// `wudao workflow run <file.js|file.json> [--resume <runId>] [--auto|--read-only]
//   [--budget-tokens N] [--args <json>]` · `wudao workflow list` · `wudao workflow status <runId>`
//
// A `.js` file runs in the M29 script engine (JS is the workflow language);
// a `.json` file is compiled by the M22 adapter into an equivalent plan and
// runs through the SAME engine — old workflows keep working, with the new
// journal, budget and failure taxonomy underneath.
//
// Exit codes: 0 = all ok (or fully replayed); 1 = run failure (task failed,
// budget exhausted, no API key, unknown resume id); 2 = usage / validation.
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { ModelClient, PermissionDecision } from "@wudao-org/core";
import { createProvider, resolveProviderConfigResult, type ProviderConfig } from "@wudao-org/providers";
import { credentialMaterialPath, decidePermission, decideRichPermission, modeFromArgv } from "../permission.js";
import { loadLayeredSettings } from "../settings-layer.js";
import { parseFallbackModels } from "../misc-config.js";
import { parseWorkflow } from "./schema.js";
import {
  journalFilePath,
  listWorkflowStates,
  loadJournal,
  workflowIdentity,
  newRunId,
  openJournal,
  readWorkflowState,
  workflowStatePath,
} from "./journal.js";
import { planFromWorkflow, runPlanWorkflow, runScriptWorkflow, type JsflowEvent, type JsflowRunResult } from "./engine.js";
import { DEFAULT_BUDGET_TOKENS } from "./budget.js";
import { routePreflight } from "./preflight.js";
// Provider management §7: the workflow window rides the per-model chain.
import { loadEffectiveProfiles, resolveSessionWindowTokens } from "../provider-registry.js";
import {
  MEA_AUDITOR_MODEL_LABEL,
  MEA_DISABLE_ENV,
  parseMeaGoal,
  priorChargedSpend,
  recoverMeaState,
  runMeaWorkflow,
  type MeaState,
} from "./mea.js";
import { buildEvaluatorModel, type EvaluatorModel } from "../goal.js";

// ω99-166e-ii: #1（块体整体中文化，反引号模板与 ${DEFAULT_BUDGET_TOKENS} 两处插值结构不变）
const USAGE = `用法：wudao workflow <command>

  run <file.js|file.json>   运行 workflow 脚本（.js）或 M22 JSON workflow
      --resume <runId>        续跑既有 run；命中的任务从 journal 零模型调用重放；
                              任务有改动则从编辑点截断 journal
      --args <json>          脚本 args 全局的 JSON 值（仅 .js）；
                              必须可解析——坏值按用法错误失败
      --budget-tokens N      单次运行 token 预算（默认 ${DEFAULT_BUDGET_TOKENS}）；
                              超出即以预算耗尽失败
      --allow-cmd <name>      授予脚本 run() 原语的命令（可重复；未授予的命令
                              fail-closed 拒绝——能力≠策略，命令集在调用时可知）
      --auto                 允许在白名单了非只读工具的任务里使用它们
      --read-only            全程拒绝非只读工具
  mea <goal.json>            运行 MEA workflow（管理–执行–审计）：管理器提出有界
                              子任务，执行器在全新上下文里跑它们，goal 文件里的
                              确定性门是「完成」的唯一权威
      --resume <runId>        从 journal 记录的任务 STATE 续跑 MEA run（轮次、门
                              矩阵、失败证据）；不重放、不截断；剩余预算 =
                              总额减去已消耗
      --budget-tokens N      单次运行 token 预算（默认 ${DEFAULT_BUDGET_TOKENS}）
      --auto                 允许执行器任务使用其白名单内的非只读工具
                              （MEA 任务中途不能弹询问）
      --read-only            全程拒绝非只读工具
  list                       列出既往 run（读各自 terminal state.json）
  status <runId>             查看单个 run 的终态
journal：.wudao/workflows/<runId>.jsonl（append-only；可安全重跑）`;

export type ParsedWorkflowArgs =
  | { kind: "run"; file: string; resumeId?: string; budgetTokens?: number; args?: unknown; allowCmd?: readonly string[] }
  | { kind: "mea"; file: string; resumeId?: string; budgetTokens?: number }
  | { kind: "list" }
  | { kind: "status"; runId: string }
  | { kind: "usage"; error?: string };

const MODE_FLAGS = new Set(["--auto", "--read-only"]);

// Parse tokens AFTER "workflow" (e.g. ["run", "f.js", "--resume", "id"]).
export function parseWorkflowArgs(argv: readonly string[]): ParsedWorkflowArgs {
  const [cmd, ...rest] = argv;
  if (cmd === "list") {
    return rest.length > 0 ? { kind: "usage", error: `unexpected argument "${rest[0]}"` } : { kind: "list" };
  }
  if (cmd === "status") {
    const runId = rest[0];
    if (runId === undefined || runId.startsWith("--")) return { kind: "usage", error: "status requires a runId" };
    if (rest.length > 1) return { kind: "usage", error: `unexpected argument "${rest[1]}"` };
    return { kind: "status", runId };
  }
  if (cmd !== "run" && cmd !== "mea") {
    return { kind: "usage", error: cmd === undefined ? undefined : `unknown subcommand "${cmd}"` };
  }
  let file: string | undefined;
  let resumeId: string | undefined;
  let budgetTokens: number | undefined;
  let args: unknown;
  const allowCmd: string[] = []; // M11 #2：--allow-cmd 可重复积聚
  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i];
    if (tok === undefined) break;
    if (tok === "--resume") {
      const next = rest[i + 1];
      if (!next) return { kind: "usage", error: "--resume requires a runId" };
      resumeId = next;
      i += 1;
    } else if (cmd === "run" && tok === "--args") {
      const next = rest[i + 1];
      if (next === undefined) return { kind: "usage", error: "--args requires a JSON value" };
      try {
        args = JSON.parse(next) as unknown;
      } catch (err) {
        return { kind: "usage", error: `--args requires valid JSON (${err instanceof Error ? err.message : String(err)})` };
      }
      i += 1;
    } else if (tok === "--budget-tokens") {
      const next = rest[i + 1];
      const parsed = next !== undefined ? Number(next) : NaN;
      if (!Number.isInteger(parsed) || parsed < 1) {
        return { kind: "usage", error: `--budget-tokens requires an integer >= 1 (got "${next ?? "nothing"}")` };
      }
      budgetTokens = parsed;
      i += 1;
    } else if (cmd === "run" && tok === "--allow-cmd") {
      // M11 #2：授予脚本级 run() 的命令（可重复；能力≠策略）。
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) return { kind: "usage", error: "--allow-cmd requires a command name" };
      allowCmd.push(next);
      i += 1;
    } else if (MODE_FLAGS.has(tok)) {
      // consumed by the permission gate below
    } else if (tok.startsWith("--")) {
      return { kind: "usage", error: `unknown flag "${tok}"` };
    } else if (file === undefined) {
      file = tok;
    } else {
      return { kind: "usage", error: `unexpected argument "${tok}"` };
    }
  }
  if (file === undefined) {
    return { kind: "usage", error: cmd === "mea" ? "missing MEA goal file" : "missing workflow file" };
  }
  if (cmd === "mea") {
    return {
      kind: "mea", file,
      ...(resumeId !== undefined ? { resumeId } : {}),
      ...(budgetTokens !== undefined ? { budgetTokens } : {}),
    };
  }
  return {
    kind: "run", file,
    ...(resumeId !== undefined ? { resumeId } : {}),
    ...(budgetTokens !== undefined ? { budgetTokens } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(allowCmd.length > 0 ? { allowCmd } : {}),
  };
}

export interface WorkflowCliDeps {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly buildModel?: (config: ProviderConfig) => ModelClient;
  /** ω-4c: the MEA auditor's cheap-model picker (defaults to the /goal
   *  machinery — cheapest priced matrix model, else the session model). */
  readonly buildAuditorModel?: (sessionModel: ModelClient, sessionMeta: { readonly provider?: string; readonly model: string }, env: NodeJS.ProcessEnv) => EvaluatorModel;
  readonly out?: (s: string) => void;
}

// Permission gate per CLI mode, adapted for unattended workflow runs: "ask"
// (default mode + non-read tool) fail-closes to a deny with a pointed hint —
// a scripted run has no human to prompt mid-task.
export function workflowPermissionGate(argv: readonly string[]): (toolName: string, input: Record<string, unknown>) => Promise<PermissionDecision> {
  const mode = modeFromArgv(argv as string[]);
  return async (toolName: string, input: Record<string, unknown>): Promise<PermissionDecision> => {
    const decision = decideRichPermission({ mode, toolName, input });
    if (decision === "ask") {
      const cred = credentialMaterialPath(toolName, input);
      if (cred !== undefined) {
        return {
          behavior: "deny",
          reason: `workflow runs cannot prompt on credential material (${cred}); pre-approve with an allow rule in .wudao/settings.json if the run genuinely needs it`,
        };
      }
      return { behavior: "deny", reason: "workflow runs cannot prompt; re-run with --auto to allow non-read tools" };
    }
    return decision;
  };
}

// ---------------------------------------------------------------------------
// list / status (read state.json only — no key, no model)
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}

function runList(cwd: string, out: (s: string) => void): number {
  const states = listWorkflowStates(cwd);
  if (states.length === 0) {
    out("no workflow runs yet — journals and terminal states live in .wudao/workflows/\n");
    return 0;
  }
  out(`${"runId".padEnd(36)} ${"status".padEnd(10)} ${"tasks".padEnd(9)} ${"tokens".padStart(8)}  workflow\n`);
  for (const s of states) {
    const tasks = `${s.tasksOk}/${s.tasksTotal}${s.tasksReplayed > 0 ? ` (${s.tasksReplayed}↩)` : ""}`;
    out(
      `${s.runId.padEnd(36)} ${s.status.padEnd(10)} ${tasks.padEnd(9)} ${formatTokens(s.cost.promptTokens + s.cost.completionTokens).padStart(8)}  ${s.workflow}\n`,
    );
  }
  return 0;
}

function runStatus(cwd: string, runId: string, out: (s: string) => void): number {
  const state = readWorkflowState(workflowStatePath(cwd, runId));
  if (state === undefined) {
    out(`no terminal state for runId "${runId}" in ${cwd}/.wudao/workflows — is it a valid run id (see: wudao workflow list)?\n`);
    return 1;
  }
  out(`run        ${state.runId}\n`);
  out(`workflow   ${state.workflow}\n`);
  out(`status     ${state.status}\n`);
  out(`started    ${state.startedAt}\n`);
  out(`finished   ${state.finishedAt}\n`);
  out(`tasks      ${state.tasksOk}/${state.tasksTotal} ok (${state.tasksReplayed} replayed from the journal)\n`);
  out(`tokens     ${state.cost.promptTokens} prompt + ${state.cost.completionTokens} completion\n`);
  if (state.failure !== undefined) {
    out(`failure    ${state.failure.category}: ${state.failure.message}\n`);
  }
  out(`journal    ${journalFilePath(cwd, runId)}\n`);
  return state.status === "completed" ? 0 : 1;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

function printEvent(e: JsflowEvent, out: (s: string) => void): void {
  if (e.type === "run-started" || e.type === "run-finished") return; // the summary lines cover these
  if (e.type === "task-started") {
    out(`▶ ${e.label} …\n`);
  } else if (e.type === "task-finished") {
    if (e.replayed) {
      out(`▶ ${e.label} … ↩️ replayed from journal (${e.toolsUsed.length} tools)\n`);
    } else if (e.ok) {
      out(`▶ ${e.label} … ✅ (${e.toolsUsed.length} tools)\n`);
    } else {
      const failure = e.failure !== undefined ? ` — ${e.failure.category}: ${e.failure.message}` : "";
      out(`▶ ${e.label} … ❌${failure}\n`);
    }
  } else if (e.type === "log") {
    out(`· ${e.message}\n`);
  } else if (e.type === "journal-truncated") {
    out(`⚠ script changed at task ${e.atSeq + 1} — journal truncated at the edit point, rerunning from there\n`);
  } else if (e.type === "workflow-started") {
    out(`↳ sub-workflow ${e.name}\n`);
  } else if (e.type === "mea-round") {
    out(`◎ round ${e.round} · ${e.gatesPassing}/${e.gatesTotal} gates${e.subtask !== undefined ? ` · ${e.subtask}` : ""}\n`);
  }
}

function printSummary(result: JsflowRunResult, name: string, runId: string, journalPath: string, file: string, out: (s: string) => void): void {
  if (result.ok) {
    out(`✅ ${name}: ${result.tasksOk}/${result.tasksTotal} tasks ok (run ${runId})\n`);
    return;
  }
  const failure = result.failure !== undefined ? ` — ${result.failure.category}: ${result.failure.message}` : "";
  out(`❌ ${name}: FAILED${failure} (${result.tasksOk}/${result.tasksTotal} tasks ok, run ${runId})\n`);
  out(`journal: ${journalPath}\nresume with: wudao workflow run ${file} --resume ${runId}\n`);
}

// ---------------------------------------------------------------------------
// mea — the MEA workflow template (ω-4c §3.1, §3.5–§3.7)
// ---------------------------------------------------------------------------

interface MeaCommandCtx {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly now: () => Date;
  readonly deps: WorkflowCliDeps;
  readonly out: (s: string) => void;
}

async function runMeaCommand(
  parsed: Extract<ParsedWorkflowArgs, { kind: "mea" }>,
  ctx: MeaCommandCtx,
): Promise<number> {
  const { out, cwd, env, deps } = ctx;

  // Kill switch first (the scheduler cronDisabled posture): the refusal needs
  // no file, no key, and no model client.
  if ((env[MEA_DISABLE_ENV] ?? "").trim() === "1") {
    out(`MEA workflows are disabled (${MEA_DISABLE_ENV}=1) — the mea subcommand refuses to run\n`);
    return 2;
  }

  let text: string;
  try {
    text = readFileSync(parsed.file, "utf8");
  } catch (err) {
    out(`cannot read MEA goal file: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (extname(parsed.file).toLowerCase() !== ".json") {
    out(`MEA goal file must be .json, got "${extname(parsed.file) || "none"}"\n`);
    return 2;
  }
  const validated = parseMeaGoal(text);
  if (!validated.valid) {
    out(`invalid MEA goal (${parsed.file}):\n`);
    for (const error of validated.errors) out(`  - ${error}\n`);
    return 2;
  }
  const goal = validated.goal;
  const name = goal.name ?? parsed.file;

  // §3.5 resume = STATE continuation: recover the last meaRound state and the
  // prior charged spend. resumeTasks is deliberately NOT built — the engine's
  // replay cursor would see a key mismatch at seq 0 and truncate the journal.
  let resumeState: MeaState | undefined;
  let priorSpent = 0;
  if (parsed.resumeId !== undefined) {
    const loaded = loadJournal(journalFilePath(cwd, parsed.resumeId));
    if (loaded.records.length === 0) {
      out(`no journal for runId "${parsed.resumeId}" in ${cwd}/.wudao/workflows — nothing to resume\n`);
      return 1;
    }
    // ω-4c review M1: the journal kind must match the subcommand (the mirror
    // of the run path's mea-journal guard below). A js/json-adapter journal
    // (or a legacy engine-less one) carries no meaRound state — resuming it
    // here would silently start a FRESH MEA run inside another run's journal
    // and charge that run's spend against this budget.
    const started = loaded.records.find((r): r is Extract<typeof r, { type: "run-started" }> => r.type === "run-started");
    if (started?.engine !== "mea") {
      out(`runId "${parsed.resumeId}" is not a MEA journal (engine: ${started?.engine ?? "none"}) — use \`wudao workflow run <file> --resume ${parsed.resumeId}\` (task replay)\n`);
      return 1;
    }
    resumeState = recoverMeaState(loaded.records);
    priorSpent = priorChargedSpend(loaded.records);
    out(`resuming ${parsed.resumeId}: MEA state continuation from round ${resumeState?.round ?? 0} (${priorSpent} tokens already charged, ${loaded.tasks.length} task entries kept as audit history)\n`);
  }
  const budgetTotal = parsed.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const budgetTokens = budgetTotal - priorSpent;
  if (budgetTokens <= 0) {
    out(`prior runs already charged ${priorSpent} of the ${budgetTotal}-token budget — increase --budget-tokens to continue\n`);
    return 1;
  }

  // R-W1 (T2 review c): resolve through the registry's effective view — the
  // same threading run.ts got in T2 — so WUDAO_PROVIDER=<registry-id> boots
  // the custom on its own registry config instead of the builtin-only
  // "unknown provider" fail-fast.
  const profiles = loadEffectiveProfiles();
  const resolved = resolveProviderConfigResult(env, {}, undefined, profiles);
  const config: ProviderConfig | null = resolved.ok ? resolved.config : null;
  if (!config) {
    out("No API key found. Set WUDAO_API_KEY (or OPENAI_API_KEY), optionally WUDAO_BASE_URL / WUDAO_MODEL, then rerun.\n");
    return 1;
  }
  const settingsWarn = (m: string): void => { process.stderr.write(`${m}\n`); };
  const layered = await loadLayeredSettings(cwd, settingsWarn, env);
  const fallbackChain = parseFallbackModels(layered.effective, settingsWarn);
  const routeConfig = fallbackChain.length > 0 ? { ...config, fallbackModels: fallbackChain } : config;
  const model = (deps.buildModel ?? createProvider)(routeConfig);

  // §3.6 role-model routing: the auditor rides the cheapest matrix model when
  // one exists (the /goal machinery); the manager stays on the run model.
  const evaluator = (deps.buildAuditorModel ?? buildEvaluatorModel)(model, { provider: config.provider, model: config.model }, env);
  const taskModels = evaluator.fallback ? undefined : new Map([[MEA_AUDITOR_MODEL_LABEL, evaluator.client]]);

  const runId = parsed.resumeId ?? newRunId(ctx.now());
  const path = journalFilePath(cwd, runId);
  out(`MEA ${name} — run ${runId} (${goal.gates.length} gates, max ${goal.maxRounds} rounds)\n`);
  if (evaluator.fallback) {
    out(`auditor: session model (${evaluator.label})\n`);
  } else {
    out(`auditor: ${evaluator.label}\n`);
  }

  // M56 §5 route preflight — same admission contract as the run path.
  const admission = routePreflight({ env, model: config.model, budgetRemaining: budgetTokens, budgetTotal, fallbackModels: fallbackChain, providers: profiles });
  if (!admission.ok) {
    out(`preflight refused (no task admitted):\n${admission.refusals.map((r) => `  - ${r}`).join("\n")}\n`);
    return 1;
  }
  const preflightGate = (): string | undefined => {
    const r = routePreflight({ env, model: config.model, budgetRemaining: budgetTokens, budgetTotal, fallbackModels: fallbackChain, providers: profiles });
    return r.ok ? undefined : r.refusals.join("; ");
  };

  const result = await runMeaWorkflow(goal, {
    workspaceRoot: cwd,
    model,
    journal: openJournal(path),
    workflowName: name,
    canUseTool: workflowPermissionGate(ctx.argv),
    // §7: per-model window (registry contextLength → provider default → env).
    contextWindowTokens: resolveSessionWindowTokens({
      effective: undefined,
      envWindowTokens: Number(env.WUDAO_CONTEXT_WINDOW ?? "200000") || 200000,
      provider: config.provider,
      model: config.model,
    }),
    budgetTokens,
    ...(taskModels !== undefined ? { taskModels } : {}),
    ...(resumeState !== undefined ? { resumeState } : {}),
    preflight: preflightGate,
    onEvent: (e: JsflowEvent) => printEvent(e, out),
  });

  if (result.ok) {
    const digest = result.returnValue as { gates?: string; rounds?: number } | undefined;
    out(`✅ ${name}: ${digest?.gates ?? "?"} gates passing in ${digest?.rounds ?? "?"} rounds — ${result.tasksOk}/${result.tasksTotal} tasks ok (run ${runId})\n`);
    return 0;
  }
  const failure = result.failure !== undefined ? ` — ${result.failure.category}: ${result.failure.message}` : "";
  out(`❌ ${name}: FAILED${failure} (${result.tasksOk}/${result.tasksTotal} tasks ok, run ${runId})\n`);
  out(`journal: ${path}\nresume with: wudao workflow mea ${parsed.file} --resume ${runId}\n`);
  return 1;
}

export async function workflowMain(argv: readonly string[], deps: WorkflowCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => { process.stdout.write(s); });
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());

  const parsed = parseWorkflowArgs(argv);
  if (parsed.kind === "usage") {
    out(`${parsed.error ? parsed.error + "\n" : ""}${USAGE}\n`);
    return 2;
  }
  if (parsed.kind === "list") return runList(cwd, out);
  if (parsed.kind === "status") return runStatus(cwd, parsed.runId, out);
  if (parsed.kind === "mea") {
    return runMeaCommand(parsed, { argv, cwd, env, now, deps, out });
  }

  let text: string;
  try {
    text = readFileSync(parsed.file, "utf8");
  } catch (err) {
    out(`cannot read workflow file: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const ext = extname(parsed.file).toLowerCase();
  if (ext !== ".js" && ext !== ".json") {
    out(`workflow file must be .js (script engine) or .json (M22 adapter), got "${ext || "none"}"\n`);
    return 2;
  }
  if (parsed.args !== undefined && ext === ".json") {
    out("--args is only supported for .js scripts — M22 JSON workflows take no runtime arguments\n");
    return 2;
  }

  // .json keeps M22's exhaustive validation; .js is validated at compile time.
  let jsonPlan: ReturnType<typeof planFromWorkflow> | undefined;
  let name: string;
  if (ext === ".json") {
    const validated = parseWorkflow(text);
    if (!validated.valid) {
      out(`invalid workflow (${parsed.file}):\n`);
      for (const error of validated.errors) out(`  - ${error}\n`);
      return 2;
    }
    name = validated.workflow.name ?? parsed.file;
    jsonPlan = planFromWorkflow(name, validated.workflow.steps);
  } else {
    name = parsed.file;
  }

  // Resolve the resume set BEFORE touching the provider — a bad --resume id
  // fails fast without needing a key or a model at all.
  let resumeTasks: ReturnType<typeof loadJournal>["tasks"] | undefined;
  let resumeCmds: ReturnType<typeof loadJournal>["cmds"] | undefined; // M11 #2
  let resumeIdentity: ReturnType<typeof loadJournal>["identity"] = undefined;
  if (parsed.resumeId !== undefined) {
    const loaded = loadJournal(journalFilePath(cwd, parsed.resumeId));
    if (loaded.records.length === 0) {
      out(`no journal for runId "${parsed.resumeId}" in ${cwd}/.wudao/workflows — nothing to resume\n`);
      return 1;
    }
    // ω-4c §3.5 guard: a MEA journal must resume through `workflow mea
    // --resume` (state continuation) — the run path's task replay would see a
    // key mismatch at seq 0 and truncate the audit trail.
    const started = loaded.records.find((r): r is Extract<typeof r, { type: "run-started" }> => r.type === "run-started");
    if (started?.engine === "mea") {
      out(`this is a MEA run — use \`wudao workflow mea <goal.json> --resume ${parsed.resumeId}\` (MEA resumes by task state, not task replay)\n`);
      return 1;
    }
    resumeTasks = loaded.tasks;
    resumeCmds = loaded.cmds;
    // 133 #3：被恢复日志的原始身份（旧日志无 → undefined → 旧行为）。
    resumeIdentity = loaded.identity;
    out(`resuming ${parsed.resumeId}: ${resumeTasks.length} task(s) replayable from the journal\n`);
  }

  // R-W1 (T2 review c): resolve through the registry's effective view — the
  // same threading run.ts got in T2 — so WUDAO_PROVIDER=<registry-id> boots
  // the custom on its own registry config instead of the builtin-only
  // "unknown provider" fail-fast.
  const profiles = loadEffectiveProfiles();
  const resolved = resolveProviderConfigResult(env, {}, undefined, profiles);
  const config: ProviderConfig | null = resolved.ok ? resolved.config : null;
  if (!config) {
    out("No API key found. Set WUDAO_API_KEY (or OPENAI_API_KEY), optionally WUDAO_BASE_URL / WUDAO_MODEL, then rerun.\n");
    return 1;
  }
  // M62 §7 fix (review M2): thread the settings' fallbackModel chain into the
  // workflow run — the workflow path builds its own provider config from env
  // (it never sees main()'s decorateConfig), so without this an unlisted
  // primary is refused at preflight AND the engine's model client cannot fail
  // over. Same decoration index.ts applies to every other frontend.
  const settingsWarn = (m: string): void => { process.stderr.write(`${m}\n`); };
  const layered = await loadLayeredSettings(cwd, settingsWarn, env);
  const fallbackChain = parseFallbackModels(layered.effective, settingsWarn);
  const routeConfig = fallbackChain.length > 0 ? { ...config, fallbackModels: fallbackChain } : config;
  const model = (deps.buildModel ?? createProvider)(routeConfig);

  const runId = parsed.resumeId ?? newRunId(now());
  const path = journalFilePath(cwd, runId);
  out(`workflow ${name} — run ${runId} (${ext === ".js" ? "script engine" : "M22 adapter"})\n`);

  // M56 §5: admission-time route preflight. The budget half runs once here
  // (a refusal exits before the journal run even starts); the per-spawn gate
  // below re-checks the route (provider/key/model) before every task —
  // budget-at-spawn stays the engine's fatal assertCanSpend. Local checks
  // only — no model call, no network probe.
  const budgetTotal = parsed.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const admission = routePreflight({ env, model: config.model, budgetRemaining: budgetTotal, budgetTotal, fallbackModels: fallbackChain, providers: profiles });
  if (!admission.ok) {
    out(`preflight refused (no task admitted):\n${admission.refusals.map((r) => `  - ${r}`).join("\n")}\n`);
    return 1;
  }
  const preflightGate = (): string | undefined => {
    const r = routePreflight({ env, model: config.model, budgetRemaining: budgetTotal, budgetTotal, fallbackModels: fallbackChain, providers: profiles });
    return r.ok ? undefined : r.refusals.join("; ");
  };

  const engineOpts = {
    workspaceRoot: cwd,
    model,
    journal: openJournal(path),
    workflowName: name,
    ...(parsed.file.endsWith(".js") ? { scriptPath: parsed.file } : {}),
    canUseTool: workflowPermissionGate(argv),
    // §7: per-model window (registry contextLength → provider default → env).
    contextWindowTokens: resolveSessionWindowTokens({
      effective: undefined,
      envWindowTokens: Number(env.WUDAO_CONTEXT_WINDOW ?? "200000") || 200000,
      provider: config.provider,
      model: config.model,
    }),
    ...(parsed.budgetTokens !== undefined ? { budgetTokens: parsed.budgetTokens } : {}),
    ...(parsed.args !== undefined ? { args: parsed.args } : {}),
    ...(resumeTasks !== undefined ? { resumeTasks } : {}),
    // M11 #2：命令授予 + cmd 重放清单。
    ...(parsed.allowCmd !== undefined && parsed.allowCmd.length > 0 ? { commandAllowlist: new Set(parsed.allowCmd) } : {}),
    // 133 #3（a reference harness journal 身份模型）：js 路径带运行身份（脚本+参数双
    // 哈希，与她bang 剥离后的执行字节一致）；resumeIdentity 与之全等时
    // 纯度武装生效。适配器路径无脚本字节，不带（行为不变）。
    ...(jsonPlan === undefined ? { identity: workflowIdentity(text.replace(/^#![^\n]*\n/, ""), parsed.args, parsed.allowCmd) } : {}), // T007 P1：授予面随身份（--allow-cmd 变化=世界变化）
    ...(resumeIdentity !== undefined ? { resumeIdentity } : {}),
    ...(resumeCmds !== undefined && resumeCmds.length > 0 ? { resumeCmds } : {}),
    preflight: preflightGate,
    onEvent: (e: JsflowEvent) => printEvent(e, out),
  };

  const result =
    jsonPlan !== undefined
      ? await runPlanWorkflow(jsonPlan, engineOpts)
      : await runScriptWorkflow(text.replace(/^#![^\n]*\n/, ""), engineOpts);

  printSummary(result, name, runId, path, parsed.file, out);
  return result.ok ? 0 : 1;
}
