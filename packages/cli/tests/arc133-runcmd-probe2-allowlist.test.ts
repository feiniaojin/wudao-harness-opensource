// T007 探针 2 — 允许清单与重放的交互（T007 P1 修复后语义重写）
// 原审计发现：授予态不进身份/键——首跑拒绝落账后，resume 授予了命令仍重放
// 命中旧 spawnError 拒绝（"不诚实语义"）。修复：授予位进 cmdKey + allowHash
// 进身份 → 授予变化=键漂移+身份不同（编辑语义：截断重跑）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient } from "@wudao/core";
import { runScriptWorkflow } from "../src/workflow/engine.js";
import { journalFilePath, loadJournal, openJournal, workflowIdentity } from "../src/workflow/journal.js";
import type { JsflowOptions } from "../src/workflow/engine.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wf-t007-allow-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true, retryDelay: 100, maxRetries: 10 }); });

const noCallModel: ModelClient = {
  async generate(): Promise<AssistantMessage> { throw new Error("no model"); },
};
const buildOpts = (journalPath: string, extra: Partial<JsflowOptions> = {}): JsflowOptions => ({
  workspaceRoot: root, model: noCallModel, journal: openJournal(journalPath),
  workflowName: "allowlist-replay", ...extra,
});
const p = (): string => journalFilePath(root, `wf-allow-${Math.random().toString(16).slice(2, 8)}`);

const SCRIPT = "const c = await run('node', ['-e', 'console.log(42)']); return Number(c.stdout.trim());";

describe("T007 #2 允许清单与重放（P1 修复后）", () => {
  it("2a: 首跑拒绝 → resume 授予 → 真执行返回 42（绝不命中旧拒绝）", async () => {
    const journalPath = p();
    const id1 = workflowIdentity(SCRIPT, undefined); // 首跑：无授予
    const r1 = await runScriptWorkflow(SCRIPT, buildOpts(journalPath, { identity: id1 }));
    expect(r1.returnValue).toBe(0); // 拒绝：stdout 空 → Number("")=0
    const loaded = loadJournal(journalPath);
    expect(loaded.cmds[0]?.spawnError).toContain("not granted");

    const r2 = await runScriptWorkflow(
      SCRIPT,
      buildOpts(journalPath, {
        commandAllowlist: new Set(["node"]),
        // 真实 CLI 形：resume 的身份带新授予面（allowHash 不同 → 编辑语义）。
        identity: workflowIdentity(SCRIPT, undefined, ["node"]),
        resumeIdentity: id1,
        resumeTasks: loaded.tasks, resumeCmds: loaded.cmds,
      }),
    );
    expect(r2.ok).toBe(true);
    expect(r2.returnValue).toBe(42); // 命令现在允许——真执行
  });

  it("2b: 首跑授予（42）→ resume 收回授予 → 拿到拒绝（绝不重放旧成功）", async () => {
    const journalPath = p();
    const id1 = workflowIdentity(SCRIPT, undefined, ["node"]); // 首跑带授予面
    const r1 = await runScriptWorkflow(SCRIPT, buildOpts(journalPath, { commandAllowlist: new Set(["node"]), identity: id1 }));
    expect(r1.returnValue).toBe(42);
    const loaded = loadJournal(journalPath);

    const r2 = await runScriptWorkflow(
      SCRIPT,
      buildOpts(journalPath, {
        identity: workflowIdentity(SCRIPT, undefined), // 收回授予：身份不同
        resumeIdentity: id1,
        resumeTasks: loaded.tasks, resumeCmds: loaded.cmds,
      }),
    );
    expect(r2.ok).toBe(true);
    expect(r2.returnValue).toBe(0); // 拒绝——对称的不诚实已修
  });

  it("2c: 授予面变化（[node]→[]）=身份变化 → 截断重跑（编辑语义，不触发纯度）", async () => {
    const journalPath = p();
    const id1 = workflowIdentity(SCRIPT, undefined, ["node"]);
    const r1 = await runScriptWorkflow(SCRIPT, buildOpts(journalPath, { commandAllowlist: new Set(["node"]), identity: id1 }));
    expect(r1.returnValue).toBe(42);
    const loaded = loadJournal(journalPath);
    const r2 = await runScriptWorkflow(
      SCRIPT,
      buildOpts(journalPath, {
        identity: workflowIdentity(SCRIPT, undefined),
        resumeIdentity: id1,
        resumeTasks: loaded.tasks, resumeCmds: loaded.cmds,
      }),
    );
    expect(r2.ok).toBe(true);
    expect(r2.returnValue).toBe(0);
    expect(r2.failure?.category).not.toBe("purity-violation"); // 换授予是合法操作
  });

  it("身份含授予面：同授予排序无关（--allow-cmd 顺序不影响身份）", () => {
    const a = workflowIdentity(SCRIPT, undefined, ["node", "git"]);
    const b = workflowIdentity(SCRIPT, undefined, ["git", "node"]);
    expect(a).toEqual(b);
    expect(a.allowHash).not.toBe(workflowIdentity(SCRIPT, undefined, ["node"]).allowHash);
  });
});
