// ω99-132 — REPL/one-shot deliverable file card (the twin of ω99-131's TUI
// card) on the plain-run path (wudao "任务" 直跑, the dogfood main line): at
// info level a name-gated receipt (make_xlsx/make_pptx/make_docx, the ω99-125
// extractor) renders the three-line card INSTEAD of the ↳ preview line — the
// raw receipt JSON folded into that one line is screen pollution and never
// said where the file is or how to open it. These cases pin: the card's exact
// copy (icon/KB/path/open/sentence — the TUI card's own helpers, one
// derivation), the preview line's REPLACEMENT (no `↳ 已生成`, no `{"path"`),
// and the zero-drift pin — every non-receipt render keeps its exact old bytes
// (plain tools, error entries, the name gate's miss, and the whole debug
// lane). Paradigm: o99-29's runRepl + PassThrough stdout harness.
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runRepl } from "../src/repl.js";
import type { ProviderConfig } from "@wudao/providers";
import type { Tool } from "@wudao/core";

// o99-29's convention: assert on stripped text so ^/$ anchors hold.
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  await delay();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`o132: timed out waiting for ${what}`);
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

// The EXACT make_xlsx receipt shape (doc-xlsx.ts:354 execute tail): 中文句 +
// "\n" + JSON.stringify({path, relativePath, rows, columns, bytes}). 1024
// bytes → the sentence's own 1.0 KB figure — the card and the receipt
// sentence must never disagree about the same file (the 131 pin).
const XLSX_RECEIPT = '已生成 Excel：测试.xlsx（3 行 × 4 列，1.0 KB）\n{"path":"/tmp/w/测试.xlsx","relativePath":"测试.xlsx","rows":3,"columns":4,"bytes":1024}';
const XLSX_SENTENCE = "已生成 Excel：测试.xlsx（3 行 × 4 列，1.0 KB）";

const stubTool = (name: string, result: string, isError = false): Tool => ({
  name,
  description: `test fixture: ${name} result shape`,
  parameters: { type: "object", properties: {} },
  isReadOnly: () => true,
  execute: async () => ({ content: result, ...(isError ? { isError: true } : {}) }),
});

// The o99-29 T2 harness (runRepl + PassThrough stdin/stdout + scripted SSE
// fetch + wudao> prompt pump), factored ONCE — every case below rides the
// identical lane, so the only per-case variable is the tool/level under pin.
async function driveRepl(opts: {
  readonly level?: "info" | "debug";
  readonly tools: readonly Tool[];
  readonly script: readonly (readonly unknown[])[];
  readonly settle: (plain: string) => boolean;
  readonly tag: string;
}): Promise<string> {
  const ws = await realpath(await mkdtemp(join(tmpdir(), "o132-")));
  const globalHome = await mkdtemp(join(tmpdir(), "o132-gh-"));
  const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
  const prevLevel = process.env.WUDAO_LOG_LEVEL;
  const prevFetch = globalThis.fetch;
  const prevArgv = process.argv;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  if (opts.level === undefined) delete process.env.WUDAO_LOG_LEVEL; // the default: info
  else process.env.WUDAO_LOG_LEVEL = opts.level;
  process.argv = [prevArgv[0]!, "wudao", "--auto"];
  let calls = 0;
  globalThis.fetch = (async () => {
    const frames = opts.script[calls] ?? answer("ok");
    calls += 1;
    return new Response(sse(frames), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  let seen = "";
  let fed = 0;
  const lines = ["make the file", "/exit"];
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
      config: { apiKey: "sk-o132", baseURL: "https://o132.invalid/v1", model: "o132-model" } satisfies ProviderConfig,
      workspaceRoot: ws,
      buildTools: () => [...opts.tools],
      contextWindowTokens: 200_000,
      sessionId: `wudao-o132-${opts.tag}`,
      stdin,
      stdout,
    });
    await until(() => { pump(); return opts.settle(stripAnsi(seen)); }, `the ${opts.tag} run to settle`);
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) { pump(); if (fed >= lines.length) break; await delay(10); }
    await Promise.race([done!, delay(5_000)]);
  } catch (err) {
    replError = err;
  } finally {
    stdin.end();
    if (done !== undefined) await Promise.race([done.then(() => {}, () => {}), delay(500)]);
    process.argv = prevArgv;
    if (prevLevel === undefined) delete process.env.WUDAO_LOG_LEVEL; else process.env.WUDAO_LOG_LEVEL = prevLevel;
    process.env.WUDAO_GLOBAL_HOME = prevGlobal;
    globalThis.fetch = prevFetch;
    await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  if (replError !== undefined) throw replError;
  return seen;
}

describe("ω99-132 — REPL deliverable file card (info) / zero drift (everything else)", () => {
  it("info level: a make_xlsx receipt renders the three-line card INSTEAD of the ↳ preview", async () => {
    const seen = await driveRepl({
      tag: "card",
      tools: [stubTool("make_xlsx", XLSX_RECEIPT)],
      script: [toolRound("make_xlsx", "c1"), answer("done")],
      settle: (p) => p.includes("done") && p.includes("🔧 make_xlsx"),
    });
    // Line 1 — cyan: the deliverable is the turn's headline (the TUI card's
    // accent role; cyan is the plain terminal's accent escape).
    expect(seen).toContain("\x1b[36m  ▣ 📊 测试.xlsx（1.0 KB）\x1b[0m");
    // Line 2 — dim, the receipt's own sentence verbatim.
    expect(seen).toContain(`\x1b[2m  ${XLSX_SENTENCE}\x1b[0m`);
    // Line 3 — dim, the copyable path + the open hint (打开 = the system
    // default application — the TUI card's own wording, U+3000 separator).
    expect(seen).toContain('\x1b[2m  位置：/tmp/w/测试.xlsx　打开：open "测试.xlsx"\x1b[0m');
    const plain = stripAnsi(seen);
    expect(plain.match(/^ {2}▣ 📊 测试\.xlsx（1\.0 KB）$/m)).not.toBeNull();
    expect(plain).toContain(XLSX_SENTENCE);
    expect(plain).toContain('位置：/tmp/w/测试.xlsx　打开：open "测试.xlsx"');
    // The card REPLACED the preview line: the receipt JSON never hits the
    // screen, and the old `↳ 已生成…` fold is gone.
    expect(plain).not.toContain('{"path"');
    expect(plain).not.toMatch(/↳ 已生成/);
  }, 20_000);

  it("zero drift: plain tools keep the exact ↳ preview line — errors keep the [error] shape", async () => {
    const seen = await driveRepl({
      tag: "drift",
      tools: [stubTool("plain_tool", "plain result text"), stubTool("failing_tool", "boom", true)],
      script: [toolRound("plain_tool", "c1"), toolRound("failing_tool", "c2"), answer("done")],
      settle: (p) => p.includes("done") && p.includes("🔧 failing_tool"),
    });
    // Byte-exact old lines (dim escape pair included) — the zero-drift pin.
    expect(seen).toContain("\x1b[2m  ↳ plain result text\x1b[0m");
    expect(seen).toContain("\x1b[2m  ↳ [error] boom\x1b[0m");
    expect(seen).not.toContain("▣"); // no card anywhere off the receipt path
  }, 20_000);

  it("isError receipts never grow a card — the error render is exactly as before", async () => {
    const seen = await driveRepl({
      tag: "err",
      tools: [stubTool("make_xlsx", "make_xlsx: 写入失败（disk full）", true)],
      script: [toolRound("make_xlsx", "c1"), answer("done")],
      settle: (p) => p.includes("done") && p.includes("🔧 make_xlsx"),
    });
    expect(seen).toContain("\x1b[2m  ↳ [error] make_xlsx: 写入失败（disk full）\x1b[0m");
    expect(seen).not.toContain("▣");
    expect(seen).not.toContain("位置：");
  }, 20_000);

  it("the name gate: a non-gated tool returning the EXACT receipt shape gets no card — its preview line survives", async () => {
    const seen = await driveRepl({
      tag: "gate",
      tools: [stubTool("other_tool", XLSX_RECEIPT)],
      script: [toolRound("other_tool", "c1"), answer("done")],
      settle: (p) => p.includes("done") && p.includes("🔧 other_tool"),
    });
    const plain = stripAnsi(seen);
    expect(plain).not.toContain("▣");
    expect(plain).not.toContain("位置：");
    // Not prettiness — parity: the non-gated result keeps its old collapsed
    // one-line preview (JSON folded in, byte-identical to pre-ω99-132).
    expect(plain.match(/^ {2}↳ 已生成 Excel：测试\.xlsx（3 行 × 4 列，1\.0 KB） \{"path":/m)).not.toBeNull();
  }, 20_000);

  it("debug level: the full multi-line body still renders — the card is the info lane only (debug untouched)", async () => {
    const seen = await driveRepl({
      tag: "debug",
      level: "debug",
      tools: [stubTool("make_xlsx", XLSX_RECEIPT)],
      script: [toolRound("make_xlsx", "c1"), answer("done")],
      settle: (p) => p.includes("done") && p.includes("🔧 make_xlsx"),
    });
    const plain = stripAnsi(seen);
    // ω99-29 T2's own format: `    ↳ ` head + 6-space continuation lines —
    // the full receipt body (sentence AND JSON) stays visible at debug.
    expect(plain.match(/^ {4}↳ 已生成 Excel：测试\.xlsx（3 行 × 4 列，1\.0 KB）\n {6}\{"path":"\/tmp\/w\/测试\.xlsx"/m)).not.toBeNull();
    expect(plain).not.toContain("▣");
    expect(plain).not.toContain("位置：");
  }, 20_000);
});
