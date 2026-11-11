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
  "packages/evals/src/suites/deterministic.ts": 7947, // 2026-11-07 提示词弧收尾：det-25/det-38 钉子随 docs-only defer 与节清单同步（+9）。 // 名册数据表——注册表性质，独立拆分运动项。7902→7938=0.4.21 evals 三套件根治（det-25 第九期工具面随迁 + det-54 回滚环境包装的根因注释 +16）。7922=0.4.3 gate 随源演进（det-25 第八期 python_kernel 钉注 + det-41 model_change 轮询读——套件源自身的钉演进，非产品面增行）
  "packages/cli/src/driver/agent-driver.ts": 7557, // 7557=0.5.1 M85 小精灵弧：resetSessionKeepId 历史重置面 + configureModel 模型配置面（+75）。, // 2026-11-07 KV 缓存弧：driver 的 beforeModelCall 提前压缩同样接 headKeep（+9）。 // 2026-11-06 KV 缓存弧：replaceExtensions 增加 systemMessage 尾追加位（+5；提示词会话内冻结后，skills 等中途变化走持久化尾消息而不是重建前缀——该文件已有显式改帽先例）。0.4.21 长程弧无限切片：continuation.maxSlices + turnBudget 入 LoopOptions 透传（+18）。原注：7145→7450=0.4.20 gate 显式改帽（136-140 弧：流式思考落历史 / agent_root 落盘+恢复继承 / 探针 sessionId 接线 +78；此前 0.4.8 后的存量漂移未显式改帽，本次一并补帽—— 7103→7145=0.4.8 批（133 top1 缓存时钟 resume 挂载：mtime 时钟+registry 价+offer 协同预热跳过——纯决策层薄挂载）。 ω99-326a 已外提类型/纯函数；闭包体分解=后续子弧（326b+）。6765→7055=0.4.3 gate 随源演进（0.4.2 后长程弧批 +290）；拆分压力仍指向 326b+ 闭包体分解
  "packages/web/src/components/App.tsx": 3403, // 3403=0.5.1 M85：sb-f 退役后 onOpenSettings 摘除 + 工具栏 label 对（agent-root 同源）+ 归档刷新监听（+29）。, // 3305→3374=0.4.20 gate 显式改帽（139/140 仪表盘入口 + 会话解剖接线 +28； ω99-327a：app-consts/app-panels 外提 1242 行；组件闭包分解=后续子弧
  "packages/cli/src/repl.ts": 3027, // 0.4.21 长程弧：REPL 启用无限切片 continuation + tools 入提示词渲染（+4）。原注：2994→3023=0.4.20 gate 显式改帽（0.4.5 之后的存量漂移补帽； ω99 拆分运动 batch2：repl-commands.ts 外提 474 行。2971→2994=0.4.3 gate 随源演进（125 轮转接线补缝 + 长程弧零星中文警语行）
  "packages/core/src/loop.ts": 3988, // 3988=0.5.1 预算/检查点弧：taskWallBudget 提醒投影 + planCheckpoints 进度检查点 + windowSeq 提升（+31）。, // 2026-11-07 KV 缓存弧：tier-1 microcompact 接 planCompaction headKeep（+9）。 // 2026-11-06 压缩保留弧：tier-2 调用接 targetTokens（+3）。0.4.21 长程弧：无限切片进度刹车的 comparable 门（maxTurns=1 短窗不误杀）+24。原注：0.4.21 长程弧：切片边界 progress brake（sliceMadeProgress/resultFingerprint）+ 轮次水位线 note 发射（+47）。原注：3739→3878=0.4.20 gate 显式改帽（139/140 探针 sessionId 透传 +8； core 心脏——拆分=独立大弧，须跨切面 gate。3715→3739=0.4.8/0.4.9 批（133 #5 content_filter 分支+事件联合；133 #6 denied 旗两结算点+abort 旁支+三个中止点带终因）。3278→3715=0.4.3 gate 随源演进（0.4.2 后长程弧批 +437：124b 流抢占（settlePreemptedStream/归类面/MetaNote）、125 窗口身份链+WorldState 差分+new_context 即时轮转边界+预留感知触发、压缩摘要 rider 织入——各弧实现体外提在 compaction*/window-chain 等模块，loop 留缝与编排；拆分=独立大弧待立）
  "packages/cli/src/schedules.ts": 1373, // 1315→1373=131 弧 defer 闲时车道（idle 触发族+空闲资格 tick 分支+lastActivityAt seam+[闲时任务] 前缀+add 门归一化——排程域第五触发族） // 定时任务域（121/127 弧后入帽）：DurableTask 引擎+LaunchAgent 唤起+事件源+回执面；下一步拆分候选=引擎/事件/回执三件
  "packages/cli/src/driver/session-engine.ts": 1180, // 0.4.21 长程弧：web/pet 车道 maxSlices 接线（+3）。原注：1138→1177=0.4.20 gate 显式改帽（0.4.5 之后的存量漂移补帽； 1118→1138=123-2 read_session 台账读取缝。 会话引擎（多 driver 弧后入帽）：boot 记账/恢复重放/deferred bookkeeping；拆分候选=记账与重放两件
  "packages/cli/src/index.ts": 2402, // 2402=0.5.1 M85/预算通道：--task-budget/--plan-checkpoints 解析注入 + clock 条件常驻工具（+46）。, // 2350→2356=0.4.21 vitest 工人内 process.exit 守卫（m80 满载全绿退码 1 的根治，+6）。2316→2350=0.4.20 gate 显式改帽（0.4.5 之后的存量漂移补帽； 拆分 batch2 外提。2211→2311=0.4.3 gate 随源演进（125 new_context one-shot 接线（portBox/contextRotation 双达）+ 127 continue_task 注册 + 长程弧警语行——纯接线面）
  "packages/cli/src/tools.ts": 1169, // 0.4.21 TB2.1 取证：defer 判据补选择面宽度上限（EAGER_TOOL_COUNT_CEILING）（+12）。原注：0.4.21 TB2.1 取证：defer 候选集扩到全部大定义族 + 全工具集统一打标（+61）。原注：1047→1096=0.4.20 gate 显式改帽（0.4.5 之后的存量漂移补帽； 1018→1047=本批（123-3 critic 挂载+130-C1 稳定 ID 双形换算）。 131 弧入帽：defer 轮工具不可见律（WUDAO_DEFER_RUN 门控排程/交棒面挂载）；拆分候选=工具挂载分段
  "packages/cli/src/tui/app.tsx": 1011, // TUI 主面（长程弧后入帽，刚好过线）；拆分候选=渲染分层
  "packages/web/src/pet/pet.css": 1154, // 1154=0.5.1 M85 入白名单（存量债：0.4.x 时 ~950，越线发生在精灵工具栏弧——弹层/收窄/浏览行样式与既有宠物视觉语言同文件）。拆分候选=toolbar 样式外提；发版前不拆（纯 CSS 无逻辑，风险低）。
  "packages/web/src/protocol-core.ts": 1059, // 1059=0.5.1 M85：ClientOp 联合四 op + isRetryableMutation 镜像（+23）。, // 1008→1036=0.4.20 gate 显式改帽（139/140 协议面 probe/sessionAnatomy 方法 +12； web 协议核心（多 driver 弧后入帽，刚好过线）；拆分候选=消息/状态两域
  "apps/desktop/src-tauri/src/main.rs": 2552, // 2552=0.5.2 Windows 卡死根因修复：resolve_sidecar 补平铺资源候选 + 构建期模式标记判定 + 握手全程 boot.log（exe/resource_dir/pid/stderr 尾巴/超时归因）+ show_boot_error 整页退化 + USERPROFILE 兜底 + 回归钉（+120）。原注： // 0.4.21 宠物弧：compact 窗随肤 84→120 + 形象缩至 88（+15，5798aa95 已提交而帽未同步，本次补帽）。原注：2385→2417=0.4.20 gate 显式改帽（139 弧 boot_workspace_env + 探针常开 +32； 冻结区——触界需独立提交+用户肉眼验收。2343→2385=0.4.3 gate 随源演进（LaunchAgent 定时唤起 --schedule-wake 面 +42；仍属冻结区，下批审计）
  "packages/server/src/index.ts": 2117, // 2117=0.5.1 M85：pet 四 op 分发 + busy 稳定化 + 状态帧 workspace 对 + 帧链失败隔离（+154——分发面无纯函数可外提）。, // 1881→1963=0.4.20 gate 显式改帽（139/140 协议面 probeEnable/sessionAnatomy 分发 +17； 拆分运动 batch2：ports.ts 外提；1857→1859=UiDriverPort 等五名 re-export 门面 +2（cli 跨包 dist 类型链必需）。1859→1881=永续 v6 wave2 旗舰弧（reef C1 门控自改进）显式改帽：improvementFace 分发 case+形状门（+22）——纯分发面无纯函数可外提
  "packages/cli/src/driver/settings-ops.ts": 1696, // 1631→1696=0.4.20 gate 显式改帽（0.4.5 之后的存量漂移补帽； 1606→1631=0.4.3 gate 随源演进（122 LaunchAgent 弧：schedules.launchAgent 偏好开关面 +25——偏好页收益语行，纯接线）
  "packages/evals/src/suites/det-46-m62-config-economy.ts": 1077, // 2026-11-07 docs-only defer：断言从 task 换 make_docx（+7）。 // 名册套件族（同 deterministic 注记）
  "packages/cli/src/marketplace.ts": 1083, // 0.4.20 gate 入白名单（存量债：0.4.5 时 902 行，越线发生在 CCB 家族插件兼容层弧——插件安装/目录索引/清单三域同文件）。拆分弧候选=安装执行面与目录索引两件；本次发版不拆（拆分会动插件安装主路径，发布前风险高于收益），显式入册留债。
  "packages/web/src/protocol.ts": 1115, // 1115=0.5.1 M85：pet 四 op 客户端方法（+33）。, // 0.4.20 gate 入白名单（存量债：0.4.5 时 1000 行，恰在线上，越线发生在协议面加方法批次；139/140 探针+会话解剖方法再 +54）。拆分弧候选=探针/解剖两块方法面外提到 protocol-observability.ts。
  "packages/cli/src/driver/types.ts": 1046, // 0.4.21 长程弧：maxSlices 默认语义注释（+3）。原注：0.4.21 长程弧：MaxSlices 类型面（+9）。原注：0.4.20 gate 入白名单（存量债：0.4.5 时 998 行，越线发生在 driver 类型面加字段批次；138/140 的 bootRoot+SessionAnatomyResult 再 +13）。拆分弧候选=工作区根与监控两块类型外提。
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
