// T007 探针 4b — capOutput 仅落账前截断，调用方拿到的 stdout 是原始未截断
// 重放时用户拿到的就是 journal 里的 64KB 截断版——首跑与 resume 不一致
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient } from "@wudao-org/core";
import { runScriptWorkflow } from "../src/workflow/engine.js";
import { journalFilePath, loadJournal, openJournal, workflowIdentity } from "../src/workflow/journal.js";
import type { JsflowOptions } from "../src/workflow/engine.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wf-audit-t007-4b-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true, retryDelay: 100, maxRetries: 10 }); });

const noCallModel: ModelClient = {
  async generate(): Promise<AssistantMessage> { throw new Error("no model"); },
};
const buildOpts = (journalPath: string, extra: Partial<JsflowOptions> = {}): JsflowOptions => ({
  workspaceRoot: root, model: noCallModel, journal: openJournal(journalPath),
  workflowName: "cap-mismatch", ...extra,
});
const p = (): string => journalFilePath(root, `wf-cm-${Math.random().toString(16).slice(2, 8)}`);

describe("T007 #4b capOutput 行为", () => {
  it("4b-1: 100KB 输出 — 调用方拿到的 stdout 是 100KB（未截断）", async () => {
    const script = `const c = await run('node', ['-e', 'process.stdout.write("A".repeat(100*1024))']); return { len: c.stdout.length, hasMarker: c.stdout.includes("[输出超 64KB 截断]") };`;
    const r = await runScriptWorkflow(script, buildOpts(p(), { commandAllowlist: new Set(["node"]) }));
    console.log("[4b-1] r.returnValue =", r.returnValue);
    const rv = r.returnValue as { len: number; hasMarker: boolean };
    // T007 P0 修复后：调用方与 journal 同一份字节——64KB+截断标记。
    expect(rv.len).toBe(64 * 1024 + "[输出超 64KB 截断]".length + 1);
    expect(rv.hasMarker).toBe(true);
  });

  it("4b-2: 100KB 输出 — journal 落账被截断到 64KB+标记", async () => {
    const script = `await run('node', ['-e', 'process.stdout.write("A".repeat(100*1024))']); return 'ok';`;
    const journalPath = p();
    await runScriptWorkflow(script, buildOpts(journalPath, { commandAllowlist: new Set(["node"]) }));
    const loaded = loadJournal(journalPath);
    console.log("[4b-2] journal stdout.length:", loaded.cmds[0]?.stdout.length);
    console.log("[4b-2] journal stdout tail:", loaded.cmds[0]?.stdout.slice(-30));
    expect(loaded.cmds[0]?.stdout.length).toBeLessThanOrEqual(64 * 1024 + 100); // 64KB+标记
    expect(loaded.cmds[0]?.stdout).toContain("[输出超 64KB 截断]");
  });

  it("4b-3: 关键 — 首跑调用方拿到 100KB，resume 调用方拿到 64KB 截断版（重放不一致！）", async () => {
    const script = `const c = await run('node', ['-e', 'process.stdout.write("A".repeat(100*1024))']); return { len: c.stdout.length };`;
    const identity = workflowIdentity(script, undefined);
    const journalPath = p();
    const r1 = await runScriptWorkflow(script, buildOpts(journalPath, { commandAllowlist: new Set(["node"]), identity }));
    const v1 = r1.returnValue as { len: number };
    console.log("[4b-3] 首跑 r1.len =", v1.len);

    const loaded = loadJournal(journalPath);
    const r2 = await runScriptWorkflow(
      script,
      buildOpts(journalPath, {
        commandAllowlist: new Set(["node"]),
        identity, resumeIdentity: identity,
        resumeTasks: loaded.tasks, resumeCmds: loaded.cmds,
      }),
    );
    const v2 = r2.returnValue as { len: number };
    console.log("[4b-3] resume r2.len =", v2.len);
    // T007 P0 修复后：首跑与 resume 调用方字节相等（重放 soundness 恢复）。
    expect(v1.len).toBe(64 * 1024 + "[输出超 64KB 截断]".length + 1);
    expect(v2.len).toBe(v1.len);
    console.log("[4b-3] 修复生效：首跑", v1.len, "字节 = resume", v2.len, "字节");
  });
});
