// ω99-210: #1 — the pure markdown lexer, extracted BYTE-IDENTICAL from
// markdown.tsx (comments included): the lexer becomes the single source of
// truth shared by the main window's renderer (markdown.tsx) and the pet
// window's light renderer (pet/pet-md.tsx). Why a zero-import pure-TS
// module: the pet window is its own Tauri webview whose module graph must
// stay free of the main UI (pet-root.test.tsx pins the App/WS boundary;
// pet/main.tsx's head comment pins the intent), and markdown.tsx drags
// highlight.js + ContextMenu — so the shared seam is this file and nothing
// heavier. markdown.tsx re-exports the public lexer API verbatim; its seven
// importer test files evolve not at all. ONE lexer, MANY renderers — a
// later face (TUI etc.) that needs markdown rides this same seam. Only
// deltas from the moved source: `export` added on Block and EMPTY_BLOCKS
// (markdown.tsx consumes both); every other line untouched.
export type Block =
  | { kind: "code"; lang?: string; lines: string[] }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "para"; lines: string[] };

// M72 §1 — the lex cache front end (research 38 §1, CC's Markdown.tsx):
// parseBlocks is the hot cost on every parent re-render (a streaming status
// frame re-renders the whole history column per delta) and on unmount→remount
// (mode swap, settings-page swap) — useMemo survives neither history-array
// churn nor remounts. Messages are immutable in history, so same content →
// same blocks: a module-level LRU keyed by content hash makes both re-render
// paths a lookup. The syntax fast-path below skips the lexer entirely for
// plain text. Contract: getBlocks(source) ≡ parseBlocks(source) — the cache
// and fast path change WORK, never output (tests pin this against the
// parseBlocks oracle).

/** One combined probe (single regex pass, not per-marker indexOf chains):
 * any occurrence of `#`/`*`/backtick/`>`/pipe/`[` anywhere, or a `-` at a
 * line start followed by whitespace, is a necessary condition for every
 * construct in our grammar (fence/heading/list/quote/bold/inline-code/table
 * — the 2026-08-26 table's necessary marker is the pipe; the ω99-155 inline
 * link's is the opening bracket). Absence of all markers therefore PROVES
 * the text is plain — the fast path is exact, not an approximation. A
 * bracket-bearing plain line (`arr[0]`) now takes the lexer path once and
 * lexes to the same output (the inline grammar does not match it). COUPLED
 * to parseBlocks (review F3): new grammar constructs must extend this
 * regex — parseBlocks carries the mirror warning. */
const MD_SYNTAX_RE = /[#*`>|\[]|^\s*-\s/m;
/** CC samples the first 500 chars ("if markdown exists it's usually early")
 * and accepts mis-rendering late syntax in long texts; our milestone
 * contract is byte-identical output, so the tail beyond the sample is probed
 * too (still one cheap linear scan, and short messages never pay for it). */
const SYNTAX_PROBE_CHARS = 500;

export function hasMarkdownSyntax(s: string): boolean {
  if (s.length <= SYNTAX_PROBE_CHARS) return MD_SYNTAX_RE.test(s);
  return (
    MD_SYNTAX_RE.test(s.slice(0, SYNTAX_PROBE_CHARS)) || MD_SYNTAX_RE.test(s.slice(SYNTAX_PROBE_CHARS))
  );
}

/** FNV-1a 32-bit — fast, tiny, and collision-safe here: entries store the
 * source they were built from, so a colliding key is detected by string
 * equality and re-lexed (the hash only routes, never trusts). */
function hashContent(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const BLOCK_CACHE_MAX = 500;
interface CachedBlocks {
  readonly source: string;
  readonly blocks: readonly Block[];
}
const blockCache = new Map<number, CachedBlocks>(); // insertion order = LRU order

const stats = {
  lexRuns: 0,
  lexChars: 0,
  cacheHits: 0,
  cacheMisses: 0,
  fastPathSkips: 0,
  evictions: 0,
};

/** The plain-text fast path: builds the paragraph blocks parseBlocks would
 * build (blank-line runs split paragraphs; syntax cannot occur — the probe
 * proved it) without the per-line syntax walk. Deliberately NOT cached: the
 * rebuild is a couple of allocations, and caching would retain the content
 * twice for zero repeated-lex saving (CC's rationale, and ours). */
function plainParagraphBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  for (const line of source.split("\n")) {
    if (line.trim() === "") {
      if (para.length > 0) {
        blocks.push({ kind: "para", lines: para });
        para = [];
      }
    } else {
      para.push(line);
    }
  }
  if (para.length > 0) blocks.push({ kind: "para", lines: para });
  return blocks;
}

export interface MarkdownCacheStats {
  readonly size: number;
  readonly lexRuns: number;
  readonly lexChars: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly fastPathSkips: number;
  readonly evictions: number;
}

export function markdownCacheStats(): MarkdownCacheStats {
  return { size: blockCache.size, ...stats };
}

/** Test/debug seam: the cache is module-level shared state, so suites reset
 * it for isolation (production never calls this). */
export function resetMarkdownCache(): void {
  blockCache.clear();
  stats.lexRuns = 0;
  stats.lexChars = 0;
  stats.cacheHits = 0;
  stats.cacheMisses = 0;
  stats.fastPathSkips = 0;
  stats.evictions = 0;
}

export function getBlocks(source: string): readonly Block[] {
  if (!hasMarkdownSyntax(source)) {
    stats.fastPathSkips += 1;
    return plainParagraphBlocks(source);
  }
  const key = hashContent(source);
  const hit = blockCache.get(key);
  if (hit !== undefined) {
    if (hit.source === source) {
      blockCache.delete(key);
      blockCache.set(key, hit); // bump to most-recently used
      stats.cacheHits += 1;
      return hit.blocks;
    }
    // Hash collision with different content — fall through and replace.
  }
  stats.cacheMisses += 1;
  stats.lexRuns += 1;
  stats.lexChars += source.length;
  const blocks = parseBlocks(source);
  blockCache.delete(key);
  blockCache.set(key, { source, blocks });
  if (blockCache.size > BLOCK_CACHE_MAX) {
    const oldest = blockCache.keys().next().value;
    if (oldest !== undefined) blockCache.delete(oldest);
    stats.evictions += 1;
  }
  return blocks;
}

// GRAMMAR/PROBE COUPLING (review F3): every block/inline construct added
// here MUST contribute its necessary marker to MD_SYNTAX_RE above — the
// fast path proves text plain by marker-absence, so a construct whose
// markers the probe cannot see would be swallowed into a plain paragraph
// instead of parsed (the getBlocks ≡ parseBlocks oracle tests in
// tests/m72-markdown-perf.test.tsx are the tripwire; this comment is the
// source-side warning).

/** 2026-08-26 §3.2 — GFM tables: a row line is any `|`-carrying non-blank
 * text; a DELIMITER row is only `|`/`:`/`-`/whitespace with at least one
 * dash and one pipe (`| --- |`, `---|:---:|` — `- item` never qualifies:
 * no pipe). tableStartAt is the exact open condition parseBlocks and the
 * para terminator share, so a table can open right after prose or a
 * heading with no blank line between (the real model-output shape:
 * `## ✅ 结果` immediately followed by the header row). */
function isDelimRow(line: string): boolean {
  return /^[|:\-\s]+$/.test(line) && line.includes("-") && line.includes("|");
}
function tableStartAt(lines: readonly string[], i: number): boolean {
  const cur = lines[i] ?? "";
  return cur.includes("|") && cur.trim() !== "" && isDelimRow(lines[i + 1] ?? "");
}
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

export function parseBlocks(source: string): Block[] {
  const lines = source.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim() || undefined;
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        body.push(lines[i] ?? "");
        i++;
      }
      i++; // closing fence
      blocks.push({ kind: "code", lang, lines: body });
      continue;
    }
    if (tableStartAt(lines, i)) {
      const header = splitRow(line);
      i += 2; // header row + delimiter row
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim() !== "") {
        rows.push(splitRow(lines[i] ?? ""));
        i++;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    if (/^#{1,4}\s/.test(line)) {
      const level = line.match(/^#+/)?.[0]?.length ?? 1;
      blocks.push({ kind: "heading", level, text: line.replace(/^#+\s*/, "") });
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "list", items });
      continue;
    }
    if (/^>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? "")) {
        q.push((lines[i] ?? "").replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ kind: "quote", lines: q });
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() !== ""
      && !(lines[i] ?? "").startsWith("```") && !/^#{1,4}\s/.test(lines[i] ?? "")
      && !/^\s*[-*]\s+/.test(lines[i] ?? "") && !/^>\s?/.test(lines[i] ?? "")
      && !tableStartAt(lines, i)) {
      para.push(lines[i] ?? "");
      i++;
    }
    blocks.push({ kind: "para", lines: para });
  }
  return blocks;
}

// Inline: **bold**, `code`, and — ω99-155, web-only third rule — [label](url)
// → spans (the TUI keeps its exact two; links are the same web-only upgrade
// family as tables/highlight, a deliberate fork noted in the arc report).
export function parseInline(s: string): { text: string; bold?: boolean; code?: boolean; href?: string }[] {
  const spans: { text: string; bold?: boolean; code?: boolean; href?: string }[] = [];
  // ω99-155: third alternative `[label](url)` — label without `]`, url
  // without whitespace/`)` (conservative v1: no bare-URL autolink, no nested
  // formatting inside the label). Alternation order keeps the two older
  // rules winning at the same position: `` `[x](u)` `` stays inline code.
  // The outer group is NON-capturing so the link's label/url are m[1]/m[2].
  const re = /(?:\*\*[^*]+\*\*|`[^`]+`|\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) spans.push({ text: s.slice(last, m.index) });
    const tok = m[0] ?? "";
    if (tok.startsWith("**")) spans.push({ text: tok.slice(2, -2), bold: true });
    else if (tok.startsWith("`")) spans.push({ text: tok.slice(1, -1), code: true });
    else {
      // The link alternative is the only group-carrying one: m[1]=label,
      // m[2]=url (bold/code capture nothing; the ?? arms are unreachable
      // type-guards for noUncheckedIndexedAccess).
      spans.push({ text: m[1] ?? tok, href: m[2] ?? tok });
    }
    last = m.index + tok.length;
  }
  if (last < s.length) spans.push({ text: s.slice(last) });
  return spans;
}

// M72 §2 — streaming boundary advance (research 38 §1, CC's
// StreamingMarkdown): while a source string GROWS delta by delta, everything
// before the last stable seam is lexically final, so it is committed to a ref
// once and never parsed again — per-delta lex cost is O(unstable suffix),
// not O(full text). A seam is the position right after a blank line, which
// provably terminates every block in our grammar (para/list/quote/heading
// all end at a blank line; a fence re-arms seams only after it closes, so
// blank lines inside an open fence are skipped — matching parseBlocks).
// Returns 0 when nothing is provably final yet.
export function stableBoundary(suffix: string): number {
  let seam = 0;
  let lineStart = 0;
  let inFence = false;
  for (const line of suffix.split("\n")) {
    if (inFence) {
      if (line.startsWith("```")) inFence = false;
    } else if (line.startsWith("```")) {
      inFence = true;
    } else if (line.trim() === "" && lineStart + line.length + 1 <= suffix.length) {
      // A seam opens only when the blank line's following newline EXISTS.
      // split("\n") yields a phantom trailing "" for text ending in a bare
      // newline — treating it as a blank line committed a seam mid-paragraph,
      // so growth onto "…\nmore text" split one para into two (review F1;
      // the trailing blank line of "a\n\n" still seams, at EOF).
      seam = lineStart + line.length + 1;
    }
    lineStart += line.length + 1;
  }
  return seam;
}

export const EMPTY_BLOCKS: readonly Block[] = [];
