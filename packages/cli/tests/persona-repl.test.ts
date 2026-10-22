// packages/cli/tests/persona-repl.test.ts
import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersonaDefinition, PersonaRegistry } from "@wudao/providers";
import { parseReplCommand } from "../src/repl.js";
import { listSlashCommands } from "../src/slash-commands.js";
import {
  resolveBootstrapPersona, resolvePersonaSwitch, personaSwitchBreaksCache, recordPersonaChange,
} from "../src/commands/persona.js";

const def: PersonaDefinition = {
  id: "cc", displayName: "the upstream harness",
  source: { kind: "workspace-source", provenance: "t", pinnedVersion: "1" },
  headers: { anthropic: { "user-agent": "wudao-harness/0.4.14 (external, cli)" } },
  prompt: { system: { mode: "prefix", text: "You are the upstream harness.\n" } },
};
const registry: PersonaRegistry = { personas: [def], errors: [] };

describe("/persona REPL wiring", () => {
  it("parseReplCommand recognizes /persona forms", () => {
    expect(parseReplCommand("/persona")).toEqual({ kind: "persona", rest: "" });
    expect(parseReplCommand("/persona cc --with-prompt")).toEqual({ kind: "persona", rest: "cc --with-prompt" });
    expect(parseReplCommand("/personax")).toEqual({ kind: "prompt", text: "/personax" }); // 不吃前缀邻居（与 /planx 同约定：未知 /word = 普通 prompt）
  });
  it("the builtin command menu lists /persona with args help", () => {
    const row = listSlashCommands({ skills: [], pluginCommands: [], extensionCommands: [] })
      .find((c) => c.name === "persona");
    expect(row).toBeDefined();
    expect(row?.args).toContain("--headers-only");
  });
  it("the switch flow composes: resolve → break predicate → record (integration of Task 12 pieces)", async () => {
    const ws = await mkdtemp(join(tmpdir(), "persona-repl-"));
    try {
      const next = resolvePersonaSwitch(registry, "cc", "--with-prompt");
      expect(next.ok).toBe(true);
      if (!next.ok) return;
      const old = resolveBootstrapPersona(registry, {}).resolved; // null
      const cold = personaSwitchBreaksCache(old, next.resolved);
      expect(cold).toBe(true);
      await recordPersonaChange({
        workspaceRoot: ws, sessionId: "s",
        to: { id: "cc", layers: next.resolved.layers },
        from: { id: null }, coldTurnExpected: cold,
      });
      expect(true).toBe(true); // 到达即组合无异常（条目形状 Task 12 已 pin）
    } finally { await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  });
});
