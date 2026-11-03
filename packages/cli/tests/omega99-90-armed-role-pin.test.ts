// ω99-90 — armed×role-pin×无-resolver 组合态独立钉（88 走查顾虑⑤）。
// T0 裁决（亲读 base @570959fd，证据见弧报告）：现状=设计——role pin 无
// resolver 时是**声明档**（只进 requested 与 meta），烧成必须经 resolver
// （task-tool.ts:846-850 overrideBurned）；无 resolver 的 armed lane 下子
// ModelClient = 共享 client（ctx.model），其 liveConfig 直达子请求（ω99-86
// 设计核心），收据按 88 语义如实报 requested=pin / effective=live。
// 86 报告 case4 裁决明文：overrideBurned 取直接布尔正是为了让「无 resolver
// 的 pin 降级路径不触发让位」；task-tool:844 的 note 支路（"role pin (…)
// not applied in this context — the child ran on the session model"）是该
// 降级的设计成文。三条 lane 的 requested×effective 真值矩阵：
//
// | lane                              | armed | resolver | requested | effective | child client        | trail(effortSent) |
// |-----------------------------------|-------|----------|-----------|-----------|---------------------|-------------------|
// | case2 un-armed+pin（=agents-task:167 的 spec 面） | no  | no       | pin "high" | boot "low" | shared（boot 基线） | 无键（86 case2 byte-pin 形） |
// | case1 armed+pin 无 resolver（主角）| yes "high" | no  | pin "low" | live "high" | shared（liveConfig 直达） | "high"（不让位） |
// | case3 armed+pin+resolver（=88 case2 补 requested 面） | yes "high" | yes | pin "low" | burned "low" | 独立 child client | "low"（让位） |
//
// case1 与 case2 的差 = armed（effective boot→live）；case1 与 case3 的差 =
// resolver（effective live→burned、trail 让位、client 独立）。组合态恰是
// agents-task:167（un-armed+pin）与 88 case2（armed+resolver）的差集——本弧
// 之前的空格。纯现状钉：base 上即绿，无 RED 相位。
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
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "armed-role-pin-")); });
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
 *  reasoningEffort / effectiveReasoningEffort / model / loopOptions (the
 *  registry-facing receipt, same shape as ω99-86 case4 / ω99-88). */
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
 *  the .wudao/agents/<role>.json face, same as ω99-88 case2). */
async function pinRole(name: string, effort: string): Promise<void> {
  await mkdir(join(root, ".wudao", "agents"), { recursive: true });
  await writeFile(join(root, ".wudao", "agents", `${name}.json`), JSON.stringify({
    description: `ws ${name}`,
    systemPrompt: `WS-${name.toUpperCase()}`,
    toolNames: ["read_file"],
    reasoningEffort: effort,
  }));
}

describe("ω99-90 armed×role-pin×无-resolver：pin 是声明档，烧成必须经 resolver", () => {
  it("case1 组合态主角：armed live high + workspace pin low + 无 resolver → requested=low（声明）/ effective=high（live），共享 client 直达，trail 不让位", async () => {
    await pinRole("auditor", "low");
    const reg = stubRegistry();
    const model = recording([{ role: "assistant", content: "x" }]);
    const tools = buildToolSet({
      workspaceRoot: root,
      model,
      canUseTool: allow,
      contextWindowTokens: 64_000,
      // armed：getter 报 live "high"（driver 每 run 武装的 box 形，86 case1 同源）
      effortLiveBox: { get: () => "high" },
      // 无 resolveModel：embedder/自定义前端态（tools.ts:540 可选项缺省）
      agents: { registry: reg, runId: "test-run" },
    });
    const task = tools.find((t) => t.name === "task")!;
    const out = await task.execute({ description: "job", prompt: "do it", role: "auditor", background: true });
    expect(out.isError).toBeUndefined();
    expect(reg.specs).toHaveLength(1);
    const spec = reg.specs[0]!;
    // 声明档：pin 进 requested（wants → requested 计算序），一字不烧。
    expect(spec.reasoningEffort).toBe("low");
    // live 档：无 resolver ⇒ overrideBurned=false ⇒ effortToSend=liveEffortSent
    // ⇒ receipt.effective="high"（88 语义：effective 跟随子实际跑的 lane）。
    expect(spec.effectiveReasoningEffort).toBe("high");
    // 共享 client 直达（86 设计核心）：childModel = ctx.model 同一对象——
    // 无 resolver 就没有独立子 client，liveConfig 直达子请求。
    expect(spec.model).toBe(model);
    // trail 不让位：overrideBurned 为 false（86 case4 裁决的精确边界——
    // 「无 resolver 的 pin 降级路径不触发让位」），effortSent 记 live "high"。
    expect(spec.loopOptions!.effortSent).toBe("high");
  });

  it("case2 un-armed+pin 对照（agents-task:167 的 spec 面复刻）：builtin pin high + session low + 无 box → requested=high（pin 胜 session）/ effective=low（boot 基线）/ trail 无键", async () => {
    const reg = stubRegistry();
    const model = recording([{ role: "assistant", content: "x" }]);
    const tools = buildToolSet({
      workspaceRoot: root,
      model,
      canUseTool: allow,
      contextWindowTokens: 64_000,
      // 无 effortLiveBox（un-armed）+ 无 resolver —— 167 的语境，断言面换成 spec
      agents: { registry: reg, runId: "test-run", defaultEffort: "low" },
    });
    const task = tools.find((t) => t.name === "task")!;
    const out = await task.execute({ description: "advise", prompt: "weigh options", role: "consultant", background: true });
    expect(out.isError).toBeUndefined();
    const spec = reg.specs[0]!;
    // 167 已钉：consultant 的 role pin high 进 requested（胜 session low）。
    expect(spec.reasoningEffort).toBe("high");
    // 本面补全：effective 回落 boot 基线 "low"（liveEffortSent undefined ⇒ ?? effective）。
    expect(spec.effectiveReasoningEffort).toBe("low");
    // 86 case2 byte-pin 形：无 box ⇒ 无 effortSent 键（trail 字节不变）。
    expect("effortSent" in spec.loopOptions!).toBe(false);
  });

  it("case3 resolver-burned 对照（88 case2 补 requested/model/trail 面）：armed high + pin low + resolver → requested=low / effective=low（烧成）/ 独立 child client / trail 让位", async () => {
    await pinRole("auditor", "low");
    const reg = stubRegistry();
    const model = recording([{ role: "assistant", content: "x" }]);
    const childModel = recording([{ role: "assistant", content: "child on pinned effort" }]);
    const tools = buildToolSet({
      workspaceRoot: root,
      model,
      canUseTool: allow,
      contextWindowTokens: 64_000,
      effortLiveBox: { get: () => "high" },
      agents: {
        registry: reg,
        runId: "test-run",
        resolveModel: (o) => ({ ok: true, model: childModel, effectiveEffort: o.reasoningEffort ?? "off" }),
      },
    });
    const task = tools.find((t) => t.name === "task")!;
    const out = await task.execute({ description: "job", prompt: "do it", role: "auditor", background: true });
    expect(out.isError).toBeUndefined();
    const spec = reg.specs[0]!;
    // 88 case2 已钉 effective 面（burned low 胜 live high）；本面补 requested：
    // 同一个 pin 在 resolver 在场时既进声明档也进烧成档（requested==effective）。
    expect(spec.reasoningEffort).toBe("low");
    expect(spec.effectiveReasoningEffort).toBe("low");
    // 烧成的物理面：resolver 构造了独立 child client（≠ 共享 model）。
    expect(spec.model).toBe(childModel);
    expect(spec.model).not.toBe(model);
    // trail 让位（86 case4）：effortToSend=effortGuard(burned)="low"。
    expect(spec.loopOptions!.effortSent).toBe("low");
  });
});
