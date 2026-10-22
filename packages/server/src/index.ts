// @wudao/server — the localhost WS protocol server for an AgentDriver (M43-A
// §2). node:http serves the static frontend (placeholder when absent) and
// carries the WS endpoint; `ws` is the ONLY new runtime dependency. The server
// is transport-only: it relays the driver's two channels (append-only history,
// small full-snapshot status) and ops, and owns none of the agent logic — the
// driver is injected as the structural UiDriverPort below (the CLI's
// AgentDriver satisfies it; this package never imports the CLI, keeping the
// workspace graph acyclic).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
// ω99-242 — the crash-recovery coordinator's server-facing slice + the
// status row type (the recoveryStatus op's reply shape). The coordinator
// itself lives in recovery.ts; this file only mounts it like petDriver.
import type { RecoveryStatusRow } from "./recovery.js";

export type {
  RecoveryJournalEntry,
  RecoveryJournalFold,
  FoldSessionState,
  RecoveryObservation,
  RecoveryClassification,
  RecoverySettle,
  RecoveryPort,
  RecoveryStatusRow,
  RecoveryCoordinatorOptions,
  RecoveryCoordinator,
} from "./recovery.js";
export {
  createRecoveryJournal,
  foldRecoveryLines,
  classifyRecovery,
  createRecoveryCoordinator,
  RECOVERY_INTERVAL_MS,
  RECOVERY_CONCURRENCY,
  RECOVERY_ROTATION_BOUND,
} from "./recovery.js";

/** Loopback hostnames the Host header may carry (DNS-rebinding guard). */
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Close codes (documented in PROTOCOL.md). */
const CLOSE_WRONG_HOST = 4403;
const CLOSE_AUTH_FAILED = 4401;
const CLOSE_SINGLE_CLIENT = 4000;

/** ω99-225: the resume verdict relayed verbatim — a structural mirror of the
 *  CLI's ResumeOutcome (this package never imports the CLI; the shapes are
 *  kept identical by the twin tests in each package). `occupied` carries the
 *  live lease holder's pid so the web can tell a busy session from a missing
 *  one instead of guessing off the old bare boolean. */
import {
  PET_LANE_SESSION_ID,
  PetHistoryTurnWire,
  ResumeOutcome,
  UiDriverPort,
  UiPetDriverPort,
  UiRecoveryPort,
  type LaneDriverPort,
} from "./ports.js";
export type { ResumeOutcome, UiDriverPort, UiPetDriverPort, UiRecoveryPort, PetHistoryTurnWire, LaneDriverPort } from "./ports.js";
// 多 driver 并发弧 B —— 车道表（lane table）：driver 具名槽泛化为
// main + 副车道（key=sessionId）的可寻址集合；装配/订阅簿记在 lanes.ts。
import { assertMountableLaneSid, createLaneTable, MAIN_LANE_SID, type LaneTable } from "./lanes.js";
import { petTurnsFromHistory } from "./pet-turns.js";
export { PET_LANE_SESSION_ID } from "./ports.js";
// 拆分运动（借鉴弧 δ 顺带件，file-size 棘轮）：petTurnsFromHistory 纯函数
// 外提至 pet-turns.ts（逐字节搬家；本行 re-export 维持既有公共面）。
export { petTurnsFromHistory } from "./pet-turns.js";

export interface UiServerOptions {
  readonly driver: UiDriverPort;
  /** ω99-235: the pet lane's driver (the desktop sprite's own isolated
   *  session — the narrow surface the pet ops and the state frame's `pet`
   *  field need). OPTIONAL like the settings ops: absent → petSubmit/
   *  petInterrupt/petAnswerPermission answer a clean "pet ops not supported
   *  by this driver", state frames carry no `pet` field (old-server shape),
   *  and the web relay degrades to the main lane — today's single-lane
   *  behavior, byte-identical. */
  readonly petDriver?: UiPetDriverPort;
  /** ω99-242 — the crash-recovery coordinator (boot 时观察-分类-认领-限流恢复
   *  的服务面挂载). OPTIONAL like petDriver: absent → the recoveryStatus op
   *  answers "recovery not supported by this server", the submit op's
   *  invalidation call is skipped, and the orphan self-exit exits exactly as
   *  before (byte-identical legacy behavior). */
  readonly recovery?: UiRecoveryPort;
  /** 多 driver 并发弧 B —— 副车道表（key=sessionId）：同一宿主进程并发的
   *  第二…第 N 个 driver 会话（每车道独立会话/租约/run）。OPTIONAL like
   *  petDriver：缺省（undefined/空表）= 今日单车道行为字节不变——状态帧
   *  无 lanes 字段、历史帧无 sid、写 op 无 sid 路由。挂载后：状态帧携带
   *  lanes（副车道状态映射）、副车道历史帧带 sid、七个交互写 op（submit/
   *  interrupt/setMode/answerPermission/recallSteer/answerAskUser/
   *  detachToolCall）接受可选 sid 寻址（见 PROTOCOL.md Lanes 节）。key 不得
   *  为保留字 "main"/"pet"（构造期 fail-closed 拒——pet 车道走 petDriver
   *  具名槽与 petXxx op 面，不参与 sid 寻址）。 */
  readonly laneDrivers?: ReadonlyMap<string, LaneDriverPort>;
  /** 0.4.0 集成缝：车道工厂——resume 带 sid 且车道未挂时调用（返回该车道
   *  的 driver port）。缺省=未挂的 sid 干净拒（弧 B 原行为）。ui.ts 传入
   *  LaneManager 的 open 工厂即可打通「web 发 resume {id,sid} → 副车道
   *  自动创建」的并发链路。 */
  readonly laneFactory?: (sessionId: string, sid: string) => Promise<LaneDriverPort>;
  /** PB-2 — 探针遥测 bus（OPTIONAL like petDriver：缺省=三 op 干净拒答、零
   *  probe 帧、零订阅，字节形状不变）。 */
  readonly probeBus?: UiProbeBusPort;
  /** TCP port; 0 (default) picks a free ephemeral port. */
  readonly port?: number;
  /** Bind address — loopback only; anything else is refused (fail-closed). */
  readonly host?: string;
  /** The built web frontend's directory; absent → the protocol placeholder. */
  readonly staticDir?: string;
  /** Shared-secret; generated (32B, base64url) when absent. Never in a URL
   *  query or the process list — only the printed fragment carries it. */
  readonly token?: string;
  /** First-frame auth window (default 5000ms). */
  readonly authTimeoutMs?: number;
  /** Heartbeat interval for ws ping/pong (default 30000ms). */
  readonly pingIntervalMs?: number;
  /** Accepted setMode values (default: the harness's three modes). */
  readonly modes?: readonly string[];
  /** ω-3a: the mutation idempotency vault's knobs (TTL / entry cap / clock
   *  seam — tests inject a mutable clock). Defaults: 5 min, 256 entries,
   *  Date.now. */
  readonly idempotency?: {
    readonly ttlMs?: number;
    readonly maxEntries?: number;
    readonly now?: () => number;
  };
  // ω99-225 — the orphan sidecar's self-exit seams (tests inject all
  // three; production runs the byte-stable defaults). A sidecar whose parent
  // app crashed/force-quit never ran its exit cleanup — it holds live session
  // leases forever and every later resume of those sessions is refused. The
  // sweep lives in the EXISTING pinger interval (no new timer): parent gone
  // (ppid reparented to 1 — POSIX semantics, the desktop's current form) AND
  // no authenticated client for `orphanGraceMs` → one stderr receipt + exit(0).
  /** Parent-pid probe (default `() => process.ppid`). 1 = orphaned. */
  readonly getPpid?: () => number;
  /** Exit seam (default `process.exit`) — the sweep calls exit(0). */
  readonly exit?: (code: number) => void;
  /** Zero-client grace before the orphan exits (default 20000ms). */
  readonly orphanGraceMs?: number;
}

export interface UiServer {
  readonly port: number;
  readonly token: string;
  readonly url: string;
  /** 多 driver 弧 B —— 开：运行时挂载一条副车道（订阅状态/史中继 + 推一帧
   *  状态——lanes 字段增行）。同 sid 同 driver 幂等；换 driver 原子替换；
   *  保留字（"main"/"pet"）与坏形状 throw（fail-closed）。 */
  mountLane(sid: string, driver: LaneDriverPort): void;
  /** 多 driver 弧 B —— 关：卸载一条副车道（退订 + 删表 + 推一帧状态）。
   *  返回是否确有关闭：未挂的 sid 与 "main" 恒 false（幂等）。 */
  closeLane(sid: string): boolean;
  close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// Host header → hostname (strip the :port; keep the bracketed v6 form).
function hostName(host: string | undefined): string {
  if (host === undefined) return "";
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  const idx = host.indexOf(":");
  return idx === -1 ? host : host.slice(0, idx);
}

// ω-3a — the mutation idempotency vault (adapted from the upstream project's WS vault,
// channels/websocket/runtime.py: _WebUIRequestOperation + the request map).
// Client MUTATIONS carrying a client-instance qualifier are keyed by
// `cid` + the op envelope's id: a retry with the same payload digest JOINS
// the in-flight execution (never re-executes), a retry after completion
// replays the cached result, and the same id with a different payload gets
// an explicit conflict error. Reads are NEVER vaulted — a TTL-cached read
// would serve stale data (the vault is for exactly-once side effects, not
// freshness); ops without a cid (old clients) keep today's behavior.
// 多 driver 并发弧 B 的顺带件（file-size 棘轮：index.ts 白名单帽只收不
// 涨）：isVaultedMutation / canonicalJson / VaultEntry 三段纯函数/类型外提
// 至 vault.ts（逐字节搬家），re-export 门面维持既有公共面。
import { canonicalJson, isVaultedMutation, type VaultEntry } from "./vault.js";
export { isVaultedMutation } from "./vault.js";
// PB-2（探针基础设施弧）— ProbeBus 的 WS 中继（三读面 op + {t:"probe"} 帧）。
import { createProbeRelay, type UiProbeBusPort } from "./probe.js";
export type { ProbeEventWire, UiProbeBusPort, ProbeCat } from "./probe.js";

export async function createUiServer(opts: UiServerOptions): Promise<UiServer> {
  const host = opts.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(`wudao ui refuses to bind ${host}: loopback only (v1-A)`);
  }
  // 多 driver 弧 B —— 副车道 key 的构造期校验（host 校验同位、同族：任何
  // 保留字/坏形状都在开端口之前拒，绝不带病上车）。
  for (const sid of opts.laneDrivers?.keys() ?? []) assertMountableLaneSid(sid);
  const token = opts.token ?? randomBytes(32).toString("base64url");
  const authTimeoutMs = opts.authTimeoutMs ?? 5_000;
  const pingIntervalMs = opts.pingIntervalMs ?? 30_000;
  const modes = opts.modes ?? ["workspace", "ask", "auto", "plan"];
  const idemTtlMs = opts.idempotency?.ttlMs ?? 300_000;
  const idemMaxEntries = opts.idempotency?.maxEntries ?? 256;
  const idemNow = opts.idempotency?.now ?? ((): number => Date.now());
  // ω99-225: byte-stable defaults — with no injection the ONLY new behavior
  // is the orphan condition firing (a live app never trips it: its sidecar's
  // ppid is the app, hidden-tray webviews keep their WS, and a booting app
  // holds ppid != 1 through the connect window).
  const getPpid = opts.getPpid ?? ((): number => process.ppid);
  const exitFn = opts.exit ?? ((code: number): void => process.exit(code));
  const orphanGraceMs = opts.orphanGraceMs ?? 20_000;

  // ω-3a — the vault itself. Keyed by `<cid>:<op id>`: the envelope's id is
  // per-client-process monotonic (a page reload restarts it at 1), so the
  // client-instance qualifier keeps a reloaded page from joining or
  // conflicting with the previous page's ops. In-memory by design (a server
  // restart loses it — same trade as the upstream project; the client replays and the op
  // simply re-executes). Pruned lazily on access: no timers to unref.
  const vault = new Map<string, VaultEntry>();
  const pruneVault = (): void => {
    const now = idemNow();
    for (const [key, entry] of vault) {
      if (entry.done && entry.completedAt !== null && now - entry.completedAt >= idemTtlMs) {
        vault.delete(key);
      }
    }
    const completed = [...vault.entries()]
      .filter(([, entry]) => entry.done && entry.completedAt !== null)
      .sort(([, a], [, b]) => (a.completedAt as number) - (b.completedAt as number));
    for (const [key] of completed.slice(0, Math.max(0, completed.length - idemMaxEntries))) {
      vault.delete(key);
    }
  };

  // The one authenticated client slot (v1-A: single connection; a second
  // client is rejected with a reason). Reconnects re-run the auth handshake
  // and get a full history replay.
  let client: WebSocket | null = null;
  const send = (frame: unknown): void => {
    if (client !== null && client.readyState === WebSocket.OPEN) client.send(JSON.stringify(frame));
  };
  const probeRelay = createProbeRelay({ bus: opts.probeBus, send });

  // ω99-225 — orphan bookkeeping. authedConnections counts AUTHED
  // sockets (v1-A: 0 or 1 — a rejected second client or an auth-timeout close
  // never counts); orphanArmedAt stamps the moment that count hit zero. It is
  // armed from BOOT too, so a sidecar whose app died between spawn and the
  // first connect still self-exits; every auth disarms (a tray-hidden
  // webview's WS keeps it disarmed — main.rs hides the window, never kills
  // the page).
  let authedConnections = 0;
  let orphanArmedAt: number | null = Date.now();

  const http: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!ALLOWED_HOSTS.has(hostName(req.headers.host))) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("forbidden: unrecognized Host");
      return;
    }
    void handleStatic(req, res, opts.staticDir);
  });

  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => {
    if (!ALLOWED_HOSTS.has(hostName(req.headers.host))) {
      socket.write(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket) => {
    let authed = false;
    if (client !== null && client.readyState === WebSocket.OPEN) {
      ws.close(CLOSE_SINGLE_CLIENT, "another client is already connected");
      return;
    }
    const authTimer = setTimeout(() => {
      if (!authed) ws.close(CLOSE_AUTH_FAILED, "auth timeout");
    }, authTimeoutMs);
    authTimer.unref?.();

    ws.on("message", (data) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(data));
      } catch {
        if (!authed) ws.close(CLOSE_AUTH_FAILED, "first frame must be JSON auth");
        return;
      }
      if (!authed) {
        // First frame MUST be the shared-secret auth. Browsers cannot set
        // custom WS headers, so the token rides the URL fragment and the page
        // JS sends it here — it never appears in any request line.
        if (typeof frame === "object" && frame !== null && (frame as { t?: unknown }).t === "auth" &&
            (frame as { token?: unknown }).token === token) {
          authed = true;
          clearTimeout(authTimer);
          client = ws;
          // ω99-225: a live client disarms the orphan sweep (reconnect
          // within the grace window is the normal app restart flap).
          authedConnections += 1;
          orphanArmedAt = null;
          // ω99-235: #5 — the post-auth initial state frame rides the same
          // dual-lane push (#4): a reconnecting client gets BOTH statuses.
          pushState();
          send({ t: "history", entries: opts.driver.getHistory(), reset: true });
          // 多 driver 弧 B —— 副车道的初始重放：带 sid + reset，紧跟主车道
          // 重放之后（lane-aware 客户端据此恢复每车道转录；主车道帧不带 sid
          // ——重连语义与今日字节不变）。无副车道时零帧（缺省零变化）。
          for (const r of laneTable.replay()) {
            send({ t: "history", entries: r.entries, reset: true, sid: r.sid });
          }
          return;
        }
        clearTimeout(authTimer);
        ws.close(CLOSE_AUTH_FAILED, "unauthenticated");
        return;
      }
      handleFrame(frame, ws);
    });

    ws.on("pong", () => {
      (ws as WebSocket & { alive?: boolean }).alive = true;
    });
    ws.on("close", () => {
      clearTimeout(authTimer);
      if (client === ws) client = null;
      // ω99-225: only an AUTHED connection was counted — its close re-arms
      // the orphan clock (a fresh timestamp, so a flap never inherits the
      // previous drop's elapsed grace).
      if (authed) {
        authedConnections -= 1;
        if (authedConnections === 0) orphanArmedAt = Date.now();
      }
    });
    ws.on("error", () => { /* close handling above owns the slot */ });
  });

  // Op dispatch (after auth): each {t:"op", id, op} gets exactly one result.
  // ω-3a: for vaulted mutations the reply is intercepted — the FIRST reply
  // settles the vault entry (result cached, joiners flushed); the dispatch
  // below is otherwise untouched, so per-connection execution order stays
  // the synchronous arrival order it always was (no lock introduced). `ws`
  // is the REQUESTING socket: delivery is connection-bound (the upstream project's
  // model) — when the requester is no longer the authenticated client, its
  // own delivery is dropped (the vault cache serves the retry) instead of
  // landing on the new client as a duplicate.
  const handleFrame = (frame: unknown, ws: WebSocket): void => {
    if (typeof frame !== "object" || frame === null || (frame as { t?: unknown }).t !== "op") return;
    const { id, op } = frame as { id?: unknown; op?: unknown };
    let reply = (ok: unknown, err?: string): void => {
      send({ t: "result", id, ok, ...(err !== undefined ? { err } : {}) });
    };
    if (typeof op !== "object" || op === null) {
      reply(undefined, "malformed op");
      return;
    }
    const o = op as Record<string, unknown>;
    const cid = (frame as { cid?: unknown }).cid;
    if (typeof id === "number" && typeof cid === "string" && cid.length >= 1 && cid.length <= 128 && isVaultedMutation(o)) {
      const key = `${cid}:${id}`;
      // The digest covers the whole op object — action AND fields in one
      // hash (digest equality implies action equality, the stronger form of
      // the upstream project's action-or-digest conflict check).
      const digest = createHash("sha256").update(canonicalJson(o), "utf8").digest("hex");
      pruneVault();
      const existing = vault.get(key);
      if (existing !== undefined) {
        if (existing.digest !== digest) {
          reply(undefined, `conflict: op id ${String(id)} was already used for a different mutation`);
          return;
        }
        if (existing.done) {
          // Completed within the TTL (prune dropped the expired ones): serve
          // the cached outcome — the retry must not re-execute.
          reply(existing.ok, existing.err);
          return;
        }
        // In-flight: JOIN the original execution — await its reply, never
        // re-execute. The joiner's own reply closure carries the same id and
        // send() targets whatever socket is authenticated by then.
        existing.joiners.push(reply);
        return;
      }
      const entry: VaultEntry = {
        action: String(o.op),
        digest,
        done: false,
        ok: undefined,
        err: undefined,
        completedAt: null,
        joiners: [],
      };
      vault.set(key, entry);
      const inner = reply;
      const requester = ws;
      reply = (ok: unknown, err?: string): void => {
        entry.done = true;
        entry.ok = ok;
        entry.err = err;
        entry.completedAt = idemNow();
        // Connection-bound delivery: the original frame's result goes to its
        // own socket — and to nobody else when that socket is gone (a retry
        // joined, or the outcome waits in the cache for one).
        if (requester === client) inner(ok, err);
        for (const joiner of entry.joiners.splice(0)) joiner(ok, err);
        pruneVault();
      };
    }
    // 多 driver 并发弧 B —— 写 op 的 sid 寻址：op 对象携带可选 `sid` 字段时
    // 路由到对应车道；缺省 = 主车道（今日行为字节不变——老客户端从不发
    // sid）。typed 门（字符串）→ 车道表查找（未知 sid 干净拒）——resume/
    // sessionContinue 的「id 直传 → optional port → relay」三段门范式。vault
    // 的 digest 覆盖整个 op 对象（含 sid）：同一 cid+id 打不同车道 =
    // conflict，每 (cid, id, sid) 恰好执行一次。
    let lane: LaneDriverPort = opts.driver;
    if (o.sid !== undefined) {
      if (typeof o.sid !== "string") {
        reply(undefined, "sid must be a string when present");
        return;
      }
      const entry = laneTable.lanes.get(o.sid);
      if (entry === undefined) {
        // 0.4.0 集成缝：车道工厂——首次 resume 到未挂 sid 时开车道而非拒。
        if (opts.laneFactory === undefined || typeof o.id !== "string" || o.id === "") {
          reply(undefined, `unknown lane sid: ${o.sid}`);
          return;
        }
        void opts.laneFactory(o.id, o.sid).then(
          (laneDriver) => {
            laneTable.mountLane(o.sid as string, laneDriver);
            // 重入：车道现挂好，走同一 switch——直接调 laneDriver 的 resume
            void laneDriver.resume(o.id as string).then(
              (outcome) => reply(outcome),
              (err) => reply(undefined, errText(err)),
            );
          },
          (err) => reply(undefined, `lane open failed: ${errText(err)}`),
        );
        return;
      }
      lane = entry.driver;
    }
    try {
      switch (o.op) {
        case "submit": {
          if (typeof o.text !== "string") {
            reply(undefined, "submit needs a text string");
            return;
          }
          // M79 §4: the optional `images` field (protocol v1 increment — old
          // clients omit it, no behavior change). Shape-validated here; the
          // refs were minted by attachmentSave and the driver carries them
          // onto the user turn.
          let images: readonly unknown[] | undefined;
          if (o.images !== undefined) {
            if (!Array.isArray(o.images)) {
              reply(undefined, "submit images must be an array when present");
              return;
            }
            for (const img of o.images) {
              if (!isImageBlockShape(img)) {
                reply(undefined, "submit images entries must be {kind:'image', ref:{attachmentId, mediaType, byteLength}}");
                return;
              }
            }
            images = o.images;
          }
          // ω99-55: the optional `files` field (same increment discipline).
          // Blocks were minted by fileSave; the driver carries them onto the
          // user turn, and request build projects them to handle text.
          let files: readonly unknown[] | undefined;
          if (o.files !== undefined) {
            if (!Array.isArray(o.files)) {
              reply(undefined, "submit files must be an array when present");
              return;
            }
            for (const f of o.files) {
              if (!isFileBlockShape(f)) {
                reply(undefined, "submit files entries must be {kind:'file', name, bytes, attachmentId:'sha256:<64 hex>'}");
                return;
              }
            }
            files = o.files;
          }
          // ω99-242 invariant 7 — a MANUAL client submit invalidates the
          // pending recovery of the session the user took over (BEFORE the
          // engine sees it, the upstream project's forward-seam order). Permission and
          // form replies ride answerPermission — a different op that
          // deliberately never lands here: a reply may UNLOCK a tracked
          // blocked turn, so it must not cancel anything.
          // 多 driver 弧 B —— recovery 失效缝只在主车道触发：noteUserInput 取
          // 消的是「用户接管的主会话」的待恢复；副车道的 submit 落在另一个
          // 会话上，不碰主会话的恢复意图。
          if (lane === opts.driver && opts.recovery !== undefined) opts.recovery.noteUserInput();
          reply(lane.submit(o.text, {
            ...(o.plan === true ? { plan: true } : {}),
            ...(o.expand === false ? { expand: false } : {}),
            ...(images !== undefined ? { images } : {}),
            ...(files !== undefined ? { files } : {}),
          }));
          return;
        }
        case "interrupt":
          lane.interrupt();
          reply(true);
          return;
        case "setMode": {
          if (typeof o.mode !== "string" || !modes.includes(o.mode)) {
            reply(undefined, `setMode: mode must be one of ${modes.join(", ")}`);
            return;
          }
          lane.setMode(o.mode);
          reply(true);
          return;
        }
        case "answerPermission":
          if (typeof o.allow !== "boolean") {
            reply(undefined, "answerPermission needs allow: boolean");
            return;
          }
          if (typeof o.reason !== "string" && o.reason !== undefined) {
            reply(undefined, "answerPermission reason must be a string");
            return;
          }
          // 0.3.14 #1: the ask answer's scope — "session"/"always" widen the
          // allow into a recorded rule (anything else = allow once).
          if (o.scope !== undefined && o.scope !== "session" && o.scope !== "always") {
            reply(undefined, "answerPermission scope must be \"session\" | \"always\"");
            return;
          }
          reply(lane.answerPermission(
            o.allow,
            typeof o.reason === "string" ? o.reason : undefined,
            o.scope,
          ));
          return;
        // 借鉴弧 α2（the upstream format2.1.269 思想）— steering 未读撤回：CAS 面（index+text
        // 同帧相符才删）。OPTIONAL like searchSessions：未挂车道的老 driver 干净
        // 拒答（真实车道由 ui host 的 ask-lane 包装挂上）。
        case "recallSteer":
          if (typeof o.index !== "number" || !Number.isInteger(o.index) || o.index < 0) {
            reply(undefined, "recallSteer needs index: non-negative integer");
            return;
          }
          if (typeof o.text !== "string") {
            reply(undefined, "recallSteer needs text: string");
            return;
          }
          if (lane.recallSteer === undefined) {
            reply(undefined, "recallSteer not supported by this driver");
            return;
          }
          reply(lane.recallSteer(o.index, o.text));
          return;
        // 借鉴弧 α1（Codex 0.154 思想）— 回答停泊中的 ask_user 澄清卡：带文
        // =用户的回答（或点选的 chip 标签）；空/缺 = 解散（工具收到 error 结
        // 果→「自行决定并继续」）。OPTIONAL 同上。
        case "answerAskUser":
          if (o.answer !== undefined && typeof o.answer !== "string") {
            reply(undefined, "answerAskUser answer must be a string");
            return;
          }
          if (lane.answerAskUser === undefined) {
            reply(undefined, "answerAskUser not supported by this driver");
            return;
          }
          reply(lane.answerAskUser(typeof o.answer === "string" ? o.answer : undefined));
          return;
        // 借鉴弧 δ（the upstream harness 367ab084 思想）— 运行中工具调用转后台：callId 取
        // 状态帧 busyTools 行；缺省=第一个可转的在飞行。typed 裁决联合原样
        // 回（ok / not_detachable / not_in_flight）。收敛写（重放对已转/已
        // 落定的调用答 not_in_flight）→ vaulted 同 recallSteer。
        case "detachToolCall":
          if (o.callId !== undefined && typeof o.callId !== "string") {
            reply(undefined, "detachToolCall callId must be a string");
            return;
          }
          if (lane.detachToolCall === undefined) {
            reply(undefined, "detachToolCall not supported by this driver");
            return;
          }
          reply(lane.detachToolCall(typeof o.callId === "string" ? o.callId : undefined));
          return;
        // ω99-235: #3 — the pet lane's ops: OPTIONAL on the server (the settings
        // ops' contract — absent petDriver ⇒ a clean "unsupported" error, the
        // web relay then degrades to the main lane). Shape validation mirrors
        // the main-lane twins exactly; routing NEVER touches the main driver.
        case "petSubmit":
          if (opts.petDriver === undefined) {
            reply(undefined, "pet ops not supported by this driver");
            return;
          }
          if (typeof o.text !== "string") {
            reply(undefined, "petSubmit needs a text string");
            return;
          }
          // ω99-237: #1 — slash rejection: the lane invariant guards at the
          // PROTOCOL boundary, not just the UI. A slash through petSubmit
          // would ride the driver's submit slash routing (session rotation /
          // clear boundaries) and strand the fixed lane id "pet" on a dead
          // chain — ω99-235's "pet lane never changes id" dies exactly here.
          // The server is the contract executor: every client (current or
          // old web) gets the same refusal. Trim-then-test — leading
          // whitespace must not smuggle a command past the gate. The MAIN
          // lane's submit keeps slash routing untouched (commands are the
          // main lane's feature — the contrast pin).
          if (o.text.trim().startsWith("/")) {
            reply(undefined, "petSubmit rejects slash commands — the pet lane has a fixed session; use the main window for commands");
            return;
          }
          // text-only v1: the pet composer's images/files/plan lanes are not
          // opened here (Bubble is a pure send face — the honesty note).
          reply(opts.petDriver.submit(o.text));
          return;
        case "petInterrupt":
          if (opts.petDriver === undefined) {
            reply(undefined, "pet ops not supported by this driver");
            return;
          }
          opts.petDriver.interrupt();
          reply(true);
          return;
        case "petAnswerPermission":
          if (opts.petDriver === undefined) {
            reply(undefined, "pet ops not supported by this driver");
            return;
          }
          if (typeof o.allow !== "boolean") {
            reply(undefined, "petAnswerPermission needs allow: boolean");
            return;
          }
          if (typeof o.reason !== "string" && o.reason !== undefined) {
            reply(undefined, "petAnswerPermission reason must be a string");
            return;
          }
          if (o.scope !== undefined && o.scope !== "session" && o.scope !== "always") {
            reply(undefined, "petAnswerPermission scope must be \"session\" | \"always\"");
            return;
          }
          reply(opts.petDriver.answerPermission(
            o.allow,
            typeof o.reason === "string" ? o.reason : undefined,
            o.scope,
          ));
          return;
        // ω99-271 — the lane's history read (标记见 #2，端口注释): a READ, never
        // vaulted (the 260 memoryList precedent — vaulted-mirror's reads list
        // carries it). Pairs the driver's pet.jsonl history into chat turns
        // (ω99-272 起全保真无帽，标记见 #3) so the pet window can rehydrate what
        // its local transcript cannot survive (window reload / restart) — the
        // tail window no longer truncates, but it still cannot outlive the page.
        // Routing NEVER touches the main driver (the lane-isolation pin in the
        // 271 test watches main getHistory's call count stay flat).
        case "petHistory": {
          if (opts.petDriver === undefined) {
            reply(undefined, "pet ops not supported by this driver");
            return;
          }
          try {
            reply(petTurnsFromHistory(opts.petDriver.getHistory()));
          } catch (e) {
            reply(undefined, `petHistory failed: ${(e as Error).message}`);
          }
          return;
        }
        case "listSlashCommands":
          reply(opts.driver.listSlashCommands());
          return;
        // ω99-242 — the recovery reconciliation surface: per-session rows
        // counted by the coordinator from the journal's settle records (the
        // web renders 「已验证完成 X / 待续 Y」 off this — structured data,
        // never fabricated). A READ (never vaulted). The FIRST server-answered
        // op: the coordinator is host-mounted server state (like petDriver),
        // so there is no driver round-trip — the shape validation contract of
        // the driver ops does not apply; the reply is the coordinator's own.
        case "recoveryStatus":
          if (opts.recovery === undefined) {
            reply(undefined, "recovery not supported by this server");
            return;
          }
          reply(opts.recovery.status());
          return;
        // PB-2 — 探针遥测读面三 op（server-answered，recoveryStatus 同族；纯读不 vault）。
        case "probeStream":
        case "probeRecent":
        case "probeStats":
          probeRelay.handleOp(o, reply);
          return;
        case "sessions":
          void opts.driver.sessions().then(
            // ω99-235: #6 — the pet lane's row (id === the fixed "pet") carries
            // lane:"pet" — the main window's session list renders the 小精灵
            // badge off it (and its click refuses to resume: the lane is live
            // in the sprite window, the lease refuses adoption). Every other
            // row passes through untouched (no lane field at all).
            // 多 driver 弧 B —— 标记泛化：行 id 命中任何已挂副车道的 sid 同样
            // 标 lane:"<sid>"（pet 先例的推广——占用中的会话不 resume、UI 走
            // 车道切换）；无副车道时标记集只剩 pet（今日字节形状）。
            (rows) => {
              const laneMarks = new Map<string, string>([[PET_LANE_SESSION_ID, "pet"]]);
              for (const sid of laneTable.lanes.keys()) {
                if (sid !== MAIN_LANE_SID) laneMarks.set(sid, sid);
              }
              reply(rows.map((row) => {
                if (typeof row !== "object" || row === null) return row;
                const id = (row as { id?: unknown }).id;
                const mark = typeof id === "string" ? laneMarks.get(id) : undefined;
                return mark !== undefined ? { ...(row as Record<string, unknown>), lane: mark } : row;
              }));
            },
            (err) => reply(undefined, errText(err)),
          );
          return;
        // ω99-277（续，标记见上）— 弹框全文搜索：q 直传、命中原样回（sessions
        // case 的 relay 范式；optional port 的干净拒答形同 branchLeaves）。
        case "sessionSearch": {
          if (typeof o.q !== "string") {
            reply(undefined, "sessionSearch needs a q string");
            return;
          }
          if (opts.driver.searchSessions === undefined) {
            reply(undefined, "sessionSearch not supported by this driver");
            return;
          }
          void opts.driver.searchSessions(o.q).then(
            (hits) => reply(hits),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        // ω99-279（续，标记见上）— 弹框清理车道：id 直传、删除结果原样回
        // （277 #3 同形：typed 门 → optional port → relay）。收敛删除不进
        // vaulting（isVaultedMutation 零动——census 读表 +1 的裁定面）。
        case "sessionDelete": {
          if (typeof o.id !== "string") {
            reply(undefined, "sessionDelete needs an id string");
            return;
          }
          if (opts.driver.deleteSession === undefined) {
            reply(undefined, "sessionDelete not supported by this driver");
            return;
          }
          void opts.driver.deleteSession(o.id).then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        // ω99-283（续，标记见上）— 弹框回收站面：列表零参直通、恢复 id 直传
        // 结果联合原样回（sessionDelete 同款三段门：typed 门 → optional
        // port → relay）。恢复收敛（重落 target-exists/not-found 不动盘）
        // ——读表语义，isVaultedMutation 零动（census 读表 +2 的裁定面）。
        case "sessionTrashList": {
          if (opts.driver.trashSessions === undefined) {
            reply(undefined, "sessionTrashList not supported by this driver");
            return;
          }
          void opts.driver.trashSessions().then(
            (rows) => reply(rows),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        case "sessionRestore": {
          if (typeof o.id !== "string") {
            reply(undefined, "sessionRestore needs an id string");
            return;
          }
          if (opts.driver.restoreSession === undefined) {
            reply(undefined, "sessionRestore not supported by this driver");
            return;
          }
          void opts.driver.restoreSession(o.id).then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        // ω99-286（续，标记见上）— 断点续跑：id 直传、结果联合原样回
        // （sessionDelete/sessionRestore 同款三段门：typed 门 → optional
        // port → relay）。启动语义不进 vaulting（isVaultedMutation 零动——
        // driver 的 busy/尾形门让 mid-flap 重放收敛 started:false，census
        // 读表 +1 的裁定面）。
        case "sessionContinue": {
          if (typeof o.id !== "string") {
            reply(undefined, "sessionContinue needs an id string");
            return;
          }
          if (opts.driver.continueSession === undefined) {
            reply(undefined, "sessionContinue not supported by this driver");
            return;
          }
          void opts.driver.continueSession(o.id).then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        // ω99-313 — 定时任务与提醒的读面：零参直通、行数组原样回
        //（sessionSearch 的 relay 范式；optional port 的干净拒答形）。
        // 纯读，never vaulted（census 读表 +1 的裁定面）。
        case "schedulesList":
          if (opts.driver.schedulesList === undefined) {
            reply(undefined, "schedulesList not supported by this driver");
            return;
          }
          void opts.driver.schedulesList().then(
            (rows) => reply(rows),
            (err) => reply(undefined, errText(err)),
          );
          return;
        // ω99-317 — 管理面三写：typed 形状门在 optional-port 检查之后、
        // driver 之前（fileRevert 范式）；结果联合 {ok,message} 原样回（web
        // 侧按 ok 分叉通知语气）。setEnabled 与 runNow 是 VAULTED mutations。
        case "schedulesSetEnabled":
          if (opts.driver.schedulesSetEnabled === undefined) {
            reply(undefined, "schedulesSetEnabled not supported by this driver");
            return;
          }
          if (typeof o.id !== "string" || o.id.trim() === "") {
            reply(undefined, "schedulesSetEnabled needs a non-empty id string");
            return;
          }
          if (typeof o.enabled !== "boolean") {
            reply(undefined, "schedulesSetEnabled needs an enabled boolean");
            return;
          }
          void opts.driver.schedulesSetEnabled(o.id, o.enabled).then(
            (verdict) => reply(verdict),
            (err) => reply(undefined, errText(err)),
          );
          return;
        case "schedulesRemove":
          if (opts.driver.schedulesRemove === undefined) {
            reply(undefined, "schedulesRemove not supported by this driver");
            return;
          }
          if (typeof o.id !== "string" || o.id.trim() === "") {
            reply(undefined, "schedulesRemove needs a non-empty id string");
            return;
          }
          void opts.driver.schedulesRemove(o.id).then(
            (verdict) => reply(verdict),
            (err) => reply(undefined, errText(err)),
          );
          return;
        case "schedulesRunNow":
          if (opts.driver.schedulesRunNow === undefined) {
            reply(undefined, "schedulesRunNow not supported by this driver");
            return;
          }
          if (typeof o.id !== "string" || o.id.trim() === "") {
            reply(undefined, "schedulesRunNow needs a non-empty id string");
            return;
          }
          if (o.resetBreaker !== undefined && typeof o.resetBreaker !== "boolean") {
            reply(undefined, "schedulesRunNow resetBreaker must be a boolean");
            return;
          }
          void opts.driver.schedulesRunNow(
            o.id,
            o.resetBreaker === undefined ? undefined : { resetBreaker: o.resetBreaker },
          ).then(
            (verdict) => reply(verdict),
            (err) => reply(undefined, errText(err)),
          );
          return;
        case "resume":
          if (typeof o.id !== "string") {
            reply(undefined, "resume needs an id string");
            return;
          }
          // ω99-225: #2 — the outcome object relays verbatim (occupied carries
          // the holder pid; the web branches its toast on it). No boolean to
          // guess from anymore.
          void opts.driver.resume(o.id).then(
            (outcome) => reply(outcome),
            (err) => reply(undefined, errText(err)),
          );
          return;
        case "rewind": {
          const t = o.target;
          if (t !== "list" && t !== "last" && typeof t !== "number") {
            reply(undefined, 'rewind target must be a number | "last" | "list"');
            return;
          }
          void opts.driver.rewind(t).then(
            (summary) => reply(summary),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        // M53 §1: /edit <n> arming, /tree, /switch — the branching ops.
        case "edit": {
          if (typeof o.n !== "number" || !Number.isInteger(o.n) || o.n < 0) {
            reply(undefined, "edit needs an integer n ≥ 1 (0 = disarm)");
            return;
          }
          // ω99-258: n:0 disarms a pending arm (the web banner's cancel) —
          // the op is vaulted like the arming form; a disarm replay converges.
          if (o.n === 0) {
            if (opts.driver.disarmEdit === undefined) {
              reply(undefined, "edit disarm not supported by this driver");
              return;
            }
            reply(opts.driver.disarmEdit());
            return;
          }
          reply(opts.driver.beginEdit(o.n) ?? null);
          return;
        }
        case "tree":
          void opts.driver.tree().then(
            (text) => reply(text),
            (err) => reply(undefined, errText(err)),
          );
          return;
        case "switch": {
          if (o.n !== undefined && (typeof o.n !== "number" || !Number.isInteger(o.n) || o.n < 1)) {
            reply(undefined, "switch n must be an integer ≥ 1 when present");
            return;
          }
          void opts.driver.switchBranch(o.n).then(
            (text) => reply(text),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        // ω99-258: the structured leaf table (read op — never vaulted, the
        // recentWorkspaces read shape): tree()'s data twin for the web panel.
        case "branchLeaves":
          if (opts.driver.branchLeaves === undefined) {
            reply(undefined, "branchLeaves not supported by this driver");
            return;
          }
          void opts.driver.branchLeaves().then(
            (leaves) => reply(leaves),
            (err) => reply(undefined, errText(err)),
          );
          return;
        // ω99-260: the memory faces. memoryList is a READ (the branchLeaves
        // shape: optional port, clean refusal, never vaulted); memoryDecide
        // is the DECISION op — vaulted (isVaultedMutation), typed shape gates
        // (non-empty id string + the ok|del enum) BEFORE the driver call.
        case "memoryList":
          if (opts.driver.memoryList === undefined) {
            reply(undefined, "memoryList not supported by this driver");
            return;
          }
          void opts.driver.memoryList().then(
            (table) => reply(table),
            (err) => reply(undefined, errText(err)),
          );
          return;
        case "memoryDecide": {
          if (opts.driver.memoryDecide === undefined) {
            reply(undefined, "memoryDecide not supported by this driver");
            return;
          }
          if (typeof o.id !== "string" || o.id.trim() === "") {
            reply(undefined, "memoryDecide needs a non-empty id string");
            return;
          }
          if (o.action !== "ok" && o.action !== "del") {
            reply(undefined, 'memoryDecide action must be "ok" | "del"');
            return;
          }
          void opts.driver.memoryDecide(o.id, o.action).then(
            (verdict) => reply(verdict),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        // ω99-264: the memory EDIT op — the panel's 改写 key. Vaulted like
        // the decision (isVaultedMutation); typed shape gates (non-empty id
        // string + non-empty content string — 改写不得成空记忆: empty and
        // whitespace-only both refuse) BEFORE the driver call. The content
        // travels verbatim (no server-side trim rewrite — the driver's
        // short-circuit is byte equality).
        case "memoryEdit": {
          if (opts.driver.memoryEdit === undefined) {
            reply(undefined, "memoryEdit not supported by this driver");
            return;
          }
          if (typeof o.id !== "string" || o.id.trim() === "") {
            reply(undefined, "memoryEdit needs a non-empty id string");
            return;
          }
          if (typeof o.content !== "string" || o.content.trim() === "") {
            reply(undefined, "memoryEdit needs a non-empty content string");
            return;
          }
          void opts.driver.memoryEdit(o.id, o.content).then(
            (verdict) => reply(verdict),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        // 永续 v6 wave2（the upstream project C1）：门控自改进面。list 是读（memoryList 同
        // 形：optional port, clean refusal, never vaulted）；五个决策是写
        // 副作用（vaulted——isVaultedMutation 的 improvementFace 分支）。
        // 形状门在到达驱动之前：action 枚举 + 决策必带非空 id。
        case "improvementFace": {
          if (opts.driver.improvementFace === undefined) {
            reply(undefined, "improvementFace not supported by this driver");
            return;
          }
          const IMPROVE_ACTIONS: ReadonlySet<string> = new Set(["list", "consent", "ignore", "activate", "reject", "undo"]);
          if (typeof o.action !== "string" || !IMPROVE_ACTIONS.has(o.action)) {
            reply(undefined, 'improvementFace action must be "list" | "consent" | "ignore" | "activate" | "reject" | "undo"');
            return;
          }
          if (o.action !== "list" && (typeof o.id !== "string" || o.id.trim() === "")) {
            reply(undefined, `improvementFace ${o.action} needs a non-empty id string`);
            return;
          }
          void opts.driver.improvementFace(o.action as "list" | "consent" | "ignore" | "activate" | "reject" | "undo", typeof o.id === "string" ? o.id : undefined).then(
            (verdict) => reply(verdict),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        // M63 §B — the settings/credentials ops. Auth is already done (ops
        // only flow post-auth); the reply path strips any `key` field so a
        // secret NEVER rides back to the client, whatever the handler did.
        case "settingsStatus":
          if (opts.driver.settingsStatus === undefined) {
            reply(undefined, "settings ops not supported by this driver");
            return;
          }
          void opts.driver.settingsStatus().then(
            (status) => reply(stripSecrets(status)),
            (err) => reply(undefined, errText(err)),
          );
          return;
        case "settingsSaveKey": {
          if (opts.driver.settingsSaveKey === undefined) {
            reply(undefined, "settings ops not supported by this driver");
            return;
          }
          if (typeof o.provider !== "string" || o.provider.trim() === "") {
            reply(undefined, "settingsSaveKey needs a provider string");
            return;
          }
          if (typeof o.key !== "string" || o.key.trim() === "") {
            reply(undefined, "settingsSaveKey needs a non-empty key string");
            return;
          }
          void opts.driver.settingsSaveKey(o.provider, o.key).then(
            (result) => reply(stripSecrets(result)),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        case "settingsTestConnection": {
          if (opts.driver.settingsTestConnection === undefined) {
            reply(undefined, "settings ops not supported by this driver");
            return;
          }
          if (typeof o.provider !== "string" || o.provider.trim() === "") {
            reply(undefined, "settingsTestConnection needs a provider string");
            return;
          }
          if (o.key !== undefined && typeof o.key !== "string") {
            reply(undefined, "settingsTestConnection key must be a string");
            return;
          }
          if (o.model !== undefined && typeof o.model !== "string") {
            reply(undefined, "settingsTestConnection model must be a string");
            return;
          }
          const testOpts = {
            ...(typeof o.key === "string" ? { key: o.key } : {}),
            ...(typeof o.model === "string" ? { model: o.model } : {}),
          };
          void opts.driver.settingsTestConnection(o.provider, testOpts).then(
            (result) => reply(stripSecrets(result)),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        case "settingsSet": {
          if (opts.driver.settingsSet === undefined) {
            reply(undefined, "settings ops not supported by this driver");
            return;
          }
          if (typeof o.key !== "string" || o.key.trim() === "") {
            reply(undefined, "settingsSet needs a key string");
            return;
          }
          void opts.driver.settingsSet(o.key, o.value).then(
            (result) => reply(stripSecrets(result)),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        // Provider management §5 — the registry ops. Same contract as the
        // settings ops: shape validation here, semantics in the cli handler
        // (provider-registry-ops.ts), and the reply path strips secrets so a
        // saved config or a probe key never rides back to the client.
        case "settingsSaveProvider": {
          if (opts.driver.settingsSaveProvider === undefined) {
            reply(undefined, "settings ops not supported by this driver");
            return;
          }
          if (typeof o.id !== "string" || o.id.trim() === "") {
            reply(undefined, "settingsSaveProvider needs an id string");
            return;
          }
          if (typeof o.config !== "object" || o.config === null || Array.isArray(o.config)) {
            reply(undefined, "settingsSaveProvider config must be an object");
            return;
          }
          void opts.driver.settingsSaveProvider(o.id, o.config).then(
            (result) => reply(stripSecrets(result)),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        case "settingsDeleteProvider": {
          if (opts.driver.settingsDeleteProvider === undefined) {
            reply(undefined, "settings ops not supported by this driver");
            return;
          }
          if (typeof o.id !== "string" || o.id.trim() === "") {
            reply(undefined, "settingsDeleteProvider needs an id string");
            return;
          }
          void opts.driver.settingsDeleteProvider(o.id).then(
            (result) => reply(stripSecrets(result)),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        case "settingsListModels": {
          if (opts.driver.settingsListModels === undefined) {
            reply(undefined, "settings ops not supported by this driver");
            return;
          }
          if (typeof o.provider !== "string" || o.provider.trim() === "") {
            reply(undefined, "settingsListModels needs a provider string");
            return;
          }
          if (o.key !== undefined && typeof o.key !== "string") {
            reply(undefined, "settingsListModels key must be a string");
            return;
          }
          const listOpts = typeof o.key === "string" ? { key: o.key } : {};
          void opts.driver.settingsListModels(o.provider, listOpts).then(
            (result) => reply(stripSecrets(result)),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        // M75-ux1 §2 — the workspace switcher's recents (read, or add+persist
        // through the same handler; the reply is the plain list, no secrets).
        case "recentWorkspaces": {
          if (opts.driver.recentWorkspaces === undefined) {
            reply(undefined, "recent workspaces not supported by this driver");
            return;
          }
          if (o.add !== undefined && typeof o.add !== "string") {
            reply(undefined, "recentWorkspaces add must be a string when present");
            return;
          }
          void opts.driver.recentWorkspaces(typeof o.add === "string" ? o.add : undefined).then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        // M77-workspace §1 — same-window directory switch.
        case "switchWorkspace": {
          if (opts.driver.switchWorkspace === undefined) {
            reply(undefined, "workspace switching not supported by this driver");
            return;
          }
          if (typeof o.path !== "string" || o.path === "") {
            reply(undefined, "switchWorkspace path must be a non-empty string");
            return;
          }
          void opts.driver.switchWorkspace(o.path).then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        // M74-ide §1 — the file-panel data ops. Same op contract as the
        // settings ops (auth-gated, exactly one result, optional on the
        // driver port); validation here is shape-only — containment and the
        // sensitive-path list live in the driver handler (agent-driver.ts).
        case "fileTree": {
          if (opts.driver.fileTree === undefined) {
            reply(undefined, "file ops not supported by this driver");
            return;
          }
          if (typeof o.path !== "string") {
            reply(undefined, "fileTree needs a path string");
            return;
          }
          void opts.driver.fileTree(o.path).then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        case "fileRead": {
          if (opts.driver.fileRead === undefined) {
            reply(undefined, "file ops not supported by this driver");
            return;
          }
          if (typeof o.path !== "string") {
            reply(undefined, "fileRead needs a path string");
            return;
          }
          void opts.driver.fileRead(o.path).then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        // 高亮/编辑 spec §3 — the viewer's save. Same op contract as the
        // reads above (auth-gated, exactly one result, optional driver
        // method); shape validation only — containment/sensitive/CAS live
        // in the driver handler (agent-driver.ts fileWriteContent).
        case "fileWrite": {
          if (opts.driver.fileWrite === undefined) {
            reply(undefined, "file ops not supported by this driver");
            return;
          }
          if (typeof o.path !== "string" || typeof o.content !== "string" || typeof o.base !== "string") {
            reply(undefined, "fileWrite needs path, content and base strings");
            return;
          }
          void opts.driver.fileWrite(o.path, o.content, o.base).then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        // ω99-314 — the file-level time machine's restore op: typed shape
        // gates (non-empty path string + 64-hex sha) BEFORE the optional-port
        // relay; the verdict union relays verbatim (the web branches its
        // toast/confirm on stale and the refusal reasons). VAULTED — a mid-flap
        // replay joins the original execution, never a second write.
        case "fileRevert": {
          if (opts.driver.fileRevert === undefined) {
            reply(undefined, "fileRevert not supported by this driver");
            return;
          }
          if (typeof o.path !== "string" || o.path.trim() === "") {
            reply(undefined, "fileRevert needs a non-empty path string");
            return;
          }
          if (typeof o.sha !== "string" || !/^[0-9a-f]{64}$/.test(o.sha)) {
            reply(undefined, "fileRevert sha must be a 64-char lowercase hex string");
            return;
          }
          void opts.driver.fileRevert(o.path, o.sha).then(
            (verdict) => reply(verdict),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        // workspace-ux B1 — the panel-root ops: same op contract as the file
        // ops (auth-gated, exactly one result, optional on the driver port).
        // Shape validation only: the exists-and-directory check and the
        // recents write live in the driver handler (agent-driver.ts).
        case "panelRootSet": {
          if (opts.driver.panelRootSet === undefined) {
            reply(undefined, "panel root ops not supported by this driver");
            return;
          }
          if (typeof o.path !== "string" || o.path === "") {
            reply(undefined, "panelRootSet path must be a non-empty string");
            return;
          }
          void opts.driver.panelRootSet(o.path).then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        case "agentRootStatus": {
          if (opts.driver.agentRootStatus === undefined) {
            reply(undefined, "panel root ops not supported by this driver");
            return;
          }
          void opts.driver.agentRootStatus().then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        // workspace-ux B2 — the agent-root switch: same op contract as
        // panelRootSet (auth-gated, exactly one result, optional on the
        // driver port). Shape validation only: the exists-and-directory
        // gate, the busy queue, and the notice/note live in the driver
        // handler (agent-driver.ts).
        case "agentRootSwitch": {
          if (opts.driver.agentRootSwitch === undefined) {
            reply(undefined, "agent root ops not supported by this driver");
            return;
          }
          if (typeof o.path !== "string" || o.path === "") {
            reply(undefined, "agentRootSwitch path must be a non-empty string");
            return;
          }
          void opts.driver.agentRootSwitch(o.path).then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        // M76-ux2 §8 — the StatusBar ctx hover's breakdown: a read-only
        // pass-through over driver state (no validation surface — the payload
        // is the four plain numbers the driver computed).
        case "ctxInfo": {
          if (opts.driver.ctxInfo === undefined) {
            reply(undefined, "ctx info not supported by this driver");
            return;
          }
          void opts.driver.ctxInfo().then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        // ω99-213: #2 — the away recap. Same op contract as the file ops
        // (auth-gated, exactly one result, optional driver method); shape
        // validation only — the session-identity / mark / threshold gates and
        // the stats/narrative split live in the driver handler. An ok:undefined
        // reply is LEGITIMATE (zero action), distinct from an err string.
        case "recap": {
          if (opts.driver.recap === undefined) {
            reply(undefined, "recap not supported by this driver");
            return;
          }
          if (
            typeof o.sessionId !== "string" || o.sessionId === ""
            || typeof o.sinceMark !== "number" || !Number.isInteger(o.sinceMark) || o.sinceMark < 0
          ) {
            reply(undefined, "recap needs a sessionId string and a non-negative integer sinceMark");
            return;
          }
          const sinceTs = typeof o.sinceTs === "number" ? o.sinceTs : undefined;
          void opts.driver.recap(o.sessionId, o.sinceMark, sinceTs).then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        // ω99-316: /btw 侧问（PROTOCOL "sideQuestion"）。Same op contract as
        // recap (auth-gated, exactly one result, optional driver method);
        // shape validation only — the session-identity / empty-text gates
        // live in the driver handler. READ lane: the detached side loop
        // never writes the session (M24 — a replay just re-asks), so it is
        // never vaulted.
        case "sideQuestion": {
          if (opts.driver.sideQuestion === undefined) {
            reply(undefined, "sideQuestion not supported by this driver");
            return;
          }
          if (typeof o.sessionId !== "string" || o.sessionId === "") {
            reply(undefined, "sideQuestion needs a sessionId string");
            return;
          }
          if (typeof o.text !== "string" || o.text.trim() === "") {
            reply(undefined, "sideQuestion needs a non-empty text string");
            return;
          }
          void opts.driver.sideQuestion(o.sessionId, o.text).then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        // M79 §4 — the attachment ops. Shape validation only (the settings/
        // file-ops contract): count/size/media admission lives in the
        // driver's AttachmentStore, BEFORE any write; unknown ids reject in
        // the store's path guard.
        case "attachmentSave": {
          if (opts.driver.attachmentSave === undefined) {
            reply(undefined, "attachment ops not supported by this driver");
            return;
          }
          if (!Array.isArray(o.inputs) || o.inputs.length === 0) {
            reply(undefined, "attachmentSave needs a non-empty inputs array of {data, mediaType}");
            return;
          }
          for (const input of o.inputs) {
            if (typeof input !== "object" || input === null
              || typeof (input as Record<string, unknown>).data !== "string"
              || typeof (input as Record<string, unknown>).mediaType !== "string") {
              reply(undefined, "attachmentSave inputs must be {data: base64 string, mediaType: string}");
              return;
            }
          }
          void opts.driver.attachmentSave(o.inputs as { data: string; mediaType: string }[]).then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        case "attachmentGet": {
          if (opts.driver.attachmentGet === undefined) {
            reply(undefined, "attachment ops not supported by this driver");
            return;
          }
          const ref = o.ref;
          if (typeof ref !== "object" || ref === null
            || typeof (ref as Record<string, unknown>).attachmentId !== "string"
            || typeof (ref as Record<string, unknown>).mediaType !== "string"
            || typeof (ref as Record<string, unknown>).byteLength !== "number") {
            reply(undefined, "attachmentGet needs a ref {attachmentId, mediaType, byteLength}");
            return;
          }
          void opts.driver.attachmentGet(ref as { attachmentId: string; mediaType: string; byteLength: number }).then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        // ω99-55 — the file lane's save op. Shape validation only (the
        // settings/file-ops contract): count/name/base64 admission lives in
        // the driver's AttachmentStore, BEFORE any write; typed admission
        // errors relay verbatim.
        case "fileSave": {
          if (opts.driver.fileSave === undefined) {
            reply(undefined, "attachment ops not supported by this driver");
            return;
          }
          if (!Array.isArray(o.inputs) || o.inputs.length === 0) {
            reply(undefined, "fileSave needs a non-empty inputs array of {data, name}");
            return;
          }
          for (const input of o.inputs) {
            if (typeof input !== "object" || input === null
              || typeof (input as Record<string, unknown>).data !== "string"
              || typeof (input as Record<string, unknown>).name !== "string") {
              reply(undefined, "fileSave inputs must be {data: base64 string, name: string}");
              return;
            }
          }
          void opts.driver.fileSave(o.inputs as { data: string; name: string }[]).then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        // cc-plugins C1 — the plugin-management ops. Shape validation only
        // (the settings/file-ops contract): the marketplace engine behind
        // the handler owns the source grammar, the typed failures, and the
        // busy law for the two directory-deleting ops. Engine rejections
        // ride the err string verbatim (passthrough).
        case "pluginList":
          if (opts.driver.pluginList === undefined) {
            reply(undefined, "plugin ops not supported by this driver");
            return;
          }
          void opts.driver.pluginList().then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        // MCP visibility (the settings page's MCP tab): read-only, secrets
        // never ride the reply (the op's contract).
        case "mcpList":
          if (opts.driver.mcpList === undefined) {
            reply(undefined, "mcp ops not supported by this driver");
            return;
          }
          void opts.driver.mcpList().then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        case "pluginMarketList":
          if (opts.driver.pluginMarketList === undefined) {
            reply(undefined, "plugin ops not supported by this driver");
            return;
          }
          void opts.driver.pluginMarketList().then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        case "pluginMarketAdd": {
          if (opts.driver.pluginMarketAdd === undefined) {
            reply(undefined, "plugin ops not supported by this driver");
            return;
          }
          if (typeof o.source !== "string" || o.source.trim() === "") {
            reply(undefined, "pluginMarketAdd needs a source string");
            return;
          }
          if (o.name !== undefined && (typeof o.name !== "string" || o.name.trim() === "")) {
            reply(undefined, "pluginMarketAdd name must be a non-empty string when present");
            return;
          }
          void opts.driver.pluginMarketAdd(o.source, typeof o.name === "string" ? o.name : undefined).then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        case "pluginMarketUpdate": {
          if (opts.driver.pluginMarketUpdate === undefined) {
            reply(undefined, "plugin ops not supported by this driver");
            return;
          }
          if (typeof o.name !== "string" || o.name.trim() === "") {
            reply(undefined, "pluginMarketUpdate needs a name string");
            return;
          }
          void opts.driver.pluginMarketUpdate(o.name).then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        case "pluginMarketRemove": {
          if (opts.driver.pluginMarketRemove === undefined) {
            reply(undefined, "plugin ops not supported by this driver");
            return;
          }
          if (typeof o.name !== "string" || o.name.trim() === "") {
            reply(undefined, "pluginMarketRemove needs a name string");
            return;
          }
          void opts.driver.pluginMarketRemove(o.name).then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        case "pluginInstall": {
          if (opts.driver.pluginInstall === undefined) {
            reply(undefined, "plugin ops not supported by this driver");
            return;
          }
          if (typeof o.name !== "string" || o.name.trim() === "") {
            reply(undefined, "pluginInstall needs a name string");
            return;
          }
          if (typeof o.market !== "string" || o.market.trim() === "") {
            reply(undefined, "pluginInstall needs a market string");
            return;
          }
          // Absent scope = user (the engine grammar's default); anything
          // else must be the two-value union.
          if (o.scope !== undefined && o.scope !== "user" && o.scope !== "project") {
            reply(undefined, 'pluginInstall scope must be "user" | "project"');
            return;
          }
          void opts.driver.pluginInstall(o.name, o.market, o.scope === "project" ? "project" : "user").then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        case "pluginUninstall":
          if (opts.driver.pluginUninstall === undefined) {
            reply(undefined, "plugin ops not supported by this driver");
            return;
          }
          if (typeof o.id !== "string" || o.id.trim() === "") {
            reply(undefined, "pluginUninstall needs an id string");
            return;
          }
          void opts.driver.pluginUninstall(o.id).then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        case "pluginEnable":
        case "pluginDisable": {
          const handler = o.op === "pluginEnable" ? opts.driver.pluginEnable : opts.driver.pluginDisable;
          if (handler === undefined) {
            reply(undefined, "plugin ops not supported by this driver");
            return;
          }
          if (typeof o.id !== "string" || o.id.trim() === "") {
            reply(undefined, `${String(o.op)} needs an id string`);
            return;
          }
          void (handler as (id: string) => Promise<unknown>)(o.id).then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        // SDD 2026-08-23 persona Task 5 — the persona-management ops. Same
        // contract as the settings ops: shape validation here, semantics in
        // the cli handler (settings-ops.ts personaList/…/personaDelete over
        // the providers package's persona seam). The two writes are VAULTED
        // (isVaultedMutation); the reads never are.
        case "personaList":
          if (opts.driver.personaList === undefined) {
            reply(undefined, "persona ops not supported by this driver");
            return;
          }
          void opts.driver.personaList().then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        case "personaGet": {
          if (opts.driver.personaGet === undefined) {
            reply(undefined, "persona ops not supported by this driver");
            return;
          }
          if (typeof o.id !== "string" || o.id.trim() === "") {
            reply(undefined, "personaGet needs an id string");
            return;
          }
          void opts.driver.personaGet(o.id).then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        case "personaSave": {
          if (opts.driver.personaSave === undefined) {
            reply(undefined, "persona ops not supported by this driver");
            return;
          }
          if (typeof o.definition !== "object" || o.definition === null || Array.isArray(o.definition)) {
            reply(undefined, "personaSave definition must be an object");
            return;
          }
          void opts.driver.personaSave(o.definition).then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        case "personaDelete": {
          if (opts.driver.personaDelete === undefined) {
            reply(undefined, "persona ops not supported by this driver");
            return;
          }
          if (typeof o.id !== "string" || o.id.trim() === "") {
            reply(undefined, "personaDelete needs an id string");
            return;
          }
          if (o.unbind !== undefined && typeof o.unbind !== "boolean") {
            reply(undefined, "personaDelete unbind must be a boolean when present");
            return;
          }
          void opts.driver.personaDelete(o.id, o.unbind === true ? true : undefined).then(
            (result) => reply(result),
            (err) => reply(undefined, errText(err)),
          );
          return;
        }
        default:
          reply(undefined, `unknown op: ${String(o.op)}`);
      }
    } catch (err) {
      reply(undefined, errText(err));
    }
  };

  const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  /** M79 §4: the submit envelope's image-block shape check (transport-level;
   *  the driver trusts the refs it minted via attachmentSave). */
  const isImageBlockShape = (v: unknown): boolean => {
    if (typeof v !== "object" || v === null) return false;
    const b = v as Record<string, unknown>;
    if (b.kind !== "image" || typeof b.ref !== "object" || b.ref === null) return false;
    const r = b.ref as Record<string, unknown>;
    return typeof r.attachmentId === "string" && r.attachmentId !== ""
      && typeof r.mediaType === "string"
      && typeof r.byteLength === "number";
  };

  /** ω99-55: the submit envelope's file-block shape check (transport-level;
   *  the strict sha256 id shape doubles as the path-traversal refusal — a
   *  doctored id never matches, exactly like the store's own guard). */
  const isFileBlockShape = (v: unknown): boolean => {
    if (typeof v !== "object" || v === null) return false;
    const b = v as Record<string, unknown>;
    return b.kind === "file"
      && typeof b.name === "string" && b.name !== ""
      && typeof b.bytes === "number" && Number.isFinite(b.bytes) && b.bytes >= 0
      && typeof b.attachmentId === "string" && /^sha256:[a-f0-9]{64}$/.test(b.attachmentId);
  };

  // M63 §B: the protocol-boundary key strip — whatever a settings handler
  // returned, no secret-shaped field (`key`/`apiKey`/`apiKeys`/`keys`)
  // crosses back to the client, at ANY depth (a nested
  // {providers:[{apiKey:…}]} must not ride the wire either — review L4).
  // The handlers are built to return statuses only (counts, never values);
  // this is the backstop.
  const SECRET_FIELDS = ["key", "apiKey", "apiKeys", "keys"];
  const stripSecrets = (result: unknown): unknown => {
    if (Array.isArray(result)) {
      let changed = false;
      const out = result.map((item) => {
        const stripped = stripSecrets(item);
        if (stripped !== item) changed = true;
        return stripped;
      });
      return changed ? out : result;
    }
    if (typeof result !== "object" || result === null) return result;
    let changed = false;
    const clone: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(result as Record<string, unknown>)) {
      if (SECRET_FIELDS.includes(field)) {
        changed = true;
        continue;
      }
      const stripped = stripSecrets(value);
      if (stripped !== value) changed = true;
      clone[field] = stripped;
    }
    return changed ? clone : result;
  };

  // Driver → client relays (wired once; gated on the live authenticated slot).
  // ω99-235: #4 — ONE state frame carries BOTH lanes — the main driver's snapshot
  // under `state`, the pet lane's (when this server hosts one) under `pet`.
  // Each driver's subscription pushes the SAME frame: both statuses are
  // re-read at push time, so a pet emit never ships a stale main state and
  // vice versa. No petDriver → the frame is byte-identical to the old shape.
  // 多 driver 并发弧 B —— 帧面泛化：副车道（laneDrivers/运行时 mountLane 挂载）
  // 的状态并入同一帧的 OPTIONAL `lanes` 字段（推送时逐车道重读——ω99-235 的
  // 双读合并纪律从 2 车道推广到 N 车道）；无副车道时字段整体缺席，帧与旧
  // 形状字节相同。车道表（lanes.ts）持有 main + 副车道的订阅簿记；挂载/卸载
  // 各推一帧（客户端据 lanes 增减感知车道面）。
  const pushState = (): void => {
    const laneStatuses = laneTable.statuses();
    send({
      t: "state",
      state: opts.driver.getStatus(),
      ...(opts.petDriver !== undefined ? { pet: opts.petDriver.getStatus() } : {}),
      // 0.4.0 集成缝：laneFactory 在场=车道能力恒声明（空表也算——web 的
      // capable 判定=lanes 字段存在，鸡生蛋问题：车道只在首次 resume {sid}
      // 后才创建，但 web 只有看到 lanes 字段才走并发路径发 sid）。
      ...((laneStatuses !== undefined || opts.laneFactory !== undefined) ? { lanes: laneStatuses ?? {} } : {}),
    });
  };
  const laneTable: LaneTable = createLaneTable({
    main: opts.driver,
    onStatus: pushState,
    // 副车道历史帧带 sid（追加形与 reset 形同规则）；主车道帧永不带——老客
    // 户端只消费主车道帧，主车道中继两行保持字节不变。
    onSideHistory: (sid, entries, reset) =>
      send(reset ? { t: "history", entries, reset: true, sid } : { t: "history", entries, sid }),
  });
  for (const [sid, driver] of opts.laneDrivers ?? []) laneTable.mountLane(sid, driver);
  opts.petDriver?.subscribe(pushState);
  opts.driver.onHistory((entries, reset) =>
    send(reset ? { t: "history", entries, reset: true } : { t: "history", entries }),
  );
  opts.driver.onLoopEvent((event) => send({ t: "event", event }));

  // Heartbeat: ping every interval; a socket that never pongged since the
  // last sweep is terminated (dead-tab detection).
  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      const marked = ws as WebSocket & { alive?: boolean };
      if (marked.alive === false) {
        ws.terminate();
        continue;
      }
      marked.alive = false;
      ws.ping();
    }
    // ω99-225: #3 — the orphan sweep rides the SAME interval (no new timer).
    // Double condition, zero false positives: ppid 1 means the parent app is
    // gone (macOS/Linux reparent to init; the app's tray-hide keeps a live
    // client, so this arm never fires for it), and the client count zero
    // means nobody is watching. Both must hold past the grace window — then
    // one stderr receipt for the operator and a clean exit(0): the residual
    // leases die with the process and the core lease's dead-pid steal
    // recovers them, so there is deliberately no lease release here.
    if (authedConnections === 0 && orphanArmedAt !== null &&
        getPpid() === 1 && Date.now() - orphanArmedAt >= orphanGraceMs) {
      clearInterval(pinger);
      process.stderr.write("wudao-server: parent gone and no clients — orphan self-exit\n");
      // ω99-242 invariant 3 — the orphan self-exit is a shutdown too: freeze
      // the in-flight session's recovery intent BEFORE exit(0), or this
      // path's own kill would erase it. Bounded (stop() is journal appends
      // only); without a mounted recovery the exit stays exactly as before.
      if (opts.recovery !== undefined) {
        void opts.recovery.stop().catch(() => {}).then(() => exitFn(0));
        return;
      }
      exitFn(0);
    }
  }, pingIntervalMs);
  pinger.unref?.();

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port ?? 0, host, () => resolve());
  });
  const port = (http.address() as { port: number }).port;

  return {
    port,
    token,
    url: `http://127.0.0.1:${port}/#${token}`,
    mountLane: laneTable.mountLane,
    closeLane: laneTable.closeLane,
    close: async () => {
      clearInterval(pinger);
      probeRelay.close();
      // Shutdown must not WAIT on peers: a graceful ws.close() handshake
      // leaves the process alive until the client ACKs — a dead tab never
      // does, and Ctrl+C must exit promptly even with a run in flight.
      // Terminate every client (the web UI's reconnect machinery owns
      // recovery) and drop any dangling HTTP connections.
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      http.closeAllConnections?.();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

// Static serving: <staticDir> when it exists (the built web frontend),
// otherwise the protocol placeholder. Path traversal is normalized away.
async function handleStatic(req: IncomingMessage, res: ServerResponse, staticDir: string | undefined): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  const wants = url.pathname === "/" ? "/index.html" : url.pathname;
  const fallback = async (): Promise<void> => {
    if (wants !== "/index.html") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(placeholderPage());
  };
  if (staticDir === undefined) {
    await fallback();
    return;
  }
  const rel = normalize(decodeURIComponent(wants)).replace(/^(\.\.[/\\])+/, "");
  const abs = join(staticDir, rel);
  // Path-containment guard. Separator-agnostic: on win32 join() emits `\`, so
  // a plain `startsWith(staticDir + "/")` would reject every legit request.
  const prefix = staticDir.endsWith("/") || staticDir.endsWith("\\")
    ? staticDir
    : `${staticDir}${sep}`;
  if (!abs.startsWith(prefix)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const info = await stat(abs);
    if (!info.isFile()) {
      await fallback();
      return;
    }
    const body = await readFile(abs);
    res.writeHead(200, { "content-type": CONTENT_TYPES[extname(abs)] ?? "application/octet-stream" }).end(body);
  } catch {
    await fallback();
  }
}

// The placeholder template is exported for tests/inspection.
import { placeholderPage } from "./placeholder.js";
export { placeholderPage };
