// M60 §2 — the channel session manager: the channel-agnostic brain between
// an InboundChannel and N harness sessions. One thread = one session (the
// persisted thread↔session map); busy sessions take follow-ups through the
// driver's steering queue (M18 semantics — the loop drains before each model
// call); idle sessions submit the prompt. Summaries post back at run end
// (≤3000 chars, md → mrkdown) with the 查看会话 affordance; errors and
// compaction notices post back; per-tool progress NEVER does (noise rule).
// Every inbound line crosses BOTH allowlists (user AND channel) — anything
// else is a silent drop with one log line (spec §2/§4).
import type { InboundChannel, InboundCommand, InboundMessage, InboundTarget } from "./channel.js";
import { parseInboundCommand, INBOUND_COMMAND_NAMES } from "./channel.js";
import { threadKey, type SlackThreadMap } from "./threads.js";
import type { SlackSettings } from "./settings.js";
import { createChannelAskRelay, type ChannelAskRelay } from "./relay.js";
import { mdToMrkdown, truncateSummary, truncateThreadContext } from "./mrkdown.js";

/** The summary post-back cap (spec §2: ≤3000 chars). */
export const SUMMARY_MAX_CHARS = 3000;

/** The structural driver slice the manager needs (the cli AgentDriver
 *  satisfies it; tests drive a fake). History entries are the driver's
 *  append-only channel kinds — only the fields the manager reads. */
export interface ManagedHistoryEntry {
  readonly kind: string;
  readonly text?: string;
  readonly summary?: string;
  readonly isError?: boolean;
}

export interface ManagedDriverStatus {
  readonly busy: boolean;
  readonly queued: readonly string[];
  readonly sessionId: string;
}

export interface ManagedDriver {
  submit(text: string, opts?: { readonly plan?: boolean; readonly expand?: boolean }): unknown;
  interrupt(): void;
  getStatus(): ManagedDriverStatus;
  getHistory(): readonly ManagedHistoryEntry[];
  subscribe(cb: () => void): () => void;
  onHistory(cb: (entries: readonly ManagedHistoryEntry[], reset: boolean) => void): () => void;
  notify(text: string): void;
  pushMetaNote(text: string): void;
  // ω99-225 跟进（0.3.60 发版链拦截）：driver.resume 的返回从布尔真话化为
  // 带因三态（ResumeOutcome {ok:true} | {ok:false,reason}）；slack 侧对结果
  // 弃值消费（manager.ts :193 只 await 落定），契约钉 {ok:boolean} 宽面即
  // 可结构承载全部三态——不镜像 reason/holderPid（无消费者，YAGNI）。
  resume(id: string): Promise<{ ok: boolean }>;
  dispose(): void;
}

export interface CreateSessionArgs {
  /** Mapped session id (resume); undefined → a fresh session. */
  readonly sessionId?: string;
  /** The ask relay bound to this conversation. */
  readonly askRelay: ChannelAskRelay;
  /** The conversation target (channel + thread). */
  readonly target: InboundTarget;
}

export interface ManagedSession {
  readonly driver: ManagedDriver;
}

export interface ChannelManagerOptions {
  readonly settings: SlackSettings;
  readonly channel: InboundChannel;
  readonly threadMap: SlackThreadMap;
  /** Creates (or re-adopts) one harness session. */
  readonly createSession: (args: CreateSessionArgs) => Promise<ManagedSession>;
  readonly log?: (line: string) => void;
}

/** Fail-closed allowlist: BOTH lists are non-empty requirements — an empty
 *  list passes nobody (the doctor flags this loudly). Pure. */
export function allowlistsPass(
  settings: Pick<SlackSettings, "allowedUsers" | "allowedChannels">,
  userId: string,
  channel: string,
): boolean {
  const users = settings.allowedUsers;
  const channels = settings.allowedChannels;
  if (users.length === 0 || channels.length === 0) return false;
  return users.includes(userId) && channels.includes(channel);
}

interface LiveSession {
  readonly driver: ManagedDriver;
  readonly target: InboundTarget;
  readonly key: string;
  readonly sessionId: string;
  busy: boolean;
  /** Index into driver history — everything at or before it was already
   *  handled (notices posted / summarized past). */
  relayedUpTo: number;
  unsubscribeStatus: () => void;
  unsubscribeHistory: () => void;
}

export interface ChannelSessionManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Test/diagnostic face: live bindings (thread key → session id). */
  bindings(): Readonly<Record<string, string>>;
  paused(): boolean;
}

export function createChannelSessionManager(opts: ChannelManagerOptions): ChannelSessionManager {
  const { settings, channel, threadMap } = opts;
  const log = opts.log ?? (() => {});
  const live = new Map<string, LiveSession>();
  let pausedFlag = false;
  let pauseNoticeSent = false;
  let stopped = false;

  // -- key-notice + summary post-back ---------------------------------------
  // Per-tool progress never relays (noise rule): error entries and the ♻️
  // compaction line post as they land; the final assistant summary posts at
  // the busy→idle transition with the 查看会话 affordance.
  const relayNewEntries = (s: LiveSession, entries: readonly ManagedHistoryEntry[]): void => {
    for (const e of entries) {
      if (e.kind === "error" && e.text !== undefined) {
        void channel.reply(s.target, `⚠️ ${mdToMrkdown(truncateSummary(e.text, SUMMARY_MAX_CHARS))}`);
      } else if (e.kind === "notice" && typeof e.text === "string" && e.text.startsWith("♻️")) {
        void channel.reply(s.target, mdToMrkdown(e.text));
      }
    }
  };

  const postRunSummary = (s: LiveSession): void => {
    const history = s.driver.getHistory();
    // The final answer = the LAST assistant entry inside this run's span
    // (history before relayedUpTo belonged to earlier runs).
    let lastAnswer: string | undefined;
    // 0.3.15（用户需求：任务整体执行时间统计）：本 run 的耗时收据（driver
    // 落定的最后一条耗时收据 notice）——转发进 footer；找不到就照旧（老 driver）。
    let runStats: string | undefined;
    for (let i = history.length - 1; i >= Math.max(0, s.relayedUpTo); i -= 1) {
      const e = history[i];
      if (e === undefined) continue;
      if (lastAnswer === undefined && e.kind === "assistant") {
        lastAnswer = e.text;
        continue;
      }
      if (runStats === undefined && e.kind === "notice" && typeof e.text === "string" && e.text.startsWith("耗时")) {
        runStats = e.text;
      }
    }
    s.relayedUpTo = history.length;
    if (lastAnswer === undefined || lastAnswer === "") return;
    const body = mdToMrkdown(truncateSummary(lastAnswer, SUMMARY_MAX_CHARS));
    const footer = `\n—\n${runStats !== undefined ? `${runStats}\n` : ""}查看会话: \`wudao --resume ${s.sessionId}\` (或 \`wudao ui\` 后 /resume)`;
    void channel.reply(s.target, `${body}${footer}`, { sessionId: s.sessionId });
  };

  const watchSession = (driver: ManagedDriver, target: InboundTarget, key: string, sessionId: string): LiveSession => {
    const s: LiveSession = {
      driver,
      target,
      key,
      sessionId,
      busy: driver.getStatus().busy,
      relayedUpTo: driver.getHistory().length,
      unsubscribeStatus: () => {},
      unsubscribeHistory: () => {},
    };
    s.unsubscribeStatus = driver.subscribe(() => {
      const busy = driver.getStatus().busy;
      if (s.busy && !busy) postRunSummary(s);
      s.busy = busy;
    });
    s.unsubscribeHistory = (driver as ManagedDriver).onHistory((entries, reset) => {
      if (reset) {
        s.relayedUpTo = 0;
        return;
      }
      relayNewEntries(s, entries);
    });
    return s;
  };

  const ensureSession = async (m: InboundMessage, known: boolean): Promise<LiveSession> => {
    const key = threadKey(m.channel, m.threadTs, m.ts);
    const target: InboundTarget = { channel: m.channel, threadTs: m.threadTs ?? m.ts, userId: m.userId };
    const mapped = known ? threadMap.get(key) : undefined;
    const askRelay = createChannelAskRelay({ channel, target, timeoutMs: settings.askTimeoutMs });
    const session = await opts.createSession({
      ...(mapped !== undefined ? { sessionId: mapped } : {}),
      askRelay,
      target,
    });
    const sessionId = session.driver.getStatus().sessionId;
    if (mapped !== undefined && mapped === sessionId) {
      // Adopt the persisted conversation (branch-aware, same projection the
      // CLI resume uses). A missing/unreadable file degrades to fresh.
      await session.driver.resume(mapped).catch(() => false);
    }
    await threadMap.set(key, sessionId);
    log(`slack: thread ${key} → session ${sessionId}${mapped !== undefined ? " (resumed)" : " (new)"}`);
    const s = watchSession(session.driver, target, key, sessionId);
    live.set(key, s);
    return s;
  };

  const onMessage = async (m: InboundMessage): Promise<void> => {
    // §2/§4: dual allowlist — silent drop (one log line), never a reply (a
    // reply would confirm the bot's presence to a non-allowlisted sender).
    if (!allowlistsPass(settings, m.userId, m.channel)) {
      log(`slack: dropped message from ${m.userId} in ${m.channel} (not in both allowlists)`);
      return;
    }
    // Control commands dispatch through the channel's onCommand seam; a
    // command text never becomes a prompt.
    if (parseInboundCommand(m.text) !== null) return;
    if (pausedFlag) {
      if (!pauseNoticeSent) {
        pauseNoticeSent = true;
        await channel.reply({ channel: m.channel, threadTs: m.threadTs ?? m.ts }, "⏸ wudao 已暂停 — `/slack resume` 恢复");
      } else {
        log(`slack: dropped message while paused (from ${m.userId})`);
      }
      return;
    }
    if (m.text.trim() === "") return;
    // A brand-new conversation needs a mention; a mapped thread does not
    // (the binding IS the intent — follow-ups continue the session).
    const key = threadKey(m.channel, m.threadTs, m.ts);
    const known = live.has(key) || threadMap.get(key) !== undefined;
    if (!known && !m.mentioned) {
      log(`slack: ignoring non-mention message in unmapped thread ${key}`);
      return;
    }
    const s = known ? (live.get(key) ?? (await ensureSession(m, known))) : await ensureSession(m, known);
    // A brand-new session: the thread digest rides the FIRST model call
    // through the MetaNote channel (the model sees it; the persisted
    // conversation stays clean — the same projection rule as git-status).
    if (!known && channel.threadContext !== undefined) {
      const digest = await channel.threadContext(s.target).catch(() => undefined);
      if (digest !== undefined && digest.trim() !== "") {
        s.driver.pushMetaNote(
          `[slack thread context — this thread's recent conversation before the session started]\n${truncateThreadContext(digest, settings.threadContextMaxChars)}\n[/slack thread context]`,
        );
      }
    }
    const outcome = s.driver.submit(m.text);
    if (outcome === "steered") {
      await channel.reply(s.target, "⏳ 已加入 steering 队列 — 下一次模型调用前排空");
    }
  };

  const onCommand = async (cmd: InboundCommand): Promise<void> => {
    const m = cmd.message;
    if (!allowlistsPass(settings, m.userId, m.channel)) {
      log(`slack: dropped command from ${m.userId} in ${m.channel} (not in both allowlists)`);
      return;
    }
    const target: InboundTarget = { channel: m.channel, threadTs: m.threadTs ?? m.ts };
    const reply = (text: string): void => {
      void channel.reply(target, text);
    };
    switch (cmd.name) {
      case "status": {
        const rows = [...live.entries()].map(([key, s]) => {
          const st = s.driver.getStatus();
          return `  ${key} → ${s.sessionId}${st.busy ? " (busy)" : ""}${st.queued.length > 0 ? ` (queued ${st.queued.length})` : ""}`;
        });
        reply(
          `wudao slack · ${pausedFlag ? "⏸ paused" : "▶️ running"} · ${live.size} session(s)\n` +
            (rows.length > 0 ? rows.join("\n") : "  (no active threads)"),
        );
        return;
      }
      case "pause":
        pausedFlag = true;
        pauseNoticeSent = false;
        reply("⏸ 已暂停 — 消息将被忽略,`/slack resume` 恢复");
        return;
      case "resume":
        pausedFlag = false;
        pauseNoticeSent = false;
        reply("▶️ 已恢复");
        return;
      default:
        reply(`未知子命令 "${cmd.name}" — 可用: ${INBOUND_COMMAND_NAMES.join(" | ")}`);
    }
  };

  return {
    async start(): Promise<void> {
      await channel.start({
        // Promises pass through (a channel may await its dispatch to back-
        // pressure its inbound queue); rejections surface in the channel's
        // own middleware logging instead of vanishing.
        onMessage: (m) => onMessage(m),
        onCommand: (c) => onCommand(c),
      });
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      for (const s of live.values()) {
        s.unsubscribeStatus();
        s.unsubscribeHistory();
        s.driver.interrupt();
        s.driver.dispose();
      }
      live.clear();
      await channel.stop();
    },
    bindings: () => {
      const out: Record<string, string> = {};
      for (const [key, s] of live) out[key] = s.sessionId;
      return out;
    },
    paused: () => pausedFlag,
  };
}
