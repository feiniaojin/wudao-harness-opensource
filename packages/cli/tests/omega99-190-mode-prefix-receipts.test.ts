// ω99-190 receipts — mode 词前缀族收口（渲染行 7 面：statusline.ts:93 /
// tui/status-bar.tsx:38 / tui/app.tsx:2024 / repl.ts:1485 / repl.ts:1517 /
// repl.ts:1523 / tui/banner.ts:38）。A 组真渲染（镜像 statusline.test /
// banner.test 的 fixture 形）+ repl/TUI 源钉（166/175 系 readFileSync 范式）；
// B 组反向：旧英文前缀形在被测渲染输出归零 + modeLabel 枚举字面 wire 层
// 原样（ω99-175 裁定：accept/ask/auto/plan/workspace 为 wire 枚举，显示层
// 前缀词中文化不动枚举值）。插值/${} 结构逐字保留；repl:1485 的 `model: `
// 前缀词为 model 域 sibling 残面，域外披露不在本弧。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStatuslineSnapshot, formatStatuslineLine } from "../src/statusline.js";
import { buildBanner } from "../src/tui/banner.js";
import type { DriverStatus } from "../src/driver/agent-driver.js";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const SRC = {
  repl: readFileSync(join(srcDir, "repl.ts"), "utf8") as string,
  bar: readFileSync(join(srcDir, "tui", "status-bar.tsx"), "utf8") as string,
  app: readFileSync(join(srcDir, "tui", "app.tsx"), "utf8") as string,
};

// 镜像 statusline.test 的 baseStatus fixture（mode: "workspace" → 显示层
// modeLabel 折叠为 accept，wire 值 workspace 保真）。
const baseStatus = (over: Partial<DriverStatus> = {}): DriverStatus => ({
  live: { reasoning: "th", answer: "an answer text", busyTools: [{ name: "read_file", summary: "a" }] },
  busy: true,
  queued: ["next"],
  boardProgress: { done: 1, total: 4 },
  ctxTokens: { used: 12_000, window: 64_000, nearLimit: false },
  mode: "workspace",
  cachePercent: 87.4,
  bg: { active: 1, spawned: 2 },
  pendingPermission: null,
  planBoard: null,
  sessionId: "wudao-abcdefgh",
  sidecar: { checks: 3, breakerOpen: false },
  ...over,
});

const bannerInfo = { version: "0.2.0", model: "deepseek-v4-flash", session8: "060dc142", mode: "ask" };

describe("ω99-190 A — 渲染行新形（真渲染 + 源钉锁步）", () => {
  it("formatStatuslineLine 两态：模式 段在场（有数据 full-line / 空态收尾）", () => {
    const line = formatStatuslineLine(buildStatuslineSnapshot(baseStatus(), { version: "1", model: "deepseek-chat" }));
    expect(line).toBe("wudao · deepseek-chat · wudao-ab │ 模式 accept │ ctx 12k/64k │ cache 87% │ ▣ 1/4 │ bg 1/2 │ sidecar 3 │ busy │ queued 1");
    const empty = formatStatuslineLine(buildStatuslineSnapshot(baseStatus({
      boardProgress: null, ctxTokens: null, cachePercent: null, sidecar: null, busy: false, queued: [],
      bg: { active: 0, spawned: 0 },
      live: { reasoning: "", answer: "", busyTools: [] },
    }), { version: "1", model: "m" }));
    expect(empty).toBe("wudao · m · wudao-ab │ 模式 accept");
  });

  it("buildBanner info 行：· 模式 尾段逐字（宽形末行 / 窄形回退行）", () => {
    const wide = buildBanner(bannerInfo, 120);
    expect(wide[wide.length - 1]).toBe("悟道Harness v0.2.0 · deepseek-v4-flash · 060dc142 · 模式 ask"); // 品牌弧前缀
    const [narrow] = buildBanner(bannerInfo, 40);
    expect(narrow).toContain("悟道Harness v0.2.0 · deepseek-v4-flash · 060dc142 · 模式 ask"); // 品牌弧前缀
  });

  it("repl 启动 banner（源钉）：模式： 前缀在位（mode: → 模式：）", () => {
    expect(SRC.repl).toContain("· 模式：${modeLabel(modeRef.mode)}\\n");
  });

  it("mode-cycle notice 双分支（源钉）：mid-run \\n 前缀形 + idle 形", () => {
    expect(SRC.repl).toContain("stdout.write(`\\n模式 → ${label}\\n`)");
    expect(SRC.repl).toContain("stdout.write(`模式 → ${label}\\n`)");
  });

  it("TUI 状态条 + 头部暗行（源钉）：模式 段与 status-bar/app.tsx 锁步", () => {
    expect(SRC.bar).toContain("模式 ${modeLabel(s.mode as Parameters<typeof modeLabel>[0])}");
    expect(SRC.app).toContain("· 模式 ${modeLabel(api.mode)} · session ");
  });
});

describe("ω99-190 B — 反向：旧形归零 + wire 枚举原样", () => {
  it("旧英文前缀形在被测渲染输出归零（mode accept/ask · │ mode · · mode · mode → ）", () => {
    const line = formatStatuslineLine(buildStatuslineSnapshot(baseStatus(), { version: "1", model: "deepseek-chat" }));
    const empty = formatStatuslineLine(buildStatuslineSnapshot(baseStatus({
      boardProgress: null, ctxTokens: null, cachePercent: null, sidecar: null, busy: false, queued: [],
      bg: { active: 0, spawned: 0 },
      live: { reasoning: "", answer: "", busyTools: [] },
    }), { version: "1", model: "m" }));
    const wide = buildBanner(bannerInfo, 120).join("\n");
    const [narrow] = buildBanner(bannerInfo, 40);
    for (const text of [line, empty, wide, narrow ?? ""]) {
      expect(text).not.toContain("mode accept");
      expect(text).not.toContain("mode ask");
      expect(text).not.toContain("│ mode ");
      expect(text).not.toContain("· mode ");
    }
    expect(SRC.repl).not.toContain("mode → "); // repl 双分支渲染行（175 同形负钉扩至 repl 域）
  });

  it("modeLabel 枚举字面 wire 层原样（模式 accept / 模式 ask + snapshot JSON raw mode）", () => {
    const line = formatStatuslineLine(buildStatuslineSnapshot(baseStatus(), { version: "1", model: "deepseek-chat" }));
    expect(line).toContain("模式 accept"); // 枚举字面 accept 原样骑行
    const wide = buildBanner(bannerInfo, 120);
    expect(wide[wide.length - 1]).toContain("模式 ask"); // 枚举字面 ask 原样骑行
    // JSON snapshot 的 mode 字段是 machine-readable wire 值（statusline.ts
    // buildStatuslineSnapshot 原样透传，中文化零触 §三）。
    expect(buildStatuslineSnapshot(baseStatus(), { version: "1", model: "m" }).mode).toBe("workspace");
  });
});
