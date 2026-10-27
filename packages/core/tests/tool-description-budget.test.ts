// M53 §5 — the tool-description audit's token budget: the six audited core
// tools (read_file/edit/run_script/glob/grep/task) carry examples + negative
// boundaries, but the TOTAL description budget stays sane (every byte rides
// every request's tool array — prefix-cache payload).
import { describe, expect, it } from "vitest";
import { createReadFileTool } from "../src/tools/read-file.js";
import { createEditTool } from "../src/tools/edit.js";
import { createRunScriptTool } from "../src/tools/run-script.js";
import { createGlobTool } from "../src/tools/glob.js";
import { createGrepTool } from "../src/tools/grep.js";
import { createTaskTool } from "../src/tools/task.js";

/** The audit's ceiling: the six descriptions together must stay under this
 *  (they were ~2.0k before M53 §5; examples + negative boundaries may add at
 *  most ~1.2k total). ω99-30 (F): +120 for glob's one-sentence dot-dir
 *  semantics note (the sanctioned release-time append — pattern-as-intent
 *  must be legible to the model, and a hidden reachability rule it cannot
 *  read is a trap it cannot avoid). */
const TOTAL_DESCRIPTION_BUDGET_CHARS = 4_320;

describe("tool description audit budget (M53 §5)", () => {
  const tools = [
    createReadFileTool({ workspaceRoot: "/ws" }),
    createEditTool({ workspaceRoot: "/ws" }),
    createRunScriptTool({ workspaceRoot: "/ws" }),
    createGlobTool({ workspaceRoot: "/ws" }),
    createGrepTool({ workspaceRoot: "/ws" }),
    createTaskTool({ registry: { status: () => [], spawn: (() => { throw new Error("unused"); }) as never, abortAll: () => {}, awaitAgents: (() => Promise.resolve([])) as never } as never }),
  ];
  const byName = new Map(tools.map((t) => [t.name, t.description]));

  it("each audited tool has an Example and a negative boundary (Do NOT)", () => {
    for (const name of ["read_file", "edit", "run_script", "glob", "grep", "task"]) {
      const d = byName.get(name) ?? "";
      expect(d.length, `${name} description exists`).toBeGreaterThan(0);
      expect(d, `${name} carries a real example`).toContain("Example:");
      expect(d, `${name} names its negative boundary`).toContain("Do NOT");
    }
  });

  it("the six descriptions together stay inside the budget", () => {
    const total = [...byName.values()].reduce((n, d) => n + d.length, 0);
    expect(total).toBeLessThanOrEqual(TOTAL_DESCRIPTION_BUDGET_CHARS);
  });
});
