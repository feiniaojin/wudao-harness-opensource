// @vitest-environment jsdom
// ω99-215: #R — 会话未读徽标 receipts。先红后绿：红=纯层缺位（module not
// found，如实分类）。两层：①unread-store 纯层（畸形读作空/往返/seedMark
// 首见播种/markSeen 追平/30 封顶剪枝按最近触碰/被禁 storage 不崩）；
// ②全 App harness（buddy 侧栏，214 归档 receipts 式样：mock-ws fakeServer +
// authOk + settingsStatus→buddy + sessions op 播种）——差值出「N 新」、
// 打开即清（mark 追平到当时的 messages）、差值 0/首见无徽标（播种语义
// 落盘钉）、>99 显 99+、活跃行无徽标、归档箱行无徽标（归档共存）。
// 徽标数据源=既有 sessions 轮询的 messages 计数，渲染零网络零 op。夹具
// 零文件系统（纯 localStorage/jsdom；红线：绝不触碰用户文件）。
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/components/App.js";
import { WudaoClient } from "../src/protocol.js";
import type { SessionRow } from "../src/protocol.js";
import { authOk, fakeServer } from "./mock-ws.js";
import type { FakeServer } from "./mock-ws.js";
import {
  markSeen,
  MAX_UNREAD_MARKS,
  readMarks,
  seedMark,
  writeMarks,
} from "../src/unread-store.js";

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
 * 式样——侧栏 mount 即发，act 内同步上帧）。 */
async function replySessions(h: Harness, rows: readonly SessionRow[]): Promise<void> {
  await act(async () => {
    const op = opFrames(h).filter((o) => o.op.op === "sessions").at(-1);
    h.server.socket.serverSend({ t: "result", id: op?.id, ok: rows });
  });
}

/** 行点击 → resume op 应答 ok + 全量 state 帧（sessionId 切换——bare state
 *  帧整替 status，App 的 activeSessionId 随之变，侧栏 markSeen 写点触发）。 */
async function switchActive(h: Harness, id: string): Promise<void> {
  await act(async () => {
    const op = opFrames(h).filter((o) => o.op.op === "resume").at(-1);
    // ω99-225: the server now relays the outcome object — the fake rides the
    // same wire shape (a raw boolean would fall into not_found's branch).
    h.server.socket.serverSend({ t: "result", id: op?.id, ok: { ok: true } });
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
        sessionId: id,
        sidecar: null,
      },
    });
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

/** 三行：活跃（今天，authOk 默认 sessionId=wudao-test-0001 即它，messages 5）
 *  / 未读目标（今天，messages 12）/ 归档目标（上月，messages 8）。 */
const seedRows = (): SessionRow[] => [
  row({ id: "wudao-test-0001", name: "正在用的会话", messages: 5 }),
  row({ id: "wudao-unread-002", name: "有新进展的会话", messages: 12 }),
  row({ id: "wudao-old-00003", name: "上月的老会话", messages: 8, mtime: new Date(Date.now() - 30 * DAY).toISOString() }),
];

/** The ACTIVE-list row (.sb-list 内) whose title cell reads `title`. */
const activeRow = (h: Harness, title: string): HTMLElement | undefined =>
  ([...h.container.querySelectorAll(".sb-list .sb-i")] as HTMLElement[])
    .find((r) => r.querySelector(".sb-t")?.textContent === title);

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
  window.localStorage.removeItem("wudao.archive.v1");
  window.localStorage.removeItem("wudao.unread.v1"); // reset unread marks between tests
  document.title = "";
});

describe("unread-store 纯层 (ω99-215)", () => {
  it("畸形载荷读作空（非 JSON/空串/null/错形/marks 非对象），条目值非有限非负数被滤除，缺 key 读作空", () => {
    expect(readMarks()).toEqual({}); // no key
    const KEY = "wudao.unread.v1";
    const bads = [
      "not json{",
      "",
      "[]",
      "null",
      JSON.stringify({}),
      JSON.stringify({ marks: "x" }),
      JSON.stringify({ marks: [1, 2] }),
      JSON.stringify({ other: { a: 1 } }),
    ];
    for (const bad of bads) {
      window.localStorage.setItem(KEY, bad);
      expect(readMarks()).toEqual({});
    }
    // 值滤除是逐条目的（好条目保留——214 archived 数组同款粒度）。
    window.localStorage.setItem(KEY, JSON.stringify({ marks: { a: 3, b: "x", c: -1, d: 1e999 } }));
    expect(readMarks()).toEqual({ a: 3 });
  });

  it("writeMarks→readMarks 往返（载荷恰 {marks} 单版本化形状，插序保持）", () => {
    const back = writeMarks({ a: 3, b: 5 });
    expect(back).toEqual({ a: 3, b: 5 });
    expect(readMarks()).toEqual({ a: 3, b: 5 });
    expect(window.localStorage.getItem("wudao.unread.v1")).toBe(JSON.stringify({ marks: { a: 3, b: 5 } }));
    expect(Object.keys(readMarks())).toEqual(["a", "b"]); // 插序 = 触碰序（剪枝依它）
  });

  it("seedMark 首见播种：不在→播种落盘；在→绝不覆写（水位线只前进不后退由 markSeen 管）", () => {
    expect(seedMark("s1", 7)).toEqual({ s1: 7 });
    expect(readMarks()).toEqual({ s1: 7 });
    // 已在：第二次 seed（哪怕带更大 messages）零覆写零落盘。
    const before = window.localStorage.getItem("wudao.unread.v1");
    expect(seedMark("s1", 9)).toEqual({ s1: 7 });
    expect(window.localStorage.getItem("wudao.unread.v1")).toBe(before);
    expect(readMarks()).toEqual({ s1: 7 });
  });

  it("markSeen 追平：在→更新到当时 messages；不在→播种；同值幂等零落盘", () => {
    writeMarks({ s1: 7 });
    expect(markSeen("s1", 12)).toEqual({ s1: 12 });
    expect(readMarks()).toEqual({ s1: 12 });
    expect(markSeen("s2", 4)).toEqual({ s1: 12, s2: 4 }); // 不在→播种
    expect(readMarks()).toEqual({ s1: 12, s2: 4 });
    const before = window.localStorage.getItem("wudao.unread.v1");
    expect(markSeen("s1", 12)).toEqual({ s1: 12, s2: 4 }); // 同值：无写
    expect(window.localStorage.getItem("wudao.unread.v1")).toBe(before);
  });

  it("30 封顶剪枝按最近触碰：超限写丢最旧触碰；markSeen 触碰将旧条目挪到幸存侧", () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < MAX_UNREAD_MARKS + 2; i++) many[`k${String(i).padStart(2, "0")}`] = i;
    const kept = writeMarks(many);
    expect(Object.keys(kept)).toHaveLength(MAX_UNREAD_MARKS);
    expect(Object.keys(kept)[0]).toBe("k02"); // 最旧两条被剪（k00/k01 出局）
    expect(kept["k31"]).toBe(31); // 最新触碰幸存
    expect(readMarks()["k00"]).toBeUndefined();
    // 触碰序：把最旧的 k02 markSeen 后再溢入一条 → 被剪的是 k03（k02 已被
    // 触碰挪尾），被剪会话次轮首见重播种、无静默错徽标。
    markSeen("k02", 99);
    markSeen("k32", 32);
    const after = readMarks();
    expect(Object.keys(after)).toHaveLength(MAX_UNREAD_MARKS);
    expect(after["k02"]).toBe(99);
    expect(after["k32"]).toBe(32);
    expect(after["k03"]).toBeUndefined();
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
      expect(readMarks()).toEqual({});
      expect(() => writeMarks({ x: 1 })).not.toThrow();
      expect(() => seedMark("x", 1)).not.toThrow();
      expect(() => markSeen("x", 1)).not.toThrow();
    } finally {
      Object.defineProperty(window, "localStorage", orig!);
    }
    expect(readMarks()).toEqual({});
  });
});

describe("SessionSidebar 未读徽标面 (ω99-215)", () => {
  it("mark < messages → 行显「N 新」（差值确切）；徽标渲染零网络零 op", async () => {
    window.localStorage.setItem(
      "wudao.unread.v1",
      JSON.stringify({ marks: { "wudao-unread-002": 9 } }),
    );
    const h = await buddyApp();
    const framesAfterLoad = opFrames(h).length;
    const target = activeRow(h, "有新进展的会话");
    expect(target).toBeDefined();
    expect(target?.querySelector(".sb-unread")?.textContent).toBe("3 新"); // 12−9
    // 其余行（首见=已读）无徽标；渲染徽标零新增 op 帧（数据源=既有轮询）。
    expect(activeRow(h, "正在用的会话")?.querySelector(".sb-unread")).toBeNull();
    expect(activeRow(h, "上月的老会话")?.querySelector(".sb-unread")).toBeNull();
    expect(opFrames(h).length).toBe(framesAfterLoad);
  });

  it("打开该会话（activeSessionId 切换）→ 徽标清（mark 追平到当时的 messages），原活跃行不冒徽标", async () => {
    window.localStorage.setItem(
      "wudao.unread.v1",
      JSON.stringify({ marks: { "wudao-unread-002": 9 } }),
    );
    const h = await buddyApp();
    const target = activeRow(h, "有新进展的会话");
    expect(target?.querySelector(".sb-unread")?.textContent).toBe("3 新");
    await act(async () => {
      target!.click(); // 行点击 = resume（徽标无独立动作，随行打开）
    });
    await switchActive(h, "wudao-unread-002");
    // 徽标清：mark 追平 12，行转 .on（正在看的没有未读）。
    const now = activeRow(h, "有新进展的会话");
    expect(now?.classList.contains("on")).toBe(true);
    expect(now?.querySelector(".sb-unread")).toBeNull();
    expect(readMarks()["wudao-unread-002"]).toBe(12);
    // 原活跃行（wudao-test-0001）已在挂载时追平/播种 → 切走不冒徽标。
    expect(activeRow(h, "正在用的会话")?.querySelector(".sb-unread")).toBeNull();
  });

  it("差值 0 → 无徽标；首见会话 → 无徽标且播种落盘（升级当天不全员满徽标）", async () => {
    window.localStorage.setItem(
      "wudao.unread.v1",
      JSON.stringify({ marks: { "wudao-unread-002": 12 } }),
    );
    const h = await buddyApp();
    expect(activeRow(h, "有新进展的会话")?.querySelector(".sb-unread")).toBeNull(); // 差值 0
    expect(activeRow(h, "上月的老会话")?.querySelector(".sb-unread")).toBeNull(); // 首见
    const marks = readMarks();
    expect(marks["wudao-old-00003"]).toBe(8); // 首见播种 = 当前 messages（基线落盘）
    expect(marks["wudao-test-0001"]).toBe(5); // 活跃会话挂载即追平
  });

  it("差值 >99 → 显「99+ 新」", async () => {
    window.localStorage.setItem(
      "wudao.unread.v1",
      JSON.stringify({ marks: { "wudao-unread-002": 0 } }),
    );
    const h = await buddyApp(
      seedRows().map((r) => (r.id === "wudao-unread-002" ? { ...r, messages: 150 } : r)),
    );
    expect(activeRow(h, "有新进展的会话")?.querySelector(".sb-unread")?.textContent).toBe("99+ 新");
  });

  it("活跃会话行自身无徽标（mark 落后也不显——正在看的没有未读），且挂载即追平", async () => {
    window.localStorage.setItem(
      "wudao.unread.v1",
      JSON.stringify({ marks: { "wudao-test-0001": 0 } }),
    );
    const h = await buddyApp();
    const live = activeRow(h, "正在用的会话");
    expect(live?.classList.contains("on")).toBe(true);
    expect(live?.querySelector(".sb-unread")).toBeNull(); // 差值 5 也不显
    expect(readMarks()["wudao-test-0001"]).toBe(5); // 追平已落盘
  });

  it("归档共存：归档行有差值也不显徽标（收起的就是不打扰的），恢复回活跃列表徽标即在", async () => {
    window.localStorage.setItem("wudao.archive.v1", JSON.stringify({ archived: ["wudao-old-00003"] }));
    window.localStorage.setItem(
      "wudao.unread.v1",
      JSON.stringify({ marks: { "wudao-old-00003": 0 } }), // 差值 8
    );
    // 本件自带行集：归档目标取 3 天前（.sb-when 断言走确定性的「3天前」，
    // 30 天前的行 relativeTime 已是纯日期字符串）。
    const h = await buddyApp([
      row({ id: "wudao-test-0001", name: "正在用的会话", messages: 5 }),
      row({ id: "wudao-unread-002", name: "有新进展的会话", messages: 12 }),
      row({ id: "wudao-old-00003", name: "三天前的老会话", messages: 8, mtime: new Date(Date.now() - 3 * DAY).toISOString() }),
    ]);
    expect(activeRow(h, "三天前的老会话")).toBeUndefined(); // 在归档箱不在活跃列表
    const head = h.container.querySelector<HTMLElement>(".sb-arch-h");
    await act(async () => {
      head!.click(); // 展开
    });
    const archRow = ([...h.container.querySelectorAll(".sb-arch-list .sb-arch-i")] as HTMLElement[])
      .find((r) => r.querySelector(".sb-t")?.textContent === "三天前的老会话");
    expect(archRow?.querySelector(".sb-unread")).toBeNull(); // 归档行无徽标
    expect(archRow?.querySelector(".sb-when")?.textContent).toBe("3天前"); // 214 行语言零扰
    await act(async () => {
      archRow!.click(); // 恢复
    });
    expect(activeRow(h, "三天前的老会话")?.querySelector(".sb-unread")?.textContent).toBe("8 新");
  });
});
