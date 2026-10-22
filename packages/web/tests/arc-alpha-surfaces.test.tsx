// @vitest-environment jsdom
// 借鉴弧 α2/α1 的 web 面：
//   α2  LiveArea / SimpleTurnStatus 的排队行 ↩ 撤回钮（无 onRecall 时不渲染
//       ——老面字节不变；点击带 (index, text) 上抛——CAS 对的原料）
//   α1  AskUserCards 的 inline 形（.ask-card 无 scrim，chips+自由输入+解散都
//       活）与 SimpleMode 的澄清卡挂载（pendingAsk + 权限卡优先）
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act } from "react";
import { mount, unmount } from "./css-test-utils.js";
import { LiveArea } from "../src/components/LiveArea.js";
import { SimpleTurnStatus } from "../src/components/SimpleTurnStatus.js";
import { AskUserCards } from "../src/components/AskUserCards.js";
import { SimpleMode } from "../src/components/SimpleMode.js";
import type { DriverStatus, LiveState, PendingAskUser } from "../src/protocol.js";

afterEach(unmount);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const live: LiveState = { reasoning: "", answer: "", busyTools: [] };

/** Type into a controlled input the way a real browser does (components.test's
 *  native-setter discipline — React ignores a bare .value assignment). */
const type = (el: HTMLInputElement, text: string): void => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("α2 — 排队行的 ↩ 撤回钮", () => {
  it("LiveArea: renders the recall button per queued line; the click carries (index, text); absent onRecall renders the legacy line", async () => {
    const onRecall = vi.fn();
    const c = mount(<LiveArea live={live} queued={["甲", "乙"]} onRecall={onRecall} />);
    const buttons = c.querySelectorAll("button.recall");
    expect(buttons.length).toBe(2);
    expect(c.textContent).toContain("将在下一步前注入:甲");
    await act(async () => { (buttons[1] as HTMLButtonElement).click(); });
    expect(onRecall).toHaveBeenCalledWith(1, "乙");
    // The legacy face (no onRecall prop): the line renders WITHOUT a button.
    const legacy = mount(<LiveArea live={live} queued={["甲"]} />);
    expect(legacy.querySelectorAll("button.recall").length).toBe(0);
    expect(legacy.textContent).toContain("将在下一步前注入:甲");
  });

  it("SimpleTurnStatus: the same affordance on the queue lines", async () => {
    const onRecall = vi.fn();
    const c = mount(<SimpleTurnStatus busy={true} live={live} queued={["排队中"]} onRecall={onRecall} />);
    const btn = c.querySelector("button.recall") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    await act(async () => { btn.click(); });
    expect(onRecall).toHaveBeenCalledWith(0, "排队中");
  });
});

describe("α1 — AskUserCards 的 inline 澄清卡", () => {
  it("inline renders .ask-card WITHOUT the scrim; chips answer by click; the dismiss lane works", async () => {
    const onAnswer = vi.fn();
    const onDismiss = vi.fn();
    const c = mount(
      <AskUserCards inline={true} question="用哪个方案？" options={[{ label: "方案 A" }, { label: "方案 B" }]} onAnswer={onAnswer} onDismiss={onDismiss} />,
    );
    expect(c.querySelector(".ask-card")).not.toBeNull();
    expect(c.querySelector(".scrim")).toBeNull(); // no fullscreen dim — the chat stays visible
    await act(async () => { (c.querySelectorAll(".optioncard")[1] as HTMLButtonElement).click(); });
    expect(onAnswer).toHaveBeenCalledWith("方案 B");
    // The dismiss lane (让 agent 自行决定) works from the card.
    await act(async () => { (c.querySelector(".btnrow button.wudao") as HTMLButtonElement).click(); });
    expect(onDismiss).toHaveBeenCalled();
  });

  it("the free-text variant answers on Enter inside the inline card", async () => {
    const onAnswer = vi.fn();
    const c = mount(<AskUserCards inline={true} question="名字？" onAnswer={onAnswer} onDismiss={() => {}} />);
    const input = c.querySelector("input.wudao-input") as HTMLInputElement;
    await act(async () => { type(input, "悟道"); });
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    expect(onAnswer).toHaveBeenCalledWith("悟道");
  });
});

describe("α1 — SimpleMode 的澄清卡挂载", () => {
  const askStatus = (over: Record<string, unknown> = {}): DriverStatus => ({
    live,
    busy: true,
    queued: [],
    boardProgress: null,
    ctxTokens: null,
    mode: "auto",
    cachePercent: null,
    bg: { active: 0, spawned: 0 },
    pendingPermission: null,
    planBoard: null,
    sessionId: "s",
    sidecar: null,
    pendingAskUser: { question: "继续吗？", options: [{ label: "继续" }, { label: "停" }] },
    ...over,
  }) as DriverStatus;
  const base = {
    status: askStatus(),
    history: [] as never[],
    connected: true,
    commands: [] as never[],
    onSubmit: (): boolean => false,
    onInterrupt: () => {},
    onCycleMode: () => {},
    onAnswerPermission: async () => true,
    onRecallSteer: () => {},
    onAnswerAskUser: async () => true,
    onShield: () => {},
    notify: () => {},
    parked: [] as string[],
    onPark: () => {},
    onDropParked: () => {},
    onDraftApplied: () => {},
    rootCard: null,
    onAgentRootSwitch: async () => {},
    onAgentRootKeep: () => {},
    workspaceRoot: "/w",
    onSwitchWorkspace: async () => {},
    onOpenOtherWorkspace: () => {},
    onSideAsk: () => {},
    sideQas: [] as never[],
    onPromoteSideQa: () => {},
    fileOpsClient: null as never,
    // α1: App derives this from status.pendingAskUser and passes it down.
    pendingAsk: { question: "继续吗？", options: [{ label: "继续" }, { label: "停" }] } as PendingAskUser,
  };

  it("renders the clarification card when pendingAsk pends and no permission ask outranks it", () => {
    const c = mount(<SimpleMode {...base} />);
    expect(c.querySelector(".ask-card")).not.toBeNull();
    expect(c.textContent).toContain("继续吗？"); // 116 弧 C：❓ → circle-help 细线字形
    expect(c.querySelectorAll(".optioncard").length).toBe(2);
  });

  it("a pending permission ask outranks the clarification card (side effects gate first)", () => {
    const c = mount(
      <SimpleMode
        {...base}
        status={askStatus({ pendingPermission: { toolName: "shell", summary: "rm x", input: {} } })}
      />,
    );
    expect(c.querySelector(".ask-card")).toBeNull(); // the approval card owns the slot
  });

  it("an old server without the field renders no card (quiet degradation)", () => {
    const { pendingAsk, ...rest } = base;
    void pendingAsk;
    const c = mount(<SimpleMode {...rest} status={askStatus({ pendingAskUser: undefined })} />);
    expect(c.querySelector(".ask-card")).toBeNull();
  });
});

describe("δ — 在飞工具行的「转入后台」钮", () => {
  const busy: LiveState = {
    reasoning: "",
    answer: "",
    busyTools: [
      { name: "shell", summary: "pnpm build", callId: "call_1" },
      { name: "read_file", summary: "a.ts" }, // pre-ω99-63 shape: no callId
    ],
  };

  it("LiveArea: renders the button only on callId-carrying rows; the click carries the callId; absent onDetachTool renders the legacy row", async () => {
    const onDetach = vi.fn();
    const c = mount(<LiveArea live={busy} queued={[]} onDetachTool={onDetach} />);
    const buttons = c.querySelectorAll("button.detach");
    expect(buttons.length).toBe(1); // the callId-less row stays byte-identical
    expect(buttons[0]?.getAttribute("aria-label")).toContain("转入后台");
    await act(async () => { (buttons[0] as HTMLButtonElement).click(); });
    expect(onDetach).toHaveBeenCalledWith("call_1");
    // The legacy face (no handler): no button on ANY row.
    const legacy = mount(<LiveArea live={busy} queued={[]} />);
    expect(legacy.querySelectorAll("button.detach").length).toBe(0);
    expect(legacy.textContent).toContain("pnpm build");
  });

  it("SimpleMode: the same affordance threads through the simple face's busy rows", async () => {
    const onDetach = vi.fn();
    const status = {
      live: busy,
      busy: true,
      queued: [],
      permissions: { mode: "workspace" },
    } as unknown as DriverStatus;
    const c = mount(
      <SimpleMode
        status={status}
        history={[]}
        connected={true}
        commands={[]}
        onSubmit={() => {}}
        onInterrupt={() => {}}
        onCycleMode={() => {}}
        onAnswerPermission={() => Promise.resolve(false)}
        notify={() => {}}
        parked={[]}
        onPark={() => {}}
        onDropParked={() => {}}
        onDraftApplied={() => {}}
        rootCard={null}
        onAgentRootSwitch={async () => {}}
        onAgentRootKeep={async () => {}}
        workspaceRoot="/w"
        onSwitchWorkspace={async () => {}}
        onOpenOtherWorkspace={() => {}}
        onShield={() => {}}
        fileOpsClient={null as never}
        onSideAsk={() => {}}
        sideQas={[]}
        onPromoteSideQa={() => {}}
        onDetachTool={onDetach}
      />,
    );
    const btn = c.querySelector("button.detach") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    await act(async () => { btn.click(); });
    expect(onDetach).toHaveBeenCalledWith("call_1");
  });
});
