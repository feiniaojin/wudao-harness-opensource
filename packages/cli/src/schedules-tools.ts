// ω99 拆分运动 弧 B：schedules 工具面外提（schedule_add/list/remove——原
// schedules.ts 模块级段逐字保留；schedules.ts re-export 门面保公共面）。
import { buildTool } from "@wudao/core";
import type { Tool } from "@wudao/core";
import type { AddableSchedule, DurableTask } from "./schedules-model.js";
import { validScheduleOriginSessionId } from "./schedules-model.js";
import type { ScheduleAddInput } from "./schedules.js";
import { DEFER_IDLE_DEFAULT_MINUTES } from "./schedules-model.js";

/** The tool face the daemon satisfies (structural subset of ScheduleDaemon). */
export interface ScheduleToolFace {
  add(input: ScheduleAddInput): Promise<string>;
  rm(id: string): Promise<string>;
  listText(): string;
  /** 127 项 1 — the structured table read (the daemon's LIVE in-memory rows,
   *  single-host truth). Present only on the real daemon — continue_task's
   *  idempotency scan reads it; absent on scripted test faces = the tool
   *  does not mount (fail-closed family). */
  list?(): readonly DurableTask[];
  /** 121 项 2 — the LIVE session id read (the ui host late-binds it to the
   *  driver's getSessionId; execute-time reads see post-resume rotations).
   *  Absent (tests, embedders) = no origin stamping: the add input stays
   *  byte-identical to the pre-121 shape. */
  readonly liveSessionId?: () => string | undefined;
}

export function createScheduleTools(face: ScheduleToolFace): Tool[] {
  const scheduleAdd = buildTool({
    name: "schedule_add",
    description:
      "Schedule a durable task or reminder for the user (runs even between conversations, hosted by the resident `wudao ui` process). kind=task runs the prompt as an agent run; tasks you set from THIS conversation automatically resume it at each fire — the context you built (files read, decisions made) carries over, durable across restarts — so write the prompt as the recurring instruction itself (e.g. \"check the build status and fix what broke\"); kind=reminder only notifies the user at the time — zero model calls. Triggers are structured calendars (local timezone), never cron strings: {type:\"at\", at:\"2026-09-15T09:00\"} fires once; {type:\"every\", intervalMs:900000} repeats; {type:\"weekly\", weekdays:[1,3], time:\"09:00\"} fires weekly (0=Sunday). Event triggers watch a signal instead of the clock: {type:\"event\", source:{kind:\"file\", path:\"reports/weekly.md\"}} runs when that workspace-relative file changes (debounced); {type:\"event\", source:{kind:\"webhook\"}} runs when its local webhook receives a POST — the add receipt carries the curl address and token. Reminders may carry snoozeMinutes (the user can push one re-ring). Tasks may carry budgetTokens (a per-fire token ceiling) and sessionId (bind to a session id from schedule_list for cache-friendly continuation).",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["task", "reminder"], description: "task = run the prompt; reminder = notify the user only (no model calls)" },
        prompt: { type: "string", description: "The task prompt, or the reminder text shown to the user" },
        trigger: {
          type: "object",
          description: 'Structured local-time trigger: {type:"at", at:"YYYY-MM-DDTHH:mm"} one-shot | {type:"every", intervalMs:number (>=60000)} interval | {type:"weekly", weekdays:number[0-6], time:"HH:mm"} weekly | {type:"event", source:{kind:"file", path:"relative/path"}|{kind:"webhook"}} signal-driven',
          properties: {
            type: { type: "string", enum: ["at", "every", "weekly", "event"] },
            at: { type: "string", description: 'One-shot local time, e.g. "2026-09-15T09:00" (type=at)' },
            intervalMs: { type: "number", description: "Repeat interval in milliseconds, minimum 60000 (type=every)" },
            weekdays: { type: "array", items: { type: "number" }, description: "Weekdays 0-6 (0=Sunday), e.g. [1,3] = Mon+Wed (type=weekly)" },
            time: { type: "string", description: 'Local time-of-day "HH:mm", e.g. "09:00" (type=weekly)' },
            source: {
              type: "object",
              description: 'Event signal source (type=event): {kind:"file", path:"workspace-relative path"} watches file changes; {kind:"webhook"} receives local POSTs (address+token come back in the receipt)',
              properties: {
                kind: { type: "string", enum: ["file", "webhook"] },
                path: { type: "string", description: 'Workspace-relative path to watch (source kind=file); absolute paths and ".." are refused' },
              },
              required: ["kind"],
              additionalProperties: false,
            },
          },
          required: ["type"],
          additionalProperties: false,
        },
        sessionId: { type: "string", description: "Optional: bind a task to a session id — a fire continues that session when it has unfinished work (same context, cache-friendly)" },
        budgetTokens: { type: "number", description: "Optional per-fire token ceiling for a task" },
        runtime: {
          type: "object",
          description: 'Optional per-task runtime tier (113-C1), consumed ONLY when a fire spawns a fresh headless run — a bound continue lane keeps the session\'s own runtime. Night crons can run a cheaper model than interactive sessions: {provider:"deepseek", model:"deepseek-v4-flash", persona:"the upstream format", effort:"low"} — every field optional; unknown persona ids are refused at add.',
          properties: {
            model: { type: "string", description: "Model id for the spawned run (--model — wins over env pins)" },
            provider: { type: "string", description: "Provider id for the spawned run (--provider)" },
            persona: { type: "string", description: "Persona id for the spawned run (checked against the registry at add)" },
            effort: { type: "string", enum: ["low", "medium", "high"], description: "Reasoning-effort tier for the spawned run (--reasoning-effort)" },
          },
          additionalProperties: false,
        },
        snoozeMinutes: { type: "number", description: "Optional (reminders): minutes a fired reminder stays re-ringable (default snooze length)" },
      },
      required: ["kind", "prompt", "trigger"],
      additionalProperties: false,
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    isOpenWorld: () => false,
    async execute(args) {
      const kind = args.kind === "reminder" ? "reminder" : "task";
      const t = args.trigger as Record<string, unknown> | undefined;
      if (typeof t !== "object" || t === null) {
        return { content: "trigger is required: {type:\"at\"|\"every\"|\"weekly\", …}", isError: true };
      }
      let schedule: AddableSchedule | undefined;
      if (t.type === "at" && typeof t.at === "string") {
        const ms = Date.parse(t.at);
        if (!Number.isFinite(ms)) {
          return { content: `cannot parse at "${String(t.at)}" (use the local form 2026-09-15T09:00)`, isError: true };
        }
        schedule = { type: "at", at: ms };
      } else if (t.type === "every" && typeof t.intervalMs === "number") {
        schedule = { type: "every", intervalMs: t.intervalMs };
      } else if (t.type === "weekly" && Array.isArray(t.weekdays) && typeof t.time === "string") {
        schedule = { type: "weekly", weekdays: t.weekdays.filter((d): d is number => typeof d === "number"), time: t.time };
      }
      // 借鉴弧 ε — 事件源（webhook 不带 token 进来：守护铸造）。
      else if (t.type === "event" && typeof t.source === "object" && t.source !== null) {
        const src = t.source as Record<string, unknown>;
        if (src.kind === "file" && typeof src.path === "string") {
          schedule = { type: "event", source: { kind: "file", path: src.path } };
        } else if (src.kind === "webhook") {
          schedule = { type: "event", source: { kind: "webhook" } };
        }
      }
      if (schedule === undefined) {
        return { content: 'trigger must be one of {type:"at", at:string} | {type:"every", intervalMs:number} | {type:"weekly", weekdays:number[], time:string} | {type:"event", source:{kind:"file", path:string}|{kind:"webhook"}}', isError: true };
      }
      if (typeof args.prompt !== "string" || args.prompt.trim() === "") {
        return { content: "prompt is required (the task prompt or the reminder text)", isError: true };
      }
      // 121 项 2 — the agent's own schedule stamps its birthplace: this
      // conversation's LIVE session id (execute-time read — a post-resume
      // rotation is honored), shape-gated (side- chains and junk never
      // stamp). Reminders never carry it (they run nothing). A face without
      // the seam, or a non-task kind, adds EXACTLY the pre-121 input shape.
      const liveSessionId = kind === "task" ? face.liveSessionId?.() : undefined;
      const origin = liveSessionId !== undefined && validScheduleOriginSessionId(liveSessionId)
        ? { sessionId: liveSessionId }
        : undefined;
      const text = await face.add({
        schedule,
        prompt: args.prompt,
        kind,
        ...(typeof args.sessionId === "string" && args.sessionId !== "" ? { sessionId: args.sessionId } : {}),
        ...(origin !== undefined ? { origin } : {}),
        ...(typeof args.budgetTokens === "number" ? { budgetTokens: args.budgetTokens } : {}),
        ...(typeof args.runtime === "object" && args.runtime !== null ? { runtime: args.runtime as import("./schedules-model.js").ScheduleRuntimeOverrides } : {}),
        ...(typeof args.snoozeMinutes === "number" ? { snoozeMinutes: args.snoozeMinutes } : {}),
        createdFrom: "schedule_add",
      });
      // The daemon's receipts are the user-facing ⚠️ lines on validation
      // failures — surface them as tool errors so the model corrects itself.
      return text.startsWith("⚠️") ? { content: text.slice(2).trim(), isError: true } : { content: text };
    },
  });

  const scheduleList = buildTool({
    name: "schedule_list",
    description: "List the durable scheduled tasks and reminders (id, trigger, next run, enabled state, prompt preview) — the same list /schedule shows the user.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    isOpenWorld: () => false,
    async execute() {
      return { content: face.listText() };
    },
  });

  const scheduleRemove = buildTool({
    name: "schedule_remove",
    description: "Remove one durable task or reminder by its 8-character id (see schedule_list).",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "8-character id from schedule_list" } },
      required: ["id"],
      additionalProperties: false,
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    isOpenWorld: () => false,
    async execute(args) {
      const id = String(args.id ?? "");
      const text = await face.rm(id);
      return text.startsWith("⚠️") ? { content: text.slice(2).trim(), isError: true } : { content: text };
    },
  });

  // 131 弧（zcode off-peak 引进）— defer_task：模型可托付的闲时车道。
  // 契约即文档（zcode 律）：行为纪律写在 schema 描述里——无人值守（没人
  // 应答，交付物要说显）、防递归（不得再排任务）都写在调用点。
  const deferTask = buildTool({
    name: "defer_task",
    description:
      'Defer work to IDLE time — the deferred run later continues THIS conversation unattended (full history available) when the user has been away for the requested idle window. Use it when the user says a task is not urgent ("闲时/回头/不急的时候再做"). The run has NO interactive user: state the expected deliverable explicitly in the prompt (nobody will answer questions during the run — decide yourself and proceed); never ask the run to create, schedule, or configure another task, reminder, or deferred task.',
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Concise title of the deferred work for receipts and the queue list (no file paths)" },
        prompt: { type: "string", description: "Instructions for the unattended run — it continues this conversation, so it may refer to context already established here; state the deliverable explicitly" },
        idle_minutes: { type: "number", description: `Minutes of user inactivity before the run starts (default ${String(DEFER_IDLE_DEFAULT_MINUTES)}, range 5-120)` },
        budget_tokens: { type: "number", description: "Optional per-run token ceiling" },
      },
      required: ["title", "prompt"],
      additionalProperties: false,
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    isOpenWorld: () => false,
    async execute(args) {
      if (typeof args.prompt !== "string" || args.prompt.trim() === "") {
        return { content: "prompt is required (the unattended run's instructions)", isError: true };
      }
      const idleMinutes = typeof args.idle_minutes === "number" && Number.isFinite(args.idle_minutes)
        ? args.idle_minutes
        : DEFER_IDLE_DEFAULT_MINUTES;
      // 121 项 2 同律 — agent 自设的闲时任务盖本会话 origin 章（火时
      // resume 本会话）+ sessionId 绑定（活宿主时走 continue 车道，无租约
      // 冲突）。
      const liveSessionId = face.liveSessionId?.();
      const origin = liveSessionId !== undefined && validScheduleOriginSessionId(liveSessionId)
        ? { sessionId: liveSessionId, contextHint: typeof args.title === "string" ? args.title : undefined }
        : undefined;
      const text = await face.add({
        schedule: { type: "idle", idleMinutes },
        prompt: args.prompt,
        kind: "task",
        ...(liveSessionId !== undefined && validScheduleOriginSessionId(liveSessionId) ? { sessionId: liveSessionId } : {}),
        ...(origin !== undefined ? { origin } : {}),
        ...(typeof args.budget_tokens === "number" ? { budgetTokens: args.budget_tokens } : {}),
        createdFrom: "defer_task",
      });
      return text.startsWith("⚠️") ? { content: text.slice(2).trim(), isError: true } : { content: text };
    },
  });

  return [scheduleAdd, scheduleList, scheduleRemove, deferTask];
}

