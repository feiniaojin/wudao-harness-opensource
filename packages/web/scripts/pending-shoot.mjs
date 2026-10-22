// pending-shoot.mjs — the UI-3 (ui-pending) / UI-4 (ui-motion) screenshot
// driver (headless Chrome via playwright-core, riding the pending-mock.mjs
// ws harness). UI-4 LOW-2 vendored it into the repo from the /tmp harness so
// the caret ASSERTS are durable and reviewable; the mock server itself stays
// a /tmp-session artifact.
//
// Asserts (exit 1 on failure — the LOW-2 contract):
//   - with a live-answer on screen the ▌ caret MUST be in place
//   - the finished read card's tail carries the mocked durationMs (C10)
//   - after an ask parks and clears mid-turn, the statusline busy segment
//     must reappear with the CUMULATIVE seconds (LOW-1), not restart
//
// Usage: node packages/web/scripts/pending-shoot.mjs [outDir]
//   outDir   shot output dir (default $UI_SHOTS_OUT or /tmp/ui-shots)
//   Chrome   $PENDING_SHOOT_CHROME (default the macOS Chrome.app path)
// Prerequisites (not vendored — no new dependencies by design):
//   1. playwright-core must be resolvable. This file resolves it through
//      createRequire, so either run it from a directory whose node_modules
//      has playwright-core, or point NODE_PATH at one:
//      NODE_PATH=/tmp/ui-shots/sweep/node_modules node …/pending-shoot.mjs
//   2. four pending-mock.mjs instances serving the built dist:
//      8801 simple/tools · 8802 advanced/tools · 8803 advanced/think ·
//      8804 advanced/askrel (the ask→release scripted variant)
import { createRequire } from "node:module";

const OUT = process.argv[2] ?? process.env.UI_SHOTS_OUT ?? "/tmp/ui-shots";
const BASE_SIMPLE_TOOLS = "http://127.0.0.1:8801/#devtoken";
const BASE_ADV_TOOLS = "http://127.0.0.1:8802/#devtoken";
const BASE_ADV_THINK = "http://127.0.0.1:8803/#devtoken";
const BASE_ADV_ASKREL = "http://127.0.0.1:8804/#devtoken";
const CHROME = process.env.PENDING_SHOOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// createResolve honors NODE_PATH (the bare ESM import does not), so the
// driver runs without adding playwright-core to packages/web's deps.
const req = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = req("playwright-core"));
} catch {
  console.error(
    "pending-shoot.mjs: playwright-core is not resolvable from here.\n" +
      "Run from a directory whose node_modules has it, or set NODE_PATH to one,\n" +
      "e.g. NODE_PATH=/tmp/ui-shots/sweep/node_modules node packages/web/scripts/pending-shoot.mjs",
  );
  process.exit(2);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
let failed = 0;
const fail = (where, why) => {
  console.error(`FAIL ${where}: ${why}`);
  failed += 1;
};

async function pageFor(theme, base) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 160)));
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 15000 });
  // The busy segment's clock ticks at a 1s throttle — give it room, then
  // some: the shot should read `▌… · Ns`.
  await page.waitForTimeout(1800);
  // LIGHT rides the real user path (the settingsStatus's uiTheme:null force-
  // applies factory dark at boot): the ◐ toggle, optimistic + persisted.
  if (theme === "light") {
    await page.click('.topbar button[aria-label="切换主题"]');
    await page.waitForTimeout(400);
  }
  return { ctx, page };
}

/** UI-4 LOW-2: with a live-answer on screen the ▌ caret MUST be in place. */
async function assertCaret(page, where) {
  const answer = await page.$(".turnlive .live-answer");
  if (answer === null) return; // no streaming answer: the caret is not owed
  const caret = await page.$(".turnlive .live-answer .caret");
  if (caret === null) {
    fail(where, "live-answer present but the ▌ caret is MISSING");
    return;
  }
  const text = await caret.textContent();
  if (text !== "▌") fail(where, `caret present but renders ${JSON.stringify(text)}`);
  else console.log(`  ${where}: caret ✓`);
}

for (const theme of ["dark", "light"]) {
  {
    const { ctx, page } = await pageFor(theme, BASE_SIMPLE_TOOLS);
    await page.waitForSelector(".turnlive .act[data-status='run']", { timeout: 4000 });
    const seg = await page.$(".statusline .seg-busy");
    console.log(`  simple(${theme}): statusline seg (expected none — simple drops the bar):`, seg ? "PRESENT?!" : "absent");
    await assertCaret(page, `simple(${theme})`);
    // UI-4 C10: the finished read card's tail carries the mocked duration.
    const tails = await page.$$eval(".act[data-kind='read'] .act-tail", (els) => els.map((e) => e.textContent));
    console.log(`  simple(${theme}): read-card tails (C10):`, JSON.stringify(tails));
    if (!tails.some((t) => t === "· 1.2s")) fail(`simple(${theme})`, `C10 tail missing (got ${JSON.stringify(tails)})`);
    await page.screenshot({ path: `${OUT}/ui-pending-simple-busy-${theme}.png` });
    await ctx.close();
  }
  {
    const { ctx, page } = await pageFor(theme, BASE_ADV_TOOLS);
    const seg = await page.$(".statusline .seg-busy");
    console.log(`  advanced tools(${theme}): busy seg:`, seg ? await seg.textContent() : "MISSING");
    await assertCaret(page, `advanced tools(${theme})`);
    await page.screenshot({ path: `${OUT}/ui-pending-advanced-busy-${theme}.png` });
    await ctx.close();
  }
  {
    const { ctx, page } = await pageFor(theme, BASE_ADV_THINK);
    const seg = await page.$(".statusline .seg-busy");
    console.log(`  advanced think(${theme}): busy seg:`, seg ? await seg.textContent() : "MISSING");
    await page.screenshot({ path: `${OUT}/ui-pending-advanced-thinking-${theme}.png` });
    await ctx.close();
  }
}

// UI-4 LOW-1 — the ask→release discrimination, live: the mock parks the ask
// at t+1.5s and clears it at t+7s. During the ask the segment must be GONE;
// after the clear it must read the WHOLE turn's seconds (≥6 — the mock's
// clock starts ≈0.3s after its timers), proving the ask never restarted the
// clock (a restart would read 0-1s).
{
  const { ctx, page } = await pageFor("dark", BASE_ADV_ASKREL);
  await page.waitForSelector(".permission-card", { timeout: 6000 }); // the ask parked
  const duringAsk = await page.$(".statusline .seg-busy");
  if (duringAsk !== null) fail("askrel(dark)", "the busy segment must be hidden while the ask parks");
  else console.log("  askrel(dark): seg hidden during the ask ✓");
  await page.waitForSelector(".statusline .seg-busy", { timeout: 8000 }); // released
  const segEl = await page.$(".statusline .seg-busy");
  const text = segEl === null ? null : await segEl.textContent();
  console.log("  askrel(dark): released busy seg:", text);
  const secs = text === null ? -1 : Number(/·\s*(\d+)s/.exec(text)?.[1] ?? -1);
  if (segEl === null) fail("askrel(dark)", "the busy segment never returned after the ask cleared");
  else if (!(secs >= 6)) fail("askrel(dark)", `cumulative clock broken — got ${JSON.stringify(text)} (<6s; a restart would read 0-2s)`);
  else console.log(`  askrel(dark): cumulative clock ✓ (${secs}s across the ask, not from zero)`);
  await assertCaret(page, "askrel(dark)"); // think variant: no live-answer → not owed, assert skips
  await page.screenshot({ path: `${OUT}/ui4-askrel-dark.png` });
  await ctx.close();
}

await browser.close();
if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("done — all asserts green");
