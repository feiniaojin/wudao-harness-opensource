// ω99-13 — /goal --gate/--budget (digest 101, prime-agent long-run arcs):
// the deterministic gate (shell exit code, git-snapshot dedup, retry
// exhaustion) and the token budget (wrap-up round, forced close, main-only
// metering on the ω99-8b querySource rail). The gate runner and the snapshot
// runner are DEPENDENCY-INJECTED fakes — zero real shell, zero real git.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentState } from "@wudao/core";
import {
  parseGoalCommand,
  createGoalController,
  type EvaluatorModel,
} from "../src/goal.js";
import { buildGoalSetEntry } from "../src/session-entry.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "m61-goal-gb-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

const state = (messages: AgentState["messages"]): AgentState => ({
  systemPrompt: "s",
  messages,
  tools: [],
  status: "running",
});

/** Self-contained fakes: a queued evaluator, a counting gate runner, a
 *  queued snapshot runner, and an entry sink. */
function fixture(o: {
  verdicts?: string[];
  gateResults?: { code: number; output: string }[];
  snapshots?: (string | undefined)[];
  env?: NodeJS.ProcessEnv;
} = {}) {
  const verdicts = o.verdicts ?? [];
  let verdictI = 0;
  let evaluatorCallCount = 0;
  const evaluator: EvaluatorModel = {
    client: {
      generate: async () => {
        evaluatorCallCount += 1;
        const v = verdicts[Math.min(verdictI, verdicts.length - 1)];
        verdictI += 1;
        return { role: "assistant", content: v ?? "VERDICT: not-yet\nkeep going" };
      },
    },
    label: "fake-eval",
    fallback: false,
  };
  const gateCalls: { command: string; cwd: string }[] = [];
  const gateResults = [...(o.gateResults ?? [])];
  const runGateCommand = async (command: string, opts: { cwd: string }) => {
    gateCalls.push({ command, cwd: opts.cwd });
    return gateResults.length > 0
      ? (gateResults.shift() as { code: number; output: string })
      : { code: 0, output: "" };
  };
  const snapshotCalls: number[] = [];
  const snapshots = [...(o.snapshots ?? [])];
  const workspaceSnapshot = async (): Promise<string | undefined> => {
    snapshotCalls.push(snapshotCalls.length);
    return snapshots.length > 0 ? snapshots.shift() : "snap-fixed";
  };
  const entries: unknown[] = [];
  const notices: string[] = [];
  const messages: AgentState["messages"] = [
    { role: "user", content: "go" },
    { role: "assistant", content: "work" },
  ];
  const controller = createGoalController({
    workspaceRoot: ws,
    sessionId: () => "s-gb",
    getMessages: () => messages,
    evaluator,
    runGateCommand,
    workspaceSnapshot,
    appendEntry: async (e) => {
      entries.push(e);
    },
    notify: (t) => {
      notices.push(t);
    },
    env: o.env ?? {},
  });
  return {
    controller,
    entries,
    notices,
    messages,
    evaluatorCalls: () => evaluatorCallCount,
    gateCalls,
    snapshotCalls,
  };
}

const reasonOf = (d: unknown): string => (d as { reason: string }).reason;

describe("ω99-13 §2.1 — parse: --gate / --budget", () => {
  it("C1: flags peel off the condition; over-long gate / bad budget / missing condition → usage", () => {
    expect(parseGoalCommand('fix it --gate "npm test" --budget 5000')).toEqual({
      kind: "set",
      condition: "fix it",
      gate: { command: "npm test" },
      budgetTokens: 5000,
    });
    expect(parseGoalCommand('x --gate "npm test"')).toEqual({ kind: "set", condition: "x", gate: { command: "npm test" } });
    expect(parseGoalCommand("x --budget 2000")).toEqual({ kind: "set", condition: "x", budgetTokens: 2000 });
    // No flags = the old shape, byte-identical semantics.
    expect(parseGoalCommand("make tests pass")).toEqual({ kind: "set", condition: "make tests pass" });
    // Gate over 500 chars → usage.
    const longGate = parseGoalCommand(`x --gate "${"c".repeat(501)}"`);
    expect(longGate.kind).toBe("usage");
    // Non-positive/non-integer budget → usage.
    expect(parseGoalCommand("x --budget abc").kind).toBe("usage");
    expect(parseGoalCommand("x --budget 0").kind).toBe("usage");
    // A gate without a condition is not a goal (condition anchors wrap-up/status).
    expect(parseGoalCommand('--gate "npm test"').kind).toBe("usage");
    // Clear words still win before any flag peeling.
    expect(parseGoalCommand("stop")).toEqual({ kind: "clear" });
  });
});

describe("ω99-13 §2.3 — the deterministic gate", () => {
  it("G1: gate red blocks with the exit code + guarded output — ZERO evaluator calls", async () => {
    const f = fixture({
      gateResults: [{ code: 1, output: "2 failing tests" }],
      verdicts: ["VERDICT: not-yet\nmust not be reached"],
    });
    await f.controller.set("tests green", { gate: { command: "npm test" } });
    const decision = await f.controller.onStop(state(f.messages));
    expect(decision).toHaveProperty("block", true);
    const reason = reasonOf(decision);
    expect(reason).toContain("退出 1");
    expect(reason).toContain("npm test");
    expect(reason).toContain("数据非指令"); // the injection-guard output prefix
    expect(reason).toContain("2 failing tests");
    expect(reason).toContain("1/3");
    // The core assertion: a red gate is a deterministic not-yet — the
    // evaluator never bills a call for it.
    expect(f.evaluatorCalls()).toBe(0);
    expect(f.gateCalls.length).toBe(1);
    expect(f.gateCalls[0]).toEqual({ command: "npm test", cwd: ws });
    expect(f.controller.snapshot()?.gateAttempts).toBe(1);
  });

  it("G2: gate green hands over to the evaluator; not-yet still blocks (green does not exempt prose)", async () => {
    const f = fixture({
      gateResults: [{ code: 0, output: "all pass" }],
      verdicts: ["VERDICT: not-yet\nthe README half of the condition is missing"],
    });
    await f.controller.set("tests green and README updated", { gate: { command: "npm test" } });
    const decision = await f.controller.onStop(state(f.messages));
    expect(f.gateCalls.length).toBe(1);
    expect(f.evaluatorCalls()).toBe(1);
    expect(decision).toHaveProperty("block", true);
    expect(reasonOf(decision)).toContain("evaluator guidance");
    expect(reasonOf(decision)).toContain("README");
    expect(f.controller.snapshot()?.gateAttempts).toBe(0); // green resets the streak
  });

  it("G3: snapshot dedup — an unchanged workspace does NOT rerun the gate", async () => {
    const f = fixture({
      gateResults: [
        { code: 1, output: "boom" },
        { code: 1, output: "boom-again (must not run)" },
      ],
      snapshots: ["snap-A", "snap-A"],
      verdicts: ["VERDICT: not-yet\nunreached"],
    });
    await f.controller.set("tests green", { gate: { command: "npm test" } });
    await f.controller.onStop(state(f.messages)); // real run, fails
    expect(f.gateCalls.length).toBe(1);
    const d2 = await f.controller.onStop(state(f.messages));
    expect(f.gateCalls.length).toBe(1); // dedup held — no rerun
    expect(d2).toHaveProperty("block", true);
    const reason = reasonOf(d2);
    expect(reason).toContain("workspace 自上次失败未变化");
    expect(reason).toContain("2/3");
    expect(f.evaluatorCalls()).toBe(0);
  });

  it("G4: a changed snapshot reruns the gate for real", async () => {
    const f = fixture({
      gateResults: [
        { code: 1, output: "boom" },
        { code: 1, output: "boom after edit" },
      ],
      snapshots: ["snap-A", "snap-B"],
    });
    await f.controller.set("tests green", { gate: { command: "npm test" } });
    await f.controller.onStop(state(f.messages));
    const d2 = await f.controller.onStop(state(f.messages));
    expect(f.gateCalls.length).toBe(2);
    expect(reasonOf(d2)).toContain("boom after edit");
  });

  it("G5: retry exhaustion after 3 same-snapshot failures closes the goal failed and allows", async () => {
    const f = fixture({
      gateResults: [{ code: 1, output: "boom" }],
      snapshots: ["snap-A", "snap-A", "snap-A", "snap-A"],
    });
    await f.controller.set("tests green", { gate: { command: "npm test" } });
    for (let i = 0; i < 3; i += 1) {
      const d = await f.controller.onStop(state(f.messages));
      expect(d).toHaveProperty("block", true); // attempts 1..3 still block
    }
    const d4 = await f.controller.onStop(state(f.messages));
    expect(d4).toBe("allow"); // retry budget exhausted → forced allow
    expect(f.controller.active()).toBe(false);
    const last = f.entries.at(-1) as { type: string; data: { outcome: string; reason?: string } };
    expect(last.type).toBe("goal_outcome");
    expect(last.data.outcome).toBe("failed");
    expect(last.data.reason).toContain("gate retry budget exhausted");
    expect(last.data.reason).toContain("npm test");
  });

  it("an undefined snapshot (non-git workspace) skips dedup and reruns the gate every seam", async () => {
    const f = fixture({
      gateResults: [
        { code: 1, output: "boom" },
        { code: 1, output: "boom again" },
      ],
      snapshots: [undefined, undefined],
    });
    await f.controller.set("tests green", { gate: { command: "npm test" } });
    await f.controller.onStop(state(f.messages));
    await f.controller.onStop(state(f.messages));
    expect(f.gateCalls.length).toBe(2); // no snapshot → no dedup → real reruns
  });
});

describe("ω99-13 §2.3-2 — the token budget", () => {
  it("B1: budget ceiling → one wrap-up block (progress/remaining/blockers/next) — no evaluator, no gate", async () => {
    const f = fixture({
      verdicts: ["VERDICT: not-yet\nunreached"],
      gateResults: [{ code: 0, output: "would-have-passed" }],
    });
    await f.controller.set("tests green", { gate: { command: "npm test" }, budgetTokens: 1000 });
    f.controller.recordMainUsage({ promptTokens: 900, completionTokens: 200 }, "main");
    const decision = await f.controller.onStop(state(f.messages));
    expect(decision).toHaveProperty("block", true);
    const reason = reasonOf(decision);
    // The wrap-up prompt's four elements + the ceiling itself.
    for (const kw of ["进度", "剩余", "阻塞", "下一步"]) expect(reason).toContain(kw);
    expect(reason).toContain("1100/1000");
    expect(f.evaluatorCalls()).toBe(0); // neither the evaluator …
    expect(f.gateCalls.length).toBe(0); // … nor the gate ran
    expect(f.controller.snapshot()?.budgetWrapupPending).toBe(true);
    expect(f.controller.snapshot()?.continuationsUsed).toBe(1);
  });

  it("B2: the wrap-up round is the LAST — next stop allows + budget_limited entry with the usage report", async () => {
    const f = fixture({ verdicts: ["VERDICT: not-yet\nunreached"] });
    await f.controller.set("tests green", { budgetTokens: 100 });
    f.controller.recordMainUsage({ promptTokens: 80, completionTokens: 40 }, "main");
    await f.controller.onStop(state(f.messages)); // the wrap-up block
    const d2 = await f.controller.onStop(state(f.messages));
    expect(d2).toBe("allow"); // forced close — the budget path never blocks twice
    expect(f.controller.active()).toBe(false);
    const last = f.entries.at(-1) as { type: string; data: { outcome: string; usageReport?: string } };
    expect(last.type).toBe("goal_outcome");
    expect(last.data.outcome).toBe("budget_limited");
    expect(last.data.usageReport).toContain("tokens used 120 of budget 100");
    expect(last.data.usageReport).toContain("continuations 1");
    expect(last.data.usageReport).toContain("duration");
    expect(f.evaluatorCalls()).toBe(0);
  });

  it("B3: metering counts ONLY main calls — subagent/evaluator rows never land in mainTokensUsed", async () => {
    const f = fixture({});
    await f.controller.set("tests green", { budgetTokens: 1000 });
    f.controller.recordMainUsage({ promptTokens: 100, completionTokens: 50 }, "subagent");
    f.controller.recordMainUsage({ promptTokens: 200, completionTokens: 50 }, "evaluator");
    expect(f.controller.snapshot()?.mainTokensUsed).toBe(0);
    f.controller.recordMainUsage({ promptTokens: 300, completionTokens: 60 }); // untagged = main
    f.controller.recordMainUsage({ promptTokens: 100, completionTokens: 40 }, "title");
    expect(f.controller.snapshot()?.mainTokensUsed).toBe(500);
  });
});

describe("ω99-13 §2.4 — status, restore, availability", () => {
  it("C2: status shows the metering/gate/budget lines; restore re-arms gate/budget with counters reset", async () => {
    const f = fixture({ gateResults: [{ code: 1, output: "boom" }] });
    await f.controller.set("tests green", { gate: { command: "npm test" }, budgetTokens: 5000 });
    f.controller.recordMainUsage({ promptTokens: 400, completionTokens: 100 }, "main");
    await f.controller.onStop(state(f.messages)); // gate red: attempts → 1
    const s = f.controller.status();
    expect(s).toContain("main tokens: 500 · continuations: 1"); // the gate-red block counted
    expect(s).toContain("gate: npm test (attempts 1)");
    expect(s).toContain("budget: 500/5000");
    // ω99-14: restore re-arms gate/budget from the entry set() itself
    // persisted — counters reset to zero, budget re-armed FULL (the old
    // run's partial usage NOT inherited).
    expect(f.controller.restoreFromEntries([...f.entries])).toBe(true);
    const snap = f.controller.snapshot();
    expect(snap?.gate).toEqual({ command: "npm test" });
    expect(snap?.budgetTokens).toBe(5000);
    expect(snap?.mainTokensUsed).toBe(0);
    expect(snap?.gateAttempts).toBe(0);
    expect(snap?.continuationsUsed).toBe(0);
    expect(f.controller.status()).toContain("main tokens: 0");
    expect(f.controller.status()).toContain("gate: npm test (attempts 0)");
    expect(f.controller.status()).toContain("budget: 0/5000");
  });

  it("the gate rides the evaluator's availability gate: WUDAO_DISABLE_HOOKS=1 refuses the set", async () => {
    const f = fixture({ env: { WUDAO_DISABLE_HOOKS: "1" } });
    const notice = await f.controller.set("tests green", { gate: { command: "npm test" } });
    expect(notice.startsWith("⚠️")).toBe(true);
    expect(notice).toContain("WUDAO_DISABLE_HOOKS");
    expect(f.controller.active()).toBe(false);
    expect(f.gateCalls.length).toBe(0);
  });
});

// ω99-14 — persist + re-arm across restore: the goal_set entry carries
// gate/budget (additive fields), restore re-arms BOTH constraints with
// counters zeroed (budget re-armed FULL, not the old run's partial usage),
// and corrupt/hand-edited fields degrade to condition-only — never throw.
describe("ω99-14 — gate/budget persist on goal_set and re-arm on restore", () => {
  it("R1: set persists gate/budget on the entry; a flagless set stays the old shape (fields absent)", async () => {
    const f = fixture({});
    await f.controller.set("ship it", { gate: { command: "npm test" }, budgetTokens: 200000 });
    const e = f.entries[0] as { type: string; data: Record<string, unknown> };
    expect(e.type).toBe("goal_set");
    expect(e.data.condition).toBe("ship it");
    expect(e.data.gate).toBe("npm test");
    expect(e.data.budgetTokens).toBe(200000);
    // No flags = the old byte-shape: the keys are ABSENT, not undefined.
    const plain = fixture({});
    await plain.controller.set("plain goal");
    const d = (plain.entries[0] as { data: Record<string, unknown> }).data;
    expect("gate" in d).toBe(false);
    expect("budgetTokens" in d).toBe(false);
  });

  it("R2: restore re-arms gate/budget — counters zero, notice says re-armed, the gate actually runs at the next seam", async () => {
    const f = fixture({});
    expect(f.controller.restoreFromEntries([buildGoalSetEntry("ship it", new Date(), { gate: "npm test", budgetTokens: 200000 })])).toBe(true);
    const snap = f.controller.snapshot();
    expect(snap?.gate).toEqual({ command: "npm test" });
    expect(snap?.budgetTokens).toBe(200000);
    expect(snap?.mainTokensUsed).toBe(0);
    expect(snap?.gateAttempts).toBe(0);
    expect(snap?.continuationsUsed).toBe(0);
    const notice = f.notices.at(-1) ?? "";
    expect(notice).toContain("restored on resume");
    expect(notice).toContain("re-armed");
    expect(notice).toContain("200000");
    // Behavioral proof: the re-armed gate RUNS at the next stop seam (the
    // restore armed real constraints, not just snapshot fields).
    await f.controller.onStop(state(f.messages));
    expect(f.gateCalls.length).toBe(1);
    expect(f.gateCalls[0]?.command).toBe("npm test");
  });

  it("R3: an old-shape entry (no gate/budget fields) restores condition-only — the pre-ω99-14 behavior", () => {
    const f = fixture({});
    expect(f.controller.restoreFromEntries([buildGoalSetEntry("legacy goal")])).toBe(true);
    const snap = f.controller.snapshot();
    expect(snap?.condition).toBe("legacy goal");
    expect(snap?.gate).toBeUndefined();
    expect(snap?.budgetTokens).toBeUndefined();
    expect(f.controller.status()).not.toContain("gate:");
    expect(f.notices.at(-1) ?? "").not.toContain("re-armed");
  });

  it('R4: corrupt fields are dropped — budgetTokens "abc" + over-long gate → condition-only, no throw', () => {
    const f = fixture({});
    const handEdited = [
      { type: "goal_set", data: { condition: "hand-edited", at: "2026-09-01T00:00:00.000Z", budgetTokens: "abc", gate: "c".repeat(501) } },
    ];
    expect(f.controller.restoreFromEntries(handEdited)).toBe(true);
    const snap = f.controller.snapshot();
    expect(snap?.condition).toBe("hand-edited");
    expect(snap?.gate).toBeUndefined();
    expect(snap?.budgetTokens).toBeUndefined();
    expect(f.notices.at(-1) ?? "").not.toContain("re-armed");
  });
});
