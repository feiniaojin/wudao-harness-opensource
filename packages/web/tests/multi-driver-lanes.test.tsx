// @vitest-environment jsdom
// 多 driver 并发弧 C（2026-09-16）— web 多车道快照 + UI 车道化的 receipts。
// 三层：
//   ① 协议客户端（protocol.ts）：state 帧 lanes 字段进快照（busy/sessionId
//      重读、history/epoch 客户端跨帧保留、无变化帧身份稳定）；带 sid 的
//      history 帧进对应车道数组（reset 只 bump 该车道 epoch，主车道字节不
//      动）；老 server（无 lanes）快照 lanes 恒 undefined；写方法（submit/
//      interrupt/setMode/resume）带 sid 上帧、缺省不带。
//   ② 纯函数（use-lane-view.ts）：busySessionIdsOf（侧栏 ◐ 徽标集）、
//      pickLaneRoute（点击三路决策）、useSessionViews（视图状态按会话分键
//      ——A 车道的回执绝不落进 B 车道，recon §G1 的结构性钉）。
//   ③ App（jsdom）：车道化 server 上主车道 busy 不再拦切换（侧栏点开新车
//      道=resume {id,sid}，视图切到车道 history，主车道内容不渲染）；侧栏
//      「运行中」徽标；老 server 的 busy 拒绝路径字节不变（回归钉）。
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/components/App.js";
import { WudaoClient } from "../src/protocol.js";
import { mergeLaneStatuses, applyLaneHistory, mintLaneId } from "../src/protocol.js";
import { busySessionIdsOf, pickLaneRoute, useSessionViews } from "../src/use-lane-view.js";
import { authOk, fakeServer } from "./mock-ws.js";
import type { FakeServer } from "./mock-ws.js";
import type { DriverStatus, SessionRow, LaneSnapshot } from "../src/protocol.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function laneClient(): { client: WudaoClient; server: FakeServer } {
  const server = fakeServer();
  const client = new WudaoClient({
    url: "ws://127.0.0.1:1",
    token: "t",
    wsFactory: () => server.spawn(),
    reconnect: false,
  });
  client.connect();
  server.socket.serverOpen();
  return { client, server };
}

/** A full DriverStatus (a bare state frame replaces the status wholesale —
 *  the same base authOk uses, with overrides). */
function statusFrame(over: Record<string, unknown> = {}): DriverStatus {
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
    sessionId: "wudao-main-0001",
    sidecar: null,
    ...over,
  } as DriverStatus;
}

const send = (socket: FakeServer["socket"], frame: unknown): void => {
  socket.serverSend(frame);
};

type OpFrame = { id: number; op: Record<string, unknown> };
const opFrames = (harness: { server: FakeServer }): OpFrame[] =>
  harness.server
    .clientFrames()
    .filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f && "id" in f);

// ---------------------------------------------------------------------------
// ① protocol client — lanes snapshot consumption
// ---------------------------------------------------------------------------

describe("多 driver 弧 C — 协议客户端的车道快照", () => {
  it("state 帧的 lanes 进快照：busy/sessionId 重读、history 跨帧保留、无变化帧身份稳定", () => {
    const { client, server } = laneClient();
    send(server.socket, { t: "state", state: statusFrame(), lanes: { L1: { busy: false, sessionId: "s-b" } } });
    let snap = client.getSnapshot();
    expect(snap.lanes?.L1).toMatchObject({ busy: false, sessionId: "s-b", history: [], historyEpoch: 0 });
    const stable = snap.lanes;
    // 同成员同状态的下一次推送：身份稳定（流式帧不搅渲染）。
    send(server.socket, { t: "state", state: statusFrame(), lanes: { L1: { busy: false, sessionId: "s-b" } } });
    expect(client.getSnapshot().lanes).toBe(stable);
    // 车道历史落地后，后续 state 帧的 busy 更新保留 history（重读合并纪律）。
    send(server.socket, { t: "history", entries: [{ kind: "user", text: "b1" }], sid: "L1" });
    send(server.socket, { t: "state", state: statusFrame(), lanes: { L1: { busy: true, sessionId: "s-b" } } });
    snap = client.getSnapshot();
    expect(snap.lanes?.L1?.busy).toBe(true);
    expect(snap.lanes?.L1?.history).toHaveLength(1);
    client.close();
  });

  it("带 sid 的 history 帧：append 进车道数组、reset 只 bump 该车道 epoch、主车道不动", () => {
    const { client, server } = laneClient();
    send(server.socket, { t: "state", state: statusFrame() });
    send(server.socket, { t: "history", entries: [{ kind: "user", text: "主车道消息" }], reset: true });
    const mainEpoch = client.getSnapshot().historyEpoch;
    send(server.socket, { t: "state", state: statusFrame(), lanes: { L1: { busy: false, sessionId: "s-b" } } });
    send(server.socket, { t: "history", entries: [{ kind: "user", text: "b1" }], sid: "L1" });
    send(server.socket, { t: "history", entries: [{ kind: "user", text: "b2" }], sid: "L1", reset: true });
    const snap = client.getSnapshot();
    expect(snap.lanes?.L1?.history.map((e) => (e.kind === "user" ? e.text : ""))).toEqual(["b2"]);
    expect(snap.lanes?.L1?.historyEpoch).toBe(1);
    // 主车道字节不动：history 与 epoch 都还是 reset 重放后的样子。
    expect(snap.history.map((e) => (e.kind === "user" ? e.text : ""))).toEqual(["主车道消息"]);
    expect(snap.historyEpoch).toBe(mainEpoch);
    client.close();
  });

  it("车道 history 可先于 state 帧到达（采纳竞态）：条目自动建车道，state 帧随后校正状态", () => {
    const { client, server } = laneClient();
    send(server.socket, { t: "state", state: statusFrame(), lanes: {} });
    send(server.socket, { t: "history", entries: [{ kind: "user", text: "early" }], sid: "L9" });
    expect(client.getSnapshot().lanes?.L9?.history).toHaveLength(1);
    send(server.socket, { t: "state", state: statusFrame(), lanes: { L9: { busy: true, sessionId: "s-9" } } });
    const lane = client.getSnapshot().lanes?.L9;
    expect(lane?.busy).toBe(true);
    expect(lane?.sessionId).toBe("s-9");
    expect(lane?.history).toHaveLength(1); // 校正不动历史
    client.close();
  });

  it("老 server（无 lanes 字段）：快照 lanes 恒 undefined，单车道路径字节不变", () => {
    const { client, server } = laneClient();
    send(server.socket, { t: "state", state: statusFrame() });
    send(server.socket, { t: "history", entries: [{ kind: "user", text: "m" }], reset: true });
    send(server.socket, { t: "state", state: statusFrame({ busy: true }) });
    const snap = client.getSnapshot();
    expect(snap.lanes).toBeUndefined();
    expect(snap.history).toHaveLength(1);
    client.close();
  });

  it("mergeLaneStatuses：server 关掉的车道从快照消失（其 history 一并退役）；缺席字段保持前值", () => {
    const withHistory: Record<string, LaneSnapshot> = { L1: { busy: false, sessionId: "s-b", history: [{ kind: "user", text: "x" }], historyEpoch: 1 }, L2: { busy: true, sessionId: "s-c", history: [], historyEpoch: 0 } };
    // 帧里没有 lanes（老 server / 竞态帧）：保持前值。
    expect(mergeLaneStatuses(withHistory, undefined)).toBe(withHistory);
    // L1 从帧里消失（server 关掉了它）：快照同步退役；L2 busy 翻转保留 history。
    const merged = mergeLaneStatuses(withHistory, { L2: { busy: false, sessionId: "s-c" } });
    expect(merged && Object.keys(merged)).toEqual(["L2"]);
    expect(merged?.L2?.busy).toBe(false);
    expect(merged?.L2?.historyEpoch).toBe(0);
    // 形状防御：畸形行淘汰（fail-closed membership）。
    const guarded = mergeLaneStatuses(undefined, { Bad: null, L1: { busy: false, sessionId: "s" } } as unknown as Record<string, { busy: boolean; sessionId: string }>);
    expect(guarded && Object.keys(guarded)).toEqual(["L1"]);
  });

  it("applyLaneHistory：append / reset 两条路（车道 epoch 只在 reset 时 +1）", () => {
    const prev = applyLaneHistory(undefined, "L1", [{ kind: "user", text: "a" }], true);
    expect(prev.L1?.historyEpoch).toBe(1);
    const appended = applyLaneHistory(prev, "L1", [{ kind: "user", text: "b" }], false);
    expect(appended.L1?.history).toHaveLength(2);
    expect(appended.L1?.historyEpoch).toBe(1);
  });

  it("写方法带 sid 上帧、缺省不带（老 server 忽略未知字段=零破坏）", () => {
    const { client, server } = laneClient();
    send(server.socket, { t: "state", state: statusFrame() });
    const sent = (): Record<string, unknown>[] => server.clientFrames().map((f) => (f as { op: Record<string, unknown> }).op);
    const fire = (p: Promise<unknown>): void => {
      p.catch(() => { /* 无回执测试——close() 会拒，吞之 */ });
    };
    fire(client.submit("去车道", { sid: "L1" }));
    fire(client.interrupt("L1"));
    fire(client.setMode("auto", "L1"));
    fire(client.resume("s-b", "L1"));
    const withSid = sent().slice(-4);
    expect(withSid[0]).toMatchObject({ op: "submit", text: "去车道", sid: "L1" });
    expect(withSid[1]).toMatchObject({ op: "interrupt", sid: "L1" });
    expect(withSid[2]).toMatchObject({ op: "setMode", mode: "auto", sid: "L1" });
    expect(withSid[3]).toMatchObject({ op: "resume", id: "s-b", sid: "L1" });
    // 缺省（主车道）：帧上没有 sid 键——字节级兼容。
    fire(client.submit("主车道"));
    fire(client.interrupt());
    fire(client.setMode("auto"));
    fire(client.resume("s-b"));
    const bare = sent().slice(-4);
    for (const op of bare) expect("sid" in op).toBe(false);
    client.close();
  });

  it("mintLaneId：web 端铸造的车道 id（L- 前缀，两次不同）", () => {
    const a = mintLaneId();
    expect(a.startsWith("L-")).toBe(true);
    expect(mintLaneId()).not.toBe(a);
  });
});

// ---------------------------------------------------------------------------
// ② pure helpers — badge set / pick route / per-session view slots
// ---------------------------------------------------------------------------

describe("多 driver 弧 C — 纯函数与分键视图状态", () => {
  const lanes: Record<string, LaneSnapshot> = {
    L1: { busy: true, sessionId: "s-b", history: [{ kind: "user", text: "x" }], historyEpoch: 1 },
    L2: { busy: false, sessionId: "s-c", history: [], historyEpoch: 0 },
  };

  it("busySessionIdsOf：主车道 busy 会话 + busy 副车道的会话；老 server → undefined（面隐藏）", () => {
    expect(busySessionIdsOf(null, undefined)).toBeUndefined();
    expect(busySessionIdsOf(statusFrame({ busy: true, sessionId: "s-main" }), undefined)).toBeUndefined();
    const set = busySessionIdsOf(statusFrame({ busy: true, sessionId: "s-main" }), lanes);
    expect(set && [...set].sort()).toEqual(["s-b", "s-main"]); // 主车道与副车道同权（◐ 与主车道一致）
  });

  it("pickLaneRoute：三路决策——主车道已持有→view-main；副车道已持有→view-lane；无人持有→open-lane", () => {
    const status = statusFrame({ sessionId: "s-main" });
    expect(pickLaneRoute(status, lanes, "s-main")).toEqual({ kind: "view-main" });
    expect(pickLaneRoute(status, lanes, "s-c")).toEqual({ kind: "view-lane", laneId: "L2" });
    const open = pickLaneRoute(status, lanes, "s-new");
    expect(open.kind).toBe("open-lane");
    expect(open.kind === "open-lane" && open.laneId.startsWith("L-")).toBe(true);
    // 老 server（lanes undefined）：决策仍可用（App 的老路径不经过它，但
    // 无 lanes 时持有判定只剩主车道）。
    expect(pickLaneRoute(status, undefined, "s-main").kind).toBe("view-main");
    expect(pickLaneRoute(status, undefined, "s-x").kind).toBe("open-lane");
  });

  it("useSessionViews：视图状态按会话分键——A 车道的回执绝不落进 B 车道", async () => {
    let views!: ReturnType<typeof useSessionViews>;
    const Probe = (): null => {
      views = useSessionViews();
      return null;
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Probe />);
    });
    act(() => {
      views.stampNote("s-a", "A 车道回执", 0, 1);
      views.stampNote("s-b", "B 车道回执", 0, 1);
    });
    expect(views.slot("s-a").notes.map((n) => n.text)).toEqual(["A 车道回执"]);
    expect(views.slot("s-b").notes.map((n) => n.text)).toEqual(["B 车道回执"]);
    // 代换清理只清本键（B 车道换血不动 A 车道的回执）。
    act(() => {
      views.filterNotes("s-b", (n) => n.epoch === 2);
    });
    expect(views.slot("s-b").notes).toHaveLength(0);
    expect(views.slot("s-a").notes).toHaveLength(1);
    // armed / fork 徽标同分键。
    act(() => {
      views.setArmedEdit("s-a", { n: 2 });
      views.setForkBadges("s-b", new Set(["k1"]));
    });
    expect(views.slot("s-a").armedEdit).toEqual({ n: 2 });
    expect(views.slot("s-b").armedEdit).toBeNull();
    expect(views.slot("s-b").forkBadges.has("k1")).toBe(true);
    expect(views.slot("s-a").forkBadges.size).toBe(0);
    await act(async () => {
      root.unmount();
    });
  });
});

// ---------------------------------------------------------------------------
// ③ App — the lane-aware UI
// ---------------------------------------------------------------------------

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

const row = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: "sess-lane-b",
  mtime: new Date(Date.now() - 60 * 60_000).toISOString(),
  messages: 2,
  firstUser: "车道B的首句",
  model: "deepseek-v4-flash",
  ...over,
});

const mainRow = (): SessionRow => ({
  id: "wudao-main-0001",
  mtime: new Date().toISOString(),
  messages: 3,
  firstUser: "主车道首句",
  model: "deepseek-v4-flash",
});

async function replySettings(h: AppHarness, uiDefaultMode: "simple" | "buddy" | "advanced"): Promise<void> {
  await act(async () => {
    const op = opFrames(h).find((o) => o.op.op === "settingsStatus");
    h.server.socket.serverSend({ t: "result", id: op?.id, ok: { settings: { memoryEnabled: true, uiDefaultMode } } });
  });
}

async function replySessions(h: AppHarness, rows: readonly SessionRow[]): Promise<void> {
  await act(async () => {
    const op = opFrames(h).filter((o) => o.op.op === "sessions").at(-1);
    h.server.socket.serverSend({ t: "result", id: op?.id, ok: rows });
  });
}

/** Push one server frame under act (a state/history frame drives React state). */
async function push(h: AppHarness, frame: unknown): Promise<void> {
  await act(async () => {
    h.server.socket.serverSend(frame);
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  window.localStorage.removeItem("wudao.ui.v1");
});

describe("多 driver 弧 C — App 车道化", () => {
  it("主车道 busy 不再拦切换：侧栏点开新车道（resume 带 sid），车道 history 接管视图，主车道内容不渲染", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, { sessionId: "wudao-main-0001" }, [{ kind: "user", text: "主车道消息" }]);
    });
    // 能力在场（空 lanes）+ 主车道 busy —— 旧世界这里切换是被拒的。
    await push(h, { t: "state", state: statusFrame({ busy: true }), lanes: {} });
    await replySettings(h, "buddy");
    await replySessions(h, [mainRow(), row()]);
    await act(async () => {
      (h.container.querySelectorAll(".sb-i")[1] as HTMLElement).click();
    });
    // 无 busy 拒绝回执；resume op 已带 sid 发出（开新车道）。
    expect(h.container.textContent).not.toContain("运行中无法 切换会话");
    const resumeOp = opFrames(h).find((o) => o.op.op === "resume");
    expect(resumeOp?.op).toMatchObject({ id: "sess-lane-b" });
    const sid = (resumeOp?.op as { sid?: string }).sid;
    expect(typeof sid).toBe("string");
    // server 侧车道落地：ok 回执 + 车道状态 + 车道 reset 重放（带同一 sid）。
    await act(async () => {
      h.server.socket.serverSend({ t: "result", id: resumeOp?.id, ok: { ok: true } });
      h.server.socket.serverSend({ t: "state", state: statusFrame({ busy: true }), lanes: { [sid as string]: { busy: false, sessionId: "sess-lane-b" } } });
      h.server.socket.serverSend({ t: "history", entries: [{ kind: "user", text: "车道B的消息" }], reset: true, sid });
    });
    // 视图=车道 history（分键渲染：主车道消息不在车道视图里）。
    expect(h.container.textContent).toContain("车道B的消息");
    expect(h.container.textContent).not.toContain("主车道消息");
    // 已开车道的会话再点一次：纯视图切换（不再发 resume）。
    await act(async () => {
      (h.container.querySelectorAll(".sb-i")[0] as HTMLElement).click(); // 回主车道
      (h.container.querySelectorAll(".sb-i")[1] as HTMLElement).click(); // 再看车道
    });
    expect(h.container.textContent).toContain("车道B的消息");
    expect(opFrames(h).filter((o) => o.op.op === "resume")).toHaveLength(1);
  });

  it("侧栏「运行中」徽标：busy 车道的会话行挂 .sb-run；老 server（无 lanes）零徽标", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, { sessionId: "wudao-main-0001" });
    });
    await replySettings(h, "buddy");
    await replySessions(h, [mainRow(), row()]);
    // 老 server：主车道 busy 也没有徽标（能力缺席=面隐藏，字节不变）。
    await push(h, { t: "state", state: statusFrame({ busy: true }) });
    expect(h.container.querySelectorAll(".sb-run")).toHaveLength(0);
    // 车道化 server：busy 车道的会话行挂徽标（主车道 busy 的行同款）。
    await act(async () => {
      h.server.socket.serverSend({
        t: "state",
        state: statusFrame({ busy: false }),
        lanes: { L1: { busy: true, sessionId: "sess-lane-b" } },
      });
    });
    const runRows = h.container.querySelectorAll(".sb-run");
    expect(runRows).toHaveLength(1);
    expect(runRows[0]?.closest(".sb-i")?.textContent).toContain("车道B的首句");
    // busy 翻转 → 徽标随下一帧消失。
    await act(async () => {
      h.server.socket.serverSend({
        t: "state",
        state: statusFrame({ busy: false }),
        lanes: { L1: { busy: false, sessionId: "sess-lane-b" } },
      });
    });
    expect(h.container.querySelectorAll(".sb-run")).toHaveLength(0);
  });

  // 0.5.11 报障修（Buddy 模式切模型不生效）：副车道视图里模型 chip 读车道
  // 自己的 model（wire 全量状态此前被客户端类型收窄丢弃），/provider 切换
  // 随视图车道 sid 提交——此前一律打主驱动，车道会话纹丝不动（用户报障：
  // glm-code 配额用尽后切 deepseek，会话仍报 glm-code 配额用尽）。
  it("副车道视图的模型 chip：显示车道自己的模型，跨 provider 选择随车道 sid 提交 /provider", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, { sessionId: "wudao-main-0001" });
    });
    await replySettings(h, "buddy");
    await replySessions(h, [mainRow(), row()]);
    // capable 先行（空 lanes 帧）——否则侧栏点击走老单车道路径（裸 resume 无
    // sid），后续车道帧就无处落。同款时序见本 describe 第一例。
    await push(h, { t: "state", state: statusFrame({ busy: false }), lanes: {} });
    // 开车道（侧栏点击 → resume 带 sid → ok 回执 + 车道状态带 model 块 + reset 重放）。
    await act(async () => {
      (h.container.querySelectorAll(".sb-i")[1] as HTMLElement).click();
    });
    const resumeOp = opFrames(h).filter((o) => o.op.op === "resume").at(-1);
    const sid = (resumeOp?.op as { sid?: string }).sid;
    expect(typeof sid).toBe("string");
    if (sid === undefined) return;
    await act(async () => {
      h.server.socket.serverSend({ t: "result", id: resumeOp?.id, ok: { ok: true } });
      h.server.socket.serverSend({
        t: "state",
        state: statusFrame({ busy: false }),
        lanes: {
          [sid]: {
            busy: false,
            sessionId: "sess-lane-b",
            model: {
              label: "glm-5.3",
              provider: "glm-code",
              choices: [
                { provider: "glm-code", model: "glm-5.3", source: "registry" },
                { provider: "deepseek", model: "deepseek-v3.2", source: "registry" },
              ],
            },
          },
        },
      });
      h.server.socket.serverSend({ t: "history", entries: [{ kind: "user", text: "车道B的消息" }], reset: true, sid });
    });
    expect(h.container.textContent).toContain("车道B的消息");
    // chip 显示车道自己的模型（不是主车道的）。
    const chip = h.container.querySelector<HTMLButtonElement>(".composer-tools .chip.model");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("glm-5.3");
    // 跨 provider 选择 deepseek → /provider 随车道 sid 提交（绝不裸打主车道）。
    await act(async () => {
      chip!.click();
    });
    await act(async () => {
      (h.container.querySelector<HTMLButtonElement>('.menu .mroot .mi.mprov[data-provider="deepseek"]') as HTMLElement).click();
    });
    await act(async () => {
      (h.container.querySelector<HTMLButtonElement>('.menu .mi[data-model="deepseek-v3.2"]') as HTMLElement).click();
    });
    const submitOps = opFrames(h).filter((o) => o.op.op === "submit");
    const last = submitOps.at(-1)?.op;
    expect(last).toMatchObject({ text: "/provider deepseek", sid });
    // 主车道（sid 缺省）从未收到过这条命令。
    expect(submitOps.some((o) => o.op.text === "/provider deepseek" && o.op.sid === undefined)).toBe(false);
  });

  it("老 server 回归钉：主车道 busy 时侧栏点击仍被拒（无 resume op、中文拒绝回执）", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, { sessionId: "wudao-main-0001" });
    });
    await replySettings(h, "buddy");
    await replySessions(h, [mainRow(), row()]);
    await act(async () => {
      h.server.socket.serverSend({ t: "state", state: statusFrame({ busy: true }) });
    });
    await act(async () => {
      (h.container.querySelectorAll(".sb-i")[1] as HTMLElement).click();
    });
    expect(opFrames(h).find((o) => o.op.op === "resume")).toBeUndefined();
    expect(h.container.textContent).toContain("运行中无法 切换会话（任务进行中）");
  });
});
