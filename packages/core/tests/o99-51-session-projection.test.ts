// ω99-51 — session projection seam pilot (todo domain + constitution line).
//
// The base (packages/core/src/session/projection.ts) owns the generic
// machinery: defineProjection (pure domain unit: key/init/apply) +
// createProjectionDriver (feed/reset/snapshot/subscribe, two Object.is
// gates). The first registered unit is the todo fold
// (session/todo-projection.ts): state = the LAST board-bearing message's
// raw content + parse — the verbatim semantics of the plan-review backscan
// (packages/cli/src/plan.ts lastTodoBoard), measured T0: consumers scan the
// LIVE message chain (post branch-projection, post tier-2 wholesale
// replacement, post stub), so the fold is fed that same sequence and the
// equivalence below is by-construction against a reference backscan whose
// predicate is copied verbatim from lastTodoBoard.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTodoBoard } from "../src/tools/todo.js";
import { createProjectionDriver, defineProjection } from "../src/session/projection.js";
import { todoProjection } from "../src/session/todo-projection.js";
import type { ProjectionSnapshot } from "../src/session/projection.js";
import type { AgentMessage } from "../src/types.js";

// ---- fixtures ---------------------------------------------------------------

const u = (content: string): AgentMessage => ({ role: "user", content });
const a = (content: string): AgentMessage => ({ role: "assistant", content });
const tool = (toolCallId: string, name: string, content: string): AgentMessage => ({
  role: "tool",
  toolCallId,
  name,
  content,
});

const BOARD_V1 = "[todo board 0/3 done]\n☐ explore the code\n☐ write the plan\n☐ verify";
const BOARD_V2 = "[todo board 2/3 done]\n☑ explore the code\n☑ write the plan\n◐ verify";
// M23 §2 tier-2 restore shape: the board survives compaction as a user
// message whose header line carries the (restored) suffix — still parseable.
const BOARD_RESTORED = "[todo board 2/3 done](restored)\n☑ explore the code\n☑ write the plan\n◐ verify";
const SUMMARY = "[compacted summary] Task: fix the login bug\nthe auth module was explored…";
// ω-2b stub shape (compaction.ts stubResult) — NOT parseable as a board.
const STUB =
  '[compacted tool_result t3: [todo board 0/1 done] ☐ old…] — full original retained in this session; recover with session_result(tool_call_id="t3", result_ref="sha256:…")';

/** Reference backscan — predicate and value extraction copied verbatim from
 *  packages/cli/src/plan.ts lastTodoBoard (the old path this pilot retires
 *  from the plan-review consumers). */
function referenceLastBoard(messages: readonly AgentMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m !== undefined && parseTodoBoard(m.content) !== undefined) return m.content;
  }
  return undefined;
}

/** Recorded entry-sequence corpus: real shapes the live chain takes —
 *  todo writes, interleaved foreign tool results, the tier-2 replacement
 *  form ([summary, restored board, …tail]), a stubbed old board, and
 *  board-less chains. */
const CORPUS: readonly { readonly name: string; readonly messages: readonly AgentMessage[] }[] = [
  {
    name: "todo writes interleaved with foreign tool results",
    messages: [
      u("fix the login bug"),
      a("on it — reading the module first"),
      tool("t1", "read_file", "export function login() {\n  …\n}"),
      tool("t2", "todo_write", BOARD_V1),
      a("board written; exploring"),
      tool("t3", "grep", "src/auth/login.ts:12:…"),
      tool("t4", "todo_write", BOARD_V2),
      a("done — the plan items are complete"),
    ],
  },
  {
    name: "tier-2 replacement form: summary + restored board + kept tail",
    messages: [
      u(SUMMARY),
      u(BOARD_RESTORED),
      a("continuing after the compaction boundary"),
      tool("t9", "grep", "3 matches"),
      a("finished the verification"),
    ],
  },
  {
    name: "tier-2 replacement form without a board in the compacted span",
    messages: [u(SUMMARY), a("no board survived"), tool("t5", "read_file", "plain bytes"), a("done")],
  },
  {
    name: "stubbed old board — the last parseable board wins earlier",
    messages: [
      u("long task"),
      tool("t1", "todo_write", BOARD_V1),
      a("mid-flight"),
      tool("t2", "todo_write", BOARD_V2),
      tool("t3", "read_file", STUB),
      a("wrapped up"),
    ],
  },
  {
    name: "board-less chain",
    messages: [u("hello"), a("hi"), tool("t1", "shell", "ok"), a("bye")],
  },
  {
    name: "board mid-chain, none later",
    messages: [u("task"), tool("t2", "todo_write", BOARD_V1), a("ack"), tool("t3", "read_file", "x")],
  },
];

// ---- acceptance 1: equivalence vs the old backscan, at EVERY prefix -------

describe("ω99-51 todo projection equivalence (acceptance 1)", () => {
  for (const { name, messages } of CORPUS) {
    it(`fold ≡ reference backscan at every prefix — ${name}`, () => {
      const driver = createProjectionDriver(todoProjection);
      for (let k = 0; k <= messages.length; k += 1) {
        driver.reset();
        for (let i = 0; i < k; i += 1) driver.feed(messages[i] as AgentMessage);
        const got = driver.snapshot().state.content;
        const want = referenceLastBoard(messages.slice(0, k));
        expect(got).toBe(want);
        if (got !== undefined) {
          // verbatim equality also means the fold's parse matches the old
          // path's parse of the same content.
          expect(driver.snapshot().state.board).toEqual(parseTodoBoard(got));
        }
      }
    });
  }
});

// ---- acceptance 2/3: the two Object.is gates + the whole-value rule -------

describe("ω99-51 projection driver mechanics (acceptances 2 and 3)", () => {
  it("Object.is gate: M todo-irrelevant messages → zero notifications, same snapshot reference", () => {
    const driver = createProjectionDriver(todoProjection);
    const seen: ProjectionSnapshot<{ content: string | undefined; board: ReturnType<typeof parseTodoBoard> }>[] = [];
    const off = driver.subscribe((snap) => seen.push(snap));
    const before = driver.snapshot();
    for (const m of [u("hello"), a("hi"), tool("t1", "read_file", "plain bytes"), u(SUMMARY)]) {
      driver.feed(m);
    }
    expect(seen).toHaveLength(0);
    expect(driver.snapshot()).toBe(before); // identical reference — nothing republished
    expect(driver.snapshot().asOfSeq).toBe(0);
    // a board-bearing message still changes the state and publishes exactly once
    driver.feed(u(BOARD_RESTORED));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.state.content).toBe(BOARD_RESTORED);
    off();
    driver.feed(tool("t2", "todo_write", BOARD_V2));
    expect(seen).toHaveLength(1); // unsubscribed — no further deliveries
  });

  it("whole-value rule: every notification carries the complete post-state (no deltas)", () => {
    const driver = createProjectionDriver(todoProjection);
    const seen: { content: string | undefined; board: ReturnType<typeof parseTodoBoard> }[] = [];
    driver.subscribe((snap) => seen.push({ ...snap.state }));
    const seq = [u(BOARD_V1), a("note"), tool("t1", "todo_write", BOARD_V2), u(SUMMARY), u(BOARD_RESTORED)];
    for (const m of seq) driver.feed(m);
    expect(seen.map((s) => s.content)).toEqual([BOARD_V1, BOARD_V2, BOARD_RESTORED]);
    for (const s of seen) {
      expect(s.board).toEqual(s.content === undefined ? undefined : parseTodoBoard(s.content));
      expect(Object.keys(s).sort()).toEqual(["board", "content"]);
    }
  });

  it("snapshot is value-identical at any interruption point; asOfSeq is monotone (acceptance 3)", () => {
    const seq = CORPUS[0]!.messages;
    const straight = createProjectionDriver(todoProjection);
    for (const m of seq) straight.feed(m);
    const finalState = straight.snapshot().state;
    // interrupting the feed at ANY point and continuing lands on the same
    // value as feeding straight through (the resync/reset replay contract):
    for (const k of [0, 1, 3, seq.length]) {
      const driver = createProjectionDriver(todoProjection);
      for (let i = 0; i < k; i += 1) driver.feed(seq[i] as AgentMessage);
      // the mid-feed snapshot equals a fresh driver fed the same prefix
      const fresh = createProjectionDriver(todoProjection);
      for (let i = 0; i < k; i += 1) fresh.feed(seq[i] as AgentMessage);
      expect(driver.snapshot().state).toEqual(fresh.snapshot().state);
      expect(driver.snapshot().asOfSeq).toBe(fresh.snapshot().asOfSeq);
      for (let i = k; i < seq.length; i += 1) driver.feed(seq[i] as AgentMessage);
      expect(driver.snapshot().state).toEqual(finalState);
    }
    // monotonicity within one feed run
    const driver = createProjectionDriver(todoProjection);
    let last = driver.snapshot().asOfSeq;
    for (const m of seq) {
      driver.feed(m);
      const now = driver.snapshot().asOfSeq;
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
  });

  it("reset re-derives identically (rewind / branch-switch / reload semantics)", () => {
    const seq = CORPUS[3]!.messages;
    const driver = createProjectionDriver(todoProjection);
    for (const m of seq) driver.feed(m);
    const first = driver.snapshot().state;
    driver.reset();
    expect(driver.snapshot().state.content).toBeUndefined();
    expect(driver.snapshot().asOfSeq).toBe(0);
    for (const m of seq) driver.feed(m);
    expect(driver.snapshot().state).toEqual(first);
  });

  it("listener failure is isolated — a throwing subscriber never breaks the feed (events ≠ hooks)", () => {
    const driver = createProjectionDriver(todoProjection);
    let deliveries = 0;
    driver.subscribe(() => {
      deliveries += 1;
      throw new Error("boom");
    });
    driver.feed(u(BOARD_V1));
    driver.feed(a("irrelevant"));
    driver.feed(tool("t1", "todo_write", BOARD_V2));
    expect(deliveries).toBe(2);
    expect(driver.snapshot().state.content).toBe(BOARD_V2);
  });
});

// ---- the base itself: generic, minimal, framework-grade -------------------

describe("ω99-51 projection base (generic driver, acceptance 6)", () => {
  it("defineProjection + createProjectionDriver work for an arbitrary domain unit", () => {
    const counter = defineProjection({
      key: "count-a",
      init: () => ({ n: 0 }),
      apply: (ev: { s: string }, st: { n: number }) => (ev.s === "a" ? { n: st.n + 1 } : st),
    });
    const driver = createProjectionDriver(counter);
    driver.feed({ s: "x" });
    driver.feed({ s: "a" });
    driver.feed({ s: "a" });
    expect(driver.snapshot().state.n).toBe(2);
    expect(driver.snapshot().asOfSeq).toBe(2);
    expect(counter.key).toBe("count-a");
  });

  it("base ≤150 lines and imports nothing (zero new dependencies)", () => {
    const src = readFileSync(join(__dirname, "../src/session/projection.ts"), "utf8");
    expect(src.split("\n").length).toBeLessThanOrEqual(150);
    expect(src).not.toMatch(/\bfrom\s*"/);
    expect(src).not.toMatch(/\brequire\(/);
  });
});

// ---- acceptance 5: the constitution line -----------------------------------

describe("ω99-51 constitution line (acceptance 5)", () => {
  it("docs/research/106 exists with the three-domain census, the 4th-domain trigger, and the deferral rationale", () => {
    const doc = readFileSync(
      join(__dirname, "../../../docs/research/106-session-projection-constitution.md"),
      "utf8",
    );
    expect(doc).toContain("todo");
    expect(doc).toContain("session_name");
    expect(doc).toContain("goal");
    expect(doc).toContain("第四");
    expect(doc.toLowerCase()).toContain("checkpoint");
    expect(doc).toContain("projection");
  });
});

