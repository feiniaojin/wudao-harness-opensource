// ω99-193 — /status 一页器中文化回执：formatStatusReport/formatCtxLine 全报告体。
// 182/192 报告体先例同性质：报告体=用户所见，全中文。单源=commands/status.ts，
// 两调用点（repl.ts:2578 stdout / agent-driver.ts:5006 appendHistory notice）纯
// 结构透传零触；mode 值侧传 modeLabel(...) 显示词表，`${input.mode}` 插值原样。
// 中文词表裁定（key 前缀族）：status:→状态： version:→版本： provider · model:→
// 供应商 · 模型： mode:→模式： session:→会话： context:→上下文： keys:→密钥：
// reasoning:→推理： connectivity:→连通性： surfaces:→已加载：
// 值形：(unknown — frontend did not supply labels)→（未知——前端未提供标签）、
// (unknown)→（未知）、(none)→（无）、(not measured yet)→（尚未测量）、not probed
// (offline view…)→未探测（离线视图——上方为供应商标签，默认不联网）。
// token 保留：两空格行缩进、· 分隔符、/ 比值形、kib 数值 token、WUDAO_API_KEYS、
// 60s 429、MCP、join("\n") 结构。两组 6 it：
//   A1 满配（keys+reasoning）九 key 前缀各一 + surfaces 全串；
//   A2 未知标签双缺/单缺形；A3 会话空 + ctx null 形；A4 keys 冷却形 + 尾注逐字；
//   B1 旧形 12 串满配归零（not.toContain——(not measured yet)/(none) 两断言改前
//     即绿按 188/190/191/192 先例与十条红断言并组保红）；
//   B2 reasoning 条件门亲证（armed 在场正钉〔红〕+ 缺席 not.toContain 推理：
//     〔改前即绿〕并组保红）。
import { describe, expect, it } from "vitest";

import { formatStatusReport, formatCtxLine } from "../src/commands/status.js";
import type { StatusInput } from "../src/commands/status.js";

/** 必填族 fixture（provider/model/keys/reasoning 由各 it 显式加挂）。 */
const CORE: StatusInput = {
  version: "9.9.9",
  mode: "auto",
  sessionId: "wudao-abc-1234",
  ctx: { used: 12_000, window: 64_000 },
  surfaces: { skills: 3, plugins: 2, extensions: 1, mcp: 4, tools: 22 },
};

/** 满配减 reasoning（labels+keys 在场，条件门缺席腿）。 */
const LOADED: StatusInput = {
  ...CORE,
  provider: "deepseek",
  model: "deepseek-chat",
  keys: { total: 3, available: 2, cooling: 1 },
};

/** 满配（keys+reasoning 双在场——九 key 前缀一次全覆盖）。 */
const FULL: StatusInput = { ...LOADED, reasoningMandatoryPreArmed: true };

describe("ω99-193 A — /status 一页器中文化形态", () => {
  it("A1 满配全渲染：状态：头 + 九 key 前缀各一 + surfaces 全串", () => {
    const report = formatStatusReport(FULL);
    expect(report).toContain("状态：");
    for (const key of [
      "版本：",
      "供应商 · 模型：",
      "模式：",
      "会话：",
      "上下文：",
      "密钥：",
      "推理：",
      "连通性：",
      "已加载：",
    ]) {
      expect(report).toContain(key);
    }
    expect(report).toContain("3 个技能 · 2 个插件 · 1 个扩展 · 4 个 MCP 工具 · 共 22 个工具");
  });

  it("A2 未知标签形：双缺→（未知——前端未提供标签）；单缺→（未知）", () => {
    expect(formatStatusReport(CORE)).toContain("（未知——前端未提供标签）");
    expect(formatStatusReport({ ...CORE, provider: "deepseek" })).toContain(
      "供应商 · 模型：deepseek · （未知）",
    );
    expect(formatStatusReport({ ...CORE, model: "deepseek-chat" })).toContain(
      "供应商 · 模型：（未知） · deepseek-chat",
    );
  });

  it("A3 会话空→（无）；ctx null→（尚未测量）", () => {
    expect(formatStatusReport({ ...CORE, sessionId: "" })).toContain("会话：（无）");
    expect(formatStatusReport({ ...CORE, ctx: null })).toContain("上下文：（尚未测量）");
    expect(formatCtxLine(null)).toBe("（尚未测量）");
  });

  it("A4 keys 冷却形：（1 个冷却中）在场 + 尾注逐字", () => {
    expect(formatStatusReport(FULL)).toContain("（1 个冷却中）");
    expect(formatStatusReport(FULL)).toContain("（WUDAO_API_KEYS 密钥池，轮询 + 60s 429 冷却）");
    expect(
      formatStatusReport({ ...LOADED, keys: { total: 3, available: 3, cooling: 0 } }),
    ).not.toContain("个冷却中");
  });
});

describe("ω99-193 B — 旧形归零 + 条件门", () => {
  it("B1 旧形 12 串在满配输出归零", () => {
    const report = formatStatusReport(FULL);
    for (const old of [
      "version:",
      "mode:",
      "session:",
      "context:",
      "reasoning:",
      "connectivity:",
      "surfaces:",
      "skills · ",
      "tools total",
      "not probed",
      "(not measured yet)",
      "(none)",
    ]) {
      expect(report).not.toContain(old);
    }
  });

  it("B2 reasoning 条件门亲证：armed→推理：在场；缺席→not.toContain 推理：", () => {
    expect(formatStatusReport(LOADED)).not.toContain("推理：");
    expect(formatStatusReport({ ...LOADED, reasoningMandatoryPreArmed: true })).toContain(
      "推理：端点要求思考——本会话已预启用",
    );
  });
});
