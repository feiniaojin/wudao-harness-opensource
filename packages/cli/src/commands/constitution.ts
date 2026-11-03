// P2-13 (96 队列 #13) — /constitution: the HUMAN approval verb over the
// user constitution. ONE grammar, two frontends (the driver's case routes
// here, the REPL's branch calls the same runner), the /trust command-face
// pattern:
//   /constitution               → status: active digest / clause count /
//                                 staleness + the pending inbox (first-line
//                                 truncated) + usage
//   /constitution show          → the active file's content
//   /constitution approve <n>   → pending n → appended into the ACTIVE file
//                                 (atomic) + manifest digest recorded
//   /constitution reject <n>    → drop pending n
// Config-only (reads/writes ~/.wudao/constitution*), busy-safe like /plugin
// and /trust: never touches a run's files. Approvals change the SYSTEM
// PROMPT's constitution section — which is session-static (prefix-cache
// law), so they take effect on the NEXT session start (the receipt says
// so; this is the same restart note as lsp.enabled / MCP config changes).
import { truncateSafe } from "@wudao-org/core"; // 113-A4
import { approvePendingClause, constitutionStatus, rejectPendingClause } from "../constitution/store.js";

export interface RunConstitutionCommandArgs {
  /** The raw arg string after "/constitution" ("" | "show" | "approve <n>"
   * | "reject <n>" — the parse layer's exact-match grammar; junk here
   * answers with usage). */
  readonly args: string;
  /** Test seam (WUDAO_GLOBAL_HOME sandbox); production = process.env. */
  readonly env?: NodeJS.ProcessEnv;
}

/** First-line preview for the status list (the clause's own first line,
 * capped). */
const PREVIEW_CHARS = 60;

function firstLinePreview(content: string): string {
  const first = content.split("\n")[0] ?? "";
  return first.length <= PREVIEW_CHARS ? first : `${truncateSafe(first, PREVIEW_CHARS)}…`;
}

const USAGE = [
  "用法：/constitution——用户宪章", // ω99-166d-i: #25
  "  /constitution                状态（生效 digest、条款数、待审建议）", // ω99-179: #1
  "  /constitution show           查看生效宪章的完整内容", // ω99-179: #2
  "  /constitution approve <n>    批准第 n 条待审建议（原子写入 + 清单 digest）", // ω99-179: #3
  "  /constitution reject <n>     丢弃第 n 条待审建议", // ω99-179: #4
  "（模型只能经 constitution_suggest 建议；批准的条款在下一次会话启动时装入 prompt）", // ω99-179: #5
].join("\n");

/** Run /constitution. Pure-ish (reads the store, writes only on
 * approve/reject); never throws — failures land in the receipt text (both
 * frontends render notices, not error channels). */
export async function runConstitutionCommand(args: RunConstitutionCommandArgs): Promise<string> {
  const env = args.env ?? process.env;
  const rest = args.args.trim();

  if (rest !== "" && rest !== "show") {
    const m = /^(approve|reject) (\d+)$/.exec(rest);
    if (m === null) return USAGE;
    const n = Number(m[2]);
    try {
      if (m[1] === "approve") {
        const ap = approvePendingClause(n, env);
        return [
          `✅ 宪章条款已批准——当前生效 ${ap.clauseCount} 条，digest sha256:${ap.digest.slice(0, 12)}…`, // ω99-179: #6
          "prompt 段在会话内冻结（前缀缓存）：重启会话后装入修订的宪章", // ω99-179: #7
        ].join("\n");
      }
      const rj = rejectPendingClause(n, env);
      return `已丢弃待审建议 ${n}——收件箱还剩 ${rj.pendingCount} 条`; // ω99-179: #8
    } catch (err) {
      return `⚠️ /constitution ${m[1]} 失败：${err instanceof Error ? err.message : String(err)}`; // ω99-179: #9
    }
  }

  const status = constitutionStatus(env);

  if (rest === "show") {
    if (status.active === undefined) return "尚无生效宪章（~/.wudao/constitution.md 不存在）——请先批准一条待审建议"; // ω99-179: #10
    const head = status.active.stale
      ? "⚠️ 已过期——constitution.md 与批准时的 digest 不符（在 /constitution 之外编辑过？）；未装入 prompt" // ω99-179: #11
      : `生效宪章——digest sha256:${status.active.digest.slice(0, 12)}… · 共 ${status.active.clauseCount} 条`; // ω99-179: #12
    return `${head}\n\n${status.active.content.trimEnd()}`;
  }

  // Bare = status.
  const lines: string[] = [];
  if (status.active === undefined) {
    lines.push("宪章：暂无生效条款（~/.wudao/constitution.md 不存在）"); // ω99-179: #13
  } else if (status.active.stale) {
    lines.push("⚠️ 宪章：已过期——constitution.md 与批准时的 digest 不符（在 /constitution 之外编辑过？）"); // ω99-179: #14
    lines.push("  该段未装入；请恢复文件或经 /constitution 重新批准，然后重启会话"); // ω99-179: #15（行首两空格原样）
  } else {
    lines.push(`宪章：生效 ${status.active.clauseCount} 条——digest sha256:${status.active.digest.slice(0, 12)}…`); // ω99-179: #16
  }
  if (status.pending.length === 0) {
    lines.push("待审建议（0 条）：无——模型经 constitution_suggest 排队条款"); // ω99-179: #17
  } else {
    lines.push(`待审建议（${status.pending.length} 条）：`); // ω99-179: #18
    for (const p of status.pending) lines.push(`  ${p.n}. ${firstLinePreview(p.content)}`);
  }
  lines.push('用法：/constitution show · approve <n> · reject <n>'); // ω99-166d-i: #26
  return lines.join("\n");
}
