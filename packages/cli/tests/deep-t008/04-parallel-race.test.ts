// T008 探针 #4：并行任务 + 导入（关门在并行分支间的竞态）
//
// **已知真实 BUG（稳定复现）**：truncate 路径在 parallel 内并发跑时，
// 单一共享 tmp 文件 `.truncating` 被多个 truncateTaskJournal 同时
// 写入/rename，后到的 rename 找不到 tmp 文件 → ENOENT → parallel 把
// 失败降级为 null。
//
// 复现：parallel 内 N 个 task（v2 多 key）——多个 task 同步触发 cursor
// mismatch → 多次 truncateTaskJournal 竞态同一 .truncating。
//
// 钉位（强制）：failures 必须包含 ENOENT/truncating 错误，且 result
// 中至少有 null（slot 降级）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput } from "@wudao-org/core";
import { runScriptWorkflow } from "../../src/workflow/engine.js";
import { journalFilePath, loadJournal, openJournal } from "../../src/workflow/journal.js";
import type { JsflowOptions } from "../../src/workflow/engine.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wf-t008-prl-"));
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
  workflowName: "prl",
  ...over,
});
const path = (): string => journalFilePath(root, `wf-prl-${Math.random().toString(16).slice(2, 8)}`);

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

describe("T008 #4 — parallel() + 导入 / TRUNCATE 竞态", () => {
  it("4-race) N=7 task 在 parallel 内（多 key）：truncate 竞态稳定触发", async () => {
    const p = path();
    const N = 7;
    const first = trackedModel(Array.from({length:N},(_,i)=>`B1-${i}`));
    const script1 =
      "const ps = await parallel([\n" +
      Array.from({length:N},(_,i)=>`  () => task('t${i}'),`).join("\n") +
      "]);\n" +
      "return ps.results.map(r => r.text);";
    await runScriptWorkflow(script1, opts(first.client, p));

    // v2: 全部改了 key → N 个 task 同步进 truncate 路径 → 竞态
    const second = trackedModel(Array.from({length:N},(_,i)=>`B2-${i}`));
    const script2 =
      "const ps = await parallel([\n" +
      Array.from({length:N},(_,i)=>`  () => task('t${i}-EDIT'),`).join("\n") +
      "]);\n" +
      "return JSON.stringify({failures: ps.failures.map(f=>f.message), results: ps.results.map(r => r === null ? null : r.text)});";
    const r2 = await runScriptWorkflow(script2, opts(second.client, p, {
      resumeTasks: loadJournal(p).tasks,
    }));
    expect(r2.ok).toBe(true);
    const parsed = JSON.parse(r2.returnValue as string);
    // **核心钉位**：failures 必须包含 ENOENT/truncating（truncate 竞态）
    const enoentFailures = (parsed.failures as string[]).filter(m =>
      m.includes("ENOENT") || m.includes("truncating")
    );
    expect(enoentFailures.length).toBe(0); // T008 α 修复后：无竞态  // 必有竞态
    // result 至少有一个 null（slot 降级）
    const nulls = (parsed.results as unknown[]).filter(r => r === null);
    expect(nulls.length).toBe(0); // T008 α 修复后：无降级
  });

  it("4-race-b) 1 个 edit + 6 个 import 在 parallel 内：truncate 竞态也触发", async () => {
    const p = path();
    const N = 7;
    const first = trackedModel(Array.from({length:N},(_,i)=>`T${i}-1`));
    const script1 =
      "const ps = await parallel([\n" +
      Array.from({length:N},(_,i)=>`  () => task('t${i}'),`).join("\n") +
      "]);\n" +
      "return ps.results.map(r => r.text);";
    await runScriptWorkflow(script1, opts(first.client, p));

    // v2: 仅 t0 改了 key；其余 6 个同键应导入
    const second = trackedModel(Array.from({length:N},(_,i)=>`T${i}-2`));
    const script2 =
      "const ps = await parallel([\n" +
      Array.from({length:N},(_,i)=>`  () => task('t${i}${i===0?"-EDIT":""}'),`).join("\n") +
      "]);\n" +
      "return JSON.stringify({failures: ps.failures.map(f=>f.message), results: ps.results.map(r => r === null ? null : r.text)});";
    const r2 = await runScriptWorkflow(script2, opts(second.client, p, {
      resumeTasks: loadJournal(p).tasks,
    }));
    expect(r2.ok).toBe(true);
    const parsed = JSON.parse(r2.returnValue as string);
    // 关键：t0 触发 truncate；t1..t6 cursor mismatch 也触发 truncate → 竞态
    const enoentFailures = (parsed.failures as string[]).filter(m =>
      m.includes("ENOENT") || m.includes("truncating")
    );
    expect(enoentFailures.length).toBe(0); // T008 α 修复后：无竞态
  });

  it("4-ok) 纯导入（无 edit）在 parallel 内：不应触发 truncate 竞态", async () => {
    const p = path();
    const N = 7;
    const first = trackedModel(Array.from({length:N},(_,i)=>`T${i}-1`));
    const script1 =
      "const ps = await parallel([\n" +
      Array.from({length:N},(_,i)=>`  () => task('t${i}'),`).join("\n") +
      "]);\n" +
      "return ps.results.map(r => r.text);";
    await runScriptWorkflow(script1, opts(first.client, p));

    const second = trackedModel(["A2"]);
    const script2 =
      "const a = await task('a-NEW');\n" +
      "const ps = await parallel([\n" +
      Array.from({length:N},(_,i)=>`  () => task('t${i}'),`).join("\n") +
      "]);\n" +
      "return JSON.stringify({failCount: ps.failures.length, results: ps.results.map(r => r === null ? null : r.text).sort()});";
    const r2 = await runScriptWorkflow(script2, opts(second.client, p, {
      resumeTasks: loadJournal(p).tasks,
    }));
    expect(r2.ok).toBe(true);
    const parsed = JSON.parse(r2.returnValue as string);
    expect(parsed.failCount).toBe(0); // 0 failures
    expect(parsed.results.length).toBe(N);
    expect(parsed.results.every((t:string)=>t.endsWith("-1"))).toBe(true);
    expect(second.calls).toBe(1); // 仅 a 重跑
  });
});
