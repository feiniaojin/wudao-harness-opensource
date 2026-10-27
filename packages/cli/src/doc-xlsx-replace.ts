// ω99-231: #1 — xlsx 就地改写面纯层 + 工具面（零依赖）。三件套「改」半边
// xlsx 侧收口：「把表里这格的旧值换成新值」「把旧公司名全表换掉」是 Excel
// 最高频编辑动作——读（221）/造（123）/追加（228）都齐了，唯独 xlsx 的
// 「改」缺位（229 落了 docx/pptx）：模型此前只能读→整文件重造，原表样式
// 全丢。本面补最后一刀，四环（读/造/追加/改）齐。
//
// 设计裁定（超越点，brief §零钉，写进代码注释）：**单元格级字符串外科 +
// sharedStrings 零触碰**。xlsx 写库常规道（openpyxl 等）是「整包 load→对
// 象树改值→全包 save」——sharedStrings 去重表被整表重写、所有共享索引漂
// 移、未改部件也被重序列化。本面命中格**就地改写该格 XML**：共享串格
// （t="s"）→ 重指为 inlineStr（同 run 结构保形）；纯数字格（无 t 或 t="n"、
// 非公式）→ 原位换 `<v>`；`xl/sharedStrings.xml` 部件**字节不动**——其他
// 引用同串的格零扰动、去重表零漂移（228 inlineStr 绕行的第三落地：追加
// 面/公式缓存面之外，「改」面同样绕开共享表）。诚实双闸（229 同族）：① 富
// 文本串横跨 run 边界 → 不静默跳、不静默压平——typed 拒/收据警示点名格位
// （Sheet!B7 词汇比 docx 段序更可行动）；② 数字格替换结果非有限数或空串
// → 不落盘、点名格位（行业写库普遍不设的闸——数字格被写进非数值文本是
// 静默数据损坏）。
//
// 优缺点三行（brief §零）：优点=sharedStrings 字节不动（R1 直钉该部件
// bytesEqual）+未命中格与未命中部件字节级保真+格位定位词汇；缺点=孤儿共
// 享串累积（被重指的旧共享项留在表里，读面看不见、无害）+同值格同命（值
// 级替换语义——Excel 自己把同值格折叠为共享串，值级替换是正确语义非局
// 限；单格改需缩小 find 或 scope sheet）+公式格/布尔格/错误格不参与；超
// 越=inlineStr 重指（228 第三落地）+富文本 run 诚实拒（229 xlsx 同族）+
// 数字安全闸（行业写库普遍不设）。
//
// 纯层件（brief §二）：escapeXml/unescapeXml（双向——比较前 unescape、
// 写回前 escape，实体往返钉；族内第 4 份逐字复制，自含纪律，观察注：四份
// 同款可候池收敛，本弧不动）+ parseSharedStrings（单 <t> 形/富文本 runs 形
// 判别，拼接纪律同读面）+ workbookSheets（表清单步行——workbook.xml 名序
// + rels r:id→target，不假设 sheetN=顺序，221 纪律；scanXlsxSheetPart 的
// 全表镜像，复制不重构）+ countSheetOccurrences（count pass）+
// replaceInSheetXml（格判型与改写：先扫后改单趟）+ replaceXlsxText（驱动：
// unzip→scope→全局帽→逐表改写→smartZip 回装→互证收据层）。
//
// 纪律（brief 钉，221/223/228/229 同款）：
// - 纯层纯函数：不碰时钟（DOS 时间由 doc-zip 钉）、不碰盘（盘只在工具面
//   execute 里 readFile/writeFile）；
// - 原包字节保真：除改到的 sheet 部件外逐字节过 zip 层（sharedStrings.xml
//   显式零触碰——smartZip 的 bytesEqual 直过裁定自动保真，230 三形）；
//   条目名序原样（确定性：同输入两次全等）；dimension 不动（无行列几何
//   变化）；
// - typed 拒优于静默剥：坏 zip/加密/Zip64/缺部件/坏参数/sheet 不存在直接
//   拒，错误信息用户语（unzipEntriesWithMeta 本体是 xlsx 口径，零映射直
//   过；sheet 拒沿 228 文案）；
// - 帽子：validateDocReplace 同源（缺省 50 硬帽 200，replace 族帽子语义
//   同一源）；全局帽不分表（229 同形）；计数=出现次数（格值内可多次，
//   split 计数）；
// - 互证收据层（223/228/229 范式）：回装字节喂 parseXlsxSheets 断言
//   scoped 表内 find 零余（残余豁免精确计：跨界拼接/数字闸/不参与格的
//   可见值逐格计入 tolerated，见 replaceXlsxText 注）、replace 在场（空白
//   替换与零替换不检——读面行不变量折）。
import { scanXlsxSheetPart } from "./doc-xlsx-append.js";
import { validateDocReplace, REPLACE_DEFAULT_MAX_COUNT, REPLACE_HARD_MAX_COUNT } from "./doc-replace.js";
import { smartZip, unzipEntriesWithMeta } from "./doc-zip.js";
import type { SmartZipEntry } from "./doc-zip.js";
import { parseXlsxSheets } from "./doc-xlsx-read.js";
import { buildTool, resolveWorkspacePath } from "@wudao/core";
import type { Tool } from "@wudao/core";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

// ---------------------------------------------------------------------------
// A — 改写纯层。
// ---------------------------------------------------------------------------

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** XML 实体解码：五个命名实体 + 十进制/十六进制数字实体（单趟，不双解）——
 *  doc-replace.ts / doc-xlsx-append.ts 同款逐字复制（族内第 4 份，自含纪
 *  律；四份同款可候池收敛，本弧不动）。 */
function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      try {
        return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
      } catch {
        return whole;
      }
    }
    if (body.startsWith("#")) {
      try {
        return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
      } catch {
        return whole;
      }
    }
    return XML_ENTITIES[body] ?? whole;
  });
}

/** 五实体转义（&amp; &lt; &gt; &quot; &apos;）——doc-replace.ts 同款件逐
 *  字复制（复制 ~5 行，注释钉同源）。 */
function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&apos;");
}

/** 子串出现次数（split 计数；find 已由调用方保证非空）——229 同形。 */
function occurrences(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

/** 从一个起始标签文本里取属性值（属性序无关；单双引号都认）——
 *  doc-xlsx-append.ts 同款件复制（追加面未导出；复制不重构，同源纪律）。 */
function attrValue(tag: string, name: string): string | undefined {
  const m =
    new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(tag) ??
    new RegExp(`${name}\\s*=\\s*'([^']*)'`).exec(tag);
  return m?.[1];
}

/** 0 基列号 → Excel 列字母（0→A，25→Z，26→AA）——doc-xlsx-append.ts 同款
 *  件复制（无 r 属性格的定位合成用）。 */
function columnLetter(i: number): string {
  let s = "";
  let n = i;
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

/** A1 引用 → 0 基列号（$ 容忍）；无字母部分 → undefined——doc-xlsx-read.ts
 *  同款件复制（读面按此定位格，改写面按同款定位才能对上读回坐标）。 */
function columnIndexFromRef(ref: string): number | undefined {
  const m = /^\$?([A-Za-z]+)\$?\d+/.exec(ref.trim());
  if (m === null) return undefined;
  let n = 0;
  for (const ch of m[1]!) {
    n = n * 26 + (ch.charCodeAt(0) & 0x1f);
  }
  return n - 1;
}

/** 一个富文本 run：rPr=原 run 属性元素原文（如 `<rPr><b/></rPr>`，缺席
 *  null——重指时原样回填，保格式边界）；text=unescape 后的 run 文本。 */
export interface RichRun {
  readonly rPr: string | null;
  readonly text: string;
}

/** 一个共享串项：text=全值（单 t 直取或 runs 顺序拼接——拼接纪律同读面：
 *  runs 顺序拼接、`<t xml:space>` 直取、rPh 音注剥）；runs=null 即单 <t>
 *  plain 形（改写走整值替换重指），非 null 即富文本形（单 run 命中保 run
 *  结构改写 / 跨 run 拒）。 */
export interface SharedStringItem {
  readonly text: string;
  readonly runs: readonly RichRun[] | null;
}

/** 一个文本块（<si> 或 <is> 内文）→ {全值, runs}。有 <r> 即富文本形；无
 *  即单 <t> plain 形（多 <t> 拼接容错）。纯。 */
function parseTextBlock(inner: string): { text: string; runs: readonly RichRun[] | null } {
  const cleaned = inner.replace(/<rPh\b[\s\S]*?<\/rPh>/g, ""); // 音注假名剥（读面同款）
  const runMatches = [...cleaned.matchAll(/<r\b[^>]*>([\s\S]*?)<\/r>/g)];
  if (runMatches.length === 0) {
    let text = "";
    for (const m of cleaned.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) {
      text += unescapeXml(m[1] ?? "");
    }
    return { text, runs: null };
  }
  const runs: RichRun[] = runMatches.map((m) => {
    const body = m[1]!;
    const rPr = /<rPr\b[^>]*?(?:\/>|>[\s\S]*?<\/rPr>)/.exec(body)?.[0] ?? null;
    let text = "";
    for (const t of body.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) {
      text += unescapeXml(t[1] ?? "");
    }
    return { rPr, text };
  });
  return { text: runs.map((r) => r.text).join(""), runs };
}

/** sharedStrings.xml 部件 → 共享串项数组（索引即 <si> 次序）。两形判别见
 *  SharedStringItem。纯。 */
export function parseSharedStrings(xml: string): readonly SharedStringItem[] {
  const out: SharedStringItem[] = [];
  for (const m of xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
    const block = parseTextBlock(m[1] ?? "");
    out.push({ text: block.text, runs: block.runs });
  }
  return out;
}

/** 富文本 runs 序列化（重指 inlineStr 用）：rPr 原样回填、t 恒带
 *  xml:space="preserve"（重建块统一保空白——确定性 + 空白不丢）。 */
function serializeRuns(runs: readonly RichRun[]): string {
  return runs.map((r) => `<r>${r.rPr ?? ""}<t xml:space="preserve">${escapeXml(r.text)}</t></r>`).join("");
}

/** 开标签按需补 xml:space="preserve"：结果文本为空串或首尾带空白时补（229
 *  openTagWithPreserve 同款纪律——原位编辑走最小动，属性保持=字节保真）。 */
function withPreserve(openTag: string, text: string): string {
  if (/xml:space\s*=\s*["']preserve["']/.test(openTag)) return openTag;
  const needs = text === "" || /^[ \t\r\n]/.test(text) || /[ \t\r\n]$/.test(text);
  if (!needs) return openTag;
  return openTag.replace(/^<t\b/, (m) => `${m} xml:space="preserve"`);
}

/** 表清单步行：workbook.xml 的 <sheet> 名序（**不假设 sheetN.xml 编号=顺
 *  序**——Excel 只保证 workbook 里的次序，部件文件名任意）+ rels 的
 *  r:id→target（相对 xl/ 解析、绝对形去头斜杠）→ 全部 {名, 部件}。读面
 *  parseXlsxSheets 内部同款步行的本地件（复制不重构，读面字节零动，
 *  228 scanXlsxSheetPart 先例）；单表选择走 scanXlsxSheetPart（228 拒文
 *  案同源）。纯。 */
function workbookSheets(
  parts: readonly { readonly name: string; readonly data: Uint8Array }[],
): { ok: true; sheets: readonly { name: string; partName: string }[] } | { ok: false; error: string } {
  const dec = new TextDecoder();
  const find = (name: string) => parts.find((e) => e.name === name);
  const workbookPart = find("xl/workbook.xml");
  if (workbookPart === undefined) {
    return { ok: false, error: "这不是有效的 Excel（.xlsx）文件——缺少工作簿结构" };
  }
  const relsPart = find("xl/_rels/workbook.xml.rels");
  const rels = new Map<string, string>();
  if (relsPart !== undefined) {
    for (const m of dec.decode(relsPart.data).matchAll(/<Relationship\b[^>]*>/g)) {
      const id = attrValue(m[0], "Id");
      const target = attrValue(m[0], "Target");
      if (id === undefined || target === undefined) continue;
      const normalized = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
      rels.set(id, normalized);
    }
  }
  const sheets: { name: string; partName: string }[] = [];
  for (const m of dec.decode(workbookPart.data).matchAll(/<sheet\b[^>]*>/g)) {
    const name = attrValue(m[0], "name");
    const rid = attrValue(m[0], "r:id");
    if (name === undefined || rid === undefined) continue;
    const part = rels.get(rid);
    if (part === undefined || find(part) === undefined) {
      return { ok: false, error: `这不是有效的 Excel（.xlsx）文件——工作簿引用了一张缺失的表（${name}）` };
    }
    sheets.push({ name, partName: part });
  }
  if (sheets.length === 0) {
    return { ok: false, error: "这不是有效的 Excel（.xlsx）文件——没有找到任何工作表" };
  }
  return { ok: true, sheets };
}

/** 一个扫出的格（开闭对）：开标签原文/属性区/内文 + 原 body 偏移（缝补层
 *  原位写回用）+ 定位（r 属性解不出列的格与读面同款跳过；无 r 的格按邻
 *  位合成坐标——读面同款容错）。 */
interface CellSpan {
  readonly attrs: string;
  readonly children: string;
  readonly cellStart: number;
  readonly cellEnd: number;
  readonly ref: string;
}

/** sheetData 内文 → 格清单（行/格开闭对步行，属性形收、自闭合略）。格偏移
 *  折算成 body 绝对坐标（matchAll 的 index 相对各自搜索串——行内格须加行
 *  内文在 body 中的起点，缝补层才能原位写回）。纯。 */
function scanCells(body: string): readonly CellSpan[] {
  const out: CellSpan[] = [];
  let lastRow = 0;
  for (const rowMatch of body.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowAttrs = rowMatch[1] ?? "";
    const children = rowMatch[2];
    const rAttr = /\br\s*=\s*"(\d+)"/.exec(rowAttrs)?.[1];
    const rowNo = rAttr !== undefined ? Number.parseInt(rAttr, 10) : lastRow + 1;
    lastRow = rowNo;
    if (children === undefined) continue; // 自闭合行无内容
    const rowContentStart = rowMatch.index! + rowMatch[0].length - children.length - "</row>".length;
    let lastCol = -1;
    for (const cellMatch of children.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1] ?? "";
      const inner = cellMatch[2];
      if (inner === undefined) continue; // 自闭合格无值
      const ref = attrValue(attrs, "r");
      let col: number;
      if (ref !== undefined) {
        const parsed = columnIndexFromRef(ref);
        if (parsed === undefined) continue; // 引用解不出——读面同款跳过（格不可见即不可改）
        col = parsed;
      } else {
        col = lastCol + 1;
      }
      lastCol = col;
      const start = rowContentStart + cellMatch.index!;
      out.push({
        attrs,
        children: inner,
        cellStart: start,
        cellEnd: start + cellMatch[0].length,
        ref: ref ?? `${columnLetter(col)}${rowNo}`,
      });
    }
  }
  return out;
}

/** 一个格的值判别（honest edge 全景）：
 *  - plain：t="s" 单 <t> 共享串 / t="str" 公式串缓存（无 <f> 残留形）/
 *    t="inlineStr" 单 <t>——整值替换；repoint=true 者改写后重指 inlineStr
 *    （共享表零触碰的代价位），false 者（inlineStr）原位换 t 文本。
 *  - rich：富文本形（共享或 inline）——单 run 命中保 run 结构改写；横跨
 *    run 边界由改写层拒。
 *  - numeric：无 t / t="n" 且无 <f>——原位换 <v>（数字闸在改写层）。
 *  - none：不参与——含 <f> 公式格（改公式结果缓存会与重算不一致，弃）、
 *    t="b" 布尔、t="e" 错误、未知 t、无值格、共享索引越界格。 */
type CellValue =
  | { readonly kind: "plain"; readonly value: string; readonly repoint: boolean }
  | { readonly kind: "rich"; readonly text: string; readonly runs: readonly RichRun[]; readonly repoint: boolean }
  | { readonly kind: "numeric"; readonly vText: string }
  | { readonly kind: "none" };

/** 格判型（children+attrs+共享表 → CellValue）。纯。 */
function classifyCell(attrs: string, children: string, shared: readonly SharedStringItem[]): CellValue {
  const t = attrValue(attrs, "t");
  if (/<f\b/.test(children)) return { kind: "none" }; // 公式格不参与（honest edge）
  if (t === "b" || t === "e") return { kind: "none" };
  if (t === "s") {
    const v = /<v\b[^>]*?(?:\/>|>([\s\S]*?)<\/v>)/.exec(children)?.[1];
    if (v === undefined) return { kind: "none" };
    const idx = Number.parseInt(v.trim(), 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= shared.length) return { kind: "none" };
    const item = shared[idx]!;
    return item.runs === null
      ? { kind: "plain", value: item.text, repoint: true }
      : { kind: "rich", text: item.text, runs: item.runs, repoint: true };
  }
  if (t === "inlineStr") {
    const is = /<is\b[^>]*?(?:\/>|>([\s\S]*?)<\/is>)/.exec(children)?.[1];
    if (is === undefined) return { kind: "none" };
    const block = parseTextBlock(is);
    return block.runs === null
      ? { kind: "plain", value: block.text, repoint: false }
      : { kind: "rich", text: block.text, runs: block.runs, repoint: false };
  }
  if (t === "str") {
    const v = /<v\b[^>]*?(?:\/>|>([\s\S]*?)<\/v>)/.exec(children)?.[1];
    if (v === undefined) return { kind: "none" };
    return { kind: "plain", value: unescapeXml(v), repoint: true };
  }
  if (t === undefined || t === "n") {
    const v = /<v\b[^>]*?(?:\/>|>([\s\S]*?)<\/v>)/.exec(children)?.[1];
    if (v === undefined) return { kind: "none" };
    return { kind: "numeric", vText: unescapeXml(v) };
  }
  return { kind: "none" };
}

/** 一格的可替换出现次数与跨界判定：plain/numeric=值内出现次数；rich=单
 *  run 内出现次数之和（拼接含 find 而单 run 皆不含 → 横跨 run 边界，计 0
 *  并标记跨界——该格拒改，不静默压平）。 */
function cellHitCount(value: CellValue, find: string): { count: number; spans: boolean } {
  if (value.kind === "plain") return { count: occurrences(value.value, find), spans: false };
  if (value.kind === "numeric") return { count: occurrences(value.vText, find), spans: false };
  if (value.kind === "rich") {
    let perRun = 0;
    for (const r of value.runs) perRun += occurrences(r.text, find);
    const concat = occurrences(value.text, find);
    // perRun ≤ concat 恒成立（run 内出现映射进拼接仍互不重叠）；严格小于即
    // 至少一处横跨边界——该格拒改（富格不部分改，保格式边界诚实拒）。
    return { count: concat > perRun ? 0 : perRun, spans: concat > perRun };
  }
  return { count: 0, spans: false };
}

/** 一格改写后的读面可见文本（互证层 tolerated 计量用——被拒/不参与格的
 *  find 残余是 by-design，须精确豁免）：b→TRUE/FALSE、其余取解转义 v 或块
 *  拼接；空串→空（读面空格口径折）。纯。 */
function visibleOf(value: CellValue, cell: CellSpan): string {
  if (value.kind === "plain") return value.value;
  if (value.kind === "rich") return value.text;
  if (value.kind === "numeric") return value.vText;
  // none 形回看 children——b→TRUE/FALSE、公式/错误取 v（读面 cellText 同
  // 款口径）。
  const t = attrValue(cell.attrs, "t");
  const v = /<v\b[^>]*?(?:\/>|>([\s\S]*?)<\/v>)/.exec(cell.children)?.[1];
  if (v === undefined) return "";
  if (t === "b") return v.trim() === "1" ? "TRUE" : "FALSE";
  return unescapeXml(v);
}

/** 格改写（原位外科）：
 *  - plain repoint（共享单 <t>/t="str"）：整值替换后重指 inlineStr——开标
 *    签 t 属性换新、r/s 及其余属性原样保留；重建块 t 恒带 preserve。
 *  - plain 非 repoint（inlineStr 单 t）：原位换 t 文本（开标签最小动，
 *    withPreserve 纪律）。
 *  - rich repoint（共享富）：重指 inlineStr 保 run 结构（rPr 原样、命中
 *    run 文本替换、其余 run 原文重序列化）。
 *  - rich 非 repoint（inline 富）：原位逐 run 换 t 文本（未命中 run 字节
 *    零动）。
 *  - numeric：新文本非空且 Number.isFinite → 原位换 <v>（数字形保持，无
 *    转义必要——闸保证纯数字形）；否则 numericSkipped 收格位、原格零动。
 *  返回 null=该格不改（跨界/无命中）。 */
function rewriteCell(span: CellSpan, value: CellValue, find: string, replaceText: string): string | null {
  if (value.kind === "plain") {
    if (!value.value.includes(find)) return null;
    const newValue = value.value.split(find).join(replaceText); // split-join：字面全替换不递归
    if (value.repoint) {
      const attrs = span.attrs.replace(/\bt\s*=\s*("[^"]*"|'[^']*')/, `t="inlineStr"`);
      return `<c${attrs}><is><t xml:space="preserve">${escapeXml(newValue)}</t></is></c>`;
    }
    const tMatch = /<t\b[^>]*?(?:\/>|>)([\s\S]*?)<\/t>/.exec(span.children);
    if (tMatch === null) return null; // 病态（单 t 形解析过才有值）——防御
    const openTag = span.children.slice(tMatch.index!, tMatch.index! + tMatch[0].length - tMatch[1]!.length - "</t>".length);
    const rebuilt = `${withPreserve(openTag, newValue)}${escapeXml(newValue)}</t>`;
    const children = span.children.slice(0, tMatch.index!) + rebuilt + span.children.slice(tMatch.index! + tMatch[0].length);
    return `<c${span.attrs}>${children}</c>`;
  }
  if (value.kind === "rich") {
    if (!value.runs.some((r) => r.text.includes(find))) return null;
    if (value.repoint) {
      const newRuns = value.runs.map((r) => (r.text.includes(find) ? { ...r, text: r.text.split(find).join(replaceText) } : r));
      const attrs = span.attrs.replace(/\bt\s*=\s*("[^"]*"|'[^']*')/, `t="inlineStr"`);
      return `<c${attrs}><is>${serializeRuns(newRuns)}</is></c>`;
    }
    // inline 富：原位逐 run 换 t（未命中 run 字节零动）。
    let children = "";
    let cursor = 0;
    for (const run of span.children.matchAll(/<r\b[^>]*>([\s\S]*?)<\/r>/g)) {
      const runBody = run[1]!;
      const tMatch = /<t\b[^>]*?(?:\/>|>)([\s\S]*?)<\/t>/.exec(runBody);
      if (tMatch === null || !unescapeXml(tMatch[1] ?? "").includes(find)) continue;
      const text = unescapeXml(tMatch[1] ?? "").split(find).join(replaceText);
      const openTag = runBody.slice(tMatch.index!, tMatch.index! + tMatch[0].length - tMatch[1]!.length - "</t>".length);
      const rebuiltRun = run[0]!.slice(0, run[0]!.length - runBody.length - "</r>".length) +
        `${withPreserve(openTag, text)}${escapeXml(text)}</t></r>`;
      children += span.children.slice(cursor, run.index!) + rebuiltRun;
      cursor = run.index! + run[0]!.length;
    }
    if (cursor === 0) return null; // 防御（classify 与此处判定同源，不可达）
    return `<c${span.attrs}>${children + span.children.slice(cursor)}</c>`;
  }
  if (value.kind === "numeric") {
    if (!value.vText.includes(find)) return null;
    const newText = value.vText.split(find).join(replaceText);
    if (newText === "" || !Number.isFinite(Number(newText))) return null; // 数字闸——调用方收格位
    const vMatch = /<v\b[^>]*?(?:\/>|>)([\s\S]*?)<\/v>/.exec(span.children);
    if (vMatch === null) return null;
    const openTag = span.children.slice(vMatch.index!, vMatch.index! + vMatch[0].length - vMatch[1]!.length - "</v>".length);
    const rebuilt = `${openTag}${newText}</v>`; // 纯数字形无实体，escape 恒等价于直写
    const children = span.children.slice(0, vMatch.index!) + rebuilt + span.children.slice(vMatch.index! + vMatch[0].length);
    return `<c${span.attrs}>${children}</c>`;
  }
  return null;
}

/** 改写单表的结果：超帽不动（点名总数）/ 未超则新 xml、替换数、跨界格位、
 *  数字闸格位、非改格可见残余量（互证层豁免计量）。 */
export type SheetReplaceCheck =
  | { readonly overLimit: true; readonly total: number }
  | {
      readonly overLimit: false;
      readonly newXml: string;
      readonly replaced: number;
      readonly spansCells: readonly string[];
      readonly numericSkipped: readonly string[];
      readonly toleratedFind: number;
    };

/** sheetData 区域抽取（开闭对；自闭合形=空表容）。 */
function sheetDataRegion(sheetXml: string): { body: string; prefix: string; suffix: string } | undefined {
  const sd = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(sheetXml);
  if (sd !== null) {
    const body = sd[1]!;
    const bodyStart = sd.index! + sd[0].length - body.length - "</sheetData>".length;
    return { body, prefix: sheetXml.slice(0, bodyStart), suffix: sheetXml.slice(bodyStart + body.length) };
  }
  return undefined; // 自闭合 <sheetData/> 或缺失——零格（appendXlsxRows 的病态宽容不适用：改写面无锚点即无格可改
}

/** count pass：单表的可替换出现次数总和（跨界富格计 0、不参与格计 0）。
 *  纯。 */
export function countSheetOccurrences(sheetXml: string, shared: readonly SharedStringItem[], find: string): number {
  const region = sheetDataRegion(sheetXml);
  if (region === undefined) return 0;
  let total = 0;
  for (const cell of scanCells(region.body)) {
    total += cellHitCount(classifyCell(cell.attrs, cell.children, shared), find).count;
  }
  return total;
}

/** 先扫后改单趟（229 同形）：count pass 全量计数，超 budget 不动返
 *  {overLimit:true, total}；未超则 replace pass 逐格原位外科——共享格重指
 *  inlineStr（r/s 保真）、inline 格原位换、富单 run 保结构、跨 run 拒收格
 *  位、数字闸收格位；dimension 不动（无行列几何变化）。纯。 */
export function replaceInSheetXml(
  sheetXml: string,
  shared: readonly SharedStringItem[],
  find: string,
  replaceText: string,
  budget: number,
): SheetReplaceCheck {
  const region = sheetDataRegion(sheetXml);
  if (region === undefined) {
    return { overLimit: false, newXml: sheetXml, replaced: 0, spansCells: [], numericSkipped: [], toleratedFind: 0 };
  }
  const cells = scanCells(region.body);
  let total = 0;
  for (const cell of cells) {
    total += cellHitCount(classifyCell(cell.attrs, cell.children, shared), find).count;
  }
  if (total > budget) return { overLimit: true, total };

  let out = "";
  let cursor = 0;
  let replaced = 0;
  const spansCells: string[] = [];
  const numericSkipped: string[] = [];
  let tolerated = 0;
  for (const cell of cells) {
    const value = classifyCell(cell.attrs, cell.children, shared);
    const hit = cellHitCount(value, find);
    if (hit.spans) {
      spansCells.push(cell.ref); // 跨 run 拒——原格零动，残余计入豁免
      tolerated += occurrences(visibleOf(value, cell), find);
      continue;
    }
    if (hit.count === 0) {
      tolerated += occurrences(visibleOf(value, cell), find); // 不参与/无命中的可见残余豁免
      continue;
    }
    const rewritten = rewriteCell(cell, value, find, replaceText);
    if (rewritten === null) {
      numericSkipped.push(cell.ref); // 数字闸拒——原格零动，残余计入豁免
      tolerated += occurrences(visibleOf(value, cell), find);
      continue;
    }
    replaced += hit.count;
    out += region.body.slice(cursor, cell.cellStart) + rewritten;
    cursor = cell.cellEnd;
  }
  return {
    overLimit: false,
    newXml: region.prefix + out + region.body.slice(cursor) + region.suffix,
    replaced,
    spansCells,
    numericSkipped,
    toleratedFind: tolerated,
  };
}

/** replaceXlsxText 的结果（四形判别 + typed 拒；各形带交叉键 undefined——
 *  判别式收窄可用）。skippedNumeric/spans 的格位带表名（Sheet!B7 词汇，
 *  多表 scope 可区分）。 */
export type ReplaceXlsxCheck =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      readonly replaced: number;
      readonly sheetsTouched: number;
      readonly spansRemaining: number;
      readonly skippedNumeric: readonly { readonly sheet: string; readonly ref: string }[];
    }
  | {
      readonly ok: false;
      readonly reason: "spans_runs";
      readonly cells: readonly { readonly sheet: string; readonly ref: string }[];
      readonly total?: undefined;
      readonly limit?: undefined;
      readonly error?: undefined;
    }
  | {
      readonly ok: false;
      readonly reason: "over_limit";
      readonly total: number;
      readonly limit: number;
      readonly cells?: undefined;
      readonly error?: undefined;
    }
  | {
      readonly ok: false;
      readonly reason: "not_found";
      readonly cells?: undefined;
      readonly total?: undefined;
      readonly limit?: undefined;
      readonly error?: undefined;
    }
  | {
      readonly ok: false;
      readonly reason?: undefined;
      readonly cells?: undefined;
      readonly total?: undefined;
      readonly limit?: undefined;
      readonly error: string;
    };

/** 解包→表清单（scope 收窄或全表）→全局帽（不分表，229 同形）→逐表先扫
 *  后改→smartZip 回装（**仅命中格所在 sheet 部件换新，其余部件含
 *  sharedStrings.xml 挂 meta 原样直过**——230 三形裁定自动保真）→互证收
 *  据层：回装字节喂 parseXlsxSheets，断言 scoped 表内 find 残余不超过逐格
 *  计量的豁免量（跨界拼接/数字闸/不参与格的可见值——比 229 的四跳条件更
 *  精确的第三落地：b/e/f 不参与格的残余同样豁免，公式缓存值可见性对齐读
 *  面）、replace 在场（空白替换/零替换不检——读面行不变量折）。replaced
 *  ===0 且有跨 run → spans_runs 拒；零命中 → not_found；纯数字闸残余 →
 *  ok 带警示（字节原样，收据点名格位）。纯函数：不碰时钟、不碰盘。 */
export function replaceXlsxText(
  bytes: Uint8Array,
  find: string,
  replaceText: string,
  sheet?: string | number,
  maxCount: number = REPLACE_DEFAULT_MAX_COUNT,
): ReplaceXlsxCheck {
  const unzipped = unzipEntriesWithMeta(bytes);
  if (!unzipped.ok) return { ok: false, error: unzipped.error }; // xlsx 口径文案原样直过

  // scope：sheet 参数走 scanXlsxSheetPart（228 拒文案同源）；缺省全表。
  let scoped: readonly { name: string; partName: string }[];
  if (sheet === undefined) {
    const all = workbookSheets(unzipped.entries);
    if (!all.ok) return { ok: false, error: all.error };
    scoped = all.sheets;
  } else {
    const one = scanXlsxSheetPart(unzipped.entries, sheet);
    if (!one.ok) return { ok: false, error: one.error };
    scoped = [{ name: one.sheetName, partName: one.partName }];
  }

  const dec = new TextDecoder();
  const ssPart = unzipped.entries.find((e) => e.name === "xl/sharedStrings.xml");
  const shared = ssPart === undefined ? [] : parseSharedStrings(dec.decode(ssPart.data));
  const xmls = scoped.map((s) => dec.decode(unzipped.entries.find((e) => e.name === s.partName)!.data));

  // count pass：全局帽不分表（跨表汇总先判，超帽任何部件都不动）。
  let total = 0;
  for (const xml of xmls) total += countSheetOccurrences(xml, shared, find);
  if (total > maxCount) return { ok: false, reason: "over_limit", total, limit: maxCount };

  // replace pass：各跑各的（全局帽已判，单趟不会超）。
  let replaced = 0;
  let tolerated = 0;
  const changed = new Map<number, string>();
  const spansLocs: { sheet: string; ref: string }[] = [];
  const numericLocs: { sheet: string; ref: string }[] = [];
  xmls.forEach((xml, i) => {
    const r = replaceInSheetXml(xml, shared, find, replaceText, maxCount);
    if (r.overLimit) return; // 不可达（全局帽已判）——防御
    replaced += r.replaced;
    tolerated += r.toleratedFind;
    if (r.replaced > 0) changed.set(i, r.newXml);
    for (const ref of r.spansCells) spansLocs.push({ sheet: scoped[i]!.name, ref });
    for (const ref of r.numericSkipped) numericLocs.push({ sheet: scoped[i]!.name, ref });
  });

  if (replaced === 0 && spansLocs.length > 0) return { ok: false, reason: "spans_runs", cells: spansLocs };
  if (replaced === 0 && numericLocs.length === 0) return { ok: false, reason: "not_found" };

  // 回装：改到的 sheet 部件换新，其余（含 sharedStrings.xml）原字节挂 meta
  // 直过——smartZip 自行 bytesEqual 裁定（无信任旗帜，230 纪律）。
  const byPart = new Map(scoped.map((s, i) => [s.partName, i]));
  const enc = new TextEncoder();
  const parts: SmartZipEntry[] = unzipped.entries.map((e) => {
    const i = byPart.get(e.name);
    const nx = i === undefined ? undefined : changed.get(i);
    return { name: e.name, data: nx === undefined ? e.data : enc.encode(nx), meta: e };
  });
  const out = smartZip(parts);

  // 读写互证（223/228/229 范式）：回装字节喂读面。
  const parsed = parseXlsxSheets(out);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const scopedNames = new Set(scoped.map((s) => s.name));
  const texts: string[] = [];
  for (const s of parsed.sheets) {
    if (!scopedNames.has(s.name)) continue;
    for (const row of s.rows) for (const cell of row) if (cell !== null) texts.push(cell);
  }
  let visibleFind = 0;
  for (const t of texts) visibleFind += occurrences(t, find);
  if (replaced > 0 && replaceText.trim() !== "" && !texts.some((t) => t.includes(replaceText))) {
    return { ok: false, error: "这不是有效的 Excel（.xlsx）文件——文件结构不完整或已损坏" };
  }
  if (!replaceText.includes(find) && visibleFind > tolerated) {
    return { ok: false, error: "这不是有效的 Excel（.xlsx）文件——文件结构不完整或已损坏" };
  }
  return {
    ok: true,
    bytes: out,
    replaced,
    sheetsTouched: changed.size,
    spansRemaining: spansLocs.length,
    skippedNumeric: numericLocs,
  };
}

// ---------------------------------------------------------------------------
// B — 工具面：replace_xlsx（三件套「改」半边 xlsx 侧收口）。path（必填，
// 相对工作区）+ find（必填非空）+ replace（必填，可空串=删除）+ sheet（可
// 选 string|正整数）+ maxCount（可选，缺省 50 硬帽 200）；魔数嗅探：OLE
// （旧版 .xls）给「另存为 .xlsx」出路、非 PK 拒；改写只覆写目标文件本身
// （零删除面零 mkdir）。
// ---------------------------------------------------------------------------

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0] as const;

/** 数字闸警示的格位列表：裸 ref（B7、C9——brief 例形）；截前 5 格防警示
 *  爆量，余量见收据计数。 */
function numericCellList(cells: readonly { sheet: string; ref: string }[]): string {
  return cells.slice(0, 5).map((c) => c.ref).join("、");
}

/** 把工作区里现有 Excel 文件（.xlsx）表里的某段文字就地换成新文字。顶级工
 * 具（tools.ts 固定钉位）；路径必经 resolveWorkspacePath（外逃/绝对路径
 * typed 拒，fail-closed）；校验先于副作用：拒时零写盘。姿态镜像
 * make_/append_/replace_ 写面。 */
export function createReplaceXlsxTool(workspaceRoot: string): Tool {
  return buildTool({
    name: "replace_xlsx",
    description:
      "把工作区里现有 Excel 文件（.xlsx）表里的某段文字就地换成新文字，其他单元格的内容、公式和表格样式原样保留。适合「把表里这格的旧值换成新值」「把旧公司名全表换掉」类请求；与读表的 read_xlsx 配套——先读确认原文，再把要改的文字就地换掉。" +
      " path 是文件相对工作区的路径。find 是要找的原文字（不能为空），replace 是换成什么（可以给空串表示删除），sheet 可选：只改哪张工作表（名字或 1 起序号），缺省全部工作表都改。maxCount 可选：一次最多替换多少处（缺省 50，最大 200，命中更多会拒并告知总数，可缩小范围或分批）。" +
      " 注意：只改文本格和数字格的值；如果某格的文字在单元格里被拆成多段不同格式的文字（比如夹了不同颜色或字号的字），无法原位替换，会点名在哪张表哪个格——可先读表定位后重建该格，或缩小 find；公式格、布尔格不改（避免与重算结果不一致）；数字格换成数字才算有效，换成文字会被拒绝并点名；Excel 里的日期本质是数字序号，替换日期请按 read_xlsx 读到的序号口径给 find；旧版 .xls 格式不支持，需先在 Excel 里另存为 .xlsx。",
    // 写盘（非只读）；只在本地文件系统（closed-world）。覆写目标文件本身
    // → destructive 诚实标注（make_/append_/replace_ 同款 posture 镜像）。
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    isOpenWorld: () => false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要改写的 Excel 文件路径（相对工作区，可带子目录），.xlsx 文件。" },
        find: { type: "string", description: "要找的原文字（非空）——按表里出现的原样给。" },
        replace: { type: "string", description: "换成什么；空串表示删除这段文字。" },
        // sheet 双形（名或 1 起序号）：wire 类型只认标量，报 string 形（名
        // 字是主用法）；序号形在 execute 里 typed 认（read_xlsx/append_xlsx
        // 同款纪律）。
        sheet: { type: "string", description: "只改哪张工作表：名字或序号（1 起）；缺省全部工作表都改。read_xlsx 会先列出全部工作表供选择。" },
        maxCount: { type: "number", description: "一次最多替换多少处（全部工作表合计）；缺省 50，最大 200（命中更多会拒并告知总数）。" },
      },
      required: ["path", "find", "replace"],
      additionalProperties: false,
    },
    async execute(args) {
      // 参数 typed 校验（先于任何盘副作用）。
      const rawPath = args["path"];
      if (typeof rawPath !== "string" || rawPath.trim() === "") {
        return { content: 'replace_xlsx: "path" must be a non-empty path relative to the workspace', isError: true };
      }
      const rel = rawPath.trim();
      const checked = validateDocReplace(args["find"], args["replace"], args["maxCount"]);
      if (!checked.ok) return { content: `replace_xlsx: ${checked.error}`, isError: true };

      let sheetSel: string | number | undefined;
      const rawSheet = args["sheet"];
      if (rawSheet !== undefined) {
        if (typeof rawSheet === "string") {
          if (rawSheet.trim() === "") {
            return { content: 'replace_xlsx: "sheet" must be a worksheet name or a 1-based sheet number', isError: true };
          }
          sheetSel = rawSheet.trim();
        } else if (typeof rawSheet === "number" && Number.isInteger(rawSheet) && rawSheet >= 1) {
          sheetSel = rawSheet;
        } else {
          return { content: 'replace_xlsx: "sheet" must be a worksheet name or a 1-based sheet number', isError: true };
        }
      }

      // 工作区边界（外逃/绝对路径/符号链接诡计拒）。
      const resolved = await resolveWorkspacePath(workspaceRoot, rel);
      if (!resolved.ok) return { content: `replace_xlsx: ${resolved.error}`, isError: true };

      let bytes: Uint8Array;
      try {
        bytes = await readFile(resolved.absPath);
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return { content: `replace_xlsx: 文件不存在：${rel}`, isError: true };
        }
        return { content: `replace_xlsx: 读取失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
      }

      // 魔数嗅探先于结构解析：旧版 .xls（OLE 复合文档）与「根本不是
      // Excel」分开拒——前者有出路（另存为 .xlsx），说清楚。
      if (bytes.length >= 4 && OLE_MAGIC.every((b, i) => bytes[i] === b)) {
        return {
          content: `replace_xlsx: ${rel} 是旧版 .xls 格式，改不了——请先用 Excel 打开并「另存为」.xlsx 格式后再试`,
          isError: true,
        };
      }
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
        return {
          content: `replace_xlsx: ${rel} 不是 Excel（.xlsx）文件——如果它是旧版 .xls 或其他格式，请先在 Excel 里另存为 .xlsx 再试`,
          isError: true,
        };
      }

      const replaced = replaceXlsxText(bytes, checked.find, checked.replace, sheetSel, checked.maxCount);
      if (!replaced.ok) {
        if (replaced.reason === "spans_runs") {
          const listed = replaced.cells
            .slice(0, 5)
            .map((c) => `${c.sheet}!${c.ref}`)
            .join("、");
          const more = replaced.cells.length > 5 ? `……等共 ${replaced.cells.length} 格` : "";
          return {
            content:
              `replace_xlsx: 「${checked.find}」在 ${replaced.cells.length} 个格里被拆分在多个富文本段内，无法原位替换（保格式边界）——${listed}${more}。` +
              `可 read_xlsx 定位后重建该格，或缩小 find`,
            isError: true,
          };
        }
        if (replaced.reason === "over_limit") {
          return {
            content: `replace_xlsx: 命中 ${replaced.total} 处超过上限 ${replaced.limit}——请缩小 find、指定 sheet，或分批（增大 maxCount 至 ${REPLACE_HARD_MAX_COUNT} 内）`,
            isError: true,
          };
        }
        if (replaced.reason === "not_found") {
          return { content: `replace_xlsx: 没有找到「${checked.find}」——这份表里没有出现这段文字（可先 read_xlsx 核对原文）`, isError: true };
        }
        return { content: `replace_xlsx: ${replaced.error}`, isError: true };
      }

      // 改写=覆写目标文件本身（零删除面零 mkdir；目录已存在——刚读过这文件）。
      try {
        await writeFile(resolved.absPath, replaced.bytes);
      } catch (err) {
        return { content: `replace_xlsx: 写入失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
      }
      const kb = (replaced.bytes.byteLength / 1024).toFixed(1);
      const spansWarn =
        replaced.spansRemaining > 0 ? `（另有 ${replaced.spansRemaining} 处被拆分在多个富文本段内，未替换）` : "";
      const numericWarn =
        replaced.skippedNumeric.length > 0
          ? `（另有 ${replaced.skippedNumeric.length} 格数字改后不再是有效数字，未替换：${numericCellList(replaced.skippedNumeric)}）`
          : "";
      const cross = sheetSel === undefined && replaced.sheetsTouched > 1 ? `跨 ${replaced.sheetsTouched} 张表，` : "";
      return {
        // 收据=用户语：一句中文（路径/替换数/找换对/警示子句/跨表子句）+
        // 结构化字段一行（文件卡从这行提取）。
        content:
          `已在 ${rel} 就地替换 ${replaced.replaced} 处「${checked.find}」→「${checked.replace}」${spansWarn}${numericWarn}（${cross}${kb} KB）\n` +
          JSON.stringify({
            path: resolved.absPath,
            relativePath: rel,
            replaced: replaced.replaced,
            sheetsTouched: replaced.sheetsTouched,
            skippedNumeric: replaced.skippedNumeric,
            bytes: replaced.bytes.byteLength,
          }),
      };
    },
  });
}

/** log.ts summarize 的对象摘要件（导出给测试直钉）：文件尾名 + 找换对，
 *  形「订单.xlsx 替换「旧」→「新」」（220 裁定语法：summary=动作对象；
 *  summarize 只见输入，N 在结果不可达不编造；空串替换「」如实显）。
 *  纯。 */
export function summarizeReplaceXlsx(input: Record<string, unknown>): string {
  const parts: string[] = [];
  const path = input["path"];
  if (typeof path === "string" && path.trim() !== "") parts.push(basename(path.trim()));
  const find = input["find"];
  const replace = input["replace"];
  if (typeof find === "string" && find !== "" && typeof replace === "string") {
    parts.push(`替换「${find}」→「${replace}」`);
  }
  return parts.join(" ");
}
