// M62 review fix round — one regression test per finding:
//   M1  memoryEnabled:false in the ONE-SHOT leaves zero memory surface (the
//       `openSessionMemoryStore(...) ?? openMemoryStore(...)` shape reopened
//       the default store exactly when memory was disabled). E2E through the
//       real CLI binary against a local stub OpenAI endpoint: the request's
//       tool list is the observable — no memory_write/memory_search tools ⇒
//       no memory reads/writes are even possible.
//   M2  the workflow run threads the settings' fallbackModel chain into the
//       provider config AND both routePreflight calls — an unlisted primary
//       with a switchable fallback now routes instead of refusing.
//   M3  /config set local <k> <v> — the product writer for the local tier
//       (first write auto-gitignores settings.local.json; escalation keys
//       refused; the bare report stays read-only).
//   L4  (covered by build + evals) the output-styles cache key keeps its NUL
//       separator byte — now spelled \x00 so the source file is text.
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, ModelClient, ModelInput } from "@wudao/core";
import { routePreflight } from "../src/workflow/preflight.js";
import { workflowMain } from "../src/workflow/cli.js";
import { runConfigCommand } from "../src/commands/config.js";
import { parseReplCommand } from "../src/repl.js";

const CLI_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

function makeWs(prefix: string): string {
  const ws = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(ws, ".wudao"), { recursive: true });
  return ws;
}

// ---------------------------------------------------------------------------
// M1 — the one-shot's memory surface (real CLI binary + stub SSE endpoint).
// ---------------------------------------------------------------------------

/** A minimal OpenAI-compatible SSE chat endpoint that records each request's
 *  tool names and answers one plain assistant turn. */
function stubModelEndpoint(): { server: Server; port: Promise<number>; toolLists: string[][]; close: () => Promise<void> } {
  const toolLists: string[][] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString("utf8"); });
    req.on("end", () => {
      let parsed: { tools?: Array<{ function?: { name?: string } }> } = {};
      try { parsed = JSON.parse(body) as typeof parsed; } catch { /* ignore */ }
      toolLists.push((parsed.tools ?? []).map((t) => t.function?.name ?? "").filter((n) => n !== ""));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "stub-ack" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  const port = new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  return {
    server,
    port,
    toolLists,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function runOneShot(prompt: string, cwd: string, envHome: string, baseURL: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, prompt], {
      cwd,
      env: {
        ...process.env,
        WUDAO_GLOBAL_HOME: envHome,
        WUDAO_API_KEY: "test-key",
        WUDAO_BASE_URL: baseURL,
        WUDAO_MODEL: "fake-e2e-model",
        NO_COLOR: "1",
        // Gate ablation via ENV, never argv (the I2 review's "argv surprise"):
        // stripLogFlags keeps `--no-gates` in the prompt words, so the old
        // argv form made this spawn's one-shot prompt "--no-gates hi" — and
        // pre-I2-fix even armed a goal from prompt.slice(5) (condition "gates
        // hi"). WUDAO_NO_GATES is the ablation bridge's own env name
        // (args.ts ablationEnvVar("gates")), read by applyGatesAblation via
        // isFeatureAblated — same sibling pattern as i2-goal-guard.test.ts
        // and approval-trace-e2e.test.ts.
        WUDAO_NO_GATES: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    const killer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    killer.unref?.();
    child.on("close", () => clearTimeout(killer));
  });
}

describe("M62 fix M1 — one-shot memoryEnabled:false → no memory store", () => {
  it("the disabled one-shot sends NO memory tools; the default sends both (real CLI, stub endpoint)", async () => {
    const stub = stubModelEndpoint();
    const port = await stub.port;
    const baseURL = `http://127.0.0.1:${port}/v1`;
    const disabledWs = makeWs("wudao-m62-m1-off-");
    const enabledWs = makeWs("wudao-m62-m1-on-");
    const envHome = mkdtempSync(join(tmpdir(), "wudao-m62-m1-home-"));
    try {
      writeFileSync(join(disabledWs, ".wudao", "settings.json"), JSON.stringify({ memoryEnabled: false }), "utf8");

      const off = await runOneShot("hi", disabledWs, envHome, baseURL);
      expect(off.code).toBe(0);
      expect(stub.toolLists.length).toBeGreaterThanOrEqual(1);
      const offTools = stub.toolLists[0] ?? [];
      expect(offTools).not.toContain("memory_write");
      expect(offTools).not.toContain("memory_search");
      // No store was opened behind the flag's back: nothing to read or write.
      expect(existsSync(join(disabledWs, ".wudao", "memory.jsonl"))).toBe(false);

      stub.toolLists.length = 0;
      const on = await runOneShot("hi", enabledWs, envHome, baseURL);
      expect(on.code).toBe(0);
      const onTools = stub.toolLists[0] ?? [];
      expect(onTools).toContain("memory_write");
      expect(onTools).toContain("memory_search");
    } finally {
      await stub.close();
      for (const ws of [disabledWs, enabledWs, envHome]) rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 45000);
});

// ---------------------------------------------------------------------------
// M2 — fallbackModel threaded into workflow runs.
// ---------------------------------------------------------------------------

describe("M62 fix M2 — workflow run threads the fallbackModel chain", () => {
  it("routePreflight: an unlisted primary + a switchable fallback routes (and without the chain it refuses)", () => {
    // The whitespace-carrying WUDAO_MODEL is unlisted for the resolved
    // provider (availableModels registers the TRIMMED name; the resolved
    // config keeps the raw spelling) — the one env-only way a workflow
    // primary sits outside the profile set.
    const env = { WUDAO_API_KEY: "k", WUDAO_MODEL: " not-a-real-model " };
    const base = { env, budgetRemaining: 100_000, budgetTotal: 100_000 };
    const without = routePreflight(base);
    expect(without.ok).toBe(false);
    expect(without.refusals.some((r) => r.includes("model:"))).toBe(true);
    const withChain = routePreflight({ ...base, fallbackModels: ["deepseek-v4-flash"] });
    expect(withChain.ok).toBe(true);
    expect(withChain.checks.find((c) => c.id === "model")?.detail).toContain("deepseek-v4-flash");
  });

  it("workflowMain: a fallbackModel setting + an unlisted primary → admitted, and the engine's config carries the chain", async () => {
    const ws = makeWs("wudao-m62-m2-");
    const envHome = mkdtempSync(join(tmpdir(), "wudao-m62-m2-home-"));
    try {
      writeFileSync(join(ws, ".wudao", "settings.json"), JSON.stringify({ fallbackModel: ["deepseek-v4-flash"] }), "utf8");
      writeFileSync(join(ws, "wf.js"), "const a = await task('say it');\nreturn a.ok;\n", "utf8");
      const seen: ProviderConfigLike[] = [];
      const replies: AssistantMessage[] = [{ role: "assistant", content: "workflow-done" }];
      let i = 0;
      const model: ModelClient = {
        async generate(input: ModelInput): Promise<AssistantMessage> {
          input.onUsage?.({ promptTokens: 10, cacheHitTokens: 0, cacheMissTokens: 10, completionTokens: 5 });
          const r = replies[i];
          i += 1;
          if (!r) throw new Error("scripted responses exhausted");
          return r;
        },
      };
      const out: string[] = [];
      const env = {
        WUDAO_API_KEY: "k",
        WUDAO_BASE_URL: "http://127.0.0.1:1/v1",
        WUDAO_MODEL: " not-a-real-model ", // untrimmed → outside the profile set
        WUDAO_GLOBAL_HOME: envHome,
      };
      const code = await workflowMain(["run", join(ws, "wf.js")], {
        cwd: ws,
        env,
        buildModel: (config) => { seen.push(config); return model; },
        out: (s) => { out.push(s); },
      });
      // Pre-fix this exited 1 with "preflight refused" (model: not in the
      // profile set) — now the chain routes via the fallback.
      expect(code).toBe(0);
      expect(out.join("")).not.toContain("preflight refused");
      expect(out.join("")).toContain("1/1 tasks ok"); // the task RAN (not merely admitted)
      // The engine's model client got the DECORATED config (failover works).
      expect(seen[0]?.fallbackModels).toEqual(["deepseek-v4-flash"]);
      expect(seen[0]?.model).toBe(" not-a-real-model ");
    } finally {
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      rmSync(envHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 15000);
});

interface ProviderConfigLike {
  readonly model?: string;
  readonly fallbackModels?: readonly string[];
}

// ---------------------------------------------------------------------------
// M3 — /config set local <key> <value> (the §3 first-write auto-gitignore's
// product trigger).
// ---------------------------------------------------------------------------

describe("M62 fix M3 — /config set local writes the local tier", () => {
  it("the first write creates settings.local.json AND appends the .gitignore entry; the second merges + never re-touches .gitignore", async () => {
    const ws = makeWs("wudao-m62-m3-");
    try {
      writeFileSync(join(ws, ".gitignore"), "node_modules\n", "utf8");
      const first = await runConfigCommand({ workspaceRoot: ws, args: "set local theme dark" });
      expect(first).toContain("已保存 theme"); // ω99-177: 钉随源演进
      expect(first).toContain("已创建并已 gitignore"); // ω99-177: 钉随源演进
      const record = JSON.parse(readFileSync(join(ws, ".wudao", "settings.local.json"), "utf8")) as Record<string, unknown>;
      expect(record).toEqual({ theme: "dark" });
      expect(readFileSync(join(ws, ".gitignore"), "utf8")).toContain(".wudao/settings.local.json");

      const second = await runConfigCommand({ workspaceRoot: ws, args: 'set local fallbackModel ["m-a","m-b"]' });
      expect(second).toContain("已更新"); // ω99-177: 钉随源演进
      const merged = JSON.parse(readFileSync(join(ws, ".wudao", "settings.local.json"), "utf8")) as Record<string, unknown>;
      expect(merged).toEqual({ theme: "dark", fallbackModel: ["m-a", "m-b"] }); // JSON value parsed, old key kept
      const gi = readFileSync(join(ws, ".gitignore"), "utf8");
      expect(gi.split(/\r?\n/).filter((l) => l.trim() === ".wudao/settings.local.json")).toHaveLength(1); // never duplicated
    } finally {
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("escalation keys are refused at the writer (local follows project trust); junk args print usage", async () => {
    const ws = makeWs("wudao-m62-m3b-");
    try {
      const refused = await runConfigCommand({ workspaceRoot: ws, args: "set local bypassPermissions true" });
      expect(refused).toContain("提权键"); // ω99-177: 钉随源演进（裸词漏网，census 披露同弧演进）
      expect(existsSync(join(ws, ".wudao", "settings.local.json"))).toBe(false); // nothing written
      expect(await runConfigCommand({ workspaceRoot: ws, args: "banana" })).toContain("用法："); // ω99-166d-i: 泛 usage 钉演进（#32）
      expect(await runConfigCommand({ workspaceRoot: ws, args: "set global theme dark" })).toContain("只有 local 层可写"); // ω99-166d-i: 尾文钉演进（#31）
      // The bare command is still the read-only report.
      const report = await runConfigCommand({ workspaceRoot: ws, args: "" });
      expect(report).toContain("配置（生效值，只读）："); // ω99-182: 钉随源演进（brief 钉表漏列——反查兜出，181 教训）
    } finally {
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("parseReplCommand routes /config with and without args", () => {
    expect(parseReplCommand("/config", [], [])).toEqual({ kind: "config", args: "" });
    expect(parseReplCommand("/config set local theme dark", [], [])).toEqual({ kind: "config", args: "set local theme dark" });
    expect(parseReplCommand("/configX", [], []).kind).toBe("prompt");
  });
});
