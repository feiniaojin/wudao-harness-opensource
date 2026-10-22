// ω99-126 — A: doc-docx 纯层（DocBlock 校验 + minimal docx 组装）。
// typed 拒矩阵 + 五部件读回 + document.xml 语义 + 字节确定性。RED-first。
// styles 择定=案 (a) 完全省略：document.xml 全部直接格式化，零样式引用、
// 零关系引用 → 零 styles.xml、零 word/_rels（独立读者验证记录见弧报告）。
import { describe, it, expect } from "vitest";
import { crc32 } from "../src/doc-zip.js";
import { validateDocTable } from "../src/doc-xlsx.js"; // 对照钉：cell 规与 123 两侧一致
import { validateDocDoc, buildDocx, defaultDocxFilename } from "../src/doc-docx.js";

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

const DOC = {
  blocks: [
    { kind: "title", text: "季度盘点报告" },
    { kind: "heading", text: "一、总体情况" },
    { kind: "body", text: "本季度共盘点 & 汇总 <三次>，详见下表。" },
    { kind: "bullet", text: "第一条要点" },
    { kind: "table", columns: [{ header: "名称" }, { header: "数量" }], rows: [["键盘 & 鼠标", 12], [true, null], ["短行"]] },
  ],
};

const docx = (): Uint8Array => {
  const r = validateDocDoc(DOC);
  if (!r.ok) throw new Error("fixture must validate");
  return buildDocx(r.doc);
};

describe("ω99-126 A — validateDocDoc typed 拒矩阵", () => {
  const bad = (raw: unknown): string => {
    const r = validateDocDoc(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    return r.error;
  };
  const blocks = (...b: unknown[]) => ({ blocks: [...b] });
  const tableBlock = (rows: unknown[], columns: unknown[] = [{ header: "列" }]) => ({ kind: "table", columns, rows });

  it("happy：五种 block 形全过（title/heading/body/bullet/table）", () => {
    const r = validateDocDoc(DOC);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.blocks.length).toBe(5);
  });

  it("形状拒：非对象/数组/缺 blocks/空数组/501 块（500 收）", () => {
    for (const raw of [null, 42, "doc", [], ["a"]]) bad(raw);
    bad({});
    bad({ blocks: [] });
    bad({ blocks: Array.from({ length: 501 }, () => ({ kind: "body", text: "x" })) });
    expect(validateDocDoc({ blocks: Array.from({ length: 500 }, () => ({ kind: "body", text: "x" })) }).ok).toBe(true);
  });

  it("kind 拒：未知 kind / 缺 kind / kind 非字符串", () => {
    bad(blocks({ kind: "quote", text: "t" }));
    bad(blocks({ text: "t" }));
    bad(blocks({ kind: 7, text: "t" }));
  });

  it("文本拒（title/heading/body/bullet 四类同规）：非字符串/空/控制字符 ×8；\\t \\n \\r 放行", () => {
    for (const kind of ["title", "heading", "body", "bullet"]) {
      bad(blocks({ kind, text: 7 }));
      bad(blocks({ kind, text: "" }));
      for (const ctrl of ["\x00", "\x01", "\x07", "\x08", "\x0B", "\x0C", "\x0E", "\x1F"]) {
        bad(blocks({ kind, text: `a${ctrl}b` }));
      }
      expect(validateDocDoc(blocks({ kind, text: "a\tb\nc\rd" })).ok).toBe(true);
    }
  });

  it("表格列拒：空/65 列（64 收）/header 非字符串空/列形状/控制字符", () => {
    bad(blocks(tableBlock([], [])));
    bad(blocks(tableBlock([[]], Array.from({ length: 65 }, () => ({ header: "a" })))));
    expect(validateDocDoc(blocks(tableBlock([[]], Array.from({ length: 64 }, () => ({ header: "a" }))))).ok).toBe(true);
    bad(blocks(tableBlock([[]], [{ header: "" }])));
    bad(blocks(tableBlock([[]], [{ header: 7 }])));
    bad(blocks(tableBlock([[]], ["列名"])));
    bad(blocks(tableBlock([[]], [{ header: "a\x07b" }])));
  });

  it("行拒：5001 行（5000 收）/rows 非数组/行非数组/行比列多拒；短行收（构建时补 null）", () => {
    bad(blocks(tableBlock(Array.from({ length: 5001 }, () => [1]))));
    expect(validateDocDoc(blocks(tableBlock(Array.from({ length: 5000 }, () => [1])))).ok).toBe(true);
    bad(blocks({ kind: "table", columns: [{ header: "a" }], rows: "x" }));
    bad(blocks(tableBlock(["row"])));
    bad(blocks(tableBlock([["a", "b"]]))); // 2 cell > 1 列
    expect(validateDocDoc(blocks(tableBlock([["a"]]))).ok).toBe(true);
  });

  it("cell 拒（同族四形）：对象/undefined/NaN/Infinity/控制字符", () => {
    for (const v of [[{}], [[undefined]], [[NaN]], [[Infinity]]]) bad(blocks(tableBlock(v as unknown[][])));
    bad(blocks(tableBlock([["a\x07b"]])));
  });

  it("对照钉：cell 收/拒与 validateDocTable 逐值一致（两侧同规的机器证）", () => {
    const cells: unknown[] = ["ok", "", "a\tb", 0, 12.5, true, false, null, {}, [], NaN, Infinity, "a\x07b", "\x00", undefined, () => 1];
    for (const v of cells) {
      const x = validateDocTable({ columns: [{ header: "a" }], rows: [[v]] });
      const d = validateDocDoc(blocks(tableBlock([[v]])));
      expect(d.ok).toBe(x.ok);
    }
  });
});

describe("ω99-126 A — buildDocx 五部件与 document.xml 语义（读回断言）", () => {
  it("部件清单=5 件且顺序固定（styles 案 (a)：零样式引用 → 零 styles 部件 + 零 word/_rels）", () => {
    expect(readZip(docx()).map((f) => f.name)).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "docProps/core.xml",
      "docProps/app.xml",
      "word/document.xml",
    ]);
  });

  it("[Content_Types]：document override（wordprocessingml document.main）+ docProps 两件；零 styles override", () => {
    const ct = text(docx(), "[Content_Types].xml");
    expect(ct).toContain('<Default Extension="rels"');
    expect(ct).toContain('<Default Extension="xml"');
    expect(ct).toContain('PartName="/word/document.xml"');
    expect(ct).toContain("application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml");
    expect(ct).toContain('PartName="/docProps/core.xml"');
    expect(ct).toContain('PartName="/docProps/app.xml"');
    expect(ct).not.toContain("styles");
  });

  it("_rels/.rels 三角：officeDocument→word/document.xml + core + app", () => {
    const r = text(docx(), "_rels/.rels");
    expect(r).toContain('Id="rId1"');
    expect(r).toContain('Target="word/document.xml"');
    expect(r).toContain("relationships/officeDocument");
    expect(r).toContain('Target="docProps/core.xml"');
    expect(r).toContain('Target="docProps/app.xml"');
  });

  it("docProps：core 时间钉 2026-01-01T00:00:00Z（两处）；app=wudao-harness", () => {
    const core = text(docx(), "docProps/core.xml");
    expect(core.match(/2026-01-01T00:00:00Z/g)?.length).toBe(2);
    expect(text(docx(), "docProps/app.xml")).toContain("<Application>wudao-harness</Application>");
  });

  it("title：居中（w:jc center）+ sz 56（28pt）+ 加粗；CJK 原样", () => {
    const s = text(docx(), "word/document.xml");
    expect(s).toContain('<w:jc w:val="center"/>');
    expect(s).toContain('<w:sz w:val="56"/>');
    expect(s).toContain("季度盘点报告");
  });

  it("heading：sz 32（16pt）+ 加粗；只有 title 段居中（jc 恰 1 处；b 恰 4 处=title+heading+两表头）", () => {
    const s = text(docx(), "word/document.xml");
    expect(s).toContain('<w:sz w:val="32"/>');
    expect(s).toContain("一、总体情况");
    expect(s.match(/<w:jc w:val="center"\/>/g)?.length).toBe(1);
    expect(s.match(/<w:b\/>/g)?.length).toBe(4);
  });

  it("body：sz 21（10.5pt）无加粗；五实体转义", () => {
    const s = text(docx(), "word/document.xml");
    expect(s).toContain('<w:sz w:val="21"/>');
    expect(s).toContain("盘点 &amp; 汇总 &lt;三次&gt;");
  });

  it("bullet：'• ' 字符前缀 + w:ind left=360 缩进；零 numbering 引用（诚实非真列表）", () => {
    const s = text(docx(), "word/document.xml");
    expect(s).toContain('<w:ind w:left="360"/>');
    expect(s).toContain("• 第一条要点");
    expect(s).not.toContain("numPr");
    expect(s).not.toContain("numbering");
  });

  it("表格：首行 tblHeader + shd F2F2F2 + 表头加粗；gridCol 等分 9026；空 cell=空 w:p；数字/布尔文本形", () => {
    const s = text(docx(), "word/document.xml");
    expect(s).toContain("<w:tblHeader/>");
    expect(s).toContain('w:fill="F2F2F2"');
    expect(s).toContain('<w:gridCol w:w="4513"/><w:gridCol w:w="4513"/>'); // (11906-1440×2)/2
    expect(s).toContain("键盘 &amp; 鼠标");
    expect(s).toContain('<w:t xml:space="preserve">12</w:t>');
    expect(s).toContain('<w:t xml:space="preserve">true</w:t>');
    expect(s).toContain("<w:tc><w:p/></w:tc>"); // null/补齐 cell = 一个空 w:p（OOXML 硬规）
  });

  it("sectPr：A4 纵向 11906×16838 + pgMar 1440 四边，body 收尾", () => {
    const s = text(docx(), "word/document.xml");
    expect(s).toContain('<w:pgSz w:w="11906" w:h="16838"/>');
    expect(s).toContain('<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>');
    expect(s.endsWith("</w:sectPr></w:body></w:document>")).toBe(true);
  });

  it("字节确定性：同 doc 两次构建全等", () => {
    const a = docx();
    const b = docx();
    expect(a.length).toBe(b.length);
    // Buffer.equals（Node 自带）；Uint8Array 无 equals（Node 24 实况）。
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("缺省文件名：wudao-文档-YYYYMMDD-HHmmss.docx（本地时区 pad2）", () => {
    expect(defaultDocxFilename(new Date(2026, 8, 6, 9, 5, 7))).toBe("wudao-文档-20260906-090507.docx");
  });
});
