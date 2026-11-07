// ω99-96 — barrel surface pin (queue 111 row 3, the closing arc of the barrel
// diet): the 325-name public surface that ω99-94 (−158 self-used) and ω99-95
// (−122 test-only) carved out of packages/core/src/index.ts is pinned to a
// snapshot fixture. From here on, any unintentional export added to or removed
// from the barrel turns this file red with a bidirectional, actionable diff —
// the diet's result can no longer silently rebound.
//
// 口径注记（caliber）: 剥注释口径；审计 596/粗解 599 的历史差异见 ω99-94 报告
// §口径注记（concern-3: 三法差异全在块内行注释的解析处理，本钉全程单一口径）。
// The oracle is scripts/count-barrel-exports.mjs (comment-stripped, name-level
// extraction — immune to the inline-type/dynamic-import miss shapes ω99-95
// documented), NOT tsc: ω99-94 §3 proved TS4023 is structurally silent on pure
// re-export barrels, so no compiler gate can see this surface at all.
//
// Deliberately changing the barrel (a reviewed diet cut, a reviewed addition)
// requires regenerating the fixture and updating PINNED_COUNT in the same
// commit — that friction is the point of the pin:
//   node scripts/count-barrel-exports.mjs --snapshot packages/core/src/index.ts \
//     > packages/core/tests/fixtures/barrel-surface.txt
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const COUNTER = join(REPO_ROOT, "scripts", "count-barrel-exports.mjs");
const BARREL = join(REPO_ROOT, "packages", "core", "src", "index.ts");
const SNAPSHOT = join(import.meta.dirname, "fixtures", "barrel-surface.txt");

/** The pinned surface size after ω99-94 (447 = 605 − 158) and ω99-95
 *  (325 = 447 − 122). ω99-249: #14 — 348 = 325 + 23 (the GoalState object
 *  face: goal-state.ts's exports). 0.3.79 发版门 — 349 = 348 + 1
 *  (SESSION_ID_RE, ω99-279 随 store 面放出; 516daab9 漏跟钉, 此处补).
 *  ω99-318（后到者吸收并行弧漂移，双注释保留）— 365 = 349 + 5 + 11:
 *  +5 是 ω99-315 turn-retry 面（4d449df4 加了 barrel 导出但 fixture 再生
 *  滞后——main 上本钉当时已红，此处按 census 撞车纪律一并吸收）；
 *  +11 是 ω99-318 unicode-security 面（unicode-security.ts 的导出）.
 *  借鉴弧 B1/B2（a reference project C1/C2）— 372 = 365 + 6 + 1：压缩经济学面的 6 个
 *  类型名（CachePricing/CacheRatioSource/CompactionEconomics{Decision,Reason,
 *  Report}/EconomicsDecideInput）+ 1 个缺省 ratio 常量（providers 推导链与
 *  core tracker 共用的单一真值点）——其余运行面走 compaction.ts 域门面不进 barrel。
 *   * 借鉴弧C（2026-09-15）随迁：+15=log-slimming 公共面（DEFAULT_LOG_SLIMMING/LOG_SLIMMING_SYSTEM_PROMPT/
 * LogSlimmingConfig/LogSlimmingPorts/ParsedReceipt/ReceiptProvenance/SlimOutcome/VerifiedEvidence 等）。
 *   * 借鉴弧 ζ1（2026-09-15，Reasonix 蒸馏）— 406 = 387 + 19：未决写崩溃事实
 * 面——pending-actions.ts 的 15 个名（PENDING_ACTIONS_{TAG,CAP}/STALE_PENDING_
 * WRITE_RESULT/canonicalArguments/argumentFingerprint/normalizePathArg/
 * pendingActionLine/formatPendingActions/parsePendingActionsFromSummary/
 * pendingLedgerOf/pendingActionsSection/createPendingWriteGate + PendingWrite
 * {Entry,Gate}/WriteActionTool 三类型）+ tool-result-synthetics.ts 的 4 常量
 *（TRUNCATED/ABORTED_UNKNOWN/ABORTED_NOT_STARTED 外提后 loop re-export 面转
 * 正 + UNKNOWN_OUTCOME_TOOL_RESULTS 判定集）。
 * Bump only with a fixture regeneration.
 * 多 driver 并发弧 A（2026-09-16）— 415 = 413 + 2：多槽租约盒面
 * （createMultiSlotLeaseBox 值导出 + MultiSlotSessionLeaseBox 类型——
 * lease.ts 新增多 driver 并发原语，单槽行为不变）。
 * PB-1 探针基础设施弧（2026-09-17）— 424 = 415 + 9：探针面 9 名
 * （ProbeEvent/ProbeCategory/ProbeBus/ProbeBusStatsEntry 四类型 +
 * createProbeBus/probeBus/probeEnabled/probeModelClient/PROBE_ENV 五值
 * ——探针总线与标准化遥测格式；PROBE_ENV 走 MONITOR_DISABLE_ENV 同款
 * env 名单一真值点先例；其余挂载件 probeTools/probeAgentLoop/
 * startSystemProbes 走 core/providers 内部缝不进 barrel）。 */
/** 113-B1：recency 锚 barrel +4（427→431）+ 113-B3 配额停泊 +2 撞车吸收（431→433）
 * + 114 纪律层 goal 面桶 +2（433→435，弧5 e5113c1b）。
 * 114 持久 Python kernel +3（435→438）：createPythonKernelTool/
 * PYTHON_KERNEL_DEFAULT_IDLE_TIMEOUT_MS/PYTHON_KERNEL_TMP_PREFIX——
 * 夹具经 canonical oracle 再生（并集 438，两弧吸收历史的单一真值）。
 * 120-a A2 摘要前缀冻结契约 +2（438→440）：summaryPrefixDrift/
 * PrefixFreezeContract——createScriptedModel 家族的测试支持件。
 * 121 挖掘 TOP5 #1 压缩历史检索面 +10（440→450）：searchHistory/
 * historySearchSnippet/createSearchHistoryTool + SEARCH_HISTORY_×3 常量 +
 * HistorySearch{Loader,Corpus,Entry,Hit} 四类型——被压缩对话的模型侧
 * 检索工具（session_result 的族弟）。
 * 121 项 1 AIMD 面 +3 撞车吸收（111c965d 加了 barrel 导出但夹具再生滞后，
 * ω99-318 census 纪律：后到者吸收）+ 121 §1 续章持久笔记面 +16（450→469）：
 * createNotesTools + 命名/解析/列示 7 纯函数（noteSlugOf/noteTimestampName/
 * noteFileName/parseNoteFileName/noteFileBody/parseNoteBody/listNotes）+
 * 5 常量（NOTE_CONTENT_MAX_CHARS/NOTES_{LIMIT_DEFAULT,LIMIT_MAX,
 * READ_TOTAL_MAX_CHARS}/NOTE_SLUG_MAX_CHARS）+ NotesToolOptions/
 * NoteRecord/NoteListHeader 三类型——note_write/note_read 持久笔记对
 * （search_history 的主动保存族弟）。
/** Export names on the working-tree barrel, via the shared counter oracle. */

/** 125b 撞车吸收：canonical oracle 再生。127 项 1（continue_task 工具面）—
 *  534 = 510 + 24（tools/continue-task.ts 的导出：工具工厂 + baton 纯层 +
 *  常量 + 类型）。 */
const PINNED_COUNT = 639; // 长程弧 §1：工具自述渲染器 +4（TOOL_GUIDE_HEADING / ToolPromptEntry /
// collectToolPromptEntries / renderToolGuideSection）。前值 631：135 trace 投影层 +4（observeRun / createOtlpExporterFromEnv 两值 +
// ObserveRunOptions / OtlpExporter 两类型——其余投影/编码面走子路径 @wudao-org/core/trace，
// 不进 barrel：PB-1 探针先例，挂载件与内部机制不加宽公共面）。
// 前值 627：stop-tree 停止协调器 +6（2 值：StopCoordinator/MAX_STOP_TREE_DEPTH；4 类型：StopTreeEvent/StopTreePlan/
// StopTreeDispatchPort/PendingRequestKind——openwork opencode-interruption 的 wudao 移植弧），
// 同树并行吸收（census 撞车纪律，后到者吸收）：persistent-shell 面 +22（并行弧的 persistentShellRuntime 族），
// 前值 599（调研引入弧 B 缓存感知压缩调度 +13——其前的撞车吸收链：memory-store 面 +9、
// 弧 C 预算切片续跑面 +10、前值 567（133 #4 todo 生成器治理 +12）——全文见 git 历史）。
function listBarrelExports(): string[] {
  const out = execFileSync(process.execPath, [COUNTER, "--list", BARREL], { encoding: "utf8" });
  return out.split("\n").filter((line) => line.length > 0);
}

/** Parse the fixture: leading `#` lines are the header, the rest are names. */
function parseSnapshot(text: string): { header: string; names: string[] } {
  const lines = text.split("\n");
  const header = lines.filter((line) => line.startsWith("#")).join("\n");
  const names = lines.filter((line) => !line.startsWith("#")).map((line) => line.trim()).filter((line) => line.length > 0);
  return { header, names };
}

/** The actionable bidirectional mismatch report (snapshot = expected,
 *  barrel = actual):
 *    +added:   exports on the barrel but NOT pinned — the surface grew.
 *              Remove the export, or regenerate the fixture deliberately.
 *    -missing: pinned exports no longer on the barrel — the surface shrank.
 *              Restore the export, or regenerate the fixture deliberately. */
function buildSurfaceDiff(actual: readonly string[], pinned: readonly string[]): string {
  const actualSet = new Set(actual);
  const pinnedSet = new Set(pinned);
  const added = [...actualSet].filter((name) => !pinnedSet.has(name)).sort();
  const missing = [...pinnedSet].filter((name) => !actualSet.has(name)).sort();
  const list = (names: readonly string[]): string => (names.length > 0 ? names.map((n) => `  ${n}`).join("\n") : "  (none)");
  return [
    "barrel surface drifted from the pinned snapshot (packages/core/tests/fixtures/barrel-surface.txt)",
    "",
    `+added: exports on the barrel but NOT pinned (remove the export, or regenerate the fixture deliberately) [${added.length}]`,
    list(added),
    "",
    `-missing: pinned exports no longer on the barrel (restore the export, or regenerate the fixture deliberately) [${missing.length}]`,
    list(missing),
    "",
    "regen: node scripts/count-barrel-exports.mjs --snapshot packages/core/src/index.ts > packages/core/tests/fixtures/barrel-surface.txt",
  ].join("\n");
}

const fixture = readFileSync(SNAPSHOT, "utf8");
const { header, names: pinned } = parseSnapshot(fixture);

describe("ω99-96 barrel surface pin", () => {
  it("working-tree barrel export surface equals the pinned snapshot (exactly 349 names)", () => {
    const actual = listBarrelExports();
    expect(actual, `oracle returned duplicates:\n${actual.join("\n")}`).toEqual([...new Set(actual)]);
    // The diff-carrying equality goes FIRST so any drift reports the drifting
    // names (a length pre-check would shadow it — every drift changes length).
    expect([...actual].sort(), buildSurfaceDiff(actual, pinned)).toEqual([...pinned].sort());
    // Equal sets but a different size = the fixture was regenerated for a
    // deliberate surface change without bumping PINNED_COUNT. That bump, in
    // the same commit, is the pin's intended friction.
    expect(pinned, "fixture size !== PINNED_COUNT — deliberate surface change? update PINNED_COUNT together with the regenerated fixture").toHaveLength(PINNED_COUNT);
    expect(actual, "barrel size !== PINNED_COUNT — deliberate surface change? update PINNED_COUNT together with the regenerated fixture").toHaveLength(PINNED_COUNT);
  });

  it("mismatch report is bidirectional: +added and -missing sections each list their names", () => {
    // Known mutation, synthetic: the barrel grew A, the pin still holds D.
    // Both sections must appear with their own name lists — this is the
    // in-test self-proof of the report shape the pin failure relies on.
    const report = buildSurfaceDiff(["surfaceA", "kept1", "kept2"], ["kept1", "kept2", "staleD"]);
    expect(report).toContain("+added:");
    expect(report).toContain("  surfaceA");
    expect(report).toContain("-missing:");
    expect(report).toContain("  staleD");
  });
});

describe("ω99-96 snapshot hygiene", () => {
  it("fixture header carries the regeneration command", () => {
    expect(header).toContain("count-barrel-exports.mjs");
    expect(header).toContain("--snapshot packages/core/src/index.ts");
    expect(header).toContain("barrel-surface.txt");
  });

  it("fixture names are clean: identifiers only, no blanks, no duplicates", () => {
    for (const line of fixture.split("\n").filter((l) => !l.startsWith("#"))) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue; // trailing newline / spacer lines
      expect(trimmed, `non-identifier snapshot line: ${JSON.stringify(line)}`).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
    }
    expect(pinned, `duplicate names in snapshot: ${pinned.filter((n, i) => pinned.indexOf(n) !== i).join(", ")}`).toEqual([...new Set(pinned)]);
    expect(pinned).toHaveLength(PINNED_COUNT);
  });
});
