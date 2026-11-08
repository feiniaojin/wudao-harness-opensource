// ω99-313 — 会话列表行的 ⏰ 定时标记（schedulesList 的 sessionId join）的
// receipts：绑定的活跃 schedule → 行显 ⏰（tooltip 收益语）；暂停/熔断的绑
// 定不显（标记即「它会自己醒」的承诺）；能力缺席（旧 server）与读取失败
// → 标记整体隐藏，会话列表本身永不因此门控；CSS 静信号形钉。
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { readStyles } from "./styles-source.js";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SessionSidebar } from "../src/components/SessionSidebar.js";
import type { SessionRow, ScheduleListRow } from "../src/protocol.js";

// 201/209 receipts 同款形：URL 首参必须是变量（vite 测试管线会改写字面量形）。
const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

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

const row = (id: string): SessionRow => ({
  id,
  mtime: new Date(Date.now() - 5 * 60_000).toISOString(),
  messages: 2,
  firstUser: "",
  model: "deepseek-v4-flash",
});

const schedRow = (over: Partial<ScheduleListRow> & { id: string }): ScheduleListRow => ({
  kind: "task",
  prompt: "p",
  trigger: "每周一 09:00",
  nextRunAt: Date.now() + 3_600_000,
  enabled: true,
  paused: false,
  ...over,
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
});

describe("ω99-313 — ⏰ 标记 join 面", () => {
  it("绑定的活跃 schedule → 该行显 ⏰（tooltip 收益语）；暂停绑定与未绑定行不显", async () => {
    const rows = [
      { ...row("sess-bound"), name: "绑定行" },
      { ...row("sess-paused"), name: "暂停行" },
      { ...row("sess-plain"), name: "普通行" },
    ];
    const client = {
      sessions: () => Promise.resolve(rows),
      schedulesList: () =>
        Promise.resolve([
          schedRow({ id: "aaaaaaaa", sessionId: "sess-bound" }),
          schedRow({ id: "bbbbbbbb", sessionId: "sess-paused", paused: true }),
        ]),
    };
    const el = mount(
      <SessionSidebar client={client} activeSessionId={null} onResume={() => {}} onNewChat={() => {}} onOpenSearch={() => {}} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    const markers = el.querySelectorAll(".sb-sched");
    expect(markers.length).toBe(1);
    expect(markers[0]!.getAttribute("title")).toBe("这个会话有定时任务或提醒");
    // 116 弧 C：⏰ emoji → clock 细线字形（textContent 空、svg 在位）。
    expect(markers[0]!.textContent).toMatch(/^\s*$/); // svg inter-path 空白
    expect(markers[0]!.querySelector("svg")).not.toBeNull();
    // The paused binding leaves its row unmarked (the ⏰ is a live-wake promise).
    const markedRow = markers[0]!.closest(".sb-i") as HTMLElement | null;
    expect(markedRow?.textContent).toContain("绑定行");
    expect(markedRow?.textContent).not.toContain("暂停行");
  });

  it("熔断停用（enabled:false）的绑定同样不显", async () => {
    const rows = [row("sess-broken")];
    const client = {
      sessions: () => Promise.resolve(rows),
      schedulesList: () => Promise.resolve([schedRow({ id: "cccccccc", sessionId: "sess-broken", enabled: false })]),
    };
    const el = mount(
      <SessionSidebar client={client} activeSessionId={null} onResume={() => {}} onNewChat={() => {}} onOpenSearch={() => {}} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(el.querySelectorAll(".sb-sched").length).toBe(0);
  });

  it("能力缺席（无 schedulesList）与读取失败 → 标记整体隐藏，会话行照常渲染", async () => {
    const rows = [row("sess-a"), row("sess-b")];
    const plain = { sessions: () => Promise.resolve(rows) };
    const el = mount(
      <SessionSidebar client={plain} activeSessionId={null} onResume={() => {}} onNewChat={() => {}} onOpenSearch={() => {}} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(el.querySelectorAll(".sb-sched").length).toBe(0);
    expect(el.querySelectorAll(".sb-i").length).toBeGreaterThanOrEqual(2);

    const failing = {
      sessions: () => Promise.resolve(rows),
      schedulesList: () => Promise.reject(new Error("old server")),
    };
    const el2 = mount(
      <SessionSidebar client={failing} activeSessionId={null} onResume={() => {}} onNewChat={() => {}} onOpenSearch={() => {}} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(el2.querySelectorAll(".sb-sched").length).toBe(0);
    expect(el2.querySelectorAll(".sb-i").length).toBeGreaterThanOrEqual(2);
  });
});

describe("ω99-313 — CSS 静信号形钉", () => {
  it(".sb-sched 规则在册：text-2 静信号 + caption 号 + 零底（不是状态徽标语言）", () => {
    const css = readStyles();
    const m = css.match(/\.sb-i\s+\.sb-sched\s*\{([^}]*)\}/);
    expect(m, ".sb-i .sb-sched rule present").not.toBeNull();
    const body = m?.[1] ?? "";
    expect(body).toMatch(/color:\s*var\(--text-2\)/);
    expect(body).toMatch(/font-size:\s*var\(--fs-caption\)/);
    expect(body).not.toMatch(/background:/);
  });
});
