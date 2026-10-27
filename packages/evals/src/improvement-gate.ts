// 永续迭代 v6 · wave2 旗舰弧（reef C1）——配对回放门：改进提案激活前的
// 确定性门禁。reef backend.py 配对交错回放的 wudao 落地，语义照搬、执行面
// 重铸：
//
//   reef 的门 = 候选树 vs 当前树，每任务两侧交错跑完整 episode（2×任务×
//   repeats 次模型调用），wins-losses 边际裁决。wudao 的提案是**规则文本**
//   （.wudao/rules/ 车道），不是代码——它能弱化的面是：①规则装载车道本身
//   （加载/字节数/稳定节注入），②harness 整体回归。所以门 = 两段：
//
//   ① 配对回放（提案感知）：基线工作区 A（无规则）vs 候选工作区 B（提案
//   规则落 .wudao/rules/），两侧都走**真实** loadContextRules +
//   buildSystemPrompt（+ gated 规则的真实 matcher/note 构造）。判据=「提案
//   不弱化门任务」：基线先自证健康（基线红=门不可判，fail-open 什么都不
//   改——reef「报错排在一切真分数之下」的教训：不可判绝不并列为零分）；
//   候选必须通过基线通过的全部断言 + 规则在场断言（装得上、装得对）。
//   ② 骨干 det 套件精选（5 个跨域）：det-01 基础 loop / det-06 M24 前缀
//   稳定 / det-17 workflow / det-46 规则-上下文车道 / det-54 记忆自精化——
//   全绿才过。脚本化模型=零 API 成本、确定性（同一提案同一裁决）。
//
//   对垒现役（2026-09-15）：Dream/refine 只精化「记忆」，提案无门直接可写
//   的路径不存在（/rules 手写=用户自己的手）；本弧是 wudao 第一条「学到的
//   行为变更」发布链，门是它区别于 Dream/refine 的构成性护栏。
//   超越点（digest C1）：reef 三个手写算术任务测不出 Workflow 变更
//   （reefine 自认全 tie）——本门精选覆盖 workflow/规则/M24 域的 harness
//   真实任务面；确定性套件无漂移，无需交错均摊（reef 交错是为均摊非确定性
//   模型漂移——脚本化模型按构造免漂移）；任务晋升（真实 mission 任务进
//   门）留 seam：指纹 resolved 事件流已是候选源（弧 A 接口），待后续弧。
//
//   M24：门全程零主会话字节（独立进程/独立 tmpdir），提案规则落盘发生在
//   激活时=轮界+会话界（rules 会话静态 memo，下次会话才进前缀）——零前缀
//   改写代价。
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAllEvals, type AnyEvalDefinition, type EvalResult } from "./runner.js";
import { deterministicSuites } from "./suites/deterministic.js";
import { loadContextRules, createContextRuleMatcher, buildRuleNote, ruleNotePrefix, MAX_RULE_BODY_CHARS } from "wudao-harness/rules";
import { buildSystemPrompt, SYSTEM_PREAMBLE } from "wudao-harness/prompt";

/** The gate's backbone suites (name-filtered from the deterministic roster —
 *  the roster stays the single source; this list only SELECTS). Five suites,
 *  five domains: the base loop, the M24 prefix discipline, the workflow
 *  engine, the rules/context lane itself, and the memory self-refinement
 *  family this arc belongs to. */
export const GATE_SUITE_NAMES: readonly string[] = [
  "det-01-read-file-answer",
  "det-06-prefix-stability",
  "det-17-jsflow-workflow",
  "det-46-m62-config-economy",
  "det-54-dream-consolidation",
];

/** One gate invocation's input (the CLI side serializes this to the bin). */
export interface ImprovementGateInput {
  readonly proposalId: string;
  /** The rules-lane file name the activation would write (e.g. `auto-p3-a1b2c3d4.md`). */
  readonly ruleFileName: string;
  /** The rule body (no frontmatter — the gate adds it when paths are present). */
  readonly ruleText: string;
  /** Optional path globs — present = a GATED rule (lazy history lane), absent = STABLE. */
  readonly paths?: readonly string[];
}

export interface ImprovementGateSuiteRow {
  readonly name: string;
  readonly status: string;
  readonly errors: readonly string[];
}

export interface ImprovementGateVerdict {
  readonly ok: boolean;
  /** Short human reason when !ok (shown on the proposal card). */
  readonly reason?: string;
  readonly paired: { readonly baselineOk: boolean; readonly candidateOk: boolean; readonly errors: readonly string[] };
  readonly suites: readonly ImprovementGateSuiteRow[];
  readonly durationMs: number;
  readonly at: string;
}

/** Select the backbone suites from the roster. Unknown names are a GATE
 *  CONFIG error (fail-closed: a silently smaller gate is a silently weaker
 *  gate). */
export function selectGateSuites(names: readonly string[], roster: readonly AnyEvalDefinition[]): readonly AnyEvalDefinition[] {
  const byName = new Map(roster.map((d) => [d.name, d]));
  const out: AnyEvalDefinition[] = [];
  for (const n of names) {
    const def = byName.get(n);
    if (def === undefined) throw new Error(`improvement gate: suite "${n}" not in the deterministic roster`);
    out.push(def);
  }
  return out;
}

// ---------------------------------------------------------------------------
// ① Paired rules-lane replay (proposal-aware; both sides fresh).
// ---------------------------------------------------------------------------

/** The exact bytes activation would write (ONE writer of this shape — the
 *  activation op and the gate must never drift). */
export function renderRuleFile(input: ImprovementGateInput): string {
  const body = input.ruleText.trim();
  if (input.paths === undefined || input.paths.length === 0) return `${body}\n`;
  const fm = `${["---", "paths:", ...input.paths.map((p) => `- ${p}`), "---"].join("\n")}\n\n`;
  return `${fm}${body}\n`;
}

/** A literal path that a scope glob must match (wildcard positions filled
 *  with a benign literal — `src/**` → `src/gate`). Pure heuristic probe. */
function scopeProbePath(glob: string): string {
  return glob.replace(/\*+/g, "gate").replace(/\?/g, "x").replace(/^\//, "");
}

function assertBaseline(root: string, errors: string[]): void {
  // The rules face of an empty workspace: loader clean, prompt assembles with
  // the preamble. A red baseline means THIS build/workspace is unjudgeable —
  // never the proposal's fault, and never a pass.
  const rules = loadContextRules(root, (m) => errors.push(`baseline loader warning: ${m}`));
  if (rules.stable.length > 0 || rules.gated.length > 0) {
    errors.push(`baseline workspace unexpectedly carries rules (${rules.stable.length} stable, ${rules.gated.length} gated)`);
  }
  if (!buildSystemPrompt(root).includes(SYSTEM_PREAMBLE)) {
    errors.push("baseline system prompt lost the preamble (assembly broken)");
  }
}

function assertCandidate(root: string, input: ImprovementGateInput, errors: string[]): void {
  const warnFor: string[] = [];
  const rules = loadContextRules(root, (m) => warnFor.push(m));
  const source = `.wudao/rules/${input.ruleFileName}`;
  const gated = input.paths !== undefined && input.paths.length > 0;
  const lane = gated ? rules.gated : rules.stable;
  const rule = lane.find((r) => r.source === source);
  if (rule === undefined) {
    errors.push(`提案规则未装载（${source} 不在 ${gated ? "gated" : "stable"} 车道）`);
  } else {
    // Byte faithfulness: below the loader's own cap the body must equal the
    // written bytes verbatim (the trim is the loader's documented behavior).
    const trimmed = input.ruleText.trim();
    if (trimmed.length <= MAX_RULE_BODY_CHARS ? rule.body !== trimmed : rule.body.length > MAX_RULE_BODY_CHARS || !rule.body.startsWith(trimmed.slice(0, MAX_RULE_BODY_CHARS - 100))) {
      errors.push("提案规则正文未逐字节装载（装载器改写了正文）");
    }
    if (gated && (rule.paths === undefined || rule.paths.length === 0)) {
      errors.push("gated 提案规则装载后丢失了 paths");
    }
  }
  for (const w of warnFor) {
    if (w.includes(input.ruleFileName)) errors.push(`提案规则引发装载警告：${w}`);
  }
  const prompt = buildSystemPrompt(root);
  if (!prompt.includes(SYSTEM_PREAMBLE)) errors.push("候选系统提示丢失了 preamble（规则破坏了组装）");
  if (rule !== undefined && !gated && rule.body.length >= 20 && !prompt.includes(rule.body.slice(0, 60))) {
    errors.push("stable 提案规则未出现在组装后的系统提示里");
  }
  if (gated) {
    // The lazy lane's real seam: the matcher hands the rule for a matching
    // read and the note carries the loop's own dedupe marker.
    const matcher = createContextRuleMatcher(root, rules.gated);
    const probe = scopeProbePath(input.paths?.[0] ?? "");
    const hits = matcher("read_file", { path: join(root, probe) });
    const hit = hits.find((r) => r.source === source);
    if (hit === undefined) {
      errors.push(`gated 提案规则匹配不到自己的适用范围（探测 "${probe}"）`);
    } else if (!buildRuleNote(hit).startsWith(ruleNotePrefix(source))) {
      errors.push("gated 规则笔记丢失了 loop 的去重标记");
    }
    if (input.ruleText.trim().length >= 20 && prompt.includes(input.ruleText.trim().slice(0, 60))) {
      errors.push("gated 提案规则泄漏进了 stable 提示节（车道错挂）");
    }
  }
}

/** Paired replay in fresh temp dirs (real loaders, real prompt assembly; the
 *  scripted-model loop coverage is the backbone suites' job below). */
export async function pairedRulesReplay(
  input: ImprovementGateInput,
  tmpRoot?: string,
): Promise<{ readonly baselineOk: boolean; readonly candidateOk: boolean; readonly errors: readonly string[] }> {
  const base = tmpRoot ?? tmpdir();
  const dirA = await mkdtemp(join(base, "wudao-gate-a-"));
  const dirB = await mkdtemp(join(base, "wudao-gate-b-"));
  try {
    await mkdir(join(dirB, ".wudao", "rules"), { recursive: true });
    await writeFile(join(dirB, ".wudao", "rules", input.ruleFileName), renderRuleFile(input), "utf8");
    const baselineErrors: string[] = [];
    assertBaseline(dirA, baselineErrors);
    const candidateErrors: string[] = [];
    assertCandidate(dirB, input, candidateErrors);
    return {
      baselineOk: baselineErrors.length === 0,
      candidateOk: candidateErrors.length === 0,
      errors: [...baselineErrors.map((e) => `[基线] ${e}`), ...candidateErrors.map((e) => `[候选] ${e}`)],
    };
  } finally {
    await rm(dirA, { recursive: true, force: true }).catch(() => {});
    await rm(dirB, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// ② The full gate: paired replay + backbone suites. Both must be green.
// ---------------------------------------------------------------------------

export async function runImprovementGate(
  input: ImprovementGateInput,
  opts: { readonly suites?: readonly AnyEvalDefinition[]; readonly tmpRoot?: string } = {},
): Promise<ImprovementGateVerdict> {
  const started = Date.now();
  const at = new Date().toISOString();
  const suites = opts.suites ?? selectGateSuites(GATE_SUITE_NAMES, deterministicSuites);
  const paired = await pairedRulesReplay(input, opts.tmpRoot);
  const results: readonly EvalResult[] = await runAllEvals(suites);
  const rows: ImprovementGateSuiteRow[] = results.map((r) => ({ name: r.name, status: r.status, errors: r.errors }));
  const suiteErrors = results.filter((r) => r.status !== "pass");
  let ok = paired.baselineOk && paired.candidateOk && suiteErrors.length === 0;
  let reason: string | undefined;
  if (!paired.baselineOk) {
    // Unjudgeable — the reef rule: an errored baseline ranks BELOW every real
    // verdict; the fail-open law upstream changes nothing either way.
    ok = false;
    reason = "基线未过——门不可判（未做任何改动）";
  } else if (!paired.candidateOk) {
    reason = "配对回放未过——提案规则削弱了规则车道";
  } else if (suiteErrors.length > 0) {
    reason = `骨干套件未全绿：${suiteErrors.map((r) => r.name).join("、")}`;
  }
  return {
    ok,
    ...(reason !== undefined ? { reason } : {}),
    paired: { baselineOk: paired.baselineOk, candidateOk: paired.candidateOk, errors: paired.errors },
    suites: rows,
    durationMs: Date.now() - started,
    at,
  };
}
