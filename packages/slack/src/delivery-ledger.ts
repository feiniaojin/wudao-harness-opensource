// 96 队列 P1-6 — durable delivery-obligation ledger for the Slack gateway's
// FINAL replies (a reference harness gateway/delivery_ledger.py paradigm). A final
// response that was generated but not yet platform-ACKed is the one artifact
// the gateway loses without a trace: the turn already burned its tokens and
// the text lives only in a local. Three checkpoints bracket the send:
//
//   record()          state='pending'     before any send attempt
//   markAttempting()  state='attempting'  immediately before the await
//   markDelivered()   state='delivered'   only on a successful post
//   markFailed()      state='failed'      on a definitive rejection
//
// Storage is an append-only JSONL transition stream (the wudao session-store
// DNA — no sqlite): every line is a full row snapshot and the read side folds
// last-line-per-id wins. Crash ambiguity is explicit and honest:
//
//   pending     — the send never started: redeliver plainly, no dup risk.
//   attempting  — crashed mid-await: the platform MAY already have the
//                 message. Redelivered WITH a visible (recovered) marker —
//                 honest at-least-once, never a silent duplicate.
//   failed      — rejected once; a restart is a natural retry boundary.
//                 Also carries the marker.
//   delivered   — nothing to do; retention prunes.
//   abandoned   — poison guard: attempts reached the cap (no spin).
//
// EVERYTHING here is best-effort by design (红线 1): a ledger failure must
// never block or delay the real send, so all IO exceptions are swallowed
// inside the module with one log line each — unlike hermes, which makes
// callers wrap every call, wudao keeps the try/catch inside so the call face
// stays clean.
//
// All filesystem access is deliberately synchronous: the send seam calls at
// most once per reply, the journal is pruned-bounded, and sync removes any
// interleaving hazard without a lock (Node is single-threaded per process).
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { truncateSafe } from "@wudao/core";
import type { InboundTarget } from "./channel.js";

export type DeliveryState = "pending" | "attempting" | "delivered" | "failed" | "abandoned";

/** One physical JSONL line: a full row snapshot at a transition point. */
export interface DeliveryLedgerLine {
  readonly id: string;
  readonly state: DeliveryState;
  readonly target: { readonly channel: string; readonly threadTs?: string };
  readonly text: string;
  readonly ts?: string;
  readonly reason?: string;
  readonly attempts: number;
  /** ISO timestamp of this transition (fold recency ordering). */
  readonly updatedAt: string;
}

/** A row the startup sweep hands back for redelivery. `withMarker` is the
 *  honesty bit: attempting/failed rows may already sit on the platform, so
 *  their redelivery MUST carry the visible recovered prefix. */
export interface SweptDelivery {
  readonly id: string;
  readonly target: InboundTarget;
  readonly text: string;
  readonly withMarker: boolean;
}

export interface DeliveryLedger {
  /** Record a final reply as owed (state 'pending'); returns the row id. */
  record(target: InboundTarget, text: string): string;
  /** state → 'attempting'; spends one attempt (the poison budget). */
  markAttempting(id: string): void;
  /** state → 'delivered' (ONLY on a successful SendResult). */
  markDelivered(id: string, ts?: string): void;
  /** state → 'failed' (a definitive rejection). */
  markFailed(id: string, reason: string): void;
  /** Startup sweep: claims every non-delivered row (a single daemon means
   *  any such row's owner is a dead process), abandons poison rows, prunes
   *  terminal retention. Never throws. */
  sweep(now?: Date): SweptDelivery[];
}

export interface DeliveryLedgerOptions {
  now?: () => Date;
  /** Poison cap: a row at or over this attempt count sweeps to 'abandoned'. */
  maxAttempts?: number;
  /** Terminal-row retention (delivered + abandoned keep the most recent N). */
  retainRows?: number;
  /** Operational sink for swallowed-IO lines. */
  log?: (line: string) => void;
}

/** The visible prefix for redeliveries that might duplicate an already
 *  received message (crash mid-send / post-rejection retry). Honest
 *  at-least-once — never a silent resend. */
export const RECOVERED_MARKER_LINE = "_(recovered after restart)_";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETAIN_ROWS = 200;

const journalFile = (home: string): string => join(home, "slack-delivery.jsonl");

const STATES: readonly DeliveryState[] = ["pending", "attempting", "delivered", "failed", "abandoned"];

/** Tolerant read side: fold a raw journal into last-line-per-id rows.
 *  Garbage lines (unparseable / id-less / unknown-state) are skipped — a
 *  corrupt line must never hide the rows around it. Pure + exported for
 *  tests and diagnostics. */
export function foldDeliveryJournal(raw: string): Map<string, DeliveryLedgerLine> {
  const rows = new Map<string, DeliveryLedgerLine>();
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const rec = parsed as Record<string, unknown>;
    const id = rec["id"];
    const state = rec["state"];
    const target = rec["target"];
    const text = rec["text"];
    if (typeof id !== "string" || id === "") continue;
    if (typeof state !== "string" || !STATES.includes(state as DeliveryState)) continue;
    if (typeof target !== "object" || target === null) continue;
    if (typeof text !== "string") continue;
    rows.set(id, rec as unknown as DeliveryLedgerLine);
  }
  return rows;
}

export function createDeliveryLedger(home: string, opts: DeliveryLedgerOptions = {}): DeliveryLedger {
  const now = opts.now ?? (() => new Date());
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retainRows = opts.retainRows ?? DEFAULT_RETAIN_ROWS;
  const log = opts.log ?? (() => {});
  const file = journalFile(home);

  // Best-effort wrapper: ONE log line per swallowed failure (红线 1).
  const safe = <T>(op: () => T, fallback: T, what: string): T => {
    try {
      return op();
    } catch (err) {
      log(`slack: delivery ledger ${what} failed (${err instanceof Error ? err.message : String(err)}) — best-effort, send continues`);
      return fallback;
    }
  };

  const readRaw = (): string => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return ""; // missing file = empty journal (first ever send)
    }
  };

  const fold = (): Map<string, DeliveryLedgerLine> => foldDeliveryJournal(readRaw());

  const append = (line: DeliveryLedgerLine): void => {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(line)}\n`);
  };

  /** Append a transition for an existing row, carrying its folded target and
   *  text forward (the marker is compose-time only and never persisted). */
  const transition = (id: string, next: Partial<DeliveryLedgerLine> & { readonly state: DeliveryState }): void => {
    safe(
      () => {
        const row = fold().get(id);
        if (row === undefined) return; // unknown id: nothing to transition
        append({ ...row, ...next, updatedAt: now().toISOString() });
      },
      undefined,
      `mark${next.state === "attempting" ? "Attempting" : next.state === "delivered" ? "Delivered" : "Failed"}`,
    );
  };

  const prune = (): void => {
    safe(
      () => {
        const rows = [...fold().values()];
        const terminal = rows
          .filter((r) => r.state === "delivered" || r.state === "abandoned")
          .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.id < b.id ? -1 : 1));
        if (terminal.length <= retainRows) return; // under the cap: pure append stays cheap
        const drop = new Set(terminal.slice(0, terminal.length - retainRows).map((r) => r.id));
        const keep = rows.filter((r) => !drop.has(r.id));
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, keep.map((r) => `${JSON.stringify(r)}\n`).join(""));
        renameSync(tmp, file); // atomic swap — a crash mid-prune keeps the old journal
      },
      undefined,
      "prune",
    );
  };

  return {
    record(target, text) {
      const id = randomUUID();
      const line: DeliveryLedgerLine = {
        id,
        state: "pending",
        target: { channel: target.channel, ...(target.threadTs !== undefined ? { threadTs: target.threadTs } : {}) },
        text,
        attempts: 0,
        updatedAt: now().toISOString(),
      };
      safe(() => append(line), undefined, "record");
      return id; // the id exists even when the write failed — mark* stays callable
    },
    markAttempting(id) {
      const current = safe(() => fold().get(id)?.attempts, undefined, "read(attempting)");
      if (current === undefined) {
        // The fold failed or the row is gone; still spend a nominal attempt so
        // a broken-read daemon cannot redeliver unboundedly.
        transition(id, { state: "attempting", attempts: 1 });
        return;
      }
      transition(id, { state: "attempting", attempts: current + 1 });
    },
    markDelivered(id, ts) {
      transition(id, { state: "delivered", ...(ts !== undefined ? { ts } : {}) });
    },
    markFailed(id, reason) {
      transition(id, { state: "failed", reason: truncateSafe(reason, 500) }); // 113-A4：失败原因帽代理对安全
    },
    sweep(sweepNow) {
      const moment = sweepNow ?? now();
      return safe(
        () => {
          const out: SweptDelivery[] = [];
          for (const row of fold().values()) {
            if (row.state !== "pending" && row.state !== "attempting" && row.state !== "failed") continue;
            if (row.attempts >= maxAttempts) {
              // Poison guard: cap reached, stop the spin. Kept for inspection
              // until the retention prune takes it.
              append({ ...row, state: "abandoned", updatedAt: moment.toISOString() });
              log(`slack: delivery ${row.id} abandoned after ${row.attempts} attempts — inspect ${file}`);
              continue;
            }
            out.push({
              id: row.id,
              target: row.target,
              text: row.text,
              // pending = send never started → plain redelivery;
              // attempting/failed = ambiguous or rejected → visible marker.
              withMarker: row.state !== "pending",
            });
          }
          prune();
          return out;
        },
        [],
        "sweep",
      );
    },
  };
}
