// ω99-281: #3 — 删除守卫扩展测试：目标会话自己的 core lease（.leases/
// <id>.json）活 pid 在持 → 不可删（他进程 resume 正在写的会话，rename 删
// 会让对方下一次 append 在原路径脏复活）。driver 级语义用纯层组合验证：
// sessionLeaseAlive（lease 活性）+ deleteSessionFile（guardIds 组装后拒
// active）。夹具全 mkdtemp(os.tmpdir())，零触碰 ~/.wudao-desktop；EPERM
// 跨用户场景无法可靠造，源级钉实现形状（279 pet 段同款做法）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, stat, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionLeaseAlive, deleteSessionFile } from "../src/driver/session-delete.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wudao-281-lease-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const sessionsDir = (): string => join(dir, ".wudao", "sessions");

/** 写一个会话 JSONL（279 seed 同款直写）。 */
async function seedSession(id: string): Promise<string> {
  await mkdir(sessionsDir(), { recursive: true });
  const file = join(sessionsDir(), `${id}.jsonl`);
  await writeFile(file, JSON.stringify({ role: "user", content: "正文" }) + "\n", "utf8");
  return file;
}

/** 写一个 core lease 载荷（acquireSessionLease 同款 {pid,at,gen} 形）。 */
async function seedLease(id: string, pid: number): Promise<void> {
  await mkdir(join(sessionsDir(), ".leases"), { recursive: true });
  await writeFile(
    join(sessionsDir(), ".leases", `${id}.json`),
    JSON.stringify({ pid, at: new Date().toISOString(), gen: "g1" }),
    "utf8",
  );
}

describe("ω99-281 sessionLeaseAlive — 活锁拒（driver 级语义组合）", () => {
  it("活 pid（自己）持锁 → true；入 guardIds 后 deleteSessionFile 拒 active、原文件原地、.trash 不建", async () => {
    const file = await seedSession("sess-held");
    await seedLease("sess-held", process.pid); // 自己 pid 必活
    await expect(sessionLeaseAlive(sessionsDir(), "sess-held")).resolves.toBe(true);
    // driver 级语义的纯层组合：lease 活 → guardIds 含 id → active 拒。
    const r = await deleteSessionFile(sessionsDir(), "sess-held", { guardIds: ["sess-held"] });
    expect(r).toEqual({ deleted: false, reason: "active" });
    expect((await stat(file)).isFile()).toBe(true); // 原文件原地
    await expect(stat(join(sessionsDir(), ".trash"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("ω99-281 sessionLeaseAlive — 死锁不守", () => {
  it("死 pid 持锁 → false（死锁会被 acquire 偷回，不构成保护理由）；无守卫时照常删", async () => {
    // spawn 真子进程，kill 后等 libuv 收尸（exit 事件后 kill(pid,0) 才 ESRCH）。
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
    const deadPid = child.pid as number;
    await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    // 前置钉：pid 确已死（防僵尸假阳性——僵尸对 signal 0 仍应答）。
    expect(() => process.kill(deadPid, 0)).toThrow();
    await seedSession("sess-dead");
    await seedLease("sess-dead", deadPid);
    await expect(sessionLeaseAlive(sessionsDir(), "sess-dead")).resolves.toBe(false);
    expect(await deleteSessionFile(sessionsDir(), "sess-dead")).toEqual({ deleted: true });
  });
});

describe("ω99-281 sessionLeaseAlive — 无锁/坏锁不守", () => {
  it("无 .leases 目录 → false", async () => {
    await seedSession("sess-nolease");
    await expect(sessionLeaseAlive(sessionsDir(), "sess-nolease")).resolves.toBe(false);
  });

  it("坏载荷全 false：空文件 / 非 JSON / {} / pid 非数字（\"123\"）", async () => {
    await mkdir(join(sessionsDir(), ".leases"), { recursive: true });
    const bad: readonly [string, string][] = [
      ["sess-empty", ""],
      ["sess-junk", "not-json{"],
      ["sess-nopid", "{}"],
      ["sess-strpid", JSON.stringify({ pid: "123", at: "2026-09-01T00:00:00Z", gen: "g" })],
    ];
    for (const [id, content] of bad) {
      await writeFile(join(sessionsDir(), ".leases", `${id}.json`), content, "utf8");
      await expect(sessionLeaseAlive(sessionsDir(), id), `id=${id}`).resolves.toBe(false);
    }
  });
});

describe("ω99-281 sessionLeaseAlive — 坏 id 形状门", () => {
  it("空 / 穿越形 / side- 前缀 → false，零读盘（根目录不存在也不抛、不被创建）", async () => {
    // 传一个根本不存在的 sessions 根：形状门必须在拼路径之前拒。
    const absent = join(dir, "never-made");
    for (const badId of ["", "../evil", "a/b", "side-x", "..", "."]) {
      await expect(sessionLeaseAlive(absent, badId), `id=${JSON.stringify(badId)}`).resolves.toBe(false);
    }
    await expect(stat(absent)).rejects.toMatchObject({ code: "ENOENT" }); // 零触碰
  });
});

describe("ω99-281 sessionLeaseAlive — EPERM 活属他人（钉实现形状）", () => {
  it("源级断言：helper 含 kill(pid,0) + EPERM 分支（跨用户场景无法可靠造，形状钉死）", async () => {
    const src = await readFile(
      fileURLToPath(new URL("../src/driver/session-delete.ts", import.meta.url)),
      "utf8",
    );
    // 判据与 core src/session/lease.ts 的 isAlive 字面孪生。
    expect(src).toContain("process.kill(");
    expect(src).toContain("EPERM");
  });
});
