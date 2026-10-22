// @vitest-environment jsdom
// 终端式布局契约（用户契约 2026-08-27）：页面永不滚动 + 会话流终端式滚动
// （能滚、无滚动条）。三个钉子：
// 1. CSS：html/body overflow hidden —— 页面级铁律。任何状态都不许买来整页
//    滚动条；滚动只发生在各自的滚动容器里（.chat / .set-body / 卡片内部）。
//    复现实证：真 WebKit（桌面壳引擎）里一张长权限卡把页面顶出了滚动条
//    （.approval 无视口帽，stash-repro 探针 pageScrolls:true），修复后双引擎
//    ×双窗口高度全 false。
// 2. CSS：简洁模式会话流 scrollbar-width:none + WKWebView 的
//    ::-webkit-scrollbar 覆盖（引擎不吃标准属性；jsdom 的 CSSOM 会丢厂商
//    伪元素规则，所以这条钉原文）。
// 3. DOM：长权限卡被帽住 —— 文字墙进 .ap-scroll（内滚），pill 按钮和接管
//    回执留在滚动区外（.permission-card .pc-scroll 的同款契约），按钮永远
//    够得着。
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { stylesCss } from "./styles-source.js";
import "../src/styles.css";
import { App } from "../src/components/App.js";
import { WudaoClient } from "../src/protocol.js";
import { authOk, fakeServer } from "./mock-ws.js";
import { decl, mount, unmount } from "./css-test-utils.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  unmount();
  window.localStorage.removeItem("wudao.ui.v1");
});

describe("终端式布局 — 页面永不滚动（CSS 契约）", () => {
  it("html/body overflow hidden：滚动只属于滚动容器，页面本身永远滚不动", () => {
    expect(decl("html, body", "overflow")).toBe("hidden");
  });

  it("会话流可滚但无滚动条：scrollbar-width:none + WKWebView 伪元素覆盖", () => {
    expect(decl(".simple .chat", "scrollbar-width")).toBe("none");
    // jsdom 的 CSSOM 会丢厂商伪元素规则 —— 钉原文（桌面壳 WKWebView 需要）。
    expect(stylesCss).toContain(".simple .chat::-webkit-scrollbar { display: none; }");
  });

  it("权限卡有视口帽 + 内部滚动区：max-height 帽住卡片，.ap-scroll 吃溢出", () => {
    expect(decl(".approval", "max-height")).toBe("calc(100% - 3.5rem)");
    expect(decl(".approval", "overflow")).toBe("hidden");
    expect(decl(".approval .ap-scroll", "overflow-y")).toBe("auto");
  });
});

describe("终端式布局 — 长权限卡的 DOM 契约", () => {
  interface Harness {
    container: HTMLElement;
    server: ReturnType<typeof fakeServer>;
  }
  function sendState(h: Harness, overrides: Record<string, unknown>): void {
    h.server.socket.serverSend({
      t: "state",
      state: {
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
        ...overrides,
      },
    });
  }

  /** Boot the App connected and flipped into 简洁模式 (the persisted
   *  preference path — the shell the contract is about). */
  async function mountedSimpleApp(): Promise<Harness> {
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
    await act(async () => {
      authOk(server.socket);
    });
    const op = server.clientFrames().find((f): f is { id: number; op: { op: string } } =>
      typeof f === "object" && f !== null && "op" in f && (f as { op: { op: string } }).op.op === "settingsStatus");
    await act(async () => {
      server.socket.serverSend({ t: "result", id: op?.id, ok: { settings: { memoryEnabled: true, uiDefaultMode: "simple" } } });
    });
    expect(container.querySelector(".simple")).not.toBeNull(); // 简洁面已上屏
    return { container, server };
  }

  it("长 ask 被帽住：文字墙在 .ap-scroll 里滚，strip/按钮/回执在滚动区外", async () => {
    const h = await mountedSimpleApp();
    await act(async () => {
      sendState(h, {
        busy: true,
        pendingPermission: {
          toolName: "bash",
          summary: "需要先重写配置与入口模块再跑验证。".repeat(60),
          input: { command: "pnpm --filter @wudao/web exec vitest run " + "case-1234567890 ".repeat(40) },
          warning: "该命令将写入工作区并修改 git 状态；".repeat(40),
          sidecar: "写操作会修改工作区文件，请确认内容。",
        },
      });
    });
    const card = h.container.querySelector(".approval") as HTMLElement;
    expect(card).not.toBeNull();
    const scroll = card.querySelector(".ap-scroll") as HTMLElement;
    expect(scroll).not.toBeNull();
    // 文字墙（理由 + 警告 + 命令）都在滚动区里 —— 溢出走内滚，不顶页面。
    expect(scroll.querySelector(".why")).not.toBeNull();
    expect(scroll.querySelector(".warn")).not.toBeNull();
    expect(scroll.querySelector(".cmd")).not.toBeNull();
    // strip 帽在滚动区上方（琥珀标题不跟着墙滚走）。
    const strip = card.querySelector(".strip") as HTMLElement;
    expect(strip.parentElement).toBe(card);
    // 按钮在滚动区外 —— 墙再长也够得着（.pc-scroll 同款契约）。
    const btns = card.querySelector(".btns") as HTMLElement;
    expect(btns.parentElement).toBe(card);
    expect(scroll.contains(btns)).toBe(false);
    // 接管回执仍在卡下方（输入位的回执契约不变）。
    expect(h.container.querySelector(".approval-note")).not.toBeNull();
  });
});
