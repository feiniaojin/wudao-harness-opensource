// ω99-151 — the A layer under the IME guard: a pure state machine for
// composition-period keyboard events. 中文产品的组合命门：拼音候选条浮现时，
// IME 拥有键盘——那一刻我们的 Enter=提交/选中/打开、↑/↓=翻选、Esc 语义
// 全部必须让位，否则半成品消息被误发、候选没选完输入框内容被换掉。
// 窄接口（事件只取 isComposing/keyCode 两字段）为此而设：组件传
// e.nativeEvent，测试传普通对象即可确定性驱动。Safari/WKWebView 怪癖：
// 确认组合的那次 Enter 在 compositionend 之后才到且 isComposing=false——
// 只查事件旗标挡不住，靠 endedAt 后的 100ms 窗兜（ProseMirror/GitHub
// 同款启发式）。组件接线见 InputBox.tsx / App.tsx（守卫只吞激活不吞
// 输入：return 不 preventDefault，组合键交还 IME 默认处理）。

/** The mutable ref's shape: composing = 组合进行中；endedAt = 最近一次
 *  compositionend 的 Date.now()（0 = 从未组合过）。 */
export interface ImeGuardState {
  composing: boolean;
  endedAt: number;
}

/** The event seam: a native KeyboardEvent satisfies this structurally
 *  (只读两字段），普通对象在测试里同构。 */
export interface ImeKeyEvent {
  isComposing: boolean;
  keyCode: number;
}

/** compositionstart 的状态转移（不可变：返回新对象，原状态不动）。 */
export const imeStart = (st: ImeGuardState): ImeGuardState =>
  ({ composing: true, endedAt: st.endedAt });

/** compositionend 的状态转移：落下 endedAt 供假 Enter 时间窗判定。 */
export const imeEnd = (st: ImeGuardState, now: number): ImeGuardState =>
  ({ composing: false, endedAt: now });

/** 组合期守卫判定：事件自证（isComposing / keyCode 229——IME 处理中键码
 *  的惯例占位）、状态 composing、或 compositionend 后不足 100ms（Safari
 *  假 Enter 窗）任一为真即吞。 */
export const imeSwallows = (ev: ImeKeyEvent, st: ImeGuardState, now: number): boolean =>
  ev.isComposing || ev.keyCode === 229 || st.composing ||
  (st.endedAt > 0 && now - st.endedAt < 100);
