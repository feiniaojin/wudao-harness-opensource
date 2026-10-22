// M64-A §A — the per-session UDS inbox: a small net.Server per session and
// the matching one-shot client. Newline-delimited JSON frames (protocol.ts);
// the FIRST frame must authenticate (auth-peer with the sender descriptor,
// or auth-self with the session token — the spec's "自身子进程回投经 token
// 首帧行认证"). Every message frame is answered with exactly one ack line.
// Bounded everywhere: frame bytes, frames per connection, connection backlog.
import { connect, createServer, type Socket } from "node:net";
import { chmod, unlink } from "node:fs/promises";
import {
  PEER_FRAMES_PER_CONNECTION,
  PEER_FRAME_MAX_BYTES,
  formatPeerAck,
  formatPeerFrame,
  parsePeerAck,
  parsePeerFrame,
  type PeerAck,
  type PeerFrame,
  type PeerSenderDescriptor,
} from "./protocol.js";

export const PEER_CONNECT_TIMEOUT_MS = 2_000;

export interface InboxMessageContext {
  /** auth-peer: the declared sender (registry cross-check is the caller's). */
  readonly sender?: PeerSenderDescriptor;
  /** auth-self: the connection proved the session token. */
  readonly self: boolean;
}

export interface PeerInboxServer {
  readonly socketPath: string;
  close(): Promise<void>;
}

export interface PeerInboxServerOptions {
  readonly socketPath: string;
  /** The session token; an auth-self frame carrying it is marked `self`. */
  readonly token: string;
  /** Handle one message frame; the returned ack is written back. */
  readonly onMessage: (frame: Extract<PeerFrame, { type: "message" }>, ctx: InboxMessageContext) => Promise<PeerAck>;
  /** Handle one report frame (a hold outcome report from another runtime). */
  readonly onReport: (frame: Extract<PeerFrame, { type: "report" }>, ctx: InboxMessageContext) => Promise<PeerAck>;
}

/** Start the inbox server. Resolves once listening; the socket file is
 *  chmod 0600 (the 0700 run dir is the outer boundary). Never rejects —
 *  listen errors surface via the returned server's close/`error` handling by
 *  the runtime (which degrades to refuse-all acks). */
export async function startPeerInboxServer(opts: PeerInboxServerOptions): Promise<PeerInboxServer> {
  const connections = new Set<Socket>();
  const server = createServer((sock) => {
    connections.add(sock);
    sock.on("close", () => connections.delete(sock));
    sock.on("error", () => connections.delete(sock));
    let buffer = "";
    let authed: InboxMessageContext | undefined;
    let frames = 0;
    const fail = (outcome: PeerAck["outcome"], detail?: string): void => {
      sock.write(formatPeerAck({ ok: false, outcome, ...(detail !== undefined ? { detail } : {}) }));
      sock.end();
    };
    sock.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      // Oversize guard: a frame bigger than the cap aborts the connection.
      if (buffer.length > PEER_FRAME_MAX_BYTES * 2) {
        fail("bad-frame", "oversize");
        return;
      }
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim() !== "") void handleLine(line);
        nl = buffer.indexOf("\n");
      }
    });
    const handleLine = (line: string): void => {
      if (line.length > PEER_FRAME_MAX_BYTES) {
        fail("bad-frame", "oversize");
        return;
      }
      const frame = parsePeerFrame(line);
      if (frame === undefined) {
        fail("bad-frame");
        return;
      }
      // First frame: auth.
      if (authed === undefined) {
        if (frame.type === "auth-peer") {
          authed = { sender: frame.sender, self: false };
          return;
        }
        if (frame.type === "auth-self") {
          // Constant-time-ish compare is unnecessary (local transport), but a
          // plain === on a random 32-hex token is unguessable either way.
          if (frame.token === opts.token) {
            authed = { self: true };
            return;
          }
          fail("unauthorized", "bad token");
          return;
        }
        fail("unauthorized", "first frame must authenticate");
        return;
      }
      // Authed frames: message | report only.
      frames += 1;
      if (frames > PEER_FRAMES_PER_CONNECTION) {
        fail("bad-frame", "too many frames");
        return;
      }
      if (frame.type === "message") {
        void opts
          .onMessage(frame, authed)
          .catch((err): PeerAck => ({ ok: false, outcome: "bad-frame", detail: err instanceof Error ? err.message : String(err) }))
          .then((ack) => {
            if (!sock.destroyed) sock.write(formatPeerAck(ack));
          });
        return;
      }
      if (frame.type === "report") {
        void opts
          .onReport(frame, authed)
          .catch((): PeerAck => ({ ok: false, outcome: "bad-frame" }))
          .then((ack) => {
            if (!sock.destroyed) sock.write(formatPeerAck(ack));
          });
        return;
      }
      fail("bad-frame", "unexpected frame");
    };
  });
  // A stale socket file from a crashed session would EADDRINUSE — remove it,
  // then bind (a live same-path listener refuses the bind: EADDRINUSE, which
  // the caller surfaces — two same-id sessions is a bug, never a takeover).
  const listening = new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", (err) => reject(err));
  });
  // win32: the inbox listens on a named pipe (peerSocketPath) — no stale
  // socket FILE to clear and no chmod (the pipe namespace is per-user).
  if (process.platform !== "win32") {
    await unlink(opts.socketPath).catch(() => {});
  }
  server.listen(opts.socketPath);
  await listening;
  if (process.platform !== "win32") {
    await chmod(opts.socketPath, 0o600).catch(() => {});
  }
  return {
    socketPath: opts.socketPath,
    close: async () => {
      for (const c of connections) c.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // An un-connected server closes immediately; safety timeout either way.
        setTimeout(() => resolve(), 200).unref?.();
      });
      if (process.platform !== "win32") {
        await unlink(opts.socketPath).catch(() => {});
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The client (one connection, one message)
// ---------------------------------------------------------------------------

export interface PeerSendOptions {
  readonly socketPath: string;
  /** auth-self when sending to THIS session's own inbox (the tool's self
   *  path and hook loopback); otherwise auth-peer with the descriptor. */
  readonly auth: PeerFrame;
  readonly frames: readonly PeerFrame[];
  readonly timeoutMs?: number;
}

/** Connect, auth, send each frame, collect one ack per frame. Client-side
 *  failures (no listener, timeout, bad auth reply) resolve — never throw —
 *  with the matching non-ok outcome so the tool can report it. */
export function peerSend(opts: PeerSendOptions): Promise<{ readonly acks: readonly PeerAck[] }> {
  const timeoutMs = opts.timeoutMs ?? PEER_CONNECT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const sock = connect(opts.socketPath);
    const acks: PeerAck[] = [];
    let buffer = "";
    let expected = opts.frames.length;
    const finish = (): void => {
      sock.destroy();
      resolve({ acks });
    };
    const timer = setTimeout(() => {
      if (acks.length === 0) acks.push({ ok: false, outcome: "unreachable", detail: "timeout" });
      finish();
    }, timeoutMs);
    timer.unref?.();
    sock.on("error", (err) => {
      clearTimeout(timer);
      acks.push({
        ok: false,
        outcome: "unreachable",
        detail: err instanceof Error ? err.message : String(err),
      });
      finish();
    });
    sock.on("connect", () => {
      sock.write(formatPeerFrame(opts.auth));
      for (const frame of opts.frames) sock.write(formatPeerFrame(frame));
    });
    sock.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const ack = parsePeerAck(line);
        if (ack !== undefined) acks.push(ack);
        if (acks.length >= expected) {
          clearTimeout(timer);
          finish();
          return;
        }
        nl = buffer.indexOf("\n");
      }
    });
    sock.on("close", () => {
      clearTimeout(timer);
      if (acks.length === 0) {
        acks.push({ ok: false, outcome: "unreachable", detail: "closed before ack" });
      }
      finish();
    });
  });
}
