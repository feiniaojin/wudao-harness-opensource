// Shared output caps for list-shaped tools (glob/grep): 2000 lines / 50KB,
// whichever fires first — the same budget read_file's default window uses.
// Truncation appends a deterministic tail note so the model knows the output
// was capped (suffix minimization with an honest marker).
export const OUTPUT_MAX_LINES = 2000;
export const OUTPUT_MAX_BYTES = 50 * 1024;

/** Cap to whole lines, backing off so the byte cap never cuts mid-line. */
export function capOutputLines(
  text: string,
  maxLines: number = OUTPUT_MAX_LINES,
  maxBytes: number = OUTPUT_MAX_BYTES,
): string {
  if (text.length <= maxBytes) return text;
  const lines = text.split("\n");
  let kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const cost = line.length + (kept.length > 0 ? 1 : 0);
    if (kept.length >= maxLines || bytes + cost > maxBytes) break;
    kept.push(line);
    bytes += cost;
  }
  const dropped = lines.length - kept.length;
  return `${kept.join("\n")}\n… (${dropped} more line${dropped === 1 ? "" : "s"} — output capped at ${maxLines} lines / ${Math.round(maxBytes / 1024)}KB)`;
}
