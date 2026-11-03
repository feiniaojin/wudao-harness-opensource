// T008 探针 #6a：firstWrite 跨子工作流（修正版）
// 关键观察：sub-workflow 的 task 与父 task 共享 `shared` 引用（firstWrite/seq/invalidated
// 全共享），所以父的 firstWrite=true 会**正确**传递给子的 runTask。
// 但本测试 v1 sub.b 的 toolsUsed=[] (纯项)，cmd 后的 firstWrite=true 不影响纯项。
// 真正的关门验证放在 06h（那里我把 sub.b 的 toolsUsed 改成 ["read_file"]）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput } from "@wudao-org/core";
import { runScriptWorkflow } from "../../src/workflow/engine.js";
import { journalFilePath, loadJournal, openJournal } from "../../src/workflow/journal.js";
import type { JsflowOptions } from "../../src/workflow/engine.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wf-t008-subwf-"));
  writeFileSync(join(root, "f.txt"), "data");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, retryDelay: 100, maxRetries: 10 });
});

const say = (content: string): AssistantMessage => ({ role: "assistant", content });
const opts = (model: ModelClient, journalPath: string, over: Partial<JsflowOptions> = {}): JsflowOptions => ({
  workspaceRoot: root,
  model,
  journal: openJournal(journalPath),
  workflowName: "subwf",
  ...over,
});
const path = (): string => journalFilePath(root, `wf-subwf-${Math.random().toString(16).slice(2, 8)}`);

function trackedModel(responses: readonly string[]): { client: ModelClient; calls: number } {
  let i = 0;
  return {
    get calls() { return i; },
    client: {
      async generate(input: ModelInput): Promise<AssistantMessage> {
        const r = responses[i];
        i += 1;
        if (r === undefined) throw new Error("exhausted");
        input.onUsage?.({ promptTokens: 5, cacheHitTokens: 0, cacheMissTokens: 5, completionTokens: 2 });
        return say(r);
      },
    },
  };
}

describe("T008 #6a — sub-workflow 中 firstWrite 的传播", () => {
  it("父 cmd 之后子 task (toolsUsed=[]) 仍可导入（纯项始终允许）", async () => {
    const p = path();
    writeFileSync(join(root, "sub.js"),
      "const b = await task('sub-b');\nreturn b.text;\n"
    );
    const first = trackedModel(["A1", "SUB-B1", "C1"]);
    const script1 =
      "const a = await task('parent-a');\n" +
      "const cmd = await run('node', ['-e', 'console.log(99)']);\n" +
      "const b = await workflow('sub');\n" +
      "const c = await task('parent-c');\n" +
      "return [a.text, cmd.stdout.trim(), b, c.text];";
    await runScriptWorkflow(script1, opts(first.client, p, {
      commandAllowlist: new Set(["node"]),
    }));

    const second = trackedModel(["A2"]);
    const script2 =
      "const a = await task('parent-a-EDIT');\n" +
      "const cmd = await run('node', ['-e', 'console.log(99)']);\n" +
      "const b = await workflow('sub');\n" +
      "const c = await task('parent-c');\n" +
      "return [a.text, cmd.stdout.trim(), b, c.text];";
    const r2 = await runScriptWorkflow(script2, opts(second.client, p, {
      commandAllowlist: new Set(["node"]),
      resumeTasks: loadJournal(p).tasks,
      resumeCmds: loadJournal(p).cmds,
    }));
    expect(r2.ok).toBe(true);
    // sub.b toolsUsed=[] → firstWrite=true 仍放行纯项
    expect(r2.returnValue?.[2]).toBe("SUB-B1"); // 来自 journal 导入
    expect(second.calls).toBe(1); // 仅 a 重跑
  });
});
