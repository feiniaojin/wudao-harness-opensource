// M64-A §A — the peer package's shared constants and pure helpers, one import
// site for every module (protocol shapes live in protocol.ts; this file owns
// the numeric policy knobs so inbound/runtime/tests never redeclare them —
// the 8k text cap is re-exported, not owned: protocol.ts defines it as an
// alias of core's MAIL_CONTENT_MAX_CHARS, the single source (ω99-67).
export {
  newPeerToken,
  newPeerMessageId,
  peerFingerprint,
  PEER_PROTOCOL_VERSION,
  PEER_FRAME_MAX_BYTES,
  PEER_TEXT_MAX_CHARS,
  PEER_FRAMES_PER_CONNECTION,
  type PeerTier,
  type PeerSenderDescriptor,
  type PeerFrame,
  type PeerAck,
  type PeerAckOutcome,
} from "./protocol.js";

/** 节流: per-sender sliding-window rate limit (messages). */
export const PEER_RATE_MAX = 20;
/** 节流: the rate window (ms). */
export const PEER_RATE_WINDOW_MS = 60_000;
/** 节流: same sender+text inside this window is a dropped duplicate (ms). */
export const PEER_DUP_WINDOW_MS = 30_000;
/** 待读上限: undelivered inbound ceiling (accept queue + holds). */
export const PEER_UNREAD_CAP = 50;
/** hold 上限: parked-hold ceiling; beyond it would-be holds are denied. */
export const PEER_HOLD_CAP = 100;
/** dialogExpiry default: 5 minutes; `peerDialogExpiry: "never"` disables. */
export const PEER_DIALOG_EXPIRY_DEFAULT_MS = 5 * 60_000;
/** Seconds of inactivity before a registry entry is lazily re-probed. */
export const PEER_LIVENESS_TTL_MS = 10_000;
/** Kill switch (mirrors WUDAO_DISABLE_CRON): no sockets, no registry, tools
 *  answer with the refusal — fail-closed, never a silent no-op. */
export const PEER_DISABLE_ENV = "WUDAO_DISABLE_PEER";
/** The --sandbox override: UDS inbox is OFF under sandbox unless this is "1". */
export const PEER_SOCKET_ENV = "WUDAO_PEER_SOCKET";
/** Hook-facing env (spec §A): the inbox socket + the self-loopback token. */
export const PEER_HOOK_SOCKET_ENV = "WUDAO_MSG_SOCKET";
export const PEER_HOOK_TOKEN_ENV = "WUDAO_MSG_TOKEN";

/** RESERVED (spec §A: 不做跨机中继,接口位保留). Cross-machine relay is out of
 *  scope — the peer runtime is machine-local by construction (a registry
 *  entry IS a unix socket on this host). The slot exists so a future relay
 *  can gate cross-machine traffic without reshaping the runtime; nothing
 *  implements or consumes it in this milestone. */
export interface IsolatePeerMachines {
  /** May a session on one machine message a session on another? (Project
   *  files may OPEN this, never close it — the the upstream formatrule.) */
  readonly allowsCrossMachine: (from: { readonly machine: string }, to: { readonly machine: string }) => boolean;
}
