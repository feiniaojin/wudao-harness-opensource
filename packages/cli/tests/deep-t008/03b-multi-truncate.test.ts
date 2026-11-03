// T008 探针 #3b：v2 完成后 journal 里 v1 的条目物理消失了吗？
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
  root = mkdtempSync(join(tmpdir(), "wf-t008-trunc-"));
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
  workflowName: "trunc",
  ...over,
});
const path = (): string => journalFilePath(root, `wf-trunc-${Math.random().toString(16).slice(2, 8)}`);

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

describe("T008 #3b — v2 truncate 是否物理移除 v1 条目", () => {
  it("v2 编辑 a → journal 中 v1 的 b/c 条目被物理 truncate", async () => {
    const p = path();
    const v1 = trackedModel(["A1", "B1", "C1"]);
    const scriptV1 =
      "const a = await task('a');\n" +
      "const b = await task('b');\n" +
      "const c = await task('c');\n" +
      "return [a.text, b.text, c.text];";
    await runScriptWorkflow(scriptV1, opts(v1.client, p));
    
    // v1 journal 中应包含 B1 的 task-finished（seq=1）
    const v1Lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim() !== "");
    const v1HasB1 = v1Lines.some((l) => {
      try {
        const rec = JSON.parse(l);
        return rec.type === "task-finished" && rec.seq === 1 && rec.text === "B1";
      } catch { return false; }
    });
    expect(v1HasB1).toBe(true);

    // v2: 编辑 a
    const v2 = trackedModel(["A2"]);
    const scriptV2 =
      "const a = await task('a-EDIT');\n" +
      "const b = await task('b');\n" +
      "const c = await task('c');\n" +
      "return [a.text, b.text, c.text];";
    await runScriptWorkflow(scriptV2, opts(v2.client, p, {
      resumeTasks: loadJournal(p).tasks,
    }));

    // v2 journal 中应**不**再包含 seq=1 text=B1（v1 的那条被 truncate）
    // 但应有 seq=1 text=B1（v2 的导入写入的）
    // 区别：v2 的 task-finished 之前有 task-started task-replayed 配对
    const v2Lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim() !== "");
    const v2Records = v2Lines.map((l) => JSON.parse(l));
    // 找 seq=1 的所有 task-finished
    const seq1Finishes = v2Records.filter((r) => r.type === "task-finished" && r.seq === 1);
    // 应该恰好有 1 个（v2 导入写的），且 seq=2 task-replayed
    expect(seq1Finishes.length).toBe(1);
    // 这个 task-finished 应有对应 task-replayed 标记
    const seq1Replays = v2Records.filter((r) => r.type === "task-replayed" && r.seq === 1);
    expect(seq1Replays.length).toBe(1);
    // seq=2 task-finished 也应是 1 个（c 的导入）
    const seq2Finishes = v2Records.filter((r) => r.type === "task-finished" && r.seq === 2);
    expect(seq2Finishes.length).toBe(1);
  });
});
