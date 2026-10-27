// T008 #4h — 单 edit + 同 key 的兄弟在 parallel 内 → 也会竞态 truncate？
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
  root = mkdtempSync(join(tmpdir(), "wf-t008-oneedit-"));
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
  workflowName: "oneedit",
  ...over,
});
const path = (): string => journalFilePath(root, `wf-oneedit-${Math.random().toString(16).slice(2, 8)}`);

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

describe("T008 #4h — 单 edit + 同 key 兄弟 + parallel", () => {
  it("一个 edit + 两个 import → truncate 竞态", async () => {
    const p = path();
    const first = trackedModel(["B1", "C1", "D1"]);
    const script1 =
      "const ps = await parallel([\n" +
      "  () => task('b'),\n" +
      "  () => task('c'),\n" +
      "  () => task('d'),\n" +
      "]);\n" +
      "return ps.results.map(r => r.text);";
    await runScriptWorkflow(script1, opts(first.client, p));

    // v2: 只 b 改了，c/d 同键
    const second = trackedModel(["B2"]);
    const script2 =
      "const ps = await parallel([\n" +
      "  () => task('b-EDIT'),\n" +
      "  () => task('c'),\n" +
      "  () => task('d'),\n" +
      "]);\n" +
      "return ps.failures.concat(ps.results.map(r => r === null ? 'NULL' : r.text)).join('|');";
    const r2 = await runScriptWorkflow(script2, opts(second.client, p, {
      resumeTasks: loadJournal(p).tasks,
    }));
    console.log("DEBUG r2.ok:", r2.ok);
    console.log("DEBUG returnValue:", r2.returnValue);
    console.log("DEBUG calls:", second.calls);
  });
});
