// ω99-140 — the permission posture of browser_type_xy: the WHOLE tool class
// sits in DEFAULT_ASK_TOOLS (typing injects CONTENT — higher-stakes than
// clicking — and the miss layer cannot classify the target field at all, so
// every call surfaces on the human confirmation card; the hit layer asking
// too is the accepted over-strictness, no parameter split, 139 ruling
// verbatim). Rules keep their order: deny outranks the default-ask layer,
// an `a`/`p` allow recorded earlier pre-approves without repeat nagging,
// plan mode still denies.
import { describe, it, expect } from "vitest";
import { DEFAULT_ASK_TOOLS, isDefaultAskCall, decideRichPermission, PLAN_DENY_REASON } from "../src/permission.js";

describe("ω99-140 browser_type_xy — default-ask class (whole tool, no parameter split)", () => {
  it("isDefaultAskCall: ANY input asks — hit-shaped, miss-shaped, submit or not", () => {
    // the probe never inspects x/y/text/submit — the NAME decides (the miss
    // layer cannot classify the target, so the whole class asks).
    expect(isDefaultAskCall("browser_type_xy", { x: 200, y: 400, text: "q" })).toBe(true); // miss-shaped
    expect(isDefaultAskCall("browser_type_xy", { x: 80, y: 70, text: "q" })).toBe(true);  // hit-shaped
    expect(isDefaultAskCall("browser_type_xy", { x: 80, y: 70, text: "q", submit: true })).toBe(true);
    expect(isDefaultAskCall("browser_type_xy", { x: 80, y: 70, text: "q", submit: false })).toBe(true);
    expect(isDefaultAskCall("browser_type_xy", {})).toBe(true);
  });

  it("DEFAULT_ASK_TOOLS carries the three whole-tool names (zero drift on the first two)", () => {
    // ω99-212: the computer ACTION quartet (computer_type/key/click,
    // app_activate) joins the whole-tool class — physical input on the user's
    // machine asks by default like browser clicks; expected-set evolution,
    // nothing removed. The two read faces (screen_capture/app_list) stay out.
    // ω99-220 演进：computer_scroll / computer_drag 入列（滚轮动用户机器上的
    // 活动窗口、拖拽物理挪物——同 whole-tool-class 问姿）——同款集演进。
    expect(DEFAULT_ASK_TOOLS).toEqual(new Set([
      "browser_click", "browser_click_xy", "browser_type_xy",
      "computer_type", "computer_key", "computer_click", "app_activate",
      "computer_scroll", "computer_drag",
    ]));
  });

  it("decideRichPermission: no rule → ask on the confirmation card (workspace; auto follows the tier — ω99-226 裁定)", () => {
    // ω99-226 产品裁定（非回归）：auto 档放行（sidecar 照审）；workspace 照问。
    expect(decideRichPermission({ mode: "auto", toolName: "browser_type_xy", input: { x: 100, y: 100, text: "你好 world" } })).toEqual({ behavior: "allow" });
    expect(decideRichPermission({ mode: "workspace", toolName: "browser_type_xy", input: { x: 100, y: 100, text: "你好 world" } })).toBe("ask");
  });

  it("an always/session rule pre-approves (rules run FIRST — no repeat nagging)", () => {
    expect(decideRichPermission({ mode: "auto", toolName: "browser_type_xy", input: { x: 100, y: 100, text: "q" }, session: ["browser_type_xy"] })).toEqual({ behavior: "allow" });
    expect(decideRichPermission({ mode: "auto", toolName: "browser_type_xy", input: { x: 100, y: 100, text: "q" }, settings: { allow: ["browser_type_xy"], deny: [], ask: [], sidecarExempt: [] } })).toEqual({ behavior: "allow" });
  });

  it("a settings deny rule outranks the default-ask layer", () => {
    expect(decideRichPermission({ mode: "auto", toolName: "browser_type_xy", input: { x: 100, y: 100, text: "q" }, settings: { deny: ["browser_type_xy"], allow: [], ask: [], sidecarExempt: [] } })).toEqual({ behavior: "deny", reason: 'settings deny rule "browser_type_xy"' });
  });

  it("plan mode still denies outright (the read-only fence is untouched)", () => {
    expect(decideRichPermission({ mode: "plan", toolName: "browser_type_xy", input: { x: 100, y: 100, text: "q" } })).toEqual({ behavior: "deny", reason: PLAN_DENY_REASON });
  });
});
