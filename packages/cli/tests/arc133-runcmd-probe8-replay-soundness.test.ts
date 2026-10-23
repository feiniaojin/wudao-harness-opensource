// T007 探针 8 — 重放 soundness 严格测试
// 核心：capOutput 重放不一致（钉 #4 发现）— 验证脚本依赖完整 stdout 时会出错
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient } from "@wudao/core";
import { runScriptWorkflow } from "~/xdev/github/wudao-harness-project/wudao-harness/packages/cli/src/workflow/engine.js";
import { journalFilePath, loadJournal, openJournal, workflowIdentity } from "~/xdev/github/wudao-harness-project/wudao-harness/packages/cli/src/workflow/journal.js";
import type { JsflowOptions } from "~/xdev/github/wudao-harness-project/wudao-harness/packages/cli/src/workflow/engine.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wf-audit-t007-8-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true, retryDelay: 100, maxRetries: 10 }); });

const noCallModel: ModelClient = {
  async generate(): Promise<AssistantMessage> { throw new Error("no model"); },
};
const buildOpts = (journalPath: string, extra: Partial<JsflowOptions> = {}): JsflowOptions => ({
  workspaceRoot: root, model: noCallModel, journal: openJournal(journalPath),
  workflowName: "replay-sound", ...extra,
});
const p = (): string => journalFilePath(root, `wf-rs-${Math.random().toString(16).slice(2, 8)}`);

describe("T007 #8 重放 soundness", () => {
  it("8-1: 关键路径：脚本依赖 stdout 长度判断（首跑通过 / resume 因截断出错）", async () => {
    // 100KB 输出 → 首跑 stdout.length = 102400 → 脚本判定 length > 65536
    // resume 重放拿到 65550 (64KB + 标记) → 脚本再判定 length > 65536 → 但内容不同
    // 这暴露：脚本的"门控循环"依赖完整 stdout 时，resume 拿到的是截断版
    const script = `
const c = await run('node', ['-e', 'process.stdout.write("X".repeat(100*1024))']);
const ok = c.stdout.length === 100*1024;  // 首跑 true, resume false
return { ok, len: c.stdout.length };
`;
    const identity = workflowIdentity(script, undefined);
    const journalPath = p();
    const r1 = await runScriptWorkflow(script, buildOpts(journalPath, { commandAllowlist: new Set(["node"]), identity }));
    console.log("[8-1] r1 =", r1.returnValue);

    const loaded = loadJournal(journalPath);
    const r2 = await runScriptWorkflow(
      script,
      buildOpts(journalPath, {
        commandAllowlist: new Set(["node"]),
        identity, resumeIdentity: identity,
        resumeTasks: loaded.tasks, resumeCmds: loaded.cmds,
      }),
    );
    console.log("[8-1] r2 =", r2.returnValue);
    // T007 P0 修复后：帽在 settle 一处生效——首跑与 resume 对 stdout 长度
    // 的判定**一致**（重放 soundness 恢复）。
    const v1 = r1.returnValue as { ok: boolean; len: number };
    const v2 = r2.returnValue as { ok: boolean; len: number };
    expect(v1.len).toBe(v2.len);
    expect(v1.ok).toBe(v2.ok);
  });

  it("8-2: stdout 含 [输出超 64KB 截断] 标记 → 脚本能否区分？", async () => {
    // 用户的合法 stdout 可能含 "[输出超 64KB 截断]" 字面字符串——会被 64KB 帽的标记搞混
    // 这是边界情况
    const marker = "[输出超 64KB 截断]";
    const script = `
const c = await run('node', ['-e', 'process.stdout.write("${marker}".repeat(20000))']);
const hasMarker = c.stdout.endsWith("${marker}");
return { hasMarker, len: c.stdout.length };
`;
    // 上面构造一个 stdout 总长 = marker.length * 20000 = 9 * 20000 = 180KB——超 64KB 帽
    // 帽后的 stdout = 64KB X + marker 标记——这与"用户原意输出"的 marker 混淆
    const r = await runScriptWorkflow(script, buildOpts(p(), { commandAllowlist: new Set(["node"]) }));
    console.log("[8-2] r =", r.returnValue);
    // ★ 用户原意：hasMarker=true（输出 180KB 都是 marker）
    // 帽后：stdout 是 64KB X + 截断标记（不是用户原 marker）—— hasMarker 检测末尾是 marker
    // 但截断标记也是 marker——所以 hasMarker=true 仍然成立！
    // 但用户可能想用脚本检查输出里是否有 user-marker (而非 cap-marker)——两者无法区分
    // 这是一个潜在的**重放语义破坏**场景：用户检测 marker 来识别 cap，但 cap 标记也是同字符串
  });

  it("8-3: cap 后的 stdout 含 ASCII 截断标记 — 用户 grep 该串会误命中", async () => {
    // 用户的 stdout 含 "[输出超 64KB 截断]" 子串（合法场景）——cap 后追加这个串
    // 用户的 grep/解析逻辑可能误把 cap 标记当作用户内容
    const marker = "[输出超 64KB 截断]";
    const half = 50 * 1024; // 50KB
    const filler = "F".repeat(half);
    // 脚本输出 = filler (50KB) + marker (单条) + filler (50KB) = 100KB + 9B
    // 帽后 = 64KB + marker (cap)
    const script = `
const c = await run('node', ['-e', 'process.stdout.write("${filler}${marker}${filler}")']);
const markerCount = (c.stdout.match(/\\[输出超 64KB 截断\\]/g) || []).length;
return { markerCount, len: c.stdout.length };
`;
    const r = await runScriptWorkflow(script, buildOpts(p(), { commandAllowlist: new Set(["node"]) }));
    console.log("[8-3] r =", r.returnValue);
    // 期望：markerCount = 2（用户的 1 个 + cap 追加的 1 个）——用户不知道 cap 的存在
    // 这会让用户脚本误判
    const v = r.returnValue as { markerCount: number; len: number };
    if (v.markerCount > 1) {
      console.log("[8-3] ★ cap 标记与用户 marker 混淆：markerCount =", v.markerCount);
    }
  });
});
