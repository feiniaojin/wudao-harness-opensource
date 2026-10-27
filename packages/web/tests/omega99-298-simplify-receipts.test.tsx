// @vitest-environment jsdom
// ω99-298 — 高级面简洁化收据（v5 弧4）。三处同族：同一事实在一张脸上
// 显示两遍。I7: topbar run 徽章的 `· Xk ctx` 尾巴退役——statusline 的
// seg-ctx 是唯一家（窗口 + ⚠ + hover 明细严格更富）；徽章只报 tools，
// ctx 仍是活性门（App 级钉在 shell-visual 演进里）。M13: 思考卡的
// 「按 Esc…可停止」尾注退役——输入框 busy 态的「停止 (Esc)」chip 是唯
// 一停止入口，同屏不再回声。M14: statusline 模型/模式段退役——composer
// 的 ModelSelector/ShieldSelector chips 是可交互的唯一家（用户 ω99-224
// 的「已重复显示」裁定在高级面完成收口）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StatusBar } from "../src/components/StatusBar.js";
import { SimpleTurnStatus } from "../src/components/SimpleTurnStatus.js";
import { InputBox } from "../src/components/InputBox.js";
import type { DriverStatus, LiveState } from "../src/protocol.js";
import "../src/styles.css";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const mount = (el: React.ReactElement): HTMLElement => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(el);
  });
  return container;
};
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
});

/** 224 同款 FULL DriverStatus 夹具（模型/ctx/cache/board/bg/sidecar 全
 *  在场）——负钉证明是段退役、不是夹具缺数据。 */
const status: (over: Partial<DriverStatus>) => DriverStatus = (over) => ({
  live: { reasoning: "", answer: "", busyTools: [] },
  busy: false,
  queued: [],
  boardProgress: { done: 3, total: 5 },
  ctxTokens: { used: 12345, window: 131072, nearLimit: false },
  mode: "auto",
  cachePercent: 89,
  bg: { active: 1, spawned: 2 },
  pendingPermission: null,
  planBoard: null,
  sessionId: "wudao-test-0001",
  sidecar: { checks: 4, breakerOpen: false },
  model: { label: "glm-5.3", provider: "zhipu", choices: [] },
  ...over,
});

describe("ω99-298 高级面简洁化收据", () => {
  it("M14 (DOM): 模型/模式段退役——数据在场也不显；ctx/cache/board 等非重复段原样在场", () => {
    const c = mount(<StatusBar status={status({})} />);
    const bar = c.querySelector(".statusline") as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.textContent).not.toContain("模型 ");
    expect(bar.textContent).not.toContain("模式 ");
    // composer 里没有的事实（ctx 用量 / cache 命中 / board 进度）一条不少。
    expect(bar.textContent).toContain("ctx 12.3k/131.1k");
    expect(bar.textContent).toContain("cache 89%");
    expect(bar.textContent).toContain("3/5"); // 116 弧 C：▣ → list-checks 字形
  });

  it("M14 (守卫): branch 段（ω99-253 高级面同芯片）不受模型/模式退役牵连", () => {
    const c = mount(<StatusBar status={status({ gitBranch: "feat/x" })} />);
    const seg = c.querySelector(".statusline .seg-branch") as HTMLElement;
    expect(seg).not.toBeNull();
    expect(seg.textContent).toBe("feat/x");
  });

  it("M13 (DOM): busy 思考卡头部无停止尾注——行内只剩 spinner/label/clock", () => {
    const live = { reasoning: "想", answer: "", busyTools: [] } as LiveState;
    const c = mount(<SimpleTurnStatus busy={true} live={live} />);
    expect(c.querySelector(".ts-head .cancel-hint")).toBeNull();
    expect(c.querySelector(".ts-head .label")?.textContent).toContain("正在");
  });

  it("M13 (CSS): .cancel-hint 死规则已删（全 CSSOM 无该选择器）", () => {
    const hits: string[] = [];
    for (const sheet of document.styleSheets) {
      const rules = [...(sheet.cssRules ?? [])];
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule && rule.selectorText.includes("cancel-hint")) {
          hits.push(rule.selectorText);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("M13 (对面): 停止的唯一家在场——composer busy 态渲染「停止 (Esc)」chip", () => {
    const c = mount(
      <InputBox
        busy={true}
        mode="workspace"
        commands={[]}
        connected={true}
        onSubmit={vi.fn()}
        onInterrupt={vi.fn()}
        onShield={vi.fn()}
        onCycleMode={vi.fn()}
      />,
    );
    const chip = c.querySelector<HTMLButtonElement>(".composer-tools .chip.interrupt");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("停止 (Esc)");
  });
});
