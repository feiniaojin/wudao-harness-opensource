// ω99-144 — the ref chain's degradation copy routes browser_see alongside
// browser_snapshot: see refreshes the SAME ref table (138 semantics) and
// additionally attaches the page image, so snapshot-only advice loops a
// model forever on a canvas page (a fresh snapshot stays sparse — the real
// way out is see's image + browser_click_xy). This battery pins all eight
// routed messages (malformed / no-snapshot / ref-not-in-table with the
// canvas escape / stale / navigationNote / click-failure / type-failure /
// scroll ok-note). Pure copy: zero behavior; the Fake-port harness from
// tools.test.ts rides the REAL runtime.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserToolsFor } from "../src/tools.js";
import { createBrowserRuntime } from "../src/runtime.js";
import { COLLECT_SCRIPT } from "../src/snapshot.js";
import type { BrowserPort, PageHandle, Tool } from "./helpers.js";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "wd-browser-refblind-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

interface Scripted {
  url: string;
  navAfterClick: boolean;
  clickFails: boolean;
  fillFails: boolean;
  collected: unknown;
}

const makeTools = (s: Scripted): Tool[] => {
  const page: PageHandle = {
    url: async () => s.url,
    goto: async (u) => { s.url = u; return { finalUrl: u }; },
    title: async () => "Example",
    evaluate: async (script: string) => (script === COLLECT_SCRIPT ? s.collected : null),
    click: async () => { if (s.clickFails) throw new Error("node detached"); if (s.navAfterClick) s.url = s.url + "/next"; },
    fill: async () => { if (s.fillFails) throw new Error("node detached"); },
    text: async () => "body",
    press: async () => {},
    close: async () => {},
  };
  const port: BrowserPort = { async launch() { return { newPage: async () => page, close: async () => {} }; } };
  return browserToolsFor(createBrowserRuntime({
    port, homeDir: home, env: () => ({}),
    resolveInstalled: async () => "/fake/kernel",
    download: async () => { throw new Error("no download in tests"); },
    registerExitHook: () => () => {},
    profileMkdir: async () => {},
  }));
};

const script = (over: Partial<Scripted> = {}): Scripted => ({
  url: "https://example.test/start",
  navAfterClick: false,
  clickFails: false,
  fillFails: false,
  collected: { url: "https://example.test/start", title: "Example", text: "hello page", elements: [
    { ref: "e1", tag: "a", text: "Next", href: "/next" },
    { ref: "e2", tag: "input", text: "", type: "text", placeholder: "q" },
  ] },
  ...over,
});
const byName = (tools: readonly Tool[], n: string): Tool => {
  const t = tools.find((x) => x.name === n);
  if (!t) throw new Error(`missing ${n}`);
  return t;
};
const openedAndSnapped = async (tools: readonly Tool[], s: Scripted): Promise<void> => {
  await byName(tools, "browser_open").execute({ url: s.url });
  await byName(tools, "browser_snapshot").execute({});
};

describe("ω99-144 ref-chain degradation copy routes browser_see", () => {
  it("malformed ref: the shape hint names both table sources", async () => {
    const s = script();
    const tools = makeTools(s);
    await openedAndSnapped(tools, s);
    const res = await byName(tools, "browser_click").execute({ ref: "x1" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("from browser_snapshot or browser_see");
  });

  it("no snapshot yet: see is named first and the image bonus is said — canvas escape stays at the loop site only", async () => {
    const s = script();
    const tools = makeTools(s);
    await byName(tools, "browser_open").execute({ url: s.url });
    const res = await byName(tools, "browser_click").execute({ ref: "e1" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("call browser_see (or browser_snapshot) first");
    expect(res.content).toContain("browser_see also attaches the page image");
    expect(res.content).not.toContain("browser_click_xy");
  });

  it("ref not in the table: fresh refs AND the canvas escape (browser_click_xy) — no more blind loop", async () => {
    const s = script();
    const tools = makeTools(s);
    await openedAndSnapped(tools, s);
    const res = await byName(tools, "browser_click").execute({ ref: "e9" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("call browser_see or browser_snapshot again for fresh refs");
    expect(res.content).toContain("browser_click_xy");
    expect(res.content).toContain("canvas/graphics page");
  });

  it("stale snapshot: the refresh advice pairs see with snapshot (no canvas escape here)", async () => {
    const s = script();
    const tools = makeTools(s);
    await openedAndSnapped(tools, s);
    s.url = "https://example.test/moved"; // navigated after the snapshot
    const res = await byName(tools, "browser_click").execute({ ref: "e1" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Call browser_see or browser_snapshot again");
    expect(res.content).not.toContain("browser_click_xy");
  });

  it("navigationNote: invalidation advice pairs see with snapshot", async () => {
    const s = script({ navAfterClick: true });
    const tools = makeTools(s);
    await openedAndSnapped(tools, s);
    const res = await byName(tools, "browser_click").execute({ ref: "e1" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("all refs are invalidated; run browser_see or browser_snapshot for fresh refs");
  });

  it("click by-ref failure: the recovery advice pairs see with snapshot", async () => {
    const s = script({ clickFails: true });
    const tools = makeTools(s);
    await openedAndSnapped(tools, s);
    const res = await byName(tools, "browser_click").execute({ ref: "e1" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("If the page changed, run browser_see or browser_snapshot for fresh refs");
  });

  it("type by-ref failure: the recovery advice pairs see with snapshot", async () => {
    const s = script({ fillFails: true });
    const tools = makeTools(s);
    await openedAndSnapped(tools, s);
    const res = await byName(tools, "browser_type").execute({ ref: "e2", text: "hi" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("If the page changed, run browser_see or browser_snapshot for fresh refs");
  });

  it("scroll ok-note: newly-visible-element advice names see first", async () => {
    const s = script();
    const tools = makeTools(s);
    await byName(tools, "browser_open").execute({ url: s.url });
    const res = await byName(tools, "browser_scroll").execute({ direction: "down" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("browser_see (or browser_snapshot) reveals newly visible elements");
  });
});
