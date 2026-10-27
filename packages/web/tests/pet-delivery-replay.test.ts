// ω99-115 — 错过沿的补递达（B 半：web 侧 mountPetDelivery 重放补递）. RED-first.
// 弧门后半：A 半让「关过 app 的提醒」在重开后照常触发并写入 history；本半
// 让宠物在「重放」（首连 / 断线重连，historyEpoch 重置=整段替换重放）时把
// 错过 busy 下降沿的 scheduled 完成轮补送到脸上——现状 epoch 重置只重置基线
// 不判沿，错过即静默哑火。
//
// 语义（brief B，一字不差）：
// - historyEpoch 重置基线时（含首连）扫 tail：只递最后一条 scheduled turn，
//   且仅当它是「最近一个完成的轮」——其后无普通 user turn（老提醒重放不打
//   扰新对话）。
// - 重连（epoch 变更）同上判据 + 页内内存去重（记 lastDeliveredIndex/taskId；
//   页面刷新重发一次=接受上限）。
// - 沿判定与补递互斥去重：同一 scheduled turn 走了沿就不走补递（共享
//   lastDelivered）。
// - 复用 105 全部纯函数；零新事件（照发 WUDAO_PET_DELIVERY_EVENT）；零协议改动。
import { describe, it, expect, vi } from "vitest";
import { WUDAO_PET_DELIVERY_EVENT, mountPetDelivery } from "../src/pet/delivery.js";
import type { DriverStatus, HistoryEntry, UiSnapshot } from "../src/protocol.js";

const u = (text: string): HistoryEntry => ({ kind: "user", text });
const a = (text: string): HistoryEntry => ({ kind: "assistant", text });
const tool = (): HistoryEntry => ({ kind: "tool", name: "Read", summary: "读文件" });
const INJ = "[scheduled task ab12cd34] 每天早上整理收件箱并汇报未读数";
const INJ2 = "[scheduled task ef56gh78] 下午复盘今日进展";

interface FakeClient {
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => UiSnapshot;
  __set: (s: Partial<UiSnapshot>) => void;
}
function fakeClient(): FakeClient {
  const listeners = new Set<() => void>();
  let snap: UiSnapshot = {
    connection: "connected", reconnectAttempt: 0, lastClose: null, status: null, history: [], historyEpoch: 0,
  };
  const notify = (): void => {
    for (const cb of listeners) cb();
  };
  return {
    subscribe: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getSnapshot: () => snap,
    __set: (s) => {
      snap = { ...snap, ...s };
      notify();
    },
  };
}
function status(busy: boolean): DriverStatus {
  return {
    live: { reasoning: "", answer: "", busyTools: [] },
    busy,
    queued: [],
    boardProgress: null,
    ctxTokens: null,
    mode: "workspace",
    cachePercent: null,
    bg: { active: 0, spawned: 0 },
    pendingPermission: null,
    planBoard: null,
    sessionId: "s",
    sidecar: null,
  };
}

describe("ω99-115 B — 重放补递（epoch 重置时补送错过的 scheduled 完成轮）", () => {
  it("首连：尾部有未观察的 scheduled 完成轮 → 发一次 pet-delivery（payload=组装结果）", () => {
    const client = fakeClient();
    const emit = vi.fn(async (): Promise<boolean> => true);
    mountPetDelivery(client, { emit });
    client.__set({
      status: status(false),
      history: [u("昨晚的普通问题"), a("旧答"), u(INJ), tool(), a("收件箱已整理")],
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(WUDAO_PET_DELIVERY_EVENT, {
      taskId: "ab12cd34",
      promptDigest: "每天早上整理收件箱并汇报未读数",
      answerDigest: "收件箱已整理",
    });
  });

  it("首连：其后已有普通用户轮 → 不发（老提醒重放不打扰新对话）", () => {
    const client = fakeClient();
    const emit = vi.fn(async (): Promise<boolean> => true);
    mountPetDelivery(client, { emit });
    client.__set({
      status: status(false),
      history: [u(INJ), a("答"), u("今早的新问题"), a("新答")],
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it("首连 busy=true（轮仍在飞）→ 不补递；同 epoch 完成沿照发（沿/补递互斥不打架）", () => {
    const client = fakeClient();
    const emit = vi.fn(async (): Promise<boolean> => true);
    mountPetDelivery(client, { emit });
    client.__set({ status: status(true), history: [u(INJ), tool()] });
    expect(emit).not.toHaveBeenCalled();
    client.__set({ status: status(false), history: [u(INJ), tool(), a("答")] });
    expect(emit).toHaveBeenCalledTimes(1); // 完成沿送达，不是补递抢先
  });

  it("非 scheduled 尾轮 → 不发", () => {
    const client = fakeClient();
    const emit = vi.fn(async (): Promise<boolean> => true);
    mountPetDelivery(client, { emit });
    client.__set({ status: status(false), history: [u("普通问题"), a("普通答")] });
    expect(emit).not.toHaveBeenCalled();
  });

  it("沿路径已递 → 重连（epoch 变更重放）不重发（互斥去重：共享 lastDelivered）", () => {
    const client = fakeClient();
    const emit = vi.fn(async (): Promise<boolean> => true);
    mountPetDelivery(client, { emit });
    client.__set({ status: status(true), historyEpoch: 0, history: [u(INJ), tool()] });
    client.__set({ status: status(false), history: [u(INJ), tool(), a("答")] });
    expect(emit).toHaveBeenCalledTimes(1); // 沿送达
    // 断线重连：reset 重放整段 history，同一完成轮不得再补发
    client.__set({ status: status(false), historyEpoch: 1, history: [u(INJ), tool(), a("答")] });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("重连补递：断线期间新完成的 scheduled 轮 → 补发一次", () => {
    const client = fakeClient();
    const emit = vi.fn(async (): Promise<boolean> => true);
    mountPetDelivery(client, { emit });
    // 首连时只有旧普通轮（无 scheduled 尾巴）
    client.__set({ status: status(false), historyEpoch: 0, history: [u("普通"), a("答")] });
    expect(emit).not.toHaveBeenCalled();
    // 断线期间 scheduled 轮触发并完成；重连 reset 重放带上了它
    client.__set({ status: status(false), historyEpoch: 1, history: [u("普通"), a("答"), u(INJ), tool(), a("收件箱已整理")] });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(WUDAO_PET_DELIVERY_EVENT, {
      taskId: "ab12cd34",
      promptDigest: "每天早上整理收件箱并汇报未读数",
      answerDigest: "收件箱已整理",
    });
  });

  it("补递后又一轮重放（epoch 再变、history 未变）→ 不重发（补递→补递去重）", () => {
    const client = fakeClient();
    const emit = vi.fn(async (): Promise<boolean> => true);
    mountPetDelivery(client, { emit });
    client.__set({ status: status(false), historyEpoch: 0, history: [u(INJ), a("答")] });
    expect(emit).toHaveBeenCalledTimes(1);
    client.__set({ status: status(false), historyEpoch: 1, history: [u(INJ), a("答")] });
    expect(emit).toHaveBeenCalledTimes(1);
    client.__set({ status: status(false), historyEpoch: 2, history: [u(INJ), a("答")] });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("同任务再次触发（新轮）→ 重连补递照发（taskId 相同但轮是新的一条）", () => {
    const client = fakeClient();
    const emit = vi.fn(async (): Promise<boolean> => true);
    mountPetDelivery(client, { emit });
    client.__set({ status: status(false), historyEpoch: 0, history: [u(INJ), a("第一次答")] });
    expect(emit).toHaveBeenCalledTimes(1);
    // 同一任务 id 的下一轮在断线期间完成 → 是新轮，补递照发
    client.__set({ status: status(false), historyEpoch: 1, history: [u(INJ), a("第一次答"), u(INJ), a("第二次答")] });
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith(WUDAO_PET_DELIVERY_EVENT, {
      taskId: "ab12cd34",
      promptDigest: "每天早上整理收件箱并汇报未读数",
      answerDigest: "第二次答",
    });
  });

  it("重连时尾部 scheduled 轮之后有普通用户轮 → 不发（重连同判据）", () => {
    const client = fakeClient();
    const emit = vi.fn(async (): Promise<boolean> => true);
    mountPetDelivery(client, { emit });
    client.__set({ status: status(false), historyEpoch: 0, history: [u("普通"), a("答")] });
    client.__set({ status: status(false), historyEpoch: 1, history: [u(INJ), a("答"), u("重连后的新手"), a("新答")] });
    expect(emit).not.toHaveBeenCalled();
  });

  it("非 scheduled 的新任务轮（无前缀）不触发；补递后 unmount 零 emit", () => {
    const client = fakeClient();
    const emit = vi.fn(async (): Promise<boolean> => true);
    const unmount = mountPetDelivery(client, { emit });
    client.__set({ status: status(false), historyEpoch: 0, history: [u(INJ2.replace("[scheduled task ef56gh78] ", "")), a("答")] });
    expect(emit).not.toHaveBeenCalled();
    unmount();
    client.__set({ status: status(false), historyEpoch: 1, history: [u(INJ), a("答")] });
    expect(emit).not.toHaveBeenCalled();
  });
});
