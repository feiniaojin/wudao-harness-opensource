// M42 §2 — the slash suggestion menu rendered above the input. Pure window
// math (≤7 visible rows, overflow scrolls, selection kept in view) plus the
// presentational component; the keyboard decisions live in input.tsx next to
// the buffer state they edit.
import React from "react";
import { Box, Text } from "ink";
import { T } from "./theme.js";
import type { SlashCommandInfo } from "../slash-commands.js";

/** Spec: at most 7 menu rows visible; longer lists scroll. */
export const SUGGEST_MAX_ROWS = 7;

/** The visible window for a list of `length` with `selected` highlighted:
 *  the whole list while it fits, otherwise a 7-row window scrolled to keep
 *  the selection in view (centered when possible, clamped at the ends). */
export function suggestWindow(
  length: number,
  selected: number,
  max: number = SUGGEST_MAX_ROWS,
): { start: number; rows: number } {
  if (length <= 0) return { start: 0, rows: 0 };
  if (length <= max) return { start: 0, rows: length };
  const sel = Math.min(Math.max(selected, 0), length - 1);
  const start = Math.max(0, Math.min(sel - Math.floor(max / 2), length - max));
  return { start, rows: max };
}

export function SlashSuggest({ commands, selected }: {
  readonly commands: readonly SlashCommandInfo[];
  readonly selected: number;
}): React.JSX.Element | null {
  if (commands.length === 0) return null;
  const sel = Math.min(Math.max(selected, 0), commands.length - 1);
  const { start, rows } = suggestWindow(commands.length, sel);
  const visible = commands.slice(start, start + rows);
  const hidden = commands.length - (start + rows);
  return (
    <Box flexDirection="column">
      {visible.map((c, i) => {
        const isSelected = start + i === sel;
        return (
          <Text key={c.name} color={isSelected ? T.accent : undefined}>
            {isSelected ? "›" : " "}/{c.name}
            {c.args ? <Text dimColor>{`${c.name.endsWith(":") ? "" : " "}${c.isSensitive === true ? "<redacted>" : c.args}`}</Text> : null}
            {c.description ? <Text dimColor>{`  ${c.description}`}</Text> : null}
          </Text>
        );
      })}
      {/* ω99-169: 溢出行中文化（web InputBox.tsx 孪生同串）。 */}
      {hidden > 0 ? <Text dimColor>{`  … 还有 ${hidden} 项（↓ 滚动）`}</Text> : null}
    </Box>
  );
}
