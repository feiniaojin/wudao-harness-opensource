// build-sea.mjs — the server sidecar pipeline (M43-C):
//
//   packages build → web build → esbuild single-file bundle → Node SEA
//   injection per target triple → src-tauri/binaries/wudao-server-<triple>
//
// SEA strategy (explicitly, not silently):
//   - Node >= 25 one-shot `node --compile` is PROBED FIRST (one command,
//     no postject) — unavailable on Node 24.x and earlier;
//   - this repo's toolchain (Node 24.7.0) has the official Node SEA API —
//     `node --experimental-sea-config` + postject — which produces the same
//     single-file executable and is what runs here;
//   - there is NO third fallback (no bundled-node_modules zip): if SEA is
//     unavailable the build fails loudly. See docs/desktop.md §SEA.
//
// darwin default: BOTH x86_64 and aarch64 sidecars (the universal .dmg).
// `--host-only` (desktop:dev) or DESKTOP_SIDECAR_TARGETS=a,b override.

import { spawnSync } from "node:child_process";
import { cp, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile, chmod } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { ensureNodeBinary } from "./fetch-node.mjs";
import { runSync } from "./spawn.mjs";
import { parsePlaywrightPin, planPlaywrightCoreCopy, runtimeResourceManifest } from "./playwright-resource.mjs";

const APPS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = resolve(APPS_DIR, "..", "..");
const SEA_DIR = join(APPS_DIR, ".sea");
const BINARIES_DIR = join(APPS_DIR, "src-tauri", "binaries");
const WEB_DIST = join(REPO_ROOT, "packages", "web", "dist");

// node's process.arch ("x64"/"arm64") vs rust/target triples ("x86_64"/"aarch64").
function tripleOf(nodeArch, platform) {
  const arch = nodeArch === "x64" ? "x86_64" : nodeArch === "arm64" ? "aarch64" : nodeArch;
  if (platform === "darwin") return `${arch}-apple-darwin`;
  if (platform === "win32") return `${arch}-pc-windows-msvc`;
  return `${arch}-unknown-linux-gnu`;
}
function nodeArchOf(triple) {
  return triple.startsWith("x86_64-") ? "x64" : triple.startsWith("aarch64-") ? "arm64" : triple.split("-")[0];
}
const HOST_TRIPLE = tripleOf(process.arch, process.platform);

const SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const log = (msg) => process.stdout.write(`${msg}\n`);
const run = (cmd, args, opts = {}) => {
  const res = runSync(cmd, args, { stdio: "inherit", ...opts });
  if (res.status !== 0) throw new Error(`command failed (${res.status}): ${cmd} ${args.join(" ")}`);
  return res;
};

async function walk(dir, prefix = "") {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walk(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out;
}

/** Does this node understand the one-shot compile flag? (Node >= 25) */
function supportsNodeCompile() {
  const res = spawnSync(process.execPath, ["--compile", "--help"], { stdio: "ignore" });
  return res.status === 0;
}

// On win32 the .bin shims are .CMD files spawnSync can't exec directly —
// spawn.mjs's run() resolves them to their JS entry. Elsewhere the path is
// spawned as-is, so hand back a "command" form both platforms accept.
const postjectBin = () =>
  process.platform === "win32"
    ? "postject"
    : join(APPS_DIR, "node_modules", ".bin", "postject");

/**
 * Classic-SEA health probe: build a hello-world SEA (official docs recipe),
 * run it, and check it actually executes. On some hosts (verified: this
 * macOS 12 x86_64 machine, official Node 22.21.1 AND 24.7.0 + postject
 * 1.0.0-alpha.6) the injected binary SIGSEGVs inside
 * node::sea::FindSingleExecutableResource before main() — so "the flag
 * exists" is NOT sufficient evidence. The probe turns that into a clean,
 * loud fallback to the bundled-runtime mode instead of a broken installer.
 */
async function seaHealthy() {
  const dir = await mkdtemp(join(tmpdir(), "wudao-sea-probe-"));
  try {
    const main = join(dir, "probe.cjs");
    await writeFile(main, "process.stdout.write('SEA_OK\\n');\n");
    const cfg = join(dir, "sea-config.json");
    await writeFile(cfg, JSON.stringify({ main, output: join(dir, "probe.blob"), disableExperimentalSEAWarning: true }));
    run(process.execPath, ["--experimental-sea-config", cfg], { stdio: "ignore" });
    const bin = join(dir, "probe.bin");
    await copyFile(process.execPath, bin);
    await chmod(bin, 0o755);
    if (process.platform === "darwin") {
      run("codesign", ["--remove-signature", bin], { stdio: "ignore" });
    }
    run(postjectBin(), [
      bin, "NODE_SEA_BLOB", join(dir, "probe.blob"),
      "--sentinel-fuse", SENTINEL_FUSE,
      ...(process.platform === "darwin" ? ["--macho-segment-name", "__NODE_SEA"] : []),
    ], { stdio: "ignore" });
    if (process.platform === "darwin") {
      run("codesign", ["--sign", "-", bin], { stdio: "ignore" });
    }
    const res = runSync(bin, [], { stdio: "pipe" });
    return res.status === 0 && String(res.stdout ?? "").includes("SEA_OK");
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function buildPackages() {
  log("[sea] building workspace packages (core → providers → browser → server → cli → web)");
  // @wudao-org/browser (ω99-117): the cli package imports it, so its dist must
  // exist before the cli's tsc runs. The root `pnpm build` order already had
  // browser before cli; this list had silently relied on a stale browser/dist
  // (fresh checkouts failed TS2307 until this entry — same order as root).
  for (const pkg of ["@wudao-org/core", "@wudao-org/providers", "@wudao-org/browser", "@wudao-org/server", "wudao-harness", "@wudao-org/web"]) {
    run("pnpm", ["--filter", pkg, "run", "build"], { cwd: REPO_ROOT });
  }
}

// The server bundle never renders a TUI, but `wudao ui`'s entry (index.ts)
// transitively imports ink — whose reconciler top-level-awaits a devtools
// import, which CJS output (SEA requires a CJS main) cannot express. The TUI
// modules are dead weight for the sidecar, so they are stubbed at the module
// level: any name imported from ink/react resolves to a callable no-op. The
// ui path calls none of them; if that ever changes, the sidecar fails loudly
// at first use instead of silently misbehaving (the stub throws on call).
const TUI_STUB = `
module.exports = new Proxy(function tuiStub() {
  throw new Error("wudao-server (SEA): TUI module is stubbed out of the desktop sidecar");
}, {
  get(target, prop) {
    if (prop === "default" || prop === "__esModule") return target;
    if (typeof prop === "symbol") return undefined;
    return target;
  },
  apply(target) { throw new Error("wudao-server (SEA): TUI module is stubbed out of the desktop sidecar"); },
});
`;

const tuiStubPlugin = {
  name: "tui-stub",
  setup(builder) {
    builder.onResolve({ filter: /^(ink|react|react-dom|ink-testing-library)(\/.*)?$/ }, (args) => ({
      path: args.path,
      namespace: "tui-stub",
    }));
    builder.onLoad({ filter: /.*/, namespace: "tui-stub" }, () => ({ contents: TUI_STUB, loader: "js" }));
  },
};

// CJS output replaces `import.meta` with an empty object; the one live use
// (ui.ts's web-dist probe) needs a real URL. Rewrite it to the __filename
// equivalent so the bundle also runs under plain `node` (debugging/dev).
const importMetaUrlFix = {
  name: "import-meta-url-cjs",
  setup(builder) {
    builder.onLoad({ filter: /\.(js|cjs)$/ }, async (args) => {
      const contents = await readFile(args.path, "utf8");
      if (!contents.includes("import.meta.url")) return null;
      return {
        contents: contents.replaceAll(
          "import.meta.url",
          `require("url").pathToFileURL(__filename).href`,
        ),
        loader: "js",
      };
    });
  },
};

async function bundleServer() {
  log("[sea] esbuild: single-file CJS bundle of the wudao ui stack");
  await mkdir(SEA_DIR, { recursive: true });
  await build({
    entryPoints: [join(APPS_DIR, "src", "sea-entry.cjs")],
    outfile: join(SEA_DIR, "wudao-server.cjs"),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    sourcemap: false,
    legalComments: "none",
    plugins: [tuiStubPlugin, importMetaUrlFix],
    // ws's optional native accelerators — never installed, always guarded at
    // runtime by try/require in ws itself. node-pty (P2-12): the terminal
    // tool's dynamic import degrades the same way in the sea blob — the tool
    // just doesn't register (warn once); terminal.enabled defaults false.
    // playwright-core (ω99-112): its coreBundle lazy-requires
    // chromium-bidi/... subpaths that cannot resolve under pnpm — unbundled
    // on purpose. The browser runtime detects node:sea and answers every
    // browser tool with the honest "not in the desktop bundle yet" error
    // (browser SEA support is the ω99-113 debt); dev/terminal mode is
    // unaffected (real node_modules on disk).
    external: ["bufferutil", "utf-8-validate", "node-pty", "playwright-core"],
    logLevel: "warning",
  });
}

async function writeSeaConfig() {
  const files = await walk(WEB_DIST);
  if (!files.includes("index.html")) throw new Error(`${WEB_DIST} has no index.html — run the web build first`);
  const manifestPath = join(SEA_DIR, "web-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify({ files }, null, 2)}\n`);
  const assets = { "web/manifest.json": manifestPath };
  for (const rel of files) assets[`web/${rel}`] = join(WEB_DIST, rel);
  const config = {
    main: join(SEA_DIR, "wudao-server.cjs"),
    output: join(SEA_DIR, "wudao-server.blob"),
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
    assets,
  };
  const configPath = join(SEA_DIR, "sea-config.json");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { files, configPath };
}

function targetList(args) {
  if (process.env.DESKTOP_SIDECAR_TARGETS) return process.env.DESKTOP_SIDECAR_TARGETS.split(",").map((s) => s.trim());
  if (args.includes("--host-only")) return [HOST_TRIPLE];
  if (process.platform === "darwin") return ["x86_64-apple-darwin", "aarch64-apple-darwin"]; // universal dmg
  return [HOST_TRIPLE];
}

async function buildOneTarget(triple, { configPath, strategy }) {
  const platform = triple.endsWith("-apple-darwin") ? "darwin"
    : triple.endsWith("-pc-windows-msvc") ? "win32"
    : "linux";
  const nodeBin = await ensureNodeBinary(process.versions.node, platform, nodeArchOf(triple));
  // Windows executables carry .exe — tauri's externalBin appends it itself,
  // so the staged sidecar must already be named for it.
  const dest = join(BINARIES_DIR, `wudao-server-${triple}${platform === "win32" ? ".exe" : ""}`);
  await mkdir(BINARIES_DIR, { recursive: true });

  if (strategy === "bundled-runtime") {
    // The documented fallback: `wudao-server-<triple>` IS a pristine node
    // binary; the self-contained server bundle + web build ride as Tauri
    // resources (sidecar-resources/) and the shell spawns
    // `wudao-server <resources>/wudao-server.cjs`. Same stdout protocol,
    // same lifecycle; see docs/desktop.md §SEA for the tradeoffs.
    log(`[sea] ${triple}: bundled-runtime (node + bundle + web resources)`);
    await copyFile(nodeBin, dest);
    await chmod(dest, 0o755);
    await materializeRuntimeResources();
  } else {
    const work = await mkdtemp(join(tmpdir(), `wudao-sea-${triple}-`));
    const binary = join(work, `node-${triple}`);
    // A fresh copy of the target-arch node binary, unsigned for injection.
    await copyFile(nodeBin, binary);
    await chmod(binary, 0o755);
    if (platform === "darwin") {
      // Official dist binaries are signed; the signature covers the regions
      // postject writes into, so remove it first (re-signed ad-hoc below).
      const res = spawnSync("codesign", ["--remove-signature", binary], { stdio: "ignore" });
      if (res.status !== 0) log(`[sea] note: codesign --remove-signature failed on ${triple} (continuing)`);
    }
    if (strategy === "node-compile") {
      log(`[sea] ${triple}: node --compile (one-shot)`);
      run(process.execPath, ["--compile", join(SEA_DIR, "wudao-server.cjs"), "-o", binary]);
    } else {
      log(`[sea] ${triple}: node --experimental-sea-config + postject`);
      run(process.execPath, ["--experimental-sea-config", configPath], { cwd: APPS_DIR });
      const args = [binary, "NODE_SEA_BLOB", join(SEA_DIR, "wudao-server.blob"), "--sentinel-fuse", SENTINEL_FUSE];
      if (platform === "darwin") args.push("--macho-segment-name", "__NODE_SEA");
      run(postjectBin(), args);
    }
    if (platform === "darwin") {
      run("codesign", ["--sign", "-", binary]); // ad-hoc: required to execute on macOS
    }
    await copyFile(binary, dest);
    await chmod(dest, 0o755);
    await rm(work, { recursive: true, force: true });
    // SEA single-binary mode must NOT leave stale runtime resources around —
    // the shell detects the mode by their presence.
    await materializeRuntimeResources({ clean: true });
  }
  const info = await stat(dest);
  log(`[sea] ${triple}: ${(info.size / 1_048_576).toFixed(1)} MB → ${relative(REPO_ROOT, dest)}`);
}

// ω99-117: the browser runtime's playwright-core rides as a resource SIBLING
// of the bundled wudao-server.cjs — node resolves the bare specifier by
// walking up from the cjs, so Resources/sidecar-resources/node_modules hits.
// The placeholder mirrors web/assets/README.md's job: tauri's resource globs
// must match something in EVERY mode (an empty glob is a hard bundler error),
// and a committed file is impossible here — the root .gitignore's blanket
// `node_modules/` ignores this whole subtree. build-sea therefore writes the
// placeholder itself in both modes (same deal as web/pet/, which also only
// exists after a build).
const PLAYWRIGHT_PLACEHOLDER = `# node_modules/playwright-core (generated)

This directory is populated by \`pnpm desktop:sea\` (bundled-runtime mode
ships the full playwright-core package here; SEA mode leaves only this
placeholder). Do not commit anything under node_modules/.
`;

/**
 * Resolve + verify the playwright-core copy plan (ω99-117). Version is
 * asserted against the pnpm-lock pin BEFORE any copying — lock drift fails
 * the build loudly instead of quietly shipping a mismatched driver. Throws
 * (typed, via the plan's code) on missing package / unreadable pin / drift.
 */
async function playwrightResourcePlan() {
  const sourceDir = join(REPO_ROOT, "packages", "browser", "node_modules", "playwright-core");
  let packageJsonFound = false;
  let onDiskVersion;
  try {
    onDiskVersion = JSON.parse(await readFile(join(sourceDir, "package.json"), "utf8")).version;
    packageJsonFound = true;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const pinnedVersion = parsePlaywrightPin(await readFile(join(REPO_ROOT, "pnpm-lock.yaml"), "utf8"));
  const plan = planPlaywrightCoreCopy({ packageJsonFound, onDiskVersion, pinnedVersion, sourceDir });
  if (plan.status === "error") {
    throw new Error(`build-sea: [${plan.code}] ${plan.message}`);
  }
  return plan;
}

/** Ship the runtime-mode payloads as Tauri resources (bundled-runtime only).
 *  The committed README placeholders survive the rewrite — tauri's resource
 *  globs are single-level and must match something in EVERY mode, so each
 *  depth carries one (/, web/, web/assets/); node_modules/playwright-core/
 *  gets a build-written placeholder (see PLAYWRIGHT_PLACEHOLDER). Idempotent
 *  across the per-target invocations (runs once per sidecar triple). */
async function materializeRuntimeResources({ clean = false } = {}) {
  const dir = join(APPS_DIR, "src-tauri", "sidecar-resources");
  await rm(join(dir, "wudao-server.cjs"), { force: true });
  const webDir = join(dir, "web");
  const assetsDir = join(webDir, "assets");
  await mkdir(assetsDir, { recursive: true });
  // web/: drop generated entries, keep the README placeholder + assets/ + pet/
  // (pet/ carries its own placeholder below — tauri's web/pet/* glob must
  // match something in EVERY mode, and in SEA mode the skins ride INSIDE the
  // binary as SEA assets, never as loose resource files).
  for (const entry of await readdir(webDir, { withFileTypes: true })) {
    if (entry.name === "README.md" || entry.name === "assets" || entry.name === "pet") continue;
    await rm(join(webDir, entry.name), { recursive: true, force: true });
  }
  // web/assets/: drop generated entries, keep the README placeholder
  for (const entry of await readdir(assetsDir, { withFileTypes: true })) {
    if (entry.name === "README.md") continue;
    await rm(join(assetsDir, entry.name), { recursive: true, force: true });
  }
  // web/pet/: reset to the placeholder in every mode (same deal as
  // playwright-core: SEA-clean keeps exactly it — the skins are SEA assets;
  // bundled-runtime re-copies the real PNGs from the web dist over it).
  const petDir = join(webDir, "pet");
  await mkdir(petDir, { recursive: true });
  for (const entry of await readdir(petDir, { withFileTypes: true })) {
    if (entry.name === "README.md") continue;
    await rm(join(petDir, entry.name), { recursive: true, force: true });
  }
  await writeFile(
    join(petDir, "README.md"),
    "# web/pet (generated)\n\nPet window skins. In SEA mode they ride inside the\nsingle-file sidecar as SEA assets; in bundled-runtime mode\n`pnpm desktop:sea` copies packages/web/dist/pet/ here.\nDo not commit anything in this directory.\n",
  );
  // node_modules/playwright-core/: reset to the placeholder in every mode
  // (SEA-clean keeps exactly it; bundled re-copies the real package over).
  const pwDir = join(dir, "node_modules", "playwright-core");
  await mkdir(pwDir, { recursive: true });
  for (const entry of await readdir(pwDir, { withFileTypes: true })) {
    if (entry.name === "README.md") continue;
    await rm(join(pwDir, entry.name), { recursive: true, force: true });
  }
  await writeFile(join(pwDir, "README.md"), PLAYWRIGHT_PLACEHOLDER);
  if (clean) return;
  const plan = await playwrightResourcePlan();
  await copyFile(join(SEA_DIR, "wudao-server.cjs"), join(dir, "wudao-server.cjs"));
  const webFiles = await walk(WEB_DIST);
  for (const rel of webFiles) {
    const target = join(webDir, rel);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(WEB_DIST, rel), target);
  }
  // Copy the package body only — playwright-core 1.63.0 has zero
  // dependencies/optionalDependencies/peerDependencies (verified), and the
  // filter skips any nested node_modules as discipline regardless. dereference
  // follows the pnpm symlink into the store so the REAL files are copied.
  await cp(plan.sourceDir, pwDir, {
    recursive: true,
    dereference: true,
    filter: (src) => basename(src) !== "node_modules",
  });
  log(`[sea] sidecar resources: ${runtimeResourceManifest({ webFiles, playwright: plan }).join(" · ")}`);
}

async function main() {
  const args = process.argv.slice(2);
  const started = Date.now();
  let strategy;
  if (process.platform === "win32") {
    // Windows 首航对齐出货配方：macOS dmg 一直走 bundled-runtime（node +
    // bundle + web 资源，每日打包验证）；SEA 探针在 Windows runner 上碰巧
    // 通过就会走 postject-into-node.exe 的从未验证路径（0.4.21 揭发：探针
    // 绿≠产物可跑）。等产品面在 Windows 真机验证后再开 SEA 实验。
    strategy = "bundled-runtime";
  } else if (supportsNodeCompile()) strategy = "node-compile";
  else if (await seaHealthy()) strategy = "sea";
  else strategy = "bundled-runtime";
  log(
    `[sea] node ${process.versions.node} · host ${HOST_TRIPLE} · strategy ${strategy}` +
    (strategy === "bundled-runtime"
      ? " (SEA probe FAILED on this host — see docs/desktop.md §SEA; the sidecar ships node + bundle + web resources)"
      : ""),
  );

  await buildPackages();
  await bundleServer();
  const { files, configPath } = await writeSeaConfig();
  log(`[sea] web assets embedded: ${files.length} files`);

  const targets = targetList(args);
  log(`[sea] sidecar targets: ${targets.join(", ")}`);
  for (const triple of targets) {
    await buildOneTarget(triple, { configPath, strategy });
  }
  // Tauri's universal-apple-darwin bundle expects ONE sidecar file named for
  // the universal triple — merge the per-arch sidecars ourselves.
  if (targets.includes("x86_64-apple-darwin") && targets.includes("aarch64-apple-darwin")) {
    const universal = join(BINARIES_DIR, "wudao-server-universal-apple-darwin");
    run("lipo", [
      "-create",
      "-output", universal,
      join(BINARIES_DIR, "wudao-server-x86_64-apple-darwin"),
      join(BINARIES_DIR, "wudao-server-aarch64-apple-darwin"),
    ]);
    const info = await stat(universal);
    log(`[sea] universal: ${(info.size / 1_048_576).toFixed(1)} MB → ${relative(REPO_ROOT, universal)}`);
  }
  log(`[sea] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  process.stderr.write(`build-sea: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
