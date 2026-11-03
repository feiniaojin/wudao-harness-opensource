// ω99-222: #R1 — read_docx / read_pptx receipts（六层：解压层搬家零漂移 /
// docx 纯层 / pptx 纯层 / 窗口 / 工具面 / summarize）。RED-first。
// ★测试红线：夹具全内存（storedZip / deflateRawSync / buildDocx / buildPptx
// 造字节）或 os.tmpdir() 临时工作区；绝不碰用户真实文档；零 rm（tmpdir 只写
// 不删）；零真实键鼠/截屏（本弧不涉）。零第三方依赖（node:zlib 内建）。
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import type { Tool } from "@wudao-org/core";
// 写面反哺：storedZip/crc32 造夹具 + buildDocx/buildPptx roundtrip（读写的
// 同源互测是本弧的验收面之一——三件套读半边收口）。
import { storedZip, crc32 } from "../src/doc-zip.js";
import { buildDocx } from "../src/doc-docx.js";
import { buildPptx } from "../src/doc-pptx.js";
import {
  createReadDocxTool,
  parseDocxBlocks,
  summarizeDocxWindow,
  DOCX_DEFAULT_BLOCK_LIMIT,
  DOCX_MAX_BLOCK_LIMIT,
} from "../src/doc-docx-read.js";
import {
  createReadPptxTool,
  parsePptxSlides,
  summarizePptxWindow,
  PPTX_MAX_SLIDE_LIMIT,
} from "../src/doc-pptx-read.js";
// §1 搬家零漂移：新址（doc-zip.ts）与旧址 re-export（doc-xlsx-read.ts）同一函数。
import { unzipEntries as unzipFromZip } from "../src/doc-zip.js";
import { unzipEntries as unzipFromRead } from "../src/doc-xlsx-read.js";
import { summarizeToolCall } from "../src/log.js";
import { buildToolSet } from "../src/tools.js";
import { DEFAULT_ASK_TOOLS, READ_TOOLS, WORKSPACE_TOOLS, decidePermission } from "../src/permission.js";

const enc = new TextEncoder();
const XDECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

// ---------------------------------------------------------------------------
// 夹具工坊（全内存）
// ---------------------------------------------------------------------------

type Part = { name: string; data: Uint8Array };

const part = (name: string, xml: string): Part => ({ name, data: enc.encode(xml) });

/** 手搓单条目 zip（method/flags 可控——加密/Zip64 夹具的底座，221 同款）。 */
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

/** 多条目 method-8（deflate）zip——解压道真夹具（storedZip 只写 method 0）。 */
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

/** docx document.xml 夹具（body 原文注入——§2 直接控制每个形）。 */
const docXml = (body: string): string =>
  `${XDECL}<w:document xmlns:w="${NS_W}"><w:body>${body}<w:sectPr/></w:body></w:document>`;

/** 最小 docx zip（只有 word/document.xml——纯层/窗口夹具够用）。 */
const docxZip = (body: string): Uint8Array => storedZip([part("word/document.xml", docXml(body))]);

/** 段落夹具（run 内单 <w:t>）。 */
const p = (t: string): string => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;

/** 表格夹具：rows 每行 cells（字符串或 null=空段格）。 */
function tbl(rows: readonly (readonly (string | null)[])[]): string {
  return (
    `<w:tbl><w:tblGrid>${rows[0]?.map(() => "<w:gridCol/>").join("") ?? ""}</w:tblGrid>` +
    rows
      .map(
        (cells) =>
          `<w:tr>${cells.map((c) => `<w:tc><w:tcPr/><w:p>${c === null ? "" : `<w:r><w:t>${c}</w:t></w:r>`}</w:p></w:tc>`).join("")}</w:tr>`,
      ).join("") +
    "</w:tbl>"
  );
}

/** pptx 演示夹具：sldIdLst 顺序（rid 序）+ rels 映射 + 各张部件（编号任意）。 */
function pptxZip(
  slides: readonly { readonly rid: string; readonly target: string; readonly paragraphs: readonly string[] }[],
  extra: readonly Part[] = [],
): Uint8Array {
  const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
  return storedZip([
    part(
      "ppt/presentation.xml",
      `${XDECL}<p:presentation xmlns:p="${NS_P}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<p:sldIdLst>${slides.map((s, i) => `<p:sldId id="${256 + i}" r:id="${s.rid}"/>`).join("")}</p:sldIdLst></p:presentation>`,
    ),
    part(
      "ppt/_rels/presentation.xml.rels",
      `${XDECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        slides
          .map(
            (s) =>
              `<Relationship Id="${s.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="${s.target}"/>`,
          )
          .join("") +
        `</Relationships>`,
    ),
    ...slides.map((s) =>
      part(
        `ppt/${s.target.replace(/^\.\//, "")}`,
        `${XDECL}<p:sld xmlns:p="${NS_P}"><p:cSld><p:spTree>` +
          s.paragraphs.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join("") +
          `</p:spTree></p:cSld></p:sld>`,
      ),
    ),
    ...extra,
  ]);
}

// ---------------------------------------------------------------------------
// §1 解压层搬家零漂移（unzipEntries 移入 doc-zip.ts；行为逐字同）
// ---------------------------------------------------------------------------

describe("ω99-222 §1 — 解压层搬家零漂移", () => {
  it("re-export 同一函数：doc-xlsx-read.ts 的 unzipEntries 就是 doc-zip.ts 的（R1 连续性）", () => {
    expect(unzipFromRead).toBe(unzipFromZip);
  });

  it("stored 道：storedZip 产物从新址解出名与字节全等", () => {
    const bytes = storedZip([part("word/document.xml", "<doc/>"), part("[Content_Types].xml", "<Types 中文='是'/>")]);
    const r = unzipFromZip(bytes);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.map((e) => e.name)).toEqual(["word/document.xml", "[Content_Types].xml"]);
    expect(new TextDecoder().decode(r.entries[1]!.data)).toBe("<Types 中文='是'/>");
  });

  it("deflated 道：method 8 条目从新址 inflateRawSync 还原", () => {
    const payload = "第一段正文与第二段正文，含实体 &amp; 与中文。".repeat(10);
    const bytes = deflatedZip([part("word/document.xml", "<doc/>"), part("ppt/slides/slide1.xml", payload)]);
    const r = unzipFromZip(bytes);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(new TextDecoder().decode(r.entries[1]!.data)).toBe(payload);
  });

  it("加密旗（bit 0）拒：文案教出路（另存无密码副本）——搬家后逐字同", () => {
    const r = unzipFromZip(singleEntryZip(enc.encode("<doc/>"), "word/document.xml", 0, UTF8_FLAG | 0x0001));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("密码");
    expect(r.error).toContain("另存");
  });

  it("Zip64 标记拒：EOCD 条目数 0xFFFF 与中央目录偏移 0xFFFFFFFF 两形", () => {
    const a = singleEntryZip(enc.encode("<doc/>"), "word/document.xml", 0, UTF8_FLAG);
    const dvA = new DataView(a.buffer);
    dvA.setUint16(a.length - 22 + 10, 0xffff, true);
    expect(unzipFromZip(a).ok).toBe(false);
    const b = singleEntryZip(enc.encode("<doc/>"), "word/document.xml", 0, UTF8_FLAG);
    const dvB = new DataView(b.buffer);
    const cdOff = b.length - 22 - (46 + "word/document.xml".length);
    dvB.setUint32(cdOff + 42, 0xffffffff, true);
    const rb = unzipFromZip(b);
    expect(rb.ok).toBe(false);
    if (rb.ok) return;
    expect(rb.error).toContain("不支持");
  });

  it("坏 zip 拒：无 EOCD（随机字节）→ 同款用户语错误（零实现术语）", () => {
    const r = unzipFromZip(enc.encode("这不是一个 zip 文件，只是一段文本。"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("不是有效的 Excel"); // 搬家=逐字移：原 xlsx 文案原样保留（docx/pptx 面各自映射）
    for (const jargon of ["zip", "EOCD", "XML", "central"]) {
      expect(r.error.toLowerCase()).not.toContain(jargon.toLowerCase());
    }
  });
});

// ---------------------------------------------------------------------------
// §2 docx 纯层（run 拼接 / 表格 / 文档序块流 / 实体 / 自闭合 / 空段 / 嵌套压平）
// ---------------------------------------------------------------------------

describe("ω99-222 §2 — docx 纯层", () => {
  it("buildDocx 写面 roundtrip：五块形按文档序读回（title/heading/bullet→段落、table→表格）", () => {
    const bytes = buildDocx({
      blocks: [
        { kind: "title", text: "季度报告" },
        { kind: "heading", text: "一、概述" },
        { kind: "body", text: "本季度进展顺利。" },
        { kind: "bullet", text: "第一条要点" },
        {
          kind: "table",
          columns: [{ header: "名称" }, { header: "数量" }],
          rows: [["键盘", 12], ["鼠标", null]],
        },
      ],
    });
    const xml = new TextDecoder().decode(
      unzipFromZip(bytes).ok ? (unzipFromZip(bytes) as { entries: readonly { name: string; data: Uint8Array }[] }).entries.find((e) => e.name === "word/document.xml")!.data : new Uint8Array(),
    );
    const blocks = parseDocxBlocks(xml);
    expect(blocks).toHaveLength(5);
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "paragraph", "paragraph", "paragraph", "table"]);
    expect(blocks[0]).toMatchObject({ kind: "paragraph", text: "季度报告" });
    expect(blocks[3]).toMatchObject({ kind: "paragraph", text: "• 第一条要点" }); // 写面 v1 的 "• " 前缀照读
    const table = blocks[4]!;
    expect(table.kind).toBe("table");
    if (table.kind !== "table") return;
    expect(table.index).toBe(1);
    expect(table.rows).toEqual([["名称", "数量"], ["键盘", "12"], ["鼠标", ""]]); // null 格=空段格
  });

  it("run 拼接：一段多 run 的 <w:t> 顺序拼接；<w:br/>/<w:tab/> 折成空格不粘字", () => {
    const blocks = parseDocxBlocks(
      docXml(
        `<w:p><w:r><w:t>今天</w:t></w:r><w:r><w:t>天气</w:t></w:r></w:p>` +
          `<w:p><w:r><w:t>第一行</w:t><w:br/><w:t>第二行</w:t></w:r></w:p>` +
          `<w:p><w:r><w:t>左</w:t><w:tab/><w:t>右</w:t></w:r></w:p>`,
      ),
    );
    expect(blocks[0]).toMatchObject({ kind: "paragraph", text: "今天天气" });
    expect(blocks[1]).toMatchObject({ kind: "paragraph", text: "第一行 第二行" });
    expect(blocks[2]).toMatchObject({ kind: "paragraph", text: "左 右" });
  });

  it("表格行列→TSV 行：格内多段落空格相连；表序号文档序递增", () => {
    const blocks = parseDocxBlocks(
      docXml(
        p("表前") +
          tbl([["h1", "h2"], ["两段一 两段二", null]]) +
          tbl([["只有一格"]]),
      ),
    );
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "table", "table"]);
    const t1 = blocks[1]!;
    if (t1.kind !== "table") return;
    expect(t1.index).toBe(1);
    expect(t1.rows).toEqual([["h1", "h2"], ["两段一 两段二", ""]]);
    const t2 = blocks[2]!;
    if (t2.kind !== "table") return;
    expect(t2.index).toBe(2);
    expect(t2.rows).toEqual([["只有一格"]]);
  });

  it("嵌套表格压平：内层表格文本并入外层所在格（v1 压平纪律，如实记）", () => {
    const nested =
      `<w:tbl><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid>` +
      `<w:tr>` +
      `<w:tc><w:p><w:r><w:t>外层格</w:t></w:r></w:p>` +
      `<w:tbl><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>内层格</w:t></w:r></w:p></w:tc></w:tr></w:tbl>` +
      `</w:tc>` +
      `<w:tc><w:p><w:r><w:t>旁边格</w:t></w:r></w:p></w:tc>` +
      `</w:tr></w:tbl>`;
    const blocks = parseDocxBlocks(docXml(nested));
    expect(blocks).toHaveLength(1); // 内层不另起块（压平）
    const t = blocks[0]!;
    if (t.kind !== "table") return;
    expect(t.rows).toHaveLength(1); // 内层行不外溢
    expect(t.rows[0]![0]).toBe("外层格 内层格"); // 内层文本并入所在格
    expect(t.rows[0]![1]).toBe("旁边格");
  });

  it("实体解码：五个命名实体 + 十进制/十六进制数字实体", () => {
    const blocks = parseDocxBlocks(docXml(p("&amp;&lt;&gt;&quot;&apos;&#20013;&#x4E01;")));
    expect(blocks[0]).toMatchObject({ kind: "paragraph", text: `&<>"'中丁` });
  });

  it("自闭合非贪婪：<w:p/> 空段成块；<w:t/> 贡献空串；<w:pPr> 不误当段", () => {
    const blocks = parseDocxBlocks(
      docXml(`<w:p/><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t/></w:r></w:p><w:p><w:r><w:t>尾</w:t></w:r></w:p>`),
    );
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ kind: "paragraph", text: "" }); // 空段保留（文档序忠实）
    expect(blocks[1]).toMatchObject({ kind: "paragraph", text: "" }); // 只有 pPr 与自闭合 t
    expect(blocks[2]).toMatchObject({ kind: "paragraph", text: "尾" });
  });

  it("文档序线性化：段与表交错照序（p → tbl → p）", () => {
    const blocks = parseDocxBlocks(docXml(p("一") + tbl([["a"]]) + p("二")));
    expect(blocks.map((b) => (b.kind === "table" ? `表${b.index}` : b.text))).toEqual(["一", "表1", "二"]);
  });
});

// ---------------------------------------------------------------------------
// §3 pptx 纯层（sldIdLst 顺序 ≠ 编号 / rels 映射 / 段落行 / run 拼接）
// ---------------------------------------------------------------------------

describe("ω99-222 §3 — pptx 纯层", () => {
  it("buildPptx 写面 roundtrip：三版式页的段落按序读回（cover/bullets/table）", () => {
    const bytes = buildPptx({
      slides: [
        { kind: "cover", title: "路演标题", subtitle: "副标题" },
        { kind: "bullets", title: "要点页", bullets: ["要点一", "要点二"] },
        { kind: "table", title: "数据页", columns: [{ header: "A" }, { header: "B" }], rows: [["x", null]] },
      ],
    });
    const r = parsePptxSlides(bytes);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.slides).toHaveLength(3);
    expect(r.slides[0]!.paragraphs).toEqual(["路演标题", "副标题"]);
    expect(r.slides[1]!.paragraphs).toEqual(["要点页", "要点一", "要点二"]);
    // 表格页：标题 + 格内段落按文档序照读（标题/正文不区分占位符——v1 边界）；
    // null 格是空段，空段剔除。
    expect(r.slides[2]!.paragraphs).toEqual(["数据页", "A", "B", "x"]);
  });

  it("sldIdLst 顺序 ≠ 编号：slide9.xml 在前、slide2.xml 在后——名序说了算", () => {
    const r = parsePptxSlides(
      pptxZip([
        { rid: "rId7", target: "slides/slide9.xml", paragraphs: ["第一张（部件 slide9）"] },
        { rid: "rId2", target: "slides/slide2.xml", paragraphs: ["第二张（部件 slide2）"] },
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.slides.map((s) => s.paragraphs[0])).toEqual(["第一张（部件 slide9）", "第二张（部件 slide2）"]);
  });

  it("rels 绝对 target 形（/ppt/slides/slide3.xml）也解析得到", () => {
    const r = parsePptxSlides(
      storedZip([
        part(
          "ppt/presentation.xml",
          `${XDECL}<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
        ),
        part(
          "ppt/_rels/presentation.xml.rels",
          `${XDECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="/ppt/slides/slide3.xml"/></Relationships>`,
        ),
        part("ppt/slides/slide3.xml", `${XDECL}<p:sld><a:p><a:r><a:t>绝对路径张</a:t></a:r></a:p></p:sld>`),
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.slides[0]!.paragraphs).toEqual(["绝对路径张"]);
  });

  it("run 拼接与 <a:br/>：一段多 run 拼接、换行折空格；空段剔除不算行", () => {
    const r = parsePptxSlides(
      pptxZip([
        {
          rid: "rId1",
          target: "slides/slide1.xml",
          paragraphs: [], // 占位——下面直接手写 slide XML
        },
      ]),
    );
    expect(r.ok); // 最小形可解
    // 手写完整 slide：多 run + br + 空段。
    const hand = storedZip([
      part(
        "ppt/presentation.xml",
        `${XDECL}<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
      ),
      part(
        "ppt/_rels/presentation.xml.rels",
        `${XDECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`,
      ),
      part(
        "ppt/slides/slide1.xml",
        `${XDECL}<p:sld><p:cSld><p:spTree>` +
          `<a:p><a:r><a:t>多run</a:t></a:r><a:r><a:t>拼接</a:t></a:r></a:p>` +
          `<a:p><a:r><a:t>上行</a:t></a:r><a:br/><a:r><a:t>下行</a:t></a:r></a:p>` +
          `<a:p><a:pPr algn="ctr"/></a:p>` +
          `<a:p><a:r><a:t>尾段</a:t></a:r></a:p>` +
          `</p:spTree></p:cSld></p:sld>`,
      ),
    ]);
    const parsed = parsePptxSlides(hand);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.slides[0]!.paragraphs).toEqual(["多run拼接", "上行 下行", "尾段"]); // 空段剔除
  });

  it("引用缺失张（rels 指向不存在的部件）→ typed 拒（含第几张）", () => {
    const r = parsePptxSlides(
      storedZip([
        part(
          "ppt/presentation.xml",
          `${XDECL}<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
        ),
        part(
          "ppt/_rels/presentation.xml.rels",
          `${XDECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide404.xml"/></Relationships>`,
        ),
      ]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("第 1 张");
  });

  it("空演示（无 sldIdLst 条目）→ typed 拒", () => {
    const r = parsePptxSlides(
      storedZip([
        part(
          "ppt/presentation.xml",
          `${XDECL}<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst></p:sldIdLst></p:presentation>`,
        ),
      ]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("没有找到任何幻灯片");
  });
});

// ---------------------------------------------------------------------------
// §4 窗口（docx 块窗默认 100 / pptx 张窗默认全部 / 硬帽 / 越界拒 / 截断通知）
// ---------------------------------------------------------------------------

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "o222-doc-"));
});

const exec = async (tool: Tool, args: Record<string, unknown>) => tool.execute(args);
const docxTool = () => createReadDocxTool(ws);
const pptxTool = () => createReadPptxTool(ws);

describe("ω99-222 §4 — 窗口与输出格式", () => {
  it("docx 默认 100 块：150 段文档读前 100，名录+分隔+截断通知三件齐", async () => {
    const blocks = Array.from({ length: 150 }, (_, i) => ({ kind: "body", text: `第${i + 1}段正文` }));
    await writeFile(join(ws, "报告.docx"), buildDocx({ blocks }));
    const r = await exec(docxTool(), { path: "报告.docx" });
    expect(r.isError).toBeFalsy();
    const lines = (r.content as string).split("\n");
    expect(lines[0]).toBe("文档：报告.docx（150 段 · 0 表）");
    expect(lines[1]).toBe("── 第 1–100 块（共 150 块）──");
    expect(lines[2]).toBe("第1段正文");
    expect(lines[101]).toBe("第100段正文");
    expect(lines).toHaveLength(2 + 100 + 1); // 名录+分隔+100 段行+通知
    expect(lines[102]).toContain("已截断");
    expect(lines[102]).toContain("offset=101");
    for (const jargon of ["zip", "XML", "EOCD", "inflate"]) {
      expect(r.content.toLowerCase()).not.toContain(jargon.toLowerCase());
    }
  });

  it("docx offset/limit 翻页：offset=101 limit=50 → 第 101–150 块恰读满，无截断通知", async () => {
    const blocks = Array.from({ length: 150 }, (_, i) => ({ kind: "body", text: `段${i + 1}` }));
    await writeFile(join(ws, "长文.docx"), buildDocx({ blocks }));
    const r = await exec(docxTool(), { path: "长文.docx", offset: 101, limit: 50 });
    expect(r.isError).toBeFalsy();
    const lines = (r.content as string).split("\n");
    expect(lines[1]).toBe("── 第 101–150 块（共 150 块）──");
    expect(lines[2]).toBe("段101");
    expect(lines[51]).toBe("段150");
    expect(lines).toHaveLength(2 + 50); // 尾行即数据尾——读到文尾无通知
  });

  it("docx limit 硬帽 1000：1200 段手搓文档要 5000 只读 1000（千分位如实）", async () => {
    await writeFile(join(ws, "超长.docx"), docxZip(Array.from({ length: 1200 }, (_, i) => p(`s${i + 1}`)).join("")));
    const r = await exec(docxTool(), { path: "超长.docx", limit: 5000 });
    expect(r.isError).toBeFalsy();
    const lines = (r.content as string).split("\n");
    expect(lines[0]).toBe("文档：超长.docx（1,200 段 · 0 表）");
    expect(lines[1]).toBe("── 第 1–1,000 块（共 1,200 块）──");
    expect(lines).toHaveLength(2 + 1000 + 1);
    expect(lines[1002]).toContain("offset=1,001");
  });

  it("docx offset 越界 → typed 拒（错误给总块数，模型可自修）", async () => {
    await writeFile(join(ws, "短.docx"), buildDocx({ blocks: [{ kind: "body", text: "唯一一段" }] }));
    const r = await exec(docxTool(), { path: "短.docx", offset: 99 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("超出");
    expect(r.content).toContain("共 1 块");
  });

  it("pptx 默认全部：12 张 deck 全读，名录+张头+缩进段落行，无截断通知", async () => {
    const slides = Array.from({ length: 12 }, (_, i) =>
      i === 0 ? { kind: "cover", title: `封面${i + 1}` } : { kind: "bullets" as const, title: `页${i + 1}`, bullets: [`要点${i + 1}`] },
    );
    await writeFile(join(ws, "路演.pptx"), buildPptx({ slides }));
    const r = await exec(pptxTool(), { path: "路演.pptx" });
    expect(r.isError).toBeFalsy();
    const lines = (r.content as string).split("\n");
    expect(lines[0]).toBe("演示：路演.pptx（12 张）");
    expect(lines[1]).toBe("第 1 张");
    expect(lines[2]).toBe("  封面1"); // 段落行缩进两格
    expect(lines[3]).toBe("第 2 张");
    expect(lines[4]).toBe("  页2");
    expect(lines[5]).toBe("  要点2");
    expect(lines.filter((l) => l.startsWith("第 "))).toHaveLength(12);
    expect(lines.some((l) => l.includes("已截断"))).toBe(false);
  });

  it("pptx 硬帽 100 张：101 张手搓 deck 缺省读前 100 并通知；limit=500 钳到 100", async () => {
    const slides = Array.from({ length: 101 }, (_, i) => ({ rid: `rId${i + 1}`, target: `slides/slide${i + 1}.xml`, paragraphs: [`第${i + 1}张文本`] }));
    await writeFile(join(ws, "大deck.pptx"), pptxZip(slides));
    const r = await exec(pptxTool(), { path: "大deck.pptx" });
    expect(r.isError).toBeFalsy();
    const lines = (r.content as string).split("\n");
    expect(lines[0]).toBe("演示：大deck.pptx（101 张）");
    expect(lines.filter((l) => l.startsWith("第 "))).toHaveLength(100);
    expect(lines[lines.length - 1]).toContain("已截断");
    expect(lines[lines.length - 1]).toContain("offset=101");
    const clamped = await exec(pptxTool(), { path: "大deck.pptx", limit: 500 });
    expect(clamped.isError).toBeFalsy();
    expect((clamped.content as string).split("\n").filter((l) => l.startsWith("第 "))).toHaveLength(100); // 钳到帽
  });

  it("pptx offset/limit 张窗：offset=3 limit=2 → 第 3–4 张；空张显「（无文本）」；后有张未读则通知", async () => {
    const slides = [
      { rid: "rId1", target: "slides/slide1.xml", paragraphs: ["a"] },
      { rid: "rId2", target: "slides/slide2.xml", paragraphs: ["b"] },
      { rid: "rId3", target: "slides/slide3.xml", paragraphs: ["c1", "c2"] },
      { rid: "rId4", target: "slides/slide4.xml", paragraphs: [] }, // 无文本张
      { rid: "rId5", target: "slides/slide5.xml", paragraphs: ["e"] },
    ];
    await writeFile(join(ws, "窗.pptx"), pptxZip(slides));
    const r = await exec(pptxTool(), { path: "窗.pptx", offset: 3, limit: 2 });
    expect(r.isError).toBeFalsy();
    const lines = (r.content as string).split("\n");
    expect(lines[0]).toBe("演示：窗.pptx（5 张）");
    expect(lines[1]).toBe("第 3 张");
    expect(lines[2]).toBe("  c1");
    expect(lines[3]).toBe("  c2");
    expect(lines[4]).toBe("第 4 张");
    expect(lines[5]).toBe("  （无文本）");
    expect(lines[6]).toContain("已截断"); // 3–4 窗未盖住第 5 张——通知教翻页
    expect(lines[6]).toContain("offset=5");
    // 读到文尾的窗（offset=4 limit=2 → 4–5）无通知。
    const tail = await exec(pptxTool(), { path: "窗.pptx", offset: 4, limit: 2 });
    expect(tail.isError).toBeFalsy();
    expect((tail.content as string).split("\n")).toHaveLength(5); // 名录+第4张2行+第5张2行
  });

  it("pptx offset 越界 → typed 拒（错误给总张数）", async () => {
    await writeFile(join(ws, "小.pptx"), buildPptx({ slides: [{ kind: "cover", title: "唯一一页" }] }));
    const r = await exec(pptxTool(), { path: "小.pptx", offset: 9 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("超出");
    expect(r.content).toContain("共 1 张");
  });
});

// ---------------------------------------------------------------------------
// §5 工具面（typed 校验先于盘副作用 / 越界拒 / 姿态 / READ_TOOLS / 魔数 / 挂载）
// ---------------------------------------------------------------------------

describe("ω99-222 §5 — 工具面与挂载", () => {
  it("typed 校验先于盘副作用：坏 offset + 不存在的路径 → 报 offset 不报文件不存在", async () => {
    const r = await exec(docxTool(), { path: "不存在.docx", offset: 0 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("offset");
    expect(r.content).not.toContain("文件不存在");
    const t = await exec(pptxTool(), { path: "不存在.pptx", limit: 1.5 });
    expect(t.isError).toBe(true);
    expect(t.content).toContain("limit");
    expect(t.content).not.toContain("文件不存在");
  });

  it("workspace 越界拒：../ 与绝对路径 typed 拒（两工具同形）", async () => {
    await writeFile(join(ws, "内.docx"), buildDocx({ blocks: [{ kind: "body", text: "x" }] }));
    for (const bad of ["../外逃.docx", "/tmp/o222-abs-evil.docx"]) {
      const r = await exec(docxTool(), { path: bad });
      expect(r.isError).toBe(true);
      expect(r.content).toContain("escapes workspace");
    }
    const t = await exec(pptxTool(), { path: "../外逃.pptx" });
    expect(t.isError).toBe(true);
    expect(t.content).toContain("escapes workspace");
  });

  it("文件不存在 → typed 拒（含路径回显）", async () => {
    const r = await exec(docxTool(), { path: "没有这个.docx" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("文件不存在");
    expect(r.content).toContain("没有这个.docx");
    const t = await exec(pptxTool(), { path: "没有这个.pptx" });
    expect(t.isError).toBe(true);
    expect(t.content).toContain("文件不存在");
  });

  it("姿态四布尔钉：只读 / 并发安全 / 非破坏 / 非开放世界（两工具与 make_* 写面逐项相反）", () => {
    for (const t of [createReadDocxTool("/tmp/ws"), createReadPptxTool("/tmp/ws")]) {
      expect(t.isReadOnly?.({})).toBe(true);
      expect(t.isConcurrencySafe?.({})).toBe(true);
      expect(t.isDestructive?.({})).toBe(false);
      expect(t.isOpenWorld?.({})).toBe(false);
      expect(t.shouldDefer?.()).toBeFalsy(); // 读面不进 defer 候选
    }
  });

  it("READ_TOOLS 读域钉（221 fix1 裁定沿用）：两名都进——workspace/plan 放行、ask 仍问、auto 放行；ask 集不含", () => {
    for (const name of ["read_docx", "read_pptx"]) {
      expect(READ_TOOLS.has(name)).toBe(true);
      expect(WORKSPACE_TOOLS.has(name)).toBe(true);
      expect(DEFAULT_ASK_TOOLS.has(name)).toBe(false); // 读类不是全档问的动作类
      expect(decidePermission("workspace", name)).toEqual({ behavior: "allow" });
      expect(decidePermission("plan", name)).toEqual({ behavior: "allow" }); // plan 只读栅栏放行
      expect(decidePermission("ask", name)).toBe("ask"); // 0.3.12：ask 档每个工具都问
      expect(decidePermission("auto", name)).toEqual({ behavior: "allow" });
    }
  });

  it("魔数三态：OLE → 教出路的文案；非 zip 文本 → 拒；合法文件 → 读到", async () => {
    const ole = new Uint8Array(512);
    ole.set([0xd0, 0xcf, 0x11, 0xe0], 0);
    await writeFile(join(ws, "旧版.doc"), ole);
    await writeFile(join(ws, "旧版.ppt"), ole);
    const d = await exec(docxTool(), { path: "旧版.doc" });
    expect(d.isError).toBe(true);
    expect(d.content).toContain("旧版 .doc 格式");
    expect(d.content).toContain("另存为");
    const pp = await exec(pptxTool(), { path: "旧版.ppt" });
    expect(pp.isError).toBe(true);
    expect(pp.content).toContain("旧版 .ppt 格式");
    expect(pp.content).toContain("另存为");
    await writeFile(join(ws, "文本.txt"), enc.encode("只是文本，不是文档"));
    const badDocx = await exec(docxTool(), { path: "文本.txt" });
    expect(badDocx.isError).toBe(true);
    expect(badDocx.content).toContain("不是 Word");
    const badPptx = await exec(pptxTool(), { path: "文本.txt" });
    expect(badPptx.isError).toBe(true);
    expect(badPptx.content).toContain("不是演示文稿");
  });

  it("挂载位钉（零配置）：read_xlsx+1=read_docx、read_docx+1=read_pptx、read_pptx+1=append_docx", () => {
    const stubModel = { stream: async function* () { /* never invoked */ } } as unknown as never;
    const gate = async (): Promise<{ behavior: "allow" }> => ({ behavior: "allow" });
    const names = buildToolSet({ workspaceRoot: "/tmp/ws", model: stubModel, canUseTool: gate, contextWindowTokens: 64_000 }).map((t) => t.name);
    expect(names).toContain("read_docx");
    expect(names).toContain("read_pptx");
    expect(names[names.indexOf("read_xlsx") + 1]).toBe("read_docx");
    expect(names[names.indexOf("read_docx") + 1]).toBe("read_pptx");
    // ω99-223 演进——append_docx/append_pptx 插在 read_pptx 之后、task 之前
    // （Word/PPT 追加面，append-only 尾）：read_pptx 的链尾改钉 append_docx
    // （与 223 R1 的挂载钉互证；solo 同跑）。
    expect(names[names.indexOf("read_pptx") + 1]).toBe("append_docx");
  });

  it("描述=用户收益词汇：教「帮我看下这个 Word/PPT 写了什么」场景，零实现术语", () => {
    for (const t of [createReadDocxTool("/tmp/ws"), createReadPptxTool("/tmp/ws")]) {
      for (const jargon of ["zip", "XML", "EOCD", "inflate", "unzipEntries", "buildTool", "sldIdLst"]) {
        expect(t.description.toLowerCase()).not.toContain(jargon.toLowerCase());
      }
    }
    expect(createReadDocxTool("/tmp/ws").description).toContain("帮我看下");
    expect(createReadPptxTool("/tmp/ws").description).toContain("帮我看下");
  });
});

// ---------------------------------------------------------------------------
// §6 summarize（两例 + 老例零漂移）
// ---------------------------------------------------------------------------

describe("ω99-222 §6 — summarize", () => {
  it("read_docx 一例：文件尾名+块窗口；缺省形与显形都对", () => {
    expect(summarizeDocxWindow({ path: "docs/报告.docx", offset: 101, limit: 100 })).toBe("报告.docx 第 101–200 块");
    expect(summarizeDocxWindow({ path: "报告.docx" })).toBe("报告.docx 第 1–100 块");
    expect(summarizeDocxWindow({})).toBe("第 1–100 块"); // 无 path 的最小形
    expect(summarizeToolCall("read_docx", { path: "报告.docx" })).toBe("报告.docx 第 1–100 块");
  });

  it("read_pptx 一例：文件尾名+张窗口（缺省=全部，总量在结果里不可达——不编造）", () => {
    expect(summarizePptxWindow({ path: "路演.pptx", offset: 1, limit: 12 })).toBe("路演.pptx 第 1–12 张");
    expect(summarizePptxWindow({ path: "路演.pptx", limit: 12 })).toBe("路演.pptx 第 1–12 张");
    expect(summarizePptxWindow({ path: "路演.pptx", offset: 5 })).toBe("路演.pptx 第 5 张起");
    expect(summarizePptxWindow({ path: "路演.pptx" })).toBe("路演.pptx"); // 缺省全部：总量不可知，只报名
    expect(summarizeToolCall("read_pptx", { path: "路演.pptx", limit: 12 })).toBe("路演.pptx 第 1–12 张");
  });

  it("老例零漂移：read_xlsx 与 computer/read_file/shell/unknown 的 summary 不动", () => {
    expect(summarizeToolCall("read_xlsx", { path: "订单.xlsx", sheet: "销售明细" })).toBe("订单.xlsx 「销售明细」 第 1–100 行");
    expect(summarizeToolCall("shell", { command: "ls" })).toBe("ls");
    expect(summarizeToolCall("read_file", { path: "a.ts" })).toBe("a.ts");
    expect(summarizeToolCall("computer_click", { x: 3, y: 4 })).toBe("(3, 4)");
    expect(summarizeToolCall("screen_capture", {})).toBe("全屏");
    expect(summarizeToolCall("zzz", { x: 1 })).toBe("");
  });
});

// 常量钉（窗口纪律的单一事实源：docx 块窗缺省 100 / 硬帽 1000；pptx 张帽 100）。
describe("ω99-222 附录 — 窗口常量", () => {
  it("docx 缺省 100 块、硬帽 1000 块；pptx 张帽 100", () => {
    expect(DOCX_DEFAULT_BLOCK_LIMIT).toBe(100);
    expect(DOCX_MAX_BLOCK_LIMIT).toBe(1000);
    expect(PPTX_MAX_SLIDE_LIMIT).toBe(100);
  });
});
