// StatusBar — the single bottom line, the web mirror of the TUI's
// status-bar.tsx: head (`wudao · <session8>`), mode, ctx watermark (+ ⚠ when
// near limit), cache %, ▣ board progress, bg counts, sidecar checks, and the
// 🛡✕ breaker segment. Segments whose data is absent are omitted entirely
// (no dangling separators). M57 §2: the model segment (from the state
// snapshot's `model` field) is a CLICKABLE button when onPickModel is wired
// — the web model picker's entry point.
//
// 墨线 T10 收编: the strip's class is .statusline (the mockup's name — was
// .statusbar) and its skin is the panel bottom edge (28px caption mono on
// the window bg, no surface band). The props contract is unchanged; App
// mounts it exactly where it did.
//
// M76-ux2 §8 — the ctx segment's hover: the title attribute carries the
// four-section breakdown from the ctxInfo op (newline-separated, rendered
// pre-line by the browser's native tooltip), fetched on mount and again
// only when ctx.used moves by >1k (the fetch rides a latest-value ref, so a
// new fetcher identity from the parent never restarts the effect). Without
// the op — not wired, or an old server where it rejects — the title stays
// the generic 上下文使用量 label; the segment itself never changes.
//
// UI-3 C3 — the busy segment: the mockup P4 statusline's right-edge
// `▌思考中 · 12s`. Shown while the driver is busy AND no ask is parked (an
// asked turn is WAITING ON THE USER, not thinking — the amber card owns the
// attention). The label is derived from the SAME state the simple face's
// turn status reads (turnPhaseOf — one phase derivation, both shells), so
// the wording stays honest when the work changes shape (思考中/执行中/
// 回复中/处理中). The seconds ride useTurnClock — the shared turn clock
// (SimpleTurnStatus's own timer, extracted), 1s-throttled: no new timer
// pattern, and the statusline never re-renders per frame.
//
// ω99-224 — the BUDDY variant (0.3.59 验装回执第一报: 「这些其实会话窗口
// 都有，已经重复显示了，换一些会话窗口没有的内容」). The buddy shell's
// conversation window already carries the model chip, the ctx ring, and the
// mode cycle (SimpleComposer→InputBox), so the strip's head/model/mode/ctx/
// cache segments are pure duplication THERE. With `buddy` the chain becomes:
// a LEADING workspace segment (the trust anchor — which folder the agent
// works in, basename shown + full path on hover) → ▣ board → bg → sidecar →
// the busy segment (kept — same derivation as SimpleTurnStatus). The
// advanced face (buddy absent/false) renders byte-identically: its
// instrument-panel philosophy is untouched.
import React, { useEffect, useRef, useState } from "react";
import type { CtxInfoResult, DriverStatus } from "../protocol.js";
import { formatTokensK } from "../log.js";
import { SEGMENT_SEP } from "../theme.js";
import { turnPhaseOf, useTurnClock, type TurnPhase } from "./SimpleTurnStatus.js";
import { Icon } from "./Icon.js";

/** The busy segment's wording per phase (mockup P4: 思考中; the other three
 *  keep the segment honest when tools run or the answer streams). */
const BUSY_LABEL: Record<TurnPhase, string> = {
  thinking: "思考中",
  tools: "执行中",
  answering: "回复中",
  working: "处理中",
};

/** The clock appears after this many ms — the 1s throttle the shared turn
 *  clock enforces anyway (the mockup shows `· 12s`, i.e. from the first
 *  second; the simple face's 15s quiet period is its own choice). */
const BUSY_CLOCK_DELAY_MS = 1_000;

/** The hover's one line per section (spec §8: 分行). ~ marks the estimate —
 *  the driver's chars/4 accounting, not a provider count. R5-I1: the 图片
 *  line rides along ONLY when images exist (imagesTokens absent on an old
 *  server, or 0 on a text-only session → no line). */
const ctxTitle = (info: CtxInfoResult): string =>
  [
    `系统提示 ~${formatTokensK(info.systemTokens)}`,
    `工具定义 ~${formatTokensK(info.toolsTokens)}`,
    `消息历史 ~${formatTokensK(info.messagesTokens)}`,
    ...(info.imagesTokens !== undefined && info.imagesTokens > 0
      ? [`图片 ~${formatTokensK(info.imagesTokens)}`]
      : []),
    `可用 ~${formatTokensK(info.availableTokens)}`,
  ].join("\n");

export function StatusBar({
  status,
  ctxInfo,
  stale,
  sessionName,
  buddy,
  workspaceName,
  workspacePath,
}: {
  status: DriverStatus | null;
  /** M76-ux2 §8: the ctxInfo op (structural — the WudaoClient method or a
   *  test double). Absent or rejecting → the generic hover title. */
  ctxInfo?: () => Promise<CtxInfoResult>;
  /** statecover A2 — true while the connection is NOT connected: the strip
   *  renders the PRE-DROP snapshot (protocol.ts keeps the last status), so
   *  the row is marked stale and visually weakened until a reconnect's
   *  replay restores it. Presentation only — the refetch semantics are the
   *  panels' (ui-review-r4 I3), not this component's. */
  stale?: boolean;
  /** ω99-156: the CURRENT session's user-given name (App's activeName read
   *  of the sessions store — the /rename lane, 150). Absent or empty → the
   *  id8 handle stands (the segment never widens beyond its data). */
  sessionName?: string;
  /** ω99-224: the BUDDY variant's flag — App's view state (the simple shell
   *  never mounts the strip at all). True → the workspace-led chain; absent
   *  or false → the advanced instrument panel, byte-identical to the
   *  pre-224 strip. */
  buddy?: boolean;
  /** ω99-224: the workspace segment's label — the AGENT root's basename
   *  (App's workspace-ux B3 mirror; NOT the file panel's view root, which a
   *  pick can move independently of where the agent works). Absent/empty →
   *  the segment omits entirely (the strip's no-dangling-separator
   *  discipline). */
  workspaceName?: string;
  /** ω99-224: the workspace segment's hover — the FULL agent-root path (the
   *  basename alone is the glance; the absolute path is the hover's job). */
  workspacePath?: string;
}): React.JSX.Element | null {
  const [ctxBreakdown, setCtxBreakdown] = useState<CtxInfoResult | null>(null);
  // Latest-value refs: the fetch effect keys on the ctx.used VALUE only — a
  // new fetcher identity (inline arrow from App) must not restart it.
  const ctxInfoRef = useRef(ctxInfo);
  ctxInfoRef.current = ctxInfo;
  const fetchedFor = useRef<number | null>(null); // ctx.used at the last SUCCESSFUL fetch

  const ctxUsed = status?.ctxTokens?.used ?? null;
  // UI-3 C3: busy, but a parked ask means the turn waits on the user —
  // "thinking" would lie, and the approval card already owns the attention.
  const thinking = status !== null && status.busy && status.pendingPermission === null;
  // UI-4 LOW-1: the clock keys on the TURN (busy), not the ask-free slice.
  // `thinking` stays the RENDER gate (an asked turn hides the segment —
  // pinned), but keying the clock on it made a mid-turn ask RESTART the
  // timer on release (归零重计), disagreeing with the simple face's
  // one-turn-one-clock discipline (SimpleTurnStatus keys on busy). The ask
  // is part of the turn: the seconds keep accumulating underneath the
  // hidden segment, and the released segment reappears with the cumulative
  // count. The shared clock's 1s throttle still bounds the hidden period's
  // re-renders.
  const elapsed = useTurnClock(status !== null && status.busy, BUSY_CLOCK_DELAY_MS);
  const busyLabel = thinking ? BUSY_LABEL[turnPhaseOf(status.live)] : null;
  useEffect(() => {
    // ω99-224: the buddy variant renders no ctx segment, so the hover's
    // breakdown has no consumer — the fetch stays off the buddy wire.
    if (buddy === true) return;
    const fetcher = ctxInfoRef.current;
    // No fetcher (old client), or no ctx data yet (ctxTokens null — the
    // segment is not even rendered; the first real frame re-triggers this
    // effect as last flips from never-fetched). Keeps the pre-connect wire
    // free of ops that would only reject "not connected".
    if (fetcher === undefined || ctxUsed === null) return;
    // Refetch when the segment first appears, then only on a >1k delta
    // (noise from per-delta watermark nudges stays off the wire).
    const last = fetchedFor.current;
    if (last !== null && Math.abs(ctxUsed - last) <= 1000) return;
    let cancelled = false;
    fetcher().then(
      (info) => {
        if (cancelled) return;
        fetchedFor.current = ctxUsed;
        setCtxBreakdown(info);
      },
      () => {
        if (!cancelled) setCtxBreakdown(null); // old server: keep the fallback
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ctxUsed]);

  const segments: React.ReactNode[] = [];
  if (status !== null) {
    if (buddy === true) {
      // ω99-224: #1 — the buddy variant's chain. The conversation window
      // already shows the model/ctx/mode (SimpleComposer→InputBox chips +
      // ContextMeter), so those segments are duplication on this face; the
      // workspace segment is the face's NEW information — the trust anchor
      // for 托付: which folder the agent works in, one glance away (basename
      // shown, full path on hover). Absent workspaceName → the segment
      // omits entirely (no dangling separator — the strip's discipline).
      if (workspaceName !== undefined && workspaceName !== "") {
        segments.push(
          <span key="workspace" title={workspacePath}>
            {`工作区 ${workspaceName}`}
          </span>,
        );
        // ω99-253: #6 — the branch chip, the anchor's one property: WHICH
        // checkout of that workspace the agent works in. Rides immediately
        // after the workspace segment (not a new status item — the visual
        // union with the anchor); name verbatim ("HEAD" = detached, honest);
        // null/absent (old server, non-repo, read failure) renders NOTHING.
        if (typeof status.gitBranch === "string" && status.gitBranch !== "") {
          segments.push(
            <span key="branch" className="seg-branch" title="当前工作分支">
              {status.gitBranch}
            </span>,
          );
        }
      }
    } else {
      // ω99-156: the head names the session the user named it; the id8 stays as
      // the precise handle when no name exists (instrument-panel fallback).
      segments.push(`wudao · ${sessionName !== undefined && sessionName !== "" ? sessionName : status.sessionId.slice(0, 8)}`);
      // ω99-253 (same chip, advanced face) — the SAME chip on the advanced face, right after the
      // identity head (two faces, one piece of information — the ruling this
      // arc pins; an absent/null field keeps the strip byte-identical, so
      // 224's advanced snapshot discipline holds for old servers).
      if (typeof status.gitBranch === "string" && status.gitBranch !== "") {
        segments.push(
          <span key="branch" className="seg-branch" title="当前工作分支">
            {status.gitBranch}
          </span>,
        );
      }
      /* ω99-298 (M14): the 模型/模式 segments are RETIRED — the composer's
         chips (ModelSelector / ShieldSelector) are the interactive single
         home for both facts, one glance away on the same screen. This
         completes the user's own ω99-224 ruling on the ADVANCED face
         (「模型…模式…这些其实会话窗口都有，已经重复显示了」— that arc
         dropped them from the buddy variant only); v5's 简化 license
         finishes the sentence. ctx/cache below are NOT duplicated in the
         composer and stay. */
      if (status.ctxTokens !== null) {
        segments.push(
          <span key="ctx" className="seg-ctx" title={ctxBreakdown !== null ? ctxTitle(ctxBreakdown) : "上下文使用量"}>
            {`ctx ${status.ctxTokens.used === null ? "…" : formatTokensK(status.ctxTokens.used)}/${formatTokensK(status.ctxTokens.window)}`}
            {status.ctxTokens.nearLimit ? <span className="warn"><Icon name="triangle-alert" size={11} /></span> : null}
          </span>,
        );
      }
      // M64-visual §4: cache% reads on --ok (the statusline's quiet green).
      if (typeof status.cachePercent === "number") {
        segments.push(<span key="cache" className="cache">{`cache ${Math.round(status.cachePercent)}%`}</span>);
      }
      // ω99-249: #12 — the goal's one line — what we're working toward and what the
      // budget allows (benefit copy: 目标/已花/预算, zero implementation terms;
      // the hover title carries the split + progress for the curious). Absent
      // or null (old server / no budgeted task claimed) renders NOTHING.
      // budget_limited gets its own warn face: the objective stays visible
      // with an explicit 预算已尽 — a stopped-for-budget campaign must not
      // read as an idle one.
      if (status.goal != null) {
        const g = status.goal;
        const spentLine =
          g.budgetTokens !== undefined
            ? `已花 ${formatTokensK(g.usedTokens)} / 预算 ${formatTokensK(g.budgetTokens)}`
            : `已花 ${formatTokensK(g.usedTokens)}`;
        segments.push(
          <span
            key="goal"
            className={g.status === "budget_limited" ? "seg-goal warn" : "seg-goal"}
            title={`目标：${g.objective}\n${spentLine}（输入 ${formatTokensK(g.inputTokens)} · 输出 ${formatTokensK(g.outputTokens)}）\n任务进度 ${g.progress.done}/${g.progress.total}`}
          >
            {g.status === "budget_limited"
              ? `目标预算已尽 · ${g.objective.slice(0, 24)}${g.objective.length > 24 ? "…" : ""}（${spentLine}，任务 ${g.progress.done}/${g.progress.total}）`
              : `目标 ${g.objective.slice(0, 24)}${g.objective.length > 24 ? "…" : ""}（${spentLine}，任务 ${g.progress.done}/${g.progress.total}）`}
          </span>,
        );
      }
    }
    if (status.boardProgress !== null) {
      // 116 弧 C：▣ → list-checks 细线字形（看板进度位）。
      segments.push(<span key="board" className="board"><Icon name="list-checks" size={11} /> {`${status.boardProgress.done}/${status.boardProgress.total}`}</span>);
    }
    if (status.bg.spawned > 0) segments.push(`bg ${status.bg.active}/${status.bg.spawned}`);
    if (status.sidecar !== null && status.sidecar.checks > 0) {
      segments.push(`sidecar ${status.sidecar.checks}`);
      // 116 弧 C：🛡✕ 双字符位 → shield-x 单字形（warn 语义色）。
      if (status.sidecar.breakerOpen) segments.push(<span key="breaker" className="warn"><Icon name="shield-x" size={11} /></span>);
    }
  }
  if (segments.length === 0) return null;
  return (
    <div className="statusline" data-stale={stale === true ? "" : undefined}>
      {segments.map((segment, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <span className="sep">{SEGMENT_SEP}</span> : null}
          {segment}
        </React.Fragment>
      ))}
      {/* C3: the right-edge busy segment rides OUTSIDE the sep chain — a
          separator pulled away from its left neighbor by the auto margin
          would dangle mid-gap. Renders only once the clock ticks (1s). */}
      {thinking && elapsed !== null && busyLabel !== null ? (
        <span className="seg-busy">{`▌${busyLabel} · ${elapsed}s`}</span>
      ) : null}
    </div>
  );
}
