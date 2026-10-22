// M55 §C3 — /tasks tests.
import { describe, it, expect } from "vitest";
import { buildTaskRows, formatTasksReport } from "../src/commands/tasks.js";
import type { AgentStatusInfo } from "@wudao/core";

describe("/tasks", () => {
  it("builds task rows from status snapshot", () => {
    const status: AgentStatusInfo[] = [
      {
        id: "bg-1",
        role: "coder",
        status: "running",
        parentCallId: "call-123",
      },
      {
        id: "bg-2",
        role: "tester",
        status: "done",
      },
    ];

    const rows = buildTaskRows(status);
    expect(rows.length).toBe(2);
    expect(rows[0].id).toBe("bg-1");
    expect(rows[0].role).toBe("coder");
    expect(rows[0].status).toBe("running");
    expect(rows[0].parentCallId).toBe("call-123");

    expect(rows[1].id).toBe("bg-2");
    expect(rows[1].role).toBe("tester");
    expect(rows[1].status).toBe("done");
    expect(rows[1].parentCallId).toBeUndefined();
  });

  it("includes writeScope when present", () => {
    const status: AgentStatusInfo[] = [
      {
        id: "bg-1",
        role: "coder",
        status: "running",
        writeScope: "src/*.ts",
      },
    ];

    const rows = buildTaskRows(status);
    expect(rows[0].writeScope).toBe("src/*.ts");
  });

  it("formats tasks report with header and table", () => {
    const rows = [
      {
        id: "bg-1",
        role: "coder",
        status: "running",
        parentCallId: "call-123",
        writeScope: undefined,
      },
      {
        id: "bg-2",
        role: "tester",
        status: "done",
        parentCallId: undefined,
        writeScope: undefined,
      },
    ];

    const report = formatTasksReport(rows);
    expect(report).toMatch(/^tasks \(2 total/);
    expect(report).toContain("bg-1");
    expect(report).toContain("coder");
    expect(report).toContain("running");
    expect(report).toContain("→ parent: call-123");

    expect(report).toContain("bg-2");
    expect(report).toContain("tester");
    expect(report).toContain("done");
  });

  it("formats empty report when no tasks", () => {
    const report = formatTasksReport([]);
    expect(report).toBe("tasks:\n  (no background agents)");
  });

  it("counts status summary correctly", () => {
    const rows = [
      { id: "bg-1", role: "coder", status: "running", parentCallId: undefined, writeScope: undefined },
      { id: "bg-2", role: "tester", status: "running", parentCallId: undefined, writeScope: undefined },
      { id: "bg-3", role: "reviewer", status: "done", parentCallId: undefined, writeScope: undefined },
      { id: "bg-4", role: "planner", status: "failed", parentCallId: undefined, writeScope: undefined },
    ];

    const report = formatTasksReport(rows);
    expect(report).toContain("running: 2");
    expect(report).toContain("done: 1");
    expect(report).toContain("failed: 1");
  });

  it("includes writeScope in report when present", () => {
    const rows = [
      {
        id: "bg-1",
        role: "coder",
        status: "running",
        parentCallId: undefined,
        writeScope: "src/*.ts",
      },
    ];

    const report = formatTasksReport(rows);
    expect(report).toContain("→ scope: src/*.ts");
  });
});
