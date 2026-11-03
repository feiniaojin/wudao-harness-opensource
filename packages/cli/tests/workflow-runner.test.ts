import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput } from "@wudao-org/core";
import { runWorkflow } from "../src/workflow/runner.js";
import type { Workflow } from "../src/workflow/schema.js";
import { openJournal, loadJournal, journalFilePath, newRunId } from "../src/workflow/journal.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wf-runner-"));
  writeFileSync(join(root, "note.txt"), "the quick brown fox");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// Scripted model that also CAPTURES every ModelInput (so tests can assert the
// tool set the model actually saw, and the substituted prompt text).
function capturingModel(responses: AssistantMessage[]): { client: ModelClient; inputs: ModelInput[] } {
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
  role: "assistant", content: "", toolCalls: [{ id: `c-${name}-${Math.random()}`, name, arguments: args }],
});

describe("runWorkflow", () => {
  it("runs a 2-step workflow, substituting {{step.<id>.output}} with step1's finalText", async () => {
    const { client, inputs } = capturingModel([
      say("ALPHA-RESULT"),
      say("BETA-DONE"),
    ]);
    const workflow: Workflow = {
      steps: [
        { id: "one", prompt: "produce alpha" },
        { id: "two", prompt: "summarize {{step.one.output}} please" },
      ],
    };
    const path = journalFilePath(root, newRunId());
    const result = await runWorkflow(workflow, {
      workspaceRoot: root,
      model: client,
      journal: openJournal(path),
      workflowName: "subst-test",
    });

    expect(result.ok).toBe(true);
    expect(result.results.map((r) => r.id)).toEqual(["one", "two"]);
    expect(result.results[0]?.finalText).toBe("ALPHA-RESULT");
    expect(result.results[1]?.finalText).toBe("BETA-DONE");

    // step2's user message contains step1's output verbatim
    const step2Messages = inputs[1]?.messages;
    const step2User = step2Messages?.find((m) => m.role === "user");
    expect((step2User as { content: string } | undefined)?.content).toContain("summarize ALPHA-RESULT please");
  });

  it("filters the tool set to the step whitelist and NEVER exposes the task tool", async () => {
    // The model tries to call grep — with allowTools ["read_file"] it must not
    // even see it. Assert via ModelInput.tools.
    const { client, inputs } = capturingModel([
      call("read_file", { path: join(root, "note.txt") }),
      say("done"),
    ]);
    const workflow: Workflow = {
      steps: [{ id: "s", prompt: "read the note", allowTools: ["read_file"], expect: { toolUsed: "read_file" } }],
    };
    const result = await runWorkflow(workflow, {
      workspaceRoot: root, model: client, journal: openJournal(journalFilePath(root, newRunId())), workflowName: "t",
    });
    expect(result.ok).toBe(true);
    const names = inputs[0]?.tools.map((t) => t.name);
    expect(names).toEqual(["read_file"]);
    expect(names).not.toContain("task");
  });

  it("defaults to the read-only tool set (read_file/glob/grep, no task, no writes)", async () => {
    const { client, inputs } = capturingModel([say("ok")]);
    const workflow: Workflow = { steps: [{ id: "s", prompt: "p" }] };
    await runWorkflow(workflow, {
      workspaceRoot: root, model: client, journal: openJournal(journalFilePath(root, newRunId())), workflowName: "t",
    });
    expect(inputs[0]?.tools.map((t) => t.name).sort()).toEqual(["glob", "grep", "read_file"]);
  });

  it("even an explicit allowTools entry of 'task' is stripped (deterministic scope)", async () => {
    const { client, inputs } = capturingModel([say("ok")]);
    const workflow: Workflow = { steps: [{ id: "s", prompt: "p", allowTools: ["read_file", "task"] }] };
    await runWorkflow(workflow, {
      workspaceRoot: root, model: client, journal: openJournal(journalFilePath(root, newRunId())), workflowName: "t",
    });
    expect(inputs[0]?.tools.map((t) => t.name)).toEqual(["read_file"]);
  });

  it("step system prompt = buildSystemPrompt(root) + trailing workflow section naming allowed tools", async () => {
    const { client, inputs } = capturingModel([say("ok")]);
    const workflow: Workflow = { steps: [{ id: "s", prompt: "p", allowTools: ["grep"] }] };
    await runWorkflow(workflow, {
      workspaceRoot: root, model: client, journal: openJournal(journalFilePath(root, newRunId())), workflowName: "named-flow",
    });
    const sys = inputs[0]?.systemPrompt ?? "";
    expect(sys).toContain(`Working directory: ${root}`); // from buildSystemPrompt
    expect(sys.indexOf("Working directory")).toBeLessThan(sys.indexOf("Workflow")); // appended at the END (prefix-cache stable)
    expect(sys).toContain("grep");
    expect(sys).toContain("s");
  });

  it("expect.toolUsed passes when the tool appears in toolsUsed", async () => {
    const { client } = capturingModel([
      call("read_file", { path: join(root, "note.txt") }),
      say("the file says: fox"),
    ]);
    const workflow: Workflow = {
      steps: [{ id: "s", prompt: "p", expect: { toolUsed: "read_file", outputContains: "fox" } }],
    };
    const result = await runWorkflow(workflow, {
      workspaceRoot: root, model: client, journal: openJournal(journalFilePath(root, newRunId())), workflowName: "t",
    });
    expect(result.ok).toBe(true);
    expect(result.results[0]?.toolsUsed).toEqual(["read_file"]);
  });

  it("expect.toolUsed FAILS when the tool was never used → journal ok:false, run stops, later steps skipped", async () => {
    const { client } = capturingModel([say("i did nothing")]);
    const workflow: Workflow = {
      steps: [
        { id: "a", prompt: "p", expect: { toolUsed: "read_file" } },
        { id: "b", prompt: "never runs" },
      ],
    };
    const path = journalFilePath(root, newRunId());
    const result = await runWorkflow(workflow, {
      workspaceRoot: root, model: client, journal: openJournal(path), workflowName: "t",
    });
    expect(result.ok).toBe(false);
    expect(result.results).toHaveLength(1); // b never ran
    expect(result.results[0]?.error).toMatch(/toolUsed/);

    const journal = loadJournal(path);
    const finished = journal.records.filter((r) => r.type === "step-finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ id: "a", ok: false });
    expect(journal.records.at(-1)).toMatchObject({ type: "run-finished", ok: false });
  });

  it("expect.outputContains FAILS on a non-substring → ok:false + exit-worthy result", async () => {
    const { client } = capturingModel([say("totally different")]);
    const workflow: Workflow = { steps: [{ id: "s", prompt: "p", expect: { outputContains: "MARKER" } }] };
    const result = await runWorkflow(workflow, {
      workspaceRoot: root, model: client, journal: openJournal(journalFilePath(root, newRunId())), workflowName: "t",
    });
    expect(result.ok).toBe(false);
    expect(result.results[0]?.error).toMatch(/outputContains/);
  });

  it("journal records toolsUsed as ORDERED UNIQUE tool names", async () => {
    // two read_file calls in one assistant message → toolsUsed = ["read_file"]
    const dual: AssistantMessage = {
      role: "assistant", content: "",
      toolCalls: [
        { id: "c1", name: "read_file", arguments: { path: join(root, "note.txt") } },
        { id: "c2", name: "read_file", arguments: { path: join(root, "note.txt") } },
      ],
    };
    const { client } = capturingModel([dual, say("done")]);
    const workflow: Workflow = { steps: [{ id: "s", prompt: "p" }] };
    const result = await runWorkflow(workflow, {
      workspaceRoot: root, model: client, journal: openJournal(journalFilePath(root, newRunId())), workflowName: "t",
    });
    expect(result.results[0]?.toolsUsed).toEqual(["read_file"]); // deduped, in call order
  });

  it("RESUME: steps with step-finished ok in the journal are skipped (model called once only)", async () => {
    // First run: step one ok, step two fails → journal has one finished-ok.
    const first = capturingModel([say("ONE"), say("bad")]);
    const workflow: Workflow = {
      name: "resumable",
      steps: [
        { id: "one", prompt: "p1" },
        { id: "two", prompt: "p2 {{step.one.output}}", expect: { outputContains: "MARKER" } },
      ],
    };
    const path = journalFilePath(root, newRunId());
    const r1 = await runWorkflow(workflow, {
      workspaceRoot: root, model: first.client, journal: openJournal(path), workflowName: "resumable",
    });
    expect(r1.ok).toBe(false);

    // Resume from the same journal: one is replayed from the journal (skipped),
    // two re-runs with the journal's step-one output substituted.
    const second = capturingModel([say("ok MARKER ok")]);
    const r2 = await runWorkflow(workflow, {
      workspaceRoot: root,
      model: second.client,
      journal: openJournal(path),
      workflowName: "resumable",
      resumeFrom: loadJournal(path).finishedOk,
    });
    expect(second.inputs).toHaveLength(1); // model called ONCE (step two only)
    const step2User = second.inputs[0]?.messages.find((m) => m.role === "user") as { content: string } | undefined;
    expect(step2User?.content).toContain("ONE");
    expect(r2.ok).toBe(true);
    expect(r2.results[0]).toMatchObject({ id: "one", ok: true, skipped: true, finalText: "ONE" });
    expect(r2.results[1]).toMatchObject({ id: "two", ok: true, skipped: false });
  });

  it("a max_turns step result fails the step (no finalText to satisfy expectations)", async () => {
    const looping = call("read_file", { path: join(root, "note.txt") });
    const { client } = capturingModel([looping, looping, looping, looping]);
    const workflow: Workflow = { steps: [{ id: "s", prompt: "p", maxTurns: 3 }] };
    const result = await runWorkflow(workflow, {
      workspaceRoot: root, model: client, journal: openJournal(journalFilePath(root, newRunId())), workflowName: "t",
    });
    expect(result.ok).toBe(false);
    expect(result.results[0]?.error).toMatch(/max_turns/);
  });
});
