// 借鉴弧 C2（SoL-Pi C4）— 盲 held-out 的机械面：密封清单检查、训练面
// 报告剥离、泄漏扫描。
//
// 纪律（SoL-Pi blog 的防自我欺骗核心）："no agent inside the auto-research
// loop sees the held-out results"——held-out 套件的结果绝不进入改进循环的
// 任何分析输入。在 wudao 的落地分工：
//   * 训练面选择：contracts.ts 的 `--changed`（本包）——已排除 held-out；
//   * 记忆精化入口（cli memory refine/dream）：带 heldout 标记的记忆条目
//     在入口被过滤（见 cli 侧 HELDOUT_MEMORY_TAG）；
//   * 报告消费：本模块的 stripHeldOutReport——任何要喂给精化/分析输入的
//     last.json 先剥掉 held-out 行（弧的最终验收读全量报告，那条路不走
//     精化）；
//   * 泄漏自检：leakScan——弧在提交精化输入前扫一遍（memory.jsonl、报告
//     文本），发现 held-out 套件名出现即报警（应改标签或改走验收通道）。
//
// 产品面 = 无（内部纪律）；输出中文人话。
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadContracts, heldOutSet, type ContractsData, type HeldOutManifest } from "./contracts.js";

/** The sealed manifest (undefined when contracts.json carries no heldout). */
export function loadHeldOut(data: ContractsData = loadContracts()): HeldOutManifest | undefined {
  return data.heldout;
}

/** The sealed names (frozen literals — never re-derived at read time). */
export function heldOutSuites(data: ContractsData = loadContracts()): readonly string[] {
  return data.heldout?.suites ?? [];
}

/** True when the suite is sealed held-out. */
export function isHeldOutSuite(name: string, data: ContractsData = loadContracts()): boolean {
  return heldOutSet(data).has(name);
}

/** The sealed manifest's invariants beyond contracts.ts's validateContracts
 *  (that one owns exists/dup/whitelist/fraction); here: the seal must not be
 *  EMPTY (an empty held-out set silently disables the blind gate) and the
 *  sealed share of the mapped pool must stay inside the declared band —
 *  shrinkage below half the declared fraction means the list went stale
 *  (suites were removed) and must be re-sealed, not silently drift. */
export function validateHeldOutSeal(data: ContractsData, suiteNames: readonly string[]): string[] {
  const violations: string[] = [];
  const held = data.heldout;
  if (held === undefined) return violations;
  const mappedPool = new Set<string>();
  for (const c of data.contracts) for (const s of c.suites) mappedPool.add(s);
  const sealed = held.suites ?? [];
  if (sealed.length === 0) violations.push("held-out manifest is empty — the blind gate would be a no-op; carve a real subset or drop the section");
  const mappedSealed = sealed.filter((s) => mappedPool.has(s)).length;
  if (sealed.length > 0 && mappedSealed !== sealed.length) {
    violations.push(`${sealed.length - mappedSealed} held-out suite(s) are no longer in the mapped pool — re-seal the manifest`);
  }
  if (mappedPool.size > 0) {
    const share = sealed.length / mappedPool.size;
    if (share < held.fraction * 0.5 || share > 0.5) {
      violations.push(`held-out share ${(share * 100).toFixed(1)}% drifted from the declared fraction ${held.fraction} — re-seal with a new sealedAt`);
    }
  }
  void suiteNames;
  return violations;
}

// ---------------------------------------------------------------------------
// Report stripping — the refinement-safe view of an eval report
// ---------------------------------------------------------------------------

/** Duck-typed report row (last.json's results[] shape — keep it loose so the
 *  strip never crashes on a report shape drift). */
interface ReportLike {
  readonly results?: readonly { readonly name?: unknown }[];
  readonly [k: string]: unknown;
}

export interface StrippedReport {
  /** The report with held-out rows removed (shallow copy; other fields kept). */
  readonly report: Record<string, unknown>;
  /** The names removed (Chinese reasons quote them). */
  readonly removed: readonly string[];
}

/** Drop held-out rows from a parsed last.json. Pure; never throws — a report
 *  without results passes through untouched with removed=[]. */
export function stripHeldOutReport(parsed: unknown, data: ContractsData = loadContracts()): StrippedReport {
  const held = heldOutSet(data);
  const report = (typeof parsed === "object" && parsed !== null ? parsed : {}) as ReportLike;
  const rows = Array.isArray(report.results) ? report.results : [];
  const kept: unknown[] = [];
  const removed: string[] = [];
  for (const row of rows) {
    const name = typeof (row as { name?: unknown })?.name === "string" ? (row as { name: string }).name : undefined;
    if (name !== undefined && held.has(name)) removed.push(name);
    else kept.push(row);
  }
  const out: Record<string, unknown> = { ...report, results: kept };
  if (report.total !== undefined && removed.length > 0) {
    out["total"] = (typeof report.total === "number" ? report.total : rows.length) - removed.length;
  }
  if (removed.length > 0) {
    out["heldOutSealed"] = removed.length;
  }
  return { report: out, removed };
}

// ---------------------------------------------------------------------------
// Leak scan — the arc-side self-check
// ---------------------------------------------------------------------------

/** Held-out suite names mentioned in arbitrary text (refinement inputs,
 * memory ledgers, reports). A mention is not proof of a leak — it is the
 * signal to re-check the input's provenance before it feeds refinement. */
export function leakScan(text: string, data: ContractsData = loadContracts()): readonly string[] {
  const hits: string[] = [];
  for (const name of heldOutSuites(data)) {
    if (text.includes(name)) hits.push(name);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// CLI — node dist/heldout.js --list | --scan <file> | --strip <in.json> <out.json>
// ---------------------------------------------------------------------------

function printUsage(): number {
  process.stderr.write("usage: node dist/heldout.js --list                    # 密封清单 + 占比\n       node dist/heldout.js --scan <file>             # 泄漏自检（文本里出现 held-out 套件名即报警）\n       node dist/heldout.js --strip <in.json> <out.json> # 把报告剥成精化安全视图\n");
  return 1;
}

export function main(argv: readonly string[]): number {
  const data = loadContracts();
  const held = loadHeldOut(data);
  if (argv[0] === "--list") {
    if (held === undefined) {
      process.stdout.write("(no held-out manifest — 盲测纪律未启用)\n");
      return 0;
    }
    const mapped = new Set<string>();
    for (const c of data.contracts) for (const s of c.suites) mapped.add(s);
    process.stdout.write(`sealed ${held.sealedAt} — ${held.suites.length}/${mapped.size} 套件盲化 (${((held.suites.length / Math.max(1, mapped.size)) * 100).toFixed(1)}%)\n`);
    for (const s of held.suites) process.stdout.write(`  ${s}\n`);
    if (held.derivation !== undefined) process.stdout.write(`${held.derivation}\n`);
    const sealViolations = validateHeldOutSeal(data, []);
    for (const v of sealViolations) process.stdout.write(`⚠️ ${v}\n`);
    return sealViolations.length > 0 ? 1 : 0;
  }
  if (argv[0] === "--scan") {
    const file = argv[1];
    if (file === undefined) return printUsage();
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      process.stderr.write(`--scan: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    const hits = leakScan(text, data);
    if (hits.length === 0) {
      process.stdout.write("干净：未发现 held-out 套件名。\n");
      return 0;
    }
    process.stdout.write(`⚠️ 发现 ${hits.length} 个 held-out 套件名出现在该输入里：\n`);
    for (const h of hits) process.stdout.write(`  ${h}\n`);
    process.stdout.write("该输入不得喂给 Dream/refine/任何精化通道——改走验收通道或去掉相关内容。\n");
    return 1;
  }
  if (argv[0] === "--strip") {
    const [inPath, outPath] = [argv[1], argv[2]];
    if (inPath === undefined || outPath === undefined) return printUsage();
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(inPath, "utf8"));
    } catch (err) {
      process.stderr.write(`--strip: cannot read/parse ${inPath}: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    const { report, removed } = stripHeldOutReport(parsed, data);
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(removed.length > 0
      ? `已剥离 ${removed.length} 行 held-out 结果 → ${outPath}（精化安全视图）\n`
      : `报告中没有 held-out 行，原样写出 → ${outPath}\n`);
    return 0;
  }
  return printUsage();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
