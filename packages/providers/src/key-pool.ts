// M56 §1 (hive llm/key_pool.py) — the multi-key pool. Domestic providers
// rate-limit PER KEY (RPM quotas per credential), so a harness aimed at them
// pools N keys and rotates. Semantics (the hive contract, pinned by tests):
//
//   round-robin   selection advances a cursor over the deduped key list;
//   cooldown      a key that just took a KEY-SIDE failure is skipped — 夜移 007
//                 (hermes port) keys this by HTTP status class: 401/403 = the
//                 credential is dead → `authCooldownMs` (default 15min, it
//                 must stop re-entering rotation); 429 = rate/fleet limit →
//                 `cooldownMs` (default 60s, the M56 contract); provider-side
//                 statuses (5xx…) cool NOTHING — penalizing keys over the
//                 provider's own outage starves the pool for no gain;
//   soonest-expiring fallback
//                 when EVERY key is cooling, selection returns the key whose
//                 cooldown expires soonest — "so the caller can proceed with
//                 minimal delay... no sleep required". The retry ladder's
//                 backoff absorbs the wait; a single-key pool therefore keeps
//                 the historical single-key behavior exactly (same key, same
//                 ladder). A dead key in a one-key pool thus fails every
//                 request — correct: the retry ladder deliberately does NOT
//                 retry 401/403 (a wrong key is a config problem, not a
//                 transient; fail fast, diverging from hermes's rotate-on-auth
//                 on purpose).
//
// Key selection happens per REQUEST (inside each HTTP attempt): the key rides
// only the Authorization header, never the body, so rotating mid-session or
// mid-retry cannot disturb the prompt prefix (M24 cache invariant).
import { parseApiKeyPool } from "./config.js";

/** The /status + statusline shape: `keys n/m`. */
export interface KeyPoolSnapshot {
  readonly total: number;
  readonly available: number;
  readonly cooling: number;
}

/**
 * 夜移 007 (hermes credential-pool port): cooldowns are keyed by HTTP status
 * class, not "was it a 429". `auth` (401/403 — the credential is dead) cools
 * LONG so a revoked key stops re-entering rotation; `rate` (429) keeps the M56
 * 60s contract; provider-side failures cool NOTHING (penalizing keys over the
 * provider's own outage starves the pool for no gain).
 */
export type CooldownClass = "auth" | "rate";

/** 401/403 → auth; 429 → rate; everything else → null (never cool the key). */
export function cooldownClassForStatus(status: number): CooldownClass | null {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate";
  return null;
}

export interface KeyPool {
  /** The key for the next request (round-robin, cooldown-aware). */
  select(): string;
  /** Put a key into cooldown (no-op for unknown keys). Without a class the
   *  M56 rate contract applies — existing call sites keep their behavior. */
  markCooldown(key: string, cls?: CooldownClass): void;
  /** Live counts for /status and the statusline. */
  snapshot(): KeyPoolSnapshot;
  readonly size: number;
}

export interface KeyPoolOptions {
  /** Cooldown after a 429; default 60s (WUDAO key cooldown contract). */
  readonly cooldownMs?: number;
  /** Cooldown after a 401/403 (dead credential); default 15min. */
  readonly authCooldownMs?: number;
  /** Injectable clock (tests); default Date.now. */
  readonly now?: () => number;
}

export const DEFAULT_KEY_COOLDOWN_MS = 60_000;
export const DEFAULT_AUTH_COOLDOWN_MS = 900_000;

/** Build a pool from raw keys (deduped, order-preserving). Throws on empty —
 *  a pool with no key is a configuration error, not a runtime state. */
export function createKeyPool(rawKeys: readonly string[], options: KeyPoolOptions = {}): KeyPool {
  const keys = canonicalKeys(rawKeys);
  if (keys.length === 0) throw new Error("key pool needs at least one API key");

  const cooldownMs = options.cooldownMs ?? DEFAULT_KEY_COOLDOWN_MS;
  const authCooldownMs = options.authCooldownMs ?? DEFAULT_AUTH_COOLDOWN_MS;
  const now = options.now ?? Date.now;
  /** key → epoch-ms when its cooldown lapses. */
  const coolingUntil = new Map<string, number>();
  let cursor = 0;

  const isCooling = (key: string, t: number): boolean => (coolingUntil.get(key) ?? 0) > t;

  return {
    get size(): number {
      return keys.length;
    },
    select(): string {
      const t = now();
      // First available key at/after the cursor (wrap-around included).
      for (let i = 0; i < keys.length; i += 1) {
        const idx = (cursor + i) % keys.length;
        const key = keys[idx]!;
        if (!isCooling(key, t)) {
          cursor = (idx + 1) % keys.length;
          return key;
        }
      }
      // All cooling: the soonest-expiring key — minimal delay, no sleep.
      let best = keys[0]!;
      let bestUntil = coolingUntil.get(best) ?? 0;
      for (const key of keys) {
        const until = coolingUntil.get(key) ?? 0;
        if (until < bestUntil) {
          best = key;
          bestUntil = until;
        }
      }
      const idx = keys.indexOf(best);
      cursor = (idx + 1) % keys.length;
      return best;
    },
    markCooldown(key: string, cls: CooldownClass = "rate"): void {
      if (!keys.includes(key)) return;
      const until = now() + (cls === "auth" ? authCooldownMs : cooldownMs);
      // Never SHORTEN an existing cooldown (the max wins on repeat hits —
      // including cross-class: a 429 on an auth-cooling key extends nothing).
      if (until > (coolingUntil.get(key) ?? 0)) coolingUntil.set(key, until);
    },
    snapshot(): KeyPoolSnapshot {
      const t = now();
      let cooling = 0;
      for (const key of keys) if (isCooling(key, t)) cooling += 1;
      return { total: keys.length, available: keys.length - cooling, cooling };
    },
  };
}

/** Convenience: the env's pool, as `createKeyPool` wants it (may be empty —
 *  resolution is the caller's failure to explain). */
export function keyPoolFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseApiKeyPool(env);
}

/** Trim + dedup (order-preserving) — the pool's canonicalization of a raw
 *  key list, shared by the static and live factories. */
function canonicalKeys(rawKeys: readonly string[]): string[] {
  const keys: string[] = [];
  for (const k of rawKeys) {
    const trimmed = k.trim();
    if (trimmed !== "" && !keys.includes(trimmed)) keys.push(trimmed);
  }
  return keys;
}

/**
 * The LIVE pool — keys read from `getKeys` on EVERY select/snapshot, not
 * captured at construction (2026-08-31 minimax-401 弧).
 *
 * The session engine used to build ONE static `createKeyPool` at boot and
 * hand that object to every client rebuilt at a `/provider` switch; the
 * adapters treat an explicit pool as authoritative (`options.keyPool ??
 * own-config pool`), so a switched provider authenticated with the BOOT
 * provider's key — `401 login fail` on every retry. The bug's class: key
 * state derived once from the boot config and surviving config changes —
 * a SECOND key store that can silently disagree with the config that built
 * the current client.
 *
 * The fix is structural, not disciplinary (no "remember to reseed" at every
 * future build site): the live pool HAS no independent key list. Wired to
 * the engine's ONE mutable config holder (the S2b doctrine — the switch
 * seam syncs it in place before every rebuild), it structurally cannot
 * serve a key the current config does not carry. Rotation/cooldown
 * semantics are the static pool's; cooldowns stay keyed by key VALUE, so
 * a key that survives a config change keeps its cooldown, and a key that
 * leaves the config takes its cooldown with it.
 */
export function createLiveKeyPool(
  getKeys: () => readonly string[],
  options: KeyPoolOptions = {},
): KeyPool {
  // Fail-fast at construction, exactly like the static pool: a getter that
  // yields nothing is a configuration error, not a runtime state.
  if (canonicalKeys(getKeys()).length === 0) throw new Error("key pool needs at least one API key");

  const cooldownMs = options.cooldownMs ?? DEFAULT_KEY_COOLDOWN_MS;
  const authCooldownMs = options.authCooldownMs ?? DEFAULT_AUTH_COOLDOWN_MS;
  const now = options.now ?? Date.now;
  /** key → epoch-ms when its cooldown lapses (values only — config-proof). */
  const coolingUntil = new Map<string, number>();
  let cursor = 0;

  const isCooling = (key: string, t: number): boolean => (coolingUntil.get(key) ?? 0) > t;

  return {
    get size(): number {
      return canonicalKeys(getKeys()).length;
    },
    select(): string {
      const keys = canonicalKeys(getKeys());
      // The holder mutated to empty mid-session (nothing upstream validates
      // it): fail LOUD here rather than silently serving a stale key — that
      // silence is exactly the 401 this pool exists to make impossible.
      if (keys.length === 0) throw new Error("key pool needs at least one API key");
      const t = now();
      // First available key at/after the cursor (wrap-around included) —
      // modulo the CURRENT length, so a list that shrank or grew never
      // indexes out of range or pins a dead position.
      for (let i = 0; i < keys.length; i += 1) {
        const idx = (cursor + i) % keys.length;
        const key = keys[idx]!;
        if (!isCooling(key, t)) {
          cursor = (idx + 1) % keys.length;
          return key;
        }
      }
      // All cooling: the soonest-expiring CURRENT key (same contract).
      let best = keys[0]!;
      let bestUntil = coolingUntil.get(best) ?? 0;
      for (const key of keys) {
        const until = coolingUntil.get(key) ?? 0;
        if (until < bestUntil) {
          best = key;
          bestUntil = until;
        }
      }
      const idx = keys.indexOf(best);
      cursor = (idx + 1) % keys.length;
      return best;
    },
    markCooldown(key: string, cls: CooldownClass = "rate"): void {
      if (!canonicalKeys(getKeys()).includes(key)) return;
      const until = now() + (cls === "auth" ? authCooldownMs : cooldownMs);
      // Never SHORTEN an existing cooldown (the max wins on repeat hits —
      // including cross-class: a 429 on an auth-cooling key extends nothing).
      if (until > (coolingUntil.get(key) ?? 0)) coolingUntil.set(key, until);
    },
    snapshot(): KeyPoolSnapshot {
      const keys = canonicalKeys(getKeys());
      const t = now();
      let cooling = 0;
      for (const key of keys) if (isCooling(key, t)) cooling += 1;
      return { total: keys.length, available: keys.length - cooling, cooling };
    },
  };
}
