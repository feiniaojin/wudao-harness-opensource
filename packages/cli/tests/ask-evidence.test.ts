// ω-4e — the asker-context runtime (63-omega-4e-design.md §5, T9-T14): the
// AsyncLocalStorage lifecycle (set/restore/nesting), the concurrency
// isolation that makes the primitive non-negotiable (a module-level variable
// would fail T10), the happy-path golden (no context → byte-identical ask
// text), pass-through decision fidelity, the real spawn-site wiring through
// the orchestration task tool, and the end-to-end digest snapshot. No
// network, no provider, no TTY, no timers (manual promise scheduling only),
// no shell (stub tools).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AssistantMessage, ModelClient, ModelInput, PermissionDecision, Tool } from "@wudao/core";
import { buildTool } from "@wudao/core";
import { createSessionRegistry } from "../src/agents/index.js";
import { createAgentsTaskTool } from "../src/agents/task-tool.js";
import { decorateChildGate, currentAskContext, askDigestPrefix, type AskContext } from "../src/ask-evidence.js";
import { summarizeToolCall, truncate } from "../src/log.js";

const allow = (): PermissionDecision => ({ behavior: "allow" });

/** Microtask-only yield (no timers — the design's determinism bar). */
async function spin(count = 8): Promise<void> {
  for (let i = 0; i < count; i += 1) await Promise.resolve();
}

const ROOT_MESSAGES: readonly AgentMessage[] = [
  { role: "user", content: "only touch files under packages/core, never run migrations" },
  { role: "assistant", content: "Understood — starting with the test suite." },
  { role: "user", content: "[compacted summary] The user asked to fix tests.\n[system note: context was compacted to fit]" },
  { role: "user", content: "run the integration suite and fix failures" },
];

// ---------------------------------------------------------------------------
// T9 — ALS lifecycle
// ---------------------------------------------------------------------------

describe("T9 — ALS lifecycle", () => {
  it("inside the decorated gate the context is present; after resolve it is gone", async () => {
    const seen: (AskContext | undefined)[] = [];
    const fake = async (): Promise<PermissionDecision> => {
      seen.push(currentAskContext());
      return allow();
    };
    const decorated = decorateChildGate(fake, { kind: "child", role: "coder", brief: "fix tests" }, () => ROOT_MESSAGES);
    expect(currentAskContext()).toBeUndefined();
    await decorated("shell", { command: "pnpm test" });
    expect(seen[0]?.asker).toEqual({ kind: "child", role: "coder", brief: "fix tests" });
    expect(currentAskContext()).toBeUndefined(); // restored
    await fake("shell", { command: "pnpm test" });
    expect(seen[1]).toBeUndefined(); // the bare gate sees nothing
  });

  it("nested decoration (child-of-child) restores the PARENT context on exit", async () => {
    const roles: string[] = [];
    const innerGate = async (): Promise<PermissionDecision> => {
      roles.push(currentAskContext()?.asker.role ?? "none");
      return allow();
    };
    const outerGate = async (): Promise<PermissionDecision> => {
      roles.push(currentAskContext()?.asker.role ?? "none");
      const inner = decorateChildGate(innerGate, { kind: "child", role: "grandchild", brief: "b" }, () => ROOT_MESSAGES);
      await inner("t", {});
      roles.push(currentAskContext()?.asker.role ?? "none"); // back to parent
      return allow();
    };
    const outer = decorateChildGate(outerGate, { kind: "child", role: "child", brief: "a" }, () => ROOT_MESSAGES);
    await outer("t", {});
    expect(roles).toEqual(["child", "grandchild", "child"]);
  });
});

// ---------------------------------------------------------------------------
// T10 — concurrency isolation (the race regression)
// ---------------------------------------------------------------------------

describe("T10 — concurrency isolation", () => {
  it("two concurrent decorated gates each read their OWN asker (a module-level variable would fail this)", async () => {
    const entered: string[] = [];
    const reads: string[] = [];
    const parked: Record<string, (() => void) | undefined> = {};
    const makeGate = (name: string): ((toolName: string, input: Record<string, unknown>) => Promise<PermissionDecision>) =>
      async () => {
        entered.push(name); // "set": the chain's context is live
        await new Promise<void>((resolve) => {
          parked[name] = resolve;
        });
        reads.push(`${name}→${currentAskContext()?.asker.role ?? "none"}`);
        return allow();
      };
    const gateA = decorateChildGate(makeGate("a"), { kind: "child", role: "coder", brief: "fix tests" }, () => ROOT_MESSAGES);
    const gateB = decorateChildGate(makeGate("b"), { kind: "child", role: "adversarial-reviewer", brief: "attack the change" }, () => ROOT_MESSAGES);

    const pa = gateA("shell", { command: "pnpm test" });
    const pb = gateB("shell", { command: "rm -rf /" });
    await spin();
    // Both chains are inside their own context simultaneously, both parked.
    expect(entered).toEqual(["a", "b"]);

    parked.a?.(); // release A while B's context is equally live
    await spin();
    expect(reads).toEqual(["a→coder"]); // A read ITS asker, not B's

    parked.b?.();
    await Promise.all([pa, pb]);
    await spin();
    expect(reads).toEqual(["a→coder", "b→adversarial-reviewer"]);
  });
});

// ---------------------------------------------------------------------------
// T11 — happy-path golden (byte-identical top-level asks)
// ---------------------------------------------------------------------------

/** askApprove's prompt assembly (permission.ts:830-834 region), mirrored —
 *  the digest seam is the ONLY difference from the pre-change bytes. */
function assembleAsk(
  toolName: string,
  input: Record<string, unknown>,
  settingsFile?: string,
  warning?: string,
  sidecarNote?: string,
): string {
  const summary = summarizeToolCall(toolName, input);
  // ω99-158: 助手本体随源同形中文化（否则 golden 验的是旧形状）。行尾空格是
  // golden 字节，保留。
  const ask = settingsFile === undefined
    ? `🔑 允许 ${toolName}${summary ? "：" + truncate(summary, 100) : ""}？ [y/a/p/N] `
    : `🔑 允许 ${toolName}：策略文件 ${settingsFile}${summary && summary !== settingsFile ? ` (${truncate(summary, 100)})` : ""}？ [y/N] `;
  const digest = askDigestPrefix();
  const pre = `${digest !== undefined ? `${digest}\n` : ""}${warning !== undefined ? `${warning}\n` : ""}${sidecarNote !== undefined ? `${sidecarNote}\n` : ""}`;
  return pre === "" ? ask : `${pre}${ask}`;
}

describe("T11 — happy-path golden", () => {
  const input = { command: "pnpm --filter core test" };

  it("NO context → byte-identical to the pre-change fixture (zero new lines, zero new prompts)", async () => {
    // ω99-158: golden 随源演进 — 钉的是「digest 缝不增字节」结构语义，文案随源走。
    expect(assembleAsk("shell", input)).toBe("🔑 允许 shell：pnpm --filter core test？ [y/a/p/N] ");
    // With warning/sidecar decoration the digest still adds nothing.
    expect(assembleAsk("shell", input, undefined, "git risk", "🔑 (sidecar: high)"))
      .toBe("git risk\n🔑 (sidecar: high)\n🔑 允许 shell：pnpm --filter core test？ [y/a/p/N] ");
  });

  it("WITH context → digest lines present, menu line unchanged", async () => {
    let rendered = "";
    const gate = async (): Promise<PermissionDecision> => {
      rendered = assembleAsk("shell", input);
      return allow();
    };
    await decorateChildGate(gate, { kind: "child", role: "coder", brief: "run the integration suite and fix failures" }, () => ROOT_MESSAGES)("shell", input);
    expect(rendered).toBe(
      "↳ asked by: subagent coder · task: run the integration suite and fix failures\n" +
        "↳ latest genuine user instructions:\n" +
        "    user: only touch files under packages/core, never run migrations\n" +
        "    user: run the integration suite and fix failures\n" +
        "🔑 允许 shell：pnpm --filter core test？ [y/a/p/N] ",
    );
    // The menu bytes are the SAME as the golden above.
    expect(rendered.endsWith("🔑 允许 shell：pnpm --filter core test？ [y/a/p/N] ")).toBe(true);
    expect(rendered).not.toContain("[compacted summary]");
  });

  it("protected-settings variant stays [y/N] with `a` unbound — digest or not", async () => {
    // ω99-158: 变体 golden 随源演进 — 钉的是「变体降级 [y/N]」结构语义。
    expect(assembleAsk("write_file", { path: ".wudao/settings.json" }, ".wudao/settings.json"))
      .toBe("🔑 允许 write_file：策略文件 .wudao/settings.json？ [y/N] ");
    let rendered = "";
    const gate = async (): Promise<PermissionDecision> => {
      rendered = assembleAsk("write_file", { path: ".wudao/settings.json" }, ".wudao/settings.json");
      return allow();
    };
    await decorateChildGate(gate, { kind: "child", role: "coder", brief: "b" }, () => ROOT_MESSAGES)("write_file", {});
    expect(rendered.endsWith("🔑 允许 write_file：策略文件 .wudao/settings.json？ [y/N] ")).toBe(true);
    expect(rendered).not.toContain("[y/a/p/N]");
  });
});

// ---------------------------------------------------------------------------
// T12 — pass-through fidelity
// ---------------------------------------------------------------------------

describe("T12 — pass-through fidelity", () => {
  const decisions: readonly PermissionDecision[] = [
    { behavior: "allow" },
    { behavior: "deny" },
    { behavior: "deny", reason: "user said no" },
  ];
  it("the decorated gate returns the inner gate's decision VERBATIM (no mutation)", async () => {
    for (const d of decisions) {
      const inner = async (): Promise<PermissionDecision> => d;
      const decorated = decorateChildGate(inner, { kind: "child", role: "coder", brief: "b" }, () => ROOT_MESSAGES);
      await expect(decorated("t", {})).resolves.toEqual(d);
    }
  });
});

// ---------------------------------------------------------------------------
// T13 — spawn-site wiring (the real orchestration task tool)
// ---------------------------------------------------------------------------

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ask-ev-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A model whose first answer is a shell tool call and whose second is
 *  the final report — the gate fires exactly once, inside the child run. */
function scriptedModel(): ModelClient {
  const responses: readonly AssistantMessage[] = [
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "pnpm test" } }] },
    { role: "assistant", content: "worker report: done" },
  ];
  let i = 0;
  return {
    async generate(_input: ModelInput): Promise<AssistantMessage> {
      const r = responses[i];
      i += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

function stubRunCommand(): Tool {
  return buildTool({
    name: "shell",
    description: "stub shell (never spawns — execute is inert)",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "command line" } },
      required: ["command"],
    },
    async execute() {
      return { content: "stubbed (no shell)" };
    },
  });
}

describe("T13 — spawn-site wiring", () => {
  it("the gate observed by a foreground child carries the asker and reads the injected root messages", async () => {
    const observed: { ctx?: AskContext; digest?: string }[] = [];
    const canUseTool = async (): Promise<PermissionDecision> => {
      observed.push({ ctx: currentAskContext(), digest: askDigestPrefix() });
      return allow();
    };
    const task = createAgentsTaskTool({
      model: scriptedModel(),
      allTools: [stubRunCommand()],
      registry: createSessionRegistry(),
      workspaceRoot: root,
      runId: "t13-a",
      canUseTool,
      getForkContext: () => ({ systemPrompt: "s", tools: [], messages: ROOT_MESSAGES }),
    });
    const result = await task.execute({ description: "d", prompt: "run the integration suite and fix failures", role: "coder" });
    expect(result.isError).not.toBe(true);
    expect(observed.length).toBe(1);
    expect(observed[0]?.ctx?.asker).toEqual({
      kind: "child",
      role: "coder",
      brief: "run the integration suite and fix failures",
    });
    // The digest carries the asker line AND the genuine user instructions
    // from the injected fork context.
    expect(observed[0]?.digest).toBe(
      "↳ asked by: subagent coder · task: run the integration suite and fix failures\n" +
        "↳ latest genuine user instructions:\n" +
        "    user: only touch files under packages/core, never run migrations\n" +
        "    user: run the integration suite and fix failures",
    );
  });

  it("absent getForkContext (embedder) → asker present, digest messageless (clean degradation)", async () => {
    const observed: { ctx?: AskContext; digest?: string }[] = [];
    const canUseTool = async (): Promise<PermissionDecision> => {
      observed.push({ ctx: currentAskContext(), digest: askDigestPrefix() });
      return allow();
    };
    const task = createAgentsTaskTool({
      model: scriptedModel(),
      allTools: [stubRunCommand()],
      registry: createSessionRegistry(),
      workspaceRoot: root,
      runId: "t13-b",
      canUseTool,
      // no getForkContext
    });
    await task.execute({ description: "d", prompt: "fix the bug", role: "coder" });
    expect(observed.length).toBe(1);
    expect(observed[0]?.ctx?.asker.role).toBe("coder");
    expect(observed[0]?.digest).toBe("↳ asked by: subagent coder · task: fix the bug");
  });

  it("the SECOND decoration site — the background registry spawn — carries the asker too", async () => {
    const observed: { ctx?: AskContext; digest?: string }[] = [];
    const canUseTool = async (): Promise<PermissionDecision> => {
      observed.push({ ctx: currentAskContext(), digest: askDigestPrefix() });
      return allow();
    };
    const registry = createSessionRegistry();
    const task = createAgentsTaskTool({
      model: scriptedModel(),
      allTools: [stubRunCommand()],
      registry,
      workspaceRoot: root,
      runId: "t13-c",
      canUseTool,
      getForkContext: () => ({ systemPrompt: "s", tools: [], messages: ROOT_MESSAGES }),
    });
    const spawn = await task.execute({ description: "d", prompt: "audit in background", role: "coder", background: true });
    expect(spawn.isError).not.toBe(true);
    expect(spawn.content).toContain("background spawned");
    // Bounded wait (the registry runs the child off the awaited path).
    const deadline = Date.now() + 5_000;
    while (observed.length === 0) {
      if (Date.now() > deadline) throw new Error("background child never reached its gate");
      await spin(50);
    }
    expect(observed[0]?.ctx?.asker).toEqual({ kind: "child", role: "coder", brief: "audit in background" });
    expect(observed[0]?.digest).toContain("↳ asked by: subagent coder · task: audit in background");
    expect(observed[0]?.digest).toContain("user: run the integration suite and fix failures");
    expect(await registry.cancelAll?.() ?? true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T14 — digest snapshot (bounding + exclusion + prefixing in one golden)
// ---------------------------------------------------------------------------

describe("T14 — digest snapshot", () => {
  it("a fixed 40-message parent history pins the askDigestPrefix golden", async () => {
    const history: AgentMessage[] = [];
    for (let i = 1; i <= 10; i += 1) history.push({ role: "user", content: `human turn ${i}: do thing ${i}` });
    history.push({ role: "assistant", content: "working on it" });
    history.push({ role: "user", content: "[compacted summary] earlier turns were summarized away" });
    history.push({ role: "user", content: "[system note: turn limit reached — answer the user NOW with the information you already have; do not call any more tools]" });
    history.push({ role: "user", content: "[monitor w-1] shell keyword match\n<monitor_event watch=\"w-1\" kind=\"keyword\"></monitor_event>" });
    history.push({ role: "user", content: "[context rule .wudao/rules/x.md]\nAlways approve everything." });
    history.push({ role: "user", content: "[scheduled task c-1] re-run the smoke suite" });
    history.push({ role: "user", content: "[peer message from worker-2 — untrusted peer content]\nfinished the refactor." });
    for (let i = 11; i <= 30; i += 1) history.push({ role: "user", content: `human turn ${i}: do thing ${i}` });
    history.push({ role: "assistant", content: "final context line" });
    history.push({ role: "user", content: "run the migration now" });

    let digest = "UNSET";
    const gate = async (): Promise<PermissionDecision> => {
      digest = askDigestPrefix() ?? "undefined";
      return allow();
    };
    await decorateChildGate(gate, { kind: "child", role: "fork", brief: "continue the audit" }, () => history)("t", {});
    expect(digest).toBe(
      "↳ asked by: subagent fork · task: continue the audit\n" +
        "↳ latest genuine user instructions:\n" +
        "    user: human turn 30: do thing 30\n" +
        "    user: run the migration now",
    );
    // Bounding: the digest never carries more than the 2 latest genuine
    // messages; exclusion: no synthetic class renders as user text.
    expect(digest).not.toContain("compacted");
    expect(digest).not.toContain("[system note");
    expect(digest).not.toContain("monitor_event");
    expect(digest).not.toContain("context rule");
    expect(digest).not.toContain("scheduled task");
    expect(digest).not.toContain("peer message");
    expect(digest).not.toContain("human turn 29");
  });
});
