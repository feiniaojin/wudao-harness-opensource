// M41 — the kernel-policy single source. Core owns the mechanisms; the
// deployment's operating points live in cli/src/kernel-policy.ts and are
// threaded into every construction site. These pins are the no-regression
// oracle for the M41 hoist: every value below is the pre-M41 core default,
// now cli-supplied. Changing one is a deliberate deployment-policy change —
// say so in the commit and update the mechanism/policy inventory in
// docs/ARCHITECTURE.md.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput } from "@wudao/core";
import { createReadFileTool } from "@wudao/core";
import { KERNEL_POLICY } from "../src/kernel-policy.js";
import { DEFAULT_MAX_CONCURRENT, HARD_MAX_CONCURRENT } from "../src/agents/contract.js";
import { createSessionRegistry } from "../src/agents/index.js";
import type { AgentSpawnSpec } from "../src/agents/index.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kernel-policy-"));
  await writeFile(join(root, "data.txt"), "hello");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const ROLE: AgentSpawnSpec["role"] = { id: "tester", description: "test role", toolNames: ["read_file"] };

describe("kernel-policy single source (M41)", () => {
  it("pins the registry operating points (the pre-M41 core defaults)", () => {
    expect(KERNEL_POLICY.registry).toEqual({
      maxConcurrent: 3,
      maxConcurrentCeiling: 16,
      hardCap: 16,
      childTurns: 20,
      graceTools: ["todo_write"],
      strictOverlaps: false,
      // 波次8 #47 (OH#6): the background wall-clock default (30m — the same
      // scale as SCHEDULE_RUN_TIMEOUT_MS).
      backgroundTimeoutMs: 1_800_000,
    });
  });

  it("波次8 #47: pins the agent tool-input clamp range", () => {
    expect(KERNEL_POLICY.agentTimeout).toEqual({ minMs: 30_000, maxMs: 3_600_000 });
  });

  it("contract constants derive from the policy (no second value source)", () => {
    expect(DEFAULT_MAX_CONCURRENT).toBe(KERNEL_POLICY.registry.maxConcurrent);
    expect(HARD_MAX_CONCURRENT).toBe(KERNEL_POLICY.registry.maxConcurrentCeiling);
  });

  it("createSessionRegistry threads hardCap into core (observable at the 17th live spawn)", () => {
    const reg = createSessionRegistry();
    const parked: Array<() => void> = [];
    const parkingModel: ModelClient = {
      generate(): Promise<AssistantMessage> {
        return new Promise((resolve) => { parked.push(() => resolve({ role: "assistant", content: "late" })); });
      },
    };
    for (let i = 0; i < KERNEL_POLICY.registry.hardCap; i += 1) {
      reg.spawn({ model: parkingModel, allTools: [], role: ROLE, prompt: "p" });
    }
    expect(() =>
      reg.spawn({ model: parkingModel, allTools: [], role: ROLE, prompt: "p" }),
    ).toThrow(new RegExp(`hard cap \\(${KERNEL_POLICY.registry.hardCap} live agents\\)`));
    reg.abortAll();
    for (const release of parked) release();
  });

  it("createSessionRegistry threads childTurns + graceTools (budget-limited receipt names 21 turns)", async () => {
    // A model that spends every turn on a read: the registry-level budget
    // (childTurns, no spawn/role override) fires, the grace turn (graceTools
    // whitelist ∩ read-only child = empty tool set) forces the final report.
    for (let i = 1; i <= KERNEL_POLICY.registry.childTurns + 2; i += 1) {
      await writeFile(join(root, `data${i}.txt`), `hello ${i}`);
    }
    let call = 0;
    const model: ModelClient = {
      async generate(_input: ModelInput): Promise<AssistantMessage> {
        call += 1;
        if (call <= KERNEL_POLICY.registry.childTurns) {
          return {
            role: "assistant",
            content: "",
            // A DIFFERENT file each turn — M48's loop-safety net would
            // otherwise (correctly) flag 20 identical reads as a loop long
            // before the budget the test exists to pin.
            toolCalls: [{ id: `c${call}`, name: "read_file", arguments: { path: join(root, `data${call}.txt`) } }],
          };
        }
        return { role: "assistant", content: "partial: budget exhausted" };
      },
    };
    const reg = createSessionRegistry();
    const spawned = reg.spawn({
      model,
      allTools: [createReadFileTool({ workspaceRoot: root })],
      role: ROLE,
      prompt: "p",
    });
    const r = await spawned.done;
    expect(r.ok).toBe(true);
    expect(r.budgetLimited).toBe(true);
    expect(r.report).toContain("partial: budget exhausted");
    expect(r.workerReport).toContain(`turns_used: ${KERNEL_POLICY.registry.childTurns + 1}`);
  });
});
