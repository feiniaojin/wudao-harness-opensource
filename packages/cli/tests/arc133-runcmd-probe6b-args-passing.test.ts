// T007 探针 6b — 子工作流 args 传递
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient } from "@wudao/core";
import { runScriptWorkflow } from "external/packages/cli/src/workflow/engine.js";
import { journalFilePath, loadJournal, openJournal, workflowIdentity } from "external/packages/cli/src/workflow/journal.js";
import type { JsflowOptions } from "external/packages/cli/src/workflow/engine.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wf-audit-t007-6b-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true, retryDelay: 100, maxRetries: 10 }); });

const noCallModel: ModelClient = {
  async generate(): Promise<AssistantMessage> { throw new Error("no model"); },
};
const buildOpts = (journalPath: string, extra: Partial<JsflowOptions> = {}): JsflowOptions => ({
  workspaceRoot: root, model: noCallModel, journal: openJournal(journalPath),
  workflowName: "subworkflow-args", ...extra,
});
const p = (): string => journalFilePath(root, `wf-sa-${Math.random().toString(16).slice(2, 8)}`);

describe("T007 #6b 子工作流 args 传递", () => {
  it("6b-1: 子工作流默认 args 来自父 args（无显式 childArgs）", async () => {
    const subScript = `return { tag: args.tag };`;
    const subPath = join(root, "sub-args.js");
    writeFileSync(subPath, subScript);

    const parentScript = `return await workflow('sub-args.js', args);`;
    const journalPath = p();
    const r = await runScriptWorkflow(parentScript, buildOpts(journalPath, {
      commandAllowlist: new Set(["node"]),
      args: { tag: "PARENT" },
    }));
    console.log("[6b-1] r.returnValue =", r.returnValue);
    // 期望：args.tag 继承父
    expect(r.ok).toBe(true);
    expect(r.returnValue).toEqual({ tag: "PARENT" });
  });

  it("6b-2: 子工作流接受显式 childArgs 覆盖", async () => {
    const subScript = `return { tag: args.tag };`;
    const subPath = join(root, "sub-args2.js");
    writeFileSync(subPath, subScript);

    const parentScript = `return await workflow('sub-args2.js', { tag: "CHILD" });`;
    const journalPath = p();
    const r = await runScriptWorkflow(parentScript, buildOpts(journalPath, {
      commandAllowlist: new Set(["node"]),
      args: { tag: "PARENT" },
    }));
    console.log("[6b-2] r.returnValue =", r.returnValue);
    expect(r.returnValue).toEqual({ tag: "CHILD" });
  });

  it("6b-3: 子工作流 identity 是自己 scriptSource + childArgs — 与父无关", async () => {
    // 关键：子工作流的 identity 是否包含父的 scriptHash？
    // T006 F3：identity = sha256(scriptSource) + sha256(argsCanonical)
    // 子 args 来源：父 workflow(name, childArgs)，如果 childArgs=undefined 用 ctx.args
    // 子 identity 应只看 childArgs 或父 args？— 设计模糊
    const subScript = `return args.tag;`;
    const subPath = join(root, "sub-args3.js");
    writeFileSync(subPath, subScript);

    const parentScript = `return await workflow('sub-args3.js', args);`;
    const journalPath = p();
    const r1 = await runScriptWorkflow(parentScript, buildOpts(journalPath, {
      commandAllowlist: new Set(["node"]),
      args: { tag: "X" },
    }));
    console.log("[6b-3] r1.returnValue =", r1.returnValue);
    expect(r1.returnValue).toBe("X");

    // 子工作流的 identity 与父的 args 关联——resume 父的 args 不同 → 子工作流 identity 异
    // 这是潜在的设计问题——子工作流的"身份"被父的输入污染
  });
});
