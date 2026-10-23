// 121 §1 续章（codex history/notes 三仓收敛的第二面）— the model-side
// PROACTIVE-SAVE surface over long-task knowledge. search_history (the same
// mining's first face) lets the model RETRIEVE what compaction swallowed, but
// retrieval needs the model to remember to look; the missing half is the
// deliberate save: key conclusions / decisions / intermediate data written
// down AT THE MOMENT they are learned, so a post-compaction lookup has a
// curated, tag-indexed corpus to hit instead of raw transcript noise.
//
//   · storage = PLAIN FILES under <workspace>/.wudao/notes/<sessionId>/ —
//     one markdown file per note, named <timestamp>-<slug>.md. Append-only:
//     a note is never rewritten or deleted by the tool (each write creates a
//     NEW file); the session-scoped directory rides the same .wudao runtime-
//     data convention as notebooks/ and sessions/ (plan.md law: .wudao is
//     harness runtime data, not user files). Bypass read/write of plain files
//     — ZERO kernel changes, zero new persisted formats, user-inspectable.
//   · M24 discipline: the tool DEFINITIONS joining the tools list is ONE
//     declared cross-version cold point (append-only tail beside the
//     retrieval family — session_result / search_history; never a
//     mid-session change). The note FILES never enter model context by
//     themselves — note_read is the only door (按需读取).
//   · note_write: content (required) + tag (optional, classification key).
//     Auto-stamps timestamp + session attribution; receipt is ONE line.
//     Permission posture: the WRITE face — deliberately NOT in any
//     auto-allow roster (ask in workspace mode by the fail-closed default).
//   · note_read: tag filter + limit (default 10, capped at 50), NEWEST
//     FIRST, honest truncation under a total-char budget. Read class
//     (READ_TOOLS in the CLI layer).
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildTool } from "../tool.js";
import type { Tool, ToolParameterSchema } from "../tool.js";

/** Max chars of one note's content (fail-closed typed error above — notes
 *  are key conclusions, not documents). */
export const NOTE_CONTENT_MAX_CHARS = 4000;
/** Default max notes returned per note_read call. */
export const NOTES_LIMIT_DEFAULT = 10;
/** Hard note-count ceiling per call (帽 50 — an over-ask clamps, never errors). */
export const NOTES_LIMIT_MAX = 50;
/** Total content budget of one note_read reply (chars over all returned
 *  notes; the list stops with an honest truncated flag beyond it). */
export const NOTES_READ_TOTAL_MAX_CHARS = 16_000;
/** Max chars of the slug derived from the note's first line. */
export const NOTE_SLUG_MAX_CHARS = 24;

/** Tags become match keys inside the file metadata line — fail-closed
 *  charset: no quotes/angle brackets (they would break the comment attr),
 *  no newlines; 1-64 chars. */
const NOTE_TAG_RE = /^[^\n\r"'<>]{1,64}$/;

/** Slug charset: ASCII alphanumerics + hyphen/underscore. Non-ASCII (CJK)
 *  content slugs to empty and falls back to "note" — the timestamp prefix
 *  already makes the file name unique. */
const SLUG_CHAR_RE = /[A-Za-z0-9_-]/;

/** Derive the file-name slug from the note content: first non-empty line,
 *  ASCII-safe chars kept (others collapse to hyphens), trimmed of
 *  leading/trailing hyphens, capped at NOTE_SLUG_MAX_CHARS; "note" when
 *  nothing survives. Pure. */
export function noteSlugOf(content: string): string {
  const firstLine = content.split("\n", 1)[0] ?? "";
  let slug = "";
  for (const ch of firstLine) {
    slug += SLUG_CHAR_RE.test(ch) ? ch : "-";
  }
  slug = slug.replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, NOTE_SLUG_MAX_CHARS).replace(/-+$/g, "");
  return slug === "" ? "note" : slug;
}

/** Timestamp file-name prefix: UTC, compact, lexically sortable —
 *  YYYYMMDDTHHMMSSmmmZ (17 chars; lexical order == time order). */
export function noteTimestampName(atMs: number): string {
  const d = new Date(atMs);
  const p = (n: number, w: number): string => String(Math.abs(n)).padStart(w, "0");
  return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1, 2)}${p(d.getUTCDate(), 2)}` +
    `T${p(d.getUTCHours(), 2)}${p(d.getUTCMinutes(), 2)}${p(d.getUTCSeconds(), 2)}${p(d.getUTCMilliseconds(), 3)}Z`;
}

/** The note's file name: <timestamp>-<slug>.md. Pure. */
export function noteFileName(atMs: number, slug: string): string {
  return `${noteTimestampName(atMs)}-${slug}.md`;
}

export interface ParsedNoteFileName {
  /** ISO timestamp recovered from the file-name prefix. */
  readonly at: string;
  readonly slug: string;
}

/** Read side of the file name: strict shape gate (anything else is not a
 *  note file and the directory scan skips it); returns undefined on a
 *  mismatch, never throws. */
export function parseNoteFileName(name: string): ParsedNoteFileName | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-(.+)\.md$/.exec(name);
  if (m === null) return undefined;
  const [, y, mo, d, h, mi, s, ms, slug] = m as unknown as [string, string, string, string, string, string, string, string, string];
  const at = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms)));
  if (Number.isNaN(at.getTime())) return undefined;
  return { at: at.toISOString(), slug };
}

/** The file body: an invisible-to-renderers metadata comment (timestamp +
 *  optional tag; the session attribution is the DIRECTORY) then the content.
 *  Pure. */
export function noteFileBody(atIso: string, tag: string | undefined, content: string): string {
  const meta = tag !== undefined
    ? `<!-- wudao-note at="${atIso}" tag="${tag}" -->`
    : `<!-- wudao-note at="${atIso}" -->`;
  return `${meta}\n${content}`;
}

/** Parse a note file's body: the metadata line when it matches (tag
 *  extracted), the rest is content. A body without the metadata line reads
 *  whole-as-content with no tag (fail-open read — a hand-edited file stays
 *  readable, never an error). Pure. */
export function parseNoteBody(text: string): { readonly at?: string; readonly tag?: string; readonly content: string } {
  const m = /^<!-- wudao-note at="([^"]+)"(?: tag="([^"]+)")? -->\n/.exec(text);
  if (m === null) return { content: text };
  return { at: m[1], ...(m[2] !== undefined ? { tag: m[2] } : {}), content: text.slice(m[0].length) };
}

/** One listed note (note_read's hit unit). */
export interface NoteRecord {
  readonly file: string;
  /** ISO from the file-name timestamp (the append-only ordering key). */
  readonly at: string;
  readonly tag?: string;
  readonly content: string;
}

/** The note_read result header (rendered as the output's first JSON line). */
export interface NoteListHeader {
  readonly tag?: string;
  /** The EFFECTIVE limit (after the 帽-50 clamp). */
  readonly limit: number;
  /** Present only when the caller's limit was clamped down to the cap. */
  readonly limit_clamped?: boolean;
  /** Notes matching the tag filter (before limit AND budget cuts). */
  readonly matches: number;
  readonly returned: number;
  /** True when the total-char budget cut the list short of `limit`. */
  readonly truncated: boolean;
}

/** Pure listing over parsed notes: exact-tag filter (absent = all), NEWEST
 *  FIRST (at descending — the file-name order), limit clamp, and the honest
 *  total-char budget stop. Pure. */
export function listNotes(
  notes: readonly NoteRecord[],
  opts?: { readonly tag?: string; readonly limit?: number },
): { header: NoteListHeader; notes: readonly NoteRecord[] } {
  const tag = opts?.tag;
  if (tag !== undefined && (typeof tag !== "string" || tag === "")) {
    throw new Error("note_read: tag, when given, must be a non-empty string");
  }
  if (opts?.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
    throw new Error(`note_read: limit must be an integer ≥ 1 (got ${String(opts.limit)})`);
  }
  const limitClamped = opts?.limit !== undefined && opts.limit > NOTES_LIMIT_MAX;
  const limit = limitClamped ? NOTES_LIMIT_MAX : (opts?.limit ?? NOTES_LIMIT_DEFAULT);
  const matching = (tag === undefined ? [...notes] : notes.filter((n) => n.tag === tag))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : (a.file < b.file ? 1 : -1)));
  const out: NoteRecord[] = [];
  let budget = NOTES_READ_TOTAL_MAX_CHARS;
  let truncated = false;
  for (const n of matching) {
    if (out.length >= limit) break;
    if (n.content.length > budget) {
      truncated = true; // honest stop: the budget ran out before the limit
      break;
    }
    budget -= n.content.length;
    out.push(n);
  }
  return {
    header: {
      ...(tag !== undefined ? { tag } : {}),
      limit,
      ...(limitClamped ? { limit_clamped: true } : {}),
      matches: matching.length,
      returned: out.length,
      truncated: truncated || matching.length > out.length, // the limit cut or the budget cut — either way the list is short of the matches
    },
    notes: out,
  };
}

/** The seam the frontends wire: where notes live (the boot workspace root —
 *  session-anchored, agent-root switches do not move it) and the LIVE
 *  session id (resolved per call, the search_history loader law). */
export interface NotesToolOptions {
  readonly workspaceRoot?: string;
  readonly sessionId: () => string;
  readonly now?: () => number;
}

const WRITE_PARAMETERS: ToolParameterSchema = {
  type: "object",
  properties: {
    content: { type: "string", description: `the note itself: a finding, decision, or intermediate datum worth keeping. 1-${NOTE_CONTENT_MAX_CHARS} chars. First line becomes the file name's slug.` },
    tag: { type: "string", description: "optional classification key (1-64 chars, no quotes/newlines) — note_read filters on it, e.g. \"finding\" / \"decision\" / \"data\"" },
  },
  required: ["content"],
  additionalProperties: false,
};

const READ_PARAMETERS: ToolParameterSchema = {
  type: "object",
  properties: {
    tag: { type: "string", description: "only notes saved with this exact tag (omit for all tags)" },
    limit: { type: "number", description: `max notes to return (default ${NOTES_LIMIT_DEFAULT}, capped at ${NOTES_LIMIT_MAX}); results are newest-first, check "truncated" in the header` },
  },
  additionalProperties: false,
};

const noteDir = (workspaceRoot: string | undefined, sessionId: string): string =>
  join(workspaceRoot ?? "", ".wudao", "notes", sessionId);

/** The persistent-notes pair — note_write (append) + note_read (list).
 *  Both are session-scoped: writes land under
 *  <workspace>/.wudao/notes/<sessionId>/, reads list that same directory
 *  (sidechains and other sessions are separate directories this pair never
 *  touches). note_write is NOT concurrency-safe-ordered against itself by
 *  any lock, but each write creates a NEW uniquely-named file (wx-flag
 *  create, collision-suffixed) — concurrent appends never overwrite. */
export function createNotesTools(options: NotesToolOptions): Tool[] {
  const now = options.now ?? Date.now;
  const dirFor = (): { dir: string; fail: string } => {
    const sid = options.sessionId();
    if (options.workspaceRoot === undefined || typeof sid !== "string" || sid === "") {
      return { dir: "", fail: "note tools: 该前端未接线 workspace 根或会话 id——笔记面不可用（fail-closed）" };
    }
    return { dir: noteDir(options.workspaceRoot, sid), fail: "" };
  };

  const noteWrite: Tool = buildTool({
    name: "note_write",
    description:
      "长任务中的重要发现、决策、中间数据——写下笔记确保压缩后仍可查回。每条笔记是一个独立 markdown 文件（本会话目录 .wudao/notes/ 下，时间戳命名，只增不改），自动记录时间与会话归属；可选 tag 供 note_read 分类检索。上下文压缩不会碰这些文件。写给「未来的自己」：一条笔记一个要点，先结论后细节。",
    parameters: WRITE_PARAMETERS,
    isReadOnly: () => false,
    isConcurrencySafe: () => true, // each write creates a new file (wx-create); never overwrites
    isDestructive: () => false,
    async execute(args) {
      const content = args["content"];
      if (typeof content !== "string" || content.trim() === "") {
        return { content: "note_write: content must be a non-empty string", isError: true };
      }
      if (content.length > NOTE_CONTENT_MAX_CHARS) {
        return { content: `note_write: content exceeds the ${NOTE_CONTENT_MAX_CHARS}-char note cap (got ${content.length}) — split into multiple notes`, isError: true };
      }
      const tag = args["tag"];
      if (tag !== undefined && (typeof tag !== "string" || !NOTE_TAG_RE.test(tag))) {
        return { content: `note_write: tag, when given, must be 1-64 chars without quotes/angle-brackets/newlines (got ${JSON.stringify(tag)})`, isError: true };
      }
      const { dir, fail } = dirFor();
      if (fail !== "") return { content: fail, isError: true };
      const atMs = now();
      const atIso = new Date(atMs).toISOString();
      const slug = noteSlugOf(content);
      await mkdir(dir, { recursive: true });
      // Append-only by construction: exclusive create (wx); a same-millisecond
      // collision with the same slug takes a numeric suffix, never an overwrite.
      let fileName = noteFileName(atMs, slug);
      for (let i = 2; ; i += 1) {
        try {
          await writeFile(join(dir, fileName), noteFileBody(atIso, tag, content), { encoding: "utf8", flag: "wx" });
          break;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "EEXIST") {
            return { content: `note_write: 保存笔记失败 — ${err instanceof Error ? err.message : String(err)}`, isError: true };
          }
          if (i > 32) {
            return { content: "note_write: 保存笔记失败 — 同毫秒同名碰撞超过上限（wx 重试 32 次）", isError: true };
          }
          fileName = `${noteFileName(atMs, slug).slice(0, -3)}-${i}.md`;
        }
      }
      return { content: `已保存笔记${tag !== undefined ? ` [${tag}]` : ""}（${fileName}）` };
    },
  });

  const noteRead: Tool = buildTool({
    name: "note_read",
    description:
      "读取本会话已保存的笔记（note_write 写下的），时间倒序、带 tag 与全文。长任务被上下文压缩后，用这个工具查回之前主动保存的发现/决策/中间数据——比 search_history 更准：笔记是当时提炼过的结论，不是原始对话。按 tag 过滤可缩小范围；上限由 limit 控制。",
    parameters: READ_PARAMETERS,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(args) {
      const tag = args["tag"];
      if (tag !== undefined && (typeof tag !== "string" || tag === "")) {
        return { content: "note_read: tag, when given, must be a non-empty string", isError: true };
      }
      const limit = args["limit"] === undefined ? NOTES_LIMIT_DEFAULT : Number(args["limit"]);
      if (!Number.isInteger(limit) || limit < 1) {
        return { content: `note_read: limit must be an integer ≥ 1 (got ${String(args["limit"])})`, isError: true };
      }
      const { dir, fail } = dirFor();
      if (fail !== "") return { content: fail, isError: true };
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        return {
          content: `没有笔记（本会话尚未写过笔记——用 note_write 保存长任务中的发现/决策/中间数据）`,
        };
      }
      const records: NoteRecord[] = [];
      for (const f of files) {
        const parsedName = parseNoteFileName(f);
        if (parsedName === undefined) continue; // not a note file — skip honestly
        let text: string;
        try {
          text = await readFile(join(dir, f), "utf8");
        } catch {
          continue; // unreadable file (racing write, permissions) — skip, never fail the listing
        }
        const body = parseNoteBody(text);
        records.push({
          file: f,
          at: body.at !== undefined ? body.at : parsedName.at,
          ...(body.tag !== undefined ? { tag: body.tag } : {}),
          content: body.content,
        });
      }
      try {
        const { header, notes } = listNotes(records, { ...(tag !== undefined ? { tag } : {}), limit });
        const body =
          notes.length === 0
            ? `没有匹配的笔记${tag !== undefined ? `（tag ${JSON.stringify(tag)}）` : ""}——本会话共 ${records.length} 条`
            : notes.map((n) => JSON.stringify(n)).join("\n");
        return { content: `${JSON.stringify(header)}\n${body}` };
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }
    },
  });

  return [noteWrite, noteRead];
}
