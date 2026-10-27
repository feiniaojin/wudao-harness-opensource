// @vitest-environment jsdom
// M-Memory 管理记忆面 — 长期记忆段（jsdom）：条目渲染（kind·用过 N 次·文本）/
// 「忘掉」→ longtermMemoryForget(id) + 重取 / 空 / 老 server（方法缺场或拒答）
// → 整段隐藏（零噪音门）。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PreferencesTab } from "../src/components/PreferencesTab.js";
import type { WudaoClient } from "../src/protocol.js";

function mount(client: WudaoClient): HTMLElement {
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  root.render(createElement(PreferencesTab, { client, notify: () => {}, refresh: () => {} } as never));
  return container;
}

const flush = async (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function baseClient(overrides: Record<string, unknown>): WudaoClient {
  return {
    settingsStatus: vi.fn().mockResolvedValue({ settings: {} }),
    memoryList: vi.fn().mockResolvedValue({ entries: [] }),
    ...overrides,
  } as unknown as WudaoClient;
}

const ENTRIES = [
  { id: "a1", kind: "preference", text: "回复用中文", tags: [], createdAt: new Date().toISOString(), useCount: 3 },
  { id: "b2", kind: "lesson", text: "压缩前先跑测试", tags: [], createdAt: new Date().toISOString(), useCount: 1 },
];

describe("PreferencesTab: 长期记忆段", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("条目渲染：kind·用过 N 次 + 文本 + 忘掉按钮", async () => {
    const c = mount(baseClient({ longtermMemoryList: vi.fn().mockResolvedValue({ entries: ENTRIES }) }));
    await flush(); await flush(); await flush();
    const sec = c.querySelector("[data-lt-memory]");
    expect(sec).not.toBeNull();
    expect(sec!.textContent).toContain("长期记忆");
    expect(sec!.textContent).toContain("preference · 用过 3 次");
    expect(sec!.textContent).toContain("回复用中文");
    expect(c.querySelectorAll("[data-lt-entry]").length).toBe(2);
  });

  it("「忘掉」→ forget(id) 调用 + 列表重取（条目消失）", async () => {
    const list = vi.fn().mockResolvedValue({ entries: ENTRIES });
    const forget = vi.fn().mockResolvedValue(undefined);
    const listAfter = vi.fn().mockResolvedValue({ entries: [ENTRIES[1]!] });
    const seq = vi.fn().mockImplementationOnce(list).mockImplementationOnce(listAfter);
    const c = mount(baseClient({ longtermMemoryList: seq, longtermMemoryForget: forget }));
    await flush(); await flush(); await flush();
    (c.querySelector('[data-lt-entry="a1"] .mem-del') as HTMLButtonElement).click();
    await flush(); await flush(); await flush();
    expect(forget).toHaveBeenCalledWith("a1");
    expect(c.querySelector('[data-lt-entry="a1"]')).toBeNull();
    expect(c.querySelector('[data-lt-entry="b2"]')).not.toBeNull();
  });

  it("空库 → 空态文案；老 server（方法缺场）→ 整段隐藏", async () => {
    const empty = mount(baseClient({ longtermMemoryList: vi.fn().mockResolvedValue({ entries: [] }) }));
    await flush(); await flush(); await flush();
    expect(empty.querySelector("[data-lt-memory]")!.textContent).toContain("还没有长期记忆");

    const old = mount(baseClient({})); // 方法缺场
    await flush(); await flush(); await flush();
    expect(old.querySelector("[data-lt-memory]")).toBeNull();
  });
});
