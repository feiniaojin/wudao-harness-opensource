// @vitest-environment jsdom
// M75-ux3 §10 — the topbar's + new-chat button: renders between the empty
// drag space and the ◐/⚙ pair, opens a 确认/取消 confirm (「清空当前对话？
// 未保存的工作保留在磁盘」), and the confirmed path rides the EXISTING
// client.submit wire with "/clear" — the typed /clear's frontend clearView
// flow stays untouched; the button is the palettized entry.
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
const click = (el: Element | null | undefined): void => {
  act(() => {
    el?.dispatchEvent(new Event("click", { bubbles: true }));
  });
};

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  window.localStorage.removeItem("wudao.ui.v1"); // ui-review-r3 P2: reset the persisted layout between tests
});

interface Entry {
  name: string;
  type: "file" | "dir";
  size?: number;
  hidden?: boolean;
}

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

type OpFrame = { id: number; op: { op: string; path?: string; text?: string } };

const opFrames = (h: Harness): OpFrame[] =>
  h.server
    .clientFrames()
    .filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f && "id" in f);

async function drain(h: Harness, listing: Record<string, readonly Entry[]>): Promise<void> {
  await act(async () => {
    for (const f of opFrames(h)) {
      if (h.answered.has(f.id)) continue;
      h.answered.add(f.id);
      if (f.op.op === "fileTree") {
        h.server.socket.serverSend({ t: "result", id: f.id, ok: { entries: listing[f.op.path ?? ""] ?? [] } });
      } else if (f.op.op === "settingsStatus") {
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
}

async function connectedApp(listing: Record<string, readonly Entry[]>): Promise<Harness> {
  const h = mountedApp();
  await act(async () => {
    authOk(h.server.socket);
  });
  await drain(h, listing);
  await drain(h, {});
  return h;
}

describe("new-chat button (M75-ux3 §10)", () => {
  it("renders + between the drag space and the ◐/⚙ pair; opens the confirm; 取消/Esc close without a submit; 确认 submits /clear", async () => {
    const h = await connectedApp({ "": [{ name: "a.ts", type: "file" }] });
    const plus = h.container.querySelector<HTMLButtonElement>(".topbar .new-chat");
    expect(plus).not.toBeNull();
    // ui-review-r2 P5: the glyph is IconPlus (SVG currentColor) — the old
    // bare "+" text is gone; aria-label still carries the name.
    expect(plus?.querySelector("svg")).not.toBeNull();
    expect(plus?.getAttribute("aria-label")).toBe("新对话");
    // §10 placement: after the empty drag space (.sp), before the picker /
    // theme / settings trio (ui-review-r1 P3: SVG glyphs, so the slots are
    // named by aria-label, not by emoji equality). 2026-08-26 §3.3: the
    // advanced-only 审查专注 affordance sits between the picker and the
    // theme/settings pair.
    const topbar = [...h.container.querySelectorAll(".topbar > *")];
    expect(topbar.indexOf(plus!)).toBe(1); // [sp, +, sessions, review-focus, theme, settings]
    expect(topbar[0]?.classList.contains("sp")).toBe(true);
    expect(topbar[2]?.getAttribute("aria-label")).toBe("会话列表");
    expect(topbar[3]?.getAttribute("aria-label")).toBe("审查专注");
    expect(topbar[3]?.getAttribute("aria-pressed")).toBe("false");
    expect(topbar[4]?.getAttribute("aria-label")).toBe("切换主题");
    expect(topbar[5]?.getAttribute("aria-label")).toBe("设置");

    // The confirm dialog — the round's wording + 确认/取消.
    click(plus);
    const modal = h.container.querySelector(".modal-card");
    expect(modal?.textContent).toContain("清空当前对话");
    expect(modal?.textContent).toContain("未保存的工作保留在磁盘");
    const confirmBtn = modal?.querySelector<HTMLButtonElement>(".wudao.danger");
    const cancelBtn = modal?.querySelector<HTMLButtonElement>(".btnrow .wudao:not(.danger)");
    expect(confirmBtn?.textContent).toContain("确认");
    expect(cancelBtn?.textContent).toContain("取消");

    // 取消 — closes, nothing on the wire.
    click(cancelBtn);
    expect(h.container.querySelector(".modal-card")).toBeNull();
    expect(opFrames(h).filter((f) => f.op.op === "submit")).toHaveLength(0);

    // Esc — the same cancel path (single-shot: no double resolution).
    click(plus);
    act(() => {
      h.container
        .querySelector(".modal-card")
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(h.container.querySelector(".modal-card")).toBeNull();
    expect(opFrames(h).filter((f) => f.op.op === "submit")).toHaveLength(0);

    // 确认 — /clear rides the existing client.submit path.
    click(plus);
    click(h.container.querySelector(".modal-card .wudao.danger"));
    expect(h.container.querySelector(".modal-card")).toBeNull();
    const submits = opFrames(h).filter((f) => f.op.op === "submit");
    expect(submits).toHaveLength(1);
    expect(submits[0]?.op.text).toBe("/clear");
  });

  // ui-review-r1 I7: the sibling confirms must agree on Enter — the SAFE
  // path. The dialog keeps focus (no button autofocus at all), and the
  // modal's Enter resolves to CANCEL (ClearConfirm's own idiom); the
  // destructive button needs an explicit click or Tab+Enter.
  it("a bare Enter on the open confirm does NOT clear — Enter resolves to cancel", async () => {
    const h = await connectedApp({ "": [{ name: "a.ts", type: "file" }] });
    click(h.container.querySelector(".topbar .new-chat"));
    const modal = h.container.querySelector(".modal-card") as HTMLElement;
    expect(document.activeElement).toBe(modal); // the dialog owns focus, no button autofocus
    act(() => {
      modal.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(h.container.querySelector(".modal-card")).toBeNull(); // closed via cancel
    expect(opFrames(h).filter((f) => f.op.op === "submit")).toHaveLength(0); // nothing cleared
  });
});
