// 直接测试 cmd 后 firstWrite 是否真的传递给了 sub-workflow 的 task
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
  root = mkdtempSync(join(tmpdir(), "wf-t008-directfw-"));
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
  workflowName: "directfw",
  ...over,
});
const path = (): string => journalFilePath(root, `wf-directfw-${Math.random().toString(16).slice(2, 8)}`);

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

describe("T008 #6c — cmd 后立即接 task 的 firstWrite", () => {
  it("cmd + task（journal 中 task 用过工具） → 应被关门重跑", async () => {
    const p = path();
    // 首跑：tool-using task
    const first = trackedModel(["T1"]);
    await runScriptWorkflow("const t = await task('sub-b');\nreturn t.text;", opts(first.client, p));
    // 把 seq=0 的 toolsUsed 改
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

    // v2: 先 cmd + 再 task（同 prompt sub-b 但 key 同）
    const second = trackedModel(["T2-NEW"]);
    const script2 =
      "const cmd = await run('node', ['-e', 'console.log(1)']);\n" +
      "const t = await task('sub-b');\n" +
      "return [cmd.stdout.trim(), t.text];";
    const r2 = await runScriptWorkflow(script2, opts(second.client, p, {
      commandAllowlist: new Set(["node"]),
      resumeTasks: loadJournal(p).tasks,
      resumeCmds: loadJournal(p).cmds,
    }));
    console.log("DEBUG 6c result:", r2.returnValue, "calls:", second.calls);
  });
});
