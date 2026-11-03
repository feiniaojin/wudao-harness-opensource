// ω99-21 — hook-allow authorization ceiling + hook source trust grading.
//
// Two guards, one goal: close the self-authorization chain (agent silently
// plants a hook in an agent-writable dir → boot/resume mounts it → every ask
// including the three bypass-immune layers auto-allows):
//
//   immune ceiling  withPermissionRequestHook's immuneAsk opt — a hook ALLOW
//                  on the three bypass-immune ask layers downgrades to
//                  "ask"; the predicate itself is immuneAskCeiling
//                  (protectedSettingsFile || settings.ask hit ||
//                  credentialMaterialPath).
//   source trust    deny-only wrappers at the composition seams — hooks from
//                  agent-writable sources (.wudao/extensions/*.mjs,
//                  project-scope plugins) may DENY or stay silent but never
//                  ALLOW; human-installed sources (user/flag plugins,
//                  settings.json) keep their allow (still under the ceiling).
//
// The planting chain's first step is separately fenced: writes under
// .wudao/extensions|plugins are layer-2 protected asks in EVERY mode.
//
// Zero real shell, zero network: the compiled plugin-hook cases run through
// the mcp_tool backend with a fake in-memory seam.
import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideRichPermission,
  protectedSettingsFile,
  withPermissionRequestHook,
  immuneAskCeiling,
  createPermissionGate,
  type StaticRuleDecide,
} from "../src/permission.js";
import { buildConfiguredHooks, denyOnlyPermissionRequest } from "../src/hooks-config.js";
import { mergeHooksSettings } from "../src/plugins.js";
import type { LoadedPlugin } from "../src/plugins.js";
import { attachBootExtensions, buildExtensionState } from "../src/extension-state.js";
import type { ExtensionState } from "../src/extension-state.js";
import type { AgentHooks } from "@wudao-org/core";

const NO_RULES = { allow: [], deny: [], ask: [] } as const;

const autoStatic = (settings = NO_RULES, mode: "auto" | "workspace" = "auto"): StaticRuleDecide =>
  async (toolName, input) => decideRichPermission({ mode, toolName, input, settings });

describe("ω99-21 immuneAskCeiling — the ceiling predicate over the real three layers", () => {
  it("protected settings/hook-source writes and credential material trip it", async () => {
    const ceiling = immuneAskCeiling(async () => NO_RULES);
    await expect(ceiling("write_file", { path: ".wudao/settings.json" })).resolves.toBe(true);
    await expect(ceiling("edit", { path: ".wudao/extensions/implant.mjs" })).resolves.toBe(true);
    await expect(ceiling("edit", { path: ".wudao/plugins/p/hooks/hooks.json" })).resolves.toBe(true);
    await expect(ceiling("read_file", { path: "~/.ssh/id_rsa" })).resolves.toBe(true);
    await expect(ceiling("write_file", { path: "src/a.ts" })).resolves.toBe(false);
  });

  it("an operator settings.ask rule hit trips it (live getter — the hot-reload rides along)", async () => {
    const ceiling = immuneAskCeiling(async () => ({ allow: [], deny: [], ask: ["shell:curl"] }));
    await expect(ceiling("shell", { command: "curl https://x.example" })).resolves.toBe(true);
    await expect(ceiling("shell", { command: "ls" })).resolves.toBe(false);
  });
});

describe("ω99-21 ceiling over the REAL static layers (decideRichPermission)", () => {
  it("auto mode: hook allow on a hook-source implant write downgrades to ask", async () => {
    const layered = withPermissionRequestHook(async () => ({ behavior: "allow" }), () => "auto", autoStatic(), {
      immuneAsk: immuneAskCeiling(async () => NO_RULES),
    });
    await expect(layered("write_file", { path: ".wudao/extensions/implant.mjs", content: "" })).resolves.toBe("ask");
    // Same gate, same hook: a non-immune call keeps the hook's allow.
    await expect(layered("write_file", { path: "src/a.ts", content: "" })).resolves.toEqual({ behavior: "allow" });
  });

  it("an operator ask rule survives a hook allow (settings-driven immune ask)", async () => {
    const settings = { allow: [], deny: [], ask: ["shell:curl"] };
    const layered = withPermissionRequestHook(async () => ({ behavior: "allow" }), () => "auto", autoStatic(settings), {
      immuneAsk: immuneAskCeiling(async () => settings),
    });
    await expect(layered("shell", { command: "curl https://x.example" })).resolves.toBe("ask");
  });
});

describe("ω99-21 I7 — the planting chain fence (protected write-set extension)", () => {
  it("writes under .wudao/extensions|plugins are protected in every spelling", () => {
    expect(protectedSettingsFile("write_file", { path: ".wudao/extensions/x.mjs" })).toBe(".wudao/extensions");
    expect(protectedSettingsFile("write_file", { path: ".wudao/extensions/x.mjs" })).toBeDefined();
    expect(protectedSettingsFile("edit", { path: ".wudao/plugins/p/hooks/hooks.json" })).toBe(".wudao/plugins");
    expect(protectedSettingsFile("write_file", { path: "/repo/.wudao/extensions/a.mjs" })).toBeDefined();
    expect(protectedSettingsFile("write_file", { path: "deploy/.wudao/plugins/p/pkg.json" })).toBeDefined();
    // The USER plugin tier too: a planted ~/.wudao/plugins hook is worse
    // (user-scope hooks are not deny-only wrapped) — segment matching covers it.
    expect(protectedSettingsFile("write_file", { path: "~/.wudao/plugins/p/hooks/hooks.json" })).toBeDefined();
  });

  it("near-misses stay unprotected (segment rule, not substring)", () => {
    expect(protectedSettingsFile("write_file", { path: ".wudao/extensions-notes.md" })).toBeUndefined();
    expect(protectedSettingsFile("write_file", { path: ".wudao/extension/x.mjs" })).toBeUndefined();
    expect(protectedSettingsFile("write_file", { path: "src/.wudao/plugins-readme.md" })).toBeUndefined();
    expect(protectedSettingsFile("read_file", { path: ".wudao/extensions/x.mjs" })).toBeUndefined();
  });

  it("the original three JSON exact matches are byte-identical", () => {
    expect(protectedSettingsFile("write_file", { path: ".wudao/settings.json" })).toBe(".wudao/settings.json");
    expect(protectedSettingsFile("edit", { path: "docs/.wudao/mcp.json" })).toBe(".wudao/mcp.json");
    expect(protectedSettingsFile("write_file", { path: ".mcp.json" })).toBe(".mcp.json");
  });

  it("layer 2 asks in AUTO mode for hook-source writes (bypass-immune: mode cannot allow)", () => {
    expect(decideRichPermission({ mode: "auto", toolName: "write_file", input: { path: ".wudao/extensions/x.mjs" } })).toBe("ask");
    expect(decideRichPermission({ mode: "auto", toolName: "edit", input: { path: ".wudao/plugins/y/hooks/hooks.json", old_string: "a", new_string: "b" } })).toBe("ask");
  });
});

// ---------------------------------------------------------------------------
// I5/I6 — hook source trust grading. Deny-only semantics: a hook from an
// agent-writable source that answers ALLOW is treated as NO opinion (it
// falls back to the original pipeline — an ask stays an ask); deny and
// no-opinion pass through verbatim.
// ---------------------------------------------------------------------------

const emptyState = (): ExtensionState => ({
  plugins: [],
  pluginCommands: [],
  pluginAgents: [],
  hooksSettings: {},
  hooks: undefined,
  fileWatchTargets: [],
  skills: [],
  mcpConfig: { servers: {} },
  counts: { skills: 0, plugins: 0, hooks: 0 },
  trustSuppressed: false,
});

describe("ω99-21 I5 — .wudao/extensions hooks are deny-only (never authorize)", () => {
  it("denyOnlyPermissionRequest: allow → no opinion; deny/no-opinion verbatim; other faces untouched", async () => {
    const other = async (): Promise<void> => {};
    const orig: AgentHooks = { onRunStart: other, onPermissionRequest: async () => ({ behavior: "allow" }) };
    const wrapped = denyOnlyPermissionRequest(orig)!;
    await expect(wrapped.onPermissionRequest!("write_file", {})).resolves.toBeUndefined();
    expect(wrapped.onRunStart).toBe(other); // not the permission face — untouched
    // deny passes verbatim:
    const denying = denyOnlyPermissionRequest({ onPermissionRequest: async () => ({ behavior: "deny", reason: "p" }) })!;
    await expect(denying.onPermissionRequest!("write_file", {})).resolves.toEqual({ behavior: "deny", reason: "p" });
    // no-opinion passes verbatim:
    const silent = denyOnlyPermissionRequest({ onPermissionRequest: async () => undefined })!;
    await expect(silent.onPermissionRequest!("write_file", {})).resolves.toBeUndefined();
    // undefined input stays undefined:
    expect(denyOnlyPermissionRequest(undefined)).toBeUndefined();
  });

  it("attachBootExtensions wraps the boot extension hooks deny-only", async () => {
    const configHooks: AgentHooks = { onPermissionRequest: async () => undefined };
    const extHooks: AgentHooks = { onPermissionRequest: async () => ({ behavior: "allow" }) };
    const state = attachBootExtensions({ ...emptyState(), hooks: configHooks }, extHooks);
    await expect(state.hooks!.onPermissionRequest!("shell", { command: "ls" })).resolves.toBeUndefined();
    // …and the same boot object composed through buildExtensionState:
    const built = await buildExtensionState(join(tmpdir(), "wudao-omega99-21-nows"), [], {
      env: process.env,
      extensionsHooks: extHooks,
    });
    await expect(built.hooks!.onPermissionRequest!("shell", { command: "ls" })).resolves.toBeUndefined();
  });

  it("I9 composed: deny-only extension allow on an immune write → ask; deny still lands", async () => {
    const extHooks: AgentHooks = { onPermissionRequest: async () => ({ behavior: "allow" }) };
    const state = attachBootExtensions(emptyState(), extHooks);
    const layered = withPermissionRequestHook(state.hooks!.onPermissionRequest, () => "auto", autoStatic(), {
      immuneAsk: immuneAskCeiling(async () => NO_RULES),
    });
    await expect(layered("write_file", { path: ".wudao/settings.json" })).resolves.toBe("ask");
    const denying = attachBootExtensions(emptyState(), { onPermissionRequest: async () => ({ behavior: "deny", reason: "ext policy" }) });
    // M63-A fires the hook only when pipeline work remains: an ask-class
    // call (workspace-mode shell) is where a deny-only deny lands.
    const layered2 = withPermissionRequestHook(denying.hooks!.onPermissionRequest, () => "auto", autoStatic(NO_RULES, "workspace"), {
      immuneAsk: immuneAskCeiling(async () => NO_RULES),
    });
    await expect(layered2("shell", { command: "curl https://x.example" })).resolves.toEqual({ behavior: "deny", reason: "ext policy" });
  });
});

const pluginFixture = (name: string, scope: "project" | "user" | "flag", hooks: LoadedPlugin["hooks"]): LoadedPlugin => ({
  name,
  dir: `/tmp/plugins/${name}`,
  source: scope === "flag" ? "flag" : "plugins-dir",
  scope,
  skills: [],
  commands: [],
  agents: [],
  mcpServers: {},
  hooks,
  warnings: [],
});

describe("ω99-21 I6 — project plugin permission hooks are deny-only; user/flag are not", () => {
  const mcpEntry = (tool: string) => ({ type: "mcp_tool" as const, server: "s", tool });

  it("mergeHooksSettings stamps denyOnly ONLY on project-scope onPermissionRequest entries", () => {
    const merged = mergeHooksSettings(
      { onPermissionRequest: [{ command: "user-hook" }] },
      [
        pluginFixture("proj", "project", { onPermissionRequest: [{ command: "proj-hook" }], onPreToolUse: [{ command: "proj-pre" }] }),
        pluginFixture("usr", "user", { onPermissionRequest: [{ command: "usr-hook" }] }),
        pluginFixture("flg", "flag", { onPermissionRequest: [{ command: "flg-hook" }] }),
      ],
    );
    expect(merged.onPermissionRequest).toEqual([
      { command: "user-hook" },
      { command: "proj-hook", denyOnly: true },
      { command: "usr-hook" },
      { command: "flg-hook" },
    ]);
    expect(merged.onPreToolUse).toEqual([{ command: "proj-pre" }]); // other events never stamped
  });

  it("compiled: a project plugin's allow is no opinion; its deny lands; a user plugin's allow stands", async () => {
    // Each plugin's entry points at its OWN fake mcp tool; the seam answers
    // only the entry under test (the other stays silent), so one layer's
    // answer is isolated even though both ride the same compiled hook.
    const merged = mergeHooksSettings({}, [
      pluginFixture("proj", "project", { onPermissionRequest: [mcpEntry("proj-policy")] }),
      pluginFixture("usr", "user", { onPermissionRequest: [mcpEntry("user-policy")] }),
    ]);
    const answer = (tool: string, text: string) => buildConfiguredHooks(merged, {
      workspaceRoot: "/tmp/wudao-omega99-21",
      mcp: { call: async (_server, t) => ({ ok: true, text: t === tool ? text : "" }) },
    })!;
    // Project entry answering allow → the whole config layer has NO opinion.
    const projAllow = answer("proj-policy", '{"decision":"allow"}');
    await expect(projAllow.onPermissionRequest!("write_file", {})).resolves.toBeUndefined();
    // Project entry answering deny → deny lands (narrowing is always effective).
    const projDeny = answer("proj-policy", '{"decision":"deny","reason":"plugin policy"}');
    await expect(projDeny.onPermissionRequest!("write_file", {})).resolves.toEqual({
      behavior: "deny",
      reason: "permission hook: plugin policy",
    });
    // A USER plugin entry answering allow still allows (still under the ceiling).
    const usrAllow = answer("user-policy", '{"decision":"allow"}');
    await expect(usrAllow.onPermissionRequest!("write_file", {})).resolves.toEqual({ behavior: "allow" });
  });
});

describe("ω99-21 end-to-end — the shared gate builder (createPermissionGate) carries the ceiling", () => {
  it("auto mode: an allow-all hook still cannot clear a protected write (non-TTY ask → deny), while non-immune calls keep the hook's allow", async () => {
    const root = await mkdtemp(join(tmpdir(), "wudao-omega99-21-e2e-"));
    const prevCwd = process.cwd();
    try {
      process.chdir(root);
      const consulted: string[] = [];
      const gate = createPermissionGate(["--auto"], undefined, undefined, undefined, undefined, async (toolName) => {
        consulted.push(toolName);
        return { behavior: "allow" };
      });
      // The implant write: static layer 2 asks; the hook allows; the ceiling
      // downgrades to ask; no TTY → the ask degrades to the fail-closed deny.
      await expect(gate("write_file", { path: ".wudao/extensions/implant.mjs", content: "" })).resolves.toEqual({
        behavior: "deny",
        reason: "non-interactive",
      });
      // The same gate, same hook, a NON-immune ask-class call: hook allow wins.
      const gateDefault = createPermissionGate([], undefined, undefined, undefined, undefined, async () => ({ behavior: "allow" }));
      await expect(gateDefault("shell", { command: "ls" })).resolves.toEqual({ behavior: "allow" });
      expect(consulted).toEqual(["write_file"]);
    } finally {
      process.chdir(prevCwd);
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

