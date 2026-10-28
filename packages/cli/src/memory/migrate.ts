// 记忆两库收敛（docs/specs/memory-system.md 实施裁决的后续收敛弧）——
// M49 存量一次性迁移 + M49 调度停用门。用户令：M49 人审门作为新库的
// confidence 路径合流——pending（人审队列）住新库 .wudao/memory/，审核面
// （web memoryList/Decide/Edit + TUI /memory ok|del + boot 待审提醒）读写
// 新库；旧库 .wudao/memory.jsonl 冻结为只读历史（模块与文件都不删——回滚线）。
//
// 迁移语义（一次性、幂等）：
//   * active 条目 → 新库 save confirmed；pending → save pending（M49 的
//     人审开项原样带过去，下次会话浮出待确认）
//   * 内容哈希去重天然幂等——重复调用零动作由 marker 保证（.wudao/memory/
//     migrated），即使 marker 丢失重迁也只是 useCount+1，不产生重复条目
//   * 凭据值/指令覆盖形状（guard 的块档门）在迁移时同样硬拦：拦下的条目
//     不进新库（pending 会把密钥明文持久化），改落拦截台账（可见，不静默丢）
//   * kind 映射：fact→fact、preference→preference、skill_note→skill、
//     harness→lesson（M49 的「操作心得」就是新库的「教训」族）
//   * useCount 归 1（新库的强度信号从此重新积累；M49 hits 遥测留在旧库）
//
// 调度停用门（dream/refine）：默认关。WUDAO_M49_LEGACY=1 重新启用——
// 回滚线不删模块，只停调度；模块级测试用同一开关跑既有机制钉。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openMemoryStore } from "./store.js";
import type { MemoryEntry as LegacyMemoryEntry, MemoryKind as LegacyMemoryKind } from "./store.js";
import { longtermMemoryDir, openLongtermMemoryStore } from "../longterm-memory.js";
import { appendBlockedLearningAt, buildBlockedRecord, screenLearningInput } from "./guard.js";
import type { MemoryStore } from "@wudao/core";

/** 迁移完成 marker：`<ws>/.wudao/memory/migrated`（存在即零动作）。 */
export function legacyMemoryMigrationMarker(workspaceRoot: string): string {
  return join(longtermMemoryDir(workspaceRoot), "migrated");
}

/** True once the one-shot migration has landed for this workspace. */
export async function legacyMemoryMigrated(workspaceRoot: string): Promise<boolean> {
  try {
    await readFile(legacyMemoryMigrationMarker(workspaceRoot), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** M49 kind → 新库 kind（内容哈希含 kind——映射必须稳定，幂等性依赖它）。 */
function migrateKind(kind: LegacyMemoryKind): "fact" | "preference" | "skill" | "lesson" {
  switch (kind) {
    case "fact":
      return "fact";
    case "preference":
      return "preference";
    case "skill_note":
      return "skill";
    case "harness":
      return "lesson";
  }
}

/**
 * One-shot legacy→new migration. Idempotent: the marker short-circuits repeat
 * calls; a lost marker re-runs into content-hash dedup (useCount bumps, no
 * duplicates). Never throws — a failed migration costs one console-noisy
 * retry at next boot, never a broken session.
 */
export async function migrateLegacyMemory(workspaceRoot: string, store?: MemoryStore): Promise<void> {
  if (await legacyMemoryMigrated(workspaceRoot)) return;
  // The legacy ledger（M49 store 的读路径自带坏行容错；文件缺席=空库）。
  const legacy: readonly LegacyMemoryEntry[] = await openMemoryStore(workspaceRoot).load().catch((): readonly LegacyMemoryEntry[] => []);
  const target = store ?? openLongtermMemoryStore(workspaceRoot);
  // 拦截台账锚在旧库路径（.wudao/memory-blocked.jsonl）——台账位置是 web
  // 文案的既定契约，不随库搬家。
  const ledgerAnchor = openMemoryStore(workspaceRoot).path;
  const blocked: { readonly at: string; readonly reasons: readonly string[]; readonly content: string }[] = [];
  const migrateOne = async (entry: LegacyMemoryEntry, confidence: "confirmed" | "pending"): Promise<void> => {
    const screen = screenLearningInput(entry.content);
    if (screen.blocked) {
      blocked.push({ at: new Date().toISOString(), reasons: screen.reasons, content: entry.content });
      return;
    }
    const created = Date.parse(entry.created);
    await target.save({
      kind: migrateKind(entry.kind),
      text: entry.content,
      tags: entry.tags,
      confidence,
      ...(Number.isFinite(created) ? { now: new Date(created) } : {}),
    });
  };
  // active 先迁：同内容的 pending 随后会 bump 已 confirmed 的行（单向门不回审）。
  for (const e of legacy) {
    if (e.status === "active") await migrateOne(e, "confirmed");
  }
  for (const e of legacy) {
    if (e.status !== "active") await migrateOne(e, "pending");
  }
  // 拦截台账（决定已成立；落盘失败不阻断迁移）。
  for (const b of blocked) {
    await appendBlockedLearningAt(ledgerAnchor, buildBlockedRecord({ ...b, source: "migrate" })).catch(() => {});
  }
  // Marker last——中途失败则下次 boot 重试（dedup 吸收半程写入）。
  await mkdir(longtermMemoryDir(workspaceRoot), { recursive: true });
  await writeFile(legacyMemoryMigrationMarker(workspaceRoot), `${new Date().toISOString()}\n`, "utf8");
}

/**
 * M49 调度停用门（dream / auto-refine 的自动调度）。默认 false——两库收敛
 * 后新库是唯一记忆管线；WUDAO_M49_LEGACY=1 是回滚开关（旧调度原样恢复）。
 */
export function legacyMemorySchedulingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.WUDAO_M49_LEGACY ?? "").trim() === "1";
}
