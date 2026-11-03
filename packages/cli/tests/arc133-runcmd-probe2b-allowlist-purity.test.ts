// T007 探针 2b — allowlist 状态变更：cmd 重放命中 + key 漂移 → 纯度违例？
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient } from "@wudao-org/core";
import { runScriptWorkflow } from "~/xdev/github/wudao-harness-project/wudao-harness/packages/cli/src/workflow/engine.js";
import { journalFilePath, loadJournal, openJournal, workflowIdentity } from "~/xdev/github/wudao-harness-project/wudao-harness/packages/cli/src/workflow/journal.js";
import type { JsflowOptions } from "~/xdev/github/wudao-harness-project/wudao-harness/packages/cli/src/workflow/engine.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wf-audit-t007-2b-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true, retryDelay: 100, maxRetries: 10 }); });

const noCallModel: ModelClient = {
  async generate(): Promise<AssistantMessage> { throw new Error("no model"); },
};
const buildOpts = (journalPath: string, extra: Partial<JsflowOptions> = {}): JsflowOptions => ({
  workspaceRoot: root, model: noCallModel, journal: openJournal(journalPath),
  workflowName: "allowlist-purity", ...extra,
});
const p = (): string => journalFilePath(root, `wf-pur-${Math.random().toString(16).slice(2, 8)}`);

describe("T007 #2b allowlist 与 cmd 键漂移", () => {
  it("2b-1: 首跑拒绝 → resume 仍拒绝（同一 cmdKey）→ 重放命中，spawnError 复现", async () => {
    // 同身份 + 同 cmdKey，但允许清单仍未授予——这与首跑一致（都拒绝）→ 纯度武装下"重放命中"
    const script = `const c = await run('node', ['-e', 'console.log(1)']); return c.spawnError ?? 'ran';`;
    const identity = workflowIdentity(script, undefined);
    const journalPath = p();

    const r1 = await runScriptWorkflow(script, buildOpts(journalPath, { identity }));
    expect(r1.ok).toBe(true);
    expect(String(r1.returnValue)).toContain("not granted");

    const loaded = loadJournal(journalPath);
    const r2 = await runScriptWorkflow(
      script,
      buildOpts(journalPath, {
        identity, resumeIdentity: identity,
        resumeTasks: loaded.tasks, resumeCmds: loaded.cmds,
      }),
    );
    // 重放：spawnError="not granted"（旧"事实"），仍 ok
    expect(r2.ok).toBe(true);
    expect(String(r2.returnValue)).toContain("not granted");
    console.log("[2b-1] 仍拒绝，重放一致 =", r2.returnValue);
  });

  it("2b-2: 异 cmd（参数漂移）→ 纯度武装下应纯度违例", async () => {
    // 首跑 cmd("node", ["-e", "console.log(1)"])
    // resume cmd("node", ["-e", "console.log(2)"])——key 漂移
    // 同身份 → purityArmed=true → 应抛 WorkflowPurityError
    const script1 = `const c = await run('node', ['-e', 'console.log(1)']); return c.stdout.trim();`;
    const script2 = `const c = await run('node', ['-e', 'console.log(2)']); return c.stdout.trim();`;
    const journalPath = p();

    // 用 script1 的 identity 跑 script1
    const id1 = workflowIdentity(script1, undefined);
    const r1 = await runScriptWorkflow(script1, buildOpts(journalPath, { commandAllowlist: new Set(["node"]), identity: id1 }));
    expect(r1.returnValue).toBe("1");

    // 用 script2 的 identity 跑 script2（同身份？不同）—— scriptHash 不同 → 异身份 → 截断重跑
    // 等等：id1 是 script1 的，id2 是 script2 的。resumeIdentity=id1, identity=id2 → 异身份
    // 应截断后重跑：expect r2.returnValue="2", ok=true
    const id2 = workflowIdentity(script2, undefined);
    const loaded = loadJournal(journalPath);
    const r2 = await runScriptWorkflow(
      script2,
      buildOpts(journalPath, {
        commandAllowlist: new Set(["node"]),
        identity: id2, resumeIdentity: id1,
        resumeTasks: loaded.tasks, resumeCmds: loaded.cmds,
      }),
    );
    console.log("[2b-2] r2.ok =", r2.ok, "failure=", r2.failure, "returnValue=", r2.returnValue);
    // 异身份 = 编辑语义，截断后重跑
    expect(r2.ok).toBe(true);
    expect(r2.returnValue).toBe("2");
  });

  it("2b-3: 同身份 + cmd 参数漂移（同脚本字面、但 args 不同）— 模拟纯度武装下 args 变化", async () => {
    // 思路：固定脚本字面，但首跑与 resume 用不同 args 输入
    // 但 task() 的 key 是 sha256(prompt+canonical(opts))——args 字段在 opts 里就是漂移
    // run() 的 cmdKey = sha256(cmd + "\n" + JSON.stringify(args))——args 是直传
    // 关键：identity = sha256(scriptSource) + sha256(argsCanonical)
    // 同身份要求：argsCanonical 相同 —— 但 run() 的 args 是局部数据，不入 identity
    // 所以：同一脚本字面 + 不同 run args 算同身份 → cmdKey 漂移 → 纯度武装
    // 但实际上脚本字面就是 args 的来源——脚本字面相同则 args 必然相同（同确定性）
    // 这里我们用 args 注入：脚本字面含 args.cmdline 这样的字段（但 args 不入 identity 因为 args 是 workflow 输入）
    // 实际：identity 只看 workflow 的 args（外部参数），不看脚本内的局部 run() args
    // 所以同脚本字面 + 同 workflow args = 同身份；run() args 改变 = cmdKey 漂移 = 纯度违例
    // 但脚本字面是固定的——run() args 也只能从 args 推，无法运行时变化（除非 args 包含随机）
    // 我们的探针：用 args 注入随机 cmd args（但 tripwire 会拦随机）——我们用 args 注入确定性但不同的 args
    const script = `const c = await run('node', ['-e', 'console.log(' + args.tag + ')']); return c.stdout.trim();`;
    const identity1 = workflowIdentity(script, { tag: "A" });
    const identity2 = workflowIdentity(script, { tag: "B" });
    console.log("[2b-3] identity1 === identity2 ?", identity1.scriptHash === identity2.scriptHash, identity1.argsHash === identity2.argsHash);
    // 显然不同——argsHash 异
    // 所以：args 真变化走异身份截断语义
    // 真正能纯度武装下 cmdKey 漂移的场景：脚本字面相同 + args 相同 + run() 内 args 变化
    // 这种场景：要么 args 注入随机（tripwire 拦），要么 args 内含纯函数（理论上不可能漂移）
    // 结论：在合规写法下，纯度违例 cmd 漂移需要脚本字面相同但调用 run() 时传不同 args——除非 args 也是动态的
    // 这是 T006 F3 已有约束（assertJsonSafeArgs）——所以走异身份截断就够了
    expect(identity1.argsHash !== identity2.argsHash).toBe(true);
  });
});
