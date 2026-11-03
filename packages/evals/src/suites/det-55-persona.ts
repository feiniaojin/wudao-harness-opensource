// persona 层 det-55 — 分层 wire 字节纪律 + 双向工具名映射（spec §9.7）。
// 机制自包含：内联测试 persona（不依赖 doc 90 的调研数据），跑在真实适配器
// （createOpenAICompatibleProvider，wire 层1/2 逐调用经 options.personaRuntime）
// + 真实 decorator（withPersona，提示词层3）两条缝上，对照捕获的 wire 三元组：
//
//   ① 头层单独开      wire body 与无 persona 基线逐字节相同（body 层关闭 =
//                     零 body 接触——叠加键存在但不得泄漏）；头差异精确 =
//                     persona 键集（{{sessionId}} 模板已解析）；authorization
//                     / content-type 恒不被 persona 触碰。
//   ② persona 全开    system 前缀逐字节拼接（persona.text + 原文）、工具名
//                     出向映射（wire 上只见客户端显示名）、body 叠加键精确
//                     落位；endpoint 不被 persona 移动。
//   ③ 入向逆映射      响应 tool_calls 的显示名逆映射回我们的原名（core loop
//                     只认原名）。
//   ④ 确定性          同输入同 persona 两次调用：wire body 与头模板解析逐
//                     字节一致；规范 ModelInput 永不被改写（模型可见 ≠
//                     运行时已知）。
//   ⑤ Phase B 路由    createProvider wire=anthropic/responses 后，层1/2 取
//                     各自协议的 overlay（头/body 精确落位、鉴权头恒不被
//                     碰、协议间 overlay 零串扰——openai-chat 的 temperature
//                     不得泄入 anthropic/responses，反之亦然）。
//
// 零网络：fetch 注入假实现（仅捕获请求 + 回放固定响应）。
//
// ⑥ per-provider 绑定链（Task 4 pin）：providers.json 卡片的 persona 三态
// 字段 → 真实读取 helper（readProviderPersonaBinding/readGlobalDefault-
// PersonaId，wudao-harness 包导出）→ session-engine 的 bootstrap/switch 链。
// 跑在真实驱动会话上（本地 anthropic SSE 端点捕获请求头）：绑定 provider
// 的请求带 persona 头；/provider 切走后头消失，且 persona_change 以
// reason:"provider-switch" 落 JSONL。与 ①-⑤ 的注入 fetch 模式同一"wire
// 捕获"纪律，只是缝在驱动会话层（person_change 记录只有那里会写）。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { ModelInput } from "@wudao-org/core";
import { createOpenAICompatibleProvider, createPersonaRuntime, createProvider, resolvePersona, withPersona } from "@wudao-org/providers";
import type { LayerFlags, PersonaDefinition, ProtocolId } from "@wudao-org/providers";
import { createDriverSession, type DriverSession } from "wudao-harness/driver/session-engine";
import { readProviderPersonaBinding } from "wudao-harness/driver/provider-registry-ops";
import { readGlobalDefaultPersonaId } from "wudao-harness/driver/settings-ops";
import type { EvalDefinition } from "../runner.js";

/** 一次调用的 wire 证据：请求三元组 + 回来的首个 tool_call 名。 */
interface WireCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly toolCallName?: string;
}

const CFG = { apiKey: "sk-eval", baseURL: "https://eval.invalid/v1", model: "eval-model" } as const;

// 内联测试 persona：头模板（{{sessionId}}）+ body 白名单内一个标量键 +
// system 前缀 + 一条工具名映射。body 叠加键故意存在——让"body 层关闭 =
// 字节不变"成为可证伪的 pin（若层开关失效，temperature 会泄漏进 wire）。
// Phase B ⑤：三协议各带一个可区分的 overlay 值（temperature 0.2/0.3/0.4）
// ——路由到哪个协议，wire 上就必须是谁的值（零串扰可证伪）。
const testPersona: PersonaDefinition = {
  id: "eval-persona",
  displayName: "Eval Persona",
  source: { kind: "workspace-source", provenance: "det-55 inline", pinnedVersion: "1" },
  headers: {
    "openai-chat": { "x-eval-client": "eval-persona/1", "x-session": "{{sessionId}}" },
    anthropic: { "x-eval-client": "eval-persona/1" },
    responses: { originator: "eval-persona/1" },
  },
  body: {
    "openai-chat": { temperature: 0.2 },
    anthropic: { temperature: 0.3 },
    responses: { temperature: 0.4 },
  },
  prompt: {
    system: { mode: "prefix", text: "You are EvalClient.\n" },
    toolNameMap: { read_file: "Read" },
  },
};

const INPUT: ModelInput = {
  systemPrompt: "base",
  messages: [{ role: "user", content: "go" }],
  tools: [{ name: "read_file", description: "d", parameters: { type: "object", properties: {} } }],
};

function replyWith(content: string, toolName?: string): unknown {
  return {
    choices: [{
      message: {
        role: "assistant",
        content,
        ...(toolName !== undefined
          ? { tool_calls: [{ id: "c1", type: "function", function: { name: toolName, arguments: "{}" } }] }
          : {}),
      },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  };
}

// Phase B ⑤：anthropic / responses 的非流式回放体（各自协议的完成形状）。
const anthropicReply = { content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" };
const responsesReply = { output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] };

function wireFetch(payload: unknown, sink: WireCall[]): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    sink.push({
      url: String(url),
      headers: { ...(init?.headers as Record<string, string>) },
      body: String(init?.body),
    });
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

/** 一次完整调用：runtime（persona 或 null）同时喂给适配器的 wire 缝和
 *  decorator 的提示词缝——与生产接线一致。layers 为 null = 无 persona 基线。 */
async function oneCall(layers: Partial<LayerFlags> | null, reply: unknown): Promise<WireCall> {
  const sink: WireCall[] = [];
  const rt = createPersonaRuntime(
    layers === null ? null : resolvePersona(testPersona, layers),
    { sessionId: "s-eval" },
  );
  const model = withPersona(
    createOpenAICompatibleProvider(CFG, { fetch: wireFetch(reply, sink), personaRuntime: rt }),
    rt,
  );
  const msg = await model.generate(INPUT);
  const first = sink[0];
  if (first === undefined) throw new Error("det-55: the fake fetch saw no request");
  return { ...first, toolCallName: msg.toolCalls?.[0]?.name };
}

/** Phase B ⑤：经 createProvider 路由的一次调用（headers+body 层开、prompt
 *  层关——⑤ 只证层1/2 的协议路由；层3 协议无关已由 ②④ 覆盖）。 */
async function routedCall(wire: "anthropic" | "responses"): Promise<WireCall> {
  const sink: WireCall[] = [];
  const rt = createPersonaRuntime(
    resolvePersona(testPersona, { headers: true, body: true, prompt: false }),
    { sessionId: "s-eval" },
  );
  const model = createProvider({ ...CFG, wire }, { fetch: wireFetch(wire === "anthropic" ? anthropicReply : responsesReply, sink), personaRuntime: rt });
  const msg = await model.generate(INPUT);
  const first = sink[0];
  if (first === undefined) throw new Error("det-55 ⑤: the fake fetch saw no request");
  if (msg.content !== "hi") throw new Error(`det-55 ⑤: unexpected reply content ${JSON.stringify(msg.content)}`);
  return first;
}

export interface PersonaEvalEvidence {
  readonly baseline: WireCall;
  readonly headersOnly: WireCall;
  readonly allOn: WireCall;
  readonly allOnSecond: WireCall;
  readonly routedAnthropic: WireCall;
  readonly routedResponses: WireCall;
  readonly inputBefore: string;
  readonly inputAfter: string;
}

export const det55Eval: EvalDefinition<{ readonly workspaceRoot: string }, PersonaEvalEvidence> = {
  name: "det-55-persona",
  kind: "deterministic",
  async setup(tmplDir) {
    return { workspaceRoot: tmplDir };
  },
  async run(): Promise<PersonaEvalEvidence> {
    const inputBefore = JSON.stringify(INPUT);
    const baseline = await oneCall(null, replyWith("hi"));
    const headersOnly = await oneCall({ headers: true, body: false, prompt: false }, replyWith("hi"));
    const allOn = await oneCall({ headers: true, body: true, prompt: true }, replyWith("hi", "Read"));
    const allOnSecond = await oneCall({ headers: true, body: true, prompt: true }, replyWith("hi", "Read"));
    const routedAnthropic = await routedCall("anthropic");
    const routedResponses = await routedCall("responses");
    return { baseline, headersOnly, allOn, allOnSecond, routedAnthropic, routedResponses, inputBefore, inputAfter: JSON.stringify(INPUT) };
  },
  assertions(e: PersonaEvalEvidence): string[] {
    const errs: string[] = [];
    const need = (cond: boolean, what: string): void => {
      if (!cond) errs.push(what);
    };

    // ---- ① 头层单独开：body 逐字节与无 persona 基线一致（零 body 接触）
    need(
      e.headersOnly.body === e.baseline.body,
      `① headers-only: wire body must be byte-identical to the no-persona baseline (body overlay exists but the layer is OFF), got ${JSON.stringify(e.headersOnly.body.slice(0, 120))} vs ${JSON.stringify(e.baseline.body.slice(0, 120))}`,
    );
    // 基线头精确 = content-type + authorization，绝无其他键
    need(
      JSON.stringify(Object.keys(e.baseline.headers).sort()) === JSON.stringify(["authorization", "content-type"]),
      `① baseline: header key set must be exactly content-type + authorization, got ${JSON.stringify(Object.keys(e.baseline.headers).sort())}`,
    );
    // 头差异精确 = persona 键集（新增键恰为两个，顺序无关）
    const baseKeys = new Set(Object.keys(e.baseline.headers));
    const added = Object.keys(e.headersOnly.headers).filter((k) => !baseKeys.has(k)).sort();
    need(
      JSON.stringify(added) === JSON.stringify(["x-eval-client", "x-session"]),
      `① headers-only: persona must add exactly the persona header keys, got ${JSON.stringify(added)}`,
    );
    need(
      e.headersOnly.headers["x-eval-client"] === "eval-persona/1",
      `① headers-only: x-eval-client must be the literal persona header, got ${JSON.stringify(e.headersOnly.headers["x-eval-client"])}`,
    );
    need(
      e.headersOnly.headers["x-session"] === "s-eval",
      `① headers-only: {{sessionId}} template must resolve from the runtime slots, got ${JSON.stringify(e.headersOnly.headers["x-session"])}`,
    );
    need(
      e.headersOnly.headers["authorization"] === e.baseline.headers["authorization"]
        && e.headersOnly.headers["authorization"] === "Bearer sk-eval",
      "① headers-only: authorization is the key pool's header and must never be persona-touched",
    );
    need(
      e.headersOnly.headers["content-type"] === e.baseline.headers["content-type"],
      "① headers-only: content-type must be unchanged by the persona layer",
    );

    // ---- ② persona 全开：system 前缀 + 出向工具名映射 + body 叠加键 + endpoint
    const allOnJson = JSON.parse(e.allOn.body) as {
      messages?: { role?: string; content?: string }[];
      tools?: { function?: { name?: string } }[];
      temperature?: number;
    };
    need(
      allOnJson.messages?.[0]?.role === "system" && allOnJson.messages[0]?.content === "You are EvalClient.\nbase",
      `② all-on: wire system message must be the byte-exact prefix concatenation, got ${JSON.stringify(allOnJson.messages?.[0])}`,
    );
    need(
      allOnJson.tools?.[0]?.function?.name === "Read",
      `② all-on: outbound tool name must be mapped to the client display name on the wire, got ${JSON.stringify(allOnJson.tools?.[0]?.function?.name)}`,
    );
    need(
      allOnJson.temperature === 0.2,
      `② all-on: the body overlay key must land on the wire exactly, got ${JSON.stringify(allOnJson.temperature)}`,
    );
    need(
      e.allOn.url === `${CFG.baseURL}/chat/completions`,
      `② all-on: the persona must not move the endpoint, got ${e.allOn.url}`,
    );

    // ---- ③ 入向逆映射：响应 tool_calls 显示名 → 我们的原名
    need(
      e.allOn.toolCallName === "read_file",
      `③ all-on: response tool_calls name must be reverse-mapped to our canonical name, got ${JSON.stringify(e.allOn.toolCallName)}`,
    );

    // ---- ④ 确定性 + 规范输入不改写
    need(
      e.allOnSecond.body === e.allOn.body,
      "④ determinism: two identical persona-on calls must produce byte-identical wire bodies",
    );
    need(
      e.allOnSecond.headers["x-session"] === e.allOn.headers["x-session"],
      "④ determinism: header template resolution must be deterministic across identical runs",
    );
    need(
      e.inputAfter === e.inputBefore,
      "④ purity: the canonical ModelInput must never be mutated by the persona layer (模型可见 ≠ 运行时已知)",
    );

    // ---- ⑤ Phase B 路由：createProvider wire 切换后，层1/2 取各自协议 overlay
    const anBody = JSON.parse(e.routedAnthropic.body) as { temperature?: number };
    const rsBody = JSON.parse(e.routedResponses.body) as { temperature?: number };
    need(
      e.routedAnthropic.url === `${CFG.baseURL}/messages`,
      `⑤ anthropic: the routed call must hit the /messages endpoint, got ${e.routedAnthropic.url}`,
    );
    need(
      e.routedAnthropic.headers["x-api-key"] === "sk-eval" && e.routedAnthropic.headers["anthropic-version"] === "2023-06-01",
      `⑤ anthropic: the adapter's own auth headers must survive the persona spread, got ${JSON.stringify(e.routedAnthropic.headers)}`,
    );
    need(
      e.routedAnthropic.headers["x-eval-client"] === "eval-persona/1",
      `⑤ anthropic: the persona header overlay must land on the routed wire, got ${JSON.stringify(e.routedAnthropic.headers)}`,
    );
    need(
      anBody.temperature === 0.3,
      `⑤ anthropic: the body overlay must be the ANTHROPIC overlay value, got ${JSON.stringify(anBody.temperature)}`,
    );
    need(
      e.routedResponses.url === `${CFG.baseURL}/responses`,
      `⑤ responses: the routed call must hit the /responses endpoint, got ${e.routedResponses.url}`,
    );
    need(
      e.routedResponses.headers["authorization"] === "Bearer sk-eval",
      `⑤ responses: authorization is the key pool's header and must never be persona-touched, got ${JSON.stringify(e.routedResponses.headers["authorization"])}`,
    );
    need(
      e.routedResponses.headers["originator"] === "eval-persona/1",
      `⑤ responses: the persona header overlay must land on the routed wire, got ${JSON.stringify(e.routedResponses.headers)}`,
    );
    need(
      rsBody.temperature === 0.4,
      `⑤ responses: the body overlay must be the RESPONSES overlay value, got ${JSON.stringify(rsBody.temperature)}`,
    );

    return errs;
  },
};

// ---------------------------------------------------------------------------
// ⑥ per-provider 绑定链（SDD 2026-08-23 persona settings + provider binding
//    Task 4 pin）：卡片 persona 三态字段经真实 helper 读取 → bootstrap 链 →
//    anthropic wire 头捕获 → 切走后头消失 + persona_change reason。
// ---------------------------------------------------------------------------

/** 一次捕获的请求（头部即证据；body 不进断言）。 */
interface BindingWireCall {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/** 本地 anthropic SSE 端点：捕获每个请求的 url+headers，回放一段固定的
 *  message_start…message_stop 流（驱动 loop 走 stream 路径，与生产同形）。 */
function startAnthropicCapture(): Promise<{
  readonly server: Server;
  readonly url: string;
  readonly requests: BindingWireCall[];
}> {
  const requests: BindingWireCall[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString("utf8"); });
    req.on("end", () => {
      requests.push({ url: req.url ?? "", headers: { ...(req.headers as Record<string, string>) } });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        [
          `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5 } } })}`,
          `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } })}`,
          `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}`,
          `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })}`,
          `data: ${JSON.stringify({ type: "message_stop" })}`,
          "",
        ].join("\n\n"),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/v1`, requests });
    });
  });
}

const wait = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
async function until(cond: () => boolean, what: string, capMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > capMs) throw new Error(`det-55 binding: timeout waiting for ${what}`);
    await wait(20);
  }
}

export interface PersonaBindingEvidence {
  readonly boot: BindingWireCall;
  readonly afterSwitch: BindingWireCall;
  /** JSONL 里全部 persona_change 行的 data 面（type 断言在 assertions）。 */
  readonly changes: readonly { readonly type: string; readonly data: { readonly id: string | null; readonly reason?: string; readonly from?: string | null } }[];
}

export const det55BindingEval: EvalDefinition<{ readonly workspaceRoot: string }, PersonaBindingEvidence> = {
  name: "det-55-persona-binding",
  kind: "deterministic",
  async setup(tmplDir) {
    return { workspaceRoot: tmplDir };
  },
  async run(ctx): Promise<PersonaBindingEvidence> {
    // 隔离：本 lane 私有 WUDAO_GLOBAL_HOME（providers.json 卡片绑定落这里）
    // + WUDAO_BASE_URL（/provider 切换的目标也指回本地端点，零网络）。
    const savedGlobal = process.env.WUDAO_GLOBAL_HOME;
    const savedBase = process.env.WUDAO_BASE_URL;
    const cap = await startAnthropicCapture();
    const sessionRef: { current: DriverSession | null } = { current: null };
    process.env.WUDAO_GLOBAL_HOME = join(ctx.workspaceRoot, "home");
    process.env.WUDAO_BASE_URL = cap.url;
    try {
      mkdirSync(process.env.WUDAO_GLOBAL_HOME, { recursive: true });
      // 卡片绑定：deepseek（boot provider）→ eval-bind；glm（切换目标）无卡片
      // → undefined → 链落 none。显式 version 结构与生产文件一致。
      // 0.3.32b（kimi-404 修）：会话中途 /provider 切换的目标端点以目标
      // profile 为准（outrank WUDAO_BASE_URL env 钉）——所以 eval 里把切换
      // 目标 glm 指回本地端点要靠 REGISTRY OVERLAY（baseUrl: cap.url），
      // env 只再服务 boot。与 cli persona-wiring 测试的 pinGlmEndpoint 同款。
      writeFileSync(
        join(process.env.WUDAO_GLOBAL_HOME, "providers.json"),
        `${JSON.stringify({ version: 1, providers: { deepseek: { persona: "eval-bind" }, glm: { baseUrl: cap.url } } }, null, 2)}\n`,
        "utf8",
      );
      // 工作区 persona：headers-only（anthropic 头 x-eval-client）——头层即证据。
      const personasDir = join(ctx.workspaceRoot, ".wudao", "personas");
      mkdirSync(personasDir, { recursive: true });
      writeFileSync(
        join(personasDir, "eval-bind.json"),
        `${JSON.stringify({
          id: "eval-bind",
          displayName: "Eval Bind",
          source: { kind: "workspace-source", provenance: "det-55 binding", pinnedVersion: "1" },
          defaultLayers: { headers: true, body: false, prompt: false },
          headers: { anthropic: { "x-eval-client": "eval-bind/1" } },
        }, null, 2)}\n`,
        "utf8",
      );

      const session = await createDriverSession({
        config: {
          apiKey: "sk-eval", apiKeys: ["sk-eval"], baseURL: cap.url,
          model: "eval-model", provider: "deepseek", wire: "anthropic",
        },
        workspaceRoot: ctx.workspaceRoot,
        contextWindowTokens: 64_000,
        tools: [],
        sessionId: "wudao-det55-bind",
        noPeer: true,
        // 生产同款接线（ui.ts startUiSession 的形态）：真实读取 helper。
        readProviderPersonaBinding: (p) => readProviderPersonaBinding(p),
        readGlobalDefaultPersonaId: () => readGlobalDefaultPersonaId(),
      });
      sessionRef.current = session;

      // ① boot：绑定 persona 的头必须出现在 anthropic wire 上。
      session.driver.submit("hi");
      await until(() => cap.requests.length >= 1, "boot request");
      await until(() => session.driver.getStatus().busy === false, "boot run settles");
      const boot = cap.requests[0] as BindingWireCall;

      // ② 切走（glm 无绑定）→ 链落 none；头必须消失。
      session.driver.submit("/provider glm");
      await until(() => session.driver.getStatus().model?.provider === "glm", "provider switched");
      session.driver.submit("hi");
      await until(() => cap.requests.length >= 2, "post-switch request");
      await until(() => session.driver.getStatus().busy === false, "post-switch run settles");
      const afterSwitch = cap.requests[1] as BindingWireCall;

      // ③ persona_change JSONL（reason:"provider-switch"）。
      await until(
        () => {
          const f = join(ctx.workspaceRoot, ".wudao", "sessions", "wudao-det55-bind.jsonl");
          if (!existsSync(f)) return false;
          return readFileSync(f, "utf8").split("\n").filter((l) => l.trim() !== "")
            .some((l) => (JSON.parse(l) as { data?: { reason?: string } }).data?.reason === "provider-switch");
        },
        "persona_change provider-switch record",
      );
      const f = join(ctx.workspaceRoot, ".wudao", "sessions", "wudao-det55-bind.jsonl");
      const changes = readFileSync(f, "utf8").split("\n").filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as PersonaBindingEvidence["changes"][number])
        .filter((e) => e.type === "persona_change");
      return { boot, afterSwitch, changes };
    } finally {
      await sessionRef.current?.close().catch(() => {});
      await new Promise<void>((resolve) => { cap.server.close(() => { resolve(); }); });
      if (savedGlobal === undefined) delete process.env.WUDAO_GLOBAL_HOME;
      else process.env.WUDAO_GLOBAL_HOME = savedGlobal;
      if (savedBase === undefined) delete process.env.WUDAO_BASE_URL;
      else process.env.WUDAO_BASE_URL = savedBase;
    }
  },
  assertions(e: PersonaBindingEvidence): string[] {
    const errs: string[] = [];
    const need = (cond: boolean, what: string): void => {
      if (!cond) errs.push(what);
    };
    // ---- ⑥-a 绑定生效：anthropic wire 上出现绑定 persona 的头
    need(
      e.boot.url.endsWith("/messages"),
      `⑥ boot: the bound provider must speak the anthropic wire (/messages), got ${e.boot.url}`,
    );
    need(
      e.boot.headers["x-api-key"] === "sk-eval" && e.boot.headers["anthropic-version"] === "2023-06-01",
      `⑥ boot: the adapter's own auth headers must survive the persona overlay, got ${JSON.stringify(e.boot.headers)}`,
    );
    need(
      e.boot.headers["x-eval-client"] === "eval-bind/1",
      `⑥ boot: the card-bound persona's header must appear on the wire (card persona → chain → runtime), got ${JSON.stringify(e.boot.headers)}`,
    );
    // ---- ⑥-b 切走后头消失（链落 none，裸字节）
    need(
      e.afterSwitch.url.endsWith("/messages"),
      `⑥ after-switch: still the anthropic wire, got ${e.afterSwitch.url}`,
    );
    need(
      e.afterSwitch.headers["x-eval-client"] === undefined,
      `⑥ after-switch: the persona header must be GONE after switching to an unbound provider, got ${JSON.stringify(e.afterSwitch.headers)}`,
    );
    need(
      e.afterSwitch.headers["x-api-key"] === "sk-eval",
      `⑥ after-switch: the adapter's auth header must survive the persona dropping off, got ${JSON.stringify(e.afterSwitch.headers)}`,
    );
    // ---- ⑥-c persona_change reason:"provider-switch"（id:null = 链落 none；from = 绑定 persona）
    const rec = e.changes.find((c) => c.data.reason === "provider-switch");
    need(rec !== undefined, `⑥ record: a persona_change with reason "provider-switch" must land in the session JSONL, got ${JSON.stringify(e.changes)}`);
    if (rec !== undefined) {
      need(rec.data.id === null, `⑥ record: the switched-to chain resolves to none (id null), got ${JSON.stringify(rec.data.id)}`);
      need(rec.data.from === "eval-bind", `⑥ record: from must be the bound persona id, got ${JSON.stringify(rec.data.from)}`);
    }
    return errs;
  },
};
