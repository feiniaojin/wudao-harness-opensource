// ω99-112 — download layer (RED first): browsers.json parsing (real-shape
// fixture), CDN URL construction, path-segment whitelisting, zip-slip staging
// validation, checksum enforcement, and the atomic install. All local: the
// network is a fake fetch, unzip is the system binary over a real zip.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chromiumBuildFromBrowsersJson,
  chromiumDownloadUrl,
  safeSegment,
  installLayout,
  validateStaging,
  ensureChromiumDownloaded,
} from "../src/download.js";

const sh = (cmd: string, args: readonly string[], opts: { cwd: string }): Promise<void> =>
  new Promise((res, rej) => execFile(cmd, args, opts, (e) => (e ? rej(e) : res())));

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "wd-browser-dl-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

// The real playwright-core 1.63.0 browsers.json chromium entry (verbatim
// shape), plus a synthetic checksum the checksum tests control.
const REAL_FIXTURE = {
  comment: "Playwright browsers metadata",
  browsers: [
    { name: "chromium-headless-shell", revision: "1243", installByDefault: true, browserVersion: "153.0.8010.12" },
    { name: "chromium", revision: "1243", installByDefault: true, browserVersion: "153.0.8010.12", title: "Chrome for Testing" },
  ],
};

describe("browsers.json parsing", () => {
  it("finds the pinned chromium build in the real-shape fixture", () => {
    const b = chromiumBuildFromBrowsersJson(REAL_FIXTURE);
    expect(b).toEqual({ revision: "1243", browserVersion: "153.0.8010.12" });
  });

  it("returns null when chromium is absent or the shape is wrong (fail-closed)", () => {
    expect(chromiumBuildFromBrowsersJson({ browsers: [] })).toBeNull();
    expect(chromiumBuildFromBrowsersJson({ browsers: [{ name: "chromium", revision: 1243 }] })).toBeNull();
    expect(chromiumBuildFromBrowsersJson(null)).toBeNull();
  });
});

describe("CDN URL construction", () => {
  it("builds the Chrome-for-Testing URL for both mac arches", () => {
    expect(chromiumDownloadUrl("153.0.8010.12", "darwin", "arm64"))
      .toBe("https://cdn.playwright.dev/dbazure/download/playwright/builds/cft/153.0.8010.12/mac-arm64/chrome-mac-arm64.zip");
    expect(chromiumDownloadUrl("153.0.8010.12", "darwin", "x64"))
      .toBe("https://cdn.playwright.dev/dbazure/download/playwright/builds/cft/153.0.8010.12/mac-x64/chrome-mac-x64.zip");
  });

  it("returns null off macOS (v1 is macOS-only; the caller reports honestly)", () => {
    expect(chromiumDownloadUrl("1.2.3.4", "linux", "x64")).toBeNull();
    expect(chromiumDownloadUrl("1.2.3.4", "win32", "x64")).toBeNull();
  });
});

describe("path-segment whitelist", () => {
  it("accepts plain build ids", () => {
    expect(safeSegment("1243")).toBe("1243");
    expect(safeSegment("chromium-1243")).toBe("chromium-1243");
  });
  it("rejects traversal, absolute, empty, and separator-bearing segments", () => {
    expect(safeSegment("..")).toBeNull();
    expect(safeSegment("../x")).toBeNull();
    expect(safeSegment("/etc")).toBeNull();
    expect(safeSegment("")).toBeNull();
    expect(safeSegment("a/b")).toBeNull();
    expect(safeSegment("a\\b")).toBeNull();
    expect(safeSegment(".")).toBeNull();
    expect(safeSegment("  ")).toBeNull();
  });
});

describe("install layout", () => {
  it("mirrors the playwright registry layout under the wudao home (mac-arm64)", () => {
    const l = installLayout(home, "1243", "darwin", "arm64");
    expect(l?.installDir).toBe(join(home, "browser", "chromium-1243"));
    expect(l?.executablePath).toBe(join(home, "browser", "chromium-1243", "chrome-mac-arm64",
      "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"));
  });
  it("is null off macOS (v1)", () => {
    expect(installLayout(home, "1243", "linux", "x64")).toBeNull();
  });
});

describe("staging validation (zip-sip/zip-slip guard)", () => {
  it("accepts exactly the expected top-level dir and rejects anything else", async () => {
    const staging = join(home, "staging");
    await mkdir(join(staging, "chrome-mac-arm64", "inner"), { recursive: true });
    expect(await validateStaging(staging, ["chrome-mac-arm64"])).toBe(true);
    // an escaped sibling written outside staging must fail validation
    await writeFile(join(staging, "chrome-mac-arm64", "ok.txt"), "x");
    expect(await validateStaging(staging, ["chrome-mac-arm64"])).toBe(true);
    await writeFile(join(staging, "evil.txt"), "x");
    expect(await validateStaging(staging, ["chrome-mac-arm64"])).toBe(false);
  });
  it("rejects symlinked top entries", async () => {
    const staging = join(home, "staging2");
    await mkdir(join(home, "target"), { recursive: true });
    await mkdir(staging, { recursive: true });
    const { symlink } = await import("node:fs/promises");
    await symlink(join(home, "target"), join(staging, "chrome-mac-arm64"));
    expect(await validateStaging(staging, ["chrome-mac-arm64"])).toBe(false);
  });
});

// A real zip (system `zip`) with the registry top segment — the success path
// runs the REAL system unzip over it; only the network is faked.
async function makeZip(dest: string, top: string): Promise<void> {
  const src = join(home, "zipsrc", top, "Google Chrome for Testing.app", "Contents", "MacOS");
  await mkdir(src, { recursive: true });
  await writeFile(join(src, "Google Chrome for Testing"), "fake-binary");
  await sh("zip", ["-r", "-q", dest, top], { cwd: join(home, "zipsrc") });
}

const fixtureHere = () => dirname(fileURLToPath(import.meta.url));

describe("ensureChromiumDownloaded", () => {
  it("streams, unzips, checksums, and installs atomically (checksum present)", async () => {
    const zip = join(home, "dl.zip");
    await makeZip(zip, "chrome-mac-arm64");
    const bytes = await readFile(zip);
    const withChecksum = {
      browsers: [{ name: "chromium", revision: "1243", browserVersion: "153.0.8010.12", checksum: "sha256:deadbeef" }],
    };
    const log: string[] = [];
    const out = await ensureChromiumDownloaded({
      homeDir: home,
      browsersJson: withChecksum,
      platform: "darwin", arch: "arm64",
      fetchImpl: (async () => new Response(bytes)) as typeof fetch,
      hashImpl: async () => "deadbeef",
      log: (l) => log.push(l),
    });
    expect(await stat(out.executablePath)).toBeTruthy();
    expect(await readdir(join(home, "browser"))).toContain("chromium-1243");
    // idempotent: a second call sees the install and downloads nothing
    let fetched = 0;
    await ensureChromiumDownloaded({
      homeDir: home, browsersJson: withChecksum, platform: "darwin", arch: "arm64",
      fetchImpl: (async () => { fetched++; return new Response(bytes); }) as typeof fetch,
      hashImpl: async () => { throw new Error("must not hash"); },
    });
    expect(fetched).toBe(0);
  });

  it("rejects a checksum mismatch, cleans half-done state, and leaves nothing installed", async () => {
    const zip = join(home, "dl2.zip");
    await makeZip(zip, "chrome-mac-arm64");
    const bytes = await readFile(zip);
    const withChecksum = {
      browsers: [{ name: "chromium", revision: "1243", browserVersion: "153.0.8010.12", checksum: "sha256:expected" }],
    };
    await expect(ensureChromiumDownloaded({
      homeDir: home, browsersJson: withChecksum, platform: "darwin", arch: "arm64",
      fetchImpl: (async () => new Response(bytes)) as typeof fetch,
      hashImpl: async () => "wrong",
    })).rejects.toThrow(/checksum/i);
    expect(await readdir(join(home, "browser", "downloads")).catch(() => [])).toEqual([]);
    await expect(stat(join(home, "browser", "chromium-1243"))).rejects.toThrow();
  });

  it("skips checksum verification when browsers.json carries none (the 1.63 reality)", async () => {
    const zip = join(home, "dl3.zip");
    await makeZip(zip, "chrome-mac-arm64");
    const bytes = await readFile(zip);
    const out = await ensureChromiumDownloaded({
      homeDir: home, browsersJson: REAL_FIXTURE, platform: "darwin", arch: "arm64",
      fetchImpl: (async () => new Response(bytes)) as typeof fetch,
      hashImpl: async () => { throw new Error("no checksum → no hashing"); },
    });
    expect(await stat(out.executablePath)).toBeTruthy();
  });

  it("refuses zip-slip: an unzip writing outside staging fails validation and cleans up", async () => {
    const zip = join(home, "dl4.zip");
    await makeZip(zip, "chrome-mac-arm64");
    const bytes = await readFile(zip);
    let escaped = false;
    await expect(ensureChromiumDownloaded({
      homeDir: home, browsersJson: REAL_FIXTURE, platform: "darwin", arch: "arm64",
      fetchImpl: (async () => new Response(bytes)) as typeof fetch,
      runUnzip: async (_z, dest) => {
        await mkdir(dest, { recursive: true });
        await mkdir(join(dest, "chrome-mac-arm64"), { recursive: true });
        // hostile archive: an unexpected top-level entry INSIDE staging (the
        // whitelist's job) plus an escape write outside it (cleanup's job)
        await mkdir(join(dest, "etc"), { recursive: true });
        await writeFile(join(dest, "etc", "passwd"), "slipped");
        await writeFile(join(dest, "..", "escaped.txt"), "slipped");
        escaped = true;
      },
    })).rejects.toThrow(/staging/i);
    expect(escaped).toBe(true);
    // failure wipes the whole downloads scratch dir (ours, half-done only)
    await expect(stat(join(home, "browser", "downloads", "escaped.txt"))).rejects.toThrow();
    await expect(stat(join(home, "browser", "chromium-1243"))).rejects.toThrow();
  });
});

describe("real browsers.json wiring", () => {
  it("reads the pinned playwright-core fixture shipped in the repo", async () => {
    const raw = JSON.parse(await readFile(join(fixtureHere(), "fixtures", "browsers.json.fixture"), "utf8")) as unknown;
    const b = chromiumBuildFromBrowsersJson(raw);
    expect(b?.revision).toBe("1243");
    expect(b?.browserVersion).toBe("153.0.8010.12");
  });
});
