// desktop:smoke — end-to-end check of the SEA sidecar WITHOUT the Rust
// shell: launch the compiled binary, await its protocol line, verify the web
// UI is actually served from the embedded assets (HTML + a hashed asset),
// then terminate (SIGTERM path) and confirm a clean exit. Run after
// `desktop:sea`. Uses a scratch workspace + a dummy API key: the model is
// never called before the first submit, so no network is needed.
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchSidecar, terminateSidecar } from "./sidecar-protocol.ts";

const APPS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function hostTriple(): string {
  const arch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch;
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  if (process.platform === "win32") return `${arch}-pc-windows-msvc`;
  return `${arch}-unknown-linux-gnu`;
}

const sidecar = join(APPS_DIR, "src-tauri", "binaries", `wudao-server-${hostTriple()}${process.platform === "win32" ? ".exe" : ""}`);

// Mode detection mirrors the Rust shell: a server-bundle resource next to
// the tree means bundled-runtime (node + bundle); otherwise the sidecar is
// the single-file SEA executable.
const runtimeBundle = join(APPS_DIR, "src-tauri", "sidecar-resources", "wudao-server.cjs");
const bundledRuntime = await isFile(runtimeBundle);

const workspace = await mkdtemp(join(tmpdir(), "wudao-smoke-"));
try {
  const t0 = Date.now();
  const launched = await launchSidecar({
    command: sidecar,
    ...(bundledRuntime ? { args: [runtimeBundle] } : {}),
    cwd: workspace,
    env: {
      WUDAO_API_KEY: "smoke-dummy-key",
      ...(bundledRuntime ? { WUDAO_UI_STATIC_DIR: join(APPS_DIR, "src-tauri", "sidecar-resources", "web") } : {}),
    },
    timeoutMs: 30_000,
  });
  const bootMs = Date.now() - t0;
  console.log(`mode=${bundledRuntime ? "bundled-runtime" : "sea"} · protocol line in ${bootMs}ms: ${launched.handshake.url.replace(/#.+$/, "#<token>")}`);

  const page = await fetch(`http://127.0.0.1:${launched.handshake.port}/`);
  const html = await page.text();
  // 品牌弧（9942866b）后 title=悟道Harness——旧钉 <title>wudao 随源演进。
  if (page.status !== 200 || !/<title>悟道Harness<\/title>/.test(html)) {
    throw new Error(`index.html not served (status ${page.status}, ${html.length} bytes)`);
  }
  const asset = /(?:src|href)="\/?(assets\/[^"]+)"/.exec(html)?.[1];
  if (asset === undefined) throw new Error(`no hashed asset reference found in index.html`);
  const assetRes = await fetch(`http://127.0.0.1:${launched.handshake.port}/${asset}`);
  if (assetRes.status !== 200) throw new Error(`asset ${asset} -> ${assetRes.status}`);
  console.log(`web UI served from embedded assets (index + ${asset}, ${(await assetRes.text()).length} bytes)`);

  const method = await terminateSidecar(launched.child, { graceMs: 5_000 });
  if (method !== "terminated") throw new Error(`sidecar needed ${method} (expected clean SIGTERM termination)`);
  console.log(`sidecar terminated cleanly (SIGTERM), workspace: ${workspace}`);
  console.log("SMOKE PASS");
} finally {
  await rm(workspace, { recursive: true, force: true });
}
