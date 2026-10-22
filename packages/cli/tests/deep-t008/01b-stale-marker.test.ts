// T008 探针 #1d：stale 拒绝后是否落 task-replayed 标记？
// 期望：仅**真正命中**（光标重放或导入成功）才写 task-replayed。
//      stale 拒绝 → 走的是真执行路径 → 应写 task-started + task-finished，
//      不应写 task-replayed。
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
  root = mkdtempSync(join(tmpdir(), "wf-t008-stale-"));
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
  workflowName: "stale",
  ...over,
});
const path = (): string => journalFilePath(root, `wf-mk-${Math.random().toString(16).slice(2, 8)}`);

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

function patchJournalEntryData(journalPath: string, seq: number, newData: unknown): void {
  const lines = readFileSync(journalPath, "utf8").split("\n").filter((l) => l.trim() !== "");
  const out: string[] = [];
  for (const line of lines) {
    const rec = JSON.parse(line);
    if (rec.type === "task-finished" && rec.seq === seq) {
      out.push(JSON.stringify({ ...rec, data: newData }));
    } else {
      out.push(line);
    }
  }
  writeFileSync(journalPath, out.join("\n") + "\n");
}

describe("T008 #1d — stale 拒绝后 journal 标记", () => {
  it("被 stale 拒绝的导入位不写 task-replayed（重跑路径）", async () => {
    const p = path();
    const S = JSON.stringify({ type: "object", properties: { v: { type: "number" } }, required: ["v"] });
    const first = trackedModel(['{"v":1}', '{"v":2}', '{"v":3}']);
    const script1 =
      `const a = await task('t1', { responseSchema: ${S} });\n` +
      `const b = await task('t2', { responseSchema: ${S} });\n` +
      `const c = await task('t3', { responseSchema: ${S} });\n` +
      `return 'ok';`;
    await runScriptWorkflow(script1, opts(first.client, p));

    patchJournalEntryData(p, 2, [1, 2, 3]);

    const second = trackedModel(['{"v":1}', '{"v":99}']);
    const script2 =
      `const a = await task('t1-EDIT', { responseSchema: ${S} });\n` +
      `const b = await task('t2', { responseSchema: ${S} });\n` +
      `const c = await task('t3', { responseSchema: ${S} });\n` +
      `return 'ok';`;
    await runScriptWorkflow(script2, opts(second.client, p, {
      resumeTasks: loadJournal(p).tasks,
    }));

    // 读 journal 第二轮（截断后追加的标记）
    // 截断后追加的有 run-started, task-started/finished 实际执行、task-replayed 命中
    const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim() !== "");
    const records = lines.map((l) => JSON.parse(l));
    const types = records.map((r) => r.type);
    // 关键探针：seq=2 应当**没有 task-replayed**（因为导入被 stale 拒绝、走真实执行）
    const seq2Replays = records.filter((r) => r.type === "task-replayed" && r.seq === 2);
    expect(seq2Replays.length).toBe(0);
    // seq=2 应该有 task-started + task-finished（真实执行）
    const seq2Started = records.filter((r) => r.type === "task-started" && r.seq === 2);
    const seq2Finished = records.filter((r) => r.type === "task-finished" && r.seq === 2);
    expect(seq2Started.length).toBeGreaterThan(0);
    expect(seq2Finished.length).toBeGreaterThan(0);
    // 顺带：seq=1 (t2) 应当有 task-replayed（导入纯项成功）
    const seq1Replays = records.filter((r) => r.type === "task-replayed" && r.seq === 1);
    expect(seq1Replays.length).toBeGreaterThan(0);
  });
});
