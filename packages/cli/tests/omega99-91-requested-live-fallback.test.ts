// ω99-91 — 收据 requested fallback live 化（88 姊妹深度，queue 109 row 2）。
// 契约注释「requested = caller > role pin > session default」里的 session
// default 语义 post-86 已移动：armed 会话的实际默认 = live 档（liveConfig 武装
// 后直达子请求），而收据第三档 fallback 仍读 boot 静态 ctx.defaultEffort ——
// armed-no-ask lane（父 run 中派 Task、无人显式要档、role 不 pin）下收据报
// requested=off（boot），与同一 spawn 的 effective（88 已收口为 live 档）自相
// 矛盾。本弧只改第三档：caller/role pin 声明 > armed live 会话档 > boot 基线
// （liveEffortSent 已 guard：un-armed/armed-unset/"off" ⇒ undefined ⇒ 字节级
// 回落 boot）。声明档语义保持（90 裁决）：pin 无 resolver 仍只进声明、不烧成
// —— wants 计算序不动，effective 一行不动（88 资产）。期望值依据 = 90 测试
// 头表三 lane 真值矩阵；本文件四 case 的 lane 标注：
//   case1 armed-no-ask（主角，RED on base：boot off → live high）
//   case2 un-armed 字节钉（liveEffortSent undefined ⇒ boot，字节不变）
//   case3 pin-wins 字节钉（90 case1 requested 面复刻，wants 胜 live）
//   case4 armed-unset 回落钉（getter undefined ⇒ guard ⇒ boot）
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient, ModelInput, AssistantMessage } from "@wudao-org/core";
import type { AgentRegistry, AgentSpawnSpec } from "@wudao-org/core";
import { buildToolSet } from "../src/tools.js";

const allow = async () => ({ kind: "allow" as const });
type EffortLiveBox = { get?: () => string | undefined };

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "requested-live-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });

function recording(responses: readonly AssistantMessage[]): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let call = 0;
  const model: ModelClient & { inputs: ModelInput[] } = {
    inputs,
    async generate(input: ModelInput) {
      inputs.push({ ...input, messages: [...input.messages] });
      const r = responses[call];
      call += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
  return model;
}

/** Records every background spawn's spec verbatim — the assertion face for
 *  spec.reasoningEffort (the registry-facing requested, same shape as ω99-90). */
function stubRegistry(): AgentRegistry & { specs: AgentSpawnSpec[] } {
  const specs: AgentSpawnSpec[] = [];
  const stub: unknown = {
    specs,
    spawn: (spec: AgentSpawnSpec) => {
      specs.push(spec);
      return { id: "bg-1", done: Promise.resolve({ ok: true, report: "stub", turns: 0 }), warnings: [] };
    },
    awaitAgents: async () => [],
    status: () => [],
    cancel: () => false,
    abortAll: () => {},
    steer: () => {},
  };
  return stub as AgentRegistry & { specs: AgentSpawnSpec[] };
}

/** A workspace role profile with a reasoningEffort pin (shadows builtins —
 *  the .wudao/agents/<role>.json face, same as ω99-90 case1). */
async function pinRole(name: string, effort: string): Promise<void> {
  await mkdir(join(root, ".wudao", "agents"), { recursive: true });
  await writeFile(join(root, ".wudao", "agents", `${name}.json`), JSON.stringify({
    description: `ws ${name}`,
    systemPrompt: `WS-${name.toUpperCase()}`,
    toolNames: ["read_file"],
    reasoningEffort: effort,
  }));
}

describe("ω99-91 requested fallback reads the armed live session level (declaration tiers intact)", () => {
  it("case1 armed-no-ask 主角：armed live high + 无 pin/caller/resolver → requested=high（会话默认=live 档；base 报 boot off）", async () => {
    const reg = stubRegistry();
    const model = recording([{ role: "assistant", content: "x" }]);
    const tools = buildToolSet({
      workspaceRoot: root,
      model,
      canUseTool: allow,
      contextWindowTokens: 64_000,
      // armed：getter 报 live "high"（driver 每 run 武装的 box 形，86/88/90 同源）
      effortLiveBox: { get: () => "high" },
      // 无 resolveModel、无 defaultEffort：boot 基线 = "off"（88 case1 语境）
      agents: { registry: reg, runId: "test-run" },
    });
    const task = tools.find((t) => t.name === "task")!;
    // 默认 role（builtin general-purpose 无 effort pin）+ 无 caller 档 ——
    // requested 的三档全部落到第三档 fallback。
    const out = await task.execute({ description: "job", prompt: "do it", background: true });
    expect(out.isError).toBeUndefined();
    expect(reg.specs).toHaveLength(1);
    const spec = reg.specs[0]!;
    // 主断言（RED on base）：armed 会话的实际默认 = live "high"，第三档 fallback
    // 读 live 档而非 boot 静态（base 上 ctx.defaultEffort ?? "off" 报 "off"）。
    expect(spec.reasoningEffort).toBe("high");
    // 同一 spawn 的 88 face（base 即绿）：effective 已是 live "high" —— 收据的
    // requested 与 effective 不再自相矛盾（三面一致：spec=收据=meta 同值）。
    expect(spec.effectiveReasoningEffort).toBe("high");
  });

  it("case2 un-armed 字节钉：裸 buildToolSet（无 box）+ defaultEffort low → requested=low（liveEffortSent undefined ⇒ 回落 boot，字节不变）", async () => {
    const reg = stubRegistry();
    const model = recording([{ role: "assistant", content: "x" }]);
    const tools = buildToolSet({
      workspaceRoot: root,
      model,
      canUseTool: allow,
      contextWindowTokens: 64_000,
      // 无 effortLiveBox（un-armed）—— 88 case3 的 requested 面独立钉
      agents: { registry: reg, runId: "test-run", defaultEffort: "low" },
    });
    const task = tools.find((t) => t.name === "task")!;
    const out = await task.execute({ description: "job", prompt: "do it", background: true });
    expect(out.isError).toBeUndefined();
    expect(reg.specs[0]!.reasoningEffort).toBe("low");
  });

  it("case3 pin-wins 字节钉：armed live high + workspace pin low + 无 resolver → requested=low（声明档语义保持，wants 胜 live —— 90 case1 requested 面复刻）", async () => {
    await pinRole("auditor", "low");
    const reg = stubRegistry();
    const model = recording([{ role: "assistant", content: "x" }]);
    const tools = buildToolSet({
      workspaceRoot: root,
      model,
      canUseTool: allow,
      contextWindowTokens: 64_000,
      effortLiveBox: { get: () => "high" },
      agents: { registry: reg, runId: "test-run" },
    });
    const task = tools.find((t) => t.name === "task")!;
    const out = await task.execute({ description: "job", prompt: "do it", role: "auditor", background: true });
    expect(out.isError).toBeUndefined();
    const spec = reg.specs[0]!;
    // 90 裁决不动摇：pin 是声明档，进 requested 一字不烧（无 resolver 不烧成）；
    // live "high" 只进 effective 面（90 case1 已钉），requested 面本弧字节不变。
    expect(spec.reasoningEffort).toBe("low");
    expect(spec.effectiveReasoningEffort).toBe("high");
  });

  it("case4 armed-unset 回落钉：armed 且 getter undefined + defaultEffort low → requested=low（guard ⇒ undefined ⇒ boot 基线）", async () => {
    const reg = stubRegistry();
    const model = recording([{ role: "assistant", content: "x" }]);
    const tools = buildToolSet({
      workspaceRoot: root,
      model,
      canUseTool: allow,
      contextWindowTokens: 64_000,
      // armed 但会话从未设档（getter undefined）—— 88 case4 的 requested 面
      effortLiveBox: { get: () => undefined },
      agents: { registry: reg, runId: "test-run", defaultEffort: "low" },
    });
    const task = tools.find((t) => t.name === "task")!;
    const out = await task.execute({ description: "job", prompt: "do it", background: true });
    expect(out.isError).toBeUndefined();
    expect(reg.specs[0]!.reasoningEffort).toBe("low");
  });
});
