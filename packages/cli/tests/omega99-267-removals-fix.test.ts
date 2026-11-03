// ω99-267: #2 — verifyRemovals 零删除部件时 rels/CT 误拒修复 receipts（256 潜
// 伏缺陷，263 报告 §四-6 记档：裸 make_docx 无 word/_rels/document.xml.rels，
// set_docx_first_page 纯开关 true→false 被 verifyRemovals 的部件在场前置误拒成
// STRUCTURE_ERROR——用户可见症状「对裸文档开-关一次首页不同 → 莫名文档结构
// 异常」）。RED-first（R1 先红后绿，223/256/259 谱系）。★测试红线（09-09 用
// 户令，逐字）：「注意，开发、测试过程禁止删除用户文件/文件夹。」夹具全内存
// zip 工坊 + 工具面 mkdtemp(os.tmpdir()) 临时工作区只写不删；零删除原语；零
// 真模型零网络零 spawn。
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import type { Tool } from "@wudao-org/core";
// 写面原语（裸 docx 夹具 + 「已有 default 页眉」起点——238 setDocxChrome 造链）。
import { buildDocx } from "../src/doc-docx.js";
import type { DocBlock } from "../src/doc-docx.js";
// zip 地基。
import { crc32, unzipEntriesWithMeta } from "../src/doc-zip.js";
import type { RawZipEntry } from "../src/doc-zip.js";
// 本弧面 + 邻接（263 even 纯旗标路径行为钉）。
import {
  setDocxChrome,
  clearDocxChrome,
  setDocxFirstPage,
  setDocxEvenPages,
  createSetDocxFirstPageTool,
} from "../src/doc-chrome.js";

const enc = new TextEncoder();
const UTF8_FLAG = 0x0800;
const STRUCTURE_ERROR_TEXT = "这不是有效的 Word（.docx）文件——文件结构不完整或已损坏";

const exec = async (tool: Tool, args: Record<string, unknown>) => tool.execute(args);

// ---------------------------------------------------------------------------
// 夹具工坊（全内存；零删除）——256/259/263 同款件
// ---------------------------------------------------------------------------

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const doc = (blocks: readonly DocBlock[]): Uint8Array =>
  buildDocx({ blocks: blocks.length > 0 ? blocks : [{ kind: "title", text: "裸文档" }] });

type MethodPart = { name: string; data: Uint8Array; method: 0 | 8 };

/** 手搓全 deflate（method 8）zip——模拟用户 Office 存的包（230/256 同款工坊）。 */
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

/** 解包成 name→RawZipEntry（断言用；要求 unzip 成功）。 */
function mustUnzip(bytes: Uint8Array): Map<string, RawZipEntry> {
  const out = unzipEntriesWithMeta(bytes);
  expect(out.ok).toBe(true);
  if (!out.ok) throw new Error("unzip failed");
  return new Map(out.entries.map((e) => [e.name, e]));
}

const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

/** 「已有 default 页眉」的起点夹具（238 前作造链——带 rels rId1 + CT）。 */
const withDefaultHeader = (text = "公司机密"): Uint8Array =>
  setDocxChrome(doc([{ kind: "title", text: "简历" }, { kind: "body", text: "正文一段" }]), "header", text).bytes as Uint8Array;

/** 换件重装（全内存字符串手术通用底座：其余条目原样 deflate 重装）。 */
function rezipWith(parts: Map<string, RawZipEntry>, swaps: Map<string, Uint8Array>): Uint8Array {
  return zipWithMethods(
    [...parts.entries()].map(([n, e]) => ({ name: n, data: swaps.get(n) ?? e.data, method: 8 as const })),
  );
}

// ---------------------------------------------------------------------------
// R1 — 缺陷复现（红→绿）：裸包纯开关 true→false
// ---------------------------------------------------------------------------

describe("ω99-267 R1 — 裸包纯开关误拒（红→绿）", () => {
  it("裸包部件清单亲验（brief 侦察 #3 执行者实证）：make_docx 最小包恰五件、无 word/_rels/document.xml.rels、有 [Content_Types].xml；纯开关 true 后仍裸", () => {
    const bare = doc([{ kind: "title", text: "裸文档" }]);
    const parts = mustUnzip(bare);
    expect(parts.size).toBe(5);
    expect(parts.has("word/_rels/document.xml.rels")).toBe(false);
    expect(parts.has("[Content_Types].xml")).toBe(true);
    expect(parts.has("word/document.xml")).toBe(true);
    const on = setDocxFirstPage(bare, { firstDifferent: true });
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    expect(on.removedParts).toEqual([]);
    // titlePg 只动 document.xml——ensureTitlePg 零建件，包仍裸（缺陷前置钉）。
    expect(mustUnzip(on.bytes).has("word/_rels/document.xml.rels")).toBe(false);
  });

  it("缺陷复现：裸包 true→false 纯开关 → ok（红取证=现行 STRUCTURE_ERROR）+ 收据形与 removedParts:[] 现行形一致", () => {
    const on = setDocxFirstPage(doc([{ kind: "title", text: "裸文档" }]), { firstDifferent: true });
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    const off = setDocxFirstPage(on.bytes, { firstDifferent: false });
    expect(off.ok).toBe(true); // ← 修复前：rels 在场前置把纯开关路径打死。
    if (!off.ok) return;
    expect(off.firstDifferent).toBe(false);
    expect(off.removedParts).toEqual([]);
    expect(Object.keys(off).sort()).toEqual(["bytes", "firstDifferent", "ok", "removedParts"]);
    const parts = mustUnzip(off.bytes);
    expect(/<w:titlePg\b/.test(decode(parts.get("word/document.xml")!.data))).toBe(false); // titlePg 真拆（旗标互证仍在）。
    expect(parts.has("word/_rels/document.xml.rels")).toBe(false); // 零新建——关闭不造件。
  });

  it("对照（今日已绿）：带 headerText 的 true→false 有删除部件 → removedParts 非空走老路径照旧 ok", () => {
    const bare = doc([{ kind: "title", text: "裸文档" }]);
    const on = setDocxFirstPage(bare, { firstDifferent: true, headerText: "首页专属" });
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    expect(mustUnzip(on.bytes).has("word/_rels/document.xml.rels")).toBe(true); // setDocxChromeRef 建链三件。
    const off = setDocxFirstPage(on.bytes, { firstDifferent: false });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.removedParts).toEqual(["word/header1.xml"]); // 有删除 → rels/CT 两段照跑（fail-closed 老路）。
    const parts = mustUnzip(off.bytes);
    expect(parts.has("word/header1.xml")).toBe(false);
    expect(parts.has("word/_rels/document.xml.rels")).toBe(true); // rels 部件本身保留（条目已清）。
  });

  it("工具面（用户可见症状）：裸文档开-关一次首页不同 → 两步都成功、第二步回执「首页已设为与全篇相同」", async () => {
    const dir = await mkdtemp(join(tmpdir(), "o267-tool-"));
    const rel = "手册.docx";
    await writeFile(join(dir, rel), doc([{ kind: "title", text: "手册" }]));
    const tool = createSetDocxFirstPageTool(dir);
    const on = await exec(tool, { path: rel, firstDifferent: true });
    expect(on.isError).toBeFalsy();
    expect(on.content.split("\n")[0]).toBe("首页已设为不同（无首页页眉）");
    const off = await exec(tool, { path: rel, firstDifferent: false });
    expect(off.isError).toBeFalsy(); // ← 修复前：用户看到「文档结构异常」误报。
    expect(off.content.split("\n")[0]).toBe("首页已设为与全篇相同");
    const tail = JSON.parse(off.content.split("\n").at(-1)!);
    expect(tail.firstDifferent).toBe(false);
    expect(tail.relativePath).toBe(rel);
    // 盘上互证：titlePg 已拆。
    expect(/<w:titlePg\b/.test(decode(await readFile(join(dir, rel))))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R2 — fail-closed 保持：有删除路径三拒逐字照旧（tamper 全内存手术造）
// ---------------------------------------------------------------------------

describe("ω99-267 R2 — fail-closed 保持：有删除路径三拒照旧", () => {
  it("① 被删部件内容仍留在包里（重名双条目包）→ STRUCTURE_ERROR", () => {
    const parts = mustUnzip(withDefaultHeader());
    const doubled = zipWithMethods([
      ...[...parts.values()].map((e) => ({ name: e.name, data: e.data, method: 8 as const })),
      { name: "word/header1.xml", data: parts.get("word/header1.xml")!.data, method: 8 },
    ]);
    // 前置亲验：zip 里同名条目恰两条（Map 视角会去重——按原始条目数）。
    const u = unzipEntriesWithMeta(doubled);
    expect(u.ok).toBe(true);
    if (!u.ok) return;
    expect(u.entries.filter((e) => e.name === "word/header1.xml").length).toBe(2);
    const out = clearDocxChrome(doubled, "header", "default");
    // 重名第二条目活过清扫 → 被删部件在场互证打头（现行检查直证）。
    expect(out).toEqual({ ok: false, error: STRUCTURE_ERROR_TEXT });
  });

  it("② rels 残行指向被删部件（悬空 rId9 同 Target）→ STRUCTURE_ERROR", () => {
    const parts = mustUnzip(withDefaultHeader());
    const rels = decode(parts.get("word/_rels/document.xml.rels")!.data);
    const withDangling = rels.replace(
      "</Relationships>",
      '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>',
    );
    expect(withDangling).not.toBe(rels); // 前置亲验：手术生效。
    const pkg = rezipWith(parts, new Map([["word/_rels/document.xml.rels", enc.encode(withDangling)]]));
    const out = clearDocxChrome(pkg, "header", "default");
    // 部件已删净、rId1 条目已清，但悬空 rId9 仍指被删部件 → rels 残行互证（现行检查直证）。
    expect(out).toEqual({ ok: false, error: STRUCTURE_ERROR_TEXT });
  });

  it("③ CT 残行（Override 元素名改小写，清扫正则收不走、字符串残行仍在）→ STRUCTURE_ERROR", () => {
    const parts = mustUnzip(withDefaultHeader());
    const ct = decode(parts.get("[Content_Types].xml").data);
    const tampered = ct.replace('<Override PartName="/word/header1.xml"', '<override PartName="/word/header1.xml"');
    expect(tampered).not.toBe(ct); // 前置亲验：手术生效。
    const pkg = rezipWith(parts, new Map([["[Content_Types].xml", enc.encode(tampered)]]));
    const out = clearDocxChrome(pkg, "header", "default");
    // rels 已净、部件已删净，但 CT 残行仍在 → Content_Types 互证（现行检查直证）。
    expect(out).toEqual({ ok: false, error: STRUCTURE_ERROR_TEXT });
  });
});

// ---------------------------------------------------------------------------
// R5 — 邻接零漂移钉：263 even 内联核行为不变 + not_found 门不外溢
// ---------------------------------------------------------------------------

describe("ω99-267 R5 — 邻接零漂移钉", () => {
  it("263 even 纯旗标路径行为不变：裸包 on→off 仍 ok、旗标真拆（内联核零改动）", () => {
    const on = setDocxEvenPages(doc([{ kind: "title", text: "手册" }]), { evenOddDifferent: true });
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    const off = setDocxEvenPages(on.bytes, { evenOddDifferent: false });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.removedParts).toEqual([]);
    expect(off.evenOddDifferent).toBe(false);
    const settings = mustUnzip(off.bytes).get("word/settings.xml");
    expect(settings).toBeDefined();
    expect(/<w:evenAndOddHeaders\b/.test(decode(settings!.data))).toBe(false); // 旗标真拆、部件永不删。
  });

  it("not_found 门不外溢：裸文档直接关首页不同 → typed not_found（修复前后的同形出口）", () => {
    expect(setDocxFirstPage(doc([{ kind: "title", text: "素" }]), { firstDifferent: false })).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("字节保真邻接：纯开关拆 titlePg 后，其余四件与裸包逐字节等值（只动 document.xml）", () => {
    const bare = doc([{ kind: "title", text: "裸文档" }]);
    const before = [...mustUnzip(bare).values()];
    const on = setDocxFirstPage(bare, { firstDifferent: true });
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    const off = setDocxFirstPage(on.bytes, { firstDifferent: false });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    const after = mustUnzip(off.bytes);
    expect([...after.keys()]).toEqual(before.map((e) => e.name)); // 条目序原样。
    for (const e of before) {
      expect(bytesEqual(after.get(e.name)!.data, e.data)).toBe(true); // 五件全部逐字节等值（titlePg 立后拆=零净改）。
    }
  });
});
