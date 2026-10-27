// M60 — the InboundChannel contract pieces: command parsing, the Block Kit
// ask payload (protected path has NO always button), the ask action parse,
// and the relay's four answer paths + fail-closed timeout.
import { describe, expect, it } from "vitest";
import { parseInboundCommand, INBOUND_COMMAND_NAMES } from "../src/channel.js";
import {
  ASK_ACTION_ALLOW,
  ASK_ACTION_ALWAYS,
  ASK_ACTION_DENY,
  askPromptText,
  askSettledText,
  buildAskBlocks,
  parseAskAction,
} from "../src/ask-blocks.js";
import { createChannelAskRelay } from "../src/relay.js";
import type { AskPrompt, AskResolution, InboundChannel, InboundTarget } from "../src/channel.js";

describe("parseInboundCommand", () => {
  it("routes /slack subcommands with args", () => {
    expect(parseInboundCommand("/slack status")).toEqual({ name: "status", args: [] });
    expect(parseInboundCommand("  /slack   pause  ")).toEqual({ name: "pause", args: [] });
    expect(parseInboundCommand("/slack")).toEqual({ name: "status", args: [] });
  });
  it("rejects non-commands and word-boundary collisions", () => {
    expect(parseInboundCommand("hello world")).toBeNull();
    expect(parseInboundCommand("/slackful status")).toBeNull();
  });
  it("documents the control surface", () => {
    expect(INBOUND_COMMAND_NAMES).toEqual(["status", "pause", "resume"]);
  });
});

describe("buildAskBlocks", () => {
  const base: AskPrompt = { toolName: "shell", summary: "rm -rf /tmp/x" };
  it("offers all three buttons on a normal ask", () => {
    const blocks = buildAskBlocks(base, "ask-1");
    const actions = blocks[1]?.elements as { action_id: string; value?: string }[];
    expect(actions.map((a) => a.action_id)).toEqual([ASK_ACTION_ALLOW, ASK_ACTION_ALWAYS, ASK_ACTION_DENY]);
    expect(actions.every((a) => a.value === "ask-1")).toBe(true);
  });
  it("a bypass-immune step (protectedFile) omits 本会话总是", () => {
    const blocks = buildAskBlocks({ ...base, protectedFile: ".wudao/settings.json" }, "ask-2");
    const actions = blocks[1]?.elements as { action_id: string }[];
    expect(actions.map((a) => a.action_id)).toEqual([ASK_ACTION_ALLOW, ASK_ACTION_DENY]);
  });
  it("prompt text carries tool, summary, and decorations", () => {
    const text = askPromptText({ toolName: "write_file", summary: ".env", protectedFile: ".wudao/settings.json", warning: "git risk", sidecarReason: "high risk cmd" });
    expect(text).toContain("write_file");
    expect(text).toContain(".env");
    expect(text).toContain("bypass-immune");
    expect(text).toContain("git risk");
    expect(text).toContain("sidecar");
  });
  it("F4: the model-controlled summary is entity-escaped (no live mentions from an ask)", () => {
    const text = askPromptText({ toolName: "shell", summary: "echo <!channel> <@U1>" });
    expect(text).toContain("&lt;!channel&gt;");
    expect(text).toContain("&lt;@U1&gt;");
    expect(text).not.toContain("<!channel>");
  });
  it("parseAskAction maps ids; settled text names the verdict", () => {
    expect(parseAskAction(ASK_ACTION_ALLOW)).toBe("allow");
    expect(parseAskAction(ASK_ACTION_ALWAYS)).toBe("always");
    expect(parseAskAction(ASK_ACTION_DENY)).toBe("deny");
    expect(parseAskAction("junk")).toBeNull();
    expect(askSettledText(base, "timeout")).toContain("超时");
    expect(askSettledText(base, "always")).toContain("本会话总是");
  });
});

// A scripted fake channel: asks answer per a queue (or stall for timeout).
function fakeChannel(script: readonly AskResolution[], opts?: { stallAsks?: boolean }) {
  const replies: { target: InboundTarget; text: string; sessionId?: string }[] = [];
  const asks: { target: InboundTarget; prompt: AskPrompt; timeoutMs: number }[] = [];
  let cursor = 0;
  const channel: InboundChannel = {
    name: "fake",
    async start() {},
    async stop() {},
    async reply(target, text, rOpts) {
      replies.push({ target, text, ...(rOpts?.sessionId !== undefined ? { sessionId: rOpts.sessionId } : {}) });
    },
    async relayAsk(target, prompt, askOpts) {
      asks.push({ target, prompt, timeoutMs: askOpts.timeoutMs });
      if (opts?.stallAsks === true) {
        // never resolves — the relay's own timeout race is what we test via
        // resolving "timeout" from here (the Slack impl races a timer).
        return "timeout";
      }
      const next = script[cursor];
      cursor += 1;
      return next ?? "deny";
    },
  };
  return { channel, replies, asks };
}

const target: InboundTarget = { channel: "C1", threadTs: "111.000" };

describe("createChannelAskRelay", () => {
  it("allow → {kind:allow}", async () => {
    const { channel } = fakeChannel(["allow"]);
    const relay = createChannelAskRelay({ channel, target, timeoutMs: 1000 });
    expect(await relay("shell", "summary", { command: "ls" })).toEqual({ kind: "allow" });
  });
  it("always → {kind:session} (the engine records the rule via applyAskAnswer)", async () => {
    const { channel } = fakeChannel(["always"]);
    const relay = createChannelAskRelay({ channel, target, timeoutMs: 1000 });
    expect(await relay("shell", "summary", { command: "ls" })).toEqual({ kind: "session" });
  });
  it("deny → {kind:deny}", async () => {
    const { channel } = fakeChannel(["deny"]);
    const relay = createChannelAskRelay({ channel, target, timeoutMs: 1000 });
    expect(await relay("shell", "summary", { command: "ls" })).toEqual({ kind: "deny" });
  });
  it("timeout → deny with a fail-closed reason", async () => {
    const { channel } = fakeChannel([], { stallAsks: true });
    const lines: string[] = [];
    const relay = createChannelAskRelay({ channel, target, timeoutMs: 60000, log: (l) => lines.push(l) });
    const answer = await relay("shell", "summary", { command: "ls" });
    expect(answer).toEqual({ kind: "deny", reason: expect.stringContaining("fail-closed") });
    expect(lines.some((l) => l.includes("timed out"))).toBe(true);
  });
  it("a channel throw is a deny, never a hang", async () => {
    const channel: InboundChannel = {
      ...fakeChannel([]).channel,
      relayAsk: async () => {
        throw new Error("boom");
      },
    };
    const relay = createChannelAskRelay({ channel, target, timeoutMs: 1000, log: () => {} });
    expect(await relay("shell", "s", {})).toEqual({ kind: "deny", reason: "ask relay failed" });
  });
  it("the prompt carries the protected-file decoration for settings writes", async () => {
    const { channel, asks } = fakeChannel(["allow"]);
    const relay = createChannelAskRelay({ channel, target, timeoutMs: 1000 });
    await relay("write_file", "summary", { path: ".wudao/settings.json", content: "{}" });
    expect(asks[0]?.prompt.protectedFile).toBe(".wudao/settings.json");
  });
});
