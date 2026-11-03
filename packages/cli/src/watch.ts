// ω99-118 — 页面盯看（watches）：cron 任务的单层薄壳。弧门：「对宠物说
// 『盯着这个页面』，它每半小时自己看一眼，页面变了气泡里告诉你。」
//
// 边界（brief 钉）：
// - watch 任务=普通 cron 任务（IntervalSchedule，origin:"model"，7 天自动
//   过期照旧）——变化判据=模型对会话历史里上次摘要做对比，零新存储；
// - 投递链全复用：fire → [scheduled task {id}] 前缀注入 → 105 气泡 →
//   115 收养，一个字节都不改；
// - 只消费 createTask（id/expiry 盖章/cap/session 归属全在 runtime 一处），
//   不复制 cron 语义；
// - 注册门=「cron runtime 在 且 浏览器工具面在」双门，无浏览器 fail-closed
//   不注册（同 cron posture；tools.ts 顶级集，subagent 永不可见）。
import { truncateSafe } from "@wudao-org/core"; // 113-A4
import { buildTool, nextFire, CronStoreRefusedError } from "@wudao-org/core";
import type { Tool } from "@wudao-org/core";
import type { CronRuntime } from "./cron.js";

/** watch prompt 的固定前缀——list/delete 的判据（模板前缀识别）。 */
export const WATCH_LEAD = "【页面盯看】";
/** 盯看间隔缺省（分钟）。 */
export const WATCH_DEFAULT_INTERVAL_MINUTES = 30;
/** 盯看间隔下限（分钟，防滥用）。 */
export const WATCH_MIN_INTERVAL_MINUTES = 5;

/** 固定中文模板（逐字钉测试）：重开不假设、摘要对比上文、一句话讲变化、
 *  「无变化」逐字、不贴全量快照——上下文纪律全在模板里，模型照办。 */
export function buildWatchPrompt(url: string): string {
  return (
    `${WATCH_LEAD}请看一眼这个页面有没有新变化：${url}\n` +
    "1. 用 browser_open 重新打开上面的网址，不要假设页面还开着。\n" +
    "2. 用 browser_snapshot 浏览页面，用一两句话概括当前内容。\n" +
    "3. 把这次的概括和对话里上一次的概括对比；找不到上一次的概括，就当作第一次看。\n" +
    "4. 有变化：只用一句话告诉用户页面变了什么。\n" +
    "5. 没变化：只回复「无变化」，不要多说。\n" +
    "无论有没有变化，都不要把页面的完整内容贴出来。"
  );
}

/** 模板首行取回 url（round-trip；非模板行 → ""）。纯。 */
export function watchUrlFromPrompt(prompt: string): string {
  if (!isWatchPrompt(prompt)) return "";
  const firstLine = prompt.split("\n")[0] ?? "";
  const at = firstLine.indexOf("：");
  return at === -1 ? "" : firstLine.slice(at + 1);
}

/** watch 任务判据：prompt 以固定模板前缀开头（cron 任务面里认出 watch）。纯。 */
export function isWatchPrompt(prompt: string): boolean {
  return prompt.startsWith(WATCH_LEAD);
}

export type WatchInterval = { readonly ok: true; readonly everyMs: number } | { readonly ok: false; readonly error: string };
export type WatchUrl = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly error: string };

/** intervalMinutes → everyMs。缺省 30；下限 5（含）；非有限数字 typed 拒。纯。 */
export function watchIntervalFromMinutes(raw: unknown): WatchInterval {
  const minutes = raw === undefined ? WATCH_DEFAULT_INTERVAL_MINUTES : raw;
  if (typeof minutes !== "number" || !Number.isFinite(minutes)) {
    return { ok: false, error: `intervalMinutes must be a number (minutes), got ${JSON.stringify(raw)}` };
  }
  if (minutes < WATCH_MIN_INTERVAL_MINUTES) {
    return { ok: false, error: `intervalMinutes must be >= ${WATCH_MIN_INTERVAL_MINUTES} (minutes) so checks stay reasonable; got ${minutes}` };
  }
  return { ok: true, everyMs: Math.round(minutes * 60_000) };
}

/** url 校验（与 browser_open 同规）：绝对 http(s)，其余 typed 拒（创建期
 *  拒掉永开不了的盯看，免得每 30 分钟白失败一次、连败 7 天）。保留用户
 *  给定的原样（trimmed）——模板嵌的是用户说的话，不做改写。纯。 */
export function watchUrlFromInput(raw: unknown): WatchUrl {
  const bad = (): WatchUrl => ({ ok: false, error: `url must be an absolute http(s) URL, got ${JSON.stringify(raw)}` });
  if (typeof raw !== "string" || raw.trim() === "") return bad();
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return bad();
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return bad();
  return { ok: true, url: raw.trim() };
}

const MIN = 60_000;

const describeWatch = (task: { readonly id: string; readonly prompt: string; readonly schedule: { readonly type: string; readonly everyMs?: number } }, now: number): string => {
  const every = task.schedule.type === "interval" && task.schedule.everyMs !== undefined
    ? `every ${Math.round(task.schedule.everyMs / MIN)}m`
    : task.schedule.type;
  return `- ${task.id}: ${every} · ${watchUrlFromPrompt(task.prompt) || truncateSafe(task.prompt, 80)}`;
};

/** The watch trio over the session's scheduler runtime. Top-level only, fixed
 *  position after the cron trio (prefix stability), fail-closed: the refusal
 *  surfaces as a tool error, never a silent no-op. */
export function createWatchTools(deps: { readonly runtime: CronRuntime; readonly now?: () => number }): Tool[] {
  const now = deps.now ?? Date.now;
  const refusal = (err: unknown): { content: string; isError: true } | undefined =>
    err instanceof CronStoreRefusedError ? { content: `scheduling unavailable: ${err.message}`, isError: true } : undefined;

  const watchCreate = buildTool({
    name: "watch_create",
    description:
      `Watch a web page for changes: schedules a recurring look at the URL every intervalMinutes minutes (default ${WATCH_DEFAULT_INTERVAL_MINUTES}, minimum ${WATCH_MIN_INTERVAL_MINUTES}). Each look re-opens the page, compares it with the previous summary in the conversation, and tells the user only what changed (or just 「无变化」 when nothing did). Watches stop automatically after 7 days. Use when the user asks to keep an eye on / monitor / 盯着 a page. Checks run only between turns; missed checks are not caught up.`,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL of the page to watch." },
        intervalMinutes: { type: "number", description: `How often to check, in minutes (minimum ${WATCH_MIN_INTERVAL_MINUTES}; default ${WATCH_DEFAULT_INTERVAL_MINUTES}).` },
      },
      required: ["url"],
      additionalProperties: false,
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    isOpenWorld: () => false,
    async execute(args) {
      // 校验在副作用之前（typed 拒，零任务落表）。
      const url = watchUrlFromInput(args["url"]);
      if (!url.ok) return { content: `watch_create: ${url.error}`, isError: true };
      const interval = watchIntervalFromMinutes(args["intervalMinutes"]);
      if (!interval.ok) return { content: `watch_create: ${interval.error}`, isError: true };
      try {
        const task = await deps.runtime.createTask({
          prompt: buildWatchPrompt(url.url),
          schedule: { type: "interval", everyMs: interval.everyMs },
          origin: "model",
        });
        const fire = nextFire(task, now());
        return {
          content:
            `watching ${url.url} every ${Math.round(interval.everyMs / MIN)}m (task ${task.id}) · next check ~${fire ? new Date(fire.fireAt).toISOString() : "n/a"} · watches stop automatically after 7 days · list with watch_list`,
        };
      } catch (err) {
        const r = refusal(err);
        if (r !== undefined) return r;
        throw err;
      }
    },
  });

  return [watchCreate, watchList(deps, now), watchDelete(deps)];
}

function watchList(deps: { readonly runtime: CronRuntime }, now: () => number): Tool {
  return buildTool({
    name: "watch_list",
    description: "List this session's active page watches (id, URL, check interval). Stop one with watch_delete.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    isOpenWorld: () => false,
    async execute() {
      const mine = deps.runtime.list().filter((t) => isWatchPrompt(t.prompt));
      if (mine.length === 0) return { content: "no page watches this session" };
      return { content: `page watches (${mine.length}):\n${mine.map((t) => describeWatch(t, now())).join("\n")}` };
    },
  });
}

function watchDelete(deps: { readonly runtime: CronRuntime }): Tool {
  return buildTool({
    name: "watch_delete",
    description: "Stop watching a page: delete one of this session's page watches by its 8-character id (see watch_list).",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "8-character watch id from watch_list" } },
      required: ["id"],
      additionalProperties: false,
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    isOpenWorld: () => false,
    async execute(args) {
      const id = typeof args["id"] === "string" ? args["id"] : "";
      if (id.trim() === "") return { content: 'watch_delete: "id" must be a watch id from watch_list', isError: true };
      const target = deps.runtime.list().find((t) => t.id === id);
      if (target === undefined) return { content: `watch_delete: no watch with id ${id} (see watch_list)`, isError: true };
      if (!isWatchPrompt(target.prompt)) return { content: `watch_delete: task ${id} is not a page watch (use cron_delete for scheduled tasks)`, isError: true };
      const removed = await deps.runtime.remove(id);
      if (!removed) return { content: `watch_delete: no watch with id ${id} (see watch_list)`, isError: true };
      return { content: `stopped watch ${id}${watchUrlFromPrompt(target.prompt) !== "" ? ` (${watchUrlFromPrompt(target.prompt)})` : ""}` };
    },
  });
}
