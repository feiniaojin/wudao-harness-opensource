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
  root = mkdtempSync(join(tmpdir(), "wf-t008-trace3-"));
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
  workflowName: "trace3",
  ...over,
});
const path = (): string => journalFilePath(root, `wf-trace3-${Math.random().toString(16).slice(2, 8)}`);

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

describe("T008 #4f — 捕获并行 truncate 竞态错误", () => {
  it("捕获 parallel 内部异常", async () => {
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

    // 监听 journal append 错误
    const failures: unknown[] = [];
    const journal = openJournal(p);
    const origAppend = journal.append;
    const wrappedJournal = {
      path: journal.path,
      append: async (rec: unknown) => {
        try { await origAppend(rec as never); }
        catch (e) { failures.push({ type: (rec as { type?: string }).type, err: String(e) }); throw e; }
      }
    };

    const second = trackedModel(["B2-NEW", "C2-NEW", "D2-NEW"]);
    const script2 =
      "try {\n" +
      "  const ps = await parallel([\n" +
      "    () => task('b-tool-EDIT'),\n" +
      "    () => task('c-tool-EDIT'),\n" +
      "    () => task('d-pure-EDIT'),\n" +
      "  ]);\n" +
      "  return ps.results.map(r => r === null ? 'NULL' : r.text);\n" +
      "} catch (e) { return 'THREW: ' + String(e); }";
    const r2 = await runScriptWorkflow(script2, opts(second.client, p, {
      resumeTasks: loadJournal(p).tasks,
      journal: wrappedJournal as never,
    }));
    console.log("DEBUG r2.ok:", r2.ok, "returnValue:", r2.returnValue);
    console.log("DEBUG failures:", failures.length);
    for (const f of failures.slice(0, 3)) console.log("  ", JSON.stringify(f).slice(0,200));
  });
});
