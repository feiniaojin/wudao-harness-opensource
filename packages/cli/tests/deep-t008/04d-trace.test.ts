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
  root = mkdtempSync(join(tmpdir(), "wf-t008-trace-"));
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
  workflowName: "trace",
  ...over,
});
const path = (): string => journalFilePath(root, `wf-trace-${Math.random().toString(16).slice(2, 8)}`);

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

describe("T008 #4d — trace", () => {
  it("debug what d returns", async () => {
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

    const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim() !== "");
    const out: string[] = [];
    for (const line of lines) {
      const rec = JSON.parse(line);
      if (rec.type === "task-finished" && (rec.seq === 0 || rec.seq === 1)) {
        out.push(JSON.stringify({ ...rec, toolsUsed: ["read_file"] }));
      } else {
        out.push(line);
      }
    }
    writeFileSync(p, out.join("\n") + "\n");

    // 不用 cmd 试验
    const second = trackedModel(["B2-NEW"]);
    const script2 =
      "const ps = await parallel([\n" +
      "  () => task('b-tool-EDIT'),\n" +
      "  () => task('c-tool'),\n" +
      "  () => task('d-pure'),\n" +
      "]);\n" +
      "return ps.results.map((r, i) => i + ':' + (r === null ? 'NULL' : JSON.stringify({ok: r.ok, text: r.text}))).join('|');";
    const r2 = await runScriptWorkflow(script2, opts(second.client, p, {
      resumeTasks: loadJournal(p).tasks,
    }));
    console.log("DEBUG:", r2.returnValue);
    console.log("DEBUG calls:", second.calls);
    const j = readFileSync(p, "utf8").split("\n").filter(l => l.trim()).map(l => JSON.parse(l));
    const types = j.map(r => `${r.type}:${r.seq ?? ""}`).join(", ");
    console.log("DEBUG journal:", types);
  });
});
