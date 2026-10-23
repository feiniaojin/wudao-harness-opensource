// M53 §1 — the pure branch-tree algebra: uuid/parentUuid chain walking,
// /tree rendering, /switch leaf listing, common-prefix fork detection.
import { describe, expect, it } from "vitest";
import {
  activeChain,
  branchTurns,
  chainEndingAt,
  commonPrefixLength,
  listBranchLeaves,
  nodeKey,
  parentIndex,
  renderBranchTree,
} from "../src/session/branch.js";
import type { AgentMessage } from "../src/types.js";

// A linear trunk: u1 → a1 → u2 → a2, no uuids (pre-M53 shape — everything
// falls back to file order and entry-id keys).
const legacyTrunk: AgentMessage[] = [
  { role: "user", content: "read the config" },
  { role: "assistant", content: "done", toolCalls: [{ id: "t1", name: "read_file", arguments: { path: "config.ts" } }] },
  { role: "tool", toolCallId: "t1", name: "read_file", content: "..." },
  { role: "user", content: "refactor it" },
  { role: "assistant", content: "refactored" },
];

// A branched tree: after (u1,a1,t1,u2,a2) the user EDITS u2 → b3's parentUuid
// points at t1 (the node u2 itself followed — the fork parent), so [u2,a2]
// stays on the tree as an abandoned branch and [u1,a1,t1,b3,b4] is the
// active chain (the file's last message). t1 carries no uuid, so the link is
// its entry-id fingerprint — exactly how the driver links into legacy tails.
const t1Key = nodeKey({ role: "tool", toolCallId: "t1", name: "read_file", content: "..." });
const branched: AgentMessage[] = [
  { role: "user", content: "read the config", uuid: "u1" },
  { role: "assistant", content: "done", toolCalls: [{ id: "t1", name: "read_file", arguments: { path: "config.ts" } }] },
  { role: "tool", toolCallId: "t1", name: "read_file", content: "..." },
  { role: "user", content: "refactor it" },
  { role: "assistant", content: "refactored" },
  // the edit of u2: branches from u2's parent point (t1)
  { role: "user", content: "refactor it carefully", uuid: "b3", parentUuid: t1Key },
  { role: "assistant", content: "refactored carefully" },
];

describe("nodeKey / parentIndex", () => {
  it("uses uuid when present, the entry-id fingerprint otherwise", () => {
    expect(nodeKey({ role: "user", content: "x", uuid: "abc" })).toBe("abc");
    expect(nodeKey({ role: "user", content: "x" })).toMatch(/^user-1-[0-9a-f]+$/);
  });

  it("a missing parentUuid means the linear predecessor", () => {
    expect(parentIndex(legacyTrunk, 1)).toBe(0);
    expect(parentIndex(legacyTrunk, 3)).toBe(2);
    expect(parentIndex(legacyTrunk, 0)).toBe(-1);
  });

  it("a parentUuid link resolves to the nearest preceding match", () => {
    expect(parentIndex(branched, 5)).toBe(2); // b3.parentUuid=t1's entry-id
    expect(parentIndex(branched, 3)).toBe(2); // u2 has no link — linear
  });
});

describe("chainEndingAt / activeChain", () => {
  it("walks to the root through parent links", () => {
    const chain = chainEndingAt(branched, branched.length - 1);
    expect(chain.map((m) => (m.role === "user" ? m.uuid : m.role))).toEqual([
      "u1",
      "assistant",
      "tool",
      "b3",
      "assistant",
    ]);
  });

  it("the legacy trunk is its own active chain", () => {
    expect(activeChain(legacyTrunk)).toHaveLength(legacyTrunk.length);
    expect(activeChain([])).toEqual([]);
  });
});

describe("branchTurns / renderBranchTree", () => {
  it("classifies the fork turn (parent link skips live entries)", () => {
    const turns = branchTurns(branched);
    expect(turns.map((t) => [t.preview, t.isFork])).toEqual([
      ["read the config", false],
      ["refactor it", false],
      ["refactor it carefully", true],
    ]);
  });

  it("renders trunk turns flush, forks indented, current chain marked", () => {
    // the leaf key is a TURN key (the active chain's last user message)
    const tree = renderBranchTree(branched, "b3");
    const lines = tree.split("\n");
    expect(lines[0]).toBe("1. read the config  ←");
    expect(lines[1]).toBe("2. refactor it");
    expect(lines[2]).toBe("  └─ 3. refactor it carefully  ←");
    // marking the ABANDONED leaf instead puts the arrow on turn 2's chain
    const oldTree = renderBranchTree(branched, nodeKey(branched[3] as AgentMessage));
    expect(oldTree.split("\n")[1]).toBe("2. refactor it  ←");
    expect(oldTree.split("\n")[2]).toBe("  └─ 3. refactor it carefully");
  });

  it("an empty message list renders a placeholder", () => {
    expect(renderBranchTree([], null)).toBe("（尚无轮次）"); // ω99-166d-ii: 空树占位钉随 #30
  });
});

describe("listBranchLeaves", () => {
  it("lists every chain leaf with fork preview and current marker", () => {
    const leaves = listBranchLeaves(branched, "b3");
    expect(leaves).toHaveLength(2);
    expect(leaves[0]?.isCurrent).toBe(false); // u2's chain (abandoned)
    expect(leaves[0]?.forkPreview).toBe("read the config");
    expect(leaves[1]?.isCurrent).toBe(true);
    expect(leaves[1]?.messageCount).toBe(5); // u1,a1,t1,b3,b4
  });

  it("a single trunk has exactly one leaf and it is current", () => {
    const leaves = listBranchLeaves(legacyTrunk, nodeKey(legacyTrunk[3] as AgentMessage));
    expect(leaves).toHaveLength(1);
    expect(leaves[0]?.isCurrent).toBe(true);
  });
});

describe("commonPrefixLength", () => {
  it("measures the shared prefix of two chains", () => {
    const active = activeChain(branched);
    const old = chainEndingAt(branched, 4);
    expect(commonPrefixLength(active, old)).toBe(3); // u1,a1,tool
  });
});

// M53 §2 — the branch-summary digest.
import { branchSummaryNote, buildBranchSummary, fileActivityNewestFirst, forkPredatesCompaction, BRANCH_SUMMARY_BUDGET_CHARS } from "../src/session/branch.js";
import { SUMMARY_MARKER } from "../src/compaction.js";

describe("branch-summary (M53 §2)", () => {
  const span: AgentMessage[] = [
    { role: "user", content: "fix the parser" },
    { role: "assistant", content: "", toolCalls: [
      { id: "r1", name: "read_file", arguments: { path: "src/old.ts" } },
      { id: "w1", name: "edit", arguments: { path: "src/parser.ts" } },
    ] },
    { role: "tool", toolCallId: "r1", name: "read_file", content: "..." },
    { role: "tool", toolCallId: "w1", name: "edit", content: "ok" },
    { role: "assistant", content: "", toolCalls: [{ id: "r2", name: "read_file", arguments: { path: "src/new.ts" } }] },
    { role: "tool", toolCallId: "r2", name: "read_file", content: "..." },
    { role: "assistant", content: "parser fixed via a token map" },
  ];

  it("accumulates file activity newest-first, deduped by path", () => {
    const activity = fileActivityNewestFirst(span);
    expect(activity.map((a) => `${a.kind} ${a.path}`)).toEqual([
      "read src/new.ts",
      "write src/parser.ts",
      "read src/old.ts",
    ]);
  });

  it("the digest carries the activity, the last ask, and the last conclusion", () => {
    const digest = buildBranchSummary(span);
    expect(digest).toContain("diverged 7 messages ago");
    expect(digest).toContain("- read src/new.ts");
    expect(digest).toContain("- write src/parser.ts");
    expect(digest).toContain("- last user request there: fix the parser");
    expect(digest).toContain("- last conclusion there: parser fixed via a token map");
    expect(branchSummaryNote(span)).toBe(`<branch-summary>\n${digest}\n</branch-summary>`);
  });

  it("respects the retention budget by dropping the OLDEST activity (newest kept)", () => {
    // full digest ≈ 250 chars; a 215 budget forces exactly the two oldest
    // activity lines out and keeps the newest one plus both excerpts.
    const digest = buildBranchSummary(span, { budgetChars: 215 });
    expect(digest).toContain("src/new.ts");
    expect(digest).not.toContain("src/old.ts");
    expect(digest).not.toContain("src/parser.ts");
    expect(digest).toContain("last conclusion there");
    expect(digest.startsWith("branch-summary:")).toBe(true);
  });

  it("an empty span produces no note", () => {
    expect(branchSummaryNote([])).toBe("");
  });

  it("the default budget is 16k (pi's retention number)", () => {
    expect(BRANCH_SUMMARY_BUDGET_CHARS).toBe(16_000);
  });

  it("forkPredatesCompaction: a marker AFTER the fork means the boundary is later", () => {
    const chain: AgentMessage[] = [
      { role: "user", content: "one" },
      { role: "assistant", content: "a" },
      { role: "user", content: "two" },
      { role: "assistant", content: "b" },
      { role: "user", content: `${SUMMARY_MARKER} ...` },
      { role: "assistant", content: "c" },
    ];
    expect(forkPredatesCompaction(chain, 2, SUMMARY_MARKER)).toBe(true); // fork at "two" — marker after
    expect(forkPredatesCompaction(chain, 4, SUMMARY_MARKER)).toBe(true); // fork AT the marker
    expect(forkPredatesCompaction(chain.slice(0, 4), 2, SUMMARY_MARKER)).toBe(false); // no marker after
  });
});

// ---------------------------------------------------------------------------
// M53 review fixes — branch-aware resume (active_branch session entries) and
// parent-resolution preference (uuid-bearing nodes beat fingerprint matches).
// ---------------------------------------------------------------------------
import { messageEntryId } from "../src/compaction.js";
import {
  ACTIVE_BRANCH_ENTRY_TYPE,
  activeBranchLeafKey,
  resumeChain,
} from "../src/session/branch.js";
import type { SessionEntry } from "../src/session/store.js";

describe("branch-aware resume (M53 review fix)", () => {
  const entriesOf = (...extra: SessionEntry[]): SessionEntry[] => [...branched, ...extra];

  it("activeBranchLeafKey reads the LAST well-formed active_branch entry", () => {
    expect(
      activeBranchLeafKey(entriesOf(
        { type: "active_branch", data: { leafKey: "stale" } },
        { type: "model_change", model: "m", at: "t" },
        { type: "active_branch", data: { leafKey: "b3" } },
      )),
    ).toBe("b3");
    // no entries / junk payloads → undefined (the load falls back to linear-last)
    expect(activeBranchLeafKey(entriesOf())).toBeUndefined();
    expect(activeBranchLeafKey(entriesOf({ type: "active_branch", data: { leafKey: 42 } }))).toBeUndefined();
    expect(activeBranchLeafKey(entriesOf({ type: "active_branch", data: {} }))).toBeUndefined();
    // a junk payload does not erase an earlier good recording
    expect(
      activeBranchLeafKey(entriesOf({ type: "active_branch", data: { leafKey: "b3" } }, { type: "active_branch", data: null })),
    ).toBe("b3");
    expect(ACTIVE_BRANCH_ENTRY_TYPE).toBe("active_branch");
  });

  it("resumeChain walks the RECORDED branch: trunk-to-cut + branch, abandoned turns out", () => {
    const chain = resumeChain(branched, "b3");
    expect(chain.map((m) => m.uuid ?? m.content)).toEqual(["u1", "done", "...", "b3", "refactored carefully"]);
    // the abandoned span ([u2 "refactor it", a2 "refactored"]) stays out
    expect(chain.some((m) => m.content === "refactored")).toBe(false);
  });

  it("resumeChain falls back to the linear-last chain when the leaf is absent or corrupt", () => {
    expect(resumeChain(branched, undefined)).toEqual(activeChain(branched));
    expect(resumeChain(branched, "no-such-leaf")).toEqual(activeChain(branched));
  });

  it("a legacy no-branch file resumes to its full linear history (byte-identical)", () => {
    expect(resumeChain(legacyTrunk, undefined)).toEqual(legacyTrunk);
  });

  it("a fingerprint leaf with duplicate content resolves to the LATEST copy (the chain's own)", () => {
    // "again" twice, uuid-less: the recorded leaf names the retry (the latest
    // copy); the chain through it must be the retry's, not stopped at the
    // abandoned first copy.
    const dup: AgentMessage[] = [
      { role: "user", content: "one" },
      { role: "user", content: "again" }, // abandoned first copy
      { role: "assistant", content: "abandoned answer" },
      { role: "user", content: "again" }, // the retry — the recorded leaf
      { role: "assistant", content: "retry answer" },
    ];
    const chain = resumeChain(dup, messageEntryId({ role: "user", content: "again" }));
    expect(chain.map((m) => m.content)).toEqual(["one", "again", "abandoned answer", "again", "retry answer"]);
  });
});

describe("parentIndex uuid preference (M53 review fix)", () => {
  it("a uuid-bearing match beats a NEARER fingerprint match", () => {
    // The link string is a node's uuid that ALSO equals the entry-id
    // fingerprint of a nearer uuid-less sibling (identical content). The
    // uuid-bearing node must win — a uuid names exactly one node.
    const nearer = { role: "assistant", content: "same bytes" };
    const link = messageEntryId(nearer);
    const crafted: AgentMessage[] = [
      { role: "user", content: "root", uuid: "r" },
      { role: "assistant", content: "carries the link as its uuid", uuid: link },
      nearer,
      { role: "user", content: "child", uuid: "c", parentUuid: link },
    ];
    expect(parentIndex(crafted, 3)).toBe(1);
  });
});
