// M60 §2 — the InboundChannel abstraction: the ONE interface a chat frontend
// must satisfy to drive harness sessions (research 26 #5). Slack (Bolt Socket
// Mode) is the first implementation; Telegram/Discord/webhook follow the same
// contract without touching the session manager. The channel is I/O only —
// allowlists, thread↔session mapping, busy/steer routing, and summaries all
// live in the manager, so every implementation inherits identical semantics.

/** Where a conversation lives on the channel (Slack: channel + thread_ts). */
export interface InboundTarget {
  readonly channel: string;
  readonly threadTs?: string;
  readonly userId?: string;
}

/** One inbound chat message, normalized. `ts` is the channel's message id —
 *  the manager threads its replies at the message's own thread (or the
 *  message itself when it starts a new conversation). */
export interface InboundMessage {
  readonly userId: string;
  readonly channel: string;
  readonly threadTs?: string;
  readonly ts: string;
  readonly text: string;
  /** True when the message explicitly mentioned the bot (a new-thread
   *  mention is what creates a session; a follow-up needs none). */
  readonly mentioned: boolean;
}

/** A `/slack …`-style control command typed in the chat. */
export interface InboundCommand {
  readonly name: string;
  readonly args: readonly string[];
  readonly message: InboundMessage;
}

/** The permission-ask prompt relayed to the human (the same sanitized
 *  summary the TUI's ask renders — see buildAskRelay). `protectedFile` set
 *  means a bypass-immune runtime-policy step: the channel MUST NOT offer the
 *  "本会话总是" option (identical to the TUI's plain [y/N] degradation). */
export interface AskPrompt {
  readonly toolName: string;
  readonly summary: string;
  readonly protectedFile?: string;
  readonly warning?: string;
  readonly sidecarReason?: string;
}

/** The three button-level answers (mapped onto the harness AskAnswer by the
 *  relay: always → {kind:"session"} — or allow-once when protected). */
export type AskChoice = "allow" | "always" | "deny";

export type AskResolution = AskChoice | "timeout";

export interface InboundChannelHandlers {
  /** A chat message arrived (already normalized + mention-stripped). */
  onMessage(message: InboundMessage): void | Promise<void>;
  /** A control command arrived (`/slack status` etc.). */
  onCommand(command: InboundCommand): void | Promise<void>;
}

export interface InboundChannel {
  /** Channel identity (diagnostics, status lines). */
  readonly name: string;
  /** Connect and begin dispatching. Resolves once the connection is live. */
  start(handlers: InboundChannelHandlers): Promise<void>;
  /** Disconnect cleanly (idempotent). */
  stop(): Promise<void>;
  /** Post a chat message into the conversation. `sessionId` (optional) lets
   *  the channel attach a "view session" affordance (the Slack 查看会话
   *  button). */
  reply(target: InboundTarget, text: string, opts?: { readonly sessionId?: string }): Promise<void>;
  /** Relay one permission ask into the conversation as interactive blocks.
   *  Resolves with the human's choice, or "timeout" when nobody answered
   *  within timeoutMs (the relay maps that to a fail-closed deny). */
  relayAsk(target: InboundTarget, prompt: AskPrompt, opts: { readonly timeoutMs: number }): Promise<AskResolution>;
  /** The recent thread conversation as a digest string (new-session thread
   *  context; ≤ threadContextMaxChars is the MANAGER's job). Absent → this
   *  channel cannot provide history. */
  threadContext?(target: InboundTarget): Promise<string>;
}

/** The parsed shape of a control command (before the message is attached). */
export interface ParsedInboundCommand {
  readonly name: string;
  readonly args: readonly string[];
}

/** Is the message a control command for us? Pure router shared by every
 *  implementation shape (`/slack status` — the name is historical; any
 *  channel accepts it so the muscle memory carries over). */
export function parseInboundCommand(text: string, commandName = "/slack"): ParsedInboundCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(commandName)) return null;
  const rest = trimmed.slice(commandName.length);
  // Only a word boundary continues the command (`/slackful` is not ours).
  if (rest !== "" && !/^\s/.test(rest)) return null;
  const parts = rest.trim().split(/\s+/).filter((p) => p !== "");
  return { name: parts[0] ?? "status", args: parts.slice(1) };
}

/** The control commands every InboundChannel implementation accepts. */
export const INBOUND_COMMAND_NAMES: readonly string[] = ["status", "pause", "resume"];
