// ω99-126 — minimal docx 组装（零依赖纯层）。DocDoc（五 block 形）→ 一个能被
// Word/WPS 双击打开的 .docx 字节流：stored zip（doc-zip，123 缝第三次复用）
// + 五件部件。模型只给内容块，版式（A4、字号、居中、缩进、表头加粗+底纹）
// 本层全钉——不暴露样式旋钮（v1 版式模型，同 123/124）。
//
// 纪律（brief 钉）：
// - 校验（validateDocDoc）与组装（buildDocx）都是纯函数：不碰时钟（docProps
//   时间钉常量、DOS 时间由 doc-zip 钉）、不碰盘；字节确定性=同 doc 两次构建全等；
// - typed 拒优于静默剥：控制字符/非有限数字/坏 kind 直接拒（错误信息给模型
//   可自修的原因）；
// - 单通道 filename（123 fix1 裁决继承）：DocDoc 内不携带任何路径字段，写盘
//   目标只有 make_docx 的顶层 filename 参数；
// - styles 择定=案 (a) 全省略：document.xml 全部直接格式化（w:rPr/w:pPr/
//   w:tcPr/w:tblPr），零样式引用、零关系引用 → 零 styles.xml、零
//   word/_rels/document.xml.rels（择定依据=独立读者验真实产物，弧报告记录）；
// - cell 规与 doc-xlsx/doc-pptx 同款（对照测试钉两侧一致）；本层未改 123/124
//   文件，cell 检查本地实现，收/拒矩阵由 tests/omega99-126 逐值对照钉死。
import { storedZip } from "./doc-zip.js";
import { buildTool, resolveWorkspacePath } from "@wudao-org/core";
import type { Tool } from "@wudao-org/core";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** 文档标题块：居中大字（28pt 加粗）。 */
export interface DocTitleBlock {
  readonly kind: "title";
  readonly text: string;
}

/** 小节标题块：16pt 加粗。 */
export interface DocHeadingBlock {
  readonly kind: "heading";
  readonly text: string;
}

/** 正文段块：10.5pt。 */
export interface DocBodyBlock {
  readonly kind: "body";
  readonly text: string;
}

/** 列表项块：v1 = "• " 字符前缀 + 缩进（诚实非真列表——不引 numbering.xml）。 */
export interface DocBulletBlock {
  readonly kind: "bullet";
  readonly text: string;
}

/** 表格块：表头列 + 数据行（cell 四形同 xlsx/pptx）。 */
export interface DocTableBlock {
  readonly kind: "table";
  readonly columns: readonly { readonly header: string }[];
  readonly rows: readonly (readonly (string | number | boolean | null)[])[];
}

export type DocBlock = DocTitleBlock | DocHeadingBlock | DocBodyBlock | DocBulletBlock | DocTableBlock;

/** 一份文档：1..500 块。落盘文件名是 make_docx 的顶层 filename 参数（单通道）。 */
export interface DocDoc {
  readonly blocks: readonly DocBlock[];
}

export type DocDocCheck = { readonly ok: true; readonly doc: DocDoc } | { readonly ok: false; readonly error: string };

export const DOCX_MAX_BLOCKS = 500;
export const DOCX_MAX_COLUMNS = 64;
export const DOCX_MAX_ROWS = 5_000;
/** 控制字符：\x00-\x08、\x0B、\x0C、\x0E-\x1F（\t \n \r 放行）——XML 1.0 非法，一律拒。 */
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

/** typed 校验：五 block 形全查（纯函数，永不抛）。未知键忽略（同 123/124：policy 面不挖嵌套）。 */
export function validateDocDoc(raw: unknown): DocDocCheck {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "doc must be an object {blocks: [...]} (1-500 blocks)" };
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.blocks)) {
    return { ok: false, error: "doc.blocks must be an array of 1-500 blocks" };
  }
  if (r.blocks.length === 0) {
    return { ok: false, error: "doc.blocks must have at least one block" };
  }
  if (r.blocks.length > DOCX_MAX_BLOCKS) {
    return { ok: false, error: `doc.blocks is limited to ${DOCX_MAX_BLOCKS} blocks, got ${r.blocks.length}` };
  }

  const blocks: DocBlock[] = [];
  for (const [i, b] of r.blocks.entries()) {
    const at = `doc.blocks[${i}]`;
    if (typeof b !== "object" || b === null || Array.isArray(b)) {
      return { ok: false, error: `${at} must be an object with a kind ("title" | "heading" | "body" | "bullet" | "table")` };
    }
    const bl = b as Record<string, unknown>;
    if (typeof bl.kind !== "string") {
      return { ok: false, error: `${at}.kind must be one of "title", "heading", "body", "bullet", "table"` };
    }
    if (bl.kind === "table") {
      const t = tableCheck(at, bl);
      if ("error" in t) return { ok: false, error: t.error };
      blocks.push(t.block);
      continue;
    }
    // 文本四类同规：非空字符串 + 无控制字符（同入 XML 1.0——124 同款加强）。
    if (typeof bl.text !== "string" || bl.text.length === 0) {
      return { ok: false, error: `${at}.text must be a non-empty string` };
    }
    if (CONTROL_CHARS.test(bl.text)) {
      return { ok: false, error: `${at}.text contains a control character that cannot go into a document — remove it (tabs and line breaks are fine)` };
    }
    if (bl.kind === "title") blocks.push({ kind: "title", text: bl.text });
    else if (bl.kind === "heading") blocks.push({ kind: "heading", text: bl.text });
    else if (bl.kind === "body") blocks.push({ kind: "body", text: bl.text });
    else if (bl.kind === "bullet") blocks.push({ kind: "bullet", text: bl.text });
    else return { ok: false, error: `${at}.kind must be one of "title", "heading", "body", "bullet", "table" (got ${JSON.stringify(bl.kind)})` };
  }
  return { ok: true, doc: { blocks } };
}

/** 表格块校验（validateDocDoc 内部用；列/行/cell 矩阵同 xlsx/pptx 族）。 */
function tableCheck(at: string, bl: Record<string, unknown>): { block: DocTableBlock } | { error: string } {
  if (!Array.isArray(bl.columns)) {
    return { error: `${at}.columns must be an array of {header: string}` };
  }
  if (bl.columns.length === 0) {
    return { error: `${at}.columns must have at least one column (the header row)` };
  }
  if (bl.columns.length > DOCX_MAX_COLUMNS) {
    return { error: `${at}.columns is limited to ${DOCX_MAX_COLUMNS} columns, got ${bl.columns.length}` };
  }
  const columns: { header: string }[] = [];
  for (const [ci, c] of bl.columns.entries()) {
    if (typeof c !== "object" || c === null || Array.isArray(c)) {
      return { error: `${at}.columns[${ci}] must be an object {header: string}` };
    }
    const h = (c as Record<string, unknown>).header;
    if (typeof h !== "string" || h.length === 0) {
      return { error: `${at}.columns[${ci}].header must be a non-empty string` };
    }
    if (CONTROL_CHARS.test(h)) {
      return { error: `${at}.columns[${ci}].header contains a control character — remove it` };
    }
    columns.push({ header: h });
  }
  if (!Array.isArray(bl.rows)) {
    return { error: `${at}.rows must be an array of rows (each row an array of cells)` };
  }
  if (bl.rows.length > DOCX_MAX_ROWS) {
    return { error: `${at}.rows is limited to ${DOCX_MAX_ROWS} rows, got ${bl.rows.length}` };
  }
  const rows: (string | number | boolean | null)[][] = [];
  for (const [ri, row] of bl.rows.entries()) {
    if (!Array.isArray(row)) {
      return { error: `${at}.rows[${ri}] must be an array of cells (string | number | boolean | null)` };
    }
    if (row.length > columns.length) {
      return { error: `${at}.rows[${ri}] has ${row.length} cells but the table only has ${columns.length} columns` };
    }
    const cells: (string | number | boolean | null)[] = [];
    for (const cell of row) {
      if (cell === null) cells.push(null);
      else if (typeof cell === "string") {
        if (CONTROL_CHARS.test(cell)) {
          return { error: `${at}.rows[${ri}] contains a control character that cannot go into a table — remove it (tabs and line breaks are fine)` };
        }
        cells.push(cell);
      } else if (typeof cell === "number") {
        if (!Number.isFinite(cell)) {
          return { error: `${at}.rows[${ri}] must contain finite numbers (NaN/Infinity cannot go into a table)` };
        }
        cells.push(cell);
      } else if (typeof cell === "boolean") cells.push(cell);
      else return { error: `${at}.rows[${ri}] cells must be strings, numbers, booleans or null` };
    }
    rows.push(cells);
  }
  return { block: { kind: "table", columns, rows } };
}

// ---------------------------------------------------------------------------
// XML 部件组装（常量模板 + 块内容注入；docProps 时间钉常量=同 123/124）。
// 版式 v1 全钉：A4 纵向、字号、居中、缩进、表头加粗+底纹——模型零样式参数。
// ---------------------------------------------------------------------------

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
/** docProps 时间钉常量（确定性：绝不读时钟）。 */
const DOC_CREATED = "2026-01-01T00:00:00Z";
const NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/** 五实体转义（&amp; &lt; &gt; &quot; &apos;）——同 123/124 规，本地同款实现。 */
function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&apos;");
}

/** A4 纵向可用宽：11906 − 左右边距 1440×2 = 9026 twips（表格等分基准）。 */
const USABLE_W = 11_906 - 1_440 * 2;

/** 文本 run：字号（半点）+ 可选加粗。 */
const run = (t: string, sz: number, bold = false): string =>
  `<w:r><w:rPr>${bold ? "<w:b/>" : ""}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr><w:t xml:space="preserve">${escapeXml(t)}</w:t></w:r>`;

/** 表格边框：单线全套。styles 缺席（案 a）下这是唯一的边框通道——无它表格
 *  无可见线（Word 只画屏幕虚线网格，不打印）。124 自决 TC_MARGINS 同款精神。 */
const TBL_BORDERS =
  "<w:tblBorders>" +
  '<w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
  '<w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
  '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
  '<w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
  '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
  '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
  "</w:tblBorders>";

/** cell 四形 → w:tc。null/补齐 → 空 w:p（OOXML 硬规：tc 至少一个块级元素）；
 *  number → String(n)；boolean → "true"/"false"（124 先例：无类型 cell 的介质形）。
 *  表头 = 加粗 + 浅灰底纹（w:shd fill="F2F2F2"）。 */
function tableCell(cell: string | number | boolean | null, header: boolean): string {
  const p = cell === null
    ? "<w:p/>"
    : `<w:p>${run(typeof cell === "string" ? cell : typeof cell === "number" ? String(cell) : cell ? "true" : "false", 21, header)}</w:p>`;
  const tcPr = header ? '<w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:tcPr>' : "";
  return `<w:tc>${tcPr}${p}</w:tc>`;
}

/** 表格块 → w:tbl：gridCol 等分可用宽（尾列吃余数）；首行 w:tblHeader（跨页
 *  重复表头）+ 表头格式；短行补 null 到列数（tc 数=gridCol 数不变量）。 */
function tableXml(block: DocTableBlock): string {
  const n = block.columns.length;
  const w = Math.floor(USABLE_W / n);
  const grid = block.columns.map((_, i) => `<w:gridCol w:w="${i === n - 1 ? USABLE_W - w * (n - 1) : w}"/>`).join("");
  const headerRow = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${block.columns.map((c) => tableCell(c.header, true)).join("")}</w:tr>`;
  const bodyRows = block.rows
    .map((row) => {
      const cells = [...row];
      while (cells.length < n) cells.push(null);
      return `<w:tr>${cells.map((c) => tableCell(c, false)).join("")}</w:tr>`;
    })
    .join("");
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${TBL_BORDERS}<w:tblLayout w:type="fixed"/></w:tblPr>` +
    `<w:tblGrid>${grid}</w:tblGrid>${headerRow}${bodyRows}</w:tbl>`
  );
}

/** 一块 → body XML。title=居中 28pt 加粗；heading=16pt 加粗；body=10.5pt；
 *  bullet="• " 前缀 + 360 twips 缩进（v1 非真列表）。
 *  ω99-223: #3 — export 缝：追加面（doc-docx-append.ts 的 appendDocxBlocks）
 *  复用同一块构造器拼新内容尾部（追加块与新建块同源同版式；零行为变化，
 *  本文件其余面不动）。 */
export function blockXml(block: DocBlock): string {
  switch (block.kind) {
    case "title":
      return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${run(block.text, 56, true)}</w:p>`;
    case "heading":
      return `<w:p>${run(block.text, 32, true)}</w:p>`;
    case "body":
      return `<w:p>${run(block.text, 21)}</w:p>`;
    case "bullet":
      return `<w:p><w:pPr><w:ind w:left="360"/></w:pPr>${run(`• ${block.text}`, 21)}</w:p>`;
    case "table":
      return tableXml(block);
  }
}

/** 组装整包：五部件（styles 案 (a)：零样式引用 → 零 styles.xml、零
 *  word/_rels/document.xml.rels）。纯函数：不碰时钟、不碰盘。条目顺序固定
 *  （严格读者 + 字节确定性）。sectPr=A4 纵向 + 1440 twips 四边。 */
export function buildDocx(doc: DocDoc): Uint8Array {
  const enc = new TextEncoder();
  const body = doc.blocks.map(blockXml).join("");
  const parts: { name: string; data: Uint8Array }[] = [
    {
      // 1. [Content_Types]：defaults + overrides（document + docProps 两件）。
      name: "[Content_Types].xml",
      data: enc.encode(
        `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
          '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
          "</Types>",
      ),
    },
    {
      // 2. 包根 rels → document + docProps。
      name: "_rels/.rels",
      data: enc.encode(
        `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
          '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" Target="docProps/core.xml"/>' +
          '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
          "</Relationships>",
      ),
    },
    {
      // 3a. docProps/core.xml —— 时间钉常量（同 123/124）。
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
      // 4. word/document.xml：body 块 + sectPr（A4 纵向 + 1 英寸四边）。
      name: "word/document.xml",
      data: enc.encode(
        `${XML_DECL}<w:document xmlns:w="${NS_W}"><w:body>${body}` +
          '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>' +
          "</w:body></w:document>",
      ),
    },
  ];
  return storedZip(parts);
}

/** 缺省文件名：wudao-文档-YYYYMMDD-HHmmss.docx（本地时区，pad 2）。纯。 */
export function defaultDocxFilename(now: Date): string {
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const d = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}`;
  const t = `${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  return `wudao-文档-${d}-${t}.docx`;
}

// ---------------------------------------------------------------------------
// B — 工具面：make_docx（123/124 同款：buildTool + typed 拒 + 中文收据；
// 单通道 filename——doc 内不携带路径字段，fix1 裁决继承）。
// ---------------------------------------------------------------------------

/** 把内容写成能双击打开的 Word 文档放进工作区。顶级专属工具（tools.ts 固定
 *  钉位=make_pptx 之后，children 天然不可见）；输出路径必经
 *  resolveWorkspacePath（外逃/绝对路径 typed 拒，fail-closed）；
 *  校验先于副作用：拒时零写盘。 */
export function createMakeDocxTool(workspaceRoot: string): Tool {
  return buildTool({
    name: "make_docx",
    promptSnippet: "create a new Word document from content",
    description:
      "把内容写成能直接用的 Word 文档（.docx）：标题、小节、正文、列表、表格，双击就能打开，存到工作区里，并把文件路径告诉用户。适合任何「帮我写份文档 / 写份报告 / 整理成 Word 文件」的请求。" +
      ` 参数 blocks：内容块数组（1 到 ${DOCX_MAX_BLOCKS} 块），每块是五种之一：标题 {kind: "title", text: "文档大标题"}；` +
      ` 小节 {kind: "heading", text: "小节标题"}；正文 {kind: "body", text: "一段正文"}；` +
      ` 列表项 {kind: "bullet", text: "一条要点"}；` +
      ` 表格 {kind: "table", columns: [{header: "列名"}, …], rows: [[单元格, …], …]}（最多 ${DOCX_MAX_COLUMNS} 列 × ${DOCX_MAX_ROWS} 行，单元格是字符串 / 数字 / 布尔 / null）。` +
      " 版式（A4 纸型、字号、标题居中、表头加粗底纹）自动排好，不用给样式。filename 可选：相对工作区的路径（可带子目录），.docx 结尾可省，缺省自动按当前时间命名放在工作区根。",
    // 写盘（非只读）；只在本地文件系统（closed-world）。显式 filename 可覆盖
    // 既有文件 → destructive 诚实标注（make_xlsx/make_pptx 同款 posture）。
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    isOpenWorld: () => false,
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string", description: "文档文件名（相对工作区，可带子目录）；.docx 结尾可省；缺省自动按当前时间命名。" },
      },
      required: ["blocks"],
      // blocks 是嵌套对象数组——core 的参数类型只认 string|number|boolean|array
      // （123 §0.5 已证无 object），按 MCP 洗练 Doctrine（mcp/tools.ts
      // toMcpParameters）它不进 properties、走宽松的未知参数道：类型检查在
      // execute 里由 validateDocDoc 做（fail-closed typed 拒）。形状在
      // description 里文档化给模型。additionalProperties 因此保持开放。
    },
    async execute(args) {
      // 校验在副作用之前（typed 拒，零写盘）。顶层参数 blocks 即块数组——
      // 包成 {blocks} 再走 typed 校验。
      const checked = validateDocDoc({ blocks: args["blocks"] });
      if (!checked.ok) return { content: `make_docx: ${checked.error}`, isError: true };
      const doc = checked.doc;

      // filename：单通道=顶层参数（123 fix1 裁决——doc 内不携带路径字段，
      // 杜绝嵌套绕门；blocks 里携带的 filename 键按未知键忽略）；缺省=时间名。
      let explicit: string | undefined;
      const rawFilename = args["filename"];
      if (rawFilename !== undefined) {
        if (typeof rawFilename !== "string" || rawFilename.trim() === "") {
          return { content: 'make_docx: "filename" must be a non-empty path relative to the workspace', isError: true };
        }
        explicit = rawFilename.trim();
      }
      const rel = explicit === undefined
        ? defaultDocxFilename(new Date())
        : explicit.toLowerCase().endsWith(".docx") ? explicit : `${explicit}.docx`;

      // 写盘前路径必经 resolveWorkspacePath（外逃/绝对路径/符号链接诡计拒）。
      const resolved = await resolveWorkspacePath(workspaceRoot, rel);
      if (!resolved.ok) return { content: `make_docx: ${resolved.error}`, isError: true };

      const bytes = buildDocx(doc);
      try {
        await mkdir(dirname(resolved.absPath), { recursive: true });
        await writeFile(resolved.absPath, bytes);
      } catch (err) {
        return { content: `make_docx: 写入失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
      }
      const kb = (bytes.byteLength / 1024).toFixed(1);
      return {
        // 收据=用户语：一句中文（路径/块数/大小）+ 结构化字段一行（前端/审计可解析）。
        content:
          `已生成文档：${rel}（${doc.blocks.length} 块，${kb} KB）\n` +
          JSON.stringify({
            path: resolved.absPath,
            relativePath: rel,
            blocks: doc.blocks.length,
            bytes: bytes.byteLength,
          }),
      };
    },
  });
}
