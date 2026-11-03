// 拆分运动弧 C：从 app.tsx 原样外提的会话模型构造簇（useSessionModel）——
// M24/M56 缓存与成本包裹、live config/key pool、persona 运行时与链跟随、
// /model /provider 切换缝、resolveModel。hook 簇原序整体迁移（React 调用序
// 在组件内保持一致）；显式依赖对象，无其它闭包捕获。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { join } from "node:path";
import type { ModelClient } from "@wudao-org/core";
import { createFileAttachmentStore } from "@wudao-org/core";
import {
  createLiveKeyPool,
  createProvider,
  loadPersonaRegistry,
  withPersona,
  type KeyPool,
  type PersonaRegistry,
  type PersonaRuntime,
  type ProviderConfig,
  type ResolvedPersona,
} from "@wudao-org/providers";
import { CostRegistry } from "../commands/cost.js";
import { applyModelSelection, asMutableConfig } from "../commands/model.js";
import type { ModelSelection, MutableProviderConfig } from "../commands/model.js";
import {
  resolveActivePersona,
  resolveBootstrapPersona,
  applyPersonaChainAfterProviderSwitch,
  formatPersonaChainFollow,
  recordPersonaChange,
} from "../commands/persona.js";
import type { DriverPersonaContext } from "../driver/agent-driver.js";
import {
  PROVIDER_SWITCH_COLD_ATTRIBUTION,
  applyProviderConfig,
  configRefreshPending,
  keyRefreshPending,
  resolveProviderSwitch,
} from "../commands/provider.js";
import { readCredentialsFileSync } from "../credentials.js";
import { resolveSessionWindowTokens } from "../provider-registry.js";
import { createProviderModelResolver } from "../agents/index.js";
import { createSoftWarnSlot } from "../soft-warn-tracker.js";
import { createCacheTrackingModel, type CacheTrackingModel } from "../cache.js";
import type { AgentDriverOptions, UseAgentResult } from "./use-agent.js";
import { resolveGlobalHome } from "../settings-layer.js";

/** useSessionModel's explicit dependency slice. */
export interface SessionModelDeps {
  readonly config: ProviderConfig;
  readonly contextWindowTokens: number;
  readonly readProviderPersonaBinding: (providerId: string) => string | null | undefined;
  readonly readGlobalDefaultPersonaId: () => string | undefined;
  readonly modelOverride: ModelClient | undefined;
  readonly streamIdleOpts: { streamIdleSoftMs: number; streamIdleHardMs: number } | undefined;
  readonly workspaceRoot: string;
  readonly sessionId: string | undefined;
  readonly resolveWindowTokens: ((provider: string | undefined, model: string) => number) | undefined;
  readonly apiRef: { readonly current: UseAgentResult | null };
  readonly notifyRef: { current: (text: string) => void };
  readonly attachmentsRef: { readonly current: ReturnType<typeof createFileAttachmentStore> };
}

export function useSessionModel(D: SessionModelDeps) {
  // M24: the resident `cache N%` status-bar segment (session-cumulative,
  // hidden under the 1KB noise floor) and miss-spike warnings (B3). The
  // tracked model is what the loop AND subagents see — accounting stays
  // session-wide. M30: the same wrapper dresses task-tool model overrides,
  // so a role-pinned child counts against the same cache numbers.
  // M43-A: the percent lands in the driver's status channel.
  // M56 §1: the session's key pool (round-robin + 60s 429 cooldown) — one
  // instance for the whole session, created once. M56 §3: the session's cost
  // registry rides the wrap seam below (per-call rows with model identity).
  const costRegistryRef = useRef<CostRegistry | null>(null);
  if (costRegistryRef.current === null) {
    costRegistryRef.current = new CostRegistry();
  }
  // ω99-38: the return type narrows to the wrapper (not the bare ModelClient)
  // so the App can hold the LIVE main-model wrapper by reference — the routed
  // /clear's onSessionCleared seam calls rotate() on it.
  const wrapTracked = useCallback(
    (m: ModelClient, coldFirstTurnAttribution?: string): CacheTrackingModel =>
      createCacheTrackingModel(m, {
        onUsage: (u, stats) => {
          const pct = stats.percent;
          D.apiRef.current?.setCachePercent(pct === null ? null : Math.round(pct));
          // M56 §3: the per-call cost row (model identity from the LIVE
          // config — what the NEXT request carries, same as /status).
          costRegistryRef.current?.record({ model: liveConfigRef.current.model, provider: liveConfigRef.current.provider, usage: u });
        },
        onBreak: (warning) => D.notifyRef.current(warning),
        // M63 §A: present only on a provider-switch build (see below).
        ...(coldFirstTurnAttribution !== undefined ? { coldFirstTurnAttribution } : {}),
      }),
    [],
  );
  // M55 §B7: the provider is built over the LIVE config — /model //effort
  // mutate its fields through onModelSwitch and the next request carries them
  // (one client identity: cache stats and tool closures stay valid).
  // M63 §A: a PROVIDER switch cannot ride that lane (the engine precomputes
  // its fallback chain and the reasoning matrix is profile-bound), so it
  // REBUILDS the client: onProviderSwitch resolves the target config, syncs
  // the live config in place (per-request readers — cost rows, /status —
  // follow), and hands the fresh client to the driver AND to the memo below
  // (the state bump makes the next setOptions carry the same client, so the
  // driver's swap survives the React refresh).
  const liveConfigRef = useRef<MutableProviderConfig>(asMutableConfig(D.config));
  // M56 §1 + 2026-08-31 minimax-401 弧 — the key pool (round-robin + 429
  // cooldown) is a LIVE view over the mutable config holder, declared AFTER
  // it (the getter reads the ref per REQUEST): a /provider switch below syncs
  // liveConfigRef in place and the next request's key follows — the old
  // once-per-mount createKeyPool snapshot rode every rebuilt client with the
  // BOOT provider's key (adapters treat an explicit pool as authoritative)
  // and cross-provider switches 401'd. There is no second key store here.
  const keyPoolRef = useRef<KeyPool | null>(null);
  if (keyPoolRef.current === null) {
    keyPoolRef.current = createLiveKeyPool(() => liveConfigRef.current.apiKeys ?? [liveConfigRef.current.apiKey]);
  }
  // SDD 2026-08-23 persona Task 3 — the session's persona runtime, sunk into
  // EVERY model construction below (mirroring runRepl's block at
  // repl.ts:592-623). The client is withPersona-wrapped from FIRST render
  // with runtime.current = null (byte-identical to the bare client — pinned
  // at the providers layer), the registry loads async at mount, and the
  // bootstrap chain (env=config.persona > binding > default) lands as a
  // runtime.current FIELD swap — no client rebuild (the /model precedent).
  const readProviderPersonaBinding = D.readProviderPersonaBinding ?? (() => undefined);
  const readGlobalDefaultPersonaId = D.readGlobalDefaultPersonaId ?? (() => undefined);
  const personaRuntimeRef = useRef<PersonaRuntime | null>(null);
  if (personaRuntimeRef.current === null) {
    personaRuntimeRef.current = {
      current: null,
      // Late-bound slots: the session id rotates on /clear, and templates
      // like {{sessionId}} resolve per request — so the slot reads the LIVE
      // id instead of the boot snapshot.
      get slots() {
        return { sessionId: D.apiRef.current?.driver.getSessionId() ?? D.sessionId ?? "tui" };
      },
    };
  }
  const personaStateRef = useRef<{ registry: PersonaRegistry; env: ResolvedPersona | null }>({
    registry: { personas: [], errors: [] },
    env: null,
  });
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Three-tier registry (builtin → ~/.wudao/personas → workspace), the
      // same dirs runRepl reads. Bad files are startup warnings, not a crash.
      const loaded = await loadPersonaRegistry({
        globalDir: join(resolveGlobalHome(), "personas"),
        workspaceDir: join(D.workspaceRoot, ".wudao", "personas"),
      });
      if (cancelled) return;
      for (const e of loaded.errors) D.notifyRef.current(`⚠️ persona file skipped: ${e}`);
      const boot = resolveBootstrapPersona(loaded, liveConfigRef.current);
      if (!boot.ok) D.notifyRef.current(`⚠️ ${boot.error}`);
      personaStateRef.current.registry = loaded;
      // The env layer NEVER clears on a provider switch (spec §1: env 恒最优先).
      personaStateRef.current.env = boot.ok ? boot.resolved : null;
      const active = resolveActivePersona(loaded, {
        envPersona: personaStateRef.current.env,
        bindingId: readProviderPersonaBinding(liveConfigRef.current.provider ?? ""),
        defaultId: readGlobalDefaultPersonaId(),
      });
      if (active.warning !== undefined) D.notifyRef.current(`⚠️ ${active.warning}`);
      personaRuntimeRef.current!.current = active.resolved;
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
    // Once per mount (workspace): registry files are read at startup, not
    // hot-reloaded (same posture as keybindings; /persona switches are
    // runtime.current swaps, never registry re-reads).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [D.workspaceRoot]);
  // The driver's /persona seam — ONE context object for the whole session
  // (identity-stable across renders: useAgent re-pushes options every render
  // and the driver installs clearManualLayer onto THIS object at creation).
  // `registry`/`chain` are late-bound reads so the async load needs no
  // rebuild of this object.
  const personaCtxRef = useRef<DriverPersonaContext | null>(null);
  if (personaCtxRef.current === null) {
    personaCtxRef.current = {
      get registry() {
        return personaStateRef.current.registry;
      },
      runtime: personaRuntimeRef.current!,
      chain: () => ({
        envPersona: personaStateRef.current.env,
        bindingId: readProviderPersonaBinding(liveConfigRef.current.provider ?? ""),
        defaultId: readGlobalDefaultPersonaId(),
      }),
      wire: () => liveConfigRef.current.wire ?? "openai-chat",
    };
  }
  // ω99-83: the session's mandatory-reasoning repair holder (repl.ts:861's
  // verbatim `{ current: boolean }` shape, held in a ref — the 82 box
  // discipline). EVERY model construction below (the memo and the
  // /provider-switch build) mounts the provider's onMandatoryRepairApplied
  // onto it (repl.ts:946's twin; the ref identity is stable, so the
  // useMemo/useCallback captures stay valid); useAgent hands the SAME holder
  // to the driver, whose /status conditionally spreads it into the report
  // (commands/status.ts:69's form — the ω99-42 reasoning line). In-process
  // only, never persisted; starts false and flips at most once per session.
  const mandatoryRepairArmedRef = useRef<{ current: boolean }>({ current: false });
  // ω99-320: the session's soft-warn slot (the 82-box discipline: a stable
  // ref the model constructions below AND useAgent read — every createProvider
  // site carries slot.forward as onStreamIdleWarning; the driver arms the
  // listener per run and clears it at settle. 迟来回调写不进下一个 run).
  const softWarnSlotRef = useRef(createSoftWarnSlot());
  const [switchedModel, setSwitchedModel] = useState<CacheTrackingModel | null>(null);
  const model = useMemo(
    // A switched client takes precedence over the seeded override — and it
    // arrives ALREADY wrapped (the build seam wraps with the cold-first-turn
    // attribution), so the memo must not wrap it a second time.
    () => switchedModel ?? wrapTracked(withPersona(D.modelOverride ?? createProvider(liveConfigRef.current, { keyPool: keyPoolRef.current!, attachments: D.attachmentsRef.current, personaRuntime: personaRuntimeRef.current!, onMandatoryRepairApplied: () => { mandatoryRepairArmedRef.current.current = true; }, ...(D.streamIdleOpts !== undefined ? { ...D.streamIdleOpts } : {}), onStreamIdleWarning: softWarnSlotRef.current.forward }), personaRuntimeRef.current!)),
    [switchedModel, D.modelOverride, wrapTracked],
  );
  // ω99-38: the LIVE main-model wrapper (a render-time ref write — the
  // askReviewModelRef pattern; both memo branches are wrapTracked products).
  // The routed /clear's onSessionCleared seam calls rotate() on it: the
  // wrapper's diff state (prevSerialized / prevPromptTokens / windowBase) is
  // pre-clear context, and without the reset the fresh session's first call
  // diffs its small prefix against the OLD session's tail request and
  // misreports ⚠️ turn-0 (ω99-34's disease, the TUI's own wrapper).
  const trackedModelRef = useRef<CacheTrackingModel | null>(null);
  trackedModelRef.current = model;
  // design 70 §4: the ask-reviewer rides the LIVE model (late-bound — see
  // the ref note at onPermissionAsk; the render-time ref write mirrors the
  // gitProbeRef pattern above).
  // design 70 §4: the ask-reviewer rides the LIVE model (late-bound — the
  // render-time ref write below; app.tsx's onPermissionAsk reads the SAME ref,
  // returned by this hook).
  const askReviewModelRef = useRef<ModelClient | null>(null);
  askReviewModelRef.current = model;
  // The label overlay a switch refreshes (header + statusline + /status).
  const [liveModelMeta, setLiveModelMeta] = useState({ provider: D.config.provider, model: D.config.model });
  // Provider management §7 (review I1): the window is STATE over the LIVE
  // config — seeded from the boot value (the caller resolved it knob-aware)
  // and re-resolved whenever /model or /provider moves the provider/model
  // pair. The re-render carries the fresh value into both consumers (the
  // tool set's defer gate and the driver's compaction options, which
  // useAgent re-pushes every render) — 切模型即切窗口.
  const [liveWindowTokens, setLiveWindowTokens] = useState(D.contextWindowTokens);
  // R-N2 (T5, review I1 follow-up): windowFor is captured ONCE by the
  // empty-deps callbacks below (onModelSwitch's useCallback([]) and
  // onProviderSwitch's build seam) — safe today ONLY because it stays a pure
  // (provider, model) → number function over process.env + the registry memo
  // (no render-scoped state), and the live config moves solely through those
  // two seams, which always re-resolve through it. If windowFor ever needs
  // render state, read it fresh per render here instead of relying on the
  // capture.
  const windowFor = D.resolveWindowTokens
    ?? ((provider: string | undefined, model: string): number =>
      resolveSessionWindowTokens({
        effective: undefined,
        envWindowTokens: Number(process.env.WUDAO_CONTEXT_WINDOW ?? "200000") || 200000,
        provider,
        model,
      }));
  const onModelSwitch = useCallback((selection: ModelSelection): void => {
    applyModelSelection(liveConfigRef.current, selection);
    // §7: the model switch may move provider+model — re-resolve the window.
    setLiveWindowTokens(windowFor(liveConfigRef.current.provider, liveConfigRef.current.model));
    setLiveModelMeta((m) => ({
      provider: selection.provider !== undefined ? selection.provider : m.provider,
      model: selection.model !== undefined ? selection.model : m.model,
    }));
  }, []);
  // M63 §A: the driver's /provider seam. resolve is PURE (a switch parked
  // behind a busy run must not touch the config that run is using); build
  // mutates + constructs and is called only at the apply point (idle, or the
  // run-settle boundary). The new wrapper carries the cold-first-turn
  // attribution — the first turn on the new endpoint names why it re-fees
  // the whole history.
  const onProviderSwitch = useMemo<AgentDriverOptions["onProviderSwitch"]>(() => ({
    // 0.3.32c kimi-401: the credentials snapshot rides EVERY resolve, not a
    // missing-key retry — without it the cross-provider file-key preference
    // and the same-provider refresh leg are dead code on this lane (a saved
    // target key never displaced the borrowed pool → 401). See
    // resolveProviderSwitch's 0.3.32c note.
    resolve: (target) =>
      resolveProviderSwitch({ target, env: process.env, current: liveConfigRef.current, credentials: readCredentialsFileSync() }),
    // 0.3.32c: the second same-name carve-out leg — a just-saved key the
    // live pool lacks makes /provider <same> a real re-resolve.
    keyRefreshPending: () => keyRefreshPending(liveConfigRef.current, readCredentialsFileSync()),
    // 2026-08-31 config-drift: the third leg — a fresh resolve would change
    // the connection (the registry row was rewritten under us; parity with
    // the session-engine seam).
    configRefreshPending: () => {
      const p = liveConfigRef.current.provider;
      if (p === undefined) return false;
      const r = resolveProviderSwitch({ target: p, env: process.env, current: liveConfigRef.current, credentials: readCredentialsFileSync() });
      return configRefreshPending(liveConfigRef.current, r.ok ? r.config : undefined);
    },
    build: (next) => {
      applyProviderConfig(liveConfigRef.current, next);
      // §7: the switch landed a new provider/model pair — re-resolve the
      // window before the rebuild (same seam as onModelSwitch above).
      setLiveWindowTokens(windowFor(next.provider, next.model));
      // SDD persona Task 3 — 链跟随（BEFORE the rebuild, so the fresh client's
      // FIRST request carries the re-resolved persona): clear the manual
      // layer (the driver's flag — a session-local /persona does not survive
      // a provider switch), re-walk env > binding > default for the TARGET
      // provider (chain() reads the just-applied live config), swap
      // runtime.current (field swap — no extra rebuild), notice +
      // persona_change(reason "provider-switch") only when it moved.
      const pc = personaCtxRef.current!;
      pc.clearManualLayer?.();
      const follow = applyPersonaChainAfterProviderSwitch(pc.runtime, pc.registry, pc.chain());
      if (follow.changed) {
        D.notifyRef.current(formatPersonaChainFollow(follow));
        const from = follow.previous;
        void recordPersonaChange({
          workspaceRoot: D.workspaceRoot,
          sessionId: D.apiRef.current?.driver.getSessionId() ?? D.sessionId ?? "",
          to: {
            id: follow.resolved?.definition.id ?? null,
            layers: follow.resolved?.layers ?? { headers: false, body: false, prompt: false },
            // Layer-selection Task 1: the effective qualified ref (absent for
            // plain ids — the record's legacy shape is unchanged).
            ...(follow.spec !== undefined ? { spec: follow.spec } : {}),
          },
          ...(from !== null ? { from: { id: from.definition.id } } : {}),
          coldTurnExpected: follow.breaksCache,
          reason: "provider-switch",
        }).catch((err) => {
          D.notifyRef.current(`⚠️ persona switch entry not recorded: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      const client = wrapTracked(
        withPersona(createProvider(liveConfigRef.current, { keyPool: keyPoolRef.current!, attachments: D.attachmentsRef.current, personaRuntime: pc.runtime, onMandatoryRepairApplied: () => { mandatoryRepairArmedRef.current.current = true; }, ...(D.streamIdleOpts !== undefined ? { ...D.streamIdleOpts } : {}), onStreamIdleWarning: softWarnSlotRef.current.forward }), pc.runtime),
        PROVIDER_SWITCH_COLD_ATTRIBUTION,
      );
      setSwitchedModel(client);
      setLiveModelMeta({ provider: next.provider, model: next.model });
      return client;
    },
  }), [wrapTracked]);
  // M30: role/caller model overrides resolve through the provider config and
  // come back cache-tracked (the reasoning receipt's `effective` side).
  // M80: the resolver-built children (and teammates through the team runtime)
  // share the session's attachment store — image-bearing child history
  // resolves instead of failing closed with no-attachment-store.
  const resolveModel = useMemo(
    () => createProviderModelResolver({ wrap: wrapTracked, attachments: D.attachmentsRef.current }),
    // D.attachmentsRef is a stable ref (one store per mounted session).
    [wrapTracked],
  );
    return {
      model, wrapTracked, costRegistryRef, liveConfigRef, keyPoolRef, personaCtxRef,
      mandatoryRepairArmedRef, softWarnSlotRef, trackedModelRef, askReviewModelRef,
      liveModelMeta, liveWindowTokens, onModelSwitch, onProviderSwitch, resolveModel,
    };
  }
