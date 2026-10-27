// ω99-318 — 审批面 Unicode 视觉欺骗防线：core 纯模块的表驱动测试。
// 三组：
//   1) inspectText 危险码点逐类命中（位置/名称/类别钉）；
//   2) 误报门（灵魂测试）：正常 CJK / emoji（含 ZWJ 序列）/ NFC 组合字符 /
//      全角中文标点散文 —— 一律零报；
//   3) inspectUrl / inspectToolInput：混形归一（真实指向）、全角折叠、
//      punycode 注记、URL_ARG_KEYS 嗅探、嵌套路径、上限守卫。
// 处置语义钉：inspect 只显形不拦截 —— 本模块没有任何 deny/throw 面。
import { describe, expect, it } from "vitest";
import {
  inspectText,
  inspectUrl,
  inspectToolInput,
  URL_ARG_KEYS,
} from "../src/unicode-security.js";

const cps = (s: string): string[] => Array.from(s);

describe("inspectText — 危险码点逐类", () => {
  it.each([
    // BiDi 覆写/嵌入/隔离（文本重排欺骗的经典面）
    ["‮", "U+202E", "RIGHT-TO-LEFT OVERRIDE", "bidi"],
    ["‭", "U+202D", "LEFT-TO-RIGHT OVERRIDE", "bidi"],
    ["‪", "U+202A", "LEFT-TO-RIGHT EMBEDDING", "bidi"],
    ["‫", "U+202B", "RIGHT-TO-LEFT EMBEDDING", "bidi"],
    ["‬", "U+202C", "POP DIRECTIONAL FORMATTING", "bidi"],
    ["⁦", "U+2066", "LEFT-TO-RIGHT ISOLATE", "bidi"],
    ["⁧", "U+2067", "RIGHT-TO-LEFT ISOLATE", "bidi"],
    ["⁨", "U+2068", "FIRST STRONG ISOLATE", "bidi"],
    ["⁩", "U+2069", "POP DIRECTIONAL ISOLATE", "bidi"],
    ["‎", "U+200E", "LEFT-TO-RIGHT MARK", "bidi"],
    ["‏", "U+200F", "RIGHT-TO-LEFT MARK", "bidi"],
    // 零宽家族
    ["​", "U+200B", "ZERO WIDTH SPACE", "zero-width"],
    ["‌", "U+200C", "ZERO WIDTH NON-JOINER", "zero-width"],
    ["‍", "U+200D", "ZERO WIDTH JOINER", "zero-width"],
    ["⁠", "U+2060", "WORD JOINER", "zero-width"],
    ["﻿", "U+FEFF", "ZERO WIDTH NO-BREAK SPACE (BOM)", "zero-width"],
    // 不可见/其他控制格式类
    ["­", "U+00AD", "SOFT HYPHEN", "invisible"],
    ["͏", "U+034F", "COMBINING GRAPHEME JOINER", "invisible"],
    ["ᅟ", "U+115F", "HANGUL CHOSEONG FILLER", "invisible"],
    ["ᅠ", "U+1160", "HANGUL JUNGSEONG FILLER", "invisible"],
    [" ", "U+2028", "LINE SEPARATOR", "invisible"],
    [" ", "U+2029", "PARAGRAPH SEPARATOR", "invisible"],
  ])("单个危险码点 %# %s 被报（名称+类别钉）", (ch, codepoint, name, category) => {
    const issues = inspectText(`rm -rf ${ch}safe`);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ codepoint, name, category });
    // 位置：按码点计的索引（Array.from 口径），钉在危险码点本身。
    expect(issues[0]?.position).toBe(cps(`rm -rf ${ch}safe`).indexOf(ch));
  });

  it("零宽空格在路径中欺骗的经典形：rm -rf /tmp/​safe 被报且位置正确", () => {
    const text = `rm -rf /tmp/​safe`;
    const issues = inspectText(text);
    expect(issues.map((i) => i.codepoint)).toEqual(["U+200B"]);
    expect(issues[0]?.position).toBe(cps(text).indexOf("​"));
  });

  it("多个危险码点按源序全部报告（去重不丢位置）", () => {
    const issues = inspectText(`a​b‮c​`);
    expect(issues.map((i) => i.codepoint)).toEqual(["U+200B", "U+202E", "U+200B"]);
    expect(issues.map((i) => i.position)).toEqual([1, 3, 5]);
  });

  it("emoji ZWJ 序列里的 U+200D 不报（夹在表意字符之间=合法序列）", () => {
    // 👨‍👩‍👧 = 1F468 ZWJ 1F469 ZWJ 1F467
    expect(inspectText("\u{1F468}‍\u{1F469}‍\u{1F467}")).toEqual([]);
    // ❤️ 族：2764 FE0F ZWJ …（ZWJ 一侧是符号块表意字符）
    expect(inspectText("\u{1F469}‍❤️‍\u{1F468}")).toEqual([]);
    // 两侧都是 emoji 但夹带了 ASCII —— 报（隐藏的必须可见）
    const mixed = `\u{1F44D}‍rm -rf /`;
    expect(inspectText(mixed).map((i) => i.codepoint)).toEqual(["U+200D"]);
  });

  it("ZWJ 一侧不是表意字符就报（攻击面保留）", () => {
    expect(inspectText(`sa‍fe`).map((i) => i.codepoint)).toEqual(["U+200D"]);
  });
});

describe("inspectText — 误报门（灵魂测试：正常文本零报）", () => {
  it("正常中文散文（含全角标点、引号、数字）零报", () => {
    const prose = `你好，世界！今天天气不错。他说：「这是《测试》文件，共 3 页。」`;
    expect(inspectText(prose)).toEqual([]);
  });

  it("正常 emoji（表情/国旗/肤色/家庭序列）零报", () => {
    expect(inspectText("👍 🎉 🏳️‍🌈 🏴Faulty?否——纯 emoji 串 🚀")).toEqual([]);
    expect(inspectText("\u{1F44D}\u{1F3FD}")).toEqual([]); // 👍🏽 肤色修饰符
  });

  it("NFC/NFD 组合字符零报（é 两种形都不报）", () => {
    expect(inspectText("café")).toEqual([]); // NFC 单码点
    expect(inspectText("café")).toEqual([]); // NFD e + U+0301
    expect(inspectText("가음 한국어 안녕하세요")).toEqual([]); // 预组 Hangul 音节
  });

  it("多语言正常文本（日文假名/西里尔正常词/希腊正常词）零报", () => {
    expect(inspectText("こんにちは世界 Привет Ελλάδα")).toEqual([]);
  });

  it("常规空白与控制不报：空格/换行/Tab", () => {
    expect(inspectText("line1\nline2\ttab  spaces")).toEqual([]);
  });
});

describe("inspectUrl — 混形归一与真实指向", () => {
  it("干净 ASCII URL：归一前后一致、零警告", () => {
    const r = inspectUrl("https://example.com/a?b=1");
    expect(r.normalizedUrl).toBe("https://example.com/a?b=1");
    expect(r.warnings).toEqual([]);
  });

  it("西里尔同形域名：归一揭示视觉等价 + punycode 实际网络名", () => {
    const raw = "https://gοogle.com"; // ο = U+03BF GREEK OMICRON
    const r = inspectUrl(raw);
    expect(r.normalizedUrl).toBe("https://google.com");
    expect(r.warnings.join(" ")).toContain("ο");
    // 机器实际解析形（punycode）必须在警告里——「你看到的」≠「它去的」
    expect(r.warnings.join(" ")).toContain("xn--");
  });

  it("scheme 内同形字符（hτtp）也被折叠揭示", () => {
    const r = inspectUrl("hτtp://evil.com"); // τ = U+03C4 GREEK TAU
    expect(r.normalizedUrl).toBe("http://evil.com");
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("全角冒号+斜杠（中文输入法形）：折叠成 ASCII 后揭示（CJK 扩展表）", () => {
    const r = inspectUrl("http：//evil。com／path");
    expect(r.normalizedUrl).toBe("http://evil.com/path");
    expect(r.warnings.join(" ")).toContain("："); // 警告点名全角冒号
  });

  it("全角拉丁域名折叠：ｅｖｉｌ.com → evil.com", () => {
    const r = inspectUrl("https://ｅｖｉｌ.com");
    expect(r.normalizedUrl).toBe("https://evil.com");
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("punycode 域名：解码注记给出 Unicode 域名形", () => {
    // xn--gogle-rce.com = gοogle.com 的真 punycode（Node IDNA 实测）；
    // 早期草稿用的 xn--gogle-0ve 是编造标签，domainToUnicode 解不出。
    const r = inspectUrl("https://xn--gogle-rce.com/");
    expect(r.normalizedUrl).toBe("https://xn--gogle-rce.com/");
    expect(r.warnings.join(" ")).toContain("gοogle"); // 解码形进警告
  });

  it("URL 里的零宽字符进警告", () => {
    const r = inspectUrl("https://evil.com/​x");
    expect(r.warnings.join(" ")).toContain("U+200B");
  });

  it("不可解析的 URL 不抛（全角 scheme 形不炸）", () => {
    expect(() => inspectUrl("not a url at all：//")).not.toThrow();
    const r = inspectUrl("not a url at all：//");
    expect(Array.isArray(r.warnings)).toBe(true);
  });
});

describe("inspectToolInput — 参数级汇总（帧载荷）", () => {
  it("URL_ARG_KEYS 钉（brief 处方六键）", () => {
    expect([...URL_ARG_KEYS].sort()).toEqual(["base_url", "endpoint", "href", "link", "uri", "url"]);
  });

  it("url 参数键走 URL 检查：spoof.urls 携带真实指向", () => {
    const r = inspectToolInput({ url: "https://gοogle.com" });
    expect(r).not.toBeNull();
    expect(r?.urls).toHaveLength(1);
    expect(r?.urls[0]).toMatchObject({ key: "url", normalizedUrl: "https://google.com" });
  });

  it("command 参数里的零宽字符进 spoof.text", () => {
    const r = inspectToolInput({ command: `rm -rf /tmp/​safe` });
    expect(r?.text).toHaveLength(1);
    expect(r?.text[0]?.key).toBe("command");
    expect(r?.text[0]?.issues[0]?.codepoint).toBe("U+200B");
  });

  it("嵌套路径（对象/数组）被走到，key 是点路径", () => {
    const r = inspectToolInput({ opts: { url: "http：//evil.com" }, list: ["ok", "a‮b"] });
    expect(r?.urls[0]?.key).toBe("opts.url");
    expect(r?.text[0]?.key).toBe("list[1]");
  });

  it("非 URL 键但值像 URL（curl 命令内嵌 http）也走 URL 检查", () => {
    const r = inspectToolInput({ command: "curl -s http：//evil.com/x" });
    expect(r?.urls).toHaveLength(1);
    expect(r?.urls[0]?.key).toBe("command");
  });

  it("干净参数返回 null（帧上零新键——加性契约的数据面）", () => {
    expect(inspectToolInput({ command: "npm test", path: "src/a.ts", n: 3 })).toBeNull();
    expect(inspectToolInput({})).toBeNull();
  });

  it("载荷是纯 JSON（帧可走 wire）", () => {
    const r = inspectToolInput({ command: `x​y`, url: "https://gοogle.com" });
    expect(() => JSON.parse(JSON.stringify(r))).not.toThrow();
  });

  it("上限守卫：超长字符串不失控、issues 有帽", () => {
    const huge = "a".repeat(100_000) + "​";
    const r = inspectToolInput({ command: huge });
    expect(r?.text[0]?.issues.length).toBeLessThanOrEqual(8);
    // 超帽的量如实披露（more 字段）
    expect(r?.text[0]?.more).toBe(0); // 单个码点不超帽
    // 20 个零宽：帽 8 + more 12
    const r2 = inspectToolInput({ command: "​".repeat(20) });
    expect(r2?.text[0]?.issues.length).toBe(8);
    expect(r2?.text[0]?.more).toBe(12);
  });
});
