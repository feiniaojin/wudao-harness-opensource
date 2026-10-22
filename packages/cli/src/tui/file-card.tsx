// ω99-131 — TUI 交付物文件卡：the terminal's render of the deliverable
// receipt the driver already lands on tool history entries (ω99-125 `file`).
// The old shape showed the raw receipt — 中文句 + a JSON line — as one dim
// preview line: the JSON polluted the screen and never said WHERE the file
// is or HOW to open it. This card replaces that line (app.tsx wires it):
// type mark + name + honest KB, the receipt's human sentence, and the
// absolute path plus the open hint (打开 = the system default application,
// the same semantics as the web card's 打开 button, ω99-129). Pure and
// stateless — an ink function component, no effects; `file` is optional on
// the wire, so its absence must (and does) leave every other entry's render
// byte-identical (the zero-drift pin).
import React from "react";
import { Box, Text } from "ink";
import { T } from "./theme.js";

/** The deliverable the driver extracts (file-receipt.ts ToolFileReceipt) —
 *  path=absolute, name=basename, bytes=positive finite. */
export interface FileCardFile {
  readonly path: string;
  readonly name: string;
  readonly bytes: number;
}

/** ω99-131: the deliverable's type mark, derived in the RENDER layer from
 *  the name's extension (the same derivation rule as the web card — the
 *  driver lands only path/name/bytes on the wire). Exported for tests. */
export function fileIconOf(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith(".xlsx")) return "📊";
  if (n.endsWith(".docx")) return "📄";
  if (n.endsWith(".pptx")) return "📽️";
  return "📦";
}

/** ω99-131: one decimal KB, the receipt's own size format — the card and
 *  the receipt sentence must never disagree about the same file. */
export function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** The card: three lines under the tool row —
 *  1. `▣ <icon> <name>（<KB>）` in the accent color (the deliverable IS the
 *     turn's headline, not quiet structure);
 *  2. the receipt's human sentence (note), dim — kept because it carries
 *     the 行×列 shape the JSON line would otherwise hold;
 *  3. `位置：<abs path>　打开：open "<name>"`, dim — the path is copyable
 *     as-is; 打开 names the system default application (open on macOS,
 *     the terminal's own verb, so the user can act on it right there).
 *  User language only — no extractor/receipt/entry terms on the face. */
export function FileCard({ file, note }: { file: FileCardFile; note?: string }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text color={T.accent}>{`▣ ${fileIconOf(file.name)} ${file.name}（${formatKb(file.bytes)}）`}</Text>
      {note ? <Text dimColor>{`  ${note}`}</Text> : null}
      <Text dimColor>{`  位置：${file.path}　打开：open "${file.name}"`}</Text>
    </Box>
  );
}
