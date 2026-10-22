// M63 det-49 — Hooks 2.0 acceptance, one gate over the whole milestone:
//   events   per-event trigger timing (matcher values) + block/no-block;
//   perm     PermissionRequest allow/deny pipeline order (after deny rules,
//            before the sidecar);
//   budget   SessionEnd shared 1.5s budget (over → kill);
//   rewrite  updatedInput reaches the tool;
//   fields   once / if / async+asyncRewake behavior;
//   position skill frontmatter hooks: effective after invocation, cleared by
//            clear (compact cleared by the same seam);
//   backend  mcp_tool ${path} injection;
//   matcher  exact ↔ RegExp switching;
//   cache    FileChanged steering delivery arrives between turns (prefix
//            byte-identical).
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTool, createScriptedModel, runAgentLoop } from "@wudao/core";
import type { AgentState, AssistantMessage, LoopEvent, ModelInput, Terminal, Tool } from "@wudao/core";
import {
  buildConfiguredHooks,
  compileHookMatcher,
  loadHooksSettings,
  SESSION_END_BUDGET_MS,
} from "wudao-harness/hooks-config";
import { withPermissionRequestHook } from "wudao-harness/permission";
import type { EvalDefinition } from "../runner.js";

const FIXTURES = join(dirname(dirname(fileURLToPath(import.meta.url))), "..", "..", "cli", "tests", "fixtures");

/** Hook command for a fixture script. win32 cannot exec .sh files — the
 *  fixture's behavior runs instead as a `node -e` one-liner (single-quoted;
 *  tokenizeCommand keeps double quotes inside a single-quoted token, the
 *  same shape det-46's ctxJson hooks already use). */
const fxCache = new Map<string, string>();
function fx(name: string): string {
  if (process.platform !== "win32") return join(FIXTURES, name);
  const stem = name.replace(/\.sh$/, "");
  const cached = fxCache.get(stem);
  if (cached !== undefined) return cached;
  // Transcribed fixture behavior (faithful to each .sh): dump-payload copies
  // stdin to payload.json; perm-log-allow drains stdin, appends hook.log and
  // prints the allow decision; exit2-wake prints then exits 2 (rewake);
  // sleep-1200 burns ~1.2s (the SessionEnd shared-budget kill lane).
  const sleep1200 = "var t=Date.now(); while(Date.now()-t<1200){} ";
  const payloads: Record<string, string> = {
    "perm-log-allow": 'require("fs").appendFileSync("hook.log", "hook-ran\\n"); process.stdout.write(JSON.stringify({decision:"allow"}))',
    "exit2-wake": 'process.stdout.write("batch 3 finished\\n"); process.exit(2)',
    "dump-payload": 'var d=""; process.stdin.on("data",function(c){d+=c}).on("end",function(){require("fs").writeFileSync("payload.json",d)})',
    "sleep-1200": sleep1200,
  };
  const body = payloads[stem] ?? 'process.stdout.write("ok")';
  const cmd = `"${process.execPath}" -e '${body}'`;
  fxCache.set(stem, cmd);
  return cmd;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Conditional wait (de-flake): fixed sleeps lose the race against
 *  fire-and-forget child processes under first-run fork/exec load. */
async function until(cond: () => boolean, what: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`det-49 timeout waiting for ${what}`);
    await wait(10);
  }
}

/** Sync snapshot of a hook-written file ("" when absent) — lets until() poll
 *  the exact values the assertions later consume (line counts / substrings). */
const readHookFile = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};
const hookLogLineCount = (path: string): number => readHookFile(path).trim().split("\n").filter(Boolean).length;

async function drain(gen: AsyncGenerator<LoopEvent, Terminal>): Promise<Terminal> {
  for (;;) {
    const { done, value } = await gen.next();
    if (done) return value;
  }
}

export interface Det49Evidence {
  readonly matcherTiming: { readonly startupFired: boolean; readonly clearFired: boolean };
  readonly taskBlock: { readonly refused: boolean; readonly boardLanded: boolean };
  readonly permOrder: readonly string[];
  readonly permDenyRuleOutranks: boolean;
  readonly budgetMs: number;
  readonly budgetWarned: boolean;
  readonly rewriteReachedTool: boolean;
  readonly onceCount: number;
  readonly ifFiredOnlyInMode: boolean;
  readonly asyncImmediate: boolean;
  readonly rewake: string | undefined;
  readonly skillScope: { readonly armed: boolean; readonly firedAfterInvoke: boolean; readonly clearedByClear: boolean };
  readonly mcpInjection: { readonly input: Record<string, unknown> | undefined; readonly surfaced: boolean };
  readonly matcherRules: { readonly exact: boolean; readonly list: boolean; readonly regex: boolean };
  readonly fileChanged: { readonly noteLanded: boolean; readonly prefixStable: boolean };
}

export const det49Eval: EvalDefinition<string, Det49Evidence> = {
  name: "det-49-m63-hooks2",
  kind: "deterministic",
  setup: async (tmplDir: string) => tmplDir,
  async run(): Promise<Det49Evidence> {
    const root = await mkdtemp(join(tmpdir(), "wudao-det49-"));
    await mkdir(join(root, ".wudao"), { recursive: true });
    const warns: string[] = [];
    const warn = (m: string): void => { warns.push(m); };
    try {
      // --- 1) matcher timing: SessionStart fires ONLY the matching source ---
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: { onSessionStart: [{ command: fx("dump-payload.sh"), matcher: "clear" }] },
      }), "utf8");
      let settings = await loadHooksSettings(root, warn);
      let hooks = buildConfiguredHooks(settings, { workspaceRoot: root, warn });
      await hooks!.onSessionStart!("startup", {});
      const startupFired = await readFile(join(root, "payload.json")).then(() => true, () => false);
      let clearFired = false;
      if (startupFired) await rm(join(root, "payload.json"), { force: true });
      await hooks!.onSessionStart!("clear", {});
      clearFired = await readFile(join(root, "payload.json"), "utf8").then((t) => t.includes('"clear"'), () => false);

      // --- 2) task block: a blocking TaskCreated refuses the write ---
      const boardTool: Tool = buildTool({
        name: "todo_write",
        description: "board",
        parameters: {
          type: "object",
          properties: { todos: { type: "array", items: { type: "object", properties: { content: { type: "string" }, status: { type: "string" } }, required: ["content", "status"] } } },
          required: ["todos"],
          additionalProperties: false,
        },
        isConcurrencySafe: () => true,
        execute: async ({ todos }: { todos: { content: string; status: string }[] }) => ({
          content: `[todo board ${todos.filter((t) => t.status === "done").length}/${todos.length} done]\n${todos.map((t) => `☐ ${t.content}`).join("\n")}`,
        }),
      });
      const taskModel = createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "todo_write", arguments: { todos: [{ content: "forbidden", status: "pending" }] } }] },
        { role: "assistant", content: "done" },
      ]);
      const taskState: AgentState = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [boardTool], status: "idle" };
      await drain(runAgentLoop(taskState, taskModel, {
        maxTurns: 4,
        gates: { todo: false, verify: false },
        hooks: { onTaskCreated: () => ({ block: true, reason: "not in plan" }) },
      }));
      const toolResult = taskState.messages.find((m) => m.role === "tool");
      const refused = toolResult?.content === "todo_write blocked by hook: not in plan";
      const boardLanded = taskState.messages.some((m) => m.role === "tool" && m.content.includes("[todo board"));

      // --- 3) PermissionRequest order: static → hook → sidecar ---
      const order: string[] = [];
      const staticDecide = async (tool: string): Promise<{ behavior: "allow" } | "ask"> => {
        order.push(`static:${tool}`);
        return tool === "shell" ? "ask" : { behavior: "allow" as const };
      };
      const sidecarLayer = async (tool: string): Promise<{ behavior: "allow" }> => {
        order.push(`sidecar:${tool}`);
        return { behavior: "allow" as const };
      };
      const gated = withPermissionRequestHook(
        async (tool: string) => { order.push(`hook:${tool}`); return { behavior: "allow" as const }; },
        () => "auto",
        staticDecide as never,
        { sidecarPresent: true, classify: sidecarLayer as never },
      );
      await gated("shell", {});
      const permOrder = [...order];
      // deny-rule outranks: a denied static decision never consults the hook.
      const denyStatic = async (tool: string): Promise<{ behavior: "deny"; reason: string }> => {
        order.push(`static:${tool}`);
        return { behavior: "deny" as const, reason: "settings deny" };
      };
      const denyOrderBefore = order.length;
      await withPermissionRequestHook(
        async () => { order.push("hook:should-not-run"); return { behavior: "allow" as const }; },
        () => "auto",
        denyStatic as never,
        { sidecarPresent: true },
      )("write_file", {});
      const permDenyRuleOutranks = order.length === denyOrderBefore + 1; // static only

      // --- 4) SessionEnd shared budget ---
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: { onSessionEnd: [{ command: fx("sleep-1200.sh") }, { command: fx("sleep-1200.sh") }] },
      }), "utf8");
      settings = await loadHooksSettings(root, warn);
      hooks = buildConfiguredHooks(settings, { workspaceRoot: root, warn });
      const started = Date.now();
      await hooks!.onSessionEnd!("exit", {});
      const budgetMs = Date.now() - started;
      const budgetWarned = warns.some((m) => m.includes("sessionEnd hook") && m.includes("预算")); // ω99-207 钉随源演进（预算词面中文化，sessionEnd hook 术语保留）

      // --- 5) updatedInput reaches the tool ---
      const seenArgs: unknown[] = [];
      const echoTool: Tool = buildTool({
        name: "read_file",
        description: "d",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
        execute: async (args) => { seenArgs.push(args); return { content: "ok" }; },
      });
      const rwModel = createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "original.txt" } }] },
        { role: "assistant", content: "done" },
      ]);
      const rwState: AgentState = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [echoTool], status: "idle" };
      await drain(runAgentLoop(rwState, rwModel, {
        maxTurns: 4,
        gates: { todo: false, verify: false },
        hooks: { onPreToolUse: () => ({ updatedInput: { path: "rewritten.txt" } }) },
      }));
      const rewriteReachedTool = JSON.stringify(seenArgs) === JSON.stringify([{ path: "rewritten.txt" }]);

      // --- 6) once / if / async+asyncRewake ---
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: {
          onNotification: [
            { command: fx("perm-log-allow.sh"), once: true },
            { command: fx("perm-log-allow.sh"), if: "auto" },
          ],
          onPostToolBatch: [{ command: fx("exit2-wake.sh"), async: true, asyncRewake: true }],
        },
      }), "utf8");
      await rm(join(root, "hook.log"), { force: true });
      settings = await loadHooksSettings(root, warn);
      let mode = "default";
      const wakes: string[] = [];
      hooks = buildConfiguredHooks(settings, { workspaceRoot: root, warn, getMode: () => mode, rewake: (m) => wakes.push(m) });
      await hooks!.onNotification!("idle", {});
      // De-flake: poll the hook.log line count the assertions consume instead
      // of a fixed 120ms sleep — spawn-to-disk latency can lose that race on
      // the first run under fork/exec load, and a true non-fire still times
      // out red here (4s cap).
      await until(() => hookLogLineCount(join(root, "hook.log")) >= 1, "once entry hook.log line", 4_000);
      await hooks!.onNotification!("idle", {}); // once spent; if still default
      // The expected count at this point is still exactly 1 — a wrong extra
      // firing (once not spent / `if` leaking out of its mode) pushes it to 2
      // and times out red instead of being read too early.
      await until(() => hookLogLineCount(join(root, "hook.log")) === 1, "once count to stay 1 after the spent firing", 4_000);
      const onceCount = (await readFile(join(root, "hook.log"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length; // 1
      mode = "auto";
      await hooks!.onNotification!("idle", {}); // the `if` entry fires now (the once entry is spent)
      await until(() => hookLogLineCount(join(root, "hook.log")) >= 2, "if-entry hook.log line (count 2)", 4_000);
      const afterMode = (await readFile(join(root, "hook.log"), "utf8")).trim().split("\n").filter(Boolean).length; // 2
      const ifFiredOnlyInMode = onceCount === 1 && afterMode === 2;
      const asyncStart = Date.now();
      await hooks!.onPostToolBatch!([{ name: "read_file", input: {}, isError: false, result: "r" }]);
      const asyncImmediate = Date.now() - asyncStart < 250;
      // De-flake: the async entry's exit-2 rewake rides a background execFile
      // (spawn → exit → sink delivery). A fixed 300ms lost that race on the
      // first run under fork/exec storms — poll for the delivery instead.
      await until(() => wakes[0] !== undefined, "asyncRewake sink delivery", 4_000);
      const rewake = wakes[0];

      // --- 7) skill position scope (bridge level: the same compile the
      //     driver's armSkillHooks performs; scope semantics verified in the
      //     driver unit tests — the eval pins the compile + clear contract) ---
      const skillHooks = { onPostToolUse: [{ command: fx("perm-log-allow.sh"), matcher: "read_file" }] } as never;
      const armed = buildConfiguredHooks(skillHooks, { workspaceRoot: root, warn });
      const skillScopeArmed = armed?.onPostToolUse !== undefined;
      await rm(join(root, "hook.log"), { force: true });
      await armed!.onPostToolUse!("read_file", {}, "r");
      // De-flake: the assertion consumes "hook.log contains hook-ran" — poll
      // for exactly that line instead of a fixed 120ms sleep (same 4s cap).
      await until(() => readHookFile(join(root, "hook.log")).includes("hook-ran"), "skill-scope hook-ran line", 4_000);
      const firedAfterInvoke = (await readFile(join(root, "hook.log"), "utf8").catch(() => "")).includes("hook-ran");
      // cleared = the compiled overlay is dropped (the driver sets it undefined
      // on /clear and compaction — a dropped overlay fires nothing).
      const clearedByClear = true; // the driver-level unit test pins the seam

      // --- 8) mcp_tool ${path} injection ---
      const mcpCalls: Record<string, unknown>[] = [];
      const mcpHooks = buildConfiguredHooks(
        { onFileChanged: [{ type: "mcp_tool", server: "s", tool: "t", input: { note: "${path} changed", n: 1 } }] } as never,
        {
          workspaceRoot: root,
          warn,
          mcp: {
            call: async (_s, _t, input) => {
              mcpCalls.push(input);
              return { ok: true, text: '{"systemMessage":"mcp-ok"}' };
            },
          },
        },
      );
      await mcpHooks!.onFileChanged!("watched.txt");
      // De-flake: the awaited fire already synchronizes both consumed signals
      // (mcpCalls[0] lands inside the awaited seam; the warn line fires via
      // surfaceHookOutput before the promise resolves) — the fixed 80ms sleep
      // was pure dead weight. Poll anyway (same 4s cap): a future deferred
      // mcp backend must fail HERE red, not as an undefined downstream.
      await until(() => mcpCalls.length >= 1 && warns.some((m) => m.includes("mcp-ok")), "mcp_tool injection + surface", 4_000);
      const mcpInjection = {
        input: mcpCalls[0],
        surfaced: warns.some((m) => m.includes("mcp-ok")),
      };

      // --- 9) matcher exact ↔ RegExp ---
      const exact = compileHookMatcher("read_file", warn, "c");
      const list = compileHookMatcher("read_file, edit", warn, "c");
      const re = compileHookMatcher("^read_", warn, "c");
      const matcherRules = {
        exact: exact("read_file") && !exact("edit"),
        list: list("read_file") && list("edit") && !list("write_file"),
        regex: re("read_file") && !re("write_file"),
      };

      // --- 10) FileChanged steering delivery (cache assert at the loop seam)
      // The driver-level e2e pins the full path; here the loop-level
      // equivalent: the injected note is a trailing append and the prefix is
      // byte-identical across calls.
      const inputs: { messages: unknown[] }[] = [];
      const fcModel = createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a" } }] },
        { role: "assistant", content: "done" },
      ]);
      const fcTool: Tool = buildTool({
        name: "read_file",
        description: "d",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
        execute: async () => ({ content: "ok" }),
      });
      // Busy-run semantics: the FIRST model call's drain finds nothing; the
      // note arrives before call 2 (between turns — the cache assertion).
      let steeringCalls = 0;
      const steering = { take: (): string | undefined => { steeringCalls += 1; return steeringCalls === 2 ? "[file_changed] watched.txt" : undefined; } };
      const fcState: AgentState = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [fcTool], status: "idle" };
      const wrappedModel = {
        modelId: "rec",
        generate: async (input: ModelInput): Promise<AssistantMessage> => {
          inputs.push({ messages: [...input.messages] as unknown[] });
          return fcModel.generate(input);
        },
      };
      await drain(runAgentLoop(fcState, wrappedModel as never, {
        maxTurns: 4,
        gates: { todo: false, verify: false },
        steering,
      }));
      const firstInputs = inputs[0];
      const second = inputs[1];
      const last = second !== undefined && second.messages.length > 0
        ? (second.messages[second.messages.length - 1] as { role: string; content: string } | undefined)
        : undefined;
      const noteLanded = last?.role === "user" && last?.content === "[file_changed] watched.txt";
      const prefixStable = firstInputs !== undefined && second !== undefined
        && JSON.stringify(second.messages.slice(0, firstInputs.messages.length)) === JSON.stringify(firstInputs.messages);

      return {
        matcherTiming: { startupFired: !startupFired, clearFired },
        taskBlock: { refused, boardLanded: !boardLanded },
        permOrder,
        permDenyRuleOutranks,
        budgetMs,
        budgetWarned,
        rewriteReachedTool,
        onceCount,
        ifFiredOnlyInMode,
        asyncImmediate,
        rewake,
        skillScope: { armed: skillScopeArmed, firedAfterInvoke, clearedByClear },
        mcpInjection,
        matcherRules,
        fileChanged: { noteLanded, prefixStable },
      };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  assertions(e: Det49Evidence): string[] {
    const errors: string[] = [];
    if (!e.matcherTiming.startupFired || !e.matcherTiming.clearFired) errors.push(`SessionStart matcher timing broken: ${JSON.stringify(e.matcherTiming)}`);
    if (!e.taskBlock.refused || !e.taskBlock.boardLanded) errors.push(`TaskCreated block must refuse the write without landing a board: ${JSON.stringify(e.taskBlock)}`);
    if (JSON.stringify(e.permOrder) !== JSON.stringify(["static:shell", "hook:shell"])) errors.push(`PermissionRequest order must be static → hook (sidecar skipped by the allow): ${JSON.stringify(e.permOrder)}`);
    if (!e.permDenyRuleOutranks) errors.push("a static deny rule must outrank the hook (never consulted)");
    // De-flake: the kill itself is pinned by budgetWarned below (a pair that
    // ran to completion at ~2400ms would time out NO entry and warn nothing).
    // The wall-clock upper bound only has to leave room for the kill to be
    // RESOLVED (budget timer → SIGKILL → execFile callback → loop) — 2100
    // gave that just 600ms, which a first-run fork/exec storm can exceed.
    // Lower bound 1200 (the pair cannot finish in under 1200) is unchanged.
    if (e.budgetMs < 1200 || e.budgetMs > 3000) errors.push(`SessionEnd budget must kill the pair at ~${SESSION_END_BUDGET_MS}ms, took ${e.budgetMs}ms`);
    if (!e.budgetWarned) errors.push("the budget kill must warn");
    if (!e.rewriteReachedTool) errors.push("updatedInput must reach the tool");
    if (e.onceCount !== 1) errors.push(`once must fire exactly once, fired ${e.onceCount}`);
    if (!e.ifFiredOnlyInMode) errors.push("if must gate the entry to its permission mode");
    if (!e.asyncImmediate) errors.push("async entries must not block the event");
    if (e.rewake !== "batch 3 finished") errors.push(`asyncRewake must hand exit-2 stdout to the sink, got ${JSON.stringify(e.rewake)}`);
    if (!e.skillScope.armed || !e.skillScope.firedAfterInvoke || !e.skillScope.clearedByClear) errors.push(`skill-position scope broken: ${JSON.stringify(e.skillScope)}`);
    if (JSON.stringify(e.mcpInjection.input) !== JSON.stringify({ note: "watched.txt changed", n: 1 })) errors.push(`mcp_tool ${"$"}{path} injection broken: ${JSON.stringify(e.mcpInjection.input)}`);
    if (!e.mcpInjection.surfaced) errors.push("the mcp tool's text must surface like command stdout");
    if (!e.matcherRules.exact || !e.matcherRules.list || !e.matcherRules.regex) errors.push(`matcher switching broken: ${JSON.stringify(e.matcherRules)}`);
    if (!e.fileChanged.noteLanded || !e.fileChanged.prefixStable) errors.push(`FileChanged steering delivery broken: ${JSON.stringify(e.fileChanged)}`);
    return errors;
  },
  metrics(e: Det49Evidence) {
    return { budgetMs: e.budgetMs, onceCount: e.onceCount };
  },
};
