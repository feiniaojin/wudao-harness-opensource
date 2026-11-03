// M37 §1 — plan mode pure helpers: the read-only whitelist, the prompt
// envelopes (request/revision/execution), and the review-line parser that
// drives the ok / 改 <意见> flow.
// 审批痕 (approval trace): appendPlanApprovalTrace tests pin the message
// shape AND the authz-evidence classification — the raw confirmation word is
// a genuine user message, never a synthetic one.
import { describe, it, expect } from "vitest";
import {
  PLAN_MODE_TOOLS,
  planModeDenied,
  buildPlanPrompt,
  buildPlanRevisionPrompt,
  buildPlanExecutionPrompt,
  parsePlanReviewInput,
  PLAN_APPROVAL_WORDS,
  appendPlanApprovalTrace,
  planConfirmApproves,
} from "../src/plan.js";
import { parseReplCommand } from "../src/repl.js";
import { classifyAuthzMessage, buildAuthzExcerpt, renderAskDigest, AUTHZ_SYNTHETIC_MARKERS, nodeKey } from "@wudao-org/core";
import type { AgentMessage } from "@wudao-org/core";

describe("PLAN_MODE_TOOLS (M37 §1 whitelist)", () => {
  it("contains exactly the read-only lane + the plan board itself", () => {
    expect([...PLAN_MODE_TOOLS].sort()).toEqual(["agent_status", "ask_user", "glob", "grep", "read_file", "todo_write"]);
  });
  it("excludes every mutating tool", () => {
    for (const t of ["write_file", "edit", "shell", "task", "agent_await", "load_tools"]) {
      expect(PLAN_MODE_TOOLS.has(t)).toBe(false);
    }
  });
});

describe("planModeDenied", () => {
  it("returns undefined for whitelisted tools (the normal gate decides)", () => {
    for (const t of PLAN_MODE_TOOLS) expect(planModeDenied(t)).toBeUndefined();
  });
  it("denies mutating tools with a plan-mode reason that names the tool", () => {
    for (const t of ["write_file", "edit", "shell", "task"]) {
      const d = planModeDenied(t);
      expect(d).toBeDefined();
      expect(d?.behavior).toBe("deny");
      if (d?.behavior === "deny") {
        expect(d.reason).toContain("plan");
        expect(d.reason).toContain(t);
      }
    }
  });
});

describe("prompt envelopes", () => {
  it("buildPlanPrompt wraps the goal, states read-only, and asks for a todo_write board", () => {
    const p = buildPlanPrompt("add a /rewind command");
    expect(p.startsWith("<plan-request>")).toBe(true);
    expect(p.trimEnd().endsWith("</plan-request>")).toBe(true);
    expect(p).toContain("add a /rewind command");
    expect(p).toContain("todo_write");
    expect(p).toContain("read-only");
    // The plan shape the spec asks for: 目标/步骤/风险/验证.
    expect(p).toContain("goal");
    expect(p).toContain("steps");
    expect(p).toContain("risks");
    expect(p).toContain("verification");
  });
  it("buildPlanRevisionPrompt carries the feedback and stays read-only", () => {
    const p = buildPlanRevisionPrompt("split step 2 into two steps");
    expect(p.startsWith("<plan-revision>")).toBe(true);
    expect(p.trimEnd().endsWith("</plan-revision>")).toBe(true);
    expect(p).toContain("split step 2 into two steps");
    expect(p).toContain("todo_write");
  });
  it("buildPlanExecutionPrompt embeds the approved board verbatim", () => {
    const board = "[todo board 0/2 done]\n☐ read the parser\n☐ fix the bug";
    const p = buildPlanExecutionPrompt(board);
    expect(p.startsWith("<plan-approved>")).toBe(true);
    expect(p.trimEnd().endsWith("</plan-approved>")).toBe(true);
    expect(p).toContain(board);
    expect(p).toContain("in_progress");
  });
});

describe("parsePlanReviewInput", () => {
  it("accepts short confirmations case-insensitively", () => {
    for (const line of ["ok", "OK", "Ok ", " y", "yes", "YES", "go", "好", "可以", "执行"]) {
      expect(parsePlanReviewInput(line)).toEqual({ kind: "approve" });
    }
  });
  it("改 <意见> → revise with the trimmed feedback", () => {
    expect(parsePlanReviewInput("改 把第二步拆开")).toEqual({ kind: "revise", feedback: "把第二步拆开" });
    expect(parsePlanReviewInput("  改   trim me  ")).toEqual({ kind: "revise", feedback: "trim me" });
  });
  it("empty input, bare 改, and any other text are NOT review input (fall through to a normal prompt)", () => {
    expect(parsePlanReviewInput("")).toBeUndefined();
    expect(parsePlanReviewInput("   ")).toBeUndefined();
    expect(parsePlanReviewInput("改")).toBeUndefined();
    expect(parsePlanReviewInput("what about the tests?")).toBeUndefined();
    expect(parsePlanReviewInput("/help")).toBeUndefined();
  });
  it("every approval word survives a trailing/leading trim", () => {
    for (const w of PLAN_APPROVAL_WORDS) expect(parsePlanReviewInput(`  ${w}  `)).toEqual({ kind: "approve" });
  });
});

describe("parseReplCommand /plan (routing)", () => {
  it("/plan <goal> → plan with the trimmed goal (inner spacing preserved, like prompt text)", () => {
    expect(parseReplCommand("/plan add dark mode")).toEqual({ kind: "plan", goal: "add dark mode" });
    expect(parseReplCommand("/plan   spaced  goal ")).toEqual({ kind: "plan", goal: "spaced  goal" });
  });
  it("bare /plan → plan with an empty goal (runtime answers with usage)", () => {
    expect(parseReplCommand("/plan")).toEqual({ kind: "plan", goal: "" });
  });
  it("/planx and /planner stay plain prompts", () => {
    expect(parseReplCommand("/planx now")).toEqual({ kind: "prompt", text: "/planx now" });
    expect(parseReplCommand("/planner hi")).toEqual({ kind: "prompt", text: "/planner hi" });
  });
  it("builtins win: a registered plugin command named plan never routes to the plugin", () => {
    expect(parseReplCommand("/plan x", ["plan"])).toEqual({ kind: "plan", goal: "x" });
  });
});

// ---------------------------------------------------------------------------
// 审批痕 (approval trace) — the raw confirmation word as a genuine user
// message pushed before the <plan-approved> wrapper.
// ---------------------------------------------------------------------------

describe("appendPlanApprovalTrace", () => {
  it("pushes the confirmation VERBATIM as a user message with a fresh uuid linked at the predecessor's nodeKey", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "/plan add it", uuid: "u1" },
      { role: "assistant", content: "board ready" },
    ];
    appendPlanApprovalTrace(messages, "ok");
    expect(messages).toHaveLength(3);
    const trace = messages[2];
    expect(trace?.role).toBe("user");
    expect(trace?.content).toBe("ok"); // the raw word, byte-for-byte
    expect(trace?.uuid).toBeDefined();
    expect(trace?.uuid).not.toBe("u1");
    // The canonical turn-node link: parentUuid = the chain predecessor's key
    // (uuid when assigned — driver agent-driver.ts submitCore shape).
    expect(trace?.parentUuid).toBe(nodeKey(messages[1] as AgentMessage));
  });

  it("links at the predecessor's entry-id fingerprint when it carries no uuid (legacy nodes)", () => {
    const messages: AgentMessage[] = [{ role: "assistant", content: "board ready" }];
    appendPlanApprovalTrace(messages, "可以");
    expect(messages[1]?.parentUuid).toBe(nodeKey(messages[0] as AgentMessage));
  });

  it("an empty history pushes a root node (no parentUuid)", () => {
    const messages: AgentMessage[] = [];
    appendPlanApprovalTrace(messages, "ok");
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toBe("ok");
    expect("parentUuid" in (messages[0] as object)).toBe(false);
  });

  it("preserves case and inner spacing of the raw line (no trim, no fold)", () => {
    const messages: AgentMessage[] = [{ role: "assistant", content: "b" }];
    appendPlanApprovalTrace(messages, " OK ");
    expect(messages[1]?.content).toBe(" OK ");
  });
});

describe("planConfirmApproves (the one-shot y/N decision, extracted pure)", () => {
  it("y/yes approve case-insensitively", () => {
    for (const line of ["y", "Y", "yes", "YES", "Yes"]) expect(planConfirmApproves(line)).toBe(true);
  });
  it("the empty line, whitespace, and any other word decline (empty = negative; nothing is pushed)", () => {
    for (const line of ["", "   ", "n", "N", "no", "ok", "y es", "yy"]) expect(planConfirmApproves(line)).toBe(false);
  });
});

describe("appendPlanApprovalTrace — authz classification (the point of the trace)", () => {
  it("every approval word classifies genuine-user: none starts with a registered marker", () => {
    for (const w of PLAN_APPROVAL_WORDS) {
      expect(AUTHZ_SYNTHETIC_MARKERS.some((marker) => w.startsWith(marker))).toBe(false);
      expect(classifyAuthzMessage({ role: "user", content: w })).toBe("genuine-user");
    }
    // The one-shot y/N words too (same property, different word set).
    for (const w of ["y", "Y", "yes", "Yes"]) {
      expect(classifyAuthzMessage({ role: "user", content: w })).toBe("genuine-user");
    }
  });

  it("the evidence channel keeps the confirmation and drops the wrapper that follows it", () => {
    const messages: AgentMessage[] = [];
    appendPlanApprovalTrace(messages, "ok");
    messages.push({ role: "user", content: buildPlanExecutionPrompt("[todo board 0/1 done]\n☐ step") });
    const excerpt = buildAuthzExcerpt(messages);
    expect(excerpt.entries).toHaveLength(1); // wrapper is synthetic — filtered
    expect(excerpt.entries[0]).toMatchObject({ role: "user", text: "ok", truncated: false });
  });

  it("the terminal ask digest renders the confirmation as the latest genuine user instruction", () => {
    const messages: AgentMessage[] = [];
    appendPlanApprovalTrace(messages, "ok");
    messages.push({ role: "user", content: buildPlanExecutionPrompt("[todo board 0/1 done]\n☐ step") });
    const digest = renderAskDigest(buildAuthzExcerpt(messages), { kind: "child", role: "coder", brief: "do the thing" });
    expect(digest).toContain("user: ok");
    expect(digest).not.toContain("<plan-approved>");
  });
});
