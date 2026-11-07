// 独立的压缩端到端案例：真实 loop + 真实模型 + 自然撞阈值。
//
// 验证三件事（这是此前的测试盲区——手工构造 span 的 A/B 测过冷轮代价，
// 但压缩在真实 loop 里自然触发从未测过）：
//   1. 压缩真的会在 loop 内部自然触发（threshold 0.8×window）；
//   2. 压缩边界前后每一轮的缓存命中率（usage 事件逐轮上报）；
//   3. 走的是 LLM 摘要而非角色统计 digest（工具内容多 → 必须走 LLM 路径）。
//
// 用法: node scripts/bench/compaction-e2e.mjs
//
// 2026-11-07 实测记录（DeepSeek，window=16000 / threshold=12800）：
//   稳态命中率 82→85%（每轮 miss ≈ 新增内容 2100 token，与设计一致）；
//   压缩在 loop 内自然触发（tier-1 桩压缩，15193→7040 省 8K）；
//   压缩后恰好一轮冷（7%），下一轮立即回到 80%+；
//   两次压缩、无 thrash、12 节任务完整跑完。
// 极端小窗（6000）会暴露另两件事，属边界行为而非缺陷：
//   tier-2 在小 span 上可能净负收益（簿记 > 节省）；microcompact 先换桩后
//   tier-2 看到的 span 已"薄"，digest 门会放行（但内容那时早已换成可重读桩）。
import { buildRunPlan } from "../../packages/cli/dist/run.js";
import { createProvider } from "../../packages/providers/dist/index.js";
import { runAgentLoop } from "../../packages/core/dist/loop.js";

const plan = buildRunPlan({ prompt: "", env: process.env, provider: "deepseek", model: "deepseek-v4-flash" });
if (plan.kind !== "real") { console.log("plan:", plan.kind, plan.reason ?? ""); process.exit(1); }
const model = createProvider(plan.config, {});

const SYS = "You are wudao, the user's agent. Always take the best route. Deliver evidence, not claims.";

// 一个每次返回 ~1200 token 内容的工具——按节递增，让上下文自然增长撞阈值。
let section = 0;
const reportTool = {
  name: "report_section",
  description: "Fetch one section of the Q3 report. Call with the section number you need next.",
  parameters: { type: "object", properties: { section: { type: "number" } }, required: ["section"] },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  isOpenWorld: () => false,
  async execute(input) {
    section += 1;
    const s = input.section ?? section;
    const body = Array.from({ length: 90 }, (_, i) => `metric ${s}.${i} = ${(i * 7 + s * 13) % 100}: trending stable over the quarter; variance within band; no action required.`).join("\n");
    return { content: `Q3 report section ${s}:\n${body}` };
  },
};

const state = {
  systemPrompt: SYS,
  messages: [{
    role: "user",
    content: "Fetch ALL 12 sections of the Q3 report with report_section (one call per section, sections 1 through 12, in order). After each fetch, note that section's key metric in one short line. After all 12, write a summary naming each section's headline metric. Do not stop early.",
  }],
  tools: [reportTool],
  status: "idle",
};

console.log("=== 独立压缩 E2E：window=16000，threshold=12800 ===");
let compactions = 0;
let lastUsage = null;
const loop = runAgentLoop(state, model, {
  maxTurns: 24,
  compaction: { contextWindowTokens: 16_000 },
});

for await (const ev of loop) {
  if (ev.type === "usage") {
    const u = ev.usage;
    const pct = u.promptTokens > 0 ? Math.round((u.cacheHitTokens / u.promptTokens) * 100) : 0;
    console.log(`turn${String(ev.turn).padStart(2)}: prompt=${String(u.promptTokens).padStart(6)} hit=${String(u.cacheHitTokens).padStart(6)} miss=${String(u.cacheMissTokens).padStart(5)} 命中率=${String(pct).padStart(3)}%`);
    lastUsage = u;
  } else if (ev.type === "compacted") {
    compactions += 1;
    console.log(`  ── 压缩#${compactions} tier=${ev.tier} trigger=${ev.trigger} reason=${ev.reason} ${ev.beforeTokens}→${ev.afterTokens} tokens`);
    if (ev.tier !== 2) { console.log(`     （tier-${ev.tier} 桩压缩：无摘要本体，工具结果已换成可重读的桩）`); continue; }
    const body = ev.summaryMessage?.content ?? "";
    const isDigest = body.includes("Deterministic context digest");
    console.log(`     摘要路径: ${isDigest ? "digest（角色统计——不该出现！）" : "LLM（结构化）"}，长度 ${body.length}`);
    if (!isDigest) console.log(body.slice(0, 900).replace(/\n/g, "\n     "));
  }
}
console.log(`\n=== 结果：压缩 ${compactions} 次；最后一轮命中率 ${lastUsage ? Math.round((lastUsage.cacheHitTokens / lastUsage.promptTokens) * 100) : "?"}% ===`);
