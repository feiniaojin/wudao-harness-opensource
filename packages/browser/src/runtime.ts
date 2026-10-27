// ω99-112 — the browser runtime: one controlled browser per session, with a
// closed→launching→open state machine, launch-once memoization (concurrent
// tool calls share one launch), a 10-minute idle reaper (every tool call
// resets it; the visible window closes itself when the model stops using
// it), a process-exit hook belt-and-braces over playwright's own signal
// handling, and the snapshot ref store with navigation invalidation.
// Construction is ZERO-IO: nothing spawns, nothing stats, nothing reads env
// until the first openPage() — safe to build at every frontend boot seam.
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserHandle, BrowserPort, PageHandle } from "./port.js";
import { createPlaywrightPort } from "./port.js";
import { browserRoot, ensureChromiumDownloaded, installedExecutablePath } from "./download.js";
// ω99-139: type-only (the same one-way type dependency snapshot.ts already has
// on this module) — SnapshotRefEntry carries the element's bbox so
// browser_click_xy's hit-test can read geometry out of the ref store.
import type { ElementBbox } from "./snapshot.js";

/** The idle reaper's window: 10 minutes of no tool calls → the page and the
 *  browser close (no orphan windows after the model wanders off). */
export const DEFAULT_IDLE_MS = 10 * 60_000;

export type BrowserState = "closed" | "launching" | "open";

/** The last snapshot's ref→element mapping (see snapshot.ts). */
export interface SnapshotRefEntry {
  readonly selector: string;
  readonly desc: string;
  /** ω99-114: the input's type attribute when the collector saw one.
   *  "password" arms the fail-closed typing gate in tools.ts (the model
   *  never types passwords); undefined means unknown — NOT password — and
   *  never blocks typing (fail-closed fires only on certain knowledge). */
  readonly type?: string;
  /** ω99-139: the element's viewport rect in CSS pixels when the collector
   *  reported one (136's ElementBbox) — browser_click_xy's hit-test source.
   *  Absent = geometry not collected, never guessed; it never gates click/type. */
  readonly bbox?: ElementBbox;
}
export interface PageSnapshotRefs {
  readonly url: string;
  readonly refs: ReadonlyMap<string, SnapshotRefEntry>;
}

/** The executable resolution decision (pure; order pinned by tests):
 *  env override → the downloaded/installed kernel → the driver's registry. */
export type ExecutableResolution =
  | { readonly kind: "executable"; readonly path: string }
  | { readonly kind: "registry" };

export function resolveExecutablePath(
  env: Record<string, string | undefined>,
  installed: string | null,
): ExecutableResolution {
  const fromEnv = (env["WUDAO_BROWSER_EXECUTABLE"] ?? "").trim();
  if (fromEnv !== "") return { kind: "executable", path: fromEnv };
  if (installed !== null) return { kind: "executable", path: installed };
  return { kind: "registry" };
}

/** Honest launch failure (model-facing): what broke + the one-sentence way
 *  out. Every launch-path failure surfaces THIS shape, never a raw stack. */
export function browserLaunchError(reason: string): Error {
  return new Error(
    `Browser launch failed (${reason}). The Chromium kernel auto-downloads to ~/.wudao-desktop/browser on first use; to prepare it manually, point WUDAO_BROWSER_EXECUTABLE at a local Chromium executable and retry.`,
  );
}

export interface BrowserRuntimeOptions {
  readonly port?: BrowserPort;
  /** default ~/.wudao-desktop (the desktop app's data home). */
  readonly homeDir?: string;
  /** default () => process.env (read at LAUNCH time, not construction). */
  readonly env?: () => Record<string, string | undefined>;
  readonly idleMs?: number;
  /** E2E lane may force headless; product default is headful (围观). */
  readonly headless?: boolean;
  /** ω99-114 persistent login profile: the userDataDir the browser launches
   *  with, so cookies/logins survive process restarts (a site the user
   *  logged into once in the visible window is still logged in next time).
   *  Default <home>/browser/profile — the SAME root as the kernel download
   *  (download.ts's browserRoot), never the user's daily browser profile.
   *  Created lazily on first launch; construction stays zero-IO. Tests/E2E
   *  may inject a temp dir. */
  readonly userDataDir?: string;
  /** default: ensureChromiumDownloaded (first-use download). */
  readonly download?: (homeDir: string) => Promise<{ readonly executablePath: string }>;
  /** default: installedExecutablePath (the ~/.wudao-desktop/browser probe). */
  readonly resolveInstalled?: (homeDir: string) => Promise<string | null>;
  /** default: node:fs/promises mkdir({recursive:true}). Injected as an
   *  immediate no-op by fake-timer choreographies (a real-IO mkdir cannot
   *  settle inside advanceTimersByTimeAsync, which yields only microtasks
   *  and fake timers); the A-2 battery keeps the real default and asserts
   *  the directory truly materializes. */
  readonly profileMkdir?: (dir: string) => Promise<void>;
  /** default: process.once("exit", fn); returns the unregister. */
  readonly registerExitHook?: (fn: () => void) => () => void;
  /** ω99-112 SEA degrade: the probe for the single-file desktop bundle.
   *  Default: node:sea's isSea(). Under SEA the launch fails FAST with the
   *  honest posture (the bundle ships playwright-core as an esbuild external
   *  — its internal requires cannot bundle), instead of a module-not-found
   *  stack or a silent hang. Terminal/dev mode is unaffected. */
  readonly seaProbe?: () => boolean;
}

export interface BrowserRuntime {
  state(): BrowserState;
  /** Launch-if-needed (memoized) + reset the idle reaper. Rejects with the
   *  honest browserLaunchError on any launch-path failure. */
  openPage(): Promise<PageHandle>;
  /** Reset the idle window (every tool call rides this). */
  touch(): void;
  /** Close page + browser, clear timers/hooks/snapshot. Idempotent. */
  close(): Promise<void>;
  /** Snapshot bookkeeping (the tools' ref store; navigation voids it). */
  saveSnapshot(url: string, refs: ReadonlyMap<string, SnapshotRefEntry>): void;
  currentSnapshot(): PageSnapshotRefs | null;
  invalidateSnapshot(): void;
  /** Void the snapshot when the page moved since it was taken. */
  noteUrl(url: string): void;
}

const defaultRegisterExitHook = (fn: () => void): (() => void) => {
  process.once("exit", fn);
  return () => process.removeListener("exit", fn);
};

/** node:sea's isSea, guarded for non-Node/runtimes without the module. */
const defaultSeaProbe = (): boolean => {
  try {
    // node:sea exists on Node >= 22; isSea() is false everywhere except a
    // single-executable application blob.
    return process.getBuiltinModule?.("node:sea")?.isSea() === true;
  } catch {
    return false;
  }
};

export function createBrowserRuntime(opts: BrowserRuntimeOptions = {}): BrowserRuntime {
  const port = opts.port ?? createPlaywrightPort();
  const homeDir = opts.homeDir ?? join(homedir(), ".wudao-desktop");
  // ω99-114: the persistent login profile (string resolution only — the
  // dir itself materializes on first launch, never at construction).
  const userDataDir = opts.userDataDir ?? join(browserRoot(homeDir), "profile");
  // ω99-142: where page-initiated downloads land — a sibling of the profile
  // under the SAME browser root, deliberately independent of the kernel's
  // scratch "downloads" dir (page exports never mix with kernel zips).
  const downloadsDir = join(browserRoot(homeDir), "page-downloads");
  const envRead = opts.env ?? (() => process.env);
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const download = opts.download ?? ((home: string) => ensureChromiumDownloaded({ homeDir: home }));
  const resolveInstalled = opts.resolveInstalled ?? ((home: string) => installedExecutablePath(home));
  const profileMkdir = opts.profileMkdir ?? ((dir: string) => mkdir(dir, { recursive: true }));
  const registerExitHook = opts.registerExitHook ?? defaultRegisterExitHook;
  const seaProbe = opts.seaProbe ?? defaultSeaProbe;

  let state: BrowserState = "closed";
  let handle: BrowserHandle | undefined;
  let page: PageHandle | undefined;
  let inflight: Promise<PageHandle> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let unregisterExit: (() => void) | undefined;
  let snapshot: PageSnapshotRefs | null = null;

  const disarmIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const armIdle = (): void => {
    disarmIdle();
    idleTimer = setTimeout(() => { void closeInternal(); }, idleMs);
    idleTimer?.unref?.();
  };
  const exitHook = (): void => {
    // An async close cannot settle inside "exit" — the sync kill is the
    // real reaper (playwright's own SIG* handling is the first line).
    if (handle?.kill !== undefined) handle.kill();
    else void handle?.close();
  };

  async function launch(): Promise<PageHandle> {
    // ω99-112 SEA degrade: inside the desktop single-file bundle the driver
    // is an esbuild external (unbundleable internal requires) — fail fast
    // with the honest posture, never a module stack or a hang.
    if (seaProbe()) {
      throw browserLaunchError("the desktop app bundle does not ship the browser driver yet — browser tools work in terminal/dev mode and arrive in a coming desktop release");
    }
    const env = envRead();
    const installed = await resolveInstalled(homeDir).catch(() => null);
    const resolution = resolveExecutablePath(env, installed);
    let launchOpts: { executablePath?: string; env?: Record<string, string>; headless?: boolean };
    if (resolution.kind === "executable") {
      launchOpts = { executablePath: resolution.path, ...(opts.headless === true ? { headless: true } : {}) };
    } else {
      // First use: try the download once; a user-managed registry kernel
      // (PLAYWRIGHT_BROWSERS_PATH) stays the fallback when it fails.
      let downloaded: string | undefined;
      try {
        downloaded = (await download(homeDir)).executablePath;
      } catch {
        downloaded = undefined; // honest fallback below; a full failure surfaces there
      }
      launchOpts = {
        ...(downloaded !== undefined ? { executablePath: downloaded } : { env: { PLAYWRIGHT_BROWSERS_PATH: browserRoot(homeDir) } }),
        ...(opts.headless === true ? { headless: true } : {}),
      };
    }
    try {
      // ω99-114: materialize the persistent profile dir (idempotent; lazy —
      // see BrowserRuntimeOptions.userDataDir). Its failure is a launch
      // failure and surfaces the honest shape.
      await profileMkdir(userDataDir);
    } catch (err) {
      throw browserLaunchError(
        `could not create the persistent profile directory ${userDataDir} (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    try {
      // ω99-142: downloadsDir rides every launch (the adapter's download
      // interception seam — without it a page export vanishes on close).
      handle = await port.launch({ ...launchOpts, userDataDir, downloadsDir });
      page = await handle.newPage();
    } catch (err) {
      handle = undefined;
      page = undefined;
      throw browserLaunchError(err instanceof Error ? err.message : String(err));
    }
    state = "open";
    unregisterExit = registerExitHook(exitHook);
    armIdle();
    return page;
  }

  async function closeInternal(): Promise<void> {
    if (state === "closed" && handle === undefined && page === undefined) return;
    const p = page;
    const h = handle;
    page = undefined;
    handle = undefined;
    state = "closed";
    snapshot = null;
    disarmIdle();
    if (unregisterExit !== undefined) unregisterExit();
    unregisterExit = undefined;
    try { await p?.close(); } catch { /* best-effort */ }
    try { await h?.close(); } catch { /* best-effort */ }
  }

  return {
    state: () => state,
    openPage(): Promise<PageHandle> {
      if (state === "open" && page !== undefined) {
        armIdle();
        return Promise.resolve(page);
      }
      if (inflight !== undefined) return inflight;
      state = "launching";
      inflight = launch().then(
        (p) => { inflight = undefined; return p; },
        (err) => { inflight = undefined; state = "closed"; throw err; },
      );
      return inflight;
    },
    touch: () => { if (state === "open") armIdle(); },
    close: closeInternal,
    saveSnapshot(url, refs) { snapshot = { url, refs }; },
    currentSnapshot: () => snapshot,
    invalidateSnapshot() { snapshot = null; },
    noteUrl(url) {
      if (snapshot !== null && snapshot.url !== url) snapshot = null;
    },
  };
}
