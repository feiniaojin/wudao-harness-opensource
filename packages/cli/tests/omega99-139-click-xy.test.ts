// ω99-139 — the permission posture of browser_click_xy: the WHOLE tool class
// sits in DEFAULT_ASK_TOOLS (the fallback layer — canvas / an unrecognized
// target — must always surface on the human confirmation card; the hit layer
// asking too is the accepted over-strictness, no parameter split). Rules keep
// their order: deny outranks the default-ask layer, an `a`/`p` allow recorded
// earlier pre-approves without repeat nagging, plan mode still denies.
import { describe, it, expect } from "vitest";
import { DEFAULT_ASK_TOOLS, isDefaultAskCall, decideRichPermission, PLAN_DENY_REASON } from "../src/permission.js";

describe("ω99-139 browser_click_xy — default-ask class (whole tool, no parameter split)", () => {
  it("isDefaultAskCall: BOTH layers ask — hit-shaped and miss-shaped inputs alike", () => {
    // miss-shaped (canvas coordinates, no ref could hit) and hit-shaped (a
    // point inside a bbox): the probe never inspects x/y — the NAME decides.
    expect(isDefaultAskCall("browser_click_xy", { x: 200, y: 400 })).toBe(true);
    expect(isDefaultAskCall("browser_click_xy", { x: 80, y: 70 })).toBe(true);
    expect(isDefaultAskCall("browser_click_xy", {})).toBe(true);
  });

  it("DEFAULT_ASK_TOOLS carries browser_click_xy alongside browser_click", () => {
    expect(DEFAULT_ASK_TOOLS.has("browser_click_xy")).toBe(true);
    expect(DEFAULT_ASK_TOOLS.has("browser_click")).toBe(true); // 112 zero drift
  });

  it("decideRichPermission: no rule → ask on the confirmation card (workspace; auto follows the tier — ω99-226 裁定)", () => {
    // ω99-226 产品裁定（非回归）：auto 档放行（sidecar 照审）；workspace 照问。
    expect(decideRichPermission({ mode: "auto", toolName: "browser_click_xy", input: { x: 680, y: 110 } })).toEqual({ behavior: "allow" });
    expect(decideRichPermission({ mode: "workspace", toolName: "browser_click_xy", input: { x: 680, y: 110 } })).toBe("ask");
  });

  it("an always/session rule pre-approves (rules run FIRST — no repeat nagging)", () => {
    expect(decideRichPermission({ mode: "auto", toolName: "browser_click_xy", input: { x: 680, y: 110 }, session: ["browser_click_xy"] })).toEqual({ behavior: "allow" });
    expect(decideRichPermission({ mode: "auto", toolName: "browser_click_xy", input: { x: 680, y: 110 }, settings: { allow: ["browser_click_xy"], deny: [], ask: [], sidecarExempt: [] } })).toEqual({ behavior: "allow" });
  });

  it("a settings deny rule outranks the default-ask layer", () => {
    expect(decideRichPermission({ mode: "auto", toolName: "browser_click_xy", input: { x: 680, y: 110 }, settings: { deny: ["browser_click_xy"], allow: [], ask: [], sidecarExempt: [] } })).toEqual({ behavior: "deny", reason: 'settings deny rule "browser_click_xy"' });
  });

  it("plan mode still denies outright (the read-only fence is untouched)", () => {
    expect(decideRichPermission({ mode: "plan", toolName: "browser_click_xy", input: { x: 680, y: 110 } })).toEqual({ behavior: "deny", reason: PLAN_DENY_REASON });
  });
});
