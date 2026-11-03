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
  root = mkdtempSync(join(tmpdir(), "wf-t008-tracesub-"));
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
  workflowName: "tracesub",
  ...over,
});
const path = (): string => journalFilePath(root, `wf-tracesub-${Math.random().toString(16).slice(2, 8)}`);

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

describe("T008 #6b — subwf trace", () => {
  it("trace sub-workflow import behavior", async () => {
    const p = path();
    writeFileSync(join(root, "sub.js"),
      "const b = await task('sub-b');\nreturn b.text;\n"
    );
    const first = trackedModel(["A1", "SUB-B1", "C1"]);
    const script1 =
      "const a = await task('parent-a');\n" +
      "const cmd = await run('node', ['-e', 'console.log(99)']);\n" +
      "const b = await workflow('sub');\n" +
      "const c = await task('parent-c');\n" +
      "return [a.text, cmd.stdout.trim(), b, c.text];";
    await runScriptWorkflow(script1, opts(first.client, p, {
      commandAllowlist: new Set(["node"]),
    }));

    const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim() !== "");
    const out: string[] = [];
    for (const line of lines) {
      const rec = JSON.parse(line);
      if (rec.type === "task-finished" && rec.seq === 1) {
        out.push(JSON.stringify({ ...rec, toolsUsed: ["read_file"] }));
      } else {
        out.push(line);
      }
    }
    writeFileSync(p, out.join("\n") + "\n");

    const second = trackedModel(["A2", "SUB-B2", "C2"]);
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
    console.log("DEBUG r2.ok:", r2.ok, "value:", r2.returnValue, "calls:", second.calls);
    const j = readFileSync(p, "utf8").split("\n").filter(l => l.trim()).map(l => JSON.parse(l));
    const types = j.map(r => `${r.type}:${r.seq ?? ""}`).join(", ");
    console.log("DEBUG journal:", types);
  });
});
