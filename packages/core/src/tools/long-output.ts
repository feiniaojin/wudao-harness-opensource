// M46 §2 — long-output head/tail shaping for shell. When combined
// stdout+stderr crosses the threshold (lines OR bytes), the inline result
// keeps the FIRST headLines and LAST tailLines with an omission marker
// between them; the FULL raw output spills to disk (the M24 seam,
// .wudao/spill/<session>/) so read_file can page through it (2000 lines /
// 50KB + offset — the spill file obeys the same rules as any file).
//
// The tail matters more than the head: errors and exit diagnostics land at
// the END of a build log. The pre-M46 behavior (byte-cap head + spill note)
// remains the fallback — when shaping is off (config absent, env kill
// switch) or when the spill write fails, shell behaves exactly as
// before.
export interface LongOutputConfig {
  /** Shape when the output has more lines than this. Default 200. */
  readonly lineThreshold: number;
  /** Shape when the output exceeds this many bytes. Default 10_000. */
  readonly byteThreshold: number;
  /** Head lines kept in the shaped result. Default 50. */
  readonly headLines: number;
  /** Tail lines kept in the shaped result. Default 50. */
  readonly tailLines: number;
}

export const DEFAULT_LONG_OUTPUT: LongOutputConfig = {
  lineThreshold: 200,
  byteThreshold: 10_000,
  headLines: 50,
  tailLines: 50,
};

/** Omission marker body — the spill path rides in the middle. */
export function omissionMarker(omittedLines: number, spillPath: string): string {
  return `... [省略 ${omittedLines} 行,完整输出已保存至 ${spillPath}] ...`;
}

/** The read-back guidance line (spec wording). */
export const LONG_OUTPUT_GUIDANCE = "如需完整输出,用 read_file 读取该文件";

/** Shaping receipt — h<head>/t<tail> + the spilled line count. */
export function shapedReceipt(config: LongOutputConfig, omittedLines: number): string {
  return `[shaped h${config.headLines}/t${config.tailLines}, +${omittedLines} lines spilled]`;
}

/** Text lines in raw (a trailing newline does not open a phantom line). */
function textLineCount(lines: readonly string[]): number {
  return lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

/** True when the output crosses EITHER threshold (lines or bytes). */
export function needsLongOutputShaping(raw: string, config: LongOutputConfig): boolean {
  if (raw.length > config.byteThreshold) return true;
  return textLineCount(raw.split("\n")) > config.lineThreshold;
}

/** Shape raw into head + omission marker + tail + guidance + receipt.
 *  Returns undefined when shaping cannot omit anything (output under
 *  threshold, or thresholds so small that head+tail covers every line —
 *  including the single-giant-line byte case, where line-granularity
 *  shaping has nothing to cut). */
export function shapeLongOutput(args: {
  readonly raw: string;
  readonly config: LongOutputConfig;
  readonly spillPath: string;
}): string | undefined {
  const { raw, config, spillPath } = args;
  if (!needsLongOutputShaping(raw, config)) return undefined;
  const lines = raw.split("\n");
  const total = textLineCount(lines);
  const omitted = total - config.headLines - config.tailLines;
  if (omitted <= 0) return undefined;
  const head = lines.slice(0, config.headLines);
  const tail = lines.slice(total - config.tailLines, total);
  return [
    ...head,
    omissionMarker(omitted, spillPath),
    ...tail,
    LONG_OUTPUT_GUIDANCE,
    shapedReceipt(config, omitted),
  ].join("\n");
}
