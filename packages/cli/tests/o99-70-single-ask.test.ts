// ω99-70 — the armed approval gate flips only SILENT allows. A call the
// human JUST decided inside the frontend layer (the sidecar high-risk
// escalation asks through the lane's ask seam; the human answers y) must
// not be re-asked by the gate: exactly ONE ask per call, on BOTH lanes.
//   driver lane: the gate closure consults o.canUseTool, which in the TUI
//     shape escalates via driver.ask → the SAME askPermission seam the gate
//     itself asks through — base asked twice per call.
//   REPL lane: the gate block consults layeredDecide, whose sidecar layer
//     escalates through askHuman — the same seam the block asks through —
//     same double ask under (sidecar + auto + high verdict + armed).
// The negative control pins the no-sidecar static path (always single-ask).
// ω99-70 also pins the y (allow-once) per-call semantics: the human-settled
// marker never outlives ITS call — a new same-input call asks again.
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { buildTool, createScriptedModel } from "@wudao/core";
import type { Tool, PermissionDecision } from "@wudao/core";
import type { ProviderConfig } from "@wudao/providers";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";
import { loadSkills } from "../src/skills.js";
import type { LoadedSkill } from "../src/skills.js";
import type { AskAnswer } from "../src/permission.js";
import type { Sidecar } from "../src/sidecar.js";
import { runRepl } from "../src/repl.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`o99-70: timed out waiting for ${what}`);
    await wait();
  }
}

const SKILL_MD = [
  "---",
  "name: deslop",
  "description: simplify completed work under a per-path approval gate",
  "approval-gate: file-edits",
  "---",
  "",
  "# deslop",
  "",
  "Simplify; every significant deletion needs per-path human approval.",
].join("\n");

async function gateWorkspace(tag: string): Promise<string> {
  const ws = await realpath(await mkdtemp(join(tmpdir(), tag)));
  await mkdir(join(ws, ".wudao", "sessions"), { recursive: true });
  await mkdir(join(ws, ".wudao", "skills", "deslop"), { recursive: true });
  await writeFile(join(ws, ".wudao", "skills", "deslop", "SKILL.md"), SKILL_MD, "utf8");
  return ws;
}

const params = {
  type: "object" as const,
  properties: { path: { type: "string" as const } },
  required: ["path"],
  additionalProperties: false,
};

function editTool(flag: { runs: number }): Tool {
  return buildTool({
    name: "edit",
    description: "d",
    parameters: params,
    execute: async () => {
      flag.runs += 1;
      return { content: "edited" };
    },
  });
}

function readTool(): Tool {
  return buildTool({ name: "read_file", description: "d", parameters: params, execute: async () => ({ content: "C" }) });
}

type Gate = (toolName: string, input: Record<string, unknown>) => Promise<PermissionDecision | "ask"> | PermissionDecision | "ask";

const editCall = (id: string, path: string) => [
  { role: "assistant" as const, content: "", toolCalls: [{ id, name: "edit", arguments: { path } }] },
  { role: "assistant" as const, content: "done" },
];

/** The driver lane, TUI shape: the frontend gate IS the sidecar escalation
 *  (app.tsx's sidecarGate → driver.ask) and the human ask rides
 *  onPermissionAsk — the escalated ask lands in the SAME askPermission seam
 *  the run gate asks through. Every onPermissionAsk answer is a plain `y`
 *  (allow-once: no receipt, no rule). */
async function escalatingDriver(
  ws: string,
  flag: { runs: number },
  asks: { toolName: string; path: unknown }[],
): Promise<{ driver: AgentDriver; rearm: (model: Parameters<typeof createScriptedModel>[0]) => void }> {
  const [skill] = loadSkills(ws, () => {}) as LoadedSkill[];
  expect(skill?.approvalGate).toBe("file-edits");
  let driver: AgentDriver | undefined;
  const opts = (model: Parameters<typeof createScriptedModel>[0]) => ({
    model,
    tools: [editTool(flag), readTool()],
    systemPrompt: "s",
    summarize: summarizeToolCall,
    sessionId: "s-o9970",
    workspaceRoot: ws,
    skills: [skill!],
    // The sidecarGate shape: the ask seam itself is the frontend gate.
    canUseTool: (async (toolName: string, input: Record<string, unknown>) =>
      driver!.ask(toolName, input, { sidecarReason: "high risk edit" })) as Gate,
    onPermissionAsk: async (toolName: string, _summary: string, input: Record<string, unknown>): Promise<AskAnswer> => {
      asks.push({ toolName, path: input.path });
      return { kind: "allow" };
    },
  });
  driver = createAgentDriver(opts([{ role: "assistant", content: "skill invoked" }]));
  driver.submit("/skill:deslop");
  await until(() => !driver.getStatus().busy, "skill invocation run settled");
  return {
    driver,
    rearm: (messages: Parameters<typeof createScriptedModel>[0]) =>
      driver!.setOptions(opts(createScriptedModel(messages))),
  };
}

describe("ω99-70 — driver lane: the armed gate flips only SILENT allows", () => {
  it("a y answered INSIDE o.canUseTool (the sidecar-escalation shape) is asked exactly once — the human's own allow stands", async () => {
    const ws = await gateWorkspace("o9970-ws-");
    const flag = { runs: 0 };
    const asks: { toolName: string; path: unknown }[] = [];
    try {
      const { driver, rearm } = await escalatingDriver(ws, flag, asks);
      rearm(editCall("c1", "src/a.ts"));
      driver.submit("simplify now");
      await until(() => !driver.getStatus().busy, "the escalated edit's run settled");
      // ONE ask per call: the escalated ask (driver.ask inside o.canUseTool)
      // already put the human's y on the record — the run gate's flip must
      // not re-ask a decision the human just made. Base: 2 (the double ask).
      expect(asks).toHaveLength(1);
      expect(asks[0]?.toolName).toBe("edit");
      expect(asks[0]?.path).toBe("src/a.ts");
      expect(flag.runs).toBe(1); // the human's y allowed the edit — it ran
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 15_000);

  it("allow-once stays per-call: a NEW same-input call asks again (the settled marker never becomes a session allow)", async () => {
    const ws = await gateWorkspace("o9970-ws-");
    const flag = { runs: 0 };
    const asks: { toolName: string; path: unknown }[] = [];
    try {
      const { driver, rearm } = await escalatingDriver(ws, flag, asks);
      rearm(editCall("c1", "src/a.ts"));
      driver.submit("first touch");
      await until(() => !driver.getStatus().busy, "first escalated edit settled");
      expect(flag.runs).toBe(1);

      // Second, SAME-INPUT call: y minted no receipt and the per-call marker
      // died with its call — the sidecar escalates again and the human is
      // asked again. Exactly one ask per call (base: one doubled ask each).
      rearm(editCall("c2", "src/a.ts"));
      driver.submit("same path again");
      await until(() => !driver.getStatus().busy, "second escalated edit settled");
      expect(asks.map((a) => a.path)).toEqual(["src/a.ts", "src/a.ts"]); // both calls asked
      expect(flag.runs).toBe(2); // both allowed by their own y
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 15_000);
});

// ---------------------------------------------------------------------------
// REPL lane — the loop is driven directly (runRepl → runAgentLoop with
// canUseTool(plan)); the gate block consults layeredDecide, whose sidecar
// layer escalates through askHuman — the same seam the block itself asks
// through.
// ---------------------------------------------------------------------------

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A sidecar whose classifier ALWAYS says high (the M45 escalation posture). */
const highSidecar = (reason: string): Sidecar => ({
  check: async () => ({ kind: "high", reason }),
  breakerOpen: () => false,
  consecutiveHighs: () => 1,
  checks: () => 1,
  breakerAllows: () => 0, // 0.3.82: the breaker never opens in this fake
  noteBreakerAllow: () => {},
  cacheSize: () => 0,
  resetRun: () => {},
  resetBreaker: () => {},
});

function gateTools(flag: { runs: number }): Tool[] {
  const read: Tool = {
    name: "read_file",
    description: "d",
    parameters: params,
    isReadOnly: () => true,
    execute: async () => ({ content: "C" }),
  };
  const edit: Tool = {
    name: "edit",
    description: "d",
    parameters: params,
    execute: async (input: Record<string, unknown>) => {
      flag.runs += 1;
      return { content: `edited ${String(input.path)}` };
    },
  };
  return [read, edit];
}

const enc = new TextEncoder();
const sse = (frames: readonly unknown[]): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({
  start(c) {
    for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
    c.enqueue(enc.encode("data: [DONE]\n\n"));
    c.close();
  },
});

const answer = (text: string): readonly unknown[] => [
  { id: "a", choices: [{ index: 0, delta: { content: text } }] },
  { id: "a", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } },
];

const toolRound = (name: string, id: string, args: Record<string, unknown>): readonly unknown[] => [
  { id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] },
  { id, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 5 } },
];

interface Lane {
  readonly seen: () => string;
  readonly feed: (line: string) => void;
  readonly runs: () => number;
  readonly finish: () => Promise<void>;
}

async function driveRepl(
  ws: string,
  script: readonly (readonly unknown[])[],
  steps: readonly { readonly when: (seen: string) => boolean; readonly line: string }[],
  opts?: { readonly sidecar?: Sidecar },
): Promise<Lane> {
  const stdin = new PassThrough();
  (stdin as unknown as { isTTY: boolean }).isTTY = true; // the y/a/N menu needs a TTY
  const stdout = new PassThrough();
  let calls = 0;
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const frames = script[calls] ?? answer("ok");
    calls += 1;
    return new Response(sse(frames), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  let seen = "";
  const drain = (): void => { let c = stdout.read(); while (c !== null) { seen += c.toString(); c = stdout.read(); } };
  const feed = (line: string): void => { stdin.write(`${line}\n`); };
  const globalHome = await mkdtemp(join(tmpdir(), "o9970-gh-"));
  const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
  const prevArgv = process.argv;
  process.env.WUDAO_GLOBAL_HOME = globalHome;
  process.argv = [prevArgv[0]!, "wudao", "--auto"];
  const flag = { runs: 0 };
  const [skill] = loadSkills(ws, () => {}) as LoadedSkill[];
  expect(skill?.approvalGate).toBe("file-edits");
  let replError: unknown;
  const done = runRepl({
    config: { apiKey: "sk-o9970", baseURL: "https://o9970.invalid/v1", model: "o9970-model" } satisfies ProviderConfig,
    workspaceRoot: ws,
    buildTools: () => gateTools(flag),
    contextWindowTokens: 200_000,
    sessionId: "wudao-o9970",
    skills: [skill!],
    stdin,
    stdout,
    gates: { verify: false },
    ...(opts?.sidecar !== undefined ? { sidecar: opts.sidecar } : {}),
  });
  void (async () => {
    try {
      let fed = 0;
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        drain();
        if (fed < steps.length && steps[fed]!.when(seen)) { feed(steps[fed]!.line); fed += 1; }
        if (fed >= steps.length && seen.includes("o9970-done")) break;
        await delay(10);
      }
      feed("/exit");
    } catch { /* never fails the test here */ }
  })();
  const finish = async (): Promise<void> => {
    await Promise.race([done.then(() => {}, (e: unknown) => { replError = e; }), delay(4_000)]);
    drain();
    stdin.end();
    process.argv = prevArgv;
    process.env.WUDAO_GLOBAL_HOME = prevGlobal;
    globalThis.fetch = prevFetch;
    await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    if (replError !== undefined) throw replError;
  };
  return {
    seen: () => { drain(); return seen; },
    feed,
    runs: () => flag.runs,
    finish,
  };
}

const askCount = (seen: string): number => seen.split("🔑 允许 edit").length - 1;
const prompts = (seen: string): number => seen.split("wudao> ").length - 1;

describe("ω99-70 — REPL lane", () => {
  it("negative control (no sidecar): the armed flip asks the human exactly once per call", async () => {
    const ws = await gateWorkspace("o9970-repl1-");
    const lane = await driveRepl(ws, [
      answer("skill invoked"),
      toolRound("edit", "c1", { path: "src/a.ts" }),
      answer("edited src/a.ts"),
    ], [
      { when: (s) => prompts(s) >= 1, line: "/skill:deslop" },
      { when: (s) => s.includes("skill invoked") && prompts(s) >= 2, line: "simplify src/a.ts" },
      // The gate flip's ask (the static auto-mode allow was silent) — `y`.
      { when: (s) => s.includes("🔑 允许 edit"), line: "y" },
    ]);
    try {
      await until(() => lane.seen().includes("edited src/a.ts"), "the y-approved edit's turn to settle");
      expect(askCount(lane.seen())).toBe(1); // exactly one ask for this call
      expect(lane.runs()).toBe(1);
    } finally {
      await lane.finish();
    }
  }, 30_000);

  it("a y answered INSIDE layeredDecide (the sidecar high-risk escalation) is asked exactly once — the gate must not re-ask", async () => {
    const ws = await gateWorkspace("o9970-repl2-");
    const lane = await driveRepl(ws, [
      answer("skill invoked"),
      toolRound("edit", "c1", { path: "src/a.ts" }),
      answer("turn settled"),
    ], [
      { when: (s) => prompts(s) >= 1, line: "/skill:deslop" },
      { when: (s) => s.includes("skill invoked") && prompts(s) >= 2, line: "simplify src/a.ts" },
      // The sidecar's high verdict escalates inside layeredDecide — the
      // human answers y HERE (allow-once).
      { when: (s) => s.includes("🔑 允许 edit"), line: "y" },
    ], { sidecar: highSidecar("risky deletion") });
    try {
      // Fixed: the y's allow stands — the edit runs, no second ask. Base:
      // the gate re-asks the just-decided call (askCount hits 2).
      await until(
        () => lane.seen().includes("edited src/a.ts") || askCount(lane.seen()) >= 2,
        "the escalated call to resolve (run or re-ask)",
      );
      if (askCount(lane.seen()) >= 2) lane.feed("n"); // settle base's re-ask so the lane can finish
      await until(() => lane.seen().includes("turn settled") || prompts(lane.seen()) >= 3, "the turn to settle");
      expect(askCount(lane.seen())).toBe(1); // base RED: 2 (the double ask)
      expect(lane.runs()).toBe(1); // the human's y allowed the edit — it ran
    } finally {
      await lane.finish();
    }
  }, 30_000);
});
