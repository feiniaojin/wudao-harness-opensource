import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  MCP_PROMPT_SECTION,
  SYSTEM_PREAMBLE,
  CORE_PRINCIPLES_SECTION,
  TOOL_USAGE_SECTION,
  TASK_DISCIPLINE_SECTION,
  LONG_TASKS_SECTION,
  BEHAVIORAL_CONTRACTS_SECTION,
  environmentSection,
} from "../src/prompt.js";

/** Section headings in output order. */
function headings(p: string): string[] {
  return [...p.matchAll(/^# (.+)$/gm)].map((m) => m[1] ?? "");
}

describe("buildSystemPrompt — section architecture (M26 P1)", () => {
  it("orders sections: core principles → tool usage → task discipline → long tasks → behavioral contracts → environment", () => {
    const p = buildSystemPrompt("/tmp/ws");
    const firstWords = headings(p).map((h) => h.split(" ")[0]);
    expect(firstWords).toEqual(["Core", "Tool", "Task", "Long", "Behavioral", "Environment"]);
    // Headings are unique — no section silently duplicated.
    expect(new Set(headings(p)).size).toBe(headings(p).length);
  });

  it("output bytes map 1:1 onto the section constants (factory assembly)", () => {
    const p = buildSystemPrompt("/tmp/ws");
    expect(p).toBe(
      [SYSTEM_PREAMBLE, CORE_PRINCIPLES_SECTION, TOOL_USAGE_SECTION, TASK_DISCIPLINE_SECTION, LONG_TASKS_SECTION, BEHAVIORAL_CONTRACTS_SECTION, environmentSection("/tmp/ws")].join("\n\n"),
    );
    // …and every section const actually appears verbatim in the output.
    for (const section of [CORE_PRINCIPLES_SECTION, TOOL_USAGE_SECTION, TASK_DISCIPLINE_SECTION, LONG_TASKS_SECTION, BEHAVIORAL_CONTRACTS_SECTION]) {
      expect(p).toContain(section);
    }
  });

  it("environment is the LAST static section — cwd/platform stay at the tail", () => {
    const p = buildSystemPrompt("/tmp/ws");
    expect(p.indexOf("# Environment")).toBeGreaterThan(p.indexOf("# Behavioral contracts"));
    expect(p).toContain("Working directory: /tmp/ws");
    // The dynamic bytes are confined to the environment tail: everything
    // before "# Environment" is byte-identical across workspaces.
    const other = buildSystemPrompt("/tmp/other-ws");
    const cut = (s: string): string => s.slice(0, s.indexOf("# Environment"));
    expect(cut(other)).toBe(cut(p));
  });

  it("is byte-stable across calls in one run (prefix-cache friendly)", () => {
    expect(buildSystemPrompt("/tmp/ws")).toBe(buildSystemPrompt("/tmp/ws"));
  });
});

describe("buildSystemPrompt — behavioral contracts (M26 P1)", () => {
  const p = buildSystemPrompt("/tmp/ws");
  const section = p.slice(p.indexOf("# Behavioral contracts"), p.indexOf("# Environment"));

  it("denied-call handling: no immediate same-call retry, find another path or ask", () => {
    expect(section).toContain("Denied calls");
    expect(section).toMatch(/denied/i);
    expect(section).toMatch(/do NOT immediately retry the same call/i);
    expect(section).toMatch(/different path|ask the user/i);
  });

  it("injection-defense duty: tool results and file contents are untrusted data", () => {
    expect(section).toContain("Untrusted content");
    expect(section).toMatch(/DATA, not instructions/i);
    expect(section).toMatch(/never be followed/i);
  });

  it("minimal change + blast radius", () => {
    expect(section).toContain("Minimal change & blast radius");
    expect(section).toMatch(/only the code related to the task/i);
    expect(section).toMatch(/blast radius/i);
    expect(section).toMatch(/Don't refactor or reformat unrelated code/i);
  });

  it("parallel-tool contract: independent operations in one turn", () => {
    expect(section).toContain("Parallel reads");
    expect(section).toMatch(/issue them together in ONE turn/i);
  });
});

describe("buildSystemPrompt — todo_write timing rules in the tool section (M26 P1)", () => {
  it("carries the four timing rules inside # Tool usage, before task discipline", () => {
    const p = buildSystemPrompt("/tmp/ws");
    const section = p.slice(p.indexOf("# Tool usage"), p.indexOf("# Task discipline"));
    expect(section).toMatch(/todo_write: create the board the moment a task starts/i);
    expect(section).toMatch(/Update it immediately after each step completes/i);
    expect(section).toMatch(/Never mark an item done before its tests pass/i);
    expect(section).toMatch(/summarize your work against the board/i);
  });

  it("keeps the long-task protocol verbatim, after task discipline", () => {
    const p = buildSystemPrompt("/tmp/ws");
    expect(p).toContain(LONG_TASKS_SECTION);
    expect(p.indexOf("# Task discipline")).toBeLessThan(p.indexOf("# Long tasks"));
    expect(p.indexOf("# Long tasks")).toBeLessThan(p.indexOf("# Behavioral contracts"));
  });

  it("folds the old working-on-tasks guidance into task discipline", () => {
    const p = buildSystemPrompt("/tmp/ws");
    expect(p).not.toContain("# Working on tasks");
    expect(TASK_DISCIPLINE_SECTION).toContain("Interpret unclear or generic instructions");
    expect(TASK_DISCIPLINE_SECTION).toContain("explore (glob/grep/read_file) → act (write_file/edit) → verify (shell)");
    expect(TASK_DISCIPLINE_SECTION).toContain('short confirmation (e.g. "ok", "yes", "要", "继续")');
  });
});

describe("buildSystemPrompt — MCP trailing section", () => {
  it("has no MCP section when no MCP tools exist", () => {
    const p = buildSystemPrompt("/tmp/ws");
    expect(p).not.toContain("MCP tools");
    expect(p.endsWith("Respond in the same language the user writes in (中文 → 用中文回答).")).toBe(true);
  });

  it("appends the MCP section at the END when MCP tools exist (prefix stays byte-stable)", () => {
    const without = buildSystemPrompt("/tmp/ws");
    const withMcp = buildSystemPrompt("/tmp/ws", true);
    // The whole non-MCP prompt is an exact prefix of the MCP variant — the
    // trailing section is purely additive for provider prefix caches.
    expect(withMcp.startsWith(without)).toBe(true);
    expect(withMcp.slice(without.length)).toBe(MCP_PROMPT_SECTION);
    expect(MCP_PROMPT_SECTION).toContain("mcp__");
    expect(MCP_PROMPT_SECTION).toContain(".wudao/mcp.json");
  });
});

describe("buildSystemPrompt — long-task discipline copy (114)", () => {
  const p = buildSystemPrompt("/tmp/ws");
  const longTasks = p.slice(p.indexOf("# Long tasks"), p.indexOf("# Behavioral contracts"));
  const toolUsage = p.slice(p.indexOf("# Tool usage"), p.indexOf("# Task discipline"));

  it("① acceptance contract first: write the acceptance standard in the task's own words before starting, self-check per block", () => {
    expect(longTasks).toContain("验收");
    expect(longTasks).toContain("任务原话");
    expect(longTasks).toContain("不要自造替代指标");
    expect(longTasks).toContain("每完成一块");
    expect(longTasks).toContain("不要把全部验证留到最后一刻");
    // it rides the long-task board protocol (after the todo_write bullet,
    // before the per-step verify bullet — start-of-work guidance)
    expect(longTasks.indexOf("验收")).toBeGreaterThan(longTasks.indexOf("todo_write"));
    expect(longTasks.indexOf("验收")).toBeLessThan(longTasks.indexOf("A code step is not done until verified"));
  });

  it("③ polling anti-pattern: long waits go to a background watch with event wake, never sleep+re-check loops", () => {
    // rides the shell bullet in # Tool usage (the tool-discipline seam)
    const shellBullet = toolUsage.split("\n").find((l) => l.startsWith("- shell:"));
    expect(shellBullet).toBeDefined();
    expect(shellBullet).toMatch(/monitor_start/);
    expect(shellBullet).toMatch(/monitor_read/);
    expect(shellBullet).toMatch(/don't loop sleep \+ re-check/);
    expect(shellBullet).toMatch(/every wait costs a full model turn/);
  });

  it("generic copy only — zero benchmark names in the new paragraphs (grep gate)", () => {
    const newCopy = longTasks + toolUsage;
    expect(newCopy).not.toMatch(/terminal[- ]?bench|swe[- ]?bench|humaneval|mlbench|\btb\b/i);
  });
});
