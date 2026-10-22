// ω99-124 — A: doc-pptx 纯层（DocDeck 三版式校验 + minimal pptx 组装）。
// typed 拒矩阵 + 九部件读回 + slide XML 语义 + theme 静态串逐字钉 + 字节确定性。
// RED-first：本文件先落，doc-pptx.ts 尚不存在。
import { describe, it, expect } from "vitest";
import { crc32 } from "../src/doc-zip.js";
import { validateDocDeck, buildPptx, defaultPptxFilename } from "../src/doc-pptx.js";
import { validateDocTable } from "../src/doc-xlsx.js"; // 对照钉：cell 规与 123 两侧一致

const u16 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number): number =>
  (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

/** 测试内极简 zip 读回器：EOCD → central directory → {name, data}[]（123 同款）。 */
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

/** 三版式各一页（含五实体转义与 CJK 覆盖）。 */
const DECK = {
  slides: [
    { kind: "cover", title: "季度汇报", subtitle: "2026 & Q3" },
    { kind: "bullets", title: "要点 <页>", bullets: ["第一条 & 第二条", `<说 "你好"> & 再见`, "收尾"] },
    {
      kind: "table",
      title: "盘点",
      columns: [{ header: "名称 & 规格" }, { header: "数量" }],
      rows: [["键盘 & 鼠标", 12], ["<A&B>", null], [true, false]],
    },
  ],
};

const tableSlide = (rows: unknown[][]): unknown => ({
  kind: "table",
  title: "t",
  columns: [{ header: "a" }, { header: "b" }],
  rows,
});

describe("ω99-124 A — validateDocDeck typed 拒矩阵", () => {
  const bad = (raw: unknown): string => {
    const r = validateDocDeck(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    return r.error;
  };

  it("happy：三版式各一页全过；未知键忽略（policy 面不挖嵌套，同 123）", () => {
    const r = validateDocDeck(DECK);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.deck.slides.length).toBe(3);
      expect(r.deck.slides[0]!.kind).toBe("cover");
      expect(r.deck.slides[1]!.kind).toBe("bullets");
      expect(r.deck.slides[2]!.kind).toBe("table");
    }
    expect(validateDocDeck({ slides: [{ ...DECK.slides[0], extra: 1 }] }).ok).toBe(true);
  });

  it("形状拒：非对象 / 缺 slides / slides 非数组 / 空数组 / 21 页（20 页收）", () => {
    for (const raw of [null, 42, "deck", [], ["x"]]) bad(raw);
    bad({});
    bad({ slides: "x" });
    bad({ slides: [] });
    bad({ slides: Array.from({ length: 21 }, () => DECK.slides[0]) });
    expect(validateDocDeck({ slides: Array.from({ length: 20 }, () => DECK.slides[0]) }).ok).toBe(true);
  });

  it("slide 拒：非对象 / 缺 kind / kind 非字符串 / kind 未知（错误列三版式）", () => {
    bad({ slides: [7] });
    bad({ slides: ["cover"] });
    bad({ slides: [{ title: "t" }] });
    bad({ slides: [{ kind: 7, title: "t" }] });
    const msg = bad({ slides: [{ kind: "quote", title: "t" }] });
    expect(msg).toContain("cover");
    expect(msg).toContain("bullets");
    expect(msg).toContain("table");
  });

  it("cover 拒：title 缺/空/非字符串/控制字符；subtitle 非字符串/空/控制字符", () => {
    bad({ slides: [{ kind: "cover" }] });
    bad({ slides: [{ kind: "cover", title: "" }] });
    bad({ slides: [{ kind: "cover", title: 7 }] });
    bad({ slides: [{ kind: "cover", title: "a\x07b" }] });
    bad({ slides: [{ kind: "cover", title: "t", subtitle: 7 }] });
    bad({ slides: [{ kind: "cover", title: "t", subtitle: "" }] });
    bad({ slides: [{ kind: "cover", title: "t", subtitle: "a\x0Bb" }] });
    expect(validateDocDeck({ slides: [{ kind: "cover", title: "t" }] }).ok).toBe(true); // subtitle 可缺省
  });

  it("bullets 拒：缺/非数组/空数组/7 条（6 条收）/条目非字符串/空串/控制字符", () => {
    bad({ slides: [{ kind: "bullets", title: "t" }] });
    bad({ slides: [{ kind: "bullets", title: "t", bullets: "x" }] });
    bad({ slides: [{ kind: "bullets", title: "t", bullets: [] }] });
    bad({ slides: [{ kind: "bullets", title: "t", bullets: Array.from({ length: 7 }, () => "x") }] });
    expect(validateDocDeck({ slides: [{ kind: "bullets", title: "t", bullets: Array.from({ length: 6 }, () => "x") }] }).ok).toBe(true);
    bad({ slides: [{ kind: "bullets", title: "t", bullets: [7] }] });
    bad({ slides: [{ kind: "bullets", title: "t", bullets: ["a", ""] }] });
    bad({ slides: [{ kind: "bullets", title: "t", bullets: ["a\x1Fb"] }] });
    // bullets 页 title 同 cover 规。
    bad({ slides: [{ kind: "bullets", bullets: ["a"] }] });
    bad({ slides: [{ kind: "bullets", title: "", bullets: ["a"] }] });
  });

  it("table 拒：columns 缺/空/65 列（64 收）/header 非字符串/空/控制字符；rows 缺/501 行（500 收）/行非数组/行比列多", () => {
    const cols = (n: number) => Array.from({ length: n }, () => ({ header: "a" }));
    bad({ slides: [{ kind: "table", title: "t", rows: [] }] });
    bad({ slides: [{ kind: "table", title: "t", columns: [], rows: [] }] });
    bad({ slides: [{ kind: "table", title: "t", columns: cols(65), rows: [] }] });
    expect(validateDocDeck({ slides: [{ kind: "table", title: "t", columns: cols(64), rows: [] }] }).ok).toBe(true);
    bad({ slides: [{ kind: "table", title: "t", columns: [{ header: 7 }], rows: [] }] });
    bad({ slides: [{ kind: "table", title: "t", columns: [{ header: "" }], rows: [] }] });
    bad({ slides: [{ kind: "table", title: "t", columns: [{ header: "a\x00b" }], rows: [] }] });
    bad({ slides: [{ kind: "table", title: "t", columns: cols(1) }] });
    bad({ slides: [{ kind: "table", title: "t", columns: cols(1), rows: Array.from({ length: 501 }, () => [1]) }] });
    expect(validateDocDeck({ slides: [{ kind: "table", title: "t", columns: cols(1), rows: Array.from({ length: 500 }, () => [1]) }] }).ok).toBe(true);
    bad({ slides: [{ kind: "table", title: "t", columns: cols(1), rows: ["row"] }] });
    bad({ slides: [{ kind: "table", title: "t", columns: cols(2), rows: [[1, 2, 3]] }] }); // 行比列多=拒
    expect(validateDocDeck({ slides: [{ kind: "table", title: "t", columns: cols(2), rows: [[1]] }] }).ok).toBe(true); // 短行=补 null
  });

  it("cell 拒（与 doc-xlsx 同规）：非四形 / NaN / Infinity / 控制字符；\\t \\n \\r 放行", () => {
    bad({ slides: [tableSlide([[{}]])] });
    bad({ slides: [tableSlide([[undefined]])] });
    bad({ slides: [tableSlide([[NaN]])] });
    bad({ slides: [tableSlide([[Infinity]])] });
    for (const ctrl of ["\x00", "\x01", "\x07", "\x08", "\x0B", "\x0C", "\x0E", "\x1F"]) {
      bad({ slides: [tableSlide([[`a${ctrl}b`]])] });
    }
    expect(validateDocDeck({ slides: [tableSlide([["a\tb\nc\rd", 1]])] }).ok).toBe(true);
  });

  it("对照钉：cell 收/拒与 validateDocTable 逐值一致（两侧同规的机器证）", () => {
    const cells: unknown[] = ["ok", "", "a\tb", 0, 12.5, true, false, null, {}, [], NaN, Infinity, "a\x07b", "\x00", undefined, () => 1];
    for (const v of cells) {
      const x = validateDocTable({ columns: [{ header: "a" }], rows: [[v]] });
      const p = validateDocDeck({ slides: [tableSlide([[v, v]])] });
      expect(p.ok).toBe(x.ok);
    }
  });
});

describe("ω99-124 A — buildPptx 部件清单与 presentation 骨架（读回断言）", () => {
  const deck = (): { slides: { kind: string }[] } => {
    const r = validateDocDeck(DECK);
    if (!r.ok) throw new Error("fixture must validate");
    return r.deck as unknown as { slides: { kind: string }[] };
  };
  const pptx = (): Uint8Array => buildPptx(deck());

  it("部件清单齐且顺序固定（九件套：pptx 比 xlsx 多 master/layout/theme 三层）", () => {
    expect(readZip(pptx()).map((f) => f.name)).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "docProps/core.xml",
      "docProps/app.xml",
      "ppt/presentation.xml",
      "ppt/_rels/presentation.xml.rels",
      "ppt/slideMasters/slideMaster1.xml",
      "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      "ppt/slideLayouts/slideLayout1.xml",
      "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      "ppt/theme/theme1.xml",
      "ppt/slides/slide1.xml",
      "ppt/slides/_rels/slide1.xml.rels",
      "ppt/slides/slide2.xml",
      "ppt/slides/_rels/slide2.xml.rels",
      "ppt/slides/slide3.xml",
      "ppt/slides/_rels/slide3.xml.rels",
    ]);
  });

  it("[Content_Types]：overrides 覆盖 presentation/master/layout/theme/每页 slide + docProps", () => {
    const ct = text(pptx(), "[Content_Types].xml");
    expect(ct).toContain('PartName="/ppt/presentation.xml"');
    expect(ct).toContain("application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml");
    expect(ct).toContain('PartName="/ppt/slideMasters/slideMaster1.xml"');
    expect(ct).toContain("presentationml.slideMaster+xml");
    expect(ct).toContain('PartName="/ppt/slideLayouts/slideLayout1.xml"');
    expect(ct).toContain("presentationml.slideLayout+xml");
    expect(ct).toContain('PartName="/ppt/theme/theme1.xml"');
    expect(ct).toContain("application/vnd.openxmlformats-officedocument.theme+xml");
    expect(ct).toContain('PartName="/ppt/slides/slide1.xml"');
    expect(ct).toContain('PartName="/ppt/slides/slide2.xml"');
    expect(ct).toContain('PartName="/ppt/slides/slide3.xml"');
    expect(ct).toContain("presentationml.slide+xml");
    expect(ct).toContain('PartName="/docProps/core.xml"');
    expect(ct).toContain('PartName="/docProps/app.xml"');
  });

  it("presentation.xml：sldMasterIdLst 1 个；sldIdLst 3 页 id 从 256 起；sldSz 16:9 EMU；notesSz", () => {
    const p = text(pptx(), "ppt/presentation.xml");
    expect(p).toContain('<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>');
    expect(p).toContain('<p:sldId id="256" r:id="rId2"/>');
    expect(p).toContain('<p:sldId id="257" r:id="rId3"/>');
    expect(p).toContain('<p:sldId id="258" r:id="rId4"/>');
    expect(p.match(/<p:sldId /g)?.length).toBe(3);
    expect(p).toContain('<p:sldSz cx="12192000" cy="6858000"/>');
    expect(p).toContain("<p:notesSz ");
  });

  it("presentation.xml.rels：master rId1 → 各页 rId2.. → theme 收尾；_rels/.rels 三角", () => {
    const r = text(pptx(), "ppt/_rels/presentation.xml.rels");
    expect(r).toContain('Id="rId1"');
    expect(r).toContain('Target="slideMasters/slideMaster1.xml"');
    expect(r).toContain('Target="slides/slide1.xml"');
    expect(r).toContain('Target="slides/slide2.xml"');
    expect(r).toContain('Target="slides/slide3.xml"');
    expect(r).toContain('Target="theme/theme1.xml"');
    const root = text(pptx(), "_rels/.rels");
    expect(root).toContain('Target="ppt/presentation.xml"');
    expect(root).toContain('Target="docProps/core.xml"');
    expect(root).toContain('Target="docProps/app.xml"');
  });

  it("master/layout 三层：blank 版式；各自 rels 指对（layout→master，master→layout+theme）", () => {
    const layout = text(pptx(), "ppt/slideLayouts/slideLayout1.xml");
    expect(layout).toContain('type="blank"');
    expect(layout).toContain("<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>");
    expect(text(pptx(), "ppt/slideLayouts/_rels/slideLayout1.xml.rels")).toContain('Target="../slideMasters/slideMaster1.xml"');
    const master = text(pptx(), "ppt/slideMasters/slideMaster1.xml");
    expect(master).toContain("<p:clrMap ");
    expect(master).toContain("<p:txStyles>");
    expect(text(pptx(), "ppt/slideMasters/_rels/slideMaster1.xml.rels")).toContain('Target="../slideLayouts/slideLayout1.xml"');
    expect(text(pptx(), "ppt/slideMasters/_rels/slideMaster1.xml.rels")).toContain('Target="../theme/theme1.xml"');
    // 每页 slide 的 rels 都指向唯一版式。
    for (let i = 1; i <= 3; i++) {
      expect(text(pptx(), `ppt/slides/_rels/slide${i}.xml.rels`)).toContain('Target="../slideLayouts/slideLayout1.xml"');
    }
  });

  it("docProps：时间钉常量（全包无第二个时刻渗入）+ creator=wudao", () => {
    const core = text(pptx(), "docProps/core.xml");
    expect(core).toContain("2026-01-01T00:00:00Z");
    const dates = core.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g) ?? [];
    expect(dates).toEqual(["2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]);
    expect(core).toContain("<dc:creator>wudao</dc:creator>");
  });

  it("20 页上限内：sldIdLst 计数随页数增长，id 连续从 256", () => {
    const big = validateDocDeck({ slides: Array.from({ length: 20 }, () => DECK.slides[0]) });
    if (!big.ok) throw new Error("unreachable");
    const p = text(buildPptx(big.deck), "ppt/presentation.xml");
    expect(p.match(/<p:sldId /g)?.length).toBe(20);
    expect(p).toContain(`<p:sldId id="${256 + 19}"`);
  });
});

describe("ω99-124 A — slide XML 语义（cover/bullets/table 三形断言）", () => {
  const pptx = (): Uint8Array => {
    const r = validateDocDeck(DECK);
    if (!r.ok) throw new Error("fixture must validate");
    return buildPptx(r.deck);
  };

  it("cover：标题居中大字 sz=4000；副标题小字 sz=1600；五实体转义 + CJK 原样", () => {
    const s = text(pptx(), "ppt/slides/slide1.xml");
    expect(s).toContain('sz="4000"');
    expect(s).toContain("季度汇报"); // CJK 原样
    expect(s).toContain('algn="ctr"');
    expect(s).toContain('anchor="ctr"');
    expect(s).toContain('sz="1600"');
    expect(s).toContain("2026 &amp; Q3"); // 五实体之 &amp;
    // 无副标题的封面不写副标题段。
    const bare = validateDocDeck({ slides: [{ kind: "cover", title: "t" }] });
    if (!bare.ok) throw new Error("unreachable");
    expect(text(buildPptx(bare.deck), "ppt/slides/slide1.xml")).not.toContain('sz="1600"');
  });

  it("bullets：标题顶部 sz=2800；要点 buChar • sz=1800；转义 &lt; &quot; &amp;", () => {
    const s = text(pptx(), "ppt/slides/slide2.xml");
    expect(s).toContain('sz="2800"');
    expect(s).toContain("要点 &lt;页&gt;");
    expect(s).toContain('<a:buChar char="•"/>');
    expect(s).toContain('sz="1800"');
    expect(s).toContain("第一条 &amp; 第二条");
    expect(s).toContain("&lt;说 &quot;你好&quot;&gt; &amp; 再见");
    expect(s).not.toContain('sz="4000"'); // 要点页无封面字号
  });

  it("table：graphicFrame a:tbl；gridCol=列数；表头 b=\"1\" 加粗；cell 四形；短行补齐 tc 数", () => {
    const s = text(pptx(), "ppt/slides/slide3.xml");
    expect(s).toContain("<p:graphicFrame>");
    expect(s).toContain('<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">');
    expect(s).toContain("<a:tbl>");
    expect(s.match(/<a:gridCol /g)?.length).toBe(2);
    expect(s).toContain("<a:tr ");
    expect(s).toContain('sz="1200"');
    // 表头行：b="1" 加粗 run。
    expect(s).toMatch(/<a:r><a:rPr[^>]*sz="1200" b="1"[^>]*\/><a:t>名称 &amp; 规格<\/a:t><\/a:r>/);
    // 正文：字符串转义、数字 String、布尔 true/false、null 空段。
    expect(s).toContain("<a:t>键盘 &amp; 鼠标</a:t>");
    expect(s).toContain("<a:t>12</a:t>");
    expect(s).toContain("<a:t>&lt;A&amp;B&gt;</a:t>");
    expect(s).toContain("<a:t>true</a:t>");
    expect(s).toContain("<a:t>false</a:t>");
    expect(s).toContain("<a:p/>");
    // 短行（1 cell 2 列）：补齐后每个 tr 的 tc 数=列数。
    const short = validateDocDeck({
      slides: [{ kind: "table", title: "t", columns: [{ header: "a" }, { header: "b" }], rows: [[1]] }],
    });
    if (!short.ok) throw new Error("unreachable");
    const ss = text(buildPptx(short.deck), "ppt/slides/slide1.xml");
    for (const tr of ss.match(/<a:tr [^>]*>(.*?)<\/a:tr>/g) ?? []) {
      expect(tr.match(/<a:tc>/g)?.length).toBe(2);
    }
  });

  it("theme1.xml 静态串逐字钉（钉死 Office 主题模板，不含任何动内容）", () => {
    expect(text(pptx(), "ppt/theme/theme1.xml")).toBe(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="wudao">' +
        "<a:themeElements>" +
        '<a:clrScheme name="wudao">' +
        '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
        '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
        '<a:dk2><a:srgbClr val="44546A"/></a:dk2>' +
        '<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
        '<a:accent1><a:srgbClr val="4472C4"/></a:accent1>' +
        '<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>' +
        '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>' +
        '<a:accent4><a:srgbClr val="FFC000"/></a:accent4>' +
        '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>' +
        '<a:accent6><a:srgbClr val="70AD47"/></a:accent6>' +
        '<a:hlink><a:srgbClr val="0563C1"/></a:hlink>' +
        '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>' +
        "</a:clrScheme>" +
        '<a:fontScheme name="wudao">' +
        '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
        '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>' +
        "</a:fontScheme>" +
        '<a:fmtScheme name="wudao">' +
        "<a:fillStyleLst>" +
        "<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>" +
        '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="67000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:tint val="81000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>' +
        '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="94000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>' +
        "</a:fillStyleLst>" +
        "<a:lnStyleLst>" +
        '<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>' +
        '<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>' +
        '<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>' +
        "</a:lnStyleLst>" +
        "<a:effectStyleLst>" +
        '<a:effectStyle><a:effectLst><a:outerShdw blurRad="40000" dist="20000" dir="5400000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="38000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle>' +
        '<a:effectStyle><a:effectLst><a:outerShdw blurRad="40000" dist="23000" dir="5400000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="35000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle>' +
        '<a:effectStyle><a:effectLst><a:outerShdw blurRad="40000" dist="23000" dir="5400000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="35000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle>' +
        "</a:effectStyleLst>" +
        "<a:bgFillStyleLst>" +
        "<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>" +
        '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="63000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>' +
        '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:shade val="81000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="69000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>' +
        "</a:bgFillStyleLst>" +
        "</a:fmtScheme>" +
        "</a:themeElements>" +
        "<a:objectDefaults/>" +
        "<a:extraClrSchemeLst/>" +
        "</a:theme>",
    );
  });

  it("字节确定性：同 deck 两次构建逐字节全等", () => {
    const r = validateDocDeck(DECK);
    if (!r.ok) throw new Error("unreachable");
    expect(Buffer.from(buildPptx(r.deck)).equals(Buffer.from(buildPptx(r.deck)))).toBe(true);
  });
});

describe("ω99-124 A — defaultPptxFilename（本地时区，pad 2）", () => {
  const p = (s: number) => String(s).padStart(2, "0");
  it("形状逐字：wudao-演示-YYYYMMDD-HHmmss.pptx", () => {
    expect(defaultPptxFilename(new Date(2026, 8, 1, 9, 5, 3))).toBe("wudao-演示-20260901-090503.pptx");
    expect(defaultPptxFilename(new Date(2026, 0, 5, 3, 2, 1))).toBe("wudao-演示-20260105-030201.pptx");
    const now = new Date();
    expect(defaultPptxFilename(now)).toBe(
      `wudao-演示-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.pptx`,
    );
  });
});
