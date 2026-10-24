#!/usr/bin/env node
// 134 — GAIA validation benchmark runner（M11 workflow 引擎驱动）
//
// 用 M11 的确定性脚本做 benchmark 编排——替代 shell+stdout 解析：
//   - task() 的 prompt 就是 GAIA 问题
//   - responseSchema 就是答案格式（字符串）
//   - verify 的 exactMatch 就是评分器
//   - journal 就是断点续跑（崩溃恢复零模型重调）
//   - --answer-only 就是干净答案输出
//
// 用法:
//   wudao workflow run gaia-benchmark.js --args '{"tasks": [...], "model": "minimax-code/MiniMax-M3"}'
//   或直接: node scripts/gaia-benchmark.js --export  # 导出任务 JSON 供 workflow 消费

// --- 内联 workflow 脚本（M11 的 seven primitives 形） ---
const WORKFLOW_SCRIPT = `
// GAIA benchmark: 逐题问答+评分，journal 断点续跑
const results = [];
const total = args.tasks.length;
let passed = 0;

for (let i = 0; i < total; i++) {
  const t = args.tasks[i];
  log({ progress: \`\${i + 1}/\${total}\`, id: t.id.slice(0, 8), level: t.level });

  const r = await task(
    `Answer this question. Use available tools to research if needed.\\n\\n${t.question}\\n\\nReply with ONLY a JSON object: {"answer": "your answer"}`,
    {
      label: \`gaia-\${t.id.slice(0, 8)}\`,
      retry: 0,           // 单发——净测 Pass@1 口径
      maxTurns: 15,
      allowTools: ["grep", "read_file", "run_command", "web_search", "glob"],
      responseSchema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } },
    }
  );

  const got = r.ok ? String((r.data ?? {}).answer ?? r.text ?? "").trim().toLowerCase().replace(/[.,!?;:]+$/, "") : "";
  const want = String(t.want).trim().toLowerCase().replace(/[.,!?;:]+$/, '');
  const ok = got === want;
  if (ok) passed++;
  results.push({ id: t.id, level: t.level, ok, got: got.slice(0, 200), want, wall_s: 0 });
}

log({ summary: { passed, total, passAt1: (passed / total * 100).toFixed(1) + '%' } });
return { results, passed, total, passAt1: passed / total };
`;

// --- Node-side: export tasks from parquet → JSON for the workflow ---
export async function exportTasks(limit = 0) {
  const { execSync } = await import("node:child_process");
  const py = `
import pandas as pd, json
df = pd.read_parquet("/Users/qinyujie/xdev/github/wudao-harness-project/wudao-bench/gaia-validation.parquet")
${limit > 0 ? `df = df.head(${limit})` : ""}
tasks = [{"id": r["task_id"], "question": r["Question"], "want": r["Final answer"], "level": int(r["Level"])} for _, r in df.iterrows()]
print(json.dumps(tasks))
`;
  const out = execSync(`python3 -c '${py}'`, { encoding: "utf8" });
  return out.trim();
}

// --- CLI entry: --export to dump tasks JSON, --script to dump the workflow script ---
async function main() {
  if (process.argv.includes("--export")) {
    const limit = process.argv.includes("--limit")
      ? Number(process.argv[process.argv.indexOf("--limit") + 1])
      : 0;
    console.log(await exportTasks(limit));
  } else if (process.argv.includes("--script")) {
    console.log(WORKFLOW_SCRIPT);
  } else {
    console.log(`GAIA Benchmark Runner (M11 workflow engine)
用法:
  node ${process.argv[1]} --export [--limit N]    # 导出任务 JSON
  node ${process.argv[1]} --script                # 导出 workflow 脚本
`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
