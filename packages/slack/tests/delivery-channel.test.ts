// 96 队列 P1-6 — the ledger wired into the send seam: postTo (the ONE final-
// reply delivery path) brackets every send with record → markAttempting →
// delivered/failed; the transient postMessage sites (relayAsk's ask blocks,
// the 查看会话 in-thread hint) stay OUT of the ledger; a broken ledger never
// blocks a send; and the startup sweep redelivers crash-ambiguous rows with
// the visible (recovered) marker — honest at-least-once, never a silent dup.
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSlackChannel,
  type SlackActionArgs,
  type SlackAppLike,
  type SlackClientLike,
} from "../src/slack-channel.js";
import { createDeliveryLedger, foldDeliveryJournal, RECOVERED_MARKER_LINE } from "../src/delivery-ledger.js";
import { VIEW_SESSION_ACTION } from "../src/ask-blocks.js";

interface RecordedPost {
  readonly channel?: string;
  readonly thread_ts?: string;
  readonly text?: string;
  readonly blocks?: unknown;
}

function fakeBoltApp(opts?: { failPosts?: boolean }) {
  const actionHandlers: ((args: SlackActionArgs) => Promise<void>)[] = [];
  const posted: RecordedPost[] = [];
  const client: SlackClientLike = {
    chat: {
      postMessage: async (body: Record<string, unknown>) => {
        if (opts?.failPosts === true) throw new Error("channel_not_found");
        posted.push(body as RecordedPost);
        return { ts: `ts-${posted.length}`, ok: true };
      },
      update: async () => ({ ok: true }),
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
  return { app, fireAction, posted };
}

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "wudao-delivery-"));
}

const journalPath = (home: string): string => join(home, "slack-delivery.jsonl");

const foldedRows = (home: string) =>
  [...foldDeliveryJournal(existsSync(journalPath(home)) ? readFileSync(journalPath(home), "utf8") : "").values()];

const target = { channel: "C1", threadTs: "111.000" };

const mkChannel = (home: string, app: SlackAppLike, logs: string[] = []) => {
  const channel = createSlackChannel({
    appToken: "xapp-x",
    botToken: "xoxb-x",
    appOverride: app,
    isAuthorized: () => true,
    log: (l) => logs.push(l),
    deliveryLedger: createDeliveryLedger(home, { log: (l) => logs.push(l) }),
  });
  return channel;
};

describe("postTo integration: the three checkpoints", () => {
  it("a successful reply lands a delivered row with the platform ts", async () => {
    const home = tmpHome();
    const { app, posted } = fakeBoltApp();
    const channel = mkChannel(home, app);
    await channel.start({ onMessage: () => {}, onCommand: () => {} });
    await channel.reply(target, "final answer");
    expect(posted.length).toBe(1);
    expect(posted[0]?.text).toBe("final answer");
    const rows = foldedRows(home);
    expect(rows.length).toBe(1);
    expect(rows[0]?.state).toBe("delivered");
    expect(rows[0]?.ts).toBe("ts-1");
    expect(rows[0]?.text).toBe("final answer");
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.target).toEqual({ channel: "C1", threadTs: "111.000" });
    await channel.stop();
  });

  it("a failed send lands a failed row AND the original error still rejects (byte-identical rethrow)", async () => {
    const home = tmpHome();
    const { app } = fakeBoltApp({ failPosts: true });
    const channel = mkChannel(home, app);
    await channel.start({ onMessage: () => {}, onCommand: () => {} });
    const err: Error[] = [];
    await channel.reply(target, "doomed").catch((e: unknown) => {
      err.push(e as Error);
    });
    expect(err.length).toBe(1);
    expect(err[0]).toBeInstanceOf(Error);
    expect(err[0]?.message).toBe("channel_not_found");
    const rows = foldedRows(home);
    expect(rows.length).toBe(1);
    expect(rows[0]?.state).toBe("failed");
    expect(rows[0]?.reason).toBe("channel_not_found");
    await channel.stop();
  });

  it("a reply with the sessionId affordance records the TEXT, not the blocks", async () => {
    const home = tmpHome();
    const { app } = fakeBoltApp();
    const channel = mkChannel(home, app);
    await channel.start({ onMessage: () => {}, onCommand: () => {} });
    await channel.reply(target, "summary body", { sessionId: "wudao-slack-1" });
    const rows = foldedRows(home);
    expect(rows[0]?.text).toBe("summary body");
    await channel.stop();
  });
});

describe("best-effort (红线 1: a broken ledger never blocks or breaks the send)", () => {
  it("unwritable ledger home: a good send still delivers; a bad send still rejects with its own error", async () => {
    const blocker = join(tmpdir(), `wudao-delivery-block-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(blocker, "file, not dir");
    const logs: string[] = [];

    const good = fakeBoltApp();
    const goodChannel = mkChannel(join(blocker, "h"), good.app, logs);
    await goodChannel.start({ onMessage: () => {}, onCommand: () => {} });
    await expect(goodChannel.reply(target, "through")).resolves.toBeUndefined();
    expect(good.posted.length).toBe(1); // the real send happened, unmolested
    await goodChannel.stop();

    const bad = fakeBoltApp({ failPosts: true });
    const badChannel = mkChannel(join(blocker, "h2"), bad.app, logs);
    await badChannel.start({ onMessage: () => {}, onCommand: () => {} });
    await expect(badChannel.reply(target, "x")).rejects.toThrow("channel_not_found");
    await badChannel.stop();
    expect(logs.some((l) => l.includes("delivery ledger"))).toBe(true); // visible, not silent
  });
});

describe("transient postMessage sites stay OUT of the ledger (红线 3)", () => {
  it("relayAsk's ask blocks and the 查看会话 hint write zero ledger rows", async () => {
    const home = tmpHome();
    const { app, fireAction, posted } = fakeBoltApp();
    const channel = mkChannel(home, app);
    await channel.start({ onMessage: () => {}, onCommand: () => {} });
    const ask = channel.relayAsk(target, { toolName: "shell", summary: "ls" }, { timeoutMs: 40 });
    await ask; // "timeout" — the ask post itself is transient
    await fireAction({
      channel: { id: "C1" },
      message: { ts: "ts-1", thread_ts: "111.000" },
      actions: [{ action_id: VIEW_SESSION_ACTION, value: "wudao-slack-9" }],
    });
    expect(posted.length).toBe(2); // ask blocks + view-session hint both posted…
    expect(existsSync(journalPath(home))).toBe(false); // …and neither was ledgered
    await channel.stop();
  });
});

describe("startup sweep: honest at-least-once redelivery", () => {
  it("an attempting row (crash mid-send) redelivers WITH the visible marker, then lands delivered", async () => {
    const home = tmpHome();
    // Simulate the dead process: it recorded + started the send, then died.
    const dead = createDeliveryLedger(home);
    const id = dead.record(target, "final answer");
    dead.markAttempting(id);
    // The new daemon process: a FRESH ledger instance over the same journal.
    const { app, posted } = fakeBoltApp();
    const logs: string[] = [];
    const channel = mkChannel(home, app, logs);
    await channel.start({ onMessage: () => {}, onCommand: () => {} });
    await channel.sweepPendingDeliveries();
    expect(posted.length).toBe(1);
    expect(posted[0]?.text).toBe(`${RECOVERED_MARKER_LINE}\nfinal answer`);
    expect(posted[0]?.channel).toBe("C1");
    expect(posted[0]?.thread_ts).toBe("111.000");
    const rows = foldedRows(home);
    expect(rows.find((r) => r.id === id)?.state).toBe("delivered");
    expect(logs.some((l) => l.includes("redeliver"))).toBe(true);
    await channel.stop();
  });

  it("a pending row (send never started) redelivers WITHOUT the marker", async () => {
    const home = tmpHome();
    const dead = createDeliveryLedger(home);
    dead.record(target, "clean text");
    const { app, posted } = fakeBoltApp();
    const channel = mkChannel(home, app);
    await channel.start({ onMessage: () => {}, onCommand: () => {} });
    await channel.sweepPendingDeliveries();
    expect(posted.length).toBe(1);
    expect(posted[0]?.text).toBe("clean text");
    await channel.stop();
  });

  it("delivered rows are never re-posted", async () => {
    const home = tmpHome();
    const dead = createDeliveryLedger(home);
    const id = dead.record(target, "already there");
    dead.markAttempting(id);
    dead.markDelivered(id);
    const { app, posted } = fakeBoltApp();
    const channel = mkChannel(home, app);
    await channel.start({ onMessage: () => {}, onCommand: () => {} });
    await channel.sweepPendingDeliveries();
    expect(posted.length).toBe(0);
    await channel.stop();
  });

  it("a redelivery that fails again marks the row failed and the sweep still resolves", async () => {
    const home = tmpHome();
    const dead = createDeliveryLedger(home);
    const id = dead.record(target, "undeliverable");
    dead.markAttempting(id);
    const { app } = fakeBoltApp({ failPosts: true });
    const logs: string[] = [];
    const channel = mkChannel(home, app, logs);
    await channel.start({ onMessage: () => {}, onCommand: () => {} });
    await expect(channel.sweepPendingDeliveries()).resolves.toBeUndefined();
    const rows = foldedRows(home);
    expect(rows.find((r) => r.id === id)?.state).toBe("failed");
    expect(logs.some((l) => l.includes("redelivery") && l.includes("failed"))).toBe(true);
    await channel.stop();
  });

  it("the recovered marker line is pinned (visible honesty, not a silent dup)", () => {
    expect(RECOVERED_MARKER_LINE).toBe("_(recovered after restart)_");
  });
});

describe("the default ledger home", () => {
  it("without deliveryLedger the channel ledgers into the global home (WUDAO_GLOBAL_HOME-aware)", async () => {
    const globalHome = process.env["WUDAO_GLOBAL_HOME"];
    expect(globalHome).toBeDefined(); // pinned by tests/setup-global-home.ts
    const { app } = fakeBoltApp();
    const channel = createSlackChannel({
      appToken: "xapp-x",
      botToken: "xoxb-x",
      appOverride: app,
      isAuthorized: () => true,
    });
    await channel.start({ onMessage: () => {}, onCommand: () => {} });
    await channel.reply({ channel: "C9" }, "default home");
    expect(existsSync(join(globalHome as string, "slack-delivery.jsonl"))).toBe(true);
    await channel.stop();
  });
});
