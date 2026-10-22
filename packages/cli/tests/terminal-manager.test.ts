// P2-12（96 队列 #12）TerminalManager 生命周期单测 — 真 PTY（node-pty
// 1.1.0 精确锁）跑核心语义：状态跨调用存活（本弧存在理由）、settle、
// ring buffer、idle 回收、kill 阶梯。确定性纪律：注入 /bin/bash
// --noprofile --norc + 短时钟参数（echo/cat/sleep 命令，无网络无随机）。
// LSP manager 同款形状：懒 spawn / idle unref 计时器 / 失败 fail-closed。
import { describe, it, expect, afterEach } from "vitest";
import { loadNodePty, type PtyProcess, type PtySpawnFn } from "../src/terminal/pty.js";
import { TerminalManager } from "../src/terminal/manager.js";

// Hermetic shell: bash with no rc files — deterministic prompts/echo.
const TEST_SHELL = { file: "/bin/bash", args: ["--noprofile", "--norc"] } as const;

let loadCount = 0;
const managers: TerminalManager[] = [];
function track(m: TerminalManager): TerminalManager {
  managers.push(m);
  return m;
}

afterEach(async () => {
  for (const m of managers.splice(0)) await m.dispose().catch(() => {});
});

/** 条件轮询：等到 cond 为真（上限 timeoutMs）。原来各处「固定 sleep 后断言」
 *  把「调度延迟低」当假设——负载下回调/子进程 I/O 拖过后就红；等条件不是等时钟。 */
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** The real node-pty spawn fn (this suite is the真 PTY suite — hard-fail if the native module is unavailable). */
async function realSpawn(): Promise<PtySpawnFn> {
  const load = await loadNodePty();
  if (!load.ok) throw new Error(`node-pty unavailable in this environment: ${load.reason}`);
  loadCount += 1;
  return load.spawn;
}

function makeManager(spawn: PtySpawnFn, opts: Partial<ConstructorParameters<typeof TerminalManager>[0]> = {}): TerminalManager {
  return track(new TerminalManager({
    cwd: process.cwd(),
    spawnFn: spawn,
    shell: TEST_SHELL,
    settleSilenceMs: 150,
    settleMaxMs: 8_000,
    idleTimeoutMs: 10 * 60_000,
    ...opts,
  }));
}

describe("TerminalManager — run 基线 + settle", () => {
  it("run echo hello → 输出含 hello，无 ANSI 转义序列（\x1b[ 永不出现）", { timeout: 20_000 }, async () => {
    const m = makeManager(await realSpawn());
    const out = await m.run("main", "echo hello");
    expect(out.output).toContain("hello");
    expect(out.output).not.toContain("\x1b[");
    expect(out.output).not.toContain("\r");
  });

  it("无会话时 run 懒 spawn；第二次 run 复用同一会话（跨调用存活）", { timeout: 20_000 }, async () => {
    const m = makeManager(await realSpawn());
    expect(m.liveSessions()).toEqual([]);
    await m.run("main", "echo first");
    expect(m.liveSessions()).toEqual(["main"]);
    const pid1 = m.sessionPid("main");
    await m.run("main", "echo second");
    expect(m.sessionPid("main")).toBe(pid1);
  });
});

describe("TerminalManager — 状态跨工具调用存活（本弧核心语义）", () => {
  it("export 的变量在后续 run 里可见：FOO=bar → echo $FOO 输出 bar", { timeout: 20_000 }, async () => {
    const m = makeManager(await realSpawn());
    await m.run("main", "FOO=bar");
    const out = await m.run("main", "echo $FOO");
    expect(out.output).toContain("bar");
  });

  it("cd 状态存活：cd /tmp → pwd 输出含 /tmp", { timeout: 20_000 }, async () => {
    const m = makeManager(await realSpawn());
    await m.run("main", "cd /tmp");
    const out = await m.run("main", "pwd");
    expect(out.output).toContain("/tmp");
  });
});

describe("TerminalManager — send / read", () => {
  it("交互式 cat：send 文本 → read 见回显", { timeout: 20_000 }, async () => {
    const m = makeManager(await realSpawn());
    await m.run("main", "cat");
    await m.send("main", "wudao-echo-line");
    // 原来：固定 sleep(400) 后断言——cat 回显经 PTY 到 ring 的延迟无上界保证，
    // 负载下 400ms 不够就红。轮询到回显进 ring 再读。
    let echoed = "";
    await until(async () => {
      echoed = (await m.read("main", 50)).text;
      return echoed.includes("wudao-echo-line");
    }, "cat echo into ring");
    expect(echoed).not.toContain("\x1b[");
  });

  it("read 缺省 50 行、上限截断（lines=2 只回尾部 2 行）", { timeout: 20_000 }, async () => {
    const m = makeManager(await realSpawn());
    await m.run("main", "for i in 1 2 3 4 5; do echo line-$i; done");
    const read = await m.read("main", 2);
    const bodyLines = read.text.split("\n").filter((l) => l.trim() !== "");
    // 尾部预算=2 行（line-5 + 当下提示符片段）；历史行绝不能全量泄漏
    expect(read.text).toContain("line-5");
    expect(read.text).not.toContain("line-1");
    expect(bodyLines.length).toBeLessThanOrEqual(3);
  });

  it("read 见全量 ring 尾部：上一命令的输出仍在（跨调用）", { timeout: 20_000 }, async () => {
    const m = makeManager(await realSpawn());
    await m.run("main", "echo persisted-marker");
    await m.run("main", "echo newer-marker");
    const read = await m.read("main", 50);
    expect(read.text).toContain("persisted-marker");
    expect(read.text).toContain("newer-marker");
  });
});

describe("TerminalManager — interrupt / exit", () => {
  it("sleep 30 → interrupt（SIGINT）→ shell 恢复：后续命令照常执行", { timeout: 25_000 }, async () => {
    const m = makeManager(await realSpawn());
    await m.run("main", "echo ready");
    // 长任务用 send 投递（run 的 settle 会等满 settleMax）；
    await m.send("main", "sleep 30");
    // 原来：固定 sleep(300) 假设 sleep 已起跑——负载下 PTY 回显/调度延迟无
    // 上界，轮询到命令回显进 ring（= shell 已收到并执行该行）再发 SIGINT。
    await until(async () => (await m.read("main", 50)).text.includes("sleep 30"), "sleep 30 delivered");
    await m.interrupt("main");
    const out = await m.run("main", "echo after-interrupt");
    expect(out.output).toContain("after-interrupt");
  });

  it("exit 杀会话并清理：后续动作报会话已结束（fail-closed，不自动重开）", { timeout: 25_000 }, async () => {
    const m = makeManager(await realSpawn());
    await m.run("main", "echo alive");
    await m.exit("main");
    expect(m.liveSessions()).toEqual([]);
    await expect(m.read("main", 10)).rejects.toThrow(/已结束|ended/);
    await expect(m.send("main", "x")).rejects.toThrow(/已结束|ended/);
    await expect(m.run("main", "echo again")).rejects.toThrow(/已结束|ended/);
  });

  // timeout 20_000 → 25_000：2 次 run 的 settle 最坏 2×8s=16s + 新增的「会话已
  // 结束」轮询预算 5s——原预算容不下「负载拖满 settle + 轮询」的自身最坏组合。
  it("进程自然退出 → 会话关闭，后续动作报会话已结束", { timeout: 25_000 }, async () => {
    const m = makeManager(await realSpawn());
    await m.run("main", "echo bye");
    await m.run("main", "exit 7");
    // 原来：固定 sleep(500) 等自然退出事件到达——负载下 exit 事件传播无上界，
    // 500ms 不够 read 就还活着。轮询到 read 已 fail-closed 再做正式断言。
    await until(async () => {
      try { await m.read("main", 10); return false; } catch { return true; }
    }, "session ended after natural exit");
    await expect(m.read("main", 10)).rejects.toThrow(/已结束|ended/);
  });
});

describe("TerminalManager — 会话上限与命名", () => {
  // 原来 timeout 20_000 < 本测试自身的最坏预算：3 次 run（echo a/b/c，每次
  // settle 最坏 settleMaxMs=8s）+ exit 的 kill 阶梯 ~2.5s ≈ 26.5s——负载把 settle
  // 拖到上限时整体超时红（r3 签名）。按设计最坏预算放宽，断言一字不改。
  it("上限 2：第三个命名会话拒绝并列出活会话", { timeout: 35_000 }, async () => {
    const m = makeManager(await realSpawn());
    await m.run("main", "echo a");
    await m.run("aux", "echo b");
    await expect(m.run("third", "echo c")).rejects.toThrow(/limit \(2\)/);
    const err = await m.run("third", "echo c").catch((e: Error) => e.message);
    expect(err).toContain("main");
    expect(err).toContain("aux");
    // exit 一个后可再开
    await m.exit("aux");
    const out = await m.run("third", "echo c");
    expect(out.output).toContain("c");
  });
});

describe("TerminalManager — idle 回收（LSP manager 同款纪律）", () => {
  it("10 分钟（注入缩短）无动作 → 自动 exit + notice；再 run 即新会话（状态诚实清零）", { timeout: 30_000 }, async () => {
    const notices: string[] = [];
    const m = makeManager(await realSpawn(), { idleTimeoutMs: 350, onNotice: (s) => notices.push(s) });
    await m.run("main", "IDLE_SENTINEL=kept");
    expect(m.liveSessions()).toEqual(["main"]);
    // 原来：固定 sleep(900) 假设 idle 点火后回收即刻完成——实际 closeSession 的
    // kill 阶梯最坏 ~2.5s，负载下 900ms 内 sessions.delete 还没执行就红。
    // 轮询到会话真被移除（notice 与 delete 同步相邻，紧随其后断言安全）。
    await until(() => m.liveSessions().length === 0, "idle reap removes the session", 8000);
    expect(m.liveSessions()).toEqual([]);
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain("main");
    // 回收后同名 run = 全新 shell（无 tombstone）：旧状态不存在
    const out = await m.run("main", "echo ${IDLE_SENTINEL:-fresh}");
    expect(out.output).toContain("fresh");
  });

  it("动作会续命：idle 窗口内的动作重置计时（不误杀）", { timeout: 20_000 }, async () => {
    const notices: string[] = [];
    const m = makeManager(await realSpawn(), { idleTimeoutMs: 600, onNotice: (s) => notices.push(s) });
    await m.run("main", "echo 1");
    await new Promise((r) => setTimeout(r, 350));
    await m.run("main", "echo 2"); // 续命
    await new Promise((r) => setTimeout(r, 350));
    expect(m.liveSessions()).toEqual(["main"]); // 第二个 350ms 窗口未满 600ms
    expect(notices).toEqual([]);
    await m.dispose();
  });
});

// ---------------------------------------------------------------------------
// Fake spawn — 纯确定性边界测试（不碰真 PTY）。
// ---------------------------------------------------------------------------

class FakePty implements PtyProcess {
  readonly pid = 4242;
  private readonly listeners: Array<(d: string) => void> = [];
  private readonly exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  killed: string[] = [];
  written: string[] = [];
  emit(data: string): void { for (const l of this.listeners) l(data); }
  kill(signal?: string): void {
    this.killed.push(signal ?? "SIGHUP");
    for (const l of this.exitListeners) l({ exitCode: 0, signal: 0 });
  }
  write(data: string): void { this.written.push(data); }
  onData(l: (d: string) => void): { dispose(): void } {
    this.listeners.push(l);
    return { dispose: () => { const i = this.listeners.indexOf(l); if (i >= 0) this.listeners.splice(i, 1); } };
  }
  onExit(l: (e: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exitListeners.push(l);
    return { dispose: () => { const i = this.exitListeners.indexOf(l); if (i >= 0) this.exitListeners.splice(i, 1); } };
  }
}

describe("TerminalManager — ring buffer 256KB 上限（fake spawn，确定性）", () => {
  it("溢出丢头保尾 + 溢出标记", { timeout: 15_000 }, async () => {
    const fake = new FakePty();
    const m = makeManager((() => fake) as unknown as PtySpawnFn, { ringMaxChars: 1000, settleSilenceMs: 40, settleMaxMs: 300 });
    // 直接驱动 manager 内部：spawn 由 run 触发，随后灌数据
    const runP = m.run("main", "echo big");
    await new Promise((r) => setTimeout(r, 80)); // spawn 完成、命令已写
    fake.emit("AAAA"); // 头部标记
    fake.emit("X".repeat(1600)); // 撑爆 1000 字上限 → 丢头
    fake.emit("\nTAIL-MARKER\n");
    await runP;
    const read = await m.read("main", 200);
    expect(read.overflowed).toBe(true);
    expect(read.text).toContain("TAIL-MARKER");
    expect(read.text).not.toContain("AAAA"); // 头已丢
    expect(read.text).toContain("dropped"); // 标记行
  });

  it("未溢出时无标记", { timeout: 15_000 }, async () => {
    const fake = new FakePty();
    const m = makeManager((() => fake) as unknown as PtySpawnFn, { settleSilenceMs: 40, settleMaxMs: 300 });
    const runP = m.run("main", "echo small");
    await new Promise((r) => setTimeout(r, 80));
    fake.emit("just a line\n");
    await runP;
    const read = await m.read("main", 50);
    expect(read.overflowed).toBe(false);
    expect(read.text).not.toContain("dropped");
  });
});

describe("TerminalManager — 参数校验 fail-closed", () => {
  it("空/非字符串会话名拒绝；空命令拒绝", async () => {
    const m = makeManager((() => new FakePty()) as unknown as PtySpawnFn);
    await expect(m.run("", "echo x")).rejects.toThrow(/session/);
    await expect(m.run("  ", "echo x")).rejects.toThrow(/session/);
    await expect(m.run("main", "")).rejects.toThrow(/command/);
    await expect(m.run("main", "   ")).rejects.toThrow(/command/);
  });

  it("不存在的会话：send/read/interrupt 报无此会话并列出活会话", async () => {
    const m = makeManager((() => new FakePty()) as unknown as PtySpawnFn);
    await expect(m.read("nope", 10)).rejects.toThrow(/no session/);
    await expect(m.send("nope", "x")).rejects.toThrow(/no session/);
    await expect(m.interrupt("nope")).rejects.toThrow(/no session/);
  });
});
