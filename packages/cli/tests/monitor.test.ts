// ω-4a — the Monitor tool's CLI runtime + integration (report 54 §5, cli half):
// the spawn/tail machinery over injected fakes (immediate return, crash
// coverage, silence/ttl reaping, stop sweep, caps, queue coalescing), the
// steering-lane delivery through the driver and the bare loop (prefix
// byte-stability, ordering after the tool batch, idle auto-start), and the
// sandbox/confinement refusals.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMonitorTools,
  resolveWorkspacePath,
  runAgentLoop,
  MONITOR_TTL_DEFAULT_MS,
  type AgentState,
  type AssistantMessage,
  type ModelClient,
  type ModelInput,
  type MonitorEvent,
  type MonitorStartInput,
  type Tool,
} from "@wudao-org/core";
import {
  createMonitorRuntime,
  type MonitorChild,
  type MonitorRuntimeOptions,
} from "../src/monitor.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";
import { stripProjectedNotes } from "./projected-notes.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "omega4a-monitor-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Fakes: child, spawner, watcher, clock
// ---------------------------------------------------------------------------

interface FakeChild {
  readonly child: MonitorChild;
  readonly kills: string[];
  emitOut(text: string): void;
  emitErr(text: string): void;
  close(code: number | null, signal?: string | null): void;
  fail(err: Error): void;
}

/** F1 item 1 (83): fake children default to NO pid — killChild then keeps the
 *  pre-v2 direct child.kill path, so every legacy kill assertion stays
 *  byte-identical and no test ever reaches a real process.kill. The
 *  group-kill tests hand an explicit pid AND an injected killProcess. */
function fakeChild(pid?: number): FakeChild {
  const out: ((chunk: string | Buffer) => void)[] = [];
  const err: ((chunk: string | Buffer) => void)[] = [];
  const closes: ((code: number | null, signal: string | null) => void)[] = [];
  const errors: ((err: Error) => void)[] = [];
  const kills: string[] = [];
  const dataStream = (ls: typeof out) => ({ on: (_e: "data", l: (chunk: string | Buffer) => void) => { ls.push(l); } });
  return {
    kills,
    child: {
      stdout: dataStream(out),
      stderr: dataStream(err),
      ...(pid !== undefined ? { pid } : {}),
      onClose: (l) => { closes.push(l); },
      onError: (l) => { errors.push(l); },
      kill: (signal) => { kills.push(signal ?? "SIGTERM"); return true; },
    },
    emitOut: (text) => { for (const l of out) l(Buffer.from(text, "utf8")); },
    emitErr: (text) => { for (const l of err) l(Buffer.from(text, "utf8")); },
    close: (code, signal = null) => { for (const l of closes) l(code, signal); },
    fail: (e) => { for (const l of errors) l(e); },
  };
}

interface SpawnCapture {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  detached: boolean;
}

function fakeSpawner(children: FakeChild[], captures: SpawnCapture[], nextPid?: () => number | undefined) {
  return (command: string, opts: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean }): MonitorChild => {
    captures.push({ command, cwd: opts.cwd, env: opts.env, detached: opts.detached });
    const c = fakeChild(nextPid?.());
    children.push(c);
    return c.child;
  };
}

function fakeWatcher() {
  const handles: { path: string; onChange: () => void; onError: (e: Error) => void; closed: boolean }[] = [];
  const watchFn: NonNullable<MonitorRuntimeOptions["watch"]> = (path, onChange, onError) => {
    const h = { path, onChange, onError, closed: false };
    handles.push(h);
    return { close: () => { h.closed = true; } };
  };
  return { watchFn, handles };
}

// A recording scripted model — captures every ModelInput for prefix asserts.
function recordingModel(responses: readonly AssistantMessage[], holdAt?: { index: number; until: Promise<void> }): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      if (holdAt !== undefined && i === holdAt.index) await holdAt.until;
      inputs.push({ ...input, messages: input.messages.map((m) => ({ ...m })) });
      const r = responses[i];
      i += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

const allowAsk = async () => ({ kind: "allow" as const });

const startInput = (over: Partial<MonitorStartInput> = {}): MonitorStartInput => ({
  kind: "command",
  target: "npm test",
  conditions: {},
  ttlMs: MONITOR_TTL_DEFAULT_MS,
  ...over,
});

function runtime(over: Partial<MonitorRuntimeOptions> = {}) {
  const children: FakeChild[] = [];
  const captures: SpawnCapture[] = [];
  const fw = fakeWatcher();
  let clock = 1_800_000_000_000;
  const rt = createMonitorRuntime({
    workspaceRoot: ws,
    sessionId: "s-test",
    env: {},
    now: () => clock,
    tickMs: 0,
    killGraceMs: 20,
    debounceMs: 10,
    spawn: fakeSpawner(children, captures),
    watch: fw.watchFn,
    ...over,
  });
  return { rt, children, captures, fw, tick: (by = 0) => { clock += by; return clock; } };
}

// ---------------------------------------------------------------------------

describe("ω-4a §5.cli-1 — monitor_start returns immediately", () => {
  it("kind=command answers < 50ms while the child is still running, over a scrubbed env", async () => {
    process.env.WUDAO_TEST_SECRET = "shh";
    try {
      const { rt, children, captures } = runtime();
      const tools = createMonitorTools({ registry: rt.registry(), confinePath: (p) => resolveWorkspacePath(ws, p), now: () => Date.now() });
      const t0 = Date.now();
      const r = await tools[0]!.execute({ kind: "command", command: "npm test", keyword: "error" });
      const elapsed = Date.now() - t0;
      expect(r.isError).not.toBe(true);
      expect(elapsed).toBeLessThan(50);
      expect(r.content).toMatch(/watch [a-z0-9]{8} armed/);
      expect(children.length).toBe(1);
      expect(captures[0]!.command).toBe("npm test");
      expect(captures[0]!.cwd).toBe(ws);
      expect(captures[0]!.env.WUDAO_TEST_SECRET).toBeUndefined(); // scrubChildEnv reuse
      rt.stop();
    } finally {
      delete process.env.WUDAO_TEST_SECRET;
    }
  });
});

describe("ω-4a §5.cli-2 — mid-run fire rides the steering drain (prefix byte-stable)", () => {
  it("the event lands as a trailing user message; the request prefix is byte-identical", async () => {
    const { rt, children } = runtime();
    await rt.registry().start(startInput({ conditions: { keyword: "error" } }));
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => { releaseFirst = r; });
    const model = recordingModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "noop", arguments: {} }] },
      { role: "assistant", content: "second turn saw the fire" },
      { role: "assistant", content: "done" },
    ], { index: 0, until: gate });
    const driver: AgentDriver = createAgentDriver({
      model,
      tools: [],
      systemPrompt: "sp",
      summarize: summarizeToolCall,
      onPermissionAsk: allowAsk,
      monitor: rt,
    });
    driver.submit("start");
    await until(() => driver.getStatus().busy === true, "run started");
    children[0]!.emitOut("compiling...\nerror: boom\n");
    expect(rt.pending().length).toBe(1);
    releaseFirst();
    await until(() => driver.getStatus().busy === false, "run finished");
    expect(model.inputs.length).toBeGreaterThanOrEqual(2);
    expect(model.inputs[1]!.systemPrompt).toBe(model.inputs[0]!.systemPrompt);
    expect(JSON.stringify(model.inputs[1]!.tools)).toBe(JSON.stringify(model.inputs[0]!.tools));
    // 夜移 003：前缀比较两侧先剥临时投影（时间提醒随下一请求消失）。
    const firstStable = stripProjectedNotes(model.inputs[0]!.messages);
    const secondStable = stripProjectedNotes(model.inputs[1]!.messages);
    const firstMsgs = JSON.stringify(firstStable);
    const secondPrefix = JSON.stringify(secondStable.slice(0, firstStable.length));
    expect(secondPrefix).toBe(firstMsgs);
    const injected = model.inputs[1]!.messages.at(-1);
    expect(injected?.role).toBe("user");
    expect((injected as { content: string }).content).toContain("[monitor ");
    expect((injected as { content: string }).content).toContain("error");
    // The keyword wake fired once; the watch stays armed for its terminal only.
    expect(rt.pending()).toHaveLength(0);
    expect(rt.registry().list().length).toBe(1);
    rt.stop();
  });
});

describe("ω-4a §5.cli-3 — ordering vs tool batches", () => {
  it("an event armed during a tool batch appends AFTER the batch's tool results, never between a call and its result", async () => {
    const { rt, children } = runtime();
    await rt.registry().start(startInput({ conditions: { keyword: "error" } }));
    let toolEntered!: () => void;
    const entered = new Promise<void>((r) => { toolEntered = r; });
    let releaseTool!: () => void;
    const toolGate = new Promise<void>((r) => { releaseTool = r; });
    const gateTool: Tool = {
      name: "gate",
      description: "blocks until released",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() { toolEntered(); await toolGate; return { content: "done" }; },
    };
    const model = recordingModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "gate", arguments: {} }] },
      { role: "assistant", content: "done" },
    ]);
    const driver: AgentDriver = createAgentDriver({
      model,
      tools: [gateTool],
      systemPrompt: "sp",
      summarize: summarizeToolCall,
      onPermissionAsk: allowAsk,
      monitor: rt,
    });
    driver.submit("start");
    await entered;
    children[0]!.emitOut("error: mid-batch\n"); // fires while the tool is in flight
    expect(rt.pending().length).toBe(1);
    releaseTool();
    await until(() => driver.getStatus().busy === false, "run finished");
    const msgs = model.inputs[1]!.messages;
    const monitorIdx = msgs.findIndex((m) => m.role === "user" && typeof (m as { content?: unknown }).content === "string" && ((m as { content: string }).content).startsWith("[monitor "));
    expect(monitorIdx).toBeGreaterThan(0);
    // Immediately before the injection stands the batch's tool RESULT — the
    // event never interleaved between the tool_use and its result.
    expect(msgs[monitorIdx - 1]!.role).toBe("tool");
    const toolUseIdx = msgs.findIndex((m) => m.role === "assistant");
    expect(toolUseIdx).toBeGreaterThan(-1);
    expect(toolUseIdx).toBeLessThan(monitorIdx - 1);
    rt.stop();
  });
});

describe("ω-4a §5.cli-4 — crash coverage (every terminal fires exactly once)", () => {
  it("exit 1 → one exit injection, queue drains empty, watch gone", async () => {
    const { rt, children } = runtime();
    await rt.registry().start(startInput());
    children[0]!.close(1);
    const injections = [rt.takeInjection(), rt.takeInjection()];
    expect(injections[0]).toContain("[monitor ");
    expect(injections[0]).toContain("command exited (code 1)");
    expect(injections[1]).toBeUndefined();
    expect(rt.registry().list()).toHaveLength(0);
    rt.stop();
  });

  it("exit 0 fires exactly like a crash (success is not privileged)", async () => {
    const { rt, children } = runtime();
    await rt.registry().start(startInput());
    children[0]!.close(0);
    const text = rt.takeInjection();
    expect(text).toContain("command exited (code 0)");
    expect(rt.takeInjection()).toBeUndefined();
    rt.stop();
  });

  it("signal death → error kind carrying the signal", async () => {
    const { rt, children } = runtime();
    await rt.registry().start(startInput());
    children[0]!.close(null, "SIGKILL");
    const text = rt.takeInjection();
    expect(text).toContain("[monitor ");
    expect(text).toContain("SIGKILL");
    rt.stop();
  });

  it("spawn failure (ENOENT) → error kind carrying the spawn error", async () => {
    const { rt, children } = runtime();
    await rt.registry().start(startInput());
    children[0]!.fail(Object.assign(new Error("spawn nosuchbin ENOENT"), { code: "ENOENT" }));
    const text = rt.takeInjection();
    expect(text).toContain("ENOENT");
    expect(rt.registry().list()).toHaveLength(0);
    rt.stop();
  });
});

describe("ω-4a §5.cli-5 — silence and ttl on the tick", () => {
  it("silence fires once at the threshold; never re-fires on later quiet", async () => {
    const { rt, children, tick } = runtime();
    await rt.registry().start(startInput({ conditions: { silenceMs: 5000 } }));
    tick(4999);
    expect(rt.tick()).toHaveLength(0);
    tick(1);
    expect(rt.tick().map((e) => e.kind)).toEqual(["silence"]);
    expect(rt.tick()).toHaveLength(0);
    tick(60_000);
    expect(rt.tick()).toHaveLength(0);
    // The watch survives a non-terminal wake (terminal still pending).
    expect(rt.registry().list()).toHaveLength(1);
    expect(rt.takeInjection()).toContain("silence"); // FIFO: drain the silence wake
    children[0]!.close(0);
    expect(rt.takeInjection()).toContain("exited");
    rt.stop();
  });

  it("ttl fires once, then the child is reaped SIGTERM → SIGKILL", async () => {
    const { rt, children, tick } = runtime();
    await rt.registry().start(startInput({ ttlMs: 60_000 }));
    tick(60_000);
    const fired = rt.tick();
    expect(fired.map((e) => e.kind)).toEqual(["ttl"]);
    expect(children[0]!.kills[0]).toBe("SIGTERM");
    await wait(60);
    expect(children[0]!.kills).toContain("SIGKILL");
    expect(rt.registry().list()).toHaveLength(0);
    expect(rt.takeInjection()).toContain("ttl");
    rt.stop();
  });
});

describe("ω-4a §5.cli-6 — kind=tail", () => {
  it("appended lines trigger conditions; deletion is the deleted terminal; ../ is refused", async () => {
    const { rt, fw } = runtime();
    const log = join(ws, "server.log");
    await writeFile(log, "existing line\n", "utf8");
    const tools = createMonitorTools({ registry: rt.registry(), confinePath: (p) => resolveWorkspacePath(ws, p), now: () => Date.now() });
    const armed = await tools[0]!.execute({ kind: "tail", path: "server.log", keyword: "listening" });
    expect(armed.isError).not.toBe(true);
    // Existing content does NOT fire (append-only semantics).
    await wait(40);
    expect(rt.pending()).toHaveLength(0);
    await appendFile(log, "server up\nlistening on 3000\n", "utf8");
    fw.handles[0]!.onChange();
    await until(() => rt.pending().length === 1, "keyword fire");
    expect(rt.takeInjection()).toContain("listening");
    // Deletion → the deleted terminal.
    await rm(log);
    fw.handles[0]!.onChange();
    await until(() => rt.pending().length === 1, "deleted terminal");
    expect(rt.takeInjection()).toContain("deleted");
    expect(rt.registry().list()).toHaveLength(0);
    // Path confinement refusal for ../.
    const esc = await tools[0]!.execute({ kind: "tail", path: "../outside.log" });
    expect(esc.isError).toBe(true);
    expect(esc.content).toContain("escapes");
    rt.stop();
  });
});

describe("ω-4a F6 (review 57) — watcher onError is a terminal", () => {
  it("an irrecoverable watcher error fires the error event, removes the watch, closes the watcher", async () => {
    const { rt, fw } = runtime();
    const log = join(ws, "e.log");
    await writeFile(log, "seed\n", "utf8");
    await rt.registry().start(startInput({ kind: "tail", target: log, conditions: {} }));
    fw.handles[0]!.onError(new Error("EMFILE: watch limit reached"));
    expect(rt.pending().map((e) => e.kind)).toEqual(["error"]);
    expect(rt.takeInjection()).toContain("EMFILE");
    expect(rt.registry().list()).toHaveLength(0);
    expect(fw.handles[0]!.closed).toBe(true);
    rt.stop();
  });

  it("F6: a SYNCHRONOUS watcher error during start still fires the terminal (no dead silent watch)", async () => {
    // The pre-registration race the review demonstrated: the error fires
    // inside watch(), before the old code's live.set — terminate must see it.
    const boom: NonNullable<MonitorRuntimeOptions["watch"]> = (_path, _onChange, onError) => {
      onError(new Error("EMFILE: watch limit reached"));
      return { close: () => {} };
    };
    const { rt } = runtime({ watch: boom });
    const log = join(ws, "boom.log");
    await writeFile(log, "seed\n", "utf8");
    await rt.registry().start(startInput({ kind: "tail", target: log, conditions: {} }));
    expect(rt.pending().map((e) => e.kind)).toEqual(["error"]);
    expect(rt.registry().list()).toHaveLength(0); // not registered as a dead watch
    expect(rt.takeInjection()).toContain("EMFILE");
    rt.stop();
  });
});

describe("ω-4a §5.cli-7 — monitor_stop", () => {
  it("kills the child, removes the watch; unknown id errors", async () => {
    const { rt, children } = runtime();
    const tools = createMonitorTools({ registry: rt.registry(), confinePath: async (p) => ({ ok: true, absPath: p }), now: () => Date.now() });
    const started = await tools[0]!.execute({ kind: "command", command: "npm test" });
    expect(started.isError).not.toBe(true);
    const id = rt.registry().list()[0]!.id;
    const stopped = await tools[2]!.execute({ id });
    expect(stopped.isError).not.toBe(true);
    expect(children[0]!.kills).toContain("SIGTERM");
    expect(rt.registry().list()).toHaveLength(0);
    const missing = await tools[2]!.execute({ id: "zzzzzzzz" });
    expect(missing.isError).toBe(true);
    rt.stop();
  });
});

describe("ω-4a §5.cli-8 — cap + queue overflow coalescing", () => {
  it("the 9th watch errors from the tool surface", async () => {
    const { rt } = runtime({ queueCap: 64 });
    const tools = createMonitorTools({ registry: rt.registry(), confinePath: async (p) => ({ ok: true, absPath: p }), now: () => Date.now() });
    for (let i = 0; i < 8; i += 1) {
      const r = await tools[0]!.execute({ kind: "command", command: `sleep ${i}` });
      expect(r.isError).not.toBe(true);
    }
    const ninth = await tools[0]!.execute({ kind: "command", command: "sleep 9" });
    expect(ninth.isError).toBe(true);
    expect(ninth.content).toContain("cap");
    rt.stop();
  });

  it("queue overflow drops the oldest events and prefixes the next injection with the count", async () => {
    const { rt, children } = runtime({ queueCap: 3 });
    await rt.registry().start(startInput({ conditions: { keyword: "a" } }));
    await rt.registry().start(startInput({ conditions: { keyword: "b" } }));
    children[0]!.emitOut("a\n");
    children[1]!.emitOut("b\n");
    children[0]!.close(0);
    children[1]!.close(0);
    // cap 3: the 4th push dropped the oldest — 3 retained, 1 counted.
    await until(() => rt.pending().length === 3, "three events retained");
    const first = rt.takeInjection();
    expect(first!.startsWith("[monitor] 1 earlier event(s) dropped")).toBe(true);
    expect(first!).toContain("[monitor ");
    const second = rt.takeInjection();
    expect(second!.startsWith("[monitor] 1 earlier event(s) dropped")).toBe(false);
    expect(rt.takeInjection()).toContain("[monitor ");
    expect(rt.takeInjection()).toBeUndefined();
    rt.stop();
  });
});

describe("ω-4a §5.cli-9 — idle auto-start", () => {
  it("an event armed with no run active starts one whose first ModelInput carries the injection", async () => {
    const { rt, children } = runtime();
    await rt.registry().start(startInput({ conditions: { keyword: "error" } }));
    const model = recordingModel([{ role: "assistant", content: "awake" }]);
    const driver: AgentDriver = createAgentDriver({
      model,
      tools: [],
      systemPrompt: "sp",
      summarize: summarizeToolCall,
      onPermissionAsk: allowAsk,
      monitor: rt,
    });
    children[0]!.emitOut("error: idle fire\n");
    // The busy window is fleeting (a one-answer run); await the durable trace
    // — the notice entry + the auto-started run's user prompt (the m61 shape).
    await until(
      () => driver.getHistory().some((h) => h.kind === "user" && ((h as { text?: string }).text ?? "").includes("[monitor ")),
      "auto-started run",
    );
    await until(() => driver.getStatus().busy === false, "run finished");
    expect(model.inputs.length).toBe(1);
    const last = stripProjectedNotes(model.inputs[0]!.messages).at(-1);
    expect(last?.role).toBe("user");
    expect((last as { content: string }).content).toContain("[monitor ");
    expect(rt.pending()).toHaveLength(0);
    rt.stop();
  });
});

describe("ω-4a §5.cli-10 — stop() sweep", () => {
  it("terminates every child, closes every watcher, clears the queue; nothing dangles", async () => {
    const { rt, children, fw } = runtime({ tickMs: 10 }); // a REAL timer this time
    const log = join(ws, "x.log");
    await writeFile(log, "seed\n", "utf8");
    await rt.registry().start(startInput());
    await rt.registry().start(startInput({ target: "cat x.log" }));
    await rt.registry().start(startInput({ kind: "tail", target: log, conditions: {} }));
    expect(children.length).toBe(2);
    expect(fw.handles.length).toBe(1);
    rt.stop();
    expect(children[0]!.kills).toEqual(["SIGTERM"]);
    expect(children[1]!.kills).toEqual(["SIGTERM"]);
    expect(fw.handles[0]!.closed).toBe(true);
    expect(rt.registry().list()).toHaveLength(0);
    await wait(50); // the 10ms tick fired post-stop without touching anything
    expect(rt.pending()).toHaveLength(0);
    // F2 (review 57): the escalations the sweep armed must RUN — a
    // SIGTERM-ignoring child is SIGKILLed after the grace window (20ms here).
    expect(children[0]!.kills).toContain("SIGKILL");
    expect(children[1]!.kills).toContain("SIGKILL");
  });

  it("F2 (review 57): a SIGTERM-ignoring child is SIGKILLed after grace even when stop() swept", async () => {
    const { rt, children } = runtime({ killGraceMs: 20 });
    await rt.registry().start(startInput());
    rt.stop();
    // The fake child ignores SIGTERM (it never exits) — the escalation must
    // survive the sweep instead of being cleared with the machinery.
    expect(children[0]!.kills).toEqual(["SIGTERM"]);
    await wait(80);
    expect(children[0]!.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

describe("ω-4a §5.cli-11 — sandbox refusal", () => {
  it("kind=command refuses under sandbox; kind=tail still works", async () => {
    const { rt } = runtime();
    const tools = createMonitorTools({ registry: rt.registry(), confinePath: (p) => resolveWorkspacePath(ws, p), sandbox: true, now: () => Date.now() });
    const refused = await tools[0]!.execute({ kind: "command", command: "npm test" });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("sandbox");
    const log = join(ws, "s.log");
    await writeFile(log, "seed\n", "utf8");
    const tail = await tools[0]!.execute({ kind: "tail", path: "s.log", lines: 1 });
    expect(tail.isError).not.toBe(true);
    rt.stop();
  });
});

describe("ω-4a §5.cli-12 — the one-shot composition", () => {
  it("a bare loop with the one-shot steering composition drains a mid-run fire at the next call", async () => {
    const { rt, children } = runtime();
    await rt.registry().start(startInput({ conditions: { keyword: "error" } }));
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => { releaseFirst = r; });
    const model = recordingModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "noop", arguments: {} }] },
      { role: "assistant", content: "done" },
    ], { index: 0, until: gate });
    const state: AgentState = {
      systemPrompt: "sp",
      messages: [{ role: "user", content: "go" }],
      tools: [],
      status: "idle",
    };
    // The exact composition index.ts wires for -p: the peer lane, then the
    // monitor lane. No peer here — the monitor take is the whole seam.
    const peerTake = (): string | undefined => undefined;
    const gen = runAgentLoop(state, model, { steering: { take: () => peerTake() ?? rt.takeInjection() } });
    const events: { type: string }[] = [];
    const consumer = (async () => {
      for await (const e of gen) events.push(e as { type: string });
    })();
    await until(() => events.some((e) => e.type === "model_call_started"), "first call in flight");
    children[0]!.emitOut("error: one-shot fire\n");
    releaseFirst();
    await consumer;
    expect(model.inputs.length).toBe(2);
    const injected = model.inputs[1]!.messages.at(-1);
    expect(injected?.role).toBe("user");
    expect((injected as { content: string }).content).toContain("[monitor ");
    // The exit sweep is the same stop() the one-shot finally runs (§5.cli-10).
    rt.stop();
  });
});

// ---------------------------------------------------------------------------
// F1 item 1 (83) — process-group kill (the v2 residual the header carried
// since ω-4a): a shell:true spawn's real work sits in the shell's CHILDREN,
// so killing only the direct child orphans them. v2: the child spawns
// detached (own process group) and killChild signals the GROUP
// (kill(-pid)), falling back to the direct kill when the group is gone
// (ESRCH/EPERM) or the platform has no groups (win32).
// ---------------------------------------------------------------------------

describe("F1 item 1 — process-group kill (v2)", () => {
  it("the default spawn asks for a detached child (own process group) on POSIX", async () => {
    const { rt, captures } = runtime();
    await rt.registry().start(startInput());
    expect(captures.length).toBe(1);
    expect(captures[0]!.detached).toBe(process.platform !== "win32");
    rt.stop();
  });

  // Process-group kills (kill(-pid)) need POSIX process groups — win32 has
  // none; the product falls back to the direct child kill there (pinned by
  // the "falls back" test below on every platform).
  it.skipIf(process.platform === "win32")("TTL reap group-kills with the NEGATIVE pid (never the direct child), then escalates the GROUP to SIGKILL", async () => {
    const groupKills: { pid: number; signal: string }[] = [];
    const children: FakeChild[] = [];
    const captures: SpawnCapture[] = [];
    const fw = fakeWatcher();
    let clock = 1_800_000_000_000;
    const rt = createMonitorRuntime({
      workspaceRoot: ws,
      sessionId: "s-test",
      env: {},
      now: () => clock,
      tickMs: 0,
      killGraceMs: 20,
      debounceMs: 10,
      spawn: fakeSpawner(children, captures, () => 4242),
      watch: fw.watchFn,
      killProcess: (pid, signal) => { groupKills.push({ pid, signal }); },
    });
    await rt.registry().start(startInput({ ttlMs: 60_000 }));
    clock += 60_000;
    expect(rt.tick().map((e) => e.kind)).toEqual(["ttl"]);
    // The group (pgid = child pid) got SIGTERM; the direct child.kill did NOT.
    expect(groupKills).toEqual([{ pid: -4242, signal: "SIGTERM" }]);
    expect(children[0]!.kills).toEqual([]);
    // The escalation timer still arms — after grace the GROUP gets SIGKILL.
    await wait(60);
    expect(groupKills).toEqual([
      { pid: -4242, signal: "SIGTERM" },
      { pid: -4242, signal: "SIGKILL" },
    ]);
    expect(children[0]!.kills).toEqual([]);
    rt.stop();
  });

  it("a group kill that throws (ESRCH/EPERM) falls back to the direct child kill, both signals", async () => {
    const children: FakeChild[] = [];
    const captures: SpawnCapture[] = [];
    const fw = fakeWatcher();
    let clock = 1_800_000_000_000;
    const rt = createMonitorRuntime({
      workspaceRoot: ws,
      sessionId: "s-test",
      env: {},
      now: () => clock,
      tickMs: 0,
      killGraceMs: 20,
      debounceMs: 10,
      spawn: fakeSpawner(children, captures, () => 4242),
      watch: fw.watchFn,
      killProcess: () => { throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" }); },
    });
    await rt.registry().start(startInput({ ttlMs: 60_000 }));
    clock += 60_000;
    rt.tick();
    expect(children[0]!.kills).toEqual(["SIGTERM"]); // the fallback fired
    await wait(60);
    expect(children[0]!.kills).toEqual(["SIGTERM", "SIGKILL"]); // escalation too
    rt.stop();
  });

  it("win32: no process groups — the direct child kill is used and no group kill is attempted", async () => {
    const groupKills: { pid: number; signal: string }[] = [];
    const real = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const children: FakeChild[] = [];
      const captures: SpawnCapture[] = [];
      const fw = fakeWatcher();
      const rt = createMonitorRuntime({
        workspaceRoot: ws,
        sessionId: "s-test",
        env: {},
        now: () => 1_800_000_000_000,
        tickMs: 0,
        killGraceMs: 20,
        debounceMs: 10,
        spawn: fakeSpawner(children, captures, () => 4242),
        watch: fw.watchFn,
        killProcess: (pid, signal) => { groupKills.push({ pid, signal }); },
      });
      await rt.registry().start(startInput());
      rt.stop();
      expect(groupKills).toEqual([]); // the guard ran BEFORE the seam
      expect(children[0]!.kills).toEqual(["SIGTERM"]);
      await wait(60);
      expect(children[0]!.kills).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      Object.defineProperty(process, "platform", { value: real, configurable: true });
    }
  });

  it("a pid-less child (the pre-v2 fake shape / already-reaped edge) keeps the direct kill", async () => {
    const { rt, children } = runtime(); // no pid, no killProcess injection
    await rt.registry().start(startInput({ ttlMs: 60_000 }));
    rt.stop();
    expect(children[0]!.kills).toEqual(["SIGTERM"]); // direct path, no OS call
    await wait(60);
    expect(children[0]!.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

// ---------------------------------------------------------------------------
// F1 item 2 (83) — a pending monitor payload vs a user submit in the same
// window, on the steering/prompt lane (loop.ts:1029-1043 drain over the
// run-start gate at loop.ts:794-813). Pins CURRENT designed behavior:
//   • no gate configured — the user's prompt is NOT lost and the monitor
//     payload still arrives, appended AFTER the prompt in the SAME first
//     ModelInput (append-only; the prefix stays byte-stable);
//   • an onPromptSubmit gate runs over BOTH texts, in order (the prompt at
//     run start first, the monitor payload at the drain second — the M63-A
//     "same gate" rule: a secrets blocker holds for watched output too);
//   • a gate blocking only the monitor payload DROPS it (a `steered` event
//     carries the reason) while the user's prompt survives verbatim.
// ---------------------------------------------------------------------------

describe("F1 item 2 — onPromptSubmit over a pending monitor payload", () => {
  const USER_PROMPT = "please fix the failing build";

  async function runOnce(hooks?: { onPromptSubmit: (text: string) => string | { block: true; reason: string } }): Promise<{
    inputs: ModelInput[];
    events: { type: string; text?: string; blockedReason?: string }[];
    rt: ReturnType<typeof createMonitorRuntime>;
  }> {
    const { rt, children } = runtime();
    await rt.registry().start(startInput({ conditions: { keyword: "error" } }));
    children[0]!.emitOut("error: boom\n"); // fires BEFORE the user submits
    expect(rt.pending()).toHaveLength(1); // the same-window precondition
    const model = recordingModel([{ role: "assistant", content: "on it" }]);
    const state: AgentState = {
      systemPrompt: "sp",
      messages: [{ role: "user", content: USER_PROMPT }],
      tools: [],
      status: "idle",
    };
    const gen = runAgentLoop(state, model, {
      steering: { take: () => rt.takeInjection() },
      ...(hooks !== undefined ? { hooks } : {}),
    });
    const events: { type: string; text?: string; blockedReason?: string }[] = [];
    for await (const e of gen) events.push(e as { type: string; text?: string; blockedReason?: string });
    return { inputs: model.inputs, events, rt };
  }

  const contentOf = (m: unknown): string => (typeof (m as { content?: unknown }).content === "string" ? (m as { content: string }).content : "");

  it("no gate: the user's prompt is not lost; the monitor payload lands right after it, in the same first ModelInput", async () => {
    const { inputs, rt } = await runOnce();
    expect(inputs.length).toBe(1);
    const msgs = inputs[0]!.messages;
    const userIdx = msgs.findIndex((m) => m.role === "user" && contentOf(m) === USER_PROMPT);
    const monIdx = msgs.findIndex((m) => m.role === "user" && contentOf(m).startsWith("[monitor "));
    expect(userIdx).toBeGreaterThan(-1); // not lost
    expect(monIdx).toBeGreaterThan(-1);  // still arrives
    expect(monIdx).toBe(userIdx + 1);    // appended AFTER the prompt
    expect(contentOf(msgs[monIdx!])).toContain("error: boom");
    expect(rt.pending()).toHaveLength(0); // drained exactly once
    rt.stop();
  });

  it("an onPromptSubmit gate sees BOTH texts, prompt first then the monitor payload (the M63-A same-gate rule)", async () => {
    const seen: string[] = [];
    const { inputs, rt } = await runOnce({
      onPromptSubmit: (text) => { seen.push(text); return text; },
    });
    expect(seen.length).toBe(2);
    expect(seen[0]).toBe(USER_PROMPT);       // the run-start gate fired on the prompt
    expect(seen[1]).toContain("[monitor ");  // the drain fired on the payload
    // Allow-through: both land, prompt then payload (same as the no-gate pin).
    const msgs = inputs[0]!.messages;
    const userIdx = msgs.findIndex((m) => m.role === "user" && contentOf(m) === USER_PROMPT);
    const monIdx = msgs.findIndex((m) => m.role === "user" && contentOf(m).startsWith("[monitor "));
    expect(monIdx).toBe(userIdx + 1);
    rt.stop();
  });

  it("a gate blocking ONLY the monitor payload drops it with a reasoned `steered` event; the user's prompt survives verbatim", async () => {
    const { inputs, events, rt } = await runOnce({
      onPromptSubmit: (text) =>
        text.startsWith("[monitor ") ? { block: true, reason: "watched output quarantined" } : text,
    });
    const msgs = inputs[0]!.messages;
    expect(msgs.some((m) => m.role === "user" && contentOf(m) === USER_PROMPT)).toBe(true); // survives
    expect(msgs.some((m) => m.role === "user" && contentOf(m).startsWith("[monitor "))).toBe(false); // dropped
    const blocked = events.find((e) => e.type === "steered" && e.blockedReason !== undefined);
    expect(blocked?.blockedReason).toBe("watched output quarantined");
    expect(blocked?.text).toContain("[monitor "); // the notice names the dropped payload
    rt.stop();
  });
});

describe("夜移 020 — registry.read: on-demand incremental output (live watches only)", () => {
  it("first read returns everything buffered; a drained read is empty; later output is the new bytes only", async () => {
    const { rt, children } = runtime();
    const w = await rt.registry().start(startInput());
    children[0]!.emitOut("hello\n");
    const first = rt.registry().read(w.id);
    expect(first).toEqual({ output: "hello\n", skippedBytes: 0, bufferedBytes: 6 });
    expect(rt.registry().read(w.id)).toEqual({ output: "", skippedBytes: 0, bufferedBytes: 6 });
    children[0]!.emitOut("more\n");
    expect(rt.registry().read(w.id)).toEqual({ output: "more\n", skippedBytes: 0, bufferedBytes: 11 });
    rt.stop();
  });

  it("event delivery does NOT advance the cursor — the post-wake read still carries the output", async () => {
    const { rt, children } = runtime();
    const w = await rt.registry().start(startInput({ conditions: { keyword: "FAIL" } }));
    children[0]!.emitOut("step 1 ok\nstep 2 FAIL boom\n");
    expect(rt.pending().length).toBe(1); // the keyword wake queued
    // The wake fired and may already be injected — but the model may have
    // missed it (queue-cap drops). The read is the backstop: cursor unmoved.
    const r = rt.registry().read(w.id);
    expect(r?.output).toBe("step 1 ok\nstep 2 FAIL boom\n");
    rt.stop();
  });

  it("ring overflow: skippedBytes reports the bytes the cursor lost to the front trim", async () => {
    const { rt, children } = runtime();
    const w = await rt.registry().start(startInput());
    // 70KB+" tail " through a 64KB ring: the first ~6KB falls out the front before any read.
    const written = 70 * 1024 + 6; // "a"*70K + "\ntail\n"
    children[0]!.emitOut(`${"a".repeat(70 * 1024)}\ntail\n`);
    const r = rt.registry().read(w.id);
    expect(r?.bufferedBytes).toBe(64 * 1024);
    expect(r?.skippedBytes).toBe(written - 64 * 1024);
    expect(r?.output.endsWith("tail\n")).toBe(true);
    expect(r?.output.length).toBe(64 * 1024);
    expect(rt.registry().read(w.id)?.output).toBe("");
    rt.stop();
  });

  it("an ended watch is gone: the terminal event carried the final output, read answers undefined", async () => {
    const { rt, children } = runtime();
    const w = await rt.registry().start(startInput());
    children[0]!.emitOut("last words\n");
    children[0]!.close(0);
    expect(rt.registry().read(w.id)).toBeUndefined();
    const terminal = rt.pending().at(-1);
    expect(terminal?.kind).toBe("exit");
    expect(terminal?.output).toBe("last words\n"); // the lane that carried it
    rt.stop();
  });

  it("the inert runtime's registry stub implements read as undefined", () => {
    const rt = createMonitorRuntime({ workspaceRoot: ws, sessionId: "s-inert", env: { WUDAO_DISABLE_MONITOR: "1" } });
    expect(rt.registry().read("abcd1234")).toBeUndefined();
    rt.stop();
  });
});
