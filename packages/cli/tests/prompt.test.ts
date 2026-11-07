import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  MCP_PROMPT_SECTION,
  SYSTEM_PREAMBLE,
  CORE_PRINCIPLES_SECTION,
  OUTPUT_CHANNEL_SECTION,
  TASK_DISCIPLINE_SECTION,
  FINISHING_JOB_SECTION,
  LONG_TASKS_SECTION,
  BEHAVIORAL_CONTRACTS_SECTION,
  ACTIONS_SECTION,
  environmentSection,
} from "../src/prompt.js";
import { buildToolSet } from "../src/tools.js";
import { renderToolGuideSection } from "@wudao-org/core";

// 生产工具集本身（渲染 Tool usage 节的唯一来源——不再有硬编码兜底）。
const PROD_TOOLS = buildToolSet({ workspaceRoot: "/tmp/ws", model: "stub" } as never);

/** 带真实工具集的提示词：凡是断言 Tool usage 节内容的用例都用它。 */
const withTools = (root = "/tmp/ws"): string =>
  buildSystemPrompt(root, false, [], false, false, PROD_TOOLS);

/** Section headings in output order. */
function headings(p: string): string[] {
  return [...p.matchAll(/^# (.+)$/gm)].map((m) => m[1] ?? "");
}

describe("buildSystemPrompt — section architecture (M26 P1)", () => {
  it("orders sections: core principles → tool usage → task discipline → long tasks → behavioral contracts → environment", () => {
    const p = withTools();
    const firstWords = headings(p).map((h) => h.split(" ")[0]);
    expect(firstWords).toEqual(["Core", "Tool", "What", "Task", "Finishing", "Long", "Behavioral", "Executing", "Environment"]);
    // Headings are unique — no section silently duplicated.
    expect(new Set(headings(p)).size).toBe(headings(p).length);
  });

  it("output bytes map 1:1 onto the section constants (factory assembly)", () => {
    const p = withTools();
    expect(p).toBe(
      [SYSTEM_PREAMBLE, CORE_PRINCIPLES_SECTION, renderToolGuideSection(PROD_TOOLS), OUTPUT_CHANNEL_SECTION, TASK_DISCIPLINE_SECTION, FINISHING_JOB_SECTION, LONG_TASKS_SECTION, BEHAVIORAL_CONTRACTS_SECTION, ACTIONS_SECTION, environmentSection("/tmp/ws")].join("\n\n"),
    );
    // …and every section const actually appears verbatim in the output.
    for (const section of [CORE_PRINCIPLES_SECTION, renderToolGuideSection(PROD_TOOLS), OUTPUT_CHANNEL_SECTION, TASK_DISCIPLINE_SECTION, FINISHING_JOB_SECTION, LONG_TASKS_SECTION, BEHAVIORAL_CONTRACTS_SECTION, ACTIONS_SECTION]) {
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
    expect(section).toContain("Parallel calls");
    expect(section).toMatch(/issue them together in ONE turn/i);
  });
});

describe("buildSystemPrompt — todo_write timing rules in the tool section (M26 P1)", () => {
  it("carries the todo timing rules inside # Tool usage, before task discipline", () => {
    const p = withTools();
    const section = p.slice(p.indexOf("# Tool usage"), p.indexOf("# Task discipline"));
    // 工具的 snippet + guidelines 现在承载这些规则（不再是一段硬编码清单）。
    expect(section).toMatch(/todo_write: the task board — create it the moment work starts/i);
    expect(section).toMatch(/update immediately after each step/i);
    expect(section).toMatch(/Never mark an item done before its tests pass/i);
    // 「收尾时对照看板总结」这条属于长任务纪律，不在工具段。
    expect(p.slice(p.indexOf("# Long tasks"))).toMatch(/summary mapped to the board/i);
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
    // 2026-11-06 通用化弧：编码流水线从 Task discipline 挪进 Code changes
    // （能力节，挂载编码工具才出现）。这里改为验证两件事：Task discipline 不
    // 再携带它，而 Code changes 携带。
    expect(TASK_DISCIPLINE_SECTION).not.toContain("explore (glob/grep/read_file)");
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
  const p = withTools();
  const longTasks = p.slice(p.indexOf("# Long tasks"), p.indexOf("# Behavioral contracts"));
  const toolUsage = p.slice(p.indexOf("# Tool usage"), p.indexOf("# Task discipline"));

  it("① acceptance contract first: write the acceptance standard in the task's own words before starting, self-check per block", () => {
    // 2026-11-07：该 bullet 统一为英文（用户定调：提示词统一英文）。
    expect(longTasks).toContain("acceptance criteria in the user's own words");
    expect(longTasks).toContain("never invent substitute metrics");
    expect(longTasks).toContain("as each block lands");
    // it rides the long-task board protocol (after the todo_write bullet —
    // start-of-work guidance)
    expect(longTasks.indexOf("acceptance criteria")).toBeGreaterThan(longTasks.indexOf("todo_write"));
  });

  it("③ polling anti-pattern: long waits go to a background watch with event wake, never sleep+re-check loops", () => {
    // 现在挂在 shell 工具的 guidelines 下面（工具自述的一部分）：
    const lines = toolUsage.split("\n");
    const at = lines.findIndex((l) => l.startsWith("- shell:"));
    expect(at).toBeGreaterThanOrEqual(0);
    // 该工具的指南紧跟其后（缩进两格的嵌套 bullet），到下一个工具行为止。
    const guidelineBlock = lines.slice(at + 1).findIndex((l) => l.startsWith("- "));
    const own = lines.slice(at, guidelineBlock === -1 ? undefined : at + 1 + guidelineBlock).join("\n");
    expect(own).toMatch(/monitor_start/);
    expect(own).toMatch(/monitor_read/);
    expect(own).toMatch(/looping sleep \+ re-check/i);
    expect(own).toMatch(/each wait costs a full model turn/i);
  });

  it("generic copy only — zero benchmark names in the new paragraphs (grep gate)", () => {
    const newCopy = longTasks + toolUsage;
    expect(newCopy).not.toMatch(/terminal[- ]?bench|swe[- ]?bench|humaneval|mlbench|\btb\b/i);
  });
});

// 长程弧（2026-11-05）：三处对比 CC/pi/dsh 后补上的缺失。这些钉子防的是
// 「某次 refactor 悄悄把一节删了」——prompt 是行为契约，静默丢失最贵。
describe("long-run sections (2026-11-05)", () => {
  it("ACTIONS_SECTION covers the irreversible/shared-state classes", () => {
    expect(ACTIONS_SECTION).toContain("hard to reverse");
    expect(ACTIONS_SECTION).toMatch(/deleting files or branches/i);
    expect(ACTIONS_SECTION).toMatch(/force-pushing, git reset --hard/i);
    expect(ACTIONS_SECTION).toMatch(/uploading content to third-party tools/i);
    // The standing-authorization rule — approval once is not approval always.
    expect(ACTIONS_SECTION).toMatch(/one-time approval is not a standing one/i);
    // Destructive shortcuts are explicitly banned as a way out of an obstacle.
    expect(ACTIONS_SECTION).toMatch(/never reach for a destructive action/i);
  });

  it("ACTIONS_SECTION lands AFTER behavioral contracts, BEFORE environment", () => {
    const p = buildSystemPrompt("/tmp/ws");
    expect(p.indexOf("# Behavioral contracts")).toBeLessThan(p.indexOf("# Executing actions with care"));
    expect(p.indexOf("# Executing actions with care")).toBeLessThan(p.indexOf("# Environment"));
  });

  it("OUTPUT_CHANNEL_SECTION tells the model only text reaches the user", () => {
    expect(OUTPUT_CHANNEL_SECTION).toContain("ONLY channel to the user");
    expect(OUTPUT_CHANNEL_SECTION).toMatch(/collapsed or hidden/);
    expect(OUTPUT_CHANNEL_SECTION).toContain("file_path:line_number");
  });

  it("failure escalation lives in behavioral contracts (diagnose before switching)", () => {
    expect(BEHAVIORAL_CONTRACTS_SECTION).toMatch(/When an approach fails: diagnose WHY/i);
    expect(BEHAVIORAL_CONTRACTS_SECTION).toMatch(/Do not retry the identical action blindly/i);
    expect(BEHAVIORAL_CONTRACTS_SECTION).toMatch(/do not abandon a workable approach/i);
  });

  it("the new sections are static (no per-run bytes — prefix cache stays warm)", () => {
    expect(buildSystemPrompt("/tmp/ws")).toBe(buildSystemPrompt("/tmp/ws"));
    expect(ACTIONS_SECTION).not.toMatch(/\$\{/);
    expect(OUTPUT_CHANNEL_SECTION).not.toMatch(/\$\{/);
  });
});

// 长程弧 §1 — Tool usage 节改由工具自述渲染（工具增删 → 提示词自动跟随）。
describe("tool self-description drives the Tool usage section", () => {
  const fake = (name: string, snippet: string, guidelines: readonly string[] = []) => ({
    name,
    description: `${name} desc`,
    parameters: { type: "object" as const, properties: {}, additionalProperties: false },
    execute: async () => ({ content: "ok" }),
    promptSnippet: snippet,
    ...(guidelines.length > 0 ? { promptGuidelines: guidelines } : {}),
  });

  it("renders the mounted tool set instead of the hardcoded list", () => {
    const p = buildSystemPrompt("/tmp/ws", false, [], false, false, [fake("zebra_tool", "does zebra things")]);
    expect(p).toContain("# Tool usage");
    expect(p).toContain("- zebra_tool: does zebra things");
    // The old hardcoded bullets must NOT also appear (a tool would be
    // described twice — the failure mode this change exists to avoid).
    expect(p).not.toContain("- read_file: read a file before editing it");
  });

  it("renders guidelines as nested bullets", () => {
    const p = buildSystemPrompt("/tmp/ws", false, [], false, false, [fake("t", "s", ["rule one"])]);
    expect(p).toContain("  - rule one");
  });

  it("keeps the section sorted by tool name regardless of array order", () => {
    const p = buildSystemPrompt("/tmp/ws", false, [], false, false, [
      fake("bravo", "b"), fake("alpha", "a"),
    ]);
    expect(p.indexOf("- alpha:")).toBeLessThan(p.indexOf("- bravo:"));
  });

  it("no tool set → no tool section at all (the hardcoded fallback is gone)", () => {
    const withoutTools = buildSystemPrompt("/tmp/ws");
    expect(withoutTools).not.toContain("# Tool usage");
    // and the assembly does not leave a hole where the section used to sit
    expect(withoutTools).not.toContain("\n\n\n");
  });

  it("a tool set that declares nothing → no tool section (never a stale hardcoded list)", () => {
    const silent = { ...fake("mcp__x", ""), promptSnippet: undefined };
    const p = buildSystemPrompt("/tmp/ws", false, [], false, false, [silent]);
    expect(p).not.toContain("# Tool usage");
  });

  it("stays deterministic across identical calls (prefix cache)", () => {
    const tools = [fake("b", "sb"), fake("a", "sa")];
    expect(buildSystemPrompt("/tmp/ws", false, [], false, false, tools))
      .toBe(buildSystemPrompt("/tmp/ws", false, [], false, false, tools));
  });
});
