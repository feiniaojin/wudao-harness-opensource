// T007 探针 2c — 纯度武装下 cmdKey 漂移（同身份 + 篡改 journal）
// 这与 reference test 里的"同身份 + 篡改 cmd key"完全对照——验证纯度武装正确工作
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient } from "@wudao-org/core";
import { runScriptWorkflow } from "~/xdev/github/wudao-harness-project/wudao-harness/packages/cli/src/workflow/engine.js";
import { journalFilePath, loadJournal, openJournal, workflowIdentity } from "~/xdev/github/wudao-harness-project/wudao-harness/packages/cli/src/workflow/journal.js";
import type { JsflowOptions } from "~/xdev/github/wudao-harness-project/wudao-harness/packages/cli/src/workflow/engine.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wf-audit-t007-2c-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true, retryDelay: 100, maxRetries: 10 }); });

const noCallModel: ModelClient = {
  async generate(): Promise<AssistantMessage> { throw new Error("no model"); },
};
const buildOpts = (journalPath: string, extra: Partial<JsflowOptions> = {}): JsflowOptions => ({
  workspaceRoot: root, model: noCallModel, journal: openJournal(journalPath),
  workflowName: "purity-cmd-drift", ...extra,
});
const p = (): string => journalFilePath(root, `wf-pd-${Math.random().toString(16).slice(2, 8)}`);

describe("T007 #2c cmdKey 漂移纯度武装", () => {
  it("2c-1: 篡改 cmd key（同身份）→ 纯度违例", async () => {
    // 1 cmd
    const script = `const c = await run('node', ['-e', 'console.log(42)']); return Number(c.stdout.trim());`;
    const identity = workflowIdentity(script, undefined);
    const journalPath = p();
    const r1 = await runScriptWorkflow(script, buildOpts(journalPath, { commandAllowlist: new Set(["node"]), identity }));
    expect(r1.returnValue).toBe(42);

    const loaded = loadJournal(journalPath);
    // 篡改 cmd 的 key
    const forged = loaded.cmds.map((c) => ({ ...c, key: "c:" + "0".repeat(64) }));
    const r2 = await runScriptWorkflow(
      script,
      buildOpts(journalPath, {
        commandAllowlist: new Set(["node"]),
        identity, resumeIdentity: identity,
        resumeTasks: loaded.tasks, resumeCmds: forged,
      }),
    );
    console.log("[2c-1] r2.ok =", r2.ok, "failure =", r2.failure);
    expect(r2.ok).toBe(false);
    expect(r2.failure?.category).toBe("purity-violation");
  });

  it("2c-2: 同身份 + 多 cmd + 篡改其中一个 → 纯度违例（不应截断到对位）", async () => {
    // 3 cmd
    const script = `
await run('node', ['-e', 'console.log("A")']);
await run('node', ['-e', 'console.log("B")']);
await run('node', ['-e', 'console.log("C")']);
return 'ok';
`;
    const identity = workflowIdentity(script, undefined);
    const journalPath = p();
    const r1 = await runScriptWorkflow(script, buildOpts(journalPath, { commandAllowlist: new Set(["node"]), identity }));
    expect(r1.returnValue).toBe("ok");

    const loaded = loadJournal(journalPath);
    expect(loaded.cmds.length).toBe(3);

    // 篡改 seq=1 的 cmd key
    const forged = loaded.cmds.map((c) => c.seq === 1 ? { ...c, key: "c:" + "f".repeat(64) } : c);
    const r2 = await runScriptWorkflow(
      script,
      buildOpts(journalPath, {
        commandAllowlist: new Set(["node"]),
        identity, resumeIdentity: identity,
        resumeTasks: loaded.tasks, resumeCmds: forged,
      }),
    );
    console.log("[2c-2] r2.ok =", r2.ok, "failure =", r2.failure);
    // 期望 purity-violation（不应静默截断）
    expect(r2.ok).toBe(false);
    expect(r2.failure?.category).toBe("purity-violation");
  });

  it("2c-3: 同身份 + cmd 数增加（journal 只有 2 cmd，脚本要 3）→ 应当？", async () => {
    // journal 只有 2 cmd，resume 时脚本跑了 3 个 run()——第 3 个会怎样？
    // 思路：脚本字面 + workflow args 都不变（同身份），但 run() 数量变了——脚本字面变了 → 异身份
    // 所以这个测试走不通同身份路径。改用"多 cmd 但只给 1 个 resumeCmds"
    const script = `
await run('node', ['-e', 'console.log(1)']);
await run('node', ['-e', 'console.log(2)']);
return 'ok';
`;
    const identity = workflowIdentity(script, undefined);
    const journalPath = p();
    const r1 = await runScriptWorkflow(script, buildOpts(journalPath, { commandAllowlist: new Set(["node"]), identity }));
    expect(r1.returnValue).toBe("ok");

    const loaded = loadJournal(journalPath);
    // 只给 1 个 cmd——第二个 cursor 会越界
    const partialCmds = loaded.cmds.slice(0, 1);
    const r2 = await runScriptWorkflow(
      script,
      buildOpts(journalPath, {
        commandAllowlist: new Set(["node"]),
        identity, resumeIdentity: identity,
        resumeTasks: loaded.tasks, resumeCmds: partialCmds,
      }),
    );
    console.log("[2c-3] r2.ok =", r2.ok, "failure =", r2.failure, "returnValue=", r2.returnValue);
    // 期望：第 1 个命中，第 2 个 entry=undefined + failureGap=false → 走 else 分支截断？
    // 看代码：if (entry !== undefined && !failureGap && entry.type === "cmd-finished" && entry.key === key)
    // entry === undefined → 这个分支不命中
    // if (entry !== undefined && !failureGap && entry.key !== key && shared.purityArmed) → entry 是 undefined
    // if (entry !== undefined && !failureGap) → entry 是 undefined
    // 所以 invalidate 路径不会走——会落到"未拒绝"的允许清单检查 → 实际执行（落账新 cmd-finished）
    expect(r2.ok).toBe(true);
  });
});
