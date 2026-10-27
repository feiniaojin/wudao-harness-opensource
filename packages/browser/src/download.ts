// ω99-112 — first-use Chromium kernel download (v1 macOS). Reads the build
// pin (revision + browserVersion + optional checksum) straight out of
// playwright-core's own browsers.json, streams the kernel zip from the
// playwright CDN into ~/.wudao-desktop/browser/downloads/, unzips into a
// staging dir, validates the extracted layout (whitelist, zip-slip guard),
// hashes when browsers.json carries a checksum, then renames the staging dir
// into its final registry-layout home ATOMICALLY. No resume support in v1 —
// a failed attempt wipes its half-done state and the next call starts over
// (documented debt; the kernel is one ~150MB file, retries are cheap).
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** The wudao browser home layout root: <home>/browser (home default
 *  ~/.wudao-desktop — the desktop app's data dir, deliberately outside every
 *  repo and outside the dmg). */
export const browserRoot = (homeDir: string): string => join(homeDir, "browser");

/** Whitelist one path segment we join into a filesystem path (build ids,
 *  revision dirs): alphanumerics plus . _ -, never empty, never a traversal
 *  or absolute-adjacent form. Fail-closed → null. */
export function safeSegment(segment: string): string | null {
  if (segment === "" || segment === "." || segment === "..") return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)) return null;
  return segment;
}

/** The pinned chromium build out of a browsers.json payload (playwright-core
 *  1.63 shape: {browsers: [{name, revision, browserVersion, checksum?}]}).
 *  Fail-closed null on any malformed shape. checksum is optional — 1.63
 *  ships none, and the verify step is skipped exactly then. */
export function chromiumBuildFromBrowsersJson(json: unknown): { revision: string; browserVersion: string; checksum?: string } | null {
  if (typeof json !== "object" || json === null) return null;
  const browsers = (json as { browsers?: unknown }).browsers;
  if (!Array.isArray(browsers)) return null;
  for (const b of browsers) {
    if (typeof b !== "object" || b === null) continue;
    const e = b as Record<string, unknown>;
    if (e["name"] !== "chromium") continue;
    if (typeof e["revision"] !== "string" || typeof e["browserVersion"] !== "string") return null;
    if (safeSegment(e["revision"]) === null || safeSegment(e["browserVersion"]) === null) return null;
    return {
      revision: e["revision"],
      browserVersion: e["browserVersion"],
      ...(typeof e["checksum"] === "string" ? { checksum: e["checksum"] } : {}),
    };
  }
  return null;
}

const macArchSegment = (platform: NodeJS.Platform, arch: string): string | null =>
  platform === "darwin" ? (arch === "arm64" ? "mac-arm64" : "mac-x64") : null;

/** The Chrome-for-Testing CDN URL for this host (v1 macOS only — off-mac is
 *  null and the caller reports the honest preparation sentence). */
export function chromiumDownloadUrl(browserVersion: string, platform: NodeJS.Platform, arch: string): string | null {
  if (safeSegment(browserVersion) === null) return null;
  const seg = macArchSegment(platform, arch);
  if (seg === null) return null;
  return `https://cdn.playwright.dev/dbazure/download/playwright/builds/cft/${browserVersion}/${seg}/chrome-${seg}.zip`;
}

/** The registry-layout install plan (mirrors playwright's own
 *  ms-playwright layout so PLAYWRIGHT_BROWSERS_PATH=~/.wudao-desktop/browser
 *  sees exactly our download). v1 macOS; null elsewhere. */
export function installLayout(
  homeDir: string,
  revision: string,
  platform: NodeJS.Platform,
  arch: string,
): { installDir: string; executablePath: string; topSegment: string } | null {
  if (safeSegment(revision) === null) return null;
  const seg = macArchSegment(platform, arch);
  if (seg === null) return null;
  const installDir = join(browserRoot(homeDir), `chromium-${revision}`);
  return {
    installDir,
    executablePath: join(installDir, `chrome-${seg}`, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
    topSegment: `chrome-${seg}`,
  };
}

/** Zip-slip guard: the staged extraction must contain EXACTLY the expected
 *  top-level directory(ies) — real directories, no symlinks, no stray files,
 *  never empty. An archive that wrote anywhere else (or tried to escape via
 *  ../entries leaving junk beside the expected tree) fails here. */
export async function validateStaging(stagingDir: string, allowedTop: readonly string[]): Promise<boolean> {
  let entries: readonly import("node:fs").Dirent[];
  try {
    entries = await readdir(stagingDir, { withFileTypes: true });
  } catch {
    return false;
  }
  if (entries.length === 0) return false;
  const allowed = new Set(allowedTop);
  for (const e of entries) {
    if (!allowed.has(e.name)) return false;
    if (!e.isDirectory() || e.isSymbolicLink()) return false;
    // belt-and-braces: the dirent says directory, prove it's not a symlink
    const st = await lstat(join(stagingDir, e.name));
    if (!st.isDirectory()) return false;
  }
  return true;
}

/** The seams ensureChromiumDownloaded honors (all injectable; defaults are
 *  the real network/unzip/hash). */
export interface DownloadOptions {
  readonly homeDir: string;
  /** browsers.json payload; default: playwright-core's real one. */
  readonly browsersJson?: unknown;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly fetchImpl?: typeof fetch;
  /** default: the system `unzip` binary */
  readonly runUnzip?: (zipPath: string, destDir: string) => Promise<void>;
  /** default: sha256 hex of the file */
  readonly hashImpl?: (file: string) => Promise<string>;
  readonly log?: (line: string) => void;
}

async function systemUnzip(zipPath: string, destDir: string): Promise<void> {
  await execFileP("unzip", ["-q", "-o", zipPath, "-d", destDir]);
}

async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(file), h as unknown as NodeJS.WritableStream);
  // pipeline drains the stream into the hash; digest once settled
  return h.digest("hex");
}

async function readRealBrowsersJson(): Promise<unknown> {
  const req = createRequire(import.meta.url);
  const pkgPath = req.resolve("playwright-core/package.json");
  return JSON.parse(await readFile(join(dirname(pkgPath), "browsers.json"), "utf8")) as unknown;
}

const exists = async (p: string): Promise<boolean> => {
  try { await stat(p); return true; } catch { return false; }
};

/** v1 macOS honest error: names the posture and the way out (one sentence,
 *  model-facing). */
export function kernelUnavailableError(reason: string): Error {
  return new Error(
    `Chromium kernel unavailable (${reason}). It auto-downloads to ~/.wudao-desktop/browser on first use; to prepare it manually, point WUDAO_BROWSER_EXECUTABLE at a local Chromium executable and retry.`,
  );
}

/** First-use download + install (idempotent: an already-installed kernel is
 *  probed FIRST and short-circuits the network entirely). Throws the honest
 *  kernelUnavailableError on any failure, after wiping all half-done state. */
export async function ensureChromiumDownloaded(opts: DownloadOptions): Promise<{ readonly executablePath: string }> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const json = opts.browsersJson ?? await readRealBrowsersJson();
  const build = chromiumBuildFromBrowsersJson(json);
  if (build === null) throw kernelUnavailableError("playwright-core browsers.json is unreadable or has no chromium build pinned");
  const layout = installLayout(opts.homeDir, build.revision, platform, arch);
  if (layout === null) throw kernelUnavailableError("v1 downloads ship for macOS only");
  if (await exists(layout.executablePath)) return { executablePath: layout.executablePath };
  const url = chromiumDownloadUrl(build.browserVersion, platform, arch);
  if (url === null) throw kernelUnavailableError("no kernel URL for this platform");
  const downloadsDir = join(browserRoot(opts.homeDir), "downloads");
  const zipPath = join(downloadsDir, `chromium-${build.revision}.zip`);
  const staging = join(downloadsDir, `staging-${build.revision}`);
  // v1 debt: no resume — one failed attempt wipes everything it wrote.
  const wipe = async (): Promise<void> => { await rm(downloadsDir, { recursive: true, force: true }); };
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    await mkdir(downloadsDir, { recursive: true });
    opts.log?.(`browser kernel: downloading ${url}`);
    const res = await fetchImpl(url);
    if (!res.ok || res.body === null) throw kernelUnavailableError(`download failed: HTTP ${res.status}`);
    await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(zipPath));
    if (typeof build.checksum === "string") {
      const expected = build.checksum.replace(/^sha256:/, "");
      const actual = await (opts.hashImpl ?? sha256File)(zipPath);
      if (actual !== expected) throw new Error(`kernel checksum mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
      opts.log?.("browser kernel: checksum verified");
    } else {
      // playwright 1.63's browsers.json ships no checksum; the staging
      // whitelist below stays the structural guard.
    }
    await mkdir(staging, { recursive: true });
    await (opts.runUnzip ?? systemUnzip)(zipPath, staging);
    if (!(await validateStaging(staging, [layout.topSegment]))) {
      throw new Error("staging validation failed: unexpected archive layout (possible zip-slip)");
    }
    await rm(layout.installDir, { recursive: true, force: true });
    await rename(staging, layout.installDir);
    if (!(await exists(layout.executablePath))) throw new Error("installed kernel is missing its executable");
    opts.log?.(`browser kernel: installed at ${layout.installDir}`);
    await rm(zipPath, { force: true });
    return { executablePath: layout.executablePath };
  } catch (err) {
    await wipe();
    throw err instanceof Error && /kernel unavailable|checksum|staging/.test(err.message)
      ? err
      : kernelUnavailableError(err instanceof Error ? err.message : String(err));
  }
}

/** The runtime's probe: the installed kernel's executable, or null (the
 *  resolver then falls to the registry / download lanes). */
export async function installedExecutablePath(
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Promise<string | null> {
  const json = await readRealBrowsersJson().catch(() => null);
  const build = json === null ? null : chromiumBuildFromBrowsersJson(json);
  if (build === null) return null;
  const layout = installLayout(homeDir, build.revision, platform, arch);
  if (layout === null) return null;
  return (await exists(layout.executablePath)) ? layout.executablePath : null;
}
