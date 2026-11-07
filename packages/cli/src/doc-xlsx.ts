// ω99-123 — minimal xlsx 组装（零依赖纯层）。DocTable（列+行）→ 一个能被
// Excel/Numbers/WPS 双击打开的 .xlsx 字节流：stored zip（doc-zip）+ 八个
// XML 部件。模型只给内容，版式（表头加粗/列宽）本层负责——不暴露样式参数
// （越少不可控参数越好）。124 pptx 复用 doc-zip 缝。
// ω99-221: #7 — xlsx 域自此不再是只写：读面（read_xlsx——把现有 .xlsx 读
// 成表文本进上下文）在 doc-xlsx-read.ts（解压/工作簿/行三层纯层 + 工具
// 面）；本文件保持写面原样，两半在 tools.ts 相邻挂载、互不 import。
//
// 纪律（brief 钉）：
// - 校验（validateDocTable）与组装（buildXlsx）都是纯函数：不碰时钟（docProps
//   时间钉常量）、不碰盘；字节确定性=同表两次构建全等；
// - typed 拒优于静默剥：控制字符/非有限数字/坏 sheet 名直接拒（错误信息给
//   模型可自修的原因）；唯一例外=列宽越界钳到 8..80（宽是排版非数据）；
// - cell 四形：string→inlineStr、number→<v>、boolean→t="b"、null→整 cell
//   省略（保 r 引用跳号正确）。
import { buildTool, resolveWorkspacePath } from "@wudao-org/core";
import type { Tool } from "@wudao-org/core";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { storedZip } from "./doc-zip.js";

/** 一列：表头文字 + 可选列宽（Excel 字符宽；越界钳 8..80）。 */
export interface DocColumn {
  readonly header: string;
  readonly width?: number;
}

/** 一张表：sheetName 可选；columns 表头；rows 数据行。落盘文件名是
 *  make_xlsx 的顶层 filename 参数（单通道）——表内不携带路径
 *  （fix1 裁决：嵌套通道零用户价值、纯绕风险，砍）。 */
export interface DocTable {
  readonly sheetName?: string;
  readonly columns: readonly DocColumn[];
  readonly rows: readonly (readonly (string | number | boolean | null)[])[];
}

export type DocTableCheck = { readonly ok: true; readonly table: DocTable } | { readonly ok: false; readonly error: string };

export const DOC_MAX_COLUMNS = 64;
export const DOC_MAX_ROWS = 5_000;
export const DOC_SHEET_NAME_MAX = 31;
export const DOC_DEFAULT_SHEET_NAME = "Sheet1";
/** ω99-133 — sheets 通道上限：周报/盘点类「一张文件多张表」8 张绰绰有余，
 * 且把 workbook/rels/部件数钉死在常数内（校验先于写盘，fail-closed）。 */
export const DOC_MAX_SHEETS = 8;
const WIDTH_MIN = 8;
const WIDTH_MAX = 80;
/** Excel sheet 名非法字符（brief 钉）。 */
const BAD_SHEET_CHARS = /[\[\]:*?/\\]/;
/** 控制字符：\x00-\x08、\x0B、\x0C、\x0E-\x1F（\t \n \r 放行）。 */
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

/** typed 校验：形状/矩阵全查，宽越界钳 8..80。纯函数，永不抛。 */
export function validateDocTable(raw: unknown): DocTableCheck {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "table must be an object {sheetName?, filename?, columns, rows}" };
  }
  const r = raw as Record<string, unknown>;

  let sheetName: string | undefined;
  if (r.sheetName !== undefined) {
    if (typeof r.sheetName !== "string" || r.sheetName.length === 0) {
      return { ok: false, error: "table.sheetName must be a non-empty string" };
    }
    if (r.sheetName.length > DOC_SHEET_NAME_MAX) {
      return { ok: false, error: `table.sheetName is limited to ${DOC_SHEET_NAME_MAX} characters (Excel sheet-name limit), got ${r.sheetName.length}` };
    }
    if (BAD_SHEET_CHARS.test(r.sheetName)) {
      return { ok: false, error: `table.sheetName must not contain any of [ ] : * ? / \\ (Excel sheet-name rules), got ${JSON.stringify(r.sheetName)}` };
    }
    sheetName = r.sheetName;
  }

  // fix1 裁决：无 filename 字段——写盘通道只有 make_xlsx 的顶层参数。
  // 表内携带的 filename 键按未知键忽略（policy 面只读顶层键，不挖嵌套）。

  if (!Array.isArray(r.columns)) {
    return { ok: false, error: "table.columns must be an array of {header: string, width?: number}" };
  }
  if (r.columns.length === 0) {
    return { ok: false, error: "table.columns must have at least one column (the header row)" };
  }
  if (r.columns.length > DOC_MAX_COLUMNS) {
    return { ok: false, error: `table.columns is limited to ${DOC_MAX_COLUMNS} columns, got ${r.columns.length}` };
  }
  const columns: DocColumn[] = [];
  for (const [i, c] of r.columns.entries()) {
    if (typeof c !== "object" || c === null || Array.isArray(c)) {
      return { ok: false, error: `table.columns[${i}] must be an object {header: string, width?: number}` };
    }
    const col = c as Record<string, unknown>;
    if (typeof col.header !== "string" || col.header.length === 0) {
      return { ok: false, error: `table.columns[${i}].header must be a non-empty string` };
    }
    let width: number | undefined;
    if (col.width !== undefined) {
      if (typeof col.width !== "number" || !Number.isFinite(col.width)) {
        return { ok: false, error: `table.columns[${i}].width must be a finite number (column width in Excel character units)` };
      }
      width = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, col.width));
    }
    columns.push(width === undefined ? { header: col.header } : { header: col.header, width });
  }

  if (!Array.isArray(r.rows)) {
    return { ok: false, error: "table.rows must be an array of rows (each row an array of cells)" };
  }
  if (r.rows.length > DOC_MAX_ROWS) {
    return { ok: false, error: `table.rows is limited to ${DOC_MAX_ROWS} rows, got ${r.rows.length}` };
  }
  const rows: (string | number | boolean | null)[][] = [];
  for (const [ri, row] of r.rows.entries()) {
    if (!Array.isArray(row)) {
      return { ok: false, error: `table.rows[${ri}] must be an array of cells (string | number | boolean | null)` };
    }
    const cells: (string | number | boolean | null)[] = [];
    for (const [ci, cell] of row.entries()) {
      const at = `table.rows[${ri}][${ci}]`;
      if (cell === null) cells.push(null);
      else if (typeof cell === "string") {
        if (CONTROL_CHARS.test(cell)) {
          return { ok: false, error: `${at} contains a control character Excel cannot store — remove it (tabs and line breaks are fine)` };
        }
        cells.push(cell);
      } else if (typeof cell === "number") {
        if (!Number.isFinite(cell)) {
          return { ok: false, error: `${at} must be a finite number (NaN/Infinity cannot go into a cell)` };
        }
        cells.push(cell);
      } else if (typeof cell === "boolean") cells.push(cell);
      else return { ok: false, error: `${at} must be a string, number, boolean or null` };
    }
    rows.push(cells);
  }

  const table: DocTable = {
    ...(sheetName !== undefined ? { sheetName } : {}),
    columns,
    rows,
  };
  return { ok: true, table };
}

export type DocSheetsCheck =
  | { readonly ok: true; readonly tables: readonly DocTable[] }
  | { readonly ok: false; readonly error: string };

/** ω99-133 — sheets 通道校验：逐元素复用 validateDocTable（含各自可选
 * sheetName，不另造一套），外加三道面检（非数组/空/超 DOC_MAX_SHEETS）与
 * 有效名去重（effective name = sheetName ?? 缺省名，两个未命名同落缺省名
 * 也算重——fail-closed，模型自己改名）。纯函数，永不抛。 */
export function validateDocSheets(raw: unknown): DocSheetsCheck {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "sheets must be an array of tables [{sheetName?, columns, rows}, …]" };
  }
  if (raw.length === 0) {
    return { ok: false, error: "sheets must have at least one table (an empty workbook has no sheet)" };
  }
  if (raw.length > DOC_MAX_SHEETS) {
    return { ok: false, error: `sheets is limited to ${DOC_MAX_SHEETS} tables, got ${raw.length}` };
  }
  const tables: DocTable[] = [];
  for (const [i, el] of raw.entries()) {
    const checked = validateDocTable(el);
    if (!checked.ok) return { ok: false, error: `sheets[${i}]: ${checked.error}` };
    tables.push(checked.table);
  }
  const seen = new Set<string>();
  for (const [i, t] of tables.entries()) {
    const name = t.sheetName ?? DOC_DEFAULT_SHEET_NAME;
    if (seen.has(name)) {
      return {
        ok: false,
        error: `sheets[${i}]: each sheet needs a distinct sheetName — "${name}" is used more than once (rename one of them)`,
      };
    }
    seen.add(name);
  }
  return { ok: true, tables };
}

// ---------------------------------------------------------------------------
// XML 部件组装（全部常量模板 + 表内容注入；docProps 时间钉常量）。
// ---------------------------------------------------------------------------

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
/** docProps 时间钉常量（确定性：绝不读时钟）。 */
const DOC_CREATED = "2026-01-01T00:00:00Z";

/** 五实体转义（&amp; &lt; &gt; &quot; &apos;）——brief 钉。 */
function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&apos;");
}

/** 0 基列号 → Excel 列字母（0→A，25→Z，26→AA；≤64 列 → 至多 BL）。 */
function columnLetter(i: number): string {
  let s = "";
  let n = i;
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

function sheetXml(table: DocTable): string {
  const colEls: string[] = [];
  table.columns.forEach((c, i) => {
    if (c.width !== undefined) {
      colEls.push(`<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`);
    }
  });
  // 首行 = 表头（s="1" = cellXfs[1]，加粗）；其余行 s 省略（默认 xf0）。
  const header = table.columns
    .map((c, i) => `<c r="${columnLetter(i)}1" s="1" t="inlineStr"><is><t xml:space="preserve">${escapeXml(c.header)}</t></is></c>`)
    .join("");
  const rowEls: string[] = [`<row r="1">${header}</row>`];
  table.rows.forEach((row, ri) => {
    const rn = ri + 2;
    const cells = row
      .map((cell, ci) => {
        if (cell === null) return ""; // 整 cell 省略——后续列的 r 引用仍按列号生成，跳号正确。
        const ref = `${columnLetter(ci)}${rn}`;
        if (typeof cell === "string") {
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell)}</t></is></c>`;
        }
        if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`;
        return `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`;
      })
      .join("");
    rowEls.push(`<row r="${rn}">${cells}</row>`);
  });
  return (
    `${XML_DECL}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0"/></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="18"/>` +
    (colEls.length > 0 ? `<cols>${colEls.join("")}</cols>` : "") +
    `<sheetData>${rowEls.join("")}</sheetData>` +
    `</worksheet>`
  );
}

/** 组装整包：八个部件起步（严格读者保险：core/app 必含），N 张表=N 个
 * worksheet 部件与对应 Override/rels 条目。纯函数。ω99-133 — 泛化为单表|
 * 多表同缝：所有 N 相关字面量按 i+1 生成，N=1 时逐字节退化为改前的单表
 * 输出（123 三件测试零改动全绿=零漂移证）。 */
export function buildXlsx(input: DocTable | readonly DocTable[]): Uint8Array {
  // ω99-133：单表入参包成 1 元数组走同一条组装路（N=1 即原字面量）。
  const tables: readonly DocTable[] = Array.isArray(input) ? input : [input];
  const enc = new TextEncoder();
  // ω99-133：每张 sheet 一条 worksheet Override（N=1=原单条字面量，位置不变）。
  const sheetOverrides = tables
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join("");
  const parts: { name: string; data: Uint8Array }[] = [
    {
      name: "[Content_Types].xml",
      data: enc.encode(
        `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
          sheetOverrides +
          `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
          `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
          `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
          `</Types>`,
      ),
    },
    {
      name: "_rels/.rels",
      data: enc.encode(
        `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
          `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
          `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>` +
          `</Relationships>`,
      ),
    },
    {
      name: "docProps/core.xml",
      data: enc.encode(
        `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
          `<dc:creator>wudao</dc:creator><cp:lastModifiedBy>wudao</cp:lastModifiedBy>` +
          `<dcterms:created xsi:type="dcterms:W3CDTF">${DOC_CREATED}</dcterms:created>` +
          `<dcterms:modified xsi:type="dcterms:W3CDTF">${DOC_CREATED}</dcterms:modified>` +
          `</cp:coreProperties>`,
      ),
    },
    {
      name: "docProps/app.xml",
      data: enc.encode(
        `${XML_DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>wudao-harness</Application></Properties>`,
      ),
    },
    {
      name: "xl/workbook.xml",
      data: enc.encode(
        `${XML_DECL}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
          // ω99-133：sheetId/r:id 按位序 1..N（Excel 要求唯一；N=1=原字面量）。
          `<sheets>${tables
            .map(
              (t, i) =>
                `<sheet name="${escapeXml(t.sheetName ?? DOC_DEFAULT_SHEET_NAME)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
            )
            .join("")}</sheets></workbook>`,
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: enc.encode(
        `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          // ω99-133：rId1..rIdN=worksheets，styles 顺延 rId{N+1}（N=1=rId2=原字面量）。
          `${tables
            .map(
              (_, i) =>
                `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
            )
            .join("")}` +
          `<Relationship Id="rId${tables.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
          `</Relationships>`,
      ),
    },
    {
      name: "xl/styles.xml",
      data: enc.encode(
        `${XML_DECL}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
          `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
          // fills 次序 [none, gray125] 是规格要求（Excel 拒绝颠倒的次序）。
          `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
          `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
          `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
          `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>` +
          `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
          `</styleSheet>`,
      ),
    },
    // ω99-133：N 张 worksheet 部件按序 sheet1..sheetN（单表=sheet1 原位，零漂移）。
    ...tables.map((t, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(sheetXml(t)) })),
  ];
  return storedZip(parts);
}

/** 缺省文件名：wudao-表格-YYYYMMDD-HHmmss.xlsx（本地时区，pad 2）。纯。 */
export function defaultXlsxFilename(now: Date): string {
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const d = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}`;
  const t = `${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  return `wudao-表格-${d}-${t}.xlsx`;
}

// ---------------------------------------------------------------------------
// B — 工具面：make_xlsx（watch.ts 范本：buildTool + typed 拒 + 中文收据）。
// ---------------------------------------------------------------------------

/** 造一个真正的 Excel 文件放进工作区。顶级专属工具（tools.ts 固定钉位，
 *  children 天然不可见）；输出路径必经 resolveWorkspacePath（外逃/绝对
 *  路径 typed 拒，fail-closed）。校验先于副作用：拒时零写盘。 */
export function createMakeXlsxTool(workspaceRoot: string): Tool {
  return buildTool({
    name: "make_xlsx",
    promptSnippet: "create a new Excel workbook from rows",
    description:
      "把清单、盘点结果、数据整理成真正的 Excel 文件（.xlsx，表头加粗、列宽合适），存到工作区里，并把文件路径告诉用户。适合任何「做成表格 / 整理成 Excel / 导出清单」的请求。" +
      ` 参数 table：{columns: [{header: "列名", width: 列宽数字}, …], rows: [[单元格, …], …]}（最多 ${DOC_MAX_COLUMNS} 列 × ${DOC_MAX_ROWS} 行，单元格是字符串 / 数字 / 布尔 / null；可选 sheetName 给工作表命名）。` +
      ` 参数 sheets：多张工作表时改传数组 [{sheetName?, columns, rows}, …]（最多 ${DOC_MAX_SHEETS} 张，名字不得重复）——周报/盘点一张文件多张表用它。` +
      " filename 可选：相对工作区的路径（可带子目录），.xlsx 结尾可省，缺省自动按当前时间命名放在工作区根。",
    // 写盘（非只读）；只在本地文件系统（closed-world）。显式 filename 可覆盖
    // 既有文件 → destructive 诚实标注（write_file 同款 posture）。
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    isOpenWorld: () => false,
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Excel 文件名（相对工作区，可带子目录）；.xlsx 结尾可省；缺省自动按当前时间命名。" },
      },
      // ω99-133 — table/sheets 二选一：required 硬钉 table 会把 sheets-only
      // 调用拦在 schema 面（loop 的 validateToolArguments 只查 key 存在），
      // 故去 required，二选一与形状全在 execute 里 typed 拒（都不给=沿用
      // validateDocTable 的现有拒；都给=「use either table or sheets」）。
      // table/sheets 是嵌套对象（数组）——core 的参数类型只认
      // string|number|boolean|array，按 MCP 洗练 Doctrine（mcp/tools.ts
      // toMcpParameters）它们不进 properties、走宽松的未知参数道：类型检查在
      // execute 里由 validateDocTable / validateDocSheets 做（fail-closed
      // typed 拒）。additionalProperties 因此保持开放。
    },
    async execute(args) {
      // 校验在副作用之前（typed 拒，零写盘）。ω99-133 — table/sheets 二选一：
      // 都给=互斥拒；都不给=落 table 通道、validateDocTable 对 undefined 的
      // 现有拒（零漂移）；sheets 通道逐元素复用 validateDocTable + 去重。
      const hasTable = args["table"] !== undefined;
      const hasSheets = args["sheets"] !== undefined;
      if (hasTable && hasSheets) {
        return { content: "make_xlsx: use either table or sheets, not both (sheets is the array form for multiple worksheets)", isError: true };
      }
      let viaSheets: boolean;
      let tables: readonly DocTable[];
      if (hasSheets) {
        const checked = validateDocSheets(args["sheets"]);
        if (!checked.ok) return { content: `make_xlsx: ${checked.error}`, isError: true };
        viaSheets = true;
        tables = checked.tables;
      } else {
        const checked = validateDocTable(args["table"]);
        if (!checked.ok) return { content: `make_xlsx: ${checked.error}`, isError: true };
        viaSheets = false;
        tables = [checked.table];
      }
      const table = tables[0]!; // table 通道的表（sheets 通道收据不走它）

      // filename：单通道=顶层参数（fix1 裁决——表内不携带，杜绝嵌套绕门）；
      // 缺省=时间名（工作区根）。
      let explicit: string | undefined;
      const rawFilename = args["filename"];
      if (rawFilename !== undefined) {
        if (typeof rawFilename !== "string" || rawFilename.trim() === "") {
          return { content: 'make_xlsx: "filename" must be a non-empty path relative to the workspace', isError: true };
        }
        explicit = rawFilename.trim();
      }
      const rel = explicit === undefined
        ? defaultXlsxFilename(new Date())
        : explicit.toLowerCase().endsWith(".xlsx") ? explicit : `${explicit}.xlsx`;

      // 写盘前路径必经 resolveWorkspacePath（外逃/绝对路径/符号链接诡计拒）。
      const resolved = await resolveWorkspacePath(workspaceRoot, rel);
      if (!resolved.ok) return { content: `make_xlsx: ${resolved.error}`, isError: true };

      // ω99-133 — table 通道传单表（逐字节=改前调用形状）；sheets 通道传数组。
      const bytes = viaSheets ? buildXlsx(tables) : buildXlsx(table);
      try {
        await mkdir(dirname(resolved.absPath), { recursive: true });
        await writeFile(resolved.absPath, bytes);
      } catch (err) {
        return { content: `make_xlsx: 写入失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
      }
      const kb = (bytes.byteLength / 1024).toFixed(1);
      if (viaSheets) {
        // ω99-133 — 多表收据：名字列表恰取前 3 个、多则尾缀「…等N张」；中文句
        // 无 {（131：TUI 按首个 { 切中文句）。JSON 末行增 sheets/总行数——
        // 提取器只读 path/relativePath/bytes，多余键忽略，不受影响。
        const names = tables.map((t) => t.sheetName ?? DOC_DEFAULT_SHEET_NAME);
        const shown = names.slice(0, 3).join("/");
        const namesPart = names.length > 3 ? `${shown}…等${names.length}张` : shown;
        const totalRows = tables.reduce((n, t) => n + t.rows.length, 0);
        return {
          content:
            `已生成 Excel：${rel}（${names.length} 张工作表：${namesPart}，${kb} KB）\n` +
            JSON.stringify({
              path: resolved.absPath,
              relativePath: rel,
              sheets: names.length,
              rows: totalRows,
              bytes: bytes.byteLength,
            }),
        };
      }
      return {
        // 收据=用户语：一句中文（路径/行列/大小）+ 结构化字段一行（前端/审计可解析）。
        content:
          `已生成 Excel：${rel}（${table.rows.length} 行 × ${table.columns.length} 列，${kb} KB）\n` +
          JSON.stringify({
            path: resolved.absPath,
            relativePath: rel,
            rows: table.rows.length,
            columns: table.columns.length,
            bytes: bytes.byteLength,
          }),
      };
    },
  });
}


