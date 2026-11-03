// M45 — the sidecar's driver surfaces: the status snapshot (checks/breaker,
// the status-bar `sidecar N` / `🛡✕` source), the busyTools gating badge
// (🛡 检查中 while the classifier is in flight), the per-run breaker reset
// at submit time, and the sidecar reason riding a parked permission ask.
import { describe, it, expect, vi } from "vitest";
import { buildTool, createScriptedModel } from "@wudao-org/core";
import type { ModelClient, ModelInput, PermissionDecision, Tool } from "@wudao-org/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";
import { withSidecarLayer } from "../src/permission.js";
import { createSidecar } from "../src/sidecar.js";
import type { Sidecar } from "../src/sidecar.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

/** A sidecar model whose reply parks on a release (assert mid-flight state). */
function parkedSidecarModel(release: Promise<void>): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  return {
    inputs,
    async generate(input: ModelInput) {
      inputs.push(input);
      await release;
      return { role: "assistant", content: '{"risk":"low","reason":"routine"}' };
    },
  };
}

function scriptedSidecarModel(replies: readonly string[]): ModelClient & { calls: () => number } {
  let n = 0;
  return {
    calls: () => n,
    async generate(_input: ModelInput) {
      const content = replies[n % replies.length] ?? '{"risk":"low","reason":"ok"}';
      n += 1;
      return { role: "assistant", content };
    },
  };
}

function stubWriteTool(): Tool {
  return buildTool({
    name: "write_file",
    description: "stub write",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    execute: async () => ({ content: "wrote" }),
  });
}

/** #452: the loop's verify stop-gate (loop.ts: "code changes were made but
 *  nothing was run since") re-opens the loop when writes EXECUTED — under
 *  托付 they always do — so scripts that write must run something before
 *  their final answer or the run eats extra turns hunting a verification. */
function stubRunTool(): Tool {
  return buildTool({
    name: "shell",
    description: "stub run",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
    execute: async () => ({ content: "ok" }),
  });
}

/** The one-turn write_file script. */
const writeTurn = (id: string, path: string) => [
  { role: "assistant", content: "", toolCalls: [{ id, name: "write_file", arguments: { path, content: "x" } }] },
  { role: "assistant", content: "DONE" },
];

/** N write_file tool-call turns + one final answer (a flat script — each
 *  tool-call turn is one model response; only the LAST entry answers). */
function writeRun(paths: readonly string[]): { role: "assistant"; content: string; toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[] }[] {
  return [
    ...paths.map((path, i) => ({
      role: "assistant" as const,
      content: "",
      toolCalls: [{ id: `c${i + 1}`, name: "write_file", arguments: { path, content: "x" } }],
    })),
    { role: "assistant" as const, content: "DONE" },
  ];
}

/** A driver wired like ui.ts/app.tsx: sidecar layer + driver-owned escalation. */
function makeSidecarDriver(args: {
  sidecar: Sidecar;
  escalate?: (toolName: string, ctx: { circuitOpen: boolean; reason?: string }) => Promise<PermissionDecision>;
  mainTurns: readonly { role: "assistant"; content: string; toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[] }[];
  mode?: "auto" | "default" | "read-only";
}): { driver: AgentDriver; sidecar: Sidecar } {
  const box: { driver?: AgentDriver } = {};
  const deny: PermissionDecision = { behavior: "deny", reason: "sidecar" };
  const gate = withSidecarLayer(
    {
      sidecar: args.sidecar,
      getMode: () => box.driver?.getMode() ?? args.mode ?? "auto",
      escalate: (toolName, input, ctx) =>
        args.escalate
          ? args.escalate(toolName, ctx)
          : Promise.resolve(deny).then(() =>
              box.driver ? box.driver.ask(toolName, input, { sidecarReason: ctx.circuitOpen ? undefined : ctx.reason }) : { behavior: "deny" as const, reason: "no driver" },
            ),
      receipt: (line) => box.driver?.notify(line),
      onGating: (toolName, on) => box.driver?.setGating(toolName, on),
    },
    async (_toolName, _input) => ({ behavior: "allow" as const }),
  );
  const driver = createAgentDriver({
    model: createScriptedModel([...args.mainTurns]),
    tools: [stubWriteTool(), stubRunTool()],
    systemPrompt: "s",
    summarize: summarizeToolCall,
    canUseTool: gate,
    mode: args.mode ?? "auto",
    sidecar: args.sidecar,
  });
  box.driver = driver;
  return { driver, sidecar: args.sidecar };
}

describe("AgentDriver sidecar surfaces (M45)", () => {
  it("status.sidecar is null without a sidecar instance", async () => {
    const driver = createAgentDriver({
      model: createScriptedModel([{ role: "assistant", content: "ok" }]),
      tools: [],
      systemPrompt: "s",
      summarize: summarizeToolCall,
    });
    expect(driver.getStatus().sidecar).toBeNull();
    driver.dispose();
  });

  it("the gating badge shows while the classifier is in flight and clears when the verdict lands", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const sidecar = createSidecar({ model: parkedSidecarModel(gate), breakerThreshold: 3 });
    const { driver } = makeSidecarDriver({ sidecar, mainTurns: writeTurn("c1", "a.txt") });

    driver.submit("go");
    await until(() => driver.getStatus().live.busyTools.length > 0, "busy tool to appear");
    await until(() => driver.getStatus().live.busyTools[0]?.gating === true, "gating badge to light up");
    release();
    await until(() => driver.getStatus().busy === false, "run to finish");

    const live = driver.getStatus().live;
    expect(live.busyTools).toEqual([]);
    // The write executed (low verdict) and the counter rode the snapshot.
    expect(driver.getHistory().some((h) => h.kind === "tool" && !h.isError)).toBe(true);
    expect(driver.getStatus().sidecar).toEqual({ checks: 1, breakerOpen: false });
    driver.dispose();
  });

  it("an open breaker surfaces in the status snapshot and a fresh submit resets it (#452: 托付不打断)", async () => {
    const sidecar = createSidecar({ model: scriptedSidecarModel(['{"risk":"high","reason":"dangerous"}']), breakerThreshold: 3 });
    const escalated = vi.fn(() => Promise.resolve({ behavior: "deny" as const, reason: "sidecar" }));
    // Run 1: five writes + a run (satisfies the verify stop-gate — see
    // stubRunTool) + the answer; run 2: one more write + run + answer. Every
    // call is a scripted high verdict: under #452 托付 all of them execute.
    const w = (id: string, path: string) => ({ role: "assistant" as const, content: "", toolCalls: [{ id, name: "write_file", arguments: { path, content: "x" } }] });
    const r = (id: string) => ({ role: "assistant" as const, content: "", toolCalls: [{ id, name: "shell", arguments: { command: "echo ok" } }] });
    const { driver } = makeSidecarDriver({
      sidecar,
      escalate: (_t, ctx) => escalated(ctx),
      mainTurns: [
        w("c1", "a.txt"), w("c2", "b.txt"), w("c3", "c.txt"), w("c4", "d.txt"), w("c5", "e.txt"),
        r("r1"),
        { role: "assistant", content: "DONE" },
        w("c6", "f.txt"),
        r("r2"),
        { role: "assistant", content: "DONE2" },
      ],
    });

    driver.submit("go");
    await until(() => driver.getStatus().busy === false, "run to finish");
    // 3 consecutive highs opened the breaker; writes 4-5 and the run skipped
    // the classifier entirely. #452: every verdict path ALLOWS — the
    // escalation seam is never consulted, the audit rides the receipts.
    expect(driver.getStatus().sidecar).toEqual({ checks: 3, breakerOpen: true });
    expect(escalated).toHaveBeenCalledTimes(0);
    // All six calls EXECUTED (five writes + the verify run) — auto 托付 keeps
    // running through high verdicts and an open breaker alike.
    expect(driver.getHistory().filter((h) => h.kind === "tool").length).toBe(6);
    expect(driver.getHistory().every((h) => h.kind !== "tool" || !h.isError)).toBe(true);

    // A fresh submit resets the run state (§1.5 run-boundary reset): run 2's
    // write and run classify from zero — without the reset the breaker would
    // still be open and the classifier skipped entirely.
    driver.submit("again");
    await until(() => driver.getStatus().busy === false && driver.getHistory().some((h) => h.kind === "user" && h.text === "again"), "second run to finish");
    expect(driver.getStatus().sidecar).toEqual({ checks: 2, breakerOpen: false });
    driver.dispose();
  });

  it("a high verdict auto-allows with the audit receipt — no ask parks (frontend-less path, #452)", async () => {
    const sidecar = createSidecar({ model: scriptedSidecarModel(['{"risk":"high","reason":"rm -rf is destructive"}']), breakerThreshold: 99 });
    const { driver } = makeSidecarDriver({ sidecar, mainTurns: writeTurn("c1", "a.txt") });
    driver.submit("go");
    await until(() => driver.getStatus().busy === false, "run to finish");
    // 托付不打断：nothing parks, the tool runs, the verdict rides a notice.
    expect(driver.getStatus().pendingPermission).toBeNull();
    const toolEntry = driver.getHistory().find((h) => h.kind === "tool");
    expect(toolEntry).toMatchObject({ kind: "tool", isError: false });
    driver.dispose();
  });
});
