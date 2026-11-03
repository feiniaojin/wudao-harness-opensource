// @vitest-environment jsdom
// ω99-307 — #457：Buddy 模式工作区切换缺口。用户报「buddy模式，不能切换
// 工作空间了吗？」——根因（系统性调试 Phase 1 定谳，非回归）：工作区切换
// 只有两个家——极简 composer 的 LEAD 槽 WorkspaceChip（bd688ef8 接线）与
// 高级模式 FileTree 树顶切换器（c2a62fc8）；Buddy 按 M78-buddy §3 丢掉 IDE
// 面板，而它共享的 chatColumn InputBox（App.tsx:3300-3344）从未接过
// controlsLead（git log -S 空=从未存在），StatusBar buddy 工作区段又是纯
// span（ω99-224）→ Buddy 三面皆无入口。修法：chatColumn InputBox 以
// uiMode==="buddy" 门控传 controlsLead（极简同款 WorkspaceChip 惯用法，
// onPick/onOpenOther 复用 App 级 switchPanelRoot/onOpenOtherWorkspace 既有
// 缝）；高级面字节不变——树顶切换器是它唯一的家（ω99-298 单一交互家纪律）。
// 断路器（B3 agent-root 语义）随弧自带：pick 只动面板根，AgentRootCard 在
// 同一列内升起问 agent 是否跟随——本件第 2 测整链钉死。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WudaoClient } from "../src/protocol.js";
import { App } from "../src/components/App.js";
import { authOk, fakeServer } from "./mock-ws.js";
import type { FakeServer } from "./mock-ws.js";

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
  window.localStorage.removeItem("wudao.ui.v1");
});

interface AppHarness {
  container: HTMLElement;
  client: WudaoClient;
  server: FakeServer;
}

function mountedApp(): AppHarness {
  const server = fakeServer();
  const client = new WudaoClient({
    url: "ws://127.0.0.1:1",
    token: "t",
    wsFactory: () => server.spawn(),
    reconnect: false,
  });
  const container = mount(<App client={client} />);
  act(() => {
    client.connect();
    server.socket.serverOpen();
  });
  return { container, client, server };
}

type OpFrame = { id: number; op: Record<string, unknown> };
const opFrames = (h: AppHarness): OpFrame[] =>
  h.server.clientFrames().filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f);

/** The connect-time agentRootStatus resolve (the panel-root truth) + the
 * settings pick that lands the shell in the wanted mode. */
async function landMode(
  h: AppHarness,
  uiDefaultMode: "simple" | "buddy" | "advanced",
): Promise<void> {
  await act(async () => {
    authOk(h.server.socket);
  });
  await act(async () => {
    const op = opFrames(h).find((o) => o.op.op === "agentRootStatus");
    h.server.socket.serverSend({
      t: "result",
      id: op?.id,
      ok: { panelRoot: "/Users/u/work/proj-x", agentRoot: "/Users/u/work/proj-x", aligned: true },
    });
  });
  await act(async () => {
    const op = opFrames(h).find((o) => o.op.op === "settingsStatus");
    h.server.socket.serverSend({
      t: "result",
      id: op?.id,
      ok: { settings: { memoryEnabled: true, uiDefaultMode } },
    });
  });
}

describe("ω99-307 — Buddy 模式 composer 的工作区 chip（#457）", () => {
  it("buddy 的 composer 控件行渲染 WorkspaceChip（LEAD 槽首位；标签=面板根 basename；title=全路径）", async () => {
    const h = mountedApp();
    await landMode(h, "buddy");
    const chip = h.container.querySelector(".buddy .composer-tools .chip.work") as HTMLButtonElement | null;
    expect(chip).not.toBeNull(); // 入口在场——本弧的全部意义（修前恒 null）
    expect(chip?.disabled).toBe(false); // 已连接态可点
    expect(chip?.textContent).toContain("proj-x"); // 标签跟面板根
    expect(chip?.getAttribute("title")).toBe("/Users/u/work/proj-x"); // title=全路径
    // LEAD 槽首位纪律（极简同款）：chip 的包裹容器是 .composer-tools 的
    // 第一个孩子（WorkspaceChip 自带 .ws-chip-wrap 包一层，早于 📎 chip）。
    const tools = h.container.querySelector(".buddy .composer-tools");
    expect(tools?.firstElementChild).toBe(chip?.closest(".ws-chip-wrap"));
  });

  it("点开菜单选最近工作区 → panelRootSet 出线 → 回执 + AgentRootCard 在同一列内升起（B3 断路器随弧自带）", async () => {
    const h = mountedApp();
    await landMode(h, "buddy");
    await act(async () => {
      (h.container.querySelector(".buddy .composer-tools .chip.work") as HTMLButtonElement).click();
    });
    // 菜单开 → recents 取数出线（useRecentWorkspaces：开才取，mount 不取）。
    await act(async () => {
      const op = opFrames(h).find((o) => o.op.op === "recentWorkspaces");
      h.server.socket.serverSend({
        t: "result",
        id: op?.id,
        ok: { workspaces: [{ path: "/Users/u/work/proj-y", mtime: Date.now() - 60_000 }] },
      });
    });
    const item = h.container.querySelector(".ws-menu .ws-item:not(.ws-open-other)") as HTMLButtonElement | null;
    expect(item?.textContent).toContain("proj-y");
    await act(async () => {
      item?.click();
    });
    // pick 骑的正是 App 级 switchPanelRoot 缝：panelRootSet 出线，路径如实。
    const switchOp = opFrames(h).find((o) => o.op.op === "panelRootSet");
    expect(switchOp?.op).toMatchObject({ path: "/Users/u/work/proj-y" });
    await act(async () => {
      h.server.socket.serverSend({ t: "result", id: switchOp?.id, ok: { root: "/Users/u/work/proj-y" } });
    });
    // 137：一次点击两个根一起动——agentRootSwitch 跟在 panelRootSet 后出线
    //（第二跳；panel 回执后才发，需再排一轮）。回执后 chip 标签随新根。
    let agentOp = opFrames(h).find((o) => o.op.op === "agentRootSwitch");
    await act(async () => {
      if (agentOp === undefined) return;
      h.server.socket.serverSend({ t: "result", id: agentOp.id, ok: { applied: true, queued: false } });
    });
    if (agentOp === undefined) {
      // 上一轮 act 内才发出——再排一轮拿到帧并应答。
      await act(async () => {
        agentOp = opFrames(h).find((o) => o.op.op === "agentRootSwitch");
        h.server.socket.serverSend({ t: "result", id: agentOp?.id, ok: { applied: true, queued: false } });
      });
    }
    expect(agentOp?.op).toMatchObject({ path: "/Users/u/work/proj-y" });
    expect(h.container.textContent).toContain("工作区已切换（agent 工作目录已跟随）→ /Users/u/work/proj-y");
    expect(
      (h.container.querySelector(".buddy .composer-tools .chip.work") as HTMLButtonElement | null)?.textContent,
    ).toContain("proj-y");
    // B3 确认卡退役：任何分支都不再升起。
    expect(h.container.querySelector(".approval.agent-root")).toBeNull();
  });

  it("高级面 composer 不渲染该 chip（树顶切换器是唯一家——ω99-298 单一交互家纪律）", async () => {
    const h = mountedApp();
    await landMode(h, "advanced");
    expect(h.container.querySelector(".composer-tools .chip.work")).toBeNull(); // 修前修后皆无——钉住不增第二家
    expect(h.container.querySelector(".buddy")).toBeNull(); // 高级面在场的旁证
  });
});
