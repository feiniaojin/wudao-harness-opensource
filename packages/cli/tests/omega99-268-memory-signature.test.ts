// ω99-268: #8 — 记忆面板实时订阅 R 件（driver 面）：DriverStatus.memorySignature
// ——记忆 store 的内容签名（`count:pending:maxVersion`，store 单调量的投影）。
// 签名不是展示源（列表数据走 memoryList op 不变）——它是变化信号：跨帧比对变
// 化 → web 管理面板/待审卡重取。刷新点 = boot + run settle + 三个 memory 闭包
// 落定后（本进程写的立即反映，不等 settle）；255 的 seq 守卫 + 值不变零帧纪律
// 逐字镜像（缓存变量 + 纯变量读进 buildStatus，emit 路径绝不读盘）。全 mock
// （scripted model + gitBranchReader 注入 null——零真模型零网络零 spawn）；夹具
// 只写 mkdtemp(os.tmpdir()) 只写不删（零删除原语——memory.jsonl 是用户数据，
// 测试绝不触 ~/.wudao 或真实工作区 store）。
import { describe, it, expect, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedModel } from "@wudao/core";
import type { AgentDriver, AgentDriverOptions, DriverStatus } from "../src/driver/agent-driver.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import { openMemoryStore } from "../src/memory/store.js";
import type { MemoryEntry } from "../src/memory/store.js";
import { summarizeToolCall } from "../src/log.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const allow = vi.fn(async () => ({ kind: "allow" as const }));

function makeDriver(opts: Partial<AgentDriverOptions>): AgentDriver {
  return createAgentDriver({
    systemPrompt: "s",
    summarize: summarizeToolCall,
    // 253/255 的注入缝：读分支返回 null——零真 git spawn，分支面零帧噪。
    gitBranchReader: async () => null,
    ...opts,
  });
}

const tmpWs = (): Promise<string> => mkdtemp(join(tmpdir(), "o268-ws-"));

/** Seed: one ACTIVE project fact (auto-allow) + one PENDING user preference
 *  (user scope never auto-allows) — signature "2:1:1". */
async function seedStore(dir: string): Promise<{ activeId: string; pendingId: string }> {
  const store = openMemoryStore(dir);
  const a = await store.write({ kind: "fact", content: "构建命令是 pnpm build", scope: "project", tags: ["build"] });
  const p = await store.write({ kind: "preference", content: "称呼我用「老板」", scope: "user" });
  return { activeId: a.entry.id, pendingId: p.entry.id };
}

/** The signature projection under test — the store's own read API (load() 一次
 *  取全量，与 memoryListFn 同一读)。count=条目数，pending=待审数，maxVersion=
 *  最大 version。 */
const sigOf = (entries: readonly MemoryEntry[]): string => {
  let pending = 0;
  let maxVersion = 0;
  for (const e of entries) {
    if (e.status === "pending") pending += 1;
    const v = e.version ?? 1;
    if (v > maxVersion) maxVersion = v;
  }
  return `${entries.length}:${pending}:${maxVersion}`;
};

describe("ω99-268 R0 — store 投影实测（执行者核档：控制器两款项漏 decide-ok）", () => {
  it("合法写路径逐个过账：write/update/remove/confirm 必动其一；bumpHits/markSurfaced 刻意盲区", async () => {
    const dir = await tmpWs();
    const store = openMemoryStore(dir);
    expect(sigOf(await store.load())).toBe("0:0:0"); // 无文件读空表——确定性起点
    // write（auto-allow）：count 0→1
    await store.write({ kind: "fact", content: "事实甲", scope: "project" });
    expect(sigOf(await store.load())).toBe("1:0:1");
    // write（user scope 必 pending）：count+1 且 pending+1
    await store.write({ kind: "preference", content: "称呼我用「老板」", scope: "user" });
    expect(sigOf(await store.load())).toBe("2:1:1");
    // ★执行者核档：confirm（decide-ok 的底层）只翻 status——count 与 maxVersion
    // 双双不动！控制器的两款项 `${count}:${maxVersion}` 在 decide-ok 后不变
    // （2:1），签名漏掉一次真实写。本弧因此加第三项 pending（最小投影修正：
    // 任何 store 写动词必动三项之一，读遥测 hits/surfaced 仍刻意不动）。
    const entries0 = await store.load();
    const pendingId = entries0.find((e) => e.status === "pending")?.id as string;
    expect(await store.confirm(pendingId)).toBe(true);
    const afterConfirm = await store.load();
    expect(afterConfirm.length).toBe(2); // count 不动（rewriteAll 原地改行）
    expect(Math.max(...afterConfirm.map((e) => e.version ?? 1))).toBe(1); // maxVersion 不动
    expect(sigOf(afterConfirm)).toBe("2:0:1"); // pending 项接住 decide-ok
    // update：version+1（内容改写必可见——同数同 version 的内容改写不可达）
    const activeId = afterConfirm[0]?.id as string;
    await store.update(activeId, { content: "事实甲（改）" });
    expect(sigOf(await store.load())).toBe("2:1:2"); // v2 + 转 pending（update 必回待审）
    // remove：count-1
    await store.remove(pendingId);
    expect(sigOf(await store.load())).toBe("1:1:2");
    // bumpHits / markSurfaced：读遥测/簿记——刻意盲区（召回透明弧的地盘）
    await store.bumpHits([activeId]);
    expect(sigOf(await store.load())).toBe("1:1:2");
    await store.markSurfaced([activeId]);
    expect(sigOf(await store.load())).toBe("1:1:2");
  });
});

describe("ω99-268 R1 — boot 帧带签名 + 别窗写 → settle 后可见（值不变零帧）", () => {
  it("boot 读落定：getStatus().memorySignature === '2:1:1'（零 run 零提交）", async () => {
    const dir = await tmpWs();
    await seedStore(dir);
    const driver = makeDriver({
      model: createScriptedModel([{ role: "assistant", content: "ok" }]),
      tools: [],
      onPermissionAsk: allow,
      workspaceRoot: dir,
      sessionId: "o268-boot",
    });
    await until(() => driver.getStatus().memorySignature === "2:1:1", "boot signature lands");
    driver.dispose();
  });

  it("无工作区（stub 驱动）：字段缺席=零信号（255 的 null-face 同语义，optional 形）", async () => {
    const driver = makeDriver({
      model: createScriptedModel([{ role: "assistant", content: "ok" }]),
      tools: [],
      onPermissionAsk: allow,
    });
    await wait(120); // 即便有迟到的 boot 读也该保持缺席
    const status: DriverStatus = driver.getStatus();
    expect("memorySignature" in status).toBe(false); // 字段不在——不是 null
    driver.dispose();
  });

  it("别窗写一条：settle 前不可见（无轮询的诚实窗口）→ 本 driver run settle 后签名变", async () => {
    const dir = await tmpWs();
    await seedStore(dir);
    const driver = makeDriver({
      model: createScriptedModel([{ role: "assistant", content: "A1" }, { role: "assistant", content: "A2" }]),
      tools: [],
      onPermissionAsk: allow,
      workspaceRoot: dir,
      sessionId: "o268-settle",
    });
    await until(() => driver.getStatus().memorySignature === "2:1:1", "boot signature lands");
    // 别窗写（同 store 路径的物理写——另一窗的 memory 工具/Dream 落条目同形）
    await openMemoryStore(dir).write({ kind: "fact", content: "别窗落的新事实", scope: "project" });
    await wait(80);
    expect(driver.getStatus().memorySignature).toBe("2:1:1"); // settle 前：快照语义，零轮询
    // 本 driver 的 run 收束（轮界结算处刷新）
    driver.submit("跑一轮");
    await until(() => driver.getStatus().busy === false, "run settles");
    await until(() => driver.getStatus().memorySignature === "3:1:1", "settle re-read lands the other-window write");
    driver.dispose();
  });

  it("值不变零帧：无别窗写的第二 run settle——静默窗内零帧、签名值稳、快照引用稳定", async () => {
    const dir = await tmpWs();
    await seedStore(dir);
    const driver = makeDriver({
      model: createScriptedModel([{ role: "assistant", content: "A1" }, { role: "assistant", content: "A2" }]),
      tools: [],
      onPermissionAsk: allow,
      workspaceRoot: dir,
      sessionId: "o268-quiet",
    });
    await until(() => driver.getStatus().memorySignature === "2:1:1", "boot signature lands");
    driver.submit("第一轮");
    await until(() => driver.getStatus().busy === false, "first run settles");
    await until(() => driver.getStatus().queued.length === 0 && !driver.getStatus().busy, "quiet");
    await wait(80); // settle 读落定窗（值不变 → 零 emit）
    driver.submit("第二轮");
    await until(() => driver.getStatus().busy === false, "second run settles");
    await wait(150); // 第二次 settle 读（值不变）+ 静默窗
    let frames = 0;
    driver.subscribe(() => { frames += 1; });
    const before = driver.getStatus();
    await wait(150);
    expect(frames).toBe(0); // 值不变零帧（255 纪律：缓存变量不是重读源）
    expect(driver.getStatus().memorySignature).toBe("2:1:1");
    expect(driver.getStatus()).toBe(before); // 引用稳定（零帧 ⇒ 零重建）
    driver.dispose();
  });
});

describe("ω99-268 R2 — 三闭包落定即新签名（不等 settle；miss 零动）", () => {
  it("decide-ok（confirm）→ pending 项动：'2:1:1' → '2:0:1'（op 返回即上新值）", async () => {
    const dir = await tmpWs();
    const { pendingId } = await seedStore(dir);
    const driver = makeDriver({
      model: createScriptedModel([{ role: "assistant", content: "ok" }]),
      tools: [],
      onPermissionAsk: allow,
      workspaceRoot: dir,
      sessionId: "o268-decide",
    });
    await until(() => driver.getStatus().memorySignature === "2:1:1", "boot signature lands");
    let frames = 0;
    driver.subscribe(() => { frames += 1; });
    const r = await driver.memoryDecide(pendingId, "ok");
    expect(r.ok).toBe(true);
    // op 落定即上新签名（无需 run、无需 until——闭包后 awaited 刷新）
    expect(driver.getStatus().memorySignature).toBe("2:0:1");
    expect(frames).toBeGreaterThan(0); // 帧即时
    driver.dispose();
  });

  it("decide-del（remove）→ count 动；edit（update）→ maxVersion 动", async () => {
    const dir = await tmpWs();
    const { activeId, pendingId } = await seedStore(dir);
    const driver = makeDriver({
      model: createScriptedModel([{ role: "assistant", content: "ok" }]),
      tools: [],
      onPermissionAsk: allow,
      workspaceRoot: dir,
      sessionId: "o268-write",
    });
    await until(() => driver.getStatus().memorySignature === "2:1:1", "boot signature lands");
    await driver.memoryDecide(pendingId, "del");
    expect(driver.getStatus().memorySignature).toBe("1:0:1"); // count 2→1
    await driver.memoryEdit(activeId, "构建命令是 pnpm -r build");
    expect(driver.getStatus().memorySignature).toBe("1:0:2"); // active 改写：v+1 且终态仍 active
    driver.dispose();
  });

  it("memoryList 自带签名知识（同一份 load 零额外 IO）：别窗写 → 面板 fetch 落定即上新值", async () => {
    const dir = await tmpWs();
    const { activeId } = await seedStore(dir);
    const driver = makeDriver({
      model: createScriptedModel([{ role: "assistant", content: "ok" }]),
      tools: [],
      onPermissionAsk: allow,
      workspaceRoot: dir,
      sessionId: "o268-list",
    });
    await until(() => driver.getStatus().memorySignature === "2:1:1", "boot signature lands");
    await driver.memoryEdit(activeId, "构建命令是 pnpm -r build"); // active 改写 → v2 仍 active
    expect(driver.getStatus().memorySignature).toBe("2:1:2");
    // 别窗写（本 driver 不做任何 run/决定）
    await openMemoryStore(dir).write({ kind: "fact", content: "别窗补一条", scope: "project" });
    expect(driver.getStatus().memorySignature).toBe("2:1:2"); // 仍旧（零轮询）
    await driver.memoryList(); // 面板 fetch-on-open——其 load 顺带刷新签名
    expect(driver.getStatus().memorySignature).toBe("3:1:2");
    driver.dispose();
  });

  it("miss（ok:false）零刷新：签名不动（无写即无信号）", async () => {
    const dir = await tmpWs();
    await seedStore(dir);
    const driver = makeDriver({
      model: createScriptedModel([{ role: "assistant", content: "ok" }]),
      tools: [],
      onPermissionAsk: allow,
      workspaceRoot: dir,
      sessionId: "o268-miss",
    });
    await until(() => driver.getStatus().memorySignature === "2:1:1", "boot signature lands");
    await driver.memoryDecide("m-nope", "del");
    await driver.memoryEdit("m-nope", "任何内容");
    expect(driver.getStatus().memorySignature).toBe("2:1:1");
    driver.dispose();
  });
});
