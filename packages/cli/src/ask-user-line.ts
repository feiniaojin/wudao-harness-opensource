// M34 §1 — the line-prompt shape the REPL and the one-shot CLI use for
// ask_user: the printed prompt (question + numbered options) and the mapping
// of one typed answer line to the final answer (a bare in-range number picks
// that option's label; anything else is the free-text answer, verbatim).
import type { AskUserOption } from "@wudao/core";

/** The full text shown before the answer line is read. */
export function formatAskUserPrompt(question: string, options?: readonly AskUserOption[]): string {
  const lines = [`❓ ${question}`];
  if (options !== undefined && options.length > 0) {
    for (const [i, opt] of options.entries()) {
      lines.push(`  ${i + 1}) ${opt.label}${opt.description !== undefined && opt.description !== "" ? ` — ${opt.description}` : ""}`);
    }
    lines.push(`answer [1-${options.length} or free text]: `);
  } else {
    lines.push("answer: ");
  }
  return lines.join("\n");
}

/** A bare number within range selects that option's label; any other line is
 *  the user's free-text answer (trimmed). */
export function mapAskUserLine(line: string, options?: readonly AskUserOption[]): string {
  const trimmed = line.trim();
  if (options !== undefined && options.length > 0 && /^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (n >= 1 && n <= options.length) return options[n - 1]?.label ?? trimmed;
  }
  return trimmed;
}
