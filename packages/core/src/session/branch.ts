// M53 §1/§2 — session branching: the pure tree algebra over the append-only
// JSONL. Messages carry optional uuid/parentUuid (assigned by the frontend
// that pushes them); a message WITHOUT a parentUuid follows the previous
// entry in file order, so pre-M53 sessions and the loop's own assistant/tool
// pushes need no ids to stay one linear trunk. A BRANCH user message is the
// only thing that ever carries a parentUuid pointing backwards past live
// entries — that one link is what forks the tree.
//
// Everything here is pure over readonly message lists (testable without a
// store); the driver owns the I/O (reading the JSONL for /tree //switch,
// slicing the active chain on an armed /edit).
import type { AgentMessage } from "../types.js";
import { messageEntryId } from "../compaction.js";
import { truncateSafe } from "../text-truncate.js";
import type { SessionEntry } from "./store.js";

/** The stable key of one node: its uuid when assigned, else the compaction
 *  entry-id fingerprint (role + length + content hash). Legacy sessions
 *  thereby get keys without migration; identical-content collisions resolve
 *  to the NEAREST preceding match (see parentIndex). */
export function nodeKey(m: AgentMessage): string {
  return m.uuid ?? messageEntryId(m);
}

/** The key a child's parentUuid refers to, resolved against a message list.
 *  M53 review fix — two passes: a link naming a UUID resolves FIRST to the
 *  node that carries it (a uuid names exactly one node, so an
 *  identical-content sibling whose entry-id fingerprint collides with the
 *  link string cannot shadow it); only when no uuid-bearing node matches does
 *  the fingerprint pass run — there a duplicate resolves to the latest copy
 *  before the child (nearest-preceding), preferring a match after the last
 *  node the chain already passed through rather than jumping further back.
 *  Falls back to the linear predecessor (file order) when the link names
 *  nothing — an append-only store never rewrites entries, so an unresolvable
 *  link can only mean a hand-edited or truncated file. Returns -1 for a
 *  root. */
export function parentIndex(messages: readonly AgentMessage[], childIndex: number): number {
  const child = messages[childIndex];
  if (child === undefined) return -1;
  const link = child.parentUuid;
  if (link !== undefined) {
    for (let i = childIndex - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m !== undefined && m.uuid === link) return i;
    }
    for (let i = childIndex - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m !== undefined && m.uuid === undefined && messageEntryId(m) === link) return i;
    }
  }
  return childIndex - 1;
}

/** The chain ending at `leafIndex`: walk parents to the root, returned in
 *  conversation order. The ACTIVE chain of a session file is the chain ending
 *  at its last message (resume walks exactly this). */
export function chainEndingAt(messages: readonly AgentMessage[], leafIndex: number): AgentMessage[] {
  const out: AgentMessage[] = [];
  let i = leafIndex;
  while (i >= 0) {
    const m = messages[i];
    if (m === undefined) break;
    out.unshift(m);
    i = parentIndex(messages, i);
  }
  return out;
}

/** The active chain of a message list: the chain ending at its last entry. */
export function activeChain(messages: readonly AgentMessage[]): AgentMessage[] {
  if (messages.length === 0) return [];
  return chainEndingAt(messages, messages.length - 1);
}

/** One user turn of the tree (the nodes /edit operates on and /tree renders). */
export interface BranchTurn {
  /** Index into the flat message list. */
  readonly index: number;
  readonly key: string;
  readonly parentKey: string | null;
  /** True when this turn's parent link skips live entries — a fork start. */
  readonly isFork: boolean;
  /** First line of the prompt (rendered preview). */
  readonly preview: string;
}

function firstLine(text: string, cap = 60): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > cap ? `${truncateSafe(line, cap)}…` : line; // 113-A4：分支名帽代理对安全
}

/** Every user turn in file order with its fork classification. */
export function branchTurns(messages: readonly AgentMessage[]): readonly BranchTurn[] {
  const out: BranchTurn[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m === undefined || m.role !== "user") continue;
    const p = parentIndex(messages, i);
    out.push({
      index: i,
      key: nodeKey(m),
      parentKey: p >= 0 && messages[p] !== undefined ? nodeKey(messages[p] as AgentMessage) : null,
      isFork: p >= 0 && p < i - 1,
      preview: firstLine(m.content),
    });
  }
  return out;
}

/** The set of node keys on one chain (membership test for /tree marking). */
export function chainKeySet(chain: readonly AgentMessage[]): ReadonlySet<string> {
  return new Set(chain.map(nodeKey));
}

/** The FULL chain of the branch a turn belongs to: from the turn's index to
 *  the branch's last message (the greatest file index whose chain passes
 *  through the turn) — trailing assistant/tool traffic after the branch's
 *  last user turn included. Returns [] for an unknown key. */
export function chainForTurn(messages: readonly AgentMessage[], turnKey: string): AgentMessage[] {
  let end = -1;
  for (let j = messages.length - 1; j >= 0; j -= 1) {
    if (chainEndingAt(messages, j).some((m) => nodeKey(m) === turnKey)) {
      end = j;
      break;
    }
  }
  if (end === -1) return [];
  return chainEndingAt(messages, end);
}

/** ASCII branch topology: one line per user turn, trunk turns flush, fork
 *  turns indented under their fork point, and the turns of the current leaf
 *  chain marked `←`. Deterministic — byte-pinned by tests. */
export function renderBranchTree(messages: readonly AgentMessage[], currentLeafKey: string | null): string {
  const turns = branchTurns(messages);
  if (turns.length === 0) return "（尚无轮次）"; // ω99-166d-ii: #30（空树占位中文化）
  const current = currentLeafKey === null ? new Set<string>() : chainKeySet(chainForTurn(messages, currentLeafKey));
  const lines: string[] = [];
  for (let i = 0; i < turns.length; i += 1) {
    const t = turns[i];
    if (t === undefined) continue;
    const onCurrent = current.has(t.key);
    const n = i + 1;
    lines.push(
      t.isFork
        ? `  └─ ${n}. ${t.preview}${onCurrent ? "  ←" : ""}`
        : `${n}. ${t.preview}${onCurrent ? "  ←" : ""}`,
    );
  }
  return lines.join("\n");
}

/** A switchable branch: the chain ending at one leaf turn. */
export interface BranchLeaf {
  /** 1-based switch index (file order of the leaf). */
  readonly n: number;
  readonly leafKey: string;
  /** The prompt of the turn where this branch diverges ("" for the trunk root). */
  readonly forkPreview: string;
  /** Total messages on the chain (turns + tool traffic). */
  readonly messageCount: number;
  /** True when this leaf's chain is the given active chain. */
  readonly isCurrent: boolean;
}

/** Every branch (leaf chain) of the tree, in file order of the leaf. A leaf
 *  turn is a user turn no LATER user turn follows on the same chain — the
 *  last turn of every chain, active or abandoned. */
export function listBranchLeaves(
  messages: readonly AgentMessage[],
  activeLeafKey: string | null,
): readonly BranchLeaf[] {
  const turns = branchTurns(messages);
  if (turns.length === 0) return [];
  const active = activeLeafKey === null ? new Set<string>() : chainKeySet(chainForTurn(messages, activeLeafKey));
  // The chain each turn belongs to (FULL chains, trailing traffic included):
  // a turn is a leaf iff no other turn's chain passes through it.
  const chainOf = turns.map((t) => new Set(chainForTurn(messages, t.key).map(nodeKey)));
  const out: BranchLeaf[] = [];
  for (let i = 0; i < turns.length; i += 1) {
    const t = turns[i];
    if (t === undefined) continue;
    // Leaf = no LATER turn's chain contains it (a later turn continuing this
    // chain would contain t's key in its chain set).
    let isLeaf = true;
    for (let j = i + 1; j < turns.length && isLeaf; j += 1) {
      if (chainOf[j]?.has(t.key)) isLeaf = false;
    }
    if (!isLeaf) continue;
    const chain = chainForTurn(messages, t.key);
    // The divergence reference: the nearest ANCESTOR turn of this leaf (the
    // last turn of the shared prefix) — what the branch forked after.
    const chainKeys = chainOf[i] as Set<string>;
    let forkPreview = "";
    for (let j = i - 1; j >= 0; j -= 1) {
      const earlier = turns[j];
      if (earlier !== undefined && chainKeys.has(earlier.key)) {
        forkPreview = earlier.preview;
        break;
      }
    }
    out.push({
      n: out.length + 1,
      leafKey: t.key,
      forkPreview,
      messageCount: chain.length,
      isCurrent: active.has(t.key),
    });
  }
  return out;
}

/** Length of the shared prefix of two chains (by node key). */
export function commonPrefixLength(a: readonly AgentMessage[], b: readonly AgentMessage[]): number {
  let i = 0;
  while (i < a.length && i < b.length && nodeKey(a[i] as AgentMessage) === nodeKey(b[i] as AgentMessage)) i += 1;
  return i;
}

// ---------------------------------------------------------------------------
// M53 §2 — the branch-summary: what the ABANDONED branch did since the fork,
// so switching back does not force the model to re-read everything. Built
// deterministically from the span's tool traffic (no model call), newest
// first, under a 16k retention budget, injected ONCE through the MetaNote
// channel (never persisted as a conversation message).
// ---------------------------------------------------------------------------

/** True when the fork at `forkIndex` predates the chain's compaction
 *  boundary: some summary-marker message sits AFTER the fork on the chain —
 *  the work done since the fork was (partly) swallowed by compaction, so a
 *  switch would lose it entirely without a digest. */
export function forkPredatesCompaction(chain: readonly AgentMessage[], forkIndex: number, summaryMarkerPrefix: string): boolean {
  for (let i = chain.length - 1; i >= forkIndex; i -= 1) {
    const m = chain[i];
    if (m !== undefined && m.role === "user" && m.content.startsWith(summaryMarkerPrefix)) return true;
  }
  return false;
}

/** The retention budget for one branch-summary (the upstream project's 16k). */
export const BRANCH_SUMMARY_BUDGET_CHARS = 16_000;

const FILE_TOOL_NAMES = new Set(["read_file", "write_file", "edit", "glob", "grep"]);

/** One accumulated file activity line's source. */
export interface FileActivity {
  readonly path: string;
  readonly kind: "read" | "write" | "search";
  /** File order of the newest traffic seen for this path. */
  readonly at: number;
}

function argPath(args: Record<string, unknown>): string | undefined {
  const p = args["path"] ?? args["file"] ?? args["pattern"];
  if (typeof p === "string" && p !== "") return p;
  return undefined;
}

/** Collect the span's file activity, newest-visited first, deduped by path. */
export function fileActivityNewestFirst(span: readonly AgentMessage[]): readonly FileActivity[] {
  const byPath = new Map<string, FileActivity & { seq: number }>();
  let seq = 0;
  for (let i = 0; i < span.length; i += 1) {
    const m = span[i];
    if (m === undefined || m.role !== "assistant" || !m.toolCalls) continue;
    for (const tc of m.toolCalls) {
      if (!FILE_TOOL_NAMES.has(tc.name)) continue;
      const path = argPath(tc.arguments);
      if (path === undefined) continue;
      byPath.set(path, {
        path,
        kind: tc.name === "read_file" ? "read" : tc.name === "write_file" || tc.name === "edit" ? "write" : "search",
        at: i,
        seq: seq += 1,
      });
    }
  }
  return [...byPath.values()].sort((a, b) => b.seq - a.seq).map(({ seq: _s, ...rest }) => rest);
}

/** The digest text: activity lines newest-first + the last ask + the last
 *  conclusion, dropping the OLDEST activity lines when over budget. */
export function buildBranchSummary(
  span: readonly AgentMessage[],
  opts: { readonly budgetChars?: number } = {},
): string {
  const budget = opts.budgetChars ?? BRANCH_SUMMARY_BUDGET_CHARS;
  if (span.length === 0) return "";
  const lines: string[] = [`branch-summary: you left a branch that diverged ${span.length} messages ago; what happened there (newest first):`];
  for (const f of fileActivityNewestFirst(span)) {
    lines.push(`- ${f.kind} ${f.path}`);
  }
  for (let i = span.length - 1; i >= 0; i -= 1) {
    const m = span[i];
    if (m !== undefined && m.role === "user" && !m.content.startsWith("[")) {
      lines.push(`- last user request there: ${firstLine(m.content, 200)}`);
      break;
    }
  }
  for (let i = span.length - 1; i >= 0; i -= 1) {
    const m = span[i];
    if (m !== undefined && m.role === "assistant" && !(m.toolCalls && m.toolCalls.length > 0)) {
      lines.push(`- last conclusion there: ${firstLine(m.content, 400)}`);
      break;
    }
  }
  let text = lines.join("\n");
  while (text.length > budget && lines.length > 2) {
    // Newest-first retention: drop the oldest ACTIVITY line (they run newest
    // first, so the candidates sit just before the trailing excerpts).
    let dropped = false;
    for (let i = lines.length - 3; i >= 1; i -= 1) {
      const l = lines[i];
      if (l !== undefined && l.startsWith("- ")) {
        lines.splice(i, 1);
        dropped = true;
        break;
      }
    }
    if (!dropped) break;
    text = lines.join("\n");
  }
  return text;
}

/** The full injected form (envelope + digest), budget-capped. */
export function branchSummaryNote(
  span: readonly AgentMessage[],
  opts: { readonly budgetChars?: number } = {},
): string {
  const digest = buildBranchSummary(span, opts);
  if (digest === "") return "";
  return `<branch-summary>\n${digest}\n</branch-summary>`;
}

// ---------------------------------------------------------------------------
// M53 review fix — branch-aware resume. The JSONL keeps trunk + abandoned +
// branch in file order; a plain linear load flattens them into one
// conversation. The driver therefore records WHICH branch is active as a
// generic session entry (`active_branch {leafKey}`) at /edit branch cuts and
// /switch; load (resolveSession + driver.resume) walks parentUuid from the
// recorded leaf — falling back to the linear-last chain when the entry is
// absent, corrupt, or names a leaf not (yet) on disk.
// ---------------------------------------------------------------------------

/** The session-entry type recording the active branch's leaf key. */
export const ACTIVE_BRANCH_ENTRY_TYPE = "active_branch";

/** The payload of one active_branch entry: the node key (uuid, else the
 *  entry-id fingerprint) of the leaf turn the active chain was cut/switched
 *  at. */
export interface ActiveBranchData {
  readonly leafKey: string;
}

/** The leaf key of the LAST well-formed active_branch entry in a loaded
 *  session (the most recent recording wins), or undefined when the session
 *  recorded none — malformed payloads are skipped, never fatal. */
export function activeBranchLeafKey(entries: readonly SessionEntry[]): string | undefined {
  let leaf: string | undefined;
  for (const e of entries) {
    if ("role" in e || e.type !== ACTIVE_BRANCH_ENTRY_TYPE) continue;
    const data = e.data as Partial<ActiveBranchData> | undefined;
    const k = data?.leafKey;
    if (typeof k === "string" && k !== "") leaf = k;
  }
  return leaf;
}

/** The chain a session resumes to: the recorded branch's chain when its leaf
 *  resolves in the file (chainForTurn prefers the greatest file index whose
 *  chain passes through the leaf — trailing traffic and later continuation
 *  included), else the chain ending at the file's LAST message. Legacy
 *  sessions with no parentUuid links at all are byte-identical under both
 *  paths (every link is linear). */
export function resumeChain(messages: readonly AgentMessage[], leafKey: string | undefined): AgentMessage[] {
  if (leafKey !== undefined) {
    const chain = chainForTurn(messages, leafKey);
    if (chain.length > 0) return chain;
  }
  return activeChain(messages);
}
