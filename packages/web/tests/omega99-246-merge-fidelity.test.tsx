// @vitest-environment jsdom
// ω99-246: #1 — web 转录两路合流的保真 R 件（身份合并/终态不回退/快照-增量
// 次序/聚合面受益/单源回归）。侦察结论钉进断言：
//   合流点   UiSnapshot 的装配在 WudaoClient（protocol.ts onMessage 的
//            history 分支：reset:true=整替、否则=追加）；渲染层 HistoryList+
//            LiveArea 是两条各自单源的车道（落定行 vs 在飞行），同一行双现
//            的唯一通路是「被换代 socket 的在途尾帧」——重连/恢复后新 socket
//            的权威重放已含该行，旧 socket 同一帧迟到再到达即双现/回退。
//   身份键   HistoryEntry 帧上无任何稳定 id（实况）；LiveBusyTool 有可选
//            callId 但历史行没有对应键，跨车道按 id 合并在我方帧上不成立
//            （不臆造 id）。帧上实有的唯一次序信号 = 连接代（socket 身份）
//            与客户端自增的 historyEpoch——纪律落在流身份：同一代流=唯一
//            来源，被换代流的帧永不并流。
//   聚合面   216（aggregateSessionChanges）与 219（aggregateComputerActions）
//            都是对 snap.history 的纯折叠（App.tsx:1264/1270）——吃的就是
//            合并后的同一条流，流修好即自动受益（R4 验明，不改面板）。
// 全 mock（mock-ws 范式）：零真网络零真模型；旧 socket 的迟到帧用
// server.sockets[0].serverSend 直接构造（真实传输里是 close 事件先到、
// 在途 message 后到的竞态，mock 把它钉成确定序）。
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WudaoClient } from "../src/protocol.js";
import type { DriverStatus, HistoryEntry } from "../src/protocol.js";
import { App } from "../src/components/App.js";
import { aggregateSessionChanges } from "../src/components/ChangesPanel.js";
import { aggregateComputerActions } from "../src/components/ComputerActionsPanel.js";
import { authOk, fakeServer } from "./mock-ws.js";
import type { FakeServer, FakeWebSocket } from "./mock-ws.js";

interface Harness {
  client: WudaoClient;
  server: FakeServer;
  timers: ((() => void) | undefined)[];
}

function makeClient(): Harness {
  const server = fakeServer();
  const timers: ((() => void) | undefined)[] = [];
  const client = new WudaoClient({
    url: "ws://127.0.0.1:9999",
    token: "sekrit",
    wsFactory: () => server.spawn(),
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length - 1;
    },
    clearTimeout: (h) => {
      if (typeof h === "number") timers[h] = undefined;
    },
  });
  return { client, server, timers };
}

/** 被换代的旧 socket（sockets[0]）——noUncheckedIndexedAccess 下的显式收窄：
 *  connected() 保证至少一只 socket 存在，缺席即测试装配坏了。 */
function oldSocket(h: Harness): FakeWebSocket {
  const s = h.server.sockets[0];
  if (s === undefined) throw new Error("no superseded socket — the harness never connected");
  return s;
}

/** connect + open + auth → connected；返回后 server.sockets[0] 是旧 socket。 */
function connected(history: readonly unknown[] = []): Harness {
  const h = makeClient();
  h.client.connect();
  h.server.socket.serverOpen();
  authOk(h.server.socket, {}, history);
  return h;
}

/** 断线 → 点火重连计时器 → 新 socket 握手（authOk 全量重放走新 socket）。 */
function reconnected(h: Harness, history: readonly unknown[] = [], status: Record<string, unknown> = {}): void {
  oldSocket(h).serverClose(1006, "");
  h.timers[0]?.();
  h.server.socket.serverOpen();
  authOk(h.server.socket, status, history);
}

describe("ω99-246 R1 身份合并 — 快照含已流过的同键行，恰一行不双现", () => {
  it("旧 socket 的在途尾帧（重放已含的同一 tool 行）绝不追加成第二行", () => {
    const h = connected([{ kind: "user", text: "帮我读配置" }]);
    const old = oldSocket(h);
    // live 流：读文件落定成终态行
    old.serverSend({ t: "history", entries: [{ kind: "tool", name: "read_file", summary: "app.config.ts" }] });
    expect(h.client.getSnapshot().history).toHaveLength(2);
    // 断线重连：新 socket 的权威重放已含该行
    reconnected(h, [
      { kind: "user", text: "帮我读配置" },
      { kind: "tool", name: "read_file", summary: "app.config.ts" },
      { kind: "assistant", text: "读完了" },
    ]);
    // 旧 socket 的同一帧在 close 之后迟到到达（在途竞态）
    old.serverSend({ t: "history", entries: [{ kind: "tool", name: "read_file", summary: "app.config.ts" }] });
    expect(h.client.getSnapshot().history).toEqual([
      { kind: "user", text: "帮我读配置" },
      { kind: "tool", name: "read_file", summary: "app.config.ts" },
      { kind: "assistant", text: "读完了" },
    ]);
  });

  it("旧 socket 的尾帧在重连尚未握手期间到达，同样不并入（换代即断流）", () => {
    const h = connected([{ kind: "user", text: "hi" }]);
    const old = oldSocket(h);
    old.serverSend({ t: "history", entries: [{ kind: "assistant", text: "答" }] });
    old.serverClose(1006, "");
    // 计时器已点火但新 socket 未握手——旧 socket 的在途尾帧到达
    h.timers[0]?.();
    old.serverSend({ t: "history", entries: [{ kind: "assistant", text: "答" }] });
    authOk(h.server.socket, {}, [{ kind: "user", text: "hi" }, { kind: "assistant", text: "答" }]);
    expect(h.client.getSnapshot().history).toEqual([
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "答" },
    ]);
  });
});

describe("ω99-246 R2 终态不回退 — 迟到旧快照不得把落定行打回运行中", () => {
  it("已落定的 tool 行 + 已清空的 busy 车道，旧 socket 的旧 state 帧复活不了", () => {
    const h = connected();
    const base = h.client.getSnapshot().status as DriverStatus;
    const old = oldSocket(h);
    // 在飞：busy 车道有该调用
    old.serverSend({
      t: "state",
      state: { ...base, busy: true, live: { ...base.live, busyTools: [{ name: "read_file", summary: "a.txt", callId: "c1" }] } },
    });
    // 落定：终态行进历史 + busy 车道清空（driver 同序）
    old.serverSend({ t: "history", entries: [{ kind: "tool", name: "read_file", summary: "a.txt" }] });
    old.serverSend({ t: "state", state: base });
    expect(h.client.getSnapshot().status?.busy).toBe(false);
    // 断线重连：重放含终态行、状态空闲
    reconnected(h, [
      { kind: "user", text: "读 a.txt" },
      { kind: "tool", name: "read_file", summary: "a.txt" },
    ]);
    // 旧 socket 落定前的 state 帧（busy=true、busyTools 还有 c1）迟到
    old.serverSend({
      t: "state",
      state: { ...base, busy: true, live: { ...base.live, busyTools: [{ name: "read_file", summary: "a.txt", callId: "c1" }] } },
    });
    const snap = h.client.getSnapshot();
    expect(snap.status?.busy).toBe(false);
    expect(snap.status?.live.busyTools).toEqual([]);
    // 终态行原样在历史（恰一行）
    expect(snap.history).toEqual([
      { kind: "user", text: "读 a.txt" },
      { kind: "tool", name: "read_file", summary: "a.txt" },
    ]);
  });
});

describe("ω99-246 R3 快照-增量次序 — 增量先应用后合并，迟到旧快照滚不回", () => {
  it("已应用的增量被权威重放整替收编（无半行、无丢行），epoch 恰 +1", () => {
    const h = connected([{ kind: "user", text: "u" }]);
    const old = oldSocket(h);
    old.serverSend({ t: "history", entries: [{ kind: "tool", name: "bash", summary: "npm test" }] });
    const epoch0 = h.client.getSnapshot().historyEpoch;
    reconnected(h, [
      { kind: "user", text: "u" },
      { kind: "tool", name: "bash", summary: "npm test" },
      { kind: "assistant", text: "绿" },
    ]);
    const snap = h.client.getSnapshot();
    expect(snap.history).toEqual([
      { kind: "user", text: "u" },
      { kind: "tool", name: "bash", summary: "npm test" },
      { kind: "assistant", text: "绿" },
    ]);
    expect(snap.historyEpoch).toBe(epoch0 + 1); // 重放=替换被认出
  });

  it("旧 socket 的迟到 reset（比新重放更旧）滚不回已合并的行", () => {
    const h = connected([{ kind: "user", text: "u" }]);
    const old = oldSocket(h);
    old.serverSend({ t: "history", entries: [{ kind: "tool", name: "bash", summary: "step1" }] });
    reconnected(h, [
      { kind: "user", text: "u" },
      { kind: "tool", name: "bash", summary: "step1" },
      { kind: "tool", name: "bash", summary: "step2" },
    ]);
    const epoch = h.client.getSnapshot().historyEpoch;
    // 旧 socket 的 reset 帧在 close 前已发出、close 后才到达（快照比新重放旧）
    old.serverSend({ t: "history", entries: [{ kind: "user", text: "u" }], reset: true });
    const snap = h.client.getSnapshot();
    expect(snap.history).toEqual([
      { kind: "user", text: "u" },
      { kind: "tool", name: "bash", summary: "step1" },
      { kind: "tool", name: "bash", summary: "step2" },
    ]);
    expect(snap.historyEpoch).toBe(epoch); // 迟到旧 reset 不再顶替、不再顶 epoch
  });

  it("重放之后到达的增量照常应用（当前代流不受影响）", () => {
    const h = connected([{ kind: "user", text: "u" }]);
    oldSocket(h).serverSend({ t: "history", entries: [{ kind: "tool", name: "bash", summary: "step1" }] });
    reconnected(h, [{ kind: "user", text: "u" }, { kind: "tool", name: "bash", summary: "step1" }]);
    h.server.socket.serverSend({ t: "history", entries: [{ kind: "assistant", text: "后续增量" }] });
    expect(h.client.getSnapshot().history).toEqual([
      { kind: "user", text: "u" },
      { kind: "tool", name: "bash", summary: "step1" },
      { kind: "assistant", text: "后续增量" },
    ]);
  });
});

describe("ω99-246 R4 聚合面受益 — 216/219 吃合并后的同一条流，计数不漂移", () => {
  it("216 轮分组与 219 步数在「重放已含 + 尾帧重放」场景下不翻倍（纯折叠直钉）", () => {
    const receipt: HistoryEntry = {
      kind: "notice",
      text: "本轮改动",
      changes: [{ path: "src/a.ts", op: "modified", writes: 1 }],
    };
    const click: HistoryEntry = { kind: "tool", name: "computer.click", summary: "按钮 提交" };
    const h = connected([{ kind: "user", text: "跑一轮" }]);
    const old = oldSocket(h);
    old.serverSend({ t: "history", entries: [receipt, click] });
    reconnected(h, [{ kind: "user", text: "跑一轮" }, receipt, click]);
    // 旧 socket 的在途尾帧把收据与电脑操作各重放一遍
    old.serverSend({ t: "history", entries: [receipt, click] });
    const merged = h.client.getSnapshot().history;
    const agg216 = aggregateSessionChanges(merged);
    const agg219 = aggregateComputerActions(merged);
    expect(agg216.runs).toHaveLength(1); // 修复前 2（漂移）
    expect(agg216.fileCount).toBe(1);
    expect(agg219.totalSteps).toBe(1); // 修复前 2（chip 会显示「电脑操作 2 步」）
  });

  it("App 顶栏 chip 端到端：重连重放 + 迟到尾帧后仍读「电脑操作 1 步」", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const server = fakeServer();
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
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<App client={client} />);
    });
    act(() => {
      client.connect();
      server.socket.serverOpen();
      authOk(server.socket, {}, [{ kind: "user", text: "点一下" }]);
      server.socket.serverSend({ t: "history", entries: [{ kind: "tool", name: "computer.click", summary: "按钮 提交" }] });
    });
    const old = server.sockets[0];
    if (old === undefined) throw new Error("no superseded socket — the harness never connected");
    act(() => {
      old.serverClose(1006, "");
      timers[0]?.();
      server.socket.serverOpen();
      authOk(server.socket, {}, [
        { kind: "user", text: "点一下" },
        { kind: "tool", name: "computer.click", summary: "按钮 提交" },
      ]);
      old.serverSend({ t: "history", entries: [{ kind: "tool", name: "computer.click", summary: "按钮 提交" }] });
    });
    expect(container.textContent).toContain("电脑操作 1 步");
    expect(container.textContent).not.toContain("电脑操作 2 步");
    act(() => {
      root.unmount();
    });
  });
});

describe("ω99-246 R5 单源通路回归 — 纯 live / 纯重放行为不变", () => {
  it("纯 live：追加序即历史序，state 帧不动 history 身份与 epoch", () => {
    const h = connected([{ kind: "user", text: "u" }]);
    const base = h.client.getSnapshot().status as DriverStatus;
    const epoch = h.client.getSnapshot().historyEpoch;
    const before = h.client.getSnapshot();
    h.server.socket.serverSend({ t: "state", state: { ...base, busy: true } });
    expect(h.client.getSnapshot().history).toBe(before.history); // 身份不动（memo 依赖）
    h.server.socket.serverSend({ t: "history", entries: [{ kind: "assistant", text: "a" }, { kind: "tool", name: "bash", summary: "s" }] });
    expect(h.client.getSnapshot().history).toEqual([
      { kind: "user", text: "u" },
      { kind: "assistant", text: "a" },
      { kind: "tool", name: "bash", summary: "s" },
    ]);
    expect(h.client.getSnapshot().historyEpoch).toBe(epoch); // 追加绝不顶 epoch
  });

  it("纯重放：同代 reset 整替依旧成立（/resume 通路），epoch 逐次 +1", () => {
    const h = connected([{ kind: "user", text: "旧会话" }]);
    const epoch0 = h.client.getSnapshot().historyEpoch;
    h.server.socket.serverSend({ t: "history", entries: [{ kind: "user", text: "新会话" }, { kind: "assistant", text: "答" }], reset: true });
    const snap = h.client.getSnapshot();
    expect(snap.history).toEqual([{ kind: "user", text: "新会话" }, { kind: "assistant", text: "答" }]);
    expect(snap.historyEpoch).toBe(epoch0 + 1);
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  window.localStorage.removeItem("wudao.ui.v1");
});
