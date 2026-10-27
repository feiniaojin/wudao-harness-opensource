// ω99 拆分运动 弧 B：/schedule 命令解析 + 读面行构造外提——原 schedules.ts
// 模块级段逐字保留；schedules.ts re-export 门面保公共面。
import { parseCronExpr } from "@wudao/core";
import type { AddableSchedule, DurableTask, ScheduleRuntimeOverrides } from "./schedules-model.js";
import { describeScheduleHuman, nextFireOf } from "./schedules-logic.js";

// ---------------------------------------------------------------------------
// /schedule command parsing
// ---------------------------------------------------------------------------

export type ScheduleCommand =
  | { kind: "list" }
  | { kind: "add"; schedule: AddableSchedule; prompt: string; runtime?: ScheduleRuntimeOverrides }
  | { kind: "rm"; id: string }
  // ω99-5a: the daemon verbs (run = goose run_now). Three separate variants —
  // a shared {kind: "pause"|"unpause"|"run"} defeats discriminant narrowing
  // at the dispatch sites.
  | { kind: "pause"; id: string }
  | { kind: "unpause"; id: string }
  | { kind: "run"; id: string }
  // ω99-313: the reminder snooze verb (minutes default = the reminder's own
  // snoozeMinutes, else 10).
  | { kind: "snooze"; id: string; minutes?: number }
  // 借鉴弧 ε: the webhook address receipt verb (re-print the curl line —
  // the token lives on the task, receipts can be re-fetched any time).
  | { kind: "webhook"; id: string }
  | { kind: "bad"; error: string };

/** 113-C1（qm #1593 形）— the `--runtime <k=v[,k=v…]>` tier spec
 *  (`model=`/`provider=`/`persona=`/`effort=low|medium|high`). Returns the
 *  overrides or the typed refusal text. Pure; the daemon's add face re-runs
 *  the same checks (this is the parse-side copy of scheduleRuntimeError). */
export function parseScheduleRuntime(spec: string): ScheduleRuntimeOverrides | string {
  const out: { model?: string; provider?: string; persona?: string; effort?: "low" | "medium" | "high" } = {};
  for (const pair of spec.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return `--runtime 需为 k=v 逗号串（收到 "${spec}"）`;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === "") return `--runtime ${key} 需非空值`;
    if (key === "model") out.model = value;
    else if (key === "provider") out.provider = value;
    else if (key === "persona") out.persona = value;
    else if (key === "effort") {
      if (value !== "low" && value !== "medium" && value !== "high") {
        return `--runtime effort 需为 low|medium|high（收到 "${value}"）`;
      }
      out.effort = value;
    } else {
      return `--runtime 未知键 "${key}"（可用：model / provider / persona / effort）`;
    }
  }
  return Object.keys(out).length > 0 ? out : `--runtime 需至少一个键值对（收到 "${spec}"）`;
}

/** `/schedule` — list | add "<cron>" <prompt> | add @<ISO> <prompt> | rm <id>
 *  | pause <id> | unpause <id> | run <id> (ω99-5a; run = goose run_now).
 *  113-C1: the add forms take an optional trailing `--runtime <spec>` tier
 *  (stripped from the prompt BEFORE the trigger forms match; absent → the
 *  legacy parse byte-for-byte). */
export function parseScheduleCommand(args: string): ScheduleCommand {
  const trimmed = args.trim();
  if (trimmed === "" || trimmed === "list") return { kind: "list" };
  const ws = trimmed.search(/\s/);
  const head = ws === -1 ? trimmed : trimmed.slice(0, ws);
  const rest = ws === -1 ? "" : trimmed.slice(ws + 1).trim();
  if (head === "rm" || head === "remove" || head === "del") {
    if (rest === "") return { kind: "bad", error: "用法：/schedule rm <id>" }; // ω99-166d-i: #1
    return { kind: "rm", id: rest.split(/\s+/)[0]! };
  }
  // 借鉴弧 ε — /schedule webhook <id>：重取触发地址（curl 一行）。
  if (head === "webhook") {
    if (rest === "") return { kind: "bad", error: "用法：/schedule webhook <id>" };
    return { kind: "webhook", id: rest.split(/\s+/)[0]! };
  }
  if (head === "pause" || head === "unpause" || head === "run") {
    if (rest === "") return { kind: "bad", error: `用法：/schedule ${head} <id>` }; // ω99-166d-i: #2
    return { kind: head, id: rest.split(/\s+/)[0]! };
  }
  // ω99-313: /schedule snooze <id> [分钟]
  if (head === "snooze") {
    const parts = rest.split(/\s+/).filter((p) => p !== "");
    const id = parts[0];
    if (id === undefined) return { kind: "bad", error: "用法：/schedule snooze <id> [分钟]" };
    if (parts.length >= 2) {
      const n = Number(parts[1]);
      if (!Number.isInteger(n) || n <= 0) return { kind: "bad", error: "snooze 分钟数需为正整数" };
      return { kind: "snooze", id, minutes: n };
    }
    return { kind: "snooze", id };
  }
  if (head === "add") {
    // 113-C1 — the optional `--runtime <spec>` tier token: stripped from the
    // prompt BEFORE the trigger-form matching (the spec token is an argument,
    // never prompt prose). Absent → every legacy form parses byte-for-byte
    // as before.
    let body = rest;
    let runtime: ScheduleRuntimeOverrides | undefined;
    const runtimeForm = /(?:^|\s)--runtime(?:\s+(\S+))?/.exec(body);
    if (runtimeForm !== null) {
      const spec = runtimeForm[1];
      if (spec === undefined) return { kind: "bad", error: '--runtime 需为 k=v 逗号串（收到 ""）' };
      const parsedRuntime = parseScheduleRuntime(spec);
      if (typeof parsedRuntime === "string") return { kind: "bad", error: parsedRuntime };
      runtime = parsedRuntime;
      body = `${body.slice(0, runtimeForm.index)} ${body.slice(runtimeForm.index + runtimeForm[0].length)}`.replace(/\s+/g, " ").trim();
    }
    // 借鉴弧 ε — the event forms: `add watch <相对路径> <prompt>`（fs.watch
    // 盯工作区内路径，防抖窗吸收一次保存的事件串）与 `add webhook <prompt>`
    // （回环 POST + token，回执带触发地址）。放在 cron/@ISO 形之前——
    // watch/webhook 是字面量头词，不与带引号/裸 cron 的旧形冲突。
    const watchForm = /^watch\s+(\S+)\s+(.*)$/s.exec(body);
    if (watchForm !== null) {
      const path = watchForm[1]!.replace(/^["']|["']$/g, "");
      const prompt = watchForm[2]!.trim();
      if (prompt === "") return { kind: "bad", error: "用法：/schedule add watch <工作区内相对路径> <prompt>" };
      return { kind: "add", schedule: { type: "event", source: { kind: "file", path } }, prompt, ...(runtime !== undefined ? { runtime } : {}) };
    }
    if (/^webhook(\s|$)/.test(body)) {
      const prompt = body.slice("webhook".length).trim();
      if (prompt === "") return { kind: "bad", error: "用法：/schedule add webhook <prompt>" };
      return { kind: "add", schedule: { type: "event", source: { kind: "webhook" } }, prompt, ...(runtime !== undefined ? { runtime } : {}) };
    }
    // Quoted 5-field cron first: /schedule add "*/10 * * * *" run the tests
    const quoted = /^"([^"]+)"\s+(.*)$/s.exec(body) ?? /^'([^']+)'\s+(.*)$/s.exec(body);
    if (quoted !== null) {
      const prompt = quoted[2]!.trim();
      if (prompt === "") return { kind: "bad", error: "用法：/schedule add \"<cron expr>\" <prompt>" }; // ω99-166d-i: #3
      return { kind: "add", schedule: { type: "cron", expr: quoted[1]!.trim() }, prompt, ...(runtime !== undefined ? { runtime } : {}) };
    }
    // @<ISO> one-shot: /schedule add @2026-08-20T10:30 run the deploy
    const atForm = /^@(\S+)\s+(.*)$/s.exec(body);
    if (atForm !== null) {
      const t = Date.parse(atForm[1]!);
      const prompt = atForm[2]!.trim();
      if (!Number.isFinite(t)) return { kind: "bad", error: `无法解析时间 "@${atForm[1]}"（用 ISO 形，如 @2026-08-20T10:30）` }; // ω99-185: #22
      if (prompt === "") return { kind: "bad", error: "用法：/schedule add @<ISO time> <prompt>" }; // ω99-166d-i: #4
      return { kind: "add", schedule: { type: "at", at: t }, prompt, ...(runtime !== undefined ? { runtime } : {}) };
    }
    // Bare 5 space-separated cron fields.
    const fields = body.split(/\s+/);
    if (fields.length >= 6) {
      const expr = fields.slice(0, 5).join(" ");
      const prompt = fields.slice(5).join(" ").trim();
      const parsed = parseCronExpr(expr);
      if (!parsed.ok) return { kind: "bad", error: parsed.error };
      if (prompt === "") return { kind: "bad", error: "用法：/schedule add <cron> <prompt>" }; // ω99-166d-i: #5
      return { kind: "add", schedule: { type: "cron", expr }, prompt, ...(runtime !== undefined ? { runtime } : {}) };
    }
    return { kind: "bad", error: '用法：/schedule add "<cron expr>" <prompt> · add @<ISO time> <prompt> · add watch <相对路径> <prompt> · add webhook <prompt>（可选尾缀 --runtime model=…,provider=…,persona=…,effort=low|medium|high）' }; // ω99-166d-i: #6（ε：+watch/webhook；113-C1：+--runtime）
  }
  return { kind: "bad", error: "用法：/schedule [list | add … | rm <id> | pause <id> | unpause <id> | run <id> | snooze <id> [分钟] | webhook <id>]" }; // ω99-166d-i: #7（313：+snooze；ε：+webhook）
}

// ---------------------------------------------------------------------------
// ω99-313 — the web read face's row shape (schedulesList): 人话 trigger text,
// the next run, the state flags, and the session binding (the sidebar's ⏰
// marker joins on sessionId). Pure over the store's task list.
// ---------------------------------------------------------------------------

export interface ScheduleListRow {
  readonly id: string;
  readonly kind: "task" | "reminder";
  readonly prompt: string;
  /** The human trigger text (「每周一、周三 09:00」；事件形「当「x」变化时」). */
  readonly trigger: string;
  /** 借鉴弧 ε — 触发大类：calendar（看钟）| event（盯信号）；131 弧加
   *  idle（等空闲）。缺省 = calendar（老行/老 server 的加性缺省）。 */
  readonly triggerKind?: "calendar" | "event" | "idle";
  /** 借鉴弧 ε — 事件源（file/webhook）；非 event 行缺省。 */
  readonly eventSource?: "file" | "webhook";
  readonly nextRunAt: number | null;
  readonly enabled: boolean;
  readonly paused: boolean;
  /** ω99-317: 最近一次触发时间（busy-skip 也算——健康可见）；从未触发 → null。 */
  readonly lastFiredAt: number | null;
  /** ω99-317: 连败计数（仅 cron-fire 的 spawn 车道计——continue 车道按 313
   *  设计不触碰熔断）。行面渲染「连败 N 次后自动停用」。 */
  readonly consecutiveFailures: number;
  /** ω99-317: 最近一次运行结果（driver 从 schedules 会话日志 join——文件序
   *  最后一条胜；提醒车道不落日志 → null）。scheduleRowsOf 不产出此字段。 */
  readonly lastRun?: ScheduleLastRun | null;
  readonly sessionId?: string;
  /** 113-C1 — the per-task runtime tier (additive; absent on legacy rows). */
  readonly runtime?: import("./schedules-model.js").ScheduleRuntimeOverrides;
}

/** ω99-317 — 最近一次运行的结果形状（lastRun join 的载荷）。 */
export interface ScheduleLastRun {
  readonly ok: boolean;
  readonly at: number;
  /** ω99-321: the fire lane ("continue" | "skipped"; the spawn lane logs no
   * mode — legacy rows stay keyless). ok:true under mode:"skipped" is the
   * 「不失败」placeholder — consumers read mode BEFORE ok. */
  readonly mode?: string;
}

/** ω99-317 — 管理面写 op 的结果联合：message 是守护的中文回执原样中继；
 * ok = 回执不以 ⚠️ 开头（拒答判据与 createScheduleTools 同一事实源）。 */
export interface ScheduleActionResult {
  readonly ok: boolean;
  readonly message: string;
}

export function scheduleRowsOf(tasks: readonly DurableTask[], now: () => number = Date.now): readonly ScheduleListRow[] {
  return tasks.map((t) => ({
    id: t.id,
    kind: t.kind === "reminder" ? "reminder" : "task",
    prompt: t.prompt,
    trigger: describeScheduleHuman(t.schedule),
    // 借鉴弧 ε — 触发大类随行走（面板的「下次」格对 event 行说「等信号」
    // 而不是日期；缺省 = calendar，老 server 行零变化）。
    ...(t.schedule.type === "event"
      ? { triggerKind: "event" as const, ...(t.schedule.source.kind === "file" || t.schedule.source.kind === "webhook" ? { eventSource: t.schedule.source.kind } : {}) }
      : t.schedule.type === "idle"
        ? { triggerKind: "idle" as const }
        : {}),
    nextRunAt: nextFireOf(t, now()) ?? null,
    enabled: t.enabled !== false,
    paused: t.paused === true,
    lastFiredAt: t.lastFiredAt ?? null,
    consecutiveFailures: t.consecutiveFailures ?? 0,
    ...(t.sessionId !== undefined ? { sessionId: t.sessionId } : {}),
    ...(t.runtime !== undefined ? { runtime: t.runtime } : {}),
  }));
}

/** ω99-317 — 会话日志条目 → 每 task 的最近一次运行（文件序最后一条胜；
 * 异形行跳过——store 未知类型透传的既定语义）。纯函数：driver 的
 * schedulesList 用它 join 行的 lastRun。 */
export function lastRunsOf(entries: readonly unknown[]): Map<string, ScheduleLastRun> {
  const runs = new Map<string, ScheduleLastRun>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as { type?: unknown; data?: unknown };
    if (e.type !== "schedule_run" || typeof e.data !== "object" || e.data === null) continue;
    const d = e.data as { taskId?: unknown; ok?: unknown; at?: unknown; mode?: unknown };
    if (typeof d.taskId !== "string" || typeof d.ok !== "boolean" || typeof d.at !== "string") continue;
    const at = Date.parse(d.at);
    if (!Number.isFinite(at)) continue;
    runs.set(d.taskId, { ok: d.ok, at, ...(typeof d.mode === "string" ? { mode: d.mode } : {}) }); // last entry in file order wins
  }
  return runs;
}
