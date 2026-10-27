// ω99-325 — the census-side derivation of the FULL sheet text. src/styles.css
// is an ordered @import shell (cascade order = the invariant); text censuses
// need the concatenated bytes of all pieces in THAT order. Pure fs + cwd
// anchor (jsdom-pragma safe — the 306 import.meta.url lesson); order is
// derived FROM the shell itself — single source, no drift. A shell line
// referencing a missing piece throws (fail-loud, never a short census).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");

const shell = readFileSync(join(SRC, "styles.css"), "utf8");
const order = [...shell.matchAll(/@import\s+url\("\.\/(.*?)"\);/g)]
  .map((m) => m[1])
  .filter((rel): rel is string => rel !== undefined);

if (order.length === 0) {
  throw new Error("styles-source: styles.css has no @import lines — shell shape changed?");
}

/** Every piece file actually present (dir scan) — must match the shell set. */
const present = readdirSync(join(SRC, "styles")).filter((f) => f.endsWith(".css"));
const orphans = present.filter((f) => !order.some((o) => o.endsWith(`/${f}`)));
if (orphans.length > 0) {
  throw new Error(`styles-source: piece(s) not imported by the shell: ${orphans.join(", ")}`);
}

/** The ordered piece file paths (absolute) — for censuses that walk files. */
export const stylesPieceFiles: readonly string[] = order.map((rel) => join(SRC, rel));

/** The full sheet text — the concatenation, in shell order, of every piece. */
export const stylesCss: string = order
  .map((rel) => readFileSync(join(SRC, rel), "utf8"))
  .join("\n");

/** Same text, function form for call-site idioms that read lazily. */
export const readStyles = (): string => stylesCss;
