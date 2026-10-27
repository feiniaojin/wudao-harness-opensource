// @vitest-environment jsdom
// ω99-99 — the quick-chat bubble (D1: same-window overlay), RED-first.
// Three forms (collapsed / input / stream) plus the waiting-user hint row;
// input sends over the Tauri event bus as {text} and collapses (feedback =
// the state frames flowing back, never a faked "received" line); Esc
// collapses without sending; empty/whitespace never sends; the stream form
// shows the answer tail plain-text bottom-aligned; and when the pet returns
// to idle the bubble LINGERS PET_BUBBLE_LINGER_MS then fades (fake timers).
// No @testing-library here — the repo's act + createRoot + native-event
// pattern (see css-test-utils / pet-root).
// ω99-272 — fold receipts appended（用户令「加一个折叠的功能不就解决了」）：
// 字符数只当触发器，全文恒在 DOM——折叠是视觉钳制，不是内容删减。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { existsSync, readFileSync } from "node:fs";
import { Bubble, PET_BUBBLE_LINGER_MS, PET_DELIVERY_MS, STREAM_FOLD_CHARS, TRANSCRIPT_FOLD_CHARS } from "../src/pet/Bubble.js";
import { WUDAO_PET_ANSWER_EVENT, WUDAO_PET_ASK_EVENT } from "../src/pet/pet-frame.js";
import { WUDAO_PET_OPEN_MAIN_EVENT } from "../src/pet/delivery.js";
import { tauriEmitEvent, tauriInvokeCommand } from "../src/tauri-invoke.js";
import type { BubbleProps } from "../src/pet/Bubble.js";
import type { PetDelivery } from "../src/pet/delivery.js";
import type { PetFrameAsk } from "../src/pet/pet-frame.js";
import type { PetSelection } from "../src/pet/selection.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/tauri-invoke.js", () => ({
  tauriEmitEvent: vi.fn(async () => false),
  // ω99-110：接单卡的「去系统设置打开」按钮走命令缝（引导卡）。
  tauriInvokeCommand: vi.fn(async () => null),
}));

const emitMock = vi.mocked(tauriEmitEvent);
const invokeMock = vi.mocked(tauriInvokeCommand);

let container: HTMLElement;
let root: Root;
let props: BubbleProps;
const closed = vi.fn();
const deliveryClosed = vi.fn();
const selectionClosed = vi.fn();
// ω99-201: 宠物源轮的发送回调（transcript 入账面）——send/划词三路改走
// 这里，收起语义退役（回答与输入同窗，用户令 09-08）。
const petTurn = vi.fn();

/** Render/re-render with the current props bag (the harness flips
 *  props.inputOpen when the bubble calls onInputClose, exactly as the pet
 *  entry does). */
function render(): void {
  act(() => {
    root.render(<Bubble {...props} />);
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  props = { inputOpen: false, answerTail: "", waitingUser: false, onInputClose: closed, delivery: null, onDeliveryClose: deliveryClosed, ask: null, selection: null, onSelectionClose: selectionClosed, busyNarration: null, workKind: null, transcript: [], onPetTurn: petTurn, livePending: false };
  emitMock.mockClear();
  invokeMock.mockClear();
  closed.mockClear();
  deliveryClosed.mockClear();
  selectionClosed.mockClear();
  petTurn.mockClear();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  document.body.innerHTML = "";
});

/** Set a controlled textarea's value the React way (native setter + input
 *  event — no testing-library in this repo). */
function typeInto(ta: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(ta, value);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(el: Element, key: string): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

const bubble = (): HTMLElement | null => container.querySelector<HTMLElement>("[data-bubble]");
const state = (): string | null | undefined => bubble()?.getAttribute("data-bubble-state");

describe("ω99-99 气泡三形态 + hint", () => {
  it("collapsed（默认）：无 input/tail/waiting → 不渲染气泡", () => {
    render();
    expect(bubble()).toBeNull();
  });

  it("input 形态：点击后 textarea（placeholder）+ 发送按钮", () => {
    props.inputOpen = true;
    render();
    expect(state()).toBe("input");
    const ta = container.querySelector<HTMLTextAreaElement>("textarea[data-bubble-input]");
    expect(ta).not.toBeNull();
    expect(ta?.placeholder).toBe("问点什么…");
    expect(container.querySelector<HTMLButtonElement>("[data-bubble-send]")?.textContent).toBe("发送");
  });

  it("stream 形态：answerTail 纯文本渲染（尾部）", () => {
    props.answerTail = "…这是回答的最后一段";
    render();
    expect(state()).toBe("stream");
    expect(bubble()?.textContent).toContain("…这是回答的最后一段");
  });

  it("waiting-user 优先于 stream：hint 行「在等你确认操作」", () => {
    props.waitingUser = true;
    props.answerTail = "还有正文";
    render();
    expect(state()).toBe("hint");
    expect(bubble()?.textContent).toContain("在等你确认操作");
    expect(bubble()?.textContent).not.toContain("还有正文");
  });
});

describe("ω99-99 气泡输入（发送/Esc/空值）", () => {
  // ω99-201: 钉随源演进（用户令 09-08「回答与输入同窗」）：send() 不再
  // onInputClose 收起——改 onPetTurn(digest) 进 transcript，聊天窗保持开
  // （回答与输入同窗；关法仍 Esc/✕/取消/失焦，143 军规）。emit 语义不动。
  it("Enter → emit(wudao-pet-ask,{text}) + onPetTurn(digest)，不收起", () => {
    props.inputOpen = true;
    render();
    const ta = container.querySelector<HTMLTextAreaElement>("textarea[data-bubble-input]")!;
    typeInto(ta, "你好，悟道");
    press(ta, "Enter");
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(WUDAO_PET_ASK_EVENT, { text: "你好，悟道" });
    expect(petTurn).toHaveBeenCalledTimes(1);
    expect(petTurn).toHaveBeenCalledWith("你好，悟道"); // ≤24 字原样 digest
    expect(closed).not.toHaveBeenCalled(); // 发送不收窗（ω99-201 聊天窗语义）
    expect(state()).toBe("input"); // 聊天窗保持开
  });

  it("点「发送」按钮同 Enter；文本经 trim", () => {
    props.inputOpen = true;
    render();
    const ta = container.querySelector<HTMLTextAreaElement>("textarea[data-bubble-input]")!;
    typeInto(ta, "  带空格  ");
    act(() => {
      container.querySelector("[data-bubble-send]")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(emitMock).toHaveBeenCalledWith(WUDAO_PET_ASK_EVENT, { text: "带空格" });
    expect(petTurn).toHaveBeenCalledWith("带空格");
    expect(closed).not.toHaveBeenCalled();
  });

  it("空输入 no-op：Enter 空串/纯空白 → 不 emit、不收起", () => {
    props.inputOpen = true;
    render();
    const ta = container.querySelector<HTMLTextAreaElement>("textarea[data-bubble-input]")!;
    press(ta, "Enter");
    typeInto(ta, "   ");
    press(ta, "Enter");
    expect(emitMock).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    expect(state()).toBe("input");
  });

  it("Esc → 收起且不发送", () => {
    props.inputOpen = true;
    render();
    const ta = container.querySelector<HTMLTextAreaElement>("textarea[data-bubble-input]")!;
    typeInto(ta, "写了但反悔");
    press(ta, "Escape");
    expect(closed).toHaveBeenCalledTimes(1);
    expect(emitMock).not.toHaveBeenCalled();
  });

  // ω99-143：用户实机反馈——「问点什么」点开后无法关闭。取消按钮=不依赖
  // 键盘焦点的确定性关闭通路（Esc 需宠物窗持焦，点别处即失）。
  it("「取消」按钮 → 收起且不发送（不依赖键盘焦点的关闭通路）", () => {
    props.inputOpen = true;
    render();
    const ta = container.querySelector<HTMLTextAreaElement>("textarea[data-bubble-input]")!;
    typeInto(ta, "写了但反悔");
    act(() => {
      container.querySelector("[data-bubble-cancel]")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("取消键只在 input 形态渲染（stream 无取消）", () => {
    props.answerTail = "流式正文";
    render();
    expect(state()).toBe("stream");
    expect(container.querySelector("[data-bubble-cancel]")).toBeNull();
  });
});

describe("ω99-99 回 idle 的 linger 淡出（fake timers）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // ω99-196: 钉随源演进——用户令 09-08「一闪而过，应该让用户主动关，因为
  // 是用户主动问的，所以必须操作对应」：stream（回答）永不自动淡出（✕ 是
  // 唯一关法，见 omega99-196-pet-answer-window.test.tsx receipts）；hint/
  // narration 保持 2500ms busy 瞬态（别域）。
  it("stream → idle：回答永不自动淡出（advance 任意时长仍 shown、无 fading）", () => {
    props.answerTail = "回答尾巴";
    render();
    expect(state()).toBe("stream");
    props.answerTail = ""; // 回 idle
    render();
    expect(state()).toBe("stream"); // held 阅读态：内容原样保持
    act(() => {
      vi.advanceTimersByTime(10_000); // 任意时长——不止 2500ms
    });
    expect(bubble()).not.toBeNull();
    expect(bubble()?.hasAttribute("data-bubble-fading")).toBe(false); // 永不进淡出
  });

  // ω99-196: 钉随源演进——stream 永不自动淡出后，「新内容到达」语义保留：
  // held 回答被新 tail 复活（活流续写），且从不进入 fading。
  it("held 回答被新内容复活：显示新 tail，且从不 fading", () => {
    props.answerTail = "旧";
    render();
    props.answerTail = "";
    render(); // held 阅读态（永不自动淡出）
    act(() => {
      vi.advanceTimersByTime(PET_BUBBLE_LINGER_MS + 100);
    });
    expect(bubble()?.hasAttribute("data-bubble-fading")).toBe(false); // ω99-196: 永不
    props.answerTail = "新内容";
    render(); // 复活
    expect(state()).toBe("stream");
    expect(bubble()?.hasAttribute("data-bubble-fading")).toBe(false);
    expect(bubble()?.textContent).toContain("新内容");
  });

  it("input 收起不 linger：发送后立即消失（不残留旧尾巴）", () => {
    props.answerTail = "上一轮尾巴";
    render();
    props.inputOpen = true; // 点开输入（linger 记忆被重置）
    render();
    const ta = container.querySelector<HTMLTextAreaElement>("textarea[data-bubble-input]")!;
    typeInto(ta, "问一句");
    press(ta, "Enter");
    props.inputOpen = false;
    props.answerTail = ""; // 帧尚未回流
    render();
    expect(bubble()).toBeNull(); // 立即收起，不 resurrect 旧尾巴
    act(() => {
      vi.advanceTimersByTime(PET_BUBBLE_LINGER_MS * 2);
    });
    expect(bubble()).toBeNull();
  });
});

describe("ω99-105 送达形态（delivery）", () => {
  const D1: PetDelivery = { taskId: "ab12cd34", promptDigest: "整理收件箱并汇报", answerDigest: "已整理，未读 3" };
  const D2: PetDelivery = { taskId: "ef99ab77", promptDigest: "汇总今日日程", answerDigest: "" };

  it("idle + 送达 → 标题 + promptDigest + answerDigest，data-bubble-state=delivery", () => {
    props.delivery = D1;
    render();
    expect(state()).toBe("delivery");
    expect(bubble()?.textContent).toContain("定时任务送达");
    expect(bubble()?.textContent).toContain("整理收件箱并汇报");
    expect(bubble()?.textContent).toContain("已整理，未读 3");
  });

  it("answerDigest 空串 → 摘要行不渲染（有则显示）", () => {
    props.delivery = D2;
    render();
    expect(bubble()?.textContent).toContain("汇总今日日程");
    expect(container.querySelector("[data-delivery-answer]")).toBeNull();
  });

  it("busy 帧优先：stream 压过 delivery（新 turn 开跑立即让位）", () => {
    props.delivery = D1;
    props.answerTail = "流式正文";
    render();
    expect(state()).toBe("stream");
    expect(bubble()?.textContent).not.toContain("定时任务送达");
    expect(bubble()?.textContent).toContain("流式正文");
  });

  it("busy 结束后送达回归（30s 内不消失，也不复活旧尾巴）", () => {
    props.delivery = D1;
    props.answerTail = "流式正文";
    render();
    props.answerTail = ""; // 新 turn 结束
    render();
    expect(state()).toBe("delivery");
    expect(bubble()?.textContent).toContain("定时任务送达");
    expect(bubble()?.textContent).not.toContain("流式正文");
  });

  it("linger：PET_DELIVERY_MS=30000 到点 onDeliveryClose", () => {
    vi.useFakeTimers();
    try {
      props.delivery = D1;
      render();
      expect(PET_DELIVERY_MS).toBe(30_000);
      act(() => {
        vi.advanceTimersByTime(PET_DELIVERY_MS - 1);
      });
      expect(deliveryClosed).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(deliveryClosed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("新送达替换旧送达：内容立即换、30s 从新送达重新起算", () => {
    vi.useFakeTimers();
    try {
      props.delivery = D1;
      render();
      act(() => {
        vi.advanceTimersByTime(20_000); // 旧送达只剩 10s
      });
      props.delivery = D2; // 新送达替换
      render();
      expect(bubble()?.textContent).toContain("汇总今日日程"); // 旧内容立即让位
      expect(bubble()?.textContent).not.toContain("整理收件箱并汇报");
      act(() => {
        vi.advanceTimersByTime(20_000); // 距新送达 20s：窗口已重开
      });
      expect(deliveryClosed).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(10_000); // 新送达满 30s
      });
      expect(deliveryClosed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Esc → onDeliveryClose（不 emit）", () => {
    props.delivery = D1;
    render();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(deliveryClosed).toHaveBeenCalledTimes(1);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("点击气泡正文 → onDeliveryClose + emit pet-open-main", () => {
    props.delivery = D1;
    render();
    act(() => {
      bubble()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(deliveryClosed).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(WUDAO_PET_OPEN_MAIN_EVENT, null);
  });
});

// --- ω99-109 ask 卡（权限确认直达宠物气泡）-----------------------------------
// 用户实机反馈 P0：「在等你确认操作，需要我不得不打开主窗口去确认」——宠物
// 已可见（waiting-user）但不可操作。卡=决策所需最小集（toolName+summary+
// 按钮组），答案语义与主窗完全一致（允许/总是允许/拒绝——一次性缺省）；
// 点击 emit wudao-pet-answer（主窗 relay 转成 answerPermission），本地不
// 乐观清卡——服务器是唯一事实源，下一状态帧 ask=null 才消。
describe("ω99-109 ask 卡（权限确认直达气泡）", () => {
  const A_ALWAYS: PetFrameAsk = { toolName: "Bash", summary: "rm -rf build 清理产物", canAlways: true };
  const A_ONCE: PetFrameAsk = { toolName: "Write", summary: "改 settings.json", canAlways: false };

  const card = (): HTMLElement | null => container.querySelector<HTMLElement>("[data-ask-card]");
  const btn = (sel: string): HTMLButtonElement | null => container.querySelector<HTMLButtonElement>(sel);
  const click = (sel: string): void => {
    act(() => {
      btn(sel)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  it("有卡时不渲染输入框形态：ask 压过 inputOpen（权限门不许被聊天遮住）", () => {
    props.ask = A_ALWAYS;
    props.inputOpen = true;
    render();
    expect(state()).toBe("ask");
    expect(container.querySelector("textarea[data-bubble-input]")).toBeNull();
  });

  it("卡压过 waiting-user hint（卡就是 waiting 的可操作形态）：徽标+摘要可见", () => {
    props.ask = A_ALWAYS;
    props.waitingUser = true;
    render();
    expect(state()).toBe("ask");
    expect(card()).not.toBeNull();
    expect(bubble()?.textContent).toContain("Bash");
    expect(bubble()?.textContent).toContain("rm -rf build 清理产物");
    expect(bubble()?.textContent).not.toContain("在等你确认操作");
  });

  it("canAlways=true → 三按钮 [允许][总是允许][拒绝]", () => {
    props.ask = A_ALWAYS;
    render();
    expect(btn("[data-ask-allow]")?.textContent).toBe("允许");
    expect(btn("[data-ask-always]")?.textContent).toBe("总是允许");
    expect(btn("[data-ask-deny]")?.textContent).toBe("拒绝");
  });

  it("canAlways=false → 两按钮（无「总是允许」——与主窗 settingsFile 降级同款）", () => {
    props.ask = A_ONCE;
    render();
    expect(btn("[data-ask-allow]")).not.toBeNull();
    expect(btn("[data-ask-always]")).toBeNull();
    expect(btn("[data-ask-deny]")).not.toBeNull();
  });

  it("点击允许 → emit {allow:true}（无 scope=一次）；点击后按钮全禁用，卡不本地清", () => {
    props.ask = A_ALWAYS;
    render();
    click("[data-ask-allow]");
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(WUDAO_PET_ANSWER_EVENT, { allow: true });
    expect(btn("[data-ask-allow]")?.disabled).toBe(true);
    expect(btn("[data-ask-always]")?.disabled).toBe(true);
    expect(btn("[data-ask-deny]")?.disabled).toBe(true);
    expect(state()).toBe("ask"); // 本地不乐观清卡——等下一状态帧
  });

  it("点击总是允许 → emit {allow:true,scope:\"always\"}", () => {
    props.ask = A_ALWAYS;
    render();
    click("[data-ask-always]");
    expect(emitMock).toHaveBeenCalledWith(WUDAO_PET_ANSWER_EVENT, { allow: true, scope: "always" });
  });

  it("点击拒绝 → emit {allow:false}（不带 scope 键）", () => {
    props.ask = A_ONCE;
    render();
    click("[data-ask-deny]");
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock.mock.calls[0]![1]).toEqual({ allow: false });
  });

  it("防连点：禁用后再点不重复 emit", () => {
    props.ask = A_ALWAYS;
    render();
    click("[data-ask-allow]");
    click("[data-ask-allow]");
    expect(emitMock).toHaveBeenCalledTimes(1);
  });

  it("应答回流：下一帧 ask=null → 卡消失（服务器是唯一事实源）", () => {
    props.ask = A_ALWAYS;
    render();
    props.ask = null;
    render();
    expect(bubble()).toBeNull();
  });

  it("卡不 linger：ask=null 后即使无 stream 也不复活旧 hint/尾巴", () => {
    vi.useFakeTimers();
    try {
      props.ask = A_ALWAYS;
      render();
      props.ask = null;
      render();
      expect(bubble()).toBeNull();
      act(() => {
        vi.advanceTimersByTime(PET_BUBBLE_LINGER_MS * 2);
      });
      expect(bubble()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("流式正文在卡下被遮；卡消后 stream 接管（不残留卡）", () => {
    props.answerTail = "流式正文";
    props.ask = A_ALWAYS;
    render();
    expect(state()).toBe("ask");
    expect(bubble()?.textContent).not.toContain("流式正文");
    props.ask = null; // 应答被接受，权限门落下
    render();
    expect(state()).toBe("stream");
  });

  it("新 ask（不同内容）到达 → 按钮重新可用（新权限门可再答）", () => {
    props.ask = A_ALWAYS;
    render();
    click("[data-ask-allow]");
    expect(btn("[data-ask-allow]")?.disabled).toBe(true);
    props.ask = A_ONCE;
    render();
    expect(btn("[data-ask-allow]")?.disabled).toBe(false);
    expect(btn("[data-ask-always]")).toBeNull(); // 新卡按自己的 canAlways 渲染
  });

  it("Esc 不关卡（权限门不让 Esc 逃逸——与主窗 modal 语义一致）", () => {
    props.ask = A_ALWAYS;
    render();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(state()).toBe("ask");
    expect(emitMock).not.toHaveBeenCalled();
  });
});

// --- ω99-110 划词接单卡（selection）-------------------------------------------
// 优先级 ask > selection > input > hint > stream > delivery（两卡同在=ask 赢，
// 接单卡压过聊天输入——划词委托是更新的意图）。三路发送（翻译/解释 chip 即发
// 且忽略框内未发文字；提问框空=generic 有字=question，回车=发送；取消=仅清卡）
// 每路 = emit submit 事件 + 本地清卡——客户端源=本地清合法（与 ask 的服务器
// 真相语义相反，依据：接单卡由热键事件驱动、无服务器态可等，卡的存在本身就是
// 本地事实）。granted=false → 权限引导卡；text="" → 空态。Esc=清卡；ask 在场
// 时 Esc 仍被 109 语义抑制。
describe("ω99-110 划词接单卡（selection）", () => {
  // 事件名与 payload 形状逐字钉（Rust/selection.ts 双端同名）。
  const SUBMIT = "wudao-pet-selection-submit";
  const SEL: PetSelection = { text: "the quick brown fox", truncated: false, granted: true };
  // 本块自有的 ask/delivery 夹具（109/105 的 describe 内常量不跨块可见）。
  const ASK: PetFrameAsk = { toolName: "Bash", summary: "rm -rf build", canAlways: true };
  const DELIVERY: PetDelivery = { taskId: "ab12cd34", promptDigest: "整理收件箱并汇报", answerDigest: "已整理" };

  const card = (): HTMLElement | null => container.querySelector<HTMLElement>("[data-selection-card]");
  const btn = (sel: string): HTMLButtonElement | null => container.querySelector<HTMLButtonElement>(sel);
  const click = (sel: string): void => {
    act(() => {
      btn(sel)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };
  function typeIntoInput(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("优先级：ask > selection（两卡同在=ask 赢，109 语义不动）", () => {
    props.selection = SEL;
    props.ask = ASK;
    render();
    expect(state()).toBe("ask");
    expect(card()).toBeNull();
  });

  it("优先级：selection > input > hint/stream/delivery", () => {
    props.selection = SEL;
    props.inputOpen = true;
    props.waitingUser = true;
    props.answerTail = "流式正文";
    props.delivery = DELIVERY;
    render();
    expect(state()).toBe("selection");
    expect(card()).not.toBeNull();
    expect(container.querySelector("textarea[data-bubble-input]")).toBeNull();
    expect(card()?.textContent).not.toContain("流式正文");
  });

  it("granted 卡内容：选文摘录 + 翻译/解释 chip + 提问框（placeholder）+ 发送 + 取消", () => {
    props.selection = SEL;
    render();
    expect(card()?.textContent).toContain("the quick brown fox");
    expect(btn("[data-selection-translate]")?.textContent).toBe("翻译");
    expect(btn("[data-selection-explain]")?.textContent).toBe("解释");
    const input = container.querySelector<HTMLInputElement>("input[data-selection-question]");
    expect(input).not.toBeNull();
    expect(input?.placeholder).toBe("想问它什么？");
    expect(btn("[data-selection-send]")?.textContent).toBe("发送");
    expect(btn("[data-selection-cancel]")?.textContent).toBe("取消");
  });

  it("chip「翻译」→ 立即以 translatePrompt 发（submit 事件）+ 本地清卡", () => {
    props.selection = SEL;
    render();
    click("[data-selection-translate]");
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(SUBMIT, {
      text: "翻译这段划选的文字（按原文方向中英互译）：\n\nthe quick brown fox",
    });
    expect(selectionClosed).toHaveBeenCalledTimes(1); // 本地清卡（客户端源合法）
  });

  it("chip 与提问框互斥：点 chip 即发，忽略框内未发文字", () => {
    props.selection = SEL;
    render();
    typeIntoInput(container.querySelector<HTMLInputElement>("input[data-selection-question]")!, "想问语法");
    click("[data-selection-explain]");
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(SUBMIT, {
      text: "解释这段划选的文字：\n\nthe quick brown fox",
    }); // 框内文字不掺入
  });

  it("提问框空 + 发送 → genericPrompt", () => {
    props.selection = SEL;
    render();
    click("[data-selection-send]");
    expect(emitMock).toHaveBeenCalledWith(SUBMIT, {
      text: "帮我看看这段划选的文字：\n\nthe quick brown fox",
    });
  });

  it("提问框有字 + 发送 → questionPrompt（问题在前选文附后）", () => {
    props.selection = SEL;
    render();
    typeIntoInput(container.querySelector<HTMLInputElement>("input[data-selection-question]")!, "这句语法对吗");
    click("[data-selection-send]");
    expect(emitMock).toHaveBeenCalledWith(SUBMIT, {
      text: "这句语法对吗\n\n（划选的文字：\nthe quick brown fox\n）",
    });
  });

  it("回车=发送（提问框 keydown Enter）", () => {
    props.selection = SEL;
    render();
    const input = container.querySelector<HTMLInputElement>("input[data-selection-question]")!;
    typeIntoInput(input, "换个问法");
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(SUBMIT, {
      text: "换个问法\n\n（划选的文字：\nthe quick brown fox\n）",
    });
    expect(selectionClosed).toHaveBeenCalledTimes(1);
  });

  it("取消 = 仅清卡不发送", () => {
    props.selection = SEL;
    render();
    click("[data-selection-cancel]");
    expect(selectionClosed).toHaveBeenCalledTimes(1);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("Esc = 清 selection 卡（不发送）；ask 在场时 Esc 被抑制（109 分支不动）", () => {
    props.selection = SEL;
    render();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(selectionClosed).toHaveBeenCalledTimes(1);
    expect(emitMock).not.toHaveBeenCalled();
    // ask 在场：Esc 既不关卡也不清 selection（权限门优先）
    props.selection = SEL;
    props.ask = ASK;
    render();
    selectionClosed.mockClear();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(selectionClosed).not.toHaveBeenCalled();
    expect(state()).toBe("ask");
  });

  it("防连点：chip 点击后禁用，双击只发一次（照 ask）", () => {
    props.selection = SEL;
    render();
    click("[data-selection-translate]");
    expect(btn("[data-selection-translate]")?.disabled).toBe(true);
    click("[data-selection-translate]"); // 禁用态二次点击
    expect(emitMock).toHaveBeenCalledTimes(1);
  });

  it("granted=false → 权限引导卡：「需要辅助功能权限」+ 去系统设置打开（命令缝）", () => {
    props.selection = { text: "", truncated: false, granted: false };
    render();
    expect(state()).toBe("selection");
    const guide = container.querySelector<HTMLElement>("[data-selection-guide]");
    expect(guide).not.toBeNull();
    expect(guide?.textContent).toContain("需要辅助功能权限");
    click("[data-selection-open-settings]");
    expect(invokeMock).toHaveBeenCalledWith("open_accessibility_settings", {});
    expect(emitMock).not.toHaveBeenCalled(); // 引导卡不发 submit
  });

  it("text=\"\"（trusted 但没划到）→ 空态「没划到文字」仅取消：无 chip/无提问框", () => {
    props.selection = { text: "", truncated: false, granted: true };
    render();
    expect(state()).toBe("selection");
    const empty = container.querySelector<HTMLElement>("[data-selection-empty]");
    expect(empty?.textContent).toContain("没划到文字");
    expect(btn("[data-selection-translate]")).toBeNull();
    expect(container.querySelector("input[data-selection-question]")).toBeNull();
    expect(btn("[data-selection-cancel]")).not.toBeNull();
    click("[data-selection-cancel]");
    expect(selectionClosed).toHaveBeenCalledTimes(1);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("新选段替换旧卡（单槽）+ 截断标记随选文显示", () => {
    props.selection = SEL;
    render();
    expect(card()?.textContent).toContain("the quick brown fox");
    props.selection = { text: "超长选文…\n…（已截断）", truncated: true, granted: true };
    render();
    expect(card()?.textContent).toContain("…（已截断）");
    expect(card()?.textContent).not.toContain("the quick brown fox");
  });

  it("卡不 linger：关闭后立即消失（不复活旧尾巴）", () => {
    vi.useFakeTimers();
    try {
      props.selection = SEL;
      render();
      props.selection = null; // 发送/取消后父级清槽
      render();
      expect(bubble()).toBeNull();
      act(() => {
        vi.advanceTimersByTime(PET_BUBBLE_LINGER_MS * 2);
      });
      expect(bubble()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- ω99-113 旁白形态（narration）---------------------------------------------
// busyTools 态的人话面（弧门：宠物全程说人话）。优先级链取 98 机器同款次序
// 的气泡投影：ask > selection > input > hint > narration > stream > delivery
// ——waiting-user > busyTools > answer，旁白是 busyTools 级信号，压过流式
// 正文（模型先说了「我来打开网页」再调工具时，尾巴不遮旁白）；非 browser
// 工具在飞（busyNarration=null）时宠物面维持既有呈现（stream/无气泡）。
// 旁白与 hint/stream 同族：busy 瞬态，linger 2500ms 后淡出。
describe("ω99-113 旁白形态（narration）", () => {
  it("browser 旁白到达 → narration 形态显示人话（data-bubble-state=narration）", () => {
    props.busyNarration = "正在打开网页…";
    render();
    expect(state()).toBe("narration");
    expect(bubble()?.textContent).toContain("正在打开网页…");
    expect(bubble()?.querySelector("[data-bubble-narration]")).not.toBeNull();
  });

  it("v7 γ1：workKind 落 data-work-kind 锚（形态差异的将来缝；无 CSS 消费=零视觉变化，null=锚缺席）", () => {
    props.busyNarration = "正在跑命令「npm test」";
    props.workKind = "command";
    render();
    expect(state()).toBe("narration");
    expect(bubble()?.querySelector("[data-bubble-narration]")?.getAttribute("data-work-kind")).toBe("command");
  });

  it("v7 γ1：workKind=null → 锚缺席（不是空串——缺席与空值同形）", () => {
    props.busyNarration = "正在打开网页…";
    props.workKind = null;
    render();
    expect(bubble()?.querySelector("[data-bubble-narration]")?.getAttribute("data-work-kind")).toBeNull();
  });

  it("旁白压过 stream：busyTools > answer（模型先说话再调工具时尾巴不遮旁白）", () => {
    props.busyNarration = "正在读页面…";
    props.answerTail = "我来打开网页看看";
    render();
    expect(state()).toBe("narration");
    expect(bubble()?.textContent).toContain("正在读页面…");
    expect(bubble()?.textContent).not.toContain("我来打开网页看看");
  });

  it("hint 压过旁白：waiting-user > busyTools（98 链次序的气泡投影）", () => {
    props.busyNarration = "正在读页面…";
    props.waitingUser = true;
    render();
    expect(state()).toBe("hint");
    expect(bubble()?.textContent).toContain("在等你确认操作");
    expect(bubble()?.textContent).not.toContain("正在读页面…");
  });

  it("input 压过旁白：用户点开的输入框不被 busy 遮", () => {
    props.busyNarration = "正在读页面…";
    props.inputOpen = true;
    render();
    expect(state()).toBe("input");
  });

  it("旁白压过 delivery（busy 帧优先于滞留送达，与 stream 同规则）", () => {
    props.busyNarration = "正在打开网页…";
    props.delivery = { taskId: "ab12cd34", promptDigest: "整理收件箱", answerDigest: "已整理" };
    render();
    expect(state()).toBe("narration");
    expect(bubble()?.textContent).not.toContain("定时任务送达");
  });

  it("busyNarration=null（非 browser 工具在飞/无在飞）→ 无旁白形态，落到 stream（既有呈现不动）", () => {
    props.busyNarration = null;
    props.answerTail = "流式正文";
    render();
    expect(state()).toBe("stream"); // 尾巴照显——null 旁白不改变任何既有行为
    props.answerTail = "";
    props.busyNarration = null;
    render();
    // 清空后进入 linger（既有 stream 语义），2500ms 内不出旁白形态
    expect(state()).not.toBe("narration");
    expect(bubble()?.querySelector("[data-bubble-narration]")).toBeNull();
  });

  it("旁白是 busy 瞬态：narration→null 后 linger 2500ms 内容保持再淡出（与 hint/stream 同族）", () => {
    vi.useFakeTimers();
    try {
      props.busyNarration = "已合上浏览器窗口";
      render();
      expect(state()).toBe("narration");
      props.busyNarration = null;
      render();
      expect(state()).toBe("narration"); // linger：内容原样保持
      act(() => {
        vi.advanceTimersByTime(PET_BUBBLE_LINGER_MS - 1);
      });
      expect(bubble()).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(PET_BUBBLE_LINGER_MS);
      });
      expect(bubble()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("旁白与正文接力：narration→null 且 answer 到达 → stream 接管不残留旁白", () => {
    props.busyNarration = "正在读页面…";
    render();
    props.busyNarration = null;
    props.answerTail = "第 2 页找到 3 条相关内容";
    render();
    expect(state()).toBe("stream");
    expect(bubble()?.textContent).toContain("第 2 页找到 3 条相关内容");
    expect(bubble()?.textContent).not.toContain("正在读页面…");
  });
});

// --- ω99-113 划词网址直读 chip（selection 卡第五路发送） -------------------------
// URL 判定命中（isUrlSelection）→ 接单卡多出「读这个网页」chip，复用既有
// chip 样式与提交车道（emit submit 事件 + 本地清卡 + 防连点锁）；话术走
// urlPrompt 逐字。非 URL 划段不出现——宁缺勿误。
describe("ω99-113 划词网址 chip（读这个网页）", () => {
  const URL_SEL: PetSelection = { text: "https://example.com/article", truncated: false, granted: true };

  const btn = (sel: string): HTMLButtonElement | null => container.querySelector<HTMLButtonElement>(sel);
  const click = (sel: string): void => {
    act(() => {
      btn(sel)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  it("URL 划段 → 「读这个网页」chip 出现（与翻译/解释并列，既有 chip 不动）", () => {
    props.selection = URL_SEL;
    render();
    expect(btn("[data-selection-url]")?.textContent).toBe("读这个网页");
    expect(btn("[data-selection-translate]")?.textContent).toBe("翻译");
    expect(btn("[data-selection-explain]")?.textContent).toBe("解释");
  });

  it("点击 → 以 urlPrompt 话术发 submit + 本地清卡（复用既有车道）", () => {
    props.selection = URL_SEL;
    render();
    click("[data-selection-url]");
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith("wudao-pet-selection-submit", {
      text: "用浏览器打开 https://example.com/article，把页面上主要讲了什么读给我听",
    });
    expect(selectionClosed).toHaveBeenCalledTimes(1);
  });

  it("非 URL 划段 → chip 不出现（翻译/解释照旧）", () => {
    props.selection = { text: "the quick brown fox", truncated: false, granted: true };
    render();
    expect(btn("[data-selection-url]")).toBeNull();
    expect(btn("[data-selection-translate]")).not.toBeNull();
  });

  it("纯域名（无 scheme）→ chip 不出现（宁缺勿误）", () => {
    props.selection = { text: "example.com/article", truncated: false, granted: true };
    render();
    expect(btn("[data-selection-url]")).toBeNull();
  });

  it("带首尾空白的 URL → 判定命中，话术带 trim 后的 URL", () => {
    props.selection = { text: "  https://example.com/a  ", truncated: false, granted: true };
    render();
    expect(btn("[data-selection-url]")).not.toBeNull();
    click("[data-selection-url]");
    expect(emitMock).toHaveBeenCalledWith("wudao-pet-selection-submit", {
      text: "用浏览器打开 https://example.com/a，把页面上主要讲了什么读给我听",
    });
  });

  it("空文空态卡 → 无 chip（空态本就无 chips）", () => {
    props.selection = { text: "", truncated: false, granted: true };
    render();
    expect(btn("[data-selection-url]")).toBeNull();
    expect(btn("[data-selection-translate]")).toBeNull();
  });

  it("防连点：chip 点击后禁用，双击只发一次（照既有 chips 锁）", () => {
    props.selection = URL_SEL;
    render();
    click("[data-selection-url]");
    expect(btn("[data-selection-url]")?.disabled).toBe(true);
    click("[data-selection-url]");
    expect(emitMock).toHaveBeenCalledTimes(1);
  });
});

// --- ω99-272 折叠（fold）--------------------------------------------------------
// 用户令 09-10「流面尾窗不要限制字数，加一个折叠的功能不就解决了」：字符数只当
// 触发器，全文恒在 state/DOM——折叠是视觉钳制（css max-height/mask），不是
// 内容删减。流面：全文超 STREAM_FOLD_CHARS 出「展开全文」钮（尾窗⇄全文内滚，
// data-stream-expanded）；transcript：冻结轮 q/a 超 TRANSCRIPT_FOLD_CHARS 出
// 「查看全文」钮（data-folded；live 轮永不折——流式增长中的折叠跳变是打扰）；
// 新 turn（空 tail）流面展开态复位（与 dismissedTail 同一 effect 模式）。
// ω99-274 演进：阈值 300→100、词面「展开」→「查看全文」、钮入气泡内
// 信息末尾、钳制行量化（见下方 274 describe 的 CSS 收据）。
describe("ω99-272: #10 — 折叠（流面尾窗 / transcript 冻结轮）", () => {
  const stream = (): HTMLElement | null => container.querySelector<HTMLElement>(".pet-bubble-stream");
  const toggle = (): HTMLButtonElement | null => container.querySelector<HTMLButtonElement>("[data-stream-toggle]");
  const foldBtns = (): NodeListOf<HTMLButtonElement> => container.querySelectorAll<HTMLButtonElement>("[data-bubble-fold]");
  const clickBtn = (el: HTMLButtonElement | null): void => {
    act(() => {
      el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  it("阈值常量逐字：STREAM_FOLD_CHARS=600、TRANSCRIPT_FOLD_CHARS=100（触发器，非截断）", () => {
    expect(STREAM_FOLD_CHARS).toBe(600);
    expect(TRANSCRIPT_FOLD_CHARS).toBe(100);
  });

  it("流面：短文（≤600）无折叠钮、无展开态属性（尾窗即全文——既有呈现不动）", () => {
    props.answerTail = "答".repeat(600);
    render();
    expect(state()).toBe("stream");
    expect(toggle()).toBeNull();
    expect(stream()?.hasAttribute("data-stream-expanded")).toBe(false);
    expect(bubble()?.textContent).toContain("答".repeat(600)); // 全文在场
  });

  it("流面：超 600 出「展开全文」钮；点击展开（data-stream-expanded + 收起）再点击收回", () => {
    props.answerTail = `${"答".repeat(598)}END`;
    render();
    expect(toggle()?.textContent).toBe("展开全文");
    expect(stream()?.hasAttribute("data-stream-expanded")).toBe(false);
    // 折叠态全文也在 DOM——头部与尾部都找得到（不是尾窗切片）
    expect(stream()?.textContent).toContain("答".repeat(20));
    expect(stream()?.textContent).toContain("END");
    clickBtn(toggle());
    expect(stream()?.hasAttribute("data-stream-expanded")).toBe(true);
    expect(toggle()?.textContent).toBe("收起");
    clickBtn(toggle());
    expect(stream()?.hasAttribute("data-stream-expanded")).toBe(false);
    expect(toggle()?.textContent).toBe("展开全文");
  });

  it("流面：新 turn（空 tail）展开态复位——新一轮从尾窗重新看起", () => {
    props.answerTail = "答".repeat(601);
    render();
    clickBtn(toggle());
    expect(stream()?.hasAttribute("data-stream-expanded")).toBe(true); // 已展开
    props.answerTail = ""; // turn 结束（held 阅读态，effect 复位在此刻发生）
    render();
    props.answerTail = "新".repeat(601); // 新 turn 开跑
    render();
    expect(stream()?.hasAttribute("data-stream-expanded")).toBe(false); // 复位
    expect(toggle()?.textContent).toBe("展开全文");
  });

  it("transcript：冻结轮 a 超 100 出「查看全文」钮 + data-folded；点击展开/收起往返", () => {
    props.inputOpen = true;
    props.transcript = [{ q: "长答问", a: `${"甲".repeat(99)}END`, live: false }];
    render();
    const cell = container.querySelector<HTMLElement>("[data-bubble-transcript] .pet-bubble-a")!;
    expect(cell.hasAttribute("data-folded")).toBe(true);
    expect(foldBtns()).toHaveLength(1);
    expect(foldBtns()[0]?.textContent).toBe("查看全文");
    // 折叠态全文恒在 DOM（甲…END 一字不少——视觉钳制非删减）
    expect(cell.textContent).toContain("甲".repeat(30));
    expect(cell.textContent).toContain("END");
    clickBtn(foldBtns()[0] ?? null);
    expect(cell.hasAttribute("data-folded")).toBe(false);
    expect(foldBtns()[0]?.textContent).toBe("收起");
    clickBtn(foldBtns()[0] ?? null);
    expect(cell.hasAttribute("data-folded")).toBe(true);
  });

  it("transcript：短答（≤100）无钮无 data-folded——短内容 DOM 与既有锚点零差", () => {
    props.inputOpen = true;
    props.transcript = [
      { q: "短问", a: "答".repeat(100), live: false }, // 恰 100=不折（阈值严格大于）
      { q: "空答轮", a: "", live: false },
    ];
    render();
    expect(foldBtns()).toHaveLength(0);
    const cells = container.querySelectorAll<HTMLElement>("[data-bubble-transcript] .pet-bubble-a");
    expect(cells).toHaveLength(1); // 空答轮不渲 a 格（既有规则）
    expect(cells[0]?.hasAttribute("data-folded")).toBe(false);
  });

  it("transcript：live 轮永不折（>100 也不出钮）——流式增长中的折叠跳变是打扰", () => {
    props.inputOpen = true;
    props.transcript = [{ q: "正在答", a: "长".repeat(500), live: true }];
    render();
    const cell = container.querySelector<HTMLElement>("[data-bubble-transcript] .pet-bubble-a")!;
    expect(cell.hasAttribute("data-folded")).toBe(false);
    expect(foldBtns()).toHaveLength(0);
  });
});

// --- ω99-274 聊天记录的头像与聊天气泡 + 100 字行量化折叠 ---------------------------
// 用户令 09-10 两连：①「在聊天记录中，使用小精灵的头像和聊天气泡，气泡内内容
// 超过 100 字在信息末尾折叠，用查看全文展开」②「现在的折叠太粗暴了，直接只
// 显示半行内容，太丑」。①②的修复面：宠物侧消息=当前肤 sheet 左帧头像+左尾角
// 气泡（「思考中…」同进宠物行）；q/a 各自独立折叠（mergeChat 会把 q 从摘要
// 升级成全文——用户气泡也会超长）；钮在气泡内信息末尾；钳制按 1.65 行高的
// 整倍数切行（旧 96px 在 1.65 行高下落 4.47 行=切半行，即「粗暴」病根）。
describe("ω99-274: #5 — 聊天记录的头像与聊天气泡 + 100 字行量化折叠", () => {
  const foldBtns = (): NodeListOf<HTMLButtonElement> => container.querySelectorAll<HTMLButtonElement>("[data-bubble-fold]");
  const clickBtn = (el: HTMLButtonElement | null): void => {
    act(() => {
      el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };
  // jsdom 的 fs 锚用 process.cwd() 候选位（178/203 两证——import.meta.url 在
  // jsdom 环境不可靠）。
  const readPetSrc = (rel: string): string => {
    const hit = ["src/pet", "packages/web/src/pet"]
      .map((d) => `${process.cwd()}/${d}/${rel}`)
      .find((p) => existsSync(p));
    if (hit === undefined) throw new Error(`pet source not found: ${rel}`);
    return readFileSync(hit, "utf8");
  };

  it("宠物侧消息带头像：缺省=default 肤 sheet URL；头像与 a 气泡同行；用户侧零头像", () => {
    props.inputOpen = true;
    props.transcript = [{ q: "问", a: "答", live: false }];
    render();
    const avatars = container.querySelectorAll<HTMLElement>("[data-pet-avatar]");
    expect(avatars).toHaveLength(1);
    expect(avatars[0]?.style.backgroundImage).toContain("/pet/skin-default.png"); // 缺省=与精灵本尊同肤
    const row = container.querySelector<HTMLElement>(".pet-row-pet");
    expect(row?.querySelector(".pet-bubble-a")).not.toBeNull(); // 头像与回答气泡同行
    expect(row?.querySelector("[data-pet-avatar]")).not.toBeNull();
    expect(container.querySelector(".pet-msg-user .pet-bubble-q")).not.toBeNull(); // q=右侧用户气泡
    expect(container.querySelector(".pet-msg-user [data-pet-avatar]")).toBeNull(); // 用户侧无头像
  });

  it("skinId 传参 → 头像跟随当前肤（lake）——与精灵换肤同链生效", () => {
    props.inputOpen = true;
    props.transcript = [{ q: "问", a: "答", live: false }];
    props.skinId = "lake";
    render();
    expect(container.querySelector<HTMLElement>("[data-pet-avatar]")?.style.backgroundImage).toContain("/pet/skin-lake.png");
  });

  it("「思考中…」也进宠物行（头像旁的左尾角气泡），不再裸行", () => {
    props.inputOpen = true;
    props.transcript = [{ q: "刚问的", a: "", live: true }];
    render();
    const thinking = container.querySelector("[data-bubble-transcript] .pet-bubble-thinking");
    expect(thinking).not.toBeNull();
    expect(thinking?.closest(".pet-row-pet")?.querySelector("[data-pet-avatar]")).not.toBeNull();
  });

  it("q 与 a 独立折叠：q 超 100 出自己的「查看全文」，展开互不干扰；q 全文恒在 DOM", () => {
    props.inputOpen = true;
    props.transcript = [{ q: "问".repeat(101), a: "答".repeat(101), live: false }];
    render();
    const q = container.querySelector<HTMLElement>("[data-bubble-transcript] .pet-bubble-q")!;
    const a = container.querySelector<HTMLElement>("[data-bubble-transcript] .pet-bubble-a")!;
    expect(q.hasAttribute("data-folded")).toBe(true);
    expect(a.hasAttribute("data-folded")).toBe(true);
    expect(foldBtns()).toHaveLength(2);
    expect(foldBtns()[0]?.textContent).toBe("查看全文"); // DOM 序：q 钮在前（用户行先渲染）
    expect(q.textContent).toContain("问".repeat(50)); // 折叠态 q 全文在场（摘要已升级全文）
    clickBtn(foldBtns()[0] ?? null); // 只展开 q
    expect(q.hasAttribute("data-folded")).toBe(false);
    expect(a.hasAttribute("data-folded")).toBe(true); // a 的折叠态不被 q 的钮带走
    expect(foldBtns()[0]?.textContent).toBe("收起");
  });

  it("钮在气泡内信息末尾：a 的 [data-bubble-fold] 是 .pet-bubble-a 子级；正文体 .pet-bubble-body 承载 markdown", () => {
    props.inputOpen = true;
    props.transcript = [{ q: "问", a: "答".repeat(101), live: false }];
    render();
    const a = container.querySelector<HTMLElement>("[data-bubble-transcript] .pet-bubble-a")!;
    const body = a.querySelector(".pet-bubble-body");
    const btn = a.querySelector("[data-bubble-fold]");
    expect(body).not.toBeNull();
    expect(btn).not.toBeNull();
    expect(btn?.parentElement).toBe(a); // 钮在气泡内（信息末尾）
    expect(body?.querySelector(".pet-md")).not.toBeNull(); // markdown 在正文体里（210 断言面的新锚点）
  });

  it("CSS 收据：行量化钳制（3×1.65em 恒整行）+ 只淡末 1.4em；旧 96px/60% 渐隐退役；头像单帧零形变", () => {
    const css = readPetSrc("pet.css");
    expect(css).toContain("max-height: calc(3 * 1.65em)"); // 整行倍数——任何字号下不出半行
    expect(css).toContain("linear-gradient(180deg, var(--shade) calc(100% - 1.4em), transparent)"); // 只淡末段（119b：mask 黑值走 --shade 令牌）
    expect(css).not.toContain("max-height: 96px"); // 旧粗暴钳制（4.47 行=切半行）退役
    expect(css).not.toContain("#000 60%"); // 旧大范围渐隐退役
    const avatarAt = css.indexOf(".pet-avatar {");
    const avatarBlock = css.slice(avatarAt, avatarAt + 420);
    expect(avatarBlock).toContain("background-size: 200% auto"); // 整 sheet 2 倍宽 → 单帧恰=盒宽
    expect(avatarBlock).toContain("background-position: 0 center"); // 左帧（睁眼）
    // 119b：气泡复合角（10/10/3 尾角族）退役——q/a/thinking 全走 --radius-md
    // 8px 均匀角，与主窗 119 规范的气泡族同形。
    expect(css).toContain("border-radius: var(--radius-md)");
    expect(css).not.toContain("10px 10px 3px");
    expect(css).not.toMatch(/border-radius:\s*\d(?!\d*%)/) // 50%（圆帽）豁免——119b 滚动条圆帽; // 零裸值圆角（含一切复合角形）
  });

  it("入口接线收据：PetApp 给 Bubble 传 skinId（换肤事件链只加这一跳；ω99-291 拆分后挂载块在 PetApp.tsx）", () => {
    const petAppSrc = readPetSrc("PetApp.tsx");
    const bubbleMount = petAppSrc.slice(petAppSrc.indexOf("<Bubble"), petAppSrc.indexOf("<PetSprite"));
    expect(bubbleMount).toContain("skinId={skinId}");
  });
});
