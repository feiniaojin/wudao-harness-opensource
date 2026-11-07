// ω99 拆分运动 弧 B：computer 的观察/等待面外提（screen_observe + computer_wait
// + 回执构造——原 createComputerTools 闭包内连续段逐字保留；可变观察/黑名单态
// 留在工具集闭包的单一 observeState holder，本文件经引用线程读写）。
import { truncateSafe } from "@wudao-org/core"; // 113-A4
import { buildTool } from "@wudao-org/core";
import type { Tool, ToolResult } from "@wudao-org/core";
import {
  ACCESSIBILITY_GUIDE,
  OBSERVE_BLACKLIST_N,
  OBSERVE_BLACKLIST_TTL_MS,
  PERM_MARKER_ACCESSIBILITY,
  WAIT_SAMPLE_INTERVAL_MS,
  WAIT_STABLE_SAMPLES,
  WAIT_TIMEOUT_DEFAULT_MS,
  WAIT_TIMEOUT_MAX_MS,
  buildObserveArgs,
  isEmptyObservation,
  matchWaitElement,
  observeContentDigest,
  observeElementDetail,
  observeRefs,
  parseObserveOutput,
  resolveClickHelper,
  sanitizeAppName,
  validObserveRef,
  type ExecSeam,
  type ObserveRefEntry,
  type ObserveTable,
} from "./exec.js";
import { ok, err, NON_DARWIN, nameRef } from "./tool-helpers.js";
import { annotateElementLine } from "./element-id.js";

/** The observe/wait faces' shared session state — the extracted twin of the
 *  tool-set closure's two mutable `let`s (ONE holder object; every site reads
 *  and writes through it, never a second binding). */
export interface ObserveState {
  /** 最近一次成功观察：refs 只收「行幸存」的编号；新观察整对覆写。 */
  lastObservation?: {
    readonly table: ObserveTable;
    readonly refs: ReadonlyMap<string, ObserveRefEntry>;
    readonly sha256: string;
    readonly appParam: string | undefined;
  };
  /** 黑名单（单条 streak）：key=app 参数或 ""（前台）；换 key 即重开。 */
  emptyStreak?: { key: string; count: number; until: number };
}

/** The observe/wait tools' closure context (verbatim free variables). */
export interface ObserveToolsCtx {
  readonly platform: string;
  readonly exec: ExecSeam;
  readonly env: NodeJS.ProcessEnv;
  readonly helperExists: (path: string) => boolean;
  readonly execPath: string | undefined;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly observeState: ObserveState;
  readonly observeBlacklisted: (key: string) => boolean;
  readonly sampleObserve: (appParam: string | undefined) => Promise<ObserveTable | undefined>;
}

export function createObserveTools(ctx: ObserveToolsCtx): { screenObserve: Tool; computerWait: Tool } {
  const { platform, exec, env, helperExists, execPath, now, sleep, observeState, observeBlacklisted, sampleObserve } = ctx;
  // —— ω99-247 — screen_observe（读面九员；computer 域尾后 append-only，M24
  // 前缀稳定：既有八面字节与序不动）——

  /** 观察成功回执（非空表）：上下文行 + 元素表原文（130-C1 注记稳定 ID
   *  与风险档）+ 用 ref 点选提示（+截断叙事）。 */
  const observeReceipt = (app: string, window: string, elementLines: readonly string[], truncated: boolean, refs?: ReadonlyMap<string, import("./exec.js").ObserveRefEntry>): string => {
    const head = `已观察 ${app} 窗口「${window}」，可操作元素如下——用 computer_click / computer_type 的 ref 参数按 [eN] 编号或 @ax: 稳定 ID 直达（比截图量坐标更快更准；@ax: ID 在部分界面变化后仍指向同一元素）：`;
    const table = refs !== undefined ? elementLines.map((l) => annotateElementLine(l, refs)).join("\n") : elementLines.join("\n");
    const trunc = truncated ? "\n[元素表已达观察预算上限被截断——未列出的元素没有编号、不可用 ref 点选；需要更深处元素时改用 screen_capture 截图辅助]" : "";
    return `${head}\n${table}${trunc}`;
  };

  /** 空观察回执（无元素树——诚实出路走截图；连续空时附降级预警）。 */
  const emptyObserveReceipt = (app: string, window: string, streakCount: number): string => {
    const base = `${app} 窗口「${window}」没有暴露可操作元素（无元素树——常见于游戏、自绘界面或部分跨平台应用）。请改用 screen_capture 截图查看 + computer_click 坐标点选。`;
    return streakCount >= OBSERVE_BLACKLIST_N
      ? `${base}\n（${app} 已连续 ${streakCount} 次观察为空——短期内 screen_observe 将直接建议走截图，不再重复尝试；约 ${Math.round(OBSERVE_BLACKLIST_TTL_MS / 60_000)} 分钟后或换目标后自动恢复）`
      : base;
  };

  const screenObserve: Tool = buildTool({
    name: "screen_observe",
    promptSnippet: "list the frontmost window's on-screen elements as refs",
    promptGuidelines: [
      "Prefer an element ref over guessed coordinates when one is available.",
    ],
    description:
      "列出前台应用（或指定 app）最前窗口里的可操作元素——按钮、输入框、菜单项等，每行带 [eN] 编号。之后用 computer_click / computer_type 的 ref 参数按编号直达，比截图量坐标更快更准、也不受分辨率影响。编号只在下一次 screen_observe 之前有效；元素表为空或找不到编号时，改用 screen_capture 截图 + 坐标。可选 app 填应用名（如 \"Safari\"）或 bundle id。",
    parameters: {
      type: "object",
      properties: {
        app: { type: "string", description: '要观察的应用名（"Safari"）或 bundle id；缺省=当前前台应用。' },
      },
      additionalProperties: false,
    },
    // 只读 AX 树（零写入面）——读屏幕内容与 screen_capture 同档（权限层同
    // 普通档位，不进 DEFAULT_ASK_TOOLS）。
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    isOpenWorld: () => true,
    timeoutMs: 30_000,
    async execute(args): Promise<ToolResult> {
      if (platform === "win32") {
        return err("screen_observe: 元素树观察基于 macOS 辅助功能（AX），Windows 上不可用——用 screen_capture 看屏幕（坐标路径点选/输入），或读窗口标题（computer_* 回执的状态行）判断现状。");
      }
      if (platform !== "darwin") return err(NON_DARWIN("screen_observe", platform));
      // app 参数净化（缺省=前台）；黑名单 key=app 参数或 ""。
      let appParam: string | undefined;
      if (args["app"] !== undefined) {
        const clean = sanitizeAppName(args["app"]);
        if (!clean.ok) return err(`screen_observe: ${clean.error}`);
        appParam = clean.text;
      }
      const key = appParam ?? "";
      // 黑名单前置：TTL 内不硬试（自适应降级——连续空的窗口主动引走截图）。
      if (observeState.emptyStreak !== undefined && observeState.emptyStreak.key === key && observeState.emptyStreak.count >= OBSERVE_BLACKLIST_N && now() < observeState.emptyStreak.until) {
        const who = appParam ?? "该应用";
        return err(`screen_observe: ${who} 近期连续观察为空（该窗口无元素树），已暂停重复尝试——请走截图：screen_capture 看屏幕 + computer_click 坐标点选。`);
      }
      const helper = resolveClickHelper(env, helperExists, execPath);
      if (helper === undefined) {
        return err(
          "screen_observe: 观察助手不在场（wudao-click 未找到）。桌面版重新安装/升级即可带上；自托管会话请把编译好的 wudao-click 路径写进环境变量 WUDAO_CLICK_HELPER（或放在 wudao 可执行文件同目录）。本工具不会在没有助手的情况下观察屏幕。",
        );
      }
      const r = await exec(helper, buildObserveArgs(appParam));
      if (r.code === 2 || r.stdout.includes("WUDAO_AX_UNTRUSTED")) {
        return err(`screen_observe: ${PERM_MARKER_ACCESSIBILITY} 观察助手没有「辅助功能」权限，读取元素被系统拒绝。${ACCESSIBILITY_GUIDE}`);
      }
      if (r.code === 5) {
        const who = appParam ?? "前台应用";
        return err(`screen_observe: 未找到 ${who} 的可观察窗口（应用未运行或没有窗口）。`);
      }
      if (r.code !== 0) {
        return err(`screen_observe: 观察助手执行失败（exit ${r.code}）：${truncateSafe((r.stderr || r.stdout).trim(), 400)}`);
      }
      const read = parseObserveOutput(r.stdout);
      if (!read.ok) {
        return err("screen_observe: 观察器输出无法解析（元素表格式异常）——请重试一次；仍失败请改用 screen_capture 截图。");
      }
      const table = read.table;
      // refs 落态（新观察整对覆写——旧 ref 作废）；空观察也覆写为空表。
      // ω99-250 — 表整张随行（settle 基线/等待谓词的输入；refs 派生不变）。
      observeState.lastObservation = { table, refs: observeRefs(table), sha256: table.sha256, appParam };
      if (isEmptyObservation(table)) {
        // 连续空计数：换 key 重开；「拉黑已过期」=宽恕重数（恢复后的单次空
        // 不立即再拉黑——给一次试探余量；未拉黑的 streak（until=0）照常累
        // 计）；达 N 拉黑到 TTL；成功路径在下方清零。
        const prev = observeState.emptyStreak !== undefined && observeState.emptyStreak.key === key ? observeState.emptyStreak : undefined;
        const expired = prev !== undefined && prev.until > 0 && now() >= prev.until;
        const streak = prev !== undefined && !expired ? prev : { key, count: 0, until: 0 };
        streak.count += 1;
        if (streak.count >= OBSERVE_BLACKLIST_N) streak.until = now() + OBSERVE_BLACKLIST_TTL_MS;
        observeState.emptyStreak = streak;
        return ok(emptyObserveReceipt(table.app, table.window, streak.count));
      }
      if (observeState.emptyStreak !== undefined && observeState.emptyStreak.key === key) observeState.emptyStreak = undefined;
      return ok(observeReceipt(table.app, table.window, table.elementLines, table.truncated, observeRefs(table)));
    },
  });

  // —— ω99-250 — computer_wait（读面十员；computer 域尾后 append-only，M24
  // 前缀稳定：既有九面字节零触碰）——

  const computerWait: Tool = buildTool({
    name: "computer_wait",
    promptSnippet: "wait until the screen changes or a deadline passes",
    promptGuidelines: [
      "Use it instead of guessing how long an action takes.",
    ],
    description:
      "等待屏幕上出现某个状态再继续——很多操作的效果要过一会儿才到位（页面加载、导出完成、弹窗出现），与其反复截图看，不如指定要等的结果。两种等法：① 等某个元素就绪：给 ref（最近一次 screen_observe 元素表的 [eN] 编号）并说明期望——value（它的内容变成什么，如 \"已完成\"）或 title（它的标题变成什么），元素到位且匹配即返回；② 等整个界面停稳：stable=true，画面连续几次采样不再变化（加载/动画结束）即返回。超时缺省 5000 毫秒、上限 30000；超时会说明哪个元素没到什么状态、当前是什么，并给出重试、重新 screen_observe、或 screen_capture 直接查看的出路。批内多个动作连发时，末尾用一次本工具等结果，无需逐动作截图。",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: '要等待的元素编号（如 "e12"）——来自最近一次 screen_observe 的 [eN] 元素表；与 value/title 搭配。' },
        value: { type: "string", description: "期望该元素的内容/值（如 \"已完成\"）——元素在场且值等于它即成功。" },
        title: { type: "string", description: "期望该元素的标题（如 \"已连接\"）——等待标题变化时给这个；与 value 至少给一个。" },
        stable: { type: "boolean", description: "true = 不等特定元素，等整个界面停稳（连续几次采样无变化）。" },
        timeoutMs: { type: "number", description: "最长等待毫秒数（缺省 5000，上限 30000）。" },
      },
      additionalProperties: false,
    },
    // 只读等待（采样观察，零写入面）——与 screen_observe 同档，不进
    // DEFAULT_ASK_TOOLS。
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    isOpenWorld: () => true,
    timeoutMs: 40_000,
    async execute(args): Promise<ToolResult> {
      if (platform === "win32") {
        return err("computer_wait: 等待依赖 macOS 元素树采样，Windows 上不可用——用 screen_capture 截图比对（间隔 1-2 秒连截两张看变化），或直接读 computer_* 回执的状态行确认结果。");
      }
      if (platform !== "darwin") return err(NON_DARWIN("computer_wait", platform));
      // 谓词形校验（fail-closed，先于一切派生）：ref 形与 stable 形二选一。
      const stable = args["stable"];
      if (stable !== undefined && typeof stable !== "boolean") {
        return err('computer_wait: "stable" must be a boolean');
      }
      const hasRef = args["ref"] !== undefined;
      if (stable === true && (hasRef || args["value"] !== undefined || args["title"] !== undefined)) {
        return err('computer_wait: "stable" cannot be combined with "ref"/"value"/"title" — pick exactly one wait condition');
      }
      if (stable !== true && !hasRef) {
        return err('computer_wait: needs exactly one condition — either "ref" (with "value" and/or "title") or "stable"=true');
      }
      let ref = "";
      if (hasRef) {
        if (!validObserveRef(args["ref"])) {
          return err(`computer_wait: "ref" must look like "e1", "e2", … (from screen_observe's [eN] table); got ${JSON.stringify(args["ref"])}`);
        }
        ref = args["ref"] as string;
        if (args["value"] === undefined && args["title"] === undefined) {
          return err('computer_wait: waiting on a ref needs a state — give "value" (its expected content) and/or "title" (its expected title)');
        }
      }
      for (const [k, v] of [["value", args["value"]], ["title", args["title"]]] as const) {
        if (v !== undefined && typeof v !== "string") {
          return err(`computer_wait: "${k}" must be a string`);
        }
      }
      let timeout = WAIT_TIMEOUT_DEFAULT_MS;
      const rawTimeout = args["timeoutMs"];
      if (rawTimeout !== undefined) {
        if (typeof rawTimeout !== "number" || !Number.isInteger(rawTimeout) || rawTimeout < 1 || rawTimeout > WAIT_TIMEOUT_MAX_MS) {
          return err(`computer_wait: "timeoutMs" must be an integer between 1 and ${WAIT_TIMEOUT_MAX_MS} (default ${WAIT_TIMEOUT_DEFAULT_MS})`);
        }
        timeout = rawTimeout;
      }
      // ref 形：从 observeState.lastObservation 解析元素身份（stale-ref 族错误先于一切采样）。
      let identity: { role: string; title: string } | undefined;
      let sampleApp: string | undefined;
      if (hasRef) {
        if (observeState.lastObservation === undefined) {
          return err("computer_wait: No observation yet — call screen_observe first: its [eN] element table is this tool's ref source.");
        }
        const entry = observeState.lastObservation.refs.get(ref);
        if (entry === undefined) {
          return err(`computer_wait: Ref ${ref} is not in the current observation (the window may have changed since screen_observe ran) — call screen_observe again for fresh refs.`);
        }
        // 身份优先取自表内同编号行的细读（247 refs entry 的标题解析对带
        // value 的行是贪婪引号形——跨行尾吃进 value=…；细读器两侧（基线身份
        // 与采样匹配）同一把尺，title 干净对称。行不合细读形 → 回退 entry。
        const detail = observeState.lastObservation.table.elementLines
          .map((l) => observeElementDetail(l))
          .find((d) => d !== undefined && d.ref === ref);
        identity = detail !== undefined
          ? { role: detail.role, title: detail.title }
          : { role: entry.role, title: entry.title };
        sampleApp = observeState.lastObservation.appParam; // 同参观察（与用户 observe 同目标）
      }
      const helper = resolveClickHelper(env, helperExists, execPath);
      if (helper === undefined) {
        return err(
          "computer_wait: 观察助手不在场（wudao-click 未找到）。桌面版重新安装/升级即可带上；自托管会话请把编译好的 wudao-click 路径写进环境变量 WUDAO_CLICK_HELPER（或放在 wudao 可执行文件同目录）。本工具不会在没有助手的情况下观察屏幕。",
        );
      }
      const expect = {
        value: typeof args["value"] === "string" ? (args["value"] as string) : undefined,
        title: typeof args["title"] === "string" ? (args["title"] as string) : undefined,
      };
      const expectName = expect.value !== undefined && expect.title !== undefined
        ? "值与标题"
        : expect.value !== undefined ? "值" : "标题";
      const expected = expect.value ?? expect.title ?? "";
      const start = now();
      const deadline = start + timeout;
      let lastDigest = "";
      let stableRun = 0;
      for (;;) {
        const table = await sampleObserve(sampleApp);
        if (table === undefined) {
          return err("computer_wait: 等待期间无法读取界面（观察器未返回可用结果）——请重试一次；仍失败请改用 screen_capture 查看。");
        }
        if (isEmptyObservation(table)) {
          return err("computer_wait: 该窗口没有暴露可观察元素（无元素树）——无法等待元素状态，请改用 screen_capture 查看画面。");
        }
        if (identity !== undefined) {
          const hit = matchWaitElement(table, identity, expect);
          if (hit !== undefined) {
            const named = nameRef(ref, identity.role, identity.title);
            return ok(`已等到：${named}的${expectName}已是「${expected}」（等待 ${now() - start} 毫秒）。`);
          }
        } else {
          const digest = observeContentDigest(table);
          stableRun = digest === lastDigest ? stableRun + 1 : 1;
          lastDigest = digest;
          if (stableRun >= WAIT_STABLE_SAMPLES) {
            return ok(`界面已停稳（连续 ${WAIT_STABLE_SAMPLES} 次采样无变化，等待 ${now() - start} 毫秒）。`);
          }
        }
        if (now() >= deadline) {
          if (identity !== undefined) {
            const named = nameRef(ref, identity.role, identity.title);
            const present = matchWaitElement(table, identity, {});
            if (present === undefined) {
              return err(`computer_wait: 等待超时（${timeout} 毫秒）——${named}未出现在当前窗口（可能已移除或界面已切换）。可重新 screen_observe 换编号，或 screen_capture 直接查看。`);
            }
            const actual = expect.title === undefined
              ? present.value !== undefined ? `当前值「${present.value}」` : "当前无值"
              : expect.value === undefined
                ? `当前标题「${present.title}」`
                : `当前值${present.value !== undefined ? `「${present.value}」` : "（无）"}、标题「${present.title}」`;
            return err(`computer_wait: 等待超时（${timeout} 毫秒）——${named}的${expectName}未达到「${expected}」（${actual}）。可再次 computer_wait、重新 screen_observe 换编号，或 screen_capture 直接查看。`);
          }
          return err(`computer_wait: 等待超时（${timeout} 毫秒）——界面持续变化未停稳。可加大 timeoutMs 再等，或 screen_capture 直接查看。`);
        }
        await sleep(WAIT_SAMPLE_INTERVAL_MS);
      }
    },
  });

  return { screenObserve, computerWait };
}
