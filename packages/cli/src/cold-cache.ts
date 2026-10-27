// ω-5a I23 — cold-cache PRE-SEND warning (the r36/r37 import, deepagents
// 8d2298ff5 semantics): every cache signal wudao has fires AFTER the tokens
// are spent (the cold tag, the miss-spike warning, the receipts). This
// module estimates, BEFORE a run starts, that the prefix is probably cold
// (idle past the provider's cache window, identity changed, age unknown).
//
// v1 posture (design Q2): non-blocking, once-per-session notice. The
// deepagents blocking modal (send-anyway / mute-session / suppress-forever)
// and any pricing-delta threshold are deferred. Wrong-window estimates erode
// trust, so the policy table is DeepSeek-only (documented window); every
// other provider reads "unknown" and the predictor stays SILENT.
import { createHash } from "node:crypto";

export type ColdCacheReason = "idle" | "age_unknown" | "identity_changed";

export interface ColdCachePolicy {
  readonly windowSeconds?: number;
  readonly windowKind: "maximum" | "minimum" | "unknown"; // deepagents 8d2298ff5 semantics
}

/** Cli-side table (NOT providers/src/models.ts — that package is the ω-2b
 *  seam). Keyed by provider profile name; DeepSeek = the documented cache
 *  window read as a MAXIMUM (definitely expired past it), GLM/Qwen entries
 *  only once documented; everything else "unknown" → the predictor stays
 *  silent (the 107980e38 trusted-endpoint discipline). */
export const COLD_CACHE_POLICIES: Readonly<Record<string, ColdCachePolicy>> = {
  // DeepSeek, context caching: "Once the cache is no longer in use, it will
  // be automatically cleared, usually within a few hours to a few days."
  // (api-docs.deepseek.com/guides/kv_cache) — a documented RANGE: the
  // maximum (definitely-expired) bound is its top, read as 3 days.
  deepseek: { windowSeconds: 3 * 24 * 3600, windowKind: "maximum" },
};

/** The "last-warm identity": baseURL + model + effort params, hashed —
 *  whatever changes the request bytes changes the identity. */
export function coldCacheIdentity(cfg: {
  readonly baseURL?: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}): string {
  return createHash("sha256").update(`${cfg.baseURL ?? ""}\n${cfg.model}\n${cfg.reasoningEffort ?? ""}`).digest("hex").slice(0, 16);
}

export interface ColdCacheCheckpoint {
  /** baseURL + model + effort params, hashed — the "last-warm identity". */
  readonly identity: string;
  readonly promptTokens: number;
  /** Epoch ms of the last observed warm usage row. */
  readonly at: number;
}

export interface ColdCachePrediction {
  readonly reason: ColdCacheReason;
  /** maximum window → expired; minimum → may-be-cold. */
  readonly confidence: "expired" | "may-be-cold";
  readonly idleSeconds: number;
  /** ≈ checkpoint.promptTokens — the re-warm size, no pricing table. */
  readonly reprocessTokens: number;
}

/** Rules (order matters):
 *   no checkpoint → undefined (a fresh session has nothing warm to lose; a
 *     resumed history with no checkpoint is equally silent — its size is
 *     unmeasured and a resume-minted prefix is already cold by doctrine).
 *   malformed/zero-time checkpoint → age_unknown — NEVER reported as a model
 *     change (the 8d2298ff5 rule: a bad checkpoint must not masquerade as
 *     an identity claim).
 *   identity mismatch → identity_changed (definitive — knowable without
 *     provider docs).
 *   checkpoint age > maximum window → idle/expired; > minimum window →
 *     idle/may-be-cold.
 *   unknown policy / no documented window → undefined (stay silent). */
export function predictColdCache(input: {
  readonly checkpoint: ColdCacheCheckpoint | undefined;
  readonly identityNow: string;
  readonly historyLength: number;
  readonly now: number;
  readonly policy: ColdCachePolicy;
}): ColdCachePrediction | undefined {
  const { checkpoint, identityNow, now, policy } = input;
  if (checkpoint === undefined) return undefined;
  const malformed = !Number.isFinite(checkpoint.at) || checkpoint.at <= 0 || typeof checkpoint.identity !== "string" || checkpoint.identity === "";
  if (malformed) {
    return { reason: "age_unknown", confidence: "may-be-cold", idleSeconds: 0, reprocessTokens: checkpoint.promptTokens };
  }
  const idleSeconds = Math.max(0, (now - checkpoint.at) / 1000);
  if (checkpoint.identity !== identityNow) {
    return { reason: "identity_changed", confidence: "expired", idleSeconds, reprocessTokens: checkpoint.promptTokens };
  }
  if (policy.windowKind === "unknown") return undefined;
  const window = policy.windowSeconds;
  if (window === undefined || !Number.isFinite(window)) return undefined;
  if (idleSeconds > window) {
    return policy.windowKind === "maximum"
      ? { reason: "idle", confidence: "expired", idleSeconds, reprocessTokens: checkpoint.promptTokens }
      : { reason: "idle", confidence: "may-be-cold", idleSeconds, reprocessTokens: checkpoint.promptTokens };
  }
  return undefined;
}

/** One per session (the session engine owns it): fed by the cache wrapper
 *  (noteUsage, once per observed usage row — the checkpoint holds the
 *  LATEST), consulted by the driver at the top of startRun (preSend). */
export class ColdCacheMonitor {
  private checkpoint: ColdCacheCheckpoint | undefined;
  private warned = false;

  constructor(private readonly policy: ColdCachePolicy = { windowKind: "unknown" }) {}

  noteUsage(identity: string, promptTokens: number, now: number = Date.now()): void {
    this.checkpoint = { identity, promptTokens, at: now };
  }

  preSend(identityNow: string, historyLength: number, now: number = Date.now()): ColdCachePrediction | undefined {
    return predictColdCache({ checkpoint: this.checkpoint, identityNow, historyLength, now, policy: this.policy });
  }

  /** The mute: fires at most ONCE per session, then stays silent until
   *  reset. Pass the preSend result through this to consume it. */
  consumeWarning(p: ColdCachePrediction | undefined): ColdCachePrediction | undefined {
    if (p === undefined || this.warned) return undefined;
    this.warned = true;
    return p;
  }

  reset(): void {
    this.warned = false;
  }
}
