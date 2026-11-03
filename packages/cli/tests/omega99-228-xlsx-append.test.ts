// ω99-228: #R1 — append_xlsx receipts（七层：回装保真 / scan 选表 / 行扫 /
// 缝补四形 / 整包互证 / 工具面 / summarize）。RED-first。
// ★测试红线（09-09 用户令）：夹具全内存（buildXlsx 造真 .xlsx 字节→append→
// 读回）或 os.tmpdir() 临时工作区**只写不删**；绝不删用户文件/文件夹；零
// rm/unlink；零第三方依赖（node 内建）；零子进程。读写互证：append 完用
// 221 的 parseXlsxSheets 读回（自家读面验自家写面——收据的「现共 M 行」也
// 从读回来，不数 XML）。
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@wudao-org/core";
// 写面（夹具底座：buildXlsx 造真 .xlsx 字节）。
import { buildXlsx } from "../src/doc-xlsx.js";
// 读面（读写互证）。
import { parseXlsxSheets } from "../src/doc-xlsx-read.js";
// 本弧追加面。
import {
  appendXlsx,
  appendXlsxRows,
  lastRowNumber,
  scanXlsxSheetPart,
  validateXlsxAppendRows,
  createAppendXlsxTool,
  summarizeAppendXlsx,
} from "../src/doc-xlsx-append.js";
// zip 地基 + 消费面。
import { crc32, storedZip, unzipEntries } from "../src/doc-zip.js";
import { summarizeToolCall } from "../src/log.js";
import { DEFAULT_ASK_TOOLS, FILE_EDIT_TOOLS, decidePermission } from "../src/permission.js";
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

/** parseXlsxSheets 的窄化帮手（读写互证断言前的夹具层）。 */
function mustParse(bytes: Uint8Array) {
  const parsed = parseXlsxSheets(bytes);
  if (!parsed.ok) throw new Error(`fixture parse failed: ${parsed.error}`);
  return parsed.sheets;
}

/** EOCD 尾扫→中央目录→逐条读 CD CRC 与本地头 CRC（§1 的链验证件）。 */
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

/** buildXlsx 真产物换掉一个部件后的整包（其余部件逐字节取自真产物）。 */
function xlsxWithPart(orig: Uint8Array, name: string, data: Uint8Array): Uint8Array {
  const parts = mustUnzip(orig).map((e) => (e.name === name ? { name, data } : e));
  return storedZip(parts);
}

/** 手搓 worksheet XML（纯层直测底座：dimension/空表/稀疏/乱序形随意造）。 */
const XDECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_M = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const sheetWith = (body: string): string => `${XDECL}<worksheet xmlns="${NS_M}">${body}</worksheet>`;

/** 手搓单条目 zip（flags 可控——加密拒链夹具的底座，221/223 同款）。 */
function singleEntryZip(data: Uint8Array, name: string, flags: number): Uint8Array {
  const nameBytes = enc.encode(name);
  const localLen = 30 + nameBytes.length + data.length;
  const out = new Uint8Array(localLen + 46 + nameBytes.length + 22);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x04034b50, true);
  dv.setUint16(4, 20, true);
  dv.setUint16(6, flags, true);
  dv.setUint16(8, 0, true); // method 0
  dv.setUint32(14, crc32(data), true);
  dv.setUint32(18, data.length, true);
  dv.setUint32(22, data.length, true);
  dv.setUint16(26, nameBytes.length, true);
  out.set(nameBytes, 30);
  out.set(data, 30 + nameBytes.length);
  dv.setUint32(localLen, 0x02014b50, true);
  dv.setUint16(localLen + 6, 20, true);
  dv.setUint16(localLen + 8, flags, true);
  dv.setUint32(localLen + 16, crc32(data), true);
  dv.setUint32(localLen + 20, data.length, true);
  dv.setUint32(localLen + 24, data.length, true);
  dv.setUint16(localLen + 28, nameBytes.length, true);
  dv.setUint32(localLen + 42, 0, true);
  out.set(nameBytes, localLen + 46);
  dv.setUint32(localLen + 46 + nameBytes.length, 0x06054b50, true);
  dv.setUint16(localLen + 46 + nameBytes.length + 8, 1, true);
  dv.setUint16(localLen + 46 + nameBytes.length + 10, 1, true);
  dv.setUint32(localLen + 46 + nameBytes.length + 12, 46 + nameBytes.length, true);
  dv.setUint32(localLen + 46 + nameBytes.length + 16, localLen, true);
  return out;
}

/** 两张表的工作簿（名序 ≠ 部件编号的活样本：销售=sheet1、库存=sheet2）。 */
const TWO_SHEETS = buildXlsx([
  {
    sheetName: "销售",
    columns: [{ header: "日期" }, { header: "金额" }],
    rows: [["一月", 100], ["二月", 200.5], ["三月", null]],
  },
  {
    sheetName: "库存",
    columns: [{ header: "品名" }, { header: "数量" }, { header: "在售" }],
    rows: [["甲", 3, true]],
  },
]);

const NEW_ROWS: readonly (readonly (string | number | boolean | null)[])[] = [
  ["四月", 400, false],
  [null, 500, true],
];

// ---------------------------------------------------------------------------
// §1 回装保真（unzip→缝→storedZip→unzip；CRC 链；确定性）
// ---------------------------------------------------------------------------

describe("ω99-228 §1 回装保真", () => {
  it("追加后部件名序不变、除目标 sheet 部件外逐字节等（回装不丢不改任何部件）", () => {
    const appended = appendXlsx(TWO_SHEETS, NEW_ROWS, "库存");
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    const before = mustUnzip(TWO_SHEETS);
    const after = mustUnzip(appended.bytes);
    expect(after.map((e) => e.name)).toEqual(before.map((e) => e.name));
    for (const [i, e] of before.entries()) {
      if (e.name === "xl/worksheets/sheet2.xml") continue; // 库存=目标部件（唯一该动的）
      expect(bytesEqual(after[i]!.data, e.data)).toBe(true);
    }
    const target = after.find((e) => e.name === "xl/worksheets/sheet2.xml");
    const oldTarget = before.find((e) => e.name === "xl/worksheets/sheet2.xml");
    expect(target !== undefined && oldTarget !== undefined).toBe(true);
    expect(bytesEqual(target!.data, oldTarget!.data)).toBe(false); // 目标部件确实动了
  });

  it("CRC 链全绿：中央目录 CRC = 本地头 CRC = crc32(数据)（每部件）", () => {
    const appended = appendXlsx(TWO_SHEETS, NEW_ROWS);
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    const byName = new Map(mustUnzip(appended.bytes).map((e) => [e.name, e.data]));
    for (const { name, cdCrc, localCrc } of zipCrcs(appended.bytes)) {
      expect(cdCrc).toBe(localCrc);
      expect(cdCrc).toBe(crc32(byName.get(name)!));
    }
  });

  it("确定性：同输入两次 append 全等字节", () => {
    const a = appendXlsx(TWO_SHEETS, NEW_ROWS, "库存");
    const b = appendXlsx(TWO_SHEETS, NEW_ROWS, "库存");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(bytesEqual(a.bytes, b.bytes)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §2 scanXlsxSheetPart（名序 + rels 映射；不假设部件编号=顺序）
// ---------------------------------------------------------------------------

describe("ω99-228 §2 scanXlsxSheetPart", () => {
  it("缺省=第一张；名选；1 起序号选", () => {
    expect(scanXlsxSheetPart(mustUnzip(TWO_SHEETS))).toEqual({
      ok: true,
      sheetName: "销售",
      partName: "xl/worksheets/sheet1.xml",
    });
    expect(scanXlsxSheetPart(mustUnzip(TWO_SHEETS), "库存")).toEqual({
      ok: true,
      sheetName: "库存",
      partName: "xl/worksheets/sheet2.xml",
    });
    expect(scanXlsxSheetPart(mustUnzip(TWO_SHEETS), 2)).toEqual({
      ok: true,
      sheetName: "库存",
      partName: "xl/worksheets/sheet2.xml",
    });
  });

  it("名 miss → typed 拒 + 全部表名列出（模型可自修）", () => {
    const r = scanXlsxSheetPart(mustUnzip(TWO_SHEETS), "回款");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("回款");
    expect(r.error).toContain("销售");
    expect(r.error).toContain("库存");
  });

  it("序号越界 → typed 拒（给总数与名录）", () => {
    const r = scanXlsxSheetPart(mustUnzip(TWO_SHEETS), 3);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("3");
    expect(r.error).toContain("2 张");
  });

  it("绝对 rels target 形（Target=\"/xl/worksheets/sheet1.xml\"）也解析到同部件", () => {
    const relsBytes = mustUnzip(TWO_SHEETS).find((e) => e.name === "xl/_rels/workbook.xml.rels")!;
    const rewritten = new TextDecoder().decode(relsBytes.data).replaceAll(
      'Target="worksheets/sheet1.xml"',
      'Target="/xl/worksheets/sheet1.xml"',
    );
    const absRels = xlsxWithPart(TWO_SHEETS, "xl/_rels/workbook.xml.rels", enc.encode(rewritten));
    expect(scanXlsxSheetPart(mustUnzip(absRels))).toEqual({
      ok: true,
      sheetName: "销售",
      partName: "xl/worksheets/sheet1.xml",
    });
  });

  it("rels 指向缺失部件 → typed 拒（缺表）；缺 workbook.xml → typed 拒", () => {
    const relsBytes = mustUnzip(TWO_SHEETS).find((e) => e.name === "xl/_rels/workbook.xml.rels")!;
    const rewritten = new TextDecoder()
      .decode(relsBytes.data)
      .replaceAll("worksheets/sheet2.xml", "worksheets/sheet9.xml");
    const dangling = xlsxWithPart(TWO_SHEETS, "xl/_rels/workbook.xml.rels", enc.encode(rewritten));
    const r = scanXlsxSheetPart(mustUnzip(dangling), "库存");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("库存");

    const noWorkbook = storedZip(mustUnzip(TWO_SHEETS).filter((e) => e.name !== "xl/workbook.xml"));
    const r2 = scanXlsxSheetPart(mustUnzip(noWorkbook));
    expect(r2.ok).toBe(false);
  });

  it("零 <sheet> 条目 → typed 拒（没有找到任何工作表）", () => {
    const emptyWb = xlsxWithPart(
      TWO_SHEETS,
      "xl/workbook.xml",
      enc.encode(`${XDECL}<workbook xmlns="${NS_M}"><sheets></sheets></workbook>`),
    );
    const r = scanXlsxSheetPart(mustUnzip(emptyWb));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("没有找到任何工作表");
  });
});

// ---------------------------------------------------------------------------
// §3 lastRowNumber（稀疏容忍、乱序容忍=取 max；空 → 0）
// ---------------------------------------------------------------------------

describe("ω99-228 §3 lastRowNumber", () => {
  it("空形：无 sheetData → 0；<sheetData/> 与 <sheetData></sheetData> → 0", () => {
    expect(lastRowNumber(sheetWith("<sheetViews/>"))).toBe(0);
    expect(lastRowNumber(sheetWith("<sheetData/>"))).toBe(0);
    expect(lastRowNumber(sheetWith("<sheetData></sheetData>"))).toBe(0);
  });

  it("稀疏（r=1、r=5）→ 5；乱序（3、1、7）→ 7（取 max 非 last）", () => {
    const sparse = sheetWith(`<sheetData><row r="1"><c r="A1"/></row><row r="5"><c r="A5"/></row></sheetData>`);
    expect(lastRowNumber(sparse)).toBe(5);
    const shuffled = sheetWith(
      `<sheetData><row r="3"><c r="A3"/></row><row r="1"><c r="A1"/></row><row r="7"><c r="A7"/></row></sheetData>`,
    );
    expect(lastRowNumber(shuffled)).toBe(7);
  });

  it("自闭合形：裸 <row/> 无 r → 略过；<row r=\"9\"/> 带 r → 计入", () => {
    const bare = sheetWith(`<sheetData><row r="2"><c r="A2"/></row><row/></sheetData>`);
    expect(lastRowNumber(bare)).toBe(2);
    const selfClosed = sheetWith(`<sheetData><row r="2"><c r="A2"/></row><row r="9"/></sheetData>`);
    expect(lastRowNumber(selfClosed)).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// §4 缝补四形 + dimension + 空表两形 + validator 帽
// ---------------------------------------------------------------------------

describe("ω99-228 §4 appendXlsxRows（四形映射 / dimension / 空表两形）", () => {
  it("四形映射：string→inlineStr、number→<v>、boolean→t=\"b\" 0|1、null→整 cell 略过（跳号正确）", () => {
    const out = appendXlsxRows(
      sheetWith(`<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>老</t></is></c></row></sheetData>`),
      [["文本", 42, true, null, "尾"]],
      2,
    );
    expect(out).toContain(`<row r="2"><c r="A2" t="inlineStr"><is><t xml:space="preserve">文本</t></is></c>`);
    expect(out).toContain(`<c r="B2"><v>42</v></c>`);
    expect(out).toContain(`<c r="C2" t="b"><v>1</v></c>`);
    expect(out).not.toContain(`<c r="D2"`); // null=整 cell 略过
    expect(out).toContain(`<c r="E2" t="inlineStr"><is><t xml:space="preserve">尾</t></is></c>`); // 跳号后 ref 仍对
  });

  it("boolean false → <v>0</v>", () => {
    const out = appendXlsxRows(sheetWith("<sheetData/>"), [[false]], 1);
    expect(out).toContain(`<c r="A1" t="b"><v>0</v></c>`);
  });

  it("dimension：present 则行分量换新 max；absent 则不造", () => {
    const withDim = sheetWith(`<dimension ref="A1:C3"/><sheetData><row r="3"><c r="A3"/></row></sheetData>`);
    const out = appendXlsxRows(withDim, [["a"], ["b"]], 4);
    expect(out).toContain(`<dimension ref="A1:C5"/>`);
    const noDim = sheetWith(`<sheetData><row r="1"><c r="A1"/></row></sheetData>`);
    const out2 = appendXlsxRows(noDim, [["a"]], 2);
    expect(out2).not.toContain("<dimension");
  });

  it("空表两形都收：<sheetData/> 整替换、<sheetData></sheetData> 前插", () => {
    const a = appendXlsxRows(sheetWith("<sheetData/>"), [["x"]], 1);
    expect(a).toContain(`<sheetData><row r="1">`);
    expect(a).toContain(`</sheetData>`);
    expect(a).not.toMatch(/<sheetData\/>/);
    const b = appendXlsxRows(sheetWith("<sheetData></sheetData>"), [["x"]], 1);
    expect(b).toContain(`<sheetData><row r="1">`);
    expect(b).toContain(`</sheetData>`);
  });

  it("插入点：新行落 </sheetData> 前、既有行原样（老行零漂移）", () => {
    const out = appendXlsxRows(
      sheetWith(`<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>老</t></is></c></row></sheetData>`),
      [["新"]],
      2,
    );
    expect(out.indexOf(`<t>老</t>`)).toBeLessThan(out.indexOf(`<t xml:space="preserve">新</t>`));
    expect(out.lastIndexOf(`<row r="2"`)).toBeLessThan(out.lastIndexOf("</sheetData>"));
  });
});

describe("ω99-228 §4b validateXlsxAppendRows（typed 校验，纯）", () => {
  it("非数组拒；空数组拒「没有可追加的行」；行非数组拒", () => {
    expect(validateXlsxAppendRows(undefined).ok).toBe(false);
    const empty = validateXlsxAppendRows([]);
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.error).toContain("没有可追加的行");
    const badRow = validateXlsxAppendRows([["a"], "不是数组"]);
    expect(badRow.ok).toBe(false);
  });

  it("列 >64 拒且指明第几列（65 列 → 越界列点名）", () => {
    const wide = Array.from({ length: 65 }, () => null);
    const r = validateXlsxAppendRows([wide]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("64");
    expect(r.error).toContain("65");
  });

  it("控制字拒且 \\t \\n \\r 放行；非有限数拒；非法类型拒；合法四形过", () => {
    expect(validateXlsxAppendRows([["bad\x01char"]]).ok).toBe(false);
    const ok = validateXlsxAppendRows([["tab\there", "line\nbreak", "cr\r", 1.5, -0, true, false, null, ""]]);
    expect(ok.ok).toBe(true);
    expect(validateXlsxAppendRows([[Number.NaN]]).ok).toBe(false);
    expect(validateXlsxAppendRows([[Number.POSITIVE_INFINITY]]).ok).toBe(false);
    expect(validateXlsxAppendRows([[{} as unknown as string]]).ok).toBe(false);
    expect(validateXlsxAppendRows([[[1] as unknown as string]]).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §5 整包 appendXlsx（读写互证：parseXlsxSheets 读回）
// ---------------------------------------------------------------------------

describe("ω99-228 §5 整包 appendXlsx（读写互证）", () => {
  it("多表文件追加到指名表：老行零漂移、新行逐格对、另一张表零漂移、行号连续", () => {
    const appended = appendXlsx(TWO_SHEETS, NEW_ROWS, "库存");
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    const sheets = mustParse(appended.bytes);
    expect(sheets.map((s) => s.name)).toEqual(["销售", "库存"]);
    // 销售表（非目标）零漂移（含表头行——make 面首行=表头）。
    const sales = sheets[0]!;
    expect(sales.rows).toEqual([["日期", "金额"], ["一月", "100"], ["二月", "200.5"], ["三月", null]]);
    // 库存表：表头 + 老行 + 新行逐格（读面口径：数字原样串、布尔 TRUE/FALSE、null=空）。
    const stock = sheets[1]!;
    expect(stock.rows).toEqual([
      ["品名", "数量", "在售"],
      ["甲", "3", "TRUE"],
      ["四月", "400", "FALSE"],
      [null, "500", "TRUE"],
    ]);
    expect(stock.rowCount).toBe(4); // 表头 + 1 老行 + 2 新行
    expect(appended.sheetName).toBe("库存");
    expect(appended.appended).toBe(2);
    expect(appended.totalRows).toBe(4); // totalRows=读回真值
  });

  it("缺省第一张 + 手搓稀疏前史（r=1、r=5）：新行接 max 后、totalRows=读回 max", () => {
    const sparse = xlsxWithPart(
      TWO_SHEETS,
      "xl/worksheets/sheet1.xml",
      enc.encode(
        sheetWith(
          `<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>头</t></is></c></row>` +
            `<row r="5"><c r="A5" t="inlineStr"><is><t>跳到五行</t></is></c></row></sheetData>`,
        ),
      ),
    );
    const appended = appendXlsx(sparse, [["新一行"]]); // 缺省=第一张（销售=sheet1）
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    const sales = mustParse(appended.bytes)[0]!;
    expect(sales.rowCount).toBe(6); // 稀疏 max=5，追加一行 → 6
    expect(sales.rows[5]).toEqual(["新一行"]); // 第 6 行（空洞 2–4 读回为空行）
    expect(appended.totalRows).toBe(6);
  });

  it("空表（<sheetData/>）追加：startRow=1，读回恰新行", () => {
    const empty = xlsxWithPart(TWO_SHEETS, "xl/worksheets/sheet1.xml", enc.encode(sheetWith("<sheetData/>")));
    const appended = appendXlsx(empty, [["甲", 1], ["乙", 2]]);
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    const sales = mustParse(appended.bytes)[0]!;
    expect(sales.rows).toEqual([["甲", "1"], ["乙", "2"]]);
    expect(appended.totalRows).toBe(2);
  });

  it("实体转义往返：& < > \" ' 追加后读回原串", () => {
    const nasty = `a&b<c>"d"'e`;
    const appended = appendXlsx(TWO_SHEETS, [[nasty]], "库存");
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    expect(mustParse(appended.bytes)[1]!.rows[2]![0]).toBe(nasty); // 表头=0、老行=1、新行=2
  });

  it("空串格读回为 null（与 make 面同形：空串即空格，诚实边界）", () => {
    const appended = appendXlsx(TWO_SHEETS, [["", "x"]], "库存");
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    expect(mustParse(appended.bytes)[1]!.rows[2]).toEqual([null, "x", null]); // 宽=表宽 3
  });

  it("坏 zip / 加密 → typed 拒（unzip 的 xlsx 口径原样过，零映射）", () => {
    const notZip = appendXlsx(enc.encode("根本不是 zip"), [["a"]]);
    expect(notZip.ok).toBe(false);
    if (notZip.ok) return;
    expect(notZip.error).toContain("不是有效的 Excel");
    // 手搓单条目加密 zip（flags bit 0）——Excel 另存出路文案。
    const locked = appendXlsx(singleEntryZip(enc.encode("<workbook/>"), "xl/workbook.xml", 0x0001), [["a"]]);
    expect(locked.ok).toBe(false);
    if (locked.ok) return;
    expect(locked.error).toContain("密码");
    expect(locked.error).toContain("另存为");
  });

  it("表名 miss → typed 拒带名录（模型可自修）", () => {
    const r = appendXlsx(TWO_SHEETS, [["a"]], "回款");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("销售");
    expect(r.error).toContain("库存");
  });
});

// ---------------------------------------------------------------------------
// §6 工具面（append_xlsx）
// ---------------------------------------------------------------------------

describe("ω99-228 §6 工具面（append_xlsx）", () => {
  it("姿态四布尔：镜像 make_xlsx/append_docx 写面（非只读/非并发安全/破坏性/非开放世界）", () => {
    const tool = createAppendXlsxTool("/tmp/ws");
    expect(tool.isReadOnly()).toBe(false);
    expect(tool.isConcurrencySafe()).toBe(false);
    expect(tool.isDestructive()).toBe(true);
    expect(tool.isOpenWorld()).toBe(false);
  });

  it("描述=用户收益词汇：教追加场景与 read/make 配套，零实现术语", () => {
    const tool = createAppendXlsxTool("/tmp/ws");
    expect(tool.description).toContain("追加");
    expect(tool.description).toContain("read_xlsx");
    for (const jargon of ["zip", "XML", "EOCD", "inflate", "sharedStrings", "inlineStr", "unzipEntries", "storedZip", "dimension"]) {
      expect(tool.description.toLowerCase()).not.toContain(jargon.toLowerCase());
    }
  });

  it("typed 校验先于盘副作用：坏 rows 拒且目标文件字节零变化", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-o228-a-"));
    const target = join(ws, "订单.xlsx");
    await writeFile(target, TWO_SHEETS);
    const tool = createAppendXlsxTool(ws);
    const before = new Uint8Array(await readFile(target));
    const bad = await exec(tool, { path: "订单.xlsx", rows: [["坏\x01字"]] });
    expect(bad.isError).toBe(true);
    expect(new Uint8Array(await readFile(target))).toEqual(before); // 拒时零写盘
  });

  it("空 rows 拒「没有可追加的行」", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-o228-b-"));
    await writeFile(join(ws, "订单.xlsx"), TWO_SHEETS);
    const r = await exec(createAppendXlsxTool(ws), { path: "订单.xlsx", rows: [] });
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain("没有可追加的行");
  });

  it("魔数嗅探：OLE → 旧版 .xls 出路文案；非 PK → 拒", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-o228-c-"));
    const tool = createAppendXlsxTool(ws);
    await writeFile(join(ws, "旧.xlsx"), new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]));
    const ole = await exec(tool, { path: "旧.xlsx", rows: [["a"]] });
    expect(ole.isError).toBe(true);
    expect(String(ole.content)).toContain("旧版 .xls");
    expect(String(ole.content)).toContain("另存为");
    await writeFile(join(ws, "假.xlsx"), "这不是表格", "utf8");
    const fake = await exec(tool, { path: "假.xlsx", rows: [["a"]] });
    expect(fake.isError).toBe(true);
    expect(String(fake.content)).toContain("不是 Excel");
  });

  it("workspace 越界拒：../ 外逃与绝对路径 typed 拒", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-o228-d-"));
    const tool = createAppendXlsxTool(ws);
    const escape = await exec(tool, { path: "../外逃.xlsx", rows: [["a"]] });
    expect(escape.isError).toBe(true);
    const absolute = await exec(tool, { path: "/tmp/绝对.xlsx", rows: [["a"]] });
    expect(absolute.isError).toBe(true);
  });

  it("文件不存在：ENOENT → 用户语", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-o228-e-"));
    const r = await exec(createAppendXlsxTool(ws), { path: "不存在.xlsx", rows: [["a"]] });
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain("文件不存在");
  });

  it("sheet miss → 名录拒（模型可自修）", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-o228-f-"));
    await writeFile(join(ws, "订单.xlsx"), TWO_SHEETS);
    const r = await exec(createAppendXlsxTool(ws), { path: "订单.xlsx", sheet: "回款", rows: [["a"]] });
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain("回款");
    expect(String(r.content)).toContain("销售");
  });

  it("覆写同路径：追加落在原文件本身 + 收据「已追加 N 行到 …（现共 M 行，第 X–Y 行）」+ 文件卡", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-o228-g-"));
    const target = join(ws, "订单.xlsx");
    await writeFile(target, TWO_SHEETS);
    const r = await exec(createAppendXlsxTool(ws), { path: "订单.xlsx", sheet: "库存", rows: NEW_ROWS });
    expect(r.isError).not.toBe(true);
    if (r.isError) return;
    const text = String(r.content);
    expect(text).toContain("已追加 2 行到 订单.xlsx「库存」（现共 4 行，第 3–4 行");
    // 同路径读回：老行在、新行在尾部（读写互证 + 只覆写目标文件本身）。
    const stock = mustParse(new Uint8Array(await readFile(target)))[1]!;
    expect(stock.rowCount).toBe(4);
    expect(stock.rows[3]).toEqual([null, "500", "TRUE"]);
    // 文件卡收据：结构化末行可提取（append 面=比新建更交付向）。
    const receipt = extractFileReceipt("append_xlsx", text);
    expect(receipt).toBeDefined();
    expect(receipt!.name).toBe("订单.xlsx");
    expect(receipt!.bytes).toBeGreaterThan(0);
  });

  it("FILE_EDIT_TOOLS 含名 + 四档矩阵（workspace/auto 放行、ask 仍问、plan 拒）+ 不进 DEFAULT_ASK_TOOLS", () => {
    expect(FILE_EDIT_TOOLS.has("append_xlsx")).toBe(true);
    expect(DEFAULT_ASK_TOOLS.has("append_xlsx")).toBe(false);
    expect(decidePermission("workspace", "append_xlsx")).toEqual({ behavior: "allow" });
    expect(decidePermission("auto", "append_xlsx")).toEqual({ behavior: "allow" });
    expect(decidePermission("ask", "append_xlsx")).toBe("ask");
    expect(decidePermission("plan", "append_xlsx")).toEqual({ behavior: "deny", reason: expect.stringContaining("plan mode is read-only") });
  });

  it("挂载位钉（零配置）：append_pptx+1=append_xlsx、append_xlsx+1=replace_docx、replace_pptx 的下一位才是 task", () => {
    const stubModel = { stream: async function* () { /* never invoked */ } } as unknown as never;
    const gate = async (): Promise<{ behavior: "allow" }> => ({ behavior: "allow" });
    const names = buildToolSet({ workspaceRoot: "/tmp/ws", model: stubModel, canUseTool: gate, contextWindowTokens: 64_000 }).map((t) => t.name);
    expect(names).toContain("append_xlsx");
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
    // ω99-238: #12 演进——set_docx_header/set_pptx_notes 插在 replace_xlsx
    // 之后、task 之前（文档部件面=页眉页脚+演讲备注，doc 名册尾 append-only
    // 尾）：replace_xlsx 的下一位改钉 set_docx_header，set_pptx_notes 的下
    // 一位才是 task。
    // ω99-256: #8 演进——clear_docx_header/set_docx_first_page 插在
    // set_pptx_notes 之后、task 之前（doc 部件面 v2=页眉删除+首页不同，
    // doc 名册尾 append-only 尾）：set_pptx_notes 的下一位改钉
    // clear_docx_header，set_docx_first_page 的下一位才是 task。
    // ω99-263: #9 演进——set_docx_even_pages 插在 set_docx_first_page 之后、
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
// §7 summarize：新例 + 老例零漂移
// ---------------------------------------------------------------------------

describe("ω99-228 §7 summarize", () => {
  it("append_xlsx 一例：对象形「订单.xlsx 「销售明细」 追加 5 行」（220 语法：总数子句砍）", () => {
    const rows = [[1], [2], [3], [4], [5]];
    expect(summarizeToolCall("append_xlsx", { path: "dir/订单.xlsx", sheet: "销售明细", rows })).toBe(
      "订单.xlsx 「销售明细」 追加 5 行",
    );
  });

  it("sheet 缺省/序号形：名子句省略 / 「第 2 张表」", () => {
    expect(summarizeToolCall("append_xlsx", { path: "订单.xlsx", rows: [[1]] })).toBe("订单.xlsx 追加 1 行");
    expect(summarizeToolCall("append_xlsx", { path: "订单.xlsx", sheet: 2, rows: [[1], [2]] })).toBe(
      "订单.xlsx 第 2 张表 追加 2 行",
    );
  });

  it("纯件直钉：summarizeAppendXlsx（文件尾名+表+追加量）", () => {
    expect(summarizeAppendXlsx({ path: "/x/订单.xlsx", sheet: "销售明细", rows: [[1]] })).toBe("订单.xlsx 「销售明细」 追加 1 行");
    expect(summarizeAppendXlsx({})).toBe("");
  });

  it("老例零漂移：read_xlsx 与 append_docx 原样", () => {
    expect(summarizeToolCall("read_xlsx", { path: "订单.xlsx", sheet: "销售明细" })).toBe("订单.xlsx 「销售明细」 第 1–100 行");
    expect(summarizeToolCall("append_docx", { path: "报告.docx", blocks: [{}, {}, {}] })).toBe("报告.docx 追加 3 块");
  });
});
