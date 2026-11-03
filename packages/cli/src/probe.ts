// PB-2（探针基础设施弧）— CLI 侧探针车道三件：
//   ① 进程内 ProbeBus 本地实现（PB-1 接口的弧并行桩——createLocalProbeBus；
//      PB-1 落地 core 后此处换 core 工厂，结构签名不变，调用面零改）；
//   ② /probe 命令面（解析 + 表格渲染，REPL 的直读查询——零模型调用）；
//   ③ JSONL 审计 sink（设置 probe.auditFile 开启，缺省关——零写零文件）。
// bus 走进程内单例（setTerminalHistorySink 同款先例）：REPL 的 /probe、
// `wudao ui` 的 server 三读面 op、PB-1 的发射点共享同一实例，无需经 opts
// 层层穿针。文件由调用方管理（旋转/清理是调用方职责）；emit/落盘失败静默吞
// ——审计与遥测绝不阻塞执行（审计不是执行的一部分，是观察）。
import { truncateSafe } from "@wudao-org/core"; // 113-A4
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProbeCat, ProbeEventWire, UiProbeBusPort } from "@wudao-org/server";
import { probeBus, type ProbeCategory } from "@wudao-org/core";
import { loadLayeredSettings } from "./settings-layer.js";

/** 环形缓冲容量（PB-1 同量级：足够回看一轮长跑，内存有界）。 */
export const PROBE_RING_CAP = 1000;

/** /probe 缺省条数（表格可读性优先——拉全量用 /probe * <N>）。 */
export const PROBE_DEFAULT_LIMIT = 20;

const PROBE_CATS: readonly ProbeCat[] = ["model", "tool", "ui", "system", "agent"];

/** PB-1 ProbeBus 的弧并行桩实现：emit 进环形缓冲 + 通知订阅者；stats 按
 *  探针名计数（{count,lastTs}，与 server wire 面一对一）。 */
export function createLocalProbeBus(cap: number = PROBE_RING_CAP): UiProbeBusPort {
  const ring: ProbeEventWire[] = [];
  const subs: { cat: ProbeCat | "*"; cb: (e: ProbeEventWire) => void }[] = [];
  const counts = new Map<string, { count: number; lastTs: number }>();
  return {
    emit: (e) => {
      ring.push(e);
      if (ring.length > cap) ring.splice(0, ring.length - cap);
      const row = counts.get(e.name);
      if (row === undefined) counts.set(e.name, { count: 1, lastTs: e.ts });
      else {
        row.count += 1;
        row.lastTs = e.ts;
      }
      for (const s of [...subs]) if (s.cat === "*" || s.cat === e.cat) s.cb(e);
    },
    subscribe: (cat, cb) => {
      subs.push({ cat, cb });
      return () => {
        const i = subs.findIndex((s) => s.cb === cb && s.cat === cat);
        if (i >= 0) subs.splice(i, 1);
      };
    },
    recent: (cat, limit) => {
      const rows = cat !== undefined ? ring.filter((e) => e.cat === cat) : [...ring];
      const n = limit !== undefined ? limit : 50;
      return rows.slice(Math.max(0, rows.length - n));
    },
    stats: () => Object.fromEntries(counts),
  };
}

// —— 进程内单例（REPL 查询面 / ui server 挂载 / PB-1 发射点共享）——
let defaultBus: UiProbeBusPort | undefined;

/** 基准×探针弧修平：PB-2 桩欠的换芯——core 单例（PB-1 发射点真正的
 *  落点）适配成 UI 面端口。此前 getDefaultProbeBus 返回本地桩=双总线断裂：
 *  core 探针发进 core 单例，/probe 与审计文件订的是本地桩，生产读面永远
 *  空（测试注入受控 bus 掩盖了这缺口；基准跑分器实证 auditFile 永不落盘）。
 *  stats 语义差：core 按类目聚，UI 面按探针名——适配器订 "*" 自计名，
 *  自适配器创建起精确（创建前的历史事件不计，诚实边界）。 */
export function coreProbeBusAdapter(): UiProbeBusPort {
  const core = probeBus();
  const nameCounts = new Map<string, { count: number; lastTs: number }>();
  void core.subscribe("*", (e) => {
    const row = nameCounts.get(e.name);
    if (row === undefined) nameCounts.set(e.name, { count: 1, lastTs: e.ts });
    else {
      row.count += 1;
      row.lastTs = e.ts;
    }
  });
  return {
    emit: (e) => core.emit(e),
    subscribe: (cat, cb) => core.subscribe(cat, cb),
    recent: (cat, limit) => core.recent(cat === undefined ? undefined : (cat as ProbeCategory), limit ?? 50),
    stats: () => Object.fromEntries(nameCounts),
  };
}

export function getDefaultProbeBus(): UiProbeBusPort {
  if (defaultBus === undefined) defaultBus = coreProbeBusAdapter();
  return defaultBus;
}

/** 测试缝：换掉/清掉单例（夹具注入受控 bus）。 */
export function resetDefaultProbeBus(bus?: UiProbeBusPort): void {
  defaultBus = bus;
}

// ---------------------------------------------------------------------------
// /probe 命令面：解析 + 渲染
// ---------------------------------------------------------------------------

export type ProbeCommand =
  | { readonly kind: "recent"; readonly cat?: ProbeCat; readonly limit: number }
  | { readonly kind: "stats" }
  | { readonly kind: "bad"; readonly message: string };

/** `/probe [cat] [N]` · `/probe stats`。cat ∈ 五类别 | "*"（全部）；首 token
 *  必须是类别或 stats（裸数字不猜——用法回执指路）。 */
export function parseProbeArgs(args: string): ProbeCommand {
  const tokens = args.trim().split(/\s+/).filter((t) => t !== "");
  if (tokens.length === 0) return { kind: "recent", limit: PROBE_DEFAULT_LIMIT };
  const [head = "", second, ...rest] = tokens;
  if (head === "stats") {
    if (second !== undefined) return { kind: "bad", message: "stats 不带参数（用法：/probe stats）" };
    return { kind: "stats" };
  }
  if (head !== "*" && !(PROBE_CATS as readonly string[]).includes(head)) {
    return { kind: "bad", message: `未知的探针类别 "${head}"（用法：/probe [model|tool|ui|system|agent|*] [N] · /probe stats）` };
  }
  let limit = PROBE_DEFAULT_LIMIT;
  if (second !== undefined) {
    if (!/^\d+$/.test(second) || Number(second) < 1) {
      return { kind: "bad", message: `条数必须是正整数（收到 "${second}"）` };
    }
    if (rest.length > 0) return { kind: "bad", message: "至多两个参数：/probe [类别] [N]" };
    limit = Number(second);
  }
  return { kind: "recent", ...(head !== "*" ? { cat: head as ProbeCat } : {}), limit };
}

/** HH:MM:SS.mmm（本地时区——诊断面向人，不面向对时）。 */
function fmtClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** 距今（统计面的「最后 X 前」）。 */
export function fmtAgo(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  if (ms < 3_600_000) return `${m}m${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function fmtValue(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
  return s.length > 48 ? `${truncateSafe(s, 45)}…` : s;
}

/** 事件行：`  时:分:秒.毫秒  类别  名称  耗时  关键字段`（车道/会话在场时缀后）。 */
function fmtEventLine(e: ProbeEventWire): string {
  const fields = Object.entries(e.data).slice(0, 3).map(([k, v]) => `${k}=${fmtValue(v)}`);
  if (Object.keys(e.data).length > 3) fields.push("…");
  const tail = [
    ...(e.lane !== undefined ? [`lane=${e.lane}`] : []),
    ...(e.sessionId !== undefined ? [`sid=${e.sessionId.slice(0, 8)}`] : []),
    ...fields,
  ].join(" ");
  return `  ${fmtClock(e.ts)}  ${e.cat.padEnd(6)} ${(e.name).padEnd(18)} ${(e.dur !== undefined ? `${e.dur}ms` : "-").padStart(7)}  ${tail}`.trimEnd();
}

/** /probe 的完整输出（recent 表 / stats 面 / 用法回执）。 */
export function formatProbeReport(bus: UiProbeBusPort, cmd: ProbeCommand, now: () => number = Date.now): string {
  if (cmd.kind === "bad") return `⚠️ ${cmd.message}`;
  if (cmd.kind === "stats") {
    const stats = bus.stats();
    const names = Object.keys(stats);
    if (names.length === 0) return "探针统计面：空（还没有事件）";
    const rows = names
      .sort((a, b) => stats[b]!.count - stats[a]!.count)
      .map((n) => `  ${n.padEnd(20)} ×${String(stats[n]!.count).padStart(5)}  最后 ${fmtAgo(Math.max(0, now() - stats[n]!.lastTs))} 前`);
    return ["探针统计面：", ...rows].join("\n");
  }
  const events = bus.recent(cmd.cat, cmd.limit);
  if (events.length === 0) {
    return cmd.cat === undefined ? "探针缓冲为空（还没有事件）" : `探针缓冲为空（类别 ${cmd.cat} 还没有事件）`;
  }
  const head = `最近 ${events.length} 条探针事件${cmd.cat === undefined ? "" : `（类别 ${cmd.cat}）`}：`;
  return [head, ...events.map(fmtEventLine)].join("\n");
}

// ---------------------------------------------------------------------------
// JSONL 审计 sink（缺省关；设置 probe.auditFile 开启）
// ---------------------------------------------------------------------------

export interface ProbeAuditSink {
  readonly path: string;
  /** 测试缝：等写链排空（写链有序——appends 逐条排队，绝不交错）。 */
  flush(): Promise<void>;
  /** 退订（进程退出语义下通常不调；旋转/清理是调用方职责）。 */
  close(): void;
}

/** 每条 ProbeEvent 追加一行 JSON。任何失败（目录不可建/盘满/权限）静默吞——
 *  审计绝不阻塞执行；文件在首条事件时才创建（零事件=零文件）。 */
export function openProbeAudit(bus: UiProbeBusPort, path: string): ProbeAuditSink {
  // The directory create HEADS the write chain: as a fire-and-forget it raced
  // the first event's appendFile (slow CI fs: append hit ENOENT before mkdir
  // landed — the catch swallowed it and the audit silently lost the event).
  let tail: Promise<void> = mkdir(dirname(path), { recursive: true }).then(() => undefined, () => {});
  const unsubscribe = bus.subscribe("*", (e) => {
    tail = tail.then(() => appendFile(path, `${JSON.stringify(e)}\n`, "utf8")).catch(() => {});
  });
  return {
    path,
    flush: () => tail,
    close: () => unsubscribe(),
  };
}

/** effective settings → probe.auditFile（非空字符串才开；其余一切形状=关）。 */
export function probeAuditPathFromSettings(effective: Readonly<Record<string, unknown>>): string | undefined {
  const probe = effective["probe"];
  if (typeof probe !== "object" || probe === null || Array.isArray(probe)) return undefined;
  const p = (probe as Record<string, unknown>)["auditFile"];
  return typeof p === "string" && p.trim() !== "" ? p : undefined;
}

/** boot 装配：读分层设置 →（配置了 auditFile 时）在默认 bus 上开审计 + 打
 *  一行 notice。未配置 → 零 IO 零输出（缺省零变化的 CLI 面）。 */
export async function setupProbeAudit(args: {
  readonly workspaceRoot: string;
  readonly out?: (line: string) => void;
  readonly loadSettings?: typeof loadLayeredSettings;
}): Promise<string | undefined> {
  const layered = await (args.loadSettings ?? loadLayeredSettings)(args.workspaceRoot, () => {});
  const path = probeAuditPathFromSettings(layered.effective);
  if (path === undefined) return undefined;
  openProbeAudit(getDefaultProbeBus(), path);
  (args.out ?? ((line: string) => process.stdout.write(`${line}\n`)))("探针审计已开启 → " + path);
  return path;
}
