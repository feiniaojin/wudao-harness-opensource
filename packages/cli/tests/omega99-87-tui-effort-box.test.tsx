// ω99-87 — the TUI's effortLiveBox wiring (86's TUI lane; 82's同形复刻).
// ω99-86 landed the live-effort box in the driver (box.get armed at run
// start, cleared at the finally seam) and wired the session-engine lane;
// the TUI built its tool set and driver with NO box — a Task child
// dispatched from the desktop TUI fell back to the session's own baseline,
// so 86's payoff never reached the main product face. These cases pin the
// TUI isomorph (82's subagentUpdateBox wiring, read-seam edition): ONE box
// instance reaching BOTH seams (buildToolSet's task tool AND the driver),
// identity-stable across re-renders; the end-to-end TUI version of 86's
// engine-lane case1 (idle /effort high → run → the child spawn's
// loopOptions.effortSent === the parent's live level); and 82's
// subagentUpdateBox face riding untouched beside the new key. The
// construction-site recording idiom is 82's (vi.mock wraps the site fn,
// records opts, delegates to the real one).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool } from "@wudao-org/core";
import type { Tool, ModelClient, ModelInput, AssistantMessage } from "@wudao-org/core";
import type { AgentRegistry, AgentSpawnSpec } from "@wudao-org/core";
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

// Every construction site's opts, in call order (82's recording idiom).
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

/** 82's scripted, call-indexed model — the TUI lane never auto-titles, so
 *  the script's order IS the conversation's order. */
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

/** 82's probe tool — flips the tool-set memo's dep (props.extraTools) so the
 *  rerender rebuilds buildToolSet and the box identity must survive. */
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

/** The session-engine box shape (86's EffortLiveBox — the read seam of 79's
 *  stateHandle single-slot object). */
type EffortBox = { get?: () => string | undefined };

/** 86's stub registry — records every background spawn's spec verbatim (the
 *  end-to-end observable is spec.loopOptions.effortSent). */
function stubRegistry(): AgentRegistry & { specs: AgentSpawnSpec[] } {
  const specs: AgentSpawnSpec[] = [];
  const stub: unknown = {
    specs,
    spawn: (spec: AgentSpawnSpec) => {
      specs.push(spec);
      return {
        id: "bg-1",
        done: Promise.resolve({ ok: true, report: "stub", turns: 0 }),
        warnings: [],
      };
    },
    awaitAgents: async () => [],
    status: () => [],
    cancel: () => false,
    abortAll: () => {},
    steer: () => {},
  };
  return stub as AgentRegistry & { specs: AgentSpawnSpec[] };
}

// ink-testing-library delivers a multi-char stdin.write as ONE input chunk —
// text must be fed character by character (82's idiom); "\r" is the return key.
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

describe("ω99-87 — TUI effortLiveBox wiring (86's TUI lane, 82's isomorph)", () => {
  it("case1 assembly: ONE box instance reaches BOTH the tool set and the driver (identity), stable across re-renders", async () => {
    const root = mkdtempSync(join(tmpdir(), "om87-wire-"));
    roots.push(root);
    const model = scriptedModel([{ role: "assistant", content: "ok", stopReason: "end_turn" }]);
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64_000} modelOverride={model} />,
    );
    await wait();
    // The driver is created exactly once (useAgent's lazy ref) — with the box.
    expect(driverOpts).toHaveLength(1);
    const driverBox = driverOpts[0]!.effortLiveBox as EffortBox | undefined;
    expect(driverBox).toBeDefined(); // RED on base: undefined — the dead lane.
    // The tool set memo ran at mount and injected the SAME instance (86's
    // two-seam isomorph — the task tool's spawn site and the driver's arming
    // share one box).
    expect(toolSetOpts.length).toBeGreaterThanOrEqual(1);
    for (const o of toolSetOpts) expect(o.effortLiveBox).toBe(driverBox);
    // Re-render with a changed memo dep (props.extraTools) rebuilds the tool
    // set — the box instance must SURVIVE (a per-render rebuild would hand the
    // task tool a getter the driver never arms; the useRef is the contract).
    const before = toolSetOpts.length;
    inst.rerender(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64_000} modelOverride={model} extraTools={[holdTool("om87_probe", Promise.resolve())]} />,
    );
    await wait();
    expect(toolSetOpts.length).toBeGreaterThan(before);
    for (const o of toolSetOpts) expect(o.effortLiveBox).toBe(driverBox);
    inst.unmount();
  });

  it("case2 end-to-end: idle /effort high → the run's armed box → the TUI task spawn carries effortSent=high; settle disarms", async () => {
    const root = mkdtempSync(join(tmpdir(), "om87-e2e-"));
    roots.push(root);
    const reg = stubRegistry();
    const model = scriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "task", arguments: { description: "child job", prompt: "research the thing", background: true } }] },
      { role: "assistant", content: "PARENT DONE", stopReason: "end_turn" },
    ]);
    const inst = render(
      <WudaoApp
        config={config}
        workspaceRoot={root}
        contextWindowTokens={64_000}
        modelOverride={model}
        agentsRegistry={reg}
        initialPermissionMode="auto"
      />,
    );
    await wait();
    const box = driverOpts[0]!.effortLiveBox as EffortBox | undefined;
    expect(box).toBeDefined(); // RED on base: the dead lane.
    expect(box!.get).toBeUndefined(); // idle: unarmed between runs
    const flat = () => (inst.lastFrame() ?? "").replace(/\n/g, "");
    // Idle /effort switch lands on the driver's modelLive NOW — the next
    // run's requests AND, through the box, its children carry it.
    await type(inst.stdin, "/effort high\r");
    await until(() => flat().includes("effort → high"), "the /effort switch receipt");
    // The run arms the getter (driver-side, 86) and the task tool reads it AT
    // SPAWN: the recorded spec's loopOptions is the observable.
    await type(inst.stdin, "go\r");
    await until(() => reg.specs.length >= 1, "the task spawn reaches the registry");
    const loopOptions = reg.specs[0]!.loopOptions!;
    expect(loopOptions).toBeDefined();
    expect(loopOptions.effortSent).toBe("high");
    // The run's settle disarms the getter at the finally seam (79's twin).
    await until(() => box!.get === undefined, "run settle disarms the effort getter");
    inst.unmount();
  });

  it("case3 byte pin: 82's subagentUpdateBox face rides untouched beside the new key (both boxes, one identity rule)", async () => {
    const root = mkdtempSync(join(tmpdir(), "om87-byte-"));
    roots.push(root);
    const model = scriptedModel([{ role: "assistant", content: "ok", stopReason: "end_turn" }]);
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64_000} modelOverride={model} />,
    );
    await wait();
    expect(driverOpts).toHaveLength(1);
    // 82's write-seam box is still on BOTH faces with its identity rule —
    // the 87 addition never rewrote the 82 wiring (只增不改).
    const deltaBox = driverOpts[0]!.subagentUpdateBox as { sink?: unknown } | undefined;
    expect(deltaBox).toBeDefined();
    expect(toolSetOpts.length).toBeGreaterThanOrEqual(1);
    for (const o of toolSetOpts) expect(o.subagentUpdateBox).toBe(deltaBox);
    // And the two boxes are DISTINCT single-slot objects (the read seam and
    // the write seam share the injection discipline, never the slot).
    expect(driverOpts[0]!.effortLiveBox).toBeDefined();
    expect(driverOpts[0]!.effortLiveBox).not.toBe(deltaBox);
    inst.unmount();
  });
});
