// HistoryList — the presentational per-entry renderer, the web mirror of the
// TUI's HistoryItem (cli/src/tui/app.tsx): user echo (first line, in the
// M64-visual §3 accent bubble), assistant markdown (under the 悟道 byline —
// no bubble), ✓/◐/✕ tool cards (fix round 1: the mockup-v2 status glyphs),
// notices, `── divider ──`, errors. Pure functions of the entry — rendered
// once per entry like the TUI's Static column.
//
// M72 §3 — semantic collapse for the ADVANCED tool stream (research 38 §1,
// CC's collapseReadSearch): consecutive OBSERVATION-tool runs (reads,
// greps, globs, web lookups) collapse into a `name ×N` group header, each
// group expandable in place. The transform is view-side only — the history
// array and its immutable entries are never rewritten; errored tools never
// collapse (failures stay loud); write-class tools (edit/write_file/
// shell) always render their own cards. r7 I3: runs of consecutive
// IDENTICAL notice texts fold the same way — a hook that warns once per
// fire reads as one `text ×N` row instead of a row per fire.
import React, { useMemo, useState } from "react";
import type { HistoryEntry } from "../protocol.js";
import { formatDur } from "../protocol.js";
import { Markdown } from "../markdown.js";
import { AssistantReply } from "./AssistantReply.js";
import { ReasoningBlock } from "./LiveArea.js";
import { TodoBoard } from "./TodoBoard.js";
import { AttachmentImages, AttachmentFiles } from "./AttachmentImages.js";
import { ContextMenu, copyToClipboard } from "./ContextMenu.js";
import { TokenSpans } from "./Tokens.js";
import { SEP } from "../theme.js";
import { firstLine } from "../log.js";
import { IconChevronDown, IconChevronRight, IconCheck } from "./icons.js";
import { Icon } from "./Icon.js";
import { classifyNotice } from "../notice-variant.js";
// M76-ux2 §2: the long-output cap + its 展开/收起 toggle — the SAME contract
// the simple activity card renders (one cap module, two shells).
// 0.3.82（0.3.81 凌乱反馈）: the EDIT entry renders the shared
// SimpleActivityCard too — a collapsed 32px 「修改 <path> 查看改动」 row with
// the diff folded inside, instead of a bare always-open DiffView dumped loose
// into the conversation (tools and answers already live in cards; file edits
// now speak the same card language on BOTH faces).
import { CARD_LINE_CAP, EXPAND_LINE_CAP, CapToggle, capLines, SimpleActivityCard } from "./SimpleActivityCard.js";
// statecover B1: the advanced face's error entries reuse the SIMPLE face's
// recovery classifier (one pure table — the tests and both cards share it).
import { recoveryFor } from "./SimpleErrorCard.js";
// ω99-212: the computer tools' system-permission guide (识别层在 cli 的机器
// 标记；本面只渲染——错误工具卡的结果行下内嵌引导)。
import { ComputerPermGuide, computerPermGuideFor } from "./ComputerPermGuide.js";
// ω99-288: #3 — 收据明细的第二个消费面同升：携带 changes 的 notice 展开
// 走 DiffText 分色（Q2 裁定：同一信息两处一套视觉；数据门=结构化 changes
// 在场，非 diff 来源（meta_note 等）零视觉变化——不走分色器，形态照旧）。
import { DiffText } from "./DiffText.js";
// 133 #9 — 长史 resume 渲染水合（尾窗+哨兵 IO+点击兜底）。
import { useHistoryTailWindow, historyHydrateLabel } from "../use-history-hydration.js";

type ToolEntry = Extract<HistoryEntry, { kind: "tool" }>;
type NoticeEntry = Extract<HistoryEntry, { kind: "notice" }>;

export const HistoryItem = React.memo(function HistoryItem({ entry, onAction, onOpenFile, forkN, fork, onForkTurn, running }: {
  entry: HistoryEntry;
  /** statecover B1 — the error entry's recovery lane. When wired (the App
   *  passes its submit seam with a STABLE identity), an actionable recovery
   *  (发送「继续」) renders beside the hint; the hint renders regardless.
   *  The original red line above is never folded or replaced. */
  onAction?: (text: string) => void;
  /** 高亮 spec §2 落点 4: edit 头 / write_file 卡的路径 chip → 文件 tab。 */
  onOpenFile?(path: string): void;
  /** ω99-258: this user row's /edit n (the hover 岔开 action's target — the
   *  driver's editTargets ordering, 1 = most recent); null renders no action
   *  (machinery "[…]" turns are never targets). */
  forkN?: number | null;
  /** ω99-258: the ⑂ badge — this turn entered on a branch (an armed submit
   *  created it); the App keys rows via historyKey. */
  fork?: boolean;
  /** ω99-258: the hover action's seam (arm n for branching — the App's
   *  client.edit door). */
  onForkTurn?(n: number): void;
  /** 0.3.82: the edit entry rides the shared EditCard, which mounts at
   *  tool-call START — without this flag the collapsed row would claim ✓
   * while the write is still in flight. The App passes an IDENTITY-STABLE
   * path set (content-equal frames keep the previous Set identity) so
   * streaming frames re-render nothing unless the running-edit set itself
   * changed. */
  running?: boolean;
}): React.JSX.Element {
  switch (entry.kind) {
    case "user":
      // M64-visual §3: the user echo is a right-aligned accent bubble; the
      // first-line ellipsize (TUI parity) is unchanged. M79b: image-carrying
      // turns render their thumbnails above the bubble (the message slot);
      // a text-less image turn renders the rail alone. ω99-258: a branched
      // turn carries the ⑂ badge at its head, and the hover 「从这里岔开」
      // rides the row head (a branch point needs a user turn).
      return (
        <div className="msg-user">
          {fork === true ? <span className="fork-badge">{"⑂"}</span> : null}
          {forkN != null && onForkTurn !== undefined ? (
            <button type="button" className="fork-act" title="以这轮为起点开一条新线（原文带回输入框，可改后发送）" onClick={() => onForkTurn(forkN)}>
              从这里岔开
            </button>
          ) : null}
          {entry.images !== undefined && entry.images.length > 0 ? <AttachmentImages images={entry.images} /> : null}
          {entry.files !== undefined && entry.files.length > 0 ? <AttachmentFiles files={entry.files} /> : null}
          {entry.text.trim() !== "" ? <div className="bub">{firstLine(entry.text)}</div> : null}
        </div>
      );
    case "assistant":
      // 墨线 §2 → 2026-08-26 spec §3.1（116 弧 B 去框化：卡壳退役、正文
      // 平铺）：署名行在卡外、正文入 .reply-card 容器（AssistantReply，与
      // 直播侧同构）。0.3.8：落定的回复携带本轮
      // 0.3.15（用户需求：LLM 回复耗时展示）：卡尾 dim meta——本回合最后
      // 一次模型调用的实测墙钟；provider 不上报时整行省略（老 server 不变）。
      // v7 γ3（Crush「Hyper 透明度」）：换腿作答的回执行——「本轮由 X
      // （降级）作答」；主模型作答=字段缺席整行省略（零噪音，老 server
      // 不变）。与耗时同款 dim meta 形，不新开视觉语言。
      return (
        <AssistantReply>
          {entry.reasoning !== undefined && entry.reasoning !== "" ? <ReasoningBlock text={entry.reasoning} defaultOpen={true} /> : null}
          <Markdown source={entry.text} />
          {entry.durationMs !== undefined ? <div className="reply-meta">{`· ${formatDur(entry.durationMs)}`}</div> : null}
          {entry.servedBy !== undefined ? <div className="reply-meta" data-served-by={entry.servedBy.model}>{`· 本轮由 ${entry.servedBy.model}（降级）作答`}</div> : null}
        </AssistantReply>
      );
    case "tool":
      // ui-parity B + fix round 1: the advanced tool card rides the mockup
      // `.act` paradigm — a bordered card whose head (the mockup-v2 status
      // glyph ✓/◐/✕, name, params, a right-edge chevron) is a BUTTON that
      // folds the body. The head's text contract is ✓/◐/✕ name(params)
      // (the old ⏺/⏹ inkline marks are retired by the coordinator ruling);
      // the status COLORS ride data-status (ok=--ok / run=--accent /
      // err=--danger, the .act-row language).
      return <ToolCard entry={entry} onOpenFile={onOpenFile} onAction={onAction} />;
    case "edit":
      // 0.3.82: the shared EditCard (collapsed 「修改 <path>」 row, diff folded
      // behind 查看改动) — one card language on both faces. The path chip's
      // onOpenFile contract (高亮 spec §2 落点 4) survives inside the expanded
      // diff body.
      return <SimpleActivityCard entry={entry} running={running === true} onOpenFile={onOpenFile} />;
    case "board":
      // 墨线 T11 (controller 补完): the history surface delegates to the
      // re-shelled TodoBoard — the same data mapping the inline case carried
      // (done/total/lines), one board shell everywhere.
      return <TodoBoard done={entry.done} total={entry.total} lines={entry.lines} />;
    case "notice":
      // 0.3.6 反馈：系统通知从裸灰线升为居中系统气泡（notice-bub）——
      // 与用户右侧重音气泡、助手左侧回复卡、工具 .act 卡同属一套对话
      // 设计语言。0.3.9（用户裁定边界）：胶囊专属 harness 内部状态
      // （与模型上下文无关）；模型可见的注入上下文（card:true）走
      // 回复卡——它是对话内容，不是游离在会话之外的机器文本。
      return entry.card === true ? <InjectedCard entry={entry} /> : <NoticeBubble entry={entry} />;
    case "divider":
      return <div className="entry-divider">{`${SEP}${SEP} ${entry.text} ${SEP}${SEP}`}</div>;
    case "error": {
      // statecover B1 — symmetry with the simple face's SimpleErrorCard: the
      // raw driver text stays WHOLE in the red line (never swallowed or
      // folded); the classifier's hint is APPENDED as a muted row, and the
      // one actionable recovery (继续) rides the caller's submit seam when
      // wired. No new channel — the App hands its existing onSubmit down.
      const recovery = recoveryFor(entry.text);
      return (
        <div className="entry-error-block">
          <div className="entry-error">{entry.text}</div>
          <div className="entry-error-hint">
            <span>{recovery.hint}</span>
            {recovery.action !== undefined && onAction !== undefined ? (
              <button type="button" className="wudao action" onClick={() => onAction(recovery.action?.text ?? "")}>
                {recovery.action.label}
              </button>
            ) : null}
          </div>
        </div>
      );
    }
  }
});

// M72 §1 — memo(HistoryItem): streaming status frames rebuild the history
// ARRAY but keep every ENTRY identity, so the shallow bail skips re-rendering
// all unchanged rows per delta (the LRU covers whatever still renders).

/** 0.3.6 反馈追修（0.3.7）：可展开的系统通知气泡。预览行截断/折叠丢信息
 *  时条目携带全文 detail——胶囊尾部出现展开箭头（ToolCard CapToggle 同款
 *  契约），展开在胶囊下方渲染全文块（viewport-bounded：max-height 内滚，
 *  0.3.1 overlay 惯例）。无 detail 的短通知与 0.3.6 形态完全一致。本地
 *  state——历史条目不可变（ToolResult 同款）。 */
/** 0.3.9（用户裁定）：模型可见的注入上下文（meta_note, card:true）以
 *  回复卡形态呈现——它是对话内容，不是 harness 内部状态；中性署名
 *  「注 · <source>」不冒充悟道（0.3.10：source 标明具体来源，如
 *  「SessionStart 钩子（startup）」「记忆召回」；缺省回退「系统注入」）。
 *  收起态 = 卡内单行预览 + 展开箭头，
 *  展开态 = 全文块（detail 机制照搬胶囊的 220px 内滚）。无 detail 的
 *  短注入是静态行（不可点，无箭头）。 */
function InjectedCard({ entry }: { readonly entry: NoticeEntry }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const hasDetail = entry.detail !== undefined && entry.detail.length > 0;
  const head = (
    <>
      <span className="inject-line">{entry.text}</span>
      {hasDetail ? (
        <span className="inject-chev">{open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}</span>
      ) : null}
    </>
  );
  return (
    <div className="msg-a msg-inject">
      <div className="msg-sig">
        <span className="sig-glyph">注</span>
        <span className="sig-name">{entry.source ?? "系统注入"}</span>
      </div>
      <div className="reply-card">
        {hasDetail ? (
          <button type="button" className="inject-head" aria-expanded={open} aria-label={open ? "收起注入全文" : "展开注入全文"} onClick={() => setOpen(!open)}>
            {head}
          </button>
        ) : (
          <div className="inject-head">{head}</div>
        )}
        {open && hasDetail ? <div className="notice-detail">{entry.detail}</div> : null}
      </div>
    </div>
  );
}

function NoticeBubble({ entry }: { readonly entry: NoticeEntry }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const hasDetail = entry.detail !== undefined && entry.detail.length > 0;
  // ω99-288（续，标记见上）: the diff form's data gate — ONLY a receipt
  // carrying structured changes takes the colored renderer (its detail is
  // the driver's own diff dialect by construction); every other detail
  // (meta_note prose, hook full texts) renders the plain block, zero change.
  const isDiffDetail = entry.changes !== undefined && entry.changes.length > 0;
  // P2 通知变体制（§6.4）：警示/成功/信息前缀在渲染面识别并剥离——语义由变体
  // （色 + 前导 12px 细线字形）承担，位图 emoji 不再上屏。新代码不要写
  // 前缀（见 src/notice-variant.ts）。
  const notice = classifyNotice(entry.text);
  return (
    <div className="entry-notice">
      <span className="notice-bub" data-variant={notice.variant}>
        {notice.variant === "warn" ? <Icon name="triangle-alert" size={12} /> : notice.variant === "ok" ? <IconCheck size={12} className="ic" /> : null}
        {notice.text}
        {hasDetail ? (
          <button type="button" className="notice-exp" aria-expanded={open} aria-label={open ? "收起通知全文" : "展开通知全文"} onClick={() => setOpen(!open)}>
            {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
          </button>
        ) : null}
      </span>
      {open && hasDetail ? (
        isDiffDetail ? (
          <DiffText detail={entry.detail ?? ""} className="notice-detail" />
        ) : (
          <div className="notice-detail">{entry.detail}</div>
        )
      ) : null}
    </div>
  );
}

/** M76-ux2 §2 (spec #16): the toolcard's result line — long output now caps
 *  at 8 lines with the SAME 展开/收起 toggle the simple activity card renders
 *  (展开 raises to 50, 收起 drops back); short results render whole, exactly
 *  as before. Local state per card — the history entries stay immutable. */
function ToolResult({ entry, onAction }: { readonly entry: ToolEntry; onAction?: (text: string) => void }): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const preview = entry.resultPreview ?? "";
  // ω99-212: 错误工具结果带系统权限标记 → 引导卡嵌在结果行下（重试钮走
  // 调用方的提交缝）；普通错误零面变化。
  const permGuide = entry.isError === true && preview !== "" ? computerPermGuideFor(preview) : null;
  const guideEl = permGuide !== null ? <ComputerPermGuide text={preview} onRetry={onAction} /> : null;
  if (preview === "") {
    return entry.isError ? (
      <div className="result err">
        {"  ↳ [error]"}
        {guideEl}
      </div>
    ) : null;
  }
  const { lines, total } = capLines(preview, expanded ? EXPAND_LINE_CAP : CARD_LINE_CAP);
  return (
    <div className={`result${entry.isError ? " err" : ""}`} data-truncated={total > CARD_LINE_CAP}>
      {`  ↳ ${entry.isError ? "[error] " : ""}${lines.join("\n")}`}
      {total > CARD_LINE_CAP || expanded ? (
        <CapToggle total={total} expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
      ) : null}
      {guideEl}
    </div>
  );
}

/** ui-parity B — the advanced tool card's `.act` shell: the bordered card +
 *  clickable head the mockup specifies for the advanced tool stream. The
 *  head keeps the CC text contract (mark + name + (params)) and gains the
 *  status coloring + chevron; clicking it folds/unfolds the body. Local
 *  state only (default OPEN — the historical surface always showed the
 *  result); the 8-line cap + its toggle live in the body below. */
function ToolCard({ entry, onOpenFile, onAction }: { readonly entry: ToolEntry; onOpenFile?(path: string): void; onAction?: (text: string) => void }): React.JSX.Element {
  const [open, setOpen] = useState(true);
  // fix round 2 (review M3): the status rides the entry's COMPLETED state,
  // not the preview's presence — a history tool entry is a committed event
  // (the wire shape carries no in-flight marker; live tools render in
  // LiveArea's run rows), so a completed-but-empty-result entry is ✓ ok,
  // and only isError reads ✕. The ◐ run glyph stays in the map for the
  // typed contract but no history state derives it.
  const status = entry.isError ? "err" : "ok";
  // fix round 1: the mockup-v2 status glyphs (✓ ok / ◐ run / ✕ err) — the
  // old ⏺/⏹ text marks retired with the inkline baseline.
  const MARK: Record<"ok" | "run" | "err", string> = { ok: "✓", run: "◐", err: "✕" };
  return (
    <div className={`toolcard${entry.isError ? " err" : ""}`} data-status={status} data-open={open}>
      <button type="button" className="head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="mark">{`${MARK[status]} `}</span>
        <span className="name">{entry.name}</span>
        {entry.summary ? (
          <span className="args">
            {`(`}
            {TOOL_ARG_LANG[entry.name] !== undefined ? (
              <TokenSpans text={entry.summary} lang={TOOL_ARG_LANG[entry.name]} />
            ) : CHIP_TOOLS.has(entry.name) && onOpenFile !== undefined ? (
              <button
                type="button"
                className="fv-chip"
                title={entry.summary}
                onClick={(e) => { e.stopPropagation(); onOpenFile(entry.summary ?? ""); }}
              >
                {entry.summary}
              </button>
            ) : (
              entry.summary
            )}
            {`)`}
          </span>
        ) : null}
        <span className="chev" aria-hidden={true}>{open ? "▾" : "▸"}</span>
      </button>
      {open ? <ToolResult entry={entry} onAction={onAction} /> : null}
    </div>
  );
}

/** The observation class: read-only lookups whose consecutive runs are safe
 * to summarize as a count — anything with side effects (edit/write_file/
 * shell) or failures (isError) keeps its own card. */
const COLLAPSIBLE_TOOLS: ReadonlySet<string> = new Set(["read_file", "grep", "glob", "web_search", "web_fetch"]);

/** 高亮 spec §2 落点 2: the tool-card arg lines that ARE code, keyed by tool
 *  name (today: shell's summary is the command text). Anything absent
 *  renders plain — a bare path colored per-word is noise. */
export const TOOL_ARG_LANG: Readonly<Record<string, string>> = { shell: "shell" };

/** 高亮 spec §2 落点 4: the tools whose summary IS a workspace path — the
 *  head renders it as a chip opening the file (advanced mode only; the
 *  callback threads down from the App's tab seam, absent → plain text). */
const CHIP_TOOLS: ReadonlySet<string> = new Set(["write_file", "read_file"]);

/** ui-review-r2 P4: a stable per-entry key. WS protocol v1's entries carry
 *  NO id, so the key is a deterministic composite — kind + the position +
 *  the first 8 chars of the entry's most identifying text. A history
 *  REPLACEMENT (clear/resume/reconnect replay) re-derives different keys
 *  for different content, so local row state (an expanded group, a tool
 *  card's 展开) can never attach to the WRONG row the way a bare index key
 *  did. Limitation (noted, accepted): two identical-kind entries with the
 *  same 8-char head at the same position across a replacement keep the
 *  state — harmless, they are visually identical anyway. */
export function historyKey(entry: HistoryEntry, i: number): string {
  const head = (
    entry.kind === "tool" ? `${entry.name}:${entry.summary}` :
    entry.kind === "edit" ? entry.path :
    entry.kind === "board" ? `${entry.done}/${entry.total}` :
    "text" in entry ? entry.text :
    ""
  ).slice(0, 8);
  return `${entry.kind}#${i}#${head}`;
}

function collapsible(entry: HistoryEntry): entry is ToolEntry {
  return entry.kind === "tool" && entry.isError !== true && COLLAPSIBLE_TOOLS.has(entry.name);
}

/** ω99-258: the hovered user row's /edit n — the driver's editTargets
 *  ordering mirrored view-side (1 = the most recent user turn; the driver
 *  counts user messages of the ACTIVE chain and excludes machinery content
 *  by the leading "["). The rendered user rows are exactly those messages
 *  (resumeEntries drops the marker families; the live echo carries the same
 *  text), so counting rendered user rows from the hovered one to the end
 *  yields the driver's n. Returns null for non-user rows and machinery
 *  turns — they are never edit targets, the hover action does not offer. */
// ω99-258: #9 — 面三（用户轮 hover 岔开 + 岔轮徽标）。
export function editTargetAt(history: readonly HistoryEntry[], index: number): number | null {
  const entry = history[index];
  if (entry === undefined || entry.kind !== "user" || entry.text.startsWith("[")) return null;
  let n = 0;
  for (let i = index; i < history.length; i += 1) {
    const e = history[i];
    if (e !== undefined && e.kind === "user" && !e.text.startsWith("[")) n += 1;
  }
  return n;
}

export type HistoryRow =
  | { readonly kind: "entry"; readonly entry: HistoryEntry }
  | { readonly kind: "toolgroup"; readonly name: string; readonly entries: readonly ToolEntry[] }
  | { readonly kind: "noticegroup"; readonly text: string; readonly entries: readonly NoticeEntry[] };

/** M72 §3 — the O(n) transform: maximal runs (≥2) of consecutive
 * collapsible same-name tools become one group row; everything else passes
 * through in order. r7 I3: runs (≥2) of consecutive IDENTICAL notice texts
 * fold the same way — a hook that warns once per fire (the driver's
 * hookWarnSink appends one notice each) no longer spams a row per fire; a
 * differing text breaks the run, so interleaved distinct notices each keep
 * their own row. Pure — tests pin the exact row shapes. */
export function groupToolRuns(history: readonly HistoryEntry[]): HistoryRow[] {
  const rows: HistoryRow[] = [];
  let i = 0;
  while (i < history.length) {
    const entry = history[i] as HistoryEntry;
    if (collapsible(entry)) {
      let j = i + 1;
      while (j < history.length) {
        const next = history[j] as HistoryEntry;
        if (!(next.kind === "tool" && next.isError !== true && next.name === entry.name)) break;
        j++;
      }
      const run = history.slice(i, j) as ToolEntry[];
      rows.push(run.length >= 2 ? { kind: "toolgroup", name: entry.name, entries: run } : { kind: "entry", entry });
      i = j;
    } else if (entry.kind === "notice" && entry.card !== true) {
      let j = i + 1;
      while (j < history.length) {
        const next = history[j] as HistoryEntry;
        if (!(next.kind === "notice" && next.card !== true && next.text === entry.text)) break;
        j++;
      }
      const run = history.slice(i, j) as NoticeEntry[];
      rows.push(run.length >= 2 ? { kind: "noticegroup", text: entry.text, entries: run } : { kind: "entry", entry });
      i = j;
    } else {
      rows.push({ kind: "entry", entry });
      i++;
    }
  }
  return rows;
}

/** M72 §3 — the collapsed group: a `✓ name ×N` header (the toolcard visual
 * language) whose click toggles the run's own cards in place. Local state +
 * a data-open class hook only — no data-flow change. */
function ToolGroup({ name, entries, onOpenFile }: { readonly name: string; readonly entries: readonly ToolEntry[]; onOpenFile?(path: string): void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="toolgroup" data-open={open}>
      <button type="button" className="grp-head act-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="mark">{"✓ "}</span>
        <span className="name">{name}</span>
        <span className="count act-tail">{` ×${entries.length}`}</span>
        {/* inkline T3 (spec §1.5): the ▾/▸ affordance was an icon slot —
            the chevron pair rides the shared 1.5-stroke SVG set now. T5:
            the row/chrome class names are the activity card's (.act-row/
            .act-tail/.act-chev) — the two modes share one row language. */}
        <span className="exp act-chev">{open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}</span>
      </button>
      {open ? entries.map((entry, i) => <HistoryItem key={historyKey(entry, i)} entry={entry} onOpenFile={onOpenFile} />) : null}
    </div>
  );
}

/** r7 I3 — the folded notice run: the same expand/collapse contract the
 *  toolgroup renders, over the notice's own warn-toned line — the repeated
 *  text once with ` ×N`, click mounts each fire's own row. The history
 *  entries stay immutable (view-side fold only). */
function NoticeGroup({ text, entries }: { readonly text: string; readonly entries: readonly NoticeEntry[] }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  // P2 通知变体制（§6.4）：折叠头同单条通知——前缀剥离 + 变体色（warn 族
  // 折叠串在头行就带警示语气，不必展开逐条看）。
  const notice = classifyNotice(text);
  return (
    <div className="noticegroup" data-open={open}>
      <button type="button" className="grp-head" data-variant={notice.variant} aria-expanded={open} onClick={() => setOpen(!open)}>
        {notice.variant === "warn" ? <Icon name="triangle-alert" size={12} /> : notice.variant === "ok" ? <IconCheck size={12} className="ic" /> : null}
        <span className="text">{notice.text}</span>
        <span className="count">{` ×${entries.length}`}</span>
        <span className="exp">{open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}</span>
      </button>
      {open ? entries.map((entry, i) => <HistoryItem key={historyKey(entry, i)} entry={entry} />) : null}
    </div>
  );
}

export const HistoryList = React.memo(function HistoryList({ history, onAction, onOpenFile, onForkTurn, forkBadgeKeys, runningEditPaths }: {
  history: readonly HistoryEntry[];
  /** statecover B1 — threaded to the ERROR entries' recovery button (the
   *  App's stable submit seam); see HistoryItem.onAction. */
  onAction?: (text: string) => void;
  /** 高亮 spec §2 落点 4: edit 头 / write_file 卡的路径 chip → 文件 tab。 */
  onOpenFile?(path: string): void;
  /** ω99-258: the user rows' hover 「从这里岔开」 seam — armed with the row's
   *  /edit n (editTargetAt). Stable identity keeps the memoized rows bailing
   *  on streaming frames (the onErrorAction idiom). */
  onForkTurn?(n: number): void;
  /** ω99-258: historyKeys of branch-entered turns (the ⑂ badge source) — a
   *  PROP (not a ref-reading predicate) so a new badge re-renders this list:
   *  this component is memoized, and a stable-callback prop alone would bail
   *  on exactly the update that must render. */
  forkBadgeKeys?: ReadonlySet<string>;
  /** 0.3.82: the edit rows' in-flight paths (the shared EditCard's ◐/✓
   *  source). The App hands an IDENTITY-STABLE Set — content-equal streaming
   *  frames keep the previous Set identity, so this memoized list re-renders
   *  only when the running-edit set itself changed (the forkBadgeKeys
   *  idiom). */
  runningEditPaths?: ReadonlySet<string>;
}): React.JSX.Element {
  // M72 §3 (research 38 §1, CC's transform/render split): the grouping is an
  // O(n) transform memoized on the history identity (App memoizes the concat
  // it passes down), kept APART from the render map — a streaming status
  // frame that changes no history re-renders zero rows instead of rebuilding
  // the pipeline per delta.
  const rows = useMemo(() => groupToolRuns(history), [history]);
  // ω99-258: grouped rows consume ≥1 history entries each — the user rows'
  // editTargetAt needs the HISTORY index, so carry a per-row offset (computed
  // on the rows identity, zero extra passes on streaming frames).
  const rowOffsets = useMemo(() => {
    const out: number[] = [];
    let n = 0;
    for (const r of rows) {
      out.push(n);
      n += r.kind === "entry" ? 1 : r.entries.length;
    }
    return out;
  }, [rows]);
  // 133 #9（deepagents 8ea734a80 形）— 长史 resume 只挂尾窗，向上滚/点击
  // 哨兵补水合。窗口的单元=分组后的 row（一组折叠工具算一行）。
  const tail = useHistoryTailWindow(rows.length);
  const tailStart = tail.hidden;
  // M76-ux2 §6: the chat message's right-click menu — user/assistant rows
  // copy their full text (tool/notice/board rows open nothing). One menu at
  // a time, at the pointer.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; text: string } | null>(null);
  const copyableText = (row: HistoryRow): string | null => {
    if (row.kind !== "entry") return null;
    return row.entry.kind === "user" || row.entry.kind === "assistant" ? row.entry.text : null;
  };
  return (
    <>
      {tailStart > 0 ? (
        <div
          ref={tail.sentinelRef}
          className="history-hydrate-sentinel"
          onClick={tail.hydrate}
          role="button"
          tabIndex={0}
          onKeyDown={(ev) => {
            if (ev.key === "Enter" || ev.key === " ") tail.hydrate();
          }}
        >
          {historyHydrateLabel(tailStart)}
        </div>
      ) : null}
      {rows.slice(tailStart).map((row, vi) => {
        const i = tailStart + vi; // 全量索引——键/偏移用全局位（切片不改变键稳定性）
        const text = copyableText(row);
        // P4: stable composite keys (see historyKey) — an index key let a
        // history replacement inherit the previous rows' expand state.
        const key =
          row.kind === "entry" ? historyKey(row.entry, i)
          : row.kind === "toolgroup" ? `grp#${row.name}#${i}#${row.entries.length}`
          : `ngrp#${row.text.slice(0, 8)}#${i}#${row.entries.length}`;
        return (
          <React.Fragment key={key}>
            {vi > 0 ? <div className="entry-gap" /> : null}
            <div
              className="entry"
              onContextMenu={text === null ? undefined : (ev) => {
                ev.preventDefault(); // the native menu stays hidden
                setCtxMenu({ x: ev.clientX, y: ev.clientY, text });
              }}
            >
              {row.kind === "toolgroup"
                ? <ToolGroup name={row.name} entries={row.entries} onOpenFile={onOpenFile} />
                : row.kind === "noticegroup"
                  ? <NoticeGroup text={row.text} entries={row.entries} />
                  : <HistoryItem
                      entry={row.entry}
                      onAction={onAction}
                      onOpenFile={onOpenFile}
                      /* ω99-258: the fork face rides plain entry rows only — a
                       * group is tool/notice traffic, never a user turn. */
                      forkN={onForkTurn !== undefined && row.entry.kind === "user" ? editTargetAt(history, rowOffsets[i] ?? i) : null}
                      fork={
                        forkBadgeKeys !== undefined && row.entry.kind === "user"
                          ? forkBadgeKeys.has(historyKey(row.entry, rowOffsets[i] ?? i))
                          : undefined
                      }
                      onForkTurn={onForkTurn}
                      /* 0.3.82: only the EDIT rows carry the running flag
                       *  (the shared EditCard's ◐/✓) — other rows render
                       *  undefined and bail as before. */
                      running={runningEditPaths !== undefined && row.entry.kind === "edit" ? runningEditPaths.has(row.entry.path) : undefined}
                    />}
            </div>
          </React.Fragment>
        );
      })}
      {ctxMenu !== null ? (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={[{ label: "复制文本", onSelect: () => copyToClipboard(ctxMenu.text) }]}
          onClose={() => setCtxMenu(null)}
        />
      ) : null}
    </>
  );
});

// Kept for the board test's direct import parity with the TUI's export.
export { TodoBoard };
