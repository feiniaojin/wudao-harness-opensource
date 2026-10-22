// Streaming markdown renderer — the web mirror of the TUI's
// cli/src/tui/markdown.ts block/inline grammar (headings, fenced code,
// inline code, bold, lists, blockquotes, paragraphs), upgraded where the
// browser makes it free: fenced code gets the zero-dep highlighter
// (src/highlight.ts) and a language tag. 2026-08-26 spec §3.2 adds two
// web-only upgrades: GFM tables (a delimiter-rowed header line opens a
// <table> — wide tables scroll horizontally instead of folding the rail)
// and headings render WITHOUT the literal `#` prefix (the level rides
// data-level + CSS sizing). Live deltas now render markdown too, via
// StreamingMarkdown in LiveAnswer — a deliberate web deviation from the
// TUI's plain-text live answer, pinned byte-identical to the final render.
import React from "react";
import { highlightLine } from "./highlight.js";
// ω99-149: the shared clipboard helper (async API + silent degrade) — the
// same seam FileTree/HistoryList's 复制菜单项 ride, reused verbatim.
import { copyToClipboard } from "./components/ContextMenu.js";
// ω99-155: the desktop open_url seam for markdown links (scheme-gated on
// the Rust side); false in a browser → onLinkClick's window.open fallback.
import { tauriOpenUrl } from "./tauri-invoke.js";
// ω99-210: #2 — the pure lexer now lives in ./md-lex.ts (zero-import pure
// TS, moved byte-identical — see its header for why the pet window forced
// the split). This module re-exports the public lexer API verbatim so the
// seven importer test files (m72-markdown-perf / m72-history-collapse /
// ui-review-r7 / diff-view-highlight / markdown-diff / inkline-message /
// markdown-copy) evolve not at all, and the components below lex through
// the SAME module the pet window's light renderer (pet/pet-md.tsx) uses —
// one lexer, many renderers.
import { EMPTY_BLOCKS, getBlocks, parseInline, stableBoundary } from "./md-lex.js";
import type { Block } from "./md-lex.js";

export {
  getBlocks,
  hasMarkdownSyntax,
  markdownCacheStats,
  parseBlocks,
  parseInline,
  resetMarkdownCache,
  stableBoundary,
} from "./md-lex.js";
export type { MarkdownCacheStats } from "./md-lex.js";

/** ω99-155: the render-side mirror of the desktop open_url gate (main.rs
 * open_url_gate) — the grammar above accepts any whitespace-free url, but
 * only http(s) becomes an anchor: a `javascript:` href the model emitted is
 * never written into the DOM, let alone navigated (fail-closed, the same
 * scheme whitelist the Rust side enforces; refused links degrade to the
 * plain label text). */
function linkHrefOk(href: string): boolean {
  return href.startsWith("https://") || href.startsWith("http://");
}

/** ω99-155: link clicks NEVER navigate the webview (WKWebView's default
 * navigation is untrusted): preventDefault always runs, then the desktop
 * open_url command; false (non-Tauri or gate-refused) falls back to
 * window.open with noopener. A module-level handler, not a prop — Markdown/
 * StreamingMarkdown have no prop seam and every link shares one behavior. */
function onLinkClick(e: React.MouseEvent<HTMLAnchorElement>): void {
  e.preventDefault();
  const href = e.currentTarget.href;
  void tauriOpenUrl(href).then((ok) => {
    if (!ok) window.open(href, "_blank", "noopener");
  });
}

export function Inline({ s }: { s: string }): React.JSX.Element {
  return (
    <>
      {parseInline(s).map((sp, idx) =>
        sp.href !== undefined && linkHrefOk(sp.href)
          ? <a key={idx} href={sp.href} target="_blank" rel="noopener noreferrer" onClick={onLinkClick}>{sp.text}</a>
          : sp.code
            ? <code key={idx} className="inline">{sp.text}</code>
            : sp.bold
              ? <span key={idx} className="bold">{sp.text}</span>
              : <span key={idx}>{sp.text}</span>,
      )}
    </>
  );
}

// 墨线 §2 (task-6): the code-block head's data — `file` (the mono head's
// left segment) and `line` (its right L-n marker). Purely additive: absent
// meta renders NO head at all, the pre-inkline output shape.
export interface MarkdownMeta {
  readonly file?: string;
  readonly line?: number;
}

/* ω99-149: the copy overlay — one button per .pre, absolutely positioned
   top-right by CSS, NOT via .pre-head (the head renders only when meta
   carries a file — inkline pins bare blocks headless — so the button is a
   sibling overlay for both shapes; `has-pre-head` shifts it below the head
   so it never stacks over the L-n marker). Click copies the verbatim joined
   lines (no trim) through the shared helper and flashes「已复制 ✓」for
   1200ms; a re-click while lit re-copies (fire-and-forget, idempotent) and
   restarts the transient. M72's committed-prefix blocks never remount
   (append-only), so this local state is safe under streaming re-renders;
   the still-growing tail block copies what has arrived so far. */
function CodeBlock({ lang, lines, meta }: { lang?: string; lines: string[]; meta?: MarkdownMeta }): React.JSX.Element {
  const [done, setDone] = React.useState(false);
  const timer = React.useRef<number | undefined>(undefined);
  React.useEffect(() => () => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
  }, []);
  const onCopy = (): void => {
    copyToClipboard(lines.join("\n"));
    setDone(true);
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDone(false), 1200);
  };
  return (
    <div className={meta?.file !== undefined ? "pre has-pre-head" : "pre"}>
      {meta?.file !== undefined ? (
        <div className="pre-head">
          <span className="pre-file">{meta.file}</span>
          {meta.line !== undefined ? <span className="pre-ln">{`L${meta.line}`}</span> : null}
        </div>
      ) : null}
      <button type="button" className={done ? "pre-copy done" : "pre-copy"} aria-label="复制代码" onClick={onCopy}>{done ? "已复制 ✓" : "复制"}</button>
      <pre>
        <code>
          {lines.map((ln, j) => (
            <React.Fragment key={j}>
              {j > 0 ? "\n" : null}
              {highlightLine(ln, lang).map((t, k) =>
                t.cls === undefined ? t.text : <span key={k} className={t.cls}>{t.text}</span>,
              )}
            </React.Fragment>
          ))}
        </code>
      </pre>
    </div>
  );
}

// M72 §2 — the block renderer shared by <Markdown> and <StreamingMarkdown>:
// ONE implementation so the streaming path is byte-identical to the final
// path by construction (same elements, same keys, same order).
function renderBlocks(blocks: readonly Block[], meta?: MarkdownMeta): React.JSX.Element[] {
  return blocks.map((b, i) => {
    if (b.kind === "code") return <CodeBlock key={i} lang={b.lang} lines={b.lines} meta={meta} />;
    if (b.kind === "heading") {
      // 2026-08-26 §3.2: the level rides data-level (1-2 size up via CSS)
      // and the literal `#` prefix is gone — chat is prose, not a .md
      // source view.
      return <div key={i} className="md-heading" data-level={b.level}><Inline s={b.text} /></div>;
    }
    if (b.kind === "table") {
      return (
        <table key={i} className="md-table">
          <thead><tr>{b.header.map((h, j) => <th key={j}><Inline s={h} /></th>)}</tr></thead>
          <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}><Inline s={c} /></td>)}</tr>)}</tbody>
        </table>
      );
    }
    if (b.kind === "list") {
      return (
        <div key={i} className="md-list">
          {b.items.map((it, j) => <div key={j}>• <Inline s={it} /></div>)}
        </div>
      );
    }
    if (b.kind === "quote") {
      return (
        <div key={i} className="md-quote">
          {b.lines.map((ln, j) => <div key={j}>{`| ${ln}`}</div>)}
        </div>
      );
    }
    return (
      <div key={i} className="md-para">
        {b.lines.map((ln, j) => <div key={j}><Inline s={ln} /></div>)}
      </div>
    );
  });
}

// M72 §1 — memo(Markdown): history entries keep their object identity across
// streaming status frames, so a shallow-prop bail skips re-rendering every
// unchanged assistant message per delta; the LRU covers whatever still
// re-renders (remounts, new parents).
export const Markdown = React.memo(function Markdown({ source, meta }: { source: string; meta?: MarkdownMeta }): React.JSX.Element {
  return <div className="md">{renderBlocks(getBlocks(source), meta)}</div>;
});

interface StreamingLexState {
  /** The committed stable prefix (a string prefix of every later delta). */
  prefix: string;
  /** Blocks committed for the prefix, in order — appended, never re-lexed. */
  stable: Block[];
}

// The boundary only advances (monotonic), so the ref mutation during render
// is idempotent under a double-render: the first pass consumes the last seam
// of the current text, leaving a tail with no seam for the second pass (the upstream format
// relies on the same property for StrictMode). A source that no longer
// starts with the committed prefix (replacement, strip-prompts-style
// rewrites) resets to zero and re-lexes once — the upstream's startsWith guard.
//
// Mount point (2026-08-26 §3.2): LiveAnswer — the live answer now renders
// markdown mid-stream inside AssistantReply's card, a deliberate web
// deviation from the TUI's plain-text live answer. Byte-identity with the
// final <Markdown> render is what makes the swap safe: the same
// renderBlocks under both, and the streaming tests pin output ≡ <Markdown>
// for every complete text — when the delta tail closes, the committed
// blocks ARE the final blocks.
export function StreamingMarkdown({ source }: { source: string }): React.JSX.Element {
  const ref = React.useRef<StreamingLexState>({ prefix: "", stable: [] });
  const st = ref.current;
  if (!source.startsWith(st.prefix)) {
    st.prefix = "";
    st.stable = [];
  }
  const suffix = source.slice(st.prefix.length);
  const seam = stableBoundary(suffix);
  if (seam > 0) {
    st.stable = st.stable.concat(getBlocks(suffix.slice(0, seam)));
    st.prefix = source.slice(0, st.prefix.length + seam);
  }
  const tail = source.slice(st.prefix.length);
  const tailBlocks = tail === "" ? EMPTY_BLOCKS : getBlocks(tail);
  return <div className="md">{renderBlocks(st.stable.concat(tailBlocks))}</div>;
}
