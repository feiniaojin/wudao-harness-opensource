// @vitest-environment jsdom
// ω99-235: #12 — 小精灵会话隔离：web 域行为面，先红后绿。①relay 的 ask/划词/应答
// 三监听随 snap.pet 在场与否分流（petSubmit/petAnswerPermission vs 主车道
// submit/answerPermission——旧服务端兼容降级钉）；②帧派生源切换
// （derivePetFrame({status: snap.pet})——pet-frame.ts 零改）；③主车道 ask 在
// pet 源下不进精灵帧（隔离钉）；④断线 idle 语义 pet 源下成立；⑤侧栏
// lane:"pet" 行：徽标「小精灵」+点击 toast「精灵会话在精灵窗口继续」+零
// resume。pet-frame.ts 与 Bubble.tsx 零改（纯函数面/纯发送面）。泵测试的
// now 可变（pet-relay.test.ts 范式）：同值帧会被等值短路吃掉，跨窗口推送
// 之间推进 PET_EMIT_MS。
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { mountPetRelay } from "../src/pet/relay.js";
import { IDLE_PET_FRAME, PET_EMIT_MS, WUDAO_PET_ASK_EVENT, WUDAO_PET_ANSWER_EVENT, WUDAO_PET_STATE_EVENT, WUDAO_PET_TOAST_EVENT, derivePetFrame } from "../src/pet/pet-frame.js";
import { WUDAO_PET_SELECTION_SUBMIT_EVENT } from "../src/pet/selection.js";
import { SessionSidebar } from "../src/components/SessionSidebar.js";
import type { DriverStatus, SubmitOutcome, UiSnapshot } from "../src/protocol.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// --- fake client（pet-relay.test.ts 的范式 + pet 字段控制） ------------------

type FakeClient = {
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => UiSnapshot;
  submit: ReturnType<typeof vi.fn<(t: string) => Promise<SubmitOutcome>>>;
  answerPermission: ReturnType<typeof vi.fn<(allow: boolean, reason?: string, scope?: "session" | "always") => Promise<boolean>>>;
  petSubmit: ReturnType<typeof vi.fn<(t: string) => Promise<SubmitOutcome>>>;
  petAnswerPermission: ReturnType<typeof vi.fn<(allow: boolean, reason?: string, scope?: "session" | "always") => Promise<boolean>>>;
  /** ω99-271: #11 — mountPetRelay 的 Pick 契约新增成员（历史代取）：车道
   *  live 时 wudao-pet-history-req 走它（271 的历史行为面在本弧专测文件）。 */
  petHistory: ReturnType<typeof vi.fn<() => Promise<readonly { q: string; a: string }[]>>>;
  __set: (s: UiSnapshot["status"]) => void;
  __setPet: (p: UiSnapshot["pet"]) => void;
  __setConnection: (c: UiSnapshot["connection"]) => void;
};

function fakeClient(): FakeClient {
  const listeners = new Set<() => void>();
  let snap: UiSnapshot = {
    connection: "connected", reconnectAttempt: 0, lastClose: null, status: null, history: [], historyEpoch: 0,
  };
  const notify = (): void => { for (const cb of listeners) cb(); };
  return {
    subscribe: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    getSnapshot: () => snap,
    submit: vi.fn(async () => "started" as SubmitOutcome),
    answerPermission: vi.fn(async () => true),
    petSubmit: vi.fn(async () => "started" as SubmitOutcome),
    petAnswerPermission: vi.fn(async () => true),
    petHistory: vi.fn(async () => [] as readonly { q: string; a: string }[]),
    __set: (s) => { snap = { ...snap, status: s }; notify(); },
    __setPet: (p) => { snap = { ...snap, pet: p }; notify(); },
    __setConnection: (c) => { snap = { ...snap, connection: c }; notify(); },
  };
}

const idleStatus = (over: Partial<DriverStatus> = {}): DriverStatus => ({
  live: { reasoning: "", answer: "", busyTools: [] },
  busy: false, queued: [], boardProgress: null, ctxTokens: null, mode: "workspace", cachePercent: null,
  bg: { active: 0, spawned: 0 }, pendingPermission: null, planBoard: null, sessionId: "s", sidecar: null,
  ...over,
});

const busyStatus = (over: Partial<DriverStatus> = {}): DriverStatus => idleStatus({
  busy: true,
  live: { reasoning: "想", answer: "答".repeat(600), busyTools: [{ name: "Read", summary: "" }] },
  ...over,
});

const askOf = (toolName: string): DriverStatus["pendingPermission"] => ({
  toolName, summary: "摘要", input: {},
});

/** 挂 relay 并按事件名捕获 handler（listen mock 分发）。 */
function mountRelay(client: FakeClient): { handlers: Map<string, (p: unknown) => void>; unmount: () => void } {
  const handlers = new Map<string, (p: unknown) => void>();
  const unmount = mountPetRelay(client, {
    emit: vi.fn(async () => true),
    listen: vi.fn(async (e: string, h: (p: unknown) => void) => { handlers.set(e, h); return () => {}; }),
    now: () => 0,
    submit: client.submit,
  });
  return { handlers, unmount };
}

describe("ω99-235 relay 车道分流（ask/划词/应答）", () => {
  it("(a1) snap.pet 在场 → ask 走 petSubmit（trim 后文本），主 submit 零调", async () => {
    const client = fakeClient();
    const { handlers, unmount } = mountRelay(client);
    client.__setPet(idleStatus({ sessionId: "pet" }));
    handlers.get(WUDAO_PET_ASK_EVENT)!({ text: "  精灵的问题  " });
    await Promise.resolve();
    expect(client.petSubmit).toHaveBeenCalledTimes(1);
    expect(client.petSubmit).toHaveBeenCalledWith("精灵的问题");
    expect(client.submit).not.toHaveBeenCalled();
    unmount();
  });

  it("(a2) snap.pet 在场 → 划词接单走 petSubmit；空白载荷同守卫", async () => {
    const client = fakeClient();
    const { handlers, unmount } = mountRelay(client);
    client.__setPet(idleStatus({ sessionId: "pet" }));
    handlers.get(WUDAO_PET_SELECTION_SUBMIT_EVENT)!({ text: "  翻译这段  " });
    handlers.get(WUDAO_PET_SELECTION_SUBMIT_EVENT)!({ text: "   " });
    await Promise.resolve();
    expect(client.petSubmit).toHaveBeenCalledTimes(1);
    expect(client.petSubmit).toHaveBeenCalledWith("翻译这段");
    expect(client.submit).not.toHaveBeenCalled();
    unmount();
  });

  it("(b1) snap.pet 缺席 → 降级旧路：ask 走主 submit（旧服务端兼容钉）", async () => {
    const client = fakeClient();
    const { handlers, unmount } = mountRelay(client);
    client.__set(busyStatus()); // 有主 status、无 pet 字段
    handlers.get(WUDAO_PET_ASK_EVENT)!({ text: "旧服务端下的提问" });
    await Promise.resolve();
    expect(client.submit).toHaveBeenCalledTimes(1);
    expect(client.submit).toHaveBeenCalledWith("旧服务端下的提问");
    expect(client.petSubmit).not.toHaveBeenCalled();
    unmount();
  });

  it("(c1) answer 分流：pet 源 → petAnswerPermission；主源（降级）→ 旧 answerPermission", async () => {
    const client = fakeClient();
    const { handlers, unmount } = mountRelay(client);
    client.__setPet(idleStatus({ sessionId: "pet" }));
    handlers.get(WUDAO_PET_ANSWER_EVENT)!({ allow: true, scope: "always" });
    await Promise.resolve();
    expect(client.petAnswerPermission).toHaveBeenCalledWith(true, undefined, "always");
    expect(client.answerPermission).not.toHaveBeenCalled();

    client.__setPet(undefined); // 服务端掉回旧形状（或 pet 车道消失）
    handlers.get(WUDAO_PET_ANSWER_EVENT)!({ allow: false });
    await Promise.resolve();
    expect(client.answerPermission).toHaveBeenCalledWith(false, undefined, undefined);
    expect(client.petAnswerPermission).toHaveBeenCalledTimes(1);
    unmount();
  });
});

describe("ω99-235 帧派生源切换与断线语义", () => {
  it("(a3) pet 源：帧只由 snap.pet 派生（主 status 缺席也发）", () => {
    const client = fakeClient();
    const petBusy = busyStatus({ sessionId: "pet" });
    let t = 0;
    const emits: unknown[][] = [];
    const unmount = mountPetRelay(client, {
      emit: vi.fn(async (_e: string, p: unknown) => { emits.push([_e, p]); return true; }),
      listen: vi.fn(async () => null),
      now: () => t,
      submit: client.submit,
    });
    client.__setPet(petBusy); // 主 status 仍 null
    expect(emits).toEqual([[WUDAO_PET_STATE_EVENT, derivePetFrame({ status: petBusy })]]);
    unmount();
  });

  it("(b2) 主源降级：pet 缺席时帧照旧由主 status 派生（ω99-99 行为钉）", () => {
    const client = fakeClient();
    const mainBusy = busyStatus();
    let t = 0;
    const emits: unknown[][] = [];
    const unmount = mountPetRelay(client, {
      emit: vi.fn(async (_e: string, p: unknown) => { emits.push([_e, p]); return true; }),
      listen: vi.fn(async () => null),
      now: () => t,
      submit: client.submit,
    });
    client.__set(mainBusy);
    expect(emits).toEqual([[WUDAO_PET_STATE_EVENT, derivePetFrame({ status: mainBusy })]]);
    unmount();
  });

  it("(d) 隔离钉：pet 源下主车道的 ask/忙不进精灵帧（帧只读 pet 的状态）", () => {
    const client = fakeClient();
    const mainBusyAsk = busyStatus({ pendingPermission: askOf("Bash"), sessionId: "main" });
    const petIdle = idleStatus({ sessionId: "pet" });
    let t = 0;
    const emits: unknown[][] = [];
    const unmount = mountPetRelay(client, {
      emit: vi.fn(async (_e: string, p: unknown) => { emits.push([_e, p]); return true; }),
      listen: vi.fn(async () => null),
      now: () => t,
      submit: client.submit,
    });
    client.__set(mainBusyAsk); // 主车道挂着权限卡 + 忙
    t += PET_EMIT_MS;
    client.__setPet(petIdle); // pet 源接管——帧必须来自 pet 的空闲态
    expect(emits.length).toBe(2);
    const frame = emits[1]![1] as { ask: unknown; pendingPermission: boolean; busy: boolean };
    expect(frame.ask).toBeNull(); // 主窗的 Bash 卡不进精灵帧
    expect(frame.pendingPermission).toBe(false);
    expect(frame.busy).toBe(false); // 主窗忙不映进精灵帧（纯隔离）
    unmount();
  });

  it("(d2) pet 自己的 ask 进帧（正向钉：卡片随车道走）", () => {
    const client = fakeClient();
    const petAsk = busyStatus({ pendingPermission: askOf("write_file"), sessionId: "pet" });
    let t = 0;
    const emits: unknown[][] = [];
    const unmount = mountPetRelay(client, {
      emit: vi.fn(async (_e: string, p: unknown) => { emits.push([_e, p]); return true; }),
      listen: vi.fn(async () => null),
      now: () => t,
      submit: client.submit,
    });
    client.__setPet(petAsk);
    expect(emits).toEqual([[WUDAO_PET_STATE_EVENT, derivePetFrame({ status: petAsk })]]);
    const frame = emits[0]![1] as { ask: { toolName: string } | null };
    expect(frame.ask?.toolName).toBe("write_file");
    unmount();
  });

  it("(f1) 断线 idle 语义 pet 源下成立：真 pet 帧后 connection 离开 connected → 补 IDLE", () => {
    const client = fakeClient();
    const petBusy = busyStatus({ live: { reasoning: "想", answer: "精灵答".repeat(600), busyTools: [] }, sessionId: "pet" });
    let t = 0;
    const emits: unknown[][] = [];
    const unmount = mountPetRelay(client, {
      emit: vi.fn(async (_e: string, p: unknown) => { emits.push([_e, p]); return true; }),
      listen: vi.fn(async () => null),
      now: () => t,
      submit: client.submit,
    });
    client.__setPet(petBusy); // pet 源真帧（busy）
    expect(emits).toEqual([[WUDAO_PET_STATE_EVENT, derivePetFrame({ status: petBusy })]]);
    t += PET_EMIT_MS;
    client.__setConnection("reconnecting"); // 断线（pet status 残留）——定格 busy 是撒谎
    expect(emits[1]).toEqual([WUDAO_PET_STATE_EVENT, IDLE_PET_FRAME]);
    unmount();
  });
});

// ω99-237: #10 — pet 源斜杠早拦（UX 层，零 RTT）：pet 车道是固定 id 的纯发送
// 面，斜杠命令属主车道——relay 的 pet 源分支（ask/划词接单两处 petSubmit 调
// 用位）在 trim 后 / 开头时根本不调 petSubmit，改 emit toast 事件（文案 brief
// §二 逐字）回宠物窗。早拦独立成立（fake petSubmit 是「旧服务端有求必应」形
// ——拒令不必等服务端升级）；对照钉=主源（snap.pet 缺席的降级路）斜杠照旧走
// 主 submit（命令是主车道功能）。渲染面（宠物窗 toast + 被拒轮回滚）钉在
// pet-root.test.tsx（入口面）。
describe("ω99-237 pet 源斜杠早拦（relay 层）", () => {
  const TOAST_TEXT = "精灵窗口不支持斜杠命令——直接提问，或到主窗口输入命令";

  /** mountRelay 同款 + emit 捕获（toast 断言面）。 */
  const mountWithEmit = (client: FakeClient): { handlers: Map<string, (p: unknown) => void>; emit: ReturnType<typeof vi.fn>; unmount: () => void } => {
    const handlers = new Map<string, (p: unknown) => void>();
    const emit = vi.fn(async (_e: string, _p: unknown): Promise<boolean> => true);
    const unmount = mountPetRelay(client, {
      emit,
      listen: vi.fn(async (e: string, h: (p: unknown) => void) => { handlers.set(e, h); return () => {}; }),
      now: () => 0,
      submit: client.submit,
    });
    return { handlers, emit, unmount };
  };
  /** emit 里 toast 事件的调用次数（帧泵的状态帧 emit 不算）。 */
  const toastEmits = (emit: ReturnType<typeof vi.fn>): unknown[][] =>
    emit.mock.calls.filter(([e]) => e === WUDAO_PET_TOAST_EVENT);

  it("(a4) pet 源 ask /clear（先导空白）→ petSubmit 零调用 + toast 事件逐字；主 submit 零调", async () => {
    const client = fakeClient();
    const { handlers, emit, unmount } = mountWithEmit(client);
    client.__setPet(idleStatus({ sessionId: "pet" }));
    handlers.get(WUDAO_PET_ASK_EVENT)!({ text: "  /clear  " });
    await Promise.resolve();
    expect(client.petSubmit).not.toHaveBeenCalled(); // 早拦独立成立：fake petSubmit 有求必应（旧服务端形）也没被调
    expect(client.submit).not.toHaveBeenCalled();
    expect(toastEmits(emit)).toEqual([[WUDAO_PET_TOAST_EVENT, { text: TOAST_TEXT }]]);
    unmount();
  });

  it("(a5) pet 源划词接单同拦：/x 文本 → petSubmit 零调用 + toast（两处 petSubmit 调用位都护住）", async () => {
    const client = fakeClient();
    const { handlers, emit, unmount } = mountWithEmit(client);
    client.__setPet(idleStatus({ sessionId: "pet" }));
    handlers.get(WUDAO_PET_SELECTION_SUBMIT_EVENT)!({ text: "/explain this" });
    await Promise.resolve();
    expect(client.petSubmit).not.toHaveBeenCalled();
    expect(client.submit).not.toHaveBeenCalled();
    expect(toastEmits(emit)).toEqual([[WUDAO_PET_TOAST_EVENT, { text: TOAST_TEXT }]]);
    unmount();
  });

  it("(b4) 对照钉：主源（snap.pet 缺席）斜杠 → 旧 submit 照调，零 toast", async () => {
    const client = fakeClient();
    const { handlers, emit, unmount } = mountWithEmit(client);
    client.__set(busyStatus()); // 主源（旧服务端/车道缺席）——斜杠是主车道功能
    handlers.get(WUDAO_PET_ASK_EVENT)!({ text: "/clear" });
    handlers.get(WUDAO_PET_SELECTION_SUBMIT_EVENT)!({ text: "/x" });
    await Promise.resolve();
    expect(client.submit).toHaveBeenCalledTimes(2);
    expect(client.submit).toHaveBeenNthCalledWith(1, "/clear");
    expect(client.submit).toHaveBeenNthCalledWith(2, "/x");
    expect(client.petSubmit).not.toHaveBeenCalled();
    expect(toastEmits(emit)).toEqual([]); // 主源斜杠不是被拒面，无 toast
    unmount();
  });
});

describe("ω99-235 侧栏 lane 行（徽标 + toast + 零 resume）", () => {
  const mount = (client: { sessions: () => Promise<unknown[]> }, onResume: () => void): HTMLElement => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <SessionSidebar
          client={client as never}
          activeSessionId={null}
          onResume={onResume}
          onNewChat={() => {}}
          onOpenSettings={() => {}}
          onOpenSearch={() => {}}
        />,
      );
    });
    return container;
  };

  it("(e) lane:=\"pet\" 行显示「小精灵」；点击零 resume + toast「精灵会话在精灵窗口继续」", async () => {
    const onResume = vi.fn();
    // mtime 显式时序（同毫秒会翻转 mtime-desc 排序——确定性夹具）。
    const now = Date.now();
    const rows = [
      { id: "pet", mtime: new Date(now).toISOString(), messages: 3, firstUser: "精灵第一问", model: "m", lane: "pet" },
      { id: "wudao-x", mtime: new Date(now - 60_000).toISOString(), messages: 1, firstUser: "主窗问题", model: "m" },
    ];
    const container = mount({ sessions: async () => rows }, onResume);
    await act(async () => {});
    const listItems = [...container.querySelectorAll<HTMLElement>(".sb-list [role='listitem']")];
    expect(listItems.length).toBe(2);
    // 徽标名替换默认标题显示（firstUser 不再是行的标题）。
    expect(listItems[0]?.textContent).toContain("小精灵");
    expect(listItems[0]?.textContent).not.toContain("精灵第一问");
    // 普通行照旧（标题梯子）。
    expect(listItems[1]?.textContent).toContain("主窗问题");

    act(() => {
      listItems[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onResume).not.toHaveBeenCalled(); // 不 resume（租约互斥——会话在精灵窗口活着）
    expect(container.textContent).toContain("精灵会话在精灵窗口继续"); // 提示 toast

    // 对照：普通行点击照旧走 resume。
    act(() => {
      listItems[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onResume).toHaveBeenCalledTimes(1);
  });
});
