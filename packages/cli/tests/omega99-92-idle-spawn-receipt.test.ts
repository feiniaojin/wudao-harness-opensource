// ω99-92 — idle spawn 收据 boot 态收口（86 顾虑②族，queue 110 row 1）。
// T0 裁决 (b)「配置即事实」：idle 态（无 armed run 时经 task 工具 spawn）的
// 子请求实际档 = 共享 client 的 liveConfig 现值（providers 每请求读
// config.reasoningEffort，openai-compatible.ts:321-325；model.ts:179-180
// "provider reads its FIELDS at request time"），而收据 idle lane 仍报 boot
// 静态（ctx.defaultEffort，task-tool.ts:839）——88 前同款矛盾，重演于最后一
// 个未接线前端。T0 Q2 枚举：唯一真实 idle-lane 生产路径 = REPL（无
// AgentDriver ⇒ effortLiveBox 结构性缺席，repl 直驱 loop；86 报告 §5 停泊的
// 「REPL 接线后续弧」，87 接了 TUI，REPL 至今未接）；driver 前端 run 间无
// 任何 task 执行路径（孙辈 spawn 被拒、cron/monitor/peer/child-mail 全走注
// 入 lane 喂新武装 run）= 理论态；one-shot 的 config 起跑后不再变异 ⇒
// live==boot ⇒ 收据 boot 即 88 式对齐。修法 = REPL 接入既有 86 五段通路
// （runRepl 收 effortLiveBox，session-long 武装 () => liveConfig.reasoning-
// Effort —— REPL 的 live 源本就是会话级 config，非 run 级快照；/effort 只
// 能落在 turn 之间，session-long 与逐 turn 武装可观察等价，且让未来任何
// idle 执行器也读到 config 真话）：task-tool/tools.ts 零改（88/91 资产零
// diff），armed-lane 三面（requested=91 第三档 / effective=88 / trail=86）
// 自动覆盖 REPL。本文件三 case：
//   case1 主角（RED on base：requested boot off → live high）
//   case2 理论态边界钉（box 在而 slot 清空 —— driver finally 残形 ⇒ boot）
//   case3 配置即事实（/effort high → spawn high → /effort low → spawn low，
//          getter 读 spawn 时现值，非起跑快照；RED on base）
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AgentRegistry, AgentSpawnSpec } from "@wudao-org/core";
import type { ProviderConfig } from "@wudao-org/providers";
import { runRepl } from "../src/repl.js";
import { buildToolSet } from "../src/tools.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait(10);
  }
}

const allow = async () => ({ kind: "allow" as const });
type EffortLiveBox = { get?: () => string | undefined };

let root: string;
let home: string;
let prevGlobalHome: string | undefined;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "idle-receipt-")));
  home = await mkdtemp(join(tmpdir(), "idle-receipt-gh-"));
  prevGlobalHome = process.env.WUDAO_GLOBAL_HOME;
  process.env.WUDAO_GLOBAL_HOME = home; // hermetic: the roster's global tier reads here
});
afterEach(async () => {
  process.env.WUDAO_GLOBAL_HOME = prevGlobalHome;
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

/** Records every background spawn's spec verbatim — the assertion face for
 *  spec.reasoningEffort / effectiveReasoningEffort / loopOptions.effortSent
 *  (the registry-facing receipt trio, ω99-88/91's assertion surface). */
function stubRegistry(): AgentRegistry & { specs: AgentSpawnSpec[] } {
  const specs: AgentSpawnSpec[] = [];
  const stub: unknown = {
    specs,
    spawn: (spec: AgentSpawnSpec) => {
      specs.push(spec);
      return { id: "bg-1", done: Promise.resolve({ ok: true, report: "stub", turns: 0 }), warnings: [] };
    },
    awaitAgents: async () => [],
    status: () => [],
    cancel: () => false,
    abortAll: () => {},
    steer: () => {},
  };
  return stub as AgentRegistry & { specs: AgentSpawnSpec[] };
}

/**
 * Drives the REAL REPL (runRepl, no AgentDriver — the production idle-lane
 * frontend) over scripted SSE turns. `lines` are fed one per "wudao> " prompt
 * in order; each "dispatch" line's model turn calls task({background:true})
 * (the stub registry records the spec — no child ever runs). The task-tool
 * box is threaded EXACTLY as index.ts threads it in production: the test
 * creates the box, hands runRepl the arming side and buildToolSet the read
 * side (the same instance). On base runRepl ignores the unknown option, the
 * box stays unarmed, and the spawn's receipt reads the boot baseline — RED.
 */
async function driveReplTurns(lines: readonly string[], dispatchTurns: readonly { args: Record<string, unknown>; answer: string }[]): Promise<{ specs: AgentSpawnSpec[]; seen: string }> {
  const reg = stubRegistry();
  const box: EffortLiveBox = {};
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const enc = new TextEncoder();
  const sse = (frames: readonly unknown[]): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  const dispatchFrames = (args: Record<string, unknown>, n: number): readonly unknown[] => [
    { id: `t${n}`, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${n}`, type: "function", function: { name: "task", arguments: JSON.stringify(args) } }] } }] },
    { id: `t${n}`, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 5 } },
  ];
  const doneFrames = (text: string, n: string): readonly unknown[] => [
    { id: n, choices: [{ index: 0, delta: { content: text } }] },
    { id: n, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } },
  ];
  let calls = 0;
  let turn = 0;
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const d = dispatchTurns[turn];
    const frames = d !== undefined && calls % 2 === 0 ? dispatchFrames(d.args, turn + 1) : doneFrames(d?.answer ?? "ok", `d${turn}`);
    if (calls % 2 === 1) turn += 1;
    calls += 1;
    return new Response(sse(frames), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;

  let seen = "";
  let fed = 0;
  const drain = (): string => {
    let text = "";
    let chunk = stdout.read();
    while (chunk !== null) { text += chunk.toString(); chunk = stdout.read(); }
    return text;
  };
  const pump = (): void => {
    seen += drain();
    const prompts = seen.split("wudao> ").length - 1;
    while (fed < lines.length && fed < prompts) { stdin.write(`${lines[fed]}\n`); fed += 1; }
  };
  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (pred: () => boolean, what: string, ms = 10000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      pump();
      if (pred()) return;
      await delay(10);
    }
    throw new Error(`idle-receipt: timed out waiting for ${what}\n--- output so far ---\n${seen}`);
  };

  let replError: unknown;
  let doneRepl: Promise<void> | undefined;
  const prevArgv = process.argv;
  // The REPL's permission tier boots from process.argv (repl.ts:835) — "task"
  // is ask-class in the default workspace tier and a non-TTY stdin fail-closes
  // every ask into a deny, so the drive runs in --auto (task auto-allows; the
  // m80 argv save/restore precedent). Hermetic: restored in the finally.
  process.argv = [...prevArgv.slice(0, 2), "--auto"];
  try {
    doneRepl = runRepl({
      config: { apiKey: "sk-92", baseURL: "http://127.0.0.1:1/v1", model: "idle-model" } satisfies ProviderConfig,
      workspaceRoot: root,
      contextWindowTokens: 200_000,
      stdin,
      stdout,
      // The ω99-92 arming side: runRepl arms box.get = () => liveConfig.reasoningEffort.
      effortLiveBox: box,
      // The read side, threaded exactly as index.ts's buildTools does in production.
      buildTools: (model) => buildToolSet({
        workspaceRoot: root,
        model,
        canUseTool: allow,
        contextWindowTokens: 200_000,
        effortLiveBox: box,
        agents: { registry: reg, runId: "w99-92-repl", defaultEffort: "off" }, // boot baseline "off" (plan.config.reasoningEffort ?? "off" with no boot effort)
      }),
    });
    await waitFor(() => reg.specs.length >= dispatchTurns.length, `all ${dispatchTurns.length} dispatch specs`);
    await waitFor(() => seen.includes(dispatchTurns[dispatchTurns.length - 1]!.answer), "the final answer line");
    stdin.write("/exit\n");
    await Promise.race([doneRepl, waitFor(() => false, "the session to end", 5000)]);
  } catch (err) {
    replError = err;
  } finally {
    process.argv = prevArgv;
    stdin.end();
    if (doneRepl !== undefined) await Promise.race([doneRepl.then(() => {}, () => {}), delay(500)]);
    globalThis.fetch = prevFetch;
  }
  if (replError !== undefined) throw replError;
  seen += drain();
  return { specs: reg.specs, seen };
}

describe("ω99-92 idle spawn receipt — 裁决 (b)：REPL lane 收据读 liveConfig 现值（五段通路最后接线）", () => {
  it("case1 主角：idle /effort high（无在飞 run）→ REPL dispatch → 收据三面 = live high（base 报 boot off）", { timeout: 30_000 }, async () => {
    const { specs } = await driveReplTurns(
      ["/effort high", "dispatch something", "/exit"],
      [{ args: { description: "job", prompt: "do it", background: true }, answer: "spawned ok" }],
    );
    expect(specs).toHaveLength(1);
    const spec = specs[0]!;
    // 主断言（RED on base）：idle 会话的实际默认 = liveConfig 现值 "high"
    //（子请求逐请求读同一 config），第三档 fallback 不得再报 boot "off"。
    expect(spec.reasoningEffort).toBe("high");
    // 88 face：effective 同源（base 上同为 boot "off"）。
    expect(spec.effectiveReasoningEffort).toBe("high");
    // 86 face：trail 章跟 live 档（base 上该键缺席）。
    expect((spec.loopOptions as { effortSent?: string } | undefined)?.effortSent).toBe("high");
  });

  it("case2 理论态边界钉：box 在而 slot 清空（driver finally 残形）+ defaultEffort low ⇒ 收据 boot low（T0 Q2：driver 前端 run 间无 task 执行路径，此钉守边界真话）", async () => {
    const reg = stubRegistry();
    const model = {
      async generate() { return { role: "assistant" as const, content: "x" }; },
    };
    const tools = buildToolSet({
      workspaceRoot: root,
      model,
      canUseTool: allow,
      contextWindowTokens: 64_000,
      // disarmed 残形：对象在、getter 清空 —— agent-driver.ts finally 解除后的
      // 精确形状（:3261 一带）。driver 前端 run 间不存在 task 执行路径（T0 Q2
      // 枚举），若未来出现 idle 执行器，本钉守住回落语义 = boot 基线。
      effortLiveBox: {},
      agents: { registry: reg, runId: "test-run", defaultEffort: "low" },
    });
    const task = tools.find((t) => t.name === "task")!;
    const out = await task.execute({ description: "job", prompt: "do it", background: true });
    expect(out.isError).toBeUndefined();
    expect(reg.specs).toHaveLength(1);
    expect(reg.specs[0]!.reasoningEffort).toBe("low");
    expect(reg.specs[0]!.effectiveReasoningEffort).toBe("low");
  });

  it("case3 配置即事实：/effort high → spawn high → /effort low → spawn low（getter 读 spawn 时现值，非起跑快照；base 报 off）", { timeout: 30_000 }, async () => {
    const { specs } = await driveReplTurns(
      ["/effort high", "dispatch one", "/effort low", "dispatch two", "/exit"],
      [
        { args: { description: "job1", prompt: "do it", background: true }, answer: "first ok" },
        { args: { description: "job2", prompt: "do it again", background: true }, answer: "second ok" },
      ],
    );
    expect(specs).toHaveLength(2);
    expect(specs[0]!.reasoningEffort).toBe("high");
    expect(specs[1]!.reasoningEffort).toBe("low");
    expect(specs[1]!.effectiveReasoningEffort).toBe("low");
  });
});
