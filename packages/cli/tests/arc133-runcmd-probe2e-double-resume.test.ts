// T007 探针 2e — 同身份 resume 两次：partial cmds 后再 resume，第二次的 cmd-replayed 命中哪一条？
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient } from "@wudao/core";
import { runScriptWorkflow } from "external/packages/cli/src/workflow/engine.js";
import { journalFilePath, loadJournal, openJournal, workflowIdentity } from "external/packages/cli/src/workflow/journal.js";
import type { JsflowOptions } from "external/packages/cli/src/workflow/engine.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wf-audit-t007-2e-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true, retryDelay: 100, maxRetries: 10 }); });

const noCallModel: ModelClient = {
  async generate(): Promise<AssistantMessage> { throw new Error("no model"); },
};
const buildOpts = (journalPath: string, extra: Partial<JsflowOptions> = {}): JsflowOptions => ({
  workspaceRoot: root, model: noCallModel, journal: openJournal(journalPath),
  workflowName: "double-resume", ...extra,
});
const p = (): string => journalFilePath(root, `wf-dr-${Math.random().toString(16).slice(2, 8)}`);

describe("T007 #2e double resume", () => {
  it("2e: 第二次 resume 全部命中（无副作用）", async () => {
    const script = `
await run('node', ['-e', 'console.log(1)']);
await run('node', ['-e', 'console.log(2)']);
return 'ok';
`;
    const identity = workflowIdentity(script, undefined);
    const journalPath = p();

    // 首跑
    const r1 = await runScriptWorkflow(script, buildOpts(journalPath, { commandAllowlist: new Set(["node"]), identity }));
    expect(r1.returnValue).toBe("ok");

    // partial resume：只有 1 cmd
    const loaded = loadJournal(journalPath);
    const r2 = await runScriptWorkflow(
      script,
      buildOpts(journalPath, {
        commandAllowlist: new Set(["node"]),
        identity, resumeIdentity: identity,
        resumeTasks: loaded.tasks, resumeCmds: loaded.cmds.slice(0, 1),
      }),
    );
    expect(r2.ok).toBe(true);

    // 第二次 resume：完整 2 cmd 都给
    const loaded2 = loadJournal(journalPath);
    console.log("[2e] 第二次 resume 前: cmd-finished =", loaded2.records.filter((r) => r.type === "cmd-finished").length);
    const r3 = await runScriptWorkflow(
      script,
      buildOpts(journalPath, {
        commandAllowlist: new Set(["node"]),
        identity, resumeIdentity: identity,
        resumeTasks: loaded2.tasks, resumeCmds: loaded2.cmds,
      }),
    );
    expect(r3.ok).toBe(true);
    expect(r3.returnValue).toBe("ok");

    const loaded3 = loadJournal(journalPath);
    const cmdReplayedAll = loaded3.records.filter((r) => r.type === "cmd-replayed");
    console.log("[2e] 3 次跑后 cmd-replayed 总数:", cmdReplayedAll.length);
    // 期望 2+1+2 = 5? 不，partial resume 第二次只放 1 cmd-replayed；
    // 第 2 次 resume 放 2 cmd-replayed
    // 总: 1 + 2 = 3? 但 partial resume 也产生 cmd-replayed
    // 序列: [首跑 0 cmd-replayed, partial 1 cmd-replayed, 完整 2 cmd-replayed] = 3 cmd-replayed
    expect(cmdReplayedAll.length).toBe(3);
  });
});
