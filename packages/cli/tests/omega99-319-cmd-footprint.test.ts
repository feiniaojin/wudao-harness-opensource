// ω99-319: #1 — cmd-footprint 纯层 + observer。先红后绿（模块缺位如实分类）。
// 钉（brief §5.1/§5.2）：
//   纯层   diffFingerprints 三态各钉（modified/created/deleted）+ 同指纹不报
//          + 忽略集钉（node_modules/.git/.wudao/dist/build/target/.DS_Store 下的
//          变更不报——.wudao 是正确性关键：快照仓自身写入不得污染下一次 diff）
//          + 扫描异常 → null（fail-open，绝不抛）。
//   obs    shell 前后配对扫描调用序；非 shell 工具零扫描；pre 扫描失败 → post
//          跳过且不抛；post 扫描失败 → 零 emit 不抛；两条连续命令足迹不串扰
//          （归因窗口=各自配对）；命令 200 字符帽（超长截断加 …）；after 内容
//          落仓（ensureBlob 播种——下一次可回退）；每文件读帽（超帽跳过内容只
//          留路径行）；deleted 无 after 可落；基础 hooks 决定原样透传。
// 夹具全在 os.tmpdir()（217 式样）；红线：绝不删用户文件、绝不阻断执行。
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentHooks } from "@wudao/core";
import {
  scanFingerprints,
  diffFingerprints,
  withCommandFootprint,
  capCommandText,
  CMD_FOOTPRINT_COMMAND_CAP_CHARS,
  type CommandFootprint,
  type FingerprintTable,
} from "../src/cmd-footprint.js";
import { createSnapshotStore, sha256Hex } from "../src/snapshots.js";

const fp = (mtimeMs: number, size: number): { mtimeMs: number; size: number } => ({ mtimeMs, size });

describe("ω99-319 纯层 — scanFingerprints / diffFingerprints", () => {
  it("忽略集：node_modules/.git/.wudao/dist/build/target/.DS_Store 下的一切不可见；常规文件可见", async () => {
    const ws = await mkdtemp(join(tmpdir(), "fp319-ign-"));
    try {
      await mkdir(join(ws, "node_modules", "pkg"), { recursive: true });
      await mkdir(join(ws, ".git"), { recursive: true });
      await mkdir(join(ws, ".wudao", "snapshots", "ab"), { recursive: true });
      await mkdir(join(ws, "dist"), { recursive: true });
      await mkdir(join(ws, "build"), { recursive: true });
      await mkdir(join(ws, "target"), { recursive: true });
      await mkdir(join(ws, "src", "nested"), { recursive: true });
      await writeFile(join(ws, "node_modules", "pkg", "x.js"), "x");
      await writeFile(join(ws, ".git", "config"), "x");
      await writeFile(join(ws, ".wudao", "snapshots", "ab", "cd"), "x");
      await writeFile(join(ws, "dist", "out.js"), "x");
      await writeFile(join(ws, "build", "o.js"), "x");
      await writeFile(join(ws, "target", "t"), "x");
      await writeFile(join(ws, ".DS_Store"), "x");
      await writeFile(join(ws, "src", "nested", "deep.ts"), "x");
      await writeFile(join(ws, "root.ts"), "x");
      const scan = await scanFingerprints(ws);
      expect(scan).not.toBeNull();
      expect([...scan!.keys()].sort()).toEqual(["root.ts", "src/nested/deep.ts"]); // posix 分隔
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("扫描异常 → null（fail-open，绝不抛）", async () => {
    await expect(scanFingerprints(join(tmpdir(), "fp319-definitely-missing-9f3a"))).resolves.toBeNull();
  });

  it("diffFingerprints 三态：mtimeMs 或 size 变=modified；新增=created；消失=deleted；同指纹不报；输出有序", () => {
    const before = new Map<string, { mtimeMs: number; size: number }>([
      ["a.ts", fp(1, 10)],
      ["b.ts", fp(2, 20)],
      ["c.ts", fp(3, 30)],
      ["d.ts", fp(4, 40)],
    ]);
    const after = new Map<string, { mtimeMs: number; size: number }>([
      ["a.ts", fp(11, 10)], // mtimeMs 变（同 size）→ modified
      ["b.ts", fp(2, 20)], // 完全同指纹 → 不报
      ["d.ts", fp(4, 44)], // size 变（mtime 同）→ modified
      ["e.ts", fp(5, 50)], // 新增 → created
    ]);
    const diff = diffFingerprints(before, after);
    expect(diff).toEqual({ modified: ["a.ts", "d.ts"], created: ["e.ts"], deleted: ["c.ts"] });
    // 同表 → 零足迹
    expect(diffFingerprints(before, before)).toEqual({ modified: [], created: [], deleted: [] });
  });
});

// ---------------------------------------------------------------------------
// observer（注入 scan 的确定性夹具 + 真文件系统的播种夹具）
// ---------------------------------------------------------------------------

/** 按序出牌的注入 scan（null = 模拟失败）。 */
const scriptedScan = (tables: (FingerprintTable | null)[]) => {
  const calls: string[] = [];
  let i = 0;
  const fn = async (root: string): Promise<FingerprintTable | null> => {
    calls.push(root);
    const t = tables[i];
    i += 1;
    return t ?? null;
  };
  return { fn, calls };
};

const table = (rows: readonly [string, number, number][]): FingerprintTable => {
  const m = new Map<string, { mtimeMs: number; size: number }>();
  for (const [p, mt, sz] of rows) m.set(p, fp(mt, sz));
  return m;
};

const baseHooks = (): AgentHooks => ({
  onPreToolUse: async () => ({ block: true, reason: "base says no" }),
  onPostToolUse: async () => "base-rewritten",
});

describe("ω99-319 observer — withCommandFootprint", () => {
  it("shell 前后配对：每条命令恰好两次扫描、pre→post 交替；足迹=窗口内 diff", async () => {
    const s = scriptedScan([
      table([["f1", 1, 10]]), // A pre
      table([["f1", 2, 12]]), // A post（f1 modified）
    ]);
    const emitted: CommandFootprint[] = [];
    const hooks = withCommandFootprint(baseHooks(), {
      liveRoot: () => "/ws",
      emit: (f) => emitted.push(f),
      scan: s.fn,
    });
    await hooks.onPreToolUse!("shell", { command: "cmd A" });
    await hooks.onPostToolUse!("shell", { command: "cmd A" }, "out");
    expect(s.calls).toEqual(["/ws", "/ws"]); // 恰两次，同根
    expect(emitted).toEqual([
      { command: "cmd A", files: [{ path: "f1", kind: "modified", afterSha: undefined }] },
    ]);
  });

  it("非 shell 工具零扫描（write_file 前后都不碰）", async () => {
    const s = scriptedScan([]);
    const hooks = withCommandFootprint(baseHooks(), { liveRoot: () => "/ws", emit: () => {}, scan: s.fn });
    await hooks.onPreToolUse!("write_file", { path: "a.ts", content: "x" });
    await hooks.onPostToolUse!("write_file", { path: "a.ts", content: "x" }, "ok");
    expect(s.calls).toHaveLength(0);
  });

  it("pre 扫描失败（null）→ post 跳过、零 emit、不抛", async () => {
    const s = scriptedScan([null, table([])]);
    const emitted: CommandFootprint[] = [];
    const hooks = withCommandFootprint(undefined, {
      liveRoot: () => "/ws",
      emit: (f) => emitted.push(f),
      scan: s.fn,
    });
    await expect(hooks!.onPreToolUse!("shell", { command: "x" })).resolves.toBeUndefined();
    await expect(hooks!.onPostToolUse!("shell", { command: "x" }, "out")).resolves.toBeUndefined();
    expect(emitted).toHaveLength(0);
    expect(s.calls).toHaveLength(1); // post 不再扫
  });

  it("post 扫描失败（null）→ 零 emit、不抛", async () => {
    const s = scriptedScan([table([["f", 1, 1]]), null]);
    const emitted: CommandFootprint[] = [];
    const hooks = withCommandFootprint(undefined, {
      liveRoot: () => "/ws",
      emit: (f) => emitted.push(f),
      scan: s.fn,
    });
    await hooks!.onPreToolUse!("shell", { command: "x" });
    await hooks!.onPostToolUse!("shell", { command: "x" }, "out");
    expect(emitted).toHaveLength(0);
  });

  it("两条连续命令不串扰：乙的 pre 承接甲的 post 之后的世界——各自配对窗口归因", async () => {
    const s = scriptedScan([
      table([["f1", 1, 10]]), // A pre：f1 在
      table([["f1", 2, 10], ["f2", 1, 5]]), // A post：f1 改了、f2 出现
      table([["f1", 2, 10], ["f2", 1, 5]]), // B pre：与 A post 同（无间隔变更）
      table([["f2", 3, 7]]), // B post：f2 又改、f1 消失
    ]);
    const emitted: CommandFootprint[] = [];
    const hooks = withCommandFootprint(undefined, {
      liveRoot: () => "/ws",
      emit: (f) => emitted.push(f),
      scan: s.fn,
    });
    await hooks!.onPreToolUse!("shell", { command: "A" });
    await hooks!.onPostToolUse!("shell", { command: "A" }, "o");
    await hooks!.onPreToolUse!("shell", { command: "B" });
    await hooks!.onPostToolUse!("shell", { command: "B" }, "o");
    expect(emitted.map((e) => e.command)).toEqual(["A", "B"]);
    // A 窗口：f1 modified + f2 created；B 窗口：f1 deleted + f2 modified（不重复归因 A 的变更）
    expect(emitted[0]!.files.map((f) => `${f.path}:${f.kind}`).sort()).toEqual(["f1:modified", "f2:created"]);
    expect(emitted[1]!.files.map((f) => `${f.path}:${f.kind}`).sort()).toEqual(["f1:deleted", "f2:modified"]);
  });

  it("命令 200 字符帽：超长截断加 …；恰 200 不截", () => {
    expect(CMD_FOOTPRINT_COMMAND_CAP_CHARS).toBe(200);
    const long = "x".repeat(250);
    expect(capCommandText(long)).toBe("x".repeat(200) + "…");
    expect(capCommandText("y".repeat(200))).toBe("y".repeat(200));
    expect(capCommandText("short")).toBe("short");
  });

  it("observer 的命令帽也钉在足迹上", async () => {
    const s = scriptedScan([table([["f", 1, 1]]), table([["f", 2, 1]])]);
    const emitted: CommandFootprint[] = [];
    const hooks = withCommandFootprint(undefined, {
      liveRoot: () => "/ws",
      emit: (f) => emitted.push(f),
      scan: s.fn,
    });
    const cmd = "z".repeat(250);
    await hooks!.onPreToolUse!("shell", { command: cmd });
    await hooks!.onPostToolUse!("shell", { command: cmd }, "o");
    expect(emitted[0]!.command).toHaveLength(201);
    expect(emitted[0]!.command.endsWith("…")).toBe(true);
  });

  it("基础 hooks 决定原样透传：pre 的 block 与 post 的改写都保留", async () => {
    const s = scriptedScan([null]);
    const hooks = withCommandFootprint(baseHooks(), { liveRoot: () => "/ws", emit: () => {}, scan: s.fn });
    const pre = await hooks.onPreToolUse!("shell", { command: "x" });
    expect(pre).toEqual({ block: true, reason: "base says no" });
    const post = await hooks.onPostToolUse!("shell", { command: "x" }, "raw");
    expect(post).toBe("base-rewritten");
    // 非 shell 也透传
    const preW = await hooks.onPreToolUse!("write_file", { path: "a" });
    expect(preW).toEqual({ block: true, reason: "base says no" });
    expect(await hooks.onPostToolUse!("write_file", { path: "a" }, "raw")).toBe("base-rewritten");
  });

  it("真文件系统：after 内容落仓播种（ensureBlob）+ afterSha 指针 + .wudao 自身不污染", async () => {
    const ws = await mkdtemp(join(tmpdir(), "fp319-seed-"));
    try {
      const store = createSnapshotStore(ws);
      await writeFile(join(ws, "a.ts"), "v1\n", "utf8");
      const hooks = withCommandFootprint(undefined, { liveRoot: () => ws, emit: () => {}, store });
      // pre：v1 世界
      await hooks!.onPreToolUse!("shell", { command: "echo v22 > a.ts" });
      await writeFile(join(ws, "a.ts"), "v22\n", "utf8"); // 命令的效果（测试直接落盘；size 3→4 确定性 modified）
      await hooks!.onPostToolUse!("shell", { command: "echo v22 > a.ts" }, "");
      // 播种断言：v22 内容在仓、afterSha 可读回（下一次改动可回退的超越点②数据面）
      const sha = sha256Hex("v22\n");
      expect(await store.hasBlob(sha)).toBe(true);
      expect(await store.readBlob(sha)).toBe("v22\n");
      // 再走一条不改文件的命令：零足迹（.wudao/snapshots 的仓写入不产生假 diff，
      // 空足迹不 emit——JSONL 噪声纪律）
      const emitted: CommandFootprint[] = [];
      const hooks2 = withCommandFootprint(undefined, { liveRoot: () => ws, emit: (f) => emitted.push(f) });
      await hooks2!.onPreToolUse!("shell", { command: "true" });
      await store.ensureBlob("another-blob-content"); // 仓自身写入（.wudao 下）
      await hooks2!.onPostToolUse!("shell", { command: "true" }, "");
      expect(emitted).toHaveLength(0);
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("每文件读帽：超帽文件跳过内容（无 afterSha，只留路径行）；deleted 无 after 可落", async () => {
    const ws = await mkdtemp(join(tmpdir(), "fp319-cap-"));
    try {
      const store = createSnapshotStore(ws);
      await writeFile(join(ws, "big.txt"), "0123456789", "utf8"); // 10 字节 > 帽 5
      await writeFile(join(ws, "gone.txt"), "bye", "utf8");
      const emitted: CommandFootprint[] = [];
      const hooks = withCommandFootprint(undefined, {
        liveRoot: () => ws,
        emit: (f) => emitted.push(f),
        maxFileBytes: 5,
      });
      await hooks!.onPreToolUse!("shell", { command: "shrink" });
      await writeFile(join(ws, "big.txt"), "987654", "utf8"); // 6 字节仍超帽；size 变（10→6）= 确定性 modified
      await rm(join(ws, "gone.txt"));
      await hooks!.onPostToolUse!("shell", { command: "shrink" }, "");
      const byPath = new Map(emitted[0]!.files.map((f) => [f.path, f]));
      expect(byPath.get("big.txt")).toEqual({ path: "big.txt", kind: "modified", afterSha: undefined }); // 超帽：无内容指针
      expect(byPath.get("gone.txt")).toEqual({ path: "gone.txt", kind: "deleted", afterSha: undefined });
      expect(await store.hasBlob(sha256Hex("987654"))).toBe(false); // 没读内容
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
