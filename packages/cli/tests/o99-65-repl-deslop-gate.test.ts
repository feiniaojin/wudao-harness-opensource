// ω99-65 — the file-edits approval gate (deslop) on the REPL lane. 56 armed
// and enforced the gate in the driver's run gate only; the plain REPL drives
// the loop itself, so the same `/skill:deslop` invocation armed nothing here
// — a permission gate that depends on the frontend is a fail-closed hole.
// These cases pin the three states on the REPL lane (the non-TTY PassThrough
// below IS the headless REPL shape — 62's "headless = 非TYY runRepl 同链"):
//   ① armed → a receipt-less edit never silently passes (auto mode too);
//   ② an `a` answer's receipt covers exactly that path+tool (no re-ask), an
//      uncovered path asks again;
//   ③ /clear disarms the posture.
// Plus the one-shot lane pin: the one-shot path has NO skill-invocation seam
// (a `/skill:…` prompt is a literal prompt there), so the only invocation
// seams in the codebase are the two gated ones (repl.ts, agent-driver.ts).
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { runRepl } from "../src/repl.js";
import { loadSkills } from "../src/skills.js";
import type { Tool } from "@wudao-org/core";
import type { ProviderConfig } from "@wudao-org/providers";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  await delay();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`o99-65: timed out waiting for ${what}`);
    await delay(10);
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

async function gateWorkspace(): Promise<string> {
  const ws = await realpath(await mkdtemp(join(tmpdir(), "o9965-ws-")));
  await mkdir(join(ws, ".wudao", "skills", "deslop"), { recursive: true });
  await writeFile(join(ws, ".wudao", "skills", "deslop", "SKILL.md"), SKILL_MD, "utf8");
  return ws;
}

/** The gated tool set: a read tool (REQUIRED — live.skills only populate when
 *  the model can act on the manifest) and an edit tool with a run flag. */
function gateTools(flag: { runs: number; paths: string[] }): Tool[] {
  const read: Tool = {
    name: "read_file",
    description: "d",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    isReadOnly: () => true,
    execute: async () => ({ content: "C" }),
  };
  const edit: Tool = {
    name: "edit",
    description: "d",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async (input: Record<string, unknown>) => {
      flag.runs += 1;
      flag.paths.push(String(input.path));
      return { content: "edited" };
    },
  };
  return [read, edit];
}

// The SSE frame builder the existing REPL suites use (o99-29 shape).
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

/** Runs the REPL (auto mode) over a scripted model + step-fed lines. Each
 *  step = (wait-for predicate, line to feed once it holds). */
async function driveRepl(
  ws: string,
  script: readonly (readonly unknown[])[],
  steps: readonly { readonly when: (seen: string) => boolean; readonly line: string }[],
  opts?: { readonly tty?: boolean },
): Promise<Lane> {
  const stdin = new PassThrough();
  if (opts?.tty === true) (stdin as unknown as { isTTY: boolean }).isTTY = true;
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
  const globalHome = await mkdtemp(join(tmpdir(), "o9965-gh-"));
  const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
  const prevArgv = process.argv;
  process.env.WUDAO_GLOBAL_HOME = globalHome;
  process.argv = [prevArgv[0]!, "wudao", "--auto"];
  const flag = { runs: 0, paths: [] as string[] };
  const [skill] = loadSkills(ws, () => {});
  expect(skill?.approvalGate).toBe("file-edits");
  let done: Promise<void> | undefined;
  let replError: unknown;
  done = runRepl({
    config: { apiKey: "sk-o9965", baseURL: "https://o9965.invalid/v1", model: "o9965-model" } satisfies ProviderConfig,
    workspaceRoot: ws,
    buildTools: () => gateTools(flag),
    contextWindowTokens: 200_000,
    sessionId: "wudao-o9965",
    skills: [skill!],
    stdin,
    stdout,
    // Determinism only: without this the loop's verify reflex injects "code
    // changes were made but nothing was run since" notes after the edits,
    // chaining extra (unscripted) model calls into the turn sequence.
    gates: { verify: false },
  });
  // The driver loop: poll output, fire steps in order, then /exit.
  void (async () => {
    try {
      let fed = 0;
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        drain();
        if (fed < steps.length && steps[fed]!.when(seen)) { feed(steps[fed]!.line); fed += 1; }
        if (fed >= steps.length && seen.includes("o9965-done")) break;
        await delay(10);
      }
      feed("/exit");
    } catch { /* the harness never fails the test here */ }
  })();
  const finish = async (): Promise<void> => {
    await Promise.race([done!.then(() => {}, (e: unknown) => { replError = e; }), delay(4_000)]);
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
/** How many `wudao> ` prompts have printed — the settle discipline: a prompt
 *  only prints after the previous turn fully settled, so "answer N printed
 *  AND prompt N+1 printed" is the deterministic feeding point. */
const prompts = (seen: string): number => seen.split("wudao> ").length - 1;

describe("ω99-65 — the file-edits approval gate on the REPL lane", () => {
  it("① armed: a receipt-less edit never silently passes — auto mode flips to the ask (headless = the non-TTY fail-closed deny)", async () => {
    const ws = await gateWorkspace();
    const lane = await driveRepl(ws, [
      answer("skill invoked"),
      toolRound("edit", "c1", { path: "src/a.ts" }),
      answer("stopped"),
    ], [
      { when: (s) => prompts(s) >= 1, line: "/skill:deslop" },
      // The invocation settled and the next prompt printed → the follow-up
      // turn whose model call issues the edit.
      { when: (s) => s.includes("skill invoked") && prompts(s) >= 2, line: "simplify src/a.ts" },
    ]);
    try {
      await until(() => lane.seen().includes("stopped"), "the denied edit's turn to settle");
      // RED pre-wiring: auto mode silently allowed the edit (runs 1≠0).
      expect(lane.runs()).toBe(0);
      expect(lane.seen()).toContain("审批门已布防（file-edits）"); // ω99-166b: 随源中文化（repl :1323，全角括号）。
      // The headless (non-TTY) lane asks fail-closed: the ask rendered, then
      // denied — the edit class NEVER silently passes while armed.
      expect(lane.seen()).toContain("正在拒绝 edit"); // ω99-158: 非交互拒随源中文化（原 denying edit）
    } finally {
      await lane.finish();
    }
  }, 30_000);

  it("② receipt: an `a` answer covers exactly that path+tool (same path runs clean, a sibling asks again)", async () => {
    const ws = await gateWorkspace();
    const lane = await driveRepl(ws, [
      answer("skill invoked"),
      toolRound("edit", "c1", { path: "src/a.ts" }),
      answer("edited a"),
      toolRound("edit", "c2", { path: "src/a.ts" }),
      answer("edited a again"),
      toolRound("edit", "c3", { path: "src/b.ts" }),
      answer("denied b"),
    ], [
      { when: (s) => prompts(s) >= 1, line: "/skill:deslop" },
      { when: (s) => s.includes("skill invoked") && prompts(s) >= 2, line: "simplify src/a.ts" },
      // The armed flip asks for the receipt-less edit; `a` = the session
      // receipt (same source as the pipeline's own session rule).
      { when: (s) => s.includes("🔑 允许 edit"), line: "a" },
      { when: (s) => s.includes("edited a") && prompts(s) >= 3, line: "same path again" },
      { when: (s) => s.includes("edited a again") && prompts(s) >= 4, line: "and the sibling" },
      { when: (s) => askCount(s) >= 2, line: "n" },
    ], { tty: true });
    try {
      await until(() => lane.seen().includes("denied b"), "the sibling turn to settle");
      // Exactly two asks: path A's first edit (answered `a`), then the
      // sibling's (answered `n`). The same-path re-edit asked ZERO times —
      // the receipt answers it (a second ask there = the gate's receipt
      // store drifting from the pipeline's session rule).
      expect(askCount(lane.seen())).toBe(2);
      expect(lane.runs()).toBe(2); // a.ts twice; b.ts denied, never ran
      expect(lane.seen()).toContain('permissions: session rule "edit:src/a.ts"');
    } finally {
      await lane.finish();
    }
  }, 30_000);

  it("③ /clear disarms: after the session boundary an edit passes under the normal gate again (no ask)", async () => {
    const ws = await gateWorkspace();
    const lane = await driveRepl(ws, [
      answer("skill invoked"),
      toolRound("edit", "c1", { path: "src/a.ts" }),
      answer("edited"),
      toolRound("edit", "c2", { path: "src/a.ts" }),
      answer("post-clear edit"),
    ], [
      { when: (s) => prompts(s) >= 1, line: "/skill:deslop" },
      { when: (s) => s.includes("skill invoked") && prompts(s) >= 2, line: "simplify src/a.ts" },
      { when: (s) => s.includes("🔑 允许 edit"), line: "a" },
      // The approved edit settled → the session boundary (confirm dialog,
      // then the wipe) → disarm → the fresh segment's prompt.
      { when: (s) => s.includes("edited") && prompts(s) >= 3, line: "/clear" },
      // ω99-159: 确认文案中文化——应答器 matcher 随源同步（对话语义不变：等确认框出现再答 y）。
      { when: (s) => s.includes("清空历史？"), line: "y" },
      { when: (s) => s.includes("审批门已解除 (/clear)") && prompts(s) >= 4, line: "edit once more" }, // ω99-166b: 应答器 matcher 随源中文化（repl :1330）。
    ], { tty: true });
    try {
      await until(() => lane.seen().includes("post-clear edit"), "the post-clear turn to settle");
      // Exactly ONE ask the whole session: the pre-clear edit. Post-clear
      // the posture is gone — the edit runs under the normal auto gate.
      expect(askCount(lane.seen())).toBe(1);
      expect(lane.runs()).toBe(2);
      expect(lane.seen()).toContain("审批门已解除 (/clear)"); // ω99-166b: 表外第三钉披露——同 :267 断源（repl :1330），repl 域内最小演进。
    } finally {
      await lane.finish();
    }
  }, 30_000);
});

describe("ω99-65 — one-shot lane: no skill-invocation seam exists (nothing to bypass)", () => {
  const src = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");
  const replSrc = (): string => src("../src/repl.ts");
  const driverSrc = (): string => src("../src/driver/agent-driver.ts");
  const oneShotSrc = (): string => src("../src/index.ts");

  it("the ONLY skill-invocation seams are the two gated lanes (repl.ts, agent-driver.ts) — one-shot expands no /skill: command", () => {
    // The one-shot path (runReal) expands only @mentions; it imports neither
    // the skill-message builder nor the slash-command parser — a `/skill:x`
    // one-shot prompt is a literal prompt, so the arming trigger cannot fire
    // there and nothing can bypass the gate by switching frontends.
    expect(oneShotSrc()).not.toContain("buildExpandedSkillMessage");
    expect(oneShotSrc()).not.toContain("parseReplCommand");
    // The two invocation seams that DO exist both arm the gate at the
    // invocation trigger (56 in the driver; ω99-65 in the REPL).
    expect(replSrc()).toContain("buildExpandedSkillMessage(");
    expect(replSrc()).toContain("armApprovalGate(skill)");
    expect(driverSrc()).toContain("buildExpandedSkillMessage(");
    expect(driverSrc()).toContain("armApprovalGate(skill)");
  });
});


