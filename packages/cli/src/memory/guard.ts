// 永续迭代 v6 · reef 借鉴弧 A（digest-reef C3）——学习入口防污染三件套。
//
// 比较裁决（对垒 wudao 在位者，2026-09-15）：
//   在位者 = M49 记忆评审门（凭据形状→pending 等人审 + 一次性 surfaced 提醒）
//   + /refine 三红线（create 必 pending / update 必转 pending / delete 只建议）
//   + det-70 召回侧结构转义。对垒结论 = **部分引进**：
//   ✅ 引进——①凭据**值**形状硬拦（pending 会把密钥明文持久化进 memory.jsonl，
//      活得比轮换久；真阳性根本无需人审决策，硬拦比「落盘等人读」更便宜且
//      更强）；②指令覆盖形状硬拦（在位者**没有**这道面：无凭据词、有界、
//      新颖、project 域的注入文本会 **auto-active** 直进召回池，det-70 只杀
//      结构伪造（行伪造/信封逃逸）不杀语义注入）；③refine 轨迹/dream 台账
//      嵌入的 nonce 围栏（在位者零覆盖——轨迹里的工具输出/粘贴文本可以冒充
//      提示词作者写「## Instructions」段落）；④拦截台账（可见，不静默丢）。
//   ❌ 负裁决——①凭据**话题**（无值 prose，如 "rotate the api key monthly"）
//      维持 M49 pending 人审：人判比正则判强，不改；②/btw 侧问零新机制——
//      答案结构上不回流（工具全冻结+答案只返调用方），只补钉证其不变量；
//      ③评审 fork 是 prefix-share 重放（真实会话重放非嵌入，无从围栏，且其
//      唯一写路径已过 store 门）；④召回侧转义维持 det-70 原样（结构伪造已
//      覆盖，语义注入由本层入口拦）。
//
// 三件套（reef nodes.py:93-116 + strategies.py:151-158 的 wudao 化）：
//   1. 围栏 fenceUntrusted——随机 nonce 定界，块内文本无法提前闭合围栏冒充
//      提示词作者（闭标记携带 nonce，猜不中即闭不上）。
//   2. 双正则 screenLearningInput——CREDENTIAL_VALUE_RE（凭据值形状）+
//      DIRECTIVE_RE（指令覆盖措辞，带宾语——reef nodes.py:107-110 的教训：
//      "a task about prompts" 这类话题文本必须放过）。
//   3. 上限——拦截台账 BLOCKED_LEDGER_MAX 帽（旧条裁剪，文件有界）；学习
//      输入本体的尺寸帽沿用在位者（MEMORY_MAX_CONTENT_CHARS=500 /
//      REFINE_TRAJECTORY_CHARS / DREAM_EMBED_MAX_CHARS，不另造）。
//
//   脱敏纪律（reef redact_secret_shaped）：拦截台账的 preview 必须先过
//   CREDENTIAL_VALUE_RE 替换——拦截台账自己绝不落第二个密钥副本。
//
//   M24：零缓存代价——围栏只进 dream/refine **子代理**提示词（fresh child
//   自有前缀，父会话字节不动，与既有 M24 声明同款）；拦截回执是当轮工具
//   结果后缀。
import { truncateSafe } from "@wudao-org/core"; // 113-A4
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { memoryStorePath } from "./store.js";

/** The blocked-ledger file, a SIBLING of the memory store it guards (follows
 *  a session-configured memoryDirectory automatically — store-path-derived). */
export const BLOCKED_LEDGER_FILE = "memory-blocked.jsonl";
/** Blocked-ledger bound: keep the newest N records (the file stays readable
 *  and bounded; the visible count is of records in the ledger, honest). */
export const BLOCKED_LEDGER_MAX = 500;
/** Preview cap for a blocked record (post-redaction). */
const BLOCKED_PREVIEW_CHARS = 120;

/** The blocked ledger beside a store's own path. */
export function blockedLedgerPathFor(storePath: string): string {
  return join(dirname(storePath), BLOCKED_LEDGER_FILE);
}

/** The physical workspace ledger (the web faces' count source — memoryList's
 *  physical-store twin). */
export function blockedLearningCountAt(workspaceRoot: string): Promise<number> {
  return readBlockedLearningAt(memoryStorePath(workspaceRoot)).then((r) => r.length);
}

// ---------------------------------------------------------------------------
// ① The nonce fence.
// ---------------------------------------------------------------------------

/** Fresh fence nonce (hex; unpredictable per call — the security property). */
export function freshFenceNonce(): string {
  return randomBytes(8).toString("hex");
}

/** Wrap untrusted text in a nonce-delimited fence carrying its SOURCE label.
 *  The close tag repeats the nonce, so text inside the block cannot forge an
 *  early close (it would have to predict the nonce). The prompt author's
 *  instructions live OUTSIDE the fence and stay authoritative. */
export function fenceUntrusted(text: string, source: string, nonce: string = freshFenceNonce()): string {
  return `<untrusted source="${source}" nonce="${nonce}">\n${text}\n</untrusted nonce="${nonce}">`;
}

/** The receiver-side open/close markers for a known nonce (parser/testing). */
export function fenceMarkers(source: string, nonce: string): { readonly open: string; readonly close: string } {
  return {
    open: `<untrusted source="${source}" nonce="${nonce}">`,
    close: `</untrusted nonce="${nonce}">`,
  };
}

// ---------------------------------------------------------------------------
// ② The two screening regexes (block tier — hard evidence shapes only).
// ---------------------------------------------------------------------------

/** Credential VALUE shapes (case-insensitive): literal token families and
 *  name-carrying-value assignments. Deliberately NARROWER than the M49
 *  CREDENTIAL_RE pending tier — prose naming a secret-shaped field (no value)
 *  stays on the human-review path, untouched. */
export const CREDENTIAL_VALUE_RE =
  /(sk-[a-z0-9]{8,}|ghp_[a-z0-9]{16,}|gho_[a-z0-9]{16,}|github_pat_[a-z0-9_]{20,}|xox[abprs]-[a-z0-9-]{10,}|akia[0-9a-z]{16}|-----begin [a-z0-9 ]*private key-----|bearer\s+[a-z0-9._~+/=-]{16,}|(?:api[_-]?key|apikey|secret|token|passwd|password|passphrase|access[_-]?token|auth[_-]?token)\s*[:=]\s*["']?[a-z0-9_~+/=-]{8,}["']?)/i;

/** Instruction-override / chat-template-impersonation shapes. The directive
 *  arm matches verb + instruction-family OBJECT (reef nodes.py:107-110: match
 *  directives with objects, not topics — "a task about prompts" passes); the
 *  template arm matches control tokens that impersonate the chat format. */
export const DIRECTIVE_RE =
  /((?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+|these\s+)?(?:previous|prior|above|earlier|preceding|original|initial|system)\s+(?:instructions?|prompts?|rules?|directions?|guidance)|<\|(?:im_start|im_end|system|endoftext)\|>|\[\/?inst\]|<<\/?sys>>|<\/?(?:im_)?system>|###\s+(?:system|instruction)s?\s*$)/i;

/** One screening verdict. */
export interface LearningScreen {
  readonly blocked: boolean;
  readonly reasons: readonly string[];
}

/** Pure: screen one learning input (memory content, refine edit, any future
 *  learned-behavior text — the wave2 proposer path reuses this). Blocked =
 *  never enters the ledger, logged to the blocked ledger instead. */
export function screenLearningInput(content: string): LearningScreen {
  const reasons: string[] = [];
  if (CREDENTIAL_VALUE_RE.test(content)) reasons.push("credential-value: 内容含密钥/令牌值形状");
  if (DIRECTIVE_RE.test(content)) reasons.push("directive: 内容含指令覆盖/模板伪装形状");
  return { blocked: reasons.length > 0, reasons };
}

/** Redact credential-value shapes from a preview (the blocked ledger never
 *  persists a second copy of the secret it just refused). */
export function redactSecretShaped(text: string): string {
  return text.replace(CREDENTIAL_VALUE_RE, "…[已脱敏]…");
}

// ---------------------------------------------------------------------------
// ③ The blocked ledger (append-only, capped, visible — never a silent skip).
// ---------------------------------------------------------------------------

/** Which learning entry attempted the write (the receipt/audit dimension).
 *  永续 v6 wave2（reef C1）：+improve——改进提案器生成的规则文本过同一道
 *  准入筛查（screenLearningInput 的「任何未来 learned-behavior 文本」条款
 *  的第一个新调用方）。
 *  记忆两库收敛：+capture（新库 captureAtSessionEnd 的保守沉淀）与
 *  +migrate（M49 存量迁移）——两条新学习入口共用同一道块档门。 */
export type LearningSource = "memory_write" | "refine" | "review" | "dream" | "edit" | "btw" | "improve" | "capture" | "migrate";

/** One blocked-learning ledger line. */
export interface BlockedLearningRecord {
  readonly type: "blocked_learning";
  readonly at: string;
  readonly source: LearningSource;
  readonly reasons: readonly string[];
  /** Redacted, bounded excerpt — enough to recognize, never enough to leak. */
  readonly preview: string;
}

/** Pure row gate for reads (corrupt lines skip — a damaged ledger never
 *  breaks the count face). */
function parseBlocked(raw: unknown): BlockedLearningRecord | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.type !== "blocked_learning" || typeof r.at !== "string" || typeof r.source !== "string") return undefined;
  if (!Array.isArray(r.reasons) || r.reasons.some((x) => typeof x !== "string") || typeof r.preview !== "string") return undefined;
  return { type: "blocked_learning", at: r.at, source: r.source as LearningSource, reasons: [...(r.reasons as string[])], preview: r.preview };
}

/** Read the blocked ledger beside a store path (absent/unreadable → []). */
export async function readBlockedLearningAt(storePath: string): Promise<readonly BlockedLearningRecord[]> {
  let text: string;
  try {
    text = await readFile(blockedLedgerPathFor(storePath), "utf8");
  } catch {
    return [];
  }
  const out: BlockedLearningRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = parseBlocked(JSON.parse(trimmed));
      if (parsed !== undefined) out.push(parsed);
    } catch {
      // skip a corrupt line rather than aborting the read
    }
  }
  return out;
}

/** Append one blocked record; past BLOCKED_LEDGER_MAX the oldest rows drop
 *  (rewrite-keep-newest — the store's own bookkeeping-rewrite discipline).
 *  Never throws into the write path (the caller's block decision already
 *  stands; a failed log costs one stderr line at the caller). */
export async function appendBlockedLearningAt(storePath: string, record: BlockedLearningRecord): Promise<void> {
  const path = blockedLedgerPathFor(storePath);
  await mkdir(dirname(path), { recursive: true });
  const existing = await readBlockedLearningAt(storePath);
  const kept = [...existing, record].slice(-BLOCKED_LEDGER_MAX);
  await writeFile(path, kept.map((r) => JSON.stringify(r)).join("\n") + (kept.length > 0 ? "\n" : ""), "utf8");
}

/** Build the record for one blocked attempt (redaction runs HERE — nothing
 *  raw ever reaches the ledger). */
export function buildBlockedRecord(input: { readonly at: string; readonly source: LearningSource; readonly reasons: readonly string[]; readonly content: string }): BlockedLearningRecord {
  return {
    type: "blocked_learning",
    at: input.at,
    source: input.source,
    reasons: [...input.reasons],
    preview: truncateSafe(redactSecretShaped(input.content), BLOCKED_PREVIEW_CHARS),
  };
}

/** The user-facing hint line (the /memory list footer and the web faces). */
export function blockedLearningHint(count: number): string {
  return `已拦 ${count} 条可疑学习输入（含密钥或指令注入形状，未入库——被拦项记录在 .wudao/memory-blocked.jsonl，可查看）`;
}
