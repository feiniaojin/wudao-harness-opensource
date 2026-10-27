// M55 §B9 — /export [file]: render the session as markdown (default) or as a
// self-contained HTML page (96 队列 P0-3). The source is
// the frontend's own history channel (the driver's HistoryEntry[] — user and
// assistant turns, tool summaries, todo-board snapshots); the REPL (no
// history channel) maps its AgentMessages through exportEntriesFromMessages.
// Default target .wudao/exports/<session>.md (.html for the html format); an
// existing file is NEVER overwritten silently — the command parks the render
// and `ok` (the shared approval-word seam /plan and /init use) confirms the
// overwrite, any other input cancels. The format is resolved from fileArg
// alone (`html` or any *.html path) — the callers stay format-blind.
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@wudao/core";

/** The exportable subset of the history channel (structural — both the
 *  driver's HistoryEntry and the REPL's mapped messages fit). */
export type ExportEntry =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "assistant"; readonly text: string }
  | { readonly kind: "tool"; readonly name: string; readonly summary: string; readonly isError?: boolean }
  | { readonly kind: "board"; readonly done: number; readonly total: number; readonly lines: readonly string[] };

/** The export format — resolved from fileArg alone (the single source of
 *  truth): the exact keyword `html` or any path ending in `.html` (both
 *  case-insensitive, trimmed). Everything else — the empty default, *.md,
 *  `htmlnotes`, `a.html.txt` — stays markdown. */
export function resolveExportFormat(fileArg: string): "markdown" | "html" {
  const t = fileArg.trim().toLowerCase();
  return t === "html" || t.endsWith(".html") ? "html" : "markdown";
}

/** Default export target: .wudao/exports/<session>.md, or .html for the html
 *  format (session ids are [A-Za-z0-9_-]+ by construction — no sanitization
 *  needed beyond a trim). */
export function defaultExportPath(workspaceRoot: string, sessionId: string, format: "markdown" | "html" = "markdown"): string {
  const safe = sessionId.trim().replace(/[^\w.-]+/g, "-") || "session";
  return join(workspaceRoot, ".wudao", "exports", `${safe}.${format === "html" ? "html" : "md"}`);
}

/** Map a driver HistoryEntry list into the exportable subset (notices,
 *  dividers, errors, and raw edit diffs stay out — an export is the
 *  conversation, not the debug log). Structural narrowing — the driver's
 *  HistoryEntry union fits without importing it here. */
export function exportEntriesFromHistory(history: readonly Record<string, unknown>[]): readonly ExportEntry[] {
  const out: ExportEntry[] = [];
  for (const e of history) {
    const str = (k: string): string | undefined => {
      const v = e[k];
      return typeof v === "string" ? v : undefined;
    };
    if (e.kind === "user" || e.kind === "assistant") {
      const text = str("text") ?? "";
      out.push({ kind: e.kind, text });
    } else if (e.kind === "tool") {
      out.push({ kind: "tool", name: str("name") ?? "?", summary: str("summary") ?? "", ...(e.isError === true ? { isError: true } : {}) });
    } else if (e.kind === "board") {
      const done = typeof e.done === "number" ? e.done : 0;
      const total = typeof e.total === "number" ? e.total : 0;
      const lines = Array.isArray(e.lines) ? e.lines.filter((l): l is string => typeof l === "string") : [];
      out.push({ kind: "board", done, total, lines });
    }
  }
  return out;
}

/** Map plain conversation messages into the exportable subset (the REPL's
 *  source). Tool calls render through the caller's summarizer; machinery
 *  messages (bracketed transients) stay out. */
export function exportEntriesFromMessages(
  messages: readonly AgentMessage[],
  summarize: (toolName: string, input: Record<string, unknown>) => string,
): readonly ExportEntry[] {
  const out: ExportEntry[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      if (m.content.startsWith("[")) continue; // machinery (steering/board/approval riders)
      out.push({ kind: "user", text: m.content });
    } else if (m.role === "assistant") {
      for (const tc of m.toolCalls ?? []) {
        out.push({ kind: "tool", name: tc.name, summary: summarize(tc.name, tc.arguments as Record<string, unknown>) });
      }
      if (m.content.trim() !== "") out.push({ kind: "assistant", text: m.content });
    }
  }
  return out;
}

/** The markdown document. Sections per turn with tool summaries and board
 *  snapshots inline where they happened. */
export function renderSessionMarkdown(args: {
  readonly entries: readonly ExportEntry[];
  readonly sessionId: string;
  readonly model?: string;
  readonly generatedAt?: Date;
}): string {
  const stamp = (args.generatedAt ?? new Date()).toISOString().replace("T", " ").slice(0, 16);
  const lines: string[] = [
    `# wudao session ${args.sessionId}`,
    "",
    `_exported ${stamp} UTC${args.model !== undefined ? ` · model ${args.model}` : ""} · ${args.entries.length} entries_`,
    "",
    "---",
    "",
  ];
  let turn = 0;
  for (const e of args.entries) {
    switch (e.kind) {
      case "user":
        turn += 1;
        lines.push(`## Turn ${turn}`, "", "**User:**", "", e.text, "");
        break;
      case "assistant":
        lines.push("**Assistant:**", "", e.text, "");
        break;
      case "tool":
        lines.push(`> 🛠 \`${e.name}\`${e.isError === true ? " *(error)*" : ""} — ${e.summary.split("\n")[0] ?? ""}`);
        break;
      case "board":
        lines.push("", `**Todo board (${e.done}/${e.total}):**`, "", ...e.lines.map((l) => l), "");
        break;
    }
  }
  lines.push("---", "", "_end of session export_");
  return `${lines.join("\n")}\n`;
}

/** The HTML safety line: `&` FIRST (escape-after would corrupt the entities
 *  into &amp;lt; double-escapes), then the other four. Every interpolation
 *  in renderSessionHtml passes through this — no exceptions, so the export
 *  file can never become a stored-XSS carrier. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Entry text without a markdown dependency: split into paragraphs on blank
 *  lines, escape each paragraph, THEN turn single newlines into <br> (the
 *  inserted tags must not be re-escaped). */
function htmlParagraphs(text: string): string {
  return text
    .split(/\n\n+/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** The HTML document (96 队列 P0-3): the same entries and information order
 *  as the markdown render, but one self-contained page — inline CSS (the
 *  #1a1a24 dark-card family), native <details> folds for tool calls, zero
 *  external resources, zero JS, deterministically testable via generatedAt.
 *  pi's export-html is the paradigm; the base64 + client JS + vendor
 *  marked/hljs machinery is deliberately NOT taken. */
export function renderSessionHtml(args: {
  readonly entries: readonly ExportEntry[];
  readonly sessionId: string;
  readonly model?: string;
  readonly generatedAt?: Date;
}): string {
  const stamp = (args.generatedAt ?? new Date()).toISOString().replace("T", " ").slice(0, 16);
  const body: string[] = [];
  for (const e of args.entries) {
    switch (e.kind) {
      case "user":
        body.push(`<section class="msg user">${htmlParagraphs(e.text)}</section>`);
        break;
      case "assistant":
        body.push(`<section class="msg assistant">${htmlParagraphs(e.text)}</section>`);
        break;
      case "tool": {
        const cls = e.isError === true ? "tool error" : "tool";
        const firstLine = e.summary.split("\n")[0] ?? "";
        body.push(
          `<details class="${cls}"><summary>🛠 ${escapeHtml(e.name)} — ${escapeHtml(firstLine)}</summary><pre>${escapeHtml(e.summary)}</pre></details>`,
        );
        break;
      }
      case "board":
        body.push(
          `<section class="board"><h2>Todo board (${escapeHtml(String(e.done))}/${escapeHtml(String(e.total))})</h2>` +
            `<ul>${e.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul></section>`,
        );
        break;
    }
  }
  return [
    "<!DOCTYPE html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>wudao session ${escapeHtml(args.sessionId)}</title>`,
    "<style>",
    ...EXPORT_HTML_CSS,
    "</style>",
    "</head>",
    "<body>",
    "<header>",
    `<p class="sid">wudao session ${escapeHtml(args.sessionId)}</p>`,
    `<p class="meta">_exported ${escapeHtml(stamp)} UTC${args.model !== undefined ? ` · model ${escapeHtml(args.model)}` : ""} · ${escapeHtml(String(args.entries.length))} entries_</p>`,
    "</header>",
    "<main>",
    ...body,
    "</main>",
    "<footer>_end of session export_</footer>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** Inline CSS for the html export — a dark-card family around #1a1a24, no
 *  external fonts or resources (the file opens offline as-is). */
const EXPORT_HTML_CSS: readonly string[] = [
  ":root { color-scheme: dark; }",
  "body { background:#1a1a24; color:#d6d8e0; font:15px/1.65 ui-monospace,Menlo,Consolas,monospace; margin:0 auto; max-width:60rem; padding:2rem 1.25rem 3rem; }",
  "header { border-bottom:1px solid #2c2d3f; margin-bottom:1.5rem; padding-bottom:1rem; }",
  "header .sid { color:#8ab4ff; font-size:1.1rem; margin:0 0 .35rem; }",
  "header .meta { color:#8b8fa3; font-size:.85rem; margin:0; }",
  ".msg { background:#22232f; border:1px solid #33344a; border-radius:8px; margin:1rem 0; padding:.9rem 1.1rem; }",
  ".msg.user { border-left:3px solid #8ab4ff; }",
  ".msg.assistant { border-left:3px solid #7bd88f; }",
  ".msg p { margin:.45rem 0; }",
  "details.tool { background:#20212c; border:1px solid #33344a; border-radius:8px; margin:.75rem 0; padding:.55rem .9rem; }",
  "details.tool summary { color:#c9a86a; cursor:pointer; }",
  "details.tool.error { border-color:#a04040; }",
  "details.tool.error summary { color:#e07070; }",
  "details.tool pre { background:#171821; border-radius:6px; margin:.6rem 0 0; overflow-x:auto; padding:.7rem; white-space:pre-wrap; word-break:break-word; }",
  ".board { background:#1f2030; border:1px dashed #3c3d55; border-radius:8px; margin:1rem 0; padding:.85rem 1.1rem; }",
  ".board h2 { color:#b8a8e8; font-size:.95rem; margin:0 0 .5rem; }",
  ".board ul { margin:0; padding-left:1.2rem; }",
  "footer { border-top:1px solid #2c2d3f; color:#8b8fa3; font-size:.8rem; margin-top:2rem; padding-top:1rem; }",
];

export type PreparedExport =
  | { readonly kind: "ok"; readonly path: string; readonly content: string }
  | { readonly kind: "exists"; readonly path: string; readonly content: string; readonly hint: string };

/** Resolve the target + render + the overwrite guard. The format comes from
 *  fileArg alone (`html` keyword → the html default path; a real path — incl.
 *  any *.html — is joined under the workspace root; empty → the markdown
 *  default). `exists` parks the write: the caller's confirm seam (`ok`)
 *  re-invokes with force to write. */
export async function prepareExport(args: {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly fileArg: string;
  readonly entries: readonly ExportEntry[];
  readonly model?: string;
  readonly generatedAt?: Date;
}): Promise<PreparedExport> {
  const format = resolveExportFormat(args.fileArg);
  const trimmed = args.fileArg.trim();
  const path = trimmed === "" || trimmed.toLowerCase() === "html"
    ? defaultExportPath(args.workspaceRoot, args.sessionId, format)
    : join(args.workspaceRoot, trimmed);
  const content = format === "html"
    ? renderSessionHtml({
      entries: args.entries,
      sessionId: args.sessionId,
      model: args.model,
      generatedAt: args.generatedAt,
    })
    : renderSessionMarkdown({
      entries: args.entries,
      sessionId: args.sessionId,
      model: args.model,
      generatedAt: args.generatedAt,
    });
  let present = false;
  try {
    await stat(path);
    present = true;
  } catch {
    present = false;
  }
  if (present) {
    return {
      kind: "exists",
      path,
      content,
      hint: `export target ${path} already exists — reply "ok" to overwrite, anything else cancels`,
    };
  }
  await writeExportFile(path, content);
  return { kind: "ok", path, content };
}

/** Write the file (mkdir -p on the parent). */
export async function writeExportFile(path: string, content: string): Promise<void> {
  await mkdir(dirnameOf(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

/** Parent directory of `p`. Both separators — on win32 the path carries `\`
 *  and a `/`-only split would return "." (parent never created → ENOENT). */
function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (i === -1) return ".";
  if (i === 0) return "/";
  return p.slice(0, i);
}
