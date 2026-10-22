// wudao OpenAI 兼容 shim（τ-bench 等第三方 harness 接入我们的 provider 线）。
// 监听 127.0.0.1:8790/v1/chat/completions，转 buildRunPlan+createProvider。
// 非流式；tools 透传（OpenAI tools → 我们的 Tool 面）；persona/baseURL/key
// 全走 registry 解析（glm-code 含 the upstream format:headers）。
import http from "node:http";
import { buildRunPlan } from "external/packages/cli/dist/run.js";
import { createProvider } from "external/packages/providers/dist/index.js";

const PORT = Number(process.env.SHIM_PORT ?? 8790);
// 取证落盘：SHIM_TRACE=1 时每个请求/响应对追加 JSONL（不设则零行为差异）。
const TRACE = process.env.SHIM_TRACE === "1";
const TRACE_PATH = process.env.SHIM_TRACE_PATH ?? "/tmp/tau-forensics-trace.jsonl";
import fs from "node:fs";
function traceReq(body) {
  if (!TRACE) return;
  try { fs.appendFileSync(TRACE_PATH, JSON.stringify({ ts: new Date().toISOString(), dir: "req", body }) + "\n"); } catch {}
}
function traceResp(content, tool_calls, usage) {
  if (!TRACE) return;
  try { fs.appendFileSync(TRACE_PATH, JSON.stringify({ ts: new Date().toISOString(), dir: "resp", content, tool_calls, usage }) + "\n"); } catch {}
}

function toOurTools(openaiTools) {
  if (!Array.isArray(openaiTools)) return [];
  return openaiTools
    .map((t) => t?.function)
    .filter(Boolean)
    .map((f) => ({ name: f.name, description: f.description ?? "", parameters: f.parameters ?? { type: "object", properties: {} } }));
}

function toOurMessages(msgs) {
  return (msgs ?? []).flatMap((m) => {
    if (m.role === "tool") {
      return [{ role: "tool", toolCallId: String(m.tool_call_id ?? ""), name: String(m.name ?? ""), content: String(m.content ?? "") }];
    }
    if (m.role === "assistant") {
      const tcs = (m.tool_calls ?? []).map((tc) => ({
        id: String(tc.id ?? ""),
        name: String(tc.function?.name ?? ""),
        arguments: JSON.parse(tc.function?.arguments || "{}"),
      }));
      return [{ role: "assistant", content: String(m.content ?? ""), ...(tcs.length ? { toolCalls: tcs } : {}) }];
    }
    return [{ role: m.role === "system" ? "user" : m.role, content: String(m.content ?? "") }];
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: process.env.BENCH_MODEL ?? "glm-5.3" }] }));
    return;
  }
  if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
    res.writeHead(404); res.end("{}"); return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    (async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      traceReq(body);
      // 瞬时错重试：上游网关 502/超时/断连不透传给 bench，等 2s 重发（最多 2 次）。
      const MAX_TRANSIENT_RETRIES = 2;
      for (let attempt = 0; ; attempt++) {
        try {
          const plan = buildRunPlan({
            prompt: "", env: process.env,
            ...(process.env.BENCH_PROVIDER ? { provider: process.env.BENCH_PROVIDER } : {}),
            ...(process.env.BENCH_MODEL ? { model: process.env.BENCH_MODEL } : {}),
          });
          if (plan.kind !== "real") { res.writeHead(500); res.end(JSON.stringify({ error: plan.reason })); return; }
          const client = createProvider(plan.config);
          const msg = await client.generate({
            systemPrompt: extractSystem(body.messages),
            messages: toOurMessages(body.messages ?? []),
            tools: toOurTools(body.tools),
          });
          const tool_calls = (msg.toolCalls ?? []).map((tc, i) => ({
            id: tc.id || `call_${i}`, type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
          }));
          traceResp(msg.content ?? "", tool_calls);
          if (res.destroyed) { console.error("[shim] client gone before respond"); return; }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            id: "chatcmpl-shim", object: "chat.completion", created: Date.now() / 1000 | 0,
            model: body.model ?? "shim",
            choices: [{ index: 0, message: { role: "assistant", content: msg.content ?? "", ...(tool_calls.length ? { tool_calls } : {}) }, finish_reason: tool_calls.length ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }));
          return;
        } catch (e) {
          const msg = String(e?.message ?? e).toLowerCase();
          const transient = msg.includes("temporarily unavailable") || msg.includes("timeout") || msg.includes("connection");
          if (transient && attempt < MAX_TRANSIENT_RETRIES && !res.destroyed) {
            console.error(`[shim] transient (retry ${attempt + 1}/${MAX_TRANSIENT_RETRIES}) in 2s: ${msg.slice(0, 200)}`);
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          console.error(`[shim] 502 after ${attempt + 1} attempt(s): ${msg.slice(0, 200)}`);
          if (!res.destroyed) { res.writeHead(502); res.end(JSON.stringify({ error: String(e?.message ?? e) })); }
          return;
        }
      }
    })();
  });
});

function extractSystem(msgs) {
  const sys = (msgs ?? []).filter((m) => m.role === "system").map((m) => String(m.content ?? "")).join("\n\n");
  return sys !== "" ? sys : "You are a helpful assistant.";
}

server.listen(PORT, "127.0.0.1", () => console.log(`wudao openai shim on :${PORT}`));
