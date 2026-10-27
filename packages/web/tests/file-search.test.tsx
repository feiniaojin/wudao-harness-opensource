// @vitest-environment jsdom
// M75-ux3 §6 — the Ctrl+P file-search palette. Two halves: the palette
// COMPONENT (subsequence fuzzy match over the paths the tree has loaded,
// ↑/↓/Enter/Esc keyboard contract, matched-character highlight, the §6
// pinned geometry — fixed scrim, 400px pop at the top fifth) and the APP
// wiring (Ctrl+P opens it over the loaded tree; v1 is frontend-only by
// design, so an UNEXPANDED dir's files are simply not in the index until
// the tree loads them; Enter opens the file through the selection seam and
// closes). The §13 chord subset lands here too: Ctrl+B (left panel),
// Cmd+, (settings), Ctrl+\ (the center-collapse seam Task 2 wires at
// merge — registered, never throws).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App, FileSearch } from "../src/components/App.js";
import { WudaoClient } from "../src/protocol.js";
import { authOk, fakeServer } from "./mock-ws.js";
import type { FakeServer } from "./mock-ws.js";
import { decl } from "./css-test-utils.js";
import "../src/styles.css";

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
const flush = async (): Promise<void> => {
  await act(async () => {});
};
const click = (el: Element | null | undefined): void => {
  act(() => {
    el?.dispatchEvent(new Event("click", { bubbles: true }));
  });
};
/** Type into a controlled input the way a real browser does. */
function type(el: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
/** A keydown on an ELEMENT (the palette's own keyboard contract). */
const key = (el: Element | null | undefined, k: string): void => {
  act(() => {
    el?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
};
/** A GLOBAL chord — the App's window-level listener. */
const press = (k: string, mods: { ctrlKey?: boolean; metaKey?: boolean } = {}): void => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }));
  });
};

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  window.localStorage.removeItem("wudao.ui.v1"); // ui-review-r3 P2: reset the persisted layout between tests
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
});

// --- the App-level harness (the ide-layout suite's, trimmed to the ops
// this suite needs: fileTree/fileRead from the table, settingsStatus with
// the shell preference, everything else a bare ok). ---
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
  listing: Record<string, readonly Entry[]>;
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
  return { container, client, server, answered: new Set<number>(), listing: {} };
}

type OpFrame = { id: number; op: { op: string; path?: string; text?: string } };

const opFrames = (h: Harness): OpFrame[] =>
  h.server
    .clientFrames()
    .filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f && "id" in f);

const opCount = (h: Harness, name: string, path?: string): number =>
  opFrames(h).filter((f) => f.op.op === name && (path === undefined || f.op.path === path)).length;

async function drain(h: Harness, opts: { listing?: Record<string, readonly Entry[]> } = {}): Promise<void> {
  const listing = opts.listing ?? h.listing;
  if (opts.listing !== undefined) h.listing = opts.listing;
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
      } else if (f.op.op === "fileRead") {
        h.server.socket.serverSend({
          t: "result",
          id: f.id,
          ok: {
            content: `// ${f.op.path ?? ""}\nline2\n`,
            truncated: false,
            totalBytes: 24,
            lines: 2,
            language: "ts",
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
  await drain(h, { listing });
  await drain(h);
  return h;
}

const PATHS = ["README.md", "src/App.tsx", "src/main.ts", "docs/guide.md"];

const searchRows = (c: HTMLElement): string[] =>
  [...c.querySelectorAll(".search-item")].map((r) => r.getAttribute("data-path") ?? "");

describe("FileSearch palette component (M75-ux3 §6)", () => {
  // ui-review-r1 I1: the palette steals focus on open; closing (any path —
  // Esc, scrim, pick) must hand it BACK to the trigger, not drop it to
  // <body>.
  it("unmounting the palette returns focus to the element that opened it", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    mount(<FileSearch getAllKnownPaths={() => PATHS} onOpenPath={vi.fn()} onClose={vi.fn()} />);
    expect(document.activeElement?.classList.contains("search-input")).toBe(true); // focus stolen on open
    act(() => {
      root?.unmount();
    });
    root = null;
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("lists the known paths on open; a subsequence query filters and highlights the matched characters", () => {
    const c = mount(<FileSearch getAllKnownPaths={() => PATHS} onOpenPath={vi.fn()} onClose={vi.fn()} />);
    const input = c.querySelector<HTMLInputElement>(".search-input");
    expect(input).not.toBeNull();
    expect(searchRows(c)).toEqual(PATHS);
    // "ap" is a subsequence of src/App.tsx (A..p) but of nothing else listed.
    type(input!, "ap");
    expect(searchRows(c)).toEqual(["src/App.tsx"]);
    const hits = [...c.querySelectorAll(".search-item .hit")].map((s) => s.textContent ?? "");
    expect(hits.join("")).toBe("Ap"); // the original casing, chars 4-5 highlighted
    // Clearing the query restores the full list.
    type(input!, "");
    expect(searchRows(c)).toEqual(PATHS);
  });

  it("夜移 019: smart-case — an uppercase query matches case-sensitively", () => {
    const c = mount(<FileSearch getAllKnownPaths={() => PATHS} onOpenPath={vi.fn()} onClose={vi.fn()} />);
    const input = c.querySelector<HTMLInputElement>(".search-input")!;
    // Lowercase "sm" is case-insensitive → both subsequence hits show,
    // ranked with src/main.ts (the tighter match) first.
    type(input, "sm");
    expect(searchRows(c)).toEqual(["src/main.ts", "docs/guide.md"]);
    // Uppercase "SM" flips to case-sensitive → src/main.ts has no uppercase
    // S, so nothing matches (the old always-lowercased matcher matched it).
    type(input, "SM");
    expect(searchRows(c)).toEqual([]);
    // ...and a real hump still matches: "README.md" has R then E uppercase.
    type(input, "RE");
    expect(searchRows(c)).toEqual(["README.md"]);
  });

  it("↑/↓ move the selection; Enter opens the selected path; clicking a row opens it too", () => {
    const onOpenPath = vi.fn();
    const c = mount(<FileSearch getAllKnownPaths={() => PATHS} onOpenPath={onOpenPath} onClose={vi.fn()} />);
    const input = c.querySelector<HTMLInputElement>(".search-input")!;
    const sel = () => c.querySelector(".search-item.sel")?.getAttribute("data-path");
    expect(sel()).toBe("README.md");
    key(input, "ArrowDown");
    expect(sel()).toBe("src/App.tsx");
    key(input, "ArrowDown");
    key(input, "ArrowDown"); // past the end — clamped
    expect(sel()).toBe("docs/guide.md");
    key(input, "ArrowUp");
    expect(sel()).toBe("src/main.ts");
    key(input, "ArrowUp");
    key(input, "ArrowUp");
    key(input, "ArrowUp"); // past the top — clamped
    expect(sel()).toBe("README.md");
    // Enter opens exactly the selected row.
    key(input, "ArrowDown");
    key(input, "Enter");
    expect(onOpenPath).toHaveBeenCalledTimes(1);
    expect(onOpenPath).toHaveBeenCalledWith("src/App.tsx");
    // A row click opens that row directly.
    click(c.querySelector('.search-item[data-path="docs/guide.md"]'));
    expect(onOpenPath).toHaveBeenCalledTimes(2);
    expect(onOpenPath).toHaveBeenLastCalledWith("docs/guide.md");
  });

  it("Esc closes through onClose; a non-matching query shows the empty row; a scrim click closes", () => {
    const onClose = vi.fn();
    const c = mount(<FileSearch getAllKnownPaths={() => PATHS} onOpenPath={vi.fn()} onClose={onClose} />);
    const input = c.querySelector<HTMLInputElement>(".search-input")!;
    type(input, "zzz");
    expect(c.querySelector(".search-empty")).not.toBeNull();
    expect(searchRows(c)).toEqual([]);
    key(input, "Enter"); // nothing selected — a no-op, never an undefined open
    expect(onClose).not.toHaveBeenCalled();
    key(input, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    click(c.querySelector(".search-scrim"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("pins the §6 geometry: a fixed scrim with the pop at the top fifth, 400px wide", () => {
    mount(<FileSearch getAllKnownPaths={() => PATHS} onOpenPath={vi.fn()} onClose={vi.fn()} />);
    expect(decl(".search-scrim", "position")).toBe("fixed");
    expect(decl(".search-scrim", "padding-top")).toBe("20vh");
    expect(decl(".search-pop", "width")).toBe("400px");
  });

  // UI-5 C9 姊妹 — the listbox points aria-activedescendant at the
  // highlighted row (the input keeps DOM focus; SRs announce the ↑/↓ moves).
  it("rows carry ids; the listbox's aria-activedescendant is the highlighted row's id, and the pointer follows ↑/↓", () => {
    const c = mount(<FileSearch getAllKnownPaths={() => PATHS} onOpenPath={vi.fn()} onClose={vi.fn()} />);
    const input = c.querySelector<HTMLInputElement>(".search-input")!;
    const listbox = c.querySelector(".search-results") as HTMLElement;
    expect(listbox.getAttribute("role")).toBe("listbox");
    const rows = [...c.querySelectorAll(".search-item")] as HTMLElement[];
    expect(rows.length).toBe(PATHS.length);
    for (const r of rows) expect(r.id).not.toBe("");

    const activeIsSelectedRow = (): void => {
      const selRow = listbox.querySelector("[aria-selected='true']") as HTMLElement | null;
      expect(selRow).not.toBeNull();
      expect(listbox.getAttribute("aria-activedescendant")).toBe(selRow!.id);
    };
    activeIsSelectedRow(); // the initial highlight (row 0)
    key(input, "ArrowDown");
    activeIsSelectedRow();
    expect((listbox.querySelector("[aria-selected='true']") as HTMLElement).getAttribute("data-path")).toBe("src/App.tsx");
    key(input, "ArrowDown");
    activeIsSelectedRow();
    expect((listbox.querySelector("[aria-selected='true']") as HTMLElement).getAttribute("data-path")).toBe("src/main.ts");

    // The empty result set clears the pointer (nothing to point at).
    type(input, "zzz");
    expect(listbox.getAttribute("aria-activedescendant")).toBeNull();
  });
});

describe("Ctrl+P over the loaded tree (M75-ux3 §6)", () => {
  it("Ctrl+P opens the palette; only LOADED paths are searchable; Enter opens the file and closes the palette", async () => {
    const h = await connectedApp({
      "": [
        { name: "src", type: "dir" },
        { name: "README.md", type: "file", size: 4 },
      ],
      src: [{ name: "App.tsx", type: "file", size: 5 }],
    });
    expect(h.container.querySelector(".search-pop")).toBeNull();
    press("p", { ctrlKey: true });
    expect(h.container.querySelector(".search-pop")).not.toBeNull();
    const input = h.container.querySelector<HTMLInputElement>(".search-input")!;
    // v1 is frontend-only: src is still UNEXPANDED, so App.tsx is not in
    // the index — the palette answers 无匹配, and not one search op exists.
    type(input, "app");
    expect(h.container.querySelector(".search-empty")).not.toBeNull();
    expect(opCount(h, "fileTree")).toBe(1); // only the tree's root fetch ever happened
    key(input, "Escape");
    expect(h.container.querySelector(".search-pop")).toBeNull();

    // Expand src in the tree — the index follows the loaded listings.
    click(h.container.querySelector('.tree-node[data-path="src"] > .ft-row'));
    await drain(h);
    press("p", { ctrlKey: true });
    type(h.container.querySelector<HTMLInputElement>(".search-input")!, "apptx"); // subsequence of src/App.tsx
    expect(searchRows(h.container)).toEqual(["src/App.tsx"]);
    key(h.container.querySelector<HTMLInputElement>(".search-input")!, "Enter");
    expect(h.container.querySelector(".search-pop")).toBeNull(); // opened → closed
    await drain(h); // the selection's fileRead reply lands
    expect(h.container.querySelector(".fileviewer .fv-head .fv-file")?.textContent).toBe("src/App.tsx");
    expect(h.container.querySelector(".ft-row.on")?.closest(".tree-node")?.getAttribute("data-path")).toBe("src/App.tsx");
  });
});

describe("global chords (M75-ux3 §13 subset)", () => {
  it("Ctrl+B toggles the left panel; Ctrl+\\ is a safe seam (Task 2 wires the center collapse at merge); Cmd+, opens settings", async () => {
    const h = await connectedApp({ "": [{ name: "a.ts", type: "file" }] });
    const ide = h.container.querySelector<HTMLElement>(".ide");
    expect(ide?.style.getPropertyValue("--tree-w")).toBe("220px");
    press("b", { ctrlKey: true });
    expect(ide?.style.getPropertyValue("--tree-w")).toBe("0px");
    press("b", { ctrlKey: true });
    expect(ide?.style.getPropertyValue("--tree-w")).toBe("220px");
    // The center chord: registered against the no-op seam — the shell is
    // untouched and nothing throws until Task 2's state lands.
    press("\\", { ctrlKey: true });
    expect(h.container.querySelector(".ide")).not.toBeNull();
    expect(ide?.style.getPropertyValue("--tree-w")).toBe("220px");
    // Cmd+, opens the settings page.
    press(",", { metaKey: true });
    expect(h.container.querySelector(".settings-page")).not.toBeNull();
  });
});
