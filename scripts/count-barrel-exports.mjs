#!/usr/bin/env node
// ω99-96 — core barrel export-name counter (queue 111 row 3): the
// comment-stripped counting caliber used by the ω99-94/95 barrel-diet
// walkthroughs, promoted from throwaway shells into the repo so the pin test
// (packages/core/tests/barrel-surface.test.ts) and future audits share ONE
// oracle.
//
// Caliber (剥注释口径, ω99-94 report §4.1):
//   1. Strip comments FIRST — `//` line comments and `/* */` block comments,
//      string-literal-aware (a `//` inside a string literal is not a comment).
//      The ω99-94 walkthrough proved the naive per-part `split("//")[0]` parse
//      silently drops every name that follows an in-block comment line
//      (audit 596 / coarse 599 / comment-stripped 605 on the d77b5f8e barrel —
//      the gap is purely comment-position parse artifacts).
//   2. Extract exported NAMES, not import statements: every
//      `export [type] { ... } from "..."` re-export block (multiline; `a as b`
//      counts as `b`; inline `type` specifiers count as the bare name) plus
//      declared exports (`export const/let/var/function/class <name>`).
//      Name-level extraction, not statement-level parsing, is what keeps the
//      counter immune to the miss shapes ω99-95 documented (inline type
//      specifiers, dynamic-import attribute access) — the snapshot pins names.
//   3. Deduplicate; the unique-name count is the barrel's public surface.
//
// NOT tsc: ω99-94 §3 established that TS4023 is structurally silent on pure
// re-export barrels (declaration emit forwards re-exports verbatim and never
// expands signatures), so no compiler gate can see this surface. This script
// is the oracle.
//
// Usage (run from anywhere; paths resolve against the repo root unless the
// argument is an existing file relative to the cwd):
//   node scripts/count-barrel-exports.mjs                 # count, working barrel
//   node scripts/count-barrel-exports.mjs --list          # one name per line, sorted
//   node scripts/count-barrel-exports.mjs --snapshot      # pin-fixture header + sorted names
//   node scripts/count-barrel-exports.mjs <ref>           # count at a git ref
//   node scripts/count-barrel-exports.mjs <ref>:<path>    # count of <path> at <ref>
//   node scripts/count-barrel-exports.mjs <file>          # count of a file on disk
//
// Historical calibration points (comment-stripped caliber, must reproduce):
//   d77b5f8e → 605    67e3236e/c22d511e → 447    3bb660a5 → 325
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BARREL = "packages/core/src/index.ts";
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function fail(message) {
  console.error(String(message));
  process.exit(1);
}

/** Strip `//` and `/* *\/` comments, string-literal-aware; keep everything else
 *  (including newlines) verbatim so spans and offsets stay stable. */
function stripComments(source) {
  let out = "";
  let state = "code"; // code | line | block | single | double | template
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (c === "/" && next === "/") { state = "line"; i++; continue; }
      if (c === "/" && next === "*") { state = "block"; i++; continue; }
      if (c === "'") { state = "single"; out += c; continue; }
      if (c === '"') { state = "double"; out += c; continue; }
      if (c === "`") { state = "template"; out += c; continue; }
      out += c;
      continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += c; }
      continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") { state = "code"; i++; }
      continue;
    }
    // Inside a string literal: emit verbatim (keeps `//`-in-URLs intact) and
    // leave on the matching unescaped quote.
    out += c;
    if (c === "\\") { out += next ?? ""; i++; continue; }
    if ((state === "single" && c === "'") || (state === "double" && c === '"') || (state === "template" && c === "`")) {
      state = "code";
    }
  }
  return out;
}

/** Names exported by the (comment-stripped) barrel source. */
function extractExportNames(source) {
  const names = [];
  const stripped = stripComments(source);
  // Re-export blocks: `export [type] { ... } from "spec";` (multiline blocks,
  // comma/newline-separated members, optional `a as b` aliases).
  const reExport = /export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(?:"[^"\n]+"|'[^'\n]+')/g;
  for (const block of stripped.matchAll(reExport)) {
    for (const member of block[1].split(",")) {
      let name = member.trim();
      name = name.replace(/^type\s+/, "");
      if (name.includes(" as ")) name = name.split(" as ").pop().trim();
      if (IDENT.test(name)) names.push(name);
    }
  }
  // Declared exports at the barrel top level (`export const PACKAGE_NAME = ...`).
  const declared = /export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\s*\*?|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  for (const decl of stripped.matchAll(declared)) names.push(decl[1]);
  return [...new Set(names)];
}

/** Resolve the positional source argument to barrel source text:
 *  existing file path → read; `ref:path` → git show; bare ref → git show at
 *  the default barrel path. */
function readSource(spec) {
  if (spec === undefined) return readFileSync(resolve(REPO_ROOT, DEFAULT_BARREL), "utf8");
  const asFile = resolve(process.cwd(), spec);
  if (existsSync(asFile)) return readFileSync(asFile, "utf8");
  const colon = spec.indexOf(":");
  let ref = spec;
  let path = DEFAULT_BARREL;
  if (colon !== -1) {
    ref = spec.slice(0, colon);
    path = spec.slice(colon + 1);
  }
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    fail(`cannot resolve source "${spec}" (not an existing file, and git show ${ref}:${path} failed): ${error.stderr ?? error.message}`);
  }
}

const args = process.argv.slice(2);
const mode = args.filter((a) => a === "--list" || a === "--snapshot")[0] ?? "--count";
const spec = args.find((a) => !a.startsWith("--"));
const names = extractExportNames(readSource(spec)).sort();

if (mode === "--list") {
  console.log(names.join("\n"));
} else if (mode === "--snapshot") {
  const barrel = spec ?? DEFAULT_BARREL;
  console.log(`# wudao core barrel surface snapshot (omega99-96 pin fixture)`);
  console.log(`# caliber: comment-stripped export-name parse — see omega99-94 report §4.1;`);
  console.log(`# audit-596/coarse-599 historical deltas are comment-position parse artifacts.`);
  console.log(`# names: ${names.length} (sorted; one identifier per line)`);
  console.log(`# regenerate from the repo root:`);
  console.log(`#   node scripts/count-barrel-exports.mjs --snapshot ${barrel} > packages/core/tests/fixtures/barrel-surface.txt`);
  console.log(names.join("\n"));
} else {
  console.log(names.length);
}
