// Live suites: a real model (DeepSeek via WUDAO_API_KEY / .env) driving real
// tools in a throwaway workspace. Assertions are deliberately loose — model
// output is not deterministic, so we assert on keywords, final file state,
// and which tool calls actually happened (transcript assertions), never exact
// text matches.
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  runAgentLoop,
  createReadFileTool,
  createWriteFileTool,
  createEditTool,
  createShellTool,
  createGlobTool,
  createGrepTool,
  type LoopEvent,
  type Terminal,
  type AgentState,
  type Tool,
  buildTool,
} from "@wudao-org/core";
import { resolveProviderConfigResult, createOpenAICompatibleProvider, NO_KEY_REASON } from "@wudao-org/providers";
import { buildSystemPrompt } from "wudao-harness/prompt";
import type { EvalDefinition } from "../runner.js";
import { drain } from "./deterministic.js";

const LIVE_TIMEOUT_MS = 240_000;
const LIVE_MAX_TURNS = 16;

/** Shared live context: workspace + model + tools. Eval CLI loads .env into
 *  process.env before suites run; skip() consults the same env. */
interface LiveCtx {
  readonly workspaceRoot: string;
}

interface LiveEvidence {
  readonly terminal: Terminal | undefined;
  readonly events: readonly LoopEvent[];
  readonly answer: string;
  /** Extra suite-specific evidence (file contents, verification runs). */
  readonly extra: Record<string, string | undefined>;
}

function toolNamesInOrder(events: readonly LoopEvent[]): string[] {
  return events
    .filter((e): e is Extract<LoopEvent, { type: "tool_call_started" }> => e.type === "tool_call_started")
    .map((e) => e.toolName);
}

/** Result contents for one tool name (finished events carry only toolCallId,
 *  so names are resolved through the started events). */
function toolResults(events: readonly LoopEvent[], name: string): string[] {
  const idToName = new Map<string, string>();
  for (const e of events) {
    if (e.type === "tool_call_started") idToName.set(e.toolCallId, e.toolName);
  }
  return events
    .filter((e): e is Extract<LoopEvent, { type: "tool_call_finished" }> => e.type === "tool_call_finished")
    .filter((e) => idToName.get(e.toolCallId) === name)
    .map((e) => e.result);
}

interface RunLiveOptions {
  readonly systemPrompt?: string;
  /** ω-long-2: arm the arc-C continuation (budget-window resets). */
  readonly continuation?: { sessionId: string; maxSlices: number };
  /** Turn fuse for this run (default LIVE_MAX_TURNS). The slicing eval lowers
   *  it deliberately: slicing only happens at a boundary. */
  readonly maxTurns?: number;
  /** Overrides the default six-tool set (the slicing eval needs a tool whose
   *  result VARIES per call — a constant result is indistinguishable from
   *  stasis by the progress brake, by design). */
  readonly toolsOverride?: readonly Tool[];
}

async function runLive(
  ctx: LiveCtx,
  prompt: string,
  extra: Record<string, () => Promise<string | undefined>> = {},
  options: RunLiveOptions = {},
): Promise<LiveEvidence> {
  const resolved = resolveProviderConfigResult(process.env);
  if (!resolved.ok) throw new Error(`live run without provider config: ${resolved.reason}`);
  const model = createOpenAICompatibleProvider(resolved.config);
  const tools: Tool[] = [...(options.toolsOverride ?? [
    createReadFileTool({ workspaceRoot: ctx.workspaceRoot }),
    createWriteFileTool({ workspaceRoot: ctx.workspaceRoot }),
    createEditTool({ workspaceRoot: ctx.workspaceRoot }),
    createShellTool({ workspaceRoot: ctx.workspaceRoot }),
    createGlobTool({ workspaceRoot: ctx.workspaceRoot }),
    createGrepTool({ workspaceRoot: ctx.workspaceRoot }),
  ])];
  const state: AgentState = {
    systemPrompt: options.systemPrompt ?? "You are a coding agent working in the current workspace. Use the tools to accomplish the task, then answer concisely.",
    messages: [{ role: "user", content: prompt }],
    tools,
    status: "running",
  };
  const { events, terminal } = await drain(runAgentLoop(state, model, {
    maxTurns: options.maxTurns ?? LIVE_MAX_TURNS,
    // Headless eval: the workspace is a throwaway tmp dir, so auto-allow.
    canUseTool: () => ({ behavior: "allow" as const }),
    signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
    ...(options.continuation !== undefined ? { continuation: options.continuation } : {}),
  }));
  // Deferred extras: the thunks only run AFTER the loop, so they observe the
  // final on-disk state (not a race with the model's writes).
  const extraResolved: Record<string, string | undefined> = {};
  for (const [k, thunk] of Object.entries(extra)) extraResolved[k] = await thunk();
  return {
    terminal,
    events,
    answer: terminal?.finalMessage?.content ?? state.messages.filter((m) => m.role === "assistant").at(-1)?.content ?? "",
    extra: extraResolved,
  };
}

async function readFileOrNull(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// live-01: read README, one-sentence summary
// ---------------------------------------------------------------------------

const readSummaryEval: EvalDefinition<LiveCtx, LiveEvidence> = {
  name: "live-01-read-summary",
  kind: "live",
  skip: () => {
    const r = resolveProviderConfigResult(process.env);
    return r.ok ? undefined : (r.reason || NO_KEY_REASON);
  },
  async setup(dir) {
    await writeFile(
      join(dir, "README.md"),
      "# fixture\n\nThis tiny fixture project is codenamed MAGENTA-HYDRA-77.\nIt contains nothing but this README.\n",
      "utf8",
    );
    return { workspaceRoot: dir };
  },
  run(ctx) {
    return runLive(ctx, "Read README.md in the workspace and reply with a one-sentence summary of it.");
  },
  assertions(evidence) {
    const errors: string[] = [];
    if (evidence.terminal?.reason !== "completed") {
      errors.push(`expected terminal "completed", got "${evidence.terminal?.reason ?? "none"}"`);
    }
    const reads = toolResults(evidence.events, "read_file");
    if (reads.length === 0) errors.push("model never called read_file");
    else if (reads.every((r) => !r.includes("MAGENTA-HYDRA-77"))) errors.push("read_file result did not carry the README content");
    if (!/magenta[- ]?hydra/i.test(evidence.answer)) {
      errors.push(`answer does not mention the codename MAGENTA-HYDRA (got: ${evidence.answer.slice(0, 160)})`);
    }
    return errors;
  },
};

// ---------------------------------------------------------------------------
// live-02: write calc.js, run it, report the number
// ---------------------------------------------------------------------------

const writeCalcEval: EvalDefinition<LiveCtx & { calcPath: string }, LiveEvidence> = {
  name: "live-02-write-and-run",
  kind: "live",
  skip: () => {
    const r = resolveProviderConfigResult(process.env);
    return r.ok ? undefined : (r.reason || NO_KEY_REASON);
  },
  async setup(dir) {
    return { workspaceRoot: dir, calcPath: join(dir, "calc.js") };
  },
  async run(ctx) {
    return runLive(
      ctx,
      "Create a file calc.js that prints the result of 6*7, run it with `node calc.js`, and tell me the number it printed.",
      {
        // Independent verification: WE run the final file with the harness's
        // own shell tool after the loop finishes.
        verifyOutput: async () => {
          const tool = createShellTool({ workspaceRoot: ctx.workspaceRoot });
          const result = await tool.execute({ command: "node calc.js" });
          return result.content;
        },
        finalFile: () => readFileOrNull(ctx.calcPath),
      },
    );
  },
  assertions(evidence) {
    const errors: string[] = [];
    if (evidence.terminal?.reason !== "completed") {
      errors.push(`expected terminal "completed", got "${evidence.terminal?.reason ?? "none"}"`);
    }
    if (toolResults(evidence.events, "write_file").length === 0) errors.push("model never called write_file");
    const runs = toolResults(evidence.events, "shell");
    if (!runs.some((r) => r.toLowerCase().includes("node"))) errors.push("model never ran calc.js with node");
    const finalFile = evidence.extra.finalFile;
    if (finalFile === undefined) errors.push("calc.js does not exist after the run");
    const verify = evidence.extra.verifyOutput ?? "";
    if (!verify.includes("42")) errors.push(`independent \`node calc.js\` run did not print 42 (got: ${verify.slice(0, 160)})`);
    if (!evidence.answer.includes("42")) errors.push(`answer does not contain the real result 42 (got: ${evidence.answer.slice(0, 160)})`);
    return errors;
  },
};

// ---------------------------------------------------------------------------
// live-03: two-turn tool chain glob -> grep -> read_file
// ---------------------------------------------------------------------------

const toolChainEval: EvalDefinition<LiveCtx, LiveEvidence> = {
  name: "live-03-tool-chain",
  kind: "live",
  skip: () => {
    const r = resolveProviderConfigResult(process.env);
    return r.ok ? undefined : (r.reason || NO_KEY_REASON);
  },
  async setup(dir) {
    const docs = join(dir, "docs");
    await mkdir(docs, { recursive: true });
    await writeFile(join(docs, "alpha.md"), "# alpha\nJust ordinary release notes.\n", "utf8");
    await writeFile(join(docs, "beta.md"), "# beta\nThe access codeword is COBALT-OTTER-19.\n", "utf8");
    await writeFile(join(dir, "scratch.txt"), "nothing interesting here\n", "utf8");
    return { workspaceRoot: dir };
  },
  run(ctx) {
    return runLive(
      ctx,
      "Find the markdown files in this workspace with glob, locate the one containing the word COBALT with grep, read that file with read_file, and tell me the full codeword it contains.",
    );
  },
  assertions(evidence) {
    const errors: string[] = [];
    if (evidence.terminal?.reason !== "completed") {
      errors.push(`expected terminal "completed", got "${evidence.terminal?.reason ?? "none"}"`);
    }
    const order = toolNamesInOrder(evidence.events);
    const first = (name: string): number => order.indexOf(name);
    if (first("glob") === -1) errors.push("model never called glob");
    if (first("grep") === -1) errors.push("model never called grep");
    if (first("read_file") === -1) errors.push("model never called read_file");
    if (first("glob") !== -1 && first("grep") !== -1 && !(first("glob") < first("grep"))) {
      errors.push(`expected glob before grep, call order was: ${order.join(", ")}`);
    }
    if (first("grep") !== -1 && first("read_file") !== -1 && !(first("grep") < first("read_file"))) {
      errors.push(`expected grep before read_file, call order was: ${order.join(", ")}`);
    }
    const reads = toolResults(evidence.events, "read_file");
    if (!reads.some((r) => r.includes("COBALT-OTTER-19"))) {
      errors.push("read_file result did not carry the codeword file content");
    }
    if (!/cobalt[- ]?otter/i.test(evidence.answer)) {
      errors.push(`answer does not contain the codeword COBALT-OTTER (got: ${evidence.answer.slice(0, 160)})`);
    }
    return errors;
  },
};

// ---------------------------------------------------------------------------
// det-12: live cache hit-rate gate (M24) — a real 3+ turn tool chain must ride
// the provider's prefix cache: from the 3rd model call on, ≥80% of prompt
// tokens must be cache hits. The first two calls legitimately miss (cold
// start + first write-back); the threshold is deliberately conservative to
// start with and tightens later.
// ---------------------------------------------------------------------------

interface CacheGateEvidence {
  readonly terminal: Terminal | undefined;
  readonly usageEvents: readonly { turn: number; promptTokens: number; cacheHitTokens: number; cacheMissTokens: number }[];
  readonly answer: string;
}

const cacheHitGateEval: EvalDefinition<LiveCtx, CacheGateEvidence> = {
  name: "det-12-cache-hit-gate",
  kind: "live",
  skip: () => {
    const r = resolveProviderConfigResult(process.env);
    return r.ok ? undefined : (r.reason || NO_KEY_REASON);
  },
  async setup(dir) {
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(join(dir, "README.md"), "# fixture\\n\\nA small workspace for the cache gate. Codename INDIGO-LYNX-55.\\n", "utf8");
    await writeFile(join(dir, "docs", "alpha.md"), "# alpha\\n\\nPlain notes about release cadence.\\n", "utf8");
    await writeFile(join(dir, "docs", "beta.md"), "# beta\\n\\nThe access codeword is INDIGO-LYNX-55.\\n", "utf8");
    await writeFile(join(dir, "scratch.txt"), "scratch content\\n", "utf8");
    return { workspaceRoot: dir };
  },
  run(ctx) {
    return (async (): Promise<CacheGateEvidence> => {
      const e = await runLive(
        ctx,
        "Use glob to list the markdown files in this workspace, then grep them for the word INDIGO, then read README.md and the matching docs file with read_file, and finally report the codeword and which file it lives in.",
      );
      return {
        terminal: e.terminal,
        answer: e.answer,
        usageEvents: e.events
          .filter((ev): ev is Extract<LoopEvent, { type: "usage" }> => ev.type === "usage")
          .map((ev) => ({ turn: ev.turn, ...ev.usage })),
      };
    })();
  },
  assertions(evidence) {
    const errors: string[] = [];
    if (evidence.terminal?.reason !== "completed") {
      errors.push(`expected terminal "completed", got "${evidence.terminal?.reason ?? "none"}"`);
    }
    // The chain actually chained (multi-turn tool use, not a one-shot answer).
    if (evidence.usageEvents.length < 3) {
      errors.push(`expected at least 3 usage-reporting model calls, got ${evidence.usageEvents.length}`);
    }
    // From the 3rd call on: weighted hit rate ≥ 80%.
    const qualifying = evidence.usageEvents.slice(2);
    if (qualifying.length > 0) {
      const prompt = qualifying.reduce((n, u) => n + u.promptTokens, 0);
      const hit = qualifying.reduce((n, u) => n + u.cacheHitTokens, 0);
      const rate = prompt > 0 ? hit / prompt : 0;
      if (rate < 0.8) {
        errors.push(`cache hit rate from call 3 on is ${(rate * 100).toFixed(1)}% (hit ${hit} / prompt ${prompt}), below the 80% gate`);
      }
    }
    if (!/indigo[- ]?lynx/i.test(evidence.answer)) {
      errors.push(`answer does not carry the codeword INDIGO-LYNX (got: ${evidence.answer.slice(0, 160)})`);
    }
    return errors;
  },
  metrics(evidence) {
    const prompt = evidence.usageEvents.reduce((n, u) => n + u.promptTokens, 0);
    const hit = evidence.usageEvents.reduce((n, u) => n + u.cacheHitTokens, 0);
    return {
      hitRatePct: prompt > 0 ? Math.round((hit / prompt) * 1000) / 10 : 0,
      modelCalls: evidence.usageEvents.length,
    };
  },
};

// ---------------------------------------------------------------------------
// live-04 (M54): project-context files — a WUDAO.md describing the scratch
// workspace's conventions must reach the model through the system prompt (the
// real buildSystemPrompt path) so the agent answers convention questions
// from it directly.
// ---------------------------------------------------------------------------
const projectContextEval: EvalDefinition<LiveCtx, LiveEvidence & { systemPrompt: string }> = {
  name: "live-04-project-context",
  kind: "live",
  skip: () => {
    const r = resolveProviderConfigResult(process.env);
    return r.ok ? undefined : (r.reason || NO_KEY_REASON);
  },
  async setup(dir) {
    await writeFile(
      join(dir, "WUDAO.md"),
      [
        "# Conventions for this repository",
        "",
        "- Package manager: pnpm only — never call npm or yarn directly.",
        "- Tests always run via `pnpm test`, never a bare vitest invocation.",
        "- Every release of this project is tagged with the codename VELVET-OKAPI-88.",
        "",
      ].join("\n"),
      "utf8",
    );
    return { workspaceRoot: dir };
  },
  async run(ctx) {
    // The REAL production prompt (project context included, memoized — same
    // bytes the loop will send).
    const systemPrompt = buildSystemPrompt(ctx.workspaceRoot);
    const evidence = await runLive(
      ctx,
      "Without reading any files: what package manager and test command is this project supposed to use, and what is its release codename?",
      {},
      { systemPrompt },
    );
    return { ...evidence, systemPrompt };
  },
  assertions(evidence) {
    const errors: string[] = [];
    if (evidence.terminal?.reason !== "completed") {
      errors.push(`expected terminal "completed", got "${evidence.terminal?.reason ?? "none"}"`);
    }
    if (!evidence.systemPrompt.includes("# Project context") || !evidence.systemPrompt.includes("VELVET-OKAPI-88")) {
      errors.push("the live system prompt must carry the WUDAO.md body in # Project context");
    }
    if (!/velvet[- ]?okapi/i.test(evidence.answer)) {
      errors.push(`answer does not carry the WUDAO.md codename VELVET-OKAPI (got: ${evidence.answer.slice(0, 160)})`);
    }
    return errors;
  },
};


// ---------------------------------------------------------------------------
// live-05 (ω-long-2): 长程续跑在真模型下真的管用吗？
//
// 这条用例存在的唯一目的，是回答「deterministic 测试绿了，但是不是真管用」。
// scripted model 不会累、不会跑偏、不会在第 N 轮开始敷衍，而长程任务真实的
// 失败模式全都在那里。所以这里用真模型跑一个**必须撞上限才能完成**的任务：
//
//   - maxTurns = 3（远小于任务所需轮数），装备 continuation；
//   - 任务是「往计数器文件里追加到 9 条」；每次只能看一眼、写一条；
//   - 如果续跑失效，run 会在第 3 轮以 max_turns 死掉，文件不满 9 条；
//   - 成功 = 文件真的到了 9 条 + 至少注入过一次续跑消息 + 终态不是
//     max_turns（模型自己收工）。
//
// 关键设计：工具是「读-写-读」形状，每轮结果都不同（进度刹车要的正是这个），
// 同时任务本身有明确的完成判据，模型能自己判断何时该 end_turn。
const LONG_TASK_TARGET = 9;

/** Build the long-task eval with slicing ON or OFF. The OFF variant is the
 *  control: same task, same fuse, no continuation — it MUST die at the fuse.
 *  Without that control a green ON result would only prove the task is
 *  doable, not that slicing is what made it doable. */
function longRunEval(slicing: boolean): EvalDefinition<LiveCtx, LiveEvidence & { finalCount: number; continuations: number }> {
  return {
  name: slicing ? "live-05-long-run-slicing" : "live-06-long-run-control",
  kind: "live",
  skip: () => {
    const r = resolveProviderConfigResult(process.env);
    return r.ok ? undefined : (r.reason || NO_KEY_REASON);
  },
  async setup(dir) {
    await writeFile(join(dir, "counter.txt"), "0\n", "utf8");
    return { workspaceRoot: dir };
  },
  async run(ctx) {
    const counterPath = join(ctx.workspaceRoot, "counter.txt");
    // ONE tool doing read-then-write: every call changes the file, so each
    // turn's result differs (a constant result would be indistinguishable
    // from stasis and the progress brake would — correctly — stop the run).
    const step = buildTool({
      name: "bump_counter",
      description:
        "Read counter.txt, then write back its current integer + 1. Returns the NEW value. " +
        "Call it repeatedly; when the reported value reaches the target, stop and say you are done.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      // This tool is DESIGNED to be called over and over with identical
      // arguments — that is exactly the polling/increment cadence the
      // loopExempt annotation exists for. Without it the identical_calls
      // detector (name+args fingerprint, W=6 window) reads six identical
      // calls as a stall and aborts a run that is making real progress.
      // Found the hard way on the first live run of this eval.
      loopExempt: () => true,
      async execute() {
        const raw = await readFile(counterPath, "utf8").catch(() => "0");
        const next = (Number.parseInt(raw.trim(), 10) || 0) + 1;
        await writeFile(counterPath, `${next}\n`, "utf8");
        return { content: `counter is now ${next}` };
      },
    }) as Tool;
    const evidence = await runLive(
      ctx,
      `Call bump_counter repeatedly until counter.txt reaches ${LONG_TASK_TARGET}, then report the final value. ` +
        "You must call the tool at least once per step — do not guess the value.",
      {},
      {
        toolsOverride: [step],
        // The whole point: a fuse far short of what the task needs. Without
        // slicing this run is dead at turn 3.
        maxTurns: 3,
        ...(slicing ? { continuation: { sessionId: "live-long-run", maxSlices: Number.POSITIVE_INFINITY } } : {}),
      },
    );
    const raw = await readFile(counterPath, "utf8").catch(() => "0");
    return {
      ...evidence,
      finalCount: Number.parseInt(raw.trim(), 10) || 0,
      continuations: evidence.events.filter((e) => e.type === "continuation_injected").length,
    };
  },
  assertions(evidence) {
    const errors: string[] = [];
    if (!slicing) {
      // The CONTROL asserts the MECHANISM, not the model's mood.
      //
      // An earlier version demanded terminal === "max_turns" and went red
      // because the model answered on its own at turn 3 without ever
      // reaching the fuse — that assertion was measuring model variance,
      // not slicing. What the control actually has to prove is narrower and
      // model-independent: with continuation absent, the run injects ZERO
      // continuation messages. Combined with the sliced twin's 4, that is
      // the contrast the eval exists to establish.
      //
      // The task outcome (finalCount) is recorded as a metric rather than
      // asserted: a model that quits early makes the control weaker
      // evidence, but it must never make it RED.
      if (evidence.continuations !== 0) {
        errors.push(`control run injected ${evidence.continuations} continuations — slicing was armed when it should not be`);
      }
      if (evidence.terminal?.reason === "max_turns" && evidence.finalCount >= LONG_TASK_TARGET) {
        // Reached the fuse AND finished: then the fuse is not a bound at all
        // and the sliced twin proves nothing.
        errors.push("control hit max_turns yet still finished the task — the fuse never actually bounded this run, so the sliced twin is not evidence");
      }
      return errors;
    }
    // 1) 撞了上限还活着：max_turns 是「续跑彻底失效」的直接证据。
    if (evidence.terminal?.reason === "max_turns") {
      errors.push("run ended on max_turns — the continuation never took over");
    }
    // 2) 确实发生了切片（3 轮上限跑不完 9 次自增）。
    if (evidence.continuations < 1) {
      errors.push(`no continuation_injected event (got ${evidence.continuations}) — slicing never armed`);
    }
    // 3) 真把活干完了，而不是「活着但没进展」。
    if (evidence.finalCount < LONG_TASK_TARGET) {
      errors.push(`counter reached ${evidence.finalCount}, target ${LONG_TASK_TARGET} — the run stayed alive but did not finish the task`);
    }
    return errors;
  },
  metrics(evidence) {
    return { continuations: evidence.continuations, finalCount: evidence.finalCount };
  },
  };
}

const longRunSlicingEval = longRunEval(true);
const longRunControlEval = { ...longRunEval(false), name: "live-06-long-run-control" };

export const liveSuites: readonly EvalDefinition<unknown, unknown>[] = [
  readSummaryEval,
  writeCalcEval,
  toolChainEval,
  cacheHitGateEval,
  projectContextEval,
  longRunSlicingEval,
  longRunControlEval,
];
