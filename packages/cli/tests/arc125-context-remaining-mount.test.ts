// 125 项 2（codex get_context_remaining 形）— context_remaining 的挂载面钉子：
// 工具集装配（ctx_inspect 族定位）、只读权限面（READ_TOOLS，不进 ask）、
// 三个交互前端的接线（web/session-engine · TUI/app · REPL/index.ts+repl.ts）
// 与 one-shot。源码缝断言沿 omega99-175/190 的 readFileSync 先例。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildToolSet } from "../src/tools.js";
import { READ_TOOLS } from "../src/permission-modes.js";
import { DEFAULT_ASK_TOOLS } from "../src/permission-rules.js";
import type { Tool } from "@wudao/core";

const noop = (): void => {};

const baseOpts = {
  workspaceRoot: "/tmp/w",
  model: { modelId: "m", generate: async () => ({ role: "assistant", content: "x" }) } as never,
  canUseTool: async () => ({ behavior: "allow" }) as never,
  contextWindowTokens: 100_000,
};

describe("125 项 2 — buildToolSet 挂载面", () => {
  it("三缝齐备 → context_remaining 挂载，定位紧随 ctx_inspect 之后", () => {
    const tools = buildToolSet({
      ...baseOpts,
      contextProbe: () => [],
      getSystemPrompt: () => "s",
      contextRemaining: { getThreshold: () => ({ windowTokens: 100_000 }) },
    });
    const names = tools.map((t) => t.name);
    const iInspect = names.indexOf("ctx_inspect");
    const iRemaining = names.indexOf("context_remaining");
    expect(iInspect).toBeGreaterThanOrEqual(0);
    expect(iRemaining).toBe(iInspect + 1); // 家族定位：ctx_inspect 的紧邻族弟
    const tool = tools.find((t) => t.name === "context_remaining") as Tool;
    expect(tool.isReadOnly?.({})).toBe(true);
  });

  it("contextRemaining 缺席 → 零表面（既有夹具字节不变）；probe 缺席 → 同样零表面", () => {
    const without = buildToolSet({ ...baseOpts, contextProbe: () => [], getSystemPrompt: () => "s" });
    expect(without.some((t) => t.name === "context_remaining")).toBe(false);
    const noProbe = buildToolSet({
      ...baseOpts,
      getSystemPrompt: () => "s",
      contextRemaining: { getThreshold: () => ({ windowTokens: 100_000 }) },
    });
    expect(noProbe.some((t) => t.name === "context_remaining")).toBe(false);
  });

  it("阈值缝随调用重读（live 窗口/预留——/model //provider 切换后生效）", async () => {
    let live = { windowTokens: 100_000, outputReserveTokens: 4_096 };
    const tools = buildToolSet({
      ...baseOpts,
      contextProbe: () => [],
      getSystemPrompt: () => "s",
      contextRemaining: { getThreshold: () => live },
    });
    const tool = tools.find((t) => t.name === "context_remaining") as Tool;
    const first = (await tool.execute({})).content as string;
    expect(first).toContain("compressionThreshold: 80000"); // min(80K, 100K−4K−2K)
    live = { windowTokens: 128_000, outputReserveTokens: 32_768 };
    const second = (await tool.execute({})).content as string;
    expect(second).toContain("compressionThreshold: 93184"); // 128K 窗 + 32K 预留
  });
});

describe("125 项 2 — 权限面（只读不加 ask）", () => {
  it("READ_TOOLS 含 context_remaining（workspace/plan 只读面自动放行）", () => {
    expect(READ_TOOLS.has("context_remaining")).toBe(true);
  });
  it("不进 DEFAULT_ASK_TOOLS（查自己的水位线不是要审批的动作）", () => {
    expect(DEFAULT_ASK_TOOLS.has("context_remaining")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 前端接线（三交互前端 + one-shot）：源码缝断言——每处 buildToolSet 都交了
// contextRemaining 缝（readFileSync 先例：omega99-175/190）。
// ---------------------------------------------------------------------------
const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

describe("125 项 2 — 前端接线面", () => {
  it("web/session-engine：contextRemaining 缝 + live 窗口（compactionOptions）", () => {
    const src = read("../src/driver/session-engine.ts");
    expect(src).toContain("contextRemaining: {");
    expect(src).toContain("compactionOptions?.contextWindowTokens ?? contextWindowTokens");
  });
  it("TUI/app：contextRemaining 缝 + live 窗口（liveWindowTokens）", () => {
    const src = read("../src/tui/app.tsx");
    expect(src).toContain("contextRemaining: {");
    expect(src).toContain("windowTokens: liveWindowTokens");
  });
  it("REPL：index.ts 交盒 + repl.ts 武装（effortLiveBox 同款晚绑纪律）", () => {
    const indexSrc = read("../src/index.ts");
    const replSrc = read("../src/repl.ts");
    expect(indexSrc).toContain("replCompactionThresholdBox");
    expect(replSrc).toContain("compactionThresholdLiveBox.get =");
    expect(replSrc).toContain("windowTokens: windowRef.current");
  });
  it("one-shot：静态接线（boot 窗口 + config 帽）", () => {
    const src = read("../src/index.ts");
    expect(src).toContain("windowTokens: contextWindowTokens,");
    expect(src).toContain("compactionThresholdFields(config, oneShotCompactionSettings)");
  });
});
