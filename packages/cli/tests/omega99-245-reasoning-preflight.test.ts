// ω99-245: #3 — 推理配置正确性弧测试矩阵（brief §五 R2-R5、R7；R1 在
// providers/tests/omega99-245-effort-catalog.test.ts，R6 = o99-53 归因族 solo）。
// 全 mock（scripted model/client），禁真模型调用；夹具只写 tmpdir（★红线）。
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput, Tool } from "@wudao/core";
import type { ProviderConfig } from "@wudao/providers";
import { createDriverSession } from "../src/driver/session-engine.js";
import type { DriverSession } from "../src/driver/session-engine.js";
import { preflightRoleReasoning, formatReasoningHealthLine, effortProbeEnabled } from "../src/driver/reasoning-preflight.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";

const sessions: DriverSession[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  vi.unstubAllEnvs();
});

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const tmpWs = (): string => {
  const ws = mkdtempSync(join(tmpdir(), "o245-"));
  roots.push(ws);
  return ws;
};

const okModel = (): ModelClient => ({
  async generate(): Promise<AssistantMessage> {
    return { role: "assistant", content: "ok", stopReason: "stop" };
  },
});

// ---------------------------------------------------------------------------
// R3 — override 链来源标注（纯函数）：flag/env > 供应商绑定 > 全局默认 > 启动配置。
// ---------------------------------------------------------------------------
describe("preflightRoleReasoning — 有效 effort 的来源链（R3）", () => {
  const deepseek = (effort?: string): { provider: string; model: string; reasoningEffort?: string } => ({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    ...(effort !== undefined ? { reasoningEffort: effort } : {}),
  });
  const preflight = (over: {
    config?: { provider: string; model: string; reasoningEffort?: string };
    env?: Record<string, string>;
    binding?: string | null;
    global?: string;
  }) =>
    preflightRoleReasoning({
      config: over.config ?? deepseek("high"),
      env: over.env ?? {},
      readBinding: () => over.binding,
      readGlobalDefault: () => over.global,
    });

  it("环境变量钉 > 一切：来源标注「环境变量 WUDAO_REASONING_EFFORT」", () => {
    const r = preflight({ env: { WUDAO_REASONING_EFFORT: "high" }, binding: "low", global: "medium" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.roles[0]).toMatchObject({ role: "主对话", effort: "high", sourceLabel: "环境变量 WUDAO_REASONING_EFFORT" });
  });

  it("供应商绑定（无 env 钉）居中：来源标注「供应商绑定（providers.json 的 effort 列）」", () => {
    const r = preflight({ binding: "high", global: "medium" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.roles[0]).toMatchObject({ effort: "high", sourceLabel: "供应商绑定（providers.json 的 effort 列）" });
  });

  it("全局默认兜底：来源标注「设置里的默认推理档」", () => {
    const r = preflight({ global: "high" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.roles[0]).toMatchObject({ effort: "high", sourceLabel: "设置里的默认推理档" });
  });

  it("三层皆缺席但 config 有值（旗标/手建）：来源标注「启动时的模型配置」", () => {
    const r = preflight({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.roles[0]).toMatchObject({ effort: "high", sourceLabel: "启动时的模型配置" });
  });

  it("无任何 effort：主对话 默认，健康摘要静默（无事可报零噪音）", () => {
    const r = preflight({ config: deepseek() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.roles[0]?.effort).toBeUndefined();
    expect(formatReasoningHealthLine(r.roles)).toBeUndefined();
  });

  it("绑定显式 null（不发送）= 无 effort，不误标来源", () => {
    const r = preflight({ config: deepseek(), binding: null, global: "high" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // config.reasoningEffort undefined（null 阻断 global）——降级路径，值以 config 为准
    expect(r.roles[0]?.effort).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// R2 — 预检不过：错误叙事逐字（角色/模型/档位/来源/支持列表/怎么改）。
// ---------------------------------------------------------------------------
describe("preflightRoleReasoning — 不过即报的错误叙事（R2 纯函数面）", () => {
  it("主对话无效档（kimi-k2.7-code × none）：叙事逐字钉形", () => {
    const r = preflightRoleReasoning({
      config: { provider: "kimi", model: "kimi-k2.7-code", reasoningEffort: "none" },
      env: {},
      readBinding: () => undefined,
      readGlobalDefault: () => undefined,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe(
      "启动预检未过：主对话 的推理档「none」不被 kimi/kimi-k2.7-code 支持（配置来源：启动时的模型配置；该模型可用档位：low、medium、high、max）。"
      + "改法：调整启动参数或环境变量里的推理档后重启。",
    );
  });

  it("环境变量来源的修复行指向 WUDAO_REASONING_EFFORT", () => {
    const r = preflightRoleReasoning({
      config: { provider: "kimi", model: "kimi-k2.7-code", reasoningEffort: "none" },
      env: { WUDAO_REASONING_EFFORT: "none" },
      readBinding: () => undefined,
      readGlobalDefault: () => undefined,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("配置来源：环境变量 WUDAO_REASONING_EFFORT");
    expect(r.error).toContain("把 WUDAO_REASONING_EFFORT 换成上面的可用档位");
  });

  it("角色档案无效档（junk 档位）：先于目录查表失败，叙事含角色与档案修复行", () => {
    const r = preflightRoleReasoning({
      config: { provider: "deepseek", model: "deepseek-v4-flash" },
      env: {},
      roster: [{ id: "researcher", reasoningEffort: "turbo" }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe(
      "启动预检未过：子代理[researcher] 的推理档「turbo」不是有效档位（配置来源：角色档案 researcher.json；有效档位：low、medium、high、max、none）。"
      + "改法：把 researcher.json 里的 reasoningEffort 改成可用档位，或删掉该字段让它跟随主对话。",
    );
  });

  it("角色档案换模型继承主档位（无自身档位钉）：对角色模型校验主档位", () => {
    const r = preflightRoleReasoning({
      config: { provider: "kimi", model: "kimi-k3", reasoningEffort: "none" },
      env: {},
      roster: [{ id: "coder", model: "kimi-k2.7-code" }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("子代理[coder] 的推理档「none」不被 kimi/kimi-k2.7-code 支持");
    expect(r.error).toContain("配置来源：跟随主对话");
  });

  it("内置角色档位钉（consultant high）也在校验面（对会话模型）；目录命中则过", () => {
    const r = preflightRoleReasoning({
      config: { provider: "deepseek", model: "deepseek-v4-flash" },
      env: {},
      roster: [{ id: "consultant", reasoningEffort: "high", builtin: true }],
    });
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R2 boot — 不建会话先报（Reasonix 纪律：任何角色不过就不建 session）。
// ---------------------------------------------------------------------------
describe("createDriverSession — 预检不过即拒绝建会话（R2 集成面）", () => {
  it("kimi-k2.7-code × none：拒绝且逐字叙事；盘上无会话文件无租约", async () => {
    const ws = tmpWs();
    const config: ProviderConfig = {
      apiKey: "test-key",
      baseURL: "https://api.moonshot.cn/anthropic",
      model: "kimi-k2.7-code",
      provider: "kimi",
      reasoningEffort: "none",
    };
    const sid = "o245-refused";
    let message = "";
    try {
      const s = await createDriverSession({ config, workspaceRoot: ws, contextWindowTokens: 64_000, modelOverride: okModel(), tools: [], sessionId: sid });
      sessions.push(s);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toBe(
      "启动预检未过：主对话 的推理档「none」不被 kimi/kimi-k2.7-code 支持（配置来源：启动时的模型配置；该模型可用档位：low、medium、high、max）。"
      + "改法：调整启动参数或环境变量里的推理档后重启。",
    );
    // 不建会话先报：无 JSONL、无租约文件。
    expect(existsSync(join(ws, ".wudao", "sessions", `${sid}.jsonl`))).toBe(false);
    expect(existsSync(join(ws, ".wudao", "sessions", ".leases", `${sid}.json`))).toBe(false);
  });

  it("工作区角色档案 junk 档位：同样拒绝建会话", async () => {
    const ws = tmpWs();
    mkdirSync(join(ws, ".wudao", "agents"), { recursive: true });
    writeFileSync(
      join(ws, ".wudao", "agents", "nightwatch.json"),
      JSON.stringify({ description: "night watch", reasoningEffort: "midnight" }),
    );
    let message = "";
    try {
      const s = await createDriverSession({
        config: { apiKey: "k", baseURL: "https://api.deepseek.com", model: "deepseek-v4-flash", provider: "deepseek" },
        workspaceRoot: ws,
        contextWindowTokens: 64_000,
        modelOverride: okModel(),
        tools: [],
        sessionId: "o245-role-refused",
      });
      sessions.push(s);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("子代理[nightwatch] 的推理档「midnight」不是有效档位");
  });

  it("目录命中（deepseek × high）：静默通过、正常建会话", async () => {
    const ws = tmpWs();
    const session = await createDriverSession({
      config: { apiKey: "k", baseURL: "https://api.deepseek.com", model: "deepseek-v4-flash", provider: "deepseek", reasoningEffort: "high" },
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      modelOverride: okModel(),
      tools: [],
      sessionId: "o245-pass",
    });
    sessions.push(session);
    expect(session.driver.getSessionId()).toBe("o245-pass");
  });
});

// ---------------------------------------------------------------------------
// R5 — 健康摘要：回执行逐字（多角色形/未验证形/静默形）；收益向零实现术语。
// ---------------------------------------------------------------------------
describe("会话建立回执的健康摘要行（R5）", () => {
  const healthLineOf = (history: readonly { kind: string; text?: string }[]): string | undefined =>
    history.find((h) => h.kind === "notice" && (h.text ?? "").startsWith("推理配置："))?.text;

  it("主对话显式档 → 多角色形逐字（小精灵同主对话、子代理继承）", async () => {
    const ws = tmpWs();
    const session = await createDriverSession({
      config: { apiKey: "k", baseURL: "https://api.deepseek.com", model: "deepseek-v4-flash", provider: "deepseek", reasoningEffort: "high" },
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      modelOverride: okModel(),
      tools: [],
      sessionId: "o245-health-a",
    });
    sessions.push(session);
    expect(healthLineOf(session.driver.getHistory() as { kind: string; text?: string }[])).toBe(
      "推理配置：主对话 high · 小精灵 同主对话 · 子代理 high",
    );
  });

  it("未知模型降级未验证形逐字（目录查不到——不编造）", async () => {
    const ws = tmpWs();
    const session = await createDriverSession({
      config: { apiKey: "k", baseURL: "https://api.deepseek.com", model: "brand-new-model", reasoningEffort: "low" },
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      modelOverride: okModel(),
      tools: [],
      sessionId: "o245-health-b",
    });
    sessions.push(session);
    expect(healthLineOf(session.driver.getHistory() as { kind: string; text?: string }[])).toBe(
      "推理配置：主对话 low（未验证） · 小精灵 同主对话（未验证） · 子代理 low（未验证）",
    );
  });

  it("工作区角色档案档位钉 → 追加角色段；收益向（grep 不到实现术语）", async () => {
    const ws = tmpWs();
    mkdirSync(join(ws, ".wudao", "agents"), { recursive: true });
    writeFileSync(
      join(ws, ".wudao", "agents", "researcher.json"),
      JSON.stringify({ description: "research", reasoningEffort: "medium" }),
    );
    const session = await createDriverSession({
      config: { apiKey: "k", baseURL: "https://api.deepseek.com", model: "deepseek-v4-flash", provider: "deepseek" },
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      modelOverride: okModel(),
      tools: [],
      sessionId: "o245-health-c",
    });
    sessions.push(session);
    const line = healthLineOf(session.driver.getHistory() as { kind: string; text?: string }[]);
    expect(line).toBe("推理配置：主对话 默认 · 小精灵 默认 · 子代理 默认 · researcher medium");
    // 收益向门：实现术语零出现。
    expect(line ?? "").not.toMatch(/reasoning_effort|ModelInput|registry|catalog|providers\.json|provider\b/i);
  });

  it("零配置零噪音：无显式档位、无角色钉、无未验证 → 无健康行", async () => {
    const ws = tmpWs();
    const session = await createDriverSession({
      config: { apiKey: "k", baseURL: "https://api.deepseek.com", model: "deepseek-v4-flash", provider: "deepseek" },
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      modelOverride: okModel(),
      tools: [],
      sessionId: "o245-health-d",
    });
    sessions.push(session);
    expect(healthLineOf(session.driver.getHistory() as { kind: string; text?: string }[])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// R4 — effort 窗口 pin 四转移（codex reasoning_effort.rs 范式；压缩不吞用户意图）。
// ①变更=轮界事件（next-turn-only 已有：运行中 /effort 只停泊 pendingModelApply）；
// ②采样建 pin=轮起快照（run 内 modelLive 不变，采样与压缩共用——ω99-53 的
// effortSent 桩是采样档位的可观测面）；③压缩只读快照绝不写状态（摘要请求携带
// 旧档；失败走静态回退 pin 仍存活）；④收束落地后下一 run 重建基线。
// 体量设计：tier-2 走 LLM 需越过 immediate 阈（0.8×600+8192 band ≈ 8672）且
// span 叙事超 digest 阈（digest 只数 user/assistant 文本）——故大块文本走
// 转向道（steering lane，append-only）注入 user 消息，keepRecent 0 让它进 span；
// 工具结果保持极小（tier-0/1 无事可做），压缩在停泊之后的轮首触发。
// ---------------------------------------------------------------------------
describe("effort 窗口 pin 四转移（R4，driver 级全 mock）", () => {
  const BIG = "The parser rewrite touched the token budget planner, the retry ladder, and the accounting receipts, and the usage receipts now carry the answering model identity. ".repeat(64); // ≈7.7k chars/token×… 见下：需 ≈40k chars
  const STEER_TEXT = "背景补充（转向注入）：".concat(BIG).repeat(5); // ≈ 40k chars ≈ 10k tokens > 8672
  type Rec = { effort?: string; src?: string };

  function makeRig() {
    const recs: Rec[] = [];
    const state = { summarizerFails: false };
    let releaseTool: (() => void) | undefined;
    const toolGate = new Promise<void>((r) => { releaseTool = r; });
    let mainCalls = 0;
    let toolRuns = 0;
    const model: ModelClient = {
      async generate(input: ModelInput): Promise<AssistantMessage> {
        recs.push({ effort: input.reasoningEffort, src: input.querySource });
        if (input.querySource === "summarizer") {
          if (state.summarizerFails) throw new Error("provider down");
          return { role: "assistant", content: "summary of the span", stopReason: "stop" };
        }
        mainCalls += 1;
        if (mainCalls <= 2) {
          return {
            role: "assistant",
            content: `leg ${mainCalls} of the parser audit`,
            stopReason: "tool_use",
            toolCalls: [{ id: `t${mainCalls}`, name: "slow_tool", arguments: {} }],
          };
        }
        return { role: "assistant", content: "done", stopReason: "stop" };
      },
    };
    const slowTool: Tool = {
      name: "slow_tool",
      description: "holds until released",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => {
        toolRuns += 1;
        if (toolRuns === 1) await toolGate; // only the FIRST tool phase gates the park
        return { content: "ok" };
      },
    };
    const driver = createAgentDriver({
      model,
      tools: [slowTool],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      sessionMeta: { effort: "low" },
      onPermissionAsk: async () => ({ kind: "allow" as const }),
      compaction: { keepRecent: 0, contextWindowTokens: 600 },
    });
    return { driver, recs, state, release: () => releaseTool?.() };
  }

  const summarizers = (recs: readonly Rec[]): Rec[] => recs.filter((r) => r.src === "summarizer");
  const finalEfforts = (d: ReturnType<typeof createAgentDriver>): (string | undefined)[] =>
    d.state.messages.filter((m) => m.role === "assistant").map((m) => (m as { effort?: string }).effort);

  async function driveRunWithPark(rig: ReturnType<typeof makeRig>): Promise<void> {
    expect(rig.driver.submit("go")).toBe("started");
    await until(() => rig.driver.getStatus().live.busyTools.length > 0, "tool phase 1");
    // ① 变更=轮界事件：运行中 /effort 只停泊，不落 modelLive。
    expect(rig.driver.submit("/effort high")).toBe("notice");
    // The fat steer rides the steering lane (append-only): it lands before the
    // next model call and drives the occupancy over the immediate threshold.
    expect(rig.driver.submit(STEER_TEXT)).toBe("steered");
    rig.release();
    await until(() => rig.driver.isIdle(), "run 1 settled");
  }

  it("①②③④ 成功路径：停泊后触发的压缩摘要用旧档（low），本 run 采样不漂移，收束后下一 run 用 high", async () => {
    const rig = makeRig();
    await driveRunWithPark(rig);
    // ③ 压缩在停泊之后触发，摘要请求携带轮起快照 low（不是停泊中的 high）。
    expect(summarizers(rig.recs).length).toBeGreaterThanOrEqual(1);
    for (const s of summarizers(rig.recs)) expect(s.effort).toBe("low");
    // ② 采样 pin：run 1 的最终 assistant 桩（effortSent）= low。
    expect(finalEfforts(rig.driver).at(-1)).toBe("low");
    // ④ 收束落地，下一 run 采样重建基线 high。
    expect(rig.driver.submit("next")).toBe("started");
    await until(() => rig.driver.isIdle(), "run 2 settled");
    expect(finalEfforts(rig.driver).at(-1)).toBe("high");
  });

  it("③失败路径：摘要调用失败走静态回退——pin 存活、运行中不漂移、轮界照常落地", async () => {
    const rig = makeRig();
    rig.state.summarizerFails = true;
    await driveRunWithPark(rig);
    // 压缩失败确实发生（静态回退落地）且失败没有改写 pin：本 run 采样仍 low。
    expect(summarizers(rig.recs).length).toBeGreaterThanOrEqual(1);
    expect(rig.driver.state.messages.some((m) => m.role === "user" && m.content.includes("Static fallback summary"))).toBe(true);
    expect(finalEfforts(rig.driver).at(-1)).toBe("low");
    // ④ 失败不清除停泊：轮界落地，下一 run high。
    expect(rig.driver.submit("next")).toBe("started");
    await until(() => rig.driver.isIdle(), "run 2 settled");
    expect(finalEfforts(rig.driver).at(-1)).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// R7 — 首 token 轻量能力探测（面三）：默认关；开=一次极小请求；失败降级不阻塞。
// ---------------------------------------------------------------------------
describe("首 token 能力探测（R7，全 mock）", () => {
  it("effortProbeEnabled 门：默认关；1/true 开", () => {
    expect(effortProbeEnabled({})).toBe(false);
    expect(effortProbeEnabled({ WUDAO_EFFORT_PROBE: "0" })).toBe(false);
    expect(effortProbeEnabled({ WUDAO_EFFORT_PROBE: "1" })).toBe(true);
    expect(effortProbeEnabled({ WUDAO_EFFORT_PROBE: "true" })).toBe(true);
  });

  it("默认关：零探测调用（boot 时间预算不破）", async () => {
    const ws = tmpWs();
    const probeCalls: ModelInput[] = [];
    const model: ModelClient = {
      async generate(input: ModelInput): Promise<AssistantMessage> {
        if (input.querySource === "effort-probe") probeCalls.push(input);
        return { role: "assistant", content: "ok", stopReason: "stop" };
      },
    };
    const session = await createDriverSession({
      config: { apiKey: "k", baseURL: "https://api.deepseek.com", model: "deepseek-v4-flash", provider: "deepseek", reasoningEffort: "high" },
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      modelOverride: model,
      tools: [],
      sessionId: "o245-probe-off",
    });
    sessions.push(session);
    expect(probeCalls).toHaveLength(0);
    const line = (session.driver.getHistory() as { kind: string; text?: string }[]).find((h) => h.kind === "notice" && (h.text ?? "").startsWith("推理配置："))?.text;
    expect(line).toBe("推理配置：主对话 high · 小精灵 同主对话 · 子代理 high");
  });

  it("开+命中：一次极小请求（querySource=effort-probe、携带主档位），摘要标「已验证」", async () => {
    vi.stubEnv("WUDAO_EFFORT_PROBE", "1");
    const ws = tmpWs();
    const probeCalls: ModelInput[] = [];
    const model: ModelClient = {
      async generate(input: ModelInput): Promise<AssistantMessage> {
        if (input.querySource === "effort-probe") probeCalls.push(input);
        return { role: "assistant", content: "ok", stopReason: "stop" };
      },
    };
    const session = await createDriverSession({
      config: { apiKey: "k", baseURL: "https://api.deepseek.com", model: "deepseek-v4-flash", provider: "deepseek", reasoningEffort: "high" },
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      modelOverride: model,
      tools: [],
      sessionId: "o245-probe-hit",
    });
    sessions.push(session);
    expect(probeCalls).toHaveLength(1);
    expect(probeCalls[0]?.reasoningEffort).toBe("high");
    expect(probeCalls[0]?.maxTokens).toBeLessThanOrEqual(16);
    const line = (session.driver.getHistory() as { kind: string; text?: string }[]).find((h) => h.kind === "notice" && (h.text ?? "").startsWith("推理配置："))?.text;
    expect(line).toBe("推理配置：主对话 high（已验证） · 小精灵 同主对话（已验证） · 子代理 high（已验证）");
  });

  it("开+失败：降级「未验证」绝不阻塞会话", async () => {
    vi.stubEnv("WUDAO_EFFORT_PROBE", "1");
    const ws = tmpWs();
    const model: ModelClient = {
      async generate(input: ModelInput): Promise<AssistantMessage> {
        if (input.querySource === "effort-probe") throw new Error("400 invalid reasoning_effort");
        return { role: "assistant", content: "ok", stopReason: "stop" };
      },
    };
    const session = await createDriverSession({
      config: { apiKey: "k", baseURL: "https://api.deepseek.com", model: "deepseek-v4-flash", provider: "deepseek", reasoningEffort: "max" },
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      modelOverride: model,
      tools: [],
      sessionId: "o245-probe-fail",
    });
    sessions.push(session);
    const line = (session.driver.getHistory() as { kind: string; text?: string }[]).find((h) => h.kind === "notice" && (h.text ?? "").startsWith("推理配置："))?.text;
    expect(line).toBe("推理配置：主对话 max（未验证） · 小精灵 同主对话（未验证） · 子代理 max（未验证）");
  });

  it("无档位不探测（无 effort 事实可验证，省一次请求）", async () => {
    vi.stubEnv("WUDAO_EFFORT_PROBE", "1");
    const ws = tmpWs();
    const probeCalls: ModelInput[] = [];
    const model: ModelClient = {
      async generate(input: ModelInput): Promise<AssistantMessage> {
        if (input.querySource === "effort-probe") probeCalls.push(input);
        return { role: "assistant", content: "ok", stopReason: "stop" };
      },
    };
    const session = await createDriverSession({
      config: { apiKey: "k", baseURL: "https://api.deepseek.com", model: "deepseek-v4-flash", provider: "deepseek" },
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      modelOverride: model,
      tools: [],
      sessionId: "o245-probe-noeffort",
    });
    sessions.push(session);
    expect(probeCalls).toHaveLength(0);
  });
});
