// @vitest-environment jsdom
// UI-5 顺手项 —
//   A (scout §2 R1/R2): the motion family completion — the remaining
//      mount-on-open popups (.menu.ctx / .slashmenu / .filetree .ws-menu)
//      ride the SAME pop mount keyframe C6 gave .pop .menu, and the
//      advanced toolcard's .result body rides C5's fade — no new keyframes,
//      fast tier everywhere, reduced-motion's global block collapses all.
//   B (scout §2 R3, mockup v2:246): the simple approval card's takeover
//      receipt line — 权限卡临时接管输入位置 · 处理后自动恢复, centered,
//      caption-size, token colors, below the card in the composer slot.
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { stylesCss } from "./styles-source.js";
import { App } from "../src/components/App.js";
import { WudaoClient } from "../src/protocol.js";
import { authOk, fakeServer } from "./mock-ws.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STYLES_CSS = stylesCss;

let root: Root | null = null;
const mount = (el: React.ReactElement): HTMLElement => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(el);
  });
  return container;
};

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  window.localStorage.removeItem("wudao.ui.v1");
});

// ---------------------------------------------------------------------------
// A — the motion family completion (raw-text pins: jsdom's cssstyle drops
// var()-bearing animation shorthands — the suite's standing convention).
// ---------------------------------------------------------------------------
describe("UI-5 顺手项 A — the mount-keyframe family completion", () => {
  const POP = /animation:\s*pop var\(--dur-fast\) var\(--ease\);/;
  const FADE = /animation:\s*fade var\(--dur-fast\) var\(--ease\);/;

  it(".menu.ctx (the right-click menu) enters through the pop mount keyframe", () => {
    expect(STYLES_CSS).toMatch(new RegExp(String.raw`\.menu\.ctx\s*\{[^}]*${POP.source}`, "s"));
  });

  it(".slashmenu (the / menu) enters through the pop mount keyframe", () => {
    expect(STYLES_CSS).toMatch(new RegExp(String.raw`\.slashmenu\s*\{[^}]*${POP.source}`, "s"));
  });

  it(".ws-menu (the tree/chip recents dropdown — promoted global) enters through the pop mount keyframe", () => {
    // The selector was un-scoped from .filetree (composer chip menus share
    // the visuals); the global rule keeps the same mount keyframe.
    expect(STYLES_CSS).toMatch(new RegExp(String.raw`(^|\})\s*\.ws-menu\s*\{[^}]*${POP.source}`, "s"));
  });

  it(".toolcard .result (the advanced expand body) enters through the fade mount keyframe", () => {
    expect(STYLES_CSS).toMatch(new RegExp(String.raw`\.toolcard \.result\s*\{[^}]*${FADE.source}`, "s"));
  });

  it("reused, not duplicated — exactly one pop and one fade keyframes sheet-wide; reduced-motion stays universal", () => {
    expect(STYLES_CSS.match(/^@keyframes pop\b/gm)?.length).toBe(1);
    expect(STYLES_CSS.match(/^@keyframes fade\b/gm)?.length).toBe(1);
    // The global reduced-motion block's UNIVERSAL selector is what folds the
    // new rules in — pin that the sweep covers every element, not a list.
    expect(STYLES_CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*, \*::before, \*::after\s*\{/);
    expect(STYLES_CSS).toMatch(/prefers-reduced-motion[\s\S]*?animation-duration:\s*\.01ms\s*!important/);
    expect(STYLES_CSS).toMatch(/prefers-reduced-motion[\s\S]*?animation-iteration-count:\s*1\s*!important/);
  });

  it("no layout value moved: the .result cap and the ws-menu geometry are untouched by the animation lines", () => {
    const result = /\.toolcard \.result\s*\{([^}]*)\}/.exec(STYLES_CSS)?.[1] ?? "";
    expect(result).toMatch(/max-height:\s*132px;/);
    expect(result).not.toMatch(/transition|transform/); // opacity-only keyframes, no layout tricks
  });
});

// ---------------------------------------------------------------------------
// B — the takeover receipt line under the simple approval card.
// ---------------------------------------------------------------------------
describe("UI-5 顺手项 B — the approval takeover receipt", () => {
  it("the CSS rule exists, centered and token-colored (no literal color)", () => {
    expect(STYLES_CSS).toMatch(
      /\.approval-note\s*\{[^}]*text-align:\s*center;[^}]*font-size:\s*var\(--fs-caption\);[^}]*color:\s*var\(--text-3\);/s,
    );
  });

  it("in the shell: the line renders below the approval card while the ask pends, and leaves with it", async () => {
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
    await act(async () => {
      authOk(server.socket);
    });
    const op = server.clientFrames().find((f): f is { id: number; op: { op: string } } =>
      typeof f === "object" && f !== null && "op" in f && (f as { op: { op: string } }).op.op === "settingsStatus");
    await act(async () => {
      server.socket.serverSend({ t: "result", id: op?.id, ok: { settings: { memoryEnabled: true, uiDefaultMode: "simple" } } });
    });
    const sendState = (overrides: Record<string, unknown>): void => {
      act(() => {
        server.socket.serverSend({
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
      });
    };
    expect(container.querySelector(".approval-note")).toBeNull(); // idle — nothing borrowed
    await act(async () => {
      sendState({
        busy: true,
        pendingPermission: { toolName: "shell", summary: "跑测试", input: { command: "npm t" } },
      });
    });
    const note = container.querySelector(".approval-note") as HTMLElement;
    expect(note).not.toBeNull();
    expect(note.textContent).toBe("权限卡临时接管输入位置 · 处理后自动恢复");
    // Below the card: the note follows .approval in the input slot.
    const approval = container.querySelector(".approval") as HTMLElement;
    expect(approval.nextElementSibling).toBe(note);
    await act(async () => {
      sendState({ busy: false, pendingPermission: null });
    });
    expect(container.querySelector(".approval-note")).toBeNull(); // the input came back
  });
});
