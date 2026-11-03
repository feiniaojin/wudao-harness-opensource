// ω99-3a — /refine session refiner: truncation-aware JSON extraction (the
// prime-agent refinement.ts:570-631 idea, wudao-native), the proposal
// validator (fact 禁入 / ≤5 edits / shape), the planner (one fake-model call,
// 80k trajectory tail bound), apply+audit+rollback integration, and the
// /refine command face. The three safety disciplines run through every
// suite: create 必 pending（forcePending）、update 必转 pending、delete 只建议不执行.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient, ModelInput, AgentMessage } from "@wudao-org/core";
import {
  openMemoryStore,
  extractProposalJson,
  validateProposal,
  planRefinement,
  applyRefinement,
  runRefineCommand,
  readRefinementAudit,
  REFINE_SYSTEM_PROMPT,
  REFINE_TRAJECTORY_CHARS,
  REFINE_MAX_EDITS,
} from "../src/memory/index.js";
import type { RefineProposal } from "../src/memory/index.js";
import { listSlashCommands } from "../src/slash-commands.js";
import { parseReplCommand } from "../src/repl.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wudao-refine-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** The scripted proposer: captures every ModelInput, answers one canned
 *  assistant text. Enough for planRefinement (a single generate call). */
function fakeModel(reply: string): { model: ModelClient; inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  return {
    inputs,
    model: {
      async generate(input: ModelInput) {
        inputs.push(input);
        return { role: "assistant", content: reply };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// extractProposalJson — truncation-aware extraction (pure, the重点 tests)
// ---------------------------------------------------------------------------

describe("extractProposalJson — 截断感知 JSON 抽取", () => {
  it("① parses bare JSON", () => {
    expect(extractProposalJson('{"summary":"s","edits":[]}')).toEqual({ summary: "s", edits: [] });
  });

  it("② strips ```json fences", () => {
    expect(extractProposalJson('```json\n{"summary":"s","edits":[]}\n```')).toEqual({ summary: "s", edits: [] });
  });

  it("③ recovers JSON wrapped in prose via the brace-balance scan", () => {
    expect(extractProposalJson('Here is the plan:\n{"summary":"s","edits":[]}\nHope that helps.')).toEqual({ summary: "s", edits: [] });
  });

  it("③ saves the complete prefix when the tail is truncated garbage", () => {
    // A reply cut mid-second-object still yields the FIRST complete object.
    expect(extractProposalJson('plan: {"summary":"keep","edits":[]} trailing {"summary":"lost')).toEqual({ summary: "keep", edits: [] });
  });

  it("returns undefined for a lone truncated object (balance never closes)", () => {
    expect(extractProposalJson('{"summary":"x","edits":[{"action":"crea')).toBeUndefined();
  });

  it("returns undefined for non-JSON garbage", () => {
    expect(extractProposalJson("no object here at all")).toBeUndefined();
    expect(extractProposalJson("")).toBeUndefined();
  });

  it("ignores braces inside strings (the scan is string/escape-aware)", () => {
    expect(extractProposalJson('note {"summary":"uses {braces} inside","edits":[]} end')).toEqual({ summary: "uses {braces} inside", edits: [] });
  });
});

// ---------------------------------------------------------------------------
// validateProposal — whole-case rejection, never silent edit drops
// ---------------------------------------------------------------------------

describe("validateProposal — 整案校验", () => {
  const base = { summary: "s", rationale: "r", expectedOutcome: "o" };

  it("rejects fact kind (facts belong to the review fork)", () => {
    const r = validateProposal({ ...base, edits: [{ action: "create", kind: "fact", content: "x" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("fact");
  });

  it(`rejects more than ${REFINE_MAX_EDITS} edits (one refine must not rewrite the personality)`, () => {
    const edits = Array.from({ length: REFINE_MAX_EDITS + 1 }, () => ({ action: "create", kind: "harness", content: "note" }));
    expect(validateProposal({ ...base, edits }).ok).toBe(false);
  });

  it("rejects update/delete without an id", () => {
    expect(validateProposal({ ...base, edits: [{ action: "update", kind: "harness", content: "x" }] }).ok).toBe(false);
    expect(validateProposal({ ...base, edits: [{ action: "delete" }] }).ok).toBe(false);
  });

  it("rejects illegal actions and non-object shapes", () => {
    expect(validateProposal({ ...base, edits: [{ action: "upsert", kind: "harness", content: "x" }] }).ok).toBe(false);
    expect(validateProposal("nope").ok).toBe(false);
    expect(validateProposal({ summary: "s" }).ok).toBe(false);
    expect(validateProposal({ ...base, edits: "nope" }).ok).toBe(false);
  });

  it("rejects create/update content over 500 chars (the review-fork bound)", () => {
    expect(validateProposal({ ...base, edits: [{ action: "create", kind: "harness", content: "x".repeat(501) }] }).ok).toBe(false);
  });

  it("accepts a legal 5-edit case and round-trips the fields", () => {
    const edits = [
      { action: "create", kind: "harness", content: "a", tags: ["t"], evidence: "e" },
      { action: "create", kind: "preference", content: "b" },
      { action: "create", kind: "skill_note", content: "c" },
      { action: "update", id: "m-1", kind: "harness", content: "d" },
      { action: "delete", id: "m-2" },
    ];
    const r = validateProposal({ ...base, edits });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.proposal.edits).toHaveLength(5);
      expect(r.proposal.summary).toBe("s");
      expect(r.proposal.edits[0]?.tags).toEqual(["t"]);
      expect(r.proposal.edits[3]?.id).toBe("m-1");
    }
  });
});

// ---------------------------------------------------------------------------
// planRefinement — one model call, bounded prompt
// ---------------------------------------------------------------------------

describe("planRefinement — 一次 model 调用出提案", () => {
  it("parses a canned proposal from exactly one generate call", async () => {
    const canned = JSON.stringify({
      summary: "add a plan-gate note",
      rationale: "r",
      expectedOutcome: "o",
      edits: [{ action: "create", kind: "harness", content: "gate plan mode on an explicit ask", evidence: "user asked twice" }],
    });
    const { model, inputs } = fakeModel(canned);
    const store = await openMemoryStore(dir);
    const plan = await planRefinement(model, [{ role: "user", content: "fix the login bug" }], store);
    expect(plan.summary).toBe("add a plan-gate note");
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0]?.kind).toBe("harness");
    expect(inputs).toHaveLength(1); // ONE call — no fork, no replay concerns
    expect(inputs[0]?.systemPrompt).toBe(REFINE_SYSTEM_PROMPT);
    expect(inputs[0]?.tools).toEqual([]);
    expect(inputs[0]?.messages[0]?.content).toContain("fix the login bug");
  });

  it("returns an empty rejected-shape proposal on model garbage — never throws", async () => {
    const { model } = fakeModel("I cannot answer in JSON, sorry!");
    const store = await openMemoryStore(dir);
    const plan = await planRefinement(model, [], store);
    expect(plan.edits).toEqual([]);
  });

  it(`bounds the trajectory tail at REFINE_TRAJECTORY_CHARS (${REFINE_TRAJECTORY_CHARS})`, async () => {
    const { model, inputs } = fakeModel('{"summary":"no changes needed","edits":[]}');
    const store = await openMemoryStore(dir);
    const big: AgentMessage[] = [{ role: "user", content: "x".repeat(200_000) }];
    await planRefinement(model, big, store, "focus on tool lessons");
    const sent = inputs[0]?.messages[0]?.content ?? "";
    // 概览（空 store，很小）+ 80k 轨迹尾 + 头部/说明的小常数。
    expect(sent.length).toBeLessThanOrEqual(REFINE_TRAJECTORY_CHARS + 4_000);
    expect(sent).toContain("focus on tool lessons");
    expect(sent).toContain("x"); // the trajectory body itself made it in
  });
});

// ---------------------------------------------------------------------------
// applyRefinement — pending discipline + audit snapshots + rollback
// ---------------------------------------------------------------------------

describe("applyRefinement — 三条纪律 + 审计 + 回滚（tmpdir 真store）", () => {
  it("creates land pending, updates version-chain to pending, deletes are only suggested; rollback restores", async () => {
    const store = await openMemoryStore(dir);
    const seeded = await store.write({ kind: "skill_note", content: "run the focused vitest file after each edit", tags: ["testing"] });
    const victim = await store.write({ kind: "preference", content: "prefer terse receipts" });
    expect(seeded.entry.status).toBe("active");
    const proposal: RefineProposal = {
      summary: "tighten testing + receipt notes",
      rationale: "trajectory shows repeated full-suite runs",
      expectedOutcome: "fewer wasted runs",
      edits: [
        { action: "create", kind: "harness", content: "never run the full suite during the day", tags: ["testing"], evidence: "user gated full runs to night" },
        { action: "update", id: seeded.entry.id, kind: "skill_note", content: "run the focused vitest file after each edit (full suite is user-gated)", evidence: "night-only rule" },
        { action: "delete", id: victim.entry.id, kind: "preference", evidence: "contradicted later in the session" },
      ],
    };
    const { refineId, receipt } = await applyRefinement(dir, store, proposal);
    expect(refineId).toMatch(/^rf-[0-9a-f]{8}$/);

    // 纪律 1: create 必 pending（forcePending —— LLM 策展不过人审不落 active）。
    const all = await store.load();
    const created = all.find((e) => e.kind === "harness");
    expect(created?.status).toBe("pending");

    // 纪律 2: update 必转 pending，同 id 版本 +1。
    const updated = all.find((e) => e.id === seeded.entry.id);
    expect(updated?.version).toBe(2);
    expect(updated?.status).toBe("pending");
    expect(updated?.content).toContain("user-gated");

    // 纪律 3: delete 只建议不执行 —— 条目仍在，receipt 点名让用户自己删。
    expect(all.find((e) => e.id === victim.entry.id)).toBeDefined();
    expect(receipt).toContain(victim.entry.id);
    expect(receipt).toContain("/memory del");
    expect(receipt).toContain("/memory ok");
    expect(receipt).toContain(refineId);

    // 审计行：before/after 快照从 store 返回值取。
    const audit = await readRefinementAudit(dir);
    const line = audit.find((l) => l.refineId === refineId);
    expect(line?.outcome).toBe("applied");
    expect(line?.edits[0]?.action).toBe("create");
    expect(line?.edits[0]?.after?.content).toBe("never run the full suite during the day");
    expect(line?.edits[1]?.before).toEqual({ content: seeded.entry.content, version: 1, status: "active" });
    expect(line?.edits[1]?.after).toEqual({ content: updated?.content, version: 2, status: "pending" });
    expect(line?.edits[2]?.action).toBe("delete");
    expect(line?.edits[2]?.before?.content).toBe("prefer terse receipts");

    // 回滚：update 回 before（version 再 +1、status 恢复），create 逆推为 remove，
    // delete 建议无操作（条目本来就没动）。
    expect(await store.rollback(refineId)).toBe(true);
    const rolled = await store.load();
    expect(rolled.find((e) => e.id === created?.id)).toBeUndefined();
    const restored = rolled.find((e) => e.id === seeded.entry.id);
    expect(restored?.content).toBe(seeded.entry.content);
    expect(restored?.version).toBe(3);
    expect(restored?.status).toBe("active");
    expect(rolled.find((e) => e.id === victim.entry.id)).toBeDefined();
    expect(await store.rollback("rf-nope")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runRefineCommand — the /refine face
// ---------------------------------------------------------------------------

describe("runRefineCommand — /refine 命令面", () => {
  it("answers with usage when no model context is threaded (dream-verb precedent)", async () => {
    const out = await runRefineCommand(dir, "");
    expect(out).toContain("用法："); // ω99-166d-i: 泛 usage 钉演进（#17）
  });

  it("rollback of an unknown refineId fails with a clear line", async () => {
    const out = await runRefineCommand(dir, "rollback bogus");
    expect(out).toContain("bogus");
  });

  it("plans + applies end-to-end with a threaded model (receipt + pending entry)", async () => {
    const canned = JSON.stringify({
      summary: "one safety note",
      rationale: "r",
      expectedOutcome: "o",
      edits: [{ action: "create", kind: "harness", content: "ask before deleting anything", evidence: "near-miss" }],
    });
    const { model } = fakeModel(canned);
    const out = await runRefineCommand(dir, "focus on safety", { model, messages: [{ role: "user", content: "we almost deleted a file" }] });
    expect(out).toContain("🧠 refine");
    expect(out).toContain("pending");
    const store = await openMemoryStore(dir);
    const h = (await store.load()).find((e) => e.kind === "harness");
    expect(h?.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// Wiring — the slash entry + the REPL parse
// ---------------------------------------------------------------------------

describe("/refine wiring", () => {
  it("listSlashCommands carries the refine builtin (sensitive args, like /memory)", () => {
    const refine = listSlashCommands({}).find((c) => c.name === "refine");
    expect(refine).toBeDefined();
    expect(refine?.isSensitive).toBe(true);
    expect(refine?.args).toContain("rollback");
  });

  it("parseReplCommand routes /refine (bare, with instructions, and prefix-neighbors stay prompts)", () => {
    expect(parseReplCommand("/refine")).toEqual({ kind: "refine", args: "" });
    expect(parseReplCommand("/refine focus on tools")).toEqual({ kind: "refine", args: "focus on tools" });
    expect(parseReplCommand("/refinex everything")).toEqual({ kind: "prompt", text: "/refinex everything" });
  });
});
