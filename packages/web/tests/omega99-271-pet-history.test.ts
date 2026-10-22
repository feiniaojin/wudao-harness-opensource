// ω99-271: #13 — 小精灵完整史车道（web 面），先红后绿。用户报障 09-10：
// 「很多消息没有展示完全，也看不到完整的会话信息」。三层根因的 web 侧修
// 复 receipts：①尾窗 500→2000（pet-frame.test 钉）；②本地窗 3→30
// （pet-chat.test 钉）；③完整史车道——主窗 relay 代取（wudao-pet-history-req
// → client.petHistory() → wudao-pet-history {turns}），宠物窗 mergeChat 把
// digest 对上的本地轮升级为全文。本文件钉 relay 车道 + mergeChat + wire 解析。
// ω99-272 — ①②的帽全撤（用户令「流面尾窗不要限制字数，加一个折叠的功能
// 不就解决了，本地转写无限」）：answerTail 全文直通（pet-frame.test 钉）、
// 本地转写与合并后无轮数帽（(j) 改钉）。
import { describe, expect, it, vi } from "vitest";
import { mountPetRelay } from "../src/pet/relay.js";
import { WUDAO_PET_ASK_EVENT, WUDAO_PET_HISTORY_EVENT, WUDAO_PET_HISTORY_REQ_EVENT, readPetHistory } from "../src/pet/pet-frame.js";
import { digest, emptyPetChat, mergeChat, pushTurn } from "../src/pet/pet-chat.js";
import type { DriverStatus, SubmitOutcome, UiSnapshot } from "../src/protocol.js";

// --- fake client（pet-relay/235 同范式；本文件要驱动 pet 车道） -----------------

type PetTurn = { q: string; a: string };

function fakeClient(petHistoryImpl?: () => Promise<readonly PetTurn[]>) {
  const listeners = new Set<() => void>();
  let snap: UiSnapshot = {
    connection: "connected", reconnectAttempt: 0, lastClose: null, status: null, history: [], historyEpoch: 0,
  };
  return {
    subscribe: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    getSnapshot: () => snap,
    submit: vi.fn(async (): Promise<SubmitOutcome> => "started"),
    answerPermission: vi.fn(async () => true),
    petSubmit: vi.fn(async (): Promise<SubmitOutcome> => "started"),
    petAnswerPermission: vi.fn(async () => true),
    petHistory: vi.fn(petHistoryImpl ?? (async () => [] as readonly PetTurn[])),
    __setPet: (p: UiSnapshot["pet"]) => { snap = { ...snap, pet: p }; },
  };
}

const idlePetStatus = (): DriverStatus => ({
  live: { reasoning: "", answer: "", busyTools: [] },
  busy: false, queued: [], boardProgress: null, ctxTokens: null, mode: "auto", cachePercent: null,
  bg: { active: 0, spawned: 0 }, pendingPermission: null, planBoard: null, sessionId: "pet", sidecar: null,
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("ω99-271 relay 历史代取车道（第四个反向监听）", () => {
  it("(a) 车道 live：history-req → client.petHistory() → emit wudao-pet-history {turns} 原样转手", async () => {
    const turns: readonly PetTurn[] = [{ q: "旧问", a: "旧答全文" }];
    const client = fakeClient(async () => turns);
    let req: ((p: unknown) => void) | undefined;
    const emit = vi.fn(async (): Promise<boolean> => true);
    const listen = vi.fn(async (e: string, h: (p: unknown) => void) => { if (e === WUDAO_PET_HISTORY_REQ_EVENT) req = h; return () => {}; });
    mountPetRelay(client, { emit, listen, now: () => 0, submit: client.submit });
    client.__setPet(idlePetStatus()); // 车道判定是事件时点的（不缓存）
    req!({});
    await flush(); await flush();
    expect(client.petHistory).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(WUDAO_PET_HISTORY_EVENT, { turns });
  });

  it("(b) 车道缺席：history-req 到了也不调 petHistory、不发回执（本地转写照旧）", async () => {
    const client = fakeClient();
    let req: ((p: unknown) => void) | undefined;
    const emit = vi.fn(async (): Promise<boolean> => true);
    const listen = vi.fn(async (e: string, h: (p: unknown) => void) => { if (e === WUDAO_PET_HISTORY_REQ_EVENT) req = h; return () => {}; });
    mountPetRelay(client, { emit, listen, now: () => 0, submit: client.submit });
    req!({}); // snap.pet 从未在场
    await flush();
    expect(client.petHistory).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith(WUDAO_PET_HISTORY_EVENT, expect.anything());
  });

  it("(c) petHistory reject：静默吞掉（旧服务端 unsupported/网络失败），不发半套回执", async () => {
    const client = fakeClient(async () => { throw new Error("pet ops not supported by this driver"); });
    let req: ((p: unknown) => void) | undefined;
    const emit = vi.fn(async (): Promise<boolean> => true);
    const listen = vi.fn(async (e: string, h: (p: unknown) => void) => { if (e === WUDAO_PET_HISTORY_REQ_EVENT) req = h; return () => {}; });
    mountPetRelay(client, { emit, listen, now: () => 0, submit: client.submit });
    client.__setPet(idlePetStatus());
    req!({});
    await flush(); await flush();
    expect(client.petHistory).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalledWith(WUDAO_PET_HISTORY_EVENT, expect.anything());
  });

  it("(d) 其它事件名不被误当历史请求（ask 仍走旧路——回归钉）", async () => {
    const client = fakeClient();
    let ask: ((p: unknown) => void) | undefined;
    const listen = vi.fn(async (e: string, h: (p: unknown) => void) => { if (e === WUDAO_PET_ASK_EVENT) ask = h; return () => {}; });
    mountPetRelay(client, { emit: vi.fn(async () => true), listen, now: () => 0, submit: client.submit });
    client.__setPet(idlePetStatus());
    ask!({ text: "精灵问一句" });
    await flush();
    expect(client.petSubmit).toHaveBeenCalledWith("精灵问一句");
  });
});

describe("ω99-271 mergeChat（完整史 ∥ 本地转写 纯合并）", () => {
  it("(e) 升级：本地 digest 对上的已冻结轮 → q 全文 + a 完整；对不上的保留", () => {
    const long = "答".repeat(2000);
    const local = pushTurn(pushTurn(emptyPetChat, "这个问题的前二十四个字会很长很长很长很长很长"), "第二问");
    const frozen = applySettled(local);
    const merged = mergeChat(
      [
        { q: "这个问题的前二十四个字会很长很长很长很长很长", a: long },
        { q: "第二问", a: "短答" },
      ],
      frozen,
    );
    expect(merged.turns[0]).toEqual({ q: "这个问题的前二十四个字会很长很长很长很长很长", a: long, live: false });
    expect(merged.turns[1]?.a).toBe("短答");
  });

  it("(f) 本地比史新（stale 拉取缺口）：unmatched 本地轮原样保留、排序在后", () => {
    const local = pushTurn(pushTurn(emptyPetChat, "史里有的问"), "史里还没有的新问");
    const merged = mergeChat([{ q: "史里有的问", a: "史答" }], applySettled(local));
    expect(merged.turns.map((t) => t.q)).toEqual(["史里有的问", "史里还没有的新问"]);
    expect(merged.turns[0]?.a).toBe("史答"); // 配对轮升级
    expect(merged.turns[1]?.a).toBe(""); // 本地轮不受史影响
  });

  it("(g) 史比本地长（重启后 fresh 本地）：史轮全部补齐在前", () => {
    const local = pushTurn(emptyPetChat, "重启后新问");
    const history: PetTurn[] = [{ q: "昨天问一", a: "昨天答一" }, { q: "昨天问二", a: "昨天答二" }];
    const merged = mergeChat(history, local);
    expect(merged.turns.map((t) => t.q)).toEqual(["昨天问一", "昨天问二", "重启后新问"]);
    expect(merged.turns[0]?.live).toBe(false);
  });

  it("(h) live 旗随本地：史里已落定、本地仍在流的轮升级拿全文但保持 live（冻结仍归 applyFrame）", () => {
    const local = pushTurn(emptyPetChat, "流式中的问");
    const merged = mergeChat([{ q: "流式中的问", a: "其实已经答完了" }], local);
    expect(merged.turns[0]).toEqual({ q: "流式中的问", a: "其实已经答完了", live: true });
  });

  it("(i) 主窗兜底格（q=\"\"）不配对、不丢弃", () => {
    const local = { turns: [{ q: "", a: "主窗轮的尾窗", live: false }] };
    const merged = mergeChat([{ q: "精灵的问", a: "精灵的答" }], local);
    expect(merged.turns.map((t) => t.q)).toEqual(["精灵的问", ""]);
  });

  it("(j) ω99-272: #8 — 合并后无帽：史 60 轮全进、最旧不被逐（本地转写无限，滚动区承接）", () => {
    const history: PetTurn[] = [];
    for (let i = 0; i < 60; i += 1) history.push({ q: `史问${i}`, a: `史答${i}` });
    const merged = mergeChat(history, emptyPetChat);
    expect(merged.turns).toHaveLength(60);
    expect(merged.turns[0]?.q).toBe("史问0");
  });
});

describe("ω99-271 readPetHistory（wire 解析）", () => {
  it("(k) 合法载荷整收；坏载荷整丢（不半信）", () => {
    expect(readPetHistory({ turns: [{ q: "问", a: "答" }, { q: "问二", a: "" }] })).toEqual({
      turns: [{ q: "问", a: "答" }, { q: "问二", a: "" }],
    });
    expect(readPetHistory(null)).toBeNull();
    expect(readPetHistory({})).toBeNull();
    expect(readPetHistory({ turns: "not-array" })).toBeNull();
    expect(readPetHistory({ turns: [{ q: 1, a: "答" }] })).toBeNull(); // q 非 string → 整包作废
    expect(readPetHistory({ turns: [{ q: "问", a: "答" }, null] })).toBeNull(); // 混入 junk → 整包作废
  });
});

/** 本地两轮都冻结（applyFrame 的 settled 语义捷径——测试只关心形状）。 */
function applySettled(c: { turns: readonly { q: string; a: string; live: boolean }[] }): { turns: readonly { q: string; a: string; live: boolean }[] } {
  return { turns: c.turns.map((t) => ({ ...t, live: false })) };
}

// digest 的既有契约回归钉（mergeChat 的配对键就是它）：
describe("ω99-271 digest 回归（配对键）", () => {
  it("(l) 24 字内原样；超长截 24 字 + …（Array.from 码点计）", () => {
    expect(digest("短问")).toBe("短问");
    expect(digest("一二三四五六七八九十一二三四五六七八九十一二三四五")).toBe("一二三四五六七八九十一二三四五六七八九十一二三四…");
  });
});
