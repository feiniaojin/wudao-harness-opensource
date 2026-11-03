// M55 §C3 — /tasks: background agent listing from the registry snapshot. Shows
// id, role, status, lineage parentCallId when present, and a counts summary.
// NOTE: The registry status does NOT include the prompt (AgentStatusInfo lacks
// that field), so the prompt line is omitted. Pure formatting: the driver
// fetches the snapshot from the agent registry.
import type { AgentStatusInfo } from "@wudao-org/core";

/** One task row for the /tasks table. */
export interface TaskRow {
  readonly id: string;
  readonly role: string;
  readonly status: string;
  readonly parentCallId?: string;
  readonly writeScope?: string;
}

/** Build task rows from the registry status snapshot. */
export function buildTaskRows(status: readonly AgentStatusInfo[]): TaskRow[] {
  return status.map((s) => ({
    id: s.id,
    role: s.role,
    status: s.status,
    parentCallId: s.parentCallId,
    writeScope: s.writeScope,
  }));
}

/** Format the /tasks report with a summary header and the task table. */
export function formatTasksReport(rows: readonly TaskRow[]): string {
  if (rows.length === 0) {
    return "tasks:\n  (no background agents)";
  }
  // Count by status
  const byStatus = rows.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const statusSummary = Object.entries(byStatus)
    .map(([status, count]) => `${status}: ${count}`)
    .join(" · ");

  const lines = [
    `tasks (${rows.length} total · ${statusSummary}):`,
  ];
  for (const r of rows) {
    const lineage = r.parentCallId !== undefined ? ` → parent: ${r.parentCallId}` : "";
    const scope = r.writeScope !== undefined ? ` → scope: ${r.writeScope}` : "";
    lines.push(`  ${r.id} · ${r.role} · ${r.status}${lineage}${scope}`);
  }
  return lines.join("\n");
}
