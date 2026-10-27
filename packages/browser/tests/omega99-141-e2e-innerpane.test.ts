// ω99-141 — the arc's existence proof, live: an EMBEDDED scrollable pane
// (overflow-y:auto, 300px tall over 3000px of content) inside an UNSCROLLABLE
// page (body overflow:hidden — window.scrollY can never move). browser_scroll
// (window.scrollBy) is structurally blind to this pane; browser_scroll_xy
// must dispatch the wheel AT the pane's coordinates and the pane — not the
// page — must scroll: pane.scrollTop > 0 while window.scrollY === 0. The
// pane is a plain div, outside the collector's selector list → refs empty
// (and irrelevant: scrolling has no hit layer). Same lane discipline as
// omega99-139/140 E2E: WUDAO_BROWSER_E2E=1 gates the real Chromium (kernel
// via WUDAO_BROWSER_EXECUTABLE); every runtime uses a TEMP profile.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserRuntime } from "../src/runtime.js";
import { browserToolsFor } from "../src/tools.js";

// The embedded-pane page: #pane sits at (40,40) sized 400×300 with
// overflow-y:auto over a 3000px-tall inner div — an online design tool's
// layers-sidebar shape. html/body are height:100% overflow:hidden: the PAGE
// cannot scroll at all, so any scroll observed must be the pane's own.
const PANE_PAGE = `<!doctype html><html><head><title>Pane App</title><style>
html, body { margin: 0; height: 100%; overflow: hidden; }
#pane { position: fixed; left: 40px; top: 40px; width: 400px; height: 300px; overflow-y: auto; border: 1px dashed #cbd5e1; font-size: 14px; }
#tall { height: 3000px; padding: 8px; box-sizing: border-box; }
</style></head><body>
<div id="pane"><div id="tall">line<br>line<br>line<br>…3000px of pane content…</div></div>
</body></html>`;

const e2e = process.env.WUDAO_BROWSER_E2E === "1";

describe("ω99-141 browser_scroll_xy E2E (real chromium, embedded inner pane)", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    if (!e2e) return;
    server = createServer((req, res) => {
      if ((req.url ?? "/") === "/pane") { res.writeHead(200, { "content-type": "text/html" }); res.end(PANE_PAGE); }
      else { res.writeHead(404); res.end("no"); }
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => { if (e2e) await new Promise<void>((res) => server.close(() => res())); });

  it.skipIf(!e2e)("open → see (empty refs) → coordinate scroll reaches the INNER pane; the page itself never moves", async () => {
    const profile = await mkdtemp(join(tmpdir(), "wd-e2e-scrollxy-"));
    const runtime = createBrowserRuntime({ headless: true, userDataDir: profile });
    try {
      const tools = browserToolsFor(runtime);
      const by = (n: string) => tools.find((t) => t.name === n)!;
      const open = await by("browser_open").execute({ url: `${base}/pane` });
      expect(open.isError).toBeFalsy();
      // browser_see (no sink in this lane): arms the snapshot — a plain div
      // matches none of the collector selectors, refs come back EMPTY.
      const see = await by("browser_see").execute({});
      expect(see.isError).toBeFalsy();
      expect(see.content).toContain("no clickable elements on this page");
      // (100, 100): inside #pane (40..440 × 40..340) — the wheel goes there.
      // Page-level scroll CANNOT reach this pane; this call is the proof.
      const scrolled = await by("browser_scroll_xy").execute({ x: 100, y: 100, direction: "down" });
      expect(scrolled.isError).toBeFalsy();
      expect(scrolled.content).toContain("坐标之下");
      const page = await runtime.openPage();
      // The wheel is applied asynchronously by the compositor — poll briefly
      // for scrollTop > 0 instead of racing a single evaluate.
      let paneTop = -1;
      for (let i = 0; i < 40 && paneTop <= 0; i++) {
        paneTop = await page.evaluate<number>("document.getElementById('pane').scrollTop");
        if (paneTop <= 0) await new Promise((r) => setTimeout(r, 50));
      }
      expect(paneTop).toBeGreaterThan(0); // the pane really scrolled
      const pageY = await page.evaluate<number>("window.scrollY");
      expect(pageY).toBe(0); // the page body never moved (it cannot — and didn't)
      await by("browser_close").execute({});
    } finally { await rm(profile, { recursive: true, force: true }); }
  }, 120_000);
});
