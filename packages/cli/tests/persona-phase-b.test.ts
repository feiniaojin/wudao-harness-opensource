// packages/cli/tests/persona-phase-b.test.ts — Phase B wire routing through
// the REAL REPL (design 93 §4.2): the CLI's model construction seam is
// `createProvider(config)`, so a config carrying `wire` must reach the
// matching protocol adapter end-to-end.
//   ① wire=anthropic — the captured request is an anthropic /messages call
//      with the anthropic request-body shape (spec §5), driven through one
//      full model turn of the live REPL loop (stream path).
//   ④ /persona --off — the mismatch note the switch path already prints
//      (final-review I1) was MISSING on the bootstrap fallback: a
//      protocol-mismatched config persona (openai-responses = responses-only) fell back
//      silently. The --off confirmation must carry the same note, naming the
//      protocol the LIVE wire speaks (openai-chat default, or wire=anthropic).
import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runRepl } from "../src/repl.js";
import type { ProviderConfig } from "@wudao/providers";

const CFG: ProviderConfig = {
  apiKey: "sk-phase-b",
  baseURL: "https://phase-b.invalid/v1",
  model: "phase-b-model",
};

/** The captured wire request (init.headers as passed — no Node fetch involved). */
interface WireCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** A healthy anthropic SSE completion (the loop prefers `stream`). */
function anthropicSseFetch(captured: WireCall[]): typeof fetch {
  const enc = new TextEncoder();
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 3 } } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return (async (url: unknown, init?: RequestInit) => {
    captured.push({
      url: String(url),
      method: String(init?.method ?? "GET"),
      headers: { ...(init?.headers as Record<string, string>) },
      body: String(init?.body),
    });
    if (!String(url).endsWith("/messages")) {
      // The red-path shape: anything that is NOT the anthropic endpoint fails
      // fast and non-retryably (400 = semantic error — no ladder walk).
      return new Response("phase-b: not a /messages call", { status: 400 });
    }
    const sse = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ev of events) c.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
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

/** Drive one full REPL session through injected streams; resolves on /exit
 *  (same one-line-per-prompt discipline as persona-wire-repl.test.ts). */
async function driveRepl(
  lines: readonly string[],
  opts: { readonly config?: ProviderConfig; readonly sessionId?: string },
): Promise<{ wire: WireCall[]; out: string }> {
  const ws = await mkdtemp(join(tmpdir(), "phase-b-ws-"));
  const globalHome = await mkdtemp(join(tmpdir(), "phase-b-gh-"));
  const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
  const prevFetch = globalThis.fetch;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const captured: WireCall[] = [];
  process.env.WUDAO_GLOBAL_HOME = globalHome; // isolate the global persona tier
  globalThis.fetch = anthropicSseFetch(captured);
  let replError: unknown;
  let seen = "";
  let fed = 0;
  let feeder: ReturnType<typeof setInterval> | undefined;
  try {
    const done = runRepl({
      config: opts.config ?? CFG,
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

describe("Phase B ① — wire=anthropic reaches the anthropic adapter through the live REPL", () => {
  it("the model turn posts an anthropic /messages request with the spec §5 body shape", async () => {
    const { wire, out } = await driveRepl(["hello", "/exit"], {
      config: { ...CFG, wire: "anthropic" },
      sessionId: "phase-b-an-1",
    });
    // The turn completed against the anthropic SSE replay.
    expect(out).toContain("ok");
    const call = wire.find((c) => c.url.endsWith("/messages"));
    if (call === undefined) throw new Error(`the fake fetch saw no /messages request (urls: ${wire.map((c) => c.url).join(", ")})`);
    // Endpoint + method + the anthropic auth shape.
    expect(call.url).toBe("https://phase-b.invalid/v1/messages");
    expect(call.method).toBe("POST");
    expect(call.headers["x-api-key"]).toBe("sk-phase-b");
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers["authorization"]).toBeUndefined();
    // Request-body shape (spec §5): exactly these keys (the loop prefers
    // stream, so the adapter's `stream: true` rider is on the wire), anthropic
    // messages are block arrays, tools carry input_schema. The system prompt
    // is the CLI's own (dynamic) — pin its presence, not its bytes.
    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model", "stream", "system", "tools"]);
    expect(body.stream).toBe(true);
    expect(body.model).toBe("phase-b-model");
    expect(typeof body.max_tokens).toBe("number");
    expect(typeof body.system).toBe("string");
    expect((body.system as string).length).toBeGreaterThan(0);
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
    expect(Array.isArray(body.tools)).toBe(true);
  });
});

describe("Phase B ④ — /persona --off mismatch note (protocol-mismatched bootstrap persona)", () => {
  // openai-responses defines headers/body ONLY on `responses` — a protocol-mismatched
  // bootstrap persona under every wire this test speaks.
  const CODEX_BOOT = { ...CFG, persona: { id: "openai-responses" } } as ProviderConfig;

  it("default wire: the --off fallback prints the mismatch note (was silently missing)", async () => {
    const { out } = await driveRepl(["/persona --off", "/exit"], { config: CODEX_BOOT, sessionId: "phase-b-off-1" });
    expect(out).toContain("persona → openai-responses —— 下一个请求即生效"); // ω99-166f-ii: 钉随源演进
    expect(out).toContain("注：此 persona 未定义 openai-chat 的 headers/body——这里只有 prompt 层生效"); // ω99-166f-ii: 钉随源演进
  });

  it("wire=anthropic: the note names the protocol the LIVE wire speaks", async () => {
    const { out } = await driveRepl(["/persona --off", "/exit"], {
      config: { ...CODEX_BOOT, wire: "anthropic" },
      sessionId: "phase-b-off-2",
    });
    expect(out).toContain("注：此 persona 未定义 anthropic 的 headers/body——这里只有 prompt 层生效"); // ω99-166f-ii: 钉随源演进
  });
});
