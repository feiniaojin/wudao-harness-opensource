// 124b 项 1（the upstream projectinstant_interrupt）——流抢占的旁路审计。
//
// 被弃 partial 的量与时刻只走这条旁路日志（.wudao/logs/stream-preempt-
// audit.jsonl）：不进会话 JSONL 转录（M24：append-only 历史零接触）、不进
// 模型所见（前缀字节稳定声明的另一半）。这是刻意的三分离——
//   转录（state.messages/JSONL）＝模型与回放的真相，被弃内容不在其中；
//   UI 历史（appendHistory）＝人看的流式保真，被弃内容标中断展示；
//   旁路日志（本件）＝审计面：字节量 + 时刻 + 会话，可 grep 可聚合。
// 写入 fire-and-forget：失败静默（一条审计行绝不打断运行链）。

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

/** One preempted-stream audit row (JSONL line). */
export interface StreamPreemptAuditEntry {
  /** ISO timestamp (the loop's preemptedAt). */
  readonly at: string;
  /** The turn whose model call was preempted. */
  readonly turn: number;
  /** Abandoned body chars (UTF-16 code units, 0 = preempted pre-first-delta). */
  readonly droppedTextChars: number;
  /** Abandoned reasoning chars (UTF-16 code units). */
  readonly droppedReasoningChars: number;
  /** The session whose run was preempted (attribution across sessions). */
  readonly sessionId?: string;
}

/** The audit file's home: <workspaceRoot>/.wudao/logs/stream-preempt-audit.jsonl. */
export function streamPreemptAuditPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".wudao", "logs", "stream-preempt-audit.jsonl");
}

/** Append one audit row (mkdir on demand). Callers fire-and-forget. */
export async function appendStreamPreemptAudit(workspaceRoot: string, entry: StreamPreemptAuditEntry): Promise<void> {
  const path = streamPreemptAuditPath(workspaceRoot);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}
