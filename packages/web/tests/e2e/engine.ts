// PB-3 E2E — 真实浏览器引擎的选定与发射（每 worker 一进程，测试间共享）。
//
// 选定序（确定、可观察、每候选带 45s 竞速——挂死的候选绝不拖死整个套件）：
//   ① WUDAO_E2E_BROWSER_EXE —— 显式可执行文件覆盖（任何引擎，CI/本机皆可）
//   ② 真实 WebKit —— playwright-core 自身的 pinned 构建（macOS 13+ / Linux
//      CI 已装时命中）。这是 PB-3 的首选引擎；本仓 pin 的 1.63 在 macOS 12
//      无 webkit 构建（registry 表里 mac12 = void），这类机器落到 ③。
//   ③ 机器的 playwright 缓存里最新的 chromium-*（Chrome-for-Testing）——
//      与 @wudao/browser 包为产品准备的内核同族。
// 依赖纪律：playwright-core 只在 @wudao/browser 的依赖树里（PB-3 不新增
// 依赖）。pnpm 隔离下本包解析不到它 —— createRequire 挂到 browser 包目录
// 解析（node 的语义解析会走 packages/browser/node_modules）。
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 我们用到的 playwright 最小结构面（避免 tsc 依赖 playwright 类型包）。 */
export interface PwBrowser {
  newContext(opts?: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
  version?(): Promise<string>;
}
export interface PwContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
export interface PwPage {
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  click(selector: string, opts?: Record<string, unknown>): Promise<void>;
  fill(selector: string, text: string, opts?: Record<string, unknown>): Promise<void>;
  press(selector: string, key: string, opts?: Record<string, unknown>): Promise<void>;
  $(selector: string): Promise<{ textContent(): Promise<string | null> } | null>;
  $$eval<R>(selector: string, fn: (els: unknown[]) => R, arg?: unknown): Promise<R>;
  waitForSelector(selector: string, opts?: Record<string, unknown>): Promise<unknown>;
  evaluate<R>(fn: string | ((...a: unknown[]) => R), arg?: unknown): Promise<R>;
  title(): Promise<string>;
  close(): Promise<void>;
  on(event: string, cb: (msg: unknown) => void): void;
  content(): Promise<string>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
// tests/e2e → web/tests → web → packages —— browser/server 是其下的兄弟包。
const PACKAGES_ROOT = join(HERE, "..", "..", "..");
const BROWSER_PACKAGE_ROOT = join(PACKAGES_ROOT, "browser");

type PlaywrightModule = {
  webkit: { launch(opts?: Record<string, unknown>): Promise<PwBrowser> };
  chromium: { launch(opts?: Record<string, unknown>): Promise<PwBrowser> };
};

/** playwright-core 经 @wudao/browser 的依赖树解析（无新依赖的纪律面）。 */
export function loadPlaywright(): PlaywrightModule {
  const req = createRequire(join(BROWSER_PACKAGE_ROOT, "package.json"));
  return req("playwright-core") as PlaywrightModule;
}

/** 每候选竞速预算：挂死的候选（不兼容的系统 Chrome 等）到此放弃。 */
const LAUNCH_BUDGET_MS = 45_000;

async function withBudget<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: launch exceeded ${LAUNCH_BUDGET_MS}ms`)), LAUNCH_BUDGET_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 候选引擎必须真的能驱动（newPage + 导航）：版本错配（1.63 的协议设置
 *  撞上老内核的 Unknown setting）在 launch 阶段不报错，首次 newPage 才炸
 *  —— 探针把这些「假成功」挡在候选序里，落到真能开的引擎上。 */
async function drivable(browser: PwBrowser): Promise<void> {
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.goto("data:text/html,<title>wudao-e2e-probe</title>");
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** ①显式覆盖 ②pinned WebKit ③缓存 CFT Chromium —— 依次尝试，收集失败清单。 */
export async function launchEngine(): Promise<{ browser: PwBrowser; engine: string }> {
  const pw = loadPlaywright();
  const tried: string[] = [];

  const tryCandidate = async (label: string, launch: () => Promise<PwBrowser>): Promise<{ browser: PwBrowser; engine: string } | null> => {
    let browser: PwBrowser | null = null;
    try {
      browser = await withBudget(label, launch);
      await withBudget(`${label} (drivable probe)`, () => drivable(browser as PwBrowser));
      return { browser: browser as PwBrowser, engine: label };
    } catch (e) {
      await browser?.close().catch(() => {});
      tried.push(`${label} → ${errText(e)}`);
      return null;
    }
  };

  const exe = (process.env["WUDAO_E2E_BROWSER_EXE"] ?? "").trim();
  if (exe !== "") {
    const hit = await tryCandidate(`env:${exe}`, () => pw.chromium.launch({ executablePath: exe, headless: true }));
    if (hit !== null) return hit;
  }

  const webkitHit = await tryCandidate("webkit", () => pw.webkit.launch({ headless: true }));
  if (webkitHit !== null) return webkitHit;

  const cached = cachedChromiumExecutable();
  if (cached !== null) {
    const hit = await tryCandidate(`chromium:${cached}`, () => pw.chromium.launch({ executablePath: cached, headless: true }));
    if (hit !== null) return hit;
  }

  throw new Error(
    `E2E 无法启动任何可驱动的真实浏览器引擎。已尝试：\n  ${tried.join("\n  ")}\n` +
      `解法（任一）：安装 pinned WebKit（playwright 1.63 的 webkit 构建）；或设 WUDAO_E2E_BROWSER_EXE 指向一个本地 Chromium 可执行文件。`,
  );
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0]?.slice(0, 200) ?? String(e);
}

/** playwright 缓存里最新的 chromium-* 内核（macOS 的 CFT .app 与 Linux 布局都认）。 */
export function cachedChromiumExecutable(): string | null {
  const roots = [
    process.env["PLAYWRIGHT_BROWSERS_PATH"] ?? "",
    join(homedir(), "Library", "Caches", "ms-playwright"),
    join(homedir(), ".cache", "ms-playwright"),
  ].filter((r) => r !== "" && existsSync(r));
  const MAC_SUFFIX = join("Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
  for (const root of roots) {
    let dirs: string[] = [];
    try {
      dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    } catch {
      continue;
    }
    for (const d of dirs) {
      const base = join(root, d);
      // macOS: chromium-*/chrome-mac[-x64|arm64]/Google Chrome for Testing.app/…
      try {
        for (const sub of readdirSync(base)) {
          const exe = join(base, sub, MAC_SUFFIX);
          if (existsSync(exe)) return exe;
        }
      } catch {
        /* fallthrough */
      }
      // Linux: chromium-*/chrome-linux64/chrome | chrome-linux/chrome
      for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
        const exe = join(base, rel);
        if (existsSync(exe)) return exe;
      }
    }
  }
  return null;
}
