/**
 * M73 §3 — verify and append-seal the frozen Agent Note archive
 * (a reference harness's 115-line equivalent, docs/research/36 §1).
 *
 * Prove-every-seal-then-append: the gate first proves every manifest seal
 * still matches the bytes on disk and that no previously sealed entry was
 * changed or removed (append-only, checked against the baseline manifest from
 * git — WUDAO_ARCHIVE_BASE_REF overrides the default HEAD), and only then,
 * under `--write`, appends hashes for newly archived artifacts. A sealed
 * artifact is permanently frozen: editing it fails here, by design.
 *
 * Usage: node --experimental-strip-types scripts/verify-archived-agent-notes.ts [--root <dir>] [--write]
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AGENT_NOTE_CLASSES,
  extendArchiveManifest,
  parseArchiveManifest,
  renderArchiveManifest,
  validateArchiveArtifacts,
  validateArchiveManifestExtension,
  type ArchiveManifest,
} from "./agent-notes-shared.ts";

const args = process.argv.slice(2);
const writeMode = args.includes("--write");
const rootFlag = args.indexOf("--root");
const parsedOk =
  args.every((a, i) => a === "--write" || a === "--root" || (rootFlag !== -1 && i === rootFlag + 1)) &&
  (rootFlag === -1 || (rootFlag + 1 < args.length && args[rootFlag + 1] !== "--write"));
let root = resolve(import.meta.dirname, "../.agents/notes");
if (!parsedOk) {
  console.error("verify-archived-agent-notes: usage: node scripts/verify-archived-agent-notes.ts [--root <dir>] [--write]");
  process.exit(2);
}
if (rootFlag !== -1) root = resolve(args[rootFlag + 1] ?? ".");

const archiveRoot = resolve(root, "archived");
// The opensource distribution ships no `.agents/notes/` tree (it is the
// internal development audit trail, deliberately excluded by sync) — a
// missing tree means there is nothing to verify, not a violation.
if (!existsSync(archiveRoot)) {
  console.log(`verify-archived-agent-notes: no archive at ${archiveRoot}; nothing to verify.`);
  process.exit(0);
}
const manifestRepoPath = ".agents/notes/archived/manifest.json";
const errors: string[] = [];

// M73 §3 — the archive tree: only README.md and manifest.json at the root,
// one directory per class (all six required), regular files inside.
const allowedRootFiles = new Set(["README.md", "manifest.json"]);
if (!existsSync(resolve(archiveRoot, "README.md"))) errors.push("archived/README.md is required");
const artifacts = new Map<string, Buffer>();
const kinds = new Set<string>();
for (const entry of readdirSync(archiveRoot, { withFileTypes: true })) {
  if (entry.isFile()) {
    if (!allowedRootFiles.has(entry.name)) errors.push(`archived/${entry.name}: unexpected root file`);
    continue;
  }
  if (!entry.isDirectory()) {
    errors.push(`archived/${entry.name}: only regular files and class directories are allowed`);
    continue;
  }
  if (!(AGENT_NOTE_CLASSES as readonly string[]).includes(entry.name)) {
    errors.push(`archived/${entry.name}/: unknown Agent Note class`);
    continue;
  }
  kinds.add(entry.name);
  for (const child of readdirSync(resolve(archiveRoot, entry.name), { withFileTypes: true })) {
    if (!child.isFile()) {
      errors.push(`archived/${entry.name}/${child.name}: class directories contain regular files only`);
      continue;
    }
    if (child.name === ".gitkeep") continue;
    artifacts.set(`${entry.name}/${child.name}`, readFileSync(resolve(archiveRoot, entry.name, child.name)));
  }
}
for (const kind of AGENT_NOTE_CLASSES) {
  if (!kinds.has(kind)) errors.push(`archived/${kind}/: required class directory is missing`);
}
errors.push(...validateArchiveArtifacts(artifacts));

function runGit(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git exited with status ${result.status}`);
  return result.stdout;
}

/** Read the pre-change manifest the append-only proof compares against. */
function readBaselineManifest(ref: string, cwd: string): ArchiveManifest {
  runGit(["cat-file", "-e", `${ref}^{commit}`], cwd);
  const listed = runGit(["ls-tree", "--name-only", ref, "--", manifestRepoPath], cwd).trim();
  if (listed === "") return { version: 1, files: {} };
  return parseArchiveManifest(runGit(["show", `${ref}:${manifestRepoPath}`], cwd));
}

const manifestPath = resolve(archiveRoot, "manifest.json");
let manifest: ArchiveManifest = { version: 1, files: {} };
if (existsSync(manifestPath)) {
  try {
    manifest = parseArchiveManifest(readFileSync(manifestPath, "utf8"));
  } catch (error: unknown) {
    errors.push(`archived/manifest.json: ${error instanceof Error ? error.message : String(error)}`);
  }
} else if (!writeMode) {
  errors.push("archived/manifest.json is required; seal new artifacts with `pnpm run verify-archived-agent-notes -- --write`");
}

// CI supplies its trusted pre-change commit; local writes compare with committed HEAD.
const baselineRef = process.env.WUDAO_ARCHIVE_BASE_REF ?? "HEAD";
try {
  const baseline = readBaselineManifest(baselineRef, resolve(root, "../.."));
  errors.push(...validateArchiveManifestExtension(baseline, manifest));
} catch (error: unknown) {
  errors.push(
    `archived/manifest.json: cannot read baseline ${JSON.stringify(baselineRef)}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

const extended = extendArchiveManifest(manifest, artifacts);
errors.push(...extended.errors);
if (!writeMode) {
  for (const path of extended.added) errors.push(`${path}: archived artifact is not sealed in manifest.json`);
}

if (errors.length > 0) {
  console.error("verify-archived-agent-notes: archive rules violated:");
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}

if (writeMode) {
  const rendered = renderArchiveManifest(extended.files);
  if (!existsSync(manifestPath) || readFileSync(manifestPath, "utf8") !== rendered) {
    writeFileSync(manifestPath, rendered);
  }
  console.log(`verify-archived-agent-notes: sealed ${extended.added.length} new artifact(s); existing seals unchanged.`);
} else {
  console.log(`verify-archived-agent-notes: ${artifacts.size} frozen artifact(s) checked across ${kinds.size} class(es).`);
}
