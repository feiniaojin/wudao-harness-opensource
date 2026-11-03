// ω99-82 — the TUI's subagent-delta box wiring (79's concern-1 payoff).
// ω99-79 landed subagentUpdateBox in the DRIVER (box.sink armed at run start,
// cleared at the run's finally seam) and wired BOTH driver-based frontends
// (web ui + Slack through session-engine.ts :653/:700/:808). The TUI was the
// dead lane: app.tsx built its tool set with NO box (the task tool forwarded
// child deltas onto nothing) and use-agent.ts's createAgentDriver(opts) had
// no box to arm. These cases pin the TUI's isomorph — the SAME box instance
// reaching BOTH seams (the tool set's task tool AND the driver), the instance
// surviving re-renders (a per-render rebuild would orphan an armed sink
// mid-run), and the end-to-end surface: a `sub:` delta injected at the armed
// box opens a subagent busyTools row in the rendered frame (77's LiveArea
// tail line — zero render changes), and the run's settle clears the sink.
// The construction-site recording idiom is m80-resolver-wiring's (vi.mock
// wraps the site fn, records opts, delegates to the real one); the delta
// injection idiom is ω99-79's (the box IS the real chain's entry point).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool } from "@wudao-org/core";
import type { Tool, ModelClient, ModelInput, AssistantMessage, IdentifiedOutputDelta } from "@wudao-org/core";
import type { ProviderConfig } from "@wudao-org/providers";
import { WudaoApp } from "../src/tui/app.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait(20);
  }
}

// Every construction site's opts, in call order (the m80 recording idiom).
const { toolSetOpts, driverOpts } = vi.hoisted(() => ({
  toolSetOpts: [] as Array<Record<string, unknown>>,
  driverOpts: [] as Array<Record<string, unknown>>,
}));

vi.mock("../src/tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools.js")>();
  return {
    ...actual,
    buildToolSet: (opts: Record<string, unknown>) => {
      toolSetOpts.push(opts);
      return actual.buildToolSet(opts as Parameters<typeof actual.buildToolSet>[0]);
    },
  };
});

vi.mock("../src/driver/agent-driver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/driver/agent-driver.js")>();
  return {
    ...actual,
    createAgentDriver: (opts: Record<string, unknown>) => {
      driverOpts.push(opts);
      return actual.createAgentDriver(opts as Parameters<typeof actual.createAgentDriver>[0]);
    },
  };
});

const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };

/** A scripted, call-indexed model (79's recording shape): the TUI lane never
 *  auto-titles (that flag rides session-engine only), so the script's order
 *  IS the conversation's order. */
function scriptedModel(responses: readonly AssistantMessage[]): ModelClient {
  let call = 0;
  return {
    async generate(input: ModelInput): Promise<AssistantMessage> {
      void input;
      const r = responses[call];
      call += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

const noParams = { type: "object" as const, properties: {}, additionalProperties: false };

/** Holds the run open through the tool phase (79's gated shape) — the box
 *  deltas are injected while the parent's own busy row is on screen. */
const holdTool = (name: string, gate: Promise<void>): Tool =>
  buildTool({
    name,
    description: "holds the run open",
    parameters: noParams,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute() {
      await gate;
      return { content: "held" };
    },
  });

const subAppend = (child: string, rawId: string, toolName: string, text: string): IdentifiedOutputDelta =>
  ({ kind: "append", text, toolCallId: `sub:${child}:${rawId}`, toolName });

type Box = { sink?: (delta: IdentifiedOutputDelta) => void };

// ink-testing-library delivers a multi-char stdin.write as ONE input chunk —
// text must be fed character by character (persona-wiring's idiom); "\r"
// alone parses as the return key.
async function type(stdin: { write(s: string): void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await wait(15);
  }
}

const roots: string[] = [];
beforeEach(() => {
  toolSetOpts.length = 0;
  driverOpts.length = 0;
});
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("ω99-82 — TUI subagent-delta box wiring (79's third frontend)", () => {
  it("assembly: ONE box instance reaches BOTH the tool set and the driver (identity), stable across re-renders", async () => {
    const root = mkdtempSync(join(tmpdir(), "om82-wire-"));
    roots.push(root);
    const model = scriptedModel([{ role: "assistant", content: "ok", stopReason: "end_turn" }]);
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64_000} modelOverride={model} />,
    );
    await wait();
    // The driver is created exactly once (useAgent's lazy ref) — with the box.
    expect(driverOpts).toHaveLength(1);
    const driverBox = driverOpts[0]!.subagentUpdateBox as Box | undefined;
    expect(driverBox).toBeDefined(); // RED on base: undefined — the dead lane.
    // The tool set memo ran at mount and injected the SAME instance (79's
    // two-seam isomorph — task tool and driver share one box).
    expect(toolSetOpts.length).toBeGreaterThanOrEqual(1);
    for (const o of toolSetOpts) expect(o.subagentUpdateBox).toBe(driverBox);
    // Re-render with a changed memo dep (props.extraTools) rebuilds the tool
    // set — the box instance must SURVIVE (a per-render rebuild would orphan
    // an armed sink mid-run; the useRef is the stability contract).
    const before = toolSetOpts.length;
    inst.rerender(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64_000} modelOverride={model} extraTools={[holdTool("om82_probe", Promise.resolve())]} />,
    );
    await wait();
    expect(toolSetOpts.length).toBeGreaterThan(before);
    for (const o of toolSetOpts) expect(o.subagentUpdateBox).toBe(driverBox);
    inst.unmount();
  });

  it("end-to-end: a sub: delta at the armed box opens a subagent row in the frame; run settle clears the sink", async () => {
    const root = mkdtempSync(join(tmpdir(), "om82-e2e-"));
    roots.push(root);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const model = scriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "om82_hold", arguments: {} }] },
      { role: "assistant", content: "DONE-82", stopReason: "end_turn" },
    ]);
    const inst = render(
      <WudaoApp
        config={config}
        workspaceRoot={root}
        contextWindowTokens={64_000}
        modelOverride={model}
        extraTools={[holdTool("om82_hold", gate)]}
        initialPermissionMode="auto"
      />,
    );
    await wait();
    const box = driverOpts[0]!.subagentUpdateBox as Box;
    expect(box).toBeDefined();
    expect(box.sink).toBeUndefined(); // idle: unarmed between runs

    await type(inst.stdin, "go\r");
    // The run arms the sink (driver-side, 79) — poll the captured instance.
    await until(() => box.sink !== undefined, "run arms the subagent sink");
    // The parent's own busy row is on screen; the child's delta rides the
    // armed box exactly like core's forwarding would deliver it.
    box.sink!(subAppend("eph-1", "call_0", "grep", "SUB-TAIL-82"));
    const flat = () => (inst.lastFrame() ?? "").replace(/\n/g, "");
    await until(() => flat().includes("SUB-TAIL-82"), "the subagent row's tail line in the frame");
    expect(flat()).toContain("subagent");
    expect(flat()).toContain("grep");

    release();
    await until(() => !flat().includes("SUB-TAIL-82"), "run settle drops the row (LiveArea unmounts)");
    expect(box.sink).toBeUndefined(); // disarmed at the run's finally seam
    inst.unmount();
  });
});
