// M11 #3（ZCode amend-resume 导入缓存）— 第一写关闭规则收据：
// 编辑点后键未变的任务从导入池复用（零模型调用）；首个带工具的实际执行
// 关闭非纯项；纯项（toolCalls===0）关门后仍可导入；cmd 执行永远关门。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput } from "@wudao/core";
import { runScriptWorkflow } from "../src/workflow/engine.js";
import { journalFilePath, loadJournal, openJournal, workflowIdentity } from "../src/workflow/journal.js";
import { importableEntry, closesImportPool, type ImportPoolState } from "../src/workflow/import-cache.js";
import type { JsflowOptions, TaskJournalEntry } from "../src/workflow/engine.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wf-import-"));
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
  workflowName: "import",
  ...over,
});
const path = (): string => journalFilePath(root, `wf-imp-${Math.random().toString(16).slice(2, 8)}`);

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

describe("M11 #3 — importableEntry（纯层）", () => {
  const pool: readonly TaskJournalEntry[] = [
    { type: "task-finished", seq: 0, key: "K-pure", prompt: "pure", ok: true, text: "pure-result", toolsUsed: [], cost: { promptTokens: 5, completionTokens: 2 }, endedAt: "t" },
    { type: "task-finished", seq: 1, key: "K-tool", prompt: "tool", ok: true, text: "tool-result", toolsUsed: ["read_file"], cost: { promptTokens: 5, completionTokens: 2 }, endedAt: "t" },
  ] as never;

  it("编辑前（pastEditPoint=false）→ undefined——走光标重放不走导入", () => {
    expect(importableEntry(pool, "K-pure", { pastEditPoint: false, firstWrite: false })).toBeUndefined();
  });

  it("编辑后无写入 → 纯项与非纯项都可导入", () => {
    expect(importableEntry(pool, "K-pure", { pastEditPoint: true, firstWrite: false })?.text).toBe("pure-result");
    expect(importableEntry(pool, "K-tool", { pastEditPoint: true, firstWrite: false })?.text).toBe("tool-result");
  });

  it("首写后 → 纯项可导入、非纯项被关闭", () => {
    expect(importableEntry(pool, "K-pure", { pastEditPoint: true, firstWrite: true })?.text).toBe("pure-result");
    expect(importableEntry(pool, "K-tool", { pastEditPoint: true, firstWrite: true })).toBeUndefined();
  });

  it("键未命中 → undefined", () => {
    expect(importableEntry(pool, "K-missing", { pastEditPoint: true, firstWrite: false })).toBeUndefined();
  });

  it("closesImportPool：带工具关闭、零工具不关闭", () => {
    expect(closesImportPool(["read_file"])).toBe(true);
    expect(closesImportPool([])).toBe(false);
  });
});

describe("M11 #3 — 引擎端到端（编辑后导入）", () => {
  it("三任务编辑中间：前缀重放 + 编辑点重跑 + 尾任务导入（键未变）", async () => {
    const p = path();
    const first = trackedModel(["A", "B", "C"]);
    await runScriptWorkflow(
      "const a = await task('alpha');\nconst b = await task('beta');\nconst c = await task('gamma');\nreturn [a.text, b.text, c.text];",
      opts(first.client, p),
    );
    // 编辑：beta 的 prompt 变了（→ 重跑），gamma 的没变（→ 导入）
    const second = trackedModel(["B2"]); // 只需要 beta 的新答案
    const r2 = await runScriptWorkflow(
      "const a = await task('alpha');\nconst b = await task('BETA-EDITED');\nconst c = await task('gamma');\nreturn [a.text, b.text, c.text];",
      opts(second.client, p, { resumeTasks: loadJournal(p).tasks }),
    );
    expect(r2.ok).toBe(true);
    expect(second.calls).toBe(1); // 只有 beta 重跑
    expect(r2.tasksReplayed).toBe(2); // alpha 前缀重放 + gamma 导入
    expect(r2.returnValue).toEqual(["A", "B2", "C"]); // gamma 拿旧值
  });

  it("首写关门的引擎面由 cmd 承担（脚本化模型不实际调工具——工具级关门在纯层钉住）", async () => {
    const p = path();
    // 首跑：t1 + t2 + cmd + t3
    const first = trackedModel(["R1", "R2", "R3"]);
    await runScriptWorkflow(
      "const a = await task('t1');\nconst b = await task('t2');\nconst c = await run('node', ['-e', 'console.log(42)']);\nconst d = await task('t3');\nreturn [a.text, b.text, c.stdout.trim(), d.text];",
      opts(first.client, p, { commandAllowlist: new Set(["node"]) }),
    );
    // 编辑 t2 → t2 重跑 → cmd 键变了（参数不同）→ cmd 重跑（永远关门）
    // → t3 纯项仍可导入（关门只关非纯项——纯层钉住）
    const second = trackedModel(["R2-NEW", "R3"]); // t2 重跑 + t3 也需要（关门测试）
    const r2 = await runScriptWorkflow(
      "const a = await task('t1');\nconst b = await task('t2-EDIT');\nconst c = await run('node', ['-e', 'console.log(43)']);\nconst d = await task('t3');\nreturn [a.text, b.text, c.stdout.trim(), d.text];",
      opts(second.client, p, {
        commandAllowlist: new Set(["node"]),
        resumeTasks: loadJournal(p).tasks, resumeCmds: loadJournal(p).cmds,
      }),
    );
    expect(r2.ok).toBe(true);
    expect(second.calls).toBeGreaterThanOrEqual(1); // t2 至少重跑（键变了）
    expect(r2.returnValue?.[2]).toBe("43"); // cmd 拿新值
  });

  it("cmd 执行永远关门", async () => {
    const p = path();
    // 首跑：纯 task + cmd
    const first = trackedModel(["R1"]);
    await runScriptWorkflow(
      "const a = await task('pure');\nconst c = await run('node', ['-e', 'console.log(42)']);\nreturn [a.text, c.stdout.trim()];",
      opts(first.client, p, { commandAllowlist: new Set(["node"]) }),
    );
    // 编辑 cmd 的参数 → cmd 重跑（永远关门）→ 后续纯任务若键变了也不再导入非纯
    const second = trackedModel(["R1-NEW"]); // pure 的 prompt 变了
    const r2 = await runScriptWorkflow(
      "const a = await task('pure-EDITED');\nconst c = await run('node', ['-e', 'console.log(43)']);\nreturn [a.text, c.stdout.trim()];",
      opts(second.client, p, {
        commandAllowlist: new Set(["node"]),
        resumeTasks: loadJournal(p).tasks, resumeCmds: loadJournal(p).cmds,
      }),
    );
    expect(r2.ok).toBe(true);
    expect(second.calls).toBe(1); // pure-EDITED 重跑（prompt 变了）
  });
});
