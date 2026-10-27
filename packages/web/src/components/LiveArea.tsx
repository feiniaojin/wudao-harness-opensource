// LiveArea — the streaming surface under the history, the web mirror of the
// TUI's LiveArea + the M43-B reasoning-collapse upgrade: live reasoning is a
// <details> whose summary always shows the head-of-thought (last line), so
// long thoughts collapse by default and expand on click while still
// streaming. 2026-08-26 spec §3.2: the answer streams MARKDOWN inside the
// same AssistantReply card the history commits (StreamingMarkdown — a web
// deviation from the TUI's plain-text live answer), riding BELOW the panel
// as the turn's conclusion; the steering queue shows its ⏳ lines.
//
// 墨线 T10 (spec §5): the tool flow is a TIMELINE PANEL, not loose lines —
// .panel > .panel-head(.panel-title 工具流 + .panel-count `N 项`) +
// .panel-list, the busy tools riding the SAME Task-5 .act/.act-row contract
// the history cards use (verb + mono file + status glyph). Rows are
// hairline-separated by the list's adjacent-sibling rule (Linear issue-list
// language, 非卡片堆): the .act card chrome yields to the list seams via one
// scoped strip in styles.css, never a forked copy.
//
// 墨线 T11 (T5 寄存项, controller r1): the braille .spin surface is now
// IconSpinner — the same static-arc-plus-.spin-rotation idiom the history
// cards use (SimpleActivityCard), so both surfaces share one spinner.
import React from "react";
import type { LiveBusyTool, LiveState } from "../protocol.js";
import { firstLine, truncate } from "../log.js";
import { StreamingMarkdown } from "../markdown.js";
import { activityKindOf, activityVerbOf } from "./SimpleActivityCard.js";
import { AssistantReply } from "./AssistantReply.js";
import { IconSpinner } from "./icons.js";
import { Icon } from "./Icon.js";

export function Spinner(): React.JSX.Element {
  return <IconSpinner size={13} className="spin" />;
}

export function ReasoningBlock({ text, streaming = false, defaultOpen = false }: { text: string; streaming?: boolean; readonly defaultOpen?: boolean }): React.JSX.Element {
  // 0.3.8（用户反馈：think 过程要展示）：思考中自动展开、正文一开始自动
  // 收起——用户点过 summary 后以用户为准，程序不再插手。正文增长时块内
  // tail-follow（近底 40px 才粘底，骑上去看前文就松手——与 use-jump-bottom
  // 同语义）。
  const detailsRef = React.useRef<HTMLDetailsElement>(null);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const [userToggled, setUserToggled] = React.useState(false);
  // 产品原则（10-27 用户令）：LLM 返回的任何内容都要展示。流式思考自动
  // 展开；历史回放（streaming 恒 false）经 defaultOpen 也默认展开——折叠
  // 态只属于用户主动收起（userToggled 之后尊重选择）。
  React.useEffect(() => {
    if (userToggled || detailsRef.current === null) return;
    detailsRef.current.open = streaming ? true : defaultOpen;
  }, [streaming, defaultOpen, userToggled]);
  React.useEffect(() => {
    const el = bodyRef.current;
    if (el !== null && el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
      el.scrollTop = el.scrollHeight;
    }
  }, [text]);
  return (
    <details className="reasoning" data-streaming={streaming} ref={detailsRef}>
      <summary onClick={() => setUserToggled(true)}>
        {/* 0.3.81 精修: 流式摘要去掉 ▌ 伪光标——真光标只属于正在打字的回答
            （.live-answer .caret，会闪）；思考阶段的动效信号已由状态行/状态栏
            承担，这里再放一个不闪的 ▌ 是第二根"假指针"。 */}
        {streaming ? "思考中" : `思考过程 · ${text.length} 字`}
      </summary>
      <div className="body" ref={bodyRef}>{text}</div>
    </details>
  );
}

/** One in-flight tool as a timeline row — the Task-5 row contract with the
 *  card chrome left to the list: .act root carries data-kind/data-status
 *  ("run" — there is no result yet), the row itself is NOT a button (a busy
 *  tool has no body to expand; the scoped cursor pin says so), and the
 *  sidecar check rides the right-edge tail in the warn tone.
 *
 *  UI-3 C1: exported so the 简洁面 rides the SAME row (one contract, two
 *  surfaces — the advanced timeline strips the card chrome via .panel-list,
 *  the simple turnlive keeps it; both pin the cursor off the row).
 *  借鉴弧 δ (penguin 367ab084): the row's ONE action — 转入后台 (the α2
 *  recall button's idiom on the busy face). Rendered only when the row
 *  carries a callId AND the surface wired a handler (old servers/rows
 *  without callId stay byte-identical); a typed refusal surfaces as a
 *  notice, never a silent no-op. */
export function BusyToolRow({ tool, onDetach }: { readonly tool: LiveBusyTool; readonly onDetach?: (callId: string) => void }): React.JSX.Element {
  const kind = activityKindOf(tool.name);
  // ω99-63: the streaming call's live tail renders as ONE dim line under the
  // row — the LAST non-empty line (the most recent output), truncated. No
  // tail → no line: pre-ω99-63 rows stay byte-identical.
  // 品牌弧补丁（用户令「看不到执行过程」）：尾行 1 行→最近 3 行——
  // shell 流式输出/读文件进度等多行执行过程可见，不只是最后一行。
  const tailLines = tool.tail === undefined
    ? []
    : tool.tail.split("\n").filter((l) => l.trim() !== "").slice(-3);
  return (
    <div className="act" data-kind={kind} data-status="run">
      <div className="act-row" data-status="run">
        <span className="act-st st-run" aria-hidden={true}>
          <Spinner />
        </span>
        <span className="sr-only">进行中</span>
        <span className="act-verb">{activityVerbOf(tool.name)}</span>
        {/* 品牌弧补丁（用户令「根本不知道什么工具在执行」）：摘要空时回退显示
            工具名——行面永远可识别（审计可读性；summarize 默认空串族不再裸动词）。 */}
        <span className="act-file">{tool.summary !== "" ? tool.summary : tool.name}</span>
        {/* ω99-160: gating 尾中文化——盾牌 emoji 承载安全语义，文字只需状态词；结构零动。 */}
        {tool.gating ? (
          <span className="act-tail gating">
            <Icon name="shield" size={11} /> 检查中
          </span>
        ) : null}
        {onDetach !== undefined && tool.callId !== undefined ? (
          <button type="button" className="detach" aria-label="把这个工具调用转入后台" title="不再等待——调用转后台继续跑，完成后自动并入对话" onClick={() => onDetach(tool.callId as string)}>转入后台</button>
        ) : null}
      </div>
      {tailLines.length > 0 ? <div className="act-tail-line">{tailLines.join("\n")}</div> : null}
    </div>
  );
}

/** UI-3 C4 + 2026-08-26 §3.2: the streaming answer with its typing cursor —
 *  ONE component for both faces (the advanced surface and the simple
 *  turnlive), so the card + ▌ land identically wherever an answer streams.
 *  The text renders through StreamingMarkdown inside AssistantReply — the
 *  SAME card the history commits when the turn closes, so the live→final
 *  swap changes nothing visually. The cursor is aria-hidden: it decorates
 *  "still typing", it never reads as content. */
export function LiveAnswer({ text }: { readonly text: string }): React.JSX.Element {
  return (
    <div className="live-answer">
      <AssistantReply>
        <StreamingMarkdown source={text} />
        <span className="caret" aria-hidden={true}>▌</span>
      </AssistantReply>
    </div>
  );
}

export function LiveArea({ live, queued, onRecall, onDetachTool }: { live: LiveState; queued: readonly string[]; onRecall?: (index: number, text: string) => void; onDetachTool?: (callId: string) => void }): React.JSX.Element {
  // The panel counts the TOOL events (the busyTools list) — reasoning,
  // answer, and the steering queue ride the same timeline but are not tools.
  const events = live.busyTools;
  // #451（0.3.81 用户反馈：凌乱感）: the panel renders ONLY when it has
  // content — a pure-thinking or pure-answering turn (no tools, no reasoning
  // block, nothing queued) must not show a ghost 「工具流 0 项」box: the
  // reasoning block and the streaming answer carry those phases alone.
  const hasContent = events.length > 0 || live.reasoning !== "" || queued.length > 0;
  return (
    <>
      {hasContent ? (
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">工具流</span>
          {/* ω99-160: 计数词中文化——与同行中文标题「工具流」一致；结构零动。 */}
          <span className="panel-count">{`${events.length} 项`}</span>
        </div>
        <div className="panel-list">
          {live.reasoning !== "" ? <ReasoningBlock text={live.reasoning} streaming={live.thinking ?? false} /> : null}
          {events.map((t, i) => (
            <BusyToolRow key={`${t.name}:${t.summary}:${i}`} tool={t} onDetach={onDetachTool} />
          ))}
          {queued.map((t, i) => (
            // ω99-160: steering 行中文化——前缀逐字节镜像 SimpleTurnStatus.tsx:95
            // （半角冒号无空格），两副词表统一为一副；保留本面自己的截宽 60。
            // 借鉴弧 α2: the ↩ recall button rides the line — the parked-chip
            // drop idiom (SimpleComposer) on the SERVER-side queue; CAS guards
            // the race (a consumed entry answers false and the line is gone
            // with the next frame anyway).
            <div key={i} className="steer">
              {/* 116 弧 C：⏳ 前缀换 hourglass 细线字形——与 SimpleTurnStatus
                  的镜像律不变（两副同换）。 */}
              <Icon name="hourglass" size={11} />
              {` 将在下一步前注入:${truncate(firstLine(t), 60)}`}
              {onRecall !== undefined ? (
                <button type="button" className="recall" aria-label="撤回这条排队消息" title="趁还没被读取，撤回这条" onClick={() => onRecall(i, t)}>↩ 撤回</button>
              ) : null}
            </div>
          ))}
        </div>
      </div>
      ) : null}
      {/* 2026-08-26 §3.2: the answer is the turn's CONCLUSION — it rides
          below the timeline panel in the same card the history will commit
          (the .panel-list keeps tools/reasoning/steering only). */}
      {live.answer !== "" ? <LiveAnswer text={live.answer} /> : null}
    </>
  );
}
