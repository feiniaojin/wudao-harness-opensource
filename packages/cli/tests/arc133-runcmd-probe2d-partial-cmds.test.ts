// T007 探针 2d — partial cmd 重放：仅前 N 个 cmd 在 resumeCmds 中
// 验证后续 cmd 的 journal 状态
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient } from "@wudao-org/core";
import { runScriptWorkflow } from "../src/workflow/engine.js";
import { journalFilePath, loadJournal, openJournal, workflowIdentity } from "../src/workflow/journal.js";
import type { JsflowOptions } from "../src/workflow/engine.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wf-audit-t007-2d-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true, retryDelay: 100, maxRetries: 10 }); });

const noCallModel: ModelClient = {
  async generate(): Promise<AssistantMessage> { throw new Error("no model"); },
};
const buildOpts = (journalPath: string, extra: Partial<JsflowOptions> = {}): JsflowOptions => ({
  workspaceRoot: root, model: noCallModel, journal: openJournal(journalPath),
  workflowName: "partial-cmds", ...extra,
});
const p = (): string => journalFilePath(root, `wf-pc-${Math.random().toString(16).slice(2, 8)}`);

describe("T007 #2d partial cmd 重放", () => {
  it("2d: 同身份 + 2 cmd, resumeCmds 只给 1 个——第 2 个是 cmd-replayed 还是新 cmd-finished?", async () => {
    const script = `
await run('node', ['-e', 'console.log(1)']);
await run('node', ['-e', 'console.log(2)']);
return 'ok';
`;
    const identity = workflowIdentity(script, undefined);
    const journalPath = p();
    const r1 = await runScriptWorkflow(script, buildOpts(journalPath, { commandAllowlist: new Set(["node"]), identity }));
    expect(r1.returnValue).toBe("ok");

    const loaded = loadJournal(journalPath);
    console.log("[2d] 首跑 journal 中 cmd 数:", loaded.cmds.length);

    // 只给第 1 个 cmd
    const partialCmds = loaded.cmds.slice(0, 1);
    const r2 = await runScriptWorkflow(
      script,
      buildOpts(journalPath, {
        commandAllowlist: new Set(["node"]),
        identity, resumeIdentity: identity,
        resumeTasks: loaded.tasks, resumeCmds: partialCmds,
      }),
    );
    console.log("[2d] r2.ok =", r2.ok, "failure =", r2.failure);
    expect(r2.ok).toBe(true);

    const after = loadJournal(journalPath);
    const cmdFinished = after.records.filter((r) => r.type === "cmd-finished");
    const cmdReplayed = after.records.filter((r) => r.type === "cmd-replayed");
    console.log("[2d] 二跑后: cmd-finished =", cmdFinished.length, "cmd-replayed =", cmdReplayed.length);
    console.log("[2d] records 类型序列:", after.records.map((r) => r.type));
    // 期望：第 1 个 cmd-replayed (命中)，第 2 个是新 cmd-finished（实际跑了 node）
    expect(cmdReplayed.length).toBe(1);
    expect(cmdFinished.length).toBe(3); // 原 2 + 新 1 (但 seq 重叠)
    const replayedEntry = cmdReplayed[0] as { seq: number; key: string };
    expect(replayedEntry.seq).toBe(0);
  });
});
