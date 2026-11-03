// 借鉴弧 δ（penguin-harness 367ab084 思想）— 运行中工具调用转后台：
//   车道面  typed 裁决（block 族=不可中断族拒 / 无在飞拒 / 裸调用挑第一个
//          可转的）、收集登记→注入排队（2000 字截断）、stopAll 的取消回执
//          （已停任务落定只回执不注入）
//   驱动面  detachToolCall 的全链路：busy 行 → 请求 → run 轮界收口
//          （busy 落闲、🔄 回执入历史、模型不再被调用）→ 落定结果经
//          take() 车道并入下一 run 的首个模型调用（M24：轮尾追加）→
//          interrupt 一并停（用户意图优先：per-call signal aborted）
//   纯层   parseBgCommand（/recall 同款 TUI 自有命令）
import { describe, it, expect } from "vitest";
import type { ModelClient, ModelInput, ToolResultMessage } from "@wudao-org/core";
import { buildTool, type Tool } from "@wudao-org/core";
import { createDetachLane, describeDetachVerdict, DETACH_RESULT_INJECTION_CHARS } from "../src/driver/detach-lane.js";
import { createAgentDriver, type AgentDriver } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";
import { parseBgCommand } from "../src/tui/bg-core.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const blockTool = buildTool({
  name: "blocker",
  description: "uninterruptible",
  parameters: { type: "object", properties: {} },
  interruptBehavior: "block",
  async execute() { return { content: "settled" }; },
});
const plainTool = buildTool({
  name: "plain",
  description: "detachable",
  parameters: { type: "object", properties: {} },
  async execute() { return { content: "ok" }; },
});

describe("δ 车道面 — typed 裁决与收集", () => {
  it("typed refusals: nothing in flight / unknown callId / the block family; bare detach skips the block row", () => {
    const lane = createDetachLane({ onNotice: () => {} });
    const tools: readonly Tool[] = [blockTool, plainTool];
    expect(lane.detach(undefined, [], tools)).toEqual({ kind: "refused", reason: "not_in_flight" });
    expect(lane.detach("nope", [{ name: "plain", callId: "c1" }], tools)).toEqual({ kind: "refused", reason: "not_in_flight" });
    expect(lane.detach("c9", [{ name: "blocker", callId: "c9" }], tools))
      .toEqual({ kind: "refused", reason: "not_detachable", toolName: "blocker" });
    // Bare: the block-only frame refuses naming it; the mixed frame picks plain.
    expect(lane.detach(undefined, [{ name: "blocker", callId: "c1" }], tools))
      .toEqual({ kind: "refused", reason: "not_detachable", toolName: "blocker" });
    expect(lane.detach(undefined, [{ name: "blocker", callId: "c1" }, { name: "plain", callId: "c2" }], tools))
      .toEqual({ kind: "ok", callId: "c2", toolName: "plain" });
    // Rows without a callId (pre-ω99-63 shapes) are invisible to detach.
    expect(lane.detach(undefined, [{ name: "plain" }], tools)).toEqual({ kind: "refused", reason: "not_in_flight" });
  });

  it("an ok verdict fires the hub request (the loop's race hears it)", () => {
    const lane = createDetachLane({ onNotice: () => {} });
    const heard: string[] = [];
    lane.loopOptions.toolDetach.onRequest((id) => { heard.push(id); });
    lane.detach("c1", [{ name: "plain", callId: "c1" }], [plainTool]);
    expect(heard).toEqual(["c1"]);
  });

  it("a landed result queues the injection (formatted, truncated past the cap); takeInjection drains FIFO", async () => {
    const lane = createDetachLane({ onNotice: () => {} });
    const controller = new AbortController();
    let releaseTool: ((r: { message: ToolResultMessage }) => void) | undefined;
    const result = new Promise<{ message: ToolResultMessage }>((resolve) => { releaseTool = resolve; });
    lane.register({ call: { id: "c1", name: "shell", arguments: { command: "pnpm build" } }, controller, result }, "pnpm build");
    expect(lane.runningCount()).toBe(1);
    expect(lane.takeInjection()).toBeUndefined(); // nothing landed yet
    releaseTool?.({ message: { role: "tool", toolCallId: "c1", name: "shell", content: "BUILD OUTPUT [exit 0]" } });
    await until(() => lane.runningCount() === 0, "the result lands");
    expect(lane.takeInjection()).toBe("[后台工具完成] shell(pnpm build)\nBUILD OUTPUT [exit 0]");
    expect(lane.takeInjection()).toBeUndefined();
    // The truncation cap: a result past the cap carries the honest marker.
    let release2: ((r: { message: ToolResultMessage }) => void) | undefined;
    const result2 = new Promise<{ message: ToolResultMessage }>((resolve) => { release2 = resolve; });
    lane.register({ call: { id: "c2", name: "shell", arguments: {} }, controller: new AbortController(), result: result2 }, "");
    release2?.({ message: { role: "tool", toolCallId: "c2", name: "shell", content: "x".repeat(DETACH_RESULT_INJECTION_CHARS + 100) } });
    await until(() => lane.runningCount() === 0, "the huge result lands");
    const injection = lane.takeInjection() ?? "";
    expect(injection).toContain("已截断");
    expect(injection.length).toBeLessThan(DETACH_RESULT_INJECTION_CHARS + 200);
  });

  it("124 项 1（dsh b6775f6d4f 教训）：N 连续落定全唤醒——唤醒链没有预算，第 4 个及以后的通知照常并入", async () => {
    // dsh 的后台完成链曾带 maxConsecutiveWakes=3 默认预算，预算耗尽后「第 4
    // 个通知不再唤醒、会话死到用户敲键」（issue #641，回滚 b6775f6d4f 才改
    // opt-in）。wudao 的唤醒面（idle seam 的 drain→landed + 本车道的注入
    // 队列）设计上无任何唤醒计数：N 超过 dsh 默认 3（这里取 5），每次落定
    // 都必须仍有一条注入可 drain，FIFO 全量。钉子见 idle-seam.ts 头注。
    const lane = createDetachLane({ onNotice: () => {} });
    const N = 5; // > dsh's default wake budget of 3
    const releases: ((r: { message: ToolResultMessage }) => void)[] = [];
    for (let i = 1; i <= N; i += 1) {
      let release: ((r: { message: ToolResultMessage }) => void) | undefined;
      const result = new Promise<{ message: ToolResultMessage }>((resolve) => { release = resolve; });
      releases.push(release!);
      lane.register(
        { call: { id: `c${i}`, name: "shell", arguments: {} }, controller: new AbortController(), result },
        `job ${i}`,
      );
    }
    expect(lane.runningCount()).toBe(N);
    // All settle sequentially (background tasks finish one after another while
    // the frontend is idle — each landing is one wake).
    for (let i = 1; i <= N; i += 1) {
      releases[i - 1]!({ message: { role: "tool", toolCallId: `c${i}`, name: "shell", content: `DONE ${i}` } });
      await until(() => lane.runningCount() === N - i, `job ${i} to land`);
    }
    // Every completion still has its injection — no budget exhausted at the
    // 4th (dsh's death shape) or anywhere else.
    const drained: string[] = [];
    for (;;) {
      const next = lane.takeInjection();
      if (next === undefined) break;
      drained.push(next);
    }
    expect(drained).toHaveLength(N);
    expect(drained[0]).toContain("job 1");
    expect(drained[3]).toContain("job 4"); // the dsh #641 shape — still awake
    expect(drained[4]).toContain("job 5");
  });

  it("stopAll aborts the controllers and a stopped task settles as a receipt, never an injection", async () => {
    const notices: string[] = [];
    const lane = createDetachLane({ onNotice: (t) => { notices.push(t); } });
    const controller = new AbortController();
    let releaseTool: ((r: { message: ToolResultMessage }) => void) | undefined;
    const result = new Promise<{ message: ToolResultMessage }>((resolve) => { releaseTool = resolve; });
    lane.register({ call: { id: "c1", name: "shell", arguments: {} }, controller, result }, "long build");
    lane.stopAll();
    expect(controller.signal.aborted).toBe(true);
    releaseTool?.({ message: { role: "tool", toolCallId: "c1", name: "shell", content: "[stopped by user] …" } });
    await until(() => notices.length === 1, "the stop receipt lands");
    expect(notices[0]).toContain("已按用户停止");
    expect(lane.takeInjection()).toBeUndefined();
  });

  it("the verdict receipt strings are stable (the surfaces' reply copy)", () => {
    expect(describeDetachVerdict({ kind: "ok", callId: "c1", toolName: "shell" }))
      .toBe("🔄 已转入后台：shell——完成后自动并入对话");
    expect(describeDetachVerdict({ kind: "refused", reason: "not_detachable", toolName: "blocker" }))
      .toContain("blocker");
    expect(describeDetachVerdict({ kind: "refused", reason: "not_in_flight" }))
      .toContain("没有可转后台");
  });
});

// ---------------------------------------------------------------------------
// The driver-level full chain: busy row → detach → backgrounded close → the
// landed result merges into the NEXT run's first model call.
// ---------------------------------------------------------------------------

function makeDetachDriver(): {
  readonly driver: AgentDriver;
  readonly inputs: ModelInput[];
  releaseTool(content: string): void;
  toolSignal(): AbortSignal | undefined;
} {
  const inputs: ModelInput[] = [];
  let call = 0;
  const model: ModelClient = {
    async generate(input: ModelInput) {
      inputs.push(input);
      call += 1;
      if (call === 1) {
        return { role: "assistant" as const, content: "working", toolCalls: [{ id: "call_1", name: "slowtool", arguments: {} }] };
      }
      return { role: "assistant" as const, content: `answer-${call}` };
    },
  };
  let releaseFn: ((r: { content: string }) => void) | undefined;
  let seenSignal: AbortSignal | undefined;
  const slow = buildTool({
    name: "slowtool",
    description: "slow",
    parameters: { type: "object", properties: {} },
    async execute(_args: unknown, _onUpdate: unknown, signal?: AbortSignal) {
      seenSignal = signal;
      return new Promise<{ content: string }>((resolve) => { releaseFn = resolve; });
    },
  });
  const driver = createAgentDriver({
    systemPrompt: "s",
    summarize: summarizeToolCall,
    model,
    tools: [slow],
    canUseTool: () => ({ behavior: "allow" as const }),
    gates: { todo: false, verify: false },
  });
  return {
    driver,
    inputs,
    releaseTool: (content) => { releaseFn?.({ content }); releaseFn = undefined; },
    toolSignal: () => seenSignal,
  };
}

describe("δ 驱动面 — detachToolCall 全链路", () => {
  it("detaches the in-flight call: the run closes at the turn boundary, the model is not called again, the landed result merges into the next run", async () => {
    const { driver, inputs, releaseTool } = makeDetachDriver();
    driver.submit("go");
    await until(() => (driver.getStatus().live.busyTools[0]?.callId ?? undefined) !== undefined, "the busy row carries its callId");
    const callId = driver.getStatus().live.busyTools[0]!.callId;

    const verdict = driver.detachToolCall(callId);
    expect(verdict).toEqual({ kind: "ok", callId, toolName: "slowtool" });
    // The run closes at the batch end — busy falls, the receipt lands, and
    // the model was called exactly once (the detach close skips generation).
    await until(() => driver.getStatus().busy === false, "the run closes");
    expect(inputs).toHaveLength(1);
    const history = JSON.stringify(driver.getHistory());
    expect(history).toContain("已转入后台");

    // The landed result rides the lane: a NEW run's first model call reads
    // it as a turn-tail user message (the monitor seam's discipline).
    releaseTool("REAL OUTPUT [exit 0]");
    driver.submit("结果如何？");
    await until(() => inputs.length >= 2, "the follow-up run's model call");
    const merged = JSON.stringify(inputs[1!]?.messages ?? []);
    expect(merged).toContain("后台工具完成");
    expect(merged).toContain("REAL OUTPUT [exit 0]");
    // Let the second run settle (its model call returns a final answer).
    await until(() => driver.getStatus().busy === false, "the follow-up settles");
    driver.dispose();
  }, 10_000);

  it("interrupt stops the background task with the run (用户意图优先)", async () => {
    const { driver, toolSignal } = makeDetachDriver();
    driver.submit("go");
    await until(() => (driver.getStatus().live.busyTools[0]?.callId ?? undefined) !== undefined, "the busy row");
    const verdict = driver.detachToolCall();
    expect(verdict.kind).toBe("ok");
    await until(() => driver.getStatus().busy === false, "the run closes");
    // The task still runs in the background (its signal is live)…
    await until(() => toolSignal() !== undefined, "execute saw its signal");
    expect(toolSignal()!.aborted).toBe(false);
    // …until the user says stop.
    driver.interrupt();
    expect(toolSignal()!.aborted).toBe(true);
    driver.dispose();
  }, 10_000);

  it("refuses the block family at the driver face (the loop never arms a leg either)", async () => {
    const inputs: ModelInput[] = [];
    let call = 0;
    const model: ModelClient = {
      async generate(input: ModelInput) {
        inputs.push(input);
        call += 1;
        if (call === 1) {
          return { role: "assistant" as const, content: "working", toolCalls: [{ id: "call_1", name: "blocker", arguments: {} }] };
        }
        return { role: "assistant" as const, content: "done" };
      },
    };
    let settleBlocker: (() => void) | undefined;
    const blocker = buildTool({
      name: "blocker",
      description: "uninterruptible",
      parameters: { type: "object", properties: {} },
      interruptBehavior: "block",
      async execute() { return new Promise<{ content: string }>((resolve) => { settleBlocker = () => resolve({ content: "SETTLED" }); }); },
    });
    const driver = createAgentDriver({
      systemPrompt: "s",
      summarize: summarizeToolCall,
      model,
      tools: [blocker],
      canUseTool: () => ({ behavior: "allow" as const }),
      gates: { todo: false, verify: false },
    });
    driver.submit("go");
    await until(() => (driver.getStatus().live.busyTools[0]?.callId ?? undefined) !== undefined, "the busy row");
    const verdict = driver.detachToolCall();
    expect(verdict).toEqual({ kind: "refused", reason: "not_detachable", toolName: "blocker" });
    // The block tool still owns the run: it settles for real, the model gets
    // called again (no backgrounded close).
    settleBlocker?.();
    await until(() => inputs.length >= 2, "the run continues past the block tool");
    expect(JSON.stringify(driver.getHistory())).not.toContain("已转入后台");
    await until(() => driver.getStatus().busy === false, "the run settles");
    driver.dispose();
  }, 10_000);
});

describe("δ 纯层 — parseBgCommand", () => {
  it("bare /bg, /bg <n>, and the neighbors (the /find-/recall family shape)", () => {
    expect(parseBgCommand("/bg")).toEqual({});
    expect(parseBgCommand("  /bg 2 ")).toEqual({ n: 2 });
    expect(parseBgCommand("/bgx")).toBeUndefined();
    expect(parseBgCommand("/bg abc")).toBeUndefined();
    expect(parseBgCommand("bg")).toBeUndefined();
    // 0 parses (recall's shape: the TARGET resolution refuses, not the parser).
    expect(parseBgCommand("/bg 0")).toEqual({ n: 0 });
  });
});
