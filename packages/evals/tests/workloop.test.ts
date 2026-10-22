// M48 §4 — the the upstream harness Agent Work Loop scorer: 5 dimensions × 15
// checks over a transcript + terminal, evidence-state ceilings, findings
// decoupled from scores ("a score never creates or suppresses a finding").
import { describe, it, expect } from "vitest";
import {
  EVIDENCE_CEILING, WORKLOOP_DIMENSIONS, scoreWorkloop, loadSessionMessages, PARTIAL_SUCCESS_SCORE,
  type WorkloopInput, type CheckId,
} from "../src/workloop.js";
import type { AgentMessage } from "@wudao/core";

// ---------------------------------------------------------------------------
// the evidence-state ceiling table (the upstream harness models/agent-work-loop.md)
// ---------------------------------------------------------------------------

describe("evidence ceilings", () => {
  it("pins the seven states to their score ceilings", () => {
    expect(EVIDENCE_CEILING).toEqual({
      missing: 59,
      unobserved: 59,
      "not-applicable": 59,
      present: 74,
      wired: 84,
      exercised: 94,
      "outcome-supported": 100,
    });
  });

  it("the 15 checks spread exactly 3 per dimension", () => {
    expect(WORKLOOP_DIMENSIONS).toHaveLength(5);
    const ids = WORKLOOP_DIMENSIONS.flatMap((d) => d.checks.map((c) => c.id));
    expect(new Set(ids).size).toBe(15);
    for (const dim of WORKLOOP_DIMENSIONS) expect(dim.checks).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** A healthy coding transcript: understand → read → write → verify → answer. */
const goodRun: AgentMessage[] = [
  { role: "user", content: "Fix the login bug in src/auth.ts and run the tests." },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "src/auth.ts" } }] },
  { role: "tool", toolCallId: "c1", name: "read_file", content: "export function login() { return null; }" },
  { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "edit", arguments: { path: "src/auth.ts", old_string: "return null", new_string: "return user" } }] },
  { role: "tool", toolCallId: "c2", name: "edit", content: "[verified: edit ok]" },
  { role: "assistant", content: "", toolCalls: [{ id: "c3", name: "shell", arguments: { command: "pnpm test" } }] },
  { role: "tool", toolCallId: "c3", name: "shell", content: "3 passed" },
  { role: "assistant", content: "Fixed the login bug in src/auth.ts; the test suite passes (3 tests)." },
];

/** A looping transcript: the same failing edit over and over, run aborted. */
const loopRun: AgentMessage[] = [
  { role: "user", content: "Update the README introduction." },
  ...Array.from({ length: 4 }, (_, i) => ({
    role: "assistant" as const,
    content: "",
    toolCalls: [{ id: `e${i}`, name: "edit", arguments: { path: "README.md", old_string: "old intro", new_string: "new intro" } }],
  })),
  ...Array.from({ length: 4 }, (_, i) => ({
    role: "tool" as const,
    toolCallId: `e${i}`,
    name: "edit",
    content: "edit failed: old_string not found",
    isError: true,
  })),
];

const input = (messages: readonly AgentMessage[], terminal?: WorkloopInput["terminal"], overrides?: WorkloopInput["overrides"]): WorkloopInput =>
  ({ messages, ...(terminal !== undefined ? { terminal } : {}), ...(overrides !== undefined ? { overrides } : {}) });

const dim = (report: ReturnType<typeof scoreWorkloop>, id: string) =>
  report.dimensions.find((d) => d.id === id);

const checkState = (report: ReturnType<typeof scoreWorkloop>, id: CheckId) =>
  report.dimensions.flatMap((d) => d.checks).find((c) => c.check === id)?.state;

// ---------------------------------------------------------------------------
// dimension formula: dim score = min(ceiling of its checks); overall = mean
// ---------------------------------------------------------------------------

describe("scoreWorkloop — formula", () => {
  it("a dimension's score is the MIN of its checks' ceilings", () => {
    const report = scoreWorkloop(input(goodRun, { reason: "completed" }));
    const d1 = dim(report, "task-understanding")!;
    const expected = Math.min(...d1.checks.map((c) => EVIDENCE_CEILING[c.state]));
    expect(d1.score).toBe(expected);
    expect(report.overall).toBe(Math.round(report.dimensions.reduce((n, d) => n + d.score, 0) / report.dimensions.length));
  });

  it("any missing check caps its dimension at 59 (required checks)", () => {
    const report = scoreWorkloop(input(loopRun, { reason: "aborted" }));
    expect(dim(report, "reliable-delivery")!.score).toBeLessThanOrEqual(59);
  });

  it("overrides replace derived states (the harness-level self-assessment lane)", () => {
    const report = scoreWorkloop(input(goodRun, { reason: "completed" }, {
      "later-validation": "exercised",
      "loop-engineering": "outcome-supported",
    }));
    expect(checkState(report, "later-validation")).toBe("exercised");
    expect(checkState(report, "loop-engineering")).toBe("outcome-supported");
    // The min formula still binds: the third check stays unobserved (≤59).
    expect(dim(report, "learning-capture")!.score).toBe(59);
    // Lifting ALL of a dimension's checks lifts the dimension.
    const lifted = scoreWorkloop(input(goodRun, { reason: "completed" }, {
      "later-validation": "exercised",
      "loop-engineering": "outcome-supported",
      "lifecycle-repeat-detection": "exercised",
    }));
    expect(dim(lifted, "learning-capture")!.score).toBe(94);
  });
});

// ---------------------------------------------------------------------------
// evaluator behavior
// ---------------------------------------------------------------------------

describe("scoreWorkloop — evaluators", () => {
  it("the healthy run: strong validation/delivery, weak learning capture", () => {
    const report = scoreWorkloop(input(goodRun, { reason: "completed" }));
    // Change Validation is our strongest axis (research self-assessment).
    expect(checkState(report, "relevant-check")).toBe("outcome-supported");
    expect(checkState(report, "acceptance-evidence")).toBe("outcome-supported");
    // Learning capture cannot be evidenced from ONE transcript.
    expect(dim(report, "learning-capture")!.score).toBeLessThanOrEqual(59);
    expect(checkState(report, "later-validation")).toBe("unobserved");
    // No dangerous commands and no denials in the fixture → unobserved.
    expect(checkState(report, "high-risk-approval")).toBe("unobserved");
    expect(checkState(report, "permission-boundary")).toBe("unobserved");
    expect(report.findings).toHaveLength(0);
  });

  it("the aborted loop run: repeat detection + repair are missing, findings fire", () => {
    const report = scoreWorkloop(input(loopRun, { reason: "aborted" }));
    expect(checkState(report, "lifecycle-repeat-detection")).toBe("missing");
    expect(checkState(report, "failure-repair")).toBe("missing");
    expect(checkState(report, "acceptance-evidence")).toBe("missing");
    const findingChecks = report.findings.map((f) => f.check);
    expect(findingChecks).toContain("lifecycle-repeat-detection");
    expect(findingChecks).toContain("failure-repair");
    expect(findingChecks).toContain("acceptance-evidence");
  });

  it("a write without any verification floors relevant-check", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Write the config file." },
      { role: "assistant", content: "", toolCalls: [{ id: "w1", name: "write_file", arguments: { path: "cfg.json", content: "{}" } }] },
      { role: "tool", toolCallId: "w1", name: "write_file", content: "wrote cfg.json" },
      { role: "assistant", content: "Wrote the config file." },
    ];
    const report = scoreWorkloop(input(messages, { reason: "completed" }));
    expect(checkState(report, "relevant-check")).toBe("missing");
    // Context was never gathered before acting either.
    expect(checkState(report, "relevant-context")).toBe("missing");
  });

  it("a path-escape attempt floors scope-boundary", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Read the secret." },
      { role: "assistant", content: "", toolCalls: [{ id: "r1", name: "read_file", arguments: { path: "../../etc/passwd" } }] },
      { role: "tool", toolCallId: "r1", name: "read_file", content: "permission denied: path escape", isError: true },
      { role: "assistant", content: "I cannot read that file." },
    ];
    const report = scoreWorkloop(input(messages, { reason: "completed" }));
    expect(checkState(report, "scope-boundary")).toBe("missing");
  });

  it("a terminal derived from the transcript when none is given", () => {
    const report = scoreWorkloop(input(goodRun));
    expect(checkState(report, "acceptance-evidence")).toBe("outcome-supported");
    const unterminated = scoreWorkloop(input(loopRun));
    expect(checkState(unterminated, "acceptance-evidence")).toBe("missing");
  });
});

// ---------------------------------------------------------------------------
// session JSONL loading (the --workloop subcommand's input)
// ---------------------------------------------------------------------------

describe("loadSessionMessages", () => {
  it("parses message lines and skips non-message entries", () => {
    const text = [
      JSON.stringify({ role: "user", content: "go" }),
      JSON.stringify({ type: "model_change", model: "m", at: "2026-08-17T00:00:00Z" }),
      JSON.stringify({ type: "session_name", name: "fix-bug" }),
      JSON.stringify({ role: "assistant", content: "done" }),
      "not json at all",
    ].join("\n");
    const messages = loadSessionMessages(text);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("empty and whitespace-only input yield no messages", () => {
    expect(loadSessionMessages("")).toEqual([]);
    expect(loadSessionMessages("\n\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// M56 §4 — no-evidence success = 0.5 partial, never a pass (the upstream format C7).
// ---------------------------------------------------------------------------
describe("scoreWorkloop — evidence verdict (M56 §4)", () => {
  it("a completed run with writes + a verification run is evidence-verified", () => {
    const report = scoreWorkloop(input(goodRun, { reason: "completed" }));
    expect(report.evidence).toBe("verified");
  });

  it("an answer-only success (no writes, no checks) is a 0.5 PARTIAL, never a pass", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "2+2 is 4." },
    ];
    const report = scoreWorkloop(input(messages, { reason: "completed" }));
    expect(checkState(report, "acceptance-evidence")).toBe("present"); // ceiling 74, not 100
    expect(report.evidence).toBe("partial");
    expect(PARTIAL_SUCCESS_SCORE).toBe(0.5);
  });

  it("an aborted run is never evidence-verified", () => {
    const report = scoreWorkloop(input(loopRun, { reason: "aborted" }));
    expect(report.evidence).toBe("partial");
  });
});
