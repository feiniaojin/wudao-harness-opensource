// OOM-fix guardrail — startup sweep of stale run_script RPC dirs AND stale
// python_kernel session dirs (114). run_script (core) creates a private
// `wudao-ptc-*` dir under the OS tmpdir per call; python_kernel keeps ONE
// `wudao-kernel-*` dir per kernel lifetime (lazy spawn → idle reap/crash).
// A crashed/killed run leaks either forever on long-lived machines. Every CLI
// start removes dirs older than the grace window, best-effort: no throw, no
// block (callers fire-and-forget), and nothing matching another prefix is
// touched.
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PYTHON_KERNEL_TMP_PREFIX } from "@wudao/core";

export const RPC_TMP_PREFIX = "wudao-ptc-";
/** Grace window: an in-flight run_script child owns its dir for up to its
 *  120s script timeout; a LIVE python kernel owns its dir for the whole
 *  session (15min idle reap by default), so sweep only clearly-abandoned
 *  dirs — 1h covers both. */
export const STALE_RPC_DIR_MAX_AGE_MS = 60 * 60 * 1000;

const SWEEP_PREFIXES: readonly string[] = [RPC_TMP_PREFIX, PYTHON_KERNEL_TMP_PREFIX];

/** Remove `wudao-ptc-*` / `wudao-kernel-*` dirs under `baseDir` older than
 *  `maxAgeMs`. Returns the removed paths. Never throws — a sweep failure is
 *  a no-op. */
export async function sweepStaleRpcDirs(
  baseDir: string = tmpdir(),
  now: number = Date.now(),
  maxAgeMs: number = STALE_RPC_DIR_MAX_AGE_MS,
): Promise<string[]> {
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch {
    return removed;
  }
  for (const name of entries) {
    if (!SWEEP_PREFIXES.some((p) => name.startsWith(p))) continue;
    const full = join(baseDir, name);
    try {
      const s = await stat(full);
      if (!s.isDirectory()) continue;
      if (now - s.mtimeMs <= maxAgeMs) continue;
      await rm(full, { recursive: true, force: true });
      removed.push(full);
    } catch {
      // best-effort: a raced/permission-denied dir is simply skipped
    }
  }
  return removed;
}
