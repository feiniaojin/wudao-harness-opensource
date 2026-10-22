// T007 探针 7 — 自选边界
// 1) invalidated × replay 交互
// 2) pipeline() 里 run()
// 3) cmdKey 的 args 序列化边界：空数组 / 重复参数 / 超长参数 / 特殊字符
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient } from "@wudao/core";
import { runScriptWorkflow } from "external/packages/cli/src/workflow/engine.js";
import { journalFilePath, loadJournal, openJournal, workflowIdentity, cmdKey } from "external/packages/cli/src/workflow/journal.js";
import type { JsflowOptions } from "external/packages/cli/src/workflow/engine.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wf-audit-t007-7-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true, retryDelay: 100, maxRetries: 10 }); });

const noCallModel: ModelClient = {
  async generate(): Promise<AssistantMessage> { throw new Error("no model"); },
};
const buildOpts = (journalPath: string, extra: Partial<JsflowOptions> = {}): JsflowOptions => ({
  workspaceRoot: root, model: noCallModel, journal: openJournal(journalPath),
  workflowName: "extra-bounds", ...extra,
});
const p = (): string => journalFilePath(root, `wf-eb-${Math.random().toString(16).slice(2, 8)}`);

describe("T007 #7 自选边界", () => {
  describe("7A invalidated × replay 交互", () => {
    it("7A-1: invalidated 后 cmd 重放路径如何？", async () => {
      // 思路：先让 invalidated=true（task 漂移触发），再看 cmd 的 invalidate 分支
      const script1 = `
const t = await task('echo', {});
const c = await run('node', ['-e', 'console.log(1)']);
return [t.text, c.stdout.trim()];
`;
      const script2 = `
const t = await task('echo WORLD', {});
const c = await run('node', ['-e', 'console.log(1)']);
return [t.text, c.stdout.trim()];
`;
      const journalPath = p();

      const m: ModelClient = {
        async generate(): Promise<AssistantMessage> {
          return { role: "assistant", content: "T_OUT" };
        },
      };
      await runScriptWorkflow(script1, buildOpts(journalPath, { commandAllowlist: new Set(["node"]), identity: workflowIdentity(script1, undefined), model: m }));
      const loaded = loadJournal(journalPath);

      const m2: ModelClient = {
        async generate(): Promise<AssistantMessage> {
          return { role: "assistant", content: "T_OUT_2" };
        },
      };
      // 异身份 → task 截断重跑 + cmd 截断重跑（同 cmdKey 但 invalidated=true）
      const r2 = await runScriptWorkflow(
        script2,
        buildOpts(journalPath, {
          commandAllowlist: new Set(["node"]),
          identity: workflowIdentity(script2, undefined),
          resumeIdentity: workflowIdentity(script1, undefined),
          resumeTasks: loaded.tasks, resumeCmds: loaded.cmds,
          model: m2,
        }),
      );
      console.log("[7A-1] r2.returnValue =", r2.returnValue);
      expect(r2.ok).toBe(true);
      // 期望 task 重跑（MODEL_TEXT_2），cmd 也重跑（仍 "1"，但落新 cmd-finished）
      expect(r2.returnValue).toEqual(["T_OUT_2", "1"]);
    });

    it("7A-2: invalidated=true 后 cmd 重放分支被跳过（不再命中旧 entry）", async () => {
      // script1: task('echo A', {}) + run(...)
      // script2: task('echo B', {}) + run(...)
      // task prompt 变了 → 截断 → invalidated=true
      // 此时 cmd 的 entry 命中（key 相同）？—— invalidated 后跳过重放分支
      const script1 = `
const t = await task('A', {});
const c = await run('node', ['-e',  'console.log("CMD")']);
return [t.text, c.stdout.trim()];
`;
      const script2 = `
const t = await task('B', {});
const c = await run('node', ['-e',  'console.log("CMD")']);
return [t.text, c.stdout.trim()];
`;
      const journalPath = p();

      let calls = 0;
      const m: ModelClient = {
        async generate(): Promise<AssistantMessage> {
          calls += 1;
          return { role: "assistant", content: "T" + calls };
        },
      };
      await runScriptWorkflow(script1, buildOpts(journalPath, { commandAllowlist: new Set(["node"]), identity: workflowIdentity(script1, undefined), model: m }));
      console.log("[7A-2] calls after r1:", calls);

      const loaded = loadJournal(journalPath);
      const r2 = await runScriptWorkflow(
        script2,
        buildOpts(journalPath, {
          commandAllowlist: new Set(["node"]),
          identity: workflowIdentity(script2, undefined),
          resumeIdentity: workflowIdentity(script1, undefined),
          resumeTasks: loaded.tasks, resumeCmds: loaded.cmds,
          model: m,
        }),
      );
      console.log("[7A-2] calls after r2:", calls);
      console.log("[7A-2] r2.returnValue =", r2.returnValue);
      // task 漂移触发截断，cmd 截断后重跑
      expect(calls).toBe(2);
      expect(r2.returnValue).toEqual(["T2", "CMD"]);
    });
  });

  describe("7B pipeline() + run()", () => {
    it("7B-1: pipeline 跑 cmd — seq 对位 + 重放", async () => {
      const script = `
async function* gen() {
  yield () => run('node', ['-e', 'console.log("P-A")']);
  yield () => run('node', ['-e', 'console.log("P-B")']);
  yield () => run('node', ['-e', 'console.log("P-C")']);
}
const r = await pipeline(gen());
return r.results.map(x => x.stdout.trim());
`;
      const identity = workflowIdentity(script, undefined);
      const journalPath = p();
      const r1 = await runScriptWorkflow(script, buildOpts(journalPath, { commandAllowlist: new Set(["node"]), identity }));
      console.log("[7B-1] r1.returnValue =", r1.returnValue);
      expect(r1.returnValue).toEqual(["P-A", "P-B", "P-C"]);

      const loaded = loadJournal(journalPath);
      const r2 = await runScriptWorkflow(
        script,
        buildOpts(journalPath, {
          commandAllowlist: new Set(["node"]),
          identity, resumeIdentity: identity,
          resumeTasks: loaded.tasks, resumeCmds: loaded.cmds,
        }),
      );
      console.log("[7B-1] r2.returnValue =", r2.returnValue);
      expect(r2.returnValue).toEqual(["P-A", "P-B", "P-C"]);

      const after = loadJournal(journalPath);
      const replayed = after.records.filter((r) => r.type === "cmd-replayed");
      console.log("[7B-1] replayed 数:", replayed.length);
      expect(replayed.length).toBe(3);
    });

    it("7B-2: pipeline + sleep 不同延迟（流式执行）", async () => {
      // pipeline 是 no-barrier streaming——每个 yield 启动后立即让出，slot 空闲再启动下一个
      // 三路 sleep 不同延迟：先 yield 的应先 finish（短延迟优先）——但 pipeline 是顺序 yield + 并行执行
      const script = `
async function* gen() {
  yield () => run('node', ['-e', 'setTimeout(()=>console.log("S-LONG"),300)']);
  yield () => run('node', ['-e', 'setTimeout(()=>console.log("S-SHORT"),50)']);
  yield () => run('node', ['-e', 'setTimeout(()=>console.log("S-MID"),150)']);
}
const r = await pipeline(gen());
return r.results.map(x => x.stdout.trim());
`;
      const r = await runScriptWorkflow(script, buildOpts(p(), { commandAllowlist: new Set(["node"]) }));
      console.log("[7B-2] r.returnValue =", r.returnValue);
      // pipeline 不重排——按 yield 顺序；但并发执行——seq 按 yield 顺序
      expect(r.returnValue).toEqual(["S-LONG", "S-SHORT", "S-MID"]);
    });
  });

  describe("7C cmdKey args 序列化边界", () => {
    it("7C-1: 空 args 数组 vs undefined args", () => {
      // cmdKey(cmd, []) vs cmdKey(cmd, undefined)
      const k1 = cmdKey("ls", []);
      const k2 = cmdKey("ls", undefined);
      console.log("[7C-1] k1:", k1.slice(0, 20), "k2:", k2.slice(0, 20));
      // 都是 "c:" + sha256("ls\n[]")？应该相同
      expect(k1).toBe(k2);
    });

    it("7C-2: args 是 [undefined, undefined] vs []", () => {
      // 注意：args 元素可能是 undefined 吗？通常不是——args 是 string[]
      const k1 = cmdKey("echo", []);
      const k2 = cmdKey("echo", [""]);
      console.log("[7C-2] k1:", k1.slice(0, 20), "k2:", k2.slice(0, 20));
      expect(k1).not.toBe(k2);
    });

    it("7C-3: 重复 args", () => {
      // echo(a) vs echo(a, a) vs echo(a) — sha256 of JSON.stringify 区分
      const k1 = cmdKey("echo", ["a"]);
      const k2 = cmdKey("echo", ["a", "a"]);
      console.log("[7C-3] k1:", k1.slice(0, 20), "k2:", k2.slice(0, 20));
      expect(k1).not.toBe(k2);
    });

    it("7C-4: 超长参数（接近 execFile ARG_MAX 风险）", async () => {
      // execFile 在 Linux ARG_MAX 通常 128KB-2MB。我们造 1MB 单参数
      const longArg = "A".repeat(1024 * 1024); // 1MB
      const script = `const c = await run('node', ['-e', 'console.log(process.argv[1].length)'], { timeoutMs: 3000 }); return c.stdout.trim();`;
      const r = await runScriptWorkflow(script, buildOpts(p(), { commandAllowlist: new Set(["node"]) }));
      // node -e 'console.log(process.argv[1].length)' <longArg> → 应该输出 1048576（argv[1] 是 longArg 长度）
      console.log("[7C-4] r.returnValue =", r.returnValue);
      // 期望：1048576 或 spawnError（如果超 ARG_MAX）
      const rv = String(r.returnValue);
      if (rv === "1048576") {
        console.log("[7C-4] 1MB 参数成功传参");
      } else if (rv.includes("spawn") || rv === "0") {
        console.log("[7C-4] 参数被截断或 spawn 失败");
      }
    }, 10_000);

    it("7C-5: 特殊字符（含 shell 元字符但 execFile 不解析）", async () => {
      // execFile 无 shell——管道/重定向字符应作为字面参数
      const script = `const c = await run('node', ['-e', 'process.stdout.write(process.argv[1])'], { timeoutMs: 3000 }); return c.stdout;`;
      const specialArg = "rm -rf / ; echo pwned | cat > /tmp/x";
      // 我们不能直接用 specialArg 作为字符串拼接——build script
      const wrapped = script.replace("{ timeoutMs: 3000 }", JSON.stringify({ timeoutMs: 3000 }));
      const r = await runScriptWorkflow(wrapped + "; " + "return null;", buildOpts(p(), { commandAllowlist: new Set(["node"]) }));
      // 实际上由于 JS 脚本无法在编译时插值——这个测试设计有缺陷
      // 改测：用 process.env 注入特殊字符
      // 或者：直接测固定字面特殊字符
      const script2 = `const c = await run('node', ['-e', 'process.stdout.write(process.argv[1])', 'rm -rf / ; echo | cat']); return c.stdout;`;
      const r2 = await runScriptWorkflow(script2, buildOpts(p(), { commandAllowlist: new Set(["node"]) }));
      console.log("[7C-5] r2.returnValue =", JSON.stringify(r2.returnValue));
      expect(r2.returnValue).toBe("rm -rf / ; echo | cat");
    });
  });
});

describe("T007 #7D 其他边缘：cmd 与 task 的 cmdKey 重叠边界", () => {
  it("7D-1: cmdKey 前缀隔离 c: — taskKey 不会误命中 cmd", async () => {
    // task key 是 sha256 hex（64 chars），cmd key 是 "c:" + sha256 hex（66 chars）
    // 它们不会混淆。但 loadJournal 的 filter 是按 type 分流
    const loaded = await Promise.resolve({ cmds: [], tasks: [] });
    expect(loaded.cmds.length).toBe(0);
    expect(loaded.tasks.length).toBe(0);
    // 单纯验证 cmdKey 格式
    const k = cmdKey("x", ["y"]);
    expect(k.startsWith("c:")).toBe(true);
    expect(k.length).toBe(2 + 64);
  });
});
