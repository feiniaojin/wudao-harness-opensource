import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput } from "@wudao/core";
import { parseWorkflowArgs, workflowMain } from "../src/workflow/cli.js";
import { journalFilePath, loadJournal } from "../src/workflow/journal.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wf-cli29-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const ENV = { WUDAO_API_KEY: "sk-test", WUDAO_BASE_URL: "https://example.test", WUDAO_MODEL: "test-model" };

// A model factory whose responses ALSO report usage through the M24 channel
// (the only way tokens flow out of a call) so budget tests can exhaust.
function usageModelFactory(responses: AssistantMessage[], usage = { promptTokens: 50, completionTokens: 10 }) {
  const inputs: ModelInput[] = [];
  const factory = (): ModelClient => ({
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push(input);
      const r = responses[inputs.length - 1];
      if (!r) throw new Error("exhausted");
      input.onUsage?.({ promptTokens: usage.promptTokens, cacheHitTokens: 0, cacheMissTokens: usage.promptTokens, completionTokens: usage.completionTokens });
      return r;
    },
  });
  return { inputs, factory };
}

const say = (content: string): AssistantMessage => ({ role: "assistant", content });

describe("parseWorkflowArgs (M29)", () => {
  it("dispatches run with .js/.json and parses --budget-tokens", () => {
    expect(parseWorkflowArgs(["run", "wf.js"])).toEqual({ kind: "run", file: "wf.js" });
    expect(parseWorkflowArgs(["run", "wf.json", "--budget-tokens", "1000"])).toEqual({ kind: "run", file: "wf.json", budgetTokens: 1000 });
    expect(parseWorkflowArgs(["run", "wf.js", "--resume", "wf-1", "--budget-tokens", "5", "--auto"]))
      .toEqual({ kind: "run", file: "wf.js", resumeId: "wf-1", budgetTokens: 5 });
  });
  it("dispatches list and status", () => {
    expect(parseWorkflowArgs(["list"])).toEqual({ kind: "list" });
    expect(parseWorkflowArgs(["status", "wf-1"])).toEqual({ kind: "status", runId: "wf-1" });
    expect(parseWorkflowArgs(["status"]).kind).toBe("usage");
    expect(parseWorkflowArgs(["list", "extra"]).kind).toBe("usage");
  });
  it("rejects a bad --budget-tokens value", () => {
    expect(parseWorkflowArgs(["run", "f.js", "--budget-tokens", "abc"]).kind).toBe("usage");
    expect(parseWorkflowArgs(["run", "f.js", "--budget-tokens"]).kind).toBe("usage");
    expect(parseWorkflowArgs(["run", "f.js", "--budget-tokens", "0"]).kind).toBe("usage");
  });
  it("parses --args as JSON onto the run", () => {
    expect(parseWorkflowArgs(["run", "f.js", "--args", '{"x":1}'])).toEqual({ kind: "run", file: "f.js", args: { x: 1 } });
    expect(parseWorkflowArgs(["run", "f.js", "--args", "[1,2]", "--auto"])).toEqual({ kind: "run", file: "f.js", args: [1, 2] });
    expect(parseWorkflowArgs(["run", "f.js", "--args", "null"])).toEqual({ kind: "run", file: "f.js", args: null });
  });
  it("rejects junk or missing --args values with a pointed error", () => {
    expect(parseWorkflowArgs(["run", "f.js", "--args", "not json"])).toMatchObject({
      kind: "usage", error: expect.stringContaining("--args requires valid JSON"),
    });
    expect(parseWorkflowArgs(["run", "f.js", "--args", '{"x":1']).kind).toBe("usage");
    expect(parseWorkflowArgs(["run", "f.js", "--args"]).kind).toBe("usage");
  });
  it("rejects non .js/.json files at parse level only for unknown flags (extension is checked in main)", () => {
    expect(parseWorkflowArgs(["run", "wf.yaml"])).toEqual({ kind: "run", file: "wf.yaml" });
  });
});

describe("workflowMain — .js script engine", () => {
  it("runs a .js workflow end-to-end: per-task lines, summary, journal, state.json", async () => {
    writeFileSync(join(root, "note.txt"), "x");
    const { factory } = usageModelFactory([say("ONE"), say("TWO")]);
    const file = join(root, "flow.js");
    writeFileSync(file, "const a = await task('first thing');\nconst b = await task('second ' + a.text);\nreturn [a.text, b.text];\n");
    const lines: string[] = [];
    const code = await workflowMain(["run", file, "--auto"], { cwd: root, env: ENV, out: (s) => lines.push(s), buildModel: factory });
    expect(code).toBe(0);
    const joined = lines.join("");
    expect(joined).toContain("script engine");
    expect(joined).toContain("▶ task-1");   // default labels task-<n>
    expect(joined).toContain("✅");
    expect(joined).toMatch(/2\/2/);
    const runId = readdirSync(join(root, ".wudao", "workflows"))[0]!.replace(/\.state\.json$/, "").replace(/\.jsonl$/, "");
    const journal = loadJournal(journalFilePath(root, runId));
    expect(journal.tasks.map((t) => t.text)).toEqual(["ONE", "TWO"]);
  });

  it("a .js label rides the task line (label option)", async () => {
    const { factory } = usageModelFactory([say("ok")]);
    const file = join(root, "labeled.js");
    writeFileSync(file, "await task('p', { label: 'my-label' });\nreturn 1;\n");
    const lines: string[] = [];
    await workflowMain(["run", file, "--auto"], { cwd: root, env: ENV, out: (s) => lines.push(s), buildModel: factory });
    expect(lines.join("")).toContain("▶ my-label");
  });

  it("a sandbox violation fails the run with a pointed error (exit 1)", async () => {
    const { factory } = usageModelFactory([]);
    const file = join(root, "bad.js");
    writeFileSync(file, "const t = Date.now();\nreturn t;\n");
    const lines: string[] = [];
    const code = await workflowMain(["run", file, "--auto"], { cwd: root, env: ENV, out: (s) => lines.push(s), buildModel: factory });
    expect(code).toBe(1);
    expect(lines.join("")).toMatch(/determinism sandbox/);
  });

  it("--args <json> reaches the script's args global (passthrough into the engine)", async () => {
    const { factory } = usageModelFactory([say("ok")]);
    const file = join(root, "args.js");
    writeFileSync(file, "if (args?.word !== 'hello') { throw new Error('args did not reach the script'); }\nawait task('ping ' + args.word);\nreturn 1;\n");
    const lines: string[] = [];
    const code = await workflowMain(["run", file, "--auto", "--args", '{"word":"hello"}'], {
      cwd: root, env: ENV, out: (s) => lines.push(s), buildModel: factory,
    });
    expect(code).toBe(0);
    expect(lines.join("")).toContain("✅");
  });

  it("--args on a .json workflow is a usage error (M22 JSON takes no runtime args)", async () => {
    writeFileSync(join(root, "wf.json"), JSON.stringify({ name: "j", steps: [{ id: "s", prompt: "p" }] }));
    const lines: string[] = [];
    const code = await workflowMain(["run", join(root, "wf.json"), "--args", "{}"], {
      cwd: root, env: ENV, out: (s) => lines.push(s), buildModel: () => { throw new Error("no model expected"); },
    });
    expect(code).toBe(2);
    expect(lines.join("")).toContain("--args");
  });

  it("--args junk fails at the CLI boundary with the usage text (exit 2)", async () => {
    const lines: string[] = [];
    const code = await workflowMain(["run", join(root, "nope.js"), "--args", "{oops}"], {
      cwd: root, env: ENV, out: (s) => lines.push(s), buildModel: () => { throw new Error("unused"); },
    });
    expect(code).toBe(2);
    expect(lines.join("")).toContain("--args requires valid JSON");
  });

  it("a non .js/.json extension exits 2", async () => {
    const file = join(root, "wf.yaml");
    writeFileSync(file, "steps: []");
    const code = await workflowMain(["run", file], { cwd: root, env: ENV, out: () => {}, buildModel: () => { throw new Error("unused"); } });
    expect(code).toBe(2);
  });

  it("--budget-tokens exhausts → exit 1 with the budget-exhausted category", async () => {
    const { factory } = usageModelFactory([say("a"), say("b"), say("c")]);
    const file = join(root, "loop.js");
    writeFileSync(file, "for (let i = 0; i < 3; i++) { await task('t' + i); }\nreturn 1;\n");
    const lines: string[] = [];
    const code = await workflowMain(["run", file, "--auto", "--budget-tokens", "100"], {
      cwd: root, env: ENV, out: (s) => lines.push(s), buildModel: factory,
    });
    expect(code).toBe(1);
    expect(lines.join("")).toMatch(/budget-exhausted/);
    // state.json records the failure for `workflow status`
    const stateFile = readdirSync(join(root, ".wudao", "workflows")).find((f) => f.endsWith(".state.json"))!;
    const state = JSON.parse(readFileSync(join(root, ".wudao", "workflows", stateFile), "utf8"));
    expect(state.status).toBe("failed");
    expect(state.failure.category).toBe("budget-exhausted");
  });

  it("--resume of a .js run replays matched tasks with zero model calls", async () => {
    const file = join(root, "flow.js");
    writeFileSync(file, "const a = await task('p1');\nreturn a.text;\n");
    const first = usageModelFactory([say("V1")]);
    await workflowMain(["run", file, "--auto"], { cwd: root, env: ENV, out: () => {}, buildModel: first.factory });
    const runId = readdirSync(join(root, ".wudao", "workflows"))[0]!.replace(/\.(jsonl|state\.json)$/, "");

    const second = usageModelFactory([]);
    const lines: string[] = [];
    const code = await workflowMain(["run", file, "--resume", runId, "--auto"], {
      cwd: root, env: ENV, out: (s) => lines.push(s), buildModel: second.factory,
    });
    expect(code).toBe(0);
    expect(second.inputs).toHaveLength(0); // zero model calls
    expect(lines.join("")).toMatch(/1 task\(s\) replayable/);
    expect(lines.join("")).toMatch(/↩️ replayed/);
  });
});

describe("workflowMain — .json stays compatible (M22 adapter path)", () => {
  it("runs .json through the adapter: same UX as M22 (step lines, 2/2, resume)", async () => {
    const file = join(root, "wf.json");
    writeFileSync(file, JSON.stringify({
      name: "compat",
      steps: [
        { id: "one", prompt: "p1" },
        { id: "two", prompt: "p2 {{step.one.output}}" },
      ],
    }));
    const { factory } = usageModelFactory([say("S1"), say("S2")]);
    const lines: string[] = [];
    const code = await workflowMain(["run", file, "--auto"], { cwd: root, env: ENV, out: (s) => lines.push(s), buildModel: factory });
    expect(code).toBe(0);
    const joined = lines.join("");
    expect(joined).toContain("M22 adapter");
    expect(joined).toContain("▶ one");
    expect(joined).toContain("▶ two");
    expect(joined).toMatch(/2\/2/);
  });

  it("an .json expect failure exits 1 with ❌ + the verify-failed category", async () => {
    const file = join(root, "wf.json");
    writeFileSync(file, JSON.stringify({
      name: "fails",
      steps: [{ id: "s", prompt: "p", expect: { toolUsed: "read_file" } }],
    }));
    const { factory } = usageModelFactory([say("i skipped the tool")]);
    const lines: string[] = [];
    const code = await workflowMain(["run", file, "--auto"], { cwd: root, env: ENV, out: (s) => lines.push(s), buildModel: factory });
    expect(code).toBe(1);
    expect(lines.join("")).toMatch(/❌/);
    expect(lines.join("")).toMatch(/verify-failed/);
  });
});

describe("workflowMain — list / status", () => {
  it("list on an empty workspace prints a hint, exit 0", async () => {
    const lines: string[] = [];
    const code = await workflowMain(["list"], { cwd: root, env: {}, out: (s) => lines.push(s) });
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/no workflow runs yet/);
  });

  it("list after a run shows the runId + status; status shows the full record", async () => {
    const file = join(root, "wf.json");
    writeFileSync(file, JSON.stringify({ name: "listed", steps: [{ id: "a", prompt: "p" }] }));
    const { factory } = usageModelFactory([say("done")]);
    await workflowMain(["run", file, "--auto"], { cwd: root, env: ENV, out: () => {}, buildModel: factory });
    const runId = readdirSync(join(root, ".wudao", "workflows")).find((f) => f.endsWith(".state.json"))!.replace(/\.state\.json$/, "");

    const listLines: string[] = [];
    expect(await workflowMain(["list"], { cwd: root, env: {}, out: (s) => listLines.push(s) })).toBe(0);
    const listed = listLines.join("");
    expect(listed).toContain(runId);
    expect(listed).toContain("completed");
    expect(listed).toContain("listed");

    const statusLines: string[] = [];
    expect(await workflowMain(["status", runId], { cwd: root, env: {}, out: (s) => statusLines.push(s) })).toBe(0);
    const status = statusLines.join("");
    expect(status).toContain("completed");
    expect(status).toContain("1/1");
    expect(status).toMatch(/prompt \+ \d+ completion/);

    const missing: string[] = [];
    expect(await workflowMain(["status", "wf-ghost"], { cwd: root, env: {}, out: (s) => missing.push(s) })).toBe(1);
    expect(missing.join("")).toMatch(/no terminal state/);
  });

  it("status of a failed run exits 1", async () => {
    const file = join(root, "wf.json");
    writeFileSync(file, JSON.stringify({ name: "f", steps: [{ id: "s", prompt: "p", expect: { toolUsed: "read_file" } }] }));
    const { factory } = usageModelFactory([say("no tool")]);
    await workflowMain(["run", file, "--auto"], { cwd: root, env: ENV, out: () => {}, buildModel: factory });
    const runId = readdirSync(join(root, ".wudao", "workflows")).find((f) => f.endsWith(".state.json"))!.replace(/\.state\.json$/, "");
    const lines: string[] = [];
    expect(await workflowMain(["status", runId], { cwd: root, env: {}, out: (s) => lines.push(s) })).toBe(1);
    expect(lines.join("")).toMatch(/verify-failed/);
  });
});
