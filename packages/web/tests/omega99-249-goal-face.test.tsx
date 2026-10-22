// @vitest-environment jsdom
// ω99-249: #13 — R5 — the web's goal face. One line in the status strip: the
// objective with spent/budget (benefit copy, zero implementation terms);
// budget_limited gets its own dedicated treatment (warn styling + 预算已尽
// wording); an old server that never sends `goal` (or sends null) renders
// NOTHING — quiet degradation, no dangling separator.
import { describe, it, expect } from "vitest";
import React from "react";
import ReactDOM from "react-dom/client";
import { act } from "react";
import { StatusBar } from "../src/components/StatusBar.js";
import type { DriverStatus } from "../src/protocol.js";

function baseStatus(): DriverStatus {
  return {
    live: { reasoning: "", answer: "", busyTools: [] },
    busy: false,
    queued: [],
    boardProgress: null,
    ctxTokens: null,
    mode: "workspace",
    cachePercent: null,
    bg: { active: 0, spawned: 0 },
    pendingPermission: null,
    planBoard: null,
    sessionId: "wudao-test-0001",
    sidecar: null,
    model: null,
  };
}

const goal = (over: Partial<NonNullable<DriverStatus["goal"]>> = {}) => ({
  objective: "完成认证模块并全部测试通过",
  status: "active" as const,
  usedTokens: 4300,
  inputTokens: 4000,
  outputTokens: 300,
  budgetTokens: 5000,
  missionTaskId: "t2",
  progress: { done: 2, total: 5 },
  ...over,
});

async function render(el: React.ReactElement): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = ReactDOM.createRoot(host);
  await act(async () => {
    root.render(el);
  });
  return host;
}

describe("ω99-249 R5 — StatusBar 的目标一行露出", () => {
  it("renders the goal segment with benefit copy: objective + spent/budget + progress", async () => {
    const c = await render(<StatusBar status={{ ...baseStatus(), goal: goal() }} />);
    const seg = c.querySelector(".statusline .seg-goal") as HTMLElement;
    expect(seg).not.toBeNull();
    expect(seg.textContent).toContain("目标");
    expect(seg.textContent).toContain("完成认证模块并全部测试通过");
    expect(seg.textContent).toContain("4.3k"); // formatTokensK(4300)
    expect(seg.textContent).toContain("5k"); // formatTokensK(5000)
    expect(seg.textContent).toContain("2/5");
    // benefit-copy discipline: no implementation terms on the user-visible line
    expect(seg.textContent).not.toContain("entry");
    expect(seg.textContent).not.toContain("投影");
    expect(seg.textContent).not.toContain("missionTaskId");
  });

  it("unbudgeted goal: spent only, no fake budget number", async () => {
    const c = await render(<StatusBar status={{ ...baseStatus(), goal: goal({ budgetTokens: undefined }) }} />);
    const seg = c.querySelector(".statusline .seg-goal") as HTMLElement;
    expect(seg.textContent).toContain("4.3k"); // the spent figure
    expect(seg.textContent).not.toContain("5k"); // no budget was declared
    expect(seg.textContent).not.toContain("预算");
  });

  it("budget_limited: the dedicated warn face (own class + explicit wording)", async () => {
    const c = await render(<StatusBar status={{ ...baseStatus(), goal: goal({ status: "budget_limited", usedTokens: 5400 }) }} />);
    const seg = c.querySelector(".statusline .seg-goal") as HTMLElement;
    expect(seg).not.toBeNull();
    expect(seg.className).toContain("warn");
    expect(seg.textContent).toContain("预算已尽");
  });

  it("old server / no goal: NOTHING renders — quiet degradation, no dangling separator", async () => {
    const noField = await render(<StatusBar status={baseStatus()} />);
    expect(noField.querySelector(".statusline .seg-goal")).toBeNull();
    const nullGoal = await render(<StatusBar status={{ ...baseStatus(), goal: null }} />);
    expect(nullGoal.querySelector(".statusline .seg-goal")).toBeNull();
    // and the strip itself still renders its other segments untouched
    expect(nullGoal.querySelector(".statusline")).not.toBeNull();
  });
});
