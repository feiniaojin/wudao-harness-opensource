// @vitest-environment jsdom
// ω99-214: #R — 会话归档 receipts。先红后绿：红=纯层缺位（module not
// found，如实分类）。两层：①archive-store 纯层（畸形读作空/往返/toggle
// 增删幂等/被禁 storage 不崩）；②全 App harness（buddy 侧栏，213 recap
// receipts 式样：mock-ws fakeServer + authOk + settingsStatus→buddy +
// sessions op 播种）——归档后活跃列表消失+归档箱计数、恢复回原时间分组、
// 活跃会话无归档动作、跨重挂载保持、折叠组默认收起、归档集里的活跃会话
// 自动回列。归档/恢复零网络零 op（前后 op 帧数不变钉）。夹具零文件系统
// （纯 localStorage/jsdom；归档是视图层过滤，绝不触碰会话文件）。
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/components/App.js";
import { WudaoClient } from "../src/protocol.js";
import type { SessionRow } from "../src/protocol.js";
import { authOk, fakeServer } from "./mock-ws.js";
import type { FakeServer } from "./mock-ws.js";
import { isArchived, readArchive, toggleArchive, writeArchive } from "../src/archive-store.js";

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

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

interface Harness {
  container: HTMLElement;
  client: WudaoClient;
  server: FakeServer;
}

function mountedApp(): Harness {
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

type OpFrame = { id: number; op: { op: string; [k: string]: unknown } };
const opFrames = (h: Harness): OpFrame[] =>
  h.server
    .clientFrames()
    .filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f && "id" in f);

/** auth → settingsStatus(buddy)。最小形状（buddy-mode 套件同款——App 只读
 *  settings.uiDefaultMode 定壳层，其余 op 挂起不影响本面）。 */
async function replySettings(h: Harness): Promise<void> {
  await act(async () => {
    const op = opFrames(h).find((o) => o.op.op === "settingsStatus");
    h.server.socket.serverSend({
      t: "result",
      id: op?.id,
      ok: { settings: { memoryEnabled: true, uiDefaultMode: "buddy" } },
    });
  });
}

/** Answer the LATEST sessions fetch with rows（buddy-mode 的 replySessions
 *  式样——侧栏 mount 即发，act 内同步上帧）。 */
async function replySessions(h: Harness, rows: readonly SessionRow[]): Promise<void> {
  await act(async () => {
    const op = opFrames(h).filter((o) => o.op.op === "sessions").at(-1);
    h.server.socket.serverSend({ t: "result", id: op?.id, ok: rows });
  });
}

const DAY = 86_400_000;
const row = (over: Partial<SessionRow> & { id: string }): SessionRow => ({
  mtime: new Date(Date.now() - 5 * 60_000).toISOString(),
  messages: 2,
  firstUser: "",
  model: "deepseek-chat",
  ...over,
});
/** 三行：活跃（今天，authOk 默认 sessionId=wudao-test-0001 即它）/ 三天前
 *  （7 天内）/ 上月（更早）——恢复回原分组的断言用后两者的组别。 */
const seedRows = (): SessionRow[] => [
  row({ id: "wudao-test-0001", name: "正在用的会话" }),
  row({ id: "wudao-arch-0002", name: "三天前的会话", mtime: new Date(Date.now() - 3 * DAY).toISOString() }),
  row({ id: "wudao-old-00003", name: "上月的老会话", mtime: new Date(Date.now() - 30 * DAY).toISOString() }),
];

/** The ACTIVE-list row (.sb-list 内) whose title cell reads `title`. */
const activeRow = (h: Harness, title: string): HTMLElement | undefined =>
  ([...h.container.querySelectorAll(".sb-list .sb-i")] as HTMLElement[])
    .find((r) => r.querySelector(".sb-t")?.textContent === title);

/** The date-group label a title currently sits under（向左扫最近的 .sb-g）。 */
const groupOf = (h: Harness, title: string): string | undefined => {
  const kids = [...(h.container.querySelector(".sb-list")?.children ?? [])];
  const idx = kids.findIndex(
    (k) => k.classList.contains("sb-i") && k.querySelector(".sb-t")?.textContent === title,
  );
  for (let i = idx; i >= 0; i--) if (kids[i]!.classList.contains("sb-g")) return kids[i]!.textContent ?? undefined;
  return undefined;
};

/** buddy 侧栏挂到行可见为止。 */
async function buddyApp(rows: readonly SessionRow[] = seedRows()): Promise<Harness> {
  const h = mountedApp();
  await act(async () => {
    authOk(h.server.socket);
  });
  await replySettings(h);
  await replySessions(h, rows);
  await until(() => h.container.querySelector(".sb-list .sb-i") !== null, "sidebar rows");
  return h;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  window.localStorage.removeItem("wudao.ui.v1");
  window.localStorage.removeItem("wudao.recap.v1");
  window.localStorage.removeItem("wudao.archive.v1"); // ω99-214: reset archive state between tests
  document.title = "";
});

describe("archive-store 纯层 (ω99-214)", () => {
  it("畸形载荷读作空（非 JSON/空串/null/错形/非串数组），缺 key 读作空", () => {
    expect(readArchive()).toEqual([]); // no key
    const KEY = "wudao.archive.v1";
    const bads = [
      "not json{",
      "",
      "[]",
      "null",
      JSON.stringify({}),
      JSON.stringify({ archived: "x" }),
      JSON.stringify({ other: ["a"] }),
      JSON.stringify({ archived: [1, {}, null] }),
    ];
    for (const bad of bads) {
      window.localStorage.setItem(KEY, bad);
      expect(readArchive()).toEqual([]);
    }
  });

  it("writeArchive→readArchive 往返 + isArchived 集合判定（载荷恰 {archived} 单版本化形状）", () => {
    writeArchive(["a", "b"]);
    expect(readArchive()).toEqual(["a", "b"]);
    expect(window.localStorage.getItem("wudao.archive.v1")).toBe(JSON.stringify({ archived: ["a", "b"] }));
    expect(isArchived(readArchive(), "a")).toBe(true);
    expect(isArchived(readArchive(), "c")).toBe(false);
    expect(isArchived([], "a")).toBe(false);
  });

  it("toggleArchive 增删幂等：不在→入、在→出、双 toggle 复原（每次已落盘）", () => {
    expect(toggleArchive("x")).toEqual(["x"]);
    expect(readArchive()).toEqual(["x"]);
    expect(toggleArchive("x")).toEqual([]);
    expect(readArchive()).toEqual([]);
    writeArchive(["a"]);
    expect(toggleArchive("b")).toEqual(["a", "b"]);
    expect(readArchive()).toEqual(["a", "b"]);
    expect(toggleArchive("b")).toEqual(["a"]);
    expect(readArchive()).toEqual(["a"]);
  });

  it("被禁 storage 读作空、写不崩（UI_LAYOUT_KEY 律：try/catch 全包）", () => {
    const orig = Object.getOwnPropertyDescriptor(window, "localStorage");
    try {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() {
          throw new Error("denied");
        },
      });
      expect(readArchive()).toEqual([]);
      expect(() => writeArchive(["x"])).not.toThrow();
      expect(() => toggleArchive("x")).not.toThrow();
    } finally {
      Object.defineProperty(window, "localStorage", orig!);
    }
    expect(readArchive()).toEqual([]);
  });
});

describe("SessionSidebar 归档面 (ω99-214)", () => {
  it("归档动作 → 行从活跃列表消失、归档箱计数+1（默认收起）；恢复 → 回活跃列表原时间分组；归档/恢复零网络零 op", async () => {
    const h = await buddyApp();
    const framesBefore = opFrames(h).length;
    const target = activeRow(h, "三天前的会话");
    expect(target).toBeDefined();
    const archBtn = target!.querySelector<HTMLElement>(".sb-act");
    expect(archBtn?.textContent).toBe("归档");
    await act(async () => {
      archBtn!.click();
    });
    // 活跃列表消失；归档箱 +1，默认收起（无行渲染）。
    expect(activeRow(h, "三天前的会话")).toBeUndefined();
    const head = h.container.querySelector<HTMLElement>(".sb-arch-h");
    expect(head?.textContent).toContain("已归档 1");
    expect(h.container.querySelector(".sb-arch-list")).toBeNull();
    // per-viewer localStorage 已持久。
    expect(isArchived(readArchive(), "wudao-arch-0002")).toBe(true);
    // 归档零网络零 op。
    expect(opFrames(h).length).toBe(framesBefore);
    // 展开 → 行同款渲染（标题+相对时间）+「恢复」动作在位。
    await act(async () => {
      head!.click();
    });
    const archRow = ([...h.container.querySelectorAll(".sb-arch-list .sb-arch-i")] as HTMLElement[])
      .find((r) => r.querySelector(".sb-t")?.textContent === "三天前的会话");
    expect(archRow?.querySelector(".sb-when")?.textContent).toBe("3天前");
    expect(archRow?.querySelector(".sb-act")?.textContent).toBe("恢复");
    // 恢复 → 回活跃列表原时间分组（7 天内），归档箱清空消失。
    await act(async () => {
      archRow!.click();
    });
    expect(groupOf(h, "三天前的会话")).toBe("7 天内");
    expect(h.container.querySelector(".sb-arch")).toBeNull();
    expect(readArchive()).toEqual([]);
    // 恢复同样零网络零 op。
    expect(opFrames(h).length).toBe(framesBefore);
  });

  it("活跃会话行无归档动作（v1 不许归档自己正在看的会话）；其余行有", async () => {
    const h = await buddyApp();
    const live = activeRow(h, "正在用的会话");
    expect(live?.classList.contains("on")).toBe(true);
    expect(live?.querySelector(".sb-act")).toBeNull();
    expect(activeRow(h, "三天前的会话")?.querySelector(".sb-act")).not.toBeNull();
  });

  it("归档状态跨重挂载保持（per-viewer localStorage 重水合，活跃行不受扰）", async () => {
    const h1 = await buddyApp();
    await act(async () => {
      activeRow(h1, "三天前的会话")!.querySelector<HTMLElement>(".sb-act")!.click();
    });
    act(() => {
      root?.unmount();
    });
    root = null;
    document.body.innerHTML = "";
    const h2 = await buddyApp();
    expect(activeRow(h2, "三天前的会话")).toBeUndefined();
    expect(h2.container.querySelector(".sb-arch-h")?.textContent).toContain("已归档 1");
    expect(activeRow(h2, "正在用的会话")).toBeDefined();
  });

  it("折叠组默认收起；点击展开见行（含「可随时恢复」明示），再点收起", async () => {
    window.localStorage.setItem("wudao.archive.v1", JSON.stringify({ archived: ["wudao-old-00003"] }));
    const h = await buddyApp();
    expect(activeRow(h, "上月的老会话")).toBeUndefined();
    expect(h.container.querySelector(".sb-arch-list")).toBeNull(); // 默认收起
    const head = h.container.querySelector<HTMLElement>(".sb-arch-h");
    expect(head?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      head!.click();
    });
    expect(h.container.querySelector<HTMLElement>(".sb-arch-h")?.getAttribute("aria-expanded")).toBe("true");
    expect(h.container.querySelector(".sb-arch-list .sb-arch-i .sb-t")?.textContent).toBe("上月的老会话");
    expect(h.container.querySelector(".sb-arch-hint")?.textContent).toBe("可随时恢复");
    await act(async () => {
      h.container.querySelector<HTMLElement>(".sb-arch-h")!.click();
    });
    expect(h.container.querySelector(".sb-arch-list")).toBeNull();
  });

  it("归档集里的活跃会话自动回列（resume 拾起已归档会话不留悬空态）", async () => {
    window.localStorage.setItem("wudao.archive.v1", JSON.stringify({ archived: ["wudao-test-0001"] }));
    const h = await buddyApp();
    const live = activeRow(h, "正在用的会话");
    expect(live).toBeDefined();
    expect(live?.classList.contains("on")).toBe(true);
    expect(readArchive()).toEqual([]);
    expect(h.container.querySelector(".sb-arch")).toBeNull();
  });
});
