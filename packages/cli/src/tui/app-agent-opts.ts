// 拆分运动弧 C：从 app.tsx 原样外提的 useAgent opts 构造器（buildAgentOptions）——
// 纯对象装配（零 hook）；函数体与原内联字面量逐字节同源（头部一次性解构注入
// 局部名，props 整体随依赖传入）。
import { maxTurns, VERSION } from "../version.js";
import { modelLabel, summarizeToolCall } from "../log.js";
import type { AgentHooks, AgentMessage, AgentState, IdentifiedOutputDelta } from "@wudao-org/core";
import type { KeyPool } from "@wudao-org/providers";
import type { MutableProviderConfig } from "../commands/model.js";
import type { Mode } from "../permission.js";
import type { CostRegistry } from "../commands/cost.js";
import type { DriverPersonaContext } from "../driver/agent-driver.js";
import { createMemoryRuntime } from "../memory/index.js";
// 125 项 1（dsh resolveCompactSpec 形）：预留感知触发线的装配缝 + 缺省锚。
import { compactionThresholdFields, DEFAULT_COMPACTION_SETTINGS } from "../misc-config.js";
import type { WudaoAppProps } from "./app-props.js";
import type { UseAgentOptions } from "./use-agent.js";

/** buildAgentOptions' explicit dependency slice: the App's locals the literal
 *  reads (props rides whole — its ~20 fields stay untouched inside). */
export interface AgentOptsDeps {
  readonly props: WudaoAppProps;
  readonly model: UseAgentOptions["model"];
  readonly tools: UseAgentOptions["tools"];
  readonly systemPrompt: string;
  readonly modeGate: UseAgentOptions["canUseTool"];
  readonly sessionId: string;
  readonly skills: readonly NonNullable<UseAgentOptions["skills"]>[number][];
  readonly pluginCommands: readonly NonNullable<UseAgentOptions["pluginCommands"]>[number][];
  readonly pluginAgents: UseAgentOptions["pluginAgents"];
  readonly fileHistory: UseAgentOptions["fileHistory"];
  readonly turnDiff: UseAgentOptions["turnDiff"];
  readonly snapshots: UseAgentOptions["snapshots"];
  readonly sessionName: string | undefined;
  readonly workspaceRoot: string;
  readonly setSessionName: (name: string | undefined) => void;
  readonly subagentUpdateBox: { current: { sink?: (delta: IdentifiedOutputDelta) => void } };
  readonly effortLiveBox: { current: { get?: () => string | undefined } };
  readonly mandatoryRepairArmedRef: { current: { current: boolean } };
  readonly softWarnSlotRef: { current: NonNullable<UseAgentOptions["softWarnSlot"]> };
  readonly loadedRef: { current: AgentMessage[] };
  readonly liveWindowTokens: number;
  readonly liveConfigRef: { current: MutableProviderConfig };
  readonly gatedRuleMatcher: UseAgentOptions["contextRules"] extends infer R ? (R extends { readonly match: infer M } ? M | undefined : never) : never;
  readonly gitProbeRef: { current: { probe(): Promise<unknown> } | null };
  readonly initialMode: { current: Mode };
  readonly agentsRegistry: UseAgentOptions["agentsRegistry"];
  readonly memoryRuntime: ReturnType<typeof createMemoryRuntime>;
  readonly liveHooks: AgentHooks | undefined;
  readonly onPermissionAsk: UseAgentOptions["onPermissionAsk"];
  readonly onUserTurn: UseAgentOptions["onUserTurn"];
  readonly onBeforeToolDispatch: UseAgentOptions["onBeforeToolDispatch"];
  readonly onRunComplete: UseAgentOptions["onRunComplete"];
  readonly onCompacted: UseAgentOptions["onCompacted"];
  readonly onCompactBoundary: UseAgentOptions["onCompactBoundary"];
  readonly onDeferLoaded: UseAgentOptions["onDeferLoaded"];
  readonly onHistoryReplaced: UseAgentOptions["onHistoryReplaced"];
  readonly onSessionCleared: UseAgentOptions["onSessionCleared"];
  readonly stateHandle: { current: { state?: AgentState } };
  readonly personaCtxRef: { current: DriverPersonaContext | null };
  readonly keyPoolRef: { current: KeyPool | null };
  readonly costRegistryRef: { current: CostRegistry | null };
  readonly liveModelMeta: { readonly provider: string | undefined; readonly model: string };
  readonly onModelSwitch: UseAgentOptions["onModelSwitch"];
  readonly onProviderSwitch: UseAgentOptions["onProviderSwitch"];
}

export function buildAgentOptions(d: AgentOptsDeps): UseAgentOptions {
  const props = d.props;
  const {
    model, tools, systemPrompt, modeGate, sessionId, skills, pluginCommands, pluginAgents,
    fileHistory, turnDiff, snapshots, sessionName, subagentUpdateBox, effortLiveBox,
    mandatoryRepairArmedRef, softWarnSlotRef, loadedRef, liveWindowTokens, liveConfigRef,
    gatedRuleMatcher, gitProbeRef, initialMode, agentsRegistry, memoryRuntime, workspaceRoot, setSessionName,
    onPermissionAsk, onUserTurn, onBeforeToolDispatch, onRunComplete, onCompacted,
    onCompactBoundary, onDeferLoaded, onHistoryReplaced, onSessionCleared, stateHandle,
    personaCtxRef, keyPoolRef, costRegistryRef, liveModelMeta, onModelSwitch,
    onProviderSwitch, liveHooks,
  } = d;
  return {
    model,
    tools,
    // ω99-82: the subagent-delta box the driver arms per run (the SAME
    // instance the tool set's task tool forwards onto — the session-engine
    // isomorph, agent-driver.ts AgentDriverOptions.subagentUpdateBox).
    subagentUpdateBox: subagentUpdateBox.current,
    // ω99-87: the live-effort box the driver arms per run (the SAME instance
    // the task tool's spawn site reads — agent-driver.ts
    // AgentDriverOptions.effortLiveBox, 86's seam via 82's injection rule).
    effortLiveBox: effortLiveBox.current,
    // ω99-83: the mandatory-reasoning repair holder (the model constructions
    // above write it via the provider callback; the driver's /status reads
    // it — agent-driver.ts AgentDriverOptions.mandatoryRepairArmed).
    mandatoryRepairArmed: mandatoryRepairArmedRef.current,
    // ω99-320: the soft-warn slot (the SAME instance the model constructions
    // above carry as onStreamIdleWarning) — the driver arms it per run.
    softWarnSlot: softWarnSlotRef.current,
    systemPrompt,
    canUseTool: modeGate,
    maxTurns: props.maxTurns ?? maxTurns(),
    gates: props.gates,
    initialMessages: loadedRef.current,
    sessionId,
    compaction: (props.compactionEnabled ?? true)
      ? {
          // §7: the LIVE window (state — follows /model and /provider
          // switches; useAgent re-pushes options every render).
          contextWindowTokens: liveWindowTokens,
          // 125 项 1（dsh resolveCompactSpec 形）：预留感知触发线 —— 平比帽
          // （ratio×window）永远在；outputReserveTokens 在场（已画像窗口语义
          // + 请求帽已知）时收紧到 min(ratio×window, window − reserve −
          // headroom)。每次 render 从 live config 重读（/model //provider 切换
          // 自然生效）。
          ...compactionThresholdFields(liveConfigRef.current, props.compactionSettings ?? DEFAULT_COMPACTION_SETTINGS),
          // ω-2b (I1-c): the live config's window semantics (a settled /model
          // provider switch counts) gate the admission clip.
          ...(liveConfigRef.current.windowMode !== undefined ? { windowMode: liveConfigRef.current.windowMode } : {}),
        }
      : undefined,
    // M62 §1: path-gated context rules — the matcher over this workspace's
    // gated rules (absent when there are none, zero cost).
    ...(gatedRuleMatcher !== undefined ? { contextRules: { match: gatedRuleMatcher } } : {}),
    hooks: liveHooks,
    ...(props.rewakeSink !== undefined ? { rewakeSink: props.rewakeSink } : {}),
    ...(props.hookRuntime !== undefined ? { hookRuntime: props.hookRuntime } : {}),
    ...(props.promptIdBox !== undefined ? { promptIdBox: props.promptIdBox } : {}),
    ...(props.sessionIdBox !== undefined ? { sessionIdBox: props.sessionIdBox } : {}),
    ...(props.hookWarnSink !== undefined ? { hookWarnSink: props.hookWarnSink } : {}),
    // P1-5: the trust-gate boot notice rides the driver's history channel.
    ...(props.bootNotices !== undefined && props.bootNotices.length > 0 ? { bootNotices: props.bootNotices } : {}),
    // M63-A: the explicit creation source ("fork"); absent → the driver
    // derives startup/resume from the seed history.
    ...(props.sessionStartSource !== undefined ? { sessionStartSource: props.sessionStartSource } : {}),
    // M63-B: the FileChanged watchers + the skills ConfigChange poll.
    ...(props.fileChangeTargets !== undefined && props.fileChangeTargets.length > 0 && liveHooks?.onFileChanged !== undefined
      ? {
          fileChangeWatch: {
            targets: props.fileChangeTargets,
            fire: (path: string) => liveHooks!.onFileChanged?.(path),
          },
        }
      : {}),
    ...(props.configSkillsPath !== undefined && liveHooks?.onConfigChange !== undefined
      ? {
          configChangeSkills: {
            path: props.configSkillsPath,
            decide: async (position: "skills", path: string) => {
              const decision = await liveHooks!.onConfigChange?.(position, { path });
              return !(typeof decision === "object" && decision.block);
            },
          },
        }
      : {}),
    summarize: summarizeToolCall,
    workspaceRoot,
    // M59 §3: /doctor web checks ride the driver as data (sync dispatch).
    ...(props.webDoctor !== undefined ? { webDoctor: props.webDoctor } : {}),
    // M64-A §A: peer deliveries ride the driver's steering lane; dispose
    // closes the inbox + unregisters.
    ...(props.peer !== undefined ? { peer: props.peer } : {}),
    onPermissionAsk,
    onUserTurn,
    onBeforeToolDispatch,
    onRunComplete,
    onCompacted,
    onCompactBoundary,
    onDeferLoaded,
    onHistoryReplaced,
    // ω99-38: the routed /clear's rotation mirror (seal + React id + wrapper).
    onSessionCleared,
    ...(props.readState ? { readState: props.readState } : {}),
    onStateReady: (state) => {
      stateHandle.current.state = state;
    },
    // M58 §C#8: turn-boundary fingerprint refresh (the eager session-start
    // probe lives in the mount effect above; see gitProbeRef).
    onEvent: (event) => {
      if (event.type === "turn_finished") void gitProbeRef.current?.probe();
    },
    // M43-A: the driver owns the runtime mode + bg counts (status channel).
    mode: initialMode.current,
    agentsRegistry,
    // M45: the sidecar's counters/breaker ride the status channel; the
    // driver resets its run state at every run start.
    ...(props.sidecar ? { sidecar: props.sidecar } : {}),
    // M43-A Task 3: the driver-executable commands' data (skill routing,
    // command listing) + the file history driving driver-level /rewind.
    // A3 review fix (MEDIUM): the LIVE overlay list — useAgent's setOptions
    // refresh on every render would otherwise clobber the driver's swapped
    // skills back to the boot props after a rescanExtensions() swap.
    skills,
    pluginCommands,
    extensionCommands: props.extensions?.commands ?? [],
    fileHistory,
    turnDiff,
    // ω99-314: the time machine's store (write-pre capture + settle index +
    // fileRevert — the driver owns all three).
    snapshots,
    // M55 §A: /status display labels + the /rename header refresh seam.
    sessionMeta: { provider: liveModelMeta.provider, model: liveModelMeta.model },
    // M55 §B7: the /model //effort switch seam — mutates the live provider
    // config (next-turn effect) and refreshes the labels above.
    onModelSwitch,
    // M63 §A: the /provider switch seam — resolve/build (client rebuild at
    // the turn boundary; see onProviderSwitch above).
    onProviderSwitch,
    // SDD 2026-08-23 persona: the /persona seam (registry + the session
    // runtime + chain/wire live views — see the construction block above).
    // Identity-stable across renders; the driver installs clearManualLayer
    // onto this object at creation.
    persona: personaCtxRef.current!,
    // M55 §B12: the plugin agent layer for the driver's /agents listing.
    pluginAgents,
    onSessionRenamed: setSessionName,
    // M49 §1: bounded auto-recall rides the run's first model call (MetaNote
    // channel — projection-only, never a persisted conversation message).
    memoryRecall: memoryRuntime.recall,
    // M49 §2: the background review fork after successful ≥3-tool-call runs
    // (through this session's registry; WUDAO_BG_REVIEW=off disables).
    backgroundReview: true,
    // M53 §3: identity meta for the statusline snapshot (single source).
    // M56: the key pool rides it (the `keys n/m` segment + /status line) and
    // the cost registry feeds /cost's $ summary.
    statusline: { model: modelLabel(liveModelMeta), sessionName, version: VERSION, keys: keyPoolRef.current! },
    costRegistry: costRegistryRef.current!,
  };
}
