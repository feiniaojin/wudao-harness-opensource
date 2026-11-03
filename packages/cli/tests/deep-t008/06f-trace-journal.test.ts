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
  root = mkdtempSync(join(tmpdir(), "wf-t008-tr-"));
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
  workflowName: "tr",
  ...over,
});
const path = (): string => journalFilePath(root, `wf-tr-${Math.random().toString(16).slice(2, 8)}`);

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

describe("T008 #6f — 追踪 journal 内容", () => {
  it("确认 v1 后 loadJournal 看到所有 task-finished", async () => {
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
    // 不 patch，直接看 loadJournal 看到啥
    const loaded = loadJournal(p);
    console.log("Loaded tasks count:", loaded.tasks.length);
    for (const t of loaded.tasks) {
      console.log(`  seq=${t.seq} key=${t.key.slice(0,10)} text=${t.text} toolsUsed=${JSON.stringify(t.toolsUsed)}`);
    }
    console.log("Loaded cmds count:", loaded.cmds.length);
    for (const c of loaded.cmds) {
      console.log(`  seq=${c.seq} cmd=${c.cmd} args=${JSON.stringify(c.args)} code=${c.code}`);
    }
  });
});
