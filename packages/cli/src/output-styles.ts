// M62 §4 — output styles: `.wudao/output-styles/*.md` + the global twin
// `~/.wudao/output-styles/*.md`. The settings key `outputStyle` names one;
// its BODY is appended into the system prompt's stable tail section.
//
// Cache law: the style is chosen at SESSION START and byte-frozen for the
// session — changing settings/`/config` mid-session is a no-op until the
// next session (the selection is read once, before any prompt is built, and
// the resolved section is memoized per workspace root). This mirrors the upstream's
// restart-only semantics and keeps the prefix cache intact.
//
// Default posture (deliberately the OPPOSITE of the upstream format): the style body is
// APPENDED and the coding instructions (`# Tool usage`) section is KEPT —
// a coding harness puts safety first; a style is voice, not a replacement
// for tool discipline. A style can opt out per-file with the frontmatter
// flag `replace-coding-instructions: true`, which swaps that section for
// the style body.
//
// Same-name resolution mirrors skills (M57): the PROJECT file wins over the
// global twin with a load warning naming both paths.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveGlobalHome } from "./settings-layer.js";

/** One discovered output-style file. */
export interface LoadedOutputStyle {
  /** Selection key: frontmatter `name:` when present, else the file stem. */
  readonly name: string;
  /** Display path for warnings/doctor (`.wudao/output-styles/x.md` or
   *  `~/.wudao/output-styles/x.md`). */
  readonly source: string;
  /** Body after the frontmatter, whitespace-trimmed (verbatim otherwise). */
  readonly body: string;
  /** `replace-coding-instructions: true` — swap the coding-instructions
   *  section for this body instead of appending a tail section. */
  readonly replaceCodingInstructions: boolean;
  readonly tier: "project" | "global";
}

/** Parse a style file's line-style frontmatter (`name?`,
 *  `replace-coding-instructions: true?` — tolerant, unknown keys dropped)
 *  and return {frontmatter, body}. */
export function parseOutputStyleFile(text: string): {
  readonly name?: string;
  readonly replaceCodingInstructions: boolean;
  readonly body: string;
} {
  const lines = text.split(/\r?\n/);
  let name: string | undefined;
  let replace = false;
  let end = 0;
  if ((lines[0] ?? "").trim() === "---") {
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (line.trim() === "---") {
        end = i + 1;
        break;
      }
      const m = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
      if (!m) continue;
      const value = (m[2] ?? "").trim().replace(/^["']|["']$/g, "");
      if (m[1] === "name") {
        if (value !== "") name = value;
      } else if (m[1] === "replace-coding-instructions") {
        if (value === "true") replace = true;
      }
    }
  }
  const body = (end === 0 ? text : lines.slice(end).join("\n")).trim();
  return { ...(name !== undefined ? { name } : {}), replaceCodingInstructions: replace, body };
}

function loadTier(
  root: string,
  tier: "project" | "global",
  display: (file: string) => string,
  warn: (msg: string) => void,
): LoadedOutputStyle[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // no such root — styles simply absent there
  }
  const out: LoadedOutputStyle[] = [];
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = join(root, entry.name);
    let text: string;
    try {
      text = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const parsed = parseOutputStyleFile(text);
    if (parsed.body === "") {
      warn(`output style ${filePath} has an empty body; skipping it`);
      continue;
    }
    out.push({
      name: parsed.name ?? entry.name.replace(/\.md$/, ""),
      source: display(entry.name),
      body: parsed.body,
      replaceCodingInstructions: parsed.replaceCodingInstructions,
      tier,
    });
  }
  return out;
}

/** Load both style tiers; same-name project wins with a warning. Pure w.r.t.
 *  the fs at call time. */
export function loadOutputStyles(workspaceRoot: string, warn: (msg: string) => void = () => {}): readonly LoadedOutputStyle[] {
  const byName = new Map<string, LoadedOutputStyle>();
  for (const s of loadTier(join(resolveGlobalHome(), "output-styles"), "global", (f) => `~/.wudao/output-styles/${f}`, warn)) {
    byName.set(s.name, s);
  }
  for (const s of loadTier(join(workspaceRoot, ".wudao", "output-styles"), "project", (f) => `.wudao/output-styles/${f}`, warn)) {
    const existing = byName.get(s.name);
    if (existing !== undefined && existing.tier === "global") {
      warn(`output style "${s.name}": project ${s.source} shadows global ${existing.source} (project wins)`);
    }
    byName.set(s.name, s);
  }
  return [...byName.values()];
}

/** Exact-name lookup (settings `outputStyle`). */
export function findOutputStyle(styles: readonly LoadedOutputStyle[], name: string): LoadedOutputStyle | undefined {
  return styles.find((s) => s.name === name);
}

// ---------------------------------------------------------------------------
// Session-static selection (M62 §4). The selection is set ONCE at process
// start (before any prompt build) via setSessionOutputStyle; the resolution
// is memoized per root. Mid-session calls to the setter are REFUSED unless
// the selection is still unset — a live flip would shift prompt bytes and
// break the prefix cache (the spec's "restart-only" rule, enforced).
// ---------------------------------------------------------------------------

let sessionSelection: string | undefined;
let selectionSealed = false;
const resolved = new Map<string, LoadedOutputStyle | undefined>();

/** Set the session's output-style name. First call wins; later calls are
 *  no-ops (byte-frozen for the session — change it and restart). */
export function setSessionOutputStyle(name: string | undefined): void {
  if (selectionSealed) return;
  sessionSelection = name !== undefined && name !== "" ? name : undefined;
  selectionSealed = true;
}

/** The style selected for this session, resolved against a workspace root
 *  (memoized; undefined when nothing is selected or the name matches no
 *  style — a missing style warns once and degrades to no section). */
export function getSelectedOutputStyle(
  workspaceRoot: string,
  warn: (msg: string) => void = () => {},
): LoadedOutputStyle | undefined {
  if (sessionSelection === undefined) return undefined;
  const key = `${workspaceRoot}\x00${sessionSelection}`;
  if (!resolved.has(key)) {
    const styles = loadOutputStyles(workspaceRoot, warn);
    const hit = findOutputStyle(styles, sessionSelection);
    if (hit === undefined) {
      warn(`outputStyle "${sessionSelection}" matches no loaded style (searched .wudao/output-styles and the global twin); continuing without one`);
    }
    resolved.set(key, hit);
  }
  return resolved.get(key);
}

/** The append-mode prompt section for a style ("" semantics belong to the
 *  caller: a replace-mode style contributes no tail section — its body
 *  already lives in the base sections). Format pinned by tests:
 *
 *   # Output style (<name>)
 *   <body>
 */
export function outputStylePromptSection(style: LoadedOutputStyle): string {
  return `\n\n# Output style (${style.name})\n${style.body}`;
}

/** Tests only: unseal the selection and drop the resolution memo. */
export function resetOutputStyleForTests(): void {
  sessionSelection = undefined;
  selectionSealed = false;
  resolved.clear();
}
