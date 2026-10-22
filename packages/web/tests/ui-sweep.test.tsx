// @vitest-environment jsdom
// ui-sweep (2026-08-25 task brief) — UI-2's two lanes, pinned:
//   B. the UI-1 defer cleanup, each with a DISCRIMINATIVE assertion:
//      N2 — hover never eats the composer chip's selected state;
//      N3 — the ctx menu's left clamp closes the loop on the menu's own
//           WIDTH var (a wide menu flush to the right edge stays < 100vw);
//      M4 — the retired composer-radius whitelist entry is gone from the
//           tokens-conformance gate AND its anchor declaration is gone from
//           the sheet (one-way enforcement).
//   A. the settings/simple-surface token sweep lives in the second half of
//      this file (same seams: the mounted sheet for CSSOM decl() pins, the
//      raw text for source-level audits).
import { afterEach, describe, expect, it } from "vitest";
import { readStyles } from "./styles-source.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import "../src/styles.css";
import "../src/tokens.css";
import { App } from "../src/components/App.js";
import { WudaoClient } from "../src/protocol.js";
import { fakeServer, authOk } from "./mock-ws.js";
import type { FakeServer } from "./mock-ws.js";
import { decl, mount, unmount } from "./css-test-utils.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  unmount();
  window.localStorage.removeItem("wudao.ui.v1");
});

/** The full App on a fake socket (ui-parity's harness). */
function mountedApp(): { container: HTMLElement; server: FakeServer } {
  const server = fakeServer();
  const client = new WudaoClient({
    url: "ws://127.0.0.1:1",
    token: "t",
    wsFactory: () => server.spawn(),
    reconnect: false,
  });
  const container = mount(<App client={client} />);
  act(() => {
    client.connect();
    server.socket.serverOpen();
  });
  return { container, server };
}

/** Answer the settingsStatus fetch with a persisted default ui mode. */
async function replySettings(
  h: { server: FakeServer },
  uiDefaultMode: "simple" | "buddy" | "advanced" | null,
): Promise<void> {
  await act(async () => {
    const op = h.server.clientFrames().find((f): f is { id: number; op: { op: string } } =>
      typeof f === "object" && f !== null && "op" in f && (f as { op: { op: string } }).op.op === "settingsStatus");
    h.server.socket.serverSend({
      t: "result",
      id: op?.id,
      ok: { settings: { memoryEnabled: true, uiDefaultMode } },
    });
  });
}

/** The raw sheet — source-level audits (selector shapes the CSSOM keeps).
 *  fileURLToPath, not the file:// string strip (win32 doubles the drive). */
const STYLES_CSS = readStyles();

/** A custom property declared on the FIRST rule whose selector contains
 *  `selector` — the decl() seam's twin for --custom-props. */
function customProp(selector: string, name: string): string {
  for (const sheet of [...document.styleSheets] as CSSStyleSheet[]) {
    for (const rule of [...sheet.cssRules]) {
      if (rule instanceof CSSStyleRule && rule.selectorText.includes(selector)) {
        const v = rule.style.getPropertyValue(name);
        if (v !== "") return v.trim();
      }
    }
  }
  throw new Error(`no rule matching ${selector} declares ${name}`);
}

// ---------------------------------------------------------------------------
// B / N2 — hover never eats the selected composer chip.
// ---------------------------------------------------------------------------
describe("ui-sweep B/N2 — hover excludes the selected state (.on/.sel)", () => {
  it("the scoped hover rule carries the exclusion — (0,4,0) can no longer repaint a selected chip", () => {
    // The defer: `.composer .chip:hover:not(:disabled)` (0,4,0) sat AFTER and
    // OUTRANKED the scoped selected rule (0,3,0), so a hovered selected chip
    // flashed to the neutral surface-2 band. The fix is the EXCLUSION (not a
    // selected-specificity bump): hover is the affordance of the UNSELECTED
    // chip; the selected chip's accent-weak fill + accent border is its own,
    // stronger feedback. Pinned at the selector level because jsdom cannot
    // compute :hover — with the exclusion, a hovered .sel chip matches ONLY
    // the selected rule, so the accent-weak pins below are the cascade's
    // outcome by construction.
    expect(STYLES_CSS).toMatch(
      /\.composer \.chip:hover:not\(:disabled\):not\(\.on\):not\(\.sel\)\s*\{[^}]*background:\s*var\(--surface-2\)/s,
    );
  });

  it("an UNSELECTED composer chip still gets its hover band (the affordance survives the fix)", () => {
    expect(decl(".composer .chip:hover:not(:disabled):not(.on):not(.sel)", "background")).toBe("var(--surface-2)");
    expect(decl(".composer .chip:hover:not(:disabled):not(.on):not(.sel)", "border-color")).toBe("transparent");
  });

  it("the selected chip keeps its NEUTRAL fill + hairline edge (what hover must not eat; 116 弧 A)", () => {
    expect(decl(".composer .chip.sel", "background")).toBe("var(--surface-2)");
    expect(decl(".composer .chip.sel", "border-color")).toBe("var(--hair-2)");
    expect(decl(".composer .chip.on", "background")).toBe("var(--surface-2)");
  });

  it("the GLOBAL chip hover excludes .on/.sel too — the same bug class, killed at the root", () => {
    // The global hover (0,3,0) vs the global selected (0,2,0) had the same
    // race on border-color/color; the settings pickers only survived via
    // later equal-specificity overrides. The exclusion removes the race
    // instead of papering over it per-surface.
    expect(STYLES_CSS).toMatch(
      /^\.chip:hover:not\(:disabled\):not\(\.on\):not\(\.sel\)\s*\{[^}]*border-color:\s*var\(--hair-2\)/m,
    );
  });
});

// ---------------------------------------------------------------------------
// B / N3 — the ctx menu's left clamp closes on the menu's own width.
// ---------------------------------------------------------------------------
describe("ui-sweep B/N3 — the ctx menu width is pinned and shared with the left clamp", () => {
  it("min-width = max-width = --ctx-w: the menu's width is a constant, not content-driven", () => {
    expect(decl(".menu.ctx", "min-width")).toBe("var(--ctx-w)");
    expect(decl(".menu.ctx", "max-width")).toBe("var(--ctx-w)");
    expect(customProp(".menu.ctx", "--ctx-w")).toBe("224px");
  });

  it("the left clamp subtracts the SAME var the width pins ride (the closed loop)", () => {
    // The defer: the left axis borrowed the HEIGHT cap (--ctx-cap: 180px) as
    // a width proxy, so a menu wider than 196px overshoot 100vw at the
    // clamped left. Now width is pinned to --ctx-w AND the clamp subtracts
    // --ctx-w: right edge = left + 224px ≤ (100vw - 224 - 16) + 224 < 100vw
    // — a menu opened flush at the right edge can no longer poke out,
    // whatever its labels (overlong rows ellipsize per button.menu-item).
    expect(decl(".menu.ctx", "left")).toBe("min(var(--ctx-x, 0px), calc(100vw - var(--ctx-w) - var(--sp-4)))");
    // The clamp and the width pins literally share the one var — nothing
    // between them can re-open the loop.
    const w = customProp(".menu.ctx", "--ctx-w");
    expect(decl(".menu.ctx", "left")).toContain(`calc(100vw - var(--ctx-w)`);
    expect(w).toBe("224px");
  });

  it("the height axis keeps its own cap (--ctx-cap still owns top + max-height)", () => {
    expect(decl(".menu.ctx", "top")).toBe("min(var(--ctx-y, 0px), calc(100dvh - var(--ctx-cap) - var(--sp-4)))");
    expect(decl(".menu.ctx", "max-height")).toBe("var(--ctx-cap)");
  });

  it("--ctx-w matches the mockup pop-menu's 224px — the two floating menus agree", () => {
    expect(decl(".pop .menu", "min-width")).toBe("224px");
  });
});

// ---------------------------------------------------------------------------
// B / M4 — the retired composer-radius whitelist is gone (one-way cleanup).
// ---------------------------------------------------------------------------
describe("ui-sweep B/M4 — the dead tokens-conformance whitelist entry is retired", () => {
  it("the whitelist's anchor declaration no longer exists in the sheet", () => {
    // The exempted `padding: var(--sp-1) … calc(var(--sp-2) + 6px)` was the
    // 墨线 14px composer's radius-alignment inset — retired by UI-1's
    // --radius-pill rework. Nothing in styles.css matches it anymore.
    expect(STYLES_CSS).not.toContain("calc(var(--sp-2) + 6px)");
  });

  it("the gate's spacing whitelist now holds ONLY the two living optical exceptions", () => {
    // The machinery's own regression (tokens-conformance.test.ts, ui-sweep
    // M4 block) proves the removal is one-way: the retired idiom now FLAGS.
    // Here we pin the whitelist inventory itself — exactly two `continue`
    // exemptions survive (bubble 10px/14px, inline-code 1px/5px).
    const gate = readFileSync(
      join(fileURLToPath(import.meta.url), "../tokens-conformance.test.ts"),
      "utf8",
    );
    const exemptions = [...gate.matchAll(/^\s*if \(\/\^padding:[^\n]*\.test\(d\)\) continue;\s*$/gm)];
    expect(exemptions).toHaveLength(2);
    expect(gate).toMatch(/padding:\\s\*10px 14px/);
    expect(gate).toMatch(/padding:\\s\*1px 5px/);
  });
});

// ---------------------------------------------------------------------------
// A — the settings-domain token sweep (卡片半径/边线/底色、chip、表单控件).
// ---------------------------------------------------------------------------
describe("ui-sweep A — settings cards join the conversation card language", () => {
  it("master/detail cards: --radius-md + --surface fill over the page --bg", () => {
    for (const sel of [".provider-card", ".provider-detail", ".persona-row"]) {
      expect(decl(sel, "border-radius")).toBe("var(--radius-md)");
      expect(decl(sel, "background")).toBe("var(--surface)");
    }
  });

  it("the plugin tab's cards ride the same chrome", () => {
    for (const sel of [".market-row", ".plugin-entry", ".installed-row"]) {
      expect(decl(sel, "border-radius")).toBe("var(--radius-md)");
      expect(decl(sel, "background")).toBe("var(--surface)");
    }
  });

  it("the wizard's provider card: radius token, --bg recess fill on purpose (inside the surface .wiz)", () => {
    expect(decl(".wizard-provider-card", "border-radius")).toBe("var(--radius-md)");
    expect(decl(".wizard-provider-card", "background")).toBe("var(--bg)");
  });

  it("menus + floating pops: radius-lg everywhere (119: the float family tier)", () => {
    // 119 用户反馈修正（圆角统一）：浮层族（菜单/弹窗/toast/面板）统一归
    // lg 12——旧 md 档把浮层与卡片混在同档，是「不统一」感的成分队列。
    expect(decl(".slashmenu", "border-radius")).toBe("var(--radius-lg)");
    // .ws-menu/.ws-open-other were un-scoped from .filetree (composer chip
    // menus share the visuals) — the global rules carry the same family tier.
    expect(decl(".ws-menu", "border-radius")).toBe("var(--radius-lg)");
    expect(decl(".ws-open-other", "border-radius")).toBe("0 0 var(--radius-lg) var(--radius-lg)");
    expect(decl(".search-pop", "border-radius")).toBe("var(--radius-lg)");
  });

  it("row-chips and controls: radius-sm (the .ctl/.chip tier)", () => {
    // ω99-302: .statusline .seg-btn / .effort-chip left the census — both
    // rules retired by the dead-rule sweep (no renderer since M14 / 0.3.26 ①).
    for (const sel of ["button.wudao", ".optioncard", ".pickrow", ".model-chip"]) {
      expect(decl(sel, "border-radius")).toBe("var(--radius-sm)");
    }
  });

  it("the modal-card family radius; .planboard joins the conversation cards", () => {
    // ω99-302: the pin's old ".modal" selector stopped existing in ω99-301 —
    // decl()'s substring match kept it green against ".modal-card". Say what
    // we pin.
    expect(decl(".modal-card", "border-radius")).toBe("var(--radius-lg)");
    expect(decl(".planboard", "border-radius")).toBe("var(--radius-md)");
  });

  it("the shared mono cmd block's 8px is tokenized", () => {
    expect(decl(".approval .cmd", "border-radius")).toBe("var(--radius-md)");
    expect(decl(".permission-card .cmd", "border-radius")).toBe("var(--radius-md)");
  });

  it("the market-source input finally gets the .ctl box (hairline border + radius + surface + text-1)", () => {
    expect(decl(".market-source-input", "border-color")).toBe("var(--hair-1)");
    expect(decl(".market-source-input", "border-radius")).toBe("var(--radius-sm)");
    expect(decl(".market-source-input", "background")).toBe("var(--surface)");
    expect(decl(".market-source-input", "color")).toBe("var(--text-1)");
  });

  it("floating pops carry the elevation trio's mid tier (116 弧 A: stroke-in-shadow, border retired)", () => {
    // The family base .menu owns the float chrome now (border:0 + --elev-2);
    // every floating member (pop menus, the ctx menu, ws-menu) rides it.
    expect(decl(".menu", "box-shadow")).toBe("var(--elev-2)");
    expect(decl(".menu", "border")).toBe("0");
    expect(decl(".pop .menu", "background")).toBe("var(--surface)");
    expect(decl(".ws-menu", "box-shadow")).toBe("var(--elev-2)");
    expect(decl(".ws-menu", "border")).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// A — the simple/buddy topbar economy (mockup-space-v3: 顶栏只留必要钮).
// ---------------------------------------------------------------------------
describe("ui-sweep A — topbar economy per shell", () => {
  const CTX = { used: 27000, window: 64000, nearLimit: false };

  it("simple: the run badge is GONE (advanced telemetry); +/📋/◐/⚙ stay — the shell's only access", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, { ctxTokens: CTX });
    });
    await replySettings(h, "simple");
    expect(h.container.querySelector("[data-mode='simple']")).not.toBeNull();
    expect(h.container.querySelector(".tb-run")).toBeNull();
    // 必要钮: no sidebar → the topbar is the only home for new-chat/sessions.
    expect(h.container.querySelector(".topbar .new-chat")).not.toBeNull();
    expect(h.container.querySelector(".topbar .sessions")).not.toBeNull();
    expect(h.container.querySelector('.topbar button[aria-label="切换主题"]')).not.toBeNull();
    expect(h.container.querySelector('.topbar button[aria-label="设置"]')).not.toBeNull();
  });

  it("buddy: + and 📋 leave the topbar (the sidebar owns them); ◐/⚙ stay; the sidebar renders", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, { ctxTokens: CTX });
    });
    await replySettings(h, "buddy");
    expect(h.container.querySelector(".buddy")).not.toBeNull();
    expect(h.container.querySelector(".topbar .new-chat")).toBeNull();
    expect(h.container.querySelector(".topbar .sessions")).toBeNull();
    expect(h.container.querySelector('.topbar button[aria-label="切换主题"]')).not.toBeNull();
    expect(h.container.querySelector('.topbar button[aria-label="设置"]')).not.toBeNull();
    // The functions did not leave the shell — the sidebar owns them now.
    expect(h.container.querySelector(".sb-new")).not.toBeNull();
    expect(h.container.querySelector(".sb")).not.toBeNull();
    // Buddy is a power surface: the run badge STAYS (the statusline's twin).
    expect(h.container.querySelector(".tb-run")).not.toBeNull();
  });

  it("advanced is unchanged: 4 icobtns + the badge when ctx exists", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, { ctxTokens: CTX });
    });
    await replySettings(h, "advanced");
    expect(h.container.querySelectorAll(".topbar button.icobtn")).toHaveLength(5);
    expect(h.container.querySelector(".tb-run")).not.toBeNull();
    expect(h.container.textContent).toContain("ctx");
  });
});
