import { resolve, relative, sep } from "node:path";
import { realpath, readdir, lstat } from "node:fs/promises";

export type WorkspaceResolution = { ok: true; absPath: string } | { ok: false; error: string };

// Resolve inputPath against workspaceRoot and ensure the real path stays inside the root.
// Returns {ok:false,error} on escape; never throws.
export async function resolveWorkspacePath(workspaceRoot: string, inputPath: string): Promise<WorkspaceResolution> {
  // Normalize root to strip trailing separators - prevents bypass with "/root/"
  workspaceRoot = resolve(workspaceRoot);
  const candidate = resolve(workspaceRoot, inputPath);

  // Fast path: lexical containment check
  const rel = relative(workspaceRoot, candidate);
  if (rel.startsWith(`..${sep}`) || rel === `..`) {
    return { ok: false, error: `path escapes workspace: ${inputPath}` };
  }

  const rootReal = await safeRealpath(workspaceRoot);
  if (rootReal === undefined) {
    return { ok: false, error: `workspace root not found: ${workspaceRoot}` };
  }

  // Walk existing components from the root, verifying each realpath step.
  // This catches symlinked intermediate directories even when the final
  // component (the file being written) does not exist yet.
  // POSIX-only `sep`-based split is acceptable: this repo targets darwin/linux.
  const rootParts = workspaceRoot.split(sep);
  const candParts = candidate.split(sep);
  if (candParts.length <= rootParts.length) {
    // candidate equals the root (true ancestors were rejected by lexical check above)
    const real = await safeRealpath(candidate);
    return real === undefined
      ? { ok: true, absPath: candidate }
      : { ok: true, absPath: real };
  }
  const tail = candParts.slice(rootParts.length); // components under the root
  let verified = rootReal;
  for (let i = 0; i < tail.length; i++) {
    const part = tail[i];
    if (part === undefined || part === "") continue;
    const next = `${verified}${sep}${part}`;
    const real = await safeRealpath(next);
    if (real === undefined) {
      // Component couldn't be realpath'd. Check if it exists at all.
      if (await pathExists(next)) {
        // Name exists but realpath failed → dangling symlink or similar → deny.
        return { ok: false, error: `path escapes workspace (symlink?): ${inputPath}` };
      }
      // Name truly absent: everything after is new — join onto verified.
      const absPath = [verified, ...tail.slice(i)].join(sep);
      return { ok: true, absPath };
    }
    const relReal = relative(rootReal, real);
    if (relReal.startsWith(`..${sep}`) || relReal === "..") {
      return { ok: false, error: `path escapes workspace (symlink?): ${inputPath}` };
    }
    verified = real;
  }
  return { ok: true, absPath: verified };
}

async function safeRealpath(p: string): Promise<string | undefined> {
  try {
    return await realpath(p);
  } catch {
    return undefined;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

// Recursively list regular files under root as paths RELATIVE to root.
// Skips node_modules and dotfile entries. Used by glob/grep.
// ω99-30 (F): `dotDirsAllowed` — the pattern-is-intent seam. A dot entry is
// listed (and a dot directory descended into) ONLY when its name is
// explicitly allow-listed by the caller; glob derives that set from the
// literal dot segments the pattern NAMES (`.wudao/**` enters .wudao — an
// implicit `**/*` names nothing, so the default face is unchanged, byte for
// byte). Absent/empty set = today's behavior; node_modules stays
// unconditionally skipped no matter what the set says.
export async function listWorkspaceFiles(root: string, dotDirsAllowed?: ReadonlySet<string>): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      if (entry.name.startsWith(".") && !(dotDirsAllowed !== undefined && dotDirsAllowed.has(entry.name))) continue;
      const full = dir + "/" + entry.name;
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(full.slice(root.length + 1));
    }
  }
  await walk(root);
  return out;
}
