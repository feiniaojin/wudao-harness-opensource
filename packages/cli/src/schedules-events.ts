// 借鉴弧 ε（Cursor Projects 事件订阅思想，digest-c 候选 C3）— 事件触发源
// 基座：把「到点自己醒」（钟）泛化为「盯到信号就动手」（事件流）。v1 两
// 个最常用的源，都长在调度守护的成熟面上（熔断/绑定会话/busy 跳过落账/
// 手动词语义原样复用）：
//
//   file   —— fs.watch 任务工作区内的相对路径（validWatchPath 逃逸门）。
//             一次保存的事件串（rename+change）被同信号防抖窗吸收；路径
//             不存在/中途消失 → notify 一次并退场（fail-isolated，绝不
//             拖垮守护——file-change.ts 的 watcher 纪律同源）。
//   webhook —— 回环 HTTP 监听（只绑 127.0.0.1，server v1-A 的 fail-closed
//             律）：POST /trigger/<任务id> + Bearer token（add 时生成、
//             落库、与任务共存亡——rm 即吊销）。默认关 = 没有生效的
//             webhook 任务时监听根本不存在；body 只排空不消费（v1 预设
//             任务原样跑——把 body 变成 prompt 载荷是后续弧的事）。
//
// 与 cron 车道的语义差（弧记档 docs/research/117 的判据）：事件没有
// 「火」——不推进表（advanceAfterFire 只归 cron）、不武装漏火补跑
// （armMissRetry 拒绝 event）、缺火补跑（applyMissedFire）天然不触及
// （event 行永不物化 nextRunAt）；但熔断照喂（连败停用即关监听/关
// watcher——reconcile 只武装 enabled 且未暂停的任务）。
import { watch, type FSWatcher } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { DurableTask } from "./schedules-model.js";
import {
  SCHEDULE_EVENT_DEBOUNCE_MS, SCHEDULE_WEBHOOK_BODY_CAP, SCHEDULE_WEBHOOK_DEFAULT_PORT, SCHEDULE_WEBHOOK_HOST,
  SCHEDULE_WEBHOOK_PORT_ENV,
} from "./schedules-model.js";

/** The daemon-side fire plan: a debounced, source-attributed signal for ONE
 *  task id. The daemon owns every run decision (paused/enabled/running/
 *  lanes) — this substrate only owns signal hygiene. */
export interface EventSourcePlan {
  readonly fire: (taskId: string, source: "file" | "webhook") => void;
  /** The notify channel (missing path / bind failure — one line each, never
   *  fatal). */
  readonly notify: (line: string) => void;
}

export interface EventSourcesOptions extends EventSourcePlan {
  /** Test seams: debounce window, fixed webhook port, clock. */
  readonly debounceMs?: number;
  readonly webhookPort?: number;
  readonly now?: () => number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface EventSourcesHandle {
  /** (Re)arm after every table change: watchers for enabled file tasks, the
   *  webhook listener when an enabled webhook task exists (default-off is
   *  structural — no task, no socket). Sync; the bind itself is async and
   *  races no caller (webhookReady awaits it). */
  reconcile(tasks: readonly DurableTask[]): void;
  /** Resolve when the webhook listener is bound (its port), or undefined when
   *  off/failed. Receipts and tests await this. */
  webhookReady(): Promise<number | undefined>;
  stop(): void;
}

/** Is this task an ARMABLE event source? (event family + file/webhook kind —
 *  paused/breaker rows never arm; their signals arrive nowhere.) Pure. */
export function armableEventTask(t: DurableTask): boolean {
  if (t.schedule.type !== "event") return false;
  if (t.paused === true || t.enabled === false) return false;
  return t.schedule.source.kind === "file" || t.schedule.source.kind === "webhook";
}

/** Constant-time token compare: hash both sides to equal-length digests
 *  first (timingSafeEqual throws on length mismatch — the hash form makes
 *  the comparison shape-independent of the guess). */
function tokenMatches(guess: string, secret: string): boolean {
  const g = createHash("sha256").update(guess, "utf8").digest();
  const s = createHash("sha256").update(secret, "utf8").digest();
  return timingSafeEqual(g, s);
}

/** The webhook port: explicit seam > env override > the default constant. */
export function webhookPortOf(opts: { readonly env?: NodeJS.ProcessEnv; readonly webhookPort?: number }): number {
  if (opts.webhookPort !== undefined) return opts.webhookPort;
  const raw = (opts.env ?? process.env)[SCHEDULE_WEBHOOK_PORT_ENV];
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65_536 ? n : SCHEDULE_WEBHOOK_DEFAULT_PORT;
}

/** The loopback Host-header allowlist (the ui server's DNS-rebinding guard,
 *  same law): `host` or `host:port` of 127.0.0.1/localhost/[::1]. */
function loopbackHost(header: string | undefined): boolean {
  if (header === undefined) return false;
  const bare = header.replace(/:\d+$/, "").toLowerCase();
  return bare === "127.0.0.1" || bare === "localhost" || bare === "[::1]";
}

/** Drain the body up to the cap, then acknowledge. The v1 fire never reads
 *  the body — draining is protocol hygiene (a 202 before the sender finishes
 *  writing would surface as a connection reset on their side). */
function drainAndAck(req: IncomingMessage, res: ServerResponse, status: number, text: string): void {
  let seen = 0;
  req.on("data", (chunk: Buffer) => {
    seen += chunk.length;
    if (seen > SCHEDULE_WEBHOOK_BODY_CAP) {
      req.destroy(); // oversized body: cut the connection, no ack
      return;
    }
  });
  req.on("end", () => {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    res.end(text);
  });
  req.on("error", () => {
    /* the sender hung up — nothing to acknowledge */
  });
}

export function createEventSources(opts: EventSourcesOptions): EventSourcesHandle {
  const debounceMs = opts.debounceMs ?? SCHEDULE_EVENT_DEBOUNCE_MS;
  const now = opts.now ?? Date.now;
  const port = webhookPortOf(opts);
  // ---- file watchers -----------------------------------------------------
  const watchers = new Map<string, { readonly w: FSWatcher; readonly path: string }>();
  const lastSignal = new Map<string, number>();
  const warnedMissing = new Set<string>();
  const armFile = (task: DurableTask): void => {
    if (task.schedule.type !== "event" || task.schedule.source.kind !== "file") return;
    const path = task.schedule.source.path;
    const abs = join(task.workspace, path);
    const accept = (): void => {
      const t = now();
      const last = lastSignal.get(task.id) ?? 0;
      if (t - last < debounceMs) return; // 同信号防抖：窗口内首到即收
      lastSignal.set(task.id, t);
      opts.fire(task.id, "file");
    };
    try {
      const w = watch(abs, { persistent: false }, () => accept());
      w.on("error", (err: Error) => {
        // 中途消失（文件被删/重命名）：退场 + 一次 notify，任务留在表里
        //（路径回来后 rm+重加或下次 reconcile 重试武装——honest，不静默）。
        watchers.delete(task.id);
        w.close();
        opts.notify(`⚠️ 事件任务 ${task.id} 盯的「${path}」不能看了（${err.message}）——触发器已退场，路径恢复后重新添加`);
      });
      watchers.set(task.id, { w, path });
    } catch (err) {
      // watch 对不存在路径同步抛——一次性 notify（每个任务每次守护生命
      // 只说一遍），不武装。fail-isolated：一个盯不住的路径绝不拖垮别的。
      if (!warnedMissing.has(task.id)) {
        warnedMissing.add(task.id);
        opts.notify(
          `⚠️ 事件任务 ${task.id} 盯的「${path}」现在不存在，触发器未生效${err instanceof Error && err.message.length > 0 ? `（${err.message}）` : ""}`,
        );
      }
    }
  };
  const closeWatchers = (): void => {
    for (const { w } of watchers.values()) w.close();
    watchers.clear();
  };

  // ---- webhook listener --------------------------------------------------
  // Lifecycle: bound while ≥1 armable webhook task exists; closed the moment
  // none does (默认关 is structural). One bind attempt per need-on transition
  // that FAILED — a taken port notifies once and stays off (no retry storm).
  let server: Server | undefined;
  let boundPort: number | undefined;
  let bindPromise: Promise<number | undefined> | undefined;
  let bindFailedNotified = false;
  const tokens = new Map<string, string>();
  const startListener = (): void => {
    if (server !== undefined || bindPromise !== undefined) return;
    const srv = createServer((req, res) => {
      if (!loopbackHost(req.headers.host)) {
        res.writeHead(403).end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" }).end();
        return;
      }
      const id = /^\/trigger\/([A-Za-z0-9]{8})$/.exec(req.url ?? "")?.[1];
      const secret = id === undefined ? undefined : tokens.get(id);
      if (id === undefined || secret === undefined) {
        drainAndAck(req, res, 404, "no such trigger");
        return;
      }
      const auth = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? "");
      if (auth === null || !tokenMatches(auth[1]!, secret)) {
        drainAndAck(req, res, 401, "bad token");
        return;
      }
      // 202 = 信号已收（跑不跑、跳不跳是守护的账——busy 跳过会另行落账）。
      drainAndAck(req, res, 202, "accepted");
      const t = now();
      const last = lastSignal.get(id) ?? 0;
      if (t - last < debounceMs) return; // 发送方重试/风暴：同信号防抖
      lastSignal.set(id, t);
      opts.fire(id, "webhook");
    });
    bindPromise = new Promise<number | undefined>((resolve) => {
      srv.once("error", (err: Error) => {
        srv.close();
        bindPromise = undefined;
        // A late error on a bound listener is a teardown, not a bind failure
        // — no "didn't come up" notice for a listener that ran fine.
        const wasBound = boundPort !== undefined;
        boundPort = undefined;
        if (server === srv) server = undefined;
        if (!wasBound && !bindFailedNotified) {
          bindFailedNotified = true;
          opts.notify(`⚠️ webhook 触发监听没起来（127.0.0.1:${port} ${err.message}）——webhook 任务收不到信号；端口被占可设 ${SCHEDULE_WEBHOOK_PORT_ENV} 换端口`);
        }
        resolve(undefined);
      });
      srv.listen(port, SCHEDULE_WEBHOOK_HOST, () => {
        const addr = srv.address();
        boundPort = typeof addr === "object" && addr !== null ? addr.port : port;
        resolve(boundPort);
      });
    });
    void bindPromise.catch(() => undefined);
    server = srv;
  };
  const stopListener = (): void => {
    if (server === undefined) return;
    const srv = server;
    server = undefined;
    boundPort = undefined;
    bindPromise = undefined;
    srv.close();
    // close() 只拒新连，不掐空闲的 keep-alive 连接——宿主停机/表空时要的是
    // 端口立刻让出来（Node 18.2+；缺席时 close() 已尽其责）。
    srv.closeAllConnections?.();
  };

  let stopped = false;
  return {
    reconcile(tasks) {
      if (stopped) return;
      const armable = tasks.filter(armableEventTask);
      // File watchers: arm the new, close the gone (id-set diff on the
      // CURRENT table — pause/breaker/rm all flow through here).
      const wantFiles = new Map(
        armable
          .filter((t) => t.schedule.type === "event" && t.schedule.source.kind === "file")
          .map((t) => [t.id, t] as const),
      );
      for (const id of [...watchers.keys()]) {
        if (!wantFiles.has(id)) {
          watchers.get(id)?.w.close();
          watchers.delete(id);
        }
      }
      for (const [id, t] of wantFiles) {
        if (!watchers.has(id)) armFile(t);
      }
      // Webhook listener: present iff an armable webhook task is.
      tokens.clear();
      let need = false;
      for (const t of armable) {
        if (t.schedule.type === "event" && t.schedule.source.kind === "webhook") {
          tokens.set(t.id, t.schedule.source.token);
          need = true;
        }
      }
      if (need) startListener();
      else stopListener();
    },
    webhookReady: () => bindPromise ?? Promise.resolve(boundPort),
    stop() {
      stopped = true;
      closeWatchers();
      stopListener();
    },
  };
}
