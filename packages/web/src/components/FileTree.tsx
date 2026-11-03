// M74-ide §2 — FileTree: the IDE left panel. A lazy, cache-backed tree over
// the fileTree op: the root's first level loads on mount, a dir's children
// only on first expand (collapse KEEPS the cache — only a refresh clears
// it), and the expanded set survives refreshes so a reload refreshes
// content, never the user's place in the tree. Sorting is dirs-first-alpha
// (defensively re-run client-side), hidden entries (server-flagged OR
// name-matched: dotfiles, node_modules, __pycache__, dist, target) are
// filtered until the ☰ toggle opts in, and every file row carries a
// hover-revealed @ button that reports the WORKSPACE-RELATIVE path for the
// input box's mention state (spec §4 — the App wires that state machine).
//
// Selection: clicking a file reports it (single select — 墨线 T11: the
// active ROW carries .on, the wrapper keeps only the kind/modified marks);
// clicking a dir toggles expansion AND reports it with isDir=true, which is
// what makes the middle panel's directory-listing mode (spec §3) reachable
// through the same click. M75-ux1 §2: the tree-top is a workspace switcher —
// [📁 dirname ▾] with the full path in the tooltip; ▾ opens the recents
// dropdown (basename labels, max 5, the recentWorkspaces op's data) plus the
//「打开其他目录…」entry. workspace-ux B1: a pick re-roots the file PANEL
// (App routes it through panelRootSet — instant, busy-safe; the browser-mode
// notice survives only for the no-dialog-bridge case).
//
// M75-ux2 §5: every listing on the wire shows the spinner row (the
// expanding dir's children area, or the whole tree area for the initial
// root load), and a failed load renders the「加载失败 · 点击重试」row whose
// click re-fetches just that dir.
//
// M75-ux3 §7 — the filter: a small input under the tree-top live-filters
// the LOADED nodes (pure frontend, no ops): a file hides unless its name
// matches (case-insensitive substring), a dir stays while its own name OR
// any loaded descendant matches, and clearing restores the full listing.
// Unloaded dirs have nothing to match but their own names — the same
// "已展开+已缓存" boundary the Ctrl+P palette (§6) indexes.
import React, { useEffect, useRef, useState } from "react";
import type { FileOpsClient, FileTreeEntry } from "../file-ops.js";
import { sortTreeEntries } from "../file-ops.js";
import { useRecentWorkspaces } from "../use-recent-workspaces.js";
import { IconFolder, IconFolderOpen, IconFile, IconChevronRight, IconChevronDown, IconRefresh, IconMenu } from "./icons.js";
import { ContextMenu, copyToClipboard } from "./ContextMenu.js";
import type { ContextMenuItem } from "./ContextMenu.js";
// ω99-163: the reveal seam — the ω99-125 file card's same source
// (SimpleActivityCard): a null-safe desktop invoke, browser-silent.
import { tauriInvokeCommand } from "../tauri-invoke.js";

/** The spec §2 default-hidden set beyond dotfiles (the server's hidden flag
 *  is trusted but re-derived — a stale or lenient reply stays filtered). */
const HIDDEN_NAMES = new Set(["node_modules", "__pycache__", "dist", "target"]);

/** An entry stays out of the tree until the ☰ toggle opts in. */
function isHiddenEntry(e: { readonly name: string; readonly hidden?: boolean }): boolean {
  return e.hidden === true || e.name.startsWith(".") || HIDDEN_NAMES.has(e.name);
}

/** One directory's cached listing ("" = the root). */
interface DirState {
  readonly entries: readonly FileTreeEntry[];
  readonly error: string | null;
}

/** M75-ux1 §2: the switcher label — the path's LAST segment (spec §2 当前
 *  目录名=路径最后一段; the full path rides the tooltip). A path with no
 *  separator stands in as-is (the display-only "工作区" placeholder). */
function baseName(path: string): string {
  const parts = path.split("/").filter((p) => p !== "");
  return parts[parts.length - 1] ?? path;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Join a parent's relative path with a child basename ("" + name = name). */
function joinRel(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

/** ω99-163: 右键「在访达中显示」的绝对路径——树持工作区相对路径，
 * join 面板根；连接前的「工作区」占位窗（非 / 开头）返回 null（点击静默
 * no-op，与 SimpleActivityCard 的浏览器态同姿——垫片自静默，无特判）。 */
function absPathFor(root: string, rel: string): string | null {
  if (!root.startsWith("/")) return null;
  const trimmed = rel.replace(/^\/+/, "");
  return trimmed === "" ? root : `${root}/${trimmed}`;
}

/** ω99-163: 右键 reveal 项——reveal_path 经 null-safe 垫片（ω99-125
 *  交付物卡片同缝）；占位根/浏览器态静默 no-op，菜单项始终可见。 */
const revealInFinder = (root: string, rel: string): void => {
  const abs = absPathFor(root, rel);
  if (abs !== null) void tauriInvokeCommand("reveal_path", { path: abs });
};

/** M75-ux2 §5: the inline loading row — a CSS-animated dot plus the label,
 *  shown while a listing is on the wire (an expanding dir's children area,
 *  or the whole tree area on the initial root load). */
function TreeLoading(): React.JSX.Element {
  return (
    <div className="tree-loading" role="status">
      <span className="tree-spin" aria-hidden={true} />
      加载中…
    </div>
  );
}

/** M75-ux2 §5: the failed-load row — the raw message in the tooltip, the
 *  retry affordance in the row itself (one click re-fetches just this dir).
 *  ui-review-r1 I3: role="button" without tabIndex/keys was mouse-only —
 *  Enter/Space now retry too. */
function TreeError({ message, onRetry }: { message: string; onRetry: () => void }): React.JSX.Element {
  return (
    <div
      className="tree-err"
      role="button"
      tabIndex={0}
      title={message}
      onClick={onRetry}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onRetry();
        }
      }}
    >
      加载失败 · 点击重试
    </div>
  );
}

export function FileTree({ client, workspaceRoot, bootRoot, selectedPath, onSelect, onAtMention, refreshKey, onSwitchWorkspace, onOpenOtherWorkspace, onPathsChange, modifiedPaths, modifiedKey, onManualRefresh }: {
  client: FileOpsClient;
  workspaceRoot: string;
  /** 138 续（2026-11-03 用户令）：boot 根（会话锚）——树顶菜单「默认空间」
   * 钉项的落点。可选：缺席/未解析 → 钉项不渲染，普通树挂载照常编译。 */
  bootRoot?: string;
  selectedPath: string | null;
  /** The selected RELATIVE path (plus isDir so the App can route the middle
   *  panel); handlers that ignore the second arg still typecheck. */
  onSelect(path: string, isDir?: boolean): void;
  onAtMention(path: string): void;
  /** Bump to wipe every cached listing and reload (the manual ⟳ button
   *  bumps an internal counter through the same path). */
  refreshKey: number;
  /** M75-ux1 §2: a recent-workspace pick. workspace-ux B1: App routes it
   *  through panelRootSet — the panel re-roots instantly and the driver
   *  records the recents row (no separate write op). Optional so plain-tree
   *  mounts keep compiling; the menu entry no-ops without it. */
  onSwitchWorkspace?(path: string): void;
  /** M75-ux1 §2: the「打开其他目录…」pick — App opens the Tauri directory
   *  dialog (no bridge in a plain browser → the CLI notice) and routes the
   *  pick through the same panel re-root. */
  onOpenOtherWorkspace?(): void;
  /** M75-ux3 §6: the Ctrl+P palette's index feed — every loaded listing's
   *  paths (root + cached dirs, walked) on each cache change. Optional so
   *  the M74 suites' mounts stay valid. */
  onPathsChange?: (paths: readonly string[]) => void;
  /** M76-ux2 §1: the agent-modified paths (the App watcher's collected
   *  write_file/edit_file summaries) — a matching FILE row takes the accent
   *  marker (class `modified`). Optional so plain-tree mounts keep
   *  compiling. */
  modifiedPaths?: ReadonlySet<string>;
  /** M76-ux2 §1: App bumps this counter with every set mutation — the SET
   *  object is a stable ref, so the key is the re-render guarantee.
   *  Accepted for the contract (and any future memo boundary), not read
   *  here. */
  modifiedKey?: number;
  /** M76-ux2 §1: the manual ⟳ fired — the App clears its marker set. An
   *  agent-driven refresh (refreshKey) keeps the marks; only the user's
   *  ⟳ clears. Optional so plain-tree mounts keep compiling. */
  onManualRefresh?(): void;
}): React.JSX.Element {
  const [tree, setTree] = useState<ReadonlyMap<string, DirState>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const [manualRefresh, setManualRefresh] = useState(0);
  // M75-ux3 §7: the live tree filter — "" renders everything.
  const [filter, setFilter] = useState("");
  // M75-ux1 §2: the switcher dropdown — the open flag; the recents ride the
  // shared useRecentWorkspaces hook (fetch on OPEN, never on mount — a
  // closed menu costs no ops; null = nothing loaded yet).
  const [wsMenu, setWsMenu] = useState(false);
  const recents = useRecentWorkspaces(client, wsMenu);
  // M76-ux2 §6: the right-click menu — the pointer position + the node it
  // opened on (path + kind drive the items). One menu at a time; closing is
  // the ContextMenu's own contract (item click / backdrop / Esc).
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; path: string; isDir: boolean } | null>(null);
  // Latest-value refs: the load effect keys on the refresh identity ONLY —
  // a new client object or a mid-flight expansion set must not restart it.
  const clientRef = useRef(client);
  clientRef.current = client;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const loadDir = (rel: string): void => {
    clientRef.current.fileTree(rel).then(
      (r) => setTree((m) => new Map(m).set(rel, { entries: sortTreeEntries(r.entries), error: null })),
      (e) => setTree((m) => new Map(m).set(rel, { entries: [], error: errText(e) })),
    );
  };

  // Mount + every refresh (prop key or manual): wipe the caches, then
  // reload the root AND every currently-expanded dir in parallel — the
  // expansion set itself is never touched here.
  const effKey = `${refreshKey}#${manualRefresh}`;
  useEffect(() => {
    let cancelled = false;
    setTree(new Map());
    const dirs = [...expandedRef.current];
    void Promise.all(
      ["", ...dirs].map(async (p): Promise<[string, DirState]> => {
        try {
          const r = await clientRef.current.fileTree(p);
          return [p, { entries: sortTreeEntries(r.entries), error: null }];
        } catch (e) {
          return [p, { entries: [], error: errText(e) }];
        }
      }),
    ).then((pairs) => {
      if (!cancelled) setTree(new Map(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [effKey]);

  const toggleDir = (rel: string): void => {
    const isOpen = expanded.has(rel);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (isOpen) next.delete(rel);
      else next.add(rel);
      return next;
    });
    if (!isOpen && !tree.has(rel)) loadDir(rel); // lazy: fetch on first expand only
    // M75-ux2 §4: a dir click BOTH toggles the subtree AND reports the path
    // with isDir=true — every click, open or collapse. The App's tab dedupe
    // by path turns the repeat click into "collapse the subtree, keep the
    // tab" (spec: collapse the subtree without closing the tab).
    onSelect(rel, true);
  };

  // M76-ux2 §6: the per-kind right-click items — both kinds copy the
  // workspace-relative path; a file can @-mention into the composer or open
  // in the viewer, a dir opens its listing (the middle panel's dir mode).
  // ω99-163: both kinds append the Finder-reveal item LAST (locate through
  // the panel root) — append-last keeps every index click drift-free.
  const ctxMenuItems = (path: string, isDir: boolean): ContextMenuItem[] =>
    isDir
      ? [
          { label: "复制路径", onSelect: () => copyToClipboard(path) },
          { label: "在 viewer 打开目录列表", onSelect: () => onSelect(path, true) },
          { label: "在访达中显示", onSelect: () => revealInFinder(workspaceRoot, path) },
        ]
      : [
          { label: "复制路径", onSelect: () => copyToClipboard(path) },
          { label: "@-mention 到输入", onSelect: () => onAtMention(path) },
          { label: "在 viewer 打开", onSelect: () => onSelect(path, false) },
          { label: "在访达中显示", onSelect: () => revealInFinder(workspaceRoot, path) },
        ];

  // M75-ux3 §7: one entry's filter verdict — a name match, or (dirs only)
  // any MATCHING loaded descendant keeps the ancestor chain visible.
  const filterQuery = filter.trim().toLowerCase();
  const matchesFilter = (e: FileTreeEntry, rel: string): boolean => {
    if (e.name.toLowerCase().includes(filterQuery)) return true;
    if (e.type !== "dir") return false;
    const st = tree.get(rel);
    return st !== undefined && st.entries.some((k) => matchesFilter(k, joinRel(rel, k.name)));
  };

  // M75-ux3 §6: report the loaded-path index whenever a listing lands (or
  // the refresh wipes one) — the walk covers the root plus every CACHED
  // dir, so a collapsed-but-fetched dir's children stay searchable while
  // an untouched dir contributes only its own name.
  useEffect(() => {
    if (onPathsChange === undefined) return;
    const paths: string[] = [];
    const walk = (parentRel: string, entries: readonly FileTreeEntry[]): void => {
      for (const e of entries) {
        const rel = joinRel(parentRel, e.name);
        paths.push(rel);
        const st = e.type === "dir" ? tree.get(rel) : undefined;
        if (st !== undefined) walk(rel, st.entries);
      }
    };
    const rootState = tree.get("");
    if (rootState !== undefined && rootState.error === null) walk("", rootState.entries);
    onPathsChange(paths);
  }, [tree, onPathsChange]);

  const renderNodes = (entries: readonly FileTreeEntry[], parentRel: string, depth: number): React.JSX.Element[] =>
    entries
      .filter((e) => showHidden || !isHiddenEntry(e))
      .filter((e) => filterQuery === "" || matchesFilter(e, joinRel(parentRel, e.name)))
      .map((e) => {
        const rel = joinRel(parentRel, e.name);
        const isDir = e.type === "dir";
        const isOpen = isDir && expanded.has(rel);
        const kids = isDir && isOpen ? tree.get(rel) : undefined;
        // M76-ux2 §1: the agent-modified marker — files the agent wrote/edited
        // this epoch (dirs never carry it).
        const modified = !isDir && (modifiedPaths?.has(rel) ?? false);
        // ui-review-r1 I3: the row's gesture, shared by click and keys.
        const activate = (): void => {
          if (isDir) toggleDir(rel);
          else onSelect(rel, false);
        };
        return (
          <div
            key={e.name}
            className={`tree-node ${e.type}${modified ? " modified" : ""}`}
            data-path={rel}
          >
            <div
              className={`ft-row${selectedPath === rel ? " on" : ""}`}
              role="button"
              tabIndex={0}
              // I3: plain divs with onClick were mouse-only — Enter/Space
              // (Space's scroll default suppressed) ride the same handler.
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  activate();
                }
              }}
              onClick={activate}
              // M76-ux2 §6: right-click opens the node's self-drawn menu at
              // the pointer (preventDefault keeps the native one hidden).
              onContextMenu={(ev) => {
                ev.preventDefault();
                setCtxMenu({ x: ev.clientX, y: ev.clientY, path: rel, isDir });
              }}
            >
              {/* 墨线 T11: depth rides repeated .ft-indent spans (one per
                  level, --sp-3 wide) — the old inline paddingLeft
                  arithmetic is gone. */}
              {Array.from({ length: depth }, (_, i) => (
                <span key={i} className="ft-indent" />
              ))}
              <span className="caret">{isDir ? (isOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />) : null}</span>
              <span className="ico">{isDir ? (isOpen ? <IconFolderOpen size={14} /> : <IconFolder size={14} />) : <IconFile size={14} />}</span>
              <span className="name">{e.name}</span>
              {isDir ? null : (
                <button
                  type="button"
                  className="at-btn"
                  title={`@ ${rel}`}
                  onClick={(ev) => {
                    ev.stopPropagation(); // mention, not select
                    onAtMention(rel);
                  }}
                >
                  @
                </button>
              )}
            </div>
            {isDir && isOpen ? (
              <div className="kids">
                {kids === undefined ? (
                  <TreeLoading />
                ) : kids.error !== null ? (
                  <TreeError message={kids.error} onRetry={() => loadDir(rel)} />
                ) : (
                  renderNodes(kids.entries, rel, depth + 1)
                )}
              </div>
            ) : null}
          </div>
        );
      });

  const rootState = tree.get("");
  return (
    <div className="filetree">
      <div className="tree-top">
        {/* M75-ux1 §2: the workspace switcher — [📁 dirname ▾], full path in
            the tooltip; ▾ toggles the recents dropdown below. */}
        <button
          type="button"
          className="ws-switcher"
          title={workspaceRoot}
          aria-haspopup="menu"
          aria-expanded={wsMenu}
          onClick={() => setWsMenu((v) => !v)}
        >
          <span className="tree-root"><IconFolder size={14} /> {baseName(workspaceRoot)} <IconChevronDown size={12} /></span>
        </button>
        <button
          type="button"
          className="tree-toggle"
          aria-pressed={showHidden}
          aria-label={showHidden ? "隐藏隐藏项" : "显示隐藏项"}
          title={showHidden ? "隐藏隐藏项" : "显示隐藏项"}
          onClick={() => setShowHidden((v) => !v)}
        >
          <IconMenu size={14} />
        </button>
        <button
          type="button"
          className="tree-refresh"
          aria-label="刷新"
          title="刷新"
          onClick={() => {
            setManualRefresh((k) => k + 1);
            onManualRefresh?.(); // M76-ux2 §1: the user's ⟳ clears the agent-modified marks
          }}
        >
          <IconRefresh size={14} />
        </button>
        {wsMenu ? (
          <>
            {/* The click-away surface: a transparent fixed layer under the
                menu closes it on any outside click. */}
            <div className="ws-backdrop" onClick={() => setWsMenu(false)} />
            <div className="ws-menu" role="menu">
              {/* 138 续：默认空间钉在 recents 之上（chip 同款契约）——一键
                  回会话锚，面板与 agent 根同走 onSwitchWorkspace 缝。 */}
              {bootRoot !== undefined && bootRoot !== "" ? (
                <button
                  type="button"
                  className="ws-item ws-default"
                  role="menuitem"
                  title={bootRoot}
                  onClick={() => {
                    setWsMenu(false);
                    onSwitchWorkspace?.(bootRoot);
                  }}
                >
                  默认空间 · {baseName(bootRoot)}
                </button>
              ) : null}
              {(recents ?? []).map((w) => (
                <button
                  key={w.path}
                  type="button"
                  className="ws-item"
                  role="menuitem"
                  title={w.path}
                  onClick={() => {
                    setWsMenu(false);
                    onSwitchWorkspace?.(w.path);
                  }}
                >
                  {baseName(w.path)}
                </button>
              ))}
              {recents === null ? <div className="ws-loading">加载中…</div> : null}
              {/* A2 landed the Tauri dialog pick; a plain browser (no invoke
                  bridge) keeps the CLI-restart notice on the App side. */}
              <button
                type="button"
                className="ws-item ws-open-other"
                role="menuitem"
                onClick={() => {
                  setWsMenu(false);
                  onOpenOtherWorkspace?.();
                }}
              >
                打开其他目录…
              </button>
            </div>
          </>
        ) : null}
      </div>
      {/* M75-ux3 §7: the live filter — hides non-matching LOADED nodes while
          typing; dirs survive on their own name or any matching descendant. */}
      <div className="tree-filter">
        <input
          type="text"
          value={filter}
          placeholder="过滤…"
          aria-label="过滤文件树"
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="tree-body">
        {rootState === undefined ? (
          <TreeLoading />
        ) : rootState.error !== null ? (
          <TreeError message={rootState.error} onRetry={() => loadDir("")} />
        ) : rootState.entries.length === 0 ? (
          // ui-review-r1 P7: a loaded-but-empty root gets its empty state —
          // the previously dead .tree-empty class's own home.
          <div className="tree-empty" role="status">空目录</div>
        ) : (
          renderNodes(rootState.entries, "", 0)
        )}
      </div>
      {/* M76-ux2 §6: the node's right-click menu — files get 复制路径 /
          @-mention 到输入 / 在 viewer 打开; dirs get 复制路径 / 在 viewer 打开
          目录列表 (the middle panel's dir mode through the same onSelect
          (path, true) the click gesture uses). ω99-163: both append the
          Finder-reveal item (reveal_path with the panel root joined on). */}
      {ctxMenu !== null ? (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxMenuItems(ctxMenu.path, ctxMenu.isDir)}
          onClose={() => setCtxMenu(null)}
        />
      ) : null}
    </div>
  );
}
