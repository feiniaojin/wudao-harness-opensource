// ω-1b — the loop-level generic large-result guard (goose
// crates/goose/src/agents/large_response_handler.rs:5-14, digest 98a). M46
// gave shell its own head/tail + spill shaping (200 lines / 10KB), but
// every OTHER tool's oversized string result — web_fetch pages, grep floods,
// custom/MCP tools — still entered context whole. This module is the LOOP's
// uniform backstop: over looser generic thresholds (1000 lines / 50KB,
// exported below) any string result is shaped head/tail around an omission
// marker with the FULL text spilled for read_file paging — reusing the M46
// primitives verbatim (shapeLongOutput / omissionMarker / guidance) so the
// two guards share one output dialect.
//
// The spill rides the M24 seam exactly as shell.ts and web-fetch.ts
// wire it (.wudao/spill/<session>/, sha256 content-hash name, mkdir -p +
// sync write, best-effort): a failed write means NO shaping — the raw result
// passes through (M46's fail-open fallback doctrine). The sync-fs closure is
// deliberately a sibling copy rather than a refactor of those tools' private
// ones — each module stays self-confined and this change stays additive.
//
// read_file is exempt by M24's standing clause ("read_file 不限长"): it IS
// the paging primitive every other spill points at — shaping its results
// would hide the very bytes the model spills things to go read. Exemptions
// are a tool-NAME list so the loop can check before calling in (the pure
// function below never sees the name).
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { needsLongOutputShaping, shapeLongOutput, type LongOutputConfig } from "./long-output.js";

/** Tools whose results are never generically shaped. M24's read_file clause
 *  is the entire list today; self-shaping tools (shell M46, the
 *  monitor payload shaper) sit far under these thresholds, so the backstop
 *  never double-shapes in practice. */
export const UNSHAPED_TOOLS: readonly string[] = ["read_file"];

/** The generic (deliberately loose) thresholds + shaping window: 5× M46's
 *  line threshold, 5× its byte threshold — a generous "this no longer belongs
 *  inline" line, not a tight budget. */
export const DEFAULT_GENERIC_RESULT_CONFIG: LongOutputConfig = {
  lineThreshold: 1_000,
  byteThreshold: 50_000,
  headLines: 100,
  tailLines: 100,
};

/** What the loop injects. `spillDir` absent → shaping OFF entirely (the M46
 *  config-absent kill-switch pattern: no injected session spill directory,
 *  no generic backstop — behavior is byte-identical to pre-ω-1b). */
export interface GenericResultShaping {
  readonly spillDir?: string;
  readonly config?: LongOutputConfig;
}

/** Spill the FULL raw text (shell.ts's exact seam: recursive mkdir,
 *  sha256-16 content-hash name so identical results share one file, sync
 *  write; any failure → undefined = fail-open). */
function spillTo(dir: string, raw: string): string | undefined {
  try {
    mkdirSync(dir, { recursive: true });
    const name = `${createHash("sha256").update(raw).digest("hex").slice(0, 16)}.txt`;
    const path = join(dir, name);
    writeFileSync(path, raw, "utf8");
    return path;
  } catch {
    return undefined;
  }
}

/** Shape one tool result string. undefined = pass the raw through unchanged
 *  (under threshold, no spillDir injected, spill write failed, or nothing
 *  omittable at line granularity — shapeLongOutput's own bounds). The loop
 *  applies this to STRING results only; structured payloads are not this
 *  guard's business and pass through untouched. */
export function shapeGenericToolResult(
  raw: string,
  shaping: GenericResultShaping = {},
): { shaped: string } | undefined {
  if (shaping.spillDir === undefined) return undefined;
  const config = shaping.config ?? DEFAULT_GENERIC_RESULT_CONFIG;
  if (!needsLongOutputShaping(raw, config)) return undefined;
  const spillPath = spillTo(shaping.spillDir, raw);
  if (spillPath === undefined) return undefined;
  const shaped = shapeLongOutput({ raw, config, spillPath });
  return shaped === undefined ? undefined : { shaped };
}
