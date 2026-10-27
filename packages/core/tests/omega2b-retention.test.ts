// ω-2b (I2-a) — per-tool retention targeting: the cheap compaction tiers
// (tier-0 clear, tier-1 microcompact) may only touch tools that fall inside
// the retention target. Acceptance per design §3-C:
//   · old read_file (exempt) + grep results over thresholds with
//     retention {exclude:["read_file"]} → read_file intact, grep stubbed,
//     fitsTokens met;
//   · golden test — ABSENT retention ⇒ byte-identical tier output (the
//     status quo is a fixed point of the change);
//   · compactionExempt tool lands in the CLI-built exclude set
//     (compactionRetentionFor);
//   · tier-2 span selection ignores retention (out of scope by design).
import { describe, it, expect } from "vitest";
import {
  clearTier,
  microcompact,
  matchesRetention,
  compactionRetentionFor,
  estimateTokens,
  CLEARED_MARKER,
  COMPACTION_STUB_PREFIX,
} from "../src/compaction.js";
import { buildTool } from "../src/tool.js";
import type { AgentMessage, ToolResultMessage } from "../src/types.js";
import type { Tool } from "../src/tool.js";

const BIG = (n: number): string => "r".repeat(n);

const toolResult = (id: string, name: string, content: string): ToolResultMessage => ({
  role: "tool",
  toolCallId: id,
  name,
  content,
});

/** A plausible pre-compaction history: call/result pairs, the huge results
 *  past keepRecent. */
const HISTORY = (): AgentMessage[] => [
  { role: "user", content: "task" },
  { role: "assistant", content: "", toolCalls: [
    { id: "r1", name: "read_file", arguments: { file: "a.ts" } },
    { id: "g1", name: "grep", arguments: { pattern: "x" } },
  ] },
  toolResult("r1", "read_file", BIG(40_000)),
  toolResult("g1", "grep", BIG(4_000)),
  { role: "assistant", content: "found things" },
  { role: "user", content: "go" },
];

describe("matchesRetention (ω-2b I2-a)", () => {
  it("no filter = match (status quo)", () => {
    expect(matchesRetention("anything")).toBe(true);
    expect(matchesRetention("anything", {})).toBe(true);
  });

  it("the include set wins and is exhaustive", () => {
    expect(matchesRetention("grep", { include: ["grep"] })).toBe(true);
    expect(matchesRetention("read_file", { include: ["grep"] })).toBe(false);
    expect(matchesRetention("grep", { include: ["grep"], exclude: ["grep"] })).toBe(true);
    expect(matchesRetention("grep", { include: [] })).toBe(false);
  });

  it("an exclude list exempts exactly its members", () => {
    expect(matchesRetention("read_file", { exclude: ["read_file"] })).toBe(false);
    expect(matchesRetention("grep", { exclude: ["read_file"] })).toBe(true);
  });
});

describe("retention on the cheap tiers (ω-2b I2-a)", () => {
  it("tier-1: an excluded read_file stays intact while grep is stubbed, and the budget is met", () => {
    const messages = HISTORY();
    const out = microcompact(messages, { keepRecent: 2, retention: { exclude: ["read_file"] } });
    const read = out.find((m) => m.role === "tool" && m.name === "read_file");
    const grep = out.find((m) => m.role === "tool" && m.name === "grep");
    expect((read as ToolResultMessage).content).toBe(BIG(40_000));
    expect((grep as ToolResultMessage).content.startsWith(COMPACTION_STUB_PREFIX)).toBe(true);
    // The stub actually shrank the estimate.
    expect(estimateTokens("", [], out)).toBeLessThan(estimateTokens("", [], messages));
  });

  it("tier-0: an excluded read_file is never cleared even past the 30k threshold", () => {
    const messages = HISTORY();
    const out = clearTier(messages, { keepRecent: 2, retention: { exclude: ["read_file"] } });
    expect(out.cleared).toBe(0); // the only >30k result is the exempt read_file
    const outNoRetention = clearTier(messages, { keepRecent: 2 });
    expect(outNoRetention.cleared).toBe(1);
    const cleared = outNoRetention.messages.find((m) => m.role === "tool" && m.name === "read_file");
    expect((cleared as ToolResultMessage).content.startsWith(CLEARED_MARKER)).toBe(true);
  });

  it("an include set targets exactly its members on both tiers", () => {
    const messages = HISTORY();
    const stubbed = microcompact(messages, { keepRecent: 2, retention: { include: ["grep"] } });
    expect((stubbed.find((m) => m.role === "tool" && m.name === "grep") as ToolResultMessage).content.startsWith(COMPACTION_STUB_PREFIX)).toBe(true);
    expect((stubbed.find((m) => m.role === "tool" && m.name === "read_file") as ToolResultMessage).content).toBe(BIG(40_000));
    const cleared = clearTier(messages, { keepRecent: 2, retention: { include: ["grep"] } });
    expect(cleared.cleared).toBe(0); // grep is 4k < 30k minChars; read_file not included
  });

  it("golden: ABSENT retention ⇒ byte-identical tier output (status-quo fixed point)", () => {
    const messages = HISTORY();
    const withUndefined = microcompact(messages, { keepRecent: 2, retention: undefined });
    const plain = microcompact(messages, { keepRecent: 2 });
    expect(withUndefined).toEqual(plain);
    expect(clearTier(messages, { keepRecent: 2, retention: undefined })).toEqual(clearTier(messages, { keepRecent: 2 }));
    // …and against the recorded pre-change shape: both old tools are stubbed.
    for (const name of ["read_file", "grep"]) {
      const m = plain.find((x) => x.role === "tool" && x.name === name) as ToolResultMessage;
      expect(m.content.startsWith(COMPACTION_STUB_PREFIX)).toBe(true);
    }
  });
});

describe("compactionRetentionFor — the CLI-built exclude set (ω-2b I2-a)", () => {
  const mk = (name: string, exempt?: boolean): Tool =>
    buildTool({
      name,
      description: "d",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: "" }),
      ...(exempt === true ? { compactionExempt: true } : {}),
    });

  it("no exempt tool ⇒ undefined (status-quo options)", () => {
    expect(compactionRetentionFor([mk("grep"), mk("read_file")])).toBeUndefined();
    expect(compactionRetentionFor([])).toBeUndefined();
  });

  it("every compactionExempt tool lands in the exclude set", () => {
    expect(compactionRetentionFor([mk("grep"), mk("read_file", true), mk("ask_user", true)]))
      .toEqual({ exclude: ["read_file", "ask_user"] });
  });

  it("buildTool leaves the flag opt-in (absent = not exempt)", () => {
    const t = buildTool({ name: "x", description: "d", parameters: { type: "object", properties: {} }, execute: async () => ({ content: "" }) });
    expect(t.compactionExempt).toBeUndefined();
  });
});
