#!/usr/bin/env node
// GAIA benchmark launcher — bypasses shell escaping by reading tasks from file
// Usage: node gaia-workflow-launch.mjs <tasks.json> [limit] [--resume <runId>]
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const WUDAO = "/Users/qinyujie/xdev/github/wudao-harness-project/wudao-harness/packages/cli/dist/index.js";
const RUNNER = "/Users/qinyujie/xdev/github/wudao-harness-project/wudao-harness/scripts/gaia-runner.js";

// Read tasks
const tasksFile = process.argv[2];
if (!tasksFile) { console.error("Usage: node gaia-workflow-launch.mjs <tasks.json> [limit]"); process.exit(1); }
let tasks = JSON.parse(readFileSync(tasksFile, "utf8"));

// Apply limit
const limitIdx = process.argv.indexOf("--limit");
if (limitIdx >= 0) tasks = tasks.slice(0, Number(process.argv[limitIdx + 1]));

// Get MiniMax key from credentials
const creds = readFileSync(join(homedir(), ".wudao", ".credentials.yaml"), "utf8");
const mmKey = creds.match(/minimax-code:\s*(.+)/)?.[1]?.trim().replace(/^"|"$/g, "");
if (!mmKey) { console.error("No minimax-code key found"); process.exit(1); }

// Build args JSON
const argsJson = JSON.stringify({ tasks });

// Find --resume flag
const resumeIdx = process.argv.indexOf("--resume");
const resumeFlag = resumeIdx >= 0 ? ["--resume", process.argv[resumeIdx + 1]] : [];

// Run workflow
const cmd = ["node", WUDAO, "workflow", "run", RUNNER,
  "--args", argsJson,
  "--budget-tokens", "500000",
  ...resumeFlag];

console.log(`Launching GAIA benchmark: ${tasks.length} tasks`);
console.log(`Provider: minimax-code/MiniMax-M3`);

try {
  const out = execFileSync("node", cmd.slice(1), {
    env: { ...process.env, WUDAO_PROVIDER: "minimax-code", WUDAO_API_KEY: mmKey },
    cwd: "/tmp",
    timeout: 3600_000,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });
  console.log(out);
} catch (e) {
  if (e.stdout) console.log(e.stdout);
  console.error("Workflow failed:", e.message?.slice(0, 200));
}
