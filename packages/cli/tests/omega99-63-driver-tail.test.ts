// ω99-63 — the driver's consumer side of onToolUpdate: the run's identified
// deltas land on the busyTools row (per-call bounded tail), the existing
// fields stay byte-identical, and the tail never leaks into history or the
// model-visible face. Deterministic: gated fake model + gated test tool.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool } from "@wudao-org/core";
import type { Tool, ModelClient, ModelInput, AssistantMessage, ToolUpdateFn } from "@wudao-org/core";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriverOptions, AgentDriver } from "../src/driver/agent-driver.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const allow = async () => ({ kind: "allow" as const });

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "tail-drv-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });

function makeDriver(opts: Partial<AgentDriverOptions> & Pick<AgentDriverOptions, "model" | "tools">): AgentDriver {
  return createAgentDriver({
    systemPrompt: "s",
    summarize: (_n: string, i: Record<string, unknown>) => JSON.stringify(i).slice(0, 60),
    ...opts,
  });
}

function recording(responses: readonly AssistantMessage[]): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let call = 0;
  const model: ModelClient & { inputs: ModelInput[] } = {
    inputs,
    async generate(input: ModelInput) {
      inputs.push({ ...input, messages: [...input.messages] });
      const r = responses[call];
      call += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
  return model;
}

const noParams = { type: "object" as const, properties: {}, additionalProperties: false };

const TAIL_CAP = 2000;

/** A streaming tool whose beats the TEST releases gate-by-gate — each gate
 *  resolves after the assertion on the PREVIOUS beat, so the tail's per-beat
 *  evolution is observed deterministically. */
function gatedStreamTool(name: string, marker: string, gates: Promise<void>[]) {
  return buildTool({
    name,
    description: `streams ${marker}`,
    parameters: noParams,
    isConcurrencySafe: () => true,
    async execute(_args: Record<string, unknown>, onUpdate?: ToolUpdateFn) {
      onUpdate?.({ kind: "append", text: `${marker}-beat1` });
      await gates[0];
      onUpdate?.({ kind: "append", text: `${marker}-beat2` });
      await gates[1];
      onUpdate?.({ kind: "snapshot", text: `${marker}-whole`, droppedHeadBytes: 9 });
      await gates[2];
      onUpdate?.({ kind: "append", text: "y".repeat(3000) });
      await gates[3];
      return { content: `${marker} done` };
    },
  });
}
describe("ω99-63 driver busyTools tail (consumer side)", () => {
  it("the tail evolves append→append→snapshot(whole-replace) and caps at 2000 chars; existing fields byte-identical", async () => {
    let g0!: () => void; let g1!: () => void; let g2!: () => void; let g3!: () => void;
    const gates = [
      new Promise<void>((r) => { g0 = r; }),
      new Promise<void>((r) => { g1 = r; }),
      new Promise<void>((r) => { g2 = r; }),
      new Promise<void>((r) => { g3 = r; }),
    ];
    const stream = gatedStreamTool("shell", "TAIL", gates);
    const model = recording([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: {} }] },
      { role: "assistant", content: "DONE" },
    ]);
    const driver = makeDriver({ model, tools: [stream], onPermissionAsk: allow });
    driver.submit("go");
    await until(() => driver.getStatus().live.busyTools.length === 1, "tool phase opens");

    // beat 1 — append lands; the row keeps its existing fields and carries callId.
    await until(() => driver.getStatus().live.busyTools[0]?.tail === "TAIL-beat1", "beat1 tail");
    const row = driver.getStatus().live.busyTools[0]!;
    expect(row.name).toBe("shell");
    expect(row.summary).toBe("{}");
    expect(row.callId).toBe("c1");
    g0();
    // beat 2 — append concatenates.
    await until(() => driver.getStatus().live.busyTools[0]?.tail === "TAIL-beat1TAIL-beat2", "beat2 tail");
    g1();
    // beat 3 — snapshot REPLACES the whole view.
    await until(() => driver.getStatus().live.busyTools[0]?.tail === "TAIL-whole", "snapshot tail");
    g2();
    // beat 4 — over-cap append clips to the LAST cap chars (O(1) bounded tail).
    await until(() => driver.getStatus().live.busyTools[0]?.tail?.length === TAIL_CAP, "cap tail");
    expect(driver.getStatus().live.busyTools[0]?.tail).toBe("y".repeat(TAIL_CAP));
    g3();

    await until(() => driver.getStatus().busy === false, "run to finish");
    expect(driver.getStatus().live.busyTools).toEqual([]);
    driver.dispose();
  });

  it("two parallel calls: each tail lands on its OWN row (callId match)", async () => {
    const mkGates = () => {
      const rs: (() => void)[] = [];
      const ps = [0, 1, 2, 3].map(() => new Promise<void>((r) => { rs.push(r); }));
      return { ps, rs };
    };
    const a = mkGates(); const b = mkGates();
    const toolA = gatedStreamTool("fan_a", "AAA", a.ps);
    const toolB = gatedStreamTool("fan_b", "BBB", b.ps);
    const model = recording([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "pa-1", name: "fan_a", arguments: {} },
          { id: "pb-2", name: "fan_b", arguments: {} },
        ],
      },
      { role: "assistant", content: "DONE" },
    ]);
    const driver = makeDriver({ model, tools: [toolA, toolB], onPermissionAsk: allow });
    driver.submit("go");
    await until(() => driver.getStatus().live.busyTools.length === 2, "both rows open");
    await until(() => driver.getStatus().live.busyTools.every((t) => t.tail !== undefined), "both first beats");
    const byCall = new Map(driver.getStatus().live.busyTools.map((t) => [t.callId, t]));
    expect(byCall.get("pa-1")?.tail).toBe("AAA-beat1");
    expect(byCall.get("pb-2")?.tail).toBe("BBB-beat1");
    a.rs[0]!();
    await until(() => driver.getStatus().live.busyTools.find((t) => t.callId === "pa-1")?.tail === "AAA-beat1AAA-beat2", "A beat2");
    expect(driver.getStatus().live.busyTools.find((t) => t.callId === "pb-2")?.tail).toBe("BBB-beat1");
    a.rs[1]!(); a.rs[2]!(); a.rs[3]!(); b.rs[0]!(); b.rs[1]!(); b.rs[2]!(); b.rs[3]!();
    await until(() => driver.getStatus().busy === false, "run to finish");
    driver.dispose();
  });

  it("tail bytes never enter history or the model-visible face (M24)", async () => {
    const gates = [
      Promise.resolve(), Promise.resolve(), Promise.resolve(),
    ];
    const stream = gatedStreamTool("shell", "SECRET", gates);
    const model = recording([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: {} }] },
      { role: "assistant", content: "DONE" },
    ]);
    const driver = makeDriver({ model, tools: [stream], onPermissionAsk: allow });
    driver.submit("go");
    await until(() => driver.getStatus().busy === false, "run to finish");
    const history = JSON.stringify(driver.getHistory());
    expect(history).not.toContain("SECRET-beat1");
    expect(history).not.toContain("SECRET-beat2");
    expect(history).not.toContain("SECRET-whole");
    const face = JSON.stringify(model.inputs);
    expect(face).not.toContain("SECRET-beat1");
    expect(face).not.toContain("SECRET-beat2");
    expect(face).not.toContain("SECRET-whole");
    driver.dispose();
  });
});
