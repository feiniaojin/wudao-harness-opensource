// P2-9（96 队列 #9）LspClient 单测 — 对 fake-lsp-server 的进程级协议测试。
// 钉死：握手、id 配对、通知不入等待、server→client 请求自动应答、
// 超时不挂死、崩溃 fail-closed、didOpen 缓存 + didChange 增量、有界 close。
import { describe, it, expect, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LspClient } from "../src/lsp/client.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-lsp-server.mjs", import.meta.url));

interface LogLine {
  boot?: number;
  recv?: { id?: number; method?: string; params?: unknown };
  crash?: string;
}

async function makeWorkspace(): Promise<{ root: string; log: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "wudao-lsp-client-"));
  const log = join(root, "lsp.log");
  const docPath = join(root, "src", "app.ts");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(docPath, "export function foo(): void {}\nfoo();\n", "utf8");
  return { root, log, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

function spawnClient(
  root: string,
  log: string,
  env: Record<string, string> = {},
  opts: { timeoutMs?: number; initializeTimeoutMs?: number; shutdownGraceMs?: number; killGraceMs?: number } = {},
): LspClient {
  return new LspClient({
    command: process.execPath,
    args: [FIXTURE],
    workspaceRoot: root,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.initializeTimeoutMs !== undefined ? { initializeTimeoutMs: opts.initializeTimeoutMs } : {}),
    ...(opts.shutdownGraceMs !== undefined ? { shutdownGraceMs: opts.shutdownGraceMs } : {}),
    ...(opts.killGraceMs !== undefined ? { killGraceMs: opts.killGraceMs } : {}),
    env: { FAKE_LSP_LOG: log, ...env },
  });
}

async function readLog(log: string): Promise<LogLine[]> {
  try {
    return (await readFile(log, "utf8")).split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as LogLine);
  } catch {
    return [];
  }
}

const methods = (lines: LogLine[]): string[] =>
  lines.flatMap((l) => (l.recv?.method !== undefined ? [l.recv.method] : []));

const clients: LspClient[] = [];
function track(c: LspClient): LspClient {
  clients.push(c);
  return c;
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
});

describe("LspClient (Content-Length stdio)", () => {
  it("handshakes: initialize → capabilities, then the initialized notification, exactly once", async () => {
    const ws = await makeWorkspace();
    try {
      const c = track(spawnClient(ws.root, ws.log));
      await c.initialize();
      // 0.4.10 gate 闪红收据：initialize() resolve 时 notify("initialized")
      // 已写 socket，但夹具的落盘链（子进程解析→追加日志文件）异步——立即
      // 读日志会输掉竞态（冷启动/满载下必现）。有界等待代替立即读/固定 sleep
      // （下邻 configuration 测试的 250ms sleep 是同族旧形态）。
      const untilMethods = async (want: string[], ms = 4_000): Promise<string[]> => {
        const by = Date.now() + ms;
        for (;;) {
          const sent = methods(await readLog(ws.log));
          if (sent.length >= want.length && want.every((m, i) => sent[i] === m)) return sent;
          if (Date.now() > by) return sent; // 超时返回现状——断言给出真实差异
          await new Promise((r) => setTimeout(r, 10));
        }
      };
      let sent = await untilMethods(["initialize", "initialized"]);
      expect(sent).toEqual(["initialize", "initialized"]);
      // Second initialize() is a no-op (single-flight, no duplicate handshake).
      await c.initialize();
      sent = await untilMethods(["initialize", "initialized"]);
      expect(sent).toEqual(["initialize", "initialized"]);
    } finally {
      await ws.cleanup();
    }
  });

  it("answers server→client requests (workspace/configuration) — the client's reply lands in the log", async () => {
    const ws = await makeWorkspace();
    try {
      const c = track(spawnClient(ws.root, ws.log));
      await c.initialize();
      // The fake's configuration request rides the initialize response chunk;
      // the client's auto-reply needs a beat to round-trip into the fake's log.
      await new Promise((r) => setTimeout(r, 250));
      const lines = await readLog(ws.log);
      // the client must have sent a RESPONSE frame back (logged as a recv with
      // id 9000 and no method). Without it a real tsserver wedges.
      const response = lines.find((l) => l.recv?.id === 9000 && l.recv?.method === undefined);
      expect(response).toBeDefined();
      // The auto-answer for configuration is a null-per-item array.
      expect(response?.recv).toMatchObject({ id: 9000, result: [null] });
    } finally {
      await ws.cleanup();
    }
  });

  it("correlates concurrent requests via id; server notifications never mispair", async () => {
    const ws = await makeWorkspace();
    try {
      const c = track(spawnClient(ws.root, ws.log));
      await c.initialize();
      const docUri = pathToFileURL(join(ws.root, "src", "app.ts")).href;
      const [hover, refs] = await Promise.all([
        c.request("textDocument/hover", { textDocument: { uri: docUri }, position: { line: 1, character: 4 } }),
        c.request("textDocument/references", { textDocument: { uri: docUri }, position: { line: 1, character: 4 } }),
      ]);
      // The fake's startup window/logMessage notification arrived before any
      // response — a mispaired decoder would have resolved the wrong shapes.
      expect((hover as { contents: { value: string } }).contents.value).toContain("function foo");
      expect(refs).toBeInstanceOf(Array);
      expect((refs as unknown[]).length).toBe(3);
    } finally {
      await ws.cleanup();
    }
  });

  it("rejects a request on timeout while the connection stays usable (never hangs)", async () => {
    const ws = await makeWorkspace();
    try {
      const c = track(spawnClient(ws.root, ws.log, { FAKE_LSP_DELAY_MS: "400" }, { timeoutMs: 80, initializeTimeoutMs: 5000 }));
      await c.initialize();
      const docUri = pathToFileURL(join(ws.root, "src", "app.ts")).href;
      await expect(c.request("textDocument/hover", { textDocument: { uri: docUri }, position: { line: 0, character: 0 } }))
        .rejects.toThrow(/timed out/i);
      // A later request with a per-call budget succeeds on the SAME process.
      const hover = await c.request("textDocument/hover", { textDocument: { uri: docUri }, position: { line: 0, character: 0 } }, { timeoutMs: 5000 });
      expect((hover as { contents: { value: string } }).contents.value).toContain("function foo");
    } finally {
      await ws.cleanup();
    }
  });

  it("rejects pending AND future requests when the server crashes (fail-closed)", async () => {
    const ws = await makeWorkspace();
    try {
      const c = track(spawnClient(ws.root, ws.log, { FAKE_LSP_CRASH_ON: "textDocument/hover" }));
      await c.initialize();
      const docUri = pathToFileURL(join(ws.root, "src", "app.ts")).href;
      await expect(c.request("textDocument/hover", { textDocument: { uri: docUri }, position: { line: 0, character: 0 } }))
        .rejects.toThrow(/crashed|exited|died/i);
      await expect(c.request("textDocument/hover", { textDocument: { uri: docUri }, position: { line: 0, character: 0 } }))
        .rejects.toThrow(/closed|crashed|exited|died/i);
    } finally {
      await ws.cleanup();
    }
  });

  it("dies fail-closed on unframed garbage from the server", async () => {
    const ws = await makeWorkspace();
    try {
      const c = track(spawnClient(ws.root, ws.log, { FAKE_LSP_GARBAGE: "1" }));
      await expect(c.initialize()).rejects.toThrow(/frame|Content-Length|exceeded/i);
    } finally {
      await ws.cleanup();
    }
  });

  it("dies fail-closed when the command does not exist (spawn ENOENT)", async () => {
    const ws = await makeWorkspace();
    try {
      const c = track(new LspClient({
        command: "/nonexistent/no-such-lsp-server",
        args: [],
        workspaceRoot: ws.root,
        timeoutMs: 1000,
      }));
      await expect(c.initialize()).rejects.toThrow(/start|spawn|ENOENT|no such/i);
    } finally {
      await ws.cleanup();
    }
  });

  it("openDocument sends didOpen once per document; changed text rides didChange (full sync)", async () => {
    const ws = await makeWorkspace();
    const docPath = join(ws.root, "src", "app.ts");
    try {
      const c = track(spawnClient(ws.root, ws.log));
      await c.initialize();
      c.openDocument({ path: docPath, languageId: "typescript", text: "let a = 1;\n" });
      c.openDocument({ path: docPath, languageId: "typescript", text: "let a = 1;\n" }); // same text — no frame
      c.openDocument({ path: docPath, languageId: "typescript", text: "let a = 2;\n" }); // changed — didChange
      // Let the notifications flush to the child.
      await new Promise((r) => setTimeout(r, 250));
      const sent = methods(await readLog(ws.log));
      expect(sent).toEqual(["initialize", "initialized", "textDocument/didOpen", "textDocument/didChange"]);
      // The fake's hover embeds the didOpen COUNT — still 1 after the change.
      const hover = await c.request("textDocument/hover", {
        textDocument: { uri: pathToFileURL(docPath).href },
        position: { line: 0, character: 0 },
      });
      expect((hover as { contents: { value: string } }).contents.value).toContain("didOpens: 1");
    } finally {
      await ws.cleanup();
    }
  });

  it("close() runs the LSP ladder (shutdown → exit → EOF) and is bounded + idempotent", async () => {
    const ws = await makeWorkspace();
    try {
      const c = track(spawnClient(ws.root, ws.log));
      await c.initialize();
      const started = Date.now();
      await c.close();
      await c.close(); // no-op, not an error
      expect(Date.now() - started).toBeLessThan(5_000);
      const sent = methods(await readLog(ws.log));
      expect(sent).toEqual(["initialize", "initialized", "shutdown", "exit"]);
      // The fake is gone: its boot marker names a pid that no longer exists
      // (ESRCH). Give the reaped child a beat to be reaped by the OS.
      await new Promise((r) => setTimeout(r, 200));
      const pid = (await readLog(ws.log)).find((l) => l.boot !== undefined)?.boot;
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid as number, 0)).toThrow(/ESRCH|No such process/i);
      // After close, requests fail-closed.
      await expect(c.request("textDocument/hover", { textDocument: { uri: "file:///x.ts" }, position: { line: 0, character: 0 } }))
        .rejects.toThrow(/closed/i);
    } finally {
      await ws.cleanup();
    }
  });

  it.skipIf(process.platform === "win32")("close() is bounded even when the server traps SIGTERM (SIGKILL fallback)", async () => {
    const ws = await makeWorkspace();
    try {
      const c = track(spawnClient(ws.root, ws.log, { FAKE_TRAP_SIGTERM: "1" }, { shutdownGraceMs: 100, killGraceMs: 100 }));
      await c.initialize();
      const started = Date.now();
      await c.close(); // must resolve — never hang the CLI on shutdown
      expect(Date.now() - started).toBeLessThan(5_000);
      // SIGKILL was sent inside close(); the exit event lands shortly after.
      await new Promise((r) => setTimeout(r, 250));
      expect(c.childSignal).toBe("SIGKILL");
    } finally {
      await ws.cleanup();
    }
  });
});
