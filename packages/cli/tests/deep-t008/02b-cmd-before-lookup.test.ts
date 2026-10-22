// T008 探针 #2b：cmd 在导入查找之前执行 → 导入池应在 cmd 执行瞬间关闭
// 含义：如果 first 个 task 在 cmd 之后，并且 cmd 真的执行了——
// 那么 first task 即便是非纯的也应被关门（纯项仍可导入）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput } from "@wudao/core";
import { runScriptWorkflow } from "../../src/workflow/engine.js";
import { journalFilePath, loadJournal, openJournal } from "../../src/workflow/journal.js";
import type { JsflowOptions } from "../../src/workflow/engine.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wf-t008-cmdb-"));
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
  workflowName: "cmdb",
  ...over,
});
const path = (): string => journalFilePath(root, `wf-cmdb-${Math.random().toString(16).slice(2, 8)}`);

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

describe("T008 #2b — cmd 在导入查找之前执行", () => {
  it("cmd 先执行 → 后续非纯 task 必须重跑（即便 journal 有同键缓存）", async () => {
    const p = path();
    // 首跑：tool-using task + 纯 task；无 cmd。
    const first = trackedModel(["TOOL1", "PURE2"]);
    const script1 =
      "const a = await task('a-tool');\n" +
      "const b = await task('b-pure');\n" +
      "return [a.text, b.text];";
    const r1 = await runScriptWorkflow(script1, opts(first.client, p));
    expect(r1.ok).toBe(true);

    // 手改 journal：让 a（seq=0）的 toolsUsed=["read_file"]
    const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim() !== "");
    const out: string[] = [];
    for (const line of lines) {
      const rec = JSON.parse(line);
      if (rec.type === "task-finished" && rec.seq === 0) {
        out.push(JSON.stringify({ ...rec, toolsUsed: ["read_file"] }));
      } else {
        out.push(line);
      }
    }
    writeFileSync(p, out.join("\n") + "\n");

    // 编辑 a → invalidated=true
    // 第二轮脚本：先 cmd（实际执行 → firstWrite=true），再 a，再 b
    // 期望：a 在导入路径被关闭 → 重跑（2 次模型调用）；b 仍可导入（纯）
    const second = trackedModel([
      "TOOL1-NEW",   // a 重跑（关门后）
      // b 是纯项 → 导入
    ]);
    const script2 =
      "const c = await run('node', ['-e', 'console.log(99)']);\n" +
      "const a = await task('a-tool');\n" +          // seq=1
      "const b = await task('b-pure');\n" +           // seq=2
      "return [c.stdout.trim(), a.text, b.text];";
    const r2 = await runScriptWorkflow(script2, opts(second.client, p, {
      commandAllowlist: new Set(["node"]),
      resumeTasks: loadJournal(p).tasks,
      resumeCmds: loadJournal(p).cmds,
    }));
    expect(r2.ok).toBe(true);
    expect(second.calls).toBe(1); // 只有 a 重跑；b 是纯项导入
    expect(r2.returnValue?.[1]).toBe("TOOL1-NEW"); // 来自新调用
    expect(r2.returnValue?.[2]).toBe("PURE2");      // 来自 journal 导入
    expect(r2.tasksReplayed).toBe(1);                // 仅 b 被导入
  });
});
