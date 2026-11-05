// @vitest-environment jsdom
// ω99-98 — the skin registry, RED-first: the skin seam must be a seam, not
// a promise — PET_SKINS carries a renderable component per id, every skin
// DECLARES (and so must keep) coverage of all seven PetDisplayState values,
// and rendering for each value never crashes and stamps the root contract
// attributes. Registry lookup lives in pet/main.tsx (the only consumer —
// keeps PetSprite↔skins a single directed import), so these renders pass
// the registry's entry explicitly, exactly as the entry does.
// ω99-111 期望变更（依据：用户 0.3.45 反馈「支持换肤，用户可以换成其他形象」
// + brief §2）——注册表从 default 一项扩到四肤（default/sakura/lake/honey），
// 形象从单张 <img> 换成 2 帧 sheet 的 background-div（steps(1) 换帧需要
// background-position，img 做不到）；assets 由 scripts/make-logo-sprite.py
// 产出为 public/pet/skin-<id>.png（logo-sprite.png 退役）。
// 2026-11-05 用户令「换肤能够切换小精灵或者 power.png 这两种展示，直接改变
// 形象」——第五肤 power（力量形态=小精灵长大之后的成年形象）：不同形象同一
// 工厂同一 DOM 契约；帧 1:1（slime 族 390/238），pet.css 只覆写 aspect-ratio
// （几何契约钉见下方 power 专属 describe）；资产 scripts/make-power-sprite.py。
import { describe, expect, it, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PET_SKINS, normalizePetSkinId } from "../src/pet/skins/index.js";
import { PetSprite, sheetSkin } from "../src/pet/PetSprite.js";
import type { PetDisplayState } from "../src/pet/pet-state.js";
import { mount, unmount } from "./css-test-utils.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ALL_STATES: readonly PetDisplayState[] = [
  "idle",
  "thinking",
  "working",
  "answering",
  "waiting-user",
  "done",
  "drag",
];
const ALL_SKINS = ["default", "sakura", "lake", "honey", "power"] as const;

afterEach(unmount);

describe("ω99-111 pet 皮肤注册表（五肤：四色 + 力量形态）", () => {
  it("注册表恰为五肤：default/sakura/lake/honey/power，每肤 component 可渲染且 states 覆盖七值", () => {
    expect(Object.keys(PET_SKINS).sort()).toEqual([...ALL_SKINS].sort());
    for (const id of ALL_SKINS) {
      const skin = PET_SKINS[id];
      expect(typeof skin.component, `skin=${id}`).toBe("function");
      // 既有钉（ω99-98）逐肤同钉：default 必须全覆盖七态 → 每肤都必须。
      expect([...skin.states].sort(), `skin=${id}`).toEqual([...ALL_STATES].sort());
    }
  });

  it("每肤渲染 background-div（非 img）：backgroundImage 指向自己的 sheet", () => {
    for (const id of ALL_SKINS) {
      const Figure = PET_SKINS[id].component;
      const c = mount(<Figure display="working" />);
      // ω99-111 期望变更（依据：steps(1) 换帧需要 background-position——
      // img 只能换 src 会闪；figure 仍 state-agnostic（无 JS 状态分支）。
      expect(c.querySelectorAll("img").length, `skin=${id}`).toBe(0);
      const div = c.querySelector<HTMLElement>(".pet-figure .pet-sprite-img");
      expect(div, `skin=${id}`).not.toBeNull();
      expect(div?.style.backgroundImage, `skin=${id}`).toContain(`/pet/skin-${id}.png`);
    }
  });

  it("旧资产退役：default 皮不再引用 logo-sprite.png（由 skin-default.png 取代）", () => {
    const c = mount(<PET_SKINS.default.component display="idle" />);
    expect(c.innerHTML).not.toContain("logo-sprite");
    expect(c.querySelector<HTMLElement>(".pet-figure .pet-sprite-img")?.style.backgroundImage).toContain(
      "/pet/skin-default.png",
    );
  });

  it("sheetSkin 工厂：任意 sheetUrl 产出同构组件（backgroundImage=该 url，无 img）", () => {
    const Custom = sheetSkin("/pet/skin-custom.png");
    const c = mount(<Custom display="idle" />);
    const div = c.querySelector<HTMLElement>(".pet-figure .pet-sprite-img");
    expect(div?.style.backgroundImage).toContain("url(/pet/skin-custom.png)");
    expect(c.querySelectorAll("img").length).toBe(0);
    expect(c.querySelector(".pet-figure")).not.toBeNull();
  });

  it("逐值渲染不炸：root 带 data-skin=<id> 与对应 data-pet-state（四肤 × 七态）", () => {
    for (const id of ALL_SKINS) {
      for (const s of ALL_STATES) {
        const c = mount(<PetSprite display={s} skinId={id} figure={PET_SKINS[id].component} />);
        const root = c.querySelector<HTMLElement>("[data-pet-root]");
        expect(root, `skin=${id} state=${s}`).not.toBeNull();
        expect(root?.getAttribute("data-skin"), `skin=${id} state=${s}`).toBe(id);
        expect(root?.getAttribute("data-pet-state"), `skin=${id} state=${s}`).toBe(s);
        unmount();
      }
    }
  });

  it("paused 属性透传：root 带 data-paused（省缺不带）", () => {
    const c = mount(<PetSprite display="idle" paused={true} />);
    expect(c.querySelector<HTMLElement>("[data-pet-root]")?.hasAttribute("data-paused")).toBe(true);
    unmount();
    const c2 = mount(<PetSprite display="idle" />);
    expect(c2.querySelector<HTMLElement>("[data-pet-root]")?.hasAttribute("data-paused")).toBe(false);
  });
});

describe("力量形态（power）几何契约钉（0.3.78 教训：DOM 形断言≠几何，逐消费面钉）", () => {
  const read = (rel: string) =>
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), rel), "utf8");

  it("pet.css：[data-skin=power] 三件覆写——aspect 1/1 + width 88 + left 4（compact 随肤窗 120 不裁头）", () => {
    const petCss = read("../src/pet/pet.css");
    expect(petCss).toContain('[data-skin="power"] .pet-sprite-img');
    expect(petCss).toContain("aspect-ratio: 1 / 1");
    expect(petCss).toMatch(/\[data-skin="power"\] \.pet-sprite-img[^}]*width: 88px;/s);
    expect(petCss).toMatch(/\[data-skin="power"\] \.pet-sprite-img[^}]*left: 4px;/s);
    // 基线几何不因第五肤漂移：slime 帧比仍是 390/238（既有族契约原样钉）
    expect(petCss).toContain("aspect-ratio: 390 / 238");
  });

  it("换肤即时重应用布局：usePetLayoutSync(mode, skinId) 双依赖（Rust 按肤解析 compact 高度）", () => {
    const signals = read("../src/pet/signals.ts");
    expect(signals).toContain("export function usePetLayoutSync(mode: PetLayoutMode, skinId: PetSkinId)");
    expect(signals).toMatch(/\}, \[mode, skinId\]\);/);
    const petApp = read("../src/pet/PetApp.tsx");
    expect(petApp).toContain("usePetLayoutSync(layoutMode, skinId)");
  });

  it("00-base.css：power 的 sig-avatar 与 hero/connect logo 规则在（URL 同 PET_SKIN_SHEETS）", () => {
    const base = read("../src/styles/00-base.css");
    expect(base).toContain('[data-pet-skin="power"] .sig-avatar { background-image: url("/pet/skin-power.png"); }');
    // hero 盒 64×40 容不下 1:1 帧：power 收窄 width 40px（200% auto 下帧恰合盒高）
    expect(base).toContain('[data-pet-skin="power"] .hero .logo, [data-pet-skin="power"] .connect-card .logo {');
    expect(base).toMatch(/\[data-pet-skin="power"\] \.hero \.logo[^}]*width: 40px;/s);
    expect(base).toContain('url("/pet/skin-power.png")');
  });

  it("sheet 资产在场：public/pet/skin-power.png（2 帧 1:1，两帧同图）", async () => {
    const png = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../public/pet/skin-power.png"));
    expect(png.length, "资产存在且非空").toBeGreaterThan(1000);
    // PNG IHDR: 宽=高×2（两帧并排，帧 1:1）——字节级几何钉，防再生成时比例漂移
    const w = png.readUInt32BE(16);
    const h = png.readUInt32BE(20);
    expect(w).toBe(h * 2);
  });
});

describe("ω99-111 normalizePetSkinId（皮肤 id 归一）", () => {
  it("注册表内的 id 原样通过", () => {
    for (const id of ALL_SKINS) expect(normalizePetSkinId(id)).toBe(id);
  });
  it("注册表外的字符串、非字符串一律归一 default", () => {
    // 依据：Rust 侧 pet-skin.json 缺失/损坏/非法 id → "default"，两侧同规。
    expect(normalizePetSkinId("nope")).toBe("default");
    expect(normalizePetSkinId("DEFAULT")).toBe("default");
    expect(normalizePetSkinId("")).toBe("default");
    expect(normalizePetSkinId(undefined)).toBe("default");
    expect(normalizePetSkinId(null)).toBe("default");
    expect(normalizePetSkinId(42)).toBe("default");
    expect(normalizePetSkinId({ skin: "sakura" })).toBe("default");
  });
});
