// M63-B — the FileChanged watcher: literal filenames from the
// onFileChanged config entries are fs.watch targets. On a change the hook
// commands fire (observer) AND the change reaches the MODEL through the
// steering channel — a turn-boundary user-message append, so the KV-cache
// prefix stays byte-stable (the cache assertion lives in the tests).
//
// Debounce: fs.watch fires a burst per save (rename + change, editor
// patterns); each target carries a cooldown window (default 500ms) — the
// first event of a burst fires, the rest are absorbed. Failures are
// isolated: an unwatchable target (missing file, ENOSPC watchers) warns
// once and drops out — the watcher never takes the session down.
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

export interface FileChangeWatchPlan {
  /** Fire the configured hook commands for this changed target (observer). */
  readonly fire: (path: string) => void | Promise<void>;
  /** Deliver the change to the model (the steering push). */
  readonly deliver: (path: string) => void;
}

export interface FileChangeWatchHandle {
  /** Stop every watcher (idempotent; the driver's dispose calls it). */
  stop(): void;
}

const COOLDOWN_MS = 500;

export function createFileChangeWatcher(
  targets: readonly string[],
  workspaceRoot: string,
  plan: FileChangeWatchPlan,
  warn: (line: string) => void,
  opts?: { readonly cooldownMs?: number },
): FileChangeWatchHandle {
  const cooldown = opts?.cooldownMs ?? COOLDOWN_MS;
  const lastFired = new Map<string, number>();
  const watchers: FSWatcher[] = [];
  const onChange = (name: string): void => {
    const now = Date.now();
    const last = lastFired.get(name) ?? 0;
    if (now - last < cooldown) return;
    lastFired.set(name, now);
    try {
      void plan.fire(name);
    } catch {
      /* observer isolation — the hook failure never breaks delivery */
    }
    try {
      plan.deliver(name);
    } catch {
      /* delivery failure is the queue's business — never fatal here */
    }
  };
  for (const name of targets) {
    const abs = join(workspaceRoot, name);
    try {
      const w = watch(abs, { persistent: false }, () => onChange(name));
      w.on("error", (err: Error) => {
        warn(`⚠️ fileChanged watcher for ${name} stopped: ${err.message}`);
        w.close();
      });
      watchers.push(w);
    } catch (err) {
      warn(`⚠️ fileChanged watcher cannot watch ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {
    stop: () => {
      for (const w of watchers) w.close();
      watchers.length = 0;
    },
  };
}
