// @vitest-environment jsdom
// ω99-224: #R1 — buddy 底部状态栏去冗余 + 工作区信任锚（0.3.59 验装回执
// 第一报）。用户令：「buddy模式，底部状态栏，wudao · 58052fe9 │ 模型
// glm-5.3 │ 模式 accep 这些其实会话窗口都有，已经重复显示了，换一些
// 会话窗口没有的内容」。五钉（brief §四）：
//   §1 buddy 变体渲染工作区领衔段（basename + title 全路径）+ ▣/bg/sidecar；
//   §2 buddy 变体不渲染 head/模型/模式/ctx/cache（负向钉——用户令的直接
//      验收面；夹具故意带着 model/ctxTokens/cachePercent 数据，证明是变体
//      砍段不是缺数据）；
//   §3 advanced 变体回归钉——既有段链字节级不变（现状快照，capture 自
//      本弧实现前的渲染）；
//   §4 busy 右缘段 buddy 保留（▌思考中 · Ns，与 SimpleTurnStatus 同源）；
//   §5 workspaceName 缺数据时工作区段省略（无悬空分隔符；全空时整条
//      statusline 按 omitted-entirely 纪律归零）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StatusBar } from "../src/components/StatusBar.js";
import type { DriverStatus, LiveState } from "../src/protocol.js";

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

/** The shared DriverStatus fixture — deliberately FULL: model + ctxTokens +
 *  cachePercent + board + bg + sidecar all present, so §2's negative pins
 *  prove the buddy VARIANT drops the redundant segments (not the fixture's
 *  missing data) and §3's snapshot exercises every advanced segment. */
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

describe("ω99-224 — StatusBar buddy 变体（去冗余 + 工作区信任锚）", () => {
  it("§1: buddy 渲染工作区领衔段（basename + title 全路径）+ ▣/bg/sidecar", () => {
    const c = mount(
      <StatusBar
        status={status({})}
        buddy={true}
        workspaceName="proj-x"
        workspacePath="/Users/u/work/proj-x"
      />,
    );
    const bar = c.querySelector(".statusline") as HTMLElement;
    expect(bar).not.toBeNull();
    // 领衔：工作区段是段链第一个孩子（信任锚一瞥可见）。
    const lead = bar.firstElementChild as HTMLElement;
    expect(lead?.textContent).toBe("工作区 proj-x");
    expect(lead?.getAttribute("title")).toBe("/Users/u/work/proj-x");
    // 会话窗没有的内容恰是新段集：board 进度 / bg 计数 / sidecar 检查。
    expect(bar.textContent).toContain("3/5"); // 116 弧 C：▣ → list-checks 细线字形
    expect(bar.textContent).toContain("bg 1/2");
    expect(bar.textContent).toContain("sidecar 4");
  });

  it("§2: buddy 不渲染 head/模型/模式/ctx/cache（负向钉——数据在也不显）", () => {
    const c = mount(
      <StatusBar
        status={status({})} // 夹具带着 model/ctxTokens/cachePercent
        buddy={true}
        workspaceName="proj-x"
        workspacePath="/Users/u/work/proj-x"
      />,
    );
    const bar = c.querySelector(".statusline") as HTMLElement;
    expect(bar?.textContent).not.toContain("wudao ·");
    expect(bar?.textContent).not.toContain("模型");
    expect(bar?.textContent).not.toContain("模式");
    expect(bar?.textContent).not.toContain("ctx");
    expect(bar?.textContent).not.toContain("cache");
    // 结构面同步负查：ctx/cache 段类零渲染。
    expect(bar?.querySelector(".seg-ctx")).toBeNull();
    expect(bar?.querySelector(".cache")).toBeNull();
  });

  it("§3: advanced 变体回归钉——既有段链字节级不变（现状快照，随 ω99-298 演进）", () => {
    const c = mount(<StatusBar status={status({})} />);
    const bar = c.querySelector(".statusline") as HTMLElement;
    expect(bar).not.toBeNull();
    // 快照 capture 自本弧实现前的渲染（wudao · id8 head → [branch 有则随]
    // → ctx → cache → ▣（116 弧 C 起 = list-checks 细线字形，此处归一为
    // <svg/> 占位——svg 内部标记由 arc116c 图标收据钉）→ bg → sidecar，
    // │ 分隔；本夹具无 branch）。
    // ω99-298 (M14): 模型/模式段退役（用户 224 报的「已重复显示」在高级面
    // 完成收口——composer chips 是唯一家）。任何段序/段文/分隔符的漂移都会
    // 在这里红。
    const norm = (html: string): string => html.replace(/<svg[\s\S]*?<\/svg>/g, "<svg/>");
    expect(norm(bar.innerHTML)).toBe(
      'wudao · wudao-te<span class="sep"> │ </span>' +
        '<span class="seg-ctx" title="上下文使用量">ctx 12.3k/131.1k</span>' +
        '<span class="sep"> │ </span><span class="cache">cache 89%</span>' +
        '<span class="sep"> │ </span><span class="board"><svg/> 3/5</span>' +
        '<span class="sep"> │ </span>bg 1/2' +
        '<span class="sep"> │ </span>sidecar 4',
    );
  });

  it("§4: busy 右缘段 buddy 保留（▌思考中 · Ns，1s 节流后）", async () => {
    vi.useFakeTimers();
    try {
      const c = mount(
        <StatusBar
          status={status({ busy: true, live: { reasoning: "想", answer: "", busyTools: [] } as LiveState })}
          buddy={true}
          workspaceName="proj-x"
          workspacePath="/Users/u/work/proj-x"
        />,
      );
      expect(c.querySelector(".seg-busy")).toBeNull(); // 1s 节流：t=0 无段
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      const seg = c.querySelector(".statusline > .seg-busy") as HTMLElement;
      expect(seg).not.toBeNull();
      expect(seg.textContent).toBe("▌思考中 · 1s");
      // 段链末位（右缘）——工作区段仍在领衔，busy 骑在分隔符链之外。
      expect((c.querySelector(".statusline") as HTMLElement).firstElementChild?.textContent).toBe("工作区 proj-x");
      expect(seg.nextElementSibling).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("§5: workspaceName 缺数据时工作区段省略——无悬空分隔符；全空时整条归零", () => {
    // 有其他段数据：工作区段省略，段链以 ▣ 领衔，首位不是分隔符。
    const c = mount(<StatusBar status={status({})} buddy={true} />);
    const bar = c.querySelector(".statusline") as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.textContent).not.toContain("工作区");
    expect(bar.firstElementChild?.textContent).toContain("3/5"); // ▣ 已是 svg 字形
    expect(bar.firstElementChild?.querySelector("svg")).not.toBeNull();
    expect(bar.firstElementChild?.classList.contains("sep")).toBe(false);
    // 全空（既无工作区又无 board/bg/sidecar）：整条 statusline 省略
    // （omitted-entirely 纪律——空壳条比没有条更坏）。
    const bare = mount(
      <StatusBar
        status={status({ boardProgress: null, bg: { active: 0, spawned: 0 }, sidecar: null })}
        buddy={true}
      />,
    );
    expect(bare.querySelector(".statusline")).toBeNull();
  });
});
