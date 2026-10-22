// ω99-123 — A2: doc-xlsx 纯层（DocTable 校验 + minimal xlsx 组装）。
// typed 拒矩阵 + 部件读回 + sheet1 XML 语义 + 字节确定性。RED-first。
import { describe, it, expect } from "vitest";
import { crc32 } from "../src/doc-zip.js";
import { validateDocTable, buildXlsx, defaultXlsxFilename } from "../src/doc-xlsx.js";

const enc = new TextEncoder();
const u16 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number): number =>
  (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

/** 测试内极简 zip 读回器：EOCD → central directory → {name, data}[]。 */
function readZip(z: Uint8Array): { name: string; data: Uint8Array }[] {
  const e = z.length - 22;
  if (u32(z, e) !== 0x06054b50) throw new Error("no EOCD");
  const count = u16(z, e + 10);
  let p = u32(z, e + 16);
  const out: { name: string; data: Uint8Array }[] = [];
  for (let i = 0; i < count; i++) {
    const nameLen = u16(z, p + 28);
    const localOff = u32(z, p + 42);
    const size = u32(z, p + 24);
    const name = new TextDecoder().decode(z.subarray(p + 46, p + 46 + nameLen));
    const localNameLen = u16(z, localOff + 26);
    const crcLocal = u32(z, localOff + 14);
    const data = z.subarray(localOff + 30 + localNameLen, localOff + 30 + localNameLen + size);
    expect(crc32(data)).toBe(crcLocal); // 每条读回即复算 CRC
    out.push({ name, data });
    p += 46 + nameLen;
  }
  return out;
}

const text = (z: Uint8Array, name: string): string =>
  new TextDecoder().decode(readZip(z).find((f) => f.name === name)!.data);

const TABLE = {
  sheetName: "盘点",
  columns: [
    { header: "名称", width: 3 },
    { header: "数量" },
    { header: "备注" },
  ],
  rows: [
    ["键盘 & 鼠标", 12, true],
    ["<A&B>", null, false],
  ],
};

describe("ω99-123 A2 — validateDocTable typed 拒矩阵", () => {
  const bad = (raw: unknown): string => {
    const r = validateDocTable(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    return r.error;
  };

  it("happy：合法表过，钳宽 8..80（宽是排版非数据——定：钳）", () => {
    const r = validateDocTable(TABLE);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.table.columns[0]!.width).toBe(8); // 3 → 钳到 8
      expect(r.table.columns[1]!.width).toBeUndefined();
    }
    const wide = validateDocTable({ columns: [{ header: "a", width: 200 }], rows: [] });
    expect(wide.ok && wide.table.columns[0]!.width).toBe(80); // 200 → 钳到 80
    const mid = validateDocTable({ columns: [{ header: "a", width: 12.5 }], rows: [] });
    expect(mid.ok && mid.table.columns[0]!.width).toBe(12.5); // 界内原样
  });

  it("形状拒：非对象/数组/缺 columns/缺 rows", () => {
    for (const raw of [null, 42, "table", [], ["a"]]) bad(raw);
    bad({});
    bad({ columns: [{ header: "a" }] }); // rows 缺
  });

  it("columns 拒：空 / 65 列 / header 非字符串或空 / 形状不对 / width 非有限数字", () => {
    bad({ columns: [], rows: [] });
    bad({ columns: Array.from({ length: 65 }, () => ({ header: "a" })), rows: [] });
    expect(validateDocTable({ columns: Array.from({ length: 64 }, () => ({ header: "a" })), rows: [] }).ok).toBe(true);
    bad({ columns: [{ header: "" }], rows: [] });
    bad({ columns: [{ header: 7 }], rows: [] });
    bad({ columns: ["名称"], rows: [] });
    bad({ columns: [{ header: "a", width: "12" }], rows: [] });
    bad({ columns: [{ header: "a", width: NaN }], rows: [] });
  });

  it("rows 拒：5001 行 / 行非数组 / 单元格类型拒 / 控制字符拒 / 非有限数字拒", () => {
    bad({ columns: [{ header: "a" }], rows: Array.from({ length: 5001 }, () => [1]) });
    expect(validateDocTable({ columns: [{ header: "a" }], rows: Array.from({ length: 5000 }, () => [1]) }).ok).toBe(true);
    bad({ columns: [{ header: "a" }], rows: [["a"], "row"] });
    bad({ columns: [{ header: "a" }], rows: [{ cell: 1 }] });
    bad({ columns: [{ header: "a" }], rows: [[{}]] });
    bad({ columns: [{ header: "a" }], rows: [[NaN]] });
    bad({ columns: [{ header: "a" }], rows: [[Infinity]] });
    for (const ctrl of ["\x00", "\x01", "\x07", "\x08", "\x0B", "\x0C", "\x0E", "\x1F"]) {
      bad({ columns: [{ header: "a" }], rows: [[`a${ctrl}b`]] });
    }
    // \t \n \r 放行。
    expect(validateDocTable({ columns: [{ header: "a" }], rows: [["a\tb\nc\rd"]] }).ok).toBe(true);
  });

  it("sheetName 拒：非字符串/空/32 字符/非法字符 []:*?/\\ ；31 字符收", () => {
    bad({ sheetName: 7, columns: [{ header: "a" }], rows: [] });
    bad({ sheetName: "", columns: [{ header: "a" }], rows: [] });
    bad({ sheetName: "x".repeat(32), columns: [{ header: "a" }], rows: [] });
    expect(validateDocTable({ sheetName: "x".repeat(31), columns: [{ header: "a" }], rows: [] }).ok).toBe(true);
    for (const ch of ["[", "]", ":", "*", "?", "/", "\\"]) {
      bad({ sheetName: `a${ch}b`, columns: [{ header: "a" }], rows: [] });
    }
  });
});
describe("ω99-123 A2 — buildXlsx 部件清单与 XML 语义（读回断言）", () => {
  const table = validateDocTable(TABLE);
  if (!table.ok) throw new Error("fixture must validate");
  const xlsx = (): Uint8Array => buildXlsx(table.table);

  it("部件清单齐且顺序固定（严格读者保险：core/app 必含）", () => {
    expect(readZip(xlsx()).map((f) => f.name)).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "docProps/core.xml",
      "docProps/app.xml",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
    ]);
  });

  it("workbook：sheet 名=显式 sheetName（缺省 Sheet1），r:id 对上 rels", () => {
    expect(text(xlsx(), "xl/workbook.xml")).toContain('<sheet name="盘点" sheetId="1" r:id="rId1"/>');
    const plain = validateDocTable({ columns: [{ header: "a" }], rows: [] });
    const wb = text(buildXlsx(plain.ok ? plain.table : { columns: [], rows: [] }), "xl/workbook.xml");
    expect(wb).toContain('<sheet name="Sheet1"');
    expect(text(xlsx(), "xl/_rels/workbook.xml.rels")).toContain('Target="worksheets/sheet1.xml"');
    expect(text(xlsx(), "xl/_rels/workbook.xml.rels")).toContain('Target="styles.xml"');
  });

  it("styles：fills[none,gray125] 次序（规格要求）+ cellXfs 两条（默认/表头加粗）", () => {
    const s = text(xlsx(), "xl/styles.xml");
    const none = s.indexOf('patternType="none"');
    const gray = s.indexOf('patternType="gray125"');
    expect(none).toBeGreaterThan(-1);
    expect(gray).toBeGreaterThan(none);
    expect(s).toContain('<fonts count="2">');
    expect(s).toContain("<b/>"); // font[1] = 加粗
    expect(s).toContain('<cellXfs count="2">');
    expect(s).toMatch(/<xf [^>]*fontId="1"[^>]*applyFont="1"/);
    expect(s).toContain('<cellStyle name="Normal"');
  });

  it("sheet1：首行=headers 带 s=\"1\" 加粗；inlineStr 五实体转义；CJK 原样", () => {
    const sh = text(xlsx(), "xl/worksheets/sheet1.xml");
    expect(sh).toContain('<sheetView workbookViewId="0"/>');
    expect(sh).toContain('defaultRowHeight="18"');
    expect(sh).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">名称</t></is></c>');
    expect(sh).toContain('<c r="B1" s="1" t="inlineStr"><is><t xml:space="preserve">数量</t></is></c>');
    // 转义：& 与 < ；中文原样不转义。
    expect(sh).toContain("键盘 &amp; 鼠标");
    expect(sh).toContain("&lt;A&amp;B&gt;");
    expect(sh).toContain("键盘"); // CJK 原样（非实体）
  });

  it("sheet1：cell 四形——数字无 t、布尔 t=\"b\" 1|0、null 整 cell 省略且 r 跳号正确", () => {
    const sh = text(xlsx(), "xl/worksheets/sheet1.xml");
    expect(sh).toContain('<c r="B2"><v>12</v></c>'); // number：无 t
    expect(sh).toContain('<c r="C2" t="b"><v>1</v></c>'); // true
    expect(sh).toContain('<c r="C3" t="b"><v>0</v></c>'); // false
    expect(sh).not.toContain('<c r="B3"'); // null → 整 cell 省略
    expect(sh).toContain('<c r="C3"'); // 跳号后引用仍正确
    expect(sh).toContain('<row r="1">');
    expect(sh).toContain('<row r="3">');
  });

  it("sheet1：cols——有 width 才写 col（钳后值），customWidth=1；无 width 无 col", () => {
    const sh = text(xlsx(), "xl/worksheets/sheet1.xml");
    expect(sh).toContain('<cols><col min="1" max="1" width="8" customWidth="1"/></cols>'); // 3 钳到 8；列 2/3 无 width 不写
    const plain = validateDocTable({ columns: [{ header: "a" }, { header: "b" }], rows: [] });
    if (!plain.ok) throw new Error("unreachable");
    expect(text(buildXlsx(plain.table), "xl/worksheets/sheet1.xml")).not.toContain("<cols>");
  });

  it("docProps 时间钉常量（确定性）+ 类型映射完整", () => {
    const core = text(xlsx(), "docProps/core.xml");
    expect(core).toContain("2026-01-01T00:00:00Z");
    // 全文所有日期形状都是钉常量（无其他年份/时刻渗入）。
    const dates = core.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g) ?? [];
    expect(dates).toEqual(["2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]);
    const ct = text(xlsx(), "[Content_Types].xml");
    expect(ct).toContain("/xl/workbook.xml");
    expect(ct).toContain("/docProps/core.xml");
    expect(ct).toContain("/docProps/app.xml");
  });

  it("字节确定性：同表两次构建逐字节全等", () => {
    const a = xlsx();
    const b = buildXlsx(table.table);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

describe("ω99-123 A2 — defaultXlsxFilename（本地时区，pad 2）", () => {
  const p = (s: number) => String(s).padStart(2, "0");
  it("形状逐字：wudao-表格-YYYYMMDD-HHmmss.xlsx", () => {
    expect(defaultXlsxFilename(new Date(2026, 8, 1, 9, 5, 3))).toBe("wudao-表格-20260901-090503.xlsx");
    expect(defaultXlsxFilename(new Date(2026, 0, 5, 3, 2, 1))).toBe(`wudao-表格-20260105-030201.xlsx`);
    const now = new Date();
    expect(defaultXlsxFilename(now)).toBe(
      `wudao-表格-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.xlsx`,
    );
  });
});

