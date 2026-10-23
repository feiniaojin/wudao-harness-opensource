#!/usr/bin/env node
// 134 — GAIA validation 第二模型臂（MiniMax-M3）runner
// 用法: node gaia-minimax-runner.mjs [--limit N]
// 输出: wudao-bench/gaia-minimax-results.json（与 gaia-clean-results.json 同形）
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const BENCH = "~/xdev/github/wudao-harness-project/wudao-bench";
const WUDAO = "~/xdev/github/wudao-harness-project/wudao-harness/packages/cli/dist/index.js";
const PROGRESS_DIR = join(BENCH, "gaia-minimax-progress");
const OUT = join(BENCH, "gaia-minimax-results.json");
const MODEL_ARGS = ["--provider", "minimax-code", "--model", "MiniMax-M3"];

// Parse --limit
const limitIdx = process.argv.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) : Infinity;

// Load GAIA validation tasks from existing results (reuse the task IDs + questions)
const glmResults = JSON.parse(readFileSync(join(BENCH, "gaia-clean-results.json"), "utf8"));
const tasks = Object.entries(glmResults);
console.log(`GAIA MiniMax-M3 arm: ${tasks.length} tasks${Number.isFinite(LIMIT) ? ` (limit ${LIMIT})` : ""}`);

mkdirSync(PROGRESS_DIR, { recursive: true });

const normalize = (s) => String(s ?? "").trim().toLowerCase().replace(/[.,!?;:]+$/g, "");

// Process each task
const results = {};
let done = 0;
for (const [id, ref] of tasks) {
  if (done >= LIMIT) break;

  // Resume: skip completed
  const progressFile = join(PROGRESS_DIR, `${id}.json`);
  if (existsSync(progressFile)) {
    results[id] = JSON.parse(readFileSync(progressFile, "utf8"));
    done++;
    continue;
  }

  // Extract the question from the existing result's metadata
  // The original GAIA parquet has the question; we can get it from the progress dir of the glm run
  const glmProgress = join(BENCH, "gaia-clean-progress", `${id}.json`);
  let question = "";
  let want = ref.want ?? "";
  let level = ref.level ?? 1;
  if (existsSync(glmProgress)) {
    try {
      const p = JSON.parse(readFileSync(glmProgress, "utf8"));
      question = p.question ?? p.task ?? "";
      want = p.want ?? want;
      level = p.level ?? level;
    } catch {}
  }
  if (!question) {
    console.log(`  SKIP ${id.slice(0, 8)} (no question found)`);
    results[id] = { id, ok: false, level, got: "", want, wall_s: 0, error: "no-question" };
    writeFileSync(progressFile, JSON.stringify(results[id]));
    done++;
    continue;
  }

  // Run wudao with MiniMax-M3
  const start = Date.now();
  let got = "";
  let ok = false;
  let error = "";
  try {
    const proc = Bun.spawn([process.execPath, WUDAO, ...MODEL_ARGS, "--print", question], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, WUDAO_API_KEY: "", WUDAO_BASE_URL: "", WUDAO_MODEL: "" },
      timeout: 600_000, // 10min per task
    });
    const [out] = await Promise.all([new Response(proc.stdout).text()]);
    got = out.trim().split("\n").filter(l => l.length > 0).pop() ?? "";
    await proc.exited;
  } catch (e) {
    error = String(e);
  }
  const wall_s = (Date.now() - start) / 1000;
  ok = normalize(got) === normalize(want);

  results[id] = { id, ok, level, got, want, wall_s, ...(error ? { error } : {}) };
  writeFileSync(progressFile, JSON.stringify(results[id]));
  done++;
  const passCount = Object.values(results).filter(r => r.ok).length;
  console.log(`  ${done}/${tasks.length} ${id.slice(0, 8)} L${level} ${ok ? "✓" : "✗"} got="${got.slice(0, 30)}" want="${want.slice(0, 30)}" (${wall_s.toFixed(0)}s) [${passCount}/${done} = ${(passCount/done*100).toFixed(1)}%]`);
}

// Write final results
writeFileSync(OUT, JSON.stringify(results, null, 2));
const total = Object.keys(results).length;
const passed = Object.values(results).filter(r => r.ok).length;
console.log(`\nGAIA MiniMax-M3: ${passed}/${total} = ${total > 0 ? ((passed/total)*100).toFixed(1) : 0}% Pass@1`);
console.log(`Results: ${OUT}`);
