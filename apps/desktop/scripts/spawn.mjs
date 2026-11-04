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

  // PATH shims — TWO shapes must parse (0.4.21 Windows CI 首航揭发):
  //  - global npm (%APPDATA%\npm): "%_prog%"  "%dp0%\node_modules\..."
  //  - 工具链装的 bin 目录（actions 的 setup-pnpm 落 PNPM_HOME=…\node_modules\.bin，
  //    即仓库本地形状）: node "%~dp0\..\pnpm\bin\pnpm.cjs" — 此前只认前者，
  //    pnpm 解析不到 → 裸 spawn .CMD → status null（build-sea: command failed (null)）。
  const pathDirs = String(process.env.PATH ?? "").split(";");
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const shimName of [`${cmd}.CMD`, `${cmd}.cmd`]) {
      const shim = join(dir, shimName);
      if (!existsSync(shim)) continue;
      const text = readFileSync(shim, "utf8");
      // resolve() 在 win32 上折叠 .. 段（%~dp0\.. 型目标）；别处无害。
      const raw = entryFromShimText(text, dir);
      const entry = raw === null ? null : resolve(raw);
      if (entry && isAbsolute(entry) && existsSync(entry)) {
        const resolved = { exe: process.execPath, prefix: [entry], env: {} };
        const nodePath = nodePathFromCmd(text);
        if (nodePath) resolved.env.NODE_PATH = nodePath;
        return resolved;
      }
    }
  }

  return null; // a real .exe on PATH (cargo, tar, ...) — spawn as-is
}

/** spawnSync that understands pnpm-installed .CMD shims on Windows. */
export function runSync(cmd, args, opts = {}) {
  const resolved = resolveCommand(cmd, { cwd: opts.cwd });
  if (resolved) {
    const { exe, prefix, env } = resolved;
    return spawnSync(exe, [...prefix, ...args], { ...opts, env: { ...opts.env, ...env } });
  }
  // 兜底：win32 上解析不出的裸命令（.CMD shim 形状超出上面两种——
  // 0.4.21 两轮 CI 实证 setup-pnpm 的 pnpm.CMD 两种都不匹配）交给
  // shell 生成：cmd.exe 自己解析 .CMD，与 npm script 的运行方式一致。
  // DEP0190 只对含 shell 元字符的参数报警——本管线的参数（filter 名/
  // build/静态路径）均不含。
  if (process.platform === "win32" && !/[\\/]/.test(cmd)) {
    return spawnSync(cmd, args, { ...opts, shell: true });
  }
  return spawnSync(cmd, args, opts);
}

/** Async spawn with the same shim resolution. */
export function runAsync(cmd, args, opts = {}) {
  const resolved = resolveCommand(cmd, { cwd: opts.cwd });
  if (resolved) {
    const { exe, prefix, env } = resolved;
    return spawn(exe, [...prefix, ...args], { ...opts, env: { ...opts.env, ...env } });
  }
  if (process.platform === "win32" && !/[\\/]/.test(cmd)) {
    return spawn(cmd, args, { ...opts, shell: true });
  }
  return spawn(cmd, args, opts);
}
