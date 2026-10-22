// ω99-139 — the M-CU1 flagship E2E: a PURE CANVAS page (no DOM ref can hit —
// the collector sees zero clickable elements) with a login button drawn at a
// KNOWN rect; browser_click_xy must land the click through the miss layer
// (clickAt) and the page's own hit-test navigates to /login. Same lane
// discipline as e2e.real.test.ts: WUDAO_BROWSER_E2E=1 gates the real
// Chromium; every runtime uses a TEMP profile.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserRuntime } from "../src/runtime.js";
import { browserToolsFor } from "../src/tools.js";

// The canvas page: full-window canvas, button drawn at rect (600,80)-(760,140)
// — known coordinates, well inside any default viewport (1280×720). The click
// handler is addEventListener (NOT an onclick attribute), so the collector's
// selector never matches it: refs come back EMPTY, forcing the miss layer.
const CANVAS_PAGE = `<!doctype html><html><head><title>Canvas App</title><style>
canvas { position: fixed; left: 0; top: 0; display: block; }
</style></head><body>
<canvas id="c"></canvas>
<script>
  const c = document.getElementById('c');
  const fit = () => { c.width = window.innerWidth; c.height = window.innerHeight; draw(); };
  const draw = () => {
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = '#64748b'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#2563eb'; g.fillRect(600, 80, 160, 60); // the login button rect
    g.fillStyle = '#ffffff'; g.font = '20px sans-serif'; g.fillText('Log in', 640, 118);
  };
  fit(); window.addEventListener('resize', fit);
  c.addEventListener('click', (ev) => {
    const x = ev.clientX, y = ev.clientY;
    if (x >= 600 && x <= 760 && y >= 80 && y <= 140) location.href = '/login';
  });
</script>
</body></html>`;
const LOGIN_PAGE = `<!doctype html><html><head><title>Logged In</title></head><body><h1 id="in">canvas login ok</h1></body></html>`;

const e2e = process.env.WUDAO_BROWSER_E2E === "1";

describe("ω99-139 browser_click_xy E2E (real chromium, pure canvas page)", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    if (!e2e) return;
    server = createServer((req, res) => {
      const url = req.url ?? "/";
      if (url === "/canvas") { res.writeHead(200, { "content-type": "text/html" }); res.end(CANVAS_PAGE); }
      else if (url === "/login") { res.writeHead(200, { "content-type": "text/html" }); res.end(LOGIN_PAGE); }
      else { res.writeHead(404); res.end("no"); }
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => { if (e2e) await new Promise<void>((res) => server.close(() => res())); });

  it.skipIf(!e2e)("open → see (empty refs) → coordinate click lands on the drawn button → /login", async () => {
    const profile = await mkdtemp(join(tmpdir(), "wd-e2e-clickxy-"));
    const runtime = createBrowserRuntime({ headless: true, userDataDir: profile });
    try {
      const tools = browserToolsFor(runtime);
      const by = (n: string) => tools.find((t) => t.name === n)!;
      const open = await by("browser_open").execute({ url: `${base}/canvas` });
      expect(open.isError).toBeFalsy();
      // browser_see (no sink in this lane): the text table arms the refs — a
      // pure canvas page yields ZERO clickable elements.
      const see = await by("browser_see").execute({});
      expect(see.isError).toBeFalsy();
      expect(see.content).toContain("no clickable elements on this page");
      // A coordinate click on EMPTY canvas does nothing but click (no nav).
      const idle = await by("browser_click_xy").execute({ x: 300, y: 300 });
      expect(idle.isError).toBeFalsy();
      expect(idle.content).toContain("未命中");
      expect(idle.content).not.toContain("The page navigated");
      // The drawn button's center (680, 110): inside the known rect, outside
      // every bbox (there are none) → the miss layer clicks raw coordinates,
      // the page's own hit-test navigates to /login.
      const clicked = await by("browser_click_xy").execute({ x: 680, y: 110 });
      expect(clicked.isError).toBeFalsy();
      expect(clicked.content).toContain("/login");
      expect(clicked.content).toContain("已按坐标点击");
      const page = await runtime.openPage();
      expect(await page.url()).toContain("/login");
      const snap = await by("browser_snapshot").execute({});
      expect(snap.content).toContain("canvas login ok");
      await by("browser_close").execute({});
    } finally { await rm(profile, { recursive: true, force: true }); }
  }, 120_000);
});
