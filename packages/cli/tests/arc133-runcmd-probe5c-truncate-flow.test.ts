// T007 探针 5c — 异身份 resume 的截断流
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput } from "@wudao-org/core";
import { runScriptWorkflow } from "../src/workflow/engine.js";
import { journalFilePath, loadJournal, openJournal, workflowIdentity } from "../src/workflow/journal.js";
import type { JsflowOptions } from "../src/workflow/engine.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wf-audit-t007-5c-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true, retryDelay: 100, maxRetries: 10 }); });

const buildOpts = (journalPath: string, extra: Partial<JsflowOptions> = {}): JsflowOptions => ({
  workspaceRoot: root,
  model: undefined as unknown as ModelClient,
  journal: openJournal(journalPath),
  workflowName: "truncate-flow",
  ...extra,
});
const p = (): string => journalFilePath(root, `wf-tf-${Math.random().toString(16).slice(2, 8)}`);

describe("T007 #5c 异身份截断流", () => {
  it("5c-1: 异身份 + 单 task → 监听 onEvent 'journal-truncated'", async () => {
    const script1 = `const t = await task('echo', {}); return t.text;`;
    const script2 = `const t = await task('echo', {}); return t.text + '!';`;
    const journalPath = p();

    let modelCalls: string[] = [];
    const firstModel: ModelClient = {
      async generate(_input: ModelInput): Promise<AssistantMessage> {
        modelCalls.push("firstModel");
        return { role: "assistant", content: "FIRST" };
      },
    };
    const events: string[] = [];
    const r1 = await runScriptWorkflow(script1, buildOpts(journalPath, {
      identity: workflowIdentity(script1, undefined),
      model: firstModel,
      onEvent: (e) => events.push(`r1:${e.type}`),
    }));
    console.log("[5c-1] r1.returnValue =", r1.returnValue);
    console.log("[5c-1] r1 events:", events);

    const loaded = loadJournal(journalPath);
    const secondModel: ModelClient = {
      async generate(_input: ModelInput): Promise<AssistantMessage> {
        modelCalls.push("secondModel");
        return { role: "assistant", content: "SECOND" };
      },
    };
    const events2: string[] = [];
    const r2 = await runScriptWorkflow(
      script2,
      buildOpts(journalPath, {
        identity: workflowIdentity(script2, undefined),
        resumeIdentity: workflowIdentity(script1, undefined),
        resumeTasks: loaded.tasks, resumeCmds: loaded.cmds,
        model: secondModel,
        onEvent: (e) => events2.push(`r2:${e.type}`),
      }),
    );
    console.log("[5c-1] r2.returnValue =", r2.returnValue);
    console.log("[5c-1] r2 events:", events2);
    console.log("[5c-1] modelCalls:", modelCalls);
    // 看 onEvent 是否发出 journal-truncated
    const truncated = events2.filter((e) => e.includes("truncated"));
    console.log("[5c-1] truncated 事件:", truncated);
  });
});
