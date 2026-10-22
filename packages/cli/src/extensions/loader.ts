// M39: extension loading. Extensions = `.wudao/extensions/*.mjs` — pure ESM,
// zero build — each default-exporting a factory:
//
//   export default function wudaoExtension(api) { … }
//
// Loading is EXECUTION: dynamic import() runs the file, then the factory runs
// with full user privileges. There is no sandbox and (by design) no kill
// switch short of deleting the file — the trust decision happens when you put
// code in the workspace, exactly like hook commands and MCP servers.
//
// Failure posture (warn-not-crash, mirroring plugins/MCP/skills): a missing
// directory is silent; an unimportable file, a missing/non-function default
// export, or a throwing factory warns and skips THAT extension — the CLI and
// every other extension keep working. Filenames are deduped defensively;
// Node's module cache makes a re-import of the same URL a no-op factory-wise
// only across loaders, so a fresh loadExtensions call re-runs factories into
// a fresh collector (tests rely on unique names).
import { statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { VERSION } from "../version.js";
import { createExtensionApi, createExtensionState, finalizeExtensionRuntime } from "./api.js";
import type { ExtensionRuntime, ExtensionWarn } from "./api.js";

export interface LoadExtensionsOptions {
  /** Reported through api.meta.version (defaults to the CLI's VERSION). */
  readonly version?: string;
  readonly warn?: ExtensionWarn;
  /** Loaded plugin command names — an extension command colliding with one
   *  is rejected (builtin/plugin precedence; builtins are always rejected). */
  readonly pluginCommandNames?: readonly string[];
  /** M40 §1: per-call timeout (ms) for every registered event handler.
   *  Defaults to WUDAO_EXTENSION_TIMEOUT_MS / 10s; 0 disables. */
  readonly timeoutMs?: number;
}

function defaultWarn(msg: string): void {
  process.stderr.write(`⚠️ ${msg}\n`);
}

/** Real-file check that follows symlinked entries (a symlinked .mjs is as
 *  loadable as a plain one). */
function isLoadableFile(entry: Dirent): boolean {
  if (entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(join(entry.parentPath, entry.name)).isFile();
  } catch {
    return false;
  }
}

export async function loadExtensions(workspaceRoot: string, opts: LoadExtensionsOptions = {}): Promise<ExtensionRuntime> {
  const warn = opts.warn ?? defaultWarn;
  const { state, binding, collector } = createExtensionState({
    version: opts.version ?? VERSION,
    workspaceRoot,
  });

  let entries: readonly Dirent[];
  try {
    entries = await readdir(join(workspaceRoot, ".wudao", "extensions"), { withFileTypes: true });
  } catch {
    entries = []; // no extensions dir → extensions simply off, no noise
  }

  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.name.endsWith(".mjs")) {
      if (/\.(js|cjs|ts|mts)$/.test(entry.name) && isLoadableFile(entry)) {
        warn(`extension file ${join(".wudao", "extensions", entry.name)} is not .mjs — extensions are plain ESM (*.mjs), no build step; skipped`);
      }
      continue;
    }
    if (!isLoadableFile(entry)) continue;
    if (seen.has(entry.name)) continue; // defensive: readdir never repeats, this pins it
    seen.add(entry.name);

    const stem = entry.name.slice(0, -".mjs".length);
    const filePath = join(workspaceRoot, ".wudao", "extensions", entry.name);
    let mod: unknown;
    try {
      mod = await import(pathToFileURL(filePath).href);
    } catch (err) {
      warn(`extension ${stem}: failed to import ${filePath} (${err instanceof Error ? err.message : String(err)}); skipped`);
      continue;
    }
    const factory = (mod as { default?: unknown } | undefined)?.default;
    if (typeof factory !== "function") {
      warn(`extension ${stem}: ${entry.name} must default-export a factory function (export default function wudaoExtension(api) { … }); skipped`);
      continue;
    }
    const api = createExtensionApi(stem, collector, state, {
      ...(opts.warn ? { warn: opts.warn } : {}),
      pluginCommandNames: opts.pluginCommandNames ?? [],
    });
    try {
      await (factory as (api: unknown) => void | Promise<void>)(api);
    } catch (err) {
      warn(`extension ${stem}: factory threw (${err instanceof Error ? err.message : String(err)}); skipped`);
      continue;
    }
    names.push(stem);
  }

  return finalizeExtensionRuntime(names, collector, state, binding, {
    warn,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
}
