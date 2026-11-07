// ω99-222: #3 — docx 读面纯层 + 工具面（零依赖）。Word 文档（.docx）与
// xlsx 同为 OOXML zip：解压复用 doc-zip.ts 的 unzipEntries（222 起的共享
// 地基），之上是 document.xml 的结构读取——「帮我看下这个 Word 写了什么」
// 场景的读半边（写半边 make_docx 在 doc-docx.ts，两半互不 import）。
//
// 纯层 parseDocxBlocks(xml)：扫 <w:p> 段落（多 run 的 <w:t> 拼接）与
// <w:tbl> 表格（<w:tr> 行 / <w:tc> 格，格内段落文本相连），文档序线性化
// 成「块」流（段落与表格交错照序）。
//
// 纪律（brief 钉，221 同款）：
// - 纯层全部纯函数：不碰时钟、不碰盘（盘只在工具面 execute 里 readFile）；
// - typed 拒优于静默剥：坏 zip/加密/Zip64/缺部件/坏参数直接拒，错误信息
//   给模型可自修的原因（用户语，零 zip/XML 实现术语——技术词只在注释层）；
// - 自闭合标签全用非贪婪形（<w:p/> 误当开标签会吞后续内容——221 教训）；
// - 嵌套表格 v1 压平：内层表格的文本并入外层所在格（稀见形，不拒收整份
//   文档；如实记档）；
// - 段落一行一块：文本里的制表符/换行折成空格（块的行不变量）；
// - 读夹具反哺：本层与 doc-docx.ts 写器同源互测（buildDocx 造 roundtrip）。
import { unzipEntries } from "./doc-zip.js";
import { buildTool, resolveWorkspacePath } from "@wudao-org/core";
import type { Tool } from "@wudao-org/core";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

// ---------------------------------------------------------------------------
// A — docx 结构纯层（段落 / 表格 / 文档序块流）。
// ---------------------------------------------------------------------------

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** XML 实体解码：五个命名实体 + 十进制/十六进制数字实体（单趟，不双解）。 */
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

/** 段落（或表格格）文本 → 单行安全文本：制表符/换行折成空格（「段落一行
 *  一块」/「一格一列」的可读性前提；多行内容降单行，记档）。 */
function lineSafe(s: string): string {
  return s.replace(/[\t\r\n]+/g, " ");
}

/** 一段（<w:p> 内文）→ 文本：全部 <w:t>（含多 run）顺序拼接；<w:br/> 与
 *  <w:tab/> 合成空格文本 run（折成空格不粘字——空格必须落在 <w:t> 里才进
 *  拼接）；首尾空白剪除；实体解码。纯。 */
function paragraphText(inner: string): string {
  const breaks = inner
    .replace(/<w:br\b[^>]*?(?:\/>|><\/w:br>)/g, "<w:t> </w:t>")
    .replace(/<w:tab\b[^>]*?\/>/g, "<w:t> </w:t>");
  let out = "";
  for (const m of breaks.matchAll(/<w:t\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:t>)/g)) {
    out += decodeXmlEntities(m[1] ?? "");
  }
  return out.trim();
}

/** 深度计数取某标签的直接子块内文（开/闭标签配平；自闭合=空块；嵌套层归
 *  入父块内容——v1 压平纪律）。畸形容错：无开标签的闭标签跳过。纯。 */
function directSpans(xml: string, tag: string): string[] {
  const token = new RegExp(`<${tag}\\b[^>]*?(\\/?)>|</${tag}>`, "g");
  const out: string[] = [];
  const stack: number[] = [];
  for (const m of xml.matchAll(token)) {
    if (m[0].startsWith("</")) {
      const start = stack.pop();
      if (start === undefined) continue;
      if (stack.length === 0) out.push(xml.slice(start, m.index));
    } else if (m[1] === "/") {
      if (stack.length === 0) out.push("");
    } else {
      stack.push(m.index! + m[0].length);
    }
  }
  return out;
}

/** 一个读出的段落块：text 可为空串（空段照读——文档序忠实，Word 用空段做
 *  布局间距是常态）。 */
export interface DocxReadParagraph {
  readonly kind: "paragraph";
  readonly text: string;
}

/** 一个读出的表格块：index=文档序表号（跨窗口稳定，1 起）；rows 每行是格
 *  文本数组（null/空段格=""，行宽不齐照实——gridSpan 不展开）。 */
export interface DocxReadTable {
  readonly kind: "table";
  readonly index: number;
  readonly rows: readonly (readonly string[])[];
}

export type DocxReadBlock = DocxReadParagraph | DocxReadTable;

/** 表格（<w:tbl> 内文）→ 行×格文本：行取直接子 <w:tr>（嵌套表格的行归入
 *  外层格文本，不外溢）；格文本=格内全部 <w:p> 的段落文本相连（空段跳过，
 *  嵌套表格的段落自然并入=压平）。纯。 */
function tableRows(tblInner: string): string[][] {
  return directSpans(tblInner, "w:tr").map((row) =>
    directSpans(row, "w:tc").map((cell) =>
      lineSafe(
        [...cell.matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)]
          .map((m) => paragraphText(m[1] ?? ""))
          .filter((t) => t !== "")
          .join(" "),
      ),
    ),
  );
}

/** document.xml → 文档序块流（段落与表格交错照序；段落不嵌套可直配，
 *  表格深度配平）。纯。 */
export function parseDocxBlocks(xml: string): readonly DocxReadBlock[] {
  const blocks: DocxReadBlock[] = [];
  const token = /<w:p\b[^>]*?(\/?)>|<\/w:p>|<w:tbl\b[^>]*?(\/?)>|<\/w:tbl>/g;
  let pStart = -1; // 段内起点（<w:p> 不嵌套——直接子级才起算）
  const tblStack: number[] = [];
  let tableCount = 0;
  for (const m of xml.matchAll(token)) {
    const t = m[0];
    if (t.startsWith("</")) {
      if (t === "</w:p>") {
        if (pStart >= 0) {
          blocks.push({ kind: "paragraph", text: lineSafe(paragraphText(xml.slice(pStart, m.index))) });
          pStart = -1;
        }
      } else {
        const start = tblStack.pop();
        if (start !== undefined && tblStack.length === 0) {
          tableCount += 1;
          blocks.push({ kind: "table", index: tableCount, rows: tableRows(xml.slice(start, m.index)) });
        }
      }
    } else if (t.startsWith("<w:p")) {
      if (pStart < 0 && tblStack.length === 0) {
        if (m[1] === "/") blocks.push({ kind: "paragraph", text: "" }); // 自闭合空段
        else pStart = m.index! + t.length;
      }
    } else {
      // 表开标签：不嵌在段落里就**一律压栈**（嵌套表格的深度由此配平——
      // 只有栈归零的那个闭标签才成块；自闭合空表只在顶层成块）。
      if (pStart < 0) {
        if (m[2] === "/") {
          if (tblStack.length === 0) {
            tableCount += 1;
            blocks.push({ kind: "table", index: tableCount, rows: [] }); // 自闭合空表
          }
        } else tblStack.push(m.index! + t.length);
      }
    }
  }
  return blocks;
}

/** 一份文档的解析产物（名录计数 + 块流）。 */
export interface DocxReadDoc {
  readonly paragraphCount: number;
  readonly tableCount: number;
  readonly blocks: readonly DocxReadBlock[];
}

export type DocxReadDocCheck =
  | { readonly ok: true; readonly doc: DocxReadDoc }
  | { readonly ok: false; readonly error: string };

/** unzip 的 xlsx 口径错误 → docx 词汇（加密类教 Word 出路；超大/压缩法类
 *  本就通用原样过；其余归「文件结构损坏」）。 */
function docxZipError(error: string): string {
  if (error.includes("密码")) {
    return "这个文件有密码保护，读取不了——请在 Word 里打开并另存为无密码的 .docx 副本后再试";
  }
  if (error.includes("超大") || error.includes("压缩方式")) return error;
  return "这不是有效的 Word（.docx）文件——文件结构不完整或已损坏";
}

/** 解包并解析整份 docx：word/document.xml → 块流。纯。 */
export function parseDocxDocument(bytes: Uint8Array): DocxReadDocCheck {
  const unzipped = unzipEntries(bytes);
  if (!unzipped.ok) return { ok: false, error: docxZipError(unzipped.error) };
  const document = unzipped.entries.find((e) => e.name === "word/document.xml");
  if (document === undefined) {
    return { ok: false, error: "这不是有效的 Word（.docx）文件——缺少文档内容" };
  }
  const blocks = parseDocxBlocks(new TextDecoder().decode(document.data));
  return {
    ok: true,
    doc: {
      paragraphCount: blocks.filter((b) => b.kind === "paragraph").length,
      tableCount: blocks.filter((b) => b.kind === "table").length,
      blocks,
    },
  };
}

// ---------------------------------------------------------------------------
// B — 工具面：read_docx（make_docx 的读半边；「帮我看下这个 Word 写了什么」
// 场景）。path（必填，相对工作区）+ offset（1 起块）/ limit（缺省 100，硬帽
// 1000）；输出=首行名录（段数·表数）→ 分隔行（块窗口）→ 段落一行一块、
// 表格「表 N（r 行 × c 列）：」+ TSV 网格 → 截断通知（教 offset 翻页）；
// 魔数嗅探：OLE（旧版 .doc）给「另存为 .docx」出路、非 PK 拒。
// ---------------------------------------------------------------------------

/** 块窗口：缺省 100 块（工具结果预算纪律——长文分次读，不一次爆上下文）。 */
export const DOCX_DEFAULT_BLOCK_LIMIT = 100;
/** 块窗口硬帽：单次最多读 1000 块（更大的 limit 钳到帽并如实告知）。 */
export const DOCX_MAX_BLOCK_LIMIT = 1000;

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0] as const;

/** 千分位（1,200）：名录/分隔行/通知里的计数都走它（人读数字）。 */
function fmtCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** 读工作区里现有的 Word 文档（.docx），把段落与表格变成带结构的文本进上
 * 下文。顶级只读工具（tools.ts 固定钉位）；路径必经 resolveWorkspacePath
 * （外逃/绝对路径 typed 拒，fail-closed）；与 make_docx 组成「读→想→写」
 * 闭环。读面姿态与写面相反：只读/并发安全/非破坏/非开放世界。 */
export function createReadDocxTool(workspaceRoot: string): Tool {
  return buildTool({
    name: "read_docx",
    promptSnippet: "read a Word document as structured text",
    description:
      "读取工作区里现有的 Word 文档（.docx），把里面的段落和表格变成带结构的文本，用于查看、核对、摘录、总结和再加工——「帮我看下 / 总结 / 提取这个 Word 里写了什么」类请求都用它；与生成 Word 的 make_docx 相对，两者合起来可完成「读现有文档 → 整理 → 给出新文档」。" +
      " path 是文件相对工作区的路径。offset / limit 可选：按「块」翻页（一个段落或一张表格各算一块），从第几块开始（1 起）与这次最多读多少块——长文档分几次读，文件开头会先给出段落总数和表格总数，方便决定读多少。" +
      " 注意：只读文字内容和表格数据，图片、样式、批注、页眉页脚不读；编号列表和项目符号读出来是普通文字（层级不还原）；表格里的空单元格读出来是空白。旧版 .doc 格式读取不了，需先在 Word 里另存为 .docx。",
    // 读面四布尔：只读、并发安全（多路同时读互不干扰）、非破坏、本地
    // 文件系统（非开放世界）——与 make_docx 写面姿态逐项相反。
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    isOpenWorld: () => false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Word 文档路径（相对工作区，可带子目录），.docx 文件。" },
        offset: { type: "number", description: "从第几块开始读（1 起；段落和表格各算一块）；缺省第 1 块。" },
        limit: { type: "number", description: `这次最多读多少块；缺省 ${DOCX_DEFAULT_BLOCK_LIMIT}，最大 ${DOCX_MAX_BLOCK_LIMIT}（更大也会按这个上限读）。` },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args) {
      // 参数 typed 校验（先于任何盘副作用）。
      const rawPath = args["path"];
      if (typeof rawPath !== "string" || rawPath.trim() === "") {
        return { content: 'read_docx: "path" must be a non-empty path relative to the workspace', isError: true };
      }
      const rel = rawPath.trim();

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
        limit = positiveInt("limit", args["limit"]) ?? DOCX_DEFAULT_BLOCK_LIMIT;
      } catch (err) {
        return { content: `read_docx: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      limit = Math.min(limit, DOCX_MAX_BLOCK_LIMIT); // 硬帽（截断通知如实反映实读窗口）

      // 工作区边界（外逃/绝对路径/符号链接诡计拒）。
      const resolved = await resolveWorkspacePath(workspaceRoot, rel);
      if (!resolved.ok) return { content: `read_docx: ${resolved.error}`, isError: true };

      let bytes: Uint8Array;
      try {
        bytes = await readFile(resolved.absPath);
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return { content: `read_docx: 文件不存在：${rel}`, isError: true };
        }
        return { content: `read_docx: 读取失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
      }

      // 魔数嗅探先于结构解析：旧版 .doc（OLE 复合文档）与「根本不是 Word」
      // 分开拒——前者有出路（另存为 .docx），说清楚。
      if (bytes.length >= 4 && OLE_MAGIC.every((b, i) => bytes[i] === b)) {
        return {
          content: `read_docx: ${rel} 是旧版 .doc 格式，读取不了——请先用 Word 打开并「另存为」.docx 格式后再试`,
          isError: true,
        };
      }
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
        return {
          content: `read_docx: ${rel} 不是 Word（.docx）文档——如果它是旧版 .doc 或其他格式，请先在 Word 里另存为 .docx 再试`,
          isError: true,
        };
      }

      const parsed = parseDocxDocument(bytes);
      if (!parsed.ok) return { content: `read_docx: ${parsed.error}`, isError: true };
      const doc = parsed.doc;
      const total = doc.blocks.length;

      if (total === 0) {
        return {
          content: [`文档：${basename(rel)}（${fmtCount(doc.paragraphCount)} 段 · ${fmtCount(doc.tableCount)} 表）`, "──（空文档）──"].join("\n"),
        };
      }
      if (offset > total) {
        return {
          content: `read_docx: 第 ${fmtCount(offset)} 块超出文档范围——这份文档共 ${fmtCount(total)} 块（用 1–${fmtCount(total)} 之间的 offset）`,
          isError: true,
        };
      }

      const last = Math.min(offset + limit - 1, total);

      // 名录恒在（跨翻页都先看到整份文档的段落/表格盘点）。
      const lines: string[] = [
        `文档：${basename(rel)}（${fmtCount(doc.paragraphCount)} 段 · ${fmtCount(doc.tableCount)} 表）`,
        `── 第 ${fmtCount(offset)}–${fmtCount(last)} 块（共 ${fmtCount(total)} 块）──`,
      ];
      for (let i = offset; i <= last; i++) {
        const block = doc.blocks[i - 1]!;
        if (block.kind === "paragraph") {
          lines.push(block.text);
        } else {
          const cols = block.rows.reduce((m, r) => Math.max(m, r.length), 0);
          lines.push(`表 ${fmtCount(block.index)}（${fmtCount(block.rows.length)} 行 × ${fmtCount(cols)} 列）：`);
          for (const row of block.rows) {
            // 尾部空格剪掉（TSV 行不拖一串制表符）；行内空格保留占位。
            const cells = [...row];
            while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
            lines.push(cells.join("\t"));
          }
        }
      }
      if (last < total) {
        lines.push(`（已截断：显示了第 ${fmtCount(offset)}–${fmtCount(last)} 块，共 ${fmtCount(total)} 块——用 offset=${fmtCount(last + 1)} 继续翻页读取）`);
      }
      return { content: lines.join("\n") };
    },
  });
}

/** log.ts summarize 的对象摘要件（导出给测试直钉）：文件尾名 + 块窗口，形
 *  「报告.docx 第 101–200 块」。纯。 */
export function summarizeDocxWindow(input: Record<string, unknown>): string {
  const parts: string[] = [];
  const path = input["path"];
  if (typeof path === "string" && path.trim() !== "") parts.push(basename(path.trim()));
  const offset = typeof input["offset"] === "number" && Number.isInteger(input["offset"]) && input["offset"] >= 1
    ? input["offset"]
    : 1;
  const limit = typeof input["limit"] === "number" && Number.isInteger(input["limit"]) && input["limit"] >= 1
    ? input["limit"]
    : DOCX_DEFAULT_BLOCK_LIMIT;
  parts.push(`第 ${fmtCount(offset)}–${fmtCount(offset + limit - 1)} 块`);
  return parts.join(" ");
}
