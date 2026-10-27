// ω99-222: #4 — pptx 读面纯层 + 工具面（零依赖）。演示文稿（.pptx）与
// xlsx/docx 同为 OOXML zip：解压复用 doc-zip.ts 的 unzipEntries（222 起的
// 共享地基），之上是幻灯片清单结构——presentation.xml 的 <p:sldIdLst> 给
// 张序，ppt/_rels/presentation.xml.rels 给 r:id→部件路径（**不假设
// slideN.xml 编号=顺序**，221 workbook 同款纪律；PowerPoint 只保证 sldIdLst
// 次序）。每张读 <a:p> 段落=一行（run 拼接；标题/正文/表格格不区分占位符
// 类型——按文档序照读，v1 边界如实记）。
//
// 工具面 read_pptx（make_pptx 的读半边；「帮我看下这个 PPT 都写了什么」
// 场景）：path（必填，相对工作区）+ offset/limit（**按张**，1 起，缺省全部、
// 硬帽 100 张）；输出=名录（张数）→ 每张「第 N 张」+ 段落行（缩进两格）→
// 截断通知（教 offset 翻页）；魔数嗅探：OLE（旧版 .ppt）给「另存为 .pptx」
// 出路、非 PK 拒。
//
// 纪律（brief 钉，221 同款）：
// - 纯层纯函数；typed 拒优于静默剥（错误用户语零实现术语）；
// - 自闭合标签全用非贪婪形（<a:p/> 误当开标签会吞后续内容）；
// - 读夹具反哺：本层与 doc-pptx.ts 写器同源互测（buildPptx 造 roundtrip）。
import { unzipEntries } from "./doc-zip.js";
// ω99-238: #3 — 演讲备注读缝：parsePptxNotes（doc-notes.ts 的读侧纯层）解析
// slide→notesSlide 关系，read_pptx 的每张段落在内容之后追加「备注：<text>」
// 行。无备注的 slide notes 键缺席 → 输出零加行（无备注 deck 的 read_pptx
// 输出逐字节不变——零演进锚，升级前输出已抓取落盘对照）。
import { parsePptxNotes } from "./doc-notes.js";
import { buildTool, resolveWorkspacePath } from "@wudao/core";
import type { Tool } from "@wudao/core";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

// ---------------------------------------------------------------------------
// A — pptx 结构纯层（sldIdLst 张序 + rels 映射 + 每张段落行）。
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

/** 从一个起始标签文本里取属性值（属性序无关；单双引号都认；实体解码）。 */
function attrValue(tag: string, name: string): string | undefined {
  const m =
    new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(tag) ??
    new RegExp(`${name}\\s*=\\s*'([^']*)'`).exec(tag);
  return m?.[1] !== undefined ? decodeXmlEntities(m[1]) : undefined;
}

/** 一段（<a:p> 内文）→ 文本：全部 <a:t>（含多 run）顺序拼接；<a:br/> 合成
 *  空格文本 run（空格必须落在 <a:t> 里才进拼接——不粘字）；首尾空白剪除；
 *  实体解码。纯。 */
function paragraphText(inner: string): string {
  const breaks = inner.replace(/<a:br\b[^>]*?(?:\/>|><\/a:br>)/g, "<a:t> </a:t>");
  let out = "";
  for (const m of breaks.matchAll(/<a:t\b[^>]*?(?:\/>|>([\s\S]*?)<\/a:t>)/g)) {
    out += decodeXmlEntities(m[1] ?? "");
  }
  return out.trim();
}

/** 一张幻灯片的解析产物：paragraphs=非空段落文本行（空段剔除不算行——
 *  张内空段是版式噪音，非内容）；notes=该张的演讲备注折形文本（ω99-238；
 *  无备注/断链时键缺席——读面据此零加行，无备注 deck 输出逐字节不变）。 */
export interface PptxReadSlide {
  readonly paragraphs: readonly string[];
  readonly notes?: string;
}

export type PptxSlidesCheck =
  | { readonly ok: true; readonly slides: readonly PptxReadSlide[] }
  | { readonly ok: false; readonly error: string };

/** unzip 的 xlsx 口径错误 → pptx 词汇（加密类教 PowerPoint 出路；超大/
 *  压缩法类本就通用原样过；其余归「文件结构损坏」）。 */
function pptxZipError(error: string): string {
  if (error.includes("密码")) {
    return "这个文件有密码保护，读取不了——请在 PowerPoint 里打开并另存为无密码的 .pptx 副本后再试";
  }
  if (error.includes("超大") || error.includes("压缩方式")) return error;
  return "这不是有效的演示文稿（.pptx）文件——文件结构不完整或已损坏";
}

/** 解包并解析整副演示文稿：sldIdLst 顺序（rels 的 r:id→target 解析部件，
 *  target 相对 ppt/，兼容绝对形）→ 每张段落行。纯。 */
export function parsePptxSlides(bytes: Uint8Array): PptxSlidesCheck {
  const unzipped = unzipEntries(bytes);
  if (!unzipped.ok) return { ok: false, error: pptxZipError(unzipped.error) };
  const byName = new Map<string, Uint8Array>();
  for (const e of unzipped.entries) byName.set(e.name, e.data);
  const dec = new TextDecoder();

  const presentationBytes = byName.get("ppt/presentation.xml");
  if (presentationBytes === undefined) {
    return { ok: false, error: "这不是有效的演示文稿（.pptx）文件——缺少文稿结构" };
  }
  const presentation = dec.decode(presentationBytes);

  // r:id → 部件路径（相对 ppt/ 目录解析；绝对 target 去头斜杠）。
  const relsBytes = byName.get("ppt/_rels/presentation.xml.rels");
  const rels = new Map<string, string>();
  if (relsBytes !== undefined) {
    for (const m of dec.decode(relsBytes).matchAll(/<Relationship\b[^>]*>/g)) {
      const id = attrValue(m[0], "Id");
      const target = attrValue(m[0], "Target");
      if (id === undefined || target === undefined) continue;
      const normalized = target.startsWith("/")
        ? target.slice(1)
        : `ppt/${target.replace(/^\.\//, "")}`;
      rels.set(id, normalized);
    }
  }

  // sldIdLst 次序=张序（编号与顺序无关）；每张部件经 rels 解析。
  // 演讲备注（ω99-238）：读侧同源 parsePptxNotes 一次扫全包（slide 部件名 →
  // 备注文本）；无备注的 slide 缺席 → 零加行。
  const notesMap = parsePptxNotes(byName);
  const slides: PptxReadSlide[] = [];
  for (const m of presentation.matchAll(/<p:sldId\b[^>]*>/g)) {
    const rid = attrValue(m[0], "r:id");
    if (rid === undefined) continue;
    const part = rels.get(rid);
    const partBytes = part === undefined ? undefined : byName.get(part);
    if (partBytes === undefined) {
      return { ok: false, error: `这不是有效的演示文稿（.pptx）文件——文稿引用了一张缺失的幻灯片（第 ${slides.length + 1} 张）` };
    }
    const paragraphs: string[] = [];
    for (const p of dec.decode(partBytes).matchAll(/<a:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/a:p>)/g)) {
      const text = paragraphText(p[1] ?? "").replace(/[\t\r\n]+/g, " ");
      if (text !== "") paragraphs.push(text);
    }
    const notes = part === undefined ? undefined : notesMap.get(part);
    slides.push(notes === undefined ? { paragraphs } : { paragraphs, notes });
  }
  if (slides.length === 0) {
    return { ok: false, error: "这不是有效的演示文稿（.pptx）文件——没有找到任何幻灯片" };
  }
  return { ok: true, slides };
}

// ---------------------------------------------------------------------------
// B — 工具面：read_pptx（按张开窗；缺省全部、硬帽 100 张）。
// ---------------------------------------------------------------------------

/** 张窗硬帽：单次最多读 100 张（更大的 limit 钳到帽并如实告知）。 */
export const PPTX_MAX_SLIDE_LIMIT = 100;

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0] as const;

/** 千分位（1,200）：名录/张头/通知里的计数都走它（人读数字）。 */
function fmtCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** 读工作区里现有的演示文稿（.pptx），把每页文字变成文本进上下文。顶级
 * 只读工具（tools.ts 固定钉位）；路径必经 resolveWorkspacePath（外逃/绝对
 * 路径 typed 拒，fail-closed）；与 make_pptx 组成「读→想→写」闭环。读面
 * 姿态与写面相反：只读/并发安全/非破坏/非开放世界。 */
export function createReadPptxTool(workspaceRoot: string): Tool {
  return buildTool({
    name: "read_pptx",
    description:
      "读取工作区里现有的演示文稿（.pptx），把每一页的文字内容变成文本，用于查看、核对、摘录、总结和再加工——「帮我看下 / 总结 / 提取这个 PPT 都写了什么」类请求都用它；与生成演示文稿的 make_pptx 相对，两者合起来可完成「读现有 PPT → 整理 → 给出新 PPT」。" +
      " path 是文件相对工作区的路径。offset / limit 可选：按「张」翻页——从第几张开始读（1 起）与这次最多读多少张；缺省从第 1 张读到结尾（单次最多 100 张，更多分次读）。" +
      " 注意：只读每页的文字（标题、要点、表格里的文字都按页面顺序读出来）和该页的演讲备注（有备注时在页内容后面以「备注：」行读出），图片、图表、动画、样式不读；项目符号读出来是普通文字行（层级不还原）。旧版 .ppt 格式读取不了，需先在 PowerPoint 里另存为 .pptx。",
    // 读面四布尔：只读、并发安全（多路同时读互不干扰）、非破坏、本地
    // 文件系统（非开放世界）——与 make_pptx 写面姿态逐项相反。
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    isOpenWorld: () => false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "演示文稿路径（相对工作区，可带子目录），.pptx 文件。" },
        offset: { type: "number", description: "从第几张开始读（1 起）；缺省第 1 张。" },
        limit: { type: "number", description: `这次最多读多少张；缺省读到结尾，单次最多 ${PPTX_MAX_SLIDE_LIMIT} 张（更大也会按这个上限读）。` },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args) {
      // 参数 typed 校验（先于任何盘副作用）。
      const rawPath = args["path"];
      if (typeof rawPath !== "string" || rawPath.trim() === "") {
        return { content: 'read_pptx: "path" must be a non-empty path relative to the workspace', isError: true };
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
      let limit: number | undefined;
      try {
        offset = positiveInt("offset", args["offset"]) ?? 1;
        limit = positiveInt("limit", args["limit"]);
      } catch (err) {
        return { content: `read_pptx: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      // 缺省=全部；硬帽 100（截断通知如实反映实读窗口）。
      const effectiveLimit = Math.min(limit ?? Number.MAX_SAFE_INTEGER, PPTX_MAX_SLIDE_LIMIT);

      // 工作区边界（外逃/绝对路径/符号链接诡计拒）。
      const resolved = await resolveWorkspacePath(workspaceRoot, rel);
      if (!resolved.ok) return { content: `read_pptx: ${resolved.error}`, isError: true };

      let bytes: Uint8Array;
      try {
        bytes = await readFile(resolved.absPath);
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return { content: `read_pptx: 文件不存在：${rel}`, isError: true };
        }
        return { content: `read_pptx: 读取失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
      }

      // 魔数嗅探先于结构解析：旧版 .ppt（OLE 复合文档）与「根本不是演示
      // 文稿」分开拒——前者有出路（另存为 .pptx），说清楚。
      if (bytes.length >= 4 && OLE_MAGIC.every((b, i) => bytes[i] === b)) {
        return {
          content: `read_pptx: ${rel} 是旧版 .ppt 格式，读取不了——请先用 PowerPoint 打开并「另存为」.pptx 格式后再试`,
          isError: true,
        };
      }
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
        return {
          content: `read_pptx: ${rel} 不是演示文稿（.pptx）文件——如果它是旧版 .ppt 或其他格式，请先在 PowerPoint 里另存为 .pptx 再试`,
          isError: true,
        };
      }

      const parsed = parsePptxSlides(bytes);
      if (!parsed.ok) return { content: `read_pptx: ${parsed.error}`, isError: true };
      const total = parsed.slides.length;

      if (offset > total) {
        return {
          content: `read_pptx: 第 ${fmtCount(offset)} 张超出范围——这份演示文稿共 ${fmtCount(total)} 张（用 1–${fmtCount(total)} 之间的 offset）`,
          isError: true,
        };
      }

      const last = Math.min(offset + effectiveLimit - 1, total);

      // 名录恒在（跨翻页都先看到整副的张数盘点）。
      const lines: string[] = [`演示：${basename(rel)}（${fmtCount(total)} 张）`];
      for (let i = offset; i <= last; i++) {
        lines.push(`第 ${fmtCount(i)} 张`);
        const slide = parsed.slides[i - 1]!;
        if (slide.paragraphs.length === 0) {
          lines.push("  （无文本）"); // 纯图/空版式张——诚实说无文本，不静默跳过
        } else {
          for (const text of slide.paragraphs) lines.push(`  ${text}`);
        }
        // 演讲备注行（ω99-238）：该张段内、紧跟内容之后；无备注零加行。
        if (slide.notes !== undefined) lines.push(`  备注：${slide.notes}`);
      }
      if (last < total) {
        lines.push(`（已截断：显示了第 ${fmtCount(offset)}–${fmtCount(last)} 张，共 ${fmtCount(total)} 张——用 offset=${fmtCount(last + 1)} 继续翻页读取）`);
      }
      return { content: lines.join("\n") };
    },
  });
}

/** log.ts summarize 的对象摘要件（导出给测试直钉）：文件尾名 + 张窗口，
 *  形「路演.pptx 第 1–12 张」。缺省（无 limit）时总量在结果里不可达——
 *  只报名不编造总数；offset 无 limit 报「第 X 张起」。纯。 */
export function summarizePptxWindow(input: Record<string, unknown>): string {
  const parts: string[] = [];
  const path = input["path"];
  if (typeof path === "string" && path.trim() !== "") parts.push(basename(path.trim()));
  const offset = typeof input["offset"] === "number" && Number.isInteger(input["offset"]) && input["offset"] >= 1
    ? input["offset"]
    : undefined;
  const limit = typeof input["limit"] === "number" && Number.isInteger(input["limit"]) && input["limit"] >= 1
    ? input["limit"]
    : undefined;
  if (limit !== undefined) {
    const from = offset ?? 1;
    parts.push(`第 ${fmtCount(from)}–${fmtCount(from + limit - 1)} 张`);
  } else if (offset !== undefined) {
    parts.push(`第 ${fmtCount(offset)} 张起`);
  }
  return parts.join(" ");
}
