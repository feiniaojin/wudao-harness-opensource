// @vitest-environment jsdom
// M76-ux2 §3 — the 📋 topbar session picker: renders between the + new-chat
// and the ◐/⚙ pair, opens the FileSearch-shaped overlay (same scrim/pop
// classes) over the sessions op's rows — id8 + a 50-char message preview +
// a relative time per row, capped at 20. ↑/↓ walk, Enter rides the EXISTING
// client.resume wire, Esc closes with nothing on the wire.
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/components/App.js";
import { ResumePicker } from "../src/components/ResumePicker.js";
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
/** A keydown on an ELEMENT (the picker's own keyboard contract). */
const key = (el: Element | null | undefined, k: string): void => {
  act(() => {
    el?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
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

interface SessionRowLike {
  id: string;
  mtime: string;
  messages: number;
  firstUser: string;
  model: string;
  name?: string;
}

interface Harness {
  container: HTMLElement;
  client: WudaoClient;
  server: FakeServer;
  answered: Set<number>;
  sessionRows: SessionRowLike[];
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
  return { container, client, server, answered: new Set<number>(), sessionRows: [] };
}

const opFrames = (h: Harness): { id: number; op: Record<string, unknown> }[] =>
  h.server
    .clientFrames()
    .filter((f): f is { id: number; op: Record<string, unknown> } =>
      typeof f === "object" && f !== null && "op" in f && "id" in f);

async function drain(h: Harness, listing: Record<string, readonly Entry[]>): Promise<void> {
  await act(async () => {
    for (const f of opFrames(h)) {
      if (h.answered.has(f.id)) continue;
      h.answered.add(f.id);
      if (f.op.op === "fileTree") {
        h.server.socket.serverSend({ t: "result", id: f.id, ok: { entries: listing[f.op.path as string] ?? [] } });
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
      } else if (f.op.op === "sessions") {
        h.server.socket.serverSend({ t: "result", id: f.id, ok: h.sessionRows });
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

/** The picker's preview source: the row's name ?? firstUser, 50-char cap. */
const LONG_PREVIEW = "拖".repeat(60);

function rows(): SessionRowLike[] {
  return [
    {
      id: "aaaaaaaa-1111-2222-3333-444444444444",
      mtime: new Date(Date.now() - 5 * 60_000).toISOString(), // 5 分钟前
      messages: 7,
      firstUser: LONG_PREVIEW,
      model: "deepseek-chat",
    },
    {
      id: "bbbbbbbb-1111-2222-3333-444444444444",
      mtime: new Date(Date.now() - 2 * 60 * 60_000).toISOString(), // 2 小时前
      messages: 2,
      firstUser: "",
      model: "glm",
    },
  ];
}

describe("session picker (M76-ux2 §3)", () => {
  it("renders 📋 between + and ◐; clicking fetches sessions and shows the FileSearch-shaped overlay with id8/preview/relative time", async () => {
    const h = await connectedApp({ "": [{ name: "a.ts", type: "file" }] });
    h.sessionRows = rows();
    const btn = h.container.querySelector<HTMLButtonElement>(".topbar .sessions");
    expect(btn).not.toBeNull();
    expect(btn?.querySelector("svg")).not.toBeNull(); // ui-review-r1 P3: the IconSessions glyph
    expect(btn?.getAttribute("aria-label")).toBe("会话列表");
    // §3 placement: between the + new-chat and the ◐/⚙ pair (P3: named by
    // aria-label — the glyphs are SVG now).
    const topbar = [...h.container.querySelectorAll(".topbar > *")];
    expect(topbar.map((t) => t.getAttribute("aria-label") ?? "")).toEqual(["", "新对话", "会话列表", "审查专注", "切换主题", "监控", "设置"]); // 139：+监控

    click(btn);
    await drain(h, {});
    const scrim = h.container.querySelector(".search-scrim");
    expect(scrim).not.toBeNull();
    expect(h.container.querySelector(".search-pop")?.getAttribute("aria-label")).toBe("会话列表");
    const items = [...h.container.querySelectorAll(".search-item")];
    expect(items).toHaveLength(2);
    // Row shape: readable title (name → firstUser 16 字梯 → id8 兜底) ·
    // preview (50-char cap + …) · relative time.
    expect(items[0]?.getAttribute("data-id")).toBe("aaaaaaaa-1111-2222-3333-444444444444");
    expect(items[0]?.textContent).toContain(LONG_PREVIEW.slice(0, 16)); // ω99-178: 钉随源演进——主行=可读标题（firstUser 前 16 字梯），id8 降位
    expect(items[0]?.textContent).not.toContain("aaaaaaaa");
    expect(items[0]?.textContent).toContain(LONG_PREVIEW.slice(0, 50));
    expect(items[0]?.textContent).not.toContain(LONG_PREVIEW.slice(0, 51));
    expect(items[0]?.textContent).toContain("5分钟前");
    expect(items[1]?.textContent).toContain("bbbbbbbb"); // ω99-178: 钉随源演进——第二 fixture 行 name/firstUser 双空，断的是空会话兜底 id8（三梯末位）
    expect(items[1]?.textContent).toContain("2小时前");
    // The first row starts selected.
    expect(items[0]?.classList.contains("sel")).toBe(true);
    expect(items[1]?.classList.contains("sel")).toBe(false);
  });

  it("caps the list at 20 rows", async () => {
    const h = await connectedApp({});
    h.sessionRows = Array.from({ length: 30 }, (_, i) => ({
      id: `id${String(i).padStart(4, "0")}-0000`,
      mtime: new Date().toISOString(),
      messages: 1,
      firstUser: `m${i}`,
      model: "deepseek-chat",
    }));
    click(h.container.querySelector(".topbar .sessions"));
    await drain(h, {});
    expect([...h.container.querySelectorAll(".search-item")]).toHaveLength(20);
  });

  it("↑↓ move the selection; Enter resumes the selected id through the existing wire and closes; Esc closes with no resume", async () => {
    const h = await connectedApp({});
    h.sessionRows = rows();
    click(h.container.querySelector(".topbar .sessions"));
    await drain(h, {});
    const pop = h.container.querySelector(".search-pop");

    key(pop, "ArrowDown");
    let items = [...h.container.querySelectorAll(".search-item")];
    expect(items[1]?.classList.contains("sel")).toBe(true);
    key(pop, "ArrowUp");
    items = [...h.container.querySelectorAll(".search-item")];
    expect(items[0]?.classList.contains("sel")).toBe(true);

    // Enter on the second row — resume rides the existing client.resume op.
    key(pop, "ArrowDown");
    key(pop, "Enter");
    const resumes = opFrames(h).filter((f) => f.op.op === "resume");
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.op.id).toBe("bbbbbbbb-1111-2222-3333-444444444444");
    expect(h.container.querySelector(".search-scrim")).toBeNull();

    // Esc — closes, nothing further on the wire.
    click(h.container.querySelector(".topbar .sessions"));
    await drain(h, {});
    key(h.container.querySelector(".search-pop"), "Escape");
    expect(h.container.querySelector(".search-scrim")).toBeNull();
    expect(opFrames(h).filter((f) => f.op.op === "resume")).toHaveLength(1);
  });

  // ui-review-r1 I1: the picker steals focus on open; closing returns it to
  // the 📋 trigger (jsdom's click moves no focus, so the test focuses the
  // trigger the way a real browser's click would have).
  it("closing the picker returns focus to the sessions trigger", async () => {
    const h = await connectedApp({});
    const btn = h.container.querySelector<HTMLButtonElement>(".topbar .sessions");
    btn?.focus();
    expect(document.activeElement).toBe(btn);
    click(btn);
    await drain(h, {});
    expect(h.container.querySelector(".search-pop")).not.toBeNull();
    key(h.container.querySelector(".search-pop"), "Escape");
    expect(h.container.querySelector(".search-scrim")).toBeNull();
    expect(document.activeElement).toBe(btn);
  });

  // UI-5 C9 姊妹 — the rows' aria-activedescendant wiring: the listbox
  // points at the highlighted row so SRs announce the ↑/↓ moves.
  it("rows carry ids; the listbox's aria-activedescendant is the highlighted row's id, and the pointer follows ↑/↓", async () => {
    const h = await connectedApp({});
    h.sessionRows = rows();
    click(h.container.querySelector(".topbar .sessions"));
    await drain(h, {});
    const pop = h.container.querySelector(".search-pop");
    const listbox = h.container.querySelector(".search-results") as HTMLElement;
    expect(listbox.getAttribute("role")).toBe("listbox");
    const items = [...h.container.querySelectorAll(".search-item")] as HTMLElement[];
    expect(items).toHaveLength(2);
    for (const r of items) expect(r.id).not.toBe("");

    const activeIsSelectedRow = (): void => {
      const selRow = listbox.querySelector("[aria-selected='true']") as HTMLElement | null;
      expect(selRow).not.toBeNull();
      expect(listbox.getAttribute("aria-activedescendant")).toBe(selRow!.id);
    };
    activeIsSelectedRow(); // row 0 highlighted on load
    key(pop, "ArrowDown");
    activeIsSelectedRow();
    expect((listbox.querySelector("[aria-selected='true']") as HTMLElement).getAttribute("data-id")).toBe("bbbbbbbb-1111-2222-3333-444444444444");
    key(pop, "ArrowUp");
    activeIsSelectedRow();
    expect((listbox.querySelector("[aria-selected='true']") as HTMLElement).getAttribute("data-id")).toBe("aaaaaaaa-1111-2222-3333-444444444444");
  });
});

// 墨线 T14 — the overlay family: every centered dialog re-shells onto the
// shared .scrim (fullscreen dim + fade entry) > .modal-card (surface +
// hairline + radius-lg + the .pop-in entry). ResumePicker stands in for the
// family here (settings-trial r7 moved PermissionModal out of the family —
// it renders as an inline conversation card now, pinned in its own suites);
// the resume/model/ask cards ride the same pair and are pinned in their own
// suites.
describe("modal family (墨线 T14)", () => {
  it("modal family shares .modal-card (scrim + hairline + radius-lg + pop-in)", () => {
    const c = mount(
      <ResumePicker
        rows={[{ id: "wudao-standin-01", mtime: new Date().toISOString(), messages: 2, firstUser: "hi", model: "m" }]}
        onPick={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(c.querySelector(".scrim .modal-card")).toBeTruthy();
    expect(c.querySelector(".scrim .modal-card")?.classList.contains("pop-in")).toBe(true);
  });
});
