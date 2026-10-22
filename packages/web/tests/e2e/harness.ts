// PB-3 E2E — 测试夹具框架：真实 server（ephemeral port + fake driver）+
// 真实 web bundle（packages/web/dist，vite build 的产物）+ 真实浏览器引擎
// （engine.ts 的选定序：WebKit 优先，缓存 Chromium 兜底）。每测试独立
// server + 浏览器上下文（隔离）；浏览器进程每 worker 共享一次发射。
//
// server 的解析纪律与 playwright 相同：@wudao/server 不在 web 的依赖里
// （PB-3 零新依赖），createRequire 挂到 server 包目录直取其 dist。
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HistoryEntry } from "../../src/protocol.js";
import { FakeDriver, type FakeSeed, type FakeTurn } from "./fake-driver.js";
import { launchEngine, type PwBrowser, type PwContext, type PwPage } from "./engine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(HERE, "..", "..");

/** @wudao/server 的最小结构面（createUiServer 的返回 + 构造项）。 */
interface UiServer {
  readonly port: number;
  readonly token: string;
  close(): Promise<void>;
}
interface UiServerOptions {
  driver: unknown;
  laneFactory?: (sessionId: string, sid: string) => Promise<unknown>;
  staticDir?: string;
  port?: number;
  token?: string;
}

function loadCreateUiServer(): (opts: UiServerOptions) => Promise<UiServer> {
  const req = createRequire(join(WEB_ROOT, "..", "server", "package.json"));
  const mod = req("./dist/index.js") as { createUiServer: (opts: UiServerOptions) => Promise<UiServer> };
  return mod.createUiServer;
}

/** vite build 的 web bundle 目录（server 的 staticDir）。缺产物 = 明确报错。 */
export function webDist(): string {
  const dist = join(WEB_ROOT, "dist");
  if (!existsSync(join(dist, "index.html"))) {
    throw new Error(`E2E 需要 packages/web/dist/index.html —— 先跑 pnpm -C packages/web build`);
  }
  return dist;
}

// ---- 共享浏览器进程（每 worker 一次） ---------------------------------------

let sharedBrowser: { readonly browser: PwBrowser; readonly engine: string } | null = null;

export async function acquireBrowser(): Promise<{ readonly browser: PwBrowser; readonly engine: string }> {
  if (sharedBrowser === null) {
    sharedBrowser = await launchEngine();
    // 诊断面：E2E 实际驱动的引擎一眼可见（WebKit 缺席的机器上这是唯一诚实信号）。
    console.error(`[wudao-e2e] browser engine: ${sharedBrowser.engine}`);
  }
  return sharedBrowser;
}

export async function releaseBrowser(): Promise<void> {
  const b = sharedBrowser;
  sharedBrowser = null;
  if (b !== null) await b.browser.close().catch(() => {});
}

// ---- 页夹具（真实 DOM 上的操作面） ------------------------------------------

export class PageFixture {
  readonly page: PwPage;
  private readonly pollMs = 120;

  constructor(page: PwPage) {
    this.page = page;
  }

  async click(selector: string, opts?: Record<string, unknown>): Promise<void> {
    await this.page.click(selector, { timeout: 10_000, ...opts });
  }

  /** DOM 级点击（el.click()）：给顶栏钮用——.topbar 带 -webkit-app-region:
   *  drag，Chromium 里拖拽区吞指针命中（WKWebView/Tauri 才是产品形态，
   *  那里该属性被忽略、真点击可达）。JS click 事件照样走 React 合成事件。 */
  async clickDom(selector: string): Promise<void> {
    await this.page.waitForSelector(selector, { state: "attached", timeout: 10_000 });
    const hit = await this.page.$$eval(selector, (els) => {
      (els[0] as HTMLElement | undefined)?.click();
      return els.length;
    });
    if (hit === 0) throw new Error(`clickDom: ${selector} 无命中`);
  }

  /** 输入文本（fill = 一次性替换，playwright 的真实键盘路径）。清空走键盘
   *  （全选+退格）：playwright 的 fill("") 会合成一次 Delete 键——在会话
   *  弹框里恰好是「进删除确认」的快捷键，纯属伪影，真实用户打不出来。 */
  async type(selector: string, text: string): Promise<void> {
    if (text === "") {
      await this.page.click(selector, { timeout: 10_000 });
      await this.page.press(selector, "Meta+a", { timeout: 10_000 });
      await this.page.press(selector, "Backspace", { timeout: 10_000 });
      return;
    }
    await this.page.fill(selector, text, { timeout: 10_000 });
  }

  async press(selector: string, key: string): Promise<void> {
    await this.page.press(selector, key, { timeout: 10_000 });
  }

  async expectVisible(selector: string, timeoutMs = 10_000): Promise<void> {
    await this.page.waitForSelector(selector, { state: "visible", timeout: timeoutMs });
  }

  async expectGone(selector: string, timeoutMs = 10_000): Promise<void> {
    await this.page.waitForSelector(selector, { state: "detached", timeout: timeoutMs }).catch(async () => {
      // detached 不可达时（元素在但隐藏）退到 hidden —— 两者都算「不在场」。
      await this.page.waitForSelector(selector, { state: "hidden", timeout: 1_000 });
    });
  }

  /** 轮询直到 selector 命中集中某元素包含 text（子串）。 */
  async expectText(selector: string, text: string, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    for (;;) {
      const texts = await this.texts(selector);
      if (texts.some((t) => t.includes(text))) return;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`expectText 超时：${selector} 中等「${text}」未出现（当前：${JSON.stringify(texts.slice(0, 6))}）`);
      }
      await wait(this.pollMs);
    }
  }

  /** 反向断言（两段语义）：先给过渡窗口等「text 退场」（状态切换后行刷新
   *  有一个 op 往返的延迟——第一拍在场是合法的），再给一个稳定窗口确认
   *  它保持不在场。全程超时仍在场 = 失败。 */
  async expectNotText(selector: string, text: string, settleMs = 1_500, waitMs = 10_000): Promise<void> {
    const start = Date.now();
    const present = async (): Promise<boolean> =>
      (await this.texts(selector)).some((t) => t.includes(text));
    while (await present()) {
      if (Date.now() - start > waitMs) {
        throw new Error(`expectNotText 超时：${selector} 中「${text}」迟迟不退场`);
      }
      await wait(this.pollMs);
    }
    const holdUntil = Date.now() + Math.min(settleMs, 1_500);
    while (Date.now() < holdUntil) {
      if (await present()) {
        throw new Error(`expectNotText 失败：${selector} 中出现了「${text}」`);
      }
      await wait(this.pollMs);
    }
  }

  async texts(selector: string): Promise<string[]> {
    return this.page.$$eval(selector, (els) => (els as HTMLElement[]).map((e) => e.textContent ?? ""));
  }

  async textOf(selector: string): Promise<string> {
    const el = await this.page.$(selector);
    if (el === null) return "";
    return (await el.textContent()) ?? "";
  }

  async count(selector: string): Promise<number> {
    return this.page.$$eval(selector, (els) => els.length);
  }

  /** 等到应用真正连上（连接盖板退场、输入框在场）。 */
  async expectAppReady(timeoutMs = 15_000): Promise<void> {
    await this.expectVisible("textarea.composer-ta", timeoutMs);
  }

  /** 在输入框打一句话并回车发送（真实键盘路径）。 */
  async submitComposer(text: string): Promise<void> {
    await this.type("textarea.composer-ta", text);
    await this.press("textarea.composer-ta", "Enter");
  }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Node 侧条件等待（fake driver 状态等非 DOM 事实的断言面）。 */
export async function waitFor(what: string, cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor 超时：${what}`);
    await wait(60);
  }
}

// ---- E2E 夹具 ---------------------------------------------------------------

export interface E2EOptions {
  /** 种子 ui.defaultMode（App boot 的 shell 解析源）。默认 buddy（侧栏主场）。 */
  readonly mode?: "advanced" | "buddy" | "simple";
  /** 主车道会话 id。 */
  readonly mainId?: string;
  /** 主会话既有史（auth 重放即见）。 */
  readonly mainEntries?: readonly HistoryEntry[];
  /** 主会话剧本。 */
  readonly mainScript?: readonly FakeTurn[];
  /** 种子副会话（侧栏/弹框列表的数据源）。 */
  readonly seeds?: readonly FakeSeed[];
  /** 额外设置项（language.reply 等）。 */
  readonly settings?: Record<string, unknown>;
}

export interface E2EFixture {
  readonly driver: FakeDriver;
  readonly server: UiServer;
  readonly url: string;
  readonly page: PageFixture;
  /** 杀掉并同 port/token 重建 server（断连重连路径）。 */
  restartServer(): Promise<void>;
  dispose(): Promise<void>;
}

export async function startE2E(opts: E2EOptions = {}): Promise<E2EFixture> {
  const driver = new FakeDriver(opts.mainId ?? "wudao-e2e-main");
  driver.settings["ui.defaultMode"] = opts.mode ?? "buddy";
  driver.defaultScript = opts.mainScript ?? [];
  for (const [k, v] of Object.entries(opts.settings ?? {})) driver.settings[k] = v;
  if (opts.mainEntries !== undefined || opts.mainScript !== undefined) {
    driver.seed({
      id: opts.mainId ?? "wudao-e2e-main",
      entries: opts.mainEntries,
      script: opts.mainScript,
      firstUser: firstUserOf(opts.mainEntries),
    });
  }
  for (const s of opts.seeds ?? []) driver.seed(s);

  const createUiServer = loadCreateUiServer();
  const staticDir = webDist();
  const token = "wudao-e2e-token";
  const bootServer = async (port: number): Promise<UiServer> => {
    // 同 port 重建：旧 socket 释放有竞态，EADDRINUSE 小步重试（总窗 ~5s）。
    const start = Date.now();
    for (;;) {
      try {
        return await createUiServer({ driver, laneFactory: (id) => driver.openLane(id), staticDir, port, token });
      } catch (e) {
        if (!String(e).includes("EADDRINUSE") || Date.now() - start > 5_000) throw e;
        await wait(150);
      }
    }
  };

  let server = await bootServer(0);
  const { browser, engine } = await acquireBrowser();
  const context: PwContext = await browser.newContext();
  let page: PageFixture;
  try {
    const rawPage: PwPage = await context.newPage();
    page = new PageFixture(rawPage);
    await rawPage.goto(`http://127.0.0.1:${server.port}/#${token}`);
  } catch (err) {
    // 半途失败不泄漏 server/上下文（beforeEach 抛出时 afterEach 无 fx 可收）。
    await context.close().catch(() => {});
    await server.close().catch(() => {});
    throw err;
  }

  return {
    driver,
    get server(): UiServer {
      return server;
    },
    url: `http://127.0.0.1:${server.port}/#${token}`,
    page,
    restartServer: async (): Promise<void> => {
      const port = server.port;
      await server.close();
      server = await bootServer(port);
    },
    dispose: async (): Promise<void> => {
      await context.close().catch(() => {});
      await server.close().catch(() => {});
      void engine;
    },
  };
}

function firstUserOf(entries: readonly HistoryEntry[] | undefined): string | undefined {
  const first = entries?.find((e) => e.kind === "user");
  return first !== undefined && first.kind === "user" ? first.text.slice(0, 24) : undefined;
}
