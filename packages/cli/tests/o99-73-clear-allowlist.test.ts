// ω99-73 — /clear ends the session allowlist. `a` answers cast session rules
// (permission.ts createSessionAllowlist) that survive /clear today: the wipe
// clears messages/persistBase/planBoard, rotates the model, disarms the
// approval gate ("a fresh session starts unarmed", ω99-65) and fires the
// session boundary hooks (M63-A) — but the finer-grained receipts (the
// session allow rules) outlive the boundary the coarser posture died at.
// These cases pin the corrected semantics on both lanes that own an
// allowlist lifecycle:
//   ① REPL (TTY harness, o99-65 shape): a static ask rule asks; `a` covers
//      the path (0 re-ask — the rule IS cast); /clear; the SAME path asks
//      again (exactly one new ask) and the tool still executes on `y`;
//   ② REPL `p` pin: an `always` answer lands in .wudao/settings.json, so the
//      same path stays silent AFTER /clear — clear() empties the in-memory
//      session set only, never the persistent tier;
//   ③ engine lane (driver session): the routed /clear clears the session
//      allowlist too (the onSessionCleared seam — the engine's mirror of the
//      REPL wipe; wudao ui + Slack record their `a` rules there).
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, realpathSync } from "node:fs";
import { PassThrough } from "node:stream";
import { runRepl } from "../src/repl.js";
import { createDriverSession } from "../src/driver/session-engine.js";
import type { DriverSession } from "../src/driver/session-engine.js";
import { createScriptedModel } from "@wudao/core";
import type { AgentMessage, ModelClient, ModelInput, Tool } from "@wudao/core";
import type { ProviderConfig } from "@wudao/providers";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 8_000): Promise<void> {
  const start = Date.now();
  await delay();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`o99-73: timed out waiting for ${what}`);
    await delay(10);
  }
}

/** Case ① workspace: .wudao/settings.json with permissions.ask ["edit"] —
 *  the layer BELOW the session allowlist, so the same-path edit asks whenever
 *  no session rule covers it (the deterministic ask driver). Case ② uses a
 *  bare workspace instead: the ask there is the builtin --ask mode, which a
 *  `p` answer's persistent allow legitimately outlives (a settings ask rule
 *  would SHADOW the allow — layer 4 beats 4.6 by design). */
async function askWorkspace(bare = false): Promise<string> {
  const ws = await realpath(await mkdtemp(join(tmpdir(), "o9973-ws-")));
  if (bare) return ws;
  await mkdir(join(ws, ".wudao"), { recursive: true });
  await writeFile(join(ws, ".wudao", "settings.json"), JSON.stringify({ permissions: { ask: ["edit"] } }), "utf8");
  return ws;
}

/** read + edit tools — the edit's run flag is the "eventually executable"
 *  observer. read is required so the loop has a read-class tool available. */
function askTools(flag: { runs: number }): Tool[] {
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
    execute: async () => {
      flag.runs += 1;
      return { content: "edited" };
    },
  };
  return [read, edit];
}

// The SSE frame builder the existing REPL suites use (o99-65 shape).
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

/** Runs the REPL over a scripted model + step-fed lines (the o99-65 harness
 *  shape; TTY on — the ask menu fails closed without it). `mode` picks the
 *  builtin ask driver: --auto (default) or --ask. A step's optional
 *  `settleMs` parks the feed that long AFTER its `when` holds (case ②'s
 *  settings-write reload wait — the watcher re-stats at most once per second,
 *  so the persistent allow only becomes gate-visible after the window). */
async function driveRepl(
  ws: string,
  script: readonly (readonly unknown[])[],
  steps: readonly { readonly when: (seen: string) => boolean; readonly line: string; readonly settleMs?: number }[],
  opts?: { readonly mode?: "--auto" | "--ask" },
): Promise<Lane> {
  const stdin = new PassThrough();
  (stdin as unknown as { isTTY: boolean }).isTTY = true;
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
  const globalHome = await mkdtemp(join(tmpdir(), "o9973-gh-"));
  const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
  const prevArgv = process.argv;
  process.env.WUDAO_GLOBAL_HOME = globalHome;
  process.argv = [prevArgv[0]!, "wudao", opts?.mode ?? "--auto"];
  const flag = { runs: 0 };
  let done: Promise<void> | undefined;
  let replError: unknown;
  done = runRepl({
    config: { apiKey: "sk-o9973", baseURL: "https://o9973.invalid/v1", model: "o9973-model" } satisfies ProviderConfig,
    workspaceRoot: ws,
    buildTools: () => askTools(flag),
    contextWindowTokens: 200_000,
    sessionId: "wudao-o9973",
    stdin,
    stdout,
    // Determinism only (o99-65's note): without this the verify reflex chains
    // extra unscripted model calls after the edits.
    gates: { verify: false },
  });
  void (async () => {
    try {
      let fed = 0;
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        drain();
        if (fed < steps.length && steps[fed]!.when(seen)) {
          const step = steps[fed]!;
          fed += 1;
          if (step.settleMs !== undefined) await delay(step.settleMs);
          feed(step.line);
        }
        if (fed >= steps.length && seen.includes("o9973-done")) break;
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
const prompts = (seen: string): number => seen.split("wudao> ").length - 1;

describe("ω99-73 — /clear ends the session allowlist (REPL lane)", () => {
  it("① `a` covers the path; after /clear the SAME path asks again (exactly one new ask) and executes", async () => {
    const ws = await askWorkspace();
    const lane = await driveRepl(ws, [
      // turn 1 — the ask fires (static ask rule), answered `a` (session rule).
      toolRound("edit", "c1", { path: "src/a.ts" }),
      answer("turn one done"),
      // turn 2 — the same path: covered by the session rule, 0 asks.
      toolRound("edit", "c2", { path: "src/a.ts" }),
      answer("turn two done"),
      // turn 3 (post-clear) — the rule died with the boundary: the SAME path
      // asks again; answered `y` the edit still executes.
      toolRound("edit", "c3", { path: "src/a.ts" }),
      answer("turn three done"),
    ], [
      { when: (s) => prompts(s) >= 1, line: "first edit" },
      { when: (s) => s.includes("🔑 允许 edit"), line: "a" },
      { when: (s) => s.includes("turn one done") && prompts(s) >= 2, line: "same path again" },
      { when: (s) => s.includes("turn two done") && prompts(s) >= 3, line: "/clear" },
      // ω99-159: 确认文案中文化——应答器 matcher 随源同步（等确认框出现再答 y 的语义不变）。
      { when: (s) => s.includes("清空历史？"), line: "y" },
      // ω99-161: 应答器 matcher 随源演进（等回执出现再续拍的语义不变）。
      { when: (s) => s.includes("(历史已清空)") && prompts(s) >= 4, line: "same path once more" },
      { when: (s) => askCount(s) >= 2, line: "y" },
    ]);
    try {
      await until(() => lane.seen().includes("turn three done"), "the post-clear turn to settle");
      // The `a` receipt really landed (pins that turn two's silence was the
      // session rule, not a dead harness — o99-73 §3.2).
      expect(lane.seen()).toContain('permissions: session rule "edit:src/a.ts"');
      expect(lane.seen()).toContain("(历史已清空)"); // ω99-161: 回执串随源演进。
      // Exactly TWO asks: the first edit, and — post-clear — the SAME path
      // again. Turn two asked zero times. On base this is 1 (the rule
      // survived the boundary): the RED.
      expect(askCount(lane.seen())).toBe(2);
      // The re-ask is genuinely POST-clear (ordering, not just counts).
      const cleared = lane.seen().indexOf("(历史已清空)"); // ω99-161: 排序钉随源演进。
      const secondAsk = lane.seen().indexOf("🔑 允许 edit", lane.seen().indexOf("🔑 允许 edit") + 1);
      expect(secondAsk).toBeGreaterThan(cleared);
      // `y` still means allow-once — the edit executes (eventually runnable).
      expect(lane.runs()).toBe(3);
    } finally {
      await lane.finish();
    }
  }, 60_000);

  it("② `p` is untouched: the always-rule lives in settings.json and outlives /clear (no re-ask)", async () => {
    // Bare workspace + --ask: the ask is the BUILTIN mode, so the `p`
    // answer's persistent allow (layer 4.6) legitimately beats it after the
    // reload — the one `p` shape where "post-clear still silent" is the
    // designed semantics (a settings ask rule would shadow the allow).
    const ws = await askWorkspace(true);
    const lane = await driveRepl(ws, [
      toolRound("edit", "c1", { path: "src/a.ts" }),
      answer("turn one done"),
      toolRound("edit", "c2", { path: "src/a.ts" }),
      answer("turn two done"),
    ], [
      { when: (s) => prompts(s) >= 1, line: "first edit" },
      { when: (s) => s.includes("🔑 允许 edit"), line: "p" },
      // Gate on the persistent receipt (the settings write landed), then let
      // the watcher's 1s re-stat window pass BEFORE the boundary — the
      // post-clear gate read must see the fresh allow deterministically.
      { when: (s) => s.includes("permissions: added allow rule") && prompts(s) >= 2, line: "/clear", settleMs: 1_500 },
      // ω99-159: 确认文案中文化——应答器 matcher 随源同步（等确认框出现再答 y 的语义不变）。
      { when: (s) => s.includes("清空历史？"), line: "y" },
      // ω99-161: 应答器 matcher 随源演进（等回执出现再续拍的语义不变）。
      { when: (s) => s.includes("(历史已清空)") && prompts(s) >= 3, line: "same path once more" },
    ], { mode: "--ask" });
    try {
      await until(() => lane.seen().includes("turn two done"), "the post-clear turn to settle");
      // ONE ask the whole session (the first edit, answered `p`). The same
      // path stays silent AFTER /clear — clear() empties the in-memory
      // session set only, never the persistent tier (holds on base AND
      // fixed).
      expect(askCount(lane.seen())).toBe(1);
      expect(lane.runs()).toBe(2);
      // The persistent tier itself is untouched by the wipe: the rule the
      // `p` answer wrote is still in .wudao/settings.json after /clear.
      const settings = JSON.parse(await readFile(join(ws, ".wudao", "settings.json"), "utf8")) as { permissions?: { allow?: string[] } };
      expect(settings.permissions?.allow).toContain("edit:src/a.ts");
    } finally {
      await lane.finish();
    }
  }, 60_000);
});

describe("ω99-73 — the routed /clear clears the engine session allowlist (driver lane)", () => {
  const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };
  const sessions: DriverSession[] = [];
  const roots: string[] = [];
  afterEach(async () => {
    for (const s of sessions.splice(0)) await s.close();
    for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  });

  it("submit(\"/clear\") empties session.allowlist (rules() pins the wipe; matches stays cold)", async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), "o9973-eng-")));
    roots.push(ws);
    const model: ModelClient = (() => {
      const inner = createScriptedModel([{ role: "assistant", content: "ok" } as AgentMessage]);
      return { generate: (input: ModelInput) => inner.generate(input) };
    })();
    const session = await createDriverSession({
      config,
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      modelOverride: model,
      tools: [],
      sessionId: "wudao-o9973-eng",
    });
    sessions.push(session);
    // The exact rule an `a` answer on edit:src/a.ts casts (askRuleFor shape);
    // recorded through the same store the engine's askRelay/answerPermission
    // record into (session.allowlist — DriverSession's documented seam).
    session.allowlist.add("edit:src/a.ts");
    expect(session.allowlist.rules()).toEqual(["edit:src/a.ts"]);
    expect(session.allowlist.matches("edit", { path: "src/a.ts" })).toBe(true);
    // The routed /clear (the arm wudao ui / Slack ride — client.submit("/clear")
    // → routedSubmit case "clear"): the wipe must reach the allowlist too.
    expect(session.driver.submit("/clear")).toBe("cleared");
    expect(session.allowlist.rules()).toEqual([]);
    expect(session.allowlist.matches("edit", { path: "src/a.ts" })).toBe(false);
  }, 60_000);
});
