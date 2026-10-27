// ω99-213: #3 — 回来摘要横幅卡（纯展示）。会话流顶部横幅（不弹窗不打断）：
// 标题「你离开了 X——这期间：」+ 三段（完成了/还在进行/等你决定）+ 数字行
// （N 轮 · M 次工具调用 · K 个文件——数字来自结构化历史计数，非模型生成）+
// 关闭钮。narrative 缺席 = 诚实降级卡：只出标题+数字行，零编造。文案守
// user-facing-copy 令——只写用户收益，不写实现术语。
import type React from "react";
import type { RecapPayload } from "../protocol.js";

/** The three labels (the narrative contract's order — cli's RECAP_LABELS
 *  hand-mirrored; the web is zero-dep on cli). */
const LABELS = ["完成了：", "还在进行：", "等你决定："] as const;

/** Pure: the away span as a human phrase. Minutes under the hour, floor
 *  hours beyond, days beyond 24h; null when sinceTs is absent/nonsense (the
 *  title falls back to a duration-free form). */
export function formatAwayDuration(sinceTs: number | null, now: number): string | null {
  if (sinceTs === null || !Number.isFinite(sinceTs) || sinceTs > now) return null;
  const minutes = Math.floor((now - sinceTs) / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

/** Pure: split a sanitized narrative into its labeled segments. A line that
 *  starts a label opens a segment; any other line continues the previous one
 *  (sanitize already stripped leading junk, so this is display-side
 *  defensiveness only). */
export function recapSegments(narrative: string): { label: string; body: string }[] {
  const lines = narrative
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  // Group by label-starting lines: each label opens a segment that owns every
  // line up to the next label (continuation lines join with a space).
  const starts: number[] = [];
  lines.forEach((line, i) => {
    if (LABELS.some((l) => line.startsWith(l))) starts.push(i);
  });
  const out: { label: string; body: string }[] = [];
  starts.forEach((from, s) => {
    const to = s + 1 < starts.length ? starts[s + 1] as number : lines.length;
    const first = lines[from] ?? "";
    const label = LABELS.find((l) => first.startsWith(l));
    if (label === undefined) return;
    const parts = lines.slice(from, to).map((l, i) => (i === 0 ? l.slice(label.length).trim() : l));
    out.push({ label, body: parts.filter((p) => p !== "").join(" ") });
  });
  return out;
}

/** The banner card. No payload = never mounted (the hook owns that gate). */
export function RecapBanner({ payload, now, onClose }: {
  payload: RecapPayload;
  now: number;
  onClose: () => void;
}): React.JSX.Element {
  const away = formatAwayDuration(payload.stats.sinceTs, now);
  const segments = payload.narrative !== undefined ? recapSegments(payload.narrative) : [];
  return (
    <div className="recap-banner" role="status">
      <div className="recap-title">{away !== null ? `你离开了 ${away}——这期间：` : "你离开了这段时间——"}</div>
      {segments.length > 0 ? (
        <div className="recap-segments">
          {segments.map((s) => (
            <div className="recap-segment" key={s.label}>
              <span className="recap-label">{s.label}</span>
              {s.body}
            </div>
          ))}
        </div>
      ) : null}
      <div className="recap-stats">{`${payload.stats.turns} 轮 · ${payload.stats.toolCalls} 次工具调用 · ${payload.stats.filesTouched} 个文件`}</div>
      <button type="button" className="wudao action recap-close" onClick={onClose}>知道了</button>
    </div>
  );
}
