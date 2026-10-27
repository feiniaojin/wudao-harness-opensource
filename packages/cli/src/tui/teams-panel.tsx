// M64-C §C — the in-process team panel (TUI): one line per teammate from
// the shared view model (idle rows hide after 30s, past 3 visible rows it
// collapses), ↑↓ moves the selection, Enter opens the direct-send input
// for the selected teammate, x stops it. The panel mounts only when a team
// exists (teammates or pending plans) — no team, zero surface.
import React, { useCallback, useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import { teammatePanelRows, formatTeammateRow } from "../teams/panel.js";
import type { TeamRuntime } from "../teams/runtime.js";

export interface TeamsPanelProps {
  readonly team: TeamRuntime;
  /** Re-render tick (the app drives it from its own state loop). */
  readonly now: number;
  readonly onSend: (name: string, text: string) => void;
  readonly focused: boolean;
}

export function TeamsPanel(props: TeamsPanelProps): React.JSX.Element {
  const rows = props.team.teammates();
  const pending = props.team.pendingPlans();
  const panel = teammatePanelRows(rows, props.now);
  const selectable = panel.filter((r) => r.kind === "teammate");
  const [selected, setSelected] = useState(0);
  const [draftFor, setDraftFor] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const clamp = useCallback(
    (n: number) => Math.max(0, Math.min(selectable.length - 1, n)),
    [selectable.length],
  );

  useInput((input, key) => {
    if (!props.focused) return;
    if (draftFor !== null) {
      if (key.return) {
        if (draft.trim() !== "") props.onSend(draftFor, draft.trim());
        setDraftFor(null);
        setDraft("");
        return;
      }
      if (key.escape) {
        setDraftFor(null);
        setDraft("");
        return;
      }
      if (key.backspace || key.delete) {
        setDraft((d) => d.slice(0, -1));
        return;
      }
      if (input !== "") setDraft((d) => d + input);
      return;
    }
    if (key.upArrow) {
      setSelected((s) => clamp(s - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((s) => clamp(s + 1));
      return;
    }
    const row = selectable[Math.min(selected, selectable.length - 1)];
    if (row === undefined) return;
    if (input === "x") {
      void props.team.stopTeammate((row as { row: { name: string } }).row.name);
      return;
    }
    if (key.return) {
      const name = (row as { row: { name: string } }).row.name;
      const plan = pending.find((p) => p.teammate === name);
      if (plan !== undefined) {
        // Enter on a plan-pending row approves; shift+Enter rejects.
        if (key.shift) void props.team.reject(name, "rejected from the panel");
        else void props.team.approve(name);
        return;
      }
      setDraftFor(name);
    }
  });

  if (panel.length === 0) return <></>;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingLeft={1} paddingRight={1}>
      {/* ω99-170: #1 骨架行中文化 */}
      <Text dimColor>团队 {props.team.team} —— ↑↓ 选择 · Enter {pending.length > 0 ? "批准（shift=拒绝）" : "查看+发送"} · x 停止</Text>
      {panel.map((r, i) => {
        if (r.kind === "collapsed") {
          // ω99-170: #2 折叠行中文化（词表与 169 归一；保留前导两空格与 dimColor）
          return (
            <Text key={`collapsed-${i}`} dimColor>  … 还有 {r.hidden} 项</Text>
          );
        }
        const isSelected = props.focused && selectable.findIndex((s) => s === r) === selected;
        return (
          <Text key={r.row.name} color={isSelected ? "cyan" : undefined}>
            {isSelected ? "❯ " : "  "}
            {formatTeammateRow(r.row)}
          </Text>
        );
      })}
      {/* ω99-170: #3 待批方案行中文化（teammate 名插值原样） */}
      {pending.length > 0 && (
        <Text color="yellow">📋 待批方案：{pending.map((p) => p.teammate).join(", ")}</Text>
      )}
      {/* ω99-170: #4 直发草稿行中文化（保留前导空格与 cursor span） */}
      {draftFor !== null && (
        <Text> 发给 {draftFor}：{draft}<span className="cursor">▌</span></Text>
      )}
    </Box>
  );
}
