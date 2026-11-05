// ω99-275: #4 — 皮肤标识的零依赖模块（从 skins/index.ts 拆出）：id 表、
// sheet 路径表、换肤事件名、id 归一规则。拆因：主壳入口（main.tsx 的
// html[data-pet-skin] stamp，喂助手消息头像）与宠物窗只需要这些常量，而原
// 住处 skins/index.ts 会拖进 PetSprite/React——主壳 bundle 不该为四个字符串
// 付出一张精灵组件图。宠物域两入口照旧从 index.js 拿（re-export 兼容，零演
// 进）。「表是唯一事实源」的地位不变（ω99-274 #1 立的规：五个皮肤全由它
// 构造，防字面量漂移）——index.ts 从这里 re-export，单一事实源仍是这一份。
export const PET_SKIN_IDS = ["default", "sakura", "lake", "honey", "power"] as const;

export type PetSkinId = (typeof PET_SKIN_IDS)[number];

/** sheet 路径表（id → 2 帧图 URL）：精灵本尊、宠物聊天头像、主窗助手消息
 *  头像三处共用同一张 sheet，左帧=睁眼（睁眼帧做头像）。
 *  power（2026-11-05 用户令「换肤能切换小精灵或 power 两种展示，直接改变
 *  形象」）：小精灵「长大之后」的成年形态——单姿势形象，sheet 仍是两帧
 *  同图（眨眼翻帧零视觉差，保 2 帧 DOM 契约零特例），帧 1:1（slime 族
 *  390/238），几何覆写在 pet.css 的 [data-skin="power"] 块。资产出自
 *  scripts/make-power-sprite.py（源=assets/power.png）。 */
export const PET_SKIN_SHEETS = {
  default: "/pet/skin-default.png",
  sakura: "/pet/skin-sakura.png",
  lake: "/pet/skin-lake.png",
  honey: "/pet/skin-honey.png",
  power: "/pet/skin-power.png",
} as const satisfies Record<PetSkinId, string>;

/** ω99-111 — Tauri 换肤事件名（Rust 托盘广播 {"skin":"<id>"}；宠物窗与主壳
 *  入口都监听）。与 id 归一同住：两者是一个 wire contract。 */
export const WUDAO_PET_SKIN_EVENT = "wudao-pet-skin";

/** ω99-111 — 两条皮肤 wire 边共享的唯一 id 规则：注册表 id 原样过，其它
 *  任何值（未知串/非串/null…）读 "default"。与 Rust 侧 normalize_pet_skin
 *  镜像（missing/corrupt/unknown pet-skin.json → "default"）。 */
export function normalizePetSkinId(raw: unknown): PetSkinId {
  return typeof raw === "string" && (PET_SKIN_IDS as readonly string[]).includes(raw)
    ? (raw as PetSkinId)
    : "default";
}
