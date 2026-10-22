// ω-4b — the loop-safety reflection fork: pure module (instruction builder,
// window digest, verdict parser, the one-call challenger) + loop integration
// at the second-verdict boundary. Deterministic throughout: scripted models,
// no network, no subagents.
//
// Fail-closed is the spine under test everywhere: ANY challenger failure
// (throw, timeout, marker-less answer, missing directive) must produce the
// ORIGINAL abort semantics — never a swallowed one.
import { describe, it, expect } from "vitest";
import {
  buildChallengerInstruction,
  windowDigest,
  parseReflectionVerdict,
  runReflectionFork,
  REFLECTION_KINDS,
  REFLECTION_DEFAULT_TIMEOUT_MS,
  DIGEST_MAX_LINES,
  DIGEST_LINE_CHARS,
  DIGEST_TOTAL_CHARS,
} from "../src/loop-reflection.js";
import { runAgentLoop } from "../src/index.js";
import type {
  AgentMessage, AgentState, AssistantMessage, LoopEvent, ModelClient, ModelInput, ModelUsage, Terminal, Tool,
} from "../src/index.js";
import type { LoopSafetyTurn } from "../src/loop-safety.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function callTurn(name: string, args: Record<string, unknown>, isError = false): LoopSafetyTurn {
  return { calls: [{ name, args, isError }] };
}

function answerTurn(text: string): LoopSafetyTurn {
  return { calls: [], answer: text };
}

const CHALLENGER_PREFIX = "[loop-safety challenger]";

/** True when a recorded input is the challenger's (its defining shape: the
 *  one trailing user message carrying the instruction). */
function isChallengerInput(input: ModelInput): boolean {
  const last = input.messages.at(-1);
  return last !== undefined && last.role === "user" && last.content.startsWith(CHALLENGER_PREFIX);
}

/** Scripted model that records every input and routes the challenger call
 *  deterministically: regular turns consume `regular` in order; the ONE
 *  challenger call goes to `challenger` (a response, or a handler that may
 *  throw / hang / fire usage). */
function reflectionModel(opts: {
  regular: readonly AssistantMessage[];
  challenger: AssistantMessage | ((input: ModelInput) => Promise<AssistantMessage>);
  challengerUsage?: ModelUsage;
  regularUsage?: ModelUsage;
}): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push({ ...input, messages: input.messages.map((m) => ({ ...m })) });
      if (isChallengerInput(input)) {
        if (opts.challengerUsage !== undefined) input.onUsage?.(opts.challengerUsage);
        return typeof opts.challenger === "function" ? opts.challenger(input) : opts.challenger;
      }
      if (opts.regularUsage !== undefined) input.onUsage?.(opts.regularUsage);
      const r = opts.regular[i];
      i += 1;
      if (!r) throw new Error("scripted regular responses exhausted");
      return r;
    },
  };
}

const SYSTEM = "You are a deterministic test agent.";

function stateWith(tools: readonly Tool[]): AgentState {
  return { systemPrompt: SYSTEM, messages: [{ role: "user", content: "do the thing" }], tools: [...tools], status: "idle" };
}

const echoTool: Tool = {
  name: "echo",
  description: "echoes its arg",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  execute: async (args) => ({ content: `echo: ${String((args as { text?: string }).text ?? "")}` }),
};

const sameCall = (id: string): AssistantMessage => ({
  role: "assistant",
  content: "",
  toolCalls: [{ id, name: "echo", arguments: { text: "same" } }],
});

const RECOVERABLE = "VERDICT: recoverable\nDIRECTIVE: read the file before editing — the old_string no longer matches.";
const STUCK = "VERDICT: stuck — no realistic change of approach remains\nThe same edit failed three times after the warning.";

async function drain(gen: AsyncGenerator<LoopEvent, Terminal>): Promise<{ events: LoopEvent[]; terminal: Terminal }> {
  const events: LoopEvent[] = [];
  for (;;) {
    const { done, value } = await gen.next();
    if (done) return { events, terminal: value };
    events.push(value);
  }
}

const loopEvents = <T extends { type: string }>(events: readonly T[], type: string) =>
  events.filter((e) => e.type === type) as unknown as { type: string }[];

// ---------------------------------------------------------------------------
// parseReflectionVerdict (pure)
// ---------------------------------------------------------------------------

describe("parseReflectionVerdict", () => {
  it("parses stuck with the same-line rationale", () => {
    const v = parseReflectionVerdict(STUCK);
    expect(v?.outcome).toBe("stuck");
    expect(v?.rationale).toContain("no realistic change of approach remains");
    expect(v?.directive).toBeUndefined();
  });

  it("parses recoverable and extracts the DIRECTIVE line", () => {
    const v = parseReflectionVerdict(RECOVERABLE);
    expect(v?.outcome).toBe("recoverable");
    expect(v?.directive).toContain("read the file before editing");
  });

  it("marker match is case-insensitive and tolerates no space after the colon", () => {
    expect(parseReflectionVerdict("verdict: STUCK")?.outcome).toBe("stuck");
    expect(parseReflectionVerdict("VERDICT:recoverable\nDIRECTIVE: x")?.outcome).toBe("recoverable");
  });

  it("caps rationale at 600 and directive at 400 chars", () => {
    const v = parseReflectionVerdict(
      `VERDICT: stuck — ${"r".repeat(900)}\nDIRECTIVE: ${"d".repeat(500)}`,
    );
    expect(v?.outcome).toBe("stuck");
    expect(v?.rationale?.length).toBeLessThanOrEqual(600);
    expect(v?.directive?.length).toBeLessThanOrEqual(400);
  });

  it("marker-less, empty, and whitespace answers yield undefined", () => {
    expect(parseReflectionVerdict("I cannot decide.")).toBeUndefined();
    expect(parseReflectionVerdict("")).toBeUndefined();
    expect(parseReflectionVerdict("   \n  ")).toBeUndefined();
  });

  it("tool_calls-only answers (empty content) yield undefined", () => {
    expect(parseReflectionVerdict("")).toBeUndefined();
  });

  it("FAIL-CLOSED: recoverable without a DIRECTIVE yields undefined (→ unavailable → abort)", () => {
    expect(parseReflectionVerdict("VERDICT: recoverable\nI think it could work out.")).toBeUndefined();
    expect(parseReflectionVerdict("VERDICT: recoverable\nDIRECTIVE:   ")).toBeUndefined();
  });

  it("the rationale excludes DIRECTIVE lines", () => {
    const v = parseReflectionVerdict("VERDICT: recoverable\nfirst line of why\nDIRECTIVE: do the other thing\nsecond line of why");
    expect(v?.directive).toBe("do the other thing");
    expect(v?.rationale).toContain("first line of why");
    expect(v?.rationale).toContain("second line of why");
    expect(v?.rationale).not.toContain("DIRECTIVE");
  });
});

// ---------------------------------------------------------------------------
// windowDigest (pure, capped)
// ---------------------------------------------------------------------------

describe("windowDigest", () => {
  it("shapes call lines (ok | error) and answer lines", () => {
    const d = windowDigest([
      callTurn("echo", { text: "same" }),
      callTurn("shell", { cmd: "x" }, true),
      answerTurn("The answer is 42."),
    ]);
    const lines = d.split("\n");
    expect(lines[0]).toBe('echo({"text":"same"}) → ok');
    expect(lines[1]).toBe('shell({"cmd":"x"}) → error');
    expect(lines[2]).toBe('(no tools) "The answer is 42."');
  });

  it("is pure: same input → same output, input untouched", () => {
    const turns = [callTurn("echo", { text: "a" }), answerTurn("hi")];
    expect(windowDigest(turns)).toBe(windowDigest(turns));
    expect(turns).toHaveLength(2);
  });

  it("caps each line at DIGEST_LINE_CHARS", () => {
    const d = windowDigest([callTurn("echo", { text: "x".repeat(400) })]);
    expect(d.split("\n")[0]?.length).toBeLessThanOrEqual(DIGEST_LINE_CHARS);
    expect(d).toContain("…");
  });

  it("keeps only the newest DIGEST_MAX_LINES lines with the truncation marker", () => {
    const turns = Array.from({ length: DIGEST_MAX_LINES + 6 }, (_, i) => callTurn("t", { n: i }));
    const d = windowDigest(turns);
    const lines = d.split("\n");
    expect(lines[0]).toBe("… (older activity truncated)");
    expect(lines).toHaveLength(DIGEST_MAX_LINES + 1);
    expect(d).toContain(`t({"n":${DIGEST_MAX_LINES + 5}})`); // newest kept
    expect(d).not.toContain(`t({"n":0})`); // oldest dropped
  });

  it("caps the total at DIGEST_TOTAL_CHARS (dropping OLDEST lines first)", () => {
    // Long tool names push each line near the line cap, so 24 lines exceed
    // the 2000-char budget → the oldest lines drop, newest survive.
    const name = "n".repeat(40);
    const turns = Array.from({ length: DIGEST_MAX_LINES }, (_, i) => callTurn(name, { pad: "y".repeat(200), i }));
    const d = windowDigest(turns);
    expect(d.length).toBeLessThanOrEqual(DIGEST_TOTAL_CHARS);
    expect(d).toContain("… (older activity truncated)");
    expect(d).toContain(`{"i":${DIGEST_MAX_LINES - 1}`); // the newest line survives
    expect(d).not.toContain(`{"i":0}`); // the oldest line dropped
  });
});

// ---------------------------------------------------------------------------
// buildChallengerInstruction (deterministic prompt seam)
// ---------------------------------------------------------------------------

describe("buildChallengerInstruction", () => {
  const evidence = 'identical echo({"text":"same"}) ×3 in last 6 turns';
  const digest = 'echo({"text":"same"}) → ok\necho({"text":"same"}) → ok';

  it("embeds the evidence verbatim, the digest, both verdict lines, and the directive rule", () => {
    const s = buildChallengerInstruction(evidence, digest);
    expect(s).toContain(evidence);
    expect(s).toContain(digest);
    expect(s).toContain("VERDICT: stuck");
    expect(s).toContain("VERDICT: recoverable");
    expect(s).toContain("DIRECTIVE:");
    expect(s).toContain("required when recoverable");
    expect(s.startsWith(CHALLENGER_PREFIX)).toBe(true);
  });

  it("is byte-stable across calls (no timestamps)", () => {
    expect(buildChallengerInstruction(evidence, digest)).toBe(buildChallengerInstruction(evidence, digest));
  });
});

// ---------------------------------------------------------------------------
// runReflectionFork (the one call, never throws)
// ---------------------------------------------------------------------------

describe("runReflectionFork", () => {
  const baseCtx = {
    systemPrompt: SYSTEM,
    messages: [{ role: "user" as const, content: "go" }],
    tools: [],
    evidence: "e",
    digest: "d",
    timeoutMs: 1000,
  };

  it("builds the prefix-shared request: verbatim system prompt, same tools, messages + ONE trailing instruction, background querySource", async () => {
    let seen: ModelInput | undefined;
    const model: ModelClient = {
      generate: async (input) => {
        seen = input;
        return { role: "assistant", content: RECOVERABLE };
      },
    };
    const v = await runReflectionFork(model, baseCtx);
    expect(v.outcome).toBe("recoverable");
    expect(seen?.systemPrompt).toBe(SYSTEM);
    expect(seen?.tools).toEqual([]);
    expect(seen?.querySource).toBe("loop-reflector");
    expect(seen?.reasoningEffort).toBeUndefined();
    expect(seen?.messages).toHaveLength(baseCtx.messages.length + 1);
    expect(seen?.messages.at(-1)?.role).toBe("user");
    expect(seen?.messages.at(-1)?.content.startsWith(CHALLENGER_PREFIX)).toBe(true);
    // The caller's message array is untouched (the fork copies).
    expect(baseCtx.messages).toHaveLength(1);
  });

  it("stamps reflectionTokens onto the forwarded usage row", async () => {
    const rows: ModelUsage[] = [];
    const model: ModelClient = {
      generate: async (input) => {
        input.onUsage?.({ promptTokens: 100, cacheHitTokens: 90, cacheMissTokens: 10, completionTokens: 20 });
        return { role: "assistant", content: STUCK };
      },
    };
    const v = await runReflectionFork(model, { ...baseCtx, onUsage: (u) => rows.push(u) });
    expect(v.outcome).toBe("stuck");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reflectionTokens).toBe(120);
    expect(rows[0]?.promptTokens).toBe(100);
  });

  it("NEVER throws: provider error, marker-less answer, and timeout all map to unavailable", async () => {
    const throwing: ModelClient = { generate: async () => { throw new Error("provider down"); } };
    expect((await runReflectionFork(throwing, baseCtx)).outcome).toBe("unavailable");

    const markerless: ModelClient = { generate: async () => ({ role: "assistant", content: "no markers here" }) };
    expect((await runReflectionFork(markerless, baseCtx)).outcome).toBe("unavailable");

    // Timeout: the call hangs until the linked controller aborts it.
    const hanging: ModelClient = {
      generate: (input) =>
        new Promise<AssistantMessage>((_, reject) => {
          input.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    };
    expect((await runReflectionFork(hanging, { ...baseCtx, timeoutMs: 10 })).outcome).toBe("unavailable");
  });

  it("forwards the parent signal (abort mid-fork → unavailable, timer cleared)", async () => {
    const ac = new AbortController();
    const hanging: ModelClient = {
      generate: (input) =>
        new Promise<AssistantMessage>((_, reject) => {
          input.signal?.addEventListener("abort", () => reject(Object.assign(new Error("x"), { name: "AbortError" })));
        }),
    };
    const p = runReflectionFork(hanging, { ...baseCtx, timeoutMs: 5000, signal: ac.signal });
    ac.abort();
    expect((await p).outcome).toBe("unavailable");
  });
});

// ---------------------------------------------------------------------------
// REFLECTION_KINDS — the fail-closed allowlist
// ---------------------------------------------------------------------------

describe("REFLECTION_KINDS", () => {
  it("arms exactly the three action-shaped kinds; no_answer is excluded", () => {
    expect([...REFLECTION_KINDS].sort()).toEqual(["edit_repeat", "failure_streak", "identical_calls"]);
    expect(REFLECTION_KINDS.has("no_answer")).toBe(false);
  });

  it("the default timeout is 45s", () => {
    expect(REFLECTION_DEFAULT_TIMEOUT_MS).toBe(45_000);
  });
});

// ---------------------------------------------------------------------------
// loop integration — the second-verdict adjudication
// ---------------------------------------------------------------------------

describe("runAgentLoop — reflection fork integration", () => {
  it("(a) recoverable stays the abort ONCE: directive note rides the MetaNote channel, a 3rd verdict aborts with attempts [1,2,3]", async () => {
    const model = reflectionModel({
      regular: Array.from({ length: 9 }, (_, i) => sameCall(`c${i + 1}`)),
      challenger: { role: "assistant", content: RECOVERABLE },
    });
    const state = stateWith([echoTool]);
    const { events, terminal } = await drain(
      runAgentLoop(state, model, { maxTurns: 20, gates: { todo: false, verify: false }, reflection: {} }),
    );

    expect(terminal.reason).toBe("aborted");
    expect(terminal.loopEvidence).toContain("echo");
    const detected = loopEvents(events, "loop_detected") as Extract<LoopEvent, { type: "loop_detected" }>[];
    expect(detected.map((e) => e.attempt)).toEqual([1, 2, 3]);

    // The fork ran EXACTLY once.
    const challengerInputs = model.inputs.filter(isChallengerInput);
    expect(challengerInputs).toHaveLength(1);
    const forks = loopEvents(events, "reflection_fork") as Extract<LoopEvent, { type: "reflection_fork" }>[];
    expect(forks).toHaveLength(1);
    expect(forks[0]?.outcome).toBe("recoverable");
    expect(forks[0]?.directive).toContain("read the file before editing");
    expect(forks[0]?.kind).toBe("identical_calls");

    // Verdict-1 note (generic) then verdict-2 note (the directive) — both
    // projected, never persisted.
    const notes = events.filter((e): e is Extract<LoopEvent, { type: "meta_note" }> => e.type === "meta_note");
    expect(notes).toHaveLength(2);
    expect(notes[0]?.text).toContain("stuck in a loop");
    expect(notes[1]?.text).toContain("RECOVERABLE");
    expect(notes[1]?.text).toContain("read the file before editing");
    expect(notes[1]?.text).toContain("Final warning");
    expect(state.messages.some((m) => m.content.includes("stuck in a loop") || m.content.includes("RECOVERABLE"))).toBe(false);
    // The directive is model-visible on the NEXT request's tool_result tail.
    const challengerIdx = model.inputs.findIndex(isChallengerInput);
    const nextInput = model.inputs[challengerIdx + 1];
    const lastTool = [...(nextInput?.messages ?? [])].reverse().find((m) => m.role === "tool");
    expect(lastTool?.content).toContain("read the file before editing");
  });

  it("(b) challenger stuck → enriched abort at the 2nd verdict (challenger-confirmed + rationale)", async () => {
    const model = reflectionModel({
      regular: Array.from({ length: 6 }, (_, i) => sameCall(`c${i + 1}`)),
      challenger: { role: "assistant", content: STUCK },
    });
    const state = stateWith([echoTool]);
    const { events, terminal } = await drain(
      runAgentLoop(state, model, { maxTurns: 20, gates: { todo: false, verify: false }, reflection: {} }),
    );

    expect(terminal.reason).toBe("aborted");
    expect(terminal.loopEvidence).toContain("echo"); // the DETECTOR's evidence stays authoritative
    expect(terminal.loopReflection?.outcome).toBe("challenger-confirmed");
    expect(terminal.loopReflection?.rationale).toContain("no realistic change of approach remains");
    const detected = loopEvents(events, "loop_detected") as Extract<LoopEvent, { type: "loop_detected" }>[];
    expect(detected.map((e) => e.attempt)).toEqual([1, 2]);
    const forks = loopEvents(events, "reflection_fork") as Extract<LoopEvent, { type: "reflection_fork" }>[];
    expect(forks).toHaveLength(1);
    expect(forks[0]?.outcome).toBe("stuck");
  });

  it("(c1) FAIL-CLOSED: the challenger throwing → today's abort + challenger-unavailable", async () => {
    const model = reflectionModel({
      regular: Array.from({ length: 6 }, (_, i) => sameCall(`c${i + 1}`)),
      challenger: async () => { throw new Error("provider exploded"); },
    });
    const { events, terminal } = await drain(
      runAgentLoop(stateWith([echoTool]), model, { maxTurns: 20, gates: { todo: false, verify: false }, reflection: {} }),
    );
    expect(terminal.reason).toBe("aborted");
    expect(terminal.loopEvidence).toContain("echo");
    expect(terminal.loopReflection?.outcome).toBe("challenger-unavailable");
    const forks = loopEvents(events, "reflection_fork") as Extract<LoopEvent, { type: "reflection_fork" }>[];
    expect(forks).toHaveLength(1);
    expect(forks[0]?.outcome).toBe("unavailable");
  });

  it("(c2) FAIL-CLOSED: a small injected timeout → today's abort + challenger-unavailable (timer cleared)", async () => {
    const model = reflectionModel({
      regular: Array.from({ length: 6 }, (_, i) => sameCall(`c${i + 1}`)),
      challenger: (input) =>
        new Promise<AssistantMessage>((_, reject) => {
          input.signal?.addEventListener("abort", () => reject(Object.assign(new Error("t/o"), { name: "AbortError" })));
        }),
    });
    const { terminal } = await drain(
      runAgentLoop(stateWith([echoTool]), model, {
        maxTurns: 20, gates: { todo: false, verify: false }, reflection: { timeoutMs: 10 },
      }),
    );
    expect(terminal.reason).toBe("aborted");
    expect(terminal.loopEvidence).toContain("echo");
    expect(terminal.loopReflection?.outcome).toBe("challenger-unavailable");
  });

  it("(c3) FAIL-CLOSED: a marker-less challenger answer → today's abort + challenger-unavailable", async () => {
    const model = reflectionModel({
      regular: Array.from({ length: 6 }, (_, i) => sameCall(`c${i + 1}`)),
      challenger: { role: "assistant", content: "I cannot render a verdict." },
    });
    const { terminal } = await drain(
      runAgentLoop(stateWith([echoTool]), model, { maxTurns: 20, gates: { todo: false, verify: false }, reflection: {} }),
    );
    expect(terminal.reason).toBe("aborted");
    expect(terminal.loopReflection?.outcome).toBe("challenger-unavailable");
  });

  it("(6a) no_answer on the 2nd verdict NEVER forks (allowlist excludes it)", async () => {
    const answer = () => ({ role: "assistant" as const, content: "I cannot update the board right now, sorry." });
    const model = reflectionModel({ regular: Array.from({ length: 8 }, answer), challenger: { role: "assistant", content: RECOVERABLE } });
    const state: AgentState = {
      systemPrompt: SYSTEM,
      messages: [
        { role: "user", content: "work the board" },
        { role: "user", content: "[todo board 0/2 done]\n◐ step one\n☐ step two" },
      ],
      tools: [],
      status: "idle",
    };
    const { events, terminal } = await drain(
      runAgentLoop(state, model, { maxTurns: 14, gates: { todo: true, verify: false, maxInsists: 8 }, reflection: {} }),
    );
    expect(terminal.reason).toBe("aborted");
    expect(model.inputs.filter(isChallengerInput)).toHaveLength(0);
    expect(events.some((e) => e.type === "reflection_fork")).toBe(false);
  });

  it("(6b) reflection absent → byte-identical M48 behavior (attempts [1,2], abort, no fork)", async () => {
    const model = reflectionModel({
      regular: Array.from({ length: 6 }, (_, i) => sameCall(`c${i + 1}`)),
      challenger: { role: "assistant", content: RECOVERABLE },
    });
    const { events, terminal } = await drain(
      runAgentLoop(stateWith([echoTool]), model, { maxTurns: 20, gates: { todo: false, verify: false } }),
    );
    expect(terminal.reason).toBe("aborted");
    expect(terminal.loopReflection).toBeUndefined();
    const detected = loopEvents(events, "loop_detected") as Extract<LoopEvent, { type: "loop_detected" }>[];
    expect(detected.map((e) => e.attempt)).toEqual([1, 2]);
    expect(model.inputs.filter(isChallengerInput)).toHaveLength(0);
    expect(events.some((e) => e.type === "reflection_fork")).toBe(false);
  });

  it("(6c) loopSafety:false → the whole net (fork included) is off", async () => {
    const model = reflectionModel({
      regular: Array.from({ length: 4 }, (_, i) => sameCall(`c${i + 1}`)).concat([{ role: "assistant", content: "done" }]),
      challenger: { role: "assistant", content: RECOVERABLE },
    });
    const { events, terminal } = await drain(
      runAgentLoop(stateWith([echoTool]), model, {
        maxTurns: 20, gates: { todo: false, verify: false }, loopSafety: false, reflection: {},
      }),
    );
    expect(terminal.reason).toBe("completed");
    expect(events.some((e) => e.type === "loop_detected")).toBe(false);
    expect(model.inputs.filter(isChallengerInput)).toHaveLength(0);
  });

  it("(6d) the parent signal already aborted at the boundary → no fork, today's abort", async () => {
    const ac = new AbortController();
    let turns = 0;
    const model = reflectionModel({
      regular: Array.from({ length: 6 }, (_, i) => sameCall(`c${i + 1}`)),
      challenger: { role: "assistant", content: RECOVERABLE },
    });
    const { terminal } = await drain(
      runAgentLoop(stateWith([echoTool]), model, {
        maxTurns: 20,
        gates: { todo: false, verify: false },
        reflection: {},
        signal: ac.signal,
        hooks: {
          onPostToolUse: async () => {
            turns += 1;
            if (turns === 6) ac.abort(); // abort AFTER the 6th tool settles, before the boundary
          },
        },
      }),
    );
    expect(terminal.reason).toBe("aborted");
    expect(model.inputs.filter(isChallengerInput)).toHaveLength(0);
  });

  it("(7) cache-prefix law: the challenger request shares the run's prefix byte-for-byte", async () => {
    const model = reflectionModel({
      regular: Array.from({ length: 9 }, (_, i) => sameCall(`c${i + 1}`)),
      challenger: { role: "assistant", content: RECOVERABLE },
    });
    const state = stateWith([echoTool]);
    await drain(runAgentLoop(state, model, { maxTurns: 20, gates: { todo: false, verify: false }, reflection: {} }));

    const idx = model.inputs.findIndex(isChallengerInput);
    expect(idx).toBeGreaterThan(0);
    const challenger = model.inputs[idx]!;
    const first = model.inputs[0]!;

    // System prompt + tools segment: byte-equal to the run's own requests.
    expect(challenger.systemPrompt).toBe(first.systemPrompt);
    expect(JSON.stringify(challenger.tools)).toBe(JSON.stringify(first.tools));

    // Messages = the state at the verdict boundary + EXACTLY ONE trailing
    // instruction message; no other suffix, nothing mutated.
    expect(challenger.messages.at(-1)?.role).toBe("user");
    const prefix = challenger.messages.slice(0, -1);

    // The NEXT regular request extends the SAME history — its prefix (all but
    // the last tool_result, which carries the projected directive note) is
    // byte-identical to the challenger's prefix.
    const next = model.inputs[idx + 1]!;
    expect(JSON.stringify(next.messages.slice(0, prefix.length - 1))).toBe(JSON.stringify(prefix.slice(0, -1)));
    const prefixLast = prefix.at(-1);
    const nextAt = next.messages[prefix.length - 1];
    expect(nextAt?.role).toBe(prefixLast?.role);
    if (typeof prefixLast?.content === "string" && typeof nextAt?.content === "string") {
      expect(nextAt.content.startsWith(prefixLast.content)).toBe(true); // projection is append-only
    }

    // The fork is read-only over state: no challenger artifact ever persists.
    expect(state.messages.some((m) => m.content.includes(CHALLENGER_PREFIX))).toBe(false);
    expect(state.messages.some((m) => m.role === "user" && m.content.includes("RECOVERABLE"))).toBe(false);
  });

  it("(8) usage stamping: the fork's row surfaces as a usage event with reflectionTokens", async () => {
    const model = reflectionModel({
      regular: Array.from({ length: 9 }, (_, i) => sameCall(`c${i + 1}`)),
      challenger: { role: "assistant", content: STUCK },
      challengerUsage: { promptTokens: 100, cacheHitTokens: 90, cacheMissTokens: 10, completionTokens: 20 },
    });
    const { events } = await drain(
      runAgentLoop(stateWith([echoTool]), model, { maxTurns: 20, gates: { todo: false, verify: false }, reflection: {} }),
    );
    const reflectionRows = events.filter(
      (e): e is Extract<LoopEvent, { type: "usage" }> => e.type === "usage" && e.usage.reflectionTokens !== undefined,
    );
    expect(reflectionRows).toHaveLength(1);
    expect(reflectionRows[0]?.usage.reflectionTokens).toBe(120);
    // The row lands before the reflection_fork event (receipt, then verdict).
    const usageIdx = events.findIndex((e) => e.type === "usage" && (e as { usage: ModelUsage }).usage.reflectionTokens !== undefined);
    const forkIdx = events.findIndex((e) => e.type === "reflection_fork");
    expect(usageIdx).toBeGreaterThan(-1);
    expect(forkIdx).toBe(usageIdx + 1);
  });

  it("(9) instruction content: the evidence + the digest of exactly the post-note window", async () => {
    const model = reflectionModel({
      regular: Array.from({ length: 9 }, (_, i) => sameCall(`c${i + 1}`)),
      challenger: { role: "assistant", content: STUCK },
    });
    // ω-1b: ablate the repetition breaker — this fixture drives 9 identical
    // call TURNS on purpose (M48 verdict fuel), and the breaker would refuse
    // every 3rd one, rewriting the window digest under assertion.
    await drain(runAgentLoop(stateWith([echoTool]), model, { maxTurns: 20, gates: { todo: false, verify: false }, reflection: {}, repetitionBreaker: false }));
    const challenger = model.inputs.find(isChallengerInput)!;
    const text = challenger.messages.at(-1)?.content ?? "";
    expect(text).toContain("×3 in last 6 turns"); // the detector evidence
    // safetyTurns was reset at verdict 1 → the digest covers exactly turns
    // 4-6 (the post-note window), one call line each.
    expect(text.split("→ ok").length - 1).toBe(3);
  });
});
