// Fetch an official node distribution binary for a target platform/arch —
// needed because Node SEA injects into a copy of the RUNNING node binary, so
// a cross-arch sidecar (e.g. the aarch64 half of the universal darwin dmg on
// an x86_64 host, or CI cross-builds) needs that arch's node.
//
// Cached under apps/desktop/.cache/node/<version>-<platform>-<arch>/node.
// Mirror override: NODE_DIST_MIRROR (default https://nodejs.org/dist, with an
// automatic fallback to npmmirror's node dist mirror).

import { createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";

const DESKTOP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const NODE_CACHE_DIR = join(DESKTOP_DIR, ".cache", "node");

const MIRRORS = [
  process.env.NODE_DIST_MIRROR,
  "https://nodejs.org/dist",
  "https://cdn.npmmirror.com/bin/node",
].filter((m) => typeof m === "string" && m !== "");

function distFile(platform, arch, version) {
  // Official dist filenames carry the `v` prefix (node-v24.7.0-darwin-arm64.tar.gz)
  // — same shape the tar/zip extraction paths below expect.
  if (platform === "win32") return `node-v${version}-win-${arch}.zip`;
  const ext = platform === "linux" ? "tar.xz" : "tar.gz";
  return `node-v${version}-${platform}-${arch}.${ext}`;
}

async function exists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function downloadOnce(url, target, transport) {
  if (transport === "curl") {
    const res = spawnSync("curl", ["-fsSL", "--max-time", "600", "-o", target, url]);
    if (res.status !== 0) {
      throw new Error(`curl exit ${res.status}: ${String(res.stderr).slice(0, 300)}`);
    }
    return;
  }
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || res.body === null) throw new Error(`GET -> ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(target));
}

/**
 * Download with transport alternation and retries: this network class
 * (verified on the dev machine) intermittently 404s undici requests and
 * resets curl mid-transfer for the SAME url seconds apart — so each round
 * tries fetch then curl, and only a plausibly-sized file (>= 1 MB) counts.
 */
async function download(url, target) {
  const failures = [];
  for (let round = 1; round <= 4; round++) {
    for (const transport of ["fetch", "curl"]) {
      try {
        process.stdout.write(`fetch-node: ${url} [${transport}${round > 1 ? ` round ${round}` : ""}]\n`);
        await downloadOnce(url, target, transport);
        if ((await sizeOf(target)) >= 1_000_000) return;
        failures.push(`${transport}: file too small`);
      } catch (err) {
        failures.push(`${transport}: ${err.message}`);
      }
    }
    await sleep(2_000 * round);
  }
  throw new Error(`download failed after retries: ${failures.join("; ")}`);
}

/**
 * Return the path to a node binary for (platform, arch), downloading and
 * caching the official dist on first use. Resolves to the HOST node binary
 * when platform+arch match the running process.
 */
export async function ensureNodeBinary(version, platform, arch) {
  if (platform === process.platform && arch === process.arch) return process.execPath;

  const exe = platform === "win32" ? "node.exe" : "node";
  const cached = join(NODE_CACHE_DIR, `${version}-${platform}-${arch}`, exe);
  if (await exists(cached)) return cached;

  const file = distFile(platform, arch, version);
  await mkdir(dirname(cached), { recursive: true });
  const archive = join(tmpdir(), file);
  let fetched = false;
  const failures = [];
  for (const mirror of MIRRORS) {
    const url = `${mirror.replace(/\/$/, "")}/v${version}/${file}`;
    try {
      await download(url, archive);
      fetched = true;
      break;
    } catch (err) {
      failures.push(`${url} (${err.message})`);
    }
  }
  if (!fetched) throw new Error(`fetch-node: all mirrors failed:\n  ${failures.join("\n  ")}`);

  const extractDir = join(dirname(cached), "extract");
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  // bsdtar handles tar.gz/tar.xz AND zip — present on macOS, Linux, and
  // Windows 10+. Strip the dist's top dir, keep only bin/<exe>.
  const inner = `node-v${version}-${platform}-${arch}/bin/${exe}`;
  const zipInner = `node-v${version}-win-${arch}/${exe}`;
  const tar = spawnSync("tar", ["-xf", archive, "-C", extractDir, "--strip-components=2", inner], { stdio: "inherit" });
  const zip = tar.status !== 0
    ? spawnSync("tar", ["-xf", archive, "-C", extractDir, "--strip-components=1", zipInner], { stdio: "inherit" })
    : null;
  const extracted = join(extractDir, exe);
  if (!(await exists(extracted))) {
    throw new Error(`fetch-node: extraction failed (tar=${tar.status}${zip ? ` zip=${zip.status}` : ""})`);
  }
  await copyFile(extracted, cached);
  await chmod(cached, 0o755);
  await rm(extractDir, { recursive: true, force: true });
  await rm(archive, { force: true });
  return cached;
}
