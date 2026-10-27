// ω99-242: #5 — verify-first 恢复注入的 cli 面：恢复 admission 的 prompt 构造
// （§三模板逐字钉）+ 收据对账数据源 + 会话证据/mission 绑定的纯投影 + 挂进
// server 协调器的 RecoveryPort 装配（resume + submit——恢复走正常权限管线，
// §二.8 零旁路）。
//
// M24 声明（§二.10，代码注释+报告双声明）：恢复注入发生在 resume 边界=冷转
// 预期（cold turn expected）——verify-first 恢复 prompt 是全新 user turn，前
// 缓存前缀在 resume 边界重建后不再命中，这是本设计的已知缓存代价；补偿=
// 轮界时机（只在 boot 恢复与 ≥2s 间隔的轮界注入，绝不在运行中打断）。
// 121 #4 追加声明：会话恢复 system note（RECOVERY_SESSION_NOTE）搭同一班冷
// 转——它经 driver.pushMetaNote 走 MetaNote 通道（尾侧投影，永不落盘），在
// verify-first run 的首个模型调用一次性可见；干净会话（无恢复 admission）
// 从不 push，字节不变，零新增前缀代价。
//
// 收据对账数据源（§三）：session JSONL 既有面——turn_diff_receipt / run_stats_
// receipt（217 泛型车道）+ 工具调用条目（resume 从 messages 重建同源：本模块
// 的链投影与 driver.resume 同一 projection 函数）+ file-receipt（125 名册门）。
// 纯读投影，不新造持久面。
import { createJsonlSessionStore, resumeChain, activeBranchLeafKey, type AgentMessage, type SessionEntry, type SessionStore } from "@wudao/core";
import type { RecoveryObservation, RecoveryPort, RecoverySettle } from "@wudao/server";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentDriver } from "./driver/agent-driver.js";
import type { MissionState, MissionTask } from "./mission.js";
import { loadMissionStore } from "./mission.js";
import { extractFileReceipt } from "./driver/file-receipt.js";
import { permissionPendingFromEntries } from "./driver/permission-ledger.js";
import { truncate } from "./log.js";

/** ω99-242 — never recovery candidates: the pet lane's fixed session (its own
 *  driver owns it at the next boot) and the schedules daemon's log session
 *  (not a conversation). Sidechains (side-*) are never top-level sessions. */
export const RECOVERY_EXCLUDED_SESSION_IDS: ReadonlySet<string> = new Set(["pet", "schedules"]);

/** A session id the recovery coordinator may consider at all. */
export function isRecoveryCandidateId(id: string): boolean {
  return !RECOVERY_EXCLUDED_SESSION_IDS.has(id) && !id.startsWith("side-");
}

/** The same projection driver.resume rebuilds from (entries → the active
 *  branch's message chain) — 对账与 resume 同源，不另造视图。 */
export function recoveryChainMessages(entries: readonly SessionEntry[]): AgentMessage[] {
  return resumeChain(entries.filter((e): e is AgentMessage => "role" in e), activeBranchLeafKey(entries));
}

// ---------------------------------------------------------------------------
// §三 verify-first 恢复 prompt（逐字钉——tests/omega99-242-recovery-prompt
// .test.ts R4 两形字节钉：有收据形 / 无收据整段省略形）
// ---------------------------------------------------------------------------

/** Build the verify-first recovery prompt. `receipts` is the receipt-level
 *  completed list (one line each: 做了什么 + 产物路径（若有）); an EMPTY list
 *  omits the whole 已完成 section (§三: 无收据可查时此段整段省略). `pending`
 *  is the 待续 interpolant (mission task description, or the interrupted
 *  turn's original commission when no mission is bound). */
export function buildRecoveryPrompt(receipts: readonly string[], pending: string): string {
  if (typeof pending !== "string" || pending.trim() === "") {
    throw new Error("buildRecoveryPrompt: 待续 description must be non-empty (fail-closed)");
  }
  const lines = ["继续之前的任务。上一进程在执行中中断，我已按会话记录对账："];
  if (receipts.length > 0) {
    lines.push("已完成（收据核实）：");
    lines.push(...receipts);
  }
  lines.push(`待续：${pending}`);
  lines.push("请先检查会话与工作区，确认上面「已完成」的部分真实在盘；保留已完成的工作，不要重复已产生副作用的操作；只完成剩余部分。无法确认某一步是否已执行时，停下来问我，不要猜。");
  // ω99-252: #3 — the RESEND guidance (面二): a permission-blocked tool call
  // must be re-issued AS-IS in the verify-first run — the ask re-floats
  // through the normal pipeline (证据不是授权). Without this sentence the
  // model may narrate the blocked step instead of re-sending it, leaving the
  // morning loop's last hop (一答续跑) to model discretion. Benefit copy, one
  // sentence, appended — the 242 lines above are byte-frozen.
  // M24: the recovery prompt is a per-run constructed user turn at the resume
  // boundary (242's declared cold turn) — the sentence rides the same
  // one-time bytes; zero stable-prefix cost, nothing to declare beyond 242.
  lines.push("上一轮被权限挡住的工具调用请原样重发，授权问句会自动浮出；不要改为口头描述或跳过。");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 121 #4 — 幸存现场对模型可见（a reference harness eefdcb42f「Prior Session 前缀提
// 示」形 + 超越）。恢复协调器恢复"本会话"，但模型不知道「我从哪恢复的」
// ——上下文断层而模型不自知。恢复成功后在 verify-first run 首个模型调用注
// 入一次性 system note。超越点 vs a reference harness：a reference harness 把提示钉进会话 prompt
// 前缀（常驻字节）；本实现走 MetaNote 瞬态投影（尾侧追加、永不落盘、一次
// 性可见）——干净会话字节不变，M24 零前缀代价（见文件头 121 #4 追加声明）。
// ---------------------------------------------------------------------------

/** The one-time session-recovery note (byte-pinned — tests assert verbatim). */
export const RECOVERY_SESSION_NOTE =
  "[系统注入·会话恢复] 本会话从崩溃/重启中恢复。之前的对话历史完整保留；最后一次操作可能未完成——请检查最近的工具结果与文件状态后再继续。";

// ---------------------------------------------------------------------------
// The receipt projection (收据对账数据源)
// ---------------------------------------------------------------------------

/** One changes row — receiptNoticesFromEntries' read-side twin (tui/resume.ts;
 *  same validation, kept local so this module never grows a HistoryEntry
 *  dependency — the prompt needs plain lines, not notices). */
interface ReceiptChange { readonly path: string; readonly op: "created" | "modified"; readonly writes: number }

function validChanges(v: unknown): readonly ReceiptChange[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const out: ReceiptChange[] = [];
  for (const c of v) {
    if (typeof c !== "object" || c === null) return undefined;
    const { path, op, writes } = c as Record<string, unknown>;
    if (typeof path !== "string" || path === "") return undefined;
    if (op !== "created" && op !== "modified") return undefined;
    if (typeof writes !== "number" || !Number.isInteger(writes) || writes < 0) return undefined;
    out.push({ path, op, writes });
  }
  return out;
}

/** Receipt lines cap — the completed list stays a verification INDEX, not a
 *  transcript replay (prompt bloat guard). */
export const RECOVERY_RECEIPT_MAX_LINES = 30;

export interface RecoveryCompletedList {
  /** The 已完成（收据核实） lines (each 做了什么 + 产物路径（若有）). */
  readonly lines: readonly string[];
  /** How many lines are RECEIPT-verified (turn-diff + file receipts; the
   *  trailing tool-ledger summary line is not counted). */
  readonly verifiedDone: number;
}

/** Project the receipt-level completed list from a session's entries.
 *  Sources (file order): turn_diff_receipt entries (their rendered text IS
 *  「做了什么 + 产物路径」), file-receipt deliverables from the chain's tool
 *  results (the 125 name gate), and a one-line tool-call ledger (the 工具调用
 *  条目 source). run_stats_receipt is deliberately NOT listed — it verifies a
 *  run settled, not a work product (弧报告 §一缝位裁定). Malformed payloads
 *  drop silently (the 217 read-side honesty); an empty projection gives an
 *  empty list (the builder then omits the whole section). */
export function recoveryCompletedList(entries: readonly SessionEntry[]): RecoveryCompletedList {
  const receipts: string[] = [];
  for (const e of entries) {
    if (!("type" in e) || e.type !== "turn_diff_receipt") continue;
    const data: unknown = (e as { readonly data?: unknown }).data;
    if (typeof data !== "object" || data === null) continue;
    const { text, detail, changes } = data as Record<string, unknown>;
    if (typeof text !== "string" || text === "") continue;
    if (validChanges(changes) === undefined) continue; // the 217 read contract
    if (detail !== undefined && typeof detail !== "string") continue;
    receipts.push(text);
  }
  const chain = recoveryChainMessages(entries);
  for (const m of chain) {
    if (m.role !== "tool") continue;
    const receipt = extractFileReceipt(m.name, m.content);
    if (receipt !== undefined) receipts.push(`生成交付物 ${receipt.name}（${receipt.bytes} B）：${receipt.path}`);
  }
  const calls = new Map<string, number>();
  for (const m of chain) {
    if (m.role !== "assistant" || m.toolCalls === undefined) continue;
    for (const c of m.toolCalls) calls.set(c.name, (calls.get(c.name) ?? 0) + 1);
  }
  const verifiedDone = receipts.length;
  const lines: string[] = [];
  if (verifiedDone > RECOVERY_RECEIPT_MAX_LINES) {
    lines.push(`……（更早 ${verifiedDone - RECOVERY_RECEIPT_MAX_LINES} 条收据略）`);
    lines.push(...receipts.slice(verifiedDone - RECOVERY_RECEIPT_MAX_LINES));
  } else {
    lines.push(...receipts);
  }
  if (calls.size > 0) {
    lines.push(`工具调用记录：${[...calls.entries()].map(([name, n]) => `${name} ×${n}`).join(" · ")}`);
  }
  return { lines, verifiedDone };
}

// ---------------------------------------------------------------------------
// Half-turn evidence (§二.4: 同一未完成轮——idle 本身不是证据)
// ---------------------------------------------------------------------------

export interface TurnEvidence {
  /** The active chain's turn stands unfinished: the last entry is a user
   *  turn (submit landed, no reply), an assistant tool-call turn with its
   *  results missing, or a trailing tool result (the loop never wrote the
   *  closing assistant message). A plain closing assistant message = closed. */
  readonly turnOpen: boolean;
  /** The open turn is waiting on a delegated child (父等子): the trailing
   *  tool call spawns/awaits a child agent → blocked, not independently
   *  recovered. */
  readonly childPending: boolean;
}

/** The delegated-child tool family (agents/task-tool.ts: task spawns,
 *  task_wait awaits — either way the parent's turn depends on the child). */
const CHILD_TASK_TOOLS: ReadonlySet<string> = new Set(["task", "task_wait"]);

export function turnEvidence(messages: readonly AgentMessage[]): TurnEvidence {
  const last = messages[messages.length - 1];
  if (last === undefined) return { turnOpen: false, childPending: false };
  if (last.role === "assistant" && (last.toolCalls ?? []).length === 0) {
    return { turnOpen: false, childPending: false }; // the turn closed honestly
  }
  // Open — is the trailing work a delegated child?
  let childPending = false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m === undefined || m.role !== "assistant" || (m.toolCalls ?? []).length === 0) continue;
    const calls = m.toolCalls ?? [];
    childPending = calls.some((c) => CHILD_TASK_TOOLS.has(c.name));
    break;
  }
  return { turnOpen: true, childPending };
}

// ---------------------------------------------------------------------------
// The mission seam (待续 interpolant + DAG rank + in-flight detection)
// ---------------------------------------------------------------------------

/** Longest-path topological depth per task (roots 0). The recovery order's
 *  rank source (§二.9: 恢复顺序沿 mission DAG 依赖拓扑). */
export function missionTopoDepth(tasks: readonly MissionTask[]): Map<string, number> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depth = new Map<string, number>();
  const visit = (id: string, seen: ReadonlySet<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0; // cycle guard — hasCycle already refused these at plan time
    const task = byId.get(id);
    if (task === undefined) return 0;
    const d = task.dependsOn.length === 0
      ? 0
      : 1 + Math.max(...task.dependsOn.map((dep) => visit(dep, new Set([...seen, id]))));
    depth.set(id, d);
    return d;
  };
  for (const t of tasks) visit(t.id, new Set());
  return depth;
}

/** The 待续 interpolant: the active mission's earliest ready task (deps all
 *  done), else its objective. Empty string when no active mission (the caller
 *  falls back to the interrupted turn's original commission). */
export function missionPendingDescription(mission: MissionState | null): string {
  if (mission === null || mission.status !== "active") return "";
  const done = new Set(mission.tasks.filter((t) => t.status === "done").map((t) => t.id));
  const ready = mission.tasks.find((t) => t.status !== "done" && t.status !== "failed" && t.dependsOn.every((d) => done.has(d)));
  if (ready !== undefined) {
    return `任务 ${ready.id}（${ready.title}）${ready.detail !== undefined ? `：${ready.detail}` : ""}`;
  }
  return truncate(mission.objective, 400);
}

/** The reconciliation Y: an active mission counts its not-done tasks; a
 *  mission-less session counts the one interrupted turn. */
export function missionRemainingCount(mission: MissionState | null): number {
  if (mission === null || mission.status !== "active") return 1;
  return mission.tasks.filter((t) => t.status === "todo" || t.status === "doing").length;
}

/** The last mission_complete receipt's task id in this session (file order) —
 *  the session's progress marker on the DAG. */
export function sessionLastCompletedTask(messages: readonly AgentMessage[]): string | undefined {
  let last: string | undefined;
  for (const m of messages) {
    if (m.role !== "assistant" || m.toolCalls === undefined) continue;
    for (const c of m.toolCalls) {
      if (c.name !== "mission_complete") continue;
      const id = c.arguments?.taskId;
      if (typeof id === "string" && id !== "") last = id;
    }
  }
  return last;
}

/** Does this session carry mission activity at all (the boot scan filter)? */
export function hasMissionActivity(entries: readonly SessionEntry[]): boolean {
  return recoveryChainMessages(entries).some((m) =>
    m.role === "assistant" && (m.toolCalls ?? []).some((c) => c.name.startsWith("mission_")));
}

/** The session's DAG rank: depth(lastCompletedTask) + 1 (its next work sits
 *  one past its progress marker); 0 when mission-active but pre-first-complete;
 *  Number.POSITIVE_INFINITY when mission-unbound (§二.9: unbound sessions
 *  recover after every mission-bound one). */
export function sessionMissionRank(entries: readonly SessionEntry[], mission: MissionState | null): number {
  if (mission === null || mission.status !== "active") return Number.POSITIVE_INFINITY;
  const chain = recoveryChainMessages(entries);
  if (!chain.some((m) => m.role === "assistant" && (m.toolCalls ?? []).some((c) => c.name.startsWith("mission_")))) {
    return Number.POSITIVE_INFINITY;
  }
  const last = sessionLastCompletedTask(chain);
  if (last === undefined) return 0;
  const depth = missionTopoDepth(mission.tasks).get(last);
  return depth === undefined ? 0 : depth + 1;
}

// ---------------------------------------------------------------------------
// The port装配 (server 协调器 ↔ cli 引擎)
// ---------------------------------------------------------------------------

/** Is `pid` alive? (lease.ts's isAlive twin — probe-only, never acquires.) */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read-only lease probe: another LIVE process holds the session's run lease
 *  → active (observe only). Our OWN pid does not count (we may admit into the
 *  session we already own — the --continue boot case). */
async function leaseHeldByOther(sessionsDir: string, id: string): Promise<boolean> {
  try {
    const text = await readFile(join(sessionsDir, ".leases", `${id}.json`), "utf8");
    const parsed = JSON.parse(text) as { pid?: unknown };
    if (typeof parsed.pid !== "number") return false;
    return parsed.pid !== process.pid && pidAlive(parsed.pid);
  } catch {
    return false; // no lock / junk bytes — nobody else holds it
  }
}

const LAST_USER_CHARS = 200;

/** The interrupted turn's original commission (the no-mission 待续 fallback):
 *  the last real user message, marker machinery excluded. */
function lastUserCommission(messages: readonly AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m === undefined || m.role !== "user") continue;
    if (m.content.startsWith("[system note:") || m.content.startsWith("[compacted summary]") || m.content.startsWith("[todo board")) continue;
    if (m.content.trim() === "") continue;
    return truncate(m.content, LAST_USER_CHARS);
  }
  return "";
}

export interface RecoveryPortOptions {
  readonly driver: AgentDriver;
  readonly workspaceRoot: string;
  /** Test seam: the session store (default: the workspace's .wudao/sessions). */
  readonly store?: SessionStore;
  /** Boot-scan bound: how many newest mission-bound sessions to name. */
  readonly bootScanLimit?: number;
}

/** Build the RecoveryPort the server coordinator drives. Everything here is
 *  the EXISTING seams — resume() (the ω99-225 verdict + lease adoption) and
 *  submit() (the full routing + permission pipeline, §二.8: 恢复 admission
 *  走正常权限管线，安全性继承，不建旁路). */
export function createRecoveryPort(opts: RecoveryPortOptions): RecoveryPort {
  const driver = opts.driver;
  const store = opts.store ?? createJsonlSessionStore(join(opts.workspaceRoot, ".wudao", "sessions"));
  const sessionsDir = join(opts.workspaceRoot, ".wudao", "sessions");
  const bootScanLimit = opts.bootScanLimit ?? 3;
  // 121 #4 — exactly-once guard: one note per session per port instance (per
  // boot). The coordinator's claim discipline already refuses double admission
  // within a boot; this set makes the note's own invariant local and testable
  // (注入一次不复注). A NEXT boot's recovery of the same session is a new
  // crash cycle — a fresh port instance, a fresh (truthful) note.
  const notedSessions = new Set<string>();

  const missionOf = async (): Promise<MissionState | null> => {
    try {
      return (await loadMissionStore({ workspaceRoot: opts.workspaceRoot })).mission;
    } catch {
      return null; // corrupt/symlink ledger — the mission domain reports its own refusal
    }
  };

  return {
    bootCandidates: async (): Promise<readonly string[]> => {
      // §四 v1: the disk scan names 「mission in-flight」 sessions the journal
      // never saw (the pre-feature crash path). No active mission → zero IO.
      const mission = await missionOf();
      if (mission === null || mission.status !== "active") return [];
      const ids = (await store.list().catch(() => [])).filter(isRecoveryCandidateId);
      const withMtime: { id: string; mtime: number }[] = [];
      for (const id of ids.slice(0, 20)) { // newest-first scan bound
        try {
          withMtime.push({ id, mtime: (await stat(join(sessionsDir, `${id}.jsonl`))).mtimeMs });
        } catch {
          /* raced away — skip */
        }
      }
      withMtime.sort((a, b) => b.mtime - a.mtime);
      const bound: string[] = [];
      for (const row of withMtime) {
        if (bound.length >= bootScanLimit) break;
        const entries = await store.loadSessionEntries(row.id).catch(() => []);
        if (hasMissionActivity(entries)) bound.push(row.id);
      }
      return bound;
    },

    observe: async (id: string): Promise<RecoveryObservation | undefined> => {
      const entries = await store.loadSessionEntries(id).catch(() => undefined);
      if (entries === undefined || entries.length === 0) return undefined;
      const chain = recoveryChainMessages(entries);
      const evidence = turnEvidence(chain);
      const mission = await missionOf();
      const current = driver.getSessionId();
      // ω99-248: #6 — the permissionPending evidence's MIRROR rule. The LIVE
      // driver status is the only truth for the CURRENT session (242's rule,
      // unchanged): after the morning resume the record alone must NOT hold
      // the session blocked — the admission's verify-first run is what
      // re-floats the ask through the normal pipeline, and a resumed-idle
      // session must classify unfinished to get it. For every OTHER session
      // the PERSISTENT record (permission_ask / permission_ask_settled in this
      // session's own JSONL, the 217 generic lane) is the evidence: the
      // blocked(权限) verdict survives restarts. The record is EVIDENCE, never
      // authorization — nothing here answers or replays the ask.
      const record = permissionPendingFromEntries(entries);
      const permissionPending = id === current
        ? (driver.getStatus() as { pendingPermission?: unknown }).pendingPermission != null
        : record.pending;
      return {
        leaseHeldByOther: await leaseHeldByOther(sessionsDir, id),
        permissionPending,
        // The morning face's data: only the RECORD-sourced ask carries (a
        // live-parked current session answers through its own modal — the
        // banner never claims 昨夜 for a session the user is watching).
        ...(id !== current && record.ask !== undefined ? { pendingAsk: record.ask } : {}),
        childPending: evidence.childPending,
        turnOpen: evidence.turnOpen,
        missionTerminal: mission !== null && mission.status !== "active",
        dagRank: sessionMissionRank(entries, mission),
      };
    },

    admit: async (id: string): Promise<RecoverySettle> => {
      // §二.8 — the normal pipeline: resume() runs the lease adoption + hook
      // seams; submit() runs the full routing + permission stack. No bypass.
      if (id !== driver.getSessionId()) {
        const outcome = await driver.resume(id);
        if (!outcome.ok) {
          throw new Error(outcome.reason === "occupied"
            ? `resume refused: session held by pid ${outcome.holderPid}`
            : "resume refused: session not found");
        }
      }
      // 121 #4 — the survivor scene, model-visible: after a successful
      // recovery, ONE system note rides the recovery turn's first model call
      // (driver.pushMetaNote → the MetaNote channel: projected into the last
      // tool_result tail BEFORE the new recovery prompt turn, tail-side only,
      // never persisted, transient — the next model call carries no residue).
      // M24: it rides 242's already-declared resume-boundary cold turn — zero
      // stable-prefix bytes, zero additional cost to declare. A refused resume
      // (the throw above) never reaches this push — no note without a
      // recovery. Both arms are truthful recoveries: the coordinator admits
      // only unfinished (checkpointed / open-turn) sessions, including the
      // boot --continue case where the session is already current.
      if (!notedSessions.has(id)) {
        notedSessions.add(id);
        driver.pushMetaNote(RECOVERY_SESSION_NOTE);
      }
      const entries = await store.loadSessionEntries(id).catch(() => []);
      const list = recoveryCompletedList(entries);
      const mission = await missionOf();
      const chain = recoveryChainMessages(entries);
      const pending = missionPendingDescription(mission) || lastUserCommission(chain) || `继续会话 ${id} 的未完成工作`;
      // M24: resume 边界的全新 user turn = 冷转预期（cold turn expected）——
      // 见本文件头注；注入只在轮界发生（协调器的 busy 门 + ≥2s 间隔）。
      const outcome = driver.submit(buildRecoveryPrompt(list.lines, pending));
      if (outcome !== "started" && outcome !== "steered") {
        throw new Error(`recovery submit not admitted (${outcome})`);
      }
      return { verifiedDone: list.verifiedDone, remaining: missionRemainingCount(mission) };
    },

    currentSession: (): string | undefined => driver.getSessionId(),
    busy: (): boolean => !driver.isIdle(),
  };
}
