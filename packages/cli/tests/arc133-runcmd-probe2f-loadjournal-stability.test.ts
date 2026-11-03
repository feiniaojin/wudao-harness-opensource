// T007 探针 2f — loadJournal.cmds 同 seq 时的稳定性
// partial resume 让 journal 有 seq=1 的两条 cmd-finished
// 验证 loadJournal.cmds 排序后取哪一条（第一条还是最后一条？）
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient } from "@wudao-org/core";
import { runScriptWorkflow } from "~/xdev/github/wudao-harness-project/wudao-harness/packages/cli/src/workflow/engine.js";
import { journalFilePath, loadJournal, openJournal, workflowIdentity } from "~/xdev/github/wudao-harness-project/wudao-harness/packages/cli/src/workflow/journal.js";
import type { JsflowOptions } from "~/xdev/github/wudao-harness-project/wudao-harness/packages/cli/src/workflow/engine.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wf-audit-t007-2f-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true, retryDelay: 100, maxRetries: 10 }); });

const noCallModel: ModelClient = {
  async generate(): Promise<AssistantMessage> { throw new Error("no model"); },
};
const buildOpts = (journalPath: string, extra: Partial<JsflowOptions> = {}): JsflowOptions => ({
  workspaceRoot: root, model: noCallModel, journal: openJournal(journalPath),
  workflowName: "loadjournal-stability", ...extra,
});
const p = (): string => journalFilePath(root, `wf-ls-${Math.random().toString(16).slice(2, 8)}`);

describe("T007 #2f loadJournal 稳定性", () => {
  it("2f: 同 seq 多条 cmd-finished 时 cmds 排序的稳定性", async () => {
    // 设计：让两次 resume 都产生 seq=1 的 cmd-finished
    // 但 partial resume 的 cmd-finished 顺序：原 run-finished 后 partial cmd-replayed(seq=0) + new cmd-finished(seq=1)
    // 第二次完整 resume：cursor++ 到 seq=1 命中那条 cmd-finished
    // 让我们先看简单情况：两次完整 resume 是否会让 journal 累积 seq=0,1 各两条？
    const script = `
await run('node', ['-e', 'console.log(1)']);
return 'ok';
`;
    const identity = workflowIdentity(script, undefined);
    const journalPath = p();

    const r1 = await runScriptWorkflow(script, buildOpts(journalPath, { commandAllowlist: new Set(["node"]), identity }));
    expect(r1.returnValue).toBe("ok");

    // 第一次 resume：完整给
    const loaded = loadJournal(journalPath);
    const r2 = await runScriptWorkflow(
      script,
      buildOpts(journalPath, {
        commandAllowlist: new Set(["node"]),
        identity, resumeIdentity: identity,
        resumeTasks: loaded.tasks, resumeCmds: loaded.cmds,
      }),
    );
    expect(r2.ok).toBe(true);

    // 第二次 resume：再给
    const loaded2 = loadJournal(journalPath);
    console.log("[2f] 2 次跑后 cmd-finished:", loaded2.records.filter((r) => r.type === "cmd-finished").length);
    console.log("[2f] loadJournal.cmds:", loaded2.cmds.map((c) => ({ seq: c.seq, ended: c.endedAt })));
    const r3 = await runScriptWorkflow(
      script,
      buildOpts(journalPath, {
        commandAllowlist: new Set(["node"]),
        identity, resumeIdentity: identity,
        resumeTasks: loaded2.tasks, resumeCmds: loaded2.cmds,
      }),
    );
    expect(r3.ok).toBe(true);
    const loaded3 = loadJournal(journalPath);
    console.log("[2f] 3 次跑后 cmd-finished:", loaded3.records.filter((r) => r.type === "cmd-finished").length);
    console.log("[2f] loadJournal.cmds:", loaded3.cmds.map((c) => ({ seq: c.seq, ended: c.endedAt })));
    // 期望：第 2 次 resume 后 cmd-finished=1, cmd-replayed=1
    // 第 3 次 resume 后 cmd-finished=1（不会重写）, cmd-replayed=2
    // 但实际可能累积？看实际输出
  });
});
