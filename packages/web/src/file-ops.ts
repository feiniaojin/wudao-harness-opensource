// M74-ide §5/§6 — the data-panel ops' client port. Task 1 lands the server
// side and with it the WudaoClient methods + the protocol.ts mirror of these
// shapes; until that merge the IDE panels depend on this STRUCTURAL slice
// instead (any object with the two methods satisfies it — the tests' mocks
// included), and a post-merge WudaoClient satisfies it by structural typing
// with zero adapter code. The result shapes below hand-mirror spec §5.
//
// Path convention (spec §5): every path is RELATIVE to the workspace root,
// "" = the root itself; the server's resolveWorkspacePath is the security
// boundary (escape/sensitive/size rejections happen there, the panels only
// render what comes back or the rejected error).

/** One fileTree entry (basename + kind; the server pre-marks hidden). */
export interface FileTreeEntry {
  readonly name: string;
  /** "file" | "dir" */
  readonly type: "file" | "dir";
  /** Bytes (files only). */
  readonly size?: number;
  /** Dotfile / matched the hidden list server-side. */
  readonly hidden?: boolean;
}

/** fileTree's result — the server sorts dirs-first-alpha before replying. */
export interface FileTreeResult {
  readonly entries: ReadonlyArray<FileTreeEntry>;
}

/** fileRead's result (spec §5): UTF-8 text with the server's truncation
 *  flags; binary:true means content is "" and the viewer shows the
 *  placeholder card instead of reading. */
export interface FileReadResult {
  readonly content: string;
  readonly truncated: boolean;
  readonly totalBytes: number;
  /** Total lines pre-truncation. */
  readonly lines: number;
  /** Detected from the extension, "text" fallback. */
  readonly language: string;
  readonly binary?: boolean;
}

/** M75-ux1 §2: the workspace switcher's recents row (the ▾ menu's data;
 *  hand-mirrors the protocol's recentWorkspaces result). */
export interface RecentWorkspace {
  readonly path: string;
  /** ISO timestamp — JSON has no Date. */
  readonly lastUsed: string;
}

/** The fileWrite reply (高亮/编辑 spec §3): written, or the conflict shape
 *  with the disk content's 100KB-capped prefix (nothing written). */
export type FileWriteResult =
  | { readonly written: true }
  | { readonly conflict: true; readonly current: string };

/** The structural slice of WudaoClient both IDE panels consume. */
export interface FileOpsClient {
  fileTree(path: string): Promise<FileTreeResult>;
  fileRead(path: string): Promise<FileReadResult>;
  /** M75-ux1 §2: the recents list (max 5, most-recent-first); with `add` the
   *  path is unshifted + persisted server-side first. OPTIONAL like the
   *  server port's method — a client (or mock) without it degrades the ▾ menu
   *  to the 打开其他目录… entry only. */
  recentWorkspaces?(add?: string): Promise<{ readonly workspaces: ReadonlyArray<RecentWorkspace> }>;
  /** 高亮/编辑 spec §3: the viewer's save. OPTIONAL like the server port's
   *  method — a client (or mock) without it hides the 编辑 button. */
  fileWrite?(path: string, content: string, base: string): Promise<FileWriteResult>;
}

/** Dirs first (alpha), then files (alpha). The server already sorts — the
 *  tree re-sorts defensively (spec §2) so an unsorted reply can never leak
 *  into the DOM. Pure, shared by the tree and the viewer's dir listing. */
export function sortTreeEntries<T extends { readonly name: string; readonly type: "file" | "dir" }>(
  entries: readonly T[],
): T[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}
