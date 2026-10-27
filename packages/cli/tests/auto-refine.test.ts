// ω99-7 — auto-refine trigger layer: the pure two-level decision (turn
// count / compaction → cheap JSON gate → the EXISTING applyRefinement
// pipeline, zero new write permissions), the debounce (cooldown stamps on
// EVERY failure path, pending flags preserved through busy/cooldown,
// inProgress serialization), assistant-turn counting, the observational
// hooks wrapper (never blocks a run), and the qm-consolidation rules riding
// REFINE_SYSTEM_PROMPT.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentHooks, AgentState, ModelClient, ModelInput, AgentMessage } from "@wudao/core";
import {
  shouldTriggerAutoRefine,
  countAssistantTurns,
  reviewAutoRefineGate,
  createAutoRefineRuntime,
  observeAutoRefineOnHooks,
  AUTO_REFINE_GATE_SYSTEM_PROMPT,
  REFINE_SYSTEM_PROMPT,
  openMemoryStore,
  readRefinementAudit,
} from "../src/memory/index.js";
import type { AutoRefineRuntime } from "../src/memory/index.js";
// ω99-7b: the pure digest ships without re-opening the index export surface.
import { summarizeEditActivity } from "../src/memory/auto-refine.js";
import { DEFAULT_REFINE_AUTO } from "../src/refine-auto-config.js";
import type { RefineAutoSettings } from "../src/refine-auto-config.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wudao-auto-refine-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const GATE_YES = '{"shouldRefine":true,"rationale":"durable tool lesson"}';
const GATE_NO = '{"shouldRefine":false,"rationale":"nothing settled yet"}';
const PLAN_ONE = JSON.stringify({
  summary: "one plan-gate note",
  rationale: "r",
  expectedOutcome: "o",
  edits: [{ action: "create", kind: "harness", content: "gate plan mode on an explicit ask", evidence: "user asked twice" }],
});

/** The scripted model (memory-refine.test.ts 造法): answers each reply in
 *  order, capturing every ModelInput so gate/refine calls are countable. */
function scriptModel(replies: string[]): { model: ModelClient; inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    model: {
      async generate(input: ModelInput) {
        inputs.push(input);
        const reply = replies[i];
        i += 1;
        return { role: "assistant", content: reply ?? GATE_NO };
      },
    },
  };
}

function cfg(over: Partial<RefineAutoSettings> = {}): RefineAutoSettings {
  return { ...DEFAULT_REFINE_AUTO, enabled: true, ...over };
}

/** n assistant turns interleaved with tool results (the realistic shape). */
function turns(n: number): AgentMessage[] {
  const out: AgentMessage[] = [{ role: "user", content: "do the thing" }];
  for (let i = 0; i < n; i += 1) {
    out.push({ role: "assistant", content: `answer ${i}` });
    out.push({ role: "tool", toolCallId: `c${i}`, name: "bash", content: "ok" });
  }
  return out;
}

/** A runtime over the tmpdir store with injectable time; notices captured. */
function makeRt(over: { cfg?: RefineAutoSettings; now?: () => number } = {}): { rt: AutoRefineRuntime; notices: string[] } {
  const notices: string[] = [];
  const rt = createAutoRefineRuntime({
    cfg: over.cfg ?? cfg({ turnInterval: 2, cooldownMs: 1_000 }),
    workspaceRoot: dir,
    openStore: () => openMemoryStore(dir),
    onNotice: (t2) => notices.push(t2),
    now: over.now ?? (() => 10_000),
  });
  return { rt, notices };
}

/** The gate prompts seen by the scripted model (filter by system prompt). */
function gateCalls(inputs: ModelInput[]): ModelInput[] {
  return inputs.filter((i) => i.systemPrompt === AUTO_REFINE_GATE_SYSTEM_PROMPT);
}

// ---------------------------------------------------------------------------
// shouldTriggerAutoRefine — the pure decision
// ---------------------------------------------------------------------------

describe("shouldTriggerAutoRefine — 纯决策", () => {
  const base = { cfg: cfg({ turnInterval: 25 }), now: 100_000, lastAt: 0, inProgress: false };
  it("turns < interval → no", () => {
    expect(shouldTriggerAutoRefine({ ...base, assistantTurnsSince: 24, compactPending: false })).toMatchObject({ run: false });
  });
  it("turns ≥ interval → yes, reason turns", () => {
    expect(shouldTriggerAutoRefine({ ...base, assistantTurnsSince: 25, compactPending: false })).toEqual({ run: true, reason: "turns" });
  });
  it("compactPending → yes, reason compact (outranks the turn count)", () => {
    expect(shouldTriggerAutoRefine({ ...base, assistantTurnsSince: 0, compactPending: true })).toEqual({ run: true, reason: "compact" });
  });
  it("compactPending with cfg.compact=false falls through to the turns check", () => {
    const d = shouldTriggerAutoRefine({ ...base, cfg: cfg({ turnInterval: 25, compact: false }), assistantTurnsSince: 30, compactPending: true });
    expect(d).toEqual({ run: true, reason: "turns" });
  });
  it("inside cooldown → skip (pending preservation is the shell's job)", () => {
    const d = shouldTriggerAutoRefine({ ...base, cfg: cfg({ cooldownMs: 60_000 }), assistantTurnsSince: 30, compactPending: true, now: 120_000, lastAt: 100_000 });
    expect(d).toEqual({ run: false, reason: "cooldown-skip" });
  });
  it("inProgress → no (busy)", () => {
    expect(shouldTriggerAutoRefine({ ...base, assistantTurnsSince: 30, inProgress: true })).toMatchObject({ run: false });
  });
  it("disabled → off", () => {
    expect(shouldTriggerAutoRefine({ ...base, cfg: { ...base.cfg, enabled: false }, assistantTurnsSince: 30 })).toEqual({ run: false, reason: "off" });
  });
});

describe("countAssistantTurns — 计数面", () => {
  it("counts assistant messages; tool-call-only rounds are assistant turns too", () => {
    const msgs: AgentMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "bash", input: {} } as never] },
      { role: "tool", toolCallId: "c1", name: "bash", content: "ok" },
      { role: "assistant", content: "done" },
    ];
    expect(countAssistantTurns(msgs)).toBe(2);
    expect(countAssistantTurns(turns(3))).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// reviewAutoRefineGate — the cheap JSON boolean gate (extractProposalJson reuse)
// ---------------------------------------------------------------------------

describe("reviewAutoRefineGate — 便宜门", () => {
  it("parses a bare JSON verdict", async () => {
    const { model, inputs } = scriptModel([GATE_YES]);
    const v = await reviewAutoRefineGate(model, turns(2), { reason: "turns", turnsSinceLastReview: 2 });
    expect(v.shouldRefine).toBe(true);
    expect(v.rationale).toBe("durable tool lesson");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.tools).toEqual([]);
    expect(inputs[0]?.messages[0]?.content).toContain("2 assistant turns since");
  });

  it("parses a fence-wrapped verdict (the ③-level tolerance)", async () => {
    const { model } = scriptModel(["```json\n" + GATE_YES + "\n```"]);
    expect((await reviewAutoRefineGate(model, [], { reason: "compact", turnsSinceLastReview: 0 })).shouldRefine).toBe(true);
  });

  it("garbage → shouldRefine=false, never throws (the runtime stamps the cooldown)", async () => {
    const { model } = scriptModel(["I cannot answer in JSON, sorry!"]);
    const v = await reviewAutoRefineGate(model, [], { reason: "turns", turnsSinceLastReview: 2 });
    expect(v.shouldRefine).toBe(false);
  });

  it("a thrown generate propagates (network) — the runtime's catch stamps", async () => {
    const model: ModelClient = {
      async generate() {
        throw new Error("boom");
      },
    };
    await expect(reviewAutoRefineGate(model, [], { reason: "turns", turnsSinceLastReview: 2 })).rejects.toThrow("boom");
  });
});

// ---------------------------------------------------------------------------
// createAutoRefineRuntime — gate → the EXISTING pipeline, plus the debounce
// ---------------------------------------------------------------------------

describe("createAutoRefineRuntime — 门 + 既有管线 + 防抖", () => {
  it("gate yes → ONE gate call + applyRefinement ran (pending entry, audit, notice); counts reset", async () => {
    const { rt, notices } = makeRt();
    const { model, inputs } = scriptModel([GATE_YES, PLAN_ONE]);
    await rt.noteRunStopped(turns(2), model);
    expect(gateCalls(inputs)).toHaveLength(1);
    expect(inputs).toHaveLength(2); // gate + exactly one planRefinement
    // 三纪律继承: create 必 pending —— the auto path gains NO new write permission.
    const h = (await openMemoryStore(dir).load()).find((e) => e.kind === "harness");
    expect(h?.status).toBe("pending");
    expect((await readRefinementAudit(dir)).at(0)?.summary).toBe("one plan-gate note");
    expect(notices.join("\n")).toContain("🧠 refine");
    const snap = rt.snapshot();
    expect(snap.lastAt).toBe(10_000); // stamped
    expect(snap.baselineTurns).toBe(2); // counting reset — the same tail is not re-refined
    expect(snap.inProgress).toBe(false);
    // 计数清零: the same messages stop again → no new gate call.
    await rt.noteRunStopped(turns(2), model);
    expect(inputs).toHaveLength(2);
  });

  it("gate no → no apply, stamp + counts reset", async () => {
    const { rt } = makeRt();
    const { model, inputs } = scriptModel([GATE_NO]);
    await rt.noteRunStopped(turns(2), model);
    expect(inputs).toHaveLength(1);
    expect(rt.snapshot()).toMatchObject({ lastAt: 10_000, baselineTurns: 2, inProgress: false });
    expect((await openMemoryStore(dir).load())).toHaveLength(0);
  });

  it("gate garbage → same as no: no apply + stamp (the debounce-critical assertion)", async () => {
    const { rt } = makeRt();
    const { model, inputs } = scriptModel(["total garbage, no object"]);
    await rt.noteRunStopped(turns(2), model);
    expect(inputs).toHaveLength(1);
    expect(rt.snapshot().lastAt).toBe(10_000);
  });

  it("gate throw → no apply + stamp, counts KEPT (re-qualifies after the cooldown); never surfaces", async () => {
    const t = (() => 10_000);
    const { rt } = makeRt({ now: t });
    const boom: ModelClient = { async generate() { throw new Error("net down"); } };
    await expect(rt.noteRunStopped(turns(2), boom)).resolves.toBeUndefined();
    expect(rt.snapshot().lastAt).toBe(10_000);
    expect(rt.snapshot().baselineTurns).toBe(0); // counts survive a failed review
  });

  it("trigger while in flight → no concurrency; the second parks as pending", async () => {
    const { rt } = makeRt();
    let releaseGate: () => void = () => {};
    const gate = new Promise<{ role: "assistant"; content: string }>((res) => {
      releaseGate = () => res({ role: "assistant", content: GATE_NO });
    });
    const inputs: ModelInput[] = [];
    const model: ModelClient = {
      async generate(input: ModelInput) {
        inputs.push(input);
        return input.systemPrompt === AUTO_REFINE_GATE_SYSTEM_PROMPT ? await gate : { role: "assistant", content: PLAN_ONE };
      },
    };
    const first = rt.noteRunStopped(turns(2), model);
    expect(rt.snapshot().inProgress).toBe(true);
    await rt.noteRunStopped(turns(3), model); // busy → parks, resolves immediately
    releaseGate();
    await first;
    expect(gateCalls(inputs)).toHaveLength(1); // exactly ONE review ran
    expect(rt.snapshot().inProgress).toBe(false);
  });

  it("compactPending survives a cooldown and is released after it", async () => {
    let t = 10_000;
    const { rt } = makeRt({ now: () => t, cfg: cfg({ turnInterval: 2, cooldownMs: 1_000 }) });
    const { model, inputs } = scriptModel([GATE_NO, GATE_NO]);
    await rt.noteRunStopped(turns(2), model); // stamps at t=10_000
    rt.noteCompacted();
    t = 10_500; // inside the cooldown
    await rt.noteRunStopped(turns(3), model); // compact flag would fire, but cooldown → skip
    expect(gateCalls(inputs)).toHaveLength(1);
    expect(rt.snapshot().pendingCompact).toBe(true); // 旗保留
    t = 11_001; // cooldown expired
    await rt.noteRunStopped(turns(3), model); // compact reason fires now
    expect(gateCalls(inputs)).toHaveLength(2);
    expect(inputs[1]?.messages[0]?.content).toContain("compact"); // the gate saw the compact trigger
    expect(rt.snapshot().pendingCompact).toBe(false);
  });

  it("disabled cfg → noteRunStopped is a no-op (model never touched)", async () => {
    const { rt } = makeRt({ cfg: cfg({ enabled: false }) });
    const { model, inputs } = scriptModel([GATE_YES]);
    rt.noteCompacted();
    await rt.noteRunStopped(turns(5), model);
    expect(inputs).toHaveLength(0);
  });

  it("no resident model → the fired trigger parks nothing new, never throws", async () => {
    const { rt } = makeRt();
    await expect(rt.noteRunStopped(turns(2), undefined)).resolves.toBeUndefined();
    expect(rt.snapshot().inProgress).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// observeAutoRefineOnHooks — the observational wiring (OFF = byte-zero)
// ---------------------------------------------------------------------------

describe("observeAutoRefineOnHooks — 观察侧接线", () => {
  const fakeState = (n: number) => ({ messages: turns(n) }) as unknown as AgentState;

  it("rt undefined → the hooks object is returned UNCHANGED (byte-zero when OFF)", () => {
    const hooks: AgentHooks = { onRunStart: () => {} };
    expect(observeAutoRefineOnHooks(hooks, undefined, () => undefined)).toBe(hooks);
    expect(observeAutoRefineOnHooks(undefined, undefined, () => undefined)).toBeUndefined();
  });

  it("passes the inner decision through VERBATIM (allow and block); triggers only on allow", async () => {
    const { rt } = makeRt();
    const { model, inputs } = scriptModel([GATE_NO]);
    const block = { block: true, reason: "keep going" } as const;
    const wrapped = observeAutoRefineOnHooks({ onRunStop: async () => block }, rt, () => model);
    expect(await wrapped?.onRunStop?.(fakeState(2))).toEqual(block); // run continues → NO trigger
    expect(inputs).toHaveLength(0);
    expect(await observeAutoRefineOnHooks({ onRunStop: async () => "allow" }, rt, () => model)?.onRunStop?.(fakeState(2))).toBe("allow");
    expect(gateCalls(inputs)).toHaveLength(1); // the run actually stopped → trigger fired
  });

  it("an inner throw degrades to allow and STILL only then triggers", async () => {
    const { rt } = makeRt();
    const { model, inputs } = scriptModel([GATE_NO]);
    const wrapped = observeAutoRefineOnHooks({ onRunStop: async () => { throw new Error("hook bug"); } }, rt, () => model);
    expect(await wrapped?.onRunStop?.(fakeState(2))).toBe("allow");
    expect(gateCalls(inputs)).toHaveLength(1);
  });

  it("the onPostCompact wrapper forwards to the inner hook and notifies the runtime", async () => {
    const { rt } = makeRt();
    const seen: string[] = [];
    const wrapped = observeAutoRefineOnHooks({ onPostCompact: async (m) => { seen.push(String(m.length)); } }, rt, () => undefined);
    await wrapped?.onPostCompact?.(turns(2), "auto");
    expect(seen).toEqual(["5"]);
    expect(rt.snapshot().pendingCompact).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// REFINE_SYSTEM_PROMPT — the qm consolidation rules ride the existing prompt
// ---------------------------------------------------------------------------

describe("REFINE_SYSTEM_PROMPT — qm consolidation 四规则", () => {
  it("carries UPDATE-first / atomicity / prune-derivable / mechanics-vs-user-conventions", () => {
    expect(REFINE_SYSTEM_PROMPT).toContain("UPDATE over DELETE");
    expect(REFINE_SYSTEM_PROMPT).toContain("atomic");
    expect(REFINE_SYSTEM_PROMPT).toContain("stale, contradicted");
    expect(REFINE_SYSTEM_PROMPT).toContain("system mechanics");
    expect(REFINE_SYSTEM_PROMPT).toContain("user-stated conventions");
  });
});

// ---------------------------------------------------------------------------
// ω99-7b — 门输入富化: the deterministic edit-activity digest (pure window
// slice over the same counting face as countAssistantTurns, then injected
// into the SAME gate call — trigger line → digest → trajectory tail).
// Fixtures here use REAL tool names + the real `arguments.path` key — no casts.
// ---------------------------------------------------------------------------

/** An assistant turn carrying tool calls (honest ToolCall shape, no `as`). */
function callTurn(id: string, calls: ReadonlyArray<{ name: string; args: Record<string, unknown> }>): AgentMessage {
  return {
    role: "assistant",
    content: "",
    toolCalls: calls.map((c, k) => ({ id: `${id}-${k}`, name: c.name, arguments: c.args })),
  };
}

describe("summarizeEditActivity — 窗口切片纯函数", () => {
  it("window = last N assistant messages; earlier writes are NOT re-counted (the ω99-7b §0 invariant)", () => {
    const msgs: AgentMessage[] = [
      { role: "user", content: "go" },
      callTurn("a", [{ name: "write_file", args: { path: "old/early.ts" } }]), // assistant 1 — outside
      { role: "tool", toolCallId: "a-0", name: "write_file", content: "ok" },
      callTurn("b", [{ name: "read_file", args: { path: "keep/b.ts" } }]), // assistant 2 — outside
      callTurn("c", [{ name: "write_file", args: { path: "old/late.ts" } }]), // assistant 3 — outside
      { role: "tool", toolCallId: "c-0", name: "write_file", content: "ok" },
      callTurn("d", [ // assistant 4 — inside
        { name: "write_file", args: { path: "new/d1.ts" } },
        { name: "edit", args: { path: "new/d2.ts" } },
      ]),
      { role: "tool", toolCallId: "d-0", name: "write_file", content: "ok" },
      callTurn("e", [{ name: "edit", args: { path: "new/e.ts" } }]), // assistant 5 — inside
    ];
    expect(summarizeEditActivity(msgs, 2)).toEqual({
      writeCalls: 3,
      files: ["new/d1.ts", "new/d2.ts", "new/e.ts"],
    });
  });

  it("counts write_file+edit only; dedupes paths into lexicographic order", () => {
    const msgs: AgentMessage[] = [
      callTurn("a", [
        { name: "write_file", args: { path: "b/second.ts" } },
        { name: "read_file", args: { path: "b/read-ignored.ts" } },
        { name: "shell", args: { command: "npm test" } },
        { name: "edit", args: { path: "a/first.ts" } },
      ]),
      callTurn("b", [
        { name: "write_file", args: { path: "a/first.ts" } },
        { name: "edit", args: { path: "a/first.ts" } },
      ]),
    ];
    expect(summarizeEditActivity(msgs, 2)).toEqual({
      writeCalls: 4, // 2×write_file + 2×edit; read_file/shell never counted
      files: ["a/first.ts", "b/second.ts"], // dedup + 字典序 despite insertion order
    });
  });

  it("since=0 → the honest empty window {0, []}; a non-string path counts the call but collects no file", () => {
    const msgs: AgentMessage[] = [callTurn("a", [{ name: "write_file", args: { path: "x.ts" } }])];
    expect(summarizeEditActivity(msgs, 0)).toEqual({ writeCalls: 0, files: [] });
    const weird: AgentMessage[] = [callTurn("a", [{ name: "write_file", args: { path: 42 } }, { name: "edit", args: {} }])];
    expect(summarizeEditActivity(weird, 1)).toEqual({ writeCalls: 2, files: [] });
  });
});

describe("reviewAutoRefineGate — digest 注入（ω99-7b）", () => {
  it("digest sits AFTER the trigger line and BEFORE the trajectory tail, with the exact deterministic line", async () => {
    const { model, inputs } = scriptModel([GATE_NO]);
    const msgs: AgentMessage[] = [
      { role: "user", content: "go" },
      callTurn("a", [{ name: "read_file", args: { path: "x.ts" } }]),
      callTurn("b", [
        { name: "write_file", args: { path: "apps/z.ts" } },
        { name: "edit", args: { path: "packages/a.ts" } },
        { name: "edit", args: { path: "apps/z.ts" } },
      ]),
    ];
    await reviewAutoRefineGate(model, msgs, { reason: "turns", turnsSinceLastReview: 2 });
    const p = String(inputs[0]?.messages[0]?.content);
    expect(p).toContain("## Run activity since last review");
    expect(p.indexOf("assistant turns since")).toBeLessThan(p.indexOf("## Run activity since last review"));
    expect(p.indexOf("## Run activity since last review")).toBeLessThan(p.indexOf("## Session trajectory"));
    expect(p).toContain("write_file/edit calls: 3 across 2 files (apps/z.ts, packages/a.ts)");
  });

  it("a pure-Q&A run shows the honest zero (aligns with the count line — no misleading digest)", async () => {
    const { model, inputs } = scriptModel([GATE_NO]);
    await reviewAutoRefineGate(model, turns(2), { reason: "turns", turnsSinceLastReview: 2 });
    expect(String(inputs[0]?.messages[0]?.content)).toContain("write_file/edit calls: 0");
  });

  it("file list caps at 12 lexicographic entries with (+N more)", async () => {
    const { model, inputs } = scriptModel([GATE_NO]);
    const files = Array.from({ length: 13 }, (_, i) => `f${String(i).padStart(2, "0")}.ts`);
    const msgs: AgentMessage[] = [callTurn("a", files.map((f) => ({ name: "write_file", args: { path: f } })))];
    await reviewAutoRefineGate(model, msgs, { reason: "turns", turnsSinceLastReview: 1 });
    const p = String(inputs[0]?.messages[0]?.content);
    expect(p).toContain(`write_file/edit calls: 13 across 13 files (${files.slice(0, 12).join(", ")} (+1 more))`);
    expect(p).not.toContain("f12.ts"); // the 13th file is elided, not listed
  });

  it("determinism: the same input yields byte-identical prompts (sort order pinned)", async () => {
    const { model, inputs } = scriptModel([GATE_NO, GATE_NO]);
    const msgs: AgentMessage[] = [
      callTurn("a", [
        { name: "edit", args: { path: "z/last.ts" } },
        { name: "write_file", args: { path: "a/first.ts" } },
      ]),
    ];
    await reviewAutoRefineGate(model, msgs, { reason: "turns", turnsSinceLastReview: 1 });
    await reviewAutoRefineGate(model, msgs, { reason: "turns", turnsSinceLastReview: 1 });
    expect(String(inputs[1]?.messages[0]?.content)).toBe(String(inputs[0]?.messages[0]?.content));
  });
});
