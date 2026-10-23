// M60 — the shared session engine: ONE place builds a full driver session
// (model + key pool + cost registry, agent registry, read-state, file history,
// permission gate stack, tool set, persistence seams, git-status prober) over
// the AgentDriver. `wudao ui` (ui.ts) adds the WS server on top; the Slack
// interface (@wudao/slack) adds the Bolt Socket Mode relay on top. Extracted
// verbatim from ui.ts's startUiSession — the wiring comments live there; this
// file owns the two seams the frontends differ on:
//   • askRelay — the frontend-owned permission ask (the Slack Block Kit relay).
//     Present → every "ask" decision AND sidecar escalation routes through it
//     (the driver's onPermissionAsk path), with the session-allowlist rule
//     recorded exactly like the TUI's prompt handler records an `a` answer.
//     Absent → asks park as status.pendingPermission (the web frontend path).
//   • topLevelTools — tools appended to the TOP-LEVEL set after the builtins
//     (the Slack refusal ask_user; one-shot pushes its ask_user the same way).
import { join } from "node:path";
// 夜移 034 stage-2: the boot-time warn/notify fallbacks ride the stdout
// guard lane (EAGAIN-retry + serialization) — same discipline as the one-shot
// dispatch region; an injected startupNotice sink (TUI/web) still wins.
import { stdoutGuard } from "../output-guard.js";
import { createFileAttachmentStore, createFileHistory, createJsonlSessionStore, createReadStateTable, createTurnDiffTracker, sessionLeaseBoxFor, resolveOutputReserveTokens, buildContextRotationEntry } from "@wudao/core";
// ω99-314: 文件级时光机——快照仓纯层。
import { createSnapshotStore } from "../snapshots.js";
import type { AgentMessage, FileHistory, IdentifiedOutputDelta, Tool } from "@wudao/core";
// 125 项 1: the model-side rotation port box (new_context 工具 ↔ loop 的共享单槽).
import type { NewContextPortBox } from "@wudao/core";
import { createProvider, createLiveKeyPool, modelAcceptsImages, withPersona } from "@wudao/providers";
import type { ProviderConfig } from "@wudao/providers";
// SDD 2026-08-23 persona: the per-session persona runtime sunk into this
// engine's construction seams (registry three-tier load + bootstrap chain +
// withPersona wrap; the provider-switch build follows the chain).
import { loadLayeredSettings, resolveGlobalHome } from "../settings-layer.js";
// 114 取证弧：python kernel 的 idle 窗设置（node 级孪生，boot 一次读）。
import { pythonKernelSettingsFromNode, agentsSettingsFromNode, compactionSettingsFromNode, compactionThresholdFields } from "../misc-config.js";
// ω99-315: the stream idle watchdog budget (settings → ProviderOptions).
// ω99-320: the soft tier's session slot (the callback reaches the driver).
import { loadStreamSettings, streamIdleProviderOptions } from "../stream-idle-config.js";
import { createSoftWarnSlot } from "../soft-warn-tracker.js";
import { resolveLanguagePreference } from "../language.js";
// M63 §A: the /provider switch machinery (target-config derivation + the
// cold-cache receipt constants).
// M63 §C: the wizard's just-saved key resolves from the credentials file;
// WIZARD_PLACEHOLDER_KEY marks the no-key boot's placeholder config.
import { WIZARD_PLACEHOLDER_KEY } from "../credentials.js";
import { CostRegistry } from "../commands/cost.js";
import { persistAllowRule } from "../commands/permissions.js";
import { createAgentDriver } from "./agent-driver.js";
import type { AgentDriver, DriverPersonaContext } from "./agent-driver.js";
import { asMutableConfig, applyModelSelection } from "../commands/model.js";
import type { MutableProviderConfig } from "../commands/model.js";
import { createGitStatusProber } from "../git-status-note.js";
import { buildToolSet } from "../tools.js";
import { historySearchCorpus } from "../history-search.js";
import { loadLogSlimmingPortsForBoot } from "../output-config.js";
import { createMemoryRuntime, surfacePendingReview } from "../memory/index.js";
// M-Memory 弧第二半 — 长期记忆装配（工具换轨 + 首轮注入 + rescan 保尾 +
// 会话终了沉淀）。
import { createLongtermMemoryRuntime, setLongtermMemoryRuntime, withFirstRunMemoryInjection } from "../longterm-memory.js";
import { buildSystemPrompt } from "../prompt.js";
import { summarizeToolCall, modelLabel } from "../log.js";
import { createCacheTrackingModel } from "../cache.js";
// ω-5a I23: the cold-cache pre-send monitor (one per session).
import { ColdCacheMonitor, COLD_CACHE_POLICIES, coldCacheIdentity } from "../cold-cache.js";
// P0-1: the per-turn prefix-cache waste attribution monitor (pi cache-stats
// port) + the kill-switch bridge for its notice.
import { CacheWasteMonitor, formatCacheWasteNotice, CACHE_TTL_MS } from "../cache-report.js";
import { isFeatureAblated } from "../args.js";
import { modeFromArgv, recordAskRules, type Mode } from "../permission.js";
import { createProviderModelResolver, createSessionRegistry, loadRoleProfiles, BUILTIN_ROLES, AimdGate, KERNEL_POLICY } from "../agents/index.js";
// ω99-245: the role-level reasoning preflight (boot fail-fast) + its health
// line and the opt-in first-token probe.
import { preflightRoleReasoning, formatReasoningHealthLine, effortProbeEnabled, probeReasoningSupport } from "./reasoning-preflight.js";
// ω99-211: the deferred boot bookkeeping (route A) writes the SAME entries
// the index.ts boot paths record — modelStateDivergence ({} ⇒ everything
// diverges, the fresh-boot shape) + the workspace_root entry, same tick.
import { createCronRuntime, type CronRuntime } from "../cron.js";
// ω99-112: the controlled-browser runtime (six browser_* tools; playwright-core
// loads only at first launch, inside the runtime's dynamic import).
import { createBrowserRuntime } from "@wudao/browser";
// ω-4a: the monitor runtime (monitor tools + steering-lane event delivery).
import { createMonitorRuntime, type MonitorRuntime } from "../monitor.js";
import { maybeLoginShellEnv } from "../shell-snapshot.js";
// Provider management §7: the compaction window follows the LIVE config.
import { resolveSessionWindowTokens, loadEffectiveProfiles } from "../provider-registry.js";;
// M64-A §A: the peer-messaging runtime (UDS inbox + registry + inbound
// engine); rides the tool set (list_agents/send_message), the driver's
// steering lane, and the hooks' WUDAO_MSG_* env.
import { createPeerRuntime, readPeerDialogExpiry, sidecarMessageReview, type PeerRuntime } from "../peer/runtime.js";
// ω99-57: the child-mail lane (task-tool sink + driver drain, one instance).
import { createChildMailLane } from "../agents/child-mail.js";
import { parseSessionNameFlag } from "../args.js";
import type { LoopController } from "../commands/loop.js";
// ω99-13b: the /goal controller's late-bound box type (same track as loopBox).
import type { GoalController } from "../goal.js";
// ω99-15: the mission campaign controller (task DAG + ledger + resume over
// .wudao/mission.json) — the driver session's late-bound box.
import { createMissionController, type MissionController } from "../mission.js";
// ω99-249: #7 — the model-side GoalState runtime (mission-derived, budget-aware).
import type { GoalRuntime } from "../goal-runtime.js";
import { appendSessionEntry, buildContextWindowEntry } from "../session-entry.js";
import { registerExtensionSwapSink, rescanExtensionsAt, takePendingBundleColdAttribution } from "../extension-state.js";
import { getContextRules, createContextRuleMatcher } from "../rules.js";
import { VERSION } from "../version.js";
// P2-15 (96 队列 #15): the OTel export runtime (events-seam observer; absent
// telemetry settings ⇒ undefined ⇒ zero egress, zero hot allocations).
import { createTelemetryRuntimeFromSettings } from "../telemetry/telemetry.js";
import { createSessionPersistenceSeams } from "./session-engine-persist.js";
import { createProviderSwitchSeam } from "./session-engine-switch.js";
import { createSessionPermissionGate } from "./session-engine-gate.js";
import { buildSessionPersonaContext } from "./session-engine-persona.js";
// ω99 拆分运动 弧 B：门面类型外提至 session-engine-types.ts（纯移动）；
// re-export 门面保公共面，本文件体继续使用的名字走 import type 互引。
import type { DriverSessionOptions, DriverSession } from "./session-engine-types.js";
export type { DriverSessionOptions, DriverSession } from "./session-engine-types.js";

export async function createDriverSession(props: DriverSessionOptions): Promise<DriverSession> {
  const { config, workspaceRoot, contextWindowTokens, resumeHistory, modelOverride, hooks } = props;
  // ω99-245: #8 — 角色化推理能力预检（boot fail-fast）。在任何会话/租约/
  // 运行时建立之前对每个已配置角色查能力目录：不过就抛错（错误叙事带角色/
  // 模型/档位/来源/支持列表/怎么改），不建会话先报（Reasonix 纪律）。通过时
  // 的角色事实（roles）供模型构建后的健康摘要行使用。roster 读取容错（不可
  // 读 = 只查主配置链；plugin 层角色不在 boot 面，spawn 侧解析仍 fail-fast）。
  let rosterRoles: import("./reasoning-preflight.js").PreflightRosterRole[] | undefined;
  try {
    const roster = await loadRoleProfiles(workspaceRoot, {
      globalAgentsDir: join(resolveGlobalHome(), "agents"),
      onWarning: () => { /* spawn-side load still surfaces these; the boot stays quiet */ },
    });
    rosterRoles = [...roster.profiles.values()].map((p) => ({
      id: p.id,
      ...(p.provider !== undefined ? { provider: p.provider } : {}),
      ...(p.model !== undefined ? { model: p.model } : {}),
      ...(p.reasoningEffort !== undefined ? { reasoningEffort: p.reasoningEffort } : {}),
      builtin: BUILTIN_ROLES.get(p.id) === p,
    }));
  } catch { /* unreadable roster tier — the config-level preflight still runs */ }
  const preflight = preflightRoleReasoning({
    config,
    env: process.env,
    ...(rosterRoles !== undefined ? { roster: rosterRoles } : {}),
    profiles: loadEffectiveProfiles(),
  });
  if (!preflight.ok) throw new Error(preflight.error);
  // workspace-ux B2: ONE box for the whole session — the tool set resolves the
  // builtin file tools' boundary through it, the driver's agentRootSwitch
  // writes it, and (when the caller hands index.ts's hookWorkspaceRoot) hook
  // payloads build their paths against it. Session-anchored seams below keep
  // reading the plain `workspaceRoot`.
  const agentRootBox = props.agentRootBox ?? { current: workspaceRoot };
  const store = createJsonlSessionStore(join(workspaceRoot, ".wudao", "sessions"));
  const loadedRef: AgentMessage[] = resumeHistory ? [...resumeHistory] : [];
  // 夜移 017 (#31): the in-flight early user append (ordering barrier for the
  // run-complete tail pass — see onUserTurn below).
  // ω99-211 — the fresh-boot deferral arm. A sessionFresh boot id writes
  // NOTHING to disk until the FIRST user submit materializes it (route A:
  // 落盘延迟). The arm disarms at that first submit (the deferred boot
  // bookkeeping — model_change + workspace_root — enqueues ahead of the user
  // line in the same tick, so the store's FIFO keeps the old boot-time entry
  // order), on a /clear that rotates away from the still-empty boot id
  // (nothing ever materializes — see onSessionCleared), and never fires for
  // a rotated/adopted id (the sid === sessionId guard in onUserTurn:
  // post-/clear segments and adopted sessions keep the M80 status quo — no
  // boot bookkeeping on rotation). ω99 拆分运动 弧 B: the two `let`s are now
  // ONE holder (single binding — the extracted seams write through it).
  const persistState: import("./session-engine-persist.js").SessionPersistState = {
    earlyUserPersist: Promise.resolve(),
    freshBootPending: props.sessionFresh === true,
  };
  // M61 §1: the session's scheduler runtime (cron.json store + fire-on-idle).
  // Inert (carrying `refusal`) under WUDAO_DISABLE_CRON=1 or a symlinked
  // store — every surface then says why instead of silently no-op'ing.
  const sessionId0 = props.sessionId ?? `wudao-${Date.now().toString(36)}`;
  // #48 (hermes#4 turn-lease slice): the boot lease — this process becomes
  // the session's run-writer here, so it must OWN the cross-process lease
  // before anything else spins up (cron, watchers, the driver). A live
  // foreign holder refuses the boot outright: `wudao ui` double-opened on
  // one workspace, or a desktop sidecar racing a terminal `wudao --resume`,
  // would otherwise fork two writers against one JSONL. The lease rides the
  // root-memoized box (the driver's run gate acquires the same instance —
  // idempotent); a crashed holder's lock is stale and stolen on sight.
  // ω99-235: a caller may hand its OWN box (the pet lane's no-op box — two
  // concurrent sessions cannot share one box's single `current` lease).
  const sessionLeases = props.sessionLeases ?? sessionLeaseBoxFor(join(workspaceRoot, ".wudao", "sessions"));
  // #48: an INFRASTRUCTURE failure (unusable sessions root — ENOTDIR on a
  // broken .wudao, EACCES, …) is not a holder conflict: nobody can hold a
  // lease over an unwritable root. Degrade open with one warn line through
  // the engine's existing startupNotice lane; a LIVE foreign holder below
  // stays fail-closed.
  let bootLease: Awaited<ReturnType<typeof sessionLeases.acquire>> | undefined;
  try {
    bootLease = await sessionLeases.acquire(sessionId0);
  } catch (err) {
    (props.startupNotice ?? ((l: string) => stdoutGuard.writeRawStdout(`${l}\n`)))(
      `⚠️ 会话租约不可用（${err instanceof Error ? err.message : String(err)}）— 本次运行无跨进程占用保护`,
    );
  }
  if (bootLease !== undefined && !bootLease.ok) {
    throw new Error(
      `会话 ${sessionId0} 正被进程 ${bootLease.holder.pid} 占用(自 ${bootLease.holder.at}) — 同一会话不允许两个并发运行者;` +
        `若确认无进程在使用,删除 ${join(workspaceRoot, ".wudao", "sessions", ".leases", `${sessionId0}.json`)} 后重试`,
    );
  }
  const cron: CronRuntime = await createCronRuntime({
    workspaceRoot,
    sessionId: sessionId0,
    onWarn: (line) => (props.startupNotice ?? ((l) => stdoutGuard.writeRawStdout(`${l}\n`)))(line),
    // ω99-235: the pet lane's inert posture — env-scoped refusal (a second
    // live runtime over one cron.json double-arms due fires; see the prop).
    ...(props.cronDisabled === true ? { env: { WUDAO_DISABLE_CRON: "1" } } : {}),
  });
  // ω99-112: the session's browser runtime — same posture as the scheduler
  // (created beside it; construction is ZERO-IO, the kernel only downloads/
  // launches when the model first opens a page). Idle 10min reaping + the
  // process-exit hook own the window; engine teardown closes it with the
  // session below.
  const browser = createBrowserRuntime();
  // ω-4a: the session's monitor runtime — same posture as the scheduler
  // (inert under WUDAO_DISABLE_MONITOR=1, the tools then answer with the
  // refusal). In-memory watches only: they die with the process by design.
  const monitor: MonitorRuntime = createMonitorRuntime({
    workspaceRoot,
    sessionId: sessionId0,
    env: process.env,
    spillDir: join(workspaceRoot, ".wudao", "spill", sessionId0),
    onWarn: (line) => (props.startupNotice ?? ((l) => stdoutGuard.writeRawStdout(`${l}\n`)))(line),
  });
  // ω-4d: the session's login-shell snapshot provider (lazily resolved on
  // the first host-path shell; one capture per session, failure
  // cached — undefined under the kill switch / no $SHELL / unsupported shell).
  const loginShellEnv = maybeLoginShellEnv(workspaceRoot);
  // 114：会话的 python kernel idle 窗（settings pythonKernel；boot 一次读）。
  const pythonKernelIdleMs = pythonKernelSettingsFromNode((await loadLayeredSettings(workspaceRoot, () => {}, process.env)).effective["pythonKernel"]).idleTimeoutMs;
  // 125 项 1（dsh resolveCompactSpec 形）— 预留感知触发线的 misc 旋钮
  // （compaction.thresholdRatio/headroomTokens；缺省 0.8/2048 = reserve 缺席
  // 时平比字节不变）。boot 一次读；live 的窗口语义/请求帽在 recomputeWindow
  // 随 /provider 切换重算。
  const compactionSettings = compactionSettingsFromNode(
    (await loadLayeredSettings(workspaceRoot, () => {}, process.env)).effective["compaction"],
    (line) => (props.startupNotice ?? ((l) => stdoutGuard.writeRawStdout(`${l}\n`)))(line),
  );
  // 121 项 1（a reference harness 498490680 形）— AIMD 速率自适应并发门：设置缺省时
  // 门上限=kernel-policy 静态帽（3）且初值=上限——与既有静态帽字节等价，
  // 直到第一个 overload 信号。agents.aimdMaxConcurrent 可抬/降上限
  // （[1,16]，misc 家族纪律：junk→warning+缺省）。这一个 gate 同时喂两路：
  // registry 结算信号（ok→onSuccess / overload 死亡→onThrottle，在
  // createSessionRegistry 内接线）+ 解析出的子模型的重试梯子 onOverload
  // （中途 429 也降容——结算面看不到的那半）。
  const agentsAimd = agentsSettingsFromNode(
    (await loadLayeredSettings(workspaceRoot, () => {}, process.env)).effective["agents"],
    (line) => (props.startupNotice ?? ((l) => stdoutGuard.writeRawStdout(`${l}\n`)))(line),
  );
  const aimdGate = new AimdGate({ max: agentsAimd.aimdMaxConcurrent });

  // M24: the tracked model is what the loop AND subagents see — accounting
  // stays session-wide. M30: the resolver dresses task-tool model overrides.
  // M56 §3: one cost registry per session feeds /cost's $ summary.
  // M56 §1 + M63 §A: the key pool (round-robin + 429 cooldown) is declared
  // BELOW, as a live view over the mutable config holder — /provider swaps
  // the holder and rebuilds the client at a turn boundary, and the pool
  // follows without a second store.
  const costRegistry = new CostRegistry();
  // 推理档三级配置 S2b — the live config is ONE MUTABLE holder from boot
  // (the TUI's liveConfigRef pattern): /model //effort land on it through
  // the driver's onModelSwitch seam (applyModelSelection mutates fields in
  // place — the provider reads them per request, one client identity), and
  // /provider switches sync it in place (applyProviderConfig, including
  // optional-field REMOVAL) before the client rebuild. Before S2b the engine
  // never wired onModelSwitch — a browser /effort changed only the display
  // overlay while the request kept the boot bytes.
  const liveConfig: MutableProviderConfig = asMutableConfig(config);
  // 2026-08-31 minimax-401 弧 — the key pool is a LIVE view over the ONE
  // mutable holder (the S2b doctrine's last missing reader): select() reads
  // liveConfig's keys per REQUEST, so a /provider switch (applyProviderConfig
  // in the build seam below syncs the holder BEFORE the rebuild) and a
  // settings key refresh re-seat the wire key with zero coordination. The
  // old boot-time createKeyPool snapshot rode every rebuilt client — the
  // adapters treat an explicit pool as authoritative (options.keyPool ??
  // own-config pool), so cross-provider switches authenticated with the
  // BOOT provider's key → 401 login fail (kimi→minimax 2026-08-31). A live
  // pool HAS no second key store; there is nothing left to forget to reseed.
  const keyPool = createLiveKeyPool(() => liveConfig.apiKeys ?? [liveConfig.apiKey]);
  // M79 §2: the session's attachment store is the provider's image seam —
  // image-bearing requests resolve their transient data URLs here (a
  // scripted modelOverride in tests bypasses the provider entirely).
  const attachments = createFileAttachmentStore(workspaceRoot);
  // ω99-315: the dual-tier idle watchdog budget (soft warn / hard abort) —
  // one boot-time read, spread into every createProvider site below.
  const streamIdleOpts = streamIdleProviderOptions(await loadStreamSettings(workspaceRoot));
  // ω99-320: the session's soft-warn slot — ONE instance shared by the boot
  // provider build and every /provider-switch rebuild below (the budget
  // fragment's exact discipline). Every createProvider site spreads
  // `onStreamIdleWarning: slot.forward` (the constructor seam — the callback
  // is a ProviderOptions field, never a ModelInput one), and the driver gets
  // the SAME slot as `softWarnSlot` for run-scoped counting + the first-warn
  // live notice (迟来回调写不进下一个 run). Pure bypass: M24 zero impact.
  const softWarnSlot = createSoftWarnSlot();
  // SDD 2026-08-23 persona Task 3 — moved to session-engine-persona.ts
  // (ω99 拆分运动 弧 B: verbatim extract; see that file for the wiring notes).
  const { personaCtx, personaRuntime } = await buildSessionPersonaContext({
    props, config, liveConfig, workspaceRoot, sessionId0,
  });
  // ω-5a I23: ONE cold-cache monitor per session. The policy is resolved from
  // the BOOT provider (undocumented providers read "unknown" → silent); a
  // mid-session /provider switch is dominated by the identity_changed rule,
  // which needs no window docs.
  const coldCacheMonitor = new ColdCacheMonitor(COLD_CACHE_POLICIES[config.provider ?? ""] ?? { windowKind: "unknown" });
  const coldCacheFeed = {
    identity: (): string => coldCacheIdentity(liveConfig),
    noteUsage: (identity: string, promptTokens: number): void => coldCacheMonitor.noteUsage(identity, promptTokens),
  };
  // P0-1 (pi cache-stats port): the per-turn waste attribution monitor. Idle
  // attribution uses the provider's DOCUMENTED cache window when the policy
  // table has one (DeepSeek: days) — pi's 5-minute default would mislabel
  // every >5min gap on DeepSeek as expiry (the ω-5a I23 trusted-window rule).
  const coldPolicy0 = COLD_CACHE_POLICIES[config.provider ?? ""] ?? { windowKind: "unknown" };
  const wasteIdleTtlMs = coldPolicy0.windowKind !== "unknown" && coldPolicy0.windowSeconds !== undefined
    ? coldPolicy0.windowSeconds * 1000
    : CACHE_TTL_MS;
  const cacheWasteMonitor = new CacheWasteMonitor(wasteIdleTtlMs);
  // The per-row seam: MAIN calls only (the wrapper filters querySource-tagged
  // side calls — title/btw/summarizer ride other prefixes). The model key is
  // the ANSWERING model's (usage.model) — /model switches and failover rows
  // both move it; kill-switch gated (--no-cache-waste-notice).
  const noteCacheWaste = (u: import("@wudao/core").ModelUsage): void => {
    if (isFeatureAblated("cache-waste-notice")) return;
    const report = cacheWasteMonitor.noteUsage({
      promptTokens: u.promptTokens,
      cacheHitTokens: u.cacheHitTokens,
      ...(u.cacheWriteTokens !== undefined ? { cacheWriteTokens: u.cacheWriteTokens } : {}),
      ...(u.coldTurnExpected === true ? { coldTurnExpected: true } : {}),
      // ω99-53: the row's reasoning effort — the live config's current level
      // (the same value the run's assistant trail persisted). Absent on
      // effort-less configs; a one-sided comparison never attributes.
      ...(liveConfig.reasoningEffort !== undefined ? { effort: liveConfig.reasoningEffort } : {}),
      modelKey: `${liveConfig.provider ?? ""}/${u.model ?? liveConfig.model}`,
      at: Date.now(),
    });
    if (report !== null) driverBox.current?.notify(formatCacheWasteNotice(report));
  };
  // ω-5a I19: the context-window identity receipt — every wrapper advance
  // (compaction, /edit branch cut, provider-switch rebuild) lands ONE
  // context_window entry on the live session's JSONL. Fire-and-forget with
  // the same failure surface as every other entry seam below (the driverBox
  // / persistFailed closures are initialized before any model call runs).
  const appendWindowEntry = (w: import("../cache.js").WindowAdvance): void => {
    appendSessionEntry(store, driverBox.current?.getSessionId() ?? sessionId, buildContextWindowEntry({
      id: w.to,
      advancedFrom: w.from,
      divergedAt: w.divergedAt,
      ...(w.firstCall !== undefined ? { firstCall: w.firstCall } : {}),
    })).catch(persistFailed);
  };
  // ω99-83: the session's mandatory-reasoning repair holder (repl.ts:861's
  // verbatim `{ current: boolean }` shape — the subagentUpdateBox discipline:
  // a plain single-slot object the engine owns, declared before the model
  // constructions that write it). EVERY createProvider below (the boot build
  // and the /provider-switch rebuild) mounts the provider's
  // onMandatoryRepairApplied onto it (repl.ts:946's twin); the driver gets
  // the SAME holder, whose /status conditionally spreads it into the report
  // (commands/status.ts:69's form — the ω99-42 reasoning line). In-process
  // only, never persisted; starts false and flips at most once per session.
  const mandatoryRepairArmed: { current: boolean } = { current: false };
  let model = createCacheTrackingModel(withPersona(modelOverride ?? createProvider(liveConfig, { keyPool, attachments, personaRuntime, onMandatoryRepairApplied: () => { mandatoryRepairArmed.current = true; }, ...streamIdleOpts, onStreamIdleWarning: softWarnSlot.forward }), personaRuntime), {
    // ω99-8b: same-client child calls arrive stamped querySource="subagent"
    // — skip them HERE (the task tool's ω99-8 forwarder owns the subagent
    // row, so the child counts exactly once). Other tags/untagged still record.
    onUsage: (u, _s, _w, src) => {
      if (src === "subagent") return;
      // ω99-13b: /goal --budget metering rides the same seam the cost
      // registry does; the controller's own ω99-8b partition drops the
      // evaluator's rows (subagent rows are already gone above).
      goalBox.current?.recordMainUsage(u, src);
      costRegistry.record({ model: liveConfig.model, provider: liveConfig.provider, usage: u });
    },
    // P0-1: main-call rows feed the per-turn waste attribution monitor.
    onTurnUsage: noteCacheWaste,
    onWindowAdvance: appendWindowEntry,
    // ω-5a I23: every observed usage row feeds the monitor's checkpoint.
    coldCache: coldCacheFeed,
    // ω99-24 B: a reasoned bundle rescan parks its M24 attribution at the
    // seam — the next main-call usage row declares itself cold-and-expected.
    pendingColdAttribution: takePendingBundleColdAttribution,
  });
  const registry = createSessionRegistry({
    concurrencyGate: aimdGate,
    // The settings ceiling also raises the static cap itself (the gate and
    // the cap share ONE number — AIMD oscillates in [1, aimdMaxConcurrent]).
    ...(agentsAimd.aimdMaxConcurrent !== KERNEL_POLICY.registry.maxConcurrent ? { maxConcurrent: agentsAimd.aimdMaxConcurrent } : {}),
  });
  // M61 §2: the /loop controller box — the tool set reads it (late-bound),
  // the driver fills it at creation.
  const loopBox: { current?: LoopController } = {};
  // ω99-13b: the /goal controller box — the model wrapper's onUsage meters
  // /goal --budget main-call tokens through it. Late-bound exactly like
  // loopBox: the controller is created INSIDE the driver (after the wrapper),
  // so the box bridges the two; the driver fills it via opts.goalBox.
  const goalBox: { current?: GoalController } = {};
  // ω99-15: the mission campaign box — buildToolSet reads it above; the
  // engine tail fills it (late-bound exactly like goalBox/loopBox).
  const missionBox: { current?: MissionController } = {};
  // ω99-249: the GoalState runtime box — the tool set's `goal` query tool
  // reads it here; the DRIVER fills it at creation (the runtime owns the
  // sessionStore/sessionId seams, so it lives inside agent-driver). Same
  // late-bound discipline as missionBox above.
  const goalRuntimeBox: { current?: GoalRuntime } = {};
  // M80: the resolver-built children (provider/model pins, teammates) share
  // the session's attachment store — an image-bearing child history resolves
  // instead of failing closed with no-attachment-store.
  // 121 项 1: every resolved child's retry ladder reports overload-class
  // failures to the SAME gate the registry consults — a 429 storm the ladder
  // absorbs (retries eventually succeed) still converges the fan-out.
  const resolveModel = createProviderModelResolver({
    wrap: (m) => createCacheTrackingModel(m),
    attachments,
    onOverload: () => aimdGate.onThrottle(),
  });

  // M32: one read-state table per session; M37 §2: the file history driving
  // driver-level /rewind (one per session id).
  const readState = props.readState ?? createReadStateTable();
  // 夜移 032 (codex turn-diff): the per-run net-change ledger — one shared
  // instance threaded into BOTH the tool set (write_file/edit record) and
  // the driver (reset at run start, receipt at run settle).
  const turnDiff = createTurnDiffTracker();
  const sessionId = sessionId0;
  // 127 项 4（F5，审计缺口 E）— 引擎的 live-sid 盒（effortLiveBox 同款晚绑
  // 纪律；REPL 的 replSidLive 同款单绑定）：notes / historySearch /
  // sessionResult 三个会话锚定工具缝在工具构造时捕获 boot 会话 id 的 const，
  // continueSession/恢复协调器在主线进程内采纳别的会话后（setSessionId 轮换）
  // 这三个工具仍读 boot 会话的目录/账本——续跑的模型看不到刚恢复会话的
  // notes。改为执行时读盒后，轮换自动跟随。宿主自带 sessionIdBox（hooks 面）
  // 时复用同一实例（单一真相，hooks 行为不变）；否则引擎自铸一个并传给
  // driver（o.sessionIdBox）——setSessionId 的每次轮换写盒。
  const engineLiveSidBox: { current?: string } = props.sessionIdBox ?? { current: sessionId0 };
  const fileHistory: FileHistory = createFileHistory(join(workspaceRoot, ".wudao", "history", sessionId));
  // ω99-314: 文件级时光机的快照仓——workspace 全局 content-addressed（区别
  // 于 history/<sessionId> 的 per-session 快照）；驱动接管写前捕获、settle
  // 索引与 fileRevert。
  const snapshots = createSnapshotStore(workspaceRoot);

  // The gate stack mirrors app.tsx: session allowlist (`a` answers recorded
  // through the protocol) + hot-reloading .wudao/settings.json rules + the
  // runtime mode — but "ask" flows park in the driver (status.pendingPermission
  // → answerPermission op) instead of a React prompt, or resolve through the
  // caller's askRelay (M60: the Slack Block Kit relay) when one is given.
  // 0.3.11: the boot chain — CLI 旗标（显式命令行最高）> 持久默认档
  // （permissions.defaultMode，ui boot 读全局层传入）> "workspace"
  // （0.3.12：工作区可读写是默认档；--read-only 随四档制退役，--ask 补位）。
  const initialMode: Mode = process.argv.includes("--auto") || process.argv.includes("--ask")
    ? modeFromArgv(process.argv)
    : (props.defaultPermissionMode ?? "workspace");
  const driverBox: { current: AgentDriver | null } = { current: null };
  // M51 §3: the sidecar's tool-annotation resolver reads the tool set through
  // this late-bound box (the gate is built before the tools below).
  const toolsBox: { current?: readonly Tool[] } = {};
  // M64-A §A: the peer-messaging runtime — one per session; inert (carrying
  // `refusal`) under the kill switch / sandbox-without-override, in which
  // case the tool pair still registers and answers with the refusal. Built
  // AFTER driverBox exists: registerPeerSession reads the tier closure AT
  // CONSTRUCTION (a pre-driverBox reference was a TDZ that silently killed
  // registration — fix-round follow-up). The receiver tier reads the LIVE
  // mode (shift+tab flips the matrix); the auto-tier sidecar (when present)
  // reviews inbound text before delivery.
  const peerDialogExpiryRaw = await readPeerDialogExpiry(workspaceRoot);
  const sessionNameFlag = parseSessionNameFlag(process.argv.slice(2));
  const peer: PeerRuntime = await createPeerRuntime({
    workspaceRoot,
    sessionId: sessionId0,
    ...((props.sessionName ?? sessionNameFlag) !== undefined ? { name: (props.sessionName ?? sessionNameFlag) as string } : {}),
    env: props.noPeer === true ? { ...process.env, WUDAO_DISABLE_PEER: "1" } : process.env,
    tier: () => ((driverBox.current?.getMode() ?? modeFromArgv(process.argv)) === "auto" ? "bypass" : "normal"),
    ...(props.sandbox !== undefined ? { sandboxed: true } : {}),
    ...(peerDialogExpiryRaw === "never" || typeof peerDialogExpiryRaw === "number"
      ? { dialogExpiryMs: peerDialogExpiryRaw as number | "never" }
      : {}),
    notify: (line) => (props.startupNotice ?? ((l) => stdoutGuard.writeRawStdout(`${l}\n`)))(line),
    // The spec's auto-tier pre-delivery review (fail-closed with the
    // sidecar's own posture: only a low verdict passes).
    ...(props.sidecar !== undefined ? { reviewMessage: sidecarMessageReview(props.sidecar) } : {}),
  });
  // ω99 拆分运动 弧 B: the gate stack (allowlist → subagentGate) moved to
  // session-engine-gate.ts (verbatim extract; watcher/richDecide/sidecar layer
  // are that builder's internals now).
  const { allowlist, gate, subagentGate, onPermissionAsk } = await createSessionPermissionGate({
    props,
    workspaceRoot,
    agentRootBox,
    driverBox,
    toolsBox,
    initialMode,
  });

  const skills = props.skills ?? [];
  // M62 §1 fix (review L5): the gated context-rule matcher for this session —
  // the SAME construction app.tsx wires for the TUI (load the rules once,
  // match lazily on read/edit). Building it HERE gives both driver-based
  // frontends — `wudao ui` and the Slack interface — the lazy rule injection
  // the TUI/REPL/one-shot paths already had. No gated rules → the loop seam
  // stays unwired (zero cost).
  const gatedRules = getContextRules(workspaceRoot, (line) => (props.startupNotice ?? ((l) => stdoutGuard.writeRawStdout(`${l}\n`)))(line)).gated;
  const ruleMatcher = gatedRules.length > 0 ? createContextRuleMatcher(workspaceRoot, gatedRules) : undefined;
  // M49 §1: the memory runtime (recall pool + pending-review surface).
  // 多 driver 并发弧 A: side lanes pass memoryDisabled — an INERT runtime
  // (no refresh, no recall, no pending-review notice): memory.jsonl is
  // workspace-global and N lanes must not multiply its writers.
  const memoryRuntime = props.memoryDisabled === true
    ? { refresh: async () => {}, recall: (_prompt: string) => undefined }
    : createMemoryRuntime(workspaceRoot);
  if (props.memoryDisabled !== true) {
    await memoryRuntime.refresh();
    const pending = await surfacePendingReview(workspaceRoot);
    if (pending !== undefined) (props.startupNotice ?? ((line) => stdoutGuard.writeRawStdout(`${line}\n`)))(pending);
  }
  const extraTools = props.extraTools ?? [];
  const hasMcpTools = extraTools.some((t) => t.name.startsWith("mcp__"));
  const hasReadTool = props.tools ? props.tools.some((t) => t.name === "read_file") : true;
  // ω99-241: #6 — the computer strategy section rides the prompt iff the
  // session's tool set carries the computer octet (session-static, like
  // hasMcpTools; the rescan below reuses this same flag). computer_click
  // probes the octet: it mounts as a unit (tools.ts, zero-config top-level
  // only). No explicit tools prop → the standard builtin set, which includes
  // the octet.
  const hasComputerTools = props.tools ? props.tools.some((t) => t.name === "computer_click") : true;
  const stateHandle: { state?: import("@wudao/core").AgentState } = {};
  // ω99-79: the session's subagent-delta box (the stateHandle shape — an
  // empty single-slot object shared by both sides): the DRIVER arms
  // box.sink at run start and clears it at the run's finally seam
  // (AgentDriverOptions below); the task tool's loopOptions forward every
  // child's identified delta (core ω99-76, `sub:<childIdentity>:<rawId>`)
  // onto it (tools.ts). Between runs the slot is undefined — the tool-side
  // wrapper no-ops, child deltas from detached children stay unobserved.
  const subagentUpdateBox: { sink?: (delta: IdentifiedOutputDelta) => void } = {};
  // ω99-86 (53 停泊债清偿): the session's live-effort box (the same
  // stateHandle shape): the DRIVER arms box.get = () => modelLive.effort at
  // run start (cleared at the run's finally seam); the task tool reads it AT
  // SPAWN and threads the guarded value into the child's loopOptions.effortSent
  // — the ω99-53 trail, so a child dispatched mid-run records (and its
  // receipts align with) the level its requests actually run at. Between
  // runs the slot is undefined — idle spawns fall back to the session's own
  // baseline (the documented 79-style degradation).
  const effortLiveBox: { get?: () => string | undefined } = {};
  // 125 项 1: the model-side rotation port box — the SAME instance reaches the
  // tool set (buildToolSet newContext.portBox) and the driver (contextRotation
  // Box → LoopOptions.contextRotation.port); the loop installs its
  // implementation per run, so an idle box is the tool's fail-closed state.
  const contextRotationBox: NewContextPortBox = {};
  // ω99-57: the session's child-mail lane — the task tool's children deliver
  // their mid-run messages onto it; the driver drains it between the peer and
  // monitor lanes and wakes an idle frontend. One instance, shared by both
  // sides (the frontends that build tools without a driver pass none and the
  // children simply draw no mail tool).
  const childMail = createChildMailLane();
  // M-Memory 弧第二半 — 长期记忆 runtime（boot 召回注入 + 会话终了沉淀）。
  // store：<ws>/.wudao/memory/memory.jsonl（与 M49 的 .wudao/memory.jsonl 物理
  // 分离，见 longterm-memory.ts 头注）；enabled 读分层设置 memory.enabled。
  // 单例装配给命令道（/memory 新动词）与 REPL 同款位点复用。
  const ltsMemory = await createLongtermMemoryRuntime({ workspaceRoot });
  setLongtermMemoryRuntime(ltsMemory);
  const tools: Tool[] = [
    ...(props.tools ? props.tools : buildToolSet({
      workspaceRoot,
      agentRootBox,
      model,
      canUseTool: subagentGate,
      contextWindowTokens,
      // ω99-8: every child (subagent) model call's usage lands in the
      // session's cost registry under provider="subagent" (provenance, like
      // the M61 evaluator rows) keyed by the ANSWERING model — WUDAO_PRICE_
      // <MODEL> keys stay priceable (the evaluator-label lesson, not
      // repeated). Observational: recorder failures are isolated.
      onSubagentUsage: (info) => {
        costRegistry.record({ model: info.model, provider: "subagent", usage: info.usage });
        // 125 项 3（codex 预算上卷）：同一行也归账进根目标（晚绑 goalRuntimeBox
        // ——driver 创建时填充；goal 面缺席/无 live 目标时 runtime 静默丢弃）。
        // 计入报告、不计入触发（ω99-8b 分区不动）。
        goalRuntimeBox.current?.onSubagentUsage(info);
      },
      spillDir: join(workspaceRoot, ".wudao", "spill", sessionId),
      ...(loginShellEnv !== undefined ? { loginShellEnv } : {}),
      // 夜移 029: the session's skills — threshold-gated discover_skills.
      ...(skills.length > 0 ? { skills } : {}),
      history: fileHistory,
      contextProbe: () => stateHandle.state?.messages ?? [],
      getForkContext: () => stateHandle.state,
      getSystemPrompt: () => stateHandle.state?.systemPrompt ?? "",
      // 125 项 2（codex get_context_remaining 形）：水位线查询工具的触发线
      // 缝——窗口读可变 compactionOptions（/provider 切换 recomputeWindow 跟
      // 随），ratio/headroom/reserve 从 live config + misc 设置重读（闭包晚绑
      // 定：compactionOptions 在本调用之后声明，读发生在工具执行时）。
      contextRemaining: {
        getThreshold: () => ({
          windowTokens: compactionOptions?.contextWindowTokens ?? contextWindowTokens,
          ...compactionThresholdFields(liveConfig, compactionSettings),
        }),
      },
      // 123-2 — read_session 的台账读取缝（store 在本引擎作用域；读别的
      // 会话=纯旁路读，与 live state 零接触）。
      sessionRead: {
        read: (sid) => historySearchCorpus(store, sid).catch(() => undefined),
      },
      // 132-P1-2 — context_doctor 的晚绑快照（execute 时读：state 的
      // systemPrompt/messages + 本引擎工具集 + live 窗口——compactionOptions
      // 在本调用之后声明，闭包晚绑定同 contextRemaining 缝）。
      contextDoctor: {
        get: () => {
          const st = stateHandle.state;
          if (st === undefined) return undefined;
          return {
            systemPrompt: st.systemPrompt,
            tools,
            messages: st.messages,
            contextWindowTokens: compactionOptions?.contextWindowTokens ?? contextWindowTokens,
          };
        },
      },
      ...(props.sandbox ? { sandbox: props.sandbox } : {}),
      ...(props.writeVerify ? { writeVerify: props.writeVerify } : {}),
      ...(props.longOutput ? { longOutput: props.longOutput } : {}),
      // 借鉴弧 C1（a reference project C3）：长日志瘦身端口——引擎自解析 settings+env
      // （loadLayeredSettings 同款纪律），缺省关 = undefined。
      logSlimming: await loadLogSlimmingPortsForBoot(config),
      // 114: the kernel's session knob (idle-reap window).
      pythonKernel: { idleTimeoutMs: pythonKernelIdleMs },
      ...(props.web !== undefined ? { web: props.web } : {}),
      cron: { table: cron.table(), sessionId, env: process.env, runtime: cron },
      // ω99-313: the resident durable-schedule daemon's tool face — present
      // ONLY where the host wired one (`wudao ui`; the tool trio is the
      // append-only tail, absent seam = zero surface).
      ...(props.schedule !== undefined ? { schedules: props.schedule } : {}),
      // ω99-112: the browser sextet (fixed position after the web face,
      // before the scheduler trio; registered at session start like every
      // builtin so the tool-list prefix stays byte-stable).
      browser,
      // ω99-138: the browser_see vision materials — the session's attachment
      // store (screenshots join .wudao/attachments) + a LIVE modality verdict
      // over liveConfig, so /model //provider switches take effect at the
      // next browser_see call (a text main model degrades to the text table,
      // never a typed image refusal on every later request).
      browserVision: { store: attachments, modelAcceptsImages: () => modelAcceptsImages(liveConfig) },
      // ω99-212: screen_capture 的图片附件缝（与 browserVision 同库同纪律）。
      computerVision: { store: attachments, modelAcceptsImages: () => modelAcceptsImages(liveConfig) },
      // ω-4a: the monitor trio (fixed position beside the cron trio; inert
      // runtimes keep the trio for the fail-closed refusal).
      monitor: { registry: monitor.registry(), ...(monitor.refusal !== undefined ? { refusal: monitor.refusal } : {}) },
      loop: { getController: () => loopBox.current },
      // ω99-15: the mission quartet (fixed position after the loop tool;
      // late-bound over missionBox, filled at the engine tail below).
      mission: { getController: () => missionBox.current },
      // ω99-249: the goal query tool (fixed position after the mission
      // quartet — tail append, prefix stability; late-bound over the
      // goalRuntimeBox the driver fills at creation).
      goalFace: { getRuntime: () => goalRuntimeBox.current },
      // M64-A §A: list_agents + send_message ride the top-level set (fixed
      // position; inert runtimes keep the pair for the fail-closed refusal).
      peer,
      // ω99-57: the child-mail lane (the task tool's children deliver onto it).
      childMail,
      // ω99-79: the subagent-delta box (the task tool forwards child deltas
      // onto it; the driver arms the SAME instance's sink at run start).
      subagentUpdateBox,
      // ω99-86: the live-effort box (the task tool reads it at spawn; the
      // driver arms the SAME instance's getter at run start).
      effortLiveBox,
      // ω-2b (I3): the paged tool-result recovery tool over this session's
      // JSONL (beside ctx_inspect; sidechains are not searched).
      // 127 项 4（F5）: 三个会话锚定缝改读 live-sid 盒（执行时读——
      // continueSession 采纳新会话后自动跟随；盒空回落 boot id，fail-closed）。
      sessionResult: {
        load: async (toolCallId) =>
          (await store.load(engineLiveSidBox.current ?? sessionId)).filter((m): m is import("@wudao/core").ToolResultMessage => m.role === "tool" && m.toolCallId === toolCallId),
      },
      // 121 挖掘 TOP5 #1: the conversation-history search over THIS session's
      // JSONL (beside session_result — same family, same pure bypass read;
      // sidechains are not searched).
      historySearch: {
        load: () => historySearchCorpus(store, engineLiveSidBox.current ?? sessionId),
      },
      // 121 §1 续章: the persistent-notes pair over this session's
      // .wudao/notes/<sessionId>/ directory (beside the retrieval family —
      // same session anchor; the boot workspace root, not the live agent
      // root).
      notes: { sessionId: () => engineLiveSidBox.current ?? sessionId },
      // 125 项 1: the new_context tool rides the top-level tail beside the
      // notes pair — ONLY where compaction is on (a rotation IS a tier-2
      // boundary; an autoCompactEnabled:false session registers no tool at
      // all rather than a permanently-refusing one).
      ...(props.compactionEnabled === false ? {} : { newContext: { portBox: contextRotationBox } }),
      readState,
      turnDiff,
      // M-Memory 弧第二半：模型记忆工具面换轨——memory_save/memory_search/
      // memory_forget（新库）。M49 的 memory_write/memory_search 不再挂载：
      // memory_search 同名冲突，两缝互斥（buildToolSet fail-closed 拒绝同传）。
      // M49 的 dream/refine/pending-review 走 store 直连不受影响；回滚=换回
      // memory: { store: openMemoryStore(workspaceRoot) }。
      ...(ltsMemory.enabled ? { longtermMemory: { store: ltsMemory.store } } : {}),
      agents: {
        registry,
        runId: sessionId,
        resolveModel,
        defaultEffort: config.reasoningEffort ?? "off",
        onNotice: () => {},
        ...(props.pluginAgents ? { pluginAgents: props.pluginAgents } : {}),
        // M63-B: the SubagentStart/Stop faces ride the task tool.
        ...(hooks !== undefined ? { hooks } : {}),
        // M63-C R1: the fire-runtime view rides the subagent position.
        ...(props.hookRuntime !== undefined ? { hookRuntime: props.hookRuntime } : {}),
      },
    })),
    ...extraTools,
    // M60: the frontend's top-level tail (the Slack refusal ask_user rides
    // here exactly like the one-shot's interactive ask_user rides tools.push).
    ...(props.topLevelTools ?? []),
  ];
  toolsBox.current = tools;
  // M39: extension entries ride this run's session JSONL.
  props.extensions?.bindSession(store, sessionId);

  const persistFailed = (e: unknown): void => {
    driverBox.current?.notify(`⚠️ 会话保存失败：${e instanceof Error ? e.message : String(e)}`); // ω99-175: #4
  };

  // Provider management §7: the driver's compaction options live in ONE
  // MUTABLE object — the driver reads o.compaction at every run boundary
  // (and per /status), so a /provider switch mutates the window field in
  // place and the NEXT run sees the new per-model value. The initial value
  // is the boot config's (props.contextWindowTokens, knob-resolved by the
  // caller); re-resolution runs the §7 chain through props.resolveWindowTokens.
  // 125 项 1: the object also carries the reserve-aware threshold fields —
  // thresholdRatio/headroomTokens from the misc settings (session-static) +
  // outputReserveTokens from the LIVE config's request cap (recomputed on
  // every /provider switch beside the window).
  const compactionOptions:
    | {
        contextWindowTokens: number;
        windowMode?: import("@wudao/providers").WindowMode;
        thresholdRatio?: number;
        headroomTokens?: number;
        outputReserveTokens?: number;
      }
    | undefined =
    props.compactionEnabled === false
      ? undefined
      : {
          contextWindowTokens,
          ...(liveConfig.windowMode !== undefined ? { windowMode: liveConfig.windowMode } : {}),
          ...compactionThresholdFields(liveConfig, compactionSettings),
        };
  const recomputeWindow = (next: ProviderConfig): void => {
    if (compactionOptions === undefined) return;
    compactionOptions.contextWindowTokens = props.resolveWindowTokens !== undefined
      ? props.resolveWindowTokens(next.provider, next.model)
      : resolveSessionWindowTokens({
        effective: undefined,
        envWindowTokens: Number(process.env.WUDAO_CONTEXT_WINDOW ?? "200000") || 200000,
        provider: next.provider,
        model: next.model,
      });
    // 125 项 1: the threshold basis follows the switch too — windowMode and
    // the request cap (maxTokens) are per-provider facts; a stale reserve
    // from the previous provider would mis-gate the new one.
    if (next.windowMode !== undefined) compactionOptions.windowMode = next.windowMode;
    else delete compactionOptions.windowMode;
    const reserve = resolveOutputReserveTokens(next.maxTokens, next.windowMode);
    if (reserve !== undefined) compactionOptions.outputReserveTokens = reserve;
    else delete compactionOptions.outputReserveTokens;
  };

  // M58 §C#8 — git status block via the MetaNote channel (projection-only;
  // NEVER the prompt prefix — see git-status-note.ts for the hard rule).
  // Eager probe at state creation = session start; every turn_finished
  // re-checks the cheap fingerprint. A note pushed while idle waits in the
  // driver's queue until the next model call drains it, so a mid-run change
  // (e.g. the agent committing) surfaces on the next model call — turn
  // boundaries only, never per keystroke.
  const gitProbe = createGitStatusProber({
    workspaceRoot,
    push: (t) => driverBox.current?.pushMetaNote(t),
  });

  // 推理档三级配置 + 语言 chip S4: the language boot seed — the layered
  // settings `language` node (global < project < local) folded over env
  // HERE; the driver keeps it as the session tier's seed and re-folds
  // env+session EVERY submit (so the ablation env stays live and a
  // mid-session settings write lands next boot). Reader-side tolerant: a
  // corrupt node reads as absent (the S3 fold's rule).
  // P2-15 (96 队列 #15): the same layered read resolves the `telemetry` node
  // (OTel export; global-tier only — the trust gate drops it from the
  // cloneable tiers, so absent ⇒ no runtime ⇒ zero egress bytes).
  const layeredEffective = (await loadLayeredSettings(workspaceRoot, () => {}, process.env)).effective;
  const languageNodeRaw = layeredEffective["language"];
  // The OTel runtime rides the EVENTS seam (observer only): turn/tool spans
  // from the driver's onEvent stream, usage from the cost registry's rows
  // (read-only差量), sessionEnd at close(). Best-effort by construction —
  // every failure self-isolates inside the runtime.
  const telemetry = createTelemetryRuntimeFromSettings(layeredEffective["telemetry"], {
    sessionId,
    liveIdentity: () => ({ model: liveConfig.model, provider: liveConfig.provider }),
    costRows: () => costRegistry.rows,
    log: (line) => (props.startupNotice ?? ((l: string) => stdoutGuard.writeRawStdout(`${l}\n`)))(line),
  });
  const languageSeed = resolveLanguagePreference(
    process.env,
    typeof languageNodeRaw === "object" && languageNodeRaw !== null && !Array.isArray(languageNodeRaw)
      ? (languageNodeRaw as { reply?: unknown; reasoning?: unknown })
      : undefined,
  );
  // ω99-245（续）— 首 token 轻量探测（默认关，WUDAO_EFFORT_PROBE=1 开）
  // 与会话建立回执的健康摘要行。探测走已构建的 model（querySource 标记——
  // 缓存浪费归因的主链不受扰）；失败/超时降级「未验证」绝不阻塞。摘要行零
  // 配置零噪音：无显式档位且无角色钉时 formatReasoningHealthLine 返回
  // undefined，历史零新增。
  const effortProbe = effortProbeEnabled()
    && liveConfig.reasoningEffort !== undefined
    && liveConfig.apiKey !== WIZARD_PLACEHOLDER_KEY
    ? await probeReasoningSupport(model, liveConfig.reasoningEffort)
    : undefined;
  const reasoningHealthLine = formatReasoningHealthLine(preflight.roles, effortProbe);
  // P1-5 boot notices + ω99-245's health line share the lane (below the
  // resume divider — they describe THIS process's boot).
  const bootNoticesMerged = [
    ...(props.bootNotices ?? []),
    ...(reasoningHealthLine !== undefined ? [reasoningHealthLine] : []),
  ];

  // ω99 拆分运动 弧 B: the driver's nine persistence seams (verbatim extract —
  // the two mutable boot-persistence bindings ride persistState above).
  const persistenceSeams = createSessionPersistenceSeams({
    store,
    loadedRef,
    workspaceRoot,
    sessionId,
    liveConfig,
    allowlist,
    missionBox,
    memoryRuntime,
    driverBox,
    persistFailed,
    getModel: () => model,
    persistState,
  });

  const driver = createAgentDriver({
    model,
    tools,
    // ω99-320: the soft-warn slot (the SAME instance the provider builds
    // above carry as onStreamIdleWarning) — the driver arms it per run
    // (count + first-warn live notice) and clears it at settle.
    softWarnSlot,
    // ω99-249: the GoalState runtime's late-bound box — the driver creates
    // the runtime itself (it owns sessionStore/sessionId/missionBox) and
    // fills this box so the tool set's `goal` query tool can reach it.
    goalRuntimeBox,
    // ω99-79: the subagent-delta box the driver arms per run (the SAME
    // instance the tool set's task tool forwards onto — stateHandle shape).
    subagentUpdateBox,
    // ω99-86: the live-effort box the driver arms per run (the SAME
    // instance the task tool's spawn site reads — 79's twin shape).
    effortLiveBox,
    // ω99-83: the mandatory-reasoning repair holder (the model constructions
    // above write it via the provider callback; the driver's /status reads
    // it — AgentDriverOptions.mandatoryRepairArmed).
    mandatoryRepairArmed,
    // S4: the folded language seed (the session tier's boot value).
    languagePreference: languageSeed,
    // 0.3.31 kimi-400: the live model overlay must boot from the RESOLVED
    // config, never empty — an unseeded modelLive leaves provider undefined,
    // which fails /model's cross-provider guard open (a /model k3-256k on a
    // deepseek session then relabeled config.provider while the endpoint
    // stayed put: the request carried k3-256k to api.deepseek.com → 400).
    // The TUI already passes this pair (app.tsx); this is the web twin.
    sessionMeta: {
      ...(liveConfig.provider !== undefined ? { provider: liveConfig.provider } : {}),
      model: liveConfig.model,
      ...(liveConfig.reasoningEffort !== undefined ? { effort: liveConfig.reasoningEffort } : {}),
    },
    systemPrompt: buildSystemPrompt(workspaceRoot, hasMcpTools, hasReadTool ? skills : [], peer.refusal === undefined, hasComputerTools),
    canUseTool: gate,
    maxTurns: props.maxTurns,
    // 夜移 005: interactive sessions auto-title (one-shot paths keep the
    // derived name — a background call racing process exit buys nothing).
    // ω99-235: a caller may opt out (the pet lane — fixed display name).
    autoTitle: props.autoTitle !== false,
    // ω99-248 — the pet lane's isolation opt-out (see the prop above).
    persistPermissionAsks: props.persistPermissionAsks !== false,
    // ω99-235: the lease box the run gate rides — the SAME instance the boot
    // acquire above used (the caller's own box when one was handed in).
    sessionLeases,
    initialMessages: loadedRef,
    sessionId,
    ...(props.compactionEnabled === false
      ? {}
      : {
          // §7: the mutable window holder — see compactionOptions above.
          compaction: compactionOptions,
          // 125 项 1: the rotation port box (the tool set holds the same
          // instance) + the durable counter seam — one context_rotation JSONL
          // row per fired rotation (the driver's counter + resume replay are
          // the count's two halves).
          contextRotationBox,
          onContextRotation: (info: { readonly window: number; readonly rationale: string }) => {
            appendSessionEntry(
              store,
              driverBox.current?.getSessionId() ?? sessionId,
              buildContextRotationEntry({ window: info.window, rationale: info.rationale, at: new Date().toISOString() }),
            ).catch(persistFailed);
          },
        }),
    // M-Memory 弧第二半：driver 专属 hooks 注入包裹（首轮召回注入缝——
    // onRunStart 在首个模型调用之前触发，注入块照样进第一个请求）。agents
    // 选项（上方）保持原样 hooks：子 agent 的 loop 不触发主会话注入。
    hooks: withFirstRunMemoryInjection(hooks, ltsMemory),
    ...(props.sessionStartSource !== undefined ? { sessionStartSource: props.sessionStartSource } : {}),
    ...(props.rewakeSink !== undefined ? { rewakeSink: props.rewakeSink } : {}),
    ...(props.hookRuntime !== undefined ? { hookRuntime: props.hookRuntime } : {}),
    ...(props.promptIdBox !== undefined ? { promptIdBox: props.promptIdBox } : {}),
    // 127 项 4（F5）— the live-sid box rides the driver UNCONDITIONALLY now
    // (props.sessionIdBox when the host wired one — hooks keep their single
    // truth; else the engine's own box) so setSessionId rotations always
    // reach the three session-anchored tool seams above.
    sessionIdBox: engineLiveSidBox,
    ...(props.hookWarnSink !== undefined ? { hookWarnSink: props.hookWarnSink } : {}),
    // P1-5: the trust-gate boot notice rides the driver's history channel.
    // P1-5 boot notices + ω99-245's health line share the lane (merged above).
    ...(bootNoticesMerged.length > 0 ? { bootNotices: bootNoticesMerged } : {}),
    // M63-B: the FileChanged watchers + the skills-position ConfigChange poll.
    ...(props.fileChangeTargets !== undefined && props.fileChangeTargets.length > 0 && hooks?.onFileChanged !== undefined
      ? {
          fileChangeWatch: {
            targets: props.fileChangeTargets,
            fire: (path: string) => hooks!.onFileChanged?.(path),
          },
        }
      : {}),
    ...(props.configSkillsPath !== undefined && hooks?.onConfigChange !== undefined
      ? {
          configChangeSkills: {
            path: props.configSkillsPath,
            decide: async (position: "skills", path: string) => {
              const decision = await hooks!.onConfigChange?.(position, { path });
              return !(typeof decision === "object" && decision.block);
            },
          },
        }
      : {}),
    gates: props.gates,
    summarize: summarizeToolCall,
    workspaceRoot,
    agentRootBox,
    // M59 §3: /doctor web checks ride the driver as data (sync dispatch).
    ...(props.webDoctor !== undefined ? { webDoctor: props.webDoctor } : {}),
    readState,
    turnDiff,
    agentsRegistry: registry,
    mode: initialMode,
    skills,
    ...(props.sidecar ? { sidecar: props.sidecar } : {}),
    pluginCommands: props.pluginCommands ?? [],
    extensionCommands: props.extensions?.commands ?? [],
    // M61 §1: fire-on-idle scheduling rides the steering lane + idle poll.
    cron,
    // ω-4a: monitor events ride the same lane + idle poll; dispose (close
    // below) stops the runtime via the driver (children reaped, watchers closed).
    monitor,
    // SDD 2026-08-23 persona: the /persona seam (registry + per-session
    // runtime + chain/wire live views — see the construction block above).
    // The driver installs clearManualLayer onto this object at creation.
    persona: personaCtx,
    // M64-A §A: peer deliveries ride the same lane + idle poll; dispose
    // (close below) stops the runtime via the driver.
    peer,
    // ω99-57: child→parent mail — the SAME lane instance the tool set above
    // feeds (drained after peer, before monitor; idle-wake like the peer lane).
    childMail,
    // M61 §2: the driver fills this box with the /loop controller.
    loopBox,
    // ω99-13b: the driver fills this box with the /goal controller (same
    // late-bound track) so the usage wrapper above meters --budget.
    goalBox,
    // ω99-19: the driver's /mission slash face reads this same late-bound box
    // (filled at the engine tail below, after the driver exists).
    missionBox,
    // M61 §3: the /goal surface (stop-hook-position evaluator).
    goal: true,
    // M61 §4: the durable daemon (when the host created one).
    ...(props.schedule !== undefined ? { schedule: props.schedule } : {}),
    fileHistory,
    // ω99-314: the workspace-global snapshot store (write-pre capture + settle
    // index + fileRevert's data face).
    snapshots,
    // M62 §1 fix (review L5): the gated-rule matcher rides the driver (the
    // loop seam the TUI/REPL/one-shot already wire) — see gatedRules above.
    ...(ruleMatcher !== undefined ? { contextRules: { match: ruleMatcher } } : {}),
    // M56: the key pool (`keys n/m` in /status + the statusline snapshot)
    // and the cost registry (/cost's $ summary + unpriced note).
    statusline: { model: modelLabel(config), version: VERSION, provider: config.provider, keys: keyPool },
    costRegistry,
    // M63 §A: the /provider seam — without a modelOverride (the scripted
    // test seam), switches rebuild the real provider at the turn boundary;
    // the fresh wrapper carries the cold-first-turn receipt attribution.
    // ω99 拆分运动 弧 B: the seam body moved to session-engine-switch.ts
    // (verbatim extract; the engine's mutable `model` rides getModel/setModel).
    ...(modelOverride === undefined
      ? {
          onProviderSwitch: createProviderSwitchSeam({
            liveConfig,
            getModel: () => model,
            setModel: (m) => { model = m; },
            recomputeWindow,
            personaCtx,
            workspaceRoot,
            sessionId,
            driverBox,
            persistFailed,
            costRegistry,
            keyPool,
            attachments,
            personaRuntime,
            streamIdleOpts,
            softWarnSlot,
            mandatoryRepairArmed,
            noteCacheWaste,
            appendWindowEntry,
            coldCacheFeed,
          }),
        }
      : {}),
    // 推理档三级配置 S2b — the /model //effort seam (the TUI's
    // onModelSwitch twin): the selection mutates the ONE mutable live config
    // in place, so the NEXT request carries the new model/effort with the
    // client identity (and therefore the cache stats) stable. Without this
    // leg a browser /effort moved only the driver's display overlay.
    onModelSwitch: (selection) => {
      applyModelSelection(liveConfig, selection);
    },
    // M49 §1: bounded auto-recall rides each run's first model call; the
    // recall pool refreshes after every settled run (writes land mid-run).
    memoryRecall: memoryRuntime.recall,
    // M49 §2: the background review fork (registry-backed; kill switch env).
    backgroundReview: true,
    // ω-5a I23: the driver consults the cold-cache monitor at the top of
    // startRun (identity bound here — the driver never knows the config);
    // the notice itself is the driver's once-per-session mute.
    coldCache: {
      preSend: (historyLength: number) => coldCacheMonitor.preSend(coldCacheIdentity(liveConfig), historyLength),
    },
    ...(onPermissionAsk !== undefined ? { onPermissionAsk } : {}),
    // 0.3.14 #1: the parked-ask rule sink — the web menu's `a`/`p` answers
    // record the session rule here (the askRelay path above applies its own),
    // and `p` persists through the /permissions lane with a notify receipt.
    onAskRule: (rule, persist) => {
      // 夜移 009: same seam as the askRelay — a session-only rule (persist
      // false, the web menu's `a`) gets its receipt; `p`'s receipt lands via
      // persistAllowRule below instead.
      const sessionNote = recordAskRules(allowlist, { sessionRule: rule, persistentRule: persist ? rule : null });
      if (sessionNote !== null) driverBox.current?.notify(sessionNote);
      if (!persist) return;
      void persistAllowRule(workspaceRoot, rule).then(
        (receipt) => driverBox.current?.notify(receipt),
        (err) => driverBox.current?.notify(`permissions：always-rule 写入失败（${String(err)}）——本会话规则仍然生效`), // ω99-166e-i: #4（session-engine 第二臂同 #1 新串）
      );
    },
    onStateReady: (state) => {
      stateHandle.state = state;
      // M58 §C#8: session-start git snapshot rides the first model call.
      void gitProbe.probe();
    },
    // M58 §C#8: turn-boundary fingerprint refresh (see gitProbe above).
    // P2-15: the OTel observer rides the same events seam (self-isolated —
    // the runtime swallows its own failures; the git probe is unaffected).
    onEvent: (event) => {
      if (event.type === "turn_finished") void gitProbe.probe();
      telemetry?.observe(event);
    },
    // ω99 拆分运动 弧 B: the nine persistence seams moved to session-engine-persist.ts
    // (createSessionPersistenceSeams — verbatim bodies; see that file).
    ...persistenceSeams,
  });
  driverBox.current = driver;

  // ω99-15: the mission campaign controller — created AFTER the driver so
  // restore notices ("mission 已恢复…") ride the driver's history channel,
  // and late-bound into the tool set's mission_* quartet through missionBox.
  missionBox.current = await createMissionController({
    workspaceRoot,
    notify: (text) => driver.notify(text),
    // ω99-18: bundle mount/unmount rides the EXISTING cache-aware swap seam
    // (sink fan-out + busy-run parking + prefix invariants all inherited).
    // ω99-24 B: the TYPED reason rides along so the seam can declare the
    // cost on the next usage row.
    onBundlesChanged: async (reason) => {
      await rescanExtensionsAt(workspaceRoot, reason);
    },
  });

  // cc-plugins A3: rescanExtensions() hot-swaps this session's extension
  // surface. replaceExtensions lands the option slots AND state.systemPrompt
  // (setOptions can never land a prompt); the prompt rebuild keeps the cache
  // invariant — only the trailing <available_skills> manifest moves
  // (hasMcpTools/hasReadTool are session-static tool-set facts). Busy runs
  // park the swap; it lands at run settle inside the driver.
  const unregisterExtensionSwap = registerExtensionSwapSink((fresh) => {
    driverBox.current?.replaceExtensions({
      skills: fresh.skills,
      pluginCommands: fresh.pluginCommands,
      ...(fresh.pluginAgents.length > 0 ? { pluginAgents: fresh.pluginAgents } : {}),
      // M-Memory 弧第二半：fresh.hooks 同款包裹——extension swap 换掉 driver
      // hooks 后首轮注入缝仍在（fresh.hooks 缺席时 replaceExtensions 不动
      // hooks 槽，包裹版原样存活）。
      ...(fresh.hooks !== undefined ? { hooks: withFirstRunMemoryInjection(fresh.hooks, ltsMemory) } : {}),
      // ω99-28 T1 — the rebuild passes the SAME session-static peer flag the
      // boot prompt was built with (line ~794). Omitting it defaulted the 4th
      // arg to false: every rescan in a peer-tools session DROPPED the
      // "# Peer messaging" tail — an undeclared system-header break on any
      // mission_start/bundle rescan (the ω99-26 campaign's turn 3, 18.4k).
      // M-Memory 弧第二半：appendTo 保尾——rescan 重建后的 prompt 尾部仍带
      // 冻结的 <long-term-memory> 块（boot 注入与 rescan 两个位点字节一致）。
      systemPrompt: ltsMemory.appendTo(buildSystemPrompt(workspaceRoot, hasMcpTools, hasReadTool ? fresh.skills : [], peer.refusal === undefined, hasComputerTools)),
    });
  });

  return {
    driver,
    registry,
    allowlist,
    goalBox,
    missionBox,
    close: async () => {
      // ω99-36: the engine's session end — settle a dangling SHELL mission
      // BEFORE any teardown (a pure-fs ledger write into the archive; the
      // receipt is ignored — a non-empty campaign is never settled).
      try {
        await missionBox.current?.settleAtSessionBoundary();
      } catch {
        /* settlement never blocks teardown */
      }
      // M43-B review: SIGINT must exit even with a run in flight — abort the
      // driver's fetch/tool race first (its pending request would otherwise
      // hold the event loop open past the shutdown).
      unregisterExtensionSwap(); // A3: the session is over — no more swaps land here
      driverBox.current?.interrupt();
      registry.abortAll();
      // M-Memory 弧第二半：会话终了确定性沉淀（管线 ②——用户纠正模式的保守
      // lesson 提炼，无 key 纯确定性；静默，失败绝不阻塞 teardown）。读已
      // 持久化的会话轨迹（store.load——审计完整性的同一来源）。
      try {
        const captureSid = engineLiveSidBox.current ?? sessionId;
        await ltsMemory.captureAtSessionEnd({ sessionId: captureSid, messages: await store.load(captureSid) });
      } catch {
        /* capture never blocks teardown */
      }
      driver.dispose();
      // P2-15 (96 队列 #15): sessionEnd 强制 flush the OTel exporter (the
      // runtime's own await cap bounds this — teardown never waits past it,
      // and a failed export is a logged line, never a teardown blocker).
      await telemetry?.close();
      // M61 §1: stop the scheduler's tick with the session.
      cron.stop();
      // ω99-112: close the controlled browser with the session (idempotent —
      // an idle-reaped or never-launched runtime is a no-op).
      await browser.close();
      // ω-4a: reap watched children + close watchers with the session.
      monitor.stop();
      // #48: graceful shutdown releases the run lease (a crash leaves the
      // stale lock for the next boot's pid check to steal).
      await sessionLeases.release();
    },
  };
}
