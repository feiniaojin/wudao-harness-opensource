// I2 hotfix — the M61 headless-goal guard regression (packages/cli/src/index.ts):
// `/^\/goal(?:\s+|$)/.exec(prompt)` returns a match object or NULL — never
// undefined — so `goalPromptMatch !== undefined` was ALWAYS true and every
// one-shot prompt was force-fed through parseGoalCommand(prompt.slice(5)):
//   • a plain prompt ("hello world from the test") had its first 5 chars
//     chopped into a goal condition (first user message replaced by the 残句)
//     and armed a FALSE goal — "goal set" printed, goal_set entry landed;
//   • a prompt whose post-slice text parses as status/clear ("hi" → status)
//     printed the goal status and exited WITHOUT ever calling the model;
//   • prompts starting with OTHER slash commands ("/plan something" →
//     condition "something") wrongly took the goal branch too.
// E2E through the real CLI binary (m62 fix-round harness pattern) against a
// local stub OpenAI-compatible SSE endpoint. Three observables per case: the
// WIRE (the stub records every request's full message list — the model
// boundary is the truth), the session JSONL (persisted first user message +
// goal_set entries), and stdout ("goal set" notice). Requires dist/ built
// (same precondition as m62-fix-round.test.ts, which spawns the same binary).
//
// Env-gated like approval-trace-e2e.test.ts (WUDAO_E2E=1), per the I1 ruling
// recorded in doc 40: real-CLI spawns in the PARALLEL default suite worsen
// the known session-flush timing-flake family (doc 68 §7, flake-lane ticket
// open). The default suite still gets ONE ungated spawn (the "hi" pin below)
// covering the bug's worst face: a short prompt silently parsed as
// goal-status exits before ANY model call. NOTE m62-fix-round.test.ts M1
// still does not pin this: it ablates gates via the WUDAO_NO_GATES env (the
// same bridge — its argv `--no-gates hi` surprise was fixed per the I2
// review), so its prompt is now the bare "hi", but its assertions only look
// at the tool list, never at message content or goal state.
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
// The env gate (see the file header): default OFF; WUDAO_E2E=1 opts in.
const E2E_ON = process.env.WUDAO_E2E === "1";

interface WireMessage {
  role?: string;
  content?: string;
}

/** A minimal OpenAI-compatible SSE chat endpoint that records each request's
 *  full message list and answers one plain assistant turn. A verdict-free
 *  answer (no "VERDICT:" line) makes any goal-evaluator call allow the stop
 *  without clearing the goal — the run settles cleanly either way. */
function stubModelEndpoint(): { server: Server; port: Promise<number>; requests: WireMessage[][]; close: () => Promise<void> } {
  const requests: WireMessage[][] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString("utf8"); });
    req.on("end", () => {
      let parsed: { messages?: WireMessage[] } = {};
      try { parsed = JSON.parse(body) as typeof parsed; } catch { /* ignore */ }
      requests.push(parsed.messages ?? []);
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
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function makeWs(prefix: string): string {
  const ws = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(ws, ".wudao"), { recursive: true });
  return ws;
}

/** The last user-role message of the FIRST recorded request — the run's
 *  first-turn instruction exactly as the model saw it. */
function firstTurnInstruction(requests: readonly WireMessage[][]): string | undefined {
  const first = requests[0];
  const users = (first ?? []).filter((m) => m.role === "user");
  return users.at(-1)?.content;
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
        // Gate ablation via ENV, never argv: an argv flag would stay in the
        // prompt words (stripLogFlags keeps it) and change what we assert on.
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

/** The one run's session JSONL, parsed line by line. A fresh ws per case
 *  holds exactly one session file. */
function sessionLines(ws: string): Record<string, unknown>[] {
  const dir = join(ws, ".wudao", "sessions");
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  expect(files).toHaveLength(1);
  return readFileSync(join(dir, files[0]!), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const firstUserContent = (lines: readonly Record<string, unknown>[]): unknown =>
  lines.find((l) => l.role === "user")?.content;
const goalSetEntries = (lines: readonly Record<string, unknown>[]): Record<string, unknown>[] =>
  lines.filter((l) => l.type === "goal_set");

// The UNGATED default-suite pin (ONE piped spawn — same load class as
// m62-fix-round's two): the bug's silent-exit face. Pre-fix, "hi" slices to
// "" → goal-status → the one-shot prints the status and exits without ANY
// model call; post-fix it is a plain prompt that runs.
describe("I2 — a short one-shot prompt actually runs (default-suite pin)", () => {
  it("\"hi\" reaches the model verbatim and arms no goal", async () => {
    const stub = stubModelEndpoint();
    const baseURL = `http://127.0.0.1:${await stub.port}/v1`;
    const ws = makeWs("wudao-i2-hi-");
    const envHome = mkdtempSync(join(tmpdir(), "wudao-i2-hi-home-"));
    try {
      const run = await runOneShot("hi", ws, envHome, baseURL);
      expect(run.code).toBe(0);
      expect(run.stderr).toBe("");
      // The run happened: the model was called, with the prompt VERBATIM.
      expect(stub.requests.length).toBeGreaterThanOrEqual(1);
      expect(firstTurnInstruction(stub.requests)).toBe("hi");
      // And no goal was armed from it.
      expect(run.stdout).not.toContain("goal set");
    } finally {
      await stub.close();
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      rmSync(envHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 45_000);
});

describe.skipIf(!E2E_ON)("I2 — the headless-goal guard: only /goal takes the goal branch", () => {
  it("a plain one-shot prompt reaches the model VERBATIM, persists verbatim, and arms NO goal", async () => {
    const stub = stubModelEndpoint();
    const baseURL = `http://127.0.0.1:${await stub.port}/v1`;
    const ws = makeWs("wudao-i2-plain-");
    const envHome = mkdtempSync(join(tmpdir(), "wudao-i2-plain-home-"));
    try {
      const run = await runOneShot("hello world from the test", ws, envHome, baseURL);
      expect(run.code).toBe(0);
      expect(run.stderr).toBe("");
      // The run actually ran (the model answered; today's "hi"-shape face of
      // the same bug exits before any model call — pinned by the ungated test above).
      expect(run.stdout).toContain("stub-ack");
      // NO goal branch: no set notice, no goal_set entry.
      expect(run.stdout).not.toContain("goal set");
      // The wire: the run's first-turn instruction is the FULL prompt.
      expect(firstTurnInstruction(stub.requests)).toBe("hello world from the test");
      // The persisted first user message is the FULL prompt, verbatim.
      const lines = sessionLines(ws);
      expect(firstUserContent(lines)).toBe("hello world from the test");
      expect(goalSetEntries(lines)).toEqual([]);
    } finally {
      await stub.close();
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      rmSync(envHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 45_000);

  it("`/goal <condition>` still takes the goal branch exactly as before (设置即开局)", async () => {
    const stub = stubModelEndpoint();
    const baseURL = `http://127.0.0.1:${await stub.port}/v1`;
    const ws = makeWs("wudao-i2-goal-");
    const envHome = mkdtempSync(join(tmpdir(), "wudao-i2-goal-home-"));
    try {
      const run = await runOneShot("/goal make all tests pass", ws, envHome, baseURL);
      expect(run.code).toBe(0);
      // The goal branch: armed with the condition, set notice printed.
      expect(run.stdout).toContain("goal set");
      const lines = sessionLines(ws);
      expect(goalSetEntries(lines)).toEqual([expect.objectContaining({ data: expect.objectContaining({ condition: "make all tests pass" }) })]);
      // 设置即开局: the condition itself is the run's first-turn instruction.
      expect(firstTurnInstruction(stub.requests)).toBe("make all tests pass");
      expect(firstUserContent(lines)).toBe("make all tests pass");
    } finally {
      await stub.close();
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      rmSync(envHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 45_000);

  it("a prompt starting with ANOTHER slash command does NOT take the goal branch", async () => {
    const stub = stubModelEndpoint();
    const baseURL = `http://127.0.0.1:${await stub.port}/v1`;
    const ws = makeWs("wudao-i2-slash-");
    const envHome = mkdtempSync(join(tmpdir(), "wudao-i2-slash-home-"));
    try {
      const run = await runOneShot("/plan something", ws, envHome, baseURL);
      expect(run.code).toBe(0);
      expect(run.stderr).toBe("");
      // No goal armed from a /plan (or any non-/goal slash) prompt.
      expect(run.stdout).not.toContain("goal set");
      expect(firstTurnInstruction(stub.requests)).toBe("/plan something");
      const lines = sessionLines(ws);
      expect(firstUserContent(lines)).toBe("/plan something");
      expect(goalSetEntries(lines)).toEqual([]);
    } finally {
      await stub.close();
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      rmSync(envHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 45_000);
});
