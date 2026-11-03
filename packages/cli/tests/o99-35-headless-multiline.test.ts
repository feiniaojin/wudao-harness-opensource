// ω99-35 — headless (non-TTY) multi-line prompt fragmentation.
//
// §0: `--no-tui` + non-TTY stdin (FIFO/pipe — wudao's headless ops shape) fed
// a multi-line prompt submitted EVERY line as its own user turn: the model
// read line 1 as the whole task and self-created a mission while the rest
// dribbled in across ledgers (campaign evidence). The fix wraps a batcher
// around the non-TTY rl wiring layer ONLY: a blank line terminates the
// accumulated batch (SMTP-style), an idle window flushes it (default 150ms;
// the opts seam injects 20ms here — every window wait below is ≥30×), a
// STANDALONE command line (empty batch + command-table hit) submits
// immediately, EOF flushes the in-flight batch then exits, and the TTY path
// is byte-identical to before (⑤).
import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runRepl } from "../src/repl.js";
import type { AgentHooks } from "@wudao-org/core";
import type { ProviderConfig } from "@wudao-org/providers";

const WINDOW_MS = 20; // injected seam value — window waits use ≥30× (600ms)
const LONG_WINDOW_MS = 10_000; // immediacy/EOF proofs: only the trigger under test can deliver in the test's lifetime

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const enc = new TextEncoder();
const sse = (): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({
  start(c) {
    c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`));
    c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`));
    c.enqueue(enc.encode("data: [DONE]\n\n"));
    c.close();
  },
});

/** A pipe-shaped stream flagged as a terminal (the TTY simulation for ⑤). */
class TtyStream extends PassThrough {
  readonly isTTY = true;
}

interface Harness {
  readonly stdin: PassThrough;
  readonly captured: { readonly url: string; readonly body: string }[];
  readonly ends: string[];
  /** The LAST user message of the n-th model call (the turn's own prompt). */
  readonly userTexts: (call: number) => string[];
  readonly waitPrompt: (n?: number) => Promise<void>;
  readonly waitFor: (pred: () => boolean, what: string, ms?: number) => Promise<void>;
  readonly doneSettled: () => Promise<boolean>;
  readonly finish: () => Promise<void>;
  readonly cleanup: () => Promise<void>;
}

const startRepl = async (opts?: {
  readonly windowMs?: number;
  readonly tty?: boolean;
  readonly hooks?: AgentHooks;
}): Promise<Harness> => {
  const ws = await mkdtemp(join(tmpdir(), "o9935-ws-"));
  const globalHome = await mkdtemp(join(tmpdir(), "o9935-gh-"));
  const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
  const prevFetch = globalThis.fetch;
  const stdin = opts?.tty === true ? new TtyStream() : new PassThrough();
  const stdout = opts?.tty === true ? new TtyStream() : new PassThrough();
  const captured: { url: string; readonly body: string }[] = [];
  const ends: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    captured.push({ url: String(url), body: String(init?.body) });
    return new Response(sse(), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  process.env.WUDAO_GLOBAL_HOME = globalHome;
  let seen = "";
  const drain = (): string => {
    let t = "";
    let ch = stdout.read();
    while (ch !== null) { t += ch.toString(); ch = stdout.read(); }
    seen += t;
    return t;
  };
  const done = runRepl({
    config: { apiKey: "sk-o9935", baseURL: "https://o9935.invalid/v1", model: "o9935-model" } satisfies ProviderConfig,
    workspaceRoot: ws,
    buildTools: () => [],
    contextWindowTokens: 200_000,
    ...(opts?.windowMs !== undefined ? { headlessBatchWindowMs: opts.windowMs } : {}),
    ...(opts?.hooks !== undefined ? { hooks: opts.hooks } : {}),
    stdin,
    stdout,
  });
  const waitPrompt = async (n = 1): Promise<void> => {
    for (let i = 0; i < 1_000 && seen.split("wudao> ").length - 1 < n; i += 1) { drain(); await delay(10); }
  };
  const waitFor = async (pred: () => boolean, what: string, ms = 6_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      drain();
      if (pred()) return;
      await delay(10);
    }
    throw new Error(`o99-35: timed out waiting for ${what}\n--- output so far ---\n${seen}`);
  };
  const finish = async (): Promise<void> => {
    drain();
    // /exit is a standalone command → immediate; if it joined an in-flight
    // batch the window would still deliver it long inside the deadline.
    stdin.write("/exit\n");
    await Promise.race([done.then(() => {}, () => {}), delay(6_000)]);
  };
  const doneSettled = async (): Promise<boolean> =>
    Promise.race([done.then(() => true, () => true), delay(2_000).then(() => false)]);
  const userTexts = (call: number): string[] => {
    const body = JSON.parse(captured[call - 1]?.body ?? "{}") as { messages?: { role: string; content: unknown }[] };
    return (body.messages ?? []).filter((m) => m.role === "user").map((m) => String(m.content));
  };
  const cleanup = async (): Promise<void> => {
    stdin.end();
    await Promise.race([done.then(() => {}, () => {}), delay(500)]);
    process.env.WUDAO_GLOBAL_HOME = prevGlobal;
    globalThis.fetch = prevFetch;
    await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  return { stdin, captured, ends, userTexts, waitPrompt, waitFor, doneSettled, finish, cleanup };
};

// ---------------------------------------------------------------------------
// Unit — the batcher itself (constructed directly; windowMs injected small).
// The dynamic import keeps the pre-fix RED run meaningful: the integration
// cases below still execute (and show the 5-turn fragmentation baseline)
// even while this module does not exist yet.
// ---------------------------------------------------------------------------
describe("ω99-35 unit — createHeadlessLineBatcher", () => {
  const make = async (parked: string[]) => {
    const { createHeadlessLineBatcher } = await import("../src/headless-batch.js");
    return {
      batcher: createHeadlessLineBatcher({
        windowMs: WINDOW_MS,
        isImmediate: (line) => line.startsWith("/") || line.startsWith("!"),
        onPark: (text) => parked.push(text),
        write: () => {},
      }),
      parked,
    };
  };
  const raceSentinel = <T,>(p: Promise<T>): Promise<T | "SENTINEL"> => Promise.race([p, delay(150).then(() => "SENTINEL" as const)]);

  it("u1: quick lines with no blank line aggregate to exactly one flush (idle window)", async () => {
    const { batcher, parked } = await make([]);
    const got = batcher.take("");
    batcher.push("l1");
    batcher.push("l2");
    batcher.push("l3");
    expect(parked).toEqual([]); // nothing before the window
    await delay(700); // ≥30× the 20ms window
    expect(await raceSentinel(got)).toBe("l1\nl2\nl3");
    expect(parked).toEqual([]);
  });

  it("u2: a blank line terminates the batch immediately (a\\n\\nb → two flushes)", async () => {
    const { batcher, parked } = await make([]);
    batcher.push("a");
    batcher.push("");
    batcher.push("b");
    expect(parked).toEqual(["a"]); // delivered at once, no window
    await delay(700);
    expect(parked).toEqual(["a", "b"]);
  });

  it("u3: a standalone command submits immediately — no window wait, no batch", async () => {
    const { batcher, parked } = await make([]);
    const got = batcher.take("");
    batcher.push("/exit");
    expect(await raceSentinel(got)).toBe("/exit");
    expect(parked).toEqual([]);
  });

  it("u4: a command-shaped line AFTER content rides with the batch as message content", async () => {
    const { batcher, parked } = await make([]);
    const got = batcher.take("");
    batcher.push("task line");
    batcher.push("/help"); // non-first line of the in-flight message → content (the TUI's whole-text routing semantics)
    await delay(700);
    expect(await raceSentinel(got)).toBe("task line\n/help");
    expect(parked).toEqual([]);
  });

  it("u5: notifyClose flushes the in-flight batch, then takes resolve null (EOF exit)", async () => {
    const { batcher, parked } = await make([]);
    const got = batcher.take("");
    batcher.push("l1");
    batcher.push("l2");
    batcher.notifyClose();
    expect(await raceSentinel(got)).toBe("l1\nl2"); // flushed to the pending take
    expect(await raceSentinel(batcher.take(""))).toBe(null); // drained → exit sentinel
    expect(parked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration — the five acceptance cases over the real runRepl wiring.
// ---------------------------------------------------------------------------
describe("ω99-35 integration — the non-TTY rl wiring batches multi-line prompts", () => {
  it("① five quick lines, no blank line → exactly ONE user turn carrying the five original lines", async () => {
    const h = await startRepl({ windowMs: WINDOW_MS });
    try {
      await h.waitPrompt(1);
      h.stdin.write("task line one\n");
      h.stdin.write("task line two\n");
      h.stdin.write("task line three\n");
      h.stdin.write("task line four\n");
      h.stdin.write("task line five\n");
      await delay(700); // ≥30× window — the idle-window flush must have landed
      expect(h.captured.length).toBe(1); // RED pre-fix: 5 turns (each line submitted alone)
      expect(h.userTexts(1).at(-1)).toBe("task line one\ntask line two\ntask line three\ntask line four\ntask line five");
      await h.finish();
    } finally {
      await h.cleanup();
    }
  }, 20_000);

  it("② a\\nb with a blank line → exactly two turns, split at the blank line", async () => {
    const h = await startRepl({ windowMs: WINDOW_MS });
    try {
      await h.waitPrompt(1);
      h.stdin.write("a\n\nb\n");
      await delay(700);
      expect(h.captured.length).toBe(2);
      expect(h.userTexts(1).at(-1)).toBe("a");
      expect(h.userTexts(2).at(-1)).toBe("b");
      await h.finish();
    } finally {
      await h.cleanup();
    }
  }, 20_000);

  it("③a a standalone command takes effect immediately — no window wait (10s window, /exit ends the session at once)", async () => {
    const h = await startRepl({ windowMs: LONG_WINDOW_MS });
    try {
      await h.waitPrompt(1);
      h.stdin.write("/exit\n");
      await delay(2_000); // << the 10s window: only command immediacy can end the session in here
      expect(h.captured.length).toBe(0); // the command never entered a batch / a model turn
      expect(await h.doneSettled()).toBe(true); // the session actually ended
    } finally {
      await h.cleanup();
    }
  }, 20_000);

  it("③b a command-shaped line following content rides with the batch (message content, current semantics)", async () => {
    const h = await startRepl({ windowMs: WINDOW_MS });
    try {
      await h.waitPrompt(1);
      h.stdin.write("task line\n");
      h.stdin.write("/help\n");
      await delay(700);
      expect(h.captured.length).toBe(1); // one message turn — /help did not split it
      expect(h.userTexts(1).at(-1)).toBe("task line\n/help");
      await h.finish();
    } finally {
      await h.cleanup();
    }
  }, 20_000);

  it("④ EOF flushes the in-flight batch as its turn, then the session exits cleanly", async () => {
    const ends: string[] = [];
    const h = await startRepl({ windowMs: LONG_WINDOW_MS, hooks: { onSessionEnd: (s) => { ends.push(s); } } });
    try {
      await h.waitPrompt(1);
      h.stdin.write("final task one\n");
      h.stdin.write("final task two\n");
      h.stdin.end(); // EOF in the same breath — only the close flush can deliver inside 10s
      await delay(2_000);
      expect(h.captured.length).toBe(1); // the in-flight batch became exactly one turn
      expect(h.userTexts(1).at(-1)).toBe("final task one\nfinal task two");
      expect(ends).toContain("exit"); // clean exit through the /exit seam
      expect(await h.doneSettled()).toBe(true); // the runRepl promise resolved — no hang at the prompt
    } finally {
      await h.cleanup();
    }
  }, 20_000);

  it("⑤ TTY stdin (isTTY true) — every line is its own immediate turn, zero batching (old behavior pinned)", async () => {
    const h = await startRepl({ tty: true });
    try {
      const lines = ["tty one", "tty two", "tty three", "tty four", "tty five"];
      // Prompt-paced feeding (the readline discipline): one line per prompt.
      for (let i = 0; i < lines.length; i += 1) {
        await h.waitPrompt(i + 1);
        h.stdin.write(`${lines[i]}\n`);
        await h.waitFor(() => h.captured.length >= i + 1, `turn ${i + 1}`);
      }
      expect(h.captured.length).toBe(5); // five separate turns — no merge
      for (let i = 0; i < lines.length; i += 1) {
        expect(h.userTexts(i + 1).at(-1)).toBe(lines[i]); // each exactly its single line
      }
      await h.finish();
    } finally {
      await h.cleanup();
    }
  }, 25_000);
});
