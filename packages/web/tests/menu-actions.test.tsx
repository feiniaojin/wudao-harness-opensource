// @vitest-environment jsdom
// M76-ux2 §7 — the menu-bar plumbing: the web side listens for the
// "wudao:menu-action" DOM event (the Rust-side tauri::menu emits Tauri
// events; the bridge dispatches this DOM CustomEvent) and routes the four
// round-2 actions — new-chat, settings, toggle-left, toggle-theme — onto
// the EXISTING seams (the + confirm, the ⚙ page, the Ctrl+B collapse, the
// ◐ toggle). The native menu itself is Rust-side (tauri::menu — the conf
// only flips macOSPrivateApi), so this is the testable half of §7.
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/components/App.js";
import { WudaoClient } from "../src/protocol.js";
import { authOk, fakeServer } from "./mock-ws.js";
import type { FakeServer } from "./mock-ws.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
const menuAction = (action: string): void => {
  act(() => {
    window.dispatchEvent(new CustomEvent("wudao:menu-action", { detail: action }));
  });
};

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  window.localStorage.removeItem("wudao.ui.v1"); // ui-review-r3 P2: reset the persisted layout between tests
  document.documentElement.dataset.theme = "dark";
  window.localStorage.clear();
});

interface Harness {
  container: HTMLElement;
  client: WudaoClient;
  server: FakeServer;
  answered: Set<number>;
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
  return { container, client, server, answered: new Set<number>() };
}

type OpFrame = { id: number; op: Record<string, unknown> };

const opFrames = (h: Harness): OpFrame[] =>
  h.server
    .clientFrames()
    .filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f && "id" in f);

async function connectedApp(): Promise<Harness> {
  const h = mountedApp();
  await act(async () => {
    authOk(h.server.socket);
  });
  await act(async () => {
    for (const f of opFrames(h)) {
      if (h.answered.has(f.id)) continue;
      h.answered.add(f.id);
      if (f.op.op === "settingsStatus") {
        h.server.socket.serverSend({
          t: "result",
          id: f.id,
          ok: {
            providers: [],
            credentials: { path: "/root/.wudao/credentials.json", keyCount: 0 },
            settings: {
              memoryEnabled: false,
              uiDefaultMode: null,
              wizardCompletedVersion: 1,
              uiTheme: null,
              uiAccent: null,
            },
            current: { provider: "deepseek", model: "deepseek-chat" },
            envKey: false,
            readiness: false,
            efforts: [],
          },
        });
      } else {
        h.server.socket.serverSend({ t: "result", id: f.id, ok: [] });
      }
    }
  });
  await act(async () => {});
  return h;
}

describe("menu-bar actions (M76-ux2 §7)", () => {
  it("new-chat → the + button's confirm; settings → the settings page", async () => {
    const h = await connectedApp();
    expect(h.container.querySelector(".modal-card")).toBeNull();
    menuAction("new-chat");
    expect(h.container.querySelector(".modal-card")?.textContent).toContain("清空当前对话");
    // Dismiss it, then open settings through the menu seam.
    act(() => {
      h.container
        .querySelector(".modal-card")
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(h.container.querySelector(".settings-page")).toBeNull();
    menuAction("settings");
    expect(h.container.querySelector(".settings-page")).not.toBeNull();
  });

  it("toggle-left collapses and re-expands the left panel (the Ctrl+B seam)", async () => {
    const h = await connectedApp();
    const ide = h.container.querySelector<HTMLElement>(".ide");
    expect(ide).not.toBeNull();
    expect(ide?.style.getPropertyValue("--tree-w")).toBe("220px");
    menuAction("toggle-left");
    expect(ide?.style.getPropertyValue("--tree-w")).toBe("0px");
    menuAction("toggle-left");
    expect(ide?.style.getPropertyValue("--tree-w")).toBe("220px");
  });

  it("toggle-theme rides the ◐ toggle (optimistic flip + ui.theme persist)", async () => {
    const h = await connectedApp();
    expect(document.documentElement.dataset.theme).toBe("dark");
    menuAction("toggle-theme");
    expect(document.documentElement.dataset.theme).toBe("light");
    const sets = opFrames(h).filter((f) => f.op.op === "settingsSet");
    expect(sets).toHaveLength(1);
    expect(sets[0]?.op.key).toBe("ui.theme");
    expect(sets[0]?.op.value).toBe("light");
  });

  it("an unknown action is a no-op (forward compat — the menu grows Rust-side)", async () => {
    const h = await connectedApp();
    menuAction("about");
    expect(h.container.querySelector(".modal-card")).toBeNull();
    expect(h.container.querySelector(".settings-page")).toBeNull();
    expect(h.container.querySelector<HTMLElement>(".ide")?.style.getPropertyValue("--tree-w")).toBe("220px");
  });
});
