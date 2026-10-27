// 借鉴弧 α1（Codex rust-v0.154.0 中途内联问答思想）— ask_user 的 web 车道：
//   园     createAskUserPark 的停泊生命周期（park→snapshot；answer 带 文
//          =resolve、空/缺=reject「自行决定」；自清计时器；双停泊 fail-closed；
//          rejectPending=中断道）
//   车道   createAskUserLane().mount 的端口面（getStatus 合并 pendingAskUser；
//          answerAskUser op；recallSteer 直通驱动；interrupt 先解散停泊；
//          subscribe 在停泊/清空时触发自己的订阅者——server 的 pushState 骑
//          subscribe，驱动本身无状态变化不会自发 emit）
// M24：问答进历史沿用 ask_user 既有契约（tool_use+tool_result 轮界追加）——
// 本件只钉停泊园，工具契约已有 core 钉（ask-user 工具的 fail-closed 族）。
import { describe, it, expect } from "vitest";
import { createAskUserLane } from "../src/driver/ask-user-park.js";
import type { AgentDriver } from "../src/driver/contract.js";
import type { UiDriverPort } from "@wudao/server";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/** A minimal driver double — only recallSteer is on the lane's path. */
const fakeDriver = { recallSteer: (i: number, t: string) => i === 0 && t === "q" } as unknown as AgentDriver;

/** A minimal inner port (the scriptedDriver shape). */
function innerPort(): UiDriverPort {
  return {
    subscribe: () => () => {},
    getStatus: () => ({ live: { reasoning: "", answer: "", busyTools: [] }, busy: true, queued: [] }),
    getHistory: () => [],
    onHistory: () => () => {},
    onLoopEvent: () => () => {},
    submit: () => "started",
    interrupt: () => {},
    setMode: () => {},
    answerPermission: () => false,
    listSlashCommands: () => [],
    sessions: async () => [],
  };
}

describe("α1 园 — createAskUserPark 生命周期", () => {
  it("parks, surfaces the snapshot, and resolves on a real answer; empty/dismiss rejects as decide-yourself", async () => {
    const lane = createAskUserLane({ timeoutMs: 60_000 });
    const p = lane.park.askUser("用哪个方案？", [{ label: "A" }, { label: "B" }]);
    expect(lane.park.snapshot()).toEqual({ question: "用哪个方案？", options: [{ label: "A" }, { label: "B" }] });
    expect(lane.park.answer("B 方案")).toBe(true);
    await expect(p).resolves.toBe("B 方案");
    expect(lane.park.snapshot()).toBeNull();
    // Dismiss (no answer / whitespace) → the tool's decide-yourself error.
    const p2 = lane.park.askUser("再问一个？");
    expect(lane.park.answer("   ")).toBe(true);
    await expect(p2).rejects.toThrow("dismissed");
    // Nothing parked → answering is an honest false.
    expect(lane.park.answer("x")).toBe(false);
  });

  it("the self-clean timer mirrors the tool's timeout (a late answer resolves a settled promise, harmlessly)", async () => {
    const lane = createAskUserLane({ timeoutMs: 30 });
    const p = lane.park.askUser("会超时的问题？");
    const rejected = p.catch((e: Error) => `rejected:${e.message}`).then((r) => r);
    await wait(60);
    expect(lane.park.snapshot()).toBeNull(); // the card cannot linger
    expect(lane.park.answer("太晚了")).toBe(false); // nothing to answer
    expect(await rejected).toMatch(/^rejected:/);
  });

  it("a second concurrent park fails CLOSED (ask_user is isConcurrencySafe:false — one card owns the lane)", async () => {
    const lane = createAskUserLane({ timeoutMs: 60_000 });
    const first = lane.park.askUser("第一个？");
    await expect(lane.park.askUser("第二个？")).rejects.toThrow("already parked");
    expect(lane.park.snapshot()?.question).toBe("第一个？");
    lane.park.answer("好");
    await expect(first).resolves.toBe("好");
  });

  it("rejectPending is the interrupt lane (the run unwinds, the card clears)", async () => {
    const lane = createAskUserLane({ timeoutMs: 60_000 });
    const p = lane.park.askUser("会被中断的问题？");
    lane.park.rejectPending("interrupted");
    await expect(p).rejects.toThrow("interrupted");
    expect(lane.park.snapshot()).toBeNull();
  });
});

describe("α1 车道 — mount 的端口面", () => {
  it("getStatus merges pendingAskUser over the inner status; answerAskUser routes the park", async () => {
    const lane = createAskUserLane({ timeoutMs: 60_000 });
    const port = lane.mount(innerPort(), fakeDriver);
    expect((port.getStatus() as { pendingAskUser: unknown }).pendingAskUser).toBeNull();
    const p = lane.park.askUser("哪个？", [{ label: "X" }]);
    expect((port.getStatus() as { pendingAskUser: { question: string } }).pendingAskUser.question).toBe("哪个？");
    expect(port.answerAskUser!("X")).toBe(true);
    await expect(p).resolves.toBe("X");
    expect(port.answerAskUser!("late")).toBe(false);
  });

  it("recallSteer passes straight to the driver's CAS face; interrupt rejects the parked ask first", async () => {
    const lane = createAskUserLane({ timeoutMs: 60_000 });
    let interrupted = false;
    const inner = { ...innerPort(), interrupt: () => { interrupted = true; } };
    const port = lane.mount(inner, fakeDriver);
    expect(port.recallSteer!(0, "q")).toBe(true); // the fake driver's CAS hit
    expect(port.recallSteer!(0, "other")).toBe(false);
    const p = lane.park.askUser("中断时在问？");
    port.interrupt();
    expect(interrupted).toBe(true);
    await expect(p).rejects.toThrow("interrupted");
  });

  it("a park/settle fires the lane's OWN subscribers (the server's pushState rides subscribe; the driver has no state change of its own)", async () => {
    const lane = createAskUserLane({ timeoutMs: 60_000 });
    const port = lane.mount(innerPort(), fakeDriver);
    const events: string[] = [];
    port.subscribe(() => events.push("push"));
    const p = lane.park.askUser("通知？");
    await wait();
    lane.park.answer("好");
    await expect(p).resolves.toBe("好");
    await wait();
    expect(events.filter((e) => e === "push").length).toBeGreaterThanOrEqual(2); // park + settle
  });
});
