// ω99-221: #R1 — read_xlsx receipts（六层：解压纯层 / 工作簿解析 / 行解析 /
// 窗口 / 工具面 / summarize）。RED-first。
// ★测试红线：夹具全内存（storedZip / deflateRawSync 造字节）或 os.tmpdir()
// 临时工作区；绝不碰用户真实 Excel；零 rm（tmpdir 只写不删）；零真实键鼠/
// 截屏（本弧不涉）。零第三方依赖（node:zlib 内建）。
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import type { Tool } from "@wudao/core";
// 写面反哺：storedZip/crc32 造夹具（读写的同源互测是本弧的验收面之一）。
import { storedZip, crc32 } from "../src/doc-zip.js";
import { buildXlsx, DOC_MAX_COLUMNS } from "../src/doc-xlsx.js";
import {
  createReadXlsxTool,
  parseSheetRows,
  parseXlsxSheets,
  summarizeXlsxWindow,
  unzipEntries,
  XLSX_DEFAULT_ROW_LIMIT,
  XLSX_MAX_ROW_LIMIT,
  XLSX_MAX_COLUMNS,
} from "../src/doc-xlsx-read.js";
import { summarizeToolCall } from "../src/log.js";
import { buildToolSet } from "../src/tools.js";
import { DEFAULT_ASK_TOOLS, READ_TOOLS, WORKSPACE_TOOLS, decidePermission } from "../src/permission.js";

const enc = new TextEncoder();
const XDECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

// ---------------------------------------------------------------------------
// 夹具工坊（全内存）
// ---------------------------------------------------------------------------

type Part = { name: string; data: Uint8Array };

const part = (name: string, xml: string): Part => ({ name, data: enc.encode(xml) });

/** 手搓单条目 zip（method/flags 可控——加密/Zip64/压缩道夹具的底座）。 */
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

const UTF8_FLAG = 0x0800;

/** 多条目 method-8（deflate）zip——解压道的真夹具（storedZip 只写 method 0）。 */
function deflatedZip(entries: readonly Part[]): Uint8Array {
  const packed = entries.map((e) => ({ name: e.name, raw: e.data, data: deflateRawSync(e.data) }));
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
    dv.setUint16(o + 8, 8, true); // method 8 = deflate
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

/** worksheet XML（sheetData 原文注入——§3 直接控制每个 cell 形）。 */
const worksheetXml = (sheetData: string): string =>
  `${XDECL}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData></worksheet>`;

/** 工作簿夹具：workbook.xml（名序）+ rels（r:id→target）+ 各 sheet 部件。 */
function workbookZip(
  sheets: readonly { readonly name: string; readonly target: string; readonly sheetData: string }[],
  extra: readonly Part[] = [],
): Uint8Array {
  const parts: Part[] = [
    part(
      "xl/workbook.xml",
      `${XDECL}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
        sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
        `</sheets></workbook>`,
    ),
    part(
      "xl/_rels/workbook.xml.rels",
      `${XDECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${s.target}"/>`).join("") +
        `</Relationships>`,
    ),
    ...sheets.map((s) => part(`xl/${s.target.replace(/^\.\//, "")}`, worksheetXml(s.sheetData))),
    ...extra,
  ];
  return storedZip(parts);
}

// ---------------------------------------------------------------------------
// §1 解压纯层（stored + deflated 双道 / 加密拒 / Zip64 拒 / 坏 zip 拒）
// ---------------------------------------------------------------------------

describe("ω99-221 §1 — 解压纯层", () => {
  it("stored 道：storedZip 产物解出名与字节全等（读写同源互测）", () => {
    const bytes = storedZip([
      part("[Content_Types].xml", "<Types/>"),
      part("xl/workbook.xml", "<workbook 中文='是'/>"),
    ]);
    const r = unzipEntries(bytes);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.map((e) => e.name)).toEqual(["[Content_Types].xml", "xl/workbook.xml"]);
    expect(new TextDecoder().decode(r.entries[1]!.data)).toBe("<workbook 中文='是'/>");
  });

  it("deflated 道：method 8 条目 inflateRawSync 还原（多个条目、CRC/尺寸对）", () => {
    const payload = "销售明细，第 1 行：键盘\t12\tTRUE".repeat(20);
    const bytes = deflatedZip([part("xl/workbook.xml", "<wb/>"), part("xl/worksheets/sheet1.xml", payload)]);
    const r = unzipEntries(bytes);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(new TextDecoder().decode(r.entries[1]!.data)).toBe(payload);
  });

  it("加密旗（bit 0）诚实拒：文案教出路（另存无密码副本）", () => {
    const r = unzipEntries(singleEntryZip(enc.encode("<wb/>"), "xl/workbook.xml", 0, UTF8_FLAG | 0x0001));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("密码");
    expect(r.error).toContain("另存");
  });

  it("Zip64 标记拒：EOCD 条目数 0xFFFF 与中央目录偏移 0xFFFFFFFF 两形", () => {
    const a = singleEntryZip(enc.encode("<wb/>"), "xl/workbook.xml", 0, UTF8_FLAG);
    const dvA = new DataView(a.buffer);
    dvA.setUint16(a.length - 22 + 10, 0xffff, true); // EOCD entriesTotal 标记
    expect(unzipEntries(a).ok).toBe(false);
    const b = singleEntryZip(enc.encode("<wb/>"), "xl/workbook.xml", 0, UTF8_FLAG);
    const dvB = new DataView(b.buffer);
    const cdOff = b.length - 22 - (46 + "xl/workbook.xml".length);
    dvB.setUint32(cdOff + 42, 0xffffffff, true); // 中央目录 local offset 标记
    const rb = unzipEntries(b);
    expect(rb.ok).toBe(false);
    if (rb.ok) return;
    expect(rb.error).toContain("不支持");
  });

  it("坏 zip 拒：无 EOCD（随机字节）→ 用户语错误（无实现术语）", () => {
    const junk = enc.encode("这不是一个 zip 文件，只是一段文本。");
    const r = unzipEntries(junk);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("不是有效的 Excel");
    for (const jargon of ["zip", "EOCD", "XML", "central"]) {
      expect(r.error.toLowerCase()).not.toContain(jargon.toLowerCase());
    }
  });
});

// ---------------------------------------------------------------------------
// §2 工作簿解析（sheet 名序 / rels 映射 / 非顺序编号文件名）
// ---------------------------------------------------------------------------

describe("ω99-221 §2 — 工作簿解析", () => {
  it("buildXlsx 写面 roundtrip：sheet 名序、行列数、单元格值全对", () => {
    const bytes = buildXlsx([
      {
        sheetName: "销售明细",
        columns: [{ header: "名称" }, { header: "数量" }],
        rows: [["键盘", 12], ["鼠标", null]],
      },
      { sheetName: "汇总", columns: [{ header: "合计" }], rows: [[36]] },
    ]);
    const r = parseXlsxSheets(bytes);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sheets.map((s) => s.name)).toEqual(["销售明细", "汇总"]);
    expect(r.sheets[0]!.rowCount).toBe(3); // 表头 + 2 行
    expect(r.sheets[0]!.columnCount).toBe(2);
    expect(r.sheets[0]!.rows[0]).toEqual(["名称", "数量"]);
    expect(r.sheets[0]!.rows[1]).toEqual(["键盘", "12"]); // 数字原样字符串
    expect(r.sheets[0]!.rows[2]).toEqual(["鼠标", null]); // null cell = 空
    expect(r.sheets[1]!.rows[1]).toEqual(["36"]);
  });

  it("非顺序编号文件名：workbook 名序说了算，sheet99/sheet7 的编号与顺序无关", () => {
    const bytes = workbookZip([
      { name: "第一张", target: "worksheets/sheet99.xml", sheetData: `<row r="1"><c r="A1"><v>11</v></c></row>` },
      { name: "第二张", target: "worksheets/sheet7.xml", sheetData: `<row r="1"><c r="A1"><v>22</v></c></row>` },
    ]);
    const r = parseXlsxSheets(bytes);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sheets.map((s) => s.name)).toEqual(["第一张", "第二张"]);
    expect(r.sheets[0]!.rows[0]![0]).toBe("11");
    expect(r.sheets[1]!.rows[0]![0]).toBe("22");
  });

  it("rels 绝对 target 形（/xl/worksheets/sheet1.xml）也解析得到", () => {
    const bytes = storedZip([
      part(
        "xl/workbook.xml",
        `${XDECL}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
      part(
        "xl/_rels/workbook.xml.rels",
        `${XDECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet1.xml"/></Relationships>`,
      ),
      part("xl/worksheets/sheet1.xml", worksheetXml(`<row r="1"><c r="A1" t="inlineStr"><is><t>绝对路径</t></is></c></row>`)),
    ]);
    const r = parseXlsxSheets(bytes);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sheets[0]!.rows[0]![0]).toBe("绝对路径");
  });

  it("引用缺失部件（rels 指向不存在的表）→ typed 拒（含表名）", () => {
    const bytes = storedZip([
      part(
        "xl/workbook.xml",
        `${XDECL}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="幽灵表" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
      part(
        "xl/_rels/workbook.xml.rels",
        `${XDECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet404.xml"/></Relationships>`,
      ),
    ]);
    const r = parseXlsxSheets(bytes);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("幽灵表");
  });
});

// ---------------------------------------------------------------------------
// §3 行解析（类型全覆盖 / 稀疏 / 富文本 / 实体 / A1→列号）
// ---------------------------------------------------------------------------

describe("ω99-221 §3 — 行解析", () => {
  it("共享串 t=\"s\"：索引进 sharedStrings 取值", () => {
    const rows = parseSheetRows(
      worksheetXml(`<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>`),
      ["共享甲", "共享乙"],
    );
    expect(rows.rows[0]).toEqual(["共享甲", "共享乙"]);
  });

  it("inlineStr / 布尔 / 错误格 / 数字：四形各归其位", () => {
    const rows = parseSheetRows(
      worksheetXml(
        `<row r="1">` +
          `<c r="A1" t="inlineStr"><is><t>内联文本</t></is></c>` +
          `<c r="B1" t="b"><v>1</v></c>` +
          `<c r="C1" t="b"><v>0</v></c>` +
          `<c r="D1" t="e"><v>#DIV/0!</v></c>` +
          `<c r="E1"><v>3.14</v></c>` +
          `</row>`,
      ),
      [],
    );
    expect(rows.rows[0]).toEqual(["内联文本", "TRUE", "FALSE", "#DIV/0!", "3.14"]);
  });

  it("数字原样字符串防浮点漂移：18 位整数不经过 Number", () => {
    const rows = parseSheetRows(worksheetXml(`<row r="1"><c r="A1"><v>123456789012345678</v></c></row>`), []);
    expect(rows.rows[0]![0]).toBe("123456789012345678");
  });

  it("稀疏格：中间缺列留 null、行跳号留空行（rowCount=最大行号）", () => {
    const rows = parseSheetRows(
      worksheetXml(
        `<row r="1"><c r="A1"><v>1</v></c><c r="C1"><v>3</v></c></row>` +
          `<row r="4"><c r="B4"><v>42</v></c></row>`,
      ),
      [],
    );
    expect(rows.rowCount).toBe(4);
    expect(rows.columnCount).toBe(3);
    expect(rows.rows[0]).toEqual(["1", null, "3"]);
    expect(rows.rows[1]).toEqual([null, null, null]);
    expect(rows.rows[2]).toEqual([null, null, null]);
    expect(rows.rows[3]).toEqual([null, "42", null]);
  });

  it("富文本拼接：<r><t> 多段拼一串；音注 <rPh> 剔除不算数据", () => {
    const bytes = workbookZip(
      [{ name: "S", target: "worksheets/sheet1.xml", sheetData: `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>` }],
      [
        part(
          "xl/sharedStrings.xml",
          `${XDECL}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
            `<si><r><rPr/><t>富文本</t></r><r><t>第二段</t></r></si>` +
            `<si><r><t>汉字</t></r><rPh sb="0" eb="2"><t>カナ</t></rPh></si>` +
            `</sst>`,
        ),
      ],
    );
    const parsed = parseXlsxSheets(bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.sheets[0]!.rows[0]![0]).toBe("富文本第二段"); // 多 run 拼接
    expect(parsed.sheets[0]!.rows[0]![1]).toBe("汉字"); // rPh 音注剔除，不算数据
    // inlineStr 内直下 <t> 与 <r><t> 混拼。
    const mixed = parseSheetRows(worksheetXml(`<row r="1"><c r="A1" t="inlineStr"><is><t>直下</t><r><t>与富段</t></r></is></c></row>`), []);
    expect(mixed.rows[0]![0]).toBe("直下与富段");
  });

  it("XML 实体解码：五个命名实体 + 十进制/十六进制数字实体", () => {
    const rows = parseSheetRows(
      worksheetXml(`<row r="1"><c r="A1" t="inlineStr"><is><t>&amp;&lt;&gt;&quot;&apos;&#20013;&#x4E01;</t></is></c></row>`),
      [],
    );
    expect(rows.rows[0]![0]).toBe(`&<>"'中丁`);
  });

  it("A1 引用→列号：Z=25、AA=26、BA=52（跨 26 进位）", () => {
    const rows = parseSheetRows(
      worksheetXml(
        `<row r="1"><c r="Z1"><v>25</v></c><c r="AA1"><v>26</v></c><c r="BA1"><v>52</v></c></row>`,
      ),
      [],
    );
    expect(rows.columnCount).toBe(53);
    expect(rows.rows[0]![25]).toBe("25"); // Z = 第 26 列 → 0 基 25
    expect(rows.rows[0]![26]).toBe("26"); // AA = 27 → 26
    expect(rows.rows[0]![52]).toBe("52"); // BA = 53 → 52
  });
});

// ---------------------------------------------------------------------------
// §4 窗口（默认 100 / offset / limit / 截断通知 / 列帽 / 表选 / 名录恒在）
// ---------------------------------------------------------------------------

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "o221-xlsx-"));
});

/** n 行 × m 列的 xlsx 写进临时工作区（夹具只写 tmpdir，零删除）。 */
async function writeFixture(rel: string, rows: number, cols: number): Promise<void> {
  const table = {
    columns: Array.from({ length: cols }, (_, c) => ({ header: `列${c + 1}` })),
    rows: Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => `r${r + 1}c${c + 1}`)),
  };
  await writeFile(join(ws, rel), buildXlsx(table));
}

const exec = async (tool: Tool, args: Record<string, unknown>) => tool.execute(args);
const tool = () => createReadXlsxTool(ws);

describe("ω99-221 §4 — 窗口与输出格式", () => {
  it("默认 100 行：150 行数据表读前 100，名录+分隔行+截断通知三件齐", async () => {
    await writeFixture("销售.xlsx", 150, 3);
    const r = await exec(tool(), { path: "销售.xlsx" });
    expect(r.isError).toBeFalsy();
    const lines = (r.content as string).split("\n");
    expect(lines[0]).toBe("工作表：Sheet1（151 行 × 3 列）"); // 表头 + 150 数据行
    expect(lines[1]).toBe("── Sheet1（第 1–100 行，共 151 行）──");
    expect(lines[2]).toBe("列1\t列2\t列3"); // 首行=Excel 第 1 行（表头）
    expect(lines[3]).toBe("r1c1\tr1c2\tr1c3"); // Excel 第 2 行 = 第 1 数据行
    expect(lines).toHaveLength(2 + 100 + 1); // 名录+分隔+100 行+通知
    expect(lines[102]).toContain("已截断");
    expect(lines[102]).toContain("offset=101");
    // 用户词汇：输出零实现术语。
    for (const jargon of ["zip", "XML", "EOCD", "sharedStrings", "inflate"]) {
      expect(r.content.toLowerCase()).not.toContain(jargon.toLowerCase());
    }
  });

  it("offset/limit 翻页：offset=102 limit=50 → 第 102–151 行恰读满，无截断通知", async () => {
    await writeFixture("销售.xlsx", 150, 2);
    const r = await exec(tool(), { path: "销售.xlsx", offset: 102, limit: 50 });
    expect(r.isError).toBeFalsy();
    const lines = (r.content as string).split("\n");
    expect(lines[1]).toBe("── Sheet1（第 102–151 行，共 151 行）──");
    expect(lines[2]).toBe("r101c1\tr101c2"); // Excel 第 102 行 = 第 101 数据行
    expect(lines).toHaveLength(2 + 50); // 尾行即数据尾——读到表尾无通知
  });

  it("limit 硬帽 1000：要 5000 只读 1000，截断通知如实反映实读窗口", async () => {
    await writeFixture("big.xlsx", 1200, 1);
    const r = await exec(tool(), { path: "big.xlsx", limit: 5000 });
    expect(r.isError).toBeFalsy();
    const lines = (r.content as string).split("\n");
    expect(lines[1]).toBe("── Sheet1（第 1–1,000 行，共 1,201 行）──"); // 千分位
    expect(lines).toHaveLength(2 + 1000 + 1);
    expect(lines[1002]).toContain("offset=1,001");
  });

  it("列帽 64：70 列表只显前 64 列并通知", async () => {
    await writeFixture("wide.xlsx", 2, 70);
    const r = await exec(tool(), { path: "wide.xlsx" });
    expect(r.isError).toBeFalsy();
    const lines = (r.content as string).split("\n");
    expect(lines[2].split("\t")).toHaveLength(64);
    expect(lines[2].split("\t")[63]).toBe("列64");
    const notice = lines.find((l) => l.includes("64 列"));
    expect(notice).toBeDefined();
    expect(notice).toContain("70 列");
  });

  it("多表：名录恒在 + 按名选表 + 按序号选表 + 选 miss 拒（错误含全部表名）", async () => {
    const bytes = buildXlsx([
      { sheetName: "销售明细", columns: [{ header: "A" }], rows: [["x1"], ["x2"]] },
      { sheetName: "汇总", columns: [{ header: "B" }], rows: [["y1"]] },
    ]);
    await writeFile(join(ws, "多表.xlsx"), bytes);
    const byName = await exec(tool(), { path: "多表.xlsx", sheet: "汇总" });
    expect(byName.isError).toBeFalsy();
    const lines = (byName.content as string).split("\n");
    expect(lines[0]).toBe("工作表：销售明细（3 行 × 1 列）、汇总（2 行 × 1 列）");
    expect(lines[1]).toContain("汇总");
    expect(lines[2]).toBe("B");
    const byIndex = await exec(tool(), { path: "多表.xlsx", sheet: 2 });
    expect(byIndex.isError).toBeFalsy();
    expect((byIndex.content as string).split("\n")[1]).toContain("汇总");
    const miss = await exec(tool(), { path: "多表.xlsx", sheet: "不存在表" });
    expect(miss.isError).toBe(true);
    expect(miss.content).toContain("不存在表");
    expect(miss.content).toContain("销售明细");
    expect(miss.content).toContain("汇总");
    const badIndex = await exec(tool(), { path: "多表.xlsx", sheet: 5 });
    expect(badIndex.isError).toBe(true);
    expect(badIndex.content).toContain("共 2 张");
  });

  it("offset 超范围 → typed 拒（错误给总行数，模型可自修）", async () => {
    await writeFixture("小表.xlsx", 10, 1);
    const r = await exec(tool(), { path: "小表.xlsx", offset: 999 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("超出");
    expect(r.content).toContain("11 行"); // 表头 + 10 数据行
  });
});

// ---------------------------------------------------------------------------
// §5 工具面（路径围栏 / 姿态四布尔 / ask 集不含 / 挂载位 / 魔数）
// ---------------------------------------------------------------------------

describe("ω99-221 §5 — 工具面与挂载", () => {
  it("workspace 越界拒：../ 与绝对路径 typed 拒（错误含原因）", async () => {
    await writeFixture("内.xlsx", 2, 1);
    for (const bad of ["../外逃.xlsx", "/tmp/o221-abs-evil.xlsx"]) {
      const r = await exec(tool(), { path: bad });
      expect(r.isError).toBe(true);
      expect(r.content).toContain("escapes workspace");
    }
  });

  it("文件不存在 → typed 拒（含路径回显）", async () => {
    const r = await exec(tool(), { path: "没有这个.xlsx" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("文件不存在");
    expect(r.content).toContain("没有这个.xlsx");
  });

  it("姿态四布尔钉：只读 / 并发安全 / 非破坏 / 非开放世界（与 make_xlsx 逐项相反）", () => {
    const t = createReadXlsxTool("/tmp/ws");
    expect(t.isReadOnly?.({})).toBe(true);
    expect(t.isConcurrencySafe?.({})).toBe(true);
    expect(t.isDestructive?.({})).toBe(false);
    expect(t.isOpenWorld?.({})).toBe(false);
    expect(t.shouldDefer?.()).toBeFalsy(); // 读面不进 defer 候选
  });

  it("ask 集不含钉：read_xlsx 不进 DEFAULT_ASK_TOOLS（读类不是全档问的动作类）", () => {
    expect(DEFAULT_ASK_TOOLS.has("read_xlsx")).toBe(false);
  });

  it("READ_TOOLS 读域钉（控制器 fix1 裁决）：工作区内读 = read_file 域——workspace/plan 放行、ask 仍问", () => {
    // 写半边 make_xlsx（FILE_EDIT_TOOLS）在 workspace 档本就自动放行——
    // 读半边进 READ_TOOLS 后信任域对齐（裁决前倒挂：写自动跑、读反而问）。
    // 钉形沿 lsp-gate.test.ts:112 的 decidePermission 现成范式。
    expect(READ_TOOLS.has("read_xlsx")).toBe(true);
    expect(WORKSPACE_TOOLS.has("read_xlsx")).toBe(true);
    expect(decidePermission("workspace", "read_xlsx")).toEqual({ behavior: "allow" });
    expect(decidePermission("plan", "read_xlsx")).toEqual({ behavior: "allow" }); // plan 只读栅栏放行
    expect(decidePermission("ask", "read_xlsx")).toBe("ask"); // 0.3.12：ask 档每个工具都问
    expect(decidePermission("auto", "read_xlsx")).toEqual({ behavior: "allow" });
  });

  it("魔数：旧版 .xls（OLE）→ 教出路的文案；非 zip 文本 → 拒", async () => {
    const ole = new Uint8Array(512);
    ole.set([0xd0, 0xcf, 0x11, 0xe0], 0);
    await writeFile(join(ws, "旧版.xls"), ole);
    const r = await exec(tool(), { path: "旧版.xls" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("旧版 .xls 格式");
    expect(r.content).toContain("另存为");
    await writeFile(join(ws, "文本.txt"), enc.encode("只是文本，不是表格"));
    const t = await exec(tool(), { path: "文本.txt" });
    expect(t.isError).toBe(true);
    expect(t.content).toContain("不是 Excel");
  });

  it("加密文件过工具面 → 用户语拒（无 zip 术语）", async () => {
    await writeFile(join(ws, "加密.xlsx"), singleEntryZip(enc.encode("<wb/>"), "xl/workbook.xml", 0, UTF8_FLAG | 0x0001));
    const r = await exec(tool(), { path: "加密.xlsx" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("密码");
  });

  it("挂载位钉：computer_drag+1=screen_observe（ω99-247 演进）、read_xlsx 下一位是 read_docx（零配置）", () => {
    const stubModel = { stream: async function* () { /* never invoked */ } } as unknown as never;
    const gate = async (): Promise<{ behavior: "allow" }> => ({ behavior: "allow" });
    const names = buildToolSet({ workspaceRoot: "/tmp/ws", model: stubModel, canUseTool: gate, contextWindowTokens: 64_000 }).map((t) => t.name);
    expect(names).toContain("read_xlsx");
    // ω99-247: #9 演进——screen_observe（读面）插在 computer_drag 之后、
    // read_xlsx 之前（computer 域尾后 append-only）：drag 的下一位改钉
    // screen_observe，read_xlsx 顺移一位（read_xlsx+1=read_docx 钉不变）。
    // ω99-250: #13 演进——computer_wait（等待员）插在 screen_observe 之后、
    // read_xlsx 之前（computer 域尾后 append-only）：observe 的下一位改钉
    // computer_wait，read_xlsx 再顺移一位（read_xlsx+1=read_docx 钉不变）。
    expect(names[names.indexOf("computer_drag") + 1]).toBe("screen_observe");
    expect(names[names.indexOf("screen_observe") + 1]).toBe("computer_wait");
    expect(names[names.indexOf("computer_wait") + 1]).toBe("read_xlsx");
    // ω99-222 演进——read_docx/read_pptx 插在 read_xlsx 之后、task 之前（Word/
    // PPT 读半边，append-only 尾）：read_xlsx 的下一位改钉 read_docx（与本件
    // 222 R1 的挂载钉互证；solo 同跑）。
    expect(names[names.indexOf("read_xlsx") + 1]).toBe("read_docx");
    expect(names[names.indexOf("read_docx") + 1]).toBe("read_pptx");
    // ω99-223 演进——append_docx/append_pptx 插在 read_pptx 之后、task 之前
    // （Word/PPT 追加面，append-only 尾）：read_pptx 的链尾改钉 append_docx
    // （与 223 R1 的挂载钉互证；solo 同跑）。
    expect(names[names.indexOf("read_pptx") + 1]).toBe("append_docx");
  });

  it("描述=用户收益词汇：零实现术语入 description", () => {
    const t = createReadXlsxTool("/tmp/ws");
    for (const jargon of ["zip", "XML", "EOCD", "inflate", "sharedStrings", "unzipEntries", "buildTool"]) {
      expect(t.description.toLowerCase()).not.toContain(jargon.toLowerCase());
    }
    expect(t.description).toContain("日期"); // 教模型「日期列是数字属正常」
  });
});

// ---------------------------------------------------------------------------
// §6 summarize（一例 + 老例零漂移）
// ---------------------------------------------------------------------------

describe("ω99-221 §6 — summarize", () => {
  it("read_xlsx 一例：文件尾名+表+行窗口；缺省形与显形都对", () => {
    expect(summarizeXlsxWindow({ path: "reports/订单.xlsx", sheet: "销售明细", offset: 101, limit: 100 }))
      .toBe("订单.xlsx 「销售明细」 第 101–200 行");
    expect(summarizeXlsxWindow({ path: "订单.xlsx" })).toBe("订单.xlsx 第 1–100 行");
    expect(summarizeXlsxWindow({ path: "a/深/路径/盘点.xlsx", sheet: 2 })).toBe("盘点.xlsx 第 2 张表 第 1–100 行");
    expect(summarizeXlsxWindow({})).toBe("第 1–100 行"); // 无 path 无 sheet 的最小形
    expect(summarizeToolCall("read_xlsx", { path: "订单.xlsx", sheet: "销售明细" })).toBe("订单.xlsx 「销售明细」 第 1–100 行");
  });

  it("老例零漂移：computer/read_file/shell/unknown 的 summary 不动", () => {
    expect(summarizeToolCall("shell", { command: "ls" })).toBe("ls");
    expect(summarizeToolCall("read_file", { path: "a.ts" })).toBe("a.ts");
    expect(summarizeToolCall("computer_click", { x: 3, y: 4 })).toBe("(3, 4)");
    expect(summarizeToolCall("screen_capture", {})).toBe("全屏");
    expect(summarizeToolCall("zzz", { x: 1 })).toBe("");
  });
});

// 常量钉（窗口纪律的单一事实源：缺省 100 / 硬帽 1000 / 列帽 64）。
describe("ω99-221 附录 — 窗口常量", () => {
  it("缺省 100 行、硬帽 1000 行、列帽 64（与写面 DOC_MAX_COLUMNS 同数）", () => {
    expect(XLSX_DEFAULT_ROW_LIMIT).toBe(100);
    expect(XLSX_MAX_ROW_LIMIT).toBe(1000);
    expect(XLSX_MAX_COLUMNS).toBe(64);
    expect(XLSX_MAX_COLUMNS).toBe(DOC_MAX_COLUMNS);
  });
});
