// Cross-platform CLI spawn — the Windows half of the build pipeline.
//
// pnpm / postject / tauri installed by pnpm are `.CMD` shims on win32, and
// Node's spawn/spawnSync without `shell: true` cannot exec a .CMD (ENOENT).
// Spawning with shell:true would work but mangles args (DEP0190). The robust
// route: read the shim, extract the JS entry it forwards to, and run that
// under the current node directly — same command, same args, no shell.
//
// pnpm's .CMD shims have two shapes:
//   - repo-local (node_modules/.bin): `%~dp0\..\<pkg>\dist\cli.js` plus a
//     NODE_PATH preamble the entry may resolve deps through;
//   - global npm shims (`pnpm -g`): `"%_prog%"  "%dp0%\node_modules\..."`.
// Both are parsed; the sh-style shim (no .CMD present) is too.
//
// Non-win32 hosts return the command untouched (unix PATH semantics).

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** Extract the JS entry path from a .CMD (pnpm/npm) or sh shim's text. */
function entryFromShimText(text, shimDir) {
  // pnpm repo-local: node  "%~dp0\..\<pkg>\dist\cli.js" %*
  let m = text.match(/(?:"%~dp0\\node\.exe"|%~dp0\\node\.exe|node)\s+"(%~dp0\\[^"]+)"/i);
  if (m) return m[1].replace(/%~dp0\\/gi, shimDir);
  // npm global: "%_prog%"  "%dp0%\node_modules\pnpm\bin\pnpm.cjs" %*
  m = text.match(/"%_prog%"\s+"(%dp0%[^"]+)"/i);
  if (m) return m[1].replace(/%dp0%/gi, shimDir);
  // sh shim: exec "$basedir/node"  "$basedir/node_modules/pnpm/bin/pnpm.cjs" "$@"
  m = text.match(/exec\s+"?[^"\n]*node"?\s+"(\$basedir\/[^"]+)"/);
  if (m) return m[1].replaceAll("$basedir", shimDir.replace(/\\/g, "/"));
  return null;
}

/** Extract the NODE_PATH=... value a pnpm .CMD shim sets, if any. */
function nodePathFromCmd(text) {
  const m = text.match(/@SET "NODE_PATH=([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * Resolve a bare command to a spawnable { exe, prefix, env } or null when the
 * command should be spawned as-is (absolute path, .exe, non-win32).
 */
export function resolveCommand(cmd, { cwd } = {}) {
  if (process.platform !== "win32") return null;
  if (/[\\/]/.test(cmd) || cmd.toLowerCase().endsWith(".exe")) return null;

  // Walk up from cwd (or the desktop app dir) to the workspace root —
  // build-sea runs with cwd=APPS_DIR or REPO_ROOT.
  const bases = [cwd, DESKTOP_DIR, join(DESKTOP_DIR, "..", "..")].filter(Boolean);
  for (const base of bases) {
    const binDir = join(resolve(base), "node_modules", ".bin");
    for (const shimName of [`${cmd}.CMD`, cmd]) {
      const shim = join(binDir, shimName);
      if (!existsSync(shim)) continue;
      const text = readFileSync(shim, "utf8");
      const entry = entryFromShimText(text, binDir);
      if (!entry || !isAbsolute(entry) || !existsSync(entry)) continue;
      const resolved = { exe: process.execPath, prefix: [entry], env: {} };
      const nodePath = shimName.endsWith(".CMD") ? nodePathFromCmd(text) : null;
      if (nodePath) {
        resolved.env.NODE_PATH = process.env.NODE_PATH
          ? `${nodePath};${process.env.NODE_PATH}`
          : nodePath;
      }
      return resolved;
    }
  }

  // Global npm shim (pnpm itself lives in %APPDATA%\npm, not the workspace):
  // scan PATH for <cmd>.cmd / <cmd>.CMD and use its %dp0%-style entry.
  const pathDirs = String(process.env.PATH ?? "").split(";");
  for (const dir of pathDirs) {
    if (!dir) continue;
    const shim = join(dir, `${cmd}.cmd`);
    if (!existsSync(shim)) continue;
    const text = readFileSync(shim, "utf8");
    const m = text.match(/"%_prog%"\s+"(%dp0%[^"]+)"/i);
    if (!m) continue;
    const entry = m[1].replace(/%dp0%/gi, dir);
    if (existsSync(entry)) return { exe: process.execPath, prefix: [entry], env: {} };
  }

  return null; // a real .exe on PATH (cargo, tar, ...) — spawn as-is
}

/** spawnSync that understands pnpm-installed .CMD shims on Windows. */
export function runSync(cmd, args, opts = {}) {
  const resolved = resolveCommand(cmd, { cwd: opts.cwd });
  if (!resolved) return spawnSync(cmd, args, opts);
  const { exe, prefix, env } = resolved;
  return spawnSync(exe, [...prefix, ...args], { ...opts, env: { ...opts.env, ...env } });
}

/** Async spawn with the same shim resolution. */
export function runAsync(cmd, args, opts = {}) {
  const resolved = resolveCommand(cmd, { cwd: opts.cwd });
  if (!resolved) return spawn(cmd, args, opts);
  const { exe, prefix, env } = resolved;
  return spawn(exe, [...prefix, ...args], { ...opts, env: { ...opts.env, ...env } });
}
