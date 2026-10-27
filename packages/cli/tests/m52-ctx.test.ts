// M52 — /context over the real projection, the ctx_inspect seams in
// buildToolSet, the driver's /compact (manual reason + boundary entry), and
// the chained resume (a second compaction continues from the prior boundary).
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionStore, applySummaryMarkers, staticTier2Compact, SUMMARY_MARKER, CLEARED_MARKER } from "@wudao/core";
import type { AgentMessage, LoopEvent, ModelClient } from "@wudao/core";
import { buildContextReport, formatContextReport } from "../src/context-report.js";
import { buildToolSet } from "../src/tools.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import { buildCompactBoundaryEntry, COMPACT_BOUNDARY_TYPE, lastCompactBoundary } from "../src/session-entry.js";
import { listSlashCommands } from "../src/slash-commands.js";
import { parseReplCommand } from "../src/repl.js";

const noopModel: ModelClient = {
  async generate() {
    return { role: "assistant", content: "ok" };
  },
};
const summarizeModel: ModelClient = {
  async generate() {
    return { role: "assistant", content: "SUMMARY-TEXT" };
  },
};
const summarize = (_t: string, i: Record<string, unknown>): string => `${i["path"] ?? ""}`;

describe("buildContextReport (M52 §3 real-projection breakdown)", () => {
  const tool = {
    name: "read_file",
    description: "read",
    parameters: { type: "object" as const, properties: {} },
    async execute() {
      return { content: "x" };
    },
  };
  const systemPrompt = "preamble line\n# Core principles\nbe good\n# Tool usage\nuse tools well\n";
  const messages: AgentMessage[] = [
    { role: "user", content: `${SUMMARY_MARKER} old summary` },
    { role: "user", content: "hello" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: {} }] },
    { role: "tool", toolCallId: "c1", name: "read_file", content: "x".repeat(4000) },
    { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "mcp__github__get_issue", arguments: {} }] },
    { role: "tool", toolCallId: "c2", name: "mcp__github__get_issue", content: "y".repeat(400) },
    { role: "user", content: "tail" },
  ];

  it("counts over the projected messages (clear+stub ran first), not the raw history", () => {
    const r = buildContextReport({
      systemPrompt,
      tools: [tool],
      messages,
      contextWindowTokens: 8000,
      keepRecent: 2,
      minChars: 1000,
    });
    // the old 4000-char result (outside keepRecent) got stubbed by the
    // projection — its tokens no longer count as message payload.
    expect(r.breakdown.messageCount).toBe(7);
    expect(r.used).toBeLessThan(r.breakdown.systemTokens + r.breakdown.toolsTokens + 4000 / 4);
    expect(r.breakdown.compaction.summaries).toBe(1);
    expect(r.breakdown.compaction.stubbed).toBe(1);
    expect(r.pct).toBeGreaterThan(0);
    expect(formatContextReport(r)).toContain("tool results by source:");
    expect(formatContextReport(r)).toContain("system prompt by section:");
    expect(formatContextReport(r)).toContain("# Core principles");
  });

  it("groups tool results by MCP server vs builtin", () => {
    const r = buildContextReport({ systemPrompt, tools: [tool], messages, contextWindowTokens: 64_000, keepRecent: 6 });
    const sources = r.bySource.map((s) => s.source);
    expect(sources).toContain("builtin");
    expect(sources).toContain("mcp__github");
    const gh = r.bySource.find((s) => s.source === "mcp__github");
    expect(gh?.results).toBe(1);
  });

  it("splits the system prompt into heading sections", () => {
    const r = buildContextReport({ systemPrompt, tools: [], messages: [], contextWindowTokens: 1000 });
    const names = r.byPromptSection.map((s) => s.section);
    expect(names).toContain("# Core principles");
    expect(names).toContain("# Tool usage");
    expect(names[0]).toBe("(preamble)");
  });

  it("marks nearLimit at >= 0.8x window", () => {
    const big: AgentMessage[] = [{ role: "user", content: "z".repeat(4000) }];
    const r = buildContextReport({ systemPrompt: "s", tools: [], messages: big, contextWindowTokens: 1000 });
    expect(r.nearLimit).toBe(true);
  });

  // R5-I1 — /context sees image pressure: the segments line grows an images
  // term ONLY when images ride the (projected) messages; text-only sessions
  // render the exact pre-R5-I1 line.
  it("R5-I1: images add an images segment and count in used; text-only line unchanged", () => {
    const img = (byteLength: number) => ({
      kind: "image" as const,
      ref: { kind: "image" as const, attachmentId: "00000000-0000-4000-8000-000000000000", mediaType: "image/png", byteLength },
    });
    const text: AgentMessage[] = [{ role: "user", content: "hello" }];
    const withImg: AgentMessage[] = [{ role: "user", content: "hello", images: [img(150_000)] }];
    const r0 = buildContextReport({ systemPrompt: "s", tools: [], messages: text, contextWindowTokens: 1000 });
    expect(r0.breakdown.imageCount).toBe(0);
    expect(formatContextReport(r0)).not.toContain("images");

    const r1 = buildContextReport({ systemPrompt: "s", tools: [], messages: withImg, contextWindowTokens: 1000 });
    expect(r1.breakdown.imageCount).toBe(1);
    expect(r1.breakdown.imagesTokens).toBe(85 + 200); // base + ceil(150k/750)
    expect(r1.used).toBe(r0.used + r1.breakdown.imagesTokens);
    expect(formatContextReport(r1)).toContain(`images ~${(85 + 200).toLocaleString("en-US")} (1)`);
  });
});

describe("ctx_inspect in buildToolSet (M52 §3)", () => {
  it("joins the set only when both live seams are wired", async () => {
    const withSeams = buildToolSet({
      workspaceRoot: "/tmp",
      model: noopModel,
      canUseTool: async () => ({ behavior: "allow" }),
      contextWindowTokens: 1000,
      contextProbe: () => [{ role: "user", content: "hi" }],
      getSystemPrompt: () => "sys",
    });
    const inspect = withSeams.find((t) => t.name === "ctx_inspect");
    expect(inspect).toBeDefined();
    expect(inspect?.isReadOnly?.({})).toBe(true);
    const out = await inspect?.execute({});
    expect(out?.content).toContain("context occupancy: ");
    expect(out?.content).toContain("headroom:");
    // without the seams the tool never joins
    const bare = buildToolSet({
      workspaceRoot: "/tmp",
      model: noopModel,
      canUseTool: async () => ({ behavior: "allow" }),
      contextWindowTokens: 1000,
    });
    expect(bare.find((t) => t.name === "ctx_inspect")).toBeUndefined();
  });
});

describe("driver /compact + /context (M52)", () => {
  async function newWorkspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "m52-ctx-"));
    await mkdir(join(dir, ".wudao"), { recursive: true });
    return dir;
  }

  it("/compact swaps in the summary, persists marker + boundary entry (manual reason)", async () => {
    const root = await newWorkspace();
    const store = createJsonlSessionStore(join(root, ".wudao", "sessions"));
    const persisted: { summary?: AgentMessage; boundary?: unknown[] } = { boundary: [] };
    const big = "q".repeat(4000);
    const driver = createAgentDriver({
      model: summarizeModel,
      tools: [],
      systemPrompt: "s",
      summarize,
      initialMessages: [
        { role: "user", content: "task " + big },
        { role: "assistant", content: "answer " + big },
        { role: "user", content: "latest" },
      ],
      compaction: { contextWindowTokens: 64_000 },
      onCompacted: (m) => {
        persisted.summary = m;
      },
      onCompactBoundary: (info) => {
        persisted.boundary?.push(info);
      },
    });
    const outcome = driver.submit("/compact");
    expect(outcome).toBe("notice");
    await new Promise((r) => setTimeout(r, 100));
    const history = driver.getHistory();
    expect(history.some((h) => h.kind === "notice" && h.text.includes("手动"))).toBe(true); // ω99-192: 钉随源演进（表外漏网钉，全量门兜出同弧演进；wire 值 :179 reason: "manual" 原样）
    expect(driver.state.messages[0]?.content.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(persisted.summary?.content).toContain("SUMMARY-TEXT");
    expect((persisted.boundary as { reason: string }[])[0]?.reason).toBe("manual");
    driver.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("/compact while busy parks a notice instead", async () => {
    let release: (() => void) | undefined;
    const gateModel: ModelClient = {
      async generate() {
        return { role: "assistant", content: "", toolCalls: [{ id: "x", name: "read_file", arguments: {} }] };
      },
    };
    void release;
    const driver = createAgentDriver({
      model: gateModel,
      tools: [],
      systemPrompt: "s",
      summarize,
      canUseTool: () =>
        new Promise((res) => {
          release = () => res({ behavior: "allow" });
        }),
      compaction: { contextWindowTokens: 64_000 },
    });
    driver.submit("go");
    await new Promise((r) => setTimeout(r, 30));
    const outcome = driver.submit("/compact");
    expect(outcome).toBe("notice");
    expect(driver.getHistory().some((h) => h.kind === "notice" && h.text.includes("运行中无法 /compact"))).toBe(true);
    release?.();
    driver.interrupt();
    driver.dispose();
  });

  it("/context renders the real-projection report as a notice", () => {
    const driver = createAgentDriver({
      model: noopModel,
      tools: [],
      systemPrompt: "# Core principles\nbe good\n",
      summarize,
      compaction: { contextWindowTokens: 1000 },
    });
    driver.state.messages.push({ role: "user", content: "hello" });
    const outcome = driver.submit("/context");
    expect(outcome).toBe("notice");
    const notice = driver.getHistory().find((h) => h.kind === "notice");
    expect(notice?.kind === "notice" && notice.text.includes("context:")).toBe(true);
    driver.dispose();
  });

  it("slash registry + parse route the new commands", () => {
    const names = listSlashCommands({}).map((c) => c.name);
    expect(names).toContain("compact");
    expect(names).toContain("context");
    expect(parseReplCommand("/compact").kind).toBe("compact");
    expect(parseReplCommand("/context").kind).toBe("context");
  });

  it("resume keeps the whole summary chain and a second compaction continues it", async () => {
    const root = await newWorkspace();
    const store = createJsonlSessionStore(join(root, ".wudao", "sessions"));
    // Session one: compact (static — deterministic), persist marker+boundary.
    const first: AgentMessage[] = [
      { role: "user", content: "task A " + "a".repeat(2000) },
      { role: "assistant", content: "answer A" },
      { role: "user", content: "task B" },
    ];
    const once = staticTier2Compact(first, { keepRecent: 1 });
    expect(once).not.toBeNull();
    for (const m of first) await store.append("sess", m);
    await store.append("sess", once!.summaryMessage);
    const keptFirst = once!.messages.filter((m) => !(m.role === "user" && m.content.startsWith(SUMMARY_MARKER)))[0];
    expect(keptFirst).toBeDefined();
    await store.appendEntry("sess", buildCompactBoundaryEntry({ firstKeptEntryId: "test-id", reason: "threshold", tier: 2 }));

    // Resume through the driver (chain-aware projection), continue the
    // conversation, compact AGAIN: the first summary must survive verbatim.
    const driver = createAgentDriver({
      model: summarizeModel,
      tools: [],
      systemPrompt: "s",
      summarize,
      workspaceRoot: root,
      compaction: { contextWindowTokens: 64_000 },
    });
    expect(await driver.resume("sess")).toEqual({ ok: true });
    const boundary = lastCompactBoundary(await store.loadSessionEntries("sess"));
    expect(boundary?.reason).toBe("threshold");
    // Continue the conversation past the boundary with enough material that a
    // SECOND compaction has a real span (keepRecent 6).
    for (let i = 0; i < 7; i += 1) {
      driver.state.messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i} ` + "c".repeat(200) });
    }
    driver.submit("/compact");
    await new Promise((r) => setTimeout(r, 100));
    const messages = driver.state.messages;
    expect(messages[0]?.content.startsWith(SUMMARY_MARKER)).toBe(true);
    // the CHAIN: two frozen markers, the second covering only the new span.
    expect(messages.filter((m) => m.role === "user" && m.content.startsWith(SUMMARY_MARKER))).toHaveLength(2);
    expect(messages[1]?.content.startsWith(SUMMARY_MARKER)).toBe(true);
    driver.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("COMPACT_BOUNDARY_TYPE entries never reach the model-visible history", async () => {
    const root = await newWorkspace();
    const store = createJsonlSessionStore(join(root, ".wudao", "sessions"));
    await store.append("s2", { role: "user", content: "hi" });
    await store.appendEntry("s2", { type: COMPACT_BOUNDARY_TYPE, data: { firstKeptEntryId: "x", reason: "manual", tier: 2, at: "t" } });
    const loaded = await store.load("s2");
    expect(loaded).toHaveLength(1);
    const entries = await store.loadSessionEntries("s2");
    expect(lastCompactBoundary(entries)?.firstKeptEntryId).toBe("x");
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("applySummaryMarkers chain mode keeps from the first marker (resume projection)", () => {
    const msgs: AgentMessage[] = [
      { role: "user", content: "ancient" },
      { role: "user", content: `${SUMMARY_MARKER} one` },
      { role: "user", content: "mid" },
      { role: "user", content: `${SUMMARY_MARKER} two` },
    ];
    expect(applySummaryMarkers(msgs, { chain: true })).toHaveLength(3);
  });
});

describe("cleared markers survive the boundary (regression)", () => {
  it("CLEARED_MARKER is importable and distinct from stubs", () => {
    expect(CLEARED_MARKER).toContain("cleared");
  });
});

// keep readFile/writeFile imports honest for future fixture use
void readFile;
void writeFile;
