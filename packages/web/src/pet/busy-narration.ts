// ω99-113 — busyTools 态的人话旁白（弧主菜 A）。112 落了 browser_* 六
// 工具，但宠物面对 busyTools 只有 busyToolCount（沉默）或裸露工具名两条
// 路——后者违反 user-facing copy = benefits。本模块 = 纯映射：载荷的
// name+summary（元素形状 agent-driver.ts:179，两字段都已在载荷）→ 一句
// 中文旁白。PURE TS, no imports：pet-frame.ts（主窗 distill 侧）引它，
// 落主壳 index 与 pet 两个 chunk，体积必须克制。
//
// v7 γ1（a reference harness pet v2「工作种类→表达」思想）：映射从 6 个 browser_*
// 动词扩到全工具分类——读写/检索/命令/网络/office/电脑操作/等待/编排各
// 配一句中文旁白 + 一个工作种类（workKind，随帧跨窗的形态分类锚）。113
// 自注的「非 browser 返回 null 是弧内取舍非终态」在此兑现。边界纪律不变：
// 映射不中且无已知前缀族 → null（诚实沉默，绝不编造）；空摘要降级为无
// 宾语短句，宁降级也不出空「」；全部产出不含实现术语（固定字面量纯中文，
// 插值位只进用户可读对象——路径/命令/短语）。

/** 已知 browser_* 工具 → 固定旁白（无摘要位；ω99-113 逐字钉于
 * pet-busy-narration.test.ts——改文案必改测试。γ1 扩表不动这五条）。 */
const BROWSER_NARRATIONS: Readonly<Record<string, string>> = {
  browser_open: "正在打开网页…",
  browser_snapshot: "正在读页面…",
  browser_type: "正在填写输入框",
  browser_scroll: "正在往下翻页面",
  browser_close: "已合上浏览器窗口",
  // v7 γ1：112 之后新增的 browser 面（见 packages/browser/src/tools.ts）。
  browser_see: "正在看页面…",
  browser_downloads: "正在查看下载的文件",
};

/** 摘要进旁白的模板族：`(宾语) → 有摘要/空摘要` 两条（空摘要降级为无
 * 宾语短句）。模板段（「」外）纯中文——插值位只进用户可读对象。 */
const OBJECT_NARRATIONS: Readonly<Record<string, readonly [string, string]>> = {
  read_file: ["正在读文件「{s}」", "正在读文件"],
  write_file: ["正在写文件「{s}」", "正在写文件"],
  edit: ["正在改文件「{s}」", "正在改文件"],
  glob: ["正在找文件「{s}」", "正在找文件"],
  grep: ["正在搜代码「{s}」", "正在搜代码"],
  shell: ["正在跑命令「{s}」", "正在跑命令"],
  run_script: ["正在跑脚本「{s}」", "正在跑脚本"],
  web_fetch: ["正在读网页「{s}」", "正在读网页"],
  web_search: ["正在查资料「{s}」", "正在查资料"],
  computer_click: ["正在点击屏幕（{s}）", "正在点击屏幕"],
  computer_type: ["正在打字「{s}」", "正在打字"],
  computer_key: ["正在按「{s}」", "正在按键"],
  app_activate: ["正在切换到「{s}」", "正在切换应用"],
  screen_observe: ["正在观察「{s}」", "正在观察屏幕"],
};

/** 固定旁白族（无摘要位——工具自语义已说全，或摘要面向模型不适合进
 * 用户面：subagent 行的 summary 是子工具英文名、computer_wait 的 ref
 * 形是模型侧定位符，插值会裸露实现术语）。 */
const FIXED_NARRATIONS: Readonly<Record<string, string>> = {
  // office 三面 × 读写追改 + 版式（doc-suite 名册全集，见 doc-suite.ts）。
  make_xlsx: "正在做表格",
  make_docx: "正在写文档",
  make_pptx: "正在做演示文稿",
  read_xlsx: "正在读表格",
  read_docx: "正在读文档",
  read_pptx: "正在读演示文稿",
  append_xlsx: "正在往表格里补内容",
  append_docx: "正在往文档里补内容",
  append_pptx: "正在往演示文稿里补内容",
  replace_xlsx: "正在改表格内容",
  replace_docx: "正在改文档内容",
  replace_pptx: "正在改演示文稿内容",
  set_docx_header: "正在设置文档页眉",
  clear_docx_header: "正在清掉文档页眉",
  set_docx_first_page: "正在设置文档首页页眉",
  set_docx_even_pages: "正在设置文档偶数页页眉",
  set_pptx_notes: "正在写演示备注",
  // 电脑操作余面（坐标/窗口动作自语义已全）。
  computer_scroll: "正在滚动窗口",
  computer_drag: "正在拖拽",
  app_list: "正在查看应用列表",
  screen_capture: "正在截取屏幕",
  // 等待族：等待自语义已全，ref 形不进用户面。
  computer_wait: "正在等界面就绪",
  sleep: "正在等待",
  // 笔记/待办。
  notebook: "正在记工作笔记",
  todo_write: "正在整理待办清单",
  // 编排面（mission_* 精确名 + 族降级双覆盖：族兜未来新动词）。
  task: "正在派子任务",
  subagent: "正在跑子任务",
  mission_plan: "正在编排任务计划",
  mission_start: "正在开启任务计划",
  mission_next: "正在认领下一个任务",
  mission_complete: "正在结算任务成果",
  mission_fail: "正在记录任务失败",
  mission_know_add: "正在整理任务经验",
  mission_know: "正在查看任务经验",
  mission_bundle: "正在挂载工具包",
  mission_ratchet: "正在跑回归检查",
  // 问询：模型向用户发问（主窗有完整问询卡，宠物面一句状态）。
  ask_user: "正在向你提问",
  // 网页关注 / 后台监控。
  watch_create: "正在设置网页关注",
  watch_list: "正在查看网页关注",
  watch_delete: "正在撤掉网页关注",
  monitor_start: "正在开启后台监控",
  monitor_stop: "正在停掉后台监控",
  monitor_list: "正在查看后台监控",
  monitor_read: "正在读后台输出",
};

/** 前缀族降级：未来新增的族内工具（browser_click_xy 一类）不再裸露英文
 * 名。值为 `[有摘要, 空摘要]`。browser 族保持 ω99-113 逐字钉的旧文案。 */
const FAMILY_NARRATIONS: Readonly<Record<string, readonly [string, string]>> = {
  browser_: ["正在处理：{s}", "正在处理网页任务"],
  computer_: ["正在操作电脑：{s}", "正在操作电脑"],
  mission_: ["正在推进任务：{s}", "正在推进任务"],
  schedule_: ["正在管理定时任务：{s}", "正在管理定时任务"],
  watch_: ["正在管理网页关注：{s}", "正在管理网页关注"],
  monitor_: ["正在查看后台输出：{s}", "正在查看后台输出"],
  mcp__: ["正在调用扩展工具：{s}", "正在调用扩展工具"],
};

/** 摘要的宠物面用量：首行 + 24 码点帽（「…」告知还有）。busyTools 的
 * summary 是 summarizeToolCall 原文——shell 是整条命令、read_file 是整
 * 条路径，不帽会把 184px 内宽的气泡撑成长文。按码点计数与切片（emoji
 * 不劈半，与 cli 侧截断同规则）。 */
const NARRATION_OBJECT_MAX_CHARS = 24;
function clipObject(summary: string): string {
  const firstLine = summary.split("\n")[0] ?? "";
  const chars = Array.from(firstLine.trim());
  return chars.length <= NARRATION_OBJECT_MAX_CHARS ? firstLine.trim() : `${chars.slice(0, NARRATION_OBJECT_MAX_CHARS).join("")}…`;
}

/** 工作种类（宠物形态的分类锚）：旁白之姊面——同一行 busy 工具同时给出
 * 它属于哪类工作，随帧跨窗（PetFrame.workKind），宠物面据此可做未来的
 * 形态差异（不同类不同气泡色/动画——刻意不在本弧落 CSS：0.3.78 零像素
 * 回归教训，动视觉须带几何契约钉另立弧）。值域稳定小写 ASCII，是 wire
 * 锚不是用户文案（用户文案=旁白句本身）。 */
export type PetWorkKind =
  | "browser"
  | "files"
  | "search"
  | "command"
  | "web"
  | "office"
  | "computer"
  | "wait"
  | "notes"
  | "orchestration"
  | "watch"
  | "ask"
  | "extension";

/** office 三面的全集（doc-suite 名册——18 动词 × 3 面 + 版式四件；与
 * FIXED_NARRATIONS 的 office 键一致，分类侧单列成表让两侧各自可测）。 */
const OFFICE_TOOLS: ReadonlySet<string> = new Set([
  "make_xlsx", "make_docx", "make_pptx",
  "read_xlsx", "read_docx", "read_pptx",
  "append_xlsx", "append_docx", "append_pptx",
  "replace_xlsx", "replace_docx", "replace_pptx",
  "set_docx_header", "clear_docx_header", "set_docx_first_page", "set_docx_even_pages", "set_pptx_notes",
]);

/** 工具名 → 工作种类。与旁白表独立（同族工具共享种类，未知工具 null——
 * 与 busyToolNarration 的诚实沉默同边界）。 */
export function busyToolWorkKind(name: string): PetWorkKind | null {
  // 精确名先于前缀族：computer_wait 属「等待」不属「电脑操作」（等待是
  // 宠物面的独立形态类——正在等，不在动）。
  if (name === "computer_wait" || name === "sleep") return "wait";
  if (name.startsWith("browser_")) return "browser";
  if (name.startsWith("mcp__")) return "extension";
  if (name.startsWith("computer_") || name.startsWith("app_") || name.startsWith("screen_")) return "computer";
  if (name.startsWith("mission_") || name.startsWith("schedule_")) return "orchestration";
  if (name.startsWith("watch_") || name.startsWith("monitor_")) return "watch";
  if (OFFICE_TOOLS.has(name)) return "office";
  switch (name) {
    case "read_file": case "write_file": case "edit": return "files";
    case "glob": case "grep": return "search";
    case "shell": case "run_script": return "command";
    case "web_fetch": case "web_search": return "web";
    case "task": case "subagent": return "orchestration";
    case "notebook": case "todo_write": return "notes";
    case "ask_user": return "ask";
    default: return null;
  }
}

/** 单个 busy 工具 → 旁白；未知工具（无精确名、无已知前缀族）→ null（不
 * 旁白，宠物面维持既有呈现）。browser_click 的摘要进旁白（点的是什么）；
 * 空摘要降级为无宾语短句——今日 cli 的 summarizeToolCall 尚无 browser 分
 * 支，summary 常为空串，宁降级也不出空「」。 */
export function busyToolNarration(name: string, summary: string): string | null {
  const s = clipObject(summary);
  // browser 面先行（ω99-113 逐字节保留：click 特例 + 固定表 + 族降级）。
  if (name.startsWith("browser_")) {
    if (name === "browser_click" || name === "browser_click_xy") {
      return s === "" ? "正在点击页面" : `正在点击页面上的「${s}」`;
    }
    if (name === "browser_type_xy") return "正在填写输入框";
    if (name === "browser_scroll_xy") return "正在往下翻页面";
    const known = BROWSER_NARRATIONS[name];
    if (known !== undefined) return known;
    const family = FAMILY_NARRATIONS["browser_"]!;
    return s === "" ? family[1] : family[0].replace("{s}", s);
  }
  // v7 γ1：全工具分类映射。
  const object = OBJECT_NARRATIONS[name];
  if (object !== undefined) return s === "" ? object[1] : object[0].replace("{s}", s);
  const fixed = FIXED_NARRATIONS[name];
  if (fixed !== undefined) return fixed;
  for (const [prefix, family] of Object.entries(FAMILY_NARRATIONS)) {
    if (prefix === "browser_") continue;
    if (name.startsWith(prefix)) return s === "" ? family[1] : family[0].replace("{s}", s);
  }
  return null;
}

/** busyTools 列表 → 旁白：从最新（末位）往回扫，第一个可旁白行胜出——
 * 并发多工具时「现在在干什么」以最新动作为准；无可旁白行 → null。 */
export function busyNarrationOf(tools: readonly { readonly name: string; readonly summary: string }[]): string | null {
  for (let i = tools.length - 1; i >= 0; i -= 1) {
    const n = busyToolNarration(tools[i]!.name, tools[i]!.summary);
    if (n !== null) return n;
  }
  return null;
}

/** busyTools 列表 → 工作种类（胜出行与 busyNarrationOf 同一「最新可旁白
 * 行」规则——种类与旁白同源同行；无可分类行 → null）。 */
export function busyWorkKindOf(tools: readonly { readonly name: string; readonly summary: string }[]): PetWorkKind | null {
  for (let i = tools.length - 1; i >= 0; i -= 1) {
    const k = busyToolWorkKind(tools[i]!.name);
    if (k !== null && busyToolNarration(tools[i]!.name, tools[i]!.summary) !== null) return k;
  }
  return null;
}
