// T007 探针 1 — 并发 seq 竞态（强化版：多轮次+更多 sleep 梯度）
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput } from "@wudao/core";
import { runScriptWorkflow } from "/Users/qinyujie/xdev/github/wudao-harness-project/wudao-harness/packages/cli/src/workflow/engine.js";
import { journalFilePath, loadJournal, openJournal, workflowIdentity } from "/Users/qinyujie/xdev/github/wudao-harness-project/wudao-harness/packages/cli/src/workflow/journal.js";
import type { JsflowOptions } from "/Users/qinyujie/xdev/github/wudao-harness-project/wudao-harness/packages/cli/src/workflow/engine.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wf-audit-t007-1-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true, retryDelay: 100, maxRetries: 10 }); });

const noCallModel: ModelClient = {
  async generate(): Promise<AssistantMessage> { throw new Error("no model"); },
};
const buildOpts = (journalPath: string, extra: Partial<JsflowOptions> = {}): JsflowOptions => ({
  workspaceRoot: root, model: noCallModel, journal: openJournal(journalPath),
  workflowName: "race-cmd-seq", ...extra,
});
const p = (): string => journalFilePath(root, `wf-race-${Math.random().toString(16).slice(2, 8)}`);

describe("T007 #1 并发 seq 竞态", () => {
  it("1a: 8 路 parallel run() — file-append 乱序，但 seq 排序后正确对位 call-order", async () => {
    // 8 路：每个 sleep 不同毫秒，确保完成序与 call-order 不同
    const delays = [200, 30, 80, 10, 150, 60, 110, 40];
    const labels = ["L0", "L1", "L2", "L3", "L4", "L5", "L6", "L7"];
    const fnsJs = delays.map((d, i) => `() => run('node', ['-e', 'setTimeout(()=>console.log("${labels[i]}"),${d})'])`).join(",\n  ");
    const script = `const fns = [\n  ${fnsJs}\n];\nconst r = await parallel(fns);\nreturn r.results.map(x => x.stdout.trim());\n`;
    const journalPath = p();
    const res = await runScriptWorkflow(script, buildOpts(journalPath, { commandAllowlist: new Set(["node"]) }));
    expect(res.ok).toBe(true);

    const loaded = loadJournal(journalPath);
    const fileOrderRecords = loaded.records.filter((r) => r.type === "cmd-finished") as Array<{ seq: number; stdout: string }>;
    console.log("[file 顺序 cmd-finished]:");
    for (const r of fileOrderRecords) console.log("  seq=" + r.seq, "label=" + r.stdout.trim());
    console.log("[loadJournal.cmds 排序后]:");
    for (const c of loaded.cmds) console.log("  seq=" + c.seq, "label=" + c.stdout.trim());

    // 三条 cmd，seq 必然 0..7
    expect(loaded.cmds.length).toBe(8);
    const seqs = loaded.cmds.map((c) => c.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // call-order 对应 script 字面顺序
    for (let i = 0; i < 8; i++) {
      expect(loaded.cmds.find((c) => c.seq === i)?.stdout.trim()).toBe(labels[i]);
    }
    // file 顺序至少要 ≠ seq 顺序（验证乱序）
    const fileSeqs = fileOrderRecords.map((r) => r.seq);
    const identical = fileSeqs.every((s, i) => s === i);
    expect(identical).toBe(false); // 必然乱序：完成序是从短到短
  });

  it("1b: resume 重放 — cmd-replayed seq 与原 cmd-finished seq 对齐 + 零派生", async () => {
    const delays = [200, 30, 80, 10, 150, 60, 110, 40];
    const labels = ["L0", "L1", "L2", "L3", "L4", "L5", "L6", "L7"];
    const fnsJs = delays.map((d, i) => `() => run('node', ['-e', 'setTimeout(()=>console.log("${labels[i]}"),${d})'])`).join(",\n  ");
    const script = `const fns = [\n  ${fnsJs}\n];\nconst r = await parallel(fns);\nreturn r.results.map(x => x.stdout.trim());\n`;
    const identity = workflowIdentity(script, undefined);
    const journalPath = p();
    const r1 = await runScriptWorkflow(script, buildOpts(journalPath, { commandAllowlist: new Set(["node"]), identity }));
    expect(r1.ok).toBe(true);

    let modelCalled = 0;
    const watchModel: ModelClient = {
      async generate(_input: ModelInput): Promise<AssistantMessage> {
        modelCalled += 1;
        throw new Error("REPLAY BUG: cmd 没命中");
      },
    };
    const loaded = loadJournal(journalPath);
    const r2 = await runScriptWorkflow(
      script,
      buildOpts(journalPath, {
        commandAllowlist: new Set(["node"]),
        identity,
        resumeIdentity: identity,
        resumeTasks: loaded.tasks,
        resumeCmds: loaded.cmds,
        model: watchModel,
      }),
    );
    expect(r2.ok).toBe(true);
    expect(modelCalled).toBe(0);
    expect(r2.returnValue).toEqual(r1.returnValue);

    const after = loadJournal(journalPath);
    const replayed = after.records.filter((r) => r.type === "cmd-replayed") as Array<{ seq: number; key: string }>;
    expect(replayed.length).toBe(8);
    const replayedSeqs = replayed.map((r) => r.seq).sort((a, b) => a - b);
    expect(replayedSeqs).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // key 对应
    for (const rep of replayed) {
      const orig = loaded.cmds.find((c) => c.seq === rep.seq);
      expect(orig).toBeDefined();
      expect(rep.key).toBe(orig?.key);
    }
  });

  it("1c: 同身份但调用序变化（异调用序应被截断——异身份编辑语义）", async () => {
    // 首跑：seq 0=CMD_A, seq 1=CMD_B
    const scriptA = `
const r0 = await run('node', ['-e', 'console.log("A")']);
const r1 = await run('node', ['-e', 'console.log("B")']);
return [r0.stdout.trim(), r1.stdout.trim()];
`;
    // 二跑：同样两个 run，但顺序倒过来（异身份，因为脚本字节变了）
    const scriptB = `
const r0 = await run('node', ['-e', 'console.log("B")']);
const r1 = await run('node', ['-e', 'console.log("A")']);
return [r0.stdout.trim(), r1.stdout.trim()];
`;
    const journalPath = p();
    const idA = workflowIdentity(scriptA, undefined);
    const r1 = await runScriptWorkflow(scriptA, buildOpts(journalPath, { commandAllowlist: new Set(["node"]), identity: idA }));
    expect(r1.ok).toBe(true);
    expect(r1.returnValue).toEqual(["A", "B"]);

    // resume 用 scriptB——异身份（scriptHash 不同）→ 截断
    const idB = workflowIdentity(scriptB, undefined);
    const loaded = loadJournal(journalPath);
    const r2 = await runScriptWorkflow(
      scriptB,
      buildOpts(journalPath, {
        commandAllowlist: new Set(["node"]),
        identity: idB,
        resumeIdentity: idA,
        resumeTasks: loaded.tasks,
        resumeCmds: loaded.cmds,
      }),
    );
    expect(r2.ok).toBe(true); // 异身份 = 截断后重跑
    expect(r2.returnValue).toEqual(["B", "A"]);
  });
});
