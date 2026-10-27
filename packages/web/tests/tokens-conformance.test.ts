import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { stylesPieceFiles, stylesCss } from "./styles-source.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not the string strip: on win32 `file:///D:/…` minus
// "file://" leaves `D:\…` intact but `file://D:\…` variants double the drive
// (`D:\D:\…`) — the URL parser must do the decoding.
const SRC = join(fileURLToPath(import.meta.url), "../../src");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const cssFiles = [...stylesPieceFiles];
const codeFiles = walk(join(SRC, "components")).filter((p) => p.endsWith(".tsx"));

// —— 执法核心（纯函数：喂 CSS 文本，返回违规清单）——
// 既驱动下面四个真文件 it，也驱动 fix-r1 的绕过回归（评审 I1/I2/M1/M2）。

/** CSS 注释跨度剥离（注释里的示例值不算）。 */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const FONT_OK = new Set(["11px", "12.5px", "14px", "16px", "20px"]); // 五档

function fontViolations(cssRaw: string): string[] {
  const css = stripComments(cssRaw);
  const out: string[] = [];
  // fix-r1 M2：单位大小写（CSS 单位不区分大小写）与冒号前空白不再是逃逸口。
  for (const m of css.matchAll(/font-size\s*:\s*([\d.]+)px/gi)) {
    if (!FONT_OK.has(m[1]!.toLowerCase() + "px")) out.push(m[0].trim());
  }
  // fix-r1 I2：`font: 600 13px/1.4 …` 简写里的 px 字面量同样必须落在五档
  // （简写值取 [^;{}\n]+，折行值不跨行——与时长扫描的声明边界一致）。
  for (const m of css.matchAll(/\bfont:\s*([^;{}\n]+)/gi)) {
    for (const v of m[1]!.matchAll(/([\d.]+)px/gi)) {
      if (!FONT_OK.has(v[1]!.toLowerCase() + "px")) out.push(`font: …${v[0]} (${m[1]!.trim()})`);
    }
  }
  return out;
}

function spacingViolations(cssRaw: string): string[] {
  const css = stripComments(cssRaw);
  const out: string[] = [];
  for (const m of css.matchAll(/(?:margin|padding|gap)[^:;{}]*:\s*([^;}]+)/g)) {
    const d = m[0].trim();
    // 白名单（声明级精确锚定，task-6）：spec §2 2px-offset optical exception ——
    // 用户气泡 padding 10px/14px 与行内 code chip padding 1px/5px 是圆角件
    // 内文的偏移补偿（tokfinish 后圆角走 --radius-sm/lg 令牌，这两条 px
    // 内边距仍是 4px 网格无一档能表达的光学值）；按整条
    // 声明（属性名+值）锚定，非 substring——吞不掉相邻规则的间距字面量。
    // 2026-08-26 §3.1：助手回复卡 .reply-card 的 padding 10px 14px 曾是同
    // 一光学家族的第二个消费者——116 弧 B 去框化后该卡壳退役（padding:0），
    // 用户气泡是这条声明级锚定剩下的唯一消费者（单向收紧，白名单保留）。
    if (/^padding:\s*10px 14px$/.test(d)) continue;
    if (/^padding:\s*1px 5px$/.test(d)) continue;
    // ui-sweep M4（UI-1 defer 清偿）：task-7 的 composer radius-alignment 白名单
    // 已删除 —— 该条锚定的 `padding: var(--sp-1) … calc(var(--sp-2) + 6px)` 属于
    // 退役的墨线 14px composer 圆角（UI-1 fix round 1 改为 --radius-pill 后
    // styles.css 里不再存在该声明）。单向执法确认：删白名单只会让门更严，
    // 不会放行任何新违规；真文件 it 与下方 M4 回归共同钉住这一点。
    for (const v of m[1]!.matchAll(/(-?[\d.]+)px/g)) {
      const n = Math.abs(parseFloat(v[1]!));
      if (!(Number.isInteger(n) && (n % 4 === 0 || n <= 1))) out.push(`${m[0].trim()} @ ${v[0]}`);
    }
  }
  return out;
}

function durationViolations(cssRaw: string): string[] {
  // fix-r1 M1：结尾分号不再必需（`[^;{}]*;?`），文件末尾/块末的无分号声明
  // 也在扫描内。span 会折行（多行 transition 值），也可能吞进同块里后续
  // 无分号的声明——按「行首 ident:」边界切成单条声明再逐条执法，多行值
  // （`border-color var(--dur-fast) …` 这类无冒号续行）不会被错切。
  return [...stripComments(cssRaw).matchAll(/(?:transition|animation)[^;{}]*;?/g)].flatMap((m) =>
    m[0].split(/\n(?=\s*[-\w]+\s*:)/).flatMap((piece) => {
      const d = piece.trim();
      // 白名单（fix-r1 I1：声明级精确锚定，不再结构性删块——块剥离会把
      // 内联空 @media 之后的整条规则一起吞出扫描）：reduced-motion 灭灯
      // 开关的两条 longhand 必须保持字面近零时长（.01ms !important）——
      // 没有动效令牌能表达"约等于零"，且 inkline-global / ui-review-r2
      // 逐字 pin 它（spec §1.4）。任何其它规则里的时长字面量仍被执法。
      if (/^(?:transition|animation)-duration:\s*\.01ms\s*!important;?$/.test(d)) return [];
      // 白名单：tree-spin-pulse 的 1s 是无限装饰脉冲的 LOOP PERIOD，不是
      // 状态过渡时长——三档动效（120/180/240ms）无一能表达，最近档会让
      // 脉冲快 4 倍。名字+时长成对锚定整条声明（非 substring includes），
      // 吞不掉相邻规则的时长。
      if (/^animation:\s*tree-spin-pulse\s+1s\s[^;{}]*;?$/.test(d)) return [];
      // 白名单（UI-3 C4）：live-answer 打字光标的 blink 1s 同为无限装饰 LOOP
      // PERIOD——终端光标节拍，三档动效无一能表达（最近档快 4 倍）。名字+
      // 时长成对锚定整条声明，吞不掉相邻规则的时长。
      if (/^animation:\s*blink\s+1s\s[^;{}]*;?$/.test(d)) return [];
      return [
        ...[...d.matchAll(/\b(\d+)ms\b/g)].map((x) => x[0]),
        // 补齐骨架盲区：秒形式字面量（0.12s/0.18s…）同样绕不开 var(--dur-*)。
        ...[...d.matchAll(/\b\d*\.?\d+s\b/g)].map((x) => x[0]),
      ];
    }),
  );
}

// 终审 F1：注释剥离（lazy，同真解析器——注释在第一个 `*/` 处终止）后，
// 文本里不允许再残留 `*/`。残留 = 某条注释体内含字面 `*/` 被提前截断，
// 截断后的注释尾巴会变成垃圾选择器前奏，静默吞掉后面的真规则
// （jsdom 宽松解析拦不住，只有规范 tokenizer 语义能查）。
// （实现注：说明文字用 // 行注释——块注释体内无法安全提及字面 `*/`。）
const commentResidue = (cssRaw: string): string[] =>
  [...stripComments(cssRaw).matchAll(/\*\//g)].map((m) => m[0]);

// —— tokfinish（appaudit 弧批2 §5）：两道新门 ——
// radius 门：appaudit §1.10 判定 border-radius「完全无门」（16 处离档 +
// 气泡/wchg 三处字面量）。执法面：styles.css 全量 radius 声明（含
// border-{top,bottom}-{left,right}-radius 物理角 longhand——R1 F2 补洞：
// `border-top-left-radius: 4px` 不是 border-radius 的子串，shorthand-only
// 扫描对它零违规放行），逐值检查
// ——只许 var(--radius-sm|md|lg) 三个单值档 + var(--radius-bubble)
// 气泡语义档，与两个合法原语：50%（圆）、0（直角=全出血容器）。
// 119 用户反馈修正（0.4.2「会话区直角/会话框圆角不统一」）后口径收紧：
// --radius-pill 与 999px 胶囊帽全量退役（一套 scale=6/8/12+气泡 8），
// 消费形态零出现即违规；任何裸 px（含 4/5/6/8/12/15/22px 字面量，多值
// 角列表里的每一个值同理）一律 fail。存量已在同批归零后才上门；不预置
// 任何字面量白名单（50%/0 是 CSS 原语不是豁免条目，且现存于 sheet）。
function radiusViolations(cssRaw: string): string[] {
  const css = stripComments(cssRaw);
  const out: string[] = [];
  for (const m of css.matchAll(/(?:border-(?:top|bottom)-(?:left|right)-radius|border-radius)\s*:\s*([^;{}]+)/g)) {
    for (const v of m[1]!.trim().split(/\s+/)) {
      // 单位大小写不敏感（CSS 语义）；令牌名按本 sheet 的书写约定小写。
      if (!/^(?:var\(--radius-(?:sm|md|lg|bubble)\)|50%|0)$/i.test(v)) {
        out.push(`${m[0].trim()} @ ${v}`);
      }
    }
  }
  return out;
}

// rem/em 门：px 门只匹配 px 字面量，rem/em 全部绕过（appaudit §1.10 的
// 「逃生口」，间距 92 处 + 字号 6 处）。执法面：margin/padding/gap（含
// longhand）与 font-size 声明禁 rem/em 字面量。
// 唯一豁免：所属规则的选择器（逗号分组的每一支）以 `.md` 开头——
// `.md`/`.md-*` 是 markdown 内容域：内容排版随用户根字号缩放是特性不是
// 欠账（tokfinish §4 白名单域）。这是内容域豁免不是逃生口：
//   - 前缀锚定 `^\.md(?![a-zA-Z])`——`.mdmode`（viewer 的源码/预览钮）
//     这类前缀撞车名不匹配；
//   - 选择器必须以 .md 起头——`.fileviewer .viewer-md` 不匹配；
//   - 逗号分组里混入任何非 .md 支，整块照常执法。
// 不给新违规留白名单位（存量归零后上门，顺序不可倒）。
const MD_SELECTOR = /^\.md(?![a-zA-Z])/;
function remEmViolations(cssRaw: string): string[] {
  const out: string[] = [];
  // 规则块扫描（与既有文本扫描同风格的选择器上下文追踪）：@media 外壳
  // 自带 `{`，被 `[^{}]+`/`[^{}]*` 的边界自然跳过，内层规则照常命中。
  for (const block of stripComments(cssRaw).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = block[1]!.replace(/\s+/g, " ").trim();
    const parts = selector.split(",").map((s) => s.trim()).filter((s) => s !== "");
    if (parts.length > 0 && parts.every((p) => MD_SELECTOR.test(p))) continue; // .md 内容域
    for (const m of block[2]!.matchAll(/(?:margin|padding|gap|font-size)[a-z-]*\s*:\s*([^;{}]+)/g)) {
      for (const v of m[1]!.matchAll(/-?[\d.]+(?:rem|em)\b/gi)) {
        out.push(`${m[0].trim().replace(/\s+/g, " ")} @ ${v[0]}`);
      }
    }
  }
  return out;
}

// —— P2 §2.5 字重门（DESIGN-SYSTEM Phase 2 上门）：styles/ 零裸 font-weight 数字。
// 三档令牌 var(--fw-regular|medium|strong) 是唯一合法形态（UI chrome 禁 700，
// 700 收编 600）；规范钦点的两处真 700 豁免以「选择器整块锚定」放行（不是
// 值白名单）：.md .bold（markdown 强调=内容态排版）与 .simple-error .err-head
// （错误首行）——豁免块外的 700、以及 100~900 任何其他裸数字一律 fail。
const FW_700_EXEMPT_RULES = /^\.md \.bold$|^\.simple-error \.err-head$/;
function fontWeightViolations(cssRaw: string): string[] {
  const out: string[] = [];
  for (const block of stripComments(cssRaw).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = block[1]!.replace(/\s+/g, " ").trim();
    for (const m of block[2]!.matchAll(/font-weight\s*:\s*([^;{}]+)/g)) {
      const v = m[1]!.trim();
      if (/^var\(--fw-(?:regular|medium|strong)\)$/.test(v)) continue;
      if (v === "700" && FW_700_EXEMPT_RULES.test(selector)) continue;
      out.push(`${m[0].trim()} @ ${selector}`);
    }
  }
  return out;
}

// —— ω99-295 执法基元 ——
/** 定义侧令牌名提取：注释剥离后的 `--name:` 形态（消费形态 var(--name)
 *  后面是 `)` 不是 `:`，不命中）。门 B 的基元。 */
const definedTokenNames = (cssRaw: string): Set<string> =>
  new Set([...stripComments(cssRaw).matchAll(/--[\w-]+\s*:/g)].map((m) => m[0].replace(/\s*:/, "")));

/** 代码文件（tsx）注释剥离：块注释沿用 CSS 剥离的立场（注释里的示例色不算），
 *  行注释是 TS/TSX 的主要注释形态、同一类非代码文本——`// #451` 议题引用
 *  不是颜色。`[^:]` 前置豁免 `https://` 协议斜杠（URL 字符串里的 // 不是注释）。 */
const stripCodeComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "");

// 墨线执法门（spec §7.1）：禁裸 hex / 禁令牌外字号与时长 / 间距 4 倍数。
describe("tokens conformance gate", () => {
  it("no bare hex colors outside tokens.css/icons", () => {
    for (const f of [...cssFiles, ...codeFiles]) {
      const src = readFileSync(f, "utf8");
      const stripped = stripCodeComments(src); // 注释里的示例色不算（块+行）
      expect(stripped, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
  // 回归钉（#451 假阳性揭发后立的）：行注释剥离不得吞协议斜杠、不得放跑
  // 代码位真 hex——stripCodeComments 的两个方向各有最小断言。
  it("stripCodeComments: line comments are non-code (issue refs OK); URLs and real hex stay live", () => {
    expect(stripCodeComments("// #451 议题引用\nconst x = 1;")).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(stripCodeComments('const u = "https://a.b/c"; // #fff 注释色\nconst y = 2;')).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    // 协议斜杠方向：无注释的 URL 行必须原样存活（:// 前是冒号，守卫组
    // 无匹配点——URL 里的 // 不是注释，一行一字都不该被吞）。
    expect(stripCodeComments('const u = "https://a.b/c";\nconst y = 2;')).toBe('const u = "https://a.b/c";\nconst y = 2;');
    expect(stripCodeComments("const c = '#E6F4EC'; // 真色在代码位")).toMatch(/#E6F4EC\b/);
  });
  it("styles.css font-size literals ∈ 五档 (var() 引用不受限)", () => {
    expect(fontViolations(stylesCss)).toEqual([]);
  });
  it("styles.css spacing literals are multiples of 4 (whitelist 0/1/-1)", () => {
    expect(spacingViolations(stylesCss)).toEqual([]);
  });
  it("transition durations only via var(--dur-*)", () => {
    expect(durationViolations(stylesCss)).toEqual([]);
  });
  it("styles.css 注释体内无提前闭合的 */（终审 F1：垃圾前奏会吞规则）", () => {
    expect(commentResidue(stylesCss)).toEqual([]);
  });
  // —— tokfinish 两道新门（存量先归零，本批同顺序上门）——
  it("styles.css border-radius ∈ 四档令牌 + 999px/50%/0 原语（无裸 px）", () => {
    expect(radiusViolations(stylesCss)).toEqual([]);
  });
  it("styles.css margin/padding/gap/font-size 无 rem/em（唯一豁免：.md 内容域）", () => {
    expect(remEmViolations(stylesCss)).toEqual([]);
  });
  // —— P2 字重门（存量 51 处已同批归队令牌，本门随弧上门）——
  it("styles.css font-weight 只走三档令牌（P2 §2.5；豁免两处真 700：.md .bold 与错误首行）", () => {
    expect(fontWeightViolations(stylesCss)).toEqual([]);
  });
  it("P2 字重门机械：豁免按选择器整块锚定——块外 700 与非三档裸数字照常违规", () => {
    expect(fontWeightViolations("a { font-weight: 700; } .x .y { font-weight: 600; }")).toHaveLength(2);
    expect(
      fontWeightViolations(
        ".md .bold { font-weight: 700; } .simple-error .err-head { font-weight: 700; } .z { font-weight: var(--fw-strong); }",
      ),
    ).toEqual([]);
  });
  // —— ω99-295 两道新门（存量先归零，本批同顺序上门）——
  // 门 A（静默失效）：曾有一个表面令牌被三处消费却全仓从未定义 —— var()
  // 无效在 computed-value 期静默回落 transparent，三块卡面透明、零告警。
  // 修复 = 消费归队 --surface；本门把该令牌名钉死为零出现（raw 文本级，
  // 注释也不许提——防复制复活）。
  it("ω99-295 A: styles.css 全文零出现那个从未定义的表面令牌（含注释）", () => {
    expect(stylesCss).not.toContain("--surface-1");
  });
  // —— 116 弧 A 新门（退役令牌防复活）：实色线 --line/--line-2 与单档重投影
  // --shadow-2 已全量迁发丝线三档（--hair-1/2/3）与 elevation 三件套
  // （--elev-1/2/3）。消费形态（var(--line…) / var(--shadow-2)）在 styles
  // 零出现——新代码不许再借旧名（ω99-295 A 的消费形态版）。
  it("116 弧 A: styles.css 零出现退役令牌的消费形态 var(--line)/var(--line-2)/var(--shadow-2)", () => {
    expect(stylesCss).not.toContain("var(--line)");
    expect(stylesCss).not.toContain("var(--line-2)");
    expect(stylesCss).not.toContain("var(--shadow-2)");
  });
  // 119 用户反馈修正（圆角统一）：--radius-pill 与 999px 胶囊帽全量退役——
  // 消费形态零出现（防复制复活；tokens.css 注释里的历史叙述不算消费）。
  it("119: styles.css 零出现退役胶囊档的消费形态 var(--radius-pill)/999px", () => {
    expect(stylesCss).not.toContain("var(--radius-pill)");
    expect(stripComments(stylesCss)).not.toContain("999px");
  });
  // 门 B（单一事实源）：tokens.css 是设计令牌的唯一出处在（styles.css 头部
  // 自述「只消费、不重定义」），但 --mono 曾双重定义 —— styles.css 侧更全
  // 栈因导入序赢得级联，tokens.css 侧成死代码。执法面：tokens.css 拥有的
  // 名字在 styles.css 定义侧必须零出现；styles.css 自有的局部变量
  // （--ctx-w 等运行时 setProperty 布局名）不是 tokens.css 拥有的名字，
  // 不受本门影响。
  it("ω99-295 B: styles.css 不重定义 tokens.css 拥有的任何令牌（单一事实源）", () => {
    const owned = definedTokenNames(readFileSync(join(SRC, "tokens.css"), "utf8"));
    const redefined = [...owned].filter((n) => definedTokenNames(stylesCss).has(n));
    expect(redefined).toEqual([]);
  });
});

// —— fix-r1 回归（评审 I1/I2/M1/M2）：门的机械结构本身不容绕过 ——
describe("gate machinery regressions (fix-r1)", () => {
  it("I1: an inline-closed reduced-motion block must not swallow the next rule", () => {
    const bypass = "@media (prefers-reduced-motion: reduce) { }\n.a {\n  transition: opacity 9s ease;\n}";
    expect(durationViolations(bypass)).toEqual(["9s"]);
  });
  it("I2: font: shorthand px literals are tier-checked", () => {
    expect(fontViolations(".a { font: 600 13px/1.4 var(--font); }"))
      .toEqual(["font: …13px (600 13px/1.4 var(--font))"]);
  });
  it("M2: 13PX (case-insensitive unit) does not escape", () => {
    expect(fontViolations(".a { font-size: 13PX; }")).toEqual(["font-size: 13PX"]);
  });
  it("M2: 'font-size : 13px' (space before colon) does not escape", () => {
    expect(fontViolations(".a { font-size : 13px; }")).toEqual(["font-size : 13px"]);
  });
  it("M1: a no-semicolon final declaration still gets scanned", () => {
    expect(durationViolations(".a {\n  transition: opacity 9s ease\n")).toEqual(["9s"]);
  });
  it("M1: the tree-spin whitelist matches its own declaration only", () => {
    const css = ".a {\n  animation: tree-spin-pulse 1s infinite\n  transition: opacity 7s ease;\n}";
    expect(durationViolations(css)).toEqual(["7s"]);
  });
  // UI-3 C4: the blink whitelist follows the same declaration-anchored shape
  // — it lets the cursor's own loop period through and nothing else.
  it("UI-3 C4: the blink whitelist matches its own declaration only", () => {
    const css = ".a {\n  animation: blink 1s steps(1) infinite;\n  transition: opacity 7s ease;\n}";
    expect(durationViolations(css)).toEqual(["7s"]);
    expect(durationViolations(".a { animation: other 1s infinite; }")).toEqual(["1s"]);
  });
  it("task-6: the 2px-offset spacing whitelist matches its own declarations only", () => {
    const css = ".a {\n  padding: 10px 14px;\n  margin: 6px;\n}\n.b { padding: 1px 5px; margin: 10px 14px; }";
    expect(spacingViolations(css)).toEqual([
      "margin: 6px @ 6px",
      "margin: 10px 14px @ 10px",
      "margin: 10px 14px @ 14px",
    ]);
  });
  it("ui-sweep M4: the retired composer radius-alignment whitelist is GONE — the dead idiom now flags", () => {
    // One-way cleanup: the whitelist exempted the 墨线 14px composer's
    // `padding: var(--sp-1) … calc(var(--sp-2) + 6px)`; that declaration
    // left the sheet with UI-1's --radius-pill rework, so the exemption
    // had nothing left to protect. Removing it can only tighten the gate —
    // the retired idiom (and any near-miss variant) now flags like every
    // other non-multiple-of-4 literal.
    const css = ".a {\n  padding: var(--sp-1) var(--sp-1) var(--sp-1) calc(var(--sp-2) + 6px);\n  margin: 6px;\n}\n.b { padding: var(--sp-1) calc(var(--sp-2) + 6px); }";
    expect(spacingViolations(css)).toEqual([
      "padding: var(--sp-1) var(--sp-1) var(--sp-1) calc(var(--sp-2) + 6px) @ 6px",
      "margin: 6px @ 6px",
      "padding: var(--sp-1) calc(var(--sp-2) + 6px) @ 6px",
    ]);
  });
  it("final-F1: a premature */ inside a comment leaves residue the gate can see", () => {
    const malformed =
      "/* strip comment: new .set-*/.ctl names appear --- */\n.a { transition: opacity 9s ease; }";
    expect(commentResidue(malformed)).toEqual(["*/"]);
  });
  // —— tokfinish 判别测试（M4 退役先例的反向形态）：构造最小违规串，
  // 断言两道新门各自见红——不许只测存量通过。 ——
  it("tokfinish radius gate: bare px radii flag (single, mid-tier, multi-corner); the legal primitives pass", () => {
    // 审计清单的形态：4px/5px 单值。
    expect(radiusViolations(".a { border-radius: 4px; }")).toEqual(["border-radius: 4px @ 4px"]);
    expect(radiusViolations(".a { border-radius: 5px; }")).toEqual(["border-radius: 5px @ 5px"]);
    // 审计外的同罪形态：2px 微圆、15px 中间档、6/8/12/22 档内字面量（档位
    // 必须经令牌表达，字面量本身即违规）。
    expect(radiusViolations(".a { border-radius: 2px; }")).toEqual(["border-radius: 2px @ 2px"]);
    expect(radiusViolations(".a { border-radius: 15px; }")).toEqual(["border-radius: 15px @ 15px"]);
    expect(radiusViolations(".a { border-radius: 6px; }")).toEqual(["border-radius: 6px @ 6px"]);
    // 用户气泡的退役形态：多值角列表逐值执法（4 个值 4 条违规）。
    expect(radiusViolations(".a { border-radius: 16px 16px 4px 16px; }")).toEqual([
      "border-radius: 16px 16px 4px 16px @ 16px",
      "border-radius: 16px 16px 4px 16px @ 16px",
      "border-radius: 16px 16px 4px 16px @ 4px",
      "border-radius: 16px 16px 4px 16px @ 16px",
    ]);
    // 119 收紧：999px 胶囊帽与退役档 --radius-pill 的消费形态一律红。
    expect(radiusViolations(".a { border-radius: 999px; }")).toEqual(["border-radius: 999px @ 999px"]);
    expect(radiusViolations(".a { border-radius: var(--radius-pill); }"))
      .toEqual(["border-radius: var(--radius-pill) @ var(--radius-pill)"]);
    // 合法原语与令牌全通过（含 0 与令牌混排的角列表、大小写单位）。
    expect(
      radiusViolations(
        ".a { border-radius: 50%; } .b { border-radius: 0; }" +
          ".c { border-radius: var(--radius-lg); } .d { border-radius: 0 0 0 var(--radius-sm); }" +
          ".e { border-radius: 0 0 var(--radius-md) var(--radius-md); } .f { border-radius: 50%; }",
      ),
    ).toEqual([]);
    // R1 F2 补洞的判别：物理角 longhand 不是 border-radius 的子串，
    // shorthand-only 扫描曾对它零违规放行——现在裸 px 必须红，令牌形态过。
    expect(radiusViolations(".a { border-top-left-radius: 4px; }"))
      .toEqual(["border-top-left-radius: 4px @ 4px"]);
    expect(radiusViolations(".a { border-bottom-right-radius: 5px; }"))
      .toEqual(["border-bottom-right-radius: 5px @ 5px"]);
    expect(radiusViolations(".a { border-top-right-radius: var(--radius-sm); }")).toEqual([]);
  });
  it("tokfinish rem/em gate: rem and em literals in spacing/font-size flag outside the .md content domain", () => {
    // 逃逸口形态：间距与字号，rem 与 em，shorthand 与 longhand。
    expect(remEmViolations(".a { gap: .5rem; }")).toEqual(["gap: .5rem @ .5rem"]);
    expect(remEmViolations(".a { padding: .45em .7em; }")).toEqual([
      "padding: .45em .7em @ .45em",
      "padding: .45em .7em @ .7em",
    ]);
    expect(remEmViolations(".a { margin-top: 1.5rem; }")).toEqual(["margin-top: 1.5rem @ 1.5rem"]);
    expect(remEmViolations(".a { font-size: 1rem; }")).toEqual(["font-size: 1rem @ 1rem"]);
    expect(remEmViolations(".a { font-size: 1.15rem; }")).toEqual(["font-size: 1.15rem @ 1.15rem"]);
    // 令牌形态通过（归档后的 sheet 形态）。
    expect(remEmViolations(".a { padding: var(--sp-2) var(--sp-3); gap: var(--sp-1); font-size: var(--fs-title); }")).toEqual([]);
    // .md 内容域豁免：`.md` 与 `.md-*` 起头的选择器保留 rem。
    expect(remEmViolations(".md { gap: .35rem; }")).toEqual([]);
    expect(remEmViolations(".md-list { gap: .1rem; padding-left: 1.1rem; }")).toEqual([]);
    expect(remEmViolations(".md-quote { padding-left: .8rem; }")).toEqual([]);
    // 豁免不是逃生口：前缀撞车名（.mdmode）、.md 不在选择器起头、
    // 逗号分组混入非 .md 支——整块照常执法。
    expect(remEmViolations(".mdmode { padding: .5rem; }")).toEqual(["padding: .5rem @ .5rem"]);
    expect(remEmViolations(".fileviewer .viewer-md { padding: .6rem 1rem; }")).toEqual([
      "padding: .6rem 1rem @ .6rem",
      "padding: .6rem 1rem @ 1rem",
    ]);
    expect(remEmViolations(".md-list, .other { gap: .1rem; }")).toEqual(["gap: .1rem @ .1rem"]);
    // @media 外壳不遮蔽内层规则的执法。
    expect(remEmViolations("@media (max-width: 640px) {\n  .a { gap: .5rem; }\n}")).toEqual(["gap: .5rem @ .5rem"]);
  });
  // —— ω99-295 门机械判别（不许只测存量通过）——
  it("ω99-295: definedTokenNames sees definitions, not var() consumption or comment examples", () => {
    expect([...definedTokenNames(":root { --mono: x; --sp-1: 4px; }")].sort()).toEqual(["--mono", "--sp-1"]);
    expect([...definedTokenNames('.a { color: var(--mono); padding: var(--sp-1); }')]).toEqual([]);
    // 注释里的示例名不算（与全文件「注释剥离」立场一致）。
    expect([...definedTokenNames("/* --ghost: 1; */ .a { color: red; }")]).toEqual([]);
  });
});
