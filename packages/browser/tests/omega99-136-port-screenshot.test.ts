// ω99-136 — the vision capability on the port seam (RED first): PageHandle.
// screenshot() exists purely as a capability this arc — no tool calls it yet
// (browser_see is the next arc). Two honest proofs, zero real driver:
// 1. the DEFAULT adapter passes screenshot through to the playwright page as
//    a PNG request and returns its bytes UNTOUCHED — proven against a mocked
//    playwright-core (vi.mock intercepts the dynamic import inside launch(),
//    so the ~9MB driver never loads: the same 红线 4 port.test.ts guards);
// 2. the runtime hands the vision-capable page handle through openPage()
//    untouched, and a driver failure REJECTS honestly (never a silent empty
//    image — the err-channel mapping is the next arc's tools concern).
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlaywrightPort } from "../src/port.js";
import { createBrowserRuntime } from "../src/runtime.js";
import type { BrowserHandle, BrowserPort, PageHandle } from "../src/port.js";

// The fake playwright page: PwPage-shaped, only the screenshot/close/url
// paths are exercised here. If the REAL playwright-core ever loaded instead,
// launchPersistentContext would attempt an actual browser launch (slow,
// driver-shaped failure) — the instant PNG passthrough below proves it did not.
const fake = vi.hoisted(() => {
  const gates = { shots: [] as Array<{ type?: string }>, closed: 0 };
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const page = {
    url: () => "https://example.test/",
    goto: async () => ({}),
    title: async () => "T",
    evaluate: async () => ({}),
    click: async () => {},
    fill: async () => {},
    innerText: async () => "body",
    keyboard: { press: async () => {} },
    screenshot: async (opts?: { type?: string }) => { gates.shots.push(opts ?? {}); return png; },
    close: async () => { gates.closed++; },
  };
  return { gates, png, page };
});
vi.mock("playwright-core", () => ({
  chromium: {
    launchPersistentContext: async () => ({
      pages: () => [fake.page],
      newPage: async () => fake.page,
      // browser.close() lands on the CONTEXT — track it there
      close: async () => { fake.gates.closed++; },
    }),
  },
}));

describe("ω99-136 default adapter: screenshot passthrough (playwright-core mocked)", () => {
  it("asks playwright for a PNG and returns the driver's bytes untouched", async () => {
    const browser = await createPlaywrightPort().launch({ userDataDir: "/tmp/wd-omega99-136-profile" });
    const page = await browser.newPage();
    const bytes = await page.screenshot();
    expect(fake.gates.shots).toEqual([{ type: "png" }]);
    // passthrough means THE SAME object — no copy, no re-encode, no resize
    expect(bytes).toBe(fake.png);
    // PNG magic shape survives the seam (device-pixel space per the port docs)
    expect(Array.from(bytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await browser.close();
    expect(fake.gates.closed).toBe(1);
  });
});

describe("ω99-136 runtime seam: the vision-capable handle rides openPage() untouched", () => {
  let home: string;
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7, 7, 7]);

  async function runtimeWith(screenshot: PageHandle["screenshot"]): Promise<PageHandle> {
    const page: PageHandle = {
      url: async () => "https://example.test/",
      goto: async (u) => ({ finalUrl: u }),
      title: async () => "T",
      evaluate: async () => ({}),
      click: async () => {},
      fill: async () => {},
      text: async () => "body",
      press: async () => {},
      screenshot,
      close: async () => {},
    };
    const handle: BrowserHandle = { newPage: async () => page, close: async () => {} };
    const port: BrowserPort = { launch: async () => handle };
    const rt = createBrowserRuntime({
      port,
      homeDir: home,
      env: () => ({}),
      resolveInstalled: async () => "/fake/kernel",
      download: async () => { throw new Error("no download in tests"); },
      registerExitHook: () => () => {},
      profileMkdir: async () => {},
    });
    return rt.openPage();
  }

  it("openPage() hands out the Fake page whose screenshot bytes arrive as-is", async () => {
    home = await mkdtemp(join(tmpdir(), "wd-browser-136-"));
    try {
      const page = await runtimeWith(async () => png);
      expect(await page.screenshot()).toBe(png);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("a driver-side screenshot failure REJECTS honestly — never a silent empty image", async () => {
    home = await mkdtemp(join(tmpdir(), "wd-browser-136-"));
    try {
      const page = await runtimeWith(async () => { throw new Error("CDP capture failed"); });
      await expect(page.screenshot()).rejects.toThrow(/CDP capture failed/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
