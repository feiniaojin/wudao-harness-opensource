// T007 探针 5b — 异身份 + task：实际行为
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput } from "@wudao/core";
import { runScriptWorkflow } from "~/xdev/github/wudao-harness-project/wudao-harness/packages/cli/src/workflow/engine.js";
import { journalFilePath, loadJournal, openJournal, workflowIdentity } from "~/xdev/github/wudao-harness-project/wudao-harness/packages/cli/src/workflow/journal.js";
import type { JsflowOptions } from "~/xdev/github/wudao-harness-project/wudao-harness/packages/cli/src/workflow/engine.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wf-audit-t007-5b-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true, retryDelay: 100, maxRetries: 10 }); });

const buildOpts = (journalPath: string, extra: Partial<JsflowOptions> = {}): JsflowOptions => ({
  workspaceRoot: root,
  model: undefined as unknown as ModelClient,
  journal: openJournal(journalPath),
  workflowName: "异身份-task",
  ...extra,
});
const p = (): string => journalFilePath(root, `wf-异-${Math.random().toString(16).slice(2, 8)}`);

describe("T007 #5b 异身份 task", () => {
  it("5b-1: 异身份 + 仅 task（无 cmd）→ task 是否重跑？", async () => {
    const script1 = `const t = await task('echo A', {}); return t.text;`;
    const script2 = `const t = await task('echo A', {}); return t.text;`;
    // 这俩字面其实一样——只是为了测
    const journalPath = p();

    let modelCalls: string[] = [];
    const firstModel: ModelClient = {
      async generate(_input: ModelInput): Promise<AssistantMessage> {
        modelCalls.push("firstModel");
        return { role: "assistant", content: "FIRST" };
      },
    };
    const r1 = await runScriptWorkflow(script1, buildOpts(journalPath, { identity: workflowIdentity(script1, undefined), model: firstModel }));
    console.log("[5b-1] r1.returnValue =", r1.returnValue);
    console.log("[5b-1] modelCalls after r1:", modelCalls);

    const loaded = loadJournal(journalPath);
    // 模拟异身份——脚本字面变一点
    const script2Mod = `const t = await task('echo A', {}); return t.text + '!';`;
    const secondModel: ModelClient = {
      async generate(_input: ModelInput): Promise<AssistantMessage> {
        modelCalls.push("secondModel");
        return { role: "assistant", content: "SECOND" };
      },
    };
    const r2 = await runScriptWorkflow(
      script2Mod,
      buildOpts(journalPath, {
        identity: workflowIdentity(script2Mod, undefined),
        resumeIdentity: workflowIdentity(script1, undefined),
        resumeTasks: loaded.tasks, resumeCmds: loaded.cmds,
        model: secondModel,
      }),
    );
    console.log("[5b-1] r2.returnValue =", r2.returnValue);
    console.log("[5b-1] modelCalls after r2:", modelCalls);
    expect(r2.ok).toBe(true);
    // 模型调用应该 = 2 (firstModel + secondModel)
    // 但 r2 应该是 "FIRST!" 还是 "SECOND!"？
    // 异身份 → 截断路径 → task 重跑 → secondModel 返回 "SECOND"
    // 但 script2Mod 字面要求 return text + '!' → "SECOND!"
  });

  it("5b-2: 同身份 + task 编辑（同 prompt 不同 opts）→ task key 漂移", async () => {
    // 同身份（同 scriptSource + 同 args），但 task options 不同 → task key 不同
    // 这是 "在脚本绊线外引入非确定性"——purityArmed 应触发
    const script = `const t = await task('echo', { label: args.label }); return t.text;`;
    const journalPath = p();

    let modelCalls: string[] = [];
    const m: ModelClient = {
      async generate(_input: ModelInput): Promise<AssistantMessage> {
        modelCalls.push("called");
        return { role: "assistant", content: "OUT_" + modelCalls.length };
      },
    };

    // 第一次跑 args.label="L1"
    const r1 = await runScriptWorkflow(
      script,
      buildOpts(journalPath, {
        identity: workflowIdentity(script, { label: "L1" }),
        args: { label: "L1" },
        model: m,
      }),
    );
    expect(r1.ok).toBe(true);
    console.log("[5b-2] r1.returnValue =", r1.returnValue, "modelCalls:", modelCalls);

    // resume 同 args——应当重放
    const loaded = loadJournal(journalPath);
    const r2 = await runScriptWorkflow(
      script,
      buildOpts(journalPath, {
        identity: workflowIdentity(script, { label: "L1" }),
        resumeIdentity: workflowIdentity(script, { label: "L1" }),
        args: { label: "L1" },
        resumeTasks: loaded.tasks, resumeCmds: loaded.cmds,
        model: m,
      }),
    );
    console.log("[5b-2] r2 (resume same args).returnValue =", r2.returnValue, "modelCalls:", modelCalls);
    // 应重放零派生
    expect(r2.returnValue).toEqual(r1.returnValue);
    // modelCalls 应该没增加（如果重放命中）
    console.log("[5b-2] modelCalls after r2 (期望仍 = 1):", modelCalls.length);
  });
});
