// M49 §1 — the /memory command family (list | del <id> | ok <id>) and the
// next-session pending-review surface. One implementation shared by every
// frontend (driver-level command, REPL, and the one-shot startup notice).
// M55 §A6 adds `edit` — the CONTEXT FILES in $EDITOR (the store itself is
// append-only JSONL and not hand-edit friendly).
import { truncateSafe } from "@wudao/core"; // 113-A4
import { openSessionMemoryStore, openMemoryStore } from "./store.js";
// 永续 v6 弧 A（the upstream project C3）：被拦学习输入的可见面——list 尾行报「已拦 N 条」，
// 绝不静默丢（台账 .wudao/memory-blocked.jsonl 全文可查）。
import { blockedLearningCountAt, blockedLearningHint } from "./guard.js";
import { runDreamVerb } from "./dream.js";
import type { ModelClient } from "@wudao/core";
import type { AgentRegistry } from "../agents/index.js";

/** ω-4f: the /memory dream verb's context — the session model + registry the
 *  consolidation runs through (each frontend threads its own when present). */
export interface MemoryDreamContext {
  readonly model: ModelClient;
  readonly registry?: AgentRegistry;
}

/** The command surface's store: the SESSION-configured one when set, else the
 *  M49 default (commands stay usable even when the tools are disabled). */
function storeFor(workspaceRoot: string) {
  return openSessionMemoryStore(workspaceRoot) ?? openMemoryStore(workspaceRoot);
}
import { formatPendingReview, recallMemories, RECALL_POOL_CAP } from "./recall.js";
import { runMemoryEditCommand } from "../commands/memory-edit.js";

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
  if (trimmed === "" || verb === "list") {
    const store = await storeFor(workspaceRoot);
    // 永续 v6 弧 A：拦截计数跟 PHYSICAL 工作区台账（与 web memoryList 面
    // 同源）；0 条=零噪音不加行。读失败静默省略（列表本身永不因台账坏而死）。
    const blocked = await blockedLearningCountAt(workspaceRoot).catch(() => 0);
    const entries = await store.load();
    return blocked > 0 ? `${formatMemoryList(entries)}\n${blockedLearningHint(blocked)}` : formatMemoryList(entries);
  }
  if (verb === "del") {
    if (rest === "") return "用法：/memory del <id>——删除一条记忆"; // ω99-166d-i: #12
    const store = await storeFor(workspaceRoot);
    return (await store.remove(rest)) ? `memory ${rest} deleted` : `no memory entry "${rest}" (/memory list)`;
  }
  if (verb === "ok") {
    if (rest === "") return "用法：/memory ok <id>——确认一条待审记忆"; // ω99-166d-i: #13
    const store = await storeFor(workspaceRoot);
    return (await store.confirm(rest)) ? `memory ${rest} confirmed (active)` : `no pending memory entry "${rest}" (/memory list)`;
  }
  // M55 §A6: edit the CONTEXT FILES (WUDAO.md/AGENTS.md/CLAUDE.md) in
  // $EDITOR — the store is id-addressed JSONL, not a hand-edit surface.
  if (verb === "edit") {
    return runMemoryEditCommand(workspaceRoot);
  }
  // ω-4f (design 84 §3(f)): the manual override — runs one consolidation NOW,
  // bypassing only the due-gates (never the completion gate/audit/receipt).
  if (verb === "dream") {
    if (dream === undefined) {
      return "用法：/memory dream——需要会话模型 + agent registry（此前端未接线）"; // ω99-166d-i: #14
    }
    return runDreamVerb({ workspaceRoot, model: dream.model, registry: dream.registry });
  }
  return "用法：/memory [list|del <id>|ok <id>|edit|dream]"; // ω99-166d-i: #15
}

/** The next-session surface for pending entries: returns the one-time notice
 *  (and marks them surfaced) — undefined when nothing awaits review. */
export async function surfacePendingReview(workspaceRoot: string): Promise<string | undefined> {
  const store = storeFor(workspaceRoot);
  const pending = await store.pendingReview();
  if (pending.length === 0) return undefined;
  await store.markSurfaced(pending.map((e) => e.id));
  return formatPendingReview(pending);
}

/** The session's recall runtime: caches the ACTIVE pool (refreshed at startup
 *  and after each run — writes land between runs), answers the driver's
 *  synchronous recall seam from the cache, and bumps `hits` fire-and-forget
 *  (shadow-ranking telemetry only). 夜移 015 (#22): the pool is capped to the
 *  newest RECALL_POOL_CAP entries, and hits counts ONCE per entry per session
 *  — alreadySurfaced's honest adaptation. Real the upstream formatfilters surfaced memories
 *  from re-injection because injected memories STAY in the conversation;
 *  wudao's MetaNote channel is per-run ephemeral (projection-only, never
 *  persisted), so re-injection each run is the design — what must not repeat
 *  is the telemetry count. */
export function createMemoryRuntime(workspaceRoot: string): {
  readonly refresh: () => Promise<void>;
  readonly recall: (prompt: string) => string | undefined;
} {
  let pool: readonly (import("./store.js").MemoryEntry)[] = [];
  const bumped = new Set<string>();
  // M62 §7: the runtime reads the SESSION-configured store (memoryEnabled /
  // memoryDirectory) — disabled → an always-empty pool, zero recall notes.
  const store = openSessionMemoryStore(workspaceRoot);
  return {
    async refresh() {
      try {
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
