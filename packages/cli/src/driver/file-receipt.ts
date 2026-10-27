// ω99-125 — 交付物文件卡, the pure extractor. make_xlsx/make_pptx/make_docx
// finish with a receipt (doc-xlsx.ts / doc-pptx.ts / doc-docx.ts execute
// tails): 中文一句 + "\n" + JSON.stringify({path, relativePath, rows|slides|
// blocks, bytes}) — the JSON is ALWAYS the last line, by construction. This
// module pulls that structured line out so the driver can land it on the
// tool history entry as `file` (the web renders the deliverable card from it).
//
// NAME-GATED, never a generic JSON sniff: only make_xlsx/make_pptx/make_docx
// results are inspected, so no other tool's JSON-tailed output can ever grow
// a card (predictable, fail-closed, no false positives). Future deliverable
// tools join FILE_RECEIPT_TOOLS by name. Pure and total: every mismatch
// returns undefined, nothing ever throws.
//
// ω99-125 设计出处（prep 钉）：name=basename(relativePath)；rows/slides/
// blocks/columns 等多余键忽略不进 wire；bytes 正 finite number 才收。
// ω99-126 控制器补充指令：make_docx joins the gate（docx 交付物同权成卡）。
// ω99-236: #4 — the gate's name list now rides the doc-suite ROSTER
// (DOC_SUITE_RECEIPT_TOOLS——名册模块 doc-suite.ts 的回执面名册，grep 亲验
// 与原九名逐字同集：make×3+append×3+replace×3，无读面)。从「逐名硬编码」
// 变「名册展开」，展开后内容等值（tests/omega99-236-doc-suite.test.ts R1(e)
// 钉）；名册静态消费——off 态名册惰性在册（缺席名无害），出处注释全数保留。
import { DOC_SUITE_RECEIPT_TOOLS } from "../doc-suite.js";

/** The tools whose receipts carry a deliverable file (the name gate).
 *  ω99-223: #9 — append_docx / append_pptx join the gate: they modify the
 *  user's named file (more deliverable-shaped than a fresh make — the user
 *  pointed at THIS file), and their execute tails land the same receipt shape
 *  (中文一句 + JSON last line with path/relativePath/bytes), so the file card
 *  lands on them identically. session-recap's filesTouched is NOT a second
 *  list — it derives from the landed `file` field (composeRecapStats), so one
 *  seam here carries both (一处缝，如实记).
 *  ω99-228: #5 — append_xlsx joins the gate the same way (223 #9 precedent,
 *  identical receipt shape: 中文一句 + JSON last line).
 *  ω99-229: #4 — replace_docx / replace_pptx join the gate the same way (223
 *  #9 / 228 #5 precedent, identical receipt shape: 中文一句 + JSON last line).
 *  ω99-231: #4 — replace_xlsx joins the gate the same way (223 #9 / 228 #5 /
 *  229 #4 precedent, identical receipt shape: 中文一句 + JSON last line). */
// ω99-314: 导出供 snapshots.ts 推导快照触发工具集（一处名册两处受益——
// 223 #9 先例；集合内容不变，仅可见性放开）。
export const FILE_RECEIPT_TOOLS: ReadonlySet<string> = new Set([...DOC_SUITE_RECEIPT_TOOLS]);

/** The landed deliverable: enough for the web card (name + size) and the
 *  reveal button (absolute path). Extra receipt keys stay behind. */
export interface ToolFileReceipt {
  readonly path: string;
  readonly name: string;
  readonly bytes: number;
}

/**
 * Extract the deliverable receipt from a finished tool result. Returns
 * undefined for every non-gated tool name, every result whose last
 * non-blank line is not the receipt JSON, and every shape mismatch
 * (missing/empty path or relativePath, non-positive-finite bytes,
 * empty basename). Never throws.
 */
export function extractFileReceipt(toolName: string, result: string): ToolFileReceipt | undefined {
  if (!FILE_RECEIPT_TOOLS.has(toolName)) return undefined;
  // The receipt's JSON is the last line by construction; trailing blank
  // lines (a defensive no-op) must not hide it — scan from the end.
  let last = "";
  let end = -1;
  for (let i = result.length - 1; i >= 0; i--) {
    const ch = result[i];
    if (end === -1) {
      if (ch === "\n" || ch === " " || ch === "\t" || ch === "\r") continue;
      end = i;
    } else if (ch === "\n") {
      last = result.slice(i + 1, end + 1);
      break;
    }
  }
  if (last === "" && end !== -1) last = result.slice(0, end + 1); // single-line result
  if (last === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const { path, relativePath, bytes } = parsed as Record<string, unknown>;
  if (typeof path !== "string" || path === "") return undefined;
  if (typeof relativePath !== "string" || relativePath === "") return undefined;
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return undefined;
  // basename over both separators (receipts are workspace-relative; a
  // trailing separator leaves an empty LAST segment — fail closed, no card).
  const segs = relativePath.split(/[\\/]/);
  const name = segs[segs.length - 1] ?? "";
  if (name === "") return undefined;
  return { path, name, bytes };
}
