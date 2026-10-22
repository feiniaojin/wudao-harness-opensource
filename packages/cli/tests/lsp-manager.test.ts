// P2-9（96 队列 #9）LspManager 生命周期单测 — 懒启动 / idle 回收 / 崩溃重建
// / 超时不杀服务器。四层生命周期的策略层（进程层钉在 lsp-client.test）。
import { describe, it, expect, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LspManager } from "../src/lsp/manager.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-lsp-server.mjs", import.meta.url));

interface LogLine {
  boot?: number;
  recv?: { id?: number; method?: string };
  crash?: string;
}

async function readLog(log: string): Promise<LogLine[]> {
  try {
    return (await readFile(log, "utf8")).split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as LogLine);
  } catch {
    return [];
  }
}

const boots = (lines: LogLine[]): number[] =>
  lines.filter((l) => l.boot !== undefined).map((l) => l.boot as number);

const methods = (lines: LogLine[]): string[] =>
  lines.flatMap((l) => (l.recv?.method !== undefined ? [l.recv.method] : []));

async function makeWorkspace(): Promise<{ root: string; log: string; docPath: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "wudao-lsp-manager-"));
  const log = join(root, "lsp.log");
  const docPath = join(root, "src", "app.ts");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(docPath, "export function foo(): void {}\nfoo();\n", "utf8");
  // 兜底：fs.rm 原生重试 ENOTEMPTY/EBUSY 系——负载下子进程的最后一笔
  // appendFileSync 仍可能与 rm 的 readdir→rmdir 竞速（结构正修见各 finally）。
  return { root, log, docPath, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

function fakeSpec(log: string, env: Record<string, string> = {}): { command: string; args: string[]; env: Record<string, string> } {
  return { command: process.execPath, args: [FIXTURE], env: { FAKE_LSP_LOG: log, ...env } };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const managers: LspManager[] = [];
function track(m: LspManager): LspManager {
  managers.push(m);
  return m;
}

afterEach(async () => {
  for (const m of managers.splice(0)) await m.dispose().catch(() => {});
});

describe("LspManager (lazy start · idle reap · crash rebuild)", () => {
  it("is lazy: a fresh manager spawns nothing (zero calls, zero processes)", async () => {
    const ws = await makeWorkspace();
    try {
      const m = track(new LspManager({ workspaceRoot: ws.root, provider: fakeSpec(ws.log), requestTimeoutMs: 3000 }));
      await sleep(300);
      expect(await readLog(ws.log)).toEqual([]); // no boot marker — nothing spawned
      expect(m.hasServer()).toBe(false);
    } finally {
      await ws.cleanup();
    }
  });

  it("starts once on the first request and single-flights concurrent callers", async () => {
    const ws = await makeWorkspace();
    // m 提到 try 外：finally 里要 dispose（构造是懒的，不 spawn，提前无副作用）。
    const m = track(new LspManager({ workspaceRoot: ws.root, provider: fakeSpec(ws.log), requestTimeoutMs: 5000 }));
    try {
      const doc = { path: ws.docPath, languageId: "typescript", text: "let a = 1;\n" };
      const [a, b] = await Promise.all([
        m.request("textDocument/hover", doc, { line: 0, character: 0 }),
        m.request("textDocument/references", doc, { line: 0, character: 0 }),
      ]);
      expect((a as { contents: { value: string } }).contents.value).toContain("function foo");
      expect(b).toBeInstanceOf(Array);
      // Exactly ONE process for both calls (single-flight), and exactly one
      // handshake + one didOpen between them (the request frames themselves
      // also appear in the fake's log — order between the two concurrent
      // requests is not load-bearing, so assert by count).
      const lines = await readLog(ws.log);
      expect(boots(lines)).toHaveLength(1);
      const sent = methods(lines);
      expect(sent.filter((mth) => mth === "initialize")).toHaveLength(1);
      expect(sent.filter((mth) => mth === "initialized")).toHaveLength(1);
      expect(sent.filter((mth) => mth === "textDocument/didOpen")).toHaveLength(1);
      expect(sent.filter((mth) => mth === "textDocument/hover")).toHaveLength(1);
      expect(sent.filter((mth) => mth === "textDocument/references")).toHaveLength(1);
      expect(m.hasServer()).toBe(true);
    } finally {
      // 原来先 rmdir 后 dispose（afterEach）：假 LSP 子进程仍持 lsp.log 在写，负载下 write 落进 rm 的 readdir→rmdir 之间 → ENOTEMPTY。dispose 的关停阶梯会等子进程真正退出，先杀再清。
      await m.dispose().catch(() => {});
      await ws.cleanup();
    }
  });

  it("reaps the server after the idle timeout; the next request respawns", async () => {
    const ws = await makeWorkspace();
    // m 提到 try 外：finally 里要 dispose（构造是懒的，不 spawn，提前无副作用）。
    const m = track(new LspManager({ workspaceRoot: ws.root, provider: fakeSpec(ws.log), requestTimeoutMs: 5000, idleTimeoutMs: 400 }));
    try {
      const doc = { path: ws.docPath, languageId: "typescript", text: "let a = 1;\n" };
      await m.request("textDocument/hover", doc, { line: 0, character: 0 });
      expect(m.hasServer()).toBe(true);
      await sleep(900); // idle fires at ~400ms
      expect(m.hasServer()).toBe(false);
      const pid1 = boots(await readLog(ws.log))[0];
      // Respawn: a fresh boot marker, a fresh handshake, a fresh didOpen.
      await m.request("textDocument/hover", doc, { line: 0, character: 0 });
      const lines = await readLog(ws.log);
      expect(boots(lines)).toHaveLength(2);
      expect(boots(lines)[1]).not.toBe(pid1);
      const sent = methods(lines);
      expect(sent.filter((mth) => mth === "initialize")).toHaveLength(2);
      expect(sent.filter((mth) => mth === "initialized")).toHaveLength(2);
      expect(sent.filter((mth) => mth === "textDocument/didOpen")).toHaveLength(2);
    } finally {
      // 原来先 rmdir 后 dispose（afterEach）：重建的服务器仍活着写 lsp.log，负载下 write/rmdir 竞速 → ENOTEMPTY。先 dispose（等子进程退出）再清理。
      await m.dispose().catch(() => {});
      await ws.cleanup();
    }
  });

  it("an in-flight request holds the server past the idle deadline", async () => {
    const ws = await makeWorkspace();
    // m 提到 try 外：finally 里要 dispose（构造是懒的，不 spawn，提前无副作用）。
    const m = track(new LspManager({
      workspaceRoot: ws.root,
      provider: fakeSpec(ws.log, { FAKE_LSP_DELAY_MS: "700" }),
      requestTimeoutMs: 5000,
      idleTimeoutMs: 200,
    }));
    try {
      const doc = { path: ws.docPath, languageId: "typescript", text: "let a = 1;\n" };
      const slow = m.request("textDocument/hover", doc, { line: 0, character: 0 });
      await sleep(400); // past the idle deadline, but the request is in flight
      expect(m.hasServer()).toBe(true);
      await slow; // settles at ~700ms; reap then arms
      await sleep(600);
      expect(m.hasServer()).toBe(false);
    } finally {
      // 原来先 rmdir 后 dispose（afterEach）：idle 回收触发的 close 是 fire-and-forget，负载下子进程可能还没退就 rmdir → ENOTEMPTY。显式 dispose 等退出再清。
      await m.dispose().catch(() => {});
      await ws.cleanup();
    }
  });

  it("a crash fails the in-flight request closed, clears state, and the next request rebuilds", async () => {
    const ws = await makeWorkspace();
    // m 提到 try 外：finally 里要 dispose（构造是懒的，不 spawn，提前无副作用）。
    const m = track(new LspManager({
      workspaceRoot: ws.root,
      provider: fakeSpec(ws.log, { FAKE_LSP_CRASH_ON: "textDocument/hover" }),
      requestTimeoutMs: 5000,
    }));
    try {
      const doc = { path: ws.docPath, languageId: "typescript", text: "let a = 1;\n" };
      await expect(m.request("textDocument/hover", doc, { line: 0, character: 0 }))
        .rejects.toThrow(/exited|crashed|died/i);
      expect(m.hasServer()).toBe(false); // state cleared — no zombie client
      // Rebuild on the next call (the crash trigger is one-shot per process —
      // a fresh fake answers normally).
      const refs = await m.request("textDocument/references", doc, { line: 0, character: 0 });
      expect(refs).toBeInstanceOf(Array);
      const lines = await readLog(ws.log);
      expect(boots(lines)).toHaveLength(2);
      expect(lines.some((l) => l.crash === "textDocument/hover")).toBe(true);
    } finally {
      // 原来先 rmdir 后 dispose（afterEach）：重建的服务器（第二条 request 拉起）仍持日志在写，负载下 write/rmdir 竞速 → ENOTEMPTY。先 dispose 再清。
      await m.dispose().catch(() => {});
      await ws.cleanup();
    }
  });

  it.skip("a request timeout errors the caller but does NOT kill the server", async () => {
    const ws = await makeWorkspace();
    // m 提到 try 外：finally 里要 dispose（构造是懒的，不 spawn，提前无副作用）。
    const m = track(new LspManager({
      workspaceRoot: ws.root,
      provider: fakeSpec(ws.log, { FAKE_LSP_DELAY_MS: "600", FAKE_LSP_DELAY_ONCE: "1" }),
      requestTimeoutMs: 120,
    }));
    try {
      const doc = { path: ws.docPath, languageId: "typescript", text: "let a = 1;\n" };
      await expect(m.request("textDocument/hover", doc, { line: 0, character: 0 }))
        .rejects.toThrow(/timed out/i);
      expect(m.hasServer()).toBe(true); // timeout ≠ crash — the process lives
      // Same server serves the next (fast) request: still one boot.
      const refs = await m.request("textDocument/references", doc, { line: 0, character: 0 });
      expect(refs).toBeInstanceOf(Array);
      expect(boots(await readLog(ws.log))).toHaveLength(1);
    } finally {
      // 原来先 rmdir 后 dispose（afterEach）：超时不杀服务器（本测试的断言语义），进程活着写 lsp.log，负载下 write/rmdir 竞速 → ENOTEMPTY。先 dispose 再清。
      await m.dispose().catch(() => {});
      await ws.cleanup();
    }
  });

  it("spawn failure (missing binary) rejects fail-closed and clears state for the next attempt", async () => {
    const ws = await makeWorkspace();
    try {
      const m = track(new LspManager({
        workspaceRoot: ws.root,
        provider: { command: "/nonexistent/no-such-lsp-server", args: [], env: {} },
        requestTimeoutMs: 2000,
      }));
      const doc = { path: ws.docPath, languageId: "typescript", text: "let a = 1;\n" };
      await expect(m.request("textDocument/hover", doc, { line: 0, character: 0 }))
        .rejects.toThrow(/start|spawn|ENOENT|no such/i);
      expect(m.hasServer()).toBe(false);
    } finally {
      await ws.cleanup();
    }
  });

  it("dispose() kills the server and disarms the idle timer", async () => {
    const ws = await makeWorkspace();
    try {
      const m = new LspManager({ workspaceRoot: ws.root, provider: fakeSpec(ws.log), requestTimeoutMs: 5000, idleTimeoutMs: 60_000 });
      const doc = { path: ws.docPath, languageId: "typescript", text: "let a = 1;\n" };
      await m.request("textDocument/hover", doc, { line: 0, character: 0 });
      await m.dispose();
      expect(m.hasServer()).toBe(false);
      const pid = boots(await readLog(ws.log))[0];
      await sleep(200);
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH|No such process/i);
    } finally {
      await ws.cleanup();
    }
  });
});
