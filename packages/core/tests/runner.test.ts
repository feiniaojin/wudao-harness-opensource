import { describe, it, expect } from "vitest";
import type { Runner, AgentMiddleware } from "../src/runner.js";
import { pipe } from "../src/runner.js";
import type { AgentMessage, Terminal } from "../src/types.js";
import type { ModelInput } from "../src/model-client.js";
import type { LoopEvent } from "../src/loop.js";

const HISTORY: readonly AgentMessage[] = [{ role: "user", content: "hello" }];
const INPUT: ModelInput = {
  systemPrompt: "sys",
  messages: HISTORY,
  tools: [],
};

/** A well-behaved base runner: yields two events, returns a Terminal. */
function baseRunner(trace: string[]): Runner {
  return async function* run(history, input, ctx): AsyncGenerator<LoopEvent, Terminal> {
    trace.push(`base:${history.length}:${input.systemPrompt}:${ctx.signal !== undefined}`);
    yield { type: "turn_started", turn: 0 };
    yield { type: "turn_finished", turn: 0, toolCallCount: 0 };
    return { reason: "completed", finalMessage: { role: "assistant", content: "done" } };
  };
}

function tagMiddleware(name: string, trace: string[]): AgentMiddleware {
  return (next) => async function* (history, input, ctx) {
    trace.push(`${name}>`);
    const gen = next(history, input, ctx);
    let step = await gen.next();
    while (!step.done) {
      const out = yield step.value;
      step = await gen.next();
    }
    trace.push(`<${name}`);
    return step.value;
  };
}

async function drive(runner: Runner): Promise<{ events: LoopEvent[]; terminal: Terminal | undefined }> {
  const events: LoopEvent[] = [];
  const gen = runner(HISTORY, INPUT, { signal: new AbortController().signal });
  let step = await gen.next();
  while (!step.done) {
    events.push(step.value);
    step = await gen.next();
  }
  return { events, terminal: step.value };
}

describe("pipe (Runner/Middleware seam)", () => {
  it("composes outermost-first: pipe(a,b,c)(r) === a(b(c(r)))", async () => {
    const trace: string[] = [];
    const runner = pipe(
      tagMiddleware("a", trace),
      tagMiddleware("b", trace),
      tagMiddleware("c", trace),
    )(baseRunner(trace));
    const { events, terminal } = await drive(runner);
    // Entry order: a wraps b wraps c wraps base. Exit order unwinds inward-out.
    expect(trace).toEqual(["a>", "b>", "c>", "base:1:sys:true", "<c", "<b", "<a"]);
    expect(events.map((e) => e.type)).toEqual(["turn_started", "turn_finished"]);
    expect(terminal).toEqual({ reason: "completed", finalMessage: { role: "assistant", content: "done" } });
  });

  it("pipe() with no middlewares returns the runner unchanged", () => {
    const trace: string[] = [];
    const base = baseRunner(trace);
    expect(pipe()(base)).toBe(base);
  });

  it("a middleware can rewrite what the inner runner sees (e.g. context injection)", async () => {
    const seen: string[] = [];
    const note: AgentMiddleware = (next) => (history, input, ctx) => {
      seen.push("note-applied");
      return next([...history, { role: "user", content: "[injected]" }], input, ctx);
    };
    const trace: string[] = [];
    const { terminal } = await drive(pipe(note)(baseRunner(trace)));
    expect(seen).toEqual(["note-applied"]);
    // The base runner observed the extended history (2, not 1).
    expect(trace[0]).toBe("base:2:sys:true");
    expect(terminal?.reason).toBe("completed");
  });

  it("a middleware can short-circuit without calling the inner runner", async () => {
    const trace: string[] = [];
    const budget: AgentMiddleware = () => async function* () {
      yield { type: "turn_started", turn: 0 };
      return { reason: "max_turns" } as Terminal;
    };
    const { events, terminal } = await drive(pipe(budget)(baseRunner(trace)));
    expect(trace).toEqual([]); // base never ran
    expect(events).toHaveLength(1);
    expect(terminal).toEqual({ reason: "max_turns" });
  });

  it("respects the abort carried on ctx (a middleware may observe it)", async () => {
    const controller = new AbortController();
    const observed: boolean[] = [];
    const watcher: AgentMiddleware = (next) => (history, input, ctx) => {
      observed.push(ctx.signal === controller.signal);
      return next(history, input, ctx);
    };
    const base: Runner = async function* (): AsyncGenerator<LoopEvent, Terminal> {
      return { reason: "aborted" };
    };
    const gen = pipe(watcher)(base)(HISTORY, INPUT, { signal: controller.signal });
    const terminal = await gen.next();
    expect(observed).toEqual([true]);
    expect(terminal.done).toBe(true);
    expect(terminal.value).toEqual({ reason: "aborted" });
  });
});
