// @vitest-environment jsdom
// 117 玻璃化（vibrancy）收据套件——去廉价化第四弧（窗口玻璃化）。依据
// docs/research/117-vibrancy-probe.md §6（真机定谳）+ 116 §3e（dsh 侧栏
// 蓝洗范式）。六面钉：
//   ① 玻璃门存在性：html.glass body 透明（底交材质）；基座规则零改动
//      （body/sb 的非玻璃态样式 = 玻璃化之前原样——浏览器天然降级钉）；
//   ② 侧栏蓝洗：.sb / .ide-cell.ide-left / .set-nav 三侧栏面在玻璃门内
//      透明底 + 通道令牌渐变 rgb(var(--accent-rgb) / .08)（禁裸 hex）；
//   ③ 内容列实底保持：.chat / .ide-cell.ide-center / .set-body 玻璃门内
//      var(--bg) 实底（性能税隔离承重墙——60fps 重绘全落不透明像素）；
//      .composer 的 var(--surface) 实底是既有规则（本弧零改动钉）；
//   ④ conf 侧：主窗 transparent + windowEffects(sidebar/active) 且
//      backgroundColor 已删（探针 §1b：不删则实底盖死材质）；宠物窗零
//      windowEffects（探针未验其合成路径，不动）；
//   ⑤ 门控施加：main.tsx 在 ?shell=desktop 处 stamp html.glass（与
//      data-shell 同握手同点位）；宠物入口零 glass（独立页面永不沾门）；
//   ⑥ 主题联动：applyTheme 同缝拨窗口主题（mock 行为断言，dark/light
//      双向）+ 能力位 allow-set-theme 在 main-capability。
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { stylesCss } from "./styles-source.js";
import { decl, prop, unmount } from "./css-test-utils.js";
import { applyAccent, applyTheme } from "../src/theme.js";
import { tauriEmitEvent, tauriSetWindowTheme } from "../src/tauri-invoke.js";
import "../src/styles.css";
import "../src/tokens.css";

vi.mock("../src/tauri-invoke.js", () => ({
  tauriEmitEvent: vi.fn(async () => false),
  tauriSetWindowTheme: vi.fn(async () => false),
}));

const setThemeMock = vi.mocked(tauriSetWindowTheme);
const emitMock = vi.mocked(tauriEmitEvent);

// jsdom 的 fs 锚用 process.cwd() 候选位（178/203 两证——import.meta.url 在
// jsdom 环境不可靠；omega99-275 同款）。
const readMaybe = (rel: string): string | null => {
  const hit = ["../../", "../../../"]
    .map((p) => `${process.cwd()}/${p}${rel}`)
    .find((p) => existsSync(p));
  return hit === undefined ? null : readFileSync(hit, "utf8");
};
const mustRead = (rel: string): string => {
  const v = readMaybe(rel);
  if (v === null) throw new Error(`not found: ${rel}`);
  return v;
};

afterEach(() => {
  unmount();
  document.documentElement.classList.remove("glass");
  setThemeMock.mockClear();
  emitMock.mockClear();
});

// ---------------------------------------------------------------------------
// ① 玻璃门存在性 + 非 glass 态零变化
// ---------------------------------------------------------------------------
describe("117 ① 玻璃门——html.glass 的存在性与基座零改动", () => {
  it("① glass 门内 body 透明（窗底交给 vibrancy 材质）", () => {
    // 门内：透明交底。源级 + CSSOM 双钉（CSSOM 证明规则真实进级联；jsdom
    // 不展开 shorthand 到 longhand，background-color 读 shorthand 键）。
    expect(stylesCss).toMatch(/html\.glass body\s*\{[^}]*background:\s*transparent;/s);
    expect(decl("html.glass body", "background")).toBe("transparent");
  });

  it("① 非 glass 态基座零变化：body 仍 var(--bg) 实底、.sb 仍 var(--bg)（浏览器 = 玻璃化前原样）", () => {
    expect(stylesCss).toMatch(/(?<!\.)body\s*\{[^}]*background:\s*var\(--bg\);/s);
    // .sb 的基座实底规则在 50-ide.css 原样（玻璃覆盖走 html.glass 前缀更高
    // 特异性，不是改基座）。
    expect(stylesCss).toMatch(/\.sb\s*\{[^}]*background:\s*var\(--bg\);/s);
  });

  it("① 玻璃规则全部挂 html.glass 前缀（sheet 内零裸选择器——浏览器永不沾玻璃）", () => {
    const glass = mustRead("packages/web/src/styles/05-glass.css");
    // 选择器组 = 花括号前的整段捕获（捕获段禁含「/」——注释闭合 */ 天然
    // 截断，注释体进不了组）；组内每个逗号段都必须以 html.glass 起头。
    const groups = [...glass.matchAll(/(?:^|\n)((?:[^\n{}\/]|\n)*?)\s*\{/g)]
      .map((m) => m[1] ?? "")
    // 防御：必须恰捕三组（body 门 / 侧栏族 / 内容列族）——空通过 = 假绿。
    expect(groups.length).toBe(3);
    for (const g of groups) {
      const parts = g.split(",").map((s) => s.trim()).filter((s) => s !== "");
      expect(parts.length, `group "${g}"`).toBeGreaterThan(0);
      for (const p of parts) {
        expect(p.startsWith("html.glass"), `selector not glass-gated: ${p}`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// ② 侧栏蓝洗（通道令牌）
// ---------------------------------------------------------------------------
describe("117 ② 侧栏蓝洗——三侧栏面透明底 + accent 通道令牌渐变", () => {
  const WASH = "linear-gradient(180deg, rgb(var(--accent-rgb) / .08), transparent 60%)";

  it("② .sb（buddy 会话侧栏）透明底 + 蓝洗渐变（CSSOM 声明值）", () => {
    expect(decl("html.glass .sb", "background-color")).toBe("transparent");
    expect(decl("html.glass .sb", "background-image")).toBe(WASH);
  });

  it("② .ide-cell.ide-left（高级模式文件树列）与 .set-nav（设置左导航）同款洗色", () => {
    expect(stylesCss).toMatch(/html\.glass \.ide-cell\.ide-left,\s*\nhtml\.glass \.set-nav\s*\{/);
    expect(decl("html.glass .ide-cell.ide-left", "background-image")).toBe(WASH);
    expect(decl("html.glass .set-nav", "background-image")).toBe(WASH);
  });

  it("② 洗色走 --accent-rgb 通道令牌（玻璃 sheet 禁裸 hex——WKWebView 兼容层纪律）", () => {
    const glass = mustRead("packages/web/src/styles/05-glass.css");
    // 整个 glass sheet 不得出现任何 hex 色字面量（含注释外的全部字节；
    // 通道令牌 rgb(var(--X-rgb) / α) 是唯一透明度形态）。
    expect(glass).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    // 且渐变确实消费 --accent-rgb（不是别的通道）。
    expect(glass).toContain("rgb(var(--accent-rgb) / .08)");
  });

  it("② 四主题组合：洗色随 accent 通道翻色、随主题翻底（令牌断言级视觉核对）", () => {
    // 洗色声明恒为通道形态（上面已钉）；每个组合下 --accent-rgb/--bg 的解析
    // 值 = tokens.css 该组合的定义值——玻璃上的色流与窗底随组合正确翻转。
    const COMBOS: ReadonlyArray<readonly [string, string, string]> = [
      ["dark+green", "18 168 116", "#141519"],
      ["light+green", "11 122 85", "#F5F6F8"],
      ["light+black", "17 17 17", "#F5F6F8"],
      ["light+blue", "47 84 235", "#F5F6F8"],
    ];
    for (const [name, accent, bg] of COMBOS) {
      const light = name.startsWith("light");
      applyTheme(light ? "light" : "dark");
      applyAccent(name.endsWith("black") ? "black" : name.endsWith("blue") ? "blue" : "green");
      expect(prop("--accent-rgb"), `${name} accent-rgb`).toBe(accent);
      expect(prop("--bg"), `${name} bg`).toBe(bg);
      // 声明不随组合变（通道形态恒定），解析通道随组合变——这正是「蓝洗走
      // 令牌」的全部含义。
      expect(decl("html.glass .sb", "background-image")).toBe(WASH);
    }
    // 归位（不泄漏到同文件后续 describe）。
    applyTheme("dark");
    applyAccent("green");
  });
});

// ---------------------------------------------------------------------------
// ③ 内容列实底保持（性能税隔离）
// ---------------------------------------------------------------------------
describe("117 ③ 内容列实底——玻璃只在侧栏与窗缘显形", () => {
  it("③ .chat / .ide-cell.ide-center / .set-body 玻璃门内 var(--bg) 实底", () => {
    expect(stylesCss).toMatch(
      /html\.glass \.chat,\s*\nhtml\.glass \.ide-cell\.ide-center,\s*\nhtml\.glass \.set-body\s*\{[^}]*background:\s*var\(--bg\);/s,
    );
  });

  it("③ .composer 输入条保持 var(--surface) 实底（既有规则本弧零改动）", () => {
    expect(stylesCss).toMatch(/\.composer\s*\{[^}]*?background:\s*var\(--surface\);/s);
  });

  it("③ 玻璃 sheet 不重复声明 .composer（洗色/透明化不得伸进输入条）", () => {
    const glass = mustRead("packages/web/src/styles/05-glass.css");
    expect(glass).not.toContain(".composer");
  });
});

// ---------------------------------------------------------------------------
// ④ conf 侧（探针 §1b/§6 的硬边界）
// ---------------------------------------------------------------------------
describe("117 ④ tauri.conf.json——主窗玻璃化 + 宠物窗不动", () => {
  type Win = { label?: string; backgroundColor?: string; transparent?: boolean; windowEffects?: unknown };
  const conf = JSON.parse(mustRead("apps/desktop/src-tauri/tauri.conf.json")) as {
    app: { windows: Win[] };
  };
  const main = conf.app.windows.find((w) => w.label === "main");
  const pet = conf.app.windows.find((w) => w.label === "pet");

  it("④ 主窗：backgroundColor 已删（不删则实底盖死材质）+ transparent + sidebar/active", () => {
    expect(main).toBeDefined();
    expect(main && "backgroundColor" in main).toBe(false);
    expect(main?.transparent).toBe(true);
    expect(main?.windowEffects).toEqual({ effects: ["sidebar"], state: "active", radius: 0 });
  });

  it("④ 宠物窗：零 windowEffects（探针未验其合成路径——不动 receipt）", () => {
    expect(pet).toBeDefined();
    expect(pet && "windowEffects" in pet).toBe(false);
    expect(pet?.transparent).toBe(true); // 它自己的既有透明管线（无材质）
  });
});

// ---------------------------------------------------------------------------
// ⑤ 门控施加（stamp 位）
// ---------------------------------------------------------------------------
describe("117 ⑤ html.glass 的施加——主入口 stamp、宠物入口零沾", () => {
  it("⑤ main.tsx：?shell=desktop 同点位 stamp glass（与 data-shell 同握手通道）", () => {
    const entry = mustRead("packages/web/src/main.tsx");
    expect(entry).toMatch(/if \(shell === "desktop"\) document\.documentElement\.classList\.add\("glass"\);/);
  });

  it("⑤ 宠物入口与 pet.html 零 glass stamp（独立页面永不进玻璃门）", () => {
    expect(mustRead("packages/web/src/pet/main.tsx")).not.toContain("glass");
    expect(mustRead("packages/web/pet.html")).not.toContain("glass");
  });
});

// ---------------------------------------------------------------------------
// ⑥ 主题联动（材质明暗随 CSS 主题同缝翻转）
// ---------------------------------------------------------------------------
describe("117 ⑥ 主题联动——applyTheme 同缝拨窗口主题", () => {
  it("⑥ applyTheme(light/dark) → tauriSetWindowTheme 同值（探针 P2：set_theme 当场翻材质）", () => {
    // 联动是玻璃形态专属（无玻璃 = 无材质可同步）：主入口先 stamp glass
    // 再 stampPersistedAppearance——收据按同序模拟。
    document.documentElement.classList.add("glass");
    applyTheme("light");
    expect(setThemeMock).toHaveBeenCalledWith("light");
    applyTheme("dark");
    expect(setThemeMock).toHaveBeenCalledWith("dark");
    // 宠物广播（ω99-275 单一缝）与窗口主题同一缝共存。
    expect(emitMock).toHaveBeenCalledWith("wudao-pet-theme", { theme: "dark" });
  });

  it("⑥ 非 glass 态零联动（浏览器/宠物 = 无材质，无额外 invoke）", () => {
    applyTheme("light");
    expect(setThemeMock).not.toHaveBeenCalled();
  });

  it("⑥ 能力位：main-capability 授 core:window:allow-set-theme", () => {
    const cap = JSON.parse(mustRead("apps/desktop/src-tauri/capabilities/main.json")) as {
      permissions: string[];
    };
    expect(cap.permissions).toContain("core:window:allow-set-theme");
  });

  it("⑥ invoke 缝：plugin:window|set_theme 的命令名与 value 参数形（源级钉，防漂移）", () => {
    const seam = mustRead("packages/web/src/tauri-invoke.ts");
    expect(seam).toMatch(/invoke\("plugin:window\|set_theme", \{ value: theme \}\)/);
  });
});
