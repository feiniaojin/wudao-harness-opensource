import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

// 0.3.85 门 #6 教训：本文件全是 REPL 子进程车道（spawn CLI + 喂 stdin +
// cron 注入定时器面），单跑全文件 3.5s，但门级负载下 cron 注入用例一次
// 跨过全局 20s（10× 拉伸）。文件级 60s 给足余量；真挂仍然会红。
vi.setConfig({ testTimeout: 60_000 });
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { parseReplCommand, formatResumeLine, createProgrammaticSubmitGate, createTurnSerializer, runRepl } from "../src/repl.js";
import { VERSION } from "../src/version.js";
import type { AgentMessage } from "@wudao-org/core";
import type { ProviderConfig } from "@wudao-org/providers";

const replSrc = (): string =>
  readFileSync(fileURLToPath(new URL("../src/repl.ts", import.meta.url)), "utf8");

describe("parseReplCommand", () => {
  it("empty → noop", () => { expect(parseReplCommand("   ")).toEqual({ kind: "noop" }); });
  it("/exit → exit", () => { expect(parseReplCommand("/exit")).toEqual({ kind: "exit" }); });
  it("/quit → exit", () => { expect(parseReplCommand("/quit")).toEqual({ kind: "exit" }); });
  it("/clear → clear", () => { expect(parseReplCommand("/clear")).toEqual({ kind: "clear" }); });
  it("/help → help", () => { expect(parseReplCommand("/help")).toEqual({ kind: "help" }); });
  it("text → prompt", () => { expect(parseReplCommand("hello world")).toEqual({ kind: "prompt", text: "hello world" }); });
  it("preserves leading/trailing spaces in prompt text", () => {
    expect(parseReplCommand("  hello  ")).toEqual({ kind: "prompt", text: "  hello  " });
  });

  // M27: /skill:name [args] — name up to the first whitespace, rest = args.
  it("/skill:name args → skill", () => {
    expect(parseReplCommand("/skill:commit-msg fix the login bug")).toEqual({ kind: "skill", name: "commit-msg", args: "fix the login bug" });
  });
  it("/skill:name with no args → empty args", () => {
    expect(parseReplCommand("/skill:alpha")).toEqual({ kind: "skill", name: "alpha", args: "" });
  });
  it("bare /skill and /skill: → empty name (runtime lists available skills)", () => {
    expect(parseReplCommand("/skill")).toEqual({ kind: "skill", name: "", args: "" });
    expect(parseReplCommand("/skill:")).toEqual({ kind: "skill", name: "", args: "" });
  });
  it("args collapse surrounding whitespace but keep inner spacing", () => {
    expect(parseReplCommand("/skill:x   a  b   ")).toEqual({ kind: "skill", name: "x", args: "a  b" });
  });
  it("trailing whitespace after the name → empty args", () => {
    expect(parseReplCommand("/skill:alpha   ")).toEqual({ kind: "skill", name: "alpha", args: "" });
  });
  it("/skills (no colon) and /skillx stay plain prompts", () => {
    expect(parseReplCommand("/skills")).toEqual({ kind: "prompt", text: "/skills" });
    expect(parseReplCommand("/skillful day")).toEqual({ kind: "prompt", text: "/skillful day" });
  });

  // M33 §3: /resume — the TUI opens its session picker; the readline REPL has
  // no store-driven picker, so its runtime answers with guidance instead.
  it("/compact → compact (M52; bare form unchanged)", () => { expect(parseReplCommand("/compact")).toEqual({ kind: "compact" }); });
  it("/compact focus <query> → compact with the rest-of-line focus (M58 §C#2)", () => {
    expect(parseReplCommand("/compact focus on the auth refactor")).toEqual({ kind: "compact", focus: "on the auth refactor" });
    expect(parseReplCommand("  /compact focus   spaced   query  ")).toEqual({ kind: "compact", focus: "spaced   query" });
  });
  it("/compact focus with no query, and unknown suffixes, stay today's shapes", () => {
    expect(parseReplCommand("/compact focus")).toEqual({ kind: "compact" });
    expect(parseReplCommand("/compact focus   ")).toEqual({ kind: "compact" });
    // Unknown args were never commands — still plain prompts.
    expect(parseReplCommand("/compact everything now")).toEqual({ kind: "prompt", text: "/compact everything now" });
    expect(parseReplCommand("/compaction")).toEqual({ kind: "prompt", text: "/compaction" });
  });
  it("/resume → resume", () => { expect(parseReplCommand("/resume")).toEqual({ kind: "resume" }); });
  it("/resume with trailing text still routes to resume (args ignored)", () => {
    expect(parseReplCommand("/resume 3")).toEqual({ kind: "resume" });
  });
  // P0-4 (96 队列): /cost grows a scope — bare keeps the session view
  // byte-identical; `all` widens to the cross-session ledger + wallet balance.
  it("/cost → cost (no scope); /cost all → cost scope all", () => {
    expect(parseReplCommand("/cost")).toEqual({ kind: "cost" });
    expect(parseReplCommand("/cost all")).toEqual({ kind: "cost", scope: "all" });
  });
  it("/cost with any other suffix (and /costx) stays a plain prompt", () => {
    expect(parseReplCommand("/cost extra")).toEqual({ kind: "prompt", text: "/cost extra" });
    expect(parseReplCommand("/cost  all ")).toEqual({ kind: "prompt", text: "/cost  all " });
    expect(parseReplCommand("/costall")).toEqual({ kind: "prompt", text: "/costall" });
  });
  it("/resumepoint and /res stay plain prompts", () => {
    expect(parseReplCommand("/resumepoint")).toEqual({ kind: "prompt", text: "/resumepoint" });
    expect(parseReplCommand("/res now")).toEqual({ kind: "prompt", text: "/res now" });
  });

  // M36: plugin slash commands — routed ONLY when the name is in the provided
  // list (unknown /word lines keep going to the model as plain prompts).
  it("/<plugin-cmd> args → pluginCommand when the name is registered", () => {
    expect(parseReplCommand("/hello world", ["hello"])).toEqual({ kind: "pluginCommand", name: "hello", args: "world" });
    expect(parseReplCommand("/deploy", ["deploy"])).toEqual({ kind: "pluginCommand", name: "deploy", args: "" });
    expect(parseReplCommand("/hello   a  b ", ["hello"])).toEqual({ kind: "pluginCommand", name: "hello", args: "a  b" });
  });
  it("an unregistered /word stays a plain prompt, even with the list present", () => {
    expect(parseReplCommand("/hello world", ["other"])).toEqual({ kind: "prompt", text: "/hello world" });
    expect(parseReplCommand("/hello world", [])).toEqual({ kind: "prompt", text: "/hello world" });
  });
  it("builtins win over a registered plugin command of the same name", () => {
    // "/help extra" was never the builtin help (exact match only) — and it
    // must not become a plugin command either: builtin names never route to
    // plugins, so the legacy plain-prompt behavior stands.
    expect(parseReplCommand("/help extra", ["help"])).toEqual({ kind: "prompt", text: "/help extra" });
    expect(parseReplCommand("/help", ["help"])).toEqual({ kind: "help" });
    expect(parseReplCommand("/skill:x", ["skill"])).toEqual({ kind: "skill", name: "x", args: "" });
    expect(parseReplCommand("/exit", ["exit"])).toEqual({ kind: "exit" });
  });
  it("prompt-looking lines never become plugin commands", () => {
    expect(parseReplCommand("run /hello world", ["hello"])).toEqual({ kind: "prompt", text: "run /hello world" });
  });

  // M39: extension slash commands — same routing rule as plugins, checked
  // AFTER them (builtin > plugin > extension).
  it("/<ext-cmd> args → extensionCommand when the name is registered", () => {
    expect(parseReplCommand("/ext-hello world", [], ["ext-hello"])).toEqual({ kind: "extensionCommand", name: "ext-hello", args: "world" });
    expect(parseReplCommand("/ext-deploy", [], ["ext-deploy"])).toEqual({ kind: "extensionCommand", name: "ext-deploy", args: "" });
    expect(parseReplCommand("/ext-hello   a  b ", [], ["ext-hello"])).toEqual({ kind: "extensionCommand", name: "ext-hello", args: "a  b" });
  });
  it("an unregistered /word stays a plain prompt even with extension names present", () => {
    expect(parseReplCommand("/ext-hello world", [], ["other"])).toEqual({ kind: "prompt", text: "/ext-hello world" });
    expect(parseReplCommand("/ext-hello world", [], [])).toEqual({ kind: "prompt", text: "/ext-hello world" });
  });
  it("builtins and plugin commands win over an extension command of the same name", () => {
    expect(parseReplCommand("/help", [], ["help"])).toEqual({ kind: "help" });
    expect(parseReplCommand("/skill:x", [], ["skill"])).toEqual({ kind: "skill", name: "x", args: "" });
    expect(parseReplCommand("/shared", ["shared"], ["shared"])).toEqual({ kind: "pluginCommand", name: "shared", args: "" });
  });
});

describe("VERSION (REPL header)", () => {
  it("is a semver string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// ---------------------------------------------------------------------------
// M25 §A2: REPL startup resume line (one line, no full replay)
// ---------------------------------------------------------------------------

describe("formatResumeLine", () => {
  const u = (content: string): AgentMessage => ({ role: "user", content });
  const a = (content: string): AgentMessage => ({ role: "assistant", content });

  it("composes: resumed <id> (N messages; last: <last-assistant first 60 chars>)", () => {
    const messages = [u("hi"), a("short answer")];
    expect(formatResumeLine("wudao-m1-abcd1234", messages)).toBe(
      "已恢复 wudao-m1-abcd1234（2 条消息；最近：short answer）", // ω99-172: 钉随源演进
    );
  });

  it("uses the LAST assistant message even when tool turns follow", () => {
    const messages: AgentMessage[] = [
      u("first"),
      a("early answer"),
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: {} }] },
      { role: "tool", toolCallId: "c1", name: "read_file", content: "r" },
      a("final answer"),
    ];
    expect(formatResumeLine("s1", messages)).toBe("已恢复 s1（5 条消息；最近：final answer）"); // ω99-172: 钉随源演进
  });

  it("truncates the last assistant to 60 chars (single line, ellipsis)", () => {
    const long = "x".repeat(100);
    const line = formatResumeLine("s1", [u("q"), a(long)]);
    expect(line).toBe(`已恢复 s1（2 条消息；最近：${"x".repeat(60)}…）`); // ω99-172: 钉随源演进（漏判钉——brief §二未列，读值同源）
  });

  it("collapses newlines so the summary stays one line", () => {
    const line = formatResumeLine("s1", [u("q"), a("line one\nline two\nline three and more text past the limit")]);
    expect(line).not.toContain("\n");
    expect(line.startsWith("已恢复 s1（2 条消息；最近：line one line two")).toBe(true); // ω99-172: 钉随源演进（漏判钉）
  });

  it("no assistant in history → last: …", () => {
    expect(formatResumeLine("s1", [u("only user")])).toBe("已恢复 s1（1 条消息；最近：…）"); // ω99-172: 钉随源演进（漏判钉）
  });
});

// ---------------------------------------------------------------------------
// F1 item 3 (83) — the programmatic-submit busy-guard. The REPL's fire-and-
// forget submits (monitor wakes at the cronPoll seam, /loop rounds through
// the loop controller's submit) used to call `void runTurn(...)` directly, so
// a programmatic submit during an in-flight turn produced TWO concurrent
// runTurns over the shared turn state (state.messages, activeGen/activeAbort,
// the /loop re-arm). The gate mirrors the M61 driver semantics (submitCore
// parks a busy submit): busy → park in a FIFO, drained at the settling turn's
// tail — never a concurrent run. Interactive user submits keep their own path
// (the main loop awaits runTurn; unchanged).
// ---------------------------------------------------------------------------

describe("F1 item 3 — createProgrammaticSubmitGate (the busy-guard)", () => {
  it("idle → starts immediately; a submit while a turn is in flight parks instead of running; the settle drain runs it next", () => {
    let busy = false;
    const runs: string[] = [];
    const gate = createProgrammaticSubmitGate((t) => { runs.push(t); }, () => busy);

    expect(gate.submit("wake-1")).toBe("started"); // idle: runs now
    expect(runs).toEqual(["wake-1"]);

    busy = true; // a turn is in flight
    expect(gate.submit("wake-2")).toBe("parked");
    expect(runs).toEqual(["wake-1"]); // NOT a second concurrent runTurn
    expect(gate.parked()).toEqual(["wake-2"]);

    busy = false; // the turn settled
    gate.settleDrain();
    expect(runs).toEqual(["wake-1", "wake-2"]); // the parked wake works after settle
    expect(gate.parked()).toEqual([]);
  });

  it("multiple parked submits drain FIFO, one per settle", () => {
    const runs: string[] = [];
    // Submit-time: busy (everything parks). Settle-time: idle — report 95 R2
    // made the drain busy-aware, so the FIFO pin uses a busy flag that has
    // cleared by the drain, keeping the test's original one-per-settle intent.
    let busy = true;
    const gate = createProgrammaticSubmitGate((t) => { runs.push(t); }, () => busy);
    gate.submit("a");
    gate.submit("b");
    gate.submit("c");
    expect(gate.parked()).toEqual(["a", "b", "c"]);
    busy = false;
    gate.settleDrain();
    expect(runs).toEqual(["a"]);
    expect(gate.parked()).toEqual(["b", "c"]);
    gate.settleDrain();
    expect(runs).toEqual(["a", "b"]);
    gate.settleDrain();
    expect(runs).toEqual(["a", "b", "c"]);
    gate.settleDrain(); // empty queue: a no-op
    expect(runs).toEqual(["a", "b", "c"]);
  });

  it("the park notice fires with the parked payload (skip-with-log shape)", () => {
    const notices: string[] = [];
    const gate = createProgrammaticSubmitGate(() => {}, () => true, (t) => { notices.push(t); });
    gate.submit("[monitor x] boom");
    expect(notices).toEqual(["[monitor x] boom"]);
  });

  // Report 95 R2 — the settle-drain busy re-check. R1's submitTurn chain
  // already closed the REPL's real race; this pins the drain's own guard: a
  // drain that lands while isBusy() went true again (a submit slipping in
  // between shift and run) keeps the payload parked at the HEAD — FIFO
  // priority preserved, never a second concurrent run.
  it("report 95 R2 — drain while busy re-parks the head payload; the next drain runs it", () => {
    let busy = false;
    const runs: string[] = [];
    const gate = createProgrammaticSubmitGate((t) => { runs.push(t); }, () => busy);

    gate.submit("wake-1"); // idle: runs now
    busy = true;
    gate.submit("wake-2"); // parked behind the in-flight turn
    expect(gate.parked()).toEqual(["wake-2"]);

    gate.settleDrain(); // drains while STILL busy (the R2 window)
    expect(runs).toEqual(["wake-1"]); // no second run
    expect(gate.parked()).toEqual(["wake-2"]); // re-parked at the head

    busy = false;
    gate.settleDrain(); // the next drain runs it
    expect(runs).toEqual(["wake-1", "wake-2"]);
    expect(gate.parked()).toEqual([]);
  });
});

describe("F1 item 3 — the gate is wired at both programmatic seams (source pin)", () => {
  it("the /loop submit and the monitor wake route through the gate; runTurn's tail drains; no direct fire-and-forget runTurn remains", () => {
    const src = replSrc();
    // Both programmatic seams go through the gate...
    expect(src).toContain("programmaticSubmitGate.submit(prompt);");
    expect(src).toContain("programmaticSubmitGate.submit(injection);");
    // ...the settling turn drains the queue...
    expect(src).toContain("programmaticSubmitGate.settleDrain();");
    // ...and the old unguarded fire-and-forget shapes are gone from the seams.
    expect(src).not.toContain("void runTurn(prompt, false)");
    expect(src).not.toContain("void runTurn(injection, false)");
  });
});

describe("report 95 R1 — createTurnSerializer (the admission chain)", () => {
  /** Deterministic microtask drain: enough Promise.resolve() hops for the
   *  chain to advance through a settle → next-start transition. */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };

  it("submits run strictly serialized in submission order (max concurrency 1); the queued notice fires both before-start and mid-run", async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const resolvers = new Map<string, () => void>();
    const fakeRunTurn = async (text: string): Promise<void> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`start:${text}`);
      await new Promise<void>((resolve) => { resolvers.set(text, resolve); }); // held open per turn
      active -= 1;
      order.push(`end:${text}`);
    };
    const queued: string[] = [];
    const { submitTurn } = createTurnSerializer(fakeRunTurn, (text) => { queued.push(text); });

    const p1 = submitTurn("a", false);
    const p2 = submitTurn("b", false);
    // The sync reserve: b was reported queued BEFORE any microtask moved the
    // chain — a has not even started. Admission must not depend on awaits.
    expect(queued).toEqual(["b"]);
    await flush();
    expect(order).toEqual(["start:a"]);
    const p3 = submitTurn("c", false); // mid-run: a is genuinely in flight
    expect(queued).toEqual(["b", "c"]);
    expect(order).toEqual(["start:a"]); // never a second start

    resolvers.get("a")!();
    await flush();
    expect(order).toEqual(["start:a", "end:a", "start:b"]);
    resolvers.get("b")!();
    await flush();
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c"]);
    resolvers.get("c")!();
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
    // THE invariant: at no point did two turns overlap.
    expect(maxActive).toBe(1);
  });

  it("a rejected turn neither breaks the chain nor leaks its error to later submitters", async () => {
    const order: string[] = [];
    const fakeRunTurn = async (text: string): Promise<void> => {
      order.push(text);
      if (text === "a") throw new Error("boom:a");
    };
    const { submitTurn } = createTurnSerializer(fakeRunTurn, () => {});
    const p1 = submitTurn("a", false);
    const p2 = submitTurn("b", false);
    await expect(p1).rejects.toThrow("boom:a"); // the caller still sees its own turn's failure
    await flush();
    await p2; // b ran anyway — the chain swallowed a's rejection
    expect(order).toEqual(["a", "b"]);
  });

  it("plan and branchLink ride through to runTurn verbatim (the park-drop fix: flags never lost)", async () => {
    const seen: { text: string; plan: boolean; branchLink: { readonly uuid: string; readonly parentUuid?: string } | undefined }[] = [];
    const fakeRunTurn = async (text: string, plan: boolean, branchLink?: { readonly uuid: string; readonly parentUuid?: string }): Promise<void> => {
      seen.push({ text, plan, branchLink });
    };
    const { submitTurn } = createTurnSerializer(fakeRunTurn, () => {});
    const link = { uuid: "u-1", parentUuid: "p-1" } as const;
    const p1 = submitTurn("first", false);
    const p2 = submitTurn("plan-turn", true, link); // queued behind first
    await Promise.all([p1, p2]);
    expect(seen).toEqual([
      { text: "first", plan: false, branchLink: undefined },
      { text: "plan-turn", plan: true, branchLink: link }, // both flags survived the queue
    ]);
  });
});

describe("report 95 R1 — every turn submit goes through the chain (source pin)", () => {
  it("runRepl wires submitTurn over runTurn; no direct runTurn call site remains", () => {
    const src = replSrc();
    expect(src).toContain("const { submitTurn } = createTurnSerializer(");
    // The gate's run callback enters the chain too (parked payloads queue,
    // they no longer bypass admission at the drain seam).
    expect(src).toContain("void submitTurn(text, false)");
    // The old shapes are gone: no interactive await, no fire-and-forget.
    expect(src).not.toContain("await runTurn(");
    expect(src).not.toContain("void runTurn(");
  });
});

// ---------------------------------------------------------------------------
// Report 95 R1 — REPL turn serialization (the submitTurn admission chain).
// The REPL serialized its turns purely by the main loop's `await runTurn`
// side effect, but the /loop first round is a FIRE-AND-FORGET programmatic
// submit through the gate: once it starts, a user prompt typed at the next
// `wudao> ` entered a SECOND concurrent runTurn over the single-owner turn
// state (state.messages, activeGen/activeAbort, the /loop re-arm) — the exact
// race named in design 95 §1.2. The chain collapses admission to one entry
// point (real CC's "reserve before the first await" discipline): a submit
// landing while a turn is queued/in flight QUEUES with a one-line notice
// instead of racing, and runs next in submission order.
// ---------------------------------------------------------------------------

describe("report 95 R1 — turn serialization (runRepl integration: a gate-fired /loop round races an interactive prompt)", () => {
  it("a prompt submitted while the /loop first round is in flight queues (notice) and runs next — model calls never overlap, history stays ordered", async () => {
    const ws = await mkdtemp(join(tmpdir(), "r1-serial-ws-"));
    const globalHome = await mkdtemp(join(tmpdir(), "r1-serial-gh-"));
    const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
    const prevFetch = globalThis.fetch;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const enc = new TextEncoder();
    const sse = (): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`));
        c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    const captured: { readonly url: string; readonly body: string }[] = [];
    let releaseFirst: (() => void) | undefined;
    const releaseGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      captured.push({ url: String(url), body: String(init?.body) });
      // The FIRST model call (the /loop round) is held open until the test
      // releases it — the "slow first turn" the interactive line races.
      if (captured.length === 1) await releaseGate;
      return new Response(sse(), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    let seen = "";
    let fed = 0;
    let released = false;
    let raceCaught = false;
    let serializedWhenQueued = false;
    // One line per `wudao> ` prompt (the readline/promises discipline from
    // persona-wire-repl.test.ts): prompt 2 prints while the /loop round is
    // still in flight (its submit is fire-and-forget), so "second-line" is
    // the racing interactive submit.
    const lines = ["/loop 1h keepalive round", "second-line", "/exit"];
    const drain = (): string => {
      let text = "";
      let chunk = stdout.read();
      while (chunk !== null) { text += chunk.toString(); chunk = stdout.read(); }
      return text;
    };
    const pump = (): void => {
      seen += drain();
      const prompts = seen.split("wudao> ").length - 1;
      while (fed < lines.length && fed < prompts) { stdin.write(`${lines[fed]}\n`); fed += 1; }
      if (released) return;
      if (seen.includes("⏸ 已排队（本轮运行中）：second-line")) { // ω99-166d-ii: 排队钉随 #13
        // The chain queued the interactive submit: at most the round's own
        // call (zero or one — the round may still be pre-model when the
        // notice fires, the exact about-to-start window) may exist; the
        // second turn's call must NOT have started.
        serializedWhenQueued = captured.length <= 1;
        released = true;
        releaseFirst?.();
      } else if (captured.length >= 2) {
        raceCaught = true; // pre-fix: second-line's runTurn fetched concurrently
        released = true;
        releaseFirst?.();
      }
    };
    const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (pred: () => boolean, what: string, ms = 5_000): Promise<void> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        pump();
        if (pred()) return;
        await delay(10);
      }
      throw new Error(`r1 integration: timed out waiting for ${what}\n--- output so far ---\n${seen}`);
    };

    process.env.WUDAO_GLOBAL_HOME = globalHome;
    let replError: unknown;
    let done: Promise<void> | undefined;
    try {
      done = runRepl({
        config: { apiKey: "sk-r1", baseURL: "https://r1-serial.invalid/v1", model: "r1-model" } satisfies ProviderConfig,
        workspaceRoot: ws,
        buildTools: () => [],
        contextWindowTokens: 200_000,
        stdin,
        stdout,
      });
      // Phase 1 — the /loop first round (gate → fire-and-forget) holds its
      // model call open; the interactive "second-line" lands while it runs.
      await waitFor(() => released, "the second submit to land (queued via the chain, or raced pre-fix)");
      expect(raceCaught).toBe(false); // RED pre-fix: second-line's runTurn fetched while the round was in flight
      expect(seen).toContain("⏸ 已排队（本轮运行中）：second-line"); // the one-line queue notice // ω99-166d-ii: 排队钉随 #13
      expect(serializedWhenQueued).toBe(true); // no second-turn model call while the round was in flight
      // Phase 2 — release: the queued interactive turn runs NEXT (chain order).
      await waitFor(() => captured.length >= 2, "the queued turn's model call");
      // waitFor keeps pumping (it feeds /exit at prompt 3) until the session
      // ends; its deadline arm throws if it never does.
      await Promise.race([done, waitFor(() => false, "the session to end", 10_000)]);
    } catch (err) {
      replError = err;
    } finally {
      // Tear the session down before deleting its workspace (the runtimes
      // keep writing into .wudao/ otherwise — ENOTEMPTY races).
      stdin.end();
      if (done !== undefined) await Promise.race([done.then(() => {}, () => {}), delay(500)]);
      process.env.WUDAO_GLOBAL_HOME = prevGlobal;
      globalThis.fetch = prevFetch;
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    if (replError !== undefined) throw replError;
    seen += drain();

    // Model-call seam: exactly two calls, the second only after the first
    // fully settled (it carries the first turn's messages beneath it).
    expect(captured.length).toBe(2);
    const body = JSON.parse(captured[1]!.body) as { messages: { role: string; content: string }[] };
    const userTexts = body.messages.filter((m) => m.role === "user").map((m) => String(m.content));
    const iRound = userTexts.findIndex((c) => c.includes("keepalive round"));
    const iSecond = userTexts.indexOf("second-line");
    expect(iRound).toBeGreaterThanOrEqual(0);
    expect(iSecond).toBeGreaterThanOrEqual(0);
    // The two user messages landed in submission order.
    expect(iRound).toBeLessThan(iSecond);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Report 95 R3 — mid-turn stdin lines park in a FIFO and replay after settle.
// Readline delivers a stdin line to the pending rl.question when one exists;
// with NO question pending (a turn in flight) the "line" event had no
// consumer and the input was silently DROPPED — the user typed into the void.
// R3 parks such lines in one FIFO (single list, no 'now'-priority preemption)
// with a one-line notice; after the turn settles the main loop replays them
// FIFO-first through the SAME parsing path as a typed line, so a parked line
// becomes the next turn's input instead of a lost byte. An interrupted turn
// clears the FIFO (pi's "the queue never orphans" rule, editor-less form) —
// the abort rejects the turn, its parked lines go with it.
// ---------------------------------------------------------------------------

describe("report 95 R3 — mid-turn stdin lines park in a FIFO and replay after settle", () => {
  it("a line typed mid-turn parks (notice) and becomes the next turn's input after settle — not lost", async () => {
    const ws = await mkdtemp(join(tmpdir(), "r3-park-ws-"));
    const globalHome = await mkdtemp(join(tmpdir(), "r3-park-gh-"));
    const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
    const prevFetch = globalThis.fetch;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const enc = new TextEncoder();
    const PARK_NOTICE = "⏸ 输入已暂存（本轮运行中）"; // ω99-166d-ii: PARK_NOTICE 钉随 #12（:867 为表外第 4 处同族钉）
    const sse = (): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`));
        c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    const captured: { readonly url: string; readonly body: string }[] = [];
    let releaseFirst: (() => void) | undefined;
    const releaseGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      captured.push({ url: String(url), body: String(init?.body) });
      // The FIRST model call is held open — the slow turn the parked line
      // arrives during (no `wudao> ` question is pending there).
      if (captured.length === 1) await releaseGate;
      return new Response(sse(), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    let seen = "";
    let fed = 0;
    let parkedWritten = false;
    const lines = ["first-turn", "/exit"];
    const drain = (): string => {
      let text = "";
      let chunk = stdout.read();
      while (chunk !== null) { text += chunk.toString(); chunk = stdout.read(); }
      return text;
    };
    const pump = (): void => {
      seen += drain();
      const prompts = seen.split("wudao> ").length - 1;
      while (fed < lines.length && fed < prompts) { stdin.write(`${lines[fed]}\n`); fed += 1; }
      // Once the first turn's model call is in flight, type a line mid-turn
      // (pre-R3: readline dropped it — no question pending, no listener).
      if (!parkedWritten && captured.length >= 1) { stdin.write("parked-line\n"); parkedWritten = true; }
    };
    const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (pred: () => boolean, what: string, ms = 5_000): Promise<void> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        pump();
        if (pred()) return;
        await delay(10);
      }
      throw new Error(`r3 park: timed out waiting for ${what}\n--- output so far ---\n${seen}`);
    };

    process.env.WUDAO_GLOBAL_HOME = globalHome;
    let replError: unknown;
    let done: Promise<void> | undefined;
    try {
      done = runRepl({
        config: { apiKey: "sk-r3", baseURL: "https://r3-park.invalid/v1", model: "r3-model" } satisfies ProviderConfig,
        workspaceRoot: ws,
        buildTools: () => [],
        contextWindowTokens: 200_000,
        stdin,
        stdout,
      });
      // Phase 1 — the mid-turn line parks with the one-line notice (RED
      // pre-R3: no notice ever — the line was dropped).
      await waitFor(() => seen.includes(PARK_NOTICE), "the mid-turn park notice", 4_000);
      // Phase 2 — release the held turn: the parked line replays as the NEXT
      // turn's input.
      releaseFirst?.();
      await waitFor(() => captured.length >= 2, "the parked line's replay turn");
      await Promise.race([done, waitFor(() => false, "the session to end", 10_000)]);
    } catch (err) {
      replError = err;
    } finally {
      stdin.end();
      if (done !== undefined) await Promise.race([done.then(() => {}, () => {}), delay(500)]);
      process.env.WUDAO_GLOBAL_HOME = prevGlobal;
      globalThis.fetch = prevFetch;
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    if (replError !== undefined) throw replError;
    seen += drain();

    expect(seen).toContain(PARK_NOTICE); // the exact one-line park notice
    expect(captured.length).toBe(2); // RED pre-R3: 1 — the parked line never became a turn
    const body = JSON.parse(captured[1]!.body) as { messages: { role: string; content: string }[] };
    const userTexts = body.messages.filter((m) => m.role === "user").map((c) => String(c.content));
    expect(userTexts).toContain("parked-line"); // settled → next turn input, not lost
    expect(userTexts.indexOf("first-turn")).toBeLessThan(userTexts.indexOf("parked-line"));
  }, 20_000);

  it("two lines typed mid-turn park once each and replay in FIFO order as two turns", async () => {
    const ws = await mkdtemp(join(tmpdir(), "r3-fifo-ws-"));
    const globalHome = await mkdtemp(join(tmpdir(), "r3-fifo-gh-"));
    const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
    const prevFetch = globalThis.fetch;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const enc = new TextEncoder();
    const PARK_NOTICE = "⏸ 输入已暂存（本轮运行中）"; // ω99-166d-ii: PARK_NOTICE 钉随 #12（:867 为表外第 4 处同族钉）
    const sse = (): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`));
        c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    const captured: { readonly url: string; readonly body: string }[] = [];
    let releaseFirst: (() => void) | undefined;
    const releaseGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      captured.push({ url: String(url), body: String(init?.body) });
      if (captured.length === 1) await releaseGate;
      return new Response(sse(), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    let seen = "";
    let fed = 0;
    let parked = 0;
    const lines = ["first-turn", "/exit"];
    const parkOrder = ["parked-a", "parked-b"];
    const drain = (): string => {
      let text = "";
      let chunk = stdout.read();
      while (chunk !== null) { text += chunk.toString(); chunk = stdout.read(); }
      return text;
    };
    const pump = (): void => {
      seen += drain();
      const prompts = seen.split("wudao> ").length - 1;
      while (fed < lines.length && fed < prompts) { stdin.write(`${lines[fed]}\n`); fed += 1; }
      // Both lines land while the first turn is still held open — the FIFO
      // content (a then b) is deterministic, not a timing artifact.
      // ω99-35: the non-TTY batcher aggregates writes that land inside one
      // 150ms window into ONE message by design, so the second line is
      // written only after the first's park notice (the window-elapsed
      // proof) — this test pins the FIFO replay of two SEPARATELY-SENT
      // messages (merge-aggregation has its own o99-35 coverage).
      if (
        parked < parkOrder.length &&
        captured.length >= 1 &&
        (parked === 0 || seen.includes(PARK_NOTICE))
      ) { stdin.write(`${parkOrder[parked]}\n`); parked += 1; }
    };
    const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (pred: () => boolean, what: string, ms = 5_000): Promise<void> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        pump();
        if (pred()) return;
        await delay(10);
      }
      throw new Error(`r3 fifo: timed out waiting for ${what}\n--- output so far ---\n${seen}`);
    };

    process.env.WUDAO_GLOBAL_HOME = globalHome;
    let replError: unknown;
    let done: Promise<void> | undefined;
    try {
      done = runRepl({
        config: { apiKey: "sk-r3", baseURL: "https://r3-fifo.invalid/v1", model: "r3-model" } satisfies ProviderConfig,
        workspaceRoot: ws,
        buildTools: () => [],
        contextWindowTokens: 200_000,
        stdin,
        stdout,
      });
      // Phase 1 — both mid-turn lines park (one notice each) before release.
      await waitFor(() => seen.split(PARK_NOTICE).length - 1 >= 2, "both park notices", 4_000);
      // Phase 2 — release the held turn: the FIFO drains in order as two
      // consecutive turns.
      releaseFirst?.();
      await waitFor(() => captured.length >= 3, "both parked lines' replay turns");
      await Promise.race([done, waitFor(() => false, "the session to end", 10_000)]);
    } catch (err) {
      replError = err;
    } finally {
      stdin.end();
      if (done !== undefined) await Promise.race([done.then(() => {}, () => {}), delay(500)]);
      process.env.WUDAO_GLOBAL_HOME = prevGlobal;
      globalThis.fetch = prevFetch;
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    if (replError !== undefined) throw replError;
    seen += drain();

    expect(seen.split(PARK_NOTICE).length - 1).toBe(2); // one notice per parked line
    expect(captured.length).toBe(3); // first turn + the two replayed turns
    const body = JSON.parse(captured[2]!.body) as { messages: { role: string; content: string }[] };
    const userTexts = body.messages.filter((m) => m.role === "user").map((c) => String(c.content));
    // FIFO order survived the round trip: first-turn < parked-a < parked-b.
    expect(userTexts.indexOf("first-turn")).toBeGreaterThanOrEqual(0);
    expect(userTexts.indexOf("first-turn")).toBeLessThan(userTexts.indexOf("parked-a"));
    expect(userTexts.indexOf("parked-a")).toBeLessThan(userTexts.indexOf("parked-b"));
  }, 20_000);

  it("SIGINT aborting the in-flight turn clears the parked line — no orphan replay", async () => {
    const ws = await mkdtemp(join(tmpdir(), "r3-abort-ws-"));
    const globalHome = await mkdtemp(join(tmpdir(), "r3-abort-gh-"));
    const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
    const prevFetch = globalThis.fetch;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const enc = new TextEncoder();
    const PARK_NOTICE = "⏸ 输入已暂存（本轮运行中）"; // ω99-166d-ii: PARK_NOTICE 钉随 #12（:867 为表外第 4 处同族钉）
    const sse = (): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`));
        c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    const captured: { readonly url: string; readonly body: string }[] = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      captured.push({ url: String(url), body: String(init?.body) });
      // The held first turn settles EITHER on the test's release OR on the
      // per-turn abort signal (SIGINT reaches provider fetches) — the abort
      // path is what this case drives.
      if (captured.length === 1) {
        const sig = init?.signal;
        await new Promise<void>((resolve) => {
          if (sig?.aborted) resolve();
          else {
            sig?.addEventListener("abort", () => resolve(), { once: true });
            delay(8_000).then(() => resolve());
          }
        });
      }
      return new Response(sse(), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    let seen = "";
    let fed = 0;
    let parkedWritten = false;
    let sigintSent = false;
    const lines = ["first-turn", "/exit"];
    const drain = (): string => {
      let text = "";
      let chunk = stdout.read();
      while (chunk !== null) { text += chunk.toString(); chunk = stdout.read(); }
      return text;
    };
    const pump = (): void => {
      seen += drain();
      const prompts = seen.split("wudao> ").length - 1;
      while (fed < lines.length && fed < prompts) { stdin.write(`${lines[fed]}\n`); fed += 1; }
      if (!parkedWritten && captured.length >= 1) { stdin.write("parked-line\n"); parkedWritten = true; }
      // The line is parked — now abort the in-flight turn (the process-level
      // SIGINT handler; the readline one fires only on a real TTY ^C).
      if (parkedWritten && seen.includes(PARK_NOTICE) && !sigintSent) { sigintSent = true; process.emit("SIGINT"); }
    };
    const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (pred: () => boolean, what: string, ms = 5_000): Promise<void> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        pump();
        if (pred()) return;
        await delay(10);
      }
      throw new Error(`r3 abort: timed out waiting for ${what}\n--- output so far ---\n${seen}`);
    };

    process.env.WUDAO_GLOBAL_HOME = globalHome;
    let replError: unknown;
    let done: Promise<void> | undefined;
    try {
      done = runRepl({
        config: { apiKey: "sk-r3", baseURL: "https://r3-abort.invalid/v1", model: "r3-model" } satisfies ProviderConfig,
        workspaceRoot: ws,
        buildTools: () => [],
        contextWindowTokens: 200_000,
        stdin,
        stdout,
      });
      // Phase 1 — park a line mid-turn, then SIGINT the in-flight turn.
      await waitFor(() => seen.includes(PARK_NOTICE), "the mid-turn park notice", 4_000);
      await waitFor(() => sigintSent, "the SIGINT to land");
      // Phase 2 — the turn settles interrupted; the FIFO is cleared, so the
      // next prompt is IDLE (no orphan replay of the parked line).
      await waitFor(() => seen.includes("⚠️ 已中断"), "the interrupted turn to settle"); // ω99-166b: 随源中文化（repl :1940/:1981）。
      await Promise.race([done, waitFor(() => false, "the session to end", 10_000)]);
    } catch (err) {
      replError = err;
    } finally {
      stdin.end();
      if (done !== undefined) await Promise.race([done.then(() => {}, () => {}), delay(500)]);
      process.env.WUDAO_GLOBAL_HOME = prevGlobal;
      globalThis.fetch = prevFetch;
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    if (replError !== undefined) throw replError;
    seen += drain();

    expect(seen).toContain(PARK_NOTICE);
    expect(seen).toContain("⏹ 已清空 1 条排队输入"); // the abort cleared the FIFO (one line) — ω99-191: 钉随源演进
    expect(seen).toContain("⚠️ 已中断"); // the SIGINT single-turn assumption held — ω99-166b: 随源中文化（repl :1940/:1981）。
    expect(captured.length).toBe(1); // no second model call — nothing replayed
    expect(captured.every((c) => !c.body.includes("parked-line"))).toBe(true); // no orphan delivery
  }, 20_000);

  // R3 review Minor (1764b87): the cron/peer lane's rl.write lines are R3's
  // incidental beneficiaries — pre-R3, a line written while no rl.question was
  // pending hit a "line" event with no listener and vanished. The poll can
  // never write mid-turn (its activeGen guard skips those ticks), so the real
  // window where a scheduled line can land question-less is a main-loop await
  // that is not a question — pinned here with a `!` bang command (M58 §C#12):
  // the question is consumed, no turn is in flight, and the loop is blocked on
  // the shell child for a test-chosen duration. The task is pre-written as
  // already due, so the scheduler's one startup tick arms it BEFORE the first
  // question exists (the "came due offline, fires once on next online" rule);
  // the 1s poll then takes it inside the bang window through the REAL
  // takeInjection→rl.write lane, the line parks, and the loop-top shift
  // replays it as the next turn's input through the full prompt path.
  it("a cron injection taken while the main loop awaits a bang command parks and replays as the next turn — not lost", async () => {
    const ws = await mkdtemp(join(tmpdir(), "r3-cronpark-ws-"));
    const globalHome = await mkdtemp(join(tmpdir(), "r3-cronpark-gh-"));
    await mkdir(join(ws, ".wudao"), { recursive: true });
    // createdAt 2min back + 1min interval + ≤30s late jitter → due at the
    // startup tick for certain (never a hash-dependent race). sessionId
    // "repl" is runRepl's default scope; the 8-char id is the store's shape.
    const TASK_ID = "cronpk01";
    const PAYLOAD = "[scheduled task cronpk01] cron-park-payload";
    await writeFile(
      join(ws, ".wudao", "cron.json"),
      JSON.stringify({
        version: 1,
        tasks: [{ id: TASK_ID, sessionId: "repl", prompt: "cron-park-payload", schedule: { type: "interval", everyMs: 60_000 }, createdAt: Date.now() - 120_000 }],
      }),
      "utf8",
    );
    const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
    const prevFetch = globalThis.fetch;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const enc = new TextEncoder();
    const PARK_NOTICE = "⏸ 输入已暂存（本轮运行中）"; // ω99-166d-ii: PARK_NOTICE 钉随 #12（:867 为表外第 4 处同族钉）
    const sse = (): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`));
        c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    const captured: { readonly url: string; readonly body: string }[] = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      captured.push({ url: String(url), body: String(init?.body) });
      return new Response(sse(), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    let seen = "";
    let fed = 0;
    // Line 1 opens the await window (the shell child runs ~2s — the first 1s
    // poll tick lands inside it); line 2 ends the session at the next prompt.
    const lines = ["!sleep 2", "/exit"];
    const drain = (): string => {
      let text = "";
      let chunk = stdout.read();
      while (chunk !== null) { text += chunk.toString(); chunk = stdout.read(); }
      return text;
    };
    const pump = (): void => {
      seen += drain();
      const prompts = seen.split("wudao> ").length - 1;
      while (fed < lines.length && fed < prompts) { stdin.write(`${lines[fed]}\n`); fed += 1; }
    };
    const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (pred: () => boolean, what: string, ms = 5_000): Promise<void> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        pump();
        if (pred()) return;
        await delay(10);
      }
      throw new Error(`r3 cron park: timed out waiting for ${what}\n--- output so far ---\n${seen}`);
    };

    process.env.WUDAO_GLOBAL_HOME = globalHome;
    let replError: unknown;
    let done: Promise<void> | undefined;
    try {
      done = runRepl({
        config: { apiKey: "sk-r3c", baseURL: "https://r3-cronpark.invalid/v1", model: "r3-model" } satisfies ProviderConfig,
        workspaceRoot: ws,
        buildTools: () => [],
        contextWindowTokens: 200_000,
        stdin,
        stdout,
      });
      // Phase 1 — inside the bang window: the poll takes the due task (the ⏰
      // line is the real cronPoll→takeInjection→rl.write lane) and the line
      // parks with the one-line notice.
      await waitFor(() => seen.includes(PARK_NOTICE), "the cron injection's park notice", 4_000);
      // Phase 2 — the bang command settles; the loop-top shift replays the
      // parked line as the next turn's input (RED pre-R3: the line was
      // dropped at the "line" event — no park, no replay, this times out).
      await waitFor(() => captured.length >= 1, "the parked cron line's replay turn", 6_000);
      await Promise.race([done, waitFor(() => false, "the session to end", 10_000)]);
    } catch (err) {
      replError = err;
    } finally {
      stdin.end();
      if (done !== undefined) await Promise.race([done.then(() => {}, () => {}), delay(500)]);
      process.env.WUDAO_GLOBAL_HOME = prevGlobal;
      globalThis.fetch = prevFetch;
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    if (replError !== undefined) throw replError;
    seen += drain();

    expect(seen).toContain(`⏰ ${PAYLOAD}`); // the scheduled-lane take (not peer/monitor), full payload on the icon line
    expect(seen.split(PARK_NOTICE).length - 1).toBe(1); // exactly one park — the bang line itself used the question lane
    expect(seen.indexOf(`⏰ ${PAYLOAD}`)).toBeLessThan(seen.indexOf(PARK_NOTICE)); // take precedes its park
    expect(captured.length).toBe(1); // one model call — the replayed line's turn and nothing else
    const body = JSON.parse(captured[0]!.body) as { messages: { role: string; content: string }[] };
    const userText = body.messages.filter((m) => m.role === "user").map((c) => String(c.content)).join("\n");
    expect(userText).toContain(PAYLOAD); // the parked scheduled line became the turn input — not lost
    expect(userText).toContain("$ sleep 2"); // through the FULL prompt path — the bang context prefix rode the same turn
  }, 20_000);
});
