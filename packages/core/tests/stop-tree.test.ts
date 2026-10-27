// stop-tree — 停止协调器（StopCoordinator）的确定性测试。
//
// 覆盖（任务书口径）：停止树递归 + 属主校验 + 深度上限；挂起请求回收完整
// 性；admission 三态（有终态回复=accepted；发出无回响=unknown；未发出=
// pending）；tree_settled 完成判定 + 观察者隔离。参考语义来自 openwork 的
// opencode-interruption.ts（见 src/stop-tree.ts 头注的偏差记录）。
import { describe, expect, it } from "vitest";
import { StopCoordinator, MAX_STOP_TREE_DEPTH } from "../src/stop-tree.js";
import type { StopTreeEvent } from "../src/stop-tree.js";

const OWNER = "session-root";

function recorder(): { events: StopTreeEvent[]; onEvent: (e: StopTreeEvent) => void } {
  const events: StopTreeEvent[] = [];
  return { events, onEvent: (e) => { events.push(e); } };
}

describe("StopCoordinator 停止树", () => {
  it("递归收集：root 在首、父先子后（BFS 序），逐子发 child_stopping 事件", () => {
    const { events, onEvent } = recorder();
    const tree = new StopCoordinator({ onEvent });
    // root → a → b；root → c（b 是叶子，c 挂 root 下第二支）
    tree.registerChild("root", "a", OWNER);
    tree.registerChild("a", "b", OWNER);
    tree.registerChild("root", "c", OWNER);
    const plan = tree.requestStop("root", OWNER);
    expect(plan.members).toEqual(["root", "a", "c", "b"]); // BFS：a、c 同层按注册序，b 随后
    expect(plan.skipped).toEqual([]);
    expect(events.filter((e) => e.type === "stop_requested")).toEqual([{ type: "stop_requested", rootId: "root", generation: 0 }]);
    const stopping = events.filter((e) => e.type === "child_stopping");
    expect(stopping.map((e) => (e as { childId: string }).childId)).toEqual(["a", "c", "b"]);
    const aStop = stopping[0] as Extract<StopTreeEvent, { type: "child_stopping" }>;
    expect(aStop.parentId).toBe("root");
    expect(aStop.generation).toBe(0);
  });

  it("childSessionId 随登记走：child_stopping 事件携带，缺省无键", () => {
    const { events, onEvent } = recorder();
    const tree = new StopCoordinator({ onEvent });
    tree.registerChild("root", "with-session", OWNER, "side-abc");
    tree.registerChild("root", "bare", OWNER);
    tree.requestStop("root", OWNER);
    const withSession = events.find((e) => e.type === "child_stopping" && (e as { childId: string }).childId === "with-session") as Extract<StopTreeEvent, { type: "child_stopping" }>;
    const bare = events.find((e) => e.type === "child_stopping" && (e as { childId: string }).childId === "bare") as Extract<StopTreeEvent, { type: "child_stopping" }>;
    expect(withSession.childSessionId).toBe("side-abc");
    expect("childSessionId" in bare).toBe(false);
  });

  it("属主校验：owner 不匹配的子树整体跳过 + warn（保守停止，不挡其余节点）", () => {
    const { events, onEvent } = recorder();
    const tree = new StopCoordinator({ onEvent });
    tree.registerChild("root", "mine", OWNER);
    // 外来属主的孩子挂在 mine 下——校验从 root 的 owner 链看不过
    tree.registerChild("mine", "foreign-child", "another-owner");
    // 外来属主的孩子直接挂 root 下——同样跳过
    tree.registerChild("root", "foreign-direct", "another-owner");
    // 外来孩子的后代（即使属主回到 OWNER——它的父已被跳过，不可达）
    tree.registerChild("foreign-direct", "under-foreign", OWNER);
    // 正常支线不受影响
    tree.registerChild("root", "ok-branch", OWNER);
    const plan = tree.requestStop("root", OWNER);
    expect(plan.members).toEqual(["root", "mine", "ok-branch"]);
    // 跳过序 = BFS 展开序：root 的边先于 mine 的下探
    expect(plan.skipped).toEqual([
      { childId: "foreign-direct", code: "owner_mismatch" },
      { childId: "foreign-child", code: "owner_mismatch" },
    ]);
    const warns = events.filter((e) => e.type === "stop_warn");
    expect(warns.length).toBe(2);
    for (const w of warns) {
      expect((w as { code: string }).code).toBe("owner_mismatch");
    }
    // 跳过的子节点不发 child_stopping（没停它，就别说在停它）
    expect(events.some((e) => e.type === "child_stopping" && ["foreign-child", "foreign-direct", "under-foreign"].includes((e as { childId: string }).childId))).toBe(false);
  });

  it("不声明 owner（requestStop 无 owner）：只按父子链收集，不做属主校验", () => {
    const tree = new StopCoordinator();
    tree.registerChild("root", "any-owner-child", "someone-else");
    const plan = tree.requestStop("root");
    expect(plan.members).toEqual(["root", "any-owner-child"]);
  });

  it("深度上限 256：链式树在 256 层截断 + depth_cap warn，已收集部分照常停", () => {
    const { events, onEvent } = recorder();
    const tree = new StopCoordinator({ onEvent });
    tree.registerChild("root", "c1", OWNER);
    for (let i = 2; i <= 300; i += 1) tree.registerChild(`c${i - 1}`, `c${i}`, OWNER);
    const plan = tree.requestStop("root", OWNER);
    // root（第 0 层）+ c1..c256（第 1..256 层）全部展开；触发截断的那层孩子
    // （c257，发现即入树会被停）入 members 但其后代不再收集。
    expect(plan.members.length).toBe(1 + MAX_STOP_TREE_DEPTH + 1);
    expect(plan.members[0]).toBe("root");
    expect(plan.members[MAX_STOP_TREE_DEPTH]).toBe(`c${MAX_STOP_TREE_DEPTH}`);
    expect(plan.members[MAX_STOP_TREE_DEPTH + 1]).toBe(`c${MAX_STOP_TREE_DEPTH + 1}`);
    expect(plan.members.includes(`c${MAX_STOP_TREE_DEPTH + 2}`)).toBe(false);
    const capWarns = events.filter((e) => e.type === "stop_warn" && (e as { code: string }).code === "depth_cap");
    expect(capWarns.length).toBe(1);
    expect((capWarns[0] as { childId?: string }).childId).toBe(`c${MAX_STOP_TREE_DEPTH + 1}`);
  });

  it("环防御：重复登记成环时每节点至多入树一次，不发散", () => {
    const tree = new StopCoordinator();
    tree.registerChild("root", "a", OWNER);
    tree.registerChild("a", "b", OWNER);
    // 手工造成环：b → a（registerChild 会搬边，但访问集兜底任何形状）
    tree.registerChild("b", "a2", OWNER);
    const plan = tree.requestStop("root", OWNER);
    expect(new Set(plan.members).size).toBe(plan.members.length);
    expect(plan.members).toEqual(["root", "a", "b", "a2"]);
  });

  it("beginTurn 递增 generation；requestStop 盖当前代号不递增", () => {
    const tree = new StopCoordinator();
    expect(tree.beginTurn()).toBe(1);
    expect(tree.beginTurn()).toBe(2);
    const plan = tree.requestStop("root", OWNER);
    expect(plan.generation).toBe(2);
    expect(tree.currentGeneration()).toBe(2);
  });
});

describe("StopCoordinator 挂起请求回收", () => {
  it("完整性：树成员（root+子）上的全收回、注册序；非成员与属主跳过子树上的不收回；幂等", () => {
    const tree = new StopCoordinator();
    tree.registerChild("root", "mid", OWNER);
    tree.registerChild("mid", "leaf", OWNER);
    tree.registerChild("root", "foreign", "another-owner");
    tree.registerPendingRequest("root", "p-root", "permission");
    tree.registerPendingRequest("mid", "p-mid", "ask");
    tree.registerPendingRequest("leaf", "p-leaf", "permission");
    tree.registerPendingRequest("outsider-session", "p-out", "permission");
    tree.registerPendingRequest("foreign", "p-foreign", "permission");
    // 先 requestStop（拿验证过的成员圈），再 withdraw——driver interrupt 的顺序
    tree.requestStop("root", OWNER);
    const withdrawn = tree.withdrawPending("root");
    expect(withdrawn).toEqual(["p-root", "p-mid", "p-leaf"]); // 注册序
    // 幂等：收回即出簿
    expect(tree.withdrawPending("root")).toEqual([]);
  });

  it("无活动计划时按父子链现场收集（parent 链是全部凭据）", () => {
    const tree = new StopCoordinator();
    tree.registerChild("root", "child", "any");
    tree.registerPendingRequest("child", "p1", "permission");
    expect(tree.withdrawPending("root")).toEqual(["p1"]);
  });

  it("resolvePendingRequest：正常了结（人已答）的 ask 出簿，停止时不再当僵尸收回", () => {
    const tree = new StopCoordinator();
    tree.registerPendingRequest("root", "p-answered", "permission");
    tree.registerPendingRequest("root", "p-standing", "permission");
    tree.resolvePendingRequest("p-answered");
    tree.requestStop("root", OWNER);
    expect(tree.withdrawPending("root")).toEqual(["p-standing"]);
  });

  it("requests_withdrawn 事件：非空收回时发出（携带 id 列表），空收回不发", () => {
    const { events, onEvent } = recorder();
    const tree = new StopCoordinator({ onEvent });
    tree.registerChild("root", "c", OWNER);
    tree.requestStop("root", OWNER);
    tree.withdrawPending("root");
    expect(events.filter((e) => e.type === "requests_withdrawn")).toEqual([]);
    tree.registerPendingRequest("c", "late-ask", "ask");
    const ids = tree.withdrawPending("root");
    expect(ids).toEqual(["late-ask"]);
    expect(events.filter((e) => e.type === "requests_withdrawn")).toEqual([{ type: "requests_withdrawn", rootId: "root", requestIds: ["late-ask"] }]);
  });
});

describe("StopCoordinator admission 三态", () => {
  it("未发出 = pending（含从未登记的 id）", () => {
    const tree = new StopCoordinator();
    tree.trackSubmission("s1");
    expect(tree.admissionUnknown("s1")).toBe("pending");
    expect(tree.admissionUnknown("never-tracked")).toBe("pending");
  });

  it("发出且在飞（无终态回响、通道未断）= pending——结果仍由自己的请求持有", () => {
    const tree = new StopCoordinator();
    tree.trackSubmission("s1");
    tree.markSubmitted("s1");
    expect(tree.admissionUnknown("s1")).toBe("pending");
  });

  it("发出无回响（响应丢失）= unknown + admission_unknown 事件恰一次；绝不重放语义由调用方持有", () => {
    const { events, onEvent } = recorder();
    const tree = new StopCoordinator({ onEvent });
    tree.trackSubmission("s1");
    tree.markSubmitted("s1");
    tree.markAdmissionLost("s1");
    expect(tree.admissionUnknown("s1")).toBe("unknown");
    expect(events.filter((e) => e.type === "admission_unknown")).toEqual([{ type: "admission_unknown", submissionId: "s1" }]);
    // 重复标 lost 不重复发事件
    tree.markAdmissionLost("s1");
    expect(events.filter((e) => e.type === "admission_unknown").length).toBe(1);
    expect(tree.admissionUnknown("s1")).toBe("unknown");
  });

  it("有终态 assistant 回复 = accepted（丢回响后等到了真回复也对账成立——openwork 的 exact terminal evidence）", () => {
    const { events, onEvent } = recorder();
    const tree = new StopCoordinator({ onEvent });
    tree.trackSubmission("s1");
    tree.markAdmissionLost("s1"); // 响应丢了
    tree.markTerminalReply("s1"); // 终态回复随后落地
    expect(tree.admissionUnknown("s1")).toBe("accepted");
    // 迟到的 lost 不改判 accepted
    tree.markAdmissionLost("s1");
    expect(tree.admissionUnknown("s1")).toBe("accepted");
  });

  it("直接 accepted：发出后终态回复落地，从未 lost", () => {
    const tree = new StopCoordinator();
    tree.trackSubmission("s1");
    tree.markSubmitted("s1");
    tree.markTerminalReply("s1");
    expect(tree.admissionUnknown("s1")).toBe("accepted");
  });
});

describe("StopCoordinator 树完成判定", () => {
  it("全员（含 root）落定恰发一次 tree_settled；中途不发；重复落定不重发", () => {
    const { events, onEvent } = recorder();
    const tree = new StopCoordinator({ onEvent });
    tree.registerChild("root", "c1", OWNER);
    tree.registerChild("c1", "c2", OWNER);
    const plan = tree.requestStop("root", OWNER);
    expect(tree.isTreeSettled("root")).toBe(false);
    tree.childSettled("c1");
    expect(events.some((e) => e.type === "tree_settled")).toBe(false);
    tree.childSettled("c2");
    expect(events.some((e) => e.type === "tree_settled")).toBe(false); // root 未落定
    tree.childSettled("root");
    expect(tree.isTreeSettled("root")).toBe(true);
    const settled = events.filter((e) => e.type === "tree_settled");
    expect(settled).toEqual([{ type: "tree_settled", rootId: "root", generation: plan.generation, members: ["root", "c1", "c2"] }]);
    // 迟到的重复落定不重发
    tree.childSettled("c1");
    expect(events.filter((e) => e.type === "tree_settled").length).toBe(1);
  });

  it("计划时已落定的子节点直接计入（只等未落定的）", () => {
    const { events, onEvent } = recorder();
    const tree = new StopCoordinator({ onEvent });
    tree.registerChild("root", "already-done", OWNER);
    tree.childSettled("already-done");
    tree.requestStop("root", OWNER);
    tree.childSettled("root");
    expect(events.some((e) => e.type === "tree_settled")).toBe(true);
  });

  it("观察者隔离：onEvent 抛错不影响状态机任何判定", () => {
    const tree = new StopCoordinator({
      onEvent: () => { throw new Error("observer boom"); },
    });
    tree.registerChild("root", "c1", OWNER);
    tree.registerPendingRequest("root", "p1", "permission");
    const plan = tree.requestStop("root", OWNER);
    expect(plan.members).toEqual(["root", "c1"]);
    expect(tree.withdrawPending("root")).toEqual(["p1"]);
    tree.childSettled("c1");
    tree.childSettled("root");
    expect(tree.isTreeSettled("root")).toBe(true);
  });
});
