import { readFile, writeFile, stat } from "node:fs/promises";
import { buildTool } from "../tool.js";
import { resolveWorkspacePath } from "./workspace.js";
import { freshnessError, readStateEntry, type ReadStateTable } from "./read-state.js";
import type { FileHistory } from "./file-history.js";
import type { TurnDiffTracker } from "../turn-diff.js";
import { verifyWrittenFile, shapeVerifiedResult, appendDiagnosticsLines, type WriteVerifyConfig, type DiagnosticsLayer } from "./write-verify.js";
import type { PendingWriteGate } from "../pending-actions.js";

// M32 §1 — edit hardening:
//   * fail-closed freshness against the session's read-state table (an
//     externally changed file refuses the edit until re-read),
//   * a quote-normalized → whitespace-tolerant fuzzy ladder (unique hit
//     required at every rung) so a smart-quoted or stray-whitespace old_string
//     lands in one shot instead of a failed round-trip,
//   * replace_all,
//   * ±4-line numbered result/error snippets instead of a bare "edited".
//
// ω99-4a — match ladder widened (aider search_replace.py port):
//   * blank-line-relaxed: boundary BLANK LINES stripped off old_string, with
//     new_string stripped the SAME way (aider strips the search/replace/
//     original triple identically — strip_blank_lines :611-614; preproc order
//     strip-before-indent from all_preprocs :527-541).
//   * indent-relative: whole-block UNIFORM indent shift — needle lines are
//     compared with leading [ \t] stripped (a TS simplification of aider's
//     RelativeIndenter :18-100 + try_strategy :580-607, which exists to feed
//     its dmp fuzzy path; we only detect/apply a uniform shift). Non-uniform
//     misalignment deliberately does NOT hit — it falls to the closest-
//     candidate teaching error, because when the model also got the relative
//     structure wrong, guessing is worse than not guessing.
//   Negative verdicts (controller ruling — do NOT port):
//   * git cherry-pick strategy (:481-507): spawning a git subprocess for an
//     in-process string edit is heavy and platform-risky; uniform shift
//     already covers the main failure face.
//   * dmp/difflib fuzzy apply: fuzzy hits are exactly what the unique-hit
//     iron law below exists to prevent.
//   * reverse_lines (:543-546): aider itself commented it out.
//   Execution order: exact → quote-normalized → blank-line-relaxed →
//   whitespace-tolerant → indent-relative. blank-line runs BEFORE the trim
//   because it strips strictly less (a shorter prefix/suffix survives), i.e.
//   it is the TIGHTER normalization and must claim the match first — placed
//   after the trim it could never fire in single-replacement mode, since
//   every blank-line-stripped hit is also a trimmed hit.

/** Context lines around the edit shown in result/error snippets. */
const SNIPPET_CONTEXT = 4;

type MatchLevel = "exact" | "quote-normalized" | "whitespace-tolerant"
                | "blank-line-relaxed" | "indent-relative";

interface MatchOutcome {
  readonly level: MatchLevel;
  /** Match start offsets in the ORIGINAL content (sorted). */
  readonly starts: readonly number[];
  /** Match length in the original content. */
  readonly length: number;
  /** ω99-4a: rungs that normalize old_string must transform new_string the
   *  same way (aider's triple-strip). Absent → new_string applies verbatim
   *  (the pre-ω99-4a behavior of every legacy rung). */
  readonly replacement?: string;
}

// ω99-4a rung 4 — boundary BLANK LINES only (a whole line that is empty or
// whitespace-only), NOT the whole-segment trim of rung 3: the leading anchor
// demands a newline first, so a first line's leading spaces or a last line's
// trailing spaces survive. Blank lines carrying trailing spaces/tabs count.
const LEADING_BLANK_LINES = /^(\n[ \t]*)+/;
const TRAILING_BLANK_LINES = /(\n[ \t]*)+$/;

function stripBoundaryBlankLines(s: string): string {
  return s.replace(LEADING_BLANK_LINES, "").replace(TRAILING_BLANK_LINES, "");
}

// Smart quotes (“ ” ‘ ’) each normalize to exactly one ASCII character, so the
// normalized string has the SAME length — offsets map 1:1 onto the original.
const SMART_QUOTES = /[“”‘’]/g;
const SMART_MAP: Record<string, string> = { "“": '"', "”": '"', "‘": "'", "’": "'" };

function normalizeQuotes(s: string): string {
  return s.replace(SMART_QUOTES, (c) => SMART_MAP[c] ?? c);
}

/** All occurrence offsets of `needle` in `haystack`. `overlap` steps by 1 (so
 *  "aa" in "aaa" counts as 2 — the uniqueness verdict must see every hit);
 *  non-overlapping steps past each consumed hit (replacement semantics). */
function occurrences(haystack: string, needle: string, overlap: boolean): number[] {
  if (needle === "") return [];
  const out: number[] = [];
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + (overlap ? 1 : needle.length));
  }
  return out;
}

/** The match ladder. Single-replacement mode demands exactly one hit per rung
 *  (zero hits fall through, 2+ hits are an ambiguity error). replace_all
 *  accepts 1+ hits at the two normalization rungs (the whitespace rung is a
 *  single-target concept — trimming against many hits is ambiguous).
 *  ω99-4a: newStr rides along so the two new rungs can return a
 *  correspondingly-transformed replacement (see MatchOutcome.replacement). */
function findMatch(content: string, oldStr: string, newStr: string, replaceAll: boolean): MatchOutcome | { error: string } {
  if (oldStr === "") return { error: "old_string must not be empty" };

  const exact = occurrences(content, oldStr, !replaceAll);
  if (exact.length > 1 && !replaceAll) {
    return { error: `old_string is not unique in this file (${exact.length} occurrences) — add surrounding context lines until it is unique, or pass replace_all: true` };
  }
  if (exact.length >= 1) return { level: "exact", starts: exact, length: oldStr.length };

  const normalizedContent = normalizeQuotes(content);
  const normalizedNeedle = normalizeQuotes(oldStr);
  {
    // The rung runs whenever exact found nothing — normalizing the FILE may
    // match a straight-quoted needle (and vice versa); the needle alone tells
    // us nothing about whether normalization can help.
    const quoteHits = occurrences(normalizedContent, normalizedNeedle, !replaceAll);
    if (!replaceAll && quoteHits.length > 1) {
      return { error: `old_string is not unique in this file after quote normalization (${quoteHits.length} matches) — add surrounding context lines until it is unique` };
    }
    if (quoteHits.length >= 1) return { level: "quote-normalized", starts: quoteHits, length: normalizedNeedle.length };
  }

  // ω99-4a rung 4 — blank-line relaxation (aider strip_blank_lines :611-614,
  // the (True, False, False) row of all_preprocs :527-541). Runs BEFORE the
  // trim rung: stripping only whole blank lines removes strictly less than
  // oldStr.trim(), so this is the tighter normalization and must claim the
  // match first (after the trim it could never fire — every blank-line-
  // stripped hit is also a trimmed hit: R = A + T + B with A/B whitespace, so
  // R in content implies T in content). Multi-line needles only: a single-
  // line needle's boundary newline is a trailing newline on a content line,
  // not a blank line — that case stays pinned to whitespace-tolerant. The
  // replacement is stripped the same way (aider strips the triple).
  {
    const stripped = stripBoundaryBlankLines(oldStr);
    if (stripped !== oldStr && stripped !== "" && stripped.includes("\n")) {
      const blankHits = occurrences(content, stripped, !replaceAll);
      if (!replaceAll && blankHits.length > 1) {
        return { error: `old_string is not unique in this file after blank-line relaxation (${blankHits.length} matches) — add surrounding context lines until it is unique` };
      }
      if (blankHits.length >= 1) {
        return { level: "blank-line-relaxed", starts: blankHits, length: stripped.length, replacement: stripBoundaryBlankLines(newStr) };
      }
    }
  }

  if (!replaceAll) {
    const trimmed = oldStr.trim();
    if (trimmed !== oldStr && trimmed !== "") {
      const trimHits = occurrences(content, trimmed, true);
      if (trimHits.length > 1) {
        return { error: `old_string is not unique in this file after trimming whitespace (${trimHits.length} matches) — add surrounding context lines until it is unique` };
      }
      if (trimHits.length === 1) return { level: "whitespace-tolerant", starts: trimHits, length: trimmed.length };
    }
    // ω99-4a rung 5 — indent-relative uniform shift, single-replacement only
    // (replace_all deliberately skips it: mass-applying a guessed re-indent
    // must never happen silently).
    const rel = findIndentRelative(content, oldStr, newStr);
    if (rel !== undefined) return rel;
    return { error: notFoundError(content, oldStr) };
  }
  return { error: notFoundError(content, oldStr) };
}

// ω99-4a rung 5 — indent-relative uniform shift. RelativeIndenter (aider
// :18-100) ENCODES relative indents with a marker + make_absolute round-trip
// because its consumer is a dmp fuzzy apply; the wudao rung only needs
// detect-and-apply of a UNIFORM whole-block shift, so lines are compared with
// leading [ \t] stripped instead (strictly more conservative — see header).
// Undefined = no hit (fall through to the not-found teaching error); an
// ambiguity at this rung is a hard error like every other rung.
const LINE_INDENT = /^[ \t]*/;
/** The leading [ \t] run of a line. */
const indentOf = (line: string): string => LINE_INDENT.exec(line)![0];
/** The line with its leading [ \t] run removed. */
const stripLineIndent = (line: string): string => line.replace(/^[ \t]*/, "");

function findIndentRelative(content: string, oldStr: string, newStr: string): MatchOutcome | { error: string } | undefined {
  // Needle-side preproc = rung 4's strip first (aider all_preprocs (True,
  // True, False) order: strip blank lines, THEN compare indents). A
  // single-line needle has no block to shift.
  const needle = stripBoundaryBlankLines(oldStr);
  if (needle === "" || !needle.includes("\n")) return undefined;
  const needleLines = needle.split("\n");
  // The baseline is the FIRST non-blank needle line (a leading blank line
  // says nothing about indentation).
  const baseIdx = needleLines.findIndex((l) => l.trim() !== "");
  if (baseIdx === -1) return undefined; // all-blank needle: nothing relative
  const fileLines = content.split("\n");
  const k = needleLines.length;

  // Sliding window of k consecutive file lines; every line must agree after
  // indent-stripping. stripLineIndent equality already implies blankness
  // agreement, and interior blank lines must correspond 1:1 (the window has
  // exactly k lines): two needle blank lines never match one file blank
  // line. First/last lines demand full-line alignment — a file line with
  // extra content (`bar(); // c` vs `bar();`) fails the stripped equality.
  const hits: number[] = [];
  for (let i = 0; i + k <= fileLines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < k; j += 1) {
      if (stripLineIndent(fileLines[i + j]!) !== stripLineIndent(needleLines[j]!)) { ok = false; break; }
    }
    if (ok) hits.push(i);
  }
  if (hits.length === 0) return undefined;
  if (hits.length > 1) {
    return { error: `old_string is not unique in this file after indent-relative matching (${hits.length} matches) — add surrounding context lines until it is unique` };
  }

  // Uniform shift: N = baseline needle indent, F = the matched file block's
  // indent at the same line. Both must be same-kind (all spaces or all tabs;
  // the empty baseline accepts either) — tab-vs-space declines the rung
  // rather than silently retabbing the file.
  const i = hits[0]!;
  const N = indentOf(needleLines[baseIdx]!);
  const F = indentOf(fileLines[i + baseIdx]!);
  const kind = (s: string): "empty" | "space" | "tab" | "mixed" =>
    s === "" ? "empty" : /^ +$/.test(s) ? "space" : /^\t+$/.test(s) ? "tab" : "mixed";
  const nk = kind(N);
  const fk = kind(F);
  if (fk === "mixed" || (nk === "space" && fk !== "space") || (nk === "tab" && fk !== "tab")) return undefined;

  // Re-indent new_string by the same delta: every NON-blank line must carry
  // the N prefix (F + L.slice(N.length)); one violation bails the whole rung
  // — partially-shifted output would corrupt the relative structure the
  // model actually wrote. Blank lines pass through untouched. N = "" (the
  // common case: a nested block written at column 0) degenerates to
  // prefixing F onto every line verbatim.
  const outLines: string[] = [];
  for (const L of newStr.split("\n")) {
    if (stripLineIndent(L) === "") { outLines.push(L); continue; }
    if (!indentOf(L).startsWith(N)) return undefined; // conservative bail
    outLines.push(F + L.slice(N.length));
  }

  // Byte span in the ORIGINAL file: first matched line's start → last
  // matched line's end (the trailing newline is not consumed), so
  // applyReplacements swaps exactly the block.
  let start = 0;
  for (let x = 0; x < i; x += 1) start += fileLines[x]!.length + 1;
  let end = start;
  for (let x = i; x < i + k; x += 1) end += fileLines[x]!.length + 1;
  end -= 1;
  return { level: "indent-relative", starts: [start], length: end - start, replacement: outLines.join("\n") };
}

function notFoundError(content: string, oldStr: string): string {
  const closest = findClosestLine(content, oldStr);
  const tried = "tried exact, quote-normalized, blank-line-relaxed, whitespace-tolerant and indent-relative matching";
  if (closest === undefined) {
    return `old_string not found in this file (${tried}) — re-read the file and copy the text exactly`;
  }
  return [
    `old_string not found in this file (${tried}). Closest candidate (around line ${closest}):`,
    numberedSnippet(content, closest),
    "Re-read the file and copy the text exactly, or widen old_string with surrounding lines.",
  ].join("\n");
}

function applyReplacements(content: string, starts: readonly number[], length: number, replacement: string): string {
  let out = "";
  let cursor = 0;
  for (const s of starts) {
    out += content.slice(cursor, s) + replacement;
    cursor = s + length;
  }
  return out + content.slice(cursor);
}

function splitLines(content: string): string[] {
  const parts = content.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** `NNN→ text` numbered snippet of ±context lines around a 1-based line. */
export function numberedSnippet(content: string, centerLine: number, context: number = SNIPPET_CONTEXT): string {
  const lines = splitLines(content);
  if (lines.length === 0) return "(empty file)";
  const start = Math.max(1, centerLine - context);
  const end = Math.min(lines.length, centerLine + context);
  const width = String(end).length;
  const rows: string[] = [];
  for (let n = start; n <= end; n += 1) {
    rows.push(`${String(n).padStart(width)}→ ${lines[n - 1] ?? ""}`);
  }
  return rows.join("\n");
}

/** Closest-candidate locator for the not-found error: slide a window the size
 *  of old_string over the file and score shared words (bag intersection).
 *  First-best wins (deterministic). Large files only score windows whose first
 *  line shares a word with old_string — the scan must not go quadratic. */
function findClosestLine(content: string, needle: string): number | undefined {
  const lines = splitLines(content);
  if (lines.length === 0) return undefined;
  const windowSize = Math.max(1, Math.min(splitLines(needle).length, lines.length));
  const words = (s: string): string[] => s.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  const needleWords = new Set(words(needle));
  if (needleWords.size === 0) return 1;
  const lineWords = lines.map((l) => new Set(words(l)));
  const starts: number[] = [];
  const fullScan = lines.length * windowSize <= 250_000;
  for (let i = 0; i < lines.length; i += 1) {
    if (i + windowSize > lines.length) break;
    if (fullScan || i === 0 || [...needleWords].some((w) => lineWords[i]?.has(w))) starts.push(i);
  }
  if (starts.length === 0) starts.push(0);
  let bestScore = -1;
  let bestLine = 1;
  for (const start of starts) {
    const bag = new Set<string>();
    for (let i = start; i < start + windowSize; i += 1) {
      for (const w of lineWords[i] ?? []) bag.add(w);
    }
    let score = 0;
    for (const w of needleWords) if (bag.has(w)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      bestLine = start + 1;
    }
  }
  return bestLine;
}

/** 1-based line number of a character offset. */
function lineOfOffset(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

export function createEditTool(options: {
  workspaceRoot: string;
  readState?: ReadStateTable;
  history?: FileHistory;
  /** 夜移 032 (codex turn-diff): the per-run net-change ledger; recorded
   *  after a committed edit. Absent → unchanged behavior. */
  turnDiff?: TurnDiffTracker;
  /** M46 §1: post-edit syntax verification over the UPDATED content (same
   *  semantics as write_file's seam — receipts ride the result, feedback not
   *  veto). Absent → the pre-M46 result. */
  writeVerify?: WriteVerifyConfig;
  /** M51 §2: diagnostic baseline-diff (new-only lines ride the result after
   *  the verify output). Absent → the M46 result unchanged. */
  diagnostics?: DiagnosticsLayer;
  /** 借鉴弧 ζ1: 陈旧未决写拒绝（write_file 同款——同一目标的未决写悬着且
   *  未重新读过时拒不同指纹的盲写；fail-open）。 */
  pendingWrites?: PendingWriteGate;
}) {
  return buildTool({
    name: "edit",
    promptSnippet: "exact string replacement in a file",
    promptGuidelines: [
      "old_string must be unique; copy it from a read_file result, never from memory.",
    ],
    description:
      "Replace text in a file. old_string must match the file exactly and be unique; smart quotes are normalized and leading/trailing whitespace tolerated when that yields exactly ONE match. Extra blank lines around old_string and whole-block indentation-level differences are tolerated (again only on a unique match). Fails with 'file changed since your last read' when the file changed externally after your last read_file — re-read it first. Pass replace_all: true to replace every exact occurrence instead of requiring uniqueness. " +
      "Example: {path: 'src/api.ts', old_string: 'const TIMEOUT = 30;', new_string: 'const TIMEOUT = 60;'}. " +
      "Do NOT use edit to create a file (write_file) or to move/rename one (edit content, never paths), and never type old_string from memory — copy it from a read_file result so the match is real.",
    // M51 §3: mutates disk (destructive: true), closed-world.
    isDestructive: () => true,
    isOpenWorld: () => false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path inside the workspace." },
        old_string: { type: "string", description: "Text to replace — copy it exactly from the file." },
        new_string: { type: "string", description: "Replacement text." },
        replace_all: { type: "boolean", description: "Replace every occurrence (exact matching only) instead of requiring a unique match. Default false." },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
    async execute({ path, old_string, new_string, replace_all }) {
      const resolved = await resolveWorkspacePath(options.workspaceRoot, path as string);
      if (!resolved.ok) return { content: resolved.error, isError: true };
      const oldStr = old_string as string;
      const newStr = new_string as string;
      const replaceAll = replace_all === true;
      try {
        const content = await readFile(resolved.absPath, "utf8");
        const before = await stat(resolved.absPath);

        // Freshness gate (fail-closed): the edit applies only to the bytes the
        // session last saw. edit holds the current content anyway, so mtime
        // AND content hash are both checked.
        const stale = freshnessError(options.readState, resolved.absPath, before.mtimeMs, content);
        if (stale !== undefined) return { content: `edit failed: ${stale}`, isError: true };

        // 借鉴弧 ζ1: 陈旧未决写拒绝——freshness 的姊妹门（write_file 同款；
        // edit 的 old_string 正是「以为文件是什么样」的凭据，盲打在悬而未决
        // 的写之后正是本门要拦的形状）。
        const pendingBlock = options.pendingWrites?.staleFor("edit", path as string, { path, old_string: oldStr, new_string: newStr, replace_all: replaceAll }, resolved.absPath);
        if (pendingBlock !== undefined) return { content: `edit failed: ${pendingBlock}`, isError: true };

        const outcome = findMatch(content, oldStr, newStr, replaceAll);
        if ("error" in outcome) return { content: `edit failed: ${outcome.error}`, isError: true };

        // M37 §2: snapshot the pre-edit bytes (already in hand) right before
        // the write lands. Fail-open — the edit itself is never blocked.
        if (options.history !== undefined) {
          try {
            await options.history.record(resolved.absPath, true, content, before.mtimeMs, "edit");
          } catch {
            // no rewind coverage for this step — the edit still proceeds
          }
        }

        // ω99-4a: normalizing rungs carry their own transformed replacement
        // (blank-line triple-strip, indent re-shift); legacy rungs keep
        // applying new_string verbatim.
        const updated = applyReplacements(content, outcome.starts, outcome.length, outcome.replacement ?? newStr);
        // M51 §2: capture the diagnostic baseline BEFORE the bytes land (the
        // layer's checkers read the on-disk pre-edit state). Never blocks.
        await options.diagnostics?.beforeWrite(resolved.absPath).catch(() => {});
        await writeFile(resolved.absPath, updated, "utf8");
        // 夜移 032: the ledger entry — pre-edit bytes are already in hand;
        // only the committed edit is evidence.
        options.turnDiff?.record(resolved.absPath, content, updated);

        // Our own write must not trip the next edit: refresh the entry with
        // the post-write state (only when the session had read the file).
        if (options.readState?.get(resolved.absPath) !== undefined) {
          const after = await stat(resolved.absPath);
          options.readState.record(resolved.absPath, readStateEntry(updated, after.mtimeMs));
        }

        const firstStart = outcome.starts[0] ?? 0;
        const line = lineOfOffset(updated, firstStart);
        const countNote = replaceAll ? `, ${outcome.starts.length} replacement${outcome.starts.length === 1 ? "" : "s"}` : "";
        const base = `edited ${path} (match: ${outcome.level}${countNote})\n${numberedSnippet(updated, line)}`;
        // M46 §1: verify the post-edit bytes (same seam/semantics as
        // write_file — feedback leads on failure, never isError).
        if (options.writeVerify === undefined) return { content: base };
        const verified = await verifyWrittenFile({
          absPath: resolved.absPath,
          content: updated,
          workspaceRoot: options.workspaceRoot,
          config: options.writeVerify,
        });
        // M51 §2: fold the NEW-only diagnostic lines in after the verify output.
        const newOnly = options.diagnostics !== undefined
          ? await options.diagnostics.afterWrite({ absPath: resolved.absPath, outcome: verified }).catch(() => [] as const)
          : [];
        return { content: appendDiagnosticsLines(shapeVerifiedResult(base, verified), newOnly) };
      } catch (err) {
        return { content: `edit failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  });
}
