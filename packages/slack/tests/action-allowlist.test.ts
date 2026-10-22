// F1 (review) — interactive clicks cross the dual allowlist: the real Bolt
// action handler (driven through the appOverride seam, zero network) must
// ignore a non-allowlisted user's 允许 click so the ask times out to a
// fail-closed deny, and must settle for an allowlisted user. Also pins the
// fail-closed default (no predicate → no click ever settles).
import { describe, expect, it } from "vitest";
import { createSlackChannel, type SlackAppLike, type SlackClientLike, type SlackActionArgs } from "../src/slack-channel.js";
import { ASK_ACTION_ALLOW, askSettledText } from "../src/ask-blocks.js";
import type { AskPrompt } from "../src/channel.js";

interface RecordedPost {
  readonly channel: string;
  readonly thread_ts?: string;
  readonly blocks?: { elements?: { action_id?: string; value?: string }[] }[];
  readonly text?: string;
}

function fakeBoltApp() {
  const actionHandlers: ((args: SlackActionArgs) => Promise<void>)[] = [];
  const posted: RecordedPost[] = [];
  const updated: RecordedPost[] = [];
  const client: SlackClientLike = {
    chat: {
      postMessage: async (body: Record<string, unknown>) => {
        posted.push(body as RecordedPost);
        return { ts: `ts-${posted.length}`, ok: true };
      },
      update: async (body: Record<string, unknown>) => {
        updated.push(body as RecordedPost);
        return { ok: true };
      },
    },
    conversations: { replies: async () => ({ messages: [], ok: true }) },
    auth: { test: async () => ({ user_id: "UBOT", ok: true }) },
  };
  const app: SlackAppLike = {
    message: () => {},
    command: () => {},
    action: (_constraints, handler) => {
      actionHandlers.push(handler as (args: SlackActionArgs) => Promise<void>);
    },
    start: async () => {},
    stop: async () => {},
    client,
  };
  const fireAction = async (body: SlackActionArgs["body"]): Promise<void> => {
    for (const h of [...actionHandlers]) await h({ body, ack: () => {}, client });
  };
  const lastAskValue = (): string | undefined => {
    const last = [...posted].reverse().find((p) => p.blocks !== undefined);
    return last?.blocks?.[1]?.elements?.[0]?.value;
  };
  return { app, fireAction, lastAskValue, updated };
}

const prompt: AskPrompt = { toolName: "shell", summary: "rm -rf /tmp/x" };
const target = { channel: "C_OK", threadTs: "111.000" };

describe("F1: button clicks cross the dual allowlist", () => {
  it("a non-allowlisted user's 允许 click is ignored — the ask times out to deny", async () => {
    const { app, fireAction, lastAskValue, updated } = fakeBoltApp();
    const logs: string[] = [];
    const channel = createSlackChannel({
      appToken: "xapp-x",
      botToken: "xoxb-x",
      appOverride: app,
      isAuthorized: (userId, ch) => userId === "U_OK" && ch === "C_OK",
      log: (l) => logs.push(l),
    });
    await channel.start({ onMessage: () => {}, onCommand: () => {} });
    const askPromise = channel.relayAsk(target, prompt, { timeoutMs: 150 });
    await new Promise((r) => setTimeout(r, 10)); // the ask message posts first
    const value = lastAskValue();
    expect(value).toBeDefined();
    // A workspace member who can SEE the thread but is not allowlisted clicks 允许.
    await fireAction({
      user: { id: "U_SOMEONE_ELSE" },
      channel: { id: "C_OK" },
      message: { ts: "ts-1", thread_ts: "111.000" },
      actions: [{ action_id: ASK_ACTION_ALLOW, value }],
    });
    await expect(askPromise).resolves.toBe("timeout"); // never settled by the click
    // The ONLY receipt is the timeout one (⏱ …超时拒绝) — no approval ever landed.
    expect(updated.length).toBe(1);
    expect(updated[0]?.text).toContain("超时拒绝");
    expect(updated[0]?.text).not.toContain("已允许");
    expect(logs.some((l) => l.includes("U_SOMEONE_ELSE") && l.includes("ignored"))).toBe(true);
    await channel.stop();
  });

  it("an allowlisted user's click settles the ask and swaps the receipt", async () => {
    const { app, fireAction, lastAskValue, updated } = fakeBoltApp();
    const channel = createSlackChannel({
      appToken: "xapp-x",
      botToken: "xoxb-x",
      appOverride: app,
      isAuthorized: (userId, ch) => userId === "U_OK" && ch === "C_OK",
    });
    await channel.start({ onMessage: () => {}, onCommand: () => {} });
    const askPromise = channel.relayAsk(target, prompt, { timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 10));
    await fireAction({
      user: { id: "U_OK" },
      channel: { id: "C_OK" },
      message: { ts: "ts-1", thread_ts: "111.000" },
      actions: [{ action_id: ASK_ACTION_ALLOW, value: lastAskValue() }],
    });
    await expect(askPromise).resolves.toBe("allow");
    expect(updated[0]?.text).toBe(askSettledText(prompt, "allow"));
    await channel.stop();
  });

  it("fail-closed default: with no predicate, NO click ever settles an ask", async () => {
    const { app, fireAction, lastAskValue } = fakeBoltApp();
    const channel = createSlackChannel({ appToken: "xapp-x", botToken: "xoxb-x", appOverride: app });
    await channel.start({ onMessage: () => {}, onCommand: () => {} });
    const askPromise = channel.relayAsk(target, prompt, { timeoutMs: 120 });
    await new Promise((r) => setTimeout(r, 10));
    await fireAction({
      user: { id: "U_OK" },
      channel: { id: "C_OK" },
      actions: [{ action_id: ASK_ACTION_ALLOW, value: lastAskValue() }],
    });
    await expect(askPromise).resolves.toBe("timeout");
    await channel.stop();
  });
});
