// @vitest-environment jsdom
// M75-ux2 §3 — the center panel's tab strip. The single selectedPath state
// becomes {path,name,isDir}[] + activeTabIndex: a tree click opens a tab
// (an existing path ACTIVATES instead of duplicating; a new path pushes,
// FIFO-evicting past 10), the tab strip renders filename + × close with an
// accent underline on the active tab (a [+] placeholder when empty), the
// last close returns the centered empty viewer, the ◂ button collapses the
// center column (--mid-w 0px, grid two-panel; an absolute ▸ toggle restores
// it), and the App-level keys own the tab gestures: Ctrl+W closes, Ctrl+Tab
// / Ctrl+Shift+Tab cycle (wrapping), Ctrl+1~9 jump.
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WudaoClient } from "../src/protocol.js";
import { App } from "../src/components/App.js";
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
/** An App-level key: dispatched on window (the shortcuts' registration
 *  point), never through the composer, so the textarea's own handlers stay
 *  out of the assertion. */
const key = (k: string, opts: { shift?: boolean } = {}): void => {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, ctrlKey: true, shiftKey: opts.shift ?? false, cancelable: true, bubbles: true }),
    );
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

type OpFrame = { id: number; op: { op: string; path?: string } };

const opFrames = (h: Harness): OpFrame[] =>
  h.server
    .clientFrames()
    .filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f && "id" in f);

/** Answer every still-pending op (fileTree/fileRead from the listing table,
 *  settingsStatus advanced, the rest a bare ok). One flush per call. */
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

/** The standard connected advanced app. TWO drains: the panels mount behind
 *  the shell-preference round trip, so the tree's root op lands one act
 *  after the reply — the second drain answers it. */
async function connectedApp(listing: Record<string, readonly Entry[]>): Promise<Harness> {
  const h = mountedApp();
  await act(async () => {
    authOk(h.server.socket);
  });
  await drain(h, { listing });
  await drain(h);
  return h;
}

/** The .tabbar tab paths in strip order. */
const tabPaths = (h: Harness): string[] =>
  [...h.container.querySelectorAll(".tabbar .tab")].map((t) => t.getAttribute("data-path") ?? "");

/** The active tab's path (null when the strip is empty). */
const activePath = (h: Harness): string | null => {
  const el = h.container.querySelector(".tabbar .tab.active");
  return el === null ? null : el.getAttribute("data-path");
};

describe("App center-panel tabs (M75-ux2 §3)", () => {
  it("tree clicks open tabs; an existing path activates instead of duplicating; the strip shows the [+] placeholder when empty", async () => {
    const h = await connectedApp({
      "": [
        { name: "a.ts", type: "file" },
        { name: "b.ts", type: "file" },
      ],
    });
    // Empty strip: the [+] placeholder, no tabs, the centered empty viewer.
    expect(h.container.querySelectorAll(".tabbar .tab")).toHaveLength(0);
    expect(h.container.querySelector(".tabbar .tab-empty")?.textContent).toBe("+");
    expect(h.container.querySelector(".fileviewer .viewer-empty")).not.toBeNull();

    click(h.container.querySelector('.tree-node[data-path="a.ts"] > .ft-row'));
    await drain(h);
    expect(tabPaths(h)).toEqual(["a.ts"]);
    expect(activePath(h)).toBe("a.ts");
    expect(h.container.querySelector(".fileviewer .fv-head .fv-file")?.textContent).toBe("a.ts");

    click(h.container.querySelector('.tree-node[data-path="b.ts"] > .ft-row'));
    await drain(h);
    expect(tabPaths(h)).toEqual(["a.ts", "b.ts"]);
    expect(activePath(h)).toBe("b.ts");

    // Re-clicking the FIRST file: the existing tab activates — no duplicate.
    click(h.container.querySelector('.tree-node[data-path="a.ts"] > .ft-row'));
    await drain(h);
    expect(tabPaths(h)).toEqual(["a.ts", "b.ts"]);
    expect(activePath(h)).toBe("a.ts");
  });

  it("clicking a tab activates it (the viewer + the tree highlight follow); the × closes and activates the neighbor; the last close returns the empty viewer", async () => {
    const h = await connectedApp({
      "": [
        { name: "a.ts", type: "file" },
        { name: "b.ts", type: "file" },
      ],
    });
    click(h.container.querySelector('.tree-node[data-path="a.ts"] > .ft-row'));
    click(h.container.querySelector('.tree-node[data-path="b.ts"] > .ft-row'));
    await drain(h);
    expect(activePath(h)).toBe("b.ts");
    expect(h.container.querySelector(".ft-row.on")?.closest(".tree-node")?.getAttribute("data-path")).toBe("b.ts");

    click(h.container.querySelector('.tabbar .tab[data-path="a.ts"]')); // activate the first
    await drain(h);
    expect(activePath(h)).toBe("a.ts");
    expect(h.container.querySelector(".fileviewer .fv-head .fv-file")?.textContent).toBe("a.ts");
    expect(h.container.querySelector(".ft-row.on")?.closest(".tree-node")?.getAttribute("data-path")).toBe("a.ts");

    // Close the ACTIVE first tab → its neighbor (b.ts, now index 0) activates.
    click(h.container.querySelector('.tabbar .tab[data-path="a.ts"] .tclose'));
    await drain(h);
    expect(tabPaths(h)).toEqual(["b.ts"]);
    expect(activePath(h)).toBe("b.ts");
    expect(h.container.querySelector(".fileviewer .fv-head .fv-file")?.textContent).toBe("b.ts");

    // Close the last tab → the strip empties (+ placeholder) and the viewer
    // returns to the centered empty state.
    click(h.container.querySelector('.tabbar .tab[data-path="b.ts"] .tclose'));
    expect(tabPaths(h)).toEqual([]);
    expect(h.container.querySelector(".tabbar .tab-empty")?.textContent).toBe("+");
    expect(h.container.querySelector(".fileviewer .viewer-empty")).not.toBeNull();
  });

  // 墨线 T11 (controller 补完): the viewer head's .fv-close rides the SAME
  // close path the tabbar's × does (App's closeTab on the active index) —
  // neighbor activates, the last close returns the empty viewer. No new
  // behavior, just the onClose wiring.
  it("the viewer head's .fv-close closes the active tab (the same close path as the tabbar ×)", async () => {
    const h = await connectedApp({
      "": [
        { name: "a.ts", type: "file" },
        { name: "b.ts", type: "file" },
      ],
    });
    click(h.container.querySelector('.tree-node[data-path="a.ts"] > .ft-row'));
    click(h.container.querySelector('.tree-node[data-path="b.ts"] > .ft-row'));
    await drain(h);
    expect(activePath(h)).toBe("b.ts");

    click(h.container.querySelector(".fv-head .fv-close"));
    await drain(h);
    expect(tabPaths(h)).toEqual(["a.ts"]);
    expect(activePath(h)).toBe("a.ts"); // the neighbor activates

    click(h.container.querySelector(".fv-head .fv-close"));
    await drain(h);
    expect(tabPaths(h)).toEqual([]);
    expect(h.container.querySelector(".fileviewer .viewer-empty")).not.toBeNull();
  });

  it("a dir click opens a DIR tab (the viewer's dir listing) beside file tabs", async () => {
    const h = await connectedApp({
      "": [{ name: "src", type: "dir" }, { name: "a.ts", type: "file" }],
      src: [{ name: "App.tsx", type: "file" }],
    });
    click(h.container.querySelector('.tree-node[data-path="src"] > .ft-row'));
    await drain(h);
    expect(tabPaths(h)).toEqual(["src"]);
    expect(activePath(h)).toBe("src");
    expect(h.container.querySelector(".tabbar .tab[data-path='src'] .tname")?.textContent).toContain("src");
    expect(h.container.querySelector(".fileviewer .viewer-dir")).not.toBeNull(); // dir mode

    click(h.container.querySelector('.tree-node[data-path="a.ts"] > .ft-row'));
    await drain(h);
    expect(tabPaths(h)).toEqual(["src", "a.ts"]);
    expect(activePath(h)).toBe("a.ts");

    // Collapsing the subtree does not close the tab (§4): re-click re-activates.
    click(h.container.querySelector('.tree-node[data-path="src"] > .ft-row'));
    await drain(h);
    expect(tabPaths(h)).toEqual(["src", "a.ts"]);
    expect(activePath(h)).toBe("src");
    expect(h.container.querySelector(".fileviewer .viewer-dir")).not.toBeNull();
  });

  it("caps the strip at 10 tabs, FIFO-evicting the oldest; the new tab stays active", async () => {
    const listing: Record<string, readonly Entry[]> = {
      "": Array.from({ length: 11 }, (_, i) => ({ name: `f${String(i).padStart(2, "0")}.ts`, type: "file" as const })),
    };
    const h = await connectedApp(listing);
    for (const name of listing[""]!.map((e) => e.name)) {
      click(h.container.querySelector(`.tree-node[data-path="${name}"] > .ft-row`));
      await drain(h);
    }
    // 11 opened: f00 evicted, f01..f10 remain, f10 active.
    expect(tabPaths(h)).toEqual(listing[""]!.map((e) => e.name).slice(1));
    expect(activePath(h)).toBe("f10.ts");
    expect(h.container.querySelectorAll(".tabbar .tab")).toHaveLength(10);
    expect(h.container.querySelector(".fileviewer .fv-head .fv-file")?.textContent).toBe("f10.ts");
  });

  // ω99-153: 满员逐出护住正在看的标签 — the on-screen tab is sacred: with
  // the strip full and the OLDEST tab (index 0) active, the 11th open evicts
  // f01 — the oldest tab NOT being viewed — and f00 survives.
  it("at the cap, the eviction spares the tab being viewed (index 0 active → f01 gives way, f00 survives)", async () => {
    const listing: Record<string, readonly Entry[]> = {
      "": Array.from({ length: 11 }, (_, i) => ({ name: `f${String(i).padStart(2, "0")}.ts`, type: "file" as const })),
    };
    const h = await connectedApp(listing);
    for (const name of listing[""]!.map((e) => e.name).slice(0, 10)) {
      click(h.container.querySelector(`.tree-node[data-path="${name}"] > .ft-row`));
      await drain(h);
    }
    expect(tabPaths(h)).toHaveLength(10); // f00..f09 full, the newest (f09) active
    click(h.container.querySelector('.tabbar .tab[data-path="f00.ts"]')); // view the OLDEST tab
    await drain(h);
    expect(activePath(h)).toBe("f00.ts");
    click(h.container.querySelector('.tree-node[data-path="f10.ts"] > .ft-row')); // the 11th open
    await drain(h);
    // f01 (the oldest NOT being viewed) gave way; f00 survived; f10 took the tail.
    expect(tabPaths(h)).toEqual(["f00.ts", "f02.ts", "f03.ts", "f04.ts", "f05.ts", "f06.ts", "f07.ts", "f08.ts", "f09.ts", "f10.ts"]);
    expect(activePath(h)).toBe("f10.ts");
    expect(h.container.querySelectorAll(".tabbar .tab")).toHaveLength(10);
  });

  // ω99-153: 逐出实名提示 — an eviction is never silent: the .notice-bub
  // lane (the one the rename guidance rides) names which tab gave way.
  it("an eviction announces which tab closed (the last .notice-bub names f00)", async () => {
    const listing: Record<string, readonly Entry[]> = {
      "": Array.from({ length: 11 }, (_, i) => ({ name: `f${String(i).padStart(2, "0")}.ts`, type: "file" as const })),
    };
    const h = await connectedApp(listing);
    for (const name of listing[""]!.map((e) => e.name)) {
      click(h.container.querySelector(`.tree-node[data-path="${name}"] > .ft-row`));
      await drain(h);
    }
    expect(tabPaths(h)).toEqual(listing[""]!.map((e) => e.name).slice(1)); // f00 (non-active) evicted
    const bubs = [...h.container.querySelectorAll(".notice-bub")];
    expect(bubs.length).toBeGreaterThan(0);
    expect(bubs[bubs.length - 1]?.textContent).toBe("标签已满（10 个）：已关闭「f00.ts」");
  });

  it("Ctrl+W closes the active tab; Ctrl+Tab / Ctrl+Shift+Tab cycle with wrap; Ctrl+1~9 jump; with no tabs the keys are inert", async () => {
    const h = await connectedApp({
      "": [
        { name: "a.ts", type: "file" },
        { name: "b.ts", type: "file" },
        { name: "c.ts", type: "file" },
      ],
    });
    // Inert on the empty strip — nothing crashes, nothing opens.
    key("w");
    key("Tab");
    key("2");
    expect(tabPaths(h)).toEqual([]);

    for (const name of ["a.ts", "b.ts", "c.ts"]) {
      click(h.container.querySelector(`.tree-node[data-path="${name}"] > .ft-row`));
      await drain(h);
    }
    expect(activePath(h)).toBe("c.ts");

    key("Tab"); // c → a (wrap through the end)
    expect(activePath(h)).toBe("a.ts");
    key("Tab"); // a → b
    expect(activePath(h)).toBe("b.ts");
    key("Tab", { shift: true }); // b → a
    expect(activePath(h)).toBe("a.ts");
    key("Tab", { shift: true }); // a → c (wrap through the start)
    expect(activePath(h)).toBe("c.ts");

    key("2"); // jump to the 2nd tab
    expect(activePath(h)).toBe("b.ts");
    key("9"); // beyond the strip — inert
    expect(activePath(h)).toBe("b.ts");

    key("w"); // close the active b.ts → neighbor
    expect(tabPaths(h)).toEqual(["a.ts", "c.ts"]);
    expect(activePath(h)).toBe("c.ts");
  });

  it("Ctrl+W closes the active tab; Cmd+W NEVER does (the OS keeps its close-window); Enter activates a focused tab", async () => {
    const h = await connectedApp({
      "": [
        { name: "a.ts", type: "file" },
        { name: "b.ts", type: "file" },
      ],
    });
    for (const name of ["a.ts", "b.ts"]) {
      click(h.container.querySelector(`.tree-node[data-path="${name}"] > .ft-row`));
      await drain(h);
    }
    expect(activePath(h)).toBe("b.ts");

    // ui-review-r1 I4: the chord guard is ctrl-ONLY — a metaKey W must pass
    // through to the platform (no preventDefault, no close).
    let prevented = false;
    act(() => {
      prevented = !window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "w", metaKey: true, cancelable: true, bubbles: true }),
      );
    });
    expect(prevented).toBe(false);
    expect(tabPaths(h)).toEqual(["a.ts", "b.ts"]);

    // ui-review-r1 I3: the tab strip is keyboard-drivable — Enter on a
    // focused tab activates it (Space suppressed its scroll default too).
    const firstTab = h.container.querySelector('.tabbar .tab[data-path="a.ts"]') as HTMLElement;
    expect(firstTab.getAttribute("role")).toBe("tab");
    expect(firstTab.tabIndex).toBe(0);
    act(() => {
      prevented = !firstTab.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(prevented).toBe(true);
    expect(activePath(h)).toBe("a.ts");

    key("w"); // Ctrl+W still closes the active tab
    expect(tabPaths(h)).toEqual(["b.ts"]);
  });

  it("a breadcrumb dir click opens/activates that dir's tab (§8 wiring)", async () => {
    const h = await connectedApp({
      "": [{ name: "src", type: "dir" }],
      src: [{ name: "pages", type: "dir" }],
      "src/pages": [{ name: "a.ts", type: "file" }],
    });
    click(h.container.querySelector('.tree-node[data-path="src"] > .ft-row'));
    await drain(h);
    click(h.container.querySelector('.tree-node[data-path="src/pages"] > .ft-row'));
    await drain(h);
    click(h.container.querySelector('.tree-node[data-path="src/pages/a.ts"] > .ft-row'));
    await drain(h);
    expect(tabPaths(h)).toEqual(["src", "src/pages", "src/pages/a.ts"]);
    expect(activePath(h)).toBe("src/pages/a.ts");
    // The breadcrumb's DIR prefix click rides the same openTab: an existing
    // tab activates (no duplicate), the viewer switches to its dir listing.
    click(h.container.querySelector(".fileviewer .breadcrumb .crumb:not(.current)"));
    await drain(h);
    expect(tabPaths(h)).toEqual(["src", "src/pages", "src/pages/a.ts"]);
    expect(activePath(h)).toBe("src");
    expect(h.container.querySelector(".fileviewer .viewer-dir")).not.toBeNull();
  });

  it("the ◂ tabbar button collapses the center column (two-panel grid); the absolute ▸ toggle restores it", async () => {
    const h = await connectedApp({ "": [{ name: "a.ts", type: "file" }] });
    const ide = h.container.querySelector<HTMLElement>(".ide");
    // The grid's middle column rides --mid-w (1fr default, 0px collapsed).
    expect(decl(".ide", "grid-template-columns")).toBe("var(--tree-w, 220px) var(--mid-w, 1fr) var(--chat-w, 360px)");
    expect(ide?.style.getPropertyValue("--mid-w")).toBe("1fr");
    expect(h.container.querySelector(".ide-toggle[data-side='center']")).toBeNull();

    const collapse = h.container.querySelector<HTMLButtonElement>(".tabbar-collapse");
    expect(collapse?.textContent).toBe("◂");
    click(collapse);
    expect(ide?.style.getPropertyValue("--mid-w")).toBe("0px");
    // The in-bar button is gone with the column; an absolute ▸ toggle takes
    // over on the grid so the collapse never strands the user.
    expect(h.container.querySelector(".tabbar-collapse")).toBeNull();
    const expand = h.container.querySelector<HTMLButtonElement>(".ide-toggle[data-side='center']");
    expect(expand?.textContent).toBe("▸");
    click(expand);
    expect(ide?.style.getPropertyValue("--mid-w")).toBe("1fr");
    expect(h.container.querySelector(".ide-toggle[data-side='center']")).toBeNull();
    expect(h.container.querySelector(".tabbar-collapse")).not.toBeNull();
  });
});
