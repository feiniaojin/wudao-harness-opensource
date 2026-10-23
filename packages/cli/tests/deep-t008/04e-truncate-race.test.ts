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
  root = mkdtempSync(join(tmpdir(), "wf-t008-trace2-"));
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
  workflowName: "trace2",
  ...over,
});
const path = (): string => journalFilePath(root, `wf-trace2-${Math.random().toString(16).slice(2, 8)}`);

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

describe("T008 #4e — truncate race in parallel", () => {
  it("3 tasks in parallel, all with edit (different keys) → truncate race", async () => {
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

    // 所有 key 都改了 → 三个 task 都进入 truncate path
    const second = trackedModel(["B2-NEW", "C2-NEW", "D2-NEW"]);
    const script2 =
      "const ps = await parallel([\n" +
      "  () => task('b-tool-EDIT'),\n" +
      "  () => task('c-tool-EDIT'),\n" +
      "  () => task('d-pure-EDIT'),\n" +
      "]);\n" +
      "return ps.results.map(r => r.text);";
    const r2 = await runScriptWorkflow(script2, opts(second.client, p, {
      resumeTasks: loadJournal(p).tasks,
    }));
    console.log("DEBUG r2.ok:", r2.ok);
    console.log("DEBUG failure:", r2.failure);
    console.log("DEBUG returnValue:", r2.returnValue);
    console.log("DEBUG calls:", second.calls);
    const j = readFileSync(p, "utf8").split("\n").filter(l => l.trim()).map(l => JSON.parse(l));
    console.log("DEBUG journal:");
    for (const r of j) console.log(" ", r.type, r.seq, "key:", r.key?.slice(0,8), "text:", r.text);
  });
});
