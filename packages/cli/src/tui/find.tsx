// ω99-59 — the /find overlay panel: a result list over the structured
// history with keyboard navigation (↓↑ move · Enter expands the selected
// entry in full · Esc steps back from the expanded view, then closes and
// restores the input). Same ownership pattern as AskUserPrompt /
// PermissionPrompt: while mounted the panel owns the keyboard and the
// app-level useInput stands down. No alt-screen, no scrollback control —
// the "jump" IS the focused in-panel view (the terminal keeps its own
// scrollback; that boundary is the architecture, not a gap).
import { truncateSafe, truncateTailSafe } from "@wudao-org/core"; // 113-A4
import React, { useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { T } from "./theme.js";
import { findInHistory, focusFields, FIND_MAX_SHOWN } from "./find-core.js";
import type { FindMode } from "./find-core.js";
import type { HistoryEntry } from "./use-agent.js";

const MODE_LABEL: Record<FindMode, string> = { substring: "子串", token: "词" };

// The focused view bounds each field: head + tail around a middle marker,
// so a huge tool result cannot blow the layout.
const FIELD_CAP = 1200;
function boundField(text: string): string {
  if (text.length <= FIELD_CAP) return text;
  const half = Math.floor(FIELD_CAP / 2);
  return `${truncateSafe(text, half)}\n…[+${text.length - FIELD_CAP} chars]…\n${truncateTailSafe(text, half)}`;
}

export function FindPanel({ query, history, onClose }: {
  query: string;
  history: readonly HistoryEntry[];
  onClose: () => void;
}): React.JSX.Element {
  const [selected, setSelected] = useState(0);
  const [focused, setFocused] = useState(false);
  const closed = useRef(false);
  // Live re-search: a steer landing mid-find swaps the history array and the
  // panel recomputes (indices shift with it — the view is always the truth).
  const { mode, matches } = useMemo(() => findInHistory(history, query), [history, query]);
  const shown = matches.slice(0, FIND_MAX_SHOWN);
  const sel = Math.min(selected, Math.max(0, shown.length - 1));
  const selEntry = history[shown[sel]?.index ?? -1];

  useInput((input, key) => {
    if (closed.current) return;
    if (key.ctrl && input === "c") {
      closed.current = true;
      onClose();
      return;
    }
    if (key.escape) {
      // Two-level back: expanded view → list → close (idle again).
      if (focused) setFocused(false);
      else {
        closed.current = true;
        onClose();
      }
      return;
    }
    if (key.downArrow || key.upArrow) {
      const delta = key.downArrow ? 1 : -1;
      setSelected(Math.max(0, Math.min(shown.length - 1, sel + delta)));
      return;
    }
    if (key.return && shown.length > 0) setFocused(true);
  });

  if (matches.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color={T.accent}>{`🔍 find: ${query} · ${MODE_LABEL[mode]} — 无命中`}</Text>
        <Text dimColor>{"(换个词试试 · Esc 关闭)"}</Text>
      </Box>
    );
  }
  if (focused && selEntry !== undefined) {
    return (
      <Box flexDirection="column">
        <Text color={T.accent}>{`🔍 #${shown[sel]?.index} ${shown[sel]?.label} — 第 ${sel + 1}/${shown.length} 命中 · Esc 返回列表`}</Text>
        {focusFields(selEntry).map((f, i) => (
          <Text key={i}>
            {"  "}
            <Text dimColor>{f.field.padEnd(7)}</Text>
            {boundField(f.text)}
          </Text>
        ))}
        <Text dimColor>{"(↓↑ 上一条/下一条 · Esc 返回列表)"}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text color={T.accent}>{`🔍 find: ${query} · ${MODE_LABEL[mode]} — ${matches.length} 命中`}</Text>
      {shown.map((m, i) => (
        <Text key={m.index} color={i === sel ? T.accent : undefined}>
          {`${i === sel ? "▸" : " "} ${i + 1}) #${m.index} ${m.label}  ${m.contextLine}`}
        </Text>
      ))}
      {matches.length > FIND_MAX_SHOWN ? (
        <Text dimColor>{`  … 另有 ${matches.length - FIND_MAX_SHOWN} 条（缩小查询范围）`}</Text>
      ) : null}
      <Text dimColor>{"(↓↑ 选择 · Enter 展开全文 · Esc 关闭)"}</Text>
    </Box>
  );
}
