// ω99-250: #1 — computer_wait + 动作后 settle 验证闭环 receipts（239 弧 D：
// 动作回执自带「界面变没变」的确定性事实 + 显式等待面——批内不截图的验证
// 半边）。★测试红线（212/220/247 既立红线沿承）：child_process 全 mock（注入
// ExecSeam 假件，helper observe/press/settext 输出全为构造字符串）——绝无真实
// 键鼠/截屏/真 AX 读取/真 osascript；时钟缝（now/sleep）注入驱动 settle 窗与
// wait 超时，零真实等待；夹具零盘写零删除（读源文件是只读）。
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildObserveArgs,
  observeContentDigest,
  observeElementDetail,
  matchWaitElement,
  formatSettleLine,
  parseObserveOutput,
  OBSERVE_MAX_NODES,
  OBSERVE_MAX_DEPTH,
  OBSERVE_MAX_TEXT_BYTES,
  SETTLE_WINDOW_MS,
  SETTLE_SAMPLE_INTERVAL_MS,
  WAIT_TIMEOUT_DEFAULT_MS,
  WAIT_TIMEOUT_MAX_MS,
  WAIT_SAMPLE_INTERVAL_MS,
  WAIT_STABLE_SAMPLES,
  type ExecSeam,
  type ExecResult,
} from "../src/computer/exec.js";
import { createComputerTools } from "../src/computer/tools.js";
import { DEFAULT_ASK_TOOLS, decidePermission, isDefaultAskCall } from "../src/permission.js";
import { summarizeToolCall } from "../src/log.js";
import { buildToolSet } from "../src/tools.js";
import { COMPUTER_STRATEGY_SECTION } from "../src/prompt.js";

const HELPER = "/fake/wudao-click";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);

/** 观察器 stdout 构造（helper 输出契约 mock 形——行格式即被测契约，含
 *  value=/focused 谓词输入面）。 */
const obs = (o: {
  app?: string;
  window?: string;
  lines?: readonly string[];
  nodes?: number;
  sha?: string;
} = {}): string => [
  `WUDAO_OBSERVE app=${o.app ?? "Safari"}`,
  `WUDAO_WINDOW ${o.window ?? "备忘录"}`,
  ...(o.lines ?? ['[e1] AXWindow "备忘录"', '  [e2] AXButton "添加"', '  [e3] AXTextField "搜索"']),
  `WUDAO_END nodes=${o.nodes ?? 3} truncated=0 sha256=${o.sha ?? SHA_A}`,
].join("\n");

/** 等待场景表：状态行 e3（AXStaticText「状态」）带 value= 谓词输入。 */
const LOADING_LINES = ['[e1] AXWindow "下载"', '  [e2] AXButton "提交"', '  [e3] AXStaticText "状态" value="加载中"'];
const STATUS_LOADING = obs({ lines: LOADING_LINES, sha: SHA_A });
const STATUS_DONE = obs({ lines: ['[e1] AXWindow "下载"', '  [e2] AXButton "提交"', '  [e3] AXStaticText "状态" value="已完成"'], sha: SHA_B });
const STATUS_GONE = obs({ lines: ['[e1] AXWindow "下载"', '  [e2] AXButton "提交"'], nodes: 2, sha: SHA_C });
const EMPTY_TREE = obs({ lines: ['[e1] AXWindow "游戏"'], nodes: 1, sha: SHA_D });

/** 时钟缝 + 分流 seam：helper observe 按序取 stdout（末位粘滞）、其余 helper
 *  子命令成功；osascript 状态可配（缺省空=状态行诚实缺席）；每次 helper 调用
 *  推进时钟 tickMs（settle 窗/wait 超时全由假钟驱动，零真实 sleep）。 */
function clockedSeam(opts: {
  readonly observe: readonly string[] | (() => string);
  readonly tickMs?: number;
  readonly helper?: Partial<ExecResult>;
  readonly status?: string;
}): ExecSeam & { calls: { file: string; args: string[] }[]; now: () => number } {
  let t = 0;
  const calls: { file: string; args: string[] }[] = [];
  let idx = 0;
  const next = typeof opts.observe === "function"
    ? opts.observe
    : () => {
      const i = Math.min(idx, opts.observe.length - 1);
      const out = (opts.observe as readonly string[])[i]!;
      idx += 1;
      return out;
    };
  const seam: ExecSeam = async (file, args) => {
    calls.push({ file, args: [...args] });
    if (file === HELPER) {
      t += opts.tickMs ?? 100;
      if (args[0] === "observe") return { stdout: next(), stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0, ...opts.helper };
    }
    if (file === "osascript") return { stdout: opts.status ?? "", stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  };
  return Object.assign(seam, { calls, now: () => t });
}

/** 建工具集（helper 在场；时钟注入）。 */
const tools = (s: ReturnType<typeof clockedSeam>) =>
  createComputerTools({
    exec: s, platform: "darwin", env: { WUDAO_CLICK_HELPER: HELPER }, helperExists: () => true, now: s.now,
    sleep: async () => {},
  });
const find = (t: ReturnType<typeof createComputerTools>, name: string) => t.find((x) => x.name === name)!;
const observeCalls = (s: ReturnType<typeof clockedSeam>) => s.calls.filter((c) => c.file === HELPER && c.args[0] === "observe");

// —— 三态行与超时错误字面量（逐字钉；收益语言，零实现术语）——
const LINE_CHANGED = "界面已变化（与动作前观察到的内容不同）。";
const LINE_UNCHANGED = "界面未变（可能本来就如此；像素级细节不在观察范围内，如需确认请 screen_capture）。";
const LINE_RESTLESS = `界面在 ${SETTLE_WINDOW_MS} 毫秒内未稳定（仍在变化）——可用 computer_wait 等它停稳，或 screen_capture 直接查看。`;
const LINE_NO_TREE = "无法验证界面是否变化（该窗口没有可观察元素）——如需确认请 screen_capture。";

// ---------------------------------------------------------------------------
// R1 — computer_wait 面（谓词形/超时形/stale 族/可恢复超时）
// ---------------------------------------------------------------------------
describe("ω99-250 R1 — computer_wait 工具面", () => {
  it("数值钉（裁定进报告 §一）：超时缺省 5000 / 硬帽 30000 / wait 采样间隔 400 / 稳定需连续 3 次；settle 窗 1500 / 间隔 150", () => {
    expect(WAIT_TIMEOUT_DEFAULT_MS).toBe(5_000);
    expect(WAIT_TIMEOUT_MAX_MS).toBe(30_000);
    expect(WAIT_SAMPLE_INTERVAL_MS).toBe(400);
    expect(WAIT_STABLE_SAMPLES).toBe(3);
    expect(SETTLE_WINDOW_MS).toBe(1_500);
    expect(SETTLE_SAMPLE_INTERVAL_MS).toBe(150);
  });

  it("ref 谓词命中=成功回执：点名元素+状态+等待时长；采样 argv=observe 预算三参（同参观察用户 observe 的目标）", async () => {
    const s = clockedSeam({ observe: [STATUS_LOADING, STATUS_LOADING, STATUS_DONE], tickMs: 400 });
    const t = tools(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_wait").execute({ ref: "e3", value: "已完成" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe("已等到：[e3] 文本「状态」的值已是「已完成」（等待 800 毫秒）。");
    for (const c of observeCalls(s).slice(1)) {
      expect(c.args).toEqual(["observe", String(OBSERVE_MAX_NODES), String(OBSERVE_MAX_DEPTH), String(OBSERVE_MAX_TEXT_BYTES)]);
    }
  });

  it("title 谓词形：等元素标题到位（值不锁——标题是被等的量）", async () => {
    const before = obs({ lines: ['[e1] AXWindow "w"', '  [e2] AXButton "连接"'], nodes: 2 });
    const after = obs({ lines: ['[e1] AXWindow "w"', '  [e2] AXButton "已连接"'], nodes: 2, sha: SHA_B });
    const s = clockedSeam({ observe: [before, before, after], tickMs: 400 });
    const t = tools(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_wait").execute({ ref: "e2", title: "已连接" });
    expect(r.isError).toBeFalsy();
    // 点名用「模型认识的那只元素」（身份来自 observe 时的标题），状态报新值
    expect(r.content).toBe("已等到：[e2] 按钮「连接」的标题已是「已连接」（等待 800 毫秒）。");
  });

  it("ref 失效=247 stale 文案族：未观察先等 → No observation yet；编号不在当次表 → not in current observation（零采样派生）", async () => {
    const s1 = clockedSeam({ observe: [obs()] });
    const r1 = await find(tools(s1), "computer_wait").execute({ ref: "e3", value: "x" });
    expect(r1.isError).toBe(true);
    expect(r1.content).toContain("No observation yet");
    expect(r1.content).toContain("screen_observe");
    expect(observeCalls(s1)).toHaveLength(0);
    const s2 = clockedSeam({ observe: [obs()] });
    const t2 = tools(s2);
    await find(t2, "screen_observe").execute({});
    const r2 = await find(t2, "computer_wait").execute({ ref: "e9", value: "x" });
    expect(r2.isError).toBe(true);
    expect(r2.content).toContain("Ref e9 is not in the current observation");
    expect(r2.content).toContain("call screen_observe again");
    expect(observeCalls(s2)).toHaveLength(1); // 只有用户那次，零等待采样
  });

  it("超时=可恢复报错逐字（元素在场未达标）：点名元素+期望+当前事实+三条出路（重试/重新 observe/截图）", async () => {
    const s = clockedSeam({ observe: [STATUS_LOADING], tickMs: 2_000 });
    const t = tools(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_wait").execute({ ref: "e3", value: "已完成" });
    expect(r.isError).toBe(true);
    expect(r.content).toBe(
      "computer_wait: 等待超时（5000 毫秒）——[e3] 文本「状态」的值未达到「已完成」（当前值「加载中」）。可再次 computer_wait、重新 screen_observe 换编号，或 screen_capture 直接查看。",
    );
  });

  it("超时=可恢复报错逐字（元素不在场）：如实说未出现+两条出路；自定义 timeoutMs 进报错", async () => {
    const s = clockedSeam({ observe: [STATUS_LOADING, STATUS_GONE], tickMs: 2_000 });
    const t = tools(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_wait").execute({ ref: "e3", value: "已完成", timeoutMs: 3_000 });
    expect(r.isError).toBe(true);
    expect(r.content).toBe(
      "computer_wait: 等待超时（3000 毫秒）——[e3] 文本「状态」未出现在当前窗口（可能已移除或界面已切换）。可重新 screen_observe 换编号，或 screen_capture 直接查看。",
    );
  });

  it("稳定谓词命中：连续 3 次采样无变化 → 已停稳回执（点名次数+时长）", async () => {
    const s = clockedSeam({ observe: [STATUS_DONE], tickMs: 400 });
    const r = await find(tools(s), "computer_wait").execute({ stable: true });
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe(`界面已停稳（连续 ${WAIT_STABLE_SAMPLES} 次采样无变化，等待 1200 毫秒）。`);
    expect(observeCalls(s)).toHaveLength(3);
  });

  it("稳定谓词超时逐字：界面一直变 → 未停稳+加大超时/截图出路", async () => {
    const s = clockedSeam({ observe: [STATUS_LOADING, STATUS_DONE, STATUS_GONE], tickMs: 2_000 });
    const r = await find(tools(s), "computer_wait").execute({ stable: true });
    expect(r.isError).toBe(true);
    expect(r.content).toBe("computer_wait: 等待超时（5000 毫秒）——界面持续变化未停稳。可加大 timeoutMs 再等，或 screen_capture 直接查看。");
  });

  it("首采样空树 → 快速失败（无元素树走截图出路，零轮询）", async () => {
    const s = clockedSeam({ observe: [STATUS_LOADING, EMPTY_TREE], tickMs: 400 });
    const t = tools(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_wait").execute({ ref: "e3", value: "已完成" });
    expect(r.isError).toBe(true);
    expect(r.content).toBe("computer_wait: 该窗口没有暴露可观察元素（无元素树）——无法等待元素状态，请改用 screen_capture 查看画面。");
    expect(observeCalls(s)).toHaveLength(2); // 用户 observe + 首采样恰两次，零轮询
  });

  it("采样不可用（helper 输出不可解析）→ 可恢复报错（重试/截图出路），绝不静默成功", async () => {
    const s = clockedSeam({ observe: () => "garbage not a table", tickMs: 400 });
    const t = tools(s);
    await find(t, "screen_observe").execute({}); // 用户 observe 也解析失败 → 先立观察态再等
    const r = await find(t, "computer_wait").execute({ stable: true });
    expect(r.isError).toBe(true);
    expect(r.content).toBe("computer_wait: 等待期间无法读取界面（观察器未返回可用结果）——请重试一次；仍失败请改用 screen_capture 查看。");
  });

  it("谓词形校验（fail-closed typed 拒，零派生）：stable 与 ref 组合拒/无条件拒/ref 无期望拒/ref 形状拒/超时越界拒", async () => {
    const s = clockedSeam({ observe: [STATUS_LOADING], tickMs: 100 });
    const t = tools(s);
    await find(t, "screen_observe").execute({});
    const base = observeCalls(s).length;
    const cases: readonly [Record<string, unknown>, string][] = [
      [{ stable: true, ref: "e3", value: "x" }, '"stable" cannot be combined with "ref"/"value"/"title"'],
      [{ value: "x" }, 'needs exactly one condition — either "ref"'],
      [{ ref: "e3" }, 'waiting on a ref needs a state'],
      [{ ref: "xyz", value: "x" }, '"ref" must look like "e1"'],
      [{ ref: "e3", value: "x", timeoutMs: 30_001 }, '"timeoutMs" must be an integer between 1 and 30000'],
      [{ stable: true, timeoutMs: 0 }, '"timeoutMs" must be an integer between 1 and 30000'],
      [{ stable: true, timeoutMs: 2.5 }, '"timeoutMs" must be an integer between 1 and 30000'],
    ];
    for (const [input, needle] of cases) {
      const r = await find(t, "computer_wait").execute(input);
      expect(r.isError).toBe(true);
      expect(r.content).toContain(needle);
    }
    expect(observeCalls(s)).toHaveLength(base); // 校验失败零采样
  });

  it("等待采样绝不改写观察态：wait 期间表一直在变，结束后旧 ref 仍可点（press argv 用原 sha）", async () => {
    const s = clockedSeam({ observe: [STATUS_DONE, STATUS_LOADING, STATUS_DONE, STATUS_LOADING], tickMs: 2_000 });
    const t = tools(s);
    await find(t, "screen_observe").execute({}); // 播种 refs（sha SHA_B——STATUS_DONE 的尾标）
    const rw = await find(t, "computer_wait").execute({ stable: true });
    expect(rw.isError).toBe(true); // 一直变 → 超时（不改变观察态的副作用面）
    const r = await find(t, "computer_click").execute({ ref: "e2" });
    expect(r.isError).toBeFalsy();
    const press = s.calls.find((c) => c.file === HELPER && c.args[0] === "press")!;
    expect(press.args).toEqual(["press", "2", "400", "20", "24000", SHA_B]);
  });

  it("观察目标随用户 observe：带 app 的观察 → wait 采样 argv 尾随同名 app", async () => {
    const s = clockedSeam({ observe: [STATUS_LOADING, STATUS_DONE], tickMs: 400 });
    const t = tools(s);
    await find(t, "screen_observe").execute({ app: "Notes" });
    const r = await find(t, "computer_wait").execute({ ref: "e3", value: "已完成" });
    expect(r.isError).toBeFalsy();
    expect(observeCalls(s)[1]!.args).toEqual(["observe", "400", "20", "24000", "Notes"]);
  });

  it("helper 缺席 → 结构化降级（观察助手不在场，同 observe 族指引），零派生", async () => {
    const s = clockedSeam({ observe: [STATUS_LOADING] });
    const t = createComputerTools({ exec: s, platform: "darwin", env: {}, helperExists: () => false, now: s.now });
    const r = await find(t, "computer_wait").execute({ stable: true });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("WUDAO_CLICK_HELPER");
    expect(s.calls).toHaveLength(0);
  });

  it("非 darwin → typed 拒（零派生）", async () => {
    const s = clockedSeam({ observe: [STATUS_LOADING] });
    const t = createComputerTools({ exec: s, platform: "linux", env: { WUDAO_CLICK_HELPER: HELPER }, helperExists: () => true, now: s.now });
    const r = await find(t, "computer_wait").execute({ stable: true });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("macOS");
    expect(s.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// R2 — 动作后 settle 验证行（六动作面统一缝；三态逐字；降级；绝不 fail 动作）
// ---------------------------------------------------------------------------
describe("ω99-250 R2 — 动作后 settle 验证行", () => {
  it("坐标动作基线采样 argv：动作前一次 observe（前台、预算三参）→ 动作 → 对比窗采样；未变行逐字", async () => {
    const s = clockedSeam({ observe: [STATUS_LOADING], tickMs: 100 });
    const t = tools(s);
    const r = await find(t, "computer_click").execute({ x: 42, y: 99 });
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe(`已在 (42, 99) 左键点击。\n${LINE_UNCHANGED}`);
    expect(s.calls[0]!.file).toBe(HELPER);
    expect(s.calls[0]!.args).toEqual(["observe", "400", "20", "24000"]);
    expect(s.calls[1]!.args).toEqual(["42", "99"]); // 244 坐标 argv 逐字不变
    expect(observeCalls(s)).toHaveLength(3); // 基线 + 两拍收敛
  });

  it("ref 动作基线零采样：lastObservation 即基线（press 的 sha 守卫保证新鲜）——press 仍是第二调用", async () => {
    const s = clockedSeam({ observe: [obs({ sha: SHA_A })], tickMs: 100 });
    const t = tools(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_click").execute({ ref: "e2" });
    expect(r.isError).toBeFalsy();
    expect(s.calls[1]!.args).toEqual(["press", "2", "400", "20", "24000", SHA_A]); // 247 press argv 逐字不变
    expect(r.content).toBe(`已点按 [e2] 按钮「添加」。\n${LINE_UNCHANGED}`);
  });

  it("已变化行逐字 + 行序：动作行 → 状态行（241）→ settle 行殿后", async () => {
    const s = clockedSeam({ observe: [STATUS_LOADING, STATUS_DONE, STATUS_DONE], tickMs: 100, status: "Safari\nGoogle\nAXButton" });
    const t = tools(s);
    const r = await find(t, "computer_click").execute({ x: 42, y: 99 });
    expect(r.isError).toBeFalsy();
    const lines = r.content.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("已在 (42, 99) 左键点击。");
    expect(lines[1]).toBe("当前状态：Safari · 窗口「Google」 · 焦点：按钮");
    expect(lines[2]).toBe(LINE_CHANGED);
  });

  it("未稳定行逐字：窗内一直在变 → 如实报 N 毫秒内未稳定（绝不编造成败结论）", async () => {
    const s = clockedSeam({ observe: [STATUS_LOADING, STATUS_DONE, STATUS_GONE, STATUS_LOADING], tickMs: 600 });
    const t = tools(s);
    const r = await find(t, "computer_click").execute({ x: 1, y: 2 });
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe(`已在 (1, 2) 左键点击。\n${LINE_RESTLESS}`);
  });

  it("无 AX 降级行逐字（树空）：基线采样为空树 → 不轮询、动作回执照常 + 降级行引走 screen_capture", async () => {
    const s = clockedSeam({ observe: [EMPTY_TREE], tickMs: 100 });
    const t = tools(s);
    const r = await find(t, "computer_key").execute({ key: "return" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe(`已按下 return。\n${LINE_NO_TREE}`);
    expect(observeCalls(s)).toHaveLength(1); // 基线一次即降级，零对比窗采样
  });

  it("无 AX 降级行（黑名单）：连续空观察已拉黑 → settle 不再硬试（零采样），降级行照给", async () => {
    const s = clockedSeam({ observe: [EMPTY_TREE], tickMs: 100 });
    const t = tools(s);
    await find(t, "screen_observe").execute({}); // 空 1
    await find(t, "screen_observe").execute({}); // 空 2 → 拉黑
    const before = observeCalls(s).length;
    const r = await find(t, "computer_scroll").execute({ dy: 300 });
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe(`已向下滚动 300 像素。\n${LINE_NO_TREE}`);
    expect(observeCalls(s)).toHaveLength(before); // 黑名单期内零采样（247 自愈闭环）
  });

  it("settle 采样异常绝不 fail 动作：基线不可解析 → 回执原样（单行）；对比窗采样失败 → 回执只到动作行", async () => {
    const s1 = clockedSeam({ observe: () => "garbage", tickMs: 100 });
    const r1 = await find(tools(s1), "computer_click").execute({ x: 7, y: 8 });
    expect(r1.isError).toBeFalsy();
    expect(r1.content).toBe("已在 (7, 8) 左键点击。");
    const s2 = clockedSeam({
      observe: [STATUS_LOADING, "garbage", "garbage"],
      tickMs: 100,
    });
    const r2 = await find(tools(s2), "computer_drag").execute({ startX: 1, startY: 2, endX: 3, endY: 4 });
    expect(r2.isError).toBeFalsy();
    expect(r2.content).toBe("已从 (1, 2) 拖到 (3, 4)。");
  });

  it("app_activate / computer_type（焦点路径）同缝：回执尾 settle 行照给（六动作面齐）", async () => {
    const s = clockedSeam({ observe: [STATUS_DONE], tickMs: 100 });
    const t = tools(s);
    const ra = await find(t, "app_activate").execute({ app: "Safari" });
    expect(ra.content).toBe(`已切换到 Safari。\n${LINE_UNCHANGED}`);
    const rt = await find(t, "computer_type").execute({ text: "hi" });
    expect(rt.content).toBe(`已在焦点处输入 2 个字符。\n${LINE_UNCHANGED}`);
  });
});

// ---------------------------------------------------------------------------
// R3 — 名册与挂载序（247 后 +1 = 十工具）；summarize wait 例；权限面
// ---------------------------------------------------------------------------
describe("ω99-250 R3 — 名册/挂载序/summarize", () => {
  const TEN = [
    "screen_capture", "computer_type", "computer_key", "computer_click", "app_activate", "app_list",
    "computer_scroll", "computer_drag", "screen_observe", "computer_wait",
  ];

  it("十工具名册：computer_wait 沿 247 序尾 append-only（九名序不变）", () => {
    expect(createComputerTools().map((t) => t.name)).toEqual(TEN);
  });

  it("挂载序字节钉：computer_wait 插在 screen_observe 之后、read_xlsx 之前", () => {
    const stubModel = { stream: async function* () { /* never invoked */ } } as unknown as never;
    const gate = async (): Promise<{ behavior: "allow" }> => ({ behavior: "allow" });
    const names = buildToolSet({ workspaceRoot: "/tmp/ws", model: stubModel, canUseTool: gate, contextWindowTokens: 64_000 }).map((t) => t.name);
    expect(names.indexOf("screen_capture")).toBe(names.indexOf("make_docx") + 1); // 头侧邻接不变
    expect(names[names.indexOf("computer_drag") + 1]).toBe("screen_observe");
    expect(names[names.indexOf("screen_observe") + 1]).toBe("computer_wait");
    expect(names[names.indexOf("computer_wait") + 1]).toBe("read_xlsx");
  });

  it("读面姿态：isReadOnly=true；不进 DEFAULT_ASK_TOOLS；四模式与 screen_observe 同判", () => {
    const w = createComputerTools().find((x) => x.name === "computer_wait")!;
    expect(w.isReadOnly?.({})).toBe(true);
    expect(isDefaultAskCall("computer_wait", {})).toBe(false);
    expect(DEFAULT_ASK_TOOLS.has("computer_wait")).toBe(false);
    for (const mode of ["auto", "workspace", "ask", "plan"] as const) {
      expect(decidePermission(mode, "computer_wait")).toEqual(decidePermission(mode, "screen_observe"));
    }
  });

  it("summarize wait 例（log.ts 单源）：ref+value / ref+title / stable / 裸缺席", () => {
    expect(summarizeToolCall("computer_wait", { ref: "e3", value: "已完成" })).toBe("[e3] 值「已完成」");
    expect(summarizeToolCall("computer_wait", { ref: "e2", title: "已连接" })).toBe("[e2] 标题「已连接」");
    expect(summarizeToolCall("computer_wait", { stable: true })).toBe("界面稳定");
    expect(summarizeToolCall("computer_wait", {})).toBe("");
  });

  it("schema 面钉：ref/value/title/stable/timeoutMs 五参在场、零 required；零删除通道（名与参数）", () => {
    const w = createComputerTools().find((x) => x.name === "computer_wait")!;
    expect(Object.keys(w.parameters.properties)).toEqual(["ref", "value", "title", "stable", "timeoutMs"]);
    expect(w.parameters.required).toBeUndefined();
    expect(/delete|remove|\brm\b/i.test(w.name)).toBe(false);
    for (const key of Object.keys(w.parameters.properties)) {
      expect(/delete|remove|\brm\b/i.test(key)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// R4 — 策略段裁定钉：不动（指导走工具描述缝；M24 既有字节零演进）
// ---------------------------------------------------------------------------
describe("ω99-250 R4 — 策略段裁定钉（不动）", () => {
  it("241 六守则字节零演进：策略段不含 wait/settle 语义新句（裁定=指导骑工具描述缝）", () => {
    expect(COMPUTER_STRATEGY_SECTION).not.toContain("computer_wait");
    expect(COMPUTER_STRATEGY_SECTION).not.toContain("settle");
    expect(COMPUTER_STRATEGY_SECTION).toContain("3-5 steps per batch"); // 241 原句在场（未被改写）
    expect(COMPUTER_STRATEGY_SECTION).toContain("do NOT screenshot to double-check");
  });

  it("wait 描述自带批内不截图指导（收益语言）：提到 screen_observe/screen_capture 出路与等法；零实现术语", () => {
    const w = createComputerTools().find((x) => x.name === "computer_wait")!;
    expect(w.description).toContain("screen_observe");
    expect(w.description).toContain("screen_capture");
    expect(w.description).toContain("5000");
    expect(w.description).toContain("30000");
    expect(w.description).toContain("无需逐动作截图");
    for (const jargon of ["sha256", "stateHash", "digest", "BFS", "AXValue"]) {
      expect(w.description).not.toContain(jargon);
    }
  });

  it("M24 最小面：既有九工具的描述零触碰（描述不提 wait——新语义只进新工具）", () => {
    const t = createComputerTools();
    for (const name of ["screen_capture", "computer_type", "computer_key", "computer_click", "app_activate", "app_list", "computer_scroll", "computer_drag", "screen_observe"]) {
      expect(t.find((x) => x.name === name)!.description).not.toContain("computer_wait");
    }
  });
});

// ---------------------------------------------------------------------------
// R5 — 回归钉：244 坐标路径 / 247 ref 路径 argv 逐字不变；黑名单语义零演进
// ---------------------------------------------------------------------------
describe("ω99-250 R5 — 244/247 回归钉", () => {
  it("244 坐标路径：无 capture 基准直通 argv 逐字不变（观察态在场也不改坐标路径）", async () => {
    const s = clockedSeam({ observe: [obs()], tickMs: 100 });
    const t = tools(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_click").execute({ x: 42, y: 99 });
    expect(r.isError).toBeFalsy();
    expect(s.calls.find((c) => c.file === HELPER && /^[0-9]+$/.test(c.args[0] ?? ""))!.args).toEqual(["42", "99"]);
    // scroll/drag 同口径
    const rs = await find(t, "computer_scroll").execute({ dy: 300 });
    expect(rs.isError).toBeFalsy();
    expect(s.calls.filter((c) => c.file === HELPER && c.args[0] === "scroll").map((c) => c.args)).toEqual([["scroll", "0", "0", "0", "-300"]]);
    const rd = await find(t, "computer_drag").execute({ startX: 100, startY: 200, endX: 400, endY: 500 });
    expect(rd.isError).toBeFalsy();
    expect(s.calls.filter((c) => c.file === HELPER && /^\d+$/.test(c.args[0] ?? "") && c.args.length === 4).map((c) => c.args)).toEqual([["100", "200", "400", "500"]]);
  });

  it("247 settext 路径 argv 逐字不变：观察 → type ref → settext argv 钉", async () => {
    const s = clockedSeam({ observe: [obs({ sha: SHA_A })], tickMs: 100 });
    const t = tools(s);
    await find(t, "screen_observe").execute({});
    const r = await find(t, "computer_type").execute({ ref: "e3", text: "hello" });
    expect(r.isError).toBeFalsy();
    expect(s.calls[1]!.args).toEqual(["settext", "3", "hello", "400", "20", "24000", SHA_A]);
    expect(r.content).toContain("5 个字符");
  });

  it("247 黑名单语义零演进：连续 N 次空观察 → 第 N+1 次 screen_observe 仍被拦（文案族不变）", async () => {
    const s = clockedSeam({ observe: [EMPTY_TREE], tickMs: 100 });
    const t = tools(s);
    const ob = find(t, "screen_observe");
    await ob.execute({});
    await ob.execute({});
    const r = await ob.execute({});
    expect(r.isError).toBe(true);
    expect(r.content).toContain("近期连续观察为空");
    expect(r.content).toContain("screen_capture");
  });
});

// ---------------------------------------------------------------------------
// R6 — 红线：零删除面（源码级）；本弧源不新增任何删除调用
// ---------------------------------------------------------------------------
describe("ω99-250 R6 — 红线（源码级零删除面）", () => {
  const src = async (p: string): Promise<string> => readFile(fileURLToPath(new URL(p, import.meta.url)), "utf8");

  it("tools.ts unlink 恒 6（capture 自清 + win32 层 8ca40407 三处 tmpdir 自清）；无 rmSync/rmdir", async () => {
    const t = await src("../src/computer/tools.ts");
    // 3→6：win32 执行层（8ca40407）合法新增三处 unlink 自落自清
    // （os.tmpdir 内 .catch(()=>{}) 形，2026-09-13 全量揭发升钉）。
    expect([...t.matchAll(/unlink/g)]).toHaveLength(6);
    expect(t).not.toContain("rmSync");
    expect(t).not.toContain("rmdir");
  });

  it("exec.ts 零删除 API（unlink/rmSync/rmdir 全无）", async () => {
    const e = await src("../src/computer/exec.ts");
    expect(e).not.toContain("unlink");
    expect(e).not.toContain("rmSync");
    expect(e).not.toContain("rmdir");
  });
});

// ---------------------------------------------------------------------------
// 纯层直钉：内容摘要 / 元素细读 / 谓词匹配 / settle 行渲染
// ---------------------------------------------------------------------------
describe("ω99-250 纯层 — digest/细读/谓词/行渲染", () => {
  it("observeContentDigest：值进摘要（settle 判变的基准——247 helper sha 刻意不含值，输入后不误报未变）；app/窗口/行全量", () => {
    const a = parseObserveOutput(STATUS_LOADING);
    const b = parseObserveOutput(STATUS_DONE);
    const c = parseObserveOutput(obs({ lines: LOADING_LINES, sha: SHA_C }));
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(observeContentDigest(a.table)).not.toBe(observeContentDigest(b.table)); // 值变 → 摘要变
    expect(observeContentDigest(a.table)).toBe(observeContentDigest(c.table)); // 同内容不同 sha → 摘要同
  });

  it("observeElementDetail：title/value/focused/disabled 四字段；JSON 转义值剥法；无 value（secure）→ undefined 不猜", () => {
    const d1 = observeElementDetail('  [e3] AXStaticText "状态" value="加载中" focused');
    expect(d1).toEqual({ ref: "e3", role: "AXStaticText", title: "状态", value: "加载中", disabled: false, focused: true });
    const d2 = observeElementDetail('  [e4] AXTextField value="a\\"b"');
    expect(d2?.value).toBe('a"b');
    const d3 = observeElementDetail('  [e5] AXSecureTextField "密码"');
    expect(d3?.value).toBeUndefined();
    expect(observeElementDetail("garbage")).toBeUndefined();
  });

  it("matchWaitElement：值等价匹配（角色+标题锁定）；等标题时标题不锁；无命中 → undefined", () => {
    const read = parseObserveOutput(STATUS_LOADING);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const table = read.table;
    const hit = matchWaitElement(table, { role: "AXStaticText", title: "状态" }, { value: "加载中" });
    expect(hit?.ref).toBe("e3");
    expect(matchWaitElement(table, { role: "AXStaticText", title: "状态" }, { value: "已完成" })).toBeUndefined();
    expect(matchWaitElement(table, { role: "AXButton", title: "提交" }, { title: "提交" })?.ref).toBe("e2");
    expect(matchWaitElement(table, { role: "AXSlider", title: "x" }, {})).toBeUndefined();
  });

  it("formatSettleLine 四态逐字（changed/unchanged/restless/no-tree）", () => {
    expect(formatSettleLine({ kind: "changed" })).toBe(LINE_CHANGED);
    expect(formatSettleLine({ kind: "unchanged" })).toBe(LINE_UNCHANGED);
    expect(formatSettleLine({ kind: "restless", windowMs: SETTLE_WINDOW_MS })).toBe(LINE_RESTLESS);
    expect(formatSettleLine({ kind: "no-tree" })).toBe(LINE_NO_TREE);
  });
});
