// M61 §3 — /goal: the blocking prompt-based Stop hook (continue:false +
// block cap), the evaluator's three verdicts, the stall guard (pause + goal
// kept + prompt resumes), the evaluator token column, availability (trust
// gate / disableAllHooks), and the resume projection.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop, STOP_BLOCK_CAP, createJsonlSessionStore, type AgentState, type AssistantMessage, type LoopOptions, type ModelClient, type Terminal } from "@wudao/core";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";
import {
  parseGoalCommand,
  parseGoalVerdict,
  transcriptDigest,
  goalEvaluatorAvailable,
  cheapestMatrixModel,
  createGoalController,
  routeHeadlessGoalCommand,
  GOAL_CONDITION_MAX_CHARS,
  type GoalController,
  type EvaluatorModel,
} from "../src/goal.js";
import { buildGoalSetEntry, buildGoalOutcomeEntry, activeGoalFromEntries } from "../src/session-entry.js";
import { recordUsage, emptyUsageTotals, formatCostReport } from "../src/commands/cost.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
// win32 full-suite load: spawn-heavy children outrun 4s budgets — widen there
// (posix load occasionally trips the same class; 10s everywhere is still
// far under a failure being mistaken for a hang).
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "m61-goal-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

/** Scripted ModelClient — the loop and the evaluator share one queue (the
 *  driver's fallback evaluator IS the session model in these tests). */
function scripted(responses: readonly AssistantMessage[]): ModelClient {
  let i = 0;
  return {
    generate: async () => {
      const r = responses[i];
      i += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

const state = (messages: AgentState["messages"]): AgentState => ({
  systemPrompt: "s",
  messages,
  tools: [],
  status: "running",
});

describe("M61 §3 — the blocking Stop hook (core loop)", () => {
  it("{continue:false} continues one more turn; the block cap stops after 3 no-tool continuations", async () => {
    // The model never uses tools; the hook always wants one more turn.
    let hookCalls = 0;
    const options: LoopOptions = {
      maxTurns: 50,
      hooks: {
        onRunStop: async () => {
          hookCalls += 1;
          return { continue: false, reason: "keep going" };
        },
      },
    };
    let events = 0;
    const gen = runAgentLoop(
      state([{ role: "user", content: "go" }]),
      scripted(Array.from({ length: 6 }, () => ({ role: "assistant" as const, content: "answer" }))),
      options,
    );
    let result = await gen.next();
    while (!result.done) {
      events += 1;
      result = await gen.next();
    }
    const terminal = result.value as Terminal;
    // 1 initial stop + 3 capped continuations = 4 hook calls, then the cap.
    expect(hookCalls).toBe(STOP_BLOCK_CAP + 1);
    expect(terminal.reason).toBe("completed");
    expect((terminal as { stopBlockCapped?: boolean }).stopBlockCapped).toBe(true);
    expect(events).toBeGreaterThan(0);
  });

  it("tool use between blocks resets the cap counter", async () => {
    // Turn plan: answer → block → tool turn → answer → block → tool turn → answer → block → answer(capped path avoided until 3 consecutive)
    const responses: AssistantMessage[] = [
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "noop", arguments: {} }] },
      { role: "assistant", content: "a2" },
      { role: "assistant", content: "", toolCalls: [{ id: "t2", name: "noop", arguments: {} }] },
      { role: "assistant", content: "a3" },
      { role: "assistant", content: "a4" },
      { role: "assistant", content: "a5" },
      { role: "assistant", content: "a6" },
      { role: "assistant", content: "a7" },
    ];
    let hookCalls = 0;
    const gen = runAgentLoop(state([{ role: "user", content: "go" }]), scripted(responses), {
      maxTurns: 50,
      hooks: { onRunStop: async () => { hookCalls += 1; return { block: true, reason: "more" } as const; } },
    });
    let result = await gen.next();
    while (!result.done) result = await gen.next();
    // Tool turns reset the streak: the cap only triggers on 3 CONSECUTIVE
    // no-tool continuations — the resets stretched 3 no-tool blocks across 6
    // blocks, and the 7th block (3rd consecutive) finally caps.
    expect(hookCalls).toBeGreaterThanOrEqual(STOP_BLOCK_CAP + 1);
    expect((result.value as Terminal).reason).toBe("completed");
  });
});

describe("M61 §3 — verdict parsing and commands", () => {
  it("parses the three verdicts and rejects verdict-free text", () => {
    expect(parseGoalVerdict("VERDICT: met\nthe build passed")).toEqual({ kind: "met", reason: "the build passed" });
    expect(parseGoalVerdict("blah\nVERDICT: not-yet\nstill missing the test fix")).toEqual({ kind: "not-yet", reason: "still missing the test fix" });
    expect(parseGoalVerdict("VERDICT: impossible — the API has no such endpoint")).toEqual({ kind: "impossible", reason: "the API has no such endpoint" });
    expect(parseGoalVerdict("I think it is done")).toBeUndefined();
  });

  it("parseGoalCommand: set / clear aliases / bare status", () => {
    expect(parseGoalCommand("make tests pass")).toEqual({ kind: "set", condition: "make tests pass" });
    for (const word of ["clear", "stop", "off", "reset", "none", "cancel"]) {
      expect(parseGoalCommand(word)).toEqual({ kind: "clear" });
      expect(parseGoalCommand(`${word} now`)).toEqual({ kind: "clear" });
    }
    expect(parseGoalCommand("")).toEqual({ kind: "status" });
  });

  it("transcriptDigest stays within budget and marks truncation", () => {
    const msgs = Array.from({ length: 1000 }, (_, i) => ({ role: "user", content: `x`.repeat(100) + i }));
    const digest = transcriptDigest(msgs, 5_000);
    expect(digest.length).toBeLessThanOrEqual(5_000 + 200);
    expect(digest).toContain("truncated");
    expect(digest.endsWith("x999")).toBe(true); // newest last survives
  });
});

describe("M61 §3 — availability and evaluator model", () => {
  it("WUDAO_DISABLE_HOOKS=1 explains why /goal cannot run", async () => {
    const r = await goalEvaluatorAvailable({ WUDAO_DISABLE_HOOKS: "1" }, ws);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("WUDAO_DISABLE_HOOKS");
  });

  it("a trusted workspace is available", async () => {
    const r = await goalEvaluatorAvailable({}, ws);
    expect(r.ok).toBe(true);
  });

  it("a project-tier privilege escalation (bypassPermissions) makes /goal unavailable — with the reason", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(ws, ".wudao"), { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(ws, ".wudao", "settings.json"),
      JSON.stringify({ bypassPermissions: true }),
      "utf8",
    );
    const r = await goalEvaluatorAvailable({ WUDAO_GLOBAL_HOME: join(ws, "no-global") }, ws);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("trust gate");
      expect(r.reason).toContain("bypassPermissions");
    }
  });

  it("cheapestMatrixModel picks the lowest-priced resolvable model", () => {
    // WUDAO_GLOBAL_HOME pins the credentials fallback to an empty dir so the
    // matrix resolves ONLY from this env (an operator's real credentials file
    // would otherwise fill providers the test means to leave unkeyed).
    const env = {
      WUDAO_API_KEY: "k",
      WUDAO_PROVIDER: "deepseek",
      WUDAO_GLOBAL_HOME: join(tmpdir(), "m61-goal-empty-home"),
      WUDAO_PRICE_DEEPSEEK_V4_FLASH: "0.1,0.3,0.03,0.06",
    };
    // The lowest-priced RESOLVABLE model wins (priced models with no provider
    // config never enter the race).
    expect(cheapestMatrixModel(env)).toEqual({ provider: "deepseek", model: "deepseek-v4-flash" });
    // Unpriced, no flash/mini tier → nothing cheap to pick.
    expect(cheapestMatrixModel({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "deepseek", WUDAO_MODEL: "big-serious", WUDAO_GLOBAL_HOME: env.WUDAO_GLOBAL_HOME })).toBeUndefined();
    expect(cheapestMatrixModel({ WUDAO_GLOBAL_HOME: env.WUDAO_GLOBAL_HOME })).toBeUndefined();
  });
});

describe("M61 §3 — the controller", () => {
  function fixture(verdicts: readonly string[]) {
    const evalModel: EvaluatorModel = { client: scripted(verdicts.map((v) => ({ role: "assistant", content: v }))), label: "test-eval", fallback: false };
    const entries: unknown[] = [];
    const notices: string[] = [];
    const usage: unknown[] = [];
    const messages: AgentState["messages"] = [{ role: "user", content: "go" }, { role: "assistant", content: "did the thing" }];
    const controller = createGoalController({
      workspaceRoot: ws,
      sessionId: () => "s-goal",
      getMessages: () => messages,
      evaluator: evalModel,
      appendEntry: async (e) => {
        entries.push(e);
      },
      notify: (t) => notices.push(t),
      onEvaluatorUsage: (u) => usage.push(u),
      env: {},
    });
    return { controller, entries, notices, usage, messages };
  }

  it("set refuses >4000 chars, records goal_set, and status shows the fields", async () => {
    const f = fixture([]);
    expect((await f.controller.set("x".repeat(GOAL_CONDITION_MAX_CHARS + 1))).startsWith("⚠️")).toBe(true);
    const notice = await f.controller.set("all tests green");
    expect(notice).toContain("goal set");
    expect(f.entries[0]).toMatchObject({ type: "goal_set", data: { condition: "all tests green" } });
    f.controller.status().includes("all tests green");
    expect(f.controller.status()).toContain("evaluated rounds: 0");
    expect(f.controller.active()).toBe(true);
  });

  it("not-yet blocks with the evaluator guidance injected", async () => {
    const f = fixture(["VERDICT: not-yet\nthe failing test is still red"]);
    await f.controller.set("tests green");
    const decision = await f.controller.onStop(state(f.messages));
    expect(decision).toEqual({ block: true, reason: "goal not yet met — evaluator guidance: the failing test is still red" });
    expect(f.controller.snapshot()?.evaluatedRounds).toBe(1);
    expect(f.controller.status()).toContain("not-yet: the failing test is still red");
  });

  it("met allows the stop and records achieved; impossible records failed + reason", async () => {
    const met = fixture(["VERDICT: met\neverything passes"]);
    await met.controller.set("tests green");
    expect(await met.controller.onStop(state(met.messages))).toBe("allow");
    expect(met.controller.active()).toBe(false);
    expect(met.notices.some((n) => n.includes("MET"))).toBe(true);
    expect(met.entries.at(-1)).toMatchObject({ type: "goal_outcome", data: { outcome: "achieved", reason: "everything passes" } });

    const imp = fixture(["VERDICT: impossible\nno such API exists"]);
    await imp.controller.set("call the missing API");
    expect(await imp.controller.onStop(state(imp.messages))).toBe("allow");
    expect(imp.entries.at(-1)).toMatchObject({ type: "goal_outcome", data: { outcome: "failed", reason: "no such API exists" } });
    expect(imp.notices.some((n) => n.includes("IMPOSSIBLE"))).toBe(true);
  });

  it("a verdict-free evaluator allows the stop without clearing the goal", async () => {
    const f = fixture(["I am not sure"]);
    await f.controller.set("tests green");
    expect(await f.controller.onStop(state(f.messages))).toBe("allow");
    expect(f.controller.active()).toBe(true);
  });

  it("stall guard: capped run pauses (goal kept), the next prompt resumes", async () => {
    const f = fixture(["VERDICT: not-yet\nkeep going"]);
    await f.controller.set("tests green");
    await f.controller.onStop(state(f.messages)); // not-yet (for the stall inference)
    f.controller.onRunEnd({ stopBlockCapped: true });
    expect(f.controller.snapshot()?.paused).toBe(true);
    expect(f.controller.active()).toBe(true); // goal KEPT
    expect(f.notices.some((n) => n.includes("stall guard"))).toBe(true);
    // A paused goal does not evaluate; the next user prompt resumes.
    expect(await f.controller.onStop(state(f.messages))).toBe("allow");
    f.controller.onUserPrompt();
    expect(f.controller.snapshot()?.paused).toBe(false);
  });

  it("restoreFromEntries: active goal restored with counters reset; outcome closes", () => {
    const f = fixture([]);
    expect(f.controller.restoreFromEntries([buildGoalSetEntry("ship it")])).toBe(true);
    const snap = f.controller.snapshot();
    expect(snap?.condition).toBe("ship it");
    expect(snap?.evaluatedRounds).toBe(0);
    const closed = fixture([]);
    expect(closed.controller.restoreFromEntries([buildGoalSetEntry("ship it"), buildGoalOutcomeEntry("achieved", "done")])).toBe(false);
    expect(closed.controller.active()).toBe(false);
  });

  it("activeGoalFromEntries walks set/outcome pairs", () => {
    expect(activeGoalFromEntries([buildGoalSetEntry("a"), buildGoalSetEntry("b")])?.condition).toBe("b");
    expect(activeGoalFromEntries([buildGoalSetEntry("a"), buildGoalOutcomeEntry("cleared")])).toBeUndefined();
  });

  it("evaluator tokens ride ONLY their own column — the shared totals stay the agent's", () => {
    let totals = emptyUsageTotals();
    totals = recordUsage(totals, { promptTokens: 100, cacheHitTokens: 0, cacheMissTokens: 100, completionTokens: 20, evaluatorTokens: 120 });
    // Review LOW-MED 2 pin: the evaluator row added NOTHING to the shared
    // folds — a structurally cold judge call must not drag /cost's cache%.
    expect(totals).toEqual({ promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, calls: 0, evaluatorTokens: 120 });
    totals = recordUsage(totals, { promptTokens: 500, cacheHitTokens: 400, cacheMissTokens: 100, completionTokens: 80 });
    expect(totals).toEqual({ promptTokens: 500, completionTokens: 80, cacheHitTokens: 400, cacheMissTokens: 100, calls: 1, evaluatorTokens: 120 });
    const report = formatCostReport(totals, { startedAt: Date.now() - 1000 });
    expect(report).toContain("评审：120 tokens"); // ω99-187: 钉随源演进
    expect(report).toContain("缓存 80.0%"); // ω99-187: 钉随源演进
  });
});

describe("M61 §3 — the headless /goal router (re-review BLOCKER)", () => {
  it("set RUNS; clear closes a restored goal and exits; status prints and exits; a failed set exits", async () => {
    const gws = await mkdtemp(join(tmpdir(), "m61-hg-"));
    const entries: unknown[] = [buildGoalSetEntry("ship it")];
    const loadEntries = async () => entries as readonly unknown[];
    const mk = async () => {
      const controller = createGoalController({
        workspaceRoot: gws,
        sessionId: () => "s-hg",
        getMessages: () => [{ role: "user", content: "go" }],
        evaluator: { client: { generate: async () => ({ role: "assistant", content: "VERDICT: met" }) }, label: "e", fallback: false },
        appendEntry: async (e) => {
          entries.push(e);
        },
        notify: () => {},
        env: {},
      });
      return controller;
    };

    // set → run (and the set notice rides along).
    const c1 = await mk();
    const set = await routeHeadlessGoalCommand(parseGoalCommand("make tests pass"), {
      controller: c1,
      loadEntries: async () => [],
      availability: async () => ({ ok: true }),
    });
    expect(set.kind).toBe("run");
    if (set.kind === "run") expect(set.notice).toContain("goal set");

    // clear → exit, and a RESTORED goal actually closes.
    const c2 = await mk();
    const clear = await routeHeadlessGoalCommand(parseGoalCommand("clear"), {
      controller: c2,
      loadEntries,
      availability: async () => ({ ok: true }),
    });
    expect(clear.kind).toBe("exit");
    if (clear.kind === "exit") expect(clear.notice).toContain("cleared");
    expect(c2.active()).toBe(false);
    expect((entries.at(-1) as { type: string }).type).toBe("goal_outcome");

    // clear with nothing restored → exit, no goal active.
    const c3 = await mk();
    const emptyClear = await routeHeadlessGoalCommand(parseGoalCommand("stop"), {
      controller: c3,
      loadEntries: async () => [],
      availability: async () => ({ ok: true }),
    });
    expect(emptyClear).toEqual({ kind: "exit", notice: "(no goal active)" });

    // bare status → exit with the status one-pager of a restored goal (the
    // snapshot WITHOUT the clear's outcome entry).
    const c4 = await mk();
    const status = await routeHeadlessGoalCommand(parseGoalCommand(""), {
      controller: c4,
      loadEntries: async () => [buildGoalSetEntry("ship it")],
      availability: async () => ({ ok: true }),
    });
    expect(status.kind).toBe("exit");
    if (status.kind === "exit") expect(status.notice).toContain("ship it");

    // failed availability → exit with the reason, nothing set.
    const c5 = await mk();
    const refused = await routeHeadlessGoalCommand(parseGoalCommand("x"), {
      controller: c5,
      loadEntries: async () => [],
      availability: async () => ({ ok: false, reason: "hooks are disabled" }),
    });
    expect(refused).toEqual({ kind: "exit", notice: "⚠️ hooks are disabled" });
    expect(c5.active()).toBe(false);
    await rm(gws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  });
});

describe("M61 §3 — driver integration", () => {
  it("/goal sets + starts; not-yet continues; met stops — verdicts land as notices", async () => {
    // Isolate the provider matrix: no priced/flash model may resolve, so the
    // evaluator falls back to the scripted session model.
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("WUDAO_PRICE_") || k.endsWith("_API_KEY")) {
        saved[k] = process.env[k];
        delete process.env[k];
      }
    }
    // Interleaved scripted queue: loop answer, eval not-yet, loop answer, eval met.
    const model = scripted([
      { role: "assistant", content: "still working" },
      { role: "assistant", content: "VERDICT: not-yet\nthe failing test is still red" },
      { role: "assistant", content: "fixed it, all green" },
      { role: "assistant", content: "VERDICT: met\nall tests pass now" },
    ]);
    const store = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
    const driver: AgentDriver = createAgentDriver({
      model,
      tools: [],
      systemPrompt: "sp",
      summarize: summarizeToolCall,
      onPermissionAsk: async () => ({ kind: "allow" }),
      workspaceRoot: ws,
      goal: true,
      sessionStore: store,
      statusline: { model: "test-model", version: "0" },
    });
    driver.submit("/goal make all tests pass");
    // 设置即开局: the condition becomes the run's first instruction.
    await until(() => driver.getHistory().some((h) => h.kind === "user" && h.text.includes("make all tests pass")), "goal run to start");
    await until(() => driver.getStatus().busy === false, "goal run to settle");
    const history = driver.getHistory();
    // The condition itself is the first turn's instruction.
    expect(history.some((h) => h.kind === "user" && h.text.includes("make all tests pass"))).toBe(true);
    // The evaluator's guidance rode a [stop blocked] continuation.
    expect(history.some((h) => h.kind === "notice" && h.text.includes("MET"))).toBe(true);
    expect(history.some((h) => h.kind === "notice" && h.text.includes("goal set"))).toBe(true);
    // Entries landed in the JSONL. The persist is append-buffered — under a
    // loaded pool a single read can race the goal_set flush even after the
    // run settled. Poll until BOTH types are visible.
    const entryTypesBy = Date.now() + 15_000;
    let types: string[] = [];
    for (;;) {
      const entries = await store.loadSessionEntries(driver.getSessionId());
      types = entries.filter((e) => !("role" in e)).map((e) => (e as { type: string }).type);
      if (types.includes("goal_set") && types.includes("goal_outcome")) break;
      if (Date.now() > entryTypesBy) break;
      await wait(50);
    }
    expect(types).toContain("goal_set");
    expect(types).toContain("goal_outcome");
    driver.dispose();
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v;
    }
  });
});
