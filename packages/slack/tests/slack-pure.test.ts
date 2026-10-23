// M60 — the Slack channel's pure event normalization + the interactive-tool
// refusal + the doctor's offline checks.
import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { normalizeSlackEvent, stripMentions, isMentioned, formatThreadReplies, type SlackEventShape } from "../src/slack-channel.js";
import { disableInteractiveTools, createSlackRefusalAskUserTool, SLACK_ASK_USER_REFUSAL, INTERACTIVE_TOOL_NAMES } from "../src/tools.js";
import { runSlackDoctor, formatSlackDoctorReport, tokenClass } from "../src/doctor.js";
import { DEFAULT_SLACK_SETTINGS } from "../src/settings.js";
import type { Tool } from "@wudao/core";

describe("normalizeSlackEvent", () => {
  it("keeps human text messages, stripping mention tokens", () => {
    const m = normalizeSlackEvent({ text: "<@UBOT> please fix it", user: "U1", channel: "C1", ts: "1.0" }, "UBOT");
    expect(m).toEqual({ userId: "U1", channel: "C1", ts: "1.0", text: "please fix it", mentioned: true });
  });
  it("a thread reply keeps its thread_ts and needs no mention", () => {
    const m = normalizeSlackEvent({ text: "and also", user: "U1", channel: "C1", ts: "2.0", thread_ts: "1.0" }, "UBOT");
    expect(m?.threadTs).toBe("1.0");
    expect(m?.mentioned).toBe(false);
  });
  it("drops subtypes, bots, and empty payloads", () => {
    expect(normalizeSlackEvent({ subtype: "message_changed", text: "x", user: "U1", channel: "C1", ts: "1" }, undefined)).toBeNull();
    expect(normalizeSlackEvent({ text: "x", user: "U1", channel: "C1", ts: "1", bot_id: "B1" }, undefined)).toBeNull();
    expect(normalizeSlackEvent({ text: "   ", user: "U1", channel: "C1", ts: "1" }, undefined)).toBeNull();
    expect(normalizeSlackEvent({ channel: "C1" }, undefined)).toBeNull();
  });
  it("mention detection + stripping", () => {
    expect(isMentioned("<@UBOT> hi", "UBOT")).toBe(true);
    expect(isMentioned("hi", "UBOT")).toBe(false);
    expect(isMentioned("hi", undefined)).toBe(false);
    expect(stripMentions("<@UBOT>  hi <@U2>")).toBe("hi");
  });
});

describe("formatThreadReplies", () => {
  it("digests user lines, drops bot/empty/subtype entries, keeps mention-only text as stripped", () => {
    const replies: SlackEventShape[] = [
      { text: "<@UBOT> start", user: "U1", ts: "1" },
      { text: "", user: "U2", ts: "2" },
      { text: "bot says", user: "U9", ts: "3", bot_id: "B1" },
      { text: "real answer", user: "U2", ts: "4" },
      { text: "edited away", user: "U3", ts: "5", subtype: "message_changed" },
    ];
    expect(formatThreadReplies(replies, "UBOT")).toBe("U1: start\nU2: real answer");
  });
});

describe("interactive tools", () => {
  const base: Tool = {
    name: "ask_user",
    description: "d",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: "answered" };
    },
  };
  it("ask_user is disabled with the ask-in-Slack refusal", async () => {
    const refusal = createSlackRefusalAskUserTool();
    expect(refusal.name).toBe("ask_user");
    const r = await refusal.execute({ question: "which?" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Slack");
    expect(INTERACTIVE_TOOL_NAMES).toContain("ask_user");
  });
  it("disableInteractiveTools swaps execution, keeps the surface", async () => {
    const out = disableInteractiveTools([base]);
    expect(out[0]?.name).toBe("ask_user");
    const r = await out[0]?.execute({ question: "q" });
    expect(r?.isError).toBe(true);
    expect(r?.content).toBe(SLACK_ASK_USER_REFUSAL);
    // untouched when nothing matches
    const other: Tool = { ...base, name: "read_file" };
    expect(disableInteractiveTools([other])[0]).toBe(other);
  });
});

describe("the Bolt SDK loads (dependency-health guard)", () => {
  it("imports @slack/bolt with a usable App constructor (no broken transitive deps)", async () => {
    // Guards the p-queue override: @slack/web-api's p-queue@6.0.0 tarball has
    // no "main" and crashes require on Node 22+ — the workspace pins 6.6.2.
    const mod = (await import("@slack/bolt")) as unknown as { App?: unknown; default?: { App?: unknown } };
    const Ctor = mod.App ?? mod.default?.App;
    expect(typeof Ctor).toBe("function");
  });
});

describe("doctor", () => {
  function tmpRoot(): string {
    return mkdtempSync(join(tmpdir(), "wudao-slack-doctor-"));
  }
  const full = {
    ...DEFAULT_SLACK_SETTINGS,
    enabled: true,
    allowedUsers: ["U1"],
    allowedChannels: ["C1"],
  };
  it("all checks pass with tokens + allowlists set", async () => {
    const root = tmpRoot();
    const { checks, ok } = await runSlackDoctor({
      settings: full,
      workspaceRoot: root,
      env: { WUDAO_SLACK_APP_TOKEN: "xapp-1-valid", WUDAO_SLACK_BOT_TOKEN: "xoxb-1-valid" },
      network: async () => ({ ok: true, detail: "auth.test ok" }),
    });
    expect(ok).toBe(true);
    expect(formatSlackDoctorReport(checks)).toContain("all slack checks passed");
  });
  it("flags disabled, missing tokens, empty allowlists, wrong prefixes — without values", async () => {
    const root = tmpRoot();
    const { checks, ok } = await runSlackDoctor({
      settings: { ...DEFAULT_SLACK_SETTINGS },
      workspaceRoot: root,
      env: { WUDAO_SLACK_APP_TOKEN: "xoxb-wrong", WUDAO_SLACK_BOT_TOKEN: "xapp-wrong" },
    });
    expect(ok).toBe(false);
    const report = formatSlackDoctorReport(checks);
    expect(report).not.toContain("xoxb-wrong");
    expect(report).not.toContain("xapp-wrong");
    expect(report).toContain("WRONG PREFIX");
    expect(report).toContain("EMPTY");
    expect(report).toContain("disabled");
  });
  it("a corrupt thread map is reported but not fatal; absent is 0 bindings", async () => {
    const root = tmpRoot();
    await mkdir(join(root, ".wudao"), { recursive: true });
    await writeFile(join(root, ".wudao", "slack-threads.json"), "{oops", "utf8");
    const { checks } = await runSlackDoctor({ settings: full, workspaceRoot: root, env: {} });
    const mapCheck = checks.find((c) => c.name.includes("slack-threads"));
    expect(mapCheck?.ok).toBe(false);
    expect(mapCheck?.detail).toContain("CORRUPT");
  });
  it("tokenClass separates xapp-/xoxb-", () => {
    expect(tokenClass("xapp-1")).toBe("app");
    expect(tokenClass("xoxb-1")).toBe("bot");
    expect(tokenClass("xoxp-1")).toBe("unknown");
  });
});
