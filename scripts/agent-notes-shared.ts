/**
 * M73 — Agent Notes: shared, pure gate logic.
 *
 * Two CLIs sit on this module (everything here is import-pure and takes an
 * explicit root, so the vitest suite in packages/cli/tests can exercise
 * valid/invalid fixture trees under os.tmpdir()):
 *
 *   - scripts/verify-agent-notes.ts          — M73 §2: tree + format gate
 *   - scripts/verify-archived-agent-notes.ts — M73 §3: frozen-archive gate
 *
 * The rules themselves are defined in .agents/notes/README.md; this file
 * mechanizes them, it does not own them. Mirrors the upstream's
 * agent-note-tree.ts + archived-agent-notes.ts pair (docs/research/36 §1).
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";

// M73 §1 — the two path axes. Both sets are closed: a folder outside them
// would hold Agent Notes invisible to every gate. Adding a class is a
// deliberate act — extend AGENT_NOTE_CLASSES AND the README's Classification
// table in the same change.

/** The closed set of active lifecycles (top-level folders under .agents/notes/). */
export const AGENT_NOTE_LIFECYCLES = ["proposed", "implemented", "rejected"] as const;
export type AgentNoteLifecycle = (typeof AGENT_NOTE_LIFECYCLES)[number];

/** The closed set of classes (nested folder under each lifecycle). */
export const AGENT_NOTE_CLASSES = [
  "feature",
  "bug-fix",
  "simplification",
  "architecture",
  "process",
  "testing",
] as const;
export type AgentNoteClass = (typeof AGENT_NOTE_CLASSES)[number];

/** Historical implemented notes live outside the active lifecycle tree. */
export const AGENT_NOTE_ARCHIVE = "archived";

/** M73 §2 — the date these format rules took effect; the grandfather comment is valid only before it. */
export const FORMAT_ADOPTED = "2026-08-20";

/** The exact comment a pre-format Agent Note carries in place of `## Alternatives considered`. */
export const ALTERNATIVES_GRANDFATHER =
  "<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->";

/** Status-line grammar per lifecycle folder. */
const STATUS_GRAMMAR: Record<AgentNoteLifecycle, RegExp> = {
  proposed: /^Status: proposed$/,
  implemented: /^Status: implemented$/,
  rejected: /^Status: rejected — .+$/,
};

/** Required `##` headings per lifecycle, beyond the universal `## Problem` opener. */
const REQUIRED_SECTIONS: Record<AgentNoteLifecycle, string[]> = {
  proposed: ["## Proposal", "## Acceptance criteria", "## Risks"],
  implemented: ["## Decision", "## Consequences"],
  rejected: ["## Proposal"],
};

/** M73 §2 — proposal-era spec-speak banned from implemented notes. */
const BANNED_IMPLEMENTED = /^## (?:Proposal\b|Plan\b|Migration plan\b|Acceptance criteria\b)/i;

/** Non-note files the tree walker ignores: skeleton placeholders and the archive manifest. */
const PLACEHOLDER = ".gitkeep";

/** One Agent Note file, as discovered by the walker. */
export interface AgentNoteRef {
  lifecycle: AgentNoteLifecycle;
  /** Path relative to the .agents/notes root, forward slashes. */
  rel: string;
  /** `yyyy-mm-dd` from the filename — the date the topic was first proposed. */
  date: string;
}

function isLifecycle(name: string): name is AgentNoteLifecycle {
  return (AGENT_NOTE_LIFECYCLES as readonly string[]).includes(name);
}

function isClass(name: string): name is AgentNoteClass {
  return (AGENT_NOTE_CLASSES as readonly string[]).includes(name);
}

/**
 * M73 §1 — walk the active Agent Note tree, enforcing the structure rules.
 * Returns every valid note plus one error per violation (unknown lifecycle or
 * class folder, bad depth, bad filename, stray file). A non-empty error list
 * is fatal for the caller.
 */
export function walkAgentNoteTree(root: string): { notes: AgentNoteRef[]; errors: string[] } {
  const notes: AgentNoteRef[] = [];
  const errors: string[] = [];
  // The top-level set is closed too: an unknown directory under .agents/notes/
  // would hold notes invisible to the walk below, and a stray file at the root
  // (a misplaced note) would be invisible to every gate — only README.md lives
  // here (review LOW 1).
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "INDEX.md") {
      errors.push(
        "structure: INDEX.md — centralized Agent Note indexes are forbidden; the lifecycle/class tree is the index",
      );
      continue;
    }
    if (entry.isFile()) {
      if (entry.name !== "README.md") {
        errors.push(
          `structure: ${entry.name} — unexpected file at the notes root (only README.md lives here; notes belong in {lifecycle}/{class}/)`,
        );
      }
      continue;
    }
    if (!entry.isDirectory()) {
      errors.push(`structure: ${entry.name} — only directories and README.md live at the notes root`);
      continue;
    }
    if (entry.name !== AGENT_NOTE_ARCHIVE && !isLifecycle(entry.name)) {
      errors.push(
        `structure: ${entry.name}/ — unknown lifecycle folder (allowed: ${AGENT_NOTE_LIFECYCLES.join(", ")}, plus ${AGENT_NOTE_ARCHIVE}/)`,
      );
    }
  }
  for (const lifecycle of AGENT_NOTE_LIFECYCLES) {
    if (!existsSync(`${root}/${lifecycle}`)) {
      errors.push(`structure: ${lifecycle}/ — required lifecycle folder is missing`);
      continue;
    }
    const classes = readdirSync(`${root}/${lifecycle}`, { withFileTypes: true });
    for (const cls of classes) {
      if (!cls.isDirectory()) {
        errors.push(`structure: ${lifecycle}/${cls.name} — expected a class directory here`);
        continue;
      }
      if (!isClass(cls.name)) {
        errors.push(
          `structure: ${lifecycle}/${cls.name}/ — unknown class folder (allowed: ${AGENT_NOTE_CLASSES.join(", ")})`,
        );
        continue;
      }
      for (const file of readdirSync(`${root}/${lifecycle}/${cls.name}`, { withFileTypes: true })) {
        const rel = `${lifecycle}/${cls.name}/${file.name}`;
        if (file.name === PLACEHOLDER) continue;
        // A future `<base>.zh.md` translation companion is the same note,
        // indexed by its English filename; its consistency is not gated here.
        if (file.name.endsWith(".zh.md")) continue;
        if (!file.isFile()) {
          errors.push(`structure: ${rel} — class directories contain regular files only`);
          continue;
        }
        if (!/^\d{4}-\d{2}-\d{2}-.+\.md$/.test(file.name)) {
          errors.push(`structure: ${rel} — filename must be yyyy-mm-dd-topic.md`);
          continue;
        }
        // Shape is not enough: 2026-13-45-bogus.md must not pass where the
        // archive's `Archived:` dates get a real calendar check (review LOW 2).
        const date = file.name.slice(0, 10);
        if (!validDate(date)) {
          errors.push(`structure: ${rel} — filename date ${date} is not a real calendar date`);
          continue;
        }
        notes.push({ lifecycle, rel, date });
      }
    }
  }
  notes.sort((a, b) => a.rel.localeCompare(b.rel));
  return { notes, errors };
}

/** Strip fenced code blocks: format tokens inside examples are not document
 *  structure. CRLF-tolerant (win32 autocrlf checkouts), same as the line
 *  grammar in checkNoteFormat. */
function proseLines(content: string): string[] {
  let inFence = false;
  return content
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((line) => {
      if (line.startsWith("```")) {
        inFence = !inFence;
        return false;
      }
      return !inFence;
    });
}

/**
 * M73 §2 — check one note's in-file format against its lifecycle's rules.
 * Pure: `content` is the file text, `date` the yyyy-mm-dd from the filename.
 * Returns one error string per violation.
 */
export function checkNoteFormat(lifecycle: AgentNoteLifecycle, content: string, date: string): string[] {
  const errors: string[] = [];
  const fail = (msg: string): void => {
    errors.push(msg);
  };
  // CRLF-tolerant read: a win32 checkout with core.autocrlf=true smudges the
  // corpus to \r\n — the FORMAT grammar is about lines, not terminators (the
  // archived-seal hashes stay byte-exact elsewhere).
  const lines = content.split("\n").map((l) => l.replace(/\r$/, ""));
  const prose = proseLines(content);

  if (!/^# Agent Note: \S/.test(lines[0] ?? "")) fail("line 1 must be `# Agent Note: <title>`");
  if (lines[1] !== "") fail("line 2 must be blank");
  if (!STATUS_GRAMMAR[lifecycle].test(lines[2] ?? "")) {
    fail(`line 3 must match the ${lifecycle} status grammar (${String(STATUS_GRAMMAR[lifecycle])})`);
  }
  if (lines[3] !== "") fail("line 4 must be blank");
  const statusLine = lines[2] ?? "";
  const otherStatus = prose.filter((l) => l.startsWith("Status:") && l !== statusLine);
  if (otherStatus.length > 0 || prose.filter((l) => l === statusLine).length > 1) {
    fail("the line-3 `Status:` line must be the only one in the file");
  }

  const h2s = prose.filter((l) => l.startsWith("## ")).map((l) => l.trimEnd());
  if (h2s[0] !== "## Problem") {
    fail(`the first section must be \`## Problem\` (got ${JSON.stringify(h2s[0] ?? "<none>")})`);
  }
  for (const required of REQUIRED_SECTIONS[lifecycle]) {
    if (!h2s.includes(required)) fail(`missing the required \`${required}\` section`);
  }
  if (lifecycle === "implemented") {
    for (const h2 of h2s.filter((h) => BANNED_IMPLEMENTED.test(h))) {
      fail(
        `\`${h2}\` is a proposal-era heading; an implemented Agent Note states what is (fold it into Decision/Consequences)`,
      );
    }
  }

  const hasSection = h2s.includes("## Alternatives considered");
  const hasGrandfather = prose.includes(ALTERNATIVES_GRANDFATHER);
  if (hasSection && hasGrandfather) {
    fail("carries both `## Alternatives considered` and the grandfather comment — drop the comment");
  }
  if (!hasSection && !hasGrandfather) {
    fail(
      "missing `## Alternatives considered` — a decision recorded without what it beat invites re-litigation (see .agents/notes/README.md § The file format)",
    );
  }
  if (hasGrandfather && date >= FORMAT_ADOPTED) {
    fail(`the grandfather comment is only valid for Agent Notes dated before ${FORMAT_ADOPTED}`);
  }
  return errors;
}

/** M73 §2 — walk + read + format-check the active tree. Also proves the archive manifest parses when present. */
export function verifyActiveNotes(root: string): { noteCount: number; errors: string[] } {
  const { notes, errors } = walkAgentNoteTree(root);
  for (const note of notes) {
    const content = readFileSync(`${root}/${note.rel}`, "utf8");
    for (const e of checkNoteFormat(note.lifecycle, content, note.date)) {
      errors.push(`format: ${note.rel} — ${e}`);
    }
  }
  return { noteCount: notes.length, errors };
}

// ---------------------------------------------------------------------------
// M73 §3 — the frozen archive: sealed artifacts + append-only manifest.
// ---------------------------------------------------------------------------

/** Versioned fields in the frozen-content manifest. */
export interface ArchiveManifest {
  version: 1;
  files: Readonly<Record<string, string>>;
}

/** Hash one archived artifact independently of the repository's Git object format. */
export function archiveContentHash(content: Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse the archive manifest and reject fields or hashes outside its closed schema. */
export function parseArchiveManifest(content: string): ArchiveManifest {
  const value: unknown = JSON.parse(content);
  if (!isRecord(value)) throw new Error("expected a JSON object");
  const fields = Object.keys(value).sort();
  if (fields.join(",") !== "files,version") {
    throw new Error("expected exactly the fields `version` and `files`");
  }
  if (value.version !== 1) throw new Error("unsupported manifest version (expected 1)");
  if (!isRecord(value.files)) throw new Error("`files` must be an object");
  const files: Record<string, string> = {};
  for (const [path, hash] of Object.entries(value.files)) {
    if (typeof hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`invalid content hash for ${path}`);
    }
    files[path] = hash;
  }
  return { version: 1, files };
}

/** Render the archive manifest with deterministic path ordering. */
export function renderArchiveManifest(files: Readonly<Record<string, string>>): string {
  const sorted = Object.fromEntries(
    Object.entries(files).sort(([left], [right]) => left.localeCompare(right)),
  );
  return `${JSON.stringify({ version: 1, files: sorted }, null, 2)}\n`;
}

/** M73 §3 — append-only proof part 1: reject changes or removals of entries sealed by a prior manifest. */
export function validateArchiveManifestExtension(
  baseline: ArchiveManifest,
  current: ArchiveManifest,
): string[] {
  const errors: string[] = [];
  for (const [path, expected] of Object.entries(baseline.files)) {
    const actual = current.files[path];
    if (actual === undefined) errors.push(`${path}: sealed manifest entry is missing`);
    else if (actual !== expected) errors.push(`${path}: sealed manifest hash changed`);
  }
  return errors;
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** The 5-line frozen header every sealed artifact carries (title / blank / status / archive date / blank). */
function validateSealedHeader(path: string, content: Buffer, filenameDate: string): string[] {
  const errors: string[] = [];
  const lines = content.toString("utf8").split("\n");
  if (!/^# Agent Note: \S/.test(lines[0] ?? "")) errors.push(`${path}: line 1 must be \`# Agent Note: <title>\``);
  if (lines[1] !== "") errors.push(`${path}: line 2 must be blank`);
  if (lines[2] !== "Status: implemented") errors.push(`${path}: line 3 must be \`Status: implemented\``);
  const archived = /^Archived: (\d{4}-\d{2}-\d{2})$/.exec(lines[3] ?? "")?.[1];
  if (archived === undefined || !validDate(archived)) {
    errors.push(`${path}: line 4 must be \`Archived: YYYY-MM-DD\` with a valid date`);
  } else if (archived < filenameDate) {
    errors.push(`${path}: archive date ${archived} predates the note filename date`);
  }
  if (lines[4] !== "") errors.push(`${path}: line 5 must be blank`);
  return errors;
}

/**
 * M73 §3 — validate the closed kind tree, the sealed header of every artifact,
 * and complete note/companion units. A companion (`.zh.md` translation, or a
 * future sidecar) may not be sealed without the note file it belongs to; the
 * triplet move rule is the general form: a note and its companions move and
 * seal together or not at all.
 */
export function validateArchiveArtifacts(artifacts: ReadonlyMap<string, Buffer>): string[] {
  const errors: string[] = [];
  const units = new Map<string, { source?: Buffer; companions: string[] }>();
  for (const [path, content] of [...artifacts].sort(([a], [b]) => a.localeCompare(b))) {
    const match = /^([^/]+)\/(\d{4}-\d{2}-\d{2}-.+?)(\.zh\.md|\.i18n\.yaml|\.md)$/.exec(path);
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
      errors.push(`${path}: expected {class}/yyyy-mm-dd-topic.{md,zh.md,i18n.yaml}`);
      continue;
    }
    if (!isClass(match[1])) {
      errors.push(`${path}: unknown Agent Note class ${JSON.stringify(match[1])}`);
      continue;
    }
    const key = `${match[1]}/${match[2]}`;
    const unit = units.get(key) ?? { companions: [] };
    if (match[3] === ".md") unit.source = content;
    else unit.companions.push(path);
    units.set(key, unit);
  }
  for (const [key, unit] of [...units].sort(([a], [b]) => a.localeCompare(b))) {
    if (unit.source === undefined) {
      errors.push(`${key}: companion(s) ${unit.companions.join(", ")} sealed without their note file`);
      continue;
    }
    errors.push(...validateSealedHeader(`${key}.md`, unit.source, basename(key).slice(0, 10)));
  }
  return errors;
}

/**
 * M73 §3 — append-only proof part 2: prove every existing seal still matches
 * the bytes on disk, then (and only then) compute hashes for unsealed
 * artifacts. `--write` persists exactly this extension.
 */
export function extendArchiveManifest(
  existing: ArchiveManifest,
  artifacts: ReadonlyMap<string, Buffer>,
): { files: Record<string, string>; added: string[]; errors: string[] } {
  const errors: string[] = [];
  const files: Record<string, string> = { ...existing.files };
  for (const [path, expected] of Object.entries(existing.files)) {
    const content = artifacts.get(path);
    if (content === undefined) errors.push(`${path}: sealed artifact is missing`);
    else if (archiveContentHash(content) !== expected) errors.push(`${path}: sealed content hash changed`);
  }
  const added: string[] = [];
  for (const [path, content] of [...artifacts].sort(([a], [b]) => a.localeCompare(b))) {
    if (files[path] !== undefined) continue;
    files[path] = archiveContentHash(content);
    added.push(path);
  }
  return { files, added, errors };
}
