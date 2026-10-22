// 监视 truncate 调用与失败
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
  root = mkdtempSync(join(tmpdir(), "wf-t008-spy-"));
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
  workflowName: "spy",
  ...over,
});
const path = (): string => journalFilePath(root, `wf-spy-${Math.random().toString(16).slice(2, 8)}`);

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

describe("T008 #4g — spy on truncate", () => {
  it("spy truncate + capture parallel inner failures", async () => {
    const p = path();
    const first = trackedModel(["B1", "C1", "D1"]);
    const script1 =
      "const ps = await parallel([\n" +
      "  () => task('b-tool'),\n" +
      "  () => task('c-tool'),\n" +
      "  () => task('d-pure'),\n" +
      "]);\n" +
      "return ps.results.map(r => r.text);";
    await runScriptWorkflow(script1, opts(first.client, p));

    // 监听所有 journal append，并检查 tmp 文件
    const second = trackedModel(["B2-NEW"]);
    const script2 =
      "const ps = await parallel([\n" +
      "  () => task('b-tool-EDIT'),\n" +
      "  () => task('c-tool-EDIT'),\n" +
      "  () => task('d-pure-EDIT'),\n" +
      "]);\n" +
      "return ps.failures;";
    const r2 = await runScriptWorkflow(script2, opts(second.client, p, {
      resumeTasks: loadJournal(p).tasks,
    }));
    console.log("DEBUG r2.ok:", r2.ok);
    console.log("DEBUG returnValue:", JSON.stringify(r2.returnValue));
    console.log("DEBUG failure:", r2.failure);
    const j = readFileSync(p, "utf8").split("\n").filter(l => l.trim()).map(l => JSON.parse(l));
    console.log("DEBUG journal size:", j.length);
    console.log("DEBUG calls:", second.calls);
  });
});
