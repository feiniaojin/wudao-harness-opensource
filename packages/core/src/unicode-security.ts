// ω99-318 — 审批面 Unicode 视觉欺骗防线：core 纯模块（单一事实源）。
import { domainToUnicode } from "node:url";
//
// 问题：5 层权限管线唯一的人类环节是审批卡，而人眼可被骗——`rm -rf /tmp/​safe`
// （零宽空格）、`hτtp://evil`（西里尔/希腊同形）在审批卡里看起来完全良性。
// 这是提示注入经「人眼」绕过整条管线的通道（deepagents 把这道防线做成了
// 轻量纯函数——本模块取其范式，表与接线在我们的体系里超越，见弧报告）。
//
// 宪法（brief §2/§3，逐条钉死）：
//   1. **显形不拦截**——本模块没有 deny/throw/门语义；产出只是显示数据
//      （码点徽标 + 真实指向），处置=让用户看见真的。误报零破坏。
//   2. **误报门是硬约束**——正常 CJK / emoji（含 ZWJ 序列）/ NFC 组合字符
//      必须零报。全角标点是正常中文文本的日常，绝不在 inspectText 里报——
//      全角/同形折叠只发生在 inspectUrl 的 URL 语境。
//   3. **纯函数、零 I/O、零依赖**——挂 display/approval 路径零启动开销；
//      源检验（core 一处）、边渲染（结果随 ask 帧走，web 零内部依赖不复制表）。
//
// 放置先例：formatToolError/didYouMean 家族（tool.ts）——core 纯函数 + 单一
// 事实源 + 导出供测试直钉。非 M47 校验层（不做参数校验，不叠门）。
//
// 已知留白（v2 池，弧报告登记）：U+E0020..U+E007F tag 字符（旗子 emoji 的
// 合法组成，报它会踩误报门——需要旗序列感知后再入表）；CJK 兼容表意文字
// （U+F900..，NFC 不折叠、正常文本可合法出现，同理缓入）；REPL 之外的会话
// 内容渲染同检（模型输出链接）与 evals 行为指纹入流。

/** One revealed dangerous code point. `position` is the CODE POINT index
 *  (Array.from 口径) in the inspected string — the render side segments by
 *  the same rule, so badges land at the original spot. */
export interface UnicodeIssue {
  readonly codepoint: string;
  readonly name: string;
  /** 中文显示名（徽标文案：`U+200B 零宽空格` 样式钩）。 */
  readonly nameZh: string;
  readonly position: number;
  readonly category: UnicodeIssueCategory;
}

export type UnicodeIssueCategory = "bidi" | "zero-width" | "invisible";

/** One URL-bearing argument whose visual form differs from its canonical
 *  ASCII writing. `normalizedUrl` is the homoglyph/fullwidth-folded form —
 *  「它看起来像什么」；the punycode notes in `warnings` carry 「它实际去哪」
 *  when the two differ. */
export interface UrlInspection {
  readonly key: string;
  readonly original: string;
  readonly normalizedUrl: string;
  readonly warnings: readonly string[];
}

/** The ask-frame payload (pure JSON, wire-ridable): flagged string arguments
 *  with their issues, plus URL inspections. Null when nothing was found —
 *  the frame then carries NO spoof key at all (additive-only contract). */
export interface SpoofInspection {
  readonly text: readonly { readonly key: string; readonly issues: readonly UnicodeIssue[]; /** 超出 issue 帽的剩余数量（诚实披露）。 */ readonly more?: number }[];
  readonly urls: readonly UrlInspection[];
}

// ---------------------------------------------------------------------------
// 危险码点表（inspectText 的单一事实源）。
// 每类都有出处：BiDi 覆写=文本重排欺骗（Trojan Source 的核心面）；零宽家族=
// 不可见字符夹带；invisible=软连字符/填充符/行分隔符等控制格式类。
// 刻意不入表（误报门优先）：变体选择符 U+FE00..FE0F 与 tag 字符——它们是
// 合法 emoji 序列的组成部分（✌️/🏴 的骨架），报它们=把正常 emoji 搞成惊悚面。
// ---------------------------------------------------------------------------

interface DangerousEntry {
  readonly name: string;
  readonly nameZh: string;
  readonly category: UnicodeIssueCategory;
}

const DANGEROUS_CODEPOINTS: ReadonlyMap<number, DangerousEntry> = new Map<number, DangerousEntry>(
  (
    [
      [0x00ad, { name: "SOFT HYPHEN", nameZh: "软连字符", category: "invisible" }],
      [0x034f, { name: "COMBINING GRAPHEME JOINER", nameZh: "组合字素连接符", category: "invisible" }],
      [0x061c, { name: "ARABIC LETTER MARK", nameZh: "阿拉伯字母标记", category: "bidi" }],
      [0x115f, { name: "HANGUL CHOSEONG FILLER", nameZh: "谚文初声填充", category: "invisible" }],
      [0x1160, { name: "HANGUL JUNGSEONG FILLER", nameZh: "谚文中声填充", category: "invisible" }],
      [0x180e, { name: "MONGOLIAN VOWEL SEPARATOR", nameZh: "蒙文元音分隔符", category: "invisible" }],
      [0x200b, { name: "ZERO WIDTH SPACE", nameZh: "零宽空格", category: "zero-width" }],
      [0x200c, { name: "ZERO WIDTH NON-JOINER", nameZh: "零宽非连接符", category: "zero-width" }],
      [0x200d, { name: "ZERO WIDTH JOINER", nameZh: "零宽连接符", category: "zero-width" }],
      [0x200e, { name: "LEFT-TO-RIGHT MARK", nameZh: "从左至右标记", category: "bidi" }],
      [0x200f, { name: "RIGHT-TO-LEFT MARK", nameZh: "从右至左标记", category: "bidi" }],
      [0x2028, { name: "LINE SEPARATOR", nameZh: "行分隔符", category: "invisible" }],
      [0x2029, { name: "PARAGRAPH SEPARATOR", nameZh: "段分隔符", category: "invisible" }],
      [0x202a, { name: "LEFT-TO-RIGHT EMBEDDING", nameZh: "从左至右嵌入", category: "bidi" }],
      [0x202b, { name: "RIGHT-TO-LEFT EMBEDDING", nameZh: "从右至左嵌入", category: "bidi" }],
      [0x202c, { name: "POP DIRECTIONAL FORMATTING", nameZh: "弹出方向格式化", category: "bidi" }],
      [0x202d, { name: "LEFT-TO-RIGHT OVERRIDE", nameZh: "从左至右覆写", category: "bidi" }],
      [0x202e, { name: "RIGHT-TO-LEFT OVERRIDE", nameZh: "从右至左覆写", category: "bidi" }],
      [0x2060, { name: "WORD JOINER", nameZh: "词连接符", category: "zero-width" }],
      [0x2066, { name: "LEFT-TO-RIGHT ISOLATE", nameZh: "从左至右隔离", category: "bidi" }],
      [0x2067, { name: "RIGHT-TO-LEFT ISOLATE", nameZh: "从右至左隔离", category: "bidi" }],
      [0x2068, { name: "FIRST STRONG ISOLATE", nameZh: "首强字符隔离", category: "bidi" }],
      [0x2069, { name: "POP DIRECTIONAL ISOLATE", nameZh: "弹出方向隔离", category: "bidi" }],
      [0xfeff, { name: "ZERO WIDTH NO-BREAK SPACE (BOM)", nameZh: "零宽不换行空格（BOM）", category: "zero-width" }],
    ] as const
  ).map(([cp, entry]) => [cp, entry] as const),
);

/** 表意字符近似（ZWJ 三明治豁免的邻域判定）：emoji 区块 + 杂项符号/ dingbat。
 *  U+200D 夹在两个表意字符之间=合法 emoji ZWJ 序列（👨‍👩‍👧、🏳️‍🌈），不报；
 *  一侧是普通字符（`sa‍fe`）=夹带，报。近似而非全表——只求家庭/彩虹旗等
 *  常见序列零误报（误报门），攻击面（ZWJ 贴着 ASCII 藏私货）保留。 */
function isPictographic(cp: number): boolean {
  return (cp >= 0x1f000 && cp <= 0x1faff) || (cp >= 0x2600 && cp <= 0x27bf) || (cp >= 0x2b00 && cp <= 0x2bff);
}

/** ZWJ 邻域判定时跳过的「序列胶水」码点：变体选择符（❤️=U+2764+U+FE0F——
 *  吻序列里 ZWJ 贴着的是 FE0F 不是表意字符）、keycap U+20E3、tag 字符
 *  （英格兰旗族）。跳过它们再看最近的实义邻居。 */
function isSequenceGlue(cp: number): boolean {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x20e3 || (cp >= 0xe0000 && cp <= 0xe007f);
}

/** 从 `from` 沿 `dir` 找最近的实义邻居，判定是否表意字符（序列胶水跳过）。 */
function pictographicNeighbor(points: readonly string[], from: number, dir: -1 | 1): boolean {
  for (let j = from; j >= 0 && j < points.length; j += dir) {
    const cp = (points[j] as string).codePointAt(0) ?? 0;
    if (!isSequenceGlue(cp)) return isPictographic(cp);
  }
  return false;
}

/** 不可见/危险码点扫描（纯）。按码点迭代（Array.from 口径），每处命中给
 *  {码点, 位置, 类别}。NFC 常规组合字符（Mn 类的 U+0300 等）不在表上——
 *  正常文本零噪音是本函数的第一约束。 */
export function inspectText(text: string, opts: { readonly maxIssues?: number } = {}): UnicodeIssue[] {
  const cap = opts.maxIssues ?? Number.POSITIVE_INFINITY;
  const points = Array.from(text);
  const issues: UnicodeIssue[] = [];
  for (let i = 0; i < points.length && issues.length < cap; i++) {
    const ch = points[i] as string;
    const cp = ch.codePointAt(0) as number;
    const entry = DANGEROUS_CODEPOINTS.get(cp);
    if (entry === undefined) continue;
    // ZWJ 三明治豁免：两侧（跳过序列胶水后）都是表意字符 = 合法 emoji 序列。
    if (cp === 0x200d && pictographicNeighbor(points, i - 1, -1) && pictographicNeighbor(points, i + 1, +1)) continue;
    issues.push({
      codepoint: `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`,
      name: entry.name,
      nameZh: entry.nameZh,
      position: i,
      category: entry.category,
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 同形/全角折叠表（inspectUrl 的单一事实源）。
// deepagents 只有西里尔/希腊/亚美尼亚 26 形；本表超越点 1：全角拉丁/全角
// 标点（FF01..FF5E 整块 = ASCII 0x21..0x7E 平移 0xFEE0）+ 中文句号 U+3002 +
// 表意空格 U+3000 ——中文输入法事故面（`http：//`、`ｅｖｉｌ.com`）。
// ---------------------------------------------------------------------------

/** 混形字符 → 拉丁 canonical（单码点映射）。 */
const CONFUSABLES: ReadonlyMap<number, string> = new Map<number, string>(
  (
    [
      // Cyrillic
      [0x0430, "a"], [0x0435, "e"], [0x043e, "o"], [0x0440, "p"], [0x0441, "c"],
      [0x0443, "y"], [0x0445, "x"], [0x043d, "h"], [0x0456, "i"], [0x0458, "j"],
      [0x043a, "k"], [0x0455, "s"],
      // Greek
      [0x03b1, "a"], [0x03b5, "e"], [0x03bf, "o"], [0x03c1, "p"], [0x03c7, "x"],
      [0x03ba, "k"], [0x03bd, "v"], [0x03c4, "t"],
      // Armenian
      [0x0570, "h"], [0x0578, "n"], [0x057d, "u"],
    ] as const
  ).map(([cp, latin]) => [cp, latin] as const),
);

/** 全角折叠 + 同形折叠：URL 语境的 canonical 形。纯查表——不跑 NFKC（半宽
 *  片假名等的折叠对 URL 无意义且引入噪音）。 */
export function foldConfusables(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    // 全角区 U+FF01..U+FF5E ≡ ASCII !..~ 平移 0xFEE0（ＡＢＣ／：．－全在内）。
    if (cp >= 0xff01 && cp <= 0xff5e) {
      out += String.fromCharCode(cp - 0xfee0);
      continue;
    }
    if (cp === 0x3000) {
      out += " "; // 表意空格
      continue;
    }
    if (cp === 0x3002) {
      out += "."; // 中文句号（域名字符 spoof：evil。com）
      continue;
    }
    out += CONFUSABLES.get(cp) ?? ch;
  }
  return out;
}

/** URL 参数键嗅探（brief 处方六键）。 */
export const URL_ARG_KEYS: ReadonlySet<string> = new Set(["url", "uri", "href", "link", "base_url", "endpoint"]);

/** URL 检查结果（显形数据，非判决）。 */
export interface UrlInspectionResult {
  readonly normalizedUrl: string;
  readonly warnings: string[];
}

const FOLD_PAIR_CAP = 6;

/** URL 视觉检查（纯，不抛）：同形/全角折叠给「真实指向」（归一形），归一
 *  前后不一致即 warn；punycode 注记补「机器实际去哪」（两个方向：Unicode
 *  域名给 punycode 网络名、xn-- 域名给解码形）；隐藏字符进警告。不可解析
 *  的 URL 只丢 punycode 注记，折叠照常（`http：//` 全角 scheme 形不炸）。 */
export function inspectUrl(url: string): UrlInspectionResult {
  const warnings: string[] = [];
  // 隐藏字符先扫（含折叠前的原文——零宽夹带在哪一层都该显形）。
  const hidden = inspectText(url);
  if (hidden.length > 0) {
    const tally = new Map<string, number>();
    for (const issue of hidden) tally.set(`${issue.codepoint} ${issue.nameZh}`, (tally.get(`${issue.codepoint} ${issue.nameZh}`) ?? 0) + 1);
    warnings.push(`含隐藏字符：${[...tally.entries()].map(([label, n]) => (n > 1 ? `${label}×${n}` : label)).join("、")}`);
  }
  // 折叠 + 归一差异点名（哪个字符骗了眼）。
  const folded = foldConfusables(url);
  if (folded !== url) {
    const pairs: string[] = [];
    const seen = new Set<string>();
    for (const ch of url) {
      const f = foldConfusables(ch);
      const key = `${ch}→${f}`;
      if (f !== ch && !seen.has(key)) {
        seen.add(key);
        pairs.push(key);
      }
      if (pairs.length >= FOLD_PAIR_CAP) break;
    }
    warnings.push(`同形/全角字符：${pairs.join("、")}（归一后与所见不一致）`);
  }
  // punycode 双向注记（机器视角）。WHATWG URL 把 Unicode 主机名 IDNA 成
  // punycode——规范 hostname 即「实际网络名」；domainToUnicode 给眼见形。
  // 按原文 authority 分支：眼看的是 Unicode（同形攻击）→ 揭 punycode 名；
  // 眼看的是 xn--（ punycode 域名）→ 揭解码形。两个方向都显形。
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host !== "") {
      const decoded = domainToUnicodeSafe(host);
      if (decoded !== undefined && decoded !== host) {
        const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url)?.[1] ?? "";
        if (/[^\x00-\x7f]/.test(authority)) warnings.push(`实际网络名（punycode）：${host}`);
        else warnings.push(`punycode 域名解码：${decoded}`);
      }
    }
  } catch {
    // 不可解析（全角 scheme 形等）：折叠注记已足，不炸。
  }
  return { normalizedUrl: folded, warnings };
}

function domainToUnicodeSafe(host: string): string | undefined {
  try {
    const decoded = domainToUnicode(host);
    return decoded === "" ? undefined : decoded;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 参数级汇总（帧载荷构造器）。
// ---------------------------------------------------------------------------

const WALK_MAX_DEPTH = 4;
const WALK_MAX_STRINGS = 64;
const SCAN_MAX_CODEPOINTS = 2000;
const ISSUES_CAP = 8;
const URLS_CAP = 8;

/** URL 形启发：键在 URL_ARG_KEYS，或（折叠后）值里出现 http(s)://——后者
 *  覆盖 `curl http：//evil.com` 这类命令内嵌 URL（干净 ASCII URL 检查后零
 *  载荷，无噪音）。非锚定：命令行里 URL 常在中段。 */
function urlShaped(key: string, value: string): boolean {
  const last = key.split(".").pop()?.split("[")[0]?.toLowerCase() ?? "";
  if (URL_ARG_KEYS.has(last)) return true;
  return /https?:\/\//i.test(foldConfusables(value));
}

/** 工具参数的视觉欺骗检查（纯，帧载荷形状）：走嵌套对象/数组（点路径键），
 *  有帽（串数/深度/扫描长度/issue 数/URL 数）保证 ask 路径零失控。无发现
 *  返回 null——调用方据此不带 spoof 键上帧（加性契约的数据面）。 */
export function inspectToolInput(input: Record<string, unknown>): SpoofInspection | null {
  const text: { key: string; issues: UnicodeIssue[]; more?: number }[] = [];
  const urls: UrlInspection[] = [];
  let walked = 0;

  const walk = (value: unknown, key: string, depth: number): void => {
    if (walked >= WALK_MAX_STRINGS || depth > WALK_MAX_DEPTH) return;
    if (typeof value === "string") {
      walked += 1;
      // 扫描窗：头+尾各 SCAN_MAX_CODEPOINTS（超长串两端都在——零宽夹带恰恰
      // 爱藏在末尾； ApprovalDisplayText 显示帽 300 字符，两端窗已覆盖全部
      // 眼见面）。中段超出部分的 position 以窗内计（显示提示用途，够用）。
      const pts = Array.from(value);
      const scan =
        pts.length <= SCAN_MAX_CODEPOINTS
          ? value
          : pts.slice(0, SCAN_MAX_CODEPOINTS).join("") + pts.slice(-SCAN_MAX_CODEPOINTS).join("");
      const all = inspectText(scan);
      if (all.length > 0) {
        const capped = all.slice(0, ISSUES_CAP);
        // more 恒在（0=未超帽）——诚实披露帽的存在本身。
        text.push({ key, issues: capped, more: all.length - capped.length });
      }
      if (urls.length < URLS_CAP && urlShaped(key, value)) {
        const { normalizedUrl, warnings } = inspectUrl(value);
        if (normalizedUrl !== value || warnings.length > 0) {
          urls.push({ key, original: value, normalizedUrl, warnings });
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${key}[${i}]`, depth + 1));
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, key === "" ? k : `${key}.${k}`, depth + 1);
    }
  };
  walk(input, "", 0);
  if (text.length === 0 && urls.length === 0) return null;
  return { text, urls };
}

/** TUI/REPL 共用的单行显形文案（纯渲染，formatToolError 先例）：一行说清
 *  哪个参数藏了什么 + URL 的真实指向。undefined 当且仅当载荷为空——调用
 *  方据此保持字节不变（加性契约的行级表现）。 */
export function formatSpoofLine(spoof: SpoofInspection | undefined | null): string | undefined {
  if (spoof === undefined || spoof === null) return undefined;
  const parts: string[] = [];
  for (const entry of spoof.text) {
    const tally = new Map<string, number>();
    for (const issue of entry.issues) tally.set(`${issue.codepoint} ${issue.nameZh}`, (tally.get(`${issue.codepoint} ${issue.nameZh}`) ?? 0) + 1);
    const labels = [...tally.entries()].map(([label, n]) => (n > 1 ? `${label}×${n}` : label));
    if (entry.more !== undefined) labels.push(`另 ${entry.more} 处`);
    parts.push(`${entry.key} 含${labels.join("、")}`);
  }
  for (const url of spoof.urls) parts.push(`${url.key} 真实指向 ${url.normalizedUrl}`);
  if (parts.length === 0) return undefined;
  return `⚠️ 视觉欺骗检查：${parts.join("；")}`;
}
