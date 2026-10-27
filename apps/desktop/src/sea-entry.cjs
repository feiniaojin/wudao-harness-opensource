// wudao-server SEA entry (M43-C) — the one file that becomes the sidecar.
//
// It is NOT a second server: it boots the EXISTING `wudao ui` stack (the
// bundled packages/cli dist — driver, tools, permissions, sessions, the
// @wudao/server WS protocol) with two desktop-only adjustments, both made
// BEFORE the CLI dist loads (its top-level main() runs on require):
//
//   1. web build: inside a single-file executable there is no
//      packages/web/dist to probe, so the build-embedded SEA assets are
//      extracted to a per-run temp dir and pointed at via
//      WUDAO_UI_STATIC_DIR (the CLI's static-dir probe honors it; no
//      package code changed shape);
//   2. argv: rewritten to `wudao ui --no-open` — the desktop shell owns
//      navigation, and the token-bearing URL goes to stdout for it (the
//      `open: http://127.0.0.1:<port>/#<token>` protocol line).
//
// Bundled to a single self-contained CJS file by scripts/build-sea.mjs
// (esbuild), then injected into a copy of the node binary (Node SEA).

"use strict";

const { mkdir, writeFile } = require("node:fs/promises");
const { rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join, normalize } = require("node:path");

async function extractWebAssets() {
  let sea;
  try {
    sea = require("node:sea");
  } catch {
    return; // plain `node` run (dev): the CLI's own web-dist probe takes over
  }
  if (typeof sea.isSea === "function" && !sea.isSea()) return;

  const manifest = JSON.parse(Buffer.from(sea.getAsset("web/manifest.json")).toString("utf8"));
  const dir = join(tmpdir(), `wudao-harness-desktop-web-${process.pid}`);
  await mkdir(dir, { recursive: true });
  for (const rel of manifest.files) {
    // The manifest is build-generated, but normalize anyway: the server's
    // static handler trusts this dir.
    const safe = normalize(rel).replace(/^(\.\.[/\\])+/, "");
    const target = join(dir, safe);
    await mkdir(dirname(target), { recursive: true });
    // SEA asset keys always use forward slashes; path.normalize on win32
    // yields backslashes, so map separators back for the lookup.
    await writeFile(target, Buffer.from(sea.getAsset(`web/${safe.replace(/\\/g, "/")}`)));
  }
  process.env.WUDAO_UI_STATIC_DIR = dir;
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  });
}

extractWebAssets()
  .catch((err) => {
    process.stderr.write(`wudao-server: web asset extraction failed: ${err}\n`);
  })
  .then(() => {
    // `wudao ui --no-open`: ephemeral port, random token, URL to stdout.
    process.argv = [process.argv[0] ?? "node", process.argv[1] ?? "wudao-server", "ui", "--no-open"];
    require("../../../packages/cli/dist/index.js");
  });
