// T008 探针 #2a：关门时机的精确性
// 编辑点后：纯 task 导入成功 → cmd 实际执行（永远关门）→ 
//          后续 tool-using task 应被关门（重跑），纯 task 仍可导入。
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
  root = mkdtempSync(join(tmpdir(), "wf-t008-close-"));
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
  workflowName: "close",
  ...over,
});
const path = (): string => journalFilePath(root, `wf-close-${Math.random().toString(16).slice(2, 8)}`);

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

describe("T008 #2a — 关门时机精确性（编辑点后纯→cmd→非纯→纯）", () => {
  it("纯→cmd(实际执行关门)→非纯(应被关门重跑)→纯(仍可导入)", async () => {
    const p = path();
    // 首跑：纯 task + tool-using task + 纯 task；无 cmd。
    // 这里脚本化模型不会真正调用工具，但我们用**手造 journal**塞一个
    // toolsUsed=["read_file"] 的条目，让引擎导入路径看到它。
    // 首跑跑出来 entries 0..2 都是纯（toolsUsed=[]）。
    const first = trackedModel(["PURE1", "TOOL1", "PURE2"]);
    const script1 =
      "const a = await task('a-pure-1');\n" +
      "const b = await task('b-tool');\n" +
      "const c = await task('c-pure-2');\n" +
      "return [a.text, b.text, c.text];";
    const r1 = await runScriptWorkflow(script1, opts(first.client, p));
    expect(r1.ok).toBe(true);
    expect(first.calls).toBe(3);

    // 现在手改 journal：让 b（seq=1）的 toolsUsed 变 ["read_file"]
    // （模拟首跑时确实用了工具的产物）
    const journalLines = require("node:fs").readFileSync(p, "utf8").split("\n").filter((l: string) => l.trim());
    const lines = journalLines.map((l: string) => JSON.parse(l));
    const out: string[] = [];
    for (const rec of lines) {
      if (rec.type === "task-finished" && rec.seq === 1) {
        out.push(JSON.stringify({ ...rec, toolsUsed: ["read_file"] }));
      } else {
        out.push(JSON.stringify(rec));
      }
    }
    require("node:fs").writeFileSync(p, out.join("\n") + "\n");

    // 编辑 a → invalidated=true
    // 顺序：a (纯) — 重跑；cmd ('ls') — 实际执行 → firstWrite=true；
    //       b (tool-using) — 导入路径 → firstWrite=true 且 toolsUsed>0 → 关闭 → 重跑
    //       c (纯) — 导入路径 → firstWrite=true 但 toolsUsed=0 → 仍导入
    const second = trackedModel([
      "PURE1-NEW",   // a 重跑
      "TOOL1-NEW",   // b 被关门重跑
      // c 是纯项，应从 journal 导入 → 不需要响应
    ]);
    const script2 =
      "const a = await task('a-pure-1-EDIT');\n" +
      "const cmd = await run('node', ['-e', 'console.log(1)']);\n" +
      "const b = await task('b-tool');\n" +
      "const c = await task('c-pure-2');\n" +
      "return [a.text, cmd.stdout.trim(), b.text, c.text];";
    const r2 = await runScriptWorkflow(script2, opts(second.client, p, {
      commandAllowlist: new Set(["node"]),
      resumeTasks: loadJournal(p).tasks,
      resumeCmds: loadJournal(p).cmds,
    }));
    expect(r2.ok).toBe(true);
    // 期望模型被调用 2 次：a + b（c 是纯项导入，不调用模型）
    expect(second.calls).toBe(2);
    // b 应被关门（实际重跑），c 应被导入（不调用模型）
    // 注：returnValue 是 [a.text, cmd.stdout, b.text, c.text]
    expect(r2.returnValue?.[0]).toBe("PURE1-NEW");   // 来自重跑
    expect(r2.returnValue?.[1]).toBe("1");            // 来自 cmd
    expect(r2.returnValue?.[2]).toBe("TOOL1-NEW");   // 来自关门重跑
    expect(r2.returnValue?.[3]).toBe("PURE2");       // 来自 journal 导入
    // tasksReplayed：c 导入（1 次）
    expect(r2.tasksReplayed).toBe(1);
  });
});
