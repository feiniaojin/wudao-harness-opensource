// 133 #3（a reference harness journal 身份模型，M11 线第一弧）— 运行身份 + 纯度违例
// 检测收据。四象限：同身份+键漂移=大声失败（journal 不截断）/异身份（脚本
// 或参数编辑）=既有截断语义/旧日志无身份=fail-open 截断/同身份+键一致=
// 全重放零误伤。附 workflowIdentity 的稳定性单测。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput } from "@wudao-org/core";
import { runScriptWorkflow } from "../src/workflow/engine.js";
import { journalFilePath, loadJournal, openJournal, workflowIdentity, taskKey } from "../src/workflow/journal.js";
import type { JsflowOptions } from "../src/workflow/engine.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wf-purity-"));
  writeFileSync(join(root, "note.txt"), "x");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  delete (globalThis as Record<string, unknown>).__wudaoDrift;
});

function scriptedModel(script: readonly AssistantMessage[]): { client: ModelClient; calls: number } {
  let i = 0;
  return {
    get calls() { return i; },
    client: {
      async generate(input: ModelInput): Promise<AssistantMessage> {
        const next = script[i];
        i += 1;
        input.onUsage?.({ promptTokens: 10, cacheHitTokens: 0, cacheMissTokens: 10, completionTokens: 5 });
        if (next === undefined) throw new Error("scripted responses exhausted");
        return next;
      },
    },
  };
}
const say = (content: string): AssistantMessage => ({ role: "assistant", content });

const opts = (model: ModelClient, journalPath: string, over: Partial<JsflowOptions> = {}): JsflowOptions => ({
  workspaceRoot: root,
  model,
  journal: openJournal(journalPath),
  workflowName: "purity",
  ...over,
});

/** 读全局态的脚本——绊线（Date/Math.random）不覆盖 globalThis 读取，这是
 *  现实中非确定性泄漏的形状（读文件/网络/全局同理）。 */
const DRIFT_SCRIPT = "const a = await task('topic ' + globalThis.__wudaoDrift); return a.text;";

describe("workflowIdentity（纯层）", () => {
  it("脚本字节与参数规范形各一哈希；args 键序无关、undefined≠{}", () => {
    const a = workflowIdentity("task('x')", { p: 1, q: { b: 2, a: 3 } });
    const b = workflowIdentity("task('x')", { q: { a: 3, b: 2 }, p: 1 });
    expect(a).toEqual(b);
    expect(workflowIdentity("task('x')", undefined).argsHash).not.toBe(workflowIdentity("task('x')", {}).argsHash);
    expect(workflowIdentity("task('x')", undefined).scriptHash).toBe(workflowIdentity("task('x')", undefined).scriptHash);
    expect(workflowIdentity("task('y')", undefined).scriptHash).not.toBe(workflowIdentity("task('x')", undefined).scriptHash);
  });

  it("loadJournal 读回首条带身份的 run-started；旧日志 → undefined", async () => {
    const path = journalFilePath(root, `wf-id-${Math.random().toString(16).slice(2, 8)}`);
    const model = scriptedModel([say("ok")]);
    const identity = workflowIdentity(DRIFT_SCRIPT, undefined);
    await runScriptWorkflow(DRIFT_SCRIPT, opts(model.client, path, { identity }));
    const loaded = loadJournal(path);
    expect(loaded.identity).toEqual(identity);
    // 手造旧形（无身份字段的 run-started）→ identity undefined
    const legacyPath = journalFilePath(root, `wf-legacy-${Math.random().toString(16).slice(2, 8)}`);
    const legacyJournal = openJournal(legacyPath);
    await legacyJournal.append({ type: "run-started", runId: "wf-legacy", workflow: "purity", startedAt: "t" });
    expect(loadJournal(legacyPath).identity).toBeUndefined();
  });
});

describe("133 #3 — 纯度四象限（engine 端到端）", () => {
  it("①同身份+键漂移 → purity-violation 大声失败，journal 不截断", async () => {
    const path = journalFilePath(root, `wf-q1-${Math.random().toString(16).slice(2, 8)}`);
    (globalThis as Record<string, unknown>).__wudaoDrift = "alpha";
    const first = scriptedModel([say("answer-a")]);
    const identity = workflowIdentity(DRIFT_SCRIPT, undefined);
    const r1 = await runScriptWorkflow(DRIFT_SCRIPT, opts(first.client, path, { identity }));
    expect(r1.ok).toBe(true);
    const originalEntries = loadJournal(path).tasks;

    // 同脚本同参数 resume，但全局态变了 → seq0 键漂移
    (globalThis as Record<string, unknown>).__wudaoDrift = "beta";
    const second = scriptedModel([say("answer-b")]);
    const r2 = await runScriptWorkflow(
      DRIFT_SCRIPT,
      opts(second.client, path, { identity, resumeIdentity: identity, resumeTasks: originalEntries }),
    );
    expect(r2.ok).toBe(false);
    expect(r2.failure?.category).toBe("purity-violation");
    expect(r2.failure?.message).toContain("call #1");
    expect(r2.failure?.message).toContain("nondeterministic");
    // 绝不静默偏移：journal 未被截断——原 ok 条目仍在（污染前缀不被掩盖）
    expect(loadJournal(path).tasks.length).toBeGreaterThanOrEqual(originalEntries.length);
    expect(loadJournal(path).tasks[0]?.key).toBe(originalEntries[0]?.key);
  });

  it("②异身份（脚本编辑）→ 既有截断语义：前缀保留、编辑点起重跑", async () => {
    const path = journalFilePath(root, `wf-q2-${Math.random().toString(16).slice(2, 8)}`);
    const first = scriptedModel([say("one"), say("two")]);
    const scriptV1 = "const a = await task('first');\nconst b = await task('second');\nreturn [a.text, b.text];";
    const r1 = await runScriptWorkflow(scriptV1, opts(first.client, path, { identity: workflowIdentity(scriptV1, undefined) }));
    expect(r1.ok).toBe(true);
    // 编辑：改第二个任务的 prompt → seq1 处键漂移，且 scriptHash 不同
    const scriptV2 = "const a = await task('first');\nconst b = await task('SECOND-EDITED');\nreturn [a.text, b.text];";
    const second = scriptedModel([say("two-edited")]);
    let truncatedEvent = false;
    const r2 = await runScriptWorkflow(
      scriptV2,
      opts(second.client, path, {
        identity: workflowIdentity(scriptV2, undefined),
        resumeIdentity: workflowIdentity(scriptV1, undefined),
        resumeTasks: loadJournal(path).tasks,
        onEvent: (e) => { if ((e as { type: string }).type === "journal-truncated") truncatedEvent = true; },
      }),
    );
    expect(r2.ok).toBe(true);
    expect(truncatedEvent).toBe(true);
    expect(r2.tasksReplayed).toBe(1); // 前缀 task('first') 命中重放
    expect(r2.returnValue).toEqual(["one", "two-edited"]);
  });

  it("③旧日志（无身份戳）→ fail-open：键漂移按编辑截断（旧行为不变）", async () => {
    const path = journalFilePath(root, `wf-q3-${Math.random().toString(16).slice(2, 8)}`);
    const first = scriptedModel([say("one")]);
    const scriptV1 = "const a = await task('first');\nreturn a.text;";
    await runScriptWorkflow(scriptV1, opts(first.client, path)); // 无 identity（旧调用形状）
    // 换 prompt 的同形脚本 → 截断重跑（不抛 purity）
    const scriptV2 = "const a = await task('EDITED');\nreturn a.text;";
    const second = scriptedModel([say("edited")]);
    const r2 = await runScriptWorkflow(scriptV2, opts(second.client, path, { resumeTasks: loadJournal(path).tasks }));
    expect(r2.ok).toBe(true);
    expect(r2.failure?.category).not.toBe("purity-violation");
  });

  it("④同身份+键一致 → 全重放零模型调用（无误伤）", async () => {
    const path = journalFilePath(root, `wf-q4-${Math.random().toString(16).slice(2, 8)}`);
    (globalThis as Record<string, unknown>).__wudaoDrift = "stable";
    const first = scriptedModel([say("cached")]);
    const identity = workflowIdentity(DRIFT_SCRIPT, undefined);
    await runScriptWorkflow(DRIFT_SCRIPT, opts(first.client, path, { identity }));
    // resume：全局态不变（键稳定）
    const second = scriptedModel([]);
    const r2 = await runScriptWorkflow(
      DRIFT_SCRIPT,
      opts(second.client, path, { identity, resumeIdentity: identity, resumeTasks: loadJournal(path).tasks }),
    );
    expect(r2.ok).toBe(true);
    expect(second.calls).toBe(0);
    expect(r2.tasksReplayed).toBe(1);
    expect(r2.returnValue).toBe("cached");
  });

  it("run-started 落身份戳（journal 字节面可见）", async () => {
    const path = journalFilePath(root, `wf-stamp-${Math.random().toString(16).slice(2, 8)}`);
    const model = scriptedModel([say("ok")]);
    const identity = workflowIdentity("return 1;", { k: 1 });
    await runScriptWorkflow("return 1;", opts(model.client, path, { identity, args: { k: 1 } }));
    const started = loadJournal(path).records.find((r) => r.type === "run-started") as { scriptHash?: string; argsHash?: string };
    expect(started.scriptHash).toBe(identity.scriptHash);
    expect(started.argsHash).toBe(identity.argsHash);
  });
});
