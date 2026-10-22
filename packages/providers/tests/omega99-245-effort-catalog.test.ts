// ω99-245: #1 — R1 能力目录：每模型族 → 支持的 effort 档集合 + 是否 reasoning
// 模型（reasoning_content 有无）。纯查表；覆盖列（registry efforts）整卡替换；
// 未知 provider/模型不炸（undefined = 降级未验证，绝不卡死）。
import { describe, expect, it } from "vitest";
import { effectiveProfiles } from "../src/registry.js";
import { supportedEfforts, reasoningContentStreams, MODEL_EFFORT_PINS } from "../src/effort-catalog.js";
import type { ReasoningEffort } from "../src/config.js";

const ALL: readonly ReasoningEffort[] = ["low", "medium", "high", "max", "none"];

describe("supportedEfforts — 查表（R1 在/不在）", () => {
  it("deepseek 家族全五档（deepseek format 不折叠任何档）", () => {
    expect(supportedEfforts("deepseek", "deepseek-v4-flash")).toEqual(ALL);
    expect(supportedEfforts("deepseek", "deepseek-uncataloged-name")).toEqual(ALL);
  });

  it("glm/qwen/wudao 家族全五档（折叠表无 null 不支持项）", () => {
    expect(supportedEfforts("glm", "glm-4.6")).toEqual(ALL);
    expect(supportedEfforts("qwen", "qwen3-max")).toEqual(ALL);
    expect(supportedEfforts("wudao", "wudao-preview")).toEqual(ALL);
  });

  it("kimi-k2.7-code 家族钉：effort none 不支持（平台文档：必须显式 thinking）", () => {
    expect(supportedEfforts("kimi", "kimi-k2.7-code")).toEqual(["low", "medium", "high", "max"]);
    expect(supportedEfforts("kimi", "kimi-k2.7-code-highspeed")).toEqual(["low", "medium", "high", "max"]);
    // 同族未钉模型照全五档
    expect(supportedEfforts("kimi", "kimi-k3")).toEqual(ALL);
  });

  it("anthropic 线家族全五档（effort→budget_tokens 映射每档都可表达）", () => {
    expect(supportedEfforts("anthropic", "claude-sonnet-5")).toEqual(ALL);
    expect(supportedEfforts("glm-code", "glm-5.3")).toEqual(ALL);
    expect(supportedEfforts("kimi-code", "k3-256k")).toEqual(ALL);
  });

  it("thinkingLevelMap 的 null 不支持项折进目录（未来的折叠表作者零额外接线）", () => {
    expect(supportedEfforts("minimax", "MiniMax-M3")).toEqual(ALL);
  });

  it("未知 provider / 未知一切 → undefined（降级未验证，绝不炸）", () => {
    expect(supportedEfforts(undefined, "fake-model-x")).toBeUndefined();
    expect(supportedEfforts("not-a-provider", "m")).toBeUndefined();
    expect(supportedEfforts("", "m")).toBeUndefined();
  });

  it("MODEL_EFFORT_PINS 只允许已知档位成员（数据层自一致）", () => {
    for (const perProvider of Object.values(MODEL_EFFORT_PINS)) {
      for (const efforts of Object.values(perProvider)) {
        for (const e of efforts) expect((ALL as readonly string[]).includes(e)).toBe(true);
      }
    }
  });
});

describe("supportedEfforts — 覆盖列生效（R1 fail-closed 但可逃生）", () => {
  it("registry efforts 覆盖整卡替换（含模型钉——目录过时时的用户逃生口）", () => {
    const profiles = effectiveProfiles(new Map([
      ["kimi", { baseUrl: "https://api.moonshot.cn/anthropic", efforts: ["low", "medium", "high", "max", "none"] }],
    ]));
    expect(supportedEfforts("kimi", "kimi-k2.7-code", profiles)).toEqual(ALL);
  });

  it("覆盖也能收紧（网关已知只吃两档）", () => {
    const profiles = effectiveProfiles(new Map([
      ["deepseek", { efforts: ["high", "none"] }],
    ]));
    expect(supportedEfforts("deepseek", "deepseek-v4-flash", profiles)).toEqual(["high", "none"]);
    // 无覆盖列的 provider 不受影响
    expect(supportedEfforts("glm", "glm-4.6", profiles)).toEqual(ALL);
  });

  it("custom provider 带 efforts 列同样生效", () => {
    const profiles = effectiveProfiles(new Map([
      ["my-gw", { baseUrl: "https://gw.example/v1", efforts: ["low", "high"] }],
    ]));
    expect(supportedEfforts("my-gw", "any-model", profiles)).toEqual(["low", "high"]);
  });

  it("efforts 列缺省时目录走推导（builtin/overlay 均如此）", () => {
    const profiles = effectiveProfiles(new Map([
      ["deepseek", { baseUrl: "https://gw.example/v1" }],
    ]));
    expect(supportedEfforts("deepseek", "deepseek-v4-flash", profiles)).toEqual(ALL);
  });
});

describe("reasoningContentStreams — 是否 reasoning 模型（reasoning_content 有无）", () => {
  it("openai 线推理格式全 true（deepseek/zai/qwen 族）", () => {
    expect(reasoningContentStreams("deepseek")).toBe(true);
    expect(reasoningContentStreams("glm")).toBe(true);
    expect(reasoningContentStreams("qwen")).toBe(true);
    expect(reasoningContentStreams("wudao")).toBe(true);
  });

  it("anthropic 线与 format none 家族 false（thinking 块线，无 reasoning_content）", () => {
    expect(reasoningContentStreams("anthropic")).toBe(false);
    expect(reasoningContentStreams("kimi")).toBe(false);
    expect(reasoningContentStreams("minimax")).toBe(false);
    expect(reasoningContentStreams("glm-code")).toBe(false);
    expect(reasoningContentStreams("kimi-code")).toBe(false);
    expect(reasoningContentStreams("minimax-code")).toBe(false);
  });

  it("custom（缺省 format none）false；未知 provider undefined", () => {
    const profiles = effectiveProfiles(new Map([["my-gw", { baseUrl: "https://gw/v1" }]]));
    expect(reasoningContentStreams("my-gw", profiles)).toBe(false);
    expect(reasoningContentStreams(undefined)).toBeUndefined();
    expect(reasoningContentStreams("nope")).toBeUndefined();
  });
});
