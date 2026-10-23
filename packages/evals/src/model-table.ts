// 134 — 模型路由器的数据面基座（model_table）。
//
// 问题定义：路由器需要"模型 × 任务类别 × Pass@1 × 成本"的表来决定
// "最可能解决该任务的最便宜模型"。当前数据只有 glm-5.3 的单模型八基准
// 成绩——零区分度，无法路由。
//
// 本模块是**结构化结果记录器**——不跑基准（马拉松在 wudao-bench/），只
// 定义表的模式与从成绩单提取的纯函数。跑完第二模型臂后 populate 即得
// 可路由的 model_table。
//
// 超越点（vs OpenHands）：
// - 表的每格可追溯到冻结配置净测 Pass@1（红线令）
// - 成本用 pricing 目录的 per-M-USD 算 $/run（不是猜）
// - 只在开窗时路由（M24 不变量已在 134 报告定谳）

/** One cell of the model_table: a model's result on one benchmark. */
export interface ModelBenchmarkResult {
  readonly model: string;
  readonly provider: string;
  readonly benchmark: string;
  /** Frozen-config net Pass@1, 0-1. The ONLY metric that goes in the table. */
  readonly passAt1: number;
  /** Total runs (denominator). */
  readonly totalRuns: number;
  /** Successful runs (numerator). */
  readonly passed: number;
  /** Estimated cost per run in USD (from pricing catalog). */
  readonly costPerRunUsd?: number;
  /** ISO date of the measurement. */
  readonly measuredAt: string;
  /** Methodology notes (frozen config, net test, etc). */
  readonly methodology?: string;
}

/** The routing table: which model to pick for which task category. */
export interface ModelTable {
  readonly results: readonly ModelBenchmarkResult[];
}

/** Task categories the router classifies into (OpenHands taxonomy adapted). */
export type TaskCategory =
  | "bug-fix"        // SWE-bench shape: fix a failing test
  | "test-gen"       // Generate tests for existing code
  | "greenfield"     // Build from scratch
  | "research"       // GAIA shape: multi-step reasoning + tools
  | "conversation"   // τ-bench shape: multi-turn stateful dialogue
  | "terminal";      // Terminal-Bench shape: long-horizon CLI tasks

/** Map benchmark names to the task categories they measure. */
export const BENCHMARK_CATEGORY: Readonly<Record<string, TaskCategory>> = {
  "swe-bench-lite": "bug-fix",
  "gaia-validation": "research",
  "tau2-telecom": "conversation",
  "tau-retail": "conversation",
  "terminal-bench": "terminal",
  "humaneval": "greenfield",
  "aider-polyglot": "greenfield",
  "bfcl-v4": "conversation",
};

/** Best model for a category: highest Pass@1 among models with results. */
export function bestFor(
  table: ModelTable,
  category: TaskCategory,
): { model: string; passAt1: number; costPerRunUsd?: number } | undefined {
  let best: { model: string; passAt1: number; costPerRunUsd?: number } | undefined;
  for (const r of table.results) {
    const cat = BENCHMARK_CATEGORY[r.benchmark];
    if (cat !== category) continue;
    if (best === undefined || r.passAt1 > best.passAt1) {
      best = { model: r.model, passAt1: r.passAt1, ...(r.costPerRunUsd !== undefined ? { costPerRunUsd: r.costPerRunUsd } : {}) };
    }
  }
  return best;
}

/** The table's coverage: which categories have ≥2 models (routable). */
export function routableCategories(table: ModelTable): TaskCategory[] {
  const byCat = new Map<TaskCategory, Set<string>>();
  for (const r of table.results) {
    const cat = BENCHMARK_CATEGORY[r.benchmark];
    if (cat === undefined) continue;
    if (!byCat.has(cat)) byCat.set(cat, new Set());
    byCat.get(cat)!.add(r.model);
  }
  return [...byCat.entries()].filter(([, models]) => models.size >= 2).map(([cat]) => cat);
}

/** Render the table as a human-readable comparison. */
export function renderTable(table: ModelTable): string {
  const byModel = new Map<string, ModelBenchmarkResult[]>();
  for (const r of table.results) {
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model)!.push(r);
  }
  const lines: string[] = ["模型 × 基准 Pass@1 对照表", ""];
  for (const [model, results] of byModel) {
    lines.push(`## ${model} (${results[0]?.provider ?? "?"})`);
    for (const r of results.sort((a, b) => a.benchmark.localeCompare(b.benchmark))) {
      const pct = (r.passAt1 * 100).toFixed(1);
      const cost = r.costPerRunUsd !== undefined ? ` · $${r.costPerRunUsd.toFixed(3)}/run` : "";
      lines.push(`  ${r.benchmark}: ${pct}% (${r.passed}/${r.totalRuns})${cost}`);
    }
    lines.push("");
  }
  const routable = routableCategories(table);
  lines.push(routable.length > 0
    ? `可路由类别（≥2 模型）：${routable.join(", ")}`
    : "⚠️ 零可路由类别——需 ≥2 模型的非饱和基准数据");
  return lines.join("\n");
}
