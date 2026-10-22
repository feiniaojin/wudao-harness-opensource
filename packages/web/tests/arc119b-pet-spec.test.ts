// @vitest-environment jsdom
// 119b 弧「小精灵弹窗去廉价化」的 census 收据套件——把主窗 116/119 规范
// （hair/elev 令牌 + 圆角 scale 6/8/12 + 气泡 8px 均匀角 + 大区同色画布）
// 扩到宠物窗。pet.css 从「43 处边框/圆角/投影 + 零 var() 消费的字面量孤
// 岛」迁入令牌体系，本套件钉死迁移不回退：
//   ① 令牌共享：pet/main.tsx 与主窗同一份 ../tokens.css（先于 pet.css）；
//   ② 零硬编码色 census：剥注释后的 pet.css 零 hex、零数字 rgb()/rgba()——
//      唯一通道函数形是 rgb(var(--pet-accent…))（精灵品牌绿，pet 域变量）；
//   ③ 圆角全走 scale：每条 border-radius 都是 var(--radius-sm|md|lg|pill)，
//      零复合角（多值）零裸 px；
//   ④ 投影全走 elev 三件套：旧重投影 0 4px 18px 零残留；elev 消费面
//      （.pet-bubble/.pet-toast/.pet-expr）框影不同用——border 退役；
//   ⑤ 边框色 census：hair-1/2/3 或品牌绿通道，无第四种边线；
//   ⑥ 浅色覆写块退役：[data-theme="light"] 零出现——明暗由共享令牌随
//      html[data-theme] 翻转（四主题 × 两明暗都成立，token 值本身由
//      arc116/tokens-contrast 套件把门）；
//   ⑦ 消费令牌零拼错：pet.css 引用的每个 var(--X) 都在 tokens.css 或
//      pet.css 自有 :root 里定义（jsdom 不替换 var()，拼错只能这样抓）；
//   ⑧ 大区同色：a 气泡平铺裸底（无色块对撞）+ 聊天区/输入区发丝线分界。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import "../src/tokens.css";
import "../src/pet/pet.css";

// jsdom 的 fs 锚用 process.cwd() 候选位（178/203 两证，278 同款）。
const readSrc = (rel: string): string => {
  const hit = ["src", "packages/web/src"]
    .map((d) => `${process.cwd()}/${d}/${rel}`)
    .find((p) => existsSync(p));
  if (hit === undefined) throw new Error(`source not found: ${rel}`);
  return readFileSync(hit, "utf8");
};

/** 剥掉块注释后的样式文本——census 只执法真声明，注释里的历史 hex（收据
 *  引用）不在管辖内。 */
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

const petCss = readSrc("pet/pet.css");
const petCode = stripComments(petCss);
const tokensCss = readSrc("tokens.css");
const entry = stripComments(readSrc("pet/main.tsx"));

/** 选择器规则体（行首锚定：`^selector$` 多行匹配 → 其后首个 `{`…`}`）。
 * 278 的 indexOf 首匹配在此不可用——reduce 媒体块与复合选择器（如
 * `.pet-row-pet > .pet-bubble-thinking {`）在文件里先于主规则出现。 */
const ruleBody = (css: string, selector: string): string => {
  const re = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m");
  const m = re.exec(css);
  if (m === null) throw new Error(`selector not found: ${selector}`);
  const open = css.indexOf("{", m.index);
  return css.slice(open, css.indexOf("}", open));
};

describe("119b ① 令牌共享（pet 入口与主窗同一份 tokens.css）", () => {
  it("pet/main.tsx import ../tokens.css 且先于 ./pet.css（令牌先在场）", () => {
    const tokensAt = entry.indexOf('../tokens.css');
    const petCssAt = entry.indexOf('./pet.css');
    expect(tokensAt).toBeGreaterThan(-1);
    expect(petCssAt).toBeGreaterThan(tokensAt);
  });

  it("styles.css 仍不进 pet 入口（ω99-97 隔离的 JS 面不动）", () => {
    // 只执法 import 面（注释里提 styles.css 不算加载）。
    expect(entry.match(/import\s+["'][^"']*styles\.css["']/)).toBeNull();
  });
});

describe("119b ② 零硬编码色 census（剥注释执法）", () => {
  it("零 hex 字面量（皮肤族 hex 只活在注释收据里）", () => {
    expect(petCode.match(/#[0-9a-fA-F]{3,8}\b/)).toBeNull();
  });

  it("零数字 rgb()/rgba()——通道函数只许 rgb(var(--pet-accent…)) 品牌形", () => {
    // 数字开括号形（rgba(30, …) / rgb(14, …)）全退役；剩下的 rgb( 只能跟 var(。
    expect(petCode.match(/rgba?\(\s*[\d.]/)).toBeNull();
    const calls = petCode.match(/rgba?\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0); // 品牌通道形在场（send/ask/selection/focus）
    for (const c of calls) expect(c.startsWith("rgb(var(")).toBe(true);
  });

  it("品牌绿是 pet 域通道变量：三元组定义 + 只以 rgb(var()) 消费", () => {
    expect(petCode).toContain("--pet-accent: 14 159 110;");
    expect(petCode).toContain("--pet-accent-ink: 20 21 25;");
    // 通道值不得被直接当颜色用（var(--pet-accent) 裸消费=无效色）。
    expect(petCode.match(/var\(--pet-accent(-ink)?\);/)).toBeNull();
  });
});

describe("119b ③ 圆角全走 scale（零复合角零裸值）", () => {
  it("每条 border-radius 都是 var(--radius-sm|md|lg|pill) 单值", () => {
    const radii = [...petCode.matchAll(/border-radius:\s*([^;]+);/g)].map((m) => m[1]!.trim());
    expect(radii.length).toBeGreaterThanOrEqual(20); // 旧 census 43 处声明中的 21 条圆角
    // 119a 退役 --radius-pill 后，满圆帽唯一合法形态是 50%（滚动条 thumb 族）。
    for (const r of radii) expect(r).toMatch(/^var\(--radius-(sm|md|lg)\)$|^50%$/);
  });

  it("气泡族 8px 均匀角：q/a/thinking 全 --radius-md，旧 10/10/3 复合角零残留", () => {
    expect(ruleBody(petCss, ".pet-bubble-q {")).toContain("border-radius: var(--radius-md)");
    expect(ruleBody(petCss, ".pet-bubble-a {")).toContain("border-radius: var(--radius-md)");
    expect(ruleBody(petCss, ".pet-bubble-thinking {")).toContain("border-radius: var(--radius-md)");
    expect(petCode.includes("10px 10px")).toBe(false);
  });

  it("浮层卡 12（--radius-lg）：气泡/toast；小件 6（--radius-sm）抽查", () => {
    expect(ruleBody(petCss, ".pet-bubble {")).toContain("border-radius: var(--radius-lg)");
    expect(ruleBody(petCss, ".pet-toast {")).toContain("border-radius: var(--radius-lg)");
    expect(ruleBody(petCss, ".pet-bubble-close {")).toContain("border-radius: var(--radius-sm)");
  });
});

describe("119b ④ 投影换血（elev 三件套；重投影退役）", () => {
  it("每条 box-shadow 都是 var(--elev-*)；旧 0 4px 18px 零残留", () => {
    const shadows = [...petCode.matchAll(/box-shadow:\s*([^;]+);/g)].map((m) => m[1]!.trim());
    // 09-27 报障修：textarea focus 加了品牌绿 focus 环（rgb(var(--pet-accent))，
    // 非 elev）——豁免；elev 三浮层仍全走令牌。
    const elevShadows = shadows.filter((s) => !s.includes("pet-accent"));
    expect(elevShadows.length).toBe(3); // bubble/toast/expr 三浮层
    for (const s of elevShadows) expect(s).toMatch(/^var\(--elev-[123](-soft)?\)$/);
    expect(petCode.includes("4px 18px")).toBe(false);
  });

  it("框影不同用：三个 elev 消费面零 border 声明（描边已在影里）", () => {
    for (const sel of [".pet-bubble {", ".pet-toast {", ".pet-expr {"]) {
      const body = ruleBody(petCss, sel);
      expect(body.includes("border:")).toBe(false);
    }
  });
});

describe("119b ⑤ 边框色 census（hair 三档或品牌绿通道）", () => {
  it("带色的 border 声明只许 var(--hair-*) / rgb(var(--pet-accent)) / var(--surface) / transparent", () => {
    const borders = [...petCode.matchAll(/border[^:]*:\s*[^;]+;/g)].map((m) => m[0]);
    expect(borders.length).toBeGreaterThan(10);
    for (const b of borders) {
      // border: 1px solid X / border-top-color: X 两形取色值执法；none/宽度式
      // 无色值自然跳过。
      const color = b.match(/(?:solid|color:)\s+([^;]+);/)?.[1];
      if (color !== undefined) {
        expect(color).toMatch(
          /^(var\(--hair-[123]\)|rgb\(var\(--pet-accent\)(\s*\/\s*[\d.]+)?\)|var\(--surface\)|transparent)$/,
        );
      }
    }
  });
});

describe("119b ⑥ 浅色覆写块退役（主题=令牌翻转，非第二套色）", () => {
  it("[data-theme=\"light\"] 在 pet.css 零出现（26 行覆写块整体退役）", () => {
    expect(petCode.includes('[data-theme="light"]')).toBe(false);
  });

  it("中性面/字色走全局令牌（四主题组合下随 tokens.css 翻转）", () => {
    expect(ruleBody(petCss, ".pet-bubble {")).toContain("background: var(--surface)");
    expect(ruleBody(petCss, ".pet-bubble {")).toContain("color: var(--text-1)");
    expect(ruleBody(petCss, ".pet-bubble-q {")).toContain("background: var(--bubble-user-bg)");
    expect(ruleBody(petCss, ".pet-bubble-q {")).toContain("color: var(--bubble-user-ink)");
  });

  it("CSSOM：共享令牌在两主题下确翻转（--surface/--text-1/--hair-1 各得两组值）", () => {
    const root = document.documentElement;
    const prop = (name: string): string => getComputedStyle(root).getPropertyValue(name).trim();
    root.dataset.theme = "dark";
    const darkSurface = prop("--surface");
    const darkText = prop("--text-1");
    root.dataset.theme = "light";
    const lightSurface = prop("--surface");
    const lightText = prop("--text-1");
    expect(darkSurface).not.toBe(lightSurface);
    expect(darkText).not.toBe(lightText);
    delete root.dataset.theme;
  });
});

describe("119b ⑦ 消费令牌零拼错（jsdom 不替换 var()，拼错只能源级抓）", () => {
  it("pet.css 引用的每个 var(--X) 都有定义（tokens.css 或 pet.css :root）", () => {
    const consumed = new Set([...petCss.matchAll(/var\((--[A-Za-z0-9-]+)/g)].map((m) => m[1]));
    expect(consumed.size).toBeGreaterThan(15);
    const defined = new Set([...`${tokensCss}${petCss}`.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)].map((m) => m[1]));
    for (const name of consumed) {
      expect(defined.has(name), `pet.css 消费了未定义令牌 ${name}`).toBe(true);
    }
  });
});

describe("119b ⑧ 大区同色画布（聊天气泡/输入区不再色块对撞）", () => {
  it("a 气泡平铺裸底（与主窗 assistant 平铺同策）；思考格同形", () => {
    expect(ruleBody(petCss, ".pet-bubble-a {")).toContain("background: transparent");
    expect(ruleBody(petCss, ".pet-bubble-thinking {")).toContain("background: transparent");
  });

  it("聊天区/输入区以发丝线分界（.pet-bubble-input 顶线 hair-1）", () => {
    const input = ruleBody(petCss, ".pet-bubble-input {");
    expect(input).toContain("border-top: 1px solid var(--hair-1)");
  });

  it("ask/selection 两卡同面 --surface-2（旧 #E6F4EC/#E8F1F4 变体色块对撞退役）", () => {
    expect(ruleBody(petCss, ".pet-bubble-ask {")).toContain("background: var(--surface-2)");
    expect(ruleBody(petCss, ".pet-bubble-selection {")).toContain("background: var(--surface-2)");
  });
});
