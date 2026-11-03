// ω99-223: #1 — docx 追加面纯层 + 工具面（零依赖）。「在这份报告后面补一
// 节」是高频自然话术，现状只能整份重做（make_docx 从零造，原文档内容全
// 丢）——本面补**追加式编辑**：原文档既有内容字节保真（只缝 word/document.xml
// 一个部件，其余部件原字节过 zip 层），新内容用 doc-docx.ts 的块构造器拼在
// 尾部（export 缝复用，零行为变化）。
//
// 纯层两件：appendDocxBlocks（document.xml 字符串缝补——找**最后一个**
// <w:sectPr 前插；用户文档可有节中断（<w:pPr><w:sectPr> 出现在文中），body
// 级节属性是 body 末子、必在全部中断节之后，故 lastIndexOf 落点=末节内；
// 无 sectPr 形退插 </w:body> 前）+ appendDocx（unzip→缝→smartZip 回装）。
//
// ω99-230: #2 — 回装自 storedZip 换 smartZip（压缩透传）：unzip→meta 变体
// （unzipEntriesWithMeta，原 method/原压缩载荷随行）→ 未改部件原载荷字节
// 直过（用户 Office 存的 deflate 包不再全包重装为 stored——改一处胖数倍
// 的债收口）、改到的 document.xml 按原 method 重压。改动判定内建于
// smartZip（bytesEqual 重推导，本面只统一挂 meta——无信任旗帜）。工具面/
// 门序/收据/summarize 零动（纯层内部替换）。
//
// 纪律（brief 钉，221/222 同款）：
// - 纯层纯函数：不碰时钟（DOS 时间由 doc-zip 钉）、不碰盘（盘只在工具面
//   execute 里 readFile/writeFile）；
// - 原文档字节保真：除 word/document.xml 外的部件逐字节过 zip 层（append-
//   only 精神落到文件层——行业通用做法是整包重序列化，丢未知部件是常态，
//   我们不丢）；条目名序原样（确定性：同输入两次全等）；
// - typed 拒优于静默剥：坏 zip/加密/Zip64/缺部件/无插入锚点直接拒，错误
//   信息用户语（加密类教 Word 另存出路——unzipEntries 本体是 xlsx 口径
//   文案，本面映射词汇，222 读面同款）；
// - 追加内容用自家版式：新块走 doc-docx.ts 构造器（字号/表格样式是写器
//   的朴素风格，不继承原文档主题字体——v1 边界如实记）；
// - 现共 M 块的计数复用读面 parseDocxBlocks（块 notion 与 read_docx 同源：
//   段落+表格各一块——读写互证落在工具收据上）。
import { smartZip, unzipEntriesWithMeta } from "./doc-zip.js";
import { validateDocDoc, blockXml } from "./doc-docx.js";
import type { DocBlock } from "./doc-docx.js";
import { parseDocxBlocks } from "./doc-docx-read.js";
import { buildTool, resolveWorkspacePath } from "@wudao-org/core";
import type { Tool } from "@wudao-org/core";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

// ---------------------------------------------------------------------------
// A — docx 追加纯层。
// ---------------------------------------------------------------------------

export type AppendDocxCheck =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly totalBlocks: number }
  | { readonly ok: false; readonly error: string };

/** unzip 的 xlsx 口径错误 → docx 词汇（加密类教 Word 出路；超大/压缩法类
 *  本就通用原样过；其余归「文件结构损坏」）——222 读面同款映射，本地实现
 *  （读面/追加面各自的本地件先例：doc-docx-read.ts 同名件）。 */
function docxAppendZipError(error: string): string {
  if (error.includes("密码")) {
    return "这个文件有密码保护，读取不了——请在 Word 里打开并另存为无密码的 .docx 副本后再试";
  }
  if (error.includes("超大") || error.includes("压缩方式")) return error;
  return "这不是有效的 Word（.docx）文件——文件结构不完整或已损坏";
}

/** document.xml 缝补：新块 XML 插在最后一个 <w:sectPr 前（body 级节属性=
 *  body 末子；文中的节中断都在它之前——插这里=落进末节，不切断既有节）；
 *  无 sectPr 形退插 </w:body> 前。纯。 */
export function appendDocxBlocks(documentXml: string, blocks: readonly DocBlock[]): string {
  const insertion = blocks.map((b) => blockXml(b)).join("");
  const sect = documentXml.lastIndexOf("<w:sectPr");
  const at = sect !== -1 ? sect : documentXml.lastIndexOf("</w:body>");
  if (at === -1) return documentXml; // 无锚点：调用方（appendDocx）已前置拒
  return documentXml.slice(0, at) + insertion + documentXml.slice(at);
}

/** 解包→缝→回装整份 docx：只动 word/document.xml，其余部件原字节过 zip 层
 *  （230 起按条目透传原 method——未改部件原压缩载荷直过）。纯函数：不碰
 *  时钟、不碰盘。 */
export function appendDocx(bytes: Uint8Array, blocks: readonly DocBlock[]): AppendDocxCheck {
  const unzipped = unzipEntriesWithMeta(bytes);
  if (!unzipped.ok) return { ok: false, error: docxAppendZipError(unzipped.error) };
  const document = unzipped.entries.find((e) => e.name === "word/document.xml");
  if (document === undefined) {
    return { ok: false, error: "这不是有效的 Word（.docx）文件——缺少文档内容" };
  }
  const xml = new TextDecoder().decode(document.data);
  if (!xml.includes("<w:sectPr") && !xml.includes("</w:body>")) {
    return { ok: false, error: "这不是有效的 Word（.docx）文件——文件结构不完整或已损坏" };
  }
  const newXml = appendDocxBlocks(xml, blocks);
  const enc = new TextEncoder();
  // 每条目统一挂 meta（原条目），已改/未改交给 smartZip 自行比对裁定。
  const parts = unzipped.entries.map((e) =>
    e === document ? { name: e.name, data: enc.encode(newXml), meta: e } : { name: e.name, data: e.data, meta: e },
  );
  return { ok: true, bytes: smartZip(parts), totalBlocks: parseDocxBlocks(newXml).length };
}

// ---------------------------------------------------------------------------
// B — 工具面：append_docx（make_docx 的追加半边；「在这份报告后面补一节」
// 场景）。path（必填，相对工作区）+ blocks（校验复用 make_docx 的
// validateDocDoc schema——同形状同上限）；魔数嗅探：OLE（旧版 .doc）给
// 「另存为 .docx」出路、非 PK 拒；追加只覆写目标文件本身（零删除面）。
// ---------------------------------------------------------------------------

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0] as const;

/** 往工作区里现有的 Word 文档末尾追加内容。顶级工具（tools.ts 固定钉位）；
 *  路径必经 resolveWorkspacePath（外逃/绝对路径 typed 拒，fail-closed）；
 *  校验先于副作用：拒时零写盘。姿态镜像 make_docx 写面（同是写用户文件）。 */
export function createAppendDocxTool(workspaceRoot: string): Tool {
  return buildTool({
    name: "append_docx",
    description:
      "往工作区里现有的 Word 文档（.docx）末尾追加内容：标题、小节、正文、列表、表格都能接着写，文档里已有的内容原样保留。适合「在这份报告后面再补一节」「往这个文档里加几段 / 加张表」类请求；与读文档的 read_docx、生成整份新文档的 make_docx 配套——先读现有内容，再把要补的部分追加进去。" +
      " path 是文档相对工作区的路径。blocks 是要追加的内容块数组（形状与 make_docx 相同：标题 / 小节 / 正文 / 列表项 / 表格五种）。" +
      " 注意：追加的部分用自动版式（字号、表格表头样式自动排好），不会沿用原文档的自定义字体和样式；旧版 .doc 格式不支持，需先在 Word 里另存为 .docx。",
    // 写盘（非只读）；只在本地文件系统（closed-world）。覆写目标文件本身
    // → destructive 诚实标注（make_docx 同款 posture 镜像）。
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    isOpenWorld: () => false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要追加内容的 Word 文档路径（相对工作区，可带子目录），.docx 文件。" },
      },
      required: ["path", "blocks"],
      // blocks 是嵌套对象数组——core 的参数类型只认 string|number|boolean|array
      // （make_docx 同款），走宽松的未知参数道：类型检查在 execute 里由
      // validateDocDoc 做（fail-closed typed 拒）。形状在 description 里文档化。
      additionalProperties: true,
    },
    async execute(args) {
      // 参数 typed 校验（先于任何盘副作用）。
      const rawPath = args["path"];
      if (typeof rawPath !== "string" || rawPath.trim() === "") {
        return { content: 'append_docx: "path" must be a non-empty path relative to the workspace', isError: true };
      }
      const rel = rawPath.trim();

      // blocks：校验复用 make_docx 的 schema（同形状同上限）。
      const checked = validateDocDoc({ blocks: args["blocks"] });
      if (!checked.ok) return { content: `append_docx: ${checked.error}`, isError: true };

      // 工作区边界（外逃/绝对路径/符号链接诡计拒）。
      const resolved = await resolveWorkspacePath(workspaceRoot, rel);
      if (!resolved.ok) return { content: `append_docx: ${resolved.error}`, isError: true };

      let bytes: Uint8Array;
      try {
        bytes = await readFile(resolved.absPath);
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return { content: `append_docx: 文件不存在：${rel}`, isError: true };
        }
        return { content: `append_docx: 读取失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
      }

      // 魔数嗅探先于结构解析：旧版 .doc（OLE 复合文档）与「根本不是 Word」
      // 分开拒——前者有出路（另存为 .docx），说清楚。
      if (bytes.length >= 4 && OLE_MAGIC.every((b, i) => bytes[i] === b)) {
        return {
          content: `append_docx: ${rel} 是旧版 .doc 格式，改不了——请先用 Word 打开并「另存为」.docx 格式后再试`,
          isError: true,
        };
      }
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
        return {
          content: `append_docx: ${rel} 不是 Word（.docx）文档——如果它是旧版 .doc 或其他格式，请先在 Word 里另存为 .docx 再试`,
          isError: true,
        };
      }

      const appended = appendDocx(bytes, checked.doc.blocks);
      if (!appended.ok) return { content: `append_docx: ${appended.error}`, isError: true };

      // 追加=覆写目标文件本身（零删除面；目录已存在——刚读过这文件）。
      try {
        await writeFile(resolved.absPath, appended.bytes);
      } catch (err) {
        return { content: `append_docx: 写入失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
      }
      const kb = (appended.bytes.byteLength / 1024).toFixed(1);
      return {
        // 收据=用户语：一句中文（路径/新增块数/现共块数/大小）+ 结构化字段
        // 一行（前端/审计可解析；文件卡从这行提取）。
        content:
          `已追加到 文档：${rel}（新增 ${checked.doc.blocks.length} 块，现共 ${appended.totalBlocks} 块，${kb} KB）\n` +
          JSON.stringify({
            path: resolved.absPath,
            relativePath: rel,
            appendedBlocks: checked.doc.blocks.length,
            totalBlocks: appended.totalBlocks,
            bytes: appended.bytes.byteLength,
          }),
      };
    },
  });
}

/** log.ts summarize 的对象摘要件（导出给测试直钉）：文件尾名 + 追加量，形
 *  「报告.docx 追加 3 块」。纯。 */
export function summarizeAppendDocx(input: Record<string, unknown>): string {
  const parts: string[] = [];
  const path = input["path"];
  if (typeof path === "string" && path.trim() !== "") parts.push(basename(path.trim()));
  const blocks = input["blocks"];
  if (Array.isArray(blocks)) parts.push(`追加 ${blocks.length} 块`);
  return parts.join(" ");
}
