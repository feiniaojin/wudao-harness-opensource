// ω99-117 — pure decision layer for shipping playwright-core with the
// bundled-runtime sidecar resources. The browser port does
// `await import("playwright-core")` (bare specifier), which node resolves by
// walking up from the cjs — so a `node_modules/playwright-core` directory
// SIBLING to the bundled wudao-server.cjs makes the browser tools work on a
// fresh Mac with no Node, no npm install. packages/ stays untouched.
//
// Pure on purpose (zero fs imports): build-sea.mjs owns the fs side (copy,
// dereference, node_modules filter) and runs these decisions first so a
// missing package or a lock-drifted version fails the build LOUDLY instead of
// silently shipping a broken browser runtime.
//
// playwright-core 1.63.0 ships with NO dependencies/optionalDependencies/
// peerDependencies at all (verified against its package.json) — copying the
// package body alone is complete; the copy filter still skips any nested
// node_modules as belt-and-braces discipline.

/**
 * The version pnpm resolved for `packages/browser`'s playwright-core
 * dependency, parsed out of pnpm-lock.yaml's importers section. Returns null
 * when the importer or the dependency is absent (the caller treats that as a
 * typed error — an unreadable pin must never become a skipped check).
 *
 * Lock shape being parsed (indentation is the grammar):
 *   importers:
 *     <2sp>packages/browser:
 *       <4sp>dependencies:
 *         <6sp>playwright-core:
 *           <8sp>version: 1.63.0
 */
export function parsePlaywrightPin(lockText, importer = "packages/browser", dep = "playwright-core") {
  const lines = lockText.split("\n");
  const header = `  ${importer}:`;
  const start = lines.findIndex((line) => line === header);
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // Next importer (or a 2-space key inside packages:/snapshots:) ends the block.
    if (/^  \S/.test(line)) return null;
    if (line === `      ${dep}:`) {
      for (let j = i + 1; j < lines.length; j++) {
        const field = lines[j].match(/^ {8}version: (\S+)$/);
        if (field) return field[1];
        if (/^ {6}\S/.test(lines[j])) break; // next dependency key
      }
    }
  }
  return null;
}

/**
 * Decide whether playwright-core may be copied into the resource bundle.
 * Discriminated result: { status: "copy" | "error", ... }.
 */
export function planPlaywrightCoreCopy({ packageJsonFound, onDiskVersion, pinnedVersion, sourceDir }) {
  if (!packageJsonFound) {
    return {
      status: "error",
      code: "PLAYWRIGHT_CORE_MISSING",
      message: `playwright-core not found at ${sourceDir} — run pnpm install --frozen-lockfile; refusing to bundle browser resources without it`,
    };
  }
  if (!pinnedVersion) {
    return {
      status: "error",
      code: "PLAYWRIGHT_PIN_UNREADABLE",
      message: "cannot read the playwright-core pin from pnpm-lock.yaml (packages/browser importer) — refusing to copy an unversioned dependency",
    };
  }
  if (onDiskVersion !== pinnedVersion) {
    return {
      status: "error",
      code: "PLAYWRIGHT_VERSION_MISMATCH",
      expected: pinnedVersion,
      actual: onDiskVersion,
      message: `playwright-core version drift: pnpm-lock pins ${pinnedVersion} but ${sourceDir} carries ${onDiskVersion} — rerun pnpm install --frozen-lockfile`,
    };
  }
  return { status: "copy", version: pinnedVersion, sourceDir, destDir: "node_modules/playwright-core" };
}

/**
 * The bundled-runtime resource manifest (for the build log + release report):
 * what ships next to wudao-server.cjs inside Resources/sidecar-resources/.
 */
export function runtimeResourceManifest({ webFiles, playwright }) {
  const entries = ["wudao-server.cjs", `web (${webFiles.length} files)`];
  if (playwright && playwright.status === "copy") {
    entries.push(`node_modules/playwright-core@${playwright.version}`);
  }
  return entries;
}
