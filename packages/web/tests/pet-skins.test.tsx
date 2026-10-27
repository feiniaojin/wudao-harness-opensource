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
import { describe, expect, it, afterEach } from "vitest";
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
const ALL_SKINS = ["default", "sakura", "lake", "honey"] as const;

afterEach(unmount);

describe("ω99-111 pet 皮肤注册表（四肤）", () => {
  it("注册表恰为四肤：default/sakura/lake/honey，每肤 component 可渲染且 states 覆盖七值", () => {
    expect(Object.keys(PET_SKINS).sort()).toEqual([...ALL_SKINS].sort());
    for (const id of ALL_SKINS) {
      const skin = PET_SKINS[id];
      expect(typeof skin.component, `skin=${id}`).toBe("function");
      // 既有钉（ω99-98）四肤同钉：default 必须全覆盖七态 → 每肤都必须。
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
