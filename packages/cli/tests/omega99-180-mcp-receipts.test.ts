// ω99-180: /mcp 报告全格式面中文化的 receipts 测试（先红后绿）。
// 镜像 m55b-commands/mcp-http/mcp-oauth 的 buildMcpRows/formatMcpReport fixture 形，
// 四组十三 it 逐字钉 brief §一 的 15 面新串。token 裁定：transport 值（http/stdio）、
// tier 串（mcpTierLabel 跨包缝零触）、`mcp__`、trace 模式值（off/header）、URL 产物、
// ` · ` 分隔、`${name}: ` ASCII 冒号一律保留。§零.2：oauth 标签全角冒号
// ` · oauth：已授权/需授权`，本文件 strip-regex 与 :162 源串锁步（独立于 mcp-oauth:726）。
import { describe, it, expect, afterEach } from "vitest";
import { buildMcpRows, formatMcpReport } from "../src/commands/mcp-status.js";
import type { McpRuntimeInfo } from "../src/mcp/tools.js";

const TIER_STR = "user ~/.wudao/mcp.json · root .mcp.json · project .wudao/mcp.json";
const rt = (over: Partial<McpRuntimeInfo>): McpRuntimeInfo => ({
  connected: true, tools: 0, handshakeMs: 12, calls: 0, errors: 0, ...over,
});

afterEach(() => { delete process.env.WUDAO_MCP_TRACE; });

describe("ω99-180 A — 行渲染三态/握手/最近调用/traffic", () => {
  it("A1: connected/failed/disconnected 三态行 + `N 个工具` + `握手 Xms`", () => {
    const text = formatMcpReport(buildMcpRows({
      config: { servers: { up: { command: "node" }, dead: { command: "nope" }, idle: { command: "sleep" } } },
      toolNames: [],
      runtime: new Map([
        ["up", rt({ connected: true, tools: 2 })],
        ["dead", rt({ connected: false, tools: 0, handshakeMs: 3_000, errors: 1, failure: "spawn ENOENT" })],
        ["idle", rt({ connected: false, tools: 0, handshakeMs: 0 })],
      ]),
    }));
    expect(text).toContain("up: 已连接 · 2 个工具 · 握手 12ms");
    expect(text).toContain("dead: 失败 · 0 个工具 · 握手 3.0s");
    expect(text).toContain("idle: 已断开 · 0 个工具 · 握手 0ms");
    expect(text).toContain("spawn ENOENT"); // 存活面：failure 透传行零触
  });

  it("A2: lastCallMs → `最近调用` 段（附于握手之后）", () => {
    const text = formatMcpReport(buildMcpRows({
      config: { servers: { busy: { command: "node" } } },
      toolNames: [],
      runtime: new Map([["busy", rt({ tools: 1, lastCallMs: 45 })]]),
    }));
    expect(text).toContain("busy: 已连接 · 1 个工具 · 握手 12ms · 最近调用 45ms");
  });

  it("A3: traffic——calls>0 → `N 次调用`，errors>0 → `，N 次错误`（全角逗号）；calls=0 无段", () => {
    const withTraffic = formatMcpReport(buildMcpRows({
      config: { servers: { a: { command: "node" }, b: { command: "node" }, c: { command: "node" } } },
      toolNames: [],
      runtime: new Map([
        ["a", rt({ calls: 5 })],
        ["b", rt({ calls: 5, errors: 2 })],
        ["c", rt({ calls: 0 })],
      ]),
    }));
    expect(withTraffic).toContain("a: 已连接 · 0 个工具 · 握手 12ms · 5 次调用");
    expect(withTraffic).toContain("b: 已连接 · 0 个工具 · 握手 12ms · 5 次调用，2 次错误");
    const cLine = withTraffic.split("\n").find((l) => l.trimStart().startsWith("c:")) ?? "";
    expect(cLine.endsWith("握手 12ms")).toBe(true);
  });
});

describe("ω99-180 B — 报告骨架（empty/header/footer/trace）", () => {
  const demoRows = buildMcpRows({
    config: { servers: { demo: { command: "node" } } },
    toolNames: [],
    runtime: new Map([["demo", rt({ connected: true, tools: 1 })]]),
  });

  it("B1: empty 报告整句（#2 `均无` + tier 串在场；无 mcp__ 工具句尾）", () => {
    expect(formatMcpReport([])).toBe(`mcp：未配置服务器（${TIER_STR} 均无，且未加载任何 mcp__ 工具）`);
    expect(formatMcpReport([], { file: "x.json" })).toBe("mcp：未配置服务器（x.json 均无，且未加载任何 mcp__ 工具）");
  });

  it("B2: header（#3 `mcp 服务器（` 前缀 + `+ 已加载的运行时）：`）", () => {
    expect(formatMcpReport(demoRows).split("\n")[0]).toBe(`mcp 服务器（${TIER_STR} + 已加载的运行时）：`);
    expect(formatMcpReport(demoRows, { file: "x.json" }).split("\n")[0]).toBe("mcp 服务器（x.json + 已加载的运行时）：");
  });

  it("B3: footer（#4 mcp__ 询问句 + 溯源标记）", () => {
    expect(formatMcpReport(demoRows).split("\n")).toContain("  (mcp__ 工具的写入/命令始终询问；结果带 mcp 溯源标记)");
  });

  it("B4: trace 行（#5 `(trace：` 全角冒号 + 模式值 token 原样）", () => {
    process.env.WUDAO_MCP_TRACE = "";
    expect(formatMcpReport(demoRows).split("\n")).toContain("  (trace：off)");
    process.env.WUDAO_MCP_TRACE = "1";
    expect(formatMcpReport(demoRows).split("\n")).toContain("  (trace：header)");
  });
});

describe("ω99-180 C — oauth 标注（§零.2 功能钉锁步面）", () => {
  const config = {
    servers: {
      gh: { url: "https://gh/mcp", oauth: true },
      plain: { url: "https://plain/mcp" },
      local: { command: "npx", args: ["-y", "mcp"] },
    },
  };
  const report = (authStatus?: (s: string) => boolean): string =>
    formatMcpReport(buildMcpRows({
      config, toolNames: [], runtime: new Map(),
      ...(authStatus !== undefined ? { authStatus } : {}),
    }));

  it("C1: authed 态 ` · oauth：已授权`（全角冒号）", () => {
    expect(report((s) => s === "gh")).toContain(" · oauth：已授权");
  });

  it("C2: missing 态 ` · oauth：需授权`", () => {
    expect(report(() => false)).toContain(" · oauth：需授权");
  });

  it("C3: 非 oauth 行字节稳定（strip 后逐字节一致，镜像 :726 形但独立断言）", () => {
    const withAuth = report((s) => s === "gh");
    const withAuthMissing = report(() => false);
    const without = report();
    const stripOauth = (s: string): string => s.replace(/ · oauth：(已授权|需授权)/g, "");
    expect(stripOauth(withAuth)).toBe(stripOauth(without));
    expect(stripOauth(withAuthMissing)).toBe(stripOauth(without));
    // 不 strip 时非 oauth 行也逐字节一致（oauth 标注是纯增量）。
    const plainLines = (s: string): readonly string[] => s.split("\n").filter((l) => !l.trimStart().startsWith("gh:"));
    expect(plainLines(withAuth)).toEqual(plainLines(without));
  });
});

describe("ω99-180 D — tier 行与杂项", () => {
  it("D1: source 行（#15 `来源：` 前缀 + tier 串；ASCII 括号保）", () => {
    const lines = formatMcpReport(buildMcpRows({
      config: { servers: { solo: { command: "node" } } },
      toolNames: [],
      runtime: new Map([["solo", rt({ connected: true, tools: 1 })]]),
      tiers: { user: { solo: { command: "node" } }, root: {}, project: {} },
    })).split("\n");
    expect(lines).toContain("    (来源：user ~/.wudao/mcp.json)");
  });

  it("D2: replaces（#14 ` · 取代 ` + mcpTierLabel 输出；生效项驱动渲染）", () => {
    const text = formatMcpReport(buildMcpRows({
      config: { servers: { shadowed: { command: "project-one" } } },
      toolNames: [],
      runtime: new Map(),
      tiers: { user: { shadowed: { command: "global-one" } }, root: {}, project: { shadowed: { command: "project-one" } } },
    }));
    expect(text.split("\n")).toContain("    (来源：project .wudao/mcp.json · 取代 user ~/.wudao/mcp.json)");
    expect(text).not.toContain("global-one");
  });

  it("D3: runtime-only 行 command = `(不在 mcp.json 中)`（#1，push(name, undefined) 形）", () => {
    const rows = buildMcpRows({
      toolNames: ["mcp__stray__x"],
      runtime: new Map([["stray", rt({ connected: true, tools: 1 })]]),
    });
    expect(rows[0]?.command).toBe("(不在 mcp.json 中)");
    expect(rows[0]?.source).toBeUndefined();
    expect(rows[0]?.transport).toBeUndefined();
  });
});
