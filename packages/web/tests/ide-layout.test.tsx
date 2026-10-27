// @vitest-environment jsdom
// M74-ide §3 — the App-level IDE layout. The ADVANCED shell becomes the
// Cursor-style three-panel grid (left FileTree / center FileViewer / right
// the EXISTING chat + composer + status bar, composition untouched); the
// 简洁 shell stays single-column and renders none of it. Coverage: the grid
// + its CSS vars (--tree-w/--chat-w), the 16px collapse toggles, the 4px
// col-resize drag handles (clamped 180px..40% of the window), the <900px
// auto-collapse (downward crossing only — a manual re-expand stands), the
// @-linkage (the tree's @ button arms the composer's mention: a trailing
// @token in the buffer + the existing hint chip, submitted raw so the
// driver's M35 expand pipeline owns the resolution), and the agent refresh
// (a NEW write_file/edit_file tool entry in the driver history bumps the
// tree's refreshKey → the expanded dirs re-fetch, pre-existing writes on
// mount are not news).
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

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  window.localStorage.removeItem("wudao.ui.v1"); // ui-review-r3 P2: reset the persisted layout between tests
  // jsdom's window is file-wide: restore the layout default the drag/auto-
  // collapse suites override.
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
  /** Op ids already given a result (the drain idempotence set). */
  answered: Set<number>;
  /** The listing table later bare drain() calls reuse — a second drain must
   *  answer a lazily-requested dir with ITS entries, not an empty reply. */
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

/** Count op frames of one name (optionally one path) on the wire so far. */
const opCount = (h: Harness, name: string, path?: string): number =>
  opFrames(h).filter((f) => f.op.op === name && (path === undefined || f.op.path === path)).length;

interface DrainOpts {
  listing?: Record<string, readonly Entry[]>;
  uiMode?: "simple" | "advanced";
}

/** Answer every still-pending op: fileTree/fileRead from the listing table,
 *  settingsStatus with the shell preference, everything else with a bare ok.
 *  The listing table STICKS on the harness — a later bare drain() (after a
 *  lazy expand click) answers the new dir request from the same table. One
 *  flush per call — the panel effects fire inside the same act. */
async function drain(h: Harness, opts: DrainOpts = {}): Promise<void> {
  const listing = opts.listing ?? h.listing;
  if (opts.listing !== undefined) h.listing = opts.listing;
  await act(async () => {
    for (const f of opFrames(h)) {
      if (h.answered.has(f.id)) continue;
      h.answered.add(f.id);
      if (f.op.op === "fileTree") {
        h.server.socket.serverSend({
          t: "result",
          id: f.id,
          ok: { entries: listing[f.op.path ?? ""] ?? [] },
        });
      } else if (f.op.op === "settingsStatus") {
        h.server.socket.serverSend({
          t: "result",
          id: f.id,
          ok: {
            providers: [],
            credentials: { path: "/root/.wudao/credentials.json", keyCount: 0 },
            settings: {
              memoryEnabled: false,
              uiDefaultMode: opts.uiMode ?? null,
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

/** The standard connected advanced app with the src tree expanded: root +
 * src listings answered, everything else drained. TWO drains: the panels
 * mount behind the shell-preference round trip (the App gates the tree on
 * the settingsStatus reply), so the tree's root op lands one act after the
 * reply — the second drain answers it. */
async function connectedApp(listing: Record<string, readonly Entry[]>): Promise<Harness> {
  const h = mountedApp();
  await act(async () => {
    authOk(h.server.socket);
  });
  await drain(h, { listing });
  await drain(h);
  return h;
}

const drag = (h: Harness, side: "left" | "right", xs: number[]): void => {
  const handle = h.container.querySelector(`.ide-drag[data-side="${side}"]`);
  act(() => {
    handle?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: xs[0] }));
  });
  for (const x of xs.slice(1)) {
    act(() => {
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: x }));
    });
  }
  act(() => {
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: xs[xs.length - 1] }));
  });
};

describe("App three-panel IDE layout (M74-ide §3)", () => {
  it("advanced mode renders the three panels: FileTree + FileViewer + the existing chat flow; the grid rides the width vars", async () => {
    const h = await connectedApp({
      "": [
        { name: "src", type: "dir" },
        { name: "README.md", type: "file", size: 10 },
      ],
    });
    const ide = h.container.querySelector<HTMLElement>(".ide");
    expect(ide).not.toBeNull();
    expect(h.container.querySelectorAll(".ide > .ide-cell")).toHaveLength(3);
    // Left: the tree; center: the viewer's empty state; right: the chat.
    expect(h.container.querySelector(".ide-cell.ide-left .filetree")).not.toBeNull();
    expect(h.container.querySelector(".ide-cell.ide-left .tree-root")?.textContent).toContain("工作区");
    expect(h.container.querySelector(".ide-cell.ide-center .fileviewer .viewer-empty")?.textContent).toContain("从左侧选择文件查看内容");
    expect(h.container.querySelector(".ide-cell.ide-right .chat")).not.toBeNull();
    expect(h.container.querySelector(".ide-cell.ide-right .inputarea")).not.toBeNull();
    // The status bar stays advanced-only and OUTSIDE the grid.
    expect(h.container.querySelector(".statusline")).not.toBeNull();
    expect(h.container.querySelector(".ide .statusline")).toBeNull();
    // Spec §1 widths (2026-08-26 §3.3 rebalance): 220px / 1fr / 360px,
    // driven by the two vars (M75-ux2 §3: the middle column rides --mid-w
    // for the center collapse).
    expect(decl(".ide", "grid-template-columns")).toBe("var(--tree-w, 220px) var(--mid-w, 1fr) var(--chat-w, 360px)");
    expect(ide?.style.getPropertyValue("--tree-w")).toBe("220px");
    expect(ide?.style.getPropertyValue("--chat-w")).toBe("360px");
    // Spec §1 boundary controls: 16px collapse toggles, 4px col-resize handles.
    expect(decl(".ide-toggle", "width")).toBe("16px");
    expect(decl(".ide-toggle", "height")).toBe("16px");
    expect(decl(".ide-drag", "width")).toBe("4px");
    expect(decl(".ide-drag", "cursor")).toBe("col-resize");
  });

  it("simple mode keeps the single-column shell — no grid, no panels, no status bar", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await drain(h, { uiMode: "simple", listing: { "": [{ name: "a.ts", type: "file" }] } });
    expect(h.container.querySelector("[data-mode='simple']")).not.toBeNull();
    expect(h.container.querySelector(".ide")).toBeNull();
    expect(h.container.querySelector(".filetree")).toBeNull();
    expect(h.container.querySelector(".fileviewer")).toBeNull();
    expect(h.container.querySelector(".statusline")).toBeNull();
    // (SimpleMode keeps its own single-column .chat/.composer markup — the
    // assertion that matters is the IDE panels' absence + zero ops below.)
    // And no file-panel op ever hit the wire in the simple shell.
    expect(opCount(h, "fileTree")).toBe(0);
    expect(opCount(h, "fileRead")).toBe(0);
  });

  it("the collapse toggles set the width vars to 0px and back (drag handles unmount while collapsed)", async () => {
    const h = await connectedApp({ "": [{ name: "a.ts", type: "file" }] });
    const ide = h.container.querySelector<HTMLElement>(".ide");
    const left = h.container.querySelector<HTMLButtonElement>(".ide-toggle[data-side='left']");
    const right = h.container.querySelector<HTMLButtonElement>(".ide-toggle[data-side='right']");
    expect(left?.textContent).toBe("◂");
    expect(right?.textContent).toBe("▸");

    click(left);
    expect(ide?.style.getPropertyValue("--tree-w")).toBe("0px");
    expect(left?.textContent).toBe("▸");
    expect(h.container.querySelector(".ide-drag[data-side='left']")).toBeNull();
    click(left); // expand restores the remembered width, not the default
    expect(ide?.style.getPropertyValue("--tree-w")).toBe("220px");
    expect(h.container.querySelector(".ide-drag[data-side='left']")).not.toBeNull();

    click(right);
    expect(ide?.style.getPropertyValue("--chat-w")).toBe("0px");
    expect(right?.textContent).toBe("◂");
    expect(h.container.querySelector(".ide-drag[data-side='right']")).toBeNull();
    click(right);
    expect(ide?.style.getPropertyValue("--chat-w")).toBe("360px");
  });

  it("a window crossing below 900px auto-collapses the left panel; a manual re-expand stands", async () => {
    const h = await connectedApp({ "": [{ name: "a.ts", type: "file" }] });
    const ide = h.container.querySelector<HTMLElement>(".ide");
    expect(ide?.style.getPropertyValue("--tree-w")).toBe("220px");
    act(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
      window.dispatchEvent(new Event("resize"));
    });
    expect(ide?.style.getPropertyValue("--tree-w")).toBe("0px");
    // The user can re-expand at the narrow width — no crossing, no re-collapse.
    click(h.container.querySelector(".ide-toggle[data-side='left']"));
    expect(ide?.style.getPropertyValue("--tree-w")).toBe("220px");
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(ide?.style.getPropertyValue("--tree-w")).toBe("220px");
  });

  it("dragging a handle resizes the panel, clamped to 180px..40% of the window width", async () => {
    const h = await connectedApp({ "": [{ name: "a.ts", type: "file" }] });
    const ide = h.container.querySelector<HTMLElement>(".ide");
    // Left: a 240→320 x-move drags 220+80 = 300 (plain drag), → 180 (min
    // clamp), → 409 (40% of 1024). Coordinates are pointer x's, not widths.
    drag(h, "left", [240, 320]);
    expect(ide?.style.getPropertyValue("--tree-w")).toBe("300px");
    drag(h, "left", [240, 100]);
    expect(ide?.style.getPropertyValue("--tree-w")).toBe("180px");
    drag(h, "left", [240, 900]);
    expect(ide?.style.getPropertyValue("--tree-w")).toBe("409px");
    // Right: mirrored — dragging LEFT widens the chat column. A fresh
    // mousedown reads the CURRENT width (260 after the first drag), and the
    // same 40% ceiling caps from the right too.
    drag(h, "right", [800, 900]);
    expect(ide?.style.getPropertyValue("--chat-w")).toBe("260px");
    drag(h, "right", [790, 750]);
    expect(ide?.style.getPropertyValue("--chat-w")).toBe("300px");
    drag(h, "right", [800, 4000]);
    expect(ide?.style.getPropertyValue("--chat-w")).toBe("180px");
  });

  it("M76-ux2 §5: double-clicking a drag handle resets that panel to its default width (left 220, right 360 — the 2026-08-26 rebalance)", async () => {
    const h = await connectedApp({ "": [{ name: "a.ts", type: "file" }] });
    const ide = h.container.querySelector<HTMLElement>(".ide");
    drag(h, "left", [240, 400]); // 220 + 160 = 380
    expect(ide?.style.getPropertyValue("--tree-w")).toBe("380px");
    act(() => {
      h.container
        .querySelector('.ide-drag[data-side="left"]')
        ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(ide?.style.getPropertyValue("--tree-w")).toBe("220px");
    drag(h, "right", [824, 724]); // mirrored: 360 + 100 = 460, clamped at 40% of 1024
    expect(ide?.style.getPropertyValue("--chat-w")).toBe("409px");
    act(() => {
      h.container
        .querySelector('.ide-drag[data-side="right"]')
        ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(ide?.style.getPropertyValue("--chat-w")).toBe("360px");
  });

  it("2026-08-26 §3.3 — 审查专注: Ctrl+Shift+\\ collapses the tree + narrows chat to the 320px rail; toggling off restores the snapshot; the plain chord stays the center collapse", async () => {
    const h = await connectedApp({ "": [{ name: "a.ts", type: "file" }] });
    const ide = h.container.querySelector<HTMLElement>(".ide");
    const btn = h.container.querySelector<HTMLButtonElement>("button[aria-label='审查专注']");
    expect(btn).not.toBeNull(); // advanced-only topbar affordance
    expect(btn?.getAttribute("aria-pressed")).toBe("false");
    // The chord matches e.code — a US Shift+\ carries e.key "|" and must
    // still enter the focus.
    const chord = (shift: boolean): void =>
      act(() => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { code: "Backslash", key: shift ? "|" : "\\", ctrlKey: true, shiftKey: shift }),
        );
      });
    chord(true);
    expect(ide?.style.getPropertyValue("--tree-w")).toBe("0px");
    expect(ide?.style.getPropertyValue("--chat-w")).toBe("320px");
    expect(btn?.getAttribute("aria-pressed")).toBe("true");
    chord(true); // off — the snapshot restores the fresh-mount defaults
    expect(ide?.style.getPropertyValue("--tree-w")).toBe("220px");
    expect(ide?.style.getPropertyValue("--chat-w")).toBe("360px");
    expect(btn?.getAttribute("aria-pressed")).toBe("false");
    // The plain chord (no shift) is STILL the center collapse — the two
    // never collide.
    chord(false);
    expect(ide?.style.getPropertyValue("--mid-w")).toBe("0px");
  });

  it("the tree's @ button arms the composer's mention: a trailing @token in the buffer + the hint chip; submit carries it raw", async () => {
    const h = await connectedApp({
      "": [{ name: "src", type: "dir" }],
      src: [{ name: "App.tsx", type: "file", size: 5 }],
    });
    click(h.container.querySelector('.tree-node[data-path="src"] > .ft-row')); // expand
    await drain(h);
    click(h.container.querySelector('.tree-node[data-path="src/App.tsx"] .at-btn'));
    const ta = h.container.querySelector<HTMLTextAreaElement>(".ide textarea.wudao-input");
    expect(ta?.value).toBe("@src/App.tsx");
    const hint = h.container.querySelector(".ide .inputarea .hint");
    expect(hint?.textContent).toContain("@src/App.tsx");
    // ω99-152: mention hint 模板中文化（原 "attached on send"）——
    // 钉的是 @ 按钮装填 hint 行，文案随源走。
    expect(hint?.textContent).toContain("发送时会附上");
    // Send: the mention rides the submit op verbatim — the driver's M35
    // expand pipeline (workspace-relative → absolute + content) owns it.
    click(h.container.querySelector(".ide .inputarea .send"));
    const submits = opFrames(h).filter((f) => f.op.op === "submit");
    expect(submits).toHaveLength(1);
    expect((submits[0]?.op as { text?: string }).text).toBe("@src/App.tsx");
  });

  it("a NEW write_file tool entry bumps the tree refresh: root + expanded dirs re-fetch; pre-existing writes are not news", async () => {
    const h = mountedApp();
    await act(async () => {
      // The replayed history ALREADY carries a write — seeding, not news.
      authOk(h.server.socket, {}, [
        { kind: "tool", name: "write_file", summary: "old.ts", resultPreview: "ok" },
      ]);
    });
    await drain(h, { listing: { "": [{ name: "src", type: "dir" }], src: [{ name: "App.tsx", type: "file" }] } });
    await drain(h); // the tree mounts behind the preference round trip — answer its late root op
    expect(opCount(h, "fileTree", "")).toBe(1);
    click(h.container.querySelector('.tree-node[data-path="src"] > .ft-row')); // expand src
    await drain(h);
    // M75-ux2 §4: the dir click ALSO selects src into the middle panel, so
    // the viewer's dir listing is the 2nd src fetch (tree lazy + viewer).
    expect(opCount(h, "fileTree", "src")).toBe(2);

    // The agent writes a file: a fresh write entry appends to the history.
    await act(async () => {
      h.server.socket.serverSend({
        t: "history",
        entries: [{ kind: "tool", name: "write_file", summary: "src/new.ts", resultPreview: "ok" }],
        reset: false,
      });
    });
    await drain(h);
    expect(opCount(h, "fileTree", "")).toBe(2); // root reloaded…
    expect(opCount(h, "fileTree", "src")).toBe(3); // …and the expanded dir too (viewer's path is unchanged — no re-fetch)
  });

  it("a non-write tool entry does not bump the refresh", async () => {
    const h = await connectedApp({ "": [{ name: "a.ts", type: "file" }] });
    expect(opCount(h, "fileTree", "")).toBe(1);
    await act(async () => {
      h.server.socket.serverSend({
        t: "history",
        entries: [{ kind: "tool", name: "shell", summary: "npm t", resultPreview: "" }],
        reset: false,
      });
    });
    await flush();
    expect(opCount(h, "fileTree", "")).toBe(1); // read-only tools never refresh
  });

  it("clicking a file in the tree opens it in the middle panel and moves the selection highlight", async () => {
    const h = await connectedApp({
      "": [{ name: "src", type: "dir" }],
      src: [
        { name: "App.tsx", type: "file", size: 5 },
        { name: "main.ts", type: "file", size: 3 },
      ],
    });
    click(h.container.querySelector('.tree-node[data-path="src"] > .ft-row'));
    await drain(h);
    // M75-ux2 §4: the dir click ALSO routes the middle panel — the viewer
    // renders the dir listing (the tree's expand and the panel's select are
    // the same gesture now), and the tree's dir row carries the selection.
    expect(h.container.querySelector(".ide-cell.ide-center .viewer-dir")).not.toBeNull();
    expect(h.container.querySelector(".fileviewer .fv-head .fv-file")?.textContent).toBe("src");
    click(h.container.querySelector('.tree-node[data-path="src/App.tsx"] > .ft-row'));
    await drain(h); // the fileRead reply lands
    expect(h.container.querySelector(".fileviewer .fv-head .fv-file")?.textContent).toBe("src/App.tsx");
    expect(h.container.querySelector(".fileviewer .viewer-line")).not.toBeNull();
    expect(h.container.querySelector(".ft-row.on")?.closest(".tree-node")?.getAttribute("data-path")).toBe("src/App.tsx");
    // Switching files re-reads: one fileRead per click, never more.
    click(h.container.querySelector('.tree-node[data-path="src/main.ts"] > .ft-row'));
    await drain(h);
    expect(h.container.querySelector(".fileviewer .fv-head .fv-file")?.textContent).toBe("src/main.ts");
    expect(opCount(h, "fileRead")).toBe(2);
  });

  it("M76-ux2 §1: a NEW write_file marks the tree node (accent class + CSS); the manual ⟳ clears the marks", async () => {
    const h = await connectedApp({
      "": [{ name: "src", type: "dir" }],
      src: [{ name: "new.ts", type: "file", size: 3 }],
    });
    click(h.container.querySelector('.tree-node[data-path="src"] > .ft-row')); // expand src
    await drain(h);
    const node = (): Element | null => h.container.querySelector('.tree-node[data-path="src/new.ts"]');
    expect(node()?.className).toBe("tree-node file"); // unmarked before any write
    // The agent writes: a fresh write entry lands in the driver history.
    await act(async () => {
      h.server.socket.serverSend({
        t: "history",
        entries: [{ kind: "tool", name: "write_file", summary: "src/new.ts", resultPreview: "ok" }],
        reset: false,
      });
    });
    await drain(h); // the tree reloads (the same watcher's refresh) with the marker set standing
    expect(node()?.className).toBe("tree-node file modified");
    // The CSS contract (116 弧 A): a 2px ok-semantic bar + ok name — modified
    // = diff-add semantics, not brand color.
    expect(decl(".tree-node.file.modified > .ft-row", "box-shadow")).toBe("inset 2px 0 0 var(--ok)");
    expect(decl(".tree-node.file.modified > .ft-row .name", "color")).toBe("var(--ok)");
    // The agent-driven refresh did NOT clear (the marks are the point); the
    // MANUAL ⟳ does.
    click(h.container.querySelector(".filetree .tree-refresh"));
    await drain(h);
    expect(node()?.className).toBe("tree-node file");
  });

  it("M76-ux2 §1: pre-existing writes replayed in history seed nothing — only entries appending WITHIN an epoch mark", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, {}, [
        { kind: "tool", name: "edit_file", summary: "src/old.ts", resultPreview: "ok" },
      ]);
    });
    await drain(h, { listing: { "": [{ name: "src", type: "dir" }], src: [{ name: "old.ts", type: "file" }] } });
    await drain(h);
    click(h.container.querySelector('.tree-node[data-path="src"] > .ft-row'));
    await drain(h);
    // The replay is a replacement, not news — old.ts stays unmarked.
    expect(h.container.querySelector('.tree-node[data-path="src/old.ts"]')?.className).toBe("tree-node file");
    // A NON-write tool appending in-epoch marks nothing either.
    await act(async () => {
      h.server.socket.serverSend({
        t: "history",
        entries: [{ kind: "tool", name: "shell", summary: "npm t", resultPreview: "" }],
        reset: false,
      });
    });
    await drain(h);
    expect(h.container.querySelector('.tree-node[data-path="src/old.ts"]')?.className).toBe("tree-node file");
  });

  // ui-review-r1 I5: a fresh ADVANCED session shows the empty hero in the
  // chat column (the shared chatColumn renders it), not a blank column.
  it("empty history in the advanced shell renders the EmptyHero; a real turn flips it off", async () => {
    const h = await connectedApp({ "": [{ name: "a.ts", type: "file" }] });
    const hero = h.container.querySelector(".ide-cell.ide-right .hero");
    expect(hero).not.toBeNull();
    expect(hero?.querySelector("h1")?.textContent).toContain("你好呀，我是悟道"); // ω99-167: hero 换自我介绍
    await act(async () => {
      h.server.socket.serverSend({ t: "history", entries: [{ kind: "user", text: "hi" }], reset: false });
    });
    expect(h.container.querySelector(".hero")).toBeNull();
  });
});
