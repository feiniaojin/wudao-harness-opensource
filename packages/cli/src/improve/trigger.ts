// 永续 v6 wave2（the upstream project C1）——触发器（人工同意第一道）：失败指纹 persisting
// ≥3 时，建 offered 记录 + 一条通知。the upstream project 的触发是 batch 攒齐自动开步；
// wudao 的第一道门是**人**——通知只问「要生成一条改进提案吗？」，同意之
// 前零模型调用、零文件改动（除 offered 记录本身）。
//
// 检查点=运行收束缝（与 Dream 同缝）：读台账事件流 fold（弧 A 的
// readFailureEvents/foldFailureManifest——事件是唯一持久真相），纯读。
// schedules/mission 写入的失败在同一缝被下一次 fold 看到。防污染（γ2
// 词面守卫）：run-end（终态成因）永不触发提案——它不是失败。
//
// 抑制=每指纹一生至多一条记录（任何状态）：被拒不再生成（the upstream project
// rejected_proposals）、被忽略不再烦人、已激活/已撤销的留档不重复。
// kill switch 沿用 Dream 的 env 形（WUDAO_IMPROVE=off / WUDAO_NO_IMPROVE=1）。
// fail-open：台账/提案仓不可读 → 静默跳过，绝不影响它所搭的收束路径。
import { truncateSafe } from "@wudao/core"; // 113-A4
import { failureFingerprintPath, readFailureEvents, foldFailureManifest, type FailureRecord } from "../failure-fingerprints.js";
import { hasRecordForFingerprint, listImprovements, nextImprovementId, writeImprovement, type ImprovementRecord } from "./store.js";

/** 触发阈值：同一失败模式出现满 3 次（count=历史总次数——通知文案说
 * 「已出现 N 次」用的是它；status=persisting 保证此刻仍未修复）。 */
export const IMPROVE_TRIGGER_THRESHOLD = 3;
/** 一次收束最多新建的触发数（通知洪水泥沙防——超过的下次收束再提）。 */
export const IMPROVE_MAX_NEW_OFFERS_PER_PASS = 2;

/** True unless WUDAO_IMPROVE=off or WUDAO_NO_IMPROVE=1 (dreamEnabled's shape). */
export function improveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.WUDAO_NO_IMPROVE === "1") return false;
  return (env.WUDAO_IMPROVE ?? "").trim().toLowerCase() !== "off";
}

/** Pure: the manifest records that owe the user a first offer. */
export function triggerCandidates(manifest: readonly FailureRecord[], suppressed: ReadonlySet<string>): readonly FailureRecord[] {
  return manifest
    .filter((r) => r.status === "persisting" && r.count >= IMPROVE_TRIGGER_THRESHOLD)
    .filter((r) => r.stage !== "run-end")
    .filter((r) => !suppressed.has(r.fingerprint))
    .sort((a, b) => b.count - a.count || (a.subject < b.subject ? -1 : 1))
    .slice(0, IMPROVE_MAX_NEW_OFFERS_PER_PASS);
}

/** The offer notice (benefits language — no internal vocabulary). */
export function offerNotice(record: ImprovementRecord): string {
  const subject = record.subject.length > 60 ? `${truncateSafe(record.subject, 59)}…` : record.subject;
  return `📌 同一个失败已出现 ${record.count} 次（${subject}）——要不要让助手总结成一条改进规则？在 设置 → 偏好 → 改进提案 里同意或忽略`;
}

export interface OfferOptions {
  readonly workspaceRoot: string;
  /** The settle seam's notice lane. */
  readonly onNotice?: (line: string) => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => string;
}

let offering = false;

/** One pass over the ledger at the run-settle seam (fire-and-forget; single-
 *  flight so a chatty settle seam never double-creates). Returns the newly
 *  offered records ([] when disabled/quiet/broken-ledger). Never throws. */
export async function maybeOfferImprovements(opts: OfferOptions): Promise<readonly ImprovementRecord[]> {
  if (offering) return [];
  if (!improveEnabled(opts.env)) return [];
  offering = true;
  try {
    const events = await readFailureEvents(failureFingerprintPath(opts.workspaceRoot));
    if (events.length === 0) return [];
    const manifest = foldFailureManifest(events);
    const existing = await listImprovements(opts.workspaceRoot);
    const suppressed = new Set(existing.map((r) => r.fingerprint));
    const candidates = triggerCandidates(manifest, suppressed);
    const created: ImprovementRecord[] = [];
    const at = (opts.now ?? (() => new Date().toISOString()))();
    let pool = existing;
    for (const c of candidates) {
      const record: ImprovementRecord = {
        v: 1,
        id: nextImprovementId(pool, c.fingerprint),
        version: 1,
        fingerprint: c.fingerprint,
        subject: c.subject,
        stage: c.stage,
        normalized: c.normalized,
        count: c.count,
        streak: c.streak,
        ...(c.preview !== undefined ? { preview: c.preview } : {}),
        status: "offered",
        attempts: 0,
        createdAt: at,
      };
      await writeImprovement(opts.workspaceRoot, record);
      pool = [...pool, record];
      created.push(record);
      opts.onNotice?.(offerNotice(record));
    }
    return created;
  } catch {
    // fail-open：一块坏台账/坏仓绝不影响它所搭的运行收束。
    return [];
  } finally {
    offering = false;
  }
}
