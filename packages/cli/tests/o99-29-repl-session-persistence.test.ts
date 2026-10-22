// ω99-29 T1 — the REPL's main-conversation persistence (the third frontend
// gets the M5 discipline the TUI and one-shot already carry). ω99-26's
// campaign proved the gap: `--no-tui --auto` ran 117 model calls with ZERO
// main-conversation persistence (only 2×243B meta stubs). These cases pin the
// same seams session-engine.ts wires for the driver frontends:
//   ① the user's own turn hits the JSONL BEFORE the first model call settles
//      (crash-safety for the one un-regenerable message — 夜移 017);
//   ② the tool-carrying assistant lands before any tool body runs (the 波次8
//      #45 pre-dispatch durability barrier);
//   ③ a full run's selectMessagesToPersist picks land in order, no dupes;
//   ④ an interrupted run persists the synthetic "(interrupted)" assistant +
//      the repaired tool tail — the JSONL never ends on an orphan tool_use;
//   ⑤ a tier-2 compaction's summary marker lands at event time;
//   ⑥ resume equivalence — a second run over the same session appends, never
//      re-persists (identity discipline against the loaded base).
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runRepl } from "../src/repl.js";
import {
  createJsonlSessionStore,
  repairOrphanedToolCalls,
  applySummaryMarkers,
  resumeChain,
  activeBranchLeafKey,
  SUMMARY_MARKER,
  type AgentMessage,
  type Tool,
} from "@wudao/core";
import type { ProviderConfig } from "@wudao/providers";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  await delay();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`o99-29: timed out waiting for ${what}`);
    await delay(10);
  }
}

// The SSE frame builder the existing REPL suites use (turn-diff-faces shape).
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

// Message lines of a session's JSONL (non-message entries filtered out).
async function messageLines(ws: string, sid: string): Promise<AgentMessage[]> {
  const store = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
  return store.load(sid);
}

/** A tool whose body blocks until release() — the mid-tool crash window. */
function gatedTool(name: string, result: string): { tool: Tool; started: () => boolean; release: () => void } {
  let started = false;
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  return {
    started: () => started,
    release: () => open(),
    tool: {
      name,
      description: `test fixture tool (${name})`,
      parameters: { type: "object", properties: {} },
      isReadOnly: () => true,
      execute: async () => {
        started = true;
        await gate;
        return { content: result };
      },
    },
  };
}

describe("ω99-29 T1 — REPL main-conversation persistence", () => {
  it("① the user turn lands on the JSONL before the first model call settles (early-user discipline)", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "o9929-user-")));
    const globalHome = await mkdtemp(join(tmpdir(), "o9929-user-gh-"));
    const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
    const prevFetch = globalThis.fetch;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    // Hold the FIRST model call open — everything observed while it hangs is
    // provably pre-settle (the mid-run crash window).
    let releaseModel: (() => void) | undefined;
    const modelGate = new Promise<void>((r) => { releaseModel = r; });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) await modelGate;
      return new Response(sse(answer("late answer")), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    let seen = "";
    let fed = 0;
    const lines = ["persist me first", "/exit"];
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
        config: { apiKey: "sk-o9929", baseURL: "https://o9929-user.invalid/v1", model: "o9929-model" } satisfies ProviderConfig,
        workspaceRoot: ws,
        buildTools: () => [],
        contextWindowTokens: 200_000,
        sessionId: "wudao-o9929user",
        stdin,
        stdout,
      });
      await until(() => { pump(); return calls >= 1; }, "the (held) first model call");
      // RED pre-fix: nothing but the turn is in flight and the JSONL does not
      // exist — the REPL persisted nothing. GREEN: the user line is on disk.
      await until(async () => (await messageLines(ws, "wudao-o9929user")).some((m) => m.role === "user" && m.content === "persist me first"), "the user line on disk mid-run");
      releaseModel?.();
      // Feed /exit once the next prompt prints, then let the session end.
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) { pump(); if (fed >= lines.length) break; await delay(10); }
      await Promise.race([done!, delay(5_000)]);
    } catch (err) {
      replError = err;
    } finally {
      releaseModel?.();
      stdin.end();
      if (done !== undefined) await Promise.race([done.then(() => {}, () => {}), delay(500)]);
      process.env.WUDAO_GLOBAL_HOME = prevGlobal;
      globalThis.fetch = prevFetch;
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    if (replError !== undefined) throw replError;
  }, 20_000);

  it("② the tool-carrying assistant lands before any tool body runs (pre-dispatch barrier)", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "o9929-bar-")));
    const globalHome = await mkdtemp(join(tmpdir(), "o9929-bar-gh-"));
    const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
    const prevFetch = globalThis.fetch;
    const prevArgv = process.argv;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    // A custom tool needs --auto to run ask-free (the established argv-override
    // pattern); the GATED body is the mid-tool crash window.
    process.argv = [prevArgv[0]!, "wudao", "--auto"];
    const blob = gatedTool("blob_fetch", "blob done");
    const script: readonly (readonly unknown[])[] = [
      toolRound("blob_fetch", "c1", {}),
      answer("all done"),
    ];
    let calls = 0;
    globalThis.fetch = (async () => {
      const frames = script[calls] ?? answer("ok");
      calls += 1;
      return new Response(sse(frames), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    let seen = "";
    let fed = 0;
    const lines = ["fetch the blob", "/exit"];
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
        config: { apiKey: "sk-o9929", baseURL: "https://o9929-bar.invalid/v1", model: "o9929-model" } satisfies ProviderConfig,
        workspaceRoot: ws,
        buildTools: () => [blob.tool],
        contextWindowTokens: 200_000,
        sessionId: "wudao-o9929bar",
        stdin,
        stdout,
      });
      await until(() => { pump(); return blob.started(); }, "the (held) tool body to start");
      // The tool body is running and BLOCKED. RED pre-fix: only the user line
      // is on disk — the assistant(tool_use) lands at run-complete, so a crash
      // HERE leaves the side effect untraceable. GREEN: the barrier persisted
      // the ordered prefix before the body started.
      await until(async () => {
        const msgs = await messageLines(ws, "wudao-o9929bar");
        return msgs.some((m) => m.role === "assistant" && (m.toolCalls ?? []).some((tc) => tc.id === "c1" && tc.name === "blob_fetch"));
      }, "the tool-carrying assistant on disk mid-tool");
      blob.release();
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) { pump(); if (fed >= lines.length) break; await delay(10); }
      await Promise.race([done!, delay(5_000)]);
    } catch (err) {
      replError = err;
    } finally {
      blob.release();
      stdin.end();
      if (done !== undefined) await Promise.race([done.then(() => {}, () => {}), delay(500)]);
      process.argv = prevArgv;
      process.env.WUDAO_GLOBAL_HOME = prevGlobal;
      globalThis.fetch = prevFetch;
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    if (replError !== undefined) throw replError;
  }, 20_000);

  it("③ a full run's picks land in order on the JSONL, identity-deduped (no duplicate lines)", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "o9929-tail-")));
    const globalHome = await mkdtemp(join(tmpdir(), "o9929-tail-gh-"));
    const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
    const prevFetch = globalThis.fetch;
    const prevArgv = process.argv;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    process.argv = [prevArgv[0]!, "wudao", "--auto"];
    const blob = gatedTool("blob_fetch", "blob done");
    const script: readonly (readonly unknown[])[] = [
      toolRound("blob_fetch", "c1", {}),
      answer("final answer text"),
    ];
    let calls = 0;
    globalThis.fetch = (async () => {
      const frames = script[calls] ?? answer("ok");
      calls += 1;
      return new Response(sse(frames), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    let seen = "";
    let fed = 0;
    const lines = ["run the full turn", "/exit"];
    const drain = (): string => { let t = ""; let c = stdout.read(); while (c !== null) { t += c.toString(); c = stdout.read(); } return t; };
    const pump = (): void => {
      seen += drain();
      const prompts = seen.split("wudao> ").length - 1;
      while (fed < lines.length && fed < prompts) { stdin.write(`${lines[fed]}\n`); fed += 1; }
    };
    process.env.WUDAO_GLOBAL_HOME = globalHome;
    let replError: unknown;
    let done: Promise<void> | undefined;
    let msgs: AgentMessage[] = [];
    try {
      done = runRepl({
        config: { apiKey: "sk-o9929", baseURL: "https://o9929-tail.invalid/v1", model: "o9929-model" } satisfies ProviderConfig,
        workspaceRoot: ws,
        buildTools: () => [blob.tool],
        contextWindowTokens: 200_000,
        sessionId: "wudao-o9929tail",
        stdin,
        stdout,
      });
      // This case needs the FULL run: release the body the moment it starts
      // (the barrier itself is case ②'s contract).
      await until(() => { pump(); if (blob.started()) blob.release(); return seen.includes("final answer text"); }, "the run to settle");
      // The settle seam persists synchronously inside runTurn, but the fs
      // appends resolve on their own microtasks — poll briefly for the full
      // tail before asserting.
      await until(async () => {
        msgs = await messageLines(ws, "wudao-o9929tail");
        return msgs.length >= 4;
      }, "the run's four lines on disk");
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) { pump(); if (fed >= lines.length) break; await delay(10); }
      await Promise.race([done!, delay(5_000)]);
    } catch (err) {
      replError = err;
    } finally {
      blob.release();
      stdin.end();
      if (done !== undefined) await Promise.race([done.then(() => {}, () => {}), delay(500)]);
      process.argv = prevArgv;
      process.env.WUDAO_GLOBAL_HOME = prevGlobal;
      globalThis.fetch = prevFetch;
      // Read AFTER the REPL settled but BEFORE the workspace goes away.
      msgs = await messageLines(ws, "wudao-o9929tail").catch(() => msgs);
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    if (replError !== undefined) throw replError;
    // Exactly the run's four lines, in order: user → assistant(tool_use) →
    // tool result → final assistant. RED pre-fix: only the first two (early
    // user + barrier) land — the tool result and final answer are lost.
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(msgs[0]?.content).toBe("run the full turn");
    expect((msgs[1]?.toolCalls ?? []).map((tc) => tc.name)).toEqual(["blob_fetch"]);
    expect(msgs[2]?.content).toBe("blob done");
    expect(msgs[3]?.content).toBe("final answer text");
    // Identity discipline: no line was appended twice (the early-user + the
    // tail pass share the persistBase; a duplicate would show as length 5+).
    expect(msgs.length).toBe(4);
  }, 20_000);

  it("④ an interrupted run persists the synthetic (interrupted) assistant + repaired tool tail — no orphan tool_use at the JSONL's end", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "o9929-int-")));
    const globalHome = await mkdtemp(join(tmpdir(), "o9929-int-gh-"));
    const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
    const prevFetch = globalThis.fetch;
    const prevArgv = process.argv;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    process.argv = [prevArgv[0]!, "wudao", "--auto"];
    // The tool body stays HELD while SIGINT lands: the assistant(tool_use) is
    // durable (case ②'s barrier) but the call has no result yet — the exact
    // orphan window repairOrphanedToolCalls exists for.
    const blob = gatedTool("blob_fetch", "blob done");
    const script: readonly (readonly unknown[])[] = [
      toolRound("blob_fetch", "c1", {}),
      answer("never reached"),
    ];
    let calls = 0;
    globalThis.fetch = (async () => {
      const frames = script[calls] ?? answer("ok");
      calls += 1;
      return new Response(sse(frames), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    let seen = "";
    let fed = 0;
    const lines = ["fetch the blob", "/exit"];
    const drain = (): string => { let t = ""; let c = stdout.read(); while (c !== null) { t += c.toString(); c = stdout.read(); } return t; };
    const pump = (): void => {
      seen += drain();
      const prompts = seen.split("wudao> ").length - 1;
      while (fed < lines.length && fed < prompts) { stdin.write(`${lines[fed]}\n`); fed += 1; }
    };
    process.env.WUDAO_GLOBAL_HOME = globalHome;
    let replError: unknown;
    let done: Promise<void> | undefined;
    let msgs: AgentMessage[] = [];
    try {
      done = runRepl({
        config: { apiKey: "sk-o9929", baseURL: "https://o9929-int.invalid/v1", model: "o9929-model" } satisfies ProviderConfig,
        workspaceRoot: ws,
        buildTools: () => [blob.tool],
        contextWindowTokens: 200_000,
        sessionId: "wudao-o9929int",
        stdin,
        stdout,
      });
      await until(() => { pump(); return blob.started() || seen.includes("blob_fetch"); }, "the tool round to reach the body");
      // SIGINT mid-tool (the suite's established process.emit pattern).
      try { process.emit("SIGINT"); } catch { /* the handler may throw through a blocked exit */ }
      await until(() => { pump(); return seen.includes("⚠️ 已中断"); }, "the interrupted terminal"); // ω99-166b: 随源中文化（repl :1940/:1981）。
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) { pump(); if (fed >= lines.length) break; await delay(10); }
      await Promise.race([done!, delay(5_000)]);
      await until(async () => {
        msgs = await messageLines(ws, "wudao-o9929int");
        return msgs.length >= 2 && msgs[msgs.length - 1]?.role === "assistant";
      }, "the interrupted tail on disk");
    } catch (err) {
      replError = err;
    } finally {
      blob.release();
      stdin.end();
      if (done !== undefined) await Promise.race([done.then(() => {}, () => {}), delay(500)]);
      process.argv = prevArgv;
      process.env.WUDAO_GLOBAL_HOME = prevGlobal;
      globalThis.fetch = prevFetch;
      msgs = await messageLines(ws, "wudao-o9929int").catch(() => msgs);
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    if (replError !== undefined) throw replError;
    // The user line, the durable tool_use, then the repaired tail. The LAST
    // line is the synthetic assistant (never an orphan tool_use), and the
    // unmatched call got a repair result (UNKNOWN-outcome text), not silence.
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[1]?.role).toBe("assistant");
    expect((msgs[1]?.toolCalls ?? []).map((tc) => tc.id)).toEqual(["c1"]);
    const last = msgs[msgs.length - 1];
    expect(last?.role).toBe("assistant");
    expect(last?.content).toBe("(interrupted)");
    // Every tool_use on the JSONL is answered: no tool message is missing
    // between the assistant(tool_use) and the synthetic tail.
    const toolUses = new Set<string>();
    const answered = new Set<string>();
    for (const m of msgs) {
      if (m.role === "assistant") for (const tc of m.toolCalls ?? []) toolUses.add(tc.id);
      if (m.role === "tool" && m.toolCallId !== undefined) answered.add(m.toolCallId);
    }
    for (const id of toolUses) expect(answered.has(id)).toBe(true);
  }, 20_000);

  it("⑤ a tier-2 compaction's summary marker lands on the JSONL at event time", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "o9929-cmp-")));
    const globalHome = await mkdtemp(join(tmpdir(), "o9929-cmp-gh-"));
    const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
    const prevFetch = globalThis.fetch;
    const prevArgv = process.argv;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    process.argv = [prevArgv[0]!, "wudao", "--auto"];
    // A span of 8 thin seeded messages (past keepRecent=6) + a 100KB
    // compactionExempt tool result: tiers 0/1 skip the exempt result
    // (retention), so the pre-call occupancy check (window 20k, immediate
    // band) lands on tier 2 — whose digestible span takes the ZERO-LLM
    // digest path (deterministic; no fetch branching needed).
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
      execute: async () => ({ content: "x".repeat(100_000) }),
    };
    const script: readonly (readonly unknown[])[] = [
      toolRound("big_blob", "c1", {}),
      answer("done after compact"),
    ];
    let calls = 0;
    globalThis.fetch = (async () => {
      const frames = script[calls] ?? answer("ok");
      calls += 1;
      return new Response(sse(frames), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    let seen = "";
    let fed = 0;
    const lines = ["load the blob", "/exit"];
    const drain = (): string => { let t = ""; let c = stdout.read(); while (c !== null) { t += c.toString(); c = stdout.read(); } return t; };
    const pump = (): void => {
      seen += drain();
      const prompts = seen.split("wudao> ").length - 1;
      while (fed < lines.length && fed < prompts) { stdin.write(`${lines[fed]}\n`); fed += 1; }
    };
    process.env.WUDAO_GLOBAL_HOME = globalHome;
    let replError: unknown;
    let done: Promise<void> | undefined;
    let msgs: AgentMessage[] = [];
    try {
      done = runRepl({
        config: { apiKey: "sk-o9929", baseURL: "https://o9929-cmp.invalid/v1", model: "o9929-model" } satisfies ProviderConfig,
        workspaceRoot: ws,
        buildTools: () => [bigBlob],
        contextWindowTokens: 20_000,
        resumeHistory: seed,
        sessionId: "wudao-o9929cmp",
        stdin,
        stdout,
      });
      await until(() => { pump(); return seen.includes("♻️ 上下文已压缩"); }, "the compaction to fire"); // ω99-192: 钉随源演进
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) { pump(); if (fed >= lines.length) break; await delay(10); }
      await Promise.race([done!, delay(5_000)]);
      await until(async () => {
        msgs = await messageLines(ws, "wudao-o9929cmp");
        return msgs.some((m) => m.role === "user" && m.content.startsWith(SUMMARY_MARKER));
      }, "the summary marker on disk");
    } catch (err) {
      replError = err;
    } finally {
      stdin.end();
      if (done !== undefined) await Promise.race([done.then(() => {}, () => {}), delay(500)]);
      process.argv = prevArgv;
      process.env.WUDAO_GLOBAL_HOME = prevGlobal;
      globalThis.fetch = prevFetch;
      msgs = await messageLines(ws, "wudao-o9929cmp").catch(() => msgs);
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    if (replError !== undefined) throw replError;
    // The frozen summary marker is a durable line (the engine's onCompacted
    // discipline). RED pre-fix: the compacted branch renders but persists
    // nothing — no SUMMARY_MARKER line exists on the JSONL.
    const markers = msgs.filter((m) => m.role === "user" && m.content.startsWith(SUMMARY_MARKER));
    expect(markers.length).toBe(1);
    // And the seeded (already-persisted-by-a-previous-process) history was
    // NOT re-persisted: the identity base kept the seed out.
    expect(msgs.some((m) => m.role === "user" && m.content === "seed question 0")).toBe(false);
  }, 20_000);

  it("⑤b a MANUAL /compact persists its frozen summary too (the driver's onCompacted parity)", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "o9929-mcp-")));
    const globalHome = await mkdtemp(join(tmpdir(), "o9929-mcp-gh-"));
    const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
    const prevFetch = globalThis.fetch;
    const prevArgv = process.argv;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    process.argv = [prevArgv[0]!, "wudao", "--auto"];
    // Same seed shape as ⑤, but the window is HUGE (no auto compaction) —
    // the user types /compact and manualCompact's tier-2 runs on the span
    // (digest path, deterministic).
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
    const script: readonly (readonly unknown[])[] = [
      toolRound("big_blob", "c1", {}),
      answer("turn done"),
    ];
    let calls = 0;
    globalThis.fetch = (async () => {
      const frames = script[calls] ?? answer("ok");
      calls += 1;
      return new Response(sse(frames), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    let seen = "";
    let fed = 0;
    const lines = ["load the blob", "/compact", "/exit"];
    const drain = (): string => { let t = ""; let c = stdout.read(); while (c !== null) { t += c.toString(); c = stdout.read(); } return t; };
    const pump = (): void => {
      seen += drain();
      const prompts = seen.split("wudao> ").length - 1;
      while (fed < lines.length && fed < prompts) { stdin.write(`${lines[fed]}\n`); fed += 1; }
    };
    process.env.WUDAO_GLOBAL_HOME = globalHome;
    let replError: unknown;
    let done: Promise<void> | undefined;
    let msgs: AgentMessage[] = [];
    try {
      done = runRepl({
        config: { apiKey: "sk-o9929", baseURL: "https://o9929-mcp.invalid/v1", model: "o9929-model" } satisfies ProviderConfig,
        workspaceRoot: ws,
        buildTools: () => [bigBlob],
        contextWindowTokens: 200_000,
        resumeHistory: seed,
        sessionId: "wudao-o9929mcp",
        stdin,
        stdout,
      });
      await until(() => { pump(); return seen.includes("♻️ 上下文已压缩"); }, "the manual compaction line"); // ω99-192: 钉随源演进
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) { pump(); if (fed >= lines.length) break; await delay(10); }
      await Promise.race([done!, delay(5_000)]);
      await until(async () => {
        msgs = await messageLines(ws, "wudao-o9929mcp");
        return msgs.some((m) => m.role === "user" && m.content.startsWith(SUMMARY_MARKER));
      }, "the manual summary marker on disk");
    } catch (err) {
      replError = err;
    } finally {
      stdin.end();
      if (done !== undefined) await Promise.race([done.then(() => {}, () => {}), delay(500)]);
      process.argv = prevArgv;
      process.env.WUDAO_GLOBAL_HOME = prevGlobal;
      globalThis.fetch = prevFetch;
      msgs = await messageLines(ws, "wudao-o9929mcp").catch(() => msgs);
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    if (replError !== undefined) throw replError;
    const markers = msgs.filter((m) => m.role === "user" && m.content.startsWith(SUMMARY_MARKER));
    expect(markers.length).toBe(1);
  }, 20_000);

  it("⑥ resume equivalence — a second run over the same session appends, never re-persists", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "o9929-res-")));
    const globalHome = await mkdtemp(join(tmpdir(), "o9929-res-gh-"));
    const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
    const prevFetch = globalThis.fetch;
    const prevArgv = process.argv;
    process.argv = [prevArgv[0]!, "wudao", "--auto"];
    const store = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
    const SID = "wudao-o9929res";
    // resolveSession's reading shape (index.ts:263-277): entries → messages →
    // chain-aware summary projection → orphan repair. Same composition, so
    // the resume the boot performs is what run 2 sees here.
    const loadHistory = async (): Promise<AgentMessage[]> => {
      const entries = await store.loadSessionEntries(SID);
      const messages = entries.filter((e): e is AgentMessage => "role" in e);
      return repairOrphanedToolCalls(applySummaryMarkers(resumeChain(messages, activeBranchLeafKey(entries)), { chain: true }));
    };
    const script: readonly (readonly unknown[])[] = [
      toolRound("blob_fetch", "c1", {}),
      answer("first run done"),
      answer("second run done"),
    ];
    let calls = 0;
    globalThis.fetch = (async () => {
      const frames = script[calls] ?? answer("ok");
      calls += 1;
      return new Response(sse(frames), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const blob = gatedTool("blob_fetch", "blob done");
    const runOnce = async (prompt: string, resumeHistory?: readonly AgentMessage[]): Promise<void> => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      let seen = "";
      let fed = 0;
      const lines = [prompt, "/exit"];
      const drain = (): string => { let t = ""; let c = stdout.read(); while (c !== null) { t += c.toString(); c = stdout.read(); } return t; };
      const pump = (): void => {
        seen += drain();
        const prompts = seen.split("wudao> ").length - 1;
        while (fed < lines.length && fed < prompts) { stdin.write(`${lines[fed]}\n`); fed += 1; }
      };
      let replError: unknown;
      let done: Promise<void> | undefined;
      try {
        done = runRepl({
          config: { apiKey: "sk-o9929", baseURL: "https://o9929-res.invalid/v1", model: "o9929-model" } satisfies ProviderConfig,
          workspaceRoot: ws,
          buildTools: () => [blob.tool],
          contextWindowTokens: 200_000,
          sessionId: SID,
          stdin,
          stdout,
          ...(resumeHistory !== undefined ? { resumeHistory } : {}),
        });
        await until(() => { pump(); if (blob.started()) blob.release(); return seen.includes("done"); }, "the run to settle");
        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline) { pump(); if (fed >= lines.length) break; await delay(10); }
        await Promise.race([done!, delay(5_000)]);
      } catch (err) {
        replError = err;
      } finally {
        blob.release();
        stdin.end();
        if (done !== undefined) await Promise.race([done.then(() => {}, () => {}), delay(500)]);
      }
      if (replError !== undefined) throw replError;
    };
    process.env.WUDAO_GLOBAL_HOME = globalHome;
    let afterRun1: AgentMessage[] = [];
    let afterRun2: AgentMessage[] = [];
    try {
      await runOnce("first round");
      afterRun1 = await messageLines(ws, SID);
      expect(afterRun1.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
      // Resume: same session, same reading the boot's resolveSession does.
      await runOnce("second round", await loadHistory());
      await until(async () => {
        afterRun2 = await messageLines(ws, SID);
        return afterRun2.length >= 6;
      }, "run 2's lines on disk");
    } finally {
      process.argv = prevArgv;
      process.env.WUDAO_GLOBAL_HOME = prevGlobal;
      globalThis.fetch = prevFetch;
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    // History = OLD + NEW exactly: the resumed base (fresh identities from
    // the load) seeded persistBase, so run 1's lines never re-appended.
    expect(afterRun2.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user", "assistant"]);
    expect(afterRun2[4]?.content).toBe("second round");
    expect(afterRun2[5]?.content).toBe("second run done");
    const userTexts = afterRun2.filter((m) => m.role === "user").map((m) => m.content);
    expect(userTexts.filter((c) => c === "first round").length).toBe(1);
    expect(userTexts.filter((c) => c === "second round").length).toBe(1);
  }, 30_000);
});
