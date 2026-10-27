// ω99-140 — the M-CU2 flagship E2E: a full-width CONTENTEDITABLE page (the
// collector's selector matches none of it — refs come back EMPTY, forcing
// the miss layer); browser_type_xy must click the raw coordinates to land
// focus in the editable region, then keystroke the text into it. An
// empty-region click+type afterwards must not misfire into other elements.
// Same lane discipline as omega99-139-e2e-canvas.test.ts: WUDAO_BROWSER_E2E=1
// gates the real Chromium; every runtime uses a TEMP profile.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserRuntime } from "../src/runtime.js";
import { browserToolsFor } from "../src/tools.js";

// The editable page: #edit covers the top 70% of the viewport (a plain
// contenteditable div — NOT in the collector's selector list, so refs stay
// empty); #out (a span at 75%) displays what was "submitted". The strip
// between 70% and 75% is dead body space (the empty-region probe).
const EDIT_PAGE = `<!doctype html><html><head><title>Editable App</title><style>
html, body { margin: 0; height: 100%; }
#edit { position: fixed; left: 0; top: 0; width: 100%; height: 70%; font-size: 18px; padding: 8px; box-sizing: border-box; outline: 1px dashed #cbd5e1; }
#out { position: fixed; left: 8px; top: 75%; font-size: 14px; color: #475569; }
</style></head><body>
<div id="edit" contenteditable="true"></div>
<span id="out">(nothing submitted)</span>
</body></html>`;

const e2e = process.env.WUDAO_BROWSER_E2E === "1";

describe("ω99-140 browser_type_xy E2E (real chromium, contenteditable page)", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    if (!e2e) return;
    server = createServer((req, res) => {
      if ((req.url ?? "/") === "/edit") { res.writeHead(200, { "content-type": "text/html" }); res.end(EDIT_PAGE); }
      else { res.writeHead(404); res.end("no"); }
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => { if (e2e) await new Promise<void>((res) => server.close(() => res())); });

  it.skipIf(!e2e)("open → see (empty refs) → coordinate typing lands in the contenteditable; empty-region typing misfires nothing", async () => {
    const profile = await mkdtemp(join(tmpdir(), "wd-e2e-typexy-"));
    const runtime = createBrowserRuntime({ headless: true, userDataDir: profile });
    try {
      const tools = browserToolsFor(runtime);
      const by = (n: string) => tools.find((t) => t.name === n)!;
      const open = await by("browser_open").execute({ url: `${base}/edit` });
      expect(open.isError).toBeFalsy();
      // browser_see (no sink in this lane): the text table arms the refs — a
      // plain contenteditable div matches none of the collector selectors.
      const see = await by("browser_see").execute({});
      expect(see.isError).toBeFalsy();
      expect(see.content).toContain("no clickable elements on this page");
      // (100, 100): inside #edit (top 70% of the 720px viewport), outside
      // every bbox (there are none) → the miss layer clicks raw coordinates
      // to focus, then keystrokes the text into the editable region.
      const typed = await by("browser_type_xy").execute({ x: 100, y: 100, text: "你好 world" });
      expect(typed.isError).toBeFalsy();
      expect(typed.content).toContain("未命中");
      expect(typed.content).toContain("字段类型未知");
      const page = await runtime.openPage();
      const edit = await page.evaluate<string>("document.getElementById('edit').innerText");
      expect(edit).toContain("你好 world"); // the text really landed
      // Empty-region probe: (100, 530) is the dead strip between #edit's
      // bottom (504) and #out's top (540) — clicking there and typing must
      // NOT misfire into the editable region or the span.
      const stray = await by("browser_type_xy").execute({ x: 100, y: 530, text: "STRAY" });
      expect(stray.isError).toBeFalsy();
      const editAfter = await page.evaluate<string>("document.getElementById('edit').innerText");
      const outAfter = await page.evaluate<string>("document.getElementById('out').innerText");
      expect(editAfter).toBe("你好 world");           // the editable region untouched
      expect(outAfter).toBe("(nothing submitted)");   // the span untouched
      await by("browser_close").execute({});
    } finally { await rm(profile, { recursive: true, force: true }); }
  }, 120_000);
});
