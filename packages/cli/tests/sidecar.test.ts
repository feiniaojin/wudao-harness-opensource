// M45 — the auto-mode sidecar classifier: input shape (structured fields
// ONLY — ADR-009 red line), verdict parsing (M29 schema subset), the LRU
// verdict cache, the 4s timeout error path, the rejection circuit breaker,
// and the three config channels (settings / env / flag).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput } from "@wudao/core";
import { createEditTool } from "@wudao/core";
import {
  SIDECAR_CLASSIFIER_PROMPT,
  SIDECAR_CACHE_LIMIT,
  createSidecar,
  parseSidecarReply,
  loadSidecarSettings,
  resolveSidecarRuntime,
  DEFAULT_SIDECAR_SETTINGS,
  // ω99-42: the classifier-config shape pin (soft none).
  sidecarClassifierConfig,
} from "../src/sidecar.js";
import type { ProviderConfig } from "@wudao/providers";

/** A scripted sidecar model: records every ModelInput, answers from a queue. */
function fakeModel(
  respond: (input: ModelInput, call: number) => AssistantMessage | Promise<AssistantMessage>,
): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push(input);
      return respond(input, inputs.length);
    },
  };
}

const reply = (content: string): AssistantMessage => ({ role: "assistant", content });
const low = reply('{"risk":"low","reason":"routine edit"}');
const high = reply('{"risk":"high","reason":"destructive rm -rf"}');
const WRITE_ARGS = { path: "src/a.ts", content: "x" };

describe("parseSidecarReply (M29 schema subset, fail-closed)", () => {
  it("parses a plain low/high object", () => {
    expect(parseSidecarReply('{"risk":"low","reason":"fine"}')).toEqual({ kind: "low", reason: "fine" });
    expect(parseSidecarReply('{"risk":"high","reason":"danger"}')).toEqual({ kind: "high", reason: "danger" });
  });
  it("parses a fenced JSON block", () => {
    expect(parseSidecarReply('thinking...\n```json\n{"risk":"low","reason":"ok"}\n```')).toEqual({ kind: "low", reason: "ok" });
  });
  it("empty / non-JSON text is the error path", () => {
    expect(parseSidecarReply("I cannot answer that").kind).toBe("error");
    expect(parseSidecarReply("").kind).toBe("error");
  });
  it("schema violations are the error path (fail-closed)", () => {
    expect(parseSidecarReply('{"risk":"maybe","reason":"x"}').kind).toBe("error");
    expect(parseSidecarReply('{"risk":"low"}').kind).toBe("error");
    expect(parseSidecarReply('{"risk":"low","reason":42}').kind).toBe("error");
    expect(parseSidecarReply('["low"]').kind).toBe("error");
  });
});

describe("createSidecar input shape (ADR-009 red line)", () => {
  it("the classifier ModelInput carries ONLY the fixed prompt + one structured user message", async () => {
    const model = fakeModel(() => low);
    const sidecar = createSidecar({ model });
    await sidecar.check("write_file", WRITE_ARGS);
    expect(model.inputs.length).toBe(1);
    const input = model.inputs[0];
    if (!input) throw new Error("no input recorded");
    expect(input.systemPrompt).toBe(SIDECAR_CLASSIFIER_PROMPT);
    expect(input.tools).toEqual([]);
    expect(input.messages.length).toBe(1);
    const only = input.messages[0];
    if (!only || only.role !== "user") throw new Error("expected one user message");
    const parsed = JSON.parse(only.content) as { tool: string; arguments: unknown };
    expect(parsed.tool).toBe("write_file");
    expect(parsed.arguments).toEqual(WRITE_ARGS);
  });
  it("the serialized input is exactly the structured envelope — no conversation, no reasoning, no tool defs", async () => {
    const model = fakeModel(() => low);
    const sidecar = createSidecar({ model });
    await sidecar.check("shell", { command: "rm -rf /tmp/x" });
    const input = model.inputs[0];
    if (!input) throw new Error("no input recorded");
    const serialized = JSON.stringify(input);
    // The ONLY payload is the one user message; the system prompt is the fixed
    // constant. Nothing about the surrounding conversation is reachable here
    // (det-30 pins the same red line against a real conversation).
    expect(JSON.parse(serialized).messages.length).toBe(1);
    expect(serialized.includes('"role":"assistant"')).toBe(false);
    expect(serialized.includes('"role":"tool"')).toBe(false);
    expect(input.messages[0]?.content).toBe('{"arguments":{"command":"rm -rf /tmp/x"},"tool":"shell"}');
  });
});

describe("verdict cache (LRU 128)", () => {
  it("same tool+canonical args hit the cache: no second model call", async () => {
    const model = fakeModel(() => low);
    const sidecar = createSidecar({ model });
    const a = await sidecar.check("write_file", { path: "a", content: "x" });
    const b = await sidecar.check("write_file", { content: "x", path: "a" }); // key-order independent
    expect(a).toEqual(b);
    expect(model.inputs.length).toBe(1);
    expect(sidecar.checks()).toBe(1);
  });
  it("different args miss the cache", async () => {
    const model = fakeModel(() => low);
    const sidecar = createSidecar({ model });
    await sidecar.check("write_file", { path: "a" });
    await sidecar.check("write_file", { path: "b" });
    expect(model.inputs.length).toBe(2);
  });
  it("evicts the least recently used entry past the limit", async () => {
    const model = fakeModel(() => low);
    const sidecar = createSidecar({ model });
    await sidecar.check("write_file", { path: "first" });
    for (let i = 0; i < SIDECAR_CACHE_LIMIT; i += 1) {
      await sidecar.check("write_file", { path: `fill-${i}` });
    }
    expect(sidecar.cacheSize()).toBe(SIDECAR_CACHE_LIMIT);
    // "first" was evicted — rechecking it calls the model again.
    await sidecar.check("write_file", { path: "first" });
    expect(model.inputs.length).toBe(SIDECAR_CACHE_LIMIT + 2);
  });
  it("error verdicts are not cached (a transient timeout is retried)", async () => {
    let n = 0;
    const model = fakeModel(() => (n++ === 0 ? reply("garbage") : low));
    const sidecar = createSidecar({ model });
    expect((await sidecar.check("write_file", { path: "a" })).kind).toBe("error");
    expect((await sidecar.check("write_file", { path: "a" })).kind).toBe("low");
    expect(model.inputs.length).toBe(2);
  });
});

describe("timeout / model failure → error path (fail-closed)", () => {
  it("a model that never settles resolves as error after timeoutMs", async () => {
    const model: ModelClient = { generate: () => new Promise<AssistantMessage>(() => {}) };
    const sidecar = createSidecar({ model, timeoutMs: 25 });
    const started = Date.now();
    const verdict = await sidecar.check("shell", { command: "echo hi" });
    expect(verdict.kind).toBe("error");
    expect(verdict.reason).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(1500);
  });
  it("a throwing model resolves as error", async () => {
    const model: ModelClient = {
      generate: () => Promise.reject(new Error("boom")),
    };
    const sidecar = createSidecar({ model, timeoutMs: 1000 });
    const verdict = await sidecar.check("shell", { command: "echo hi" });
    expect(verdict.kind).toBe("error");
    expect(verdict.reason).toContain("boom");
  });
  // 基准×探针弧（4s 中止定谳后续）：①自适应升预算——连续超时 4→8→12s
  // 封顶（reason 里的预算数逐档翻倍）；②超时不进熔断计数（3 连超时后
  // breaker 仍关——旧语义此时已开→未分类全放行的安全降级）；③非超时
  // 错误照旧 fail-closed 计数（既有钉在 breaker describe）。
  it("连续超时自适应升预算（档位比 1→2→4 后持稳；小基数钉比例，帽=12s 常量）", async () => {
    const model: ModelClient = { generate: () => new Promise<AssistantMessage>(() => {}) };
    const sidecar = createSidecar({ model, timeoutMs: 25 });
    const v1 = await sidecar.check("shell", { command: "rm -rf /1" });
    expect(v1.kind).toBe("error");
    if (v1.kind === "error") expect(v1.reason).toContain("timed out after 25ms");
    const v2 = await sidecar.check("shell", { command: "rm -rf /2" });
    if (v2.kind === "error") expect(v2.reason).toContain("timed out after 50ms");
    const v3 = await sidecar.check("shell", { command: "rm -rf /3" });
    if (v3.kind === "error") expect(v3.reason).toContain("timed out after 100ms");
    const v4 = await sidecar.check("shell", { command: "rm -rf /4" });
    if (v4.kind === "error") expect(v4.reason).toContain("timed out after 100ms"); // 三档后持稳
  });
  it("超时不进熔断计数（3 连超时 breaker 仍关）", async () => {
    const model: ModelClient = { generate: () => new Promise<AssistantMessage>(() => {}) };
    const sidecar = createSidecar({ model, timeoutMs: 10 });
    for (let i = 0; i < 3; i += 1) await sidecar.check("shell", { command: `rm -rf /t${i}` });
    expect(sidecar.breakerOpen()).toBe(false); // 旧语义：3 连 error → 开
    expect(sidecar.consecutiveHighs()).toBe(0);
  });
});

describe("rejection circuit breaker (§1.5)", () => {
  async function runCalls(sidecar: ReturnType<typeof createSidecar>, n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) await sidecar.check("shell", { command: `rm -rf /tmp/${i}` });
  }
  it("opens at 3 consecutive highs (default threshold)", async () => {
    const sidecar = createSidecar({ model: fakeModel(() => high) });
    expect(sidecar.breakerOpen()).toBe(false);
    await runCalls(sidecar, 2);
    expect(sidecar.breakerOpen()).toBe(false);
    await runCalls(sidecar, 1);
    expect(sidecar.breakerOpen()).toBe(true);
    expect(sidecar.consecutiveHighs()).toBe(3);
  });
  it("threshold is configurable", async () => {
    const sidecar = createSidecar({ model: fakeModel(() => high), breakerThreshold: 2 });
    await runCalls(sidecar, 1);
    expect(sidecar.breakerOpen()).toBe(false);
    await runCalls(sidecar, 1);
    expect(sidecar.breakerOpen()).toBe(true);
  });
  it("one low resets the consecutive count", async () => {
    const responses = [high, high, low, high, high, high];
    let n = 0;
    const sidecar = createSidecar({ model: fakeModel(() => responses[n++ % responses.length] ?? low) });
    await runCalls(sidecar, 5); // high high low high high → count 2, still closed
    expect(sidecar.breakerOpen()).toBe(false);
    await runCalls(sidecar, 1); // third consecutive high → open
    expect(sidecar.breakerOpen()).toBe(true);
  });
  it("a cached high replay still feeds the breaker", async () => {
    const sidecar = createSidecar({ model: fakeModel(() => high) });
    await sidecar.check("shell", { command: "rm -rf /x" });
    await sidecar.check("shell", { command: "rm -rf /x" }); // cache hit
    await sidecar.check("shell", { command: "rm -rf /x" }); // cache hit
    expect(sidecar.breakerOpen()).toBe(true);
    expect(sidecar.checks()).toBe(1);
  });
  it("error verdicts count as rejections too (fail-closed)", async () => {
    const sidecar = createSidecar({ model: fakeModel(() => reply("{oops")) });
    await runCalls(sidecar, 3);
    expect(sidecar.breakerOpen()).toBe(true);
  });
  it("resetRun() zeroes everything (run boundary)", async () => {
    const sidecar = createSidecar({ model: fakeModel(() => high) });
    await runCalls(sidecar, 3);
    expect(sidecar.breakerOpen()).toBe(true);
    sidecar.resetRun();
    expect(sidecar.breakerOpen()).toBe(false);
    expect(sidecar.consecutiveHighs()).toBe(0);
    expect(sidecar.checks()).toBe(0);
    expect(sidecar.cacheSize()).toBe(0);
  });
  it("resetBreaker() is the manual-approval ground truth reset", async () => {
    const sidecar = createSidecar({ model: fakeModel(() => high) });
    await runCalls(sidecar, 3);
    sidecar.resetBreaker();
    expect(sidecar.breakerOpen()).toBe(false);
    expect(sidecar.consecutiveHighs()).toBe(0);
  });
});

describe("settings (.wudao/settings.json sidecar node)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wudao-sidecar-test-"));
    await mkdir(join(dir, ".wudao"), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("missing file → defaults", async () => {
    expect(await loadSidecarSettings(dir)).toEqual(DEFAULT_SIDECAR_SETTINGS);
  });
  it("reads the node", async () => {
    await writeFile(
      join(dir, ".wudao", "settings.json"),
      JSON.stringify({ sidecar: { enabled: false, model: "flash-mini", maxTokens: 128, timeoutMs: 2000, breakerThreshold: 5 } }),
      "utf8",
    );
    // M57 trust gate: the PROJECT tier cannot disarm the classifier —
    // enabled:false is dropped (stays default true); every non-privilege
    // field still applies.
    expect(await loadSidecarSettings(dir)).toEqual({
      enabled: true,
      model: "flash-mini",
      maxTokens: 128,
      timeoutMs: 2000,
      breakerThreshold: 5,
    });
  });
  it("M57: the GLOBAL tier may disable the sidecar (the user's own call)", async () => {
    const globalHome = await mkdtemp(join(tmpdir(), "wudao-glob-"));
    const prev = process.env.WUDAO_GLOBAL_HOME;
    process.env.WUDAO_GLOBAL_HOME = globalHome;
    try {
      await mkdir(globalHome, { recursive: true });
      await writeFile(
        join(globalHome, "settings.json"),
        JSON.stringify({ sidecar: { enabled: false } }),
        "utf8",
      );
      expect((await loadSidecarSettings(dir)).enabled).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.WUDAO_GLOBAL_HOME;
      else process.env.WUDAO_GLOBAL_HOME = prev;
      await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  it("malformed node warns and falls back per-field", async () => {
    const warns: string[] = [];
    await writeFile(
      join(dir, ".wudao", "settings.json"),
      JSON.stringify({ sidecar: { enabled: "yes", maxTokens: -1, timeoutMs: "4", breakerThreshold: 2.5, junk: 1 } }),
      "utf8",
    );
    const s = await loadSidecarSettings(dir, (m) => void warns.push(m));
    expect(s).toEqual({ ...DEFAULT_SIDECAR_SETTINGS, breakerThreshold: 3 });
    expect(warns.some((w) => w.includes("sidecar.enabled"))).toBe(true);
    expect(warns.some((w) => w.includes("sidecar.maxTokens"))).toBe(true);
    expect(warns.some((w) => w.includes("sidecar.timeoutMs"))).toBe(true);
    expect(warns.some((w) => w.includes("sidecar.breakerThreshold"))).toBe(true);
    expect(warns.some((w) => w.includes("junk"))).toBe(true);
  });
  it("malformed JSON warns and defaults", async () => {
    const warns: string[] = [];
    await writeFile(join(dir, ".wudao", "settings.json"), "{oops", "utf8");
    const s = await loadSidecarSettings(dir, (m) => void warns.push(m));
    expect(s).toEqual(DEFAULT_SIDECAR_SETTINGS);
    expect(warns.length).toBeGreaterThan(0);
  });
});

describe("resolveSidecarRuntime (three channels: settings < env < flag)", () => {
  it("defaults to enabled", () => {
    expect(resolveSidecarRuntime(DEFAULT_SIDECAR_SETTINGS, {}, []).enabled).toBe(true);
  });
  it("settings can disable", () => {
    expect(resolveSidecarRuntime({ ...DEFAULT_SIDECAR_SETTINGS, enabled: false }, {}, []).enabled).toBe(false);
  });
  it("WUDAO_SIDECAR=off beats settings enabled", () => {
    expect(resolveSidecarRuntime(DEFAULT_SIDECAR_SETTINGS, { WUDAO_SIDECAR: "off" }, []).enabled).toBe(false);
  });
  it("WUDAO_SIDECAR junk values do not disable", () => {
    expect(resolveSidecarRuntime(DEFAULT_SIDECAR_SETTINGS, { WUDAO_SIDECAR: "false" }, []).enabled).toBe(true);
  });
  it("--no-sidecar beats everything", () => {
    expect(resolveSidecarRuntime(DEFAULT_SIDECAR_SETTINGS, {}, ["--no-sidecar"]).enabled).toBe(false);
    expect(resolveSidecarRuntime({ ...DEFAULT_SIDECAR_SETTINGS, enabled: true }, { WUDAO_SIDECAR: "on" }, ["wudao", "--no-sidecar"]).enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The shared gate layer (permission.ts withSidecarLayer + scope)
// ---------------------------------------------------------------------------
import {
  sidecarGatesTool,
  withSidecarLayer,
  createPermissionGate,
  toolMetaResolverFor,
  type Mode,
  type SidecarEscalation,
  type StaticRuleDecide,
} from "../src/permission.js";
import { createAgentsTaskTool, createSessionRegistry } from "../src/agents/index.js";
import type { PermissionDecision } from "@wudao/core";

describe("sidecarGatesTool (scope matrix)", () => {
  it("audits the write/exec class and unknown tools", () => {
    for (const t of ["write_file", "edit", "shell", "mcp__github__create_pr", "ext_deploy", "some_future_tool"]) {
      expect(sidecarGatesTool(t)).toBe(true);
    }
  });
  it("skips the read class and the harness meta-tools", () => {
    for (const t of ["read_file", "glob", "grep", "todo_write", "ask_user", "load_tools", "agent_status"]) {
      expect(sidecarGatesTool(t)).toBe(false);
    }
  });
  it("agent_await is read-class (M45 review): awaits never classify", () => {
    // Waiting on an already-spawned agent mutates nothing the classifier
    // could audit — zero sidecar latency, zero breaker pressure.
    expect(sidecarGatesTool("agent_await")).toBe(false);
  });
});

/** Harness for the layer tests: a static decide stub + an escalation recorder. */
function layerHarness(args: {
  verdicts?: readonly string[]; // scripted sidecar replies (default [low])
  mode?: Mode | Mode[]; // live mode value(s), cycled per call
  staticDecision?: PermissionDecision | "ask";
  escalate?: (ctx: SidecarEscalation) => PermissionDecision;
}) {
  const replies = args.verdicts ?? ['{"risk":"low","reason":"fine"}'];
  let replyIdx = 0;
  const model = fakeModel(
    () =>
      ({
        role: "assistant",
        content:
          replies[replyIdx++ % replies.length] ?? '{"risk":"low","reason":"fine"}',
      }) as AssistantMessage,
  );
  const sidecar = createSidecar({ model });
  const modes = args.mode === undefined ? "auto" : args.mode;
  let call = 0;
  const modeList = Array.isArray(modes) ? modes : [modes];
  const escalateCalls: SidecarEscalation[] = [];
  const staticDecide: StaticRuleDecide = async () => args.staticDecision ?? { behavior: "allow" };
  const receipts: string[] = [];
  const gating: boolean[] = [];
  const gate = withSidecarLayer(
    {
      sidecar,
      getMode: () => modeList[Math.min(call, modeList.length - 1)] ?? "auto",
      escalate: async (_t, _i, ctx) => {
        escalateCalls.push(ctx);
        return args.escalate ? args.escalate(ctx) : { behavior: "deny", reason: ctx.circuitOpen ? "sidecar circuit-open" : `sidecar: ${ctx.reason ?? ""}` };
      },
      receipt: (l) => void receipts.push(l),
      onGating: (_n, on) => void gating.push(on),
    },
    staticDecide,
  );
  const next = async (tool = "shell", input: Record<string, unknown> = { command: "echo x" }) => {
    const r = await gate(tool, input);
    call += 1;
    return r;
  };
  return { sidecar, model, next, receipts, gating, escalations: escalateCalls };
}

describe("withSidecarLayer (auto mode gate)", () => {
  it("low → allow with the sidecar:low receipt", async () => {
    const h = layerHarness({});
    const d = await h.next();
    expect(d).toEqual({ behavior: "allow" });
    expect(h.receipts[0]).toContain("sidecar:low");
    expect(h.gating).toEqual([true, false]);
  });
  it("high → auto 托付：allow with the loud audit receipt, ZERO escalations (#452)", async () => {
    const h = layerHarness({ verdicts: ['{"risk":"high","reason":"rm -rf is destructive"}'] });
    const d = await h.next();
    expect(d).toEqual({ behavior: "allow" });
    expect(h.receipts[0]).toContain("sidecar:high");
    expect(h.receipts[0]).toContain("auto 托付模式自动放行");
    expect(h.receipts[0]).toContain("rm -rf is destructive");
    expect(h.escalations.length).toBe(0);
  });
  it("error verdict → auto 托付：allow with the sidecar:error receipt (#452)", async () => {
    const h = layerHarness({ verdicts: ["not json at all"] });
    const d = await h.next();
    expect(d).toEqual({ behavior: "allow" });
    expect(h.receipts[0]).toContain("sidecar:error");
    expect(h.receipts[0]).toContain("auto 托付模式自动放行");
    expect(h.escalations.length).toBe(0);
  });
  it("ask mode NEVER calls the classifier (human already gates)", async () => {
    const h = layerHarness({ mode: "default", staticDecision: "ask" });
    const d = await h.next();
    expect(d).toBe("ask");
    expect(h.sidecar.checks()).toBe(0);
    expect(h.escalations.length).toBe(0);
  });
  it("read-only denies never reach the sidecar", async () => {
    const h = layerHarness({ mode: "read-only", staticDecision: { behavior: "deny", reason: "read-only mode" } });
    const d = await h.next();
    expect(d).toEqual({ behavior: "deny", reason: "read-only mode" });
    expect(h.sidecar.checks()).toBe(0);
  });
  it("out-of-scope tools skip the classifier even in auto mode", async () => {
    const h = layerHarness({});
    const d = await h.next("read_file", { path: "a" });
    expect(d).toEqual({ behavior: "allow" });
    expect(h.sidecar.checks()).toBe(0);
  });
  it("static settings deny passes through untouched", async () => {
    const h = layerHarness({ staticDecision: { behavior: "deny", reason: 'settings deny rule "shell:rm"' } });
    const d = await h.next();
    expect(d).toEqual({ behavior: "deny", reason: 'settings deny rule "shell:rm"' });
    expect(h.sidecar.checks()).toBe(0);
  });
  it("the mode is read LIVE: a mid-run shift out of auto stops classifying", async () => {
    const h = layerHarness({ mode: ["auto", "default"] });
    await h.next(); // auto → classified (allow + in scope → one check)
    const d = await h.next(); // default (ask mode) → the layer steps aside
    expect(d).toEqual({ behavior: "allow" });
    expect(h.sidecar.checks()).toBe(1);
  });
  it("breaker open: no classifier call; auto 托付 direct allow; the trip notice fires (#452)", async () => {
    const h = layerHarness({ verdicts: ['{"risk":"high","reason":"r1"}'] });
    // Distinct args → 3 real model calls → breaker opens.
    await h.next("shell", { command: "rm -rf /a" });
    await h.next("shell", { command: "rm -rf /b" });
    await h.next("shell", { command: "rm -rf /c" });
    expect(h.sidecar.breakerOpen()).toBe(true);
    const checksAtOpen = h.sidecar.checks();
    const d = await h.next("shell", { command: "rm -rf /d" });
    expect(h.sidecar.checks()).toBe(checksAtOpen); // zero sidecar model calls — the breaker only SAVES the round-trip
    expect(d).toEqual({ behavior: "allow" }); // 托付不打断：no escalation, no ask
    expect(h.escalations.length).toBe(0);
    expect(h.receipts.some((r) => r.includes("连续高风险"))).toBe(true); // the trip notice
    // 0.3.82: the per-call (未分类) receipt is retired — the allow COUNTS on
    // the sidecar now (the run's settle seam aggregates it to one receipt).
    expect(h.sidecar.breakerAllows()).toBe(1);
    expect(h.receipts.some((r) => r.includes("自动放行（未分类）"))).toBe(false);
  });
  it("while open the breaker STAYS open — the run boundary (resetRun) is the only reset (#452)", async () => {
    const h = layerHarness({ verdicts: ['{"risk":"high","reason":"r"}'] });
    for (const c of ["a", "b", "c"]) await h.next("shell", { command: `rm -rf /${c}` });
    expect(h.sidecar.breakerOpen()).toBe(true);
    const checksAtOpen = h.sidecar.checks();
    for (const c of ["d", "e"]) await h.next("shell", { command: `rm -rf /${c}` }); // both auto-allow
    expect(h.sidecar.breakerOpen()).toBe(true); // allows never reset it — no approval path exists anymore
    expect(h.sidecar.checks()).toBe(checksAtOpen); // and nothing classifies while open
    h.sidecar.resetRun(); // the run boundary the driver calls at submit
    expect(h.sidecar.breakerOpen()).toBe(false);
    const d = await h.next("shell", { command: "rm -rf /f" });
    expect(d).toEqual({ behavior: "allow" });
    expect(h.sidecar.checks()).toBe(1); // resetRun zeroed the counter; one classify since
  });
  it("the trip notice fires ONCE per trip, not per gated call (M45 review, #452 wording)", async () => {
    const h = layerHarness({ verdicts: ['{"risk":"high","reason":"r"}'] });
    for (const c of ["a", "b", "c"]) await h.next("shell", { command: `rm -rf /${c}` });
    expect(h.sidecar.breakerOpen()).toBe(true);
    // Two more calls while open — each auto-allows, but the trip notice must
    // not repeat (a state check, not a per-call emission).
    await h.next("shell", { command: "rm -rf /d" });
    await h.next("shell", { command: "rm -rf /e" });
    expect(h.receipts.filter((r) => r.includes("连续高风险")).length).toBe(1);
    // And a fresh trip (after a run-boundary resetRun) notices again.
    h.sidecar.resetRun();
    for (const c of ["f", "g", "h"]) await h.next("shell", { command: `rm -rf /${c}` }); // trips again
    await h.next("shell", { command: "rm -rf /i" }); // open again → notice #2
    expect(h.receipts.filter((r) => r.includes("连续高风险")).length).toBe(2);
  });
  it("while open every gated call still COUNTS (the audit trail the settle seam aggregates, 0.3.82)", async () => {
    const h = layerHarness({ verdicts: ['{"risk":"high","reason":"r"}'] });
    for (const c of ["a", "b", "c"]) await h.next("shell", { command: `rm -rf /${c}` });
    await h.next("shell", { command: "rm -rf /d" });
    await h.next("shell", { command: "rm -rf /e" });
    // The per-call receipts are retired (0.3.81 clutter) — the counter is the
    // audit trail now: two auto-allows while open, zero (未分类) receipts.
    expect(h.sidecar.breakerAllows()).toBe(2);
    expect(h.receipts.filter((r) => r.includes("自动放行（未分类）")).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// M45 review — the shared gate builder (one-shot main gate + the REPL's
// buildTools gate, which is ALSO the gate the task tool's children inherit).
// ---------------------------------------------------------------------------

describe("createPermissionGate (shared builder carries the sidecar)", () => {
  // The builder reads .wudao/settings.json rules from cwd — isolate it from
  // whatever repo the suite runs in.
  let dir: string;
  let cwd: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gate-"));
    cwd = process.cwd();
    process.chdir(dir);
  });
  afterEach(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  it("auto mode + a sidecar: a shell classifies before the allow", async () => {
    const sidecar = createSidecar({ model: fakeModel(() => low) });
    const gate = createPermissionGate(["wudao", "--auto"], sidecar);
    const d = await gate("shell", { command: "echo x" });
    expect(d).toEqual({ behavior: "allow" });
    expect(sidecar.checks()).toBe(1);
  });
  it("without a sidecar the gate is unchanged: allow, zero classifier calls", async () => {
    const gate = createPermissionGate(["wudao", "--auto"]);
    const d = await gate("shell", { command: "echo x" });
    expect(d).toEqual({ behavior: "allow" });
  });
  it("a high verdict auto-allows through the shared builder too (#452 托付；receipt rides stdout)", async () => {
    const sidecar = createSidecar({ model: fakeModel(() => high) });
    const gate = createPermissionGate(["wudao", "--auto"], sidecar);
    const d = await gate("shell", { command: "rm -rf /" });
    expect(d).toEqual({ behavior: "allow" });
    expect(sidecar.checks()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// M51 §3 — tool_flags in the structured input + the equivalence verdict cache
// ---------------------------------------------------------------------------

describe("M51 tool_flags + inputsEquivalent", () => {
  it("flags ride the classifier input as the fixed tool_flags field", async () => {
    const model = fakeModel(() => low);
    const sidecar = createSidecar({ model });
    await sidecar.check("write_file", WRITE_ARGS, { flags: { destructive: true, openWorld: false } });
    const sent = model.inputs[0]!.messages[0] as { role: "user"; content: string };
    expect(sent.content).toContain('"tool_flags":{"destructive":true,"open_world":false}');
  });

  it("no flags → no tool_flags field (the ADR-009 surface stays minimal)", async () => {
    const model = fakeModel(() => low);
    const sidecar = createSidecar({ model });
    await sidecar.check("write_file", WRITE_ARGS);
    const sent = model.inputs[0]!.messages[0] as { role: "user"; content: string };
    expect(sent.content).not.toContain("tool_flags");
  });

  it("inputsEquivalent widens the cache: semantically equal args replay without a classifier call", async () => {
    const model = fakeModel(() => low);
    const sidecar = createSidecar({ model });
    // equivalence: ignore a trailing-whitespace difference in `content`
    const eq = (a: Record<string, unknown>, b: Record<string, unknown>): boolean =>
      (a.content as string).trim() === (b.content as string).trim();
    await sidecar.check("write_file", { path: "a.ts", content: "let x = 1;" }, { inputsEquivalent: eq });
    const v = await sidecar.check("write_file", { path: "a.ts", content: "let x = 1;   " }, { inputsEquivalent: eq });
    expect(v).toEqual({ kind: "low", reason: "routine edit" });
    expect(model.inputs).toHaveLength(1); // replayed, not re-classified
    expect(sidecar.checks()).toBe(1);
  });

  it("equivalence never crosses tool identities", async () => {
    const model = fakeModel(() => low);
    const sidecar = createSidecar({ model });
    const eq = () => true;
    await sidecar.check("write_file", { a: 1 }, { inputsEquivalent: eq });
    await sidecar.check("shell", { a: 1 }, { inputsEquivalent: eq });
    expect(model.inputs).toHaveLength(2);
  });
});

describe("withSidecarLayer M51 toolMeta wiring", () => {
  it("toolMeta resolves flags (args-sensitive) and the custom equivalence into check()", async () => {
    const replies = ['{"risk":"low","reason":"fine"}'];
    let replyIdx = 0;
    const model = fakeModel(() => ({ role: "assistant", content: replies[replyIdx++ % replies.length] ?? "" }) as AssistantMessage);
    const sidecar = createSidecar({ model });
    const seen: string[] = [];
    // the spy sidecar: wrap check to record what the layer passes
    const origCheck = sidecar.check.bind(sidecar);
    sidecar.check = (tool, args, opts) => {
      seen.push(JSON.stringify({ flags: opts?.flags, hasEq: opts?.inputsEquivalent !== undefined }));
      return origCheck(tool, args, opts);
    };
    const eq = (a: Record<string, unknown>, b: Record<string, unknown>) => a.command === b.command;
    const gate = withSidecarLayer(
      {
        sidecar,
        getMode: () => "auto",
        escalate: async () => ({ behavior: "deny", reason: "x" }),
        toolMeta: () => ({
          isDestructive: (args) => String(args.command).startsWith("rm"),
          isOpenWorld: () => true,
          inputsEquivalent: eq,
        }),
      },
      async () => ({ behavior: "allow" as const }),
    );
    await gate("shell", { command: "rm -rf build" });
    expect(seen[0]).toBe(JSON.stringify({ flags: { destructive: true, openWorld: true }, hasEq: true }));
    await gate("shell", { command: "ls" });
    expect(seen[1]).toBe(JSON.stringify({ flags: { destructive: false, openWorld: true }, hasEq: true }));
  });

  it("no toolMeta → the classifier runs flagless and the cache stays byte-keyed", async () => {
    const replies = ['{"risk":"low","reason":"fine"}'];
    let replyIdx = 0;
    const model = fakeModel(() => ({ role: "assistant", content: replies[replyIdx++ % replies.length] ?? "" }) as AssistantMessage);
    const sidecar = createSidecar({ model });
    const gate = withSidecarLayer(
      { sidecar, getMode: () => "auto", escalate: async () => ({ behavior: "deny", reason: "x" }) },
      async () => ({ behavior: "allow" as const }),
    );
    await gate("write_file", { path: "a", content: "x" });
    const sent = model.inputs[0]!.messages[0] as { content: string };
    expect(sent.content).not.toContain("tool_flags");
  });
});

// ---------------------------------------------------------------------------
// ω99-23 — T1: the session task tool's honest annotations; T2: the
// child_gated dispatch-semantics flag; T3: classifier prompt calibration.
// Reverse pins: the new signals make the verdict INPUT more truthful, never
// the verdict PATH looser (deny/breaker/escalation byte-identical).
// ---------------------------------------------------------------------------

/** The REAL session-registered task tool (createAgentsTaskTool — the one
 *  tools.ts registers; core's createTaskTool is not in cli sessions),
 *  wired through the real late-bound resolver exactly as repl.ts and
 *  session-engine.ts wire it. */
function taskHarness(verdicts: readonly string[] = ['{"risk":"low","reason":"fine"}']) {
  let replyIdx = 0;
  const model = fakeModel(() => ({ role: "assistant", content: verdicts[replyIdx++ % verdicts.length] ?? "" }) as AssistantMessage);
  const sidecar = createSidecar({ model });
  const seen: unknown[] = [];
  const origCheck = sidecar.check.bind(sidecar);
  sidecar.check = (tool, args, opts) => {
    seen.push(opts);
    return origCheck(tool, args, opts);
  };
  const task = createAgentsTaskTool({
    model,
    allTools: [],
    registry: createSessionRegistry(),
    workspaceRoot: "/",
    runId: "omega99-23-sidecar-test",
  });
  const gate = withSidecarLayer(
    {
      sidecar,
      getMode: () => "auto",
      escalate: async () => ({ behavior: "deny", reason: "escalated" }),
      toolMeta: toolMetaResolverFor(() => [task]),
    },
    async () => ({ behavior: "allow" as const }),
  );
  return { model, sidecar, gate, seen, task };
}

describe("ω99-23 T1: the session task tool resolves to honest tool_flags", () => {
  it("task carries destructive:false + open_world:true — not the fail-closed defaults", async () => {
    const h = taskHarness();
    const d = await h.gate("task", { description: "fan out", prompt: "fix the failing suites across the repo" });
    expect(d).toEqual({ behavior: "allow" }); // scripted low verdict
    expect(h.seen[0]).toMatchObject({ flags: { destructive: false, openWorld: true } });
    // …and the serialized classifier input carries them (snake_case field).
    const sent = h.model.inputs[0]!.messages[0] as { content: string };
    expect(sent.content).toContain('"tool_flags":{"destructive":false,"open_world":true}');
  });

  it("a fan-out-describing prompt still resolves destructive:false (the described work is the children's, classified per child call)", async () => {
    const h = taskHarness();
    await h.gate("task", {
      description: "rewrite the whole module tree",
      prompt: "Edit every file under src/, delete the dead modules, and force-push the branch",
    });
    expect(h.seen[0]).toMatchObject({ flags: { destructive: false, openWorld: true } });
  });
});

describe("ω99-23 T2: child_gated dispatch semantics (SidecarToolMeta → check opts → classifier input)", () => {
  const TASK_ARGS = { description: "fix suites", prompt: "run the tests and fix what fails" };

  it("childGated:true adds the fixed child_gated field (canonical key order, beside tool_flags)", async () => {
    const model = fakeModel(() => low);
    const sidecar = createSidecar({ model });
    await sidecar.check("task", TASK_ARGS, { flags: { destructive: false, openWorld: true }, childGated: true });
    const sent = model.inputs[0]!.messages[0] as { content: string };
    expect(sent.content).toBe(
      '{"arguments":{"description":"fix suites","prompt":"run the tests and fix what fails"},"child_gated":true,"tool":"task","tool_flags":{"destructive":false,"open_world":true}}',
    );
  });

  it("childGated absent or false → NO child_gated field (the input keeps its exact pre-ω99-23 shape)", async () => {
    const model = fakeModel(() => low);
    const sidecar = createSidecar({ model });
    await sidecar.check("task", TASK_ARGS, { flags: { destructive: false, openWorld: true } });
    await sidecar.check("task", { ...TASK_ARGS, role: "x" }, { flags: { destructive: false, openWorld: true }, childGated: false });
    expect((model.inputs[0]!.messages[0] as { content: string }).content).toBe(
      '{"arguments":{"description":"fix suites","prompt":"run the tests and fix what fails"},"tool":"task","tool_flags":{"destructive":false,"open_world":true}}',
    );
    for (const input of model.inputs) {
      expect((input.messages[0] as { content: string }).content).not.toContain("child_gated");
    }
  });

  it("withSidecarLayer resolves meta.isChildGated into check opts; no annotation stays conservative", async () => {
    const model = fakeModel(() => low);
    const sidecar = createSidecar({ model });
    const seen: unknown[] = [];
    const origCheck = sidecar.check.bind(sidecar);
    sidecar.check = (tool, args, opts) => {
      seen.push(opts);
      return origCheck(tool, args, opts);
    };
    const gate = withSidecarLayer(
      {
        sidecar,
        getMode: () => "auto",
        escalate: async () => ({ behavior: "deny", reason: "x" }),
        toolMeta: (name) =>
          name === "dispatch_a"
            ? { isDestructive: () => false, isOpenWorld: () => true, isChildGated: () => true }
            : name === "dispatch_b"
              ? { isDestructive: () => false, isOpenWorld: () => true } // annotated, but not child-gated
              : undefined,
      },
      async () => ({ behavior: "allow" as const }),
    );
    await gate("dispatch_a", {});
    await gate("dispatch_b", {});
    expect(seen[0]).toMatchObject({ childGated: true });
    expect(seen[1]).not.toMatchObject({ childGated: true });
    // …and the second call's classifier input carries no child_gated field.
    expect((model.inputs[1]!.messages[0] as { content: string }).content).not.toContain("child_gated");
  });

  it("no toolMeta at all → the classifier input is BYTE-identical to the pre-ω99-23 shape", async () => {
    const model = fakeModel(() => low);
    const sidecar = createSidecar({ model });
    const gate = withSidecarLayer(
      { sidecar, getMode: () => "auto", escalate: async () => ({ behavior: "deny", reason: "x" }) },
      async () => ({ behavior: "allow" as const }),
    );
    await gate("shell", { command: "echo x" });
    const sent = model.inputs[0]!.messages[0] as { content: string };
    expect(sent.content).toBe('{"arguments":{"command":"echo x"},"tool":"shell"}');
  });

  it("the session task tool carries child_gated:true end-to-end (annotation → resolver → check opts → input)", async () => {
    const h = taskHarness();
    await h.gate("task", { description: "d", prompt: "p" });
    expect(h.seen[0]).toMatchObject({ childGated: true, flags: { destructive: false, openWorld: true } });
    const sent = h.model.inputs[0]!.messages[0] as { content: string };
    expect(sent.content).toContain('"child_gated":true');
  });

  // --- reverse pins (§3.3): a truer INPUT never softens the verdict PATH ---

  it("REVERSE PIN: child_gated:true + a high verdict follows the SAME #452 auto-托付 allow — the signal never loosens the path", async () => {
    const h = taskHarness(['{"risk":"high","reason":"dispatch to a risky role"}']);
    const d = await h.gate("task", { description: "d", prompt: "p" });
    expect(d).toEqual({ behavior: "allow" }); // high → 托付放行（回执审计），escalate 永不进局
    const sent = h.model.inputs[0]!.messages[0] as { content: string };
    expect(sent.content).toContain('"child_gated":true'); // the signal arrived — and changed nothing
  });

  it("REVERSE PIN: child_gated calls feed the breaker exactly like any other call", async () => {
    const h = taskHarness(['{"risk":"high","reason":"r"}']);
    for (const c of ["a", "b", "c"]) await h.gate("task", { description: `d-${c}`, prompt: "p" });
    expect(h.sidecar.breakerOpen()).toBe(true);
  });

  it("REVERSE PIN: a static deny passes through untouched even with a child-gated toolMeta", async () => {
    const model = fakeModel(() => low);
    const sidecar = createSidecar({ model });
    const gate = withSidecarLayer(
      {
        sidecar,
        getMode: () => "auto",
        escalate: async () => ({ behavior: "deny", reason: "escalated" }),
        toolMeta: () => ({ isDestructive: () => false, isOpenWorld: () => true, isChildGated: () => true }),
      },
      async () => ({ behavior: "deny", reason: 'settings deny rule "task:*"' }),
    );
    const d = await gate("task", { description: "d", prompt: "p" });
    expect(d).toEqual({ behavior: "deny", reason: 'settings deny rule "task:*"' });
    expect(sidecar.checks()).toBe(0);
  });
});

describe("ω99-23 T3: classifier prompt calibration (three additions, still a constant)", () => {
  it("a — child_gated: judge this call's own effect, never double-count described downstream work", () => {
    expect(SIDECAR_CLASSIFIER_PROMPT).toContain('"child_gated": true');
    expect(SIDECAR_CLASSIFIER_PROMPT).toContain("classified separately at each child call");
    expect(SIDECAR_CLASSIFIER_PROMPT).toContain("do not double-count the described work");
  });
  it("b — harness-verified bounded flags make future-work text plan data, not this call's action", () => {
    expect(SIDECAR_CLASSIFIER_PROMPT).toContain('"destructive": false and "open_world": false');
    expect(SIDECAR_CLASSIFIER_PROMPT).toContain("this call's own effect is bounded");
    expect(SIDECAR_CLASSIFIER_PROMPT).toContain("plan data, not an action this call takes");
  });
  it("c — the bulk dimension is mutation-only: read-only operations are never bulk changes", () => {
    expect(SIDECAR_CLASSIFIER_PROMPT).toContain("concerns mutation only");
    expect(SIDECAR_CLASSIFIER_PROMPT).toContain("never bulk changes");
  });
  it("the prompt stays a fixed constant — no interpolation surface", () => {
    expect(SIDECAR_CLASSIFIER_PROMPT).not.toContain("${");
    expect(SIDECAR_CLASSIFIER_PROMPT).not.toContain("`");
    // The verdict contract is untouched by the calibration.
    expect(SIDECAR_CLASSIFIER_PROMPT).toContain('{"risk":"low"|"high","reason":"<one short sentence>"}');
    expect(SIDECAR_CLASSIFIER_PROMPT).toContain('When in doubt, answer "high".');
  });
});

// ---------------------------------------------------------------------------
// ω99-27 T1 — the closed-world read-only two-flag rule (breaker de-blinding).
// A gated tool that HONESTLY declares isReadOnly:true + isOpenWorld:false
// (the list_agents shape) never reaches the classifier: the harness already
// knows the call cannot mutate anything worth auditing. Reverse pins: the
// rule never fires on unannotated/open-world/write tools, and static
// deny/ask still short-circuit above it.
// ---------------------------------------------------------------------------

/** ω99-27 layer harness with a stubbable toolMeta resolver. */
function wallHarness(args: {
  verdicts?: readonly string[];
  meta?: (toolName: string) =>
    | { isReadOnly?: (a: Record<string, unknown>) => boolean; isOpenWorld?: (a: Record<string, unknown>) => boolean }
    | undefined;
  /** T2: the operator exemption rules (the seam frontends wire over the
   *  permission settings watcher's sidecarExempt list). */
  exempt?: readonly string[];
}) {
  const replies = args.verdicts ?? ['{"risk":"low","reason":"fine"}'];
  let replyIdx = 0;
  const model = fakeModel(() => ({ role: "assistant", content: replies[replyIdx++ % replies.length] ?? "" }) as AssistantMessage);
  const sidecar = createSidecar({ model });
  const receipts: string[] = [];
  const escalations: SidecarEscalation[] = [];
  const gate = withSidecarLayer(
    {
      sidecar,
      getMode: () => "auto",
      escalate: async (_t, _i, ctx) => {
        escalations.push(ctx);
        return { behavior: "deny", reason: ctx.circuitOpen ? "sidecar circuit-open" : `sidecar: ${ctx.reason ?? ""}` };
      },
      receipt: (l) => void receipts.push(l),
      ...(args.meta !== undefined ? { toolMeta: args.meta } : {}),
      ...(args.exempt !== undefined ? { sidecarExemptRules: () => args.exempt as readonly string[] } : {}),
    },
    async () => ({ behavior: "allow" as const }),
  );
  return { model, sidecar, gate, receipts, escalations };
}

/** The honest list_agents-shaped annotation (peer/tools.ts). */
const READ_ONLY_CLOSED = { isReadOnly: () => true, isOpenWorld: () => false };

describe("ω99-27 T1: closed-world read-only two-flag rule", () => {
  it("declared isReadOnly:true + isOpenWorld:false → allow, zero classifier calls, the receipt — even with the breaker OPEN", async () => {
    const h = wallHarness({ verdicts: ['{"risk":"high","reason":"r"}'], meta: (n) => (n === "list_agents" ? READ_ONLY_CLOSED : undefined) });
    // Force the breaker open: 3 distinct write-class highs.
    for (const c of ["a", "b", "c"]) await h.gate("shell", { command: `rm -rf /${c}` });
    expect(h.sidecar.breakerOpen()).toBe(true);
    const checksAtOpen = h.sidecar.checks();
    const escalationsAtOpen = h.escalations.length;
    const d = await h.gate("list_agents", {});
    expect(d).toEqual({ behavior: "allow" });
    expect(h.sidecar.checks()).toBe(checksAtOpen); // the model was never called
    expect(h.escalations.length).toBe(escalationsAtOpen); // …and nothing escalated
    expect(h.receipts).toContain("🛡 sidecar read-only (declared) — no audit needed");
  });

  it("steady state too: breaker closed, a declared read-only call still skips the classifier", async () => {
    const h = wallHarness({ meta: (n) => (n === "list_agents" ? READ_ONLY_CLOSED : undefined) });
    const d = await h.gate("list_agents", {});
    expect(d).toEqual({ behavior: "allow" });
    expect(h.sidecar.checks()).toBe(0);
    expect(h.model.inputs).toHaveLength(0);
    expect(h.receipts).toContain("🛡 sidecar read-only (declared) — no audit needed");
  });

  it("no declared meta → the breaker still blinds the CLASSIFIER (zero calls) but #452 托付 allows with the trip receipts", async () => {
    const h = wallHarness({ verdicts: ['{"risk":"high","reason":"r"}'], meta: () => undefined });
    for (const c of ["a", "b", "c"]) await h.gate("shell", { command: `rm -rf /${c}` });
    const checksAtOpen = h.sidecar.checks();
    const d = await h.gate("list_agents", {}); // gated, but the resolver knows nothing
    expect(d).toEqual({ behavior: "allow" }); // #452: open breaker = 省一次分类往返，不是升级人工
    expect(h.sidecar.checks()).toBe(checksAtOpen);
    expect(h.receipts.some((r) => r.includes("read-only (declared)"))).toBe(false);
    expect(h.receipts.some((r) => r.includes("连续高风险"))).toBe(true);
    // 0.3.82: counted, not receipted per call (one aggregated receipt at settle).
    expect(h.sidecar.breakerAllows()).toBe(1);
  });

  it("declared isReadOnly:true but isOpenWorld:true (web_fetch shape) → no read-only bypass; breaker-open path still allows (#452)", async () => {
    const h = wallHarness({
      verdicts: ['{"risk":"high","reason":"r"}'],
      meta: (n) => (n === "web_fetch" ? { isReadOnly: () => true, isOpenWorld: () => true } : undefined),
    });
    for (const c of ["a", "b", "c"]) await h.gate("shell", { command: `rm -rf /${c}` });
    const d = await h.gate("web_fetch", { url: "https://example.com" });
    expect(d).toEqual({ behavior: "allow" }); // the two-flag rule never fires (open world) — breaker-open 托付放行
    expect(h.receipts.some((r) => r.includes("read-only (declared)"))).toBe(false);
    expect(h.sidecar.breakerAllows()).toBe(1); // counted, not receipted per call (0.3.82)
  });

  it("fail-closed defaults never match: undeclared isReadOnly (write tool) stays classified", async () => {
    const h = wallHarness({ meta: () => ({ isReadOnly: () => false, isOpenWorld: () => false }) });
    const d = await h.gate("edit", { path: "README.md", old_string: "a", new_string: "b" });
    expect(d).toEqual({ behavior: "allow" }); // scripted low — but it WENT through the classifier
    expect(h.sidecar.checks()).toBe(1);
    expect(h.receipts.some((r) => r.includes("read-only (declared)"))).toBe(false);
  });

  it("a static deny short-circuits ABOVE the two-flag rule (deny is never overridden)", async () => {
    const h = wallHarness({
      meta: () => READ_ONLY_CLOSED,
      verdicts: ['{"risk":"low","reason":"fine"}'],
    });
    const denyGate = withSidecarLayer(
      {
        sidecar: h.sidecar,
        getMode: () => "auto",
        escalate: async () => ({ behavior: "deny", reason: "x" }),
        receipt: () => {},
        toolMeta: () => READ_ONLY_CLOSED,
      },
      async () => ({ behavior: "deny", reason: 'settings deny rule "list_agents"' }),
    );
    const d = await denyGate("list_agents", {});
    expect(d).toEqual({ behavior: "deny", reason: 'settings deny rule "list_agents"' });
    expect(h.sidecar.checks()).toBe(0);
  });

  it("SIDECAR_UNGATED members behave byte-identically: no new receipt, no classification, no meta consult", async () => {
    let metaConsulted = false;
    const h = wallHarness({
      meta: () => {
        metaConsulted = true;
        return READ_ONLY_CLOSED;
      },
    });
    for (const t of ["agent_status", "agent_await", "read_file", "grep"]) {
      const d = await h.gate(t, t === "read_file" || t === "grep" ? { path: "a" } : {});
      expect(d).toEqual({ behavior: "allow" });
    }
    expect(h.sidecar.checks()).toBe(0);
    expect(h.receipts).toEqual([]); // no read-only receipt either — never reached
    expect(metaConsulted).toBe(false); // the ungated set returns before T1
  });
});

// ---------------------------------------------------------------------------
// ω99-27 T2 — the settings sidecarExempt lane: the operator's explicit,
// receipt-leaving, hot-reloading takeover channel past the classifier. Same
// selector grammar as allow (ruleMatches); static deny/ask short-circuit
// ABOVE it; no verdict is produced so no breaker accounting happens.
// ---------------------------------------------------------------------------

describe("ω99-27 T2: settings sidecarExempt lane (operator takeover)", () => {
  const EDIT_ARGS = { path: "README.md", old_string: "@v0.2.0", new_string: "@v0.3.0" };

  it("an exempt rule allows with ZERO classifier calls and a receipt naming the rule", async () => {
    const h = wallHarness({
      verdicts: ['{"risk":"high","reason":"swaps a dependency version — unbounded modification"}'],
      exempt: ["edit:README.md"],
    });
    const d = await h.gate("edit", EDIT_ARGS);
    expect(d).toEqual({ behavior: "allow" });
    expect(h.sidecar.checks()).toBe(0); // the classifier never ran
    expect(h.model.inputs).toHaveLength(0);
    expect(h.receipts).toContain("🛡 sidecar exempt — settings rule «edit:README.md» (operator)");
  });

  it("the campaign wall scenario: breaker OPEN + operator exemption → allow, no restart, no escalation", async () => {
    const h = wallHarness({
      verdicts: ['{"risk":"high","reason":"r"}'],
      exempt: ["edit:README.md"],
    });
    for (const c of ["a", "b", "c"]) await h.gate("shell", { command: `rm -rf /${c}` });
    expect(h.sidecar.breakerOpen()).toBe(true);
    const checksAtOpen = h.sidecar.checks();
    const escalationsAtOpen = h.escalations.length;
    const d = await h.gate("edit", EDIT_ARGS);
    expect(d).toEqual({ behavior: "allow" });
    expect(h.sidecar.checks()).toBe(checksAtOpen); // no verdict → no accounting
    expect(h.escalations.length).toBe(escalationsAtOpen);
    expect(h.sidecar.breakerOpen()).toBe(true); // the lane does not reset the breaker either
  });

  it("the selector grammar mirrors allow: path-prefix, bare tool, and non-matching rule shapes", async () => {
    const h = wallHarness({ verdicts: ['{"risk":"high","reason":"r"}'], exempt: ["edit:docs/"] });
    // prefix hit
    expect(await h.gate("edit", { path: "docs/desktop.md", old_string: "a", new_string: "b" })).toEqual({ behavior: "allow" });
    // non-matching path → falls through to the classifier (scripted high →
    // #452 托付 allow + the sidecar:high receipt)
    const d = await h.gate("edit", EDIT_ARGS);
    expect(d).toEqual({ behavior: "allow" });
    expect(h.sidecar.checks()).toBe(1);
    expect(h.receipts.some((r) => r.includes("sidecar:high"))).toBe(true);
  });

  it("a settings deny rule still denies — lane order pinned through the REAL gate builder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gate-exempt-"));
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      await mkdir(join(dir, ".wudao"), { recursive: true });
      await writeFile(
        join(dir, ".wudao", "settings.json"),
        JSON.stringify({ permissions: { deny: ["edit"], sidecarExempt: ["edit:README.md"] } }),
        "utf8",
      );
      const sidecar = createSidecar({ model: fakeModel(() => low) });
      const gate = createPermissionGate(["wudao", "--auto"], sidecar);
      const d = await gate("edit", EDIT_ARGS);
      expect(d).toEqual({ behavior: "deny", reason: 'settings deny rule "edit"' });
      expect(sidecar.checks()).toBe(0);
    } finally {
      process.chdir(cwd);
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("a settings ask rule passes through BEFORE the lane (exempt never overrides ask)", async () => {
    const h = wallHarness({ exempt: ["edit"] });
    const askGate = withSidecarLayer(
      {
        sidecar: h.sidecar,
        getMode: () => "auto",
        escalate: async () => ({ behavior: "deny", reason: "x" }),
        receipt: (l) => void h.receipts.push(l),
        sidecarExemptRules: () => ["edit"],
      },
      async () => "ask" as const,
    );
    const d = await askGate("edit", EDIT_ARGS);
    expect(d).toBe("ask");
    expect(h.sidecar.checks()).toBe(0);
    expect(h.receipts.some((r) => r.includes("sidecar exempt"))).toBe(false);
  });

  it("an EMPTY exempt list is byte-identical to no lane at all (regression pin)", async () => {
    const run = async (withEmptyLane: boolean) => {
      const h = wallHarness({
        verdicts: ['{"risk":"low","reason":"fine"}', '{"risk":"high","reason":"r"}'],
        ...(withEmptyLane ? { exempt: [] } : {}),
      });
      const d1 = await h.gate("edit", EDIT_ARGS); // low → allow + receipt
      const d2 = await h.gate("shell", { command: "rm -rf /x" }); // high → deny
      return { d1, d2, receipts: h.receipts, checks: h.sidecar.checks(), escalations: h.escalations.length };
    };
    expect(await run(true)).toEqual(await run(false));
  });
});

// ---------------------------------------------------------------------------
// ω99-27 T3 — edit-verdict honesty calibration: three more pure-constant
// sentences (ω99-23 template) teaching the classifier the campaign's
// residual misjudgment classes: bounded single-file edits read as
// "unbounded modification", docs/ + version strings read as risk, and
// read-only grep pipelines read as change. The verdict contract and the
// fail-closed posture ("When in doubt, answer high", edit's
// isDestructive:true) are UNTOUCHED — this calibrates the input facts,
// never the verdict path.
// ---------------------------------------------------------------------------

describe("ω99-27 T3: edit-verdict honesty calibration (three sentences, still a constant)", () => {
  it("a — a bounded single-file replacement is judged by its actual patch radius, never as an unbounded modification", () => {
    expect(SIDECAR_CLASSIFIER_PROMPT).toContain("judged by its actual patch radius");
    expect(SIDECAR_CLASSIFIER_PROMPT).toContain('never as an "unbounded modification"');
    expect(SIDECAR_CLASSIFIER_PROMPT).toContain("editing an existing file is not by itself a risk signal");
    // …and the destructive flag itself records only that disk content changes
    // (edit.ts keeps isDestructive:true — the flag stays fail-closed, the
    // VERDICT stops treating the flag alone as the risk).
    expect(SIDECAR_CLASSIFIER_PROMPT).toContain('the edit tool\'s "destructive" flag records only that disk content changes');
  });
  it("b — docs/ paths and version-string updates are routine maintenance, not a privilege/exfiltration surface", () => {
    expect(SIDECAR_CLASSIFIER_PROMPT).toContain("under docs/");
    expect(SIDECAR_CLASSIFIER_PROMPT).toContain("version-string updates");
    expect(SIDECAR_CLASSIFIER_PROMPT).toContain("not a privilege-escalation or exfiltration surface");
  });
  it("c — a read-only grep pipeline (including --include multi-pattern forms) is inspection, not modification", () => {
    expect(SIDECAR_CLASSIFIER_PROMPT).toContain("read-only grep pipeline");
    expect(SIDECAR_CLASSIFIER_PROMPT).toContain("--include multi-pattern forms");
    expect(SIDECAR_CLASSIFIER_PROMPT).toContain("inspection, not modification");
  });
  it("the calibration stays a fixed constant — no interpolation, verdict contract byte-identical", () => {
    expect(SIDECAR_CLASSIFIER_PROMPT).not.toContain("${");
    expect(SIDECAR_CLASSIFIER_PROMPT).not.toContain("`");
    expect(SIDECAR_CLASSIFIER_PROMPT).toContain('{"risk":"low"|"high","reason":"<one short sentence>"}');
    expect(SIDECAR_CLASSIFIER_PROMPT).toContain('When in doubt, answer "high".');
  });

  it("REVERSE PIN: the real edit tool's flags are UNCHANGED — isDestructive stays true (fail-closed), open_world false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "o27-edit-pin-"));
    try {
      const editTool = createEditTool({ workspaceRoot: dir });
      expect(editTool.isDestructive?.({ path: "README.md", old_string: "a", new_string: "b" })).toBe(true);
      expect(editTool.isOpenWorld?.({ path: "README.md", old_string: "a", new_string: "b" })).toBe(false);
      // …and through the layer the classifier STILL sees destructive:true.
      const h = wallHarness({});
      const gate = withSidecarLayer(
        {
          sidecar: h.sidecar,
          getMode: () => "auto",
          escalate: async () => ({ behavior: "deny", reason: "x" }),
          receipt: () => {},
          toolMeta: toolMetaResolverFor(() => [editTool]),
        },
        async () => ({ behavior: "allow" as const }),
      );
      await gate("edit", { path: "README.md", old_string: "@v0.2.0", new_string: "@v0.3.0" });
      const sent = h.model.inputs[0]!.messages[0] as { content: string };
      expect(sent.content).toContain('"tool_flags":{"destructive":true,"open_world":false}');
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("the campaign's six rejected shapes each assemble a classifier input carrying the calibration segment", async () => {
    const model = fakeModel(() => low);
    const sidecar = createSidecar({ model });
    // The six ω99-26 campaign rejections (log :1607-1613 diff shapes + the
    // multi-pattern grep pipeline), reconstructed verbatim in shape.
    const cases: [string, Record<string, unknown>][] = [
      ["edit", {
        path: "docs/desktop.md",
        old_string: "4. 版本对齐：根 0.2.0 = `apps/desktop/package.json` = `tauri.conf.json` =\n   `Cargo.toml`（改版本时四处同步，或后续引入单一来源）。",
        new_string: "4. 版本对齐：`apps/desktop/package.json` = `tauri.conf.json` = `Cargo.toml`\n   （当前 0.3.42；改版本时三处同步。根 package.json 是私有根号 0.2.7，不参与桌面产物命名）。",
      }],
      ["edit", { path: "README.md", old_string: "@v0.2.0", new_string: "@v0.3.0" }],
      ["edit", { path: "README.md", old_string: "### The three frontends", new_string: "### Frontends" }],
      ["edit", { path: "website/index.html", old_string: "六个前端", new_string: "产品特性（六张特性卡）" }],
      ["edit", {
        path: "README.md",
        old_string: "| /mission <总目标> | start / status / end a **task campaign** — cross-session mission ledger (0.3.41+) |",
        new_string: "| /mission <总目标> | start / status / end a **task campaign** — cross-session mission ledger, each finished task's verification re-run before later tasks complete (slash and ledger since 0.3.41; the desktop app's input box and mission_start since 0.3.42) |",
      }],
      ["shell", {
        command: 'grep -rln "r2.dev\\|pub-e4e7bbe2593c42f580c95fed25a3bd0b\\|R2" . --include="*.sh" --include="*.mjs" --include="*.yml" --include="*.json"',
      }],
    ];
    for (const [tool, args] of cases) {
      await sidecar.check(tool, args, { flags: { destructive: tool === "edit", openWorld: false } });
    }
    expect(model.inputs).toHaveLength(6);
    for (const input of model.inputs) {
      // Every campaign-shaped call meets the calibrated instruction set.
      expect(input.systemPrompt).toContain("judged by its actual patch radius");
      expect(input.systemPrompt).toContain("version-string updates");
      expect(input.systemPrompt).toContain("inspection, not modification");
    }
  });
});

describe("ω99-42: the classifier's effort none is a soft code default (mandatory-endpoint repairable)", () => {
  it("sidecarClassifierConfig marks softReasoningNone — the user's own config is never marked", () => {
    const base: ProviderConfig = {
      apiKey: "k",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen3-max",
      provider: "qwen",
    };
    const classifier = sidecarClassifierConfig(base, DEFAULT_SIDECAR_SETTINGS);
    expect(classifier.reasoningEffort).toBe("none");
    expect(classifier.softReasoningNone).toBe(true);
    expect(classifier.model).toBe(base.model);
    // the session config itself stays untouched (no silent user rewrite)
    expect(base.softReasoningNone).toBeUndefined();
    expect(base.reasoningEffort).toBeUndefined();
  });
});
