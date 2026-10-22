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
  root = mkdtempSync(join(tmpdir(), "wf-t008-uw-"));
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
  workflowName: "uw",
  ...over,
});
const path = (): string => journalFilePath(root, `wf-uw-${Math.random().toString(16).slice(2, 8)}`);

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

function stripToolsUsed(journalPath: string, seq: number): void {
  const lines = readFileSync(journalPath, "utf8").split("\n").filter((l) => l.trim() !== "");
  const out: string[] = [];
  for (const line of lines) {
    const rec = JSON.parse(line);
    if (rec.type === "task-finished" && rec.seq === seq) {
      const { toolsUsed: _toolsUsed, ...rest } = rec;
      out.push(JSON.stringify(rest));
    } else {
      out.push(line);
    }
  }
  writeFileSync(journalPath, out.join("\n") + "\n");
}

describe("T008 #5d — toolsUsed 缺失 + firstWrite=true", () => {
  it("工具使用 task 真实跑过（firstWrite=true）→ 下一个 task 导入时 toolsUsed 缺失 → 期望 throws", async () => {
    const p = path();
    // 首跑：3 个纯 task
    const first = trackedModel(["A1", "B1", "C1"]);
    const script1 =
      "const a = await task('a');\n" +
      "const b = await task('b');\n" +
      "const c = await task('c');\n" +
      "return [a.text, b.text, c.text];";
    await runScriptWorkflow(script1, opts(first.client, p));

    // 抹掉 seq=1 (b) 的 toolsUsed
    stripToolsUsed(p, 1);

    // v2: 编辑 a + 加一个 **cmd** 在 b 之前 → cmd 让 firstWrite=true → b 导入时 firstWrite=true 且 toolsUsed 缺失 → 应 throws
    const second = trackedModel(["A2"]);
    const script2 =
      "const cmd = await run('node', ['-e', 'console.log(1)']);\n" +  // firstWrite=true
      "const a = await task('a-EDIT');\n" +
      "const b = await task('b');\n" +
      "const c = await task('c');\n" +
      "return [cmd.stdout.trim(), a.text, b.text, c.text];";
    let threw: unknown = undefined;
    let result: { ok?: boolean; returnValue?: unknown; failure?: unknown } = {};
    try {
      const r2 = await runScriptWorkflow(script2, opts(second.client, p, {
        commandAllowlist: new Set(["node"]),
        resumeTasks: loadJournal(p).tasks,
        resumeCmds: loadJournal(p).cmds,
      }));
      result = r2;
    } catch (e) { threw = e; }
    console.log("DEBUG 5d threw:", String(threw).slice(0,300));
    console.log("DEBUG 5d result:", JSON.stringify(result).slice(0,300));
  });
});
