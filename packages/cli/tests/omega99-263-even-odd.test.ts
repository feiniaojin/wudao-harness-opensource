// ω99-263: #3 — docx 奇偶页不同 receipts（settings.xml 的 evenAndOddHeaders
// 文档级旗标 + header/footer 双部件族的 even 引用档——「首页/奇偶」两轴收口
// 后 docx 部件面 ECMA 对称完备）。RED-first：先红后绿（223/256/259 谱系）。
// settings.xml 夹具用全内存字符串手术造（make_docx 裸包无该部件——不拿被测
// 面自证「已在场」起点）。★测试红线（09-09 用户令，逐字）：「注意，开发、
// 测试过程禁止删除用户文件/文件夹。」夹具全内存或 mkdtemp(os.tmpdir()) 临
// 时工作区**只写不删**；零删除调用；零真网络零真模型零 spawn。
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import type { Tool } from "@wudao/core";
// 写面原语（裸 docx 夹具；238 setDocxChrome 造「已有 default 页眉」起点）。
import { buildDocx } from "../src/doc-docx.js";
import type { DocBlock } from "../src/doc-docx.js";
// zip 地基。
import { crc32, unzipEntriesWithMeta } from "../src/doc-zip.js";
import type { RawZipEntry } from "../src/doc-zip.js";
// 本弧面 + 前作。
import {
  setDocxChrome,
  clearDocxChrome,
  setDocxFirstPage,
  setDocxEvenPages,
  validateDocxEvenPages,
  createSetDocxEvenPagesTool,
  createClearDocxHeaderTool,
  summarizeSetDocxEvenPages,
} from "../src/doc-chrome.js";
// 消费面（收据门 / 摘要 / 权限钉 / 名册四缝）。
import { summarizeToolCall } from "../src/log.js";
import { FILE_EDIT_TOOLS } from "../src/permission.js";
import { extractFileReceipt } from "../src/driver/file-receipt.js";
import { buildToolSet } from "../src/tools.js";
import {
  DOC_SUITE_EDIT_TOOLS,
  DOC_SUITE_RECEIPT_TOOLS,
  docSuiteSummarizers,
} from "../src/doc-suite.js";

const enc = new TextEncoder();
const UTF8_FLAG = 0x0800;

const exec = async (tool: Tool, args: Record<string, unknown>) => tool.execute(args);

// ---------------------------------------------------------------------------
// 夹具工坊（全内存；零删除）——256/259 同款件
// ---------------------------------------------------------------------------

type Part = { name: string; data: Uint8Array };
type MethodPart = Part & { method: 0 | 8 };

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const doc = (blocks: readonly DocBlock[]): Uint8Array =>
  buildDocx({ blocks: blocks.length > 0 ? blocks : [{ kind: "title", text: "裸文档" }] });

/** 手搓全 deflate（method 8）zip——模拟用户 Office 存的包（230/256 同款工坊）。 */
function deflatedZip(entries: readonly Part[]): Uint8Array {
  return zipWithMethods(entries.map((e) => ({ ...e, method: 8 as const })));
}

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

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(tag) ?? new RegExp(`${name}\\s*=\\s*'([^']*)'`).exec(tag);
  return m?.[1];
};

const decodeEntities = (s: string): string =>
  s.replace(/&(amp|lt|gt|quot|apos|#x[0-9A-Fa-f]+|#[0-9]+);/g, (whole, body: string) => {
    if (body === "amp") return "&";
    if (body === "lt") return "<";
    if (body === "gt") return ">";
    if (body === "quot") return '"';
    if (body === "apos") return "'";
    if (body.startsWith("#x")) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return whole;
  });

/** 末节 body sectPr 内文（单节夹具=文档里唯一的 sectPr）。 */
function bodySectInner(bytes: Uint8Array): string {
  const document = decode(mustUnzip(bytes).get("word/document.xml")!.data);
  const open = document.lastIndexOf("<w:sectPr>");
  const close = document.lastIndexOf("</w:sectPr>");
  expect(open).toBeGreaterThanOrEqual(0);
  expect(close).toBeGreaterThan(open);
  return document.slice(open + "<w:sectPr>".length, close);
}

/** 指定 which+refType 的部件链读回（223/256/259 互证范式；263 起 even 三档通用）。 */
function chromeText(bytes: Uint8Array, which: "header" | "footer", refType: "default" | "first" | "even"): string | undefined {
  const parts = mustUnzip(bytes);
  const document = decode(parts.get("word/document.xml")!.data);
  let rid: string | undefined;
  for (const m of document.matchAll(new RegExp(`<w:${which}Reference\\b[^>]*>`, "g"))) {
    if (attr(m[0], "w:type") === refType) rid = attr(m[0], "r:id");
  }
  if (rid === undefined) return undefined;
  const rels = decode(parts.get("word/_rels/document.xml.rels")!.data);
  let target: string | undefined;
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    if (attr(m[0], "Id") === rid) target = attr(m[0], "Target");
  }
  expect(target).toBeDefined();
  const partName = `word/${target!.replace(/^\.\//, "")}`;
  const chrome = decode(parts.get(partName)!.data);
  expect(chrome.includes(which === "header" ? "<w:hdr" : "<w:ftr")).toBe(true);
  let out = "";
  for (const m of chrome.matchAll(/(<w:br\b[^>]*\/>)|<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)) {
    if (m[1] !== undefined) out += "\n";
    else out += decodeEntities(m[2] ?? "");
  }
  return out;
}

/** settings.xml 里 evenAndOddHeaders 旗标是否在场（任意形）。 */
function hasEvenOddFlag(bytes: Uint8Array): boolean {
  const settings = mustUnzip(bytes).get("word/settings.xml");
  if (settings === undefined) return false;
  return /<w:evenAndOddHeaders\b/.test(decode(settings.data));
}

/** 「已有 default 页眉/页脚」的起点夹具（238 前作造链——带 rels rId1）。 */
const withDefaultHeader = (text = "公司机密"): Uint8Array =>
  setDocxChrome(doc([{ kind: "title", text: "简历" }, { kind: "body", text: "正文一段" }]), "header", text).bytes as Uint8Array;
const withDefaultFooter = (text = "第 1 页"): Uint8Array =>
  setDocxChrome(doc([{ kind: "title", text: "报告" }]), "footer", text).bytes as Uint8Array;

/** 换件重装（全内存字符串手术通用底座：其余条目原样 deflate 重装）。 */
function rezipWith(parts: Map<string, RawZipEntry>, swaps: Map<string, Uint8Array>): Uint8Array {
  return zipWithMethods(
    [...parts.entries()].map(([n, e]) => ({ name: n, data: swaps.get(n) ?? e.data, method: 8 as const })),
  );
}

/** 手术③：往包里加 word/settings.xml（四缝布线：rels rId=max+1 + CT Override
 *  + 新部件——镜像真 Word 的布线；make_docx 裸包无该部件，夹具不拿被测面自
 *  证「已在场」起点）。inner 即 <w:settings> 内文。 */
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function addSettingsPart(base: Uint8Array, inner: string): Uint8Array {
  const parts = mustUnzip(base);
  const rels = decode(parts.get("word/_rels/document.xml.rels")!.data);
  expect(rels.includes("</Relationships>")).toBe(true);
  let maxRid = 0;
  for (const m of rels.matchAll(/Id="rId(\d+)"/g)) maxRid = Math.max(maxRid, Number.parseInt(m[1]!, 10));
  const rid = `rId${maxRid + 1}`;
  const newRels = rels.replace(
    "</Relationships>",
    `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>`,
  );
  const ct = decode(parts.get("[Content_Types].xml").data);
  expect(ct.includes("</Types>")).toBe(true);
  const newCt = ct.replace(
    "</Types>",
    '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>',
  );
  const settingsXml = `${XML_DECL}<w:settings xmlns:w="${W_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${inner}</w:settings>`;
  return zipWithMethods([
    ...[...parts.entries()]
      .filter(([n]) => n !== "word/_rels/document.xml.rels" && n !== "[Content_Types].xml")
      .map(([n, e]) => ({ name: n, data: e.data, method: 8 as const })),
    { name: "word/_rels/document.xml.rels", data: enc.encode(newRels), method: 8 },
    { name: "[Content_Types].xml", data: enc.encode(newCt), method: 8 },
    { name: "word/settings.xml", data: enc.encode(settingsXml), method: 8 },
  ]);
}

/** 真实感 settings 内文（无旗标）：zoom/proofState/defaultTabStop 在旗标**前**
 *  的 spec 位，characterSpacingControl/compat/rsids/decimalSymbol/listSeparator
 *  在旗标**后**——EVENODD_LATER_ELEMENTS 位序钉的对照件。 */
const SETTINGS_INNER_PLAIN =
  '<w:zoom w:percent="100"/><w:proofState w:spelling="clean" w:grammar="clean"/><w:defaultTabStop w:val="420"/>' +
  '<w:characterSpacingControl w:val="doNotCompress"/>' +
  '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>' +
  '<w:rsids><w:rsid w:val="00A1B2C3"/></w:rsids>' +
  '<w:decimalSymbol w:val="."/><w:listSeparator w:val=","/>';
/** 同内文+旗标在 spec 位（defaultTabStop 之后、characterSpacingControl 之前）。 */
const SETTINGS_INNER_FLAGGED = SETTINGS_INNER_PLAIN.replace(
  "<w:characterSpacingControl",
  "<w:evenAndOddHeaders/><w:characterSpacingControl",
);
const settingsXmlOf = (inner: string): string => `${XML_DECL}<w:settings xmlns:w="${W_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${inner}</w:settings>`;

/** 手术④：末节 sectPr 里把该 which 的 default 引用复制为 even 引用（同
 *  r:id=共享部件夹具——clear(even) 共享守卫的钉用）。 */
function shareDefaultRefAsEven(base: Uint8Array, which: "header" | "footer"): Uint8Array {
  const parts = mustUnzip(base);
  const docXml = decode(parts.get("word/document.xml")!.data);
  const m = new RegExp(`<w:${which}Reference\\b[^>]*w:type="default"[^>]*>`).exec(docXml);
  expect(m).not.toBeNull();
  const rid = attr(m![0], "r:id");
  expect(rid).toBeDefined();
  const evenRef = `<w:${which}Reference w:type="even" r:id="${rid}"/>`;
  const newDoc = docXml.slice(0, m!.index + m![0].length) + evenRef + docXml.slice(m!.index + m![0].length);
  return rezipWith(parts, new Map([["word/document.xml", enc.encode(newDoc)]]));
}

// ---------------------------------------------------------------------------
// R1 — 旗标面：在场插入位序 / 缺席创建三件齐 / 已在幂等 / 移除只删旗标 / 部件永不删
// ---------------------------------------------------------------------------

describe("ω99-263 R1 — evenAndOddHeaders 旗标面（settings.xml 读改写）", () => {
  it("缺席创建（裸包无 settings 无 document rels）：settings.xml+CT+rels 三件齐，rId=maxRId+1=rId1 钉", () => {
    const out = setDocxEvenPages(doc([{ kind: "title", text: "书稿" }]), { evenOddDifferent: true });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const parts = mustUnzip(out.bytes);
    const settings = parts.get("word/settings.xml");
    expect(settings).toBeDefined();
    expect(decode(settings!.data)).toBe(`${XML_DECL}<w:settings xmlns:w="${W_NS}"><w:evenAndOddHeaders/></w:settings>`);
    expect(decode(parts.get("[Content_Types].xml").data)).toContain('PartName="/word/settings.xml"');
    expect(decode(parts.get("word/_rels/document.xml.rels")!.data)).toContain('Id="rId1"');
    expect(decode(parts.get("word/_rels/document.xml.rels")!.data)).toContain('Target="settings.xml"');
  });

  it("缺席创建（已有 rels rId1）：settings 关系落 rId2（max+1 碰撞纪律钉）", () => {
    const out = setDocxEvenPages(withDefaultHeader(), { evenOddDifferent: true });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const rels = decode(mustUnzip(out.bytes).get("word/_rels/document.xml.rels")!.data);
    expect(/Id="rId2"[^>]*Target="settings\.xml"/.test(rels)).toBe(true);
  });

  it("在场插入位序（EVENODD_LATER_ELEMENTS 钉）：旗标落 defaultTabStop 之后、characterSpacingControl 之前", () => {
    const base = addSettingsPart(withDefaultHeader("默认页眉"), SETTINGS_INNER_PLAIN);
    const out = setDocxEvenPages(base, { evenOddDifferent: true });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(decode(mustUnzip(out.bytes).get("word/settings.xml")!.data)).toBe(settingsXmlOf(SETTINGS_INNER_FLAGGED));
    // 其他 Word 设置原样保留（字节等值由整串等值直证）。
  });

  it("已在场幂等：再开=原字节回（零重装）", () => {
    const once = setDocxEvenPages(withDefaultHeader(), { evenOddDifferent: true });
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const twice = setDocxEvenPages(once.bytes, { evenOddDifferent: true });
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    expect(bytesEqual(twice.bytes, once.bytes)).toBe(true);
  });

  it("移除只删旗标元素：其他子保留字节等值、部件永不删", () => {
    const base = addSettingsPart(withDefaultHeader("默认页眉"), SETTINGS_INNER_FLAGGED);
    const out = setDocxEvenPages(base, { evenOddDifferent: false });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.removedParts).toEqual([]);
    const parts = mustUnzip(out.bytes);
    expect(parts.has("word/settings.xml")).toBe(true); // 部件在——永不删。
    expect(decode(parts.get("word/settings.xml")!.data)).toBe(settingsXmlOf(SETTINGS_INNER_PLAIN));
    expect(decode(parts.get("[Content_Types].xml").data)).toContain('PartName="/word/settings.xml"');
  });

  it("新建文件再关闭=旗标无、settings 部件仍与它的布线同在（部件永不删钉）", () => {
    const bare = doc([{ kind: "title", text: "手册" }]);
    const on = setDocxEvenPages(bare, { evenOddDifferent: true });
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    const off = setDocxEvenPages(on.bytes, { evenOddDifferent: false });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    const parts = mustUnzip(off.bytes);
    expect(parts.has("word/settings.xml")).toBe(true);
    expect(/<w:evenAndOddHeaders\b/.test(decode(parts.get("word/settings.xml")!.data))).toBe(false);
    expect(decode(parts.get("[Content_Types].xml").data)).toContain('PartName="/word/settings.xml"');
    expect(/Target="settings\.xml"/.test(decode(parts.get("word/_rels/document.xml.rels")!.data))).toBe(true);
  });

  it("settings.xml 缺席时关闭：零写点幂等（原字节回，不新建部件）", () => {
    const bare = withDefaultHeader();
    const out = setDocxEvenPages(bare, { evenOddDifferent: false });
    // 无旗标无 even 引用 → not_found（关闭语义的诚实出口）。
    expect(out).toEqual({ ok: false, reason: "not_found" });
  });
});

// ---------------------------------------------------------------------------
// R2 — even 档读写：setDocxChromeRef refType="even" 双族 + 读回互证 + 序号纪律
// ---------------------------------------------------------------------------

describe("ω99-263 R2 — even 引用档：双族文本落盘 + verifyChrome 读回互证 + 部件号 max+1", () => {
  it("双族一次落盘：header2/footer1（各自 max+1）+ even 引用在场 + 读回等值 + default 原样", () => {
    const out = setDocxEvenPages(withDefaultHeader("默认页眉"), {
      evenOddDifferent: true,
      evenHeaderText: "偶数页页眉",
      evenFooterText: "偶数页页脚",
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.evenHeaderPartName).toBe("word/header2.xml");
    expect(out.evenHeaderPartCreated).toBe(true);
    expect(out.evenFooterPartName).toBe("word/footer1.xml");
    expect(out.evenFooterPartCreated).toBe(true);
    const sect = bodySectInner(out.bytes);
    expect(/<w:headerReference\b[^>]*w:type="even"/.test(sect)).toBe(true);
    expect(/<w:footerReference\b[^>]*w:type="even"/.test(sect)).toBe(true);
    // 读回互证（verifyChrome 同构——「已设置」从读回来）。
    expect(chromeText(out.bytes, "header", "even")).toBe("偶数页页眉");
    expect(chromeText(out.bytes, "footer", "even")).toBe("偶数页页脚");
    expect(chromeText(out.bytes, "header", "default")).toBe("默认页眉");
    expect(hasEvenOddFlag(out.bytes)).toBe(true);
  });

  it("覆写幂等：再设 even 双文本 → 部件数不增（created=false、部件名稳定）", () => {
    const a = setDocxEvenPages(withDefaultHeader("默认页眉"), { evenOddDifferent: true, evenHeaderText: "第一版" });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const b = setDocxEvenPages(a.bytes, { evenOddDifferent: true, evenHeaderText: "第二版" });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.evenHeaderPartName).toBe("word/header2.xml");
    expect(b.evenHeaderPartCreated).toBe(false);
    const names = [...mustUnzip(b.bytes).keys()].filter((n) => /^word\/header\d+\.xml$/.test(n));
    expect(names).toEqual(["word/header1.xml", "word/header2.xml"]);
    expect(chromeText(b.bytes, "header", "even")).toBe("第二版");
  });

  it("碰撞纪律：裸文档无既有部件 → even header 落 header1.xml（max+1 从零起）", () => {
    const out = setDocxEvenPages(doc([{ kind: "title", text: "裸" }]), { evenOddDifferent: true, evenHeaderText: "左页" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.evenHeaderPartName).toBe("word/header1.xml");
    expect(chromeText(out.bytes, "header", "even")).toBe("左页");
  });
});

// ---------------------------------------------------------------------------
// R3 — setDocxEvenPages true：旗标+双文本原子 + 单面缺席跳过 + typed 拒
// ---------------------------------------------------------------------------

describe("ω99-263 R3 — true 路径：原子开关 + 文本可选 + typed 拒族", () => {
  it("纯开关（零文本）：只立旗标零引用新建；回执「奇偶页不同已开启（未设偶数页专属页眉/页脚）」", async () => {
    const dir = await mkdtemp(join(tmpdir(), "o263-on-"));
    const rel = "书.docx";
    await writeFile(join(dir, rel), withDefaultHeader("默认页眉"));
    const tool = createSetDocxEvenPagesTool(dir);
    const res = await exec(tool, { path: rel, evenOddDifferent: true });
    expect(res.isError).toBeFalsy();
    expect(res.content.split("\n")[0]).toBe("奇偶页不同已开启（未设偶数页专属页眉/页脚）");
    expect(extractFileReceipt("set_docx_even_pages", res.content)).toBeDefined();
    const tail = JSON.parse(res.content.split("\n").at(-1)!);
    expect(tail.evenOddDifferent).toBe(true);
    expect(tail.evenHeaderText).toBeUndefined();
    expect(Object.keys(tail).sort()).toEqual(["bytes", "evenOddDifferent", "path", "relativePath"]);
    // 盘上互证：旗标在、无 even 引用新建。
    const onDisk = await readFile(join(dir, rel));
    expect(hasEvenOddFlag(onDisk)).toBe(true);
    expect(/w:type="even"/.test(decode(onDisk))).toBe(false);
  });

  it("双文本回执变体：header-only「偶数页页眉：「X」」/ 双文本「X」；「Y」」/ 20 字预览帽", async () => {
    const dir = await mkdtemp(join(tmpdir(), "o263-on-t-"));
    const tool = createSetDocxEvenPagesTool(dir);
    const relA = "a.docx";
    await writeFile(join(dir, relA), withDefaultHeader());
    const hOnly = await exec(tool, { path: relA, evenOddDifferent: true, evenHeaderText: "左页书名" });
    expect(hOnly.isError).toBeFalsy();
    expect(hOnly.content.split("\n")[0]).toBe("奇偶页不同已开启（偶数页页眉：「左页书名」）");
    const relB = "b.docx";
    await writeFile(join(dir, relB), withDefaultHeader());
    const both = await exec(tool, { path: relB, evenOddDifferent: true, evenHeaderText: "左页书名", evenFooterText: "左页页脚" });
    expect(both.content.split("\n")[0]).toBe("奇偶页不同已开启（偶数页页眉：「左页书名」；偶数页页脚：「左页页脚」）");
    const relC = "c.docx";
    await writeFile(join(dir, relC), withDefaultHeader());
    const long = await exec(tool, { path: relC, evenOddDifferent: true, evenHeaderText: "字".repeat(21) });
    expect(long.content.split("\n")[0]).toBe(`奇偶页不同已开启（偶数页页眉：「${"字".repeat(20)}…」）`);
    // 盘上互证：even 链读回等值。
    expect(chromeText(await readFile(join(dir, relA)), "header", "even")).toBe("左页书名");
  });

  it("typed 拒族（纯层逐字）：布尔拒 / 空串 / 控制字符 / 4001 码点——全程零写盘", async () => {
    const dir = await mkdtemp(join(tmpdir(), "o263-rej-"));
    const rel = "报告.docx";
    const before = withDefaultHeader("默认页眉");
    await writeFile(join(dir, rel), before);
    const tool = createSetDocxEvenPagesTool(dir);
    expect((await exec(tool, { path: rel, evenOddDifferent: "yes" })).content).toContain('"evenOddDifferent" must be a boolean');
    expect((await exec(tool, { path: rel, evenOddDifferent: true, evenHeaderText: "  " })).content).toContain('"evenHeaderText" must be a non-empty string');
    expect((await exec(tool, { path: rel, evenOddDifferent: true, evenHeaderText: "a\x01b" })).content).toContain("control character");
    expect((await exec(tool, { path: rel, evenOddDifferent: true, evenFooterText: "字".repeat(4001) })).content).toContain("limited to 4000");
    expect(bytesEqual(await readFile(join(dir, rel)), before)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R4 — false 关闭：拒文本逐字 / 旗标删+even 双族清 / 缺席跳过 / not_found
// ---------------------------------------------------------------------------

describe("ω99-263 R4 — false 路径：一键回全篇一致", () => {
  it("typed 拒逐字：false 带文本=参数矛盾（header/footer 各自文案）", () => {
    expect(validateDocxEvenPages(false, "x", undefined)).toEqual({
      ok: false,
      error: '关闭奇偶页不同时不接受 "evenHeaderText"——关闭即回到与其他页相同的页眉',
    });
    expect(validateDocxEvenPages(false, undefined, "y")).toEqual({
      ok: false,
      error: '关闭奇偶页不同时不接受 "evenFooterText"——关闭即回到与其他页相同的页脚',
    });
    expect(validateDocxEvenPages(false)).toEqual({ ok: true, evenOddDifferent: false });
  });

  it("双在场：旗标删 + even 引用双族四清（removedParts 先 header 后 footer）+ default 不动 + 回执「奇偶页不同已关闭」", async () => {
    const on = setDocxEvenPages(withDefaultHeader("默认页眉"), {
      evenOddDifferent: true,
      evenHeaderText: "左页页眉",
      evenFooterText: "左页页脚",
    });
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    const off = setDocxEvenPages(on.bytes, { evenOddDifferent: false });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.evenOddDifferent).toBe(false);
    expect(off.removedParts).toEqual(["word/header2.xml", "word/footer1.xml"]);
    const parts = mustUnzip(off.bytes);
    const document = decode(parts.get("word/document.xml")!.data);
    expect(/w:type="even"/.test(document)).toBe(false);
    expect(hasEvenOddFlag(off.bytes)).toBe(false);
    expect(parts.has("word/header2.xml")).toBe(false);
    expect(parts.has("word/footer1.xml")).toBe(false);
    expect(/Target="header2\.xml"/.test(decode(parts.get("word/_rels/document.xml.rels")!.data))).toBe(false);
    expect(decode(parts.get("[Content_Types].xml").data)).not.toContain('PartName="/word/footer1.xml"');
    // default 引用族不动（回到全篇一致=每页普通页眉还在）。
    expect(/<w:headerReference\b[^>]*w:type="default"/.test(document)).toBe(true);
    expect(parts.has("word/header1.xml")).toBe(true);
    expect(chromeText(off.bytes, "header", "default")).toBe("默认页眉");
    // 工具面回执。
    const dir = await mkdtemp(join(tmpdir(), "o263-off-"));
    const rel = "书.docx";
    await writeFile(join(dir, rel), on.bytes);
    const res = await exec(createSetDocxEvenPagesTool(dir), { path: rel, evenOddDifferent: false });
    expect(res.isError).toBeFalsy();
    expect(res.content.split("\n")[0]).toBe("奇偶页不同已关闭");
    expect(extractFileReceipt("set_docx_even_pages", res.content)).toBeDefined();
  });

  it("单面在场：缺席面跳过不构成 not_found（开关语义=回到全篇一致）", () => {
    const on = setDocxEvenPages(withDefaultHeader("默认页眉"), { evenOddDifferent: true, evenHeaderText: "左页" });
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    const off = setDocxEvenPages(on.bytes, { evenOddDifferent: false });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.removedParts).toEqual(["word/header2.xml"]);
    expect(/w:type="even"/.test(decode(mustUnzip(off.bytes).get("word/document.xml")!.data))).toBe(false);
  });

  it("纯旗标在场（手术造，无 even 引用）：只删旗标零报错、settings 部件保留", () => {
    const base = addSettingsPart(withDefaultHeader("默认页眉"), SETTINGS_INNER_FLAGGED);
    const off = setDocxEvenPages(base, { evenOddDifferent: false });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.removedParts).toEqual([]);
    expect(hasEvenOddFlag(off.bytes)).toBe(false);
    expect(mustUnzip(off.bytes).has("word/settings.xml")).toBe(true);
  });

  it("双缺=not_found：裸文档（无旗标无 even 引用）typed 拒零写盘 + 工具面「本就没有设置」", async () => {
    expect(setDocxEvenPages(doc([{ kind: "title", text: "素" }]), { evenOddDifferent: false })).toEqual({ ok: false, reason: "not_found" });
    const dir = await mkdtemp(join(tmpdir(), "o263-nf-"));
    const rel = "素.docx";
    const before = withDefaultHeader("默认页眉");
    await writeFile(join(dir, rel), before);
    const res = await exec(createSetDocxEvenPagesTool(dir), { path: rel, evenOddDifferent: false });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("本就没有设置奇偶页不同");
    expect(bytesEqual(await readFile(join(dir, rel)), before)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R5 — clear refType="even"：清两族 even 引用 + 旗标不动（职责分离直证）
// ---------------------------------------------------------------------------

describe("ω99-263 R5 — clear_docx_header 的 even 档：引用/部件/rels/CT 四清 + 旗标不动", () => {
  it("header even 定向四清：even 引用族删尽 + default 原样 + evenAndOddHeaders 旗标不动（直证钉）", () => {
    const on = setDocxEvenPages(withDefaultHeader("默认页眉"), { evenOddDifferent: true, evenHeaderText: "左页页眉" });
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    const out = clearDocxChrome(on.bytes, "header", "even");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.removedParts).toEqual(["word/header2.xml"]);
    const parts = mustUnzip(out.bytes);
    const document = decode(parts.get("word/document.xml")!.data);
    expect(/<w:headerReference\b[^>]*w:type="even"/.test(document)).toBe(false);
    expect(/<w:headerReference\b[^>]*w:type="default"/.test(document)).toBe(true);
    expect(parts.has("word/header2.xml")).toBe(false);
    expect(/Target="header2\.xml"/.test(decode(parts.get("word/_rels/document.xml.rels")!.data))).toBe(false);
    expect(decode(parts.get("[Content_Types].xml").data)).not.toContain('PartName="/word/header2.xml"');
    // 旗标不动（文档级开关归 set_docx_even_pages，clear 只管引用面）。
    expect(hasEvenOddFlag(out.bytes)).toBe(true);
    expect(chromeText(out.bytes, "header", "even")).toBeUndefined();
    expect(chromeText(out.bytes, "header", "default")).toBe("默认页眉");
  });

  it("footer even 同缝四清（双族变体）", () => {
    const on = setDocxEvenPages(withDefaultFooter("第 1 页"), { evenOddDifferent: true, evenFooterText: "左页脚" });
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    const out = clearDocxChrome(on.bytes, "footer", "even");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.removedParts).toEqual(["word/footer2.xml"]);
    expect(/<w:footerReference\b[^>]*w:type="even"/.test(decode(mustUnzip(out.bytes).get("word/document.xml")!.data))).toBe(false);
    expect(hasEvenOddFlag(out.bytes)).toBe(true);
    expect(chromeText(out.bytes, "footer", "default")).toBe("第 1 页");
  });

  it("共享部件守卫：default+even 同引一个部件 → clear(even) 引用删、部件/rels/CT 保留", () => {
    const shared = shareDefaultRefAsEven(withDefaultHeader("共用页眉"), "header");
    const out = clearDocxChrome(shared, "header", "even");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.removedParts).toEqual([]);
    const parts = mustUnzip(out.bytes);
    expect(/<w:headerReference\b[^>]*w:type="even"/.test(decode(parts.get("word/document.xml")!.data))).toBe(false);
    expect(parts.has("word/header1.xml")).toBe(true);
    expect(chromeText(out.bytes, "header", "default")).toBe("共用页眉");
  });

  it("工具面：refType=even 收据「已删除偶数页页眉」+ 旗标不动 + 值域拒换新文案", async () => {
    const dir = await mkdtemp(join(tmpdir(), "o263-clear-"));
    const rel = "书.docx";
    const on = setDocxEvenPages(withDefaultHeader("默认页眉"), { evenOddDifferent: true, evenHeaderText: "左页" });
    expect(on.ok).toBe(true);
    await writeFile(join(dir, rel), on.bytes);
    const tool = createClearDocxHeaderTool(dir);
    const res = await exec(tool, { path: rel, refType: "even" });
    expect(res.isError).toBeFalsy();
    expect(res.content.split("\n")[0]).toBe("已删除偶数页页眉");
    expect(extractFileReceipt("clear_docx_header", res.content)).toBeDefined();
    // 旗标不动 + 盘上 even 链真断。
    const reread = await readFile(join(dir, rel));
    expect(hasEvenOddFlag(reread)).toBe(true);
    expect(/<w:headerReference\b[^>]*w:type="even"/.test(decode(reread))).toBe(false);
    // 非法值域拒（新文案含 even）+ 零写盘。
    await writeFile(join(dir, "b.docx"), on.bytes);
    const bad = await exec(tool, { path: "b.docx", refType: "odd" });
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain('"refType" must be "default", "first" or "even"');
    expect(bytesEqual(await readFile(join(dir, "b.docx")), on.bytes)).toBe(true);
    // 再删 even=not-found 诚实出口（偶数页插值文案）。
    const nf = await exec(tool, { path: rel, refType: "even" });
    expect(nf.isError).toBe(true);
    expect(nf.content).toContain("本就没有偶数页页眉");
  });
});

// ---------------------------------------------------------------------------
// R6 — 零演进钉：default/first 两档不碰 settings.xml + 字节保真
// ---------------------------------------------------------------------------

describe("ω99-263 R6 — 零演进：非 even 面零 settings.xml 漂移 + smartZip 直通透传", () => {
  it("default/first 路径零漂移：set_docx_header / set_docx_first_page / clear 全程不造不碰 settings.xml", () => {
    const bare = doc([{ kind: "title", text: "简历" }]);
    const withHeader = setDocxChrome(bare, "header", "公司机密");
    expect(withHeader.ok).toBe(true);
    expect(mustUnzip(withHeader.bytes).has("word/settings.xml")).toBe(false);
    const first = setDocxFirstPage(withHeader.bytes, { firstDifferent: true, headerText: "首页" });
    expect(first.ok).toBe(true);
    expect(mustUnzip(first.bytes).has("word/settings.xml")).toBe(false);
    const cleared = clearDocxChrome(withHeader.bytes, "header", "default");
    expect(cleared.ok).toBe(true);
    expect(mustUnzip(cleared.bytes).has("word/settings.xml")).toBe(false);
    // （first/default 两档行为字节不变的完整直证=256/259 件全绿——solo 清单跑。）
  });

  it("字节保真：deflate 重装包上开旗标，未触及条目 method/raw/data 三等 + 条目序原样", () => {
    const base = addSettingsPart(withDefaultHeader("默认页眉"), SETTINGS_INNER_PLAIN);
    const repacked = deflatedZip([...mustUnzip(base).values()].map((e) => ({ name: e.name, data: e.data })));
    const out = setDocxEvenPages(repacked, { evenOddDifferent: true });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const before = [...mustUnzip(repacked).values()];
    const after = mustUnzip(out.bytes);
    expect([...after.keys()]).toEqual(before.map((e) => e.name)); // 条目序原样（settings 在场改内容、无新部件）。
    // 本操作唯一改件=word/settings.xml；其余条目（含 deflate 原 method 8）逐字节直过。
    for (const e of before) {
      if (e.name === "word/settings.xml") continue;
      const a = after.get(e.name)!;
      expect(a.method).toBe(e.method);
      expect(bytesEqual(a.raw, e.raw)).toBe(true);
      expect(bytesEqual(a.data, e.data)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// R7 — census 邻接：名册四缝 +1 + 挂载 append-only 尾 + 摘要/回执/权限
// ---------------------------------------------------------------------------

describe("ω99-263 R7 — census 邻接（名册四缝/挂载序/摘要器/权限域）", () => {
  const stubModel = { stream: async function* () { /* never invoked */ } } as unknown as never;
  const gate = async (): Promise<{ behavior: "allow" }> => ({ behavior: "allow" });
  const build = (): Tool[] =>
    buildToolSet({ workspaceRoot: "/tmp/ws", model: stubModel, canUseTool: gate, contextWindowTokens: 64_000 });

  it("写册 14 / 回执册同 / 摘要器键 17——四缝数值演进恰 +1", () => {
    expect(DOC_SUITE_EDIT_TOOLS.length).toBe(14);
    expect(DOC_SUITE_EDIT_TOOLS.slice(-5)).toEqual([
      "set_docx_header", "set_pptx_notes", "clear_docx_header", "set_docx_first_page", "set_docx_even_pages",
    ]);
    expect([...DOC_SUITE_RECEIPT_TOOLS]).toEqual([...DOC_SUITE_EDIT_TOOLS]);
    expect(Object.keys(docSuiteSummarizers).length).toBe(17);
  });

  it("挂载 append-only 尾：set_docx_first_page+1=set_docx_even_pages → task", () => {
    const names = build().map((t) => t.name);
    expect(names[names.indexOf("set_docx_first_page") + 1]).toBe("set_docx_even_pages");
    expect(names[names.indexOf("set_docx_even_pages") + 1]).toBe("task");
  });

  it("摘要器 + 权限域 + 回执名门：新员三缝全进", () => {
    expect(summarizeSetDocxEvenPages({ path: "a/书.docx", evenOddDifferent: true })).toBe("书.docx 奇偶页设为不同");
    expect(summarizeSetDocxEvenPages({ path: "a/书.docx", evenOddDifferent: false })).toBe("书.docx 奇偶页设为相同");
    expect(summarizeToolCall("set_docx_even_pages", { path: "a/书.docx", evenOddDifferent: true, evenHeaderText: "x" })).toBe("书.docx 奇偶页设为不同");
    expect(FILE_EDIT_TOOLS.has("set_docx_even_pages")).toBe(true);
    const receipt =
      "奇偶页不同已开启\n" + JSON.stringify({ path: "/tmp/ws/书.docx", relativePath: "书.docx", evenOddDifferent: true, bytes: 1234 });
    expect(extractFileReceipt("set_docx_even_pages", receipt)).toBeDefined();
  });
});
