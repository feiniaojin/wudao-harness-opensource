// ω99-112 — the six model tools over the browser runtime. Ref discipline is
// the whole contract: every clickable element a snapshot lists carries a ref
// (e1..eN); click/type address refs, NEVER CSS selectors; navigation voids
// all refs and the honest error tells the model to re-snapshot. Risk flags
// are explicit on every tool (this package cannot import core's buildTool as
// a VALUE — zero core runtime dependency — so the fail-closed defaults are
// spelled out literally): all are open-world (they drive a live web page),
// none defers (the tool-list prefix stays byte-stable), reads are marked
// read-only so the permission tiers can treat them gently. Submission-class
// actions (click, type-with-submit) carry their ask posture in the CLI
// permission layer (DEFAULT_ASK_TOOLS), not here — core's PermissionDecision
// cannot express "ask".
// ω99-138 — the seventh tool, browser_see, adds the VISION face: a CSS-pixel
// screenshot plus the current ref/bbox table. Screenshot bytes leave this
// package ONLY through the injected imageSink (the caller owns persistence);
// with no sink the tool degrades honestly to its text table (a text model
// works fine off the table — one browser_see must never poison every later
// request with a typed image refusal).
// ω99-139 — the eighth tool, browser_click_xy, closes the vision loop: it
// turns CSS-pixel coordinates (browser_see's image/table) into a click —
// ref-routed when a bbox hits, raw page coordinates otherwise (canvas), with
// the always-ask posture for the unrecognized-target layer in the CLI
// permission layer (DEFAULT_ASK_TOOLS), never here.
// ω99-140 — the ninth tool, browser_type_xy, is the type pair's coordinate
// face: CSS-pixel coordinates become typed text through the same two ruled
// layers — a bbox hit routes through the FULL browser_type channel (the
// password gate VERBATIM: a coordinate is never a lane around the credential
// refusal), a miss clicks the raw coordinates to land focus, then
// keystrokes the text in, honestly labeled "field type unknown" (whole-tool
// always-ask posture in the CLI permission layer, DEFAULT_ASK_TOOLS).
// ω99-141 — the tenth tool, browser_scroll_xy, is the scroll pair's
// coordinate face: a WHEEL dispatched at CSS-pixel coordinates reaches the
// scrollable container UNDER the point (a canvas app's embedded panels —
// the layers sidebar, the artboard viewport), which page-level
// window.scrollBy (browser_scroll) can never touch. Read-only like
// browser_scroll: the permission tiers auto-allow it, no ask surface.
// ω99-142 — the eleventh tool, browser_downloads, is the M-CU2 closer: a
// page's "Export" button produces a FILE, and until the port intercepted
// context-level download events (saveAs under sanitized names) that file
// silently vanished when the browser closed. This tool is the manifest —
// what landed, how big, where on disk. A closed-world read (local records,
// no page touch): the isReadOnly:true + isOpenWorld:false pair is the
// sidecar's no-audit shape, and the permission tiers auto-allow it — zero
// ask surface, permission.ts untouched this arc.
import type { ImageBlock, Tool, ToolResult } from "@wudao-org/core";
import type { PageHandle } from "./port.js";
import type { BrowserRuntime, PageSnapshotRefs, SnapshotRefEntry } from "./runtime.js";
import { COLLECT_SCRIPT, formatSnapshot, validRef } from "./snapshot.js";

const ok = (content: string): ToolResult => ({ content });
const err = (content: string): ToolResult => ({ content, isError: true });
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const NOT_OPEN = "The browser window is not open — call browser_open with an http(s) URL first.";

// ---------------------------------------------------------------------------
// ω99-138 — the injected screenshot sink (the persistence seam stays OUTSIDE
// this package: zero core runtime, ImageBlock is a type-only import).
// ---------------------------------------------------------------------------

/** What the sink learns about the captured PNG (its IHDR dimensions — the
 *  CSS-pixel viewport when browser_see captures at scale:"css"). */
export interface BrowserImageSinkMeta {
  readonly widthPx: number;
  readonly heightPx: number;
}

/** Receives the PNG bytes, returns the durable ImageBlock they became.
 *  Returning undefined = honest no-image THIS call (the caller's modality
 *  pre-check declined — browser_see degrades to its text table); throwing =
 *  an honest error result (a failed screenshot is never silently empty). */
export type BrowserImageSink = (png: Uint8Array, meta: BrowserImageSinkMeta) => Promise<ImageBlock | undefined>;

/** Read the IHDR width/height out of PNG bytes (big-endian at fixed offsets
 *  16/20 — the first chunk of every valid PNG is IHDR). Pure, no deps; used
 *  only to hand the sink honest dimensions. */
function pngSize(b: Uint8Array): { readonly widthPx: number; readonly heightPx: number } | null {
  if (b.length < 24) return null;
  const w = (b[16]! << 24) | (b[17]! << 16) | (b[18]! << 8) | b[19]!;
  const h = (b[20]! << 24) | (b[21]! << 16) | (b[22]! << 8) | b[23]!;
  if (w <= 0 || h <= 0) return null;
  return { widthPx: w, heightPx: h };
}

/** ω99-114 fail-closed credential gate: the model NEVER types passwords.
 *  Literal-pinned by tests ("password" + "visible browser window"). */
const PASSWORD_REFUSED = (ref: string): string =>
  `Typing into ${ref} was refused: it is a password field. Never type a password for the user — ask the user to type their password in the visible browser window. The login persists in the controlled profile, so the site stays logged in for future sessions.`;

function parseHttpUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** ω99-114: the backoff between a failed goto and its single retry. */
const OPEN_RETRY_MS = 2_000;

/** ω99-114: navigate with ONE retry. Any goto failure retries once after a
 *  2s backoff — transient DNS/socket blips recover, and the error-class
 *  strings are unstable, so the gate is deliberately WIDE (取宽): worst
 *  case one wasted 2s wait; never a retry storm. A second failure
 *  propagates and surfaces the existing honest error. The success path
 *  sleeps zero. */
async function gotoWithRetry(page: PageHandle, url: string): Promise<{ readonly finalUrl: string }> {
  try {
    return await page.goto(url);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, OPEN_RETRY_MS));
    return await page.goto(url);
  }
}

/** Shared prelude for click/type: an open page, a live snapshot, a resolvable ref. */
type ActionTarget =
  | { readonly kind: "ok"; readonly page: PageHandle; readonly snapshot: PageSnapshotRefs; readonly selector: string; readonly desc: string; readonly entry: SnapshotRefEntry }
  | { readonly kind: "err"; readonly result: ToolResult };

async function actionTarget(runtime: BrowserRuntime, rawRef: unknown): Promise<ActionTarget> {
  if (runtime.state() === "closed") return { kind: "err", result: err(NOT_OPEN) };
  if (typeof rawRef !== "string" || !validRef(rawRef)) {
    // ω99-144: browser_see 同刷 ref 表（138 语义），降级文案并列路由。
    return { kind: "err", result: err(`ref must look like "e1", "e2", … (from browser_snapshot or browser_see); got ${JSON.stringify(rawRef)}.`) };
  }
  const snapshot = runtime.currentSnapshot();
  if (snapshot === null) {
    // ω99-144: browser_see 同刷 ref 表（138 语义），降级文案并列路由。
    return { kind: "err", result: err("No snapshot yet — call browser_see (or browser_snapshot) first: both list every clickable element with its ref; browser_see also attaches the page image.") };
  }
  const entry = snapshot.refs.get(rawRef);
  if (entry === undefined) {
    // ω99-144: browser_see 同刷 ref 表（138 语义）；ref 丢失现场是模型兜圈处，canvas 出路只在这里给。
    return { kind: "err", result: err(`Ref ${rawRef} is not in the current snapshot (the page may have navigated since it was taken) — call browser_see or browser_snapshot again for fresh refs — if the table stays sparse (canvas/graphics page), use browser_see's image and click at CSS-pixel coordinates (browser_click_xy).`) };
  }
  try {
    const page = await runtime.openPage();
    // Stale guard at action time: the page may have navigated since the
    // snapshot (link clicks, redirects, timers) — a ref from another
    // document must never receive this click.
    const now = await page.url();
    if (now !== snapshot.url) {
      runtime.invalidateSnapshot();
      // ω99-144: browser_see 同刷 ref 表（138 语义），降级文案并列路由。
      return { kind: "err", result: err(`The snapshot is stale — the page navigated to ${now} after it was taken. Call browser_see or browser_snapshot again and use the fresh refs.`) };
    }
    return { kind: "ok", page, snapshot, selector: entry.selector, desc: entry.desc, entry };
  } catch (e) {
    return { kind: "err", result: err(msg(e)) };
  }
}

/** Poll for a post-action navigation (a form submit lands a tick after the
 *  keypress; a link's navigation after the click). Returns the final URL. */
async function settleUrl(page: PageHandle, before: string, ms = 1500): Promise<string> {
  const start = Date.now();
  let now = await page.url();
  while (now === before && Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 100));
    now = await page.url();
  }
  return now;
}

/** After an action: void refs when the page moved; say which it was.
 *  settle=true (click, submit-Enter) polls briefly for the navigation the
 *  action itself initiates. */
async function navigationNote(runtime: BrowserRuntime, page: PageHandle, before: string, settle = false): Promise<string> {
  const now = settle ? await settleUrl(page, before) : await page.url();
  runtime.noteUrl(now);
  // ω99-144: browser_see 同刷 ref 表（138 语义），降级文案并列路由。
  return now === before
    ? ""
    : ` The page navigated to ${now} — all refs are invalidated; run browser_see or browser_snapshot for fresh refs.`;
}

// ω99-139 — the viewport probe for browser_click_xy's fallback layer: CSS
// pixels, the same grid as the bboxes (a fixed expression string so tests can
// match it deterministically).
const VIEWPORT_PROBE = "({ w: window.innerWidth, h: window.innerHeight })";

/** ω99-139 — pure hit-test: the SMALLEST-area ref'd bbox containing the
 *  point (the innermost box wins when elements nest). Inclusive edges;
 *  entries without a bbox never match (geometry not collected is never
 *  guessed). Iteration order is the refs map's insertion order, so ties
 *  keep the first-collected (document order) — deterministic. */
function hitRef(snapshot: PageSnapshotRefs, x: number, y: number): { readonly ref: string; readonly area: number } | null {
  let best: { ref: string; area: number } | null = null;
  for (const [ref, entry] of snapshot.refs) {
    const b = entry.bbox;
    if (b === undefined) continue;
    if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height) {
      const area = b.width * b.height;
      if (best === null || area < best.area) best = { ref, area };
    }
  }
  return best;
}

/** The eleven tools, in their FIXED registration order (the CLI inserts them
 *  at one fixed position; this order inside the group never changes).
 *  ω99-138: `imageSink` is optional — absent (or undefined-returning) keeps
 *  browser_see on its honest text-table degradation; the six 112 tools are
 *  untouched by it either way.
 *  ω99-139: browser_click_xy sits right after browser_click (the click pair),
 *  arming "point at pixels → click" for canvas pages browser_see unveiled.
 *  ω99-140: browser_type_xy sits right after browser_type (the type pair) —
 *  the same pairing logic, isomorphic: "point at pixels → type".
 *  ω99-141: browser_scroll_xy sits right after browser_scroll (the scroll
 *  pair) — "point at pixels → scroll the container under them".
 *  ω99-142: browser_downloads sits right after browser_scroll_xy, before
 *  browser_close — the export flow's last mile (see the file the page
 *  saved), zero parameters by design. */
export function browserToolsFor(runtime: BrowserRuntime, imageSink?: BrowserImageSink): Tool[] {
  const browserOpen: Tool = {
    name: "browser_open",
    description:
      "Open a URL in the visible browser window (launching the browser if needed) and return the page title, the final URL after redirects, and a short text excerpt. http(s) URLs only. Follow with browser_snapshot to see the page's clickable elements and their refs.",
    parameters: { type: "object", properties: { url: { type: "string", description: "Absolute http(s) URL to open." } }, required: ["url"], additionalProperties: false },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    shouldDefer: () => false,
    isOpenWorld: () => true,
    async execute(input): Promise<ToolResult> {
      const url = parseHttpUrl(input["url"]);
      if (url === null) return err(`url must be an absolute http(s) URL; got ${JSON.stringify(input["url"])}.`);
      let page: PageHandle;
      try {
        page = await runtime.openPage();
        const { finalUrl } = await gotoWithRetry(page, url.toString());
        const title = await page.title();
        const text = (await page.text()).replace(/\s+/g, " ").trim();
        runtime.invalidateSnapshot(); // a new document voids every ref
        const excerpt = text.length > 500 ? `${text.slice(0, 500)}…` : text;
        return ok(`Opened: ${finalUrl}\nTitle: ${title}\n\n${excerpt}\n\n(Next: browser_snapshot lists clickable elements with refs.)`);
      } catch (e) {
        return err(msg(e));
      }
    },
  };
  const browserSnapshot: Tool = {
    name: "browser_snapshot",
    description:
      "Capture the current page: its text outline plus every visible clickable element, each addressable by a short ref (e1, e2, …). Refs stay valid only until the page navigates — after any navigation or stale-ref error, take a fresh snapshot and use the new refs.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    shouldDefer: () => false,
    isOpenWorld: () => true,
    async execute(): Promise<ToolResult> {
      if (runtime.state() === "closed") return err(NOT_OPEN);
      try {
        const page = await runtime.openPage();
        const collected = await page.evaluate<unknown>(COLLECT_SCRIPT);
        if (typeof collected !== "object" || collected === null || !Array.isArray((collected as { elements?: unknown }).elements)) {
          return err("The page snapshot came back malformed — retry browser_snapshot.");
        }
        const payload = collected as { url?: unknown; title?: unknown; text?: unknown; elements?: unknown };
        const { text, refs } = formatSnapshot({
          url: typeof payload.url === "string" ? payload.url : "",
          title: typeof payload.title === "string" ? payload.title : "",
          text: typeof payload.text === "string" ? payload.text : "",
          elements: payload.elements as never,
        });
        const url = typeof payload.url === "string" ? payload.url : "";
        runtime.saveSnapshot(url, refs);
        runtime.noteUrl(await page.url());
        return ok(text);
      } catch (e) {
        return err(msg(e));
      }
    },
  };
  // ω99-138 — the vision face. Screenshot FIRST (the pixels the model is
  // about to be shown), then the same collect/format/save channel as
  // browser_snapshot, so the ref/bbox table and the image describe one page
  // state and the navigation-void discipline is identical by construction.
  const browserSee: Tool = {
    name: "browser_see",
    description:
      "Look at the current page: attach a screenshot (CSS pixel space — the same grid as the @[x,y,w,h] coordinates in snapshot lines) alongside the fresh clickable-element table with refs. Use it when visuals matter (canvas, images, layout, verifying what a change looks like). On text-only models the screenshot is omitted and the table alone is returned. Refreshes refs exactly like browser_snapshot.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    shouldDefer: () => false,
    isOpenWorld: () => true,
    async execute(): Promise<ToolResult> {
      if (runtime.state() === "closed") return err(NOT_OPEN);
      try {
        const page = await runtime.openPage();
        // CSS-pixel capture: the DPR gap is normalized at the source (port.ts),
        // so the PNG and the bbox table share one grid — no conversion ever.
        const png = await page.screenshot({ scale: "css" });
        const collected = await page.evaluate<unknown>(COLLECT_SCRIPT);
        if (typeof collected !== "object" || collected === null || !Array.isArray((collected as { elements?: unknown }).elements)) {
          return err("The page snapshot came back malformed — retry browser_see.");
        }
        const payload = collected as { url?: unknown; title?: unknown; text?: unknown; elements?: unknown };
        const { text, refs } = formatSnapshot({
          url: typeof payload.url === "string" ? payload.url : "",
          title: typeof payload.title === "string" ? payload.title : "",
          text: typeof payload.text === "string" ? payload.text : "",
          elements: payload.elements as never,
        });
        runtime.saveSnapshot(typeof payload.url === "string" ? payload.url : "", refs);
        runtime.noteUrl(await page.url());
        if (imageSink === undefined) {
          // Honest degradation, no sink wired: the tool still works — the
          // table is the complete actionable surface for a text model.
          return ok(`${text}\n\n(视觉通道未接入：截图未附。上表已列出全部可点元素及其 CSS 像素坐标，可凭表操作；需要看图时请在接入视觉模型的会话中使用本工具。)`);
        }
        const meta = pngSize(png);
        if (meta === null) {
          return err("The screenshot bytes came back malformed (not a decodable PNG) — retry browser_see.");
        }
        let block: ImageBlock | undefined;
        try {
          block = await imageSink(png, meta);
        } catch (e) {
          // A failed attach is never a silent empty result (136 discipline):
          // the error names the failure; the table above is NOT returned in
          // the error channel — retry browser_see re-runs both halves.
          return err(`Attaching the screenshot failed (${msg(e)}). The page has not changed; retry browser_see.`);
        }
        if (block === undefined) {
          // The sink declined THIS call (the caller's modality pre-check —
          // a text main model must never be fed an image-bearing request).
          return ok(`${text}\n\n(截图未附：当前主模型不接受图像输入。上表已列出全部可点元素及其 CSS 像素坐标，可凭表完成操作。)`);
        }
        return { content: `${text}\n\n截图已附（CSS 像素空间，坐标即表中所列）。`, images: [block] };
      } catch (e) {
        return err(msg(e));
      }
    },
  };
  // ω99-139 — the eighth tool: click CSS-pixel coordinates from browser_see.
  // TWO LAYERS (the M-CU1 closing ruling): a point inside a ref'd element's
  // bbox routes through actionTarget — the FULL browser_click channel (stale
  // guard, selector click, navigation note, identical ask posture); a point
  // that hits no bbox (canvas, an unref'd region) clicks the page at raw
  // coordinates via clickAt. The miss layer's ask posture is whole-tool-class
  // (the tool name sits in the CLI's DEFAULT_ASK_TOOLS): the hit layer being
  // asked too is an accepted over-strictness — no parameter splitting.
  const browserClickXy: Tool = {
    name: "browser_click_xy",
    description:
      "Click at CSS-pixel page coordinates (x, y) — the same grid as browser_see's screenshot and its @[x,y,w,h] table. A point inside a listed element's box clicks that element by ref (the normal click channel); a point outside every box (canvas, unref'd regions) clicks the page at raw coordinates — that layer always surfaces on the user's confirmation card. Call browser_see first for a fresh image and table.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "number", description: "Horizontal CSS-pixel coordinate, from browser_see's screenshot or its @[x,y,w,h] table." },
        y: { type: "number", description: "Vertical CSS-pixel coordinate, from browser_see's screenshot or its @[x,y,w,h] table." },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    shouldDefer: () => false,
    isOpenWorld: () => true,
    async execute(input): Promise<ToolResult> {
      // Fail-closed BEFORE any launch: coordinates are finite non-negative
      // CSS pixels — anything else never touches the page.
      const px = input["x"];
      const py = input["y"];
      if (
        typeof px !== "number" || !Number.isFinite(px) ||
        typeof py !== "number" || !Number.isFinite(py) ||
        px < 0 || py < 0
      ) {
        return err(`x and y must be finite non-negative numbers (CSS pixels, from browser_see's screenshot or @[x,y,w,h] table); got x=${JSON.stringify(px)}, y=${JSON.stringify(py)}.`);
      }
      if (runtime.state() === "closed") return err(NOT_OPEN);
      const snapshot = runtime.currentSnapshot();
      if (snapshot === null) {
        return err("No snapshot yet — call browser_see (or browser_snapshot) first: its image and @[x,y,w,h] table are this tool's coordinate source.");
      }
      // Layer 1 — hit: the full actionTarget channel (never bypassed).
      const hit = hitRef(snapshot, px, py);
      if (hit !== null) {
        const t = await actionTarget(runtime, hit.ref);
        if (t.kind === "err") return t.result;
        try {
          await t.page.click(t.selector);
          return ok(`(${px}, ${py}) hits ${hit.ref} (${t.desc}) — clicked by ref through the normal channel.${await navigationNote(runtime, t.page, t.snapshot.url, true)}`);
        } catch (e) {
          return err(`Click on ${hit.ref} at (${px}, ${py}) failed (${msg(e)}). If the page changed, run browser_see for a fresh image and table.`);
        }
      }
      // Layer 2 — miss (canvas / an unref'd region): raw coordinate click.
      try {
        const page = await runtime.openPage();
        const now = await page.url();
        if (now !== snapshot.url) {
          runtime.invalidateSnapshot();
          return err(`The snapshot is stale — the page navigated to ${now} after it was taken, so these coordinates were measured on another page. Call browser_see again and retry with fresh coordinates.`);
        }
        const vp = await page.evaluate<{ w?: unknown; h?: unknown }>(VIEWPORT_PROBE);
        const vw = vp !== null && typeof vp === "object" && typeof vp.w === "number" ? vp.w : Number.NaN;
        const vh = vp !== null && typeof vp === "object" && typeof vp.h === "number" ? vp.h : Number.NaN;
        if (!Number.isFinite(vw) || !Number.isFinite(vh) || px >= vw || py >= vh) {
          return err(`(${px}, ${py}) is outside the current viewport${Number.isFinite(vw) && Number.isFinite(vh) ? ` (${vw}×${vh} CSS px)` : ""} — nothing there to click. Call browser_see and use coordinates inside the image.`);
        }
        await page.clickAt(px, py);
        return ok(`Clicked at (${px}, ${py}) — the point hits no listed element's box (canvas/未命中层，已按坐标点击), so the page was clicked at raw coordinates.${await navigationNote(runtime, page, snapshot.url, true)}`);
      } catch (e) {
        return err(`Coordinate click at (${px}, ${py}) failed (${msg(e)}). Call browser_see for a fresh image and table, then retry.`);
      }
    },
  };
  // ω99-140 — the ninth tool: type at CSS-pixel coordinates (the type pair's
  // coordinate face, isomorphic to browser_click_xy's two layers). A hit
  // routes through the FULL browser_type channel — the password gate VERBATIM
  // (a coordinate is never a lane around the credential refusal); a miss
  // (canvas / contenteditable / an unref'd field) clicks the raw coordinates
  // to land focus, then typeText keystrokes into whatever received it — the
  // field's type is UNKNOWN there and the result text says so honestly (the
  // whole tool class always asks in the CLI's DEFAULT_ASK_TOOLS).
  const browserTypeXy: Tool = {
    name: "browser_type_xy",
    description:
      "Type text at CSS-pixel page coordinates (x, y) — the same grid as browser_see's screenshot and its @[x,y,w,h] table. A point inside a listed field's box fills that field by ref (the normal type channel; password fields are refused). A point outside every box (canvas, contenteditable, unref'd fields) clicks there first to focus, then types keystrokes into whatever received focus — that layer never knows the field's type and says so. submit:true presses Enter after typing. Call browser_see first for a fresh image and table.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "number", description: "Horizontal CSS-pixel coordinate, from browser_see's screenshot or its @[x,y,w,h] table." },
        y: { type: "number", description: "Vertical CSS-pixel coordinate, from browser_see's screenshot or its @[x,y,w,h] table." },
        text: { type: "string", description: "Text to type at the coordinates (a hit replaces the field's content)." },
        submit: { type: "boolean", description: "Press Enter after typing (submits the form). Default false." },
      },
      required: ["x", "y", "text"],
      additionalProperties: false,
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    shouldDefer: () => false,
    isOpenWorld: () => true,
    async execute(input): Promise<ToolResult> {
      // Fail-closed BEFORE any launch (139 discipline verbatim): coordinates
      // are finite non-negative CSS pixels and the text a non-empty string —
      // anything else never touches the page.
      const px = input["x"];
      const py = input["y"];
      const text = input["text"];
      const submit = input["submit"] ?? false;
      if (
        typeof px !== "number" || !Number.isFinite(px) ||
        typeof py !== "number" || !Number.isFinite(py) ||
        px < 0 || py < 0
      ) {
        return err(`x and y must be finite non-negative numbers (CSS pixels, from browser_see's screenshot or @[x,y,w,h] table); got x=${JSON.stringify(px)}, y=${JSON.stringify(py)}.`);
      }
      if (typeof text !== "string" || text === "") return err("text must be a non-empty string.");
      if (typeof submit !== "boolean") return err("submit must be a boolean.");
      if (runtime.state() === "closed") return err(NOT_OPEN);
      const snapshot = runtime.currentSnapshot();
      if (snapshot === null) {
        return err("No snapshot yet — call browser_see (or browser_snapshot) first: its image and @[x,y,w,h] table are this tool's coordinate source.");
      }
      // Layer 1 — hit: the FULL browser_type channel, never bypassed — the
      // password gate included (the coordinate must refuse exactly as hard).
      const hit = hitRef(snapshot, px, py);
      if (hit !== null) {
        const t = await actionTarget(runtime, hit.ref);
        if (t.kind === "err") return t.result;
        // ω99-140: the credential gate, VERBATIM from browser_type — a KNOWN
        // password field never receives model-typed text, whichever channel
        // (ref or coordinate) addressed it; zero fill, zero typeText.
        if (t.entry.type === "password") return err(PASSWORD_REFUSED(hit.ref));
        try {
          await t.page.fill(t.selector, text);
          if (submit) await t.page.press("Enter");
          return ok(
            `(${px}, ${py}) hits ${hit.ref} (${t.desc}) — typed by ref through the normal channel${submit ? ", Enter pressed" : ""}.${await navigationNote(runtime, t.page, t.snapshot.url, submit)}`,
          );
        } catch (e) {
          return err(`Typing into ${hit.ref} at (${px}, ${py}) failed (${msg(e)}). If the page changed, run browser_see for a fresh image and table.`);
        }
      }
      // Layer 2 — miss (canvas / an unref'd field): click the raw coordinates
      // to land focus, then keystroke the text into whatever received it.
      try {
        const page = await runtime.openPage();
        const now = await page.url();
        if (now !== snapshot.url) {
          runtime.invalidateSnapshot();
          return err(`The snapshot is stale — the page navigated to ${now} after it was taken, so these coordinates were measured on another page. Call browser_see again and retry with fresh coordinates.`);
        }
        const vp = await page.evaluate<{ w?: unknown; h?: unknown }>(VIEWPORT_PROBE);
        const vw = vp !== null && typeof vp === "object" && typeof vp.w === "number" ? vp.w : Number.NaN;
        const vh = vp !== null && typeof vp === "object" && typeof vp.h === "number" ? vp.h : Number.NaN;
        if (!Number.isFinite(vw) || !Number.isFinite(vh) || px >= vw || py >= vh) {
          return err(`(${px}, ${py}) is outside the current viewport${Number.isFinite(vw) && Number.isFinite(vh) ? ` (${vw}×${vh} CSS px)` : ""} — nothing there to type into. Call browser_see and use coordinates inside the image.`);
        }
        // ω99-140: click FIRST (focus), then keystroke — one combined channel,
        // so a failure of either surfaces as one honest coordinate error.
        await page.clickAt(px, py);
        await page.typeText(text);
        if (submit) await page.press("Enter");
        return ok(`Typed at (${px}, ${py}) — 未命中层，已按坐标点击后打字（字段类型未知）：the point hits no listed element's box, so focus landed on whatever the click hit and the text was keystroked into it${submit ? ", then Enter" : ""}.${await navigationNote(runtime, page, snapshot.url, submit)}`);
      } catch (e) {
        return err(`Coordinate typing at (${px}, ${py}) failed (${msg(e)}). Call browser_see for a fresh image and table, then retry.`);
      }
    },
  };
  // ω99-141 — the tenth tool: scroll the container UNDER CSS-pixel
  // coordinates. browser_scroll drives window.scrollBy — page-level only,
  // blind to the embedded panes of online design tools (a layers sidebar,
  // a canvas viewport); browser_scroll_xy instead dispatches a WHEEL at the
  // point, and the browser routes it to whatever scrollable container sits
  // there. NO hit layer — scrolling needs no target identification (wherever
  // the point sits is what scrolls); the 139/140 preamble (stale guard,
  // viewport probe) is the whole story. Read-only like browser_scroll, so
  // the permission tiers auto-allow it (ZERO ask surface — this arc does not
  // touch permission.ts).
  const browserScrollXy: Tool = {
    name: "browser_scroll_xy",
    description:
      "Scroll the container under CSS-pixel coordinates (x, y) up or down by about one screen — the same coordinate grid as browser_see's screenshot and its @[x,y,w,h] table. Unlike browser_scroll (page-level), the wheel reaches whatever scrollable pane sits under the point: an online design tool's layers sidebar, a canvas viewport, any embedded panel. Read-only; refs stay valid while the page does not navigate. Call browser_see first for a fresh image and table.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "number", description: "Horizontal CSS-pixel coordinate, from browser_see's screenshot or its @[x,y,w,h] table." },
        y: { type: "number", description: "Vertical CSS-pixel coordinate, from browser_see's screenshot or its @[x,y,w,h] table." },
        direction: { type: "string", description: '"down" or "up" — one wheel of ~90% of the viewport height (browser_scroll\'s own convention), applied to the container under (x, y).' },
      },
      required: ["x", "y", "direction"],
      additionalProperties: false,
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    shouldDefer: () => false,
    isOpenWorld: () => true,
    async execute(input): Promise<ToolResult> {
      // Fail-closed BEFORE any launch (139 discipline verbatim): coordinates
      // are finite non-negative CSS pixels and direction is up|down —
      // anything else never touches the page.
      const px = input["x"];
      const py = input["y"];
      const direction = input["direction"];
      if (
        typeof px !== "number" || !Number.isFinite(px) ||
        typeof py !== "number" || !Number.isFinite(py) ||
        px < 0 || py < 0
      ) {
        return err(`x and y must be finite non-negative numbers (CSS pixels, from browser_see's screenshot or @[x,y,w,h] table); got x=${JSON.stringify(px)}, y=${JSON.stringify(py)}.`);
      }
      if (direction !== "up" && direction !== "down") return err('direction must be "up" or "down".');
      if (runtime.state() === "closed") return err(NOT_OPEN);
      const snapshot = runtime.currentSnapshot();
      if (snapshot === null) {
        return err("No snapshot yet — call browser_see (or browser_snapshot) first: its image and @[x,y,w,h] table are this tool's coordinate source.");
      }
      // No hit layer by design: the wheel is addressed to a POINT, not an
      // element — whatever scrollable container sits under it is what
      // scrolls (a plain page point scrolls the page, a pane point scrolls
      // the pane). The stale guard + viewport probe are the full preamble.
      try {
        const page = await runtime.openPage();
        const now = await page.url();
        if (now !== snapshot.url) {
          runtime.invalidateSnapshot();
          return err(`The snapshot is stale — the page navigated to ${now} after it was taken, so these coordinates were measured on another page. Call browser_see again and retry with fresh coordinates.`);
        }
        const vp = await page.evaluate<{ w?: unknown; h?: unknown }>(VIEWPORT_PROBE);
        const vw = vp !== null && typeof vp === "object" && typeof vp.w === "number" ? vp.w : Number.NaN;
        const vh = vp !== null && typeof vp === "object" && typeof vp.h === "number" ? vp.h : Number.NaN;
        if (!Number.isFinite(vw) || !Number.isFinite(vh) || px >= vw || py >= vh) {
          return err(`(${px}, ${py}) is outside the current viewport${Number.isFinite(vw) && Number.isFinite(vh) ? ` (${vw}×${vh} CSS px)` : ""} — no container sits under it to scroll. Call browser_see and use coordinates inside the image.`);
        }
        // One wheel = ~90% of the viewport height — browser_scroll's own
        // convention; down is a positive delta, up negative.
        const dy = Math.round(vh * 0.9) * (direction === "down" ? 1 : -1);
        await page.wheelAt(px, py, 0, dy);
        return ok(`Scrolled ${direction} at (${px}, ${py}) — the wheel landed on whatever container sits under the coordinates (坐标之下的滚动容器，canvas 内嵌面板在内), not necessarily the page body. Refs stay valid while the page does not navigate; run browser_see to see newly revealed elements.`);
      } catch (e) {
        return err(`Coordinate scroll at (${px}, ${py}) failed (${msg(e)}). Call browser_see for a fresh image and table, then retry.`);
      }
    },
  };
  // ω99-142 — the eleventh tool: the page-download manifest (M-CU2's missing
  // last mile — "改标题 + 导出 PNG" ends with SEEING the exported file). The
  // port intercepts context-level download events and saves them under
  // sanitized, timestamp-prefixed names; this tool lists what COMPLETED —
  // a save still in flight never appears (honest numbers, no phantom rows;
  // the model polls after an export click). ZERO parameters by design: the
  // smallest injection surface there is. Closed-world read of local records
  // (no page touch, no network) → isConcurrencySafe, and the
  // isReadOnly:true + isOpenWorld:false pair is the sidecar's no-audit
  // shape; the permission tiers auto-allow it (permission.ts untouched).
  const browserDownloads: Tool = {
    name: "browser_downloads",
    description:
      "List the files the page has downloaded (an export button's output — a PNG, a PDF, a spreadsheet): each with its saved filename, size in bytes, and absolute path on disk. A download triggered moments ago may still be saving — if the file you expect is missing, call this again shortly.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    shouldDefer: () => false,
    isOpenWorld: () => false,
    async execute(): Promise<ToolResult> {
      if (runtime.state() === "closed") return err(NOT_OPEN);
      try {
        const page = await runtime.openPage();
        const list = await page.downloads?.();
        if (list === undefined || list.length === 0) {
          return ok("No downloads yet — a file exported by the page (an export button click) lands here.");
        }
        return ok(`Downloads saved by the page (oldest first):\n${list.map((r) => `${r.filename} (${r.bytes} B) → ${r.path}`).join("\n")}`);
      } catch (e) {
        return err(msg(e));
      }
    },
  };
  return [
    browserOpen,
    browserSnapshot,
    browserSee,
    {
      name: "browser_click",
      description:
        "Click a clickable element by its snapshot ref (e1, e2, …). Buttons that submit forms, post, order, or confirm are submission-class: they surface on the user's confirmation card by default (the user can approve once or always). Refs come from the latest browser_snapshot and are voided by any navigation.",
      parameters: { type: "object", properties: { ref: { type: "string", description: 'Element ref from the latest browser_snapshot, e.g. "e1".' } }, required: ["ref"], additionalProperties: false },
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      shouldDefer: () => false,
      isOpenWorld: () => true,
      async execute(input): Promise<ToolResult> {
        const t = await actionTarget(runtime, input["ref"]);
        if (t.kind === "err") return t.result;
        try {
          await t.page.click(t.selector);
          return ok(`Clicked ${String(input["ref"])} (${t.desc}).${await navigationNote(runtime, t.page, t.snapshot.url, true)}`);
        } catch (e) {
          // ω99-144: browser_see 同刷 ref 表（138 语义），降级文案并列路由。
          return err(`Click on ${String(input["ref"])} failed (${msg(e)}). If the page changed, run browser_see or browser_snapshot for fresh refs.`);
        }
      },
    },
    browserClickXy,
    {
      name: "browser_type",
      description:
        "Type text into a form field addressed by its snapshot ref (fills the field, replacing its content). With submit:true an Enter follows the text — the same confirmation posture as clicking a submit button. Refs come from the latest browser_snapshot and are voided by any navigation.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: 'Field ref from the latest browser_snapshot, e.g. "e2".' },
          text: { type: "string", description: "Text to type into the field (replaces current content)." },
          submit: { type: "boolean", description: "Press Enter after typing (submits the form). Default false." },
        },
        required: ["ref", "text"],
        additionalProperties: false,
      },
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      shouldDefer: () => false,
      isOpenWorld: () => true,
      async execute(input): Promise<ToolResult> {
        const text = input["text"];
        if (typeof text !== "string" || text === "") return err("text must be a non-empty string.");
        const submit = input["submit"] ?? false;
        if (typeof submit !== "boolean") return err("submit must be a boolean.");
        const t = await actionTarget(runtime, input["ref"]);
        if (t.kind === "err") return t.result;
        // ω99-114 fail-closed credential gate: a KNOWN password field never
        // receives model-typed text (an unknown type is not a password —
        // the gate refuses only on certain knowledge, never guesses).
        if (t.entry.type === "password") return err(PASSWORD_REFUSED(String(input["ref"])));
        try {
          await t.page.fill(t.selector, text);
          if (submit) await t.page.press("Enter");
          return ok(
            `Typed into ${String(input["ref"])} (${t.desc})${submit ? " and pressed Enter" : ""}.${await navigationNote(runtime, t.page, t.snapshot.url, submit)}`,
          );
        } catch (e) {
          // ω99-144: browser_see 同刷 ref 表（138 语义），降级文案并列路由。
          return err(`Typing into ${String(input["ref"])} failed (${msg(e)}). If the page changed, run browser_see or browser_snapshot for fresh refs.`);
        }
      },
    },
    // ω99-140: the type pair — browser_type_xy sits right after browser_type.
    browserTypeXy,
    {
      name: "browser_scroll",
      description:
        "Scroll the current page up or down by about one screen. Read-only; refs stay valid while the page does not navigate — take a fresh browser_snapshot to see newly revealed elements.",
      parameters: {
        type: "object",
        properties: { direction: { type: "string", description: '"down" (default direction of reading) or "up".' } },
        required: ["direction"],
        additionalProperties: false,
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => false,
      shouldDefer: () => false,
      isOpenWorld: () => true,
      async execute(input): Promise<ToolResult> {
        if (runtime.state() === "closed") return err(NOT_OPEN);
        const direction = input["direction"];
        if (direction !== "up" && direction !== "down") return err('direction must be "up" or "down".');
        try {
          const page = await runtime.openPage();
          const sign = direction === "down" ? "" : "-";
          await page.evaluate(`window.scrollBy(0, ${sign}window.innerHeight * 0.9)`);
          // ω99-144: browser_see 同刷 ref 表（138 语义），降级文案并列路由。
          return ok(`Scrolled ${direction} ~one screen. Refs stay valid while the page stays put; browser_see (or browser_snapshot) reveals newly visible elements.`);
        } catch (e) {
          return err(msg(e));
        }
      },
    },
    // ω99-141: the scroll pair — browser_scroll_xy sits right after
    // browser_scroll (page-level scroll keeps its lane; the coordinate face
    // reaches the containers under a point).
    browserScrollXy,
    // ω99-142: the download manifest closes the coordinate trio's export
    // flows — right after the trio, right before browser_close.
    browserDownloads,
    {
      name: "browser_close",
      description:
        "Close the browser window (idempotent). The browser also closes itself after 10 idle minutes, so orphaned windows do not linger.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      isReadOnly: () => true,
      isConcurrencySafe: () => false,
      shouldDefer: () => false,
      isOpenWorld: () => true,
      async execute(): Promise<ToolResult> {
        await runtime.close();
        return ok("Browser closed.");
      },
    },
  ];
}
