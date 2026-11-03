// ω99-230: #R1 — 压缩透传 receipts（四层：unzipEntriesWithMeta 镜像 / smartZip
// 三形裁定 / 五 repack 面 e2e / 工具面过真文件）。RED-first。
// ★测试红线（09-09 用户令，逐字）：「注意，开发、测试过程禁止删除用户文件/
// 文件夹。」夹具全内存（手搓 zip 字节 + deflateRawSync 造 deflate 条目）或
// mkdtemp(os.tmpdir()) 临时工作区**只写不删**；零删除调用；零真实键鼠/截屏
// （本弧不涉）。
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { Tool } from "@wudao-org/core";
// zip 地基（本弧增量：unzipEntriesWithMeta / smartZip）+ 123 写器（夹具）。
import { crc32, smartZip, storedZip, unzipEntries, unzipEntriesWithMeta } from "../src/doc-zip.js";
import type { RawZipEntry } from "../src/doc-zip.js";
// 五 repack 面（e2e 主角）。
import { appendXlsx, createAppendXlsxTool } from "../src/doc-xlsx-append.js";
import { appendDocx, appendDocxBlocks } from "../src/doc-docx-append.js";
import { appendPptxSlides } from "../src/doc-pptx-append.js";
import { replaceDocxText, replacePptxText, createReplaceDocxTool } from "../src/doc-replace.js";
// 读面（读写互证——Excel/Word/PPT 兼容代理）。
import { parseXlsxSheets } from "../src/doc-xlsx-read.js";
import { parseDocxDocument } from "../src/doc-docx-read.js";
import { parsePptxSlides } from "../src/doc-pptx-read.js";
// make 面（pptx/docx 真产物 → 重压成 deflate 夹具，模拟用户 Office 存的包）。
import { buildPptx } from "../src/doc-pptx.js";
import { buildDocx } from "../src/doc-docx.js";
import type { DocBlock, DocDeck } from "../src/doc-docx.js";

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

const part = (name: string, xml: string): Part => ({ name, data: enc.encode(xml) });

/** 手搓混合 method zip（条目各带 method 0|8；可选 local extra 字段——Office
 *  形「header 不复刻 extra」夹具用）。221 deflatedZip 的 method 参数化泛化。 */
function zipWithMethods(entries: readonly MethodPart[], localExtra = 0): Uint8Array {
  const packed = entries.map((e) =>
    e.method === 8 ? { name: e.name, raw: e.data, data: deflateRawSync(e.data), method: 8 as const } : { name: e.name, raw: e.data, data: e.data, method: 0 as const },
  );
  const nameBytes = packed.map((e) => enc.encode(e.name));
  const localLen = packed.reduce((s, e, i) => s + 30 + nameBytes[i]!.length + localExtra + e.data.length, 0);
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
    dv.setUint16(o + 28, localExtra, true);
    out.set(nb, o + 30);
    out.set(e.data, o + 30 + nb.length + localExtra);
    o += 30 + nb.length + localExtra + e.data.length;
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
    dv.setUint16(o + 32, 0, true);
    dv.setUint16(o + 34, 0, true);
    dv.setUint16(o + 36, 0, true);
    dv.setUint32(o + 38, 0, true);
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

/** 手搓单条目 zip（method/flags 可控——拒链夹具的底座；221 同款）。 */
function singleEntryZip(data: Uint8Array, name: string, method: number, flags: number): Uint8Array {
  const nameBytes = enc.encode(name);
  const localLen = 30 + nameBytes.length + data.length;
  const out = new Uint8Array(localLen + 46 + nameBytes.length + 22);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x04034b50, true);
  dv.setUint16(4, 20, true);
  dv.setUint16(6, flags, true);
  dv.setUint16(8, method, true);
  dv.setUint16(10, 0, true);
  dv.setUint16(12, 0x21, true);
  dv.setUint32(14, crc32(data), true);
  dv.setUint32(18, data.length, true);
  dv.setUint32(22, data.length, true);
  dv.setUint16(26, nameBytes.length, true);
  dv.setUint16(28, 0, true);
  out.set(nameBytes, 30);
  out.set(data, 30 + nameBytes.length);
  const cd = localLen;
  dv.setUint32(cd, 0x02014b50, true);
  dv.setUint16(cd + 4, 20, true);
  dv.setUint16(cd + 6, 20, true);
  dv.setUint16(cd + 8, flags, true);
  dv.setUint16(cd + 10, method, true);
  dv.setUint16(cd + 12, 0, true);
  dv.setUint16(cd + 14, 0x21, true);
  dv.setUint32(cd + 16, crc32(data), true);
  dv.setUint32(cd + 20, data.length, true);
  dv.setUint32(cd + 24, data.length, true);
  dv.setUint16(cd + 28, nameBytes.length, true);
  dv.setUint16(cd + 30, 0, true);
  dv.setUint16(cd + 32, 0, true);
  dv.setUint16(cd + 34, 0, true);
  dv.setUint16(cd + 36, 0, true);
  dv.setUint32(cd + 38, 0, true);
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

/** 整包重压成全 deflate（模拟用户 Office 存的包——正文 XML 压 5-10 倍）。 */
function rezipDeflated(bytes: Uint8Array): Uint8Array {
  const un = unzipEntries(bytes);
  if (!un.ok) throw new Error(`fixture unzip failed: ${un.error}`);
  return zipWithMethods(un.entries.map((e) => ({ name: e.name, data: e.data, method: 8 as const })));
}

/** unzipEntriesWithMeta 的窄化帮手（夹具层：失败即夹具坏，抛出终止）。 */
function mustUnzipMeta(bytes: Uint8Array): RawZipEntry[] {
  const un = unzipEntriesWithMeta(bytes);
  if (!un.ok) throw new Error(`fixture unzipMeta failed: ${un.error}`);
  return [...un.entries];
}

/** 解出的条目按名索引（meta 形——载荷透传比对用）。 */
function metaByName(bytes: Uint8Array): Map<string, RawZipEntry> {
  return new Map(mustUnzipMeta(bytes).map((e) => [e.name, e]));
}

/** 全条目挂 meta（repack 面的标准装填形：改动判定交给 smartZip 自行比对）。 */
const withMeta = (entries: readonly RawZipEntry[]) => entries.map((e) => ({ name: e.name, data: e.data, meta: e }));

/** CD 与 local header 对读链（method/CRC/两尺寸四字段每条目；223 zipCrcs 的扩形）。 */
function cdLocalChain(bytes: Uint8Array): { name: string; cd: { method: number; crc: number; comp: number; uncomp: number }; local: { method: number; crc: number; comp: number; uncomp: number } }[] {
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
  const out: ReturnType<typeof cdLocalChain> = [];
  for (let n = 0; n < count; n++) {
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    out.push({
      name,
      cd: { method: dv.getUint16(p + 10, true), crc: dv.getUint32(p + 16, true), comp: dv.getUint32(p + 20, true), uncomp: dv.getUint32(p + 24, true) },
      local: { method: dv.getUint16(localOffset + 8, true), crc: dv.getUint32(localOffset + 14, true), comp: dv.getUint32(localOffset + 18, true), uncomp: dv.getUint32(localOffset + 22, true) },
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 读面窄化帮手（读写互证）。 */
function mustParseXlsx(bytes: Uint8Array) {
  const r = parseXlsxSheets(bytes);
  if (!r.ok) throw new Error(`parseXlsxSheets failed: ${r.error}`);
  return r.sheets;
}
function mustParseDocx(bytes: Uint8Array) {
  const r = parseDocxDocument(bytes);
  if (!r.ok) throw new Error(`parseDocxDocument failed: ${r.error}`);
  return r.doc;
}
function mustParsePptx(bytes: Uint8Array) {
  const r = parsePptxSlides(bytes);
  if (!r.ok) throw new Error(`parsePptxSlides failed: ${r.error}`);
  return r.slides;
}

// §2 的混合包：A=大 deflate / B=stored / C=中 deflate。
const BIG_TEXT = "销售明细，第 001 行：机械键盘\t十二\tTRUE。备注入库与盘点口径一致。".repeat(80);
const MID_TEXT = "中部部件：季度经营回顾，数据口径与去年一致。".repeat(30);
const MIX = zipWithMethods([
  { name: "big-deflate.xml", data: enc.encode(BIG_TEXT), method: 8 },
  { name: "small-stored.xml", data: enc.encode("stored 原文，不经压缩。"), method: 0 },
  { name: "mid-deflate.xml", data: enc.encode(MID_TEXT), method: 8 },
]);

// §3 的 OOXML 夹具（全 deflate——用户 Office 存的包形）。
const NS_M = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const sheetRowsXml =
  `<row r="1"><c r="A1" t="inlineStr"><is><t>品名</t></is></c><c r="B1" t="inlineStr"><is><t>数量</t></is></c></row>` +
  Array.from({ length: 40 }, (_, i) =>
    `<row r="${i + 2}"><c r="A${i + 2}" t="inlineStr"><is><t>机械键盘-标准版-${String(i + 1).padStart(3, "0")}</t></is></c><c r="B${i + 2}" t="inlineStr"><is><t>${(i + 1) * 3}</t></is></c></row>`,
  ).join("");

const XLSX_DEFLATED = zipWithMethods([
  { name: "docProps/core.xml", data: enc.encode(`${XDECL}<coreProperties/>`), method: 8 },
  {
    name: "xl/workbook.xml",
    data: enc.encode(
      `${XDECL}<workbook xmlns="${NS_M}" xmlns:r="${NS_R}"><sheets><sheet name="销售明细" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    method: 8,
  },
  {
    name: "xl/_rels/workbook.xml.rels",
    data: enc.encode(
      `${XDECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${NS_R}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    method: 8,
  },
  {
    name: "xl/worksheets/sheet1.xml",
    data: enc.encode(`${XDECL}<worksheet xmlns="${NS_M}"><sheetData>${sheetRowsXml}</sheetData></worksheet>`),
    method: 8,
  },
]);

const docXml = (body: string): string =>
  `${XDECL}<w:document xmlns:w="${NS_W}"><w:body>${body}<w:sectPr/></w:body></w:document>`;
const wP = (t: string): string => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;

const DOCX_BODY =
  wP("开场：本报告由旧公司名出具，口径如下。") +
  Array.from({ length: 30 }, (_, i) => wP(`正文第 ${i + 1} 段：旧公司名的季度经营回顾，数据口径与去年一致，结论与展望略。`)).join("");

const DOCX_DEFLATED = zipWithMethods([
  { name: "[Content_Types].xml", data: enc.encode(`${XDECL}<Types/>`), method: 8 },
  { name: "word/document.xml", data: enc.encode(docXml(DOCX_BODY)), method: 8 },
]);

const PPTX_DEFLATED = rezipDeflated(
  buildPptx({
    slides: [
      { kind: "bullets", title: "页一", bullets: ["旧公司名简介"] },
      { kind: "bullets", title: "页二", bullets: ["二"] },
    ],
  }),
);

const NEW_BLOCKS: readonly DocBlock[] = [
  { kind: "heading", text: "补充小节" },
  { kind: "body", text: "追加段" },
];
const NEW_SLIDES: DocDeck["slides"] = [
  { kind: "bullets", title: "新页甲", bullets: ["甲一"] },
];

// ---------------------------------------------------------------------------
// §1 unzipEntriesWithMeta（镜像 unzipEntries：拒链逐字同、meta 齐、双跑一致）
// ---------------------------------------------------------------------------

describe("ω99-230 §1 — unzipEntriesWithMeta（镜像 unzipEntries）", () => {
  it("双形 meta 齐：method 0|8、raw=原压缩载荷、crc=crc32(原内容)、compSize=原压缩尺寸（raw 可 inflate 回）", () => {
    const entries = mustUnzipMeta(MIX);
    expect(entries.map((e) => e.name)).toEqual(["big-deflate.xml", "small-stored.xml", "mid-deflate.xml"]);
    const big = entries[0]!;
    expect(big.method).toBe(8);
    expect(big.compSize).toBe(deflateRawSync(enc.encode(BIG_TEXT)).length);
    expect(big.crc).toBe(crc32(enc.encode(BIG_TEXT)));
    expect(bytesEqual(inflateRawSync(big.raw), big.data)).toBe(true);
    expect(new TextDecoder().decode(big.data)).toBe(BIG_TEXT);
    const small = entries[1]!;
    expect(small.method).toBe(0);
    expect(small.compSize).toBe(small.data.length);
    expect(bytesEqual(small.raw, small.data)).toBe(true);
    expect(small.crc).toBe(crc32(small.data));
  });

  it("拒链逐字同 unzipEntries：加密 / Zip64 两形 / 坏结构——同包双跑同文案同拒", () => {
    const bads: Uint8Array[] = [
      singleEntryZip(enc.encode("<wb/>"), "xl/workbook.xml", 0, UTF8_FLAG | 0x0001), // 加密旗
      (() => {
        // Zip64 形一：EOCD 条目总数踩 0xFFFF 标记。
        const a = singleEntryZip(enc.encode("<wb/>"), "xl/workbook.xml", 0, UTF8_FLAG);
        new DataView(a.buffer).setUint16(a.length - 22 + 10, 0xffff, true);
        return a;
      })(),
      (() => {
        // Zip64 形二：中央目录 local offset 踩 0xFFFFFFFF 标记。
        const b = singleEntryZip(enc.encode("<wb/>"), "xl/workbook.xml", 0, UTF8_FLAG);
        const dvB = new DataView(b.buffer);
        const cdOff = b.length - 22 - (46 + "xl/workbook.xml".length);
        dvB.setUint32(cdOff + 42, 0xffffffff, true);
        return b;
      })(),
      enc.encode("这不是一个 zip 文件，只是一段文本。"), // 坏结构
      singleEntryZip(enc.encode("<wb/>"), "xl/workbook.xml", 12, UTF8_FLAG), // 不支持的压缩方式
    ];
    for (const bad of bads) {
      const meta = unzipEntriesWithMeta(bad);
      const plain = unzipEntries(bad);
      expect(meta.ok).toBe(false);
      expect(plain.ok).toBe(false);
      if (meta.ok || plain.ok) return;
      expect(meta.error).toBe(plain.error); // 拒链逐字同（镜像纪律）
    }
  });

  it("同包双跑内容一致：与 unzipEntries 的条目名序与 data 逐条等长等值", () => {
    const plain = unzipEntries(MIX);
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    const meta = mustUnzipMeta(MIX);
    expect(meta.length).toBe(plain.entries.length);
    meta.forEach((m, i) => {
      expect(m.name).toBe(plain.entries[i]!.name);
      expect(m.data.length).toBe(plain.entries[i]!.data.length);
      expect(bytesEqual(m.data, plain.entries[i]!.data)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// §2 smartZip 三形裁定（未改直过 / 已改重压 / 缺省 stored）+ 确定性 + CD 链
// ---------------------------------------------------------------------------

describe("ω99-230 §2 — smartZip 三形裁定", () => {
  it("未改直过（deflate）：raw 逐位等 + 原 method/CRC/compSize 保真；同构夹具整机逐字节等", () => {
    const meta = mustUnzipMeta(MIX);
    const out = smartZip(withMeta(meta));
    const after = mustUnzipMeta(out);
    after.forEach((a, i) => {
      expect(a.method).toBe(meta[i]!.method);
      expect(a.crc).toBe(meta[i]!.crc);
      expect(a.compSize).toBe(meta[i]!.compSize);
      expect(bytesEqual(a.raw, meta[i]!.raw)).toBe(true); // 原压缩载荷字节直过
    });
    // 同构夹具（同 header 布局 + 同 DOS 常量 + 无 extra）：全直过回装整机逐字节等。
    expect(bytesEqual(out, MIX)).toBe(true);
  });

  it("已改原 deflate → method 8 重压：inflate 回等 + CRC=crc32(新内容) + compSize=新载荷长；体积回原量级", () => {
    const meta = mustUnzipMeta(MIX);
    const fresh = enc.encode(BIG_TEXT.replace("机械键盘", "静电容键盘").concat("——追加的新内容。"));
    const out = smartZip([{ name: meta[0]!.name, data: fresh, meta: meta[0]! }]);
    const after = mustUnzipMeta(out);
    expect(after[0]!.method).toBe(8);
    expect(bytesEqual(inflateRawSync(after[0]!.raw), fresh)).toBe(true); // 重压载荷可解回
    expect(after[0]!.crc).toBe(crc32(fresh));
    expect(after[0]!.compSize).toBe(after[0]!.raw.length);
    expect(after[0]!.data.length).toBe(fresh.length);
    // 压缩量级回到 deflate 档（stored 重装会到 fresh.length 级——远大于此）。
    expect(after[0]!.compSize).toBeLessThan(fresh.length / 3);
  });

  it("已改原 stored → 照旧 stored：payload=data、CRC=crc32(新内容)、两尺寸恒等", () => {
    const meta = mustUnzipMeta(MIX);
    const fresh = enc.encode("stored 改后的新内容。");
    const out = smartZip([{ name: meta[1]!.name, data: fresh, meta: meta[1]! }]);
    const after = mustUnzipMeta(out);
    expect(after[0]!.method).toBe(0);
    expect(bytesEqual(after[0]!.raw, fresh)).toBe(true);
    expect(after[0]!.crc).toBe(crc32(fresh));
    expect(after[0]!.compSize).toBe(fresh.length);
    expect(after[0]!.data.length).toBe(fresh.length);
  });

  it("无 meta 条目缺省 stored：123 写器纪律不掺透传", () => {
    const fresh = enc.encode("全新部件，无原条目。");
    const out = smartZip([{ name: "新部件.xml", data: fresh }]);
    const after = mustUnzipMeta(out);
    expect(after[0]!.method).toBe(0);
    expect(bytesEqual(after[0]!.raw, fresh)).toBe(true);
    expect(after[0]!.crc).toBe(crc32(fresh));
  });

  it("混合包一包内三形齐：改 A（8 重压）/ 未改 B（stored 直过）/ 未改 C（8 直过）逐条目各归各位", () => {
    const meta = mustUnzipMeta(MIX);
    const freshA = enc.encode(BIG_TEXT.concat("——新版本。"));
    const out = smartZip([
      { name: meta[0]!.name, data: freshA, meta: meta[0]! }, // 已改原 deflate
      { name: meta[1]!.name, data: meta[1]!.data, meta: meta[1]! }, // 未改 stored
      { name: meta[2]!.name, data: meta[2]!.data, meta: meta[2]! }, // 未改 deflate
    ]);
    const after = mustUnzipMeta(out);
    expect(after[0]!.method).toBe(8);
    expect(bytesEqual(inflateRawSync(after[0]!.raw), freshA)).toBe(true);
    expect(bytesEqual(after[0]!.raw, meta[0]!.raw)).toBe(false); // 改过 → 不是原载荷
    expect(after[1]!.method).toBe(0);
    expect(bytesEqual(after[1]!.raw, meta[1]!.raw)).toBe(true);
    expect(after[2]!.method).toBe(8);
    expect(bytesEqual(after[2]!.raw, meta[2]!.raw)).toBe(true);
  });

  it("确定性：同输入两次全等（固定 deflate 选项 + 固定 DOS 时戳 + 条目名序原样）", () => {
    const meta = mustUnzipMeta(MIX);
    const entries = [
      { name: meta[0]!.name, data: enc.encode(BIG_TEXT.concat("v2")), meta: meta[0]! },
      { name: meta[1]!.name, data: meta[1]!.data, meta: meta[1]! },
    ];
    expect(bytesEqual(smartZip(entries), smartZip(entries))).toBe(true);
  });

  it("CD=local 同 method 同 CRC 同两尺寸（每条目四字段对读，重压/直过两形都查）", () => {
    const meta = mustUnzipMeta(MIX);
    const out = smartZip([
      { name: meta[0]!.name, data: enc.encode(BIG_TEXT.concat("——链验证。")), meta: meta[0]! },
      { name: meta[1]!.name, data: meta[1]!.data, meta: meta[1]! },
      { name: meta[2]!.name, data: meta[2]!.data, meta: meta[2]! },
    ]);
    const chain = cdLocalChain(out);
    expect(chain.map((c) => c.name)).toEqual(["big-deflate.xml", "small-stored.xml", "mid-deflate.xml"]);
    for (const c of chain) {
      expect(c.local.method).toBe(c.cd.method);
      expect(c.local.crc).toBe(c.cd.crc);
      expect(c.local.comp).toBe(c.cd.comp);
      expect(c.local.uncomp).toBe(c.cd.uncomp);
    }
    // 直过条目的 CD 值=原包 CD 值（保真链）；重压条目的 CD CRC=crc32(新内容)。
    expect(chain[1]!.cd.crc).toBe(meta[1]!.crc);
    expect(chain[2]!.cd.crc).toBe(meta[2]!.crc);
    expect(chain[0]!.cd.crc).toBe(crc32(enc.encode(BIG_TEXT.concat("——链验证。"))));
  });

  it("65535 帽照旧：65536 条目 throw（123 写器同款守卫）", () => {
    const huge = Array.from({ length: 65536 }, (_, i) => ({ name: `e${i}`, data: new Uint8Array(0) }));
    expect(() => smartZip(huge)).toThrow(/65535/);
  });

  it("Office 形（local extra 字段）：载荷直过等、新 header 不复刻 extra（整机不等、读面同形）", () => {
    const original = zipWithMethods([{ name: "big-deflate.xml", data: enc.encode(BIG_TEXT), method: 8 }], 4);
    const meta = mustUnzipMeta(original);
    const out = smartZip(withMeta(meta));
    const after = mustUnzipMeta(out);
    expect(after[0]!.method).toBe(8);
    expect(bytesEqual(after[0]!.raw, meta[0]!.raw)).toBe(true); // 载荷保真
    expect(bytesEqual(out, original)).toBe(false); // header 不复刻 extra（诚实边界，读面容忍）
    expect(new TextDecoder().decode(after[0]!.data)).toBe(BIG_TEXT);
  });
});

// ---------------------------------------------------------------------------
// §3 五 repack 面 e2e（deflate 夹具：体积回原量级 + 未改部件载荷逐字节等 + 读回）
// ---------------------------------------------------------------------------

describe("ω99-230 §3 — 五 repack 面 e2e（deflate 输入：透传收口膨胀债）", () => {
  it("append_xlsx：体积 < 原×1.5（stored 重装必爆 ≥3 倍）+ 读回追加行 + 未改部件载荷逐字节等", () => {
    // 存储档展开尺寸（膨胀债的基线证明：stored 重装会到这个量级）。
    const uncompressed = mustUnzipMeta(XLSX_DEFLATED).reduce((s, e) => s + e.data.length, 0);
    expect(uncompressed).toBeGreaterThan(XLSX_DEFLATED.byteLength * 3);
    const r = appendXlsx(XLSX_DEFLATED, [["新行甲", 1], ["新行乙", 2]]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bytes.byteLength).toBeLessThan(XLSX_DEFLATED.byteLength * 1.5);
    // 读回（Excel 兼容代理）：表头 + 40 老行 + 2 新行。
    const sheets = mustParseXlsx(r.bytes);
    expect(sheets.map((s) => s.name)).toEqual(["销售明细"]);
    const rows = sheets[0]!.rows;
    expect(rows.length).toBe(43);
    expect(rows[41]).toEqual(["新行甲", "1"]);
    expect(rows[42]).toEqual(["新行乙", "2"]);
    expect(rows[1]).toEqual(["机械键盘-标准版-001", "3"]); // 老行零漂移
    // 未改部件载荷逐字节等 + method 保真；改到的工作表保 method 8。
    const before = metaByName(XLSX_DEFLATED);
    const after = metaByName(r.bytes);
    for (const [name, m] of before) {
      const got = after.get(name);
      expect(got).toBeDefined();
      if (name === "xl/worksheets/sheet1.xml") {
        expect(got!.method).toBe(8); // 已改原 deflate → 重压不降档
        expect(bytesEqual(got!.raw, m.raw)).toBe(false);
      } else {
        expect(got!.method).toBe(m.method);
        expect(bytesEqual(got!.raw, m.raw)).toBe(true); // 直过
      }
    }
  });

  it("append_docx：同形（体积 < 原×1.5 + 读回追加块 + [Content_Types] 载荷直过等）", () => {
    const r = appendDocx(DOCX_DEFLATED, NEW_BLOCKS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bytes.byteLength).toBeLessThan(DOCX_DEFLATED.byteLength * 1.5);
    const doc = mustParseDocx(r.bytes);
    const texts = doc.blocks.filter((b) => b.kind === "paragraph").map((b) => b.text);
    expect(texts.some((t) => t.includes("补充小节"))).toBe(true);
    expect(texts.some((t) => t.includes("追加段"))).toBe(true);
    expect(texts.some((t) => t.includes("正文第 1 段"))).toBe(true); // 老段零漂移
    expect(r.totalBlocks).toBe(31 + NEW_BLOCKS.length);
    const before = metaByName(DOCX_DEFLATED);
    const after = metaByName(r.bytes);
    expect(after.get("word/document.xml")!.method).toBe(8);
    expect(bytesEqual(after.get("[Content_Types].xml")!.raw, before.get("[Content_Types].xml")!.raw)).toBe(true);
    expect(after.get("[Content_Types].xml")!.method).toBe(8);
  });

  it("append_pptx（appendPptxSlides→smartZip 组合）：体积回量级 + 读回张序 + 未改部件载荷直过等", () => {
    const meta = mustUnzipMeta(PPTX_DEFLATED);
    const r = appendPptxSlides(withMeta(meta), NEW_SLIDES);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = smartZip(r.parts);
    expect(out.byteLength).toBeLessThan(PPTX_DEFLATED.byteLength * 1.5);
    const slides = mustParsePptx(out);
    expect(slides.map((s) => s.paragraphs[0] ?? "")).toEqual(["页一", "页二", "新页甲"]);
    // 未改部件（两页正文 + 各自 rels + 版式/母版族）载荷直过等；三缝补部件是重压。
    const before = metaByName(PPTX_DEFLATED);
    const after = metaByName(out);
    const spliced = new Set(["ppt/presentation.xml", "ppt/_rels/presentation.xml.rels", "[Content_Types].xml"]);
    for (const [name, m] of before) {
      const got = after.get(name);
      expect(got).toBeDefined();
      if (spliced.has(name)) {
        expect(got!.method).toBe(8);
        expect(bytesEqual(got!.raw, m.raw)).toBe(false);
      } else {
        expect(got!.method).toBe(m.method);
        expect(bytesEqual(got!.raw, m.raw)).toBe(true);
      }
    }
    // 新页部件（无原）→ 缺省 stored。
    expect(after.get("ppt/slides/slide3.xml")!.method).toBe(0);
  });

  it("replace_docx：体积 < 原×1.5 + find 零余 replace 在场 + 未改部件载荷直过等", () => {
    const r = replaceDocxText(DOCX_DEFLATED, "旧公司名", "新公司名", 50);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.replaced).toBe(31);
    expect(r.bytes.byteLength).toBeLessThan(DOCX_DEFLATED.byteLength * 1.5);
    const doc = mustParseDocx(r.bytes);
    const texts: string[] = [];
    for (const b of doc.blocks) {
      if (b.kind === "paragraph") texts.push(b.text);
      else for (const row of b.rows) texts.push(...row);
    }
    expect(texts.some((t) => t.includes("旧公司名"))).toBe(false);
    expect(texts.some((t) => t.includes("新公司名"))).toBe(true);
    const before = metaByName(DOCX_DEFLATED);
    const after = metaByName(r.bytes);
    expect(after.get("word/document.xml")!.method).toBe(8);
    expect(bytesEqual(after.get("[Content_Types].xml")!.raw, before.get("[Content_Types].xml")!.raw)).toBe(true);
  });

  it("replace_pptx：同形（体积回量级 + 读回替换 + 未改部件载荷直过等）", () => {
    const r = replacePptxText(PPTX_DEFLATED, "旧公司名", "新公司名", 50);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.replaced).toBe(1);
    expect(r.bytes.byteLength).toBeLessThan(PPTX_DEFLATED.byteLength * 1.5);
    const slides = mustParsePptx(r.bytes);
    const texts = slides.flatMap((s) => s.paragraphs);
    expect(texts.some((t) => t.includes("旧公司名"))).toBe(false);
    expect(texts.some((t) => t.includes("新公司名"))).toBe(true);
    const before = metaByName(PPTX_DEFLATED);
    const after = metaByName(r.bytes);
    for (const [name, m] of before) {
      const got = after.get(name);
      expect(got).toBeDefined();
      if (name === "ppt/slides/slide1.xml") {
        expect(got!.method).toBe(8); // 改到 → 重压保档
        expect(bytesEqual(got!.raw, m.raw)).toBe(false);
      } else {
        expect(got!.method).toBe(m.method);
        expect(bytesEqual(got!.raw, m.raw)).toBe(true); // 直过
      }
    }
  });

  it("既有 stored 夹具零漂移：make 面 stored 包过 append 面，出包与 storedZip 直装逐字节等（观察钉）", () => {
    const storedOriginal = buildDocx({ blocks: [{ kind: "body", text: "占位正文。" }] });
    const r = appendDocx(storedOriginal, NEW_BLOCKS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // stored 包：未改条目直过（raw=原字节）、改到条目 method 0 照旧 store——
    // 时戳常量同源，出包与 storedZip 直接回装应逐字节等（brief §三：不必
    // 断言、如实观察——本机两写器同构，等成立即证 stored 路径零漂移）。
    const un = unzipEntries(storedOriginal);
    expect(un.ok).toBe(true);
    if (!un.ok) return;
    const document = un.entries.find((e) => e.name === "word/document.xml");
    expect(document).toBeDefined();
    const newXml = appendDocxBlocks(new TextDecoder().decode(document!.data), NEW_BLOCKS);
    const legacy = storedZip(
      un.entries.map((e) => (e === document ? { name: e.name, data: enc.encode(newXml) } : e)),
    );
    expect(bytesEqual(r.bytes, legacy)).toBe(true);
    const doc = mustParseDocx(r.bytes);
    expect(doc.blocks.length).toBe(r.totalBlocks);
    const after = mustUnzipMeta(r.bytes);
    for (const e of un.entries) {
      if (e.name === "word/document.xml") continue;
      const got = after.find((a) => a.name === e.name);
      expect(got).toBeDefined();
      expect(bytesEqual(got!.data, e.data)).toBe(true);
      expect(bytesEqual(got!.raw, e.data)).toBe(true); // stored 直过形
    }
  });
});

// ---------------------------------------------------------------------------
// §4 工具面（tmpdir 只写不删）：append_xlsx / replace_docx 过真文件
// ---------------------------------------------------------------------------

describe("ω99-230 §4 — 工具面（deflate 文件过真写盘路径）", () => {
  it("append_xlsx：deflate 文件追加后盘上体积 < 原×1.5 + 读回行对 + 收据用户语", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-o230-a-"));
    const target = join(ws, "订单.xlsx");
    await writeFile(target, XLSX_DEFLATED);
    const r = await exec(createAppendXlsxTool(ws), { path: "订单.xlsx", rows: [["新行甲", 1]] });
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toContain("已追加");
    const after = new Uint8Array(await readFile(target));
    expect(after.byteLength).toBeLessThan(XLSX_DEFLATED.byteLength * 1.5);
    const rows = mustParseXlsx(after)[0]!.rows;
    expect(rows[rows.length - 1]).toEqual(["新行甲", "1"]);
  });

  it("replace_docx：deflate 文件替换后盘上体积 < 原×1.5 + 读回 find 零余", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-o230-b-"));
    const target = join(ws, "报告.docx");
    await writeFile(target, DOCX_DEFLATED);
    const r = await exec(createReplaceDocxTool(ws), { path: "报告.docx", find: "旧公司名", replace: "新公司名" });
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toContain("就地替换");
    const after = new Uint8Array(await readFile(target));
    expect(after.byteLength).toBeLessThan(DOCX_DEFLATED.byteLength * 1.5);
    const texts: string[] = [];
    for (const b of mustParseDocx(after).blocks) {
      if (b.kind === "paragraph") texts.push(b.text);
      else for (const row of b.rows) texts.push(...row);
    }
    expect(texts.some((t) => t.includes("旧公司名"))).toBe(false);
    expect(texts.some((t) => t.includes("新公司名"))).toBe(true);
  });
});
