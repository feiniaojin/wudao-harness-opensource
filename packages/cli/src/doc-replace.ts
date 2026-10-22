// ω99-229: #1 — docx/pptx 就地改写面纯层 + 两工具面（零依赖）。「把这份文档
// 里的旧公司名换成新的」「把这页 PPT 的日期改了」是编辑类最高频动作——读
// （221/222）、造（123）、追加（223/228）都齐了，唯独「改」缺位：模型此前只
// 能读→整文件重造，丢用户原格式又费 token。本面补第三刀：**就地文本替换**。
//
// 设计裁定（超越点，brief §零钉，写进代码注释）：**run 边界诚实拒替**。替换
// 作用域=单个文本节点（docx <w:t> / pptx <a:t>）内：节点文本含 find → 原位
// 替换，**格式全保真**（只动节点内文本，run/段落属性零触碰）；**串存在但横跨
// run 边界 → 不静默漏，typed 拒 + 段落定位 + 出路**（检测器用与读面同源的
// run 拼接纪律：段落全拼接含 find 但任何单节点不含 → 拒语点名第几段+拼接预
// 览，出路=read 定位后用 append 侧重建该段，或整文档重造）。docx 正文被 Word
// 拆成任意多个 <w:r>（拼写检查/IME/中英混排都会拆），朴素 XML find-replace 对
// 跨 run 文本**静默漏替**——python-docx 时代就著名的坑，多数 OOXML 工具至今
// 装聋。把行业的静默 miss 变成可行动的拒，是本弧对 223/228 追加范式的超越；
// 读写互证范式也从收据层（228 读回行数）前移到**拒替判定层**（229 判定前拼
// 接）——同一哲学两处落地。
//
// 纯层七件（brief §二）：escapeXml/unescapeXml（双向——比较前 unescape、写回
// 前 escape，实体往返钉）+ scanTextNodes（开闭对扫描，属性形收自闭合略过）+
// countAndReplace（先扫后改单趟，全局帽）+ detectSpansRuns（跨 run 检测，拼
// 接纪律同读面）+ validateDocReplace（typed 帽子）+ replaceDocxText /
// replacePptxText（unzip→缝→smartZip 回装 + 互证收据层）。
//
// ω99-230: #5 — 回装自 storedZip 换 smartZip（压缩透传）：unzip→meta
// 变体（unzipEntriesWithMeta）→ 未改部件原压缩载荷字节直过、改到的部件按
// 原 method 重压——用户 Office 存的 deflate 包不再改几个字就全包重装为不
// 压缩（改一处胖数倍的债收口）。改动判定内建于 smartZip（bytesEqual 重推
// 导，本面只统一挂 meta——无信任旗帜）；工具面/门序/收据/summarize 零动。
//
// 纪律（brief 钉，221/222/223/228 同款）：
// - 纯层纯函数：不碰时钟（DOS 时间由 doc-zip 钉）、不碰盘（盘只在工具面
//   execute 里 readFile/writeFile）；
// - 原包字节保真：除改到的部件外逐字节过 zip 层；条目名序原样（确定性：同
//   输入两次全等）；
// - typed 拒优于静默剥：坏 zip/加密/Zip64/缺部件/坏参数直接拒，错误信息用户
//   语（unzipEntries 本体是 xlsx 口径，本面映射成 docx/pptx 词汇——223 追加
//   面同款本地件）；
// - 帽子：maxCount 缺省 50、硬帽 200（护栏不是拒绝功能的门——模型可分批）；
//   find 非空；find===replace 拒（无操作）；replace 可空串（=删除）；控制字
//   政策逐字同 make 面（\x00-\x08、\x0B、\x0C、\x0E-\x1F 拒，\t \n \r 放行）；
//   find/replace 长度不设帽（append_* 零帽先例）；
// - 互证收据层（223/228 范式）：回装字节喂 parseDocxDocument / parsePptxSlides
//   断言 find 零余、replace 在场——「已替换 N 处」从读回来。跨 run 拒的分支
//   不进互证（没改）。
import { smartZip, unzipEntriesWithMeta } from "./doc-zip.js";
import type { ZipEntry } from "./doc-zip.js";
import { parseDocxDocument } from "./doc-docx-read.js";
import { parsePptxSlides } from "./doc-pptx-read.js";
import { buildTool, resolveWorkspacePath } from "@wudao/core";
import type { Tool } from "@wudao/core";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

// ---------------------------------------------------------------------------
// A — 改写纯层。
// ---------------------------------------------------------------------------

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** XML 实体解码：五个命名实体 + 十进制/十六进制数字实体（单趟，不双解）——
 *  读面 doc-docx-read.ts 同款纪律的本地件（复制不重构，读面字节零动）。 */
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

/** 五实体转义（&amp; &lt; &gt; &quot; &apos;）——doc-xlsx-append.ts 同款件
 *  逐字复制（追加面未导出；复制 ~5 行，注释钉同源）。 */
function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&apos;");
}

/** 子串出现次数（split 计数；find 已由调用方保证非空）。 */
function occurrences(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

/** 一个扫出的文本节点：raw=原（仍转义）内文、text=unescape 后；开标签与内文
 *  的原 xml 偏移（缝补层原位写回用）。 */
export interface TextNodeSpan {
  readonly raw: string;
  readonly text: string;
  readonly openTag: string;
  readonly tagStart: number;
  readonly contentStart: number;
  readonly contentEnd: number;
}

/** 扫 <w:t …>…</w:t> / <a:t …>…</a:t> 开闭对：属性形（xml:space= 等）收；
 *  自闭合形无文本略过。产出节点清单（text=unescape 后）。纯。 */
export function scanTextNodes(xml: string, nodeTag: string): readonly TextNodeSpan[] {
  const token = new RegExp(`<${nodeTag}\\b[^>]*?(?:\\/>|>([\\s\\S]*?)<\\/${nodeTag}>)`, "g");
  const out: TextNodeSpan[] = [];
  for (const m of xml.matchAll(token)) {
    if (m[1] === undefined) continue; // 自闭合形（无文本）
    const content = m[1]!;
    const closeLen = `</${nodeTag}>`.length;
    const openEnd = m.index! + m[0].length - content.length - closeLen;
    out.push({
      raw: content,
      text: unescapeXml(content),
      openTag: xml.slice(m.index!, openEnd),
      tagStart: m.index!,
      contentStart: openEnd,
      contentEnd: openEnd + content.length,
    });
  }
  return out;
}

/** count-replace 的结果：超帽不动（点名总数）/ 未超则已改写的新 xml 与替换数。 */
export type CountAndReplaceCheck =
  | { readonly overLimit: true; readonly total: number }
  | { readonly overLimit: false; readonly newXml: string; readonly replaced: number };

/** 开标签按需补 xml:space="preserve"：结果文本为空串（brief 钉——空节点保
 *  留且必带）或首尾带空白（Word 默认修剪首尾空白，同一修剪风险的延伸）时，
 *  开标签缺该属性则补；已带或不需要则原样返回（属性保持=字节保真）。 */
function openTagWithPreserve(openTag: string, resultText: string, nodeTag: string): string {
  if (/xml:space\s*=\s*["']preserve["']/.test(openTag)) return openTag;
  const needs = resultText === "" || /^[ \t\r\n]/.test(resultText) || /[ \t\r\n]$/.test(resultText);
  if (!needs) return openTag;
  return openTag.replace(new RegExp(`^<${nodeTag}\\b`), (m) => `${m} xml:space="preserve"`);
}

/** 先扫后改单趟：count pass 数全部出现次数（节点内可多次），**超 maxCount 不
 *  动**返 {overLimit:true, total}；未超则 replace pass 改写——unescape 后比
 *  较/替换、re-escape 写回原开闭对之间（未命中区域的既有实体保持转义形），
 *  xml:space="preserve" 属性保持（空串/首尾空白结果必带）。纯。 */
export function countAndReplace(
  xml: string,
  nodeTag: string,
  find: string,
  replaceText: string,
  maxCount: number,
): CountAndReplaceCheck {
  const nodes = scanTextNodes(xml, nodeTag);
  let total = 0;
  for (const n of nodes) total += occurrences(n.text, find);
  if (total > maxCount) return { overLimit: true, total };
  let out = "";
  let cursor = 0;
  let replaced = 0;
  for (const n of nodes) {
    if (!n.text.includes(find)) continue;
    const newText = n.text.split(find).join(replaceText); // split-join：字面全替换，replace 含 find 也不递归
    replaced += occurrences(n.text, find);
    out += xml.slice(cursor, n.tagStart) + openTagWithPreserve(n.openTag, newText, nodeTag) + escapeXml(newText);
    cursor = n.contentEnd;
  }
  return { overLimit: false, newXml: out + xml.slice(cursor), replaced };
}

/** 一个跨 run 命中的段落：paragraphIndex=文档序 1 起（含空段与表内段——
 *  <w:p> 元素序，与 read_docx 块窗编号在表前文档里一致）；preview=拼接前
 *  40 字（码点计）；slideIndex=pptx 的张号（sldIdLst 张序，docx 恒缺省）。 */
export interface SpanningParagraph {
  readonly paragraphIndex: number;
  readonly preview: string;
  readonly slideIndex?: number;
}

/** 一段内文 → 全部文本节点拼接（unescape 后直拼；br/tab 折空格纪律**同读
 *  面**——空格必须落在文本节点里才进拼接，不粘字；首尾空白剪除）。 */
function paragraphConcat(inner: string, nodeTag: string, prefix: string): string {
  const spaceRun = `<${nodeTag}> </${nodeTag}>`;
  const folded = inner
    .replace(new RegExp(`<${prefix}:br\\b[^>]*?(?:\\/|><\\/${prefix}:br>)`, "g"), spaceRun)
    .replace(new RegExp(`<${prefix}:tab\\b[^>]*?\\/>`, "g"), spaceRun);
  let out = "";
  for (const n of scanTextNodes(folded, nodeTag)) out += n.text;
  return out.trim();
}

/** 跨 run 检测（replaced===0 时跑）：段落开闭对（docx <w:p> / pptx <a:p>，
 *  段落不嵌套——直接子级才起算；自闭合空段计序不进拼接）内同段全部文本节点
 *  拼接，拼接含 find → 收集 {paragraphIndex, preview}。返回清单（可能多段）。
 *  纯。 */
export function detectSpansRuns(
  xml: string,
  find: string,
  paragraphTag: string,
  nodeTag: string,
): readonly SpanningParagraph[] {
  const prefix = nodeTag.includes(":") ? nodeTag.slice(0, nodeTag.indexOf(":")) : "";
  const token = new RegExp(`<${paragraphTag}\\b[^>]*?(\\/?)>|<\\/${paragraphTag}>`, "g");
  const out: SpanningParagraph[] = [];
  let start = -1;
  let index = 0;
  for (const m of xml.matchAll(token)) {
    if (m[0].startsWith("</")) {
      if (start >= 0) {
        const concat = paragraphConcat(xml.slice(start, m.index), nodeTag, prefix);
        if (concat.includes(find)) {
          out.push({ paragraphIndex: index, preview: Array.from(concat).slice(0, 40).join("") });
        }
        start = -1;
      }
    } else {
      index += 1;
      if (m[1] !== "/") start = m.index! + m[0].length;
    }
  }
  return out;
}

/** 帽子：maxCount 缺省 50、硬帽 200（read 面 limit 同款钳制，不是拒绝功能的
 *  门——模型可分批）；find 非空；find===replace 拒；replace 可空串；控制字
 *  政策逐字同 make 面（\t \n \r 放行）。纯函数，永不抛。 */
export const REPLACE_DEFAULT_MAX_COUNT = 50;
export const REPLACE_HARD_MAX_COUNT = 200;

const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

export type ValidateReplaceCheck =
  | { readonly ok: true; readonly find: string; readonly replace: string; readonly maxCount: number }
  | { readonly ok: false; readonly error: string };

/** typed 校验（先于任何盘副作用）：find 必填非空 string、replace 必填 string
 *  （可空串=删除）、maxCount 可选正整数（缺省 50、硬帽 200 钳制）。 */
export function validateDocReplace(rawFind: unknown, rawReplace: unknown, rawMaxCount: unknown): ValidateReplaceCheck {
  if (typeof rawFind !== "string" || rawFind === "") {
    return { ok: false, error: '"find" must be a non-empty string of text to search for' };
  }
  if (typeof rawReplace !== "string") {
    return { ok: false, error: '"replace" must be a string (may be empty to delete the found text)' };
  }
  if (rawFind === rawReplace) {
    return { ok: false, error: '"replace" 与 "find" 相同——没有要做的改动' };
  }
  if (CONTROL_CHARS.test(rawFind)) {
    return { ok: false, error: '"find" contains a control character that cannot be searched — remove it (tabs and line breaks are fine)' };
  }
  if (CONTROL_CHARS.test(rawReplace)) {
    return { ok: false, error: '"replace" contains a control character that cannot go into a document — remove it (tabs and line breaks are fine)' };
  }
  let maxCount = REPLACE_DEFAULT_MAX_COUNT;
  if (rawMaxCount !== undefined) {
    if (typeof rawMaxCount !== "number" || !Number.isInteger(rawMaxCount) || rawMaxCount < 1) {
      return { ok: false, error: '"maxCount" must be a positive integer' };
    }
    maxCount = Math.min(rawMaxCount, REPLACE_HARD_MAX_COUNT);
  }
  return { ok: true, find: rawFind, replace: rawReplace, maxCount };
}

/** 跨 run / 超帽 / 不在场 / 其余 typed 拒的四形共用判别（docx 与 pptx 同形；
 *  各形带交叉键 undefined——判别式收窄可用）。 */
export type ReplaceDocCheck =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly replaced: number; readonly spansRemaining: number }
  | {
      readonly ok: false;
      readonly reason: "spans_runs";
      readonly paragraphs: readonly SpanningParagraph[];
      readonly total?: undefined;
      readonly limit?: undefined;
      readonly error?: undefined;
    }
  | {
      readonly ok: false;
      readonly reason: "over_limit";
      readonly total: number;
      readonly limit: number;
      readonly paragraphs?: undefined;
      readonly error?: undefined;
    }
  | {
      readonly ok: false;
      readonly reason: "not_found";
      readonly paragraphs?: undefined;
      readonly total?: undefined;
      readonly limit?: undefined;
      readonly error?: undefined;
    }
  | {
      readonly ok: false;
      readonly reason?: undefined;
      readonly paragraphs?: undefined;
      readonly total?: undefined;
      readonly limit?: undefined;
      readonly error: string;
    };

export type ReplacePptxCheck = ReplaceDocCheck;

/** unzip 的 xlsx 口径错误 → docx 词汇（加密类教 Word 出路；超大/压缩法类本就
 *  通用原样过）——222/223 同款映射，本地件。 */
function docxZipError(error: string): string {
  if (error.includes("密码")) {
    return "这个文件有密码保护，读取不了——请在 Word 里打开并另存为无密码的 .docx 副本后再试";
  }
  if (error.includes("超大") || error.includes("压缩方式")) return error;
  return "这不是有效的 Word（.docx）文件——文件结构不完整或已损坏";
}

/** unzip 的 xlsx 口径错误 → pptx 词汇（加密类教 PowerPoint 出路）。 */
function pptxZipError(error: string): string {
  if (error.includes("密码")) {
    return "这个文件有密码保护，读取不了——请在 PowerPoint 里打开并另存为无密码的 .pptx 副本后再试";
  }
  if (error.includes("超大") || error.includes("压缩方式")) return error;
  return "这不是有效的演示文稿（.pptx）文件——文件结构不完整或已损坏";
}

/** 互证的「在场」针：读面把 \t\r\n 折成空格（块的行不变量），针同折后才比。 */
function foldForRead(text: string): string {
  return text.replace(/[\t\r\n]+/g, " ");
}

/** 解包→定位 word/document.xml→count/replace→跨 run 检测→smartZip 回装（仅
 *  document.xml 换新，其余部件字节原样、条目名序原样；230 起按条目透传原
 *  method——未改部件原压缩载荷直过）→互证。docx 只扫 word/document.xml
 *  （页眉页脚/脚注/尾注 v1 不进——候池如实披露）。纯。 */
export function replaceDocxText(bytes: Uint8Array, find: string, replaceText: string, maxCount: number): ReplaceDocCheck {
  const unzipped = unzipEntriesWithMeta(bytes);
  if (!unzipped.ok) return { ok: false, error: docxZipError(unzipped.error) };
  const document = unzipped.entries.find((e) => e.name === "word/document.xml");
  if (document === undefined) {
    return { ok: false, error: "这不是有效的 Word（.docx）文件——缺少文档内容" };
  }
  const xml = new TextDecoder().decode(document.data);
  const car = countAndReplace(xml, "w:t", find, replaceText, maxCount);
  if (car.overLimit) return { ok: false, reason: "over_limit", total: car.total, limit: maxCount };
  if (car.replaced === 0) {
    const spans = detectSpansRuns(xml, find, "w:p", "w:t");
    if (spans.length > 0) return { ok: false, reason: "spans_runs", paragraphs: spans };
    return { ok: false, reason: "not_found" };
  }
  const enc = new TextEncoder();
  // 每条目统一挂 meta（原条目），已改/未改交给 smartZip 自行比对裁定。
  const parts = unzipped.entries.map((e) =>
    e === document ? { name: e.name, data: enc.encode(car.newXml), meta: e } : { name: e.name, data: e.data, meta: e },
  );
  const out = smartZip(parts);
  // 读写互证（223/228 范式）：回装字节喂读面——find 零余、replace 在场。跨 run
  // 拒的分支不进互证（没改）；混合形（换过但段落拼接仍含 find）跳过零余断言，
  // 残余数如实上抛（收据带警示子句，绝不静默漏）。replace 自含 find（如
  // 「旧」→「旧新」）时零余断言同样不成立，跳过。
  const parsed = parseDocxDocument(out);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const texts: string[] = [];
  for (const b of parsed.doc.blocks) {
    if (b.kind === "paragraph") texts.push(b.text);
    else for (const row of b.rows) texts.push(...row);
  }
  const spansRemaining = detectSpansRuns(car.newXml, find, "w:p", "w:t").length;
  if (replaceText.trim() !== "" && !texts.some((t) => t.includes(foldForRead(replaceText)))) {
    return { ok: false, error: "这不是有效的 Word（.docx）文件——文件结构不完整或已损坏" };
  }
  if (!replaceText.includes(find) && spansRemaining === 0 && texts.some((t) => t.includes(find))) {
    return { ok: false, error: "这不是有效的 Word（.docx）文件——文件结构不完整或已损坏" };
  }
  return { ok: true, bytes: out, replaced: car.replaced, spansRemaining };
}

/** presentation.xml 的 sldIdLst 张序 → 部件名（rels 的 r:id→target 解析，相
 *  对 ppt/、绝对形去头斜杠）——读面 parsePptxSlides 内部同款纪律的本地件
 *  （复制不重构，读面字节零动，228 scanXlsxSheetPart 先例）。 */
function slidePartOrder(
  parts: readonly ZipEntry[],
): { ok: true; order: readonly string[] } | { ok: false; error: string } {
  const find = (name: string) => parts.find((e) => e.name === name);
  const dec = new TextDecoder();
  const presentationPart = find("ppt/presentation.xml");
  if (presentationPart === undefined) {
    return { ok: false, error: "这不是有效的演示文稿（.pptx）文件——缺少文稿结构" };
  }
  const relsPart = find("ppt/_rels/presentation.xml.rels");
  const rels = new Map<string, string>();
  if (relsPart !== undefined) {
    for (const m of dec.decode(relsPart.data).matchAll(/<Relationship\b[^>]*>/g)) {
      const id = attrValue(m[0], "Id");
      const target = attrValue(m[0], "Target");
      if (id === undefined || target === undefined) continue;
      const normalized = target.startsWith("/") ? target.slice(1) : `ppt/${target.replace(/^\.\//, "")}`;
      rels.set(id, normalized);
    }
  }
  const order: string[] = [];
  for (const m of dec.decode(presentationPart.data).matchAll(/<p:sldId\b[^>]*>/g)) {
    const rid = attrValue(m[0], "r:id");
    const part = rid === undefined ? undefined : rels.get(rid);
    if (part === undefined || find(part) === undefined) {
      return {
        ok: false,
        error: `这不是有效的演示文稿（.pptx）文件——文稿引用了一张缺失的幻灯片（第 ${order.length + 1} 张）`,
      };
    }
    order.push(part);
  }
  if (order.length === 0) {
    return { ok: false, error: "这不是有效的演示文稿（.pptx）文件——没有找到任何幻灯片" };
  }
  return { ok: true, order };
}

/** 从一个起始标签文本里取属性值（属性序无关；单双引号都认）——追加面
 *  doc-pptx-append.ts 同款本地件。 */
function attrValue(tag: string, name: string): string | undefined {
  const m =
    new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(tag) ??
    new RegExp(`${name}\\s*=\\s*'([^']*)'`).exec(tag);
  return m?.[1];
}

/** 解包→**全部** slide 部件各跑各的（条目名实存枚举，不假设编号连续；含
 *  sldIdLst 未引用的孤儿部件——照改）→count 汇总先判全局帽（不分张）→改到
 *  的部件各回装、未改部件字节原样（230 起按条目透传原 method——未改部件
 *  原压缩载荷直过；ω99-230: #6）→互证。pptx 只扫 slides（layouts/masters/
 *  notesSlides v1 不进）。纯。 */
export function replacePptxText(bytes: Uint8Array, find: string, replaceText: string, maxCount: number): ReplacePptxCheck {
  const unzipped = unzipEntriesWithMeta(bytes);
  if (!unzipped.ok) return { ok: false, error: pptxZipError(unzipped.error) };
  const deckOrder = slidePartOrder(unzipped.entries);
  if (!deckOrder.ok) return { ok: false, error: deckOrder.error };
  const dec = new TextDecoder();
  const slideNumber = new Map(deckOrder.order.map((name, i) => [name, i + 1]));
  const slideParts = unzipped.entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name));
  if (slideParts.length === 0) {
    return { ok: false, error: "这不是有效的演示文稿（.pptx）文件——没有找到任何幻灯片" };
  }
  const xmls = slideParts.map((e) => dec.decode(e.data));

  // count pass：全局帽不分张（跨张汇总先判，超帽任何部件都不动）。
  let total = 0;
  for (const xml of xmls) for (const n of scanTextNodes(xml, "a:t")) total += occurrences(n.text, find);
  if (total > maxCount) return { ok: false, reason: "over_limit", total, limit: maxCount };

  // replace pass：各跑各的（全局帽已判，单趟不会超）。
  let replaced = 0;
  const changed = new Map<number, string>();
  xmls.forEach((xml, i) => {
    const car = countAndReplace(xml, "a:t", find, replaceText, maxCount);
    if (car.overLimit || car.replaced === 0) return;
    replaced += car.replaced;
    changed.set(i, car.newXml);
  });

  if (replaced === 0) {
    // 跨 run 检测（张序定位——read_pptx 的张号；孤儿部件不进报告，read_pptx
    // 看不见它们）。
    const paragraphs: SpanningParagraph[] = [];
    for (const part of deckOrder.order) {
      const idx = slideParts.findIndex((e) => e.name === part);
      if (idx === -1) continue;
      for (const p of detectSpansRuns(xmls[idx]!, find, "a:p", "a:t")) {
        paragraphs.push({ ...p, slideIndex: slideNumber.get(part) });
      }
    }
    if (paragraphs.length > 0) return { ok: false, reason: "spans_runs", paragraphs };
    return { ok: false, reason: "not_found" };
  }

  const enc = new TextEncoder();
  // 每条目统一挂 meta（原条目），已改/未改交给 smartZip 自行比对裁定。
  const parts = unzipped.entries.map((e) => {
    const i = slideParts.indexOf(e);
    const nx = i === -1 ? undefined : changed.get(i);
    return { name: e.name, data: nx === undefined ? e.data : enc.encode(nx), meta: e };
  });
  const out = smartZip(parts);
  // 读写互证（同 replaceDocxText 的四跳条件）。
  const parsed = parsePptxSlides(out);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const texts = parsed.slides.flatMap((s) => s.paragraphs);
  let spansRemaining = 0;
  xmls.forEach((xml, i) => {
    spansRemaining += detectSpansRuns(changed.get(i) ?? xml, find, "a:p", "a:t").length;
  });
  if (replaceText.trim() !== "" && !texts.some((t) => t.includes(foldForRead(replaceText)))) {
    return { ok: false, error: "这不是有效的演示文稿（.pptx）文件——文件结构不完整或已损坏" };
  }
  if (!replaceText.includes(find) && spansRemaining === 0 && texts.some((t) => t.includes(find))) {
    return { ok: false, error: "这不是有效的演示文稿（.pptx）文件——文件结构不完整或已损坏" };
  }
  return { ok: true, bytes: out, replaced, spansRemaining };
}

// ---------------------------------------------------------------------------
// B — 工具面：replace_docx / replace_pptx（三件套「改」半边第一刀）。path
// （必填，相对工作区）+ find（必填非空）+ replace（必填，可空串=删除）+
// maxCount（可选，缺省 50 硬帽 200）；魔数嗅探：OLE（旧版 .doc/.ppt）给「另
// 存为」出路、非 PK 拒；改写只覆写目标文件本身（零删除面零 mkdir）。
// ---------------------------------------------------------------------------

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0] as const;

/** 跨 run 拒语（两格式共用骨架，pptx 段落定位带张号、docx 只报段序；列表截
 *  前 5 段防拒语爆量，余量点名）。 */
function spansRefusal(tool: string, find: string, paragraphs: readonly SpanningParagraph[], tail: string): string {
  const listed = paragraphs
    .slice(0, 5)
    .map((p) => {
      const at = p.slideIndex === undefined ? `第 ${p.paragraphIndex} 段` : `第 ${p.slideIndex} 张第 ${p.paragraphIndex} 段`;
      return `${at}预览：「${p.preview}」`;
    })
    .join("；");
  const more = paragraphs.length > 5 ? `……等共 ${paragraphs.length} 段` : "";
  return `${tool}: 「${find}」在 ${paragraphs.length} 个段落中被拆分在多个格式段内，无法原位替换（保格式边界）——${listed}${more}。${tail}`;
}

/** 把工作区里现有 Word 文档（.docx）中出现的某段文字就地换成新文字。顶级工
 *  具（tools.ts 固定钉位）；路径必经 resolveWorkspacePath（外逃/绝对路径
 *  typed 拒，fail-closed）；校验先于副作用：拒时零写盘。姿态镜像 make_* /
 *  append_* 写面。 */
export function createReplaceDocxTool(workspaceRoot: string): Tool {
  return buildTool({
    name: "replace_docx",
    description:
      "把工作区里现有 Word 文档（.docx）中出现的某段文字就地换成新文字，文档里其他内容和排版原样保留。适合「把这份文档里的旧公司名换成新的」「把报告里的日期改了」类请求；与读文档的 read_docx 配套——先读确认原文，再把要改的文字就地换掉。" +
      " path 是文档相对工作区的路径。find 是要找的原文字（不能为空），replace 是换成什么（可以给空串表示删除），maxCount 可选：一次最多替换多少处（缺省 50，最大 200，命中更多会拒并告知总数，可缩小范围或分批）。" +
      " 注意：只改文档正文里的文字；如果那段文字在一句话中被拆分在多个格式段内（比如夹了不同颜色或字号的字），无法原位替换，会告知在第几段——可先读文档定位后用 append_docx 重建该段，或整文档重造；页眉页脚、脚注、批注里的文字不在此列；旧版 .doc 格式不支持，需先在 Word 里另存为 .docx。",
    // 写盘（非只读）；只在本地文件系统（closed-world）。覆写目标文件本身
    // → destructive 诚实标注（make_*/append_* 同款 posture 镜像）。
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    isOpenWorld: () => false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要改写的 Word 文档路径（相对工作区，可带子目录），.docx 文件。" },
        find: { type: "string", description: "要找的原文字（非空）——按文档里出现的原样给。" },
        replace: { type: "string", description: "换成什么；空串表示删除这段文字。" },
        maxCount: { type: "number", description: "一次最多替换多少处；缺省 50，最大 200（命中更多会拒并告知总数）。" },
      },
      required: ["path", "find", "replace"],
      additionalProperties: false,
    },
    async execute(args) {
      // 参数 typed 校验（先于任何盘副作用）。
      const rawPath = args["path"];
      if (typeof rawPath !== "string" || rawPath.trim() === "") {
        return { content: 'replace_docx: "path" must be a non-empty path relative to the workspace', isError: true };
      }
      const rel = rawPath.trim();
      const checked = validateDocReplace(args["find"], args["replace"], args["maxCount"]);
      if (!checked.ok) return { content: `replace_docx: ${checked.error}`, isError: true };

      // 工作区边界（外逃/绝对路径/符号链接诡计拒）。
      const resolved = await resolveWorkspacePath(workspaceRoot, rel);
      if (!resolved.ok) return { content: `replace_docx: ${resolved.error}`, isError: true };

      let bytes: Uint8Array;
      try {
        bytes = await readFile(resolved.absPath);
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return { content: `replace_docx: 文件不存在：${rel}`, isError: true };
        }
        return { content: `replace_docx: 读取失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
      }

      // 魔数嗅探先于结构解析：旧版 .doc（OLE 复合文档）与「根本不是 Word」
      // 分开拒——前者有出路（另存为 .docx），说清楚。
      if (bytes.length >= 4 && OLE_MAGIC.every((b, i) => bytes[i] === b)) {
        return {
          content: `replace_docx: ${rel} 是旧版 .doc 格式，改不了——请先用 Word 打开并「另存为」.docx 格式后再试`,
          isError: true,
        };
      }
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
        return {
          content: `replace_docx: ${rel} 不是 Word（.docx）文档——如果它是旧版 .doc 或其他格式，请先在 Word 里另存为 .docx 再试`,
          isError: true,
        };
      }

      const replaced = replaceDocxText(bytes, checked.find, checked.replace, checked.maxCount);
      if (!replaced.ok) {
        if (replaced.reason === "spans_runs") {
          return { content: spansRefusal("replace_docx", checked.find, replaced.paragraphs, "可 read 定位该段后用 append 侧重建，或整文档重造"), isError: true };
        }
        if (replaced.reason === "over_limit") {
          return {
            content: `replace_docx: 命中 ${replaced.total} 处超过上限 ${replaced.limit}——请缩小 find 或分批（增大 maxCount 至 ${REPLACE_HARD_MAX_COUNT} 内）`,
            isError: true,
          };
        }
        if (replaced.reason === "not_found") {
          return { content: `replace_docx: 没有找到「${checked.find}」——这份文档里没有出现这段文字（可先 read_docx 核对原文）`, isError: true };
        }
        return { content: `replace_docx: ${replaced.error}`, isError: true };
      }

      // 改写=覆写目标文件本身（零删除面零 mkdir；目录已存在——刚读过这文件）。
      try {
        await writeFile(resolved.absPath, replaced.bytes);
      } catch (err) {
        return { content: `replace_docx: 写入失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
      }
      const kb = (replaced.bytes.byteLength / 1024).toFixed(1);
      const warn =
        replaced.spansRemaining > 0
          ? `（另有 ${replaced.spansRemaining} 处被拆分在多个格式段内，未替换——可 read 定位该段后用 append 侧重建，或整文档重造）`
          : "";
      return {
        // 收据=用户语：一句中文（路径/替换数/找换对）+ 结构化字段一行（文件卡
        // 从这行提取）。
        content:
          `已在 ${rel} 就地替换 ${replaced.replaced} 处「${checked.find}」→「${checked.replace}」${warn}（${kb} KB）\n` +
          JSON.stringify({
            path: resolved.absPath,
            relativePath: rel,
            replaced: replaced.replaced,
            bytes: replaced.bytes.byteLength,
          }),
      };
    },
  });
}

/** 把工作区里现有演示文稿（.pptx）每一页上的某段文字就地换成新文字。顶级工
 *  具（tools.ts 固定钉位）；门序/姿态与 replace_docx 逐字同（221/223/228 谱
 *  系）。 */
export function createReplacePptxTool(workspaceRoot: string): Tool {
  return buildTool({
    name: "replace_pptx",
    description:
      "把工作区里现有演示文稿（.pptx）里每一页上的某段文字就地换成新文字，页面里其他内容和排版原样保留。适合「把这个 PPT 里的旧公司名换成新的」「把这页 PPT 的日期改了」类请求；与读演示文稿的 read_pptx 配套——先读确认每一页写了什么，再把要改的文字就地换掉。" +
      " path 是演示文稿相对工作区的路径。find 是要找的原文字（不能为空），replace 是换成什么（可以给空串表示删除），maxCount 可选：一次最多替换多少处（缺省 50，最大 200，命中更多会拒并告知总数，可缩小范围或分批——上限按全部页面合计算）。" +
      " 注意：只改幻灯片页面上的文字；如果那段文字在一句话中被拆分在多个格式段内（比如夹了不同颜色或字号的字），无法原位替换，会告知在第几页第几段——可先读演示文稿定位后用 append_pptx 补一页替代，或整份重造；版式、母版、演讲者备注里的文字不在此列；旧版 .ppt 格式不支持，需先在 PowerPoint 里另存为 .pptx。",
    // 写盘（非只读）；只在本地文件系统（closed-world）。覆写目标文件本身
    // → destructive 诚实标注（make_*/append_* 同款 posture 镜像）。
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    isOpenWorld: () => false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要改写的演示文稿路径（相对工作区，可带子目录），.pptx 文件。" },
        find: { type: "string", description: "要找的原文字（非空）——按页面里出现的原样给。" },
        replace: { type: "string", description: "换成什么；空串表示删除这段文字。" },
        maxCount: { type: "number", description: "一次最多替换多少处（全部页面合计）；缺省 50，最大 200（命中更多会拒并告知总数）。" },
      },
      required: ["path", "find", "replace"],
      additionalProperties: false,
    },
    async execute(args) {
      // 参数 typed 校验（先于任何盘副作用）。
      const rawPath = args["path"];
      if (typeof rawPath !== "string" || rawPath.trim() === "") {
        return { content: 'replace_pptx: "path" must be a non-empty path relative to the workspace', isError: true };
      }
      const rel = rawPath.trim();
      const checked = validateDocReplace(args["find"], args["replace"], args["maxCount"]);
      if (!checked.ok) return { content: `replace_pptx: ${checked.error}`, isError: true };

      // 工作区边界（外逃/绝对路径/符号链接诡计拒）。
      const resolved = await resolveWorkspacePath(workspaceRoot, rel);
      if (!resolved.ok) return { content: `replace_pptx: ${resolved.error}`, isError: true };

      let bytes: Uint8Array;
      try {
        bytes = await readFile(resolved.absPath);
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return { content: `replace_pptx: 文件不存在：${rel}`, isError: true };
        }
        return { content: `replace_pptx: 读取失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
      }

      // 魔数嗅探先于结构解析：旧版 .ppt（OLE 复合文档）与「根本不是演示文
      // 稿」分开拒——前者有出路（另存为 .pptx），说清楚。
      if (bytes.length >= 4 && OLE_MAGIC.every((b, i) => bytes[i] === b)) {
        return {
          content: `replace_pptx: ${rel} 是旧版 .ppt 格式，改不了——请先用 PowerPoint 打开并「另存为」.pptx 格式后再试`,
          isError: true,
        };
      }
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
        return {
          content: `replace_pptx: ${rel} 不是演示文稿（.pptx）文件——如果它是旧版 .ppt 或其他格式，请先在 PowerPoint 里另存为 .pptx 再试`,
          isError: true,
        };
      }

      const replaced = replacePptxText(bytes, checked.find, checked.replace, checked.maxCount);
      if (!replaced.ok) {
        if (replaced.reason === "spans_runs") {
          return { content: spansRefusal("replace_pptx", checked.find, replaced.paragraphs, "可 read 定位该段后用 append 侧重建，或整份重造"), isError: true };
        }
        if (replaced.reason === "over_limit") {
          return {
            content: `replace_pptx: 命中 ${replaced.total} 处超过上限 ${replaced.limit}——请缩小 find 或分批（增大 maxCount 至 ${REPLACE_HARD_MAX_COUNT} 内）`,
            isError: true,
          };
        }
        if (replaced.reason === "not_found") {
          return { content: `replace_pptx: 没有找到「${checked.find}」——这份演示文稿里没有出现这段文字（可先 read_pptx 核对原文）`, isError: true };
        }
        return { content: `replace_pptx: ${replaced.error}`, isError: true };
      }

      // 改写=覆写目标文件本身（零删除面零 mkdir；目录已存在——刚读过这文件）。
      try {
        await writeFile(resolved.absPath, replaced.bytes);
      } catch (err) {
        return { content: `replace_pptx: 写入失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
      }
      const kb = (replaced.bytes.byteLength / 1024).toFixed(1);
      const warn =
        replaced.spansRemaining > 0
          ? `（另有 ${replaced.spansRemaining} 处被拆分在多个格式段内，未替换——可 read 定位该段后用 append 侧重建，或整份重造）`
          : "";
      return {
        content:
          `已在 ${rel} 就地替换 ${replaced.replaced} 处「${checked.find}」→「${checked.replace}」${warn}（${kb} KB）\n` +
          JSON.stringify({
            path: resolved.absPath,
            relativePath: rel,
            replaced: replaced.replaced,
            bytes: replaced.bytes.byteLength,
          }),
      };
    },
  });
}

/** log.ts summarize 的对象摘要件（导出给测试直钉）：文件尾名 + 找换对，形
 *  「订单.docx 替换「旧」→「新」」（220 裁定语法：summary=动作对象；summarize
 *  只见输入，N 在结果不可达不编造）。纯。 */
export function summarizeReplaceDocx(input: Record<string, unknown>): string {
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

/** pptx 同形摘要件（220 语法同缝；与 docx 各自导出——log.ts 两 case 各引各
 *  的，228 双子先例）。纯。 */
export function summarizeReplacePptx(input: Record<string, unknown>): string {
  return summarizeReplaceDocx(input);
}
