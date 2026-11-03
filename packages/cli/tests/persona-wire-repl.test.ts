// packages/cli/tests/persona-wire-repl.test.ts — final-review fix round.
// C1/T13-M2: a runRepl-level integration test — switch a builtin persona whose
// openai-chat headers carry {{sessionId}}, drive ONE model turn against an
// injected fetch, and assert the captured wire request carries the RESOLVED
// session header (the Critical: the REPL constructed its PersonaRuntime with
// no slots, so every templated header threw at request time).
// I1: the protocol-mismatch notice — codex defines headers/body only on
// `responses`; the REPL speaks openai-chat, so the switch confirmation must
// say the wire is byte-unchanged (and the captured wire proves it).
// T13-M1: the driver's /persona is a VISIBLE unavailable notice, not a silent
// frontend drop (the /provider no-seam precedent).
import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createScriptedModel, createReadFileTool } from "@wudao-org/core";
import type { Tool } from "@wudao-org/core";
import { runRepl } from "../src/repl.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";
import type { ProviderConfig } from "@wudao-org/providers";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

const CFG: ProviderConfig = {
  apiKey: "sk-wire-test",
  baseURL: "https://wire.invalid/v1",
  model: "wire-model",
};

/** The captured wire request (init.headers as passed — no Node fetch involved). */
interface WireCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** Fake fetch: capture every request, replay a minimal SSE completion (the
 * loop prefers `stream`, so the response must be a parseable event stream —
 * the providers persona-openai-wire fixture shape). */
function sseFetch(captured: WireCall[]): typeof fetch {
  const enc = new TextEncoder();
  return (async (url: unknown, init?: RequestInit) => {
    captured.push({
      url: String(url),
      headers: { ...(init?.headers as Record<string, string>) },
      body: String(init?.body),
    });
    const sse = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`));
        c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}

/** Drain everything a PassThrough buffered so far. */
function drainAll(out: PassThrough): string {
  let text = "";
  let chunk = out.read();
  while (chunk !== null) {
    text += chunk.toString();
    chunk = out.read();
  }
  return text;
}

/** Drive one full REPL session through injected streams; resolves on /exit.
 * Lines are fed ONE PER PROMPT: readline/promises drops a line that arrives
 * while no question is pending (it fires as a bare 'line' event), and the
 * REPL finishes ~700 lines of post-interface setup before its first
 * question — so we watch for each "wudao> " prompt before writing the next
 * line. runRepl builds its provider without a fetch seam, so the wire is
 * captured through a stubbed globalThis.fetch (saved/restored). */
async function driveRepl(lines: readonly string[], opts: { readonly sessionId?: string }): Promise<{ wire: WireCall[]; out: string }> {
  const ws = await mkdtemp(join(tmpdir(), "persona-wire-ws-"));
  const globalHome = await mkdtemp(join(tmpdir(), "persona-wire-gh-"));
  const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
  const prevFetch = globalThis.fetch;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const captured: WireCall[] = [];
  process.env.WUDAO_GLOBAL_HOME = globalHome; // isolate the global persona tier
  globalThis.fetch = sseFetch(captured);
  let replError: unknown;
  let seen = "";
  let fed = 0;
  let feeder: ReturnType<typeof setInterval> | undefined;
  try {
    const done = runRepl({
      config: CFG,
      workspaceRoot: ws,
      buildTools: () => [],
      contextWindowTokens: 200_000,
      stdin,
      stdout,
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    });
    feeder = setInterval(() => {
      seen += drainAll(stdout);
      const prompts = seen.split("wudao> ").length - 1;
      while (fed < lines.length && fed < prompts) {
        stdin.write(`${lines[fed]}\n`);
        fed += 1;
      }
    }, 15);
    await done;
  } catch (err) {
    replError = err;
  } finally {
    if (feeder !== undefined) clearInterval(feeder);
    process.env.WUDAO_GLOBAL_HOME = prevGlobal;
    globalThis.fetch = prevFetch;
    await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  if (replError !== undefined) throw replError;
  return { wire: captured, out: seen + drainAll(stdout) };
}

const chatCall = (wire: readonly WireCall[]): WireCall => {
  const call = wire.find((c) => c.url.endsWith("/chat/completions"));
  if (call === undefined) throw new Error("the fake fetch saw no /chat/completions request");
  return call;
};

describe("final-review C1 — REPL runtime slots (runRepl integration)", () => {
  it("/persona a reference harness: the wire carries the RESOLVED session header, never a literal {{sessionId}} (closes T13-M2)", async () => {
    const { wire, out } = await driveRepl(["/persona deepseek-native", "hello", "/exit"], { sessionId: "wire-sess-1" });
    const call = chatCall(wire);
    // The Critical's exact pin: the openai-chat session header is the runtime
    // slot value — pre-fix this threw inside resolveTemplate on EVERY call.
    expect(call.headers["x-a reference harness-session-id"]).toBe("wire-sess-1");
    // The literal template layer: the pinned attribution header rides too.
    expect(call.headers["user-agent"]).toBe("wudao-harness/0.4.20 (+https://github.com/feiniaojin/wudao-harness-opensource)");
    // No templated value ever reaches the wire unresolved.
    expect(Object.values(call.headers).some((v) => v.includes("{{"))).toBe(false);
    // The adapter's own headers stay intact (persona spreads after, adds only).
    expect(call.headers["authorization"]).toBe("Bearer sk-wire-test");
    expect(call.headers["content-type"]).toBe("application/json");
    // The switch confirmed (no mismatch note — this persona IS openai-chat).
    expect(out).toContain("persona → deepseek-native [headers+body] —— 下一个请求即生效"); // ω99-166f-ii: 钉随源演进
    expect(out).not.toContain("note: this persona defines no openai-chat headers/body");
  });

  it("default slot: a session-less REPL boot resolves {{sessionId}} to \"repl\" (the cron/monitor fallback)", async () => {
    // opts.sessionId omitted → createPersonaRuntime falls back to "repl"; the
    // header still resolves (pre-fix: every call threw).
    const { wire } = await driveRepl(["/persona deepseek-native", "hello", "/exit"], {});
    expect(chatCall(wire).headers["x-a reference harness-session-id"]).toBe("repl");
  });
});

describe("final-review I1 — protocol-mismatch switch notice (runRepl integration)", () => {
  it("/persona codex: layers flagged on but nothing defined on openai-chat → the notice line + a byte-unchanged wire", async () => {
    const { wire, out } = await driveRepl(["/persona openai-responses", "hi", "/exit"], { sessionId: "wire-sess-2" });
    // The informational notice (exact brief text), appended to the confirmation.
    expect(out).toContain("注：此 persona 未定义 openai-chat 的 headers/body——这里只有 prompt 层生效"); // ω99-166f-ii: 钉随源演进
    // The confirmation itself still prints (informational, not an error).
    expect(out).toContain("persona → openai-responses [headers+body] —— 下一个请求即生效"); // ω99-166f-ii: 钉随源演进
    // The wire proof: codex defines headers/body only on `responses` — the
    // captured request is byte-wise the adapter's own (exactly the two
    // baseline headers, nothing persona-added).
    const call = chatCall(wire);
    expect(Object.keys(call.headers).sort()).toEqual(["authorization", "content-type"]);
  });
});

describe("final-review T13-M1 — driver /persona is a visible notice, not a silent drop", () => {
  it("driver.submit(\"/persona cc\") → notice outcome rendered by every frontend; the model never runs", async () => {
    const ws = await mkdtemp(join(tmpdir(), "persona-drv-"));
    try {
      const model = createScriptedModel([]);
      const driver: AgentDriver = createAgentDriver({
        systemPrompt: "s",
        summarize: summarizeToolCall,
        model,
        tools: [createReadFileTool({ workspaceRoot: process.cwd() }) as Tool],
        workspaceRoot: ws,
        sessionId: "persona-drv-1",
      });
      driver.submit("/persona cc");
      await wait();
      const notices = driver.getHistory().map((e) => (e.kind === "notice" ? e.text : "")).join("\n");
      // The /provider no-seam precedent shape: parenthesized, names the owner
      // frontend and the restart escape hatch.
      expect(notices).toContain("此前端不支持切换 persona"); // ω99-166f-ii: 钉随源演进（brief 二节漏判的钉）
      expect(notices).toContain("/persona 归 readline REPL 所有"); // ω99-166f-ii: 钉随源演进（brief 二节漏判的钉）
      expect(notices).toContain("WUDAO_PERSONA=");
      // Nothing was silently sent to the model either.
      expect(model.calls).toBe(0);
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
