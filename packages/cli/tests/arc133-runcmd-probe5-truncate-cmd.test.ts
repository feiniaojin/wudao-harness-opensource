// T007 探针 5 — truncateTaskJournal 与 cmd 记录
// 关键设计：truncateTaskJournal 只过滤 task records（task-started/finished/failed/replayed）
// cmd-finished 与 cmd-replayed 不被 keepSeqs 过滤——这意味着编辑点之后的 cmd 不会被截断
// 但 task 会被截断→重跑。task 重跑可能影响后续 cmd（task 输出作 cmd 输入？）
// 让我们看 journal 状态
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput } from "@wudao/core";
import { runScriptWorkflow } from "external/packages/cli/src/workflow/engine.js";
import { journalFilePath, loadJournal, openJournal, workflowIdentity } from "external/packages/cli/src/workflow/journal.js";
import type { JsflowOptions } from "external/packages/cli/src/workflow/engine.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wf-audit-t007-5-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true, retryDelay: 100, maxRetries: 10 }); });

const noCallModel: ModelClient = {
  async generate(): Promise<AssistantMessage> { throw new Error("no model"); },
};
const buildOpts = (journalPath: string, extra: Partial<JsflowOptions> = {}): JsflowOptions => ({
  workspaceRoot: root, model: noCallModel, journal: openJournal(journalPath),
  workflowName: "truncate-cmd", ...extra,
});
const p = (): string => journalFilePath(root, `wf-tc-${Math.random().toString(16).slice(2, 8)}`);

describe("T007 #5 truncateTaskJournal 与 cmd 记录", () => {
  it("5-1: 编辑点之后 cmd-finished 是否被截断？", async () => {
    // 首跑：1 task + 1 cmd（cmd 在 task 之后）
    // 异身份 resume（脚本变了）：编辑语义——task 截断后重跑，cmd 呢？
    const script1 = `
const t = await task('echo', {});
const c = await run('node', ['-e', 'console.log("CMD1")']);
return { taskText: t.text, cmdOut: c.stdout.trim() };
`;
    const script2 = `
const t = await task('echo', {});
const c = await run('node', ['-e', 'console.log("CMD2")']);
return { taskText: t.text, cmdOut: c.stdout.trim() };
`;
    const journalPath = p();

    // 用一个会返回文本的 model 跑首跑
    const firstModel: ModelClient = {
      async generate(_input: ModelInput): Promise<AssistantMessage> {
        return { role: "assistant", content: "MODEL_TEXT" };
      },
    };
    const r1 = await runScriptWorkflow(script1, buildOpts(journalPath, { commandAllowlist: new Set(["node"]), identity: workflowIdentity(script1, undefined), model: firstModel }));
    expect(r1.ok).toBe(true);
    const loaded = loadJournal(journalPath);
    console.log("[5-1] 首跑 journal records 类型序列:", loaded.records.map((r) => r.type));
    expect(loaded.tasks.length).toBe(1);
    expect(loaded.cmds.length).toBe(1);

    // 异身份 resume：用 script2 → 应触发截断（编辑点=脚本变了）
    const secondModel: ModelClient = {
      async generate(_input: ModelInput): Promise<AssistantMessage> {
        return { role: "assistant", content: "MODEL_TEXT_2" };
      },
    };
    const r2 = await runScriptWorkflow(
      script2,
      buildOpts(journalPath, {
        commandAllowlist: new Set(["node"]),
        identity: workflowIdentity(script2, undefined),
        resumeIdentity: workflowIdentity(script1, undefined),
        resumeTasks: loaded.tasks, resumeCmds: loaded.cmds,
        model: secondModel,
      }),
    );
    expect(r2.ok).toBe(true);
    const after = loadJournal(journalPath);
    console.log("[5-1] 异身份 resume 后 records 类型序列:", after.records.map((r) => r.type));
    console.log("[5-1] after.tasks.length:", after.tasks.length, "after.cmds.length:", after.cmds.length);
    // 期望
    // - task: 截断→重跑，2 条 task-finished（带同 seq 0/1? 实际 seq 由 resume 重新分配）
    // - cmd: 是否被截断？看 truncateTaskJournal 的代码——只过滤 task records，cmd 不动
    //  所以 journal 里仍有原 cmd-finished(seq=1) + 新 cmd-finished(seq=1)
    //  resume 时 cursor 走查会命中第一条 cmd-finished——returnValue 是 CMD1（错误！应该是 CMD2）
    // 这是 critical bug!
    expect(r2.returnValue).toEqual({ taskText: "MODEL_TEXT", cmdOut: "CMD2" });
    // 如果 returnValue.cmdOut === "CMD1" 表示 bug——重放拿旧值
    const cmdOut = (r2.returnValue as { cmdOut: string }).cmdOut;
    if (cmdOut === "CMD1") {
      console.log("[5-1] ★★★ 严重 BUG：异身份 resume 后 cmd 仍拿 CMD1！截断后重跑却拿到了旧 cmd 结果");
    } else if (cmdOut === "CMD2") {
      console.log("[5-1] cmd 正确拿了 CMD2（编辑后重跑）");
    }
  });

  it("5-2: cmd-finished 在 journal 中是否累积？", async () => {
    // 异身份截断 + 跑两次，看 journal 里 cmd-finished 累积
    const script1 = `
const c = await run('node', ['-e', 'console.log("X1")']);
return c.stdout.trim();
`;
    const script2 = `
const c = await run('node', ['-e', 'console.log("X2")']);
return c.stdout.trim();
`;
    const journalPath = p();

    const r1 = await runScriptWorkflow(script1, buildOpts(journalPath, { commandAllowlist: new Set(["node"]), identity: workflowIdentity(script1, undefined) }));
    expect(r1.returnValue).toBe("X1");

    const loaded = loadJournal(journalPath);
    const r2 = await runScriptWorkflow(
      script2,
      buildOpts(journalPath, {
        commandAllowlist: new Set(["node"]),
        identity: workflowIdentity(script2, undefined),
        resumeIdentity: workflowIdentity(script1, undefined),
        resumeTasks: loaded.tasks, resumeCmds: loaded.cmds,
      }),
    );
    console.log("[5-2] r2.returnValue =", r2.returnValue);
    expect(r2.returnValue).toBe("X2");

    const after = loadJournal(journalPath);
    const cmdFinished = after.records.filter((r) => r.type === "cmd-finished");
    console.log("[5-2] after cmd-finished 数:", cmdFinished.length);
    for (const c of cmdFinished) console.log("  seq:", (c as { seq: number }).seq, "stdout:", (c as { stdout: string }).stdout.trim());
    // 期望：异身份 + cmd 漂移 → 走 truncateTaskJournal 路径（invalidated=true）→ 实际执行
    // 但 truncateTaskJournal 只动 task records——cmd 不动
    // 所以 journal 有 1 条 X1 cmd-finished（保留）+ 1 条 X2 cmd-finished（新落账）
    // cmd-replayed 会命中哪一条？看代码：cursor 走到 entry.seq=0，entry.key=X1 cmdKey，但当前计算出的 cmdKey=X2——key 不同
    // purityArmed=false（异身份 → purityArmed 取决于 identity 完全相等）——所以不会纯度违例
    // 走到 invalidate 分支：entry !== undefined && !failureGap → truncateTaskJournal + invalidated=true
    // 然后执行新 cmd，落账 X2 cmd-finished
    // loadJournal.cmds 排序后：seq 都是 0，按 file 顺序，X1 在前——下次 resume cursor 仍指 X1 entry？
    // 这次只看本次行为即可——期望 cmdOut = "X2" 已被验证
  });

  it("5-3: 多次异身份 resume — cmd-finished 是否累积？", async () => {
    const script1 = `const c = await run('node', ['-e', 'console.log("v1")']); return c.stdout.trim();`;
    const script2 = `const c = await run('node', ['-e', 'console.log("v2")']); return c.stdout.trim();`;
    const script3 = `const c = await run('node', ['-e', 'console.log("v3")']); return c.stdout.trim();`;
    const journalPath = p();

    await runScriptWorkflow(script1, buildOpts(journalPath, { commandAllowlist: new Set(["node"]), identity: workflowIdentity(script1, undefined) }));
    let loaded = loadJournal(journalPath);
    console.log("[5-3] 跑 1 后 cmd-finished:", loaded.cmds.length);

    await runScriptWorkflow(
      script2,
      buildOpts(journalPath, {
        commandAllowlist: new Set(["node"]),
        identity: workflowIdentity(script2, undefined),
        resumeIdentity: workflowIdentity(script1, undefined),
        resumeTasks: loaded.tasks, resumeCmds: loaded.cmds,
      }),
    );
    loaded = loadJournal(journalPath);
    console.log("[5-3] 跑 2 后 cmd-finished:", loaded.cmds.length);

    await runScriptWorkflow(
      script3,
      buildOpts(journalPath, {
        commandAllowlist: new Set(["node"]),
        identity: workflowIdentity(script3, undefined),
        resumeIdentity: workflowIdentity(script2, undefined),
        resumeTasks: loaded.tasks, resumeCmds: loaded.cmds,
      }),
    );
    loaded = loadJournal(journalPath);
    console.log("[5-3] 跑 3 后 cmd-finished:", loaded.cmds.length);
    const allCmds = loaded.cmds;
    for (const c of allCmds) console.log("  seq:", c.seq, "stdout:", c.stdout.trim(), "key:", c.key.slice(0, 12));
    // journal 累积了 v1, v2, v3 三条 cmd-finished——都是 seq=0（同 identity 重用 seq 0）
    // loadJournal.cmds 排序后取哪一条？稳定排序——file 顺序
    // 第一次 cmd-replayed 会命中第一条 file 顺序的（即 v1）——下次 resume 又拿 v1
    // 这是 journal 污染累积问题
  });

  it("5-4: 同身份 + task 在 cmd 之后：task 漂移触发截断，cmd 怎样？", async () => {
    // cmd(0) + task(1) + cmd(2)
    // 编辑 task 的 prompt 让 seq=1 task-finished key 漂移 → 截断 task → cmd 保留
    const script1 = `
const c0 = await run('node', ['-e', 'console.log("C0")']);
const t1 = await task('hello', {});
const c2 = await run('node', ['-e', 'console.log("C2")']);
return { c0: c0.stdout.trim(), t1: t1.text, c2: c2.stdout.trim() };
`;
    const script2 = `
const c0 = await run('node', ['-e', 'console.log("C0")']);
const t1 = await task('hello WORLD', {});  // task prompt 变了
const c2 = await run('node', ['-e', 'console.log("C2")']);
return { c0: c0.stdout.trim(), t1: t1.text, c2: c2.stdout.trim() };
`;
    const journalPath = p();

    const firstModel: ModelClient = {
      async generate(_input: ModelInput): Promise<AssistantMessage> {
        return { role: "assistant", content: "T1_OUT" };
      },
    };
    const r1 = await runScriptWorkflow(script1, buildOpts(journalPath, { commandAllowlist: new Set(["node"]), identity: workflowIdentity(script1, undefined), model: firstModel }));
    expect(r1.returnValue).toEqual({ c0: "C0", t1: "T1_OUT", c2: "C2" });

    const loaded = loadJournal(journalPath);
    console.log("[5-4] 首跑 records:", loaded.records.map((r) => r.type));

    // 异身份（脚本字面变了）→ 编辑语义
    const secondModel: ModelClient = {
      async generate(_input: ModelInput): Promise<AssistantMessage> {
        return { role: "assistant", content: "T1_OUT_2" };
      },
    };
    const r2 = await runScriptWorkflow(
      script2,
      buildOpts(journalPath, {
        commandAllowlist: new Set(["node"]),
        identity: workflowIdentity(script2, undefined),
        resumeIdentity: workflowIdentity(script1, undefined),
        resumeTasks: loaded.tasks, resumeCmds: loaded.cmds,
        model: secondModel,
      }),
    );
    console.log("[5-4] r2.returnValue =", r2.returnValue);
    const after = loadJournal(journalPath);
    console.log("[5-4] 异身份后 records 类型序列:", after.records.map((r) => r.type));
    const allCmds = after.cmds;
    console.log("[5-4] after.cmds:");
    for (const c of allCmds) console.log("  seq:", c.seq, "stdout:", c.stdout.trim());
    // 异身份 → 截断路径（不是 purityArmed）→ invalidated=true
    // 截断后所有 task records 删，但 cmd-finished 不删
    // 重跑 task(seq=1) + 重跑 cmd(seq=0, seq=2)（实际执行）
    // expect r2.returnValue = { c0: "C0", t1: "T1_OUT_2", c2: "C2" } 全是新值
    expect(r2.returnValue).toEqual({ c0: "C0", t1: "T1_OUT_2", c2: "C2" });
  }, 30_000);
});
