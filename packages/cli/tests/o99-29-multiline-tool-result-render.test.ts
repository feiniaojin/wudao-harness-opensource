// ω99-29 T2 — headless multi-line tool-result rendering. ω99-26's campaign
// evidence (/tmp/o26-campaign.log, read-only): the mission_complete tool
// result carries a second line (`技能包（…）将于会话边界卸载`) that NEVER hit
// the screen — `grep -c 将于会话边界卸载` over the whole campaign log = 0.
// Phase-1 delimitation (recorded in omega99-29-report.md):
//   · the campaign ran at the DEFAULT info level, where repl.ts's tool-result
//     render is debug-gated — tool results did not print AT ALL; the visible
//     mission lines came from the model's own streamed text and the mission
//     controller's notify channel (level semantics stay as-is per the brief's
//     negative boundary #4);
//   · the ACTUAL rendering defect: at debug level the render ran the result
//     through truncate() — log.ts's whitespace collapse (`\s+`→" ") folds
//     every newline into a space, so a multi-line result prints as ONE
//     glued line (and a >400-char result loses its tail outright).
// These cases pin the fix: line structure survives the render.
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runRepl } from "../src/repl.js";
import { truncateMultiline } from "../src/log.js";
import type { ProviderConfig } from "@wudao/providers";
import type { Tool } from "@wudao/core";

// ω99-32 T2: the info preview rides the dim escape pair — assert on the
// stripped text so ^/$ anchors hold.
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  await delay();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`o99-29 T2: timed out waiting for ${what}`);
    await delay(10);
  }
}

const enc = new TextEncoder();
const sse = (frames: readonly unknown[]): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({
  start(c) {
    for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
    c.enqueue(enc.encode("data: [DONE]\n\n"));
    c.close();
  },
});
const answer = (text: string): readonly unknown[] => [
  { id: "a", choices: [{ index: 0, delta: { content: text } }] },
  { id: "a", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } },
];
const toolRound = (name: string, id: string): readonly unknown[] => [
  { id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "{}" } }] } }] },
  { id, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 5 } },
];

// The EXACT mission_complete result shape (mission.ts:742): first line = the
// completion receipt, second line = the bundle-unmount notice.
const MISSION_RESULT = "✅ t5 完成 — 🚩 mission 完成（5/5 任务完成）：三方事实一致性核查与修复：wudao-harness 0.3.42 已发版，对 README.md、docs/desktop.md、website/index.html 三处文档做事实漂移核查\n技能包（ref-docs）将于会话边界卸载";

const missionTool = (): Tool => ({
  name: "mission_complete",
  description: "test fixture: the mission_complete result shape",
  parameters: { type: "object", properties: {} },
  isReadOnly: () => true,
  execute: async () => ({ content: MISSION_RESULT }),
});

describe("ω99-29 T2 — multi-line tool results keep their line structure", () => {
  it("debug level: every line of a mission_complete-shaped result renders as its own screen line", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "o9929-ml-")));
    const globalHome = await mkdtemp(join(tmpdir(), "o9929-ml-gh-"));
    const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
    const prevLevel = process.env.WUDAO_LOG_LEVEL;
    const prevFetch = globalThis.fetch;
    const prevArgv = process.argv;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    process.env.WUDAO_LOG_LEVEL = "debug";
    process.argv = [prevArgv[0]!, "wudao", "--auto"];
    const script: readonly (readonly unknown[])[] = [
      toolRound("mission_complete", "c1"),
      answer("done"),
    ];
    let calls = 0;
    globalThis.fetch = (async () => {
      const frames = script[calls] ?? answer("ok");
      calls += 1;
      return new Response(sse(frames), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    let seen = "";
    let fed = 0;
    const lines = ["complete t5", "/exit"];
    const drain = (): string => { let t = ""; let c = stdout.read(); while (c !== null) { t += c.toString(); c = stdout.read(); } return t; };
    const pump = (): void => {
      seen += drain();
      const prompts = seen.split("wudao> ").length - 1;
      while (fed < lines.length && fed < prompts) { stdin.write(`${lines[fed]}\n`); fed += 1; }
    };
    process.env.WUDAO_GLOBAL_HOME = globalHome;
    let replError: unknown;
    let done: Promise<void> | undefined;
    try {
      done = runRepl({
        config: { apiKey: "sk-o9929", baseURL: "https://o9929-ml.invalid/v1", model: "o9929-model" } satisfies ProviderConfig,
        workspaceRoot: ws,
        buildTools: () => [missionTool()],
        contextWindowTokens: 200_000,
        sessionId: "wudao-o9929ml",
        stdin,
        stdout,
      });
      await until(() => { pump(); return seen.includes("done"); }, "the run to settle");
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) { pump(); if (fed >= lines.length) break; await delay(10); }
      await Promise.race([done!, delay(5_000)]);
    } catch (err) {
      replError = err;
    } finally {
      stdin.end();
      if (done !== undefined) await Promise.race([done.then(() => {}, () => {}), delay(500)]);
      process.argv = prevArgv;
      process.env.WUDAO_LOG_LEVEL = prevLevel;
      process.env.WUDAO_GLOBAL_HOME = prevGlobal;
      globalThis.fetch = prevFetch;
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    if (replError !== undefined) throw replError;
    // Line structure survived: the receipt's first line and its second line
    // are separate SCREEN lines (a newline between them). Pre-fix the render
    // folded "\n" into a space — one glued line, regex fails.
    expect(seen).toMatch(/✅ t5 完成[^\n]*\n[^\n]*技能包（ref-docs）将于会话边界卸载/);
  }, 20_000);

  it("info level (the campaign's level): the result renders as ONE folded preview line — ω99-32 T2's contract (supersedes the ω99-29 delimitation)", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "o9929-info-")));
    const globalHome = await mkdtemp(join(tmpdir(), "o9929-info-gh-"));
    const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
    const prevFetch = globalThis.fetch;
    const prevArgv = process.argv;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    delete process.env.WUDAO_LOG_LEVEL; // the default: info
    process.argv = [prevArgv[0]!, "wudao", "--auto"];
    const script: readonly (readonly unknown[])[] = [
      toolRound("mission_complete", "c1"),
      answer("done"),
    ];
    let calls = 0;
    globalThis.fetch = (async () => {
      const frames = script[calls] ?? answer("ok");
      calls += 1;
      return new Response(sse(frames), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    let seen = "";
    let fed = 0;
    const lines = ["complete t5", "/exit"];
    const drain = (): string => { let t = ""; let c = stdout.read(); while (c !== null) { t += c.toString(); c = stdout.read(); } return t; };
    const pump = (): void => {
      seen += drain();
      const prompts = seen.split("wudao> ").length - 1;
      while (fed < lines.length && fed < prompts) { stdin.write(`${lines[fed]}\n`); fed += 1; }
    };
    process.env.WUDAO_GLOBAL_HOME = globalHome;
    let replError: unknown;
    let done: Promise<void> | undefined;
    try {
      done = runRepl({
        config: { apiKey: "sk-o9929", baseURL: "https://o9929-info.invalid/v1", model: "o9929-model" } satisfies ProviderConfig,
        workspaceRoot: ws,
        buildTools: () => [missionTool()],
        contextWindowTokens: 200_000,
        sessionId: "wudao-o9929info",
        stdin,
        stdout,
      });
      await until(() => { pump(); return seen.includes("done") && seen.includes("🔧 mission_complete"); }, "the run to settle (tool line visible)");
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) { pump(); if (fed >= lines.length) break; await delay(10); }
      await Promise.race([done!, delay(5_000)]);
    } catch (err) {
      replError = err;
    } finally {
      stdin.end();
      if (done !== undefined) await Promise.race([done.then(() => {}, () => {}), delay(500)]);
      process.argv = prevArgv;
      process.env.WUDAO_GLOBAL_HOME = prevGlobal;
      globalThis.fetch = prevFetch;
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    if (replError !== undefined) throw replError;
    // ω99-32 T2 superseded this delimitation: info now renders the TUI-shaped
    // single-line preview (`  ↳ …`, the campaign's grep target finally
    // visible at the default level), while the full multi-line body stays
    // debug-only. What survives of the old record: the 🔧 tool line prints,
    // and the result NEVER expands to its multi-line structure at info.
    const plain = stripAnsi(seen);
    expect(plain).toContain("🔧 mission_complete");
    expect(plain.match(/^ {2}↳ ✅ t5 完成.*将于会话边界卸载$/m)).not.toBeNull();
    expect(plain).not.toMatch(/\n技能包（ref-docs）将于会话边界卸载/);
    expect(plain.match(/^ {4}↳ /m)).toBeNull();
  }, 20_000);

  // ② The helper's own behavior pin (the brief's truncate-behavior nail, in
  // its multiline form — truncate() itself is untouched and stays pinned in
  // tests/log.test.ts).
  describe("truncateMultiline", () => {
    it("keeps lines as lines (the mission_complete shape)", () => {
      expect(truncateMultiline("first line\nsecond line", 400)).toBe("first line\nsecond line");
    });
    it("trims per-line whitespace and drops blank runs, keeping structure", () => {
      expect(truncateMultiline("  a  \n\n\n  b  ", 400)).toBe("a\nb");
    });
    it("cuts on a line boundary with an ellipsis marker — never welds two lines", () => {
      const out = truncateMultiline("aaaa\nbbbb\ncccc", 6);
      expect(out).toBe("aaaa\n…");
      expect(out.includes("\n")).toBe(true);
    });
    it("a single huge line truncates inline (truncate()'s behavior)", () => {
      expect(truncateMultiline("x".repeat(10), 4)).toBe("xxxx…");
    });
    it("empty / whitespace-only input renders empty", () => {
      expect(truncateMultiline("", 400)).toBe("");
      expect(truncateMultiline(" \n \n ", 400)).toBe("");
    });
  });
});
