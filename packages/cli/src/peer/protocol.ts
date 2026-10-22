// M64-A §A — the peer-messaging wire protocol: newline-delimited JSON frames
// over a per-session UDS inbox. Pure (no sockets, no fs, no env reads): the
// shapes, the frame codec, and the ack vocabulary every side speaks.
//
// Protocol (v1), one connection per send:
//   client → server, line 1 (AUTH):   {"v":1,"type":"auth-peer","sender":{…}}
//                                     {"v":1,"type":"auth-self","token":"…"}
//   client → server, line 2 (frame):  {"v":1,"type":"message",…} | {"v":1,"type":"report",…}
//   server → client, per frame (ack): {"v":1,"type":"ack","ok":true,"outcome":"…"}
//
// AUTH classes:
//   • auth-peer — another wudao session. The OS-user boundary (0700 run dir,
//     0600 socket) is the transport trust; the declared sender descriptor is
//     cross-checked against the on-disk registry by the receiver.
//   • auth-self — THIS session's own subprocess (a hook holding
//     WUDAO_MSG_SOCKET + WUDAO_MSG_TOKEN). The token first-frame proves the
//     loopback; self frames skip the peer tier classification (operator
//     configured the hook) but their TEXT keeps the untrusted content rules —
//     the same posture as hook stdout anywhere else.
import { truncateSafe } from "@wudao/core"; // 113-A4
import { createHash, randomBytes, randomInt } from "node:crypto";
import { MAIL_CONTENT_MAX_CHARS } from "@wudao/core";

/** The peer permission tier: "bypass" = the session runs with the ask layer
 *  off (mode "auto" — the local equivalent of the upstream's bypassPermissions). */
export type PeerTier = "bypass" | "normal";

export interface PeerSenderDescriptor {
  readonly sessionId: string;
  readonly name: string;
  readonly tier: PeerTier;
}

export type PeerFrame =
  | { readonly type: "auth-peer"; readonly sender: PeerSenderDescriptor }
  | { readonly type: "auth-self"; readonly token: string }
  | { readonly type: "message"; readonly id: string; readonly sentAt: number; readonly text: string }
  | {
      readonly type: "report";
      /** The SENDER's original message-frame id (the receiver's engine
       *  carries it as InboundMessage.originId; the receiver's own held id
       *  is private and never leaves the process). Sanitized + capped by
       *  the codec — it is attacker-shaped free text on the wire. */
      readonly messageId: string;
      readonly outcome: "delivered" | "denied" | "expired";
      /** The reporting session's name (sanitized + capped). */
      readonly by: string;
    };

/** The ack outcome vocabulary. `ok:true` only for accepted/held — everything
 *  else is a final refusal the sender's tool reports verbatim. */
export type PeerAckOutcome =
  | "accepted" // queued for delivery (accept path / report / self)
  | "held" // parked pending human approval (dialogExpiry applies)
  | "refused" // inbound policy said no (silent at the receiver)
  | "duplicate" // short-window duplicate dropped
  | "throttled" // per-sender rate limit hit
  | "capped" // unread cap (50) reached
  | "hold-capped" // hold queue cap (100) reached — denied outright
  | "denied" // the human (or a cap) denied it after hold
  | "unreachable" // client-side: no listener at the socket (sender-side only)
  | "unauthorized" // bad/missing auth first frame
  | "bad-frame" // unparseable frame / oversize / wrong shape
  | "self-loop" // sender-side: sending to yourself uses the self path, not peer

export interface PeerAck {
  readonly ok: boolean;
  readonly outcome: PeerAckOutcome;
  readonly detail?: string;
}

export const PEER_PROTOCOL_VERSION = 1;
/** Hard bound on one frame line (auth + message): a peer must not be able to
 *  balloon the receiver's memory. Inbound text is separately capped. */
export const PEER_FRAME_MAX_BYTES = 64 * 1024;
/** Inbound message text cap (commands arrive as PLAIN TEXT — bounded text,
 *  never structured payloads). Single-sourced from the mail constitution
 *  (ω99-67): the value is MAIL_CONTENT_MAX_CHARS via @wudao/core — the
 *  name stays (export ABI), the local 8k literal is gone. */
export const PEER_TEXT_MAX_CHARS = MAIL_CONTENT_MAX_CHARS;
/** Messages per connection before the receiver closes it (protocol abuse
 *  guard; the throttle is per-sender, this is per-connection). */
export const PEER_FRAMES_PER_CONNECTION = 100;

/** One fresh 32-hex session token (the WUDAO_MSG_TOKEN value). */
export function newPeerToken(): string {
  return randomBytes(16).toString("hex");
}

/** One fresh message id: 12 [a-z0-9] chars (receiver-side held ids). */
export function newPeerMessageId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 12; i += 1) out += alphabet[randomInt(alphabet.length)];
  return out;
}

const asString = (v: unknown): string => (typeof v === "string" ? v : "");
const asTier = (v: unknown): PeerTier => (v === "bypass" ? "bypass" : "normal");

/** Bound an attacker-shaped identifier before it can ride into any
 *  model-facing note: one line, no control chars, capped. */
const PEER_ID_MAX_CHARS = 64;
function sanitizeId(v: unknown): string {
  return asString(v).replace(/[\r\n\t]+/g, " ").replace(/[^\x20-\x7e]/g, "").trim().slice(0, PEER_ID_MAX_CHARS);
}

function parseSender(v: unknown): PeerSenderDescriptor | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const s = v as Record<string, unknown>;
  const sessionId = asString(s.sessionId);
  const name = asString(s.name);
  if (sessionId === "" || name === "") return undefined;
  return { sessionId, name, tier: asTier(s.tier) };
}

/** Parse one wire line into a frame; undefined = not a valid v1 frame (the
 *  connection is a bad-frame). Never throws. */
export function parsePeerFrame(line: string): PeerFrame | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const f = parsed as Record<string, unknown>;
  if (f.v !== PEER_PROTOCOL_VERSION) return undefined;
  switch (f.type) {
    case "auth-peer": {
      const sender = parseSender(f.sender);
      return sender === undefined ? undefined : { type: "auth-peer", sender };
    }
    case "auth-self":
      return asString(f.token) === "" ? undefined : { type: "auth-self", token: asString(f.token) };
    case "message": {
      const id = asString(f.id);
      const text = asString(f.text);
      const sentAt = typeof f.sentAt === "number" && Number.isFinite(f.sentAt) ? f.sentAt : 0;
      if (id === "" || text === "") return undefined;
      return { type: "message", id, sentAt, text: truncateSafe(text, PEER_TEXT_MAX_CHARS) };
    }
    case "report": {
      const messageId = sanitizeId(f.messageId);
      const by = sanitizeId(f.by);
      const outcome = f.outcome === "delivered" || f.outcome === "denied" || f.outcome === "expired" ? f.outcome : undefined;
      if (messageId === "" || outcome === undefined) return undefined;
      return { type: "report", messageId, outcome, by };
    }
    default:
      return undefined;
  }
}

export function formatPeerFrame(frame: PeerFrame): string {
  const body =
    frame.type === "auth-peer"
      ? { sender: frame.sender }
      : frame.type === "auth-self"
        ? { token: frame.token }
        : frame.type === "message"
          ? { id: frame.id, sentAt: frame.sentAt, text: frame.text }
          : { messageId: frame.messageId, outcome: frame.outcome, by: frame.by };
  return `${JSON.stringify({ v: PEER_PROTOCOL_VERSION, type: frame.type, ...body })}\n`;
}

export function formatPeerAck(ack: PeerAck): string {
  return `${JSON.stringify({ v: PEER_PROTOCOL_VERSION, type: "ack", ok: ack.ok, ...(ack.detail !== undefined ? { detail: ack.detail } : {}), outcome: ack.outcome })}\n`;
}

export function parsePeerAck(line: string): PeerAck | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const f = parsed as Record<string, unknown>;
  if (f.type !== "ack") return undefined;
  const rawOutcome = asString(f.outcome);
  if (rawOutcome === "") return undefined;
  const rawDetail = asString(f.detail);
  return { ok: f.ok === true, outcome: rawOutcome as PeerAckOutcome, ...(rawDetail !== "" ? { detail: rawDetail } : {}) };
}

/** Stable non-cryptographic digest for the duplicate-drop window (sender+text). */
export function peerFingerprint(senderId: string, text: string): string {
  return createHash("sha256").update(`${senderId}\0${text}`).digest("hex").slice(0, 32);
}
