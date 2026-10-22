// ω99-46 — the egress test base (brief §1.6): deterministic LOCAL stubs, one
// factory shared by the core egress suites and the providers acceptance test.
//
// - startHttpProxyStub: a node:http server on 127.0.0.1 that records every
//   proxy-form request it receives — absolute-URI requests (`GET
//   http://host/path`) for http targets and `CONNECT host:port` for https
//   targets — replying canned responses. `connectStatus` configures the
//   CONNECT reply (403 exercises the attribution path; 200 establishes the
//   tunnel).
// - startSocksProxyStub: a byte-level SOCKS5 server (no-auth greeting →
//   connect request → success/refusal reply) that then records the HTTP
//   request head sent through the tunnel and replies canned. `refuseReply`
//   makes the final socks reply REP=0x05 (connection refused) instead of 0x00.
//
// Targets use the reserved `.test` TLD so a DIRECT connection to them fails
// deterministically with ENOTFOUND — "did not go through the proxy" is
// observable without any real DNS. (A proxied request never resolves the
// target locally: CONNECT/socks carry the hostname BY NAME.)
import http from "node:http";
import net from "node:net";

export interface HttpProxyStub {
  readonly port: number;
  /** Every proxy-form request line received, in order. */
  readonly requests: readonly string[];
  /** The CONNECT reply status this stub currently sends (200 or 403). */
  connectStatus: number;
  /** The canned body for absolute-URI (http-target) requests. */
  responseBody: string;
  /** When true (default) the request URI is appended to the body — set
   *  false when the body must be pure JSON (provider acceptance). */
  appendUrl: boolean;
  readonly close: () => Promise<void>;
}

export async function startHttpProxyStub(opts: { readonly connectStatus?: number } = {}): Promise<HttpProxyStub> {
  const requests: string[] = [];
  const stub = {
    port: 0,
    requests,
    connectStatus: opts.connectStatus ?? 200,
    responseBody: "STUB-PROXY-OK",
    appendUrl: true,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  const server = http.createServer((req, res) => {
    // An http-target request arrives in proxy form: an ABSOLUTE URI.
    requests.push(`${req.method ?? "?"} ${req.url ?? "?"}`);
    const body = stub.appendUrl ? `${stub.responseBody} ${req.url ?? ""}` : stub.responseBody;
    res.writeHead(200, { "content-type": "text/plain", "content-length": String(Buffer.byteLength(body)) });
    res.end(body);
  });
  server.on("connect", (req, socket) => {
    requests.push(`CONNECT ${req.url ?? "?"}`);
    const status = stub.connectStatus;
    socket.write(`HTTP/1.1 ${status} ${status === 200 ? "Connection established" : "Forbidden"}\r\n\r\n`);
    if (status !== 200) {
      socket.destroy();
      return;
    }
    // status 200: the tunnel is established; the client's TLS to the fake
    // target can never complete, so cut the tunnel shortly after the
    // ClientHello lands — the CONNECT receipt is what tests assert, and the
    // request must fail fast instead of hanging to undici's headers timeout.
    const cut = setTimeout(() => socket.destroy(), 250);
    cut.unref?.();
    socket.on("close", () => clearTimeout(cut));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stub.port = (server.address() as net.AddressInfo).port;
  return stub;
}

export interface SocksProxyStub {
  readonly port: number;
  /** The socks CONNECT target the stub was asked to reach (`host:port`). */
  readonly targets: readonly string[];
  /** The HTTP request heads sent through established tunnels. */
  readonly httpHeads: readonly string[];
  /** Reply REP byte for the final socks reply: 0x00 success, 0x05 refused. */
  refuseReply: boolean;
  readonly close: () => Promise<void>;
}

export async function startSocksProxyStub(): Promise<SocksProxyStub> {
  const targets: string[] = [];
  const httpHeads: string[] = [];
  const stub = {
    port: 0,
    targets,
    httpHeads,
    refuseReply: false,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let greeted = false;
    let buffer = Buffer.alloc(0);
    let target = "";
    const onChunk = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!greeted) {
        // [VER=5, NMETHODS, METHODS...] → no-auth reply.
        if (buffer.length < 2) return;
        const n = buffer[1]!;
        if (buffer.length < 2 + n) return;
        buffer = buffer.subarray(2 + n);
        greeted = true;
        socket.write(Buffer.from([0x05, 0x00]));
      }
      if (target === "") {
        // [VER=5, CMD=1, RSV, ATYP, ADDR, PORT]
        if (buffer.length < 4) return;
        const atyp = buffer[3]!;
        let addrEnd = -1;
        if (atyp === 0x01) addrEnd = 4 + 4;
        else if (atyp === 0x03) {
          if (buffer.length < 5) return;
          addrEnd = 5 + buffer[4]!;
        } else if (atyp === 0x04) addrEnd = 4 + 16;
        else {
          socket.destroy();
          return;
        }
        if (buffer.length < addrEnd + 2) return;
        // ATYP=1: addr is bytes 4..8. ATYP=3: byte 4 is the length, addr is
        // 5..5+len (slicing from 4 would include the length byte itself).
        const addrBytes = atyp === 0x03 ? buffer.subarray(5, addrEnd) : buffer.subarray(4, addrEnd);
        const host = atyp === 0x01
          ? Array.from(addrBytes, (b) => String(b)).join(".")
          : atyp === 0x03
            ? addrBytes.toString("ascii")
            : "ipv6-target";
        const port = (buffer[addrEnd]! << 8) | buffer[addrEnd + 1]!;
        target = `${host}:${port}`;
        targets.push(target);
        buffer = buffer.subarray(addrEnd + 2);
        const rep = stub.refuseReply ? 0x05 : 0x00;
        socket.write(Buffer.from([0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        if (stub.refuseReply) {
          socket.destroy();
          return;
        }
        // An https target never sends an HTTP head through the tunnel — cut
        // it after a grace so the client's TLS fails fast instead of hanging
        // to its headers timeout.
        const cut = setTimeout(() => socket.destroy(), 250);
        cut.unref?.();
        socket.on("close", () => clearTimeout(cut));
      }
      if (buffer.length > 0) {
        // Tunnelled HTTP: keep the head up to the blank line.
        const text = buffer.toString("latin1");
        const end = text.indexOf("\r\n\r\n");
        if (end !== -1) {
          httpHeads.push(text.slice(0, end + 4));
          const body = "SOCKS-STUB-OK";
          socket.write(
            `HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`,
          );
          buffer = Buffer.alloc(0);
          socket.removeListener("data", onChunk as (c: Buffer) => void);
        }
      }
    };
    socket.on("data", onChunk);
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stub.port = (server.address() as net.AddressInfo).port;
  return stub;
}
