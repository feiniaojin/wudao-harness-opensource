// T007 探针 9 — cmd key 漂移 + purity 武装 vs 异身份 编辑
// 验证：同身份 + cmd key 漂移 → 纯度违例
//        异身份 + cmd key 漂移 → 编辑语义截断重跑
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient } from "@wudao/core";
import { runScriptWorkflow } from "~/xdev/github/wudao-harness-project/wudao-harness/packages/cli/src/workflow/engine.js";
import { journalFilePath, loadJournal, openJournal, workflowIdentity } from "~/xdev/github/wudao-harness-project/wudao-harness/packages/cli/src/workflow/journal.js";
import type { JsflowOptions } from "~/xdev/github/wudao-harness-project/wudao-harness/packages/cli/src/workflow/engine.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wf-audit-t007-9-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true, retryDelay: 100, maxRetries: 10 }); });

const noCallModel: ModelClient = {
  async generate(): Promise<AssistantMessage> { throw new Error("no model"); },
};
const buildOpts = (journalPath: string, extra: Partial<JsflowOptions> = {}): JsflowOptions => ({
  workspaceRoot: root, model: noCallModel, journal: openJournal(journalPath),
  workflowName: "stale-truncation", ...extra,
});
const p = (): string => journalFilePath(root, `wf-st-${Math.random().toString(16).slice(2, 8)}`);

describe("T007 #9 cmd 漂移语义", () => {
  it("9-1: 同身份 + cmd 篡改 key → purity-violation", async () => {
    const script = `const c = await run('node', ['-e', 'console.log(1)']); return c.stdout.trim();`;
    const identity = workflowIdentity(script, undefined);
    const journalPath = p();
    await runScriptWorkflow(script, buildOpts(journalPath, { commandAllowlist: new Set(["node"]), identity }));
    const loaded = loadJournal(journalPath);
    const forged = loaded.cmds.map((c) => ({ ...c, key: "c:" + "0".repeat(64) }));
    const r2 = await runScriptWorkflow(
      script,
      buildOpts(journalPath, {
        commandAllowlist: new Set(["node"]),
        identity, resumeIdentity: identity,
        resumeTasks: loaded.tasks, resumeCmds: forged,
      }),
    );
    expect(r2.ok).toBe(false);
    expect(r2.failure?.category).toBe("purity-violation");
    // message 应含 "in workflow" 子串？顶层 run 应无
    console.log("[9-1] message:", r2.failure?.message);
  });

  it("9-2: 异身份 + cmd 篡改 → 编辑语义（截断重跑）", async () => {
    const script1 = `const c = await run('node', ['-e', 'console.log(1)']); return c.stdout.trim();`;
    const script2 = `const c = await run('node', ['-e', 'console.log(2)']); return c.stdout.trim();`;
    const journalPath = p();
    await runScriptWorkflow(script1, buildOpts(journalPath, { commandAllowlist: new Set(["node"]), identity: workflowIdentity(script1, undefined) }));
    const loaded = loadJournal(journalPath);
    const r2 = await runScriptWorkflow(
      script2,
      buildOpts(journalPath, {
        commandAllowlist: new Set(["node"]),
        identity: workflowIdentity(script2, undefined),
        resumeIdentity: workflowIdentity(script1, undefined),
        resumeTasks: loaded.tasks, resumeCmds: loaded.cmds,
      }),
    );
    // 异身份 → 编辑语义 → 截断重跑 → returnValue = "2"
    expect(r2.ok).toBe(true);
    expect(r2.returnValue).toBe("2");
  });

  it("9-3: 同身份 + 多 cmd + 篡改其一 → purity-violation", async () => {
    const script = `
await run('node', ['-e', 'console.log("A")']);
await run('node', ['-e', 'console.log("B")']);
await run('node', ['-e', 'console.log("C")']);
return 'ok';
`;
    const identity = workflowIdentity(script, undefined);
    const journalPath = p();
    await runScriptWorkflow(script, buildOpts(journalPath, { commandAllowlist: new Set(["node"]), identity }));
    const loaded = loadJournal(journalPath);
    // 篡改 seq=1 的 key
    const forged = loaded.cmds.map((c) => c.seq === 1 ? { ...c, key: "c:" + "f".repeat(64) } : c);
    const r2 = await runScriptWorkflow(
      script,
      buildOpts(journalPath, {
        commandAllowlist: new Set(["node"]),
        identity, resumeIdentity: identity,
        resumeTasks: loaded.tasks, resumeCmds: forged,
      }),
    );
    expect(r2.ok).toBe(false);
    expect(r2.failure?.category).toBe("purity-violation");
  });
});
