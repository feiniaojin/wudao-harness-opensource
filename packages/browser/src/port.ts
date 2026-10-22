// ω99-112 — the controlled-browser port: the injectable seam between the
// wudao runtime and the browser driver. Everything above this file is driver
// agnostic (tests inject a Fake port, zero real browser); playwright-core
// itself is imported ONLY inside the default implementation's launch(), as a
// dynamic import — importing this module costs nothing and the CLI's static
// graph never pulls the ~9MB driver in until a browser is actually launched.
//
// PageHandle is deliberately playwright-shaped (a strict subset: goto/title/
// evaluate/click/fill/text/press/close + url for stale-ref detection), so the
// default adapter below is a one-liner per method and a second driver (CDP,
// WebKit, …) can slot in without touching the runtime, the snapshot, or the
// six model tools.
// ω99-142 — the download seam: the adapter intercepts context-level
// "download" events (a page export would otherwise vanish on close) and
// saves them under sanitized names; PageHandle gains an OPTIONAL downloads()
// for the manifest (the default adapter always provides it — absence marks a
// hand-rolled port, never the product path).
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { safeSegment } from "./download.js";

/** Options the runtime resolves BEFORE a launch (executable resolution order
 *  and the honest-error contract live in runtime.ts, not here). */
export interface BrowserLaunchOptions {
  /** A fully resolved browser binary. Absent → the driver's own registry
   *  lookup (for playwright: PLAYWRIGHT_BROWSERS_PATH-relative). */
  readonly executablePath?: string;
  /** v1 is headful by design — the whole point is a window the user can
   *  watch (弧门: 看得见的浏览器). headless stays an option for the E2E lane. */
  readonly headless?: boolean;
  /** Extra env for the driver launch (PLAYWRIGHT_BROWSERS_PATH rides here). */
  readonly env?: Readonly<Record<string, string>>;
  /** ω99-114: the persistent profile dir the browser launches with
   *  (chromium.launchPersistentContext's userDataDir). The runtime always
   *  resolves an absolute path before launching; the default adapter is
   *  fail-closed on its absence — there is NO silent fallback to an
   *  ephemeral context (login state must survive process restarts, or not
   *  promise persistence at all). */
  readonly userDataDir?: string;
  /** ω99-142: the directory page-initiated downloads are saved into (the
   *  runtime resolves <home>/browser/page-downloads before launching; the
   *  adapter mkdirs it and wires context.on("download") → saveAs). Absent →
   *  the adapter wires NO download interception — the runtime always passes
   *  it, so absence means a hand-rolled port, never the product path. */
  readonly downloadsDir?: string;
}

/** One live browser process (default impl: one playwright Browser). */
export interface BrowserHandle {
  newPage(): Promise<PageHandle>;
  close(): Promise<void>;
  /** Best-effort SYNCHRONOUS kill for process-exit hooks — an async close()
   *  cannot settle inside "exit". Absent → close() is the only recourse. */
  kill?(): void;
}

/** ω99-142 — one COMPLETED page-initiated download (a page's export button
 *  clicked by the model, saved to disk by the adapter's context.on("download")
 *  interception). An in-flight save is deliberately NOT representable: the
 *  manifest reports only files that actually landed (honest numbers). */
export interface DownloadRecord {
  /** The sanitized landed filename — timestamp-prefixed, safeSegment-verified
   *  (the page-controlled suggestedFilename NEVER joins a path raw). */
  readonly filename: string;
  /** File size in bytes (stat after saveAs). */
  readonly bytes: number;
  /** The absolute path the file landed at. */
  readonly path: string;
}

/** One controlled tab (default impl: one playwright Page). */
export interface PageHandle {
  /** The page's current URL — the runtime's navigation detector. */
  url(): Promise<string>;
  /** Navigate; resolves on domcontentloaded with the FINAL url (redirects
   *  included). Throws on invalid/unreachable targets. */
  goto(url: string): Promise<{ readonly finalUrl: string }>;
  title(): Promise<string>;
  /** Evaluate a page expression (the snapshot collector runs here). */
  evaluate<T = unknown>(script: string): Promise<T>;
  /** Click the element matching the selector (snapshot refs become
   *  `[data-wudao-ref="eN"]` selectors). Short timeout — a miss is the stale
   *  story, not a 30s hang. */
  click(selector: string): Promise<void>;
  /** ω99-139 — click at RAW viewport coordinates for the canvas/unref'd layer
   *  of browser_click_xy. SPACE: CSS pixels, the same grid as the snapshot
   *  bboxes (getBoundingClientRect) and browser_see's css-scale screenshot —
   *  the driver dispatches at viewport coordinates, so no conversion happens
   *  on either side of this seam. */
  clickAt(x: number, y: number): Promise<void>;
  /** ω99-141 — move the mouse to RAW viewport coordinates, then dispatch a
   *  wheel with the given deltas — ONE gesture (move + wheel are inseparable:
   *  the driver routes the wheel to the scrollable container under the
   *  pointer, which is exactly what browser_scroll_xy needs and what
   *  page-level window.scrollBy can never reach). SPACE: CSS pixels, the same
   *  grid as the snapshot bboxes and clickAt; dx/dy are wheel deltas in the
   *  same units (positive dy scrolls down). */
  wheelAt(x: number, y: number, dx: number, dy: number): Promise<void>;
  /** Type text into a form field (focus + replace). */
  fill(selector: string, text: string): Promise<void>;
  /** The page body's visible text. */
  text(): Promise<string>;
  /** Press a keyboard key at the page ("Enter" for submit). */
  press(key: string): Promise<void>;
  /** ω99-140 — type text KEYSTROKE BY KEYSTROKE into whatever element
   *  currently holds focus (playwright's keyboard.type dispatches each key
   *  to the focused element). The typing primitive for browser_type_xy's
   *  miss layer: clickAt(x, y) lands the focus, typeText fills it — an
   *  unref'd field (canvas, contenteditable) has no selector, so focus is
   *  the only honest address. */
  typeText(text: string): Promise<void>;
  /** ω99-136 — PNG bytes of the page for the vision lane (canvas pages the
   *  DOM snapshot is blind to). DEFAULT PIXEL SPACE: DEVICE pixels —
   *  playwright captures via CDP, so a Retina tab (devicePixelRatio 2) yields
   *  a PNG twice the CSS viewport in each dimension; snapshot bboxes
   *  (snapshot.ts) are CSS pixels.
   *  ω99-138 — `scale: "css"` captures at device-INDEPENDENT CSS pixels (the
   *  DPR gap is normalized at the source), which makes CSS the canonical
   *  coordinate space: a css-scale screenshot and the bbox table describe the
   *  same grid, so no conversion ever has to happen downstream. The device
   *  default stays (136 behavior, zero drift); browser_see asks for "css". */
  screenshot(opts?: { readonly scale?: "css" | "device" }): Promise<Uint8Array>;
  /** ω99-142 — the COMPLETED page-initiated downloads of this browser
   *  session (context-level: any tab's export lands here; the surface rides
   *  the page because the runtime is single-page). Completed saves only —
   *  a save still in flight never appears (the manifest has no phantom
   *  rows). Optional: the default adapter always provides it. */
  downloads?(): Promise<readonly DownloadRecord[]>;
  close(): Promise<void>;
}

/** The seam. Inject a Fake in every unit battery; the default is the
 *  playwright-core adapter below. */
export interface BrowserPort {
  launch(opts: BrowserLaunchOptions): Promise<BrowserHandle>;
}

/** Timeouts the default adapter pins (playwright's 30s defaults would turn a
 *  stale-ref miss into a half-minute hang; these keep failure honest and
 *  quick). Exported for the E2E lane's expectations. */
export const PORT_TIMEOUTS = {
  /** Navigation budget (a slow first paint is fine to wait for). */
  gotoMs: 30_000,
  /** Element-action budget (click/fill — a miss means stale refs). */
  actionMs: 5_000,
} as const;

/** The minimal structural view of a playwright Page the adapter wraps
 *  (driver typing churn stays outside this package). */
type PwPage = {
  url(): string;
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  title(): Promise<string>;
  evaluate<T>(script: string): Promise<T>;
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  fill(selector: string, text: string, opts?: { timeout?: number }): Promise<void>;
  innerText(selector: string): Promise<string>;
  // ω99-140: keyboard gains `type` — keystroke dispatch to the focused
  // element (the miss layer's typing primitive, see PageHandle.typeText).
  keyboard: { press(key: string): Promise<void>; type(text: string): Promise<void> };
  // ω99-139: playwright's mouse dispatches at viewport CSS pixels — the same
  // space as the snapshot bboxes, so the adapter is a bare passthrough.
  // ω99-141: mouse gains `move` + `wheel` — the wheel primitive for
  // PageHandle.wheelAt (playwright routes the wheel to the scrollable
  // container under the moved-to position).
  mouse: {
    click(x: number, y: number): Promise<void>;
    move(x: number, y: number): Promise<void>;
    wheel(dx: number, dy: number): Promise<void>;
  };
  // ω99-136: playwright's Buffer IS a Uint8Array — the structural view types
  // the adapter's passthrough without importing driver typings here.
  // ω99-138: the structural view gains `scale` (css|device) alongside `type`
  // so the adapter can forward the CSS-pixel capture browser_see asks for.
  screenshot(opts?: { type?: string; scale?: "css" | "device" }): Promise<Uint8Array>;
  close(): Promise<void>;
};

/** ω99-142 — the minimal structural view of a playwright Download (the same
 *  discipline as PwPage: driver typings stay outside this package). */
type PwDownload = {
  /** PAGE-CONTROLLED — must pass safeSegment before it ever joins a path. */
  suggestedFilename(): string;
  url(): string;
  saveAs(path: string): Promise<void>;
};

/** The default BrowserPort — playwright-core, loaded lazily. The dynamic
 *  import is the ONLY reference to the driver in this package's static
 *  graph; unit tests never reach it (they inject their own port). The
 *  playwright objects are viewed through a minimal structural type so this
 *  adapter survives driver typing churn (sync url(), evaluate overloads,
 *  the launched-process optional).
 *
 *  ω99-114: launches via chromium.launchPersistentContext(userDataDir, …) —
 *  one persistent profile per userDataDir, so cookies/logins survive
 *  process restarts (the whole point of the login arc). The returned
 *  BrowserContext (not a Browser) has pages()/newPage()/close() but NO
 *  process handle, so this handle omits kill (BrowserHandle.kill is
 *  optional): playwright's own SIGINT/SIGTERM/SIGHUP handling below is the
 *  first line of process hygiene, and the runtime's exit hook degrades to
 *  a close() attempt — recorded honestly, never faked. */
export function createPlaywrightPort(): BrowserPort {
  return {
    async launch(opts) {
      // Fail-closed BEFORE the dynamic import: absent/empty userDataDir
      // must refuse here (unit-testable without pulling the ~9MB driver —
      // 红线 4), and must never silently fall back to an ephemeral context
      // that would eat the login state on exit.
      if (typeof opts.userDataDir !== "string" || opts.userDataDir === "") {
        throw new Error(
          "userDataDir is required: the controlled browser always launches with a persistent profile (no silent fallback to an ephemeral context).",
        );
      }
      const userDataDir = opts.userDataDir;
      const { chromium } = await import("playwright-core");
      const context = (await chromium.launchPersistentContext(userDataDir, {
        headless: opts.headless ?? false,
        ...(opts.executablePath !== undefined ? { executablePath: opts.executablePath } : {}),
        ...(opts.env !== undefined ? { env: { ...process.env, ...opts.env } } : {}),
        // Playwright's own signal hygiene is the first line of "进程退出必收
        // 窗"; our exit hook (runtime.ts) is the belt-and-braces second
        // (degraded to close() — see the doc comment above).
        handleSIGINT: true,
        handleSIGTERM: true,
        handleSIGHUP: true,
      })) as unknown as {
        pages(): PwPage[];
        newPage(): Promise<PwPage>;
        close(): Promise<void>;
        // ω99-142: the context-level download event (the interception seam).
        on(event: "download", cb: (download: PwDownload) => void): unknown;
      };
      // ω99-142 — a page-initiated download left unsaved is LOST when the
      // context closes (playwright keeps it only in memory): intercept every
      // download event, saveAs into the caller-resolved dir under a
      // timestamp-prefixed SANITIZED name, and record COMPLETED saves for
      // PageHandle.downloads() (the manifest reports landed files only).
      const completed: DownloadRecord[] = [];
      if (opts.downloadsDir !== undefined) {
        const dir = opts.downloadsDir;
        // Honest failure: a downloads dir we cannot create is a launch
        // failure (the interception promise cannot be kept) — never a silent
        // no-download posture (the exact bug this arc exists to close).
        await mkdir(dir, { recursive: true });
        const inflight = new Set<PwDownload>(); // received-but-unsaved — invisible to the manifest by design
        context.on("download", (d) => {
          inflight.add(d);
          void (async () => {
            // suggestedFilename is PAGE-CONTROLLED: safeSegment (download.ts)
            // or the "download.bin" fallback — the raw name never joins a path.
            const safeName = safeSegment(d.suggestedFilename()) ?? "download.bin";
            const filename = `${Date.now()}-${safeName}`; // timestamp prefix: same-name exports never overwrite
            const path = join(dir, filename);
            await d.saveAs(path);
            completed.push({ filename, bytes: (await stat(path)).size, path });
          })()
            .catch(() => undefined) // a failed save never enters the manifest (completed only — honest numbers)
            .finally(() => { inflight.delete(d); });
        });
      }
      const adapt = (page: PwPage) => ({
        url: async () => page.url(),
        async goto(url: string) {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: PORT_TIMEOUTS.gotoMs });
          return { finalUrl: page.url() };
        },
        title: () => page.title(),
        evaluate: <T>(script: string) => page.evaluate<T>(script),
        click: (selector: string) => page.click(selector, { timeout: PORT_TIMEOUTS.actionMs }),
        // ω99-139: raw coordinate click (CSS pixels) — mouse passthrough.
        clickAt: (x: number, y: number) => page.mouse.click(x, y),
        // ω99-141: coordinate wheel — move the pointer FIRST, then wheel; the
        // driver delivers the scroll to whatever container sits under (x, y).
        wheelAt: async (x: number, y: number, dx: number, dy: number) => {
          await page.mouse.move(x, y);
          await page.mouse.wheel(dx, dy);
        },
        fill: (selector: string, text: string) => page.fill(selector, text, { timeout: PORT_TIMEOUTS.actionMs }),
        text: () => page.innerText("body"),
        press: (key: string) => page.keyboard.press(key),
        // ω99-140: keystroke typing to the FOCUSED element — one-line
        // passthrough (see PageHandle.typeText for the semantics).
        typeText: (text: string) => page.keyboard.type(text),
        // ω99-136: vision-lane passthrough — PNG bytes in the driver's device
        // pixel space, straight from playwright (see PageHandle.screenshot).
        // ω99-138: an explicit scale rides through verbatim; absent scale
        // keeps the 136 bytes (playwright's device default) — zero drift.
        screenshot: (opts?: { scale?: "css" | "device" }) =>
          page.screenshot({ type: "png", ...(opts?.scale !== undefined ? { scale: opts.scale } : {}) }),
        close: () => page.close(),
        // ω99-142: the manifest — one shared array per context (every page of
        // this launch sees the same completed records; a COPY, never the live
        // array). No downloadsDir → no method: the honest degradation.
        ...(opts.downloadsDir !== undefined
          ? { downloads: async (): Promise<readonly DownloadRecord[]> => [...completed] }
          : {}),
      });
      return {
        async newPage() {
          // launchPersistentContext spawns with one initial blank page —
          // adopt it instead of piling up tabs; newPage() only when the
          // initial page is gone (closed by a test or the idle reaper).
          const page = context.pages()[0] ?? (await context.newPage());
          return adapt(page);
        },
        close: () => context.close(),
      };
    },
  };
}
