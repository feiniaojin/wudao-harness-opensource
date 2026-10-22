// ω99-324 文件行数规约（用户令 2026-09-14：「文件最大行数控制在 500 行左右，
// 硬性要求不超过 1000 行」）。机械执行=本 census；规约正文见 CONTRIBUTING.md。
//
// 纪律形状（棘轮）：
//   1. 白名单外任何 src 文件 > 1000 行 → 红（新增零宽限）。
//   2. 白名单内文件行数 > 记录帽 → 红（存量只收缩：拆分弧收尾时把帽改小或
//      删条目；确需加行的改动必须显式改帽并写明理由——把压力推向拆分）。
//   3. 白名单条目失效（文件 ≤1000 或已不存在）→ 红（拆分落地必须同步清条
//      目，防白名单变垃圾场）。
// 豁免注记：deterministic.ts=evals 名册数据表（注册表性质，独立运动项）；
// main.rs=冻结区（几何流触界需独立提交+用户肉眼验收双要件）。
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, extname, relative } from "node:path";

const REPO_ROOT = resolve(process.cwd(), "../..");
const HARD_CAP = 1000;
const SRC_EXT = new Set([".ts", ".tsx", ".css", ".rs"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "target", "bundle", "coverage"]);

/** 白名单：路径（仓相对）→ 行数帽（=收录时实测）。按行数降序。 */
const WHITELIST: Readonly<Record<string, number>> = {
  "packages/evals/src/suites/deterministic.ts": 7922, // 名册数据表——注册表性质，独立拆分运动项。7902→7922=0.4.3 gate 随源演进（det-25 第八期 python_kernel 钉注 + det-41 model_change 轮询读——套件源自身的钉演进，非产品面增行）
  "packages/cli/src/driver/agent-driver.ts": 7145, // 7103→7145=0.4.8 批（133 top1 缓存时钟 resume 挂载：mtime 时钟+registry 价+offer 协同预热跳过——纯决策层薄挂载）。 ω99-326a 已外提类型/纯函数；闭包体分解=后续子弧（326b+）。6765→7055=0.4.3 gate 随源演进（0.4.2 后长程弧批 +290）；拆分压力仍指向 326b+ 闭包体分解
  "packages/web/src/components/App.tsx": 3305, // ω99-327a：app-consts/app-panels 外提 1242 行；组件闭包分解=后续子弧
  "packages/cli/src/repl.ts": 2994, // ω99 拆分运动 batch2：repl-commands.ts 外提 474 行。2971→2994=0.4.3 gate 随源演进（125 轮转接线补缝 + 长程弧零星中文警语行）
  "packages/core/src/loop.ts": 3739, // core 心脏——拆分=独立大弧，须跨切面 gate。3715→3739=0.4.8/0.4.9 批（133 #5 content_filter 分支+事件联合；133 #6 denied 旗两结算点+abort 旁支+三个中止点带终因）。3278→3715=0.4.3 gate 随源演进（0.4.2 后长程弧批 +437：124b 流抢占（settlePreemptedStream/归类面/MetaNote）、125 窗口身份链+WorldState 差分+new_context 即时轮转边界+预留感知触发、压缩摘要 rider 织入——各弧实现体外提在 compaction*/window-chain 等模块，loop 留缝与编排；拆分=独立大弧待立）
  "packages/cli/src/schedules.ts": 1373, // 1315→1373=131 弧 defer 闲时车道（idle 触发族+空闲资格 tick 分支+lastActivityAt seam+[闲时任务] 前缀+add 门归一化——排程域第五触发族） // 定时任务域（121/127 弧后入帽）：DurableTask 引擎+LaunchAgent 唤起+事件源+回执面；下一步拆分候选=引擎/事件/回执三件
  "packages/cli/src/driver/session-engine.ts": 1138, // 1118→1138=123-2 read_session 台账读取缝。 会话引擎（多 driver 弧后入帽）：boot 记账/恢复重放/deferred bookkeeping；拆分候选=记账与重放两件
  "packages/cli/src/index.ts": 2316, // 拆分 batch2 外提。2211→2311=0.4.3 gate 随源演进（125 new_context one-shot 接线（portBox/contextRotation 双达）+ 127 continue_task 注册 + 长程弧警语行——纯接线面）
  "packages/cli/src/tools.ts": 1047, // 1018→1047=本批（123-3 critic 挂载+130-C1 稳定 ID 双形换算）。 131 弧入帽：defer 轮工具不可见律（WUDAO_DEFER_RUN 门控排程/交棒面挂载）；拆分候选=工具挂载分段
  "packages/cli/src/tui/app.tsx": 1011, // TUI 主面（长程弧后入帽，刚好过线）；拆分候选=渲染分层
  "packages/web/src/protocol-core.ts": 1008, // web 协议核心（多 driver 弧后入帽，刚好过线）；拆分候选=消息/状态两域
  "apps/desktop/src-tauri/src/main.rs": 2385, // 冻结区——触界需独立提交+用户肉眼验收。2343→2385=0.4.3 gate 随源演进（LaunchAgent 定时唤起 --schedule-wake 面 +42；仍属冻结区，下批审计）
  "packages/server/src/index.ts": 1881, // 拆分运动 batch2：ports.ts 外提；1857→1859=UiDriverPort 等五名 re-export 门面 +2（cli 跨包 dist 类型链必需）。1859→1881=永续 v6 wave2 旗舰弧（the upstream project C1 门控自改进）显式改帽：improvementFace 分发 case+形状门（+22）——纯分发面无纯函数可外提
  "packages/cli/src/driver/settings-ops.ts": 1631, // 1606→1631=0.4.3 gate 随源演进（122 LaunchAgent 弧：schedules.launchAgent 偏好开关面 +25——偏好页收益语行，纯接线）
  "packages/evals/src/suites/det-46-m62-config-economy.ts": 1070, // 名册套件族（同 deterministic 注记）
};

function walkSrc(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkSrc(full, out);
    } else if (st.isFile() && SRC_EXT.has(extname(name))) {
      // 只收「src/ 之下」的文件（apps 的 src-tauri/src 同构）。
      if (dir.split("/").some((seg) => seg === "src")) out.push(full);
    }
  }
  return out;
}

function lineCount(path: string): number {
  // 与 wc -l 同口径（换行符计数）——白名单帽按此口径收录。
  return (readFileSync(path, "utf8").match(/\n/g) ?? []).length;
}

describe("ω99-324 文件行数规约（目标 ~500 / 硬帽 1000；白名单棘轮）", () => {
  const files = [
    ...walkSrc(join(REPO_ROOT, "packages")),
    ...walkSrc(join(REPO_ROOT, "apps")),
  ].map((abs) => relative(REPO_ROOT, abs));

  it("白名单外零超限：任何 src 文件（ts/tsx/css/rs）不得超过 1000 行", () => {
    const offenders = files
      .filter((rel) => !(rel in WHITELIST))
      .map((rel) => ({ rel, n: lineCount(join(REPO_ROOT, rel)) }))
      .filter((f) => f.n > HARD_CAP)
      .sort((a, b) => b.n - a.n);
    expect(
      offenders.map((f) => `${f.rel}=${f.n}`),
      "超限且不在白名单——新文件零宽限；确属存量债请入白名单并写拆分弧注记",
    ).toEqual([]);
  });

  it("白名单棘轮：存量超限文件行数不得超过收录帽（拆分收尾改小帽/删条目）", () => {
    const grown = Object.entries(WHITELIST)
      .map(([rel, cap]) => ({ rel, cap, n: lineCount(join(REPO_ROOT, rel)) }))
      .filter((f) => f.n > f.cap)
      .sort((a, b) => b.n - a.n);
    expect(
      grown.map((f) => `${f.rel}: ${f.n} > 帽 ${f.cap}`),
      "白名单文件只许收缩——若确需加行，显式改帽并在弧记档写理由",
    ).toEqual([]);
  });

  it("白名单卫生：条目必须仍超限且存在（拆分落地同步清条目）", () => {
    const stale = Object.entries(WHITELIST).filter(([rel, cap]) => {
      try {
        return lineCount(join(REPO_ROOT, rel)) <= Math.min(HARD_CAP, cap);
      } catch {
        return true; // 文件已不存在（被拆掉）——条目必须删除
      }
    });
    expect(
      stale.map(([rel]) => rel),
      "白名单条目已不超限或不存在——拆分弧收尾时删掉它们",
    ).toEqual([]);
  });
});
