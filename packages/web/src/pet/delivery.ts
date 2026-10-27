// ω99-105 — scheduled-task delivery (P1 送达半环): the pet as MESSENGER.
// 104 made "hand it over" (drop = delegate); this makes "bring it back" —
// when a cron-fired task finishes, the pet surfaces the result as a
// delivery form (long-linger bubble + task digest, click reopens the main
// window). Identification rides the injection prefix core's scheduler
// stamps on every fired task (SOFT CONTRACT, deliberately a COPY: web does
// not depend on core — it is a pure WS consumer with its own protocol
// copy — so the lead constant is pinned here and by tests; a hand-typed
// `[scheduled task ` prefix at worst triggers one harmless extra bubble).
// PURE TS — no React, no CSS import; the main-shell entry pulls the mount
// into its index chunk, so it stays light (type-only imports of protocol).
import { tauriEmitEvent } from "../tauri-invoke.js";
import type { HistoryEntry, WudaoClient } from "../protocol.js";

/** Core's SCHEDULED_INJECTION_LEAD (scheduler.ts), copied. NOTE the
 * trailing space: the injection template is `${LEAD} ${task.id}] ${prompt}`,
 * so every fired task's user text starts with `[scheduled task `. */
export const SCHEDULED_TASK_LEAD = "[scheduled task ";

/** 主窗 → 宠物：送达信号事件名（Tauri event bus）。一次性信号事件——不走
 *  PetFrame 的节流泵（泵是快照流，送达是信号；与 pet-file-drop 同范式）。 */
export const WUDAO_PET_DELIVERY_EVENT = "pet-delivery";
/** 宠物 → Rust：点击送达气泡唤起主窗（main.rs 的 app.listen 同名常量）。 */
export const WUDAO_PET_OPEN_MAIN_EVENT = "pet-open-main";

/** promptDigest 截断长度（注入文本去掉前缀头后的 `<prompt>`）。 */
export const PROMPT_DIGEST_CHARS = 60;
/** answerDigest 截断长度（终答首行）。 */
export const ANSWER_DIGEST_CHARS = 80;

/** One delivery payload — task identity + the two digests the bubble shows. */
export interface PetDelivery {
  /** 从 `[scheduled task <id>] ` 提取的 id；无 `]`（或空）→ null（仍算
   *  scheduled，只是没有可用 id）。 */
  readonly taskId: string | null;
  readonly promptDigest: string;
  /** 终答首行截 80 字；空串照发（任务可能产出为空）。 */
  readonly answerDigest: string;
}

/** 前缀判断：本条 user 文本是否 scheduled 注入。 */
export function isScheduledUserText(text: string): boolean {
  return text.startsWith(SCHEDULED_TASK_LEAD);
}

/** 从 `[scheduled task <id>] …` 提取 id（到 `]` 为止）。非 scheduled /
 * 无 `]` / 空 id → null（无 id 但仍算 scheduled 的语义由调用方保留）。 */
export function parseScheduledTaskId(text: string): string | null {
  if (!isScheduledUserText(text)) return null;
  const rest = text.slice(SCHEDULED_TASK_LEAD.length);
  const end = rest.indexOf("]");
  if (end <= 0) return null;
  return rest.slice(0, end);
}

/** The `<prompt>` after the `[scheduled task <id>] ` header. Best-effort:
 * no `]` → the whole remainder (a hand-typed fake prefix — harmless). */
function promptBody(text: string): string {
  const rest = text.slice(SCHEDULED_TASK_LEAD.length);
  const end = rest.indexOf("]");
  const body = end === -1 ? rest : rest.slice(end + 1);
  return body.replace(/^\s+/, "");
}

/** Assemble a delivery from a turn's user texts + its final answer. ANY
 * scheduled text in the set triggers (steering injections included); the
 * digest comes from the (first) scheduled text. Pure, no IO. */
export function deliveryFromTurn(turnUserTexts: readonly string[], lastAnswer: string): PetDelivery | null {
  const injected = turnUserTexts.find((t) => isScheduledUserText(t));
  if (injected === undefined) return null;
  const firstLine = lastAnswer.split("\n", 1)[0] ?? "";
  return {
    taskId: parseScheduledTaskId(injected),
    promptDigest: promptBody(injected).slice(0, PROMPT_DIGEST_CHARS),
    answerDigest: firstLine.slice(0, ANSWER_DIGEST_CHARS),
  };
}

/** Segment the wire history for the just-finished turn and assemble its
 * delivery (null when the turn had no scheduled driver). The turn's user
 * set = every user entry AFTER the last assistant entry preceding the LAST
 * user entry — mid-turn steering injections are inside that stretch (tool
 * and segment entries do not wall it off); lastAnswer = the LAST assistant
 * entry of the turn, "" when the turn committed none (pure-tool / errored
 * turns deliver with an empty digest, never with the previous turn's
 * answer). Known rare miss (103-style honesty): a steering user arriving
 * after an in-turn assistant segment re-anchors the boundary past the
 * original injection — history alone cannot tell a mid-turn steer from a
 * new turn's submit; that turn then delivers no bubble. */
export function deliveryFromHistory(entries: readonly HistoryEntry[]): PetDelivery | null {
  let lastUser = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]!.kind === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser === -1) return null;
  let boundary = -1;
  for (let i = lastUser - 1; i >= 0; i -= 1) {
    if (entries[i]!.kind === "assistant") {
      boundary = i;
      break;
    }
  }
  const texts: string[] = [];
  let answer = "";
  for (let i = boundary + 1; i < entries.length; i += 1) {
    const e = entries[i]!;
    if (e.kind === "user") texts.push(e.text);
    else if (e.kind === "assistant") answer = e.text;
  }
  return deliveryFromTurn(texts, answer);
}

/** Wire parse for the pet-side listener: the payload crosses the Tauri bus
 * untyped; a malformed payload is dropped whole, never partially trusted. */
export function readDelivery(p: unknown): PetDelivery | null {
  if (typeof p !== "object" || p === null) return null;
  const f = p as Record<string, unknown>;
  if (f.taskId !== null && typeof f.taskId !== "string") return null;
  if (typeof f.promptDigest !== "string" || typeof f.answerDigest !== "string") return null;
  return { taskId: f.taskId as string | null, promptDigest: f.promptDigest, answerDigest: f.answerDigest };
}

/** Mount deps — emit injectable so tests run the edge logic with fakes. */
export interface PetDeliveryDeps {
  readonly emit: (e: string, p: unknown) => Promise<boolean> | boolean;
}

/** ω99-115 — the index of the LAST scheduled user entry in the history, or
 * -1 when none. The supplement path's tail-scan anchor (105's existing
 * isScheduledUserText is the judgement; this just locates the newest hit). */
function lastScheduledUserIndex(entries: readonly HistoryEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i]!;
    if (e.kind === "user" && isScheduledUserText(e.text)) return i;
  }
  return -1;
}

/** Mount on the MAIN window (beside mountPetRelay / mountPetDropFiles):
 * watch the single client's snapshots for the busy FALLING EDGE and emit a
 * pet-delivery signal when the just-finished turn was scheduled-driven.
 * Judgement only on connected snapshots (103 discipline — a lingering
 * status during disconnect must not fake an edge), and a historyEpoch
 * change re-arms lastBusy (a reset replay is a replacement, not an append
 * — the edge never judges across a replay). ω99-115 补递：an epoch reset
 * (first connect / reconnect replay) ALSO re-delivers a scheduled turn
 * whose falling edge was missed while the page had no view of it — see
 * supplementMissed. busy is distilled from status.busy — the same field
 * derivePetFrame reads. Emission is fire-and-forget: a failed emit still
 * counts as sent (99-arc rule). Returns the unmount (unsubscribe). */
export function mountPetDelivery(
  client: Pick<WudaoClient, "subscribe" | "getSnapshot">,
  deps?: Partial<PetDeliveryDeps>,
): () => void {
  const emit = deps?.emit ?? ((e, p) => tauriEmitEvent(e, p));
  let lastBusy: boolean | null = null; // null = 从未见（首见永不判沿）
  let lastEpoch: number | null = null;
  // ω99-115 — 页内递达记忆：本页面已递过（沿或补递）的最后一条 scheduled
  // turn。重连重放同一轮不得二送（沿/补递互斥去重共享此状态）。页面刷新即
  // 清零 → 重发一次 = 接受上限（持久化需存储/协议改动，本弧红线禁止）。
  // index 跨「整段替换重放」是启发式（服务端压缩可移位）：最坏重发一次，
  // 与刷新上限同级，诚实接受。
  let lastDelivered: { taskId: string | null; index: number } | null = null;

  const deliver = (d: PetDelivery, index: number): void => {
    lastDelivered = { taskId: d.taskId, index };
    void Promise.resolve(emit(WUDAO_PET_DELIVERY_EVENT, d)).catch(() => {});
  };

  // ω99-115 — 错过沿的补递达：epoch 重置（首连/重连 reset 重放）时，若页面
  // 空闲（busy ⇒ 在飞轮的完成沿稍后自会送达，补递抢先=双泡）且 tail 的最后
  // 一条 scheduled turn 就是「最近一个完成的轮」（其后无普通 user turn——
  // 老提醒重放不打扰新对话）且页内未递过（沿/补递互斥），补发一次。
  const supplementMissed = (entries: readonly HistoryEntry[]): void => {
    const idx = lastScheduledUserIndex(entries);
    if (idx === -1) return;
    for (let j = entries.length - 1; j > idx; j -= 1) {
      if (entries[j]!.kind === "user") return; // 其后有 user 轮 → 非最近轮
    }
    const e = entries[idx]!;
    if (e.kind !== "user") return;
    const taskId = parseScheduledTaskId(e.text);
    if (lastDelivered !== null && lastDelivered.index === idx && lastDelivered.taskId === taskId) return;
    const d = deliveryFromHistory(entries);
    if (d !== null) deliver(d, idx);
  };

  const unsubscribe = client.subscribe(() => {
    const snap = client.getSnapshot();
    if (snap.connection !== "connected") return;
    const busy = snap.status !== null && snap.status.busy;
    if (snap.historyEpoch !== lastEpoch) {
      lastEpoch = snap.historyEpoch;
      lastBusy = busy; // replay 重置基线，不判沿
      if (!busy) supplementMissed(snap.history);
      return;
    }
    if (lastBusy === true && !busy) {
      const d = deliveryFromHistory(snap.history);
      if (d !== null) deliver(d, lastScheduledUserIndex(snap.history));
    }
    lastBusy = busy;
  });
  return unsubscribe;
}
