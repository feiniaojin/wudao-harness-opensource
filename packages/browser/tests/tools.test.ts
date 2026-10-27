// ω99-112 — the six model tools (RED first): name order, risk flags
// (fail-closed, all open-world), input validation BEFORE any launch, the
// ref-addressed click/type routing onto the Fake page handle, navigation
// invalidation with the honest stale error, scroll directions, close
// idempotence. Everything rides the REAL runtime over a Fake port.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserToolsFor } from "../src/tools.js";
import { createBrowserRuntime } from "../src/runtime.js";
import { COLLECT_SCRIPT, refSelector } from "../src/snapshot.js";
import type { BrowserPort, PageHandle, Tool } from "./helpers.js";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "wd-browser-tools-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

interface Scripted {
  launches: number;
  goto: string[];
  clicks: string[];
  fills: { selector: string; text: string }[];
  presses: string[];
  evals: string[];
  closed: number;
  url: string;              // live fake URL (tests mutate)
  navAfterClick: boolean;   // fake page: does a click navigate?
  collected: unknown;       // evaluate(COLLECT_SCRIPT) payload
  title: string;
  body: string;
  gotoFailures: number;     // ω99-114: first N goto ATTEMPTS throw a network error
}

function makeRuntime(script: Scripted): Tool[] {
  const page: PageHandle = {
    url: async () => script.url,
    goto: async (u) => {
      script.goto.push(u); // every ATTEMPT is recorded, failures included
      if (script.gotoFailures > 0) { script.gotoFailures--; throw new Error("net::ERR_NAME_NOT_RESOLVED"); }
      script.url = u;
      return { finalUrl: u };
    },
    title: async () => script.title,
    evaluate: async (s: string) => { script.evals.push(s); return s === COLLECT_SCRIPT ? script.collected : null; },
    click: async (sel) => { script.clicks.push(sel); if (script.navAfterClick) script.url = script.url + "/next"; },
    fill: async (sel, text) => { script.fills.push({ selector: sel, text }); },
    text: async () => script.body,
    press: async (k) => { script.presses.push(k); },
    close: async () => { script.closed++; },
  };
  const port: BrowserPort = {
    async launch() { script.launches++; return { newPage: async () => page, close: async () => {} }; },
  };
  return browserToolsFor(createBrowserRuntime({
    port,
    homeDir: home,
    env: () => ({}),
    resolveInstalled: async () => "/fake/kernel",
    download: async () => { throw new Error("no download in tests"); },
    registerExitHook: () => () => {},
    // fake-timer choreographies (ω99-114 retry battery) need the launch
    // chain fully microtask-driven; the real default mkdir is covered by
    // the A-2 runtime battery (stat-asserted on disk).
    profileMkdir: async () => {},
  }));
}

const script = (over: Partial<Scripted> = {}): Scripted => ({
  launches: 0, goto: [], clicks: [], fills: [], presses: [], evals: [], closed: 0,
  url: "https://example.test/start", navAfterClick: false,
  title: "Example", body: "body text",
  gotoFailures: 0,
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

describe("the six tools", () => {
  it("register under fixed names, all open-world, non-deferred, with honest read/write flags", () => {
    const tools = makeRuntime(script());
    // ω99-138: browser_see joins the registration right after browser_snapshot
    // (the read-page pair) — expected-list evolution, the six 112 names and
    // their order/flags inside the group are otherwise unchanged.
    // ω99-139: browser_click_xy joins right after browser_click (the click
    // pair) — same expected-list evolution; every other name/flag unchanged.
    // ω99-140: browser_type_xy joins right after browser_type (the type pair)
    // — same expected-list evolution; every other name/flag unchanged.
    // ω99-141: browser_scroll_xy joins right after browser_scroll (the scroll
    // pair) — same expected-list evolution; every other name/flag unchanged.
    // ω99-142: browser_downloads joins right after browser_scroll_xy, before
    // browser_close (the download manifest closes the export flows) — same
    // expected-list evolution; its flags break the uniform loop HONESTLY:
    // reading a local manifest is the closed-world read-only pair
    // (isReadOnly:true + isOpenWorld:false — the sidecar's no-audit shape).
    expect(tools.map((t) => t.name)).toEqual([
      "browser_open", "browser_snapshot", "browser_see", "browser_click", "browser_click_xy", "browser_type", "browser_type_xy", "browser_scroll", "browser_scroll_xy", "browser_downloads", "browser_close",
    ]);
    for (const t of tools) {
      if (t.name !== "browser_downloads") expect(t.isOpenWorld?.({})).toBe(true); // the one closed-world exception, asserted below
      expect(t.shouldDefer?.()).toBe(false);
    }
    expect(byName(tools, "browser_downloads").isOpenWorld?.({})).toBe(false); // local manifest read — closed world
    expect(tools.map((t) => t.isReadOnly?.({}))).toEqual([false, true, true, false, false, false, false, true, true, true, true]);
  });
});

describe("browser_open", () => {
  it("launches once, navigates, returns title + final URL + a 500-char excerpt", async () => {
    const s = script({ body: "A".repeat(600) });
    const res = await byName(makeRuntime(s), "browser_open").execute({ url: "https://example.test/start" });
    expect(res.isError).toBeFalsy();
    expect(s.launches).toBe(1);
    expect(s.goto).toEqual(["https://example.test/start"]);
    expect(res.content).toContain("Example");
    expect(res.content).toContain("https://example.test/start");
    expect(res.content).toContain("A".repeat(500));
    expect(res.content).not.toContain("A".repeat(501));
  });

  it("rejects non-http(s) and malformed URLs BEFORE launching (fail-closed, no side effects)", async () => {
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "notaurl", "", 42]) {
      const s = script();
      const res = await byName(makeRuntime(s), "browser_open").execute({ url: bad });
      expect(res.isError).toBe(true);
      expect(s.launches).toBe(0);
    }
  });

  it("ω99-114: retries a transiently failed goto exactly once after a 2s backoff (fake timers) and succeeds", async () => {
    vi.useFakeTimers();
    try {
      const s = script({ gotoFailures: 1 });
      const tools = makeRuntime(s);
      const pending = byName(tools, "browser_open").execute({ url: "https://example.test/start" });
      await vi.advanceTimersByTimeAsync(2000); // release the backoff sleep
      const res = await pending;
      expect(res.isError).toBeFalsy();
      expect(s.goto).toHaveLength(2); // one failed attempt + the retry
      expect(res.content).toContain("Example");
    } finally { vi.useRealTimers(); }
  });

  it("ω99-114: two failed gotos → the honest error after exactly two attempts (no retry storm)", async () => {
    vi.useFakeTimers();
    try {
      const s = script({ gotoFailures: 2 });
      const tools = makeRuntime(s);
      const pending = byName(tools, "browser_open").execute({ url: "https://example.test/start" });
      await vi.advanceTimersByTimeAsync(2000);
      const res = await pending;
      expect(res.isError).toBe(true);
      expect(res.content).toContain("net::ERR_NAME_NOT_RESOLVED");
      expect(s.goto).toHaveLength(2); // retried once, never a third attempt
    } finally { vi.useRealTimers(); }
  });

  it("ω99-114: the success path sleeps zero — no backoff when the first goto lands", async () => {
    vi.useFakeTimers();
    try {
      const s = script();
      const tools = makeRuntime(s);
      // NO timer advance: a backoff here would hang this await until timeout
      const res = await byName(tools, "browser_open").execute({ url: "https://example.test/start" });
      expect(res.isError).toBeFalsy();
      expect(s.goto).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
});

describe("browser_snapshot", () => {
  it("answers honestly when no browser is open (names browser_open)", async () => {
    const res = await byName(makeRuntime(script()), "browser_snapshot").execute({});
    expect(res.isError).toBe(true);
    expect(res.content).toContain("browser_open");
  });

  it("collects via the in-page script, returns the formatted text, and arms the refs", async () => {
    const s = script();
    const tools = makeRuntime(s);
    await byName(tools, "browser_open").execute({ url: "https://example.test/start" });
    const snap = await byName(tools, "browser_snapshot").execute({});
    expect(snap.isError).toBeFalsy();
    expect(s.evals).toContain(COLLECT_SCRIPT);
    expect(snap.content).toContain("hello page");
    expect(snap.content).toContain("e1");
    // armed: a click on e1 now routes to the fake handle
    const click = await byName(tools, "browser_click").execute({ ref: "e1" });
    expect(click.isError).toBeFalsy();
    expect(s.clicks).toEqual([refSelector("e1")]);
  });
});

describe("browser_click", () => {
  it("errors honestly with no snapshot and with a stale snapshot", async () => {
    const tools = makeRuntime(script());
    await byName(tools, "browser_open").execute({ url: "https://example.test/start" });
    const noSnap = await byName(tools, "browser_click").execute({ ref: "e1" });
    expect(noSnap.isError).toBe(true);
    // ω99-144: 文案现为 "call browser_see (or browser_snapshot) first: both list every
    // clickable element with its ref"——see 同刷 ref 表（138 语义），断言随路由双钉。
    expect(noSnap.content).toContain("browser_see");
    expect(noSnap.content).toContain("browser_snapshot");
    // stale: the page navigated after the snapshot (runtime.noteUrl voids refs)
    const s = script({ collected: { url: "https://example.test/start", title: "T", text: "x", elements: [{ ref: "e1", tag: "a", text: "N", href: "/n" }] } });
    const t2 = makeRuntime(s);
    await byName(t2, "browser_open").execute({ url: "https://example.test/start" });
    await byName(t2, "browser_snapshot").execute({});
    s.url = "https://example.test/moved"; // navigation happened
    const stale = await byName(t2, "browser_click").execute({ ref: "e1" });
    expect(stale.isError).toBe(true);
    expect(stale.content).toMatch(/stale|expired|重新|browser_snapshot/i);
    // ω99-144: 文案现为 "Call browser_see or browser_snapshot again and use the fresh
    // refs"——see 同刷 ref 表（138 语义），stale 恢复路由也双钉。
    expect(stale.content).toContain("browser_see");
    expect(s.clicks).toEqual([]);
  });

  it("clicks by ref and reports the navigation (refs invalidated)", async () => {
    const s = script({ navAfterClick: true });
    const tools = makeRuntime(s);
    await byName(tools, "browser_open").execute({ url: "https://example.test/start" });
    await byName(tools, "browser_snapshot").execute({});
    const res = await byName(tools, "browser_click").execute({ ref: "e1" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("/next");
    // ω99-144: 文案现为 "all refs are invalidated; run browser_see or browser_snapshot
    // for fresh refs"——see 同刷 ref 表（138 语义），失效恢复路由双钉。
    expect(res.content).toContain("browser_see");
    expect(res.content).toContain("browser_snapshot");
  });

  it("rejects malformed refs before touching the page", async () => {
    const s = script();
    const tools = makeRuntime(s);
    await byName(tools, "browser_open").execute({ url: "https://example.test/start" });
    await byName(tools, "browser_snapshot").execute({});
    for (const bad of ["e0", "x1", "e", ""]) {
      const res = await byName(tools, "browser_click").execute({ ref: bad });
      expect(res.isError).toBe(true);
    }
    expect(s.clicks).toEqual([]);
  });
});

describe("browser_type", () => {
  it("fills by ref; submit:false types without Enter, submit:true presses Enter", async () => {
    const s = script();
    const tools = makeRuntime(s);
    await byName(tools, "browser_open").execute({ url: "https://example.test/start" });
    await byName(tools, "browser_snapshot").execute({});
    await byName(tools, "browser_type").execute({ ref: "e2", text: "hello" });
    expect(s.fills).toEqual([{ selector: refSelector("e2"), text: "hello" }]);
    expect(s.presses).toEqual([]);
    await byName(tools, "browser_type").execute({ ref: "e2", text: "again", submit: true });
    expect(s.fills).toHaveLength(2);
    expect(s.presses).toEqual(["Enter"]);
  });

  it("requires a non-empty string text (fail-closed)", async () => {
    const tools = makeRuntime(script());
    await byName(tools, "browser_open").execute({ url: "https://example.test/start" });
    await byName(tools, "browser_snapshot").execute({});
    const res = await byName(tools, "browser_type").execute({ ref: "e2", text: "" });
    expect(res.isError).toBe(true);
    const res2 = await byName(tools, "browser_type").execute({ ref: "e2" });
    expect(res2.isError).toBe(true);
  });

  it("ω99-114: refuses a KNOWN password field (fail-closed) and points at the visible window — nothing is typed", async () => {
    const s = script({ collected: { url: "https://example.test/start", title: "Example", text: "login", elements: [
      { ref: "e1", tag: "input", text: "", type: "password" },
      { ref: "e2", tag: "input", text: "", type: "text", placeholder: "user" },
      { ref: "e3", tag: "input", text: "", placeholder: "maybe" },
    ] } });
    const tools = makeRuntime(s);
    await byName(tools, "browser_open").execute({ url: "https://example.test/start" });
    await byName(tools, "browser_snapshot").execute({});
    const res = await byName(tools, "browser_type").execute({ ref: "e1", text: "hunter2" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("password");
    expect(res.content).toContain("visible browser window");
    expect(s.fills).toEqual([]); // the field never received a keystroke
    expect(s.presses).toEqual([]);
  });

  it("ω99-114: ordinary (type=text) and unknown-type fields still type normally — the gate only fires on KNOWN passwords", async () => {
    const s = script({ collected: { url: "https://example.test/start", title: "Example", text: "login", elements: [
      { ref: "e1", tag: "input", text: "", type: "password" },
      { ref: "e2", tag: "input", text: "", type: "text", placeholder: "user" },
      { ref: "e3", tag: "input", text: "", placeholder: "maybe" },
    ] } });
    const tools = makeRuntime(s);
    await byName(tools, "browser_open").execute({ url: "https://example.test/start" });
    await byName(tools, "browser_snapshot").execute({});
    await byName(tools, "browser_type").execute({ ref: "e2", text: "alice" });
    await byName(tools, "browser_type").execute({ ref: "e3", text: "bob" });
    expect(s.fills).toEqual([
      { selector: refSelector("e2"), text: "alice" },
      { selector: refSelector("e3"), text: "bob" },
    ]);
  });

  it("ω99-114: clicking a password field is NOT gated (focusing is innocent; only typing is refused)", async () => {
    const s = script({ collected: { url: "https://example.test/start", title: "Example", text: "login", elements: [
      { ref: "e1", tag: "input", text: "", type: "password" },
    ] } });
    const tools = makeRuntime(s);
    await byName(tools, "browser_open").execute({ url: "https://example.test/start" });
    await byName(tools, "browser_snapshot").execute({});
    const res = await byName(tools, "browser_click").execute({ ref: "e1" });
    expect(res.isError).toBeFalsy();
    expect(s.clicks).toEqual([refSelector("e1")]);
  });
});

describe("browser_scroll", () => {
  it("scrolls down and up via the page (and says so honestly when closed)", async () => {
    const s = script();
    const tools = makeRuntime(s);
    const closed = await byName(tools, "browser_scroll").execute({ direction: "down" });
    expect(closed.isError).toBe(true);
    expect(closed.content).toContain("browser_open");
    await byName(tools, "browser_open").execute({ url: "https://example.test/start" });
    await byName(tools, "browser_scroll").execute({ direction: "down" });
    await byName(tools, "browser_scroll").execute({ direction: "up" });
    const scrolls = s.evals.filter((e) => e.includes("scrollBy"));
    expect(scrolls).toHaveLength(2);
    expect(scrolls[0]).not.toContain("-");
    expect(scrolls[1]).toContain("-");
    const bad = await byName(tools, "browser_scroll").execute({ direction: "sideways" });
    expect(bad.isError).toBe(true);
  });
});

describe("browser_close", () => {
  it("is idempotent and safe on a closed browser", async () => {
    const s = script();
    const tools = makeRuntime(s);
    const a = await byName(tools, "browser_close").execute({});
    expect(a.isError).toBeFalsy();
    await byName(tools, "browser_open").execute({ url: "https://example.test/start" });
    const b = await byName(tools, "browser_close").execute({});
    expect(b.isError).toBeFalsy();
    expect(s.closed).toBe(1);
    const c = await byName(tools, "browser_close").execute({});
    expect(c.isError).toBeFalsy();
  });
});
