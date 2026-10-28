// ω99-268: #8 — 记忆面板实时订阅 R 件（driver 面）：DriverStatus.memorySignature
// ——记忆 store 的内容签名（`count:pending:ids`，store 单调量的投影）。
// 签名不是展示源（列表数据走 memoryList op 不变）——它是变化信号：跨帧比对变
// 化 → web 管理面板/待审卡重取。刷新点 = boot + run settle + 三个 memory 闭包
// 落定后（本进程写的立即反映，不等 settle）；255 的 seq 守卫 + 值不变零帧纪律
// 逐字镜像（缓存变量 + 纯变量读进 buildStatus，emit 路径绝不读盘）。全 mock
// （scripted model + gitBranchReader 注入 null——零真模型零网络零 spawn）；夹具
// 只写 mkdtemp(os.tmpdir()) 只写不删（零删除原语——memory.jsonl 是用户数据，
// 测试绝不触 ~/.wudao 或真实工作区 store）。
// 记忆两库收敛（retarget 随源演进）：签名源改钉新库（.wudao/memory/）——R0 的
// 旧库投影实测保留（冻结 store 的投影档案），R1/R2 的种子与期望值改走新库；
// 第三项从 maxVersion（旧库内容链轨道，随冻结退役）换为排序 id 的 sha256 摘
// 要——新库改写=新 id 换旧 id（count/pending 可双净零），id 集把「内容链变
// 了」带回签名面。
import { describe, it, expect, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedModel } from "@wudao/core";
import type { AgentDriver, AgentDriverOptions, DriverStatus } from "../src/driver/agent-driver.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import { openMemoryStore } from "../src/memory/store.js";
import type { MemoryEntry } from "../src/memory/store.js";
import { openLongtermMemoryStore, longtermMemoryAuditRow } from "../src/longterm-memory.js";
import { createMemorySignatureTracker } from "../src/driver/memory-signature.js";
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

/** Seed（合流后）：一条 confirmed 事实 + 一条 pending 偏好（人审队列）。 */
async function seedStore(dir: string): Promise<{ activeId: string; pendingId: string }> {
  const store = openLongtermMemoryStore(dir);
  const a = await store.save({ kind: "fact", text: "构建命令是 pnpm build", tags: ["build"] });
  const p = await store.save({ kind: "preference", text: "称呼我用「老板」", confidence: "pending" });
  return { activeId: a.id, pendingId: p.id };
}

/** The signature projection under test — the tracker's OWN compute (single
 *  source; the seed rows go through the same audit-row mapping the driver
 *  uses, never a hand-copied formula). */
const sigTracker = createMemorySignatureTracker({ workspaceRoot: undefined, emit: () => {}, openStore: () => { throw new Error("unused"); } });
const sigOf = (entries: readonly import("@wudao/core").MemoryEntry[]): string =>
  sigTracker.compute(entries.map((e) => longtermMemoryAuditRow(e)));
/** 新库当前全量（confirmed + pending——memoryList 的同面）。 */
const allOf = (dir: string) => openLongtermMemoryStore(dir).list({ includePending: true });

describe("ω99-268 R0 — 旧库（M49）投影实测（冻结档案：执行者核档的原始证据链保留）", () => {
  it("合法写路径逐个过账：write/update/remove/confirm 必动其一；bumpHits/markSurfaced 刻意盲区", async () => {
    const dir = await tmpWs();
    const store = openMemoryStore(dir);
    const sig49 = async (): Promise<string> => {
      const entries = await store.load();
      let pending = 0;
      for (const e of entries) if (e.status === "pending") pending += 1;
      let maxVersion = 0;
      for (const e of entries) { const v = e.version ?? 1; if (v > maxVersion) maxVersion = v; }
      return `${entries.length}:${pending}:${maxVersion}`;
    };
    expect(await sig49()).toBe("0:0:0"); // 无文件读空表——确定性起点
    await store.write({ kind: "fact", content: "事实甲", scope: "project" });
    expect(await sig49()).toBe("1:0:1");
    await store.write({ kind: "preference", content: "称呼我用「老板」", scope: "user" });
    expect(await sig49()).toBe("2:1:1");
    const entries0 = await store.load();
    const pendingId = entries0.find((e) => e.status === "pending")?.id as string;
    expect(await store.confirm(pendingId)).toBe(true);
    expect(await sig49()).toBe("2:0:1"); // pending 项接住 decide-ok
    const activeId = entries0.find((e) => e.status === "active")?.id as string;
    await store.update(activeId, { content: "事实甲（改）" });
    expect(await sig49()).toBe("2:1:2"); // v2 + 转 pending（update 必回待审）
    await store.remove(pendingId);
    expect(await sig49()).toBe("1:1:2");
    await store.bumpHits([activeId]);
    await store.markSurfaced([activeId]);
    expect(await sig49()).toBe("1:1:2"); // 读遥测/簿记——刻意盲区
  });
});

describe("ω99-268 R1 — boot 帧带签名 + 别窗写 → settle 后可见（值不变零帧）", () => {
  it("boot 读落定：getStatus().memorySignature === 种子签名（零 run 零提交）", async () => {
    const dir = await tmpWs();
    await seedStore(dir);
    const expected = sigOf(allOf(dir));
    expect(expected).toMatch(/^2:1:[0-9a-f]{8}$/); // 合流投影形：count:pending:ids8
    const driver = makeDriver({
      model: createScriptedModel([{ role: "assistant", content: "ok" }]),
      tools: [],
      onPermissionAsk: allow,
      workspaceRoot: dir,
      sessionId: "o268-boot",
    });
    await until(() => driver.getStatus().memorySignature === expected, "boot signature lands");
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
    const before = sigOf(allOf(dir));
    const driver = makeDriver({
      model: createScriptedModel([{ role: "assistant", content: "A1" }, { role: "assistant", content: "A2" }]),
      tools: [],
      onPermissionAsk: allow,
      workspaceRoot: dir,
      sessionId: "o268-settle",
    });
    await until(() => driver.getStatus().memorySignature === before, "boot signature lands");
    // 别窗写（新库物理写——另一窗的 memory 工具/会话终了沉淀同形）
    await openLongtermMemoryStore(dir).save({ kind: "fact", text: "别窗落的新事实" });
    const after = sigOf(allOf(dir));
    expect(after).toMatch(/^3:1:/);
    await wait(80);
    expect(driver.getStatus().memorySignature).toBe(before); // settle 前：快照语义，零轮询
    // 本 driver 的 run 收束（轮界结算处刷新）
    driver.submit("跑一轮");
    await until(() => driver.getStatus().busy === false, "run settles");
    await until(() => driver.getStatus().memorySignature === after, "settle re-read lands the other-window write");
    driver.dispose();
  });

  it("值不变零帧：无别窗写的第二 run settle——静默窗内零帧、签名值稳、快照引用稳定", async () => {
    const dir = await tmpWs();
    await seedStore(dir);
    const expected = sigOf(allOf(dir));
    const driver = makeDriver({
      model: createScriptedModel([{ role: "assistant", content: "A1" }, { role: "assistant", content: "A2" }]),
      tools: [],
      onPermissionAsk: allow,
      workspaceRoot: dir,
      sessionId: "o268-quiet",
    });
    await until(() => driver.getStatus().memorySignature === expected, "boot signature lands");
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
    expect(driver.getStatus().memorySignature).toBe(expected);
    expect(driver.getStatus()).toBe(before); // 引用稳定（零帧 ⇒ 零重建）
    driver.dispose();
  });
});

describe("ω99-268 R2 — 三闭包落定即新签名（不等 settle；miss 零动）", () => {
  it("decide-ok（confirm）→ pending 项动：'2:1:x' → '2:0:x'（同 id 换行——ids 不动，op 返回即上新值）", async () => {
    const dir = await tmpWs();
    await seedStore(dir);
    const expected = sigOf(allOf(dir));
    const driver = makeDriver({
      model: createScriptedModel([{ role: "assistant", content: "ok" }]),
      tools: [],
      onPermissionAsk: allow,
      workspaceRoot: dir,
      sessionId: "o268-decide",
    });
    await until(() => driver.getStatus().memorySignature === expected, "boot signature lands");
    let frames = 0;
    driver.subscribe(() => { frames += 1; });
    const pendingId = allOf(dir).find((e) => e.confidence === "pending")!.id;
    const r = await driver.memoryDecide(pendingId, "ok");
    expect(r.ok).toBe(true);
    const afterConfirm = sigOf(allOf(dir));
    expect(afterConfirm).toBe(expected.replace(/^2:1:/, "2:0:")); // pending-1，ids 不动
    expect(driver.getStatus().memorySignature).toBe(afterConfirm);
    expect(frames).toBeGreaterThan(0); // 帧即时
    driver.dispose();
  });

  it("decide-del（forget）→ count 动；edit（新 id 换旧 id）→ ids 摘要动（合流轨道）", async () => {
    const dir = await tmpWs();
    const { activeId, pendingId } = await seedStore(dir);
    const driver = makeDriver({
      model: createScriptedModel([{ role: "assistant", content: "ok" }]),
      tools: [],
      onPermissionAsk: allow,
      workspaceRoot: dir,
      sessionId: "o268-write",
    });
    await until(() => driver.getStatus().memorySignature === sigOf(allOf(dir)), "boot signature lands");
    await driver.memoryDecide(pendingId, "del");
    const afterDel = sigOf(allOf(dir));
    expect(afterDel).toMatch(/^1:0:/); // count 2→1（tombstone）
    expect(driver.getStatus().memorySignature).toBe(afterDel);
    await driver.memoryEdit(activeId, "构建命令是 pnpm -r build");
    const afterEdit = sigOf(allOf(dir));
    expect(afterEdit).toMatch(/^1:0:/); // count/pending 双净零（改写=新 id 换旧 id）
    expect(afterEdit).not.toBe(afterDel); // ids 摘要接住「内容链变了」
    expect(driver.getStatus().memorySignature).toBe(afterEdit);
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
    await until(() => driver.getStatus().memorySignature === sigOf(allOf(dir)), "boot signature lands");
    await driver.memoryEdit(activeId, "构建命令是 pnpm -r build"); // 改写 → 新 id
    const afterEdit = sigOf(allOf(dir));
    expect(driver.getStatus().memorySignature).toBe(afterEdit);
    // 别窗写（本 driver 不做任何 run/决定）
    await openLongtermMemoryStore(dir).save({ kind: "fact", text: "别窗补一条" });
    expect(driver.getStatus().memorySignature).toBe(afterEdit); // 仍旧（零轮询）
    await driver.memoryList(); // 面板 fetch-on-open——其 load 顺带刷新签名
    expect(driver.getStatus().memorySignature).toBe(sigOf(allOf(dir)));
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
    const expected = sigOf(allOf(dir));
    await until(() => driver.getStatus().memorySignature === expected, "boot signature lands");
    await driver.memoryDecide("nope", "del");
    await driver.memoryEdit("nope", "任何内容");
    expect(driver.getStatus().memorySignature).toBe(expected);
    driver.dispose();
  });
});
