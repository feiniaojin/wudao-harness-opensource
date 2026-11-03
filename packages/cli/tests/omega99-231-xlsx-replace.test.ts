// ω99-231: #R1 — replace_xlsx receipts（六层：parseSharedStrings / 格判型改写 /
// 整包 sharedStrings 零触碰 / scope 与帽子 / 工具面 / census）。RED-first。
// ★测试红线（09-09 用户令）：「注意，开发、测试过程禁止删除用户文件/文件
// 夹。」夹具全内存（手搓 xlsx 字节 + storedZip/deflateRawSync 造包）或
// os.tmpdir() 临时工作区**只写不删**；绝不删用户文件/文件夹；零 rm/unlink；
// 零子进程；零外网。读写互证：replace 完用 221 的 parseXlsxSheets 读回
// （自家读面验自家写面——收据的「已替换 N 处」互证层也从读回来，不数 XML）。
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import type { Tool } from "@wudao-org/core";
// 读面（读写互证）+ 追加面（scanXlsxSheetPart 同族邻居）。
import { parseXlsxSheets } from "../src/doc-xlsx-read.js";
import { buildXlsx } from "../src/doc-xlsx.js";
// zip 地基。
import { storedZip, unzipEntries, unzipEntriesWithMeta, crc32 } from "../src/doc-zip.js";
// 本弧改写面。
import {
  parseSharedStrings,
  countSheetOccurrences,
  replaceInSheetXml,
  replaceXlsxText,
  createReplaceXlsxTool,
  summarizeReplaceXlsx,
} from "../src/doc-xlsx-replace.js";
// 消费面。
import { summarizeToolCall } from "../src/log.js";
import { DEFAULT_ASK_TOOLS, FILE_EDIT_TOOLS, FILENAME_KEY_TOOLS, decidePermission } from "../src/permission.js";
import { extractFileReceipt } from "../src/driver/file-receipt.js";
import { buildToolSet } from "../src/tools.js";

const enc = new TextEncoder();
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

/** unzip 的窄化帮手（夹具层：失败即夹具坏，抛出终止）。 */
function mustUnzip(bytes: Uint8Array): Part[] {
  const un = unzipEntries(bytes);
  if (!un.ok) throw new Error(`fixture unzip failed: ${un.error}`);
  return [...un.entries];
}

function partOf(parts: readonly Part[], name: string): Uint8Array {
  const hit = parts.find((e) => e.name === name);
  if (hit === undefined) throw new Error(`fixture part missing: ${name}`);
  return hit.data;
}

/** parseXlsxSheets 的窄化帮手（读写互证断言前的夹具层）。 */
function mustParse(bytes: Uint8Array) {
  const parsed = parseXlsxSheets(bytes);
  if (!parsed.ok) throw new Error(`fixture parse failed: ${parsed.error}`);
  return parsed.sheets;
}

/** 一张表的全部格文本（互证层断言的粒度：扁平串清单）。 */
function sheetTexts(sheets: readonly { rows: readonly (readonly (string | null)[])[] }[], name: string): string[] {
  const sheet = sheets.find((s) => (s as { name: string }).name === name);
  if (sheet === undefined) throw new Error(`fixture sheet missing: ${name}`);
  const out: string[] = [];
  for (const row of sheet.rows) for (const cell of row) if (cell !== null) out.push(cell);
  return out;
}

const XML_DECL = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;
const MAIN_NS = `xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"`;
const R_NS = `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
const REL_TYPE = `http://schemas.openxmlformats.org/officeDocument/2006/relationships`;

/** 手搓工作簿：workbook.xml + rels + sharedStrings（可选）+ N 张表 + styles
 *  （styles 是「非目标部件字节保真」断言的对照件）。 */
function xlsxZip(sheets: readonly { name: string; body: string }[], siBodies: readonly string[] = []): Uint8Array {
  const parts: Part[] = [
    {
      name: "xl/workbook.xml",
      data: enc.encode(
        `${XML_DECL}<workbook ${MAIN_NS} ${R_NS}><sheets>` +
          sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
          `</sheets></workbook>`,
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: enc.encode(
        `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL_TYPE}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
          (siBodies.length > 0 ? `<Relationship Id="rId${sheets.length + 1}" Type="${REL_TYPE}/sharedStrings" Target="sharedStrings.xml"/>` : "") +
          `</Relationships>`,
      ),
    },
  ];
  if (siBodies.length > 0) {
    parts.push({
      name: "xl/sharedStrings.xml",
      data: enc.encode(`${XML_DECL}<sst ${MAIN_NS} count="1" uniqueCount="${siBodies.length}">${siBodies.map((b) => `<si>${b}</si>`).join("")}</sst>`),
    });
  }
  parts.push({ name: "xl/styles.xml", data: enc.encode(`${XML_DECL}<styleSheet ${MAIN_NS}><fonts count="1"/></styleSheet>`) });
  sheets.forEach((s, i) => {
    parts.push({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: enc.encode(`${XML_DECL}<worksheet ${MAIN_NS}><sheetData>${s.body}</sheetData></worksheet>`),
    });
  });
  return storedZip(parts);
}

/** 富夹具的共享串表（五项：plain 命中 / runs 跨界 / plain 无关 / runs 单 run
 *  命中 / plain 实体）。 */
const RICH_SI = [
  `<t>旧公司</t>`,
  `<r><rPr><b/></rPr><t>旧</t></r><r><t>公司</t></r>`,
  `<t>无关文本</t>`,
  `<r><rPr><b/></rPr><t>前缀旧公司</t></r><r><t>尾</t></r>`,
  `<t>旧&amp;公司</t>`,
];

/** Sheet1 富格全景：A1/A2 共享 plain 命中（两格共一 index——去重表镜像）、
 *  B2 共享 runs 跨界、C3 inlineStr 单 t 命中、D4 inlineStr runs 单 run 命中、
 *  E5 inlineStr runs 跨界、F6 布尔、G7 公式、H8 t="str" 命中、J10 共享无关。 */
const RICH_SHEET1_BODY = [
  `<row r="1"><c r="A1" s="12" t="s"><v>0</v></c></row>`,
  `<row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" t="s"><v>1</v></c></row>`,
  `<row r="3"><c r="C3" t="inlineStr"><is><t>旧公司 inline</t></is></c></row>`,
  `<row r="4"><c r="D4" t="inlineStr"><is><r><rPr><i/></rPr><t>前缀旧公司</t></r><r><t>尾</t></r></is></c></row>`,
  `<row r="5"><c r="E5" t="inlineStr"><is><r><t>旧</t></r><r><t>公司后</t></r></is></c></row>`,
  `<row r="6"><c r="F6" t="b"><v>1</v></c></row>`,
  `<row r="7"><c r="G7"><f>SUM(1,2)</f><v>3</v></c></row>`,
  `<row r="8"><c r="H8" t="str"><v>旧公司 str</v></c></row>`,
  `<row r="10"><c r="J10" t="s"><v>2</v></c></row>`,
].join("");

const richXlsx = (): Uint8Array => xlsxZip([{ name: "Sheet1", body: RICH_SHEET1_BODY }], RICH_SI);

/** 纯命中夹具（无跨界富文本）：A1/A2 共享 + C3 inline + H8 str + Sheet2 一处。 */
const HITS_SI = [`<t>旧公司</t>`, `<t>别的内容</t>`];
const hitsXlsx = (): Uint8Array =>
  xlsxZip(
    [
      {
        name: "Sheet1",
        body: [
          `<row r="1"><c r="A1" s="7" t="s"><v>0</v></c></row>`,
          `<row r="2"><c r="A2" t="s"><v>0</v></c></row>`,
          `<row r="3"><c r="C3" t="inlineStr"><is><t>旧公司 inline</t></is></c></row>`,
          `<row r="4"><c r="D4" t="s"><v>1</v></c></row>`,
        ].join(""),
      },
      { name: "Sheet2", body: `<row r="1"><c r="B2" t="s"><v>0</v></c></row>` },
    ],
    HITS_SI,
  );

/** 纯跨界夹具（零可替换命中）：B2 共享 runs 跨界 + E5 inline runs 跨界。 */
const spansOnlyXlsx = (): Uint8Array =>
  xlsxZip(
    [
      {
        name: "Sheet1",
        body: [
          `<row r="2"><c r="B2" t="s"><v>1</v></c></row>`,
          `<row r="5"><c r="E5" t="inlineStr"><is><r><t>旧</t></r><r><t>公司后</t></r></is></c></row>`,
        ].join(""),
      },
    ],
    RICH_SI,
  );

/** 手搓 deflate zip（230 R1 zipWithMethods 同款简化：全 method 8）——压缩透
 *  传断言的夹具。 */
function deflatedZip(parts: readonly Part[]): Uint8Array {
  const packed = parts.map((e) => ({ name: e.name, raw: e.data, data: deflateRawSync(e.data) }));
  const names = packed.map((e) => enc.encode(e.name));
  const localLen = packed.reduce((s, e, i) => s + 30 + names[i]!.length + e.data.length, 0);
  const centralLen = names.reduce((s, n) => s + 46 + n.length, 0);
  const out = new Uint8Array(localLen + centralLen + 22);
  const dv = new DataView(out.buffer);
  let o = 0;
  const offsets: number[] = [];
  packed.forEach((e, i) => {
    const nb = names[i]!;
    offsets.push(o);
    dv.setUint32(o, 0x04034b50, true);
    dv.setUint16(o + 4, 20, true);
    dv.setUint16(o + 6, 0x0800, true);
    dv.setUint16(o + 8, 8, true);
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
    const nb = names[i]!;
    dv.setUint32(o, 0x02014b50, true);
    dv.setUint16(o + 4, 20, true);
    dv.setUint16(o + 6, 20, true);
    dv.setUint16(o + 8, 0x0800, true);
    dv.setUint16(o + 10, 8, true);
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

// ---------------------------------------------------------------------------
// §1 纯层 — parseSharedStrings（单 <t> 形 / 富文本 <r><t> 形）
// ---------------------------------------------------------------------------

describe("ω99-231 §1 parseSharedStrings", () => {
  it("两形：单 <t> 取文本；富文本 runs 清单（拼接纪律同读面）；rPh 剥", () => {
    const items = parseSharedStrings(
      `${XML_DECL}<sst ${MAIN_NS}>` +
        `<si><t>旧公司</t></si>` +
        `<si><r><rPr><b/></rPr><t>旧</t></r><r><t>公司</t></r></si>` +
        `<si><t xml:space="preserve"> 带空格 </t></si>` +
        `<si><rPh sb="0" eb="1"><t>jiu</t></rPh><t>音注剥掉</t></si>` +
        `<si/></sst>`,
    );
    expect(items).toHaveLength(5);
    expect(items[0]).toMatchObject({ text: "旧公司", runs: null });
    expect(items[1]).toMatchObject({ text: "旧公司" });
    expect(items[1]!.runs).toEqual([
      { rPr: `<rPr><b/></rPr>`, text: "旧" },
      { rPr: null, text: "公司" },
    ]);
    expect(items[2]).toMatchObject({ text: " 带空格 ", runs: null });
    expect(items[3]).toMatchObject({ text: "音注剥掉" });
    expect(items[4]).toMatchObject({ text: "", runs: null });
  });

  it("实体解码：&amp; &lt; &gt; &quot; 数字实体（单趟不双解）", () => {
    const items = parseSharedStrings(
      `<sst>${`<si><t>a &amp; b &lt;c&gt; &#65;</t></si>`}</sst>`,
    );
    expect(items[0]!.text).toBe("a & b <c> A");
  });
});

// ---------------------------------------------------------------------------
// §2 纯层 — countSheetOccurrences + replaceInSheetXml（格判型与改写）
// ---------------------------------------------------------------------------

describe("ω99-231 §2 格判型与改写", () => {
  const shared = parseSharedStrings(`${XML_DECL}<sst ${MAIN_NS}>${RICH_SI.map((b) => `<si>${b}</si>`).join("")}</sst>`);

  it("计数：值内多次命中 split 计数；跨界富格计 0；布尔/公式不参与", () => {
    const multi = xlsxZip([{ name: "S", body: `<row r="1"><c r="A1" t="s"><v>0</v></c></row>` }], [`<t>旧公司 旧公司</t>`]);
    const multiShared = parseSharedStrings(new TextDecoder().decode(partOf(mustUnzip(multi), "xl/sharedStrings.xml")));
    const sheet = `${XML_DECL}<worksheet ${MAIN_NS}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="B2" t="s"><v>1</v></c><c r="F6" t="b"><v>1</v></c><c r="G7"><f>SUM(1)</f><v>旧公司</v></c></row></sheetData></worksheet>`;
    expect(countSheetOccurrences(sheet, multiShared, "旧公司")).toBe(2);
    // RICH_SI 语境：B2 富跨界计 0。
    const richSheet = `${XML_DECL}<worksheet ${MAIN_NS}><sheetData><row r="2"><c r="B2" t="s"><v>1</v></c></row></sheetData></worksheet>`;
    expect(countSheetOccurrences(richSheet, shared, "旧公司")).toBe(0);
  });

  it("共享 plain 重指 inlineStr：r/s 及其余属性原样保留、t=s→inlineStr 形变", () => {
    const sheet = `${XML_DECL}<worksheet ${MAIN_NS}><sheetData><row r="1"><c r="A1" s="12" t="s"><v>0</v></c></row></sheetData></worksheet>`;
    const r = replaceInSheetXml(sheet, shared, "旧公司", "新公司", 50);
    expect(r.overLimit).toBe(false);
    if (!r.overLimit) {
      expect(r.replaced).toBe(1);
      expect(r.newXml).toContain(`<c r="A1" s="12" t="inlineStr"><is><t xml:space="preserve">新公司</t></is></c>`);
      expect(r.newXml).not.toContain(`t="s"`);
    }
  });

  it("t=str 重指 inlineStr；inlineStr 单 t 原位换（开标签最小动）", () => {
    const sheet = `${XML_DECL}<worksheet ${MAIN_NS}><sheetData>` +
      `<row r="8"><c r="H8" t="str"><v>旧公司 str</v></c></row>` +
      `<row r="3"><c r="C3" t="inlineStr"><is><t>旧公司 inline</t></is></c></row>` +
      `</sheetData></worksheet>`;
    const r = replaceInSheetXml(sheet, shared, "旧公司", "新公司", 50);
    if (!r.overLimit) {
      expect(r.replaced).toBe(2);
      expect(r.newXml).toContain(`<c r="H8" t="inlineStr"><is><t xml:space="preserve">新公司 str</t></is></c>`);
      // 原位换：t 开标签原样（无属性），内文换新。
      expect(r.newXml).toContain(`<is><t>新公司 inline</t></is>`);
    } else {
      throw new Error("unexpected overLimit");
    }
  });

  it("富文本单 run 命中：重指 inlineStr 保 run 结构（rPr 原样、该 run 文本替换）", () => {
    const sheet = `${XML_DECL}<worksheet ${MAIN_NS}><sheetData><row r="4"><c r="D4" t="s"><v>3</v></c></row></sheetData></worksheet>`;
    const r = replaceInSheetXml(sheet, shared, "旧公司", "新公司", 50);
    if (!r.overLimit) {
      expect(r.replaced).toBe(1);
      expect(r.newXml).toContain(
        `<c r="D4" t="inlineStr"><is><r><rPr><b/></rPr><t xml:space="preserve">前缀新公司</t></r><r><t xml:space="preserve">尾</t></r></is></c>`,
      );
    } else {
      throw new Error("unexpected overLimit");
    }
  });

  it("跨界富格拒改：格位收集（共享与 inline 两形）、原格字节零动", () => {
    const sheet = `${XML_DECL}<worksheet ${MAIN_NS}><sheetData>` +
      `<row r="2"><c r="B2" t="s"><v>1</v></c></row>` +
      `<row r="5"><c r="E5" t="inlineStr"><is><r><t>旧</t></r><r><t>公司后</t></r></is></c></row>` +
      `</sheetData></worksheet>`;
    const r = replaceInSheetXml(sheet, shared, "旧公司", "新公司", 50);
    if (!r.overLimit) {
      expect(r.replaced).toBe(0);
      expect(r.spansCells).toEqual(["B2", "E5"]);
      expect(r.newXml).toContain(`<c r="B2" t="s"><v>1</v></c>`);
      expect(r.newXml).toContain(`<r><t>旧</t></r><r><t>公司后</t></r>`);
    } else {
      throw new Error("unexpected overLimit");
    }
  });

  it("数字闸：有效数字原位换 <v>；非有限/空串拒并收集格位", () => {
    const sheet = `${XML_DECL}<worksheet ${MAIN_NS}><sheetData>` +
      `<row r="1"><c r="A1"><v>12345</v></c><c r="B2"><v>23</v></c><c r="C3" t="n"><v>230</v></c></row>` +
      `</sheetData></worksheet>`;
    const ok = replaceInSheetXml(sheet, [], "23", "9", 50);
    if (!ok.overLimit) {
      expect(ok.replaced).toBe(3);
      expect(ok.newXml).toContain(`<c r="A1"><v>1945</v></c>`);
      expect(ok.newXml).toContain(`<c r="B2"><v>9</v></c>`);
      expect(ok.newXml).toContain(`<c r="C3" t="n"><v>90</v></c>`);
      expect(ok.numericSkipped).toEqual([]);
    } else {
      throw new Error("unexpected overLimit");
    }
    const gated = replaceInSheetXml(sheet, [], "23", "九", 50);
    if (!gated.overLimit) {
      expect(gated.replaced).toBe(0);
      expect(gated.numericSkipped).toEqual(["A1", "B2", "C3"]);
      expect(gated.newXml).toContain(`<c r="A1"><v>12345</v></c>`);
    } else {
      throw new Error("unexpected overLimit");
    }
    const emptied = replaceInSheetXml(sheet, [], "230", "", 50);
    if (!emptied.overLimit) {
      // "230"→"" 空串拒；"12345"/"23" 不含 find 不动。
      expect(emptied.replaced).toBe(0);
      expect(emptied.numericSkipped).toEqual(["C3"]);
    } else {
      throw new Error("unexpected overLimit");
    }
  });

  it("布尔/公式格不参与：字节零动", () => {
    const sheet = `${XML_DECL}<worksheet ${MAIN_NS}><sheetData>` +
      `<row r="6"><c r="F6" t="b"><v>1</v></c></row>` +
      `<row r="7"><c r="G7"><f>SUM(1,2)</f><v>3</v></c></row>` +
      `</sheetData></worksheet>`;
    const r = replaceInSheetXml(sheet, [], "1", "9", 50);
    if (!r.overLimit) {
      expect(r.replaced).toBe(0);
      expect(r.newXml).toBe(sheet);
    } else {
      throw new Error("unexpected overLimit");
    }
  });

  it("实体往返：find/replace 含 & < > 仍准（比较前 unescape、写回前 escape）", () => {
    const entShared = parseSharedStrings(`<sst><si>${RICH_SI[4]}</si></sst>`);
    const sheet = `${XML_DECL}<worksheet ${MAIN_NS}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`;
    const r = replaceInSheetXml(sheet, entShared, "旧&公司", `新<公司>`, 50);
    if (!r.overLimit) {
      expect(r.replaced).toBe(1);
      expect(r.newXml).toContain(`<t xml:space="preserve">新&lt;公司&gt;</t>`);
    } else {
      throw new Error("unexpected overLimit");
    }
  });

  it("maxCount 边界：恰=过；超=拒不动+总数", () => {
    const sheet = `${XML_DECL}<worksheet ${MAIN_NS}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`;
    const at = replaceInSheetXml(sheet, shared, "旧公司", "新公司", 1);
    expect(at.overLimit).toBe(false);
    const over = replaceInSheetXml(sheet, shared, "旧公司", "新公司", 0);
    expect(over).toEqual({ overLimit: true, total: 1 });
  });
});

// ---------------------------------------------------------------------------
// §3 整包 — replaceXlsxText（sharedStrings 零触碰 / 互证 / 确定性 / 透传 / scope）
// ---------------------------------------------------------------------------

describe("ω99-231 §3 replaceXlsxText 整包", () => {
  it("★核心主张：sharedStrings.xml 部件 bytesEqual 原包；非目标部件（workbook/rels/styles）bytesEqual", () => {
    const original = richXlsx();
    const r = replaceXlsxText(original, "旧公司", "新公司");
    if (!r.ok) throw new Error(`unexpected refusal: ${JSON.stringify(r)}`);
    const before = mustUnzip(original);
    const after = mustUnzip(r.bytes);
    expect(bytesEqual(partOf(after, "xl/sharedStrings.xml"), partOf(before, "xl/sharedStrings.xml"))).toBe(true);
    expect(bytesEqual(partOf(after, "xl/workbook.xml"), partOf(before, "xl/workbook.xml"))).toBe(true);
    expect(bytesEqual(partOf(after, "xl/_rels/workbook.xml.rels"), partOf(before, "xl/_rels/workbook.xml.rels"))).toBe(true);
    expect(bytesEqual(partOf(after, "xl/styles.xml"), partOf(before, "xl/styles.xml"))).toBe(true);
  });

  it("闭环互测：改写格读回（共享重指后 find 零余、replace 在场、其余格零漂移）+ 混合形 spansRemaining", () => {
    const r = replaceXlsxText(richXlsx(), "旧公司", "新公司");
    if (!r.ok) throw new Error("unexpected refusal");
    // 命中=A1/A2（共享 plain）+C3（inline 单 t）+D4（inline 富单 run）+H8（str）=5；
    // 跨界=B2（共享富）+E5（inline 富）→ spansRemaining=2。
    expect(r.replaced).toBe(5);
    expect(r.spansRemaining).toBe(2);
    expect(r.sheetsTouched).toBe(1);
    const sheets = mustParse(r.bytes);
    const texts = sheetTexts(sheets, "Sheet1");
    // 跨界格（B2/E5）读回拼接仍含 find 是 by-design 残余——互证层的零余断言
    // 按精确清单核（spans 残余跳过零余，229 四跳条件同族）。
    const flat = texts.filter((t) => t.includes("旧公司"));
    expect(flat).toEqual(["旧公司", "旧公司后"]); // B2 拼接「旧公司」与 E5 拼接「旧公司后」
    expect(texts).toContain("新公司");
    expect(texts).toContain("新公司 inline");
    expect(texts).toContain("前缀新公司尾"); // D4 inline 富单 run 命中：该 run 换新、未命中 run「尾」零漂移
    expect(texts).toContain("新公司 str");
    expect(texts).toContain("无关文本"); // 共享无关项零漂移
    expect(texts).toContain("TRUE"); // 布尔格读回
    expect(texts).toContain("3"); // 公式缓存值零漂移
  });

  it("确定性：同输入两次全等", () => {
    const a = replaceXlsxText(richXlsx(), "旧公司", "新公司");
    const b = replaceXlsxText(richXlsx(), "旧公司", "新公司");
    if (a.ok && b.ok) expect(bytesEqual(a.bytes, b.bytes)).toBe(true);
    else throw new Error("unexpected refusal");
  });

  it("smartZip 透传：deflate 夹具出包体积 < 原×1.5；sharedStrings 部件字节等", () => {
    const original = deflatedZip(mustUnzip(richXlsx()).map((e) => ({ name: e.name, data: e.data })));
    const r = replaceXlsxText(original, "旧公司", "新公司");
    if (!r.ok) throw new Error("unexpected refusal");
    expect(r.bytes.byteLength).toBeLessThan(original.byteLength * 1.5);
    expect(bytesEqual(partOf(mustUnzip(r.bytes), "xl/sharedStrings.xml"), partOf(mustUnzip(original), "xl/sharedStrings.xml"))).toBe(true);
    // 未改条目原压缩载荷直过（透传直证）。
    const before = unzipEntriesWithMeta(original);
    const after = unzipEntriesWithMeta(r.bytes);
    if (before.ok && after.ok) {
      const ssB = before.entries.find((e) => e.name === "xl/sharedStrings.xml")!;
      const ssA = after.entries.find((e) => e.name === "xl/sharedStrings.xml")!;
      expect(bytesEqual(ssA.raw, ssB.raw)).toBe(true);
    } else {
      throw new Error("fixture unzip failed");
    }
  });

  it("scope：缺省全表；表名/序收窄；scope 外表部件 bytesEqual 原包（find 保留=by design 钉）", () => {
    const original = hitsXlsx();
    const all = replaceXlsxText(original, "旧公司", "新公司");
    if (!all.ok) throw new Error("unexpected refusal");
    expect(all.replaced).toBe(4);
    expect(all.sheetsTouched).toBe(2);
    expect(sheetTexts(mustParse(all.bytes), "Sheet2")).toContain("新公司");

    const byName = replaceXlsxText(original, "旧公司", "新公司", "Sheet2");
    if (!byName.ok) throw new Error("unexpected refusal");
    expect(byName.replaced).toBe(1);
    expect(byName.sheetsTouched).toBe(1);
    const after = mustUnzip(byName.bytes);
    expect(bytesEqual(partOf(after, "xl/worksheets/sheet1.xml"), partOf(mustUnzip(original), "xl/worksheets/sheet1.xml"))).toBe(true);
    expect(sheetTexts(mustParse(byName.bytes), "Sheet1")).toContain("旧公司"); // scope 外保留=by design
    expect(sheetTexts(mustParse(byName.bytes), "Sheet2")).toContain("新公司");

    const byIndex = replaceXlsxText(original, "旧公司", "新公司", 2);
    if (!byIndex.ok) throw new Error("unexpected refusal");
    expect(byIndex.replaced).toBe(1);
  });

  it("sheet 不存在 typed 拒（228 同文案）：表名与序两形", () => {
    const missName = replaceXlsxText(hitsXlsx(), "旧公司", "新公司", "不存在");
    expect(missName).toEqual({ ok: false, error: `没有名为「不存在」的工作表——这个文件里的工作表：Sheet1、Sheet2` });
    const missIndex = replaceXlsxText(hitsXlsx(), "旧公司", "新公司", 99);
    expect(missIndex).toEqual({ ok: false, error: `第 99 张工作表不存在——这个文件共 2 张工作表：Sheet1、Sheet2` });
  });

  it("over_limit：全局帽不分表，拒不动+总数", () => {
    const r = replaceXlsxText(hitsXlsx(), "旧公司", "新公司", undefined, 3);
    expect(r).toEqual({ ok: false, reason: "over_limit", total: 4, limit: 3 });
  });

  it("not_found：零命中零跨界的干净拒", () => {
    const r = replaceXlsxText(hitsXlsx(), "不存在词", "新");
    expect(r).toEqual({ ok: false, reason: "not_found" });
  });

  it("spans_runs：零可替换命中+跨界 → typed 拒带格位（sheet+ref）", () => {
    const r = replaceXlsxText(spansOnlyXlsx(), "旧公司", "新公司");
    if (r.ok) throw new Error("unexpected success");
    if (r.reason === "spans_runs") {
      expect(r.cells).toEqual([
        { sheet: "Sheet1", ref: "B2" },
        { sheet: "Sheet1", ref: "E5" },
      ]);
    } else {
      throw new Error(`unexpected reason: ${JSON.stringify(r)}`);
    }
  });

  it("数字闸残余：ok 带 skippedNumeric 格位、数字格字节零动（混合形）", () => {
    const fixture = xlsxZip(
      [
        {
          name: "S",
          body: `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B7"><v>23</v></c></row>`,
        },
      ],
      [`<t>旧公司</t>`],
    );
    const r = replaceXlsxText(fixture, "旧公司", "新公司");
    // 先只换串格：数字格不含 find —— 换一个 find 让数字格也命中。
    const r2 = replaceXlsxText(
      xlsxZip([{ name: "S", body: `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B7"><v>23旧</v></c></row>` }], [`<t>旧</t>`]),
      "旧",
      "新",
    );
    if (!r2.ok) throw new Error("unexpected refusal");
    expect(r2.replaced).toBe(1);
    expect(r2.skippedNumeric).toEqual([{ sheet: "S", ref: "B7" }]);
    expect(new TextDecoder().decode(partOf(mustUnzip(r2.bytes), "xl/worksheets/sheet1.xml"))).toContain(`<c r="B7"><v>23旧</v></c>`);
    expect(r.ok && r.skippedNumeric).toEqual([]);
  });

  it("make_xlsx 闭环：自家造的表（全 inlineStr）改后读回一致", () => {
    const made = buildXlsx({
      columns: [{ header: "客户" }, { header: "金额" }],
      rows: [["旧公司", 100], ["新客户", 200], ["旧公司二期", 300]],
    });
    const r = replaceXlsxText(made, "旧公司", "新公司");
    if (!r.ok) throw new Error("unexpected refusal");
    expect(r.replaced).toBe(2);
    const texts = sheetTexts(mustParse(r.bytes), "Sheet1");
    expect(texts.filter((t) => t.includes("旧公司"))).toEqual([]);
    expect(texts).toContain("新公司");
    expect(texts).toContain("新公司二期");
    expect(texts).toContain("100"); // 数字格零漂移
  });
});

// ---------------------------------------------------------------------------
// §4 工具面 — 门序 / 收据 / 拒语（tmpdir 工作区只写不删）
// ---------------------------------------------------------------------------

describe("ω99-231 §4 工具面", () => {
  it("typed 拒先于盘副作用：find 空 / find===replace / maxCount 非法 / sheet 非法", async () => {
    const tool = createReplaceXlsxTool("/tmp/ws");
    expect((await exec(tool, { path: "a.xlsx", find: "", replace: "x" })).content).toBe(
      `replace_xlsx: "find" must be a non-empty string of text to search for`,
    );
    expect((await exec(tool, { path: "a.xlsx", find: "旧", replace: "旧" })).content).toBe(
      `replace_xlsx: "replace" 与 "find" 相同——没有要做的改动`,
    );
    expect((await exec(tool, { path: "a.xlsx", find: "旧", replace: "新", maxCount: 0 })).content).toBe(
      `replace_xlsx: "maxCount" must be a positive integer`,
    );
    expect((await exec(tool, { path: "a.xlsx", find: "旧", replace: "新", sheet: true })).content).toBe(
      `replace_xlsx: "sheet" must be a worksheet name or a 1-based sheet number`,
    );
    expect((await exec(tool, { path: "  ", find: "旧", replace: "新" })).content).toBe(
      `replace_xlsx: "path" must be a non-empty path relative to the workspace`,
    );
  });

  it("外逃路径拒 / ENOENT 用户语 / OLE 出路 / 非 PK 拒", async () => {
    const ws = await mkdtemp(join(tmpdir(), "o231-gates-"));
    const tool = createReplaceXlsxTool(ws);
    expect((await exec(tool, { path: "../outside.xlsx", find: "旧", replace: "新" })).content).toContain("workspace");
    expect((await exec(tool, { path: "no.xlsx", find: "旧", replace: "新" })).content).toBe(`replace_xlsx: 文件不存在：no.xlsx`);
    await writeFile(join(ws, "ole.xls"), Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]));
    expect((await exec(tool, { path: "ole.xls", find: "旧", replace: "新" })).content).toBe(
      `replace_xlsx: ole.xls 是旧版 .xls 格式，改不了——请先用 Excel 打开并「另存为」.xlsx 格式后再试`,
    );
    await writeFile(join(ws, "plain.txt"), enc.encode("hello world"));
    expect((await exec(tool, { path: "plain.txt", find: "旧", replace: "新" })).content).toBe(
      `replace_xlsx: plain.txt 不是 Excel（.xlsx）文件——如果它是旧版 .xls 或其他格式，请先在 Excel 里另存为 .xlsx 再试`,
    );
  });

  it("成功收据单表形：中文一句 + JSON 末行；sharedStrings 零触碰（盘上直证）", async () => {
    const ws = await mkdtemp(join(tmpdir(), "o231-ok-"));
    const single = xlsxZip(
      [
        {
          name: "Sheet1",
          body: [
            `<row r="1"><c r="A1" s="7" t="s"><v>0</v></c></row>`,
            `<row r="2"><c r="A2" t="s"><v>0</v></c></row>`,
            `<row r="3"><c r="C3" t="inlineStr"><is><t>旧公司 inline</t></is></c></row>`,
          ].join(""),
        },
      ],
      HITS_SI,
    );
    const before = partOf(mustUnzip(single), "xl/sharedStrings.xml");
    await writeFile(join(ws, "订单.xlsx"), single);
    const tool = createReplaceXlsxTool(ws);
    const out = await exec(tool, { path: "订单.xlsx", find: "旧公司", replace: "新公司" });
    expect(out.isError).toBeUndefined();
    const written = await readFile(join(ws, "订单.xlsx"));
    expect(bytesEqual(partOf(mustUnzip(new Uint8Array(written)), "xl/sharedStrings.xml"), before)).toBe(true);
    const kb = (written.byteLength / 1024).toFixed(1);
    const lines = out.content.split("\n");
    expect(lines[0]).toBe(`已在 订单.xlsx 就地替换 3 处「旧公司」→「新公司」（${kb} KB）`);
    const json = JSON.parse(lines[1]!);
    expect(json).toMatchObject({ relativePath: "订单.xlsx", replaced: 3, sheetsTouched: 1, skippedNumeric: [], bytes: written.byteLength });
  });

  it("成功收据跨表形：（跨 2 张表，K KB）", async () => {
    const ws = await mkdtemp(join(tmpdir(), "o231-cross-"));
    await writeFile(join(ws, "订单.xlsx"), hitsXlsx());
    const tool = createReplaceXlsxTool(ws);
    const out = await exec(tool, { path: "订单.xlsx", find: "旧公司", replace: "新公司" });
    const written = await readFile(join(ws, "订单.xlsx"));
    const kb = (written.byteLength / 1024).toFixed(1);
    expect(out.content.split("\n")[0]).toBe(`已在 订单.xlsx 就地替换 4 处「旧公司」→「新公司」（跨 2 张表，${kb} KB）`);
  });

  it("spans_runs 拒语：格位点名（Sheet!Ref）+ 出路；列表截前 5 格", async () => {
    const ws = await mkdtemp(join(tmpdir(), "o231-spans-"));
    await writeFile(join(ws, "富.xlsx"), spansOnlyXlsx());
    const tool = createReplaceXlsxTool(ws);
    const out = await exec(tool, { path: "富.xlsx", find: "旧公司", replace: "新公司" });
    expect(out.content).toBe(
      `replace_xlsx: 「旧公司」在 2 个格里被拆分在多个富文本段内，无法原位替换（保格式边界）——Sheet1!B2、Sheet1!E5。可 read_xlsx 定位后重建该格，或缩小 find`,
    );
    expect(out.isError).toBe(true);
  });

  it("数字闸警示子句 + spans 残余警示子句（混合形收据）", async () => {
    const ws = await mkdtemp(join(tmpdir(), "o231-warn-"));
    const mixSi = [`<t>旧公司</t>`, `<r><rPr><b/></rPr><t>旧公</t></r><r><t>司 x</t></r>`];
    const fixture = xlsxZip(
      [
        {
          name: "Sheet1",
          body: [
            `<row r="1"><c r="A1" t="s"><v>0</v></c></row>`,
            `<row r="7"><c r="B7"><v>旧公司23</v></c></row>`,
            `<row r="2"><c r="B2" t="s"><v>1</v></c></row>`,
          ].join(""),
        },
      ],
      mixSi,
    );
    await writeFile(join(ws, "混合.xlsx"), fixture);
    const tool = createReplaceXlsxTool(ws);
    const out = await exec(tool, { path: "混合.xlsx", find: "旧公司", replace: "新公司" });
    expect(out.isError).toBeUndefined();
    const written = await readFile(join(ws, "混合.xlsx"));
    const kb = (written.byteLength / 1024).toFixed(1);
    expect(out.content.split("\n")[0]).toBe(
      `已在 混合.xlsx 就地替换 1 处「旧公司」→「新公司」（另有 1 处被拆分在多个富文本段内，未替换）（另有 1 格数字改后不再是有效数字，未替换：B7）（${kb} KB）`,
    );
  });

  it("over_limit 拒语 / not_found 拒语", async () => {
    const ws = await mkdtemp(join(tmpdir(), "o231-limits-"));
    await writeFile(join(ws, "订单.xlsx"), hitsXlsx());
    const tool = createReplaceXlsxTool(ws);
    const over = await exec(tool, { path: "订单.xlsx", find: "旧公司", replace: "新公司", maxCount: 3 });
    expect(over.content).toBe(
      `replace_xlsx: 命中 4 处超过上限 3——请缩小 find、指定 sheet，或分批（增大 maxCount 至 200 内）`,
    );
    const none = await exec(tool, { path: "订单.xlsx", find: "不存在词", replace: "新" });
    expect(none.content).toBe(`replace_xlsx: 没有找到「不存在词」——这份表里没有出现这段文字（可先 read_xlsx 核对原文）`);
  });

  it("file-receipt：JSON 末行进门（extractFileReceipt 提取）", async () => {
    const ws = await mkdtemp(join(tmpdir(), "o231-receipt-"));
    await writeFile(join(ws, "订单.xlsx"), hitsXlsx());
    const tool = createReplaceXlsxTool(ws);
    const out = await exec(tool, { path: "订单.xlsx", find: "旧公司", replace: "新公司" });
    const receipt = extractFileReceipt("replace_xlsx", out.content);
    expect(receipt).toMatchObject({ name: "订单.xlsx" });
    expect(receipt!.bytes).toBeGreaterThan(0);
    expect(receipt!.path).toContain("订单.xlsx");
  });
});

// ---------------------------------------------------------------------------
// §5 summarize（220 语法：N 不可达不编造）
// ---------------------------------------------------------------------------

describe("ω99-231 §5 summarize", () => {
  it("两形：文件尾名+找换对；空串替换「」", () => {
    expect(summarizeToolCall("replace_xlsx", { path: "dir/订单.xlsx", find: "旧公司", replace: "新公司" })).toBe(
      "订单.xlsx 替换「旧公司」→「新公司」",
    );
    expect(summarizeToolCall("replace_xlsx", { path: "路演.xlsx", find: "旧", replace: "" })).toBe(
      "路演.xlsx 替换「旧」→「」",
    );
    expect(summarizeReplaceXlsx({ path: "订单.xlsx", find: "旧", replace: "新" })).toBe("订单.xlsx 替换「旧」→「新」");
    expect(summarizeReplaceXlsx({})).toBe("");
  });
});

// ---------------------------------------------------------------------------
// §6 census — 挂载位 / 权限位 / 姿态 / 描述
// ---------------------------------------------------------------------------

describe("ω99-231 §6 挂载·权限·summarize（census 邻域）", () => {
  const stubModel = { stream: async function* () { /* never invoked */ } } as unknown as never;
  const gate = async (): Promise<{ behavior: "allow" }> => ({ behavior: "allow" });

  it("挂载位钉（零配置）：replace_pptx+1=replace_xlsx、replace_xlsx+1=set_docx_header、set_pptx_notes 的下一位才是 task", () => {
    const names = buildToolSet({ workspaceRoot: "/tmp/ws", model: stubModel, canUseTool: gate, contextWindowTokens: 64_000 }).map((t) => t.name);
    expect(names).toContain("replace_xlsx");
    expect(names[names.indexOf("replace_pptx") + 1]).toBe("replace_xlsx");
    // ω99-238: #8 — 演进：set_docx_header / set_pptx_notes 插在 replace_xlsx
    // 之后、task 之前（文档部件面=页眉页脚+演讲备注，doc 名册尾 append-only
    // 尾）——replace_xlsx 的下一位改钉 set_docx_header，set_pptx_notes 的下
    // 一位才是 task。
    // ω99-256: #10 演进——clear_docx_header/set_docx_first_page 插在
    // set_pptx_notes 之后、task 之前（doc 部件面 v2=页眉删除+首页不同，
    // doc 名册尾 append-only 尾）：set_pptx_notes 的下一位改钉
    // clear_docx_header，set_docx_first_page 的下一位才是 task。
    // ω99-263: #11 演进——set_docx_even_pages 插在 set_docx_first_page 之后、
    // task 之前（doc 部件面 v3=奇偶页不同，doc 名册尾 append-only 尾）：
    // set_docx_first_page 的下一位改钉 set_docx_even_pages，set_docx_even_
    // pages 的下一位才是 task。
    expect(names[names.indexOf("replace_xlsx") + 1]).toBe("set_docx_header");
    expect(names[names.indexOf("set_docx_header") + 1]).toBe("set_pptx_notes");
    expect(names[names.indexOf("set_pptx_notes") + 1]).toBe("clear_docx_header");
    expect(names[names.indexOf("set_docx_first_page") + 1]).toBe("set_docx_even_pages");
    expect(names[names.indexOf("set_docx_even_pages") + 1]).toBe("task");
  });

  it("权限位：FILE_EDIT_TOOLS 收；FILENAME_KEY_TOOLS / DEFAULT_ASK_TOOLS 不进", () => {
    expect(FILE_EDIT_TOOLS.has("replace_xlsx")).toBe(true);
    expect(FILENAME_KEY_TOOLS.has("replace_xlsx")).toBe(false);
    expect(DEFAULT_ASK_TOOLS.has("replace_xlsx")).toBe(false);
    expect(decidePermission("workspace", "replace_xlsx")).toEqual({ behavior: "allow" });
    expect(decidePermission("auto", "replace_xlsx")).toEqual({ behavior: "allow" });
    expect(decidePermission("ask", "replace_xlsx")).toBe("ask");
    expect(decidePermission("plan", "replace_xlsx")).toEqual({ behavior: "deny", reason: expect.stringContaining("plan mode is read-only") });
  });

  it("姿态四布尔镜像 append_*/replace_* 写面：非只读 / 非并发安全 / 破坏性 / 非开放世界", () => {
    const t = createReplaceXlsxTool("/tmp/ws");
    expect(t.isReadOnly()).toBe(false);
    expect(t.isConcurrencySafe()).toBe(false);
    expect(t.isDestructive()).toBe(true);
    expect(t.isOpenWorld()).toBe(false);
  });

  it("描述=用户收益词汇：教「把…换成…」场景，零实现术语", () => {
    const t = createReplaceXlsxTool("/tmp/ws");
    for (const jargon of ["zip", "XML", "EOCD", "inflate", "unzipEntries", "buildTool", "inlineStr", "sharedStrings", "sheetData"]) {
      expect(t.description.toLowerCase()).not.toContain(jargon.toLowerCase());
    }
    expect(t.description).toContain("换成");
  });
});
