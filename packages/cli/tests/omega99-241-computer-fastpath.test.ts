// ω99-241: #8 — computer 快路径弧 A receipts（R1 状态行 + R2 prompt 节）。
// ★测试红线（212/220 既立红线沿承）：ExecSeam 全 mock——绝不真键鼠/截屏/
// 真 osascript 执行；夹具全内存零盘写；绝不删用户文件。core 侧批执行钉
// （R3）在 packages/core/tests/omega99-241-batch-sequential.test.ts。
import { describe, expect, it } from "vitest";
import {
  buildStatusScript,
  parseStatusOutput,
  formatStatusLine,
  fetchStatusLine,
  type ExecSeam,
  type ExecResult,
} from "../src/computer/exec.js";
import { createComputerTools } from "../src/computer/tools.js";
import {
  buildSystemPrompt,
  COMPUTER_STRATEGY_SECTION,
} from "../src/prompt.js";

// ---------------------------------------------------------------------------
// 缝 mock：动作与状态行按调用形状分流（状态脚本唯一带 AXFocusedUIElement；
// click/scroll/drag 的动作走 helper 路径，type/key/activate 的动作是
// osascript 但脚本不含该串）——一次缝两角色，全程零真派生。
// ---------------------------------------------------------------------------
const statusSeam = (
  status: { code?: number; stdout?: string; stderr?: string } = {},
  action: Partial<ExecResult> = {},
): ExecSeam & { calls: { file: string; args: string[] }[] } => {
  const calls: { file: string; args: string[] }[] = [];
  const seam: ExecSeam = async (file, args) => {
    calls.push({ file, args: [...args] });
    if (file === "osascript" && String(args[1] ?? "").includes("AXFocusedUIElement")) {
      return { stdout: "", stderr: "", code: 0, ...status } as ExecResult;
    }
    return { stdout: "", stderr: "", code: 0, ...action } as ExecResult;
  };
  return Object.assign(seam, { calls });
};

const find = (name: string, opts: Parameters<typeof createComputerTools>[0]) =>
  createComputerTools(opts).find((t) => t.name === name)!;

const FULL = "Safari\nGoogle\nAXTextField";
const FULL_LINE = "当前状态：Safari · 窗口「Google」 · 焦点：文本框";

// ---------------------------------------------------------------------------
// R1-纯层：状态脚本 / 解析 / 行形
// ---------------------------------------------------------------------------
describe("ω99-241 R1 纯层 — 状态行三件", () => {
  it("buildStatusScript 钉住：System Events 前台进程 + 窗口 1 标题 + AXFocusedUIElement 角色，一次 osascript", () => {
    const s = buildStatusScript();
    expect(s).toContain('tell application "System Events"');
    expect(s).toContain("frontmost is true");
    expect(s).toContain("name of window 1");
    expect(s).toContain('attribute "AXFocusedUIElement"');
    expect(s).toContain("role of");
    expect(s).toContain("linefeed");
  });

  it("安全纪律（逐字钉）：焦点元素只读角色，绝不读 value——脚本无 AXValue / contents of / 元素 value 读取面", () => {
    const s = buildStatusScript();
    // 唯一允许的 value of = 取 AXFocusedUIElement 属性（拿元素引用本身），
    // 不是读字段值；此外任何值读取面（AXValue/contents of/value of _p 的
    // 元素值）都必须缺席。
    const valueOfs = [...s.matchAll(/value of/g)].length;
    expect(valueOfs).toBe(1);
    expect(s).toContain('value of attribute "AXFocusedUIElement"');
    expect(s).not.toContain("AXValue");
    expect(s).not.toContain("contents of");
  });

  it("parseStatusOutput：三行 → 三元组；应用缺席 → ok:false（整行不附）；空白行容差", () => {
    expect(parseStatusOutput("Safari\nGoogle\nAXTextField")).toEqual({
      ok: true,
      status: { app: "Safari", title: "Google", role: "AXTextField" },
    });
    expect(parseStatusOutput("Finder\n\n").ok).toBe(true);
    expect(parseStatusOutput("\nGoogle\nAXTextField").ok).toBe(false);
    expect(parseStatusOutput("").ok).toBe(false);
    // CRLF 容差（osascript 输出行尾按平台）
    expect(parseStatusOutput("访达\r\n下载\r\nAXButton")).toEqual({
      ok: true,
      status: { app: "访达", title: "下载", role: "AXButton" },
    });
  });

  it("formatStatusLine 行形逐字：全态 / 无窗口缩略 / 焦点缺席缩略（不捏造不占位）", () => {
    expect(formatStatusLine({ app: "Safari", title: "Google", role: "AXTextField" })).toBe(FULL_LINE);
    expect(formatStatusLine({ app: "Finder", title: "", role: "" })).toBe("当前状态：Finder · 无窗口");
    expect(formatStatusLine({ app: "Safari", title: "Google", role: "" })).toBe("当前状态：Safari · 窗口「Google」");
    // 锚缺席 → 整行缺席（不输出半截状态）
    expect(formatStatusLine({ app: "", title: "x", role: "AXButton" })).toBeUndefined();
  });

  it("角色映射：常见 AX 角色 → 中文；未映射角色原样显示（诚实不捏造）", () => {
    expect(formatStatusLine({ app: "Safari", title: "登录", role: "AXSecureTextField" })).toContain("焦点：密码框");
    expect(formatStatusLine({ app: "Safari", title: "x", role: "AXButton" })).toContain("焦点：按钮");
    expect(formatStatusLine({ app: "Safari", title: "x", role: "AXTextArea" })).toContain("焦点：文本区");
    expect(formatStatusLine({ app: "Safari", title: "x", role: "AXSomeFutureRole" })).toContain("焦点：AXSomeFutureRole");
  });

  it("fetchStatusLine：seam ok → 行；code!==0 → undefined（诚实缺席）；stdout 空 → undefined", async () => {
    const okSeam: ExecSeam = async () => ({ stdout: FULL, stderr: "", code: 0 });
    expect(await fetchStatusLine(okSeam)).toBe(FULL_LINE);
    const failSeam: ExecSeam = async () => ({ stdout: "", stderr: "execution error", code: 1 });
    expect(await fetchStatusLine(failSeam)).toBeUndefined();
    const emptySeam: ExecSeam = async () => ({ stdout: "", stderr: "", code: 0 });
    expect(await fetchStatusLine(emptySeam)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// R1-工具面：六动作面尾附状态行（全 mock——★零真实键鼠/截屏/osascript）
// ---------------------------------------------------------------------------
describe("ω99-241 R1 工具面 — 六动作面状态行", () => {
  it("click：成功回执尾新行状态行；状态是第二次派生（helper → osascript 状态脚本）", async () => {
    const seam = statusSeam({ stdout: FULL });
    const click = find("computer_click", { exec: seam, helperExists: () => true });
    const r = await click.execute({ x: 42, y: 99 });
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe(`已在 (42, 99) 左键点击。\n${FULL_LINE}`);
    // ω99-250: #10 — 同形演进：坐标动作前新增 settle 基线采样（observe 一次
    // helper 调用；mock 空输出 → 基线不可用 → 无 settle 行）——动作顺移到
    // calls[1]，回执字节不变（settle 不附行=诚实缺席面钉）。
    // ω99-265: #3 — 同形演进：坐标单击 settle 后新增落点身份 hit（殿后第四
    // 笔；mock 空输出 → 信息行静默缺席）——回执字节不变（信息行不附=诚实
    // 缺席面钉）。
    expect(seam.calls).toHaveLength(4);
    expect(seam.calls[0]!.file).not.toBe("osascript"); // 基线采样（helper observe）
    expect(seam.calls[0]!.args[0]).toBe("observe");
    expect(seam.calls[1]!.file).not.toBe("osascript"); // helper 动作
    expect(seam.calls[2]!.file).toBe("osascript");
    expect(seam.calls[2]!.args[0]).toBe("-e");
    expect(seam.calls[2]!.args[1]).toContain("AXFocusedUIElement");
    expect(seam.calls[3]!.file).not.toBe("osascript"); // 落点身份 hit（265 殿后）
    expect(seam.calls[3]!.args[0]).toBe("hit");
  });

  it("type / key：成功回执尾附状态行", async () => {
    const seam = statusSeam({ stdout: FULL });
    const type = find("computer_type", { exec: seam });
    const rt = await type.execute({ text: "hello" });
    expect(rt.isError).toBeFalsy();
    expect(rt.content).toBe(`已在焦点处输入 5 个字符。\n${FULL_LINE}`);
    const key = find("computer_key", { exec: seam });
    const rk = await key.execute({ key: "return" });
    expect(rk.isError).toBeFalsy();
    expect(rk.content).toBe(`已按下 return。\n${FULL_LINE}`);
  });

  it("scroll / drag：成功回执尾附状态行", async () => {
    const seam = statusSeam({ stdout: FULL });
    const scroll = find("computer_scroll", { exec: seam, helperExists: () => true });
    const rs = await scroll.execute({ dy: 300 });
    expect(rs.isError).toBeFalsy();
    expect(rs.content).toBe(`已向下滚动 300 像素。\n${FULL_LINE}`);
    const drag = find("computer_drag", { exec: seam, helperExists: () => true });
    const rd = await drag.execute({ startX: 100, startY: 200, endX: 400, endY: 500 });
    expect(rd.isError).toBeFalsy();
    expect(rd.content).toBe(`已从 (100, 200) 拖到 (400, 500)。\n${FULL_LINE}`);
  });

  it("app_activate：activate 后状态行=目标应用前台的最直接验证", async () => {
    const seam = statusSeam({ stdout: FULL });
    const act = find("app_activate", { exec: seam });
    const r = await act.execute({ app: "Safari" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe(`已切换到 Safari。\n${FULL_LINE}`);
  });

  it("缩略形：无窗口 → 「无窗口」；窗口在焦点缺席 → 焦点段整段缺席", async () => {
    const seam = statusSeam({ stdout: "Finder\n\n" });
    const click = find("computer_click", { exec: seam, helperExists: () => true });
    const r = await click.execute({ x: 1, y: 2 });
    expect(r.content).toBe(`已在 (1, 2) 左键点击。\n当前状态：Finder · 无窗口`);
    const seam2 = statusSeam({ stdout: "Safari\nGoogle\n" });
    const key = find("computer_key", { exec: seam2 });
    const rk = await key.execute({ key: "tab" });
    expect(rk.content).toBe(`已按下 tab。\n当前状态：Safari · 窗口「Google」`);
  });

  it("降级纪律：状态 osascript 失败 → 整行不附，动作回执原样（单行原文）", async () => {
    const seam = statusSeam({ code: 1, stderr: "execution error" });
    const click = find("computer_click", { exec: seam, helperExists: () => true });
    const r = await click.execute({ x: 7, y: 8 });
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe("已在 (7, 8) 左键点击。");
    // 半截状态不放：回执里没有任何「当前状态」字样
    expect(r.content).not.toContain("当前状态");
  });

  it("密码框角色形：AXSecureTextField → 「密码框」，回执无 value 字样（值永不入上下文）", async () => {
    const seam = statusSeam({ stdout: "Safari\n登录\nAXSecureTextField" });
    const type = find("computer_type", { exec: seam });
    const r = await type.execute({ text: "x" });
    expect(r.content).toContain("当前状态：Safari · 窗口「登录」 · 焦点：密码框");
    expect(r.content).not.toContain("value");
  });

  it("screen_capture / app_list 回执不变：无状态行派生（osascript 状态调用零次）", async () => {
    const seam = statusSeam({ stdout: FULL });
    const list = find("app_list", { exec: seam });
    const r = await list.execute({});
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe("当前没有打开着窗口的应用。");
    expect(seam.calls).toHaveLength(1); // 只有 app_list 自己的一次 osascript
    expect(seam.calls[0]!.args[1]).not.toContain("AXFocusedUIElement");
    // screen_capture 视觉链缺席 → typed 拒，零状态行
    const cap = find("screen_capture", { exec: seam });
    const rc = await cap.execute({});
    expect(rc.isError).toBe(true);
    expect(rc.content).not.toContain("当前状态");
  });

  it("动作失败 → 错误回执不附状态行（失败面无验证语义）", async () => {
    const seam = statusSeam({ stdout: FULL }, { code: 1, stderr: "boom" });
    const key = find("computer_key", { exec: seam });
    const r = await key.execute({ key: "return" });
    expect(r.isError).toBe(true);
    expect(r.content).not.toContain("当前状态");
  });
});

// ---------------------------------------------------------------------------
// R2：prompt.ts computer 策略节
// ---------------------------------------------------------------------------
describe("ω99-241 R2 — computer 策略节（挂载=computer 工具启用同门）", () => {
  it("节在场：关键守则句逐字（批处理节奏/完成即停/键盘优先/直接导航/何时截图/复杂导航校验）", () => {
    const p = buildSystemPrompt("/tmp/ws", false, [], false, true);
    expect(p).toContain("# Computer operation");
    // 1 批处理节奏：3-5 步一批，同一回复连发
    expect(COMPUTER_STRATEGY_SECTION).toContain("3-5 steps per batch");
    expect(COMPUTER_STRATEGY_SECTION).toMatch(/SEVERAL tool calls in ONE reply/i);
    expect(COMPUTER_STRATEGY_SECTION).toMatch(/one step per turn/i);
    // 2 完成即停：状态行确认即收尾，不再截图复查
    expect(COMPUTER_STRATEGY_SECTION).toMatch(/status line/);
    expect(COMPUTER_STRATEGY_SECTION).toMatch(/do NOT screenshot to double-check/);
    // 3 键盘优先 + 系统启动器（win32 弧后双平台并书——钉随源演进，意图不变）
    expect(COMPUTER_STRATEGY_SECTION).toMatch(/Keyboard first/i);
    expect(COMPUTER_STRATEGY_SECTION).toContain("macOS Spotlight: cmd+space, type, return; Windows: the Windows key, type, return");
    // 4 直接导航
    expect(COMPUTER_STRATEGY_SECTION).toMatch(/known URL/);
    expect(COMPUTER_STRATEGY_SECTION).toMatch(/known file path/);
    // 5 何时才截图：像素级事实才截
    expect(COMPUTER_STRATEGY_SECTION).toMatch(/pixel-level facts/);
    // 6 复杂导航后校验
    expect(COMPUTER_STRATEGY_SECTION).toMatch(/confirm orientation/);
    expect(p).toContain(COMPUTER_STRATEGY_SECTION);
  });

  it("节缺席：computer 关（默认参）→ prompt 无该节；字节与基线全同", () => {
    const p = buildSystemPrompt("/tmp/ws");
    expect(p).not.toContain("# Computer operation");
    // 既有字节钉（M26 P1 工厂装配）不受新参影响
    expect(p).not.toContain(COMPUTER_STRATEGY_SECTION);
  });

  it("M24 前缀律：节是纯尾附——关版是开版的字节前缀，且关版以 Environment 尾收束不变", () => {
    const without = buildSystemPrompt("/tmp/ws");
    const withC = buildSystemPrompt("/tmp/ws", false, [], false, true);
    expect(withC.startsWith(without)).toBe(true);
    expect(withC.slice(without.length)).toBe(COMPUTER_STRATEGY_SECTION);
    // 关版尾部钉（prompt.test.ts 同款）：最后仍是语言行
    expect(without.endsWith("Respond in the same language the user writes in (中文 → 用中文回答).")).toBe(true);
  });

  it("字节稳定：同参两次构建逐字节相同（memoized 段，session 内不漂移）", () => {
    expect(buildSystemPrompt("/tmp/ws", false, [], false, true)).toBe(buildSystemPrompt("/tmp/ws", false, [], false, true));
  });
});
