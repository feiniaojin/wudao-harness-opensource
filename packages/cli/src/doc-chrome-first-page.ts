// docx first-page-different pure layer — module-level segment extracted from
// doc-chrome.ts (ω99 file-size discipline arc A): the titlePg flag + first
// reference pair management (setDocxFirstPage). Pure functions over the
// shared primitives in doc-chrome-xml.ts.
import { smartZip, unzipEntriesWithMeta } from "./doc-zip.js";
import {
  chromeParamText,
  attrValue,
  bodySectPrRange,
  docxChromeZipError,
  STRUCTURE_ERROR,
  findTitlePgTags,
  findRefTags,
  removeSpans,
  removeRelsEntry,
  removeCtOverride,
  ridStillUsed,
  partNameOf,
  verifyRemovals,
  verifyChrome,
  setDocxChromeRef,
} from "./doc-chrome-xml.js";

/** 首页不同的输入形（工具面与纯层共用；unknown 域=入口自校验的纵深防御）。
 *  259 起 footerText 同 headerText 形（双部件族对称）。 */
export interface DocxFirstPageInput {
  readonly firstDifferent?: unknown;
  readonly headerText?: unknown;
  readonly footerText?: unknown;
}

export type ValidateFirstPageCheck =
  | { readonly ok: true; readonly firstDifferent: boolean; readonly headerText?: string; readonly footerText?: string }
  | { readonly ok: false; readonly error: string };

/** typed 校验（先于任何盘副作用）：firstDifferent 必布尔；headerText/
 *  footerText 可缺席（=该部件族首页无内容），给了则非空非纯白、无控制字
 *  符、帽 4,000 码点（238 的 text 校验族同款，参数名插值）；关闭（false）
 *  时不接受任何文本参数——关闭即回全篇同款，给了是参数矛盾（headerText/
 *  footerText 各自的矛盾文案）。纯函数，永不抛。 */
export function validateDocxFirstPage(rawFirst: unknown, rawText: unknown, rawFooter?: unknown): ValidateFirstPageCheck {
  if (typeof rawFirst !== "boolean") {
    return { ok: false, error: `"firstDifferent" must be a boolean (got ${JSON.stringify(rawFirst) ?? "undefined"})` };
  }
  if (rawFirst === false) {
    if (rawText !== undefined) {
      return { ok: false, error: '关闭首页不同时不接受 "headerText"——关闭即回到与其他页相同的页眉' };
    }
    if (rawFooter !== undefined) {
      return { ok: false, error: '关闭首页不同时不接受 "footerText"——关闭即回到与其他页相同的页脚' };
    }
    return { ok: true, firstDifferent: rawFirst };
  }
  let headerText: string | undefined;
  if (rawText !== undefined) {
    const checked = chromeParamText(rawText, "headerText");
    if (!checked.ok) return { ok: false, error: checked.error };
    headerText = checked.text;
  }
  let footerText: string | undefined;
  if (rawFooter !== undefined) {
    const checked = chromeParamText(rawFooter, "footerText");
    if (!checked.ok) return { ok: false, error: checked.error };
    footerText = checked.text;
  }
  return {
    ok: true,
    firstDifferent: rawFirst,
    ...(headerText !== undefined ? { headerText } : {}),
    ...(footerText !== undefined ? { footerText } : {}),
  };
}

/** <w:titlePg/> 的 schema 位序（ECMA-376 CT_SectPr 文序）：titlePg 在页面组
 *  （pgSz/pgMar/paperSrc/pgBorders/lnNumType/pgNumType/cols/formProt/vAlign/
 *  noEndnote）之后、其后组（textDirection/bidi/rtlGutter/docGrid/
 *  printerSettings/sectPrChange）之前——首个后组元素前插，无后组元素则
 *  sectPr 内文尾。未经 Word 真机回读验证（spec 文序裁定，真机验收归用户
 *  验装——诚实边界记报告）。 */
const TITLEPG_LATER_ELEMENTS = ["<w:textDirection", "<w:bidi", "<w:rtlGutter", "<w:docGrid", "<w:printerSettings", "<w:sectPrChange"];

/** 立旗（幂等）：titlePg 已在 → 原字节回（零重装）；不在 → 按位序插。纯。 */
function ensureTitlePg(bytes: Uint8Array): { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly error: string } {
  const unzipped = unzipEntriesWithMeta(bytes);
  if (!unzipped.ok) return { ok: false, error: docxChromeZipError(unzipped.error) };
  const entries = unzipped.entries;
  const document = entries.find((e) => e.name === "word/document.xml");
  if (document === undefined) return { ok: false, error: "这不是有效的 Word（.docx）文件——缺少文档内容" };
  const xml = new TextDecoder().decode(document.data);
  const range = bodySectPrRange(xml);
  if (range === undefined) return { ok: false, error: STRUCTURE_ERROR };
  if (findTitlePgTags(xml, range).length > 0) return { ok: true, bytes };
  let insertAt = range.innerEnd;
  const inner = xml.slice(range.innerStart, range.innerEnd);
  for (const later of TITLEPG_LATER_ELEMENTS) {
    const i = inner.indexOf(later);
    if (i !== -1 && range.innerStart + i < insertAt) insertAt = range.innerStart + i;
  }
  const newXml = xml.slice(0, insertAt) + "<w:titlePg/>" + xml.slice(insertAt);
  const enc = new TextEncoder();
  const out = smartZip(
    entries.map((e) => (e === document ? { name: e.name, data: enc.encode(newXml), meta: e } : { name: e.name, data: e.data, meta: e })),
  );
  return { ok: true, bytes: out };
}

export type SetDocxFirstPageCheck =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      readonly firstDifferent: boolean;
      readonly headerText?: string;
      readonly firstPartName?: string;
      readonly firstPartCreated?: boolean;
      readonly footerText?: string;
      readonly footerPartName?: string;
      readonly footerPartCreated?: boolean;
      readonly removedParts: readonly string[];
    }
  | { readonly ok: false; readonly reason: "not_found"; readonly error?: undefined }
  | { readonly ok: false; readonly reason?: undefined; readonly error: string };

/** 首页不同（面二，「首页不要页眉/首页不要页码」零参数达成）：
 *  - `firstDifferent: true`：末节 sectPr 立 `<w:titlePg/>`（幂等——已在则原
 *    字节回）+（可选 headerText/footerText，259 起双部件族对称）建/换各族
 *    的 **first 引用部件**（复用 238 的 setDocxChromeRef 机械，type 换
 *    "first"——覆写路径部件数不增；两族部件号/rId 各自 max+1 碰撞纪律）；
 *    不给任何文本=纯开关：titlePg 在 + first 引用缺 = 首页无页眉也无页脚
 *    （既有 first 引用保留——本面不静默删内容，要清走 false 或 clear 的
 *    first 变体）。
 *  - `firstDifferent: false`：拆 titlePg + header/footer 的 first 引用/部
 *    件/rels/CT **各自独立四清**（同 clear 缝，双面对称——单面缺席跳过不
 *    报错：开关语义是「回到全篇一致」）；default 页眉/页脚原样保留。两者
 *    皆无（titlePg 与两族 first 引用全缺）→ typed not_found。
 *  入口自校验 + 回装互证。纯函数。 */
export function setDocxFirstPage(bytes: Uint8Array, input: DocxFirstPageInput): SetDocxFirstPageCheck {
  const checked = validateDocxFirstPage(input.firstDifferent, input.headerText, input.footerText);
  if (!checked.ok) return { ok: false, error: checked.error };
  if (checked.firstDifferent) {
    let cur = bytes;
    let firstPartName: string | undefined;
    let firstPartCreated: boolean | undefined;
    if (checked.headerText !== undefined) {
      const set = setDocxChromeRef(cur, "header", "first", checked.headerText);
      if (!set.ok) return { ok: false, error: set.error };
      cur = set.bytes;
      firstPartName = set.partName;
      firstPartCreated = set.created;
    }
    // footerText 同语义（首件族后建——两族部件号/rId 各自 max+1，一次调用
    // 双部件族原子达成）。
    let footerPartName: string | undefined;
    let footerPartCreated: boolean | undefined;
    if (checked.footerText !== undefined) {
      const set = setDocxChromeRef(cur, "footer", "first", checked.footerText);
      if (!set.ok) return { ok: false, error: set.error };
      cur = set.bytes;
      footerPartName = set.partName;
      footerPartCreated = set.created;
    }
    const titled = ensureTitlePg(cur);
    if (!titled.ok) return { ok: false, error: titled.error };
    // 互证：titlePg 在（+给了文本则各族 first 链读回等值——238 范式）。
    const unzipped = unzipEntriesWithMeta(titled.bytes);
    if (!unzipped.ok) return { ok: false, error: STRUCTURE_ERROR };
    const document = unzipped.entries.find((e) => e.name === "word/document.xml");
    if (document === undefined) return { ok: false, error: STRUCTURE_ERROR };
    const xml = new TextDecoder().decode(document.data);
    const range = bodySectPrRange(xml);
    if (range === undefined) return { ok: false, error: STRUCTURE_ERROR };
    if (findTitlePgTags(xml, range).length === 0) return { ok: false, error: STRUCTURE_ERROR };
    if (checked.headerText !== undefined) {
      const failure = verifyChrome(titled.bytes, "header", "first", checked.headerText);
      if (failure !== undefined) return { ok: false, error: failure };
    }
    if (checked.footerText !== undefined) {
      const failure = verifyChrome(titled.bytes, "footer", "first", checked.footerText);
      if (failure !== undefined) return { ok: false, error: failure };
    }
    return {
      ok: true,
      bytes: titled.bytes,
      firstDifferent: true,
      ...(checked.headerText !== undefined ? { headerText: checked.headerText, firstPartName, firstPartCreated } : {}),
      ...(checked.footerText !== undefined ? { footerText: checked.footerText, footerPartName, footerPartCreated } : {}),
      removedParts: [],
    };
  }
  // ——关闭：拆 titlePg + header/footer 的 first 引用族各自独立四清（同
  //  clear 缝，双面对称；单面缺席跳过——「回到全篇一致」如实不报错）。——
  const unzipped = unzipEntriesWithMeta(bytes);
  if (!unzipped.ok) return { ok: false, error: docxChromeZipError(unzipped.error) };
  const entries = unzipped.entries;
  const document = entries.find((e) => e.name === "word/document.xml");
  if (document === undefined) return { ok: false, error: "这不是有效的 Word（.docx）文件——缺少文档内容" };
  const xml = new TextDecoder().decode(document.data);
  const range = bodySectPrRange(xml);
  if (range === undefined) return { ok: false, error: STRUCTURE_ERROR };
  const titleTags = findTitlePgTags(xml, range);
  const firstRefs = [...findRefTags(xml, range, "header", "first"), ...findRefTags(xml, range, "footer", "first")];
  if (titleTags.length === 0 && firstRefs.length === 0) return { ok: false, reason: "not_found" };
  const relsEntry = entries.find((e) => e.name === "word/_rels/document.xml.rels");
  const ctEntry = entries.find((e) => e.name === "[Content_Types].xml");
  if (firstRefs.length > 0 && (relsEntry === undefined || ctEntry === undefined)) return { ok: false, error: STRUCTURE_ERROR };
  const relsXml = relsEntry === undefined ? "" : new TextDecoder().decode(relsEntry.data);
  const ctXml = ctEntry === undefined ? "" : new TextDecoder().decode(ctEntry.data);

  const enc = new TextEncoder();
  let newXml = removeSpans(xml, [...titleTags, ...firstRefs]);
  const removedParts: string[] = [];
  const removedPartSet = new Set<string>();
  const droppedParts = new Set<(typeof entries)[number]>();
  let newRels = relsXml;
  let newCt = ctXml;
  for (const rid of [...new Set(firstRefs.map((r) => attrValue(r.tag, "r:id")))]) {
    if (rid === undefined) return { ok: false, error: STRUCTURE_ERROR };
    let target: string | undefined;
    for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
      if (attrValue(m[0], "Id") === rid) target = attrValue(m[0], "Target");
    }
    if (target === undefined) return { ok: false, error: STRUCTURE_ERROR };
    const partName = partNameOf(target);
    if (ridStillUsed(newXml, rid)) continue; // 剩余文档仍引用（如 default 同引）——保留。
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
      if (relsEntry !== undefined && e === relsEntry) return [{ name: e.name, data: enc.encode(newRels), meta: e }];
      if (ctEntry !== undefined && e === ctEntry) return [{ name: e.name, data: enc.encode(newCt), meta: e }];
      return [{ name: e.name, data: e.data, meta: e }];
    }),
  );
  const failure = verifyRemovals(out, { refs: firstRefs, titlePg: true, removedParts: removedPartSet });
  if (failure !== undefined) return { ok: false, error: failure };
  return { ok: true, bytes: out, firstDifferent: false, removedParts };
}
