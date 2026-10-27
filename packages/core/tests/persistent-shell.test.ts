// 持久 bash（prime-agent #3640 引进弧）— 验收：记录生命周期（建档三件套 →
// append 封顶 → finalize → list）、identity 稳定性（+腐改记录 fail-closed
// 跳读）、输出窗口封顶（head 冻结 / tail 滚动 / 中段字节计数 / 代理对安全）、
// 孤儿清理（age 线 + 腐 lastSeenAt fail-closed）、crash 后重挂语义（.rc 缺席
// + lastSeenAt 超时 → 进程已消失、输出保留；grace 内按他进程所有如实报）、
// runtime 真子进程（spawn 泵 → close 收尾 → 组击杀 stop → outstanding 面 →
// 存活上限）。夹具只写 tmpdir；子进程是真 sh（echo/sleep——python-kernel
// test 的真子进程纪律）。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendShellOutput,
  createShellRecord,
  finalizeShell,
  listPersistentShells,
  persistentShellDir,
  persistentShellRuntime,
  pruneStaleShells,
  readShellOutput,
  shellExitCode,
  shellRecordIdentity,
  PERSISTENT_SHELL_ORPHAN_GRACE_MS,
  type PersistentShellRecord,
} from "../src/index.js";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 代理对测试的头垫（x 前缀长度——让定窗边界落在 emoji 对流中间）。 */
const HEAD_PAD = 4090;

async function until(cond: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wudao-pshell-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

/** 直接重写记录的 lastSeenAt（identity 不含 lastSeenAt——重写不破身份校验）。 */
async function rewriteSeen(id: string, iso: string): Promise<void> {
  const path = join(persistentShellDir(root), `${id}.json`);
  const raw = JSON.parse(await readFile(path, "utf8")) as PersistentShellRecord;
  await writeFile(path, JSON.stringify({ ...raw, lastSeenAt: iso }), "utf8");
}

// ---------------------------------------------------------------------------
// 存储层（纯函数面）
// ---------------------------------------------------------------------------

describe("persistent shell 记录生命周期", () => {
  it("建档三件套：.json + 空 .out，.rc 缺席（运行中的判定面）", () => {
    const record = createShellRecord(root, "pnpm build");
    expect(existsSync(join(persistentShellDir(root), `${record.id}.json`))).toBe(true);
    expect(readShellOutput(root, record.id)).toBe("");
    expect(shellExitCode(root, record.id)).toBeUndefined();
    expect(record.command).toBe("pnpm build");
  });

  it("append → 读回 → finalize(rc) → list（lastSeenAt 单调）", async () => {
    const record = createShellRecord(root, "make test");
    appendShellOutput(root, record.id, "line1\n");
    appendShellOutput(root, record.id, "line2\n");
    expect(readShellOutput(root, record.id)).toBe("line1\nline2\n");
    const seenBefore = listPersistentShells(root)[0]!.lastSeenAt;
    expect(seenBefore >= record.createdAt).toBe(true);
    finalizeShell(root, record.id, 0);
    expect(shellExitCode(root, record.id)).toBe(0);
    const after = listPersistentShells(root);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(record.id);
    expect(after[0]!.lastSeenAt >= seenBefore).toBe(true);
  });
});

describe("persistent shell identity（而非 pid）", () => {
  it("同一 (command, createdAt) → 同一 identity；任一变动 → 不同", () => {
    const a = shellRecordIdentity("cmd", "2026-10-28T00:00:00.000Z");
    expect(shellRecordIdentity("cmd", "2026-10-28T00:00:00.000Z")).toBe(a);
    expect(shellRecordIdentity("cmd", "2026-10-28T00:00:00.001Z")).not.toBe(a);
    expect(shellRecordIdentity("cmd2", "2026-10-28T00:00:00.000Z")).not.toBe(a);
  });

  it("建档即校验面：identity 与 command/createdAt 一致", () => {
    const record = createShellRecord(root, "echo x");
    expect(record.identity).toBe(shellRecordIdentity(record.command, record.createdAt));
  });

  it("腐改记录（command 被改、identity 没跟）→ listPersistentShells 跳读（fail-closed）", async () => {
    const record = createShellRecord(root, "echo original");
    const path = join(persistentShellDir(root), `${record.id}.json`);
    const raw = JSON.parse(await readFile(path, "utf8")) as PersistentShellRecord;
    await writeFile(path, JSON.stringify({ ...raw, command: "echo tampered" }), "utf8");
    expect(listPersistentShells(root)).toHaveLength(0);
  });
});

describe("persistent shell 输出窗口封顶（head 4KB + tail 4KB）", () => {
  it("窗口内原样；溢出定头劈尾、中段字节计数；此后头冻结、尾滚动、计数只增", () => {
    const record = createShellRecord(root, "firehose");

    appendShellOutput(root, record.id, "a".repeat(3000));
    appendShellOutput(root, record.id, "b".repeat(3000));
    // 6000 ≤ 8192：仍是无标记全量。
    expect(readShellOutput(root, record.id)).toBe("a".repeat(3000) + "b".repeat(3000));

    appendShellOutput(root, record.id, "c".repeat(3000));
    // 9000 > 8192：首次定窗。head = a*3000+b*1096；tail = b*1096+c*3000；
    // 中段 808 ASCII 字节。
    const windowed = readShellOutput(root, record.id);
    expect(windowed).toBe(
      "a".repeat(3000) + "b".repeat(1096) +
      "\n[... 808 bytes truncated ...]\n" +
      "b".repeat(1096) + "c".repeat(3000),
    );

    appendShellOutput(root, record.id, "d".repeat(100));
    // 尾流 1096+3000+100=4196 > 4096：滚出的 100 个 b 计入中段（808→908）。
    // 头不变。
    expect(readShellOutput(root, record.id)).toBe(
      "a".repeat(3000) + "b".repeat(1096) +
      "\n[... 908 bytes truncated ...]\n" +
      "b".repeat(996) + "c".repeat(3000) + "d".repeat(100),
    );
  });

  it("劈在代理对中间也不产生孤立代理项（113-A4 原语收口）", () => {
    const record = createShellRecord(root, "emoji-firehose");
    appendShellOutput(root, record.id, "x".repeat(HEAD_PAD));
    appendShellOutput(root, record.id, "🎉".repeat(2200)); // 每项 2 单元/4 字节 → 必然溢出
    const text = readShellOutput(root, record.id);
    expect(text).toContain("bytes truncated ...]");
    expect(text.startsWith("x".repeat(HEAD_PAD))).toBe(true);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});

describe("persistent shell 孤儿清理 pruneStaleShells", () => {
  it("超龄三件套整体删除，鲜活保留（缺省 7 天线）", async () => {
    const oldShell = createShellRecord(root, "old-watch");
    const freshShell = createShellRecord(root, "fresh-build");
    appendShellOutput(root, oldShell.id, "stale\n");
    finalizeShell(root, oldShell.id, 0);
    await rewriteSeen(oldShell.id, new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString());
    const pruned = pruneStaleShells(root);
    expect(pruned).toEqual([oldShell.id]);
    expect(existsSync(join(persistentShellDir(root), `${oldShell.id}.json`))).toBe(false);
    expect(existsSync(join(persistentShellDir(root), `${oldShell.id}.out`))).toBe(false);
    expect(existsSync(join(persistentShellDir(root), `${oldShell.id}.rc`))).toBe(false);
    expect(listPersistentShells(root).map((r) => r.id)).toEqual([freshShell.id]);
  });

  it("自定义 maxAge 与不可解析的 lastSeenAt（fail-closed 按超龄清）", async () => {
    const shell2h = createShellRecord(root, "two-hours");
    await rewriteSeen(shell2h.id, new Date(Date.now() - 2 * 60 * 60_000).toISOString());
    expect(pruneStaleShells(root, 60 * 60_000)).toEqual([shell2h.id]);
    const corrupt = createShellRecord(root, "corrupt-seen");
    await rewriteSeen(corrupt.id, "not-a-date");
    expect(pruneStaleShells(root)).toEqual([corrupt.id]);
  });
});

// ---------------------------------------------------------------------------
// runtime（进程注册表 + 真子进程；POSIX-only 面）
// ---------------------------------------------------------------------------

describe("persistent shell runtime — crash 后重挂语义（无进程的记录）", () => {
  it("grace 内：running + owned:false（他进程所有，如实报）；超时：vanished、输出保留", async () => {
    const record = createShellRecord(root, "ghost-cmd");
    appendShellOutput(root, record.id, "ghost-output\n");
    const rt = persistentShellRuntime(root);
    const fresh = rt.status(record.id);
    expect(fresh?.state).toBe("running");
    expect(fresh?.owned).toBe(false);
    await rewriteSeen(record.id, new Date(Date.now() - (PERSISTENT_SHELL_ORPHAN_GRACE_MS + 60_000)).toISOString());
    const vanished = rt.status(record.id);
    expect(vanished?.state).toBe("vanished");
    expect(readShellOutput(root, record.id)).toBe("ghost-output\n"); // 输出保留
  });

  it("外属/未知 id 的 stop：typed 拒（绝不按盘上记录赌 pid）", async () => {
    const record = createShellRecord(root, "foreign-cmd");
    const rt = persistentShellRuntime(root);
    await expect(rt.stop(record.id)).resolves.toEqual({ kind: "foreign" });
    await expect(rt.stop("no-such-id")).resolves.toEqual({ kind: "unknown" });
    finalizeShell(root, record.id, 3);
    await expect(rt.stop(record.id)).resolves.toEqual({ kind: "finished", exitCode: 3 });
  });

  it("status：未知 id → undefined", () => {
    expect(persistentShellRuntime(root).status("deadbeef")).toBeUndefined();
  });
});

describe("persistent shell runtime — 真子进程生命周期", () => {
  it("start → 泵落 .out → close 收尾 rc → outstanding 由有到无", async () => {
    const rt = persistentShellRuntime(root);
    const started = rt.start("echo pshell-hello; sleep 0.3; echo pshell-world");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(rt.outstanding().map((s) => s.id)).toContain(started.record.id);
    expect(rt.outstanding().find((s) => s.id === started.record.id)?.command).toBe(
      "echo pshell-hello; sleep 0.3; echo pshell-world",
    );
    await until(() => shellExitCode(root, started.record.id) !== undefined, "shell close + rc", 8000);
    expect(shellExitCode(root, started.record.id)).toBe(0);
    const output = readShellOutput(root, started.record.id);
    expect(output).toContain("pshell-hello");
    expect(output).toContain("pshell-world");
    const status = rt.status(started.record.id);
    expect(status?.state).toBe("finished");
    expect(status?.exitCode).toBe(0);
    expect(rt.outstanding().map((s) => s.id)).not.toContain(started.record.id);
  }, 12_000);

  it("stop：组击杀（整条流水线死）→ rc 落盘（信号杀 = -1）→ 幂等 finished", async () => {
    const rt = persistentShellRuntime(root);
    const started = rt.start("while :; do echo beat; sleep 0.1; done");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await until(
      () => readShellOutput(root, started.record.id).split("beat").length >= 3,
      "heartbeat output",
      8000,
    );
    const stopped = await rt.stop(started.record.id);
    expect(stopped).toMatchObject({ kind: "stopped" });
    await until(() => shellExitCode(root, started.record.id) !== undefined, "killed rc", 8000);
    expect(shellExitCode(root, started.record.id)).toBe(-1); // TERM 组杀 → 无干净退出码
    // 组死透：泵已停，窗口冻结（等一拍再读，字节不再长）。
    const frozen = readShellOutput(root, started.record.id);
    await wait(300);
    expect(readShellOutput(root, started.record.id)).toBe(frozen);
    await expect(rt.stop(started.record.id)).resolves.toMatchObject({ kind: "finished" });
  }, 15_000);

  it("存活上限 16：第 17 个 typed 拒（拒绝不留孤儿记录）", async () => {
    const rt = persistentShellRuntime(root);
    const ids: string[] = [];
    for (let i = 0; i < 16; i += 1) {
      const s = rt.start("sleep 10");
      expect(s.ok).toBe(true);
      if (s.ok) ids.push(s.record.id);
    }
    expect(rt.aliveCount()).toBe(16);
    const refused = rt.start("sleep 10");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("too many live persistent shells");
    for (const id of ids) await rt.stop(id);
    await until(() => rt.aliveCount() === 0, "all stopped", 10_000);
  }, 25_000);
});
