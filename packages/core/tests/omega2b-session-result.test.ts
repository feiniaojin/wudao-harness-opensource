// ω-2b (I3) — session paged tool-result recovery. Acceptance per design §3-E:
//   · seeded JSONL with a 100KB tool result → a microcompact stub names
//     session_result with the correct tr- ref (sha256 recomputed
//     independently — NOT via toolResultRef);
//   · page 0 → header {total, sha256, next_offset ≈ 16384 (surrogate-
//     snapped), complete:false}; the final page completes; pages concatenate
//     to the original;
//   · unknown id → typed not-found; duplicate id → ambiguity error listing
//     refs; wrong ref → not-found naming candidates;
//   · offset on a surrogate half → snapped; limit > 24576 → arg error;
//   · tier-0 clear markers carry the pointer line; [SKILL_PRUNED] keeps its
//     read_file reload semantics.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  createSessionResultTool,
  toolResultRef,
  createJsonlSessionStore,
  microcompact,
  clearTier,
  occupancyBreakdown,
  CLEARED_MARKER,
  COMPACTION_STUB_PREFIX,
  formatSkillPrunedMarker,
} from "../src/index.js";
import { pageToolResult, SESSION_RESULT_PAGE_DEFAULT, SESSION_RESULT_PAGE_MAX } from "../src/tools/session-result.js";
import type { AgentMessage, ToolResultMessage } from "../src/types.js";

/** Independent ref computation (deliberately NOT toolResultRef): sha256 of
 *  id + NUL + body, first 12 hex chars, "tr-" prefixed. */
function independentRef(id: string, body: string): string {
  return `tr-${createHash("sha256").update(`${id}\0${body}`, "utf8").digest("hex").slice(0, 12)}`;
}

const result = (id: string, content: string, name = "shell"): ToolResultMessage => ({
  role: "tool",
  toolCallId: id,
  name,
  content,
});

describe("toolResultRef (ω-2b I3)", () => {
  it("is the pinned sha256 spelling, computed independently", () => {
    const body = "x".repeat(1_000);
    expect(toolResultRef("call_1", body)).toBe(independentRef("call_1", body));
  });

  it("depends on both id and content; deterministic across calls", () => {
    expect(toolResultRef("a", "b")).toBe(toolResultRef("a", "b"));
    expect(toolResultRef("a", "b")).not.toBe(toolResultRef("a", "c"));
    expect(toolResultRef("a", "b")).not.toBe(toolResultRef("ab", ""));
  });
});

describe("pageToolResult (ω-2b I3)", () => {
  const BODY = "0123456789".repeat(4_000); // 40k units, pure BMP

  it("page 0: default window, header shape, not complete", () => {
    const { header, page } = pageToolResult(BODY, 0, SESSION_RESULT_PAGE_DEFAULT, "tr-fixed");
    expect(page.length).toBe(SESSION_RESULT_PAGE_DEFAULT);
    expect(header).toEqual({
      result_ref: "tr-fixed",
      offset: 0,
      next_offset: SESSION_RESULT_PAGE_DEFAULT,
      total: BODY.length,
      sha256: createHash("sha256").update(BODY, "utf8").digest("hex"),
      complete: false,
    });
  });

  it("pages concatenate exactly to the original; the final page completes", () => {
    let offset = 0;
    let joined = "";
    let complete = false;
    for (let i = 0; i < 100 && !complete; i += 1) {
      const p = pageToolResult(BODY, offset, 7_000);
      joined += p.page;
      offset = p.header.next_offset;
      complete = p.header.complete;
    }
    expect(complete).toBe(true);
    expect(joined).toBe(BODY);
  });

  it("surrogate snapping: an offset on a LOW half snaps back; a page END splitting a pair snaps back", () => {
    // One leading BMP char, then surrogate pairs (😀 U+1F600), then filler.
    const pairs = "😀".repeat(1_000);
    const body = `a${pairs}b`;
    // Offset 2 lands on the LOW half of the first pair → snapped to 1.
    const p = pageToolResult(body, 2, 100);
    expect(p.header.offset).toBe(1);
    expect(p.page.charCodeAt(0)).toBeGreaterThanOrEqual(0xd800); // starts on the HIGH half
    // A limit ending right after a HIGH half leaves the partner for the next
    // page: offset 1 + limit 1 would split the pair → end snaps back.
    const split = pageToolResult(body, 1, 1);
    expect(split.page.length).toBe(0);
    expect(split.header.next_offset).toBe(1);
    // Concatenation still holds across snapped edges.
    let offset = 1;
    let joined = "";
    let complete = false;
    for (let i = 0; i < 5_000 && !complete; i += 1) {
      const q = pageToolResult(body, offset, 999);
      joined += q.page;
      offset = q.header.next_offset;
      complete = q.header.complete;
    }
    expect(joined).toBe(body.slice(1));
  });

  it("argument errors: negative offset, limit 0, limit over the 24KB max", () => {
    expect(() => pageToolResult(BODY, -1, 100)).toThrow(/offset/);
    expect(() => pageToolResult(BODY, 0, 0)).toThrow(/limit/);
    expect(() => pageToolResult(BODY, 0, SESSION_RESULT_PAGE_MAX + 1)).toThrow(/limit/);
    expect(() => pageToolResult(BODY, 0, SESSION_RESULT_PAGE_MAX)).not.toThrow();
  });

  it("an offset past the end is a graceful empty complete page", () => {
    const p = pageToolResult(BODY, BODY.length + 50, 100);
    expect(p.page).toBe("");
    expect(p.header.complete).toBe(true);
    expect(p.header.next_offset).toBe(BODY.length);
  });
});

// ---------------------------------------------------------------------------
// The tool over a seeded JSONL store
// ---------------------------------------------------------------------------

describe("createSessionResultTool over a seeded session (ω-2b I3)", () => {
  let dir: string;
  const SESSION = "omega2b-e2e";
  const BIG_BODY = "Z".repeat(100 * 1024); // 100KB
  const SMALL = "small result body";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "wudao-omega2b-"));
    const store = createJsonlSessionStore(dir);
    const lines: AgentMessage[] = [
      { role: "user", content: "run something big" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_big", name: "shell", arguments: { command: "x" } }] },
      result("call_big", BIG_BODY),
      { role: "assistant", content: "done" },
      { role: "user", content: "again" },
    ];
    for (const m of lines) await store.append(SESSION, m);
    // A retried duplicate id with different content (ambiguity case).
    await store.append(SESSION, { role: "assistant", content: "", toolCalls: [{ id: "call_dup", name: "shell", arguments: { command: "y" } }] });
    await store.append(SESSION, result("call_dup", "first attempt body"));
    await store.append(SESSION, { role: "assistant", content: "", toolCalls: [{ id: "call_dup", name: "shell", arguments: { command: "y2" } }] });
    await store.append(SESSION, result("call_dup", "second attempt body"));
  });

  const tool = () =>
    createSessionResultTool(async (id) => {
      const store = createJsonlSessionStore(dir);
      return (await store.load(SESSION)).filter((m): m is ToolResultMessage => m.role === "tool" && m.toolCallId === id);
    });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("page 0 of the 100KB result: header + 16KB body, not complete", async () => {
    const out = await tool().execute({ tool_call_id: "call_big" });
    expect(out.isError).not.toBe(true);
    const nl = out.content.indexOf("\n");
    const header = JSON.parse(out.content.slice(0, nl)) as ReturnType<typeof pageToolResult>["header"];
    const page = out.content.slice(nl + 1);
    expect(page.length).toBe(SESSION_RESULT_PAGE_DEFAULT);
    expect(page).toBe(BIG_BODY.slice(0, SESSION_RESULT_PAGE_DEFAULT));
    expect(header.total).toBe(BIG_BODY.length);
    expect(header.next_offset).toBe(SESSION_RESULT_PAGE_DEFAULT);
    expect(header.complete).toBe(false);
    expect(header.result_ref).toBe(independentRef("call_big", BIG_BODY));
    expect(header.sha256).toBe(createHash("sha256").update(BIG_BODY, "utf8").digest("hex"));
  });

  it("paging through completes and concatenates to the original", async () => {
    const t = tool();
    let offset = 0;
    let joined = "";
    let complete = false;
    for (let i = 0; i < 32 && !complete; i += 1) {
      const out = await t.execute({ tool_call_id: "call_big", offset });
      const nl = out.content.indexOf("\n");
      const header = JSON.parse(out.content.slice(0, nl)) as { next_offset: number; complete: boolean };
      joined += out.content.slice(nl + 1);
      offset = header.next_offset;
      complete = header.complete;
    }
    expect(complete).toBe(true);
    expect(joined).toBe(BIG_BODY);
  });

  it("an unknown id is a typed not-found error", async () => {
    const out = await tool().execute({ tool_call_id: "call_nope" });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("no tool result found");
    expect(out.content).toContain("call_nope");
  });

  it("a duplicate id without a ref is the ambiguity error listing EVERY candidate ref", async () => {
    const out = await tool().execute({ tool_call_id: "call_dup" });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("ambiguous");
    expect(out.content).toContain(independentRef("call_dup", "first attempt body"));
    expect(out.content).toContain(independentRef("call_dup", "second attempt body"));
  });

  it("a ref selects its exact candidate; a wrong ref is a not-found naming the candidates", async () => {
    const t = tool();
    const want = independentRef("call_dup", "second attempt body");
    const out = await t.execute({ tool_call_id: "call_dup", result_ref: want });
    expect(out.isError).not.toBe(true);
    expect(out.content).toContain("second attempt body");
    const bad = await t.execute({ tool_call_id: "call_dup", result_ref: "tr-000000000000" });
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("matches none");
    expect(bad.content).toContain(independentRef("call_dup", "first attempt body"));
  });

  it("the default ref parameter fills the header when paging (header carries the selected ref)", async () => {
    const t = tool();
    const want = independentRef("call_dup", "first attempt body");
    const out = await t.execute({ tool_call_id: "call_dup", result_ref: want });
    const header = JSON.parse(out.content.slice(0, out.content.indexOf("\n"))) as { result_ref: string };
    expect(header.result_ref).toBe(want);
  });

  it("limit > 24576 is an argument error surfaced as an error result", async () => {
    const out = await tool().execute({ tool_call_id: "call_big", limit: SESSION_RESULT_PAGE_MAX + 1 });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("limit");
  });

  it("an offset on a surrogate half is snapped (page start backs onto the high half)", async () => {
    // Seed a body with a surrogate pair early; ask for an offset ON the low half.
    const store = createJsonlSessionStore(dir);
    const body = `a${"😀".repeat(50)}tail`;
    await store.append(SESSION, { role: "assistant", content: "", toolCalls: [{ id: "call_sur", name: "shell", arguments: {} }] });
    await store.append(SESSION, result("call_sur", body));
    const out = await tool().execute({ tool_call_id: "call_sur", offset: 2, limit: 10 });
    expect(out.isError).not.toBe(true);
    const header = JSON.parse(out.content.slice(0, out.content.indexOf("\n"))) as { offset: number };
    expect(header.offset).toBe(1);
  });

  it("is read-only and concurrency-safe (the declared tool surface)", () => {
    const t = tool();
    expect(t.isReadOnly?.({})).toBe(true);
    expect(t.isConcurrencySafe?.({})).toBe(true);
    expect(t.name).toBe("session_result");
  });
});

// ---------------------------------------------------------------------------
// Marker wiring: stubs/clears carry the pointer
// ---------------------------------------------------------------------------

describe("compaction markers name the recovery call (ω-2b I3)", () => {
  const BIG = "Y".repeat(40_000);
  const messages = (): AgentMessage[] => [
    { role: "user", content: "task" },
    { role: "assistant", content: "", toolCalls: [{ id: "call_x", name: "grep", arguments: {} }] },
    result("call_x", BIG, "grep"),
    // ω-3b hand-check: the result used to end its exchange unseen — stubbing/
    // clearing it was the over-stub the floor closes. The ack makes it SEEN,
    // so the pointer/marker bytes these tests pin stay exercised.
    { role: "assistant", content: "grep returned" },
    { role: "user", content: "go" },
  ];

  it("a microcompact stub embeds session_result args with the correct tr- ref", () => {
    const out = microcompact(messages(), { keepRecent: 1 });
    const stub = out.find((m) => m.role === "tool") as ToolResultMessage;
    expect(stub.content.startsWith(COMPACTION_STUB_PREFIX)).toBe(true);
    expect(stub.content).toContain(`recover with session_result(tool_call_id="call_x", result_ref="${independentRef("call_x", BIG)}")`);
    // The ref matches toolResultRef's own computation of the ORIGINAL bytes.
    expect(stub.content).toContain(toolResultRef("call_x", BIG));
    // Still idempotent (a second pass skips the already-stubbed result).
    expect(microcompact(out, { keepRecent: 1 })).toEqual(out);
  });

  it("a tier-0 clear carries the marker + pointer line; the breakdown still counts it", () => {
    const out = clearTier(messages(), { keepRecent: 1 });
    const cleared = out.messages.find((m) => m.role === "tool") as ToolResultMessage;
    expect(cleared.content.startsWith(CLEARED_MARKER)).toBe(true);
    expect(cleared.content).toBe(`${CLEARED_MARKER}\nfull original retained in this session; recover with session_result(tool_call_id="call_x", result_ref="${independentRef("call_x", BIG)}")`);
    expect(occupancyBreakdown("", [], out.messages).compaction.cleared).toBe(1);
  });

  it("a skill read keeps its [SKILL_PRUNED] reload marker (read_file is the better recovery)", () => {
    const skillReads = new Map([["call_x", { name: "my-skill", path: ".claude/skills/my-skill/SKILL.md" }]]);
    const stubbed = microcompact(messages(), { keepRecent: 1, skillReads });
    expect((stubbed.find((m) => m.role === "tool") as ToolResultMessage).content)
      .toBe(formatSkillPrunedMarker("my-skill", ".claude/skills/my-skill/SKILL.md"));
    const clearedOut = clearTier(messages(), { keepRecent: 1, skillReads });
    expect((clearedOut.messages.find((m) => m.role === "tool") as ToolResultMessage).content)
      .toBe(formatSkillPrunedMarker("my-skill", ".claude/skills/my-skill/SKILL.md"));
  });
});
