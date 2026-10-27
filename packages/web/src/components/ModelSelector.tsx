// ModelSelector — the composer's 模型 chip (用户反馈 2026-08-28: 模型选择的
// 弹窗太丑,不要用弹窗,应该像强度和模式一样弹出一个类似下拉列表的选择框;
// 同日第二报:下拉按供应商分组,同名模型可挂多供应商;2026-08-31 第三报:模型
// 太多,一级下拉已经超出屏幕 —— 收进两级;同日第四报:两级「钻入」被否 ——
// 选了供应商后供应商不该消失,要像下拉列表的联动一样). EffortSelector's
// dropdown mechanics verbatim: .pop + .menu + .mi/.on, outside pointerdown
// closes (refocus:false), Esc closes and refocuses the chip, every reopen
// starts fresh. The rows ride the status snapshot's /model matrix, grouped
// by provider (first-appearance order — robust to a non-contiguous matrix);
// a model listed under several providers appears once per provider with its
// own lane. Same-provider entries submit /model <name>, cross-provider
// entries submit /provider <name> (M63 §A — the endpoint switch is
// in-session; a new endpoint is a new cache namespace, so the next turn
// re-processes the ENTIRE session history). The right pane's footer
// 设为默认 persists the session's CURRENT model as the boot default
// (model.defaultModel via settingsSet — the R6 quickwin's Ctrl+S lane,
// made visible; the digit-buffer and arrow-key hotkeys retired with the
// modal, the TUI keeps /model <n>).
//
// 联动两栏 (2026-08-31 第四报): the menu is ONE surface, never a drill —
// 左列 .mroot = 供应商(常驻,当前供应商 .on + 模型数徽记),右列 .mpane =
// 联动焦点的模型行。Click AND hover both link the panes(标准的级联联动);
// focus 为 null 时自动跟随当前供应商 —— 打开即见当前家的模型,右栏永不空。
// Esc 一层即关;outside pointerdown 整关;重开重置回自动焦点。两栏各自
// 内滚(max-height 60vh)—— bottom 锚定的菜单条目再多也只滚动,不溢出屏幕。
import { useEffect, useRef, useState } from "react";
import { isSwitchableModel } from "../protocol.js";
import type { RecentModel } from "../recent-models-store.js";

// ω99-218: #2 — 「最近使用」= 左列顶部的虚拟组（伪供应商行）：多供应商
// 用户的高频切模型动作打开即达（goose chat footer recent 的场景），但不破
// 四轮反馈锁定的两栏级联——最近行完全复用既有联动机械（hover/click 联动
// 右栏、onPick(model, provider) 对参数、/model vs /provider 路由、Esc/
// outside 关闭、重开回自动焦点全不动）。矩阵滤层：recent 条目只在当前
// choices 矩阵里仍有同 (provider, model) 行才渲染（供应商被删配置后死
// 端点行不出现）。零喂 = 逐字节旧行为（census model-selector.test.tsx 钉）。
/** The 「最近使用」 virtual group's focus sentinel. NUL-prefixed so it can
 *  never collide with a real provider id (config ids never carry NUL) — the
 *  single `focus` state var carries both lanes unchanged. */
const RECENT_GROUP = "\u0000recent";

export function ModelSelector({
  label,
  provider,
  choices,
  recent,
  disabled = false,
  onPick,
  onPersistDefault,
}: {
  readonly label: string;
  /** The session's current provider — routes each row's lane (/model vs /provider). */
  readonly provider: string | undefined;
  readonly choices: readonly { readonly provider: string; readonly model: string; readonly source: string }[];
  /** ω99-218: recently-used (provider, model) pairs, newest first — the
   *  left column's pinned 「最近使用」 virtual group. Optional + empty-safe:
   *  absent/empty/all-filtered-out = no virtual row (byte-identical old
   *  behavior). */
  readonly recent?: readonly RecentModel[];
  readonly disabled?: boolean;
  readonly onPick: (model: string, provider: string) => void;
  /** The right-pane footer row — persists the session's CURRENT model as the
   *  boot default (the caller owns the settingsSet write; absent = no footer). */
  readonly onPersistDefault?: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  /** 联动焦点 (2026-08-31 第四报): null = 自动 —— 跟随当前供应商(矩阵里
   *  没有它再退到首家),打开/重开都从这里开始;点/悬停左列供应商行即联动
   *  右栏。close 一并复位。 */
  const [focus, setFocus] = useState<string | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);

  /** Closes the menu; on Esc the focused `.mi` unmounts, so focus returns
   *  to the chip instead of falling to <body>. An outside pointerdown
   *  passes `refocus: false` — yanking focus back would steal it from
   *  whatever the user clicked. */
  const close = (refocus = true): void => {
    setOpen(false);
    setFocus(null);
    // #456 reopen: focus() from INSIDE the click task reads as focus-visible
    // to WKWebView (its gesture-task heuristic) — the keyboard ring paints
    // outside the pill after every mouse pick, and the 0.3.83 :not() patch
    // can't reach this branch. Deferring one task past the gesture keeps
    // focus on the trigger without the ring — the same timing the modal
    // family's passive focus effects ride (the in-app discriminator). The
    // body guard keeps the late focus from stealing a target the user
    // already moved on to; Esc keeps its ring (keyboard feedback, correct).
    if (refocus) {
      setTimeout(() => {
        if (document.activeElement === document.body) chipRef.current?.focus();
      }, 0);
    }
  };

  // An outside pointerdown closes without committing.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event): void => {
      if (popRef.current !== null && !popRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  // 供应商分组（用户反馈 2026-08-28 第二报）:首现序 Map —— 矩阵行序不保证
  // 同供应商连续,先见先立组、后见归组。两栏共用这一份分组:左列每组一行
  // (带模型数),右列渲染联动焦点组的模型行。
  const order: string[] = [];
  // (typeof choices is a readonly array — no push. The bucket type is the
  // same shape with a mutable array; readonly FIELDS assign into it fine,
  // only the array itself must be writable.)
  const byProvider = new Map<string, { provider: string; model: string; source: string }[]>();
  for (const c of choices) {
    let rows = byProvider.get(c.provider);
    if (rows === undefined) {
      rows = [];
      byProvider.set(c.provider, rows);
      order.push(c.provider);
    }
    rows.push(c);
  }
  // ω99-218: 矩阵滤层 — a recent pair renders ONLY while its exact
  // (provider, model) row still exists in the choices matrix (a provider
  // whose config was deleted must not leave a dead row); dupes collapse
  // first-wins (the store dedupes on write — this stays defensive).
  const seenRecent = new Set<string>();
  const recentRows: RecentModel[] = [];
  for (const e of recent ?? []) {
    const key = `${e.provider}/${e.model}`;
    if (seenRecent.has(key)) continue;
    if (byProvider.get(e.provider)?.some((c) => c.model === e.model) !== true) continue;
    seenRecent.add(key);
    recentRows.push(e);
  }
  // 联动焦点:null = 自动 —— 当前供应商优先(打开即见自己家的模型),矩阵里
  // 没有当前供应商(如 boot 缺省态)退到首家。choices 为空时右栏根本不渲染。
  const focused =
    focus ?? (provider !== undefined && byProvider.has(provider) ? provider : undefined) ?? order[0];
  const recentFocused = recentRows.length > 0 && focused === RECENT_GROUP;

  return (
    <div
      className="pop"
      ref={popRef}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      }}
    >
      <button
        type="button"
        ref={chipRef}
        className="chip model"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${label} — 切换模型(会话内,下一轮生效;跨供应商行经 /provider 切换端点,缓存全冷)`}
        onClick={() => {
          setFocus(null);
          setOpen(!open);
        }}
      >
        {/* ω99-296 (I1): label 落在专属 flex 项上 —— inline-flex 容器的
            text-overflow 是死代码，省略号必须活在可缩项（.chip-label 三件
            套见 styles.css）；title 带全名，兑现 12rem 帽下不丢读。 */}
        <span className="chip-label">{label}</span>
        <span className="caret" aria-hidden={true}>▾</span>
      </button>
      {open ? (
        <div className="menu model-menu" role="menu" aria-label="切换模型">
          {choices.length === 0 || focused === undefined ? (
            <div className="muted">暂无可切换的模型</div>
          ) : (
            <>
              {/* 左列:供应商行常驻(当前供应商 .on + 模型数徽记;联动焦点行
                  .mfoc)。click 与 hover 都联动 —— 标准级联下拉的行为。 */}
              <div className="mroot" role="group" aria-label="供应商">
                {/* ω99-218: 「最近使用」虚拟组行——左列首位的伪供应商行(增不是
                    改):hover/click 联动右栏 recent 行,机械与供应商行同款。 */}
                {recentRows.length > 0 ? (
                  <button
                    key="recent"
                    type="button"
                    role="menuitemradio"
                    aria-checked={false}
                    className={`mi mprov mrec${recentFocused ? " mfoc" : ""}`}
                    data-recent="true"
                    title="最近使用的模型"
                    onClick={() => {
                      setFocus(RECENT_GROUP);
                    }}
                    onMouseEnter={() => {
                      setFocus(RECENT_GROUP);
                    }}
                  >
                    <span className="mlabel">最近使用</span>
                    <span className="msub">{`${recentRows.length} 个`}</span>
                  </button>
                ) : null}
                {order.map((p) => {
                  const isCurrentProvider = provider !== undefined && p === provider;
                  return (
                    <button
                      key={p}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isCurrentProvider}
                      className={`mi mprov${isCurrentProvider ? " on" : ""}${p === focused ? " mfoc" : ""}`}
                      data-provider={p}
                      title={`选择 ${p} 的模型`}
                      onClick={() => {
                        setFocus(p);
                      }}
                      onMouseEnter={() => {
                        setFocus(p);
                      }}
                    >
                      <span className="mlabel">{p}</span>
                      <span className="msub">{`${byProvider.get(p)!.length} 个模型`}</span>
                    </button>
                  );
                })}
              </div>
              {/* 右列:联动焦点供应商的模型行(组头沿用一级下拉时代的 .mgroup
                  样式 —— 大写/字距/发丝线的契约测试继续钉它),底部带
                  设为默认 footer。ω99-218: 联动到「最近使用」时组头与行换成
                  recent 视图(mlabel=model、msub=provider——最近行没有 env 徽
                  记位,右缘常驻供应商名),路由与 isCurrent 同语义。 */}
              <div className="mpane" role="group" aria-label={recentFocused ? "最近使用的模型" : `${focused} 的模型`}>
                {recentFocused ? (
                  <>
                    <div className="mgroup" data-recent="true">最近使用</div>
                    {recentRows.map((e) => {
                      const cross = !isSwitchableModel(e, provider);
                      const isCurrent = label === e.model && (provider === undefined || provider === e.provider);
                      return (
                        <button
                          key={`${e.provider}/${e.model}`}
                          type="button"
                          role="menuitemradio"
                          aria-checked={isCurrent}
                          className={`mi${isCurrent ? " on" : ""}`}
                          data-model={e.model}
                          data-provider={e.provider}
                          title={cross
                            ? `submit /provider ${e.provider} — 切换端点,历史全量重处理(缓存全冷)`
                            : `submit /model ${e.model}`}
                          onClick={() => {
                            onPick(e.model, e.provider);
                            close();
                          }}
                        >
                          <span className="mlabel">{e.model}</span>
                          <span className="msub">{e.provider}</span>
                        </button>
                      );
                    })}
                  </>
                ) : (
                  <>
                    <div className="mgroup" data-provider={focused}>{focused}</div>
                    {byProvider.get(focused)!.map((c) => {
                      const cross = !isSwitchableModel(c, provider);
                      const isCurrent = label === c.model && (provider === undefined || provider === c.provider);
                      return (
                        <button
                          key={`${c.provider}/${c.model}`}
                          type="button"
                          role="menuitemradio"
                          aria-checked={isCurrent}
                          className={`mi${isCurrent ? " on" : ""}`}
                          data-model={c.model}
                          data-provider={c.provider}
                          title={cross
                            ? `submit /provider ${c.provider} — 切换端点,历史全量重处理(缓存全冷)`
                            : `submit /model ${c.model}`}
                          onClick={() => {
                            onPick(c.model, c.provider);
                            close();
                          }}
                        >
                          <span className="mlabel">{c.model}</span>
                          {c.source === "env" ? <span className="msub">env</span> : null}
                        </button>
                      );
                    })}
                  </>
                )}
                {onPersistDefault !== undefined ? (
                  <>
                    <div className="menu-sep" />
                    <button
                      type="button"
                      role="menuitem"
                      className="mi foot"
                      data-action="persist-default"
                      onClick={() => {
                        onPersistDefault();
                        close();
                      }}
                    >
                      <span className="mlabel">设为默认(下次启动)</span>
                    </button>
                  </>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
