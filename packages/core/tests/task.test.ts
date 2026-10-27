import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskTool } from "../src/tools/task.js";
import { createScriptedModel } from "../src/model-client.js";
import { createReadFileTool } from "../src/tools/read-file.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "ws-")); await writeFile(join(root, "f.txt"), "DATA"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("task tool", () => {
  it("spawns a subagent and returns its answer", async () => {
    const childModel = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: join(root, "f.txt") } }] },
      { role: "assistant", content: "Found: DATA" },
    ]);
    const tool = createTaskTool({ model: childModel, allTools: [createReadFileTool()], loopOptions: { maxTurns: 20 } });
    const res = await tool.execute({ description: "read file", prompt: "Read f.txt and report." });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("DATA");
  });

  it("uses general-purpose by default (read-only tools)", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "done" }]);
    const tool = createTaskTool({ model, allTools: [createReadFileTool()], loopOptions: { maxTurns: 20 } });
    const res = await tool.execute({ description: "test", prompt: "hi" });
    expect(res.content).toBe("done");
  });

  it("returns isError on subagent failure", async () => {
    const failingModel = { async generate() { throw new Error("boom"); } };
    const tool = createTaskTool({ model: failingModel as any, allTools: [], loopOptions: { maxTurns: 20 } });
    const res = await tool.execute({ description: "fail", prompt: "go" });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/subagent failed/);
  });
});
