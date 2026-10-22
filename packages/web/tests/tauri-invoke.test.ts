// @vitest-environment jsdom
// workspace-ux A1 — the Tauri invoke seam. ONE three-tier resolver backs
// every desktop-plugin call (dialog / notification / window drag).
// __TAURI_INTERNALS__.invoke wins because the webview always injects it,
// while the core-only `__TAURI__.core` global needs withGlobalTauri:true;
// no bridge at all → null/false so the caller takes the browser fallback.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  resolveTauriInvoke,
  tauriPickDirectory,
  tauriNotify,
  tauriStartDrag,
  tauriToggleMaximize,
  tauriOpenUrl,
  tauriListenEvent,
  unwrapTauriEventPayload,
} from "../src/tauri-invoke.js";

type W = typeof window & { __TAURI_INTERNALS__?: { invoke?: unknown }; __TAURI__?: { core?: { invoke?: unknown } } };
const w = window as W;

describe("tauri-invoke 三层解析", () => {
  beforeEach(() => { delete w.__TAURI_INTERNALS__; delete w.__TAURI__; });

  it("首选 __TAURI_INTERNALS__.invoke", async () => {
    const internals = vi.fn(async (cmd: string) => `internals:${cmd}`);
    const bundle = vi.fn(async (cmd: string) => `bundle:${cmd}`);
    w.__TAURI_INTERNALS__ = { invoke: internals }; w.__TAURI__ = { core: { invoke: bundle } };
    // await：vitest 3 起 resolves 断言不再自动收尾（brief 代码的两处补 await）。
    await expect(resolveTauriInvoke()!("x")).resolves.toBe("internals:x");
    expect(bundle).not.toHaveBeenCalled();
  });
  it("次选 __TAURI__.core.invoke（无 internals 时）", async () => {
    const bundle = vi.fn(async () => "b");
    w.__TAURI__ = { core: { invoke: bundle } };
    await expect(resolveTauriInvoke()!("x")).resolves.toBe("b");
  });
  it("两者皆无 → undefined（调用方走浏览器回退）", () => {
    expect(resolveTauriInvoke()).toBeUndefined();
  });
  it("tauriPickDirectory 走 plugin:dialog|open + directory:true；取消(null/空串/数组)归一为 null", async () => {
    const invoke = vi.fn(async (_c: string, a: unknown) => (a as { options: { directory: boolean } }).options.directory ? "/picked/dir" : "");
    w.__TAURI_INTERNALS__ = { invoke };
    expect(await tauriPickDirectory()).toBe("/picked/dir");
    expect(invoke).toHaveBeenCalledWith("plugin:dialog|open", { options: { directory: true, multiple: false } });
    w.__TAURI_INTERNALS__ = { invoke: vi.fn(async () => null) };
    expect(await tauriPickDirectory()).toBeNull();
    w.__TAURI_INTERNALS__ = { invoke: vi.fn(async () => "") };
    expect(await tauriPickDirectory()).toBeNull(); // A1 review: 空串 = 取消
    w.__TAURI_INTERNALS__ = { invoke: vi.fn(async () => ["/a"]) };
    expect(await tauriPickDirectory()).toBe("/a"); // A1 review: 防御性数组取 [0]
  });
  it("tauriNotify / tauriStartDrag 的命令与参数形状；无桥 → false", async () => {
    const invoke = vi.fn(async () => undefined);
    w.__TAURI_INTERNALS__ = { invoke };
    await tauriNotify("t"); await tauriStartDrag();
    expect(invoke).toHaveBeenCalledWith("plugin:notification|notify", { options: { title: "t" } });
    expect(invoke).toHaveBeenCalledWith("plugin:window|start_dragging");
    delete w.__TAURI_INTERNALS__;
    expect(await tauriNotify("t")).toBe(false);
    expect(await tauriStartDrag()).toBe(false);
  });
  // workspace-ux C1: 顶栏双击最大化 rides the same seam. 无 label = 调用方
  // 所在窗口（workspace-* 多窗同享 topbar，写死 "main" 会切错窗）。
  it("tauriToggleMaximize 走 plugin:window|toggle_maximize 无 label；无桥/拒绝 → false", async () => {
    const invoke = vi.fn(async () => undefined);
    w.__TAURI_INTERNALS__ = { invoke };
    expect(await tauriToggleMaximize()).toBe(true);
    expect(invoke).toHaveBeenCalledWith("plugin:window|toggle_maximize");
    delete w.__TAURI_INTERNALS__;
    expect(await tauriToggleMaximize()).toBe(false);
    w.__TAURI_INTERNALS__ = { invoke: vi.fn(async () => { throw new Error("denied"); }) };
    expect(await tauriToggleMaximize()).toBe(false); // 缺 capability 不炸调用方
  });
  // ω99-155: markdown 链接外开 rides the same seam（自定义 app 命令
  // open_url，非 plugin: 前缀）。无桥 / Rust scheme 门拒绝 → false，调用方
  // （markdown.tsx 的 onLinkClick）走 window.open 浏览器回退。
  it("tauriOpenUrl 走 open_url + {url}；无桥/拒绝 → false（调用方浏览器回退）", async () => {
    const invoke = vi.fn(async () => undefined);
    w.__TAURI_INTERNALS__ = { invoke };
    expect(await tauriOpenUrl("https://example.com/x")).toBe(true);
    expect(invoke).toHaveBeenCalledWith("open_url", { url: "https://example.com/x" });
    delete w.__TAURI_INTERNALS__;
    expect(await tauriOpenUrl("https://example.com/x")).toBe(false); // 非 Tauri → 回退
    w.__TAURI_INTERNALS__ = { invoke: vi.fn(async () => { throw new Error("open_url: scheme not allowed"); }) };
    expect(await tauriOpenUrl("ftp://example.com/f")).toBe(false); // 门拒 → 回退，不炸
  });
});

// ω99-107 — 事件缝解包（P0 用户报障根因）。live 实证（0.3.44 真机注入诊断）
// 的逐字线格式：原生 plugin:event|listen 回调收到的是 Tauri Event 包装对象
// {"event":"wudao-diag-test","payload":{"probe":42},"id":1}（event=字符串,
// payload=emit 端对象, id=数字）。@tauri-apps/api 的 listen() 会帮你解包；
// 我们走裸 plugin 命令缝，必须由 seam 单点解——四个消费者（relay ask / 宠物
// 帧 / 定时送达 / 拖文件）只见 payload。
type WEvent = typeof window & { __TAURI_INTERNALS__?: { invoke?: unknown; transformCallback?: unknown } };
const we = window as WEvent;

describe("tauriListenEvent 事件解包（ω99-107）", () => {
  let capturedCb: ((payload: unknown) => void) | undefined;
  let nextId: number;
  let invoke: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    capturedCb = undefined;
    nextId = 1;
    invoke = vi.fn(async (cmd: string) => (cmd === "plugin:event|listen" ? 900 : undefined));
    we.__TAURI_INTERNALS__ = {
      invoke,
      transformCallback: (cb: (payload: unknown) => void): number => {
        capturedCb = cb;
        return nextId++;
      },
    };
    delete (window as W).__TAURI__;
  });

  afterEach(() => {
    delete we.__TAURI_INTERNALS__;
  });

  it("listen 注册 {event,target:{kind:'Any'},handler=回调id}；Event 包装回调 → handler 只见 payload", async () => {
    const h = vi.fn();
    const unlisten = await tauriListenEvent("e", h);
    expect(unlisten).toBeTypeOf("function");
    expect(invoke).toHaveBeenCalledWith("plugin:event|listen", { event: "e", target: { kind: "Any" }, handler: 1 });
    // 逐字 live 形状（真机诊断原样）：三键齐备的 Event 包装 → 只递 payload
    capturedCb!({ event: "e", payload: { a: 1 }, id: 7 });
    expect(h).toHaveBeenCalledWith({ a: 1 });
    expect(h).toHaveBeenCalledTimes(1);
    // unlisten 用 listen 的返回值（eventId=900），不是 transformCallback 的回调 id
    unlisten!();
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith("plugin:event|unlisten", { event: "e", eventId: 900 });
  });

  it("裸 payload / 原始值 / null 一律透传——不误伤非包装形状", async () => {
    const h = vi.fn();
    await tauriListenEvent("e", h);
    capturedCb!({ a: 1 });
    capturedCb!("str");
    capturedCb!(null);
    expect(h).toHaveBeenNthCalledWith(1, { a: 1 });
    expect(h).toHaveBeenNthCalledWith(2, "str");
    expect(h).toHaveBeenNthCalledWith(3, null);
  });

  it("unwrapTauriEventPayload 直测：三键齐备才解包，否则原样返回", () => {
    expect(unwrapTauriEventPayload({ event: "wudao-diag-test", payload: { probe: 42 }, id: 1 })).toEqual({ probe: 42 });
    // 近似形状：event 非字符串 / 缺 payload 键 → 不猜，透传
    expect(unwrapTauriEventPayload({ event: 7, payload: { a: 1 }, id: 1 })).toEqual({ event: 7, payload: { a: 1 }, id: 1 });
    expect(unwrapTauriEventPayload({ event: "e", id: 1 })).toEqual({ event: "e", id: 1 });
    // 裸对象 / 数组 / 字符串 / null：同引用原样返回
    const bare = { a: 1 };
    expect(unwrapTauriEventPayload(bare)).toBe(bare);
    const arr = [1, 2];
    expect(unwrapTauriEventPayload(arr)).toBe(arr);
    expect(unwrapTauriEventPayload("str")).toBe("str");
    expect(unwrapTauriEventPayload(null)).toBeNull();
  });
});
