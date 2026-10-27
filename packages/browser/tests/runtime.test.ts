// ω99-112 — runtime layer (RED first): the closed→launching→open state
// machine, launch-once memoization, the 10-minute idle reaper (fake clock),
// the process-exit hook, honest launch failures, the executable resolution
// order, and the snapshot ref store. Zero real browser: a Fake port.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserRuntime, resolveExecutablePath, DEFAULT_IDLE_MS } from "../src/runtime.js";
import type { BrowserHandle, BrowserPort, PageHandle } from "../src/port.js";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "wd-browser-rt-")); });
afterEach(async () => { vi.useRealTimers(); await rm(home, { recursive: true, force: true }); });

interface FakeGates {
  launches: { executablePath?: string; env?: Record<string, string>; userDataDir?: string }[];
  killed: number;
  browserClosed: number;
  pageClosed: number;
  releaseLaunch: (() => void) | null;
  failLaunch: Error | null;
}
interface FakePort extends BrowserPort { gates: FakeGates }

function fakePort(opts: { defer?: boolean } = {}): FakePort {
  const gates: FakeGates = { launches: [], killed: 0, browserClosed: 0, pageClosed: 0, releaseLaunch: null, failLaunch: null };
  const makePage = (): PageHandle => ({
    url: async () => "https://example.test/",
    goto: async (u) => ({ finalUrl: u }),
    title: async () => "T",
    evaluate: async () => ({}),
    click: async () => {},
    fill: async () => {},
    text: async () => "body",
    press: async () => {},
    close: async () => { gates.pageClosed++; },
  });
  const handle = (browser: { newPage(): Promise<PageHandle>; close(): Promise<void>; kill?(): void }): BrowserHandle => browser;
  const port: FakePort = {
    gates,
    async launch(o) {
      gates.launches.push({ ...(o.executablePath !== undefined ? { executablePath: o.executablePath } : {}), ...(o.env !== undefined ? { env: { ...o.env } } : {}), ...(o.userDataDir !== undefined ? { userDataDir: o.userDataDir } : {}) });
      if (gates.failLaunch !== null) throw gates.failLaunch;
      if (opts.defer) await new Promise<void>((res) => { gates.releaseLaunch = res; });
      return handle({
        newPage: async () => makePage(),
        close: async () => { gates.browserClosed++; },
        kill: () => { gates.killed++; },
      });
    },
  };
  return port;
}

const baseOpts = (port: FakePort) => ({
  port,
  homeDir: home,
  env: () => ({}) as Record<string, string | undefined>,
  resolveInstalled: async () => "/fake/installed-chromium",
  download: async () => { throw new Error("download must not run when installed"); },
  registerExitHook: () => () => {},
});

describe("state machine + launch-once", () => {
  it("starts closed, goes launching, settles open", async () => {
    const port = fakePort({ defer: true });
    const rt = createBrowserRuntime(baseOpts(port));
    expect(rt.state()).toBe("closed");
    const pending = rt.openPage();
    expect(rt.state()).toBe("launching");
    // let launch() reach the deferred gate. ω99-114: the launch path gained a
    // real-IO await (the profile mkdir) before port.launch, so microtask
    // flushes can no longer see across it — poll on real timers instead.
    await vi.waitFor(() => { expect(port.gates.releaseLaunch).not.toBeNull(); });
    port.gates.releaseLaunch?.();
    await pending;
    expect(rt.state()).toBe("open");
  });

  it("launches exactly once for concurrent and later callers", async () => {
    const port = fakePort();
    const rt = createBrowserRuntime(baseOpts(port));
    const [a, b] = await Promise.all([rt.openPage(), rt.openPage()]);
    expect(a).toBe(b);
    await rt.openPage();
    expect(port.gates.launches).toHaveLength(1);
  });

  it("fails honestly and stays closed; a retry relaunches", async () => {
    const port = fakePort();
    port.gates.failLaunch = new Error("boom");
    const rt = createBrowserRuntime(baseOpts(port));
    await expect(rt.openPage()).rejects.toThrow(/WUDAO_BROWSER_EXECUTABLE/);
    expect(rt.state()).toBe("closed");
    port.gates.failLaunch = null;
    await rt.openPage();
    expect(rt.state()).toBe("open");
  });
});

describe("idle reaper (fake clock)", () => {
  it("closes page + browser after 10 idle minutes", async () => {
    vi.useFakeTimers();
    const port = fakePort();
    const rt = createBrowserRuntime(baseOpts(port));
    await rt.openPage();
    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_MS - 1);
    expect(rt.state()).toBe("open");
    await vi.advanceTimersByTimeAsync(2);
    expect(rt.state()).toBe("closed");
    expect(port.gates.browserClosed).toBe(1);
    expect(port.gates.pageClosed).toBe(1);
  });

  it("a tool call resets the idle window; a relaunch works after reaping", async () => {
    vi.useFakeTimers();
    const port = fakePort();
    const rt = createBrowserRuntime(baseOpts(port));
    await rt.openPage();
    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_MS - 1000);
    rt.touch();
    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_MS - 1000);
    expect(rt.state()).toBe("open");
    await vi.advanceTimersByTimeAsync(2000);
    expect(rt.state()).toBe("closed");
    await rt.openPage();
    expect(port.gates.launches).toHaveLength(2);
    expect(rt.state()).toBe("open");
  });
});

describe("process-exit hook", () => {
  it("kills the browser on exit and unregisters after close()", async () => {
    const port = fakePort();
    const hooks: (() => void)[] = [];
    let unregistered = 0;
    const rt = createBrowserRuntime({ ...baseOpts(port), registerExitHook: (fn) => { hooks.push(fn); return () => { unregistered++; }; } });
    await rt.openPage();
    expect(hooks).toHaveLength(1);
    hooks[0]!();
    expect(port.gates.killed).toBe(1);
    await rt.close();
    expect(unregistered).toBe(1);
    // idempotent close
    await rt.close();
    expect(port.gates.browserClosed).toBe(1);
  });
});

describe("executable resolution", () => {
  it("pure order: env override > installed > registry", () => {
    expect(resolveExecutablePath({ WUDAO_BROWSER_EXECUTABLE: "/env/chrome" }, "/installed/chrome"))
      .toEqual({ kind: "executable", path: "/env/chrome" });
    expect(resolveExecutablePath({}, "/installed/chrome")).toEqual({ kind: "executable", path: "/installed/chrome" });
    expect(resolveExecutablePath({}, null)).toEqual({ kind: "registry" });
    expect(resolveExecutablePath({ WUDAO_BROWSER_EXECUTABLE: "  " }, null)).toEqual({ kind: "registry" });
  });

  it("env override reaches the port launch even when an install exists", async () => {
    const port = fakePort();
    const rt = createBrowserRuntime({ ...baseOpts(port), env: () => ({ WUDAO_BROWSER_EXECUTABLE: "/env/chrome" }) });
    await rt.openPage();
    expect(port.gates.launches[0]?.executablePath).toBe("/env/chrome");
  });

  it("installed kernel reaches the port; the download lane never fires", async () => {
    const port = fakePort();
    const rt = createBrowserRuntime(baseOpts(port));
    await rt.openPage();
    expect(port.gates.launches[0]?.executablePath).toBe("/fake/installed-chromium");
  });

  it("registry lane downloads on first use, then launches the downloaded kernel", async () => {
    const port = fakePort();
    let dl = 0;
    const rt = createBrowserRuntime({
      ...baseOpts(port),
      resolveInstalled: async () => (dl === 0 ? null : "/dl/chrome"),
      download: async () => { dl++; return { executablePath: "/dl/chrome" }; },
    });
    await rt.openPage();
    expect(dl).toBe(1);
    expect(port.gates.launches[0]?.executablePath).toBe("/dl/chrome");
  });

  it("download failure falls back to a registry-env launch (user-managed kernels)", async () => {
    const port = fakePort();
    const rt = createBrowserRuntime({
      ...baseOpts(port),
      resolveInstalled: async () => null,
      download: async () => { throw new Error("net down"); },
    });
    await rt.openPage();
    expect(port.gates.launches[0]?.executablePath).toBeUndefined();
    expect(port.gates.launches[0]?.env?.["PLAYWRIGHT_BROWSERS_PATH"]).toBe(join(home, "browser"));
  });

  it("download failure + registry launch failure = honest error", async () => {
    const port = fakePort();
    port.gates.failLaunch = new Error("no kernel");
    const rt = createBrowserRuntime({
      ...baseOpts(port),
      resolveInstalled: async () => null,
      download: async () => { throw new Error("net down"); },
    });
    await expect(rt.openPage()).rejects.toThrow(/WUDAO_BROWSER_EXECUTABLE/);
    expect(rt.state()).toBe("closed");
  });
});

describe("SEA degrade (ω99-112: the desktop bundle ships playwright-core external)", () => {
  it("under node:sea the launch fails FAST with the honest posture (never a module stack, never a hang)", async () => {
    const port = fakePort();
    const rt = createBrowserRuntime({ ...baseOpts(port), seaProbe: () => true });
    await expect(rt.openPage()).rejects.toThrow(/desktop app bundle does not ship the browser driver/);
    expect(port.gates.launches).toHaveLength(0);
    expect(rt.state()).toBe("closed");
  });

  it("outside SEA the probe never interferes (the default probe reads node:sea)", async () => {
    const port = fakePort();
    const rt = createBrowserRuntime({ ...baseOpts(port), seaProbe: () => false });
    await rt.openPage();
    expect(rt.state()).toBe("open");
  });
});

describe("snapshot ref store", () => {
  it("saves, serves, and voids on navigation", async () => {
    const port = fakePort();
    const rt = createBrowserRuntime(baseOpts(port));
    await rt.openPage();
    expect(rt.currentSnapshot()).toBeNull();
    const refs = new Map([["e1", { selector: "[data-wudao-ref=\"e1\"]", desc: "a Link" }]]);
    rt.saveSnapshot("https://a.test/", refs);
    expect(rt.currentSnapshot()?.url).toBe("https://a.test/");
    rt.noteUrl("https://a.test/"); // same URL → snapshot survives
    expect(rt.currentSnapshot()).not.toBeNull();
    rt.noteUrl("https://b.test/"); // navigated → refs invalidated
    expect(rt.currentSnapshot()).toBeNull();
    rt.saveSnapshot("https://b.test/", refs);
    rt.invalidateSnapshot();
    expect(rt.currentSnapshot()).toBeNull();
  });

  it("close() clears the snapshot too", async () => {
    const port = fakePort();
    const rt = createBrowserRuntime(baseOpts(port));
    await rt.openPage();
    rt.saveSnapshot("https://a.test/", new Map());
    await rt.close();
    expect(rt.currentSnapshot()).toBeNull();
  });
});

describe("persistent profile dir (ω99-114)", () => {
  it("resolves the default profile dir under the kernel root and passes it to the port", async () => {
    const port = fakePort();
    const rt = createBrowserRuntime(baseOpts(port));
    await rt.openPage();
    expect(port.gates.launches[0]?.userDataDir).toBe(join(home, "browser", "profile"));
  });

  it("an explicit userDataDir overrides the default verbatim (E2E/temp lanes)", async () => {
    const port = fakePort();
    const rt = createBrowserRuntime({ ...baseOpts(port), userDataDir: "/tmp/wd-alt-profile" });
    await rt.openPage();
    expect(port.gates.launches[0]?.userDataDir).toBe("/tmp/wd-alt-profile");
  });

  it("creates the profile dir lazily — construction stays zero-IO, first launch mkdirs it", async () => {
    const port = fakePort();
    const rt = createBrowserRuntime(baseOpts(port));
    await expect(stat(join(home, "browser", "profile"))).rejects.toThrow();
    await rt.openPage();
    expect((await stat(join(home, "browser", "profile"))).isDirectory()).toBe(true);
  });

  it("a mkdir failure surfaces the honest launch error (never a raw stack)", async () => {
    const port = fakePort();
    const blocked = join(home, "blocked");
    await writeFile(blocked, "x"); // a FILE where the profile dir should go → recursive mkdir fails
    const rt = createBrowserRuntime({ ...baseOpts(port), userDataDir: join(blocked, "profile") });
    await expect(rt.openPage()).rejects.toThrow(/profile/);
    expect(rt.state()).toBe("closed");
    expect(port.gates.launches).toHaveLength(0); // the port was never asked to launch
  });
});
