// ω99-256: #3 — doc 部件面 v2 receipts（页眉删除三处全清 + 首页不同
// titlePg 开关/first 引用）。RED-first：先红后绿（223/229/238 谱系）。
// ★测试红线（09-09 用户令，逐字）：「注意，开发、测试过程禁止删除用户文件/
// 文件夹。」夹具全内存（buildDocx 造裸文档 + 手搓 deflate 包）或
// mkdtemp(os.tmpdir()) 临时工作区**只写不删**；零删除调用；零真网络。
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import type { Tool } from "@wudao-org/core";
// 写面原语（裸 docx 夹具；238 的 setDocxChrome 造「已有页眉」起点）。
import { buildDocx } from "../src/doc-docx.js";
import type { DocBlock } from "../src/doc-docx.js";
// zip 地基。
import { crc32, unzipEntriesWithMeta } from "../src/doc-zip.js";
import type { RawZipEntry } from "../src/doc-zip.js";
// 本弧 doc 部件面 v2（clear + first-page）与 238 前作。
import {
  setDocxChrome,
  clearDocxChrome,
  setDocxFirstPage,
  createClearDocxHeaderTool,
  createSetDocxFirstPageTool,
  summarizeClearDocxHeader,
  summarizeSetDocxFirstPage,
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
// 夹具工坊（全内存；零删除）——238 同款件
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

/** 手搓全 deflate（method 8）zip——模拟用户 Office 存的包（230/238 同款工坊）。 */
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

/** 指定 refType 的 headerReference 链读回（223/238 互证范式；default/first 分
 * 派）。返回 undefined=该 type 引用缺席。 */
function chromeTextByRefType(bytes: Uint8Array, refType: "default" | "first"): string | undefined {
  const parts = mustUnzip(bytes);
  const document = decode(parts.get("word/document.xml")!.data);
  let rid: string | undefined;
  for (const m of document.matchAll(/<w:headerReference\b[^>]*>/g)) {
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
  expect(chrome.includes("<w:hdr")).toBe(true);
  let out = "";
  for (const m of chrome.matchAll(/(<w:br\b[^>]*\/>)|<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)) {
    if (m[1] !== undefined) out += "\n";
    else out += decodeEntities(m[2] ?? "");
  }
  return out;
}

/** 「已有 default 页眉」的起点夹具（238 前作造链，本弧在其上做删/分野）。 */
const withDefaultHeader = (text = "公司机密"): Uint8Array =>
  setDocxChrome(doc([{ kind: "title", text: "简历" }, { kind: "body", text: "正文一段" }]), "header", text).bytes as Uint8Array;

// ---------------------------------------------------------------------------
// R1/R2 — 面一 clearDocxChrome：三处全清 + 无引用诚实
// ---------------------------------------------------------------------------

describe("ω99-256 R1 — 删除主路径：引用+部件+rels+Content_Types 四处全清", () => {
  it("setDocxChrome 造页眉 → clearDocxChrome → 读回链断 + zip 部件表无 headerN + rels 无条目 + CT 无 Override", () => {
    const out = clearDocxChrome(withDefaultHeader(), "header");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.removedParts).toEqual(["word/header1.xml"]);
    const parts = mustUnzip(out.bytes);
    // ① sectPr 引用删尽（default 引用没了；文档里再无任何 headerReference——
    //    夹具只有 default 一种）。
    const document = decode(parts.get("word/document.xml")!.data);
    expect(/<w:headerReference\b/.test(document)).toBe(false);
    // ② 部件删尽（zip 部件表无 word/headerN.xml）。
    expect(parts.has("word/header1.xml")).toBe(false);
    for (const name of parts.keys()) expect(name).not.toMatch(/^word\/header\d+\.xml$/);
    // ③ rels 条目删尽（header 类型关系没了）。
    const rels = decode(parts.get("word/_rels/document.xml.rels")!.data);
    expect(/Type="[^"]*\/header"/.test(rels)).toBe(false);
    expect(rels).not.toContain('Id="rId1"');
    // ④ Content_Types Override 清（本弧裁定：一并清，诚实完整性）。
    const ct = decode(parts.get("[Content_Types].xml").data);
    expect(ct).not.toContain('PartName="/word/header1.xml"');
    // 读回互证（223/238 范式）：default 链断——引用缺席即「已删除」从读回来。
    expect(chromeTextByRefType(out.bytes, "default")).toBeUndefined();
    // 正文原样：document.xml 里标题正文还在（删除只动页眉域）。
    expect(document).toContain("简历");
    expect(document).toContain("正文一段");
  });

  it("footer 同缝：clearDocxChrome(footer) 四处全清（which 参数域）", () => {
    const withFooter = setDocxChrome(doc([{ kind: "title", text: "裸" }]), "footer", "第 1 页").bytes as Uint8Array;
    const out = clearDocxChrome(withFooter, "footer");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.removedParts).toEqual(["word/footer1.xml"]);
    const parts = mustUnzip(out.bytes);
    expect(/<w:footerReference\b/.test(decode(parts.get("word/document.xml")!.data))).toBe(false);
    expect(parts.has("word/footer1.xml")).toBe(false);
    expect(/Type="[^"]*\/footer"/.test(decode(parts.get("word/_rels/document.xml.rels")!.data))).toBe(false);
  });

  it("first/even 引用不动（本面只清 default——首页不同域归面二）：clear 后 first 引用原样在场", () => {
    // 手造：default+first 双引用共享部件的文档（first 单独部件更清晰）。
    const base = setDocxChrome(doc([{ kind: "title", text: "裸" }]), "header", "默认页眉").bytes as Uint8Array;
    const withFirst = setDocxFirstPage(base, { firstDifferent: true, headerText: "首页专属" });
    expect(withFirst.ok).toBe(true);
    if (!withFirst.ok) return;
    // 只清 default：first 引用与其部件必须原样保留（first 域归 set_docx_first_page 管）。
    const out = clearDocxChrome(withFirst.bytes, "header");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const document = decode(mustUnzip(out.bytes).get("word/document.xml")!.data);
    expect(/<w:headerReference\b[^>]*w:type="default"/.test(document)).toBe(false);
    const firstRef = /<w:headerReference\b[^>]*w:type="first"/.exec(document);
    expect(firstRef).not.toBeNull();
    expect(chromeTextByRefType(out.bytes, "first")).toBe("首页专属");
  });
});

describe("ω99-256 R2 — 无引用诚实：素 docx clear → typed not_found（229 四出口形）", () => {
  it("素 docx：{ok:false, reason:'not_found'}（判别式收窄可用）", () => {
    const out = clearDocxChrome(doc([{ kind: "title", text: "裸" }]), "header");
    expect(out).toEqual({ ok: false, reason: "not_found" });
  });

  it("坏 which typed 拒 + 坏 zip 用户语拒", () => {
    expect(clearDocxChrome(doc([]), "top" as never)).toEqual({
      ok: false,
      error: '"which" must be "header" or "footer" (got "top")',
    });
    const junk = clearDocxChrome(enc.encode("根本不是zip"), "header");
    expect(junk.ok).toBe(false);
    if (junk.ok) return;
    expect(junk.reason).toBeUndefined();
    expect(junk.error).toContain("不是有效的 Word");
  });
});

// ---------------------------------------------------------------------------
// R3/R4/R5 — 面二 setDocxFirstPage：纯开关 / 带文本 / 关闭回全篇
// ---------------------------------------------------------------------------

describe("ω99-256 R3 — 首页不同纯开关：titlePg 立 + 无 first 引用（零参数达成）", () => {
  it("setDocxFirstPage(true) 无 text：sectPr 带 <w:titlePg/>、无 first 引用、default 页眉不动", () => {
    const base = withDefaultHeader("默认页眉");
    const out = setDocxFirstPage(base, { firstDifferent: true });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const sect = bodySectInner(out.bytes);
    expect(sect).toContain("<w:titlePg/>");
    // OOXML schema 位序钉（CT_SectPr 文序：titlePg 在 pgSz/pgMar 页面组之后、
    // 文字方向/docGrid/sectPrChange 之前——本弧按 spec 文序插）。
    expect(sect.indexOf("<w:titlePg/>")).toBeGreaterThan(sect.indexOf("<w:pgMar"));
    // 首页页眉的 OOXML 事实：titlePg 在 + first 引用缺 = 首页无页眉。
    expect(chromeTextByRefType(out.bytes, "first")).toBeUndefined();
    // default 页眉不动（全篇页眉照旧）。
    expect(chromeTextByRefType(out.bytes, "default")).toBe("默认页眉");
  });
});

describe("ω99-256 R4 — 首页不同带文本：first 引用部件建链 + 文本互证读回", () => {
  it("true+headerText：first 引用在 + rels + 部件 + CT override + 读回等值；default 原样", () => {
    const base = withDefaultHeader("默认页眉");
    const out = setDocxFirstPage(base, { firstDifferent: true, headerText: "首页专属页眉" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.firstDifferent).toBe(true);
    expect(out.headerText).toBe("首页专属页眉");
    expect(out.firstPartName).toBe("word/header2.xml");
    expect(out.firstPartCreated).toBe(true);
    const parts = mustUnzip(out.bytes);
    const document = decode(parts.get("word/document.xml")!.data);
    const firstRef = /<w:headerReference\b[^>]*w:type="first"[^>]*>/.exec(document);
    expect(firstRef).not.toBeNull();
    const sect = bodySectInner(out.bytes);
    expect(sect).toContain("<w:titlePg/>");
    // 部件在场 + CT override 在场（four-way wiring）。
    expect(parts.has("word/header2.xml")).toBe(true);
    expect(decode(parts.get("[Content_Types].xml").data)).toContain('PartName="/word/header2.xml"');
    // 文本互证读回：first 链=新文本；default 链=原文本（两域互不扰）。
    expect(chromeTextByRefType(out.bytes, "first")).toBe("首页专属页眉");
    expect(chromeTextByRefType(out.bytes, "default")).toBe("默认页眉");
  });

  it("换文本幂等覆写：已有 first 部件 → 原位换内容（部件数不增）", () => {
    const base = withDefaultHeader("默认页眉");
    const first = setDocxFirstPage(base, { firstDifferent: true, headerText: "第一版" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const again = setDocxFirstPage(first.bytes, { firstDifferent: true, headerText: "第二版" });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.firstPartName).toBe("word/header2.xml");
    expect(again.firstPartCreated).toBe(false);
    const names = [...mustUnzip(again.bytes).keys()].filter((n) => /^word\/header\d+\.xml$/.test(n));
    expect(names).toEqual(["word/header1.xml", "word/header2.xml"]);
    expect(chromeTextByRefType(again.bytes, "first")).toBe("第二版");
    expect(chromeTextByRefType(again.bytes, "default")).toBe("默认页眉");
  });
});

describe("ω99-256 R5 — 关闭回全篇：titlePg 拆 + first 三清 + default 原样保留", () => {
  it("R4 后 (false)：titlePg 拆、first 引用/部件/rels/CT 全清、default 页眉原样", () => {
    const base = withDefaultHeader("默认页眉");
    const on = setDocxFirstPage(base, { firstDifferent: true, headerText: "首页专属" });
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    const off = setDocxFirstPage(on.bytes, { firstDifferent: false });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.firstDifferent).toBe(false);
    expect(off.removedParts).toEqual(["word/header2.xml"]);
    const parts = mustUnzip(off.bytes);
    const document = decode(parts.get("word/document.xml")!.data);
    expect(/<w:titlePg\b/.test(document)).toBe(false);
    expect(/<w:headerReference\b[^>]*w:type="first"/.test(document)).toBe(false);
    expect(parts.has("word/header2.xml")).toBe(false);
    expect(/Type="[^"]*\/header"[^>]*Target="header2\.xml"/.test(decode(parts.get("word/_rels/document.xml.rels")!.data))).toBe(false);
    expect(decode(parts.get("[Content_Types].xml").data)).not.toContain('PartName="/word/header2.xml"');
    // default 页眉原样保留（回到全篇同页眉=页眉还在，只是首页不再特殊）。
    expect(chromeTextByRefType(off.bytes, "default")).toBe("默认页眉");
    expect(parts.has("word/header1.xml")).toBe(true);
  });

  it("关纯开关（无 first 部件）：titlePg 拆即成，其余零动（含 footer 在场零误伤）", () => {
    const on = setDocxFirstPage(withDefaultHeader("默认页眉"), { firstDifferent: true });
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    const off = setDocxFirstPage(on.bytes, { firstDifferent: false });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.removedParts).toEqual([]);
    expect(chromeTextByRefType(off.bytes, "default")).toBe("默认页眉");
    expect(/<w:titlePg\b/.test(bodySectInner(off.bytes))).toBe(false);
    // 回归钉：文档同时带 footer（default 引用在）时关纯开关——verify 的引用
    // 组检查只盯 first（空组=无检查，不误伤 footer/default 引用）。
    const withFooter = setDocxChrome(doc([{ kind: "title", text: "裸" }]), "footer", "第 1 页").bytes as Uint8Array;
    const onF = setDocxFirstPage(withFooter, { firstDifferent: true });
    expect(onF.ok).toBe(true);
    if (!onF.ok) return;
    const offF = setDocxFirstPage(onF.bytes, { firstDifferent: false });
    expect(offF.ok).toBe(true);
    if (!offF.ok) return;
    const parts = mustUnzip(offF.bytes);
    expect(/<w:footerReference\b[^>]*w:type="default"/.test(decode(parts.get("word/document.xml")!.data))).toBe(true);
    expect(parts.has("word/footer1.xml")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R6/R7 — 字节保真（smartZip 直过）与幂等
// ---------------------------------------------------------------------------

describe("ω99-256 R6 — 字节保真：未触及条目逐字节等（230 R1 同族钉）", () => {
  it("clear 后：未触及条目 method/raw/data 三等 + 条目序原样（缺被删件）", () => {
    const src = mustUnzip(withDefaultHeader());
    const repacked = deflatedZip([...src.values()].map((e) => ({ name: e.name, data: e.data })));
    const out = clearDocxChrome(repacked, "header");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const before = [...mustUnzip(repacked).values()];
    const after = mustUnzip(out.bytes);
    const kept = before.filter((e) => e.name !== "word/header1.xml");
    expect([...after.keys()]).toEqual(kept.map((e) => e.name));
    // 本操作的三处改件（引用/rels/CT）合法重压；其余条目逐字节直过。
    const touched = new Set(["word/document.xml", "word/_rels/document.xml.rels", "[Content_Types].xml"]);
    for (const e of kept) {
      if (touched.has(e.name)) continue;
      const a = after.get(e.name)!;
      expect(a.method).toBe(e.method); // 未改条目 method 8 照旧 8
      expect(bytesEqual(a.raw, e.raw)).toBe(true); // 原压缩载荷字节直过
      expect(bytesEqual(a.data, e.data)).toBe(true);
    }
  });

  it("first-page 开后：未触及条目逐字节等（document.xml 是唯一被改件）", () => {
    const src = mustUnzip(withDefaultHeader("默认页眉"));
    const repacked = deflatedZip([...src.values()].map((e) => ({ name: e.name, data: e.data })));
    const out = setDocxFirstPage(repacked, { firstDifferent: true });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const before = [...mustUnzip(repacked).values()];
    const after = mustUnzip(out.bytes);
    for (const e of before) {
      if (e.name === "word/document.xml") continue;
      const a = after.get(e.name)!;
      expect(a.method).toBe(e.method);
      expect(bytesEqual(a.raw, e.raw)).toBe(true);
      expect(bytesEqual(a.data, e.data)).toBe(true);
    }
  });
});

describe("ω99-256 R7 — 幂等：二清走诚实 not-found；titlePg 重复立字节稳定", () => {
  it("clear 两次 → 第二次 {ok:false, reason:'not_found'}", () => {
    const once = clearDocxChrome(withDefaultHeader(), "header");
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    expect(clearDocxChrome(once.bytes, "header")).toEqual({ ok: false, reason: "not_found" });
  });

  it("titlePg 重复立 → 字节稳定（同输入两次全等）", () => {
    const base = withDefaultHeader("默认页眉");
    const a = setDocxFirstPage(base, { firstDifferent: true });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const b = setDocxFirstPage(a.bytes, { firstDifferent: true });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(bytesEqual(a.bytes, b.bytes)).toBe(true);
    // 同输入两次全等（确定性）。
    const c = setDocxFirstPage(base, { firstDifferent: true });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(bytesEqual(a.bytes, c.bytes)).toBe(true);
  });

  it("带文本重复设 → 字节稳定；关闭两次 → 第二次 not_found", () => {
    const base = withDefaultHeader("默认页眉");
    const a = setDocxFirstPage(base, { firstDifferent: true, headerText: "首页" });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const b = setDocxFirstPage(a.bytes, { firstDifferent: true, headerText: "首页" });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(bytesEqual(a.bytes, b.bytes)).toBe(true);
    const off = setDocxFirstPage(a.bytes, { firstDifferent: false });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(setDocxFirstPage(off.bytes, { firstDifferent: false })).toEqual({ ok: false, reason: "not_found" });
  });

  it("素 docx 关首页不同（本就未设）→ 诚实 not_found", () => {
    expect(setDocxFirstPage(doc([{ kind: "title", text: "裸" }]), { firstDifferent: false })).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

// ---------------------------------------------------------------------------
// R8 — 面三名册四缝 + 挂载 append-only 尾 + 工具面收据/摘要/权限域
// ---------------------------------------------------------------------------

describe("ω99-256 R8(a) — 名册四缝恰 +2、挂载 append-only 尾", () => {
  const stubModel = { stream: async function* () { /* never invoked */ } } as unknown as never;
  const gate = async (): Promise<{ behavior: "allow" }> => ({ behavior: "allow" });
  const build = (): Tool[] =>
    buildToolSet({ workspaceRoot: "/tmp/ws", model: stubModel, canUseTool: gate, contextWindowTokens: 64_000 });

  it("写册/回执册尾恰 +2（set_docx_header、set_pptx_notes 之后）；摘要器键集同 +2", () => {
    // ω99-263: #5 演进——set_docx_even_pages 进名册尾（doc 部件面 v3=奇偶页
    // 不同）：尾段 slice(-4)/length/键数随源 +1（13→14、16→17），本弧的
    // 「恰 +2」史实钉不因后继弧失效——改钉为随源现值。
    expect(DOC_SUITE_EDIT_TOOLS.slice(-4)).toEqual([
      "set_pptx_notes", "clear_docx_header", "set_docx_first_page", "set_docx_even_pages",
    ]);
    expect(DOC_SUITE_EDIT_TOOLS.length).toBe(14);
    expect([...DOC_SUITE_RECEIPT_TOOLS]).toEqual([...DOC_SUITE_EDIT_TOOLS]);
    for (const n of ["clear_docx_header", "set_docx_first_page"]) {
      expect(Object.prototype.hasOwnProperty.call(docSuiteSummarizers, n)).toBe(true);
    }
    expect(Object.keys(docSuiteSummarizers).length).toBe(17);
  });

  it("挂载 append-only 尾：set_pptx_notes+1=clear_docx_header、再+1=set_docx_first_page、再+1=task", () => {
    const names = build().map((t) => t.name);
    expect(names[names.indexOf("set_pptx_notes") + 1]).toBe("clear_docx_header");
    expect(names[names.indexOf("clear_docx_header") + 1]).toBe("set_docx_first_page");
    expect(names[names.indexOf("set_docx_first_page") + 1]).toBe("set_docx_even_pages");
    expect(names[names.indexOf("set_docx_even_pages") + 1]).toBe("task");
  });

  it("权限域同册（写面 FILE_EDIT_TOOLS 双名在场）", () => {
    expect(FILE_EDIT_TOOLS.has("clear_docx_header")).toBe(true);
    expect(FILE_EDIT_TOOLS.has("set_docx_first_page")).toBe(true);
  });
});

describe("ω99-256 R8(b) — clear_docx_header 工具面（238 单工具骨架同款）", () => {
  it("主路径：tmp 夹具删页眉 → 收据「已删除页眉」+ JSON 尾行 + 盘上文件真被清", async () => {
    const dir = await mkdtemp(join(tmpdir(), "o256-clear-"));
    const rel = "简历.docx";
    await writeFile(join(dir, rel), withDefaultHeader("公司机密"));
    const tool = createClearDocxHeaderTool(dir);
    const res = await exec(tool, { path: rel });
    expect(res.isError).toBeFalsy();
    const lines = res.content.split("\n");
    expect(lines[0]).toBe("已删除页眉");
    expect(extractFileReceipt("clear_docx_header", res.content)).toBeDefined();
    // 盘上互证：重读文件，default 引用已消失。
    const reread = await readFile(join(dir, rel));
    expect(/<w:headerReference\b/.test(decode(reread))).toBe(false);
  });

  it("which 可选缺省 header；which=footer 收据插值「已删除页脚」", async () => {
    const dir = await mkdtemp(join(tmpdir(), "o256-clear-which-"));
    const rel = "带脚注.docx";
    await writeFile(join(dir, rel), setDocxChrome(doc([{ kind: "title", text: "裸" }]), "footer", "第 1 页").bytes as Uint8Array);
    const tool = createClearDocxHeaderTool(dir);
    const res = await exec(tool, { path: rel, which: "footer" });
    expect(res.content.startsWith("已删除页脚\n")).toBe(true);
    expect(extractFileReceipt("clear_docx_header", res.content)).toBeDefined();
  });

  it("无引用诚实：素 docx → 「本就没有页眉」+ isError + 零写盘（文件字节不变）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "o256-clear-none-"));
    const rel = "素.docx";
    const bare = doc([{ kind: "title", text: "裸" }]);
    await writeFile(join(dir, rel), bare);
    const tool = createClearDocxHeaderTool(dir);
    const res = await exec(tool, { path: rel });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("本就没有页眉");
    expect(bytesEqual(await readFile(join(dir, rel)), bare)).toBe(true);
  });

  it("typed 拒族：空 path / 坏 which / 外逃路径 / 旧版 .doc / 非 Word（拒时零写盘）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "o256-clear-rejects-"));
    const tool = createClearDocxHeaderTool(dir);
    expect((await exec(tool, { path: "  " })).content).toContain('"path" must be a non-empty path');
    expect((await exec(tool, { path: "a.docx", which: "top" })).content).toContain('"which" must be "header" or "footer"');
    expect((await exec(tool, { path: "../外逃.docx" })).content).toContain("clear_docx_header:");
    expect((await exec(tool, { path: "无.docx" })).content).toContain("文件不存在");
    await writeFile(join(dir, "旧.doc"), new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xb1, 0x1a, 0xe1, 0x1a]));
    expect((await exec(tool, { path: "旧.doc" })).content).toContain("旧版 .doc 格式");
    await writeFile(join(dir, "plain.txt"), enc.encode("hello world"));
    expect((await exec(tool, { path: "plain.txt" })).content).toContain("不是 Word（.docx）文档");
  });
});

describe("ω99-256 R8(c) — set_docx_first_page 工具面", () => {
  it("纯开关收据：「首页已设为不同（无首页页眉）」+ JSON 尾行 + 盘上 titlePg 真 立", async () => {
    const dir = await mkdtemp(join(tmpdir(), "o256-first-on-"));
    const rel = "报告.docx";
    await writeFile(join(dir, rel), withDefaultHeader("默认页眉"));
    const tool = createSetDocxFirstPageTool(dir);
    const res = await exec(tool, { path: rel, firstDifferent: true });
    expect(res.isError).toBeFalsy();
    expect(res.content.split("\n")[0]).toBe("首页已设为不同（无首页页眉）");
    expect(extractFileReceipt("set_docx_first_page", res.content)).toBeDefined();
    expect(/<w:titlePg\b/.test(decode(await readFile(join(dir, rel))))).toBe(true);
  });

  it("带文本收据：「首页已设为不同（首页页眉：「X」）」；关闭收据：「首页已设为与全篇相同」", async () => {
    const dir = await mkdtemp(join(tmpdir(), "o256-first-text-"));
    const rel = "报告.docx";
    await writeFile(join(dir, rel), withDefaultHeader("默认页眉"));
    const tool = createSetDocxFirstPageTool(dir);
    const on = await exec(tool, { path: rel, firstDifferent: true, headerText: "求职简历" });
    expect(on.content.split("\n")[0]).toBe("首页已设为不同（首页页眉：「求职简历」）");
    const off = await exec(tool, { path: rel, firstDifferent: false });
    expect(off.content.split("\n")[0]).toBe("首页已设为与全篇相同");
    expect(extractFileReceipt("set_docx_first_page", off.content)).toBeDefined();
  });

  it("typed 拒族：非布尔 firstDifferent / headerText 空串 / 控制字符 / 4001 码点 / false 带 headerText / 无引用关闭", async () => {
    const dir = await mkdtemp(join(tmpdir(), "o256-first-rejects-"));
    const rel = "报告.docx";
    await writeFile(join(dir, rel), withDefaultHeader("默认页眉"));
    const tool = createSetDocxFirstPageTool(dir);
    expect((await exec(tool, { path: rel, firstDifferent: "yes" })).content).toContain('"firstDifferent" must be a boolean');
    expect((await exec(tool, { path: rel, firstDifferent: true, headerText: "  " })).content).toContain('"headerText" must be a non-empty string');
    expect((await exec(tool, { path: rel, firstDifferent: true, headerText: "a\x01b" })).content).toContain("control character");
    expect((await exec(tool, { path: rel, firstDifferent: true, headerText: "字".repeat(4001) })).content).toContain("limited to 4000");
    expect((await exec(tool, { path: rel, firstDifferent: false, headerText: "x" })).content).toContain('不接受 "headerText"');
    expect((await exec(tool, { path: rel, firstDifferent: false })).content).toContain("本就没有设置首页不同");
    // 素文档（无 default 页眉也可开关首页不同——titlePg 与页眉存在无关）。
    const bareRel = "素.docx";
    await writeFile(join(dir, bareRel), doc([{ kind: "title", text: "裸" }]));
    const bareOn = await exec(tool, { path: bareRel, firstDifferent: true });
    expect(bareOn.isError).toBeFalsy();
    expect(bareOn.content.split("\n")[0]).toBe("首页已设为不同（无首页页眉）");
  });

  it("摘要器：log.ts 名册命中形（which 缺省=header；firstDifferent 两形）+ 238 前作零演进", () => {
    expect(summarizeClearDocxHeader({ path: "dir/报告.docx", which: "header" })).toBe("报告.docx 删除了页眉");
    expect(summarizeClearDocxHeader({ path: "a/简历.docx" })).toBe("简历.docx 删除了页眉");
    expect(summarizeSetDocxFirstPage({ path: "报告.docx", firstDifferent: true })).toBe("报告.docx 首页设为不同");
    expect(summarizeSetDocxFirstPage({ path: "报告.docx", firstDifferent: false })).toBe("报告.docx 首页设为与全篇相同");
    // 名册消费缝（log.ts 经 docSuiteSummarizers 命中）。
    expect(summarizeToolCall("clear_docx_header", { path: "a/报告.docx" })).toBe("报告.docx 删除了页眉");
    expect(summarizeToolCall("set_docx_first_page", { path: "a/报告.docx", firstDifferent: true })).toBe("报告.docx 首页设为不同");
    // 238 前作零演进（同缝共存）。
    expect(summarizeToolCall("set_docx_header", { path: "a/报告.docx", which: "header", text: "x" })).toBe("报告.docx 设置了页眉");
  });
});
