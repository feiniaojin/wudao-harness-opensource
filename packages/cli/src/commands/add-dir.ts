// M55 §C1 — /add-dir: extend the session's workspace boundary. Accepts a
// path (absolute or relative to cwd), validates it exists, records it as a
// session entry (added_dir), and extends the file-tools' workspace boundary.
// No duplicates; /status shows the added dirs. Pure validation + formatting.
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";

/** The session entry type for added directories. */
export const ADDED_DIR_TYPE = "added_dir";

export interface AddedDirData {
  /** The absolute path of the added directory. */
  readonly path: string;
  /** ISO timestamp when it was added. */
  readonly at: string;
}

export type AddDirValidation =
  | { readonly ok: true; readonly absPath: string }
  | { readonly ok: false; readonly error: string };

/** Validate a path argument: resolve vs cwd, check existence, ensure no
 *  duplicates. Returns the absolute path on success. */
export function validateAddDirPath(args: {
  readonly input: string;
  readonly cwd: string;
  readonly existingPaths: readonly string[];
}): AddDirValidation {
  const trimmed = args.input.trim();
  if (trimmed === "") {
    return { ok: false, error: "路径不能为空" }; // ω99-177: #1
  }
  const absPath = resolve(args.cwd, trimmed);
  // Check existence
  if (!existsSync(absPath)) {
    return { ok: false, error: `路径不存在：${trimmed}` }; // ω99-177: #2
  }
  // Check for duplicates
  for (const existing of args.existingPaths) {
    if (existing === absPath) {
      return { ok: false, error: `路径已添加过：${trimmed}` }; // ω99-177: #3
    }
  }
  return { ok: true, absPath };
}

/** Build the session entry for an added directory. */
export function buildAddedDirEntry(absPath: string): { readonly type: string; readonly data: AddedDirData } {
  return {
    type: ADDED_DIR_TYPE,
    data: { path: absPath, at: new Date().toISOString() } satisfies AddedDirData,
  };
}

/** Format the /add-dir success notice. */
export function formatAddDirNotice(args: { readonly absPath: string; readonly count: number }): string {
  return `已添加工作区目录：${args.absPath}（共 ${args.count} 个工作区目录）`; // ω99-177: #4（复数三元随删——中文无复数）
}

/** Format the added-dirs section for /status. */
export function formatAddedDirsList(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  const list = paths.map((p) => `  - ${p}`).join("\n");
  return `工作区目录（${paths.length} 个）：\n${list}`; // ω99-177: #5
}
