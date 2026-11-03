// M62 §1 — path-gated context rules (`.wudao/rules/**/*.md` + the global
// twin `~/.wudao/rules/**/*.md`). Two kinds, split by frontmatter:
//
//   no `paths:`  STABLE — loads at session start into the project-context
//                stable section (same home as WUDAO.md: global tier first,
//                alphabetical within a tier), counts against the 128KB
//                section budget. See project-context.ts (M54b).
//   `paths:`     GATED — lazy: when a matching file FIRST enters context via
//                a successful read_file/edit, the rule body is APPENDED to
//                the message history as a system-adjacent note (NOT a
//                resident projection). Compaction summarizes it away like
//                any history; the next matching read re-loads it. Once per
//                rule per presence-in-history — the loop dedupes by scanning
//                for the note marker, so a rule already in history never
//                re-injects until a compaction removes it.
//
// A subdirectory WUDAO.md/AGENTS.md/agents.md inside the workspace is an
// IMPLICIT gated rule scoped to its subtree (the root and .git-bounded
// parent files keep their M54b startup load).
//
// Discovery mirrors the skills loader (M57): same-name project rule wins
// with a "shadows global" warning. Rule bodies cap at 8k chars on a line
// boundary. Everything is memoized per workspace root — session-static, no
// hot reload (editing a rule mid-session does nothing until restart; the
// prefix cache rules).
import { truncateSafe } from "@wudao-org/core"; // 113-A4
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { globToRegex } from "@wudao-org/core";
import { resolveGlobalHome } from "./settings-layer.js";

/** Single-rule body cap (chars, line boundary — spec §1). */
export const MAX_RULE_BODY_CHARS = 8_192;

const RULE_TRUNCATION = "\n[… rule truncated at 8k chars …]";

/** One discovered rule file. */
export interface ContextRule {
  /** Tier-relative identity (e.g. `python.md`, `frontend/react.md`) — the
   *  shadowing key across tiers. */
  readonly name: string;
  /** Display form the TUI notice and the prompt header use
   *  (`.wudao/rules/x.md` / `~/.wudao/rules/x.md` / `pkg/WUDAO.md`). */
  readonly source: string;
  /** Glob list from `paths:` frontmatter — workspace-relative posix. An
   *  implicit subdir rule carries its subtree glob here. */
  readonly paths?: readonly string[];
  /** Body after frontmatter, whitespace-trimmed, capped 8k. */
  readonly body: string;
  readonly tier: "project" | "global";
  /** True for the subdirectory WUDAO.md/AGENTS.md special case. */
  readonly implicit?: true;
}

/** Cap a rule body at MAX_RULE_BODY_CHARS on a line boundary. Pure. */
export function capRuleBody(body: string): string {
  const text = body.trim();
  if (text.length <= MAX_RULE_BODY_CHARS) return text;
  const capped = truncateSafe(text, MAX_RULE_BODY_CHARS);
  const lastNl = capped.lastIndexOf("\n");
  return (lastNl === -1 ? capped : capped.slice(0, lastNl)) + RULE_TRUNCATION;
}

/** Parse a rule file's line-style frontmatter. Only `paths:` is meaningful:
 *  an inline list (`paths: a/**, b/**` or `paths: ["a/**","b/**"]`) or a
 *  block list (`paths:` followed by `- item` lines). Tolerant — malformed
 *  lines are ignored, unknown keys dropped. */
export function parseRuleFrontmatter(text: string): { readonly paths?: readonly string[] } {
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") return {};
  let paths: string[] | undefined;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "---") break;
    const m = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!m) {
      // Block-list item continuing an open `paths:` node.
      const item = /^-[ \t]*(.*)$/.exec(line.trim());
      if (item !== null && paths !== undefined) {
        const v = stripListQuotes((item[1] ?? "").trim());
        if (v !== "") paths.push(v);
      }
      continue;
    }
    if (m[1] !== "paths") continue;
    const inline = (m[2] ?? "").trim();
    if (inline === "") {
      paths = []; // block list opens below
      continue;
    }
    const list = parseInlineList(inline);
    paths = list.length > 0 ? list : [];
  }
  if (paths === undefined || paths.length === 0) return {};
  return { paths };
}

/** One inline list value: `a, b`, `[a, b]`, or a JSON-ish `["a","b"]` array.
 *  Generic list syntax (not glob-specific) — skills.ts (cc-plugins D1) reuses
 *  it for the frontmatter list fields, keeping ONE inline-list parser. */
export function parseInlineList(inline: string): string[] {
  let raw = inline;
  if (raw.startsWith("[") && raw.endsWith("]")) raw = raw.slice(1, -1);
  else if (raw.startsWith("\"") || raw.startsWith("'")) {
    // JSON-ish array: ["a/**", "b/**"] — reparse as JSON first.
    try {
      const parsed = JSON.parse(inline) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
      }
    } catch {
      /* fall through to comma split */
    }
  }
  return raw
    .split(",")
    .map((s) => stripListQuotes(s.trim()))
    .filter((s) => s !== "");
}

function stripListQuotes(v: string): string {
  if (v.length >= 2 && ((v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

/** Recursively list every `.md` file under one rules root (relative to it).
 *  Missing root → []. Hidden dirs are skipped. */
function listRuleFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, prefix === "" ? entry.name : `${prefix}/${entry.name}`);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(prefix === "" ? entry.name : `${prefix}/${entry.name}`);
      }
    }
  };
  walk(root, "");
  return out;
}

function loadTier(
  root: string,
  tier: "project" | "global",
  display: (rel: string) => string,
  warn: (msg: string) => void,
): ContextRule[] {
  const out: ContextRule[] = [];
  for (const rel of listRuleFiles(root)) {
    const filePath = join(root, rel);
    let text: string;
    try {
      text = readFileSync(filePath, "utf8");
    } catch {
      continue; // unreadable file — skip silently (optional surface)
    }
    const fm = parseRuleFrontmatter(text);
    const body = capRuleBody(text.replace(/^---\r?\n.*?\r?\n---\r?\n?/s, ""));
    if (body === "") {
      warn(`rule ${filePath} has an empty body; skipping it`);
      continue;
    }
    out.push({
      name: rel,
      source: display(rel),
      ...(fm.paths !== undefined ? { paths: fm.paths } : {}),
      body,
      tier,
    });
  }
  return out;
}

/** Subdirectory context files = implicit gated rules. Sync walk of the
 *  workspace, skipping heavy/hidden dirs; a safety cap bounds hostile trees.
 *  The workspace ROOT's own files are excluded (M54b owns those), and so is
 *  every file at or above it. */
export const SUBDIR_CONTEXT_FILENAMES: readonly string[] = ["WUDAO.md", "AGENTS.md", "agents.md"];
const SUBDIR_WALK_SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", ".wudao", "dist", "build", "coverage"]);
const SUBDIR_WALK_MAX_FILES = 20_000;

/** Discover the implicit subdir rules for a workspace (sorted for
 *  determinism; the exact-case AGENTS.md beats lowercase agents.md in one
 *  directory, same as M54b). */
export function discoverSubdirContextRules(workspaceRoot: string): ContextRule[] {
  const root = resolve(workspaceRoot);
  const found: ContextRule[] = [];
  let walked = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name.startsWith(".") || SUBDIR_WALK_SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (!entry.isDirectory()) continue;
      if (++walked > SUBDIR_WALK_MAX_FILES) return;
      const relDir = toPosix(relative(root, full));
      let picked: string | undefined;
      for (const name of SUBDIR_CONTEXT_FILENAMES) {
        try {
          if (statSync(join(full, name)).isFile()) {
            picked = name;
            break;
          }
        } catch {
          /* not present */
        }
      }
      if (picked !== undefined) {
        try {
          const text = readFileSync(join(full, picked), "utf8");
          const body = capRuleBody(text);
          if (body !== "") {
            found.push({
              name: `${relDir}/${picked}`,
              source: `${relDir}/${picked}`,
              paths: [`${relDir}/**`],
              body,
              tier: "project",
              implicit: true,
            });
          }
        } catch {
          /* unreadable — skip */
        }
      }
      walk(full);
    }
  };
  walk(root);
  return found;
}

/** The session's rule set: stable (no paths) + gated (paths incl. implicit). */
export interface ContextRules {
  /** No-paths rules in injection order: global tier first, then project,
   *  alphabetical within each tier (spec §1). */
  readonly stable: readonly ContextRule[];
  /** Paths-carrying rules (explicit + implicit subdir), any order. */
  readonly gated: readonly ContextRule[];
  readonly warnings: readonly string[];
}

/** Load both rule tiers + the implicit subdir rules. Pure w.r.t. the fs at
 *  call time; callers wanting session-static behavior use
 *  getContextRules(). */
export function loadContextRules(workspaceRoot: string, warn: (msg: string) => void = () => {}): ContextRules {
  const warnings: string[] = [];
  const byName = new Map<string, ContextRule>();
  for (const r of loadTier(join(resolveGlobalHome(), "rules"), "global", (rel) => `~/.wudao/rules/${rel}`, warn)) {
    byName.set(r.name, r);
  }
  for (const r of loadTier(join(resolve(workspaceRoot), ".wudao", "rules"), "project", (rel) => `.wudao/rules/${rel}`, warn)) {
    const existing = byName.get(r.name);
    if (existing !== undefined && existing.tier === "global") {
      warnings.push(`rule "${r.name}": project ${r.source} shadows global ${existing.source} (project wins)`);
    }
    byName.set(r.name, r);
  }
  for (const r of discoverSubdirContextRules(workspaceRoot)) {
    byName.set(r.name, r);
  }
  const all = [...byName.values()];
  const tierRank = (r: ContextRule): number => (r.tier === "global" ? 0 : 1);
  const stable = all
    .filter((r) => r.paths === undefined)
    .sort((a, b) => tierRank(a) - tierRank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const gated = all.filter((r) => r.paths !== undefined);
  for (const w of warnings) warn(`[wudao] rules: ${w}`);
  return { stable, gated, warnings };
}

// Session-static memo (same discipline as project-context: loaded once per
// process per root — no hot reload, prefix cache rules).
const cache = new Map<string, ContextRules>();

/** The memoized rule set for a workspace root. */
export function getContextRules(workspaceRoot: string, warn: (msg: string) => void = () => {}): ContextRules {
  const key = resolve(workspaceRoot);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const result = loadContextRules(workspaceRoot, warn);
  cache.set(key, result);
  return result;
}

/** True when the workspace has any gated rule (the loop seam is only wired
 *  when this is true — zero cost otherwise). */
export function hasGatedRules(workspaceRoot: string): boolean {
  return getContextRules(workspaceRoot).gated.length > 0;
}

/** The note prefix a gated rule's history message carries (the dedupe
 *  marker the loop scans for). */
export function ruleNotePrefix(source: string): string {
  return `[context rule ${source}]`;
}

/** Build the full history note for one gated rule (the loop appends this as
 *  a user-role system-adjacent message after the matching read's batch). */
export function buildRuleNote(rule: ContextRule): string {
  return `${ruleNotePrefix(rule.source)}\n${rule.body}`;
}

/** Normalize one workspace-relative or raw path arg to a posix rel path
 *  ("" when it escapes the workspace). */
function normalizeRelPath(workspaceRoot: string, rawPath: string): string {
  const cleaned = rawPath.replace(/^\.\//, "");
  const abs = resolve(workspaceRoot, cleaned);
  const rel = relative(resolve(workspaceRoot), abs);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) return "";
  return toPosix(rel);
}

/** True when one glob matches a workspace-relative posix path. A pattern
 *  with no `/` also matches the path's basename (`CLAUDE.md` matches
 *  `pkg/foo/CLAUDE.md`) — the friendly CC spelling. Pure. */
export function globMatchesPath(glob: string, relPath: string): boolean {
  const re = globToRegex(glob);
  if (re.test(relPath)) return true;
  if (!glob.includes("/")) {
    const base = relPath.split("/").pop() ?? relPath;
    if (re.test(base)) return true;
  }
  return false;
}

/** The matcher handed to the loop's contextRules seam: returns the rules
 *  whose bodies should enter history for THIS tool call (empty for tools /
 *  paths that match nothing — zero cost). */
export function createContextRuleMatcher(
  workspaceRoot: string,
  gated: readonly ContextRule[],
): (toolName: string, args: Record<string, unknown>) => readonly ContextRule[] {
  if (gated.length === 0) return () => [];
  const compiled = gated.map((rule) => ({ rule, globs: rule.paths ?? [] }));
  return (toolName, args) => {
    if (toolName !== "read_file" && toolName !== "edit") return [];
    const raw = args["path"];
    if (typeof raw !== "string" || raw === "") return [];
    const rel = normalizeRelPath(workspaceRoot, raw);
    if (rel === "") return [];
    const out: ContextRule[] = [];
    for (const { rule, globs } of compiled) {
      if (globs.some((g) => globMatchesPath(g, rel))) out.push(rule);
    }
    return out;
  };
}

/** Tests only: drop the memo so a fresh load observes new fixture files. */
export function resetContextRulesForTests(): void {
  cache.clear();
}
