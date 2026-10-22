// M60 §1/§3 — the Slack implementation of InboundChannel: Bolt for Node in
// Socket Mode (app-level xapp- token + bot xoxb- token; NO public ingress —
// the daemon holds one outbound websocket). All decision logic lives in the
// manager; this file is pure I/O: normalize events, post replies, render the
// ask blocks (ask-blocks.ts, pure) and correlate button clicks to pending
// asks. Slash commands ride the socket too (`/slack status` configured in
// the app manifest; typing it as plain text routes the same way).
//
// The Bolt import is DELIBERATELY lazy (inside start): the pure normalizers
// and builders stay loadable without the Slack SDK on the resolution path —
// tests and the eval suite import them freely.
import { randomUUID } from "node:crypto";
import type {
  AskPrompt,
  AskResolution,
  InboundChannel,
  InboundChannelHandlers,
  InboundCommand,
  InboundMessage,
  InboundTarget,
} from "./channel.js";
import { parseInboundCommand } from "./channel.js";
import {
  ASK_ACTION_ALLOW,
  ASK_ACTION_ALWAYS,
  ASK_ACTION_DENY,
  VIEW_SESSION_ACTION,
  askSettledText,
  buildAskBlocks,
  parseAskAction,
  type KnownBlock,
} from "./ask-blocks.js";
// 96 队列 P1-6 — the at-least-once delivery ledger (durable final replies).
import {
  createDeliveryLedger,
  RECOVERED_MARKER_LINE,
  type DeliveryLedger,
} from "./delivery-ledger.js";
import { resolveGlobalHome } from "wudao-harness/settings-layer";

/** The structural slice of a Slack message event the normalizer reads. */
export interface SlackEventShape {
  readonly text?: string;
  readonly user?: string;
  readonly channel?: string;
  readonly ts?: string;
  readonly thread_ts?: string;
  readonly subtype?: string;
  readonly bot_id?: string;
}

/** Strip every <@U…> mention token from a message text (pure). */
export function stripMentions(text: string): string {
  return text.replace(/<@[A-Za-z0-9._=-]+>/g, "").replace(/\s{2,}/g, " ").trim();
}

/** Does the text mention the bot? (pure) */
export function isMentioned(text: string, botUserId: string | undefined): boolean {
  if (botUserId === undefined || botUserId === "") return false;
  return text.includes(`<@${botUserId}>`);
}

/** Normalize one Slack event into an InboundMessage (pure). null when the
 *  event is not a human-authored text message (bot messages, edits, deletes,
 *  channel joins, empty payloads). */
export function normalizeSlackEvent(event: SlackEventShape, botUserId: string | undefined): InboundMessage | null {
  if (event.subtype !== undefined) return null; // message_changed/deleted/joins…
  if (event.user === undefined || event.channel === undefined || event.ts === undefined) return null;
  if (event.bot_id !== undefined) return null; // never react to bots (ourselves included)
  const raw = typeof event.text === "string" ? event.text : "";
  if (raw.trim() === "") return null;
  const mentioned = isMentioned(raw, botUserId);
  return {
    userId: event.user,
    channel: event.channel,
    ts: event.ts,
    ...(event.thread_ts !== undefined ? { threadTs: event.thread_ts } : {}),
    text: stripMentions(raw),
    mentioned,
  };
}

/** Render conversations.replies into a thread digest (pure; newest last).
 *  The bot's own messages are omitted — the digest is what the HUMANS said. */
export function formatThreadReplies(
  messages: readonly SlackEventShape[],
  botUserId: string | undefined,
  maxMessages = 50,
): string {
  const relevant = messages
    .filter((m) => m.subtype === undefined && m.user !== undefined && m.bot_id === undefined && (m.text ?? "").trim() !== "")
    .filter((m) => !isMentioned(m.text ?? "", botUserId) || stripMentions(m.text ?? "") !== "");
  const tail = relevant.slice(-maxMessages);
  return tail.map((m) => `${m.user}: ${stripMentions(m.text ?? "")}`).join("\n");
}

/** Format the thread-context fetch's page (pure, exported for tests). */
export function threadContextFromReplies(replies: readonly SlackEventShape[], botUserId: string | undefined): string {
  return formatThreadReplies(replies, botUserId);
}

export interface SlackChannelOptions {
  readonly appToken: string;
  readonly botToken: string;
  /** F1 (review): the dual-allowlist predicate EVERY interactive click must
   *  cross — buttons render in any workspace member's client who can see the
   *  thread, so the click (not the message) is the approval's security
   *  boundary. Absent → fail-closed (no click ever settles an ask). */
  readonly isAuthorized?: (userId: string | undefined, channel: string | undefined) => boolean;
  /** Log sink for operational lines (never token values). */
  readonly log?: (line: string) => void;
  /** Test seam: a pre-built Bolt App (fake). */
  readonly appOverride?: SlackAppLike;
  /** 96 P1-6: the at-least-once delivery ledger for final replies. Absent →
   *  one over the global home (~/.wudao/slack-delivery.jsonl). The ledger is
   *  best-effort by construction: its failures never block a real send. */
  readonly deliveryLedger?: DeliveryLedger;
}

/** The structural slice of Bolt's App the channel uses (tests fake this). */
export interface SlackAppLike {
  message(handler: (args: SlackMessageArgs) => Promise<void> | void): void;
  command(commandName: string, handler: (args: SlackCommandArgs) => Promise<void> | void): void;
  action(constraints: string | RegExp, handler: (args: SlackActionArgs) => Promise<void> | void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  client: SlackClientLike;
}

export interface SlackClientLike {
  chat: {
    postMessage(args: Record<string, unknown>): Promise<{ ts?: string; ok?: boolean }>;
    update(args: Record<string, unknown>): Promise<{ ok?: boolean }>;
  };
  conversations: {
    replies(args: Record<string, unknown>): Promise<{ messages?: SlackEventShape[]; ok?: boolean }>;
  };
  auth: {
    test(args?: Record<string, unknown>): Promise<{ user_id?: string; ok?: boolean }>;
  };
}

export interface SlackMessageArgs {
  readonly message: SlackEventShape & { channel?: string };
  readonly client: SlackClientLike;
}

export interface SlackCommandArgs {
  readonly command: { readonly channel_id?: string; readonly user_id?: string; readonly text?: string; readonly trigger_id?: string };
  ack(): Promise<void> | void;
  readonly client: SlackClientLike;
}

export interface SlackActionArgs {
  readonly body: {
    readonly channel?: { readonly id?: string };
    readonly message?: { readonly ts?: string; readonly thread_ts?: string };
    readonly user?: { readonly id?: string };
    readonly actions?: readonly { readonly action_id?: string; readonly value?: string }[];
  };
  ack(): Promise<void> | void;
  readonly client: SlackClientLike;
}

interface PendingAsk {
  readonly target: InboundTarget;
  readonly prompt: AskPrompt;
  readonly messageTs: string | undefined;
  readonly resolve: (r: AskResolution) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** The delivery-sweep seam a daemon entry drives after start(): redelivers
 *  final replies a previous process owed (crash between generation and
 *  platform ACK), honestly — ambiguous rows carry the visible marker. */
export interface SlackDeliverySweep {
  sweepPendingDeliveries(): Promise<void>;
}

export function createSlackChannel(opts: SlackChannelOptions): InboundChannel & SlackDeliverySweep {
  const log = opts.log ?? (() => {});
  // F1: fail-closed — without the predicate no click can settle an ask.
  const isAuthorized = opts.isAuthorized ?? ((_userId: string | undefined, _channel: string | undefined) => false);
  const ledger = opts.deliveryLedger ?? createDeliveryLedger(resolveGlobalHome(), { log: (l) => log(l) });
  let botUserId: string | undefined;
  let handlers: InboundChannelHandlers | null = null;
  let app: SlackAppLike | null = null;
  const pending = new Map<string, PendingAsk>();

  // 96 P1-6: the ONE send seam, bracketed by the ledger's three checkpoints —
  // record (发前落账) → markAttempting (紧贴 await 前) → markDelivered (仅成功)
  // / markFailed (确定性拒绝, then the ORIGINAL error rethrows byte-identical
  // so upstream catch semantics never change). `existingId` is the sweep's
  // redelivery path: the obligation already exists, so no fresh record — only
  // the attempt/delivered/failed checkpoints run against that row. The ledger
  // swallows its own IO failures; it can never block or alter the send.
  const sendWithLedger = async (
    target: InboundTarget,
    body: Record<string, unknown>,
    text: string | undefined,
    existingId?: string,
  ): Promise<string | undefined> => {
    const client = app?.client;
    if (client === undefined) throw new Error("slack channel not started");
    const id = existingId ?? (text !== undefined ? ledger.record(target, text) : undefined);
    if (id !== undefined) ledger.markAttempting(id);
    try {
      const res = await client.chat.postMessage(body);
      if (id !== undefined) ledger.markDelivered(id, res.ts);
      return res.ts;
    } catch (err) {
      if (id !== undefined) ledger.markFailed(id, err instanceof Error ? err.message : String(err));
      throw err;
    }
  };

  const postTo = async (target: InboundTarget, ...args: unknown[]): Promise<string | undefined> => {
    const client = app?.client;
    if (client === undefined) throw new Error("slack channel not started");
    const body: Record<string, unknown> = {
      channel: target.channel,
      ...(target.threadTs !== undefined ? { thread_ts: target.threadTs } : {}),
    };
    const [text, maybeOpts] = args as [string, { readonly sessionId?: string } | undefined];
    if (typeof text === "string") body["text"] = text;
    if (maybeOpts !== undefined && typeof maybeOpts === "object" && "sessionId" in maybeOpts) {
      body["blocks"] = [
        { type: "section", text: { type: "mrkdwn", text } },
        {
          type: "actions",
          elements: [
            { type: "button", action_id: VIEW_SESSION_ACTION, value: maybeOpts.sessionId, text: { type: "plain_text", text: "查看会话" } },
          ],
        },
      ];
    }
    return await sendWithLedger(target, body, typeof text === "string" ? text : undefined);
  };

  const settleAsk = (ask: PendingAsk, resolution: AskResolution): void => {
    for (const [key, value] of pending) {
      if (value === ask) pending.delete(key);
    }
    clearTimeout(ask.timer);
    // Swap the interactive blocks for the settled receipt.
    const client = app?.client;
    if (client !== undefined && ask.messageTs !== undefined) {
      void client.chat
        .update({
          channel: ask.target.channel,
          ts: ask.messageTs,
          text: askSettledText(ask.prompt, resolution),
        })
        .catch(() => {});
    }
    ask.resolve(resolution);
  };

  const wire = (bolt: SlackAppLike): void => {
    bolt.message(async ({ message, client }) => {
      const normalized = normalizeSlackEvent(message, botUserId);
      if (normalized === null || handlers === null) return;
      const command = parseInboundCommand(normalized.text);
      if (command !== null) {
        await handlers.onCommand({ ...command, message: normalized });
        return;
      }
      await handlers.onMessage(normalized);
      void client; // (typing only — posting happens through postTo)
    });
    bolt.command("/slack", async ({ command, ack }) => {
      await ack();
      if (handlers === null) return;
      const parsed = parseInboundCommand(`/slack ${command.text ?? ""}`.trim());
      if (parsed === null) return;
      const message: InboundMessage = {
        userId: command.user_id ?? "",
        channel: command.channel_id ?? "",
        ts: `${Date.now() / 1000}`,
        text: `/slack ${(command.text ?? "").trim()}`.trim(),
        mentioned: true,
      };
      await handlers.onCommand({ ...parsed, message });
    });
    const askPattern = new RegExp(`^(${ASK_ACTION_ALLOW}|${ASK_ACTION_ALWAYS}|${ASK_ACTION_DENY}|${VIEW_SESSION_ACTION})$`);
    bolt.action(askPattern, async ({ body, ack, client }) => {
      await ack();
      const action = body.actions?.[0];
      if (action === undefined) return;
      // F1 (review): the click crosses the SAME dual allowlist as messages.
      // Slack renders the buttons to every workspace member who can see the
      // thread (a public channel = everyone); without this gate any of them
      // could approve tool executions. An unauthorized click is ignored
      // exactly like a stale one (ack'd, logged, nothing settles).
      const channel = body.channel?.id;
      if (!isAuthorized(body.user?.id, channel)) {
        log(`slack: ignored button click from ${body.user?.id ?? "unknown"} in ${channel ?? "unknown"} (not in both allowlists)`);
        return;
      }
      if (action.action_id === VIEW_SESSION_ACTION) {
        // 查看会话 button: answer in-thread with the local deep-link hint (a
        // browser URL only exists while a `wudao ui` session is running).
        const sessionId = action.value ?? "";
        const threadTs = body.message?.thread_ts ?? body.message?.ts;
        if (channel !== undefined) {
          await client.chat
            .postMessage({
              channel,
              ...(threadTs !== undefined ? { thread_ts: threadTs } : {}),
              text: `查看会话: \`wudao --resume ${sessionId}\` (或 \`wudao ui\` 后 /resume)`,
            })
            .catch(() => {});
        }
        return;
      }
      const choice = parseAskAction(action.action_id ?? "");
      const ask = action.value !== undefined ? pending.get(action.value) : undefined;
      if (choice === null || ask === undefined) return; // stale click (already settled)
      settleAsk(ask, choice);
    });
  };

  return {
    name: "slack",
    async start(h): Promise<void> {
      handlers = h;
      if (opts.appOverride !== undefined) {
        app = opts.appOverride;
      } else {
        // Lazy: only the daemon pays the Bolt import. CJS interop: the class
        // rides the `App` named export (Node's lexer) or module.exports.App.
        const bolt = (await import("@slack/bolt")) as unknown as {
          App?: new (args: Record<string, unknown>) => SlackAppLike;
          default?: { App?: new (args: Record<string, unknown>) => SlackAppLike };
        };
        const Ctor = bolt.App ?? bolt.default?.App;
        if (Ctor === undefined) throw new Error("@slack/bolt did not export App");
        app = new Ctor({
          token: opts.botToken,
          socketMode: true,
          appToken: opts.appToken,
        });
      }
      wire(app);
      await app.start();
      // The bot's own user id: mention detection needs it (<@U…> matching).
      try {
        const auth = await app.client.auth.test();
        botUserId = auth.user_id;
      } catch (err) {
        log(`slack: auth.test failed (${err instanceof Error ? err.message : String(err)}) — mention detection degraded`);
      }
      log("slack: socket mode connected");
    },
    async stop(): Promise<void> {
      for (const ask of [...pending.values()]) settleAsk(ask, "deny");
      if (app !== null) await app.stop();
      app = null;
      handlers = null;
    },
    async reply(target, text, replyOpts): Promise<void> {
      await postTo(target, text, replyOpts);
    },
    async relayAsk(target, prompt, askOpts): Promise<AskResolution> {
      const client = app?.client;
      if (client === undefined) throw new Error("slack channel not started");
      const askId = randomUUID();
      const blocks = buildAskBlocks(prompt, askId);
      const posted = await client.chat.postMessage({
        channel: target.channel,
        ...(target.threadTs !== undefined ? { thread_ts: target.threadTs } : {}),
        blocks,
        // text: the non-block fallback (notifications, previews)
        text: `🔑 权限审批:${prompt.toolName}`,
      });
      return await new Promise<AskResolution>((resolve) => {
        const timer = setTimeout(() => {
          const ask = pending.get(askId);
          if (ask !== undefined) settleAsk(ask, "timeout");
        }, askOpts.timeoutMs);
        timer.unref?.();
        pending.set(askId, {
          target,
          prompt,
          messageTs: posted.ts,
          resolve,
          timer,
        });
      });
    },
    async threadContext(target): Promise<string> {
      const client = app?.client;
      if (client === undefined || target.threadTs === undefined) return "";
      const res = await client.conversations.replies({
        channel: target.channel,
        ts: target.threadTs,
        limit: 100,
        oldest: "0",
      });
      return threadContextFromReplies(res.messages ?? [], botUserId);
    },
    async sweepPendingDeliveries(): Promise<void> {
      // 96 P1-6: startup sweep — redeliver final replies the PREVIOUS daemon
      // process generated but never confirmed-delivered. Single-daemon
      // assumption: at startup any non-delivered row's owner is a dead
      // process, so every pending/attempting/failed row is claimable. With
      // marker = the platform may ALREADY have the message (crash mid-await /
      // a rejected send retried across restart) — the visible (recovered)
      // prefix keeps the contract honest at-least-once. The whole sweep is
      // best-effort: it must never block or crash the daemon.
      let rows: ReturnType<DeliveryLedger["sweep"]>;
      try {
        rows = ledger.sweep();
      } catch (err) {
        log(`slack: delivery sweep failed (${err instanceof Error ? err.message : String(err)})`);
        return;
      }
      for (const row of rows) {
        const client = app?.client;
        if (client === undefined) {
          log("slack: delivery sweep skipped — channel not started");
          return;
        }
        const text = row.withMarker ? `${RECOVERED_MARKER_LINE}\n${row.text}` : row.text;
        log(`slack: redelivering recovered reply ${row.id}${row.withMarker ? " (with recovery marker)" : ""}`);
        const body: Record<string, unknown> = {
          channel: row.target.channel,
          ...(row.target.threadTs !== undefined ? { thread_ts: row.target.threadTs } : {}),
          text,
        };
        try {
          // Redelivery posts against the EXISTING ledger row: markAttempting
          // (spends the bounded retry budget) → delivered / failed on outcome.
          await sendWithLedger(row.target, body, row.text, row.id);
        } catch (err) {
          log(`slack: redelivery of ${row.id} failed (${err instanceof Error ? err.message : String(err)}) — retried on next restart`);
        }
      }
    },
  };
}
