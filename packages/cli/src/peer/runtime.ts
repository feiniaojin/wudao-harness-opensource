// M64-A §A — the per-session peer runtime: one object ties together the
// registry entry (name + socket + tier), the UDS inbox, the inbound engine
// (three-state classification, throttling, holds + dialogExpiry), the
// model-facing tools' seams (list/send), the hook env export
// (WUDAO_MSG_SOCKET/TOKEN), and the hold-outcome reports back to senders.
//
// Delivery rides the steering channel (M63-B's rail, the M61 cron track):
// takeInjection() is drained between tool calls mid-turn and starts a fresh
// turn when the frontend is idle — a delivery NEVER interrupts a running
// tool, and it is a turn-tail append, so the request prefix never moves.
//
// Inert shape: WUDAO_DISABLE_PEER=1, or sandbox without the socket override,
// yields a runtime carrying `refusal` — tools answer with it (fail-closed,
// never a silent no-op), no socket, no registry entry.
import { truncateSafe } from "@wudao-org/core"; // 113-A4
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { loadLayeredSettings } from "../settings-layer.js";
import { peerSend, startPeerInboxServer } from "./inbox.js";
import {
  createInboundEngine,
  formatReportNote,
  resolvePeerInboundSetting,
  type HeldPending,
  type PeerInboundMode,
} from "./inbound.js";
import {
  listLiveEntries,
  peerShortId,
  peerSocketPath,
  registerPeerSession,
  removeSocketFile,
  resolvePeerTarget,
  unregisterPeerSession,
  updatePeerSession,
  type PeerRegistryEntry,
} from "./registry.js";
import {
  PEER_DIALOG_EXPIRY_DEFAULT_MS,
  PEER_DISABLE_ENV,
  PEER_HOOK_SOCKET_ENV,
  PEER_HOOK_TOKEN_ENV,
  PEER_RATE_MAX,
  PEER_RATE_WINDOW_MS,
  PEER_SOCKET_ENV,
  PEER_TEXT_MAX_CHARS,
  PEER_UNREAD_CAP,
  newPeerMessageId,
  newPeerToken,
  type PeerAck,
  type PeerTier,
} from "./defs.js";

/** Where the runtime exposes its env to hook subprocesses (hooks-config
 *  re-adds these AFTER its credential scrub — the token is a capability
 *  handed to hooks BY DESIGN, spec §A). */
export const peerHookEnvBox: { current?: Record<string, string> } = {};

/** The approval-dialog data the frontend sink receives (HeldPending + the
 *  full text for preview rendering). */
export type HoldDialog = HeldPending & { readonly text: string };

export interface PeerRuntimeOptions {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  /** --name / a /rename value carried into the registry at start. */
  readonly name?: string;
  /** The session's live permission tier ("bypass" = mode auto). */
  readonly tier?: () => PeerTier;
  /** Explicitly resolved peerInbound (tests / callers that own settings). */
  readonly inboundSetting?: () => PeerInboundMode | undefined;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  /** Human-visible notice channel (holds, outcomes, refusals). */
  readonly notify?: (line: string) => void;
  /** Late-bound approval sink — the frontend/driver fills `current`; absent
   *  (or unfilled) holds sit until dialogExpiry (headless posture). */
  readonly approvalSink?: { current?: (held: HoldDialog) => Promise<boolean> };
  /** Auto-tier message review (the sidecar, when present): runs BEFORE a
   *  message is classified; a block denies delivery. */
  readonly reviewMessage?: (text: string, from: string) => Promise<boolean>;
  /** dialogExpiry: ms, or "never" (default 5min). */
  readonly dialogExpiryMs?: number | "never";
  /** True under --sandbox (the UDS inbox then requires WUDAO_PEER_SOCKET=1). */
  readonly sandboxed?: boolean;
  /** Test seam: skip the disable/sandbox guards. */
  readonly forceEnabled?: boolean;
}

export interface SendResult {
  readonly ok: boolean;
  /** The human/tool-facing line. */
  readonly line: string;
  readonly outcome: string;
  readonly target?: PeerRegistryEntry;
}

export interface PeerRuntime {
  /** Why the runtime is inert (kill switch / sandbox), when it is. */
  readonly refusal?: string;
  readonly sessionId: string;
  readonly socketPath: string | undefined;
  readonly token: string | undefined;
  /** The registration (undefined while inert). */
  readonly entry: PeerRegistryEntry | undefined;
  /** Late-bound approval sink (the driver fills it at creation). */
  readonly approvalSink: { current?: (held: HoldDialog) => Promise<boolean> };
  /** Steering-channel drain (between tool calls mid-turn; idle = new turn). */
  takeInjection(): string | undefined;
  /** The parked holds (approval dialog data: sender + preview + expiry). */
  pendingHolds(): readonly HeldPending[];
  /** Answer one hold (the approval dialog's y/n). False when unknown/gone. */
  answer(id: string, allow: boolean): boolean;
  /** Expire due holds (dialogExpiry) — the timer calls this; tests drive it
   *  with the injected clock. Returns the expired hold ids. */
  sweepHolds(now?: number): readonly string[];
  /** list_agents' data face (undefined while inert). */
  listAgents(): Promise<readonly PeerRegistryEntry[]>;
  /** send_message's data face (validation → resolve → socket → ack). */
  send(to: string, text: string): Promise<SendResult>;
  /** Follow a /rename (or --name) into the registry. */
  rename(name: string): Promise<void>;
  /** Set the session's permission tier — AUTHORITATIVE from the first call:
   *  moves the classification input AND the registry entry together (the
   *  driver's setMode and the REPL's mode cycle call it on every change). */
  setTier(tier: PeerTier): Promise<void>;
  /** Stop: close the inbox, unregister, clear timers. Idempotent. */
  stop(): Promise<void>;
}

/** The sandbox/disable gate: WUDAO_DISABLE_PEER=1 kills the surface; a
 *  sandboxed session (M21) keeps its UDS inbox OFF unless
 *  WUDAO_PEER_SOCKET=1 explicitly opts back in (--sandbox 的 unix-socket
 *  开关可禁). Pure. */
export function peerSocketRefusal(env: NodeJS.ProcessEnv, sandboxed: boolean): string | undefined {
  if ((env[PEER_DISABLE_ENV] ?? "").trim() === "1") return `peer messaging disabled (${PEER_DISABLE_ENV}=1)`;
  if (sandboxed && (env[PEER_SOCKET_ENV] ?? "").trim() !== "1") {
    return `peer messaging inbox disabled under --sandbox (set ${PEER_SOCKET_ENV}=1 to enable the unix socket)`;
  }
  return undefined;
}

/** Read settings `peerDialogExpiry` (layered effective): number (ms) |
 *  "never" | undefined (unset/invalid → the runtime default). One helper so
 *  every frontend construction honors the setting identically. */
export async function readPeerDialogExpiry(workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<number | "never" | undefined> {
  const layered = await loadLayeredSettings(workspaceRoot, () => {}, env).catch(() => undefined);
  const v = layered?.effective["peerDialogExpiry"];
  return v === "never" || (typeof v === "number" && Number.isFinite(v) && v > 0) ? (v as number | "never") : undefined;
}

/** Build the spec's "sidecar 在投递前审查消息" seam over a sidecar instance
 *  (structurally typed — no sidecar.ts import): classify the inbound text as
 *  `peer_message` with the untrusted provenance flag; only a LOW verdict
 *  passes (high/error deny — the sidecar's own fail-closed posture). */
export function sidecarMessageReview(
  sidecar: { readonly check: (tool: string, args: Record<string, unknown>, opts?: { readonly untrusted?: boolean }) => Promise<{ readonly kind: "low" | "high" | "error" }> },
): (text: string, from: string) => Promise<boolean> {
  return async (text, from) => (await sidecar.check("peer_message", { text, from }, { untrusted: true })).kind === "low";
}

/** Resolve the effective dialogExpiry: default 5min; "never" → undefined. */
export function effectiveDialogExpiry(v: number | "never" | undefined): number | undefined {
  if (v === "never") return undefined;
  if (v === undefined) return PEER_DIALOG_EXPIRY_DEFAULT_MS;
  return Number.isFinite(v) && v > 0 ? v : PEER_DIALOG_EXPIRY_DEFAULT_MS;
}

export async function createPeerRuntime(opts: PeerRuntimeOptions): Promise<PeerRuntime> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const notify = opts.notify ?? (() => {});
  const sessionId = opts.sessionId;
  const socketPath = peerSocketPath(sessionId, env);
  const token = newPeerToken();
  const dialogExpiry = effectiveDialogExpiry(opts.dialogExpiryMs);
  const approvalSink: { current?: (held: HoldDialog) => Promise<boolean> } = opts.approvalSink ?? {};

  const refusal = opts.forceEnabled === true ? undefined : peerSocketRefusal(env, opts.sandboxed === true);
  if (refusal !== undefined) return inertRuntime(refusal, sessionId);

  // The settings-backed inbound mode: layered (global < project < local)
  // with the refuse veto + cloneable-tier tightening rule (inbound.ts).
  // Refreshed before every inbound frame; cached 1s; the engine's sync
  // getSetting reads the cache.
  let cachedMode: PeerInboundMode | undefined;
  let cachedAt = -Infinity;
  const seenWarnings = new Set<string>();
  const refreshSettings = async (): Promise<void> => {
    if (now() - cachedAt < 1_000) return;
    if (opts.inboundSetting !== undefined) {
      cachedMode = opts.inboundSetting();
      cachedAt = now();
      return;
    }
    const layered = await loadLayeredSettings(opts.workspaceRoot, () => {}, env);
    const resolved = resolvePeerInboundSetting(
      layered.global["peerInbound"],
      layered.project["peerInbound"],
      layered.local["peerInbound"],
    );
    for (const w of resolved.warnings) {
      if (!seenWarnings.has(w)) {
        seenWarnings.add(w);
        notify(w);
      }
    }
    cachedMode = resolved.mode;
    cachedAt = now();
  };
  // Warm the cache so the first ingest classifies against a fresh read.
  await refreshSettings().catch(() => {});

  const baseTier = opts.tier ?? ((): PeerTier => "normal");
  // setTier() is AUTHORITATIVE once called: the override wins over the
  // constructor closure, so a mid-session mode change (the driver's setMode,
  // the REPL's cycle) moves BOTH the classification input and the registry
  // entry with one call — a frontend either wires setTier or passes a live
  // closure, never neither.
  let tierOverride: PeerTier | undefined;
  const tierFn = (): PeerTier => tierOverride ?? baseTier();

  // Registration (name uniqueness over the live set).
  let entry: PeerRegistryEntry | undefined;
  try {
    entry = await registerPeerSession({
      sessionId,
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      socket: socketPath,
      tier: tierFn(),
      workspaceRoot: opts.workspaceRoot,
      env,
      now,
    });
  } catch (err) {
    notify(`⚠️ peer 注册表不可用：${err instanceof Error ? err.message : String(err)}——消息保持仅本地`); // ω99-173: #1
  }

  // Hold-outcome reports ride back over the sender's own inbox. The report
  // carries the SENDER's original frame id (the receiver's held id is
  // private), so the sender's model can correlate delivered/denied/expired
  // with its own send.
  const sendReport = (to: { readonly sessionId: string; readonly name: string }, originId: string, outcome: "delivered" | "denied" | "expired"): void => {
    void (async () => {
      const live = await listLiveEntries(env).catch(() => [] as PeerRegistryEntry[]);
      const target = live.find((e) => e.sessionId === to.sessionId);
      if (target === undefined) return; // sender gone — nothing to report to
      await peerSend({
        socketPath: target.socket,
        auth: { type: "auth-peer", sender: { sessionId, name: entry?.name ?? sessionId, tier: tierFn() } },
        frames: [{ type: "report", messageId: originId, outcome, by: entry?.name ?? sessionId }],
      });
    })().catch(() => {});
  };

  const review = opts.reviewMessage;
  const engine = createInboundEngine({
    now,
    getSetting: () => cachedMode,
    getReceiverTier: tierFn,
    ...(dialogExpiry !== undefined ? { dialogExpiryMs: dialogExpiry } : {}),
    onHold: (msg) => {
      const pending = engine.pendingHolds().find((h) => h.id === msg.id);
      if (dialogExpiry !== undefined) {
        const t = setTimeout(() => engine.sweep(now()), dialogExpiry + 50);
        t.unref?.();
      }
      notify(`📬 来自 ${msg.senderName} 的 peer 消息已挂起（${peerShortId(msg.senderId)}，层级 ${msg.senderTier}）——等待批准`); // ω99-173: #2
      const sink = approvalSink.current;
      if (sink !== undefined && pending !== undefined) {
        void sink({ ...pending, text: msg.text })
          .then((allow) => {
            runtime.answer(msg.id, allow);
          })
          .catch(() => {
            /* a failed dialog is NOT a deny — dialogExpiry decides */
          });
      }
    },
    onOutcome: (msg, outcome) => {
      notify(
        outcome === "delivered"
          ? `📬 ${msg.senderName} 的挂起消息已批准——投递中` // ω99-173: #3
          : outcome === "denied"
            ? `🚫 ${msg.senderName} 的挂起消息已拒绝` // ω99-173: #4
            : `⌛ ${msg.senderName} 的挂起消息已过期（dialogExpiry）——已丢弃`, // ω99-173: #5
      );
      sendReport({ sessionId: msg.senderId, name: msg.senderName }, msg.originId ?? msg.id, outcome);
    },
  });

  let server: Awaited<ReturnType<typeof startPeerInboxServer>> | undefined;
  let stopped = false;
  try {
    // The bind must not depend on registration having created the run dir
    // (a failed registration still leaves a working inbox for DIRECT sends).
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 }).catch(() => {});
    server = await startPeerInboxServer({
      socketPath,
      token,
      onMessage: async (frame, ctx) => {
        await refreshSettings();
        // Effective sender tier: the REGISTRY entry (self-written at the
        // sender's startup) cross-checked against the declared tier — a
        // declared bypass on top of a registry entry still classifies as
        // bypass (claiming more privilege only buys the claimer a hold,
        // never an accept); no entry at all (raced unregister) → declared.
        let senderTier: PeerTier = ctx.sender?.tier ?? "normal";
        let senderName = ctx.sender?.name ?? "unknown";
        const senderId = ctx.sender?.sessionId ?? "unknown";
        if (ctx.sender !== undefined) {
          const live = await listLiveEntries(env).catch(() => [] as PeerRegistryEntry[]);
          const reg = live.find((e) => e.sessionId === senderId);
          if (reg !== undefined) {
            senderName = reg.name;
            senderTier = reg.tier === "bypass" || senderTier === "bypass" ? "bypass" : "normal";
          }
        }
        if (review !== undefined && !ctx.self) {
          const pass = await review(frame.text, `${senderName} (${peerShortId(senderId)})`).catch(() => true);
          if (!pass) {
            notify(`🛡 来自 ${senderName} 的 peer 消息被评审拦截——已拒绝`); // ω99-173: #6
            return { ok: false, outcome: "denied", detail: "blocked by receiver review" };
          }
        }
        return engine.ingest({
          senderId,
          senderName,
          senderTier,
          text: frame.text,
          kind: ctx.self ? "self" : "peer",
          ...(ctx.self ? {} : { originId: frame.id }),
        });
      },
      onReport: async (frame, ctx) => {
        await refreshSettings();
        // Reports arrive over the wire from PEERS (the sender's runtime
        // auths as a peer) — the same untrusted lane as messages: the
        // auto-tier review runs on them too (a crafted "report" is text the
        // model reads), and the note renders through the CONSTRAINED
        // template (formatReportNote sanitizes; the codec caps) — never the
        // raw payload. Self-sourced reports (own hooks) skip the review,
        // like self messages.
        if (review !== undefined && !ctx.self) {
          const note = formatReportNote(frame.by, frame.messageId, frame.outcome);
          const pass = await review(note, `report (${frame.by})`).catch(() => true);
          if (!pass) {
            notify(`🛡 来自 ${frame.by} 的 peer 回报被评审拦截——已拒绝`); // ω99-173: #7
            return { ok: false, outcome: "denied", detail: "blocked by receiver review" };
          }
        }
        return engine.ingest({
          senderId: "report",
          senderName: truncateSafe(frame.by, 24),
          senderTier: "normal",
          text: formatReportNote(frame.by, frame.messageId, frame.outcome),
          kind: "report", // runtime traffic: skip the peer throttle/dup lanes
        });
      },
    });
  } catch (err) {
    notify(`⚠️ peer 收件箱启动失败：${err instanceof Error ? err.message : String(err)}——消息接收已停用`); // ω99-173: #8
  }

  // Hook env: exposed for the session's subprocesses (loopback sends).
  if (server !== undefined) {
    peerHookEnvBox.current = { [PEER_HOOK_SOCKET_ENV]: socketPath, [PEER_HOOK_TOKEN_ENV]: token };
  }

  const runtime: PeerRuntime = {
    sessionId,
    socketPath: server !== undefined ? socketPath : undefined,
    token,
    entry,
    approvalSink,
    takeInjection: () => engine.takeInjection(),
    pendingHolds: () => engine.pendingHolds(),
    answer: (id, allow) => engine.answer(id, allow),
    sweepHolds: (at) => engine.sweep(at),
    listAgents: async () => (server === undefined ? [] : listLiveEntries(env)),
    send: async (to, text) => {
      const trimmedTo = to.trim();
      const trimmedText = text.trim();
      if (trimmedTo === "") return { ok: false, line: 'send_message: "to" is empty', outcome: "invalid" };
      if (trimmedText === "") return { ok: false, line: 'send_message: "text" is empty', outcome: "invalid" };
      if (trimmedText.length > PEER_TEXT_MAX_CHARS) {
        return { ok: false, line: `send_message: text exceeds ${PEER_TEXT_MAX_CHARS} chars (got ${trimmedText.length})`, outcome: "invalid" };
      }
      if (server === undefined) {
        return { ok: false, line: `send_message unavailable: ${refusal ?? "inbox not started"}`, outcome: "unavailable" };
      }
      const live = await listLiveEntries(env);
      const resolved = resolvePeerTarget(live, trimmedTo);
      if (!resolved.ok) {
        const candidates =
          resolved.candidates !== undefined && resolved.candidates.length > 1
            ? `\n${resolved.candidates.map((c) => `- ${c.name} (${peerShortId(c.sessionId)})`).join("\n")}`
            : "";
        return { ok: false, line: resolved.error + candidates, outcome: "unresolved" };
      }
      const target = resolved.entry;
      const isSelf = target.sessionId === sessionId;
      // The message id the sender's own model can correlate a later
      // delivered/denied/expired [peer report] against.
      const messageId = newPeerMessageId();
      const { acks } = await peerSend({
        socketPath: target.socket,
        auth: isSelf
          ? { type: "auth-self", token }
          : { type: "auth-peer", sender: { sessionId, name: entry?.name ?? sessionId, tier: tierFn() } },
        frames: [{ type: "message", id: messageId, sentAt: now(), text: trimmedText }],
      });
      const ack: PeerAck | undefined = acks[0];
      const who = `${target.name} (${peerShortId(target.sessionId)})`;
      if (ack === undefined) {
        return { ok: false, line: `send_message ${messageId}: no answer from ${who}`, outcome: "unreachable", target };
      }
      switch (ack.outcome) {
        case "accepted":
          return { ok: true, line: `message ${messageId} delivered to ${who} — queued for their next turn`, outcome: ack.outcome, target };
        case "held":
          return { ok: true, line: `message ${messageId} held by ${who} — awaiting their approval (a delivered/denied/expired report will arrive)`, outcome: ack.outcome, target };
        case "refused":
          return { ok: false, line: `${who} refused the message (their peerInbound policy — silent at their end)`, outcome: ack.outcome, target };
        case "duplicate":
          return { ok: false, line: `${who} dropped it as a short-window duplicate`, outcome: ack.outcome, target };
        case "throttled":
          return { ok: false, line: `${who} throttled you (per-sender limit: ${PEER_RATE_MAX}/${Math.round(PEER_RATE_WINDOW_MS / 1000)}s)`, outcome: ack.outcome, target };
        case "capped":
          return { ok: false, line: `${who} is at the unread cap (${PEER_UNREAD_CAP}) — try later`, outcome: ack.outcome, target };
        case "hold-capped":
          return { ok: false, line: `${who} is at the hold cap — denied outright`, outcome: ack.outcome, target };
        case "denied":
          return { ok: false, line: `${who} denied the message${ack.detail !== undefined ? ` (${ack.detail})` : ""}`, outcome: ack.outcome, target };
        default:
          return { ok: false, line: `message ${messageId} to ${who} failed: ${ack.outcome}${ack.detail !== undefined ? ` (${ack.detail})` : ""}`, outcome: ack.outcome, target };
      }
    },
    rename: async (name) => {
      const updated = await updatePeerSession({ sessionId, name, env });
      if (updated !== undefined) entry = updated;
    },
    setTier: async (tier) => {
      tierOverride = tier;
      const updated = await updatePeerSession({ sessionId, tier, env });
      if (updated !== undefined) entry = updated;
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (peerHookEnvBox.current?.[PEER_HOOK_SOCKET_ENV] === socketPath) peerHookEnvBox.current = undefined;
      await server?.close().catch(() => {});
      if (server === undefined) await removeSocketFile(socketPath);
      await unregisterPeerSession(sessionId, env);
    },
  };
  return runtime;
}

function inertRuntime(reason: string, sessionId: string): PeerRuntime {
  return {
    refusal: reason,
    sessionId,
    socketPath: undefined,
    token: undefined,
    entry: undefined,
    approvalSink: {},
    takeInjection: () => undefined,
    pendingHolds: () => [],
    answer: () => false,
    sweepHolds: () => [],
    listAgents: async () => [],
    send: async () => ({ ok: false, line: `send_message unavailable: ${reason}`, outcome: "unavailable" }),
    rename: async () => {},
    setTier: async () => {},
    stop: async () => {},
  };
}

