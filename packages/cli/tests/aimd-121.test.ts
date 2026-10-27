// 121 项 1 — the CLI composition: createSessionRegistry rides an AIMD gate
// whose ceiling IS the effective static cap (zero behavior change by
// construction — the default construction admits exactly the pre-121 three),
// and the agents.aimdMaxConcurrent settings node follows the misc-config
// family discipline (junk → warning + default, never fatal).
import { describe, it, expect } from "vitest";
import { createSessionRegistry, AimdGate } from "../src/agents/index.js";
import { KERNEL_POLICY } from "../src/kernel-policy.js";
import { agentsSettingsFromNode, DEFAULT_AGENTS_SETTINGS } from "../src/misc-config.js";
import type { ModelClient, ModelInput } from "@wudao/core";
import type { AssistantMessage } from "@wudao/core";
import { BUILTIN_ROLES } from "../src/agents/index.js";

// The CLI spelling is a Map (core-bind adapts core's Record).
const ROLE = BUILTIN_ROLES.get("general-purpose")!;

/** The gated-model shape from core's registry tests (release-held response). */
function gatedModel(): { readonly model: ModelClient; readonly release: (text: string) => void } {
  let release!: (m: AssistantMessage) => void;
  const gate = new Promise<AssistantMessage>((resolve) => { release = resolve; });
  const model: ModelClient = {
    async generate(input: ModelInput): Promise<AssistantMessage> {
      if (!input.signal) return gate;
      return new Promise<AssistantMessage>((resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (input.signal.aborted) { onAbort(); return; }
        input.signal.addEventListener("abort", onAbort, { once: true });
        void gate.then((m) => {
          input.signal.removeEventListener("abort", onAbort);
          resolve(m);
        });
      });
    },
  };
  return { model, release: (text) => release({ role: "assistant", content: text }) };
}

describe("createSessionRegistry × AIMD (121 项 1)", () => {
  it("the DEFAULT construction admits exactly the pre-121 static cap (initial = old cap = 3)", async () => {
    const reg = createSessionRegistry();
    const children = [gatedModel(), gatedModel(), gatedModel(), gatedModel()];
    const handles = children.map((c) => reg.spawn({ model: c.model, allTools: [], role: ROLE, prompt: "p" }));
    await new Promise((r) => setTimeout(r, 10));
    // kernel-policy's 3 admitted, the 4th queued — the pre-121 behavior.
    expect(handles.slice(0, 3).every((h) => reg.status(h.id)!.status === "running")).toBe(true);
    expect(reg.status(handles[3]!.id)!.status).toBe("queued");
    children.forEach((c) => c.release("done"));
    await Promise.all(handles.map((h) => h.done));
    reg.abortAll();
  });

  it("an explicitly-passed gate IS the one consulted (shared-gate composition)", async () => {
    const gate = new AimdGate({ max: 2 });
    const reg = createSessionRegistry({ concurrencyGate: gate });
    const children = [gatedModel(), gatedModel(), gatedModel()];
    const handles = children.map((c) => reg.spawn({ model: c.model, allTools: [], role: ROLE, prompt: "p" }));
    await new Promise((r) => setTimeout(r, 10));
    // Gate ceiling 2 < kernel-policy 3: the gate governs, two run one queues.
    expect(reg.status().filter((s) => s.status === "running").length).toBe(2);
    expect(reg.status(handles[2]!.id)!.status).toBe("queued");
    children.forEach((c) => c.release("done"));
    await Promise.all(handles.map((h) => h.done));
  });

  it("a caller's explicit maxConcurrent keeps ruling (the clamp + gate ceiling track it)", async () => {
    const gate = new AimdGate({ max: 1 });
    const reg = createSessionRegistry({ maxConcurrent: 1, concurrencyGate: gate });
    const a = gatedModel();
    const b = gatedModel();
    const ha = reg.spawn({ model: a.model, allTools: [], role: ROLE, prompt: "p" });
    const hb = reg.spawn({ model: b.model, allTools: [], role: ROLE, prompt: "p" });
    await new Promise((r) => setTimeout(r, 10));
    expect(reg.status(ha.id)!.status).toBe("running");
    expect(reg.status(hb.id)!.status).toBe("queued");
    a.release("1");
    await ha.done;
    await new Promise((r) => setTimeout(r, 10));
    expect(reg.status(hb.id)!.status).toBe("running");
    b.release("2");
    await hb.done;
  });
});

describe("agents.aimdMaxConcurrent settings node (121 项 1, misc-config family)", () => {
  it("default = the kernel-policy static cap (zero behavior change by default)", () => {
    expect(DEFAULT_AGENTS_SETTINGS.aimdMaxConcurrent).toBe(KERNEL_POLICY.registry.maxConcurrent);
    expect(agentsSettingsFromNode(undefined).aimdMaxConcurrent).toBe(3);
    expect(agentsSettingsFromNode({}).aimdMaxConcurrent).toBe(3);
  });

  it("a well-formed integer is kept (the ceiling the gate may grow back to)", () => {
    expect(agentsSettingsFromNode({ aimdMaxConcurrent: 8 }).aimdMaxConcurrent).toBe(8);
    expect(agentsSettingsFromNode({ aimdMaxConcurrent: 1 }).aimdMaxConcurrent).toBe(1);
    expect(agentsSettingsFromNode({ aimdMaxConcurrent: 16 }).aimdMaxConcurrent).toBe(16);
  });

  it("junk warns and falls back to the default — never fatal (family discipline)", () => {
    const warn: string[] = [];
    expect(agentsSettingsFromNode({ aimdMaxConcurrent: 0 }, (m) => warn.push(m)).aimdMaxConcurrent).toBe(3);
    expect(agentsSettingsFromNode({ aimdMaxConcurrent: 17 }, (m) => warn.push(m)).aimdMaxConcurrent).toBe(3);
    expect(agentsSettingsFromNode({ aimdMaxConcurrent: 2.5 }, (m) => warn.push(m)).aimdMaxConcurrent).toBe(3);
    expect(agentsSettingsFromNode({ aimdMaxConcurrent: "8" }, (m) => warn.push(m)).aimdMaxConcurrent).toBe(3);
    expect(warn.length).toBe(4);
    expect(warn.every((w) => w.includes("aimdMaxConcurrent"))).toBe(true);
  });

  it("a non-object node warns and defaults; unknown keys warn and are ignored", () => {
    const warn: string[] = [];
    expect(agentsSettingsFromNode(null, (m) => warn.push(m)).aimdMaxConcurrent).toBe(3);
    expect(agentsSettingsFromNode([1, 2], (m) => warn.push(m)).aimdMaxConcurrent).toBe(3);
    expect(agentsSettingsFromNode({ aimdMaxConcurrent: 5, frobnicate: true }, (m) => warn.push(m)).aimdMaxConcurrent).toBe(5);
    expect(warn.some((w) => w.includes("must be an object"))).toBe(true);
    expect(warn.some((w) => w.includes("frobnicate"))).toBe(true);
  });
});
