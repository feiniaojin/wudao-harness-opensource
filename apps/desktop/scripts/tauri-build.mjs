// tauri-build wrapper — picks the bundle target per platform:
//   darwin  → universal-apple-darwin (aarch64 + x86_64 in one .dmg; needs
//             both sidecar triples, which build-sea.mjs produces)
//   win/linux → host default (nsis / AppImage+deb; CI picks explicitly)
// Override: DESKTOP_TAURI_TARGET=a,b,c (comma list, passed through).
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// 117 玻璃化的平台分叉（0.5.4 Windows 实测：主窗除实底区外全透明）：
// conf 的 windowEffects:"sidebar" 是 macOS NSVisualEffectView 专属——Windows
// 上 Tauri 忽略它，但 transparent:true 仍然生效，于是整窗透到桌面，只剩
// 会话流/输入框这些自带实底的区域可见。tauri.conf 不支持按平台分支，所以
// 构建时改写：非 darwin 把主窗 transparent 关掉（宠物窗同理）。
// 改写在进程内进行、不落盘回仓库：读完即改 conf 文件，构建结束恢复原字节。
const CONF = join(APPS_DIR, "src-tauri", "tauri.conf.json");
const confOriginal = readFileSync(CONF, "utf8");
if (process.platform !== "darwin") {
  const conf = JSON.parse(confOriginal);
  // ONLY the main window: its transparency exists to reveal the macOS
  // NSVisualEffectView material, which Windows has no equivalent for — there
  // the flag just made everything see-through. The PET window is different:
  // it is a decorations:false floating sprite, and transparency is what hides
  // its rectangular frame (0.5.5 turned it off too and the pet grew an opaque
  // box). Leave non-main windows alone.
  for (const w of conf.app?.windows ?? []) {
    if (w.label === "main" && w.transparent === true) w.transparent = false;
  }
  writeFileSync(CONF, `${JSON.stringify(conf, null, 2)}\n`);
  process.stdout.write("[tauri] non-darwin: MAIN window transparency disabled (pet keeps its cutout)\n");
}
process.on("exit", () => {
  try { writeFileSync(CONF, confOriginal); } catch { /* best effort */ }
});

const targets = process.env.DESKTOP_TAURI_TARGET
  ? process.env.DESKTOP_TAURI_TARGET.split(",").map((s) => s.trim())
  : process.platform === "darwin" ? ["universal-apple-darwin"] : [];

const args = ["build", ...targets.flatMap((t) => ["--target", t])];
process.stdout.write(`[tauri] ${args.join(" ")}\n`);
const res = runSync(cli, args, { stdio: "inherit", cwd: APPS_DIR });
process.exit(res.status ?? 1);
