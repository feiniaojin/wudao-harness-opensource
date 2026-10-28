// 记忆两库收敛 — M49 存量一次性迁移（migrate.ts）R 件：active→confirmed /
// pending→pending 分流、kind 映射、marker 幂等（二次调用零动作、字节零变）、
// 凭据值形状硬拦（不迁移、落拦截台账且预览脱敏）、同内容 active+pending
// 双行收敛为 confirmed（单向门）。夹具只写 mkdtemp(os.tmpdir())（★红线——
// memory.jsonl 是用户数据，测试绝不触真实工作区）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStore as openLegacyStore } from "../src/memory/store.js";
import {
  migrateLegacyMemory,
  legacyMemoryMigrated,
  legacyMemoryMigrationMarker,
} from "../src/memory/migrate.js";
import { openLongtermMemoryStore } from "../src/longterm-memory.js";
import { readBlockedLearningAt, blockedLedgerPathFor } from "../src/memory/guard.js";
import { memoryStorePath } from "../src/memory/store.js";

let ws: string;
beforeEach(async () => { ws = await mkdtemp(join(tmpdir(), "wudao-mem-migrate-")); });
afterEach(async () => { await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

describe("记忆两库收敛 — migrateLegacyMemory", () => {
  it("active→confirmed / pending→pending 分流 + kind 映射（fact/preference/skill_note→skill/harness→lesson）", async () => {
    const legacy = openLegacyStore(ws);
    await legacy.write({ kind: "fact", content: "构建命令是 pnpm build", scope: "project", tags: ["build"] });
    await legacy.write({ kind: "preference", content: "称呼我用老板", scope: "user" }); // user-scope → pending
    await legacy.write({ kind: "skill_note", content: "改动后跑聚焦测试", scope: "project", tags: ["test"] }); // project → active
    await legacy.write({ kind: "harness", content: "先问再动 plan 模式", scope: "project", forcePending: true });

    await migrateLegacyMemory(ws);

    const store = openLongtermMemoryStore(ws);
    const all = store.list({ includePending: true });
    expect(all).toHaveLength(4);
    const confirmed = store.list();
    expect(confirmed.map((e) => e.text).sort()).toEqual(["构建命令是 pnpm build", "改动后跑聚焦测试"].sort());
    expect(store.listPending().map((e) => e.text).sort()).toEqual(["先问再动 plan 模式", "称呼我用老板"].sort());
    // kind 映射真值
    expect(confirmed.find((e) => e.text === "改动后跑聚焦测试")?.kind).toBe("skill");
    expect(store.listPending().find((e) => e.text === "先问再动 plan 模式")?.kind).toBe("lesson");
    // tags 与 created 保留（created 走迁移的 now 注入）
    expect(confirmed.find((e) => e.text === "构建命令是 pnpm build")?.tags).toContain("build");
  });

  it("marker 幂等：迁移后 marker 在场；二次调用零动作（新库字节零变）", async () => {
    const legacy = openLegacyStore(ws);
    await legacy.write({ kind: "fact", content: "一次性事实", scope: "project" });
    await migrateLegacyMemory(ws);
    expect(await legacyMemoryMigrated(ws)).toBe(true);
    const file = join(ws, ".wudao", "memory", "memory.jsonl");
    const bytes = await readFile(file, "utf8");
    const markerStat = await readFile(legacyMemoryMigrationMarker(ws), "utf8");
    await migrateLegacyMemory(ws); // 二次调用
    expect(await readFile(file, "utf8")).toBe(bytes); // 零动作
    expect(await readFile(legacyMemoryMigrationMarker(ws), "utf8")).toBe(markerStat);
  });

  it("空旧库（无 .wudao/memory.jsonl）→ 零条目 + marker 落定（此后每会话一次廉价存在检查）", async () => {
    await migrateLegacyMemory(ws);
    expect(openLongtermMemoryStore(ws).list({ includePending: true })).toHaveLength(0);
    expect(await legacyMemoryMigrated(ws)).toBe(true);
  });

  it("凭据值形状硬拦：不迁移、落拦截台账（source=migrate、预览脱敏）", async () => {
    // guard 弧之前的存量可能已含密钥行（当时的 store.write 只有 pending 门）——
    // 直写原始行模拟 pre-guard 存量（今天的 write 会当场硬拦，进不了台账）。
    const legacy = openLegacyStore(ws);
    const b = await legacy.write({ kind: "fact", content: "正常的迁移事实", scope: "project" });
    expect(b.entry.status).toBe("active");
    const { appendFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(ws, ".wudao"), { recursive: true });
    await appendFile(memoryStorePath(ws), `${JSON.stringify({
      id: "m-bad", kind: "fact", content: "the api key is sk-abcdef12345678",
      scope: "project", tags: [], created: new Date().toISOString(), hits: 0, status: "pending", seq: 2, version: 1,
    })}\n`);

    await migrateLegacyMemory(ws);

    const store = openLongtermMemoryStore(ws);
    expect(store.list({ includePending: true }).map((e) => e.text)).toEqual(["正常的迁移事实"]);
    const ledger = await readBlockedLearningAt(memoryStorePath(ws));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.source).toBe("migrate");
    expect(ledger[0]!.preview).not.toContain("sk-abcdef12345678");
    expect(ledger[0]!.preview).toContain("已脱敏");
  });

  it("同内容同 kind 的 active+pending 双行：收敛为 confirmed（单向门，useCount 承接强度）", async () => {
    const legacy = openLegacyStore(ws);
    await legacy.write({ kind: "fact", content: "同内容条目", scope: "project" }); // active
    await legacy.write({ kind: "fact", content: "同内容条目", scope: "project", forcePending: true }); // pending
    await migrateLegacyMemory(ws);
    const store = openLongtermMemoryStore(ws);
    expect(store.listPending()).toHaveLength(0); // active 先迁 → pending 追存只 bump
    const e = store.list().find((x) => x.text === "同内容条目");
    expect(e).toBeDefined();
    expect(e!.confidence).toBe("confirmed");
    expect(e!.useCount).toBe(2); // 两行 = 两次遇见（迁移的 dedup 即强度）
  });

  it("legacyMemoryMigrated 的缺省 false（无 marker 即未迁移——/memory list 过渡期双列的判据）", async () => {
    expect(await legacyMemoryMigrated(ws)).toBe(false);
  });

  it("runtime 装配点触发（createLongtermMemoryRuntime 内建迁移）+ enabled=false 尊重开关零动作", async () => {
    const legacy = openLegacyStore(ws);
    await legacy.write({ kind: "fact", content: "装配点迁移事实", scope: "project" });
    const { createLongtermMemoryRuntime } = await import("../src/longterm-memory.js");
    await createLongtermMemoryRuntime({ workspaceRoot: ws, enabled: false });
    expect(await legacyMemoryMigrated(ws)).toBe(false); // 失能零动作
    await createLongtermMemoryRuntime({ workspaceRoot: ws });
    expect(await legacyMemoryMigrated(ws)).toBe(true);
    expect(openLongtermMemoryStore(ws).list()).toHaveLength(1);
  });
});

// 台账路径契约：拦截台账住在旧库路径旁（.wudao/memory-blocked.jsonl）——
// web 文案的既定契约，不随新库搬家。
describe("记忆两库收敛 — 拦截台账路径契约", () => {
  it("blockedLedgerPathFor(旧库路径) = <ws>/.wudao/memory-blocked.jsonl", () => {
    expect(blockedLedgerPathFor(memoryStorePath(ws))).toBe(join(ws, ".wudao", "memory-blocked.jsonl"));
  });
});

// 调度停用门：dream / auto-refine 默认不调度（WUDAO_M49_LEGACY=1 回滚态）。
// 机制本体（冻结回滚线）的既有钉在 dream-consolidation.test.ts /
// auto-refine.test.ts（各自设 env 跑）。
describe("记忆两库收敛 — 调度停用门（legacyMemorySchedulingEnabled）", () => {
  it("缺省 false；WUDAO_M49_LEGACY=1 true；宽松解析（空白/其它值=false）", async () => {
    const { legacyMemorySchedulingEnabled } = await import("../src/memory/migrate.js");
    expect(legacyMemorySchedulingEnabled({})).toBe(false);
    expect(legacyMemorySchedulingEnabled({ WUDAO_M49_LEGACY: "1" })).toBe(true);
    expect(legacyMemorySchedulingEnabled({ WUDAO_M49_LEGACY: " 1 " })).toBe(true);
    expect(legacyMemorySchedulingEnabled({ WUDAO_M49_LEGACY: "0" })).toBe(false);
  });

  it("spawnDreamRun 缺省 undefined（零 spawn——不因调度停用而抛）", async () => {
    const { spawnDreamRun } = await import("../src/memory/dream.js");
    const saved = process.env.WUDAO_M49_LEGACY;
    delete process.env.WUDAO_M49_LEGACY;
    try {
      await expect(spawnDreamRun({ workspaceRoot: ws } as never)).resolves.toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.WUDAO_M49_LEGACY = saved;
    }
  });

  it("refineAutoRuntimeFor 缺省 undefined——即便设置里 refine.auto.enabled=true（收敛后用户设置失效）", async () => {
    const { refineAutoRuntimeFor, resetRefineAutoRuntimeCache } = await import("../src/memory/auto-refine.js");
    const { writeFile: wf, mkdir: mk } = await import("node:fs/promises");
    await mk(join(ws, ".wudao"), { recursive: true });
    await wf(join(ws, ".wudao", "settings.json"), JSON.stringify({ refine: { auto: { enabled: true } } }), "utf8");
    const saved = process.env.WUDAO_M49_LEGACY;
    delete process.env.WUDAO_M49_LEGACY;
    try {
      resetRefineAutoRuntimeCache();
      await expect(refineAutoRuntimeFor(ws)).resolves.toBeUndefined();
    } finally {
      resetRefineAutoRuntimeCache();
      if (saved !== undefined) process.env.WUDAO_M49_LEGACY = saved;
    }
  });
});
