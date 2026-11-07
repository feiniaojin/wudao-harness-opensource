// 123-3（zcode runFinalCriticLoop 引进，变体）— critic 终态评审。
//
// 问题：长任务跑完≠做对——todo 板上打勾的项是模型的自我申报，缺一个
// 「按验收标准逐项复核」的对抗视角。zcode 的 critic 是工作流阶段（图
// 执行器里的独立 phase，可重开图节点）；我们没有图执行器，但 todo 板就
// 是工作项表——本工具是它的终态评审面。
//
// 机制：模型在宣告长任务完成前调用 `critic_review`；工具发起一次独立
// 的轻量评审调用（side-call——不是模型在上下文里给自己打分：独立的
// 请求、评审提示词、结构化裁决），输入=todo 板 done 项+任务原话+近期
// 工作摘要，输出=pass | 逐项 reopen 建议（缺口说明）。模型据 reopen
// 建议自行打回工作项（todo_write 把 done 项改回 in_progress/pending）
// 并补做——打回动作留在模型手里（不自动续跑：自动循环是危险的升级面，
// no-progress 台账会抓住病态复读）。
//
// 审计：工具回执经正常 tool-result 持久化进转录（审计完整——评审发生
// 过、裁定了什么、都在盘上）；querySource="critic" 溯源（title/recap
// 车道同族——goal 计量的过滤纪律天然排除）。
import { buildTool, type Tool, type ModelClient, type AgentMessage } from "../index.js";

export const CRITIC_QUERY_SOURCE = "critic";

/** The board's done items as the critic sees them. */
export interface CriticBoardSnapshot {
  readonly doneItems: readonly string[];
  readonly incompleteItems: readonly string[];
  /** The full last board text (context for the reviewer). */
  readonly boardText: string;
}

export interface CriticReviewOptions {
  /** The review model (the SAME client the session runs on — an independent
   *  REQUEST is the adversarial separation we can honestly provide). */
  readonly model: ModelClient;
  /** The board read (execute-time; the last board in the live state). */
  readonly getBoard: () => CriticBoardSnapshot | undefined;
  /** The task statement — the run's original ask in the user's words (the
   *  acceptance criteria source: the 长任务纪律 asks the model to restate
   *  the user's own acceptance words; the first user message is the floor). */
  readonly getTaskStatement: () => string | undefined;
  /** Recent work evidence — the last few tool summaries (what actually ran);
   *  absent = the reviewer works from board + statement only. */
  readonly getRecentWork?: () => readonly AgentMessage[];
}

/** One gap the critic flags on a done item. */
export interface CriticGap {
  readonly item: string;
  readonly why: string;
}

/** Parse the critic's JSON verdict (tolerant — a malformed reply degrades to
 *  an honest error result, never a fabricated pass). */
export function parseCriticVerdict(reply: string): { verdict: "pass" | "reopen"; gaps: readonly CriticGap[] } | undefined {
  const json = /\{[\s\S]*\}/.exec(reply);
  if (json === null) return undefined;
  try {
    const raw = JSON.parse(json[0]) as { verdict?: unknown; gaps?: unknown };
    if (raw.verdict !== "pass" && raw.verdict !== "reopen") return undefined;
    const gaps: CriticGap[] = [];
    if (Array.isArray(raw.gaps)) {
      for (const g of raw.gaps) {
        if (typeof g === "object" && g !== null) {
          const item = (g as { item?: unknown }).item;
          const why = (g as { why?: unknown }).why;
          if (typeof item === "string" && item !== "" && typeof why === "string" && why !== "") {
            gaps.push({ item, why });
          }
        }
      }
    }
    if (raw.verdict === "reopen" && gaps.length === 0) return undefined; // reopen 必须点名
    return { verdict: raw.verdict, gaps };
  } catch {
    return undefined;
  }
}

/** The review prompt (byte-pinned — the adversarial framing is the tool). */
export function criticPrompt(snap: CriticBoardSnapshot, taskStatement: string, recentWork: string): string {
  return [
    "You are an adversarial completion reviewer. The agent below claims these work items are DONE.",
    "Review each DONE item against the task statement and the work evidence.",
    "An item is genuinely done only if the evidence shows the work happened AND meets the task's acceptance bar.",
    "Flag an item when: the work is asserted without evidence, partially done, done but off-spec, or the task statement implies verification that did not run.",
    "Do NOT flag style or phrasing; flag substance only. Be strict but fair.",
    "",
    "## Task statement (the user's own words)",
    taskStatement,
    "",
    "## Work board (the agent's claims)",
    snap.boardText,
    "",
    "## Recent work evidence (tool activity)",
    recentWork || "(none available)",
    "",
    'Reply with ONLY this JSON: {"verdict":"pass"} or {"verdict":"reopen","gaps":[{"item":"<the done item text>","why":"<the specific gap>"}]}',
  ].join("\n");
}

export function createCriticReviewTool(opts: CriticReviewOptions): Tool {
  return buildTool({
    name: "critic_review",
    promptSnippet: "adversarial review of the finished board before you report done",
    promptGuidelines: [
      "Run it before declaring a long task complete: it checks the done items against the task's own acceptance words.",
      "It returns reopen suggestions; acting on them stays your decision.",
    ],
    description:
      "Adversarial completion review — an INDEPENDENT review pass over your todo board's done items against the task statement. Call it before declaring a long task (≥3 steps) done: it returns pass, or per-item reopen gaps you then fix (flip the item back via todo_write, do the work, review again). Read-only. The verdict lands in the transcript — an honest audit of what you claimed done.",
    parameters: {
      type: "object",
      properties: {
        task_statement: {
          type: "string",
          description: "The acceptance criteria in the user's own words (paste the original ask; the reviewer checks each done item against it)",
        },
      },
      additionalProperties: false,
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    isOpenWorld: () => false,
    async execute(args) {
      const snap = opts.getBoard();
      if (snap === undefined || snap.doneItems.length === 0) {
        return { content: "没有可评审的完成项——todo 板上没有 done 项（先 todo_write 建板并推进，或在无板的短任务上跳过本工具）" };
      }
      const statement =
        typeof args.task_statement === "string" && args.task_statement.trim() !== ""
          ? args.task_statement.trim()
          : opts.getTaskStatement() ?? "(absent)";
      const recent = opts.getRecentWork?.() ?? [];
      const workText = recent
        .filter((m) => m.role === "assistant" || m.role === "tool")
        .slice(-12)
        .map((m) => (m.role === "assistant" ? `A: ${m.content.slice(0, 160)}` : `T: ${m.content.slice(0, 160)}`))
        .join("\n");
      try {
        const reply = await opts.model.generate({
          systemPrompt: "s",
          messages: [{ role: "user", content: criticPrompt(snap, statement, workText) }],
          tools: [],
          reasoningEffort: "low",
          maxTokens: 512,
          querySource: CRITIC_QUERY_SOURCE,
        });
        const verdict = parseCriticVerdict(reply.content);
        if (verdict === undefined) {
          return { content: "评审回复无法解析（非 JSON 或缺裁决）——视为未通过复核：自行逐项复查后再次调用", isError: true };
        }
        if (verdict.verdict === "pass") {
          return { content: `✅ 评审通过：${String(snap.doneItems.length)} 个完成项均经复核（对照任务原话与工作证据）` };
        }
        const lines = verdict.gaps.map((g) => `↩︎ 「${g.item}」— ${g.why}`);
        return {
          content:
            `⚠️ 评审打回 ${String(verdict.gaps.length)} 项（独立复核，对照任务原话与工作证据）：\n` +
            lines.join("\n") +
            "\n用 todo_write 把这些项改回未完成，补做后再次评审。",
        };
      } catch (err) {
        return { content: `评审调用失败：${err instanceof Error ? err.message : String(err)}——视为未通过复核，自行逐项复查`, isError: true };
      }
    },
  });
}
