// ω99-134 — the ONE-SHOT deliverable file card. ω99-132 put the card on the
// REPL (repl.ts), but `wudao "任务"` 直跑 renders events in index.ts's OWN
// loop (runPass's for-await) — 132's "one-shot/REPL share repl.ts" premise
// was wrong, and post-133 dogfood showed one-shot still folding the make_xlsx
// receipt into `↳ 已生成…{"path":…}`. These cases pin the SAME card (verbatim
// copy — the four-frontend one-card rule: web 125 / TUI 131 / REPL 132 /
// one-shot here) plus the zero-drift pin: a plain read_file keeps its exact
// ↳ preview dim line, an isError result keeps its exact ↳ [error] shape.
// Paradigm: o99-32 ⑤ — argv rewrite + env stub + scripted SSE fetch + fake
// process.stdout.write that HONORS the callback (stdoutGuard's piped
// discipline queues on it; swallowing it deadlocks the boot with zero
// output) + vi.resetModules() + dynamic index.js import (main() boots once).
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The dynamic index.js import pulls ink → yoga-wasm. Loading the tui graph
// STATICALLY first (o99-32 ⑤'s shape) lets the externalized module evaluate
// on the healthy static path; the post-resetModules dynamic chain then
// reuses the cached module instead of re-preparing the wasm.
import "../src/tui/app.js";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  await delay();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`o134: timed out waiting for ${what}`);
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

// o99-29's convention: assert on stripped text so ^/$ anchors hold.
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** The o99-32 ⑤ one-shot harness (main() has no construction seam): install
 *  argv/env/cwd FIRST, patch process.stdout.write, then vi.resetModules() +
 *  dynamic import so main() boots exactly once under our conditions. The
 *  REAL default tool set runs (make_xlsx/read_file are zero-config always-on)
 *  — no tool stubs, only the SSE fetch is scripted. Returns RAW captured
 *  stdout (strip ANSI before asserting). `setup` presets files into the
 *  fresh workspace before the boot. */
async function driveOneShot(o: {
  readonly tag: string;
  readonly prompt: string;
  readonly script: readonly (readonly unknown[])[];
  readonly settle: (plain: string) => boolean;
  readonly setup?: (ws: string) => Promise<void>;
}): Promise<string> {
  const ws = await realpath(await mkdtemp(join(tmpdir(), "o134-")));
  const globalHome = await mkdtemp(join(tmpdir(), "o134-gh-"));
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
  let errCaptured = "";
  try {
    if (o.setup !== undefined) await o.setup(ws);
    delete process.env.WUDAO_LOG_LEVEL; // the default: info
    process.env.WUDAO_GLOBAL_HOME = globalHome;
    process.env.WUDAO_API_KEY = "sk-o134";
    process.env.WUDAO_BASE_URL = "https://o134.invalid/v1";
    process.env.WUDAO_MODEL = "o134-model";
    // ω99-134: --no-sidecar — the purpose-built hard-off switch (sidecar.ts
    // resolveSidecarRuntime). --auto + a destructive tool (make_xlsx) otherwise
    // rides the DEFAULT-ON sidecar classifier, whose classify call the scripted
    // SSE stub cannot answer (a 4s timeout → non-interactive DENY — the run
    // then never produces a receipt, nondeterministically per fetch order).
    // o99-32 ⑤ never met this: read_file is read-only, never sidecar-gated.
    process.argv = [prevArgv[0]!, "wudao", "--auto", "--no-sidecar", o.prompt];
    let calls = 0;
    globalThis.fetch = (async () => {
      const frames = o.script[calls] ?? answer("ok");
      calls += 1;
      return new Response(sse(frames), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    process.stdout.write = ((chunk: unknown, encOrCb?: unknown, maybeCb?: unknown) => {
      captured += typeof chunk === "string" ? chunk : String(chunk);
      const cb = typeof encOrCb === "function" ? encOrCb : typeof maybeCb === "function" ? maybeCb : undefined;
      if (cb !== undefined) queueMicrotask(() => (cb as () => void)());
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      errCaptured += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    }) as typeof process.stderr.write;
    process.chdir(ws);
    vi.resetModules();
    await import("../src/index.js");
    await until(() => o.settle(stripAnsi(captured)), `the ${o.tag} one-shot to settle (captured: ${JSON.stringify(captured.slice(-300))}, stderr: ${JSON.stringify(errCaptured.slice(-300))})`, 20_000);
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
  return captured;
}

describe("ω99-134 — one-shot deliverable file card (info) / zero drift (everything else)", () => {
  it("info level: a REAL make_xlsx receipt renders the three-line card INSTEAD of the ↳ preview", async () => {
    const seen = await driveOneShot({
      tag: "card",
      prompt: "把清单做成表格",
      script: [
        toolRound("make_xlsx", "c1", { filename: "卡片.xlsx", table: { columns: [{ header: "列", width: 8 }], rows: [["值"]] } }),
        answer("卡片做好"),
      ],
      settle: (p) => p.includes("卡片做好") && p.includes("🔧 make_xlsx"),
    });
    // Line 1 — cyan headline: the deliverable is the turn's headline (the
    // accent escape matches the REPL's ω99-132 card byte-for-byte).
    expect(seen).toContain("\x1b[36m  ▣ 📊 卡片.xlsx（");
    const plain = stripAnsi(seen);
    // The REAL buildXlsx wrote the file — only the KB FIGURE's shape is
    // pinned (a real zip's exact byte count is not a contract).
    expect(plain.match(/^ {2}▣ 📊 卡片\.xlsx（\d+(\.\d+)? KB）$/m)).not.toBeNull();
    // Line 2 — the receipt's own 中文句 verbatim (first non-empty line).
    expect(plain).toContain("已生成 Excel：卡片.xlsx（1 行 × 1 列");
    // Line 3 — the copyable path + the open hint (U+3000 separator, the
    // 132/131 wording).
    expect(plain).toMatch(/位置：\/[^\n]*卡片\.xlsx　打开：open "卡片\.xlsx"/);
    // The card REPLACED the preview line: the receipt JSON never hits the
    // screen, and the old `↳ 已生成…` fold is gone.
    expect(plain).not.toContain('{"path"');
    expect(plain).not.toMatch(/↳ 已生成/);
  }, 30_000);

  it("zero drift: a plain read_file keeps the exact ↳ preview dim line — no card off the receipt path", async () => {
    const seen = await driveOneShot({
      tag: "drift-read",
      prompt: "读一下探针文件",
      script: [
        toolRound("read_file", "c1", { path: "probe.txt" }),
        answer("读好了"),
      ],
      settle: (p) => p.includes("读好了") && p.includes("🔧 read_file"),
      setup: (ws) => writeFile(join(ws, "probe.txt"), "drift probe payload\n"),
    });
    // Byte-exact old line (dim escape pair included) — the zero-drift pin.
    expect(seen).toContain("\x1b[2m  ↳ drift probe payload\x1b[0m");
    expect(seen).not.toContain("▣");
    expect(seen).not.toContain("位置：");
  }, 30_000);

  it("zero drift: an isError result keeps the exact ↳ [error] shape — receipts on the error lane never grow a card", async () => {
    const seen = await driveOneShot({
      tag: "drift-err",
      prompt: "把清单做成表格",
      script: [
        // table AND sheets both given → make_xlsx's own typed rejection (an
        // isError result through the REAL tool, no stub).
        toolRound("make_xlsx", "c1", { table: { columns: [{ header: "列", width: 8 }], rows: [["值"]] }, sheets: [{ columns: [{ header: "列", width: 8 }], rows: [["值"]] }] }),
        answer("参数给错了"),
      ],
      settle: (p) => p.includes("参数给错了") && p.includes("🔧 make_xlsx"),
    });
    expect(seen).toContain("\x1b[2m  ↳ [error] make_xlsx: use either table or sheets, not both (sheets is the array form for multiple worksheets)\x1b[0m");
    expect(seen).not.toContain("▣");
    expect(seen).not.toContain("位置：");
  }, 30_000);
});
