// M25 §A1: resumeEntries — the AgentMessage[] → HistoryEntry[] projection for
// a resumed session. The resumed view is an INDEX, not a replay: a divider
// heads the list, each tool turn folds into one entry (no diff/board detail
// re-rendered), and marker/system messages the loop injected for itself drop
// out. Pure: same messages + session id → same entries, so the persisted
// history fully determines the restored view.
import { parseTodoBoard } from "@wudao-org/core";
import type { AgentMessage, SessionEntry, ToolCall, ToolResultMessage } from "@wudao-org/core";
import { truncate } from "../log.js";
import type { HistoryEntry } from "../driver/agent-driver.js";

/** Folded-turn result preview cap (spec: last result, first 80 chars). */
const RESUME_PREVIEW_CHARS = 80;

/** ω99-320: run_stats_receipt `softIdleWarns` 的读侧帽——每条软警告至少
 * 对应一个 ≥ softMs 的静默 gap（设置页最小合法值 1s 量级），1e6 条需要
 * 十一天以上的连续静默；超出即畸形写者载荷（弃字段不弃行，idleReconnects
 * 同形纪律）。 */
const SOFT_IDLE_WARNS_RECEIPT_CAP = 1_000_000;

// User-role messages the machinery speaks to itself with — never a human turn.
// Gate injections ([system note: …]), the tier-2 summary marker
// ([compacted summary] …), and the board restored as a user message after
// compaction ([todo board …](restored)) all skip the resumed view.
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

/** Fold one tool turn (an assistant toolCalls message + its consecutive tool
 *  results). A standalone todo_write turn keeps the board entry (the existing
 *  checklist renderer); everything else collapses to a single tool line. */
function toolTurnEntry(calls: readonly ToolCall[], results: readonly ToolResultMessage[]): HistoryEntry {
  const last = results[results.length - 1];
  if (calls.length === 1 && last !== undefined) {
    const board = parseTodoBoard(last.content);
    if (board) return { kind: "board", done: board.done, total: board.total, lines: board.lines };
  }
  const names = calls.map((c) => c.name);
  return {
    kind: "tool",
    name: names[0] ?? "tool",
    summary: `${calls.length} 个工具：${names.join(",")}`, // ω99-176: #3
    ...(last ? { resultPreview: last.content } : {}), // 审计完整性：resume 重建带全文（显示层披露）
  };
}

/** The resume projection's build state: the view entries plus, per entry, the
 *  1-based file index of the FIRST message it absorbed (the divider precedes
 *  every message → 0). Receipt anchors (118) interleave between entries by
 *  this key: an anchor at message-count N rides after the last entry whose
 *  range starts at ≤ N and before any entry that starts later — i.e. under
 *  the turn that was on screen when the receipt was written, never inside a
 *  LATER turn. A tool turn's folded entry records the index of its opening
 *  assistant toolCalls message (the flush timing must not leak into the
 *  anchor math). */
interface ResumeProjection {
  readonly entries: HistoryEntry[];
  readonly entryStarts: readonly number[];
}

function buildResumeProjection(messages: readonly AgentMessage[], sessionId: string): ResumeProjection {
  if (messages.length === 0) return { entries: [], entryStarts: [] };
  const out: HistoryEntry[] = [
    { kind: "divider", text: `已恢复 ${sessionId.slice(0, 8)} · ${messages.length} 条消息` }, // ω99-172: #5（divider——投影视图专用，不进 JSONL、不模型可见，见弧报告）
  ];
  const starts: number[] = [0];

  // A tool turn accumulates here: the assistant's toolCalls + every consecutive
  // tool result, flushed into ONE entry when the turn ends.
  let calls: ToolCall[] | null = null;
  let results: ToolResultMessage[] = [];
  let foldStart = 0; // 1-based index of the fold's opening assistant message
  const flush = (): void => {
    if (calls) {
      out.push(toolTurnEntry(calls, results));
      starts.push(foldStart);
    }
    calls = null;
    results = [];
  };

  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i]!;
    const msgIndex = i + 1; // 1-based file position
    if (m.role === "tool") {
      // An orphan result (its call predates the loaded span) folds into nothing.
      if (calls) results.push(m);
      continue;
    }
    flush();
    if (m.role === "user") {
      // M79b: image refs survive the projection — the resumed view re-renders
      // a turn's images from the durable pointers (bytes never enter the log).
      // ω99-55: file blocks ride along the same way (content-addressed
      // pointers; the view renders name+size chips from them).
      if (!isMarkerUserMessage(m.content)) {
        out.push({ kind: "user", text: m.content, ...(m.images !== undefined && m.images.length > 0 ? { images: m.images } : {}), ...(m.files !== undefined && m.files.length > 0 ? { files: m.files } : {}) });
        starts.push(msgIndex);
      }
      continue;
    }
    if (m.toolCalls && m.toolCalls.length > 0) {
      calls = [...m.toolCalls];
      results = [];
      foldStart = msgIndex;
    } else {
      out.push({ kind: "assistant", text: m.content });
      starts.push(msgIndex);
    }
  }
  flush();
  return { entries: out, entryStarts: starts };
}

/** Project resumed session messages into initial TUI history entries. */
export function resumeEntries(messages: readonly AgentMessage[], sessionId: string): HistoryEntry[] {
  return buildResumeProjection(messages, sessionId).entries;
}

// 118 报障修复（回合收据堆底）：resume 的交错读侧——收据不再尾部追加，而是
// 按 JSONL 文件序插到各自回合的消息之后。锚点语义：afterMessageIndex = 该收据
// 条目在文件里之前出现的消息条目数（role 携带者计数）；交错 walk 以
// entryStarts 为键——收据落在「吸收了它的锚点消息的那条视图条目」之后、下一条
// 视图条目之前。同锚点多枚收据保持文件相对序（walk 稳定推进）。纯函数：同
// messages + 同 anchors → 同 entries。
export function resumeEntriesAnchored(
  messages: readonly AgentMessage[],
  sessionId: string,
  anchors: readonly ReceiptAnchor[],
): HistoryEntry[] {
  const { entries, entryStarts } = buildResumeProjection(messages, sessionId);
  if (anchors.length === 0) return entries;
  const out: HistoryEntry[] = [];
  let ai = 0;
  for (let i = 0; i < entries.length; i += 1) {
    out.push(entries[i]!);
    // Everything pending that belongs AFTER entry i and BEFORE entry i+1's
    // message range. The last entry's nextStart is +∞ (trailing anchors ride
    // at the projection's tail — e.g. a receipt after a final marker message).
    const nextStart = i + 1 < entryStarts.length ? entryStarts[i + 1]! : Number.POSITIVE_INFINITY;
    while (ai < anchors.length && anchors[ai]!.afterMessageIndex < nextStart) {
      out.push(anchors[ai]!.notice);
      ai += 1;
    }
  }
  return out;
}

// ω99-217: #2 — 收据回放纯层：settle 收据（turn-diff 净变更 + run-stats
// 耗时）持久化在 session JSONL 的 M35 §2 泛型车道（turn_diff_receipt /
// run_stats_receipt），resume/boot 时从 store 的全条目文件序视图重建为
// notice——面板（216 聚合）/胶囊/chip 三消费者一次喂饱，web/server 零改
// （回放条目走既有 history relay）。验证按写者契约整条严格：核心字段
// （data.text、turn-diff 的 changes）畸形即弃该条不崩（"data payload is
// the writer's contract" 的读侧诚实）；未知附加字段忽略（append-only 惯例
// 的前向兼容）。纯函数：同 entries → 同 notices，文件序保持。
/** One rebuilt changes-summary row (216 HistoryChange 的读侧形状).
 *  ω99-288: #5 — optional plus/minus（每文件 +M/−K 行数）随收据带过：写者
 *  （driver settle）在本弧起总是成对落计数，读侧成对校验、成对透传——
 *  新收据重启后面板计数不丢；老收据缺省仍缺省（append-only）。 */
interface ReceiptChange {
  readonly path: string;
  readonly op: "created" | "modified";
  readonly writes: number;
  readonly plus?: number;
  readonly minus?: number;
  readonly beforeSha?: string;
  /** ω99-319: 命令级归因标记（该行的改动来自这条 shell 命令——写者=settle
   *  的足迹 merge，200 字符帽 + …）。可选、append-only：老收据缺省；非串
   *  或超帽的畸形值只弃字段不弃行（idleReconnects 先例）。 */
  readonly cmd?: string;
}

function isReceiptText(v: unknown): v is string {
  return typeof v === "string" && v !== "";
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** ω99-314: beforeSha 是可选的 64 位小写十六进制（快照仓指针）——畸形即弃
 *  整个 changes（写者契约纪律；缺席合法：老收据/快照落盘失败的行）。 */
function isHex64(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
}

function validChanges(v: unknown): readonly ReceiptChange[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const out: ReceiptChange[] = [];
  for (const c of v) {
    if (typeof c !== "object" || c === null) return undefined;
    const { path, op, writes, plus, minus, beforeSha } = c as Record<string, unknown>;
    if (typeof path !== "string" || path === "") return undefined;
    if (op !== "created" && op !== "modified") return undefined;
    if (typeof writes !== "number" || !Number.isInteger(writes) || writes < 0) return undefined;
    // ω99-288: counts are both-or-neither — a half-present or negative pair
    // is a malformed writer payload (the whole changes drop, detail's rule).
    const hasCounts = plus !== undefined || minus !== undefined;
    if (hasCounts && (!isCount(plus) || !isCount(minus))) return undefined;
    // ω99-314: the snapshot pointer validates as hex64 when present.
    if (beforeSha !== undefined && !isHex64(beforeSha)) return undefined;
    // ω99-319: the command attribution marker validates as a non-empty string
    // within the writer's cap (+1 for the ellipsis) — malformed drops the
    // FIELD, never the row (idleReconnects precedent).
    const { cmd } = c as Record<string, unknown>;
    const cmdOk = cmd === undefined || (typeof cmd === "string" && cmd !== "" && cmd.length <= 201);
    out.push({
      path,
      op,
      writes,
      ...(hasCounts ? { plus, minus } : {}),
      ...(beforeSha !== undefined ? { beforeSha } : {}),
      ...(cmdOk && cmd !== undefined ? { cmd } : {}),
    });
  }
  return out;
}

/** 118: the notice variant of HistoryEntry, named — receipt rebuilds only
 *  ever produce this shape, and the driver's live-tail dedupe joins on its
 *  text (the honest ceiling: receipts carry no stable id across the
 *  persist/replay boundary). */
export type ReceiptNoticeEntry = Extract<HistoryEntry, { kind: "notice" }>;

/** Rebuild ONE persisted settle receipt entry as a notice — undefined for
 *  anything else (non-receipt entries, malformed payloads). The exact
 *  per-entry conversion receiptNoticesFromEntries always ran inline; 118
 *  extracts it so the anchoring walk can share the validation verbatim
 *  (same writer's contract, same reader). */
export function receiptNoticeFromEntry(e: SessionEntry): ReceiptNoticeEntry | undefined {
  if (!("type" in e)) return undefined;
  if (e.type !== "turn_diff_receipt" && e.type !== "run_stats_receipt") return undefined;
  const data: unknown = (e as { readonly data?: unknown }).data;
  if (typeof data !== "object" || data === null) return undefined;
  const { text, detail, changes } = data as Record<string, unknown>;
  if (!isReceiptText(text)) return undefined;
  if (e.type === "run_stats_receipt") {
    // ω99-315: the additive idle count passes through when well-formed
    // (a non-negative integer); anything else drops the FIELD, never the
    // notice — old receipts replay exactly as before.
    const idle = (data as { idleReconnects?: unknown }).idleReconnects;
    const idleOk = typeof idle === "number" && Number.isInteger(idle) && idle > 0;
    // ω99-320: softIdleWarns rides the same additive lane (idleReconnects
    // 同形 + 超帽弃字段：每条软警告至少对应一个 ≥softMs 的静默 gap，1e6 条
    // = 以 1s gap 计也要 11.6 天——超出即畸形写者载荷，弃字段不弃行).
    const soft = (data as { softIdleWarns?: unknown }).softIdleWarns;
    const softOk = typeof soft === "number" && Number.isInteger(soft) && soft > 0 && soft <= SOFT_IDLE_WARNS_RECEIPT_CAP;
    // v7 γ3: the serving-model receipt rides the same additive lane — the
    // replayed assistant entries come from AgentMessages (no servedBy
    // there), so the fallback note folds into the replayed stats text
    // (persisted fallbacks stay visible after resume; malformed drops the
    // note, never the line).
    const served = (data as { servedBy?: unknown }).servedBy;
    const servedModel = typeof served === "object" && served !== null && typeof (served as { model?: unknown }).model === "string"
      ? (served as { model: string }).model
      : undefined;
    const servedNote = servedModel === undefined ? "" : `；本轮由 ${servedModel}（降级）作答`;
    return { kind: "notice", text: `${text}${servedNote}`, ...(idleOk ? { idleReconnects: idle } : {}), ...(softOk ? { softIdleWarns: soft } : {}) };
  }
  const valid = validChanges(changes);
  if (valid === undefined) return undefined;
  if (detail !== undefined && !isReceiptText(detail)) return undefined;
  return { kind: "notice", text, ...(detail !== undefined ? { detail } : {}), changes: valid };
}

/** 118: one persisted receipt + its interleave position — afterMessageIndex
 *  counts the role-carrying entries that PRECEDE it in the JSONL (file
 *  order), i.e. "this receipt belongs below the N-th message's view entry".
 *  Malformed receipts never anchor (receiptNoticeFromEntry dropped them). */
export interface ReceiptAnchor {
  readonly afterMessageIndex: number;
  readonly notice: ReceiptNoticeEntry;
}

/** Walk the session file's entries in order and anchor every replayable
 *  receipt to the message count at its file position. Non-decreasing
 *  afterMessageIndex by construction (one forward pass); receipts sharing a
 *  position keep their file relative order. */
export function receiptAnchorsFromEntries(entries: readonly SessionEntry[]): ReceiptAnchor[] {
  const out: ReceiptAnchor[] = [];
  let messages = 0;
  for (const e of entries) {
    if ("role" in e) {
      messages += 1;
      continue;
    }
    const notice = receiptNoticeFromEntry(e);
    if (notice !== undefined) out.push({ afterMessageIndex: messages, notice });
  }
  return out;
}

/** Rebuild the persisted settle receipts (file order) as notice entries —
 *  malformed payloads drop silently; a receipt-free file replays ZERO.
 *  (118: thin wrapper over the anchoring walk — same output as always, the
 *  tail-merge consumers keep their contract untouched.) */
export function receiptNoticesFromEntries(entries: readonly SessionEntry[]): HistoryEntry[] {
  return receiptAnchorsFromEntries(entries).map((a) => a.notice);
}
