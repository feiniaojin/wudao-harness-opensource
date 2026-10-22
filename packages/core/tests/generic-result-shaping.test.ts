// ω-1b — the loop-level generic large-result guard (the upstream project
// large_response_handler.rs:5-14, digest 98a): EVERY tool's string result —
// not just shell's (M46) — gets the head/tail + spill treatment before
// it enters history, over looser thresholds (1000 lines / 50KB). read_file is
// exempt (the M24 clause: it IS the paging primitive). Spill rides the M24
// seam (.wudao/spill/<session>/, sha256-named); a failed spill write means no
// shaping (fail-open, M46's fallback doctrine). Loop integration: the shaped
// text is what lands in state.messages and on the finished event.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shapeGenericToolResult,
  UNSHAPED_TOOLS,
  DEFAULT_GENERIC_RESULT_CONFIG,
  type GenericResultShaping,
} from "../src/tools/generic-result.js";
import { runAgentLoop } from "../src/index.js";
import type { AgentState, AssistantMessage, LoopEvent, ModelClient, ModelInput, Terminal, Tool } from "../src/index.js";

let root: string;
let spillDir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "grs-"));
  spillDir = join(root, ".wudao", "spill", "test-session");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line-${i + 1}`).join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// pure shaping
// ---------------------------------------------------------------------------

describe("shapeGenericToolResult", () => {
  it("exports the generic thresholds and the M24 exemption list", () => {
    expect(DEFAULT_GENERIC_RESULT_CONFIG.lineThreshold).toBe(1_000);
    expect(DEFAULT_GENERIC_RESULT_CONFIG.byteThreshold).toBe(50_000);
    expect(UNSHAPED_TOOLS).toContain("read_file");
  });

  it("shapes over the line lane: marker + spill path + guidance + receipt, spill holds the full text", async () => {
    const raw = lines(1_200);
    const res = shapeGenericToolResult(raw, { spillDir });
    if (res === undefined) throw new Error("expected shaping");
    expect(res.shaped).toContain("[省略 1000 行");
    const spillPath = /完整输出已保存至 (.+?)\] \.\.\./.exec(res.shaped)?.[1];
    if (spillPath === undefined) throw new Error(`no spill path in:\n${res.shaped}`);
    expect(spillPath).toContain(spillDir);
    expect(res.shaped).toContain("如需完整输出");
    expect(res.shaped).toContain("[shaped h100/t100, +1000 lines spilled]");
    // Head 100 / tail 100 around the marker — nothing in between.
    const out = res.shaped.split("\n");
    expect(out[0]).toBe("line-1");
    expect(out[99]).toBe("line-100");
    expect(out[100]).toContain("省略 1000 行");
    expect(out[101]).toBe("line-1101");
    expect(out[200]).toBe("line-1200");
    expect(res.shaped).not.toContain("\nline-101\n");
    expect(res.shaped).not.toContain("\nline-1100\n");
    // The spill file holds the FULL raw output verbatim.
    expect(await readFile(spillPath, "utf8")).toBe(raw);
  });

  it("shapes over the byte lane alone (under the line threshold)", async () => {
    // 600 lines × ~120B ≈ 72KB: under 1000 lines, over 50KB.
    const raw = Array.from({ length: 600 }, (_, i) => `L${String(i + 1).padStart(6, "0")} ${"x".repeat(110)}`).join("\n") + "\n";
    const res = shapeGenericToolResult(raw, { spillDir });
    if (res === undefined) throw new Error("expected shaping");
    expect(res.shaped).toContain("省略 400 行");
    const spillPath = /完整输出已保存至 (.+?)\] \.\.\./.exec(res.shaped)?.[1];
    expect(await readFile(spillPath ?? "/none", "utf8")).toBe(raw);
  });

  it("returns undefined under both thresholds (and spills nothing)", async () => {
    expect(shapeGenericToolResult(lines(1_000), { spillDir })).toBeUndefined(); // AT the line threshold
    expect(shapeGenericToolResult("x".repeat(50_000), { spillDir })).toBeUndefined(); // AT the byte threshold
    expect(await readdir(spillDir).catch(() => [])).toEqual([]); // dir may not exist — nothing spilled
  });

  it("absent spillDir = shaping OFF (the M46 config-absent kill-switch pattern)", () => {
    expect(shapeGenericToolResult(lines(2_000), {})).toBeUndefined();
    expect(shapeGenericToolResult(lines(2_000))).toBeUndefined();
  });

  it("a failed spill write returns undefined (fail-open: the raw result passes through)", async () => {
    await writeFile(join(root, "blocker"), "not a directory", "utf8");
    const blocked: GenericResultShaping = { spillDir: join(root, "blocker", "spill") }; // mkdir fails
    expect(shapeGenericToolResult(lines(1_200), blocked)).toBeUndefined();
  });

  it("honors an injected custom config", () => {
    const res = shapeGenericToolResult(lines(20), { spillDir, config: { lineThreshold: 10, byteThreshold: 50_000, headLines: 2, tailLines: 3 } });
    if (res === undefined) throw new Error("expected shaping");
    expect(res.shaped.split("\n")).toEqual([
      "line-1",
      "line-2",
      expect.stringContaining("省略 15 行"),
      "line-18",
      "line-19",
      "line-20",
      "如需完整输出,用 read_file 读取该文件",
      expect.stringContaining("[shaped h2/t3, +15 lines spilled]"),
    ]);
  });
});

// ---------------------------------------------------------------------------
// loop integration: shaping rides the executeToolCall seam, before history.
// ---------------------------------------------------------------------------

const SYSTEM = "You are a deterministic test agent.";

function stateWith(tools: readonly Tool[]): AgentState {
  return { systemPrompt: SYSTEM, messages: [{ role: "user", content: "do the thing" }], tools: [...tools], status: "idle" };
}

function recordingModel(responses: readonly AssistantMessage[]): ModelClient {
  let i = 0;
  return {
    async generate(input: ModelInput): Promise<AssistantMessage> {
      void input;
      const r = responses[i];
      i += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

async function drain(gen: AsyncGenerator<LoopEvent, Terminal>): Promise<{ events: LoopEvent[]; terminal: Terminal }> {
  const events: LoopEvent[] = [];
  for (;;) {
    const { done, value } = await gen.next();
    if (done) return { events, terminal: value };
    events.push(value);
  }
}

describe("runAgentLoop — generic result shaping integration", () => {
  it("an oversized web_fetch result lands in history shaped, with the full text spilled", async () => {
    const bigTool: Tool = {
      name: "web_fetch",
      description: "fetches",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      execute: async () => ({ content: lines(1_200) }),
    };
    const model = recordingModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "web_fetch", arguments: { url: "https://x" } }] },
      { role: "assistant", content: "done" },
    ]);
    const state = stateWith([bigTool]);
    const { events, terminal } = await drain(runAgentLoop(state, model, {
      maxTurns: 6,
      gates: { todo: false, verify: false },
      genericResultShaping: { spillDir },
    }));

    expect(terminal.reason).toBe("completed");
    const msg = state.messages.find((m) => m.role === "tool");
    expect(msg?.content).toContain("省略 1000 行");
    const spillPath = /完整输出已保存至 (.+?)\] \.\.\./.exec(msg?.content ?? "")?.[1];
    if (spillPath === undefined) throw new Error("no spill path");
    expect(await readFile(spillPath, "utf8")).toBe(lines(1_200));
    // The finished event carries the shaped text (what the model saw).
    const finished = events.find((e): e is Extract<LoopEvent, { type: "tool_call_finished" }> => e.type === "tool_call_finished");
    expect(finished?.result).toContain("省略 1000 行");
  });

  it("read_file is exempt (M24: it IS the paging primitive — its results are never shaped)", async () => {
    const readFileLike: Tool = {
      name: "read_file",
      description: "reads",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: async () => ({ content: lines(1_200) }),
    };
    const model = recordingModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }] },
      { role: "assistant", content: "done" },
    ]);
    const state = stateWith([readFileLike]);
    const { terminal } = await drain(runAgentLoop(state, model, {
      maxTurns: 6,
      gates: { todo: false, verify: false },
      genericResultShaping: { spillDir },
    }));

    expect(terminal.reason).toBe("completed");
    const msg = state.messages.find((m) => m.role === "tool");
    expect(msg?.content.split("\n").length).toBe(1_201); // 1200 lines + trailing newline — everything inline
    expect(msg?.content).not.toContain("省略");
    expect(await readdir(spillDir).catch(() => [])).toEqual([]); // nothing spilled
  });
});
