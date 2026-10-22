// ω99-138 — browser_see (the vision face): the screenshot rides the injected
// sink into result.images as an ImageBlock, the text half is the SAME
// ref/bbox table browser_snapshot produces plus the fixed attach note, the
// capture asks for scale:"css" (CSS pixels — one grid with the bboxes), and
// every degradation is honest: no sink → text table + the fixed note; sink
// decline (undefined) → text table + the modality note; sink throw → err
// channel, never a silent empty result. Registration: SEVEN tools, the six
// 112 tools untouched (order + risk flags).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageBlock, Tool } from "@wudao/core";
import { browserToolsFor, type BrowserImageSink } from "../src/tools.js";
import { createBrowserRuntime } from "../src/runtime.js";
import { COLLECT_SCRIPT } from "../src/snapshot.js";
import type { BrowserPort, PageHandle } from "./helpers.js";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "wd-browser-see-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

/** A minimal IHDR-shaped PNG (pngSize reads offsets 16/23 big-endian). */
const pngWith = (w: number, h: number): Uint8Array => {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  return b;
};

interface Scripted {
  url: string;
  collected: unknown;
  shots: ({ scale?: string } | undefined)[];
}

/** The fake page records screenshot opts (the css-scale request shape). */
const makeTools = (scripted: Scripted, sink?: BrowserImageSink): Tool[] => {
  const page: PageHandle = {
    url: async () => scripted.url,
    goto: async (u) => { scripted.url = u; return { finalUrl: u }; },
    title: async () => "Example",
    evaluate: async (s: string) => (s === COLLECT_SCRIPT ? scripted.collected : null),
    click: async () => {},
    fill: async () => {},
    text: async () => "body",
    press: async () => {},
    screenshot: async (opts?: { scale?: "css" | "device" }) => { scripted.shots.push(opts); return pngWith(1280, 800); },
    close: async () => {},
  };
  const port: BrowserPort = { async launch() { return { newPage: async () => page, close: async () => {} }; } };
  return browserToolsFor(createBrowserRuntime({
    port, homeDir: home, env: () => ({}),
    resolveInstalled: async () => "/fake/kernel",
    download: async () => { throw new Error("no download in tests"); },
    registerExitHook: () => () => {},
    profileMkdir: async () => {},
  }), sink);
};

const script = (over: Partial<Scripted> = {}): Scripted => ({
  url: "https://example.test/start",
  collected: {
    url: "https://example.test/start", title: "Example", text: "hello page",
    elements: [
      { ref: "e1", tag: "a", text: "Next", href: "/next", bbox: { x: 10, y: 20, width: 100, height: 30 } },
      { ref: "e2", tag: "input", text: "", type: "text", placeholder: "q", bbox: { x: 10, y: 60, width: 200, height: 24 } },
    ],
  },
  shots: [],
  ...over,
});
const byName = (tools: readonly Tool[], n: string): Tool => {
  const t = tools.find((x) => x.name === n);
  if (!t) throw new Error(`missing ${n}`);
  return t;
};
const opened = async (tools: readonly Tool[]): Promise<void> => {
  const res = await byName(tools, "browser_open").execute({ url: "https://example.test/start" });
  expect(res.isError).toBeFalsy();
};
const block: ImageBlock = {
  kind: "image",
  ref: { kind: "image", attachmentId: "01234567-89ab-cdef-0123-456789abcdef", mediaType: "image/png", byteLength: 24 },
};

describe("ω99-138 browser_see", () => {
  it("registers ELEVEN tools; the six 112 tools keep their order and risk flags", () => {
    const tools = makeTools(script());
    // ω99-139: browser_click_xy joined right after browser_click (the click
    // pair) — expected-list evolution; every other name/flag unchanged.
    // ω99-140: browser_type_xy joined right after browser_type (the type
    // pair) — same expected-list evolution; every other name/flag unchanged.
    // ω99-141: browser_scroll_xy joined right after browser_scroll (the
    // scroll pair) — same expected-list evolution; every other name/flag
    // unchanged.
    // ω99-142: browser_downloads joined right after browser_scroll_xy, before
    // browser_close (the download manifest) — same expected-list evolution;
    // it is the one CLOSED-WORLD tool (local manifest read — the sidecar's
    // no-audit pair), so the open-world loop carves its honest exception.
    expect(tools.map((t) => t.name)).toEqual([
      "browser_open", "browser_snapshot", "browser_see", "browser_click", "browser_click_xy", "browser_type", "browser_type_xy", "browser_scroll", "browser_scroll_xy", "browser_downloads", "browser_close",
    ]);
    // read-only flags in the same order: see sits after snapshot, read-only like it.
    expect(tools.map((t) => t.isReadOnly?.({}))).toEqual([false, true, true, false, false, false, false, true, true, true, true]);
    for (const t of tools) {
      if (t.name !== "browser_downloads") expect(t.isOpenWorld?.({})).toBe(true); // the one closed-world exception, asserted below
      expect(t.shouldDefer?.()).toBe(false);
    }
    expect(byName(tools, "browser_downloads").isOpenWorld?.({})).toBe(false); // local manifest read — closed world
  });

  it("not open → the shared NOT_OPEN error; zero screenshots taken", async () => {
    const s = script();
    const res = await byName(makeTools(s), "browser_see").execute({});
    expect(res.isError).toBe(true);
    expect(res.content).toContain("browser_open");
    expect(s.shots).toHaveLength(0);
  });

  it("attaches the sink's block, returns the ref/bbox table + the fixed note, asks scale css", async () => {
    const s = script();
    const calls: { w: number; h: number }[] = [];
    const sink: BrowserImageSink = async (png, meta) => {
      expect(png.length).toBe(24);
      calls.push({ w: meta.widthPx, h: meta.heightPx });
      return block;
    };
    const tools = makeTools(s, sink);
    await opened(tools);
    const res = await byName(tools, "browser_see").execute({});
    expect(res.isError).toBeFalsy();
    expect(res.images).toEqual([block]);
    expect(res.content).toContain("e1");
    expect(res.content).toContain("@[10,20,100,30]"); // the bbox table (CSS px)
    expect(res.content).toContain("截图已附（CSS 像素空间，坐标即表中所列）");
    // the capture request shape: CSS pixels, one grid with the bboxes.
    expect(s.shots).toEqual([{ scale: "css" }]);
    expect(calls).toEqual([{ w: 1280, h: 800 }]); // IHDR dims handed to the sink
  });

  it("no sink → honest degradation: table + the no-channel note, NO images", async () => {
    const tools = makeTools(script());
    await opened(tools);
    const res = await byName(tools, "browser_see").execute({});
    expect(res.isError).toBeFalsy();
    expect(res.images).toBeUndefined();
    expect(res.content).toContain("e1");
    expect(res.content).toContain("视觉通道未接入");
  });

  it("sink declines (undefined) → table + the modality note, NO images", async () => {
    const tools = makeTools(script(), async () => undefined);
    await opened(tools);
    const res = await byName(tools, "browser_see").execute({});
    expect(res.isError).toBeFalsy();
    expect(res.images).toBeUndefined();
    expect(res.content).toContain("当前主模型不接受图像输入");
  });

  it("sink throws → the err channel, never a silent empty result", async () => {
    const tools = makeTools(script(), async () => { throw new Error("disk full"); });
    await opened(tools);
    const res = await byName(tools, "browser_see").execute({});
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Attaching the screenshot failed");
    expect(res.content).toContain("disk full");
    expect(res.images).toBeUndefined();
  });

  it("arms refs exactly like browser_snapshot (the table's refs click)", async () => {
    const s = script();
    const tools = makeTools(s, async () => block);
    await opened(tools);
    await byName(tools, "browser_see").execute({});
    // fresh refs armed by the see's own collect pass — a click routes by ref.
    const click = await byName(tools, "browser_click").execute({ ref: "e1" });
    expect(click.isError).toBeFalsy();
  });
});
