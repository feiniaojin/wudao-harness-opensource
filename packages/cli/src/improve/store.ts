// 永续迭代 v6 · wave2 旗舰弧（the upstream project C1）——改进提案的版本化发布面
// （.wudao/proposals/，一提案一 JSON 文件）。
//
// 对垒现役（2026-09-15）：wudao 已有的「学到的东西」全在记忆面
// （memory.jsonl——陈述性知识，Dream/refine 精化、评审门把关）；本弧是
// 第一条「行为变更」发布链（规则文本→.wudao/rules/ 车道），它与记忆面的
// 差别=它改模型的行为，所以它的状态机携带两道人工门（offered=第一道：
// 同意才生成；gated=第二道：批准才激活）+ 门禁结果留档 + 驳回记忆（同一
// 指纹被拒的提案不再重复生成——the upstream project rejected_proposals 的 wudao 化，但
// 用户可见：每条记录就是管理面的一张卡）。
//
// 状态机（终态留档永不删——rejected 记忆是防重复提案的载体，永不清理；
// .wudao/proposals/ 是产品数据不是缓存，不设自动裁剪）：
//   offered →(同意)→ proposing →(生成+门禁过)→ gated →(激活)→ activated
//                                        ↘ (门禁败)→ gate-failed（终态）
//       ↘(忽略)→ ignored（终态）          ↘ (生成败,尝试<3)→ offered（带错误，可重试）
//   gated →(驳回)→ rejected（终态）          ↘ (生成败,尝试≥3)→ abandoned（终态）
//   activated →(撤销)→ undone →(可再激活)→ activated
//
// 快照纪律（文件时光机的等价物）：激活时把**写入的逐字字节**存进记录
// （ruleFileContent）；撤销只在当前文件内容与它逐字节相等时删除——被人工
// 改过的规则文件绝不删（红线：不删用户文件），且字节永远可从记录恢复
// （=时光机的「恢复到写前状态」保证，落点在提案仓而不是会话快照仓，因为
// 写/删发生在轮外的管理操作，不属于任何 run 的时光机窗口）。
//
// M24：提案文件零模型输入字节（管理面数据）；激活写的规则文件走既有
// rules 车道（会话静态 memo——下次会话才进前缀，零轮中前缀改写）。
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { FailureStage } from "../failure-fingerprints.js";

/** The proposals' workspace-relative home (beside rules/ and memory.jsonl). */
export const IMPROVE_DIR = "proposals";
/** 一条提案规则的正文帽（比 rules 车道自身的 8k 帽紧得多——学到的规则要
 * 的是短而可执行，提案器的后验校验同帽）。 */
export const PROPOSAL_RULE_MAX_CHARS = 1200;
export const PROPOSAL_SUMMARY_MAX_CHARS = 160;
export const PROPOSAL_SCOPE_MAX_CHARS = 120;
/** 提案器烧穿护栏（the upstream project C4）：同一指纹生成失败 3 次即弃（每次失败都是一次
 * 模型调用——attempts 帽防「整夜反复提同一方案烧后台 token」）。 */
export const PROPOSER_MAX_ATTEMPTS = 3;

export type ImprovementStatus =
  | "offered" // 第一道门卡：等同意/忽略
  | "proposing" // 已同意，生成中（异步）
  | "gated" // 门禁已过：第二道门卡（激活/驳回）
  | "gate-failed" // 门禁未过（终态，fail-open——什么都没改）
  | "rejected" // 用户驳回（终态，防重复提案）
  | "ignored" // 用户忽略触发（终态）
  | "abandoned" // 生成连败放弃（终态）
  | "activated" // 规则已写入 rules 车道
  | "undone"; // 已激活后撤销（规则文件已删；可再激活）

/** 门禁结果的序列化镜像（结构上等同 @wudao/evals 的 verdict——cli 不能
 * import evals（工作区依赖图无环律），结构镜像 + 双侧测试钉同一字面量）。 */
export interface ImprovementGateResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly paired: { readonly baselineOk: boolean; readonly candidateOk: boolean; readonly errors: readonly string[] };
  readonly suites: readonly { readonly name: string; readonly status: string; readonly errors: readonly string[] }[];
  readonly durationMs: number;
  readonly at: string;
}

export interface ImprovementRecord {
  readonly v: 1;
  readonly id: string;
  readonly version: number;
  /** 来源指纹（sha256 全长）——驳回记忆与触发去重的键。 */
  readonly fingerprint: string;
  readonly subject: string;
  readonly stage: FailureStage;
  readonly normalized: string;
  /** 触发时的出现次数/连续次数（通知文案的数据）。 */
  readonly count: number;
  readonly streak: number;
  readonly preview?: string;
  readonly status: ImprovementStatus;
  /** 生成尝试次数（含当前；≥PROPOSER_MAX_ATTEMPTS 弃）。 */
  readonly attempts: number;
  readonly lastError?: string;
  // —— 生成产物（proposing 之后在场）——
  readonly problemSummary?: string;
  readonly ruleText?: string;
  /** 适用范围的人话描述（提案卡显示）。 */
  readonly scope?: string;
  /** 适用路径 globs（缺省=stable 规则）。 */
  readonly paths?: readonly string[];
  readonly gate?: ImprovementGateResult;
  // —— 激活产物（activated 之后在场）——
  /** rules 车道内的文件名（auto-<id>.md）。 */
  readonly ruleFile?: string;
  /** 激活时写入的逐字字节（撤销的快照纪律）。 */
  readonly ruleFileContent?: string;
  readonly activatedAt?: string;
  readonly createdAt: string;
  readonly decidedAt?: string;
}

export function proposalsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".wudao", IMPROVE_DIR);
}

function recordPath(workspaceRoot: string, id: string): string {
  return join(proposalsDir(workspaceRoot), `${id}.json`);
}

/** Tolerant row gate (a damaged file skips — a broken proposals dir never
 *  breaks the trigger/decide paths). */
function parseRecord(raw: unknown): ImprovementRecord | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || typeof r.id !== "string" || r.id === "") return undefined;
  if (typeof r.fingerprint !== "string" || typeof r.subject !== "string" || typeof r.stage !== "string") return undefined;
  if (typeof r.normalized !== "string" || typeof r.count !== "number" || typeof r.streak !== "number") return undefined;
  const STATUSES: readonly string[] = ["offered", "proposing", "gated", "gate-failed", "rejected", "ignored", "abandoned", "activated", "undone"];
  if (typeof r.status !== "string" || !STATUSES.includes(r.status)) return undefined;
  if (typeof r.attempts !== "number" || typeof r.createdAt !== "string") return undefined;
  return {
    v: 1,
    id: r.id,
    version: typeof r.version === "number" ? r.version : 1,
    fingerprint: r.fingerprint,
    subject: r.subject,
    stage: r.stage as FailureStage,
    normalized: r.normalized,
    count: r.count,
    streak: r.streak,
    ...(r.preview !== undefined && typeof r.preview === "string" ? { preview: r.preview } : {}),
    status: r.status as ImprovementStatus,
    attempts: r.attempts,
    ...(r.lastError !== undefined && typeof r.lastError === "string" ? { lastError: r.lastError } : {}),
    ...(r.problemSummary !== undefined && typeof r.problemSummary === "string" ? { problemSummary: r.problemSummary } : {}),
    ...(r.ruleText !== undefined && typeof r.ruleText === "string" ? { ruleText: r.ruleText } : {}),
    ...(r.scope !== undefined && typeof r.scope === "string" ? { scope: r.scope } : {}),
    ...(Array.isArray(r.paths) && r.paths.every((p) => typeof p === "string") ? { paths: [...(r.paths as string[])] } : {}),
    ...(r.gate !== undefined && typeof r.gate === "object" && r.gate !== null ? { gate: r.gate as ImprovementGateResult } : {}),
    ...(r.ruleFile !== undefined && typeof r.ruleFile === "string" ? { ruleFile: r.ruleFile } : {}),
    ...(r.ruleFileContent !== undefined && typeof r.ruleFileContent === "string" ? { ruleFileContent: r.ruleFileContent } : {}),
    ...(r.activatedAt !== undefined && typeof r.activatedAt === "string" ? { activatedAt: r.activatedAt } : {}),
    createdAt: r.createdAt,
    ...(r.decidedAt !== undefined && typeof r.decidedAt === "string" ? { decidedAt: r.decidedAt } : {}),
  };
}

/** All records, file-name order (deterministic listing for the panel). */
export async function listImprovements(workspaceRoot: string): Promise<readonly ImprovementRecord[]> {
  let names: string[];
  try {
    names = await readdir(proposalsDir(workspaceRoot));
  } catch {
    return [];
  }
  const out: ImprovementRecord[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = parseRecord(JSON.parse(await readFile(join(proposalsDir(workspaceRoot), name), "utf8")));
      if (parsed !== undefined) out.push(parsed);
    } catch {
      // skip a corrupt record rather than aborting the listing
    }
  }
  return out;
}

/** The rejection/offer memory: one record per fingerprint EVER (any status
 *  suppresses a new offer — 被拒提案不重复生成，被忽略的触发不再烦人）。 */
export function hasRecordForFingerprint(records: readonly ImprovementRecord[], fingerprint: string): boolean {
  return records.some((r) => r.fingerprint === fingerprint);
}

/** Next id in the `p<seq>-<fp8>` shape (seq = max existing + 1; fp8 = the
 *  fingerprint's first 8 hex — the id names its own provenance). */
export function nextImprovementId(records: readonly ImprovementRecord[], fingerprint: string): string {
  let max = 0;
  for (const r of records) {
    const m = /^p(\d+)-/.exec(r.id);
    if (m !== null) max = Math.max(max, Number(m[1]));
  }
  return `p${max + 1}-${fingerprint.slice(0, 8)}`;
}

/** Whole-file write (mkdir-on-demand). Low volume by construction — every
 *  record begins with a human-visible trigger. */
export async function writeImprovement(workspaceRoot: string, record: ImprovementRecord): Promise<void> {
  const p = recordPath(workspaceRoot, record.id);
  await mkdir(proposalsDir(workspaceRoot), { recursive: true });
  await writeFile(p, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

/** Load one record (undefined = absent/corrupt — the decide paths converge on
 *  the honest MISS, never throw). */
export async function readImprovement(workspaceRoot: string, id: string): Promise<ImprovementRecord | undefined> {
  if (!/^p\d+-[a-f0-9]+$/.test(id)) return undefined;
  try {
    return parseRecord(JSON.parse(await readFile(recordPath(workspaceRoot, id), "utf8")));
  } catch {
    return undefined;
  }
}

/** The one legal transition map (pure — the decide ops and the async settle
 *  path both route through it; anything else is a store bug, refused). */
export function canTransition(from: ImprovementStatus, to: ImprovementStatus): boolean {
  switch (from) {
    case "offered":
      return to === "proposing" || to === "ignored";
    case "proposing":
      return to === "gated" || to === "gate-failed" || to === "offered" || to === "abandoned";
    case "gated":
      return to === "activated" || to === "rejected";
    case "activated":
      return to === "undone";
    case "undone":
      return to === "activated";
    default:
      return false; // 终态不再迁移（重放收敛：第二次决定走 MISS 形）
  }
}

export function withStatus(record: ImprovementRecord, to: ImprovementStatus, patch: Partial<ImprovementRecord> = {}): ImprovementRecord | undefined {
  if (!canTransition(record.status, to)) return undefined;
  const next: ImprovementRecord = { ...record, ...patch, status: to };
  return next;
}

// ---------------------------------------------------------------------------
// Activation / undo — the rules-lane tail writes (the ONLY fs mutations this
// arc performs outside .wudao/proposals/).
// ---------------------------------------------------------------------------

/** The exact bytes activation writes. MUST stay byte-identical to the gate's
 *  renderer (@wudao/evals improvement-gate.ts renderRuleFile) — both sides'
 *  tests pin the same literals; changing the shape is a two-file change by
 *  design (a drifted renderer gates the wrong bytes). */
export function renderRuleFileForActivation(ruleText: string, paths?: readonly string[]): string {
  const body = ruleText.trim();
  if (paths === undefined || paths.length === 0) return `${body}\n`;
  const fm = `${["---", "paths:", ...paths.map((p) => `- ${p}`), "---"].join("\n")}\n\n`;
  return `${fm}${body}\n`;
}

export function ruleFileNameFor(id: string): string {
  return `auto-${id}.md`;
}

export type ActivationOutcome =
  | { readonly ok: true; readonly record: ImprovementRecord; readonly wrote: string; readonly content: string; readonly alreadyInPlace: boolean }
  | { readonly ok: false; readonly message: string; readonly record?: ImprovementRecord };

/** Activate one record: write `.wudao/rules/auto-<id>.md` with the recorded
 *  bytes (idempotent when identical; NEVER clobber different content), then
 *  flip gated|undone → activated storing the exact bytes (the undo snapshot). */
export async function activateImprovement(workspaceRoot: string, record: ImprovementRecord, now: string): Promise<ActivationOutcome> {
  if ((record.status !== "gated" && record.status !== "undone") || record.ruleText === undefined) {
    return { ok: false, message: "这条提案不在可激活状态（可能已处理过）" };
  }
  const fileName = record.ruleFile ?? ruleFileNameFor(record.id);
  const content = renderRuleFileForActivation(record.ruleText, record.paths);
  const target = join(workspaceRoot, ".wudao", "rules", fileName);
  await mkdir(join(workspaceRoot, ".wudao", "rules"), { recursive: true });
  let alreadyInPlace = false;
  if (existsSync(target)) {
    const current = await readFile(target, "utf8").catch(() => null);
    if (current !== content) {
      return { ok: false, message: "规则文件已存在且内容不同（可能手工编辑过）——未覆盖；如需替换请先处理该文件", record };
    }
    alreadyInPlace = true;
  }
  if (!alreadyInPlace) await writeFile(target, content, "utf8");
  const next = withStatus(record, "activated", { ruleFile: fileName, ruleFileContent: content, activatedAt: now, ...(record.status === "gated" ? { decidedAt: now } : {}) });
  if (next === undefined) return { ok: false, message: "这条提案不在可激活状态（可能已处理过）", record };
  await writeImprovement(workspaceRoot, next);
  return { ok: true, record: next, wrote: target, content, alreadyInPlace };
}

export type UndoOutcome = { readonly ok: boolean; readonly message: string; readonly record?: ImprovementRecord };

/** Undo one activated record: delete the rule file ONLY when its bytes still
 *  equal what activation wrote (a hand-edited rule file is the user's file —
 *  never deleted; the honest message says so). */
export async function undoImprovement(workspaceRoot: string, record: ImprovementRecord, now: string): Promise<UndoOutcome> {
  if (record.status !== "activated" || record.ruleFile === undefined || record.ruleFileContent === undefined) {
    return { ok: false, message: "这条提案不在可撤销状态（可能已处理过）" };
  }
  const target = join(workspaceRoot, ".wudao", "rules", record.ruleFile);
  if (existsSync(target)) {
    const current = await readFile(target, "utf8").catch(() => null);
    if (current !== record.ruleFileContent) {
      return { ok: false, message: "规则文件已被手工修改过——不再自动删除；不需要它的话请手动移除", record };
    }
    await rm(target, { force: true });
  }
  const next = withStatus(record, "undone", {});
  if (next === undefined) return { ok: false, message: "这条提案不在可撤销状态（可能已处理过）", record };
  await writeImprovement(workspaceRoot, next);
  return { ok: true, message: "已撤销该规则（原字节留在提案记录里，可随时再激活）", record: next };
}

/** Stable content id of a record's current bytes (audit/logs). */
export function improvementContentHash(record: ImprovementRecord): string {
  return createHash("sha256").update(`${record.ruleText ?? ""} ${(record.paths ?? []).join(",")}`).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// The wire mirror (the driver op's list rows — card-relevant fields only;
// ruleFileContent and the normalized cause stay home).
// ---------------------------------------------------------------------------

export interface ImprovementWire {
  readonly id: string;
  readonly fingerprint: string;
  readonly subject: string;
  readonly stage: string;
  readonly count: number;
  readonly streak: number;
  readonly status: ImprovementStatus;
  readonly attempts: number;
  readonly problemSummary?: string;
  readonly ruleText?: string;
  readonly scope?: string;
  readonly paths?: readonly string[];
  readonly gate?: ImprovementGateResult;
  readonly ruleFile?: string;
  readonly lastError?: string;
  readonly preview?: string;
  readonly createdAt: string;
  readonly decidedAt?: string;
}

export function toImprovementWire(r: ImprovementRecord): ImprovementWire {
  return {
    id: r.id,
    fingerprint: r.fingerprint,
    subject: r.subject,
    stage: r.stage,
    count: r.count,
    streak: r.streak,
    status: r.status,
    attempts: r.attempts,
    ...(r.problemSummary !== undefined ? { problemSummary: r.problemSummary } : {}),
    ...(r.ruleText !== undefined ? { ruleText: r.ruleText } : {}),
    ...(r.scope !== undefined ? { scope: r.scope } : {}),
    ...(r.paths !== undefined ? { paths: r.paths } : {}),
    ...(r.gate !== undefined ? { gate: r.gate } : {}),
    ...(r.ruleFile !== undefined ? { ruleFile: r.ruleFile } : {}),
    ...(r.lastError !== undefined ? { lastError: r.lastError } : {}),
    ...(r.preview !== undefined ? { preview: r.preview } : {}),
    createdAt: r.createdAt,
    ...(r.decidedAt !== undefined ? { decidedAt: r.decidedAt } : {}),
  };
}

/** The driver op's reply shape (list carries rows; decisions carry the verdict). */
export interface ImprovementFaceResult {
  readonly ok: boolean;
  readonly message: string;
  readonly records?: readonly ImprovementWire[];
}
