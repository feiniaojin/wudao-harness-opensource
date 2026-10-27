// ω99-238: #5 — set_docx_header receipts（docx 页眉页脚面：纯层四件全接 /
// 幂等覆写 / typed 拒族 / 4,000 字帽 / 互证链 / smartZip 保真 / 工具面收据）。
// RED-first：先红后绿（223/229/230 谱系）。
// ★测试红线（09-09 用户令，逐字）：「注意，开发、测试过程禁止删除用户文件/
// 文件夹。」夹具全内存（buildDocx 造裸文档 + 手搓 deflate 包）或
// mkdtemp(os.tmpdir()) 临时工作区**只写不删**；零删除调用。
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import type { Tool } from "@wudao/core";
// 写面原语（裸 docx 夹具）。
import { buildDocx } from "../src/doc-docx.js";
import type { DocBlock } from "../src/doc-docx.js";
// zip 地基。
import { crc32, unzipEntries, unzipEntriesWithMeta } from "../src/doc-zip.js";
import type { RawZipEntry } from "../src/doc-zip.js";
// 本弧 docx 部件面。
import {
  DOCX_CHROME_TEXT_MAX,
  setDocxChrome,
  validateDocxChrome,
  createSetDocxHeaderTool,
  summarizeSetDocxHeader,
} from "../src/doc-chrome.js";
// 消费面（收据门 / 摘要 / 权限钉）。
import { summarizeToolCall } from "../src/log.js";
import { FILE_EDIT_TOOLS } from "../src/permission.js";
import { extractFileReceipt } from "../src/driver/file-receipt.js";

const enc = new TextEncoder();
const XDECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const UTF8_FLAG = 0x0800;

const exec = async (tool: Tool, args: Record<string, unknown>) => tool.execute(args);

// ---------------------------------------------------------------------------
// 夹具工坊（全内存；零删除）
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

/** 手搓全 deflate（method 8）zip——模拟用户 Office 存的包（230 同款工坊）。 */
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
  return new Map(out.entries.map((e) => [e.name, e]));
}

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

/** 互证链（223 范式）：default headerReference r:id → rels 解析 → 部件文本
 *  读回（<w:t> 依序拼接，<w:br/> 折 \n——本面生成件的同构读回）。引用的
 *  sectPr 内位置由专测钉（sectPrChange 免疫件），此处扫全文档走链。 */
function chromeRoundtrip(bytes: Uint8Array, which: "header" | "footer"): string {
  const parts = mustUnzip(bytes);
  const document = new TextDecoder().decode(parts.get("word/document.xml")!.data);
  let rid: string | undefined;
  for (const m of document.matchAll(new RegExp(`<w:${which}Reference\\b[^>]*>`, "g"))) {
    if (attr(m[0], "w:type") === "default") rid = attr(m[0], "r:id");
  }
  expect(rid).toBeDefined();
  const rels = new TextDecoder().decode(parts.get("word/_rels/document.xml.rels")!.data);
  let target: string | undefined;
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    if (attr(m[0], "Id") === rid) target = attr(m[0], "Target");
  }
  expect(target).toBeDefined();
  const partName = `word/${target!.replace(/^\.\//, "")}`;
  const chrome = new TextDecoder().decode(parts.get(partName)!.data);
  expect(chrome.includes(which === "header" ? "<w:hdr" : "<w:ftr")).toBe(true);
  let out = "";
  for (const m of chrome.matchAll(/(<w:br\b[^>]*\/>)|<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)) {
    // <w:br/> 折 \n（本面生成件的多行形）；连续 <w:t> 直拼。
    if (m[1] !== undefined) out += "\n";
    else out += decodeEntities(m[2] ?? "");
  }
  return out;
}

// ---------------------------------------------------------------------------
// §1 纯层——裸 docx 建链：四件全接（部件 + sectPr 引用 + rels + content-type）
// ---------------------------------------------------------------------------

describe("ω99-238 R1(a) — 裸 docx set header：四件全接 + 读回等值", () => {
  it("header1.xml 在场 + sectPr default 引用 + rels 关系 + content-type override，文本读回等值", () => {
    const out = setDocxChrome(doc([{ kind: "title", text: "裸" }]), "header", "公司机密");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.created).toBe(true);
    expect(out.partName).toBe("word/header1.xml");
    const parts = mustUnzip(out.bytes);

    // 件①：部件在场，根是 <w:hdr>。
    const header = parts.get("word/header1.xml");
    expect(header).toBeDefined();
    expect(new TextDecoder().decode(header!.data).includes("<w:hdr")).toBe(true);

    // 件②：末节 sectPr 有 default headerReference。
    const document = new TextDecoder().decode(parts.get("word/document.xml")!.data);
    const sect = document.slice(document.lastIndexOf("<w:sectPr"));
    const refs = [...sect.matchAll(/<w:headerReference\b[^>]*>/g)].map((m) => m[0]);
    expect(refs.length).toBe(1);
    expect(attr(refs[0]!, "w:type")).toBe("default");
    // 引用必须在 sectPr 首子位（schema 序：headerReference 在 pgSz 前）。
    const sectInner = sect.slice(sect.indexOf(">") + 1);
    expect(sectInner.startsWith("<w:headerReference")).toBe(true);

    // 件③：document rels 有 header 关系，target 指向新部件。
    const rels = new TextDecoder().decode(parts.get("word/_rels/document.xml.rels")!.data);
    expect(rels.includes('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header"')).toBe(true);
    expect([...rels.matchAll(/<Relationship\b[^>]*>/g)].some((m) => attr(m[0], "Target") === "header1.xml" && attr(m[0], "Type")!.endsWith("/header"))).toBe(true);

    // 件④：content-type override。
    const ct = new TextDecoder().decode(parts.get("[Content_Types].xml")!.data);
    expect(ct.includes('<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>')).toBe(true);

    // 互证：r:id 链解析 → 文本往返等值。
    expect(chromeRoundtrip(out.bytes, "header")).toBe("公司机密");
  });

  it("XML 逃逸：text 含 &<>\"' 五实体往返等值", () => {
    const tricky = `A&B<C>"D"'E'`;
    const out = setDocxChrome(doc([{ kind: "body", text: "x" }]), "header", tricky);
    expect(out.ok).toBe(true);
    if (out.ok) expect(chromeRoundtrip(out.bytes, "header")).toBe(tricky);
  });

  it("多行 text（\\n 放行）往返等值（<w:br/> 折行）", () => {
    const out = setDocxChrome(doc([{ kind: "body", text: "x" }]), "header", "第一行\n第二行");
    expect(out.ok).toBe(true);
    if (out.ok) expect(chromeRoundtrip(out.bytes, "header")).toBe("第一行\n第二行");
  });

  it("碰撞纪律：包已有 header2.xml 时新部件号扫 max+1（header3）", () => {
    // 手造一个已有 header2.xml（无引用）的包：部件号有空洞——新部件不得用 1。
    const base = mustUnzip(doc([{ kind: "body", text: "x" }]));
    const parts = [...base.values()].map((e) => ({ name: e.name, data: e.data }));
    parts.push({ name: "word/header2.xml", data: enc.encode(`${XDECL}<w:hdr>旧</w:hdr>`) });
    const out = setDocxChrome(zipWithMethods(parts.map((p) => ({ ...p, method: 0 as const }))), "header", "新的");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.partName).toBe("word/header3.xml");
  });

  it("rId 碰撞：document rels 已有 rId5 时新 rId 扫 max+1", () => {
    const base = mustUnzip(doc([{ kind: "body", text: "x" }]));
    const parts = [...base.values()].map((e) => ({ name: e.name, data: e.data }));
    parts.push({
      name: "word/_rels/document.xml.rels",
      data: enc.encode(
        `${XDECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
      ),
    });
    const out = setDocxChrome(zipWithMethods(parts.map((p) => ({ ...p, method: 0 as const }))), "header", "页眉");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const rels = new TextDecoder().decode(mustUnzip(out.bytes).get("word/_rels/document.xml.rels")!.data);
    expect(rels.includes('Id="rId6"')).toBe(true);
    expect(rels.includes('Target="header1.xml"')).toBe(true);
  });

  it("锚定免疫：<w:sectPrChange>（修订标记，前缀同名 + 内嵌旧 sectPr）不劫持锚——引用落在当前 body 级 sectPr 首子位", () => {
    const base = mustUnzip(doc([{ kind: "body", text: "x" }]));
    const parts = [...base.values()].map((e) => ({ name: e.name, data: e.data }));
    const docIdx = parts.findIndex((p) => p.name === "word/document.xml");
    const docXml = new TextDecoder().decode(parts[docIdx!]!.data).replace(
      "</w:sectPr>",
      '<w:sectPrChange><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:sectPrChange></w:sectPr>',
    );
    parts[docIdx!] = { name: "word/document.xml", data: enc.encode(docXml) };
    const out = setDocxChrome(zipWithMethods(parts.map((p) => ({ ...p, method: 0 as const }))), "header", "页眉");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const after = new TextDecoder().decode(mustUnzip(out.bytes).get("word/document.xml")!.data);
    // 引用必须在真 sectPr 开标签之后、pgSz 之前（首子位），且不在 sectPrChange 内。
    const open = after.indexOf("<w:sectPr>");
    expect(after.slice(open, open + 220)).toContain('<w:headerReference w:type="default" r:id="rId1"/><w:pgSz');
    // sectPrChange 原样保留（修订历史不碰）。
    expect(after.includes("<w:sectPrChange>")).toBe(true);
    expect(chromeRoundtrip(out.bytes, "header")).toBe("页眉");
  });

  it("自闭合 sectPr（<w:sectPr/>，schema 上 pgSz 必子、本就无效）→ 结构拒", () => {
    const base = mustUnzip(doc([{ kind: "body", text: "x" }]));
    const parts = [...base.values()].map((e) => ({ name: e.name, data: e.data }));
    const docIdx = parts.findIndex((p) => p.name === "word/document.xml");
    const docXml = new TextDecoder().decode(parts[docIdx!]!.data).replace(/<w:sectPr>[\s\S]*?<\/w:sectPr>/, "<w:sectPr/>");
    parts[docIdx!] = { name: "word/document.xml", data: enc.encode(docXml) };
    expect(setDocxChrome(zipWithMethods(parts.map((p) => ({ ...p, method: 0 as const }))), "header", "页眉")).toEqual({
      ok: false,
      error: "这不是有效的 Word（.docx）文件——文件结构不完整或已损坏",
    });
  });
});

// ---------------------------------------------------------------------------
// §2 纯层——幂等覆写（已有 reference：原位换文本，部件数不增）
// ---------------------------------------------------------------------------

describe("ω99-238 R1(b) — 幂等覆写", () => {
  it("set 两次：第二次部件数不增、部件名不变、文本换新", () => {
    const first = setDocxChrome(doc([{ kind: "body", text: "x" }]), "header", "第一版");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = setDocxChrome(first.bytes, "header", "第二版换了文本");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(false);
    expect(second.partName).toBe(first.partName);
    expect(mustUnzip(second.bytes).size).toBe(mustUnzip(first.bytes).size);
    expect(chromeRoundtrip(second.bytes, "header")).toBe("第二版换了文本");
    // rels 不加第二条 header 关系（幂等：覆写不新增布线）。
    const rels = new TextDecoder().decode(mustUnzip(second.bytes).get("word/_rels/document.xml.rels")!.data);
    expect([...rels.matchAll(/\/header"/g)].length).toBe(1);
  });

  it("header 与 footer 各自独立幂等（互不抢占部件号空间）", () => {
    const base = doc([{ kind: "body", text: "x" }]);
    const withHeader = setDocxChrome(base, "header", "页眉一");
    expect(withHeader.ok).toBe(true);
    if (!withHeader.ok) return;
    const withBoth = setDocxChrome(withHeader.bytes, "footer", "页脚一");
    expect(withBoth.ok).toBe(true);
    if (!withBoth.ok) return;
    expect(withBoth.partName).toBe("word/footer1.xml");
    const again = setDocxChrome(withBoth.bytes, "header", "页眉二");
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.partName).toBe(withHeader.partName);
    expect(chromeRoundtrip(again.bytes, "header")).toBe("页眉二");
    expect(chromeRoundtrip(again.bytes, "footer")).toBe("页脚一");
  });
});

// ---------------------------------------------------------------------------
// §3 footer 对照（R1(c)）
// ---------------------------------------------------------------------------

describe("ω99-238 R1(c) — footer 同款对照", () => {
  it("裸 docx set footer：footerReference + <w:ftr> 根 + footer+xml content-type + 读回", () => {
    const out = setDocxChrome(doc([{ kind: "body", text: "x" }]), "footer", "第 1 页");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.partName).toBe("word/footer1.xml");
    const ct = new TextDecoder().decode(mustUnzip(out.bytes).get("[Content_Types].xml")!.data);
    expect(ct.includes("wordprocessingml.footer+xml")).toBe(true);
    expect(chromeRoundtrip(out.bytes, "footer")).toBe("第 1 页");
  });
});

// ---------------------------------------------------------------------------
// §4 typed 拒族（R1(d)(e)(f)——文案族逐字）
// ---------------------------------------------------------------------------

describe("ω99-238 R1(d)(e)(f) — 校验 typed 拒（先于任何盘副作用）", () => {
  it("which 非法值 → typed 拒", () => {
    expect(validateDocxChrome("top", "文本")).toEqual({ ok: false, error: '"which" must be "header" or "footer" (got "top")' });
    expect(validateDocxChrome(42, "文本")).toEqual({ ok: false, error: '"which" must be "header" or "footer" (got 42)' });
    expect(validateDocxChrome(undefined, "文本")).toEqual({ ok: false, error: '"which" must be "header" or "footer" (got undefined)' });
  });

  it("text 空串/纯空白/非字符串 → typed 拒", () => {
    expect(validateDocxChrome("header", "")).toEqual({ ok: false, error: '"text" must be a non-empty string' });
    expect(validateDocxChrome("header", "   \n\t ")).toEqual({ ok: false, error: '"text" must be a non-empty string' });
    expect(validateDocxChrome("header", 42)).toEqual({ ok: false, error: '"text" must be a non-empty string' });
    expect(validateDocxChrome("header", undefined)).toEqual({ ok: false, error: '"text" must be a non-empty string' });
  });

  it("text 控制字符 → typed 拒（doc-docx.ts :139 同款校验文案族；\\t\\n\\r 放行）", () => {
    expect(validateDocxChrome("header", "坏\x07字符")).toEqual({
      ok: false,
      error: '"text" contains a control character that cannot go into a document — remove it (tabs and line breaks are fine)',
    });
    expect(validateDocxChrome("header", "坏\x1F字符").ok).toBe(false);
    expect(validateDocxChrome("header", "好\t制表").ok).toBe(true);
    expect(validateDocxChrome("header", "好\n换行").ok).toBe(true);
  });

  it(`text ${DOCX_CHROME_TEXT_MAX + 1} 字 → 帽拒（防部件炸弹）`, () => {
    expect(DOCX_CHROME_TEXT_MAX).toBe(4000);
    const over = "长".repeat(DOCX_CHROME_TEXT_MAX + 1);
    expect(validateDocxChrome("header", over)).toEqual({
      ok: false,
      error: `"text" is limited to ${DOCX_CHROME_TEXT_MAX} characters, got ${DOCX_CHROME_TEXT_MAX + 1}`,
    });
    expect(validateDocxChrome("header", "长".repeat(DOCX_CHROME_TEXT_MAX)).ok).toBe(true);
  });

  it("结构拒：非 zip / 缺 document.xml / 缺 sectPr → 用户语拒", () => {
    expect(setDocxChrome(enc.encode("not a zip"), "header", "x")).toEqual({
      ok: false,
      error: "这不是有效的 Word（.docx）文件——文件结构不完整或已损坏",
    });
    const noDoc = zipWithMethods([{ name: "[Content_Types].xml", data: enc.encode("<Types/>"), method: 0 }]);
    expect(setDocxChrome(noDoc, "header", "x")).toEqual({
      ok: false,
      error: "这不是有效的 Word（.docx）文件——缺少文档内容",
    });
    const badBody = zipWithMethods([
      { name: "word/document.xml", data: enc.encode(`${XDECL}<w:document><w:body></w:body></w:document>`), method: 0 },
    ]);
    expect(setDocxChrome(badBody, "header", "x")).toEqual({
      ok: false,
      error: "这不是有效的 Word（.docx）文件——文件结构不完整或已损坏",
    });
  });
});

// ---------------------------------------------------------------------------
// §5 smartZip 保真（R1(h)——230 bytesEqual 钉同款：未改部件原压缩载荷直过）
// ---------------------------------------------------------------------------

describe("ω99-238 R1(h) — smartZip 保真：未改部件原压缩载荷字节直过", () => {
  it("deflate 包 set header 后：docProps/媒体等未改部件 method 8 保留 + 原载荷逐字节直过", () => {
    // 用户 Office 形的包：全 deflate + 一个二进制媒体部件（document.xml 之外的
    // 未改部件代表）。
    const media = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
    const base = mustUnzip(doc([{ kind: "body", text: "x" }]));
    const parts: Part[] = [...base.values()].map((e) => ({ name: e.name, data: e.data }));
    parts.push({ name: "word/media/image1.png", data: media });
    const packed = deflatedZip(parts);

    const out = setDocxChrome(packed, "header", "页眉");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const after = mustUnzip(out.bytes);
    const before = mustUnzip(packed);
    // 未改四件：原 method 8、原压缩载荷逐字节直过、解压内容等。
    for (const name of ["_rels/.rels", "docProps/core.xml", "docProps/app.xml", "word/media/image1.png"]) {
      const b = before.get(name)!;
      const a = after.get(name)!;
      expect(a.method).toBe(8);
      expect(bytesEqual(a.raw, b.raw)).toBe(true);
      expect(bytesEqual(a.data, b.data)).toBe(true);
    }
    // 改到的 document.xml：仍是 method 8（按原 method 重压），内容已变。
    expect(after.get("word/document.xml")!.method).toBe(8);
    // 新部件（无原）：stored。
    expect(after.get("word/header1.xml")!.method).toBe(0);
    expect(after.get("word/_rels/document.xml.rels")!.method).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §6 确定性（同输入两次全等）
// ---------------------------------------------------------------------------

describe("ω99-238 R1(g) — 确定性与互证链", () => {
  it("同输入两次 set → 逐字节全等", () => {
    const base = doc([{ kind: "heading", text: "节" }, { kind: "body", text: "文" }]);
    const a = setDocxChrome(base, "header", "页眉");
    const b = setDocxChrome(base, "header", "页眉");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(bytesEqual(a.bytes, b.bytes)).toBe(true);
    // 回装仍是合法 zip（unzipEntries 读面口径全数解出）。
    const legacy = unzipEntries(a.bytes);
    expect(legacy.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §7 工具面：门序 / 收据 / summarize / 权限（真文件走 mkdtemp 只写）
// ---------------------------------------------------------------------------

describe("ω99-238 §7 — set_docx_header 工具面", () => {
  it("真文件 set header：收据逐字（brief §二）+ JSON 尾行 + 回读等值", async () => {
    const dir = await mkdtemp(join(tmpdir(), "o238-chrome-"));
    const rel = "报告.docx";
    await writeFile(join(dir, rel), doc([{ kind: "title", text: "标题" }]));
    const tool = createSetDocxHeaderTool(dir);
    const out = await exec(tool, { path: rel, which: "header", text: "公司机密" });
    expect(out.isError).toBeUndefined();
    const lines = out.content.split("\n");
    expect(lines[0]).toBe(`已设置页眉：「公司机密」`);
    const receipt = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(receipt["relativePath"]).toBe(rel);
    expect(receipt["which"]).toBe("header");
    expect(typeof receipt["bytes"]).toBe("number");
    // 回读互证（盘上真文件）。
    expect(chromeRoundtrip(await readFile(join(dir, rel)), "header")).toBe("公司机密");
  });

  it("收据前 20 字截断 + 「…」（超长不帽拒的合法长度）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "o238-chrome-trunc-"));
    const rel = "长页眉.docx";
    await writeFile(join(dir, rel), doc([{ kind: "body", text: "x" }]));
    const tool = createSetDocxHeaderTool(dir);
    const text = "字".repeat(25);
    const out = await exec(tool, { path: rel, which: "footer", text });
    expect(out.content.split("\n")[0]).toBe(`已设置页脚：「${"字".repeat(20)}…」`);
  });

  it("拒链（先于副作用）：路径/which/text/帽/ENOENT/OLE/非 PK，文案逐字", async () => {
    const dir = await mkdtemp(join(tmpdir(), "o238-chrome-rej-"));
    const tool = createSetDocxHeaderTool(dir);
    await writeFile(join(dir, "报告.docx"), doc([{ kind: "body", text: "x" }]));
    await writeFile(join(dir, "旧.doc"), new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]));
    await writeFile(join(dir, "plain.txt"), enc.encode("hello"));
    expect((await exec(tool, { path: "", which: "header", text: "x" })).content).toBe(
      'set_docx_header: "path" must be a non-empty path relative to the workspace',
    );
    expect((await exec(tool, { path: "报告.docx", which: "top", text: "x" })).content).toBe(
      'set_docx_header: "which" must be "header" or "footer" (got "top")',
    );
    expect((await exec(tool, { path: "报告.docx", which: "header", text: "  " })).content).toBe(
      'set_docx_header: "text" must be a non-empty string',
    );
    expect((await exec(tool, { path: "报告.docx", which: "header", text: "a\x07b" })).content).toBe(
      'set_docx_header: "text" contains a control character that cannot go into a document — remove it (tabs and line breaks are fine)',
    );
    expect((await exec(tool, { path: "报告.docx", which: "header", text: "长".repeat(4001) })).content).toBe(
      'set_docx_header: "text" is limited to 4000 characters, got 4001',
    );
    expect((await exec(tool, { path: "无.docx", which: "header", text: "x" })).content).toBe(
      "set_docx_header: 文件不存在：无.docx",
    );
    expect((await exec(tool, { path: "旧.doc", which: "header", text: "x" })).content).toBe(
      "set_docx_header: 旧.doc 是旧版 .doc 格式，改不了——请先用 Word 打开并「另存为」.docx 格式后再试",
    );
    expect((await exec(tool, { path: "plain.txt", which: "header", text: "x" })).content).toBe(
      "set_docx_header: plain.txt 不是 Word（.docx）文档——如果它是旧版 .doc 或其他格式，请先在 Word 里另存为 .docx 再试",
    );
    expect((await exec(tool, { path: "../外逃.docx", which: "header", text: "x" })).content).toContain("set_docx_header:");
  });

  it("幂等语义落到真文件：两次 set 后部件数不增、文本换新", async () => {
    const dir = await mkdtemp(join(tmpdir(), "o238-chrome-idem-"));
    const rel = "幂等.docx";
    await writeFile(join(dir, rel), doc([{ kind: "body", text: "x" }]));
    const tool = createSetDocxHeaderTool(dir);
    await exec(tool, { path: rel, which: "header", text: "一" });
    const first = await readFile(join(dir, rel));
    await exec(tool, { path: rel, which: "header", text: "二" });
    const second = await readFile(join(dir, rel));
    expect(mustUnzip(second).size).toBe(mustUnzip(first).size);
    expect(chromeRoundtrip(second, "header")).toBe("二");
  });

  it("summarize：`设置了页眉/页脚`（which 插值；brief §二）+ 收据门 + 权限册", () => {
    expect(summarizeSetDocxHeader({ path: "dir/报告.docx", which: "header", text: "x" })).toBe("报告.docx 设置了页眉");
    expect(summarizeSetDocxHeader({ path: "报告.docx", which: "footer", text: "x" })).toBe("报告.docx 设置了页脚");
    expect(summarizeToolCall("set_docx_header", { path: "a/报告.docx", which: "header", text: "x" })).toBe("报告.docx 设置了页眉");
    // 收据门（file-receipt 名册展开自动受益）。
    const receipt = `已设置页眉：「公司机密」\n${JSON.stringify({ path: "/tmp/ws/报告.docx", relativePath: "报告.docx", which: "header", bytes: 4096 })}`;
    expect(extractFileReceipt("set_docx_header", receipt)).toBeDefined();
    expect(extractFileReceipt("set_docx_header", "set_docx_header: 写入失败（boom）")).toBeUndefined();
    // 权限册（FILE_EDIT_TOOLS 名册展开自动受益）。
    expect(FILE_EDIT_TOOLS.has("set_docx_header")).toBe(true);
  });
});
