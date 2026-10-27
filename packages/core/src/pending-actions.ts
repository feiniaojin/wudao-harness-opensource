// 借鉴弧 ζ1（digest-b 候选 5，Reasonix durable tool recovery 蒸馏）——未决
// 工具动作的崩溃事实面。在位者（pre-dispatch barrier + 轮级 verify-first 恢
// 复）是「问模型」；本层补「告诉模型」的机器事实：一个写动作已发出、从未
// 等到结果（崩溃/中断），后续对同一目标的盲目重写要有机器凭据可拦。
//
// 三件（Reasonix 的分层采纳，交互式恢复 UX 已被其自己退役——留下的有效件
// 是数据面不是交互面）：
//  (a) 稳定动作身份 = tool + 目标 path + 参数指纹（canonical JSON 的 sha256
//      前 8 hex；Reasonix 的「AttemptID 置空的可幂等键」——崩溃后可判定
//      「同一逻辑动作」的 resend）。
//  (b) 未决记录尾注：随 tier-2 冻结摘要的 riders 通道活过压缩（夜移030 文
//      件台账同族 tag 块——重解析冻结字节、跨边界合并、有帽）。
//  (c) 陈旧写拒绝：写入路径查未决表（fail-open：链缺席/畸形绝不阻塞写入
//      ——freshness gate 仍是第一道门，本层只补「崩溃后 readState 清空、
//      freshness 失效」的那个窗口）。
//
// 状态纪律（夜移030 同款）：零新持久面——未决集永远从消息链重新推导
// （冻结摘要的 tag 块作种子 + 摘要后的链扫描），resume 可重导、确定性、
// 同输入同输出。M24：身份不进 system prompt；尾注只随压缩边界的新摘要字
// 节走（压缩本就是声明的冷转预期位）；拒绝是普通 tool result（纯后缀）。
import { createHash } from "node:crypto";
import type { AgentMessage, ToolCall } from "./types.js";
import { SUMMARY_MARKER } from "./compaction-markers.js";
import { UNKNOWN_OUTCOME_TOOL_RESULTS } from "./tool-result-synthetics.js";

/** ζ1: 写动作工具域（与夜移030 文件台账的 modified 集完全同族——write_file/
 *  edit 有 path 身份；shell 改动无路径身份，v1 诚实边界，不归因不拦截）。 */
export type WriteActionTool = "write_file" | "edit";

/** ζ1: 一条未决写记录（动作身份的持久形状——callId 只活在链内做逐调用配
 *  对，跨压缩存活的身份是 tool+path+指纹三元组）。 */
export interface PendingWriteEntry {
  readonly tool: WriteActionTool;
  /** The call's path argument, normalized (leading "./" stripped) — the same
   *  convention the file ledger uses (raw arg paths, not abs). */
  readonly path: string;
  /** sha256 of the canonical argument JSON, first 8 hex chars. */
  readonly fingerprint: string;
}

/** ζ1: the rider block's tag (夜移030 tag family). */
export const PENDING_ACTIONS_TAG = "pending-actions";
/** ζ1: cap on entries a summary carries (omission-line protocol, lossless
 *  re-merge at the next boundary). These lines are heavier than file-ledger
 *  paths — 5 is plenty for a crash's worth of in-flight writes. */
export const PENDING_ACTIONS_CAP = 5;

/** Canonical argument JSON: recursively key-sorted, so {"a":1,"b":2} and
 *  {"b":2,"a":1} are the SAME action; boolean-false keys are dropped (a
 *  schema default of false is identity-neutral — the tool reconstructs
 *  {replace_all: false} where the model omitted it, and a re-sent action
 *  must not diverge over it). Deterministic across runs. */
export function canonicalArguments(args: Record<string, unknown>): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (typeof v === "object" && v !== null) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        if ((v as Record<string, unknown>)[k] === false) continue;
        out[k] = sort((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(args));
}

/** ζ1: the action fingerprint — sha256 of canonical args, first 8 hex. */
export function argumentFingerprint(args: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalArguments(args), "utf8").digest("hex").slice(0, 8);
}

/** Normalize a path argument for identity comparison ("./a.ts" === "a.ts";
 *  anything deeper is compared verbatim — the file ledger's documented
 *  boundary). */
export function normalizePathArg(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}

const isWriteAction = (name: string, args: Record<string, unknown>): name is WriteActionTool =>
  (name === "write_file" || name === "edit") && typeof args.path === "string" && args.path !== "";

// ---------------------------------------------------------------------------
// The extraction — the ONE seam (gate, rider composer, and tests all read it)
// ---------------------------------------------------------------------------

/** One walk slot: either an awaited write action or an awaited read. */
type WalkSlot =
  | { readonly kind: "write"; readonly entry: PendingWriteEntry }
  | { readonly kind: "read"; readonly path: string };

/** ζ1: the pending-write ledger derived from a message chain. Semantics —
 *  a write-class call is PENDING-UNKNOWN when its result never arrived, or
 *  arrived as a known unknown-outcome synthetic (resume repair / abort
 *  pairing). It leaves the ledger when:
 *   - a SUCCESSFUL read_file of the target follows it (the model re-grounded:
 *     the disk state is visible again, elided reads included — elision only
 *     fires after a real disk read that matched the context bytes), or
 *   - a SUCCESSFUL write to the target follows it (its own committed write
 *     supersedes the stale mental model), or
 *  and a call answered by ANY other result (error, permission denial, the
 *  deterministic no-op synthetics) is resolved — the tool responded, no
 *  commit happened. Dangling unanswered calls at the END of the chain count
 *  as pending-unknown: the pre-dispatch barrier means a durable call without
 *  a result is exactly "dispatched, outcome unknown" — in a live chain that
 *  is only the current in-flight call itself (its own fingerprint allows the
 *  re-issue); in a resumed chain it is the crash residue. Results for other
 *  agents' chains never appear here — extraction is per-chain.
 *
 *  The chain's LAST frozen summary seeds the ledger (its rider block parsed
 *  from frozen bytes); only messages AFTER it are walked — older summaries
 *  were already folded into that block at its composition.
 *  Pure: same chain → same ledger. `onlyPath` (the gate's hot path) walks
 *  the same semantics filtered to one target. */
export function pendingLedgerOf(messages: readonly AgentMessage[], onlyPath?: string): PendingWriteEntry[] {
  const matches = (p: string): boolean => onlyPath === undefined || p === onlyPath;
  // 1. Seed from the last frozen summary's rider block.
  let seed: PendingWriteEntry[] = [];
  let walkStart = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m !== undefined && m.role === "user" && m.content.startsWith(SUMMARY_MARKER)) {
      const parsed = parsePendingActionsFromSummary(m.content);
      if (parsed !== undefined) seed = parsed.filter((e) => matches(e.path));
      walkStart = i + 1;
      break;
    }
  }
  // 2. Walk. unknowns = the surviving ledger; slots = calls awaiting results.
  const unknowns: PendingWriteEntry[] = [...seed];
  const slots = new Map<string, WalkSlot>();
  const clearTarget = (path: string): void => {
    for (let i = unknowns.length - 1; i >= 0; i -= 1) {
      if (unknowns[i]?.path === path) unknowns.splice(i, 1);
    }
  };
  for (let i = walkStart; i < messages.length; i += 1) {
    const m = messages[i];
    if (m === undefined) continue;
    if (m.role === "assistant" && m.toolCalls !== undefined) {
      for (const call of m.toolCalls) {
        const slot = walkSlotOf(call, matches);
        if (slot !== undefined) slots.set(call.id, slot);
      }
      continue;
    }
    if (m.role !== "tool") continue;
    const slot = slots.get(m.toolCallId);
    slots.delete(m.toolCallId);
    if (slot === undefined) continue;
    if (slot.kind === "read") {
      // A successful read re-grounds the target (an elided read still touched
      // the disk — elision compares the FRESH bytes against context); a
      // failed read (missing file, …) proves nothing.
      if (m.isError !== true) clearTarget(slot.path);
      continue;
    }
    if (m.isError !== true) {
      clearTarget(slot.entry.path); // own committed write supersedes
      continue;
    }
    if (UNKNOWN_OUTCOME_TOOL_RESULTS.has(m.content)) unknowns.push(slot.entry);
    // else: answered (denied / error / deterministic no-op synthetic) — the
    // call is resolved; the ledger keeps nothing for it.
  }
  // 3. Dangling calls = dispatched, outcome unknown (see doc above).
  for (const slot of slots.values()) {
    if (slot.kind === "write") unknowns.push(slot.entry);
  }
  // Dedupe by identity, first occurrence wins (a re-sent identical action is
  // ONE logical pending action, not two).
  const seen = new Set<string>();
  const out: PendingWriteEntry[] = [];
  for (const e of unknowns) {
    const key = `${e.tool}\n${e.path}\n${e.fingerprint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/** The walk slot of one assistant tool call (undefined when the call is
 *  neither a matching write action nor a matching read). */
function walkSlotOf(call: ToolCall, matches: (p: string) => boolean): WalkSlot | undefined {
  const path = call.arguments.path;
  if (typeof path !== "string" || path === "") return undefined;
  const norm = normalizePathArg(path);
  if (!matches(norm)) return undefined;
  if (call.name === "write_file" || call.name === "edit") {
    return { kind: "write", entry: { tool: call.name, path: norm, fingerprint: argumentFingerprint(call.arguments) } };
  }
  if (call.name === "read_file") return { kind: "read", path: norm };
  return undefined;
}

// ---------------------------------------------------------------------------
// The rider block (format / parse — 夜移030 discipline: frozen bytes in, frozen
// bytes out; lossless re-merge across boundaries; "" keeps summary bytes
// byte-identical when nothing rides)
// ---------------------------------------------------------------------------

/** Entry line: `- write_file src/a.ts (fingerprint 1a2b3c4d)` — tool, target,
 *  and the identity the gate compares a re-sent action against. */
export function pendingActionLine(e: PendingWriteEntry): string {
  return `- ${e.tool} ${e.path} (fingerprint ${e.fingerprint})`;
}

const ENTRY_LINE_RE = /^- (write_file|edit) (\S+) \(fingerprint ([0-9a-f]{8})\)$/;

/** ζ1: the pending-actions block appended to a tier-2 summary. `\n\n` + tag +
 *  a one-line model directive + `- ` entries, oldest-first, capped with the
 *  omission-line protocol. Empty entries → "" (status-quo bytes). Pure. */
export function formatPendingActions(entries: readonly PendingWriteEntry[]): string {
  if (entries.length === 0) return "";
  const dropped = Math.max(0, entries.length - PENDING_ACTIONS_CAP);
  const kept = dropped > 0 ? entries.slice(dropped) : [...entries];
  const lines = [
    ...(dropped > 0 ? [`[... ${dropped} older pending writes omitted]`] : []),
    ...kept.map(pendingActionLine),
  ];
  return `\n\n<${PENDING_ACTIONS_TAG}>\n[these writes were dispatched but their results never arrived (crash or interrupt) — the files' current on-disk state is unknown; verify before rewriting]\n${lines.join("\n")}\n</${PENDING_ACTIONS_TAG}>`;
}

/** ζ1: parse the ledger back out of a frozen summary. Takes the LAST complete
 *  block; only well-formed `- ` entry lines are facts (the directive line and
 *  the omission line are presentation). Undefined when no block rides the
 *  text. Pure. */
export function parsePendingActionsFromSummary(content: string): PendingWriteEntry[] | undefined {
  const open = `<${PENDING_ACTIONS_TAG}>`;
  const start = content.lastIndexOf(open);
  if (start === -1) return undefined;
  const end = content.indexOf(`</${PENDING_ACTIONS_TAG}>`, start);
  if (end === -1) return undefined;
  const out: PendingWriteEntry[] = [];
  for (const raw of content.slice(start + open.length, end).split("\n")) {
    const m = ENTRY_LINE_RE.exec(raw.trim());
    if (m === null) continue;
    const tool = m[1] as WriteActionTool;
    const path = m[2];
    const fingerprint = m[3];
    if (path === undefined || fingerprint === undefined) continue;
    out.push({ tool, path, fingerprint });
  }
  return out.length > 0 ? out : undefined;
}

/** ζ1: the composed pending-actions section for a tier-2 boundary — the
 *  replaced region (prior + span) folded through the ONE extraction seam,
 *  formatted for the frozen summary. "" when the region carries no pending
 *  writes (status-quo bytes — the three tier-2 composers append it
 *  unconditionally and old sessions' summaries stay byte-identical). */
export function pendingActionsSection(prior: readonly AgentMessage[], span: readonly AgentMessage[]): string {
  return formatPendingActions(pendingLedgerOf([...prior, ...span]));
}

// ---------------------------------------------------------------------------
// The stale-write gate (写入路径查未决表)
// ---------------------------------------------------------------------------

/** ζ1: the model-facing rejection (the tool prefixes its own `failed:` head).
 *  English like its sibling freshness-gate messages; actionable in one read. */
export const STALE_PENDING_WRITE_RESULT =
  "this file has a write whose result never arrived (crash or interrupt) — its outcome and the current on-disk state are unknown to you. Read the file first; if you are re-sending the SAME action, send identical arguments";

/** The write tools' seam: consult the pending ledger before side effects.
 *  Constructed by the tool-set assembly with a LIVE chain accessor and a
 *  re-grounding oracle; absent (or failing) = fail-open, never blocks. */
export interface PendingWriteGate {
  /** The rejection text, or undefined when the write may proceed. */
  staleFor(tool: WriteActionTool, pathArg: string, args: Record<string, unknown>, absPath: string): string | undefined;
}

/** ζ1: the gate. `getChain` is the live message chain (the same accessor the
 *  frontends hand contextProbe); `hasFreshRead` reports whether the session's
 *  read-state table holds the abs path (a read SINCE THIS PROCESS started —
 *  the freshness gate re-arms on it, and together they close both cases: if
 *  the pending write LANDED, the mtime moved and freshness refuses; if it
 *  never landed, the mental model is true and the write is safe).
 *  Fail-open everywhere: no chain, a throwing accessor, or a malformed chain
 *  read as "no ledger" — the write proceeds (freshness remains the first
 *  gate; a damaged pending table must never block writes). */
export function createPendingWriteGate(
  getChain: () => readonly AgentMessage[] | undefined,
  hasFreshRead: (absPath: string) => boolean,
): PendingWriteGate {
  return {
    staleFor(tool, pathArg, args, absPath) {
      try {
        const chain = getChain();
        if (chain === undefined) return undefined;
        const target = normalizePathArg(pathArg);
        const ledger = pendingLedgerOf(chain, target);
        const fingerprint = argumentFingerprint(args);
        // pendingLedgerOf(…, target) is already path-filtered; identity is the
        // (tool, path, fingerprint) triple — a re-sent IDENTICAL action is the
        // redo the verify-first flow wants (allow); anything else to the same
        // target rides a stale mental model (block).
        const blocking = ledger.some((e) => e.tool !== tool || e.fingerprint !== fingerprint);
        if (!blocking) return undefined;
        // A fresh read in THIS process re-grounded the file (cross-agent
        // writes share the session's read-state table; the freshness gate
        // still refuses if the disk moved past that read).
        if (hasFreshRead(absPath)) return undefined;
        return STALE_PENDING_WRITE_RESULT;
      } catch {
        return undefined; // fail-open — 表损坏不阻塞
      }
    },
  };
}
