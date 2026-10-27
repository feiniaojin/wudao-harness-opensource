// ω99-133 — make_xlsx 多工作表（sheets 数组）：buildXlsx 多表部件读回 +
// validateDocSheets 拒矩阵 + 工具面多表收据/零写盘 + 单表零漂移。RED-first。
// 123 三件零改动全绿=单表路径零漂移的硬证；本文件只钉多表新面。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@wudao/core";
import { crc32 } from "../src/doc-zip.js";
import { extractFileReceipt } from "../src/driver/file-receipt.js";
import {
  buildXlsx,
  createMakeXlsxTool,
  validateDocTable,
  validateDocSheets,
  DOC_MAX_COLUMNS,
  DOC_MAX_SHEETS,
  DOC_DEFAULT_SHEET_NAME,
} from "../src/doc-xlsx.js";
import type { DocTable } from "../src/doc-xlsx.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "w133-xlsx-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

const u16 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number): number =>
  (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

/** 测试内极简 zip 读回器（123 同款）：EOCD → central directory → {name, data}[]。 */
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

/** 周报三表（dogfood 实证原需求形状：一张文件三张表）。 */
const SHEETS = [
  {
    sheetName: "本周进展",
    columns: [{ header: "事项", width: 12 }, { header: "状态" }],
    rows: [
      ["对接 API", "完成"],
      ["压测", "进行中"],
    ],
  },
  {
    sheetName: "下周计划",
    columns: [{ header: "日期" }, { header: "安排" }],
    rows: [
      ["周一", "复盘"],
      ["周二", "发版"],
    ],
  },
  {
    sheetName: "风险",
    columns: [{ header: "风险" }],
    rows: [["供应商延迟"]],
  },
];

const mustSheets = (raw: unknown): readonly DocTable[] => {
  const c = validateDocSheets(raw);
  if (!c.ok) throw new Error("fixture must validate");
  return c.tables;
};

/** n 张互不同名的小表（上限边界用）。 */
const nSheets = (n: number): unknown[] =>
  Array.from({ length: n }, (_, i) => ({ sheetName: `表${i + 1}`, columns: [{ header: "列" }], rows: [[i + 1]] }));

const exec = async (tool: Tool, args: Record<string, unknown>) => tool.execute(args);

describe("ω99-133 — buildXlsx 多表部件（读回断言：workbook/rels/Content_Types/sheetN）", () => {
  const x3 = (): Uint8Array => buildXlsx(mustSheets(SHEETS));

  it("部件清单：7 固定件 + sheet1..sheet3 按序收尾", () => {
    expect(readZip(x3()).map((f) => f.name)).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "docProps/core.xml",
      "docProps/app.xml",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
      "xl/worksheets/sheet2.xml",
      "xl/worksheets/sheet3.xml",
    ]);
  });

  it("workbook：`<sheets>` 按位序 name/sheetId=i+1/r:id=rId{i+1}", () => {
    expect(text(x3(), "xl/workbook.xml")).toContain(
      '<sheets><sheet name="本周进展" sheetId="1" r:id="rId1"/><sheet name="下周计划" sheetId="2" r:id="rId2"/><sheet name="风险" sheetId="3" r:id="rId3"/></sheets>',
    );
  });

  it("rels：rId1..rIdN=worksheets/sheetN，styles 顺延 rId{N+1}", () => {
    const rels = text(x3(), "xl/_rels/workbook.xml.rels");
    for (const i of [1, 2, 3]) {
      expect(rels).toContain(
        `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`,
      );
    }
    expect(rels).toContain(
      '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    );
  });

  it("Content_Types：每张 sheet 一条 worksheet Override（恰 3 条按序）", () => {
    expect(text(x3(), "[Content_Types].xml").match(/\/xl\/worksheets\/sheet\d\.xml/g)).toEqual([
      "/xl/worksheets/sheet1.xml",
      "/xl/worksheets/sheet2.xml",
      "/xl/worksheets/sheet3.xml",
    ]);
  });

  it("sheetN ↔ 表内容映射：sheet1=进展、sheet2=计划、sheet3=风险，互不串页", () => {
    const s1 = text(x3(), "xl/worksheets/sheet1.xml");
    expect(s1).toContain("事项");
    expect(s1).toContain("对接 API");
    expect(s1).not.toContain("发版");
    const s2 = text(x3(), "xl/worksheets/sheet2.xml");
    expect(s2).toContain("周一");
    expect(s2).toContain("发版");
    expect(s2).not.toContain("压测");
    expect(text(x3(), "xl/worksheets/sheet3.xml")).toContain("供应商延迟");
  });

  it("未命名 sheet 落缺省名：workbook 里 name=Sheet1 与显式名并列", () => {
    const mixed = mustSheets([
      { columns: [{ header: "a" }], rows: [] },
      { sheetName: "数据", columns: [{ header: "b" }], rows: [] },
    ]);
    expect(text(buildXlsx(mixed), "xl/workbook.xml")).toContain(
      `<sheets><sheet name="${DOC_DEFAULT_SHEET_NAME}" sheetId="1" r:id="rId1"/><sheet name="数据" sheetId="2" r:id="rId2"/></sheets>`,
    );
  });

  it("N=1 退化：数组单表与单表入参逐字节相同；多表两次构建逐字节全等", () => {
    const t = validateDocTable(SHEETS[0]);
    if (!t.ok) throw new Error("fixture must validate");
    expect(Buffer.from(buildXlsx(mustSheets([SHEETS[0]]))).equals(Buffer.from(buildXlsx(t.table)))).toBe(true);
    expect(Buffer.from(x3()).equals(Buffer.from(buildXlsx(mustSheets(SHEETS))))).toBe(true);
  });
});

describe("ω99-133 — validateDocSheets 拒矩阵（typed 拒，逐元素复用 123 校验）", () => {
  const bad = (raw: unknown): string => {
    const r = validateDocSheets(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    return r.error;
  };

  it("面检拒：非数组 / 空数组 / 超 DOC_MAX_SHEETS（报上限）；恰 8 张收", () => {
    for (const raw of [null, 7, "sheets", {}, { columns: [] }]) expect(validateDocSheets(raw).ok).toBe(false);
    expect(bad("x")).toContain("sheets must be an array");
    expect(bad([])).toContain("at least one table");
    expect(validateDocSheets(nSheets(DOC_MAX_SHEETS)).ok).toBe(true);
    const nine = bad(nSheets(DOC_MAX_SHEETS + 1));
    expect(nine).toContain(`limited to ${DOC_MAX_SHEETS} tables`);
  });

  it("有效名去重拒：显式重名 + 两个未命名同落缺省名（fail-closed，模型自己改名）", () => {
    const dup = bad([SHEETS[0], SHEETS[1], { ...SHEETS[0] }]);
    expect(dup).toContain("each sheet needs a distinct sheetName");
    expect(dup).toContain("本周进展");
    const unnamed = bad([
      { columns: [{ header: "a" }], rows: [] },
      { columns: [{ header: "b" }], rows: [] },
    ]);
    expect(unnamed).toContain("each sheet needs a distinct sheetName");
    expect(unnamed).toContain(DOC_DEFAULT_SHEET_NAME);
  });

  it("123 单表校验在 sheets 元素内同样生效：列超限/控制字符/坏 sheet 名——错误带 sheets[i] 前缀", () => {
    const cols = bad([
      { sheetName: "好表", columns: [{ header: "a" }], rows: [] },
      { sheetName: "坏表", columns: Array.from({ length: DOC_MAX_COLUMNS + 1 }, () => ({ header: "a" })), rows: [] },
    ]);
    expect(cols).toContain("sheets[1]");
    expect(cols).toContain(`limited to ${DOC_MAX_COLUMNS} columns`);
    const ctrl = bad([{ sheetName: "x", columns: [{ header: "a" }], rows: [["a\x07b"]] }]);
    expect(ctrl).toContain("sheets[0]");
    expect(ctrl).toContain("control character");
    const badName = bad([{ sheetName: "a[b", columns: [{ header: "a" }], rows: [] }]);
    expect(badName).toContain("sheets[0]");
    expect(badName).toContain("Excel sheet-name rules");
  });
});

describe("ω99-133 — 工具面：sheets 多表执行/收据/零写盘 + 单表零漂移", () => {
  it("多表：真写盘，收据中文句含「N 张工作表：名1/名2/名3」，JSON 末行 sheets/总行数", async () => {
    const tool = createMakeXlsxTool(ws);
    const r = await exec(tool, { sheets: SHEETS, filename: "周报/第36周.xlsx" });
    expect(r.isError).toBeFalsy();
    const line1 = r.content.split("\n")[0]!;
    expect(line1).toContain("已生成 Excel：周报/第36周.xlsx");
    expect(line1).toContain("3 张工作表：本周进展/下周计划/风险");
    expect(line1).not.toContain("{"); // 131：中文句不得含 {（TUI 按首个 { 切句）
    const parsed = JSON.parse(r.content.split("\n")[1]!) as Record<string, unknown>;
    expect(parsed["relativePath"]).toBe("周报/第36周.xlsx");
    expect(parsed["path"]).toBe(await realpath(join(ws, "周报/第36周.xlsx")));
    expect(parsed["sheets"]).toBe(3);
    expect(parsed["rows"]).toBe(5); // 2+2+1 总行数
    expect((await stat(parsed["path"] as string)).size).toBe(parsed["bytes"]);
    // 落盘字节=buildXlsx 多表直构。
    const onDisk = await readFile(join(ws, "周报/第36周.xlsx"));
    expect(onDisk.equals(Buffer.from(buildXlsx(mustSheets(SHEETS))))).toBe(true);
    // 提取器（125 名门）读多表收据不受影响：path/bytes 照取。
    const receipt = extractFileReceipt("make_xlsx", r.content);
    expect(receipt?.path).toBe(parsed["path"]);
    expect(receipt?.bytes).toBe(parsed["bytes"]);
  });

  it("名字列表恰取前 3 个：4 张 → 尾缀「…等4张」", async () => {
    const tool = createMakeXlsxTool(ws);
    const four = [
      { sheetName: "一", columns: [{ header: "a" }], rows: [[1]] },
      { sheetName: "二", columns: [{ header: "a" }], rows: [[2]] },
      { sheetName: "三", columns: [{ header: "a" }], rows: [[3]] },
      { sheetName: "四", columns: [{ header: "a" }], rows: [[4]] },
    ];
    const r = await exec(tool, { sheets: four, filename: "四表.xlsx" });
    expect(r.isError).toBeFalsy();
    expect(r.content.split("\n")[0]).toContain("4 张工作表：一/二/三…等4张");
    expect(JSON.parse(r.content.split("\n")[1]!)["sheets"]).toBe(4);
  });

  it("sheets 单元素：走多表收据形（1 张工作表）", async () => {
    const tool = createMakeXlsxTool(ws);
    const r = await exec(tool, { sheets: [SHEETS[0]] });
    expect(r.isError).toBeFalsy();
    expect(r.content.split("\n")[0]).toContain("1 张工作表：本周进展");
  });

  it("互斥拒：table 与 sheets 都给 → use either table or sheets；都不给=沿用现有拒", async () => {
    const tool = createMakeXlsxTool(ws);
    const both = await exec(tool, { table: SHEETS[0], sheets: SHEETS });
    expect(both.isError).toBe(true);
    expect(both.content).toContain("use either table or sheets, not both");
    const neither = await exec(tool, {});
    expect(neither.isError).toBe(true);
    expect(neither.content).toContain("table must be an object");
    expect(await readdir(ws)).toEqual([]); // 拒时零写盘
  });

  it("校验拒时零写盘：非数组/空/超 8/重名/元素内列超限 全拒且目录空", async () => {
    const tool = createMakeXlsxTool(ws);
    const bads: Record<string, unknown>[] = [
      { sheets: 7 },
      { sheets: [] },
      { sheets: nSheets(DOC_MAX_SHEETS + 1) },
      { sheets: [SHEETS[0], { ...SHEETS[0] }] },
      {
        sheets: [
          { sheetName: "a", columns: [{ header: "x" }], rows: [] },
          { sheetName: "b", columns: Array.from({ length: DOC_MAX_COLUMNS + 1 }, () => ({ header: "x" })), rows: [] },
        ],
      },
    ];
    for (const args of bads) {
      const r = await exec(tool, args);
      expect(r.isError).toBe(true);
      expect(r.content).not.toContain("已生成");
    }
    expect(await readdir(ws)).toEqual([]);
  });

  it("单表零漂移：table 通道收据与改前同形——不含「张工作表」，JSON 无 sheets 键", async () => {
    const tool = createMakeXlsxTool(ws);
    const r = await exec(tool, { table: SHEETS[0], filename: "单表.xlsx" });
    expect(r.isError).toBeFalsy();
    const line1 = r.content.split("\n")[0]!;
    expect(line1).toContain("已生成 Excel：单表.xlsx");
    expect(line1).toContain("2 行 × 2 列");
    expect(line1).not.toContain("张工作表");
    const parsed = JSON.parse(r.content.split("\n")[1]!) as Record<string, unknown>;
    expect(parsed["sheets"]).toBeUndefined();
    expect(parsed["rows"]).toBe(2);
    expect(parsed["columns"]).toBe(2);
  });

  it("模型发现面：description 含 sheets 用法一句（最多 8 张/名字不得重复）", () => {
    const tool = createMakeXlsxTool(ws);
    expect(tool.description).toContain("参数 sheets");
    expect(tool.description).toContain(`最多 ${DOC_MAX_SHEETS} 张`);
    expect(tool.description).toContain("名字不得重复");
  });
});

