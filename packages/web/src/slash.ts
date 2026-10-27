// Slash-command helpers — the web mirror of cli/src/slash-commands.ts's pure
// half. The DATA is the server's (the listSlashCommands op returns the same
// SlashCommandInfo rows every frontend shares); these functions reproduce the
// token/filter/complete/help rules so the web menu behaves like the TUI's.
/** Where a command row comes from (the driver's listSlashCommands data). */
export type SlashSource = "builtin" | "skill" | "plugin" | "extension";

/** Mirrors the driver's SlashCommandInfo (the listSlashCommands op's result). */
export interface SlashCommandInfo {
  /** The completable token (no leading slash): "help", "skill:alpha". */
  readonly name: string;
  /** One-line description (menu dim text / help body). */
  readonly description: string;
  /** Display-only usage suffix: "<goal>" (completion inserts the name). */
  readonly args?: string;
  /** M53 §4: arguments are sensitive — the suggestion menu previews them as
   *  `<redacted>` instead of the args template. */
  readonly isSensitive?: boolean;
  /** M53 §4: executes immediately even while a run is in flight (read-only,
   *  model-independent commands bypass the steering queue). */
  readonly immediate?: boolean;
  /** Every source that defines this name (the parse-priority winner leads). */
  readonly sources?: readonly string[];
  readonly source: SlashSource;
}

/** The menu's token for a line: the text after "/" while the user is still
 *  typing the command word (no whitespace yet). Undefined = no menu. */
export function slashToken(line: string): string | undefined {
  if (!line.startsWith("/")) return undefined;
  const rest = line.slice(1);
  return /\s/.test(rest) ? undefined : rest;
}

/** Prefix filter (inline prefix — no fuzzy, no substring). */
export function filterSlashCommands(
  commands: readonly SlashCommandInfo[],
  token: string,
): readonly SlashCommandInfo[] {
  return commands.filter((c) => c.name.startsWith(token));
}

/** Complete a slash line to the selected command (the token has no
 *  whitespace by construction, so the replacement is the whole line). */
export function completeSlashLine(line: string, name: string): string {
  return `/${name}`;
}

/** Display form of one command: "/plan <goal>", "/skill:name [args]".
 *  M53 §4: a sensitive command's args preview as `<redacted>`. */
export function slashDisplay(cmd: SlashCommandInfo): string {
  if (cmd.args === undefined) return `/${cmd.name}`;
  const sep = cmd.name.endsWith(":") ? "" : " ";
  return `/${cmd.name}${sep}${cmd.isSensitive === true ? "<redacted>" : cmd.args}`;
}

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

/** /help rendered FROM the listSlashCommands data — the web keys line is the
 *  web's own (Enter to send · Shift+Enter new line · Esc interrupt ·
 *  Shift+Tab cycles mode). ui-review-r4 I4: the App-level chords were listed
 *  nowhere — the keys block gains ONE chord line so Ctrl+P/Ctrl+B/Ctrl+\ /
 *  Cmd+, / Ctrl+W / Ctrl+Tab / Ctrl+1-9 are discoverable from /help itself
 *  (中文单词表·双端同步保 parity——ω99-162 起，先例反转自 ui-review-r4 I4 的英文镜像裁定). */
export function formatSlashHelp(
  commands: readonly SlashCommandInfo[],
  opts: { readonly mode?: string } = {},
): string {
  const lines = ["命令："]; // ω99-162: 骨架头中文化（与 cli formatSlashHelp 同一副词表保 parity）。
  for (const c of commands) lines.push(`  ${slashDisplay(c)}${c.description ? `  ${c.description}` : ""}`);
  // ω99-162: 键位两行中文化（键名 token 与模式链标识符原样；描述词与 161 TUI 键位族同源）。
  lines.push("键位：");
  lines.push("  Enter 发送 · Shift+Enter 换行 · ↑↓ 翻历史 · / 命令 · @ 提及文件 · Esc 中断 · shift+tab 切模式 (workspace → ask → auto)");
  lines.push("  Ctrl+P 文件搜索 · Ctrl+B 左栏 · Ctrl+\\ 中栏 · Cmd/Ctrl+, 设置 · Ctrl+W 关标签页 · Ctrl+Tab 切标签页 · Ctrl+1-9 跳标签页");
  if (opts.mode !== undefined) lines.push(`模式：${opts.mode}`); // ω99-162: mode 行头中文化（mode 标识符原样）。
  return lines.join("\n");
}
