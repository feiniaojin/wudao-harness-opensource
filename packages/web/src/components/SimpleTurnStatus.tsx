// SimpleTurnStatus — M63 §D (research 35 #6): ONE stable turn-level label
// (no per-frame flicker — the label is a pure function of the phase, and the
// phase only changes when the work actually changes shape), an elapsed clock
// that appears ONLY after 15 seconds (a fast turn never shows a number), a
// cancel hint on every wait, and the steering-queue lines. The retry
// countdown the pattern book describes needs retry state the protocol does
// not carry yet (DriverStatus has no attempt/secondsLeft) — that seam stays
// open; nothing here fabricates it.
//
// 0.3.81 精修（双信号收口第二刀）: the parked (排队) lines are GONE from
// here — a parked message already lives in the composer's ⏳ chip (with its
// drop affordance), so the turn status showing it AGAIN was the same
// message on screen twice. The queued (注入) lines stay: they have no
// composer surface.
import { useEffect, useRef, useState } from "react";
import type { LiveState } from "../protocol.js";
import { firstLine, truncate } from "../log.js";
import { Icon } from "./Icon.js";

export type TurnPhase = "thinking" | "tools" | "answering" | "working";

/** The phase derivation (pure — tests share it): a tool in flight owns the
 *  label, then a streaming answer, then reasoning; a busy turn with none of
 *  those is generic "processing". */
export function turnPhaseOf(live: LiveState): TurnPhase {
  if (live.busyTools.length > 0) return "tools";
  if (live.answer !== "") return "answering";
  if (live.reasoning !== "") return "thinking";
  return "working";
}

const PHASE_LABEL: Record<TurnPhase, string> = {
  thinking: "正在思考",
  tools: "正在执行操作",
  answering: "正在回复",
  working: "正在处理",
};

/** The clock appears only after this many ms (research 35 #6: 15s 后才出现计时钟). */
export const CLOCK_DELAY_MS = 15_000;

/** UI-3 C3: the ONE turn clock, extracted from the component so the
 *  statusline's busy segment rides the SAME discipline instead of a second
 *  timer pattern — one turn = one clock, started when the turn goes busy,
 *  torn down on idle; the number appears only after `delayMs`, then ticks at
 *  a 1s throttle (never faster — a busy statusline must not re-render per
 *  frame). The simple face keeps its 15s CLOCK_DELAY_MS; the statusline
 *  passes 1s (the mockup's `· 12s` shows from the first second). */
export function useTurnClock(busy: boolean, delayMs: number): number | null {
  const [elapsed, setElapsed] = useState<number | null>(null);
  const startedAt = useRef<number | null>(null);

  useEffect(() => {
    if (!busy) {
      startedAt.current = null;
      setElapsed(null);
      return;
    }
    startedAt.current = Date.now();
    let interval: ReturnType<typeof setInterval> | null = null;
    const tick = (): void => {
      if (startedAt.current !== null) setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
    };
    const delay = setTimeout(() => {
      tick();
      interval = setInterval(tick, 1000);
    }, delayMs);
    return () => {
      clearTimeout(delay);
      if (interval !== null) clearInterval(interval);
    };
  }, [busy, delayMs]);
  return elapsed;
}

export function formatElapsed(seconds: number): string {
  return `已进行 ${seconds} 秒`;
}

export function SimpleTurnStatus({ busy, live, queued = [], onRecall }: {
  busy: boolean;
  live: LiveState;
  /** Driver-side steering queue (submitted mid-run; injected before the
   *  next model call). */
  readonly queued?: readonly string[];
  /** 借鉴弧 α2 — the ↩ recall on each queued line (absent on faces without
   *  the op: the line renders exactly as before). */
  readonly onRecall?: (index: number, text: string) => void;
}): React.JSX.Element | null {
  // One turn = one clock. The timer only exists between the 15s delay and
  // the end of the turn, so a fast turn costs zero renders.
  const elapsed = useTurnClock(busy, CLOCK_DELAY_MS);

  if (!busy) return null;
  const phase = turnPhaseOf(live);
  // #451（0.3.81 用户反馈：回答时两个转圈，凌乱）: the spinner renders ONLY
  // in the phases where nothing else carries the motion — tools rows spin
  // their own .act-st glyph (BusyToolRow) and the answering caret ▌ types
  // (LiveAnswer). One glance, ONE moving glyph; the label stays on every
  // phase (it says WHAT is happening, not whether).
  const showsSpinner = phase === "thinking" || phase === "working";
  return (
    <div className="turnstatus" data-phase={phase}>
      {/* #451: ONE quiet head line — spinner + label + clock ride a single
          row (the old column flex stacked them as 3-4 lines of noise above
          the answer); only the queued/parked lines keep their rows.
          ω99-298 (M13): the trailing 按 Esc…可停止 hint is retired — the
          composer's 停止 (Esc) chip (busy-gated, same screen) is the single
          stop affordance; the head keeps only the WHAT, not the how-to-stop
          echo. */}
      <div className="ts-head">
        {/* DESIGN-SYSTEM P3：文本等待态走 shimmer（呼吸文字）——spinner 退役于
            文字行首（#451 的「ONE moving glyph」由文字本身承担），保留于图标位。 */}
        <span className={showsSpinner ? "label shimmer" : "label"}>{PHASE_LABEL[phase]}</span>
        {elapsed !== null ? <span className="clock">{formatElapsed(elapsed)}</span> : null}
      </div>
      {queued.map((t, i) => (
        // 借鉴弧 α2: the recall rides the queue line (the advanced face's
        // LiveArea mirror); CAS guards the click race.
        <div key={`q${i}`} className="queue-line">
          {/* 116 弧 C：⏳ 前缀换 hourglass 细线字形（LiveArea .steer 的镜像位同换）。 */}
          <Icon name="hourglass" size={11} />
          {` 将在下一步前注入:${truncate(firstLine(t), 48)}`}
          {onRecall !== undefined ? (
            <button type="button" className="recall" aria-label="撤回这条排队消息" title="趁还没被读取，撤回这条" onClick={() => onRecall(i, t)}>↩ 撤回</button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
