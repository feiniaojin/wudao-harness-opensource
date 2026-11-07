// ω99-223: #2 — pptx 追加面纯层 + 工具面（零依赖）。「帮我在这个 PPT 后面
// 再加几页」现状只能整份重做（make_pptx 从零造，原 deck 内容全丢）——本面
// 补**追加式编辑**：既有页面部件原字节过 zip 层，只缝三个小部件
// （presentation.xml / presentation rels / [Content_Types].xml）+ 尾续新页
// 部件与每页自己的 rels（指向既有版式）。
//
// 四缝（§一.3）：①sldIdLst 扩——</p:sldIdLst> 前插新 <p:sldId id r:id/>；
// ②presentation rels 扩——</Relationships> 前插新 Relationship；③
// [Content_Types].xml 扩——</Types> 前插每新页 Override；④新页部件 +
// ppt/slides/_rels/slideN.xml.rels 指向既有版式（扫第一张页的 rels 取其
// layout target 复用——通常 slideLayout1；零页时退扫版式目录）。
//
// 碰撞纪律（§一.4，载荷级）：新页部件号=扫既有 ppt/slides/slideN.xml 部件
// 名取 max N 再 +1 起（部件名可有空洞，不能数数量）；新 rId=扫 rels 既有
// rIdN 取 max +1 起（rels 还挂着 master/theme 等关系，不能假设页=前 k 个
// rId）；新 sldId id=扫既有 <p:sldId id 取 max +1 起（≥256 族）。
//
// 纪律：纯层纯函数（不碰时钟不碰盘）；typed 拒优于静默剥（错误用户语零实
// 现术语）；新页走 doc-pptx.ts 的 slideXml 构造器（export 缝复用，零行为
// 变化——追加页用写器的朴素版式，不继承用户主题字体/母版样式，v1 边界）。
//
// ω99-230: #3 — 回装自 storedZip 换 smartZip（压缩透传）：unzip→meta 变体
// （unzipEntriesWithMeta）→ 三缝补部件按原 method 重压、未改部件原压缩载荷
// 字节直过、新页部件（无原）缺省 stored——用户 Office 存的 deflate 包不再
// 全包重装为不压缩（改几页胖数倍的债收口）。改动判定内建于 smartZip；工具
// 面/门序/收据/summarize 零动。
import { smartZip, unzipEntriesWithMeta } from "./doc-zip.js";
import type { SmartZipEntry, ZipEntry } from "./doc-zip.js";
import { validateDocDeck, slideXml } from "./doc-pptx.js";
import type { DocSlide } from "./doc-pptx.js";
import { buildTool, resolveWorkspacePath } from "@wudao-org/core";
import type { Tool } from "@wudao-org/core";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

// ---------------------------------------------------------------------------
// A — pptx 追加纯层（四缝 + 三碰撞纪律）。
// ---------------------------------------------------------------------------

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const RELS_OPEN = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
const SLIDE_REL_TYPE = `${NS_R}/slide`;
const SLIDE_LAYOUT_REL_TYPE = `${NS_R}/slideLayout`;
const SLIDE_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";

/** 从一个起始标签文本里取属性值（属性序无关；单双引号都认；实体解码——
 *  读面 doc-pptx-read.ts 同款本地件）。 */
function attrValue(tag: string, name: string): string | undefined {
  const m =
    new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(tag) ??
    new RegExp(`${name}\\s*=\\s*'([^']*)'`).exec(tag);
  return m?.[1];
}

/** 一个部件的关系部件名（OPC 规：dir/name.ext 的 rels 住 dir/_rels/
 *  name.ext.rels——幻灯片部件的版式引用在那里）。 */
function relsPartFor(part: string): string {
  const slash = part.lastIndexOf("/");
  return slash === -1 ? `_rels/${part}.rels` : `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`;
}

/** 演示文稿结构扫描产物：四缝三碰撞所需的全部载荷。 */
interface PptxStructure {
  /** presentation.xml 文本。 */
  readonly presentation: string;
  /** presentation rels 文本。 */
  readonly rels: string;
  /** [Content_Types].xml 文本。 */
  readonly contentTypes: string;
  /** 既有页部件名集合（碰撞纪律：取 max 编号）。 */
  readonly slideNumbers: readonly number[];
  /** 既有 rId 编号集合（取 max）。 */
  readonly rIds: readonly number[];
  /** 既有 sldId id 集合（取 max）。 */
  readonly sldIds: readonly number[];
  /** 新页版式 target（扫第一张页的 rels 复用；零页退扫版式目录）。 */
  readonly layoutTarget: string;
}

export type AppendPptxCheck =
  | {
      readonly ok: true;
      readonly parts: readonly SmartZipEntry[];
      readonly slideNumbers: readonly number[];
      readonly totalSlides: number;
    }
  | { readonly ok: false; readonly error: string };

/** 解出部件列表 → 解码文本 + 扫三碰撞载荷 + 选版式 target。 */
function scanPptx(parts: readonly ZipEntry[]): { ok: true; structure: PptxStructure } | { ok: false; error: string } {
  const dec = new TextDecoder();
  const find = (name: string): ZipEntry | undefined => parts.find((e) => e.name === name);

  const presentationPart = find("ppt/presentation.xml");
  if (presentationPart === undefined) {
    return { ok: false, error: "这不是有效的演示文稿（.pptx）文件——缺少文稿结构" };
  }
  const presentation = dec.decode(presentationPart.data);
  if (!presentation.includes("<p:sldIdLst")) {
    // 零页 deck 无 sldIdLst（读面同口径拒：零页=无效演示文稿——一致处理）。
    return { ok: false, error: "这不是有效的演示文稿（.pptx）文件——没有找到任何幻灯片" };
  }
  const relsPart = find("ppt/_rels/presentation.xml.rels");
  if (relsPart === undefined) {
    return { ok: false, error: "这不是有效的演示文稿（.pptx）文件——缺少文稿结构" };
  }
  const ctPart = find("[Content_Types].xml");
  if (ctPart === undefined) {
    return { ok: false, error: "这不是有效的演示文稿（.pptx）文件——文件结构不完整或已损坏" };
  }
  const rels = dec.decode(relsPart.data);
  const contentTypes = dec.decode(ctPart.data);

  // 碰撞纪律三扫（载荷级：名/编号都可能空洞，一律取 max 不数数量）。
  const slideNumbers: number[] = [];
  for (const e of parts) {
    const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(e.name);
    if (m !== null) slideNumbers.push(Number.parseInt(m[1]!, 10));
  }
  const rIds: number[] = [];
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attrValue(m[0], "Id");
    const n = id === undefined ? null : /^rId(\d+)$/.exec(id);
    if (n !== null && n !== undefined) rIds.push(Number.parseInt(n[1]!, 10));
  }
  const sldIds: number[] = [];
  let firstSlidePart: string | undefined; // sldIdLst 首页部件（版式复用的样本）
  const ridToTarget = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attrValue(m[0], "Id");
    const target = attrValue(m[0], "Target");
    if (id !== undefined && target !== undefined) ridToTarget.set(id, target);
  }
  for (const m of presentation.matchAll(/<p:sldId\b[^>]*>/g)) {
    const id = attrValue(m[0], "id");
    const rid = attrValue(m[0], "r:id");
    if (id !== undefined) sldIds.push(Number.parseInt(id, 10));
    if (firstSlidePart === undefined && rid !== undefined) {
      const target = ridToTarget.get(rid);
      if (target !== undefined) firstSlidePart = `ppt/${target.replace(/^\.\//, "").replace(/^\//, "")}`;
    }
  }

  // 版式 target：扫第一张页的 rels 取其 layout target 复用（新页与第一张
  // 同目录，target 相对形可原样复用；绝对形同引同解析）；零页/首页无版式
  // 时退扫版式目录取最小编号。
  let layoutTarget: string | undefined;
  if (firstSlidePart !== undefined) {
    const slideRels = find(relsPartFor(firstSlidePart));
    if (slideRels !== undefined) {
      for (const m of dec.decode(slideRels.data).matchAll(/<Relationship\b[^>]*>/g)) {
        const type = attrValue(m[0], "Type");
        const target = attrValue(m[0], "Target");
        if (type === SLIDE_LAYOUT_REL_TYPE && target !== undefined) {
          layoutTarget = target;
          break;
        }
      }
    }
  }
  if (layoutTarget === undefined) {
    let minLayout: number | undefined;
    for (const e of parts) {
      const m = /^ppt\/slideLayouts\/slideLayout(\d+)\.xml$/.exec(e.name);
      if (m === null) continue;
      const n = Number.parseInt(m[1]!, 10);
      if (minLayout === undefined || n < minLayout) minLayout = n;
    }
    if (minLayout !== undefined) layoutTarget = `../slideLayouts/slideLayout${minLayout}.xml`;
  }
  if (layoutTarget === undefined) {
    return { ok: false, error: "这不是有效的演示文稿（.pptx）文件——没有可用的页面版式" };
  }

  return {
    ok: true,
    structure: { presentation, rels, contentTypes, slideNumbers, rIds, sldIds, layoutTarget },
  };
}

/** 追加纯层：既有部件原字节过 zip 层，四缝缝补 + 新页部件尾续。返回回装
 *  部件表（smartZip 直用——meta 随行，透传裁定在 smartZip）。纯函数：不
 *  碰时钟、不碰盘。 */
export function appendPptxSlides(
  parts: readonly SmartZipEntry[],
  slides: readonly DocSlide[],
): AppendPptxCheck {
  const scanned = scanPptx(parts);
  if (!scanned.ok) return { ok: false, error: scanned.error };
  const s = scanned.structure;
  const enc = new TextEncoder();

  // 三碰撞起点（既有集合空时用家族下界：部件号 1 / rId 1 / sldId 256）。
  const nextPart = (s.slideNumbers.reduce((m, n) => Math.max(m, n), 0)) + 1;
  const nextRId = (s.rIds.reduce((m, n) => Math.max(m, n), 0)) + 1;
  const nextSldId = Math.max((s.sldIds.reduce((m, n) => Math.max(m, n), 255)) + 1, 256);

  const count = slides.length;
  const newNumbers = slides.map((_, i) => nextPart + i);

  // 缝①：sldIdLst 尾扩（</p:sldIdLst> 前插，张序=尾部）。
  const sldIds = slides
    .map((_, i) => `<p:sldId id="${nextSldId + i}" r:id="rId${nextRId + i}"/>`)
    .join("");
  const presentation = s.presentation.replace("</p:sldIdLst>", `${sldIds}</p:sldIdLst>`);
  // 缝②：presentation rels 尾扩（</Relationships> 前插）。
  const relsAdd = slides
    .map((_, i) => `<Relationship Id="rId${nextRId + i}" Type="${SLIDE_REL_TYPE}" Target="slides/slide${newNumbers[i]}.xml"/>`)
    .join("");
  const rels = s.rels.replace("</Relationships>", `${relsAdd}</Relationships>`);
  // 缝③：Content_Types 尾扩（</Types> 前插每新页 Override）。
  const ctAdd = newNumbers
    .map((n) => `<Override PartName="/ppt/slides/slide${n}.xml" ContentType="${SLIDE_CONTENT_TYPE}"/>`)
    .join("");
  const contentTypes = s.contentTypes.replace("</Types>", `${ctAdd}</Types>`);

  // 三个缝补部件原位替换 + 缝④新页部件与每页 rels 尾续（slide 在前、rels
  // 紧随——buildPptx 的 flatMap 同序；条目名序其余原样=字节保真）。缝补件
  // 用展开保 meta（smartZip 比对出「已改」→ 按原 method 重压）；新页部件无
  // meta（→ 缺省 stored）。
  const out: SmartZipEntry[] = parts.map((e) => {
    if (e.name === "ppt/presentation.xml") return { ...e, data: enc.encode(presentation) };
    if (e.name === "ppt/_rels/presentation.xml.rels") return { ...e, data: enc.encode(rels) };
    if (e.name === "[Content_Types].xml") return { ...e, data: enc.encode(contentTypes) };
    return e;
  });
  for (const [i, slide] of slides.entries()) {
    out.push({ name: `ppt/slides/slide${newNumbers[i]}.xml`, data: enc.encode(slideXml(slide)) });
    out.push({
      name: `ppt/slides/_rels/slide${newNumbers[i]}.xml.rels`,
      data: enc.encode(`${XML_DECL}${RELS_OPEN}<Relationship Id="rId1" Type="${SLIDE_LAYOUT_REL_TYPE}" Target="${s.layoutTarget}"/></Relationships>`),
    });
  }
  return { ok: true, parts: out, slideNumbers: newNumbers, totalSlides: s.sldIds.length + count };
}

// ---------------------------------------------------------------------------
// B — 工具面：append_pptx（make_pptx 的追加半边；「帮我在这个 PPT 后面
// 再加几页」场景）。path（必填，相对工作区）+ slides（校验复用 make_pptx
// 的 validateDocDeck schema——同形状同上限）；魔数嗅探：OLE（旧版 .ppt）
// 给「另存为 .pptx」出路、非 PK 拒；追加只覆写目标文件本身（零删除面）。
// ---------------------------------------------------------------------------

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0] as const;

/** unzip 的 xlsx 口径错误 → pptx 词汇（加密类教 PowerPoint 出路；超大/
 *  压缩法类本就通用原样过）——读面 doc-pptx-read.ts 同款映射，本地实现。 */
function pptxAppendZipError(error: string): string {
  if (error.includes("密码")) {
    return "这个文件有密码保护，读取不了——请在 PowerPoint 里打开并另存为无密码的 .pptx 副本后再试";
  }
  if (error.includes("超大") || error.includes("压缩方式")) return error;
  return "这不是有效的演示文稿（.pptx）文件——文件结构不完整或已损坏";
}

/** 往工作区里现有的演示文稿末尾追加几页。顶级工具（tools.ts 固定钉位）；
 *  路径必经 resolveWorkspacePath（外逃/绝对路径 typed 拒，fail-closed）；
 *  校验先于副作用：拒时零写盘。姿态镜像 make_pptx 写面。 */
export function createAppendPptxTool(workspaceRoot: string): Tool {
  return buildTool({
    name: "append_pptx",
    promptSnippet: "append slides to an existing presentation",
    description:
      "往工作区里现有的演示文稿（.pptx）末尾追加几页：封面 / 要点 / 表格三种页型都能接着加，已有的页面原样保留。适合「帮我在这个 PPT 后面再加几页」「往这份演示文稿里补两页要点」类请求；与读演示文稿的 read_pptx、生成整份新演示文稿的 make_pptx 配套——先读现有页面，再把要补的页追加进去。" +
      " path 是文件相对工作区的路径。slides 是要追加的页数组（形状与 make_pptx 相同：封面 / 要点 / 表格三种页型）。" +
      " 注意：追加的页用自动版式（16:9 版面、字号、项目符号自动排好），不会沿用原演示文稿的主题字体和母版样式；追加保存后文件体积可能会变大一些（不影响内容）；旧版 .ppt 格式不支持，需先在 PowerPoint 里另存为 .pptx。",
    // 写盘（非只读）；只在本地文件系统（closed-world）。覆写目标文件本身
    // → destructive 诚实标注（make_pptx 同款 posture 镜像）。
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    isOpenWorld: () => false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要追加页的演示文稿路径（相对工作区，可带子目录），.pptx 文件。" },
      },
      required: ["path", "slides"],
      // slides 是嵌套对象数组（make_pptx 同款），走宽松的未知参数道：
      // 类型检查在 execute 里由 validateDocDeck 做（fail-closed typed 拒）。
      additionalProperties: true,
    },
    async execute(args) {
      // 参数 typed 校验（先于任何盘副作用）。
      const rawPath = args["path"];
      if (typeof rawPath !== "string" || rawPath.trim() === "") {
        return { content: 'append_pptx: "path" must be a non-empty path relative to the workspace', isError: true };
      }
      const rel = rawPath.trim();

      // slides：校验复用 make_pptx 的 schema（同形状同上限）。
      const checked = validateDocDeck({ slides: args["slides"] });
      if (!checked.ok) return { content: `append_pptx: ${checked.error}`, isError: true };

      // 工作区边界（外逃/绝对路径/符号链接诡计拒）。
      const resolved = await resolveWorkspacePath(workspaceRoot, rel);
      if (!resolved.ok) return { content: `append_pptx: ${resolved.error}`, isError: true };

      let bytes: Uint8Array;
      try {
        bytes = await readFile(resolved.absPath);
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return { content: `append_pptx: 文件不存在：${rel}`, isError: true };
        }
        return { content: `append_pptx: 读取失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
      }

      // 魔数嗅探先于结构解析。
      if (bytes.length >= 4 && OLE_MAGIC.every((b, i) => bytes[i] === b)) {
        return {
          content: `append_pptx: ${rel} 是旧版 .ppt 格式，改不了——请先用 PowerPoint 打开并「另存为」.pptx 格式后再试`,
          isError: true,
        };
      }
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
        return {
          content: `append_pptx: ${rel} 不是演示文稿（.pptx）文件——如果它是旧版 .ppt 或其他格式，请先在 PowerPoint 里另存为 .pptx 再试`,
          isError: true,
        };
      }

      const unzipped = unzipEntriesWithMeta(bytes);
      if (!unzipped.ok) return { content: `append_pptx: ${pptxAppendZipError(unzipped.error)}`, isError: true };
      // 每条目统一挂 meta（原条目），已改/未改交给 smartZip 自行比对裁定。
      const appended = appendPptxSlides(
        unzipped.entries.map((e) => ({ name: e.name, data: e.data, meta: e })),
        checked.deck.slides,
      );
      if (!appended.ok) return { content: `append_pptx: ${appended.error}`, isError: true };
      const out = smartZip(appended.parts);

      // 追加=覆写目标文件本身（零删除面；目录已存在——刚读过这文件）。
      try {
        await writeFile(resolved.absPath, out);
      } catch (err) {
        return { content: `append_pptx: 写入失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
      }
      const kb = (out.byteLength / 1024).toFixed(1);
      return {
        // 收据=用户语：一句中文（路径/新增页数/现共页数/大小）+ 结构化字段
        // 一行（文件卡从这行提取）。
        content:
          `已追加到 演示文稿：${rel}（新增 ${checked.deck.slides.length} 页，现共 ${appended.totalSlides} 页，${kb} KB）\n` +
          JSON.stringify({
            path: resolved.absPath,
            relativePath: rel,
            appendedSlides: checked.deck.slides.length,
            totalSlides: appended.totalSlides,
            bytes: out.byteLength,
          }),
      };
    },
  });
}

/** log.ts summarize 的对象摘要件（导出给测试直钉）：文件尾名 + 追加量，形
 *  「路演.pptx 追加 3 页」。纯。 */
export function summarizeAppendPptx(input: Record<string, unknown>): string {
  const parts: string[] = [];
  const path = input["path"];
  if (typeof path === "string" && path.trim() !== "") parts.push(basename(path.trim()));
  const slides = input["slides"];
  if (Array.isArray(slides)) parts.push(`追加 ${slides.length} 页`);
  return parts.join(" ");
}
