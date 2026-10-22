// ω99-3a — /refine: the session refiner (the upstream project Continual Harness,
// wudao-native stage 1). The THIRD entry into memory formation, beside the
// review fork (M49, transcript→assessed entries) and Dream (ω-4f, ledger→
// curated ledger): /refine is ON-DEMAND, CURRENT-SESSION, EVIDENCE-CARRYING.
// One LLM call sees the trajectory tail + a memory overview and proposes
// precise create/update/delete edits (kinds: harness|preference|skill_note).
//
// 三条安全纪律（红线，改动前重读）:
//  1. create 必 pending —— applyRefinement 的 create 一律走 store.write 的
//     forcePending: true。LLM 策展不过人审永不落 active（M63 密钥纪律同款
//     精神: 机器建议, 人拍板）。
//  2. update 必转 pending —— store.update 的语义就是"写 v+1 并转 pending",
//     /memory ok 之前新版不进 recall 池。
//  3. delete 只建议不执行 —— LLM 没有删除权。receipt 列出 id, 删除永远是
//     人的 /memory del <id>。防的是 LLM 误删（the upstream project 把删除权留给
//     rollback, wudao 更保守: 连 rollback 的 delete 逆推也只对 create 生效）。
//
// M24 (cache): /refine rides its OWN one-shot prompt (fresh system prompt,
// no prefix fork), so the session's cached bytes are untouched — zero cache
// cost, exactly like Dream's fresh child. ω-3b (stage 2) would add the
// deterministic prompt-tail section + the one-cold-prefix compensation.
//
// 永续 v6 弧 A（the upstream project C3）——学习入口防污染在本文件的两处落点：①轨迹嵌入
// 加 nonce 围栏（会话文本里的工具输出/粘贴内容无法提前闭合围栏冒充提示词
// 作者写「## Instructions」段——围栏只进本 fresh-child 提示词，M24 零代价，
// 与上方声明同款）；②提案 create/update 过 store 的块档门（凭据值/指令
// 覆盖形状未入库即拦，回执行诚实标注 × blocked——整案拒绝纪律不变：单条
// 被拦只丢那一条的落地，其余 edits 照常执行并各自留痕）。
import { truncateSafe } from "@wudao/core"; // 113-A4
import { randomBytes } from "node:crypto";
import type { AgentMessage, ModelClient } from "@wudao/core";
import { openMemoryStore, openSessionMemoryStore, MEMORY_MAX_CONTENT_CHARS, isHeldOutEntry } from "./store.js";
import type { MemoryKind, MemoryStore, MemoryEntry } from "./store.js";
import { appendRefinementAuditAt } from "./refinements.js";
import type { RefineEdit } from "./refinements.js";
import { fenceUntrusted } from "./guard.js";

/** The frontend's thread into the session: the model to plan through and the
 *  live trajectory. A frontend without a resident model passes nothing and
 *  gets the usage line (the dream-verb precedent). */
export interface RefineContext {
  readonly model: ModelClient;
  readonly messages: readonly AgentMessage[];
}

/** One model-proposed edit (pre-validation shape — fields optional until
 *  validateProposal has spoken). */
export interface ProposedEdit {
  readonly action: "create" | "update" | "delete";
  readonly id?: string;
  readonly kind?: MemoryKind;
  readonly content?: string;
  readonly tags?: readonly string[];
  readonly evidence?: string;
}

/** The validated proposal: what one /refine run wants to do. */
export interface RefineProposal {
  readonly summary: string;
  readonly rationale: string;
  readonly expectedOutcome: string;
  readonly edits: readonly ProposedEdit[];
}

/** The trajectory tail budget (98c's slice size; the upstream project refinement.ts
 *  ships the whole trajectory, wudao caps it like Dream caps its embed). */
export const REFINE_TRAJECTORY_CHARS = 80_000;
/** Per-tool-result truncation inside the serialized trajectory. */
const REFINE_TOOL_RESULT_CHARS = 400;
/** Overview shape: first N entries per kind, each truncated (98c 限流格式,
 *  the Dream embed discipline — the model edits the real ledger, not a
 *  stale mental model, but bounded). */
const REFINE_OVERVIEW_PER_KIND = 6;
const REFINE_OVERVIEW_ENTRY_CHARS = 180;
/** Whole-case edit ceiling — one refine must not rewrite the personality. */
export const REFINE_MAX_EDITS = 5;
/** The sentinel summary planRefinement returns when validation failed (the
 *  rejected-shape contract: never throws, edits always []). */
export const REFINE_REJECTED_SUMMARY = "proposal rejected";

/** The proposer's fixed system prompt (中文注释风格照 review.ts 的
 *  REVIEW_PROMPT: 中文定调 + 英文精确规格). Demands ONE JSON object, the
 *  exact edit shape, evidence per edit, minimal edits, and the no-op
 *  escape hatch. Mirrors the upstream project refinement.ts:123-173's four rules
 *  (minimal edits / evidence / scope policy / base-prompt immutability →
 *  wudao's映射: kind 禁 fact, ≤5 edits, ≤500 chars). */
export const REFINE_SYSTEM_PROMPT = [
  "你是 wudao 的 /refine 会话精炼器（Continual Harness）：从当前会话轨迹提炼值得持久化的操作性笔记, 修正既有过时笔记。",
  "Curate the CURRENT memory store from the trajectory below. This is precision curation, not summarization: emit the smallest set of create/update/delete edits that captures durable operational lessons (how the agent should work: tool lessons, plan-gate timing, workflow preferences) — NOT project facts, NOT one-off details.",
  'Output JSON ONLY — exactly this shape, no prose, no code fence: {"summary":"one sentence","rationale":"why these edits are justified by trajectory evidence","expectedOutcome":"what should improve and how to validate it","edits":[{"action":"create|update|delete","kind":"harness|preference|skill_note","id":"existing id (update/delete only)","content":"<=500 chars, self-contained","tags":["short-lowercase"],"evidence":"the trajectory observation supporting this edit"}]}',
  "Rules: kind is harness|preference|skill_note ONLY — never fact (project facts go through the background review path, not /refine). AT MOST 5 edits; prefer one precise edit over a rewrite. update/delete MUST cite an existing id from the overview. Every edit carries evidence quoting or pointing at a concrete trajectory observation — no evidence, no edit. Never include secrets or credentials. If nothing qualifies, return exactly {\"summary\":\"no changes needed\",\"edits\":[]}.",
  // ω99-7: qm consolidation.ts:29-45 的四条动作规则并入 —— 决定"动哪条"的优先序。
  "Curation rules: prefer UPDATE over DELETE+create when a note has evolved or two notes should merge (update one, delete the other). Keep entries atomic — one self-contained lesson each; split a compound note into one update plus creates. Suggest deleting entries that are stale, contradicted by newer evidence, near-duplicates, or trivially derivable from others. Suggest deleting look-uppable system mechanics (endpoints, plumbing, state-file paths, tool invocation details), but keep user-stated conventions about them and the existence-level fact for a standing system the user relies on (a cron, a watcher, an integration).",
].join("\n");

// ---------------------------------------------------------------------------
// Truncation-aware JSON extraction (the upstream project refinement.ts:570-631 思路,
// wudao 收敛为"不 throw, 全败 → undefined"): ① 直接 parse; ② 剥 ```json 围栏;
// ③ 首个 `{` 起做字符串感知的大括号平衡扫描, 深度归零处截断再 parse ——
// 轨迹尾被输出预算截断时, 前面已完整的对象仍能被救回。
// ---------------------------------------------------------------------------

/** String/escape-aware brace-balance scan: returns the substring from `start`
 *  through the `}` that brings the running depth back to zero (the FIRST
 *  complete object), or undefined when it never re-balances (truncated) or
 *  closes before opening (malformed). Braces inside string literals never
 *  count. */
function balancedObjectAt(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
      if (depth < 0) return undefined;
    }
  }
  return undefined;
}

/** Pure: pull the proposal JSON out of a model reply. Never throws — a
 *  reply with no recoverable object yields undefined (the caller turns that
 *  into the rejected-shape proposal). */
export function extractProposalJson(text: string): unknown {
  const trimmed = text.trim();
  // ① the reply is the JSON.
  if (trimmed !== "") {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through
    }
  }
  // ② a ```json fence around it.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1] !== undefined) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // fall through
    }
  }
  // ③ prose-wrapped (or fence-wrapped-but-sloppy): balance-scan from the
  // first `{` and parse the first complete object.
  const start = trimmed.indexOf("{");
  if (start !== -1) {
    const candidate = balancedObjectAt(trimmed, start);
    if (candidate !== undefined) {
      try {
        return JSON.parse(candidate);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Whole-case validation (the upstream project :673-714 validateEdit 的整案版: 动词
// 非法/形状不对 → 整案拒绝, 绝不静默丢条目).
// ---------------------------------------------------------------------------

export type ValidatedProposal = { readonly ok: true; readonly proposal: RefineProposal } | { readonly ok: false; readonly reason: string };

/** Pure: validate an untrusted proposal. Rejects the WHOLE case (never
 *  drops individual edits) on: non-object shape, non-array edits, illegal
 *  action, missing kind/content on create|update, missing id on
 *  update|delete, kind "fact" (facts belong to the review fork), more than
 *  REFINE_MAX_EDITS edits, content over the 500-char review-fork bound.
 *  The three header strings are dressing, not safety — they normalize to ""
 *  rather than reject. */
export function validateProposal(p: unknown): ValidatedProposal {
  if (typeof p !== "object" || p === null || Array.isArray(p)) {
    return { ok: false, reason: "proposal must be a JSON object" };
  }
  const r = p as Record<string, unknown>;
  if (!Array.isArray(r.edits)) {
    return { ok: false, reason: "proposal.edits must be an array" };
  }
  if (r.edits.length > REFINE_MAX_EDITS) {
    return { ok: false, reason: `edits: ${r.edits.length} > ${REFINE_MAX_EDITS} — one refine must not rewrite the personality` };
  }
  const edits: ProposedEdit[] = [];
  for (const raw of r.edits) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, reason: "each edit must be an object" };
    }
    const e = raw as Record<string, unknown>;
    const action = e.action;
    if (action !== "create" && action !== "update" && action !== "delete") {
      return { ok: false, reason: `unsupported action ${String(action)}` };
    }
    if (action !== "delete") {
      // create/update carry the content — and the kind gate (fact 禁入:
      // 事实走 review fork, /refine 只策展操作性笔记).
      const kind = e.kind;
      if (kind === "fact") {
        return { ok: false, reason: 'kind "fact" is not refinable — project facts go through the background review path; /refine curates harness|preference|skill_note only' };
      }
      if (kind !== "harness" && kind !== "preference" && kind !== "skill_note") {
        return { ok: false, reason: `unsupported kind ${String(kind)} (harness|preference|skill_note)` };
      }
      if (typeof e.content !== "string" || e.content.trim() === "") {
        return { ok: false, reason: `${action} requires non-empty content` };
      }
      if (e.content.length > MEMORY_MAX_CONTENT_CHARS) {
        return { ok: false, reason: `content: ${e.content.length} > ${MEMORY_MAX_CONTENT_CHARS} chars (the review-fork bound)` };
      }
    }
    if (action !== "create") {
      if (typeof e.id !== "string" || e.id.trim() === "") {
        return { ok: false, reason: `${action} requires an existing id from the overview` };
      }
    }
    edits.push({
      action,
      ...(action !== "delete" ? { kind: e.kind as MemoryKind, content: e.content as string } : {}),
      ...(action !== "create" && typeof e.id === "string" ? { id: e.id } : {}),
      ...(Array.isArray(e.tags) ? { tags: e.tags.filter((t): t is string => typeof t === "string") } : {}),
      ...(typeof e.evidence === "string" ? { evidence: e.evidence } : {}),
    });
  }
  return {
    ok: true,
    proposal: {
      summary: typeof r.summary === "string" ? r.summary : "",
      rationale: typeof r.rationale === "string" ? r.rationale : "",
      expectedOutcome: typeof r.expectedOutcome === "string" ? r.expectedOutcome : "",
      edits,
    },
  };
}

// ---------------------------------------------------------------------------
// The planner — one model call.
// ---------------------------------------------------------------------------

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${truncateSafe(text, max - 1)}…`;
}

/** The memory overview the proposer sees: the three refinable kinds, first
 *  REFINE_OVERVIEW_PER_KIND per kind, each entry capped at
 *  REFINE_OVERVIEW_ENTRY_CHARS (98c 限流格式; ids included because they are
 *  the update/delete targets). Pure. 借鉴弧 C2: heldout 标记条目在此被过滤
 *  ——密封证据在任何精化视图里都不可见（planRefinement 的入口过滤之外，
 *  视图自身也强制）。 */
export function renderRefineOverview(entries: readonly MemoryEntry[]): string {
  const lines: string[] = ["## Current memory overview (kinds harness|preference|skill_note — ids are the update/delete targets)"];
  for (const kind of ["harness", "preference", "skill_note"] as const) {
    const ofKind = entries.filter((e) => e.kind === kind && !isHeldOutEntry(e)).slice(0, REFINE_OVERVIEW_PER_KIND);
    if (ofKind.length === 0) {
      lines.push(`### ${kind}: (none)`);
      continue;
    }
    lines.push(`### ${kind}:`);
    for (const e of ofKind) {
      lines.push(`- [${e.id} ${e.scope} ${e.status} v${e.version ?? 1}] ${truncate(e.content, REFINE_OVERVIEW_ENTRY_CHARS)}`);
    }
  }
  return lines.join("\n");
}

/** Pure: serialize the trajectory as plain text (role + text content; tool
 *  results capped at REFINE_TOOL_RESULT_CHARS each; an assistant turn that
 *  only called tools keeps a one-line marker so the proposer still sees the
 *  action), then keep the LAST REFINE_TRAJECTORY_CHARS chars (a truncated
 *  head gets an explicit marker line, and the marker counts inside the
 *  budget so the whole section is hard-bounded). */
export function serializeTrajectory(messages: readonly AgentMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      parts.push(`tool(${m.name}): ${truncate(m.content, REFINE_TOOL_RESULT_CHARS)}`);
    } else if (m.role === "assistant") {
      const calls = (m.toolCalls ?? []).map((c) => c.name).join(", ");
      const body = m.content.trim() !== "" ? m.content : calls !== "" ? `(called ${calls})` : "";
      parts.push(`assistant: ${body}`);
    } else {
      parts.push(`user: ${m.content}`);
    }
  }
  const text = parts.join("\n");
  if (text.length <= REFINE_TRAJECTORY_CHARS) return text;
  const marker = `...[trajectory head truncated — showing the last ${REFINE_TRAJECTORY_CHARS} chars]\n`;
  return marker + text.slice(text.length - (REFINE_TRAJECTORY_CHARS - marker.length));
}

/** Plan one refinement: overview + trajectory tail (+ optional instructions)
 *  → ONE model.generate → extract → validate. Validation failure returns the
 *  rejected-shape proposal (summary REFINE_REJECTED_SUMMARY, edits []) —
 *  never throws; a MODEL failure (network etc.) propagates to the command
 *  layer's try/catch. Single-turn call: no reasoning-replay concern (M47 is
 *  about replaying history tool turns; here there is no history). */
export async function planRefinement(
  model: ModelClient,
  messages: readonly AgentMessage[],
  store: MemoryStore,
  instructions?: string,
): Promise<RefineProposal> {
  // 借鉴弧 C2（the upstream project C4）：heldout 标记条目在精化入口被过滤——密封套件
  // 的结果永不进入任何精化输入（overview 不可见、update/delete 不可指——
  // 模型连它们的 id 都拿不到；/memory del 仍是人删除它们的唯一通道）。
  const entries = (await store.load()).filter((e) => !isHeldOutEntry(e));
  const userPrompt = [
    renderRefineOverview(entries),
    "",
    "## Session trajectory (tail)",
    // 永续 v6 弧 A：轨迹=不可信文本（工具输出/用户粘贴都在其中），整段
    // 进 nonce 围栏——块内无法冒充提示词作者；围栏外的本提示词指令保持
    // 唯一权威。用户手输的 instructions 不围（用户是委托人不是注入源）。
    fenceUntrusted(serializeTrajectory(messages), "refine-trajectory"),
    ...(instructions !== undefined && instructions.trim() !== "" ? ["", "## Instructions", instructions.trim()] : []),
  ].join("\n");
  const reply = await model.generate({
    systemPrompt: REFINE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
    tools: [],
  });
  const parsed = validateProposal(extractProposalJson(reply.content));
  if (!parsed.ok) {
    return { summary: REFINE_REJECTED_SUMMARY, rationale: parsed.reason, expectedOutcome: "", edits: [] };
  }
  return parsed.proposal;
}

// ---------------------------------------------------------------------------
// The applier — the three safety disciplines live here.
// ---------------------------------------------------------------------------

/** Apply one proposal edit-by-edit and write ONE audit line beside the
 *  store's ledger (snapshots taken from the STORE's return values — never
 *  the model's self-report, the dream D6 rule). `workspaceRoot` is kept for
 *  signature symmetry with the brief; the audit follows the STORE's own
 *  directory so a session-configured memoryDirectory is honored. */
export async function applyRefinement(
  workspaceRoot: string,
  store: MemoryStore,
  proposal: RefineProposal,
): Promise<{ readonly refineId: string; readonly receipt: string }> {
  void workspaceRoot;
  const refineId = `rf-${randomBytes(4).toString("hex")}`;
  const auditEdits: RefineEdit[] = [];
  const lines: string[] = [];
  // The pre-apply view: the before-snapshot source for update/delete edits.
  const existing = await store.load();
  for (const edit of proposal.edits) {
    if (edit.action === "create" && edit.kind !== undefined && edit.content !== undefined) {
      // 纪律 1: forcePending — the create lands pending no matter what the
      // assessment would auto-allow.
      const r = await store.write({ kind: edit.kind, content: edit.content, tags: edit.tags, forcePending: true, source: "refine" });
      if (!r.ok) {
        // 永续 v6 弧 A：块档门拦下——未入库（也无审计 after 快照可记），
        // 回执行名「已拦」；整案其余 edits 不受牵连（各自独立落地）。审计
        // 只记「拦过、为何拦」，绝不复抄被拦原文（否则密钥换了个文件存活）。
        auditEdits.push({ action: "create", kind: edit.kind, before: { content: "(blocked — content not recorded)", version: 0, status: "blocked" } });
        lines.push(`× create ${edit.kind} 已拦 — ${r.reasons.join("；")}（未入库，拦截清单可见）`);
        continue;
      }
      auditEdits.push({
        action: "create",
        id: r.entry.id, // the store-minted id — rollback's create→remove needs it
        kind: edit.kind,
        after: { content: r.entry.content, version: r.entry.version ?? 1, status: r.entry.status },
      });
      lines.push(`+ create ${edit.kind} ${r.entry.id} (pending) — ${truncate(edit.content, 80)}`);
    } else if (edit.action === "update" && edit.id !== undefined) {
      const target = existing.find((e) => e.id === edit.id);
      const before = target !== undefined ? { content: target.content, version: target.version ?? 1, status: target.status } : undefined;
      // 纪律 2 rides inside store.update: version+1 AND status → pending.
      const updated = target !== undefined && edit.content !== undefined
        ? await store.update(edit.id, { content: edit.content, tags: edit.tags, source: "refine" })
        : undefined;
      auditEdits.push({
        action: "update",
        id: edit.id,
        kind: (updated !== undefined && updated !== "blocked" ? updated.kind : undefined) ?? target?.kind ?? edit.kind,
        ...(before !== undefined ? { before } : {}),
        ...(updated !== undefined && updated !== "blocked" ? { after: { content: updated.content, version: updated.version ?? 1, status: updated.status } } : {}),
      });
      lines.push(
        updated === "blocked"
          ? `~ update ${edit.id} 已拦 — 新内容含凭据值/指令覆盖形状（原条未动，拦截清单可见）`
          : updated !== undefined
            ? `~ update ${edit.id} → v${updated.version ?? 1} (pending) — ${truncate(updated.content, 80)}`
            : `~ update ${edit.id} skipped — no such entry (/memory list)`,
      );
    } else if (edit.action === "delete" && edit.id !== undefined) {
      // 纪律 3: delete 只建议不执行 —— the entry stays; the receipt hands
      // the id to the human. before-snapshot recorded anyway (the audit's
      // copy of the content survives even after the user's /memory del).
      const target = existing.find((e) => e.id === edit.id);
      auditEdits.push({
        action: "delete",
        id: edit.id,
        kind: target?.kind ?? edit.kind,
        ...(target !== undefined ? { before: { content: target.content, version: target.version ?? 1, status: target.status } } : {}),
      });
      lines.push(`- delete suggested ${edit.id}${target !== undefined ? ` (${target.kind})` : " (no such entry)"} — run /memory del ${edit.id} yourself`);
    }
  }
  const rejected = proposal.summary === REFINE_REJECTED_SUMMARY;
  await appendRefinementAuditAt(store.path, {
    refineId,
    at: new Date().toISOString(),
    trigger: "manual",
    summary: proposal.summary,
    rationale: proposal.rationale,
    expectedOutcome: proposal.expectedOutcome,
    edits: auditEdits,
    outcome: rejected ? "rejected" : "applied",
  });
  const receipt = [
    `🧠 refine ${refineId}: ${proposal.summary}`,
    ...lines,
    `pending 条目需 /memory ok 生效；delete 需自行 /memory del <id>；回滚: /refine rollback ${refineId}`,
  ].join("\n");
  return { refineId, receipt };
}

// ---------------------------------------------------------------------------
// The command face — /refine [instructions] | /refine rollback <refineId>.
// ---------------------------------------------------------------------------

/** Execute `/refine <args>`. `rollback <refineId>` reverses one refinement
 *  from its audit snapshots; anything else plans + applies through the
 *  session model (no ctx → the usage line, the dream-verb precedent).
 *  Returns the receipt text; model-class failures propagate to the REPL's
 *  try/catch like /memory's. */
export async function runRefineCommand(workspaceRoot: string, args: string, ctx?: RefineContext): Promise<string> {
  const trimmed = args.trim();
  const store = openSessionMemoryStore(workspaceRoot) ?? openMemoryStore(workspaceRoot);
  if (trimmed === "rollback" || trimmed.startsWith("rollback ")) {
    const id = trimmed.slice("rollback".length).trim();
    if (id === "") return "用法：/refine rollback <refineId>——按审计快照回滚一次精炼"; // ω99-166d-i: #16
    const ok = await store.rollback(id);
    return ok
      ? `↩️ refine ${id} rolled back (updates restored at version+1, creates removed; a rollback audit line was written)`
      : `no refinement "${id}" found — it never applied, or the audit file has no such line`;
  }
  if (ctx === undefined) {
    return "用法：/refine [instructions]——需要会话模型（此前端未接线）"; // ω99-166d-i: #17
  }
  const plan = await planRefinement(ctx.model, ctx.messages, store, trimmed === "" ? undefined : trimmed);
  const { receipt } = await applyRefinement(workspaceRoot, store, plan);
  return receipt;
}
