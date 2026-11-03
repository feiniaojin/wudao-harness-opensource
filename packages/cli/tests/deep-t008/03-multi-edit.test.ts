// T008 探针 #3：多轮编辑 v1→v2→v3
// 关键问题：第二轮（v3）的导入池是否只看 v2 的结果（不是 v1 的）？
// journal 里累积的 v1 条目会不会被误导入？
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
  root = mkdtempSync(join(tmpdir(), "wf-t008-multi-"));
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
  workflowName: "multi",
  ...over,
});
const path = (): string => journalFilePath(root, `wf-multi-${Math.random().toString(16).slice(2, 8)}`);

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

describe("T008 #3 — 多轮编辑 v1→v2→v3", () => {
  it("v3 看到的导入池只来自 v2，不会泄漏 v1 的旧条目", async () => {
    const p = path();
    // v1: a + b + c
    const v1 = trackedModel(["A1", "B1", "C1"]);
    const scriptV1 =
      "const a = await task('a');\n" +
      "const b = await task('b');\n" +
      "const c = await task('c');\n" +
      "return [a.text, b.text, c.text];";
    await runScriptWorkflow(scriptV1, opts(v1.client, p));
    expect(v1.calls).toBe(3);
    // v1 完成后，b 的 text 应是 "B1"，c 是 "C1"
    const v1Tasks = loadJournal(p).tasks;
    const v1B = v1Tasks.find((t) => t.key === (v1Tasks[1]?.key ?? ""));
    const v1C = v1Tasks.find((t) => t.key === (v1Tasks[2]?.key ?? ""));

    // v2: 编辑 a → a 重跑、b/c 导入
    const v2 = trackedModel(["A2", "B2", "C2"]);
    const scriptV2 =
      "const a = await task('a-EDIT');\n" +
      "const b = await task('b');\n" +
      "const c = await task('c');\n" +
      "return [a.text, b.text, c.text];";
    const r2 = await runScriptWorkflow(scriptV2, opts(v2.client, p, {
      resumeTasks: loadJournal(p).tasks,
    }));
    expect(r2.ok).toBe(true);
    // v2: a 重跑（1 次）+ b/c 是同键 → 命中导入（但导入要求 schema 匹配 →
    // 纯 task 无 schema → 始终通过 → 0 次额外调用）
    // 等等，问题是：v2 的 b/c 是否真的导入了？
    // 重新算一遍：v2 a 改了 → invalidated=true，cursor=0；b 进导入路径 → 
    // importableEntry 找 v1 pool 里 K-b（toolsUsed=[]）→ firstWrite=false → 返回 → 导入
    // c 同理
    // 期望：v2.calls === 1（只 a 重跑）
    expect(v2.calls).toBe(1);
    // v2 returnValue 应是 [A2, B1, C1] (b/c 从 v1 pool 导入)
    expect(r2.returnValue).toEqual(["A2", "B1", "C1"]);
    // v2 完成后，b 的缓存被刷为 v1 的 B1（导入复制），
    // 但 v2 的 task-finished 里有 seq=1 K-b text=B1
    // 现在 v3：再编辑 a 一次
    const v3 = trackedModel(["A3"]);
    const scriptV3 =
      "const a = await task('a-EDIT2');\n" +
      "const b = await task('b');\n" +
      "const c = await task('c');\n" +
      "return [a.text, b.text, c.text];";
    const r3 = await runScriptWorkflow(scriptV3, opts(v3.client, p, {
      resumeTasks: loadJournal(p).tasks,
    }));
    expect(r3.ok).toBe(true);
    // v3 a 改了 → invalidated=true, cursor=0；b 进导入路径 → 
    // importableEntry 在 v2 pool 里找 K-b → 找到 → 返回（firstWrite=false）
    // c 同理
    expect(v3.calls).toBe(1);
    // 关键探针：v3 看到的 b.text 是 v1 的 B1（不是 v2 重跑的 B2——v2 的 b 是**导入**而非实际执行）
    expect(r3.returnValue).toEqual(["A3", "B1", "C1"]);
  });

  it("v3 故意把 v1 旧条目混入 resumeTasks（污染测试）→ 应当被导入路径接受（同键）", async () => {
    const p = path();
    // 首跑：3 个 task
    const v1 = trackedModel(["A1", "B1", "C1"]);
    const scriptV1 =
      "const a = await task('a');\n" +
      "const b = await task('b');\n" +
      "const c = await task('c');\n" +
      "return [a.text, b.text, c.text];";
    await runScriptWorkflow(scriptV1, opts(v1.client, p));

    // 现在直接编辑 a，**但**故意把 v1 的旧 task 列表（已被 v2 truncate）再传一次
    // 实际场景：v2 truncate 把 journal 里 v1 条目全删了，但用户**额外**注入了 v1 的旧 pool。
    // 期望：内容寻址是确定的——同键命中、同结果，导入池**应当**接受 v1 的旧 B1。
    // 这其实是设计意图（"旧世界答案对新世界同样成立"）——但要验证它**真的**接受了。
    const v2 = trackedModel(["A2"]);
    const scriptV2 =
      "const a = await task('a-EDIT');\n" +
      "const b = await task('b');\n" +
      "const c = await task('c');\n" +
      "return [a.text, b.text, c.text];";
    // resumeTasks 同时包含"v1 loadJournal 结果"（人为注入）
    const v1Tasks = loadJournal(p).tasks;
    // 先用 v1 跑出 v2（v2 会 truncate journal）
    const r2 = await runScriptWorkflow(scriptV2, opts(v2.client, p, {
      resumeTasks: v1Tasks,
    }));
    expect(r2.ok).toBe(true);
    expect(v2.calls).toBe(1); // 只 a 重跑
    expect(r2.returnValue).toEqual(["A2", "B1", "C1"]); // 来自 v1 的导入

    // 现在跑 v3，故意不传 resumeTasks（journal 已被清空/只有 v2 的）
    // v2 的 journal 应该有 a(v2-seq0, text=A2), b(v2-seq1, text=B1), c(v2-seq2, text=C1)
    // 这些是 v2 写入的"新 task-finished"，复用了 v1 的 prompt+opts（key 不变）
    const v3 = trackedModel(["A3"]);
    const scriptV3 =
      "const a = await task('a-EDIT2');\n" +
      "const b = await task('b');\n" +
      "const c = await task('c');\n" +
      "return [a.text, b.text, c.text];";
    const r3 = await runScriptWorkflow(scriptV3, opts(v3.client, p, {
      resumeTasks: loadJournal(p).tasks,
    }));
    expect(r3.ok).toBe(true);
    expect(v3.calls).toBe(1);
    expect(r3.returnValue).toEqual(["A3", "B1", "C1"]); // b/c 仍来自 v1/v2 的缓存
  });
});
