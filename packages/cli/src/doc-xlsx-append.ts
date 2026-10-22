// ω99-228: #1 — xlsx 追加面纯层 + 工具面（零依赖）。「帮我看下这个表，
// 再把新数据添进去」是场景主线（09-05 产品令）——221 读了、123 造了新文
// 件，唯独「往用户的既有表里添行」断路（此前只能 make_xlsx 整份重造，原
// 表数据全丢）。本面补**追加式编辑**：既有部件字节保真（只缝目标工作表
// 一个部件，其余部件原字节过 zip 层），新行拼在该表 sheetData 尾部。
//
// 设计裁定（超越点，brief §零钉）：新行字符串一律走 **inlineStr**
// （<c r="A5" t="inlineStr"><is><t xml:space="preserve">…</t></is></c>）
// ——**sharedStrings 零触碰**，xlsx 的同位碰撞问题（新字符串要么扫
// count/uniqueCount 续编 <si>，要么绕开）整个消失。这不是偷懒：
// make_xlsx 写面（doc-xlsx.ts）本就全线 inlineStr，Excel/WPS/Numbers 全
// 兼容，221 读面 inlineStr 分支已解析——产品内自洽。代价如实记档：放弃
// sharedStrings 去重（同串重复存，文件略胖）；换回的是零碰撞、零跨部件
// 状态、与写面同源的四形映射（string→inlineStr / number→<v> /
// boolean→t="b" 0|1 / null→整 cell 略过=稀疏）。
//
// 纯层五件：scanXlsxSheetPart（workbook.xml <sheet> 名序 + rels r:id→
// target 解析——**与 doc-xlsx-read.ts 同源纪律**：不假设 sheetN.xml 编号
// =顺序；**复制不重构**，parseXlsxSheets 内部同款逻辑不抽出复用，读面字
// 节零动，223 scanPptx 先例）+ lastRowNumber（<row r 扫 max——稀疏/乱序
// 都容忍）+ appendXlsxRows（四形拼行、插 </sheetData> 前、空表两形整替
// 换、dimension present 则改 absent 则不造）+ validateXlsxAppendRows
// （typed 校验）+ appendXlsx（unzip→缝→storedZip 回装；totalRows 喂
// parseXlsxSheets 读回真值——读写互证前移到收据层，223 docx 同款）。
//
// 纪律（brief 钉，221/222/223 同款）：
// - 纯层纯函数：不碰时钟（DOS 时间由 doc-zip 钉）、不碰盘（盘只在工具面
//   execute 里 readFile/writeFile）；
// - 原包字节保真：除目标工作表部件外逐字节过 zip 层；条目名序原样（确
//   定性：同输入两次全等）；
// - typed 拒优于静默剥：坏 zip/加密/Zip64/缺部件/坏参数直接拒，错误信息
//   用户语（unzipEntries 本体就是 xlsx 口径文案，本面零映射直过）；
// - 列帽 64 与 XLSX_MAX_COLUMNS / DOC_MAX_COLUMNS 同源（import 读面常量，
//   超出拒且指明第几列）；行数与格文本长度**不设帽**（append_docx 零帽
//   先例 + make 面同形——政策同源优于新裁）；
// - 控制字符政策**逐字同 make 面**：\x00-\x08、\x0B、\x0C、\x0E-\x1F 拒
//   （文案给去处），\t \n \r 放行。
//
// ω99-230: #4 — 回装自 storedZip 换 smartZip（压缩透传）：unzip→meta 变体
// （unzipEntriesWithMeta）→ 未改部件原压缩载荷字节直过、目标工作表按原
// method 重压——用户 Office 存的 deflate 包不再改几行就全包重装为不压缩
// （改一处胖数倍的债收口）。改动判定内建于 smartZip；工具面/门序/收据/
// summarize 零动。
import { smartZip, unzipEntriesWithMeta } from "./doc-zip.js";
import { parseXlsxSheets, XLSX_MAX_COLUMNS } from "./doc-xlsx-read.js";
import { buildTool, resolveWorkspacePath } from "@wudao/core";
import type { Tool } from "@wudao/core";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

// ---------------------------------------------------------------------------
// A — xlsx 追加纯层。
// ---------------------------------------------------------------------------

/** 一个待追加的行（单元格四形：string | number | boolean | null）。 */
export type XlsxAppendRow = readonly (string | number | boolean | null)[];

export type AppendXlsxRowsCheck =
  | { readonly ok: true; readonly rows: readonly XlsxAppendRow[] }
  | { readonly ok: false; readonly error: string };

/** 控制字符：\x00-\x08、\x0B、\x0C、\x0E-\x1F（\t \n \r 放行）——doc-xlsx.ts
 *  同款正则逐字复制（make 面未导出；复制 ~1 行，政策同源钉在注释）。 */
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

/** typed 校验：非数组/空/行非数组/列超 64（指明第几列）/控制字/非有限数/
 *  非法类型直接拒。行数与格文本长度不设帽（append_docx 零帽先例 + make
 *  面同形）。纯函数，永不抛。 */
export function validateXlsxAppendRows(raw: unknown): AppendXlsxRowsCheck {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "rows must be an array of rows to append (each row an array of cells)" };
  }
  if (raw.length === 0) {
    return { ok: false, error: "没有可追加的行——rows 需要至少一行数据（每行是一个单元格数组）" };
  }
  const rows: XlsxAppendRow[] = [];
  for (const [ri, row] of raw.entries()) {
    if (!Array.isArray(row)) {
      return { ok: false, error: `rows[${ri}] must be an array of cells (string | number | boolean | null)` };
    }
    if (row.length > XLSX_MAX_COLUMNS) {
      return {
        ok: false,
        error: `rows[${ri}] exceeds the ${XLSX_MAX_COLUMNS}-column limit — 第 ${XLSX_MAX_COLUMNS + 1} 列起已越界（Excel 列上限内只收前 ${XLSX_MAX_COLUMNS} 列）`,
      };
    }
    const cells: (string | number | boolean | null)[] = [];
    for (const [ci, cell] of row.entries()) {
      const at = `rows[${ri}][${ci}]`;
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
  return { ok: true, rows };
}

/** 从一个起始标签文本里取属性值（属性序无关；单双引号都认）——doc-xlsx-read.ts
 *  同款件复制（读面未导出；复制不重构，同源纪律）。 */
function attrValue(tag: string, name: string): string | undefined {
  const m =
    new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(tag) ??
    new RegExp(`${name}\\s*=\\s*'([^']*)'`).exec(tag);
  return m?.[1];
}

export type SheetPartCheck =
  | { readonly ok: true; readonly sheetName: string; readonly partName: string }
  | { readonly ok: false; readonly error: string };

/** 解出部件列表 → 定位要追加的工作表部件：workbook.xml 的 <sheet> 名序
 *  （**不假设 sheetN.xml 编号=顺序**——Excel 只保证 workbook 里的次序，
 *  部件文件名任意）+ xl/_rels/workbook.xml.rels 的 r:id→target（相对 xl/
 *  解析、绝对形去头斜杠——221 同款纪律）。sheet 缺省=第一张；表名或 1 起
 *  序号皆收；miss → typed 拒 + 全部表名列出（模型可自修）。纯。 */
export function scanXlsxSheetPart(
  parts: readonly { readonly name: string; readonly data: Uint8Array }[],
  sheet?: string | number,
): SheetPartCheck {
  const dec = new TextDecoder();
  const find = (name: string) => parts.find((e) => e.name === name);

  const workbookPart = find("xl/workbook.xml");
  if (workbookPart === undefined) {
    return { ok: false, error: "这不是有效的 Excel（.xlsx）文件——缺少工作簿结构" };
  }
  const workbook = dec.decode(workbookPart.data);

  // r:id → 部件路径（相对 xl/ 目录解析；绝对 target 去头斜杠）。
  const relsPart = find("xl/_rels/workbook.xml.rels");
  const rels = new Map<string, string>();
  if (relsPart !== undefined) {
    for (const m of dec.decode(relsPart.data).matchAll(/<Relationship\b[^>]*>/g)) {
      const id = attrValue(m[0], "Id");
      const target = attrValue(m[0], "Target");
      if (id === undefined || target === undefined) continue;
      const normalized = target.startsWith("/")
        ? target.slice(1)
        : `xl/${target.replace(/^\.\//, "")}`;
      rels.set(id, normalized);
    }
  }

  // <sheet> 名序 → {名, 部件} 列表（rels miss=引用缺失，同 221 口径拒）。
  const entries: { name: string; partName: string }[] = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attrValue(m[0], "name");
    const rid = attrValue(m[0], "r:id");
    if (name === undefined || rid === undefined) continue;
    const part = rels.get(rid);
    if (part === undefined || find(part) === undefined) {
      return { ok: false, error: `这不是有效的 Excel（.xlsx）文件——工作簿引用了一张缺失的表（${name}）` };
    }
    entries.push({ name, partName: part });
  }
  if (entries.length === 0) {
    return { ok: false, error: "这不是有效的 Excel（.xlsx）文件——没有找到任何工作表" };
  }

  const names = entries.map((e) => e.name).join("、");
  let selected: { name: string; partName: string } | undefined;
  if (sheet === undefined) {
    selected = entries[0]!; // 缺省=第一张（workbook 名序）
  } else if (typeof sheet === "string") {
    selected = entries.find((e) => e.name === sheet);
    if (selected === undefined) {
      return { ok: false, error: `没有名为「${sheet}」的工作表——这个文件里的工作表：${names}` };
    }
  } else {
    if (!Number.isInteger(sheet) || sheet < 1 || sheet > entries.length) {
      return {
        ok: false,
        error: `第 ${sheet} 张工作表不存在——这个文件共 ${entries.length} 张工作表：${names}`,
      };
    }
    selected = entries[sheet - 1]!;
  }
  return { ok: true, sheetName: selected.name, partName: selected.partName };
}

/** 工作表 XML → 最大行号（<row r="N" 扫 max：稀疏容忍、乱序容忍=取 max
 *  非 last）；空/无 sheetData → 0；裸自闭合 <row/>（无 r）略过，带 r 的
 *  <row r="9"/> 计入。纯。 */
export function lastRowNumber(sheetXml: string): number {
  let max = 0;
  for (const m of sheetXml.matchAll(/<row\b[^>]*?(?:\/>|>)/g)) {
    const r = /\br\s*=\s*"(\d+)"/.exec(m[0])?.[1];
    if (r === undefined) continue; // 无 r 的行（裸 <row/>）——无内容无行号，略过
    const n = Number.parseInt(r, 10);
    if (n > max) max = n;
  }
  return max;
}

/** 五实体转义（&amp; &lt; &gt; &quot; &apos;）——doc-xlsx.ts 同款件逐字复制
 *  （写面未导出；复制 ~5 行，注释钉同源）。 */
function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&apos;");
}

/** 0 基列号 → Excel 列字母（0→A，25→Z，26→AA；≤64 列 → 至多 BL）——
 *  doc-xlsx.ts 同款件逐字复制（写面未导出；复制 ~8 行，注释钉同源）。 */
function columnLetter(i: number): string {
  let s = "";
  let n = i;
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

/** 工作表缝补：新行 <row r="startRow+i"> + 四形 cell 拼好，插到
 *  </sheetData> 前；空表自闭合形 <sheetData/> 整替换为带内容的形（两种
 *  空形都收：自闭合/开闭对——后者走同一条 </sheetData> 前插道）；
 *  dimension：present 则行分量换新 max（Excel 自开自愈，自家读面按 max
 *  行扫也容忍；但改了更诚实）、absent 则不造。纯。 */
export function appendXlsxRows(sheetXml: string, rows: readonly XlsxAppendRow[], startRow: number): string {
  const rowEls = rows.map((row, ri) => {
    const rn = startRow + ri;
    const cells = row
      .map((cell, ci) => {
        if (cell === null) return ""; // 整 cell 略过——后续列的 r 引用仍按列号生成，跳号正确。
        const ref = `${columnLetter(ci)}${rn}`;
        if (typeof cell === "string") {
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell)}</t></is></c>`;
        }
        if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`;
        return `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`;
      })
      .join("");
    return `<row r="${rn}">${cells}</row>`;
  }).join("");

  // dimension 单点：present 则 ref 的行分量（尾坐标的行号）换 max(原值, 新
  // max)——只扩不缩（dimension 声明比实际行多时不缩水，追加只会让表更长）。
  const newMax = startRow + rows.length - 1;
  let out: string | undefined;
  const dim = /(<dimension\b[^>]*\bref\s*=\s*")([^"]*)(")/.exec(sheetXml);
  if (dim !== null) {
    const ref = dim[2]!;
    const tailRow = Number.parseInt(/(\d+)(?!.*\d)/.exec(ref)?.[1] ?? "0", 10); // 最后一段数字=尾坐标行号
    const rowOut = String(Math.max(Number.isNaN(tailRow) ? 0 : tailRow, newMax));
    out = sheetXml.replace(dim[0], `${dim[1]}${ref.replace(/(\d+)(?!.*\d)/, rowOut)}${dim[3]}`);
  }

  // 插入点：常规形 </sheetData> 前插（lastIndexOf——sheetData 唯一，取尾稳）；
  // 空表自闭合形整替换；无 sheetData 标签的病态形退 </worksheet> 前造一个
  // （读面把缺失当空表容，追加侧给同款宽容：造出来，不拒）。
  const xml = out ?? sheetXml;
  const close = xml.lastIndexOf("</sheetData>");
  if (close !== -1) return xml.slice(0, close) + rowEls + xml.slice(close);
  const selfClosed = /<sheetData\b[^>]*\/>/.exec(xml);
  if (selfClosed !== null) {
    return xml.replace(selfClosed[0], `<sheetData>${rowEls}</sheetData>`);
  }
  const wsEnd = xml.lastIndexOf("</worksheet>");
  if (wsEnd !== -1) return xml.slice(0, wsEnd) + `<sheetData>${rowEls}</sheetData>` + xml.slice(wsEnd);
  return xml; // 无锚点：调用方（appendXlsx）已前置拒，此行不可达（防御）
}

export type AppendXlsxCheck =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      readonly sheetName: string;
      readonly appended: number;
      readonly totalRows: number;
    }
  | { readonly ok: false; readonly error: string };

/** 解包→定位表→缝→回装整份 xlsx：只动目标工作表部件，其余部件原字节过
 *  zip 层（条目名序原样=字节保真；230 起按条目透传原 method——未改部件
 *  原压缩载荷直过）。totalRows 不数 XML——回装字节喂 parseXlsxSheets 读
 *  回真值（读写互证前移收据层，「现共 M 行」从读回来）。纯函数：不碰
 *  时钟、不碰盘。 */
export function appendXlsx(bytes: Uint8Array, rows: readonly XlsxAppendRow[], sheet?: string | number): AppendXlsxCheck {
  const unzipped = unzipEntriesWithMeta(bytes);
  if (!unzipped.ok) return unzipped; // xlsx 口径文案原样直过（本体就是 Excel 词汇，零映射）
  const scanned = scanXlsxSheetPart(unzipped.entries, sheet);
  if (!scanned.ok) return { ok: false, error: scanned.error };
  const target = unzipped.entries.find((e) => e.name === scanned.partName);
  if (target === undefined) {
    return { ok: false, error: `这不是有效的 Excel（.xlsx）文件——工作簿引用了一张缺失的表（${scanned.sheetName}）` };
  }
  const sheetXml = new TextDecoder().decode(target.data);
  if (!sheetXml.includes("</sheetData>") && !sheetXml.includes("<sheetData") && !sheetXml.includes("</worksheet>")) {
    return { ok: false, error: "这不是有效的 Excel（.xlsx）文件——文件结构不完整或已损坏" };
  }
  const startRow = lastRowNumber(sheetXml) + 1;
  const newXml = appendXlsxRows(sheetXml, rows, startRow);
  const enc = new TextEncoder();
  // 每条目统一挂 meta（原条目），已改/未改交给 smartZip 自行比对裁定。
  const parts = unzipped.entries.map((e) =>
    e === target ? { name: e.name, data: enc.encode(newXml), meta: e } : { name: e.name, data: e.data, meta: e },
  );
  const out = smartZip(parts);
  // 读写互证：回装字节喂读面，totalRows=读回的 max 行号（不数 XML）。
  const readBack = parseXlsxSheets(out);
  if (!readBack.ok) return { ok: false, error: readBack.error };
  const reread = readBack.sheets.find((s) => s.name === scanned.sheetName);
  if (reread === undefined) {
    return { ok: false, error: "这不是有效的 Excel（.xlsx）文件——文件结构不完整或已损坏" };
  }
  return { ok: true, bytes: out, sheetName: scanned.sheetName, appended: rows.length, totalRows: reread.rowCount };
}

// ---------------------------------------------------------------------------
// B — 工具面：append_xlsx（make_xlsx 的追加半边；「帮我看下这个表，再把
// 新数据添进去」场景）。path（必填，相对工作区）+ rows（二维数组，必填，
// 空数组 typed 拒「没有可追加的行」）+ sheet（可选：表名或 1 起序号，缺省
// 第一张）；魔数嗅探：OLE（旧版 .xls）给「另存为 .xlsx」出路、非 PK 拒；
// 追加只覆写目标文件本身（零删除面）。
// ---------------------------------------------------------------------------

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0] as const;

/** 往工作区里现有的 Excel 文件末尾追加数据行。顶级工具（tools.ts 固定钉
 *  位）；路径必经 resolveWorkspacePath（外逃/绝对路径 typed 拒，
 *  fail-closed）；校验先于副作用：拒时零写盘。姿态镜像 make_xlsx 写面
 *  （append_docx 逐项同）。 */
export function createAppendXlsxTool(workspaceRoot: string): Tool {
  return buildTool({
    name: "append_xlsx",
    description:
      "往工作区里现有的 Excel 文件（.xlsx）的某张工作表末尾追加数据行：字符串、数字、布尔、留空都能进，表里已有的内容原样保留。适合「帮我看下这个表，再把新数据添进去」「往这张表后面补几行」类请求；与读表的 read_xlsx、生成新表的 make_xlsx 配套——先读现有内容，再把新的行追加进去。" +
      " path 是文件相对工作区的路径。rows 是要追加的行数组，每行是一个单元格数组（字符串 / 数字 / 布尔 / null 留空），一次最多 64 列。sheet 可选：要追加到哪张工作表（名字或 1 起序号），缺省第一张。" +
      " 注意：追加的行不带样式（用这张表的默认字体和格式），不会沿用表头的加粗；返回的行号范围可以直接接着用 read_xlsx 翻页查看；旧版 .xls 格式不支持，需先在 Excel 里另存为 .xlsx。",
    // 写盘（非只读）；只在本地文件系统（closed-world）。覆写目标文件本身
    // → destructive 诚实标注（make_xlsx/append_docx 同款 posture 镜像）。
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    isOpenWorld: () => false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要追加行的 Excel 文件路径（相对工作区，可带子目录），.xlsx 文件。" },
        // sheet 双形（名或 1 起序号）：wire 类型只认标量，报 string 形（名
        // 字是主用法）；序号形在 execute 里 typed 认（read_xlsx 同款纪律）。
        sheet: { type: "string", description: "要追加到的工作表：名字或序号（1 起）；缺省第一张。read_xlsx 会先列出全部工作表供选择。" },
      },
      required: ["path", "rows"],
      // rows 是嵌套二维数组——core 的参数类型只认 string|number|boolean|
      // array（make_xlsx 同款），走宽松的未知参数道：类型检查在 execute
      // 里由 validateXlsxAppendRows 做（fail-closed typed 拒）。
      additionalProperties: true,
    },
    async execute(args) {
      // 参数 typed 校验（先于任何盘副作用）。
      const rawPath = args["path"];
      if (typeof rawPath !== "string" || rawPath.trim() === "") {
        return { content: 'append_xlsx: "path" must be a non-empty path relative to the workspace', isError: true };
      }
      const rel = rawPath.trim();

      let sheetSel: string | number | undefined;
      const rawSheet = args["sheet"];
      if (rawSheet !== undefined) {
        if (typeof rawSheet === "string") {
          if (rawSheet.trim() === "") {
            return { content: 'append_xlsx: "sheet" must be a worksheet name or a 1-based sheet number', isError: true };
          }
          sheetSel = rawSheet.trim();
        } else if (typeof rawSheet === "number" && Number.isInteger(rawSheet) && rawSheet >= 1) {
          sheetSel = rawSheet;
        } else {
          return { content: 'append_xlsx: "sheet" must be a worksheet name or a 1-based sheet number', isError: true };
        }
      }

      // rows：typed 校验（四形/列帽/控制字/空数组全查）。
      const checked = validateXlsxAppendRows(args["rows"]);
      if (!checked.ok) return { content: `append_xlsx: ${checked.error}`, isError: true };

      // 工作区边界（外逃/绝对路径/符号链接诡计拒）。
      const resolved = await resolveWorkspacePath(workspaceRoot, rel);
      if (!resolved.ok) return { content: `append_xlsx: ${resolved.error}`, isError: true };

      let bytes: Uint8Array;
      try {
        bytes = await readFile(resolved.absPath);
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return { content: `append_xlsx: 文件不存在：${rel}`, isError: true };
        }
        return { content: `append_xlsx: 读取失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
      }

      // 魔数嗅探先于结构解析：旧版 .xls（OLE 复合文档）与「根本不是
      // Excel」分开拒——前者有出路（另存为 .xlsx），说清楚。
      if (bytes.length >= 4 && OLE_MAGIC.every((b, i) => bytes[i] === b)) {
        return {
          content: `append_xlsx: ${rel} 是旧版 .xls 格式，改不了——请先用 Excel 打开并「另存为」.xlsx 格式后再试`,
          isError: true,
        };
      }
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
        return {
          content: `append_xlsx: ${rel} 不是 Excel（.xlsx）文件——如果它是旧版 .xls 或其他格式，请先在 Excel 里另存为 .xlsx 再试`,
          isError: true,
        };
      }

      const appended = appendXlsx(bytes, checked.rows, sheetSel);
      if (!appended.ok) return { content: `append_xlsx: ${appended.error}`, isError: true };

      // 追加=覆写目标文件本身（零删除面；目录已存在——刚读过这文件）。
      try {
        await writeFile(resolved.absPath, appended.bytes);
      } catch (err) {
        return { content: `append_xlsx: 写入失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
      }
      const kb = (appended.bytes.byteLength / 1024).toFixed(1);
      const lastRow = appended.totalRows;
      const firstRow = lastRow - appended.appended + 1;
      return {
        // 收据=用户语：一句中文（路径/表名/新增行数/现共行数/新行的绝对行窗
        // ——模型下一步 read_xlsx 翻页可直接用）+ 结构化字段一行（文件卡从
        // 这行提取）。
        content:
          `已追加 ${appended.appended} 行到 ${rel}「${appended.sheetName}」（现共 ${appended.totalRows} 行，第 ${firstRow}–${lastRow} 行，${kb} KB）\n` +
          JSON.stringify({
            path: resolved.absPath,
            relativePath: rel,
            sheet: appended.sheetName,
            appendedRows: appended.appended,
            totalRows: appended.totalRows,
            bytes: appended.bytes.byteLength,
          }),
      };
    },
  });
}

/** log.ts summarize 的对象摘要件（导出给测试直钉）：文件尾名 + 表（名或
 *  第 N 张）+ 追加量，形「订单.xlsx 「销售明细」 追加 5 行」（220 裁定语
 *  法：summary=动作对象；总数子句砍——summarize 只见输入，M 在结果里不可
 *  达，不编造）。纯。 */
export function summarizeAppendXlsx(input: Record<string, unknown>): string {
  const parts: string[] = [];
  const path = input["path"];
  if (typeof path === "string" && path.trim() !== "") parts.push(basename(path.trim()));
  const sheet = input["sheet"];
  if (typeof sheet === "string" && sheet.trim() !== "") parts.push(`「${sheet.trim()}」`);
  else if (typeof sheet === "number" && Number.isInteger(sheet) && sheet >= 1) parts.push(`第 ${sheet} 张表`);
  const rows = input["rows"];
  if (Array.isArray(rows)) parts.push(`追加 ${rows.length} 行`);
  return parts.join(" ");
}
