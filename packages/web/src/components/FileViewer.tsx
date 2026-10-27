// M74-ide §3 — FileViewer: the IDE middle panel. One fetch per (path,
// isDir): a file renders through highlight.ts's per-line token pipeline
// with a numbered left gutter; a dir renders its entries table off the
// same fileTree op; a null path is the centered empty state. Big files
// (>100KB or server-truncated) cap at 2000 rendered lines with the tail
// notice. Binary → a placeholder card. .md → Markdown-rendered by default.
import { IconFolder, IconFile, IconClose } from "./icons.js";
import { TokenSpans } from "./Tokens.js";
import { CodeEditor } from "./CodeEditor.js";
import { languageFromPath } from "../highlight.js";
// 截断 notice; binary results render the placeholder card and never touch
// the token pipeline; a rejected read (the server's sensitive-path /
// escape / size refusals) surfaces its message instead of blanking — the
// server is the security boundary, the viewer only renders or reports.
//
// M75-ux2 §8: a 24px breadcrumb strip rides the top of the panel (below
// the App's tab bar) — the path's segments separated by /, every DIR
// prefix clickable (onOpenPath(path, true) — the App turns it into a dir
// tab), the current segment accent-marked and inert. §11: a .md file
// renders through the shared Markdown component by default (预览) with a
//「源码/预览」toggle at the breadcrumb bar's right end; the mode resets to
// 预览 on every path switch.
import React, { useEffect, useState } from "react";
import { Markdown } from "../markdown.js";
import type { FileOpsClient, FileReadResult, FileTreeEntry } from "../file-ops.js";
import { sortTreeEntries } from "../file-ops.js";
// ω99-148: the selection→ask A layer (pure DOM, zero React).
import { buildEditAsk, readSelection } from "./viewer-selection.js";
import { Icon } from "./Icon.js";

/** The spec §3 display caps: >100KB (or a truncated reply) shows the first
 *  2000 lines plus the tail notice. */
const BIG_BYTES = 100 * 1024;
const MAX_LINES = 2000;

type ViewState =
  | { s: "loading" }
  | { s: "file"; r: FileReadResult }
  | { s: "dir"; entries: readonly FileTreeEntry[] }
  | { s: "error"; message: string };

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The .md detection for §11's preview mode (spec names the extension). */
const isMarkdownPath = (path: string): boolean => path.endsWith(".md");

/** Split into renderable lines; one trailing newline is a terminator, not
 *  a phantom empty line. */
function splitLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function FileViewer({ client, path, isDir, onOpenPath, onReadFailed, refreshEpoch, onClose, onPrefill }: {
  client: FileOpsClient;
  /** Workspace-relative path (null = nothing selected yet). */
  path: string | null;
  isDir: boolean;
  /** M75-ux2 §8: a breadcrumb dir-prefix click — the App opens (or
   *  activates) the dir's tab. Optional so bare mounts still typecheck. */
  onOpenPath?(path: string, isDir: boolean): void;
  /** ui-review-r3 P2: a fetch for THIS path REJECTED (the target is gone, or
   *  the server refused it). The App rides it to drop a persisted tab whose
   *  target no longer exists — optional so bare mounts still typecheck. */
  onReadFailed?(path: string): void;
  /** ui-review-r4 I3: the history epoch the App keys refetches on. The fetch
   *  effect's key was [client, path, isDir] — after a reconnect-resubscribe
   *  the viewer kept rendering the STALE pre-drop content while the banner
   *  implied recovery. A reset:true replay (reconnect / clear / resume)
   *  bumps this and the open tab refetches. Optional so bare mounts
   *  (and the pre-r4 callers) keep typechecking; absent = never refetch. */
  refreshEpoch?: number;
  /** 墨线 T11: the head's × — the App routes it to its tab close (the same
   *  handler the tabbar's own × rides). Optional so bare mounts keep
   *  typechecking; absent = the button renders inert until wired. */
  onClose?(): void;
  /** ω99-148: 选中修改 — the「改这段」chip's ride into the composer. The App
   *  wires the SAME /edit draft seam the hero chips ride (M63 §D:
   *  onPrefill → setEditDraft → InputBox applies + clears). Absent = the
   *  host declines the capability: selections stay chip-less, silently. */
  onPrefill?(text: string): void;
}): React.JSX.Element {
  const [state, setState] = useState<ViewState>({ s: "loading" });
  // M75-ux2 §11: the .md render mode — 预览 by default, re-armed per open
  // (the reset rides the per-open effect below, one source of truth).
  const [mdMode, setMdMode] = useState<"preview" | "source">("preview");
  // 高亮/编辑 spec §4: the edit session — value/base 双份（base 是 CAS 的
  // 底），conflict 携磁盘当前内容，selfEpoch 触发保存后的重读刷新。
  const [edit, setEdit] = useState<{ base: string; value: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [editErr, setEditErr] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [selfEpoch, setSelfEpoch] = useState(0);
  // ω99-148: the live 选中修改 payload — the A-layer read plus the rect the
  // chip floats at and the path the ask cites (a path switch refetches and
  // clears this). null = no chip.
  const [sel, setSel] = useState<{ path: string; first: number; last: number; text: string; x: number; y: number } | null>(null);

  // The per-open resets ride the OPEN key (the fetch key minus selfEpoch):
  // a save's own selfEpoch refetch must re-read WITHOUT wiping the 已保存
  // receipt it just posted, and .md 编辑退出 restores mdMode (退出恢复) —
  // so these resets must not fire on the save-refetch. A path switch /
  // refreshEpoch reconnect / client swap resets everything as before.
  useEffect(() => {
    if (path === null) return; // the empty state resets nothing
    setMdMode("preview"); // §11: every open starts in 预览
    setEdit(null); setConflict(null); setEditErr(null); setSavedNote(null);
  }, [client, path, isDir, onReadFailed, refreshEpoch]);

  useEffect(() => {
    if (path === null) return; // the empty state fetches nothing
    let cancelled = false;
    setState({ s: "loading" });
    setSel(null); // ω99-148: a path switch / refetch retires the pending selection ask
    if (isDir) {
      client.fileTree(path).then(
        (r) => {
          if (!cancelled) setState({ s: "dir", entries: sortTreeEntries(r.entries) });
        },
        (e) => {
          if (!cancelled) {
            setState({ s: "error", message: errText(e) });
            onReadFailed?.(path);
          }
        },
      );
    } else {
      client.fileRead(path).then(
        (r) => {
          if (!cancelled) setState({ s: "file", r });
        },
        (e) => {
          if (!cancelled) {
            setState({ s: "error", message: errText(e) });
            onReadFailed?.(path);
          }
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [client, path, isDir, onReadFailed, refreshEpoch, selfEpoch]);

  // M75-ux2 §8: the breadcrumb — segments of the workspace-relative path;
  // every prefix except the last is a DIR the click opens as a tab.
  const segs = path === null ? [] : path.split("/").filter((p) => p !== "");
  const showMdToggle = path !== null && !isDir && isMarkdownPath(path) && state.s === "file" && state.r.binary !== true && edit === null;
  // 墨线 T11: the head's close chip — one shell, every non-empty state.
  const closeBtn = (
    <button type="button" className="fv-close" aria-label="关闭" title="关闭" onClick={() => onClose?.()}>
      <IconClose size={14} />
    </button>
  );

  let body: React.JSX.Element;
  if (path === null) {
    body = <div className="viewer-empty">从左侧选择文件查看内容</div>;
  } else if (state.s === "loading") {
    body = <div className="viewer-empty">加载中…</div>;
  } else if (state.s === "error") {
    body = (
      <>
        <div className="fv-head">
          <span className="fv-file">{path}</span>
          {closeBtn}
        </div>
        <div className="viewer-err"><Icon name="triangle-alert" size={13} /> {state.message}</div>
      </>
    );
  } else if (state.s === "dir") {
    body = (
      <>
        <div className="fv-head">
          <span className="fv-file">{path}</span>
          {closeBtn}
        </div>
        <div className="viewer-dirwrap">
          <table className="viewer-dir">
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>大小</th>
              </tr>
            </thead>
            <tbody>
              {state.entries.map((e) => (
                <tr key={e.name}>
                  <td className="viewer-entry-name">{e.type === "dir" ? <><IconFolder size={14} /> {e.name}</> : <><IconFile size={14} /> {e.name}</>}</td>
                  <td>{e.type === "dir" ? "目录" : "文件"}</td>
                  <td>{e.type === "file" && e.size !== undefined ? `${e.size} bytes` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  } else {
    const r = state.r;
    if (r.binary === true) {
      body = (
        <>
          <div className="fv-head">
            <span className="fv-file">{path}</span>
            {closeBtn}
          </div>
          <div className="viewer-binary">{`二进制文件 · ${r.totalBytes} bytes · 不支持预览`}</div>
        </>
      );
    } else {
      const big = r.truncated || r.totalBytes > BIG_BYTES;
      const lines = splitLines(r.content);
      const shown = big ? lines.slice(0, MAX_LINES) : lines;
      // 门控（spec §4）: 非二进制（外层分支已担保——binary 走占位卡）∧ 非截断
      // ∧ 客端带 fileWrite。可编辑 ⇒ 内容必是全文（fileRead 只在 >1MB 截断，
      // 100KB 显示帽更严）。
      const canEdit = !big && client.fileWrite !== undefined;
      const enterEdit = (): void => {
        setEdit({ base: r.content, value: r.content });
        setConflict(null);
        setEditErr(null);
        setSavedNote(null);
      };
      // ω99-148: the read-only selection bridge — on mouseup read the live
      // Selection through the A layer; a payload only lands when BOTH
      // endpoints sit on lines and onPrefill is wired. The chip floats at
      // the range rect's top-right; jsdom rects are all-zero (tolerated —
      // the chip still renders at 0,0; nothing pins coordinates).
      const onCodeMouseUp = (e: React.MouseEvent<HTMLDivElement>): void => {
        if (onPrefill === undefined || path === null) {
          setSel(null);
          return;
        }
        const s = window.getSelection();
        const payload = readSelection(e.currentTarget, s);
        if (payload === null) {
          setSel(null); // collapsed / outside / whitespace-only — no chip
          return;
        }
        let x = 0;
        let y = 0;
        try {
          const rect = s?.getRangeAt(0).getBoundingClientRect();
          x = rect?.right ?? 0;
          y = rect?.top ?? 0;
        } catch {
          /* jsdom rectlessness — all-zero stands in */
        }
        setSel({ ...payload, path, x, y });
      };
      const doSave = (base: string): void => {
        if (edit === null || path === null || client.fileWrite === undefined) return;
        setSaving(true);
        client.fileWrite(path, edit.value, base).then(
          (res) => {
            setSaving(false);
            if ("written" in res) {
              setSavedNote(`已保存 ${path} · ${edit.value.split("\n").length} 行`);
              setEdit(null);
              setConflict(null);
              setEditErr(null);
              setSelfEpoch((n) => n + 1); // spec §4: 重读刷新
            } else {
              setConflict(res.current);
            }
          },
          (e) => {
            setSaving(false);
            setEditErr(errText(e));
          },
        );
      };
      body = (
        <>
          <div className="fv-head">
            <span className="fv-file">{path}</span>
            {edit === null && canEdit ? (
              <button type="button" className="fv-btn" onClick={enterEdit}>编辑</button>
            ) : null}
            {closeBtn}
          </div>
          {savedNote !== null && edit === null ? <div className="fv-saved">{savedNote}</div> : null}
          {edit !== null ? (
            <>
              {editErr !== null ? <div className="viewer-err"><Icon name="triangle-alert" size={13} /> {editErr}</div> : null}
              <CodeEditor
                path={path}
                value={edit.value}
                language={languageFromPath(path) ?? r.language}
                dirty={edit.value !== edit.base}
                saving={saving}
                conflict={conflict}
                onChange={(v) => setEdit({ ...edit, value: v })}
                onSave={() => doSave(edit.base)}
                onOverwrite={() => doSave(conflict ?? edit.base)}
                onReopen={(cur) => { setEdit({ base: cur, value: cur }); setConflict(null); setEditErr(null); }}
                onDiscard={() => { setEdit(null); setConflict(null); setEditErr(null); }}
              />
            </>
          ) : showMdToggle && mdMode === "preview" ? (
            <div className="viewer-md">
              <Markdown source={r.content} />
            </div>
          ) : (
            <>
              <div className="viewer-code" onMouseUp={onCodeMouseUp}>
                {shown.map((ln, i) => (
                  <div className="viewer-line" key={i} data-line={i + 1}>
                    <span className="viewer-gutter">{i + 1}</span>
                    <span className="viewer-src">
                      <TokenSpans text={ln} lang={languageFromPath(path) ?? r.language} />
                    </span>
                  </div>
                ))}
              </div>
              {sel !== null && onPrefill !== undefined ? (
                // ω99-148: the floating ask chip — the ask rides the /edit
                // draft seam; the live selection and the chip itself clear
                // after the prefill (v1 单选区即清).
                <button
                  type="button"
                  className="fv-selchip"
                  style={{ left: `${sel.x}px`, top: `${sel.y}px` }}
                  onClick={() => {
                    onPrefill(buildEditAsk(sel.path, sel.first, sel.last, sel.text));
                    try {
                      window.getSelection()?.removeAllRanges();
                    } catch {
                      /* jsdom tolerance */
                    }
                    setSel(null);
                  }}
                >
                  改这段
                </button>
              ) : null}
              {big ? (
                <div className="viewer-truncated">{`截断:文件 ${r.totalBytes} bytes,仅显示前 ${MAX_LINES} 行`}</div>
              ) : null}
            </>
          )}
        </>
      );
    }
  }

  return (
    <div className="fileviewer">
      {path === null ? null : (
        <div className="breadcrumb">
          {segs.map((seg, i) => {
            const current = i === segs.length - 1;
            const dirPath = segs.slice(0, i + 1).join("/");
            return (
              <React.Fragment key={dirPath}>
                {i > 0 ? <span className="crumb-sep">/</span> : null}
                {current ? (
                  <span className="crumb current" aria-current="page">
                    {seg}
                  </span>
                ) : (
                  <span
                    className="crumb"
                    role="button"
                    tabIndex={0}
                    title={dirPath}
                    // ui-review-r1 I3: role="button" without tabIndex/keys was
                    // mouse-only — Enter/Space open the dir tab too.
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onOpenPath?.(dirPath, true);
                      }
                    }}
                    onClick={() => onOpenPath?.(dirPath, true)}
                  >
                    {seg}
                  </span>
                )}
              </React.Fragment>
            );
          })}
          {showMdToggle ? (
            <span className="md-toggle">
              <button
                type="button"
                className="mdmode"
                data-mode="source"
                aria-pressed={mdMode === "source"}
                title="渲染后的 markdown 源码"
                onClick={() => setMdMode("source")}
              >
                源码
              </button>
              <button
                type="button"
                className="mdmode"
                data-mode="preview"
                aria-pressed={mdMode === "preview"}
                title="markdown 渲染预览"
                onClick={() => setMdMode("preview")}
              >
                预览
              </button>
            </span>
          ) : null}
        </div>
      )}
      {body}
    </div>
  );
}
