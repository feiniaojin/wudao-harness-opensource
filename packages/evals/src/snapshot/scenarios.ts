// M71 §1 — the snapshot scenario set. Each scenario runs the REAL production
// assembly (buildSystemPrompt, real tools, real loop) twice around the
// marker-bearing persistence boundary; the only difference between record
// and replay is where the HTTP responses come from. Fixtures land in
// packages/evals/snapshots/<name>/ and are committed: record on the dev key
// (WUDAO_SNAPSHOT=record), replay keylessly forever after (`pnpm test`).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGlobTool, createGrepTool, createReadFileTool } from "@wudao-org/core";
import { buildSystemPrompt } from "wudao-harness/prompt";
import type { SnapshotScenario } from "./engine.js";

// ---------------------------------------------------------------------------
// snap-01: read a file and answer — the production system prompt (project
// context included) + one tool turn + the resume phase. The baseline net for
// prompt assembly: system prompt bytes, tool serialization, message
// projection, session persistence.
// ---------------------------------------------------------------------------

const readAnswerScenario: SnapshotScenario = {
  name: "snap-01-read-answer",
  sessionId: "snap01",
  async setup(workspaceRoot) {
    await writeFile(
      join(workspaceRoot, "notes.md"),
      "# Session notes\n\nThe access codename for this fixture is AMBER-YAK-42.\nIt has no other content.\n",
      "utf8",
    );
    // A workspace-level WUDAO.md rides the REAL project-context tier of the
    // system prompt — pinned through the same production loader the CLI uses.
    await writeFile(
      join(workspaceRoot, "WUDAO.md"),
      "# Conventions\n\n- Answer in one short sentence.\n- Always quote codenames verbatim.\n",
      "utf8",
    );
    return {
      systemPrompt: buildSystemPrompt(workspaceRoot),
      userPrompt: "Read notes.md and reply with the codename it contains.",
      tools: [createReadFileTool({ workspaceRoot })],
      resumePrompt: "Reply with exactly: RESUME-OK",
    };
  },
};

// ---------------------------------------------------------------------------
// snap-02: a tool chain — glob → grep → read_file over a small fixture tree.
// Pins multi-turn assembly: tool results projected into later request bodies,
// append-only growth across turns, the chain's persisted transcript.
// ---------------------------------------------------------------------------

const toolChainScenario: SnapshotScenario = {
  name: "snap-02-tool-chain",
  sessionId: "snap02",
  async setup(workspaceRoot) {
    const docs = join(workspaceRoot, "docs");
    await mkdir(docs, { recursive: true });
    await writeFile(join(docs, "alpha.md"), "# alpha\nJust ordinary release notes.\n", "utf8");
    await writeFile(join(docs, "beta.md"), "# beta\nThe access codeword is COBALT-OTTER-19.\n", "utf8");
    await writeFile(join(workspaceRoot, "scratch.txt"), "nothing interesting here\n", "utf8");
    return {
      systemPrompt: buildSystemPrompt(workspaceRoot),
      userPrompt:
        "Find the markdown files in this workspace with glob, locate the one containing the word COBALT with grep, read that file with read_file, and tell me the full codeword it contains.",
      tools: [
        createGlobTool({ workspaceRoot }),
        createGrepTool({ workspaceRoot }),
        createReadFileTool({ workspaceRoot }),
      ],
      resumePrompt: "In one word: what tool did you use to find the file?",
    };
  },
};

// ---------------------------------------------------------------------------
// snap-03: compaction — a ~2.5KB tool result under a context budget sized so
// the microcompact pipeline fires EXACTLY ONCE, at a turn boundary, with a
// LATER model call riding the stubbed projection. The reads must land in
// SEPARATE turns (parallel tool calls in one turn end the run before any
// compacted request goes out), so big.txt ends with a pointer line naming
// the companion file — the model has to read big.txt before it knows what
// to read next (window 2000 → threshold 1600; the production system prompt
// alone estimates ~1.2K tokens):
//   call 1 (occupancy ~1.3K < 1600): read big.txt;
//   call 2 (occupancy ~1.9K ≥ 1600, defer band): warm full-suffix call that
//          reads small.txt — the boundary compaction runs AFTER it;
//   call 3: carries the STUBBED big.txt result — the projection pin.
// The persisted history stays append-only with the FULL result. (A smaller
// window trips the loop's compaction-thrash guard — learned on recording.)
// ---------------------------------------------------------------------------

const compactionScenario: SnapshotScenario = {
  name: "snap-03-compaction",
  sessionId: "snap03",
  async setup(workspaceRoot) {
    await writeFile(
      join(workspaceRoot, "big.txt"),
      `${"payload line with stable bytes\n".repeat(79)}The companion file to read next is: small.txt\n`,
      "utf8",
    );
    await writeFile(join(workspaceRoot, "small.txt"), "tiny fixture file\nwith two lines\n", "utf8");
    return {
      systemPrompt: buildSystemPrompt(workspaceRoot),
      userPrompt:
        "Read big.txt — its last line names a companion file. Read that companion file too, then reply with the first two words of each file.",
      tools: [createReadFileTool({ workspaceRoot })],
      loopOptions: { compaction: { contextWindowTokens: 2000 } },
      resumePrompt: "Reply with exactly: COMPACT-RESUME-OK",
    };
  },
};

export const snapshotScenarios: readonly SnapshotScenario[] = [
  readAnswerScenario,
  toolChainScenario,
  compactionScenario,
];
