// 夜移 032 stage-2 — threading the net-change tracker into the remaining
// three faces (stage-1 landed core tracker + tools + render + driver seam +
// session-engine reference integration). The driver seam is already pinned
// (turn-diff-driver.test.ts); here each face is exercised at its own seam:
//   · REPL    runRepl drives the loop directly — opts.turnDiff must reset at
//             each run boundary (the sidecar reset seam) and print the
//             preview line at settle, BEFORE the cache summary.
//   · TUI     WudaoApp owns one tracker per session (the fileHistory sharing
//             pattern: props.turnDiff override, into buildToolSet AND the
//             driver opts) — the receipt lands in the rendered frame.
//   · one-shot main()'s inline settle has no construction seam (the 035
//             phases-line precedent: tsc + source pins) — pin the wiring
//             markers so a dropped thread turns this red.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink-testing-library";
import { createScriptedModel, createTurnDiffTracker, createWriteFileTool } from "@wudao-org/core";
import type { ProviderConfig } from "@wudao-org/providers";
import { runRepl } from "../src/repl.js";
import { WudaoApp } from "../src/tui/app.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const indexSrc = (): string =>
  readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");

describe("夜移 032 stage-2 — REPL face (runRepl drives the loop itself)", () => {
  it("each turn's writes land a preview receipt of its OWN files (reset at the run boundary)", async () => {
    // realpath: macOS tmpdir is a symlink — write_file resolves its target,
    // so the root the receipt relativizes against must be canonical too.
    const ws = await realpath(await mkdtemp(join(tmpdir(), "td-repl-")));
    const globalHome = await mkdtemp(join(tmpdir(), "td-repl-gh-"));
    const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
    const prevFetch = globalThis.fetch;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const enc = new TextEncoder();
    const sse = (frames: readonly unknown[]): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({
      start(c) {
        for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    const turn = (name: string, id: string, path: string, content: string): readonly unknown[] => [
      { id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify({ path, content }) } }] } }] },
      { id, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 5 } },
    ];
    const done = (): readonly unknown[] => [
      { id: "d", choices: [{ index: 0, delta: { content: "ok" } }] },
      { id: "d", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } },
    ];
    // Turn 1 writes a.txt (tool round then answer); turn 2 writes b.txt. Any
    // LATER call (a session-title sidecall, say) gets a plain done frame.
    const script: readonly (readonly unknown[])[] = [
      turn("write_file", "c1", "a.txt", "one\n"), done(),
      turn("write_file", "c2", "b.txt", "two\n"), done(),
    ];
    let calls = 0;
    globalThis.fetch = (async () => {
      const frames = script[calls] ?? done();
      calls += 1;
      return new Response(sse(frames), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    let seen = "";
    let fed = 0;
    const lines = ["make", "again", "/exit"];
    const drain = (): string => {
      let text = "";
      let chunk = stdout.read();
      while (chunk !== null) { text += chunk.toString(); chunk = stdout.read(); }
      return text;
    };
    const pump = (): void => {
      seen += drain();
      const prompts = seen.split("wudao> ").length - 1;
      while (fed < lines.length && fed < prompts) { stdin.write(`${lines[fed]}\n`); fed += 1; }
    };
    const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (pred: () => boolean, what: string, ms = 8000): Promise<void> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        pump();
        if (pred()) return;
        await delay(10);
      }
      throw new Error(`td-repl: timed out waiting for ${what}\n--- output so far ---\n${seen}`);
    };

    // The one tracker, shared by the tool set and the REPL run boundary —
    // the exact shape index.ts threads in production.
    const t = createTurnDiffTracker();
    process.env.WUDAO_GLOBAL_HOME = globalHome;
    let replError: unknown;
    let doneRepl: Promise<void> | undefined;
    // Captured BEFORE the finally's rm — the writes are asserted after the
    // cleanup, when the workspace is already gone.
    let aWritten = false;
    let bWritten = false;
    try {
      doneRepl = runRepl({
        config: { apiKey: "sk-td", baseURL: "https://td-repl.invalid/v1", model: "td-model" } satisfies ProviderConfig,
        workspaceRoot: ws,
        buildTools: () => [createWriteFileTool({ workspaceRoot: ws, turnDiff: t })],
        contextWindowTokens: 200_000,
        // verify:false — the write would otherwise trip the verify stop-gate
        // ("changes were made but nothing was run"), bouncing the mock's
        // "ok" answer 3× before it lets the turn settle.
        gates: { verify: false },
        turnDiff: t,
        stdin,
        stdout,
      });
      await waitFor(() => seen.includes("回合净变更 1 文件：a.txt(新建)"), "turn 1's receipt");
      await waitFor(() => seen.includes("回合净变更 1 文件：b.txt(新建)"), "turn 2's receipt");
      aWritten = existsSync(join(ws, "a.txt"));
      bWritten = existsSync(join(ws, "b.txt"));
      await Promise.race([doneRepl, waitFor(() => false, "the session to end", 8000)]);
    } catch (err) {
      replError = err;
    } finally {
      stdin.end();
      if (doneRepl !== undefined) await Promise.race([doneRepl.then(() => {}, () => {}), delay(500)]);
      process.env.WUDAO_GLOBAL_HOME = prevGlobal;
      globalThis.fetch = prevFetch;
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    if (replError !== undefined) throw replError;
    seen += drain();

    // Both receipts named exactly their own turn's file — without the run
    // boundary reset, turn 2 would have reported 2 files.
    expect(seen).toContain("回合净变更 1 文件：a.txt(新建)");
    expect(seen).toContain("回合净变更 1 文件：b.txt(新建)");
    expect(seen).not.toContain("回合净变更 2 文件");
    // The writes really landed (the receipt never lies about the tree).
    expect(aWritten).toBe(true);
    expect(bWritten).toBe(true);
  }, 20_000);
});

describe("夜移 032 stage-2 — TUI face (one tracker shared: tool set + driver)", () => {
  it("a write run lands the net-change receipt in the rendered frame", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "td-tui-")));
    try {
      const t = createTurnDiffTracker();
      const model = createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "write_file", arguments: { path: "out.ts", content: "one\n" } }] },
        { role: "assistant", content: "WRITTEN-DONE" },
      ]);
      const inst = render(
        React.createElement(WudaoApp, {
          config: { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" } satisfies ProviderConfig,
          workspaceRoot: ws,
          contextWindowTokens: 64_000,
          modelOverride: model,
          tools: [createWriteFileTool({ workspaceRoot: ws, turnDiff: t })],
          turnDiff: t,
          initialPermissionMode: "ask",
          gates: { verify: false },
        }),
      );
      await wait();
      await (async (): Promise<void> => {
        for (const ch of "make\r") { inst.stdin.write(ch); await wait(15); }
      })();
      await until(() => (inst.lastFrame() ?? "").includes("🔑"), "permission prompt to appear");
      await wait();
      inst.stdin.write("y");
      await until(() => (inst.lastFrame() ?? "").includes("回合净变更"), "the net-change receipt");
      const frame = inst.lastFrame() ?? "";
      expect(frame).toContain("回合净变更 1 文件：out.ts(新建)");
      expect(existsSync(join(ws, "out.ts"))).toBe(true);
      inst.unmount();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 20_000);
});

describe("夜移 032 stage-2 — one-shot face (wiring pins; no construction seam)", () => {
  it("main() creates one tracker, threads it into the tool set, resets per pass, prints the receipt", () => {
    const src = indexSrc();
    // one tracker, threaded into the one-shot tool set
    expect(src).toContain("const turnDiff = createTurnDiffTracker();");
    // every pass (plan pass and execution pass are two runs) starts fresh
    expect(src).toContain("turnDiff.resetRun();");
    // the settle receipt rides renderTurnDiff relative to the workspace root
    expect(src).toContain("renderTurnDiff(");
    // the REPL branch shares its own tracker between tools and the boundary
    const replUses = src.split("replTurnDiff").length - 1;
    expect(replUses).toBeGreaterThanOrEqual(3); // create + buildToolSet + runRepl opts
  });
});
