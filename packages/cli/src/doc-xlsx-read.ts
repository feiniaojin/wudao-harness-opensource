// ω99-221: #1 — xlsx 读面纯层（零依赖）。.xlsx 是 zip 包：尾部 EOCD 扫描 →
// 中央目录取条目名/压缩法/数据偏移 → local header 跳头 → method 0 直取 /
// method 8 inflateRawSync（node:zlib 内建——全仓首个 zlib import，无新第三
// 方）。加密旗（general purpose bit 0）与 Zip64 标记（0xFFFF/0xFFFFFFFF）
// 诚实拒。之上是工作簿结构：workbook.xml 的 <sheet> 名序 + workbook.xml.rels
// 的 r:id→target 映射（**不得假设 sheetN.xml 编号=顺序**——Excel 只保证
// workbook 里的 <sheet> 次序，部件文件名任意）+ sharedStrings 共享串表。
// 再上是行解析：c 的 r 引用（A1→列号）/t 类型（s 共享串、inlineStr、b 布
// 尔、e 错误、无 t 数字）/稀疏格/富文本 <r><t> 拼接/XML 实体解码。
//
// 纪律（brief 钉）：
// - 纯层全部纯函数：不碰时钟、不碰盘（盘只在工具面 execute 里 readFile）；
// - typed 拒优于静默剥：坏 zip/加密/Zip64/缺部件/坏参数直接拒，错误信息
//   给模型可自修的原因（用户语，零 zip/XML/EOCD 实现术语——技术词只在本
//   注释层）；
// - 数字照原样字符串显示（<v>123456789012345678</v> 原样进网格——绝不
//   parseFloat 再 toString，浮点漂移是静默数据损坏）；
// - read 夹具反哺：本层与 doc-zip 写器同源互测（storedZip 造夹具、
//   deflateRawSync 造压缩道夹具）。
import { buildTool, resolveWorkspacePath } from "@wudao-org/core";
import type { Tool } from "@wudao-org/core";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
// ω99-222: #2 — zip 解压层搬家后的连续缝：unzipEntries/ZipEntry/UnzipCheck
// 的家自本文件移到 doc-zip.ts（zip 域共享地——docx/pptx 读面 222 复用）。
// 顶部 re-export 保 221 的 import 连续（221 R1 从 doc-xlsx-read.js import
// unzipEntries，行为零漂移——R1 §1 钉 re-export 同一函数）；本文件内部
// 用同一条 import 缝，零循环（doc-zip 不依赖本文件）。
import { unzipEntries } from "./doc-zip.js";
export { unzipEntries } from "./doc-zip.js";
export type { ZipEntry, UnzipCheck } from "./doc-zip.js";

// ---------------------------------------------------------------------------
// B — 工作簿结构纯层（sheet 名序 + rels 映射 + sharedStrings）。
// ---------------------------------------------------------------------------

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** XML 实体解码：五个命名实体 + 十进制/十六进制数字实体（单趟替换，不双解）。 */
function decodeXmlEntities(s: string): string {
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

/** 从一个起始标签文本里取属性值（属性序无关；单双引号都认；实体解码）。 */
function attrValue(tag: string, name: string): string | undefined {
  const m =
    new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(tag) ??
    new RegExp(`${name}\\s*=\\s*'([^']*)'`).exec(tag);
  return m?.[1] !== undefined ? decodeXmlEntities(m[1]) : undefined;
}

/** 富文本块（<si> 或 <is>）里的全部 <t> 文本拼接：直下 <t> 与 <r><t> 逐段
 *  都收；先剥 <rPh>（音注假名——CJK 文件里会出现的拼音注音，不是数据）。 */
function collectTextRuns(block: string): string {
  const cleaned = block.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "";
  for (const m of cleaned.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) {
    out += decodeXmlEntities(m[1] ?? "");
  }
  return out;
}

/** sharedStrings.xml 部件 → 共享串数组（索引即 <si> 次序）。纯。 */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
    out.push(collectTextRuns(m[1] ?? ""));
  }
  return out;
}

/** A1 列字母 → 0 基列号（A→0、Z→25、AA→26）。引用无字母部分 → undefined。 */
function columnIndexFromRef(ref: string): number | undefined {
  const m = /^\$?([A-Za-z]+)\$?\d+/.exec(ref.trim());
  if (m === null) return undefined;
  let n = 0;
  for (const ch of m[1]!) {
    n = n * 26 + (ch.charCodeAt(0) & 0x1f); // A/a→1 … Z/z→26
  }
  return n - 1;
}

/** 一张表的解析产物：rowCount=最大行号（Excel 口径的「共 N 行」），
 *  columnCount=最大列号（1 起）；rows[r-1][c-1] 统一宽 columnCount，
 *  null=空格（稀疏表跳号诚实保留为空行/空格）。 */
export interface ParsedSheetRows {
  readonly rowCount: number;
  readonly columnCount: number;
  readonly rows: readonly (readonly (string | null)[])[];
}

/** worksheet XML → 行网格。t 类型全覆盖：s 共享串/inlineStr 内联/str 公式串
 *  结果/b 布尔/e 错误/无 t=数字（**原样字符串**，绝不 parseFloat——
 *  123456789012345678 漂成 123456789012345680 是静默数据损坏）。纯。 */
export function parseSheetRows(xml: string, sharedStrings: readonly string[]): ParsedSheetRows {
  const sheetData = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(xml)?.[1] ?? "";
  // rowNumber → (colIndex → 文本)；稀疏存储，最后统一铺宽。
  const rowMap = new Map<number, Map<number, string>>();
  let maxRow = 0;
  let maxCol = -1;
  let lastRow = 0; // 无 r 属性的行按「上一行 + 1」落位（容错，正常文件都有 r）
  for (const rowMatch of sheetData.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const attrs = rowMatch[1] ?? "";
    const children = rowMatch[2] ?? "";
    const rAttr = /\br\s*=\s*"(\d+)"/.exec(attrs)?.[1];
    const rowNo = rAttr !== undefined ? Number.parseInt(rAttr, 10) : lastRow + 1;
    lastRow = rowNo;
    if (rowNo > maxRow) maxRow = rowNo;
    let cells = rowMap.get(rowNo);
    let lastCol = -1; // 无 r 的 cell 同理按「左邻 + 1」
    for (const cellMatch of children.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const cAttrs = cellMatch[1] ?? "";
      const cChildren = cellMatch[2] ?? "";
      const ref = attrValue(cAttrs, "r");
      const t = attrValue(cAttrs, "t");
      let col: number;
      if (ref !== undefined) {
        const parsed = columnIndexFromRef(ref);
        if (parsed === undefined) continue; // 引用解不出——跳过这格（诚实忽略）
        col = parsed;
      } else {
        col = lastCol + 1;
      }
      lastCol = col;
      const text = cellText(cChildren, t, sharedStrings);
      if (text === null) continue; // 无值格（纯样式格）= 空
      if (cells === undefined) {
        cells = new Map<number, string>();
        rowMap.set(rowNo, cells);
      }
      cells.set(col, text);
      if (col > maxCol) maxCol = col;
    }
  }
  const columnCount = maxCol + 1;
  const rows: (string | null)[][] = [];
  for (let r = 1; r <= maxRow; r++) {
    const cells = rowMap.get(r);
    const row: (string | null)[] = new Array<string | null>(columnCount).fill(null);
    if (cells !== undefined) {
      for (const [col, text] of cells) row[col] = text;
    }
    rows.push(row);
  }
  return { rowCount: maxRow, columnCount, rows };
}

/** 单元格文本抽取（c 的 children + t 类型 + 共享串表）。null=这格无值。 */
function cellText(children: string, t: string | undefined, sharedStrings: readonly string[]): string | null {
  if (t === "inlineStr") {
    const is = /<is\b[^>]*?(?:\/>|>([\s\S]*?)<\/is>)/.exec(children)?.[1];
    if (is === undefined) return null;
    const text = collectTextRuns(is);
    return text === "" ? null : text;
  }
  const v = /<v\b[^>]*?(?:\/>|>([\s\S]*?)<\/v>)/.exec(children)?.[1];
  if (v === undefined) return null;
  if (t === "b") return v.trim() === "1" ? "TRUE" : "FALSE";
  if (t === "s") {
    const idx = Number.parseInt(v.trim(), 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= sharedStrings.length) return null;
    return sharedStrings[idx]!;
  }
  // 无 t（数字）/t="str"（公式串结果）/t="e"（错误格如 #DIV/0!）：v 原样。
  return decodeXmlEntities(v);
}

/** 一张工作表的全量数据（名 + 行网格）。 */
export interface XlsxSheetData extends ParsedSheetRows {
  readonly name: string;
}

export type XlsxSheetsCheck =
  | { readonly ok: true; readonly sheets: readonly XlsxSheetData[] }
  | { readonly ok: false; readonly error: string };

const BAD_XLSX = "这不是有效的 Excel（.xlsx）文件";

/** 解析整个工作簿：sheet 名序取 workbook.xml 的 <sheet> 次序，部件路径经
 *  workbook.xml.rels 的 r:id→target 解析（target 相对 xl/，也容绝对形），
 *  **不假设 sheetN.xml 编号与顺序有关**；sharedStrings 在场则先解。纯。 */
export function parseXlsxSheets(bytes: Uint8Array): XlsxSheetsCheck {
  const unzipped = unzipEntries(bytes);
  if (!unzipped.ok) return unzipped;
  const byName = new Map<string, Uint8Array>();
  for (const e of unzipped.entries) byName.set(e.name, e.data);
  const dec = new TextDecoder();

  const workbookBytes = byName.get("xl/workbook.xml");
  if (workbookBytes === undefined) return { ok: false, error: `${BAD_XLSX}——缺少工作簿结构` };
  const workbook = dec.decode(workbookBytes);

  // r:id → 部件路径（相对 xl/ 目录解析；绝对 target 去头斜杠）。
  const relsBytes = byName.get("xl/_rels/workbook.xml.rels");
  const rels = new Map<string, string>();
  if (relsBytes !== undefined) {
    for (const m of dec.decode(relsBytes).matchAll(/<Relationship\b[^>]*>/g)) {
      const id = attrValue(m[0], "Id");
      const target = attrValue(m[0], "Target");
      if (id === undefined || target === undefined) continue;
      const normalized = target.startsWith("/")
        ? target.slice(1)
        : `xl/${target.replace(/^\.\//, "")}`;
      rels.set(id, normalized);
    }
  }

  const sharedStrings = relsBytes !== undefined && byName.has("xl/sharedStrings.xml")
    ? parseSharedStrings(dec.decode(byName.get("xl/sharedStrings.xml")!))
    : [];

  const sheets: XlsxSheetData[] = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attrValue(m[0], "name");
    const rid = attrValue(m[0], "r:id");
    if (name === undefined || rid === undefined) continue;
    const part = rels.get(rid);
    if (part === undefined) {
      return { ok: false, error: `${BAD_XLSX}——工作簿引用了一张缺失的表（${name}）` };
    }
    const partBytes = byName.get(part);
    if (partBytes === undefined) {
      return { ok: false, error: `${BAD_XLSX}——工作簿引用了一张缺失的表（${name}）` };
    }
    const parsed = parseSheetRows(dec.decode(partBytes), sharedStrings);
    sheets.push({ name, ...parsed });
  }
  if (sheets.length === 0) {
    return { ok: false, error: `${BAD_XLSX}——没有找到任何工作表` };
  }
  return { ok: true, sheets };
}

// ---------------------------------------------------------------------------
// C — 工具面：read_xlsx（make_xlsx 的读半边；「帮我看下这个 Excel」场景）。
// ω99-221: #2 — 工具面细节：path（必填，相对工作区）+ sheet（可选，表名或
// 1 起序号，缺省第一张）+ offset（1 起行）/ limit（缺省 100，硬帽 1000）；
// 输出=首行全表名录 → 分隔行（表名+行窗口+总数）→ TSV 网格（首行=Excel
// 第 1 行）→ 截断通知（行/列各一条，教 offset/limit 翻页）；列帽 64 超出
// 截断并通知；魔数嗅探：非 zip 拒、OLE（旧版 .xls）给「另存为 .xlsx」出路。
// ---------------------------------------------------------------------------

/** 行窗口：缺省 100 行（工具结果预算纪律——大表分次读，不一次爆上下文）。 */
export const XLSX_DEFAULT_ROW_LIMIT = 100;
/** 行窗口硬帽：单次最多读 1000 行（更大的 limit 钳到帽并如实告知）。 */
export const XLSX_MAX_ROW_LIMIT = 1000;
/** 列帽：与写面 DOC_MAX_COLUMNS 同数（64）——超宽表截前 64 列并通知。 */
export const XLSX_MAX_COLUMNS = 64;

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0] as const;

/** 千分位（1,240）：名录/分隔行/通知里的计数都走它（人读数字）。 */
function fmtCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** 网格单元 → TSV 安全文本：制表符/换行压成空格（保网格结构——一格一行
 *  一列是网格的可读性前提；多行单元格因此降为单行，记档诚实边界）。 */
function tsvSafe(s: string | null): string {
  return s === null ? "" : s.replace(/[\t\r\n]+/g, " ");
}

/** 读了工作簿后选表：名匹配（精确）或 1 起序号；miss 时给名录拒（模型可
 *  自修）。纯。 */
function selectSheet(
  sheets: readonly XlsxSheetData[],
  selector: string | number | undefined,
): { ok: true; sheet: XlsxSheetData } | { ok: false; error: string } {
  const names = sheets.map((s) => s.name).join("、");
  if (selector === undefined) return { ok: true, sheet: sheets[0]! };
  if (typeof selector === "string") {
    const hit = sheets.find((s) => s.name === selector);
    if (hit === undefined) {
      return { ok: false, error: `没有名为「${selector}」的工作表——这个文件里的工作表：${names}` };
    }
    return { ok: true, sheet: hit };
  }
  if (!Number.isInteger(selector) || selector < 1 || selector > sheets.length) {
    return {
      ok: false,
      error: `第 ${selector} 张工作表不存在——这个文件共 ${sheets.length} 张工作表：${names}`,
    };
  }
  return { ok: true, sheet: sheets[selector - 1]! };
}

/** 读工作区里现有的 Excel 文件（.xlsx），把某张工作表读成文本表格进上下
 *  文。顶级只读工具（tools.ts 固定钉位）；路径必经 resolveWorkspacePath
 *  （外逃/绝对路径 typed 拒，fail-closed）；与 make_xlsx 组成「读→想→写」
 *  闭环。读面姿态与写面相反：只读/并发安全/非破坏/非开放世界。 */
export function createReadXlsxTool(workspaceRoot: string): Tool {
  return buildTool({
    name: "read_xlsx",
    description:
      "读取工作区里现有的 Excel 文件（.xlsx），把其中一张工作表的内容变成文本表格，用于查看、核对、分析和再加工——「帮我看下 / 分析 / 汇总这个 Excel」类请求都用它；与生成 Excel 的 make_xlsx 相对，两者合起来可完成「读现有表 → 整理 → 给出新表」。" +
      " path 是文件相对工作区的路径。sheet 可选：工作表名字或序号（1 起），缺省读第一张。offset / limit 可选：从第几行开始读（1 起）与这次最多读多少行——大表分几次读，文件开头会先列出全部工作表名字和行列数，方便决定读哪张、读多少。" +
      " 注意：Excel 里的日期读出来是数字（例如 45658 代表某一天），这是 Excel 的内部记法，属正常现象；只读单元格的值，样式、合并单元格和公式本身不读。旧版 .xls 格式读取不了，需先在 Excel 里另存为 .xlsx。",
    // 读面四布尔：只读、并发安全（多路同时读互不干扰）、非破坏、本地
    // 文件系统（非开放世界）——与 make_xlsx 写面姿态逐项相反。
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    isOpenWorld: () => false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Excel 文件路径（相对工作区，可带子目录），.xlsx 文件。" },
        // sheet 双形（名或 1 起序号）：wire 类型只认标量，报 string 形（名
        // 字是主用法）；序号形在 execute 里 typed 认（深度校验在工具内，
        // fail-closed——core 注释钉的同款纪律）。
        sheet: { type: "string", description: "要读的工作表：名字或序号（1 起）；缺省第一张。文件开头会先列出全部工作表供选择。" },
        offset: { type: "number", description: "从第几行开始读（1 起，Excel 行号）；缺省第 1 行。" },
        limit: { type: "number", description: `这次最多读多少行；缺省 ${XLSX_DEFAULT_ROW_LIMIT}，最大 ${XLSX_MAX_ROW_LIMIT}（更大也会按这个上限读）。` },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args) {
      // 参数 typed 校验（先于任何盘副作用）。
      const rawPath = args["path"];
      if (typeof rawPath !== "string" || rawPath.trim() === "") {
        return { content: 'read_xlsx: "path" must be a non-empty path relative to the workspace', isError: true };
      }
      const rel = rawPath.trim();

      let sheetSel: string | number | undefined;
      const rawSheet = args["sheet"];
      if (rawSheet !== undefined) {
        if (typeof rawSheet === "string") {
          if (rawSheet.trim() === "") {
            return { content: 'read_xlsx: "sheet" must be a worksheet name or a 1-based sheet number', isError: true };
          }
          sheetSel = rawSheet.trim();
        } else if (typeof rawSheet === "number" && Number.isInteger(rawSheet) && rawSheet >= 1) {
          sheetSel = rawSheet;
        } else {
          return { content: 'read_xlsx: "sheet" must be a worksheet name or a 1-based sheet number', isError: true };
        }
      }

      const positiveInt = (name: string, v: unknown): number | undefined => {
        if (v === undefined) return undefined;
        if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
          throw new Error(`${name} must be a positive integer (got ${String(v)})`);
        }
        return v;
      };
      let offset: number;
      let limit: number;
      try {
        offset = positiveInt("offset", args["offset"]) ?? 1;
        limit = positiveInt("limit", args["limit"]) ?? XLSX_DEFAULT_ROW_LIMIT;
      } catch (err) {
        return { content: `read_xlsx: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      limit = Math.min(limit, XLSX_MAX_ROW_LIMIT); // 硬帽（截断通知如实反映实读窗口）

      // 工作区边界（外逃/绝对路径/符号链接诡计拒）。
      const resolved = await resolveWorkspacePath(workspaceRoot, rel);
      if (!resolved.ok) return { content: `read_xlsx: ${resolved.error}`, isError: true };

      let bytes: Uint8Array;
      try {
        bytes = await readFile(resolved.absPath);
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return { content: `read_xlsx: 文件不存在：${rel}`, isError: true };
        }
        return { content: `read_xlsx: 读取失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
      }

      // 魔数嗅探先于结构解析：旧版 .xls（OLE 复合文档）与「根本不是
      // Excel」分开拒——前者有出路（另存为 .xlsx），说清楚。
      if (bytes.length >= 4 && OLE_MAGIC.every((b, i) => bytes[i] === b)) {
        return {
          content: `read_xlsx: ${rel} 是旧版 .xls 格式，读取不了——请先用 Excel 打开并「另存为」.xlsx 格式后再试`,
          isError: true,
        };
      }
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
        return {
          content: `read_xlsx: ${rel} 不是 Excel（.xlsx）文件——如果它是旧版 .xls 或其他格式，请先在 Excel 里另存为 .xlsx 再试`,
          isError: true,
        };
      }

      const parsed = parseXlsxSheets(bytes);
      if (!parsed.ok) return { content: `read_xlsx: ${parsed.error}`, isError: true };

      const selected = selectSheet(parsed.sheets, sheetSel);
      if (!selected.ok) return { content: `read_xlsx: ${selected.error}`, isError: true };
      const sheet = selected.sheet;

      if (offset > sheet.rowCount) {
        return {
          content: `read_xlsx: 第 ${fmtCount(offset)} 行超出「${sheet.name}」的范围——这张表共 ${fmtCount(sheet.rowCount)} 行（用 1–${fmtCount(sheet.rowCount)} 之间的 offset）`,
          isError: true,
        };
      }

      const last = Math.min(offset + limit - 1, sheet.rowCount);
      const colShown = Math.min(sheet.columnCount, XLSX_MAX_COLUMNS);

      // 名录恒在（跨翻页/跨表切换都先看到全文件的工作表盘点）。
      const lines: string[] = [
        `工作表：${parsed.sheets.map((s) => `${s.name}（${fmtCount(s.rowCount)} 行 × ${fmtCount(s.columnCount)} 列）`).join("、")}`,
      ];
      lines.push(
        sheet.rowCount === 0
          ? `── ${sheet.name}（空表）──`
          : `── ${sheet.name}（第 ${fmtCount(offset)}–${fmtCount(last)} 行，共 ${fmtCount(sheet.rowCount)} 行）──`,
      );
      for (let r = offset; r <= last; r++) {
        const row = sheet.rows[r - 1] ?? [];
        // 尾部空格剪掉（TSV 行不拖一串制表符）；行内空格保留占位。
        let end = colShown;
        while (end > 0 && row[end - 1] === null) end--;
        lines.push(row.slice(0, end).map(tsvSafe).join("\t"));
      }
      if (last < sheet.rowCount) {
        lines.push(`（已截断：显示了第 ${fmtCount(offset)}–${fmtCount(last)} 行，这张表共 ${fmtCount(sheet.rowCount)} 行——用 offset=${fmtCount(last + 1)} 或配合 limit 继续翻页读取）`);
      }
      if (sheet.columnCount > XLSX_MAX_COLUMNS) {
        lines.push(`（已截断：只显示了前 ${XLSX_MAX_COLUMNS} 列，这张表共 ${fmtCount(sheet.columnCount)} 列）`);
      }
      return { content: lines.join("\n") };
    },
  });
}

/** log.ts summarize 的对象摘要件（导出给测试直钉）：文件尾名 + 表（名或
 *  第 N 张）+ 行窗口，形「订单.xlsx 「销售明细」 第 101–200 行」。纯。 */
export function summarizeXlsxWindow(input: Record<string, unknown>): string {
  const parts: string[] = [];
  const path = input["path"];
  if (typeof path === "string" && path.trim() !== "") parts.push(basename(path.trim()));
  const sheet = input["sheet"];
  if (typeof sheet === "string" && sheet.trim() !== "") parts.push(`「${sheet.trim()}」`);
  else if (typeof sheet === "number" && Number.isInteger(sheet) && sheet >= 1) parts.push(`第 ${sheet} 张表`);
  const offset = typeof input["offset"] === "number" && Number.isInteger(input["offset"]) && input["offset"] >= 1
    ? input["offset"]
    : 1;
  const limit = typeof input["limit"] === "number" && Number.isInteger(input["limit"]) && input["limit"] >= 1
    ? input["limit"]
    : XLSX_DEFAULT_ROW_LIMIT;
  parts.push(`第 ${fmtCount(offset)}–${fmtCount(offset + limit - 1)} 行`);
  return parts.join(" ");
}
