// ω99-212: #1 — 电脑操作纯函数层：AppleScript 构造、键码表、长文分块、输出
// 净化、注入防线、helper 解析、权限失败分类。全纯（除 defaultExecSeam 一处
// child_process 缝）；工具面（tools.ts）与 receipts 全走这里，测试注入假缝
// ——绝不触真实键鼠/截屏。
//
// 注入防线（brief 钉）：app 名与 keystroke 文本一律过 applescriptEscape 进
// AppleScript 字面量（`\`→`\\`、`"`→`\"`、换行→`\\n` 两字符序列）；控制字符
// 在 sanitize 层 typed 拒（换行/Tab 走 computer_key，不嵌文本）。转义后字面量
// 无未转义引号 → 逃逸不可能，输出恒单行。
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// 缝与权限标记
// ---------------------------------------------------------------------------

/** 一次子进程调用的结果（永不抛——失败也是数据）。 */
export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  /** 进程退出码；被信号杀死/无法启动为 null。 */
  readonly code: number | null;
}

/** 子进程缝：生产=defaultExecSeam（osascript/screencapture/helper）；测试注入假件。 */
export type ExecSeam = (file: string, args: readonly string[]) => Promise<ExecResult>;

/** web 引导卡识别用机器标记（web 只匹配渲染，语义在 cli）。 */
export const PERM_MARKER_ACCESSIBILITY = "[wudao-perm:accessibility]";
export const PERM_MARKER_SCREEN_RECORDING = "[wudao-perm:screen-recording]";

/** 子进程调用超时（ms）——osascript/截屏/helper 都是有界操作。 */
export const EXEC_TIMEOUT_MS = 15_000;

/** 生产缝：execFile + 超时；错误归一成 ExecResult（永不抛）。 */
export function defaultExecSeam(): ExecSeam {
  return async (file, args) => {
    try {
      const { stdout } = await execFileAsync(file, [...args], {
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
      });
      return { stdout: String(stdout ?? ""), stderr: "", code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean; message?: string };
      return {
        stdout: String(e.stdout ?? ""),
        stderr: String(e.stderr ?? e.message ?? "spawn failed"),
        code: e.killed === true ? null : (e.code ?? -1),
      };
    }
  };
}

// ---------------------------------------------------------------------------
// 注入防线：AppleScript 字面量转义 + 输入净化
// ---------------------------------------------------------------------------

/** AppleScript 字面量转义（纯）：`\`→`\\`、`"`→`\"`、`\n`/`\r`→`\\n`。
 *  输出恒单行、字面量内无未转义引号——不可能逃出字符串执行任意脚本。 */
export function applescriptEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\n\r]+/g, "\\n");
}

/** 控制字符（含换行/Tab）——typing 与 app 名都拒（fail-closed typed 拒）。 */
const CONTROL_CHARS = /[\x00-\x1F\x7F]/;

/** 单次 keystroke 上限：超长输入模型该走多次 computer_type 或剪贴板（v1 不做剪贴板写入）。 */
export const TYPE_MAX_CHARS = 2_000;

export type TextCheck = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string };

/** keystroke 文本净化：非空字符串、≤TYPE_MAX_CHARS、无控制字符（换行/Tab 用
 *  computer_key 的 return/tab）。纯函数，永不抛。 */
export function sanitizeTypingText(raw: unknown): TextCheck {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, error: '"text" must be a non-empty string' };
  }
  if (raw.length > TYPE_MAX_CHARS) {
    return { ok: false, error: `"text" is limited to ${TYPE_MAX_CHARS} characters per call (got ${raw.length}); split across multiple computer_type calls` };
  }
  if (CONTROL_CHARS.test(raw)) {
    return { ok: false, error: '"text" must not contain control characters — send Enter/Tab via computer_key (key "return"/"tab"), not embedded newlines' };
  }
  return { ok: true, text: raw };
}

export const APP_NAME_MAX_CHARS = 200;

/** app 名净化：非空、≤200、无控制字符。引号合法（转义层兜底注入）。 */
export function sanitizeAppName(raw: unknown): TextCheck {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, error: '"app" must be a non-empty application name (e.g. "Safari") or bundle id (e.g. "com.apple.Calculator")' };
  }
  const name = raw.trim();
  if (name.length > APP_NAME_MAX_CHARS) {
    return { ok: false, error: `"app" is limited to ${APP_NAME_MAX_CHARS} characters, got ${name.length}` };
  }
  if (CONTROL_CHARS.test(name)) {
    return { ok: false, error: '"app" must not contain control characters (a real application name never does)' };
  }
  return { ok: true, text: name };
}

// ---------------------------------------------------------------------------
// 长文分块（>120 字符切块、块间 delay、CJK 不劈 surrogate）
// ---------------------------------------------------------------------------

/** 分块阈值（code point 计）：一次超长 keystroke 在系统层易超时丢字——分块逐发。 */
export const TYPE_CHUNK_CHARS = 120;
/** 块间停顿（秒，AppleScript delay 表达式里的字面值）。 */
export const TYPE_CHUNK_DELAY = "0.12";

/** 按 code point 切块（Array.from 天然不劈 surrogate 对）。纯函数。 */
export function chunkTypingText(text: string, chunkChars: number = TYPE_CHUNK_CHARS): readonly string[] {
  if (chunkChars < 1) chunkChars = TYPE_CHUNK_CHARS;
  const cps = Array.from(text);
  const chunks: string[] = [];
  for (let i = 0; i < cps.length; i += chunkChars) {
    chunks.push(cps.slice(i, i + chunkChars).join(""));
  }
  return chunks;
}

/** keystroke 脚本：单块一行；多块每块一行、块间 `delay` 行。纯函数。 */
export function buildTypeScript(text: string): string {
  const chunks = chunkTypingText(text);
  const lines: string[] = [];
  chunks.forEach((c, i) => {
    if (i > 0) lines.push(`delay ${TYPE_CHUNK_DELAY}`);
    lines.push(`tell application "System Events" to keystroke "${applescriptEscape(c)}"`);
  });
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 键码表（macOS System Events 虚拟键码；白名单外一律拒）
// ---------------------------------------------------------------------------

/** 名 → 键码（kVK_ANSI_*）。白名单：不在此表的名字（含 99999 之类乱码）拒绝。 */
export const KEY_TABLE: Readonly<Record<string, number>> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11,
  q: 12, w: 13, e: 14, r: 15, y: 16, t: 17, o: 31, u: 32, i: 34, p: 35,
  l: 37, j: 38, k: 40, n: 45, m: 46,
  "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
  return: 36, tab: 48, space: 49, delete: 51, escape: 53, forwarddelete: 117,
  left: 123, leftarrow: 123, right: 124, rightarrow: 124, down: 125, downarrow: 125,
  up: 126, uparrow: 126, home: 115, end: 119, pageup: 116, pagedown: 121, help: 114,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101,
  f10: 109, f11: 103, f12: 111,
};

/** 修饰键别名 → AppleScript 修饰名（组合输出按此规范序）。 */
const MODIFIER_TABLE: Readonly<Record<string, string>> = {
  cmd: "command", command: "command", super: "command",
  ctrl: "control", control: "control",
  alt: "option", option: "option", opt: "option",
  shift: "shift",
};
const MODIFIER_ORDER: readonly string[] = ["command", "control", "option", "shift"];

export type KeyCombo =
  | { readonly ok: true; readonly keyCode: number; readonly keyName: string; readonly modifiers: readonly string[] }
  | { readonly ok: false; readonly error: string };

/** 解析 "cmd+c" / "return" / "shift+cmd+t"：最后一段是键（白名单），其余是修饰。
 *  白名单外（未知名、数字乱码如 99999、未知修饰）typed 拒。纯函数。 */
export function resolveKeyCombo(spec: unknown): KeyCombo {
  if (typeof spec !== "string" || spec.trim() === "") {
    return { ok: false, error: '"key" must look like "cmd+c", "return", "shift+cmd+t" (see computer_key description for the built-in key list)' };
  }
  const parts = spec.split("+").map((p) => p.trim().toLowerCase()).filter((p) => p !== "");
  if (parts.length === 0) {
    return { ok: false, error: '"key" must not be empty' };
  }
  const keyName = parts[parts.length - 1]!;
  const keyCode = KEY_TABLE[keyName];
  if (keyCode === undefined) {
    return { ok: false, error: `unknown key "${keyName}" — only built-in whitelisted key names are allowed (letters, digits, return/tab/space/delete/escape, arrows, home/end/pageup/pagedown, f1–f12)` };
  }
  const mods = new Set<string>();
  for (const raw of parts.slice(0, -1)) {
    const m = MODIFIER_TABLE[raw];
    if (m === undefined) {
      return { ok: false, error: `unknown modifier "${raw}" — allowed: cmd/ctrl/alt(option)/shift` };
    }
    mods.add(m);
  }
  return {
    ok: true,
    keyCode,
    keyName,
    modifiers: MODIFIER_ORDER.filter((m) => mods.has(m)),
  };
}

/** key code 脚本：`key code N {command down, …}`（修饰按规范序）。纯函数。 */
export function buildKeyScript(spec: unknown): { readonly ok: true; readonly script: string } | { readonly ok: false; readonly error: string } {
  const combo = resolveKeyCombo(spec);
  if (!combo.ok) return combo;
  const modPart = combo.modifiers.length > 0 ? ` {${combo.modifiers.map((m) => `${m} down`).join(", ")}}` : "";
  return { ok: true, script: `tell application "System Events" to key code ${combo.keyCode}${modPart}` };
}

// ---------------------------------------------------------------------------
// app_activate / app_list（AppleScript 构造 + 输出净化）
// ---------------------------------------------------------------------------

/** 反 DNS 形（至少一段点分层、段内字母数字/连字符）→ `tell application id`；
 *  其余按名字。纯函数。 */
const BUNDLE_ID_SHAPE = /^[A-Za-z0-9]+(?:\.[A-Za-z0-9-]+)+$/;

export function buildActivateScript(app: string): { readonly ok: true; readonly script: string } | { readonly ok: false; readonly error: string } {
  const check = sanitizeAppName(app);
  if (!check.ok) return { ok: false, error: check.error };
  const escaped = applescriptEscape(check.text);
  // 名字已无控制字符、转义后无未转义引号——两形都注入安全。
  return BUNDLE_ID_SHAPE.test(check.text)
    ? { ok: true, script: `tell application id "${escaped}" to activate` }
    : { ok: true, script: `tell application "${escaped}" to activate` };
}

/** 前台进程清单脚本（钉住语义：background only is false）。纯函数。 */
export function buildListAppsScript(): string {
  return 'tell application "System Events" to get name of every process whose background only is false';
}

export const PROCESS_LIST_CAP = 80;

/** osascript 输出净化（纯）：逗号切分、去引号、去空、去重、封顶。 */
export function parseProcessList(stdout: string): readonly string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of stdout.split(/[\n,]+/)) {
    const name = raw.trim().replace(/^"+|"+$/g, "");
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    if (names.length < PROCESS_LIST_CAP) names.push(name);
  }
  return names;
}

// ---------------------------------------------------------------------------
// click helper 解析 + 权限失败分类 + 截屏空图启发
// ---------------------------------------------------------------------------

/** helper 文件名（sidecar 旁 / env 覆盖）。 */
export const CLICK_HELPER_NAME = "wudao-click";

/** 解析点击 helper 路径：env WUDAO_CLICK_HELPER（显式意图，直用）→ 可执行
 *  同目录 → macOS 包 Resources/sidecar-resources/。全不在场 → undefined（工具
 *  给结构化降级错误，绝不半坏）。纯函数（盘检经注入的 existsFn）。 */
export function resolveClickHelper(
  env: NodeJS.ProcessEnv,
  existsFn: (path: string) => boolean = existsSync,
  execPath: string = process.execPath,
): string | undefined {
  const fromEnv = (env.WUDAO_CLICK_HELPER ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  const candidates = [
    join(dirname(execPath), CLICK_HELPER_NAME),
    join(dirname(execPath), "..", "Resources", "sidecar-resources", CLICK_HELPER_NAME),
  ];
  return candidates.find((p) => existsFn(p));
}

// ω99-220: #2 — scroll/drag 的 helper argv 构造（纯函数，守卫先于派生）。
// 纯数字参数无 AppleScript 转义需求（不经 osascript），helper argv 直传。

/** 单轴滚动增量上限：超过一屏量级的单次滚动不可控——拒（fail-closed）。 */
export const SCROLL_DELTA_MAX = 10_000;

export type ScrollArgs =
  | { readonly ok: true; readonly args: readonly string[] }
  | { readonly ok: false; readonly error: string };

/** scroll helper argv（纯）。工具面口径：dy 必填、正=向下（去页尾、继续
 *  读）、负=向上（回页首）；dx 可选、正=向右、负=向左——阅读方向为正，
 *  贴用户语言。helper 的 wheel1 正=向上，dy 在这里取负翻转（dx 直传：
 *  helper 侧 wheel2=-dx 自带一次翻转，两负相抵=方向不变）。helper 现签
 *  名的 x/y 槽位解析即弃（滚轮事件贴系统光标）——占位 0 0 过其 coord
 *  校验。整数/非零/界内守卫：零增量与巨增量都拒。
 *  ω99-244: 守卫收模型值（fail-closed 对模型输入——增量上限按模型量纲
 *  收），argv 出换算后的屏幕点值：scale=屏幕点宽/最近一次 capture 输出宽
 *  （有基准时 >0；缺省 1=无基准直通——现状语义零漂移）；四舍五入 Math.round
 *  （.5 向 +∞，负值同律）。 */
/** 屏幕点（ref 路径的坐标载体）：观察表 @cx,cy 的原值——点空间直通，绝不经
 *  captureScale 换算（观察表坐标天然是屏幕点；换算只属于坐标路径）。 */
export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export function buildScrollArgs(dx: unknown, dy: unknown, scale = 1, at?: ScreenPoint): ScrollArgs {
  if (typeof dy !== "number" || !Number.isInteger(dy)) {
    return { ok: false, error: '"dy" must be an integer (scroll pixels; positive = down, negative = up)' };
  }
  let dxv = 0;
  if (dx !== undefined) {
    if (typeof dx !== "number" || !Number.isInteger(dx)) {
      return { ok: false, error: '"dx" must be an integer (horizontal scroll pixels; positive = right, negative = left)' };
    }
    dxv = dx;
  }
  if (dy === 0 && dxv === 0) {
    return { ok: false, error: 'scroll needs a non-zero delta — at least one of "dy"/"dx" must be non-zero' };
  }
  if (Math.abs(dy) > SCROLL_DELTA_MAX || Math.abs(dxv) > SCROLL_DELTA_MAX) {
    return { ok: false, error: `scroll deltas are limited to ${SCROLL_DELTA_MAX} pixels per call (got dy=${dy}, dx=${dxv}); split into multiple computer_scroll calls` };
  }
  const sx = Math.round(dxv * scale);
  const sy = Math.round(dy * scale);
  // at 在场（ref 路径）：x/y 槽位=屏幕点原值直通（绕过换算——口径主钉），
  // 增量仍按模型量纲换算（换的是距离不是位置）；尾随 at 旗标=helper 先把
  // 光标移到 (x,y) 再发滚轮。at 缺席：占位 0 0 形字节不变（指针路径照旧）。
  if (at !== undefined) {
    return { ok: true, args: ["scroll", String(at.x), String(at.y), String(sx), String(-sy), "at"] };
  }
  return { ok: true, args: ["scroll", "0", "0", String(sx), String(-sy)] };
}

/** drag helper argv（纯）。四坐标守卫与 click 同口径：有限、非负整数；
 *  button 只收 left（默认）/right。helper 面：drag x1 y1 x2 y2 [right]，
 *  down 在起点、插值移动、up 在终点——插值节奏是 helper 内部事。
 *  ω99-244: 守卫收模型值（图像空间坐标），argv 出换算后屏幕点（scale 缺
 *  省 1=无基准直通；Math.round .5 向 +∞）——与 buildScrollArgs 同律。 */
export function buildDragArgs(
  startX: unknown, startY: unknown, endX: unknown, endY: unknown, button?: unknown, scale = 1,
  startAt?: ScreenPoint, endAt?: ScreenPoint,
): ScrollArgs {
  // ref 端（startAt/endAt）覆盖对应坐标对：覆盖端=屏幕点原值直通（绕过换算
  // ——口径分轨），对应坐标参数不再校验（可省）；未覆盖端照旧像素守卫+换算
  // ——同一动作两端可混搭（startRef+endX/endY=「把元素拖到屏幕某处」常见形）。
  // 两端各自至少一种形式（ref 或坐标）必须在场：覆盖端缺席校验即此语义
  // （坐标端非法/缺席 → typed 拒，ref 端由 tools.ts 先行解析）。
  const ends: readonly { readonly names: readonly [string, string]; readonly coords: readonly [unknown, unknown]; readonly at: ScreenPoint | undefined }[] = [
    { names: ["startX", "startY"], coords: [startX, startY], at: startAt },
    { names: ["endX", "endY"], coords: [endX, endY], at: endAt },
  ];
  for (const end of ends) {
    if (end.at !== undefined) continue;
    for (const [i, name] of end.names.entries()) {
      const v = end.coords[i]!;
      if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
        return { ok: false, error: `"${name}" must be a non-negative integer (screen pixels from screen_capture's image); got ${JSON.stringify(v)}` };
      }
    }
  }
  if (button !== undefined && button !== "left" && button !== "right") {
    return { ok: false, error: '"button" must be "left" (default) or "right"' };
  }
  const pt = (v: unknown): string => String(Math.round((v as number) * scale)); // 守卫已过（上循环）
  const atPt = (p: ScreenPoint): readonly [string, string] => [String(p.x), String(p.y)]; // 原值直通（守卫已在 tools.ts 的 ref 解析）
  const startPt: readonly [string, string] = startAt !== undefined ? atPt(startAt) : [pt(startX), pt(startY)];
  const endPt: readonly [string, string] = endAt !== undefined ? atPt(endAt) : [pt(endX), pt(endY)];
  const args = [...startPt, ...endPt];
  if (button === "right") args.push("right");
  return { ok: true, args };
}

/** osascript 失败分类：-1743（不允许辅助访问）/ assistive → "accessibility"
 *  （web 引导卡标记）；其余 undefined（普通错误照实透传）。纯函数。 */
export function classifyOsascriptFailure(stderr: string): "accessibility" | undefined {
  const t = stderr.toLowerCase();
  if (t.includes("-1743") || t.includes("assistive")) return "accessibility";
  return undefined;
}

/** 截屏空图字节门：无「屏幕录制」权限时 macOS 仍产出文件，但内容近乎全黑
 *  纯色、极小（全屏 PNG 正常几十 KB 起）。低于门=按权限缺失处理（typed 错误
 *  走引导卡，而非把黑图喂给模型）。纯函数。 */
export const SCREENSHOT_MIN_BYTES = 20_000;

export function isBlankScreenshot(bytes: Uint8Array): boolean {
  return bytes.byteLength < SCREENSHOT_MIN_BYTES;
}

/** 截屏临时文件路径（os.tmpdir——工具自落自清，永不进用户目录）。 */
export function captureTmpPath(): string {
  return join(tmpdir(), `wudao-screen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
}

// ω99-241: #1 — 动作回执状态行（osascript 最小验证语义）。六动作面（click/
// type/key/scroll/drag + app_activate）成功回执尾附一行「当前状态」三元组
// （前台应用 · 其最前窗口标题 · 焦点元素角色）——回执自带验证语义：模型看得
// 见「动了之后世界变成什么样」，不必每步截图复查（ω99-239 R4 根因）。
//
// 安全纪律（the upstream formatsecure 移植，逐字钉）：焦点元素**只读角色，绝不读 value**——
// AXSecureTextField 场景角色显示「密码框」，值永不入上下文。
//
// 降级纪律：osascript 任一步失败 → 整行不附（诚实缺席，不放半截状态）；动作
// 本身照常成功回执。行形逐字钉：
//   `当前状态：<应用> · 窗口「<标题>」 · 焦点：<角色>`
// 段缺席时缩略（如 `当前状态：Finder · 无窗口`）——不捏造不占位。

/** 状态行脚本：一次 osascript 取三元组。前台进程名锚定（缺席 → 整行不附）；
 *  窗口标题 / 焦点角色各裹 try（窗口可以没有、焦点可以不在任何可及元素上）；
 *  三段以 linefeed 连接返回（应用名与角色永不含换行，标题实践上单行）。
 *  脚本唯一的 value of = 取 AXFocusedUIElement **元素引用本身**（拿的是角色
 *  的载体，不是字段值）——除此之外无任何值读取面。纯函数。 */
export function buildStatusScript(): string {
  return [
    'tell application "System Events"',
    "\tset _p to first application process whose frontmost is true",
    "\tset _app to name of _p",
    '\tset _title to ""',
    '\tset _role to ""',
    "\ttry",
    "\t\tset _title to name of window 1 of _p",
    "\tend try",
    "\ttry",
    '\t\tset _role to role of (value of attribute "AXFocusedUIElement" of _p)',
    "\tend try",
    "\treturn _app & linefeed & _title & linefeed & _role",
    "end tell",
  ].join("\n");
}

/** 状态三元组（title/role 可空串=该段缺席；app 是锚）。 */
export interface FrontmostStatus {
  readonly app: string;
  readonly title: string;
  readonly role: string;
}

export type StatusRead = { readonly ok: true; readonly status: FrontmostStatus } | { readonly ok: false };

/** osascript 状态输出解析（纯）：三行 → 三元组；首行（应用锚）缺席 → ok:false
 *  （整行不附——锚都不在就没有可验证的状态）。CRLF 行尾容差。永不抛。 */
export function parseStatusOutput(stdout: string): StatusRead {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim());
  const app = lines[0] ?? "";
  if (app === "") return { ok: false };
  return { ok: true, status: { app, title: lines[1] ?? "", role: lines[2] ?? "" } };
}

/** 常见 AX 角色 → 中文显示（回执族中文）；未映射角色原样显示（诚实不捏造）。 */
export const ROLE_DISPLAY: Readonly<Record<string, string>> = {
  AXSecureTextField: "密码框",
  AXTextField: "文本框",
  AXSearchField: "搜索框",
  AXTextArea: "文本区",
  AXButton: "按钮",
  AXCheckBox: "复选框",
  AXRadioButton: "单选按钮",
  AXPopUpButton: "下拉选择",
  AXMenu: "菜单",
  AXMenuItem: "菜单项",
  AXStaticText: "文本",
  AXLink: "链接",
  AXImage: "图片",
  AXWebArea: "网页区域",
  AXGroup: "容器",
  AXWindow: "窗口",
  AXList: "列表",
  AXTable: "表格",
  AXSlider: "滑块",
  AXTabGroup: "标签页组",
};

export function displayRole(role: string): string {
  return ROLE_DISPLAY[role] ?? role;
}

/** 状态行渲染（纯，行形逐字钉）：`当前状态：<应用> · 窗口「<标题>」 · 焦点：<角色>`。
 *  title 缺席 → ` · 无窗口`；role 缺席 → 焦点段整段缺席；app 缺席 → undefined
 *  （整行不附，不放半截状态）。 */
export function formatStatusLine(status: FrontmostStatus): string | undefined {
  if (status.app === "") return undefined;
  let line = `当前状态：${status.app}`;
  line += status.title === "" ? " · 无窗口" : ` · 窗口「${status.title}」`;
  if (status.role !== "") line += ` · 焦点：${displayRole(status.role)}`;
  return line;
}

/** 一次 osascript 取状态行（缝注入——测试喂假件，绝不真派生）。失败/锚缺席 →
 *  undefined（调用方原样回执，诚实缺席）。 */
export async function fetchStatusLine(exec: ExecSeam): Promise<string | undefined> {
  const r = await exec("osascript", ["-e", buildStatusScript()]);
  if (r.code !== 0) return undefined;
  const read = parseStatusOutput(r.stdout);
  if (!read.ok) return undefined;
  return formatStatusLine(read.status);
}

/** 权限引导文案（cli 错误自含出路；web 引导卡有自己的分步渲染）。 */
export const ACCESSIBILITY_GUIDE =
  "需要「辅助功能」权限：打开 系统设置 → 隐私与安全性 → 辅助功能，勾选 wudao 所在应用（桌面版为 wudao-harness-desktop；终端运行请勾选终端）后重试";
export const SCREEN_RECORDING_GUIDE =
  "需要「屏幕录制」权限：打开 系统设置 → 隐私与安全性 → 屏幕录制，勾选 wudao 所在应用后重启应用再试";

// ω99-244: #1 — 规范分辨率输出链 + 主屏点尺寸查询（computer 弧 C 坐标系闭环
// 的纯层）。三件纪律：
//   1. capture 落盘后长边 >CAPTURE_MAX_EDGE 才 sips -Z 原地缩。sips -Z 语义
//      （实测钉）=「最大边重采样到目标值、保纵横比、会放大小图」——小图零缩
//      放调用，防糊防浪费 token；这正是「长边约束」而非「宽约束」的裁定依据。
//   2. 输出尺寸用 sips -g pixelWidth/pixelHeight 实测回读，绝不假设 2x 或任
//      何固定比例——实测值就是该次 capture 的坐标系基准（截图可能已被缩放过，
//      推导必错，回读必对）。
//   3. 主屏点尺寸走 osascript JXA NSScreen（screens.firstObject=主屏=CG 全局
//      原点 (0,0) 所在屏=screencapture 单文件目标屏；frame 是点空间；JXA 的
//      NSArray 不可 [0] 索引、firstObject 可用——实测钉）。纯显示器几何查询，
//      零 TCC 授权弹窗。坐标换算=屏幕点宽/截图输出宽（单一标量比例，纵横比
//      缩放保比下 x/y 同比例），全在 TS 侧完成——模型永远不知道 DPR 存在。

/** 规范分辨率长边上限（sips -Z 语义=最大边；不拉伸变形——纵横比保持）。 */
export const CAPTURE_MAX_EDGE = 1280;

/** sips -g pixelWidth/pixelHeight 输出解析（纯）：实况形状 `<path>\n  pixelWidth: W\n  pixelHeight: H`；
 *  任一维缺席/非正整数 → undefined（fail-closed——坐标系基准不可知就不发图）。 */
export function parseSipsSize(stdout: string): { readonly w: number; readonly h: number } | undefined {
  const w = stdout.match(/pixelWidth:\s*(\d+)/);
  const h = stdout.match(/pixelHeight:\s*(\d+)/);
  if (w === null || h === null) return undefined;
  const width = Number(w[1]);
  const height = Number(h[1]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return undefined;
  return { w: width, h: height };
}

/** 一次 sips 读图尺寸（缝注入——测试喂假件，绝不真 sips）。失败/不可解析 → undefined。 */
export async function readImageSize(exec: ExecSeam, path: string): Promise<{ readonly w: number; readonly h: number } | undefined> {
  const r = await exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path]);
  if (r.code !== 0) return undefined;
  return parseSipsSize(r.stdout);
}

/** 主屏点尺寸脚本（JXA，纯函数）：screens.firstObject=主屏；frame 尺寸是点空间。 */
export function buildScreenPointsScript(): string {
  return 'ObjC.import("AppKit"); var f = $.NSScreen.screens.firstObject.frame; f.size.width + "x" + f.size.height';
}

/** 主屏点尺寸（点空间——CGEvent 坐标空间）。 */
export type ScreenPoints = { readonly w: number; readonly h: number };

/** JXA 输出解析（纯）：`1440x900`；不匹配/非正整数 → undefined。 */
export function parseScreenPoints(stdout: string): ScreenPoints | undefined {
  const m = stdout.trim().match(/^(\d+)x(\d+)$/);
  if (m === null) return undefined;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return undefined;
  return { w, h };
}

/** 一次 osascript JXA 取主屏点尺寸（缝注入——测试喂假件，绝不真 osascript）。
 *  失败 → undefined：capture 照常成功（截图本身是有效产物），坐标按无基准直
 *  通——诚实降级，绝不拿上一张图的过期基准顶（换图后旧比例必错）。 */
export async function fetchScreenPoints(exec: ExecSeam): Promise<ScreenPoints | undefined> {
  const r = await exec("osascript", ["-l", "JavaScript", "-e", buildScreenPointsScript()]);
  if (r.code !== 0) return undefined;
  return parseScreenPoints(r.stdout);
}

// ω99-247: #1 — screen_observe 的纯层（browser_snapshot ref 范式桌面移植）。
// 三件纪律沿 browser snapshot.ts 的心智模型逐条对齐：
//   1. ref 语法与 browser 同一形（e<正整数>，validRef 单源复用）——一个心智
//      模型跨 browser_snapshot 与 screen_observe，认知与代码双重复用。
//   2. 观察输出=带编号元素表（`[eN] role "title" value=…` 行），预算三参
//      （maxNodes/maxDepth/maxTextBytes——the upstream formatobserveSnapshot 范式）封顶；
//      未列出（被截断）的元素没有编号——refs map 只收「行幸存」的编号
//      （browser 纪律：模型看不见的 ref 是绝不发放的空头承诺）。
//   3. secure 字段（AXSecureTextField）绝不输出 value——helper 侧守卫
//      （比 the upstream format的 value="[secure]" 占位更严：本弧连占位都不给）；TS 侧的
//      回执层纪律=ref 命中只点名 role/title，永不回显 value（241 状态行
//      同源纪律的桌面元素版）。
// helper 输出契约（stdout，全 mock 可测）：
//   WUDAO_OBSERVE app=<名>
//   WUDAO_WINDOW <标题>
//   <元素行>…（每行 `[eN] role "title" value=… [disabled] [focused]`）
//   WUDAO_END nodes=<n> truncated=<0|1> sha256=<hex>
// sha256=当次观察的元素树身份（helper 内部按 app+窗口+逐元素身份行哈希）；
// press/settext 前置同参重观察 + 比对——不符=stale（exit 6），fail-closed
// 在任何 AX 动作之前（the upstream formatstateHash 纪律），TS 绝不静默改坐标猜。

/** 预算三钉（the upstream format范式、数值按我方口径裁定，见弧报告 §一）：
 *  maxNodes=400（browser 元素帽 200 的两倍——AX 树连容器一起枚举）、
 *  maxDepth=20（the upstream format同值）、maxTextBytes=24000（UTF-8 字节——browser
 *  12000 字符预算的家族量级）。预算是固定纪律不是模型可调参数（browser
 *  MAX_SNAPSHOT_CHARS 同款单源常量）。 */
export const OBSERVE_MAX_NODES = 400;
export const OBSERVE_MAX_DEPTH = 20;
export const OBSERVE_MAX_TEXT_BYTES = 24_000;

/** observe helper argv（纯）：预算三参固定、app 缺席=观察前台、给出则尾随。 */
export function buildObserveArgs(app?: string): readonly string[] {
  return ["observe", String(OBSERVE_MAX_NODES), String(OBSERVE_MAX_DEPTH), String(OBSERVE_MAX_TEXT_BYTES), ...(app !== undefined ? [app] : [])];
}

/** ref 形状=e<正整数>（browser validRef 同一语法——跨域单心智模型）。 */
export function validObserveRef(raw: unknown): raw is string {
  return typeof raw === "string" && /^e[1-9][0-9]{0,4}$/.test(raw);
}

/** ref → helper 索引（e3 → "3"）：helper 的编号是 1 起整数。 */
const refIndex = (ref: string): string => ref.slice(1);

export type HelperArgs =
  | { readonly ok: true; readonly args: readonly string[] }
  | { readonly ok: false; readonly error: string };

/** press helper argv（纯）：`press <index> <预算三参> <sha256> [app]`——
 *  sha 随行=stale 守卫的凭据（helper 同参重观察后比对）。ref 校验先行。 */
export function buildPressArgs(ref: unknown, sha: string, app?: string): HelperArgs {
  if (!validObserveRef(ref)) {
    return { ok: false, error: `"ref" must look like "e1", "e2", … (from screen_observe's [eN] table); got ${JSON.stringify(ref)}` };
  }
  const budgets = buildObserveArgs().slice(1); // ["400","20","24000"]——app 不掺进预算段
  return { ok: true, args: ["press", refIndex(ref), ...budgets, sha, ...(app !== undefined ? [app] : [])] };
}

/** settext helper argv（纯）：`settext <index> <text> <预算三参> <sha256> [app]`。
 *  文本已在工具面过 sanitizeTypingText（无控制字符、≤2000）——argv 直载。 */
export function buildSettextArgs(ref: unknown, text: string, sha: string, app?: string): HelperArgs {
  if (!validObserveRef(ref)) {
    return { ok: false, error: `"ref" must look like "e1", "e2", … (from screen_observe's [eN] table); got ${JSON.stringify(ref)}` };
  }
  const budgets = buildObserveArgs().slice(1);
  return { ok: true, args: ["settext", refIndex(ref), text, ...budgets, sha, ...(app !== undefined ? [app] : [])] };
}

// ω99-257: #3 — 观察行的位置面（scroll/drag 补 ref 寻址的数据半边）。helper
// 在 title 段后、value 段前发 ` @cx,cy`（元素中心=AXPosition+AXSize/2，四舍
// 五入整数，多屏可为负）。三件裁定：
//   1. 位置天然是屏幕点（AX 全局坐标与 CGEvent 同空间）——ref 路径的坐标
//      **绕过 captureScale 换算**（守卫在 tools.ts/builders：坐标路径=像素入/
//      点出，ref 路径=点直通——两条轨道显式分立，绝不双重换算）。
//   2. 新旧两形并存：旧形（无 @——旧版桌面 helper 二进制）照常解析，x/y=
//      undefined（诚实缺席）；scroll/drag 用无位置 entry → typed 出路（升级
//      指引），绝不编造坐标。
//   3. title 捕获组改严格引号形（escape-aware，与 DETAIL_LINE 同尺）——贪婪
//      形会把 @/value 段吃进标题（新形下 x/y 永不可达）；对旧形的唯一行为
//      差=带 value 的行标题更干净（value 不再随贪婪标题进 click/type 回执
//      ——安全纪律的回执层对齐）。observeContentDigest 不改（表文本自然含
//      @，wait-stable 比较器看到纯移动=未稳——正确语义）。
/** 元素行形：`  [e2] AXButton "添加" @371,204 value=…`（缩进=深度、编号=唯一
 *  ref 源；@ 段可选=位置缺席）。 */
const ELEMENT_LINE = /^\s*\[(e[1-9][0-9]{0,4})\] (\S+)(?: ("(?:[^"\\]|\\.)*"))?(?: @(-?\d+),(-?\d+))?/;

/** 观察表（解析后的 helper 契约形）。 */
export interface ObserveTable {
  readonly app: string;
  readonly window: string;
  readonly elementLines: readonly string[];
  readonly nodes: number;
  readonly truncated: boolean;
  readonly sha256: string;
}

export type ObserveRead = { readonly ok: true; readonly table: ObserveTable } | { readonly ok: false };

/** 观察输出解析（纯，fail-closed）：头标/窗行/元素行/尾标四段全形才收——
 *  头尾标缺失、元素行有异质行、sha 非 64 位 hex → ok:false（观察表的格式
 *  不可知就不发放任何 ref）。永不抛。 */
export function parseObserveOutput(stdout: string): ObserveRead {
  const lines = stdout.split(/\r?\n/);
  if (lines.length < 3) return { ok: false };
  const head = /^WUDAO_OBSERVE app=(.+)$/.exec(lines[0] ?? "");
  const win = /^WUDAO_WINDOW (.*)$/.exec(lines[1] ?? "");
  const end = /^WUDAO_END nodes=(\d+) truncated=(0|1) sha256=([0-9a-f]{64})$/.exec(lines[lines.length - 1] ?? "");
  if (head === null || win === null || end === null) return { ok: false };
  const elementLines = lines.slice(2, -1);
  if (!elementLines.every((l) => ELEMENT_LINE.test(l))) return { ok: false };
  return {
    ok: true,
    table: {
      app: head[1]!,
      window: win[1]!,
      elementLines,
      nodes: Number(end[1]),
      truncated: end[2] === "1",
      sha256: end[3]!,
    },
  };
}

/** ref → 点名条目（role+title；value 永不入场——安全纪律）。title 是
 *  jsonString 引号形时剥引号（JSON.parse 剥法，helper 侧 jsonString 转义）。
 *  x/y=元素中心（屏幕点，多屏可为负）；旧形行无 @ 段 → undefined（诚实
 *  缺席——scroll/drag 的 ref 路径给 typed 出路，绝不编造坐标）。 */
export interface ObserveRefEntry {
  readonly ref: string;
  readonly role: string;
  readonly title: string;
  readonly x?: number;
  readonly y?: number;
}

/** 元素行 → ref 条目（纯）。行不合形 → undefined（不猜）。 */
export function observeRefEntry(line: string): ObserveRefEntry | undefined {
  const m = ELEMENT_LINE.exec(line);
  if (m === null) return undefined;
  let title = "";
  if (m[3] !== undefined) {
    try {
      title = JSON.parse(m[3]) as string;
    } catch {
      title = m[3].slice(1, -1); // 非法 JSON 引号形：剥引号诚实降级
    }
  }
  const at = m[4] !== undefined && m[5] !== undefined ? { x: Number(m[4]), y: Number(m[5]) } : undefined;
  return at === undefined
    ? { ref: m[1]!, role: m[2]!, title }
    : { ref: m[1]!, role: m[2]!, title, x: at.x, y: at.y };
}

/** 观察表 → refs map（只收行幸存的编号——browser 纪律）。 */
export function observeRefs(table: ObserveTable): Map<string, ObserveRefEntry> {
  const m = new Map<string, ObserveRefEntry>();
  for (const line of table.elementLines) {
    const e = observeRefEntry(line);
    if (e !== undefined) m.set(e.ref, e);
  }
  return m;
}

// —— 黑名单 TTL 自适应降级（Reasonix 范式；N/TTL 裁定见弧报告 §一）——

/** 连续空观察 N 次 → 该 key 短期拉黑（第 N 次即拉黑，N+1 次起不硬试）。 */
export const OBSERVE_BLACKLIST_N = 2;
/** 拉黑时长：长到拦住一个任务内的硬试循环、短到换窗/等一会就能自愈。 */
export const OBSERVE_BLACKLIST_TTL_MS = 300_000;

/** 空=无元素树：根窗行独占（nodes≤1）=没有任何可点元素——游戏/自绘 UI 的
 *  典型形态。空观察是合法成功（exit 0），回执给「走截图」出路。 */
export function isEmptyObservation(table: ObserveTable): boolean {
  return table.nodes <= 1 || table.elementLines.length <= 1;
}

// ω99-250: #1 — settle/wait 的纯层（computer 弧 D：动作回执自带「界面变没变」
// 的确定性事实 + computer_wait 显式等待面）。蓝本 the upstream formatservice.ts:510-529 的
// settle-loop（动作后短窗轮询观察、对比前后摘要、回执带变化事实），三点我方
// 裁定：
//   1. 比对基准=observeContentDigest（app+窗口+元素行全量，**值在内**）——
//      247 的 helper sha256 刻意不含值（同窗打字不作废其余编号），settle 若
//      直接复用会在每次输入后误报「未变」；摘要只在本进程内比对，绝不外发。
//   2. 收敛语义=连续两拍相同才算「停」（变化中不下结论）——三态：变了/没变/
//      窗内未稳。the upstream format只有两态（一变即 settled）；「未稳」是我方为等待闭环
//      补的第三态（此时该走 computer_wait 或截图，不该拿半截事实当结论）。
//   3. 绝不报 verified/failed 语义结论（the upstream project的 expect 是模型侧判断）——harness
//      只见确定性事实，语义留给模型（§二诚实边界）。

/** settle 对比窗（ms）：动作后最多观察这么久——窗到仍在变=「未稳定」。 */
export const SETTLE_WINDOW_MS = 1_500;
/** settle 采样间隔（ms）：窗内两拍之间的停顿（the upstream formatsettleMs 范式）。 */
export const SETTLE_SAMPLE_INTERVAL_MS = 150;
/** computer_wait 超时缺省（ms）。 */
export const WAIT_TIMEOUT_DEFAULT_MS = 5_000;
/** computer_wait 超时硬帽（ms）：再长的等待该分多次或改走别的路。 */
export const WAIT_TIMEOUT_MAX_MS = 30_000;
/** computer_wait 采样间隔（ms）：等应用做事，比 settle 的动画拍频慢一档。 */
export const WAIT_SAMPLE_INTERVAL_MS = 400;
/** 稳定谓词需连续相同的采样次数（短窗 N 次不变=界面已停）。 */
export const WAIT_STABLE_SAMPLES = 3;

/** 观察表 → 内容摘要（纯，非加密——只做相等比对，绝不进回执/请求）。
 *  app/窗口标题/元素行全量（值在内）：值变、树变、换窗都算「界面变了」。 */
export function observeContentDigest(table: ObserveTable): string {
  return `${table.app}\n${table.window}\n${table.elementLines.join("\n")}`;
}

/** 元素行细读（wait 谓词输入）：`[eN] role "title" [@cx,cy] [value="…"]
 *  [disabled] [focused]`。与 247 的 observeRefEntry 平行的新解析器（ref/role/
 *  title 语义零演进——本件只多读 value/focused 两个尾字段，及位置段 @cx,cy
 *  ——wait 谓词不消费位置，解析随行保持同一把尺）；行不合形 → undefined
 *  （不猜）。value 缺席=该元素无值面（secure 字段/纯容器）——undefined 不是
 *  空串，谓词比对按「无值」处理。x/y 缺席=位置不在观察表（旧 helper 过渡形）。 */
export interface ObserveElementDetail {
  readonly ref: string;
  readonly role: string;
  readonly title: string;
  readonly value: string | undefined;
  readonly disabled: boolean;
  readonly focused: boolean;
  readonly x?: number;
  readonly y?: number;
}

const DETAIL_LINE = /^\s*\[(e[1-9][0-9]{0,4})\] (\S+)(?: ("(?:[^"\\]|\\.)*"))?(?: @(-?\d+),(-?\d+))?(?: value=("(?:[^"\\]|\\.)*"))?( disabled)?( focused)?$/;

/** 引号形剥法（与 247 observeRefEntry 同律）：JSON.parse，非法 JSON 剥引号
 *  诚实降级。helper 侧 jsonString 转义 → JSON.parse 是主路。 */
const unquote = (raw: string | undefined): string => {
  if (raw === undefined) return "";
  try {
    return JSON.parse(raw) as string;
  } catch {
    return raw.slice(1, -1);
  }
};

/** 元素行 → 细读条目（纯）。value 的引号捕获组缺席 → value=undefined；@ 段
 *  缺席 → x/y=undefined（旧形行）。 */
export function observeElementDetail(line: string): ObserveElementDetail | undefined {
  const m = DETAIL_LINE.exec(line);
  if (m === null) return undefined;
  return {
    ref: m[1]!,
    role: m[2]!,
    title: unquote(m[3]),
    value: m[6] === undefined ? undefined : unquote(m[6]),
    disabled: m[7] !== undefined,
    focused: m[8] !== undefined,
    ...(m[4] !== undefined && m[5] !== undefined ? { x: Number(m[4]), y: Number(m[5]) } : {}),
  };
}

/** wait 的 ref 谓词匹配（纯）：在表内找「角色相同、标题锁定（等标题变化时
 *  标题不锁——它正是被等的量）、值/标题期望满足」的第一个元素。编号是当次
 *  快照的（247 纪律：重观察会重编号）——跨快照的持久身份=角色+标题，按编号
 *  对新表取元素会在树变形后静默错位（那是本弧绝不做的「编造」）。 */
export function matchWaitElement(
  table: ObserveTable,
  identity: { readonly role: string; readonly title: string },
  expect: { readonly value?: string; readonly title?: string },
): ObserveElementDetail | undefined {
  for (const line of table.elementLines) {
    const d = observeElementDetail(line);
    if (d === undefined) continue;
    if (d.role !== identity.role) continue;
    if (expect.title === undefined && d.title !== identity.title) continue;
    if (expect.title !== undefined && d.title !== expect.title) continue;
    if (expect.value !== undefined && d.value !== expect.value) continue;
    return d;
  }
  return undefined;
}

/** settle 三态 + 无树降级（确定性事实，无成败结论）。 */
export type SettleOutcome =
  | { readonly kind: "changed" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "restless"; readonly windowMs: number }
  | { readonly kind: "no-tree" };

/** settle 行渲染（纯，逐字钉——收益语言零实现术语；「未变」带 the upstream format式注意行：
 *  像素级细节不在观察范围）。 */
export function formatSettleLine(o: SettleOutcome): string {
  switch (o.kind) {
    case "changed":
      return "界面已变化（与动作前观察到的内容不同）。";
    case "unchanged":
      return "界面未变（可能本来就如此；像素级细节不在观察范围内，如需确认请 screen_capture）。";
    case "restless":
      return `界面在 ${o.windowMs} 毫秒内未稳定（仍在变化）——可用 computer_wait 等它停稳，或 screen_capture 直接查看。`;
    case "no-tree":
      return "无法验证界面是否变化（该窗口没有可观察元素）——如需确认请 screen_capture。";
  }
}

// ω99-261: #2 — drag 终点命中回读的纯层（「拖到 e7 上」的验证半边：239 R4
// 回执零验证在 drag 域的收口）。helper hit 子命令=只读 AX 命中（零 CGEvent
// 零截屏），输出一行身份行；本层解析+一次缝调用。三件裁定：
//   1. 行形=WUDAO_HIT 前缀 + 六段 | join（observeTree hashLine 同族减 index
//      段——结构身份（247 纪律）不含编号/位置）；空可选段=""，TS 侧映射为
//      undefined（诚实缺席，不是空串占位）。标题/标签经 helper 侧
//      observeSanitize（换行已折），含 | 的标题行不符形 → null 静默降级
//      （绝不猜拆段）。
//   2. runHit 坐标=屏幕点原值直通——hit 不碰 captureScale（257 口径分轨纪律：
//      换算只属于坐标路径；观察表/hit 天然同屏点空间）。
//   3. exit 4=未命中（诚实三态的「不可证」半边）；exit 3/2/其他、exit 0 但
//      格式不符 → undefined=调用方静默降级。旧 helper 无 hit 子命令：未知词
//      首参在 click 兜底分支被 coord(argv[0]) 拒（"hit" 非数值）→ exit 3 零
//      事件——两版本过渡零断崖（257 §四-3 同款纪律）。

/** 落点身份（hit 行解析结果；subrole/title/label 缺席=undefined）。 */
export interface HitIdentity {
  readonly role: string;
  readonly subrole?: string;
  readonly title?: string;
  readonly label?: string;
  readonly enabled: boolean;
  readonly focused: boolean;
}

/** hit 身份行形：`WUDAO_HIT role|subrole|title|label|enabled|focused`（六段
 *  全形才收——前缀/段数/布尔任何不符 → null，fail-closed 不猜）。 */
const HIT_LINE = /^WUDAO_HIT ([^|]+)\|([^|]*)\|([^|]*)\|([^|]*)\|(true|false)\|(true|false)$/;

/** hit 身份行解析（纯）。空可选段 → undefined（缺席语义，与 value 的
 *  undefined-非空串同律）。永不抛。 */
export function parseHitLine(stdout: string): HitIdentity | null {
  const m = HIT_LINE.exec(stdout.trim());
  if (m === null) return null;
  return {
    role: m[1]!,
    ...(m[2]! !== "" ? { subrole: m[2]! } : {}),
    ...(m[3]! !== "" ? { title: m[3]! } : {}),
    ...(m[4]! !== "" ? { label: m[4]! } : {}),
    enabled: m[5] === "true",
    focused: m[6] === "true",
  };
}

/** 一次 helper hit（缝注入——测试喂假件，绝不真 AX）。坐标=屏幕点原值直通。 */
export type HitRead =
  | { readonly kind: "hit"; readonly identity: HitIdentity }
  | { readonly kind: "miss" };

/** 命中→身份；exit 4=未命中；其余一切（含旧 helper 的 exit 3 拒与 exit 0 但
 *  格式不符）=undefined → 调用方静默降级（验证缺席绝不 fail 拖拽本身）。 */
export async function runHit(exec: ExecSeam, helper: string, at: ScreenPoint): Promise<HitRead | undefined> {
  const r = await exec(helper, ["hit", String(at.x), String(at.y)]);
  if (r.code === 4) return { kind: "miss" };
  if (r.code !== 0) return undefined;
  const identity = parseHitLine(r.stdout);
  return identity === null ? undefined : { kind: "hit", identity };
}
