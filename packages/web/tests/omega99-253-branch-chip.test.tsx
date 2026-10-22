// @vitest-environment jsdom
// ω99-253: #2 — R3/R4 — the web's branch chip. 分支是工作区锚的一个属性
// （224 锚体系的自然延伸），不是新状态项：buddy 挂在工作区段之后、advanced
// 挂在 head 之后，两模式同挂=同一条信息（裁定钉）。null / 老 server 无字段
// / 非仓库 → chip 整面消失（零渲染零占位——与 245 健康行/251 点名行同族的
// 零噪音门）；detached "HEAD" 原样显示（诚实）。R4 邻接：224 工作区锚领衔
// 语义零演进（chip 在场时锚仍是第一个孩子）；249 goal 行 / 216 改动 chip
// 与分支 chip 各自恰一次渲染（共存互不挤占）。
import { afterEach, describe, expect, it } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StatusBar } from "../src/components/StatusBar.js";
import { App } from "../src/components/App.js";
import { WudaoClient } from "../src/protocol.js";
import type { DriverStatus } from "../src/protocol.js";
import { authOk, fakeServer } from "./mock-ws.js";

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

function baseStatus(over: Partial<DriverStatus> = {}): DriverStatus {
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
    ...over,
  };
}

/** The strip interleaves a `.sep` span before every segment past the first —
 *  "the segment right after X" means the nearest previous sibling that is
 *  NOT a separator. */
const prevSegment = (el: HTMLElement): HTMLElement | null => {
  let p = el.previousElementSibling as HTMLElement | null;
  while (p !== null && p.classList.contains("sep")) p = p.previousElementSibling as HTMLElement | null;
  return p;
};

/** Its forward twin: the nearest FOLLOWING sibling that is a real segment. */
const nextSegment = (el: HTMLElement): HTMLElement | null => {
  let p = el.nextElementSibling as HTMLElement | null;
  while (p !== null && p.classList.contains("sep")) p = p.nextElementSibling as HTMLElement | null;
  return p;
};

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

describe("ω99-253 R3 — StatusBar 分支 chip（buddy/advanced 同挂）", () => {
  it("buddy：chip 挂工作区段之后——锚后一枚小 chip，分支名原样", () => {
    const c = mount(
      <StatusBar status={baseStatus({ gitBranch: "main" })} buddy={true} workspaceName="proj-x" workspacePath="/Users/u/work/proj-x" />,
    );
    const bar = c.querySelector(".statusline") as HTMLElement;
    expect(bar).not.toBeNull();
    // 锚仍是第一个孩子（224 语义），chip 紧跟锚（跳过分隔符——分支是
    // 工作区的属性，视觉上与锚合一）。
    expect(bar.firstElementChild?.textContent).toBe("工作区 proj-x");
    const chip = c.querySelector(".statusline .seg-branch") as HTMLElement;
    expect(chip).not.toBeNull();
    expect(prevSegment(chip)?.textContent).toBe("工作区 proj-x");
    expect(chip.textContent).toBe("main");
    expect(chip.getAttribute("title")).toBe("当前工作分支");
  });

  it("advanced：同一条信息同挂——chip 挂 head 段之后（两模式裁定钉）", () => {
    const c = mount(<StatusBar status={baseStatus({ gitBranch: "feat/merge-conflicts" })} />);
    const bar = c.querySelector(".statusline") as HTMLElement;
    expect(bar).not.toBeNull();
    // head 是裸文本段（无 span），位置钉走条序：head → 分隔符 → chip。
    expect(bar.textContent?.startsWith("wudao · wudao-te │ feat/merge-conflicts")).toBe(true);
    const chip = c.querySelector(".statusline .seg-branch") as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toBe("feat/merge-conflicts");
  });

  it("detached：'HEAD' 原样显示——诚实，不改写成猜测", () => {
    const c = mount(
      <StatusBar status={baseStatus({ gitBranch: "HEAD" })} buddy={true} workspaceName="proj-x" workspacePath="/w/p" />,
    );
    const chip = c.querySelector(".statusline .seg-branch") as HTMLElement;
    expect(chip.textContent).toBe("HEAD");
  });

  it("null（非仓库/读失败）：chip 零渲染零占位——无悬空分隔符，锚领衔不动", () => {
    const c = mount(
      <StatusBar
        status={baseStatus({ gitBranch: null, boardProgress: { done: 3, total: 5 } })}
        buddy={true}
        workspaceName="proj-x"
        workspacePath="/w/p"
      />,
    );
    const bar = c.querySelector(".statusline") as HTMLElement;
    expect(c.querySelector(".seg-branch")).toBeNull();
    expect(bar.firstElementChild?.textContent).toBe("工作区 proj-x");
    expect(bar.firstElementChild?.classList.contains("sep")).toBe(false); // 首位非分隔符（224 §5 钉法）
    // 锚后的下一个真段是 ▣——chip 缺席不扰动段链（无悬空分隔符）。
    // 116 弧 C：▣ → list-checks 细线字形（svg 在位，文本只余 3/5）
    expect(nextSegment(bar.firstElementChild as HTMLElement)?.textContent).toContain("3/5");
    expect((nextSegment(bar.firstElementChild as HTMLElement) as HTMLElement).querySelector("svg")).not.toBeNull();
  });

  it("老 server 无字段：安静（零渲染零报错）——可选字段的 quiet degradation", () => {
    const c = mount(
      <StatusBar status={baseStatus()} buddy={true} workspaceName="proj-x" workspacePath="/w/p" />,
    );
    expect(c.querySelector(".seg-branch")).toBeNull();
    const advanced = mount(<StatusBar status={baseStatus()} />);
    expect(advanced.querySelector(".seg-branch")).toBeNull();
    // 其余段照常——分支缺席不扰动段链。
    expect(advanced.querySelector(".statusline")).not.toBeNull();
    expect(advanced.textContent).toContain("wudao · wudao-te");
  });

  it("空串同 null：绝不把空串渲染成空 chip", () => {
    const c = mount(
      <StatusBar status={baseStatus({ gitBranch: "" })} buddy={true} workspaceName="proj-x" workspacePath="/w/p" />,
    );
    expect(c.querySelector(".seg-branch")).toBeNull();
  });

  it("裁定钉：buddy 面 chip 是锚的属性——锚缺席时 chip 随锚一起等（不悬空领衔）", () => {
    // workspaceName 缺席（连接期 agentRootStatus 未解析）：chip 不单独浮空
    // 领衔段链——分支是工作区的一个属性，属性不先于主体出现。
    const c = mount(<StatusBar status={baseStatus({ gitBranch: "main" })} buddy={true} />);
    expect(c.querySelector(".seg-branch")).toBeNull();
    // advanced 面无此耦合（head 恒在场，chip 恒可挂）。
    const adv = mount(<StatusBar status={baseStatus({ gitBranch: "main" })} />);
    expect(adv.querySelector(".seg-branch")).not.toBeNull();
  });
});

describe("ω99-253 R4 — 邻接零演进（224 锚 / 249 goal / 216 改动共存）", () => {
  it("224 工作区锚语义零演进：chip 在场时锚仍领衔、段链形状不扰", () => {
    const c = mount(
      <StatusBar
        status={baseStatus({ gitBranch: "main", boardProgress: { done: 3, total: 5 } })}
        buddy={true}
        workspaceName="proj-x"
        workspacePath="/Users/u/work/proj-x"
      />,
    );
    const bar = c.querySelector(".statusline") as HTMLElement;
    expect(bar.firstElementChild?.textContent).toBe("工作区 proj-x"); // 锚领衔钉
    expect(bar.textContent).toContain("3/5"); // 116 弧 C：▣ → list-checks 字形，既有段照常
    expect(bar.textContent).toContain("main");
  });

  it("249 goal 行共存：goal 段与分支 chip 各自恰一次渲染（advanced 同挂面）", () => {
    const status = baseStatus({
      gitBranch: "main",
      goal: {
        objective: "完成认证模块并全部测试通过",
        status: "active",
        usedTokens: 4300,
        inputTokens: 4000,
        outputTokens: 300,
        budgetTokens: 5000,
        missionTaskId: "t2",
        progress: { done: 2, total: 5 },
      },
    });
    const c = mount(<StatusBar status={status} />);
    expect(c.querySelectorAll(".seg-branch")).toHaveLength(1);
    expect(c.querySelectorAll(".seg-goal")).toHaveLength(1);
    expect(c.querySelector(".seg-goal")?.textContent).toContain("目标");
  });

  it("buddy 面 goal 不渲染（224 裁定原样），分支 chip 照挂", () => {
    const status = baseStatus({
      gitBranch: "main",
      goal: {
        objective: "o",
        status: "active",
        usedTokens: 10,
        inputTokens: 8,
        outputTokens: 2,
        missionTaskId: "t1",
        progress: { done: 0, total: 1 },
      },
    });
    const c = mount(<StatusBar status={status} buddy={true} workspaceName="p" workspacePath="/w/p" />);
    expect(c.querySelectorAll(".seg-branch")).toHaveLength(1);
    expect(c.querySelector(".seg-goal")).toBeNull(); // buddy 无 goal 段（249 既有裁定零演进）
  });

  it("216 改动 chip 共存（App 面）：分支 chip + goal 行 + 「改动 N 文件」各自在场", async () => {
    const server = fakeServer();
    const client = new WudaoClient({
      url: "ws://127.0.0.1:1",
      token: "t",
      wsFactory: () => server.spawn(),
      reconnect: false,
    });
    const container = mount(<App client={client} />);
    await act(async () => {
      client.connect();
      server.socket.serverOpen();
      authOk(
        server.socket,
        {
          gitBranch: "omega99-253",
          goal: {
            objective: "分支指示面",
            status: "active",
            usedTokens: 4300,
            inputTokens: 4000,
            outputTokens: 300,
            budgetTokens: 5000,
            missionTaskId: "t2",
            progress: { done: 2, total: 5 },
          },
        },
        [
          {
            kind: "notice",
            text: "改动 2 文件",
            changes: [
              { path: "a.ts", op: "modify", writes: 2 },
              { path: "b.ts", op: "create", writes: 1 },
            ],
          },
        ],
      );
    });
    await until(() => container.querySelector(".statusline .seg-branch") !== null, "branch chip to land");
    // 三面共存，各自恰一次：分支 chip / goal 行 / 216 改动 chip。
    expect(container.querySelectorAll(".statusline .seg-branch")).toHaveLength(1);
    expect((container.querySelector(".statusline .seg-branch") as HTMLElement).textContent).toBe("omega99-253");
    expect(container.querySelectorAll(".statusline .seg-goal")).toHaveLength(1);
    const chg = container.querySelector(".tb-changes") as HTMLElement;
    expect(chg?.textContent).toBe("改动 2 文件");
    act(() => {
      client.close();
    });
  });
});
