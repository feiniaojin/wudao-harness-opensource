// det-75-night-porting-18 — the deterministic behavior pins for 夜移 030
// (the file-operations ledger riding tier-2 compaction summaries, ported
// from pi's compaction/utils.ts). Post-compaction the model used to lose its
// file footprint: redundant re-reads (full tokens, fresh cache-miss bytes)
// and lost "already edited X" awareness. The ledger is mechanical — span
// assistant toolCall blocks, never LLM-dependent — and survives N chained
// compactions by re-parsing the tags out of the prior frozen summary (the
// wudao delta: state-free re-derivation where pi persists entry details).
// Pinned through the PUBLIC `@wudao/core` exports: the constants, the
// extraction classification (modified-wins, recency bump, non-file tools
// ignored), the parse round-trip (omission line stripped, torn tags
// ignored, last block wins), the cross-boundary promotion, the cap, and
// the composed tier-2 message shape (tags after the system note, before
// the end marker; file-less spans keep status-quo bytes).
import type { EvalDefinition } from "../runner.js";
import {
  extractFileOps,
  parseFileOpsFromSummary,
  mergeFileOps,
  formatFileOperations,
  tier2Compact,
  FILE_LEDGER_READ_TAG,
  FILE_LEDGER_MODIFIED_TAG,
  FILE_LEDGER_CAP,
  SUMMARY_MARKER,
  SUMMARY_END_MARKER,
} from "@wudao/core";
import { createScriptedModel } from "@wudao/core";
import type { AgentMessage, ModelClient } from "@wudao/core";

const tc = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, arguments: args });
const user = (content: string): AgentMessage => ({ role: "user", content });
const asstCalls = (...calls: ReturnType<typeof tc>[]): AgentMessage => ({ role: "assistant", content: "", toolCalls: calls });
const toolMsg = (id: string, name: string, content: string): AgentMessage => ({ role: "tool", toolCallId: id, name, content });
const asstText = (content: string): AgentMessage => ({ role: "assistant", content });

const alwaysModel = (text: string): ModelClient => {
  const scripted = createScriptedModel([
    { role: "assistant", content: text },
    { role: "assistant", content: text },
  ]);
  return { generate: (input) => scripted.generate(input) };
};

const fileOpsSpan = (): AgentMessage[] => [
  user("do things " + "x".repeat(200)),
  asstCalls(tc("c1", "read_file", { path: "src/a.ts" })),
  toolMsg("c1", "read_file", "content of a"),
  asstText("ok"),
  user("now edit " + "y".repeat(200)),
  asstCalls(tc("c2", "edit", { path: "src/b.ts", old_string: "a", new_string: "b" })),
  toolMsg("c2", "edit", "ok"),
  asstText("done"),
  user("latest"),
];

export interface NightPorting18Evidence {
  // ① the exported constants: pi tag names + the wudao cap (pi is unbounded)
  readonly constants: boolean;
  // ② extraction classification: read_file→read, write_file/edit→modified,
  //    same-arg non-file tools ignored, non-string/empty paths ignored
  readonly extraction: boolean;
  // ③ modified wins in both orders; re-touch bumps recency
  readonly precedence: boolean;
  // ④ format→parse round-trip; omission line stripped; torn tag ignored;
  //    the LAST block wins over an early echo
  readonly roundTrip: boolean;
  // ⑤ cross-boundary merge: a prior read the span edits is promoted
  readonly promotion: boolean;
  // ⑥ the cap: oldest dropped, omission line, capped list re-parses cleanly
  readonly cap: boolean;
  // ⑦ tier-2 composition: tags after the system note before the end marker;
  //    file-less span keeps status-quo bytes; the chained boundary carries
  //    the running ledger with each path exactly once
  readonly tier2Shape: boolean;
}

export const det75Eval: EvalDefinition<Record<string, never>, NightPorting18Evidence> = {
  name: "det-75-night-porting-18",
  kind: "deterministic",
  async setup() {
    return {};
  },
  async run() {
    // ① constants.
    const constants = FILE_LEDGER_READ_TAG === "read-files"
      && FILE_LEDGER_MODIFIED_TAG === "modified-files"
      && FILE_LEDGER_CAP === 50;

    // ② extraction classification.
    const extractionOps = extractFileOps([
      asstCalls(
        tc("a", "read_file", { path: "r.ts" }),
        tc("b", "write_file", { path: "w.ts", content: "x" }),
        tc("c", "edit", { path: "e.ts", old_string: "a", new_string: "b" }),
        tc("d", "grep", { path: "g.ts", pattern: "x" }),
        tc("e", "read_file", { path: 7 }),
        tc("f", "write_file", { path: "", content: "x" }),
      ),
    ]);
    const extraction = extractionOps.read.length === 1 && extractionOps.read[0] === "r.ts"
      && extractionOps.modified.length === 2
      && extractionOps.modified[0] === "w.ts" && extractionOps.modified[1] === "e.ts";

    // ③ precedence + recency.
    const readThenEdit = extractFileOps([
      asstCalls(tc("a", "read_file", { path: "f.ts" })),
      asstCalls(tc("b", "edit", { path: "f.ts", old_string: "a", new_string: "b" })),
    ]);
    const bumped = extractFileOps([
      asstCalls(tc("a", "read_file", { path: "a.ts" })),
      asstCalls(tc("b", "read_file", { path: "b.ts" })),
      asstCalls(tc("c", "read_file", { path: "a.ts" })),
    ]);
    const precedence = readThenEdit.read.length === 0 && readThenEdit.modified.length === 1
      && bumped.read.length === 2 && bumped.read[0] === "b.ts" && bumped.read[1] === "a.ts";

    // ④ round-trip + parse hardening.
    const formatted = formatFileOperations(["a.ts", "b.ts"], ["c.ts"]);
    const round = parseFileOpsFromSummary(`x${formatted}`);
    const torn = parseFileOpsFromSummary("<read-files>\na.ts\n");
    const lastBlock = parseFileOpsFromSummary("<read-files>\nold.ts\n</read-files>\n<read-files>\nnew.ts\n</read-files>");
    const omissionStripped = parseFileOpsFromSummary("<read-files>\n[... 9 older files omitted]\nf.ts\n</read-files>");
    const roundTrip = formatted === "\n\n<read-files>\na.ts\nb.ts\n</read-files>\n\n<modified-files>\nc.ts\n</modified-files>"
      && round !== undefined && round.read.length === 2 && round.modified.length === 1
      && torn === undefined
      && lastBlock !== undefined && lastBlock.read.length === 1 && lastBlock.read[0] === "new.ts"
      && omissionStripped !== undefined && omissionStripped.read.length === 1 && omissionStripped.read[0] === "f.ts";

    // ⑤ cross-boundary promotion.
    const promoted = mergeFileOps({ read: ["old.ts", "keep.ts"], modified: ["done.ts"] }, { read: ["new.ts"], modified: ["old.ts"] });
    const promotion = promoted.read.length === 2 && promoted.read[0] === "keep.ts" && promoted.read[1] === "new.ts"
      && promoted.modified.length === 2 && promoted.modified[0] === "done.ts" && promoted.modified[1] === "old.ts";

    // ⑥ cap.
    const many = Array.from({ length: FILE_LEDGER_CAP + 10 }, (_, i) => `f${String(i).padStart(2, "0")}.ts`);
    const capped = formatFileOperations(mergeFileOps(undefined, { read: many, modified: [] }).read, []);
    const cappedLines = capped.split("\n");
    const reParsed = parseFileOpsFromSummary(`x${capped}`);
    const cap = cappedLines[3] === "[... 10 older files omitted]"
      && cappedLines[4] === "f10.ts"
      && reParsed !== undefined && reParsed.read.length === FILE_LEDGER_CAP && reParsed.read[0] === "f10.ts";

    // ⑦ tier-2 composition.
    const first = await tier2Compact(fileOpsSpan(), alwaysModel("SUM"), { keepRecent: 1 });
    const firstContent = first !== null ? first.summaryMessage.content : "";
    const noteIdx = firstContent.indexOf("[system note:");
    const readIdx = firstContent.indexOf("<read-files>");
    const endIdx = firstContent.indexOf(SUMMARY_END_MARKER);
    const hasTags = first !== null
      && firstContent.includes("<read-files>\nsrc/a.ts\n</read-files>")
      && firstContent.includes("<modified-files>\nsrc/b.ts\n</modified-files>")
      && noteIdx !== -1 && readIdx > noteIdx && readIdx < endIdx;
    const fileLess = await tier2Compact([
      user("plain " + "x".repeat(200)),
      asstText("answer"),
      user("plain2 " + "y".repeat(200)),
      asstText("answer2"),
      user("latest"),
    ], alwaysModel("SUM"), { keepRecent: 1 });
    const statusQuo = fileLess !== null
      && !fileLess.summaryMessage.content.includes("<read-files>")
      && !fileLess.summaryMessage.content.includes("<modified-files>");
    const grown: AgentMessage[] = first !== null ? [
      ...first.messages,
      user("phase 2 " + "z".repeat(2000)),
      asstCalls(tc("c3", "read_file", { path: "src/c.ts" })),
      toolMsg("c3", "read_file", "c"),
      asstText("ok2"),
      user("tail"),
    ] : [];
    const second = grown.length > 0 ? await tier2Compact(grown, alwaysModel("S2"), { keepRecent: 1 }) : null;
    const secondContent = second !== null ? second.summaryMessage.content : "";
    const chained = second !== null
      && secondContent.includes("<read-files>\nsrc/a.ts\nsrc/c.ts\n</read-files>")
      && secondContent.includes("<modified-files>\nsrc/b.ts\n</modified-files>")
      && secondContent.split("src/a.ts").length - 1 === 1;
    const tier2Shape = hasTags && statusQuo && chained;

    return { constants, extraction, precedence, roundTrip, promotion, cap, tier2Shape };
  },
  assertions(e) {
    const errs: string[] = [];
    const need = (ok: boolean, msg: string) => {
      if (!ok) errs.push(msg);
    };

    need(e.constants, "① the ledger constants must export unrounded (tags read-files/modified-files, cap 50)");
    need(e.extraction, "② extraction must classify read_file→read, write_file/edit→modified, and ignore non-file tools and non-string/empty paths");
    need(e.precedence, "③ modified must win over read in both orders and a re-touch must bump recency");
    need(e.roundTrip, "④ format→parse must round-trip; the omission line strips, torn tags don't parse, the LAST block wins");
    need(e.promotion, "⑤ a prior read the span edits must be promoted to modified at the next boundary");
    need(e.cap, "⑥ the cap must drop the oldest entries behind an omission line and re-parse to the capped list");
    need(e.tier2Shape, "⑦ tier-2 summaries must carry the tags after the system note (before the end marker), keep file-less spans byte-identical, and chain the running ledger");

    return errs;
  },
};
