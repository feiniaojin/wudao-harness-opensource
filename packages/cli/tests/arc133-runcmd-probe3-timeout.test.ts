// T007 探针 3 — 超时边界竞态（修正边界）
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient } from "@wudao/core";
import { runScriptWorkflow } from "external/packages/cli/src/workflow/engine.js";
import { journalFilePath, loadJournal, openJournal } from "external/packages/cli/src/workflow/journal.js";
import type { JsflowOptions } from "external/packages/cli/src/workflow/engine.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wf-audit-t007-3-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true, retryDelay: 100, maxRetries: 10 }); });

const noCallModel: ModelClient = {
  async generate(): Promise<AssistantMessage> { throw new Error("no model"); },
};
const buildOpts = (journalPath: string, extra: Partial<JsflowOptions> = {}): JsflowOptions => ({
  workspaceRoot: root, model: noCallModel, journal: openJournal(journalPath),
  workflowName: "timeout-edge", ...extra,
});
const p = (): string => journalFilePath(root, `wf-to-${Math.random().toString(16).slice(2, 8)}`);

describe("T007 #3 超时边界竞态", () => {
  it("3-1: 200ms 进程 / 1500ms 超时 — 进程在超时前完成（基线）", async () => {
    const script = `const c = await run('node', ['-e', 'setTimeout(()=>console.log("DONE"),200)'], { timeoutMs: 1500 }); return { code: c.code, timedOut: c.timedOut, stdout: c.stdout.trim() };`;
    const r = await runScriptWorkflow(script, buildOpts(p(), { commandAllowlist: new Set(["node"]) }));
    console.log("[3-1] r.returnValue =", r.returnValue);
    expect(r.ok).toBe(true);
    expect(r.returnValue).toEqual({ code: 0, timedOut: false, stdout: "DONE" });
  }, 10_000);

  it("3-2: 1100ms 进程 / 1000ms 超时 — 必被杀", async () => {
    const script = `const c = await run('node', ['-e', 'setTimeout(()=>console.log("NEVER"),1100)'], { timeoutMs: 1000 }); return { code: c.code, timedOut: c.timedOut };`;
    const r = await runScriptWorkflow(script, buildOpts(p(), { commandAllowlist: new Set(["node"]) }));
    expect(r.ok).toBe(true);
    expect(r.returnValue).toEqual({ code: undefined, timedOut: true });
  }, 10_000);

  it("3-3: 超时下 stdout 部分保留 + stderr 保留", async () => {
    const script = `const c = await run('node', ['-e', 'console.log("OUT");console.error("ERR");setTimeout(()=>{},5000)'], { timeoutMs: 500 }); return { code: c.code, timedOut: c.timedOut, stdout: c.stdout.trim(), stderr: c.stderr.trim() };`;
    const r = await runScriptWorkflow(script, buildOpts(p(), { commandAllowlist: new Set(["node"]) }));
    console.log("[3-3] r.returnValue =", r.returnValue);
    expect(r.returnValue).toEqual({ code: undefined, timedOut: true, stdout: "OUT", stderr: "ERR" });
  }, 10_000);

  it("3-4: 超时落账：cmd-finished 含 timedOut=true, code=undefined", async () => {
    const script = `const c = await run('node', ['-e', 'setTimeout(()=>{},1100)'], { timeoutMs: 500 }); return c.timedOut;`;
    const journalPath = p();
    const r1 = await runScriptWorkflow(script, buildOpts(journalPath, { commandAllowlist: new Set(["node"]) }));
    expect(r1.ok).toBe(true);
    expect(r1.returnValue).toBe(true);
    const loaded = loadJournal(journalPath);
    expect(loaded.cmds.length).toBe(1);
    expect(loaded.cmds[0]?.timedOut).toBe(true);
    expect(loaded.cmds[0]?.code).toBeUndefined();
    expect(loaded.cmds[0]?.stdout).toBe("");
    expect(loaded.cmds[0]?.stderr).toBe("");
  }, 10_000);

  it("3-5: 超时记录可重放（同身份 → cmd-replayed + 仍超时）", async () => {
    const script = `const c = await run('node', ['-e', 'setTimeout(()=>{},1100)'], { timeoutMs: 500 }); return c.timedOut;`;
    const identity = workflowIdentity_();
    const journalPath = p();
    const r1 = await runScriptWorkflow(script, buildOpts(journalPath, { commandAllowlist: new Set(["node"]), identity }));
    expect(r1.returnValue).toBe(true);

    const loaded = loadJournal(journalPath);
    // resume：应该重放命中 cmd-finished（不重新跑），returnValue 仍是 true
    const r2 = await runScriptWorkflow(
      script,
      buildOpts(journalPath, {
        commandAllowlist: new Set(["node"]),
        identity, resumeIdentity: identity,
        resumeTasks: loaded.tasks, resumeCmds: loaded.cmds,
      }),
    );
    console.log("[3-5] r2.returnValue =", r2.returnValue, "(期望 true 表示重放命中)");
    expect(r2.ok).toBe(true);
    expect(r2.returnValue).toBe(true);
  }, 10_000);

  it("3-6: SIGKILL 表现：超时被杀后 cmd-replayed 是否也报告 timedOut=true", async () => {
    // 由于 3-1 验证过 node 启动开销，1000ms 不可达
    // 让我们看 SIGKILL 在 journal 中怎样记录
    const script = `const c = await run('node', ['-e', 'setTimeout(()=>{},1100)'], { timeoutMs: 500 }); return { timedOut: c.timedOut, code: c.code, stdout: c.stdout };`;
    const identity = workflowIdentity_();
    const journalPath = p();
    const r1 = await runScriptWorkflow(script, buildOpts(journalPath, { commandAllowlist: new Set(["node"]), identity }));
    const loaded = loadJournal(journalPath);
    // killSignal: SIGKILL 意味着被强制杀，无 cleanup 机会
    // 但 execFile 的 killed 标志仍然为 true，spawn 应当被关闭
    // 验证 cmd-finished.timedOut === true
    expect(loaded.cmds[0]?.timedOut).toBe(true);
    expect(loaded.cmds[0]?.code).toBeUndefined();
    console.log("[3-6] cmd-finished:", { timedOut: loaded.cmds[0]?.timedOut, code: loaded.cmds[0]?.code, stdout: loaded.cmds[0]?.stdout.slice(0, 30) });
  }, 10_000);

  it("3-7: 边界—500ms 进程 / 1000ms 超时（基础 sanity）", async () => {
    const script = `const c = await run('node', ['-e', 'setTimeout(()=>console.log("OK"),500)'], { timeoutMs: 1000 }); return { code: c.code, timedOut: c.timedOut, stdout: c.stdout.trim() };`;
    const r = await runScriptWorkflow(script, buildOpts(p(), { commandAllowlist: new Set(["node"]) }));
    console.log("[3-7] r.returnValue =", r.returnValue);
    expect(r.ok).toBe(true);
    expect(r.returnValue).toEqual({ code: 0, timedOut: false, stdout: "OK" });
  }, 10_000);
});

function workflowIdentity_(): { scriptHash: string; argsHash: string } {
  // 简化版 identity——只用于 setup
  return { scriptHash: "test", argsHash: "test" };
}
