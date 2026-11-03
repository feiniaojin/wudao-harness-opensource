// ω99 拆分运动 弧 B：session-engine 的 /provider 切换 seam 外提（原
// createAgentDriver options 体内的 onProviderSwitch 连续段，闭包体逐字保留——
// 仅两类机械改写：可变 `model` 绑定走 getModel/setModel（单绑定，重建后引擎体
// 内的活引用同步换新）；其余闭包自由变量收进 ctx 显式线程）。
import { createProvider, createLiveKeyPool, withPersona } from "@wudao-org/providers";
import type { PersonaRuntime, ProviderConfig } from "@wudao-org/providers";
import { createFileAttachmentStore } from "@wudao-org/core";
import type { ModelUsage } from "@wudao-org/core";
import { resolveProviderSwitch, applyProviderConfig, keyRefreshPending, configRefreshPending, PROVIDER_SWITCH_COLD_ATTRIBUTION } from "../commands/provider.js";
import { readCredentialsFileSync, WIZARD_PLACEHOLDER_KEY } from "../credentials.js";
import { applyPersonaChainAfterProviderSwitch, formatPersonaChainFollow, recordPersonaChange } from "../commands/persona.js";
import { CostRegistry } from "../commands/cost.js";
import type { MutableProviderConfig } from "../commands/model.js";
import { createCacheTrackingModel } from "../cache.js";
import type { CacheTrackingModel, WindowAdvance } from "../cache.js";
import { streamIdleProviderOptions } from "../stream-idle-config.js";
import { createSoftWarnSlot } from "../soft-warn-tracker.js";
import { takePendingBundleColdAttribution } from "../extension-state.js";
import type { AgentDriver, AgentDriverOptions, DriverPersonaContext } from "./agent-driver.js";

/** The /provider switch seam's closure context (verbatim free variables, now
 *  explicit — the engine's mutable `model` binding rides getModel/setModel). */
export interface ProviderSwitchCtx {
  readonly liveConfig: MutableProviderConfig;
  /** The engine's live cache-tracked model (the ONE mutable binding). */
  readonly getModel: () => CacheTrackingModel;
  readonly setModel: (m: CacheTrackingModel) => void;
  /** §7: re-resolves the compaction window BEFORE the rebuild. */
  readonly recomputeWindow: (next: ProviderConfig) => void;
  readonly personaCtx: DriverPersonaContext;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly driverBox: { current: AgentDriver | null };
  readonly persistFailed: (e: unknown) => void;
  readonly costRegistry: CostRegistry;
  readonly keyPool: ReturnType<typeof createLiveKeyPool>;
  readonly attachments: ReturnType<typeof createFileAttachmentStore>;
  readonly personaRuntime: PersonaRuntime;
  readonly streamIdleOpts: ReturnType<typeof streamIdleProviderOptions>;
  readonly softWarnSlot: ReturnType<typeof createSoftWarnSlot>;
  readonly mandatoryRepairArmed: { current: boolean };
  readonly noteCacheWaste: (u: ModelUsage) => void;
  readonly appendWindowEntry: (w: WindowAdvance) => void;
  readonly coldCacheFeed: { identity: () => string; noteUsage: (identity: string, promptTokens: number) => void };
}

export function createProviderSwitchSeam(ctx: ProviderSwitchCtx): NonNullable<AgentDriverOptions["onProviderSwitch"]> {
  const { liveConfig, getModel, setModel, recomputeWindow, personaCtx, workspaceRoot, sessionId, driverBox, persistFailed, costRegistry, keyPool, attachments, personaRuntime, streamIdleOpts, softWarnSlot, mandatoryRepairArmed, noteCacheWaste, appendWindowEntry, coldCacheFeed } = ctx;
  return {
    // 0.3.32c kimi-401: the credentials snapshot rides EVERY resolve,
    // not a missing-key retry — 1b84537's cross-provider file-key
    // preference was gated on `credentials`, but a first-resolve
    // success (the old pool satisfies) never reached the retry, so a
    // target with a saved file key still borrowed the boot provider's
    // key and 401'd on every retry (the reported trap). Always-on
    // also enables the same-provider refresh leg (a just-saved key
    // the live pool lacks) — resolveProviderSwitch's 0.3.32c note.
    resolve: (target: string) =>
      resolveProviderSwitch({ target, env: process.env, current: liveConfig, credentials: readCredentialsFileSync() }),
    // M63 §C: while the live config is the no-key boot's placeholder,
    // the driver refuses prompt runs (browse-only) and treats a
    // same-name /provider as a REAL switch (the completion path).
    isPlaceholderLive: () => liveConfig.apiKey === WIZARD_PLACEHOLDER_KEY,
    // 0.3.32c kimi-401: the second same-name leg — the credentials
    // file holds a key the live pool lacks (a settings key save the
    // running session has not picked up).
    keyRefreshPending: () => keyRefreshPending(liveConfig, readCredentialsFileSync()),
    // 2026-08-31 config-drift: the third same-name leg — a fresh
    // resolve of the LIVE provider would change the connection
    // (endpoint/wire). The settings row save (settingsSaveProvider)
    // rewrites the registry overlay; the running session keeps the
    // endpoint it last resolved until this refresh re-applies it.
    // resolveProviderSwitch is pure (no mutation) and reads the
    // registry fresh — calling it here as the drift probe is free.
    configRefreshPending: () => {
      const p = liveConfig.provider;
      if (p === undefined) return false;
      const r = resolveProviderSwitch({ target: p, env: process.env, current: liveConfig, credentials: readCredentialsFileSync() });
      return configRefreshPending(liveConfig, r.ok ? r.config : undefined);
    },
    build: (next: ProviderConfig) => {
      // Review I1 (fix round): the replacement wrapper continues the
      // window CHAIN — it carries the old wrapper's id, so its first
      // observed row fires one synthetic advance and the switch lands
      // a context_window entry instead of the old id dying silently.
      const predecessorWindowId = getModel().currentWindowId();
      // S2b: sync the ONE mutable holder in place (field-by-field
      // including optional-field REMOVAL — the TUI's build seam rule)
      // instead of rebinding, so every live reader (cost rows,
      // persona chain, cold-cache identity) follows the switch.
      applyProviderConfig(liveConfig, next);
      // §7: the switch landed a new provider/model pair — the
      // compaction window re-resolves BEFORE the rebuild, so the
      // next run's 0.8× trigger already computes against it.
      recomputeWindow(next);
      // SDD persona Task 3 — 链跟随（BEFORE the rebuild, so the fresh
      // client's FIRST request carries the re-resolved persona):
      // clear the manual layer (the driver's flag — spec §1: a
      // session-local /persona does not survive a provider switch),
      // re-walk env > binding > default for the TARGET provider, swap
      // runtime.current (field swap — NO extra rebuild), notice +
      // persona_change(reason "provider-switch") only when it moved.
      personaCtx.clearManualLayer?.();
      const follow = applyPersonaChainAfterProviderSwitch(personaCtx.runtime, personaCtx.registry, personaCtx.chain());
      if (follow.changed) {
        driverBox.current?.notify(formatPersonaChainFollow(follow));
        const from = follow.previous;
        recordPersonaChange({
          workspaceRoot,
          sessionId: driverBox.current?.getSessionId() ?? sessionId,
          to: {
            id: follow.resolved?.definition.id ?? null,
            layers: follow.resolved?.layers ?? { headers: false, body: false, prompt: false },
            // Layer-selection Task 1: the effective qualified ref
            // (absent for plain ids — legacy record shape unchanged).
            ...(follow.spec !== undefined ? { spec: follow.spec } : {}),
          },
          ...(from !== null ? { from: { id: from.definition.id } } : {}),
          coldTurnExpected: follow.breaksCache,
          reason: "provider-switch",
        }).catch(persistFailed);
      }
      const fresh = createCacheTrackingModel(withPersona(createProvider(next, { keyPool, attachments, personaRuntime, onMandatoryRepairApplied: () => { mandatoryRepairArmed.current = true; }, ...streamIdleOpts, onStreamIdleWarning: softWarnSlot.forward }), personaRuntime), {
        // ω99-8b: same-client child calls arrive stamped querySource="subagent"
        // — skip them HERE (the task tool's ω99-8 forwarder owns the subagent
        // row, so the child counts exactly once). Other tags/untagged still record.
        onUsage: (u, _s, _w, src) => {
          if (src === "subagent") return;
          costRegistry.record({ model: liveConfig.model, provider: liveConfig.provider, usage: u });
        },
        // P0-1: the switch rebuild keeps the SAME waste monitor — the
        // row that follows carries coldTurnExpected (skipped as
        // expected), and its baseline re-seeds under the new key.
        onTurnUsage: noteCacheWaste,
        coldFirstTurnAttribution: PROVIDER_SWITCH_COLD_ATTRIBUTION,
        // ω-5a I19: a provider-switch rebuild regenerates the prefix —
        // the advance receipt rides the same seam.
        onWindowAdvance: appendWindowEntry,
        // ω-5a I23: the switch feeds the same monitor (identity is a
        // live closure over liveConfig — it reads the new config).
        coldCache: coldCacheFeed,
        // ω99-24 B: same declaration as the boot wrapper.
        pendingColdAttribution: takePendingBundleColdAttribution,
        mintedFrom: predecessorWindowId,
      });
      setModel(fresh);
      return fresh;
    },
  } satisfies NonNullable<AgentDriverOptions["onProviderSwitch"]>;
}
