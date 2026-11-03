// det-65-night-porting-8 — the deterministic behavior pins for 夜移 020
// (monitor_read: on-demand incremental output, real CC's BashOutput
// paradigm). The feature landed with core + cli unit tests (the tool's
// formatting/error/refusal surface over a scripted registry; the runtime's
// absLen/readCursor math over fakes incl. ring-overflow skippedBytes and
// the live-watches-only boundary); this suite pays the det-44-style debt
// the same way det-57..det-64 did — the DRIVER-level behavior pinned inside
// the release-eval matrix, so a regression fails the release evals, not
// just a package test someone might not run. Zero network, zero real
// processes (spawn/watch seams injected).
//
//   ① quartet        the run's tool list carries monitor_read as the 4th
//                    monitor tool (trio prefix byte-stable, M24);
//   ② increment      output emitted between turns is readable on demand:
//                    the monitor_read result rides the NEXT ModelInput as a
//                    tool message with the +N bytes header;
//   ③ drained        a read with nothing new says so (buffered N bytes);
//   ④ end lane       an ended watch's final output rides its terminal
//                    EVENT (the read lane is gone — registry.read
//                    undefined; the tool would answer the monitor_list
//                    pointer).
import { createAgentDriver } from "wudao-harness/driver/agent-driver";
import { createMonitorRuntime } from "wudao-harness/monitor";
import { summarizeToolCall } from "wudao-harness/log";
import { createMonitorTools } from "@wudao-org/core";
import type { AgentDriver } from "wudao-harness/driver/agent-driver";
import type { MonitorRuntimeOptions, MonitorChild } from "wudao-harness/monitor";
import type { AgentMessage, AssistantMessage, ModelClient, ModelInput } from "@wudao-org/core";
import type { EvalDefinition } from "../runner.js";

export interface NightPorting8Evidence {
  // ① quartet
  readonly readToolRegistered: boolean;
  readonly monitorToolCount: number;
  // ② increment
  readonly startReceiptLands: boolean;
  readonly incrementVisibleNextTurn: boolean;
  readonly incrementHeaderCarriesBytes: boolean;
  // ③ drained
  readonly drainedReadSaysNoNew: boolean;
  // ④ end lane
  readonly endedReadUndefined: boolean;
  readonly terminalCarriesFinalOutput: boolean;
}

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, what: string, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  await wait();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
  return true;
}

/** The fake child + spawner (the cli tests' shape): capture-only spawn,
 *  scripted emitOut — no real process ever exists. */
function fakeSpawn(): { spawn: MonitorRuntimeOptions["spawn"]; emit(i: number, text: string): void; close(i: number, code: number | null): void } {
  const children: { out: ((c: string | Buffer) => void)[]; close: ((code: number | null, signal: string | null) => void)[] }[] = [];
  return {
    spawn: (_command, _opts) => {
      const out: ((c: string | Buffer) => void)[] = [];
      const close: ((code: number | null, signal: string | null) => void)[] = [];
      children.push({ out, close });
      const dataStream = (ls: typeof out) => ({ on: (_e: "data", l: (c: string | Buffer) => void) => { ls.push(l); } });
      const child: MonitorChild = {
        stdout: dataStream(out),
        stderr: dataStream([]),
        onClose: (l) => { close.push(l); },
        onError: () => {},
        kill: () => true,
      };
      return child;
    },
    emit: (i, text) => { for (const l of children[i]!.out) l(Buffer.from(text, "utf8")); },
    close: (i, code) => { for (const l of children[i]!.close) l(code, null); },
  };
}

const toolResultTexts = (msgs: readonly AgentMessage[]): string[] =>
  msgs.filter((m) => m.role === "tool").map((m) => String((m as { content?: unknown }).content ?? ""));

export const det65Eval: EvalDefinition<Record<string, never>, NightPorting8Evidence> = {
  name: "det-65-night-porting-8",
  kind: "deterministic",
  async setup() {
    return {};
  },
  async run(): Promise<NightPorting8Evidence> {
    const fs = fakeSpawn();
    // Fake spawn/watch seams make the workspaceRoot inert — "." never moves.
    const rt = createMonitorRuntime({
      workspaceRoot: ".",
      sessionId: "s-det65",
      env: {},
      tickMs: 0,
      killGraceMs: 20,
      spawn: fs.spawn,
      watch: () => ({ close: () => {} }),
    });
    try {
      // The dynamic scripted model: turn 2 (the first read turn) is gated so
      // the test can emit child output BETWEEN turns — the exact window the
      // feature exists for (latch fired / no event; the model reads on
      // demand). Every ModelInput is recorded at entry.
      const inputs: ModelInput[] = [];
      let call = 0;
      let release2!: () => void;
      const gate2 = new Promise<void>((r) => { release2 = r; });
      const watchId = () => rt.registry().list()[0]?.id ?? "";
      const model: ModelClient = {
        async generate(input: ModelInput): Promise<AssistantMessage> {
          call += 1;
          inputs.push({ ...input, messages: input.messages.map((m) => ({ ...m })), tools: input.tools });
          if (call === 2) await gate2; // held until the child emitted
          if (call === 1) {
            return { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "monitor_start", arguments: { kind: "command", command: "npm test" } }] };
          }
          if (call === 2 || call === 3) {
            return { role: "assistant", content: "", toolCalls: [{ id: `t${call}`, name: "monitor_read", arguments: { id: watchId() } }] };
          }
          return { role: "assistant", content: "done" };
        },
      };
      const driver: AgentDriver = createAgentDriver({
        model,
        // The monitor tools join the toolset the way repl.ts registers them
        // (session start, fixed position). Deliberately NO `monitor: rt`
        // here: connecting the steering lane would also hand the driver
        // runtime ownership (dispose → monitor.stop()), and the idle poll
        // would race the terminal event out of rt.pending(). The event-lane
        // delivery itself is ω-4a's pinned ground (cli §5.cli-2/9); this
        // suite pins the READ lane.
        tools: createMonitorTools({ registry: rt.registry() }),
        systemPrompt: "sp",
        summarize: summarizeToolCall,
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
      driver.submit("watch the tests");
      await until(() => inputs.length === 2, "read turn reached");
      fs.emit(0, "server ready\nlistening on 3000\n");
      release2();
      await until(() => driver.getStatus().busy === false, "run finished");
      driver.dispose();

      // ① the quartet on the wire.
      const run1Tools = inputs[0]?.tools?.map((t) => t.name) ?? [];
      const readToolRegistered = run1Tools.includes("monitor_read");
      const monitorToolCount = run1Tools.filter((n) => n.startsWith("monitor_")).length;

      // ②③ the results as the model saw them.
      const turn3Results = toolResultTexts(inputs[2]?.messages ?? []); // read #1's result
      const turn4Results = toolResultTexts(inputs[3]?.messages ?? []); // read #2's result
      const read1 = turn3Results.at(-1) ?? "";
      const read2 = turn4Results.at(-1) ?? "";
      const startReceiptLands = (toolResultTexts(inputs[1]?.messages ?? []).at(-1) ?? "").includes("armed");
      const incrementVisibleNextTurn = read1.includes("server ready\nlistening on 3000\n");
      const incrementHeaderCarriesBytes = /\+3\d bytes/.test(read1);
      const drainedReadSaysNoNew = read2.includes("no new output");

      // ④ the end lane: terminal event carries the final output; read is gone.
      fs.emit(0, "last words\n");
      fs.close(0, 0);
      await until(() => rt.pending().some((e) => e.kind === "exit"), "terminal queued");
      const endedReadUndefined = rt.registry().read(watchId()) === undefined;
      const terminal = rt.pending().find((e) => e.kind === "exit");
      const terminalCarriesFinalOutput = terminal?.output === "server ready\nlistening on 3000\nlast words\n";

      return {
        readToolRegistered,
        monitorToolCount,
        startReceiptLands,
        incrementVisibleNextTurn,
        incrementHeaderCarriesBytes,
        drainedReadSaysNoNew,
        endedReadUndefined,
        terminalCarriesFinalOutput,
      };
    } finally {
      rt.stop();
    }
  },
  assertions(e) {
    const errs: string[] = [];
    const need = (ok: boolean, msg: string) => { if (!ok) errs.push(msg); };

    need(e.readToolRegistered, "① monitor_read must be registered on the run's tool list");
    need(e.monitorToolCount === 4, `① exactly 4 monitor tools expected (trio prefix byte-stable + read), got ${e.monitorToolCount}`);
    need(e.startReceiptLands, "② monitor_start's receipt must land as a tool result the model sees");
    need(e.incrementVisibleNextTurn, "② output emitted between turns must be readable on demand in the next turn's tool result");
    need(e.incrementHeaderCarriesBytes, "② the increment's header must carry the +N bytes count");
    need(e.drainedReadSaysNoNew, "③ a drained read must say no new output");
    need(e.endedReadUndefined, "④ an ended watch's read must answer undefined (live watches only)");
    need(e.terminalCarriesFinalOutput, "④ the terminal event must carry the final ring as its output");

    return errs;
  },
};
