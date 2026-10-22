// ω99-142 — the arc's existence proof, live: a page with a real DOWNLOAD
// link (Content-Disposition: attachment) — the exact "export button" shape
// of M-CU2's 「导出 PNG」 flow. Before this arc the download vanished (the
// browser package had ZERO download event surface; playwright drops an
// unsaved download on close). Now the adapter intercepts the context-level
// event, saves under a timestamp-prefixed safeSegment name, and
// browser_downloads lists it: open → see (the link gets a ref) → click(ref)
// → poll browser_downloads until hello.txt appears → assert bytes/path and
// read the file back byte-for-byte. Lane discipline: WUDAO_BROWSER_E2E=1
// gates the real Chromium AND WUDAO_BROWSER_EXECUTABLE must point at it —
// the runtime below uses a TEMP homeDir (hermetic page-downloads), so the
// kernel cannot come from the temp home's installed probe.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserRuntime } from "../src/runtime.js";
import { browserToolsFor } from "../src/tools.js";

// Fixed body bytes — the E2E asserts the landed file is byte-identical.
const BODY = "hello wudao download lane 142\n";

// The export page: ONE anchor into the attachment endpoint (an <a> matches
// the collector → browser_see arms a ref for it).
const PAGE = `<!doctype html><html><head><title>Export App</title></head><body>
<h1>export demo</h1>
<p><a href="/file">Download</a></p>
</body></html>`;

const e2e = process.env.WUDAO_BROWSER_E2E === "1" && (process.env.WUDAO_BROWSER_EXECUTABLE ?? "").trim() !== "";

describe("ω99-142 downloads E2E (real chromium, attachment link)", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    if (!e2e) return;
    server = createServer((req, res) => {
      const url = req.url ?? "/";
      if (url === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE); }
      else if (url === "/file") {
        res.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="hello.txt"' });
        res.end(BODY);
      } else { res.writeHead(404); res.end("no"); }
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => { if (e2e) await new Promise<void>((res) => server.close(() => res())); });

  it.skipIf(!e2e)("open → see → click the link → the download LANDS and browser_downloads lists it (bytes + path, file real)", async () => {
    const home = await mkdtemp(join(tmpdir(), "wd-e2e-downloads-home-"));
    const profile = await mkdtemp(join(tmpdir(), "wd-e2e-downloads-profile-"));
    const runtime = createBrowserRuntime({ headless: true, homeDir: home, userDataDir: profile });
    try {
      const tools = browserToolsFor(runtime);
      const by = (n: string) => tools.find((t) => t.name === n)!;
      const open = await by("browser_open").execute({ url: `${base}/` });
      expect(open.isError).toBeFalsy();
      const see = await by("browser_see").execute({});
      expect(see.isError).toBeFalsy();
      // The anchor is the page's only clickable element — take its ref from
      // the table line ("- e1 [a] Download → /file").
      const ref = see.content.match(/^- (e\d+) \[a\].*Download/m)?.[1];
      expect(ref).toBeDefined();
      const clicked = await by("browser_click").execute({ ref: ref as string });
      expect(clicked.isError).toBeFalsy();
      // The save is asynchronous (event → saveAs → stat): poll the manifest
      // until hello.txt COMPLETED — an in-flight save never appears (honest
      // numbers), 50ms×40 against the race (141's precedent).
      let listing = "";
      for (let i = 0; i < 40; i++) {
        const res = await by("browser_downloads").execute({});
        expect(res.isError).toBeFalsy();
        if (res.content.includes("hello.txt")) { listing = res.content; break; }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(listing).not.toBe(""); // the file landed within the window
      const m = listing.match(/\((\d+) B\) → (\S*-hello\.txt)/);
      expect(m).toBeDefined();
      expect(Number(m?.[1])).toBe(Buffer.byteLength(BODY)); // bytes = the exact body length
      const path = m?.[2] as string;
      expect(path).toContain(join(home, "browser", "page-downloads")); // the pinned page-downloads dir
      const back = await readFile(path, "utf8"); // the file really exists…
      expect(back).toBe(BODY); // …byte-identical to what the page served
      await by("browser_close").execute({});
    } finally {
      await rm(profile, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  }, 120_000);
});
