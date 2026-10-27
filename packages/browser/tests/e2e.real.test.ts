// ω99-112 — the REAL end-to-end lane (opt-in): WUDAO_BROWSER_E2E=1 launches
// a true Chromium over the default playwright port and drives the whole
// chain open → snapshot → type/submit → click → extract against a LOCAL
// http server (deterministic content, no external network). Default: skip.
// Kernel precondition: PLAYWRIGHT_BROWSERS_PATH=~/.wudao-desktop/browser
// pnpm -C packages/browser exec playwright-core install chromium (or let
// the first browser_open auto-download it).
// ω99-114: every runtime here launches with a TEMP userDataDir (the
// persistent-profile lane is the point — see the profile test below — but
// it must never touch this machine's real ~/.wudao-desktop/browser/profile
// or any daily-browser profile).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserRuntime } from "../src/runtime.js";
import { browserToolsFor } from "../src/tools.js";

const PAGE_A = `<!doctype html><html><head><title>Alpha Page</title></head><body>
<h1>Alpha</h1>
<p id="msg">hello e2e</p>
<form action="/result" method="get"><input name="q" placeholder="type here"><button type="submit">Go</button></form>
<a id="next" href="/b">Next page</a>
</body></html>`;
const PAGE_B = `<!doctype html><html><head><title>Beta Page</title></head><body><h1 id="beta">Beta reached</h1></body></html>`;
// ω99-114 D: a click that fires alert() — with no dialog listener,
// playwright auto-dismisses; the click must not hang and the page must
// stay usable afterwards.
const PAGE_DIALOG = `<!doctype html><html><head><title>Dialog Page</title></head><body>
<h1>Dialog discipline</h1>
<button id="alerter" onclick="alert('blocked?')">Fire alert</button>
<p id="after">page still usable</p>
</body></html>`;
const resultPage = (q: string) => `<!doctype html><html><head><title>Result</title></head><body><h1 id="r">result:${q}</h1></body></html>`;

const e2e = process.env.WUDAO_BROWSER_E2E === "1";

describe("browser E2E (real chromium)", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    if (!e2e) return;
    server = createServer((req, res) => {
      const url = req.url ?? "/";
      if (url === "/a" || url === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE_A); }
      else if (url === "/b") { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE_B); }
      else if (url === "/dialog") { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE_DIALOG); }
      else if (url.startsWith("/result")) {
        const q = new URL(url, "http://x").searchParams.get("q") ?? "";
        res.writeHead(200, { "content-type": "text/html" }); res.end(resultPage(q));
      } else { res.writeHead(404); res.end("no"); }
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => { if (e2e) await new Promise<void>((res) => server.close(() => res())); });

  it.skipIf(!e2e)("open → snapshot → type+submit → extract → click → stale-honesty → close (full chain)", async () => {
    const profile = await mkdtemp(join(tmpdir(), "wd-e2e-chain-"));
    const runtime = createBrowserRuntime({ headless: true, userDataDir: profile });
    try {
    const tools = browserToolsFor(runtime);
    const by = (n: string) => tools.find((t) => t.name === n)!;
    // 1. open
    const open = await by("browser_open").execute({ url: `${base}/a` });
    expect(open.isError).toBeFalsy();
    expect(open.content).toContain("Alpha Page");
    // 2. snapshot lists refs
    const snap = await by("browser_snapshot").execute({});
    expect(snap.isError).toBeFalsy();
    expect(snap.content).toContain("hello e2e");
    expect(snap.content).toMatch(/e\d+ \[input/);
    expect(snap.content).toMatch(/e\d+ \[button.*Go/);
    const inputRef = /- (e\d+) \[input/.exec(snap.content)?.[1];
    const buttonRef = /- (e\d+) \[button.*Go/.exec(snap.content)?.[1];
    const linkRef = /- (e\d+) \[a.*\/b/.exec(snap.content)?.[1];
    expect(inputRef).toBeDefined();
    expect(buttonRef).toBeDefined();
    expect(linkRef).toBeDefined();
    // 3. type with submit → form lands on /result?q=e2e-query
    const typed = await by("browser_type").execute({ ref: inputRef!, text: "e2e-query", submit: true });
    expect(typed.isError).toBeFalsy();
    expect(typed.content).toContain("/result");
    // 4. snapshot the result and extract the server-shaped text
    const snap2 = await by("browser_snapshot").execute({});
    expect(snap2.content).toContain("result:e2e-query");
    // 5. stale honesty: a ref from an older snapshot must never click
    const stale = await by("browser_click").execute({ ref: linkRef! });
    expect(stale.isError).toBe(true);
    expect(stale.content).toMatch(/not in the current snapshot|snapshot is stale|browser_snapshot/i);
    // 6. navigate back, fresh snapshot, click the link for real
    await by("browser_open").execute({ url: `${base}/a` });
    const snap3 = await by("browser_snapshot").execute({});
    const link3 = /- (e\d+) \[a.*\/b/.exec(snap3.content)?.[1];
    const clicked = await by("browser_click").execute({ ref: link3! });
    expect(clicked.isError).toBeFalsy();
    expect(clicked.content).toContain("/b");
    const snap4 = await by("browser_snapshot").execute({});
    expect(snap4.content).toContain("Beta reached");
    // 7. close
    const closed = await by("browser_close").execute({});
    expect(closed.isError).toBeFalsy();
    expect(runtime.state()).toBe("closed");
    } finally { await rm(profile, { recursive: true, force: true }); }
  }, 120_000);

  it.skipIf(!e2e)("ω99-114 D: dialog discipline — a click firing alert() auto-dismisses, never hangs, page stays usable", async () => {
    const profile = await mkdtemp(join(tmpdir(), "wd-e2e-dialog-"));
    const runtime = createBrowserRuntime({ headless: true, userDataDir: profile });
    try {
      const tools = browserToolsFor(runtime);
      const by = (n: string) => tools.find((t) => t.name === n)!;
      const open = await by("browser_open").execute({ url: `${base}/dialog` });
      expect(open.isError).toBeFalsy();
      expect(open.content).toContain("Dialog Page");
      const snap = await by("browser_snapshot").execute({});
      expect(snap.isError).toBeFalsy();
      const alertRef = /- (e\d+) \[button.*Fire alert/.exec(snap.content)?.[1];
      expect(alertRef).toBeDefined();
      // no dialog listener is registered anywhere in the stack: playwright's
      // auto-dismiss must save the click; if it did not, this await hangs.
      const clicked = await by("browser_click").execute({ ref: alertRef! });
      expect(clicked.isError).toBeFalsy();
      // the page is still alive and addressable afterwards
      const snap2 = await by("browser_snapshot").execute({});
      expect(snap2.isError).toBeFalsy();
      expect(snap2.content).toContain("page still usable");
      await by("browser_close").execute({});
    } finally { await rm(profile, { recursive: true, force: true }); }
  }, 120_000);

  it.skipIf(!e2e)("ω99-114 E: persistent profile — storage written in one runtime SURVIVES into a new process (login-state proof)", async () => {
    const profile = await mkdtemp(join(tmpdir(), "wd-e2e-profile-"));
    const key = "wudao-e2e-profile-marker-114";
    try {
      // instance 1: open, write a login-state marker, close the process
      const rt1 = createBrowserRuntime({ headless: true, userDataDir: profile });
      const page1 = await rt1.openPage();
      await page1.goto(`${base}/a`);
      await page1.evaluate(`localStorage.setItem(${JSON.stringify(key)}, "persist-ok-114")`);
      expect(rt1.state()).toBe("open");
      await rt1.close();
      expect(rt1.state()).toBe("closed");
      // instance 2: a BRAND-NEW runtime (fresh context, same userDataDir) —
      // if the profile were ephemeral this read would come back null.
      const rt2 = createBrowserRuntime({ headless: true, userDataDir: profile });
      const page2 = await rt2.openPage();
      await page2.goto(`${base}/a`);
      const marker = await page2.evaluate<string>(`localStorage.getItem(${JSON.stringify(key)})`);
      await rt2.close();
      expect(marker).toBe("persist-ok-114");
    } finally { await rm(profile, { recursive: true, force: true }); }
  }, 120_000);
});
