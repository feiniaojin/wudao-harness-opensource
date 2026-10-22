// ω99-105 — scheduled-task delivery (P1 送达半环), RED-first. The pure
// identification layer: the injection-prefix soft contract (a COPY of core's
// SCHEDULED_INJECTION_LEAD — web does not depend on core), the id parser,
// the turn assembly (60/80 digests), the history segmentation (the current
// turn's user texts — mid-turn steering injections included), and the wire
// parse for the pet-side listener.
import { describe, it, expect, vi } from "vitest";
import {
  SCHEDULED_TASK_LEAD,
  WUDAO_PET_DELIVERY_EVENT,
  isScheduledUserText,
  parseScheduledTaskId,
  deliveryFromTurn,
  deliveryFromHistory,
  readDelivery,
  mountPetDelivery,
} from "../src/pet/delivery.js";
import type { DriverStatus, HistoryEntry, UiSnapshot } from "../src/protocol.js";

const u = (text: string): HistoryEntry => ({ kind: "user", text });
const a = (text: string): HistoryEntry => ({ kind: "assistant", text });
const tool = (): HistoryEntry => ({ kind: "tool", name: "Read", summary: "读文件" });

const INJ = "[scheduled task ab12cd34] 每天早上整理收件箱并汇报未读数";

describe("ω99-105 前缀软契约（core SCHEDULED_INJECTION_LEAD 的 web 副本）", () => {
  it("SCHEDULED_TASK_LEAD 含尾随空格，与注入模板 `${LEAD} ${id}] ` 对齐", () => {
    expect(SCHEDULED_TASK_LEAD).toBe("[scheduled task ");
    expect(INJ.startsWith(SCHEDULED_TASK_LEAD)).toBe(true);
  });

  it("isScheduledUserText：前缀判断（含退化前缀；非前缀/中缀/少空格均否）", () => {
    expect(isScheduledUserText(INJ)).toBe(true);
    expect(isScheduledUserText("[scheduled task ")).toBe(true);
    expect(isScheduledUserText("普通手打提问")).toBe(false);
    expect(isScheduledUserText("[scheduled task] 少了空格")).toBe(false);
    expect(isScheduledUserText("前置文字 [scheduled task x] y")).toBe(false);
  });

  it("parseScheduledTaskId：到 ] 为止；无 ] → null；空 id → null", () => {
    expect(parseScheduledTaskId(INJ)).toBe("ab12cd34");
    expect(parseScheduledTaskId("[scheduled task 无闭合")).toBe(null);
    expect(parseScheduledTaskId("[scheduled task ] 空id")).toBe(null);
    expect(parseScheduledTaskId("普通文本")).toBe(null);
  });
});

describe("ω99-105 deliveryFromTurn（组装）", () => {
  it("非 scheduled（含空集合）→ null 不触发", () => {
    expect(deliveryFromTurn(["普通提问"], "回答")).toBe(null);
    expect(deliveryFromTurn([], "回答")).toBe(null);
  });

  it("scheduled → {taskId, promptDigest 去前缀头, answerDigest 首行}", () => {
    expect(deliveryFromTurn([INJ], "第一行答案\n第二行细节")).toEqual({
      taskId: "ab12cd34",
      promptDigest: "每天早上整理收件箱并汇报未读数",
      answerDigest: "第一行答案",
    });
  });

  it("多 user 任一命中（steering 注入也算）；digest 取 scheduled 那条", () => {
    expect(deliveryFromTurn(["手打第一句", INJ, "手打补充"], "答")).toEqual({
      taskId: "ab12cd34",
      promptDigest: "每天早上整理收件箱并汇报未读数",
      answerDigest: "答",
    });
  });

  it("无 ]（无 id 但仍算 scheduled）：taskId null，digest 用剩余文本", () => {
    expect(deliveryFromTurn(["[scheduled task 手打伪注入正文"], "答")).toEqual({
      taskId: null,
      promptDigest: "手打伪注入正文",
      answerDigest: "答",
    });
  });

  it("promptDigest 截 60 字；answerDigest 首行截 80 字", () => {
    const long = "p".repeat(100);
    expect(deliveryFromTurn([`[scheduled task ab12cd34] ${long}`], "答")?.promptDigest).toBe("p".repeat(60));
    expect(deliveryFromTurn([INJ], `${"答".repeat(100)}\n尾行`)?.answerDigest).toBe("答".repeat(80));
  });

  it("无 answer → 空串照发（任务可能产出为空）", () => {
    expect(deliveryFromTurn([INJ], "")).toEqual({
      taskId: "ab12cd34",
      promptDigest: "每天早上整理收件箱并汇报未读数",
      answerDigest: "",
    });
  });
});

describe("ω99-105 deliveryFromHistory（轮分段取证）", () => {
  it("跨 tool 取到注入与终答（canonical 定时任务轮）", () => {
    expect(deliveryFromHistory([u(INJ), tool(), a("收件箱已整理")])).toEqual({
      taskId: "ab12cd34",
      promptDigest: "每天早上整理收件箱并汇报未读数",
      answerDigest: "收件箱已整理",
    });
  });

  it("steering：轮内多条 user（含中途手打）都在集合内", () => {
    expect(deliveryFromHistory([u(INJ), tool(), u("顺带看下日历"), tool(), a("两件都办了")])).toEqual({
      taskId: "ab12cd34",
      promptDigest: "每天早上整理收件箱并汇报未读数",
      answerDigest: "两件都办了",
    });
  });

  it("多段 assistant 轮：lastAnswer 取最后一段（终答）", () => {
    expect(deliveryFromHistory([u(INJ), tool(), a("先说一段"), tool(), a("最终结论")])?.answerDigest).toBe("最终结论");
  });

  it("只看最后一轮：上一轮的 scheduled 不再触发（无假重复送达）", () => {
    expect(deliveryFromHistory([u(INJ), a("旧答案"), u("新问题"), a("新答案")])).toBe(null);
  });

  it("纯工具轮无 assistant 落定：answerDigest 空串照发", () => {
    expect(deliveryFromHistory([u(INJ), tool()])?.answerDigest).toBe("");
  });

  it("错误轮（error 条目收尾）：空 digest 送达，不误配上一轮答案", () => {
    const h: HistoryEntry[] = [a("上一轮答案"), u(INJ), tool(), { kind: "error", text: "boom" }];
    const d = deliveryFromHistory(h);
    expect(d?.taskId).toBe("ab12cd34");
    expect(d?.answerDigest).toBe("");
  });

  it("无 user 条目 / 空历史 → null", () => {
    expect(deliveryFromHistory([a("答案"), tool()])).toBe(null);
    expect(deliveryFromHistory([])).toBe(null);
  });
});

describe("ω99-105 readDelivery（wire parse）", () => {
  it("合法载荷 → PetDelivery；taskId 可为 null", () => {
    expect(readDelivery({ taskId: "ab12cd34", promptDigest: "p", answerDigest: "a" })).toEqual({
      taskId: "ab12cd34",
      promptDigest: "p",
      answerDigest: "a",
    });
    expect(readDelivery({ taskId: null, promptDigest: "p", answerDigest: "" })).toEqual({
      taskId: null,
      promptDigest: "p",
      answerDigest: "",
    });
  });

  it("畸形载荷整体丢弃：非对象 / 缺字段 / 类型错", () => {
    expect(readDelivery(null)).toBe(null);
    expect(readDelivery("x")).toBe(null);
    expect(readDelivery({ promptDigest: "p", answerDigest: "a" })).toBe(null);
    expect(readDelivery({ taskId: 7, promptDigest: "p", answerDigest: "a" })).toBe(null);
    expect(readDelivery({ taskId: null, promptDigest: 1, answerDigest: "a" })).toBe(null);
  });
});

// ---- mountPetDelivery：busy 下降沿 → 送达信号（注入 emit 的行为面） ----

interface FakeClient {
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => UiSnapshot;
  __set: (s: Partial<UiSnapshot>) => void;
  __listeners: () => number;
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
    __listeners: () => listeners.size,
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

describe("ω99-105 mountPetDelivery（busy 下降沿 → 送达信号）", () => {
  it("下降沿 + scheduled 轮 → emit pet-delivery 一次（payload=组装结果）", () => {
    const client = fakeClient();
    const emit = vi.fn(async (): Promise<boolean> => true);
    mountPetDelivery(client, { emit });
    client.__set({ status: status(true), history: [u(INJ), tool()] });
    client.__set({ status: status(false), history: [u(INJ), tool(), a("收件箱已整理")] });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(WUDAO_PET_DELIVERY_EVENT, {
      taskId: "ab12cd34",
      promptDigest: "每天早上整理收件箱并汇报未读数",
      answerDigest: "收件箱已整理",
    });
  });

  it("普通轮下降沿零 emit；上升沿不触发；首见 busy=false 不触发", () => {
    const client = fakeClient();
    const emit = vi.fn(async (): Promise<boolean> => true);
    mountPetDelivery(client, { emit });
    client.__set({ status: status(false) }); // 首见 false：无沿
    client.__set({ status: status(true), history: [u("普通问题")] }); // 上升
    client.__set({ status: status(false), history: [u("普通问题"), a("普通答案")] }); // 下降但非 scheduled
    expect(emit).not.toHaveBeenCalled();
  });

  it("非 connected 快照不判（断线不触发）", () => {
    const client = fakeClient();
    const emit = vi.fn(async (): Promise<boolean> => true);
    mountPetDelivery(client, { emit });
    client.__set({ connection: "reconnecting", status: status(true), history: [u(INJ)] });
    expect(emit).not.toHaveBeenCalled();
    client.__set({ connection: "connected", status: status(true), history: [u(INJ), tool()] });
    client.__set({ connection: "connected", status: status(false), history: [u(INJ), tool(), a("答")] });
    expect(emit).toHaveBeenCalledTimes(1); // 沿只认 connected 段内的真沿
  });

  it("historyEpoch 变化重置 lastBusy：replay 无假沿（补递送的是重放轮本身）；此后真沿照发", () => {
    const client = fakeClient();
    const emit = vi.fn(async (): Promise<boolean> => true);
    mountPetDelivery(client, { emit });
    client.__set({ status: status(true), historyEpoch: 0, history: [u(INJ), tool()] });
    // 重连 replay：epoch++ 且 busy 已 false —— 旧 lastBusy=true 不得造成假沿；
    // ω99-115 补递：重放的尾部有未观察的 scheduled 完成轮 → 补发一次（此即
    // 本弧所修的哑火：补递走的是重放轮本身，不是拿旧 lastBusy 判沿）。
    client.__set({ status: status(false), historyEpoch: 1, history: [u(INJ), tool(), a("答")] });
    expect(emit).toHaveBeenCalledTimes(1);
    // 同一重放轮再来一轮 epoch 重置不得二送（页内去重）
    client.__set({ status: status(false), historyEpoch: 2, history: [u(INJ), tool(), a("答")] });
    expect(emit).toHaveBeenCalledTimes(1);
    // 同 epoch 内的真沿照常送达（新一轮完成）
    client.__set({ status: status(true), history: [u(INJ), tool(), a("答"), u(INJ)] });
    client.__set({ status: status(false), history: [u(INJ), tool(), a("答"), u(INJ), a("答2")] });
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("emit 拒绝被吞（fire-and-forget，无 unhandled rejection）", async () => {
    const client = fakeClient();
    const emit = vi.fn((): Promise<boolean> => Promise.reject(new Error("ipc down")));
    mountPetDelivery(client, { emit });
    client.__set({ status: status(true), history: [u(INJ)] });
    client.__set({ status: status(false), history: [u(INJ), a("答")] });
    await new Promise((r) => setTimeout(r, 0)); // 微任务落定
    expect(emit).toHaveBeenCalledTimes(1); // 发过即算（99 弧纪律）
  });

  it("unmount 后快照变化零 emit", () => {
    const client = fakeClient();
    const emit = vi.fn(async (): Promise<boolean> => true);
    const unmount = mountPetDelivery(client, { emit });
    unmount();
    expect(client.__listeners()).toBe(0);
    client.__set({ status: status(true), history: [u(INJ)] });
    client.__set({ status: status(false), history: [u(INJ), a("答")] });
    expect(emit).not.toHaveBeenCalled();
  });
});
