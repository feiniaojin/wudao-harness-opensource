// ω-4f (design 84) — Dream memory consolidation: stage 2 of the two-stage
// composition (review fork = transcript→ledger, shipped M49; Dream =
// ledger→curated ledger, this batch). T1-T12 per design §4: seq mechanics,
// cursor IO + corruption, prompt construction, completion gating, the
// restricted write registry, diff-grounded audit, crash replay dedup, kill
// switches, due-gates, parent isolation, the manual verb, rollback.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient, ModelInput, AssistantMessage } from "@wudao-org/core";
import { toModelToolDefinition } from "@wudao-org/core";
import { createSessionRegistry } from "../src/agents/index.js";
import { openMemoryStore } from "../src/memory/index.js";
import type { MemoryEntry } from "../src/memory/store.js";
import {
  DREAM_BATCH_MAX_ENTRIES,
  DREAM_EMBED_MAX_CHARS,
  DREAM_PROMPT,
  DREAM_SYSTEM_PROMPT,
  buildDreamPrompt,
  dreamCursorPath,
  dreamDue,
  dreamUnprocessedCount,
  dreamEnabled,
  readDreamAudit,
  readDreamCursor,
  renderDreamLedgerEmbed,
  runDreamVerb,
  spawnDreamRun,
  writeDreamCursor,
} from "../src/memory/dream.js";
import { createMemoryWriteTool, createMemorySearchTool } from "../src/memory/tools.js";
import { runMemoryCommand, type MemoryDreamContext } from "../src/memory/commands.js";
import { setSessionMemorySettings } from "../src/memory/store.js";
import { runAgentLoop, type AgentState } from "@wudao-org/core";
import type { Tool } from "@wudao-org/core";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wudao-dream-"));
  // 记忆两库收敛：dream 自动调度默认停用（migrate.ts 的门）——本文件钉的是
  // 旧机制本体（冻结回滚线），经 WUDAO_M49_LEGACY=1 原样可跑。
  process.env.WUDAO_M49_LEGACY = "1";
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  delete process.env.WUDAO_DREAM;
  delete process.env.WUDAO_NO_DREAM_FORK;
  delete process.env.WUDAO_M49_LEGACY;
});

// ---------------------------------------------------------------------------
// Shared scripted-model helpers (memory-review.test.ts style).
// ---------------------------------------------------------------------------

/** A scripted model that also records every ModelInput it receives. The
 *  input is SNAPSHOTTED per call (the loop hands `state.messages` by
 *  reference, so a live capture would alias the growing conversation). */
function recordingModel(respond: (input: ModelInput, call: number) => AssistantMessage): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let call = 0;
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push({
        ...input,
        messages: input.messages.map((m) => ({ ...m })),
        tools: input.tools.map((t) => ({ ...t })),
      });
      call += 1;
      return respond(input, call);
    },
  };
}

function call(id: string, name: string, args: Record<string, unknown>): AssistantMessage {
  return { role: "assistant", content: "", toolCalls: [{ id, name, arguments: args }] };
}

/** One raw store line (legacy = no seq field), in file order. */
function legacyLine(i: number, content: string, status: "active" | "pending" = "active"): string {
  return JSON.stringify({
    id: `m-legacy${i}`,
    kind: "fact",
    content,
    scope: "project",
    tags: [],
    created: `2026-01-0${i}T00:00:00.000Z`,
    hits: 0,
    status,
  });
}

/** An in-memory entry with an explicit seq (buildDreamPrompt is pure). */
function seqEntry(i: number, content: string, status: "active" | "pending" = "active"): MemoryEntry {
  return {
    id: `m-e${i}`,
    kind: "fact",
    content,
    scope: "project",
    tags: [],
    created: "2026-02-01T00:00:00.000Z",
    hits: 0,
    status,
    seq: i,
  };
}

/** Distinct low-overlap filler notes (pairwise Jaccard well under 0.7). */
const FILLER = [
  "the pnpm filter name for the cli package is wudao-harness",
  "vitest isolates every test file in its own worker",
  "the memory ledger lives beside the sessions directory",
  "every milestone ships deterministic acceptance tests",
  "the registry clamps maxConcurrent into its ceiling",
  "prefix cache stability requires append-only history",
  "compaction runs cheapest-first through the pipeline",
  "hooks intercept while event listeners only observe",
  "the write-scope guard is enforced at construction",
  "steering queues land at the next turn boundary",
];

/** Seed `n` assessed entries (seq 1..n) through one store handle. */
async function seedDue(n: number, root = dir): Promise<void> {
  const store = openMemoryStore(root);
  for (let i = 0; i < n; i += 1) {
    await store.write({ kind: "fact", content: FILLER[i % FILLER.length]! + (i >= FILLER.length ? ` (part ${i})` : "") });
  }
}

async function drainLoop(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ev of gen) {
    void _ev;
  }
}

async function seedLegacy(count: number, root = dir): Promise<string[]> {
  const lines: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    lines.push(legacyLine(i, `legacy note number ${i} about topic-${i} builds and tests`));
  }
  await mkdir(join(root, ".wudao"), { recursive: true });
  await writeFile(join(root, ".wudao", "memory.jsonl"), `${lines.join("\n")}\n`, "utf8");
  return lines.map((_, i) => `m-legacy${i + 1}`);
}

// ---------------------------------------------------------------------------
// T1 — seq mechanics (design §3(b)).
// ---------------------------------------------------------------------------

describe("T1 — seq mechanics", () => {
  it("legacy lines derive seq by file order; writes append; rewriteAll round-trips", async () => {
    // 4 active legacy lines + 1 pending (so confirm has a target later).
    await mkdir(join(dir, ".wudao"), { recursive: true });
    const lines = [1, 2, 3, 4].map((i) => legacyLine(i, `legacy note number ${i} about topic-${i} builds and tests`));
    lines.push(legacyLine(5, "legacy pending note number five", "pending"));
    await writeFile(join(dir, ".wudao", "memory.jsonl"), `${lines.join("\n")}\n`, "utf8");

    const store = openMemoryStore(dir);
    expect((await store.load()).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);

    const w6 = await store.write({ kind: "fact", content: "a sixth note about the eval suite order" });
    const w7 = await store.write({ kind: "fact", content: "a seventh note about deploy checklists" });
    expect(w6.entry.seq).toBe(6);
    expect(w7.entry.seq).toBe(7);

    // rewriteAll bookkeeping flips (confirm + bumpHits) never shift seqs —
    // and persist the derived legacy seqs into the file.
    await store.confirm("m-legacy5");
    await store.bumpHits(["m-legacy2"]);
    const after = await store.load();
    expect(after.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(after.find((e) => e.id === "m-legacy5")?.status).toBe("active");
    expect(after.find((e) => e.id === "m-legacy2")?.hits).toBe(1);
    const w8 = await store.write({ kind: "fact", content: "an eighth note about workspace hygiene" });
    expect(w8.entry.seq).toBe(8);

    // A FRESH handle reads the same seqs and continues the counter.
    const store3 = openMemoryStore(dir);
    expect((await store3.load()).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const w9 = await store3.write({ kind: "fact", content: "a ninth note about cache prefixes" });
    expect(w9.entry.seq).toBe(9);

    // Interleaved write starts still get distinct seqs (assigned synchronously
    // between the readAll await and the append await — no interleaving gap).
    const [a, b] = await Promise.all([
      store3.write({ kind: "fact", content: "an interleaved note about parallel writes one" }),
      store3.write({ kind: "fact", content: "an interleaved note about parallel writes two" }),
    ]);
    expect(new Set([a.entry.seq, b.entry.seq])).toEqual(new Set([10, 11]));
  });

  it("removal never renumbers survivors and never reuses a seq", async () => {
    await seedLegacy(4);
    const store = openMemoryStore(dir);
    const late = await store.write({ kind: "fact", content: "a late note about grep flags" }); // seq 5
    expect(await store.remove("m-legacy2")).toBe(true);
    const rest = await store.load();
    expect(rest.map((e) => e.id)).toEqual(["m-legacy1", "m-legacy3", "m-legacy4", late.entry.id]);
    expect(rest.map((e) => e.seq)).toEqual([1, 3, 4, 5]);
    const next = await store.write({ kind: "fact", content: "a post-delete note about globs" });
    expect(next.entry.seq).toBe(6);
  });

  // Report-85 review M2 (report 89 item 4): the DUAL-handle collision, now
  // pinned. The seq counter is per-handle by design (store.ts: the driver
  // opens one store; design 84 §6 risk 2 names two live handles as the known
  // residual risk) — and the dream spawn IS a second live handle
  // (startDream's openSessionMemoryStore) on the same memory.jsonl the
  // parent's memory tools hold. When ONE parent write lands between the
  // dream handle's lazy init and its append, both handles assign the same
  // max-derived value: EQUAL seqs, never out-of-order for this single
  // interleave (each counter is monotonic in itself and both derive from the
  // same file max at init). The claim was analytically benign — this pins
  // both halves of that: the collision shape, and that the cursor's
  // VALUE-based batch advance consumes BOTH equal-seq entries together
  // (neither is stranded for reprocessing, neither is skipped).
  it("two live handles + one interleaved write → EQUAL seqs; the dream batch advances both together", async () => {
    const parent = openMemoryStore(dir); // the parent tools' handle
    const dream = openMemoryStore(dir); // the dream spawn's handle (same file)
    await dream.load(); // the dream handle's lazy init: nextSeq 1 on the empty file
    const p1 = await parent.write({ kind: "fact", content: "parent note about build flags lands first" });
    const d1 = await dream.write({ kind: "fact", content: "dream note about merged paraphrases lands second" });
    // The pinned collision: the dream handle's stale counter re-assigns seq 1.
    expect(p1.entry.seq).toBe(1);
    expect(d1.entry.seq).toBe(1);
    expect(p1.entry.id).not.toBe(d1.entry.id); // two DISTINCT entries share it
    // File-order seqs stay monotonic-or-equal (a fresh third handle reads
    // ground truth — parse order is append order).
    const file = await openMemoryStore(dir).load();
    const seqs = file.map((e) => e.seq);
    expect(seqs).toEqual([1, 1]);
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]!).toBeGreaterThanOrEqual(seqs[i - 1]!);
    // The dream batch at cursor 0 captures BOTH entries; advancing to the
    // batch's last seq consumes them TOGETHER — the value-based advance
    // (buildDreamPrompt.lastSeq → cursor) crosses equal seqs in one step, so
    // the duplicate seq costs one extra consolidated entry, never a loop or
    // a skip.
    const cursor = { lastSeq: 0 };
    const built = buildDreamPrompt({ entries: file, cursor });
    expect(built).toBeDefined();
    expect(built!.lastSeq).toBe(1);
    expect(dreamUnprocessedCount(file, cursor)).toBe(2);
    expect(dreamUnprocessedCount(file, { lastSeq: built!.lastSeq })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T2 — cursor roundtrip + corruption (design §3(a), D9).
// ---------------------------------------------------------------------------

describe("T2 — cursor roundtrip + corruption", () => {
  it("write→read identity", async () => {
    await mkdir(join(dir, ".wudao"), { recursive: true });
    const c = { lastSeq: 7, lastRunAt: "2026-08-22T00:00:00.000Z", lastRunOk: true };
    await writeDreamCursor(dir, c);
    expect(await readDreamCursor(dir)).toEqual(c);
    // Minimal cursor round-trips too.
    await writeDreamCursor(dir, { lastSeq: 3 });
    expect(await readDreamCursor(dir)).toEqual({ lastSeq: 3 });
  });

  it("absent / corrupt / unreadable / wrong-shape cursor → {lastSeq:0} (fail toward reprocess)", async () => {
    // absent
    expect(await readDreamCursor(dir)).toEqual({ lastSeq: 0 });
    // corrupt JSON
    await mkdir(join(dir, ".wudao"), { recursive: true });
    await writeFile(dreamCursorPath(dir), "{not json at all", "utf8");
    expect(await readDreamCursor(dir)).toEqual({ lastSeq: 0 });
    // well-formed JSON, wrong shape
    await writeFile(dreamCursorPath(dir), JSON.stringify({ lastSeq: "seven", lastRunAt: 42 }), "utf8");
    expect(await readDreamCursor(dir)).toEqual({ lastSeq: 0 });
    // unreadable (a directory sits at the path)
    await rm(dreamCursorPath(dir));
    await mkdir(dreamCursorPath(dir));
    expect(await readDreamCursor(dir)).toEqual({ lastSeq: 0 });
  });

  it("dreamCursorPath lives in the memory directory", () => {
    expect(dreamCursorPath(dir)).toBe(join(dir, ".wudao", "dream-cursor.json"));
  });
});

// ---------------------------------------------------------------------------
// T3 — prompt construction (design §3(c), D4, D10).
// ---------------------------------------------------------------------------

describe("T3 — prompt construction", () => {
  it("nothing unprocessed → undefined", () => {
    expect(buildDreamPrompt({ entries: [seqEntry(1, "a"), seqEntry(2, "b")], cursor: { lastSeq: 2 } })).toBeUndefined();
    expect(buildDreamPrompt({ entries: [], cursor: { lastSeq: 0 } })).toBeUndefined();
    // Entries without a seq never count as unprocessed past a 0 cursor.
    expect(buildDreamPrompt({ entries: [{ ...seqEntry(1, "a"), seq: undefined }], cursor: { lastSeq: 0 } })).toBeUndefined();
  });

  it("30 unprocessed → batch = first 20 in file order; lastSeq = the 20th's seq", () => {
    const entries = Array.from({ length: 30 }, (_, i) => seqEntry(i + 1, `note ${i + 1} about topic-${(i % 5) + 1}`));
    const built = buildDreamPrompt({ entries, cursor: { lastSeq: 0 } });
    expect(built).toBeDefined();
    expect(built!.lastSeq).toBe(20);
    expect(DREAM_BATCH_MAX_ENTRIES).toBe(20);
    const batch = built!.prompt.split("## Unprocessed batch")[1]!.split("## Current ledger")[0]!;
    expect(batch).toContain("m-e1 ");
    expect(batch).toContain("m-e20 ");
    expect(batch).not.toContain("m-e21");
    // The embed still carries the FULL ledger (all 30, ground truth).
    const embed = built!.prompt.split("## Current ledger")[1]!;
    expect(embed).toContain("m-e30 ");
    // The cursor partitions: entries ≤ lastSeq never enter the batch.
    const next = buildDreamPrompt({ entries, cursor: { lastSeq: 20 } });
    expect(next!.lastSeq).toBe(30);
  });

  it("embed: 40 entries × 490 chars → section ≤ 8000 with the truncation footer", () => {
    const entries = Array.from({ length: 40 }, (_, i) => seqEntry(i + 1, `${String(i + 1).padStart(3, "0")} ${"x".repeat(486)}`));
    const embed = renderDreamLedgerEmbed(entries);
    expect(embed.length).toBeLessThanOrEqual(DREAM_EMBED_MAX_CHARS);
    expect(DREAM_EMBED_MAX_CHARS).toBe(8000);
    expect(embed.endsWith("...[truncated]")).toBe(true);
    // Early entries survive whole; the tail dropped.
    expect(embed).toContain("m-e1 ");
    expect(embed).not.toContain("m-e40 ");
    // The whole-ledger guarantee (D4): with 8000 fresh chars the ground
    // truth carries 17 of these (400-truncated) ~444-char lines — far past
    // what reusing a RECALL-style 2400 cap would admit (5). A double-capped
    // embed loses the ledger's tail exactly when consolidation needs it most.
    expect(embed).toContain("m-e10 ");
    expect(embed).toContain("m-e17 ");
    expect(embed).not.toContain("m-e18 ");
    // Via the prompt the embed stays capped too.
    const built = buildDreamPrompt({ entries: entries.slice(0, 8), cursor: { lastSeq: 0 } });
    // 永续 v6 弧 A（reef C3）钉随迁：embed 进 prompt 时套 nonce 围栏（+~60
    // 字符定界标记）——帽随围栏放宽（内容本体仍受 DREAM_EMBED_MAX_CHARS 约
    // 束，围栏是定界开销不是内容）。
    expect(built!.prompt.split("## Current ledger")[1]!.length).toBeLessThanOrEqual(DREAM_EMBED_MAX_CHARS + 120);
  });

  it("a 600-char pending entry truncates at 400 per entry; status renders", () => {
    const long = seqEntry(1, `${"y".repeat(600)}`, "pending");
    const embed = renderDreamLedgerEmbed([long]);
    expect(embed).toContain("y".repeat(400));
    expect(embed).not.toContain("y".repeat(401));
    expect(embed).toContain("...[truncated]");
    expect(embed).toContain("m-e1 fact/project pending");
    // An empty ledger renders the explicit empty marker.
    expect(renderDreamLedgerEmbed([])).toBe("(empty)");
  });

  it("no parent transcript and no workspace path leak into the prompt", () => {
    const entries = Array.from({ length: 10 }, (_, i) => seqEntry(i + 1, `note ${i + 1} about the build pipeline stages`));
    const built = buildDreamPrompt({ entries, cursor: { lastSeq: 0 } })!;
    expect(built.prompt.includes(dir)).toBe(false);
    expect(built.prompt.includes(tmpdir())).toBe(false);
    expect(built.prompt).not.toMatch(/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\//);
    // The instruction core is present verbatim.
    expect(built.prompt).toContain("Consolidate the workspace memory ledger");
  });
});

// ---------------------------------------------------------------------------
// T9 — due-gates, the pure part (design §3(f)).
// ---------------------------------------------------------------------------

describe("T9 — due-gates (dreamDue/dreamEnabled, pure)", () => {
  const NOW = Date.parse("2026-08-22T12:00:00.000Z");
  const ago = (ms: number): string => new Date(NOW - ms).toISOString();

  it("enabled defaults on; both kill-switch spellings disable", () => {
    expect(dreamEnabled({})).toBe(true);
    expect(dreamEnabled({ WUDAO_DREAM: "1" })).toBe(true);
    expect(dreamEnabled({ WUDAO_DREAM: "off" })).toBe(false);
    expect(dreamEnabled({ WUDAO_DREAM: " OFF " })).toBe(false);
    expect(dreamEnabled({ WUDAO_NO_DREAM_FORK: "1" })).toBe(false);
  });

  it("backlog gate: 7 unprocessed → not due; 8+ → due", () => {
    expect(dreamDue({ lastSeq: 0 }, 7, NOW, {})).toBe(false);
    expect(dreamDue({ lastSeq: 0 }, 8, NOW, {})).toBe(true);
  });

  it("interval gate: a run 5 min ago blocks; 30+ min ago or absent allows", () => {
    expect(dreamDue({ lastSeq: 5, lastRunAt: ago(5 * 60_000), lastRunOk: true }, 20, NOW, {})).toBe(false);
    expect(dreamDue({ lastSeq: 5, lastRunAt: ago(31 * 60_000), lastRunOk: true }, 20, NOW, {})).toBe(true);
    expect(dreamDue({ lastSeq: 5, lastRunAt: ago(31 * 60_000), lastRunOk: false }, 20, NOW, {})).toBe(true);
    expect(dreamDue({ lastSeq: 0 }, 20, NOW, {})).toBe(true);
  });

  it("kill switches override everything", () => {
    expect(dreamDue({ lastSeq: 0 }, 20, NOW, { WUDAO_DREAM: "off" })).toBe(false);
    expect(dreamDue({ lastSeq: 0 }, 20, NOW, { WUDAO_NO_DREAM_FORK: "1" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T4 — completion gating (scripted fork, design §3(e)/D5).
// ---------------------------------------------------------------------------

describe("T4 — completion gating (scripted fork)", () => {
  it("ok run: cursor advances to the batch's lastSeq; audit ok/toSeq; mid-run writes stay past the cursor", async () => {
    await seedDue(8);
    const model = recordingModel((_i, c) =>
      c === 1
        ? call("w1", "memory_write", { kind: "preference", content: "prefer small commits over large batches when landing milestones", tags: ["process"] })
        : { role: "assistant", content: "consolidated: merged the process notes" });
    const spawn = await spawnDreamRun({ workspaceRoot: dir, model, registry: createSessionRegistry() });
    expect(spawn).toBeDefined();
    const line = await spawn!.done;
    expect(line).toBe("🧠 dream: consolidated 1 entry (added 1, 0 pending)");

    const cursor = await readDreamCursor(dir);
    expect(cursor.lastSeq).toBe(8);
    expect(cursor.lastRunOk).toBe(true);
    expect(typeof cursor.lastRunAt).toBe("string");

    const audit = await readDreamAudit(dir);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.type).toBe("dream_run");
    expect(audit[0]!.ok).toBe(true);
    expect(audit[0]!.fromSeq).toBe(0);
    expect(audit[0]!.toSeq).toBe(8);
    expect(audit[0]!.addedIds).toHaveLength(1);
    expect(audit[0]!.auto).toBe(1);
    expect(audit[0]!.pending).toBe(0);

    // Entries written DURING the run keep seq > cursor (re-eligible next run).
    const entries = await openMemoryStore(dir).load();
    const added = entries.find((e) => e.id === audit[0]!.addedIds[0]);
    expect(added).toBeDefined();
    expect((added!.seq ?? 0)).toBeGreaterThan(cursor.lastSeq);
  });

  it("abort: cursor lastSeq unchanged + lastRunOk:false; audit toSeq===fromSeq; receipt names the abort", async () => {
    await seedDue(8);
    let release: (m: AssistantMessage) => void = () => {};
    const gate = new Promise<AssistantMessage>((r) => { release = r; });
    const model = recordingModel((_i, c) => (c === 1
      ? call("w1", "memory_write", { kind: "fact", content: "a gated write about flaky watchers" })
      : gate));
    const registry = createSessionRegistry();
    const spawn = await spawnDreamRun({ workspaceRoot: dir, model, registry });
    expect(spawn).toBeDefined();
    expect(registry.cancel(spawn!.id)).toBe(true);
    release({ role: "assistant", content: "(late answer)" });
    const line = await spawn!.done;
    expect(line).toContain("aborted");

    const cursor = await readDreamCursor(dir);
    expect(cursor.lastSeq).toBe(0);
    expect(cursor.lastRunOk).toBe(false);
    const audit = await readDreamAudit(dir);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.ok).toBe(false);
    expect(audit[0]!.toSeq).toBe(audit[0]!.fromSeq);
    expect(audit[0]!.reason).toContain("aborted");
  });
});

// ---------------------------------------------------------------------------
// T5 — the restricted write registry (design §3(d), construction-enforced).
// ---------------------------------------------------------------------------

describe("T5 — the restricted write registry", () => {
  it("child tools are EXACTLY {memory_write, memory_search}; read_file → unknown-tool path; not-ok; cursor unchanged", async () => {
    await seedDue(8);
    const model = recordingModel((_i, c) => {
      if (c === 1) return call("r1", "read_file", { path: "package.json" });
      throw new Error("child exploded after the unknown tool");
    });
    const spawn = await spawnDreamRun({ workspaceRoot: dir, model, registry: createSessionRegistry() });
    expect(spawn).toBeDefined();
    const line = await spawn!.done;
    expect(line).toContain("skipped");

    // Set equality on the wire definitions — exactly the pair, byte-identical
    // to the production memory tools.
    const store = openMemoryStore(dir);
    const expected = [createMemoryWriteTool(store), createMemorySearchTool(store)]
      .map((t) => JSON.stringify(toModelToolDefinition(t))).sort();
    const got = (model.inputs[0]!.tools ?? []).map((t) => JSON.stringify(t)).sort();
    expect(got).toEqual(expected);
    expect((model.inputs[0]!.tools ?? []).map((t) => t.name).sort()).toEqual(["memory_search", "memory_write"]);

    // Fresh child: exactly ONE message — the dream brief itself (a fresh
    // child gets the raw prompt; the "[subagent task]" wrapper is fork-only,
    // and a fork is exactly what Dream must not be) — plus no parent
    // transcript; the scripted read_file drew the unknown-tool error.
    expect(model.inputs[0]!.messages).toHaveLength(1);
    expect(model.inputs[0]!.messages[0]!.content.startsWith(DREAM_PROMPT.slice(0, 24))).toBe(true);
    expect(model.inputs[0]!.messages[0]!.content).not.toContain("how do the builds gate merges?");
    expect(model.inputs[0]!.systemPrompt).toBe(DREAM_SYSTEM_PROMPT);
    const second = model.inputs[1]!;
    expect(second.messages.some((m) => m.role === "tool" && m.content.includes("unknown tool: read_file"))).toBe(true);

    const cursor = await readDreamCursor(dir);
    expect(cursor.lastSeq).toBe(0);
    expect(cursor.lastRunOk).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T6 — diff-grounded audit (design §3(e) step 1, D6).
// ---------------------------------------------------------------------------

describe("T6 — diff-grounded audit", () => {
  it("the receipt/audit count the store diff, never the model's self-report", async () => {
    await seedDue(8);
    const model = recordingModel((_i, c) =>
      c === 1
        ? call("w1", "memory_write", { kind: "skill_note", content: "merge duplicate notes into one durable entry during dream passes", tags: ["memory"] })
        : { role: "assistant", content: "saved 3 consolidated entries and merged 5 more" });
    const spawn = await spawnDreamRun({ workspaceRoot: dir, model, registry: createSessionRegistry() });
    const line = await spawn!.done;
    expect(line).toBe("🧠 dream: consolidated 1 entry (added 1, 0 pending)");
    expect(line.includes("3")).toBe(false);
    const audit = await readDreamAudit(dir);
    expect(audit[0]!.addedIds).toHaveLength(1);
    const raw = await readFile(join(dir, ".wudao", "dream.jsonl"), "utf8");
    expect(raw).not.toContain("saved 3");
    expect(raw).toContain(audit[0]!.addedIds[0]!);
  });

  it("empty diff + ok → 0-entry receipt and the cursor still advances", async () => {
    await seedDue(9);
    const model = recordingModel(() => ({ role: "assistant", content: "nothing to consolidate" }));
    const spawn = await spawnDreamRun({ workspaceRoot: dir, model, registry: createSessionRegistry() });
    const line = await spawn!.done;
    expect(line).toBe("🧠 dream: consolidated 0 entries (added 0, 0 pending)");
    expect((await readDreamCursor(dir)).lastSeq).toBe(9);
    const audit = await readDreamAudit(dir);
    expect(audit[0]!.ok).toBe(true);
    expect(audit[0]!.toSeq).toBe(9);
    expect(audit[0]!.addedIds).toEqual([]);
    expect(audit[0]!.auto).toBe(0);
    expect(audit[0]!.pending).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T7 — crash replay dedup (design §3(g)).
// ---------------------------------------------------------------------------

describe("T7 — crash replay dedup", () => {
  it("an aborted run leaves the cursor; replayed near-duplicates land pending, never active", async () => {
    const store = openMemoryStore(dir);
    await store.write({ kind: "fact", content: "always run the full eval suite before merging a milestone", tags: ["build"] });
    for (let i = 0; i < 7; i += 1) {
      await store.write({ kind: "fact", content: FILLER[i % FILLER.length]! });
    }

    // Run 1: writes near-verbatim A′, then the child "crashes" → ok:false.
    const crash = recordingModel((_i, c) => {
      if (c === 1) return call("w1", "memory_write", { kind: "fact", content: "always run the full eval suite before merging a milestone change" });
      throw new Error("dream child crashed");
    });
    const s1 = await spawnDreamRun({ workspaceRoot: dir, model: crash, registry: createSessionRegistry() });
    expect(s1).toBeDefined();
    await s1!.done;
    const afterCrashCursor = await readDreamCursor(dir);
    expect(afterCrashCursor.lastSeq).toBe(0); // the replay precondition
    expect(afterCrashCursor.lastRunOk).toBe(false);
    expect((await store.load())).toHaveLength(9); // A + 7 fillers + A′

    // Run 2 (manual verb — the interval gate would block an auto retry): the
    // batch includes A′; another near-verbatim proposal → pending, never active.
    const retry = recordingModel((_i, c) => {
      if (c === 1) return call("w2", "memory_write", { kind: "fact", content: "always run the full eval suite before merging a milestone release" });
      return { role: "assistant", content: "merged the build notes" };
    });
    const line = await runDreamVerb({ workspaceRoot: dir, model: retry, registry: createSessionRegistry() });
    expect(line).toBe("🧠 dream: consolidated 1 entry (added 0, 1 pending)");
    const cursor = await readDreamCursor(dir);
    expect(cursor.lastSeq).toBe(9); // the batch = 8 seeded + A′
    expect(cursor.lastRunOk).toBe(true);

    const final = await store.load();
    const dupes = final.filter((e) => /always run the full eval suite before merging a milestone (change|release)/.test(e.content));
    expect(dupes).toHaveLength(2);
    expect(dupes.every((e) => e.status === "pending")).toBe(true);
    // The original A is still the only active copy.
    const activeCopy = final.filter((e) => e.content === "always run the full eval suite before merging a milestone");
    expect(activeCopy).toHaveLength(1);
    expect(activeCopy[0]!.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// T8 — kill switches + gating-offs (design §3(f); the session-memory-disabled
// case lives in the file's LAST describe — it locks the settings global).
// ---------------------------------------------------------------------------

describe("T8 — kill switches", () => {
  it("WUDAO_DREAM=off → undefined, no model calls", async () => {
    await seedDue(8);
    process.env.WUDAO_DREAM = "off";
    const model = recordingModel(() => ({ role: "assistant", content: "x" }));
    expect(await spawnDreamRun({ workspaceRoot: dir, model, registry: createSessionRegistry() })).toBeUndefined();
    expect(model.inputs).toHaveLength(0);
  });

  it("WUDAO_NO_DREAM_FORK=1 → undefined", async () => {
    await seedDue(8);
    process.env.WUDAO_NO_DREAM_FORK = "1";
    const model = recordingModel(() => ({ role: "assistant", content: "x" }));
    expect(await spawnDreamRun({ workspaceRoot: dir, model, registry: createSessionRegistry() })).toBeUndefined();
    expect(model.inputs).toHaveLength(0);
  });

  it("registry-less caller → undefined", async () => {
    await seedDue(8);
    const model = recordingModel(() => ({ role: "assistant", content: "x" }));
    expect(await spawnDreamRun({ workspaceRoot: dir, model })).toBeUndefined();
    expect(model.inputs).toHaveLength(0);
  });

  it("not due (7 unprocessed) → undefined", async () => {
    await seedDue(7);
    const model = recordingModel(() => ({ role: "assistant", content: "x" }));
    expect(await spawnDreamRun({ workspaceRoot: dir, model, registry: createSessionRegistry() })).toBeUndefined();
    expect(model.inputs).toHaveLength(0);
    expect(await readDreamCursor(dir)).toEqual({ lastSeq: 0 }); // no cursor file written
  });
});

// ---------------------------------------------------------------------------
// T9 (spawn half) — module single-flight.
// ---------------------------------------------------------------------------

describe("T9 (spawn) — single-flight", () => {
  it("a second dream while one is in flight returns undefined", async () => {
    await seedDue(8);
    let release: (m: AssistantMessage) => void = () => {};
    const gate = new Promise<AssistantMessage>((r) => { release = r; });
    const model = recordingModel(() => gate);
    const registry = createSessionRegistry();
    const first = await spawnDreamRun({ workspaceRoot: dir, model, registry });
    expect(first).toBeDefined();
    const second = await spawnDreamRun({
      workspaceRoot: dir,
      model: recordingModel(() => ({ role: "assistant", content: "x" })),
      registry,
    });
    expect(second).toBeUndefined();
    release({ role: "assistant", content: "done" });
    await first!.done;
    // After settle, the slot frees.
    expect(await readDreamAudit(dir)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// T10 — parent isolation (design §3(h): zero M24 cost by construction).
// ---------------------------------------------------------------------------

describe("T10 — parent isolation", () => {
  it("parent ModelInputs byte-identical to a no-Dream control; receipt only via onReceipt after settle", async () => {
    await seedDue(8);
    const runParent = async (): Promise<string[]> => {
      const searchTool: Tool = createMemorySearchTool(openMemoryStore(dir));
      const model = recordingModel((_i, c) => (c === 1
        ? call("p1", "memory_search", { query: "build" })
        : { role: "assistant", content: "the parent's final answer" }));
      const state: AgentState = {
        systemPrompt: "parent system prompt",
        messages: [{ role: "user", content: "how do the builds gate merges?" }],
        tools: [searchTool],
        status: "running",
      };
      await drainLoop(runAgentLoop(state, model, {}));
      return model.inputs.map((i) => JSON.stringify(i));
    };
    const control = await runParent();
    const treatment = await runParent();
    const parentSettled = true; // the run settled — Dream fires at the seam
    const receipts: string[] = [];
    const childModel = recordingModel((_i, c) => (c === 1
      ? call("w1", "memory_write", { kind: "fact", content: "a dream-era note about pipeline gating order" })
      : { role: "assistant", content: "consolidated one note" }));
    const spawn = await spawnDreamRun({
      workspaceRoot: dir,
      model: childModel,
      registry: createSessionRegistry(),
      onReceipt: (l) => receipts.push(`${parentSettled ? "after" : "DURING"}|${l}`),
    });
    expect(spawn).toBeDefined();
    await spawn!.done;
    expect(receipts).toEqual(["after|🧠 dream: consolidated 1 entry (added 1, 0 pending)"]);

    // Byte-identical parent inputs — and no dream text, receipt glyph, or
    // recall MetaNote ever entered them (no steering enqueue, no MetaNote).
    expect(treatment).toEqual(control);
    for (const snap of treatment) {
      expect(snap.includes(DREAM_PROMPT.slice(0, 24))).toBe(false);
      expect(snap.includes("Relevant memories")).toBe(false);
      expect(snap.includes("🧠")).toBe(false);
    }
    // The child DID get the dream brief; it never got a recall note.
    expect(childModel.inputs[0]!.messages[0]!.content).toContain(DREAM_PROMPT.slice(0, 24));
    for (const input of childModel.inputs) {
      expect(input.messages.some((m) => m.content.includes("Relevant memories"))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// T11 — the manual verb (/memory dream, design §3(f)).
// ---------------------------------------------------------------------------

describe("T11 — the manual verb", () => {
  it("empty ledger → (nothing to consolidate); no model calls, no audit", async () => {
    const model = recordingModel(() => ({ role: "assistant", content: "x" }));
    expect(await runDreamVerb({ workspaceRoot: dir, model, registry: createSessionRegistry() })).toBe("(nothing to consolidate)");
    expect(model.inputs).toHaveLength(0);
    expect(await readDreamAudit(dir)).toEqual([]);
  });

  it("runs despite a blocking interval gate; receipt + audit appended", async () => {
    await seedDue(8);
    // A recent aborted attempt would block the auto path for 30 minutes —
    // the verb bypasses ONLY the due-gates (never the gate/audit).
    await writeDreamCursor(dir, { lastSeq: 0, lastRunAt: new Date().toISOString(), lastRunOk: false });
    const model = recordingModel((_i, c) => (c === 1
      ? call("w1", "memory_write", { kind: "fact", content: "the manual dream verb bypasses the interval gates only" })
      : { role: "assistant", content: "done" }));
    const line = await runDreamVerb({ workspaceRoot: dir, model, registry: createSessionRegistry() });
    expect(line).toBe("🧠 dream: consolidated 1 entry (added 1, 0 pending)");
    const cursor = await readDreamCursor(dir);
    expect(cursor.lastSeq).toBe(8);
    expect(cursor.lastRunOk).toBe(true);
    expect(await readDreamAudit(dir)).toHaveLength(1);
  });

  it("kill switch → the disabled line, no audit", async () => {
    await seedDue(8);
    process.env.WUDAO_DREAM = "off";
    const line = await runDreamVerb({ workspaceRoot: dir, model: recordingModel(() => ({ role: "assistant", content: "x" })), registry: createSessionRegistry() });
    expect(line).toContain("disabled");
    expect(await readDreamAudit(dir)).toEqual([]);
  });

  it("wired into /memory <dream>", async () => {
    await seedDue(8);
    const model = recordingModel(() => ({ role: "assistant", content: "nothing worth merging" }));
    const dream: MemoryDreamContext = { model, registry: createSessionRegistry() };
    expect(await runMemoryCommand(dir, "dream", dream)).toBe("🧠 dream: consolidated 0 entries (added 0, 0 pending)");
    expect(await runMemoryCommand(dir, "dream")).toContain("用法："); // ω99-166d-i: 泛 usage 钉演进（#14）
  });
});

// ---------------------------------------------------------------------------
// T12 — rollback (design §3(g): addedIds are the /memory del targets).
// ---------------------------------------------------------------------------

describe("T12 — rollback", () => {
  it("the audit's addedIds delete cleanly; the audit file keeps naming them; no seq moved", async () => {
    await seedDue(8);
    const model = recordingModel((_i, c) => (c === 1
      ? call("w1", "memory_write", { kind: "fact", content: "rollback shape: the audit names exactly what the dream added" })
      : { role: "assistant", content: "saved" }));
    const spawn = await spawnDreamRun({ workspaceRoot: dir, model, registry: createSessionRegistry() });
    await spawn!.done;
    const audit = await readDreamAudit(dir);
    expect(audit[0]!.addedIds.length).toBeGreaterThanOrEqual(1);

    const store = openMemoryStore(dir);
    for (const id of audit[0]!.addedIds) {
      expect(await store.remove(id)).toBe(true);
    }
    const remaining = await store.load();
    for (const id of audit[0]!.addedIds) {
      expect(remaining.some((e) => e.id === id)).toBe(false);
    }
    // The forensic trail survives; deleting entries changed no seq.
    const raw = await readFile(join(dir, ".wudao", "dream.jsonl"), "utf8");
    for (const id of audit[0]!.addedIds) expect(raw).toContain(id);
    expect((await readDreamCursor(dir)).lastSeq).toBe(8);
    expect(remaining.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

// ---------------------------------------------------------------------------
// T8 (final) — disabled session memory. This call LOCKS the store's
// session-settings global (first-call-wins, never reset) for the whole test
// file, so this describe MUST stay the file's LAST test.
// ---------------------------------------------------------------------------

describe("T8 (final) — disabled session memory", () => {
  it("memoryEnabled:false → spawnDreamRun undefined", async () => {
    await seedDue(8);
    setSessionMemorySettings({ enabled: false, path: join(dir, ".wudao", "memory.jsonl") });
    const model = recordingModel(() => ({ role: "assistant", content: "x" }));
    expect(await spawnDreamRun({ workspaceRoot: dir, model, registry: createSessionRegistry() })).toBeUndefined();
    expect(model.inputs).toHaveLength(0);
  });
});
