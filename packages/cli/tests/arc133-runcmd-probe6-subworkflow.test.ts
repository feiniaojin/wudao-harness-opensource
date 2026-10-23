// T007 探针 6 — 子工作流 cmd 作用域与 seq 共享
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient } from "@wudao/core";
import { runScriptWorkflow } from "~/xdev/github/wudao-harness-project/wudao-harness/packages/cli/src/workflow/engine.js";
import { journalFilePath, loadJournal, openJournal } from "~/xdev/github/wudao-harness-project/wudao-harness/packages/cli/src/workflow/journal.js";
import type { JsflowOptions } from "~/xdev/github/wudao-harness-project/wudao-harness/packages/cli/src/workflow/engine.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wf-audit-t007-6-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true, retryDelay: 100, maxRetries: 10 }); });

const noCallModel: ModelClient = {
  async generate(): Promise<AssistantMessage> { throw new Error("no model"); },
};
const buildOpts = (journalPath: string, extra: Partial<JsflowOptions> = {}): JsflowOptions => ({
  workspaceRoot: root, model: noCallModel, journal: openJournal(journalPath),
  workflowName: "subworkflow-cmd", ...extra,
});
const p = (): string => journalFilePath(root, `wf-sw-${Math.random().toString(16).slice(2, 8)}`);

describe("T007 #6 子工作流 cmd 作用域", () => {
  it("6-1: 父工作流调子工作流（子工作流跑 cmd）— cmd 在哪个 scope？", async () => {
    // 写一个子工作流脚本
    const subScript = `const c = await run('node', ['-e', 'console.log("SUB-CMD")']); return c.stdout.trim();`;
    const subPath = join(root, "sub.js");
    writeFileSync(subPath, subScript);

    // 父工作流：先父跑，再调子
    const parentScript = `
const p = await run('node', ['-e', 'console.log("PARENT-CMD")']);
const s = await workflow('sub.js');
return { parent: p.stdout.trim(), sub: s };
`;
    const journalPath = p();
    const r = await runScriptWorkflow(parentScript, buildOpts(journalPath, { commandAllowlist: new Set(["node"]) }));
    console.log("[6-1] r.returnValue =", r.returnValue);
    expect(r.ok).toBe(true);
    expect(r.returnValue).toEqual({ parent: "PARENT-CMD", sub: "SUB-CMD" });

    const loaded = loadJournal(journalPath);
    console.log("[6-1] cmd-finished seq 序列:", loaded.cmds.map((c) => c.seq));
    // 期望：父 seq=0 (PARENT-CMD), 子 seq=1 (SUB-CMD) — 共享 seq 计数
    expect(loaded.cmds.length).toBe(2);
    const seqs = loaded.cmds.map((c) => c.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([0, 1]);
    expect(loaded.cmds.find((c) => c.seq === 0)?.stdout.trim()).toBe("PARENT-CMD");
    expect(loaded.cmds.find((c) => c.seq === 1)?.stdout.trim()).toBe("SUB-CMD");
  });

  it("6-2: scopeLabel — 纯度违例的 scopeLabel 在子工作流 cmdKey 漂移时是否正确", async () => {
    // 难点：构造纯度武装下的 cmdKey 漂移在子工作流中——需要同身份（同 scriptSource）
    // 但 cmdKey 漂移——这需要 run() 的 args 不同，但同 scriptSource——这不可能
    // 我们用 args 注入让 cmd argv 变化
    const subScript = `const c = await run('node', ['-e', 'console.log("' + args.tag + '")']); return c.stdout.trim();`;
    const subPath = join(root, "sub2.js");
    writeFileSync(subPath, subScript);

    // 父跑：args.tag = "PAR"
    const parentScript = `
return await workflow('sub2.js');
`;
    const journalPath = p();
    // 注意：identity 来自 scriptSource + workflow args
    // 父 args = {tag: "PAR"}, 子 args = 同
    // 首跑：args.tag="PAR"
    const r1 = await runScriptWorkflow(parentScript, buildOpts(journalPath, {
      commandAllowlist: new Set(["node"]),
      args: { tag: "PAR" },
      identity: undefined,
    }));
    console.log("[6-1] r1.returnValue =", r1.returnValue);
  });

  it("6-3: 父 + 子混合 cmd（并行）— shared seq 是否仍正确对位", async () => {
    const subScript = `
const c1 = await run('node', ['-e', 'console.log("SUB-A")']);
const c2 = await run('node', ['-e', 'console.log("SUB-B")']);
return [c1.stdout.trim(), c2.stdout.trim()];
`;
    const subPath = join(root, "sub3.js");
    writeFileSync(subPath, subScript);

    const parentScript = `
const pa = await run('node', ['-e', 'console.log("PARENT-A")']);
const sa = await workflow('sub3.js');
const pb = await run('node', ['-e', 'console.log("PARENT-B")']);
return { pa: pa.stdout.trim(), sa, pb: pb.stdout.trim() };
`;
    const journalPath = p();
    const r = await runScriptWorkflow(parentScript, buildOpts(journalPath, { commandAllowlist: new Set(["node"]) }));
    console.log("[6-3] r.returnValue =", r.returnValue);
    expect(r.ok).toBe(true);

    const loaded = loadJournal(journalPath);
    console.log("[6-3] cmds:", loaded.cmds.map((c) => ({ seq: c.seq, stdout: c.stdout.trim() })));
    // 期望 seq 0=PARENT-A, 1=SUB-A, 2=SUB-B, 3=PARENT-B（共享 seq 计数器）
    expect(loaded.cmds.length).toBe(4);
    expect(loaded.cmds.find((c) => c.seq === 0)?.stdout.trim()).toBe("PARENT-A");
    expect(loaded.cmds.find((c) => c.seq === 1)?.stdout.trim()).toBe("SUB-A");
    expect(loaded.cmds.find((c) => c.seq === 2)?.stdout.trim()).toBe("SUB-B");
    expect(loaded.cmds.find((c) => c.seq === 3)?.stdout.trim()).toBe("PARENT-B");
  });

  it("6-4: scopeLabel 在 WorkflowPurityError 消息中如何表现？", async () => {
    // 不能直接构造同身份 cmdKey 漂移——脚本字面定则 cmdKey 不可变
    // 改测：trigger a 纯度违例 用手工构造 resumeCmds（同 identity 篡改 cmd key）
    const script = `const c = await run('node', ['-e', 'console.log(1)']); return c.stdout.trim();`;
    const identity = workflowIdentity_(script);
    const journalPath = p();
    const r1 = await runScriptWorkflow(script, buildOpts(journalPath, { commandAllowlist: new Set(["node"]), identity }));
    expect(r1.returnValue).toBe("1");

    const loaded = loadJournal(journalPath);
    // 篡改 cmd key——同身份 → 纯度违例
    const forged = loaded.cmds.map((c) => ({ ...c, key: "c:" + "0".repeat(64) }));
    const r2 = await runScriptWorkflow(
      script,
      buildOpts(journalPath, {
        commandAllowlist: new Set(["node"]),
        identity, resumeIdentity: identity,
        resumeTasks: loaded.tasks, resumeCmds: forged,
      }),
    );
    console.log("[6-4] failure:", r2.failure);
    // 期望 message 含 scopeLabel 子串（顶层 run 无 scopeLabel）
    expect(r2.ok).toBe(false);
    expect(r2.failure?.category).toBe("purity-violation");
    // 顶层 run 无 scopeLabel，所以 message 不应含 "(in workflow '...')"
    if (r2.failure?.message.includes("(in workflow '")) {
      console.log("[6-4] ★ 顶层 run 不应有 scope 后缀，但发现了：", r2.failure.message);
    }
  });
});

function workflowIdentity_(script: string): { scriptHash: string; argsHash: string } {
  return { scriptHash: "h", argsHash: "h" };
}
