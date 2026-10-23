// @vitest-environment jsdom
// R6 quickwin (hermes tips pattern) — the advanced/Buddy composer's idle
// placeholder rotates ONCE PER SESSION through short feature hints: a
// module-level cursor advanced once per App MOUNT picks the tip (a page load
// is one stable placeholder — never re-rolled per render; the composer's
// ask/modal unmount-remount cycles never re-roll it either, because the pick
// lives in App state). The simple composer's novice wording stays fixed.
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App, nextComposerTip } from "../src/components/App.js";
import { WudaoClient } from "../src/protocol.js";
import { authOk, fakeServer } from "./mock-ws.js";
import type { FakeServer } from "./mock-ws.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  window.localStorage.removeItem("wudao.ui.v1");
});

describe("nextComposerTip (the module contract)", () => {
  it("cycles the tip list in order, one advance per call", () => {
    const seen = [nextComposerTip(), nextComposerTip(), nextComposerTip(), nextComposerTip()];
    // Four DISTINCT picks over a four-tip list = a full cycle in order.
    expect(new Set(seen).size).toBe(4);
    // The cycle repeats (the counter is modulo, not random).
    expect(nextComposerTip()).toBe(seen[0]);
    expect(nextComposerTip()).toBe(seen[1]);
  });

  it("every tip is short (a placeholder, not a manual)", () => {
    // Re-roll from the current cursor for a full pass.
    for (let i = 0; i < 4; i += 1) {
      const tip = nextComposerTip();
      expect(tip.length).toBeLessThanOrEqual(20);
      expect(tip.trim()).toBe(tip);
    }
  });
});

/** Mount the App (advanced shell — uiDefaultMode null) and settle its boot
 *  ops so the composer is up. Returns the placeholder + a re-render knob. */
async function mountedComposerTip(): Promise<{ tip: () => string; rerender: () => void }> {
  const server: FakeServer = fakeServer();
  const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const el = <App client={client} />;
  act(() => {
    client.connect();
    server.socket.serverOpen();
  });
  act(() => {
    root?.render(el);
  });
  act(() => {
    authOk(server.socket);
  });
  await act(async () => {
    for (const name of ["listSlashCommands", "settingsStatus"]) {
      const frames = server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } =>
        typeof f === "object" && f !== null && "op" in (f as Record<string, unknown>),
      ) as { id: number; op: Record<string, unknown> }[];
      const op = [...frames].reverse().find((o) => o.op.op === name);
      if (op !== undefined) {
        server.socket.serverSend({
          t: "result",
          id: op.id,
          ok: name === "settingsStatus"
            ? {
              providers: [],
              credentials: { path: "/x", keyCount: 0 },
              settings: { memoryEnabled: true, uiDefaultMode: null, wizardCompletedVersion: 1, uiTheme: null, uiAccent: null },
              current: { provider: "deepseek", model: "deepseek-v4-flash" },
              envKey: false,
              readiness: true,
              efforts: [],
            }
            : [],
        });
      }
    }
  });
  const tip = (): string => {
    const ta = container.querySelector("textarea.wudao-input") as HTMLTextAreaElement | null;
    if (ta === null) throw new Error("composer textarea missing");
    return ta.placeholder;
  };
  return {
    tip,
    rerender: () => {
      act(() => {
        root?.render(el);
      });
    },
  };
}

describe("the composer placeholder rotates once per session", () => {
  it("two App mounts see different tips; one mount stays stable across re-renders", async () => {
    const first = await mountedComposerTip();
    const tip1 = first.tip();
    expect(tip1).not.toBe(""); // a rotation tip replaced the static default
    // Same mount: re-renders never re-roll the pick.
    first.rerender();
    first.rerender();
    expect(first.tip()).toBe(tip1);
    // A fresh mount (a new page load) advances the cursor — a different tip.
    act(() => {
      root?.unmount();
    });
    document.body.innerHTML = "";
    const second = await mountedComposerTip();
    expect(second.tip()).not.toBe(tip1);
  });
});
