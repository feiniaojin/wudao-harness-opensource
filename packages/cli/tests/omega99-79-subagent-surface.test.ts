// ω99-79 — the driver's consumer side of CHILD agent tool deltas: the run
// arms subagentUpdateBox.sink (the tools-side Task wrapper forwards every
// core-namespaced `sub:<childIdentity>:<rawId>` delta onto it — ω99-76's
// forwarding + ω99-79's box). The sink lazily builds ONE busyTools row per
// child keyed by the childIdentity SEGMENT (not the full namespaced callId:
// a child switching tools keeps one row — the tail shows the latest tool),
// folds the bounded tail with the SAME append/snapshot/cap discipline as
// parent rows (ω99-63), and the run's finally seam clears the sink —
// children have no tool_call_finished in the parent event stream, so the
// run end is their only terminal. Deterministic: gated fake model + gated
// test tool; the box injects fabricated child deltas exactly like the real
// chain would (core subagent.ts forwards with the same shape).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool } from "@wudao/core";
import type { Tool, ModelClient, ModelInput, AssistantMessage, IdentifiedOutputDelta } from "@wudao/core";
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
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "sub-surface-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });

/** The session-engine box shape: an empty single-slot object the driver
 *  writes at run start and clears at run end (stateHandle's mirror). */
type SubagentUpdateBox = { sink?: (delta: IdentifiedOutputDelta) => void };

function makeDriver(
  opts: Partial<AgentDriverOptions> & Pick<AgentDriverOptions, "model" | "tools">,
  box: SubagentUpdateBox,
): AgentDriver {
  return createAgentDriver({
    systemPrompt: "s",
    summarize: (_n: string, i: Record<string, unknown>) => JSON.stringify(i).slice(0, 60),
    subagentUpdateBox: box,
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

/** Holds the run open through the tool phase (the ω99-63 gated shape). The
 *  child deltas are injected through the BOX — the real chain is core's
 *  forwarding → the Task wrapper → box.sink; the test starts at box.sink. */
const holdTool = (name: string, gate: Promise<void>): Tool =>
  buildTool({
    name,
    description: "holds the run open",
    parameters: noParams,
    isConcurrencySafe: () => true,
    async execute() {
      await gate;
      return { content: "held" };
    },
  });

const subAppend = (child: string, rawId: string, toolName: string, text: string): IdentifiedOutputDelta =>
  ({ kind: "append", text, toolCallId: `sub:${child}:${rawId}`, toolName });
const subSnapshot = (child: string, rawId: string, toolName: string, text: string, droppedHeadBytes: number): IdentifiedOutputDelta =>
  ({ kind: "snapshot", text, droppedHeadBytes, toolCallId: `sub:${child}:${rawId}`, toolName });

const subRow = (driver: AgentDriver): { name: string; summary: string; callId?: string; tail?: string } | undefined =>
  driver.getStatus().live.busyTools.find((t) => t.name === "subagent");

describe("ω99-79 subagent activity surface (driver box consumer)", () => {
  it("arms the sink at run start; sub: deltas lazily build one subagent row; tail appends, snapshots replace, caps at 2000", async () => {
    const box: SubagentUpdateBox = {};
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const model = recording([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: {} }] },
      { role: "assistant", content: "DONE" },
    ]);
    const driver = makeDriver({ model, tools: [holdTool("shell", gate)], onPermissionAsk: allow }, box);
    driver.submit("go");
    await until(() => box.sink !== undefined, "run arms the subagent sink");
    await until(() => driver.getStatus().live.busyTools.length === 1, "parent busy row opens");

    // First child delta — the row appears LAZILY, keyed by the childIdentity
    // segment (never the full `sub:...` id).
    box.sink!(subAppend("eph-1", "call_0", "grep", "SUB-a"));
    await until(() => driver.getStatus().live.busyTools.length === 2, "subagent row opens");
    const row = subRow(driver)!;
    expect(row.callId).toBe("eph-1");
    expect(row.name).toBe("subagent");
    expect(row.summary).toBe("grep");
    expect(row.tail).toBe("SUB-a");

    // Append concatenates; snapshot replaces the whole view (63 discipline).
    box.sink!(subAppend("eph-1", "call_0", "grep", "SUB-b"));
    await until(() => subRow(driver)?.tail === "SUB-aSUB-b", "append tail");
    box.sink!(subSnapshot("eph-1", "call_0", "grep", "SNAP", 12));
    await until(() => subRow(driver)?.tail === "SNAP", "snapshot tail");
    // Over-cap append clips to the LAST cap chars (O(1) bounded tail).
    box.sink!(subAppend("eph-1", "call_0", "grep", "z".repeat(3000)));
    await until(() => subRow(driver)?.tail?.length === 2000, "cap tail");
    expect(subRow(driver)?.tail).toBe("z".repeat(2000));

    release();
    await until(() => driver.getStatus().busy === false, "run to finish");
    driver.dispose();
  });

  it("the same child switching tools keeps ONE row — summary tracks the latest toolName, the tail continues", async () => {
    const box: SubagentUpdateBox = {};
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const model = recording([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: {} }] },
      { role: "assistant", content: "DONE" },
    ]);
    const driver = makeDriver({ model, tools: [holdTool("shell", gate)], onPermissionAsk: allow }, box);
    driver.submit("go");
    await until(() => box.sink !== undefined, "sink armed");
    await until(() => driver.getStatus().live.busyTools.length === 1, "parent busy row opens");

    box.sink!(subAppend("eph-1", "call_0", "read_file", "AAA"));
    await until(() => subRow(driver) !== undefined, "first tool row");
    box.sink!(subAppend("eph-1", "call_1", "edit", "BBB"));
    await until(() => subRow(driver)?.summary === "edit", "summary tracks the latest tool");

    // ONE row per child — the rawId change (call_0 → call_1) did not fork it.
    expect(driver.getStatus().live.busyTools.filter((t) => t.name === "subagent")).toHaveLength(1);
    expect(subRow(driver)?.callId).toBe("eph-1");
    expect(subRow(driver)?.tail).toBe("AAABBB");

    release();
    await until(() => driver.getStatus().busy === false, "run to finish");
    driver.dispose();
  });

  it("two concurrent children hold two independent rows — no tail cross-talk", async () => {
    const box: SubagentUpdateBox = {};
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const model = recording([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: {} }] },
      { role: "assistant", content: "DONE" },
    ]);
    const driver = makeDriver({ model, tools: [holdTool("shell", gate)], onPermissionAsk: allow }, box);
    driver.submit("go");
    await until(() => box.sink !== undefined, "sink armed");
    await until(() => driver.getStatus().live.busyTools.length === 1, "parent busy row opens");

    box.sink!(subAppend("eph-1", "call_0", "grep", "A1"));
    await until(() => subRow(driver) !== undefined, "child 1 row");
    box.sink!(subAppend("eph-2", "call_0", "write_file", "B1"));
    await until(() => driver.getStatus().live.busyTools.filter((t) => t.name === "subagent").length === 2, "child 2 row");
    // child 1 switches tools — its row grows, child 2's tail is untouched.
    box.sink!(subAppend("eph-1", "call_1", "edit", "A2"));
    await until(() => driver.getStatus().live.busyTools.find((t) => t.callId === "eph-1")?.tail === "A1A2", "child 1 tail");

    const byChild = new Map(driver.getStatus().live.busyTools.filter((t) => t.name === "subagent").map((t) => [t.callId, t]));
    expect(byChild.get("eph-1")?.tail).toBe("A1A2");
    expect(byChild.get("eph-1")?.summary).toBe("edit");
    expect(byChild.get("eph-2")?.tail).toBe("B1");
    expect(byChild.get("eph-2")?.summary).toBe("write_file");

    release();
    await until(() => driver.getStatus().busy === false, "run to finish");
    driver.dispose();
  });

  it("run end clears the sink and drops every subagent row; the next run re-arms (serial overwrite)", async () => {
    const box: SubagentUpdateBox = {};
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let release2!: () => void;
    const gate2 = new Promise<void>((r) => { release2 = r; });
    const model = recording([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: {} }] },
      { role: "assistant", content: "DONE" },
      { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "grep", arguments: {} }] },
      { role: "assistant", content: "DONE2" },
    ]);
    // The second run also holds through its tool phase — a tool-less run
    // arms and clears within one microtask chain, unobservable by polling.
    const driver = makeDriver(
      { model, tools: [holdTool("shell", gate), holdTool("grep", gate2)], onPermissionAsk: allow },
      box,
    );
    driver.submit("go");
    await until(() => box.sink !== undefined, "sink armed");
    await until(() => driver.getStatus().live.busyTools.length === 1, "parent busy row opens");
    box.sink!(subAppend("eph-1", "call_0", "grep", "ORPHAN"));
    await until(() => subRow(driver) !== undefined, "subagent row opens");

    release();
    await until(() => driver.getStatus().busy === false, "run to finish");
    // Children have no tool_call_finished — the run's settle is their only
    // terminal: the busyTools reset drops the row AND the sink is unarmed.
    expect(box.sink).toBeUndefined();
    expect(driver.getStatus().live.busyTools.filter((t) => t.name === "subagent")).toEqual([]);
    expect(driver.getStatus().live.busyTools).toEqual([]);

    // The next run re-arms (run-scoped, serially overwritten — never stale).
    driver.submit("again");
    await until(() => box.sink !== undefined, "second run re-arms the sink");
    await until(() => driver.getStatus().live.busyTools.some((t) => t.callId === "c2"), "second run tool phase");
    release2();
    await until(() => driver.getStatus().busy === false, "second run to finish");
    expect(box.sink).toBeUndefined();
    driver.dispose();
  });

  it("a non-sub: delta reaching the sink is ignored — no row, no tail (the parent sink owns those, byte-identically)", async () => {
    const box: SubagentUpdateBox = {};
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const model = recording([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: {} }] },
      { role: "assistant", content: "DONE" },
    ]);
    const driver = makeDriver({ model, tools: [holdTool("shell", gate)], onPermissionAsk: allow }, box);
    driver.submit("go");
    await until(() => box.sink !== undefined, "sink armed");
    await until(() => driver.getStatus().live.busyTools.length === 1, "parent busy row opens");

    // A bare parent-shaped id routed at the box: the sub: guard declines —
    // the row stays untouched (its tail would otherwise be "PARENT-LEAK").
    box.sink!({ kind: "append", text: "PARENT-LEAK", toolCallId: "c1", toolName: "shell" });
    await wait(50);
    const rows = driver.getStatus().live.busyTools;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.callId).toBe("c1");
    expect(rows[0]?.tail).toBeUndefined();
    expect(rows.filter((t) => t.name === "subagent")).toEqual([]);

    release();
    await until(() => driver.getStatus().busy === false, "run to finish");
    driver.dispose();
  });
});
