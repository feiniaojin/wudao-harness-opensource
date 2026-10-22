// 96 队列 P1-6 — the delivery ledger in isolation: the three-checkpoint
// state machine (pending → attempting → delivered/failed) over an append-only
// JSONL whose read side folds last-line-per-id wins, the poison-row attempts
// cap, the honest-marker sweep truth table, the retention prune, and the
// best-effort discipline (红线 1: a broken ledger home NEVER throws out of
// record/mark*/sweep — the ledger exists to prevent loss, never to cause it).
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDeliveryLedger,
  foldDeliveryJournal,
  type DeliveryLedgerLine,
} from "../src/delivery-ledger.js";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "wudao-ledger-"));
}

const journalPath = (home: string): string => join(home, "slack-delivery.jsonl");

function rawLines(home: string): DeliveryLedgerLine[] {
  return readFileSync(journalPath(home), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as DeliveryLedgerLine);
}

const fold = (home: string) => foldDeliveryJournal(readFileSync(journalPath(home), "utf8"));

const target = { channel: "C1", threadTs: "111.000" };

describe("three checkpoints (append-only transitions, fold last-wins)", () => {
  it("record → attempting → delivered: every step appends; the fold keeps the last state", () => {
    const home = tmpHome();
    const ledger = createDeliveryLedger(home);
    const id = ledger.record(target, "final answer");
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    let rows = fold(home);
    expect(rows.get(id)?.state).toBe("pending");
    expect(rows.get(id)?.attempts).toBe(0);
    expect(rows.get(id)?.text).toBe("final answer");
    expect(rows.get(id)?.target).toEqual({ channel: "C1", threadTs: "111.000" });

    ledger.markAttempting(id);
    rows = fold(home);
    expect(rows.get(id)?.state).toBe("attempting");
    expect(rows.get(id)?.attempts).toBe(1);

    ledger.markDelivered(id, "1234.0005");
    rows = fold(home);
    expect(rows.get(id)?.state).toBe("delivered");
    expect(rows.get(id)?.ts).toBe("1234.0005");
    expect(rows.get(id)?.attempts).toBe(1); // delivery does not spend a new attempt

    // append-only: three transitions = three physical lines, nothing rewritten.
    expect(rawLines(home).length).toBe(3);
  });

  it("markFailed keeps the reason and the attempts count", () => {
    const home = tmpHome();
    const ledger = createDeliveryLedger(home);
    const id = ledger.record(target, "boom-text");
    ledger.markAttempting(id);
    ledger.markFailed(id, "channel_not_found");
    const row = fold(home).get(id);
    expect(row?.state).toBe("failed");
    expect(row?.reason).toBe("channel_not_found");
    expect(row?.attempts).toBe(1);
  });

  it("a target without threadTs roundtrips", () => {
    const home = tmpHome();
    const ledger = createDeliveryLedger(home);
    const id = ledger.record({ channel: "C2" }, "top-level reply");
    expect(fold(home).get(id)?.target).toEqual({ channel: "C2" });
  });

  it("marks against an unknown id are no-ops (never throw, never write)", () => {
    const home = tmpHome();
    const ledger = createDeliveryLedger(home);
    expect(() => {
      ledger.markAttempting("nope");
      ledger.markDelivered("nope", "1.0");
      ledger.markFailed("nope", "x");
    }).not.toThrow();
    expect(existsSync(journalPath(home))).toBe(false); // nothing was ever written
  });
});

describe("foldDeliveryJournal (tolerant read side)", () => {
  it("last line per id wins; garbage lines are skipped, never fatal", () => {
    const home = tmpHome();
    const good1 = JSON.stringify({ id: "a", state: "pending", target, text: "t", attempts: 0, updatedAt: "2026-01-01T00:00:00.000Z" });
    const good2 = JSON.stringify({ id: "a", state: "delivered", target, text: "t", ts: "9.9", attempts: 1, updatedAt: "2026-01-01T00:00:01.000Z" });
    const good3 = JSON.stringify({ id: "b", state: "failed", target, text: "u", reason: "r", attempts: 2, updatedAt: "2026-01-01T00:00:02.000Z" });
    writeFileSync(
      journalPath(home),
      ["this is not json", good1, "{broken", JSON.stringify({ state: "pending" }), good2, good3, ""].join("\n"),
    );
    const rows = fold(home);
    expect(rows.size).toBe(2);
    expect(rows.get("a")?.state).toBe("delivered"); // last wins
    expect(rows.get("b")?.state).toBe("failed");
  });
});

describe("sweep (startup redelivery claims)", () => {
  it("returns pending/attempting/failed with the marker truth table; excludes delivered", () => {
    const home = tmpHome();
    const ledger = createDeliveryLedger(home);
    const pending = ledger.record(target, "p");
    const attempting = ledger.record(target, "a");
    ledger.markAttempting(attempting);
    const failed = ledger.record(target, "f");
    ledger.markAttempting(failed);
    ledger.markFailed(failed, "not_in_channel");
    const delivered = ledger.record(target, "d");
    ledger.markAttempting(delivered);
    ledger.markDelivered(delivered);

    const swept = ledger.sweep();
    const byId = new Map(swept.map((r) => [r.id, r]));
    expect(swept.length).toBe(3);
    expect(byId.get(pending)?.withMarker).toBe(false); // send never started — no dup risk
    expect(byId.get(attempting)?.withMarker).toBe(true); // crash mid-await — ambiguous
    expect(byId.get(failed)?.withMarker).toBe(true); // rejected once — retry boundary
    expect(byId.has(delivered)).toBe(false);
    for (const r of swept) {
      expect(typeof r.text).toBe("string");
      expect(r.target.channel).toBe("C1");
    }
  });

  it("poison guard: attempts ≥ 3 transitions to abandoned and never sweeps again", () => {
    const home = tmpHome();
    const ledger = createDeliveryLedger(home);
    const id = ledger.record(target, "poison");
    ledger.markAttempting(id); // 1
    ledger.markFailed(id, "e1");
    ledger.markAttempting(id); // 2
    ledger.markFailed(id, "e2");
    ledger.markAttempting(id); // 3
    ledger.markFailed(id, "e3");
    expect(ledger.sweep()).toEqual([]);
    expect(fold(home).get(id)?.state).toBe("abandoned");
    expect(ledger.sweep()).toEqual([]); // abandoned stays excluded
  });

  it("maxAttempts is injectable (the cap, not the semantics, is the knob)", () => {
    const home = tmpHome();
    const ledger = createDeliveryLedger(home, { maxAttempts: 1 });
    const id = ledger.record(target, "one-shot");
    ledger.markAttempting(id);
    expect(ledger.sweep()).toEqual([]);
    expect(fold(home).get(id)?.state).toBe("abandoned");
  });
});

describe("retention prune (sweep 时顺带)", () => {
  it("terminal rows cap at the most recent 200; live rows are never pruned", () => {
    const home = tmpHome();
    let tick = 0;
    const ledger = createDeliveryLedger(home, { now: () => new Date(1_000_000 + tick * 1000) });
    for (let i = 0; i < 205; i += 1) {
      tick = i;
      const id = ledger.record({ channel: "C" }, `text-${i}`);
      ledger.markAttempting(id);
      ledger.markDelivered(id);
    }
    tick = 999;
    const live = ledger.record({ channel: "C" }, "still-owed");
    ledger.markAttempting(live);

    const swept = ledger.sweep();
    const rows = fold(home);
    const terminal = [...rows.values()].filter((r) => r.state === "delivered" || r.state === "abandoned");
    expect(terminal.length).toBe(200); // capped
    expect(rows.get(live)?.state).toBe("attempting"); // live survives
    expect([...rows.values()].some((r) => r.text === "text-0")).toBe(false); // oldest dropped
    expect([...rows.values()].some((r) => r.text === "text-4")).toBe(false);
    expect([...rows.values()].some((r) => r.text === "text-5")).toBe(true); // newest 200 kept
    expect([...rows.values()].some((r) => r.text === "text-204")).toBe(true);
    expect(swept.length).toBe(1); // only the live row
    expect(swept[0]?.text).toBe("still-owed");
  });

  it("below the cap the journal is not rewritten (pure append stays cheap)", () => {
    const home = tmpHome();
    const ledger = createDeliveryLedger(home);
    const id = ledger.record(target, "small");
    ledger.markAttempting(id);
    ledger.markDelivered(id);
    const before = rawLines(home).length;
    ledger.sweep();
    expect(rawLines(home).length).toBe(before); // untouched — no collapse, no rewrite
  });
});

describe("best-effort discipline (红线 1: the ledger never blocks a send)", () => {
  it("an unwritable home: record still returns an id; mark*/sweep all swallow with one log line", () => {
    const blocker = join(tmpdir(), `wudao-ledger-block-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    writeFileSync(blocker, "i am a file, not a directory");
    const logs: string[] = [];
    const ledger = createDeliveryLedger(join(blocker, "sub", "home"), { log: (l) => logs.push(l) });
    let id = "";
    expect(() => {
      id = ledger.record(target, "text");
    }).not.toThrow();
    expect(typeof id).toBe("string");
    expect(() => ledger.markAttempting(id)).not.toThrow();
    expect(() => ledger.markDelivered(id, "1.0")).not.toThrow();
    expect(() => ledger.markFailed(id, "x")).not.toThrow();
    expect(() => ledger.sweep()).not.toThrow();
    expect(ledger.sweep()).toEqual([]);
    expect(logs.length).toBeGreaterThan(0); // failures are visible, not silent
  });
});
