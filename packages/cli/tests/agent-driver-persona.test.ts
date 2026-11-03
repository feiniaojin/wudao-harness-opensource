// SDD 2026-08-23 persona settings + provider binding — Task 2: the DRIVER's
// /persona handler (agent-driver.ts case "persona"). Semantics mirror the
// REPL handler (repl.ts ~1668-1730) line for line, with appendHistory
// notices in place of stdout.write: list (with provenance mark), switch
// (manual layer, reason "manual", cold note, mismatch note), --off (clear
// the manual layer, follow the resolution chain, reason "off"), fail-closed
// unknown id, and the degraded back-compat notice when no persona context
// was injected.
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionStore, createScriptedModel, createReadFileTool } from "@wudao-org/core";
import { createPersonaRuntime, lookupPersona, resolvePersona } from "@wudao-org/providers";
import type { PersonaDefinition, PersonaRegistry, ResolvedPersona, ProtocolId } from "@wudao-org/providers";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver, DriverPersonaContext } from "../src/driver/agent-driver.js";
import { PERSONA_SWITCH_CACHE_NOTE, resolveActivePersona } from "../src/commands/persona.js";
import type { PersonaChainSources } from "../src/commands/persona.js";
import { summarizeToolCall } from "../src/log.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

async function tmpWs(tag: string): Promise<string> {
  return mkdtemp(join(tmpdir(), tag));
}

// ---------------------------------------------------------------------------
// Fixtures — the minimal persona pair the chain tests use (alpha headers-
// only on the openai-chat wire; beta adds a prompt layer so --with-prompt
// engages it and the cold-cache note fires).
// ---------------------------------------------------------------------------

const alphaDef: PersonaDefinition = {
  id: "alpha", displayName: "Alpha",
  source: { kind: "workspace-source", provenance: "test:alpha", pinnedVersion: "1" },
  headers: { "openai-chat": { "x-client": "alpha" } },
};
const betaDef: PersonaDefinition = {
  id: "beta", displayName: "Beta",
  source: { kind: "workspace-source", provenance: "test:beta", pinnedVersion: "1" },
  headers: { "openai-chat": { "x-client": "beta" } },
  prompt: { system: { mode: "prefix", text: "You are Beta.\n" } },
};
const registry: PersonaRegistry = { personas: [alphaDef, betaDef], errors: [] };

/** The DriverPersonaContext a frontend builds at construction: chain sources
 *  (env/binding/default), a runtime seeded with the chain's resolution, and
 *  the protocol the live wire speaks. */
interface CtxOver {
  readonly env?: string;
  readonly binding?: string | null;
  readonly default?: string;
  readonly wire?: ProtocolId;
}

function personaCtx(over: CtxOver = {}): DriverPersonaContext {
  const sources: PersonaChainSources = {
    envPersona: over.env !== undefined ? resolvePersona(lookupPersona(registry, over.env)!) : null,
    bindingId: over.binding,
    defaultId: over.default,
  };
  return {
    registry,
    runtime: createPersonaRuntime(resolveActivePersona(registry, sources).resolved),
    chain: () => sources,
    wire: () => over.wire ?? "openai-chat",
  };
}

function makeDriver(over: Parameters<typeof createAgentDriver>[0] = {}): AgentDriver {
  return createAgentDriver({
    systemPrompt: "s",
    summarize: summarizeToolCall,
    model: createScriptedModel([]),
    tools: [createReadFileTool({ workspaceRoot: process.cwd() })],
    ...over,
  });
}

const personaOf = (d: AgentDriver): DriverPersonaContext => {
  if (d.persona === undefined) throw new Error("persona context not injected");
  return d.persona;
};

const lastNotice = (d: AgentDriver): string => {
  const notices = d.getHistory().filter((e) => e.kind === "notice");
  const last = notices[notices.length - 1];
  return last !== undefined && last.kind === "notice" ? last.text : "";
};

/** Reads the session JSONL, polling until the record write (fired
 *  asynchronously by the sync submit) has landed — `minEntries` persona
 *  records present and the LAST entry being the persona_change is the
 *  stable condition (no run starts, nothing writes after it). */
async function readSessionEntries(ws: string, sessionId: string, minEntries = 1): Promise<readonly { type?: string; data?: Record<string, unknown> }[]> {
  const store = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
  const landed = (entries: readonly { type?: string }[]): boolean => {
    const last = entries[entries.length - 1];
    return entries.length >= minEntries && last !== undefined && last.type === "persona_change";
  };
  for (let i = 0; i < 500; i += 1) {
    const entries = await store.loadSessionEntries(sessionId).catch(() => [] as { type?: string }[]);
    if (landed(entries)) return entries as { type?: string; data?: Record<string, unknown> }[];
    await wait();
  }
  return (await store.loadSessionEntries(sessionId).catch(() => [])) as { type?: string; data?: Record<string, unknown> }[];
}

// ---------------------------------------------------------------------------
// List — the provenance mark
// ---------------------------------------------------------------------------

describe("driver /persona — list", () => {
  it("/persona list works through the driver with the bound provenance mark", async () => {
    const ws = await tmpWs("drv-persona-1-");
    try {
      const d = makeDriver({ workspaceRoot: ws, sessionId: "wudao-persona-1", persona: personaCtx({ binding: "alpha" }) });
      d.submit("/persona");
      expect(lastNotice(d)).toContain("personas (");
      expect(lastNotice(d)).toContain("← current [bound:alpha]");
      d.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("env and default provenance map through; none → no current mark", async () => {
    const ws = await tmpWs("drv-persona-2-");
    try {
      const env = makeDriver({ workspaceRoot: ws, sessionId: "wudao-persona-2", persona: personaCtx({ env: "alpha" }) });
      env.submit("/persona");
      expect(lastNotice(env)).toContain("← current [env]");
      env.dispose();

      const def = makeDriver({ workspaceRoot: ws, sessionId: "wudao-persona-2b", persona: personaCtx({ default: "beta" }) });
      def.submit("/persona");
      expect(lastNotice(def)).toContain("← current [default]");
      def.dispose();

      const none = makeDriver({ workspaceRoot: ws, sessionId: "wudao-persona-2c", persona: personaCtx({}) });
      none.submit("/persona");
      expect(lastNotice(none)).not.toContain("← current");
      none.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("after a manual switch the current row is marked [manual]; --off returns to the chain mark", async () => {
    const ws = await tmpWs("drv-persona-2d-");
    try {
      const d = makeDriver({ workspaceRoot: ws, sessionId: "wudao-persona-2d", persona: personaCtx({ env: "alpha" }) });
      d.submit("/persona beta");
      d.submit("/persona");
      expect(lastNotice(d)).toContain("beta");
      expect(lastNotice(d)).toContain("← current [manual]");
      d.submit("/persona --off");
      d.submit("/persona");
      expect(lastNotice(d)).toContain("← current [env]");
      await readSessionEntries(ws, "wudao-persona-2d", 2); // drain the async records before rm
      d.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

// ---------------------------------------------------------------------------
// Switch — the manual layer
// ---------------------------------------------------------------------------

describe("driver /persona — switch (manual layer)", () => {
  it("/persona <id> switches the manual layer, records reason:manual", async () => {
    const ws = await tmpWs("drv-persona-3-");
    try {
      const d = makeDriver({ workspaceRoot: ws, sessionId: "wudao-persona-3", persona: personaCtx({}) });
      d.submit("/persona beta");
      expect(personaOf(d).runtime.current?.definition.id).toBe("beta");
      expect(lastNotice(d)).toContain("persona → beta");
      expect(lastNotice(d)).toContain("—— 下一个请求即生效"); // ω99-166f-ii: 钉随源演进
      const entries = await readSessionEntries(ws, "wudao-persona-3");
      const last = entries[entries.length - 1];
      expect(last?.type).toBe("persona_change");
      expect(last?.data).toMatchObject({ reason: "manual", id: "beta" });
      // headers/body on, prompt off → NO cold note on this switch.
      expect(lastNotice(d)).not.toContain(PERSONA_SWITCH_CACHE_NOTE);
      d.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("cold note when the prompt layer is on (--with-prompt)", async () => {
    const ws = await tmpWs("drv-persona-4-");
    try {
      const d = makeDriver({ workspaceRoot: ws, sessionId: "wudao-persona-4", persona: personaCtx({}) });
      d.submit("/persona beta --with-prompt");
      expect(personaOf(d).runtime.current?.layers.prompt).toBe(true);
      expect(lastNotice(d)).toContain(PERSONA_SWITCH_CACHE_NOTE);
      const entries = await readSessionEntries(ws, "wudao-persona-4");
      expect(entries[entries.length - 1]?.data).toMatchObject({ id: "beta", layers: ["headers", "body", "prompt"], coldTurnExpected: true });
      d.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("mismatch note when the persona defines nothing on the live wire", async () => {
    const ws = await tmpWs("drv-persona-5-");
    try {
      // The wire speaks anthropic; alpha/beta define headers only for
      // openai-chat — the wire is byte-unchanged and the notice says so.
      const d = makeDriver({ workspaceRoot: ws, sessionId: "wudao-persona-5", persona: personaCtx({ wire: "anthropic" }) });
      d.submit("/persona beta");
      expect(lastNotice(d)).toContain("persona → beta");
      expect(lastNotice(d)).toContain("注：此 persona 未定义 anthropic 的 headers/body——这里只有 prompt 层生效"); // ω99-166f-ii: 钉随源演进
      await readSessionEntries(ws, "wudao-persona-5"); // drain the async record before rm
      d.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

// ---------------------------------------------------------------------------
// --off — clear the manual layer, follow the chain
// ---------------------------------------------------------------------------

describe("driver /persona --off", () => {
  it("clears the manual layer and follows the chain (env present → env persona)", async () => {
    const ws = await tmpWs("drv-persona-6-");
    try {
      const d = makeDriver({ workspaceRoot: ws, sessionId: "wudao-persona-6", persona: personaCtx({ env: "alpha" }) });
      d.submit("/persona beta");
      d.submit("/persona --off");
      expect(personaOf(d).runtime.current?.definition.id).toBe("alpha");
      expect(lastNotice(d)).toContain("persona → alpha");
      const entries = await readSessionEntries(ws, "wudao-persona-6", 2);
      expect(entries[entries.length - 1]?.data).toMatchObject({ reason: "off", id: "alpha" });
      d.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("no chain sources → off (bare client), entry records id null with reason:off", async () => {
    const ws = await tmpWs("drv-persona-7-");
    try {
      const d = makeDriver({ workspaceRoot: ws, sessionId: "wudao-persona-7", persona: personaCtx({}) });
      d.submit("/persona beta");
      d.submit("/persona --off");
      expect(personaOf(d).runtime.current).toBeNull();
      expect(lastNotice(d)).toContain("persona → off (bare client)");
      const entries = await readSessionEntries(ws, "wudao-persona-7", 2);
      expect(entries[entries.length - 1]?.data).toMatchObject({ reason: "off", id: null });
      d.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

describe("driver /persona — failure modes", () => {
  it("unknown persona id is fail-closed (runtime untouched, error notice)", async () => {
    const ws = await tmpWs("drv-persona-8-");
    try {
      const d = makeDriver({ workspaceRoot: ws, sessionId: "wudao-persona-8", persona: personaCtx({}) });
      d.submit("/persona beta"); // 先设一个，确保 current 非空
      d.submit("/persona ghost");
      expect(lastNotice(d)).toMatch(/unknown persona|not found/i);
      expect(personaOf(d).runtime.current?.definition.id).toBe("beta"); // 未被破坏
      await readSessionEntries(ws, "wudao-persona-8"); // drain the async record before rm
      d.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("a record failure does not crash — warning notice, runtime still switched (REPL parity)", async () => {
    const ws = await tmpWs("drv-persona-9-");
    try {
      // A workspaceRoot that is a FILE: the session-store mkdir under it
      // rejects, so the async record fails after the sync switch landed.
      const blocker = join(ws, "blocker");
      await writeFile(blocker, "x", "utf8");
      const d = makeDriver({ workspaceRoot: blocker, sessionId: "wudao-persona-9", persona: personaCtx({}) });
      d.submit("/persona beta");
      expect(personaOf(d).runtime.current?.definition.id).toBe("beta");
      await until(
        () => d.getHistory().some((e) => e.kind === "notice" && e.text.includes("persona 切换记录未写入")), // ω99-166c-iii: #8 钉演进（孪生归一）
        "record-failure warning",
      );
      d.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("persona option absent → degraded notice (back-compat, e.g. scripted tests)", async () => {
    const ws = await tmpWs("drv-persona-10-");
    try {
      const d = makeDriver({ workspaceRoot: ws, sessionId: "wudao-persona-10" }); // 不注入 persona
      expect(d.submit("/persona")).toBe("notice");
      expect(lastNotice(d)).toContain("persona 不可用"); // ω99-166f-ii: 钉随源演进（brief 二节漏判的钉）
      d.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("usage errors surface verbatim (unknown flag / --off with args)", async () => {
    const ws = await tmpWs("drv-persona-11-");
    try {
      const d = makeDriver({ workspaceRoot: ws, sessionId: "wudao-persona-11", persona: personaCtx({}) });
      d.submit("/persona beta --wat");
      expect(lastNotice(d)).toContain("unknown flag --wat");
      d.submit("/persona --off now");
      expect(lastNotice(d)).toContain("/persona --off takes no arguments");
      expect(personaOf(d).runtime.current).toBeNull(); // nothing applied
      d.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
