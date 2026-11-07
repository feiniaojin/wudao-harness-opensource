// 127 项 1（docs/research/127-cross-session-chaining.md）— continue_task：
// 跨会话交棒面。任务未完但必须跨会话边界（quota 窗口 / 上下文极限 / app 要关）
// 时，模型把任务交成一个「链」：一个 baton 文件（.wudao/task-chain/<id>.md，
// 任务的事实工件——状态 + 指针，不复述内容）+ 一发 at one-shot 排程（默认
// origin-resume 车道：同会话 id → notes 目录、可搜账本、暖前缀全部免费）。
//
//   · baton 是 PLAIN MARKDOWN（同 note 的 .wudao 运行时数据纪律，plan.md 律：
//     绝不新增 JSON 持久格式）；头注释是机器面（id/hops/status/时间戳），
//     模型可用 read_file/edit_file 直接读改——链完成时把 status 改 done 即终链。
//   · 排程永远走 daemon 的 add 面（单宿主法则：绝不旁路直写 schedules.json，
//     daemon 的内存表整表快照会覆写外部写入）。
//   · 幂等（一链一发 pending 火）：同 task_id 已有待接棒的火 → 拒绝并提示等待
//     （127 设计 §3.4；匹配键 = createdFrom "continue_task" + 火的 prompt 字节）。
//   · 有帽：同工作区活跃链（pending 火）> 3 条拒绝——唤醒链不设上限是 dsh 教训，
//     排程链必须有帽，两回事。
//   · M24 纪律：工具定义加入工具列表是一个跨版本冷点（append-only 尾，紧跟
//     schedules 三件套；仅 daemon 宿主会话注册，headless/REPL/pet/子代理不注册
//     ——fail-closed 家族，v1 的 D 缺口边界如实化）。
//   · 权限姿态：写面（建排程 + 写 .wudao 运行时文件），CLI 侧与 schedule_add
//     同档进 WORKSPACE_TOOLS；风险标注 isReadOnly:false / isConcurrencySafe:false /
//     isDestructive:false / isOpenWorld:false。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildTool } from "../tool.js";
import type { Tool, ToolParameterSchema } from "../tool.js";

/** The chain id charset/shape: 8 chars from the schedule id alphabet
 * (lowercase + digits — the same set daemon ids mint from; path-safe by
 * construction since the id becomes a FILE NAME under .wudao/task-chain/). */
export const TASK_CHAIN_ID_RE = /^[a-z0-9]{8}$/;

/** Max chars of one hop's handoff (the note-family cap: a handoff is
 * task description + current progress + next steps, not a document — the
 * DETAILS live in notes files and the session ledger; the baton points,
 * it does not restate). */
export const HANDOFF_MAX_CHARS = 4000;

/** Default seconds until the next hop fires (task 127: 缺省 30s). */
export const CONTINUE_TASK_DEFAULT_DELAY_SECONDS = 30;
/** Upper bound of delay_seconds (24h — a chain hop is a relay, not a calendar). */
export const CONTINUE_TASK_MAX_DELAY_SECONDS = 86_400;
/** Active-chain cap per workspace (pending continue_task fires of DISTINCT
 * task ids; the 4th new chain is refused — 防失控自链，127 设计 §3.4). */
export const CONTINUE_TASK_ACTIVE_CHAIN_CAP = 3;

/** The schedules-table stamp identifying rows this tool created. */
export const CONTINUE_TASK_CREATED_FROM = "continue_task";

/** Where batons live (relative to the workspace root): .wudao/task-chain/. */
export function taskChainBatonDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".wudao", "task-chain");
}

/** The baton file of one chain: .wudao/task-chain/<task_id>.md. */
export function taskChainBatonPath(workspaceRoot: string, taskId: string): string {
  return join(taskChainBatonDir(workspaceRoot), `${taskId}.md`);
}

export type TaskChainStatus = "active" | "done" | "abandoned";

/** The baton's machine face (the header comment — same discipline as the
 * note's `<!-- wudao-note -->` line). */
export interface TaskChainHeader {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** How many hops have been handed off (the chain-history line count). */
  readonly hops: number;
  readonly status: TaskChainStatus;
}

const HEADER_RE = /^<!-- wudao-task-chain id="([a-z0-9]{8})" createdAt="([^"]+)" updatedAt="([^"]+)" hops="(\d+)" status="(active|done|abandoned)" -->\n/;

/** Render the header comment line. Pure. */
export function taskChainHeaderLine(h: TaskChainHeader): string {
  return `<!-- wudao-task-chain id="${h.id}" createdAt="${h.createdAt}" updatedAt="${h.updatedAt}" hops="${String(h.hops)}" status="${h.status}" -->`;
}

/** Parse the header from a baton file's text. Undefined = missing/corrupt
 * (the caller refuses fail-closed rather than rewriting a damaged baton). Pure. */
export function parseTaskChainHeader(text: string): TaskChainHeader | undefined {
  const m = HEADER_RE.exec(text);
  if (m === null) return undefined;
  const hops = Number(m[4]);
  if (!Number.isInteger(hops) || hops < 1) return undefined;
  return { id: m[1]!, createdAt: m[2]!, updatedAt: m[3]!, hops, status: m[5] as TaskChainStatus };
}

/** One chain-history line (append-only; preserved verbatim on re-render).
 * Pure. */
export function taskChainHistoryLine(hop: number, atIso: string, sessionId: string, delaySeconds: number): string {
  return `- [${String(hop)}] ${atIso} session ${sessionId} 交棒，${String(delaySeconds)}s 后在原会话继续（resume）`;
}

/** Extract the chain-history lines from an existing baton (everything under
 * `## 链史` that looks like a history entry; hand-edited lines survive).
 * Pure. */
export function parseTaskChainHistory(text: string): readonly string[] {
  const idx = text.indexOf("## 链史");
  if (idx < 0) return [];
  return text
    .slice(idx + "## 链史".length)
    .split("\n")
    .filter((l) => l.startsWith("- ["))
    .map((l) => l.trimEnd());
}

/** The baton body the renderer consumes. */
export interface TaskChainBaton {
  readonly header: TaskChainHeader;
  /** This hop's handoff, verbatim (the newest projection of 状态节). */
  readonly handoff: string;
  /** The session handing off now (the resume lane's origin). */
  readonly sessionId: string;
  /** ALL history lines (prior verbatim + the new hop's line appended). */
  readonly history: readonly string[];
}

/** Render the full baton file (头注释 + 状态节 + 指针节 + 链史). Pure. */
export function renderTaskChainBaton(b: TaskChainBaton): string {
  const { header, handoff, sessionId, history } = b;
  return [
    taskChainHeaderLine(header),
    `# 任务链 ${header.id}`,
    "",
    "## 当前状态（最新一棒的交接）",
    "",
    handoff,
    "",
    "## 指针",
    "",
    `- 前任会话: ${sessionId}（resume 车道——.wudao/notes/${sessionId}/ 的笔记与本会话历史在续跑时原样可用）`,
    `- 交接档案: .wudao/task-chain/${header.id}.md（本文件——每棒重写「当前状态」与「指针」，链史只增）`,
    "",
    "## 链史",
    "",
    ...history,
    "",
  ].join("\n");
}

/** The fired turn's task prompt (byte-stable template — the idempotency
 * match key AND what the fired session reads). The tail is honest about the
 * v1 D-gap boundary: a HEADLESS fired leg has no continue_task tool (the
 * daemon host alone schedules) — its endgame is editing the baton directly
 * (edit_file is a plain file write, the model's own documented channel). */
export function continueTaskPrompt(taskId: string): string {
  return `[接力] 继续任务 ${taskId}：先读 .wudao/task-chain/${taskId}.md（「当前状态」+「链史」），按交接继续。完成后仍未完结：有 continue_task 工具就再次交棒；没有（无头续跑腿）就用 edit_file 把最新进展写回该文件的「当前状态」并补一行链史`;
}

/** The origin stamp's context hint (the fired prefix the resume lane shows
 * — [定时续跑] {hint}; short, it points at the baton). Pure. */
export function continueTaskContextHint(taskId: string): string {
  return `继续任务 ${taskId}：先读 .wudao/task-chain/${taskId}.md`;
}

/** The structured view of ONE schedules-table row the idempotency scan
 * needs (a structural subset of the daemon's durable rows — additive
 * optional fields on the real row type are invisible here). */
export interface ContinueTaskPendingRow {
  readonly id: string;
  readonly createdFrom: string;
  readonly prompt: string;
  readonly schedule: { readonly type: string; readonly at?: number };
  readonly nextRunAt?: number;
  readonly lastFiredAt?: number;
  readonly paused?: boolean;
  readonly enabled?: boolean;
}

/** The add input this tool sends to the schedules face (a structural subset
 * of the daemon's add input — kind:"task", one `at` one-shot, the origin
 * stamp riding the resume lane). */
export interface ContinueTaskScheduleInput {
  readonly schedule: { readonly type: "at"; readonly at: number };
  readonly prompt: string;
  readonly kind: "task";
  readonly origin: { readonly sessionId: string; readonly contextHint?: string };
  readonly createdFrom: typeof CONTINUE_TASK_CREATED_FROM;
}

/** The schedules face the tool needs: the daemon's add (single-host law —
 * every schedule goes through it, never a direct store write) + the
 * structured list (the idempotency scan's truth). */
export interface ContinueTaskScheduleFace {
  add(input: ContinueTaskScheduleInput): Promise<string>;
  list(): readonly ContinueTaskPendingRow[];
}

/** The seams a frontend wires to mount continue_task. */
export interface ContinueTaskToolOptions {
  readonly workspaceRoot: string;
  readonly face: ContinueTaskScheduleFace;
  /** The LIVE session id (execute-time read — a post-resume rotation is
   * honored), i.e. the resume lane's origin. */
  readonly sessionId: () => string | undefined;
  readonly now?: () => number;
}

const PARAMETERS: ToolParameterSchema = {
  type: "object",
  properties: {
    task_id: {
      type: "string",
      description: "任务链的唯一标识：8 位小写字母/数字（跨会话稳定——链的身份不是会话身份；同一链的每一棒用同一个 task_id）",
    },
    handoff: {
      type: "string",
      description: `交接内容：任务描述 + 当前进展 + 下一步。写给下一棒的自己，要包含足够上下文让它立刻继续（细节放 note_write/文件里，这里给结论与指针）。上限 ${String(HANDOFF_MAX_CHARS)} 字符。`,
    },
    delay_seconds: {
      type: "number",
      description: `下次接棒的延迟（秒，缺省 ${String(CONTINUE_TASK_DEFAULT_DELAY_SECONDS)}，上限 ${String(CONTINUE_TASK_MAX_DELAY_SECONDS)}）——quota 窗口对齐重置点、app 将关给重开留时间`,
    },
  },
  required: ["task_id", "handoff"],
  additionalProperties: false,
};

const sidValid = (sid: string | undefined): sid is string =>
  typeof sid === "string" && sid !== "" && !sid.startsWith("side-") && /^[A-Za-z0-9_-]+$/.test(sid);

export function createContinueTaskTool(options: ContinueTaskToolOptions): Tool {
  const now = options.now ?? Date.now;
  return buildTool({
    name: "continue_task",
    promptSnippet: "hand the task to a later session (write a baton, schedule the resume)",
    promptGuidelines: [
      "Use it when work must outlive this run — a scheduled resume picks the baton up exactly where you left it.",
    ],
    description:
      "长任务需要跨会话时使用（quota 窗口 / 上下文极限 / app 要关）：把任务交给一个链——写一份交接档案（.wudao/task-chain/<task_id>.md）并安排一发延迟的接棒排程（默认在原会话 resume 续跑，notes 和历史原样保留）。handoff 要包含足够的上下文让下一次接棒的自己能立刻继续。同一 task_id 已有待接棒的排程时会拒绝（等它接棒后再交下一棒）；任务完成后不再调用即终链（也可把档案 status 改为 done）。",
    parameters: PARAMETERS,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    isOpenWorld: () => false,
    async execute(args) {
      // --- typed doors (fail-closed, before any side effect) ---
      const taskId = args["task_id"];
      if (typeof taskId !== "string" || !TASK_CHAIN_ID_RE.test(taskId)) {
        return { content: `continue_task: task_id 需为 8 位小写字母/数字（收到 ${JSON.stringify(String(taskId))}）——同一链的每一棒复用同一个 task_id`, isError: true };
      }
      const handoff = args["handoff"];
      if (typeof handoff !== "string" || handoff.trim() === "") {
        return { content: "continue_task: handoff 必填（任务描述 + 当前进展 + 下一步——下一棒的自己靠它立刻继续）", isError: true };
      }
      if (handoff.length > HANDOFF_MAX_CHARS) {
        return { content: `continue_task: handoff 超过 ${String(HANDOFF_MAX_CHARS)} 字符上限（收到 ${String(handoff.length)}）——细节放 note_write/文件，这里给结论与指针`, isError: true };
      }
      const delayRaw = args["delay_seconds"];
      const delaySeconds = delayRaw === undefined ? CONTINUE_TASK_DEFAULT_DELAY_SECONDS : Number(delayRaw);
      if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > CONTINUE_TASK_MAX_DELAY_SECONDS) {
        return { content: `continue_task: delay_seconds 需为 1-${String(CONTINUE_TASK_MAX_DELAY_SECONDS)} 的整数（收到 ${String(delayRaw)}）`, isError: true };
      }
      const liveSid = options.sessionId();
      if (!sidValid(liveSid)) {
        return { content: "continue_task: 本会话没有可续跑的主会话 id（fail-closed）——此工具只在带调度守护的宿主会话可用", isError: true };
      }
      // --- idempotency: one chain, one pending fire (127 设计 §3.4) ---
      const firedPrompt = continueTaskPrompt(taskId);
      const rows = options.face.list();
      const mine = rows.filter((r) => r.createdFrom === CONTINUE_TASK_CREATED_FROM && continueTaskPromptMatch(r.prompt) === taskId);
      if (mine.length > 0) {
        const row = mine[0]!;
        if (row.enabled === false) {
          return { content: `任务链 ${taskId} 的排程已被熔断停用（连续失败）——请先让用户 /schedule unpause ${row.id} 重开，或另起 task_id`, isError: true };
        }
        if (row.paused === true) {
          return { content: `任务链 ${taskId} 的排程已暂停——先恢复（/schedule unpause ${row.id}）再交棒`, isError: true };
        }
        return { content: `任务链 ${taskId} 已有一发待接棒的排程在等待——等它到点接棒完成后再交下一棒（schedule_list 可查）`, isError: true };
      }
      // --- the runaway-chain cap (pending fires of DISTINCT task ids) ---
      const activeChains = new Set(
        rows
          .filter((r) => r.createdFrom === CONTINUE_TASK_CREATED_FROM && r.enabled !== false && r.paused !== true)
          .map((r) => continueTaskPromptMatch(r.prompt))
          .filter((id): id is string => id !== undefined),
      );
      activeChains.delete(taskId);
      if (activeChains.size >= CONTINUE_TASK_ACTIVE_CHAIN_CAP) {
        return { content: `本工作区已有 ${String(activeChains.size)} 条活跃任务链（帽 ${String(CONTINUE_TASK_ACTIVE_CHAIN_CAP)}）——先完成或收尾现有链再开新链`, isError: true };
      }
      // --- the baton (fact artifact): write BEFORE the schedule so a failed
      // add leaves an inert file (retry-safe), never a fire with no baton. ---
      const batonPath = taskChainBatonPath(options.workspaceRoot, taskId);
      let existing: string | undefined;
      try {
        existing = await readFile(batonPath, "utf8");
      } catch {
        existing = undefined; // no baton yet — a fresh chain (or a lost file; hop 1 restarts the ledger)
      }
      const atMs = now();
      const atIso = new Date(atMs).toISOString();
      let createdAt = atIso;
      let hops = 1;
      let history: readonly string[] = [];
      if (existing !== undefined) {
        const header = parseTaskChainHeader(existing);
        if (header === undefined) {
          return { content: `continue_task: 交接档案已存在但头注释不可解析（${batonPath}）——手工修复或删除该文件后重试，绝不盲目覆写`, isError: true };
        }
        createdAt = header.createdAt;
        hops = header.hops + 1;
        history = parseTaskChainHistory(existing);
      }
      const historyLines = [...history, taskChainHistoryLine(hops, atIso, liveSid, delaySeconds)];
      const baton = renderTaskChainBaton({
        header: { id: taskId, createdAt, updatedAt: atIso, hops, status: "active" },
        handoff,
        sessionId: liveSid,
        history: historyLines,
      });
      try {
        await mkdir(taskChainBatonDir(options.workspaceRoot), { recursive: true });
        await writeFile(batonPath, baton, "utf8");
      } catch (err) {
        return { content: `continue_task: 交接档案写入失败 — ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      // --- the schedule: ONE at one-shot on the resume lane (single-host
      // law — through the daemon's add face, never a direct store write). ---
      const receipt = await options.face.add({
        schedule: { type: "at", at: atMs + delaySeconds * 1000 },
        prompt: firedPrompt,
        kind: "task",
        origin: { sessionId: liveSid, contextHint: continueTaskContextHint(taskId) },
        createdFrom: CONTINUE_TASK_CREATED_FROM,
      });
      if (receipt.startsWith("⚠️")) {
        return { content: receipt.slice(2).trim(), isError: true };
      }
      return {
        content: `🔗 已安排任务 ${taskId} 在 ${String(delaySeconds)}s 后继续。Baton 文件：.wudao/task-chain/${taskId}.md。当前会话的 notes 和历史会在 resume 时保留。`,
      };
    },
  });
}

/** Recover the chain task_id from a continue_task row's prompt (the baton
 * path embeds it). Undefined = not one of this tool's prompts. Pure. */
export function continueTaskPromptMatch(prompt: string): string | undefined {
  const m = /\[接力\] 继续任务 ([a-z0-9]{8})：先读 \.wudao\/task-chain\/[a-z0-9]{8}\.md/.exec(prompt);
  return m?.[1];
}
