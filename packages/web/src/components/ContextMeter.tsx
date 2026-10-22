// ContextMeter — inkline Task 7 (spec §2): the inline `.ctx` readout in the
// composer's right cluster — a 12px ring (was 14/20px) plus the mono `▲N.Nk`
// used-token count; a click opens the legend. M63 §D's honesty rule stands:
// the spec's 系统/工具/消息 SEGMENT legend needs a per-segment breakdown the
// protocol does not carry yet — ctxTokens is an aggregate
// (used/window/nearLimit) only, so the legend renders the honest aggregate;
// when a future protocol version adds segments, they slot into the same
// legend. Null ctx (before the first usage frame) renders nothing — the
// widget only exists when the data does.
import { useEffect, useState } from "react";
import type { DriverStatus } from "../protocol.js";
import { formatTokensK } from "../log.js";
import { Icon } from "./Icon.js";

const SIZE = 12;
const R = 4.5;
const C = 2 * Math.PI * R;

export function ContextMeter({ ctx }: { ctx: DriverStatus["ctxTokens"] }): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  // ui-review-r1 P8: the open legend dismisses from OUTSIDE too — the
  // ws-menu/ctx-menu contract (a transparent fixed click-away + Esc on
  // window), instead of only the toggle button.
  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (ctx === null) return null;
  const frac = ctx.used === null ? 0 : Math.max(0, Math.min(1, ctx.used / ctx.window));
  return (
    <span className="ctx">
      <button
        type="button"
        className="ctx-btn"
        aria-label="上下文用量"
        aria-expanded={open}
        title="上下文用量(点击查看)"
        onClick={() => setOpen(!open)}
      >
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden={true}>
          <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke="var(--hair-2)" strokeWidth="2" />
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            fill="none"
            stroke={ctx.nearLimit ? "var(--warn)" : "var(--accent)"}
            strokeWidth="2"
            strokeDasharray={`${frac * C} ${C}`}
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          />
        </svg>
        <span className="ctx-num" aria-hidden={true}>{`▲${ctx.used === null ? "…" : formatTokensK(ctx.used)}`}</span>
      </button>
      {open ? (
        <>
          {/* P8: the click-away sits UNDER the legend (z 19 vs 20). */}
          <span className="ctxmeter-backdrop" onClick={() => setOpen(false)} />
          <span className="ctxmeter-legend" role="note">
          <span className="row">{ctx.used === null ? "已用 …(本轮未回报)" : `已用 ${formatTokensK(ctx.used)}`}</span>
          <span className="row">{`窗口 ${formatTokensK(ctx.window)}`}</span>
          <span className="row">{ctx.used === null ? "占比 …" : `占比 ${Math.round(frac * 100)}%`}</span>
          {ctx.nearLimit ? <span className="row warn"><Icon name="triangle-alert" size={11} /> 接近上限——过长时历史会自动压缩</span> : null}
          </span>
        </>
      ) : null}
    </span>
  );
}
