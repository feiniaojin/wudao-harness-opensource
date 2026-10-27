// @vitest-environment jsdom
// UI-4 — the motion batch + the timing-semantics fix:
//   C5    the .act-body expand fade-in (the body MOUNTS on open, so a mount
//         keyframe is the whole animation — the .pop-in precedent, fast tier,
//         the ONE shared fade keyframes; the inline maxHeight cap untouched)
//   C6    the Shield popup's enter animation (the declared-but-dead
//         opacity/transform transition replaced by the pop mount keyframe)
//   C8    the body's theme-switch crossfade (background-color + color)
//   C9    the slash menu's aria-activedescendant wiring (rows get ids, the
//         listbox points at the highlighted row, the pointer follows ↑/↓)
//   LOW-1 the statusline busy clock keys on the TURN: an ask hides the
//         segment (display semantics pinned in UI-3) but the seconds keep
//         accumulating — release shows the cumulative count, not a restart
//   C10   the finished tool card's durationMs tail (driver-emitted, relayed
//         verbatim; optional on the wire, never assumed)
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { stylesCss } from "./styles-source.js";
import type { DriverStatus, LiveState } from "../src/protocol.js";
import { InputBox } from "../src/components/InputBox.js";
import { StatusBar } from "../src/components/StatusBar.js";
import { SimpleActivityCard } from "../src/components/SimpleActivityCard.js";
import type { SlashCommandInfo } from "../src/slash.js";
import { mount, unmount } from "./css-test-utils.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STYLES_CSS = stylesCss;

afterEach(() => {
  unmount();
});

function type(el: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const key = (el: Element, k: string): void => {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
};

// ---------------------------------------------------------------------------
// C5 — the .act-body expand fade-in (raw-text pins: jsdom's cssstyle does
// not expand var()-carrying shorthands, the suite's standing convention for
// animation declarations).
// ---------------------------------------------------------------------------
describe("UI-4 C5 — the .act-body expand fade-in", () => {
  it("the body mounts with the shared fade keyframes on the fast tier — exactly one fade keyframes sheet-wide", () => {
    expect(STYLES_CSS).toMatch(/\.act-body\s*\{[^}]*animation:\s*fade var\(--dur-fast\) var\(--ease\);/s);
    // Reused, not duplicated: the .scrim entry's keyframes is the only one
    // (line-anchored — a section comment above mentions the name in prose).
    expect(STYLES_CSS.match(/^@keyframes fade\b/gm)?.length).toBe(1);
    // …and the reduced-motion global block collapses it (.01ms, one iteration).
    expect(STYLES_CSS).toMatch(/prefers-reduced-motion[\s\S]*?animation-duration:\s*\.01ms\s*!important/);
    expect(STYLES_CSS).toMatch(/prefers-reduced-motion[\s\S]*?animation-iteration-count:\s*1\s*!important/);
  });

  it("the animation touches NO layout — the inline maxHeight cap survives the expand gesture", async () => {
    const c = mount(
      <SimpleActivityCard entry={{ kind: "tool", name: "read_file", summary: "src/a.ts", resultPreview: "l1\nl2" }} />,
    );
    await act(async () => {
      (c.querySelector(".act .act-row") as HTMLButtonElement).click();
    });
    const body = c.querySelector(".act .act-body") as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.style.maxHeight).toBe("132px"); // the jsdom-asserted cap, byte-identical
  });
});

// ---------------------------------------------------------------------------
// C6 — the Shield popup's enter animation.
// ---------------------------------------------------------------------------
describe("UI-4 C6 — the Shield popup enters through the pop mount keyframe", () => {
  it("the mount keyframe rides pop on the fast tier; the dead transition is gone from the rule", () => {
    expect(STYLES_CSS).toMatch(/\.pop \.menu\s*\{[\s\S]*?animation:\s*pop var\(--dur-fast\) var\(--ease\);/);
    const rule = /\.pop \.menu\s*\{([^}]*)\}/.exec(STYLES_CSS)?.[1] ?? "";
    expect(rule).not.toBe("");
    expect(rule).not.toMatch(/transition:/); // the never-firing enter transition is retired
    expect(rule).toMatch(/animation:/);
  });
});

// ---------------------------------------------------------------------------
// C8 — the body's theme-switch crossfade.
// ---------------------------------------------------------------------------
describe("UI-4 C8 — the body crossfades its own colors on a theme switch", () => {
  it("the transition rides background-color + color on the fast tier (mockup v2:39)", () => {
    expect(STYLES_CSS).toMatch(
      /body\s*\{[^}]*transition:\s*background-color var\(--dur-fast\) var\(--ease\),\s*color var\(--dur-fast\) var\(--ease\);/s,
    );
  });
});

// ---------------------------------------------------------------------------
// C9 — the slash menu's aria-activedescendant contract.
// ---------------------------------------------------------------------------
describe("UI-4 C9 — slash menu aria-activedescendant", () => {
  const CMDS: readonly SlashCommandInfo[] = [
    { name: "help", description: "列出命令", source: "builtin" },
    { name: "model", description: "切换模型", source: "builtin" },
    { name: "theme", description: "切换主题", source: "builtin" },
  ];
  const INPUT_PROPS = {
    busy: false,
    mode: "workspace" as const,
    commands: CMDS,
    connected: true,
    onSubmit: vi.fn(),
    onInterrupt: vi.fn(),
    onCycleMode: vi.fn(),
    onShield: vi.fn(),
  };

  it("rows carry ids; the listbox's aria-activedescendant is the highlighted row's id, and the pointer follows ↑/↓", async () => {
    const c = mount(<InputBox {...INPUT_PROPS} />);
    const input = c.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(input, "/"); // the bare slash token opens the full list
    });
    const menu = c.querySelector(".slashmenu") as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.getAttribute("role")).toBe("listbox");

    const rows = [...menu.querySelectorAll("[role='option']")] as HTMLElement[];
    expect(rows.length).toBe(3);
    for (const r of rows) expect(r.id).not.toBe("");

    const activeIsSelectedRow = (): void => {
      const sel = menu.querySelector("[aria-selected='true']") as HTMLElement | null;
      expect(sel).not.toBeNull();
      expect(menu.getAttribute("aria-activedescendant")).toBe(sel!.id);
    };
    activeIsSelectedRow(); // the initial highlight (row 0)

    await act(async () => {
      key(input, "ArrowDown");
    });
    activeIsSelectedRow();
    expect((menu.querySelector("[aria-selected='true']") as HTMLElement).textContent).toContain("/model");

    await act(async () => {
      key(input, "ArrowDown");
    });
    activeIsSelectedRow();
    expect((menu.querySelector("[aria-selected='true']") as HTMLElement).textContent).toContain("/theme");
  });
});

// ---------------------------------------------------------------------------
// LOW-1 — the busy clock's whole-turn accumulation. css-test-utils' mount is
// single-render, so this test drives its own root through the three states
// (busy → asked → released) — the SAME component instance, which is the
// point: the clock must survive the ask without restarting.
// ---------------------------------------------------------------------------
describe("UI-4 LOW-1 — the statusline busy clock accumulates across an ask", () => {
  const live = (over: Partial<LiveState>): LiveState => ({ reasoning: "", answer: "", busyTools: [], ...over });
  const status = (over: Partial<DriverStatus>): DriverStatus => ({
    live: live({}),
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

  it("an ask HIDES the segment (UI-3 display semantics, unchanged) but the seconds keep counting — release shows the cumulative count", async () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderStatus = (over: Partial<DriverStatus>): void => {
      act(() => {
        root.render(<StatusBar status={status(over)} />);
      });
    };
    const segText = (): string => (container.querySelector(".seg-busy") as HTMLElement)?.textContent ?? "";
    try {
      renderStatus({ busy: true, live: live({ reasoning: "想" }) });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(segText()).toBe("▌思考中 · 2s");

      // The ask takes over: hidden — the turn waits on the user (pinned in
      // UI-3; this fix changes the CLOCK, not the visibility).
      renderStatus({
        busy: true,
        live: live({ reasoning: "想" }),
        pendingPermission: { toolName: "shell", summary: "pnpm test", input: {} },
      });
      expect(container.querySelector(".seg-busy")).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(container.querySelector(".seg-busy")).toBeNull(); // still hidden through the whole ask

      // Released: the segment returns with the WHOLE turn's count — the ask
      // was part of the turn, not a reset (>5s proves it never restarted).
      renderStatus({ busy: true, live: live({ reasoning: "想" }) });
      expect(segText()).toBe("▌思考中 · 7s");
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
      vi.useRealTimers();
    }
  });

  it("the turn's END still tears the clock down (idle after a turn starts the next turn at zero)", async () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderStatus = (over: Partial<DriverStatus>): void => {
      act(() => {
        root.render(<StatusBar status={status(over)} />);
      });
    };
    try {
      renderStatus({ busy: true, live: live({ answer: "a" }) });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect((container.querySelector(".seg-busy") as HTMLElement)?.textContent).toBe("▌回复中 · 3s");
      renderStatus({ busy: false }); // the turn ends
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });
      expect(container.querySelector(".seg-busy")).toBeNull();
      renderStatus({ busy: true, live: live({ answer: "b" }) }); // a NEW turn
      expect(container.querySelector(".seg-busy")).toBeNull(); // the 1s throttle: nothing at t=0
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect((container.querySelector(".seg-busy") as HTMLElement)?.textContent).toBe("▌回复中 · 1s");
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// C10 — the finished tool card's duration tail.
// ---------------------------------------------------------------------------
describe("UI-4 C10 — the tool card's durationMs tail", () => {
  it("a finished call's duration rides the collapsed tail; sub-0.1s reads honestly; absent keeps it empty; err keeps the error head", () => {
    const withDur = mount(
      <SimpleActivityCard
        entry={{ kind: "tool", name: "shell", summary: "pnpm test", resultPreview: "ok", durationMs: 1234 }}
      />,
    );
    expect(withDur.querySelector(".act-tail")?.textContent).toBe("· 1.2s");

    const fast = mount(
      <SimpleActivityCard
        entry={{ kind: "tool", name: "grep", summary: "token", resultPreview: "a.ts:1", durationMs: 45 }}
      />,
    );
    expect(fast.querySelector(".act-tail")?.textContent).toBe("· <0.1s");

    const none = mount(
      <SimpleActivityCard entry={{ kind: "tool", name: "read_file", summary: "src/a.ts", resultPreview: "l1" }} />,
    );
    expect(none.querySelector(".act-tail")?.textContent).toBe(""); // old server / pre-I21 history: no tail, exactly as before

    // Red discipline: the errored card's tail IS the error's first line —
    // a duration would dilute the failure summary.
    const err = mount(
      <SimpleActivityCard
        entry={{
          kind: "tool",
          name: "shell",
          summary: "pnpm build",
          resultPreview: "ELIFECYCLE Command failed\nsecond line",
          isError: true,
          durationMs: 9000,
        }}
      />,
    );
    expect(err.querySelector(".act-tail")?.textContent).toBe("ELIFECYCLE Command failed … · 点击查看");
  });
});
