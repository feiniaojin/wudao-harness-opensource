// ω99-8 — 子代理用量归账：child（子代理）模型调用的 usage 必须进 cost
// registry（provider="subagent"、键=实际应答模型），让 fleet 会话的子代理
// 花销对 /cost 与 .wudao/costs.jsonl 可见。M61 评估器归账的一致性补漏：
// 评估器修了，子代理一直漏。观察缝 = task tool 的 onSubagentUsage——前台
// runner 与 background registry spawn 两类 child 全覆盖；recorder 失败隔离；
// 无 recorder 路径字节零变化（事件原样直传）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { AssistantMessage, ModelClient, ModelInput, ModelUsage, LoopEvent } from "@wudao-org/core";
import { createAgentsTaskTool, createSessionRegistry } from "../src/agents/index.js";
import { createSubagentCostSink } from "../src/repl.js";
import { CostRegistry } from "../src/commands/cost.js";
import type { CostLedgerRow } from "../src/commands/wallet.js";
import type { ProviderConfig } from "@wudao-org/providers";
import { createDriverSession, type DriverSession } from "../src/driver/session-engine.js";
import { createCacheTrackingModel } from "../src/cache.js";

/** Bounded wait (background children settle asynchronously). */
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "subagent-cost-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });

/** A scripted model that ALSO reports usage rows like a real provider (the
 *  provider's only usage channel is input.onUsage — the loop turns each call
 *  into one `usage` LoopEvent). `usageFor(i)` returns the row call i reports
 *  (undefined → silent, the plain scripted model's behavior). */
function usageModel(
  responses: readonly AssistantMessage[],
  usageFor: (i: number) => ModelUsage | undefined,
): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    modelId: "spawn-config-model",
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push(input);
      const row = usageFor(i);
      if (row !== undefined) input.onUsage?.(row);
      const r = responses[i];
      i += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

interface Seam {
  readonly events: LoopEvent[];
  readonly rows: { readonly childId?: string; readonly model: string; readonly usage: ModelUsage }[];
  readonly task: ReturnType<typeof createAgentsTaskTool>;
}

/** The task tool wired with BOTH observation lanes (the renderer lane and the
 *  ω99-8 recorder lane) over one shared scripted child model. */
function seam(model: ModelClient, extra?: { onUsageThrows?: boolean }): Seam {
  const events: LoopEvent[] = [];
  const rows: { readonly model: string; readonly usage: ModelUsage }[] = [];
  const task = createAgentsTaskTool({
    model,
    allTools: [],
    registry: createSessionRegistry(),
    workspaceRoot: root,
    runId: "cost-run",
    onSubagentEvent: (e) => events.push(e),
    onSubagentUsage: (info) => {
      if (extra?.onUsageThrows) throw new Error("recorder blew up");
      rows.push(info);
    },
  });
  return { events, rows, task };
}

const ROW = (over: Partial<ModelUsage> = {}): ModelUsage => ({
  promptTokens: 100,
  completionTokens: 10,
  cacheHitTokens: 0,
  cacheMissTokens: 100,
  ...over,
});

describe("task tool — ω99-8 子代理用量归账 (foreground runner)", () => {
  it("a child's usage event reaches the recorder with the ANSWERING model; the stream still forwards verbatim", async () => {
    const model = usageModel([{ role: "assistant", content: "child done" }], () => ROW({ model: "answering-model-x" }));
    const s = seam(model);
    const r = await s.task.execute({ description: "d", prompt: "p" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("child done");
    // 125 项 3: the row now carries the per-child identity (a stable
    // `sub-<uuid>` stamped by the wrapper — the goal rollup's dedup key) beside
    // the ω99-8 answering-model contract.
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]!.childId).toMatch(/^sub-[0-9a-f-]{36}$/);
    expect(s.rows[0]!.model).toBe("answering-model-x");
    expect(s.rows[0]!.usage).toEqual(ROW({ model: "answering-model-x" }));
    // The renderer lane still sees the SAME events (order/content untouched).
    const usageEvents = s.events.filter((e) => e.type === "usage");
    expect(usageEvents.length).toBe(1);
    expect(s.events.some((e) => e.type === "model_call_finished")).toBe(true);
  });

  it("model resolution chain: usage.model → fallbackModel → the spawn config's modelId", async () => {
    // (a) usage.model wins.
    const a = seam(usageModel([{ role: "assistant", content: "ok" }], () => ROW({ model: "m-primary", fallbackModel: "m-fallback" })));
    await a.task.execute({ description: "d", prompt: "p" });
    expect(a.rows.map((x) => x.model)).toEqual(["m-primary"]);
    // (b) only the fallback chain's name → it IS the answering model.
    const b = seam(usageModel([{ role: "assistant", content: "ok" }], () => ROW({ fallbackModel: "m-fallback" })));
    await b.task.execute({ description: "d", prompt: "p" });
    expect(b.rows.map((x) => x.model)).toEqual(["m-fallback"]);
    // (c) neither (scripted/odd gateways) → the spawn config's modelId.
    const c = seam(usageModel([{ role: "assistant", content: "ok" }], () => ROW()));
    await c.task.execute({ description: "d", prompt: "p" });
    expect(c.rows.map((x) => x.model)).toEqual(["spawn-config-model"]);
  });

  it("a throwing recorder is isolated: events still forward, the child run is unaffected", async () => {
    const model = usageModel([{ role: "assistant", content: "child done" }], () => ROW({ model: "m-x" }));
    const s = seam(model, { onUsageThrows: true });
    const r = await s.task.execute({ description: "d", prompt: "p" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("child done");
    expect(s.events.filter((e) => e.type === "usage").length).toBe(1);
  });

  it("no recorder wired → the renderer lane behaves exactly as before (the usage event still arrives)", async () => {
    const model = usageModel([{ role: "assistant", content: "child done" }], () => ROW({ model: "m-x" }));
    const events: LoopEvent[] = [];
    const task = createAgentsTaskTool({
      model,
      allTools: [],
      registry: createSessionRegistry(),
      workspaceRoot: root,
      runId: "cost-run",
      onSubagentEvent: (e) => events.push(e),
    });
    const r = await task.execute({ description: "d", prompt: "p" });
    expect(r.isError).toBeFalsy();
    expect(events.filter((e) => e.type === "usage").length).toBe(1); // behavioral equivalence with the pre-ω99-8 path
  });
});

describe("task tool — ω99-8 background registry spawn", () => {
  it("a background child's usage reaches the recorder through the registry's onEvent thread", async () => {
    const model = usageModel([{ role: "assistant", content: "bg done" }], () => ROW({ model: "answering-model-x" }));
    const s = seam(model);
    const r = await s.task.execute({ description: "d", prompt: "p", background: true });
    expect(r.isError).toBeFalsy();
    await until(() => s.rows.length === 1, "the background child's usage row");
    expect(s.rows[0].model).toBe("answering-model-x");
  });
});

// ω99-8b — the exactly-once seam. The client-level meter (cache tracker's
// onUsage, where session-engine/repl wire costRegistry.record) fires on EVERY
// call of the shared client — child calls included. With the core stamp
// (querySource="subagent") the meter SKIPS the row and the ω99-8 forwarder
// owns it; without the stamp both lanes record → DOUBLE COUNT (the reason
// ω99-8 was held back from push).
describe("task tool — ω99-8b 恰一次分区（同 client 孩子恰一行账）", () => {
  it("one shared-client child call lands EXACTLY ONE row: wrapper skips the tag, the forwarder owns it", async () => {
    const registry = new CostRegistry({});
    const inner = usageModel([{ role: "assistant", content: "child done" }], () => ROW({ model: "child-answer-model" }));
    // The client-level meter, exactly as the three construction sites wire it
    // (guard first, record after — observer-neutral on the wrapper side).
    const wrapped = createCacheTrackingModel(inner, {
      onUsage: (u, _s, _w, src) => {
        if (src === "subagent") return;
        registry.record({ model: "boot-model", provider: "deepseek", usage: u });
      },
    });
    const task = createAgentsTaskTool({
      model: wrapped,
      allTools: [],
      registry: createSessionRegistry(),
      workspaceRoot: root,
      runId: "cost-run",
      onSubagentEvent: () => {},
      onSubagentUsage: (info) => registry.record({ model: info.model, provider: "subagent", usage: info.usage }),
    });
    const r = await task.execute({ description: "d", prompt: "p" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("child done");
    expect(registry.rows.length).toBe(1); // EXACTLY once — pre-ω99-8b this is 2 (double count)
    expect(registry.rows[0]).toMatchObject({ model: "child-answer-model", provider: "subagent" });
  });

  it("an untagged MAIN call on the same client still lands its own parent row (the guard only skips subagent)", async () => {
    const registry = new CostRegistry({});
    const inner = usageModel(
      [
        { role: "assistant", content: "MAIN-CALL" },
        { role: "assistant", content: "child done" },
      ],
      (i) => (i === 0 ? ROW({ model: "main-answer-model" }) : ROW({ model: "child-answer-model" })),
    );
    const wrapped = createCacheTrackingModel(inner, {
      onUsage: (u, _s, _w, src) => {
        if (src === "subagent") return;
        registry.record({ model: "boot-model", provider: "deepseek", usage: u });
      },
    });
    // The MAIN loop's own call on the shared client — untagged, records as before.
    await wrapped.generate({ systemPrompt: "s", messages: [{ role: "user", content: "main" }], tools: [] });
    const task = createAgentsTaskTool({
      model: wrapped,
      allTools: [],
      registry: createSessionRegistry(),
      workspaceRoot: root,
      runId: "cost-run",
      onSubagentEvent: () => {},
      onSubagentUsage: (info) => registry.record({ model: info.model, provider: "subagent", usage: info.usage }),
    });
    const r = await task.execute({ description: "d", prompt: "p" });
    expect(r.isError).toBeFalsy();
    // Main call (untagged) → deepseek row; child call (stamped) → subagent row.
    expect(registry.rows).toHaveLength(2);
    expect(registry.rows.filter((x) => x.provider === "subagent")).toHaveLength(1);
    expect(registry.rows.filter((x) => x.provider === "deepseek")).toHaveLength(1);
  });
});

describe("repl sink — bind 前 no-op、bind 后入账", () => {
  it("records before the bind vanish; after the bind every row lands as provider=subagent", () => {
    const sink = createSubagentCostSink();
    sink.record({ model: "pre-bind-model", usage: ROW() }); // no registry yet — no-op, never throws
    const registry = new CostRegistry({});
    sink.bind(registry);
    sink.record({ model: "child-m", usage: ROW({ model: "child-m" }) });
    expect(registry.rows.length).toBe(1); // the pre-bind record never landed
    expect(registry.rows[0]).toEqual({ model: "child-m", provider: "subagent", usage: ROW({ model: "child-m" }), costUsd: null });
  });
});

describe("session-engine wiring — driver fleet run lands child rows in the cost ledger", () => {
  it("a foreground child's usage row reaches .wudao/costs.jsonl as provider=subagent keyed by the answering model", async () => {
    // One scripted model serves parent AND child (unpinned role → the session
    // model): parent dispatches, child answers WITH a usage row, parent
    // finishes. The auto-title side-call may consume a 4th generate (its
    // exhaustion/failure is silently swallowed by design).
    const model = usageModel(
      [
        { role: "assistant", content: "", toolCalls: [{ id: "p1", name: "task", arguments: { description: "run child", prompt: "child brief" } }] },
        { role: "assistant", content: "CHILD-DONE" },
        { role: "assistant", content: "PARENT-DONE" },
      ],
      (i) => (i === 1 ? ROW({ promptTokens: 111, completionTokens: 22, cacheMissTokens: 111, model: "child-answer-model" }) : undefined),
    );
    const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "boot-model", provider: "deepseek" };
    const origArgv = process.argv;
    const origDefer = process.env.WUDAO_DEFER_TOOLS;
    process.argv = [...origArgv, "--auto"];
    process.env.WUDAO_DEFER_TOOLS = "off"; // the task tool callable without load_tools
    let session: DriverSession;
    try {
      session = await createDriverSession({
        config,
        workspaceRoot: root,
        contextWindowTokens: 64_000,
        sessionId: "subagent-cost-0001",
        modelOverride: model,
        noPeer: true,
      });
    } finally {
      process.argv = origArgv;
      if (origDefer === undefined) delete process.env.WUDAO_DEFER_TOOLS;
      else process.env.WUDAO_DEFER_TOOLS = origDefer;
    }
    try {
      session.driver.submit("dispatch the child");
      await until(
        () => session.driver.getStatus().busy === false && session.driver.getHistory().some((h) => h.kind === "assistant" && h.text === "PARENT-DONE"),
        "the run to finish",
      );
      await session.close(); // sessionEnd → flushToLedger → .wudao/costs.jsonl
      const rows = readFileSync(join(root, ".wudao", "costs.jsonl"), "utf8")
        .split("\n").map((l) => l.trim()).filter((l) => l !== "")
        .map((l) => JSON.parse(l) as CostLedgerRow);
      const subagent = rows.filter((x) => x.provider === "subagent");
      expect(subagent.length).toBe(1);
      expect(subagent[0]).toMatchObject({ model: "child-answer-model", calls: 1, promptTokens: 111, completionTokens: 22, costUsd: null });
    } finally {
      await session.close().catch(() => {});
    }
  });
});
