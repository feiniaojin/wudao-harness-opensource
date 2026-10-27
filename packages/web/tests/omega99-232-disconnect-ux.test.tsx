// ω99-232: #R1 — 断线 UX：gave-up 终态的形态诚实处方（三面逐字钉）。
// 09-09 真报障：桌面形态用户没有 `wudao ui`——旧 gave-up 横幅教一条用户无法
// 执行的 CLI 命令；closed/connecting 卡同病（sidecar 实现术语）。本件钉：
//   gave-up    8 次事实（MAX_RECONNECT_ATTEMPTS 同源插值——测试侧也同源插值，
//              src 硬编码字面即红）+ 双形态出路 + 旧地址失效点名 + 重连按钮
//              仍接 client.reconnect()（mock 断言调用）；
//   closed     标题与「刷新页面重连」按钮保留 + 新出路句逐字 + close token；
//   connecting 新句逐字（去实现术语）；
//   不回归     reconnecting 横幅 close token + 自动回放提示 + `(第 2/8 次)` 计数；
//   黑名单     三面新文案零 sidecar / server / `wudao ui`（user-facing copy =
//              benefits 规矩；`wudao ui · <state>` 与 `close <code>` 是状态
//              token，不在此列）。
// 纯呈现层弧：protocol.ts 状态机零动（重连梯子/终态转移在 protocol.test.ts 钉）。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/components/App.js";
import { WudaoClient, MAX_RECONNECT_ATTEMPTS } from "../src/protocol.js";
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

/** The reconnect-cap drive (components.test 的既证形): 手动计时器 + 逐次
 *  close——每次计时器点火拨一只新 socket，再异常 close 推一格，第
 *  MAX_RECONNECT_ATTEMPTS 次重连失败后落 gave-up。 */
function cappedClient(server: FakeServer): { client: WudaoClient; timers: ((() => void) | undefined)[] } {
  const timers: ((() => void) | undefined)[] = [];
  const client = new WudaoClient({
    url: "ws://127.0.0.1:1",
    token: "t",
    wsFactory: () => server.spawn(),
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length - 1;
    },
    clearTimeout: (h) => {
      if (typeof h === "number") timers[h] = undefined;
    },
  });
  return { client, timers };
}

describe("ω99-232 断线 UX — gave-up 终态的形态诚实处方", () => {
  it("gave-up 横幅：8 次事实（同源插值）+ 双形态出路 + 旧地址失效点名；重连按钮仍接 client.reconnect()", async () => {
    const server = fakeServer();
    const { client, timers } = cappedClient(server);
    const container = mount(<App client={client} />);
    act(() => {
      client.connect();
      server.socket.serverOpen();
    });
    await act(async () => {
      authOk(server.socket, {}, [{ kind: "user", text: "kept" }]);
    });
    // 9 次异常 close: 8 次重连（计时器点火→新 socket→再 close）后落终态。
    act(() => {
      for (let i = 0; i < 9; i++) {
        server.socket.serverClose(1006, "");
        if (client.getSnapshot().connection !== "reconnecting") break; // gave-up tripped
        timers[timers.length - 1]?.();
      }
    });
    expect(client.getSnapshot().connection).toBe("gave-up");
    const banner = container.querySelector(".banner[role='alert']") as HTMLElement;
    expect(banner).not.toBeNull();
    // 逐字钉（测试侧同源插值：src 若硬编码「8」字面，改常量时此处即红）。
    expect(MAX_RECONNECT_ATTEMPTS).toBe(8); // 终态形状锚：横幅次数与梯子帽同源
    expect(banner.textContent).toContain(
      `连接已断开 — 已连续重连 ${MAX_RECONNECT_ATTEMPTS} 次未成功。在 wudao 桌面应用窗口里遇到时，重启应用即可；在浏览器标签里，请从 wudao 桌面应用重新打开会话（这个旧页面的地址可能已失效）。`,
    );
    // 黑名单：旧 CLI 处方与实现术语零残留（横幅面无状态 token，三词全禁）。
    expect(banner.textContent).not.toContain("server");
    expect(banner.textContent).not.toContain("wudao ui");
    expect(banner.textContent).not.toContain("sidecar");
    // 重连按钮接线零动：点击 → client.reconnect()（mock 断言调用一次）。
    const reconnectSpy = vi.spyOn(client, "reconnect");
    await act(async () => {
      (banner.querySelector("button") as HTMLButtonElement).click();
    });
    expect(reconnectSpy).toHaveBeenCalledTimes(1);
  });

  it("reconnecting 横幅不回归：close token + 自动回放提示 + `(第 2/8 次)` 计数", async () => {
    const server = fakeServer();
    const { client, timers } = cappedClient(server);
    const container = mount(<App client={client} />);
    act(() => {
      client.connect();
      server.socket.serverOpen();
    });
    await act(async () => {
      authOk(server.socket);
    });
    act(() => {
      server.socket.serverClose(1006, "");
    });
    // 第 1 次重连：quiet 横幅（计数自第 2 次起显示）+ 自动回放承诺。
    expect(container.textContent).toContain("连接断开(close 1006) — 正在重连");
    expect(container.textContent).toContain("重连后自动回放历史");
    act(() => {
      timers[timers.length - 1]?.(); // 点火 → 拨一只新 socket……
      server.socket.serverClose(1006, ""); // ……新 socket 也死 → 第 2 次重连
    });
    expect(container.textContent).toContain(`(第 2/${MAX_RECONNECT_ATTEMPTS} 次)`);
    expect(container.textContent).toContain("连接断开(close 1006) — 正在重连");
  });

  it("closed 卡：标题与「刷新页面重连」按钮保留 + 新出路句逐字 + close token", () => {
    const server = fakeServer();
    const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
    const container = mount(<App client={client} />);
    act(() => {
      client.connect();
      server.socket.serverOpen();
    });
    act(() => {
      server.socket.serverClose(1006, "");
    });
    expect(client.getSnapshot().connection).toBe("closed");
    const card = container.querySelector(".connect-card") as HTMLElement;
    expect(card.textContent).toContain("连接已断开"); // 标题保留（state-cover 同钉）
    const btn = [...card.querySelectorAll("button")].find((b) => b.textContent === "刷新页面重连");
    expect(btn).toBeDefined(); // 按钮保留（state-cover 同钉）
    // 加行出路句逐字（scoped 到 .connect-msg——meta 行的 `wudao ui ·` 是状态 token 不在此列）。
    const msg = card.querySelector(".connect-msg") as HTMLElement | null;
    if (msg === null) throw new Error("connect-msg missing");
    expect(msg.textContent).toBe("若刷新后仍连不上，请从 wudao 桌面应用重新打开会话（旧地址可能已失效）。");
    expect(msg.textContent).not.toContain("sidecar");
    expect(msg.textContent).not.toContain("server");
    // close code token 保留（ui-review-r4 P1 的中文一致性 + token 纪律）。
    expect(card.querySelector(".connect-meta")?.textContent).toBe("wudao ui · closed · close 1006");
  });

  it("connecting 卡：新句逐字（去实现术语），标题与 meta token 保留", () => {
    const server = fakeServer();
    const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
    const container = mount(<App client={client} />); // 未 connect——初始 connecting
    const card = container.querySelector(".connect-card") as HTMLElement;
    const msg = card.querySelector(".connect-msg") as HTMLElement | null;
    if (msg === null) throw new Error("connect-msg missing");
    expect(msg.textContent).toBe("若长时间停留在此，请重新打开 wudao 桌面应用。");
    expect(msg.textContent).not.toContain("sidecar"); // 旧句「检查 wudao 服务（sidecar）是否已启动」退役
    expect(msg.textContent).not.toContain("server");
    expect(card.textContent).toContain("正在连接 wudao 服务…"); // 标题保留（state-cover 同钉）
    expect(card.querySelector(".connect-meta")?.textContent).toBe("wudao ui · connecting"); // token 保留
  });
});
