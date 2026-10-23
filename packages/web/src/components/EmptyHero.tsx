// EmptyHero — M63 §D (research 35 #9), restyled M64-visual §3 to the
// mockup's hero: a 52px rounded accent 悟 logo and the plain-language
// welcome. The composer itself is NOT part of this component —
// SimpleMode renders it outside the hero conditional, so the input element
// keeps its identity across the hero→session flip (focus, draft, and
// history-recall state survive).
//
// ω99-167 (user order): the preset chips are GONE — the hero task chips
// (修个 bug / 写个页面 / 解释这段代码) and the factory frequent asks
// (整理下载文件夹/总结会话/写成 Word 文档/做成 Excel 表格) read as
// fake-frequent and vague ("太笼统了，能干啥啊"). In their place the hero
// introduces the buddy in the user's benefits (读文件、写代码、改 bug、
// 查资料…顺手做成文档和表格) — no implementation vocabulary. The input
// box is the single call to action; NO button lives in the hero.
//
import { Fragment } from "react";

// ω99-251: #2 — 欢迎页点名（面三）：boot 后欢迎面对「有 N 个会话在等你
// 授权」点名一行——夜里停在权限问句上的会话，不依赖用户恰好选中也能被
// 发现。行内点名会话标题（App 联表 sessions，缺席兜 id8——标题梯子末层同
// 语义），点名字直达该会话（既有选中通路，App 喂 onOpenSession）。零噪音
// 门（245 健康行同款纪律）：无等待（awaiting 空/缺席/未接线）→ 这一行零
// 渲染，hero 字节同形。文案收益向、逐字钉在
// tests/omega99-251-awaiting-discovery.test.tsx（R3）。
/** One named session the welcome face points at. */
export interface AwaitingSessionName {
  readonly id: string;
  readonly title: string;
}

export function EmptyHero({ awaiting, onOpenSession, onResumeLatest, onAskFromHistory }: {
  /** The sessions waiting on your authorization (optional — absent mounts
   *  render no naming line, byte-identical to the pre-251 hero). */
  awaiting?: readonly AwaitingSessionName[];
  /** The existing selection lane a named session's click rides. */
  onOpenSession?: (id: string) => void;
  /* 小精灵会话弧 — 空态双入口（OPTIONAL——prop 缺席挂载零按钮，字节同形，
   * 251 点名行同款零噪音门；App 只在有历史会话时接线）：「继续上次会话」=
   * 恢复最近一条（既有 resume 通路）；「从历史会话提问」=打开会话选择器，
   * 选中后走追问流（fork 副本继续问，原对话不动）。文案收益向——「副本/
   * fork」是实现词，行内不出现。 */
  onResumeLatest?: () => void;
  onAskFromHistory?: () => void;
} = {}): React.JSX.Element {
  const names = awaiting !== undefined && onOpenSession !== undefined && awaiting.length > 0 ? awaiting : null;
  return (
    <div className="hero">
      <h1>你好呀，我是悟道Harness</h1>
      <p>你的桌面 AI 搭子——读文件、写代码、改 bug、查资料，都能直接在你电脑上替你干完；聊出来的东西也能顺手做成文档和表格。</p>
      <p className="hero-hint">想到什么，直接打字吩咐我就行。</p>
      {onResumeLatest !== undefined || onAskFromHistory !== undefined ? (
        <div className="hero-actions">
          {onResumeLatest !== undefined ? (
            <button type="button" className="hero-act" onClick={onResumeLatest}>
              继续上次会话
            </button>
          ) : null}
          {onAskFromHistory !== undefined ? (
            <button type="button" className="hero-act" onClick={onAskFromHistory}>
              从历史会话提问
            </button>
          ) : null}
        </div>
      ) : null}
      {names !== null ? (
        <p className="hero-await" role="status">
          有 {names.length} 个会话在等你授权：
          {names.map((s, i) => (
            <Fragment key={s.id}>
              {i > 0 ? "、" : ""}
              <button
                type="button"
                className="hero-await-name"
                title={`回到「${s.title}」`}
                onClick={() => onOpenSession?.(s.id)}
              >
                {s.title}
              </button>
            </Fragment>
          ))}
        </p>
      ) : null}
    </div>
  );
}
