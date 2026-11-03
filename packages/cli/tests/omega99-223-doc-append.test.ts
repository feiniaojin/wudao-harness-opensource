// ω99-223: #R1 — append_docx / append_pptx receipts（六层：回装保真 / docx
// 缝补 / pptx 缝补 / 确定性 / 工具面 / summarize）。RED-first。
// ★测试红线：夹具全内存（buildDocx/buildPptx 造原文档→append→读回）或
// os.tmpdir() 临时工作区只写不删；绝不碰用户真实文档；零 rm（tmpdir 只写
// 不删）；零第三方依赖（node 内建）。读写互证：append 完用 222 的
// parseDocxBlocks/parsePptxSlides 读回（自家读面验自家写面）。
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@wudao-org/core";
// 写面原语（追加复用的构造器与校验 schema 都在写面文件）。
import { buildDocx } from "../src/doc-docx.js";
import type { DocBlock } from "../src/doc-docx.js";
import type { DocDeck } from "../src/doc-pptx.js";
import { buildPptx } from "../src/doc-pptx.js";
// 本弧两追加面。
import {
  appendDocx,
  appendDocxBlocks,
  createAppendDocxTool,
  summarizeAppendDocx,
} from "../src/doc-docx-append.js";
import {
  appendPptxSlides,
  createAppendPptxTool,
  summarizeAppendPptx,
} from "../src/doc-pptx-append.js";
// 读面（读写互证）。
import { parseDocxBlocks, parseDocxDocument } from "../src/doc-docx-read.js";
import { parsePptxSlides } from "../src/doc-pptx-read.js";
// zip 地基 + 消费面。
import { crc32, storedZip, unzipEntries } from "../src/doc-zip.js";
import { summarizeToolCall } from "../src/log.js";
import { FILE_EDIT_TOOLS, decidePermission } from "../src/permission.js";
import { extractFileReceipt } from "../src/driver/file-receipt.js";
import { buildToolSet } from "../src/tools.js";

const enc = new TextEncoder();
const XDECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const exec = async (tool: Tool, args: Record<string, unknown>) => tool.execute(args);

// ---------------------------------------------------------------------------
// 夹具工坊（全内存；零删除）
// ---------------------------------------------------------------------------

type Part = { name: string; data: Uint8Array };

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** EOCD 尾扫→中央目录→逐条读 CD CRC 与本地头 CRC（R1 §1 的链验证件）。 */
function zipCrcs(bytes: Uint8Array): { name: string; cdCrc: number; localCrc: number }[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  expect(eocd).toBeGreaterThanOrEqual(0);
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out: { name: string; cdCrc: number; localCrc: number }[] = [];
  for (let n = 0; n < count; n++) {
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    out.push({ name, cdCrc: dv.getUint32(p + 16, true), localCrc: dv.getUint32(localOffset + 14, true) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 换掉 word/document.xml 的整包 docx（其余部件取自 buildDocx 真产物）。 */
function docxWithDocumentXml(xml: string): Uint8Array {
  const un = unzipEntries(buildDocx({ blocks: [{ kind: "body", text: "占位" }] }));
  if (!un.ok) throw new Error(`fixture unzip failed: ${un.error}`);
  const parts: Part[] = un.entries.map((e) =>
    e.name === "word/document.xml" ? { name: e.name, data: enc.encode(xml) } : e,
  );
  return storedZip(parts);
}

const p = (t: string): string => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;

/** 用户文档形：文中节中断（<w:pPr><w:sectPr>）+ body 末尾节属性——追加必须
 *  插在**最后一个** sectPr 前（落进末节，不切断既有节）。 */
const MID_SECT_XML =
  `${XDECL}<w:document xmlns:w="${NS_W}"><w:body>` +
  p("第一节") +
  `<w:p><w:pPr><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:pPr></w:p>` +
  p("第二节") +
  `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>` +
  `</w:body></w:document>`;

/** 无 sectPr 形（退插 </w:body> 前）。 */
const NO_SECT_XML = `${XDECL}<w:document xmlns:w="${NS_W}"><w:body>${p("唯一段")}</w:body></w:document>`;

/** 手搓单条目 zip（method/flags 可控——加密拒链夹具的底座，221/222 同款）。 */
function singleEntryZip(data: Uint8Array, name: string, method: number, flags: number): Uint8Array {
  const nameBytes = enc.encode(name);
  const localLen = 30 + nameBytes.length + data.length;
  const out = new Uint8Array(localLen + 46 + nameBytes.length + 22);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x04034b50, true);
  dv.setUint16(4, 20, true);
  dv.setUint16(6, flags, true);
  dv.setUint16(8, method, true);
  dv.setUint32(14, crc32(data), true);
  dv.setUint32(18, data.length, true);
  dv.setUint32(22, data.length, true);
  dv.setUint16(26, nameBytes.length, true);
  out.set(nameBytes, 30);
  out.set(data, 30 + nameBytes.length);
  const cd = localLen;
  dv.setUint32(cd, 0x02014b50, true);
  dv.setUint16(cd + 8, flags, true);
  dv.setUint16(cd + 10, method, true);
  dv.setUint32(cd + 16, crc32(data), true);
  dv.setUint32(cd + 20, data.length, true);
  dv.setUint32(cd + 24, data.length, true);
  dv.setUint16(cd + 28, nameBytes.length, true);
  dv.setUint32(cd + 42, 0, true);
  out.set(nameBytes, cd + 46);
  const eocd = cd + 46 + nameBytes.length;
  dv.setUint32(eocd, 0x06054b50, true);
  dv.setUint16(eocd + 8, 1, true);
  dv.setUint16(eocd + 10, 1, true);
  dv.setUint32(eocd + 12, 46 + nameBytes.length, true);
  dv.setUint32(eocd + 16, cd, true);
  return out;
}

/** 三空洞夹具：部件号 slide1/slide3/slide7、rId 空洞（master=rId1、slides=
 *  rId7/9/11、theme=rId5）、sldId 空洞（256/300/400）；slide1 的版式改指
 *  slideLayout2（钉「扫既有页 rels 复用」而非写死 slideLayout1）。 */
function pptxWithHoles(): Uint8Array {
  const deck: DocDeck = {
    slides: [
      { kind: "bullets", title: "页一", bullets: ["一"] },
      { kind: "bullets", title: "页二", bullets: ["二"] },
      { kind: "bullets", title: "页三", bullets: ["三"] },
    ],
  };
  const un = unzipEntries(buildPptx(deck));
  if (!un.ok) throw new Error(`fixture unzip failed: ${un.error}`);
  const dec = new TextDecoder();
  const parts: Part[] = un.entries.map((e) => {
    // 部件名替换序=高→低（slide3→slide7 先、slide2→slide3 后，防链式连跳）。
    const name = e.name.replaceAll("slide3", "slide7").replaceAll("slide2", "slide3");
    if (!e.name.endsWith(".xml") && !e.name.endsWith(".rels")) return { name, data: e.data };
    let text = dec
      .decode(e.data)
      .replaceAll("slide3", "slide7")
      .replaceAll("slide2", "slide3")
      .replaceAll("rId4", "rId11")
      .replaceAll("rId3", "rId9")
      .replaceAll("rId2", "rId7")
      .replaceAll('id="258"', 'id="400"')
      .replaceAll('id="257"', 'id="300"');
    if (e.name === "ppt/slides/_rels/slide1.xml.rels") {
      text = text.replaceAll("../slideLayouts/slideLayout1.xml", "../slideLayouts/slideLayout2.xml");
    }
    return { name, data: enc.encode(text) };
  });
  return storedZip(parts);
}

const NEW_BLOCKS: readonly DocBlock[] = [
  { kind: "heading", text: "补充小节" },
  { kind: "body", text: "追加段" },
  { kind: "bullet", text: "一条要点" },
  { kind: "table", columns: [{ header: "列一" }], rows: [["值"]] },
];

const NEW_SLIDES: DocDeck["slides"] = [
  { kind: "bullets", title: "新页甲", bullets: ["甲一"] },
  { kind: "cover", title: "新页乙", subtitle: "收尾" },
];

/** 解出的条目按名索引（append 后查部件用）。 */
function byName(bytes: Uint8Array): Map<string, Uint8Array> {
  const un = unzipEntries(bytes);
  if (!un.ok) throw new Error(`unzip failed: ${un.error}`);
  return new Map(un.entries.map((e) => [e.name, e.data]));
}

// ---------------------------------------------------------------------------
// §1 回装保真：unzip→storedZip 回装→再 unzip，未动部件逐字节等；CRC 链全绿。
// ---------------------------------------------------------------------------

describe("ω99-223 §1 回装保真（unzip→storedZip→unzip；CRC 链）", () => {
  it("docx：回装后部件名序与数据逐字节等（回装不丢不改任何部件）", () => {
    const original = buildDocx({ blocks: [{ kind: "body", text: "原文" }] });
    const a = unzipEntries(original);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const rebuilt = storedZip(a.entries);
    const b = unzipEntries(rebuilt);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.entries.map((e) => e.name)).toEqual(a.entries.map((e) => e.name));
    for (const [i, e] of b.entries.entries()) {
      expect(bytesEqual(e.data, a.entries[i]!.data)).toBe(true);
    }
  });

  it("pptx：回装后部件名序与数据逐字节等", () => {
    const original = pptxWithHoles();
    const a = unzipEntries(original);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const b = unzipEntries(storedZip(a.entries));
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.entries.map((e) => e.name)).toEqual(a.entries.map((e) => e.name));
    for (const [i, e] of b.entries.entries()) {
      expect(bytesEqual(e.data, a.entries[i]!.data)).toBe(true);
    }
  });

  it("CRC 链全绿：中央目录 CRC = 本地头 CRC = crc32(数据)（每部件）", () => {
    const original = pptxWithHoles();
    const un = unzipEntries(original);
    expect(un.ok).toBe(true);
    if (!un.ok) return;
    const rebuilt = storedZip(un.entries);
    const datas = byName(original);
    const rows = zipCrcs(rebuilt);
    expect(rows.length).toBe(datas.size);
    for (const row of rows) {
      const data = datas.get(row.name);
      expect(data).toBeDefined();
      const want = crc32(data!);
      expect(row.cdCrc).toBe(want);
      expect(row.localCrc).toBe(want);
    }
  });
});

// ---------------------------------------------------------------------------
// §2 docx 缝补：追加块序正确落尾部；节中断夹具插最后一个 sectPr 前；无
// sectPr 退 </w:body>；既有部件原字节过 zip 层；读回互证。
// ---------------------------------------------------------------------------

describe("ω99-223 §2 docx 缝补", () => {
  it("追加块落尾部 + 既有部件原字节过 zip 层（只缝 document.xml 一个部件）", () => {
    const original = buildDocx({
      blocks: [
        { kind: "title", text: "原标题" },
        { kind: "body", text: "原文" },
      ],
    });
    const before = byName(original);
    const appended = appendDocx(original, NEW_BLOCKS);
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    expect(appended.totalBlocks).toBe(6); // 2 段 + 3 段 + 1 表
    const after = byName(appended.bytes);
    expect(after.size).toBe(before.size);
    for (const [name, data] of before) {
      const got = after.get(name);
      expect(got).toBeDefined();
      if (name === "word/document.xml") expect(bytesEqual(got!, data)).toBe(false); // 唯一被缝的部件
      else expect(bytesEqual(got!, data)).toBe(true); // 其余原字节过 zip 层
    }
  });

  it("读写互证：append 后 parseDocxDocument 读回见新块序（段+表）", () => {
    const original = buildDocx({ blocks: [{ kind: "body", text: "原文" }] });
    const appended = appendDocx(original, NEW_BLOCKS);
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    const parsed = parseDocxDocument(appended.bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const texts = parsed.doc.blocks.map((b) => (b.kind === "paragraph" ? b.text : `表${b.index}`));
    expect(texts).toEqual(["原文", "补充小节", "追加段", "• 一条要点", "表1"]);
    const table = parsed.doc.blocks.find((b) => b.kind === "table");
    expect(table && table.kind === "table" ? table.rows : undefined).toEqual([["列一"], ["值"]]);
  });

  it("用户文档节中断夹具：插在最后一个 <w:sectPr 前（不切断既有节）", () => {
    const out = appendDocxBlocks(MID_SECT_XML, [{ kind: "body", text: "追加段" }]);
    // 中断节在前、追加段居中、body 节属性（带页边距的那个）在最后。
    expect(out.indexOf("<w:pPr><w:sectPr")).toBeLessThan(out.indexOf("追加段"));
    expect(out.indexOf("w:pgMar")).toBeGreaterThan(out.indexOf("追加段"));
    // 追加段紧跟「第二节」之后（尾部顺序）。
    expect(out.indexOf("第二节")).toBeLessThan(out.indexOf("追加段"));
    // 纯层读回：文档序最后一段=追加段（读写互证）。
    const blocks = parseDocxBlocks(out);
    const lastText = [...blocks].reverse().find((b) => b.kind === "paragraph" && b.text !== "");
    expect(lastText && lastText.kind === "paragraph" ? lastText.text : "").toBe("追加段");
  });

  it("无 sectPr 形：退插 </w:body> 前", () => {
    const out = appendDocxBlocks(NO_SECT_XML, [{ kind: "body", text: "追加段" }]);
    expect(out.indexOf("唯一段")).toBeLessThan(out.indexOf("追加段"));
    expect(out.indexOf("追加段")).toBeLessThan(out.indexOf("</w:body>"));
    const blocks = parseDocxBlocks(out);
    expect(blocks.filter((b) => b.kind === "paragraph").map((b) => (b as { text: string }).text)).toEqual(["唯一段", "追加段"]);
  });

  it("缺 word/document.xml：typed 拒（用户语）", () => {
    const bad = storedZip([{ name: "[Content_Types].xml", data: enc.encode(`${XDECL}<Types/>`) }]);
    const r = appendDocx(bad, NEW_BLOCKS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("缺少文档内容");
  });

  it("加密拒链：密码保护 → Word 出路文案（词汇映射）", () => {
    const encrypted = singleEntryZip(enc.encode("x"), "word/document.xml", 8, 0x0001);
    const r = appendDocx(encrypted, NEW_BLOCKS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("密码");
    expect(r.error).toContain("Word");
  });
});

// ---------------------------------------------------------------------------
// §3 pptx 缝补：四缝（sldIdLst / presentation rels / Content_Types / 新页
// 部件+每页 rels）+ 三碰撞纪律（部件号 / rId / sldId）；读回互证。
// ---------------------------------------------------------------------------

describe("ω99-223 §3 pptx 缝补（四缝 + 三碰撞纪律）", () => {
  it("四缝齐动 + 读回互证 + 未动部件原字节（buildPptx 真产物夹具）", () => {
    const original = buildPptx({
      slides: [
        { kind: "bullets", title: "页一", bullets: ["一"] },
        { kind: "bullets", title: "页二", bullets: ["二"] },
      ],
    });
    const before = byName(original);
    const un = unzipEntries(original);
    expect(un.ok).toBe(true);
    if (!un.ok) return;
    const r = appendPptxSlides(un.entries, NEW_SLIDES);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.totalSlides).toBe(4);
    const newBytes = storedZip(r.parts);
    const after = byName(newBytes);
    // 新页部件 + 每页 rels 落包。
    expect(after.has("ppt/slides/slide3.xml")).toBe(true);
    expect(after.has("ppt/slides/slide4.xml")).toBe(true);
    expect(after.has("ppt/slides/_rels/slide3.xml.rels")).toBe(true);
    expect(after.has("ppt/slides/_rels/slide4.xml.rels")).toBe(true);
    // 只缝三部件：presentation / presentation rels / [Content_Types]。
    for (const [name, data] of before) {
      const got = after.get(name);
      expect(got).toBeDefined();
      const spliced = name === "ppt/presentation.xml" || name === "ppt/_rels/presentation.xml.rels" || name === "[Content_Types].xml";
      if (spliced) expect(bytesEqual(got!, data)).toBe(false);
      else expect(bytesEqual(got!, data)).toBe(true);
    }
    // Content_Types：每新页一条 Override。
    const ct = new TextDecoder().decode(after.get("[Content_Types].xml")!);
    expect(ct).toContain('PartName="/ppt/slides/slide3.xml"');
    expect(ct).toContain('PartName="/ppt/slides/slide4.xml"');
    // 读回互证：张序=原两页+新两页。
    const parsed = parsePptxSlides(newBytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const titles = parsed.slides.map((s) => s.paragraphs[0] ?? "");
    expect(titles).toEqual(["页一", "页二", "新页甲", "新页乙"]);
  });

  it("部件号空洞夹具：slide1/slide3/slide7 → 新页 slide8 起（扫部件名取 max，不数数量）", () => {
    const fixture = pptxWithHoles();
    const un = unzipEntries(fixture);
    expect(un.ok).toBe(true);
    if (!un.ok) return;
    const r = appendPptxSlides(un.entries, NEW_SLIDES);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.slideNumbers).toEqual([8, 9]);
    const names = new Set(r.parts.map((e) => e.name));
    expect(names.has("ppt/slides/slide8.xml")).toBe(true);
    expect(names.has("ppt/slides/slide9.xml")).toBe(true);
  });

  it("rId 空洞夹具：既有 max=rId11（master1/slides7,9,11/theme5）→ 新 rId12 起", () => {
    const fixture = pptxWithHoles();
    const un = unzipEntries(fixture);
    expect(un.ok).toBe(true);
    if (!un.ok) return;
    const r = appendPptxSlides(un.entries, NEW_SLIDES);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const presentation = new TextDecoder().decode(r.parts.find((e) => e.name === "ppt/presentation.xml")!.data);
    expect(presentation).toContain('r:id="rId12"');
    expect(presentation).toContain('r:id="rId13"');
    const rels = new TextDecoder().decode(r.parts.find((e) => e.name === "ppt/_rels/presentation.xml.rels")!.data);
    expect(rels).toContain('Id="rId12"');
    expect(rels).toContain('Target="slides/slide8.xml"');
  });

  it("sldId 空洞夹具：既有 256/300/400 → 新 id 401 起（≥256 族）", () => {
    const fixture = pptxWithHoles();
    const un = unzipEntries(fixture);
    expect(un.ok).toBe(true);
    if (!un.ok) return;
    const r = appendPptxSlides(un.entries, NEW_SLIDES);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const presentation = new TextDecoder().decode(r.parts.find((e) => e.name === "ppt/presentation.xml")!.data);
    expect(presentation).toContain('<p:sldId id="401"');
    expect(presentation).toContain('<p:sldId id="402"');
    // sldIdLst 序：新页插在 </p:sldIdLst> 前（尾部）。
    expect(presentation.lastIndexOf('<p:sldId id="402"')).toBeLessThan(presentation.indexOf("</p:sldIdLst>"));
  });

  it("每新页 rels 指向既有版式：扫第一张页的 rels 取其 layout target 复用", () => {
    const fixture = pptxWithHoles(); // slide1 的版式被夹具改指 slideLayout2
    const un = unzipEntries(fixture);
    expect(un.ok).toBe(true);
    if (!un.ok) return;
    const r = appendPptxSlides(un.entries, NEW_SLIDES);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const n of [8, 9]) {
      const rels = new TextDecoder().decode(r.parts.find((e) => e.name === `ppt/slides/_rels/slide${n}.xml.rels`)!.data);
      expect(rels).toContain("../slideLayouts/slideLayout2.xml"); // 复用扫描结果，非写死 slideLayout1
    }
  });

  it("空洞夹具读回互证：append 后 parsePptxSlides 张序=原三页+新两页", () => {
    const fixture = pptxWithHoles();
    const un = unzipEntries(fixture);
    expect(un.ok).toBe(true);
    if (!un.ok) return;
    const r = appendPptxSlides(un.entries, NEW_SLIDES);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = parsePptxSlides(storedZip(r.parts));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.slides.length).toBe(5);
    expect(parsed.slides[3]!.paragraphs[0]).toBe("新页甲");
    expect(parsed.slides[4]!.paragraphs[0]).toBe("新页乙");
  });

  it("缺 presentation.xml / 无 sldIdLst：typed 拒（用户语）", () => {
    const noPresentation = storedZip([{ name: "[Content_Types].xml", data: enc.encode(`${XDECL}<Types/>`) }]);
    const empty = unzipEntries(noPresentation);
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    const a = appendPptxSlides(empty.entries, NEW_SLIDES);
    expect(a.ok).toBe(false);
    if (a.ok) return;
    expect(a.error).toContain("演示文稿");

    const fixture = pptxWithHoles();
    const un = unzipEntries(fixture);
    expect(un.ok).toBe(true);
    if (!un.ok) return;
    const noSldIdLst = un.entries.map((e) =>
      e.name === "ppt/presentation.xml"
        ? { name: e.name, data: enc.encode(new TextDecoder().decode(e.data).replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, "")) }
        : e,
    );
    const b = appendPptxSlides(noSldIdLst, NEW_SLIDES);
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.error).toContain("没有找到任何幻灯片");
  });
});

// ---------------------------------------------------------------------------
// §4 确定性：同输入两次 append 全等字节。
// ---------------------------------------------------------------------------

describe("ω99-223 §4 确定性", () => {
  it("docx：同输入两次 append 全等字节", () => {
    const original = buildDocx({ blocks: [{ kind: "body", text: "原文" }] });
    const a = appendDocx(original, NEW_BLOCKS);
    const b = appendDocx(original, NEW_BLOCKS);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(bytesEqual(a.bytes, b.bytes)).toBe(true);
  });

  it("pptx：同输入两次 append 全等字节", () => {
    const fixture = pptxWithHoles();
    const un = unzipEntries(fixture);
    expect(un.ok).toBe(true);
    if (!un.ok) return;
    const a = appendPptxSlides(un.entries, NEW_SLIDES);
    const b = appendPptxSlides(un.entries, NEW_SLIDES);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(bytesEqual(storedZip(a.parts), storedZip(b.parts))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §5 工具面：魔数/typed 校验先于盘副作用 / workspace 越界拒 / 覆写同路径 /
// 姿态四布尔 / FILE_EDIT_TOOLS + workspace 档放行矩阵。
// ---------------------------------------------------------------------------

describe("ω99-223 §5 工具面（append_docx / append_pptx）", () => {
  it("姿态四布尔：镜像 make_* 写面（非只读/非并发安全/破坏性/非开放世界）", () => {
    for (const tool of [createAppendDocxTool("/tmp/ws"), createAppendPptxTool("/tmp/ws")]) {
      expect(tool.isReadOnly()).toBe(false);
      expect(tool.isConcurrencySafe()).toBe(false);
      expect(tool.isDestructive()).toBe(true);
      expect(tool.isOpenWorld()).toBe(false);
    }
  });

  it("描述=用户收益词汇：教追加场景，零实现术语", () => {
    for (const tool of [createAppendDocxTool("/tmp/ws"), createAppendPptxTool("/tmp/ws")]) {
      expect(tool.description).toContain("追加");
      for (const jargon of ["zip", "XML", "EOCD", "inflate", "sldIdLst", "Override", "storedZip", "unzipEntries", "sectPr"]) {
        expect(tool.description.toLowerCase()).not.toContain(jargon.toLowerCase());
      }
    }
  });

  it("typed 校验先于盘副作用：坏 blocks 拒且目标文件字节零变化", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-o223-a-"));
    const target = join(ws, "报告.docx");
    await writeFile(target, buildDocx({ blocks: [{ kind: "body", text: "原文" }] }));
    const tool = createAppendDocxTool(ws);
    const before = new Uint8Array(await readFile(target));
    const bad = await exec(tool, { path: "报告.docx", blocks: [] }); // 空块数组=校验拒
    expect(bad.isError).toBe(true);
    expect(new Uint8Array(await readFile(target))).toEqual(before); // 拒时零写盘
  });

  it("魔数嗅探：OLE → 旧版格式出路文案；非 PK → 拒（docx 面）", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-o223-b-"));
    const tool = createAppendDocxTool(ws);
    await writeFile(join(ws, "旧.docx"), new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]));
    const ole = await exec(tool, { path: "旧.docx", blocks: NEW_BLOCKS });
    expect(ole.isError).toBe(true);
    expect(String(ole.content)).toContain("旧版 .doc");
    expect(String(ole.content)).toContain("另存为");
    await writeFile(join(ws, "假.docx"), "这不是文档", "utf8");
    const fake = await exec(tool, { path: "假.docx", blocks: NEW_BLOCKS });
    expect(fake.isError).toBe(true);
    expect(String(fake.content)).toContain("不是 Word（.docx）文档");
  });

  it("魔数嗅探（pptx 面）：OLE → PowerPoint 出路", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-o223-c-"));
    const tool = createAppendPptxTool(ws);
    await writeFile(join(ws, "旧.pptx"), new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]));
    const ole = await exec(tool, { path: "旧.pptx", slides: NEW_SLIDES });
    expect(ole.isError).toBe(true);
    expect(String(ole.content)).toContain("旧版 .ppt");
    expect(String(ole.content)).toContain("PowerPoint");
  });

  it("workspace 越界拒：../ 外逃与绝对路径 typed 拒", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-o223-d-"));
    for (const tool of [createAppendDocxTool(ws), createAppendPptxTool(ws)]) {
      const key = tool.name === "append_docx" ? "blocks" : "slides";
      const payload = tool.name === "append_docx" ? NEW_BLOCKS : NEW_SLIDES;
      const escape = await exec(tool, { path: "../外逃.docx", [key]: payload });
      expect(escape.isError).toBe(true);
      const absolute = await exec(tool, { path: "/tmp/绝对.docx", [key]: payload });
      expect(absolute.isError).toBe(true);
    }
  });

  it("文件不存在：ENOENT → 用户语", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-o223-e-"));
    const r = await exec(createAppendDocxTool(ws), { path: "不存在.docx", blocks: NEW_BLOCKS });
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain("文件不存在");
  });

  it("覆写同路径：追加落在原文件本身 + 收据「已追加到」+ 文件卡", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-o223-f-"));
    const docxPath = join(ws, "报告.docx");
    await writeFile(docxPath, buildDocx({ blocks: [{ kind: "body", text: "原文" }] }));
    const r = await exec(createAppendDocxTool(ws), { path: "报告.docx", blocks: NEW_BLOCKS });
    expect(r.isError).not.toBe(true);
    expect(String(r.content)).toContain("已追加到 文档：报告.docx（新增 4 块，现共 5 块");
    // 同路径读回：原内容在、新内容在尾部（读写互证 + 只覆写目标文件本身）。
    const parsed = parseDocxDocument(new Uint8Array(await readFile(docxPath)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const texts = parsed.doc.blocks.map((b) => (b.kind === "paragraph" ? b.text : `表${b.index}`));
    expect(texts[0]).toBe("原文");
    expect(texts[texts.length - 1]).toBe("表1");
    // 文件卡收据：结构化末行可提取（append 面=比新建更交付向）。
    expect(extractFileReceipt("append_docx", String(r.content))).toBeDefined();
  });

  it("pptx 面：覆写同路径 + 收据「已追加到」+ 文件卡", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-o223-g-"));
    const pptxPath = join(ws, "路演.pptx");
    await writeFile(pptxPath, buildPptx({ slides: [{ kind: "bullets", title: "页一", bullets: ["一"] }] }));
    const r = await exec(createAppendPptxTool(ws), { path: "路演.pptx", slides: NEW_SLIDES });
    expect(r.isError).not.toBe(true);
    expect(String(r.content)).toContain("已追加到 演示文稿：路演.pptx（新增 2 页，现共 3 页");
    const parsed = parsePptxSlides(new Uint8Array(await readFile(pptxPath)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.slides.map((s) => s.paragraphs[0])).toEqual(["页一", "新页甲", "新页乙"]);
    expect(extractFileReceipt("append_pptx", String(r.content))).toBeDefined();
  });

  it("FILE_EDIT_TOOLS 含两名 + 四档矩阵（workspace/auto 放行、ask 仍问、plan 拒）", () => {
    expect(FILE_EDIT_TOOLS.has("append_docx")).toBe(true);
    expect(FILE_EDIT_TOOLS.has("append_pptx")).toBe(true);
    for (const name of ["append_docx", "append_pptx"] as const) {
      expect(decidePermission("workspace", name)).toEqual({ behavior: "allow" });
      expect(decidePermission("auto", name)).toEqual({ behavior: "allow" });
      expect(decidePermission("ask", name)).toBe("ask");
      expect(decidePermission("plan", name)).toEqual({ behavior: "deny", reason: expect.stringContaining("plan mode is read-only") });
    }
  });

  it("挂载位钉（零配置）：read_pptx+1=append_docx、append_pptx+1=append_xlsx、append_xlsx+1=replace_docx、replace_pptx 的下一位才是 task", () => {
    const stubModel = { stream: async function* () { /* never invoked */ } } as unknown as never;
    const gate = async (): Promise<{ behavior: "allow" }> => ({ behavior: "allow" });
    const names = buildToolSet({ workspaceRoot: "/tmp/ws", model: stubModel, canUseTool: gate, contextWindowTokens: 64_000 }).map((t) => t.name);
    expect(names).toContain("append_docx");
    expect(names).toContain("append_pptx");
    expect(names[names.indexOf("read_pptx") + 1]).toBe("append_docx");
    expect(names[names.indexOf("append_docx") + 1]).toBe("append_pptx");
    // ω99-228 演进——append_xlsx 插在 append_pptx 之后、task 之前（Excel
    // 追加面，append-only 尾）：append_pptx 的下一位改钉 append_xlsx，
    // append_xlsx 的下一位才是 task。
    expect(names[names.indexOf("append_pptx") + 1]).toBe("append_xlsx");
    // ω99-229 演进——replace_docx/replace_pptx 插在 append_xlsx 之后、task
    // 之前（Word/PPT 就地改写面，append-only 尾）：append_xlsx 的下一位改钉
    // replace_docx，replace_pptx 的下一位才是 task。
    expect(names[names.indexOf("append_xlsx") + 1]).toBe("replace_docx");
    expect(names[names.indexOf("replace_docx") + 1]).toBe("replace_pptx");
    // ω99-231 演进——replace_xlsx 插在 replace_pptx 之后、task 之前（Excel
    // 就地改写面，append-only 尾）：replace_pptx 的下一位改钉 replace_xlsx，
    // replace_xlsx 的下一位才是 task。
    expect(names[names.indexOf("replace_pptx") + 1]).toBe("replace_xlsx");
    // ω99-238: #14 演进——set_docx_header/set_pptx_notes 插在 replace_xlsx
    // 之后、task 之前（文档部件面=页眉页脚+演讲备注，doc 名册尾 append-only
    // 尾）：replace_xlsx 的下一位改钉 set_docx_header，set_pptx_notes 的下
    // 一位才是 task。
    // ω99-256: #7 演进——clear_docx_header/set_docx_first_page 插在
    // set_pptx_notes 之后、task 之前（doc 部件面 v2=页眉删除+首页不同，
    // doc 名册尾 append-only 尾）：set_pptx_notes 的下一位改钉
    // clear_docx_header，set_docx_first_page 的下一位才是 task。
    // ω99-263: #8 演进——set_docx_even_pages 插在 set_docx_first_page 之后、
    // task 之前（doc 部件面 v3=奇偶页不同，doc 名册尾 append-only 尾）：
    // set_docx_first_page 的下一位改钉 set_docx_even_pages，set_docx_even_
    // pages 的下一位才是 task。
    expect(names[names.indexOf("replace_xlsx") + 1]).toBe("set_docx_header");
    expect(names[names.indexOf("set_pptx_notes") + 1]).toBe("clear_docx_header");
    expect(names[names.indexOf("set_docx_first_page") + 1]).toBe("set_docx_even_pages");
    expect(names[names.indexOf("set_docx_even_pages") + 1]).toBe("task");
  });
});

// ---------------------------------------------------------------------------
// §6 summarize：两新例 + 老例零漂移（read 三例不变）。
// ---------------------------------------------------------------------------

describe("ω99-223 §6 summarize", () => {
  it("append 两例：对象形「报告.docx 追加 3 块」「路演.pptx 追加 3 页」", () => {
    expect(summarizeToolCall("append_docx", { path: "报告.docx", blocks: [{}, {}, {}] })).toBe("报告.docx 追加 3 块");
    expect(summarizeToolCall("append_pptx", { path: "路演.pptx", slides: [{}, {}, {}] })).toBe("路演.pptx 追加 3 页");
  });

  it("纯件直钉：summarizeAppendDocx / summarizeAppendPptx（文件尾名+追加量）", () => {
    expect(summarizeAppendDocx({ path: "子目录/报告.docx", blocks: [1, 2] })).toBe("报告.docx 追加 2 块");
    expect(summarizeAppendPptx({ path: "子目录/路演.pptx", slides: [1, 2, 3, 4] })).toBe("路演.pptx 追加 4 页");
  });

  it("老例零漂移：read 三例原样（220-222 语法不变）", () => {
    expect(summarizeToolCall("read_xlsx", { path: "订单.xlsx", sheet: "销售明细", offset: 101, limit: 100 })).toBe("订单.xlsx 「销售明细」 第 101–200 行");
    expect(summarizeToolCall("read_docx", { path: "报告.docx" })).toBe("报告.docx 第 1–100 块");
    expect(summarizeToolCall("read_pptx", { path: "路演.pptx", limit: 12 })).toBe("路演.pptx 第 1–12 张");
  });
});
