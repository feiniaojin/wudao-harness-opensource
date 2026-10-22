// T007 探针 5d — 显式验证异身份 task 是否截断
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput } from "@wudao/core";
import { runScriptWorkflow } from "external/packages/cli/src/workflow/engine.js";
import { journalFilePath, loadJournal, openJournal, workflowIdentity } from "external/packages/cli/src/workflow/journal.js";
import type { JsflowOptions } from "external/packages/cli/src/workflow/engine.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wf-audit-t007-5d-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true, retryDelay: 100, maxRetries: 10 }); });

const buildOpts = (journalPath: string, extra: Partial<JsflowOptions> = {}): JsflowOptions => ({
  workspaceRoot: root,
  model: undefined as unknown as ModelClient,
  journal: openJournal(journalPath),
  workflowName: "verify-truncate",
  ...extra,
});
const p = (): string => journalFilePath(root, `wf-vt-${Math.random().toString(16).slice(2, 8)}`);

describe("T007 #5d 异身份 task 截断验证", () => {
  it("5d-1: 异身份 task — identity 真的不同吗？", async () => {
    const script1 = `const t = await task('echo', {}); return t.text;`;
    const script2 = `const t = await task('echo', {}); return t.text + '!';`;
    const id1 = workflowIdentity(script1, undefined);
    const id2 = workflowIdentity(script2, undefined);
    console.log("[5d-1] id1 === id2 ?", id1.scriptHash === id2.scriptHash, id1.argsHash === id2.argsHash);
    console.log("[5d-1] id1.scriptHash:", id1.scriptHash.slice(0, 16));
    console.log("[5d-1] id2.scriptHash:", id2.scriptHash.slice(0, 16));
    expect(id1.scriptHash).not.toBe(id2.scriptHash);
  });

  it("5d-2: 异身份 + task — 跑过的事件序列", async () => {
    const script1 = `const t = await task('echo', {}); return t.text;`;
    const script2 = `const t = await task('echo', {}); return t.text + '!';`;
    const journalPath = p();

    let modelCalls = 0;
    const m: ModelClient = {
      async generate(_input: ModelInput): Promise<AssistantMessage> {
        modelCalls += 1;
        return { role: "assistant", content: "OUT_" + modelCalls };
      },
    };

    await runScriptWorkflow(script1, buildOpts(journalPath, {
      identity: workflowIdentity(script1, undefined),
      model: m,
    }));
    console.log("[5d-2] modelCalls after r1:", modelCalls);

    const loaded = loadJournal(journalPath);
    const events: string[] = [];
    const r2 = await runScriptWorkflow(
      script2,
      buildOpts(journalPath, {
        identity: workflowIdentity(script2, undefined),
        resumeIdentity: workflowIdentity(script1, undefined),
        resumeTasks: loaded.tasks, resumeCmds: loaded.cmds,
        model: m,
        onEvent: (e) => events.push(`${e.type}${("seq" in e) ? "@" + (e as { seq: number }).seq : ""}`),
      }),
    );
    console.log("[5d-2] r2.returnValue =", r2.returnValue);
    console.log("[5d-2] r2 events:", events);
    console.log("[5d-2] modelCalls after r2:", modelCalls);
    // 如果 modelCalls = 1 → 重放命中（task 没重跑）—— 异身份竟然重放命中？
    // 如果 modelCalls = 2 → task 重跑了——正常截断
    if (modelCalls === 1) {
      console.log("[5d-2] ★★★ 重大发现：异身份 + task 没有截断+重跑！");
    }
    expect(r2.ok).toBe(true);
  });

  it("5d-3: 同 identity 但 task drift（args 不同）— 应 purity 违例", async () => {
    // 同身份 scriptSource, 不同 args —— argsHash 异 → 异身份
    const script = `const t = await task('echo', {}); return t.text;`;
    const journalPath = p();

    let modelCalls = 0;
    const m: ModelClient = {
      async generate(_input: ModelInput): Promise<AssistantMessage> {
        modelCalls += 1;
        return { role: "assistant", content: "OUT_" + modelCalls };
      },
    };

    // 首跑 args = {a:1}
    await runScriptWorkflow(script, buildOpts(journalPath, {
      identity: workflowIdentity(script, { a: 1 }),
      args: { a: 1 },
      model: m,
    }));
    console.log("[5d-3] modelCalls after r1:", modelCalls);
    const loaded = loadJournal(journalPath);

    // 同 scriptSource 不同 args = 异身份（argsHash 异）
    const r2 = await runScriptWorkflow(
      script,
      buildOpts(journalPath, {
        identity: workflowIdentity(script, { a: 2 }),
        resumeIdentity: workflowIdentity(script, { a: 1 }),
        args: { a: 2 },
        resumeTasks: loaded.tasks, resumeCmds: loaded.cmds,
        model: m,
      }),
    );
    console.log("[5d-3] r2.returnValue =", r2.returnValue, "failure:", r2.failure);
    console.log("[5d-3] modelCalls after r2:", modelCalls);
  });
});
