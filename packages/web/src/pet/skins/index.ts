// ω99-98 — the skin seam: PET_SKINS maps a skin id to its renderer plus the
// display states it declares. A skin is a pure component of the display
// state; swapping one swaps the figure (and its own CSS) without touching
// the machine (pet-state.ts), the entry (pet/main.tsx), or the tests'
// [data-pet-root] contract. ω99-111 fills the registry with four hue
// variants of the SAME logo slime (default/sakura/lake/honey — sheets from
// scripts/make-logo-sprite.py) plus the grown form power (力量形态——
// figure swap, sheet from scripts/make-power-sprite.py), plus the id
// normalization both wire edges
// (get_pet_skin command + wudao-pet-skin event) funnel through.
// ω99-275: #5 — 标识层（id 表 / sheet 路径表 / 换肤事件名 / id 归一）拆到
// 零依赖的 ./skin-ids.ts：主壳入口（main.tsx stamp html[data-pet-skin]）
// 需要这些名字，但不能把 PetSprite/React 拖进主壳 bundle。本文件 re-export
// 全套——既有导入面（Bubble 的 PET_SKIN_SHEETS、pet/main.tsx 与 pet-skins
// 测试的几名）零演进；registry 的 PetSkinId 也改自 skin-ids 导入（先有 id
// 表后有 registry，Record<PetSkinId,…> 从此是诚实的约束）。
import type { ComponentType } from "react";
import { sheetSkin } from "../PetSprite.js";
import { PET_SKIN_SHEETS } from "../skin-ids.js";
import type { PetDisplayState } from "../pet-state.js";
import type { PetSkinId } from "../skin-ids.js";

export { PET_SKIN_IDS, PET_SKIN_SHEETS, WUDAO_PET_SKIN_EVENT, normalizePetSkinId } from "../skin-ids.js";
export type { PetSkinId } from "../skin-ids.js";

/** What a skin renderer receives — the display state, nothing else. */
export interface PetSkinProps {
  display: PetDisplayState;
}

export interface PetSkin {
  /** The figure renderer (div + CSS by convention; no animation libs). */
  readonly component: ComponentType<PetSkinProps>;
  /** The display states this skin declares support for. EVERY skin must
   *  cover ALL SEVEN values (pinned by tests/pet-skins.test.tsx — the
   *  ω99-98 "default covers all seven" pin, extended to all four). */
  readonly states: readonly PetDisplayState[];
}

/** All seven display states — the coverage every sheet skin declares. */
const ALL_STATES: readonly PetDisplayState[] = [
  "idle",
  "thinking",
  "working",
  "answering",
  "waiting-user",
  "done",
  "drag",
];

// The three variants are the same factory output as the default skin, one
// sheet each — the hue variant lives in the ASSET (make-logo-sprite.py),
// not in markup, so every skin shares one DOM contract.
const SakuraPetSkin = sheetSkin(PET_SKIN_SHEETS.sakura);
const LakePetSkin = sheetSkin(PET_SKIN_SHEETS.lake);
const HoneyPetSkin = sheetSkin(PET_SKIN_SHEETS.honey);
// power = the grown form (成年形态)：a DIFFERENT figure, same factory — the
// 形象 swap is still just a sheet url, the DOM contract holds for it too.
const PowerPetSkin = sheetSkin(PET_SKIN_SHEETS.power);

export const PET_SKINS = {
  default: { component: sheetSkin(PET_SKIN_SHEETS.default), states: ALL_STATES },
  sakura: { component: SakuraPetSkin, states: ALL_STATES },
  lake: { component: LakePetSkin, states: ALL_STATES },
  honey: { component: HoneyPetSkin, states: ALL_STATES },
  power: { component: PowerPetSkin, states: ALL_STATES },
} as const satisfies Record<PetSkinId, PetSkin>;
