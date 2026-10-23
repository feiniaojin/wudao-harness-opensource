// det-62-night-porting-5 — the deterministic behavior pins for 夜移 015
// (候选 #22: 真 CC memdir 读侧召回的 wudao 适配切片). The feature landed
// with cli unit tests (tests/memory.test.ts, 5 new contracts); this suite
// pays the det-44-style debt the same way det-57..det-61 did — the behavior
// pinned inside the release-eval matrix, so a regression fails the release
// evals, not just a package test someone might not run. Zero network, zero
// real-home reads, zero model calls (the recall path is pure + store-only).
//
//   ① age helpers       memoryAgeDays floors/clamps/tolerates junk;
//      memoryAgeLabel carries the date arithmetic; the pool cap is 200.
//   ② line suffix       every recalled line carries the age label inside
//      the metadata parens (the model never sees a raw created timestamp).
//   ③ staleness caveat  exactly one note-level caveat when ANY selected
//      entry is ≥2 days old; absent when everything is fresh.
//   ④ runtime hits      re-injection happens EVERY run (the MetaNote
//      channel is per-run ephemeral — alreadySurfaced would hide memories
//      the model needs again), but hits counts once per entry per session.
//   ⑤ pool cap          the runtime's pool is the newest 200 entries —
//      older high-scorers beyond the cap never surface.
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  recallMemories,
  memoryAgeDays,
  memoryAgeLabel,
  RECALL_STALENESS_NOTE,
  RECALL_POOL_CAP,
  createMemoryRuntime,
} from "wudao-harness/memory";
import type { MemoryEntry } from "wudao-harness/memory";
import type { EvalDefinition } from "../runner.js";

export interface NightPorting5Evidence {
  readonly root: string;
  // ① age helpers
  readonly ageMatrix: readonly boolean[];
  readonly labelMatrix: readonly boolean[];
  readonly poolCap: number;
  // ② line suffix
  readonly agedSuffix: boolean;
  readonly freshSuffix: boolean;
  // ③ staleness caveat
  readonly caveatWhenStale: boolean;
  readonly noCaveatWhenFresh: boolean;
  // ④ runtime: re-inject every run, count once
  readonly noteRun1: boolean;
  readonly noteRun2: boolean;
  readonly hitsAfterTwoRuns: number;
  // ⑤ pool cap
  readonly cappedNote: boolean;
  readonly oldLeaked: boolean;
  readonly newSurfaced: boolean;
}

const NOW = Date.parse("2026-08-28T12:00:00.000Z");

function entry(over: Partial<MemoryEntry> & { id: string; content: string }): MemoryEntry {
  return { kind: "fact", scope: "project", tags: [], created: new Date(NOW).toISOString(), hits: 0, status: "active", ...over };
}

const rawLine = (over: Record<string, unknown>): string =>
  JSON.stringify({ kind: "fact", scope: "project", tags: [], created: new Date().toISOString(), hits: 0, status: "active", ...over });

export const det62Eval: EvalDefinition<{ readonly root: string }, NightPorting5Evidence> = {
  name: "det-62-night-porting-5",
  kind: "deterministic",
  async setup() {
    return { root: await mkdtemp(join(tmpdir(), "det62-night5-")) };
  },
  async run(ctx) {
    // ① the pure helpers (fixed clock — no wall-time dependence).
    const ageMatrix = [
      memoryAgeDays("2026-08-28T12:00:00.000Z", NOW) === 0,
      memoryAgeDays("2026-08-27T12:00:00.000Z", NOW) === 1,
      memoryAgeDays("2026-08-27T00:00:00.000Z", NOW) === 1, // 36h floors to 1
      memoryAgeDays("2026-08-25T12:01:00.000Z", NOW) === 2, // 71h59m floors to 2
      memoryAgeDays("2026-08-29T00:00:00.000Z", NOW) === 0, // future clamps to 0
      memoryAgeDays("not-a-timestamp", NOW) === 0,
    ];
    const labelMatrix = [
      memoryAgeLabel(0) === "today",
      memoryAgeLabel(1) === "yesterday",
      memoryAgeLabel(2) === "2d ago",
      memoryAgeLabel(400) === "400d ago",
    ];

    // ②+③ the recall note contract against a fixed clock.
    const aged = recallMemories({
      entries: [entry({ id: "m-1", content: "run pnpm eval before merging", tags: ["build"], created: "2026-08-25T12:00:00.000Z" })],
      prompt: "how about the build",
      now: NOW,
    });
    const fresh = recallMemories({
      entries: [entry({ id: "m-1", content: "run pnpm eval before merging", tags: ["build"], created: new Date(NOW - 86_400_000).toISOString() })],
      prompt: "how about the build",
      now: NOW,
    });

    // ④ the runtime: seed one real store file, recall twice, read hits back.
    const storePath = join(ctx.root, ".wudao", "memory.jsonl");
    await mkdir(dirname(storePath), { recursive: true });
    await writeFile(storePath, rawLine({ id: "m-1", content: "run pnpm eval before merging", tags: ["build"] }) + "\n", "utf8");
    const rt = createMemoryRuntime(ctx.root);
    await rt.refresh();
    const noteRun1 = rt.recall("how about the build") !== undefined;
    const noteRun2 = rt.recall("how about the build") !== undefined;
    let hitsAfterTwoRuns = -1;
    for (let i = 0; i < 200 && hitsAfterTwoRuns !== 1; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      hitsAfterTwoRuns = (JSON.parse((await readFile(storePath, "utf8")).trim()) as { hits: number }).hits;
    }

    // ⑤ the pool cap: 6 old high-scorers (2 tag matches) beyond the newest
    // 200 regular entries (1 tag match).
    const lines: string[] = [];
    for (let i = 0; i < 6; i += 1) lines.push(rawLine({ id: `old-${i}`, content: `old high-scorer ${i}`, tags: ["build", "merge"] }));
    for (let i = 0; i < 200; i += 1) lines.push(rawLine({ id: `new-${i}`, content: `new regular note ${i}`, tags: ["build"] }));
    const capRoot = await mkdtemp(join(tmpdir(), "det62-night5-cap-"));
    const capPath = join(capRoot, ".wudao", "memory.jsonl");
    await mkdir(dirname(capPath), { recursive: true });
    await writeFile(capPath, lines.join("\n") + "\n", "utf8");
    const capRt = createMemoryRuntime(capRoot);
    await capRt.refresh();
    const cappedNoteText = capRt.recall("build merge") ?? "";

    return {
      root: ctx.root,
      ageMatrix,
      labelMatrix,
      poolCap: RECALL_POOL_CAP,
      agedSuffix: aged.note?.includes("(tags: build; 3d ago)") === true,
      freshSuffix: fresh.note?.includes("(tags: build; yesterday)") === true,
      caveatWhenStale: aged.note?.includes(RECALL_STALENESS_NOTE) === true,
      noCaveatWhenFresh: fresh.note?.includes(RECALL_STALENESS_NOTE) !== true,
      noteRun1,
      noteRun2,
      hitsAfterTwoRuns,
      cappedNote: cappedNoteText.length > 0,
      oldLeaked: cappedNoteText.includes("old high-scorer"),
      newSurfaced: cappedNoteText.includes("new regular note"),
    };
  },
  assertions(e) {
    const errs: string[] = [];
    const need = (ok: boolean, msg: string) => { if (!ok) errs.push(msg); };

    need(e.ageMatrix.every(Boolean), `① memoryAgeDays matrix must hold (got ${JSON.stringify(e.ageMatrix)})`);
    need(e.labelMatrix.every(Boolean), `① memoryAgeLabel matrix must hold (got ${JSON.stringify(e.labelMatrix)})`);
    need(e.poolCap === 200, `① the recall pool cap must be 200 (got ${String(e.poolCap)})`);

    need(e.agedSuffix && e.freshSuffix,
      `② every recall line carries the age label (aged=${String(e.agedSuffix)}, fresh=${String(e.freshSuffix)})`);
    need(e.caveatWhenStale && e.noCaveatWhenFresh,
      `③ the staleness caveat fires exactly when a selected entry is ≥2 days old (stale=${String(e.caveatWhenStale)}, fresh=${String(e.noCaveatWhenFresh)})`);

    need(e.noteRun1 && e.noteRun2, "④ recall re-injects EVERY run (the MetaNote channel is ephemeral — that is the design)");
    need(e.hitsAfterTwoRuns === 1, `④ hits counts once per entry per session, not once per run (got ${String(e.hitsAfterTwoRuns)})`);

    need(e.cappedNote && e.newSurfaced, "⑤ the capped pool still surfaces the newest entries");
    need(!e.oldLeaked, "⑤ entries beyond the newest-200 cap never surface, even when they out-score");

    return errs;
  },
};
