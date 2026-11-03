// M33 §3 — resume polish: session naming (a kebab-case short name derived
// from the first user message, stored as a `session_name` JSONL entry), the
// --list-sessions table (id · mtime · messages · first-user-50 · model ·
// name), and the data the TUI /resume picker renders. Pure derivation +
// read-only collection; the only writes are ensureSessionName's append-once
// and M58's workspace_root re-point.
// M58 §C#7 — the worktree filter: every session records the workspaceRoot it
// runs under (generic `workspace_root` entry, append-only, last-wins). When
// the CLI starts inside a git worktree, the session lists (--list-sessions,
// the /resume picker, driver.sessions) default to sessions whose recorded
// root matches THIS worktree; `--all` lifts the filter. Sessions without a
// recorded root (pre-M58 files, forks of them) are unattributable and stay
// visible under every filter.
import { truncateSafe } from "@wudao-org/core"; // 113-A4
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createJsonlSessionStore, type AgentMessage, type SessionEntry, type SessionStore } from "@wudao-org/core";
import { lastModelState } from "./run.js";
import { hardenedGitArgs } from "./git-hardened.js";
import { truncate } from "./log.js";
import { parseAllFlag } from "./args.js";

const execFileAsync = promisify(execFile);

const NAME_MAX_CHARS = 48;
const NAME_MAX_WORDS = 6;

/** Kebab-case short name from a first user message: lowercase, split on any
 *  run of non [a-z0-9 CJK] characters, ≤6 words, ≤48 chars. CJK text has no
 *  separator runs inside a phrase, so a Chinese first message stays one word.
 *  Separator-only input degrades to "session". */
export function deriveSessionName(firstUser: string): string {
  const tokens = firstUser
    .toLowerCase()
    .split(/[^a-z0-9一-鿿]+/)
    .filter((t) => t.length > 0)
    .slice(0, NAME_MAX_WORDS);
  if (tokens.length === 0) return "session";
  const name = tokens.join("-");
  return name.length > NAME_MAX_CHARS ? truncateSafe(name, NAME_MAX_CHARS) : name;
}

// User-role messages the machinery speaks to itself with (same skips as the
// resumed-view projection in tui/resume.ts) — never a human's first question.
function isMarkerUserMessage(content: string): boolean {
  return (
    content.startsWith("[system note:") ||
    content.startsWith("[compacted summary]") ||
    content.startsWith("[todo board") ||
    // 品牌弧补丁（用户令「重开会话多出 language/reasoning 块」）：M47/夜移012
    // 的瞬态指令块是 model-facing（进 state.messages 保前缀字节），历史面
    // 重建时按标记滤除——与 system note 同族。
    content.startsWith("[language:") ||
    content.startsWith("[reasoning-language:")
  );
}

/** The session's first REAL user message (skips markers/notes and non-message
 *  entries); undefined when there is none. */
export function firstUserMessage(entries: readonly SessionEntry[]): string | undefined {
  for (const e of entries) {
    if (!("role" in e)) continue;
    if (e.role !== "user") continue;
    const content = e.content.trim();
    if (content === "" || isMarkerUserMessage(e.content)) continue;
    return e.content;
  }
  return undefined;
}

/** The session's current name entry, if any. */
function sessionName(entries: readonly SessionEntry[]): string | undefined {
  let name: string | undefined;
  for (const e of entries) {
    // M35 §2: generic {type, data} entries share the union — narrow by the
    // typed entry's own field.
    if (!("role" in e) && e.type === "session_name" && "name" in e) name = e.name;
  }
  return name;
}

/** 夜移 005: the current name entry WITH its writer tag (undefined source =
 *  legacy entries predating the tag). Auto-titling reads this to respect a
 *  manual /rename and to avoid re-titling an already-titled session. */
export function sessionNameSource(entries: readonly SessionEntry[]): { name: string; source?: "derived" | "manual" | "llm" } | undefined {
  let found: { name: string; source?: "derived" | "manual" | "llm" } | undefined;
  for (const e of entries) {
    if (!("role" in e) && e.type === "session_name" && "name" in e) {
      const src = "source" in e ? (e.source as "derived" | "manual" | "llm" | undefined) : undefined;
      found = { name: e.name, ...(src !== undefined ? { source: src } : {}) };
    }
  }
  return found;
}

/** Record the session's name once: derives it from the session's own first
 *  user message (or `fallbackText` when the caller knows the prompt before it
 *  lands, e.g. a fresh one-shot run) and appends a `session_name` entry —
 *  unless one already exists (append-once; a later call just reports it).
 *  夜移 005: entries are now tagged source:"derived" (the LLM title upgrade
 *  replaces them; a manual rename never is). */
export async function ensureSessionName(
  store: SessionStore,
  sessionId: string,
  fallbackText?: string,
): Promise<{ name: string; added: boolean } | undefined> {
  const entries = await store.loadSessionEntries(sessionId);
  const existing = sessionName(entries);
  if (existing !== undefined) return { name: existing, added: false };
  const firstUser = firstUserMessage(entries) ?? fallbackText;
  if (firstUser === undefined || firstUser.trim() === "") return undefined;
  const name = deriveSessionName(firstUser);
  await store.appendEntry(sessionId, { type: "session_name", name, source: "derived" });
  return { name, added: true };
}

// ---------------------------------------------------------------------------
// M58 §C#7 — the workspace_root entry + the worktree filter
// ---------------------------------------------------------------------------

/** The generic session-entry type recording where a session runs. */
export const WORKSPACE_ROOT_ENTRY_TYPE = "workspace_root";

/** Append-ready entry for the current workspaceRoot (generic {type,data}). */
export function buildWorkspaceRootEntry(root: string): { type: string; data: { root: string } } {
  return { type: WORKSPACE_ROOT_ENTRY_TYPE, data: { root } };
}

/** The most recent well-formed workspace_root of a loaded entry list (the
 *  last recording wins, like every append-only marker); undefined when the
 *  session never recorded one. Malformed payloads are skipped, never fatal. */
export function recordedWorkspaceRoot(entries: readonly SessionEntry[]): string | undefined {
  let root: string | undefined;
  for (const e of entries) {
    if ("role" in e || e.type !== WORKSPACE_ROOT_ENTRY_TYPE) continue;
    const data = e.data as Partial<{ root: string }> | undefined;
    const r = data?.root;
    if (typeof r === "string" && r !== "") root = r;
  }
  return root;
}

/** Ensure the session's LAST workspace_root entry names the given root:
 *  append-once for a fresh session, re-point (a fresh append — the store is
 *  append-only, the last recording wins) when the session is resumed/forked
 *  from a different directory, no-op when it already matches. */
export async function ensureWorkspaceRootEntry(
  store: SessionStore,
  sessionId: string,
  workspaceRoot: string,
): Promise<void> {
  const entries = await store.loadSessionEntries(sessionId);
  if (recordedWorkspaceRoot(entries) === workspaceRoot) return;
  await store.appendEntry(sessionId, buildWorkspaceRootEntry(workspaceRoot));
}

/** True when the directory lives inside a git worktree. The AUTHORITATIVE
 *  signal is the git probe (--git-dir vs --git-common-dir; a linked
 *  worktree's git dir nests under .git/worktrees/<name> while the common dir
 *  is the main checkout's .git). Review fix (NIT 1): the cheap
 *  <root>/.worktrees/<name> path heuristic no longer short-circuits — any
 *  directory can contain a `.worktrees` segment; the probe decides, and the
 *  heuristic survives only as the FALLBACK when the probe itself cannot run
 *  (git missing / cwd gone), where it is the best evidence available. Any
 *  failure path is fail-closed (false / heuristic), never fatal. */
export async function isInsideWorktree(cwd: string): Promise<boolean> {
  try {
    const probe = async (flag: string): Promise<string> =>
      resolve(cwd, (await execFileAsync("git", hardenedGitArgs(["rev-parse", flag]), { cwd })).stdout.trim());
    const gitDir = await probe("--git-dir");
    const commonDir = await probe("--git-common-dir");
    return gitDir !== "" && commonDir !== "" && gitDir !== commonDir;
  } catch {
    // git unavailable or cwd not probeable — fall back to the path shape.
    return cwd.split(sep).includes(".worktrees");
  }
}

/** The default list filter for a process: inside a worktree → that
 *  worktree's root (sessions recorded under a DIFFERENT root hide);
 *  `--all` (argv) or a plain checkout → undefined (everything listed).
 *  Review fix (NIT 2): the argv default is the EXEC-RELATIVE args
 *  (process.argv.slice(2)) — parseAllFlag's leading-flag window must not
 *  trip over the node/script path tokens. */
export async function defaultSessionListFilter(
  cwd: string,
  argv: readonly string[] = process.argv.slice(2),
): Promise<string | undefined> {
  if (parseAllFlag(argv)) return undefined;
  return (await isInsideWorktree(cwd)) ? cwd : undefined;
}

/** One --list-sessions / /resume-picker row. `name`/`model` empty = absent. */
export interface SessionRow {
  readonly id: string;
  readonly mtime: Date;
  readonly messages: number;
  /** First real user message, whitespace-collapsed, truncated to 50 chars. */
  readonly firstUser: string;
  /** Last recorded model (model_change entries); "" when none. */
  readonly model: string;
  /** The session_name entry's name, when present. */
  readonly name?: string;
  /** ω99-286: #1 — 断点续跑 L1 的行派生位：这个会话有「没跑完的 turn」
   *  （app 退出/崩溃留下的尾部形状）。isUnfinishedTail 的纯函数派生，搭
   *  collectSessionRows 已有的全量读——零额外 IO。 */
  readonly unfinished: boolean;
  /** ω99-289: #1 — 失败重试 L1 的行派生位：这个会话以「跑失败的回合」收
   *  尾（run 错误收束落的合成 "(error: …)" assistant 尾，:3745 单点）。
   *  isErrorTail 的纯函数派生，同一趟读——零额外 IO；与 unfinished 互斥
   *  （错误尾必是 settled assistant 形，两判据的形状自身保证）。 */
  readonly errored: boolean;
}

/** ω99-286（续，标记见上）— 「未完成」判据：会话消息尾部形状的纯函数
 *  （单一真相源是 append-only 日志的形状，不是第二个状态位）。三类中断尾
 *  全真：尾=user（首模型调用前死）/ 尾=assistant 带 toolCalls（工具执行中
 *  死——装载时被 repairOrphanedToolCalls 修补为 UNKNOWN tool_result，修补后
 *  仍落 tool 尾真）/ 尾=tool_result（工具完成后、settle 前死）。settled
 *  assistant 文本尾 → false；空会话 → false。graceful abort 两形也算未完成
 *  （用户主动打断同样提供继续）：夜移 001 的 committed partial 带
 *  interrupted:true，M12 起的合成 "(interrupted)" 哨兵（driver 落盘字面，
 *  repl 同款）。已知边界：错误回合的合成 "(error: …)" 尾读 settled（run
 *  已收束，非断点）；未来新增尾部消息形态须同步此判据——测试四形钉住。
 *  ω99-289（续，标记见上）— 上面的已知边界由姊妹判据 isErrorTail 接手：
 *  本判据零动（错误尾仍读 settled，286 语义原样），失败面走独立的
 *  errored 位（continueSession 错误臂：pop 合成错误后从失败点续跑）。 */
export function isUnfinishedTail(messages: readonly AgentMessage[]): boolean {
  const tail = messages.at(-1);
  if (tail === undefined) return false;
  if (tail.role === "user" || tail.role === "tool") return true;
  if (tail.toolCalls !== undefined && tail.toolCalls.length > 0) return true;
  return tail.interrupted === true || tail.content === "(interrupted)";
}

/** ω99-289（续，标记见上）— 「失败尾」判据：isUnfinishedTail 的姊妹纯函数
 *  （同一真相源——append-only 日志的形状）。尾=assistant、无 toolCalls、
 *  content 以 "(error: " 起（run 错误收束的合成 assistant，agent-driver
 *  :3745 单点 push——M12「永不以 user 尾收场」的产物）→ true。前驱必是
 *  中断形（首腿败→user 尾；工具轮后败→tool_result 尾），continueSession
 *  的错误臂按此防御性复验。false 领地：interrupted 两形（286 的地盘）、
 *  带 toolCalls 的孤儿形、settled 文本尾、user/tool 尾、空会话。 */
export function isErrorTail(messages: readonly AgentMessage[]): boolean {
  const tail = messages.at(-1);
  if (tail === undefined || tail.role !== "assistant") return false;
  if (tail.toolCalls !== undefined && tail.toolCalls.length > 0) return false;
  return typeof tail.content === "string" && tail.content.startsWith("(error: ");
}

const FIRST_USER_CHARS = 50;

// Whitespace-collapsed + truncated to the first 50 chars (a trailing … marks
// the cut, same convention as log.ts truncate).
function collapse(text: string): string {
  return truncate(text, FIRST_USER_CHARS);
}

/** Collect one row per session file, oldest-first (the store's list order —
 *  the same order `--continue` uses to find the most recent). M58 §C#7: a
 *  `filterWorkspaceRoot` hides sessions whose RECORDED root differs (see
 *  defaultSessionListFilter); sessions with no recording stay visible. */
export async function collectSessionRows(
  sessionsDir: string,
  opts: { readonly filterWorkspaceRoot?: string } = {},
): Promise<SessionRow[]> {
  const store = createJsonlSessionStore(sessionsDir);
  const ids = await store.list();
  const rows: SessionRow[] = [];
  for (const id of ids) {
    let mtime = new Date(0);
    try {
      mtime = (await stat(join(sessionsDir, `${id}.jsonl`))).mtime;
    } catch {
      // raced away between list() and stat() — keep the epoch placeholder
    }
    const entries = await store.loadSessionEntries(id);
    if (opts.filterWorkspaceRoot !== undefined) {
      const recorded = recordedWorkspaceRoot(entries);
      if (recorded !== undefined && recorded !== opts.filterWorkspaceRoot) continue;
    }
    const name = sessionName(entries);
    rows.push({
      id,
      mtime,
      messages: entries.filter((e) => "role" in e).length,
      firstUser: collapse(firstUserMessage(entries) ?? ""),
      model: lastModelState(entries).model ?? "",
      ...(name !== undefined ? { name } : {}),
      // ω99-286（续，标记见上）— 未完成位：同一批已读 entries 的尾部形状
      // 派生（消息视图 = 跳过 notice/generic 等非消息 entry 后的角色序）。
      unfinished: isUnfinishedTail(entries.filter((e): e is AgentMessage => "role" in e)),
      // ω99-289（续，标记见上）— 失败位：同一批 entries 的姊妹派生（与
      // unfinished 互斥——错误尾必是 settled assistant 形，判据形状自身保证）。
      errored: isErrorTail(entries.filter((e): e is AgentMessage => "role" in e)),
    });
  }
  return rows;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function two(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// Local time YYYY-MM-DD HH:mm — mtime is for human scanning, not sorting.
function formatMtime(d: Date): string {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** The --list-sessions table: aligned columns, a header row, oldest-first. */
export function formatSessionTable(rows: readonly SessionRow[]): string {
  if (rows.length === 0) return "(no sessions)\n";
  const idW = Math.max(2, ...rows.map((r) => r.id.length));
  const msgW = Math.max(3, ...rows.map((r) => String(r.messages).length));
  const firstW = Math.max(...rows.map((r) => r.firstUser.length), "first user message".length);
  const modelW = Math.max(...rows.map((r) => r.model.length), "model".length);
  const nameW = Math.max(...rows.map((r) => (r.name ?? "").length), "name".length);
  const header = `${pad("id", idW)}  ${pad("modified", 16)}  ${pad("msg", msgW)}  ${pad("first user message", firstW)}  ${pad("model", modelW)}  ${pad("name", nameW)}`;
  const lines = rows.map((r) =>
    `${pad(r.id, idW)}  ${formatMtime(r.mtime)}  ${pad(String(r.messages), msgW)}  ${pad(r.firstUser, firstW)}  ${pad(r.model, modelW)}  ${r.name ?? ""}`,
  );
  return `${header}\n${lines.join("\n")}\n`;
}

/** One numbered picker line for the TUI /resume list (index 1 = newest). */
export function formatResumePickerLine(rank: number, row: SessionRow): string {
  const label = row.name ?? row.firstUser;
  return `${rank}) ${row.id.slice(0, 8)}  ${formatMtime(row.mtime)}  ${row.messages} msg  ${label === "" ? "(empty)" : label}`;
}
