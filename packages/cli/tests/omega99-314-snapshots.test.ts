// ω99-314: #R — 快照仓纯层（文件级时光机的 content-addressed 仓）。钉：
//   去重   同内容一份（路径 <root>/.wudao/snapshots/<sha 前 2 字>/<sha>，全 64
//          位 sha256）；不同内容两份；ensureBlob 幂等。
//   捕获   capturePreWrite：文件在 → blob+sha；文件不在 → null（新建无需快照）；
//          路径逃逸 → null fail-open + warn；读失败 fail-open 不抛。
//   LRU    超帽按 atime 最旧淘汰；★红线：只删 .wudao/snapshots/ 内 blob，
//          工作区用户文件一字节不动（夹具里放一个「诱饵」用户文件钉死）。
//   读取   readBlob：在 → 内容；缺席（被淘汰/删仓）→ null（typed 拒的数据面）。
//   索引   snapshotIndexFromEntries 严格验证（畸形弃条不崩、文件序保持）；
//          latestAfterShaByPath 文件序 last-wins。
// 夹具全在 os.tmpdir()（217 式样）；绝不含工作区真实文件。
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, stat, readdir, utimes, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  createSnapshotStore,
  sha256Hex,
  snapshotIndexFromEntries,
  latestAfterShaByPath,
  withSnapshotCapture,
} from "../src/snapshots.js";
import type { AgentHooks, SessionEntry } from "@wudao/core";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

async function storeStats(dir: string): Promise<{ files: string[]; bytes: number }> {
  const out: string[] = [];
  let bytes = 0;
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        out.push(p);
        bytes += (await stat(p)).size;
      }
    }
  };
  await walk(dir);
  return { files: out, bytes };
}

describe("ω99-314 快照仓 — content-addressed 去重", () => {
  it("ensureBlob: 同内容一份、幂等；路径形 <snapshots>/<sha 前 2 字>/<sha>", async () => {
    const ws = await mkdtemp(join(tmpdir(), "snap314-a-"));
    try {
      const store = createSnapshotStore(ws);
      const s1 = await store.ensureBlob("hello world\n");
      expect(s1).toBe(sha("hello world\n"));
      await store.ensureBlob("hello world\n"); // dedup no-op
      await store.ensureBlob("hello world\n"); // idempotent
      const st = await storeStats(join(ws, ".wudao", "snapshots"));
      expect(st.files).toHaveLength(1);
      expect(st.files[0]).toBe(join(ws, ".wudao", "snapshots", s1.slice(0, 2), s1));
      // 不同内容另一份
      const s2 = await store.ensureBlob("other content");
      expect(await storeStats(join(ws, ".wudao", "snapshots"))).toMatchObject({ files: expect.arrayContaining([st.files[0]!, join(ws, ".wudao", "snapshots", s2.slice(0, 2), s2)]) });
      expect((await storeStats(join(ws, ".wudao", "snapshots"))).files).toHaveLength(2);
      // 读回逐字节
      expect(await store.readBlob(s1)).toBe("hello world\n");
      expect(await store.readBlob(s2)).toBe("other content");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("capturePreWrite: 文件在 → sha+blob；不在 → null；触发面外工具名 → null 零触碰", async () => {
    const ws = await mkdtemp(join(tmpdir(), "snap314-b-"));
    try {
      await writeFile(join(ws, "a.ts"), "before-bytes\n", "utf8");
      const store = createSnapshotStore(ws);
      const got = await store.capturePreWrite("make_xlsx", "a.ts");
      expect(got).toBe(sha("before-bytes\n"));
      expect(await store.readBlob(got!)).toBe("before-bytes\n");
      // 新建（文件不在）→ null，不写任何 blob
      expect(await store.capturePreWrite("append_docx", "missing.ts")).toBeNull();
      expect((await storeStats(join(ws, ".wudao", "snapshots"))).files).toHaveLength(1);
      // 路径逃逸 → null（fail-open，不抛）
      expect(await store.capturePreWrite("make_docx", "../../etc/passwd")).toBeNull();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("捕获失败 fail-open：warn 记一次、绝不抛（快照是尽力而为）", async () => {
    const ws = await mkdtemp(join(tmpdir(), "snap314-c-"));
    try {
      await writeFile(join(ws, "a.ts"), "x", "utf8");
      const warns: string[] = [];
      // 把仓的父目录占成一个文件 → mkdir 失败 → 写 blob 失败路径
      await writeFile(join(ws, ".wudao"), "not a dir", "utf8");
      const store = createSnapshotStore(ws, { warn: (l) => warns.push(l) });
      await expect(store.capturePreWrite("make_xlsx", "a.ts")).resolves.toBeNull();
      expect(warns.length).toBeGreaterThanOrEqual(1);
      expect(warns[0]).toContain("snapshot");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("ω99-314 快照仓 — LRU 淘汰红线", () => {
  it("超帽按 atime 最旧淘汰；只删仓内 blob，用户文件一字节不动", async () => {
    const ws = await mkdtemp(join(tmpdir(), "snap314-d-"));
    try {
      const store = createSnapshotStore(ws);
      const old = await store.ensureBlob("oldest\n");
      const mid = await store.ensureBlob("middle\n");
      const newest = await store.ensureBlob("newest\n");
      expect(old).toBeDefined();
      // atime 分层：old 最旧，newest 最新（注入显式 atime——测试确定性）
      const t0 = new Date(Date.now() - 30_000);
      const t1 = new Date(Date.now() - 20_000);
      const t2 = new Date(Date.now() - 10_000);
      await utimes(join(ws, ".wudao", "snapshots", old!.slice(0, 2), old!), t0, t0);
      await utimes(join(ws, ".wudao", "snapshots", mid!.slice(0, 2), mid!), t1, t1);
      await utimes(join(ws, ".wudao", "snapshots", newest!.slice(0, 2), newest!), t2, t2);
      // ★诱饵：工作区里的用户文件（名字像快照、内容是用户的）——淘汰绝不动它
      const decoy = join(ws, "user-file.ts");
      await writeFile(decoy, "USER DATA — must survive\n", "utf8");
      const totalNow = (await storeStats(join(ws, ".wudao", "snapshots"))).bytes;
      // 帽 = total - 1 字节 → 必须淘汰至少一个（最旧的 old）
      const r = await store.enforceLruCap(totalNow - 1);
      expect(r.evicted).toBe(1);
      expect(await store.readBlob(old!)).toBeNull(); // 最旧被淘汰
      expect(await store.readBlob(mid!)).toBe("middle\n");
      expect(await store.readBlob(newest!)).toBe("newest\n");
      // ★红线：诱饵完好
      expect(await readFile(decoy, "utf8")).toBe("USER DATA — must survive\n");
      // 仓内 blob 数 = 2
      expect((await storeStats(join(ws, ".wudao", "snapshots"))).files).toHaveLength(2);
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("帽内零淘汰；缺席 readBlob → null（淘汰后的诚实读）", async () => {
    const ws = await mkdtemp(join(tmpdir(), "snap314-e-"));
    try {
      const store = createSnapshotStore(ws);
      const s = await store.ensureBlob("tiny\n");
      expect((await store.enforceLruCap(1024 * 1024)).evicted).toBe(0);
      expect(await store.readBlob(s)).toBe("tiny\n");
      expect(await store.readBlob(sha("never stored"))).toBeNull();
      expect(await store.hasBlob(s)).toBe(true);
      expect(await store.hasBlob(sha("never stored"))).toBe(false);
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("ω99-314 索引读侧 — snapshotIndexFromEntries（217 读侧纪律）", () => {
  const row = (path: string, beforeSha: string, afterSha?: string, turn = 1, run = "s1") =>
    ({ type: "file_snapshot", data: { turn, run, path, beforeSha, ...(afterSha !== undefined ? { afterSha } : {}) } }) as SessionEntry;

  it("严格验证：好条目按文件序过境；畸形条目弃掉不崩；未知附加字段忽略", () => {
    const good1 = row("a.ts", sha("A"), sha("B"), 1);
    const good2 = row("a.ts", sha("B"), sha("C"), 2);
    const entries: SessionEntry[] = [
      { role: "user", content: "hi" },
      good1,
      { type: "file_snapshot", data: "not an object" } as unknown as SessionEntry,
      { type: "file_snapshot", data: {} }, // missing fields
      { type: "file_snapshot", data: { turn: 1, run: "s", path: "x", beforeSha: "nothex" } }, // bad sha
      { type: "file_snapshot", data: { turn: 0, run: "s", path: "x", beforeSha: sha("z") } }, // bad turn
      { type: "file_snapshot", data: { turn: 1, run: "", path: "x", beforeSha: sha("z") } }, // empty run
      { type: "file_snapshot", data: { turn: 1, run: "s", path: "", beforeSha: sha("z") } }, // empty path
      { type: "file_snapshot", data: { turn: 1, run: "s", path: "x", beforeSha: sha("z"), afterSha: 7 } }, // bad afterSha
      good2,
      { type: "turn_diff_receipt", data: { text: "t" } }, // 他类泛型条目零贡献
    ];
    const out = snapshotIndexFromEntries(entries);
    expect(out).toEqual([
      { turn: 1, run: "s1", path: "a.ts", beforeSha: sha("A"), afterSha: sha("B") },
      { turn: 2, run: "s1", path: "a.ts", beforeSha: sha("B"), afterSha: sha("C") },
    ]);
  });

  it("latestAfterShaByPath：文件序 last-wins；无 afterSha 的行不更新", () => {
    const rows = snapshotIndexFromEntries([
      { type: "file_snapshot", data: { turn: 1, run: "s", path: "a.ts", beforeSha: sha("1"), afterSha: sha("2") } },
      { type: "file_snapshot", data: { turn: 2, run: "s", path: "a.ts", beforeSha: sha("9") } }, // no afterSha
      { type: "file_snapshot", data: { turn: 3, run: "s", path: "b.md", beforeSha: sha("3") } },
    ] as readonly SessionEntry[]);
    expect(latestAfterShaByPath(rows)).toEqual(new Map([["a.ts", sha("2")]]));
  });

  it("老会话（无 file_snapshot 条目）→ 零行零崩", () => {
    expect(snapshotIndexFromEntries([{ role: "user", content: "hi" }])).toEqual([]);
    expect(snapshotIndexFromEntries([])).toEqual([]);
  });
});

describe("ω99-314 sha256Hex — 全 64 位十六进制（区别于 read-state 的 16 位截断哈希）", () => {
  it("produces the full 64-char lowercase hex digest", () => {
    expect(sha256Hex("hello world\n")).toBe(sha("hello world\n"));
    expect(sha256Hex("hello world\n")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("ω99-314 withSnapshotCapture — onPreToolUse 最外层 observer", () => {
  it("doc 写册调用先捕获（path 或 filename 双名）后委托；非触发工具零触碰；基础 hooks 决定原样透传", async () => {
    const ws = await mkdtemp(join(tmpdir(), "snap314-h-"));
    try {
      await writeFile(join(ws, "book.xlsx"), "xlsx-bytes\n", "utf8");
      await writeFile(join(ws, "doc.docx"), "docx-bytes\n", "utf8");
      const store = createSnapshotStore(ws);
      // 基础 hooks：一个会被委托到的 interceptor（返回 block 决定）。
      let baseSaw = 0;
      const base: AgentHooks = {
        onPreToolUse: async () => {
          baseSaw += 1;
          return { block: true, reason: "base says no" };
        },
      };
      const wrapped = withSnapshotCapture(base, store, () => ws);
      // ① path 参数面（append/replace/set-chrome 族）
      const d1 = await wrapped!.onPreToolUse!("append_docx", { path: "book.xlsx" });
      expect(d1).toEqual({ block: true, reason: "base says no" }); // 委托原样
      expect(await store.readBlob(sha("xlsx-bytes\n"))).toBe("xlsx-bytes\n"); // 捕获先行
      // ② filename 参数面（make 族）
      await wrapped!.onPreToolUse!("make_docx", { filename: "doc.docx" });
      expect(await store.readBlob(sha("docx-bytes\n"))).toBe("docx-bytes\n");
      // ③ 非触发工具（write_file/read_file/shell…）：零捕获、委托照常
      const before = (await store.stats()).blobs;
      await wrapped!.onPreToolUse!("write_file", { path: "book.xlsx", content: "new" });
      expect((await store.stats()).blobs).toBe(before);
      expect(baseSaw).toBe(3); // 每次都委托
      // ④ store 缺席 → hooks 原样返回（不包一层）
      expect(withSnapshotCapture(base, undefined, () => ws)).toBe(base);
      // ⑤ 无基础 hooks → 纯捕获层（不 block）
      const bare = withSnapshotCapture(undefined, store, () => ws);
      const d5 = await bare!.onPreToolUse!("replace_xlsx", { path: "book.xlsx" });
      expect(d5).toBeUndefined();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("捕获失败 fail-open：基础 hooks 决定不受影响（capture 抛被兜住）", async () => {
    const ws = await mkdtemp(join(tmpdir(), "snap314-i-"));
    try {
      const exploding = {
        ...createSnapshotStore(ws),
        capturePreWrite: async () => { throw new Error("boom"); },
      };
      const wrapped = withSnapshotCapture({ onPreToolUse: async () => undefined }, exploding, () => ws);
      await expect(wrapped!.onPreToolUse!("make_xlsx", { filename: "whatever.xlsx" })).resolves.toBeUndefined();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
