// docx even/odd-pages pure layer — module-level segment extracted from
// doc-chrome.ts (ω99 file-size discipline arc A): the settings.xml
// evenAndOddHeaders document-level flag + the even reference档 of both part
// families (setDocxEvenPages). Pure functions over the shared primitives in
// doc-chrome-xml.ts.
import { smartZip, unzipEntriesWithMeta } from "./doc-zip.js";
import {
  chromeParamText,
  attrValue,
  bodySectPrRange,
  docxChromeZipError,
  STRUCTURE_ERROR,
  findRefTags,
  findEvenOddTags,
  removeSpans,
  removeRelsEntry,
  removeCtOverride,
  ridStillUsed,
  partNameOf,
  verifyRemovals,
  verifyChrome,
  setDocxChromeRef,
  maxRId,
  XML_DECL,
  RELS_OPEN,
  NS_R,
  WORD_NS,
} from "./doc-chrome-xml.js";

// ---------------------------------------------------------------------------
// B3 — ω99-263 奇偶页不同纯层（settings.xml 的 evenAndOddHeaders 文档级旗
// 标 + header/footer 双部件族的 even 引用档）。全部纯函数：不碰时钟、不碰
// 盘；旗标的增删只动 word/settings.xml 部件内的 XML 元素——**部件永不删**
// （其他 Word 设置原样保留；缺席则创建最小壳，绝不反向拆除）。
// ---------------------------------------------------------------------------

/** settings 部件名 / 关系类型 / 内容类型（ECMA-376 wordprocessingml 常量）。 */
const SETTINGS_PART = "word/settings.xml";
const SETTINGS_REL_TYPE = `${NS_R}/settings`;
const SETTINGS_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml";

/** settings.xml 缺席时的最小壳（标准字面量裁定——ns 从 document.xml 根标签
 *  同源抄：buildDocx 的根只声明 xmlns:w，壳内唯一子 evenAndOddHeaders 也只
 *  用 w: 前缀，不声明用不到的命名空间）。 */
const SETTINGS_MINIMAL = `${XML_DECL}<w:settings xmlns:w="${WORD_NS}"><w:evenAndOddHeaders/></w:settings>`;

/** <w:evenAndOddHeaders/> 的 schema 位序（ECMA-376 Part 1 CT_Settings 文序
 *  裁定，wml.xsd transitional）：evenAndOddHeaders 在 defaultTabStop/
 *  clickAndTypeStyle/defaultTableStyle 之后，其后是 bookFoldRevPrinting 起
 *  的整段——首个后组元素前插，无后组元素则 settings 内文尾。m:mathPr 与
 *  mc:AlternateContent（Word 2010+ 的 w14/w15 扩展容器）按字面前缀一并
 *  入后组。未经 Word 真机回读验证（256 的 TITLEPG_LATER_ELEMENTS 同款诚
 *  实边界——真机验收归用户验装）。 */
const EVENODD_LATER_ELEMENTS = [
  "<w:bookFoldRevPrinting", "<w:bookFoldPrinting", "<w:bookFoldPrintingSheets",
  "<w:drawingGridHorizontalSpacing", "<w:drawingGridVerticalSpacing",
  "<w:displayHorizontalDrawingGridEvery", "<w:displayVerticalDrawingGridEvery",
  "<w:doNotUseMarginsForDrawingGridOrigin", "<w:drawingGridHorizontalOrigin", "<w:drawingGridVerticalOrigin",
  "<w:doNotShadeFormData", "<w:noPunctuationKerning", "<w:characterSpacingControl", "<w:printTwoOnOne",
  "<w:strictFirstAndLastChars", "<w:noLineBreaksAfter", "<w:noLineBreaksBefore",
  "<w:savePreviewPicture", "<w:doNotValidateAgainstSchema", "<w:saveInvalidXml", "<w:ignoreMixedContent",
  "<w:alwaysShowPlaceholderText", "<w:doNotDemarcateInvalidXml", "<w:saveXmlDataOnly",
  "<w:useXSLTWhenSaving", "<w:saveThroughXslt", "<w:showXMLTags", "<w:alwaysMergeEmptyNamespace",
  "<w:updateFields", "<w:hdrShapeDefaults", "<w:footnotePr", "<w:endnotePr",
  "<w:compat", "<w:docVars", "<w:rsids", "<m:mathPr", "<w:attachedSchema",
  "<w:themeFontLang", "<w:clrSchemeMapping", "<w:doNotIncludeSubdocsInStats",
  "<w:doNotAutoCompressPictures", "<w:forceUpgrade", "<w:captions", "<w:readModeInkLockDown",
  "<w:smartTagType", "<w:schemaLibrary", "<w:doNotEmbedSmartTags",
  "<w:decimalSymbol", "<w:listSeparator", "<mc:AlternateContent",
];

/** settings 根元素的内文区间（`<w:settings …>` 开标签尾 → `</w:settings>`
 *  前）。找不到/残缺 → undefined。纯。 */
function settingsInnerRange(settingsXml: string): { readonly innerStart: number; readonly innerEnd: number } | undefined {
  const open = /<w:settings\b[^>]*>/.exec(settingsXml);
  if (open === null) return undefined;
  const close = settingsXml.lastIndexOf("</w:settings>");
  if (close === -1 || close < open.index + open[0].length) return undefined;
  return { innerStart: open.index + open[0].length, innerEnd: close };
}

/** 奇偶页旗标的原子管理（幂等镜像 ensureTitlePg）：
 *  - enable=true：settings.xml 在场且旗标已在 → **原字节回**（零重装）；
 *    在场无旗标 → 按 EVENODD_LATER_ELEMENTS 位序插 `<w:evenAndOddHeaders/>`
 *    （其他子原样保留）；缺席 → 创建最小部件 + CT Override + document
 *    rels 关系三缝（rels 部件缺席则一并新建；rId=maxRId+1 碰撞纪律沿
 *    223/228）。
 *  - enable=false：缺席或旗标本无 → 原字节回（幂等零写点）；在场 → 只删
 *    旗标元素，**部件与其他 Word 设置原样保留（部件永不删）**。
 *  纯函数：不碰时钟、不碰盘。 */
function ensureEvenOddFlag(bytes: Uint8Array, enable: boolean): { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly error: string } {
  const unzipped = unzipEntriesWithMeta(bytes);
  if (!unzipped.ok) return { ok: false, error: docxChromeZipError(unzipped.error) };
  const entries = unzipped.entries;
  const enc = new TextEncoder();
  const settingsEntry = entries.find((e) => e.name === SETTINGS_PART);

  if (!enable) {
    if (settingsEntry === undefined) return { ok: true, bytes };
    const settingsXml = new TextDecoder().decode(settingsEntry.data);
    const tags = findEvenOddTags(settingsXml);
    if (tags.length === 0) return { ok: true, bytes };
    const newSettings = removeSpans(settingsXml, tags);
    const out = smartZip(
      entries.map((e) =>
        e === settingsEntry ? { name: e.name, data: enc.encode(newSettings), meta: e } : { name: e.name, data: e.data, meta: e },
      ),
    );
    return { ok: true, bytes: out };
  }

  if (settingsEntry !== undefined) {
    const settingsXml = new TextDecoder().decode(settingsEntry.data);
    if (findEvenOddTags(settingsXml).length > 0) return { ok: true, bytes };
    const range = settingsInnerRange(settingsXml);
    if (range === undefined) return { ok: false, error: "这不是有效的 Word（.docx）文件——文档设置部件结构不完整" };
    let insertAt = range.innerEnd;
    const inner = settingsXml.slice(range.innerStart, range.innerEnd);
    for (const later of EVENODD_LATER_ELEMENTS) {
      const i = inner.indexOf(later);
      if (i !== -1 && range.innerStart + i < insertAt) insertAt = range.innerStart + i;
    }
    const newSettings = settingsXml.slice(0, insertAt) + "<w:evenAndOddHeaders/>" + settingsXml.slice(insertAt);
    const out = smartZip(
      entries.map((e) =>
        e === settingsEntry ? { name: e.name, data: enc.encode(newSettings), meta: e } : { name: e.name, data: e.data, meta: e },
      ),
    );
    return { ok: true, bytes: out };
  }

  // ——缺席 → 创建路径：CT 必在（docx 必备件）；rels 缺席则新建（make_docx
  //  裸包零 word/_rels/document.xml.rels，238 同款裁定）；新部件尾续。——
  const ctEntry = entries.find((e) => e.name === "[Content_Types].xml");
  if (ctEntry === undefined) return { ok: false, error: STRUCTURE_ERROR };
  const ctXml = new TextDecoder().decode(ctEntry.data);
  if (!ctXml.includes("</Types>")) return { ok: false, error: STRUCTURE_ERROR };
  const relsEntry = entries.find((e) => e.name === "word/_rels/document.xml.rels");
  const relsXml = relsEntry === undefined ? undefined : new TextDecoder().decode(relsEntry.data);
  if (relsXml !== undefined && !relsXml.includes("</Relationships>")) {
    return { ok: false, error: STRUCTURE_ERROR };
  }
  const nextRid = maxRId(relsXml ?? "") + 1;
  const relAdd = `<Relationship Id="rId${nextRid}" Type="${SETTINGS_REL_TYPE}" Target="settings.xml"/>`;
  const newRels =
    relsXml === undefined ? `${XML_DECL}${RELS_OPEN}${relAdd}</Relationships>` : relsXml.replace("</Relationships>", `${relAdd}</Relationships>`);
  const newCt = ctXml.replace("</Types>", `<Override PartName="/${SETTINGS_PART}" ContentType="${SETTINGS_CONTENT_TYPE}"/></Types>`);
  const out = smartZip([
    ...entries.map((e) => {
      if (relsEntry !== undefined && e === relsEntry) return { name: e.name, data: enc.encode(newRels), meta: e };
      if (e === ctEntry) return { name: e.name, data: enc.encode(newCt), meta: e };
      return { name: e.name, data: e.data, meta: e };
    }),
    ...(relsEntry === undefined ? [{ name: "word/_rels/document.xml.rels", data: enc.encode(newRels) }] : []),
    { name: SETTINGS_PART, data: enc.encode(SETTINGS_MINIMAL) },
  ]);
  return { ok: true, bytes: out };
}

/** 奇偶页不同的输入形（工具面与纯层共用；unknown 域=入口自校验的纵深防御）。 */
export interface DocxEvenPagesInput {
  readonly evenOddDifferent?: unknown;
  readonly evenHeaderText?: unknown;
  readonly evenFooterText?: unknown;
}

export type ValidateEvenPagesCheck =
  | { readonly ok: true; readonly evenOddDifferent: boolean; readonly evenHeaderText?: string; readonly evenFooterText?: string }
  | { readonly ok: false; readonly error: string };

/** typed 校验（先于任何盘副作用；镜像 validateDocxFirstPage）：evenOddDifferent
 *  必布尔；evenHeaderText/evenFooterText 可缺席（=该部件族偶数页不另设内
 *  容），给了则非空非纯白、无控制字符、帽 4,000 码点（chromeParamText 共用
 *  件）；关闭（false）时不接受任何文本参数——关闭即回全篇一致，给了是参数
 *  矛盾（两参数各自的矛盾文案镜像 259 逐字形）。纯函数，永不抛。 */
export function validateDocxEvenPages(rawEven: unknown, rawHeader?: unknown, rawFooter?: unknown): ValidateEvenPagesCheck {
  if (typeof rawEven !== "boolean") {
    return { ok: false, error: `"evenOddDifferent" must be a boolean (got ${JSON.stringify(rawEven) ?? "undefined"})` };
  }
  if (rawEven === false) {
    if (rawHeader !== undefined) {
      return { ok: false, error: '关闭奇偶页不同时不接受 "evenHeaderText"——关闭即回到与其他页相同的页眉' };
    }
    if (rawFooter !== undefined) {
      return { ok: false, error: '关闭奇偶页不同时不接受 "evenFooterText"——关闭即回到与其他页相同的页脚' };
    }
    return { ok: true, evenOddDifferent: rawEven };
  }
  let evenHeaderText: string | undefined;
  if (rawHeader !== undefined) {
    const checked = chromeParamText(rawHeader, "evenHeaderText");
    if (!checked.ok) return { ok: false, error: checked.error };
    evenHeaderText = checked.text;
  }
  let evenFooterText: string | undefined;
  if (rawFooter !== undefined) {
    const checked = chromeParamText(rawFooter, "evenFooterText");
    if (!checked.ok) return { ok: false, error: checked.error };
    evenFooterText = checked.text;
  }
  return {
    ok: true,
    evenOddDifferent: rawEven,
    ...(evenHeaderText !== undefined ? { evenHeaderText } : {}),
    ...(evenFooterText !== undefined ? { evenFooterText } : {}),
  };
}

export type SetDocxEvenPagesCheck =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      readonly evenOddDifferent: boolean;
      readonly evenHeaderText?: string;
      readonly evenHeaderPartName?: string;
      readonly evenHeaderPartCreated?: boolean;
      readonly evenFooterText?: string;
      readonly evenFooterPartName?: string;
      readonly evenFooterPartCreated?: boolean;
      readonly removedParts: readonly string[];
    }
  | { readonly ok: false; readonly reason: "not_found"; readonly error?: undefined }
  | { readonly ok: false; readonly reason?: undefined; readonly error: string };

/** 奇偶页不同（面二，「书的左右页不同页眉」零参数达成——Word UI「奇偶页不
 *  同」域）：
 *  - `evenOddDifferent: true`：立文档级旗标 `<w:evenAndOddHeaders/>`（幂等）
 *    +（可选 evenHeaderText/evenFooterText）建/换各族 **even 引用部件**
 *    （复用 setDocxChromeRef 机械，type 换 "even"——覆写路径部件数不增；
 *    两族部件号/rId 各自 max+1 碰撞纪律）；不给任何文本=纯开关。
 *  - `evenOddDifferent: false`：拆旗标 + header/footer 的 even 引用族/部
 *    件/rels/CT **各自独立四清**（同 clear 缝；单面缺席跳过不报错：开关语
 *    义是「回到全篇一致」）；default 页眉/页脚与 settings.xml 的其他 Word
 *    设置原样保留。旗标与两族 even 引用全缺 → typed not_found。
 *  旗标是**文档级**（全文档生效，与 titlePg 的节级不同——不对称如实记）；
 *  even 引用落末节（259 池 #3 边界继承）。入口自校验 + 回装互证。纯函数。 */
export function setDocxEvenPages(bytes: Uint8Array, input: DocxEvenPagesInput): SetDocxEvenPagesCheck {
  const checked = validateDocxEvenPages(input.evenOddDifferent, input.evenHeaderText, input.evenFooterText);
  if (!checked.ok) return { ok: false, error: checked.error };
  if (checked.evenOddDifferent) {
    let cur = bytes;
    let evenHeaderPartName: string | undefined;
    let evenHeaderPartCreated: boolean | undefined;
    if (checked.evenHeaderText !== undefined) {
      const set = setDocxChromeRef(cur, "header", "even", checked.evenHeaderText);
      if (!set.ok) return { ok: false, error: set.error };
      cur = set.bytes;
      evenHeaderPartName = set.partName;
      evenHeaderPartCreated = set.created;
    }
    // evenFooterText 同语义（首件族后建——两族部件号/rId 各自 max+1，一次
    // 调用双部件族原子达成，259 同款序）。
    let evenFooterPartName: string | undefined;
    let evenFooterPartCreated: boolean | undefined;
    if (checked.evenFooterText !== undefined) {
      const set = setDocxChromeRef(cur, "footer", "even", checked.evenFooterText);
      if (!set.ok) return { ok: false, error: set.error };
      cur = set.bytes;
      evenFooterPartName = set.partName;
      evenFooterPartCreated = set.created;
    }
    const flagged = ensureEvenOddFlag(cur, true);
    if (!flagged.ok) return { ok: false, error: flagged.error };
    // 互证：旗标在（+给了文本则各族 even 链读回等值——223/238 范式）。
    const unzipped = unzipEntriesWithMeta(flagged.bytes);
    if (!unzipped.ok) return { ok: false, error: STRUCTURE_ERROR };
    const settings = unzipped.entries.find((e) => e.name === SETTINGS_PART);
    if (settings === undefined) return { ok: false, error: STRUCTURE_ERROR };
    if (findEvenOddTags(new TextDecoder().decode(settings.data)).length === 0) return { ok: false, error: STRUCTURE_ERROR };
    if (checked.evenHeaderText !== undefined) {
      const failure = verifyChrome(flagged.bytes, "header", "even", checked.evenHeaderText);
      if (failure !== undefined) return { ok: false, error: failure };
    }
    if (checked.evenFooterText !== undefined) {
      const failure = verifyChrome(flagged.bytes, "footer", "even", checked.evenFooterText);
      if (failure !== undefined) return { ok: false, error: failure };
    }
    return {
      ok: true,
      bytes: flagged.bytes,
      evenOddDifferent: true,
      ...(checked.evenHeaderText !== undefined ? { evenHeaderText: checked.evenHeaderText, evenHeaderPartName, evenHeaderPartCreated } : {}),
      ...(checked.evenFooterText !== undefined ? { evenFooterText: checked.evenFooterText, evenFooterPartName, evenFooterPartCreated } : {}),
      removedParts: [],
    };
  }
  // ——关闭：拆旗标 + header/footer 的 even 引用族各自独立四清（同 clear
  //  缝；单面缺席跳过——「回到全篇一致」如实不报错）。——
  const unzipped = unzipEntriesWithMeta(bytes);
  if (!unzipped.ok) return { ok: false, error: docxChromeZipError(unzipped.error) };
  const entries = unzipped.entries;
  const document = entries.find((e) => e.name === "word/document.xml");
  if (document === undefined) return { ok: false, error: "这不是有效的 Word（.docx）文件——缺少文档内容" };
  const xml = new TextDecoder().decode(document.data);
  const range = bodySectPrRange(xml);
  if (range === undefined) return { ok: false, error: STRUCTURE_ERROR };
  const evenRefs = [...findRefTags(xml, range, "header", "even"), ...findRefTags(xml, range, "footer", "even")];
  const settingsEntry = entries.find((e) => e.name === SETTINGS_PART);
  const flagTags = settingsEntry === undefined ? [] : findEvenOddTags(new TextDecoder().decode(settingsEntry.data));
  if (evenRefs.length === 0 && flagTags.length === 0) return { ok: false, reason: "not_found" };
  const relsEntry = entries.find((e) => e.name === "word/_rels/document.xml.rels");
  const ctEntry = entries.find((e) => e.name === "[Content_Types].xml");
  if (evenRefs.length > 0 && (relsEntry === undefined || ctEntry === undefined)) return { ok: false, error: STRUCTURE_ERROR };
  const relsXml = relsEntry === undefined ? "" : new TextDecoder().decode(relsEntry.data);
  const ctXml = ctEntry === undefined ? "" : new TextDecoder().decode(ctEntry.data);

  const enc = new TextEncoder();
  let newXml = removeSpans(xml, evenRefs);
  const removedParts: string[] = [];
  const removedPartSet = new Set<string>();
  const droppedParts = new Set<(typeof entries)[number]>();
  let newRels = relsXml;
  let newCt = ctXml;
  for (const rid of [...new Set(evenRefs.map((r) => attrValue(r.tag, "r:id")))]) {
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
      if (settingsEntry !== undefined && e === settingsEntry) {
        return [{ name: e.name, data: enc.encode(removeSpans(new TextDecoder().decode(settingsEntry.data), flagTags)), meta: e }];
      }
      return [{ name: e.name, data: e.data, meta: e }];
    }),
  );
  // 互证：even 引用在场过 verifyRemovals 真链（含旗标删尽）；纯旗标路径
  // （无引用、rels 可缺席的裸手搓包）走内联核（settings 部件允许在场但旗
  // 标必无）。
  if (evenRefs.length > 0) {
    const failure = verifyRemovals(out, { refs: evenRefs, evenOddFlag: true, removedParts: removedPartSet });
    if (failure !== undefined) return { ok: false, error: failure };
  } else {
    const recheck = unzipEntriesWithMeta(out);
    if (!recheck.ok) return { ok: false, error: STRUCTURE_ERROR };
    const settings = recheck.entries.find((e) => e.name === SETTINGS_PART);
    if (settings !== undefined && findEvenOddTags(new TextDecoder().decode(settings.data)).length !== 0) {
      return { ok: false, error: STRUCTURE_ERROR };
    }
  }
  return { ok: true, bytes: out, evenOddDifferent: false, removedParts };
}
