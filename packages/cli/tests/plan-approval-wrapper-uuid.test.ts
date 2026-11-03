import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { nodeKey, type AgentMessage } from "@wudao-org/core";
import { appendPlanApprovalTrace } from "../src/plan.js";
import { appendPlanExecutionWrapper, buildPlanExecutionBranchLink } from "../src/repl.js";

// I1 follow-up (doc 40, Minor): the `<plan-approved>` wrapper push joins the
// uuid+parentUuid chain under the approval trace, matching the canonical
// turn-node shape (plan.ts appendPlanApprovalTrace / driver submitCore). The
// wrapper content bytes stay EXACTLY buildPlanExecutionPrompt output — only
// persistence-only metadata is added (M53 branched-turn shape; never
// serialized to the provider).

const src = (p: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), "utf8");

describe("appendPlanExecutionWrapper (one-shot index.ts path)", () => {
  it("pushes the wrapper with a fresh uuid linked at the trace's nodeKey", () => {
    const messages: AgentMessage[] = [];
    appendPlanApprovalTrace(messages, "y");
    const trace = messages[messages.length - 1]!;
    appendPlanExecutionWrapper(messages, "wrapper-body");
    const wrapper = messages[messages.length - 1]!;
    expect(wrapper.role).toBe("user");
    expect(wrapper.content).toBe("wrapper-body"); // byte-identical content
    expect(wrapper.uuid).toBeTypeOf("string");
    expect(wrapper.uuid).not.toBe(trace.uuid); // fresh mint, not the trace's
    expect(wrapper.parentUuid).toBe(nodeKey(trace)); // chained UNDER the trace
  });

  it("on an empty history the wrapper carries uuid but NO parentUuid (appendPlanApprovalTrace precedent)", () => {
    const messages: AgentMessage[] = [];
    appendPlanExecutionWrapper(messages, "w");
    const wrapper = messages[messages.length - 1]!;
    expect(wrapper.uuid).toBeTypeOf("string");
    expect(wrapper.parentUuid).toBeUndefined();
  });

  it("an assistant QUOTE with no uuid falls back to the fingerprint key (nodeKey semantics, not skipped)", () => {
    const messages: AgentMessage[] = [{ role: "assistant", content: "some prior turn" }];
    appendPlanExecutionWrapper(messages, "w");
    const wrapper = messages[messages.length - 1]!;
    expect(wrapper.parentUuid).toBe(nodeKey(messages[0]!)); // fingerprint, defined
  });
});

describe("buildPlanExecutionBranchLink (REPL runTurn path)", () => {
  it("mints a link whose parentUuid is the trace's nodeKey (REPL consumes it as runTurn's 3rd param)", () => {
    const messages: AgentMessage[] = [];
    appendPlanApprovalTrace(messages, "ok");
    const trace = messages[messages.length - 1]!;
    const link = buildPlanExecutionBranchLink(messages);
    expect(link.uuid).toBeTypeOf("string");
    expect(link.parentUuid).toBe(nodeKey(trace));
    // The link object shape matches runTurn's branchLink param exactly.
    const consumed: { readonly uuid: string; readonly parentUuid?: string } = link;
    expect(consumed.uuid).toBe(link.uuid);
  });

  it("on an empty history returns a link with no parentUuid", () => {
    expect(buildPlanExecutionBranchLink([]).parentUuid).toBeUndefined();
  });
});

describe("call-site wiring (static source-scan, Phase 2b pattern — no real CLI spawn)", () => {
  it("repl.ts: the plan-approval runTurn call passes buildPlanExecutionBranchLink as the 3rd argument", () => {
    const repl = src("repl.ts");
    // Report 95 R1: the call enters through the submitTurn admission chain
    // now (the chain passes plan/branchLink through verbatim — no flag loss).
    expect(repl).toMatch(
      /appendPlanApprovalTrace\(state\.messages, cmd\.text\);\s*\n\s*await submitTurn\(buildPlanExecutionPrompt\(board\), false, buildPlanExecutionBranchLink\(state\.messages\)\);/,
    );
  });

  it("index.ts: the one-shot approval pushes the wrapper through appendPlanExecutionWrapper (not a bare push)", () => {
    const index = src("index.ts");
    expect(index).toMatch(/appendPlanExecutionWrapper\(state\.messages, buildPlanExecutionPrompt\(board\)\);/);
    // Containment, not exact import shape — additive imports on this line
    // (ω99-8's createSubagentCostSink) must not re-break the intent pin.
    expect(index).toMatch(/import \{[^}]*appendPlanExecutionWrapper[^}]*\} from "\.\/repl\.js";/);
    // The old bare push must be gone.
    expect(index).not.toMatch(/state\.messages\.push\(\{ role: "user", content: buildPlanExecutionPrompt\(board\) \}\);/);
  });
});
