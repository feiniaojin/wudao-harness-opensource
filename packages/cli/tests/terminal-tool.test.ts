// P2-12（96 队列 #12）terminal 工具面单测 — 单工具五动作（run/send/read/
// interrupt/exit）：参数校验先于副作用（fail-closed 工厂纪律）、每动作
// history 条目（action/session/首行截断/控制字符转义）、输出零 ANSI、
// 风险标注（ask 档：非只读/破坏性/open-world）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateToolArguments } from "@wudao/core";
import { createTerminalTool, closeTerminalTools, setTerminalHistorySink, __resetTerminalRuntimeForTests, buildTerminalEntry, TERMINAL_ENTRY_TYPE } from "../src/terminal/tools.js";
import type { GenericSessionEntry } from "@wudao/core";
import { loadNodePty } from "../src/terminal/pty.js";

const TEST_SHELL = { file: "/bin/bash", args: ["--noprofile", "--norc"] } as const;

const entries: GenericSessionEntry[] = [];

async function toolFor() {
  const load = await loadNodePty();
  if (!load.ok) throw new Error(`node-pty unavailable: ${load.reason}`);
  return createTerminalTool({
    workspaceRoot: process.cwd(),
    spawnFn: load.spawn,
    shell: TEST_SHELL,
    settleSilenceMs: 150,
    settleMaxMs: 8_000,
    idleTimeoutMs: 10 * 60_000,
  });
}

beforeEach(() => { entries.length = 0; });
afterEach(async () => {
  setTerminalHistorySink(undefined);
  __resetTerminalRuntimeForTests();
  await closeTerminalTools();
});

describe("terminal 工具定义（buildTool fail-closed 工厂）", () => {
  it("名为 terminal，五动作 enum，schema 过 core 校验", async () => {
    const tool = await toolFor();
    expect(tool.name).toBe("terminal");
    expect(Object.keys(tool.parameters.properties).sort()).toEqual(["action", "command", "input", "lines", "session"]);
    expect(tool.parameters.required).toEqual(["action"]);
    expect(tool.parameters.properties["action"]?.enum).toEqual(["run", "send", "read", "interrupt", "exit"]);
    expect(tool.parameters.additionalProperties).toBe(false);
    expect(validateToolArguments(tool.parameters, { action: "run", command: "echo hi" }).valid).toBe(true);
    // 逐动作最小形：run 需 command；send 需 input；read/interrupt/exit 只要 action
    expect(validateToolArguments(tool.parameters, { action: "send", input: "y" }).valid).toBe(true);
    expect(validateToolArguments(tool.parameters, { action: "read" }).valid).toBe(true);
    expect(validateToolArguments(tool.parameters, { action: "interrupt" }).valid).toBe(true);
    expect(validateToolArguments(tool.parameters, { action: "exit" }).valid).toBe(true);
  });

  it("风险标注 ask 档（每动作）：非只读 / 破坏性 / open-world / 非并发安全", async () => {
    const tool = await toolFor();
    for (const action of ["run", "send", "read", "interrupt", "exit"]) {
      const args = { action, ...(action === "run" ? { command: "ls" } : {}), ...(action === "send" ? { input: "y" } : {}) };
      expect(tool.isReadOnly?.(args), action).toBe(false);
      expect(tool.isDestructive?.(args), action).toBe(true);
      expect(tool.isOpenWorld?.(args), action).toBe(true);
      expect(tool.isConcurrencySafe?.(args), action).toBe(false);
    }
  });
});

describe("terminal — 校验先于副作用", () => {
  it("未知动作 / run 缺命令 / send 缺输入 / lines 非法 → isError，且零会话产生", async () => {
    const tool = await toolFor();
    const junk = await tool.execute({ action: "nope" });
    expect(junk.isError).toBe(true);
    const noCommand = await tool.execute({ action: "run" });
    expect(noCommand.isError).toBe(true);
    const blankCommand = await tool.execute({ action: "run", command: "  " });
    expect(blankCommand.isError).toBe(true);
    const noInput = await tool.execute({ action: "send" });
    expect(noInput.isError).toBe(true);
    const badLines = await tool.execute({ action: "read", lines: 0 });
    expect(badLines.isError).toBe(true);
    const badLines2 = await tool.execute({ action: "read", lines: 2.5 });
    expect(badLines2.isError).toBe(true);
    const badSession = await tool.execute({ action: "run", command: "echo x", session: "  " });
    expect(badSession.isError).toBe(true);
  });

  it("校验失败不记 history 条目（副作用零）", async () => {
    const tool = await toolFor();
    setTerminalHistorySink((e) => entries.push(e));
    await tool.execute({ action: "run" });
    expect(entries).toEqual([]);
  });
});

describe("terminal — run/read/send/exit 语义（真 PTY）", () => {
  it("run 基线：输出含命令回显与结果，零 ANSI、零 \\r", { timeout: 20_000 }, async () => {
    const tool = await toolFor();
    const r = await tool.execute({ action: "run", command: "echo wudao-tool" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("wudao-tool");
    expect(r.content).not.toContain("\x1b[");
    expect(r.content).not.toContain("\r");
  });

  it("状态跨工具调用存活：FOO=bar → echo $FOO 读到 bar", { timeout: 20_000 }, async () => {
    const tool = await toolFor();
    await tool.execute({ action: "run", command: "FOO=toolvar" });
    const r = await tool.execute({ action: "run", command: "echo $FOO" });
    expect(r.content).toContain("toolvar");
  });

  it("read 轮询：前一命令输出可由后续 read 读到", { timeout: 20_000 }, async () => {
    const tool = await toolFor();
    await tool.execute({ action: "run", command: "echo tool-read-marker" });
    const r = await tool.execute({ action: "read", lines: 20 });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("tool-read-marker");
  });

  it("send 向交互式进程投递输入；read 见回显", { timeout: 20_000 }, async () => {
    const tool = await toolFor();
    await tool.execute({ action: "run", command: "cat" });
    await tool.execute({ action: "send", input: "interactive-answer" });
    await new Promise((r) => setTimeout(r, 400));
    const r = await tool.execute({ action: "read", lines: 20 });
    expect(r.content).toContain("interactive-answer");
  });

  it("exit 后动作报会话已结束（isError，不自动重开）", { timeout: 20_000 }, async () => {
    const tool = await toolFor();
    await tool.execute({ action: "run", command: "echo x" });
    const ex = await tool.execute({ action: "exit" });
    expect(ex.isError).toBeFalsy();
    const after = await tool.execute({ action: "read", lines: 5 });
    expect(after.isError).toBe(true);
    expect(after.content).toContain("ended");
  });
});

describe("terminal — 每动作 history 条目（红线 4）", () => {
  it("五个动作各记一条 terminal 条目（action/session/命令）", { timeout: 25_000 }, async () => {
    const tool = await toolFor();
    setTerminalHistorySink((e) => entries.push(e));
    await tool.execute({ action: "run", command: "echo one" });
    await tool.execute({ action: "send", input: "y" }).catch(() => {});
    await tool.execute({ action: "read", lines: 5 });
    await tool.execute({ action: "interrupt" });
    await tool.execute({ action: "exit" });
    expect(entries.map((e) => e.type)).toEqual(["terminal", "terminal", "terminal", "terminal", "terminal"]);
    const actions = entries.map((e) => (e.data as { action: string }).action);
    expect(actions).toEqual(["run", "send", "read", "interrupt", "exit"]);
    const sessions = entries.map((e) => (e.data as { session: string }).session);
    expect(sessions).toEqual(["main", "main", "main", "main", "main"]);
  });

  it("缺省会话记为 main；命令首行截断；多行命令只记首行", { timeout: 20_000 }, async () => {
    const tool = await toolFor();
    setTerminalHistorySink((e) => entries.push(e));
    await tool.execute({ action: "run", command: "echo first-line\necho second-line" });
    const run = entries[0]?.data as { command?: string; session?: string };
    expect(run.command).toBe("echo first-line");
    expect(run.session).toBe("main");
  });

  it("sink 缺省时零条目（边界：无 store 接线的嵌入面）", { timeout: 20_000 }, async () => {
    const tool = await toolFor();
    await tool.execute({ action: "run", command: "echo nosink" });
    expect(entries).toEqual([]);
  });
});

describe("buildTerminalEntry（rewind_turn 同款缝的纯构建器）", () => {
  it("action/session/at 齐备；命令只记首行", () => {
    const e = buildTerminalEntry({ action: "run", session: "aux", command: "echo first-line\nsecret-second-line" });
    expect(e.type).toBe(TERMINAL_ENTRY_TYPE);
    const d = e.data as { action: string; session: string; command: string; at: string };
    expect(d.action).toBe("run");
    expect(d.session).toBe("aux");
    expect(d.command).toBe("echo first-line");
    expect(typeof d.at).toBe("string");
  });

  it("send 的控制字符以转义形入档（JSONL 序列化面）", () => {
    const e = buildTerminalEntry({ action: "send", session: "main", input: "y\x03" });
    expect(JSON.stringify(e.data)).toContain("\\u0003");
  });

  it("超长命令带截断标记；input 记原文（转义发生在序列化）", () => {
    const long = `echo ${"z".repeat(500)}`;
    const e = buildTerminalEntry({ action: "run", session: "main", command: long });
    const d = e.data as { command: string };
    expect(d.command.length).toBeLessThanOrEqual(200);
    expect(d.command).toContain("…");
  });
});
