// SimpleActivityCard — M63 §D (research 35 #2/#8), restyled M64-visual §3 to
// the mockup's .act card, then 墨线 (spec §2) to the 32px collapsed row:
// every tool call renders as ONE .act-row line (status glyph + verb + mono
// file + right-edge tail + rotating chevron); expanding opens the typed
// .act-body capped at 8 lines (read / search / web bodies slice to the cap;
// the diff body FOLDS to the balanced two-sign preview — #455: computeDiff
// emits all `-` rows before the first `+`, so a window inside the del block
// read as "only deletions"; the preview keeps each side's head with honest
// 再 −N/+N markers, and 展开 raises to the full hunk).
// An errored tool's FIRST LINE is the collapsed tail, in the error color
// (data-status="err" drives it), and the whole card takes the .act.err
// danger border — a failure is visible without expanding anything. Unknown
// tools fall back to the IN/OUT two-block body. The `edit` history entry
// (the driver pushes it at tool-call START, so the diff is visible before
// the write lands) renders as the diff card.
// UI-5 C7-A: that START-pushed diff card no longer hard-codes ✓ — it rides
// the running predicate (isEditRunning) so a write still in flight reads ◐
// (the mockup P1 signature card); the flip to ✓ lands when the busyTools
// entry leaves the live state. The tool card's status derivation drops the
// old preview-presence heuristic (a completed-but-empty result spun ◐
// forever) for the HistoryList M3 rule — isError alone decides err.
import { useState } from "react";
import type { HistoryEntry, LiveBusyTool } from "../protocol.js";
import { firstLine } from "../log.js";
import { balancedDiffRows, collapseContext, computeDiff } from "../diff.js";
import { DiffView } from "./DiffView.js";
import { IconCheck, IconSpinner, IconChevronDown } from "./icons.js";
import { Icon, type IconName } from "./Icon.js";
import { tauriInvokeCommand } from "../tauri-invoke.js";

/** The typed-card families (the edit entry adds "diff"; the driver never
 *  emits an `edit`-named TOOL entry, so the tool table has no diff row). */
export type ToolActivityKind = "read" | "search" | "web" | "inout";

export function activityKindOf(toolName: string): ToolActivityKind {
  const n = toolName.toLowerCase();
  if (n === "read_file") return "read";
  if (n === "grep" || n === "glob") return "search";
  if (n === "web_search" || n === "web_fetch") return "web";
  return "inout";
}

/** The collapsed head's verb (mockup §3: 读取 / 搜索 / …, not the raw tool
 *  name — the novice reads Chinese, not the RPC table). */
const KIND_VERB: Record<ToolActivityKind, string> = { read: "读取", search: "搜索", web: "联网", inout: "执行" };

/** 墨线 T10: the verb for any tool NAME — the SAME table the cards read, so
 *  LiveArea's timeline rows speak the history's vocabulary (one source, no
 *  forked copy). */
export const activityVerbOf = (toolName: string): string => KIND_VERB[activityKindOf(toolName)];

/** The hard card cap (research 35 #2: 8 行硬上限). */
export const CARD_LINE_CAP = 8;

/** M76-ux2 §2 (spec #16): the EXPANDED cap — one 展开 gesture raises the
 *  ceiling from 8 to 50 lines (收起 drops back); anything longer scrolls
 *  inside the raised body. */
export const EXPAND_LINE_CAP = 50;

/** Split to the cap; `total` carries the honest pre-cap line count. */
export function capLines(text: string, cap = CARD_LINE_CAP): { readonly lines: readonly string[]; readonly total: number } {
  const all = text.split("\n");
  return { lines: all.slice(0, cap), total: all.length };
}

/** The max-height of a card body: 8 lines of 12px/1.6 (mockup §3: 132px). The
 *  inline style (not a class) keeps the cap assertable from jsdom. */
const BODY_MAX_HEIGHT = "132px";

/** M76-ux2 §2: the RAISED ceiling — 50 lines of the same 12px/1.6. */
const EXPANDED_BODY_MAX_HEIGHT = "960px";

/** M76-ux2 §2 (spec #16): the truncation footer is now a TOGGLE — truncated
 *  shows 「展开 ▾ (N 行)」 with the honest total, one click raises the cap to
 *  EXPAND_LINE_CAP; expanded shows 「收起 ▴」 and drops back to 8. Shared by
 *  the simple activity card AND the advanced toolcard (HistoryList). */
export function CapToggle({ total, expanded, onToggle }: {
  total: number;
  expanded: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <button type="button" className="activity-toggle" aria-expanded={expanded} onClick={onToggle}>
      {expanded ? "收起 ▴" : `展开 ▾ (${total} 行)`}
    </button>
  );
}

/** The row's status: done, still-running (no result yet), errored. ok/run
 *  ride the shared 1.5-stroke SVG glyphs (IconCheck / IconSpinner — the arc
 *  is static, the .spin class rotates it); err keeps the ✕ TEXT glyph (the
 *  brief's deliberate content mark). The COLOR rides data-status on the row;
 *  the WORD rides a .sr-only span — the glyph alone is invisible to
 *  assistive tech. */
type ActStatus = "ok" | "run" | "err";
const STATUS_TEXT: Record<ActStatus, string> = { ok: "完成", run: "进行中", err: "出错" };

type ToolEntry = Extract<HistoryEntry, { kind: "tool" }>;
type EditEntry = Extract<HistoryEntry, { kind: "edit" }>;

/** UI-5 C7-A: is this edit entry's write still in flight? The busyTools row
 *  and the edit history entry both derive from the SAME tool_call_started
 *  event's `input.path` — the busy row's summary is literally the path string
 *  (cli summarizeToolCall's edit/write_file branch) and the entry's path is
 *  `str(ev.input.path)` — so `name + summary === path` is an exact key, no
 *  call id needed. `write_file` MUST be in the match set: an overwrite also
 *  lands an edit entry (the driver diffs it against the on-disk content), so
 *  excluding it would leave the overwrite card lying ✓ while it writes. */
export function isEditRunning(entry: EditEntry, busyTools: readonly LiveBusyTool[]): boolean {
  return busyTools.some((t) => (t.name === "edit" || t.name === "write_file") && t.summary === entry.path);
}

export function SimpleActivityCard({ entry, running = false, onOpenFile }: {
  entry: ToolEntry | EditEntry;
  /** UI-5 C7-A: the write this entry describes is still in flight (the
   *  caller derives it via isEditRunning). Default false keeps every
   *  card-level test (and any list without live state — a resumed session)
   *  rendering the settled ✓. */
  running?: boolean;
  /** 0.3.82: the edit card is now the ADVANCED face's edit renderer too —
   *  the path chip inside the expanded diff body keeps its 高亮 spec §2
   *  落点 4 contract (edit 头 → 文件 tab) on both faces. */
  onOpenFile?: (path: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  if (entry.kind === "edit") {
    return <EditCard entry={entry} open={open} onToggle={() => setOpen(!open)} running={running} onOpenFile={onOpenFile} />;
  }
  return <ToolCard entry={entry} open={open} onToggle={() => setOpen(!open)} />;
}

function ActHead({ status, verb, file, note, open, onToggle }: {
  status: ActStatus;
  verb: string;
  file: string;
  note: string;
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <button type="button" className="act-row" data-status={status} aria-expanded={open} onClick={onToggle}>
      <span className={`act-st st-${status}`} aria-hidden={true}>
        {status === "ok" ? <IconCheck size={13} /> : status === "run" ? <IconSpinner size={13} className="spin" /> : "✕"}
      </span>
      <span className="sr-only">{STATUS_TEXT[status]}</span>
      <span className="act-verb">{verb}</span>
      {file !== "" ? <span className="act-file">{file}</span> : null}
      <span className="act-tail">{note}</span>
      <IconChevronDown size={12} className="act-chev" />
    </button>
  );
}

/** ω99-125: the deliverable's type mark, derived in the RENDER layer from
 *  the name's extension (.xlsx→chart .pptx→film else file-text)。116 弧 C：
 *  emoji 位图（📊📽📄）退役 → Icon 细线字形（中性 text-2 色，弧令）——
 *  the derivation never rides the wire (the driver lands only path/name/bytes). */
export function fileIconOf(name: string): IconName {
  const n = name.toLowerCase();
  if (n.endsWith(".xlsx")) return "chart-column";
  if (n.endsWith(".pptx")) return "film";
  return "file-text";
}

/** ω99-125/129: 交付物文件卡行 — one line between the head and the body:
 *  type icon, the file name, an honest KB size, and TWO actions: 「打开」
 *  (primary, ω99-129 — open_path, the system default application; ⌘P 存
 *  PDF rides the OS pipeline, the make_pdf ruling's替代路径) and 「在访达中
 *  显示」 (reveal_path). User language — no implementation terms on the
 *  product face. Both clicks go through the null-safe tauri seam; in a
 *  browser (no bridge) the call resolves null and the click is a silent
 *  no-op — the buttons stay (the desktop is the product face; hiding them
 *  would fork the render on an environment probe). Never rendered on
 *  error entries. */
function FileCardRow({ file }: { file: { readonly path: string; readonly name: string; readonly bytes: number } }): React.JSX.Element {
  return (
    <div className="act-file-card">
      <span className="act-file-icon" aria-hidden={true}><Icon name={fileIconOf(file.name)} size={13} /></span>
      <span className="act-file-name">{file.name}</span>
      <span className="act-file-size">{`${(file.bytes / 1024).toFixed(1)} KB`}</span>
      {/* ω99-129: primary action 打开 (open_path). Reuses the act-file-reveal
          class on purpose: styles.css is OUTSIDE this arc's whitelist and the
          class is the card's shared action-button style — identical look,
          zero CSS touch. */}
      <button
        type="button"
        className="act-file-reveal"
        onClick={() => {
          void tauriInvokeCommand("open_path", { path: file.path });
        }}
      >
        打开
      </button>
      <button
        type="button"
        className="act-file-reveal"
        onClick={() => {
          void tauriInvokeCommand("reveal_path", { path: file.path });
        }}
      >
        在访达中显示
      </button>
    </div>
  );
}

function ToolCard({ entry, open, onToggle }: { entry: ToolEntry; open: boolean; onToggle: () => void }): React.JSX.Element {
  const kind = activityKindOf(entry.name);
  const preview = entry.resultPreview ?? "";
  // Research 35 #2: an error's first line IS the collapsed summary. UI-3 C1
  // (scout 顺手项): collapsed, it carries the mockup's 「· 点击查看」 hint —
  // the red first line plus where the rest went; expanded, the hint retires
  // (the body is open — the EditCard's 查看改动 note follows the same rule).
  const errHead = entry.isError ? firstLine(preview) : "";
  // UI-5 C7-A: the status rides the entry's COMPLETED state, not the
  // preview's presence — the HistoryList M3 rule, ported to the simple card.
  // A history tool entry only lands at tool_call_finished (the wire carries
  // no in-flight marker; in-flight tools render the turnlive busy rows), so
  // the old `preview === "" ? "run"` branch was unreachable-in-practice AND
  // wrong when hit: a successful tool with empty output spun ◐ forever.
  // UI-4 C10: the finished call's duration rides the collapsed tail
  // (`· 1.2s`, one decimal; sub-0.1s reads honestly as `<0.1s`). The driver
  // emits durationMs on the finished event and the relay passes the entry
  // verbatim — absent on old servers / pre-I21 history keeps the tail
  // empty exactly as before. The err card keeps the error's first line as
  // its tail (red discipline: the failure text IS that card's summary).
  const seconds = (entry.durationMs ?? 0) / 1000;
  const durTail = entry.durationMs !== undefined && !entry.isError ? `· ${seconds < 0.1 ? "<0.1" : seconds.toFixed(1)}s` : "";
  const note = errHead === "" ? durTail : open ? errHead : `${errHead} · 点击查看`;
  const status: ActStatus = entry.isError ? "err" : "ok";
  return (
    <div className={`act${entry.isError ? " err" : ""}`} data-kind={kind} data-status={status} data-err={entry.isError === true} data-open={open}>
      <ActHead
        status={status}
        verb={KIND_VERB[kind]}
        file={entry.summary}
        note={note}
        open={open}
        onToggle={onToggle}
      />
      {/* ω99-125: the deliverable receipt's card row — only on non-error
       *  entries carrying `file`; its absence keeps the DOM untouched. */}
      {entry.file !== undefined && !entry.isError ? <FileCardRow file={entry.file} /> : null}
      {open ? <ToolBody entry={entry} kind={kind} /> : null}
    </div>
  );
}

function ToolBody({ entry, kind }: { entry: ToolEntry; kind: ToolActivityKind }): React.JSX.Element | null {
  // M76-ux2 §2: the expand state rides the BODY (the card's own open/close
  // is the head's business) — 8 lines truncated → 50 expanded → back.
  const [expanded, setExpanded] = useState(false);
  const preview = entry.resultPreview ?? "";
  if (preview === "") return null;
  const { lines, total } = capLines(preview, expanded ? EXPAND_LINE_CAP : CARD_LINE_CAP);
  // Truncated at rest shows 展开; expanded (content > 8 by construction)
  // shows 收起. Under the cap there is nothing to toggle.
  const toggle =
    total > CARD_LINE_CAP || expanded ? (
      <CapToggle total={total} expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
    ) : null;
  const maxHeight = expanded ? EXPANDED_BODY_MAX_HEIGHT : BODY_MAX_HEIGHT;
  if (kind === "inout") {
    // The fallback family: the ask (IN) and the outcome (OUT) side by side.
    // 品牌弧补丁（用户令「命令和输出全放一起，做好区分」）：shell 的
    // resultPreview 自带 `$ 命令` 回显行+尾行 `[exit N]`——渲染时拆出：
    // 输入=命令（summary 已是）、输出=纯结果体、退出码挂到块标签
    // （`输出 · exit 0`），不再与正文混排。
    let outLines = lines;
    let exitTag = "";
    if (entry.name === "shell") {
      const raw = preview.split("\n");
      const body = [...raw];
      if (body.length > 0 && body[0]!.startsWith("$ ")) body.shift();
      const last = body[body.length - 1] ?? "";
      const m = /^\[exit (-?\d+)\]$/.exec(last.trim());
      if (body.length > 0 && m !== null) {
        exitTag = ` · exit ${m[1]}`;
        body.pop();
      }
      const capped = capLines(body.join("\n"), expanded ? EXPAND_LINE_CAP : CARD_LINE_CAP);
      outLines = capped.lines;
    }
    return (
      <div className="act-body inout" data-truncated={total > CARD_LINE_CAP} style={{ maxHeight }}>
        <div className="block">
          <span className="blocklabel">输入</span>
          <span className="blocktext">{entry.summary === "" ? "(无参数摘要)" : entry.summary}</span>
        </div>
        <div className={`block${entry.isError ? " err" : ""}`}>
          <span className="blocklabel">{entry.isError ? "出错" : "输出"}{exitTag}</span>
          <span className="blocktext">{outLines.join("\n") === "" && exitTag !== "" ? "(无输出)" : outLines.join("\n")}</span>
          {toggle}
        </div>
      </div>
    );
  }
  return (
    <div className={`act-body ${kind}`} data-truncated={total > CARD_LINE_CAP} style={{ maxHeight }}>
      <span className="blocktext">{lines.join("\n")}</span>
      {toggle}
    </div>
  );
}

function EditCard({ entry, open, onToggle, running, onOpenFile }: {
  entry: EditEntry;
  open: boolean;
  onToggle: () => void;
  running: boolean;
  onOpenFile?: (path: string) => void;
}): React.JSX.Element {
  // UI-5 C7-A: the card mounts at tool-call START (the driver pushes the
  // edit entry before the write runs) — with the state frame already
  // carrying the busy row (emit precedes appendHistory on the wire), the
  // first render is ◐ and the single ◐→✓ flip lands at tool_call_finished.
  // The collapsed tail names the phase honestly too (正在写入… / 查看改动).
  const status: ActStatus = running ? "run" : "ok";
  return (
    <div className="act" data-kind="diff" data-status={status} data-open={open}>
      <ActHead status={status} verb="修改" file={entry.path} note={open ? "" : running ? "正在写入…" : "查看改动"} open={open} onToggle={onToggle} />
      {open ? <DiffBody entry={entry} onOpenFile={onOpenFile} /> : null}
    </div>
  );
}

/** #455: the diff body's folded state is the BALANCED two-sign preview, not
 *  the hunk's head. The hunk keeps its full form (展开 raises to it — slicing
 *  the patch would lie), but the FOLD itself must show both sides: every `+`
 *  row sits after every `-` row (git hunk order), so the old 132px window —
 *  ≈7 rows — landed inside the del block for 19/27 edits of the reported
 *  session and read as 「只有 - 号没有 + 号」. perSide=3 keeps each side's
 *  head with honest counted elision markers; hunks under the line cap stay
 *  untouched (the preview only folds overflow). */
function DiffBody({ entry, onOpenFile }: { entry: EditEntry; onOpenFile?: (path: string) => void }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const full = collapseContext(computeDiff(entry.oldString, entry.newString));
  const overCap = full.length > CARD_LINE_CAP;
  const rows = !expanded && overCap ? balancedDiffRows(full, 3) : full;
  return (
    <div className="act-body diffwrap" style={{ maxHeight: expanded ? EXPANDED_BODY_MAX_HEIGHT : BODY_MAX_HEIGHT }}>
      <DiffView path={entry.path} oldString={entry.oldString} newString={entry.newString} rows={rows} onOpenFile={onOpenFile} />
      {overCap ? (
        <CapToggle total={full.length} expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
      ) : null}
      {expanded && full.length > EXPAND_LINE_CAP ? (
        <div className="activity-foot">{`⋯ diff 共 ${full.length} 行,卡内滚动查看`}</div>
      ) : null}
    </div>
  );
}
