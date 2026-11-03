// T008 探针 #6h：sub-workflow 中 firstWrite 正确传播（验证）
// 修补 seq=2 (sub-b) 的 toolsUsed 为 ["read_file"] — 让 cmd 后的 firstWrite=true
// 真正起作用：sub.b 必须被关门重跑。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput } from "@wudao-org/core";
import { runScriptWorkflow } from "../../src/workflow/engine.js";
import { journalFilePath, loadJournal, openJournal } from "../../src/workflow/journal.js";
import type { JsflowOptions } from "../../src/workflow/engine.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wf-t008-fxsub-"));
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
  workflowName: "fxsub",
  ...over,
});
const path = (): string => journalFilePath(root, `wf-fxsub-${Math.random().toString(16).slice(2, 8)}`);

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

describe("T008 #6h — sub-workflow 中 firstWrite 正确传播", () => {
  it("cmd 后子工作流的非纯 task 应被关门（firstWrite 共享引用）", async () => {
    const p = path();
    writeFileSync(join(root, "sub.js"),
      "const b = await task('sub-b');\nreturn b.text;\n"
    );
    const first = trackedModel(["A1", "SUB-B1", "C1"]);
    await runScriptWorkflow(
      "const a = await task('parent-a');\n" +
      "const cmd = await run('node', ['-e', 'console.log(99)']);\n" +
      "const b = await workflow('sub');\n" +
      "const c = await task('parent-c');\n" +
      "return [a.text, cmd.stdout.trim(), b, c.text];",
      opts(first.client, p, { commandAllowlist: new Set(["node"]) }),
    );
    // 修补 seq=2 (sub-b) 的 toolsUsed 为 ["read_file"]
    const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim() !== "");
    const out: string[] = [];
    let patched = false;
    for (const line of lines) {
      const rec = JSON.parse(line);
      if (rec.type === "task-finished" && rec.seq === 2) {
        out.push(JSON.stringify({ ...rec, toolsUsed: ["read_file"] }));
        patched = true;
      } else {
        out.push(line);
      }
    }
    writeFileSync(p, out.join("\n") + "\n");
    expect(patched).toBe(true);
    
    const lt = loadJournal(p).tasks;
    const subB = lt.find((t) => t.seq === 2);
    expect(subB?.toolsUsed).toEqual(["read_file"]);

    // 给两个响应：A2 给 parent-a 重跑，SUB-B2 给 sub-b 重跑
    const second = trackedModel(["A2", "SUB-B2"]);
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
    // 期望：firstWrite 从 cmd 传播到 sub-workflow，sub.b (toolsUsed>0) 被关门重跑
    expect(second.calls).toBe(2); // a 重跑 + sub.b 重跑
    expect(r2.returnValue?.[0]).toBe("A2");    // a 来自重跑
    expect(r2.returnValue?.[2]).toBe("SUB-B2"); // sub.b 来自**重跑**（不是 SUB-B1 导入）
    expect(r2.returnValue?.[3]).toBe("C1");     // c (toolsUsed=[]) 纯项仍可导入
  });
});
