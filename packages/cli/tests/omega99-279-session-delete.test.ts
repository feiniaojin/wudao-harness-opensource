// ω99-279: #13 — 回收站式删除纯层（切换会话弹框的清理车道）。tmpdir 造真实
// 会话文件钉：happy path（rename 进 .trash/ + store.list() 不再含 + 原路径
// ENOENT）；not-found 收敛；invalid-id（空/../evil/side-x 形）拒且磁盘零
// 触碰；active guardIds 拒且原文件原地；.trash 预存在幂等；重复删同 id 第二
// 次 not-found（收敛钉）；side-*.jsonl 副链留在原地。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionStore } from "@wudao/core";
import { deleteSessionFile, type SessionDeleteResult } from "../src/driver/session-delete.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wudao-279-delete-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** 写一个会话 JSONL（与 277 的 seed 同款直写）。 */
async function seed(id: string, lines: readonly unknown[] = [{ role: "user", content: "正文" }]): Promise<string> {
  const sessionsDir = join(dir, ".wudao", "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const file = join(sessionsDir, `${id}.jsonl`);
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return file;
}

const sessionsDir = (): string => join(dir, ".wudao", "sessions");

describe("ω99-279 deleteSessionFile — happy path 与双隐身", () => {
  it("rename 进 .trash/<id>.jsonl（内容保真）；store.list() 不再含；原路径 ENOENT", async () => {
    const file = await seed("sess-a");
    const before = (await readdir(sessionsDir())).sort();
    expect(before).toContain("sess-a.jsonl");
    const r = await deleteSessionFile(sessionsDir(), "sess-a");
    expect(r).toEqual({ deleted: true });
    // 原路径没了。
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    // .trash 里内容保真（可恢复）。
    const trashed = await stat(join(sessionsDir(), ".trash", "sess-a.jsonl"));
    expect(trashed.isFile()).toBe(true);
    // list() 双隐身（readdir 平铺滤 .jsonl——.trash 子目录天然不可见）。
    const store = createJsonlSessionStore(sessionsDir());
    expect(await store.list()).not.toContain("sess-a");
    expect((await readdir(sessionsDir())).includes(".trash")).toBe(true);
  });

  it("搜索车道同集隐身：删除后 searchSessionFiles 也搜不到", async () => {
    await seed("sess-searchable", [{ role: "user", content: "needle-in-haystack 唯一正文" }]);
    const { searchSessionFiles } = await import("../src/driver/session-search.js");
    expect((await searchSessionFiles(sessionsDir(), "needle-in-haystack", {})).length).toBeGreaterThan(0);
    await deleteSessionFile(sessionsDir(), "sess-searchable");
    expect(await searchSessionFiles(sessionsDir(), "needle-in-haystack", {})).toEqual([]);
  });

  it("side-*.jsonl 副链留在原地不动（对 list() 本就隐形，删父会话不碰它）", async () => {
    await seed("sess-parent");
    const sideFile = join(sessionsDir(), "side-sess-parent-1.jsonl");
    await writeFile(sideFile, JSON.stringify({ role: "assistant", content: "side" }) + "\n", "utf8");
    await deleteSessionFile(sessionsDir(), "sess-parent");
    const side = await stat(sideFile); // 不抛 = 还在原地
    expect(side.isFile()).toBe(true);
    await expect(stat(join(sessionsDir(), ".trash", "side-sess-parent-1.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("ω99-279 deleteSessionFile — 拒答三因", () => {
  it("not-found：不存在的 id 收敛（不抛）", async () => {
    await mkdir(sessionsDir(), { recursive: true });
    const r: SessionDeleteResult = await deleteSessionFile(sessionsDir(), "no-such-sess");
    expect(r).toEqual({ deleted: false, reason: "not-found" });
  });

  it("invalid-id：空 / 穿越形 / side- 前缀全拒，且磁盘零触碰（.trash 都不建）", async () => {
    await seed("sess-keep");
    for (const bad of ["", "../evil", "a/b", "side-x", "side-sess-1", "..", "."]) {
      const r = await deleteSessionFile(sessionsDir(), bad);
      expect(r, `id=${JSON.stringify(bad)}`).toEqual({ deleted: false, reason: "invalid-id" });
    }
    // 磁盘零触碰：.trash 目录根本没被创建，原文件原地。
    await expect(stat(join(sessionsDir(), ".trash"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(join(sessionsDir(), "sess-keep.jsonl"))).isFile()).toBe(true);
  });

  it("active：guardIds 含 id 拒且不碰磁盘（原文件原地、.trash 不建）", async () => {
    const file = await seed("sess-live");
    const r = await deleteSessionFile(sessionsDir(), "sess-live", { guardIds: ["sess-live", "pet"] });
    expect(r).toEqual({ deleted: false, reason: "active" });
    expect((await stat(file)).isFile()).toBe(true); // 原文件原地
    await expect(stat(join(sessionsDir(), ".trash"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await createJsonlSessionStore(sessionsDir()).list()).toContain("sess-live");
  });
});

describe("ω99-279 deleteSessionFile — 幂等与收敛", () => {
  it(".trash 预存在（含同名旧件）幂等：mkdir recursive 无害，rename 覆盖无妨", async () => {
    await seed("sess-b");
    await mkdir(join(sessionsDir(), ".trash"), { recursive: true });
    await writeFile(join(sessionsDir(), ".trash", "sess-b.jsonl"), "旧的回收件\n", "utf8");
    const r = await deleteSessionFile(sessionsDir(), "sess-b");
    expect(r).toEqual({ deleted: true });
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(sessionsDir(), ".trash", "sess-b.jsonl"), "utf8")).toContain("正文"); // 新内容覆盖旧件
  });

  it("重复删同 id：第一次 deleted:true，第二次 not-found（mid-flap 重放收敛钉）", async () => {
    await seed("sess-once");
    expect(await deleteSessionFile(sessionsDir(), "sess-once")).toEqual({ deleted: true });
    expect(await deleteSessionFile(sessionsDir(), "sess-once")).toEqual({ deleted: false, reason: "not-found" });
  });

  it("缺 sessions 目录（无 workspace 车道的形）：not-found，不抛不建", async () => {
    const r = await deleteSessionFile(join(dir, ".wudao", "never-made"), "sess-any");
    expect(r).toEqual({ deleted: false, reason: "not-found" });
  });
});
