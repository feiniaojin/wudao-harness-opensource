// P2-12（96 队列 #12）node-pty 加载缝 — 本项目第一个原生依赖（1.1.0 精确
// 锁）。动态 import + try/catch：加载失败 → 工具不注册 + 一条 warn，绝不
// fatal（仓库没装原生构建链的环境照常全绿——红线 3）。
//
// 结构化类型（PtyProcess/PtySpawnFn）：manager 与工具面只依赖这两个形状，
// node-pty 的 IPty 天然满足（鸭子缝，M1 ModelClient 端口同款）。测试可注
// 入 fake spawn（ring/确定性边界）或注入抛错 loader（降级道）。
//
// darwin 自愈（有据 workaround）：node-pty 1.1.0 发布包把 darwin 的
// spawn-helper 以 0644 打进 prebuilds/（tarball 内无执行位），而它的
// postinstall 只做 win32 conpty 清理——unix 上没有任何东西恢复执行位，
// posix_spawnp 直接 EACCES（"posix_spawnp failed."）。加载时 best-effort
// chmod 0o755 + X_OK 校验；失败按加载失败降级（报因，不 fatal）。
import { accessSync, chmodSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { IPty } from "node-pty";

/** The process face the manager drives (node-pty's IPty satisfies it). */
export interface PtyProcess {
  write(data: string): void;
  kill(signal?: string): void;
  readonly pid: number | undefined;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

/** spawn(file, args, {name, cwd, env, cols, rows}) → PtyProcess */
export type PtySpawnFn = (file: string, args: string[], options: {
  name: string;
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}) => PtyProcess;

export type PtyLoad =
  | { readonly ok: true; readonly spawn: PtySpawnFn }
  | { readonly ok: false; readonly reason: string };

/** The real node-pty spawn, structurally narrowed to PtySpawnFn. */
const realSpawn: PtySpawnFn = (file, args, options): PtyProcess => {
  // Local require (CJS native) via createRequire — node-pty has no ESM exports.
  const require = createRequire(import.meta.url);
  const pty = require("node-pty") as { spawn(file: string, args: string[], options: unknown): IPty };
  return pty.spawn(file, args, options);
};

/** darwin self-heal: restore the spawn-helper exec bit (see module note). */
function healDarwinHelper(reasonPrefix: string): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const require = createRequire(import.meta.url);
    const pkgRoot = dirname(require.resolve("node-pty/package.json"));
    const helper = join(pkgRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
    chmodSync(helper, 0o755); // best-effort: ENOENT/EACCES fall through to the probe
    accessSync(helper, constants.X_OK);
    return undefined;
  } catch {
    return `${reasonPrefix} (darwin spawn-helper not executable — upstream 1.1.0 tarball ships it 0644; tried self-heal chmod)`;
  }
}

type Loader = () => Promise<PtyLoad>;

const defaultLoad: Loader = async (): Promise<PtyLoad> => {
  try {
    // Dynamic import first: honors the graceful-degradation contract even if
    // the package is absent entirely (external embedders, filtered installs).
    await import("node-pty");
  } catch (err) {
    return { ok: false, reason: `node-pty import failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const healProblem = healDarwinHelper("node-pty darwin helper unusable");
  if (healProblem !== undefined) return { ok: false, reason: healProblem };
  return { ok: true, spawn: realSpawn };
};

let injected: Loader | undefined;
let cached: Promise<PtyLoad> | undefined;
/** The RESOLVED mirror of `cached` — the sync registration check reads this. */
let settled: PtyLoad | undefined;

/**
 * Load node-pty once (cached; success AND failure persist — a broken native
 * install must not re-probe on every registration call). `warn` fires at most
 * once, on failure only (startup-notice discipline).
 */
export function loadNodePty(warn?: (message: string) => void): Promise<PtyLoad> {
  if (cached === undefined) {
    cached = (injected ?? defaultLoad)().catch((err: unknown): PtyLoad => ({
      ok: false,
      reason: `node-pty load failed: ${err instanceof Error ? err.message : String(err)}`,
    }));
    void cached.then((load) => {
      settled = load;
    });
    if (warn !== undefined) {
      void cached.then((load) => {
        if (!load.ok) warn(`terminal tool unavailable — ${load.reason} (settings terminal.enabled stays honored; the tool is simply not registered)`);
      });
    }
  }
  return cached;
}

/**
 * The settled load verdict (undefined until the first loadNodePty resolves).
 * terminalToolsFor's sync registration reads it — index.ts awaits
 * warmTerminalPty at startup so it is already decided by tool-set time.
 */
export function terminalPtyStatus(): PtyLoad | undefined {
  return settled;
}

/** Warm the cache at startup (index.ts awaits this when terminal.enabled). */
export async function warmTerminalPty(warn?: (message: string) => void): Promise<boolean> {
  const load = await loadNodePty(warn);
  return load.ok;
}

/** Test seam: inject a loader (throwing → degradation path), undefined restores. */
export function __setPtyLoaderForTests(loader: Loader | undefined): void {
  injected = loader;
  cached = undefined; // a new loader invalidates the memoized verdict
  settled = undefined;
}
