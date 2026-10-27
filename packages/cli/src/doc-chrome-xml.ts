// doc-chrome shared OOXML primitives — module-level segment extracted from
// doc-chrome.ts (ω99 file-size discipline arc A): the chrome validation
// family, the XML/zip helpers (escape/attr/sectPr pairing), the set/clear
// chrome core (四缝布线 + 四处全清 + 互证), and the two scanners shared by
// the first-page/even-pages sibling layers (chromeParamText, findEvenOddTags).
// All pure: no clock, no disk.
import { smartZip, unzipEntriesWithMeta } from "./doc-zip.js";

// ---------------------------------------------------------------------------
// A — 校验纯层。
// ---------------------------------------------------------------------------

/** text 长度帽（码点计）：防部件炸弹，非内容审查（护栏不是拒绝功能的门）。 */
export const DOCX_CHROME_TEXT_MAX = 4000;

/** which 的二值域。 */
export type DocxChromeWhich = "header" | "footer";

/** 控制字符政策逐字同 make/replace 面（\t \n \r 放行）。 */
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

export type ValidateChromeCheck =
  | { readonly ok: true; readonly which: DocxChromeWhich; readonly text: string }
  | { readonly ok: false; readonly error: string };

/** typed 校验（先于任何盘副作用）：which ∈ {header, footer}；text 非空非纯
 *  白白串、无控制字符、帽 4,000 码点。纯函数，永不抛。 */
export function validateDocxChrome(rawWhich: unknown, rawText: unknown): ValidateChromeCheck {
  if (rawWhich !== "header" && rawWhich !== "footer") {
    return { ok: false, error: `"which" must be "header" or "footer" (got ${JSON.stringify(rawWhich) ?? "undefined"})` };
  }
  if (typeof rawText !== "string" || rawText.trim() === "") {
    return { ok: false, error: '"text" must be a non-empty string' };
  }
  if (CONTROL_CHARS.test(rawText)) {
    return { ok: false, error: '"text" contains a control character that cannot go into a document — remove it (tabs and line breaks are fine)' };
  }
  const length = Array.from(rawText).length;
  if (length > DOCX_CHROME_TEXT_MAX) {
    return { ok: false, error: `"text" is limited to ${DOCX_CHROME_TEXT_MAX} characters, got ${length}` };
  }
  return { ok: true, which: rawWhich, text: rawText };
}

// ---------------------------------------------------------------------------
// B — 页眉页脚纯层（unzip → 四缝 → smartZip 回装 → 互证）。
// ---------------------------------------------------------------------------

export const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
export const RELS_OPEN = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
export const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
/** header/footer 部件与引用的 OOXML 词根（w:hdr / w:ftr、headerReference /
 *  footerReference——which 单词直插，两形共享同一构造器）。 */
export const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const HEADER_REL_TYPE = `${NS_R}/header`;
const FOOTER_REL_TYPE = `${NS_R}/footer`;
const HEADER_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml";
const FOOTER_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml";

/** 五实体转义（&amp; &lt; &gt; &quot; &apos;）——doc-replace.ts 同款件逐字
 *  复制（追加面未导出；复制 ~5 行，注释钉同源）。 */
function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&apos;");
}

/** XML 实体解码（互证读回用）——读面 doc-docx-read.ts 同款纪律的本地件。 */
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
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    return named[body] ?? whole;
  });
}

/** 从一个起始标签文本里取属性值（属性序无关；单双引号都认）——229 同款本地件。 */
export function attrValue(tag: string, name: string): string | undefined {
  const m =
    new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(tag) ??
    new RegExp(`${name}\\s*=\\s*'([^']*)'`).exec(tag);
  return m?.[1];
}

/** unzip 的 xlsx 口径错误 → docx 词汇（加密类教 Word 出路；超大/压缩法类本就
 *  通用原样过）——222/223/229 同款映射，本地件。 */
export function docxChromeZipError(error: string): string {
  if (error.includes("密码")) {
    return "这个文件有密码保护，读取不了——请在 Word 里打开并另存为无密码的 .docx 副本后再试";
  }
  if (error.includes("超大") || error.includes("压缩方式")) return error;
  return "这不是有效的 Word（.docx）文件——文件结构不完整或已损坏";
}

export const STRUCTURE_ERROR = "这不是有效的 Word（.docx）文件——文件结构不完整或已损坏";

/** 页眉/页脚部件内容：单段 + 每行一个 <w:t>、行间 <w:br/>（\r 归一到 \n）；
 *  9pt 小字（页眉页脚的朴素版式，v1 钉死）。纯。 */
function chromeXml(which: DocxChromeWhich, text: string): string {
  const root = which === "header" ? "w:hdr" : "w:ftr";
  const body = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `<w:t xml:space="preserve">${escapeXml(line)}</w:t>`)
    .join("<w:br/>");
  return (
    `${XML_DECL}<${root} xmlns:w="${WORD_NS}" xmlns:r="${NS_R}">` +
    `<w:p><w:r><w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>${body}</w:r></w:p>` +
    `</${root}>`
  );
}

/** 扫既有同类部件号取 max（碰撞纪律：部件名可有空洞，不数数量——223 同款）。 */
function maxPartNumber(names: readonly string[], pattern: RegExp): number {
  let max = 0;
  for (const name of names) {
    const m = pattern.exec(name);
    if (m !== null) max = Math.max(max, Number.parseInt(m[1]!, 10));
  }
  return max;
}

/** body 级 sectPr 的精确区间：`<w:sectPr` 的词边界 token 化 + **括号配对**。
 *  两个朴素 lastIndexOf 陷阱（223 只做块插入、插点在锚前所以免疫；本面引
 *  用必须插进 sectPr 内部，陷阱直达）：
 *  ① `<w:sectPrChange>`（修订标记，schema 上是 sectPr 的末子）前缀同名——
 *    朴素锚会落进它内部；
 *  ② sectPrChange **内含**一个旧版 `<w:sectPr>`——即使词边界过滤，最后
 *    一个匹配也是这个修订前旧节，不是当前节。
 *  解法：token 化（\b 边界滤掉 sectPrChange）后从尾反向配对——depth 归零
 *  的 open 才是 body 级（=文档序最后一个不带亲代的 sectPr：正文节中断都是
 *  pPr 里的兄弟，body 级必在其后）；再正向配对取其闭。自闭合形
 *  （<w:sectPr/>，schema 上 pgSz 必子、本就无效）不参与配对（=拒）。
 *  返回 {start, innerStart, innerEnd}：开标签起 / 内文起 / 内文终（闭标签
 *  前）。找不到/残缺 → undefined。纯。 */
export interface SectPrRange {
  readonly start: number;
  readonly innerStart: number;
  readonly innerEnd: number;
}

export function bodySectPrRange(xml: string): SectPrRange | undefined {
  const tokens: { kind: "open" | "close"; selfClose: boolean; at: number; end: number }[] = [];
  for (const m of xml.matchAll(/<w:sectPr\b[^>]*>|<\/w:sectPr>/g)) {
    const raw = m[0];
    if (raw.startsWith("</")) tokens.push({ kind: "close", selfClose: false, at: m.index!, end: m.index! + raw.length });
    else tokens.push({ kind: "open", selfClose: raw.endsWith("/>"), at: m.index!, end: m.index! + raw.length });
  }
  // 反向配对：从尾起 depth 归零的 open = body 级。
  let depth = 0;
  let openIdx = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]!;
    if (t.kind === "close") depth += 1;
    else if (!t.selfClose) {
      depth -= 1;
      if (depth === 0) {
        openIdx = i;
        break;
      }
    }
  }
  if (openIdx === -1) return undefined;
  const open = tokens[openIdx]!;
  // 正向配对：其配对闭（跨过 sectPrChange 内嵌套）。
  let d = 1;
  for (let i = openIdx + 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === "close") {
      d -= 1;
      if (d === 0) return { start: open.at, innerStart: open.end, innerEnd: t.at };
    } else if (!t.selfClose) d += 1;
  }
  return undefined; // 无配对闭：结构残缺
}

/** 扫 rels 既有 rIdN 取 max（rels 还挂着样式等关系，不能假设连续——223 同款）。 */
export function maxRId(relsXml: string): number {
  let max = 0;
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attrValue(m[0], "Id");
    const n = id === undefined ? null : /^rId(\d+)$/.exec(id);
    if (n !== null) max = Math.max(max, Number.parseInt(n[1]!, 10));
  }
  return max;
}

export type SetDocxChromeCheck =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly partName: string; readonly created: boolean }
  | { readonly ok: false; readonly error: string };

/** 互证（223/229 范式）：回装字节重新解包，走真链——末节 sectPr 的指定
 *  refType（default|first）whichReference r:id → document rels 解析 → 部件
 *  在场 → 文本读回等值（<w:t> 依序拼接、<w:br/> 折 \n——与 chromeXml 同
 *  构）。任一环断 → 结构拒（「已设置」从读回来）。纯。 */
export function verifyChrome(bytes: Uint8Array, which: DocxChromeWhich, refType: DocxChromeRefType, text: string): string | undefined {
  const unzipped = unzipEntriesWithMeta(bytes);
  if (!unzipped.ok) return STRUCTURE_ERROR;
  const byName = new Map(unzipped.entries.map((e) => [e.name, e] as const));
  const document = byName.get("word/document.xml");
  const relsPart = byName.get("word/_rels/document.xml.rels");
  if (document === undefined || relsPart === undefined) return STRUCTURE_ERROR;
  const xml = new TextDecoder().decode(document.data);
  const range = bodySectPrRange(xml);
  if (range === undefined) return STRUCTURE_ERROR;
  const sect = xml.slice(range.innerStart, range.innerEnd);
  let rid: string | undefined;
  for (const m of sect.matchAll(new RegExp(`<w:${which}Reference\\b[^>]*>`, "g"))) {
    if (attrValue(m[0], "w:type") === refType) rid = attrValue(m[0], "r:id");
  }
  if (rid === undefined) return STRUCTURE_ERROR;
  const rels = new TextDecoder().decode(relsPart.data);
  let target: string | undefined;
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    if (attrValue(m[0], "Id") === rid) target = attrValue(m[0], "Target");
  }
  if (target === undefined) return STRUCTURE_ERROR;
  const partName = target.startsWith("/") ? target.slice(1) : `word/${target.replace(/^\.\//, "")}`;
  const part = byName.get(partName);
  if (part === undefined) return STRUCTURE_ERROR;
  const chrome = new TextDecoder().decode(part.data);
  if (!chrome.includes(which === "header" ? "<w:hdr" : "<w:ftr")) return STRUCTURE_ERROR;
  let readBack = "";
  for (const m of chrome.matchAll(/(<w:br\b[^>]*\/>)|<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)) {
    if (m[1] !== undefined) readBack += "\n";
    else readBack += unescapeXml(m[2] ?? "");
  }
  if (readBack !== text) return STRUCTURE_ERROR;
  return undefined;
}

/** 解包→末节 sectPr 定位→幂等覆写或四缝新建（sectPr 引用 + rels +
 *  content-type + 新部件）→smartZip 回装→互证。入口自校验（typed 拒在纯层
 *  边界，纵深防御——工具面校验之外的第二道）。纯函数：不碰时钟、不碰盘。
 *  238 公共面=每页同款 default；256 起引用类型参数化（setDocxFirstPage 的
 *  first 变体走同一机械——部件创建/覆写/布线零分叉）。 */
export function setDocxChrome(bytes: Uint8Array, which: DocxChromeWhich, text: string): SetDocxChromeCheck {
  const checked = validateDocxChrome(which, text);
  if (!checked.ok) return { ok: false, error: checked.error };
  return setDocxChromeRef(bytes, checked.which, "default", checked.text);
}

/** set 机械的本体（refType 参数化；调用方保证 which/text 已过验——公共面
 *  在 wrapper 验，first 变体在 validateDocxFirstPage 验）。 */
export function setDocxChromeRef(bytes: Uint8Array, which: DocxChromeWhich, refType: DocxChromeRefType, text: string): SetDocxChromeCheck {
  const unzipped = unzipEntriesWithMeta(bytes);
  if (!unzipped.ok) return { ok: false, error: docxChromeZipError(unzipped.error) };
  const entries = unzipped.entries;
  const document = entries.find((e) => e.name === "word/document.xml");
  if (document === undefined) {
    return { ok: false, error: "这不是有效的 Word（.docx）文件——缺少文档内容" };
  }
  const xml = new TextDecoder().decode(document.data);
  // body 级 sectPr 配对区间（sectPrChange 前缀/内嵌双陷阱免疫；自闭合形=
  // 无配对 → 诚实拒——schema 上 pgSz 必子，本就无效）。
  const range = bodySectPrRange(xml);
  if (range === undefined) {
    return { ok: false, error: STRUCTURE_ERROR };
  }
  const sectInner = xml.slice(range.innerStart, range.innerEnd);

  const enc = new TextEncoder();
  const relType = which === "header" ? HEADER_REL_TYPE : FOOTER_REL_TYPE;
  const contentType = which === "header" ? HEADER_CONTENT_TYPE : FOOTER_CONTENT_TYPE;

  // ——覆写路径：末节已有该 which 该 refType 的引用 → 原位换部件内容，布线零动。 ——
  let existingRid: string | undefined;
  for (const m of sectInner.matchAll(new RegExp(`<w:${which}Reference\\b[^>]*>`, "g"))) {
    if (attrValue(m[0], "w:type") === refType) existingRid = attrValue(m[0], "r:id");
  }
  if (existingRid !== undefined) {
    const relsEntry = entries.find((e) => e.name === "word/_rels/document.xml.rels");
    if (relsEntry === undefined) return { ok: false, error: STRUCTURE_ERROR };
    const rels = new TextDecoder().decode(relsEntry.data);
    let target: string | undefined;
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      if (attrValue(m[0], "Id") === existingRid) target = attrValue(m[0], "Target");
    }
    if (target === undefined) return { ok: false, error: STRUCTURE_ERROR };
    const partName = target.startsWith("/") ? target.slice(1) : `word/${target.replace(/^\.\//, "")}`;
    const partEntry = entries.find((e) => e.name === partName);
    if (partEntry === undefined) return { ok: false, error: STRUCTURE_ERROR };
    const out = smartZip(
      entries.map((e) =>
        e === partEntry ? { name: e.name, data: enc.encode(chromeXml(which, text)), meta: e } : { name: e.name, data: e.data, meta: e },
      ),
    );
    const failure = verifyChrome(out, which, refType, text);
    if (failure !== undefined) return { ok: false, error: failure };
    return { ok: true, bytes: out, partName, created: false };
  }

  // ——新建路径：部件号/rId 扫 max+1 → sectPr 首子位插引用（schema 序：
  // headerReference/footerReference 是 sectPr 首元素组，pgSz 前）→ rels 尾扩
  // （rels 部件缺席则新建——make_docx 裸包零 word/_rels/document.xml.rels）→
  // content-type 尾扩 → 新部件尾续。——
  const nextPart = maxPartNumber(entries.map((e) => e.name), new RegExp(`^word/${which}(\\d+)\\.xml$`)) + 1;
  const partName = `word/${which}${nextPart}.xml`;
  const relsEntry = entries.find((e) => e.name === "word/_rels/document.xml.rels");
  const relsXml = relsEntry === undefined ? undefined : new TextDecoder().decode(relsEntry.data);
  if (relsXml !== undefined && !relsXml.includes("</Relationships>")) {
    return { ok: false, error: STRUCTURE_ERROR };
  }
  const nextRid = maxRId(relsXml ?? "") + 1;
  const relAdd = `<Relationship Id="rId${nextRid}" Type="${relType}" Target="${which}${nextPart}.xml"/>`;
  const newRels =
    relsXml === undefined ? `${XML_DECL}${RELS_OPEN}${relAdd}</Relationships>` : relsXml.replace("</Relationships>", `${relAdd}</Relationships>`);
  const reference = `<w:${which}Reference w:type="${refType}" r:id="rId${nextRid}"/>`;
  // 插点=body 级 sectPr 内文首（schema 序：headerReference/footerReference
  // 是 sectPr 首元素组，pgSz 前；sectPrChange 是末子，插首不碰它）。
  const newDocument = xml.slice(0, range.innerStart) + reference + xml.slice(range.innerStart);
  const ctEntry = entries.find((e) => e.name === "[Content_Types].xml");
  if (ctEntry === undefined) return { ok: false, error: STRUCTURE_ERROR };
  const ctXml = new TextDecoder().decode(ctEntry.data);
  if (!ctXml.includes("</Types>")) return { ok: false, error: STRUCTURE_ERROR };
  const ctAdd = `<Override PartName="/${partName}" ContentType="${contentType}"/>`;
  const newCt = ctXml.replace("</Types>", `${ctAdd}</Types>`);

  // 既有条目原位替换（document/rels/content-type 三个缝补件），新部件尾续；
  // rels 部件缺席（make_docx 裸包零 word/_rels/document.xml.rels）则新建尾续。
  // 每条目统一挂 meta（原条目），已改/未改交给 smartZip 自行比对裁定；新
  // 部件无 meta（→ 缺省 stored）。
  const out = smartZip([
    ...entries.map((e) => {
      if (e === document) return { name: e.name, data: enc.encode(newDocument), meta: e };
      if (relsEntry !== undefined && e === relsEntry) return { name: e.name, data: enc.encode(newRels), meta: e };
      if (e === ctEntry) return { name: e.name, data: enc.encode(newCt), meta: e };
      return { name: e.name, data: e.data, meta: e };
    }),
    ...(relsEntry === undefined ? [{ name: "word/_rels/document.xml.rels", data: enc.encode(newRels) }] : []),
    { name: partName, data: enc.encode(chromeXml(which, text)) },
  ]);
  const failure = verifyChrome(out, which, refType, text);
  if (failure !== undefined) return { ok: false, error: failure };
  return { ok: true, bytes: out, partName, created: true };
}

// ---------------------------------------------------------------------------
// B2 — ω99-256 删除与首页不同纯层（clear = 三处全清；firstPage = titlePg
// 旗标 + first 引用的成对管理）。全部纯函数：不碰时钟、不碰盘；删除的是
// **内存 zip 条目**（OOXML 部件），不是文件系统的任何文件。
// ---------------------------------------------------------------------------

/** header/footer 引用的类型域（238 只用 default；256 加 first；263 加 even
 *  ——「首页/奇偶」两轴三档，ECMA 对称完备）。 */
export type DocxChromeRefType = "default" | "first" | "even";

/** 在 body 级 sectPr 内文里找该 which+refType 的全部引用标签（含 xml 绝对
 *  位；一节同型多引用的畸形容一并收——全删才叫清）。纯。 */
export function findRefTags(
  xml: string,
  range: SectPrRange,
  which: DocxChromeWhich,
  refType: DocxChromeRefType,
): { readonly tag: string; readonly at: number }[] {
  const inner = xml.slice(range.innerStart, range.innerEnd);
  const out: { tag: string; at: number }[] = [];
  for (const m of inner.matchAll(new RegExp(`<w:${which}Reference\\b[^>]*>`, "g"))) {
    if (attrValue(m[0], "w:type") === refType) out.push({ tag: m[0], at: range.innerStart + m.index! });
  }
  return out;
}

/** 在 body 级 sectPr 内文里找 <w:titlePg/>（自闭合与配对两形都收）。纯。 */
export function findTitlePgTags(xml: string, range: SectPrRange): { readonly tag: string; readonly at: number }[] {
  const inner = xml.slice(range.innerStart, range.innerEnd);
  const out: { tag: string; at: number }[] = [];
  for (const m of inner.matchAll(/<w:titlePg\b[^>]*?(?:\/>|><\/w:titlePg>)/g)) {
    out.push({ tag: m[0], at: range.innerStart + m.index! });
  }
  return out;
}

/** 从 xml 里按绝对区间删标签（倒序 splice，一次成型）。纯。 */
export function removeSpans(xml: string, spans: readonly { readonly at: number; readonly tag: string }[]): string {
  let out = xml;
  for (const s of [...spans].sort((a, b) => b.at - a.at)) {
    out = out.slice(0, s.at) + out.slice(s.at + s.tag.length);
  }
  return out;
}

/** rels 里该 Id 的 Relationship 条目删除（自闭合与配对两形；倒序）。纯。 */
export function removeRelsEntry(relsXml: string, rid: string): string {
  const spans: { at: number; tag: string }[] = [];
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    if (attrValue(m[0], "Id") !== rid) continue;
    let end = m.index! + m[0].length;
    if (!m[0].endsWith("/>")) {
      const close = relsXml.indexOf("</Relationship>", end);
      if (close !== -1) end = close + "</Relationship>".length;
    }
    spans.push({ at: m.index!, tag: relsXml.slice(m.index!, end) });
  }
  return removeSpans(relsXml, spans);
}

/** Content_Types 里该部件的 Override 条目删除。纯。 */
export function removeCtOverride(ctXml: string, partName: string): string {
  const spans: { at: number; tag: string }[] = [];
  for (const m of ctXml.matchAll(/<Override\b[^>]*>/g)) {
    if (attrValue(m[0], "PartName") === `/${partName}`) spans.push({ at: m.index!, tag: m[0] });
  }
  return removeSpans(ctXml, spans);
}

/** rid 是否仍被剩余 document.xml 引用（单双引号都认）——共享部件（first/
 *  even 同引一个 headerN.xml）的保留判据。纯。 */
export function ridStillUsed(xml: string, rid: string): boolean {
  return new RegExp(`r:id\\s*=\\s*["']${rid}["']`).test(xml);
}

/** rels Target → zip 部件名（"/word/header1.xml" 全路径与 "header1.xml" 相对
 *  两形；与 setDocxChromeRef/verifyChrome 的既有归一逐字同款）。纯。 */
export function partNameOf(target: string): string {
  return target.startsWith("/") ? target.slice(1) : `word/${target.replace(/^\.\//, "")}`;
}

/** 删除后的互证（223/238 范式——「已删除」从读回来）：引用组删尽 + 被删部
 *  件在 zip 缺席 + rels 无指向它的条目 + Content_Types 无它的 Override。
 *  任一环在 → 结构拒。纯。 */
export function verifyRemovals(
  bytes: Uint8Array,
  opts: {
    readonly refs?: readonly { readonly at: number; readonly tag: string }[];
    readonly titlePg?: boolean;
    readonly evenOddFlag?: boolean;
    readonly removedParts: ReadonlySet<string>;
  },
): string | undefined {
  const unzipped = unzipEntriesWithMeta(bytes);
  if (!unzipped.ok) return STRUCTURE_ERROR;
  const byName = new Map(unzipped.entries.map((e) => [e.name, e] as const));
  const document = byName.get("word/document.xml");
  if (document === undefined) return STRUCTURE_ERROR;
  const xml = new TextDecoder().decode(document.data);
  const range = bodySectPrRange(xml);
  if (range === undefined) return STRUCTURE_ERROR;
  if (opts.refs !== undefined && opts.refs.length > 0) {
    // 引用组可含 header/footer 混合标签（259 起 false 路径双面清）——逐标
    // 签取 which/refType 各自核删尽（单组调用=同今日行为；263 起 even 档
    // 流过同一推导）。
    for (const ref of opts.refs) {
      const which = /header/.test(ref.tag) ? "header" : "footer";
      const raw = attrValue(ref.tag, "w:type");
      const refType: DocxChromeRefType = raw === "first" || raw === "even" ? raw : "default";
      if (findRefTags(xml, range, which, refType).length !== 0) return STRUCTURE_ERROR;
    }
  }
  if (opts.titlePg === true && findTitlePgTags(xml, range).length !== 0) return STRUCTURE_ERROR;
  if (opts.evenOddFlag === true) {
    // 旗标删尽的互证（263）：settings.xml 部件**允许在场**（部件永不删），
    // 但 evenAndOddHeaders 标签必须一个不剩（「已关」从读回来）。
    const settings = byName.get("word/settings.xml");
    if (settings !== undefined && findEvenOddTags(new TextDecoder().decode(settings.data)).length !== 0) {
      return STRUCTURE_ERROR;
    }
  }
  for (const name of opts.removedParts) if (byName.has(name)) return STRUCTURE_ERROR;
  // ω99-267: #1 —— 下面 rels/CT 两段只服务于「被删部件的残留核对」：零删除部
  // 件时两段本就空转，却无条件要求两部件在场——裸 make_docx（无 word/_rels/
  //  document.xml.rels）的纯开关路径（titlePg 立后拆、first 引用空）被误拒成
  //  STRUCTURE_ERROR（256 潜伏缺陷，263 报告 §四-6 记档）。零删除提前放行；
  //  有删除时下方两段逐字节照旧（fail-closed 不减——R2 三拒直证）。
  if (opts.removedParts.size === 0) return undefined;
  const relsPart = byName.get("word/_rels/document.xml.rels");
  if (relsPart === undefined) return STRUCTURE_ERROR;
  const rels = new TextDecoder().decode(relsPart.data);
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const target = attrValue(m[0], "Target");
    if (target !== undefined && opts.removedParts.has(partNameOf(target))) return STRUCTURE_ERROR;
  }
  const ct = byName.get("[Content_Types].xml");
  if (ct === undefined) return STRUCTURE_ERROR;
  const ctXml = new TextDecoder().decode(ct.data);
  for (const name of opts.removedParts) {
    if (ctXml.includes(`PartName="/${name}"`)) return STRUCTURE_ERROR;
  }
  return undefined;
}

export type ClearDocxChromeCheck =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly removedParts: readonly string[] }
  | { readonly ok: false; readonly reason: "not_found"; readonly error?: undefined }
  | { readonly ok: false; readonly reason?: undefined; readonly error: string };

/** 删除页眉/页脚（面一，238「删除记池」收口；259 起 refType 参数化）：末节
 *  sectPr 的该 which 引用（refType 缺省 "default"=今日行为字节零演进；
 *  "first"=首页专属档——titlePg 旗标不动，开关域归 setDocxFirstPage；
 *  "even"=偶数页专属档——**evenAndOddHeaders 文档级旗标同样不动**（263 职
 *  责分离：引用面归 clear、文档级开关归 setDocxEvenPages））+ 它指向的
 *  headerN.xml/footerN.xml 部件 + rels 条目 + Content_Types Override 四处
 *  全清——**部件级删除**（残留部件=文件里还躺着可被恢复的旧页眉+体积不
 *  减，「去掉」没完成）。另一档引用不动（default 清不动 first/even，反之
 *  亦然；共享部件的 rid 仍被剩余文档引用 → 部件保留，如实——不静默拆别
 *  人的台）。无该档引用 → typed not_found（229 四出口形）。入口自校验 +
 *  回装互证。纯函数：不碰时钟、不碰盘。 */
export function clearDocxChrome(bytes: Uint8Array, which: DocxChromeWhich, refType: DocxChromeRefType = "default"): ClearDocxChromeCheck {
  if (which !== "header" && which !== "footer") {
    return { ok: false, error: `"which" must be "header" or "footer" (got ${JSON.stringify(which) ?? "undefined"})` };
  }
  if (refType !== "default" && refType !== "first" && refType !== "even") {
    return { ok: false, error: `"refType" must be "default", "first" or "even" (got ${JSON.stringify(refType) ?? "undefined"})` };
  }
  const unzipped = unzipEntriesWithMeta(bytes);
  if (!unzipped.ok) return { ok: false, error: docxChromeZipError(unzipped.error) };
  const entries = unzipped.entries;
  const document = entries.find((e) => e.name === "word/document.xml");
  if (document === undefined) return { ok: false, error: "这不是有效的 Word（.docx）文件——缺少文档内容" };
  const xml = new TextDecoder().decode(document.data);
  const range = bodySectPrRange(xml);
  if (range === undefined) return { ok: false, error: STRUCTURE_ERROR };
  const refs = findRefTags(xml, range, which, refType);
  if (refs.length === 0) return { ok: false, reason: "not_found" };
  const relsEntry = entries.find((e) => e.name === "word/_rels/document.xml.rels");
  if (relsEntry === undefined) return { ok: false, error: STRUCTURE_ERROR };
  const relsXml = new TextDecoder().decode(relsEntry.data);
  const ctEntry = entries.find((e) => e.name === "[Content_Types].xml");
  if (ctEntry === undefined) return { ok: false, error: STRUCTURE_ERROR };
  const ctXml = new TextDecoder().decode(ctEntry.data);

  const enc = new TextEncoder();
  // ① 引用删（该 refType 档全删；另一档与 even 不动）。
  const newXml = removeSpans(xml, refs);
  // ②③④ 部件/rels/CT 三清：每个 rid 解析目标；仍被剩余文档引用（共享部件）
  //  → 保留；否则三处全清。
  const removedParts: string[] = [];
  const removedPartSet = new Set<string>();
  const droppedParts = new Set<(typeof entries)[number]>();
  let newRels = relsXml;
  let newCt = ctXml;
  for (const rid of [...new Set(refs.map((r) => attrValue(r.tag, "r:id")))]) {
    if (rid === undefined) return { ok: false, error: STRUCTURE_ERROR };
    let target: string | undefined;
    for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
      if (attrValue(m[0], "Id") === rid) target = attrValue(m[0], "Target");
    }
    if (target === undefined) return { ok: false, error: STRUCTURE_ERROR };
    const partName = partNameOf(target);
    if (ridStillUsed(newXml, rid)) continue; // 另一档/even 同引的共享部件——保留。
    newRels = removeRelsEntry(newRels, rid);
    const partEntry = entries.find((e) => e.name === partName);
    if (partEntry !== undefined) droppedParts.add(partEntry);
    newCt = removeCtOverride(newCt, partName);
    removedParts.push(partName);
    removedPartSet.add(partName);
  }
  const out = smartZip(
    entries.flatMap((e) => {
      if (droppedParts.has(e)) return [];
      if (e === document) return [{ name: e.name, data: enc.encode(newXml), meta: e }];
      if (e === relsEntry) return [{ name: e.name, data: enc.encode(newRels), meta: e }];
      if (e === ctEntry) return [{ name: e.name, data: enc.encode(newCt), meta: e }];
      return [{ name: e.name, data: e.data, meta: e }];
    }),
  );
  const failure = verifyRemovals(out, { refs, removedParts: removedPartSet });
  if (failure !== undefined) return { ok: false, error: failure };
  return { ok: true, bytes: out, removedParts };
}

/** 文本参数的共用校验（headerText/footerText 同一族文案，参数名插值——238
 *  的 text 校验族同款）。纯。 */
export function chromeParamText(raw: unknown, name: string): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string } {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, error: `"${name}" must be a non-empty string` };
  }
  if (CONTROL_CHARS.test(raw)) {
    return { ok: false, error: `"${name}" contains a control character that cannot go into a document — remove it (tabs and line breaks are fine)` };
  }
  const length = Array.from(raw).length;
  if (length > DOCX_CHROME_TEXT_MAX) {
    return { ok: false, error: `"${name}" is limited to ${DOCX_CHROME_TEXT_MAX} characters, got ${length}` };
  }
  return { ok: true, text: raw };
}

/** 在 settings.xml 里找 <w:evenAndOddHeaders>（自闭合与配对两形都收——
 *  CT_OnOff 可带 w:val，[^>] 容属性）。纯。（263 奇偶页域的扫描件；居于
 *  此处因 verifyRemovals 的 evenOddFlag 互证消费它。） */
export function findEvenOddTags(settingsXml: string): { readonly tag: string; readonly at: number }[] {
  const out: { tag: string; at: number }[] = [];
  for (const m of settingsXml.matchAll(/<w:evenAndOddHeaders\b[^>]*?(?:\/>|><\/w:evenAndOddHeaders>)/g)) {
    out.push({ tag: m[0], at: m.index! });
  }
  return out;
}
