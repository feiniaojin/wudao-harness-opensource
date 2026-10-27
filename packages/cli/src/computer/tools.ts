// ω99-212: #2 — 电脑操作六工具面（buildTool fail-closed 默认；isReadOnly 按
// brief 面表；ask 姿态走 cli 权限层 DEFAULT_ASK_TOOLS——core 的
// PermissionDecision 表达不了 ask，同 browser_click 先例）。子进程全走注入缝
// （生产 defaultExecSeam；测试假件——绝不触真实键鼠/截屏）。
// ω99-220: #3 — 补两件基础手眼：computer_scroll（滚轮——读长文）+
// computer_drag（拖拽——文件挪窝/滑块/排序），六工具成八。两面沿 click 面
// 范式（helper 解析→缺席降级→AX 分类→code 透传），尾后 append-only 挂载
// （M24 前缀稳定：既有六面字节不动）。
//
// ω99-244: #2 — 坐标系闭环（弧 C）：capture 统一缩放+实测尺寸链（绝不假设
// 2x）→ 动作坐标按最近一次 capture 输出空间在 TS 侧换算（比例=屏幕点宽/截图
// 输出宽，含 DPR；模型永不知 DPR 存在）→ 截图史投影桩在 providers keep-K 窗
// 口（ω99-138 缝，K 2→3）。M24 声明：本弧改 click/scroll/drag 三面描述与坐
// 标参数描述（工具描述骑请求前缀）+ capture 回执加尺寸行（回执在消息尾，不
// 破前缀）——描述字节变更=跨版本一次缓存断裂（cold turn expected），会话内
// 字节冻结不变；无 capture 基准的会话坐标直通（现状语义零漂移）。
//
// 零删除面：八工具无任何文件删除通道（drag 是拖放语义，目标侧若为 Finder
// 的移动属用户可见的直接操作，与删除无涉）；剪贴板写入 v1 不做。
//
// ω99-250: #2 — computer_wait + 动作后 settle 验证行（弧 D）：六动作成功回
// 执在 241 状态行之后追加 settle 行（界面已变化/未变/未稳定/无树降级四态——
// 只报 observe 能证明的确定性事实，绝不报 verified/failed 语义结论）；新读面
// computer_wait(ref+value/title 谓词 | stable 稳定谓词, timeoutMs)。基线裁定：
// ref 动作用 observeState.lastObservation 当基线（press/settext 的 sha 守卫保证它就是动作
// 时刻的界面）；坐标/键盘/activate 路径动作前轻量采样一次（observeState.lastObservation
// 无守卫拴着、可能早已过期——用过期基线会把上一步的变化记到这一步头上）。
// 内部采样绝不改写 observeState.lastObservation（refs 属于用户自己的 observe——编号生命
// 周期零演进）。settle 采样失败 → 整行不附（241 状态行同款诚实缺席），绝不
// fail 动作本身。M24：名册尾后 append-only（既有九面字节零触碰）——跨版本
// 一次冷转（cold turn expected），会话内字节冻结。
//
// ω99-257: #4 — scroll/drag 补 ref 寻址（computer ref 面收口）：观察表元素行
// 自带 @cx,cy（元素中心，屏幕点）后，computer_scroll 增 ref（滚轮发生在该元
// 素中心——光标由 helper 的 at 形先移过去，「翻那个列表」一步直达，不再要求
// 先 click 移指针）、computer_drag 增 startRef/endRef（各自覆盖对应坐标对，
// 两端可混搭：startRef+endX/endY=「把元素拖到屏幕某处」）。口径分轨（本弧
// 主钉）：坐标路径=像素入/点出（captureScale 单源）；ref 路径=点直通——观察
// 表坐标天然是屏幕点，绝不经 captureScale 二次换算。旧版桌面 helper 观察表
// 无 @ 段：解析层旧形兼容（x/y undefined），ref 用于 scroll/drag 得 typed 出
// 路（升级指引）——两版本过渡零断崖。收据：ref 端点名 `[eN] 角色「标题」`
// （click 范式），坐标端照旧 (x, y) 形。M24 声明：scroll/drag 描述文本改+
// schema 加参数=工具列字节变更，跨版本一次冷转（cold turn expected），会话内
// 字节冻结；hashLine 无位置=click/type 的 ref 路径字节级零扰动（结构与位置
// 解耦——纯移动不作废编号；位置过时风险记弧报告诚实边界）。
import { truncateSafe } from "@wudao/core"; // 113-A4
import { buildTool } from "@wudao/core";
import type { Tool, ToolResult } from "@wudao/core";
import { readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  ACCESSIBILITY_GUIDE,
  CAPTURE_MAX_EDGE,
  OBSERVE_BLACKLIST_N,
  OBSERVE_BLACKLIST_TTL_MS,
  PERM_MARKER_ACCESSIBILITY,
  PERM_MARKER_SCREEN_RECORDING,
  SCREEN_RECORDING_GUIDE,
  SETTLE_SAMPLE_INTERVAL_MS,
  SETTLE_WINDOW_MS,
  WAIT_SAMPLE_INTERVAL_MS,
  WAIT_STABLE_SAMPLES,
  WAIT_TIMEOUT_DEFAULT_MS,
  WAIT_TIMEOUT_MAX_MS,
  buildActivateScript,
  buildDragArgs,
  buildKeyScript,
  buildListAppsScript,
  buildObserveArgs,
  buildPressArgs,
  buildScrollArgs,
  buildSettextArgs,
  buildTypeScript,
  captureTmpPath,
  classifyOsascriptFailure,
  chunkTypingText,
  defaultExecSeam,
  displayRole,
  fetchScreenPoints,
  fetchStatusLine,
  formatSettleLine,
  isBlankScreenshot,
  isEmptyObservation,
  matchWaitElement,
  observeContentDigest,
  observeElementDetail,
  observeRefs,
  parseObserveOutput,
  parseProcessList,
  readImageSize,
  resolveClickHelper,
  runHit,
  sanitizeAppName,
  sanitizeTypingText,
  validObserveRef,
  PROCESS_LIST_CAP,
  SCROLL_DELTA_MAX,
  type ExecSeam,
  type ObserveRefEntry,
  type ObserveTable,
  type ScreenPoint,
  type SettleOutcome,
} from "./exec.js";
import {
  buildWinActivateScript,
  buildWinClickScript,
  buildWinDragScript,
  buildWinKeyScript,
  buildWinListAppsScript,
  buildWinScrollScript,
  buildWinStatusScript,
  buildWinTypeScript,
  buildWinCaptureScript,
  formatWinStatusLine,
  parseWinAppList,
  parseWinCaptureSize,
  parseWinStatus,
  parseWinKeyCombo,
  psArgs,
  PS_BIN,
} from "./win32.js";

// ω99 拆分运动 弧 B：模块级 helper 族（ok/err、缝类型、osascript/win32 执行
// 层）外提至 tool-helpers.ts；此处 import 回用 + re-export 门面保公共面。
import {
  ok, err, NON_DARWIN, runOsascript, withStatus, validCoord, runWinPs, winStatusSuffix, WIN_NO_REF, nameRef,
} from "./tool-helpers.js";
import { createSettleEngine } from "./settle.js";
import { isStableIdRef, resolveStableId } from "./element-id.js";
import { createObserveTools } from "./observe-tools.js";
import type { ComputerVisionSeam, ComputerToolOptions } from "./tool-helpers.js";
export type { ComputerVisionSeam, ComputerToolOptions } from "./tool-helpers.js";

/** 十工具，固定序（screen_capture → computer_type → computer_key →
 *  computer_click → app_activate → app_list → computer_scroll →
 *  computer_drag → screen_observe → computer_wait——220 两员、247 观察员与
 *  250 等待员尾后 append-only，M24 前缀稳定）。 */
export function createComputerTools(opts: ComputerToolOptions = {}): Tool[] {
  const exec = opts.exec ?? defaultExecSeam();
  const platform = opts.platform ?? process.platform;
  const helperExists = opts.helperExists ?? existsSync;
  const env = opts.env ?? process.env;

  // ω99-244 — capture 坐标系基准（闭包态，随工具集=会话生命周期走；模块级
  // 状态会跨会话/跨测试泄漏，显式传参又要在全部调用位改签名——闭包是本文件
  // 既有缝的最小形）。每次成功 capture 用「实测输出尺寸 + 实测主屏点尺寸」
  // 整对覆写（换图后旧比例必错，绝不残留）；主屏查询失败 → 置 undefined
  //（无基准直通，不拿过期基准顶）。
  let lastCaptureBasis:
    | { readonly outW: number; readonly outH: number; readonly screenW: number; readonly screenH: number }
    | undefined;
  /** 当前坐标换算比=屏幕点宽/最近一次 capture 输出宽（纵横比缩放保比，宽高
   *  同比例——单一标量）；无基准 → 1（直通=现状语义）。 */
  const captureScale = (): number =>
    lastCaptureBasis === undefined ? 1 : lastCaptureBasis.screenW / lastCaptureBasis.outW;

  // ω99-247: #2 — 观察态（ref 生命周期）+ 窗口黑名单（闭包态随工具集=会话
  // 生命周期，与 lastCaptureBasis 同缝同律：非模块级防跨会话泄漏）。
  // observeState.lastObservation=最近一次成功观察：refs 只收「行幸存」的编号；**新观察
  // 整对覆写**——旧 ref 全作废（browser stale-ref 纪律：编号属于当次快照）。
  // sha256 随 press/settext 回传 helper 做 stale 守卫（同参重观察+比对，
  // fail-closed 在任何 AX 动作之前）。空观察也覆写（refs=空表——旧编号同
  // 样作废，ref 点选走 stale 错误给「重新 observe」出路）。
  // ω99 拆分运动 弧 B：观察态/黑名单态——单一 holder（外提前的两个 let）。
  const observeState: import("./observe-tools.js").ObserveState = {};
  /** 黑名单（单条 streak）：key=app 参数或 ""（前台）；连续空观察 N 次拉黑
   *  到 until；换 key 即重开（换窗/换 app 立刻可再试）；成功观察清零。 */

  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));

  // ω99 拆分运动 弧 B — settle/wait 采样层外提至 settle.ts（闭包体逐字保留；
  // observeState.lastObservation/observeState.emptyStreak 两个可变绑定留本闭包（单绑定），settle
  // 侧经 getter 只读线程）。
  const { observeBlacklisted, sampleObserve, settleBaseFromObservation, freshSettleBase, runSettle, withSettle } = createSettleEngine({
    exec,
    env,
    helperExists,
    execPath: opts.execPath,
    now,
    sleep,
    getLastObservation: () => observeState.lastObservation,
    getStreak: () => observeState.emptyStreak,
  });

  const screenCapture: Tool = buildTool({
    name: "screen_capture",
    description:
      "截取整个屏幕的画面并作为图片查看。用于「看看屏幕上现在是什么」：确认操作结果、找到要点击的位置（配合 computer_click 的坐标）、读取别的软件里模型 otherwise 看不到的内容。需要系统「屏幕录制」权限（首次使用会弹授权；被拒时会把引导给用户）。坐标点击前先截一张，点哪看哪。截图统一缩到长边不超过 1280，回执会标注尺寸——后续点击/滚动/拖拽的坐标都以这张图的像素为准，无需自行换算。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    // 读屏幕（无写入面）；但会看到用户全部屏幕内容——权限层按默认档走。
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    isOpenWorld: () => true,
    timeoutMs: 30_000,
    async execute(): Promise<ToolResult> {
      if (platform !== "darwin" && platform !== "win32") return err(NON_DARWIN("screen_capture", platform));
      const vision = opts.vision;
      // 缝缺席 / 主模型不吃图：截了也看不见——typed 拒（零截屏派生，不烧授权弹窗）。
      if (vision === undefined) {
        return err("screen_capture: 当前会话未接入图片附件链（截屏无法回传给模型）；请在桌面版或配置了视觉附件的会话中使用");
      }
      if (!vision.modelAcceptsImages()) {
        return err("screen_capture: 当前模型不接受图像输入，截屏对它不可见；先 /model 切换到支持视觉的模型再试");
      }
      const path = captureTmpPath();
      let bytes: Buffer;
      let outW = 0;
      let outH = 0;
      // win32：PowerShell CopyFromScreen（DPI 感知——物理像素坐标系，与
      // SendInput 输入面同基准）；一次出图+实测尺寸（超边在脚本内缩放），
      // P（物理）/F（终图）两行即 244 的坐标基准。
      let winBasis: { readonly physW: number; readonly physH: number } | undefined;
      if (platform === "win32") {
        const r = await exec(PS_BIN, psArgs(buildWinCaptureScript(path, CAPTURE_MAX_EDGE)));
        if (r.code !== 0) {
          await unlink(path).catch(() => {});
          return err(`screen_capture: 截屏命令失败（exit ${r.code}）：${truncateSafe(r.stderr.trim(), 400)}`);
        }
        const size = parseWinCaptureSize(r.stdout);
        if (size === undefined) {
          await unlink(path).catch(() => {});
          return err("screen_capture: 截屏输出缺尺寸行（P/F）——无法确定坐标系基准，本张不发送");
        }
        winBasis = { physW: size.physW, physH: size.physH };
        outW = size.outW;
        outH = size.outH;
        try {
          bytes = await readFile(path);
        } catch (e) {
          return err(`screen_capture: 读取截屏文件失败（${e instanceof Error ? e.message : String(e)}）`);
        } finally {
          await unlink(path).catch(() => {});
        }
        if (isBlankScreenshot(bytes)) {
          return err(`screen_capture: 截屏内容为空（${bytes.byteLength} 字节）——全黑/全纯色桌面也会触发本判据，确认屏幕确实有内容后重试。`);
        }
        let ref: { kind: "image"; attachmentId: string; mediaType: string; byteLength: number } | undefined;
        try {
          [ref] = await vision.store.saveImages([{ data: bytes.toString("base64"), mediaType: "image/png" }]);
        } catch (e) {
          return err(`screen_capture: 保存截图附件失败（${e instanceof Error ? e.message : String(e)}）`);
        }
        if (ref === undefined) return err("screen_capture: 附件库未受理本次截图（返回为空）");
        lastCaptureBasis = { outW, outH, screenW: winBasis.physW, screenH: winBasis.physH };
        const kb = (bytes.byteLength / 1024).toFixed(0);
        return {
          content: `已截取全屏（约 ${kb} KB），截图已附——请查看图片后决定下一步。\n尺寸：${outW}×${outH}（坐标以此图为准）`,
          images: [{ kind: "image" as const, ref }],
        };
      }
      const r = await exec("screencapture", ["-x", path]);
      if (r.code !== 0) {
        await unlink(path).catch(() => {});
        return err(`screen_capture: 截屏命令失败（exit ${r.code}）：${truncateSafe(r.stderr.trim(), 400)}`);
      }
      try {
        // ω99-244 — 规范分辨率链（实测尺寸=坐标系基准，绝不假设 2x）：
        // ① sips -g 实测原始尺寸 → ② 长边 >CAPTURE_MAX_EDGE 才 sips -Z 原地缩
        // （sips -Z 语义=最大边重采样到目标值且会放大小图——小图零缩放调用，
        // 防糊防浪费）→ ③ 再 sips -g 实测输出尺寸。任一步失败 → typed 拒：坐
        // 标系基准不可知的截图不发给模型——发了就是「模型量准也点不准」的旧
        // bug。全链在 try 内：任一 return 都走 finally 自清（删除面零新增）。
        const raw = await readImageSize(exec, path);
        if (raw === undefined) {
          return err("screen_capture: 读取截屏尺寸失败（sips -g pixelWidth/pixelHeight）——无法确定坐标系基准，本张不发送");
        }
        outW = raw.w;
        outH = raw.h;
        if (Math.max(raw.w, raw.h) > CAPTURE_MAX_EDGE) {
          const rz = await exec("sips", ["-Z", String(CAPTURE_MAX_EDGE), path]);
          if (rz.code !== 0) {
            return err(`screen_capture: 缩放截屏失败（sips -Z ${CAPTURE_MAX_EDGE}，exit ${rz.code}）：${truncateSafe(rz.stderr.trim(), 400)}`);
          }
          const out = await readImageSize(exec, path);
          if (out === undefined) {
            return err("screen_capture: 读取缩放后截屏尺寸失败（sips -g）——无法确定坐标系基准，本张不发送");
          }
          outW = out.w;
          outH = out.h;
        }
        bytes = await readFile(path);
      } catch (e) {
        return err(`screen_capture: 读取截屏文件失败（${e instanceof Error ? e.message : String(e)}）`);
      } finally {
        await unlink(path).catch(() => {}); // 自落自清（os.tmpdir 内）
      }
      if (isBlankScreenshot(bytes)) {
        return err(`screen_capture: ${PERM_MARKER_SCREEN_RECORDING} 截屏内容为空（${bytes.byteLength} 字节）。${SCREEN_RECORDING_GUIDE}`);
      }
      let ref: { kind: "image"; attachmentId: string; mediaType: string; byteLength: number } | undefined;
      try {
        [ref] = await vision.store.saveImages([{ data: bytes.toString("base64"), mediaType: "image/png" }]);
      } catch (e) {
        return err(`screen_capture: 保存截图附件失败（${e instanceof Error ? e.message : String(e)}）`);
      }
      if (ref === undefined) return err("screen_capture: 附件库未受理本次截图（返回为空）");
      // ω99-244 — 主屏点尺寸（换算比例的分子，JXA NSScreen）。查询失败 → 基准
      // 缺席（后续动作坐标直通），capture 照常成功：截图本身是有效产物，诚实
      // 降级不阻断；基准整对覆写——绝不残留上一张图的过期比例。
      const pts = await fetchScreenPoints(exec);
      lastCaptureBasis = pts === undefined ? undefined : { outW, outH, screenW: pts.w, screenH: pts.h };
      const kb = (bytes.byteLength / 1024).toFixed(0);
      return {
        content: `已截取全屏（约 ${kb} KB），截图已附——请查看图片后决定下一步。\n尺寸：${outW}×${outH}（坐标以此图为准）`,
        images: [{ kind: "image" as const, ref }],
      };
    },
  });

  const computerType: Tool = buildTool({
    name: "computer_type",
    description:
      "往输入框里打字（替用户输入文字，比如在 Excel 单元格、备忘录、聊天框里写字）。两条路：① ref 参数——按 screen_observe 元素表的 [eN] 编号直接写入该输入框，无需先聚焦；② 无 ref——写进当前焦点输入框（先确认目标已聚焦，必要时先 computer_click 点进去）。长文本会自动分块逐段输入、段间稍停，防止一次输入过长丢字。换行/Tab 不要塞进文本——用 computer_key 的 return/tab。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要输入的文字（不含换行/Tab；单次至多 2000 字符，超长请分多次调用）。" },
        ref: { type: "string", description: '目标输入框的编号（如 "e5"）——来自最近一次 screen_observe 的 [eN] 元素表；给出则直接写入该框（优先于焦点路径）。' },
      },
      required: ["text"],
      additionalProperties: false,
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    isOpenWorld: () => true,
    timeoutMs: 30_000,
    async execute(args): Promise<ToolResult> {
      if (platform === "win32") {
        if (args["ref"] !== undefined) return err(WIN_NO_REF("computer_type"));
        const clean = sanitizeTypingText(args["text"]);
        if (!clean.ok) return err(`computer_type: ${clean.error}`);
        const chunks = chunkTypingText(clean.text);
        const r = await runWinPs(exec, "computer_type", buildWinTypeScript(chunks));
        if (!r.ok) return err(r.error);
        const part = chunks.length > 1 ? `（长文已分 ${chunks.length} 块逐块输入）` : "";
        return ok(await winStatusSuffix(exec, `已在焦点处输入 ${Array.from(clean.text).length} 个字符${part}。`));
      }
      if (platform !== "darwin") return err(NON_DARWIN("computer_type", platform));
      const clean = sanitizeTypingText(args["text"]);
      if (!clean.ok) return err(`computer_type: ${clean.error}`);
      // ω99-247 — ref 路径（元素寻址优先）：AXValue 直写该编号的输入框；
      // 无 ref → 焦点 keystroke 路径字节不变（分块节奏是焦点路径的事——
      // 直写是一次性赋值，无需分块）。
      if (args["ref"] !== undefined) {
        // 130-C1 — ax: 稳定 ID 形先解析成当前表的 eN（元素在就命中；
        // 不在=元素不在当前观察——重观察出路同旧）。
        if (isStableIdRef(args["ref"])) {
          if (observeState.lastObservation === undefined) {
            return err("computer_type: No observation yet — call screen_observe first: its element table is this tool's ref source.");
          }
          const resolved = resolveStableId(args["ref"] as string, observeState.lastObservation.refs);
          if (resolved === undefined) {
            return err(`computer_type: Stable ID ${String(args["ref"])} 不在当前观察里（元素可能已不在界面）——重新 screen_observe 取新表。`);
          }
          (args as { ref?: string }).ref = resolved;
        }
        if (!validObserveRef(args["ref"])) {
          return err(`computer_type: "ref" must look like "e1", "e2", or an @ax: stable ID (from screen_observe's table); got ${JSON.stringify(args["ref"])}`);
        }
        const ref = args["ref"] as string;
        if (observeState.lastObservation === undefined) {
          return err("computer_type: No observation yet — call screen_observe first: its [eN] element table is this tool's ref source.");
        }
        const entry = observeState.lastObservation.refs.get(ref);
        if (entry === undefined) {
          return err(`computer_type: Ref ${ref} is not in the current observation (the window may have changed since screen_observe ran) — call screen_observe again for fresh refs.`);
        }
        const helper = resolveClickHelper(env, helperExists, opts.execPath);
        if (helper === undefined) {
          return err(
            "computer_type: 输入助手不在场（wudao-click 未找到）。桌面版重新安装/升级即可带上；自托管会话请把编译好的 wudao-click 路径写进环境变量 WUDAO_CLICK_HELPER（或放在 wudao 可执行文件同目录）。本工具不会在没有助手的情况下模拟输入。",
          );
        }
        const built = buildSettextArgs(ref, clean.text, observeState.lastObservation.sha256, observeState.lastObservation.appParam);
        if (!built.ok) return err(`computer_type: ${built.error}`);
        const settleBase = settleBaseFromObservation(); // sha 守卫拴着=动作时刻界面
        const r = await exec(helper, built.args);
        if (r.code === 2 || r.stdout.includes("WUDAO_AX_UNTRUSTED")) {
          return err(`computer_type: ${PERM_MARKER_ACCESSIBILITY} 输入助手没有「辅助功能」权限，写入被系统拒绝。${ACCESSIBILITY_GUIDE}`);
        }
        if (r.code === 6) {
          return err("computer_type: The observation is stale — the window's element tree changed after screen_observe. Call screen_observe again and use the fresh refs.");
        }
        if (r.code === 8) {
          return err("computer_type: 该元素不接受直接输入（辅助功能未接受文本写入）——换一个编号，或先用 computer_click 点进输入框再无 ref 输入。");
        }
        if (r.code !== 0) {
          return err(`computer_type: 输入助手执行失败（exit ${r.code}）：${truncateSafe((r.stderr || r.stdout).trim(), 400)}`);
        }
        const named = `[${ref}] ${displayRole(entry.role)}${entry.title !== "" ? `「${entry.title}」` : ""}`;
        return ok(await withSettle(await withStatus(exec, `已在 ${named}输入 ${Array.from(clean.text).length} 个字符。`), settleBase));
      }
      const settleBase = await freshSettleBase();
      const chunks = chunkTypingText(clean.text);
      const r = await runOsascript(exec, "computer_type", buildTypeScript(clean.text));
      if (r.isError === true) return r;
      const part = chunks.length > 1 ? `（长文已分 ${chunks.length} 块逐块输入）` : "";
      return ok(await withSettle(await withStatus(exec, `已在焦点处输入 ${Array.from(clean.text).length} 个字符${part}。`), settleBase));
    },
  });

  const computerKey: Tool = buildTool({
    name: "computer_key",
    description:
      "按一个键或组合键（回车、Tab、删除、方向键、cmd+c / cmd+shift+t 等）。可按键：字母 a-z、数字 0-9、return/tab/space/delete/forwarddelete/escape、上下左右方向键、home/end/pageup/pagedown、f1-f12；修饰键 cmd/ctrl/alt/shift 可组合。白名单之外的键名会被拒绝。",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: '键名，如 "return"、"tab"、"cmd+c"、"shift+cmd+t"、"up"。' },
      },
      required: ["key"],
      additionalProperties: false,
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    isOpenWorld: () => true,
    timeoutMs: 30_000,
    async execute(args): Promise<ToolResult> {
      if (platform === "win32") {
        const parsed = parseWinKeyCombo(args["key"]);
        if (!parsed.ok) return err(`computer_key: ${parsed.error}`);
        const r = await runWinPs(exec, "computer_key", buildWinKeyScript(parsed.combo));
        if (!r.ok) return err(r.error);
        const shown = typeof args["key"] === "string" ? args["key"] : String(args["key"]);
        return ok(await winStatusSuffix(exec, `已按下 ${shown}。`));
      }
      if (platform !== "darwin") return err(NON_DARWIN("computer_key", platform));
      const built = buildKeyScript(args["key"]);
      if (!built.ok) return err(`computer_key: ${built.error}`);
      const settleBase = await freshSettleBase();
      const r = await runOsascript(exec, "computer_key", built.script);
      if (r.isError === true) return r;
      const shown = typeof args["key"] === "string" ? args["key"] : String(args["key"]);
      return ok(await withSettle(await withStatus(exec, `已按下 ${shown}。`), settleBase));
    },
  });

  const computerClick: Tool = buildTool({
    name: "computer_click",
    description:
      "点击屏幕上的一个元素或位置。两条路：① ref 参数——按 screen_observe 元素表的 [eN] 编号直达（优先，更快更准，不受分辨率影响）；② 坐标 (x, y)——最近一次 screen_capture 输出图的像素空间，截图上量到哪里就填哪里，系统会自动换算到实际屏幕，不要自行按比例折算（ref 与坐标同给时按 ref 点选、坐标忽略）。先 screen_observe 看元素表或 screen_capture 看屏幕再点。左键单击为默认；button:\"right\" 出右键菜单，double:true 双击。按 ref 单击时，点完会自动核对落点上实际是什么元素并把结论写进回执（已确认/与预期不符/未命中），不必再截一张图确认有没有点中；按坐标单击时，回执同样会写明落点处是什么元素；双击/右键不回报落点。",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: '要点的元素编号（如 "e3"）——来自最近一次 screen_observe 的 [eN] 元素表；编号在下一次 screen_observe 前有效。' },
        x: { type: "number", description: "横坐标（像素，非负整数）——最近一次 screen_capture 输出图上的位置（ref 缺席时必填）。" },
        y: { type: "number", description: "纵坐标（像素，非负整数）——最近一次 screen_capture 输出图上的位置（ref 缺席时必填）。" },
        button: { type: "string", description: "left（默认）或 right（右键/上下文菜单）。", enum: ["left", "right"] },
        double: { type: "boolean", description: "true = 双击（打开文件、选中文本等）。" },
      },
      additionalProperties: false,
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    isOpenWorld: () => true,
    timeoutMs: 30_000,
    async execute(args): Promise<ToolResult> {
      if (platform === "win32") {
        if (args["ref"] !== undefined) return err(WIN_NO_REF("computer_click"));
        const x = args["x"];
        const y = args["y"];
        if (!validCoord(x) || !validCoord(y)) {
          return err('computer_click: needs "x"/"y" non-negative integers (screen pixels from screen_capture\'s image)');
        }
        const button = args["button"] === undefined ? "left" : args["button"];
        if (button !== "left" && button !== "right") {
          return err('computer_click: "button" must be "left" (default) or "right"');
        }
        const dbl = args["double"] === undefined ? false : args["double"];
        if (typeof dbl !== "boolean") {
          return err('computer_click: "double" must be a boolean');
        }
        // 坐标换算与 mac 同律（244）：模型给的是最近一张 capture 图上的像素。
        const px = Math.round(x * captureScale());
        const py = Math.round(y * captureScale());
        const r = await runWinPs(exec, "computer_click", buildWinClickScript(px, py, button, dbl));
        if (!r.ok) return err(r.error);
        const how = button === "right" ? "右键" : dbl === true ? "双击" : "左键";
        return ok(await winStatusSuffix(exec, `已在 (${x}, ${y}) ${how}点击。`));
      }
      if (platform !== "darwin") return err(NON_DARWIN("computer_click", platform));
      // ω99-247 — ref 路径（元素寻址优先）：AXPress 直达，坐标兜底语义保持
      // （无 ref → 244 坐标换算路径字节不变）。ref 与坐标同给 → ref 优先、
      // 回执声明坐标已忽略（裁定钉进测试）。
      if (args["ref"] !== undefined) {
        // 130-C1 — ax: 稳定 ID 形先解析成当前表的 eN。
        if (isStableIdRef(args["ref"])) {
          if (observeState.lastObservation === undefined) {
            return err("computer_click: No observation yet — call screen_observe first.");
          }
          const resolved = resolveStableId(args["ref"] as string, observeState.lastObservation.refs);
          if (resolved === undefined) {
            return err(`computer_click: Stable ID ${String(args["ref"])} 不在当前观察里（元素可能已不在界面）——重新 screen_observe 取新表。`);
          }
          (args as { ref?: string }).ref = resolved;
        }
        if (!validObserveRef(args["ref"])) {
          return err(`computer_click: "ref" must look like "e1", "e2", or an @ax: stable ID; got ${JSON.stringify(args["ref"])}`);
        }
        const ref = args["ref"] as string;
        if (observeState.lastObservation === undefined) {
          return err("computer_click: No observation yet — call screen_observe first: its [eN] element table is this tool's ref source.");
        }
        const entry = observeState.lastObservation.refs.get(ref);
        if (entry === undefined) {
          return err(`computer_click: Ref ${ref} is not in the current observation (the window may have changed since screen_observe ran) — call screen_observe again for fresh refs.`);
        }
        const helper = resolveClickHelper(env, helperExists, opts.execPath);
        if (helper === undefined) {
          return err(
            "computer_click: 点击助手不在场（wudao-click 未找到）。桌面版重新安装/升级即可带上；自托管会话请把编译好的 wudao-click 路径写进环境变量 WUDAO_CLICK_HELPER（或放在 wudao 可执行文件同目录）。本工具不会在没有助手的情况下模拟点击。",
          );
        }
        const built = buildPressArgs(ref, observeState.lastObservation.sha256, observeState.lastObservation.appParam);
        if (!built.ok) return err(`computer_click: ${built.error}`);
        const settleBase = settleBaseFromObservation(); // sha 守卫拴着=动作时刻界面
        const r = await exec(helper, built.args);
        if (r.code === 2 || r.stdout.includes("WUDAO_AX_UNTRUSTED")) {
          return err(`computer_click: ${PERM_MARKER_ACCESSIBILITY} 点击助手没有「辅助功能」权限，事件被系统丢弃。${ACCESSIBILITY_GUIDE}`);
        }
        if (r.code === 6) {
          return err("computer_click: The observation is stale — the window's element tree changed after screen_observe. Call screen_observe again and use the fresh refs.");
        }
        if (r.code === 8) {
          return err("computer_click: 该元素不支持点按（辅助功能未提供点按动作）——换一个编号，或改用坐标/键盘路径。");
        }
        if (r.code !== 0) {
          return err(`computer_click: 点击助手执行失败（exit ${r.code}）：${truncateSafe((r.stderr || r.stdout).trim(), 400)}`);
        }
        // 回执点名 role/title（241 displayRole 中文角色），绝不回显 value——
        // 安全纪律的回执层（dsh 有 secure 处理，我方再加回执层纪律）。
        const named = `[${ref}] ${displayRole(entry.role)}${entry.title !== "" ? `「${entry.title}」` : ""}`;
        const both = args["x"] !== undefined || args["y"] !== undefined ? "（按 ref 点选；同时提供的坐标已忽略）" : "";
        const receipt = await withSettle(await withStatus(exec, `已点按 ${named}${both}。`), settleBase);
        // ω99-262: #1 — click ref 路径命中验证（「点 e7」回执闭环）：settle
        // 完成后在元素中心做一次只读 AX 命中（261 落地的 hit 缝原样复用——
        // helper hit 子命令/exec parseHitLine+runHit/withLandingHit 零改动），
        // 与 ref 解析时的身份快照按 role+title 比对（四态与 drag 终点同族，
        // 验证行绝不印 [eN] 编号；hit 点=entry 屏幕点原值直通，绝不经
        // captureScale——257 口径分轨）。三道闸（裁定）：①双击/右键变体零验
        // 证——右键菜单恰在光标处弹出、双击常激活落点元素，post-click hit
        // 恒读瞬时遮罩/新态=系统性假警报，磨损验证行可信度（产品裁定非缺
        // 陷）；②观察表无位置（旧版观察形）→ 静默降级——AXPress 不需要位
        // 置、只有验证需要（scroll/drag 的 typed 出路不适用），回执保持现行
        // 形零断崖；③坐标路径（②路）零验证——无预期身份可比对（261 同
        // 裁定）。
        const variant = args["button"] === "right" || args["double"] === true;
        const at = entry.x !== undefined && entry.y !== undefined ? { x: entry.x, y: entry.y } : undefined;
        if (variant || at === undefined) return ok(receipt); // 变体/无位置=零验证行（诚实缺席）
        return ok(await withLandingHit(receipt, at, entry));
      }
      // 校验先于副作用（fail-closed）：坐标非法零派生；ref/坐标双缺席零派生。
      if (args["x"] === undefined && args["y"] === undefined) {
        return err('computer_click: needs either "ref" (from screen_observe) or "x"/"y" coordinates (from screen_capture)');
      }
      const x = args["x"];
      const y = args["y"];
      if (!validCoord(x) || !validCoord(y)) {
        return err(`computer_click: "x"/"y" must be non-negative integers (screen pixels from screen_capture's image); got x=${JSON.stringify(x)}, y=${JSON.stringify(y)}`);
      }
      const button = args["button"];
      if (button !== undefined && button !== "left" && button !== "right") {
        return err('computer_click: "button" must be "left" (default) or "right"');
      }
      const dbl = args["double"];
      if (dbl !== undefined && typeof dbl !== "boolean") {
        return err('computer_click: "double" must be a boolean');
      }
      const helper = resolveClickHelper(env, helperExists, opts.execPath);
      if (helper === undefined) {
        return err(
          "computer_click: 点击助手不在场（wudao-click 未找到）。桌面版重新安装/升级即可带上；自托管会话请把编译好的 wudao-click 路径写进环境变量 WUDAO_CLICK_HELPER（或放在 wudao 可执行文件同目录）。本工具不会在没有助手的情况下模拟点击。",
        );
      }
      // ω99-244 — 有 capture 基准 → 坐标从「最近一次输出图」像素空间换算到屏
      // 幕点空间后才进 helper（模型永不知 DPR）；无基准 → 直通（现状语义）。
      // 回执照报模型坐标（图像空间）——换算不进文案。
      const scale = captureScale();
      // px/py=换算后的屏幕点（helper argv 与 265 的 hit 落点同源——click 发生
      // 在哪 hit 就问哪）。
      const px = Math.round(x * scale);
      const py = Math.round(y * scale);
      const helperArgs = [String(px), String(py)];
      if (button === "right") helperArgs.push("right");
      if (dbl === true) helperArgs.push("double");
      const settleBase = await freshSettleBase(); // 动作前轻量基线（无守卫拴 observeState.lastObservation）
      const r = await exec(helper, helperArgs);
      if (r.code === 2 || r.stdout.includes("WUDAO_AX_UNTRUSTED")) {
        return err(`computer_click: ${PERM_MARKER_ACCESSIBILITY} 点击助手没有「辅助功能」权限，事件被系统丢弃。${ACCESSIBILITY_GUIDE}`);
      }
      if (r.code !== 0) {
        return err(`computer_click: 点击助手执行失败（exit ${r.code}）：${truncateSafe((r.stderr || r.stdout).trim(), 400)}`);
      }
      const how = button === "right" ? "右键" : dbl === true ? "双击" : "左键";
      const receipt = await withSettle(await withStatus(exec, `已在 (${x}, ${y}) ${how}点击。`), settleBase);
      // ω99-265: #1 — 坐标路径落点身份信息行：settle 完成后在换算点做一次只
      // 读 AX 命中（withLandingHit 的 expect 缺席=信息形——模型给的是位置不
      // 是 ref，无预期身份可比对，读到什么报什么，无匹配/不符态：hit→「落点
      // 是X。」/miss→「落点处未命中元素。」/读不到=静默零行）。点完立刻知道
      // 点中了什么，自证成本从再截一张图降为读一行。变体闸镜像 262：右键菜单
      // 恰在光标处弹出、双击常激活落点元素——读到遮罩物=噪音非信息，零信息行。
      if (button === "right" || dbl === true) return ok(receipt);
      return ok(await withLandingHit(receipt, { x: px, y: py }));
    },
  });

  const appActivate: Tool = buildTool({
    name: "app_activate",
    description:
      "切换到（并前置）某个已安装的应用——比如替用户打开计算器、把访达调到最前。按应用名（\"计算器\"/\"Safari\"）或 bundle id（\"com.apple.Calculator\"）都行；不确定应用叫什么名时先用 app_list 看当前打开的，或用名字试。",
    parameters: {
      type: "object",
      properties: {
        app: { type: "string", description: '应用名（"访达"/"Safari"）或 bundle id（"com.apple.Calculator"）。' },
      },
      required: ["app"],
      additionalProperties: false,
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    isOpenWorld: () => true,
    timeoutMs: 30_000,
    async execute(args): Promise<ToolResult> {
      if (platform === "win32") {
        const clean = sanitizeAppName(args["app"]);
        if (!clean.ok) return err(`app_activate: ${clean.error}`);
        const r = await exec(PS_BIN, psArgs(buildWinActivateScript(clean.text)));
        if (r.code === 3) {
          return err(`app_activate: 没有找到带窗口的正在运行应用「${clean.text}」——用 app_list 查看当前可用名后重试。`);
        }
        if (r.code !== 0) {
          return err(`app_activate: PowerShell 执行失败（exit ${r.code}）：${truncateSafe(r.stderr.trim(), 400)}`);
        }
        return ok(await winStatusSuffix(exec, `已切换到 ${clean.text}。`));
      }
      if (platform !== "darwin") return err(NON_DARWIN("app_activate", platform));
      const clean = sanitizeAppName(args["app"]);
      if (!clean.ok) return err(`app_activate: ${clean.error}`);
      const built = buildActivateScript(clean.text);
      if (!built.ok) return err(`app_activate: ${built.error}`);
      // 基线=切换前的前台（activate 的效果恰是换前台——前后对比即验证）。
      const settleBase = await freshSettleBase();
      const r = await runOsascript(exec, "app_activate", built.script);
      if (r.isError === true) return r;
      return ok(await withSettle(await withStatus(exec, `已切换到 ${clean.text}。`), settleBase));
    },
  });

  const appList: Tool = buildTool({
    name: "app_list",
    description:
      "列出当前打开着窗口的应用名（不含纯后台进程）。想知道「现在屏幕上有什么软件」、确认 app_activate 该用哪个名字时先调这个。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    isOpenWorld: () => true,
    timeoutMs: 30_000,
    async execute(): Promise<ToolResult> {
      if (platform === "win32") {
        const r = await runWinPs(exec, "app_list", buildWinListAppsScript(PROCESS_LIST_CAP));
        if (!r.ok) return err(r.error);
        const names = parseWinAppList(r.stdout);
        if (names.length === 0) return ok("当前没有打开着窗口的应用。");
        return ok(`当前打开的应用（${names.length} 个）：${names.join("、")}`);
      }
      if (platform !== "darwin") return err(NON_DARWIN("app_list", platform));
      const r = await exec("osascript", ["-e", buildListAppsScript()]);
      if (r.code !== 0) {
        const kind = classifyOsascriptFailure(r.stderr);
        if (kind === "accessibility") {
          return err(`app_list: ${PERM_MARKER_ACCESSIBILITY} 读取进程清单被系统拒绝（osascript 错误 -1743）。${ACCESSIBILITY_GUIDE}`);
        }
        return err(`app_list: osascript 执行失败（exit ${r.code}）：${truncateSafe(r.stderr.trim(), 400)}`);
      }
      const names = parseProcessList(r.stdout);
      if (names.length === 0) return ok("当前没有打开着窗口的应用。");
      return ok(`当前打开的应用（${names.length} 个）：${names.join("、")}`);
    },
  });

  // —— ω99-220 尾后两员（scroll / drag），沿 click 面骨架逐字 ——


  const computerScroll: Tool = buildTool({
    name: "computer_scroll",
    description:
      "滚动鼠标滚轮——把屏幕上的长页面/长列表往下（或往上）翻，用来读超出首屏的内容。两条路：① ref 参数——按 screen_observe 元素表的 [eN] 编号直达（滚轮直接发生在该元素中心，无需先把鼠标移过去，「翻那个列表」一步到位）；② 无 ref——滚动发生在「当前鼠标指针所在的窗口」：先用 computer_click 把光标点到目标窗口里再滚。dy 正数=往下滚（继续往后读）、负数=往上（回页首）；dx 可选，正数=向右、负数=向左（横向内容）。距离量纲 = 最近一次 screen_capture 输出图的像素空间（系统自动换算，不要自行按比例折算）。量纲参考：一屏约 800-1000 像素，单次 200-600 像素较稳，读长文可连续多次调用。给 ref 时，滚完回执也会写明滚轮实际作用在什么元素上，滚错地方一眼可辨。",
    parameters: {
      type: "object",
      properties: {
        dy: { type: "number", description: "垂直滚动像素：正=往下（去页尾）、负=往上（回页首）。必填且与 dx 至少一个非零。" },
        dx: { type: "number", description: "水平滚动像素（可选）：正=向右、负=向左。" },
        ref: { type: "string", description: '要滚动的列表/元素编号（如 "e5"）——来自最近一次 screen_observe 的 [eN] 元素表；给出则滚轮发生在该元素中心。' },
      },
      required: ["dy"],
      additionalProperties: false,
    },
    // 只改视口不碰数据；但作用于用户机器上的活动窗口——权限层按默认档走。
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    isOpenWorld: () => true,
    timeoutMs: 30_000,
    async execute(args): Promise<ToolResult> {
      if (platform === "win32") {
        // 校验同 mac 律（有限数、±10000 封顶）；win32 只吃纵向滚轮。
        const dx = args["dx"];
        const dy = args["dy"];
        const bad = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
        if (!bad(dx) || !bad(dy) || Math.abs(dx) > SCROLL_DELTA_MAX || Math.abs(dy) > SCROLL_DELTA_MAX) {
          return err(`computer_scroll: "dx"/"dy" must be finite numbers within ±${SCROLL_DELTA_MAX}`);
        }
        if (dy === 0) return err("computer_scroll: dx/dy 至少一个非零（win32 只支持纵向滚动）");
        const r = await runWinPs(exec, "computer_scroll", buildWinScrollScript(dy));
        if (!r.ok) return err(r.error);
        const dir = dy > 0 ? "向下" : "向上";
        const ignored = dx !== 0 ? `；横向 dx=${dx} 在 Windows 上暂不支持，已忽略` : "";
        return ok(await winStatusSuffix(exec, `已${dir}滚动 ${Math.abs(dy)} 格${ignored}。`));
      }
      if (platform !== "darwin") return err(NON_DARWIN("computer_scroll", platform));
      // ref 路径（元素寻址优先）：滚轮发生在该元素中心（helper 的 at 形先把
      // 光标移过去再发滚轮）；坐标=观察表 @cx,cy 屏幕点原值，**绕过
      // captureScale**（观察表坐标天然是屏幕点，双重换算=口径陷阱）。无 ref
      // 路径字节不变（指针位置语义+换算照旧）。ref 解析沿 click 骨架：形校验
      // → 观察在场 → 表内命中（缺席=stale 文案）→ 位置在场（旧 helper 观察
      // 行无 @ 段 → typed 出路，绝不编造坐标）。
      let at: ScreenPoint | undefined;
      let named: string | undefined;
      if (args["ref"] !== undefined) {
        // 130-C1 — ax: 稳定 ID 形先解析成当前表的 eN。
        if (isStableIdRef(args["ref"])) {
          if (observeState.lastObservation === undefined) {
            return err("computer_scroll: No observation yet — call screen_observe first.");
          }
          const resolved = resolveStableId(args["ref"] as string, observeState.lastObservation.refs);
          if (resolved === undefined) {
            return err(`computer_scroll: Stable ID ${String(args["ref"])} 不在当前观察里（元素可能已不在界面）——重新 screen_observe 取新表。`);
          }
          (args as { ref?: string }).ref = resolved;
        }
        if (!validObserveRef(args["ref"])) {
          return err(`computer_scroll: "ref" must look like "e1", "e2", or an @ax: stable ID; got ${JSON.stringify(args["ref"])}`);
        }
        const ref = args["ref"] as string;
        if (observeState.lastObservation === undefined) {
          return err("computer_scroll: No observation yet — call screen_observe first: its [eN] element table is this tool's ref source.");
        }
        const entry = observeState.lastObservation.refs.get(ref);
        if (entry === undefined) {
          return err(`computer_scroll: Ref ${ref} is not in the current observation (the window may have changed since screen_observe ran) — call screen_observe again for fresh refs.`);
        }
        if (entry.x === undefined || entry.y === undefined) {
          return err(`computer_scroll: [${ref}] 该元素的位置信息不在观察表里（旧版桌面助手的观察不带位置）——用坐标路径，或升级桌面版后重新 screen_observe。`);
        }
        at = { x: entry.x, y: entry.y };
        named = nameRef(ref, entry.role, entry.title);
      }
      // 校验先于副作用（fail-closed）：增量非法零派生。ω99-244——有 capture
      // 基准时增量随坐标同换算（守卫收模型值、argv 出屏幕点值，exec.ts 单源）。
      const built = buildScrollArgs(args["dx"], args["dy"], captureScale(), at);
      if (!built.ok) return err(`computer_scroll: ${built.error}`);
      const helper = resolveClickHelper(env, helperExists, opts.execPath);
      if (helper === undefined) {
        return err(
          "computer_scroll: 滚动助手不在场（wudao-click 未找到）。桌面版重新安装/升级即可带上；自托管会话请把编译好的 wudao-click 路径写进环境变量 WUDAO_CLICK_HELPER（或放在 wudao 可执行文件同目录）。本工具不会在没有助手的情况下模拟滚动。",
        );
      }
      // settle 基线=动作前轻量采样（ref 路径与坐标路径同律：scroll 的 helper
      // 动作不带 sha 守卫，observeState.lastObservation 无守卫拴着——250 的非 ref 路径裁定）。
      const settleBase = await freshSettleBase();
      const r = await exec(helper, built.args);
      if (r.code === 2 || r.stdout.includes("WUDAO_AX_UNTRUSTED")) {
        return err(`computer_scroll: ${PERM_MARKER_ACCESSIBILITY} 滚动助手没有「辅助功能」权限，事件被系统丢弃。${ACCESSIBILITY_GUIDE}`);
      }
      if (r.code !== 0) {
        return err(`computer_scroll: 滚动助手执行失败（exit ${r.code}）：${truncateSafe((r.stderr || r.stdout).trim(), 400)}`);
      }
      // 收据：ref 端点名 `[eN] 角色「标题」`（click 范式）；无 ref 照旧方向+像素量。
      const part = scrollReceipt(args["dy"] as number, args["dx"] as number | undefined);
      const receipt = named === undefined ? `已${part}。` : `已在 ${named}${part}。`;
      const done = await withSettle(await withStatus(exec, receipt), settleBase);
      // ω99-266: #1 — scroll ref 路径落点身份信息行（hit 缝第四消费：261 drag
      // →262 click ref→265 坐标→266 scroll ref）：settle 完成后在 at 屏幕点原
      // 值做一次只读 AX 命中，withLandingHit 的 expect 缺席=信息形——滚动必使
      // 内容位移，落点恒非原元素=系统性假警报，**验证形对 scroll 结构性不成
      // 立**（裁定记档：读到什么报什么恰好绕开此关，描述句亦不得暗示「验
      // 证」）；hit 点=at 原值直通（与 265 坐标路径的换算点不同——scroll 本身
      // 不换算，观察表 @cx,cy 天然屏幕点）；无 ref 路径零改动（指针位置语义
      // 无点位，零信息行——裁定）；scroll 无变体参数，无 262 式变体闸。
      return ok(at === undefined ? done : await withLandingHit(done, at));
    },
  });

  // ω99-261: #3 — 落点命中验证共享缝（drag 终点首发；262 起 click ref 路径
  // 同缝消费——两个调用点都在 settle 之后）：settle 完成后在落点做
  // 一次只读 AX 命中（helper hit 子命令——exec.ts runHit 单源），与 ref
  // 解析时的身份快照按 role+title 比对（ObserveRefEntry 只有这两面；247 结构
  // 身份纪律同源——编号跨 observe 不稳定，绝不入键）。四态：匹配=「落点已确
  // 认」；不匹配=诚实警示（**不 isError**——动作事实（CGEvent 已发）与验证
  // 结论分列报告，副作用动作只做用户/模型明示的那一次，绝不因验证失败自动
  // 重做）；未命中（exit 4）=「落点处未命中元素」诚实不猜；helper 无 hit/
  // 出错/格式不符=静默降级零验证行（旧助手回执保持 257 形零断崖）。任何异常
  // 吞在这里（250 withSettle 同律——验证绝不 fail 动作本身）。
  // 265 起 expect 可选——缺席=纯信息形（坐标路径第三消费：无预期身份就无
  // 匹配/不符态，hit 读到什么报什么）：hit→「落点是X。」（与验证行的不符
  // 句同首词不同句——后者带「——与预期的…不符」子句）；miss/降级两态与
  // 验证形共用。
  const hitNamed = (role: string, title: string): string =>
    `${displayRole(role)}${title !== "" ? `「${title}」` : ""}`;
  const withLandingHit = async (receipt: string, at: ScreenPoint, expect?: ObserveRefEntry): Promise<string> => {
    try {
      const helper = resolveClickHelper(env, helperExists, opts.execPath);
      if (helper === undefined) return receipt;
      const read = await runHit(exec, helper, at);
      if (read === undefined) return receipt; // 静默降级（旧 helper/出错/格式不符）
      // ω99-269: #1 — miss/不符两态引导句收口（回执即处方，四消费面一处改
      // 全员受益）：miss 从裸句号终点换双出路（ref 族 observe、坐标族 capture
      // ——265 坐标路径同落此态）；不符尾段从「复核」半句换完整处方（重新
      // observe 取新编号——旧 ref 属旧快照，247 编号跨 observe 不稳定纪律的
      // 用户语）。匹配/信息两态零动（确认/报态无错可纠，加句是噪音）；只改
      // 两模板串，零结构零接线。
      if (read.kind === "miss") return `${receipt}\n落点处未命中元素（可能已消失或界面已变动）——如需继续：重新 screen_observe 或 screen_capture 看清现状后再试。`;
      const a = read.identity;
      if (expect === undefined) return `${receipt}\n落点是${hitNamed(a.role, a.title ?? "")}。`;
      if (a.role === expect.role && (a.title ?? "") === expect.title) {
        return `${receipt}\n落点已确认：${hitNamed(a.role, a.title ?? "")}。`;
      }
      return `${receipt}\n落点是${hitNamed(a.role, a.title ?? "")}——与预期的${hitNamed(expect.role, expect.title)}不符（元素表是 screen_observe 那一刻的快照，界面此后可能已变动）——如需继续：重新 screen_observe 取新编号后再试，不要用旧 ref 重试。`;
    } catch {
      return receipt;
    }
  };

  const computerDrag: Tool = buildTool({
    name: "computer_drag",
    description:
      "把屏幕上的一个东西从一处拖到另一处（按住鼠标移动再松开）——把文件/图标拖进文件夹、拖动滑块、调整列表顺序。起点/终点各走两条路之一：① startRef/endRef——按 screen_observe 元素表的 [eN] 编号直达（该端=元素中心，对应坐标可省；两端可混搭，如 startRef+endX/endY=「把这个元素拖到屏幕某处」）；② 坐标——先用 screen_capture 看清屏幕，从最近一次 screen_capture 输出图的像素空间取坐标（系统自动换算，不要自行按比例折算）。给 endRef 时，拖完会自动核对落点上实际是什么元素并把结论写进回执（已确认/与预期不符/未命中），不必再截一张图确认有没有拖到位。button:\"right\" 为右键拖（少用）。拖拽对节奏敏感：内部已按小步移动放慢，若目标应用没接住（文件没挪过去），截屏确认后重试或改用其他办法。",
    parameters: {
      type: "object",
      properties: {
        startX: { type: "number", description: "起点横坐标（像素，非负整数）——最近一次 screen_capture 输出图上要拖的东西的位置（startRef 给出时可省）。" },
        startY: { type: "number", description: "起点纵坐标（像素，非负整数）——最近一次 screen_capture 输出图上的位置（startRef 给出时可省）。" },
        endX: { type: "number", description: "终点横坐标（像素，非负整数）——最近一次 screen_capture 输出图上放下的位置（endRef 给出时可省）。" },
        endY: { type: "number", description: "终点纵坐标（像素，非负整数）——最近一次 screen_capture 输出图上的位置（endRef 给出时可省）。" },
        startRef: { type: "string", description: '起点元素编号（如 "e3"）——来自最近一次 screen_observe 的 [eN] 元素表；给出则起点=该元素中心（startX/startY 可省，同给时按 ref）。' },
        endRef: { type: "string", description: '终点元素编号（如 "e7"）——来自最近一次 screen_observe 的 [eN] 元素表；给出则终点=该元素中心（endX/endY 可省，同给时按 ref）。' },
        button: { type: "string", description: "left（默认）或 right。", enum: ["left", "right"] },
      },
      additionalProperties: false,
    },
    // 拖放可能触发目标侧的真实动作（文件移动/提交）——按破坏性标注。
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    isOpenWorld: () => true,
    timeoutMs: 30_000,
    async execute(args): Promise<ToolResult> {
      if (platform === "win32") {
        if (args["startRef"] !== undefined || args["endRef"] !== undefined) {
          return err(WIN_NO_REF("computer_drag"));
        }
        const x1 = args["startX"];
        const y1 = args["startY"];
        const x2 = args["endX"];
        const y2 = args["endY"];
        if (!validCoord(x1) || !validCoord(y1) || !validCoord(x2) || !validCoord(y2)) {
          return err('computer_drag: needs "startX"/"startY"/"endX"/"endY" non-negative integers (screen pixels from screen_capture\'s image)');
        }
        const button = args["button"] === undefined ? "left" : args["button"];
        if (button !== "left" && button !== "right") {
          return err('computer_drag: "button" must be "left" (default) or "right"');
        }
        const scale = captureScale();
        const r = await runWinPs(exec, "computer_drag", buildWinDragScript(
          Math.round(x1 * scale), Math.round(y1 * scale), Math.round(x2 * scale), Math.round(y2 * scale), button,
        ));
        if (!r.ok) return err(r.error);
        const how = button === "right" ? "右键拖" : "拖";
        return ok(await winStatusSuffix(exec, `已从 (${x1}, ${y1}) ${how}到 (${x2}, ${y2})。`));
      }
      if (platform !== "darwin") return err(NON_DARWIN("computer_drag", platform));
      // ref 端解析（沿 click 骨架，两端各自独立）：形校验 → 观察在场 → 表内
      // 命中（缺席=stale 文案）→ 位置在场（旧 helper 无 @ 段 → typed 出路）。
      // ref 端坐标=元素中心屏幕点原值，**绕过 captureScale**（口径分轨）；
      // 坐标端照旧像素守卫+换算（buildDragArgs 单源）——两端各自至少一种形式
      // 必须在场（覆盖端缺席校验即此语义），校验先于副作用。
      let startAt: ScreenPoint | undefined;
      let endAt: ScreenPoint | undefined;
      let startName: string | undefined;
      let endName: string | undefined;
      let endEntry: ObserveRefEntry | undefined; // 终点身份快照（验证比对键=role+title）
      for (const [key, isStart] of [["startRef", true], ["endRef", false]] as const) {
        if (args[key] === undefined) continue;
        if (!validObserveRef(args[key])) {
          return err(`computer_drag: "${key}" must look like "e1", "e2", … (from screen_observe's [eN] table); got ${JSON.stringify(args[key])}`);
        }
        const ref = args[key] as string;
        if (observeState.lastObservation === undefined) {
          return err("computer_drag: No observation yet — call screen_observe first: its [eN] element table is this tool's ref source.");
        }
        const entry = observeState.lastObservation.refs.get(ref);
        if (entry === undefined) {
          return err(`computer_drag: Ref ${ref} is not in the current observation (the window may have changed since screen_observe ran) — call screen_observe again for fresh refs.`);
        }
        if (entry.x === undefined || entry.y === undefined) {
          return err(`computer_drag: [${ref}] 该元素的位置信息不在观察表里（旧版桌面助手的观察不带位置）——用坐标路径，或升级桌面版后重新 screen_observe。`);
        }
        if (isStart) {
          startAt = { x: entry.x, y: entry.y };
          startName = nameRef(ref, entry.role, entry.title);
        } else {
          endAt = { x: entry.x, y: entry.y };
          endName = nameRef(ref, entry.role, entry.title);
          endEntry = entry;
        }
      }
      // 校验先于副作用（fail-closed）：坐标/按钮非法零派生。ω99-244——有
      // capture 基准时起终点随坐标同换算（守卫收模型值、argv 出屏幕点值）。
      const built = buildDragArgs(args["startX"], args["startY"], args["endX"], args["endY"], args["button"], captureScale(), startAt, endAt);
      if (!built.ok) return err(`computer_drag: ${built.error}`);
      const helper = resolveClickHelper(env, helperExists, opts.execPath);
      if (helper === undefined) {
        return err(
          "computer_drag: 拖拽助手不在场（wudao-click 未找到）。桌面版重新安装/升级即可带上；自托管会话请把编译好的 wudao-click 路径写进环境变量 WUDAO_CLICK_HELPER（或放在 wudao 可执行文件同目录）。本工具不会在没有助手的情况下模拟拖拽。",
        );
      }
      // settle 基线=动作前轻量采样（ref 端与坐标端同律：drag 的 helper 动作
      // 不带 sha 守卫——250 的非 ref 路径裁定）。
      const settleBase = await freshSettleBase();
      const r = await exec(helper, built.args);
      if (r.code === 2 || r.stdout.includes("WUDAO_AX_UNTRUSTED")) {
        return err(`computer_drag: ${PERM_MARKER_ACCESSIBILITY} 拖拽助手没有「辅助功能」权限，事件被系统丢弃。${ACCESSIBILITY_GUIDE}`);
      }
      if (r.code !== 0) {
        return err(`computer_drag: 拖拽助手执行失败（exit ${r.code}）：${truncateSafe((r.stderr || r.stdout).trim(), 400)}`);
      }
      // 收据：ref 端点名 `[eN] 角色「标题」`（click 范式）；坐标端照旧 (x, y)
      // 形（模型量纲——换算不进文案）。仅 endRef 路径在 settle 之后追加落点
      // 验证行（withLandingHit——四态/静默降级见其注释；验证行是纯追加，257
      // 基线回执字节不变）。
      const how = args["button"] === "right" ? "右键拖" : "拖";
      const startLabel = startName ?? `(${String(args["startX"])}, ${String(args["startY"])})`;
      const endLabel = endName ?? `(${String(args["endX"])}, ${String(args["endY"])})`;
      const receipt = await withSettle(await withStatus(exec, `已从 ${startLabel} ${how}到 ${endLabel}。`), settleBase);
      if (endEntry === undefined || endAt === undefined) return ok(receipt); // 坐标终点零验证
      return ok(await withLandingHit(receipt, endAt, endEntry));
    },
  });

  // ω99 拆分运动 弧 B — screen_observe + computer_wait 两面外提至 observe-tools.ts
  // （闭包体逐字保留；观察/黑名单态走下方 observeState 单一 holder）。
  const { screenObserve, computerWait } = createObserveTools({
    platform,
    exec,
    env,
    helperExists,
    execPath: opts.execPath,
    now,
    sleep,
    observeState,
    observeBlacklisted,
    sampleObserve,
  });

  return [screenCapture, computerType, computerKey, computerClick, appActivate, appList, computerScroll, computerDrag, screenObserve, computerWait];
}

/** scroll 成功回执的方向短语（与 summarize 同一套方向词——回执拼「已…」，
 *  summarize 拼对象；单一口径。到回执时增量已过守卫，parts 必非空）。 */
function scrollReceipt(dy: number, dx: number | undefined): string {
  const parts: string[] = [];
  if (dy > 0) parts.push(`向下滚动 ${dy} 像素`);
  else if (dy < 0) parts.push(`向上滚动 ${-dy} 像素`);
  if (dx !== undefined && dx > 0) parts.push(`向右滚动 ${dx} 像素`);
  else if (dx !== undefined && dx < 0) parts.push(`向左滚动 ${-dx} 像素`);
  return parts.length > 0 ? parts.join("、") : "滚动";
}
