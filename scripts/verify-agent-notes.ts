/**
 * M73 §2 — the Agent Notes format gate.
 *
 * Walks the active `.agents/notes/` tree and enforces: the closed
 * lifecycle/class folder sets, the exact 3-line header with a status that
 * agrees with the folder, the lifecycle-specific body skeleton, the absence
 * of proposal-era headings in implemented notes, and the mandatory
 * `## Alternatives considered` section. Also proves the archived manifest
 * parses when present (seal matching belongs to verify-archived-agent-notes).
 * The rules are defined in .agents/notes/README.md § The file format.
 *
 * Usage: node --experimental-strip-types scripts/verify-agent-notes.ts [--root <dir>]
 * (`--root` exists so the vitest suite can point the gate at fixture trees.)
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseArchiveManifest,
  verifyActiveNotes,
  type ArchiveManifest,
} from "./agent-notes-shared.ts";

const args = process.argv.slice(2);
let root = resolve(import.meta.dirname, "../.agents/notes");
if (args.length === 2 && args[0] === "--root") {
  root = resolve(args[1] ?? ".");
} else if (args.length !== 0) {
  console.error("verify-agent-notes: usage: node scripts/verify-agent-notes.ts [--root <dir>]");
  process.exit(2);
}

// The opensource distribution ships no `.agents/notes/` tree (it is the
// internal development audit trail, deliberately excluded by sync) — a
// missing tree means there is nothing to verify, not a violation.
if (!existsSync(root)) {
  console.log(`verify-agent-notes: no active Agent Notes tree at ${root}; nothing to verify.`);
  process.exit(0);
}

const { noteCount, errors } = verifyActiveNotes(root);

// The frozen archive's manifest must at least parse here; a missing manifest
// is the archive gate's error to report (it offers the --write remedy).
const manifestPath = resolve(root, "archived/manifest.json");
if (existsSync(manifestPath)) {
  try {
    parseArchiveManifest(readFileSync(manifestPath, "utf8")) as ArchiveManifest;
  } catch (error: unknown) {
    errors.push(`archived/manifest.json: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (errors.length === 0) {
  console.log(
    `verify-agent-notes: ${noteCount} Agent Note(s) checked, all conform to .agents/notes/README.md.`,
  );
  process.exit(0);
}

console.error("verify-agent-notes: violations found:");
for (const e of errors) console.error(`  ${e}`);
process.exit(1);
