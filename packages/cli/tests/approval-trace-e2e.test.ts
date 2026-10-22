// 审批痕 (approval trace) E2E — the approval sites' observable contract
// through the REAL CLI binary (m62 fix-round harness pattern): the raw line
// the human typed to approve a plan lands VERBATIM as a genuine user message
// immediately BEFORE the <plan-approved> wrapper, and a negative line lands
// nothing. The local stub OpenAI-compatible endpoint is the observer — every
// request body carries the full message list, so the ORDER is pinned on the
// wire, at the model boundary.
//
//   repl site      packages/cli/src/repl.ts (M37 §1 review intake) — driven
//                  through --no-tui over piped stdin (the readline REPL needs
//                  no TTY for this path; todo_write is read-class so no ask
//                  ever parks on rl.question).
//   one-shot site  packages/cli/src/index.ts --plan confirm — the positive
//                  case needs a REAL TTY (stdin.isTTY gates the question) and
//                  rides /usr/bin/script's pty; the negative case (piped
//                  stdin → not a TTY) runs the plain spawn.
//   driver site    covered in-process in driver.test.ts (makeDriver harness).
//   helper/classification/y-N-decision — plan.test.ts.
//
// DELIBERATELY ONLY THREE spawns, env-gated OFF by default: these children
// boot the full CLI, and a parallel vitest worker spawning them adds real
// load to a suite whose sub-second real-timer tests (app.test.tsx /
// input.test.ts / tui-sidecar) are already machine-marginal (measured —
// report doc 68 §7: flakes rotate with AND without this file). Gating also
// states the precondition the default suite never guarantees: `dist/` must
// be built first. Opt in with WUDAO_E2E=1. The cases folded back into
// in-process coverage: the repl fall-through prompt (driver.test.ts already
// pins a non-review line keeping the board under review) and the pty EMPTY
// line (planConfirmApproves("") → false pins the empty=negative decision;
// confirmLineRaw trims to "").
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const SCRIPT_BIN = "/usr/bin/script"; // BSD/macOS pty wrapper
// The env gate (see the file header): default OFF; WUDAO_E2E=1 opts in.
const E2E_ON = process.env.WUDAO_E2E === "1";

interface WireMessage {
  role?: string;
  content?: string | Array<unknown>;
}

interface RecordedRequest {
  messages: WireMessage[];
}

/** The stub endpoint, scripted by REQUEST SHAPE (not index — robust to any
 *  extra model calls): a plan-request turn answers a todo_write tool call;
 *  once the board's tool result is in history the run gets its text answer;
 *  an execution turn (<plan-approved> in history) gets a final text. */
function stubPlanEndpoint(): {
  server: Server;
  port: Promise<number>;
  requests: RecordedRequest[];
  close: () => Promise<void>;
} {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString("utf8"); });
    req.on("end", () => {
      let parsed: { messages?: WireMessage[] } = {};
      try { parsed = JSON.parse(body) as typeof parsed; } catch { /* ignore */ }
      const messages = parsed.messages ?? [];
      requests.push({ messages });
      const contents = messages.map((m) => (typeof m.content === "string" ? m.content : ""));
      const sse = (payload: unknown): void => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      const done = (): void => {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      };
      if (contents.some((c) => c.startsWith("<plan-approved>"))) {
        // Execution turn: plain final answer.
        sse({ choices: [{ index: 0, delta: { role: "assistant", content: "EXECUTED" } }] });
        done();
        return;
      }
      if (contents.some((c) => c === "what is the plan?")) {
        // A fall-through plain prompt while the board stays under review.
        sse({ choices: [{ index: 0, delta: { role: "assistant", content: "ANSWERED" } }] });
        done();
        return;
      }
      if (contents.some((c) => c.startsWith("[todo board"))) {
        // Board already landed in history: the plan run's closing answer.
        sse({ choices: [{ index: 0, delta: { role: "assistant", content: "PLAN-READY" } }] });
        done();
        return;
      }
      // The plan run's first call: produce the board via todo_write.
      sse({
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [{
              index: 0,
              id: "t1",
              type: "function",
              function: { name: "todo_write", arguments: JSON.stringify({ todos: [{ content: "add the feature", status: "pending" }] }) },
            }],
          },
        }],
      });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
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

/** Spawn prefix that yields the CPU: the E2E children boot the whole CLI and
 *  a parallel vitest worker running them can push the suite's sub-second
 *  timing tests into flaking (measured — see the file header). These tests
 *  wait on CHILD OUTPUT patterns, never CPU budgets, so a low priority costs
 *  them nothing while protecting the concurrently running timing tests. */
const NICE: readonly string[] = ["nice", "-n", "19"];

function childEnv(home: string, baseURL: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    WUDAO_GLOBAL_HOME: home,
    WUDAO_API_KEY: "test-key",
    WUDAO_BASE_URL: baseURL,
    WUDAO_MODEL: "fake-e2e-model",
    NO_COLOR: "1",
    // Gate ablation via ENV, never argv: stripLogFlags keeps `--no-gates` in
    // the prompt words, so an argv flag would turn a bare `--no-tui` spawn
    // into a ONE-SHOT with the literal prompt "--no-gates" (and the M61
    // headless-goal guard bug would then arm a goal from prompt.slice(5)).
    WUDAO_NO_GATES: "1",
  };
}

interface ChildRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn the real CLI with piped stdio; each step writes one stdin line once
 *  its `when` patterns have ALL appeared in the captured stdout (turn-gated
 *  input: a line never races the turn it answers), and `exit` (when given)
 *  is the session-ending line with its own gate. */
function runCli(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  steps: ReadonlyArray<{ readonly when: readonly string[]; readonly line: string }>,
  exit: { readonly when: readonly string[]; readonly line: string } | undefined,
  timeoutMs = 30_000,
): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(NICE[0], [...NICE.slice(1), process.execPath, CLI_ENTRY, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    killer.unref?.();
    child.on("close", () => clearTimeout(killer));
    const writeWhen = (patterns: readonly string[], line: string): void => {
      const tick = (): void => {
        if (child.stdin.destroyed) return;
        if (patterns.every((p) => stdout.includes(p))) child.stdin.write(`${line}\n`);
        else setTimeout(tick, 100);
      };
      tick();
    };
    for (const step of steps) writeWhen(step.when, step.line);
    if (exit !== undefined) writeWhen(exit.when, exit.line);
  });
}

/** The same spawn under a real pty via BSD script(1) — the one-shot confirm
 *  reads raw stdin only when stdin.isTTY (same mechanics as askApprove). */
function runCliPty(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  confirmWhen: string,
  confirmLine: string,
  timeoutMs = 30_000,
): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(NICE[0], [...NICE.slice(1), SCRIPT_BIN, "-q", "/dev/null", process.execPath, CLI_ENTRY, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    killer.unref?.();
    child.on("close", () => clearTimeout(killer));
    const tick = (): void => {
      if (child.stdin.destroyed) return;
      if (stdout.includes(confirmWhen)) child.stdin.write(`${confirmLine}\n`);
      else setTimeout(tick, 100);
    };
    tick();
  });
}

function flatContents(req: RecordedRequest | undefined): string[] {
  return (req?.messages ?? []).map((m) => (typeof m.content === "string" ? m.content : ""));
}

function roles(req: RecordedRequest | undefined): (string | undefined)[] {
  return (req?.messages ?? []).map((m) => m.role);
}

function lastRequestWith(reqs: readonly RecordedRequest[], prefix: string): RecordedRequest | undefined {
  return reqs.filter((r) => flatContents(r).some((c) => c.startsWith(prefix))).at(-1);
}

/** The request's USER-role contents only — assistant tool-call messages
 *  legitimately carry content "" and must never be mistaken for a pushed
 *  empty confirmation. */
function userContents(req: RecordedRequest | undefined): string[] {
  return (req?.messages ?? []).filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : ""));
}

describe("审批痕 E2E — repl site (--no-tui, piped stdin)", () => {
  it.skipIf(!E2E_ON)("approve \"ok\": the wire order is […, user \"ok\", user \"<plan-approved>…\"] and the board run precedes it", async () => {
    const stub = stubPlanEndpoint();
    const port = await stub.port;
    const baseURL = `http://127.0.0.1:${port}/v1`;
    const ws = makeWs("wudao-trace-repl-");
    const home = mkdtempSync(join(tmpdir(), "wudao-trace-repl-home-"));
    try {
      const run = await runCli(
        ["--no-tui"],
        ws,
        childEnv(home, baseURL),
        [
          // "wudao> " = the readline question is ARMED (a line written before
          // the interface attaches is dropped by the pipe).
          { when: ["wudao> "], line: "/plan add a feature" },
          { when: ["plan ready"], line: "ok" },
        ],
        { when: ["EXECUTED"], line: "/exit" },
      );
      expect(run.stdout).toContain("plan ready");
      expect(stub.requests.length).toBeGreaterThanOrEqual(3); // plan(2) + execution(1)

      const exec = lastRequestWith(stub.requests, "<plan-approved>");
      expect(exec).toBeDefined();
      const contents = flatContents(exec);
      const wrapperIdx = contents.findIndex((c) => c.startsWith("<plan-approved>"));
      expect(wrapperIdx).toBeGreaterThan(0);
      // The raw confirmation word, verbatim, immediately before the wrapper.
      expect(contents[wrapperIdx - 1]).toBe("ok");
      expect(roles(exec)[wrapperIdx - 1]).toBe("user");
      // The wrapper itself still carries the board verbatim.
      expect(contents[wrapperIdx]).toContain("add the feature");
    } finally {
      await stub.close();
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 60_000);
});

describe("审批痕 E2E — one-shot --plan site", () => {
  it.skipIf(!E2E_ON)("piped stdin is not a TTY: negative by construction — nothing pushed, plan not executed", async () => {
    const stub = stubPlanEndpoint();
    const port = await stub.port;
    const baseURL = `http://127.0.0.1:${port}/v1`;
    const ws = makeWs("wudao-trace-1s-neg-");
    const home = mkdtempSync(join(tmpdir(), "wudao-trace-1s-neg-home-"));
    try {
      const run = await runCli(["--plan", "add the feature"], ws, childEnv(home, baseURL), [], undefined);
      expect(run.stdout).toContain("(plan not executed)");
      // No execution ever ran and no confirmation word was pushed as a
      // message: no request carries the wrapper or a standalone y/yes/ok
      // user line. (Request COUNT is deliberately not pinned: the
      // pre-existing M61 headless-goal guard bug arms a bogus goal on every
      // one-shot prompt and fires extra evaluator calls — noise this test
      // must tolerate until that bug is fixed on its own ticket.)
      for (const req of stub.requests) {
        expect(flatContents(req).some((c) => c.startsWith("<plan-approved>"))).toBe(false);
        expect(userContents(req).some((c) => c === "y" || c === "yes" || c === "ok")).toBe(false);
      }
    } finally {
      await stub.close();
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 60_000);

  it.skipIf(!E2E_ON || !existsSync(SCRIPT_BIN))("pty \"Y\": the raw line lands verbatim (case kept) immediately before the wrapper", async () => {
    const stub = stubPlanEndpoint();
    const port = await stub.port;
    const baseURL = `http://127.0.0.1:${port}/v1`;
    const ws = makeWs("wudao-trace-1s-y-");
    const home = mkdtempSync(join(tmpdir(), "wudao-trace-1s-y-home-"));
    try {
      const run = await runCliPty(["--plan", "add the feature"], ws, childEnv(home, baseURL), "execute this plan?", "Y");
      expect(run.stdout).not.toContain("(plan not executed)");
      const exec = lastRequestWith(stub.requests, "<plan-approved>");
      expect(exec).toBeDefined();
      const contents = flatContents(exec);
      const wrapperIdx = contents.findIndex((c) => c.startsWith("<plan-approved>"));
      expect(wrapperIdx).toBeGreaterThan(0);
      expect(contents[wrapperIdx - 1]).toBe("Y"); // verbatim, case preserved
      expect(roles(exec)[wrapperIdx - 1]).toBe("user");
      expect(contents[wrapperIdx]).toContain("add the feature");
    } finally {
      await stub.close();
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 60_000);
});
