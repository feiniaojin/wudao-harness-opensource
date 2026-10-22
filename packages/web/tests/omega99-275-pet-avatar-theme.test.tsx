// @vitest-environment jsdom
// ω99-275: #12 — 三合一收据（用户令 09-10「浅色气泡太深 / 助手头像换小精灵
// / 主窗切主题小精灵也切」）：
// ① 浅色用户气泡：三 accent 的浅色淡染对对比度 ≥4.5:1（hex 字面量直算）；
//    暗色走 var(--accent) 懒解析（源级收据——三 accent 暗色气泡与改造前
//    逐字节同，无需逐 accent 复写）。
// ② 助手消息头像：AssistantReply 挂 .sig-avatar 空挂点（16px 单帧裁切）；
//    styles.css 四肤规则 URL === PET_SKIN_SHEETS（单一事实源防漂移）；
//    主窗入口双通路 stamp html[data-pet-skin]（boot get_pet_skin + 换肤
//    事件 live）+ 能力位。
// ③ 主题联动：applyTheme 广播 wudao-pet-theme（mock emit 行为断言）+ 宠物
//    窗 boot 同源 localStorage stamp + live 监听（源级收据）+ pet.css 浅色
//    覆盖块锚。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { readStyles } from "./styles-source.js";
import { mount, decl, unmount } from "./css-test-utils.js";
import { AssistantReply } from "../src/components/AssistantReply.js";
import { applyTheme } from "../src/theme.js";
import { tauriEmitEvent } from "../src/tauri-invoke.js";
import { PET_SKIN_IDS, PET_SKIN_SHEETS, normalizePetSkinId } from "../src/pet/skin-ids.js";
import { WUDAO_PET_THEME_EVENT } from "../src/pet/pet-frame.js";
import "../src/styles.css";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/tauri-invoke.js", () => ({
  tauriEmitEvent: vi.fn(async () => false),
  tauriInvokeCommand: vi.fn(async () => null),
  tauriListenEvent: vi.fn(async () => null),
  // 117 玻璃化：applyTheme 起同缝拨窗口主题（set_theme）——mock 全替工厂
  // 必须补齐该导出，否则 applyTheme 调用即 TypeError。
  tauriSetWindowTheme: vi.fn(async () => false),
}));

const emitMock = vi.mocked(tauriEmitEvent);

// jsdom 的 fs 锚用 process.cwd() 候选位（178/203 两证——import.meta.url 在
// jsdom 环境不可靠）。
const readSrc = (rel: string): string => {
  const hit = ["src", "packages/web/src"]
    .map((d) => `${process.cwd()}/${d}/${rel}`)
    .find((p) => existsSync(p));
  if (hit === undefined) throw new Error(`source not found: ${rel}`);
  return readFileSync(hit, "utf8");
};
const readMainCapability = (): string => {
  const p = `${process.cwd()}/../../apps/desktop/src-tauri/capabilities/main.json`;
  if (!existsSync(p)) throw new Error("main.json capability not found");
  return readFileSync(p, "utf8");
};

// WCAG 2.x 相对亮度（与 tokens-contrast.test 同式；不 import 那个文件——
// 测试互 import 会把对方的 describe 也注册进来）。
const channel = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string): number => {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
const contrast = (fg: string, bg: string): number => {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi !== undefined && lo !== undefined ? (hi + 0.05) / (lo + 0.05) : 1);
};

// 浅色用户气泡（116 弧 A 起为中性对——气泡去品牌色，三 accent 同值）。
// 此表钉值——sheet 改色本测试红。
const LIGHT_BUBBLE: readonly [string, string] = ["#1B1C22", "#E9EAEF"];

afterEach(unmount);

describe("ω99-275 ① 浅色用户气泡可读性（token 化；116 弧 A 起中性）", () => {
  it("① 中性浅色气泡对 ≥4.5:1（AA normal——气泡是 14px 小字）", () => {
    const [ink, bg] = LIGHT_BUBBLE;
    expect(contrast(ink, bg), `${ink} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it("① 气泡对单一源自主题块（dark=白 alpha 叠层 / light=中性冷灰对），accent 块零覆写（116 弧 A）", () => {
    const tokens = readSrc("tokens.css");
    // 暗色：白 alpha 叠层 + 浅色：中性冷灰对（字面量锚；bubble 语义收据）。
    expect(tokens).toContain("--bubble-user-bg: rgba(255,255,255,.09); --bubble-user-ink: #EAEAE6;");
    expect(tokens).toContain("--bubble-user-bg: #E9EAEF; --bubble-user-ink: #1B1C22;");
    // 逐 accent 的气泡覆写全数退役（气泡与主色选择无关）。
    expect(tokens).not.toContain("--bubble-user-bg: var(--accent)");
    expect(tokens).not.toContain("--bubble-user-bg: #E3F4EB");
    expect(tokens).not.toContain("--bubble-user-bg: #E8EDFE");
    expect(tokens).not.toContain("--bubble-user-bg: #E7E7E4");
    expect(tokens).not.toContain('[data-accent="blue"][data-theme="light"]');
  });

  it("① blue 块仍声明于 black-light 块之后（ruleBlock 首匹配——tokens-contrast 的 blue --accent 仍读纯块）", () => {
    const tokens = readSrc("tokens.css");
    expect(tokens.indexOf('[data-accent="blue"]  {')).toBeGreaterThan(-1);
    expect(tokens.indexOf('[data-accent="blue"]:not(')).toBeGreaterThan(
      tokens.indexOf('[data-accent="blue"]  {'),
    );
  });
});

describe("ω99-275 ② 助手消息头像=小精灵当前肤", () => {
  it("② AssistantReply 挂 .sig-avatar（16px 单帧裁切同 .pet-avatar 范式）；悟字徽标退役", () => {
    const c = mount(<AssistantReply>正文</AssistantReply>);
    expect(c.querySelector(".msg-a .sig-avatar")).not.toBeNull();
    expect(c.querySelector(".msg-a .sig-glyph")).toBeNull(); // 悟字退役（.sig-glyph 规则保留给 HistoryList 的「注」徽标）
    expect(decl(".sig-avatar", "width")).toBe("16px");
    expect(decl(".sig-avatar", "background-size")).toBe("200% auto");
    expect(decl(".sig-avatar", "background-position")).toBe("0 center");
  });

  it("② styles.css 四肤规则 URL === PET_SKIN_SHEETS（单一事实源防漂移）且全 id 有规则", () => {
    const css = readStyles();
    for (const id of PET_SKIN_IDS) {
      expect(css).toContain(`[data-pet-skin="${id}"] .sig-avatar { background-image: url("${PET_SKIN_SHEETS[id]}"); }`);
    }
  });

  it("② 主窗入口双通路 stamp html[data-pet-skin]（boot get_pet_skin + 换肤事件 live）+ 能力位", () => {
    const main = readSrc("main.tsx");
    expect(main).toContain('tauriInvokeCommand("get_pet_skin", {})');
    expect(main).toContain("document.documentElement.dataset.petSkin = normalizePetSkinId(raw)");
    expect(main).toContain("tauriListenEvent(WUDAO_PET_SKIN_EVENT");
    expect(main).toContain("document.documentElement.dataset.petSkin = id;");
    expect(readMainCapability()).toContain('"allow-get-pet-skin"');
  });

  it("② normalizePetSkinId wire 规则：注册表内原样过，其余一切读 default", () => {
    for (const id of PET_SKIN_IDS) expect(normalizePetSkinId(id)).toBe(id);
    expect(normalizePetSkinId("bogus")).toBe("default");
    expect(normalizePetSkinId(42)).toBe("default");
    expect(normalizePetSkinId(null)).toBe("default");
  });
});

describe("ω99-275 ③ 主窗切主题 → 小精灵窗联动", () => {
  beforeEach(() => {
    emitMock.mockClear();
    localStorage.removeItem("wudao.ui.theme");
    delete document.documentElement.dataset.theme;
  });

  it("③ applyTheme 广播 wudao-pet-theme {theme}（单一缝：boot stamp 与所有切换点都过它）", () => {
    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("wudao.ui.theme")).toBe("light");
    expect(emitMock).toHaveBeenCalledWith(WUDAO_PET_THEME_EVENT, { theme: "light" });
    applyTheme("dark");
    expect(emitMock).toHaveBeenCalledWith(WUDAO_PET_THEME_EVENT, { theme: "dark" });
  });

  it("③ 宠物窗 boot 读同源 localStorage + live 监听 stamp html[data-theme]（源级收据；ω99-291 拆分后 live 监听钉挪 signals.ts，boot stamp 钉留入口）", () => {
    const pet = readSrc("pet/main.tsx");
    expect(pet).toContain('localStorage.getItem("wudao.ui.theme") === "light" ? "light" : "dark"');
    const signals = readSrc("pet/signals.ts");
    expect(signals).toContain("tauriListenEvent(WUDAO_PET_THEME_EVENT");
    expect(signals).toContain("document.documentElement.dataset.theme = t;");
  });

  it("③ pet.css 主题机制（119b 令牌化收据）：浅色覆写块整体退役，明暗随共享 tokens.css 翻转", () => {
    const css = readSrc("pet/pet.css");
    // 旧 [data-theme="light"] 整块覆写（26 行）退役——浅色不再是覆写出来的
    // 第二套色，而是同一套令牌在 html[data-theme="light"] 上的另一组值。
    // （剥注释执法：119b 的退役注记本身会提到这个词，不算残留。）
    const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code.includes('[data-theme="light"]')).toBe(false);
    // 令牌消费锚：浮层卡面/字色/投影走全局令牌（四主题 × 两明暗都成立）。
    expect(css).toContain("background: var(--surface)");
    expect(css).toContain("color: var(--text-1)");
    expect(css).toContain("box-shadow: var(--elev-2)");
    // 入口与主窗共享同一份 tokens.css（先于 pet.css——令牌先在场）。
    const entry = readSrc("pet/main.tsx");
    const tokensAt = entry.indexOf('../tokens.css');
    const petCssAt = entry.indexOf('./pet.css');
    expect(tokensAt).toBeGreaterThan(-1);
    expect(petCssAt).toBeGreaterThan(tokensAt);
  });
});
