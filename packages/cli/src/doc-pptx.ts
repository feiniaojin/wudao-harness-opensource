// ω99-124 — minimal pptx 组装（零依赖纯层）。DocDeck（三版式页）→ 一个能被
// PowerPoint/Keynote/WPS 双击打开的 .pptx 字节流：stored zip（doc-zip，123 缝）
// + 九件 XML 部件（presentation / master / layout / theme / slides）。
// 模型只给页的大纲内容，版式（16:9、字号、居中、项目符号、表头加粗）本层
// 全钉——不暴露样式旋钮（v1 版式模型）。
//
// 纪律（brief 钉）：
// - 校验（validateDocDeck）与组装（buildPptx）都是纯函数：不碰时钟（docProps
//   时间钉常量、DOS 时间由 doc-zip 钉）、不碰盘；字节确定性=同 deck 两次构建全等；
// - typed 拒优于静默剥：控制字符/非有限数字/坏 kind 直接拒（错误信息给模型可
//   自修的原因）；
// - 单通道 filename（123 fix1 裁决继承）：deck 内不携带任何路径字段，写盘目标
//   只有 make_pptx 的顶层 filename 参数；
// - cell 规与 doc-xlsx 同款（对照测试钉两侧一致）；本层未改 doc-xlsx.ts，
//   cell 检查本地实现，收/拒矩阵由 tests/omega99-124 逐值对照钉死。
import { buildTool, resolveWorkspacePath } from "@wudao-org/core";
import type { Tool } from "@wudao-org/core";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { storedZip } from "./doc-zip.js";

/** 封面页：大标题居中 + 可选副标题。 */
export interface DocCoverSlide {
  readonly kind: "cover";
  readonly title: string;
  readonly subtitle?: string;
}

/** 要点页：标题 + 圆点要点（1..6 条，flat——两级缩进 v1 不做）。 */
export interface DocBulletsSlide {
  readonly kind: "bullets";
  readonly title: string;
  readonly bullets: readonly string[];
}

/** 表格页：标题 + 表头列 + 数据行（cell 四形同 xlsx）。 */
export interface DocTableSlide {
  readonly kind: "table";
  readonly title: string;
  readonly columns: readonly { readonly header: string }[];
  readonly rows: readonly (readonly (string | number | boolean | null)[])[];
}

export type DocSlide = DocCoverSlide | DocBulletsSlide | DocTableSlide;

/** 一副演示文稿：1..20 页。落盘文件名是 make_pptx 的顶层 filename 参数（单通道）。 */
export interface DocDeck {
  readonly slides: readonly DocSlide[];
}

export type DocDeckCheck = { readonly ok: true; readonly deck: DocDeck } | { readonly ok: false; readonly error: string };

export const PPTX_MAX_SLIDES = 20;
export const PPTX_MAX_BULLETS = 6;
export const PPTX_MAX_COLUMNS = 64;
export const PPTX_MAX_ROWS = 500;
/** 控制字符：\x00-\x08、\x0B、\x0C、\x0E-\x1F（\t \n \r 放行）——XML 1.0 非法，一律拒。 */
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

/** typed 校验：三版式形状全查（纯函数，永不抛）。未知键忽略（同 123：policy 面不挖嵌套）。 */
export function validateDocDeck(raw: unknown): DocDeckCheck {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "deck must be an object {slides: [...]} (1-20 pages)" };
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.slides)) {
    return { ok: false, error: "deck.slides must be an array of 1-20 pages" };
  }
  if (r.slides.length === 0) {
    return { ok: false, error: "deck.slides must have at least one page" };
  }
  if (r.slides.length > PPTX_MAX_SLIDES) {
    return { ok: false, error: `deck.slides is limited to ${PPTX_MAX_SLIDES} pages, got ${r.slides.length}` };
  }

  const slides: DocSlide[] = [];
  for (const [i, s] of r.slides.entries()) {
    const at = `deck.slides[${i}]`;
    if (typeof s !== "object" || s === null || Array.isArray(s)) {
      return { ok: false, error: `${at} must be an object with a kind ("cover" | "bullets" | "table")` };
    }
    const sl = s as Record<string, unknown>;
    if (typeof sl.kind !== "string") {
      return { ok: false, error: `${at}.kind must be one of "cover", "bullets", "table"` };
    }
    // title 三版式共规：非空字符串 + 无控制字符。
    if (typeof sl.title !== "string" || sl.title.length === 0) {
      return { ok: false, error: `${at}.title must be a non-empty string` };
    }
    if (CONTROL_CHARS.test(sl.title)) {
      return { ok: false, error: `${at}.title contains a control character that cannot go into a slide — remove it (tabs and line breaks are fine)` };
    }

    if (sl.kind === "cover") {
      let subtitle: string | undefined;
      if (sl.subtitle !== undefined) {
        if (typeof sl.subtitle !== "string" || sl.subtitle.length === 0) {
          return { ok: false, error: `${at}.subtitle must be a non-empty string (or omit it)` };
        }
        if (CONTROL_CHARS.test(sl.subtitle)) {
          return { ok: false, error: `${at}.subtitle contains a control character — remove it` };
        }
        subtitle = sl.subtitle;
      }
      slides.push(subtitle === undefined ? { kind: "cover", title: sl.title } : { kind: "cover", title: sl.title, subtitle });
      continue;
    }

    if (sl.kind === "bullets") {
      if (!Array.isArray(sl.bullets)) {
        return { ok: false, error: `${at}.bullets must be an array of 1-${PPTX_MAX_BULLETS} non-empty strings` };
      }
      if (sl.bullets.length === 0) {
        return { ok: false, error: `${at}.bullets must have at least one bullet` };
      }
      if (sl.bullets.length > PPTX_MAX_BULLETS) {
        return { ok: false, error: `${at}.bullets is limited to ${PPTX_MAX_BULLETS} bullets, got ${sl.bullets.length}` };
      }
      const bullets: string[] = [];
      for (const [bi, b] of sl.bullets.entries()) {
        if (typeof b !== "string" || b.length === 0) {
          return { ok: false, error: `${at}.bullets[${bi}] must be a non-empty string` };
        }
        if (CONTROL_CHARS.test(b)) {
          return { ok: false, error: `${at}.bullets[${bi}] contains a control character — remove it (tabs and line breaks are fine)` };
        }
        bullets.push(b);
      }
      slides.push({ kind: "bullets", title: sl.title, bullets });
      continue;
    }

    if (sl.kind === "table") {
      if (!Array.isArray(sl.columns)) {
        return { ok: false, error: `${at}.columns must be an array of {header: string}` };
      }
      if (sl.columns.length === 0) {
        return { ok: false, error: `${at}.columns must have at least one column (the header row)` };
      }
      if (sl.columns.length > PPTX_MAX_COLUMNS) {
        return { ok: false, error: `${at}.columns is limited to ${PPTX_MAX_COLUMNS} columns, got ${sl.columns.length}` };
      }
      const columns: { header: string }[] = [];
      for (const [ci, c] of sl.columns.entries()) {
        if (typeof c !== "object" || c === null || Array.isArray(c)) {
          return { ok: false, error: `${at}.columns[${ci}] must be an object {header: string}` };
        }
        const h = (c as Record<string, unknown>).header;
        if (typeof h !== "string" || h.length === 0) {
          return { ok: false, error: `${at}.columns[${ci}].header must be a non-empty string` };
        }
        if (CONTROL_CHARS.test(h)) {
          return { ok: false, error: `${at}.columns[${ci}].header contains a control character — remove it` };
        }
        columns.push({ header: h });
      }
      if (!Array.isArray(sl.rows)) {
        return { ok: false, error: `${at}.rows must be an array of rows (each row an array of cells)` };
      }
      if (sl.rows.length > PPTX_MAX_ROWS) {
        return { ok: false, error: `${at}.rows is limited to ${PPTX_MAX_ROWS} rows, got ${sl.rows.length}` };
      }
      const rows: (string | number | boolean | null)[][] = [];
      for (const [ri, row] of sl.rows.entries()) {
        if (!Array.isArray(row)) {
          return { ok: false, error: `${at}.rows[${ri}] must be an array of cells (string | number | boolean | null)` };
        }
        if (row.length > columns.length) {
          return { ok: false, error: `${at}.rows[${ri}] has ${row.length} cells but the table only has ${columns.length} columns` };
        }
        const cells: (string | number | boolean | null)[] = [];
        for (const cell of row) {
          if (cell === null) cells.push(null);
          else if (typeof cell === "string") {
            if (CONTROL_CHARS.test(cell)) {
              return { ok: false, error: `${at}.rows[${ri}] contains a control character that cannot go into a table — remove it (tabs and line breaks are fine)` };
            }
            cells.push(cell);
          } else if (typeof cell === "number") {
            if (!Number.isFinite(cell)) {
              return { ok: false, error: `${at}.rows[${ri}] must contain finite numbers (NaN/Infinity cannot go into a table)` };
            }
            cells.push(cell);
          } else if (typeof cell === "boolean") cells.push(cell);
          else return { ok: false, error: `${at}.rows[${ri}] cells must be strings, numbers, booleans or null` };
        }
        rows.push(cells);
      }
      slides.push({ kind: "table", title: sl.title, columns, rows });
      continue;
    }

    return { ok: false, error: `${at}.kind must be one of "cover", "bullets", "table" (got ${JSON.stringify(sl.kind)})` };
  }
  return { ok: true, deck: { slides } };
}

// ---------------------------------------------------------------------------
// XML 部件组装（常量模板 + 页内容注入；docProps 时间钉常量=同 123）。
// 版式 v1 全钉：16:9（12192000×6858000 EMU）、字号、位置、buChar——模型零样式参数。
// ---------------------------------------------------------------------------

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
/** docProps 时间钉常量（确定性：绝不读时钟）。 */
const DOC_CREATED = "2026-01-01T00:00:00Z";

const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PPT_NS = `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"`;

/** 16:9 版面（EMU）：宽 12192000 × 高 6858000。 */
const SLIDE_CX = 12_192_000;
const SLIDE_CY = 6_858_000;

/** 五实体转义（&amp; &lt; &gt; &quot; &apos;）——同 123 规，本地同款实现。 */
function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&apos;");
}

/** spTree 开头两件（组形状的恒等变换）——master/layout/slide 三处共用。 */
const GRP_SP_PR =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

/** 文本框形状：位置/尺寸（EMU）+ 段落数组。 */
function textBox(id: number, name: string, x: number, y: number, cx: number, cy: number, bodyPr: string, paragraphs: string): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `<p:txBody>${bodyPr}<a:lstStyle/>${paragraphs}</p:txBody></p:sp>`
  );
}

/** 单段文本：algn 省略=默认左；run 带 sz（百分之一磅）。 */
const para = (sz: number, t: string, algn?: string, bold = false): string =>
  `<a:p>${algn === undefined ? "" : `<a:pPr algn="${algn}"/>`}<a:r><a:rPr sz="${sz}"${bold ? ' b="1"' : ""}/><a:t>${escapeXml(t)}</a:t></a:r></a:p>`;

/** 要点段：buChar "•" + 悬挂缩进。 */
const bulletPara = (t: string): string =>
  `<a:p><a:pPr marL="342900" indent="-342900"><a:buChar char="•"/></a:pPr><a:r><a:rPr sz="1800"/><a:t>${escapeXml(t)}</a:t></a:r></a:p>`;

// 版式几何（EMU）：封面标题垂直居中；内容页标题在顶、正文/表格在其下。
const TITLE_X = 838_200;
const BODY_Y = 1_737_360;
const BODY_CX = 10_477_500;

/** 表格行高（EMU，约 0.4"）——表头与数据行同高。 */
const ROW_H = 365_760;
/** 表头底纹（浅灰）+ 单元格边距——任何阅读器下都可读，不依赖表样式部件。 */
const TC_MARGINS = 'marL="45720" marR="45720" marT="27432" marB="27432"';

/** cell 四形 → a:tc。null/补齐 → 空段；number → String(n)；boolean → "true"/"false"。 */
function tableCell(cell: string | number | boolean | null, header: boolean): string {
  const run = cell === null ? "<a:p/>" : para(1200, typeof cell === "string" ? cell : typeof cell === "number" ? String(cell) : cell ? "true" : "false", undefined, header);
  const tcPr = header
    ? `<a:tcPr ${TC_MARGINS}><a:solidFill><a:srgbClr val="F2F2F2"/></a:solidFill></a:tcPr>`
    : `<a:tcPr ${TC_MARGINS}/>`;
  return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${run}</a:txBody>${tcPr}</a:tc>`;
}

/** 表格页 graphicFrame：a:tbl，gridCol 等分总宽，短行已由校验后补齐保证 tc 数=列数。 */
function tableFrame(id: number, columns: readonly { header: string }[], rows: readonly (readonly (string | number | boolean | null)[])[]): string {
  const n = columns.length;
  const w = Math.floor(BODY_CX / n);
  const grid = columns.map((_, i) => `<a:gridCol w="${i === n - 1 ? BODY_CX - w * (n - 1) : w}"/>`).join("");
  const headerRow = `<a:tr h="${ROW_H}">${columns.map((c) => tableCell(c.header, true)).join("")}</a:tr>`;
  // 短行补 null 到列数（校验放行短行；表格部件 tc 数与 gridCol 一致最干净）。
  const bodyRows = rows
    .map((row) => {
      const cells = [...row];
      while (cells.length < n) cells.push(null);
      return `<a:tr h="${ROW_H}">${cells.map((c) => tableCell(c, false)).join("")}</a:tr>`;
    })
    .join("");
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="${TITLE_X}" y="${BODY_Y}"/><a:ext cx="${BODY_CX}" cy="${ROW_H * (rows.length + 1)}"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${grid}</a:tblGrid>` +
    `${headerRow}${bodyRows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
  );
}

/** 一页 → slide XML（cSld + spTree + clrMapOvr；shape id 从 2 起）。
 *  ω99-223: #4 — export 缝：追加面（doc-pptx-append.ts 的 appendPptxSlides）
 *  复用同一页构造器造新页部件（追加页与新建页同源同版式；零行为变化，
 *  本文件其余面不动）。 */
export function slideXml(slide: DocSlide): string {
  let shapes: string;
  if (slide.kind === "cover") {
    // 封面：标题水平+垂直居中大字，副标题（可选）其下小字。
    shapes = textBox(2, "title", 914_400, 2_286_000, SLIDE_CX - 1_828_800, 1_828_800, '<a:bodyPr anchor="ctr"/>', para(4000, slide.title, "ctr"));
    if (slide.subtitle !== undefined) {
      shapes += textBox(3, "subtitle", 914_400, 4_114_800, SLIDE_CX - 1_828_800, 914_400, "<a:bodyPr/>", para(1600, slide.subtitle, "ctr"));
    }
  } else if (slide.kind === "bullets") {
    shapes = textBox(2, "title", TITLE_X, 365_760, BODY_CX, 1_097_280, "<a:bodyPr/>", para(2800, slide.title));
    shapes += textBox(3, "body", TITLE_X, BODY_Y, BODY_CX, 4_389_120, "<a:bodyPr/>", slide.bullets.map(bulletPara).join(""));
  } else {
    shapes = textBox(2, "title", TITLE_X, 365_760, BODY_CX, 1_097_280, "<a:bodyPr/>", para(2800, slide.title));
    shapes += tableFrame(3, slide.columns, slide.rows);
  }
  return (
    `${XML_DECL}<p:sld ${PPT_NS}><p:cSld><p:spTree>${GRP_SP_PR}${shapes}</p:spTree></p:cSld>` +
    "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"
  );
}

/** theme1：钉死的静态 minimal Office 主题模板串（常量，不含任何动内容；测试逐字钉）。 */
const THEME1_XML =
  '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="wudao">' +
  "<a:themeElements>" +
  '<a:clrScheme name="wudao">' +
  '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
  '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="44546A"/></a:dk2>' +
  '<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="4472C4"/></a:accent1>' +
  '<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>' +
  '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>' +
  '<a:accent4><a:srgbClr val="FFC000"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>' +
  '<a:accent6><a:srgbClr val="70AD47"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="0563C1"/></a:hlink>' +
  '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>' +
  "</a:clrScheme>" +
  '<a:fontScheme name="wudao">' +
  '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>' +
  "</a:fontScheme>" +
  '<a:fmtScheme name="wudao">' +
  "<a:fillStyleLst>" +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="67000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:tint val="81000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>' +
  '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="94000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>' +
  "</a:fillStyleLst>" +
  "<a:lnStyleLst>" +
  '<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>' +
  '<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>' +
  '<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>' +
  "</a:lnStyleLst>" +
  "<a:effectStyleLst>" +
  '<a:effectStyle><a:effectLst><a:outerShdw blurRad="40000" dist="20000" dir="5400000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="38000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle>' +
  '<a:effectStyle><a:effectLst><a:outerShdw blurRad="40000" dist="23000" dir="5400000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="35000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle>' +
  '<a:effectStyle><a:effectLst><a:outerShdw blurRad="40000" dist="23000" dir="5400000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="35000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle>' +
  "</a:effectStyleLst>" +
  "<a:bgFillStyleLst>" +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="63000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>' +
  '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:shade val="81000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="69000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>' +
  "</a:bgFillStyleLst>" +
  "</a:fmtScheme>" +
  "</a:themeElements>" +
  "<a:objectDefaults/>" +
  "<a:extraClrSchemeLst/>" +
  "</a:theme>";

/** slideMaster1：背景引用 + clrMap + 唯一 blank 版式 + 三段 txStyles（schema 要齐）。 */
const SLIDE_MASTER_XML =
  `${XML_DECL}<p:sldMaster ${PPT_NS}>` +
  '<p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>' +
  `<p:spTree>${GRP_SP_PR}</p:spTree></p:cSld>` +
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
  '<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4000"/></a:lvl1pPr></p:titleStyle>' +
  '<p:bodyStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle>' +
  '<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>';

/** slideLayout1：type="blank"（无占位符——版式全由每页自身的形状携带）。 */
const SLIDE_LAYOUT_XML =
  `${XML_DECL}<p:sldLayout ${PPT_NS} type="blank">` +
  `<p:cSld name="Blank"><p:spTree>${GRP_SP_PR}</p:spTree></p:cSld>` +
  "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>";

/** 组装整包：九件套（pptx 比 xlsx 多 master/layout/theme 三层）+ 每页 slide 及其 rels。
 *  纯函数：不碰时钟、不碰盘。条目顺序固定（严格读者 + 字节确定性）。 */
export function buildPptx(deck: DocDeck): Uint8Array {
  const enc = new TextEncoder();
  const n = deck.slides.length;
  const rels = (body: string): string =>
    `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
  const rel = (id: string, type: string, target: string): string =>
    `<Relationship Id="${id}" Type="${NS_R}/${type}" Target="${target}"/>`;

  const slideOverrides = deck.slides
    .map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`)
    .join("");
  const parts: { name: string; data: Uint8Array }[] = [
    {
      // 1. [Content_Types]：defaults + overrides（presentation/master/layout/theme/每页 + docProps）。
      name: "[Content_Types].xml",
      data: enc.encode(
        `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
          '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
          '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
          '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
          slideOverrides +
          '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
          '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
          "</Types>",
      ),
    },
    {
      // 2. 包根 rels → presentation + docProps。
      name: "_rels/.rels",
      data: enc.encode(
        rels(
          rel("rId1", "officeDocument", "ppt/presentation.xml") +
            rel("rId2", "metadata/core-properties", "docProps/core.xml") +
            rel("rId3", "extended-properties", "docProps/app.xml"),
        ),
      ),
    },
    {
      // 3a. docProps/core.xml —— 时间钉常量（同 123）。
      name: "docProps/core.xml",
      data: enc.encode(
        `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
          `<dc:creator>wudao</dc:creator><cp:lastModifiedBy>wudao</cp:lastModifiedBy>` +
          `<dcterms:created xsi:type="dcterms:W3CDTF">${DOC_CREATED}</dcterms:created>` +
          `<dcterms:modified xsi:type="dcterms:W3CDTF">${DOC_CREATED}</dcterms:modified>` +
          "</cp:coreProperties>",
      ),
    },
    {
      // 3b. docProps/app.xml。
      name: "docProps/app.xml",
      data: enc.encode(
        `${XML_DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>wudao-harness</Application></Properties>`,
      ),
    },
    {
      // 4. presentation：master 唯一；sldIdLst 页 id 从 256 起；sldSz 16:9；notesSz。
      name: "ppt/presentation.xml",
      data: enc.encode(
        `${XML_DECL}<p:presentation ${PPT_NS}>` +
          '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
          `<p:sldIdLst>${deck.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("")}</p:sldIdLst>` +
          `<p:sldSz cx="${SLIDE_CX}" cy="${SLIDE_CY}"/><p:notesSz cx="${SLIDE_CY}" cy="9144000"/>` +
          "</p:presentation>",
      ),
    },
    {
      // 5. presentation rels：master rId1 → 各页 rId2.. → theme 收尾。
      name: "ppt/_rels/presentation.xml.rels",
      data: enc.encode(
        rels(
          rel("rId1", "slideMaster", "slideMasters/slideMaster1.xml") +
            deck.slides.map((_, i) => rel(`rId${i + 2}`, "slide", `slides/slide${i + 1}.xml`)).join("") +
            rel(`rId${n + 2}`, "theme", "theme/theme1.xml"),
        ),
      ),
    },
    { name: "ppt/slideMasters/slideMaster1.xml", data: enc.encode(SLIDE_MASTER_XML) },
    {
      // 6b. master rels → layout + theme。
      name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      data: enc.encode(rels(rel("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml") + rel("rId2", "theme", "../theme/theme1.xml"))),
    },
    { name: "ppt/slideLayouts/slideLayout1.xml", data: enc.encode(SLIDE_LAYOUT_XML) },
    {
      // 7b. layout rels → master。
      name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      data: enc.encode(rels(rel("rId1", "slideMaster", "../slideMasters/slideMaster1.xml"))),
    },
    // 8. theme：钉死静态串（XML_DECL 前缀在写入时拼）。
    { name: "ppt/theme/theme1.xml", data: enc.encode(XML_DECL + THEME1_XML) },
    // 9. 每页 slide + rels（→ 唯一版式）。
    ...deck.slides.flatMap((slide, i): { name: string; data: Uint8Array }[] => [
      { name: `ppt/slides/slide${i + 1}.xml`, data: enc.encode(slideXml(slide)) },
      { name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: enc.encode(rels(rel("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"))) },
    ]),
  ];
  return storedZip(parts);
}

/** 缺省文件名：wudao-演示-YYYYMMDD-HHmmss.pptx（本地时区，pad 2）。纯。 */
export function defaultPptxFilename(now: Date): string {
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const d = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}`;
  const t = `${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  return `wudao-演示-${d}-${t}.pptx`;
}

// ---------------------------------------------------------------------------
// B — 工具面：make_pptx（123 createMakeXlsxTool 同款：buildTool + typed 拒 +
// 中文收据；单通道 filename——deck 内不携带路径字段，fix1 裁决继承）。
// ---------------------------------------------------------------------------

/** 把内容做成能双击打开的演示文稿放进工作区。顶级专属工具（tools.ts 固定钉位
 *  = make_xlsx 之后，children 天然不可见）；输出路径必经
 *  resolveWorkspacePath（外逃/绝对路径 typed 拒，fail-closed）；
 *  校验先于副作用：拒时零写盘。 */
export function createMakePptxTool(workspaceRoot: string): Tool {
  return buildTool({
    name: "make_pptx",
    promptSnippet: "create a new presentation (cover / bullets / table slides)",
    description:
      "把内容做成能直接用的演示文稿（.pptx）：封面 / 要点 / 表格三种页型，双击就能打开，存到工作区里，并把文件路径告诉用户。适合任何「帮我做个 PPT / 汇报几页 / 做个演示文稿」的请求。" +
      ` 参数 slides：页数组（1 到 ${PPTX_MAX_SLIDES} 页），每页是三种之一：封面页 {kind: "cover", title: "大标题", subtitle: "副标题（可选）"}；` +
      ` 要点页 {kind: "bullets", title: "页标题", bullets: ["要点 1", "要点 2", …]}（最多 ${PPTX_MAX_BULLETS} 条）；` +
      ` 表格页 {kind: "table", title: "页标题", columns: [{header: "列名"}, …], rows: [[单元格, …], …]}（最多 ${PPTX_MAX_COLUMNS} 列 × ${PPTX_MAX_ROWS} 行，单元格是字符串 / 数字 / 布尔 / null）。` +
      " 版式（16:9 版面、字号、居中、项目符号、表头加粗）自动排好，不用给样式。filename 可选：相对工作区的路径（可带子目录），.pptx 结尾可省，缺省自动按当前时间命名放在工作区根。",
    // 写盘（非只读）；只在本地文件系统（closed-world）。显式 filename 可覆盖
    // 既有文件 → destructive 诚实标注（make_xlsx 同款 posture）。
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    isOpenWorld: () => false,
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string", description: "演示文稿文件名（相对工作区，可带子目录）；.pptx 结尾可省；缺省自动按当前时间命名。" },
      },
      required: ["slides"],
      // slides 是嵌套对象数组——core 的参数类型只认 string|number|boolean|array
      // （123 §0.5 已证无 object），按 MCP 洗练 Doctrine（mcp/tools.ts
      // toMcpParameters）它不进 properties、走宽松的未知参数道：类型检查在
      // execute 里由 validateDocDeck 做（fail-closed typed 拒）。形状在
      // description 里文档化给模型。additionalProperties 因此保持开放。
    },
    async execute(args) {
      // 校验在副作用之前（typed 拒，零写盘）。顶层参数 slides 即页数组——
      // 包成 {slides} 再走 typed 校验。
      const checked = validateDocDeck({ slides: args["slides"] });
      if (!checked.ok) return { content: `make_pptx: ${checked.error}`, isError: true };
      const deck = checked.deck;

      // filename：单通道=顶层参数（123 fix1 裁决——deck 内不携带路径字段，
      // 杜绝嵌套绕门；slides 里携带的 filename 键按未知键忽略）；缺省=时间名。
      let explicit: string | undefined;
      const rawFilename = args["filename"];
      if (rawFilename !== undefined) {
        if (typeof rawFilename !== "string" || rawFilename.trim() === "") {
          return { content: 'make_pptx: "filename" must be a non-empty path relative to the workspace', isError: true };
        }
        explicit = rawFilename.trim();
      }
      const rel = explicit === undefined
        ? defaultPptxFilename(new Date())
        : explicit.toLowerCase().endsWith(".pptx") ? explicit : `${explicit}.pptx`;

      // 写盘前路径必经 resolveWorkspacePath（外逃/绝对路径/符号链接诡计拒）。
      const resolved = await resolveWorkspacePath(workspaceRoot, rel);
      if (!resolved.ok) return { content: `make_pptx: ${resolved.error}`, isError: true };

      const bytes = buildPptx(deck);
      try {
        await mkdir(dirname(resolved.absPath), { recursive: true });
        await writeFile(resolved.absPath, bytes);
      } catch (err) {
        return { content: `make_pptx: 写入失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
      }
      const kb = (bytes.byteLength / 1024).toFixed(1);
      return {
        // 收据=用户语：一句中文（路径/页数/大小）+ 结构化字段一行（前端/审计可解析）。
        content:
          `已生成演示文稿：${rel}（${deck.slides.length} 页，${kb} KB）\n` +
          JSON.stringify({
            path: resolved.absPath,
            relativePath: rel,
            slides: deck.slides.length,
            bytes: bytes.byteLength,
          }),
      };
    },
  });
}
