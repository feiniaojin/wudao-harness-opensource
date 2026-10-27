// ω99-119 — 拖文件意图 chips 的 A 层（纯函数，零依赖）。drop 之后任务
// 不再自动发出一句模糊的默认句：staged 文件配三颗建议 chips，点一颗
// 就是把一段明确意图的指令填进输入框并发出去。文案表由弧 brief 逐字
// 钉死（label=按钮上用户看到的字，text=点下去发出的指令文本），测试
// toEqual 整排钉序——改一个字、换一个顺序都会红。PURE TS, no imports:
// App/index chunk 都可能捎上它，保持零依赖（screenshot-ask.ts 同款纪律）。
//
// v1 从简：多文件混合按【首文件】的族给整排，兜底不混拼——混合批不
// 出第二排、不出混搭排。

/** 一颗建议 chip：label 上按钮、text 是点下去发出的指令文本。 */
export interface DropIntentChip {
  readonly label: string;
  readonly text: string;
}

/** 文档族文案（.txt/.md/.pdf/.docx）——brief 文案表逐字。 */
const DOC_CHIPS: readonly DropIntentChip[] = [
  { label: "总结要点", text: "总结这个文件的要点" },
  { label: "提炼待办", text: "从这个文件里提炼出我的待办事项" },
  { label: "看看这是啥", text: "这个文件是讲什么的" },
];

/** 表格族文案（.xlsx/.csv）——brief 文案表逐字。 */
const SHEET_CHIPS: readonly DropIntentChip[] = [
  { label: "看看数据", text: "看看这份数据有什么值得注意的" },
  { label: "总结要点", text: "总结这个文件的要点" },
  { label: "提炼待办", text: "从这个文件里提炼出我的待办事项" },
];

/** 通用兜底文案（其余扩展名/无扩展名/空）——brief 文案表逐字。 */
const GENERIC_CHIPS: readonly DropIntentChip[] = [
  { label: "帮我处理", text: "帮我处理这个文件" },
  { label: "总结要点", text: "总结这个文件的要点" },
  { label: "看看这是啥", text: "这个文件是讲什么的" },
];

const DOC_EXTS = new Set(["txt", "md", "pdf", "docx"]);
const SHEET_EXTS = new Set(["xlsx", "csv"]);

/** 文件名的扩展名（最后一个点后段，小写；无点 → 空串）。 */
function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i + 1).toLowerCase();
}

/** staged 文件名 → 三颗建议 chips（同一数组身份，不逐次新造——文案是
 *  常量表）。多文件按首文件的族；空名数组 → 通用兜底。 */
export function dropIntentChips(names: readonly string[]): readonly DropIntentChip[] {
  const first = names[0];
  if (first === undefined) return GENERIC_CHIPS;
  const ext = extOf(first);
  if (DOC_EXTS.has(ext)) return DOC_CHIPS;
  if (SHEET_EXTS.has(ext)) return SHEET_CHIPS;
  return GENERIC_CHIPS;
}
