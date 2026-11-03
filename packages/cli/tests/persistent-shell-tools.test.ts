// 持久 bash（prime-agent #3640）工具三件——挂载面 + 生命周期回执：装配
// （top-level only 尾挂载、沙箱零注册、READ_TOOLS 姿势）、shell_start 校验
// 与回执、shell_read（窗口 + 三态状态行 + 列表面 + 进程已消失语义）、
// shell_stop（组停 + 已完/外属/未知 typed 面）、风险标注
// （isDestructive 沿 commandLooksDestructive；shell_read 只读 + loopExempt
// 轮询豁免）。机制面（封顶窗口/孤儿清理/注册表）由 core 的
// persistent-shell.test.ts 钉住，此处不重复。夹具只写 tmpdir。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildToolSet } from "../src/tools.js";
import { createPersistentShellTools } from "../src/persistent-shell-tools.js";
import { READ_TOOLS } from "../src/permission-modes.js";
import {
  appendShellOutput,
  buildTool,
  createShellRecord,
  persistentShellDir,
  shellExitCode,
  PERSISTENT_SHELL_ORPHAN_GRACE_MS,
  type PersistentShellRecord,
  type Tool,
} from "@wudao-org/core";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

/** 从 shell_start 回执里解析 shell id（[persistent shell <id>] 行）。 */
const idFromReceipt = (content: string): string => {
  const m = /\[persistent shell ([0-9a-f]+)\]/.exec(content);
  if (m === null) throw new Error(`no shell id in receipt: ${content.slice(0, 120)}`);
  return m[1]!;
};

const baseOpts = {
  workspaceRoot: "/tmp/w",
  model: { modelId: "m", generate: async () => ({ role: "assistant", content: "x" }) } as never,
  canUseTool: async () => ({ behavior: "allow" }) as never,
  contextWindowTokens: 100_000,
};

let root: string;
let tools: readonly Tool[];
let shellStart: Tool;
let shellRead: Tool;
let shellStop: Tool;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wudao-pshell-tools-"));
  tools = createPersistentShellTools({ workspaceRoot: root });
  shellStart = tools.find((t) => t.name === "shell_start")!;
  shellRead = tools.find((t) => t.name === "shell_read")!;
  shellStop = tools.find((t) => t.name === "shell_stop")!;
});
afterEach(async () => {
  // 各测试自停自起的 shell（成功路径天然收尾，失败残留 30s 后自灭——
  // 夹具目录只在 tmpdir，永不删用户文件）。
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

/** 直接重写记录 lastSeenAt，把未拥有记录推过 grace（模拟拥有进程已死）。 */
async function backdate(id: string, iso: string): Promise<void> {
  const path = join(persistentShellDir(root), `${id}.json`);
  const raw = JSON.parse(await readFile(path, "utf8")) as PersistentShellRecord;
  await writeFile(path, JSON.stringify({ ...raw, lastSeenAt: iso }), "utf8");
}

describe("shell trio 挂载面（buildToolSet 装配 + 权限姿势）", () => {
  it("builtin 段内挂载（constitution_suggest 之后、MCP 段之前——MCP 尾部不变量）", () => {
    const names = buildToolSet({ ...baseOpts }).map((t) => t.name);
    expect(names).toContain("shell_start");
    expect(names).toContain("shell_read");
    expect(names).toContain("shell_stop");
    expect(names.indexOf("shell_start")).toBeGreaterThan(names.indexOf("constitution_suggest"));
    // MCP 段之前：extraTools（MCP 面）仍然最后（M24 前缀卫生——builtin 段
    // 内 append-only，MCP 尾部位置不动）。
    const fakeMcp = buildTool({ name: "mcp__fake__echo", description: "d", parameters: { type: "object", properties: {}, additionalProperties: false }, async execute() { return { content: "ok" }; } });
    const withMcp = buildToolSet({ ...baseOpts, extraTools: [fakeMcp] }).map((t) => t.name);
    expect(withMcp[withMcp.length - 1]).toBe("mcp__fake__echo");
    expect(withMcp.indexOf("shell_start")).toBeLessThan(withMcp.indexOf("mcp__fake__echo"));
  });

  it("沙箱会话零注册（host 直起的持久进程是 docker 沙箱的逃逸面）", () => {
    const names = buildToolSet({ ...baseOpts, sandbox: { image: "node:22-alpine" } }).map((t) => t.name);
    expect(names).not.toContain("shell_start");
    expect(names).not.toContain("shell_read");
    expect(names).not.toContain("shell_stop");
  });

  it("READ_TOOLS：shell_read 只读面入册；start/stop 不入（fail-closed ask 姿势）", () => {
    expect(READ_TOOLS.has("shell_read")).toBe(true);
    expect(READ_TOOLS.has("shell_start")).toBe(false);
    expect(READ_TOOLS.has("shell_stop")).toBe(false);
  });
});

describe("shell_start", () => {
  it("回执带 id/pid/轮询指引；窗口里能续读到输出与 finished 状态", async () => {
    const r = await shellStart.execute({ command: "echo tool-ok-42", description: "smoke" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("no timeout");
    expect(r.content).toContain("shell_read(id:");
    expect(r.content).toContain("$ echo tool-ok-42");
    const id = idFromReceipt(r.content);
    await until(() => shellExitCode(root, id) !== undefined, "shell close", 8000);
    const read = await shellRead.execute({ id });
    expect(read.isError).toBeFalsy();
    expect(read.content).toContain("tool-ok-42");
    expect(read.content).toContain("state: finished (exit 0)");
    expect(read.content).toContain("---- output ----");
  }, 12_000);

  it("fail-closed 校验：非字符串/空命令 → typed 错误，不留记录", async () => {
    const empty = await shellStart.execute({ command: "" });
    expect(empty.isError).toBe(true);
    expect(empty.content).toContain("non-empty string");
    const notString = await shellStart.execute({ command: 42 });
    expect(notString.isError).toBe(true);
  });
});

describe("shell_read", () => {
  it("无 id → 列表面（含状态与命令行）；空时给教学行", async () => {
    const empty = await shellRead.execute({});
    expect(empty.isError).toBeFalsy();
    expect(empty.content).toContain("none");
    const r = await shellStart.execute({ command: "echo list-face" });
    const id = idFromReceipt(r.content);
    await until(() => shellExitCode(root, id) !== undefined, "shell close", 8000);
    const list = await shellRead.execute({});
    expect(list.content).toContain("[persistent shells] 1");
    expect(list.content).toContain(id);
    expect(list.content).toContain("$ echo list-face");
  }, 12_000);

  it("crash 后语义：未拥有 + 超时 → 进程已消失、输出保留；宽限内如实报他进程所有", async () => {
    const record = createShellRecord(root, "ghost-watch");
    appendShellOutput(root, record.id, "ghost-output-line\n");
    const fresh = await shellRead.execute({ id: record.id });
    expect(fresh.content).toContain("owned by another harness process");
    await backdate(record.id, new Date(Date.now() - (PERSISTENT_SHELL_ORPHAN_GRACE_MS + 60_000)).toISOString());
    const vanished = await shellRead.execute({ id: record.id });
    expect(vanished.isError).toBeFalsy();
    expect(vanished.content).toContain("进程已消失，输出保留");
    expect(vanished.content).toContain("ghost-output-line"); // 输出保留
  });

  it("未知 id / 坏类型 → typed 错误", async () => {
    const unknown = await shellRead.execute({ id: "deadbeef0000" });
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toContain("unknown shell id");
    const badType = await shellRead.execute({ id: 7 });
    expect(badType.isError).toBe(true);
  });
});

describe("shell_stop", () => {
  it("活 shell：组停 + rc 落盘（信号杀 -1）+ 输出窗保留；再停 → already finished", async () => {
    const r = await shellStart.execute({ command: "sleep 30" });
    const id = idFromReceipt(r.content);
    const stopped = await shellStop.execute({ id });
    expect(stopped.isError).toBeFalsy();
    expect(stopped.content).toContain("stopped");
    await until(() => shellExitCode(root, id) !== undefined, "killed rc", 8000);
    const read = await shellRead.execute({ id });
    expect(read.content).toContain("state: finished (exit -1)");
    const again = await shellStop.execute({ id });
    expect(again.isError).toBeFalsy();
    expect(again.content).toContain("already finished");
  }, 12_000);

  it("进程已消失的 shell：no-op 拒（绝不按盘上记录赌 pid）；未知 id → typed 错误", async () => {
    const record = createShellRecord(root, "foreign-shell");
    await backdate(record.id, new Date(Date.now() - (PERSISTENT_SHELL_ORPHAN_GRACE_MS + 60_000)).toISOString());
    const foreign = await shellStop.execute({ id: record.id });
    expect(foreign.isError).toBeFalsy();
    expect(foreign.content).toContain("进程已消失");
    const unknown = await shellStop.execute({ id: "deadbeef0000" });
    expect(unknown.isError).toBe(true);
    const missing = await shellStop.execute({});
    expect(missing.isError).toBe(true);
  });
});

describe("shell trio 风险标注（fail-closed 面的显式覆盖）", () => {
  it("shell_start：isDestructive 沿 commandLooksDestructive；永不只读", () => {
    expect(shellStart.isDestructive?.({ command: "rm -rf build/" })).toBe(true);
    expect(shellStart.isDestructive?.({ command: "echo hi" })).toBe(false);
    expect(shellStart.isReadOnly?.({ command: "echo hi" })).toBe(false);
    expect(shellStart.isOpenWorld?.({ command: "echo hi" })).toBe(true);
  });

  it("shell_read：只读 + 轮询豁免（同一 id 重复读是 watch 语义）", () => {
    expect(shellRead.isReadOnly?.({})).toBe(true);
    expect(shellRead.loopExempt?.({ id: "abc" })).toBe(true);
  });

  it("shell_stop：破坏性标注（杀进程是人该看见的动作）", () => {
    expect(shellStop.isDestructive?.({ id: "abc" })).toBe(true);
    expect(shellStop.isReadOnly?.({ id: "abc" })).toBe(false);
  });
});
