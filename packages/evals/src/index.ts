#!/usr/bin/env node
// @wudao/evals CLI (`pnpm eval`): run the deterministic suites (always) plus
// the live suites (skipped with a reason when no API key is present), print a
// pass/fail/skip table, write .wudao/evals/last.json, and exit non-zero on any
// failure. Deterministic or live — a failure is a failure.
//
// M48 §4 subcommand: `pnpm eval --workloop <session.jsonl>` scores one real
// session with the the upstream harness Agent Work Loop scorer (5 dims × 15
// checks) — observational only, never a CI gate (exit 0 unless the file
// itself cannot be read).
import { readFile } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runAllEvals, type EvalResult } from "./runner.js";
import { formatTable, evalExitCode, toReportJson, formatStatsSection, parseRunsArg } from "./report.js";
import { aggregateRuns } from "./stats.js";
import { compareReports, formatCompare } from "./compare.js";
import type { ReportJson } from "./report.js";
import { loadEnvFrom } from "./env.js";
import { deterministicSuites } from "./suites/deterministic.js";
import { liveSuites } from "./suites/live.js";
import { scoreWorkloop, loadSessionMessages, formatWorkloopReport } from "./workloop.js";

async function runWorkloopCommand(path: string): Promise<number> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    process.stderr.write(`--workloop: cannot read ${path}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const messages = loadSessionMessages(text);
  if (messages.length === 0) {
    process.stderr.write(`--workloop: no message entries in ${path}\n`);
    return 1;
  }
  process.stdout.write(`${formatWorkloopReport(scoreWorkloop({ messages }))}\n`);
  return 0;
}

async function readReport(path: string): Promise<ReportJson> {
  const text = await readFile(path, "utf8");
  return JSON.parse(text) as ReportJson;
}

/** ω-5a I18: `--compare <a.json> <b.json>` — pair by (name, trial), drop
 *  infra-excluded trials on either side, print per-suite pairedDelta CIs and
 *  the verdict line. Observational: exit 0 unless a file cannot be read. */
async function runCompareCommand(aPath: string, bPath: string): Promise<number> {
  let a: ReportJson;
  let b: ReportJson;
  try {
    [a, b] = await Promise.all([readReport(aPath), readReport(bPath)]);
  } catch (err) {
    process.stderr.write(`--compare: cannot read reports: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  process.stdout.write(`${formatCompare(compareReports(a, b), { a: aPath, b: bPath })}\n`);
  return 0;
}

async function main(): Promise<number> {
  // M48 §4: `--workloop <session.jsonl>` — score one session, exit.
  const args = process.argv.slice(2);
  if (args[0] === "--workloop") {
    if (args[1] === undefined) {
      process.stderr.write("usage: pnpm eval --workloop <session.jsonl>\n");
      return 1;
    }
    return runWorkloopCommand(args[1]);
  }

  // ω-5a I18: `--compare <a.json> <b.json>` — the A/B verdict, exit.
  if (args[0] === "--compare") {
    if (args[1] === undefined || args[2] === undefined) {
      process.stderr.write("usage: pnpm eval --compare <a.json> <b.json>\n");
      return 1;
    }
    return runCompareCommand(args[1], args[2]);
  }

  // Live suites read the API key etc. from the environment; load a nearby
  // .env (existing env wins) exactly like the CLI does.
  for (const [k, v] of Object.entries(loadEnvFrom(process.cwd(), process.env))) {
    if (!(k in process.env)) process.env[k] = v;
  }

  // M57 fix-round: isolate the GLOBAL config tier for the whole run. The det
  // suites call the rewired two-tier loaders directly; a real
  // ~/.wudao/settings.json would silently merge in (a global deny could flip
  // det-23/det-30, a global skill breaks the skills eval's list). Suites that
  // need a global tier (det-43) set WUDAO_GLOBAL_HOME per-case on top.
  if (process.env.WUDAO_GLOBAL_HOME === undefined) {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "wudao-evals-global-"));
    process.env.WUDAO_GLOBAL_HOME = dir;
    process.on("exit", () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup only
      }
    });
  }

  // M51 §1: `--runs N` — run every suite N times; the report gains across-run
  // statistics (mean/SE/95% CI/Pass^k) and det suites that flip status across
  // runs are flagged NON-DETERMINISTIC. Fail-closed on a bad value.
  const runsParsed = parseRunsArg(args);
  if (typeof runsParsed !== "number") {
    process.stderr.write(`usage: pnpm eval [--runs N (1..20)] — ${runsParsed.reason}\n`);
    return 1;
  }
  const runs = runsParsed;

  const perRun: EvalResult[][] = [];
  const outDir = join(process.cwd(), ".wudao", "evals");
  // ω-5a I18: failing trials (and WUDAO_EVAL_KEEP=1 keeps passing ones too)
  // leave their workspace + receipt.json here, pruned to the last 20.
  const receipts = { outRoot: join(outDir, "receipts") };
  process.stdout.write("wudao-harness evals\n===================\n");
  for (let r = 0; r < runs; r += 1) {
    if (runs > 1) process.stdout.write(`\n-- run ${r + 1}/${runs} --\n`);
    process.stdout.write("\n-- deterministic (scripted model, no network) --\n");
    const results: EvalResult[] = [];
    results.push(...await runAllEvals(deterministicSuites, { trial: r + 1, receipts }));
    process.stdout.write("\n-- live (real model via .env; skipped without a key) --\n");
    results.push(...await runAllEvals(liveSuites, { trial: r + 1, receipts }));
    perRun.push(results);
  }
  const results: EvalResult[] = perRun.flat();

  await mkdir(outDir, { recursive: true });
  const stats = runs > 1 ? aggregateRuns(perRun) : undefined;
  await writeFile(join(outDir, "last.json"), `${JSON.stringify(toReportJson(results, stats !== undefined ? { stats } : {}), null, 2)}\n`, "utf8");

  if (stats !== undefined) {
    process.stdout.write(`\n${formatStatsSection(stats)}\n`);
  } else {
    process.stdout.write(`\n${formatTable(results)}\n`);
  }
  process.stdout.write(`\nreport: ${join(outDir, "last.json")}\n`);
  return evalExitCode(results);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`evals crashed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
