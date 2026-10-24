// T007 探针 4 — maxBuffer (4MB) 与 64KB 帽的交互
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient } from "@wudao/core";
import { runScriptWorkflow } from "/Users/qinyujie/xdev/github/wudao-harness-project/wudao-harness/packages/cli/src/workflow/engine.js";
import { journalFilePath, loadJournal, openJournal } from "/Users/qinyujie/xdev/github/wudao-harness-project/wudao-harness/packages/cli/src/workflow/journal.js";
import type { JsflowOptions } from "/Users/qinyujie/xdev/github/wudao-harness-project/wudao-harness/packages/cli/src/workflow/engine.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wf-audit-t007-4-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true, retryDelay: 100, maxRetries: 10 }); });

const noCallModel: ModelClient = {
  async generate(): Promise<AssistantMessage> { throw new Error("no model"); },
};
const buildOpts = (journalPath: string, extra: Partial<JsflowOptions> = {}): JsflowOptions => ({
  workspaceRoot: root, model: noCallModel, journal: openJournal(journalPath),
  workflowName: "buffer-cap", ...extra,
});
const p = (): string => journalFilePath(root, `wf-bc-${Math.random().toString(16).slice(2, 8)}`);

describe("T007 #4 maxBuffer vs 64KB 帽", () => {
  it("4-1: 输出 100KB（超 64KB 但低于 4MB）→ 应被 64KB 帽截断带标记", async () => {
    // 100KB 输出，超过 64KB 帽但低于 4MB maxBuffer
    const script = `const N = 100 * 1024; const c = await run('node', ['-e', 'process.stdout.write("A".repeat(' + N + '))']); return { len: c.stdout.length, head: c.stdout.slice(0, 20), tail: c.stdout.slice(-30), code: c.code };`;
    const journalPath = p();
    const r = await runScriptWorkflow(script, buildOpts(journalPath, { commandAllowlist: new Set(["node"]) }));
    console.log("[4-1] r.returnValue =", r.returnValue);
    expect(r.ok).toBe(true);
    const v = r.returnValue as { len: number; head: string; tail: string; code: number | undefined };
    // 输出是 100KB，帽后是 64KB + 截断标记
    expect(v.len).toBeGreaterThan(64 * 1024); // 64K + 截断标记
    expect(v.head).toBe("A".repeat(20)); // 头部是 A
    expect(v.tail).toContain("[输出超 64KB 截断]"); // 尾部含截断标记
    expect(v.code).toBe(0);

    // journal 也应被截断
    const loaded = loadJournal(journalPath);
    expect(loaded.cmds[0]?.stdout.length).toBeGreaterThan(64 * 1024);
    expect(loaded.cmds[0]?.stdout.endsWith("[输出超 64KB 截断]")).toBe(true);
  }, 20_000);

  it("4-2: 输出 1MB（帽之下但接近 maxBuffer 1/4）→ 应被截断", async () => {
    // 1MB 输出——低于 4MB maxBuffer 但超 64KB 帽
    const script = `const N = 1 * 1024 * 1024; const c = await run('node', ['-e', 'process.stdout.write("X".repeat(' + N + '))']); return { len: c.stdout.length, code: c.code, timedOut: c.timedOut };`;
    const r = await runScriptWorkflow(script, buildOpts(p(), { commandAllowlist: new Set(["node"]) }));
    console.log("[4-2] r.returnValue =", r.returnValue);
    expect(r.ok).toBe(true);
    const v = r.returnValue as { len: number; code: number | undefined; timedOut: boolean };
    expect(v.len).toBeGreaterThan(64 * 1024);
    expect(v.timedOut).toBe(false);
    expect(v.code).toBe(0);
  }, 30_000);

  it("4-3: 输出超 4MB（maxBuffer）→ execFile 报错 — 实际表现为？", async () => {
    // 5MB 输出，超 4MB maxBuffer
    // execFile 会报 ERR_CHILD_PROCESS_STDIO_MAXBUFFER
    const script = `const N = 5 * 1024 * 1024; const c = await run('node', ['-e', 'process.stdout.write("Y".repeat(' + N + '))']); return { code: c.code, timedOut: c.timedOut, spawnError: c.spawnError, len: c.stdout.length };`;
    const r = await runScriptWorkflow(script, buildOpts(p(), { commandAllowlist: new Set(["node"]) }));
    console.log("[4-3] r.returnValue =", r.returnValue);
    expect(r.ok).toBe(true);
    const v = r.returnValue as { code: number | undefined; timedOut: boolean; spawnError?: string; len: number };
    // execFile maxBuffer exceeded → error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
    // engine.ts: ecode = (err as { code?: unknown }).code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"（字符串）
    // typeof ecode === "number" ? ecode : err === null ? 0 : undefined
    // → code = undefined
    // code === undefined && err !== null → spawnError = err.message
    expect(v.code).toBeUndefined();
    expect(v.timedOut).toBe(false);
    expect(v.spawnError).toBeDefined();
    expect(v.spawnError).toContain("stdout maxBuffer"); // node 错误消息
  }, 30_000);

  it("4-4: 输出超 4MB → journal 落账 spawnError 含 maxBuffer 字段", async () => {
    const script = `const N = 5 * 1024 * 1024; const c = await run('node', ['-e', 'process.stdout.write("Y".repeat(' + N + '))']); return c.spawnError;`;
    const journalPath = p();
    const r = await runScriptWorkflow(script, buildOpts(journalPath, { commandAllowlist: new Set(["node"]) }));
    expect(r.ok).toBe(true);
    expect(String(r.returnValue)).toContain("stdout maxBuffer");

    const loaded = loadJournal(journalPath);
    expect(loaded.cmds.length).toBe(1);
    expect(loaded.cmds[0]?.spawnError).toBeDefined();
    expect(loaded.cmds[0]?.spawnError).toContain("stdout maxBuffer");
    expect(loaded.cmds[0]?.code).toBeUndefined();
    expect(loaded.cmds[0]?.timedOut).toBe(false);
    // T007 P0 修复后：EMAXBUFFER 的部分缓冲按数据保留（帽 64KB+标记）。
    expect(loaded.cmds[0]?.stdout.length).toBeLessThanOrEqual(64 * 1024 + 50);
    expect(loaded.cmds[0]!.stdout.startsWith("Y")).toBe(true);
    expect(loaded.cmds[0]?.stderr).toBe("");
  }, 30_000);

  it("4-5: stderr 超 4MB — maxBuffer 也对 stderr 生效", async () => {
    const script = `const N = 5 * 1024 * 1024; const c = await run('node', ['-e', 'process.stderr.write("Z".repeat(' + N + '))']); return { code: c.code, spawnError: c.spawnError, stderrLen: c.stderr.length };`;
    const r = await runScriptWorkflow(script, buildOpts(p(), { commandAllowlist: new Set(["node"]) }));
    console.log("[4-5] r.returnValue =", r.returnValue);
    expect(r.ok).toBe(true);
    const v = r.returnValue as { code: number | undefined; spawnError?: string; stderrLen: number };
    expect(v.code).toBeUndefined();
    expect(v.spawnError).toBeDefined();
    expect(v.spawnError).toContain("stderr maxBuffer");
  }, 30_000);

  it("4-6: 接近边界—4MB 略低 vs 略高", async () => {
    // 3.9MB 低于 4MB，但超 64KB 帽 → 截断到 64KB+标记
    const N = 3.9 * 1024 * 1024;
    const script = `const c = await run('node', ['-e', 'process.stdout.write("P".repeat(${Math.floor(N)}))']); return { len: c.stdout.length, hasMarker: c.stdout.endsWith("[输出超 64KB 截断]"), code: c.code };`;
    const r1 = await runScriptWorkflow(script, buildOpts(p(), { commandAllowlist: new Set(["node"]) }));
    console.log("[4-6a 3.9MB] returnValue =", r1.returnValue);
    expect(r1.ok).toBe(true);
    expect((r1.returnValue as { len: number; hasMarker: boolean; code: number | undefined }).hasMarker).toBe(true);
    expect((r1.returnValue as { code: number | undefined }).code).toBe(0);
  }, 30_000);
});
