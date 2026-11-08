// @vitest-environment jsdom
// ω99-99 — the main-window side of the pet relay, RED-first. Two units:
// createFramePump (a leading+trailing throttle with equal-frame
// short-circuit — the pet must see the LATEST state at most PET_EMIT_MS
// apart, and must not be spammed with frames it already has) and
// mountPetRelay (subscribe→derive→pump + the ask listener that submits into
// the ONE real WS client — the server's single-client rule means the pet
// window itself can never talk to the server; this relay is its only voice).
// All clocks and transports are injected; the default-deps test pins that
// the production wiring really goes through tauri-invoke (and that a
// browser, where listen resolves null, degrades to send-only without
// crashing).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createFramePump, mountPetRelay } from "../src/pet/relay.js";
import { IDLE_PET_FRAME, PET_EMIT_MS, WUDAO_PET_ASK_EVENT, WUDAO_PET_ANSWER_EVENT, WUDAO_PET_STATE_EVENT, derivePetFrame } from "../src/pet/pet-frame.js";
import type { PetFrame } from "../src/pet/pet-frame.js";
import type { DriverStatus, SubmitOutcome, UiSnapshot } from "../src/protocol.js";

const f = (p: Partial<PetFrame>): PetFrame => ({
  busy: false, pendingPermission: false, reasoningActive: false, answerTail: "", busyToolCount: 0, busyNarration: null, workKind: null, ask: null, model: null, effort: null, workspaceName: null, workspacePath: null, modelChoices: null, recentWorkspaces: null, ...p,
});
const FA = f({});
const FB = f({ busy: true });
const FC = f({ answerTail: "c" });
const FD = f({ busyToolCount: 4 });
const FE = f({ reasoningActive: true });

describe("ω99-99 createFramePump（leading+trailing 节流 + 等值短路）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("burst 5 帧/10ms → 1 leading + 1 trailing，且 trailing 发的是最新帧", () => {
    const emit = vi.fn(async (_e: string, _p: unknown): Promise<boolean> => true);
    let t = 1000;
    const pump = createFramePump({ emit, now: () => t });
    pump.push(FA); // leading：距上次发出（无）→ 立即
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0]).toBe(WUDAO_PET_STATE_EVENT);
    t += 10; pump.push(FB);
    t += 10; pump.push(FC);
    t += 10; pump.push(FD);
    t += 10; pump.push(FE); // 全在窗口内 → 只排 trailing
    expect(emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(PET_EMIT_MS); // 窗口到点
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1]![1]).toEqual(FE); // 最新帧，不是中间帧
  });

  it("首帧即 leading：emit 同步发生（不等 trailing）", () => {
    const emit = vi.fn(async (_e: string, _p: unknown): Promise<boolean> => true);
    const pump = createFramePump({ emit, now: () => 0 });
    pump.push(FA);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![1]).toEqual(FA);
  });

  it("等值帧零发：与上次已发帧 deep-equal → no-op", () => {
    const emit = vi.fn(async (_e: string, _p: unknown): Promise<boolean> => true);
    const pump = createFramePump({ emit, now: () => 1000 });
    pump.push(FA);
    pump.push(f({})); // 新对象、同值 → deep-equal
    vi.advanceTimersByTime(10 * PET_EMIT_MS);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("等值取消挂起 trailing：窗口内先变后变回 → trailing 被取消", () => {
    const emit = vi.fn(async (_e: string, _p: unknown): Promise<boolean> => true);
    let t = 1000;
    const pump = createFramePump({ emit, now: () => t });
    pump.push(FA); // 发出 FA
    t += 10; pump.push(FB); // ≠FA → 排 trailing(FB)
    t += 10; pump.push(FA); // 变回等值 → 取消挂起的 trailing
    vi.advanceTimersByTime(10 * PET_EMIT_MS);
    expect(emit).toHaveBeenCalledTimes(1); // FB 永不发（当前态=FA=已发态）
    t += 1000; pump.push(FC); // 窗口早已过 → 新 leading
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1]![1]).toEqual(FC);
  });

  it("窗口过后再 push → 新的立即 leading（窗口滑动）", () => {
    const emit = vi.fn(async (_e: string, _p: unknown): Promise<boolean> => true);
    let t = 0;
    const pump = createFramePump({ emit, now: () => t });
    pump.push(FA);
    t += PET_EMIT_MS; pump.push(FB); // 恰好到窗 → 立即
    expect(emit).toHaveBeenCalledTimes(2);
    t += PET_EMIT_MS - 1; pump.push(FC); // 差 1ms → trailing
    expect(emit).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(PET_EMIT_MS);
    expect(emit).toHaveBeenCalledTimes(3);
    expect(emit.mock.calls[2]![1]).toEqual(FC);
  });

  it("cancel：挂起的 trailing 被掐灭，此后 push 零发", () => {
    const emit = vi.fn(async (_e: string, _p: unknown): Promise<boolean> => true);
    let t = 0;
    const pump = createFramePump({ emit, now: () => t });
    pump.push(FA);
    t += 10; pump.push(FB); // trailing 挂起
    pump.cancel();
    vi.advanceTimersByTime(10 * PET_EMIT_MS);
    pump.push(FC); // cancel 后泵终止
    vi.advanceTimersByTime(10 * PET_EMIT_MS);
    expect(emit).toHaveBeenCalledTimes(1); // 只有最初的 leading
  });

  it("全时钟无关：now 注入驱动一切判定（不用 Date.now）", () => {
    const emit = vi.fn(async (_e: string, _p: unknown): Promise<boolean> => true);
    const pump = createFramePump({ emit, now: () => 42 });
    pump.push(FA);
    expect(emit).toHaveBeenCalledTimes(1);
    pump.push(FB);
    expect(emit).toHaveBeenCalledTimes(1); // 42-42=0 < 150 → 不发
  });
});

// --- mountPetRelay ----------------------------------------------------------

type FakeClient = {
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => UiSnapshot;
  submit: ReturnType<typeof vi.fn<(t: string) => Promise<SubmitOutcome>>>;
  /** ω99-109：应答走 client.answerPermission（与主窗 PermissionModal 同一条道）。 */
  answerPermission: ReturnType<typeof vi.fn<(allow: boolean, reason?: string, scope?: "session" | "always") => Promise<boolean>>>;
  /** ω99-235: #11 — pet 车道分流后的 Pick 契约成员——本文件的快照从不含 pet 字段，
   *  全部断言走降级主路（petSubmit/petAnswerPermission 永不被调，挂上仅为
   *  满足 mountPetRelay 的类型契约；pet 源行为面在
   *  omega99-235-pet-isolation.test.tsx）。 */
  petSubmit: ReturnType<typeof vi.fn<(t: string) => Promise<SubmitOutcome>>>;
  petAnswerPermission: ReturnType<typeof vi.fn<(allow: boolean, reason?: string, scope?: "session" | "always") => Promise<boolean>>>;
  /** ω99-271: #10 — mountPetRelay 的 Pick 契约新增成员（历史代取）。本文件
   *  的快照从不含 pet 字段 → 车道判定恒 false → petHistory 永不被调，挂上
   *  仅为满足类型契约；pet 源的历史行为面在 omega99-271-pet-history.test.ts。 */
  petHistory: ReturnType<typeof vi.fn<() => Promise<readonly { q: string; a: string }[]>>>;
  /** M85-pet §2 — Pick 契约新增成员（工具栏四 op）。同上：本文件的快照从不
   *  含 pet 字段 → 车道判定恒 false → 四法永不被调，挂上仅为满足类型契约；
   *  工具栏行为面在 omega99-271-pet-history.test.ts 的 M85-pet 块。 */
  petNewSession: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
  petSetModel: ReturnType<typeof vi.fn<(provider: string, model?: string, effort?: string) => Promise<true>>>;
  petSetEffort: ReturnType<typeof vi.fn<(effort: string) => Promise<true>>>;
  petSetWorkspace: ReturnType<typeof vi.fn<(path: string) => Promise<{ applied: boolean; queued: boolean }>>>;
  /** M85-final I-3 — Pick 契约新增成员（工作区数据面）：挂载时取一次最近
   *  工作区进帧（recentWorkspaces）。行为面在 m85-final-relay.test.ts。 */
  recentWorkspaces: ReturnType<typeof vi.fn<(add?: string) => Promise<{ workspaces: readonly { path: string; lastUsed: string }[] }>>>;
  __set: (s: UiSnapshot["status"]) => void;
  /** ω99-103：断线路径只改 connection（protocol.ts onclose 不碰 status）——单独驱动它。 */
  __setConnection: (c: UiSnapshot["connection"]) => void;
  __listeners: () => number;
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
    petNewSession: vi.fn(async () => null),
    petSetModel: vi.fn(async () => true),
    petSetEffort: vi.fn(async () => true),
    petSetWorkspace: vi.fn(async () => ({ applied: true, queued: false })),
    recentWorkspaces: vi.fn(async () => ({ workspaces: [] as readonly { path: string; lastUsed: string }[] })),
    __set: (s) => { snap = { ...snap, status: s }; notify(); },
    __setConnection: (c) => { snap = { ...snap, connection: c }; notify(); },
    __listeners: () => listeners.size,
  };
}

function busyStatus(): DriverStatus {
  return {
    live: { reasoning: "想", answer: "答".repeat(600), busyTools: [{ name: "Read", summary: "" }, { name: "Edit", summary: "" }] },
    busy: true, queued: [], boardProgress: null, ctxTokens: null, mode: "workspace", cachePercent: null,
    bg: { active: 0, spawned: 0 }, pendingPermission: null, planBoard: null, sessionId: "s", sidecar: null,
  };
}

describe("ω99-99 mountPetRelay（注入 deps 的行为面）", () => {
  it("状态变化 → emit 收到 derivePetFrame 的帧；status null 快照零发", () => {
    const client = fakeClient();
    const emit = vi.fn(async (_e: string, _p: unknown): Promise<boolean> => true);
    const listen = vi.fn(async () => null);
    mountPetRelay(client, { emit, listen, now: () => 0, submit: client.submit });
    client.__set(null); // 快照变了但无 status → 静默
    expect(emit).not.toHaveBeenCalled();
    client.__set(busyStatus());
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]).toEqual([WUDAO_PET_STATE_EVENT, derivePetFrame({ status: busyStatus() })]);
  });

  it("wudao-pet-ask handler → submit(trim 后文本)；空串/whitespace/缺 text 不调", async () => {
    const client = fakeClient();
    const emit = vi.fn(async (_e: string, _p: unknown): Promise<boolean> => true);
    let ask: ((p: unknown) => void) | undefined;
    const unlisten = vi.fn();
    const listen = vi.fn(async (e: string, h: (p: unknown) => void) => { if (e === WUDAO_PET_ASK_EVENT) ask = h; return unlisten; });
    mountPetRelay(client, { emit, listen, now: () => 0, submit: client.submit });
    ask!({ text: "  你好 悟道  " });
    await Promise.resolve();
    expect(client.submit).toHaveBeenCalledWith("你好 悟道");
    ask!("   ");
    ask!("");
    ask!({}); // text 缺失
    ask!(null);
    await Promise.resolve();
    expect(client.submit).toHaveBeenCalledTimes(1);
  });

  it("submit reject 不炸（吞掉，气泡无重试语义）", async () => {
    const client = fakeClient();
    let ask: ((p: unknown) => void) | undefined;
    const listen = vi.fn(async (_e: string, h: (p: unknown) => void) => { ask = h; return () => {}; });
    mountPetRelay(client, { emit: vi.fn(async () => true), listen, now: () => 0,
      submit: vi.fn(async () => { throw new Error("ws down"); }) });
    ask!({ text: "x" });
    await new Promise((r) => setTimeout(r, 0)); // rejection 已被吞
    expect(true).toBe(true);
  });

  it("unmount：退订 + unlisten + 泵 cancel，之后全静默", async () => {
    const client = fakeClient();
    const emit = vi.fn(async (_e: string, _p: unknown): Promise<boolean> => true);
    const unlisten = vi.fn();
    const listen = vi.fn(async () => unlisten);
    const unmount = mountPetRelay(client, { emit, listen, now: () => 0, submit: client.submit });
    expect(client.__listeners()).toBe(1);
    unmount();
    expect(client.__listeners()).toBe(0);
    await Promise.resolve(); // listen 的 promise 落定（unmount 早于它 → dead 分支补 unlisten）
    // ω99-109 期望变更（依据：relay 现挂两条 listen——ask 提问 + 权限应答）：
    // 同一个 unlisten mock 被两条订阅各还一次。
    // ω99-110 再变更为 3（依据：本弧加第三条 listen——划词接单 submit 车道）。
    // ω99-271 再变更为 4（依据：本弧加第四条 listen——历史代取 req 车道）。
    // M85-pet §2 再变更为 5（依据：本弧加第五条 listen——工具栏动作车道）。
    expect(unlisten).toHaveBeenCalledTimes(5);
    client.__set(busyStatus()); // 订阅已退 → 无帧
    expect(emit).not.toHaveBeenCalled();
  });

  it("默认 deps 从 tauri-invoke 接线：invoke 收到 plugin:event|emit + 事件/payload 形状", async () => {
    const invoke = vi.fn(async () => undefined);
    (window as typeof window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__ = { invoke };
    try {
      const client = fakeClient();
      const unmount = mountPetRelay(client); // 浏览器降级路径：无 transformCallback → listen null
      client.__set(busyStatus());
      await Promise.resolve(); // tauriEmitEvent 的 await invoke 落定
      expect(invoke).toHaveBeenCalledWith("plugin:event|emit", {
        event: WUDAO_PET_STATE_EVENT,
        payload: derivePetFrame({ status: busyStatus() }),
      });
      unmount(); // listen 返回 null → unmount 不炸
      delete (window as typeof window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
    } finally {
      delete (window as typeof window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
    }
  });
});

// --- ω99-103 断线回 idle -----------------------------------------------------

describe("ω99-103 断线回 idle（relay 侧诚实补帧：server 不可达=没有活 agent）", () => {
  it("IDLE_PET_FRAME 常量 = 全空闲形状（relay 补帧用的单一事实源）", () => {
    expect(IDLE_PET_FRAME).toEqual(f({}));
  });

  it("断线：connected 真帧后 connection 离开 connected（status 残留）→ 补发 idle 帧，不是残留旧态", () => {
    const client = fakeClient();
    const emit = vi.fn(async (_e: string, _p: unknown): Promise<boolean> => true);
    let t = 0;
    mountPetRelay(client, { emit, listen: async () => null, now: () => t, submit: client.submit });
    client.__set(busyStatus()); // t=0 → leading：busy 真帧
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![1]).toEqual(derivePetFrame({ status: busyStatus() }));
    t += PET_EMIT_MS;
    client.__setConnection("reconnecting"); // onclose 只改 connection，status 还是 busy
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1]![1]).toEqual(IDLE_PET_FRAME); // 全空闲帧——定格 busy 是撒谎
  });

  it("重连：connection 回 connected 后真帧恢复（短暂闪 idle 接受，不卡死）", () => {
    const client = fakeClient();
    const emit = vi.fn(async (_e: string, _p: unknown): Promise<boolean> => true);
    let t = 0;
    mountPetRelay(client, { emit, listen: async () => null, now: () => t, submit: client.submit });
    client.__set(busyStatus());
    t += PET_EMIT_MS;
    client.__setConnection("reconnecting"); // → idle 帧
    expect(emit.mock.calls[1]![1]).toEqual(IDLE_PET_FRAME);
    t += PET_EMIT_MS;
    client.__setConnection("connected"); // 残留 busy status 随真连接恢复 → 真帧回来
    expect(emit).toHaveBeenCalledTimes(3);
    expect(emit.mock.calls[2]![1]).toEqual(derivePetFrame({ status: busyStatus() }));
    t += PET_EMIT_MS;
    const fresh: DriverStatus = { ...busyStatus(), busy: true, live: { reasoning: "", answer: "续答", busyTools: [] } };
    client.__set(fresh); // 重连后服务端续流 → 新真帧照常流动
    expect(emit).toHaveBeenCalledTimes(4);
    expect(emit.mock.calls[3]![1]).toEqual(derivePetFrame({ status: fresh }));
  });

  it("冷启动：从未有过 status 时 connection 怎么变都静默（不发明 idle——空窗即 idle）", () => {
    const client = fakeClient();
    const emit = vi.fn(async (_e: string, _p: unknown): Promise<boolean> => true);
    mountPetRelay(client, { emit, listen: async () => null, now: () => 0, submit: client.submit });
    client.__setConnection("connecting");
    client.__setConnection("closed");
    client.__setConnection("reconnecting");
    client.__set(null); // status 依旧 null
    expect(emit).not.toHaveBeenCalled();
  });

  it("从未 connected 就有 status（防御面）：非 connected 期到达的 status 不触发补帧", () => {
    const client = fakeClient();
    client.__setConnection("reconnecting"); // 挂载前就已断线
    const emit = vi.fn(async (_e: string, _p: unknown): Promise<boolean> => true);
    mountPetRelay(client, { emit, listen: async () => null, now: () => 0, submit: client.submit });
    client.__set(busyStatus()); // hasSeenStatus=false → 静默（没见过真帧就不补假帧）
    expect(emit).not.toHaveBeenCalled();
    client.__setConnection("connected"); // 真连接 → 真帧（此后才算见过）
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![1]).toEqual(derivePetFrame({ status: busyStatus() }));
  });

  it("等值 idle 防重复：断线后的多次快照变化只发一次 idle（泵等值短路）", () => {
    const client = fakeClient();
    const emit = vi.fn(async (_e: string, _p: unknown): Promise<boolean> => true);
    let t = 0;
    mountPetRelay(client, { emit, listen: async () => null, now: () => t, submit: client.submit });
    client.__set(busyStatus()); // busy 真帧
    t += PET_EMIT_MS;
    client.__setConnection("reconnecting"); // idle 帧发出
    t += PET_EMIT_MS;
    client.__setConnection("closed"); // 仍断线 → 等值 idle → 零发
    t += PET_EMIT_MS;
    client.__setConnection("gave-up");
    expect(emit).toHaveBeenCalledTimes(2); // 只有 busy + idle
  });
});

// --- ω99-109 应答事件（宠物 → 主窗 wudao-pet-answer → answerPermission）------

describe("ω99-109 应答事件：形状守卫 → client.answerPermission（与主窗同一条道）", () => {
  /** 挂 relay 并捕获 wudao-pet-answer 的 handler（listen 按事件名分发）。 */
  function mountAnswer(): { client: FakeClient; answer: (p: unknown) => void } {
    const client = fakeClient();
    let answer: ((p: unknown) => void) | undefined;
    const listen = vi.fn(async (e: string, h: (p: unknown) => void) => {
      if (e === WUDAO_PET_ANSWER_EVENT) answer = h;
      return () => {};
    });
    mountPetRelay(client, { emit: vi.fn(async () => true), listen, now: () => 0, submit: client.submit });
    if (answer === undefined) throw new Error("wudao-pet-answer 未注册 handler");
    return { client, answer };
  }

  it("合法 {allow:true,scope:\"always\"} → answerPermission(true, undefined, \"always\")", async () => {
    const { client, answer } = mountAnswer();
    answer({ allow: true, scope: "always" });
    await Promise.resolve();
    expect(client.answerPermission).toHaveBeenCalledTimes(1);
    expect(client.answerPermission).toHaveBeenCalledWith(true, undefined, "always");
  });

  it("无 scope 的允许 → answerPermission(true, undefined, undefined)（缺省=一次）", async () => {
    const { client, answer } = mountAnswer();
    answer({ allow: true });
    await Promise.resolve();
    expect(client.answerPermission).toHaveBeenCalledWith(true, undefined, undefined);
  });

  it("形状守卫：缺 allow / allow 非布尔 / scope 非 \"always\" / 非对象 → 整体丢弃零调", async () => {
    const { client, answer } = mountAnswer();
    answer({ scope: "always" }); // 缺 allow
    answer({ allow: "yes" }); // 非布尔
    answer({ allow: true, scope: "session" }); // 宠物面没有 session 语义
    answer({ allow: true, scope: true }); // scope 非法类型
    answer("x");
    answer(null);
    await Promise.resolve();
    expect(client.answerPermission).not.toHaveBeenCalled();
  });

  it("allow=false 不带 scope 调用；带 scope 的 deny 也归一为无 scope（拒绝没有「总是」）", async () => {
    const { client, answer } = mountAnswer();
    answer({ allow: false });
    answer({ allow: false, scope: "always" });
    await Promise.resolve();
    expect(client.answerPermission).toHaveBeenCalledTimes(2);
    expect(client.answerPermission).toHaveBeenNthCalledWith(1, false, undefined, undefined);
    expect(client.answerPermission).toHaveBeenNthCalledWith(2, false, undefined, undefined);
  });

  it("answerPermission reject 静默（parked ask 可能已在别处解决——与 App.tsx 同语义）", async () => {
    const client = fakeClient();
    client.answerPermission = vi.fn(async () => { throw new Error("parked gone"); });
    let answer: ((p: unknown) => void) | undefined;
    const listen = vi.fn(async (e: string, h: (p: unknown) => void) => {
      if (e === WUDAO_PET_ANSWER_EVENT) answer = h;
      return () => {};
    });
    mountPetRelay(client, { emit: vi.fn(async () => true), listen, now: () => 0, submit: client.submit });
    answer!({ allow: true });
    await new Promise((r) => setTimeout(r, 0)); // rejection 已被吞，不炸
    expect(true).toBe(true);
  });
});

// --- ω99-110 划词 submit 车道（宠物 → 主窗 wudao-pet-selection-submit → submit）---

describe("ω99-110 划词 submit 车道：成品 prompt 直上唯一 client.submit", () => {
  // 宠物面在卡上就把 prompt 组装完（selection.ts 的 prompt 族），主窗收到的
  // 载荷已是成品文本——车道保持与 ask 同语义的哑管道：trim 非空才 submit、
  // reject 静默、坏载荷整丢。client Pick 不变（submit 已在）。
  const SUBMIT_EVENT = "wudao-pet-selection-submit";

  /** 挂 relay 并捕获 wudao-pet-selection-submit 的 handler。 */
  function mountSubmit(overrides?: { submit?: (t: string) => Promise<SubmitOutcome> }): {
    client: FakeClient;
    submit: (p: unknown) => void;
  } {
    const client = fakeClient();
    let handler: ((p: unknown) => void) | undefined;
    const listen = vi.fn(async (e: string, h: (p: unknown) => void) => {
      if (e === SUBMIT_EVENT) handler = h;
      return () => {};
    });
    const submit = overrides?.submit ?? client.submit;
    mountPetRelay(client, { emit: vi.fn(async () => true), listen, now: () => 0, submit });
    if (handler === undefined) throw new Error(`${SUBMIT_EVENT} 未注册 handler`);
    return { client, submit: handler };
  }

  it("好载荷 → submit(trim 后文本)：宠物已组装的成品 prompt 原样上道", async () => {
    const { client, submit } = mountSubmit();
    submit({ text: "  翻译这段划选的文字（按原文方向中英互译）：\n\nthe quick brown fox  " });
    await Promise.resolve();
    expect(client.submit).toHaveBeenCalledTimes(1);
    expect(client.submit).toHaveBeenCalledWith(
      "翻译这段划选的文字（按原文方向中英互译）：\n\nthe quick brown fox",
    );
  });

  it("空/纯空白载荷 → 静默不调 submit", async () => {
    const { client, submit } = mountSubmit();
    submit({ text: "   " });
    submit({ text: "" });
    await Promise.resolve();
    expect(client.submit).not.toHaveBeenCalled();
  });

  it("坏载荷（缺 text / 非对象 / text 非字符串）→ 整丢零调", async () => {
    const { client, submit } = mountSubmit();
    submit({});
    submit(null);
    submit("text");
    submit({ text: 42 });
    await Promise.resolve();
    expect(client.submit).not.toHaveBeenCalled();
  });

  it("submit reject 静默（与 ask 车道同语义，气泡无重试）", async () => {
    const { submit } = mountSubmit({ submit: vi.fn(async () => { throw new Error("ws down"); }) });
    submit({ text: "帮我看看这段划选的文字：\n\nx" });
    await new Promise((r) => setTimeout(r, 0)); // rejection 已被吞，不炸
    expect(true).toBe(true);
  });
});
