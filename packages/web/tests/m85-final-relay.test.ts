// M85-final（终审修复波）— relay 侧两断言面，先红后绿：
//   I-1 归档回执 → 主窗会话列表刷新信号：petNewSession 非 null 回执（真发生
//      了归档轮换）→ emit WUDAO_PET_SESSIONS_REFRESH_EVENT；null（空会话跳过）
//      /reject（旧服务端/网络失败）零信号——列表没变不重取。
//   I-3 工作区数据面：挂载时 recentWorkspaces op 取一次（≤5 条路径）进
//      PetFrame.recentWorkspaces；空表/reject → null（宠物工具栏回落手输面）。
//      modelChoices 的蒸馏/等值面在 pet-frame.test.ts（纯层），本文件钉
//      relay 车道把两者随状态帧发出的组合点。
import { describe, expect, it, vi } from "vitest";
import { mountPetRelay } from "../src/pet/relay.js";
import {
  WUDAO_PET_SESSIONS_REFRESH_EVENT,
  WUDAO_PET_STATE_EVENT,
  WUDAO_PET_TOOLBAR_EVENT,
} from "../src/pet/pet-frame.js";
import type { AgentRootSwitchResult, DriverStatus, SubmitOutcome, UiSnapshot } from "../src/protocol.js";

// --- fake client（pet-relay/271 同范式；本文件要驱动 pet 车道 + recents 面） ----

interface FakeClient {
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => UiSnapshot;
  submit: ReturnType<typeof vi.fn<(t: string) => Promise<SubmitOutcome>>>;
  answerPermission: ReturnType<typeof vi.fn<(allow: boolean, reason?: string, scope?: "session" | "always") => Promise<boolean>>>;
  petSubmit: ReturnType<typeof vi.fn<(t: string) => Promise<SubmitOutcome>>>;
  petAnswerPermission: ReturnType<typeof vi.fn<(allow: boolean, reason?: string, scope?: "session" | "always") => Promise<boolean>>>;
  petHistory: ReturnType<typeof vi.fn<() => Promise<readonly { q: string; a: string }[]>>>;
  petNewSession: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
  petSetModel: ReturnType<typeof vi.fn<(provider: string, model?: string, effort?: string) => Promise<true>>>;
  petSetEffort: ReturnType<typeof vi.fn<(effort: string) => Promise<true>>>;
  petSetWorkspace: ReturnType<typeof vi.fn<(path: string) => Promise<AgentRootSwitchResult>>>;
  recentWorkspaces: ReturnType<typeof vi.fn<(add?: string) => Promise<{ workspaces: readonly { path: string; lastUsed: string }[] }>>>;
  __setPet: (p: UiSnapshot["pet"]) => void;
}

function fakeClient(recents?: () => Promise<{ workspaces: readonly { path: string; lastUsed: string }[] }>): FakeClient {
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
    petNewSession: vi.fn(async (): Promise<string | null> => null),
    petSetModel: vi.fn(async (): Promise<true> => true),
    petSetEffort: vi.fn(async (): Promise<true> => true),
    petSetWorkspace: vi.fn(async (): Promise<AgentRootSwitchResult> => ({ applied: true, queued: false })),
    recentWorkspaces: vi.fn(recents ?? (async () => ({ workspaces: [] as readonly { path: string; lastUsed: string }[] }))),
    __setPet: (p) => { snap = { ...snap, pet: p }; notify(); },
  };
}

/** pet 车道的 idle 基座（model 块按需叠加——I-3 的 choices 蒸馏源）。 */
const petStatus = (over: Partial<DriverStatus> = {}): DriverStatus => ({
  live: { reasoning: "", answer: "", busyTools: [] },
  busy: false, queued: [], boardProgress: null, ctxTokens: null, mode: "auto", cachePercent: null,
  bg: { active: 0, spawned: 0 }, pendingPermission: null, planBoard: null, sessionId: "pet", sidecar: null,
  ...over,
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** 捕获工具栏 handler 的装配范式（271 mountWithToolbar 同款）。 */
const mountWithToolbar = (client: FakeClient, emit = vi.fn(async (): Promise<boolean> => true)) => {
  let toolbar: ((p: unknown) => void) | undefined;
  const listen = vi.fn(async (e: string, h: (p: unknown) => void) => { if (e === WUDAO_PET_TOOLBAR_EVENT) toolbar = h; return () => {}; });
  const un = mountPetRelay(client, { emit, listen, now: () => 0, submit: client.submit });
  return { fire: (p: unknown) => toolbar!(p), un, emit };
};

describe("M85-final I-1 归档回执 → 会话列表刷新信号（relay 第五个 epoch 触发者）", () => {
  it("(a) petNewSession 非 null 回执 → emit WUDAO_PET_SESSIONS_REFRESH_EVENT（载荷带归档 id）", async () => {
    const client = fakeClient();
    client.petNewSession.mockResolvedValueOnce("pet-20261109-0001");
    client.__setPet(petStatus()); // 车道 live（事件时点判定）
    const { fire, emit } = mountWithToolbar(client);
    fire({ kind: "new-session" });
    await flush(); await flush();
    expect(client.petNewSession).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(WUDAO_PET_SESSIONS_REFRESH_EVENT, { archivedId: "pet-20261109-0001" });
  });

  it("(b) null 回执（空会话跳过归档）→ 零刷新信号（列表没变）", async () => {
    const client = fakeClient();
    client.petNewSession.mockResolvedValueOnce(null);
    client.__setPet(petStatus());
    const { fire, emit } = mountWithToolbar(client);
    fire({ kind: "new-session" });
    await flush(); await flush();
    expect(client.petNewSession).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalledWith(WUDAO_PET_SESSIONS_REFRESH_EVENT, expect.anything());
  });

  it("(c) reject（旧服务端 unsupported/网络失败）→ 零信号零炸（吞掉即通过）", async () => {
    const client = fakeClient();
    client.petNewSession.mockRejectedValueOnce(new Error("pet ops not supported by this driver"));
    client.__setPet(petStatus());
    const { fire, emit } = mountWithToolbar(client);
    fire({ kind: "new-session" });
    await flush(); await flush();
    expect(client.petNewSession).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalledWith(WUDAO_PET_SESSIONS_REFRESH_EVENT, expect.anything());
  });
});

describe("M85-final I-3 工作区数据面（挂载取一次 recentWorkspaces 进帧）", () => {
  /** 装配范式：mount 时无 status（fetch 先落定、零 emit），再 __setPet 触发
   *  唯一一次 leading emit——帧内同时可见 recents 与 choices（组合点）。 */
  const mountThenSetPet = async (client: FakeClient, p: UiSnapshot["pet"]) => {
    const emit = vi.fn(async (_e: string, _p: unknown): Promise<boolean> => true);
    mountPetRelay(client, { emit, listen: vi.fn(async () => null), now: () => 0, submit: client.submit });
    await flush(); // recents fetch 落定（pushSnapshot：无 status 零发）
    client.__setPet(p);
    return emit;
  };

  it("(d) recents 两条 + model.choices 矩阵 → 单帧携带 recentWorkspaces 路径与 modelChoices 对", async () => {
    const client = fakeClient(async () => ({
      workspaces: [
        { path: "/Users/x/work/proj-a", lastUsed: "2026-11-09T00:00:00Z" },
        { path: "/Users/x/work/proj-b", lastUsed: "2026-11-08T00:00:00Z" },
      ],
    }));
    const emit = await mountThenSetPet(client, petStatus({
      model: { label: "glm-5.3", provider: "glm", choices: [
        { provider: "glm", model: "glm-5.3", source: "builtin" },
        { provider: "deepseek", model: "deepseek-v4", source: "builtin" },
      ] },
    }));
    expect(emit).toHaveBeenCalledTimes(1);
    const frame = emit.mock.calls[0]![1] as { recentWorkspaces: unknown; modelChoices: unknown };
    expect(emit.mock.calls[0]![0]).toBe(WUDAO_PET_STATE_EVENT);
    expect(frame.recentWorkspaces).toEqual(["/Users/x/work/proj-a", "/Users/x/work/proj-b"]);
    expect(frame.modelChoices).toEqual([
      { provider: "glm", model: "glm-5.3" },
      { provider: "deepseek", model: "deepseek-v4" },
    ]);
  });

  it("(e) recents 空 → 帧字段 null（宠物工具栏回落手输面）", async () => {
    const client = fakeClient(async () => ({ workspaces: [] }));
    const emit = await mountThenSetPet(client, petStatus());
    const frame = emit.mock.calls[0]![1] as { recentWorkspaces: unknown };
    expect(frame.recentWorkspaces).toBeNull();
  });

  it("(f) recents op reject → null 保持（手输面；不炸不重试）", async () => {
    const client = fakeClient(async () => { throw new Error("boom"); });
    const emit = await mountThenSetPet(client, petStatus());
    const frame = emit.mock.calls[0]![1] as { recentWorkspaces: unknown };
    expect(frame.recentWorkspaces).toBeNull();
  });

  it("(g) 超 5 条 → 截 5（chip 菜单同界——220px 宠物窗的紧凑面）", async () => {
    const client = fakeClient(async () => ({
      workspaces: Array.from({ length: 7 }, (_, i) => ({ path: `/w/p${i}`, lastUsed: "2026-11-09T00:00:00Z" })),
    }));
    const emit = await mountThenSetPet(client, petStatus());
    const frame = emit.mock.calls[0]![1] as { recentWorkspaces: unknown };
    expect(frame.recentWorkspaces).toEqual(["/w/p0", "/w/p1", "/w/p2", "/w/p3", "/w/p4"]);
  });

  it("(h) 无 model 块/空矩阵 → modelChoices null（手输回落——缺席的诚实降级）", async () => {
    const client = fakeClient();
    const emit = await mountThenSetPet(client, petStatus({ model: { label: "glm-5.3", choices: [] } }));
    const frame = emit.mock.calls[0]![1] as { modelChoices: unknown };
    expect(frame.modelChoices).toBeNull();
  });
});
