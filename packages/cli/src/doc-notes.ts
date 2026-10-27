// ω99-238: #2 — pptx 演讲备注纯层 + 工具面（零依赖）。「给 PPT 第 3 页加演
// 讲备注」是办公高频动作：pptx 的 notesSlide 是每 slide 至多一张的外围部件
// （ppt/notesSlides/notesSlideN.xml），slideN.xml.rels 指向它（notesSlide 关
// 系）、它自己的 rels 指回 slide（slide 关系）+ 可指 notesMaster——双向布
// 线。本面把它做成幂等覆写：该页已有 notesSlide → 原位替换其文本（部件名/
// 布线零动）；没有 → 新建部件 + 双向 rels + content-type（碰撞纪律沿 223：
// 部件号扫 max+1，与页号解耦）。
//
// notesMaster 裁定（brief 授权执行者亲证后定，已亲证）：make_pptx 空模板
// （doc-pptx.ts buildPptx）**没有** notesMaster 部件（八件套：content-types/
// 根 rels/docProps×2/presentation+rels/master+rels/layout+rels/theme/slides+
// rels——零 notesMaster）。本面沿包内既有：包里有 notesMaster → notesSlide
// rels 挂上它（rId2）；没有 → **不伪造**（notesSlide rels 只含 slide 回指）
// ——从零捏一个 notesMaster 需要主题链/占位符树/presentation 引用五处布线，
// CI 只能解包互证、无法对真 PowerPoint 验证，半吊子母版比没有母版更危险；
// 真机保真是已声明的诚实边界（§四）。
//
// 读侧 parsePptxNotes（喂 read_pptx 升级）：slide rels → notesSlide target →
// 段落文本（<a:t> 拼接 + <a:br/> 折空格 + \t\r\n 折空格——读面同款纪律）→
// map（slide 部件名 → 备注文本）。无备注的 deck 输出**逐字节不变**（零演
// 进锚——notes 键缺席时 read_pptx 不加行）。
//
// 纪律（brief 钉，221/222/223/228/229/231 同款）：
// - 纯层纯函数：不碰时钟、不碰盘；
// - 原包字节保真：slide 正文部件逐字节过 zip 层（备注是外围部件，正文不
//   动）；条目名序原样（新部件尾续；确定性：同输入两次全等）；
// - typed 拒优于静默剥（错误用户语零实现术语；slide 越界沿用 read_pptx 的
//   超范围文案族）；
// - 校验先于副作用：slide 正整数/text 非空非纯白/控制字符拒（\t \n \r 放
//   行）/text 帽 4,000 码点（防部件炸弹）；
// - 互证（223/229 范式）：回装字节重新解包，走真链——slide rels →
//   notesSlide 部件 → 文本读回等值（读侧同源 parsePptxNotes）。
import { smartZip, unzipEntriesWithMeta } from "./doc-zip.js";
import type { RawZipEntry, SmartZipEntry } from "./doc-zip.js";
import { buildTool, resolveWorkspacePath } from "@wudao/core";
import type { Tool } from "@wudao/core";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

// ---------------------------------------------------------------------------
// A — 校验纯层。
// ---------------------------------------------------------------------------

/** text 长度帽（码点计）：防部件炸弹，非内容审查。 */
export const PPTX_NOTES_TEXT_MAX = 4000;

/** 控制字符政策逐字同 make/replace 面（\t \n \r 放行）。 */
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

export type ValidateNotesCheck =
  | { readonly ok: true; readonly slide: number; readonly text: string }
  | { readonly ok: false; readonly error: string };

/** typed 校验（先于任何盘副作用）：slide 正整数（1 基页码；越界在纯层判—
 *  —那里才知道总页数）；text 非空非纯白、无控制字符、帽 4,000 码点。纯函
 *  数，永不抛。 */
export function validatePptxNotes(rawSlide: unknown, rawText: unknown): ValidateNotesCheck {
  if (typeof rawSlide !== "number" || !Number.isInteger(rawSlide) || rawSlide < 1) {
    return { ok: false, error: '"slide" must be a positive integer (the 1-based slide number)' };
  }
  if (typeof rawText !== "string" || rawText.trim() === "") {
    return { ok: false, error: '"text" must be a non-empty string' };
  }
  if (CONTROL_CHARS.test(rawText)) {
    return { ok: false, error: '"text" contains a control character that cannot go into a document — remove it (tabs and line breaks are fine)' };
  }
  const length = Array.from(rawText).length;
  if (length > PPTX_NOTES_TEXT_MAX) {
    return { ok: false, error: `"text" is limited to ${PPTX_NOTES_TEXT_MAX} characters, got ${length}` };
  }
  return { ok: true, slide: rawSlide, text: rawText };
}

// ---------------------------------------------------------------------------
// B — 备注纯层（结构扫描 + 写侧 setPptxNotes + 读侧 parsePptxNotes）。
// ---------------------------------------------------------------------------

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const RELS_OPEN = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const SLIDE_REL_TYPE = `${NS_R}/slide`;
const NOTES_SLIDE_REL_TYPE = `${NS_R}/notesSlide`;
const NOTES_MASTER_REL_TYPE = `${NS_R}/notesMaster`;
const NOTES_SLIDE_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml";

/** 五实体转义——doc-replace.ts 同款件逐字复制（注释钉同源）。 */
function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&apos;");
}

/** XML 实体解码——读面 doc-pptx-read.ts 同款纪律的本地件。 */
function unescapeXml(s: string): string {
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
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    return named[body] ?? whole;
  });
}

/** 从一个起始标签文本里取属性值（属性序无关；单双引号都认）——229 同款本地件。 */
function attrValue(tag: string, name: string): string | undefined {
  const m =
    new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(tag) ??
    new RegExp(`${name}\\s*=\\s*'([^']*)'`).exec(tag);
  return m?.[1];
}

/** 一个部件的关系部件名（OPC 规：dir/name.ext 的 rels 住 dir/_rels/ 下）。 */
function relsPartFor(part: string): string {
  const slash = part.lastIndexOf("/");
  return slash === -1 ? `_rels/${part}.rels` : `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`;
}

/** 相对 target（../x/y、x/y）按 baseDir 解析成包内部件名（绝对形去头斜杠）。 */
function resolveRelative(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const base = baseDir.split("/");
  for (const seg of target.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") base.pop();
    else base.push(seg);
  }
  return base.join("/");
}

/** 部件名 → 从 fromDir 出发的相对 target 形（../notesSlides/…；同目录退化
 *  裸名）——写 rels 时的 target 生成件（resolveRelative 的逆）。 */
function relativeTarget(fromDir: string, partName: string): string {
  const from = fromDir.split("/");
  const to = partName.split("/");
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  const ups = from.length - common;
  const rest = to.slice(common).join("/");
  return ups === 0 ? rest : `${"../".repeat(ups)}${rest}`;
}

/** unzip 的 xlsx 口径错误 → pptx 词汇（加密类教 PowerPoint 出路）——222/223
 *  同款映射，本地件。 */
function pptxNotesZipError(error: string): string {
  if (error.includes("密码")) {
    return "这个文件有密码保护，读取不了——请在 PowerPoint 里打开并另存为无密码的 .pptx 副本后再试";
  }
  if (error.includes("超大") || error.includes("压缩方式")) return error;
  return "这不是有效的演示文稿（.pptx）文件——文件结构不完整或已损坏";
}

const STRUCTURE_ERROR = "这不是有效的演示文稿（.pptx）文件——文件结构不完整或已损坏";

/** presentation.xml 的 sldIdLst 张序 → 部件名（rels 的 r:id→target 解析）——
 *  读面 parsePptxSlides / 229 slidePartOrder 同款纪律的本地件（复制不重
 *  构，两读面字节零动，228 scanXlsxSheetPart 先例）。 */
function slidePartOrder(
  parts: readonly RawZipEntry[],
): { ok: true; order: readonly string[] } | { ok: false; error: string } {
  const find = (name: string) => parts.find((e) => e.name === name);
  const dec = new TextDecoder();
  const presentationPart = find("ppt/presentation.xml");
  if (presentationPart === undefined) {
    return { ok: false, error: "这不是有效的演示文稿（.pptx）文件——缺少文稿结构" };
  }
  const relsPart = find("ppt/_rels/presentation.xml.rels");
  const rels = new Map<string, string>();
  if (relsPart !== undefined) {
    for (const m of dec.decode(relsPart.data).matchAll(/<Relationship\b[^>]*>/g)) {
      const id = attrValue(m[0], "Id");
      const target = attrValue(m[0], "Target");
      if (id === undefined || target === undefined) continue;
      const normalized = target.startsWith("/") ? target.slice(1) : `ppt/${target.replace(/^\.\//, "")}`;
      rels.set(id, normalized);
    }
  }
  const order: string[] = [];
  for (const m of dec.decode(presentationPart.data).matchAll(/<p:sldId\b[^>]*>/g)) {
    const rid = attrValue(m[0], "r:id");
    const part = rid === undefined ? undefined : rels.get(rid);
    if (part === undefined || find(part) === undefined) {
      return {
        ok: false,
        error: `这不是有效的演示文稿（.pptx）文件——文稿引用了一张缺失的幻灯片（第 ${order.length + 1} 张）`,
      };
    }
    order.push(part);
  }
  if (order.length === 0) {
    return { ok: false, error: "这不是有效的演示文稿（.pptx）文件——没有找到任何幻灯片" };
  }
  return { ok: true, order };
}

/** notesSlide 部件内容：cSld/spTree 内一个 body 占位符形状，每行一段
 *  （<a:p><a:r><a:t>；\r 归一 \n）——PowerPoint 备注窗格的最小同构。纯。 */
function notesSlideXml(text: string): string {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(
      (line) =>
        `<a:p><a:r><a:rPr lang="zh-CN" dirty="0"/><a:t xml:space="preserve">${escapeXml(line)}</a:t></a:r></a:p>`,
    )
    .join("");
  return (
    `${XML_DECL}<p:notes xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">` +
    '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
    '<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>' +
    `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>` +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>'
  );
}

/** 备注文本的读侧折形（读面同款纪律）：每段 <a:t> 拼接（<a:br/> 折空格）、
 *  \t\r\n 折空格、trim、非空段以空格 join——setPptxNotes 互证与
 *  parsePptxNotes 共用同一折形（读写同源）。纯。 */
function foldNotesText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t\r\n]+/g, " ").trim())
    .filter((line) => line !== "")
    .join(" ");
}

/** 读侧：解包条目表 → slide 部件名 → 备注文本映射（slide rels 里的
 *  notesSlide 关系 → 目标部件段落文本折形）。无备注/断链的 slide 缺席（读
 *  面据此零加行——无备注 deck 输出逐字节不变的根）。纯。 */
export function parsePptxNotes(byName: ReadonlyMap<string, Uint8Array>): ReadonlyMap<string, string> {
  const dec = new TextDecoder();
  const out = new Map<string, string>();
  for (const [name, data] of byName) {
    const m = /^ppt\/slides\/_rels\/(slide\d+\.xml)\.rels$/.exec(name);
    if (m === null) continue;
    const slidePart = `ppt/slides/${m[1]!}`;
    const rels = dec.decode(data);
    let notesTarget: string | undefined;
    for (const r of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      if (attrValue(r[0], "Type") === NOTES_SLIDE_REL_TYPE) notesTarget = attrValue(r[0], "Target");
    }
    if (notesTarget === undefined) continue;
    const notesPart = resolveRelative("ppt/slides", notesTarget);
    const notesBytes = byName.get(notesPart);
    if (notesBytes === undefined) continue; // 断链：读面视为无备注（诚实静默——正文照读）
    const xml = dec.decode(notesBytes);
    const paragraphs: string[] = [];
    for (const p of xml.matchAll(/<a:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/a:p>)/g)) {
      // <a:br/> 折空格文本 run（读面 paragraphText 同款纪律）。
      const folded = (p[1] ?? "").replace(/<a:br\b[^>]*?(?:\/>|><\/a:br>)/g, "<a:t> </a:t>");
      let line = "";
      for (const t of folded.matchAll(/<a:t\b[^>]*?(?:\/>|>([\s\S]*?)<\/a:t>)/g)) line += unescapeXml(t[1] ?? "");
      line = line.replace(/[\t\r\n]+/g, " ").trim();
      if (line !== "") paragraphs.push(line);
    }
    if (paragraphs.length > 0) out.set(slidePart, paragraphs.join(" "));
  }
  return out;
}

export type SetPptxNotesCheck =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly partName: string; readonly created: boolean }
  | { readonly ok: false; readonly error: string };

/** 解包→sldIdLst 张序定位目标页→幂等覆写或双向布线新建→smartZip 回装→互证
 *  （读侧同源 parsePptxNotes 走真链读回）。入口自校验（typed 拒在纯层边界，
 *  纵深防御——工具面校验之外的第二道）。纯函数：不碰时钟、不碰盘。 */
export function setPptxNotes(bytes: Uint8Array, slide: number, text: string): SetPptxNotesCheck {
  const checked = validatePptxNotes(slide, text);
  if (!checked.ok) return { ok: false, error: checked.error };
  const unzipped = unzipEntriesWithMeta(bytes);
  if (!unzipped.ok) return { ok: false, error: pptxNotesZipError(unzipped.error) };
  const entries = unzipped.entries;
  const deckOrder = slidePartOrder(entries);
  if (!deckOrder.ok) return { ok: false, error: deckOrder.error };
  if (slide > deckOrder.order.length) {
    return {
      ok: false,
      error: `第 ${slide} 页超出范围——这份演示文稿共 ${deckOrder.order.length} 页（用 1–${deckOrder.order.length} 之间的 slide）`,
    };
  }
  const target = deckOrder.order[slide - 1]!;
  const slideRelsName = relsPartFor(target);
  const slideRelsEntry = entries.find((e) => e.name === slideRelsName);
  const dec = new TextDecoder();
  const slideRelsXml = slideRelsEntry === undefined ? undefined : dec.decode(slideRelsEntry.data);
  if (slideRelsXml !== undefined && !slideRelsXml.includes("</Relationships>")) {
    return { ok: false, error: STRUCTURE_ERROR };
  }

  const enc = new TextEncoder();

  // ——覆写路径：该页已有 notesSlide 关系 → 原位换部件内容，布线零动。——
  if (slideRelsXml !== undefined) {
    let notesPart: string | undefined;
    for (const r of slideRelsXml.matchAll(/<Relationship\b[^>]*>/g)) {
      if (attrValue(r[0], "Type") === NOTES_SLIDE_REL_TYPE) {
        const t = attrValue(r[0], "Target");
        if (t !== undefined) notesPart = resolveRelative("ppt/slides", t);
      }
    }
    if (notesPart !== undefined) {
      const partEntry = entries.find((e) => e.name === notesPart);
      if (partEntry === undefined) return { ok: false, error: STRUCTURE_ERROR };
      const out = smartZip(
        entries.map((e) =>
          e === partEntry ? { name: e.name, data: enc.encode(notesSlideXml(text)), meta: e } : { name: e.name, data: e.data, meta: e },
        ),
      );
      const failure = verifyNotes(out, target, text);
      if (failure !== undefined) return { ok: false, error: failure };
      return { ok: true, bytes: out, partName: notesPart, created: false };
    }
  }

  // ——新建路径：部件号扫 max+1（与页号解耦）→ 三缝：slide rels 尾扩 +
  //  notesSlide rels 新建（slide 回指 + notesMaster 沿包内既有）+ content-type
  //  尾扩 → 新部件对尾续。——
  let nextPart = 0;
  for (const e of entries) {
    const m = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/.exec(e.name);
    if (m !== null) nextPart = Math.max(nextPart, Number.parseInt(m[1]!, 10));
  }
  nextPart += 1;
  const notesPartNew = `ppt/notesSlides/notesSlide${nextPart}.xml`;

  let nextRId = 0;
  if (slideRelsXml !== undefined) {
    for (const m of slideRelsXml.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = attrValue(m[0], "Id");
      const n = id === undefined ? null : /^rId(\d+)$/.exec(id);
      if (n !== null) nextRId = Math.max(nextRId, Number.parseInt(n[1]!, 10));
    }
  }
  nextRId += 1;
  const relAdd = `<Relationship Id="rId${nextRId}" Type="${NOTES_SLIDE_REL_TYPE}" Target="${relativeTarget("ppt/slides", notesPartNew)}"/>`;
  const newSlideRels =
    slideRelsXml === undefined
      ? `${XML_DECL}${RELS_OPEN}${relAdd}</Relationships>`
      : slideRelsXml.replace("</Relationships>", `${relAdd}</Relationships>`);

  // notesMaster 沿包内既有（无则不带——文件头裁定）。
  let master: string | undefined;
  for (const e of entries) {
    if (/^ppt\/notesMasters\/notesMaster\d+\.xml$/.test(e.name)) {
      master = e.name;
      break;
    }
  }
  const backRef = `<Relationship Id="rId1" Type="${SLIDE_REL_TYPE}" Target="${relativeTarget("ppt/notesSlides", target)}"/>`;
  const masterRef = master === undefined ? "" : `<Relationship Id="rId2" Type="${NOTES_MASTER_REL_TYPE}" Target="${relativeTarget("ppt/notesSlides", master)}"/>`;
  const notesRelsPart = relsPartFor(notesPartNew);

  const ctEntry = entries.find((e) => e.name === "[Content_Types].xml");
  if (ctEntry === undefined) return { ok: false, error: STRUCTURE_ERROR };
  const ctXml = dec.decode(ctEntry.data);
  if (!ctXml.includes("</Types>")) return { ok: false, error: STRUCTURE_ERROR };
  const ctAdd = `<Override PartName="/${notesPartNew}" ContentType="${NOTES_SLIDE_CONTENT_TYPE}"/>`;
  const newCt = ctXml.replace("</Types>", `${ctAdd}</Types>`);

  const parts: SmartZipEntry[] = entries.map((e) => {
    if (slideRelsEntry !== undefined && e === slideRelsEntry) return { name: e.name, data: enc.encode(newSlideRels), meta: e };
    if (e === ctEntry) return { name: e.name, data: enc.encode(newCt), meta: e };
    return { name: e.name, data: e.data, meta: e };
  });
  parts.push({ name: notesPartNew, data: enc.encode(notesSlideXml(text)) });
  parts.push({ name: notesRelsPart, data: enc.encode(`${XML_DECL}${RELS_OPEN}${backRef}${masterRef}</Relationships>`) });
  const out = smartZip(parts);
  const failure = verifyNotes(out, target, text);
  if (failure !== undefined) return { ok: false, error: failure };
  return { ok: true, bytes: out, partName: notesPartNew, created: true };
}

/** 互证（223/229 范式）：回装字节重新解包，走真链——slide rels → notesSlide
 *  部件在场 → 文本读回等值（parsePptxNotes 读侧同源折形）+ slide 本体在
 *  场。任一环断 → 结构拒。纯。 */
function verifyNotes(bytes: Uint8Array, slidePart: string, text: string): string | undefined {
  const unzipped = unzipEntriesWithMeta(bytes);
  if (!unzipped.ok) return STRUCTURE_ERROR;
  const byName = new Map(unzipped.entries.map((e) => [e.name, e] as const));
  if (byName.get(slidePart) === undefined) return STRUCTURE_ERROR;
  const notes = parsePptxNotes(new Map([...byName.entries()].map(([name, e]) => [name, e.data] as const)));
  if (notes.get(slidePart) !== foldNotesText(text)) return STRUCTURE_ERROR;
  return undefined;
}

// ---------------------------------------------------------------------------
// C — 工具面：set_pptx_notes。path（必填，相对工作区）+ slide（1 基页码）+
// text（非空，帽 4,000）；魔数嗅探：OLE（旧版 .ppt）给「另存为 .pptx」出
// 路、非 PK 拒；覆写只落目标文件本身（零删除面）。
// ---------------------------------------------------------------------------

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0] as const;

/** 收据预览：前 20 字（码点计）+ 超长「…」（brief §二钉形）。纯。 */
function receiptPreview(text: string): string {
  const chars = Array.from(text);
  return chars.slice(0, 20).join("") + (chars.length > 20 ? "…" : "");
}

/** 设置工作区里现有演示文稿某一页的演讲备注。顶级工具（doc 名册尾——
 *  tools.ts 双段展开自动随名册进尾段）；路径必经 resolveWorkspacePath；校验
 *  先于副作用：拒时零写盘。姿态镜像 replace_pptx 写面。 */
export function createSetPptxNotesTool(workspaceRoot: string): Tool {
  return buildTool({
    name: "set_pptx_notes",
    description:
      "设置 PPT 某一页的演讲备注（已有则替换）。适合「给 PPT 第 3 页加演讲备注」「这页要讲的重点帮我记上」类请求；与读取的 read_pptx 配套（备注会随读面一起读出来）。" +
      " path 是演示文稿相对工作区的路径。slide 是第几页（1 起）。text 是备注内容（1–4000 字，可换行）。" +
      " 注意：只写演讲者备注，不改页面上的内容；重复设置同一页会替换旧备注；旧版 .ppt 格式不支持，需先在 PowerPoint 里另存为 .pptx。",
    // 写盘（非只读）；只在本地文件系统（closed-world）。覆写目标文件本身
    // → destructive 诚实标注（make_*/replace_* 同款 posture 镜像）。
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    isOpenWorld: () => false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "演示文稿路径（相对工作区，可带子目录），.pptx 文件。" },
        slide: { type: "number", description: "要设置备注的页码（1 起始，超出总页数会拒）。" },
        text: { type: "string", description: "备注内容（1–4000 字，可换行）。" },
      },
      required: ["path", "slide", "text"],
      additionalProperties: false,
    },
    async execute(args) {
      // 参数 typed 校验（先于任何盘副作用）。
      const rawPath = args["path"];
      if (typeof rawPath !== "string" || rawPath.trim() === "") {
        return { content: 'set_pptx_notes: "path" must be a non-empty path relative to the workspace', isError: true };
      }
      const rel = rawPath.trim();
      const checked = validatePptxNotes(args["slide"], args["text"]);
      if (!checked.ok) return { content: `set_pptx_notes: ${checked.error}`, isError: true };

      // 工作区边界（外逃/绝对路径/符号链接诡计拒）。
      const resolved = await resolveWorkspacePath(workspaceRoot, rel);
      if (!resolved.ok) return { content: `set_pptx_notes: ${resolved.error}`, isError: true };

      let bytes: Uint8Array;
      try {
        bytes = await readFile(resolved.absPath);
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return { content: `set_pptx_notes: 文件不存在：${rel}`, isError: true };
        }
        return { content: `set_pptx_notes: 读取失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
      }

      // 魔数嗅探先于结构解析：旧版 .ppt（OLE 复合文档）与「根本不是演示文
      // 稿」分开拒——前者有出路（另存为 .pptx），说清楚。
      if (bytes.length >= 4 && OLE_MAGIC.every((b, i) => bytes[i] === b)) {
        return {
          content: `set_pptx_notes: ${rel} 是旧版 .ppt 格式，改不了——请先用 PowerPoint 打开并「另存为」.pptx 格式后再试`,
          isError: true,
        };
      }
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
        return {
          content: `set_pptx_notes: ${rel} 不是演示文稿（.pptx）文件——如果它是旧版 .ppt 或其他格式，请先在 PowerPoint 里另存为 .pptx 再试`,
          isError: true,
        };
      }

      const out = setPptxNotes(bytes, checked.slide, checked.text);
      if (!out.ok) return { content: `set_pptx_notes: ${out.error}`, isError: true };

      // 设置=覆写目标文件本身（零删除面；目录已存在——刚读过这文件）。
      try {
        await writeFile(resolved.absPath, out.bytes);
      } catch (err) {
        return { content: `set_pptx_notes: 写入失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
      }
      return {
        // 收据=用户语（brief §二逐字）+ 结构化字段一行（文件卡从这行提取）。
        content:
          `第 ${checked.slide} 页备注已设置：「${receiptPreview(checked.text)}」\n` +
          JSON.stringify({
            path: resolved.absPath,
            relativePath: rel,
            slide: checked.slide,
            bytes: out.bytes.byteLength,
          }),
      };
    },
  });
}

/** log.ts summarize 的对象摘要件（导出给测试直钉）：文件尾名 + 动作，形
 *  「路演.pptx 设置了第 2 页备注」（brief §二：设置了第 N 页备注）。纯。 */
export function summarizeSetPptxNotes(input: Record<string, unknown>): string {
  const parts: string[] = [];
  const path = input["path"];
  if (typeof path === "string" && path.trim() !== "") parts.push(basename(path.trim()));
  const slide = input["slide"];
  if (typeof slide === "number" && Number.isInteger(slide) && slide >= 1) {
    parts.push(`设置了第 ${slide} 页备注`);
  }
  return parts.join(" ");
}
