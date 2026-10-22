// 波次 7 #37 (the reference harness C1): the provider-level 429 pause window.
//
// The M56 key pool already handles the KEY dimension of a 429 — the limited
// key cools for every request through the shared pool. What it cannot handle
// is the PROVIDER dimension under concurrency: with a single key (or every
// key cooling), each concurrent request still enters its OWN retry ladder and
// hammers a provider that just said "stop" — under subagent fanout, N
// requests burn N ladders against the same rate limit (the self-harm CodeWhale
//'s C1 exists for). The window closes that gap:
//
//   trip()   — called at the HTTP boundary the moment a 429 arrives while the
//              key pool has no healthy spare to rotate to (single-key, or all
//              cooling). Deadline = the response's Retry-After when present,
//              else the 60s rate-class default; never above the ladder's
//              Retry-After trust cap, and never SHORTER than an existing
//              deadline.
//   wait()   — the leg entry gate, before every generate/stream call. While a
//              pause is active the caller re-checks the clock in ≤250ms
//              slices (CodeWhale's sliced re-check) and fires its first HTTP
//              attempt only after the window lapses. The originator's own
//              ladder retries are NOT gated (they sit INSIDE one leg call): a
//              transient 429 still recovers on its normal backoff — today's
//              behavior, byte-for-byte.
//   clear()  — any 2xx proves the pause stale (the blip recovered); the next
//              concurrent request enters immediately.
//
// The window is created once per provider factory closure (keyPool topology)
// and injectable whole through ProviderOptions.ratePauseWindow — tests drive
// it with a fake clock/sleep pair, embedders can share one window across
// protocol factories behind a single endpoint.
import { RETRY_AFTER_FAIL_CAP_MS } from "./retry-after.js";

/** Slice ceiling for the sliced re-check loop (the reference harness C1's 250ms). */
export const RATE_PAUSE_SLICE_MS = 250;

/** Default pause when a 429 carries no Retry-After — the key pool's rate
 *  class cooldown (60s), so the provider dimension and the key dimension
 *  agree on how long a rate signal lasts. */
export const DEFAULT_RATE_PAUSE_MS = 60_000;

export interface RatePauseWindow {
  /** Wait out any active pause in ≤250ms slices; an abort signal breaks the
   *  loop with AbortError (the ladder never retries aborts — the caller's
   *  cancel survives the pause). No-op when idle. */
  wait(signal?: AbortSignal): Promise<void>;
  /** Extend the pause deadline (never shorten; clamped to the trust cap). */
  trip(pauseMs: number): void;
  /** A successful response proves the pause stale — reset to idle. */
  clear(): void;
  /** Current deadline in epoch ms; 0 when idle (assertions/observability). */
  until(): number;
}

export interface RatePauseOptions {
  /** Injectable clock (tests); default Date.now. */
  readonly now?: () => number;
  /** Injectable sleep (tests); default setTimeout-based. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Slice ceiling for wait(); default RATE_PAUSE_SLICE_MS. */
  readonly sliceMs?: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRatePauseWindow(options: RatePauseOptions = {}): RatePauseWindow {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const sliceMs = options.sliceMs ?? RATE_PAUSE_SLICE_MS;
  let deadline = 0;

  const aborted = (signal: AbortSignal): Error => {
    const err = new Error("aborted while waiting out the provider rate pause");
    err.name = "AbortError";
    return err;
  };

  return {
    async wait(signal?: AbortSignal): Promise<void> {
      while (deadline > now()) {
        if (signal?.aborted === true) throw aborted(signal);
        const remaining = deadline - now();
        await sleep(Math.min(sliceMs, remaining));
      }
    },
    trip(pauseMs: number): void {
      const clamped = Math.max(0, Math.min(pauseMs, RETRY_AFTER_FAIL_CAP_MS));
      deadline = Math.max(deadline, now() + clamped);
    },
    clear(): void {
      deadline = 0;
    },
    until(): number {
      return deadline;
    },
  };
}
