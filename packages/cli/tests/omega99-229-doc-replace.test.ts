// ω99-229: #R1 — replace_docx / replace_pptx receipts（七层：节点扫 / count-
// replace / 跨 run 检测 / docx 整包 / pptx 多张 / 工具面 / summarize）。RED-first。
// ★测试红线（09-09 用户令）：夹具全内存（buildDocx/buildPptx 造真 .docx/.pptx
// 字节→replace→读回）或 os.tmpdir() 临时工作区**只写不删**；绝不删用户文件/
// 文件夹；零 rm/unlink；零第三方依赖（node 内建）；零子进程。读写互证：replace
// 完用 222 的 parseDocxDocument / parsePptxSlides 读回（自家读面验自家写面
// ——收据的「已替换 N 处」互证层也从读回来，不数 XML）。
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@wudao/core";
// 写面（夹具底座：buildDocx / buildPptx 造真字节）。
import { buildDocx } from "../src/doc-docx.js";
import { buildPptx } from "../src/doc-pptx.js";
// 读面（读写互证）。
import { parseDocxDocument } from "../src/doc-docx-read.js";
import { parsePptxSlides } from "../src/doc-pptx-read.js";
// 本弧改写面。
import {
  scanTextNodes,
  countAndReplace,
  detectSpansRuns,
  replaceDocxText,
  replacePptxText,
  validateDocReplace,
  createReplaceDocxTool,
  createReplacePptxTool,
  summarizeReplaceDocx,
  summarizeReplacePptx,
} from "../src/doc-replace.js";
// zip 地基 + 消费面。
import { storedZip, unzipEntries } from "../src/doc-zip.js";
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

/** parseDocxDocument 的窄化帮手（读写互证断言前的夹具层）。 */
function mustParseDocx(bytes: Uint8Array) {
  const parsed = parseDocxDocument(bytes);
  if (!parsed.ok) throw new Error(`fixture parse failed: ${parsed.error}`);
  return parsed.doc;
}

/** parsePptxSlides 的窄化帮手。 */
function mustParsePptx(bytes: Uint8Array) {
  const parsed = parsePptxSlides(bytes);
  if (!parsed.ok) throw new Error(`fixture parse failed: ${parsed.error}`);
  return parsed.slides;
}

/** docx 块流 → 文本清单（段落一行、表格格各一项——互证层断言的粒度）。 */
function docxTexts(bytes: Uint8Array): string[] {
  const out: string[] = [];
  for (const b of mustParseDocx(bytes).blocks) {
    if (b.kind === "paragraph") out.push(b.text);
    else for (const row of b.rows) out.push(...row);
  }
  return out;
}

/** 手工 docx（最小结构：只要 word/document.xml 在，replace 的门就放行）。 */
function handDocx(documentXml: string): Uint8Array {
  return storedZip([{ name: "word/document.xml", data: enc.encode(documentXml) }]);
}

/** 一份含命中与不命中的标准 docx 夹具（四段，两段含 find、一段含两次）。 */
function sampleDocx(): Uint8Array {
  return buildDocx({
    blocks: [
      { kind: "title", text: "旧公司年度报告" },
      { kind: "body", text: "本报告由旧公司编写。" },
      { kind: "body", text: "与关键词无关的一段。" },
      { kind: "bullet", text: "旧公司 旧公司 两处" },
    ],
  });
}

/** 一份三页 pptx 夹具（封面 + 要点 + 表格页，两页含 find）。 */
function samplePptx(): Uint8Array {
  return buildPptx({
    slides: [
      { kind: "cover", title: "旧公司年报", subtitle: "2026" },
      { kind: "bullets", title: "业绩概览", bullets: ["旧公司增长稳健", "现金流为正"] },
      { kind: "table", title: "明细", columns: [{ header: "指标" }, { header: "数值" }], rows: [["收入", "100"]] },
    ],
  });
}

// ---------------------------------------------------------------------------
// §1 纯层 — scanTextNodes（开闭对扫描；属性形收；自闭合略过）
// ---------------------------------------------------------------------------

describe("ω99-229 §1 scanTextNodes", () => {
  it("开闭对扫描：多节点、属性形收、自闭合略过、text=unescape 后", () => {
    const xml = `<w:t>a</w:t><w:t/><w:t xml:space="preserve">b</w:t><w:t>c &amp; d</w:t>`;
    const nodes = scanTextNodes(xml, "w:t");
    expect(nodes.map((n) => n.text)).toEqual(["a", "b", "c & d"]);
    expect(nodes[0]!.raw).toBe("a");
    expect(nodes[2]!.raw).toBe("c &amp; d");
    expect(nodes[1]!.openTag).toBe(`<w:t xml:space="preserve">`);
  });

  it("pptx 同缝：a:t 节点清单（223/228 单文件承载一族纪律）", () => {
    const nodes = scanTextNodes(`<a:t>标题</a:t><a:t></a:t><a:t>正文</a:t>`, "a:t");
    expect(nodes.map((n) => n.text)).toEqual(["标题", "", "正文"]);
  });
});

// ---------------------------------------------------------------------------
// §2 纯层 — countAndReplace（先扫后改单趟；全局帽；实体往返；preserve）
// ---------------------------------------------------------------------------

describe("ω99-229 §2 countAndReplace", () => {
  it("单节点命中：只动节点内文本，run/段落属性零触碰", () => {
    const xml = `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="21"/></w:rPr><w:t>旧公司很好</w:t></w:r></w:p>`;
    const r = countAndReplace(xml, "w:t", "旧公司", "新公司", 50);
    expect(r.overLimit).toBe(false);
    if (!r.overLimit) {
      expect(r.replaced).toBe(1);
      expect(r.newXml).toBe(`<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="21"/></w:rPr><w:t>新公司很好</w:t></w:r></w:p>`);
    }
  });

  it("节点内多次命中 + 多节点各自命中", () => {
    const xml = `<w:t>旧旧旧</w:t><w:t>无</w:t><w:t>旧</w:t>`;
    const r = countAndReplace(xml, "w:t", "旧", "新", 50);
    expect(r.overLimit).toBe(false);
    if (!r.overLimit) {
      expect(r.replaced).toBe(4);
      expect(r.newXml).toBe(`<w:t>新新新</w:t><w:t>无</w:t><w:t>新</w:t>`);
    }
  });

  it("实体往返：find 或 replace 含 & < > \" ' 时节点内命中仍准（比较前 unescape、写回前 escape）", () => {
    // find 含实体源字符：raw 里的 &amp; 在 unescape 后参与比较。
    const a = countAndReplace(`<w:t>A &amp; B</w:t>`, "w:t", "A & B", "X", 50);
    expect(a.overLimit).toBe(false);
    if (!a.overLimit) expect(a.newXml).toBe(`<w:t>X</w:t>`);
    // replace 含特殊字符：写回时重新转义（五实体全查）。
    const b = countAndReplace(`<w:t>拿 <a> 与 &</w:t>`, "w:t", "<a>", `"<b>"&'`, 50);
    expect(b.overLimit).toBe(false);
    if (!b.overLimit) expect(b.newXml).toBe(`<w:t>拿 &quot;&lt;b&gt;&quot;&amp;&apos; 与 &amp;</w:t>`);
    // 未命中区域的既有实体保持转义形。
    const c = countAndReplace(`<w:t>x &lt; y 与 旧</w:t>`, "w:t", "旧", "新", 50);
    expect(c.overLimit).toBe(false);
    if (!c.overLimit) expect(c.newXml).toBe(`<w:t>x &lt; y 与 新</w:t>`);
  });

  it("xml:space=\"preserve\" 保真：既有属性保持；空串替换结果必带", () => {
    const keep = countAndReplace(`<w:t xml:space="preserve">旧 好</w:t>`, "w:t", "旧", "新", 50);
    expect(keep.overLimit).toBe(false);
    if (!keep.overLimit) expect(keep.newXml).toBe(`<w:t xml:space="preserve">新 好</w:t>`);
    // 删除（replace=""）后节点文本为空：空节点保留 + preserve 补齐。
    const empty = countAndReplace(`<w:t>删除我</w:t>`, "w:t", "删除我", "", 50);
    expect(empty.overLimit).toBe(false);
    if (!empty.overLimit) {
      expect(empty.newXml).toBe(`<w:t xml:space="preserve"></w:t>`);
      expect(empty.newXml).not.toContain(`/>`); // 空节点不塌成自闭合（读面同形容忍）
    }
  });

  it("maxCount 边界：恰=过；超=拒且点名总数、xml 零改动", () => {
    const xml = `<w:t>旧旧旧</w:t>`;
    const edge = countAndReplace(xml, "w:t", "旧", "新", 3);
    expect(edge.overLimit).toBe(false);
    if (!edge.overLimit) expect(edge.replaced).toBe(3);
    const over = countAndReplace(xml, "w:t", "旧", "新", 2);
    expect(over.overLimit).toBe(true);
    if (over.overLimit) expect(over.total).toBe(3);
  });

  it("find 不在场：replaced 0（不报错——在场性判定归调用方）", () => {
    const r = countAndReplace(`<w:t>无关</w:t>`, "w:t", "旧", "新", 50);
    expect(r.overLimit).toBe(false);
    if (!r.overLimit) expect(r.replaced).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §3 纯层 — detectSpansRuns（跨 run 检测：段落拼接纪律同读面）
// ---------------------------------------------------------------------------

describe("ω99-229 §3 detectSpansRuns", () => {
  it("跨 run 拒的证据：find 骑 <w:r> 边界 → 段落序（文档序 1 起）+ 拼接预览", () => {
    const xml =
      `<w:p><w:r><w:t>第一段引言</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>介绍</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>旧公</w:t></w:r><w:r><w:t>司</w:t></w:r></w:p>`;
    const spans = detectSpansRuns(xml, "旧公司", "w:p", "w:t");
    expect(spans.length).toBe(1);
    expect(spans[0]!.paragraphIndex).toBe(2);
    expect(spans[0]!.preview).toBe("介绍旧公司");
  });

  it("不跨 run 的在场与不在场：段落全拼接不含 find → 空清单", () => {
    const xml = `<w:p><w:r><w:t>旧公</w:t></w:r><w:r><w:t>司</w:t></w:r></w:p>`;
    expect(detectSpansRuns(xml, "不存在的串", "w:p", "w:t")).toEqual([]);
    // 单节点已含 find：拼接也含——但那走 replace 道，不进 spans 分支（调用方以
    // replaced===0 为门）；此处只钉检测器本身的拼接纪律。
    expect(detectSpansRuns(xml, "旧公司", "w:p", "w:t").length).toBe(1);
  });

  it("br/tab 折空格纪律同读面：拼接时 <w:br/> 与 <w:tab/> 折成空格", () => {
    const xml = `<w:p><w:r><w:t>旧</w:t><w:tab/><w:t>公</w:t></w:r><w:br/><w:r><w:t>司</w:t></w:r></w:p>`;
    const spans = detectSpansRuns(xml, "旧 公 司", "w:p", "w:t");
    expect(spans.length).toBe(1);
    expect(spans[0]!.preview).toBe("旧 公 司");
  });

  it("pptx 形：<a:p>/<a:t> 同缝（a:br 折空格）", () => {
    const xml = `<a:p><a:r><a:t>旧公</a:t></a:r><a:r><a:t>司</a:t></a:r></a:p><a:p><a:r><a:t>其他</a:t></a:r></a:p>`;
    const spans = detectSpansRuns(xml, "旧公司", "a:p", "a:t");
    expect(spans.length).toBe(1);
    expect(spans[0]!.paragraphIndex).toBe(1);
    const br = detectSpansRuns(`<a:p><a:r><a:t>旧</a:t></a:r><a:br/><a:r><a:t>公司</a:t></a:r></a:p>`, "旧 公司", "a:p", "a:t");
    expect(br.length).toBe(1);
  });

  it("预览截前 40 字（码点计，长拼接不爆拒语）", () => {
    const long = "前奏".repeat(30);
    const xml = `<w:p><w:r><w:t>${long}旧</w:t></w:r><w:r><w:t>公司</w:t></w:r></w:p>`;
    const spans = detectSpansRuns(xml, "旧公司", "w:p", "w:t");
    expect(spans.length).toBe(1);
    expect(Array.from(spans[0]!.preview).length).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// §4 整包 — replaceDocxText（只换 document.xml；互证；确定性）
// ---------------------------------------------------------------------------

describe("ω99-229 §4 replaceDocxText", () => {
  it("闭环互测：find 零余、replace 在场、其余块零漂移、非目标部件 bytesEqual、同输入两次全等", () => {
    const before = sampleDocx();
    const r = replaceDocxText(before, "旧公司", "新公司", 50);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.replaced).toBe(4);
    // 读回：find 零余、replace 在场。
    const texts = docxTexts(r.bytes);
    expect(texts.some((t) => t.includes("旧公司"))).toBe(false);
    expect(texts.some((t) => t.includes("新公司"))).toBe(true);
    // 其余块零漂移：四块全文按预期（title/body/body/bullet 各就各位）。
    const paras = mustParseDocx(r.bytes).blocks.filter((b) => b.kind === "paragraph").map((b) => (b as { text: string }).text);
    expect(paras).toEqual(["新公司年度报告", "本报告由新公司编写。", "与关键词无关的一段。", "• 新公司 新公司 两处"]);
    // 非目标部件逐字节相等（只有 word/document.xml 动过）。
    const a = new Map(mustUnzip(before).map((p) => [p.name, p.data]));
    const b = new Map(mustUnzip(r.bytes).map((p) => [p.name, p.data]));
    expect([...a.keys()].sort()).toEqual([...b.keys()].sort()); // 条目名集原样
    for (const [name, data] of a) {
      if (name === "word/document.xml") expect(bytesEqual(data, b.get(name)!)).toBe(false);
      else expect(bytesEqual(data, b.get(name)!)).toBe(true);
    }
    // 确定性：同输入两次全等。
    const again = replaceDocxText(before, "旧公司", "新公司", 50);
    expect(again.ok && r.ok && bytesEqual(again.bytes, r.bytes)).toBe(true);
  });

  it("跨 run 拒分支：typed 拒 + 段落定位（不进互证——没改）", () => {
    const bytes = handDocx(
      `<w:document><w:body>` +
        `<w:p><w:r><w:t>第一段引言</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>介绍</w:t></w:r><w:r><w:t>旧公</w:t></w:r><w:r><w:t>司</w:t></w:r></w:p>` +
        `</w:body></w:document>`,
    );
    const r = replaceDocxText(bytes, "旧公司", "新公司", 50);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("spans_runs");
    if (r.reason === "spans_runs") {
      expect(r.paragraphs.length).toBe(1);
      expect(r.paragraphs[0]!.paragraphIndex).toBe(2);
      expect(r.paragraphs[0]!.preview).toBe("介绍旧公司");
    }
  });

  it("混合形：节点内命中照换 + 跨 run 残余如实点名（不静默漏）", () => {
    const bytes = handDocx(
      `<w:document><w:body>` +
        `<w:p><w:r><w:t>旧公司 直替</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>旧公</w:t></w:r><w:r><w:t>司 拆开</w:t></w:r></w:p>` +
        `</w:body></w:document>`,
    );
    const r = replaceDocxText(bytes, "旧公司", "新公司", 50);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.replaced).toBe(1);
    expect(r.spansRemaining).toBe(1);
    expect(docxTexts(r.bytes)).toEqual(["新公司 直替", "旧公司 拆开"]);
  });

  it("find 全然不在场 → not_found typed 拒", () => {
    const r = replaceDocxText(sampleDocx(), "不存在串", "新", 50);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("not_found");
  });

  it("缺 word/document.xml 与坏 zip → typed 拒（docx 词汇）", () => {
    const noDoc = storedZip([{ name: "[Content_Types].xml", data: enc.encode("<Types/>") }]);
    const miss = replaceDocxText(noDoc, "旧", "新", 50);
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.error).toContain("不是有效的 Word");
    const bad = replaceDocxText(enc.encode("根本不是 zip"), "旧", "新", 50);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("不是有效的 Word");
  });

  it("帽子：maxCount 全局帽对整包生效（恰=过/超=拒）", () => {
    const bytes = buildDocx({ blocks: [{ kind: "body", text: "旧".repeat(30) }, { kind: "body", text: "旧".repeat(30) }] });
    const ok = replaceDocxText(bytes, "旧", "新", 60);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.replaced).toBe(60);
    const over = replaceDocxText(bytes, "旧", "新", 50);
    expect(over.ok).toBe(false);
    if (over.ok) throw new Error("expected over_limit refusal");
    expect(over.reason).toBe("over_limit");
    if (over.reason === "over_limit") {
      expect(over.total).toBe(60);
      expect(over.limit).toBe(50);
    }
  });
});

// ---------------------------------------------------------------------------
// §5 整包 — replacePptxText（多张各跑各的；全局帽不分张；条目名实存枚举）
// ---------------------------------------------------------------------------

describe("ω99-229 §5 replacePptxText", () => {
  it("多张各自命中：count 汇总、读回零余、非目标部件 bytesEqual、两次全等", () => {
    const before = samplePptx();
    const r = replacePptxText(before, "旧公司", "新公司", 50);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.replaced).toBe(2); // 封面标题 + 第一条要点
    const slides = mustParsePptx(r.bytes);
    expect(slides[0]!.paragraphs[0]).toBe("新公司年报");
    expect(slides[1]!.paragraphs[1]).toBe("新公司增长稳健");
    for (const s of slides) for (const p of s.paragraphs) expect(p.includes("旧公司")).toBe(false);
    // 非目标部件（未改的 slide3 + layouts/masters/presentation 全家）原字节。
    const a = mustUnzip(before);
    const b = new Map(mustUnzip(r.bytes).map((p) => [p.name, p.data]));
    for (const p of a) {
      if (p.name === "ppt/slides/slide1.xml" || p.name === "ppt/slides/slide2.xml") continue;
      expect(bytesEqual(p.data, b.get(p.name)!)).toBe(true);
    }
    const again = replacePptxText(before, "旧公司", "新公司", 50);
    expect(again.ok && bytesEqual(again.bytes, r.bytes)).toBe(true);
  });

  it("全局帽不分张：跨张汇总超帽 → 拒且点名总数（未动任何部件）", () => {
    const bytes = buildPptx({
      slides: [
        { kind: "bullets", title: "页", bullets: ["旧".repeat(30)] },
        { kind: "bullets", title: "页", bullets: ["旧".repeat(30)] },
      ],
    });
    const r = replacePptxText(bytes, "旧", "新", 50);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected over_limit refusal");
    expect(r.reason).toBe("over_limit");
    if (r.reason === "over_limit") expect(r.total).toBe(60);
  });

  it("条目名实存枚举：slideN 编号不连续（重命名 slide2→slide9）仍各跑各的", () => {
    const before = samplePptx();
    const parts = mustUnzip(before).map((p) =>
      p.name === "ppt/slides/slide2.xml"
        ? { name: "ppt/slides/slide9.xml", data: p.data }
        : p,
    );
    // rels 里的 target 同步重命名（sldIdLst 经 rId → target 找部件）。
    const relsIdx = parts.findIndex((p) => p.name === "ppt/_rels/presentation.xml.rels");
    const relsText = new TextDecoder().decode(parts[relsIdx]!.data).replaceAll("slides/slide2.xml", "slides/slide9.xml");
    parts[relsIdx] = { name: parts[relsIdx]!.name, data: enc.encode(relsText) };
    const renamed = storedZip(parts);
    expect(mustParsePptx(renamed).length).toBe(3); // 夹具自检：重命名后读面仍通

    const r = replacePptxText(renamed, "旧公司", "新公司", 50);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.replaced).toBe(2);
    expect(mustParsePptx(r.bytes)[1]!.paragraphs[1]).toBe("新公司增长稳健");
  });

  it("跨 run 拒分支：段落定位带张号（read_pptx 的张序）", () => {
    const before = samplePptx();
    const parts = mustUnzip(before).map((p) => {
      if (p.name !== "ppt/slides/slide1.xml") return p;
      // 把封面标题「旧公司年报」拆成两个 run（骑 a:r 边界）。
      const text = new TextDecoder().decode(p.data).replace(
        /<a:r><a:rPr sz="4000"[^>]*\/><a:t>旧公司年报<\/a:t><\/a:r>/,
        `<a:r><a:rPr sz="4000"/><a:t>旧公</a:t></a:r><a:r><a:t>司年报</a:t></a:r>`,
      );
      return { name: p.name, data: enc.encode(text) };
    });
    const split = storedZip(parts);
    const r = replacePptxText(split, "旧公司年报", "新公司年报", 50);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("spans_runs");
    if (r.reason === "spans_runs") {
      expect(r.paragraphs.length).toBe(1);
      expect(r.paragraphs[0]!.slideIndex).toBe(1);
      expect(r.paragraphs[0]!.paragraphIndex).toBe(1);
      expect(r.paragraphs[0]!.preview).toBe("旧公司年报");
    }
  });

  it("find 不在场 → not_found；坏 zip → pptx 词汇拒", () => {
    const nf = replacePptxText(samplePptx(), "不存在串", "新", 50);
    expect(nf.ok).toBe(false);
    if (!nf.ok) expect(nf.reason).toBe("not_found");
    const bad = replacePptxText(enc.encode("not a zip"), "旧", "新", 50);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("不是有效的演示文稿");
  });
});

// ---------------------------------------------------------------------------
// §6 工具面（replace_docx / replace_pptx）
// ---------------------------------------------------------------------------

describe("ω99-229 §6 工具面（replace_docx / replace_pptx）", () => {
  it("成功收据：中文一句 + JSON 末行；盘上文件已改；file-receipt 门收", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-o229-a-"));
    await writeFile(join(ws, "订单.docx"), sampleDocx());
    const tool = createReplaceDocxTool(ws);
    const r = await exec(tool, { path: "订单.docx", find: "旧公司", replace: "新公司" });
    expect(r.isError ?? false).toBe(false);
    const text = String(r.content);
    expect(text).toContain(`已在 订单.docx 就地替换 4 处「旧公司」→「新公司」`);
    const last = text.slice(text.lastIndexOf("\n") + 1);
    const json = JSON.parse(last) as { path: string; relativePath: string; replaced: number; bytes: number };
    expect(json.relativePath).toBe("订单.docx");
    expect(json.replaced).toBe(4);
    expect(json.bytes).toBeGreaterThan(0);
    expect(json.path.endsWith("订单.docx")).toBe(true); // 绝对路径（realpath 形，/var→/private/var 同义）
    // 盘上真改了（读回互证）。
    expect(docxTexts(new Uint8Array(await readFile(join(ws, "订单.docx")))).some((t) => t.includes("新公司"))).toBe(true);
    // 223 #9 / 228 #5 先例：交付物文件卡门。
    expect(extractFileReceipt("replace_docx", text)).toEqual({ path: json.path, name: "订单.docx", bytes: json.bytes });
  });

  it("pptx 成功收据同缝", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-o229-b-"));
    await writeFile(join(ws, "路演.pptx"), samplePptx());
    const r = await exec(createReplacePptxTool(ws), { path: "路演.pptx", find: "旧公司", replace: "新公司" });
    expect(r.isError ?? false).toBe(false);
    const text = String(r.content);
    expect(text).toContain(`已在 路演.pptx 就地替换 2 处「旧公司」→「新公司」`);
    expect(extractFileReceipt("replace_pptx", text)).toBeDefined();
  });

  it("spans_runs 拒语含段落定位与出路（read 定位 → append 侧重建 → 整文档重造）", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-o229-c-"));
    await writeFile(
      join(ws, "分栏.docx"),
      handDocx(
        `<w:document><w:body>` +
          `<w:p><w:r><w:t>第一段引言</w:t></w:r></w:p>` +
          `<w:p><w:r><w:t>介绍</w:t></w:r><w:r><w:t>旧公</w:t></w:r><w:r><w:t>司</w:t></w:r></w:p>` +
          `</w:body></w:document>`,
      ),
    );
    const r = await exec(createReplaceDocxTool(ws), { path: "分栏.docx", find: "旧公司", replace: "新公司" });
    expect(r.isError).toBe(true);
    const text = String(r.content);
    expect(text).toContain(`「旧公司」在 1 个段落中被拆分在多个格式段内`);
    expect(text).toContain(`第 2 段预览：「介绍旧公司」`);
    expect(text).toContain(`可 read 定位该段后用 append 侧重建，或整文档重造`);
  });

  it("overLimit 拒语：命中总数 + 上限 + 分批出路；拒时零写盘", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-o229-d-"));
    const bytes = buildDocx({ blocks: [{ kind: "body", text: "旧".repeat(60) }] });
    await writeFile(join(ws, "超量.docx"), bytes);
    const r = await exec(createReplaceDocxTool(ws), { path: "超量.docx", find: "旧", replace: "新" });
    expect(r.isError).toBe(true);
    const text = String(r.content);
    expect(text).toContain(`命中 60 处超过上限 50`);
    expect(text).toContain(`请缩小 find 或分批（增大 maxCount 至 200 内）`);
    // 拒时零写盘：盘上字节与写入前全等。
    expect(bytesEqual(new Uint8Array(await readFile(join(ws, "超量.docx"))), bytes)).toBe(true);
  });

  it("魔数嗅探：OLE → 旧版 .doc 出路；非 PK → 不是 Word", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-o229-e-"));
    await writeFile(join(ws, "旧.doc"), Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]));
    await writeFile(join(ws, "假.docx"), enc.encode("hello not a zip"));
    const ole = await exec(createReplaceDocxTool(ws), { path: "旧.doc", find: "旧", replace: "新" });
    expect(ole.isError).toBe(true);
    expect(String(ole.content)).toContain("旧版 .doc 格式");
    expect(String(ole.content)).toContain("另存为");
    const fake = await exec(createReplaceDocxTool(ws), { path: "假.docx", find: "旧", replace: "新" });
    expect(fake.isError).toBe(true);
    expect(String(fake.content)).toContain("不是 Word（.docx）文档");
  });

  it("门序沿 221/223/228：ENOENT 用户语、外逃/绝对路径拒、typed 校验先于盘副作用", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-o229-f-"));
    const tool = createReplaceDocxTool(ws);
    const missing = await exec(tool, { path: "不存在.docx", find: "旧", replace: "新" });
    expect(missing.isError).toBe(true);
    expect(String(missing.content)).toContain("文件不存在：不存在.docx");
    const escape = await exec(tool, { path: "../外逃.docx", find: "旧", replace: "新" });
    expect(escape.isError).toBe(true);
    const absolute = await exec(tool, { path: "/tmp/绝对.docx", find: "旧", replace: "新" });
    expect(absolute.isError).toBe(true);
    // typed 拒：空 find / find===replace / 控制字（make 面逐字同政策）。
    for (const bad of [
      { path: "订单.docx", find: "", replace: "新" },
      { path: "订单.docx", find: "旧", replace: "旧" },
      { path: "订单.docx", find: "旧\x01", replace: "新" },
      { path: "订单.docx", find: "旧", replace: "新\x0b" },
      { path: "订单.docx", find: "旧" },
      { path: "订单.docx", find: 42, replace: "新" },
    ]) {
      const r = await exec(tool, bad);
      expect(r.isError).toBe(true);
      expect(String(r.content)).toMatch(/^replace_docx: /);
    }
  });

  it("maxCount 放大可行：55 处 maxCount 60 → 成功（护栏不是拒绝功能的门）", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-o229-g-"));
    await writeFile(join(ws, "批量.docx"), buildDocx({ blocks: [{ kind: "body", text: "旧".repeat(55) }] }));
    const r = await exec(createReplaceDocxTool(ws), { path: "批量.docx", find: "旧", replace: "新", maxCount: 60 });
    expect(r.isError ?? false).toBe(false);
    expect(String(r.content)).toContain(`就地替换 55 处`);
  });

  it("validateDocReplace 纯层：缺省 50、硬帽 200 钳制、\t \\n \\r 放行", () => {
    const d = validateDocReplace("旧", "新", undefined);
    expect(d.ok && d.maxCount).toBe(50);
    const cap = validateDocReplace("旧", "新", 500);
    expect(cap.ok && cap.maxCount).toBe(200);
    const nl = validateDocReplace("旧\n新", "改\t了\r", 10);
    expect(nl.ok).toBe(true);
    for (const bad of [null, "", 42]) {
      const r = validateDocReplace(bad, "新", undefined);
      expect(r.ok).toBe(false);
    }
    const zero = validateDocReplace("旧", "新", 0);
    expect(zero.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §7 挂载 / 权限 / summarize（census 邻域）
// ---------------------------------------------------------------------------

describe("ω99-229 §7 挂载·权限·summarize", () => {
  const stubModel = { stream: async function* () { /* never invoked */ } } as unknown as never;
  const gate = async (): Promise<{ behavior: "allow" }> => ({ behavior: "allow" });

  it("挂载位钉（零配置）：append_xlsx+1=replace_docx、replace_pptx+1=replace_xlsx、set_pptx_notes 的下一位才是 task", () => {
    const names = buildToolSet({ workspaceRoot: "/tmp/ws", model: stubModel, canUseTool: gate, contextWindowTokens: 64_000 }).map((t) => t.name);
    expect(names).toContain("replace_docx");
    expect(names).toContain("replace_pptx");
    expect(names[names.indexOf("append_xlsx") + 1]).toBe("replace_docx");
    expect(names[names.indexOf("replace_docx") + 1]).toBe("replace_pptx");
    // ω99-231 演进——replace_xlsx 插在 replace_pptx 之后、task 之前（Excel
    // 就地改写面=三件套「改」半边收口，append-only 尾）：replace_pptx 的下
    // 一位改钉 replace_xlsx，replace_xlsx 的下一位才是 task。
    expect(names[names.indexOf("replace_pptx") + 1]).toBe("replace_xlsx");
    // ω99-238: #11 演进——set_docx_header/set_pptx_notes 插在 replace_xlsx
    // 之后、task 之前（文档部件面=页眉页脚+演讲备注，doc 名册尾 append-only
    // 尾）：replace_xlsx 的下一位改钉 set_docx_header，set_pptx_notes 的下
    // 一位才是 task。
    // ω99-256: #9 演进——clear_docx_header/set_docx_first_page 插在
    // set_pptx_notes 之后、task 之前（doc 部件面 v2=页眉删除+首页不同，
    // doc 名册尾 append-only 尾）：set_pptx_notes 的下一位改钉
    // clear_docx_header，set_docx_first_page 的下一位才是 task。
    // ω99-263: #10 演进——set_docx_even_pages 插在 set_docx_first_page 之后、
    // task 之前（doc 部件面 v3=奇偶页不同，doc 名册尾 append-only 尾）：
    // set_docx_first_page 的下一位改钉 set_docx_even_pages，set_docx_even_
    // pages 的下一位才是 task。
    expect(names[names.indexOf("replace_xlsx") + 1]).toBe("set_docx_header");
    expect(names[names.indexOf("set_docx_header") + 1]).toBe("set_pptx_notes");
    expect(names[names.indexOf("set_pptx_notes") + 1]).toBe("clear_docx_header");
    expect(names[names.indexOf("set_docx_first_page") + 1]).toBe("set_docx_even_pages");
    expect(names[names.indexOf("set_docx_even_pages") + 1]).toBe("task");
  });

  it("权限位：FILE_EDIT_TOOLS 收两名；FILENAME_KEY_TOOLS / DEFAULT_ASK_TOOLS 不进", () => {
    for (const name of ["replace_docx", "replace_pptx"] as const) {
      expect(FILE_EDIT_TOOLS.has(name)).toBe(true);
      expect(FILENAME_KEY_TOOLS.has(name)).toBe(false);
      expect(DEFAULT_ASK_TOOLS.has(name)).toBe(false);
      expect(decidePermission("workspace", name)).toEqual({ behavior: "allow" });
      expect(decidePermission("auto", name)).toEqual({ behavior: "allow" });
      expect(decidePermission("ask", name)).toBe("ask");
      expect(decidePermission("plan", name)).toEqual({ behavior: "deny", reason: expect.stringContaining("plan mode is read-only") });
    }
  });

  it("summarize 两形：文件尾名 + 替换「旧」→「新」（220 语法：N 不可达不编造）", () => {
    expect(summarizeToolCall("replace_docx", { path: "dir/订单.docx", find: "旧公司", replace: "新公司" })).toBe(
      "订单.docx 替换「旧公司」→「新公司」",
    );
    expect(summarizeToolCall("replace_pptx", { path: "路演.pptx", find: "旧", replace: "" })).toBe(
      "路演.pptx 替换「旧」→「」",
    );
    expect(summarizeReplaceDocx({ path: "订单.docx", find: "旧", replace: "新" })).toBe("订单.docx 替换「旧」→「新」");
    expect(summarizeReplacePptx({ path: "路演.pptx", find: "旧", replace: "新" })).toBe("路演.pptx 替换「旧」→「新」");
  });

  it("描述=用户收益词汇：教「把…换成…」场景，零实现术语", () => {
    for (const t of [createReplaceDocxTool("/tmp/ws"), createReplacePptxTool("/tmp/ws")]) {
      for (const jargon of ["zip", "XML", "EOCD", "inflate", "unzipEntries", "buildTool", "run ", " w:t", " a:t"]) {
        expect(t.description.toLowerCase()).not.toContain(jargon.toLowerCase());
      }
      expect(t.description).toContain("换成");
    }
  });

  it("姿态四布尔镜像 append_* 写面：非只读 / 非并发安全 / 破坏性 / 非开放世界", () => {
    for (const t of [createReplaceDocxTool("/tmp/ws"), createReplacePptxTool("/tmp/ws")]) {
      expect(t.isReadOnly()).toBe(false);
      expect(t.isConcurrencySafe()).toBe(false);
      expect(t.isDestructive()).toBe(true);
      expect(t.isOpenWorld()).toBe(false);
    }
  });
});
