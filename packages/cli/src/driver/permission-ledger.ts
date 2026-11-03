// ω99-248: #4 — 权限挂起的持久证据（面一）：driver 停挂一条 ask 时，把它的
// 存在落进该会话 JSONL 的 M35 §2 泛型车道（217 收据先例）；应答/中断时
// **追加**落定行——挂起行绝不改写（append-only 钉）。证据寿命=会话寿命（会
// 话文件亡=证据亡，无跨会话泄漏、无全局文件要 GC）；242 observe 的读侧零额
// 外 IO（本就要 loadSessionEntries——R2 缝位裁定的主因）。
//
// 安全纪律（brief §一 面一）：记录只有 sessionId/toolName/summary/question/at
// 五字段——**绝无 input/env/密钥/环境值**。summary 是 ask 已渲染给人类看的
// 一行（o.summarize 的产物）；完整 input 本就由转录里预派发屏障先落盘的工具
// 调用消息承载（模型可见历史），持久记录不复制它。
//
// 「证据不是授权」（brief §一 面二）：读侧 fold 只回答「该会话最后一条 ask
// 是否仍无人应答」——它证明问过，绝不构成放行。重问由恢复 admission 的
// verify-first run 里模型再发出的同一工具调用走正常权限管线浮出。
//
// M24 声明：泛型条目只进 JSONL 永不进 state.messages/system prompt（load()
// 滤泛型=store 既有契约）——前缀缓存零代价，与 217 收据同款。
import type { GenericSessionEntry, SessionEntry } from "@wudao-org/core";

/** ω99-248 — the parked ask's evidence line (append-only; the settle line is a
 *  SEPARATE later append — this line's bytes never move). */
export const PERMISSION_ASK_ENTRY_TYPE = "permission_ask";
/** ω99-248 — the ask's resolution line (allow/deny/session/always from an
 *  answer; interrupted from the interrupt/detach path). */
export const PERMISSION_SETTLED_ENTRY_TYPE = "permission_ask_settled";

/** The settle outcomes: the four y/a/p/n answer kinds plus the interrupt
 *  resolution (denyPendingAsk — interrupt/detach/dispose all land here). */
export type PermissionAskOutcome = "allow" | "deny" | "session" | "always" | "interrupted";

/** The human-rendered question for a parked ask — ONE derivation shared by the
 *  record and the web's morning line (the PermissionModal headline's text
 *  without presentation prefixes). */
export function permissionQuestionText(toolName: string, summary: string): string {
  return `允许 ${toolName}${summary !== "" ? `：${summary}` : ""}？`;
}

/** The ask record's shape (writer's contract — the five fields, nothing else). */
export interface PermissionAskData {
  readonly sessionId: string;
  readonly toolName: string;
  readonly summary: string;
  readonly question: string;
  readonly at: number;
}

/** Build the pending-ask evidence entry. Callers pass the LIVE session id (the
 *  file it lands in IS the session's own JSONL). */
export function buildPermissionAskEntry(sessionId: string, toolName: string, summary: string, at: number): GenericSessionEntry {
  return {
    type: PERMISSION_ASK_ENTRY_TYPE,
    data: { sessionId, toolName, summary, question: permissionQuestionText(toolName, summary), at } satisfies PermissionAskData,
  };
}

/** Build the settle entry — appended on answer/interrupt, NEVER a rewrite. */
export function buildPermissionSettledEntry(sessionId: string, outcome: PermissionAskOutcome, at: number): GenericSessionEntry {
  return {
    type: PERMISSION_SETTLED_ENTRY_TYPE,
    data: { sessionId, outcome, at },
  };
}

function validAskData(v: unknown): PermissionAskData | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const d = v as Record<string, unknown>;
  if (typeof d.sessionId !== "string" || d.sessionId === "") return undefined;
  if (typeof d.toolName !== "string" || d.toolName === "") return undefined;
  if (typeof d.summary !== "string") return undefined;
  if (typeof d.question !== "string" || d.question === "") return undefined;
  if (typeof d.at !== "number" || !Number.isFinite(d.at)) return undefined;
  return { sessionId: d.sessionId, toolName: d.toolName, summary: d.summary, question: d.question, at: d.at };
}

function validSettledData(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  if (typeof d.sessionId !== "string" || d.sessionId === "") return false;
  if (d.outcome !== "allow" && d.outcome !== "deny" && d.outcome !== "session" && d.outcome !== "always" && d.outcome !== "interrupted") return false;
  return typeof d.at === "number" && Number.isFinite(d.at);
}

/** The ask evidence WITHOUT the record-internal `at` (the read side's shape for
 *  the observation/row — the wall clock is the writer's concern). */
export interface PermissionAskEvidence {
  readonly toolName: string;
  readonly summary: string;
  readonly question: string;
}

export interface PermissionPendingEvidence {
  /** The session's last ask still stands unanswered in the file order. */
  readonly pending: boolean;
  /** That ask's evidence (undefined when not pending). */
  readonly ask?: PermissionAskEvidence;
}

/** Fold a session's entries (file order): the last permission_ask without a
 *  later permission_ask_settled = pending. Pure; malformed payloads drop
 *  silently (the 217 honest-skip law) — a junk line never crashes the reader
 *  and never resurrects a settled ask. */
export function permissionPendingFromEntries(entries: readonly SessionEntry[]): PermissionPendingEvidence {
  let ask: PermissionAskEvidence | undefined;
  for (const e of entries) {
    if (!("type" in e)) continue;
    if (e.type === PERMISSION_ASK_ENTRY_TYPE) {
      const d = validAskData((e as GenericSessionEntry).data);
      if (d !== undefined) ask = { toolName: d.toolName, summary: d.summary, question: d.question };
    } else if (e.type === PERMISSION_SETTLED_ENTRY_TYPE) {
      if (validSettledData((e as GenericSessionEntry).data)) ask = undefined;
    }
  }
  return ask === undefined ? { pending: false } : { pending: true, ask };
}
