// ω99-194 — lifecycle 清扫/清除域中文化回执：formatSweepNotice/formatPurgePlan
// 显示层全中文（182/193 报告体先例），token 保留（.wudao/trash /
// softDeletePeriodDays / formatBytes 输出形 / 空串契约）。两组 5 it：
//   A1 formatSweepNotice 双分支满配全串 toBe + 单 moved 形 + 空结果 "" 契约；
//   A2 formatPurgePlan 头行逐字 + 行形 `  rel  bytes  N 天前`（now 注入控龄）；
//   A3 index.ts 三面源钉（175/191 最小 stub 范式：REPL 驱动重，渲染串由
//      det-46 跨包钉演进承担，brief §四明许此选形）；
//   B1 两格式器输出旧形归零 + index 源反查（file(s) 不在源反查之列：
//      index.ts:549 confirmLine 交互提示为面表外域界面——§三零触、
//      census 入池另案，此处不据以断言）；
//   B2 保留 token 正钉（.wudao/trash / softDeletePeriodDays / formatBytes 三形）。
// B2 改前即绿（保留契约两态皆绿），按 188-193 先例与红断言并组保红。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { formatBytes, formatPurgePlan, formatSweepNotice } from "../src/lifecycle.js";
import type { CleanableEntry, PurgePlan, SweepResult } from "../src/lifecycle.js";

const indexSrc = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8") as string;

const entry = (relPath: string, bytes: number, mtimeMs: number): CleanableEntry => ({
  absPath: `/ws/.wudao/${relPath}`,
  relPath,
  bytes,
  mtimeMs,
});

const DAY = 86_400_000;

describe("ω99-194 A — 清扫通知/清除计划显示层中文化", () => {
  it("A1 formatSweepNotice 双分支满配全串 + 单 moved 形 + 空结果空串契约", () => {
    // 2 文件 1024+512=1536 B → formatBytes "1.5 KB"；1 回收站文件 512 B → "512 B"。
    const both: SweepResult = {
      softDeleted: [entry("sessions/a.jsonl", 1024, 0), entry("sessions/b.jsonl", 512, 0)],
      hardDeleted: [entry("trash/spill/c.bin", 512, 0)],
      softDeletedBytes: 1536,
      hardDeletedBytes: 512,
    };
    expect(formatSweepNotice(both)).toBe(
      "♻️ 生命周期：已将 2 个文件（1.5 KB）移入 .wudao/trash，已彻底清除 1 个回收站文件（512 B）——超软删除窗口",
    );
    const movedOnly: SweepResult = {
      softDeleted: [entry("sessions/a.jsonl", 300, 0)],
      hardDeleted: [],
      softDeletedBytes: 300,
      hardDeletedBytes: 0,
    };
    expect(formatSweepNotice(movedOnly)).toBe("♻️ 生命周期：已将 1 个文件（300 B）移入 .wudao/trash");
    // 空串契约（det-46 :966 emptyNotice === "" 的本地镜像）。
    expect(formatSweepNotice({ softDeleted: [], hardDeleted: [], softDeletedBytes: 0, hardDeletedBytes: 0 })).toBe("");
  });

  it("A2 formatPurgePlan 头行逐字 + 行形两空格列分隔 `  rel  bytes  N 天前`（now 注入控龄）", () => {
    const now = 1_000_000_000_000;
    const plan: PurgePlan = {
      entries: [entry("spill/b.bin", 100, now), entry("sessions/a.jsonl", 2048, now - 3 * DAY)],
      totalBytes: 2148,
    };
    expect(formatPurgePlan(plan, now)).toBe(
      "清除计划——2 个文件，2.1 KB（软删除至 .wudao/trash；软删除窗口内可恢复）：\n" +
        "  sessions/a.jsonl  2.0 KB  3 天前\n" +
        "  spill/b.bin  100 B  0 天前",
    );
  });

  it("A3 index.ts 三面源钉（无可清除/试运行/移入完成；REPL 渲染串由 det-46 演进钉承担）", () => {
    expect(indexSrc).toContain('stdoutGuard.writeRawStdout("无可清除数据（.wudao 下没有可过期的运行时数据）\\n")');
    expect(indexSrc).toContain('stdoutGuard.writeRawStdout("（试运行——未写入任何内容）\\n")');
    expect(indexSrc).toContain(
      "stdoutGuard.writeRawStdout(`已将 ${result.softDeleted.length} 个文件移入 .wudao/trash——软删除窗口内可恢复（softDeletePeriodDays，默认 7）\\n`)",
    );
  });
});

describe("ω99-194 B — 反向归零 + 保留 token 正钉", () => {
  it("B1 两格式器输出旧形归零 + index 源反查（549 交互提示面外域不查）", () => {
    const notice = formatSweepNotice({
      softDeleted: [entry("sessions/a.jsonl", 1024, 0)],
      hardDeleted: [entry("trash/spill/c.bin", 512, 0)],
      softDeletedBytes: 1024,
      hardDeletedBytes: 512,
    });
    const plan = formatPurgePlan(
      { entries: [entry("sessions/a.jsonl", 2048, 0)], totalBytes: 2048 },
      1_000_000_000_000,
    );
    for (const out of [notice, plan]) {
      for (const old of ["moved ", "purged ", "file(s)", "purge plan", "d old", "lifecycle:", "dry run", "nothing to purge"]) {
        expect(out).not.toContain(old);
      }
    }
    // index 源反查：本弧三面所出的旧形归零（file(s) 的 :549 存活另案披露，不查）。
    for (const old of ["moved ", "purged ", "purge plan", "d old", "lifecycle:", "nothing to purge", "(dry run"]) {
      expect(indexSrc).not.toContain(old);
    }
  });

  it("B2 保留 token 正钉（.wudao/trash / softDeletePeriodDays / formatBytes 三形）", () => {
    expect(formatSweepNotice({ softDeleted: [entry("sessions/a.jsonl", 10, 0)], hardDeleted: [], softDeletedBytes: 10, hardDeletedBytes: 0 })).toContain(".wudao/trash");
    expect(
      formatPurgePlan({ entries: [entry("sessions/a.jsonl", 10, 0)], totalBytes: 10 }, 1_000_000_000_000),
    ).toContain(".wudao/trash");
    expect(indexSrc).toContain("softDeletePeriodDays");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});
