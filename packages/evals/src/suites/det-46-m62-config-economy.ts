// M62 det-46 — the config/context-economy package end to end through the REAL
// loaders, loop, and provider engine (scripted models, zero network):
//   §1 rules        no-paths rules in the project-context stable section
//                   (byte-stable) + two-tier shadowing + the 8k body cap;
//                   paths rules lazy-injected into MESSAGE HISTORY on the
//                   first matching read_file only (presence dedupe), prefix
//                   byte-stable across the injection, RELOADED after a real
//                   tier2Compact; subdirectory WUDAO.md = implicit gated rule.
//   §2 lifecycle    startup sweep soft-deletes expired runtime data (utimes
//                   fixtures), never-list survives byte-identical, aged trash
//                   hard-deletes; purge plan = zero writes, executePurge =
//                   soft-delete with byte recovery, the soft-delete window
//                   expires to a hard delete; the current-session skip.
//   §3 local tier   global < project < local scalar precedence, array
//                   concat-dedup in tier order, LOCAL escalation keys refused
//                   by the same trust gate (projectEscalations), first-write
//                   auto-gitignore, WUDAO.local.md loads LAST.
//   §4 outputStyle  append-mode section + coding instructions kept, replace
//                   flag swaps them, same-name project wins, session selection
//                   byte-frozen (mid-session setter refused, restart applies).
//   §5 additionalContext — hook stdout JSON injected at the NEXT model call
//                   (projection-only suffix, prefix stable), 8k cap on a line
//                   boundary, plain stdout ≠ context, exit≠0 never injects.
//   §6 defer        auto threshold flip (schema bytes/4 vs 10% of the window)
//                   through the real buildToolSet, explicit on/off override,
//                   env kill switch wins; MCP alwaysLoad pins eager loading.
//   §7 misc keys    autoCompactWindow clamp matrix, memory/mcp switches,
//                   claudeMdExcludes skip + dead-pattern lint (through the real
//                   project-context loader), fallbackModel ordered chain with
//                   receipt annotation + key-class no-fallback + sticky skip.
import { mkdir, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildTool,
  createReadFileTool,
  runAgentLoop,
  tier2Compact,
  SUMMARY_MARKER,
  type AgentState,
  type AssistantMessage,
  type LoopEvent,
  type ModelClient,
  type ModelInput,
  type Terminal,
  type Tool,
} from "@wudao-org/core";
import { createOpenAICompatibleProvider, serializePrompt } from "@wudao-org/providers";
import {
  loadContextRules,
  createContextRuleMatcher,
  MAX_RULE_BODY_CHARS,
  ruleNotePrefix,
  resetContextRulesForTests,
} from "wudao-harness/rules";
import {
  loadOutputStyles,
  findOutputStyle,
  setSessionOutputStyle,
  resetOutputStyleForTests,
} from "wudao-harness/output-styles";
import {
  loadProjectContext,
  setProjectContextExcludes,
  resetProjectContextCacheForTests,
} from "wudao-harness/project-context";
import { buildSystemPrompt } from "wudao-harness/prompt";
import { loadLayeredSettings, saveLocalSettings } from "wudao-harness/settings-layer";
import {
  buildConfiguredHooks,
  parseAdditionalContext,
  capAdditionalContext,
  MAX_ADDITIONAL_CONTEXT_CHARS,
} from "wudao-harness/hooks-config";
import { loadMcpConfig, normalizeServer } from "wudao-harness/mcp/config";
import { parseMcpTimeouts } from "wudao-harness/mcp/tools";
import {
  parseClaudeMdExcludes,
  resolveAutoCompactSettings,
  resolveMemorySettings,
  resolveMcpEnabled,
  parseFallbackModels,
  readDeferModeSetting,
} from "wudao-harness/misc-config";
import {
  runLifecycleSweep,
  buildPurgePlan,
  executePurge,
  formatPurgePlan,
  formatSweepNotice,
  resolveLifecycleSettings,
  DEFAULT_CLEANUP_PERIOD_DAYS,
  DEFAULT_SOFT_DELETE_PERIOD_DAYS,
} from "wudao-harness/lifecycle";
import {
  buildToolSet,
  resolveDeferMode,
  setSessionDeferMode,
  deferCandidatesFitWindow,
  DEFER_CANDIDATE_TOOL_NAMES,
} from "wudao-harness/tools";
import type { EvalDefinition } from "../runner.js";

const DAY = 86_400_000;

interface Det46Evidence {
  readonly rules: {
    readonly stableOrder: readonly string[];
    readonly shadowedBody: string;
    readonly shadowWarning: string | undefined;
    readonly cappedBodyTail: string;
    readonly cappedBodyLen: number;
    readonly stableInPrompt: boolean;
    readonly promptByteStable: boolean;
    readonly injectedOnce: number;
    readonly noteInHistory: boolean;
    readonly noteAfterToolResult: boolean;
    readonly prefixStable: boolean;
    readonly nonMatchZero: boolean;
    readonly matcherZeroCost: boolean;
    readonly compactRemovedNote: boolean;
    readonly reloadedAfterCompact: number;
    readonly subdirImplicit: boolean;
    readonly subdirInjected: boolean;
  };
  readonly lifecycle: {
    readonly scalars: { readonly cleanup: number; readonly soft: number; readonly junkDefault: boolean; readonly layered: number };
    readonly softDeletedCount: number;
    readonly agedTrashSurvivesSweep1: boolean;
    readonly agedTrashHardDeletedAfterWindow: number;
    readonly neverListSurvived: readonly string[];
    readonly currentSurvives: boolean;
    readonly planZeroWrites: boolean;
    readonly planText: string;
    readonly purgeSoftDeleted: number;
    readonly purgeRecoveredBytes: boolean;
    readonly windowThenHardDelete: boolean;
    readonly skipProtectsCurrent: boolean;
    readonly noticeLine: string;
    readonly emptyNotice: string;
    readonly cliPurge: {
      readonly dryRunZeroWrites: boolean;
      readonly dryRunNotice: boolean;
      readonly yesSoftDeletes: boolean;
      readonly newSessionClean: boolean;
    };
  };
  readonly local: {
    readonly scalarLocalWins: boolean;
    readonly arrayConcat: readonly string[];
    readonly escalationRefused: readonly string[];
    readonly localEscalationWarning: string | undefined;
    readonly keySource: string | undefined;
    readonly gitignoreAdded: boolean;
    readonly gitignoreWarned: boolean;
    readonly secondWriteNoTouch: boolean;
    readonly localContextLast: boolean;
  };
  readonly styles: {
    readonly projectWinsBody: string;
    readonly shadowWarning: string | undefined;
    readonly replaceFlag: boolean;
    readonly appendedKeepsCoding: boolean;
    readonly afterProjectContext: boolean;
    readonly byteFrozen: boolean;
    readonly midSessionRefused: boolean;
    readonly restartApplies: boolean;
    readonly replaceDropsCoding: boolean;
    readonly noneSelectedClean: boolean;
  };
  readonly hookCtx: {
    readonly parseJson: string | undefined;
    readonly parsePlain: boolean;
    readonly parseOtherJson: boolean;
    readonly parseEmptyString: boolean;
    readonly cappedLen: number;
    readonly cappedTail: string;
    readonly injectedAtNextCall: boolean;
    readonly notInFirstCall: boolean;
    readonly projectionOnly: boolean;
    readonly prefixStable: boolean;
    readonly chainedHooks: boolean;
    readonly plainStdoutNotContext: boolean;
    readonly exitOneNotInjected: boolean;
  };
  readonly defer: {
    readonly modeMatrix: readonly { readonly mode: string; readonly envOff: boolean; readonly out: string }[];
    readonly settingMatrix: readonly { readonly mode: string; readonly out: string }[];
    readonly thresholdFlips: boolean;
    readonly autoEagerNames: readonly string[];
    readonly autoDeferredNames: readonly string[];
    readonly wiredDefaultEager: readonly string[];
    readonly wiredDefaultDeferred: readonly string[];
    readonly explicitOnDefers: boolean;
    readonly explicitOffEager: boolean;
    readonly envOffBeatsOn: boolean;
    readonly alwaysLoadLiteral: readonly string[];
    readonly mcpEagerWhileTaskDeferred: readonly string[];
  };
  readonly misc: {
    readonly compactClampLow: number;
    readonly compactClampHigh: number;
    readonly compactJunkKeepsEnv: number;
    readonly compactDisabled: boolean;
    readonly compactLayered: number;
    readonly memoryOff: boolean;
    readonly memoryDir: string;
    readonly memoryJsonlDirect: string;
    readonly mcpOff: boolean;
    readonly mcpJunkDefault: boolean;
    readonly fallbackParse: readonly string[];
    readonly fallbackJunkEmpty: boolean;
    readonly fallbackLayered: readonly string[];
    readonly excludesSkipped: boolean;
    readonly excludesKept: boolean;
    readonly deadPatternWarned: boolean;
    readonly excludedPatternFalseDead: boolean;
    readonly mcpTimeouts: { readonly connectMs?: number; readonly requestMs?: number; readonly shutdownMs?: number };
    readonly mcpTimeoutsJunk: boolean;
  };
  readonly fallback: {
    readonly orderedModels: readonly string[];
    readonly succeededOn: string;
    readonly receipt: { readonly model?: string; readonly from?: string } | undefined;
    readonly keyClassNoFallback: boolean;
    readonly stickySkipsPrimary: boolean;
  };
}

/** Scripted model that snapshots every input (prefix asserts need frozen bytes). */
function snapshotModel(responses: readonly AssistantMessage[]): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push({ ...input, messages: input.messages.map((m) => ({ ...m })) });
      const r = responses[i];
      i += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

function toolTurn(id: string, name: string, args: Record<string, unknown>): AssistantMessage {
  return { role: "assistant", content: "", toolCalls: [{ id, name, arguments: args }] };
}

async function drain(gen: AsyncGenerator<LoopEvent, Terminal>): Promise<{ events: LoopEvent[]; terminal: Terminal }> {
  const events: LoopEvent[] = [];
  for (;;) {
    const { done, value } = await gen.next();
    if (done) return { events, terminal: value };
    events.push(value);
  }
}

async function writeFileDeep(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

/** Simple deterministic workspace with a .wudao dir. */
async function makeWs(root: string, name: string): Promise<string> {
  const ws = join(root, name);
  await mkdir(join(ws, ".wudao"), { recursive: true });
  return ws;
}

export const det46Eval: EvalDefinition<string, Det46Evidence> = {
  name: "det-46-m62-config-economy",
  kind: "deterministic",
  setup: async (tmplDir) => {
    await mkdir(tmplDir, { recursive: true });
    return tmplDir;
  },
  run: async (root) => {
    // Pin BOTH global-tier roots for the whole run: WUDAO_GLOBAL_HOME feeds
    // the rules/output-styles/mcp/settings loaders, HOME feeds project-
    // context's user-global WUDAO.md probe (os.homedir()).
    const globalHome = join(root, "global-home");
    const emptyHome = join(root, "empty-home");
    await mkdir(join(globalHome, "rules"), { recursive: true });
    await mkdir(join(globalHome, "output-styles"), { recursive: true });
    await mkdir(emptyHome, { recursive: true });
    const prevGlobalHome = process.env.WUDAO_GLOBAL_HOME;
    const prevHome = process.env.HOME;
    const prevDeferEnv = process.env.WUDAO_DEFER_TOOLS;
    process.env.WUDAO_GLOBAL_HOME = globalHome;
    process.env.HOME = emptyHome;
    // Session-static modules may carry state from earlier suites in this
    // process — start every lane from the documented fresh-session state.
    resetContextRulesForTests();
    resetProjectContextCacheForTests();
    resetOutputStyleForTests();
    setSessionDeferMode(undefined);
    try {
      // ================================================================== §1
      // rules/ — two tiers + a gated rule + an implicit subdir rule.
      await writeFile(join(globalHome, "rules", "a-global.md"), "RULE-A-GLOBAL body\n", "utf8");
      await writeFile(join(globalHome, "rules", "b-global.md"), "RULE-B-GLOBAL body\n", "utf8");
      await writeFile(join(globalHome, "rules", "x-shadow.md"), "RULE-X from global (must lose)\n", "utf8");
      const ws1 = await makeWs(root, "ws1");
      await mkdir(join(ws1, ".wudao", "rules"), { recursive: true });
      await writeFile(join(ws1, "WUDAO.md"), "ROOT-WUDAO: stable file tier\n", "utf8");
      await writeFile(join(ws1, ".wudao", "rules", "c-proj.md"), "RULE-C-PROJ body\n", "utf8");
      await writeFile(join(ws1, ".wudao", "rules", "x-shadow.md"), "RULE-X from project (must win)\n", "utf8");
      await writeFile(join(ws1, ".wudao", "rules", "big.md"), `BIG ${"x".repeat(20_000)}`, "utf8");
      await writeFile(
        join(ws1, ".wudao", "rules", "py-gated.md"),
        "---\npaths: [\"**/*.py\"]\n---\nPY-RULE: run ruff before answering\n",
        "utf8",
      );
      await writeFile(join(ws1, "code.py"), "print('hi')\n", "utf8");
      await writeFile(join(ws1, "note.txt"), "plain note\n", "utf8");
      await mkdir(join(ws1, "pkg"), { recursive: true });
      await writeFile(join(ws1, "pkg", "WUDAO.md"), "PKG-IMPLICIT: scoped to pkg/**\n", "utf8");
      await writeFile(join(ws1, "pkg", "code.py"), "print('pkg')\n", "utf8");

      const ruleWarns: string[] = [];
      const rules1 = loadContextRules(ws1, (m) => ruleWarns.push(m));
      const stableOrder = rules1.stable.map((r) => r.name);
      const shadowed = rules1.stable.find((r) => r.name === "x-shadow.md");
      const capped = rules1.stable.find((r) => r.name === "big.md");
      // The stable section joins the system prompt's project-context block,
      // byte-frozen per session (two builds → identical bytes). The implicit
      // subdir file must NOT load at startup — it is a gated rule.
      const promptA = buildSystemPrompt(ws1);
      const promptB = buildSystemPrompt(ws1);
      const stableInPrompt = promptA.includes("## ~/.wudao/rules/a-global.md")
        && promptA.includes("RULE-A-GLOBAL body")
        && promptA.includes("## .wudao/rules/c-proj.md")
        && promptA.includes("RULE-C-PROJ body")
        && promptA.indexOf("RULE-A-GLOBAL") < promptA.indexOf("RULE-C-PROJ") // global tier first
        && !promptA.includes("PKG-IMPLICIT");
      // Gated lazy injection through the REAL loop + REAL read_file tool.
      const matcher = createContextRuleMatcher(ws1, rules1.gated);
      const pyRule = rules1.gated.find((r) => r.source === ".wudao/rules/py-gated.md");
      const gatedRun = snapshotModel([
        toolTurn("g1", "read_file", { path: "code.py" }), // matching → inject
        toolTurn("g2", "read_file", { path: "note.txt" }), // non-matching → nothing
        toolTurn("g3", "read_file", { path: "code.py" }), // already present → dedupe
        { role: "assistant", content: "RULES-DONE" },
      ]);
      const gatedState: AgentState = {
        systemPrompt: "sp",
        messages: [{ role: "user", content: "work on the python file" }],
        tools: [createReadFileTool({ workspaceRoot: ws1 })],
        status: "idle",
      };
      const gatedOut = await drain(runAgentLoop(gatedState, gatedRun, {
        maxTurns: 6,
        gates: { todo: false, verify: false },
        contextRules: { match: matcher },
      }));
      const loadedEvents = gatedOut.events.filter((e): e is Extract<LoopEvent, { type: "context_rule_loaded" }> => e.type === "context_rule_loaded");
      const pyEvents = loadedEvents.filter((e) => e.source === ".wudao/rules/py-gated.md");
      const noteIdx = gatedState.messages.findIndex((m) => m.role === "user" && m.content.startsWith(ruleNotePrefix(".wudao/rules/py-gated.md")));
      const toolResultIdx = gatedState.messages.findIndex((m) => m.role === "tool");
      const serialized = gatedRun.inputs.map((i) => serializePrompt(i));
      const prefixStable = serialized.length > 1 && serialized.slice(1).every((s, k) => s.startsWith(serialized[k]!));
      const matcherZeroCost = pyRule !== undefined
        && matcher("glob", { path: "code.py" }).length === 0
        && matcher("read_file", { path: "../escape.py" }).length === 0
        && matcher("read_file", {}).length === 0;
      // Post-compact reload: the REAL tier-2 summarizer replaces the span
      // (rule note gone) → the next matching read re-injects.
      const summarizer = snapshotModel([{ role: "assistant", content: "summary: user worked on code.py" }]);
      const compacted = await tier2Compact(gatedState.messages, summarizer, { keepRecent: 0, systemPrompt: "sp", tools: [] });
      const compactRemovedNote = compacted !== null
        && compacted.messages[0]!.content.startsWith(SUMMARY_MARKER)
        && !compacted.messages.some((m) => m.content.includes("[context rule "));
      const reloadState: AgentState = {
        systemPrompt: "sp",
        messages: [...(compacted?.messages ?? []), { role: "user", content: "continue on the python file" }],
        tools: [createReadFileTool({ workspaceRoot: ws1 })],
        status: "idle",
      };
      const reloadRun = snapshotModel([
        toolTurn("g4", "read_file", { path: "pkg/code.py" }), // implicit subdir rule
        toolTurn("g5", "read_file", { path: "code.py" }), // explicit rule re-load
        { role: "assistant", content: "RELOADED" },
      ]);
      const reloadOut = await drain(runAgentLoop(reloadState, reloadRun, {
        maxTurns: 5,
        gates: { todo: false, verify: false },
        contextRules: { match: matcher },
      }));
      const reloadEvents = reloadOut.events.filter((e): e is Extract<LoopEvent, { type: "context_rule_loaded" }> => e.type === "context_rule_loaded");
      const subdirRule = rules1.gated.find((r) => r.implicit === true && r.source === "pkg/WUDAO.md");

      // ================================================================== §2
      // lifecycle + purge.
      const now = Date.now();
      const aged = new Date(now - 31 * DAY);
      const ws2 = await makeWs(root, "ws2");
      const agedFiles = [
        "sessions/old.jsonl", "spill/deep/old.bin", "history/snap-1.txt", "logs/debug.log",
      ];
      for (const rel of agedFiles) await writeFileDeep(join(ws2, ".wudao", rel), `${rel} bytes\n`);
      for (const rel of agedFiles) await utimes(join(ws2, ".wudao", rel), aged, aged);
      await writeFile(join(ws2, ".wudao", "sessions", "current.jsonl"), "current session\n", "utf8");
      const neverList = [
        "memory.jsonl", "settings.json", "settings.local.json", "experiments.jsonl",
        "agents/roster.md", "skills/deploy/SKILL.md", "rules/r.md", "cron.json", "mcp.json",
      ];
      for (const rel of neverList) {
        await writeFileDeep(join(ws2, ".wudao", rel), `NEVER ${rel}\n`);
        await utimes(join(ws2, ".wudao", rel), aged, aged);
      }
      const lifecycleWarns: string[] = [];
      const scalars = resolveLifecycleSettings({ cleanupPeriodDays: 20, softDeletePeriodDays: 3 }, (m) => lifecycleWarns.push(m));
      const junkScalars = resolveLifecycleSettings({ cleanupPeriodDays: "junk" }, (m) => lifecycleWarns.push(m));
      // Layered scalar: global 10 < project 20.
      await writeFile(join(globalHome, "settings.json"), JSON.stringify({ cleanupPeriodDays: 10 }), "utf8");
      const wsLifecycle = await makeWs(root, "ws-lifecycle");
      await writeFile(join(wsLifecycle, ".wudao", "settings.json"), JSON.stringify({ cleanupPeriodDays: 20 }), "utf8");
      const lifecycleLayered = await loadLayeredSettings(wsLifecycle, undefined, { WUDAO_GLOBAL_HOME: globalHome });
      const sweep1 = await runLifecycleSweep(ws2, { cleanupPeriodDays: 30, softDeletePeriodDays: 7 }, now);
      // M62 fix: the trash rename RESETS the entry's mtime to the trash time,
      // so an already-expired file (mtime past cleanup) is NOT past the trash
      // window — it survives this sweep and hard-deletes only after the window
      // elapses. The recoverable window is real for every file.
      const sweep2 = await runLifecycleSweep(ws2, { cleanupPeriodDays: 30, softDeletePeriodDays: 7 }, now + 8 * DAY);
      const neverSurvived: string[] = [];
      for (const rel of neverList) {
        const text = await readFile(join(ws2, ".wudao", rel), "utf8");
        if (text === `NEVER ${rel}\n`) neverSurvived.push(rel);
      }
      // purge: dry-run zero writes → execute soft-deletes (byte-recoverable)
      // → the soft-delete window expires to a hard delete.
      const ws3 = await makeWs(root, "ws3");
      await writeFileDeep(join(ws3, ".wudao", "sessions", "a.jsonl"), "A-PAYLOAD-123\n");
      await writeFileDeep(join(ws3, ".wudao", "spill", "b.bin"), "B-PAYLOAD-456\n");
      const snapFiles = async (): Promise<Record<string, { bytes: number; mtimeMs: number }>> => {
        const out: Record<string, { bytes: number; mtimeMs: number }> = {};
        const walk = async (dir: string): Promise<void> => {
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) await walk(full);
            else {
              const s = await stat(full);
              out[full] = { bytes: s.size, mtimeMs: s.mtimeMs };
            }
          }
        };
        await walk(ws3);
        return out;
      };
      const beforePlan = await snapFiles();
      const plan = await buildPurgePlan(ws3);
      const planText = formatPurgePlan(plan, Date.now());
      const afterPlan = await snapFiles();
      const execute = await executePurge(ws3, plan);
      const trashA = join(ws3, ".wudao", "trash", "sessions", "a.jsonl");
      const trashB = join(ws3, ".wudao", "trash", "spill", "b.bin");
      const recovered = (await readFile(trashA, "utf8")) === "A-PAYLOAD-123\n" && (await readFile(trashB, "utf8")) === "B-PAYLOAD-456\n";
      const sweepExpiry = await runLifecycleSweep(ws3, { cleanupPeriodDays: 30, softDeletePeriodDays: 7 }, now + 8 * DAY);
      // The current-session skip: an OLD transcript named as the live session
      // is never swept (resume must not race the sweeper).
      const ws4 = await makeWs(root, "ws4");
      await writeFileDeep(join(ws4, ".wudao", "sessions", "resumed.jsonl"), "old but live\n");
      await utimes(join(ws4, ".wudao", "sessions", "resumed.jsonl"), aged, aged);
      const skipSweep = await runLifecycleSweep(ws4, { cleanupPeriodDays: 30, softDeletePeriodDays: 7 }, now, [join(ws4, ".wudao", "sessions", "resumed.jsonl")]);
      // §2 CLI acceptance: drive the REAL `wudao purge` binary — --dry-run
      // prints the plan + "(dry run — nothing was written)" and writes ZERO
      // bytes; `--yes` soft-deletes; a fresh process then sees a clean
      // workspace ("purge 后新会话正常"). The purge branch returns before any
      // skills/plugins/settings loading, so a minimal fixture cwd is enough.
      const execFileP = promisify(execFile);
      // Monorepo-relative resolution: the cli's exports map carries only
      // import/types conditions (createRequire/CJS cannot resolve the
      // subpath), and vitest's SSR shim lacks import.meta.resolve — but this
      // suite lives IN the monorepo, so a source-relative path to
      // packages/cli/dist is deterministic. src/suites → up 3 = packages/.
      const cliDist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "cli", "dist", "index.js");
      const wsPurge = await makeWs(root, "ws-purge");
      await writeFileDeep(join(wsPurge, ".wudao", "sessions", "x.jsonl"), "X-PAYLOAD\n");
      await writeFileDeep(join(wsPurge, ".wudao", "spill", "y.bin"), "Y-PAYLOAD\n");
      const snapPurge = async (): Promise<Record<string, number>> => {
        const out: Record<string, number> = {};
        const walk = async (dir: string): Promise<void> => {
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) await walk(full);
            else out[full] = (await stat(full)).size;
          }
        };
        await walk(wsPurge);
        return out;
      };
      const beforeDryRun = await snapPurge();
      const dryRun = await execFileP(process.execPath, [cliDist, "purge", "--dry-run"], { cwd: wsPurge, maxBuffer: 1 << 20 });
      const afterDryRun = await snapPurge();
      const yesRun = await execFileP(process.execPath, [cliDist, "purge", "--yes"], { cwd: wsPurge, maxBuffer: 1 << 20 });
      const afterYes = await snapPurge();
      const newSession = await execFileP(process.execPath, [cliDist, "purge", "--dry-run"], { cwd: wsPurge, maxBuffer: 1 << 20 });

      // ================================================================== §3
      // local tier: precedence matrix + trust gate + gitignore + order.
      await writeFile(join(globalHome, "settings.json"), JSON.stringify({
        cleanupPeriodDays: 10,
        permissions: { allow: ["read_file:G"] },
      }), "utf8");
      const ws5 = await makeWs(root, "ws5");
      await writeFile(join(ws5, ".wudao", "settings.json"), JSON.stringify({
        cleanupPeriodDays: 20,
        permissions: { allow: ["read_file:P"] },
        env: { EVIL: "1" },
      }), "utf8");
      await writeFile(join(ws5, ".wudao", "settings.local.json"), JSON.stringify({
        cleanupPeriodDays: 40,
        permissions: { allow: ["read_file:L"] },
        bypassPermissions: true,
        memoryEnabled: false,
      }), "utf8");
      const localWarns: string[] = [];
      const layered5 = await loadLayeredSettings(ws5, (m) => localWarns.push(m), { WUDAO_GLOBAL_HOME: globalHome });
      const allow = (layered5.effective["permissions"] as { allow?: string[] })?.allow ?? [];
      // First write auto-gitignores when a .gitignore exists; no .gitignore →
      // warn + manual guidance; a second write never touches it again.
      const ws6 = await makeWs(root, "ws6");
      await writeFile(join(ws6, ".gitignore"), "node_modules\n", "utf8");
      const save6 = await saveLocalSettings(ws6, { theme: "dark" });
      const gitignore6 = await readFile(join(ws6, ".gitignore"), "utf8");
      const ws7 = await makeWs(root, "ws7");
      const giWarns: string[] = [];
      await saveLocalSettings(ws7, { theme: "dark" }, (m) => giWarns.push(m));
      const second = await saveLocalSettings(ws6, { theme: "light" });
      const gitignoreAfterSecond = await readFile(join(ws6, ".gitignore"), "utf8");
      // WUDAO.local.md loads LAST in the M54b order.
      const ws8 = await makeWs(root, "ws8");
      await writeFile(join(ws8, "WUDAO.md"), "WS8-ROOT body\n", "utf8");
      await writeFile(join(ws8, "WUDAO.local.md"), "WS8-LOCAL personal body\n", "utf8");
      const prompt8 = buildSystemPrompt(ws8);

      // ================================================================== §4
      // output styles.
      await writeFile(join(globalHome, "output-styles", "concise.md"), "GLOBAL-CONCISE body\n", "utf8");
      await writeFile(join(globalHome, "output-styles", "verbose.md"), "VERBOSE-STYLE body\n", "utf8");
      const ws9 = await makeWs(root, "ws9");
      await mkdir(join(ws9, ".wudao", "output-styles"), { recursive: true });
      await writeFile(join(ws9, "WUDAO.md"), "WS9-CTX body\n", "utf8");
      await writeFile(join(ws9, ".wudao", "output-styles", "concise.md"), "PROJ-CONCISE body\n", "utf8");
      await writeFile(
        join(ws9, ".wudao", "output-styles", "swap.md"),
        "---\nname: swap\nreplace-coding-instructions: true\n---\nSWAP-STYLE body\n",
        "utf8",
      );
      const styleWarns: string[] = [];
      const styles9 = loadOutputStyles(ws9, (m) => styleWarns.push(m));
      resetOutputStyleForTests();
      setSessionOutputStyle("verbose");
      const styleTools = buildToolSet({ workspaceRoot: ws9, model: "stub" } as never); // 风格评估要看到「coding 那格」——硬编码段已删，只能给真实工具集
      const spVerbose1 = buildSystemPrompt(ws9, false, [], false, false, styleTools);
      const spVerbose2 = buildSystemPrompt(ws9, false, [], false, false, styleTools);
      setSessionOutputStyle("concise"); // mid-session flip: sealed → refused
      const spMidSession = buildSystemPrompt(ws9, false, [], false, false, styleTools);
      resetOutputStyleForTests(); setSessionOutputStyle("swap"); // a RESTART reopens the selection
      const spSwap = buildSystemPrompt(ws9, false, [], false, false, styleTools);
      resetOutputStyleForTests();
      const spNone = buildSystemPrompt(ws9, false, [], false, false, styleTools);

      // ================================================================== §5
      // hooks additionalContext — real commands through buildConfiguredHooks.
      // execPath is quoted: on win32 it lives under "C:\Program Files\…" and
      // tokenizeCommand would otherwise split it at the space.
      const ctxJson = (sentinel: string): string =>
        `"${process.execPath}" -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{additionalContext:${JSON.stringify(sentinel)}}}))'`;
      const ws10 = await makeWs(root, "ws10");
      await writeFile(join(ws10, "note.txt"), "hook target file\n", "utf8");
      const runCtxLoop = async (hooksCommand: string) => {
        const hooks = buildConfiguredHooks({ onPostToolUse: [{ command: hooksCommand }] }, { workspaceRoot: ws10 });
        const model = snapshotModel([
          toolTurn("h1", "read_file", { path: "note.txt" }),
          { role: "assistant", content: "HOOKS-DONE" },
        ]);
        const state: AgentState = {
          systemPrompt: "sp",
          messages: [{ role: "user", content: "read the note" }],
          tools: [createReadFileTool({ workspaceRoot: ws10 })],
          status: "idle",
        };
        const out = await drain(runAgentLoop(state, model, {
          maxTurns: 3,
          gates: { todo: false, verify: false },
          hooks,
        }));
        return { model, state, events: out.events };
      };
      const jsonRun = await runCtxLoop(ctxJson("M62-CTX-A"));
      const jsonSerialized = jsonRun.model.inputs.map((i) => serializePrompt(i));
      const lastTool = [...jsonRun.model.inputs[1]!.messages].reverse().find((m) => m.role === "tool");
      // Two hooks chain their contexts (joined, one projection).
      const chainedHooks = buildConfiguredHooks({
        onPostToolUse: [{ command: ctxJson("CHAIN-ONE") }, { command: ctxJson("CHAIN-TWO") }],
      }, { workspaceRoot: ws10 });
      const chainedModel = snapshotModel([
        toolTurn("h2", "read_file", { path: "note.txt" }),
        { role: "assistant", content: "CHAINED" },
      ]);
      const chainedState: AgentState = {
        systemPrompt: "sp",
        messages: [{ role: "user", content: "read the note" }],
        tools: [createReadFileTool({ workspaceRoot: ws10 })],
        status: "idle",
      };
      await drain(runAgentLoop(chainedState, chainedModel, { maxTurns: 3, gates: { todo: false, verify: false }, hooks: chainedHooks }));
      const chainedLastTool = [...chainedModel.inputs[1]!.messages].reverse().find((m) => m.role === "tool");
      // Plain stdout ≠ context; exit 1 never injects.
      const plainRun = await runCtxLoop(`"${process.execPath}" -e 'process.stdout.write("just plain stdout")'`);
      const exitRun = await runCtxLoop(`"${process.execPath}" -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{additionalContext:"MUST-NOT-INJECT"}})); process.exit(1)'`);
      const bigCtx = "line\n".repeat(4_000); // 20k chars > the 8k cap

      // ================================================================== §6
      // defer auto threshold + alwaysLoad.
      const modeMatrix = ([
        { mode: "(unset)", settings: undefined, envOff: false },
        { mode: "auto", settings: "auto" as const, envOff: false },
        { mode: "on", settings: "on" as const, envOff: false },
        { mode: "off", settings: "off" as const, envOff: false },
        { mode: "junk", settings: "banana" as const, envOff: false },
        { mode: "on", settings: "on" as const, envOff: true },
      ]).map((c) => ({ mode: c.mode, envOff: c.envOff, out: resolveDeferMode(c.settings, c.envOff ? { WUDAO_DEFER_TOOLS: "off" } : {}) }));
      const deferSettingWarns: string[] = [];
      const settingMatrix = [
        { mode: "auto", settings: readDeferModeSetting({ defer: "auto" }, (m) => deferSettingWarns.push(m)) },
        { mode: "junk", settings: readDeferModeSetting({ defer: "banana" }, (m) => deferSettingWarns.push(m)) },
        { mode: "(none)", settings: readDeferModeSetting({}, (m) => deferSettingWarns.push(m)) },
      ].map((c) => ({ mode: c.mode, out: String(c.settings) }));
      const quietModel = snapshotModel([{ role: "assistant", content: "ok" }]);
      const canUse = async () => ({ behavior: "allow" as const });
      const probeTools = buildToolSet({ workspaceRoot: ws10, model: quietModel, canUseTool: canUse, contextWindowTokens: 2_000 });
      const deferCandidates = probeTools.filter((t) => DEFER_CANDIDATE_TOOL_NAMES.has(t.name));
      const thresholdFlips = deferCandidates.length > 0
        && deferCandidatesFitWindow(deferCandidates, 1_000) === false
        && deferCandidatesFitWindow(deferCandidates, 4_000_000) === true;
      const requestNames = async (window: number): Promise<string[]> => {
        const m = snapshotModel([{ role: "assistant", content: "ok" }]);
        const tools = buildToolSet({ workspaceRoot: ws10, model: m, canUseTool: canUse, contextWindowTokens: window });
        const st: AgentState = { systemPrompt: "sp", messages: [{ role: "user", content: "go" }], tools, status: "idle" };
        await drain(runAgentLoop(st, m, { maxTurns: 2, gates: { todo: false, verify: false } }));
        return (m.inputs[0]?.tools ?? []).map((t) => t.name);
      };
      setSessionDeferMode("auto");
      const autoEagerNames = await requestNames(4_000_000);
      const autoDeferredNames = await requestNames(2_000);
      // Wired default (§6): NO tools.defer key → resolveDeferMode(readDeferModeSetting(undefined))
      // → "auto" (the spec default; the legacy "on" fallback is gone). The
      // threshold then decides: big window → eager, small window → deferred.
      setSessionDeferMode(resolveDeferMode(readDeferModeSetting(undefined)));
      const wiredDefaultEager = await requestNames(4_000_000);
      const wiredDefaultDeferred = await requestNames(2_000);
      setSessionDeferMode("on");
      const onTools = buildToolSet({ workspaceRoot: ws10, model: quietModel, canUseTool: canUse, contextWindowTokens: 4_000_000 });
      const explicitOnDefers = onTools.find((t) => t.name === "task")?.shouldDefer?.() === true;
      setSessionDeferMode("off");
      const offTools = buildToolSet({ workspaceRoot: ws10, model: quietModel, canUseTool: canUse, contextWindowTokens: 2_000 });
      const explicitOffEager = offTools.find((t) => t.name === "task")?.shouldDefer?.() !== true;
      setSessionDeferMode("on");
      process.env.WUDAO_DEFER_TOOLS = "off";
      const envOffTools = buildToolSet({ workspaceRoot: ws10, model: quietModel, canUseTool: canUse, contextWindowTokens: 4_000_000 });
      const envOffBeatsOn = envOffTools.find((t) => t.name === "task")?.shouldDefer?.() !== true;
      if (prevDeferEnv === undefined) delete process.env.WUDAO_DEFER_TOOLS;
      else process.env.WUDAO_DEFER_TOOLS = prevDeferEnv;
      // alwaysLoad: the config surface (literal true only) + the eager pin
      // (MCP tools never defer — alwaysLoad guarantees it by construction).
      await writeFile(join(globalHome, "mcp.json"), JSON.stringify({
        servers: {
          alpha: { command: "run-alpha", alwaysLoad: true },
          beta: { command: "run-beta", alwaysLoad: "yes" },
        },
      }), "utf8");
      const ws11 = await makeWs(root, "ws11");
      await writeFile(join(ws11, ".wudao", "mcp.json"), JSON.stringify({
        servers: { alpha: { command: "run-alpha-project" } },
      }), "utf8");
      const mcpCfg = loadMcpConfig(ws11);
      const normalized = normalizeServer("s", { command: "c", alwaysLoad: true });
      const alwaysLoadLiteral = [
        mcpCfg.servers["alpha"]?.alwaysLoad === undefined ? "alpha:project-replaced" : "alpha:true",
        mcpCfg.servers["beta"]?.alwaysLoad === undefined ? "beta:absent" : "beta:true",
        normalized?.alwaysLoad === true ? "normalize:true" : "normalize:absent",
      ];
      setSessionDeferMode("on"); // defer everything deferrable
      const mcpTool: Tool = buildTool({
        name: "mcp__alpha_run",
        description: "d",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ content: "ok" }),
      });
      const mcpModel = snapshotModel([{ role: "assistant", content: "ok" }]);
      const mcpTools = buildToolSet({
        workspaceRoot: ws10,
        model: mcpModel,
        canUseTool: canUse,
        contextWindowTokens: 2_000,
        extraTools: [mcpTool],
      });
      const mcpState: AgentState = { systemPrompt: "sp", messages: [{ role: "user", content: "go" }], tools: mcpTools, status: "idle" };
      await drain(runAgentLoop(mcpState, mcpModel, { maxTurns: 2, gates: { todo: false, verify: false } }));
      const mcpFirstNames = (mcpModel.inputs[0]?.tools ?? []).map((t) => t.name);

      // ================================================================== §7
      // misc keys + claudeMdExcludes (through the real loader).
      const miscWarns: string[] = [];
      const clampLow = resolveAutoCompactSettings({ autoCompactWindow: 50_000 }, 400_000, (m) => miscWarns.push(m));
      const clampHigh = resolveAutoCompactSettings({ autoCompactWindow: 2_000_000 }, 400_000, (m) => miscWarns.push(m));
      const junkWindow = resolveAutoCompactSettings({ autoCompactWindow: "junk" }, 400_000, (m) => miscWarns.push(m));
      const compactOff = resolveAutoCompactSettings({ autoCompactEnabled: false }, 400_000, (m) => miscWarns.push(m));
      const ws12 = await makeWs(root, "ws12");
      await writeFile(join(ws12, ".wudao", "settings.json"), JSON.stringify({
        autoCompactWindow: 200_000,
        claudeMdExcludes: ["AGENTS.md", "zzz-*.md"],
        fallbackModel: ["m-proj"],
      }), "utf8");
      await writeFile(join(ws12, ".wudao", "settings.local.json"), JSON.stringify({
        autoCompactWindow: 500_000,
        fallbackModel: ["m-b", "m-proj", 7],
      }), "utf8");
      await writeFile(join(globalHome, "settings.json"), JSON.stringify({ fallbackModel: ["m-a"] }), "utf8");
      const layered12 = await loadLayeredSettings(ws12, (m) => miscWarns.push(m), { WUDAO_GLOBAL_HOME: globalHome });
      const compactLayered = resolveAutoCompactSettings(layered12.effective, 400_000);
      const memoryOff = resolveMemorySettings(ws12, { memoryEnabled: false, memoryDirectory: "data" });
      const memoryDirect = resolveMemorySettings(ws12, { memoryDirectory: "custom.jsonl" });
      const excludesParsed = parseClaudeMdExcludes(layered12.effective);
      resetProjectContextCacheForTests();
      setProjectContextExcludes(excludesParsed);
      await writeFile(join(ws12, "WUDAO.md"), "WS12-ROOT body\n", "utf8");
      await writeFile(join(ws12, "AGENTS.md"), "WS12-AGENTS must be skipped\n", "utf8");
      const ctx12 = loadProjectContext(ws12);

      // fallbackModel — the ordered chain through the REAL provider engine.
      const requested: string[] = [];
      const fetchByModel = (statusFor: (model: string) => number): typeof fetch => (async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        requested.push(body.model);
        const status = statusFor(body.model);
        if (status !== 200) return new Response("boom", { status });
        return new Response(JSON.stringify({
          choices: [{ message: { role: "assistant", content: `from ${body.model}` } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      const chainConfig = {
        apiKey: "k",
        baseURL: "http://det46.test",
        model: "primary",
        fallbackModels: ["fb1", "fb2"],
      };
      const noSleep = { sleep: async (): Promise<void> => {}, maxRetries: 0 };
      let receipt: { model?: string; from?: string } | undefined;
      const chainProvider = createOpenAICompatibleProvider(chainConfig, {
        fetch: fetchByModel((m) => (m === "primary" || m === "fb1" ? 500 : 200)),
        retry: noSleep,
      });
      const chainOut = await chainProvider.generate({
        systemPrompt: "s", tools: [], messages: [{ role: "user", content: "go" }],
        onUsage: (u) => { receipt = { model: u.fallbackModel, from: u.fallbackFrom }; },
      });
      // Sticky: two consecutive primary failures → the next call starts at fb1.
      await chainProvider.generate({ systemPrompt: "s", tools: [], messages: [{ role: "user", content: "again" }] });
      const callsBeforeSticky = requested.length;
      await chainProvider.generate({ systemPrompt: "s", tools: [], messages: [{ role: "user", content: "third" }] });
      const stickySegment = requested.slice(callsBeforeSticky);
      // Key-class (401) NEVER falls back.
      const keyRequested: string[] = [];
      const keyProvider = createOpenAICompatibleProvider(chainConfig, {
        fetch: (async (_url: unknown, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as { model: string };
          keyRequested.push(body.model);
          return new Response("unauthorized", { status: 401 });
        }) as typeof fetch,
        retry: noSleep,
      });
      const keyErr = await keyProvider.generate({ systemPrompt: "s", tools: [], messages: [{ role: "user", content: "go" }] }).then(() => undefined, (e: unknown) => e);

      return {
        rules: {
          stableOrder,
          shadowedBody: shadowed?.body ?? "(missing)",
          shadowWarning: ruleWarns.find((w) => w.includes("x-shadow")),
          cappedBodyTail: capped?.body.slice(-40) ?? "(missing)",
          cappedBodyLen: capped?.body.length ?? -1,
          stableInPrompt,
          promptByteStable: promptA === promptB,
          injectedOnce: pyEvents.length,
          noteInHistory: noteIdx !== -1,
          noteAfterToolResult: noteIdx > toolResultIdx,
          prefixStable,
          nonMatchZero: gatedState.messages.filter((m) => m.role === "user" && m.content.startsWith("[context rule ")).length === 1,
          matcherZeroCost,
          compactRemovedNote,
          reloadedAfterCompact: reloadEvents.length,
          subdirImplicit: subdirRule !== undefined && (subdirRule.paths ?? []).includes("pkg/**"),
          subdirInjected: reloadEvents.some((e) => e.source === "pkg/WUDAO.md"),
        },
        lifecycle: {
          scalars: {
            cleanup: scalars.cleanupPeriodDays,
            soft: scalars.softDeletePeriodDays,
            junkDefault: junkScalars.cleanupPeriodDays === DEFAULT_CLEANUP_PERIOD_DAYS && junkScalars.softDeletePeriodDays === DEFAULT_SOFT_DELETE_PERIOD_DAYS,
            layered: (lifecycleLayered.effective["cleanupPeriodDays"] as number) ?? -1,
          },
          softDeletedCount: sweep1.softDeleted.length,
          agedTrashSurvivesSweep1: sweep1.hardDeleted.length === 0,
          agedTrashHardDeletedAfterWindow: sweep2.hardDeleted.length,
          neverListSurvived: neverSurvived,
          currentSurvives: existsSync(join(ws2, ".wudao", "sessions", "current.jsonl")),
          planZeroWrites: JSON.stringify(beforePlan) === JSON.stringify(afterPlan),
          planText,
          purgeSoftDeleted: execute.softDeleted.length,
          purgeRecoveredBytes: recovered && !existsSync(join(ws3, ".wudao", "sessions", "a.jsonl")),
          windowThenHardDelete: sweepExpiry.hardDeleted.length === 2 && !existsSync(trashA) && !existsSync(trashB),
          skipProtectsCurrent: existsSync(join(ws4, ".wudao", "sessions", "resumed.jsonl")) && skipSweep.softDeleted.length === 0,
          noticeLine: formatSweepNotice(sweep1),
          emptyNotice: formatSweepNotice({ softDeleted: [], hardDeleted: [], softDeletedBytes: 0, hardDeletedBytes: 0 }),
          cliPurge: {
            dryRunZeroWrites: JSON.stringify(beforeDryRun) === JSON.stringify(afterDryRun),
            dryRunNotice: dryRun.stdout.includes("清除计划") && dryRun.stdout.includes("sessions/x.jsonl") && dryRun.stdout.includes("（试运行——未写入任何内容）"), // ω99-194: 钉随源演进
            yesSoftDeletes: yesRun.stdout.includes("已将 2 个文件移入 .wudao/trash") && !existsSync(join(wsPurge, ".wudao", "sessions", "x.jsonl")) && afterYes[join(wsPurge, ".wudao", "trash", "sessions", "x.jsonl")] === "X-PAYLOAD\n".length, // ω99-194: 钉随源演进
            newSessionClean: newSession.stdout.includes("无可清除数据"), // ω99-194: 钉随源演进
          },
        },
        local: {
          scalarLocalWins: layered5.effective["cleanupPeriodDays"] === 40,
          arrayConcat: allow,
          escalationRefused: layered5.projectEscalations,
          localEscalationWarning: localWarns.find((w) => w.includes("settings.local.json") && w.includes("bypassPermissions")),
          keySource: layered5.keySources["memoryEnabled"],
          gitignoreAdded: save6.gitignored === true && gitignore6.includes(".wudao/settings.local.json"),
          gitignoreWarned: giWarns.some((w) => w.includes(".gitignore") && w.includes("settings.local.json")),
          secondWriteNoTouch: second.created === false && gitignoreAfterSecond === gitignore6,
          localContextLast: (() => {
            const iRoot = prompt8.indexOf("## WUDAO.md");
            const iLocal = prompt8.indexOf("## WUDAO.local.md");
            return iRoot !== -1 && iLocal !== -1 && iLocal > iRoot && prompt8.includes("WS8-LOCAL personal body");
          })(),
        },
        styles: {
          projectWinsBody: findOutputStyle(styles9, "concise")?.body ?? "(missing)",
          shadowWarning: styleWarns.find((w) => w.includes("concise") && w.includes("shadows")),
          replaceFlag: findOutputStyle(styles9, "swap")?.replaceCodingInstructions === true,
          appendedKeepsCoding: spVerbose1.includes("# Output style (verbose)") && spVerbose1.includes("VERBOSE-STYLE body") && spVerbose1.includes("# Tool usage"),
          afterProjectContext: spVerbose1.indexOf("# Output style (verbose)") > spVerbose1.indexOf("# Project context"),
          byteFrozen: spVerbose1 === spVerbose2,
          midSessionRefused: spMidSession === spVerbose1 && !spMidSession.includes("PROJ-CONCISE"),
          restartApplies: spSwap.includes("SWAP-STYLE body"),
          replaceDropsCoding: spSwap.includes("SWAP-STYLE body") && !spSwap.includes("# Tool usage"),
          noneSelectedClean: !spNone.includes("# Output style"),
        },
        hookCtx: {
          parseJson: parseAdditionalContext('{"hookSpecificOutput":{"additionalContext":"X"}}'),
          parsePlain: parseAdditionalContext("plain text") === undefined,
          parseOtherJson: parseAdditionalContext('{"other":1}') === undefined,
          parseEmptyString: parseAdditionalContext('{"hookSpecificOutput":{"additionalContext":""}}') === undefined,
          cappedLen: capAdditionalContext(bigCtx).length,
          cappedTail: capAdditionalContext(bigCtx).slice(-50),
          injectedAtNextCall: (lastTool?.content ?? "").includes("<system_note>") && (lastTool?.content ?? "").includes("M62-CTX-A"),
          notInFirstCall: !serializePrompt(jsonRun.model.inputs[0]!).includes("M62-CTX-A"),
          projectionOnly: !jsonRun.state.messages.some((m) => m.content.includes("<system_note>") || m.content.includes("M62-CTX-A")),
          prefixStable: jsonSerialized[1]!.startsWith(jsonSerialized[0]!),
          chainedHooks: (chainedLastTool?.content ?? "").includes("CHAIN-ONE") && (chainedLastTool?.content ?? "").includes("CHAIN-TWO"),
          plainStdoutNotContext: !serializePrompt(plainRun.model.inputs[1]!).includes("just plain stdout") && !serializePrompt(plainRun.model.inputs[1]!).includes("<system_note>"),
          exitOneNotInjected: !serializePrompt(exitRun.model.inputs[1]!).includes("MUST-NOT-INJECT") && !serializePrompt(exitRun.model.inputs[1]!).includes("<system_note>"),
        },
        defer: {
          modeMatrix,
          settingMatrix,
          thresholdFlips,
          autoEagerNames,
          autoDeferredNames,
          wiredDefaultEager,
          wiredDefaultDeferred,
          explicitOnDefers,
          explicitOffEager,
          envOffBeatsOn,
          alwaysLoadLiteral,
          mcpEagerWhileTaskDeferred: mcpFirstNames,
        },
        misc: {
          compactClampLow: clampLow.windowTokens,
          compactClampHigh: clampHigh.windowTokens,
          compactJunkKeepsEnv: junkWindow.windowTokens,
          compactDisabled: compactOff.enabled === false,
          compactLayered: compactLayered.windowTokens,
          memoryOff: memoryOff.enabled === false,
          memoryDir: memoryOff.path,
          memoryJsonlDirect: memoryDirect.path,
          mcpOff: resolveMcpEnabled({ mcpEnabled: false }) === false,
          mcpJunkDefault: resolveMcpEnabled({ mcpEnabled: "junk" }) === true,
          mcpTimeouts: parseMcpTimeouts({ connectMs: 5_000, requestMs: 60_000, shutdownMs: 3_000 }),
          mcpTimeoutsJunk: Object.keys(parseMcpTimeouts({ connectMs: "x", requestMs: -1, shutdownMs: 0 })).length === 0,
          fallbackParse: parseFallbackModels({ fallbackModel: ["a", "", 3, "b"] }),
          fallbackJunkEmpty: parseFallbackModels({ fallbackModel: "junk" }).length === 0,
          fallbackLayered: parseFallbackModels(layered12.effective),
          excludesSkipped: !ctx12.files.some((f) => f.displayPath === "AGENTS.md") && !ctx12.section.includes("WS12-AGENTS"),
          excludesKept: ctx12.files.some((f) => f.displayPath === "WUDAO.md") && ctx12.section.includes("WS12-ROOT body"),
          deadPatternWarned: ctx12.warnings.some((w) => w.includes("zzz-*.md") && w.includes("dead pattern")),
          excludedPatternFalseDead: ctx12.warnings.some((w) => w.includes('"AGENTS.md" matches no discovered')),
        },
        fallback: {
          orderedModels: [...requested],
          succeededOn: chainOut.content,
          receipt,
          keyClassNoFallback: keyErr !== undefined && keyRequested.every((m) => m === "primary"),
          stickySkipsPrimary: stickySegment.length > 0 && !stickySegment.includes("primary"),
        },
      };
    } finally {
      if (prevGlobalHome === undefined) delete process.env.WUDAO_GLOBAL_HOME;
      else process.env.WUDAO_GLOBAL_HOME = prevGlobalHome;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevDeferEnv === undefined) delete process.env.WUDAO_DEFER_TOOLS;
      else process.env.WUDAO_DEFER_TOOLS = prevDeferEnv;
      resetContextRulesForTests();
      resetProjectContextCacheForTests();
      resetOutputStyleForTests();
      setSessionDeferMode(undefined);
    }
  },
  assertions: (e) => {
    const errors: string[] = [];
    const need = (cond: boolean, what: string): void => {
      if (!cond) errors.push(what);
    };
    // ------------------------------------------------------------------ §1
    need(JSON.stringify(e.rules.stableOrder) === JSON.stringify(["a-global.md", "b-global.md", "big.md", "c-proj.md", "x-shadow.md"]),
      `rules: stable order wrong: ${JSON.stringify(e.rules.stableOrder)} (global tier first, alphabetical per tier)`);
    need(e.rules.shadowedBody.includes("project (must win)"), "rules: same-name project rule must win over the global twin");
    need((e.rules.shadowWarning ?? "").includes("shadows global"), "rules: shadowing must warn naming both tiers");
    need(e.rules.cappedBodyTail.includes("[… rule truncated at 8k chars …]") && e.rules.cappedBodyLen < 9_000,
      `rules: >8k rule body must cap at ${MAX_RULE_BODY_CHARS} on a line boundary (len ${e.rules.cappedBodyLen}, tail ${JSON.stringify(e.rules.cappedBodyTail)})`);
    need(e.rules.stableInPrompt, "rules: no-paths rules must join the project-context stable section (global before project; subdir files stay lazy)");
    need(e.rules.promptByteStable, "rules: the stable section must be byte-identical across prompt builds (session-frozen)");
    need(e.rules.injectedOnce === 1, `rules: the gated rule must inject exactly once across repeated matching reads (got ${e.rules.injectedOnce})`);
    need(e.rules.noteInHistory && e.rules.noteAfterToolResult, "rules: the note must land in history AFTER the matching tool result (append-only)");
    need(e.rules.prefixStable, "rules: serializePrompt prefixes must stay byte-stable across the note injection");
    need(e.rules.nonMatchZero, "rules: non-matching reads must inject nothing (zero cost)");
    need(e.rules.matcherZeroCost, "rules: the matcher must filter non-read/edit tools, escapes, and missing paths");
    need(e.rules.compactRemovedNote, "rules: tier-2 compaction must summarize the rule note away (summary leads, note gone)");
    need(e.rules.reloadedAfterCompact >= 2, `rules: after compaction the matching reads must re-load rules (got ${e.rules.reloadedAfterCompact} events, want py-gated + pkg/WUDAO.md)`);
    need(e.rules.subdirImplicit, "rules: a subdirectory WUDAO.md must surface as an implicit rule scoped to pkg/**");
    need(e.rules.subdirInjected, "rules: reading pkg/code.py must inject the implicit pkg/WUDAO.md rule");
    // ------------------------------------------------------------------ §2
    need(e.lifecycle.scalars.cleanup === 20 && e.lifecycle.scalars.soft === 3, "lifecycle: configured scalars must resolve");
    need(e.lifecycle.scalars.junkDefault, "lifecycle: junk values must fall back to the defaults (30/7)");
    need(e.lifecycle.scalars.layered === 20, `lifecycle: two-tier scalar precedence broken (got ${e.lifecycle.scalars.layered})`);
    need(e.lifecycle.softDeletedCount === 4, `lifecycle: the sweep must soft-delete the 4 expired runtime files (got ${e.lifecycle.softDeletedCount})`);
    need(e.lifecycle.agedTrashSurvivesSweep1, "lifecycle: a just-trashed file must survive the same sweep (mtime reset to trash time — the window counts from trash time)");
    need(e.lifecycle.agedTrashHardDeletedAfterWindow === 4, `lifecycle: trash entries must hard-delete only after the soft-delete window elapses (got ${e.lifecycle.agedTrashHardDeletedAfterWindow})`);
    need(e.lifecycle.neverListSurvived.length === 9, `lifecycle: the never-list must survive byte-identical (kept ${e.lifecycle.neverListSurvived.length}/9: ${e.lifecycle.neverListSurvived.join(",")})`);
    need(e.lifecycle.currentSurvives, "lifecycle: the young current session must survive the sweep");
    need(e.lifecycle.planZeroWrites, "lifecycle: building/printing the purge plan must write ZERO bytes (dry-run contract)");
    need(e.lifecycle.planText.includes("sessions/a.jsonl") && e.lifecycle.planText.includes("spill/b.bin") && e.lifecycle.planText.includes("0 天前"), // ω99-194: 钉随源演进
      "lifecycle: the purge plan must print path + size + age per file");
    need(e.lifecycle.purgeSoftDeleted === 2 && e.lifecycle.purgeRecoveredBytes, "lifecycle: executing a purge must SOFT-delete (originals recoverable in .wudao/trash, byte-identical)");
    need(e.lifecycle.windowThenHardDelete, "lifecycle: after the soft-delete window the trash must hard-delete");
    need(e.lifecycle.skipProtectsCurrent, "lifecycle: the current-session skip must protect a resumed transcript from the sweep");
    need(e.lifecycle.noticeLine.includes("生命周期") && e.lifecycle.noticeLine.includes("4 个文件"), "lifecycle: a non-empty sweep must produce the one-line notice (count + bytes)"); // ω99-194: 钉随源演进
    need(e.lifecycle.emptyNotice === "", "lifecycle: an empty sweep must produce no notice");
    need(e.lifecycle.cliPurge.dryRunZeroWrites, "lifecycle: `wudao purge --dry-run` must write ZERO bytes (real CLI binary)");
    need(e.lifecycle.cliPurge.dryRunNotice, "lifecycle: `wudao purge --dry-run` must print the plan + the dry-run notice (real CLI binary)");
    need(e.lifecycle.cliPurge.yesSoftDeletes, "lifecycle: `wudao purge --yes` must soft-delete into .wudao/trash (real CLI binary, byte-recoverable)");
    need(e.lifecycle.cliPurge.newSessionClean, "lifecycle: a fresh process after purge must see a clean workspace (purge 后新会话正常)");
    // ------------------------------------------------------------------ §3
    need(e.local.scalarLocalWins, "local: scalar precedence must be global < project < local (local wins)");
    need(JSON.stringify(e.local.arrayConcat) === JSON.stringify(["read_file:G", "read_file:P", "read_file:L"]),
      `local: arrays must concat-dedup in tier order (got ${JSON.stringify(e.local.arrayConcat)})`);
    need(JSON.stringify([...e.local.escalationRefused].sort()) === JSON.stringify(["bypassPermissions", "env"]),
      `local: BOTH cloneable tiers' escalation keys must be refused (got ${JSON.stringify(e.local.escalationRefused)})`);
    need((e.local.localEscalationWarning ?? "").length > 0, "local: the local tier's escalation refusal must warn naming settings.local.json");
    need(e.local.keySource === "local", `local: /config source annotation must mark local-only keys (got ${String(e.local.keySource)})`);
    need(e.local.gitignoreAdded, "local: first write must append the .gitignore entry");
    need(e.local.gitignoreWarned, "local: with no .gitignore the first write must warn with manual guidance (never create one)");
    need(e.local.secondWriteNoTouch, "local: a second write must never touch .gitignore again");
    need(e.local.localContextLast, "local: WUDAO.local.md must load LAST (most specific personal tier)");
    // ------------------------------------------------------------------ §4
    need(e.styles.projectWinsBody.includes("PROJ-CONCISE"), "styles: same-name project style must win");
    need((e.styles.shadowWarning ?? "").includes("shadows global"), "styles: same-name shadowing must warn");
    need(e.styles.replaceFlag, "styles: replace-coding-instructions:true must parse");
    need(e.styles.appendedKeepsCoding, "styles: default APPEND must keep the coding instructions (tool-usage section)");
    need(e.styles.afterProjectContext, "styles: the style section must ride AFTER # Project context (stable tail)");
    need(e.styles.byteFrozen, "styles: the selected style must be byte-frozen across builds");
    need(e.styles.midSessionRefused, "styles: a mid-session style change must be refused (session bytes unchanged)");
    need(e.styles.restartApplies && e.styles.replaceDropsCoding, "styles: after a restart the new selection applies; replace mode drops the coding section");
    need(e.styles.noneSelectedClean, "styles: no selection must leave no style section");
    // ------------------------------------------------------------------ §5
    need(e.hookCtx.parseJson === "X", "hooks: the JSON envelope must parse to the inner string");
    need(e.hookCtx.parsePlain && e.hookCtx.parseOtherJson && e.hookCtx.parseEmptyString, "hooks: plain stdout / other JSON / empty string must NOT parse as context");
    need(e.hookCtx.cappedLen <= MAX_ADDITIONAL_CONTEXT_CHARS + 60 && e.hookCtx.cappedTail.includes("[… additionalContext truncated at 8k chars …]"),
      `hooks: >8k additionalContext must cap on a line boundary (len ${e.hookCtx.cappedLen})`);
    need(e.hookCtx.injectedAtNextCall, "hooks: the context must inject at the NEXT model call, as a tool-result suffix note");
    need(e.hookCtx.notInFirstCall, "hooks: the context must not appear in the first call");
    need(e.hookCtx.projectionOnly, "hooks: the note is projection-only — persisted history must stay clean");
    need(e.hookCtx.prefixStable, "hooks: the injection must be a pure suffix (serializePrompt prefix stable)");
    need(e.hookCtx.chainedHooks, "hooks: multiple postToolUse hooks must chain their contexts");
    need(e.hookCtx.plainStdoutNotContext, "hooks: plain stdout must NOT become model context");
    need(e.hookCtx.exitOneNotInjected, "hooks: exit≠0 must never inject (even with valid JSON on stdout)");
    // ------------------------------------------------------------------ §6
    const wantModes: Record<string, string> = { "(unset)": "auto", auto: "auto", on: "on", off: "off", junk: "auto" };
    for (const m of e.defer.modeMatrix) {
      const want = m.envOff ? "off" : wantModes[m.mode];
      need(m.out === want, `defer: mode "${m.mode}"${m.envOff ? " + env off" : ""} must resolve to ${want} (got ${m.out})`);
    }
    const wantSettings: Record<string, string> = { auto: "auto", junk: "undefined", "(none)": "undefined" };
    for (const s of e.defer.settingMatrix) {
      need(s.out === wantSettings[s.mode], `defer: tools.defer "${s.mode}" must read ${wantSettings[s.mode]} (got ${s.out})`);
    }
    need(e.defer.thresholdFlips, "defer: the auto verdict must flip with the window (schema bytes/4 vs 10%)");
    need(e.defer.autoEagerNames.includes("task") && !e.defer.autoEagerNames.includes("load_tools"),
      "defer: auto + big window → eager (task present, no load_tools round trip)");
    need(e.defer.autoDeferredNames.includes("load_tools") && !e.defer.autoDeferredNames.includes("task"),
      "defer: auto + small window → deferred (load_tools present, task absent)");
    need(e.defer.wiredDefaultEager.includes("task") && !e.defer.wiredDefaultEager.includes("load_tools"),
      "defer: NO tools.defer key + big window → eager (the wired default is auto, not legacy on)");
    need(e.defer.wiredDefaultDeferred.includes("load_tools") && !e.defer.wiredDefaultDeferred.includes("task"),
      "defer: NO tools.defer key + small window → deferred (the wired default is auto)");
    need(e.defer.explicitOnDefers, "defer: explicit on must defer even under a big window");
    need(e.defer.explicitOffEager, "defer: explicit off must load eagerly even under a small window");
    need(e.defer.envOffBeatsOn, "defer: WUDAO_DEFER_TOOLS=off must beat an explicit on");
    need(JSON.stringify(e.defer.alwaysLoadLiteral) === JSON.stringify(["alpha:project-replaced", "beta:absent", "normalize:true"]),
      `defer: alwaysLoad must count only literal true + project mcp.json replaces by name (got ${JSON.stringify(e.defer.alwaysLoadLiteral)})`);
    need(e.defer.mcpEagerWhileTaskDeferred.includes("mcp__alpha_run") && e.defer.mcpEagerWhileTaskDeferred.includes("load_tools") && !e.defer.mcpEagerWhileTaskDeferred.includes("task"),
      "defer: an alwaysLoad MCP server's tools must ride the prefix eagerly while builtin orchestration defers");
    // ------------------------------------------------------------------ §7
    need(e.misc.compactClampLow === 100_000, `misc: autoCompactWindow must clamp up to 100k (got ${e.misc.compactClampLow})`);
    need(e.misc.compactClampHigh === 1_000_000, `misc: autoCompactWindow must clamp down to 1M (got ${e.misc.compactClampHigh})`);
    need(e.misc.compactJunkKeepsEnv === 400_000, "misc: junk autoCompactWindow must keep the env window");
    need(e.misc.compactDisabled, "misc: autoCompactEnabled:false must parse");
    need(e.misc.compactLayered === 500_000, `misc: autoCompactWindow must resolve through the layered merge (local 500k wins; got ${e.misc.compactLayered})`);
    need(e.misc.memoryOff && e.misc.memoryDir.endsWith(join("data", "memory.jsonl")),
      `misc: memoryEnabled/memoryDirectory must resolve (got ${e.misc.memoryOff}, ${e.misc.memoryDir})`);
    need(e.misc.memoryJsonlDirect.endsWith("custom.jsonl"), "misc: a *.jsonl memoryDirectory must resolve directly");
    need(e.misc.mcpOff && e.misc.mcpJunkDefault, "misc: mcpEnabled must parse (false; junk → default on)");
    need(e.misc.mcpTimeouts.connectMs === 5_000 && e.misc.mcpTimeouts.requestMs === 60_000 && e.misc.mcpTimeouts.shutdownMs === 3_000,
      `misc: mcpTimeouts must parse the three positive-integer fields (got ${JSON.stringify(e.misc.mcpTimeouts)})`);
    need(e.misc.mcpTimeoutsJunk, "misc: mcpTimeouts must drop non-positive/non-number fields");
    need(JSON.stringify(e.misc.fallbackParse) === JSON.stringify(["a", "b"]), `misc: fallbackModel parsing must drop junk entries (got ${JSON.stringify(e.misc.fallbackParse)})`);
    need(e.misc.fallbackJunkEmpty, "misc: a non-array fallbackModel must be ignored");
    need(JSON.stringify(e.misc.fallbackLayered) === JSON.stringify(["m-a", "m-proj", "m-b"]),
      `misc: fallbackModel must merge across tiers (concat-dedup; got ${JSON.stringify(e.misc.fallbackLayered)})`);
    need(e.misc.excludesSkipped, "misc: claudeMdExcludes must skip matching context files");
    need(e.misc.excludesKept, "misc: claudeMdExcludes must keep non-matching files");
    need(e.misc.deadPatternWarned, "misc: a claudeMdExcludes pattern matching nothing must lint as dead");
    need(!e.misc.excludedPatternFalseDead,
      "misc: a pattern that DID exclude a file must not lint as dead (see report concern: excluded candidates never enter the seen-list)");
    // fallback chain (real engine)
    const ordered = e.fallback.orderedModels;
    const firstFb2 = ordered.indexOf("fb2");
    need(firstFb2 > -1 && ordered.slice(0, firstFb2).includes("fb1"), "fallback: the chain must be ordered (fb1 attempted before fb2)");
    need(e.fallback.succeededOn === "from fb2", `fallback: the call must succeed on the last chain entry (got ${JSON.stringify(e.fallback.succeededOn)})`);
    need(e.fallback.receipt?.model === "fb2" && e.fallback.receipt?.from === "primary",
      `fallback: the usage receipt must annotate fallbackModel/fallbackFrom (got ${JSON.stringify(e.fallback.receipt)})`);
    need(e.fallback.keyClassNoFallback, "fallback: key-class 401 must throw without touching the chain (model故障 ≠ 凭据故障)");
    need(e.fallback.stickySkipsPrimary, "fallback: after a failure streak the chain must skip straight to the first fallback");
    return errors;
  },
  metrics: (e) => ({
    ruleChecks: Object.values(e.rules).filter((v) => typeof v === "boolean" && v).length,
    lifecycleNeverKept: e.lifecycle.neverListSurvived.length,
    hookChecks: Object.values(e.hookCtx).filter((v) => typeof v === "boolean" && v).length,
    fallbackChainCalls: e.fallback.orderedModels.length,
  }),
};
