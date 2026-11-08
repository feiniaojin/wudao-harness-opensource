// wudao OpenAI 兼容 shim（τ-bench 等第三方 harness 接入我们的 provider 线）。
// 监听 127.0.0.1:8790/v1/chat/completions，转 buildRunPlan+createProvider。
// 非流式；tools 透传（OpenAI tools → 我们的 Tool 面）；persona/baseURL/key
// 全走 registry 解析（glm-code 含 a reference harness:headers）。
import http from "node:http";
import { buildRunPlan } from "~/xdev/github/wudao-harness-project/wudao-harness/packages/cli/dist/run.js";
import { createProvider } from "~/xdev/github/wudao-harness-project/wudao-harness/packages/providers/dist/index.js";

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
  const tReq = Date.now();
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    (async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const ts = () => new Date().toISOString().slice(11, 23);
      console.error(`[shim] ${ts()} <- POST ${req.url} ${Buffer.concat(chunks).length}B stream=${body.stream === true}`);
      traceReq(body);
      // 瞬时错重试：上游网关 502/超时/断连不透传给 bench，等 2s 重发（最多 2 次）。
      // 上游抽风常常持续几十秒到几分钟（实测一整波 502 集中在同一分钟）。
      // 2 次 × 2s 的固定退避完全盖不住，所以给 6 次指数退避：
      // 2s→4s→8s→16s→32s→64s（总计约 2 分钟），够跨过一次短抖动，又不至于
      // 让一个真挂死的调用占着并发名额。
      const MAX_TRANSIENT_RETRIES = Number(process.env.SHIM_MAX_TRANSIENT_RETRIES ?? 6);
      for (let attempt = 0; ; attempt++) {
        try {
          const plan = buildRunPlan({
            prompt: "", env: process.env,
            ...(process.env.BENCH_PROVIDER ? { provider: process.env.BENCH_PROVIDER } : {}),
            ...(process.env.BENCH_MODEL ? { model: process.env.BENCH_MODEL } : {}),
          });
          if (plan.kind !== "real") { res.writeHead(500); res.end(JSON.stringify({ error: plan.reason })); return; }
          // 2026-11-06 取证：这里此前不传 streamIdle —— 上游一次调用卡住时
          // provider 会**无限等**（实测一个请求挂 15 分钟，agent 全程干等，
          // wudao 侧的 90s/300s 计时器根本没机会接管，因为 shim 既没回数据
          // 也没断开）。给 shim 自己的上游调用一个明确的 idle 预算。
          const client = createProvider(plan.config, {
            streamIdleSoftMs: 90_000,
            // 2026-11-07 取证：300s 硬限下，一次上游停滞=白烧 300s 后拿到空
            // 响应，而客户端自己的 300s idle 计时器几乎同时到期 → client gone，
            // 整轮报废（write-compressor 一题实测烧掉 3×300s）。降到 120s：
            // 停滞 120s→退避→重试（通常第 2 次即成），全程 ~122s，稳在客户端
            // 300s 窗口内。正常长思考不受影响——reasoning_delta 持续流动时
            // idle 计时器一直在复位。
            streamIdleHardMs: 120_000,
          });
          const wantsStream = body.stream === true && typeof client.stream === "function";
          // 2026-11-06 Terminal-Bench 取证：此前 shim 一律走阻塞的 generate()，
          // 等上游完整返回才写第一个字节。上游一次调用超过 90 秒时，wudao 的
          // stream-idle 软警告（90s）/硬中止（300s）先一步触发，表现为
          // "[shim] client gone before respond" + agent 白等一轮。
          //
          // 现在按调用方要的形状真流式转发：上游每出一个增量就写一帧 SSE，
          // 客户端永远有数据可读，idle 计时器不会饿死。非流式请求仍走
          // generate()（保持原有的简单路径）。
          let msg;
          let usage = null;
          // 2026-11-06 取证：正文是否已经逐帧转发过。终止帧若再把完整正文
          // 发一遍，客户端逐帧累加就得到**两份**正文——实测会话记录里每段
          // 回复都出现两遍（"…先写实现文件。…先写实现文件。"）。
          let streamedText = false;
          if (wantsStream) {
            let content = "";
            let finalMsg = null;
            for await (const ev of client.stream({
              systemPrompt: extractSystem(body.messages),
              messages: toOurMessages(body.messages ?? []),
              tools: toOurTools(body.tools),
              // 2026-11-06：usage 不经 done 事件，走 onUsage 回调。此前 shim 没接，
              // 于是整条基准零 token/零成本核算。接上之后按上游真实数字回传。
              onUsage: (u) => { usage = u; },
            })) {
              if (res.destroyed) break;
              // ModelStreamEvent = reasoning_delta | text_delta | done. Tool
              // calls ride the `done` message, never a delta of their own.
              if (ev.type === "text_delta" && ev.text) {
                content += ev.text;
                streamedText = true;
                if (!res.headersSent) {
                  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
                }
                res.write(`data: ${JSON.stringify({
                  id: "chatcmpl-shim", object: "chat.completion.chunk", created: Date.now() / 1000 | 0,
                  model: body.model ?? "shim",
                  choices: [{ index: 0, delta: { content: ev.text }, finish_reason: null }],
                })}\n\n`);
              } else if (ev.type === "done") {
                finalMsg = ev.message;
                usage = ev.message?.usage ?? null;
              }
            }
            msg = finalMsg ?? { content, toolCalls: [] };
          } else {
            msg = await client.generate({
              systemPrompt: extractSystem(body.messages),
              messages: toOurMessages(body.messages ?? []),
              tools: toOurTools(body.tools),
            });
            usage = msg.usage ?? null;
          }
          const tool_calls = (msg.toolCalls ?? []).map((tc, i) => ({
            id: tc.id || `call_${i}`, type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
          }));
          console.error(`[shim] ${ts()} -> answered in ${Date.now() - tReq}ms (${tool_calls.length} tool_calls, ${(msg.content ?? "").length} chars)`);
          // 2026-11-06 取证：上游偶尔给出**完全空的**响应（无正文、无 tool_call）。
          // 此前 shim 照原样回一个空 assistant 帧，wudao 收到后既没有可执行的
          // 动作也没有收口文本，于是挂在那里等——实测卡 20 分钟直到 agent 超时。
          // 空响应不是合法结果，必须让调用方看见它，而不是静默吞掉。
          if (tool_calls.length === 0 && !(msg.content ?? "").trim()) {
            throw new Error("upstream returned an EMPTY response (no content, no tool calls)");
          }
          traceResp(msg.content ?? "", tool_calls);
          if (res.destroyed) { console.error(`[shim] ${ts()} client gone before respond`); return; }
          const payload = {
            id: "chatcmpl-shim", object: "chat.completion", created: Date.now() / 1000 | 0,
            model: body.model ?? "shim",
            choices: [{ index: 0, message: { role: "assistant", content: msg.content ?? "", ...(tool_calls.length ? { tool_calls } : {}) }, finish_reason: tool_calls.length ? "tool_calls" : "stop" }],
            usage: toOpenAiUsage(usage),
          };
          // 2026-11-06 Terminal-Bench: wudao's OpenAI-wire adapter opens with
          // stream:true by default and treats a non-SSE body as a truncated
          // stream ("stream ended without a terminal event"). The shim must
          // answer in the shape the caller asked for.
          if (body.stream === true) {
            // The incremental path above may already have opened the stream;
            // only write the header when nobody has.
            if (!res.headersSent) {
              res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
              });
            }
            const choice = payload.choices[0];
            const delta = {
              id: payload.id, object: "chat.completion.chunk", created: payload.created,
              model: payload.model,
              choices: [{ index: 0, delta: { role: "assistant", content: streamedText ? "" : (choice.message.content ?? "") }, finish_reason: null }],
            };
            if (tool_calls.length) {
              delta.choices[0].delta.tool_calls = tool_calls.map((tc, i) => ({ index: i, ...tc }));
            }
            res.write(`data: ${JSON.stringify(delta)}\n\n`);
            const fin = {
              id: payload.id, object: "chat.completion.chunk", created: payload.created,
              model: payload.model,
              choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }],
              usage: payload.usage,
            };
            res.write(`data: ${JSON.stringify(fin)}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
          return;
        } catch (e) {
          const msg = String(e?.message ?? e).toLowerCase();
          // 2026-11-06 取证：`fetch failed` 是 Node/undici 对一切网络类失败的
          // 统称（DNS、连接重置、TLS 中断、socket hang up 都会包装成它）。
          // 原列表只认 "timeout"/"connection"，于是一整波上游抽风（12 次 502
          // 全在同一分钟）**一次都没重试**，直接把失败泄给 agent——实测
          // path-tracing-reverse / pytorch-model-recovery 都是这么挂的。
          const transient =
            msg.includes("temporarily unavailable") || msg.includes("timeout") ||
            msg.includes("connection") || msg.includes("fetch failed") ||
            msg.includes("socket") || msg.includes("econn") || msg.includes("etimedout") ||
            msg.includes("eai_again") || msg.includes("network") ||
            msg.includes("502") || msg.includes("503") || msg.includes("529") ||
            // GLM 账户级 429（历史波多消费者叠加时实测过）：退避后重试，
            // 不让瞬时限速直接判死一整题。与 fetch-failed 修复同性质（通用
            // 可靠性，不动 agent 行为），口径随波披露。
            msg.includes("429") || msg.includes("rate limit") ||
            // 2026-11-07 取证：上游停滞（idle 硬限 abort）表现为「空响应」，
            // 与 502/fetch failed 同属瞬态类。此前不重试，一次停滞=一整轮
            // 报废（write-compressor 实测 3 次）。空响应路径没有任何字节
            // 已写给客户端（有字节的走 streamedText 分支），重试安全。
            msg.includes("empty response");
          if (transient && attempt < MAX_TRANSIENT_RETRIES && !res.destroyed) {
            const waitMs = Math.min(60_000, 2000 * 2 ** attempt);
            console.error(`[shim] ${ts()} transient (retry ${attempt + 1}/${MAX_TRANSIENT_RETRIES}) in ${waitMs / 1000}s: ${msg.slice(0, 200)}`);
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          console.error(`[shim] ${ts()} 502 after ${attempt + 1} attempt(s): ${msg.slice(0, 200)}`);
          if (res.destroyed) return;
          // 流式路径可能已经写过 200 + 若干 data 帧：此时再 writeHead(502)
          // 会抛 ERR_HTTP_HEADERS_SENT 并**打挂整个 shim 进程**（实测）。
          // 头已发就只能以流内错误帧收尾；头未发才走 502。
          if (res.headersSent) {
            try {
              res.write(`data: ${JSON.stringify({ error: { message: String(e?.message ?? e) } })}\n\n`);
              res.write("data: [DONE]\n\n");
            } catch { /* socket already gone */ }
            res.end();
          } else {
            res.writeHead(502);
            res.end(JSON.stringify({ error: String(e?.message ?? e) }));
          }
          return;
        }
      }
    })();
  });
});

// 2026-11-06：此前 shim 把所有 usage 硬编码成 0，整条基准因此**没有 token
// 与成本核算**，会话里的缓存行永远显示 0k/0k。上游给了真实数字就照实回传。
function toOpenAiUsage(u) {
  if (!u || typeof u !== "object") return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const prompt = Number(u.promptTokens ?? 0) || 0;
  const completion = Number(u.completionTokens ?? 0) || 0;
  const hit = Number(u.cacheHitTokens ?? 0) || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(hit > 0 ? { prompt_tokens_details: { cached_tokens: hit } } : {}),
  };
}

function extractSystem(msgs) {
  const sys = (msgs ?? []).filter((m) => m.role === "system").map((m) => String(m.content ?? "")).join("\n\n");
  return sys !== "" ? sys : "You are a helpful assistant.";
}

server.listen(PORT, "127.0.0.1", () => console.log(`wudao openai shim on :${PORT}`));
