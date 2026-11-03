// T008 探针 #1：导入池的 stale 数据绕过
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
const path = (): string => journalFilePath(root, `wf-stale-${Math.random().toString(16).slice(2, 8)}`);

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

function stripJournalEntryData(journalPath: string, seq: number): void {
  const lines = readFileSync(journalPath, "utf8").split("\n").filter((l) => l.trim() !== "");
  const out: string[] = [];
  for (const line of lines) {
    const rec = JSON.parse(line);
    if (rec.type === "task-finished" && rec.seq === seq) {
      const { data: _data, ...rest } = rec;
      out.push(JSON.stringify(rest));
    } else {
      out.push(line);
    }
  }
  writeFileSync(journalPath, out.join("\n") + "\n");
}

describe("T008 #1 — 导入池 stale 数据绕过", () => {
  it("1a) 嵌套字段类型不符 → 编辑后导入路径应拒绝（重跑而非吃 stale）", async () => {
    const p = path();
    const S = JSON.stringify({
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: { tags: { type: "array", items: { type: "string" } } },
          required: ["tags"],
        },
      },
      required: ["nested"],
    });

    const first = trackedModel([
      '{"nested":{"tags":["a","b"]}}',
      '{"nested":{"tags":["c"]}}',
      '{"nested":{"tags":["d","e"]}}',
    ]);
    const script1 =
      `const a = await task('t1', { responseSchema: ${S} });\n` +
      `const b = await task('t2', { responseSchema: ${S} });\n` +
      `const c = await task('t3', { responseSchema: ${S} });\n` +
      `return JSON.stringify([a.data, b.data, c.data]);`;
    const r1 = await runScriptWorkflow(script1, opts(first.client, p));
    expect(r1.ok).toBe(true);
    expect(first.calls).toBe(3);

    // 手改 journal：seq=2 (即 t3) 的 data 让 nested.tags 变成数字
    patchJournalEntryData(p, 2, { nested: { tags: [1, 2] } });

    // 编辑 t1 → t1 重跑、t2 命中（导入纯项 OK）、t3 走导入（被 stale 拒绝 → 重跑）
    const second = trackedModel([
      '{"nested":{"tags":["a-NEW"]}}',     // t1 重跑
      '{"nested":{"tags":["c","d","e"]}}', // t3 重跑（导入被拒绝）
    ]);
    const script2 =
      `const a = await task('t1-EDIT', { responseSchema: ${S} });\n` +
      `const b = await task('t2', { responseSchema: ${S} });\n` +
      `const c = await task('t3', { responseSchema: ${S} });\n` +
      `return JSON.stringify([a.data, b.data, c.data]);`;
    const r2 = await runScriptWorkflow(script2, opts(second.client, p, {
      resumeTasks: loadJournal(p).tasks,
    }));
    expect(r2.ok).toBe(true);
    // 关键探针：stale 的 t3 必须**重跑**（2 次调用）——不能吃 [1,2]
    expect(second.calls).toBe(2);
    // t2 是纯项 → 应被导入（计入 tasksReplayed）
    expect(r2.tasksReplayed).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(r2.returnValue as string);
    expect(parsed[2].nested.tags).not.toEqual([1, 2]); // 没吸进 stale 的数字
    expect(parsed[2].nested.tags).toEqual(["c","d","e"]); // 来自新调用
  });

  it("1b) 根类型不符（object→array） → 导入拒绝 + 重跑", async () => {
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
    expect(second.calls).toBe(2); // t1 重跑 + t3 重跑（拒绝导入）
  });

  it("1c) cache 抹掉 data 字段 → 导入拒绝 + 重跑", async () => {
    const p = path();
    const S = JSON.stringify({ type: "object", properties: { v: { type: "number" } }, required: ["v"] });
    const first = trackedModel(['{"v":1}', '{"v":2}', '{"v":3}']);
    const script1 =
      `const a = await task('t1', { responseSchema: ${S} });\n` +
      `const b = await task('t2', { responseSchema: ${S} });\n` +
      `const c = await task('t3', { responseSchema: ${S} });\n` +
      `return 'ok';`;
    await runScriptWorkflow(script1, opts(first.client, p));

    stripJournalEntryData(p, 2);

    const second = trackedModel(['{"v":1}', '{"v":99}']);
    const script2 =
      `const a = await task('t1-EDIT', { responseSchema: ${S} });\n` +
      `const b = await task('t2', { responseSchema: ${S} });\n` +
      `const c = await task('t3', { responseSchema: ${S} });\n` +
      `return 'ok';`;
    await runScriptWorkflow(script2, opts(second.client, p, {
      resumeTasks: loadJournal(p).tasks,
    }));
    expect(second.calls).toBe(2);
  });
});
