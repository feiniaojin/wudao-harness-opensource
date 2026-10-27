// ω99-46 — cli-side egress wiring tests: the `network` settings node loader
// (warn-not-fatal shapes) and the trust-gate ruling that keeps a
// project-tier `network` node from rerouting the operator's egress.
import { describe, expect, it } from "vitest";
import { isProjectForbiddenKey, sanitizeProjectTier } from "../src/settings-layer.js";
import { readEgressSettings } from "../src/egress-config.js";

describe("trust gate — `network` is global-tier only", () => {
  it("isProjectForbiddenKey covers network (same class as telemetry/slack)", () => {
    expect(isProjectForbiddenKey("network")).toBe(true);
  });

  it("a project-tier network node is dropped with a warning; ordinary nodes stay", () => {
    const gated = sanitizeProjectTier({
      network: { proxy: "http://attacker.example:8080" },
      longTask: { maxTurns: 40 },
    });
    expect(gated.record).toEqual({ longTask: { maxTurns: 40 } });
    expect(gated.dropped).toContain("network");
    expect(gated.warnings.some((w) => w.includes("network"))).toBe(true);
  });
});

describe("readEgressSettings — the network node loader", () => {
  it("absent node → undefined (env alone decides; nothing installs without env too)", () => {
    expect(readEgressSettings({}, () => {})).toBeUndefined();
    expect(readEgressSettings({ web: {} }, () => {})).toBeUndefined();
  });

  it("a full node reads proxy + proxyRoutes verbatim (validation is the policy layer's)", () => {
    const s = readEgressSettings(
      { network: { proxy: "socks5://127.0.0.1:10808", proxyRoutes: { "https://api.openai.com": "http://127.0.0.1:7890" } } },
      () => {},
    );
    expect(s).toEqual({
      proxy: "socks5://127.0.0.1:10808",
      proxyRoutes: { "https://api.openai.com": "http://127.0.0.1:7890" },
    });
  });

  it("wrong shapes warn and fall back per-field, never fatal", () => {
    const warnings: string[] = [];
    const s = readEgressSettings(
      { network: { proxy: 42, proxyRoutes: "nope", extra: 1 } },
      (w) => warnings.push(w),
    );
    // both fields dropped → an empty settings input (env alone decides)
    expect(s).toEqual({});
    expect(warnings.some((w) => w.includes("network.proxy must be"))).toBe(true);
    expect(warnings.some((w) => w.includes("proxyRoutes must be"))).toBe(true);
    expect(warnings.some((w) => w.includes("unknown network key"))).toBe(true);
  });

  it("a non-object network node warns and is ignored", () => {
    const warnings: string[] = [];
    expect(readEgressSettings({ network: "http://x:1" }, (w) => warnings.push(w))).toBeUndefined();
    expect(warnings.length).toBe(1);
  });
});
