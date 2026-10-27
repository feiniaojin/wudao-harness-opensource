// @vitest-environment jsdom
// UI-5 INFO-2 — the focus-return sweep: every overlay that steals focus on
// mount must hand it BACK to its trigger on unmount. Direct-mount pins for
// PermissionModal / ClearConfirm / ResumePicker / AskUserCards
// / PlanReview, the App-driven pin for NewChatConfirm (inline in App.tsx),
// and the SimpleApprovalCard RELEASE-contract break-guard (the composer
// remount + InputBox mount-focus is the pinned mechanism — see the comment
// in SimpleApprovalCard.tsx for why no useFocusReturn rides that card).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DriverStatus } from "../src/protocol.js";
import { App } from "../src/components/App.js";
import { WudaoClient } from "../src/protocol.js";
import { PermissionModal } from "../src/components/PermissionModal.js";
import { ClearConfirm } from "../src/components/ClearConfirm.js";
import { ResumePicker } from "../src/components/ResumePicker.js";
import { AskUserCards } from "../src/components/AskUserCards.js";
import { PlanReview } from "../src/components/PlanReview.js";
import { authOk, fakeServer } from "./mock-ws.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;
const mount = (el: React.ReactElement): HTMLElement => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(el);
  });
  return container;
};
/** Renders `next` into the SAME root — the in-place unmount path (the
 *  conditional that dropped the overlay in the real shells). */
const replace = (next: React.ReactElement): void => {
  act(() => {
    root?.render(next);
  });
};

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container = null;
  document.body.innerHTML = "";
  window.localStorage.removeItem("wudao.ui.v1");
});

/** A focused, still-attached trigger — what the overlay must return to. */
function focusedTrigger(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.textContent = "trigger";
  document.body.appendChild(btn);
  act(() => {
    btn.focus();
  });
  expect(document.activeElement).toBe(btn);
  return btn;
}

const status = (over: Partial<DriverStatus>): DriverStatus => ({
  live: { reasoning: "", answer: "", busyTools: [] },
  busy: false,
  queued: [],
  boardProgress: null,
  ctxTokens: null,
  mode: "workspace",
  cachePercent: null,
  bg: { active: 0, spawned: 0 },
  pendingPermission: null,
  planBoard: null,
  sessionId: "wudao-test-0001",
  sidecar: null,
  ...over,
});

describe("UI-5 INFO-2 — overlays hand focus back to their trigger", () => {
  it("PermissionModal: the ask steals focus while parked, and resolution returns it to the composer-side trigger", () => {
    const trigger = focusedTrigger();
    mount(<PermissionModal ask={{ toolName: "shell", summary: "npm t", input: {} }} onChoose={() => {}} />);
    const card = document.querySelector(".permission-card") as HTMLElement;
    expect(document.activeElement).toBe(card); // the steal (I3's dialog-owns-focus)
    replace(<div />);
    expect(document.activeElement).toBe(trigger); // NOT <body>
  });

  // 2026-08-28: the ModelPicker case retired with the modal (the composer's
  // ModelSelector dropdown is chip-scoped — focus handling per
  // model-selector.test.tsx; the hook's other dialog users stay pinned here).

  it("ClearConfirm: resolution returns focus to whatever opened the confirm", () => {
    const trigger = focusedTrigger();
    mount(<ClearConfirm onChoose={() => {}} />);
    const modal = document.querySelector(".modal-card") as HTMLElement; // ω99-301 re-shell: .modal retired for the family class
    expect(document.activeElement).toBe(modal);
    replace(<div />);
    expect(document.activeElement).toBe(trigger);
  });

  it("ResumePicker: pick/cancel returns focus to the composer the /resume came from", () => {
    const trigger = focusedTrigger();
    mount(<ResumePicker rows={[{ id: "wudao-a", mtime: new Date().toISOString(), messages: 2, firstUser: "hi", model: "deepseek-chat" }]} onPick={() => {}} onCancel={() => {}} />);
    const dialog = document.querySelector(".modal-card") as HTMLElement;
    expect(document.activeElement).toBe(dialog);
    replace(<div />);
    expect(document.activeElement).toBe(trigger);
  });

  it("AskUserCards free-text: answering returns focus to the trigger (the autoFocus commit-steal is gone)", () => {
    const trigger = focusedTrigger();
    const onAnswer = vi.fn();
    mount(<AskUserCards question="Name?" onAnswer={onAnswer} onDismiss={() => {}} />);
    const input = document.querySelector("input.wudao-input") as HTMLInputElement;
    expect(document.activeElement).toBe(input); // the steal lives in an effect AFTER the capture
    replace(<div />); // the parent drops the dialog once answered
    expect(document.activeElement).toBe(trigger);
  });

  // ω99-305 (弹层 Esc 可达性): the options mode has no input to steal into —
  // the CARD itself takes focus, the family idiom. Without it focus stays on
  // the trigger under the scrim and the card's Esc / 1-9 hotkeys (element-
  // level handlers inside the card) never fire.
  it("ω99-305 AskUserCards options mode: the CARD takes focus (Esc + 1-9 stay live)", () => {
    mount(
      <AskUserCards
        question="Pick one"
        options={[{ label: "A" }, { label: "B" }]}
        onAnswer={() => {}}
        onDismiss={() => {}}
      />,
    );
    const card = container?.querySelector(".modal-card") ?? null;
    expect(card).not.toBeNull();
    expect(document.activeElement).toBe(card);
  });

  it("PlanReview: the 改 input's close refocuses the 改 trigger — on Escape AND on submit", async () => {
    const onSubmit = vi.fn();
    mount(<PlanReview plan={"1. do"} busy={false} onSubmit={onSubmit} />);
    const reviseBtn = (): HTMLButtonElement => document.querySelector(".planboard .btnrow button.wudao:not(.primary)") as HTMLButtonElement;
    act(() => {
      reviseBtn().click();
    });
    const input = document.querySelector(".planboard input.wudao-input") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    // Escape closes the box — the keys land back on the trigger.
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(reviseBtn());
    // Reopen, then Enter submits — focus returns to the trigger again.
    act(() => {
      reviseBtn().click();
    });
    const input2 = document.querySelector(".planboard input.wudao-input") as HTMLInputElement;
    expect(document.activeElement).toBe(input2);
    await act(async () => {
      input2.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(onSubmit).toHaveBeenCalledWith("改");
    expect(document.activeElement).toBe(reviseBtn());
  });
});

describe("UI-5 INFO-2 — App-driven pins", () => {
  interface Harness {
    container: HTMLElement;
    server: ReturnType<typeof fakeServer>;
  }
  function mountedApp(): Harness {
    const server = fakeServer();
    const client = new WudaoClient({
      url: "ws://127.0.0.1:1",
      token: "t",
      wsFactory: () => server.spawn(),
      reconnect: false,
    });
    const container = mount(<App client={client} />);
    act(() => {
      client.connect();
      server.socket.serverOpen();
    });
    return { container, server: server };
  }
  function sendState(h: Harness, overrides: Record<string, unknown>): void {
    h.server.socket.serverSend({
      t: "state",
      state: {
        live: { reasoning: "", answer: "", busyTools: [] },
        busy: false,
        queued: [],
        boardProgress: null,
        ctxTokens: null,
        mode: "workspace",
        cachePercent: null,
        bg: { active: 0, spawned: 0 },
        pendingPermission: null,
        planBoard: null,
        sessionId: "wudao-test-0001",
        sidecar: null,
        ...overrides,
      },
    });
  }

  it("NewChatConfirm (the 简洁面's only new-chat entry): Esc closes and focus returns to the + trigger", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    const plus = h.container.querySelector<HTMLButtonElement>(".topbar .new-chat");
    expect(plus).not.toBeNull();
    act(() => {
      plus?.focus();
    });
    act(() => {
      plus?.click();
    });
    const modal = h.container.querySelector(".modal-card") as HTMLElement; // ω99-301 re-shell: .modal retired for the family class
    expect(document.activeElement).toBe(modal); // the dialog owns focus on open
    await act(async () => {
      modal.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(h.container.querySelector(".modal-card")).toBeNull(); // ω99-301 re-shell: .modal retired for the family class
    expect(document.activeElement).toBe(plus); // back on the trigger, not <body>
  });

  it("SimpleApprovalCard RELEASE contract: when the ask clears, focus lands on the remounted composer (pinned, not coincidental)", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    // Boot straight into 简洁模式 (the persisted preference)…
    const op = h.server.clientFrames().find((f): f is { id: number; op: { op: string } } =>
      typeof f === "object" && f !== null && "op" in f && (f as { op: { op: string } }).op.op === "settingsStatus");
    await act(async () => {
      h.server.socket.serverSend({ t: "result", id: op?.id, ok: { settings: { memoryEnabled: true, uiDefaultMode: "simple" } } });
    });
    const textarea = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    act(() => {
      textarea.focus();
    });
    await act(async () => {
      sendState(h, {
        busy: true,
        pendingPermission: { toolName: "shell", summary: "跑测试", input: { command: "npm t" } },
      });
    });
    const card = h.container.querySelector(".approval") as HTMLElement;
    expect(document.activeElement).toBe(card); // the takeover owns focus (UI-3 C2)
    await act(async () => {
      sendState(h, { busy: false, pendingPermission: null });
    });
    // The pinned contract: the composer remounted and InputBox's mount focus
    // took the keys — break either half and this assertion fails.
    const fresh = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    expect(fresh).not.toBeNull();
    expect(document.activeElement).toBe(fresh);
    expect(document.activeElement).not.toBe(document.body);
  });
});
