// P2-10 (96 队列) — /rewind turn: the conversation档. `turn` lists the active
// chain's recent user messages (the /edit face); `turn <n>` swaps the ACTIVE
// CHAIN to before message n — branch semantics over the append-only JSONL:
// no line ever leaves the file, the rewound turns stay visible (/tree) and
// reachable (/switch), the next submit links its parentUuid at the cut, and
// the file journal is untouched (file restore stays the explicit /rewind <m>).
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTool,
  createFileHistory,
  createJsonlSessionStore,
  createScriptedModel,
  nodeKey,
} from "@wudao-org/core";
import type { AgentMessage, Tool } from "@wudao-org/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver, AgentDriverOptions, HistoryEntry } from "../src/driver/agent-driver.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

function makeDriver(opts: Partial<AgentDriverOptions> & Pick<AgentDriverOptions, "model" | "tools">): AgentDriver {
  return createAgentDriver({ systemPrompt: "s", summarize: summarizeToolCall, ...opts });
}

const readOnlyParams = {
  type: "object" as const,
  properties: { path: { type: "string" as const } },
  required: ["path"],
  additionalProperties: false,
};

function stubReadTool(content = "STUB FILE CONTENT"): Tool {
  return buildTool({
    name: "read_file",
    description: "stub read",
    parameters: readOnlyParams,
    execute: async () => ({ content }),
  });
}

function gatedTool<T>(gate: Promise<T>): Tool {
  return buildTool({
    name: "read_file",
    description: "gated read",
    parameters: readOnlyParams,
    execute: async () => {
      await gate;
      return { content: "GATED RESULT" };
    },
  });
}

const allow = vi.fn(async () => ({ kind: "allow" as const }));

const noticeText = (driver: AgentDriver): string =>
  (driver.getHistory() as HistoryEntry[])
    .filter((e): e is Extract<HistoryEntry, { kind: "notice" }> => e.kind === "notice")
    .map((e) => e.text)
    .join("\n");

const sessionFile = (root: string, id: string): string => join(root, ".wudao", "sessions", `${id}.jsonl`);

const lineCount = async (file: string): Promise<number> =>
  (await readFile(file, "utf8")).split("\n").filter((l) => l !== "").length;

const userTexts = (driver: AgentDriver): readonly string[] =>
  driver.state.messages.filter((m) => m.role === "user").map((m) => (m as { content: string }).content);

describe("AgentDriver — P2-10 /rewind turn (conversation档)", () => {
  it("rewinds the active chain to before message n: append-only JSONL, abandoned branch visible and switch-back-able, next submit at the cut", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-p210-"));
    const store = createJsonlSessionStore(join(dir, ".wudao", "sessions"));
    const model = createScriptedModel([
      { role: "assistant", content: "A1" },
      { role: "assistant", content: "A2" },
      { role: "assistant", content: "A3" },
      { role: "assistant", content: "A4" },
    ]);
    const persistedSet = new Set<AgentMessage>();
    const driver = createAgentDriver({
      model,
      tools: [stubReadTool()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      workspaceRoot: dir,
      sessionId: "p210",
      // identity-based persistence (the real frontends' rule)
      onRunComplete: async (messages) => {
        for (const m of messages) {
          if (persistedSet.has(m)) continue;
          persistedSet.add(m);
          await store.append("p210", m);
        }
      },
    });
    driver.submit("first");
    await until(() => driver.getStatus().busy === false, "run 1");
    driver.submit("second");
    await until(() => driver.getStatus().busy === false, "run 2");
    driver.submit("third");
    await until(() => driver.getStatus().busy === false, "run 3");
    await wait(50); // fire-and-forget persistence
    const file = sessionFile(dir, "p210");
    const linesBefore = await lineCount(file);

    // /rewind turn — the listing face (the /edit face: 1 = most recent)
    expect(driver.submit("/rewind turn")).toBe("notice");
    // ω99-164: 清单头与序号提示钉随源演进（rewind.ts :64 共享 helper）。
    await until(() => noticeText(driver).includes("最近消息"), "turn listing");
    expect(noticeText(driver)).toContain("1 = 最近一条");
    expect(noticeText(driver)).toContain("1. third");
    expect(noticeText(driver)).toContain("2. second");

    // /rewind turn 2 — the active chain keeps only round one
    expect(driver.submit("/rewind turn 2")).toBe("notice");
    // ω99-165: 回退回执钉随源演进（agent-driver.ts :3836 中文化）。
    await until(() => noticeText(driver).includes("已回退到第"), "rewind notice");
    expect(userTexts(driver)).toEqual(["first"]);

    // append-only red line: no line leaves the file; the audit + active-branch
    // entries are APPENDS on top of the untouched history.
    await wait(50);
    const linesAfter = await lineCount(file);
    expect(linesAfter).toBeGreaterThanOrEqual(linesBefore + 2);
    const entries = await store.loadSessionEntries("p210");
    const rewindEntry = entries.find((e): e is Extract<typeof e, { type: "rewind_turn" }> => !("role" in e) && e.type === "rewind_turn");
    expect(rewindEntry).toBeDefined();
    expect((rewindEntry?.data as { n: number } | undefined)?.n).toBe(2);

    // /tree: the abandoned turns stay visible (rewound window face)
    const tree = await driver.tree();
    expect(tree).toContain("second");
    expect(tree).toContain("third");

    // out of range while rewound (targets are now just "first")
    expect(driver.submit("/rewind turn 2")).toBe("notice");
    // ω99-165: usage 钉随源演进（agent-driver.ts :3809 中文化）。
    await until(() => noticeText(driver).includes("用法：/rewind turn"), "out-of-range usage");
    // ω99-165: brief 表外的同型钉（同源 :3809），最小演进。
    expect(noticeText(driver)).toContain("没有第 2 条消息");

    // /switch listing in the window: the abandoned branch is switchable and
    // nothing is marked current (the active chain is a prefix, not a leaf)
    const list = await driver.switchBranch();
    // ω99-165: brief 表外的同型钉（同源 agent-driver.ts :3914/:3913），最小演进；
    // 负钉同步演进防空洞——ASCII "(current)" 翻译后缺席即永真。
    expect(list).toContain("分支");
    expect(list).not.toContain("（当前）");

    // red line 2: the abandoned branch is reachable — switch back
    const back = await driver.switchBranch(1);
    expect(back).toContain("⑂ switched to branch 1");
    expect(userTexts(driver)).toEqual(["first", "second", "third"]);

    // rewind again, then the next submit continues from the cut: its
    // parentUuid links at the cut point (the tail of round one)
    expect(driver.submit("/rewind turn 2")).toBe("notice");
    await until(
      () => {
        const last = (driver.getHistory() as HistoryEntry[]).at(-1);
        // ω99-165: 回退回执钉随源演进（agent-driver.ts :3836 中文化）。
        return last?.kind === "notice" && last.text.includes("已回退到第");
      },
      "second rewind notice",
    );
    expect(userTexts(driver)).toEqual(["first"]);
    driver.submit("fourth");
    await until(() => driver.getStatus().busy === false, "post-cut run");
    const messages = driver.state.messages;
    const fourth = [...messages].reverse().find((m) => m.role === "user") as (AgentMessage & { parentUuid?: string }) | undefined;
    const idx = messages.findIndex((m) => m === fourth);
    const predecessor = idx > 0 ? messages[idx - 1] : undefined;
    expect(fourth?.parentUuid).toBe(predecessor !== undefined ? nodeKey(predecessor) : undefined);
    expect(userTexts(driver)).toEqual(["first", "fourth"]);
    // the file never shrank through the whole flow
    expect(await lineCount(file)).toBeGreaterThanOrEqual(linesBefore);
    driver.dispose();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("refuses /rewind turn <n> mid-run (the /switch discipline: explicit refusal, never queued); the read-only listing stays available", async () => {
    let release!: (v: unknown) => void;
    const gate = new Promise<unknown>((r) => {
      release = r;
    });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "g1", name: "read_file", arguments: { path: "slow.txt" } }] },
      { role: "assistant", content: "done" },
    ]);
    const driver = makeDriver({ model, tools: [gatedTool(gate)], onPermissionAsk: allow });
    driver.submit("go");
    await until(() => driver.getStatus().live.busyTools.length > 0, "run to reach the gated tool");
    const before = driver.state.messages.length;
    expect(driver.submit("/rewind turn 1")).toBe("notice");
    await until(() => noticeText(driver).includes("运行中无法 /rewind turn"), "busy refusal");
    expect(driver.state.messages.length).toBe(before); // nothing switched mid-run
    // the read-only listing is allowed mid-run (the bare /switch discipline)
    expect(driver.submit("/rewind turn")).toBe("notice");
    // ω99-164: 清单头钉随源演进（rewind.ts :64）。
    await until(() => noticeText(driver).includes("最近消息"), "mid-run listing");
    release(undefined);
    await until(() => driver.getStatus().busy === false, "run to settle");
    driver.dispose();
  });

  it("leaves the file journal untouched — file restoration stays the explicit /rewind <m> second step", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-p210f-"));
    const fileHistory = createFileHistory(join(dir, ".wudao", "history", "s1"));
    const a = join(dir, "a.txt");
    await writeFile(a, "a-v1\n", "utf8");
    await fileHistory.record(a, true, "a-v1\n", 1, "write_file");
    await writeFile(a, "a-v2\n", "utf8");
    await fileHistory.record(a, true, "a-v2\n", 2, "write_file");
    const model = createScriptedModel([
      { role: "assistant", content: "A1" },
      { role: "assistant", content: "A2" },
    ]);
    const driver = makeDriver({ model, tools: [stubReadTool()], workspaceRoot: dir, fileHistory });
    driver.submit("one");
    await until(() => driver.getStatus().busy === false, "run 1");
    driver.submit("two");
    await until(() => driver.getStatus().busy === false, "run 2");
    const journalBefore = await fileHistory.list();
    expect(driver.submit("/rewind turn 1")).toBe("notice");
    // ω99-165: 回退回执钉随源演进（agent-driver.ts :3836 中文化）。
    await until(() => noticeText(driver).includes("已回退到第"), "rewind notice");
    expect(await fileHistory.list()).toEqual(journalBefore); // the journal is untouched
    expect(await readFile(a, "utf8")).toBe("a-v2\n"); // and so is the workspace file
    driver.dispose();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
});
