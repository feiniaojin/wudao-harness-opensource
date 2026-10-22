// ω99-314: #R — 文件级时光机 driver 面：settle 索引 + fileRevert 四守卫。
// 钉：
//   落盘   write_file 改既有文件 → JSONL 泛型车道多出 file_snapshot 条目
//          （{turn,run,path,beforeSha,afterSha} 恰形）；changes 行带 beforeSha；
//          before blob 真在仓；M24：泛型条目不进 load() 消息视图。
//   守卫1  活跃回合 409：run 进行中 fileRevert → {ok:false,reason:"busy"}。
//   守卫2  pre-restore 快照：恢复前旧内容再落一份——恢复本身可撤销（用第
//          二次 fileRevert 恢复「恢复前」的内容，超越点①直证）。
//   守卫3  哈希核验：快照后手改过 → 不拒，{ok:true,stale:true}，回执明示。
//   守卫4  blob 缺席（淘汰/删仓）→ {ok:false,reason:"evicted"}「快照已被清理」。
//   边界   路径逃逸 bad-path；无 snapshots 接线 → typed 拒（缺席=旧行为）。
//   回放   resume 后 file_snapshot 条目重建目录（stale 判据来自重建的 afterSha）。
// 夹具全在 os.tmpdir()（217 式样）；绝不触碰用户文件。
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, realpath, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  createScriptedModel,
  createTurnDiffTracker,
  createWriteFileTool,
  createJsonlSessionStore,
} from "@wudao/core";
import type { ModelClient, SessionEntry, AgentMessage } from "@wudao/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import { createSnapshotStore, sha256Hex } from "../src/snapshots.js";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

interface NoticeEntry {
  kind: "notice";
  text: string;
  changes?: readonly { path: string; op: "created" | "modified"; writes: number; beforeSha?: string }[];
}
const notices = (d: ReturnType<typeof createAgentDriver>): NoticeEntry[] =>
  d.getHistory().filter((e): e is NoticeEntry => e.kind === "notice");

/** 永不决议的模型——把 run 钉在 busy（守卫 1 的夹具）。 */
function neverResolvingModel(): ModelClient {
  return { generate: () => new Promise<never>(() => {}) };
}

/** 一个改动既有文件的 run（write_file 覆写 a.ts）。 */
function editRunDriver(ws: string, snapshots?: ReturnType<typeof createSnapshotStore>) {
  const t = createTurnDiffTracker();
  const store = snapshots ?? createSnapshotStore(ws);
  const driver = createAgentDriver({
    model: createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "write_file", arguments: { path: "a.ts", content: "AFTER-EDIT\n" } }] },
      { role: "assistant", content: "done" },
    ]),
    tools: [createWriteFileTool({ workspaceRoot: ws, turnDiff: t })],
    systemPrompt: "s",
    summarize: summarizeToolCall,
    workspaceRoot: ws,
    turnDiff: t,
    snapshots: store,
    onPermissionAsk: async () => ({ kind: "allow" as const }),
  });
  return { driver, store };
}

describe("ω99-314 落盘 — settle 索引随 217 收据批进泛型车道", () => {
  it("write_file 改既有文件 → file_snapshot 条目 + changes 行带 beforeSha + blob 在仓；泛型不进消息视图", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "tm314-a-")));
    try {
      await writeFile(join(ws, "a.ts"), "BEFORE-EDIT\n", "utf8");
      const { driver, store } = editRunDriver(ws);
      const sid = driver.getSessionId();
      driver.submit("edit it");
      await until(() => driver.getStatus().busy === false && notices(driver).some((n) => /^耗时 /.test(n.text)), "run settled");
      await wait(60); // fire-and-forget 持久化 flush
      // changes 行带 beforeSha（面板「恢复到这里」的数据源；288 计数同形在场）
      const td = notices(driver).find((n) => n.changes !== undefined && n.changes.length > 0);
      expect(td).toBeDefined();
      expect(td!.changes).toEqual([{ path: "a.ts", op: "modified", writes: 1, plus: 1, minus: 1, beforeSha: sha("BEFORE-EDIT\n") }]);
      // JSONL 泛型车道：file_snapshot 恰形
      const jsonl = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
      const entries = await jsonl.loadSessionEntries(sid);
      const snaps = entries.filter((e) => "type" in e && e.type === "file_snapshot");
      expect(snaps).toEqual([
        { type: "file_snapshot", data: { turn: 1, run: sid, path: "a.ts", beforeSha: sha("BEFORE-EDIT\n"), afterSha: sha("AFTER-EDIT\n") } },
      ]);
      // before blob 真在仓、可读回
      expect(await store.readBlob(sha("BEFORE-EDIT\n"))).toBe("BEFORE-EDIT\n");
      // M24：泛型条目不进 load() 消息视图
      const msgs = await jsonl.load(sid);
      expect(JSON.stringify(msgs)).not.toContain("file_snapshot");
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("新建文件的行不带 beforeSha、零 file_snapshot 条目（无旧可快照——诚实边界）", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "tm314-b-")));
    try {
      const { driver } = editRunDriver(ws);
      const sid = driver.getSessionId();
      driver.submit("edit it");
      await until(() => driver.getStatus().busy === false && notices(driver).some((n) => /^耗时 /.test(n.text)), "run settled");
      await wait(60);
      const td = notices(driver).find((n) => n.changes !== undefined && n.changes.length > 0);
      expect(td!.changes).toEqual([{ path: "a.ts", op: "created", writes: 1, plus: 1, minus: 0 }]); // 无 beforeSha
      const entries = await createJsonlSessionStore(join(ws, ".wudao", "sessions")).loadSessionEntries(sid);
      expect(entries.filter((e) => "type" in e && e.type === "file_snapshot")).toHaveLength(0);
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("无 snapshots 接线 → 零条目零 beforeSha（缺席=旧行为边界）+ fileRevert typed 拒", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "tm314-c-")));
    try {
      await writeFile(join(ws, "a.ts"), "BEFORE\n", "utf8");
      const t = createTurnDiffTracker();
      const driver = createAgentDriver({
        model: createScriptedModel([
          { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "write_file", arguments: { path: "a.ts", content: "AFTER\n" } }] },
          { role: "assistant", content: "done" },
        ]),
        tools: [createWriteFileTool({ workspaceRoot: ws, turnDiff: t })],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        workspaceRoot: ws,
        turnDiff: t,
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
      driver.submit("go");
      await until(() => driver.getStatus().busy === false, "settled");
      await wait(50);
      const td = notices(driver).find((n) => n.changes !== undefined && n.changes.length > 0);
      expect(td!.changes![0]).not.toHaveProperty("beforeSha");
      const r = await driver.fileRevert("a.ts", sha("BEFORE\n"));
      expect(r).toMatchObject({ ok: false });
      expect((r as { reason: string }).reason).toBe("no-store");
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("ω99-314 fileRevert — 四守卫", () => {
  it("守卫 1：run 进行中 → busy 拒（活跃回合 409，286 判据）", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "tm314-d-")));
    try {
      await writeFile(join(ws, "a.ts"), "OLD\n", "utf8");
      const store = createSnapshotStore(ws);
      const driver = createAgentDriver({
        model: neverResolvingModel(),
        tools: [],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        workspaceRoot: ws,
        snapshots: store,
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
      driver.submit("hold");
      await until(() => driver.getStatus().busy === true, "run in flight");
      const r = await driver.fileRevert("a.ts", sha("OLD\n"));
      expect(r).toMatchObject({ ok: false, reason: "busy" });
      expect((r as { message: string }).message).toContain("等它停下来");
      // 永不决议的模型让 run 悬着——断言已拿到，直接拆驱动（孤儿 promise
      // 由测试进程回收；绝不等待它 settle）。
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("恢复到快照 + 守卫 2 pre-restore 快照（恢复本身可撤销——超越点①）+ 守卫 4 typed 拒", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "tm314-e-")));
    try {
      await writeFile(join(ws, "a.ts"), "BEFORE-EDIT\n", "utf8");
      const { driver, store } = editRunDriver(ws);
      driver.submit("edit it");
      await until(() => driver.getStatus().busy === false && notices(driver).some((n) => /^耗时 /.test(n.text)), "settled");
      await wait(60);
      // 盘上现状 = AFTER-EDIT；恢复到 BEFORE
      expect(await readFile(join(ws, "a.ts"), "utf8")).toBe("AFTER-EDIT\n");
      const beforeSha = sha("BEFORE-EDIT\n");
      const r1 = await driver.fileRevert("a.ts", beforeSha);
      expect(r1).toEqual({ ok: true, stale: false, message: expect.stringContaining("已恢复") });
      expect(await readFile(join(ws, "a.ts"), "utf8")).toBe("BEFORE-EDIT\n");
      // 守卫 2：恢复前（AFTER-EDIT）的内容又存了一份快照——再恢复回去即「撤销恢复」
      const afterSha = sha("AFTER-EDIT\n");
      expect(await store.hasBlob(afterSha)).toBe(true);
      const r2 = await driver.fileRevert("a.ts", afterSha);
      expect(r2).toEqual({ ok: true, stale: false, message: expect.any(String) });
      expect(await readFile(join(ws, "a.ts"), "utf8")).toBe("AFTER-EDIT\n");
      // 回执 notice 落 history
      expect(notices(driver).some((n) => n.text.includes("已恢复") && n.text.includes("a.ts"))).toBe(true);
      // 守卫 4：不存在的 sha → typed 拒「快照已被清理」
      const r3 = await driver.fileRevert("a.ts", sha("never captured"));
      expect(r3).toMatchObject({ ok: false, reason: "evicted" });
      expect((r3 as { message: string }).message).toContain("快照已被清理");
      // 路径逃逸 → bad-path
      const r4 = await driver.fileRevert("../../outside.ts", beforeSha);
      expect(r4).toMatchObject({ ok: false, reason: "bad-path" });
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("守卫 3：快照之后手改过 → 不拒、stale:true、回执明示", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "tm314-f-")));
    try {
      await writeFile(join(ws, "a.ts"), "BEFORE-EDIT\n", "utf8");
      const { driver } = editRunDriver(ws);
      driver.submit("edit it");
      await until(() => driver.getStatus().busy === false, "settled");
      await wait(60);
      // 用户手改（内容 ≠ 索引里的最新 afterSha）
      await writeFile(join(ws, "a.ts"), "USER-HAND-EDIT\n", "utf8");
      const r = await driver.fileRevert("a.ts", sha("BEFORE-EDIT\n"));
      expect(r).toEqual({ ok: true, stale: true, message: expect.stringContaining("改过") });
      expect(await readFile(join(ws, "a.ts"), "utf8")).toBe("BEFORE-EDIT\n");
      // 手改的内容也留了快照（覆盖有兜底）
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("守卫 4 变体：快照被 LRU 淘汰后（blob 物理缺席）→ typed 拒，文件未被碰", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "tm314-g-")));
    try {
      await writeFile(join(ws, "a.ts"), "BEFORE-EDIT\n", "utf8");
      const { driver, store } = editRunDriver(ws);
      driver.submit("edit it");
      await until(() => driver.getStatus().busy === false, "settled");
      await wait(60);
      // 淘汰一切（帽 0）
      await store.enforceLruCap(0);
      expect(await store.hasBlob(sha("BEFORE-EDIT\n"))).toBe(false);
      const r = await driver.fileRevert("a.ts", sha("BEFORE-EDIT\n"));
      expect(r).toMatchObject({ ok: false, reason: "evicted" });
      // 文件未被碰（仍是 run 后内容）
      expect(await readFile(join(ws, "a.ts"), "utf8")).toBe("AFTER-EDIT\n");
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("ω99-314 回放 — resume 重建快照目录（守卫 3 的判据来自持久索引）", () => {
  it("resume 后手改文件 → fileRevert 报 stale（afterSha 目录从 file_snapshot 条目重建）", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "tm314-h-")));
    try {
      await writeFile(join(ws, "a.ts"), "BEFORE-EDIT\n", "utf8");
      const { driver: d1 } = editRunDriver(ws);
      const sid = d1.getSessionId();
      d1.submit("edit it");
      await until(() => d1.getStatus().busy === false && notices(d1).some((n) => /^耗时 /.test(n.text)), "settled");
      await wait(60);
      d1.dispose();
      // resume 进新 driver（同 workspace：store/blob 与 JSONL 都在盘上）
      const t2 = createTurnDiffTracker();
      const driver = createAgentDriver({
        model: createScriptedModel([{ role: "assistant", content: "r" }]),
        tools: [createWriteFileTool({ workspaceRoot: ws, turnDiff: t2 })],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        workspaceRoot: ws,
        turnDiff: t2,
        snapshots: createSnapshotStore(ws),
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
      expect(await driver.resume(sid)).toEqual({ ok: true });
      await wait(80); // boot 回放 flush
      // 手改（≠ 重建出的最新 afterSha=AFTER-EDIT）→ stale:true
      await writeFile(join(ws, "a.ts"), "POST-RESUME-EDIT\n", "utf8");
      const r = await driver.fileRevert("a.ts", sha("BEFORE-EDIT\n"));
      expect(r).toEqual({ ok: true, stale: true, message: expect.any(String) });
      expect(await readFile(join(ws, "a.ts"), "utf8")).toBe("BEFORE-EDIT\n");
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
