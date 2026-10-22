// tauri-build wrapper — picks the bundle target per platform:
//   darwin  → universal-apple-darwin (aarch64 + x86_64 in one .dmg; needs
//             both sidecar triples, which build-sea.mjs produces)
//   win/linux → host default (nsis / AppImage+deb; CI picks explicitly)
// Override: DESKTOP_TAURI_TARGET=a,b,c (comma list, passed through).
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSync } from "./spawn.mjs";

const APPS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
// On win32 the .bin tauri shim is a .CMD spawnSync can't exec — spawn.mjs
// resolves the command through the shim machinery; elsewhere use the path.
const cli = process.platform === "win32" ? "tauri" : join(APPS_DIR, "node_modules", ".bin", "tauri");

// ω99-212: #4 — the click helper. Compile src-tauri/helper/wudao-click.swift
// into a UNIVERSAL binary (swiftc both arches + lipo) at
// sidecar-resources/wudao-click — beside the sidecar's resource home, so the
// bundled server finds it via the cli's known-path resolution
// (dirname(execPath)/../Resources/sidecar-resources/wudao-click). `xcrun -f
// swiftc` absent (no CLT) → WARN + SKIP (never block the bundle; the cli's
// computer.click degrades to its structured guidance error). The output is a
// build artifact — never committed (resources are bundled per-build).
function buildClickHelper() {
  if (process.platform !== "darwin") return;
  const probe = spawnSync("xcrun", ["-f", "swiftc"], { encoding: "utf8" });
  if (probe.status !== 0 || (probe.error !== undefined)) {
    process.stdout.write("[click-helper] WARN: xcrun swiftc not found — skipping wudao-click (computer.click will degrade to its guidance error)\n");
    return;
  }
  const src = join(APPS_DIR, "src-tauri", "helper", "wudao-click.swift");
  const out = join(APPS_DIR, "src-tauri", "sidecar-resources", "wudao-click");
  const work = mkdtempSync(join(tmpdir(), "wudao-click-"));
  try {
    // `arm64` (not `aarch64`): ld rejects -arch aarch64 on this toolchain.
    const arches = [["arm64-apple-macosx12", "click-arm64"], ["x86_64-apple-macosx12", "click-x64"]];
    for (const [triple, name] of arches) {
      const res = spawnSync("xcrun", ["swiftc", "-target", triple, "-O", src, "-o", join(work, name)], { stdio: "inherit" });
      if (res.status !== 0) throw new Error(`swiftc failed for ${triple} (exit ${res.status})`);
    }
    const lipo = spawnSync("lipo", ["-create", "-output", out, join(work, "click-arm64"), join(work, "click-x64")], { stdio: "inherit" });
    if (lipo.status !== 0) throw new Error(`lipo failed (exit ${lipo.status})`);
    chmodSync(out, 0o755);
    process.stdout.write("[click-helper] built universal wudao-click → src-tauri/sidecar-resources/wudao-click\n");
  } catch (err) {
    process.stdout.write(`[click-helper] WARN: ${err instanceof Error ? err.message : String(err)} — skipping wudao-click (bundle continues)\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

buildClickHelper();

const targets = process.env.DESKTOP_TAURI_TARGET
  ? process.env.DESKTOP_TAURI_TARGET.split(",").map((s) => s.trim())
  : process.platform === "darwin" ? ["universal-apple-darwin"] : [];

const args = ["build", ...targets.flatMap((t) => ["--target", t])];
process.stdout.write(`[tauri] ${args.join(" ")}\n`);
const res = runSync(cli, args, { stdio: "inherit", cwd: APPS_DIR });
process.exit(res.status ?? 1);
