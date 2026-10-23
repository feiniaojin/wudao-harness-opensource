import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
// M30 — the orchestration task tool (spec §A/§B/§C/§D wiring).
//
// Extends the M9 task tool with: `role` (roster lookup: workspace profiles
// over builtins, frozen roles reject provider/model/effort overrides),
// `background` (spawn through the core agent registry, return bg-N
// immediately), `session` (new/resume/fork child sessions), `reportSchema`
// (validated at spawn via the M29 subset validator), and the reasoning
// receipt {requested, effective}. §D: `worktree: true` roles are routed
// through core's createChildWorktree — the child's tool set is re-rooted at
// the worktree; without a git repo the child stays in the main workspace
// with a degraded note. Child tool sets never contain the orchestration
// tools (no nested spawning).
//
// M31 §1: `taskWriteScope` narrows a role's declared write scope (never
// widens) and the child's write-semantics tools get the fail-closed
// write-scope guard (worktree/fork children are exempt — their writes are
// isolated by construction); overlapping scoped spawns warn on the receipt
// (or refuse under a strictOverlaps registry).
import {
  runSubagent,
  buildTool,
  createJsonlSessionStore,
  toSubagentType,
  createChildWorktree,
  createReadFileTool,
  createWriteFileTool,
  createEditTool,
  createShellTool,
  createGlobTool,
  createGrepTool,
  createTodoTool,
  createParentMessageTool,
  formatWriteScope,
  isWriteScopeDeclaration,
  isWriteScopeEmpty,
  narrowWriteScope,
  DEFAULT_MAX_IMAGES,
  newSessionId,
} from "@wudao/core";
import { buildConfiguredHooks } from "../hooks-config.js";
import type { LoopEvent, LoopOptions, ModelClient, ModelUsage, Tool, ForkContext, ChildSessionOptions, WriteScopeDeclaration, ImageBlock } from "@wudao/core";
import type { AgentRoleProfile } from "./core-bind.js";
import { BUILTIN_ROLES, loadRoleProfiles } from "./core-bind.js";
import type { ModelOverrides } from "./contract.js";
import { ORCHESTRATION_TOOL_NAMES, parseSessionParam, resolveRole, roleToolNames } from "./contract.js";
import { KERNEL_POLICY } from "../kernel-policy.js";
import { LANGUAGE_BLOCK_ZH, transcriptHasLanguageBlock, transcriptReasoningBlock } from "../language.js";
import { parseReportSchema, createFinalOutputTool, FINAL_OUTPUT_TOOL_NAME } from "./report-schema.js";
import { applyWriteScopeGuard } from "./write-scope-guard.js";
// M64-B §B: agent memory — the role's persistent MEMORY.md (tier-routed,
// spawn-injected, written back through the ordinary file tools).
import {
  agentMemoryPaths,
  applyMemoryFileRouting,
  buildMemoryInjection,
  effectiveMemoryTier,
  memoryPromptSection,
  readAgentMemory,
} from "./agent-memory.js";
import { resolveGlobalHome } from "../settings-layer.js";
import { decorateChildGate } from "../ask-evidence.js";
// ω99-43: durable child approval receipts — the face built at this spawn
// site rides the child's decorated gate (AskContext.approvals).
import { buildChildApprovals } from "./child-approvals.js";
import type { ChildApprovalFace } from "./child-approvals.js";
import { budgetsDisabled, defaultStatsPath, loadAgentStats, recordAgentSample, suggestBudget } from "./budget.js";
import type { AgentBudgetSample } from "./budget.js";
// ω99-57: the parent-side child-mail lane (the sink core's runSubagent
// delivers formatted child→parent messages onto).
import { laneAsParentMail } from "./child-mail.js";
import type { ChildMailLane } from "./child-mail.js";
import { PARENT_MESSAGE_TOOL_NAME, CHILD_MESSAGE_TOOL_NAME } from "@wudao/core";
import type { JsonSchemaSubset } from "../workflow/structured-output.js";
// ω99-5b §A: canonical schema bytes for the report-contract line (sorted keys
// — deterministic, assertable, identical for JSON-equal schemas).
import { canonicalJson } from "../workflow/structured-output.js";
// ω99 拆分运动 弧 B：spawn 支撑族外提至 task-tool-support.ts；此处 import 回用
// + re-export 门面保公共面。
import {
  BUILTIN_ROLE_NAMES, DEFAULT_CHILD_TURNS, PILOT_NUDGE,
  defaultChildToolsFor, parseJsonObject, parseImageIdsArg, subagentEventWithUsage,
  stateWord, runChild,
} from "./task-tool-support.js";
import type { AgentsTaskToolOptions } from "./task-tool-support.js";
export type { AgentsTaskToolOptions } from "./task-tool-support.js";

export function createAgentsTaskTool(options: AgentsTaskToolOptions): Tool {
  let nudged = false; // one nudge per tool instance (≈ per session)
  let rosterCache: { key: string; value: Promise<import("./core-bind.js").LoadedRoster> } | undefined;
  // M31 §3: the dispatch table — one stable call id (t-N) per task call, with
  // the settled state and child-session id resume_from validates against.
  let callCounter = 0;
  const dispatches = new Map<string, { bgId?: string; sessionId?: string; settled: boolean }>();

  const roster = (): Promise<import("./core-bind.js").LoadedRoster> => {
    // Cached per run id; a fresh session (new runId) re-reads the workspace.
    if (!rosterCache || rosterCache.key !== options.runId) {
      rosterCache = {
        key: options.runId,
        value: loadRoleProfiles(options.workspaceRoot, {
          // M40 §2: the plugin layer — builtin < plugin < global < workspace.
          ...(options.pluginAgents !== undefined && options.pluginAgents.length > 0 ? { pluginAgents: options.pluginAgents } : {}),
          // M57 §1: the global tier's AGENTS dir (~/.wudao/agents).
          globalAgentsDir: join(resolveGlobalHome(), "agents"),
        }),
      };
    }
    return rosterCache.value;
  };

  const built: Tool = buildTool({
    name: "task",
    description:
      "Launch a sub-agent for a focused task. Returns its final report (child transcripts never enter this conversation). " +
      "role: a roster role — builtins general-purpose (read-only, default), coder (full tools), fork (shares THIS conversation — warm-cache), manager (dispatch/aggregation), adversarial-reviewer (attack the change), consultant (high-effort advisory); workspace profiles from .wudao/agents/<role>.json shadow builtins and may be frozen (no provider/model/reasoningEffort overrides) or worktree-isolated. " +
      "background: true spawns through the registry and returns an id bg-N immediately — collect with agent_await({ids,mode}), inspect with agent_status, stop with agent_cancel. " +
      'session: "new" (fresh child session), "resume:<id>" (continue a prior child session), or "fork:<id>" — reusable across calls. ' +
      "images: attachment ids of THIS conversation's images to attach to an isolated child's first message (at most 9, unknown ids fail; a receipt line lists the parent's unattached image ids when any exist). " +
      "reportSchema: a JSON schema subset the background worker's final report must satisfy. " +
      "taskWriteScope: narrow a scoped role's writable paths for THIS dispatch (never widens); out-of-scope writes fail closed. " +
      "timeoutMs: wall-clock cap for a BACKGROUND child (clamped to [30s, 1h]; default 30m) — on expiry the child is aborted with an aborted result naming the timeout, so a hung worker never pins a registry slot. " +
      "maxTurns: explicit turn budget (wins over the adaptive suggestion); resumeFrom: a settled task's callId (t-N) — continue its child session instead of starting fresh.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "A short (3-5 word) description of the task." },
        prompt: { type: "string", description: "The full prompt for the sub-agent." },
        images: {
          type: "array",
          items: { type: "string" },
          description: "Attachment ids of parent-conversation images to attach to this child's first message (isolated children only, at most 9; ids must name images in this conversation's history).",
        },
        role: { type: "string", description: "Roster role (workspace profile or builtin). Overrides subagent_type." },
        subagent_type: { type: "string", description: "Legacy role name ('general-purpose' | 'coder' | 'fork')." },
        shareContext: { type: "boolean", description: "true → fork mode: the child shares this conversation's context/tools." },
        background: { type: "boolean", description: "true → spawn in the background; returns bg-N immediately." },
        session: { type: "string", description: 'Child session: "new" | "resume:<id>" | "fork:<id>" (or JSON {"mode","id"}).' },
        provider: { type: "string", description: "Override the child's provider (rejected for frozen roles)." },
        model: { type: "string", description: "Override the child's model (rejected for frozen roles)." },
        reasoningEffort: { type: "string", description: "Override the child's reasoning effort (rejected for frozen roles)." },
        reportSchema: { type: "string", description: 'JSON schema subset for the worker report, e.g. {"type":"object","required":["ok"],"properties":{}}.' },
        taskWriteScope: {
          type: "string",
          description: 'Narrow this task\'s write scope as JSON: {"roots":["src/lib/"],"exactFiles":["pkg.json"]} (workspace-relative). Can only shrink the role\'s declared writeScope — wider fails closed.',
        },
        maxTurns: { type: "number", description: "Explicit turn budget for THIS child (always wins over the adaptive suggestion)." },
        timeoutMs: {
          type: "number",
          description: "Wall-clock cap in ms for a BACKGROUND child (30_000–3_600_000; default 30m). On expiry the child aborts with a result naming the timeout — a hung worker never pins a registry slot. Ignored for foreground (awaited) children.",
        },
        suggestBudget: { type: "boolean", description: "false → skip the adaptive budget suggestion for this dispatch (default true)." },
        resumeFrom: { type: "string", description: "Call id (t-N) of a SETTLED prior task that ran with a child session: spawn this child resuming that transcript (explore→implement→verify without re-reading)." },
        teammate: { type: "string", description: "Name for a TEAMMATE spawn (M64-C): a named long-lived teammate over `role` — it gets the role's tools/model, a mailbox, and send_message; reports back when its brief completes." },
      },
      required: ["description", "prompt"],
      additionalProperties: false,
    },
    async execute(args) {
      try {
        return await executeTask(args, {
          ...options,
          // M63-C §3: the subagent-position compiler — a role's hooks node
          // compiles through the SAME bridge (workspace-rooted).
          compileRoleHooks: (role) => {
            if (role.hooks === undefined) return undefined;
            try {
              return buildConfiguredHooks(role.hooks as never, {
                workspaceRoot: options.workspaceRoot,
                ...(options.hookRuntime?.getMode !== undefined ? { getMode: options.hookRuntime.getMode } : {}),
                ...(options.hookRuntime?.common !== undefined ? { common: options.hookRuntime.common } : {}),
                ...(options.hookRuntime?.mcp !== undefined ? { mcp: options.hookRuntime.mcp } : {}),
                ...(options.hookRuntime?.rewake !== undefined ? { rewake: options.hookRuntime.rewake } : {}),
              });
            } catch {
              return undefined;
            }
          },
          // M63-B: derive the SubagentStart/Stop faces from the session's
          // hook object (both child paths consume ctx.subagentHooks).
          ...(options.hooks !== undefined
            ? {
                subagentHooks: {
                  onStart: (t: string, i: { sessionId?: string }) => options.hooks!.onSubagentStart?.(t, i),
                  onStop: (t: string, st: import("@wudao/core").AgentState) => options.hooks!.onSubagentStop?.(t, st) ?? ("allow" as const),
                } as NonNullable<Parameters<typeof executeTask>[1]["subagentHooks"]>,
              }
            : {}),
          roster,
          ...(options.teams !== undefined ? { teams: options.teams } : {}),
          ...(options.childMail !== undefined ? { childMail: options.childMail } : {}),
          statsPath: options.statsPath ?? defaultStatsPath(options.workspaceRoot),
          hasNudged: () => nudged,
          markNudged: () => (nudged = true),
          nextCallId: () => {
            callCounter += 1;
            return `t-${callCounter}`;
          },
          recordDispatch: (callId, info) => void dispatches.set(callId, info),
          getDispatch: (callId) => dispatches.get(callId),
          settleDispatch: (callId) => {
            const d = dispatches.get(callId);
            if (d !== undefined) d.settled = true;
          },
        });
      } catch (err) {
        return { content: `task failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
    // ω99-23 T1 — honest risk annotations for the DISPATCH call itself.
    // isDestructive:false — dispatching a child is a metadata operation
    // (roster lookup + spawn bookkeeping); the child's own tool calls each
    // pass the SAME createPermissionGate instance (M45: "the REPL's
    // buildTools gate — which is ALSO the gate the task tool's children
    // inherit"), so the downstream effects are already classified per child
    // call. The unannotated fail-closed default fed the sidecar classifier
    // {destructive:true, open_world:true} — a FALSE fact about this call,
    // which the classifier then obeyed (ω99-20B dogfood: 3/4 task fan-outs
    // denied). isOpenWorld:true stays honest — a child can reach the network
    // through its own gated calls. isReadOnly keeps buildTool's fail-closed
    // () => false default: the dispatch never claims read-class and stays in
    // the sidecar's audit scope.
    isDestructive: () => false,
    isOpenWorld: () => true,
  });
  // ω99-23 T2 — `isChildGated` rides the tool object as an intersection:
  // core's Tool interface (annotation-stable) does not declare it, but the
  // sidecar's toolMetaResolverFor returns the tool itself as the
  // SidecarToolMeta slice (permission.ts), which reads this field at call
  // time to emit the classifier-input `child_gated` dispatch-semantics flag.
  const annotated: Tool & { readonly isChildGated: () => boolean } = { ...built, isChildGated: () => true };
  return annotated;
}

/** Pure-ish core (exported for tests): computes the spawn plan and runs it. */
export async function executeTask(
  args: Record<string, unknown>,
  ctx: {
    readonly model: ModelClient;
    readonly allTools: readonly Tool[];
    readonly registry: import("./core-bind.js").AgentRegistry;
    readonly workspaceRoot: string;
    readonly runId: string;
    readonly loopOptions?: Omit<LoopOptions, "canUseTool">;
    readonly canUseTool?: LoopOptions["canUseTool"];
    readonly onSubagentEvent?: (event: LoopEvent) => void;
    readonly onSubagentUsage?: AgentsTaskToolOptions["onSubagentUsage"];
    readonly getForkContext?: () => ForkContext | undefined;
    readonly pilotProbe?: () => boolean;
    /** M63-C §3: compile a role profile's hooks node into child-run hooks
     *  (the subagent position). Undefined for roles without hooks. */
    readonly compileRoleHooks?: (role: { readonly hooks?: Readonly<Record<string, readonly unknown[]>> }) => import("@wudao/core").AgentHooks | undefined;
    /** M63-B: the SubagentStart/Stop faces — derived from the session's
     *  AgentHooks at the execute seam (children stay otherwise hookless). */
    readonly subagentHooks?: {
      readonly onStart?: (agentType: string, info: { readonly sessionId?: string }) => void | Promise<void>;
      readonly onStop?: (agentType: string, state: import("@wudao/core").AgentState) => import("@wudao/core").SubagentStopDecision | Promise<import("@wudao/core").SubagentStopDecision>;
    };
    readonly resolveModel?: AgentsTaskToolOptions["resolveModel"];
    readonly defaultEffort?: string;
    /** ω99-86: the parent's live-effort getter (see AgentsTaskToolOptions). */
    readonly effortLive?: AgentsTaskToolOptions["effortLive"];
    readonly childToolsFor?: AgentsTaskToolOptions["childToolsFor"];
    readonly sandboxedRunCommand?: boolean;
    readonly onNotice?: (text: string) => void;
    readonly statsPath: string;
    readonly roster: () => Promise<import("./core-bind.js").LoadedRoster>;
    readonly hasNudged: () => boolean;
    readonly markNudged: () => void;
    /** M31 §3: allocate the next stable t-N id and track the dispatch. */
    readonly nextCallId: () => string;
    readonly recordDispatch: (callId: string, info: { bgId?: string; sessionId?: string; settled: boolean }) => void;
    readonly getDispatch: (callId: string) => { bgId?: string; sessionId?: string; settled: boolean } | undefined;
    readonly settleDispatch: (callId: string) => void;
    /** M64-C §C: the session's team runtime seam (teammate spawns). */
    readonly teams?: AgentsTaskToolOptions["teams"];
    /** ω99-57: the parent-side child-mail lane (absent → no mail anywhere). */
    readonly childMail?: ChildMailLane;
  },
): Promise<{ content: string; isError?: boolean }> {
  const prompt = typeof args.prompt === "string" ? args.prompt : "";
  const description = typeof args.description === "string" ? args.description : "subagent task";
  if (prompt.trim() === "") return { content: "task failed: prompt must be a non-empty string", isError: true };

  // M80 (direction b): the explicit image hand-off — shape-checked fail-closed
  // before any work; id→ref resolution runs below (it needs the parent view
  // and the resolved role).
  const imagesArg = parseImageIdsArg(args.images);
  if (!imagesArg.ok) return { content: `task failed: ${imagesArg.error}`, isError: true };
  const imageIds = imagesArg.ids;

  // M64-C §C: a NAMED subagent is a teammate — routed to the session's team
  // runtime before anything else (no child-session machinery applies; the
  // teammate owns its own sidechain + mailbox + plan flow).
  if (typeof args.teammate === "string" && args.teammate.trim() !== "") {
    if (imageIds.length > 0) {
      return { content: "task failed: images are not supported for teammate spawns — brief the teammate in text (it does not see this conversation's images)", isError: true };
    }
    const teams = ctx.teams;
    if (teams === undefined) {
      return { content: "task failed: teammates need the session's team runtime, which this context does not provide", isError: true };
    }
    const r = await teams.getTeam().spawnTeammate({
      name: args.teammate.trim(),
      role: typeof args.role === "string" && args.role.trim() !== "" ? args.role.trim() : "general-purpose",
      prompt,
    });
    return r.ok ? { content: r.line } : { content: `task failed: ${r.line}`, isError: true };
  }

  const background = args.background === true;
  // 波次8 #47 (OH#6): the background child's wall-clock cap — clamped into
  // the kernel-policy range (model-facing knobs never trust raw input).
  // Foreground children are awaited by the parent's own run (interrupt +
  // maxTurns govern them); the registry default still bounds them via
  // createSessionRegistry's defaultTimeoutMs — but only background spawns
  // accept an explicit override.
  const timeoutMs = background && typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
    ? Math.max(KERNEL_POLICY.agentTimeout.minMs, Math.min(KERNEL_POLICY.agentTimeout.maxMs, Math.round(args.timeoutMs)))
    : undefined;
  const shareContext = args.shareContext === true;
  const roleArg = typeof args.role === "string" && args.role.trim() !== "" ? args.role.trim() : undefined;
  const legacyType = typeof args.subagent_type === "string" && args.subagent_type.trim() !== "" ? args.subagent_type.trim() : undefined;
  const roleName = roleArg ?? legacyType ?? "general-purpose";

  // Session param (spec §C): parsed fail-closed before anything spawns. The
  // store rides along at dispatch — sidechains live in the parent's session
  // root, not in a worktree child's tree.
  let session: ChildSessionOptions | undefined;
  if (args.session !== undefined) {
    const parsed = parseSessionParam(args.session);
    if (!parsed.ok) return { content: `task failed: ${parsed.error}`, isError: true };
    session = { ...parsed.session, store: createJsonlSessionStore(join(ctx.workspaceRoot, ".wudao", "sessions")) };
  }

  // M31 §3: resumeFrom — sugar over session resume. The source must be a
  // SETTLED dispatch that ran with a child session; the new child continues
  // that transcript (explore→implement→verify without re-reading the repo).
  let parentCallId: string | undefined;
  if (args.resumeFrom !== undefined) {
    const sourceId = typeof args.resumeFrom === "string" ? args.resumeFrom.trim() : "";
    if (sourceId === "") return { content: "task failed: resumeFrom must be a task call id (t-N)", isError: true };
    if (session !== undefined) {
      return { content: "task failed: resumeFrom and session are mutually exclusive — resumeFrom IS the session parameter (resume:<source>)", isError: true };
    }
    const source = ctx.getDispatch(sourceId);
    if (source === undefined) {
      return { content: `task failed: unknown task call id "${sourceId}" (resumeFrom refers to a prior task's callId, e.g. the t-1 in its receipt)`, isError: true };
    }
    if (!source.settled) {
      return { content: `task failed: task ${sourceId} is still in flight — await it (agent_await) before resuming from it`, isError: true };
    }
    if (source.sessionId === undefined) {
      return { content: `task failed: task ${sourceId} ran without a child session — there is no transcript to resume (dispatch it with session:"new" first)`, isError: true };
    }
    session = { mode: "resume", id: source.sessionId, store: createJsonlSessionStore(join(ctx.workspaceRoot, ".wudao", "sessions")) };
    parentCallId = sourceId;
  }

  // A fresh child session gets its id HERE (not inside runSubagent) so the
  // dispatch table can offer it to a later resumeFrom. ω99-54: the core v7
  // factory — a BARE id (the store's sidechain faces add the `side-` prefix
  // themselves; the domain-separation law is untouched).
  if (session?.mode === "new" && session.id === undefined) session = { ...session, id: newSessionId() };

  // ω99-43: the durable-approvals face over the child's OWN sidechain —
  // built here (id resolved, store in hand) and carried inside the
  // decorated gate's AskContext. "new" starts an empty index; "resume"
  // loads the receipts the previous process's human already gave (the
  // continuity this arc exists for). A session-fork deliberately stays
  // receipt-free v1: its writes belong to a NEW sidechain, so a fresh ask
  // is the honest behavior (and "no receipts" is exactly today's). A
  // sessionless child (fork/shareContext/no session param) has no chain to
  // ride — undefined face, byte-identical ask path.
  let childApprovals: ChildApprovalFace | undefined;
  if (session !== undefined && session.id !== undefined && session.mode !== "fork") {
    try {
      childApprovals = await buildChildApprovals(session.store, session.id);
    } catch {
      childApprovals = undefined; // unreadable chain → ask fresh (never fatal)
    }
  }

  // M31 §2: explicit maxTurns (fail-closed on junk) + the feature switches.
  // featureOn = the env switch (off disables suggestions, receipts, AND
  // recording); adaptive = per-dispatch suggestion use (suggestBudget:false
  // still runs budgeted, sampled, and receipted — just not adaptively).
  let explicitMaxTurns: number | undefined;
  if (args.maxTurns !== undefined) {
    if (typeof args.maxTurns !== "number" || !Number.isInteger(args.maxTurns) || args.maxTurns < 1) {
      return { content: "task failed: maxTurns must be a positive integer", isError: true };
    }
    explicitMaxTurns = args.maxTurns;
  }
  const featureOn = !budgetsDisabled();
  const adaptive = featureOn && args.suggestBudget !== false;
  const budgetEnabled = featureOn;

  // M31 §1: task-level write scope — shape-checked fail-closed here; the
  // narrowing/escalation decision runs once the role is known (below).
  let taskWriteScope: WriteScopeDeclaration | undefined;
  if (args.taskWriteScope !== undefined) {
    const raw = typeof args.taskWriteScope === "string"
      ? (parseJsonObject(args.taskWriteScope) ?? args.taskWriteScope)
      : args.taskWriteScope;
    if (!isWriteScopeDeclaration(raw)) {
      return { content: 'task failed: taskWriteScope must be {roots?: string[], exactFiles?: string[]} (workspace-relative paths)', isError: true };
    }
    taskWriteScope = raw;
  }

  // Roster resolution: plugin agents and workspace profiles shadow builtins.
  const roster = await ctx.roster();
  const profile = resolveRole(roster, roleName);
  if (!profile) {
    const known = [...new Set([...BUILTIN_ROLE_NAMES, ...roster.profiles.keys()])].sort();
    return { content: `task failed: unknown role "${roleName}" (known: ${known.join(", ")})`, isError: true };
  }
  // M47 §2: language-block inheritance. When the parent conversation carries
  // the language directive, isolated children inherit it as a trailing line of
  // their brief (the child's own instruction, imperative, at the tail). Fork
  // children skip this — they replay the parent transcript, which already
  // carries the block message.
  const inheritsLanguage = !(shareContext || profile.id === "fork")
    && ctx.getForkContext !== undefined
    && transcriptHasLanguageBlock(ctx.getForkContext()?.messages ?? []);
  // 夜移 012: the reasoning-language directive inherits the exact variant the
  // parent used (zh or en), not a hardcoded one — an English-thinking parent
  // must not silently flip its children to Chinese thinking.
  const inheritedReasoningBlock = !(shareContext || profile.id === "fork")
    && ctx.getForkContext !== undefined
    ? transcriptReasoningBlock(ctx.getForkContext()?.messages ?? []) : undefined;
  // ω99-57: the child→parent mail edge for THIS dispatch.
  const mailLive = ctx.childMail !== undefined
    && ctx.allTools.some((t) => t.name === PARENT_MESSAGE_TOOL_NAME)
    && !(shareContext || profile.id === "fork");
  // ω99-60: the parent→child steer edge for THIS dispatch's OWN children —
  // the tool rides the session pool (an embedder pool without it draws
  // none: children byte-identical to pre-ω99-60) and a fork/shareContext
  // replay never re-draws (its array is the parent's, verbatim).
  const steerLive = ctx.allTools.some((t) => t.name === CHILD_MESSAGE_TOOL_NAME)
    && !(shareContext || profile.id === "fork");
  // reportSchema (spec §B): spawn-time gate via the M29 subset validator.
  // ω99-5b: parsed BEFORE the brief is assembled — the schema shapes the
  // child's world in three places: the contract line in the brief (both the
  // foreground runChild and the registry's spec.prompt share THIS assembly
  // point), the final_output finishing tool, and the finalTool extraction.
  let reportSchema: JsonSchemaSubset | undefined;
  if (args.reportSchema !== undefined) {
    const parsed = parseReportSchema(args.reportSchema);
    if (!parsed.ok) return { content: `task failed: ${parsed.error}`, isError: true };
    reportSchema = parsed.schema;
  }
  const childPrompt = [
    prompt,
    // ω99-5b §A: the deterministic report contract — byte-stable constant
    // prefix + canonical schema bytes, so tests (and prompt-cache accounting)
    // pin it exactly. Absent a schema, ZERO injection (brief stays identical).
    ...(reportSchema !== undefined
      ? [`[report contract] Your FINAL message must be a single JSON object satisfying this schema (no prose, no code fences): ${canonicalJson(reportSchema)}`]
      : []),
    // ω99-57: the dsh initial-task instruction — one guidance line on the
    // isolated child's OWN brief (its fresh prefix; forks never see it, and
    // no system-prompt or tool-schema byte moves anywhere). mailLive: the
    // session wired a lane AND the drawable pool carries the global tool AND
    // this dispatch is not a fork.
    ...(mailLive
      ? [`[mail] you may message your parent mid-task with message_parent({content}) — send a finding as soon as it changes what the parent should do next (early, not with the final report); your final report still returns as this task's result.`]
      : []),
    inheritsLanguage ? LANGUAGE_BLOCK_ZH : undefined,
    inheritedReasoningBlock,
  ].filter((part) => part !== undefined).join("\n\n");
  // M40: receipts chain per layer (builtin→plugin→workspace); the LAST one
  // names what actually owns the live slot.
  const shadowReceipt = roster.shadowed.filter((s) => s.id === profile.id).at(-1);

  // M64-B §B: the role's persistent memory. Default tier = project (unset ≠
  // "no memory"). Fork children skip it (they replay the parent prompt); the
  // injection rides the child's OWN system prompt, bounded to the first 200
  // lines/25KB with a pruned marker when truncation applies.
  let memorySection: string | undefined;
  // Fix round 1 (MEDIUM): the admitted/routed path is the ROLE'S OWN memory
  // directory (dirname of MEMORY.md) — never the tier root. A child reaches
  // exactly its own memory; sibling roles' files (same tier) stay out of
  // reach, and the user tier admits one role dir, not <globalHome>/agent-memory/**.
  let memoryDir: string | undefined;
  if (!shareContext && profile.id !== "fork") {
    const tier = effectiveMemoryTier(profile.memory);
    const paths = agentMemoryPaths(tier, profile.id, {
      workspaceRoot: ctx.workspaceRoot,
      globalHome: resolveGlobalHome(),
    });
    memoryDir = dirname(paths.file);
    // A role with no memory file yet gets its memory DIRECTORY pre-created:
    // write-back rides the ordinary write_file (no mkdir tool in most role
    // sets), so the harness owns the layout and the first note lands.
    const fileText = await readAgentMemory(paths.file);
    if (fileText === undefined) await mkdir(memoryDir, { recursive: true }).catch(() => {});
    const injection = fileText !== undefined ? buildMemoryInjection(fileText) : { body: "", truncated: false, droppedLines: 0 };
    memorySection = memoryPromptSection({
      tier: paths.tier,
      role: profile.id,
      file: paths.file,
      content: injection.body,
      truncated: injection.truncated,
      fileExists: fileText !== undefined,
      ...(fileText !== undefined && fileText.trim() === "" ? { fileEmpty: true } : {}),
    });
  }

  // The effective child role: the profile with its tool list defaulted (the
  // read-only set) and the orchestration tools stripped — nested spawning is
  // refused, not nested (fail-closed even when a workspace role lists them).
  const childRole: AgentRoleProfile = {
    ...profile,
    // ω99-5b §B: a schema'd child carries the finishing tool in its roster
    // face (isolated children draw tools BY NAME). Fork children ignore
    // toolNames — they replay the parent's byte-identical tool array.
    toolNames: [
      ...roleToolNames(profile, ORCHESTRATION_TOOL_NAMES),
      ...(reportSchema !== undefined ? [FINAL_OUTPUT_TOOL_NAME] : []),
      // ω99-57: the mail tool joins every isolated/worktree child when the
      // edge is live (fixed tail position; a pool without it draws nothing).
      ...(mailLive ? [PARENT_MESSAGE_TOOL_NAME] : []),
      // ω99-60: the steer tool joins the same way — a child with its own
      // background spawns steers them (grandchild symmetry; fixed tail
      // position, the 57 mailLive-形 gate).
      ...(steerLive ? [CHILD_MESSAGE_TOOL_NAME] : []),
    ],
    // M64-B §B: the memory section appends to the role's own prompt (the
    // child context is fresh every spawn — bounded bytes, no cache concern).
    ...(memorySection !== undefined
      ? { systemPrompt: `${profile.systemPrompt ?? ""}\n\n${memorySection}`.trim() }
      : {}),
  };
  // The parent's tool array, defensively minus the orchestration tools: the
  // child draws from THIS pool by name.
  const sessionTools = ctx.allTools.filter((t) => !ORCHESTRATION_TOOL_NAMES.includes(t.name));

  // M31 §2: the effective turn budget — explicit maxTurns wins, else the
  // adaptive suggestion (median of this role's uncensored successes, <3
  // samples → the role default), else the role default.
  const roleDefaultTurns = profile.maxTurns ?? DEFAULT_CHILD_TURNS;
  let budgetTurns = explicitMaxTurns ?? roleDefaultTurns;
  let budgetNote: string | undefined;
  if (adaptive && explicitMaxTurns === undefined) {
    const stats = await loadAgentStats(ctx.statsPath);
    const suggestion = suggestBudget(stats.roles[profile.id] ?? [], roleDefaultTurns);
    budgetTurns = suggestion.suggested;
    budgetNote = suggestion.defaulted
      ? `budget: ${suggestion.suggested} (default — ${suggestion.successSamples} usable samples)`
      : `budget: ${suggestion.suggested} (adaptive: median ${suggestion.median} of ${suggestion.successSamples} successes, ceiling ${suggestion.ceiling})`;
  } else if (explicitMaxTurns !== undefined) {
    budgetNote = `budget: ${explicitMaxTurns} (explicit)`;
  } else if (budgetEnabled) {
    budgetNote = `budget: ${budgetTurns} (default — suggestBudget off for this dispatch)`;
  }

  // M31 §3: every dispatch gets its stable t-N id (allocated after
  // validation so failed calls burn no ids — ids stay dense and referenceable).
  const callId = ctx.nextCallId();

  // ω99-86 (53 停泊债清偿): the child's effort TRAIL follows the parent's
  // live level. The box getter is read ONCE per dispatch, LATE (the driver
  // arms the box per run — the ω99-79 discipline), and guarded:
  // undefined/""/"off" never ride ("off" is the receipt's unset vocabulary,
  // not a wire value; REASONING_EFFORTS has no "off"). The surviving value
  // rides the child's loopOptions.effortSent (the same trail source the
  // parent run threads — ω99-53's persistence-only stamp, never a wire
  // field). Absent ⇒ no key ⇒ byte-identical spawns (the pre-ω99-86 default
  // for unarmed/idle boxes).
  const effortGuard = (v: string | undefined): string | undefined =>
    v !== undefined && v !== "" && v !== "off" ? v : undefined;
  const liveEffortSent = effortGuard(ctx.effortLive?.());

  // Fork mode keeps its M24 semantics verbatim (shares the parent context —
  // no worktree isolation: a fork replays the parent conversation).
  if (shareContext || profile.id === "fork") {
    if (imageIds.length > 0) {
      return {
        content: "task failed: images are not needed for fork children — a fork replays the parent's image-bearing history verbatim",
        isError: true,
      };
    }
    const forkFrom = ctx.getForkContext?.();
    if (!forkFrom) {
      return {
        content: "task failed: fork mode (shareContext / subagent_type 'fork') requires the caller to expose the parent conversation",
        isError: true,
      };
    }
    ctx.recordDispatch(callId, { settled: true }); // shares the parent context — no child transcript to resume
    const answer = await runChild(ctx, {
      childRole,
      prompt: childPrompt, // fork: identical to `prompt` (no inheritance — the replay carries the block)
      forkFrom,
      session,
      notes: [`callId: ${callId}`],
      allTools: sessionTools,
      ...(budgetEnabled || explicitMaxTurns !== undefined ? { budgetTurns } : {}),
      // ω99-86: the fork child's trail follows the parent's live effort too
      // (its requests replay the parent's own config — the fork path never
      // reaches the override resolver, so the live value is the whole rule).
      ...(liveEffortSent !== undefined ? { effortSent: liveEffortSent } : {}),
    });
    return { content: answer };
  }

  // M80 (direction b + c): resolve the named attachment ids against the
  // PARENT conversation (images ride user turns and tool results; assistant
  // history never carries them). Fail-closed: an id absent from the parent
  // history — or a session with no parent view at all — refuses the spawn
  // (never a silent image drop). Direction c: when the parent history has
  // images this dispatch did NOT attach, one deterministic meta line names
  // the ids so the parent can hand them off on a re-dispatch.
  let promptImages: readonly ImageBlock[] | undefined;
  let unattachedImagesNote: string | undefined;
  {
    const parentMessages = ctx.getForkContext?.()?.messages;
    const historyImages: ImageBlock[] = [];
    for (const m of parentMessages ?? []) {
      if (m.role === "assistant") continue;
      if (m.images !== undefined && m.images.length > 0) historyImages.push(...m.images);
    }
    if (imageIds.length > 0) {
      if (parentMessages === undefined) {
        return {
          content: "task failed: images need the parent conversation — this context exposes no conversation view to resolve attachment ids against",
          isError: true,
        };
      }
      const byId = new Map(historyImages.map((b) => [b.ref.attachmentId, b]));
      const refs: ImageBlock[] = [];
      for (const id of imageIds) {
        const block = byId.get(id);
        if (block === undefined) {
          return {
            content: `task failed: unknown attachment id "${id}" — ids must name images in this conversation's history (see the receipt's unattached-images line for the available ids)`,
            isError: true,
          };
        }
        refs.push(block);
      }
      promptImages = refs;
    }
    if (promptImages !== undefined && session !== undefined && (session.mode === "resume" || session.mode === "fork")) {
      return {
        content: "task failed: images attach to a fresh child's first message — they cannot ride a resume/fork child session (its transcript replays as-is)",
        isError: true,
      };
    }
    const attached = new Set(imageIds);
    const unattached = historyImages.filter((b) => !attached.has(b.ref.attachmentId));
    if (unattached.length > 0) {
      const ids = [...new Set(unattached.map((b) => b.ref.attachmentId))].sort();
      unattachedImagesNote = `parent history has ${unattached.length} unattached image${unattached.length === 1 ? "" : "s"}: ${ids.join(", ")} (pass images:[...] to share)`;
    }
  }

  // Frozen roles (spec §A): caller overrides of provider/model/effort fail closed.
  const callerOverrides: ModelOverrides = {
    ...(typeof args.provider === "string" && args.provider.trim() !== "" ? { provider: args.provider.trim() } : {}),
    ...(typeof args.model === "string" && args.model.trim() !== "" ? { model: args.model.trim() } : {}),
    ...(typeof args.reasoningEffort === "string" && args.reasoningEffort.trim() !== "" ? { reasoningEffort: args.reasoningEffort.trim() } : {}),
  };
  if (profile.frozen === true && (callerOverrides.provider !== undefined || callerOverrides.model !== undefined || callerOverrides.reasoningEffort !== undefined)) {
    const given = [callerOverrides.provider && "provider", callerOverrides.model && "model", callerOverrides.reasoningEffort && "reasoningEffort"].filter(Boolean).join("/");
    return {
      content: `task failed: role "${profile.id}" is frozen — ${given} overrides are not allowed (the role pins its own provider/model/effort)`,
      isError: true,
    };
  }

  // Model + reasoning receipt (ω99-91): requested = caller > role pin >
  // armed live session default > boot baseline — the third tier reads the
  // armed run's LIVE level (liveEffortSent, already guarded above), because
  // post-ω99-86 the armed session's actual default IS that live level (the
  // declaration now tells the truth the effective face has told since 88).
  // Declaration semantics HOLD (the ω99-90 ruling): a pin without a resolver
  // still only feeds the declaration, never burns — this arc changes ONLY the
  // fallback tier. Guarded-out states (un-armed / armed-unset / "off") yield
  // undefined ⇒ byte-identical boot fallback.
  // effective (ω99-88) = what the child ModelClient actually carries, in the
  // post-ω99-86 three-state truth: a burned override's value (the resolver
  // pinned the child's config), else the armed run's live level (the shared
  // client's liveConfig — the same value the spawn's trail records), else the
  // session's boot baseline. Idle spawns (un-armed box) still report boot —
  // the liveConfig's idle value stays parked (86 concern ② family, not this
  // arc); an armed-unset getter (the session never set a level) falls back to
  // boot because the boot value IS what the child carries in that state.
  const wants: ModelOverrides = {
    provider: callerOverrides.provider ?? profile.provider,
    model: callerOverrides.model ?? profile.model,
    reasoningEffort: callerOverrides.reasoningEffort ?? profile.reasoningEffort,
  };
  const requested = wants.reasoningEffort ?? liveEffortSent ?? ctx.defaultEffort ?? "off";
  let childModel = ctx.model;
  let effective = ctx.defaultEffort ?? "off";
  // ω99-86: true when the resolver burned an override into the child's
  // config (see the effortToSend block below).
  let overrideBurned = false;
  const notes: string[] = [];
  const overrideKeys = (Object.keys(wants) as (keyof ModelOverrides)[]).filter((k) => wants[k] !== undefined);
  if (overrideKeys.length > 0) {
    if (!ctx.resolveModel) {
      if (callerOverrides.provider !== undefined || callerOverrides.model !== undefined || callerOverrides.reasoningEffort !== undefined) {
        return { content: "task failed: provider/model/reasoningEffort overrides need a model resolver, which this context does not provide", isError: true };
      }
      notes.push(`model: role pin (${overrideKeys.map((k) => `${k}=${String(wants[k])}`).join(", ")}) not applied in this context — the child ran on the session model`);
    } else {
      const resolved = ctx.resolveModel(wants);
      if (!resolved.ok) return { content: `task failed: model override rejected: ${resolved.error}`, isError: true };
      childModel = resolved.model;
      effective = resolved.effectiveEffort;
      overrideBurned = true;
    }
  }
  // ω99-86: OVERRIDE spawns (the resolver burned a role pin / caller override
  // into the child's config, overrideBurned above) YIELD to the burned value
  // — the trail records what the child's requests actually run at, never the
  // parent's live level.
  const effortToSend = overrideBurned ? effortGuard(effective) : liveEffortSent;
  // ω99-88: the receipt's effective follows the lane the spawn actually runs
  // at — the same three-state ToSend closes it: the burned override's value,
  // else the armed run's live level, else (guard-out / un-armed /
  // armed-unset) the boot baseline via the ?? fallback. requested untouched.
  const receipt = { requested, effective: effortToSend ?? effective };

  // Worktree isolation (spec §D): worktree roles run in
  // `.wudao/wt/<runId>/<role>-<n>` and their tool set is re-rooted there.
  // Fail-open: no git repo (or a git failure) degrades to the main workspace
  // with a note — isolation is an optimization, not a precondition.
  let childTools: readonly Tool[] = sessionTools;
  let inWorktree = false;
  if (profile.worktree === true) {
    const wt = await createChildWorktree(ctx.workspaceRoot, ctx.runId, profile.id, { onWarning: () => {} });
    if (wt) {
      childTools = (ctx.childToolsFor ?? defaultChildToolsFor)(wt.path);
      inWorktree = true;
      notes.push(`worktree: child isolated at ${wt.path} (branch ${wt.branch})`);
    } else {
      notes.push(`worktree: role requests git-worktree isolation but the workspace is not a git repo (or git failed) — the child ran in the main workspace`);
    }
  }

  // M31 §1: the effective write scope (role declaration narrowed by the
  // task's, never widened) and the fail-closed guard on the child's
  // write-semantics tools. Worktree children are exempt (their writes land
  // in their own tree); fork children never reach here — the parent's tool
  // array is shared byte-identical, which is the fork's whole purpose.
  let effectiveWriteScope: WriteScopeDeclaration | undefined;
  {
    const declared = profile.writeScope;
    if (declared !== undefined && taskWriteScope === undefined) {
      effectiveWriteScope = declared;
    } else if (declared === undefined && taskWriteScope !== undefined) {
      // Ad-hoc narrowing of an unrestricted role: everything ⊇ the task scope.
      effectiveWriteScope = taskWriteScope;
    } else if (declared !== undefined && taskWriteScope !== undefined) {
      const narrowed = narrowWriteScope(declared, taskWriteScope);
      if (!narrowed.ok) return { content: `task failed: ${narrowed.error}`, isError: true };
      effectiveWriteScope = narrowed.scope;
    }
    if (effectiveWriteScope !== undefined) {
      if (!inWorktree) {
        childTools = applyWriteScopeGuard(childTools, {
          workspaceRoot: ctx.workspaceRoot,
          scope: effectiveWriteScope,
          allowShell: profile.allowShell === true || ctx.sandboxedRunCommand === true,
          // M64-B §B + fix round 1: the role's OWN memory dir rides ABOVE the
          // declared scope — one directory, not the whole tier tree.
          ...(memoryDir !== undefined ? { alwaysAllowAbs: [memoryDir] } : {}),
        });
      }
      notes.push(`write-scope: ${formatWriteScope(effectiveWriteScope)}${inWorktree ? " (worktree child — guard off, writes land in its own tree)" : ""}`);
    }
  }

  // M64-B §B + fix round 1: memory-file admission on the child's tools. The
  // routing wrapper admits ONLY the role's own memory dir, and routes to
  // memory-rooted instances ONLY for out-of-workspace targets (the user
  // tier) or worktree children — in-workspace memory writes keep the SESSION
  // tools, so the staleness gate / rewind snapshots / write-verify all stay
  // in the loop. Order: routing OUTSIDE the guard — memory calls never fight
  // the scope at all.
  if (memoryDir !== undefined) {
    childTools = applyMemoryFileRouting(childTools, {
      workspaceRoot: ctx.workspaceRoot,
      memoryDir,
      ...(inWorktree ? { routeInWorkspace: true } : {}),
    });
  }

  // ω99-5b §B: the finishing tool joins the child's tool set AFTER the guards
  // (it is pure — nothing to scope or route). Only isolated/worktree children
  // reach here; forks replay the parent's tool array byte-identically and get
  // the contract line in their brief instead.
  if (reportSchema !== undefined) {
    childTools = [...childTools, createFinalOutputTool(reportSchema)];
  }

  const meta = [
    `task meta: role=${profile.id} reasoning.requested=${receipt.requested} reasoning.effective=${receipt.effective}`,
    ...(shadowReceipt
      ? [
          shadowReceipt.by.startsWith(".wudao/agents/")
            ? `roster: workspace profile "${profile.id}" shadows the builtin role`
            : `roster: ${shadowReceipt.by} shadows the builtin role "${profile.id}"`,
        ]
      : []),
    ...notes,
    `callId: ${callId}`,
    ...(parentCallId !== undefined ? [`resumes: ${parentCallId} (child session ${session?.id ?? "?"})`] : []),
    ...(budgetNote !== undefined ? [budgetNote] : []),
    ...(unattachedImagesNote !== undefined ? [unattachedImagesNote] : []),
  ];

  if (!background) {
    ctx.recordDispatch(callId, { sessionId: session?.id, settled: false });
    let runInfo: { turns: number; budgetLimited: boolean } | undefined;
    const answer = await runChild(ctx, {
      childRole,
      prompt: childPrompt,
      forkFrom: undefined,
      session,
      notes: meta,
      // ω99-43: the receipt face (undefined for sessionless dispatches).
      ...(childApprovals !== undefined ? { childApprovals } : {}),
      model: childModel,
      allTools: childTools,
      budgetTurns,
      // ω99-86: the guarded live effort (background twin above).
      ...(effortToSend !== undefined ? { effortSent: effortToSend } : {}),
      // ω99-5b §B: the foreground schema'd child names its finishing tool —
      // a captured final_output tool_use becomes the canonical-JSON report
      // (the parent gets structured output, not prose).
      ...(reportSchema !== undefined ? { finalTool: FINAL_OUTPUT_TOOL_NAME } : {}),
      // M80: the explicit image hand-off rides the child's first message.
      ...(promptImages !== undefined ? { promptImages } : {}),
      onResult: (info) => { runInfo = info; },
    });
    ctx.settleDispatch(callId);
    if (budgetEnabled && runInfo !== undefined) {
      const sample: AgentBudgetSample = { turns: runInfo.turns, ok: true, budgetLimited: runInfo.budgetLimited };
      void recordAgentSample(ctx.statsPath, profile.id, sample).catch(() => {});
    }
    return { content: answer };
  }

  // Background: spawn through the registry and return immediately. The
  // registry owns the child's lifecycle — it calls runSubagent itself.
  let spawned: ReturnType<import("./core-bind.js").AgentRegistry["spawn"]>;
  try {
    spawned = ctx.registry.spawn({
      model: childModel,
      allTools: childTools,
      role: childRole,
      prompt: childPrompt,
      // M80: the explicit image hand-off (threaded to the child's first
      // message by the registry's runSubagent call).
      ...(promptImages !== undefined ? { promptImages } : {}),
      // M63-B: the SubagentStart/Stop faces (background children — the
      // registry threads them to its own runSubagent call).
      ...(ctx.subagentHooks !== undefined ? { subagentHooks: ctx.subagentHooks } : {}),
      // ω99-57: the mail edge rides background children (registry →
      // runSubagent threading).
      ...(ctx.childMail !== undefined ? { parentMail: laneAsParentMail(ctx.childMail) } : {}),
      // M63-C §3: the subagent position (background children too).
      ...(ctx.compileRoleHooks !== undefined && childRole.hooks !== undefined
        ? { runHooks: ctx.compileRoleHooks(childRole) ?? undefined }
        : {}),
      ...(session !== undefined ? { session } : {}),
      ...(reportSchema !== undefined ? { reportSchema } : {}),
      reasoningEffort: receipt.requested,
      effectiveReasoningEffort: receipt.effective,
      ...(effectiveWriteScope !== undefined && !isWriteScopeEmpty(effectiveWriteScope)
        ? { writeScope: effectiveWriteScope }
        : {}),
      // M31 §2/§3: dispatch budget (explicit > adaptive) + lineage ids; the
      // settle hook records the budget sample and frees resumeFrom.
      maxTurns: budgetTurns,
      suggestedBudget: budgetTurns,
      // 波次8 #47 (OH#6): the clamped wall-clock cap (absent → the registry's
      // kernel default, 30m).
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      callId,
      ...(parentCallId !== undefined ? { parentCallId } : {}),
      onSettle: (result) => {
        ctx.settleDispatch(callId);
        if (budgetEnabled && result.turns !== undefined) {
          const sample: AgentBudgetSample = {
            turns: result.turns,
            ok: result.ok,
            budgetLimited: result.budgetLimited === true,
          };
          void recordAgentSample(ctx.statsPath, profile.id, sample).catch(() => {});
        }
      },
      // ω99-86: the guarded live effort rides the spawn's loopOptions — the
      // whole-object pass becomes a spread + conditional key (absent ToSend ⇒
      // the same key set as before, byte-identical spec).
      ...(ctx.loopOptions !== undefined || effortToSend !== undefined
        ? { loopOptions: { ...ctx.loopOptions, ...(effortToSend !== undefined ? { effortSent: effortToSend } : {}) } }
        : {}),
      // ω-4e: the background child's gate carries its asker context — every
      // ask it fires labels WHO asks (role + brief head) and the latest
      // genuine user instructions from the root conversation; the decision
      // itself passes through verbatim. ω99-43: session'd children also
      // carry their approval-receipt face (replay + fail-closed commit).
      ...(ctx.canUseTool !== undefined
        ? { canUseTool: decorateChildGate(ctx.canUseTool, { kind: "child", role: profile.id, brief: childPrompt }, () => ctx.getForkContext?.()?.messages, childApprovals) }
        : {}),
      // ω99-8: with a recorder wired, the registry's onEvent thread carries
      // the cost observer (usage recorded first, isolated, then forwarded);
      // without one this stays the plain passthrough of the pre-ω99-8 path.
      ...(ctx.onSubagentUsage !== undefined
        ? { onEvent: subagentEventWithUsage(ctx.onSubagentEvent, ctx.onSubagentUsage, childModel) }
        : ctx.onSubagentEvent !== undefined ? { onEvent: ctx.onSubagentEvent } : {}),
    });
  } catch (err) {
    return { content: `task failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
  ctx.recordDispatch(callId, { bgId: spawned.id, sessionId: session?.id, settled: false });

  const firstHand = ctx.pilotProbe?.();
  const nudge = firstHand === false && !ctx.hasNudged() ? (ctx.markNudged(), PILOT_NUDGE) : undefined;
  // M31 §1: overlap warnings computed by the registry at spawn — on the
  // receipt for the model, and through the notice channel for the human.
  for (const warning of spawned.warnings) ctx.onNotice?.(warning);
  const payload = {
    id: spawned.id,
    callId,
    role: profile.id,
    state: stateWord(ctx.registry.status(spawned.id)?.status),
    reasoning: receipt,
    ...(reportSchema !== undefined ? { reportSchema: "attached" } : {}),
    ...(effectiveWriteScope !== undefined ? { writeScope: formatWriteScope(effectiveWriteScope) } : {}),
    ...(budgetEnabled ? { budget: { suggested: budgetTurns } } : {}),
    // 波次8 #47 (OH#6): the effective wall-clock cap — explicit or kernel
    // default, so the model knows the bound its worker runs under.
    timeoutMs: timeoutMs ?? KERNEL_POLICY.registry.backgroundTimeoutMs,
    ...(parentCallId !== undefined ? { resumes: parentCallId } : {}),
    ...(session !== undefined ? { session: { mode: session.mode, ...(session.id !== undefined ? { id: session.id } : {}) } } : {}),
  };
  const lines = [
    ...(nudge !== undefined ? [nudge] : []),
    `background spawned: ${JSON.stringify(payload)}`,
    ...(unattachedImagesNote !== undefined ? [unattachedImagesNote] : []),
    ...(parentCallId !== undefined ? [`resumes: ${parentCallId} (child session ${session?.id ?? "?"}) — the source transcript continues, do not repeat its work`] : []),
    ...(effectiveWriteScope !== undefined ? [`write-scope: ${formatWriteScope(effectiveWriteScope)}${inWorktree ? " (worktree child — guard off, writes land in its own tree)" : ""}`] : []),
    ...spawned.warnings.map((w) => `⚠ ${w}`),
    `collect with agent_await({ids:["${spawned.id}"], mode:"all"}) — status via agent_status, stop via agent_cancel`,
  ];
  return { content: lines.join("\n") };
}
