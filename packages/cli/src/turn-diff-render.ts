// 夜移 032 (codex turn_diff_tracker.rs render half) — the net-diff renderer
// over the core tracker's ledger. Rendering lives in the cli (not core)
// because the LCS engine already lives here (M32's file-changes prober) —
// one diff implementation, two consumers. Output is git-style: per file a
// `--- a/… +++ b/…` header (created files carry a `new file` marker and no
// a-side), unified hunks with 3 context lines, files separated by one blank
// line, whole detail byte-capped with an explicit truncation marker (never a
// silent drop). The preview line rides the run's notice text; the full diff
// rides the notice detail.
import { unifiedDiffBody } from "./file-changes.js";
import { formatTurnDiffPreview, type TurnDiffFile } from "@wudao-org/core";

export interface TurnDiffRender {
  /** The notice preview line ("" for an empty ledger). */
  readonly text: string;
  /** The full git-style diff ("" for an empty ledger); byte-capped. */
  readonly detail: string;
  /** How many files the ledger carried. */
  readonly fileCount: number;
  /** True when the detail hit the byte cap. */
  readonly truncated: boolean;
  /** ω99-288: #4 — 每文件 +M/−K 行计数，与 files（台账序）同序：从
   *  unifiedDiffBody 的 hunk 累计 +/− 行——数据层算，绝不解析已渲染的
   *  detail 文本（216 裁定的正道），因此 8KB 帽截 detail 不改计数。
   *  identical-net 文件（listed-no-hunks）计 0/0；空台账为空数组。 */
  readonly counts: readonly { readonly plus: number; readonly minus: number }[];
}

export const TURN_DIFF_DETAIL_CAP_BYTES = 8 * 1024;

/** Marker allowance on top of the cap (the marker itself must fit). */
const TRUNCATION_MARKER = "…（净变更 diff 已按 8KB 截断——/rewind 可见完整历史）";

export function renderTurnDiff(
  files: readonly TurnDiffFile[],
  rel: (absPath: string) => string,
  options?: { readonly maxBytes?: number },
): TurnDiffRender {
  const cap = options?.maxBytes ?? TURN_DIFF_DETAIL_CAP_BYTES;
  const text = formatTurnDiffPreview(files, rel);
  if (files.length === 0) return { text: "", detail: "", fileCount: 0, truncated: false, counts: [] };

  // ω99-288（续，标记见上）— per-file +/− counts from the SAME unifiedDiffBody hunks the
  // detail renders below (one entry per ledger file, same order — the driver
  // zips them into the receipt's changes). Computed BEFORE the byte-cap loop:
  // counts describe the ledger's full net change, never the capped text.
  const counts = files.map((f) => {
    let plus = 0;
    let minus = 0;
    for (const hunk of unifiedDiffBody(f.before ?? "", f.after)) {
      for (const line of hunk.split("\n")) {
        if (line.startsWith("+")) plus += 1;
        else if (line.startsWith("-")) minus += 1;
      }
    }
    return { plus, minus };
  });

  const blocks: string[] = [];
  let used = 0;
  let truncated = false;
  for (const f of files) {
    const lines: string[] = [];
    const name = rel(f.path);
    if (f.before === f.after) continue; // identical net: listed in preview, no hunks
    if (f.before === undefined) {
      lines.push(`diff --git a/${name} b/${name}`, "new file", `--- /dev/null`, `+++ b/${name}`);
    } else {
      lines.push(`diff --git a/${name} b/${name}`, `--- a/${name}`, `+++ b/${name}`);
    }
    for (const hunk of unifiedDiffBody(f.before ?? "", f.after)) {
      lines.push(...hunk.split("\n"));
    }
    const block = lines.join("\n");
    const cost = Buffer.byteLength(block, "utf8") + (blocks.length > 0 ? 2 : 0);
    if (used + cost > cap) {
      truncated = true;
      break;
    }
    used += cost;
    blocks.push(block);
  }
  const detail = blocks.length > 0
    ? blocks.join("\n\n") + (truncated ? `\n\n${TRUNCATION_MARKER}` : "")
    : truncated ? TRUNCATION_MARKER : "";
  return { text, detail, fileCount: files.length, truncated, counts };
}
