// @vitest-environment jsdom
// guided-install 弧 — PluginTab 的「从来源安装」段（jsdom）：
// 输入 spec → 预览（pluginInstallSpec preview:true → 预览卡渲染名称/格式/
// 将映射）→ 安装（preview:false → 回执 + 列表刷新）；纯代码包拒绝文案直达。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PluginTab } from "../src/components/PluginTab.js";
import type { WudaoClient, PluginSpecInstallResult, PluginListResult, PluginMarketListResult } from "../src/protocol.js";

function fakeClient(overrides: Partial<Record<"pluginInstallSpec", (spec: string, preview?: boolean) => Promise<PluginSpecInstallResult>>> & Record<string, unknown>): WudaoClient {
  return {
    pluginList: vi.fn().mockResolvedValue({ installed: [] } satisfies Partial<PluginListResult>),
    pluginMarketList: vi.fn().mockResolvedValue({ marketplaces: [] } satisfies Partial<PluginMarketListResult>),
    ...overrides,
  } as unknown as WudaoClient;
}

function mount(client: WudaoClient): { container: HTMLElement; root: Root } {
  const container = document.createElement("div");
  const root = createRoot(container);
  root.render(createElement(PluginTab, { client, settings: null, notify: () => {}, refresh: () => {} } as never));
  return { container, root };
}

const flush = async (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** React 受控输入的 jsdom 正道：原生 value setter + change 事件（React
 *  覆盖了 el.value 的 setter，直赋值不进 state）。 */
function setInput(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  if (setter === undefined) throw new Error("no native value setter");
  setter.call(el, value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("PluginTab: 从来源安装（guided-install）", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("预览流：preview:true 调用 → 预览卡出现（名称·格式·将映射），未调安装", async () => {
    const spec = vi.fn().mockResolvedValue({
      preview: true, name: "acme-git-pkg", format: "ccb-family",
      detail: { skills: 3, commands: 0, agents: 0, hooks: 0, mcp: 0 }, warnings: [],
    } satisfies PluginSpecInstallResult);
    const client = fakeClient({ pluginInstallSpec: spec });
    const { container } = mount(client);
    await flush(); await flush();
    const input = container.querySelector<HTMLInputElement>(".plugin-spec-input");
    expect(input).not.toBeNull();
    setInput(input!, "acme/plugin");
    await flush();
    (container.querySelector("[data-plugin-spec-install] .keyrow button") as HTMLButtonElement).click();
    await flush(); await flush();
    expect(spec).toHaveBeenCalledWith("acme/plugin", true);
    const card = container.querySelector("[data-plugin-spec-preview]");
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain("acme-git-pkg");
    expect(card!.textContent).toContain("上游包格式");
    expect(card!.textContent).toContain("技能 3");
  });

  it("安装流：预览卡「安装」→ preview:false 调用 → 回执后卡与输入清空", async () => {
    const spec = vi.fn()
      .mockResolvedValueOnce({ preview: true, name: "p", detail: { skills: 1, commands: 0, agents: 0, hooks: 0, mcp: 0 }, warnings: [] } satisfies PluginSpecInstallResult)
      .mockResolvedValueOnce({ preview: false, name: "p", dir: "/ws/.wudao/plugins/p", detail: { skills: 1, commands: 0, agents: 0, hooks: 0, mcp: 0 }, warnings: [] } satisfies PluginSpecInstallResult);
    const client = fakeClient({ pluginInstallSpec: spec });
    const { container } = mount(client);
    await flush(); await flush();
    const input = container.querySelector<HTMLInputElement>(".plugin-spec-input")!;
    setInput(input, "acme/plugin");
    await flush();
    (container.querySelector("[data-plugin-spec-install] .keyrow button") as HTMLButtonElement).click();
    await flush(); await flush();
    const card = container.querySelector("[data-plugin-spec-preview]")!;
    (card.querySelector("button") as HTMLButtonElement).click(); // 安装（第一颗钮）
    await flush(); await flush();
    expect(spec).toHaveBeenLastCalledWith("acme/plugin", false);
    expect(container.querySelector("[data-plugin-spec-preview]")).toBeNull();
    expect((container.querySelector(".plugin-spec-input") as HTMLInputElement).value).toBe("");
  });

  it("拒绝文案直达：引擎错误（零资产纯代码包）以警告 notify 呈现，无预览卡", async () => {
    const spec = vi.fn().mockRejectedValue(new Error('"acme/code" declares runtime code (dsh bundle/client) but carries no static assets — Nothing was installed.'));
    const notified: string[] = [];
    const client = fakeClient({ pluginInstallSpec: spec });
    const container = document.createElement("div");
    const root = createRoot(container);
    root.render(createElement(PluginTab, { client, settings: null, notify: (m: string) => notified.push(m), refresh: () => {} } as never));
    await flush(); await flush();
    const input = container.querySelector<HTMLInputElement>(".plugin-spec-input")!;
    setInput(input, "acme/code");
    await flush();
    (container.querySelector("[data-plugin-spec-install] .keyrow button") as HTMLButtonElement).click();
    await flush(); await flush();
    expect(notified.join("\n")).toContain("no static assets");
    expect(container.querySelector("[data-plugin-spec-preview]")).toBeNull();
  });
});
