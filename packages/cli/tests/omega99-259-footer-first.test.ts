// ω99-259: #2 — docx 部件面对称收口 receipts（clear 的 first 变体 +
// setDocxFirstPage 的 footerText——titlePg 首页分野对 header/footer 双部件族
// 对称完备）。RED-first：先红后绿（223/229/256 谱系）。footer first 的夹具
// 用全内存字符串手术造（该引用族今日无公开 API 可造——不拿被测面自证）。
// ★测试红线（09-09 用户令，逐字）：「注意，开发、测试过程禁止删除用户文件/
// 文件夹。」夹具全内存（buildDocx 裸文档 + 手搓 deflate 包/字符串手术）或
// mkdtemp(os.tmpdir()) 临时工作区**只写不删**；零删除调用；零真网络零真模型。
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import type { Tool } from "@wudao/core";
// 写面原语（裸 docx 夹具；238 setDocxChrome 造「已有页眉/页脚」起点）。
import { buildDocx } from "../src/doc-docx.js";
import type { DocBlock } from "../src/doc-docx.js";
// zip 地基。
import { crc32, unzipEntriesWithMeta } from "../src/doc-zip.js";
import type { RawZipEntry } from "../src/doc-zip.js";
// 本弧对称收口面 + 前作。
import {
  setDocxChrome,
  clearDocxChrome,
  setDocxFirstPage,
  createClearDocxHeaderTool,
  createSetDocxFirstPageTool,
  summarizeClearDocxHeader,
} from "../src/doc-chrome.js";
// 消费面（收据门 / 摘要 / 权限钉 / 名册四缝）。
import { summarizeToolCall } from "../src/log.js";
import { FILE_EDIT_TOOLS } from "../src/permission.js";
import { extractFileReceipt } from "../src/driver/file-receipt.js";
import { buildToolSet } from "../src/tools.js";
import {
  DOC_SUITE_EDIT_TOOLS,
  DOC_SUITE_RECEIPT_TOOLS,
  docSuiteSummarizers,
} from "../src/doc-suite.js";

const enc = new TextEncoder();
const UTF8_FLAG = 0x0800;

const exec = async (tool: Tool, args: Record<string, unknown>) => tool.execute(args);

// ---------------------------------------------------------------------------
// 夹具工坊（全内存；零删除）——256 同款件
// ---------------------------------------------------------------------------

type Part = { name: string; data: Uint8Array };
type MethodPart = Part & { method: 0 | 8 };

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const doc = (blocks: readonly DocBlock[]): Uint8Array =>
  buildDocx({ blocks: blocks.length > 0 ? blocks : [{ kind: "title", text: "裸文档" }] });

/** 手搓全 deflate（method 8）zip——模拟用户 Office 存的包（230/256 同款工坊）。 */
function deflatedZip(entries: readonly Part[]): Uint8Array {
  return zipWithMethods(entries.map((e) => ({ ...e, method: 8 as const })));
}

function zipWithMethods(entries: readonly MethodPart[]): Uint8Array {
  const packed = entries.map((e) =>
    e.method === 8 ? { name: e.name, raw: e.data, data: deflateRawSync(e.data), method: 8 as const } : { name: e.name, raw: e.data, data: e.data, method: 0 as const },
  );
  const nameBytes = packed.map((e) => enc.encode(e.name));
  const localLen = packed.reduce((s, e, i) => s + 30 + nameBytes[i]!.length + e.data.length, 0);
  const centralLen = nameBytes.reduce((s, n) => s + 46 + n.length, 0);
  const out = new Uint8Array(localLen + centralLen + 22);
  const dv = new DataView(out.buffer);
  let o = 0;
  const offsets: number[] = [];
  packed.forEach((e, i) => {
    const nb = nameBytes[i]!;
    offsets.push(o);
    dv.setUint32(o, 0x04034b50, true);
    dv.setUint16(o + 4, 20, true);
    dv.setUint16(o + 6, UTF8_FLAG, true);
    dv.setUint16(o + 8, e.method, true);
    dv.setUint16(o + 10, 0, true);
    dv.setUint16(o + 12, 0x21, true);
    dv.setUint32(o + 14, crc32(e.raw), true);
    dv.setUint32(o + 18, e.data.length, true);
    dv.setUint32(o + 22, e.raw.length, true);
    dv.setUint16(o + 26, nb.length, true);
    dv.setUint16(o + 28, 0, true);
    out.set(nb, o + 30);
    out.set(e.data, o + 30 + nb.length);
    o += 30 + nb.length + e.data.length;
  });
  const cdStart = o;
  packed.forEach((e, i) => {
    const nb = nameBytes[i]!;
    dv.setUint32(o, 0x02014b50, true);
    dv.setUint16(o + 4, 20, true);
    dv.setUint16(o + 6, 20, true);
    dv.setUint16(o + 8, UTF8_FLAG, true);
    dv.setUint16(o + 10, e.method, true);
    dv.setUint16(o + 12, 0, true);
    dv.setUint16(o + 14, 0x21, true);
    dv.setUint32(o + 16, crc32(e.raw), true);
    dv.setUint32(o + 20, e.data.length, true);
    dv.setUint32(o + 24, e.raw.length, true);
    dv.setUint16(o + 28, nb.length, true);
    dv.setUint16(o + 30, 0, true);
    dv.setUint32(o + 42, offsets[i]!, true);
    out.set(nb, o + 46);
    o += 46 + nb.length;
  });
  dv.setUint32(o, 0x06054b50, true);
  dv.setUint16(o + 8, packed.length, true);
  dv.setUint16(o + 10, packed.length, true);
  dv.setUint32(o + 12, o - cdStart, true);
  dv.setUint32(o + 16, cdStart, true);
  return out;
}

/** 解包成 name→RawZipEntry（断言用；要求 unzip 成功）。 */
function mustUnzip(bytes: Uint8Array): Map<string, RawZipEntry> {
  const out = unzipEntriesWithMeta(bytes);
  expect(out.ok).toBe(true);
  if (!out.ok) throw new Error("unzip failed");
  return new Map(out.entries.map((e) => [e.name, e]));
}

const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(tag) ?? new RegExp(`${name}\\s*=\\s*'([^']*)'`).exec(tag);
  return m?.[1];
};

const decodeEntities = (s: string): string =>
  s.replace(/&(amp|lt|gt|quot|apos|#x[0-9A-Fa-f]+|#[0-9]+);/g, (whole, body: string) => {
    if (body === "amp") return "&";
    if (body === "lt") return "<";
    if (body === "gt") return ">";
    if (body === "quot") return '"';
    if (body === "apos") return "'";
    if (body.startsWith("#x")) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return whole;
  });

/** 末节 body sectPr 内文（单节夹具=文档里唯一的 sectPr）。 */
function bodySectInner(bytes: Uint8Array): string {
  const document = decode(mustUnzip(bytes).get("word/document.xml")!.data);
  const open = document.lastIndexOf("<w:sectPr>");
  const close = document.lastIndexOf("</w:sectPr>");
  expect(open).toBeGreaterThanOrEqual(0);
  expect(close).toBeGreaterThan(open);
  return document.slice(open + "<w:sectPr>".length, close);
}

/** 指定 which+refType 的部件链读回（223/256 互证范式；header/footer 双族通用
 *  化——本弧 footerText 的读回互证走它）。返回 undefined=该 type 引用缺席。 */
function chromeText(bytes: Uint8Array, which: "header" | "footer", refType: "default" | "first"): string | undefined {
  const parts = mustUnzip(bytes);
  const document = decode(parts.get("word/document.xml")!.data);
  let rid: string | undefined;
  for (const m of document.matchAll(new RegExp(`<w:${which}Reference\\b[^>]*>`, "g"))) {
    if (attr(m[0], "w:type") === refType) rid = attr(m[0], "r:id");
  }
  if (rid === undefined) return undefined;
  const rels = decode(parts.get("word/_rels/document.xml.rels")!.data);
  let target: string | undefined;
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    if (attr(m[0], "Id") === rid) target = attr(m[0], "Target");
  }
  expect(target).toBeDefined();
  const partName = `word/${target!.replace(/^\.\//, "")}`;
  const chrome = decode(parts.get(partName)!.data);
  expect(chrome.includes(which === "header" ? "<w:hdr" : "<w:ftr")).toBe(true);
  let out = "";
  for (const m of chrome.matchAll(/(<w:br\b[^>]*\/>)|<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)) {
    if (m[1] !== undefined) out += "\n";
    else out += decodeEntities(m[2] ?? "");
  }
  return out;
}

/** 「已有 default 页眉/页脚」的起点夹具（238 前作造链）。 */
const withDefaultHeader = (text = "公司机密"): Uint8Array =>
  setDocxChrome(doc([{ kind: "title", text: "简历" }, { kind: "body", text: "正文一段" }]), "header", text).bytes as Uint8Array;
const withDefaultFooter = (text = "第 1 页"): Uint8Array =>
  setDocxChrome(doc([{ kind: "title", text: "报告" }]), "footer", text).bytes as Uint8Array;

/** 换件重装（全内存字符串手术通用底座：其余条目原样 deflate 重装）。 */
function rezipWith(parts: Map<string, RawZipEntry>, swaps: Map<string, Uint8Array>): Uint8Array {
  return zipWithMethods(
    [...parts.entries()].map(([n, e]) => ({ name: n, data: swaps.get(n) ?? e.data, method: 8 as const })),
  );
}

/** 手术①：末节 sectPr 里把该 which 的 default 引用复制为 first 引用（同
 *  r:id=共享部件夹具——clear(first) 共享守卫的钉用；footer 同形直用）。 */
function shareDefaultRefAsFirst(base: Uint8Array, which: "header" | "footer"): Uint8Array {
  const parts = mustUnzip(base);
  const docXml = decode(parts.get("word/document.xml")!.data);
  const m = new RegExp(`<w:${which}Reference\\b[^>]*w:type="default"[^>]*>`).exec(docXml);
  expect(m).not.toBeNull();
  const rid = attr(m![0], "r:id");
  expect(rid).toBeDefined();
  const firstRef = `<w:${which}Reference w:type="first" r:id="${rid}"/>`;
  const newDoc = docXml.slice(0, m!.index + m![0].length) + firstRef + docXml.slice(m!.index + m![0].length);
  return rezipWith(parts, new Map([["word/document.xml", enc.encode(newDoc)]]));
}

/** 手术②：独立部件的 footer first 引用（四缝布线：sectPr 引用 + rels +
 *  CT Override + 新部件——镜像 setDocxChromeRef 新建路径；今日无公开 API
 *  可造 footer first，夹具不拿被测面自证）。 */
function addFirstFooterPart(base: Uint8Array, text: string): Uint8Array {
  const parts = mustUnzip(base);
  const docXml = decode(parts.get("word/document.xml")!.data);
  let maxPart = 0;
  for (const n of parts.keys()) {
    const m = /^word\/footer(\d+)\.xml$/.exec(n);
    if (m) maxPart = Math.max(maxPart, Number.parseInt(m[1]!, 10));
  }
  const partNo = maxPart + 1;
  const partName = `word/footer${partNo}.xml`;
  const rels = decode(parts.get("word/_rels/document.xml.rels")!.data);
  expect(rels.includes("</Relationships>")).toBe(true);
  let maxRid = 0;
  for (const m of rels.matchAll(/Id="rId(\d+)"/g)) maxRid = Math.max(maxRid, Number.parseInt(m[1]!, 10));
  const rid = `rId${maxRid + 1}`;
  const open = docXml.lastIndexOf("<w:sectPr>");
  const close = docXml.lastIndexOf("</w:sectPr>");
  expect(open).toBeGreaterThanOrEqual(0);
  expect(close).toBeGreaterThan(open);
  const ref = `<w:footerReference w:type="first" r:id="${rid}"/>`;
  const newDoc = docXml.slice(0, open + "<w:sectPr>".length) + ref + docXml.slice(open + "<w:sectPr>".length);
  const newRels = rels.replace(
    "</Relationships>",
    `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer${partNo}.xml"/></Relationships>`,
  );
  const ct = decode(parts.get("[Content_Types].xml").data);
  expect(ct.includes("</Types>")).toBe(true);
  const newCt = ct.replace(
    "</Types>",
    `<Override PartName="/${partName}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`,
  );
  const footerXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<w:p><w:r><w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:ftr>`;
  return zipWithMethods([
    ...[...parts.entries()]
      .filter(([n]) => n !== "word/document.xml" && n !== "word/_rels/document.xml.rels" && n !== "[Content_Types].xml")
      .map(([n, e]) => ({ name: n, data: e.data, method: 8 as const })),
    { name: "word/document.xml", data: enc.encode(newDoc), method: 8 },
    { name: "word/_rels/document.xml.rels", data: enc.encode(newRels), method: 8 },
    { name: "[Content_Types].xml", data: enc.encode(newCt), method: 8 },
    { name: partName, data: enc.encode(footerXml), method: 8 },
  ]);
}

// ---------------------------------------------------------------------------
// R1 — clearDocxChrome(…, "first")：first 引用族定向四处全清
// ---------------------------------------------------------------------------

describe("ω99-259 R1 — clear first：引用/部件/rels/CT 四处全清 + not_found + 共享部件守卫", () => {
  it("header first（256 造的 first 部件上定向删）：first 四清 + default 原样 + titlePg 不动", () => {
    const withFirst = setDocxFirstPage(withDefaultHeader("默认页眉"), { firstDifferent: true, headerText: "首页专属" });
    expect(withFirst.ok).toBe(true);
    if (!withFirst.ok) return;
    const out = clearDocxChrome(withFirst.bytes, "header", "first");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.removedParts).toEqual(["word/header2.xml"]);
    const parts = mustUnzip(out.bytes);
    const document = decode(parts.get("word/document.xml")!.data);
    expect(/<w:headerReference\b[^>]*w:type="first"/.test(document)).toBe(false);
    // 定向：default 引用与其部件原样在场。
    expect(/<w:headerReference\b[^>]*w:type="default"/.test(document)).toBe(true);
    expect(parts.has("word/header1.xml")).toBe(true);
    expect(parts.has("word/header2.xml")).toBe(false);
    expect(/Target="header2\.xml"/.test(decode(parts.get("word/_rels/document.xml.rels")!.data))).toBe(false);
    expect(decode(parts.get("[Content_Types].xml").data)).not.toContain('PartName="/word/header2.xml"');
    // titlePg 旗标不动（开关域归 setDocxFirstPage，clear 只管引用族——如实边界）。
    expect(/<w:titlePg\b/.test(document)).toBe(true);
    // 读回互证：first 链断、default 链原文本。
    expect(chromeText(out.bytes, "header", "first")).toBeUndefined();
    expect(chromeText(out.bytes, "header", "default")).toBe("默认页眉");
  });

  it("footer first（手术造独立部件）：同缝四处全清", () => {
    const out = clearDocxChrome(addFirstFooterPart(withDefaultFooter("第 1 页"), "封面脚"), "footer", "first");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.removedParts).toEqual(["word/footer2.xml"]);
    const parts = mustUnzip(out.bytes);
    const document = decode(parts.get("word/document.xml")!.data);
    expect(/<w:footerReference\b[^>]*w:type="first"/.test(document)).toBe(false);
    expect(/<w:footerReference\b[^>]*w:type="default"/.test(document)).toBe(true);
    expect(parts.has("word/footer2.xml")).toBe(false);
    expect(parts.has("word/footer1.xml")).toBe(true);
    expect(/Target="footer2\.xml"/.test(decode(parts.get("word/_rels/document.xml.rels")!.data))).toBe(false);
    expect(decode(parts.get("[Content_Types].xml").data)).not.toContain('PartName="/word/footer2.xml"');
    expect(chromeText(out.bytes, "footer", "default")).toBe("第 1 页");
  });

  it("not_found 出口：只有 default 引用 → clear(first) 双 which 各 {ok:false, reason:'not_found'}", () => {
    expect(clearDocxChrome(withDefaultHeader(), "header", "first")).toEqual({ ok: false, reason: "not_found" });
    expect(clearDocxChrome(withDefaultFooter(), "footer", "first")).toEqual({ ok: false, reason: "not_found" });
  });

  it("共享部件守卫：default+first 同引一个部件 → clear(first) 引用删、部件/rels/CT 保留（双 which）", () => {
    for (const which of ["header", "footer"] as const) {
      const base = which === "header" ? withDefaultHeader("共用页眉") : withDefaultFooter("共用脚");
      const shared = shareDefaultRefAsFirst(base, which);
      const out = clearDocxChrome(shared, which, "first");
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.removedParts).toEqual([]); // 部件仍被 default 引用——保留，不拆台。
      const parts = mustUnzip(out.bytes);
      const document = decode(parts.get("word/document.xml")!.data);
      expect(new RegExp(`<w:${which}Reference\\b[^>]*w:type="first"`).test(document)).toBe(false);
      expect(new RegExp(`<w:${which}Reference\\b[^>]*w:type="default"`).test(document)).toBe(true);
      expect(parts.has(`word/${which}1.xml`)).toBe(true);
      expect(new RegExp(`Type="[^"]*\\/${which}"`).test(decode(parts.get("word/_rels/document.xml.rels")!.data))).toBe(true);
      expect(decode(parts.get("[Content_Types].xml").data)).toContain(`PartName="/word/${which}1.xml"`);
      expect(chromeText(out.bytes, which, "default")).toBe(which === "header" ? "共用页眉" : "共用脚");
    }
  });
});

// ---------------------------------------------------------------------------
// R2 — 零演进钉：refType 缺省=今日字节，footerText 缺席=今日行为
// ---------------------------------------------------------------------------

describe("ω99-259 R2 — 零演进：缺省三形字节等值 + footerText 缺席行为字节等值", () => {
  it("clear：两参 / 第三参 undefined / 'default' 三形字节全等（header 与 footer 各钉）", () => {
    for (const which of ["header", "footer"] as const) {
      const base = which === "header" ? withDefaultHeader("默认页眉") : withDefaultFooter("第 1 页");
      const a = clearDocxChrome(base, which);
      const b = clearDocxChrome(base, which, undefined);
      const c = clearDocxChrome(base, which, "default");
      expect(a.ok && b.ok && c.ok).toBe(true);
      if (!a.ok || !b.ok || !c.ok) return;
      expect(bytesEqual(a.bytes, b.bytes)).toBe(true);
      expect(bytesEqual(a.bytes, c.bytes)).toBe(true);
    }
  });

  it("setDocxFirstPage：footerText 缺席（不在场 vs 显式 undefined）三路径字节等值", () => {
    const base = withDefaultHeader("默认页眉");
    const on1 = setDocxFirstPage(base, { firstDifferent: true });
    const on2 = setDocxFirstPage(base, { firstDifferent: true, footerText: undefined });
    expect(on1.ok && on2.ok).toBe(true);
    if (!on1.ok || !on2.ok) return;
    expect(bytesEqual(on1.bytes, on2.bytes)).toBe(true);
    const t1 = setDocxFirstPage(base, { firstDifferent: true, headerText: "首页" });
    const t2 = setDocxFirstPage(base, { firstDifferent: true, headerText: "首页", footerText: undefined });
    expect(t1.ok && t2.ok).toBe(true);
    if (!t1.ok || !t2.ok) return;
    expect(bytesEqual(t1.bytes, t2.bytes)).toBe(true);
    const off1 = setDocxFirstPage(t1.bytes, { firstDifferent: false });
    const off2 = setDocxFirstPage(t1.bytes, { firstDifferent: false, footerText: undefined });
    expect(off1.ok && off2.ok).toBe(true);
    if (!off1.ok || !off2.ok) return;
    expect(bytesEqual(off1.bytes, off2.bytes)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R3 — setDocxFirstPage footerText（true 路径）：新建/覆写 + 读回互证 + 双部件
// ---------------------------------------------------------------------------

describe("ω99-259 R3 — footerText true 路径：覆写不增部件、新建碰撞纪律 + verifyChrome 读回互证", () => {
  it("true+footerText 新建：footer first 四缝布线 + 读回等值 + default footer 原样", () => {
    const out = setDocxFirstPage(withDefaultFooter("第 1 页"), { firstDifferent: true, footerText: "封面无页码" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.firstDifferent).toBe(true);
    expect(out.footerText).toBe("封面无页码");
    expect(out.footerPartName).toBe("word/footer2.xml");
    expect(out.footerPartCreated).toBe(true);
    const parts = mustUnzip(out.bytes);
    expect(/<w:footerReference\b[^>]*w:type="first"/.test(decode(parts.get("word/document.xml")!.data))).toBe(true);
    expect(/<w:titlePg\b/.test(bodySectInner(out.bytes))).toBe(true);
    expect(parts.has("word/footer2.xml")).toBe(true);
    expect(decode(parts.get("[Content_Types].xml").data)).toContain('PartName="/word/footer2.xml"');
    // 读回互证（verifyChrome 同构——「已设置」从读回来）。
    expect(chromeText(out.bytes, "footer", "first")).toBe("封面无页码");
    expect(chromeText(out.bytes, "footer", "default")).toBe("第 1 页");
  });

  it("覆写幂等：再设 footerText → 部件数不增（created=false、部件名稳定）", () => {
    const a = setDocxFirstPage(withDefaultFooter("第 1 页"), { firstDifferent: true, footerText: "第一版" });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const b = setDocxFirstPage(a.bytes, { firstDifferent: true, footerText: "第二版" });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.footerPartName).toBe("word/footer2.xml");
    expect(b.footerPartCreated).toBe(false);
    const names = [...mustUnzip(b.bytes).keys()].filter((n) => /^word\/footer\d+\.xml$/.test(n));
    expect(names).toEqual(["word/footer1.xml", "word/footer2.xml"]);
    expect(chromeText(b.bytes, "footer", "first")).toBe("第二版");
  });

  it("碰撞纪律：无既有 footer 部件 → 新部件落 footer1.xml（max+1 从零起）", () => {
    const out = setDocxFirstPage(doc([{ kind: "title", text: "裸" }]), { firstDifferent: true, footerText: "封面脚" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.footerPartName).toBe("word/footer1.xml");
    expect(chromeText(out.bytes, "footer", "first")).toBe("封面脚");
  });

  it("双部件一次调用：headerText+footerText 同给 → 两 first 链各自读回等值（原子性钉）", () => {
    const out = setDocxFirstPage(withDefaultHeader("默认页眉"), {
      firstDifferent: true,
      headerText: "封面页眉",
      footerText: "封面脚注",
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.firstPartName).toBe("word/header2.xml");
    expect(out.footerPartName).toBe("word/footer1.xml");
    expect(chromeText(out.bytes, "header", "first")).toBe("封面页眉");
    expect(chromeText(out.bytes, "footer", "first")).toBe("封面脚注");
    expect(chromeText(out.bytes, "header", "default")).toBe("默认页眉");
  });
});

// ---------------------------------------------------------------------------
// R4 — false 路径双面清：header/footer first 四态 + default 引用族不动
// ---------------------------------------------------------------------------

describe("ω99-259 R4 — false 路径双清四态：在场清、缺席跳、双缺=纯拆 titlePg", () => {
  it("双在场：两族各自四清（removedParts 先 header 后 footer 定序）+ default 引用族不动", () => {
    const on = setDocxFirstPage(withDefaultHeader("默认页眉"), {
      firstDifferent: true,
      headerText: "封面页眉",
      footerText: "封面脚注",
    });
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    const off = setDocxFirstPage(on.bytes, { firstDifferent: false });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.firstDifferent).toBe(false);
    expect(off.removedParts).toEqual(["word/header2.xml", "word/footer1.xml"]);
    const parts = mustUnzip(off.bytes);
    const document = decode(parts.get("word/document.xml")!.data);
    expect(/<w:titlePg\b/.test(document)).toBe(false);
    expect(/<w:headerReference\b[^>]*w:type="first"/.test(document)).toBe(false);
    expect(/<w:footerReference\b[^>]*w:type="first"/.test(document)).toBe(false);
    // default 引用族不动（回到全篇一致=页眉还在，首页不再特殊）。
    expect(/<w:headerReference\b[^>]*w:type="default"/.test(document)).toBe(true);
    expect(parts.has("word/header1.xml")).toBe(true);
    expect(parts.has("word/header2.xml")).toBe(false);
    expect(parts.has("word/footer1.xml")).toBe(false);
    expect(chromeText(off.bytes, "header", "default")).toBe("默认页眉");
  });

  it("header 在场 footer 缺席：单面清、缺席跳过不构成 not_found（开关语义=回到全篇一致）", () => {
    const on = setDocxFirstPage(withDefaultHeader("默认页眉"), { firstDifferent: true, headerText: "首页专属" });
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    const off = setDocxFirstPage(on.bytes, { firstDifferent: false });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.removedParts).toEqual(["word/header2.xml"]);
    const document = decode(mustUnzip(off.bytes).get("word/document.xml")!.data);
    expect(/<w:headerReference\b[^>]*w:type="first"/.test(document)).toBe(false);
    expect(/<w:footerReference\b/.test(document)).toBe(false);
  });

  it("footer 在场 header 缺席：单面清（手术造 footer first + titlePg 开关）", () => {
    const on = setDocxFirstPage(withDefaultFooter("第 1 页"), { firstDifferent: true });
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    const withFooterFirst = addFirstFooterPart(on.bytes, "封面脚");
    const off = setDocxFirstPage(withFooterFirst, { firstDifferent: false });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.removedParts).toEqual(["word/footer2.xml"]);
    const parts = mustUnzip(off.bytes);
    const document = decode(parts.get("word/document.xml")!.data);
    expect(/<w:titlePg\b/.test(document)).toBe(false);
    expect(/<w:footerReference\b[^>]*w:type="first"/.test(document)).toBe(false);
    expect(/<w:footerReference\b[^>]*w:type="default"/.test(document)).toBe(true);
    expect(/<w:headerReference\b/.test(document)).toBe(false);
    expect(parts.has("word/footer2.xml")).toBe(false);
    expect(parts.has("word/footer1.xml")).toBe(true);
    expect(chromeText(off.bytes, "footer", "default")).toBe("第 1 页");
  });

  it("双缺=纯拆 titlePg：removedParts=[]、default 部件零动", () => {
    const on = setDocxFirstPage(withDefaultHeader("默认页眉"), { firstDifferent: true });
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    const off = setDocxFirstPage(on.bytes, { firstDifferent: false });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.removedParts).toEqual([]);
    expect(chromeText(off.bytes, "header", "default")).toBe("默认页眉");
    expect(/<w:titlePg\b/.test(bodySectInner(off.bytes))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R5 — 工具面：refType/footerText 参数校验 + 收据文案逐字 + 魔数 + 零写盘
// ---------------------------------------------------------------------------

describe("ω99-259 R5(a) — clear_docx_header 增 refType", () => {
  it("refType=first 收据「已删除首页页眉」+ JSON 尾行结构不变 + 盘上 first 链真断", async () => {
    const dir = await mkdtemp(join(tmpdir(), "o259-clear-first-"));
    const rel = "信函.docx";
    const withFirst = setDocxFirstPage(withDefaultHeader("默认页眉"), { firstDifferent: true, headerText: "首页专属" });
    expect(withFirst.ok).toBe(true);
    await writeFile(join(dir, rel), withFirst.bytes);
    const tool = createClearDocxHeaderTool(dir);
    const res = await exec(tool, { path: rel, refType: "first" });
    expect(res.isError).toBeFalsy();
    const lines = res.content.split("\n");
    expect(lines[0]).toBe("已删除首页页眉");
    expect(extractFileReceipt("clear_docx_header", res.content)).toBeDefined();
    // JSON 尾行结构不变（brief 钉：不加键——refType 不进尾行）。
    const tail = JSON.parse(lines[lines.length - 1]!);
    expect(Object.keys(tail).sort()).toEqual(["bytes", "path", "relativePath", "which"]);
    // 盘上互证：first 引用没了、default 页眉还在。
    const reread = decode(await readFile(join(dir, rel)));
    expect(/<w:headerReference\b[^>]*w:type="first"/.test(reread)).toBe(false);
    expect(/<w:headerReference\b[^>]*w:type="default"/.test(reread)).toBe(true);
  });

  it("refType=first + which=footer 收据「已删除首页页脚」", async () => {
    const dir = await mkdtemp(join(tmpdir(), "o259-clear-first-f-"));
    const rel = "报告.docx";
    await writeFile(join(dir, rel), addFirstFooterPart(withDefaultFooter("第 1 页"), "封面脚"));
    const tool = createClearDocxHeaderTool(dir);
    const res = await exec(tool, { path: rel, which: "footer", refType: "first" });
    expect(res.isError).toBeFalsy();
    expect(res.content.startsWith("已删除首页页脚\n")).toBe(true);
    expect(extractFileReceipt("clear_docx_header", res.content)).toBeDefined();
  });

  it("非法 refType typed 拒（零写盘）+ 缺省 refType 仍是今日「已删除页眉」文案", async () => {
    const dir = await mkdtemp(join(tmpdir(), "o259-clear-rt-"));
    const rel = "简历.docx";
    const before = withDefaultHeader("公司机密");
    await writeFile(join(dir, rel), before);
    const tool = createClearDocxHeaderTool(dir);
    // ω99-263: #4 演进——refType 值域 +even（原「even 当非法值」夹具随源换
    // "odd"；拒文案随值域变更含 even）。
    const bad = await exec(tool, { path: rel, refType: "odd" });
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain('"refType" must be "default", "first" or "even"');
    expect(bytesEqual(await readFile(join(dir, rel)), before)).toBe(true);
    // 缺省 refType（不传）= default——今日收据零演进。
    const def = await exec(tool, { path: rel });
    expect(def.isError).toBeFalsy();
    expect(def.content.startsWith("已删除页眉\n")).toBe(true);
  });

  it("first 缺席 not-found「本就没有首页页眉」+ 零写盘；魔数嗅探在新参数在场照拒", async () => {
    const dir = await mkdtemp(join(tmpdir(), "o259-clear-nf-"));
    const rel = "素.docx";
    const before = withDefaultHeader("默认页眉"); // 只有 default，无 first。
    await writeFile(join(dir, rel), before);
    const tool = createClearDocxHeaderTool(dir);
    const res = await exec(tool, { path: rel, refType: "first" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("本就没有首页页眉");
    expect(bytesEqual(await readFile(join(dir, rel)), before)).toBe(true);
    await writeFile(join(dir, "旧.doc"), new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xb1, 0x1a, 0xe1, 0x1a]));
    expect((await exec(tool, { path: "旧.doc", refType: "first" })).content).toContain("旧版 .doc 格式");
    await writeFile(join(dir, "plain.txt"), enc.encode("hello world"));
    expect((await exec(tool, { path: "plain.txt", refType: "first" })).content).toContain("不是 Word（.docx）文档");
  });
});

describe("ω99-259 R5(b) — set_docx_first_page 增 footerText", () => {
  it("footerText 收据变体：footer-only「首页页脚：「Y」」/ 双文本「X」；「Y」」/ 20 字预览帽 + JSON 尾行", async () => {
    const dir = await mkdtemp(join(tmpdir(), "o259-first-f-"));
    const tool = createSetDocxFirstPageTool(dir);
    const relA = "a.docx";
    await writeFile(join(dir, relA), withDefaultFooter("第 1 页"));
    const fOnly = await exec(tool, { path: relA, firstDifferent: true, footerText: "封面无页码" });
    expect(fOnly.isError).toBeFalsy();
    expect(fOnly.content.split("\n")[0]).toBe("首页已设为不同（首页页脚：「封面无页码」）");
    expect(extractFileReceipt("set_docx_first_page", fOnly.content)).toBeDefined();
    const tail = JSON.parse(fOnly.content.split("\n").at(-1)!);
    expect(tail.footerText).toBe("封面无页码");
    expect(tail.headerText).toBeUndefined();
    const relB = "b.docx";
    await writeFile(join(dir, relB), withDefaultHeader("默认页眉"));
    const both = await exec(tool, { path: relB, firstDifferent: true, headerText: "封面页眉", footerText: "封面脚注" });
    expect(both.content.split("\n")[0]).toBe("首页已设为不同（首页页眉：「封面页眉」；首页页脚：「封面脚注」）");
    // 20 字预览帽（超长收「…」，沿 headerText 钉形）。
    const relC = "c.docx";
    await writeFile(join(dir, relC), withDefaultFooter("第 1 页"));
    const long = await exec(tool, { path: relC, firstDifferent: true, footerText: "字".repeat(21) });
    expect(long.content.split("\n")[0]).toBe(`首页已设为不同（首页页脚：「${"字".repeat(20)}…」）`);
    // 盘上互证：footer first 链读回等值。
    expect(chromeText(await readFile(join(dir, relA)), "footer", "first")).toBe("封面无页码");
  });

  it("typed 拒族：false 带 footerText（矛盾拒）/ 空串 / 控制字符 / 4001 码点——全程零写盘", async () => {
    const dir = await mkdtemp(join(tmpdir(), "o259-first-rej-"));
    const rel = "报告.docx";
    const before = withDefaultHeader("默认页眉");
    await writeFile(join(dir, rel), before);
    const tool = createSetDocxFirstPageTool(dir);
    expect((await exec(tool, { path: rel, firstDifferent: false, footerText: "x" })).content).toContain('不接受 "footerText"');
    expect((await exec(tool, { path: rel, firstDifferent: true, footerText: "  " })).content).toContain('"footerText" must be a non-empty string');
    expect((await exec(tool, { path: rel, firstDifferent: true, footerText: "a\x01b" })).content).toContain("control character");
    expect((await exec(tool, { path: rel, firstDifferent: true, footerText: "字".repeat(4001) })).content).toContain("limited to 4000");
    expect(bytesEqual(await readFile(join(dir, rel)), before)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R6 — 字节保真：未改条目 smartZip 直过（256 R6 同钉移植）
// ---------------------------------------------------------------------------

describe("ω99-259 R6 — 字节保真：clear(footer, first) 未触及条目逐字节等", () => {
  it("deflate 重装包上 clear first footer：未触及条目 method/raw/data 三等 + 条目序原样", () => {
    const base = addFirstFooterPart(withDefaultFooter("第 1 页"), "封面脚");
    const repacked = deflatedZip([...mustUnzip(base).values()].map((e) => ({ name: e.name, data: e.data })));
    const out = clearDocxChrome(repacked, "footer", "first");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const before = [...mustUnzip(repacked).values()];
    const after = mustUnzip(out.bytes);
    const kept = before.filter((e) => e.name !== "word/footer2.xml");
    expect([...after.keys()]).toEqual(kept.map((e) => e.name));
    // 本操作的三处改件（引用/rels/CT）合法重压；其余条目逐字节直过。
    const touched = new Set(["word/document.xml", "word/_rels/document.xml.rels", "[Content_Types].xml"]);
    for (const e of kept) {
      if (touched.has(e.name)) continue;
      const a = after.get(e.name)!;
      expect(a.method).toBe(e.method);
      expect(bytesEqual(a.raw, e.raw)).toBe(true);
      expect(bytesEqual(a.data, e.data)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// R7 — census 邻接零演进：名册四缝数值 + 挂载序 + 摘要器（本弧零新工具）
// ---------------------------------------------------------------------------

describe("ω99-259 R7 — census 邻接零演进（名册四缝/挂载序/摘要器）", () => {
  const stubModel = { stream: async function* () { /* never invoked */ } } as unknown as never;
  const gate = async (): Promise<{ behavior: "allow" }> => ({ behavior: "allow" });
  const build = (): Tool[] =>
    buildToolSet({ workspaceRoot: "/tmp/ws", model: stubModel, canUseTool: gate, contextWindowTokens: 64_000 });

  it("写册 13 / 回执册同 / 摘要器键 16——四缝数值全零演进", () => {
    // 奇偶页弧起写册 14 / 摘要器键 17（名册尾 +1，随源演进）。
    expect(DOC_SUITE_EDIT_TOOLS.length).toBe(14);
    expect(DOC_SUITE_EDIT_TOOLS.slice(-4)).toEqual([
      "set_pptx_notes", "clear_docx_header", "set_docx_first_page", "set_docx_even_pages",
    ]);
    expect([...DOC_SUITE_RECEIPT_TOOLS]).toEqual([...DOC_SUITE_EDIT_TOOLS]);
    expect(Object.keys(docSuiteSummarizers).length).toBe(17);
  });

  it("挂载 append-only 尾不动：set_pptx_notes+1=clear_docx_header → set_docx_first_page → task", () => {
    const names = build().map((t) => t.name);
    expect(names[names.indexOf("set_pptx_notes") + 1]).toBe("clear_docx_header");
    expect(names[names.indexOf("clear_docx_header") + 1]).toBe("set_docx_first_page");
    expect(names[names.indexOf("set_docx_first_page") + 1]).toBe("set_docx_even_pages");
    expect(names[names.indexOf("set_docx_even_pages") + 1]).toBe("task");
  });

  it("摘要器零演进：refType/footerText 在场不改摘要 + 权限域名册在场", () => {
    expect(summarizeClearDocxHeader({ path: "a/报告.docx", which: "header" })).toBe("报告.docx 删除了页眉");
    expect(summarizeClearDocxHeader({ path: "a/报告.docx", which: "footer", refType: "first" })).toBe("报告.docx 删除了页脚");
    expect(summarizeToolCall("clear_docx_header", { path: "a/报告.docx", refType: "first" })).toBe("报告.docx 删除了页眉");
    expect(summarizeToolCall("set_docx_first_page", { path: "a/报告.docx", firstDifferent: true, footerText: "x" })).toBe("报告.docx 首页设为不同");
    expect(FILE_EDIT_TOOLS.has("clear_docx_header")).toBe(true);
    expect(FILE_EDIT_TOOLS.has("set_docx_first_page")).toBe(true);
  });
});
