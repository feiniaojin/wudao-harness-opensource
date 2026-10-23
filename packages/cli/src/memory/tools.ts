// M49 §1 — the memory tool surface. `memory_write` runs every payload through
// the store's assessed write (auto vs pending-review — the tool NEVER bypasses
// the gate, so §2's background review inherits it for free); `memory_search`
// is the read-only lookup (the ONLY memory tool a child set carries). Both are
// fail-closed buildTool tools; memory_write is deliberately NOT read-only.
import { buildTool, type Tool } from "@wudao/core";
import type { MemoryStore, MemoryKind, MemoryScope } from "./store.js";
import { tokenSet } from "../tokenize.js";

const KIND_ENUM: readonly MemoryKind[] = ["fact", "preference", "skill_note"];
const SCOPE_ENUM: readonly MemoryScope[] = ["project", "user"];

export interface MemoryToolsOptions {
  readonly store: MemoryStore;
  /** true → emit only memory_search (the child / read-only spelling). */
  readonly readOnly?: boolean;
}

export function createMemoryWriteTool(store: MemoryStore): Tool {
  return buildTool({
    name: "memory_write",
    description:
      "Save a durable note to the workspace memory store (.wudao/memory.jsonl). Every write is ASSESSED: short, non-sensitive, novel, project-scope notes save immediately; anything else (including ALL user-scope notes) queues for one-time human review instead. Keep content ≤500 chars, never include secrets/credentials.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", description: "Entry kind.", enum: [...KIND_ENUM] },
        content: { type: "string", description: "The note itself (≤500 chars; one self-contained fact/preference/skill note)." },
        scope: { type: "string", description: "project (default) or user — user-scope always needs review.", enum: [...SCOPE_ENUM] },
        tags: { type: "array", description: "Short lowercase tags aiding recall (e.g. build, testing).", items: { type: "string" } },
      },
      required: ["kind", "content"],
      additionalProperties: false,
    },
    async execute(args) {
      const kind = KIND_ENUM.includes(args.kind as MemoryKind) ? (args.kind as MemoryKind) : undefined;
      if (kind === undefined) {
        return { content: `memory_write failed: kind must be one of ${KIND_ENUM.join("|")}`, isError: true };
      }
      const content = typeof args.content === "string" ? args.content.trim() : "";
      if (content === "") return { content: "memory_write failed: content must be a non-empty string", isError: true };
      const scope = SCOPE_ENUM.includes(args.scope as MemoryScope) ? (args.scope as MemoryScope) : "project";
      const tags = Array.isArray(args.tags) ? args.tags.filter((t): t is string => typeof t === "string" && t.trim() !== "").map((t) => t.trim().toLowerCase()).slice(0, 8) : [];
      try {
        const result = await store.write({ kind, content, scope, tags });
        // 永续 v6 弧 A（reef C3）：被拦=未入库（拦下的密钥/注入形状不落
        // 台账、也不进 pending），回执诚实说「已拦」而非「已排队」。
        if (!result.ok) {
          return { content: `memory_write 已拦下：${result.reasons.join("；")} — 内容未入库（可疑学习输入记录在拦截清单，记忆面板可见）`, isError: true };
        }
        return result.decision === "auto"
          ? { content: `memory saved: ${result.entry.id} (active)` }
          : { content: `memory queued for review: ${result.entry.id} (pending — the user confirms next session; reasons: ${result.reasons.join("; ")})` };
      } catch (err) {
        return { content: `memory_write failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  });
}

export function createMemorySearchTool(store: MemoryStore): Tool {
  return buildTool({
    name: "memory_search",
    description:
      "Search the workspace memory store (.wudao/memory.jsonl) by keyword/tag overlap. Returns the best-matching saved notes (id, kind, content, tags). Read-only.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text query; CJK and latin both supported." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(args) {
      const query = typeof args.query === "string" ? args.query : "";
      if (query.trim() === "") return { content: "memory_search failed: query must be a non-empty string", isError: true };
      const entries = await store.active();
      if (entries.length === 0) return { content: "(memory store is empty)" };
      const q = tokenSet(query);
      const scored = entries
        .map((e) => {
          const content = tokenSet(e.content);
          let score = 0;
          for (const t of content) if (q.has(t)) score += 1;
          for (const tag of e.tags) if (q.has(tag.toLowerCase()) || query.toLowerCase().includes(tag.toLowerCase())) score += 2;
          return { e, score };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score || (a.e.id < b.e.id ? -1 : 1))
        .slice(0, 8);
      if (scored.length === 0) return { content: `(no memories match "${query}")` };
      return { content: scored.map((s) => `${s.e.id} [${s.e.kind}/${s.e.scope}] ${s.e.content}${s.e.tags.length > 0 ? ` (tags: ${s.e.tags.join(", ")})` : ""}`).join("\n") };
    },
  });
}

/** The memory tool set: both at top level, search-only for children. */
export function createMemoryTools(opts: MemoryToolsOptions): Tool[] {
  return opts.readOnly === true ? [createMemorySearchTool(opts.store)] : [createMemoryWriteTool(opts.store), createMemorySearchTool(opts.store)];
}
