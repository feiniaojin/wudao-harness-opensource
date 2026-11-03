// M11 #2（a reference harness world.run 形）— 脚本级命令门原语收据：非零退出=正常返回
// （门控循环常态）、无 shell（args 直传）、允许清单 fail-closed、journaled
// 重放零进程派生、同身份键漂移=纯度违例、超时/spawn 失败数据化。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput } from "@wudao-org/core";
import { runScriptWorkflow } from "../src/workflow/engine.js";
import { journalFilePath, loadJournal, openJournal, workflowIdentity } from "../src/workflow/journal.js";
import type { JsflowOptions } from "../src/workflow/engine.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wf-runcmd-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, retryDelay: 100, maxRetries: 10 });
});

const noCallModel: ModelClient = {
  async generate(input: ModelInput): Promise<AssistantMessage> {
    throw new Error("run() 测试不应产生模型调用");
  },
};

const opts = (over: Partial<JsflowOptions> & { journalPath: string }): JsflowOptions => ({
  workspaceRoot: root,
  model: noCallModel,
  journal: openJournal(over.journalPath),
  workflowName: "runcmd",
  ...over,
});

const path = (): string => journalFilePath(root, `wf-cmd-${Math.random().toString(16).slice(2, 8)}`);

describe("M11 #2 — run() 门语义", () => {
  it("非零退出码是正常返回（code=2 数据化，不 rejection）", async () => {
    const r = await runScriptWorkflow(
      "const c = await run('node', ['-e', 'process.exit(2)']); return { code: c.code, timedOut: c.timedOut };",
      opts({ journalPath: path(), commandAllowlist: new Set(["node"]) }),
    );
    expect(r.ok).toBe(true);
    expect(r.returnValue).toEqual({ code: 2, timedOut: false });
  });

  it("stdout/stderr 捕获（纯脚本解析输出做门控分支）", async () => {
    const r = await runScriptWorkflow(
      "const c = await run('node', ['-e', 'console.log(\"LEFT:3\"); console.error(\"warn\")']); return { out: c.stdout.trim(), err: c.stderr.trim() };",
      opts({ journalPath: path(), commandAllowlist: new Set(["node"]) }),
    );
    expect(r.returnValue).toEqual({ out: "LEFT:3", err: "warn" });
  });

  it("无 shell：管道/重定向字符只是字面参数（echo 'a | b' 原样）", async () => {
    const r = await runScriptWorkflow(
      "const c = await run('node', ['-e', 'process.stdout.write(process.argv[1])', 'a | b > c']); return c.stdout;",
      opts({ journalPath: path(), commandAllowlist: new Set(["node"]) }),
    );
    expect(r.returnValue).toBe("a | b > c");
  });

  it("允许清单 fail-closed：未授予的命令=确定性拒绝（落账含指引），exit 0 不执行", async () => {
    const p = path();
    const r = await runScriptWorkflow(
      "const c = await run('git', ['status']); return c.spawnError ?? 'ran';",
      opts({ journalPath: p }), // 无 allowlist
    );
    expect(r.ok).toBe(true);
    expect(String(r.returnValue)).toContain("not granted");
    expect(String(r.returnValue)).toContain("--allow-cmd");
    // 拒绝也落账（cmd-finished 带 spawnError）——重放一致
    const cmds = loadJournal(p).cmds;
    expect(cmds.length).toBe(1);
    expect(cmds[0]?.spawnError).toContain("not granted");
  });

  it("spawn 失败（命令不存在）数据化——即使已授予", async () => {
    const r = await runScriptWorkflow(
      "const c = await run('definitely-not-a-real-cmd-xyz', []); return { spawnError: c.spawnError !== undefined, code: c.code };",
      opts({ journalPath: path(), commandAllowlist: new Set(["definitely-not-a-real-cmd-xyz"]) }),
    );
    expect(r.ok).toBe(true);
    expect(r.returnValue).toEqual({ spawnError: true, code: undefined });
  });

  it("超时数据化：timedOut=true，进程被杀，脚本继续", async () => {
    const r = await runScriptWorkflow(
      "const c = await run('node', ['-e', 'setTimeout(() => {}, 60_000)'], { timeoutMs: 1000 }); return c.timedOut;",
      opts({ journalPath: path(), commandAllowlist: new Set(["node"]) }),
    );
    expect(r.ok).toBe(true);
    expect(r.returnValue).toBe(true);
  }, 20_000);
});

describe("M11 #2 — run() 的 journal 重放", () => {
  const SCRIPT = "const c = await run('node', ['-e', 'console.log(41 + 1)']); return Number(c.stdout.trim());";
  const id = () => workflowIdentity(SCRIPT, undefined);

  it("同身份 resume → 零进程派生（cmd-replayed 落账，值原样）", async () => {
    const p = path();
    const identity = id();
    const r1 = await runScriptWorkflow(SCRIPT, opts({ journalPath: p, commandAllowlist: new Set(["node"]), identity }));
    expect(r1.returnValue).toBe(42);
    const r2 = await runScriptWorkflow(
      SCRIPT,
      opts({
        journalPath: p, commandAllowlist: new Set(["node"]), identity,
        resumeIdentity: identity, resumeTasks: [], resumeCmds: loadJournal(p).cmds,
      }),
    );
    expect(r2.ok).toBe(true);
    expect(r2.returnValue).toBe(42);
    // 重放不重复落 cmd-finished（只多一条 cmd-replayed）
    const loaded = loadJournal(p);
    expect(loaded.cmds.length).toBe(1);
    expect(loaded.records.some((rec) => rec.type === "cmd-replayed")).toBe(true);
  });

  it("同身份 + cmd 参数漂移 → 纯度违例（大声失败不截断）", async () => {
    const p = path();
    const identity = workflowIdentity("PLACEHOLDER", undefined);
    const script1 = "const c = await run('node', ['-e', 'console.log(1)']); return c.stdout.trim();";
    const script2 = "const c = await run('node', ['-e', 'console.log(2)']); return c.stdout.trim();";
    const id1 = workflowIdentity(script1, undefined);
    await runScriptWorkflow(script1, opts({ journalPath: p, commandAllowlist: new Set(["node"]), identity: id1 }));
    // 同脚本字节才算同身份——这里用脚本编辑测异身份截断；纯度测试用篡改键
    const r2 = await runScriptWorkflow(
      script2,
      opts({
        journalPath: p, commandAllowlist: new Set(["node"]),
        identity: workflowIdentity(script2, undefined),
        resumeIdentity: workflowIdentity(script1, undefined),
        resumeTasks: [], resumeCmds: loadJournal(p).cmds,
      }),
    );
    expect(r2.ok).toBe(true); // 异身份=编辑语义：截断后重跑
    // 纯度：手工构造同身份但漂移的 cmd 键
    const p3 = path();
    const id3 = workflowIdentity(script1, undefined);
    await runScriptWorkflow(script1, opts({ journalPath: p3, commandAllowlist: new Set(["node"]), identity: id3 }));
    const hand = loadJournal(p3);
    // 篡改 journal 里 cmd 的 key → 同身份 resume 时现在算出的键不同
    const forged = hand.cmds.map((c) => ({ ...c, key: "c:" + "0".repeat(64) }));
    const r3 = await runScriptWorkflow(
      script1,
      opts({
        journalPath: p3, commandAllowlist: new Set(["node"]), identity: id3,
        resumeIdentity: id3, resumeTasks: [], resumeCmds: forged,
      }),
    );
    expect(r3.ok).toBe(false);
    expect(r3.failure?.category).toBe("purity-violation");
    expect(identity).toBeTruthy();
  });

  it("task 与 cmd 共享 seq 空间：task 在 cmd 后正确对位重放", async () => {
    const p = path();
    const script = "const g = await run('node', ['-e', 'console.log(\"7\")']); const a = await task('what number?', {}); return [g.stdout.trim(), a.text];";
    const identity = workflowIdentity(script, undefined);
    const say = (content: string): AssistantMessage => ({ role: "assistant", content });
    let i = 0;
    const scriptModel: ModelClient = {
      async generate(input: ModelInput) {
        i += 1;
        input.onUsage?.({ promptTokens: 5, cacheHitTokens: 0, cacheMissTokens: 5, completionTokens: 2 });
        return say(i === 1 ? "seven" : "RE-RUN");
      },
    };
    await runScriptWorkflow(script, opts({ journalPath: p, commandAllowlist: new Set(["node"]), identity, model: scriptModel }));
    // resume：cmd(seq0) 与 task(seq1) 都命中 → 零模型调用零进程
    const loaded = loadJournal(p);
    let j = 0;
    const replayModel: ModelClient = {
      async generate(input: ModelInput) {
        j += 1;
        input.onUsage?.({ promptTokens: 5, cacheHitTokens: 0, cacheMissTokens: 5, completionTokens: 2 });
        return say("RE-RUN");
      },
    };
    const r2 = await runScriptWorkflow(
      script,
      opts({
        journalPath: p, commandAllowlist: new Set(["node"]), identity,
        resumeIdentity: identity, resumeTasks: loaded.tasks, resumeCmds: loaded.cmds, model: replayModel,
      }),
    );
    expect(r2.ok).toBe(true);
    expect(j).toBe(0); // 零模型调用
    expect(r2.returnValue).toEqual(["7", "seven"]);
  });
});
