import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput } from "@wudao-org/core";
import { runScriptWorkflow } from "../../src/workflow/engine.js";
import { journalFilePath, loadJournal, openJournal } from "../../src/workflow/journal.js";
import type { JsflowOptions } from "../../src/workflow/engine.js";
import { importableEntry, closesImportPool } from "../../src/workflow/import-cache.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wf-t008-undef-"));
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
  workflowName: "undef",
  ...over,
});
const path = (): string => journalFilePath(root, `wf-undef-${Math.random().toString(16).slice(2, 8)}`);

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

describe("T008 #5 — toolsUsed=undefined 边界", () => {
  it("5a) importableEntry 收到 undefined toolsUsed", () => {
    const pool = [
      { type: "task-finished" as const, seq: 0, key: "K", prompt: "p", ok: true, text: "t", toolsUsed: undefined as unknown as readonly string[], cost: { promptTokens: 1, completionTokens: 1 }, endedAt: "x" },
    ];
    let threw: unknown = undefined;
    let result: unknown = "NOT_CALLED";
    try {
      result = importableEntry(pool as never, "K", { pastEditPoint: true, firstWrite: true });
    } catch (e) { threw = e; }
    console.log("DEBUG 5a threw:", String(threw));
    console.log("DEBUG 5a result:", JSON.stringify(result));
    // 文档化实际行为
    if (threw !== undefined) {
      console.log("FINDING 5a: importableEntry THROWS on undefined toolsUsed (TypeError)");
    } else if (result === undefined) {
      console.log("FINDING 5a: importableEntry returns undefined (treats as 'never import')");
    } else {
      console.log("FINDING 5a: importableEntry returns the entry (treats as pure)");
    }
    expect({ threw: String(threw), result }).toBeDefined();
  });

  it("5b) closesImportPool 收到 undefined", () => {
    let threw: unknown = undefined;
    let result: unknown = "NOT_CALLED";
    try {
      result = closesImportPool(undefined as never);
    } catch (e) { threw = e; }
    console.log("DEBUG 5b threw:", String(threw));
    console.log("DEBUG 5b result:", JSON.stringify(result));
    expect({ threw: String(threw), result }).toBeDefined();
  });

  it("5c) 引擎端到端：journal 里某 seq 的 toolsUsed 缺失 → 编辑后导入路径", async () => {
    const p = path();
    const first = trackedModel(["A1", "B1", "C1"]);
    const script1 =
      "const a = await task('a');\n" +
      "const b = await task('b');\n" +
      "const c = await task('c');\n" +
      "return [a.text, b.text, c.text];";
    await runScriptWorkflow(script1, opts(first.client, p));
    stripToolsUsed(p, 1);
    const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim() !== "");
    const seq1 = lines.map((l) => JSON.parse(l)).find((r) => r.type === "task-finished" && r.seq === 1);
    expect((seq1 as Record<string, unknown>).toolsUsed).toBeUndefined();

    const second = trackedModel(["A2"]);
    const script2 =
      "const a = await task('a-EDIT');\n" +
      "const b = await task('b');\n" +
      "const c = await task('c');\n" +
      "return [a.text, b.text, c.text];";
    let threw: unknown = undefined;
    let result: { ok?: boolean; returnValue?: unknown; failure?: unknown } = {};
    try {
      const r2 = await runScriptWorkflow(script2, opts(second.client, p, {
        resumeTasks: loadJournal(p).tasks,
      }));
      result = r2;
    } catch (e) { threw = e; }
    console.log("DEBUG 5c threw:", String(threw).slice(0,200));
    console.log("DEBUG 5c result:", JSON.stringify(result).slice(0,200));
  });
});
