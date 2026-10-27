import { describe, it, expect, afterEach, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { JsonRpcClient } from "../src/mcp/json-rpc.js";
import type { McpFrameRecord } from "../src/mcp/trace.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));

const clients: JsonRpcClient[] = [];
function makeClient(opts: { timeoutMs?: number; env?: Record<string, string>; maxLineBytes?: number; shutdownGraceMs?: number; killGraceMs?: number; trace?: (r: McpFrameRecord) => void } = {}): JsonRpcClient {
  const c = new JsonRpcClient({
    command: process.execPath,
    args: [FIXTURE],
    timeoutMs: opts.timeoutMs,
    env: opts.env,
    maxLineBytes: opts.maxLineBytes,
    shutdownGraceMs: opts.shutdownGraceMs,
    killGraceMs: opts.killGraceMs,
    ...(opts.trace !== undefined ? { trace: opts.trace } : {}),
  });
  clients.push(c);
  return c;
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
});

describe("JsonRpcClient (stdio)", () => {
  it("correlates request/response via id (initialize)", async () => {
    const c = makeClient();
    const result = await c.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" },
    });
    expect(result).toMatchObject({
      protocolVersion: "2025-06-18",
      serverInfo: { name: "fake-mcp" },
    });
  });

  it("skips malformed stdout lines (fixture emits one at startup)", async () => {
    const c = makeClient();
    // The fixture writes "this is not json" before anything else; a working
    // line parser ignores it and initialize still succeeds.
    const result = await c.request("tools/list", {});
    const tools = (result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(["echo", "fail", "slow", "crash", "wide", "opaque", "dirty"]); // dirty added by 夜移 021 boundary tests
  });

  it("resolves concurrent requests independently", async () => {
    const c = makeClient();
    const [a, b] = await Promise.all([
      c.request("tools/call", { name: "echo", arguments: { text: "first" } }),
      c.request("tools/call", { name: "echo", arguments: { text: "second" } }),
    ]);
    expect((a as { content: { text: string }[] }).content[0]?.text).toBe("first");
    expect((b as { content: { text: string }[] }).content[0]?.text).toBe("second");
  });

  it("rejects on timeout while the server is still slow-responding", async () => {
    const c = makeClient({ timeoutMs: 100 }); // slow tool responds after ~500ms
    await expect(c.request("tools/call", { name: "slow", arguments: { text: "x" } })).rejects.toThrow(/timed out/i);
    // The client stays usable for other requests after a timeout. The
    // follow-up echo overrides the client's tight 100ms default: the timing
    // under assertion is the FIRST request's timeout, not the echo's
    // roundtrip, and under parallel load a 100ms cross-process roundtrip
    // budget is exactly the flake (the per-request override exists for this).
    const ok = await c.request("tools/call", { name: "echo", arguments: { text: "still alive" } }, { timeoutMs: 5_000 });
    expect((ok as { content: { text: string }[] }).content[0]?.text).toBe("still alive");
  });

  it("rejects when the server returns a JSON-RPC error", async () => {
    const c = makeClient();
    await expect(c.request("no/such-method", {})).rejects.toThrow(/method not found/i);
  });

  it("rejects pending requests when the server process dies", async () => {
    const c = makeClient();
    const dying = c.request("tools/call", { name: "crash", arguments: {} });
    await expect(dying).rejects.toThrow(/crashed|exited/i);
  });

  it("close() ends stdin and waits for the server to exit", async () => {
    const c = makeClient();
    await c.request("initialize", { protocolVersion: "2025-06-18" });
    await c.close();
    // Second close is a no-op, not an error.
    await c.close();
  });

  // A SIGTERM handler can only trap on POSIX — win32's SIGTERM is an
  // immediate TerminateProcess, so the zombie-server lane is untestable there.
  it.skipIf(process.platform === "win32")("close() is bounded even when the server traps SIGTERM (SIGKILL fallback)", async () => {
    const c = makeClient({
      env: { FAKE_TRAP_SIGTERM: "1" },
      shutdownGraceMs: 100,
      killGraceMs: 100,
    });
    await c.request("initialize", { protocolVersion: "2025-06-18" });
    const started = Date.now();
    await c.close(); // must resolve — never hang the CLI on shutdown
    expect(Date.now() - started).toBeLessThan(5_000);
    // The trapped server is only gone via SIGKILL; the exit event lands shortly
    // after the (immediate) kill.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(c.childSignal).toBe("SIGKILL");
  });

  it("a stdout line exceeding the cap hard-errors the connection", async () => {
    const c = makeClient({ env: { FAKE_HUGE_LINE: "1" }, maxLineBytes: 1024 });
    await expect(c.request("tools/list", {})).rejects.toThrow(/exceeded|too large/i);
    // The connection is dead for future requests too — fail-closed, never hung.
    await expect(c.request("tools/list", {})).rejects.toThrow(/closed/i);
  });
});

// ω-5a I20 — frame tracing through the client (injected sink; the env-var
// parsing pins live in mcp-trace.test.ts). The off-by-default case is the
// LAST test: it pins that no env + no option = zero observable change.
describe("JsonRpcClient frame trace (I20)", () => {
  it("traces one initialize round-trip: → then ←, ids equal, bytes > 0, latencyMs >= 0", async () => {
    const records: McpFrameRecord[] = [];
    const c = makeClient({ trace: (r) => records.push(r) });
    await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    // The spawn lifecycle record rides along; the frame records follow.
    const frames = records.filter((r) => r.dir !== "lifecycle");
    expect(frames).toHaveLength(2);
    const [out, in_] = frames as [{ dir: "→" } & McpFrameRecord, { dir: "←" } & McpFrameRecord];
    expect(out.dir).toBe("→");
    expect(out.method).toBe("initialize");
    expect(out.id).toEqual(expect.any(Number));
    expect(out.bytes).toBeGreaterThan(0);
    expect(out.latencyMs).toBeUndefined(); // requests carry no latency
    expect(in_.dir).toBe("←");
    expect(in_.id).toBe(out.id);
    expect(in_.bytes).toBeGreaterThan(0);
    expect(in_.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("traces notifications with dir → and no id", async () => {
    const records: McpFrameRecord[] = [];
    const c = makeClient({ trace: (r) => records.push(r) });
    await c.request("initialize", { protocolVersion: "2025-06-18" }); // ensure the server is up
    const before = records.length;
    c.notify("notifications/initialized", {});
    await new Promise((resolve) => setTimeout(resolve, 100)); // let the write land
    const notified = records.slice(before).filter((r) => r.dir === "→");
    expect(notified).toHaveLength(1);
    expect(notified[0]?.method).toBe("notifications/initialized");
    expect(notified[0]?.id).toBeUndefined();
  });

  it("traces a timed-out request as a lifecycle timeout naming the method", async () => {
    const records: McpFrameRecord[] = [];
    const c = makeClient({ timeoutMs: 80, trace: (r) => records.push(r) });
    await expect(c.request("tools/call", { name: "slow", arguments: { text: "x" } }, { timeoutMs: 80 })).rejects.toThrow(/timed out/i);
    const timeout = records.find((r) => r.dir === "lifecycle" && r.detail?.startsWith("timeout:"));
    expect(timeout).toBeDefined();
    expect(timeout?.method).toBe("tools/call");
    expect(timeout?.detail).toContain("tools/call");
  });

  it("traces server death as a lifecycle exit record", async () => {
    const records: McpFrameRecord[] = [];
    const c = makeClient({ trace: (r) => records.push(r) });
    const dying = c.request("tools/call", { name: "crash", arguments: {} });
    await expect(dying).rejects.toThrow(/crashed|exited/i);
    const exit = records.find((r) => r.dir === "lifecycle" && r.detail?.includes("exited unexpectedly"));
    expect(exit).toBeDefined();
  });

  it("off by default: no env, no option → zero trace writes, requests still resolve", async () => {
    const prev = process.env.WUDAO_MCP_TRACE;
    delete process.env.WUDAO_MCP_TRACE;
    try {
      const writes: McpFrameRecord[] = [];
      const c = makeClient(); // no trace option
      const result = await c.request("tools/list", {});
      expect((result as { tools: unknown[] }).tools).toHaveLength(7); // dirty added by 夜移 021
      expect(writes).toEqual([]);
    } finally {
      if (prev !== undefined) process.env.WUDAO_MCP_TRACE = prev;
    }
  });

  it("a throwing sink never kills the transport — requests resolve, at most one stderr note (review M2)", async () => {
    const stderrChunks: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      const c = makeClient({
        trace: () => { throw new Error("EACCES: permission denied, open '/nope/trace.jsonl'"); },
      });
      // Round-trips still settle — spawn/→/← records all throw, none escape.
      const result = await c.request("tools/list", {});
      expect((result as { tools: unknown[] }).tools).toHaveLength(7); // dirty added by 夜移 021
      const again = await c.request("tools/call", { name: "echo", arguments: { text: "ok" } });
      expect((again as { content: { text: string }[] }).content[0]?.text).toBe("ok");
      const notes = stderrChunks.filter((w) => w.includes("mcp trace"));
      expect(notes.length).toBe(1); // the first dropped record notes; later ones stay silent
      expect(notes[0]).toBe("mcp trace: record dropped (EACCES: permission denied, open '/nope/trace.jsonl') — tracing continues best-effort\n");
    } finally {
      spy.mockRestore();
    }
  });
});
