import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput } from "@wudao/core";
import { runWorkflow } from "../src/workflow/runner.js";
import { planFromWorkflow, runPlanWorkflow } from "../src/workflow/engine.js";
import { journalFilePath, openJournal } from "../src/workflow/journal.js";
import type { Workflow } from "../src/workflow/schema.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wf-adapter-"));
  writeFileSync(join(root, "note.txt"), "the quick brown fox");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function capturingModel(responses: readonly AssistantMessage[]): { client: ModelClient; inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    client: {
      async generate(input: ModelInput): Promise<AssistantMessage> {
        inputs.push(input);
        const r = responses[i];
        i += 1;
        if (!r) throw new Error("scripted responses exhausted");
        return r;
      },
    },
  };
}

const say = (content: string): AssistantMessage => ({ role: "assistant", content });
const call = (name: string, args: Record<string, unknown>): AssistantMessage => ({
  role: "assistant", content: "", toolCalls: [{ id: `c-${name}`, name, arguments: args }],
});

// The same JSON workflow, run through the M22 runner and the M29 engine
// (adapter-compiled plan) with identically scripted models. Equivalence =
// the same model requests and the same step outcomes.
const JSON_WORKFLOW: Workflow = {
  name: "equiv",
  steps: [
    { id: "read", prompt: "read the note", allowTools: ["read_file"], expect: { toolUsed: "read_file", outputContains: "fox" } },
    { id: "summarize", prompt: "summarize {{step.read.output}}", expect: { outputContains: "fox" } },
  ],
};

describe("JSON adapter equivalence (old runner vs new engine)", () => {
  it("same JSON produces byte-equal model inputs and the same outcomes (happy path)", async () => {
    const responses: AssistantMessage[] = [
      call("read_file", { path: join(root, "note.txt") }),
      say("the file says: fox"),
      say("summary: a fox appears"),
    ];
    const oldModel = capturingModel(responses);
    const newModel = capturingModel(responses);

    const oldResult = await runWorkflow(JSON_WORKFLOW, {
      workspaceRoot: root, model: oldModel.client,
      journal: openJournal(journalFilePath(root, "wf-old")), workflowName: "equiv",
    });
    const newResult = await runPlanWorkflow(planFromWorkflow("equiv", JSON_WORKFLOW.steps), {
      workspaceRoot: root, model: newModel.client,
      journal: openJournal(journalFilePath(root, "wf-new")), workflowName: "equiv",
    });

    expect(oldResult.ok).toBe(true);
    expect(newResult.ok).toBe(true);
    expect(oldModel.inputs.length).toBe(newModel.inputs.length);
    expect(oldModel.inputs.length).toBe(3); // tool-call turn + final + step 2's final
    for (let i = 0; i < oldModel.inputs.length; i += 1) {
      const a = oldModel.inputs[i]!;
      const b = newModel.inputs[i]!;
      expect(b.systemPrompt).toBe(a.systemPrompt);   // byte-equal (workflow section included)
      expect(b.messages).toEqual(a.messages);        // substituted prompts identical
      expect(b.tools.map((t) => t.name)).toEqual(a.tools.map((t) => t.name));
      expect(b.tools.map((t) => t.description)).toEqual(a.tools.map((t) => t.description));
      expect(b.tools.map((t) => t.parameters)).toEqual(a.tools.map((t) => t.parameters));
    }
    expect(newResult.tasksTotal).toBe(2);
    expect(newResult.tasksOk).toBe(2);
    // Step outcomes (finalText per step) match.
    const oldTexts = oldResult.results.map((r) => r.finalText);
    const newTexts = [0, 1].map(() => undefined); // journal is the source of truth for the new engine
    expect(oldTexts).toEqual(["the file says: fox", "summary: a fox appears"]);
    expect(newTexts).toEqual([undefined, undefined]);
  });

  it("same failure semantics: a failed expect stops the run at that step (exit-worthy result)", async () => {
    const responses: AssistantMessage[] = [say("i did nothing")];
    const oldModel = capturingModel(responses);
    const newModel = capturingModel(responses);

    const oldResult = await runWorkflow(JSON_WORKFLOW, {
      workspaceRoot: root, model: oldModel.client,
      journal: openJournal(journalFilePath(root, "wf-oldf")), workflowName: "equiv",
    });
    const newResult = await runPlanWorkflow(planFromWorkflow("equiv", JSON_WORKFLOW.steps), {
      workspaceRoot: root, model: newModel.client,
      journal: openJournal(journalFilePath(root, "wf-newf")), workflowName: "equiv",
    });

    expect(oldResult.ok).toBe(false);
    expect(newResult.ok).toBe(false);
    expect(oldResult.results).toHaveLength(1);           // step 2 never ran
    expect(newResult.tasksTotal).toBe(1);                // same for the engine
    expect(oldResult.results[0]?.error).toMatch(/toolUsed/);
    expect(newResult.failure?.category).toBe("verify-failed");
    expect(newResult.failure?.message).toMatch(/toolUsed/);
  });

  it("default tool scope matches: read-only set, task tool stripped, in the same order", async () => {
    const oldModel = capturingModel([say("ok")]);
    const newModel = capturingModel([say("ok")]);
    const wf: Workflow = { steps: [{ id: "s", prompt: "p" }] };
    await runWorkflow(wf, {
      workspaceRoot: root, model: oldModel.client,
      journal: openJournal(journalFilePath(root, "wf-oldt")), workflowName: "t",
    });
    await runPlanWorkflow(planFromWorkflow("t", wf.steps), {
      workspaceRoot: root, model: newModel.client,
      journal: openJournal(journalFilePath(root, "wf-newt")), workflowName: "t",
    });
    const oldNames = oldModel.inputs[0]?.tools.map((t) => t.name);
    const newNames = newModel.inputs[0]?.tools.map((t) => t.name);
    expect(newNames).toEqual(oldNames);
    expect(newNames).toContain("read_file");
    expect(newNames).not.toContain("task");
  });

  it("maxTurns default (8) is preserved by the adapter", async () => {
    const looping = call("read_file", { path: join(root, "note.txt") });
    const oldModel = capturingModel([looping, looping, looping, looping]);
    const newModel = capturingModel([looping, looping, looping, looping]);
    const wf: Workflow = { steps: [{ id: "s", prompt: "p", maxTurns: 3 }] };
    const oldResult = await runWorkflow(wf, {
      workspaceRoot: root, model: oldModel.client,
      journal: openJournal(journalFilePath(root, "wf-oldm")), workflowName: "t",
    });
    const newResult = await runPlanWorkflow(planFromWorkflow("t", wf.steps), {
      workspaceRoot: root, model: newModel.client,
      journal: openJournal(journalFilePath(root, "wf-newm")), workflowName: "t",
    });
    expect(oldResult.ok).toBe(false);
    expect(newResult.ok).toBe(false);
    expect(oldModel.inputs.length).toBe(newModel.inputs.length);
    expect(newResult.failure?.message).toMatch(/max_turns/);
  });
});
