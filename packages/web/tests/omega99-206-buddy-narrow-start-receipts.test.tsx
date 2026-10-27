// @vitest-environment jsdom
// ω99-206 receipts — buddy 窄窗起跑收紧：saved 展开态在 <700px 起始窗不再
// 复原挤压性展开（对齐左栏 hydrate re-clamp 哲学——存后更窄的窗不复原挤压
// 性布局；saved=true 手动收起任何窗宽都尊重，resize 下行唯一规则与「窄窗
// 手动再展开成立」零触）。五情形（语义表全判）：①修复面 saved=false+<700px
// 起跑→收起（改前红）；②saved=false+≥700px→展开（尊重面防回归）；③
// saved=true+≥700px→收起（尊重面）；④无 saved+<700px→收起（既有 fallback
// 不变）；⑤窄窗收起后 ▸ 手动展开→展开态（toggle 行为面）。锚=.buddy-toggle
// 的 aria-label（展开会话列表=收起态 / 折叠会话列表=展开态）；范式=
// Object.defineProperty stub window.innerWidth（ide-layout 同款）+ 预置
// wudao.ui.v1 savedLayout（readPersistedLayout 的 key/shape 亲核：任意畸形
// 读 {} 的容错 lane 不在本弧域）+ App mount harness（buddy-mode mountedApp
// 同法：buddy 分支在 settingsStatus 回复后渲染，而 buddyCollapsed 初始化器
// 在首渲染即跑——stub 与 localStorage 都必须先于 mount 就位）。
import { afterEach, describe, expect, it } from "vitest";
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

// jsdom 的 window 是文件级单例（ide-layout 注释亲证）：逐 it 设定、afterEach
// 还原 1024，杜绝跨用例渗漏。
const setWidth = (w: number): void => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
};

// 只写 buddyCollapsed 一键（Partial<PersistedLayout> 合法面）：其余键缺席走
// 各自默认初始化器，不夹带无关面。
const setSaved = (buddyCollapsed: boolean): void => {
  window.localStorage.setItem("wudao.ui.v1", JSON.stringify({ buddyCollapsed }));
};

interface AppHarness {
  container: HTMLElement;
  client: WudaoClient;
  server: FakeServer;
}

type OpFrame = { id: number; op: Record<string, unknown> };

/** The buddy-mode mountedApp verbatim: connect → authOk → settingsStatus
 *  replies ui.defaultMode=buddy, so the buddy grid (and its toggle) mounts. */
async function mountedBuddyApp(): Promise<AppHarness> {
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
  const opFrames = (): OpFrame[] =>
    server.clientFrames().filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f);
  await act(async () => {
    authOk(server.socket);
  });
  await act(async () => {
    const op = opFrames().find((o) => o.op.op === "settingsStatus");
    server.socket.serverSend({
      t: "result",
      id: op?.id,
      ok: { settings: { memoryEnabled: true, uiDefaultMode: "buddy" } },
    });
  });
  return { container, client, server };
}

// 状态锚：toggle 的 aria-label（收起态=展开会话列表/▸；展开态=折叠会话列表/◂）。
const toggleLabel = (h: AppHarness): string | null =>
  h.container.querySelector<HTMLButtonElement>(".buddy-toggle")?.getAttribute("aria-label") ?? null;
const toggleGlyph = (h: AppHarness): string | null =>
  h.container.querySelector<HTMLButtonElement>(".buddy-toggle")?.textContent ?? null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  window.localStorage.removeItem("wudao.ui.v1"); // ui-review-r3 P2: reset the persisted layout between tests
  setWidth(1024);
});

describe("ω99-206 — buddy 窄窗起跑收紧 receipts", () => {
  it("① 修复面：saved=false + <700px 起跑 → 收起态（存档展开不复原挤压主内容——re-clamp 哲学）", async () => {
    setWidth(600);
    setSaved(false);
    const h = await mountedBuddyApp();
    expect(toggleLabel(h)).toBe("展开会话列表"); // 收起态
    expect(toggleGlyph(h)).toBe("▸");
  });

  it("② 尊重面：saved=false + ≥700px 起跑 → 展开态（宽窗存的展开照常复原）", async () => {
    setWidth(1024);
    setSaved(false);
    const h = await mountedBuddyApp();
    expect(toggleLabel(h)).toBe("折叠会话列表"); // 展开态
    expect(toggleGlyph(h)).toBe("◂");
  });

  it("③ 尊重面：saved=true + ≥700px 起跑 → 收起态（手动收起任何窗宽都尊重）", async () => {
    setWidth(1024);
    setSaved(true);
    const h = await mountedBuddyApp();
    expect(toggleLabel(h)).toBe("展开会话列表");
    expect(toggleGlyph(h)).toBe("▸");
  });

  it("④ 既有 fallback：无 saved + <700px 起跑 → 收起态（无存档走窄窗默认，不变）", async () => {
    setWidth(600);
    const h = await mountedBuddyApp();
    expect(toggleLabel(h)).toBe("展开会话列表");
    expect(toggleGlyph(h)).toBe("▸");
  });

  it("⑤ 手动再展开成立：窄窗收起后（saved=true）▸ 点击 → 展开态（下行唯一规则零触——toggle 行为面）", async () => {
    setWidth(600);
    setSaved(true);
    const h = await mountedBuddyApp();
    expect(toggleLabel(h)).toBe("展开会话列表"); // 起跑收起（saved=true 任何窗宽）
    await act(async () => {
      (h.container.querySelector(".buddy-toggle") as HTMLButtonElement).click();
    });
    expect(toggleLabel(h)).toBe("折叠会话列表"); // 手动再展开成立
    expect((h.container.querySelector(".buddy") as HTMLElement).style.getPropertyValue("--buddy-w")).toBe("260px");
  });
});
