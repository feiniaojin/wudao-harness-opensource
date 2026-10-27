import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { buildTool } from "../tool.js";
import type { AgentMessage } from "../types.js";
import { resolveWorkspacePath } from "./workspace.js";
import { readStateEntry, type ReadStateTable } from "./read-state.js";

// M24 dual cap: the DEFAULT (no explicit limit) read window is the file head,
// 2000 lines / 50KB — whichever fires first. A tail hint tells the model how
// to page the rest with offset=.
const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

/** The read window read_file serves — shared verbatim by the CLI's @-mention
 *  expansion (M34 §2), so a mention carries exactly what a read_file of the
 *  same file would: first `limitLines ?? 2000` lines / 50KB (whichever fires
 *  first), verbatim whole content when it fits, and the same paging hint on
 *  truncation. Pure. */
export function readTextWindow(content: string, offsetLine?: number, limitLines?: number): string {
  // Empty file: nothing to page — return it verbatim.
  if (content === "") return content;

  // Pagination: split without the trailing "" a final newline produces.
  const all = content.split("\n");
  if (all.length > 0 && all[all.length - 1] === "") all.pop();
  const totalLines = all.length;
  const start = offsetLine === undefined ? 0 : offsetLine - 1;
  if (start >= totalLines) {
    throw new Error(`offset ${offsetLine} is beyond the end of the file (${totalLines} line${totalLines === 1 ? "" : "s"})`);
  }

  // Line budget: explicit limit wins over the 2000-line default; the 50KB
  // byte cap ALWAYS applies as the hard ceiling. Always keep at least one
  // line, even if a single line exceeds the cap.
  const lineBudget = limitLines ?? MAX_LINES;
  let taken = 0;
  let bytes = 0;
  while (start + taken < totalLines && taken < lineBudget) {
    const lineLen = Buffer.byteLength(all[start + taken] ?? "", "utf8") + (taken > 0 ? 1 : 0);
    if (taken > 0 && bytes + lineLen > MAX_BYTES) break;
    bytes += lineLen;
    taken += 1;
  }

  const window = all.slice(start, start + taken);
  const remainingLines = totalLines - (start + taken);
  if (remainingLines <= 0) {
    // Full remainder: return it VERBATIM when it is the whole file, so
    // small-file reads stay byte-identical to the pre-pagination tool.
    return start === 0 && taken === totalLines ? content : window.join("\n");
  }
  const remainderBytes = all
    .slice(start + taken)
    .reduce((n, l) => n + l.length + 1, 0);
  const kb = Math.round((remainderBytes / 1024) * 10) / 10;
  return `${window.join("\n")}\n… (${remainingLines} more line${remainingLines === 1 ? "" : "s"} / ${kb} more KB — call again with offset=${start + taken + 1})`;
}

export function createReadFileTool(options?: {
  workspaceRoot?: string;
  /** M24 B1 zero-repeat elision probe: returns the messages currently visible
   *  to the model (cli wires `() => state.messages`). Absent → never elide
   *  (core keeps zero dependencies; the probe is the caller's to provide). */
  contextProbe?: () => readonly AgentMessage[];
  /** M32 §1 read-freshness table: every successful read records what the
   *  session saw (content hash + mtime + line count + diff snapshot). Shared
   *  with edit/write_file (freshness gate) and the external-change prober. */
  readState?: ReadStateTable;
}) {
  // workspace-ux B2: the root is read at EXECUTION time, not captured here —
  // the cli hands the builtin file tools a live-root options object (a getter
  // property) so an agentRootSwitch re-roots mid-session without rebuilding
  // the tool array (identical behavior for every constant-options caller).
  const contextProbe = options?.contextProbe;
  const readState = options?.readState;
  return buildTool({
    name: "read_file",
    description:
      "Read a file as UTF-8 text. By default returns the first 2000 lines (or 50KB) — when the result is truncated it ends with a hint like '… (N more lines / M more KB — call again with offset=<next>)'. Use offset (1-based line number) and limit (line count) to page through larger files. Re-reading content you already have returns a short '[elided]' stub — pass force=true to re-read it anyway (e.g. when the file changed). " +
      "Example: {path: 'src/config.ts'} for a first look; {path: 'debug.log', offset: 1200, limit: 100} to page deep into a long file. " +
      "Do NOT use read_file to test whether a file exists (glob is cheaper), and do NOT re-read bytes an '[elided]' stub says you already have — force=true is only for content that changed on disk.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative file path to read." },
        offset: { type: "number", description: "1-based line number to start reading from (for paging through long files)." },
        limit: { type: "number", description: "Maximum number of lines to return from offset." },
        force: { type: "boolean", description: "Re-read even when the identical content is already in your context (skips elision)." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute({ path, offset, limit, force }) {
      try {
        const positiveInt = (name: string, v: unknown): number | undefined => {
          if (v === undefined) return undefined;
          if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
            throw new Error(`${name} must be a positive integer (got ${String(v)})`);
          }
          return v;
        };
        const offsetLine = positiveInt("offset", offset);
        const limitLines = positiveInt("limit", limit);

        let absPath = path as string;
        const workspaceRoot = options?.workspaceRoot;
        if (workspaceRoot !== undefined) {
          const r = await resolveWorkspacePath(workspaceRoot, path as string);
          if (!r.ok) return { content: `read_file failed: ${r.error}`, isError: true };
          absPath = r.absPath;
        }
        const content = await readFile(absPath, "utf8");

        // M32 §1: a successful read records what the session saw. Every read
        // (windowed or whole-file) observes the full current file, so the
        // entry always describes the whole file, not just the returned window.
        if (readState !== undefined) {
          const st = await stat(absPath).catch(() => undefined);
          if (st !== undefined) readState.record(absPath, readStateEntry(content, st.mtimeMs));
        }

        // Empty file: nothing to page — return it verbatim.
        if (content === "") return { content, provenance: "user-file" };

        // Pagination: split without the trailing "" a final newline produces.
        let out: string;
        try {
          out = readTextWindow(content, offsetLine, limitLines);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { content: `read_file failed: ${message}`, isError: true };
        }

        // B1 zero-repeat elision: the exact bytes we are about to return are
        // already present in the model-visible messages → replace them with a
        // short stub. Compaction naturally breaks presence (old content is
        // stubbed away), which is the intended fallback to full content.
        if (!force && contextProbe && out.length > 0) {
          const present = contextProbe().some((m) => m.content.includes(out));
          if (present) {
            const hash8 = createHash("sha256").update(out).digest("hex").slice(0, 8);
            return {
              content: `[elided] ${path} unchanged — identical content already in your context (pass force=true to re-read; sha256:${hash8})`,
              isError: false,
            };
          }
        }
        // M49 §4: file bytes are USER-PROVIDED content — the result carries
        // the provenance mark (the elided stub above stays unmarked: it is a
        // harness-generated note, not file bytes).
        return { content: out, provenance: "user-file" };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: `read_file failed: ${message}`, isError: true };
      }
    },
  });
}
