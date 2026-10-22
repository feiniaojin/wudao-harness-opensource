// Bottom status bar (M25-B4): one dim line composing the model/session head,
// the context watermark, the session cache hit rate, todo-board progress, and
// the M30 background-agent counter. M53 §3: the bar now renders FROM the
// statusline snapshot (snapshotForStatusline() — the same single data source
// `wudao statusline --json` serves), so the TUI and any user statusline
// script can never disagree. Segments whose data is absent are omitted
// entirely (no dangling separators); a near-limit context appends a
// warn-colored ⚠ to the watermark.
import React from "react";
import { Text } from "ink";
import { SEGMENT_SEP, T } from "./theme.js";
import { formatTokensK } from "../log.js";
import { modeLabel } from "../permission.js";
import type { StatuslineSnapshot } from "../statusline.js";

export interface StatusBarProps {
  /** M53 §3: the driver's statusline snapshot (single source of truth). */
  readonly snapshot: StatuslineSnapshot;
  /** M35 §2: count of `deferred_loaded` session entries (how many times the
   *  run loaded deferred orchestration tools); renders only when ≥ 1. This
   *  one counter is frontend-held (the driver is not told about persistence
   *  receipts), so it rides beside the snapshot instead of inside it. */
  readonly deferredLoaded?: number | null;
  /** 0.3.15（用户需求：执行过程耗时可见）：busy 期间的活秒数（客户端 1s 节
   *  拍，紧挨 mode 段渲染 `▌Ns`；idle 时调用方传 undefined → 整段省略）。
   *  同样前端持有——快照里没有时钟，也不该每秒推快照。 */
  readonly busyElapsed?: number | null;
}

export function StatusBar(props: StatusBarProps): React.JSX.Element | null {
  const { snapshot: s, deferredLoaded, busyElapsed } = props;
  const segments: React.ReactNode[] = [];

  // `wudao · <model> · <id8>` — one head segment.
  segments.push(`wudao · ${s.model} · ${s.session.id8}`);
  // ω99-253: #11 — the branch segment — which checkout this session works in,
  // right after the identity head (the web advanced face's twin position;
  // the value is the driver's CACHED read — rendering never spawns).
  // Verbatim name ("HEAD" = detached, honest); absent/null → no segment.
  if (typeof s.gitBranch === "string" && s.gitBranch !== "") {
    segments.push(<Text key="branch">{s.gitBranch}</Text>);
  }
  // The raw snapshot mode is the machine value ("default"); the bar shows
  // the user-facing cycle label (accept / ask / auto / plan). // ω99-191: #5
  segments.push(`模式 ${modeLabel(s.mode as Parameters<typeof modeLabel>[0])}`); // ω99-190: #2
  // 0.3.15: the live run clock sits beside the mode (run state reads together).
  if (typeof busyElapsed === "number") segments.push(<Text key="busy-elapsed">{`▌${busyElapsed}s`}</Text>);
  if (s.ctx !== null) {
    segments.push(
      <Text key="ctx">
        {`ctx ${s.ctx.used === null ? "…" : formatTokensK(s.ctx.used)}/${formatTokensK(s.ctx.window)}`}
        {s.ctx.nearLimit ? <Text color={T.warn}> ⚠</Text> : null}
      </Text>,
    );
  }
  if (s.cache !== null) {
    segments.push(`cache ${s.cache.percent}%`);
  }
  if (s.board !== null) {
    segments.push(
      <Text key="board" color={T.board}>{`▣ ${s.board.done}/${s.board.total}`}</Text>,
    );
  }
  if (s.bg.spawned > 0) {
    segments.push(<Text key="bg">{`bg ${s.bg.active}/${s.bg.spawned}`}</Text>);
  }
  if (typeof deferredLoaded === "number" && deferredLoaded > 0) {
    segments.push(<Text key="defer">{`defer ${deferredLoaded}`}</Text>);
  }
  if (s.sidecar !== null && s.sidecar.checks > 0) {
    segments.push(<Text key="sidecar">{`sidecar ${s.sidecar.checks}`}</Text>);
    if (s.sidecar.breakerOpen) {
      segments.push(<Text key="breaker" color={T.warn}>{"🛡✕"}</Text>);
    }
  }
  if (segments.length === 0) return null;

  return (
    <Text dimColor>
      {segments.map((segment, i) => (
        <React.Fragment key={i}>
          {i > 0 ? SEGMENT_SEP : null}
          {segment}
        </React.Fragment>
      ))}
    </Text>
  );
}
