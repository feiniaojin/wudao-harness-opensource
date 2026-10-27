// 借鉴弧 C2（a reference project C4）— 双门验收裁决报告器：「排除少干活省出来的钱」
// 的可执行形状。a reference project 原话：双门 rule out "savings that come from getting
// less done"。任何标榜效率的改动（省 token/省轮次/省延迟）必须同时过：
//   门一（能力门）：改动前后，每一个套件的能力分都不低于「预先声明的
//     容差」——逐套件裁决，不做聚合平均（a reference project 自曝的漏洞：per-mechanism
//     门放走小损失，聚合后只剩 94%；我们逐套件把关，小损失当场现形）。
//   门二（效率门）：至少一项效率指标实测改善（严格变好，方向感知——
//     token/轮次/延迟/成本是越低越好，命中率是越高越好）。
// 两门全过 = 通过；任一门不过 = 拒绝。非支配候选（有的指标好有的平）
// 保留——拒绝的只有「靠少干活省钱」。
//
// 输入输出形状（内部纪律，产品面 = 无）；报告输出中文人话。CLI：
//   node dist/double-gate.js --input <gate.json>   # 0 = 通过，1 = 拒绝，2 = 输入坏
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** 一项效率指标的前后观测。direction 声明「哪个方向是更好」。 */
export interface EfficiencyMetric {
  /** 指标名（token / 轮次 / p95 延迟 / 单解成本 / 命中率 …）。 */
  readonly metric: string;
  readonly before: number;
  readonly after: number;
  /** "lower" = 越低越好（默认）；"higher" = 越高越好。 */
  readonly betterWhen?: "lower" | "higher";
  /** 单位（可选，仅展示）。 */
  readonly unit?: string;
}

/** 一个套件（或一个能力面）的前后能力分。0..100 或通过率；同单位即可。 */
export interface CapabilityScore {
  readonly name: string;
  readonly before: number;
  readonly after: number;
}

export interface DoubleGateInput {
  /** 弧/改动名（仅展示）。 */
  readonly label: string;
  readonly capability: {
    /** 预先声明的容差（绝对分差）——门一开跑前必须已写下，禁止事后放宽。 */
    readonly tolerance: number;
    readonly suites: readonly CapabilityScore[];
  };
  readonly efficiency: readonly EfficiencyMetric[];
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export interface DoubleGateVerdict {
  readonly verdict: "pass" | "reject";
  readonly capabilityGate: "pass" | "reject" | "not-graded";
  readonly efficiencyGate: "pass" | "reject" | "not-graded";
  /** 中文人话理由（通过时=两门各一句；拒绝时=每条不过处一句）。 */
  readonly reasons: readonly string[];
  /** 容差内但确实下降的套件（诚实标注：非支配不拒绝，但要看见）。 */
  readonly withinToleranceDrops: readonly string[];
}

/** 纯裁决。坏输入（无套件/容差为负/前后缺一侧）→ 全拒绝 + 理由，绝不
 *  静默放行（fail-closed：能力面不可比 = 没资格 claim 效率收益）。 */
export function adjudicateDoubleGate(input: DoubleGateInput): DoubleGateVerdict {
  const reasons: string[] = [];
  const withinToleranceDrops: string[] = [];
  const tolerance = input.capability.tolerance;
  const suites = input.capability.suites;

  // ---- 门一：能力门（逐套件） ----
  let capabilityGate: DoubleGateVerdict["capabilityGate"] = "pass";
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    capabilityGate = "reject";
    reasons.push(`能力门拒绝：容差声明不合法（${tolerance}）——容差必须是不小于 0 的数，且在跑分前写下。`);
  } else if (suites.length === 0) {
    capabilityGate = "reject";
    reasons.push("能力门拒绝：没有提供任何套件的前后能力分——没有能力面就没有资格声明效率收益。");
  } else {
    for (const s of suites) {
      if (!Number.isFinite(s.before) || !Number.isFinite(s.after)) {
        capabilityGate = "reject";
        reasons.push(`能力门拒绝：套件「${s.name}」的前/后分数不完整（before=${s.before}, after=${s.after}）。`);
        continue;
      }
      const drop = s.before - s.after;
      if (drop > tolerance) {
        capabilityGate = "reject";
        reasons.push(`能力门拒绝：套件「${s.name}」能力分从 ${s.before} 降到 ${s.after}（跌 ${drop.toFixed(2)}），超出预先声明的容差 ${tolerance}。`);
      } else if (drop > 0) {
        withinToleranceDrops.push(`${s.name}：${s.before}→${s.after}（容差内 -${drop.toFixed(2)}）`);
      }
    }
    if (capabilityGate === "pass") {
      reasons.push(`能力门通过：${suites.length} 个套件逐项复核，降幅全部在预先声明的容差 ${tolerance} 之内${withinToleranceDrops.length > 0 ? `（其中 ${withinToleranceDrops.length} 个确有下降，已标注）` : ""}。`);
    }
  }

  // ---- 门二：效率门 ----
  let efficiencyGate: DoubleGateVerdict["efficiencyGate"] = "pass";
  const improved: string[] = [];
  const worsened: string[] = [];
  for (const m of input.efficiency) {
    if (!Number.isFinite(m.before) || !Number.isFinite(m.after)) {
      efficiencyGate = "reject";
      reasons.push(`效率门拒绝：指标「${m.metric}」的前/后数值不完整（before=${m.before}, after=${m.after}）。`);
      continue;
    }
    const betterWhen = m.betterWhen ?? "lower";
    const better = betterWhen === "lower" ? m.after < m.before : m.after > m.before;
    const worse = betterWhen === "lower" ? m.after > m.before : m.after < m.before;
    const unit = m.unit === undefined ? "" : ` ${m.unit}`;
    if (better) improved.push(`${m.metric}：${m.before}→${m.after}${unit}（${betterWhen === "lower" ? "降" : "升"} ${Math.abs(m.before - m.after).toFixed(2)}）`);
    else if (worse) worsened.push(`${m.metric}：${m.before}→${m.after}${unit}`);
    else worsened.push(`${m.metric}：${m.before}→${m.after}${unit}（无改善）`);
  }
  if (input.efficiency.length === 0) {
    efficiencyGate = "reject";
    reasons.push("效率门拒绝：没有提供任何效率指标——这不是效率弧，不需要双门；若声称效率收益，先补前后实测。");
  } else if (improved.length === 0) {
    efficiencyGate = "reject";
    reasons.push(`效率门拒绝：没有任何一项效率指标实测改善（${worsened.join("；") || "全部持平"}）——省不出钱就不是效率改动。`);
  } else {
    reasons.push(`效率门通过：至少一项实测改善——${improved.join("；")}${worsened.length > 0 ? `（另有未改善项：${worsened.join("；")}）` : ""}。`);
  }

  const verdict = capabilityGate === "pass" && efficiencyGate === "pass" ? "pass" : "reject";
  if (verdict === "reject") {
    reasons.push("裁决：拒绝——「省下来的钱」若来自少干活，不算省；先恢复能力面，再谈效率。");
  } else {
    reasons.push("裁决：通过——效率收益建立在能力保持之上（双门全过）。");
  }
  return { verdict, capabilityGate, efficiencyGate, reasons, withinToleranceDrops };
}

// ---------------------------------------------------------------------------
// 中文人话报告
// ---------------------------------------------------------------------------

export function formatDoubleGateReport(input: DoubleGateInput, verdict: DoubleGateVerdict): string {
  const lines: string[] = [
    `双门验收裁决${input.label !== "" ? `——${input.label}` : ""}`,
    "".padEnd(30, "─"),
    ...verdict.reasons.map((r) => `· ${r}`),
  ];
  if (verdict.withinToleranceDrops.length > 0) {
    lines.push("容差内下降（诚实标注，不拒绝但要看见）：");
    for (const d of verdict.withinToleranceDrops) lines.push(`  - ${d}`);
  }
  lines.push("".padEnd(30, "─"));
  lines.push(verdict.verdict === "pass" ? "结论：通过 ✅" : "结论：拒绝 ❌");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse + validate the CLI JSON (duck-typed, fail-closed: a bad shape is a
 *  REJECT-shaped input error, never a silent pass). Returns the input or a
 *  reason. */
export function parseGateJson(text: string): { readonly input?: DoubleGateInput; readonly error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { error: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}` };
  }
  if (!isPlainObject(parsed)) return { error: "顶层必须是对象 { label, capability: { tolerance, suites[] }, efficiency[] }" };
  const capRaw = parsed["capability"];
  const effRaw = parsed["efficiency"];
  if (!isPlainObject(capRaw) || !Array.isArray(capRaw["suites"]) || !Array.isArray(effRaw)) {
    return { error: "缺少 capability.tolerance/suites 或 efficiency 数组" };
  }
  if (!isFiniteNumber(capRaw["tolerance"])) return { error: "capability.tolerance 必须是数字" };
  const suites: CapabilityScore[] = [];
  for (const s of capRaw["suites"] as unknown[]) {
    if (!isPlainObject(s) || typeof s["name"] !== "string" || !isFiniteNumber(s["before"]) || !isFiniteNumber(s["after"])) {
      return { error: "capability.suites[] 每项需要 { name: string, before: number, after: number }" };
    }
    suites.push({ name: s["name"], before: s["before"], after: s["after"] });
  }
  const efficiency: EfficiencyMetric[] = [];
  for (const m of effRaw as unknown[]) {
    if (!isPlainObject(m) || typeof m["metric"] !== "string" || !isFiniteNumber(m["before"]) || !isFiniteNumber(m["after"])) {
      return { error: "efficiency[] 每项需要 { metric: string, before: number, after: number, betterWhen?: 'lower'|'higher' }" };
    }
    const betterWhen = m["betterWhen"];
    if (betterWhen !== undefined && betterWhen !== "lower" && betterWhen !== "higher") {
      return { error: `efficiency[].betterWhen 只能是 'lower'|'higher'，得到 ${String(betterWhen)}` };
    }
    efficiency.push({
      metric: m["metric"],
      before: m["before"],
      after: m["after"],
      ...(betterWhen !== undefined ? { betterWhen } : {}),
      ...(typeof m["unit"] === "string" ? { unit: m["unit"] } : {}),
    });
  }
  return {
    input: {
      label: typeof parsed["label"] === "string" ? parsed["label"] : "",
      capability: { tolerance: capRaw["tolerance"], suites },
      efficiency,
    },
  };
}

function printUsage(): number {
  process.stderr.write("usage: node dist/double-gate.js --input <gate.json>\n\ngate.json 形状：\n{\n  \"label\": \"弧名\",\n  \"capability\": { \"tolerance\": 2, \"suites\": [{ \"name\": \"det-01-...\", \"before\": 100, \"after\": 99 }] },\n  \"efficiency\": [{ \"metric\": \"每轮 token\", \"before\": 12000, \"after\": 9000, \"betterWhen\": \"lower\" }]\n}\n退出码：0=通过 1=拒绝 2=输入坏\n");
  return 2;
}

export function main(argv: readonly string[]): number {
  if (argv[0] !== "--input" || argv[1] === undefined) return printUsage();
  let text: string;
  try {
    text = readFileSync(argv[1], "utf8");
  } catch (err) {
    process.stderr.write(`--input: cannot read ${argv[1]}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const parsed = parseGateJson(text);
  if (parsed.error !== undefined || parsed.input === undefined) {
    process.stderr.write(`输入不合法：${parsed.error ?? "未知错误"}\n`);
    return 2;
  }
  const verdict = adjudicateDoubleGate(parsed.input);
  process.stdout.write(`${formatDoubleGateReport(parsed.input, verdict)}\n`);
  return verdict.verdict === "pass" ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
