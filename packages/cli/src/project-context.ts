// M54/M54b — project-context files: the harness's answer to "CC has
// CLAUDE.md, Codex has AGENTS.md". M54 shipped root-only + alphabetical
// (user's minimum). M54b aligns discovery with the reference harnesses
// (docs/research/18-ctx-loading-semantics.md §7, dsh-flavored): the user
// directed matching reference semantics, NOT CC's walk-to-filesystem-root.
//
// Discovery & order (reference semantics):
//   1. user-global `~/.wudao/WUDAO.md` (personal baseline) concatenated
//      FIRST — least specific (CC's user tier / dsh's ~/.dsh/AGENTS.md).
//   2. `.git`-BOUNDED upward walk: from workspaceRoot walk up ONLY to the
//      nearest ancestor containing `.git` (inclusive — a worktree's `.git`
//      FILE counts too). The chain loads ROOT → CWD: parent/broadest first,
//      cwd/most-specific LAST = highest priority (CC claudemd.ts:877-878,
//      dsh ancestorChain). Never walks to the fs root: no `.git` within a
//      ≤10-level sanity bound → fallback to root-only.
//   3. Within ONE directory the user's alphabetical rule stays:
//      case-insensitive filename order — AGENTS.md → CLAUDE.md → WUDAO.md.
//      `agents.md` (lowercase) is the accepted AGENTS fallback spelling,
//      used only when exact-case AGENTS.md is absent in that directory.
//   4. Content dedup (dsh files.ts:368-384 + cross-dir extension):
//      identical trimmed content loads ONCE — within a directory the later
//      sibling collapses (kills AGENTS.md-symlinked-to-CLAUDE.md double
//      loads); across directories the MORE-SPECIFIC (later/deeper) copy
//      keeps its position and the broader one is dropped.
//
// Budget: 64KB per-file truncate (M54, kept) + 128KB total section budget.
// Over budget, files drop BROADEST-FIRST (front of the ordered list =
// global, then shallowest directory) with an in-section notice line
// `[project context: omitted <displayPath> (budget)]`; the most specific
// (cwd) file is always kept.
//
// KV-cache discipline (unchanged from M54, spec §2): the section is a
// STATIC TAIL segment injected after `# Environment` and before the
// MCP/skills tail. It is loaded ONCE per process per workspace root
// (memoized) — NO hot reload: editing files mid-session does nothing until
// restart, because re-reading would shift bytes and break the provider
// prefix cache. No files at all → empty section → the system prompt stays
// byte-identical to the pre-M54 prompt (pinned by tests). `.claude/` is
// never probed (`.claude/CLAUDE.md` and `.claude/rules/` stay unread).
import { lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { getContextRules, globMatchesPath, type ContextRule } from "./rules.js";

/** Heading of the injected system-prompt section (M52's /context picks it up
 *  via its generic `#`/`##` heading split). */
export const PROJECT_CONTEXT_HEADING = "# Project context";

/** Single-file cap (CC's 40k-token bloat lesson, threshold set wide). */
export const MAX_PROJECT_CONTEXT_FILE_BYTES = 64 * 1024;

/** Total cap for the assembled section (dsh maxBytes precedent). Broadest
 *  files are dropped first when exceeded; the cwd file is always kept. */
export const MAX_PROJECT_CONTEXT_SECTION_BYTES = 128 * 1024;

/** Env kill switch: any non-empty value disables project-context loading. */
export const NO_PROJECT_CONTEXT_ENV = "WUDAO_NO_PROJECT_CONTEXT";

/** User-global personal baseline (display form; resolved via homedir()). */
export const USER_GLOBAL_DISPLAY_PATH = "~/.wudao/WUDAO.md";

/** M62 §3: the workspace-root PERSONAL context file — loads LAST in the
 *  M54b order (the most specific personal tier). Like settings.local.json
 *  it is physically in the project directory, so a clone can carry it;
 *  treat its content with the same trust as any project file. */
export const LOCAL_CONTEXT_FILENAME = "WUDAO.local.md";

/** Root marker that bounds the upward walk (dsh `projectRootMarkers`). A
 *  `.git` FILE (worktrees) or directory both count. */
const GIT_ROOT_MARKER = ".git";

/** Sanity bound for the upward walk: workspaceRoot itself plus at most 10
 *  ancestors are probed for the marker before falling back to root-only —
 *  never walk to the filesystem root (CC's exposure, dsh's fix). */
const MAX_WALK_UP_LEVELS = 10;

export interface ProjectContextFile {
  /** Display path for the per-file header: project-root-relative for walked
   *  files (`CLAUDE.md`, `packages/foo/AGENTS.md`), bare filename when the
   *  workspace root IS the project root, `~/.wudao/WUDAO.md` for the
   *  user-global baseline. */
  readonly displayPath: string;
  /** File text (verbatim, trailing whitespace normalized; truncated when the
   *  file exceeded the 64KB cap). */
  readonly content: string;
  /** Original on-disk byte size. */
  readonly bytes: number;
  readonly truncated: boolean;
}

export interface ProjectContextResult {
  /** Files actually included, in injection order (global first, then the
   *  chain root → cwd, alphabetical within each directory). */
  readonly files: readonly ProjectContextFile[];
  /** The ready-to-append prompt section; "" when no files were found, so the
   *  assembled system prompt stays byte-identical to the no-M54 baseline. */
  readonly section: string;
  /** Non-fatal problems (truncation, dead symlinks, budget omissions) for
   *  startup warnings. */
  readonly warnings: readonly string[];
  /** Display paths dropped by the section budget (broadest first). */
  readonly omitted: readonly string[];
}

const EMPTY_RESULT: ProjectContextResult = { files: [], section: "", warnings: [], omitted: [] };

/** Candidate filenames in every walked directory. `AGENTS.md` is the
 * canonical spelling; lowercase `agents.md` is the accepted fallback (open
 * -standard case compatibility) used only when the exact-case file is
 * absent. */
const ROOT_CANDIDATES: readonly string[] = ["WUDAO.md", "AGENTS.md", "CLAUDE.md", "agents.md"];

/** Internal carrier: a loaded file plus dedup metadata. */
interface LoadedFile {
  readonly displayPath: string;
  /** Identity of the directory tier (absolute dir, or the global sentinel)
   *  for per-directory dedup. */
  readonly dirKey: string;
  /** Whitespace-trimmed content — the dedup digest (dsh
   *  trimmedInstructionDigest semantics; string key, no hash needed). */
  readonly digest: string;
  readonly content: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

/** Nearest ancestor (inclusive) carrying the root marker, or the start
 *  directory when none exists within the sanity bound — dsh
 *  findProjectRoot(files.ts:168-191). */
function findProjectRoot(startDir: string): string {
  const start = resolve(startDir);
  let current = start;
  for (let depth = 0; depth <= MAX_WALK_UP_LEVELS; depth++) {
    try {
      statSync(join(current, GIT_ROOT_MARKER)); // file (worktree) or dir
      return current;
    } catch {
      /* no marker here — keep climbing */
    }
    const parent = dirname(current);
    if (parent === current) return start; // fs root reached
    current = parent;
  }
  return start; // sanity bound hit — root-only fallback
}

/** Inclusive project-root → cwd directory chain, broadest first (dsh
 *  ancestorChain: [root, …, cwd]). */
function ancestorChain(projectRoot: string, cwd: string): string[] {
  const chain: string[] = [];
  const root = resolve(projectRoot);
  let current = resolve(cwd);
  while (current !== root) {
    chain.push(current);
    const parent = dirname(current);
    if (parent === current) break; // fs root reached — only on corrupted input
    current = parent;
  }
  chain.push(root);
  return chain.reverse();
}

/** One readable file, or a warning when the path is a dead symlink. */
function readCandidate(
  path: string,
  warnings: string[],
): { content: string; bytes: number; truncated: boolean } | undefined {
  let st;
  try {
    st = statSync(path); // follows symlinks — a dead link throws here
  } catch {
    // Distinguish "nothing here" (fine, keep going) from "a symlink points
    // nowhere" (skip + warn).
    try {
      lstatSync(path);
      warnings.push(`dead symlink skipped: ${path}`);
    } catch {
      /* not present at all */
    }
    return undefined;
  }
  if (!st.isFile()) return undefined;
  const buf = readFileSync(path);
  const truncated = buf.length > MAX_PROJECT_CONTEXT_FILE_BYTES;
  if (truncated) {
    warnings.push(
      `${path} is ${buf.length} bytes (>${MAX_PROJECT_CONTEXT_FILE_BYTES}); truncated to ${MAX_PROJECT_CONTEXT_FILE_BYTES}`,
    );
  }
  const body = truncated ? buf.subarray(0, MAX_PROJECT_CONTEXT_FILE_BYTES).toString("utf8") : buf.toString("utf8");
  return {
    // Trailing whitespace is normalized so per-file blocks join cleanly; the
    // bytes are otherwise verbatim.
    content: body.replace(/\s+$/, "") + (truncated ? `\n\n[... truncated: showing first ${MAX_PROJECT_CONTEXT_FILE_BYTES} of ${buf.length} bytes ...]` : ""),
    bytes: buf.length,
    truncated,
  };
}

/** Case-insensitive filename order, exact-case as tiebreaker (user rule for
 *  the same-directory tier): AGENTS.md → CLAUDE.md → WUDAO.md. */
function byAlphabeticalDisplayPath(a: LoadedFile, b: LoadedFile): number {
  const la = a.displayPath.toLowerCase();
  const lb = b.displayPath.toLowerCase();
  return la < lb ? -1 : la > lb ? 1 : a.displayPath < b.displayPath ? -1 : 1;
}

/** M62 §1: a stable (no-paths) context rule as a section block — same
 *  `## <source>` header form as a context file, namespaced digest so rule
 *  content never dedups against (or collapses) a real file. */
function ruleLoadedFile(rule: ContextRule): LoadedFile {
  return {
    displayPath: rule.source,
    dirKey: `rule:${rule.source}`,
    digest: `rule:${rule.source} ${rule.body.trim()}`,
    content: rule.body,
    bytes: Buffer.byteLength(rule.body, "utf8"),
    truncated: false,
  };
}

/** dsh per-directory dedup (files.ts:368-384): within one directory a later
 *  candidate whose trimmed content duplicates an earlier sibling collapses
 *  (the earliest — alphabetical-first — copy is kept). Different tiers then
 *  dedup keeping the MORE-SPECIFIC copy's position: a broader file (user
 *  global or shallower directory) identical to a deeper one is dropped so
 *  the content loads exactly once. */
function dedupLoadedFiles(loaded: readonly LoadedFile[]): LoadedFile[] {
  const seenInDir = new Map<string, Set<string>>();
  const afterDirDedup: LoadedFile[] = [];
  for (const f of loaded) {
    let digests = seenInDir.get(f.dirKey);
    if (digests === undefined) {
      digests = new Set<string>();
      seenInDir.set(f.dirKey, digests);
    }
    if (digests.has(f.digest)) continue; // identical sibling in the same dir
    digests.add(f.digest);
    afterDirDedup.push(f);
  }
  // Cross-directory: keep the LAST (most specific) occurrence of each digest.
  const lastIndexOf = new Map<string, number>();
  afterDirDedup.forEach((f, i) => lastIndexOf.set(f.digest, i));
  return afterDirDedup.filter((f, i) => lastIndexOf.get(f.digest) === i);
}

/** Rendered per-file block bytes (header + content) — the unit the section
 *  budget is measured against (notices and the section heading are free). */
function blockBytes(f: LoadedFile): number {
  return Buffer.byteLength(`## ${f.displayPath}\n${f.content}`, "utf8");
}

/** Load and assemble the project context for one workspace root. Pure with
 *  respect to the filesystem state at call time — callers wanting the
 *  session-static behavior must go through getProjectContext(). */
export function loadProjectContext(workspaceRoot: string): ProjectContextResult {
  const warnings: string[] = [];
  const root = resolve(workspaceRoot);
  const projectRoot = findProjectRoot(root);
  const chain = ancestorChain(projectRoot, root);
  const loaded: LoadedFile[] = [];
  // M62 §7: every M54b candidate the walk actually SAW (display paths) —
  // the dead-pattern lint's universe for claudeMdExcludes.
  const seenCandidates: string[] = [];

  // M62 §7 (claudeMdExcludes): skip candidates whose display path matches
  // any configured glob. Warn per skip so the user sees it working.
  const excluded = (displayPath: string): boolean => {
    if (sessionExcludes.length === 0) return false;
    for (const glob of sessionExcludes) {
      if (globMatchesPath(glob, displayPath)) {
        warnings.push(`excluded by claudeMdExcludes (${glob}): ${displayPath}`);
        return true;
      }
    }
    return false;
  };

  // 1. User-global baseline, FIRST (least specific tier). HOME wins over
  // os.homedir() when set: on win32 homedir() reads USERPROFILE and ignores
  // HOME, which would bypass every test (and CI) that pins the global tier
  // via process.env.HOME.
  const globalPath = join(process.env.HOME !== undefined && process.env.HOME !== "" ? process.env.HOME : homedir(), ".wudao", "WUDAO.md");
  const globalHit = readCandidate(globalPath, warnings);
  if (globalHit !== undefined) {
    // M62 §7: a discovered file counts as SEEN even when an exclude skips
    // it — the dead-pattern lint must only flag globs matching nothing.
    seenCandidates.push(USER_GLOBAL_DISPLAY_PATH);
    if (!excluded(USER_GLOBAL_DISPLAY_PATH)) {
      loaded.push({
        displayPath: USER_GLOBAL_DISPLAY_PATH,
        dirKey: USER_GLOBAL_DISPLAY_PATH, // its own dedup tier
        digest: globalHit.content.trim(),
        ...globalHit,
      });
    }
  }

  // 2. Ancestor chain root → cwd; alphabetical within each directory.
  for (const dir of chain) {
    const found: LoadedFile[] = [];
    // Exact-case names DISCOVERED in this directory (even when an exclude
    // then skipped them) — the `agents.md` fallback must not resurrect an
    // excluded AGENTS.md on case-insensitive filesystems (det-46 finding).
    const discovered: string[] = [];
    for (const name of ROOT_CANDIDATES) {
      // `agents.md` is a fallback spelling: skip it when exact-case
      // AGENTS.md exists in THIS directory (loaded OR excluded-but-present).
      if (name === "agents.md" && discovered.includes("AGENTS.md")) continue;
      // POSIX display separators: the header contract is `## ws/AGENTS.md`,
      // and path.relative on win32 yields `ws\AGENTS.md`.
      const displayPath = relative(projectRoot, join(dir, name)).split(sep).join("/");
      const hit = readCandidate(join(dir, name), warnings);
      if (hit === undefined) continue;
      seenCandidates.push(displayPath);
      discovered.push(name);
      if (excluded(displayPath)) continue;
      found.push({
        displayPath,
        dirKey: dir,
        digest: hit.content.trim(),
        ...hit,
      });
    }
    found.sort(byAlphabeticalDisplayPath);
    loaded.push(...found);
  }

  // 3. M62 §1: no-paths context rules join the SAME stable section, after
  //    the file chain (global tier first, alphabetical within a tier — the
  //    rules loader returns them in that order). Rule bodies are already
  //    capped at 8k; they count against the section budget below like any
  //    other block. A rule's digest is namespaced so content that happens
  //    to duplicate a file never collapses either side.
  const ruleFiles = getContextRules(workspaceRoot, (w) => warnings.push(w));
  for (const rule of ruleFiles.stable) {
    loaded.push(ruleLoadedFile(rule));
  }

  // 4. M62 §3: the root WUDAO.local.md loads LAST — the most specific
  //    PERSONAL tier (global → git-bounded parents → project root → local).
  const localDisplay = LOCAL_CONTEXT_FILENAME;
  const localHit = readCandidate(join(root, LOCAL_CONTEXT_FILENAME), warnings);
  if (localHit !== undefined) {
    seenCandidates.push(localDisplay);
    if (!excluded(localDisplay)) {
      loaded.push({
        displayPath: localDisplay,
        dirKey: `${root}/${LOCAL_CONTEXT_FILENAME}`, // its own dedup tier
        digest: localHit.content.trim(),
        ...localHit,
      });
    }
  }

  // M62 §7: dead-pattern lint — an exclude glob that matched nothing the
  //    walk saw is dead config (typo'd pattern), warn so it gets fixed.
  for (const glob of sessionExcludes) {
    if (!seenCandidates.some((p) => globMatchesPath(glob, p))) {
      warnings.push(`claudeMdExcludes pattern "${glob}" matches no discovered context file (dead pattern)`);
    }
  }

  const files = dedupLoadedFiles(loaded);

  // 3. Section budget: drop broadest-first until the kept blocks fit. The
  //    most specific file (last) is always kept — with the 64KB per-file cap
  //    it can never alone exceed the 128KB section budget.
  const totalFrom = (start: number): number => {
    let n = 0;
    for (let i = start; i < files.length; i++) n += blockBytes(files[i]!);
    return n;
  };
  let keepFrom = 0;
  while (keepFrom < files.length - 1 && totalFrom(keepFrom) > MAX_PROJECT_CONTEXT_SECTION_BYTES) keepFrom++;

  const parts: string[] = [];
  const omitted: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    if (i < keepFrom) {
      omitted.push(f.displayPath);
      parts.push(`[project context: omitted ${f.displayPath} (budget)]`);
      warnings.push(
        `omitted ${f.displayPath}: section budget ${MAX_PROJECT_CONTEXT_SECTION_BYTES} bytes exceeded (dropped broadest-first)`,
      );
    } else {
      parts.push(`## ${f.displayPath}\n${f.content}`);
    }
  }

  const section =
    parts.length === 0
      ? ""
      : `\n\n${PROJECT_CONTEXT_HEADING}\n` + parts.join("\n\n");
  return { files: files.slice(keepFrom), section, warnings, omitted };
}

// Session-static access: memoized per resolved root so the section is loaded
// ONCE per process (spec §2 — no hot reload; restart to pick up edits).
const cache = new Map<string, ProjectContextResult>();

// M62 §7 — claudeMdExcludes (settings, both tiers). Set ONCE at process
// start, BEFORE the first getProjectContext call (the memo captures them);
// later calls are no-ops for the same session-static reason.
let sessionExcludes: readonly string[] = [];

/** Set the session's claudeMdExcludes globs (startup-only; first call wins
 *  once anything has loaded — call before any prompt build). */
export function setProjectContextExcludes(globs: readonly string[]): void {
  if (cache.size > 0) return; // a root already loaded — the bytes are frozen
  sessionExcludes = globs.filter((g) => typeof g === "string" && g.trim() !== "").map((g) => g.trim());
}

/** The session's active claudeMdExcludes (tests/doctor). */
export function getProjectContextExcludes(): readonly string[] {
  return sessionExcludes;
}

/** The memoized project context for a workspace root ("" section when
 *  disabled via env or when no files exist). Warnings print once per root. */
export function getProjectContext(workspaceRoot: string): ProjectContextResult {
  if (process.env[NO_PROJECT_CONTEXT_ENV]) return EMPTY_RESULT;
  const key = resolve(workspaceRoot);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const result = loadProjectContext(workspaceRoot);
  for (const w of result.warnings) console.warn(`[wudao] project-context: ${w}`);
  cache.set(key, result);
  return result;
}

/** Just the appendable section (what buildSystemPrompt splices in). */
export function getProjectContextSection(workspaceRoot: string): string {
  return getProjectContext(workspaceRoot).section;
}

// M58 §C#2 — the standing compact-instructions rider. The `## Compact
// Instructions` section of a loaded project-context file is parsed at session
// start and woven into EVERY tier-2 summary instruction for the session (the
// compaction.ts rider seam). Priority mirrors the loader's specificity: the
// MOST-SPECIFIC file wins (project over global, cwd over parent) — the
// loader's `files` order is global-first/root→cwd, so the scan runs BACKWARD.
// Session-static through the same memoized loader (no hot reload — editing
// the section mid-session does nothing until restart, the same KV-cache
// discipline the section itself follows).

/** The recognized heading (exact case, `##` level). */
export const COMPACT_INSTRUCTIONS_HEADING = "## Compact Instructions";

/** Cap on the extracted rider. The file itself may ride the 64KB per-file
 *  cap; a STANDING instruction appended to every summary call has no business
 *  being that long. Line-boundary backoff, explicit truncation marker. */
export const MAX_COMPACT_INSTRUCTIONS_CHARS = 4_000;

const COMPACT_INSTRUCTIONS_TRUNCATION = "\n[… compact instructions truncated …]";

/** Extract the `## Compact Instructions` section body from one file text:
 *  everything after the heading line up to the next heading of level ≤2 (or
 *  EOF), heading stripped, trimmed. Undefined when the file has no such
 *  section (or the section body is empty). Pure. */
export function extractCompactInstructions(content: string): string | undefined {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.trim() === COMPACT_INSTRUCTIONS_HEADING);
  if (start === -1) return undefined;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    // The next `#`/`##` heading ends the section (a `###` sub-heading is part
    // of the body — it belongs to this section's outline).
    if (/^#{1,2}\s/.test(line)) break;
    body.push(line);
  }
  const text = body.join("\n").trim();
  if (text === "") return undefined;
  if (text.length <= MAX_COMPACT_INSTRUCTIONS_CHARS) return text;
  const capped = text.slice(0, MAX_COMPACT_INSTRUCTIONS_CHARS);
  const lastNl = capped.lastIndexOf("\n");
  return (lastNl === -1 ? capped : capped.slice(0, lastNl)) + COMPACT_INSTRUCTIONS_TRUNCATION;
}

/** The session's standing compact-instructions rider for a workspace root:
 *  the first `## Compact Instructions` section across the loaded
 *  project-context files scanned MOST-SPECIFIC first (project tier over
 *  global). undefined = no rider anywhere. */
export function getCompactInstructionsRider(workspaceRoot: string): string | undefined {
  const files = getProjectContext(workspaceRoot).files;
  for (let i = files.length - 1; i >= 0; i -= 1) {
    const rider = extractCompactInstructions(files[i]?.content ?? "");
    if (rider !== undefined) return rider;
  }
  return undefined;
}

/** Tests only: drop the memo so a fresh load observes new fixture files. */
export function resetProjectContextCacheForTests(): void {
  cache.clear();
  sessionExcludes = [];
}
