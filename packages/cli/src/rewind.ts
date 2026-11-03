// M37 §2 — /rewind: list the session's recorded file changes and roll the
// workspace back to before any step. The rollback restores snapshot bytes in
// reverse order (a create is undone by deleting the file), invalidates the
// session's read-state entries for the touched files, and informs the model
// through the MetaNote channel (the message history is never rewritten).
import { truncateSafe } from "@wudao-org/core"; // 113-A4
import { relative } from "node:path";
import type { FileHistory, FileHistoryEntry, ReadStateTable } from "@wudao-org/core";

/** What `/rewind [args]` asked for. P2-10 (96 队列) adds the conversation档:
 *  `turn` lists the active chain's recent user messages, `turn <n>` rewinds
 *  the active chain to BEFORE message n (branch semantics — the file forms
 *  above stay byte-stable). */
export type RewindTarget =
  | { kind: "list" }
  | { kind: "step"; n: number }
  | { kind: "last" }
  | { kind: "turn-list" }
  | { kind: "turn"; n: number }
  | { kind: "bad"; raw: string };

export function parseRewindTarget(args: string): RewindTarget {
  const trimmed = args.trim();
  if (trimmed === "") return { kind: "list" };
  if (trimmed.toLowerCase() === "last") return { kind: "last" };
  if (/^turn$/i.test(trimmed)) return { kind: "turn-list" };
  const turnMatch = /^turn[ \t]+(\d+)$/i.exec(trimmed);
  if (turnMatch !== null) return { kind: "turn", n: Number(turnMatch[1]) };
  if (/^\d+$/.test(trimmed)) return { kind: "step", n: Number(trimmed) };
  return { kind: "bad", raw: trimmed };
}

/** Display path for an entry: workspace-relative when inside, absolute else. */
export function displayPath(entry: FileHistoryEntry, workspaceRoot: string): string {
  const rel = relative(workspaceRoot, entry.file);
  return rel.startsWith("..") ? entry.file : rel;
}

/** The /rewind listing: one line per recorded step (seq, op, file, time). */
export function formatRewindList(entries: readonly FileHistoryEntry[], workspaceRoot: string): string {
  if (entries.length === 0) {
    // ω99-164: B15 空清单回执中文化（与 repl.ts #12 逐字同）。
    return "(本会话未记录文件改动——没有可回退的内容)";
  }
  const rows = entries.map((e) => {
    const time = e.at === "" ? "" : e.at.slice(11, 19);
    const rel = displayPath(e, workspaceRoot);
    return `  ${String(e.seq).padStart(3)}  ${e.op === "edit" ? "edit      " : "write_file"}  ${rel}${time ? `  ${time}Z` : ""}`;
  });
  // ω99-164: B16 清单头 + B17 脚注中文化（:48 一行两面；行格式 :46 刻意不动）。
  return ["本会话文件改动：", ...rows, '"/rewind <n>" 恢复到第 n 步之前 · "/rewind last" 撤销最近一步'].join("\n");
}

/** P2-10 (96 队列) — the /rewind turn listing row: one recent user message of
 *  the active chain (the same construction /edit uses; 1 = most recent). */
export interface RewindTurnRow {
  readonly n: number;
  readonly text: string;
}

/** The /rewind turn listing: the /edit-isomorphic face (1 = most recent, first
 *  line capped at 80) with its own header naming the rewind verb. */
export function formatRewindTurnList(rows: readonly RewindTurnRow[]): string {
  if (rows.length === 0) {
    // ω99-164: B18 空轮清单回执中文化。
    return "(还没有消息——没有可回退的内容)";
  }
  // ω99-164: B19 轮清单头中文化（rows 模板逐字保留；`/rewind turn <n>` 字面
  // 保留——rewind.test.ts:71 钉它，零演进）。
  return `最近消息（1 = 最近一条；/rewind turn <n> 把活跃链回退到第 n 条消息之前——回退掉的轮次仍可经 /tree //switch 找回）：\n${rows.map((t) => `  ${t.n}. ${truncateSafe(t.text.split("\n")[0] ?? "", 80)}`).join("\n")}`;
}

/** The model-facing MetaNote after a rollback (rides the next model call). */
export function buildFilesRewoundNote(toStep: number, files: readonly string[]): string {
  const unique = [...new Set(files)];
  return [
    `<files_rewound to_step="${toStep}">`,
    `Workspace files were restored to their state before step ${toStep} by the user (/rewind). Restored: ${unique.join(", ")}.`,
    "Your in-context view of these files is stale — re-read them before editing.",
    "</files_rewound>",
  ].join("\n");
}

export interface RewindOutcome {
  /** Human-facing one-line summary (printed/notified by the frontend). */
  readonly summary: string;
}

/** Run a rollback to before step n: restore snapshots (reverse order),
 *  invalidate the session's read-state entries for the touched files, and
 *  queue the model-facing MetaNote. Never touches the message history. */
export async function applyRewind(
  history: FileHistory,
  n: number,
  opts: {
    readonly workspaceRoot: string;
    readonly readState?: ReadStateTable;
    readonly pushMetaNote?: (text: string) => void;
  },
): Promise<RewindOutcome> {
  const undone = await history.rewindTo(n);
  const files = [...new Set(undone.map((e) => displayPath(e, opts.workspaceRoot)))];
  for (const e of undone) opts.readState?.delete(e.file);
  opts.pushMetaNote?.(buildFilesRewoundNote(n, files));
  return {
    // ω99-164: B20 步回退成功回执中文化（共享 helper——web/TUI 双前端同源）。
    summary: `↩ 已回退到第 ${n} 步之前——恢复了 ${undone.length} 步：${files.join(", ")}`,
  };
}
