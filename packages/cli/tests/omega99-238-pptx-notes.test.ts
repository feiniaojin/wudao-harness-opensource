// ω99-238: #6 — set_pptx_notes receipts（pptx 演讲备注面：纯层部件+双向 rels /
// content-type / 幂等覆写 / 越界与校验拒 / 读面备注行 + 无备注零演进锚 /
// smartZip 保真 / 工具面收据）。RED-first。
// ★测试红线（09-09 用户令，逐字）：「注意，开发、测试过程禁止删除用户文件/
// 文件夹。」夹具全内存（buildPptx 造 deck + 手搓包）或 mkdtemp(os.tmpdir())
// 临时工作区**只写不删**；零删除调用。
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import type { Tool } from "@wudao-org/core";
// 写面原语（deck 夹具）。
import { buildPptx } from "../src/doc-pptx.js";
import type { DocDeck } from "../src/doc-pptx.js";
// zip 地基。
import { crc32, unzipEntries, unzipEntriesWithMeta } from "../src/doc-zip.js";
import type { RawZipEntry } from "../src/doc-zip.js";
// 本弧 pptx 备注面 + 读面（升级受益者）。
import {
  PPTX_NOTES_TEXT_MAX,
  setPptxNotes,
  validatePptxNotes,
  parsePptxNotes,
  createSetPptxNotesTool,
  summarizeSetPptxNotes,
} from "../src/doc-notes.js";
import { parsePptxSlides, createReadPptxTool } from "../src/doc-pptx-read.js";
// 消费面（收据门 / 摘要 / 权限钉）。
import { summarizeToolCall } from "../src/log.js";
import { FILE_EDIT_TOOLS } from "../src/permission.js";
import { extractFileReceipt } from "../src/driver/file-receipt.js";

const enc = new TextEncoder();
const XDECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const UTF8_FLAG = 0x0800;
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

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

const deck = (): Uint8Array =>
  buildPptx({
    slides: [
      { kind: "cover", title: "季度汇报" },
      { kind: "bullets", title: "要点", bullets: ["第一点", "第二点"] },
      { kind: "table", title: "数据", columns: [{ header: "列A" }, { header: "列B" }], rows: [["1", "2"]] },
    ],
  } satisfies DocDeck);

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

const stored = (entries: readonly Part[]): Uint8Array => zipWithMethods(entries.map((e) => ({ ...e, method: 0 as const })));

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

/** notesSlide 部件文本读回（<a:t> 全拼接 + \t\r\n 折空格 + trim——读面同款纪律）。 */
function notesTextOf(bytes: Uint8Array, partName: string): string {
  const part = mustUnzip(bytes).get(partName);
  expect(part).toBeDefined();
  const xml = new TextDecoder().decode(part!.data);
  expect(xml.includes("<p:notes")).toBe(true);
  let out = "";
  for (const m of xml.matchAll(/<a:t\b[^>]*?(?:\/>|>([\s\S]*?)<\/a:t>)/g)) out += m[1] ?? "";
  return out.replace(/[\t\r\n]+/g, " ").trim();
}

/** slideN 部件的 notesSlide 关系 target（无则 undefined）。 */
function slideNotesTarget(bytes: Uint8Array, slidePart: string): string | undefined {
  const relsPart = mustUnzip(bytes).get(slidePart.replace(/([^/]+)$/, "_rels/$1.rels"));
  expect(relsPart).toBeDefined();
  const rels = new TextDecoder().decode(relsPart!.data);
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    if (attr(m[0], "Type") === `${NS_R}/notesSlide`) return attr(m[0], "Target");
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// §1 纯层——无备注 deck 建链（R2(a)）
// ---------------------------------------------------------------------------

describe("ω99-238 R2(a) — 无备注 deck set 第 2 页：部件 + 双向 rels + content-type + 读回", () => {
  it("notesSlide 部件在场、slide→notes 与 notes→slide 双向、override 在场、文本读回等值", () => {
    const out = setPptxNotes(deck(), 2, "开场先讲结论，再讲数据");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.created).toBe(true);
    expect(out.partName).toBe("ppt/notesSlides/notesSlide1.xml");
    const parts = mustUnzip(out.bytes);

    // 件①：notesSlide 部件在场，根 <p:notes>，含 body 占位符。
    const notes = parts.get("ppt/notesSlides/notesSlide1.xml");
    expect(notes).toBeDefined();
    const notesXml = new TextDecoder().decode(notes!.data);
    expect(notesXml.includes("<p:notes")).toBe(true);
    expect(notesXml.includes('<p:ph type="body"')).toBe(true);

    // 件②：slide2.xml.rels → notesSlide（notesSlide 关系类型）。
    const slideRels = new TextDecoder().decode(parts.get("ppt/slides/_rels/slide2.xml.rels")!.data);
    expect(slideRels.includes(`${NS_R}/notesSlide"`)).toBe(true);
    expect([...slideRels.matchAll(/<Relationship\b[^>]*>/g)].some((m) => attr(m[0], "Target") === "../notesSlides/notesSlide1.xml" && attr(m[0], "Type")!.endsWith("/notesSlide"))).toBe(true);
    // 原有 layout 关系保留（追加不替换）。
    expect(slideRels.includes(`${NS_R}/slideLayout"`)).toBe(true);

    // 件③：notesSlide rels → slide（回指，slide 关系类型）。
    const notesRels = new TextDecoder().decode(parts.get("ppt/notesSlides/_rels/notesSlide1.xml.rels")!.data);
    expect([...notesRels.matchAll(/<Relationship\b[^>]*>/g)].some((m) => attr(m[0], "Type") === `${NS_R}/slide` && attr(m[0], "Target") === "../slides/slide2.xml")).toBe(true);

    // 件④：content-type override。
    const ct = new TextDecoder().decode(parts.get("[Content_Types].xml")!.data);
    expect(ct.includes('<Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>')).toBe(true);

    // 读回等值 + slide 部件本体字节零动（notes 是外围部件，正文不动）。
    expect(notesTextOf(out.bytes, "ppt/notesSlides/notesSlide1.xml")).toBe("开场先讲结论，再讲数据");
  });

  it("张序寻址：set 第 3 页命中 slides/slide3.xml（sldIdLst 序，非部件号假设）", () => {
    const out = setPptxNotes(deck(), 3, "收尾");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const rels = new TextDecoder().decode(mustUnzip(out.bytes).get("ppt/slides/_rels/slide3.xml.rels")!.data);
    expect(rels.includes("/notesSlide")).toBe(true);
  });

  it("notesMaster 沿包内既有：有则链接，无则不带（make_pptx 空模板无 notesMaster——诚实边界裁定）", () => {
    // 空模板（buildPptx 无 notesMaster）：notesSlide rels 只含 slide 回指。
    const bare = setPptxNotes(deck(), 1, "备注");
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    const bareRels = new TextDecoder().decode(mustUnzip(bare.bytes).get("ppt/notesSlides/_rels/notesSlide1.xml.rels")!.data);
    expect(bareRels.includes("notesMaster")).toBe(false);
    expect([...bareRels.matchAll(/<Relationship\b/g)].length).toBe(1);

    // 手造含 notesMaster 的包：notesSlide rels 沿用之。
    const base = mustUnzip(deck());
    const parts = [...base.values()].map((e) => ({ name: e.name, data: e.data }));
    parts.push({ name: "ppt/notesMasters/notesMaster1.xml", data: enc.encode(`${XDECL}<p:notesMaster/>`) });
    const withMaster = setPptxNotes(stored(parts), 1, "备注");
    expect(withMaster.ok).toBe(true);
    if (!withMaster.ok) return;
    const masterRels = new TextDecoder().decode(mustUnzip(withMaster.bytes).get("ppt/notesSlides/_rels/notesSlide1.xml.rels")!.data);
    expect([...masterRels.matchAll(/<Relationship\b[^>]*>/g)].some((m) => attr(m[0], "Type") === `${NS_R}/notesMaster` && attr(m[0], "Target") === "../notesMasters/notesMaster1.xml")).toBe(true);
  });

  it("碰撞纪律：slide1/slide3 已有备注（notesSlide1、2）后 set slide2 → 新部件扫 max+1（notesSlide3）", () => {
    const a = setPptxNotes(deck(), 1, "一");
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const b = setPptxNotes(a.bytes, 3, "三");
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    const c = setPptxNotes(b.bytes, 2, "二");
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.partName).toBe("ppt/notesSlides/notesSlide3.xml");
    // slide2 rels 的 target 指到 notesSlide3（部件号与页号解耦）。
    expect(slideNotesTarget(c.bytes, "ppt/slides/slide2.xml")).toBe("../notesSlides/notesSlide3.xml");
  });
});

// ---------------------------------------------------------------------------
// §2 幂等覆写（R2(b)）
// ---------------------------------------------------------------------------

describe("ω99-238 R2(b) — 已有备注覆写幂等", () => {
  it("set 两次：部件数不增、部件名不变、文本换新、rels 不加第二条", () => {
    const first = setPptxNotes(deck(), 2, "第一版备注");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = setPptxNotes(first.bytes, 2, "第二版备注换了内容");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(false);
    expect(second.partName).toBe(first.partName);
    expect(mustUnzip(second.bytes).size).toBe(mustUnzip(first.bytes).size);
    expect(notesTextOf(second.bytes, second.partName)).toBe("第二版备注换了内容");
    const slideRels = new TextDecoder().decode(mustUnzip(second.bytes).get("ppt/slides/_rels/slide2.xml.rels")!.data);
    expect([...slideRels.matchAll(/\/notesSlide"/g)].length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// §3 越界与校验拒（R2(c)(d)）
// ---------------------------------------------------------------------------

describe("ω99-238 R2(c)(d) — slide/text typed 拒（先于任何盘副作用）", () => {
  it("slide 非正整数/非数字 → typed 拒（read_pptx positiveInt 同族文案）", () => {
    expect(validatePptxNotes(0, "x")).toEqual({ ok: false, error: '"slide" must be a positive integer (the 1-based slide number)' });
    expect(validatePptxNotes(-1, "x")).toEqual({ ok: false, error: '"slide" must be a positive integer (the 1-based slide number)' });
    expect(validatePptxNotes(1.5, "x")).toEqual({ ok: false, error: '"slide" must be a positive integer (the 1-based slide number)' });
    expect(validatePptxNotes("2", "x")).toEqual({ ok: false, error: '"slide" must be a positive integer (the 1-based slide number)' });
    expect(validatePptxNotes(undefined, "x")).toEqual({ ok: false, error: '"slide" must be a positive integer (the 1-based slide number)' });
  });

  it("slide 越界（0/超上限）→ typed 拒（read_pptx 超范围同族文案）", () => {
    expect(setPptxNotes(deck(), 0, "x")).toEqual({
      ok: false,
      error: '"slide" must be a positive integer (the 1-based slide number)',
    });
    expect(setPptxNotes(deck(), 4, "x")).toEqual({
      ok: false,
      error: "第 4 页超出范围——这份演示文稿共 3 页（用 1–3 之间的 slide）",
    });
    expect(setPptxNotes(deck(), 99, "x")).toEqual({
      ok: false,
      error: "第 99 页超出范围——这份演示文稿共 3 页（用 1–3 之间的 slide）",
    });
  });

  it("text 空串/纯空白/控制字符/超帽 → typed 拒（与 docx chrome 同族文案）", () => {
    expect(validatePptxNotes(1, "")).toEqual({ ok: false, error: '"text" must be a non-empty string' });
    expect(validatePptxNotes(1, " \n\t ")).toEqual({ ok: false, error: '"text" must be a non-empty string' });
    expect(validatePptxNotes(1, 42)).toEqual({ ok: false, error: '"text" must be a non-empty string' });
    expect(validatePptxNotes(1, "坏\x07字")).toEqual({
      ok: false,
      error: '"text" contains a control character that cannot go into a document — remove it (tabs and line breaks are fine)',
    });
    expect(PPTX_NOTES_TEXT_MAX).toBe(4000);
    expect(validatePptxNotes(1, "长".repeat(4001))).toEqual({
      ok: false,
      error: '"text" is limited to 4000 characters, got 4001',
    });
  });

  it("结构拒：非 zip → pptx 词汇用户语拒", () => {
    expect(setPptxNotes(enc.encode("nope"), 1, "x")).toEqual({
      ok: false,
      error: "这不是有效的演示文稿（.pptx）文件——文件结构不完整或已损坏",
    });
  });
});

// ---------------------------------------------------------------------------
// §4 读面升级（R2(e)）——备注行 + 无备注零演进锚
// ---------------------------------------------------------------------------

// 升级前（基点 23751391）read_pptx 对本夹具的输出——2026-09-10 抓取落盘
// /tmp/o238-pre-upgrade-read-pptx.txt，逐字节对照锚。
const PRE_UPGRADE_FULL =
  "演示：锚点.pptx（3 张）\n" +
  "第 1 张\n" +
  "  季度汇报\n" +
  "第 2 张\n" +
  "  要点\n" +
  "  第一点\n" +
  "  第二点\n" +
  "第 3 张\n" +
  "  数据\n" +
  "  列A\n" +
  "  列B\n" +
  "  1\n" +
  "  2";

describe("ω99-238 R2(e) — read_pptx 备注行 + 无备注零演进锚", () => {
  it("无备注 deck：输出与升级前逐字节等（零演进锚——升级前输出已落盘对照）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "o238-notes-anchor-"));
    await writeFile(join(dir, "锚点.pptx"), deck());
    const out = await exec(createReadPptxTool(dir), { path: "锚点.pptx" });
    expect(out.content).toBe(PRE_UPGRADE_FULL);
    // 纯层同证：无 notes 键。
    const parsed = parsePptxSlides(deck());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) for (const s of parsed.slides) expect(s.notes).toBeUndefined();
  });

  it("有备注 deck：该页段内紧跟内容之后输出「备注：<text>」行", async () => {
    const withNotes = setPptxNotes(deck(), 2, "开场先讲结论");
    expect(withNotes.ok).toBe(true);
    if (!withNotes.ok) return;
    const dir = await mkdtemp(join(tmpdir(), "o238-notes-read-"));
    await writeFile(join(dir, "备注版.pptx"), withNotes.bytes);
    const out = await exec(createReadPptxTool(dir), { path: "备注版.pptx" });
    expect(out.content).toBe(
      "演示：备注版.pptx（3 张）\n" +
        "第 1 张\n" +
        "  季度汇报\n" +
        "第 2 张\n" +
        "  要点\n" +
        "  第一点\n" +
        "  第二点\n" +
        "  备注：开场先讲结论\n" +
        "第 3 张\n" +
        "  数据\n" +
        "  列A\n" +
        "  列B\n" +
        "  1\n" +
        "  2",
    );
  });

  it("parsePptxNotes 纯层：slide 部件名 → 备注文本映射（多段折空格；无备注缺席）", () => {
    const withNotes = setPptxNotes(deck(), 1, "第一段\n第二段");
    expect(withNotes.ok).toBe(true);
    if (!withNotes.ok) return;
    const parts = mustUnzip(withNotes.bytes);
    const byName = new Map([...parts.values()].map((e) => [e.name, e.data]));
    const map = parsePptxNotes(byName);
    expect(map.get("ppt/slides/slide1.xml")).toBe("第一段 第二段");
    expect(map.has("ppt/slides/slide2.xml")).toBe(false);
    // XML 逃逸读回。
    const tricky = setPptxNotes(deck(), 3, `A&B<C>"D"`);
    expect(tricky.ok).toBe(true);
    if (!tricky.ok) return;
    const tmap = parsePptxNotes(new Map([...mustUnzip(tricky.bytes).values()].map((e) => [e.name, e.data])));
    expect(tmap.get("ppt/slides/slide3.xml")).toBe(`A&B<C>"D"`);
  });
});

// ---------------------------------------------------------------------------
// §5 smartZip 保真 + 互证（R2(f)）
// ---------------------------------------------------------------------------

describe("ω99-238 R2(f) — smartZip 保真 + 互证链", () => {
  it("deflate 包 set notes：未改部件（slide 正文/theme/媒体）原压缩载荷字节直过", () => {
    const base = mustUnzip(deck());
    const parts: Part[] = [...base.values()].map((e) => ({ name: e.name, data: e.data }));
    const media = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    parts.push({ name: "ppt/media/image1.png", data: media });
    const packed = zipWithMethods(parts.map((p) => ({ ...p, method: 8 as const })));

    const out = setPptxNotes(packed, 2, "备注");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const after = mustUnzip(out.bytes);
    const before = mustUnzip(packed);
    for (const name of ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml", "ppt/slides/slide3.xml", "ppt/theme/theme1.xml", "ppt/media/image1.png", "ppt/presentation.xml"]) {
      const b = before.get(name)!;
      const a = after.get(name)!;
      expect(a.method).toBe(8);
      expect(bytesEqual(a.raw, b.raw)).toBe(true);
      expect(bytesEqual(a.data, b.data)).toBe(true);
    }
    // 改到的是 slide2 rels / content-types（method 8 重压）；新部件 stored。
    expect(after.get("ppt/slides/_rels/slide2.xml.rels")!.method).toBe(8);
    expect(after.get("[Content_Types].xml")!.method).toBe(8);
    expect(after.get("ppt/notesSlides/notesSlide1.xml")!.method).toBe(0);
    // 互证：回装字节喂读面（slide 数不漂、备注在）。
    const parsed = parsePptxSlides(out.bytes);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.slides.length).toBe(3);
      expect(parsed.slides[1]!.notes).toBe("备注");
    }
    expect(unzipEntries(out.bytes).ok).toBe(true);
  });

  it("同输入两次 set → 逐字节全等（确定性）", () => {
    const a = setPptxNotes(deck(), 2, "备注文本");
    const b = setPptxNotes(deck(), 2, "备注文本");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(bytesEqual(a.bytes, b.bytes)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §6 工具面：门序 / 收据 / summarize / 权限（真文件走 mkdtemp 只写）
// ---------------------------------------------------------------------------

describe("ω99-238 §6 — set_pptx_notes 工具面", () => {
  it("真文件 set notes：收据逐字（brief §二）+ JSON 尾行 + 回读等值", async () => {
    const dir = await mkdtemp(join(tmpdir(), "o238-notes-tool-"));
    const rel = "路演.pptx";
    await writeFile(join(dir, rel), deck());
    const tool = createSetPptxNotesTool(dir);
    const out = await exec(tool, { path: rel, slide: 2, text: "开场先讲结论" });
    expect(out.isError).toBeUndefined();
    const lines = out.content.split("\n");
    expect(lines[0]).toBe(`第 2 页备注已设置：「开场先讲结论」`);
    const receipt = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(receipt["relativePath"]).toBe(rel);
    expect(receipt["slide"]).toBe(2);
    expect(typeof receipt["bytes"]).toBe("number");
    const parsed = parsePptxSlides(await readFile(join(dir, rel)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.slides[1]!.notes).toBe("开场先讲结论");
  });

  it("收据前 20 字截断 + 「…」", async () => {
    const dir = await mkdtemp(join(tmpdir(), "o238-notes-trunc-"));
    const rel = "长备注.pptx";
    await writeFile(join(dir, rel), deck());
    const out = await exec(createSetPptxNotesTool(dir), { path: rel, slide: 1, text: "字".repeat(25) });
    expect(out.content.split("\n")[0]).toBe(`第 1 页备注已设置：「${"字".repeat(20)}…」`);
  });

  it("拒链（先于副作用）：路径/slide/text/帽/越界/ENOENT/OLE/非 PK，文案逐字", async () => {
    const dir = await mkdtemp(join(tmpdir(), "o238-notes-rej-"));
    const tool = createSetPptxNotesTool(dir);
    await writeFile(join(dir, "路演.pptx"), deck());
    await writeFile(join(dir, "旧.ppt"), new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]));
    await writeFile(join(dir, "plain.txt"), enc.encode("hello"));
    expect((await exec(tool, { path: "", slide: 1, text: "x" })).content).toBe(
      'set_pptx_notes: "path" must be a non-empty path relative to the workspace',
    );
    expect((await exec(tool, { path: "路演.pptx", slide: 0, text: "x" })).content).toBe(
      'set_pptx_notes: "slide" must be a positive integer (the 1-based slide number)',
    );
    expect((await exec(tool, { path: "路演.pptx", slide: 9, text: "x" })).content).toBe(
      "set_pptx_notes: 第 9 页超出范围——这份演示文稿共 3 页（用 1–3 之间的 slide）",
    );
    expect((await exec(tool, { path: "路演.pptx", slide: 1, text: "  " })).content).toBe(
      'set_pptx_notes: "text" must be a non-empty string',
    );
    expect((await exec(tool, { path: "路演.pptx", slide: 1, text: "a\x07b" })).content).toBe(
      'set_pptx_notes: "text" contains a control character that cannot go into a document — remove it (tabs and line breaks are fine)',
    );
    expect((await exec(tool, { path: "路演.pptx", slide: 1, text: "长".repeat(4001) })).content).toBe(
      'set_pptx_notes: "text" is limited to 4000 characters, got 4001',
    );
    expect((await exec(tool, { path: "无.pptx", slide: 1, text: "x" })).content).toBe(
      "set_pptx_notes: 文件不存在：无.pptx",
    );
    expect((await exec(tool, { path: "旧.ppt", slide: 1, text: "x" })).content).toBe(
      "set_pptx_notes: 旧.ppt 是旧版 .ppt 格式，改不了——请先用 PowerPoint 打开并「另存为」.pptx 格式后再试",
    );
    expect((await exec(tool, { path: "plain.txt", slide: 1, text: "x" })).content).toBe(
      "set_pptx_notes: plain.txt 不是演示文稿（.pptx）文件——如果它是旧版 .ppt 或其他格式，请先在 PowerPoint 里另存为 .pptx 再试",
    );
  });

  it("summarize：`设置了第 N 页备注`（brief §二）+ 收据门 + 权限册", () => {
    expect(summarizeSetPptxNotes({ path: "dir/路演.pptx", slide: 2, text: "x" })).toBe("路演.pptx 设置了第 2 页备注");
    expect(summarizeToolCall("set_pptx_notes", { path: "路演.pptx", slide: 3, text: "x" })).toBe("路演.pptx 设置了第 3 页备注");
    const receipt = `第 2 页备注已设置：「开场」\n${JSON.stringify({ path: "/tmp/ws/路演.pptx", relativePath: "路演.pptx", slide: 2, bytes: 8192 })}`;
    expect(extractFileReceipt("set_pptx_notes", receipt)).toBeDefined();
    expect(extractFileReceipt("set_pptx_notes", "set_pptx_notes: 写入失败（boom）")).toBeUndefined();
    expect(FILE_EDIT_TOOLS.has("set_pptx_notes")).toBe(true);
  });
});
