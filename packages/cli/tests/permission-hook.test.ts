// M63-A — the PermissionRequest hook layer (withPermissionRequestHook): the
// MANDATED pipeline order (after the deny rules, before the sidecar checks),
// the decision semantics (deny stops the pipeline; allow skips the sidecar
// AND the human ask; no opinion changes nothing), and when the hook fires at
// all (only when remaining pipeline work exists).
import { describe, it, expect } from "vitest";
import { withPermissionRequestHook, withSidecarLayer, sidecarGatesTool, EMPTY_PERMISSION_SETTINGS } from "../src/permission.js";
import type { Mode, StaticRuleDecide } from "../src/permission.js";
import type { Sidecar, SidecarVerdict } from "../src/sidecar.js";
import type { PermissionDecision } from "@wudao-org/core";

// A recording static layer: returns queued decisions and records call order
// into `log` when given (shared with the hook/sidecar recordings for order
// assertions), else into its own array.
function recordingStatic(outcomes: { d: PermissionDecision | "ask" }[], log?: string[]) {
  const own: string[] = [];
  const calls = log ?? own;
  let last: PermissionDecision | "ask" = { behavior: "allow" };
  const decide: StaticRuleDecide = async (toolName, _input) => {
    calls.push(`static:${toolName}`);
    const next = outcomes.shift();
    if (next !== undefined) last = next.d;
    return last; // STICKY: the fall-through path re-runs the pure static layers
  };
  return { decide, calls };
}

describe("withPermissionRequestHook — firing conditions", () => {
  it("never fires when the static deny rule already denied (deny rules outrank the hook)", async () => {
    const { decide, calls } = recordingStatic([{ d: { behavior: "deny", reason: 'settings deny rule "x"' } }]);
    let hookCalls = 0;
    const layered = withPermissionRequestHook(async () => {
      hookCalls += 1;
      return { behavior: "deny" };
    }, () => "default", decide);
    const out = await layered("write_file", {});
    expect(out).toEqual({ behavior: "deny", reason: 'settings deny rule "x"' });
    expect(hookCalls).toBe(0);
    expect(calls).toEqual(["static:write_file"]);
  });

  it("does not fire for a static allow with no remaining pipeline work (default mode, read tool)", async () => {
    const { decide } = recordingStatic([{ d: { behavior: "allow" } }]);
    let hookCalls = 0;
    const layered = withPermissionRequestHook(async () => {
      hookCalls += 1;
      return { behavior: "deny" };
    }, () => "default", decide, { sidecarPresent: true });
    // read_file IS sidecar-ungated (SIDECAR_UNGATED) → no work remains.
    expect(await layered("read_file", {})).toEqual({ behavior: "allow" });
    expect(hookCalls).toBe(0);
    // In AUTO mode a gated tool that would allow DOES have work remaining.
    const gated = recordingStatic([{ d: { behavior: "allow" } }]);
    const layeredAuto = withPermissionRequestHook(async () => {
      hookCalls += 1;
      return { behavior: "allow" };
    }, () => "auto", gated.decide, { sidecarPresent: true });
    expect(await layeredAuto("write_file", {})).toEqual({ behavior: "allow" });
    expect(hookCalls).toBe(1);
  });

  it("fires on 'ask' outcomes (the human would be prompted)", async () => {
    const { decide } = recordingStatic([{ d: "ask" }]);
    const seen: string[] = [];
    const layered = withPermissionRequestHook(async (tool) => {
      seen.push(tool);
      return undefined;
    }, () => "default", decide);
    expect(await layered("shell", {})).toBe("ask");
    expect(seen).toEqual(["shell"]);
  });

  it("without a sidecar present, a static allow never consults the hook", async () => {
    const { decide } = recordingStatic([{ d: { behavior: "allow" } }]);
    let hookCalls = 0;
    const layered = withPermissionRequestHook(async () => {
      hookCalls += 1;
      return { behavior: "deny" };
    }, () => "auto", decide, { sidecarPresent: false });
    expect(await layered("write_file", {})).toEqual({ behavior: "allow" });
    expect(hookCalls).toBe(0);
  });
});

describe("withPermissionRequestHook — the mandated order vs the sidecar", () => {
  // The production structure: the sidecar layer is the hook layer's
  // no-opinion fall-through (classify), NOT its inner layer — that is what
  // lets a hook allow skip the classifier. Built the same way session-engine/
  // app.tsx/repl.ts/createPermissionGate build it.
  const build = (
    hook: (tool: string, input: Record<string, unknown>) => Promise<import("@wudao-org/core").PermissionDecision | undefined>,
    order: string[],
    mode: () => Mode,
    staticOutcome: PermissionDecision | "ask",
  ): StaticRuleDecide => {
    const { decide } = recordingStatic([{ d: staticOutcome }], order);
    const classify = withSidecarLayer(
      { sidecar: fakeSidecar(order), getMode: mode, escalate: escalate },
      decide,
    );
    return withPermissionRequestHook(hook, mode, decide, { sidecarPresent: true, classify });
  };

  const fakeSidecar = (log: string[]): Sidecar => {
    const verdict = (kind: SidecarVerdict["kind"]): SidecarVerdict => ({ kind, reason: `${kind}-reason` } as SidecarVerdict);
    return {
      check: async (tool: string) => {
        log.push(`sidecar:${tool}`);
        return verdict("low");
      },
      breakerOpen: () => false,
      consecutiveHighs: () => 0,
      resetBreaker: () => {},
      resetRun: () => {},
    } as unknown as Sidecar;
  };

  const escalate = async (): Promise<PermissionDecision> => {
    throw new Error("escalation must not run in these scenarios");
  };

  it("hook DENY: the sidecar never runs (order: hook BEFORE sidecar)", async () => {
    const order: string[] = [];
    const layered = build(async (tool) => {
      order.push(`hook:${tool}`);
      return { behavior: "deny", reason: "policy" };
    }, order, () => "default", "ask");
    expect(await layered("write_file", {})).toEqual({ behavior: "deny", reason: "policy" });
    expect(order).toEqual(["static:write_file", "hook:write_file"]);
  });

  // ω99-21: this case is deliberately NON-immune — `write_file` with an empty
  // input hits none of the three bypass-immune ask layers (no path → not a
  // protected/hook-source write, no credential segment), and the layer is
  // built WITHOUT the immuneAsk opt (byte-parity pin). It therefore still
  // pins the M63-A capability under the ω99-21 ceiling: on calls a human's
  // policy did NOT reserve, a hook allow IS the decision.
  it("hook ALLOW: the sidecar and the human ask are BOTH skipped", async () => {
    const order: string[] = [];
    const layered = build(async (tool) => {
      order.push(`hook:${tool}`);
      return { behavior: "allow" };
    }, order, () => "auto", { behavior: "allow" });
    expect(await layered("write_file", {})).toEqual({ behavior: "allow" });
    expect(order).toEqual(["static:write_file", "hook:write_file"]);
  });

  it("no opinion: the pipeline continues — the sidecar classifies (hook ran first)", async () => {
    const order: string[] = [];
    const layered = build(async (tool) => {
      order.push(`hook:${tool}`);
      return undefined;
    }, order, () => "auto", { behavior: "allow" });
    expect(await layered("write_file", {})).toEqual({ behavior: "allow" });
    // The fall-through re-runs the static layers inside the sidecar wrapper
    // (pure) — then the classifier runs. Order: static, hook, static, sidecar.
    expect(order).toEqual(["static:write_file", "hook:write_file", "static:write_file", "sidecar:write_file"]);
  });

  it("a throwing hook is infra failure: the pipeline continues untouched", async () => {
    const order: string[] = [];
    const layered = build(async () => {
      order.push("hook:throw");
      throw new Error("hook command crashed");
    }, order, () => "default", "ask");
    expect(await layered("write_file", {})).toBe("ask");
    expect(order).toEqual(["static:write_file", "hook:throw", "static:write_file"]);
  });

  it("undefined hook returns the static layer unchanged (zero-cost passthrough)", async () => {
    const { decide, calls } = recordingStatic([{ d: "ask" }]);
    const layered = withPermissionRequestHook(undefined, () => "default", decide);
    expect(await layered("shell", {})).toBe("ask");
    expect(calls).toEqual(["static:shell"]);
  });
});

describe("sidecarGatesTool sanity for the layer's firing rule", () => {
  it("write/exec tools are gated; read-class tools are not", () => {
    expect(sidecarGatesTool("write_file")).toBe(true);
    expect(sidecarGatesTool("shell")).toBe(true);
    expect(sidecarGatesTool("read_file")).toBe(false);
    expect(sidecarGatesTool("glob")).toBe(false);
    expect(EMPTY_PERMISSION_SETTINGS).toEqual({ allow: [], deny: [], ask: [], sidecarExempt: [] }); // ω99-27: fourth list
  });
});

// ---------------------------------------------------------------------------
// ω99-21 — the immune-ask ceiling. The three bypass-immune ask layers
// (protected settings/hook-source writes, operator settings.ask rules,
// credential material) mean "only a human may clear this" — a hook ALLOW
// downgrades to "ask"; deny and no-opinion pass through untouched. The
// predicate here is passed inline (the production composition —
// protectedSettingsFile || settings.ask hit || credentialMaterialPath — is
// immuneAskCeiling, pinned in omega99-21-hook-allow-ceiling.test.ts).
// ---------------------------------------------------------------------------

describe("ω99-21 immune ceiling — hook allow cannot clear the bypass-immune asks", () => {
  const IMMUNE_TRIGGERS: readonly { readonly label: string; readonly tool: string; readonly input: Record<string, unknown> }[] = [
    { label: "protected settings write", tool: "write_file", input: { path: ".wudao/settings.json", content: "{}" } },
    { label: "protected mcp config write", tool: "edit", input: { path: ".wudao/mcp.json", old_string: "a", new_string: "b" } },
    { label: "hook-source write (.wudao/extensions)", tool: "write_file", input: { path: ".wudao/extensions/implant.mjs", content: "export default () => {}" } },
    { label: "hook-source write (.wudao/plugins)", tool: "edit", input: { path: ".wudao/plugins/p/hooks/hooks.json", old_string: "a", new_string: "b" } },
    { label: "credential material", tool: "read_file", input: { path: "~/.ssh/id_rsa" } },
  ];

  it.each(IMMUNE_TRIGGERS)("I1/I2: hook ALLOW + $label → downgraded to ask", async ({ tool, input }) => {
    const { decide } = recordingStatic([{ d: "ask" }]);
    const layered = withPermissionRequestHook(async () => ({ behavior: "allow" }), () => "auto", decide, {
      immuneAsk: (t, i) => t === tool && i["path"] === input["path"],
    });
    await expect(layered(tool, input)).resolves.toBe("ask");
  });

  it.each(IMMUNE_TRIGGERS)("I3: hook DENY + $label → deny passes (narrowing is always effective)", async ({ tool, input }) => {
    const { decide } = recordingStatic([{ d: "ask" }]);
    const layered = withPermissionRequestHook(async () => ({ behavior: "deny", reason: "policy" }), () => "auto", decide, {
      immuneAsk: () => true,
    });
    await expect(layered(tool, input)).resolves.toEqual({ behavior: "deny", reason: "policy" });
  });

  it.each(IMMUNE_TRIGGERS)("no-opinion hook + $label + ceiling present → the ask stands (fall-through)", async ({ tool, input }) => {
    const { decide } = recordingStatic([{ d: "ask" }]);
    const layered = withPermissionRequestHook(async () => undefined, () => "auto", decide, {
      immuneAsk: () => true,
    });
    await expect(layered(tool, input)).resolves.toBe("ask");
  });

  it("I4: a hook ALLOW on a NON-immune ask still allows (the ceiling never over-blocks)", async () => {
    const { decide } = recordingStatic([{ d: "ask" }]);
    const layered = withPermissionRequestHook(async () => ({ behavior: "allow" }), () => "default", decide, {
      immuneAsk: () => false,
    });
    await expect(layered("shell", { command: "ls" })).resolves.toEqual({ behavior: "allow" });
  });

  it("I8: with NO immuneAsk opt, an immune call keeps the pre-ω99-21 behavior byte-for-byte (allow stands)", async () => {
    const { decide } = recordingStatic([{ d: "ask" }]);
    const layered = withPermissionRequestHook(async () => ({ behavior: "allow" }), () => "auto", decide);
    await expect(layered("write_file", { path: ".wudao/settings.json" })).resolves.toEqual({ behavior: "allow" });
  });

  it("the predicate is consulted ONLY for allow decisions (deny / no-opinion never evaluate it)", async () => {
    const consulted: string[] = [];
    const predicate = (t: string): boolean => {
      consulted.push(t);
      return true;
    };
    const allowLayer = withPermissionRequestHook(async () => ({ behavior: "allow" }), () => "auto", recordingStatic([{ d: "ask" }]).decide, { immuneAsk: predicate });
    await expect(allowLayer("write_file", { path: ".wudao/settings.json" })).resolves.toBe("ask");
    const denyLayer = withPermissionRequestHook(async () => ({ behavior: "deny", reason: "p" }), () => "auto", recordingStatic([{ d: "ask" }]).decide, { immuneAsk: predicate });
    await expect(denyLayer("write_file", { path: ".wudao/settings.json" })).resolves.toEqual({ behavior: "deny", reason: "p" });
    const silentLayer = withPermissionRequestHook(async () => undefined, () => "auto", recordingStatic([{ d: "ask" }]).decide, { immuneAsk: predicate });
    await expect(silentLayer("write_file", { path: ".wudao/settings.json" })).resolves.toBe("ask");
    expect(consulted).toEqual(["write_file"]); // only the allow consulted it
  });
});
