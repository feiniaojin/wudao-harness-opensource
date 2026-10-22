import { describe, it, expect } from "vitest";
import { readFile, mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTodoTool, TODO_BOARD_PREFIX, parseTodoBoard } from "../src/tools/todo.js";
import { validateToolArguments } from "../src/tool.js";

async function exec(todos: unknown, planFilePath?: string) {
  const tool = createTodoTool(planFilePath ? { planFilePath } : {});
  return tool.execute({ todos } as Record<string, unknown>);
}

describe("todo_write result contract", () => {
  it("first line is exactly [todo board N/M done] with per-status item prefixes", async () => {
    const r = await exec([
      { content: "read workspace.ts", status: "done" },
      { content: "add pathExists helper", status: "done" },
      { content: "symlink walk tests", status: "in_progress" },
      { content: "dangling symlink deny test", status: "pending" },
    ]);
    expect(r.isError).toBeFalsy();
    const lines = r.content.split("\n");
    expect(lines[0]).toBe("[todo board 2/4 done]");
    expect(lines[1]).toBe("☑ read workspace.ts");
    expect(lines[2]).toBe("☑ add pathExists helper");
    expect(lines[3]).toBe("◐ symlink walk tests");
    expect(lines[4]).toBe("☐ dangling symlink deny test");
    expect(r.content.startsWith(TODO_BOARD_PREFIX)).toBe(true);
  });

  it("full-replacement is idempotent (same input → same board, same file state)", async () => {
    const todos = [{ content: "a", status: "done" }, { content: "b", status: "pending" }];
    const r1 = await exec(todos);
    const r2 = await exec(todos);
    expect(r2.content).toBe(r1.content);
  });

  it("empty board is legal (0/0)", async () => {
    const r = await exec([]);
    expect(r.content.split("\n")[0]).toBe("[todo board 0/0 done]");
  });
});

describe("todo_write validation (fail-closed)", () => {
  it("rejects two in_progress items", async () => {
    const r = await exec([
      { content: "a", status: "in_progress" },
      { content: "b", status: "in_progress" },
    ]);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/in_progress/);
  });

  it("rejects items over 50", async () => {
    const todos = Array.from({ length: 51 }, (_, i) => ({ content: `item ${i}`, status: "pending" as const }));
    const r = await exec(todos);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/50/);
  });

  it("rejects content over 200 chars", async () => {
    const r = await exec([{ content: "x".repeat(201), status: "pending" }]);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/200/);
  });

  it("rejects unknown status", async () => {
    const r = await exec([{ content: "a", status: "finished" }]);
    expect(r.isError).toBe(true);
  });

  it("rejects non-object items and missing content", async () => {
    expect((await exec(["nope"])).isError).toBe(true);
    expect((await exec([{ status: "pending" }])).isError).toBe(true);
  });

  it("rejects a non-array todos value at the schema layer", () => {
    const tool = createTodoTool({});
    const v = validateToolArguments(tool.parameters, { todos: "not an array" });
    expect(v.valid).toBe(false);
  });
});

describe("todo_write disk write (.wudao/plan.md)", () => {
  it("writes a human-readable plan with header and board body", async () => {
    const dir = await mkdtemp(join(tmpdir(), "todo-tool-"));
    const plan = join(dir, "plan.md");
    const r = await exec([{ content: "step one", status: "done" }, { content: "step two", status: "in_progress" }], plan);
    expect(r.isError).toBeFalsy();
    const text = await readFile(plan, "utf8");
    expect(text).toContain("# plan · updated ");
    expect(text).toContain("1/2 done");
    expect(text).toContain("☑ step one");
    expect(text).toContain("◐ step two");
  });

  it("defaults to <workspaceRoot>/.wudao/plan.md", async () => {
    const dir = await mkdtemp(join(tmpdir(), "todo-tool-"));
    const tool = createTodoTool({ workspaceRoot: dir });
    const r = await tool.execute({ todos: [{ content: "only step", status: "done" }] });
    expect(r.isError).toBeFalsy();
    const text = await readFile(join(dir, ".wudao", "plan.md"), "utf8");
    expect(text).toContain("1/1 done");
    expect(text).toContain("☑ only step");
  });

  it("records completion timestamps for done items", async () => {
    const dir = await mkdtemp(join(tmpdir(), "todo-tool-"));
    const plan = join(dir, "plan.md");
    await exec([{ content: "first", status: "pending" }], plan);
    await exec([{ content: "first", status: "done" }], plan);
    const text = await readFile(plan, "utf8");
    expect(text).toMatch(/☑ first · done /);
  });

  it("disk write failure degrades to a warning, never isError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "todo-tool-ro-"));
    if (process.platform === "win32") {
      // chmod 0o500 never denies the OWNER on win32 (DACL untouched) — block
      // the write by squatting the parent dir NAME with a file instead.
      await writeFile(join(dir, "sub"), "a file, not a dir");
    } else {
      // Target inside a read-only directory (mkdir of the parent fails with
      // EACCES on POSIX): the disk copy cannot be written.
      await chmod(dir, 0o500);
    }
    const plan = join(dir, "sub", "plan.md");
    try {
      const r = await exec([{ content: "a", status: "pending" }], plan);
      expect(r.isError).toBeFalsy();
      expect(r.content.startsWith("[todo board 0/1 done]")).toBe(true);
      // The context board is still first-class; the warning rides after it.
      expect(r.content).toMatch(/warning: plan\.md write failed/);
    } finally {
      if (process.platform !== "win32") await chmod(dir, 0o700);
    }
  });
});

describe("parseTodoBoard", () => {
  it("parses counts and item lines", () => {
    const p = parseTodoBoard("[todo board 2/4 done]\n☑ a\n☑ b\n◐ c\n☐ d");
    expect(p).toEqual({ done: 2, total: 4, incomplete: 2, lines: ["☑ a", "☑ b", "◐ c", "☐ d"] });
  });

  it("parses a restored board (first line carries the (restored) suffix)", () => {
    const p = parseTodoBoard("[todo board 3/7 done](restored)\n☑ x\n◐ y");
    expect(p?.done).toBe(3);
    expect(p?.total).toBe(7);
    expect(p?.incomplete).toBe(4);
  });

  it("returns undefined for non-board content", () => {
    expect(parseTodoBoard("wrote src/foo.ts")).toBeUndefined();
    expect(parseTodoBoard("[compacted summary] stuff")).toBeUndefined();
    expect(parseTodoBoard("[todo board garbage]")).toBeUndefined();
  });

  it("board prefixes are the single source of truth", () => {
    // The marker every consumer keys off — loop gates, compaction, TUI.
    expect(TODO_BOARD_PREFIX).toBe("[todo board");
  });
});

describe("todo_write risk annotations", () => {
  it("is not read-only and not concurrency-safe", () => {
    const tool = createTodoTool({});
    expect(tool.isReadOnly?.({})).toBe(false);
    expect(tool.isConcurrencySafe?.({})).toBe(false);
  });
});

describe("todo_write activeForm (M26 P4)", () => {
  it("an in_progress item renders its activeForm as the line text", async () => {
    const r = await exec([
      { content: "Add pagination to list endpoint", status: "in_progress", activeForm: "Adding pagination" },
      { content: "Write integration test", status: "pending" },
    ]);
    expect(r.isError).toBeFalsy();
    const lines = r.content.split("\n");
    expect(lines[1]).toBe("◐ Adding pagination");
    expect(lines[2]).toBe("☐ Write integration test");
  });

  it("falls back to content when activeForm is absent on the in_progress item", async () => {
    const r = await exec([{ content: "plain step", status: "in_progress" }]);
    expect(r.content.split("\n")[1]).toBe("◐ plain step");
  });

  it("activeForm on non-in_progress items is ignored, not an error", async () => {
    const r = await exec([
      { content: "finished step", status: "done", activeForm: "Finishing step" },
      { content: "later step", status: "pending", activeForm: "Doing later step" },
    ]);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("☑ finished step");
    expect(r.content).toContain("☐ later step");
    expect(r.content).not.toContain("Finishing");
    expect(r.content).not.toContain("Doing later");
  });

  it("activeForm must be a non-empty string when present (fail-closed)", async () => {
    expect((await exec([{ content: "a", status: "in_progress", activeForm: 5 }])).isError).toBe(true);
    expect((await exec([{ content: "a", status: "pending", activeForm: "" }])).isError).toBe(true);
  });

  it("activeForm shares content's 200-char cap", async () => {
    const r = await exec([{ content: "a", status: "in_progress", activeForm: "z".repeat(201) }]);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/200/);
  });

  it("the disk plan shows the activeForm for in_progress lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "todo-active-"));
    const plan = join(dir, "plan.md");
    await exec([{ content: "real content", status: "in_progress", activeForm: "Working on it" }], plan);
    const text = await readFile(plan, "utf8");
    expect(text).toContain("◐ Working on it");
  });

  it("parseTodoBoard stays compatible with activeForm lines (TUI/loop gates unchanged)", () => {
    const p = parseTodoBoard("[todo board 0/1 done]\n◐ Adding pagination");
    expect(p?.incomplete).toBe(1);
    expect(p?.lines).toEqual(["◐ Adding pagination"]);
  });

  it("description is the the upstream format-style contract: three examples + binding rules", () => {
    const tool = createTodoTool({});
    expect((tool.description.match(/<example>/g) ?? []).length).toBe(3);
    // The three use cases: create the board / advance it / skip with a reason.
    expect(tool.description).toMatch(/in_progress/);
    expect(tool.description).toMatch(/activeForm/);
    expect(tool.description).toMatch(/skip/i);
    // Tests-not-passed rule is part of the contract.
    expect(tool.description).toMatch(/tests/i);
  });
});