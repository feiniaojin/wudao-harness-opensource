// ω99-34 — /clear 轮换后首调 turn-0 假断裂（campaign /tmp/o33-campaign.log:1709:
// `⚠️ cache break at user message (turn 0) — miss 6.7k/13.1k (51.3%)`）。
// REPL /clear（ω99-32 的 M80 轮换）之后，缓存 wrapper 的 prevSerialized 仍持有
// pre-clear 请求：新会话首调（小前缀，且首条 user 消息之后跟着 note 投影的降级
// user 消息 → length > 1 → ω99-28 T3 的 length===1 冷启动档够不着）对比旧会话
// 尾部请求 → 自伤边界被误报为断裂。本弧交付 rotate()（轮换 reset + ℹ️ 命名档）：
//   ⓪ 未治疗形状（不调 rotate）仍报 ⚠️ turn-0 —— 钉住 wrapper 层无法自知、
//      必须由前端在轮换事件上通知的危害（改前基线，改后仍是事实）；
//   ① rotate 后首 observe 恰一行 ℹ️ expected: session-rotation、零 ⚠️；
//   ② 无 miss（小首调）则零输出；
//   ③ stats 总会账跨轮换连续（红线：轮换不清零累计）；
//   ④ side 链不消费轮换一次性档（ω99-31 红线）；
//   ⑤ 轮换把窗口身份移交给下一主行的合成 advance（Review I1 同机制）。
import { describe, it, expect } from "vitest";
import type { AgentMessage, ModelClient, ModelInput, ModelUsage } from "@wudao-org/core";
import { createCacheTrackingModel, type WindowAdvance } from "../src/cache.js";

function fakeModel(usages: readonly ModelUsage[]): { model: ModelClient; inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    model: {
      async generate(input: ModelInput) {
        inputs.push(input);
        const usage = usages[i];
        i += 1;
        if (usage) input.onUsage?.(usage);
        return { role: "assistant", content: `answer-${i}` };
      },
    },
  };
}

const U = (promptTokens: number, hit: number): ModelUsage =>
  ({ promptTokens, cacheHitTokens: hit, cacheMissTokens: promptTokens - hit });

// The campaign shape: the pre-clear conversation (A) with a settled miss
// baseline, then the FRESH session's first request (B) — its opening user
// message plus the session-start note's degraded trailing user message
// (loop.ts projectNotes: no tool_result post-clear → a second user message),
// paying a >4k miss.
const A: AgentMessage[] = [
  { role: "user", content: "run the harbor-tide campaign" },
  { role: "assistant", content: "answer-1" },
  { role: "user", content: "advance to the next task" },
];
const B: AgentMessage[] = [
  { role: "user", content: "second round" },
  { role: "user", content: "<system_note> You have superpowers. </system_note>" },
];
const generate = async (tracked: ReturnType<typeof createCacheTrackingModel>, messages: readonly AgentMessage[], querySource?: string): Promise<void> => {
  await tracked.generate({ systemPrompt: "sys", tools: [], messages, ...(querySource !== undefined ? { querySource } : {}) });
};

describe("ω99-34 T1 — wrapper rotation: the turn-0 false break", () => {
  it("⓪ untreated (no rotate): the post-/clear pair still misreads ⚠️ turn-0 (the campaign :1709 shape)", async () => {
    const { model } = fakeModel([
      U(13000, 12900), // A — miss 100 (the settled baseline)
      U(13100, 6400), // B — miss 6700 (51.1%): spike vs [100] and > 4k
    ]);
    const breaks: string[] = [];
    const tracked = createCacheTrackingModel(model, { onBreak: (w) => breaks.push(w) });
    await generate(tracked, A);
    await generate(tracked, B);
    // The wrapper cannot know a rotation happened — the untreated cross-session
    // pair reads as a break at the new session's opening user message. This is
    // the hazard the frontends close by calling rotate() at the rotation event.
    expect(breaks).toEqual(["⚠️ cache break at user message (turn 0) — miss 6.7k/13.1k (51.1%)"]);
  });

  it("① rotate() → the first observe reports exactly ONE ℹ️ session-rotation line, zero ⚠️", async () => {
    const { model } = fakeModel([
      U(13000, 12900),
      U(13100, 6400),
    ]);
    const breaks: string[] = [];
    const tracked = createCacheTrackingModel(model, { onBreak: (w) => breaks.push(w) });
    await generate(tracked, A);
    tracked.rotate();
    await generate(tracked, B);
    expect(breaks).toEqual(["ℹ️ expected: session-rotation (cold start) — miss 6.7k/13.1k (51.1%)"]);
  });

  it("② rotate() → a small first miss stays silent (无 miss 则零输出)", async () => {
    const { model } = fakeModel([
      U(13000, 12900),
      U(600, 550), // a tiny fresh session paid nothing worth naming
    ]);
    const breaks: string[] = [];
    const tracked = createCacheTrackingModel(model, { onBreak: (w) => breaks.push(w) });
    await generate(tracked, A);
    tracked.rotate();
    await generate(tracked, B);
    expect(breaks).toEqual([]);
  });

  it("③ stats stay cumulative across the rotation (轮换不清零总会账)", async () => {
    const { model } = fakeModel([
      U(13000, 12900),
      U(13100, 6400),
    ]);
    const tracked = createCacheTrackingModel(model, {});
    await generate(tracked, A);
    tracked.rotate();
    await generate(tracked, B);
    // hit 12900+6400 = 19.3k, miss 100+6700 = 6.8k over BOTH calls — the
    // campaign's top summary line kept accounting across /clear; so must we.
    expect(tracked.stats.summaryLine()).toBe("缓存：73.9%（命中 19.3k / 未命中 6.8k，2 次模型调用）"); // ω99-188: 钉随源演进（census 兜出）
  });

  it("④ side rows never consume the rotation one-shot (ω99-31 red line)", async () => {
    const { model } = fakeModel([
      U(13000, 12900), // main A
      U(9000, 100), // side (subagent) first call — big miss, but a SIDE row
      U(13100, 6400), // main B — the rotation's first MAIN row
    ]);
    const breaks: string[] = [];
    const sources: (string | undefined)[] = [];
    const tracked = createCacheTrackingModel(model, {
      onBreak: (w) => breaks.push(w),
      onUsage: (_u, _s, _w, src) => sources.push(src),
    });
    await generate(tracked, A);
    tracked.rotate();
    await generate(tracked, B, "subagent");
    expect(breaks).toEqual([]); // the side row neither reports nor consumes
    await generate(tracked, B);
    expect(breaks).toEqual(["ℹ️ expected: session-rotation (cold start) — miss 6.7k/13.1k (51.1%)"]);
    expect(sources).toEqual([undefined, "subagent", undefined]); // usage ledger intact
    expect(tracked.stats.summaryLine()).toContain("3 次模型调用"); // ω99-188: 钉随源演进（census 兜出）
  });

  it("⑤ rotate() hands the window identity to a synthetic advance on the next MAIN row", async () => {
    const { model } = fakeModel([
      U(13000, 12900),
      U(13100, 6400),
      U(15000, 14700), // C — append-only growth on the new session
    ]);
    const advances: WindowAdvance[] = [];
    const tracked = createCacheTrackingModel(model, { onWindowAdvance: (info) => advances.push(info) });
    await generate(tracked, A);
    expect(advances).toEqual([]); // the initial mint is silent
    const preRotate = tracked.currentWindowId();
    tracked.rotate();
    const postRotate = tracked.currentWindowId();
    expect(postRotate).not.toBe(preRotate);
    await generate(tracked, B);
    // The successor reports its predecessor ONCE — the Review I1 mintedFrom
    // path, no divergedAt (a rotation has no divergent line to name).
    expect(advances).toHaveLength(1);
    expect(advances[0]!.from).toBe(preRotate);
    expect(advances[0]!.to).toBe(postRotate);
    expect(advances[0]!.divergedAt).toBeUndefined();
    expect(advances[0]!.firstCall?.promptTokens).toBe(13100);
    await generate(tracked, [...B, { role: "assistant", content: "answer-2" }, { role: "user", content: "more" }]);
    expect(advances).toHaveLength(1); // append-only growth never advances
  });
});

// ---------------------------------------------------------------------------
// REPL integration (o99-32's driveRepl harness + a session-start hook that
// queues the note the campaign rode — the loop projects it as a degraded
// trailing USER message post-clear, so the fresh session's first request is
// [user, user-note] and the ω99-28 T3 length===1 carve-out cannot fire).
// ---------------------------------------------------------------------------

import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runRepl } from "../src/repl.js";
import type { ProviderConfig } from "@wudao-org/providers";

const delay = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const enc = new TextEncoder();
const sse = (frames: readonly unknown[]): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({
  start(c) {
    for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
    c.enqueue(enc.encode("data: [DONE]\n\n"));
    c.close();
  },
});

/** `answer(text)` with a crafted cache row: hit rides
 *  prompt_tokens_details.cached_tokens (openai-compatible's mapping). */
const answerUsage = (text: string, promptTokens: number, cached: number): readonly unknown[] => [
  { id: "a", choices: [{ index: 0, delta: { content: text } }] },
  { id: "a", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: 5, prompt_tokens_details: { cached_tokens: cached } } },
];

async function driveRepl(o: {
  readonly ws: string;
  readonly sid: string;
  readonly lines: readonly string[];
  readonly script: readonly (readonly unknown[])[];
}): Promise<string> {
  const globalHome = await mkdtemp(join(tmpdir(), "o9934-gh-"));
  const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
  const prevFetch = globalThis.fetch;
  const prevArgv = process.argv;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  process.argv = [prevArgv[0]!, "wudao", "--auto"];
  let calls = 0;
  globalThis.fetch = (async () => {
    const frames = o.script[calls] ?? answerUsage("ok", 600, 550);
    calls += 1;
    return new Response(sse(frames), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  let seen = "";
  let fed = 0;
  const drain = (): string => { let t = ""; let c = stdout.read(); while (c !== null) { t += c.toString(); c = stdout.read(); } return t; };
  const pump = (): void => {
    seen += drain();
    const prompts = seen.split("wudao> ").length - 1;
    while (fed < o.lines.length && fed < prompts) { stdin.write(`${o.lines[fed]}\n`); fed += 1; }
  };
  let replError: unknown;
  let done: Promise<void> | undefined;
  try {
    done = runRepl({
      config: { apiKey: "sk-o9934", baseURL: "https://o9934.invalid/v1", model: "o9934-model" } satisfies ProviderConfig,
      workspaceRoot: o.ws,
      buildTools: () => [],
      contextWindowTokens: 200_000,
      sessionId: o.sid,
      stdin,
      stdout,
      // The campaign's post-clear first request rode the session-start note
      // (the superpowers reminder) as a SECOND user message — reproduce it.
      hooks: { onSessionStart: async () => "You have superpowers. Below is the full content of your skills." },
    });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) { pump(); if (fed >= o.lines.length) break; await delay(10); }
    await Promise.race([done!, delay(5_000)]);
  } catch (err) {
    replError = err;
  } finally {
    stdin.end();
    if (done !== undefined) await Promise.race([done.then(() => {}, () => {}), delay(500)]);
    process.argv = prevArgv;
    process.env.WUDAO_GLOBAL_HOME = prevGlobal;
    globalThis.fetch = prevFetch;
    await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  if (replError !== undefined) throw replError;
  return seen;
}

describe("ω99-34 T2 — REPL integration: /clear → first call names the rotation, not a break", () => {
  it("① /clear → the fresh session's first call prints ONE ℹ️ session-rotation line and no ⚠️", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "o9934-rot-")));
    const SID = "wudao-o9934rot";
    try {
      const seen = await driveRepl({
        ws,
        sid: SID,
        lines: ["first round", "/clear", "second round", "/exit"],
        script: [
          answerUsage("first done", 13100, 12900), // miss 200 — the settled baseline
          answerUsage("second done", 13100, 6400), // miss 6700 — the rotation cold start
        ],
      });
      expect(seen).toContain("(历史已清空)"); // ω99-161: 回执串随源演进（在场语义不变）。
      // RED pre-fix: `⚠️ cache break at user message (turn 0) — miss 6.7k/13.1k (51.1%)`
      expect(seen).not.toContain("⚠️ cache break");
      // Exactly one named tier, carrying the ω99-28 T2 cost tier on the SAME line.
      expect(seen.match(/ℹ️ expected: session-rotation \(cold start\)/g)).toHaveLength(1);
      expect(seen).toContain("ℹ️ expected: session-rotation (cold start) — miss 6.7k/13.1k (51.1%)");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);

  it("② a tiny post-clear first call stays silent (the ℹ️ has a miss floor)", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "o9934-quiet-")));
    const SID = "wudao-o9934quiet";
    try {
      const seen = await driveRepl({
        ws,
        sid: SID,
        lines: ["first round", "/clear", "second round", "/exit"],
        script: [
          answerUsage("first done", 13100, 12900),
          answerUsage("second done", 600, 550), // a small fresh session: nothing worth naming
        ],
      });
      expect(seen).toContain("(历史已清空)"); // ω99-161: 回执串随源演进（在场语义不变）。
      expect(seen).not.toContain("⚠️ cache break");
      expect(seen).not.toContain("session-rotation");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// ω99-34 T2 — driver path verification (the engine's onSessionCleared seam).
// The engine's wrapper is ONE instance for the whole session lifetime (the
// /provider rebuild is the only replacement seam), so it carries the SAME
// pre-clear diff state across a routed /clear as the REPL's did — 同病. The
// seam now calls the SAME rotate() API; the observable here is the window
// receipt: the post-clear run's advance must be the rotation's SYNTHETIC
// hand-off (advancedFrom, no divergedAt), not the untreated "message:user"
// divergence the stale windowBase diff used to fire.
// ---------------------------------------------------------------------------

import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { createDriverSession, type DriverSession } from "../src/driver/session-engine.js";

async function untilEngine(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  await delay();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`o99-34 driver: timed out waiting for ${what}`);
    await delay(10);
  }
}

/** A scripted model whose every call reports one settled usage row (miss
 *  100 — the wrapper observes it, which is what fires window receipts). */
function usageModel(): ModelClient {
  return {
    async generate(input: ModelInput) {
      input.onUsage?.({ promptTokens: 13000, cacheHitTokens: 12900, cacheMissTokens: 100, completionTokens: 5 });
      return { role: "assistant", content: "ok" };
    },
  };
}

describe("ω99-34 T2 — driver path: the engine's /clear rotates the SAME wrapper", () => {
  it("a routed /clear resets the wrapper — the next run's window receipt is the rotation's synthetic advance", async () => {
    const ws = mkdtempSync(join(tmpdir(), "o9934-drv-"));
    const SID = "wudao-o9934drv";
    let session: DriverSession | undefined;
    try {
      session = await createDriverSession({
        config: { apiKey: "sk-o9934", baseURL: "http://127.0.0.1:1/v1", model: "o9934-model" } satisfies ProviderConfig,
        workspaceRoot: ws,
        contextWindowTokens: 64_000,
        tools: [],
        sessionId: SID,
        noPeer: true,
        modelOverride: usageModel(),
      });
      const driver = session.driver;
      driver.submit("first round");
      await untilEngine(() => driver.getStatus().busy === false, "run 1 settles");
      // The routed /clear (agent-driver's M80 case → engine onSessionCleared).
      driver.submit("/clear");
      let nextSid = "";
      await untilEngine(() => { nextSid = driver.getSessionId(); return nextSid !== SID; }, "session id rotates");
      driver.submit("second round");
      await untilEngine(() => driver.getStatus().busy === false, "run 2 settles");
      // The rotation's advance lands on the NEW segment's JSONL (async append).
      const file = join(ws, ".wudao", "sessions", `${nextSid}.jsonl`);
      await untilEngine(() => existsSync(file) && readFileSync(file, "utf8").includes("context_window"), "the rotation's context_window entry");
      type Entry = { readonly type: string; readonly data: { readonly id?: string; readonly advancedFrom?: string; readonly divergedAt?: string; readonly nextSessionId?: string } };
      const entries = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as Entry).filter((e) => e.type === "context_window");
      // RED pre-wiring: the stale windowBase diff fired the advance WITH
      // divergedAt "message:user" — the mislabeled rotation receipt.
      expect(entries).toHaveLength(1);
      expect(entries[0]!.data.advancedFrom).toMatch(/^[0-9a-f-]{36}$/);
      expect(entries[0]!.data.divergedAt).toBeUndefined(); // synthetic: a rotation has no divergent line
      // Seam evidence: the routed clear went through the engine (the old
      // segment is sealed by a boundary naming the fresh id).
      const oldFile = join(ws, ".wudao", "sessions", `${SID}.jsonl`);
      const sealed = readFileSync(oldFile, "utf8").split("\n").filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as Entry).filter((e) => e.type === "clear_boundary");
      expect(sealed).toHaveLength(1);
      expect(sealed[0]!.data.nextSessionId).toBe(nextSid);
    } finally {
      if (session !== undefined) await session.close();
      for (let i = 0; i < 10; i += 1) {
        try { rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); break; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e; await delay(50); }
      }
    }
  }, 30_000);
});
