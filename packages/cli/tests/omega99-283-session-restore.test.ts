// ω99-283: #6 — 回收站恢复纯层（279 的另一半：删除搬进 .trash/，恢复搬回来）。
// tmpdir 真实文件钉：快乐径（link+unlink 回活区、.trash 清空）；target-exists
// no-overwrite（活区同名字节不变——link EEXIST 拒，这正是选 link 而非 rename
// 的理由：rename 会静默覆盖=数据丢失）；not-found 零盘触碰；invalid-id 形状
// 拒；listTrashedSessions 的 mtime 降序 / 前 20 帽 / firstUser 折叠 / 无
// .trash → []；删-恢复往返幂等。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSessionFile, restoreSessionFile, listTrashedSessions, type SessionRestoreResult } from "../src/driver/session-delete.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wudao-283-restore-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const sessionsDir = (): string => join(dir, ".wudao", "sessions");

/** 写一个会话 JSONL 进活区（与 279 的 seed 同款直写）。 */
async function seed(id: string, lines: readonly unknown[] = [{ role: "user", content: "正文" }]): Promise<string> {
  const sd = sessionsDir();
  await mkdir(sd, { recursive: true });
  const file = join(sd, `${id}.jsonl`);
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return file;
}

/** 写一个会话 JSONL 直接进 .trash（不经删除——恢复测试只要回收件在场）。 */
async function seedTrash(id: string, lines: readonly unknown[] = [{ role: "user", content: "回收正文" }]): Promise<string> {
  const trash = join(sessionsDir(), ".trash");
  await mkdir(trash, { recursive: true });
  const file = join(trash, `${id}.jsonl`);
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return file;
}

describe("ω99-283 restoreSessionFile — 快乐径", () => {
  it("删除 → 恢复：{restored:true}，活区文件内容保真，.trash 空了", async () => {
    await seed("sess-r1", [{ role: "user", content: "恢复我" }]);
    expect(await deleteSessionFile(sessionsDir(), "sess-r1")).toEqual({ deleted: true });
    const r: SessionRestoreResult = await restoreSessionFile(sessionsDir(), "sess-r1");
    expect(r).toEqual({ restored: true });
    // 活区在，内容保真。
    const back = await readFile(join(sessionsDir(), "sess-r1.jsonl"), "utf8");
    expect(back).toContain("恢复我");
    // .trash 空了（唯一 unlink = 恢复成功后拆回收件——搬家收尾）。
    expect(await readdir(join(sessionsDir(), ".trash"))).toEqual([]);
  });

  it("恢复后再删再恢复（往返幂等）", async () => {
    await seed("sess-loop", [{ role: "user", content: "往返" }]);
    await deleteSessionFile(sessionsDir(), "sess-loop");
    expect(await restoreSessionFile(sessionsDir(), "sess-loop")).toEqual({ restored: true });
    await deleteSessionFile(sessionsDir(), "sess-loop");
    expect(await restoreSessionFile(sessionsDir(), "sess-loop")).toEqual({ restored: true });
    expect(await readFile(join(sessionsDir(), "sess-loop.jsonl"), "utf8")).toContain("往返");
  });
});

describe("ω99-283 restoreSessionFile — 拒答三因", () => {
  it("target-exists：活区已有同名 → 拒；活区文件字节不变（no-overwrite 亲证）；.trash 原样", async () => {
    const trashFile = await seedTrash("sess-clash", [{ role: "user", content: "回收站里的旧版" }]);
    const liveFile = await seed("sess-clash", [{ role: "user", content: "活区的新会话，绝不能被覆盖" }]);
    const r = await restoreSessionFile(sessionsDir(), "sess-clash");
    expect(r).toEqual({ restored: false, reason: "target-exists" });
    // 活区字节不变（link no-overwrite——rename 在这里会静默覆盖=数据丢失）。
    expect(await readFile(liveFile, "utf8")).toContain("活区的新会话，绝不能被覆盖");
    // .trash 原样（拒答零痕迹）。
    expect(await readFile(trashFile, "utf8")).toContain("回收站里的旧版");
  });

  it("not-found：.trash 无此 id → 拒；零盘触碰（活区/回收区都不动，.trash 都不建）", async () => {
    await seed("sess-keep");
    const r = await restoreSessionFile(sessionsDir(), "no-such-sess");
    expect(r).toEqual({ restored: false, reason: "not-found" });
    expect(await readdir(sessionsDir())).toEqual(["sess-keep.jsonl"]); // 活区原地、无新路径
  });

  it("invalid-id：空 / 穿越形 / side- 前缀全拒，不建任何路径", async () => {
    await seed("sess-keep");
    for (const bad of ["", "../evil", "a/b", "side-x", "side-sess-1", "..", "."]) {
      const r = await restoreSessionFile(sessionsDir(), bad);
      expect(r, `id=${JSON.stringify(bad)}`).toEqual({ restored: false, reason: "invalid-id" });
    }
    // 形状门前置：.trash 都不会被碰（这里根本没建过）。
    await expect(readFile(join(sessionsDir(), ".trash"), { encoding: "utf8" })).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(sessionsDir())).includes("sess-keep.jsonl")).toBe(true);
  });
});

describe("ω99-283 listTrashedSessions — 回收站列表", () => {
  it("多条按 mtime 降序、firstUser 折叠同款（截 50）", async () => {
    const long = "长".repeat(80);
    await seedTrash("t-old", [{ role: "user", content: "旧会话" }]);
    await seedTrash("t-new", [{ role: "user", content: long }]);
    // mtime 拉开：t-new 晚 2s。
    const { utimes } = await import("node:fs/promises");
    const now = Date.now() / 1000;
    await utimes(join(sessionsDir(), ".trash", "t-old.jsonl"), now - 100, now - 100);
    await utimes(join(sessionsDir(), ".trash", "t-new.jsonl"), now, now);
    const rows = await listTrashedSessions(sessionsDir());
    expect(rows.map((r) => r.id)).toEqual(["t-new", "t-old"]); // 降序
    expect(rows[0]!.firstUser).toBe(`${"长".repeat(50)}…`); // 折叠截 50（同 SessionRow 语义）
    expect(rows[1]!.firstUser).toBe("旧会话");
  });

  it("前 20 帽：21 条只回最新 20", async () => {
    const { utimes } = await import("node:fs/promises");
    const base = Date.now() / 1000;
    for (let i = 0; i < 21; i++) {
      await seedTrash(`t-cap-${String(i).padStart(2, "0")}`, [{ role: "user", content: `第${i}条` }]);
      await utimes(join(sessionsDir(), ".trash", `t-cap-${String(i).padStart(2, "0")}.jsonl`), base + i, base + i);
    }
    const rows = await listTrashedSessions(sessionsDir());
    expect(rows).toHaveLength(20);
    expect(rows[0]!.id).toBe("t-cap-20"); // 最新在前
    expect(rows.map((r) => r.id)).not.toContain("t-cap-00"); // 最旧被帽掉
  });

  it("无 .trash → []（不建目录）", async () => {
    await mkdir(sessionsDir(), { recursive: true });
    expect(await listTrashedSessions(sessionsDir())).toEqual([]);
    await expect(readFile(join(sessionsDir(), ".trash"), { encoding: "utf8" })).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("空 .trash（目录在无文件）→ []", async () => {
    await mkdir(join(sessionsDir(), ".trash"), { recursive: true });
    expect(await listTrashedSessions(sessionsDir())).toEqual([]);
  });
});
