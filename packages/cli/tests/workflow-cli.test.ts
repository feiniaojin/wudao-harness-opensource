import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput } from "@wudao/core";
import { parseWorkflowArgs, workflowMain, workflowPermissionGate } from "../src/workflow/cli.js";
import { journalFilePath } from "../src/workflow/journal.js";
import { resetProviderRegistryCacheForTests } from "../src/provider-registry.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wf-cli-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const ENV = { WUDAO_API_KEY: "sk-test", WUDAO_BASE_URL: "https://example.test", WUDAO_MODEL: "test-model" };

function fakeModelFactory(responses: AssistantMessage[]) {
  const inputs: ModelInput[] = [];
  const client: ModelClient = {
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push(input);
      const r = responses[inputs.length - 1];
      if (!r) throw new Error("exhausted");
      return r;
    },
  };
  return { inputs, factory: () => client };
}

function boomFactory(): { factory: () => ModelClient } {
  return {
    factory: () => ({
      async generate(): Promise<AssistantMessage> {
        throw new Error("model must not be called on a fully-resumed run");
      },
    }),
  };
}

describe("parseWorkflowArgs", () => {
  it("dispatches 'run <file>'", () => {
    expect(parseWorkflowArgs(["run", "wf.json"])).toEqual({ kind: "run", file: "wf.json" });
  });
  it("accepts --resume <id> and mode flags", () => {
    expect(parseWorkflowArgs(["run", "wf.json", "--resume", "wf-1", "--auto"]))
      .toEqual({ kind: "run", file: "wf.json", resumeId: "wf-1" });
    expect(parseWorkflowArgs(["run", "wf.json", "--read-only"])).toEqual({ kind: "run", file: "wf.json" });
  });
  it("usage on: no subcommand, unknown subcommand, missing file, unknown flag, dangling --resume", () => {
    expect(parseWorkflowArgs([]).kind).toBe("usage");
    expect(parseWorkflowArgs(["dance"]).kind).toBe("usage");
    expect(parseWorkflowArgs(["run"]).kind).toBe("usage");
    expect(parseWorkflowArgs(["run", "f.json", "--bogus"]).kind).toBe("usage");
    expect(parseWorkflowArgs(["run", "f.json", "--resume"]).kind).toBe("usage");
  });
});

describe("workflowMain", () => {
  const say = (content: string): AssistantMessage => ({ role: "assistant", content });

  function wfFile(steps: unknown): string {
    const file = join(root, "wf.json");
    writeFileSync(file, JSON.stringify({ name: "cli-test", steps }));
    return file;
  }

  it("exit 2 + every validation error listed for an invalid workflow file", async () => {
    const file = join(root, "bad.json");
    writeFileSync(file, JSON.stringify({ steps: [{ id: "BAD", prompt: "" }, { id: "BAD", prompt: "x" }] }));
    const lines: string[] = [];
    const code = await workflowMain(["run", file], {
      cwd: root, env: ENV, out: (s) => lines.push(s), buildModel: () => { throw new Error("no model needed"); },
    });
    expect(code).toBe(2);
    const joined = lines.join("");
    expect(joined).toMatch(/BAD/);
    expect(joined).toMatch(/duplicate/);
  });

  it("exit 2 on a missing workflow file", async () => {
    const code = await workflowMain(["run", join(root, "nope.json")], {
      cwd: root, env: ENV, out: () => {}, buildModel: () => { throw new Error("unused"); },
    });
    expect(code).toBe(2);
  });

  it("exit 2 on usage", async () => {
    const code = await workflowMain([], { cwd: root, env: ENV, out: () => {}, buildModel: () => { throw new Error("unused"); } });
    expect(code).toBe(2);
  });

  it("exit 1 when no API key is configured", async () => {
    const code = await workflowMain(["run", wfFile([{ id: "a", prompt: "p" }])], {
      cwd: root, env: {}, out: () => {}, buildModel: () => { throw new Error("unused"); },
    });
    expect(code).toBe(1);
  });

  // 夜移 010 补丁：workflow 的无人值守权限门必须走 rich 管线——auto 模式下
  // 凭证物（4.65 层）在交互表面会 ask，在这里 deny 并指出预授权路径；普通
  // 路径决策保持字节等价（旧门 = 裸 decidePermission + ask→deny）。
  it("夜移 010: auto workflow run DENIES credential material with a pre-approval hint", async () => {
    const gate = workflowPermissionGate(["run", "wf.json", "--auto"]);
    const d = await gate("read_file", { path: "~/.ssh/id_rsa" });
    expect(d).toEqual({
      behavior: "deny",
      reason: expect.stringContaining("credential material"),
    });
    (d as { reason: string }).reason; // narrow for the content checks below
    expect((d as { reason: string }).reason).toContain("~/.ssh/id_rsa");
    expect((d as { reason: string }).reason).toContain("allow");
  });
  it("夜移 010: ordinary paths keep the old decisions in auto workflow runs", async () => {
    const gate = workflowPermissionGate(["run", "wf.json", "--auto"]);
    expect(await gate("read_file", { path: "src/a.ts" })).toEqual({ behavior: "allow" });
    expect(await gate("write_file", { path: "src/a.ts" })).toEqual({ behavior: "allow" });
  });
  it("夜移 010: default-mode workflow runs still fail-closed on ask tools (no credential needed)", async () => {
    const gate = workflowPermissionGate(["run", "wf.json"]);
    // default mode = workspace: edits are free and safe commands auto-allow
    // (4.7); an unsafe command asks → deny + the unattended hint
    expect(await gate("shell", { command: "curl https://x.test" })).toEqual({
      behavior: "deny",
      reason: "workflow runs cannot prompt; re-run with --auto to allow non-read tools",
    });
  });

  it("exit 0 on success: per-step lines + summary + journal written", async () => {
    const { factory } = fakeModelFactory([say("first done"), say("second done")]);
    const file = wfFile([
      { id: "one", prompt: "p1" },
      { id: "two", prompt: "p2" },
    ]);
    const lines: string[] = [];
    const code = await workflowMain(["run", file, "--auto"], {
      cwd: root, env: ENV, out: (s) => lines.push(s), buildModel: factory,
    });
    expect(code).toBe(0);
    const joined = lines.join("");
    expect(joined).toContain("▶ one");   // per-step line
    expect(joined).toContain("▶ two");
    expect(joined).toContain("✅");
    expect(joined).toMatch(/2\/2/);      // summary
    // journal exists and is complete
    const jdir = join(root, ".wudao", "workflows");
    const jfile = readdirSync(jdir)[0]!;
    const jtext = readFileSync(join(jdir, jfile), "utf8");
    expect(jtext).toContain('"run-finished"');
    expect(jtext).toContain('"ok":true');
  });

  it("exit 1 when an expectation fails; ❌ printed with the reason", async () => {
    const { factory } = fakeModelFactory([say("i skipped the tool")]);
    const file = wfFile([{ id: "s", prompt: "p", expect: { toolUsed: "read_file" } }]);
    const lines: string[] = [];
    const code = await workflowMain(["run", file, "--auto"], {
      cwd: root, env: ENV, out: (s) => lines.push(s), buildModel: factory,
    });
    expect(code).toBe(1);
    expect(lines.join("")).toMatch(/❌/);
  });

  it("exit 1 on --resume of an unknown runId", async () => {
    const code = await workflowMain(["run", wfFile([{ id: "a", prompt: "p" }]), "--resume", "wf-ghost"], {
      cwd: root, env: ENV, out: () => {}, buildModel: () => { throw new Error("unused"); },
    });
    expect(code).toBe(1);
  });

  it("--resume reuses the runId's journal: fully-finished workflow is skipped with NO model call, exit 0", async () => {
    // First run: both steps ok.
    const file = wfFile([
      { id: "one", prompt: "p1" },
      { id: "two", prompt: "p2" },
    ]);
    const first = fakeModelFactory([say("o"), say("t")]);
    const code1 = await workflowMain(["run", file, "--auto"], {
      cwd: root, env: ENV, out: () => {}, buildModel: first.factory,
    });
    expect(code1).toBe(0);
    const runId = readdirSync(join(root, ".wudao", "workflows"))[0]!.replace(/\.jsonl$/, "");

    // Resume: model must NOT be called; both steps replayed from the journal.
    const { factory } = boomFactory();
    const lines: string[] = [];
    const code2 = await workflowMain(["run", file, "--resume", runId, "--auto"], {
      cwd: root, env: ENV, out: (s) => lines.push(s), buildModel: factory,
    });
    expect(code2).toBe(0);
    expect(lines.join("")).toMatch(/2\/2/);
    // the journal was appended to (run-started/run-finished), never rewritten
    const jtext = readFileSync(journalFilePath(root, runId), "utf8").trim().split("\n");
    expect(jtext.length).toBeGreaterThan(6);
    expect(JSON.parse(jtext[0]!)).toMatchObject({ type: "run-started", runId });
  });
});

// R-W1 (T2 review adjudication c) — the workflow run path resolves providers
// through the registry's effective view (the same threading run.ts got in
// T2): WUDAO_PROVIDER=<registry-id> must boot the custom instead of the
// historical "unknown provider" fail-fast crash.
describe("workflow run resolves registry customs (R-W1)", () => {
  it("WUDAO_PROVIDER=<registry-id> builds the run on the custom's registry config", async () => {
    const savedHome = process.env.WUDAO_GLOBAL_HOME;
    const regHome = mkdtempSync(join(tmpdir(), "wf-provreg-"));
    try {
      process.env.WUDAO_GLOBAL_HOME = regHome;
      writeFileSync(
        join(regHome, "providers.json"),
        JSON.stringify({
          version: 1,
          providers: {
            "my-gw": { baseUrl: "https://gw.example.com/v1", defaultModel: "m-x" },
          },
        }),
        "utf8",
      );
      resetProviderRegistryCacheForTests();
      const built: { provider?: string; baseURL?: string; model?: string }[] = [];
      const { factory } = fakeModelFactory([{ role: "assistant", content: "done" }]);
      const file = join(root, "wf-gw.json");
      writeFileSync(file, JSON.stringify({ name: "gw", steps: [{ id: "s", prompt: "p" }] }));
      const code = await workflowMain(["run", file, "--auto"], {
        cwd: root,
        env: { WUDAO_API_KEY: "sk-test", WUDAO_PROVIDER: "my-gw" },
        out: () => {},
        buildModel: (cfg) => {
          built.push({ provider: cfg.provider, baseURL: cfg.baseURL, model: cfg.model });
          return factory(cfg);
        },
      });
      expect(code).toBe(0);
      expect(built[0]).toMatchObject({ provider: "my-gw", baseURL: "https://gw.example.com/v1", model: "m-x" });
    } finally {
      if (savedHome === undefined) delete process.env.WUDAO_GLOBAL_HOME;
      else process.env.WUDAO_GLOBAL_HOME = savedHome;
      rmSync(regHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      resetProviderRegistryCacheForTests();
    }
  });
});
