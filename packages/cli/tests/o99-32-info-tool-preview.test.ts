// ω99-32 T2 — the headless info level sees each tool result as ONE preview
// line (TUI transcript parity). ω99-26's campaign ran at the DEFAULT info
// level where the tool-result render was debug-gated: `grep -c 将于会话边界卸载`
// over the whole campaign log = 0 — the operator was blind to every result.
// The TUI transcript already renders exactly this line (tui/app.tsx:365:
// `  ↳ ${isError?"[error] ":""}${resultPreview}` dim) — headless lacked not a
// design but the parity. These cases pin the ONE added info-level face:
//   ① a multi-line result folds to a single `  ↳ ` preview line (the
//      campaign's grep target becomes visible at the default level), and a
//      >RESULT_PREVIEW_CHARS result cuts with the ellipsis;
//   ② debug keeps the full multi-line body (truncateMultiline) and does NOT
//      double-render the preview;
//   ③ the existing info faces are untouched (🔧 tool line, ⛔ prompt_blocked,
//      ♻️ compact line — all coexist with the preview);
//   ④ an errored result carries the `[error] ` prefix;
//   ⑤ the one-shot -p path renders the same-shaped line.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runRepl } from "../src/repl.js";
import type { AgentMessage, Tool } from "@wudao-org/core";
import type { ProviderConfig } from "@wudao-org/providers";
// Case ⑤'s dynamic index.js import pulls ink → yoga-wasm. Loading the tui
// graph STATICALLY first (m80-resolver-wiring's shape) lets the externalized
// module evaluate on the healthy static path; the post-resetModules dynamic
// chain then reuses the cached module instead of re-preparing the wasm.
import "../src/tui/app.js";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  await delay();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`o99-32 T2: timed out waiting for ${what}`);
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

const toolRound = (name: string, id: string, args: Record<string, unknown>): readonly unknown[] => [
  { id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] },
  { id, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 5 } },
];

// The EXACT mission_complete result shape (mission.ts:742): first line = the
// completion receipt, second line = the bundle-unmount notice (the campaign's
// ungreppable target).
const MISSION_RESULT = "✅ t5 完成 — 🚩 mission 完成（5/5 任务完成）：三方事实一致性核查与修复：wudao-harness 0.3.42 已发版，对 README.md、docs/desktop.md、website/index.html 三处文档做事实漂移核查\n技能包（ref-docs）将于会话边界卸载";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** The o99-29 REPL driver with a tool set, a log level, and a window. Returns
 *  everything the REPL printed (raw — strip ANSI before asserting). */
async function driveRepl(o: {
  readonly ws: string;
  readonly sid: string;
  readonly lines: readonly string[];
  readonly script: readonly (readonly unknown[])[];
  readonly tools?: readonly Tool[];
  readonly level?: "info" | "debug";
  readonly contextWindowTokens?: number;
  readonly resumeHistory?: readonly AgentMessage[];
  readonly hooks?: import("@wudao-org/core").AgentHooks;
}): Promise<string> {
  const globalHome = await mkdtemp(join(tmpdir(), "o9932p-gh-"));
  const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
  const prevLevel = process.env.WUDAO_LOG_LEVEL;
  const prevFetch = globalThis.fetch;
  const prevArgv = process.argv;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  if (o.level === undefined) delete process.env.WUDAO_LOG_LEVEL;
  else process.env.WUDAO_LOG_LEVEL = o.level;
  process.argv = [prevArgv[0]!, "wudao", "--auto"];
  let calls = 0;
  globalThis.fetch = (async () => {
    const frames = o.script[calls] ?? answer("ok");
    calls += 1;
    return new Response(sse(frames), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  let seen = "";
  let fed = 0;
  const drain = (): string => { let t = ""; let c = stdout.read(); while (c !== null) { t += c.toString(); c = stdout.read(); } return t; };
  const pump = (): void => {
    seen += drain();
    const prompts = seen.split("wudao> ").length - 1;
    while (fed < o.lines.length && fed < prompts) { stdin.write(`${o.lines[fed]}\n`); fed += 1; }
  };
  let replError: unknown;
  let done: Promise<void> | undefined;
  try {
    done = runRepl({
      config: { apiKey: "sk-o9932", baseURL: "https://o9932p.invalid/v1", model: "o9932-model" } satisfies ProviderConfig,
      workspaceRoot: o.ws,
      buildTools: () => [...(o.tools ?? [])],
      contextWindowTokens: o.contextWindowTokens ?? 200_000,
      sessionId: o.sid,
      stdin,
      stdout,
      ...(o.resumeHistory !== undefined ? { resumeHistory: o.resumeHistory } : {}),
      ...(o.hooks !== undefined ? { hooks: o.hooks } : {}),
    });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) { pump(); if (fed >= o.lines.length) break; await delay(10); }
    await Promise.race([done!, delay(5_000)]);
  } catch (err) {
    replError = err;
  } finally {
    stdin.end();
    if (done !== undefined) await Promise.race([done.then(() => {}, () => {}), delay(500)]);
    process.argv = prevArgv;
    if (prevLevel === undefined) delete process.env.WUDAO_LOG_LEVEL;
    else process.env.WUDAO_LOG_LEVEL = prevLevel;
    process.env.WUDAO_GLOBAL_HOME = prevGlobal;
    globalThis.fetch = prevFetch;
    await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  if (replError !== undefined) throw replError;
  return seen;
}

describe("ω99-32 T2 — headless info level renders the tool-result preview", () => {
  it("① a multi-line result folds to ONE `  ↳ ` preview line; a long result cuts at the shared width", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "o9932p-fold-")));
    try {
      const mission: Tool = {
        name: "mission_complete",
        description: "test fixture: the mission_complete result shape",
        parameters: { type: "object", properties: {} },
        isReadOnly: () => true,
        execute: async () => ({ content: MISSION_RESULT }),
      };
      const longline: Tool = {
        name: "long_output",
        description: "test fixture: a single huge line",
        parameters: { type: "object", properties: {} },
        isReadOnly: () => true,
        execute: async () => ({ content: "x".repeat(300) }),
      };
      const seen = stripAnsi(await driveRepl({
        ws,
        sid: "wudao-o9932fold",
        lines: ["complete t5", "read the long one", "/exit"],
        tools: [mission, longline],
        script: [
          toolRound("mission_complete", "c1", {}),
          answer("mission done"),
          toolRound("long_output", "c2", {}),
          answer("long done"),
        ],
      }));
      // The existing info face (the 🔧 tool line) is untouched.
      expect(seen).toContain("🔧 mission_complete");
      expect(seen).toContain("🔧 long_output");
      // RED pre-fix: the default level renders NO tool result at all — the
      // campaign's grep target (将于会话边界卸载) had 0 hits.
      expect(seen.match(/^ {2}↳ /gm)).toHaveLength(2);
      // The multi-line result is ONE folded line: both parts on the same
      // screen line, never a second standalone line.
      expect(seen).toMatch(/^ {2}↳ ✅ t5 完成.*将于会话边界卸载$/m);
      expect(seen).not.toMatch(/\n技能包（ref-docs）将于会话边界卸载/);
      // The huge single line cuts at the shared preview width (200, the
      // driver/TUI transcript's own budget) with the ellipsis.
      expect(seen).toMatch(/^ {2}↳ x{200}…$/m);
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);

  it("② debug keeps the full multi-line body — the preview never double-renders", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "o9932p-dbg-")));
    try {
      const mission: Tool = {
        name: "mission_complete",
        description: "test fixture: the mission_complete result shape",
        parameters: { type: "object", properties: {} },
        isReadOnly: () => true,
        execute: async () => ({ content: MISSION_RESULT }),
      };
      const seen = stripAnsi(await driveRepl({
        ws,
        sid: "wudao-o9932dbg",
        lines: ["complete t5", "/exit"],
        tools: [mission],
        level: "debug",
        script: [toolRound("mission_complete", "c1", {}), answer("done")],
      }));
      // The full body with its line structure (the o99-29 T2 contract).
      expect(seen).toMatch(/^ {4}↳ ✅ t5 完成[^\n]*\n {6}技能包（ref-docs）将于会话边界卸载$/m);
      // RED-marker discipline: debug prints the body INSTEAD of the preview.
      expect(seen.match(/^ {2}↳ /gm)).toBeNull();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);

  it("③ the existing info faces coexist untouched (⛔ prompt_blocked, ♻️ compact line, 🔧 tool line)", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "o9932p-faces-")));
    try {
      const mission: Tool = {
        name: "mission_complete",
        description: "test fixture: the mission_complete result shape",
        parameters: { type: "object", properties: {} },
        isReadOnly: () => true,
        execute: async () => ({ content: MISSION_RESULT }),
      };
      const seen = stripAnsi(await driveRepl({
        ws,
        sid: "wudao-o9932faces",
        lines: ["complete t5", "block me", "/exit"],
        tools: [mission],
        script: [toolRound("mission_complete", "c1", {}), answer("done")],
        hooks: {
          onPromptSubmit: (p) => (p === "block me" ? { block: true, reason: "test gate" } : p),
        },
      }));
      // The blocked-prompt notice (M63-B round b) still prints at info, in
      // the same session where the preview prints — no interference.
      expect(seen).toContain("⛔ 提示词被钩子拦截：test gate"); // ω99-166f-iii: 钉随源演进
      expect(seen.match(/^ {2}↳ /gm)).toHaveLength(1);
      expect(seen).toContain("🔧 mission_complete");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    // The ♻️ compact line face (o99-29 ⑤'s shape: seed + exempt blob + a
    // 20k window trips tier-2 mid-run) still prints at info alongside the
    // preview lines.
    const ws2 = await realpath(await mkdtemp(join(tmpdir(), "o9932p-cmp-")));
    try {
      const seed: AgentMessage[] = [];
      for (let i = 0; i < 4; i += 1) {
        seed.push({ role: "user", content: `seed question ${i}` });
        seed.push({ role: "assistant", content: `seed answer ${i}` });
      }
      const bigBlob: Tool = {
        name: "big_blob",
        description: "test fixture: a huge compaction-exempt result",
        parameters: { type: "object", properties: {} },
        isReadOnly: () => true,
        compactionExempt: true,
        execute: async () => ({ content: "y".repeat(100_000) }),
      };
      const seen2 = stripAnsi(await driveRepl({
        ws: ws2,
        sid: "wudao-o9932cmp",
        lines: ["load the blob", "/exit"],
        tools: [bigBlob],
        script: [toolRound("big_blob", "c1", {}), answer("done after compact")],
        contextWindowTokens: 20_000,
        resumeHistory: seed,
      }));
      expect(seen2).toContain("♻️ 上下文已压缩"); // ω99-192: 钉随源演进
      expect((seen2.match(/^ {2}↳ /gm) ?? []).length).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(ws2, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);

  it("④ an errored result carries the [error] prefix on its preview line", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "o9932p-err-")));
    try {
      const failing: Tool = {
        name: "explode_probe",
        description: "test fixture: an errored result",
        parameters: { type: "object", properties: {} },
        isReadOnly: () => true,
        execute: async () => ({ content: "boom happened", isError: true }),
      };
      const seen = stripAnsi(await driveRepl({
        ws,
        sid: "wudao-o9932err",
        lines: ["run the probe", "/exit"],
        tools: [failing],
        script: [toolRound("explode_probe", "c1", {}), answer("recovered")],
      }));
      expect(seen).toMatch(/^ {2}↳ \[error\] boom happened$/m);
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);
});

// ⑤ The one-shot -p path: main() has no construction seam, so this rides the
// nokey-interactive-fallback paradigm — install argv/env/cwd FIRST, patch
// process.stdout.write (runReal writes the preview through it directly),
// then vi.resetModules() + dynamic-import so main() boots exactly once under
// our conditions.
describe("ω99-32 T2 — the one-shot path renders the same preview", () => {
  it("⑤ -p: a read_file result folds to one `  ↳ ` preview line on stdout", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "o9932p-1shot-")));
    const globalHome = await mkdtemp(join(tmpdir(), "o9932p-1shot-gh-"));
    const prevCwd = process.cwd();
    const prevArgv = [...process.argv];
    const prevFetch = globalThis.fetch;
    const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
    const prevKey = process.env.WUDAO_API_KEY;
    const prevUrl = process.env.WUDAO_BASE_URL;
    const prevModel = process.env.WUDAO_MODEL;
    const prevLevel = process.env.WUDAO_LOG_LEVEL;
    const prevWrite = process.stdout.write.bind(process.stdout);
    const prevErrWrite = process.stderr.write.bind(process.stderr);
    let captured = "";
    try {
      await writeFile(join(ws, "probe.txt"), "line one alpha\nline two beta\n");
      delete process.env.WUDAO_LOG_LEVEL; // the default: info
      process.env.WUDAO_GLOBAL_HOME = globalHome;
      process.env.WUDAO_API_KEY = "sk-o9932";
      process.env.WUDAO_BASE_URL = "https://o9932p-1shot.invalid/v1";
      process.env.WUDAO_MODEL = "o9932-model";
      process.argv = [prevArgv[0]!, "wudao", "--auto", "read the probe"];
      let calls = 0;
      const script: readonly (readonly unknown[])[] = [
        toolRound("read_file", "c1", { path: "probe.txt" }),
        answer("probe read done"),
      ];
      globalThis.fetch = (async () => {
        const frames = script[calls] ?? answer("ok");
        calls += 1;
        return new Response(sse(frames), { status: 200, headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch;
      // The fake write MUST honor the write callback (encoding-or-callback
      // forms): stdoutGuard's piped discipline queues writes and waits for
      // the real callback — swallowing it deadlocks the boot with zero
      // output. Fire it on a microtask like the OS would.
      process.stdout.write = ((chunk: unknown, encOrCb?: unknown, maybeCb?: unknown) => {
        captured += typeof chunk === "string" ? chunk : String(chunk);
        const cb = typeof encOrCb === "function" ? encOrCb : typeof maybeCb === "function" ? maybeCb : undefined;
        if (cb !== undefined) queueMicrotask(() => (cb as () => void)());
        return true;
      }) as typeof process.stdout.write;
      let errCaptured = "";
      process.stderr.write = ((chunk: unknown) => {
        errCaptured += typeof chunk === "string" ? chunk : String(chunk);
        return true;
      }) as typeof process.stderr.write;
      process.chdir(ws);
      vi.resetModules();
      await import("../src/index.js");
      await until(() => captured.includes("probe read done"), `the one-shot run to settle (fetch calls: ${calls}, captured: ${JSON.stringify(captured.slice(-400))}, stderr: ${JSON.stringify(errCaptured.slice(-400))})`, 20_000);
      await delay(150); // trailing rows (usage line) flush
    } finally {
      process.stdout.write = prevWrite;
      process.stderr.write = prevErrWrite;
      process.chdir(prevCwd);
      process.argv = prevArgv;
      globalThis.fetch = prevFetch;
      process.env.WUDAO_GLOBAL_HOME = prevGlobal;
      process.env.WUDAO_API_KEY = prevKey;
      process.env.WUDAO_BASE_URL = prevUrl;
      process.env.WUDAO_MODEL = prevModel;
      if (prevLevel === undefined) delete process.env.WUDAO_LOG_LEVEL;
      else process.env.WUDAO_LOG_LEVEL = prevLevel;
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    const seen = stripAnsi(captured);
    // RED pre-fix: the -p renderer printed no tool result at info level.
    expect(seen).toMatch(/^ {2}↳ [^\n]*line one alpha[^\n]*line two beta$/m);
    expect(seen.match(/^ {4}↳ /gm)).toBeNull();
  }, 30_000);
});
