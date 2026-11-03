// M49 §1 — the /memory command family (list | del <id> | ok <id>) and the
// next-session pending-review surface. One implementation shared by every
// frontend (driver-level command, REPL, and the one-shot startup notice).
// M55 §A6 adds `edit` — the CONTEXT FILES in $EDITOR (the store itself is
// append-only JSONL and not hand-edit friendly).
//
// 记忆两库收敛（docs/specs/memory-system.md 实施裁决的后续弧）：M49 人审门
// 合流为新库（.wudao/memory/）的 confidence 路径——本命令面的审核动词
// （list/ok/del）与 boot 待审提醒（surfacePendingReview）改读写新库；
// ok = append 同 id 的 confirmed 行、del = 新库 tombstone forget。旧库
// .wudao/memory.jsonl 冻结为只读历史（store 本体零改动——回滚线；回滚=
// 还原本文件+去 guard 接线）。dream 动词随调度停用（WUDAO_M49_LEGACY=1
// 可回滚启用）。
import { truncateSafe } from "@wudao-org/core"; // 113-A4
import { openSessionMemoryStore, openMemoryStore } from "./store.js";
// 永续 v6 弧 A（reef C3）：被拦学习输入的可见面——list 尾行报「已拦 N 条」，
// 绝不静默丢（台账 .wudao/memory-blocked.jsonl 全文可查）。
import { blockedLearningCountAt, blockedLearningHint } from "./guard.js";
import { runDreamVerb } from "./dream.js";
import { legacyMemoryMigrated, legacyMemorySchedulingEnabled } from "./migrate.js";
import {
  longtermMemoryAuditRow,
  markLongtermMemorySurfaced,
  openLongtermMemoryStore,
  readLongtermMemorySurfaced,
} from "../longterm-memory.js";
import type { LongtermMemoryAuditRow } from "../longterm-memory.js";
import type { ModelClient } from "@wudao-org/core";
import type { AgentRegistry } from "../agents/index.js";

/** ω-4f: the /memory dream verb's context — the session model + registry the
 *  consolidation runs through (each frontend threads its own when present). */
export interface MemoryDreamContext {
  readonly model: ModelClient;
  readonly registry?: AgentRegistry;
}

/** The command surface's LEGACY store — the SESSION-configured one when set,
 *  else the M49 default（旧库冻结历史的读取面——仅 /memory dream 回滚态用）。 */
function storeFor(workspaceRoot: string) {
  return openSessionMemoryStore(workspaceRoot) ?? openMemoryStore(workspaceRoot);
}

/** The merged audit store — 新库（人审队列与 confirmed 面都在这里）。runtime
 *  单例在场时经 longtermMemoryRuntimeFor 的句柄（见调用点）。 */
import { formatPendingReview, recallMemories, RECALL_POOL_CAP } from "./recall.js";
import { runMemoryEditCommand } from "../commands/memory-edit.js";
import { longtermMemoryRuntimeFor } from "../longterm-memory.js";

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${truncateSafe(text, max - 1)}…`;
}

/** The /memory list body: one line per entry (pending ones marked). */
export function formatMemoryList(entries: readonly { id: string; kind: string; scope: string; content: string; tags: readonly string[]; hits: number; status: string }[]): string {
  if (entries.length === 0) return "(memory store is empty — memory_write saves assessed notes to .wudao/memory.jsonl)";
  const lines = entries.map(
    (e) => `${e.status === "pending" ? "⏳" : "✓"} ${e.id} [${e.kind}/${e.scope}]${e.tags.length > 0 ? ` (${e.tags.join(",")})` : ""} — ${truncate(e.content, 80)} [hits ${e.hits}]`,
  );
  return lines.join("\n");
}

/** Execute `/memory <args>` against the workspace store. Returns the notice
 *  text (never throws — failures surface as ⚠️ lines). `dream` (ω-4f) supplies
 *  the session model/registry the `dream` verb needs; without it the verb
 *  explains what is missing instead of spawning anything. */
export async function runMemoryCommand(workspaceRoot: string, args: string, dream?: MemoryDreamContext): Promise<string> {
  const trimmed = args.trim();
  const verb = trimmed.split(/\s+/)[0] ?? "";
  const rest = trimmed.slice(verb.length).trim();
  // 合流审核面：新库单句柄（runtime 在场用它的——core store 是 per-handle
  // 索引，命令道与工具道必须共一个索引）。
  const auditStore = longtermMemoryRuntimeFor()?.store ?? openLongtermMemoryStore(workspaceRoot);
  if (trimmed === "" || verb === "list") {
    // 永续 v6 弧 A：拦截计数跟 PHYSICAL 工作区台账（与 web memoryList 面
    // 同源）；0 条=零噪音不加行。读失败静默省略（列表本身永不因台账坏而死）。
    const blocked = await blockedLearningCountAt(workspaceRoot).catch(() => 0);
    const entries: readonly LongtermMemoryAuditRow[] = auditStore.list({ includePending: true }).map((e) => longtermMemoryAuditRow(e));
    const body = blocked > 0 ? `${formatMemoryList(entries)}\n${blockedLearningHint(blocked)}` : formatMemoryList(entries);
    // 迁移落定后旧库段落不再展示（旧库=冻结历史，展示即重复）；过渡期
    // （marker 未落）诚实双列。
    const migrated = await legacyMemoryMigrated(workspaceRoot).catch(() => true);
    if (migrated) return body;
    const legacy = await storeFor(workspaceRoot).load().then((rows) => formatMemoryList(rows)).catch(() => "(旧记忆系统读取失败)");
    return `${body}\n—— 旧记忆系统（M49 — .wudao/memory.jsonl，冻结历史）——\n${legacy}`;
  }
  if (verb === "del") {
    if (rest === "") return "用法：/memory del <id>——删除一条记忆"; // ω99-166d-i: #12
    if (!(auditStore.list({ includePending: true }).some((e) => e.id === rest))) {
      return `no memory entry "${rest}" (/memory list)`;
    }
    await auditStore.forget(rest).catch(() => {});
    return `memory ${rest} deleted`;
  }
  if (verb === "ok") {
    if (rest === "") return "用法：/memory ok <id>——确认一条待审记忆"; // ω99-166d-i: #13
    const target = auditStore.listPending().find((e) => e.id === rest);
    if (target === undefined) return `no pending memory entry "${rest}" (/memory list)`;
    // pending → confirmed：append 同 id 的 confirmed 行（后行胜，useCount 不动）。
    await auditStore.save({ kind: target.kind, text: target.text, tags: [...target.tags], confidence: "confirmed" });
    return `memory ${rest} confirmed (active)`;
  }
  // M55 §A6: edit the CONTEXT FILES (WUDAO.md/AGENTS.md/CLAUDE.md) in
  // $EDITOR — the store is id-addressed JSONL, not a hand-edit surface.
  if (verb === "edit") {
    return runMemoryEditCommand(workspaceRoot);
  }
  // ω-4f (design 84 §3(f)): the manual override — runs one consolidation NOW,
  // bypassing only the due-gates (never the completion gate/audit/receipt).
  // 记忆两库收敛：dream 随 M49 调度停用（产物会写进冻结的旧库=不可见的
  // 模型调用开销）；WUDAO_M49_LEGACY=1 回滚态原样可跑。
  if (verb === "dream") {
    if (!legacyMemorySchedulingEnabled()) {
      return "dream 已随记忆两库收敛停用——长期记忆走 memory_save 与会话终了沉淀（待审项 /memory list 确认）；WUDAO_M49_LEGACY=1 可回滚启用旧机制";
    }
    if (dream === undefined) {
      return "用法：/memory dream——需要会话模型 + agent registry（此前端未接线）"; // ω99-166d-i: #14
    }
    return runDreamVerb({ workspaceRoot, model: dream.model, registry: dream.registry });
  }
  return "用法：/memory [list|del <id>|ok <id>|edit|dream]"; // ω99-166d-i: #15
}

/** The next-session surface for pending entries: returns the one-time notice
 *  (and marks them surfaced) — undefined when nothing awaits review.
 *  合流后 pending 在新库；一次性（surfaced）簿记走新库目录的
 *  review-surfaced.json（M49 surfaced 语义的收敛落点）。 */
export async function surfacePendingReview(workspaceRoot: string): Promise<string | undefined> {
  const store = longtermMemoryRuntimeFor()?.store ?? openLongtermMemoryStore(workspaceRoot);
  const surfaced = await readLongtermMemorySurfaced(workspaceRoot);
  const pending = store.listPending().filter((e) => !surfaced.has(e.id));
  if (pending.length === 0) return undefined;
  await markLongtermMemorySurfaced(workspaceRoot, pending.map((e) => e.id)).catch(() => {});
  return formatPendingReview(pending.map((e) => longtermMemoryAuditRow(e, surfaced)));
}

/** The session's recall runtime: caches the ACTIVE pool (refreshed at startup
 *  and after each run — writes land between runs), answers the driver's
 *  synchronous recall seam from the cache, and bumps `hits` fire-and-forget
 *  (shadow-ranking telemetry only). 夜移 015 (#22): the pool is capped to the
 *  newest RECALL_POOL_CAP entries, and hits counts ONCE per entry per session
 *  — alreadySurfaced's honest adaptation. Real CC filters surfaced memories
 *  from re-injection because injected memories STAY in the conversation;
 *  wudao's MetaNote channel is per-run ephemeral (projection-only, never
 *  persisted), so re-injection each run is the design — what must not repeat
 *  is the telemetry count.
 *  记忆两库收敛：迁移落定后本 runtime 恒空池——旧库冻结（存量已复制进新库，
 *  再注入=同一记忆双份提示词），召回唯一来源=新库 boot 注入 + memory_search。
 *  迁移前（过渡态）行为原样。 */
export function createMemoryRuntime(workspaceRoot: string): {
  readonly refresh: () => Promise<void>;
  readonly recall: (prompt: string) => string | undefined;
} {
  let pool: readonly (import("./store.js").MemoryEntry)[] = [];
  let frozenEmpty = false; // 迁移落定 → 恒空（refresh 零读盘）
  const bumped = new Set<string>();
  // M62 §7: the runtime reads the SESSION-configured store (memoryEnabled /
  // memoryDirectory) — disabled → an always-empty pool, zero recall notes.
  const store = openSessionMemoryStore(workspaceRoot);
  return {
    async refresh() {
      try {
        if (frozenEmpty) return;
        if (await legacyMemoryMigrated(workspaceRoot)) {
          frozenEmpty = true;
          pool = [];
          return;
        }
        // 夜移 015: newest RECALL_POOL_CAP entries (active() is file order =
        // append order, so the tail is the newest).
        pool = (store !== undefined ? await store.active() : []).slice(-RECALL_POOL_CAP);
      } catch {
        pool = []; // a broken store must never break prompting
      }
    },
    recall(prompt: string): string | undefined {
      const r = recallMemories({ entries: pool, prompt });
      if (r.selected.length > 0 && store !== undefined) {
        const fresh = r.selected.filter((e) => !bumped.has(e.id)).map((e) => e.id);
        for (const id of fresh) bumped.add(id);
        if (fresh.length > 0) void store.bumpHits(fresh).catch(() => {});
      }
      return r.note;
    },
  };
}
