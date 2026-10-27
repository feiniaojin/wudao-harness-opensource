// ω99-278: #1 — 戳一戳纯层：手势数值与两条纯规则（表情轮选 / 拖拽释放
// 分类）。busy-narration/pet-chat 同款纯模块先例：零 DOM、零 React、零
// 时钟——rand 注入（测试 clock/random-free）。指针层（pet/interaction.ts）消费
// 这里的常量与分类；机器（pet-state.ts）零参与——poke/release 与 drag 同
// 属 UI 事件态家族（pet-state.ts 的 ω99-98 边界注），机器永不感知。

/** 戳一戳判定阈：按住 ≥650ms 未释放即「戳」。> interaction.ts 的 CLICK_MS(600)
 *  ——按到能戳的时长必然已过单击窗，戳与单击天然互斥，无需仲裁延迟（时
 *  间轴设计，不是事后补丁）。 */
export const POKE_HOLD_MS = 650;

/** 表情气泡停留时长（毫秒）——两秒后自行消失。 */
export const POKE_EXPR_MS = 2200;

/** squash 动画时长（毫秒）。CSS `.pet-poke-layer[data-poked]` 的
 *  pet-squash 0.6s 同值——此处供测试对表（源与样式不漂移）。 */
export const POKE_SQUASH_MS = 600;

/** 表情池：萌系短句（对外文案=用户收益纪律，不写实现术语）。 */
export const POKE_EXPRESSIONS: readonly string[] = [
  "呀！", "在呢在呢～", "嘿嘿，别捏啦", "痒痒的！", "元气满满！", "有什么吩咐？",
];

/** 轮选不连击：last 在池内则跳过该位（同一条不连续出现两次）；last 为
 *  null 或池外则全池可选。rand 是 [0,1) 随机源（生产注入 Math.random），
 *  越界值（负/≥1/NaN）收敛到 0（防御注入，生产不触发）。 */
export function pickExpression(last: string | null, rand: () => number): string {
  const n = POKE_EXPRESSIONS.length;
  const skip = last === null ? -1 : POKE_EXPRESSIONS.indexOf(last);
  const eligible = skip >= 0 ? n - 1 : n;
  const raw = rand();
  const r = raw >= 0 && raw < 1 ? raw : 0;
  const k = Math.min(Math.floor(r * eligible), eligible - 1);
  const idx = skip >= 0 && k >= skip ? k + 1 : k;
  const picked = POKE_EXPRESSIONS[idx];
  return picked !== undefined ? picked : POKE_EXPRESSIONS[0] ?? ""; // 池非空常量，缺位分支不可达（noUncheckedIndexedAccess 兜底）
}

/** 位移阈：与 main.tsx 的 CLICK_MOVE_PX(5px) 同值同义（拖动/点击的共用
 *  分界）。本模块不 import main.tsx（入口顶层即挂载，不可进测试图），
 *  在此独立钉死——两侧同改的纪律由 278 源级钉看住。 */
const DRAG_RELEASE_MOVE_PX = 5;

/** 松手分类：非 pointercancel 且位移 ≥ 阈 → 真·拖拽释放（触发回弹）；
 *  阈内（单击候选）/取消/无坐标 → false（不回弹，走旧路：点击判定或直
 *  接放手）。press 形状与 main.tsx 的 press ref 同构（x/y 可缺——合成事
 *  件可能不带坐标）。 */
export function isDragRelease(
  press: { x?: number; y?: number; t: number } | null,
  up: { clientX?: number; clientY?: number; type: string },
): boolean {
  if (press === null || up.type === "pointercancel") return false; // 取消的手势不算任何动作
  if (press.x === undefined || press.y === undefined) return false;
  if (up.clientX === undefined || up.clientY === undefined) return false;
  const dx = up.clientX - press.x;
  const dy = up.clientY - press.y;
  return dx * dx + dy * dy >= DRAG_RELEASE_MOVE_PX * DRAG_RELEASE_MOVE_PX;
}

/** ω99-282: #1 — 搬运中判据：戳计时到点时比对「按下时刻的窗位」与「当下
 *  的窗位」（window.screenX/screenY）。判据来源：拖拽是 tauriStartDrag()
 *  原生窗拖——原生拖窗期指针事件不再投递页面（pointermove 不可靠），但窗
 *  自身坐标随窗移动且在计时回调里同步可读：窗位差是「搬运中」的唯一可靠
 *  位移事实（Tauri decorations:false 无边框窗的自有判据）。阈值与
 *  isDragRelease 的 DRAG_RELEASE_MOVE_PX 同族同值（两侧同改的纪律沿 278
 *  源级钉看住）。pressScreen=null → false（无按下记录不判，保 278 行为）；
 *  任一坐标非有限数（NaN/Infinity）→ false（防御注入，生产不触发）。 */
export function isWindowCarried(
  pressScreen: { x: number; y: number } | null,
  winScreen: { x: number; y: number },
): boolean {
  if (pressScreen === null) return false;
  if (!Number.isFinite(pressScreen.x) || !Number.isFinite(pressScreen.y)) return false;
  if (!Number.isFinite(winScreen.x) || !Number.isFinite(winScreen.y)) return false;
  const dx = winScreen.x - pressScreen.x;
  const dy = winScreen.y - pressScreen.y;
  return dx * dx + dy * dy >= DRAG_RELEASE_MOVE_PX * DRAG_RELEASE_MOVE_PX;
}
