// M60 — slack settings: tolerant parse, defaults, two-tier load, token env
// resolution by NAME (never a value in settings).
import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { DEFAULT_SLACK_SETTINGS, parseSlackSettings, loadSlackSettings, resolveToken } from "../src/settings.js";

describe("parseSlackSettings", () => {
  it("absent value → defaults (disabled)", () => {
    expect(parseSlackSettings(undefined)).toEqual(DEFAULT_SLACK_SETTINGS);
  });

  it("non-object → defaults + warning", () => {
    const warnings: string[] = [];
    const s = parseSlackSettings("nope", (m) => warnings.push(m));
    expect(s.enabled).toBe(false);
    expect(warnings.length).toBe(1);
  });

  it("full node parses with the spec defaults preserved", () => {
    const s = parseSlackSettings({
      enabled: true,
      appTokenEnv: "MY_APP",
      botTokenEnv: "MY_BOT",
      allowedChannels: ["C1", "C2"],
      allowedUsers: ["U1"],
      defaultPermissionMode: "ask",
      threadContextMaxChars: 8000,
      askTimeoutMs: 300000,
    });
    expect(s).toEqual({
      enabled: true,
      appTokenEnv: "MY_APP",
      botTokenEnv: "MY_BOT",
      allowedChannels: ["C1", "C2"],
      allowedUsers: ["U1"],
      defaultPermissionMode: "ask", // the 0.3.12 trio passes through verbatim
      threadContextMaxChars: 8000,
      askTimeoutMs: 300000,
    });
  });

  it("typed lists drop with a warning; bad ints fall back; bad mode warns and uses ask", () => {
    const warnings: string[] = [];
    const s = parseSlackSettings(
      { allowedChannels: "C1", allowedUsers: [1], threadContextMaxChars: -5, askTimeoutMs: "soon", defaultPermissionMode: "yolo" },
      (m) => warnings.push(m),
    );
    expect(s.allowedChannels).toEqual([]);
    expect(s.allowedUsers).toEqual([]);
    expect(s.threadContextMaxChars).toBe(8000);
    expect(s.askTimeoutMs).toBe(300000);
    expect(s.defaultPermissionMode).toBe("ask"); // junk fails toward the safe remote tier
    expect(warnings.some((w) => w.includes("allowedChannels"))).toBe(true);
    expect(warnings.some((w) => w.includes("allowedUsers"))).toBe(true);
    expect(warnings.some((w) => w.includes("defaultPermissionMode"))).toBe(true);
  });
  it("legacy mode spellings migrate on read: acceptEdits→workspace, default→ask; read-only retires", () => {
    const warnings: string[] = [];
    const legacy = parseSlackSettings(
      { defaultPermissionMode: "acceptEdits" },
      (m) => warnings.push(m),
    );
    expect(legacy.defaultPermissionMode).toBe("workspace");
    expect(parseSlackSettings({ defaultPermissionMode: "default" }).defaultPermissionMode).toBe("ask");
    // the retired read-only lands on the safe remote tier with a warning
    const retired = parseSlackSettings({ defaultPermissionMode: "read-only" }, (m) => warnings.push(m));
    expect(retired.defaultPermissionMode).toBe("ask");
    expect(warnings.some((w) => w.includes("pre-0.3.12 spelling"))).toBe(true);
    expect(warnings.some((w) => w.includes("read-only"))).toBe(true);
  });
  it("plan joins the accepted set (0.3.14 read-only 探查 tier, remote-configurable)", () => {
    const warnings: string[] = [];
    const s = parseSlackSettings({ defaultPermissionMode: "plan" }, (m) => warnings.push(m));
    expect(s.defaultPermissionMode).toBe("plan");
    expect(warnings).toEqual([]); // a current-tier value is not a migration/warning case
  });
});

describe("loadSlackSettings (two-tier)", () => {
  it("global tier supplies the config; the project tier's slack node is TRUST-GATED (F3)", async () => {
    const root = mkdtempSync(join(tmpdir(), "wudao-slack-settings-"));
    const global = mkdtempSync(join(tmpdir(), "wudao-slack-global-"));
    await mkdir(join(global), { recursive: true });
    await writeFile(
      join(global, "settings.json"),
      JSON.stringify({ slack: { enabled: true, allowedUsers: ["U_G"], allowedChannels: ["C_G"] } }),
      "utf8",
    );
    await mkdir(join(root, ".wudao"), { recursive: true });
    // A cloned repo cannot switch the operator's daemon on nor widen the
    // allowlists: the whole project-tier `slack` key drops with the standard
    // escalation warning naming the key.
    await writeFile(
      join(root, ".wudao", "settings.json"),
      JSON.stringify({ slack: { enabled: true, allowedUsers: ["U_ATTACKER"], allowedChannels: ["C_PUBLIC"] } }),
      "utf8",
    );
    const warnings: string[] = [];
    const s = await loadSlackSettings(root, (m) => warnings.push(m), { WUDAO_GLOBAL_HOME: global });
    expect(warnings.some((w) => w.includes('"slack" 是提权键'))).toBe(true); // ω99-183: 钉随源演进
    expect(s.enabled).toBe(true);
    expect(s.allowedUsers).toEqual(["U_G"]); // the attacker's list never landed
    expect(s.allowedChannels).toEqual(["C_G"]);
  });

  it("no global tier + project-only slack → disabled defaults (the drop is silent-tier: absent)", async () => {
    const root = mkdtempSync(join(tmpdir(), "wudao-slack-settings-"));
    const global = mkdtempSync(join(tmpdir(), "wudao-slack-global-empty-"));
    await mkdir(join(root, ".wudao"), { recursive: true });
    await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({ slack: { enabled: true } }), "utf8");
    const warnings: string[] = [];
    const s = await loadSlackSettings(root, (m) => warnings.push(m), { WUDAO_GLOBAL_HOME: global });
    expect(s.enabled).toBe(false);
    expect(warnings.some((w) => w.includes("slack"))).toBe(true);
  });
});

describe("resolveToken", () => {
  it("reads by env-var NAME; blank/absent → undefined", () => {
    expect(resolveToken("APP", { APP: "xapp-123" })).toBe("xapp-123");
    expect(resolveToken("APP", { APP: "  " })).toBeUndefined();
    expect(resolveToken("APP", {})).toBeUndefined();
  });
});
