// ω99-54 — the UUIDv7 session id factory (RFC 9562).
//
// WHY v7: session ids were 8-hex truncations of a v4 UUID — NOT
// time-comparable, which forced store.list() into an N+1 stat-per-file
// mtime sort just to answer "which session is newest". A v7 id embeds a
// 48-bit unix-ms big-endian prefix, so among v7 ids CREATION ORDER IS
// LEXICOGRAPHIC STRING ORDER: list() orders the v7 tier with a plain
// string sort, zero stat calls (store.ts keeps the mtime tier only for
// legacy-shaped ids — see the epoch-boundary law there).
//
// LAYOUT (16 bytes → 8-4-4-4-12 lowercase hex):
//   bytes 0-5   unix_ts_ms, 48-bit big-endian
//   byte  6     version 7 (0b0111) in the high nibble + counter bits 11-8
//   byte  7     counter bits 7-0
//   byte  8     variant 0b10 + 6 random bits
//   bytes 9-15  56 random bits  → rand_b is fully fresh per id
//
// MONOTONIC COUNTER (12 bits, the "random section's" dedicated monotone
// slice — RFC 9562's counter method, counter in rand_a): ids issued within
// the SAME millisecond increment the counter from 0, so same-ms creation
// order == lexicographic order — pure random bits cannot deliver that.
// Capacity: 4096 ids/ms/process (0-based counter, full range). The 4097th
// same-ms id DOES NOT throw — it waits for the clock to cross into the next
// millisecond and continues there (documented choice; the clock seam makes
// that a bounded busy-wait against real Date.now(), sub-millisecond).
//
// CLOCK GUARDS & CAVEATS:
// - Backward wall clock: the factory never re-uses an ms below its last
//   issued one (a NTP step back cannot make a later id sort earlier).
// - Cross-process same-ms: two PROCESSES sharing a millisecond have
//   independent counters AND independent random bits — their interleaving
//   within that ms is not ordered (and skewed clocks can even invert it).
//   The guarantee is per-process same-ms creation order; across
//   milliseconds the 48-bit timestamp dominates.
import { randomBytes } from "node:crypto";

/** The clock seam — inject to pin milliseconds in tests. */
export interface SessionIdClock {
  /** Current unix time in milliseconds. */
  now(): number;
}

/** The production clock: Date.now(). */
export const defaultSessionIdClock: SessionIdClock = { now: (): number => Date.now() };

/** 12-bit counter → 4096 ids per millisecond per factory (per process). */
const COUNTER_LIMIT = 0x1000;

const HEX: readonly string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/** v7 SHAPE gate (lowercase only — the factory's exact output contract).
 *  An uppercase v7 (some other library) classifies as legacy and simply
 *  rides the mtime tier: still ordered, never rejected. */
export function isSessionIdV7(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
}

/** Build an id factory over a clock. The counter state is per factory —
 *  in production the module singleton below means per process. */
export function createSessionIdFactory(clock: SessionIdClock = defaultSessionIdClock): () => string {
  let lastMs = Number.NaN;
  let counter = 0; // the NEXT counter slot to issue inside lastMs
  return (): string => {
    let ms = clock.now();
    if (ms < lastMs) ms = lastMs; // backward wall clock: never step down
    if (!(ms <= lastMs)) {
      // first call, or the clock moved forward — a fresh millisecond.
      lastMs = ms;
      counter = 0;
    }
    if (counter >= COUNTER_LIMIT) {
      // Same-ms overflow (the 4097th id): wait for the NEXT millisecond —
      // never throw, never reuse an id.
      do {
        ms = clock.now();
      } while (ms <= lastMs);
      lastMs = ms;
      counter = 0;
    }
    const slot = counter;
    counter += 1;
    const bytes = new Uint8Array(16);
    // 48-bit unix_ms big-endian.
    bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
    bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
    bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
    bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
    bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
    bytes[5] = ms & 0xff;
    // version 7 + monotone counter (12 bits) in rand_a.
    bytes[6] = 0x70 | (slot >> 8);
    bytes[7] = slot & 0xff;
    // variant 10 + 62 fresh random bits (rand_b).
    const rnd = randomBytes(8);
    bytes[8] = 0x80 | ((rnd[0] ?? 0) & 0x3f);
    bytes.set(rnd.subarray(1), 9);
    // 8-4-4-4-12 lowercase hex.
    let out = "";
    for (let i = 0; i < 16; i += 1) {
      out += HEX[bytes[i] ?? 0];
      if (i === 3 || i === 5 || i === 7 || i === 9) out += "-";
    }
    return out;
  };
}

const defaultFactory: () => string = createSessionIdFactory();

/** A fresh v7 session id — the one production seam (module singleton, so
 *  the monotonic counter is per process). */
export function newSessionId(): string {
  return defaultFactory();
}
