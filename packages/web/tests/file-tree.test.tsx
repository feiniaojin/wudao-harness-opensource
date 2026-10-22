// @vitest-environment jsdom
// M74-ide §2 — FileTree: the IDE left panel. Lazy one-level loading (the
// root listing on mount, a dir's children only on first expand), the
// defensive dirs-first-alpha re-sort, the hidden-entry filter + ☰ toggle,
// single selection, the @ button's workspace-relative mention, and the
// refresh contract (a new refreshKey wipes every cached listing while the
// expanded SET survives, so refresh reloads content, not the user's place).
// The client is the structural FileOpsClient port (file-ops.ts): the mock
// below supplies the two methods as plain vi.fn's — the spec §5 shapes are
// declared HERE until Task 1's protocol mirror merges.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { stylesCss } from "./styles-source.js";
import "../src/styles.css";
import { FileTree } from "../src/components/FileTree.js";
import type { FileOpsClient } from "../src/file-ops.js";
import { decl } from "./css-test-utils.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The raw sheet text (colors read through decl() — jsdom never resolves
 *  var(); the raw text backs the geometry pins cssstyle would drop). */
const STYLES_CSS = stylesCss;

/** Spec §5 shapes, local to the test until the protocol types land (Task 1). */
interface Entry {
  name: string;
  type: "file" | "dir";
  size?: number;
  hidden?: boolean;
}
interface TreeResult {
  entries: Entry[];
}

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
/** Re-render with new props on the SAME root (the refreshKey flow). */
const rerender = (el: React.ReactElement): void => {
  act(() => {
    root?.render(el);
  });
};
const flush = async (): Promise<void> => {
  await act(async () => {});
};
const click = (el: Element | null | undefined): void => {
  act(() => {
    el?.dispatchEvent(new Event("click", { bubbles: true }));
  });
};
/** Type into a controlled input the way a real browser does (the native
 *  value setter, then the input event) — React's onChange ignores a bare
 *  .value assignment + dispatch under jsdom. */
function type(el: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
});

const ROOT = "~/xdev/github/wudao-harness";

/** A mock FileOpsClient over a mutable path→entries table: later edits are
 *  what the refresh assertions read (the tree must re-fetch, not reuse).
 *  fileRead is structurally required by the port but never called by the
 *  tree — the stub fails loud if that ever changes. */
function treeHarness(listing: Record<string, Entry[]>): { client: FileOpsClient; fileTree: ReturnType<typeof vi.fn> } {
  const fileTree = vi.fn((path: string): Promise<TreeResult> =>
    Promise.resolve({ entries: listing[path] ?? [] }),
  );
  const client: FileOpsClient = {
    fileTree,
    fileRead: () => Promise.reject(new Error("FileTree never reads files")),
  };
  return { client, fileTree };
}

const callsFor = (fn: ReturnType<typeof vi.fn>, path: string): number =>
  fn.mock.calls.filter((c) => c[0] === path).length;

/** Root-level visible names in DOM order. */
const rootNames = (c: HTMLElement): string[] =>
  [...c.querySelectorAll(".tree-body > .tree-node > .ft-row > .name")].map((n) => n.textContent ?? "");

describe("FileTree (M74-ide §2)", () => {
  it("loads only the root listing on mount; expanding a dir lazily fetches its children (sorted)", async () => {
    const h = treeHarness({
      "": [
        { name: "src", type: "dir" },
        { name: "README.md", type: "file" },
      ],
      src: [
        { name: "z.ts", type: "file" },
        { name: "inner", type: "dir" },
        { name: "App.tsx", type: "file" },
      ],
    });
    const c = mount(
      <FileTree client={h.client} workspaceRoot={ROOT} selectedPath={null} onSelect={vi.fn()} onAtMention={vi.fn()} refreshKey={0} />,
    );
    await flush();
    // Lazy: exactly the root fetch — no src listing until the click.
    expect(h.fileTree).toHaveBeenCalledTimes(1);
    expect(h.fileTree.mock.calls[0]?.[0]).toBe("");
    expect(rootNames(c)).toEqual(["src", "README.md"]);
    expect(c.textContent).not.toContain("App.tsx");
    // M75-ux1 §2: the switcher label — [📁 dirname ▾], full path in the
    // tooltip (the old …/last-2 form is gone).
    expect(c.querySelector(".tree-root")?.textContent).toContain("wudao-harness");
    expect(c.querySelector(".ws-switcher")?.getAttribute("title")).toBe(ROOT);

    click(c.querySelector('.tree-node[data-path="src"] > .ft-row'));
    await flush();
    expect(callsFor(h.fileTree, "src")).toBe(1);
    // Children render, defensively re-sorted (dir first, then files alpha).
    const childNames = [...c.querySelectorAll('.tree-node[data-path="src"] .kids > .tree-node > .ft-row > .name')].map(
      (n) => n.textContent ?? "",
    );
    expect(childNames).toEqual(["inner", "App.tsx", "z.ts"]);
  });

  it("collapsing keeps the cache: re-expanding does not re-fetch", async () => {
    const h = treeHarness({
      "": [{ name: "src", type: "dir" }],
      src: [{ name: "App.tsx", type: "file" }],
    });
    const c = mount(
      <FileTree client={h.client} workspaceRoot={ROOT} selectedPath={null} onSelect={vi.fn()} onAtMention={vi.fn()} refreshKey={0} />,
    );
    await flush();
    const row = c.querySelector('.tree-node[data-path="src"] > .ft-row');
    click(row);
    await flush();
    expect(callsFor(h.fileTree, "src")).toBe(1);
    expect(c.textContent).toContain("App.tsx");
    click(row); // collapse — the listing stays cached
    expect(c.textContent).not.toContain("App.tsx");
    click(row); // re-expand — memory hit, not a fetch
    await flush();
    expect(callsFor(h.fileTree, "src")).toBe(1);
    expect(c.textContent).toContain("App.tsx");
  });

  it("sorts dirs-first-alpha even when the reply is unsorted", async () => {
    const h = treeHarness({
      "": [
        { name: "zeta.ts", type: "file" },
        { name: "src", type: "dir" },
        { name: "alpha.ts", type: "file" },
        { name: "lib", type: "dir" },
      ],
    });
    const c = mount(
      <FileTree client={h.client} workspaceRoot={ROOT} selectedPath={null} onSelect={vi.fn()} onAtMention={vi.fn()} refreshKey={0} />,
    );
    await flush();
    expect(rootNames(c)).toEqual(["lib", "src", "alpha.ts", "zeta.ts"]);
  });

  it("hides flagged AND name-matched entries by default; the ☰ toggle reveals them", async () => {
    const h = treeHarness({
      "": [
        { name: ".git", type: "dir", hidden: true }, // server-flagged
        { name: "node_modules", type: "dir", hidden: false }, // client-side list
        { name: ".env.local", type: "file", hidden: false }, // dotfile
        { name: "a.ts", type: "file" },
      ],
    });
    const c = mount(
      <FileTree client={h.client} workspaceRoot={ROOT} selectedPath={null} onSelect={vi.fn()} onAtMention={vi.fn()} refreshKey={0} />,
    );
    await flush();
    expect(rootNames(c)).toEqual(["a.ts"]);
    const toggle = c.querySelector<HTMLButtonElement>(".tree-toggle");
    expect(toggle?.getAttribute("aria-pressed")).toBe("false");
    click(toggle);
    expect(rootNames(c)).toEqual([".git", "node_modules", ".env.local", "a.ts"]);
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
  });

  it("marks exactly the selected file's row .on; clicking a file reports its path", async () => {
    const h = treeHarness({
      "": [
        { name: "a.ts", type: "file" },
        { name: "b.ts", type: "file" },
      ],
    });
    const onSelect = vi.fn();
    const c = mount(
      <FileTree client={h.client} workspaceRoot={ROOT} selectedPath="b.ts" onSelect={onSelect} onAtMention={vi.fn()} refreshKey={0} />,
    );
    await flush();
    // 墨线 T11: the active state moved onto the ROW (.ft-row.on); the
    // .tree-node wrapper keeps only the kind/modified classes + data-path.
    expect(c.querySelectorAll(".ft-row.on")).toHaveLength(1);
    expect(c.querySelector(".ft-row.on")?.closest(".tree-node")?.getAttribute("data-path")).toBe("b.ts");
    click(c.querySelector('.tree-node[data-path="a.ts"] > .ft-row'));
    expect(onSelect).toHaveBeenCalledWith("a.ts", false);
  });

  it("the @ button fires onAtMention with the workspace-relative path and does not select", async () => {
    const h = treeHarness({
      "": [{ name: "src", type: "dir" }],
      src: [{ name: "App.tsx", type: "file" }],
    });
    const onAtMention = vi.fn();
    const onSelect = vi.fn();
    const c = mount(
      <FileTree client={h.client} workspaceRoot={ROOT} selectedPath={null} onSelect={onSelect} onAtMention={onAtMention} refreshKey={0} />,
    );
    await flush();
    click(c.querySelector('.tree-node[data-path="src"] > .ft-row'));
    await flush();
    // M75-ux2 §4: the EXPAND click itself reports (src, true) — expected now.
    // Clear it so the assertions below stay about the @ button only.
    onSelect.mockClear();
    click(c.querySelector('.tree-node[data-path="src/App.tsx"] .at-btn'));
    expect(onAtMention).toHaveBeenCalledWith("src/App.tsx");
    expect(onSelect).not.toHaveBeenCalled();
    // Files carry the @ affordance; the dir's own row does not (the child
    // file's button is a descendant of the dir node — scope to the row).
    expect(c.querySelector('.tree-node[data-path="src"] > .ft-row .at-btn')).toBeNull();
  });

  it("a new refreshKey clears the caches: root + expanded dirs reload with fresh content, expansion retained", async () => {
    const listing: Record<string, Entry[]> = {
      "": [{ name: "src", type: "dir" }],
      src: [{ name: "old.ts", type: "file" }],
    };
    const h = treeHarness(listing);
    const c = mount(
      <FileTree client={h.client} workspaceRoot={ROOT} selectedPath={null} onSelect={vi.fn()} onAtMention={vi.fn()} refreshKey={0} />,
    );
    await flush();
    click(c.querySelector('.tree-node[data-path="src"] > .ft-row'));
    await flush();
    expect(c.textContent).toContain("old.ts");

    // The agent wrote files: App bumps refreshKey AND the listing changed.
    listing[""] = [{ name: "src", type: "dir" }, { name: "new.md", type: "file" }];
    listing.src = [{ name: "new.ts", type: "file" }];
    rerender(
      <FileTree client={h.client} workspaceRoot={ROOT} selectedPath={null} onSelect={vi.fn()} onAtMention={vi.fn()} refreshKey={1} />,
    );
    await flush();
    expect(callsFor(h.fileTree, "")).toBe(2); // root reloaded
    expect(callsFor(h.fileTree, "src")).toBe(2); // the expanded dir reloaded too
    expect(c.textContent).not.toContain("old.ts");
    expect(c.textContent).toContain("new.ts");
    expect(c.textContent).toContain("new.md");
    // Expansion SURVIVED the refresh (content reloaded, place kept).
    expect(c.querySelector('.tree-node[data-path="src"] .kids')).not.toBeNull();
  });

  it("the tree-top refresh button reloads the root listing without a refreshKey change", async () => {
    const h = treeHarness({ "": [{ name: "a.ts", type: "file" }] });
    const c = mount(
      <FileTree client={h.client} workspaceRoot={ROOT} selectedPath={null} onSelect={vi.fn()} onAtMention={vi.fn()} refreshKey={0} />,
    );
    await flush();
    expect(callsFor(h.fileTree, "")).toBe(1);
    click(c.querySelector(".tree-refresh"));
    await flush();
    expect(callsFor(h.fileTree, "")).toBe(2);
  });

  // M75-ux3 §7 — the tree filter: a small input under the tree-top filters
  // the LOADED nodes live (frontend-only, no ops on the wire); a dir stays
  // while any loaded descendant (or its own name) matches, non-matching
  // files hide, and clearing restores the full listing.
  it("the filter input (placeholder 过滤…) live-filters loaded nodes; dirs stay via matching descendants; clearing restores", async () => {
    const h = treeHarness({
      "": [
        { name: "src", type: "dir" },
        { name: "docs", type: "dir" },
        { name: "README.md", type: "file" },
      ],
      src: [
        { name: "App.tsx", type: "file" },
        { name: "main.ts", type: "file" },
      ],
      docs: [{ name: "guide.md", type: "file" }],
    });
    const c = mount(
      <FileTree client={h.client} workspaceRoot={ROOT} selectedPath={null} onSelect={vi.fn()} onAtMention={vi.fn()} refreshKey={0} />,
    );
    await flush();
    click(c.querySelector('.tree-node[data-path="src"] > .ft-row')); // expand src
    click(c.querySelector('.tree-node[data-path="docs"] > .ft-row')); // expand docs
    await flush();
    const callsBefore = h.fileTree.mock.calls.length;
    const input = c.querySelector<HTMLInputElement>(".tree-filter input");
    expect(input).not.toBeNull();
    expect(input?.placeholder).toBe("过滤…");

    type(input!, "app"); // case-insensitive name match on src/App.tsx
    expect(rootNames(c)).toEqual(["src"]); // src survives via its child…
    expect(c.querySelector('.tree-node[data-path="src/App.tsx"]')).not.toBeNull();
    expect(c.querySelector('.tree-node[data-path="src/main.ts"]')).toBeNull(); // …its non-matching sibling hides
    expect(c.querySelector('.tree-node[data-path="docs"]')).toBeNull(); // no match anywhere under docs
    expect(c.querySelector('.tree-node[data-path="README.md"]')).toBeNull();
    // Filtering is pure frontend: not a single extra op on the wire.
    expect(h.fileTree.mock.calls.length).toBe(callsBefore);

    type(input!, "docs"); // a dir matching by its OWN name stays (children hide)
    expect(rootNames(c)).toEqual(["docs"]);
    expect(c.querySelector('.tree-node[data-path="docs/guide.md"]')).toBeNull();

    type(input!, ""); // clearing restores the full listing (dirs-first-alpha)
    expect(rootNames(c)).toEqual(["docs", "src", "README.md"]);
    expect(c.querySelector('.tree-node[data-path="src/main.ts"]')).not.toBeNull();
    expect(c.querySelector('.tree-node[data-path="docs/guide.md"]')).not.toBeNull();
  });

  it("the filter matches case-insensitively on file names", async () => {
    const h = treeHarness({
      "": [
        { name: "Alpha.ts", type: "file" },
        { name: "beta.ts", type: "file" },
      ],
    });
    const c = mount(
      <FileTree client={h.client} workspaceRoot={ROOT} selectedPath={null} onSelect={vi.fn()} onAtMention={vi.fn()} refreshKey={0} />,
    );
    await flush();
    type(c.querySelector<HTMLInputElement>(".tree-filter input")!, "ALPHA");
    expect(rootNames(c)).toEqual(["Alpha.ts"]);
  });
});

// M75-ux2 §4 (dir-click→onSelect) + §5 (loading feedback): a dir click now
// does BOTH things — toggles the subtree AND reports (path, true) so the
// App can open a directory TAB (the middle panel's dir mode becomes
// reachable through the same gesture). Loading feedback: a spinner row in
// the expanding children area until the reply lands, the initial root load
// spins the whole tree area, and a failed load shows the retry row.
describe("FileTree dir-click + loading feedback (M75-ux2 §4/§5)", () => {
  it("a dir click toggles expansion AND reports onSelect(path, true) — every click, open or collapse", async () => {
    const h = treeHarness({
      "": [{ name: "src", type: "dir" }],
      src: [{ name: "App.tsx", type: "file" }],
    });
    const onSelect = vi.fn();
    const c = mount(
      <FileTree client={h.client} workspaceRoot={ROOT} selectedPath={null} onSelect={onSelect} onAtMention={vi.fn()} refreshKey={0} />,
    );
    await flush();
    click(c.querySelector('.tree-node[data-path="src"] > .ft-row'));
    await flush();
    expect(onSelect).toHaveBeenCalledWith("src", true);
    expect(c.textContent).toContain("App.tsx"); // expanded
    // Re-click = collapse the subtree, still reporting (the App's tab
    // dedupe by path keeps the tab; §4: 折叠子树但不关标签).
    click(c.querySelector('.tree-node[data-path="src"] > .ft-row'));
    expect(c.textContent).not.toContain("App.tsx");
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenLastCalledWith("src", true);
  });

  it("expanding an uncached dir shows a spinner row in the children area until the reply lands", async () => {
    // A manually-released gate on "src": the promise settles only when the
    // test says so, so the spinner state is directly observable.
    let release: ((r: TreeResult) => void) | null = null;
    const fileTree = vi.fn((path: string): Promise<TreeResult> => {
      if (path === "") return Promise.resolve({ entries: [{ name: "src", type: "dir" }] });
      return new Promise<TreeResult>((res) => {
        release = res;
      });
    });
    const client: FileOpsClient = { fileTree, fileRead: () => Promise.reject(new Error("never")) };
    const c = mount(
      <FileTree client={client} workspaceRoot={ROOT} selectedPath={null} onSelect={vi.fn()} onAtMention={vi.fn()} refreshKey={0} />,
    );
    await flush();
    click(c.querySelector('.tree-node[data-path="src"] > .ft-row'));
    expect(c.querySelector('.tree-node[data-path="src"] .kids .tree-loading .tree-spin')).not.toBeNull();
    await act(async () => {
      release?.({ entries: [{ name: "App.tsx", type: "file" }] });
    });
    expect(c.querySelector(".tree-loading")).toBeNull(); // spinner replaced by children
    expect(c.textContent).toContain("App.tsx");
  });

  it("the initial root load shows a spinner for the whole tree area", async () => {
    let release: ((r: TreeResult) => void) | null = null;
    const fileTree = vi.fn(
      () => new Promise<TreeResult>((res) => {
        release = res;
      }),
    );
    const client: FileOpsClient = { fileTree, fileRead: () => Promise.reject(new Error("never")) };
    const c = mount(
      <FileTree client={client} workspaceRoot={ROOT} selectedPath={null} onSelect={vi.fn()} onAtMention={vi.fn()} refreshKey={0} />,
    );
    expect(c.querySelector(".tree-body .tree-loading .tree-spin")).not.toBeNull();
    await act(async () => {
      release?.({ entries: [{ name: "a.ts", type: "file" }] });
    });
    expect(c.querySelector(".tree-loading")).toBeNull();
    expect(c.textContent).toContain("a.ts");
  });

  it("a failed expand shows the retry row; clicking it re-fetches and renders the children", async () => {
    let fail = true;
    const fileTree = vi.fn((path: string): Promise<TreeResult> => {
      if (path === "") return Promise.resolve({ entries: [{ name: "src", type: "dir" }] });
      return fail ? Promise.reject(new Error("EACCES")) : Promise.resolve({ entries: [{ name: "App.tsx", type: "file" }] });
    });
    const client: FileOpsClient = { fileTree, fileRead: () => Promise.reject(new Error("never")) };
    const c = mount(
      <FileTree client={client} workspaceRoot={ROOT} selectedPath={null} onSelect={vi.fn()} onAtMention={vi.fn()} refreshKey={0} />,
    );
    await flush();
    click(c.querySelector('.tree-node[data-path="src"] > .ft-row'));
    await flush();
    const err = c.querySelector('.tree-node[data-path="src"] .kids .tree-err');
    expect(err?.textContent).toContain("加载失败 · 点击重试");
    expect(err?.getAttribute("title")).toBe("EACCES");
    fail = false;
    click(err);
    await flush();
    expect(callsFor(fileTree, "src")).toBe(2);
    expect(c.textContent).toContain("App.tsx");
  });

  // ui-review-r1 I3: the rows (and the retry row) are divs with onClick —
  // Enter/Space must ride the same handlers so keyboard users can drive the
  // tree. Space's page-scroll default is suppressed.
  it("Enter selects a file row; Space toggles a dir (and suppresses the scroll default); Enter retries the error row", async () => {
    let fail = true;
    const fileTree = vi.fn((path: string): Promise<TreeResult> => {
      if (path === "") return Promise.resolve({ entries: [{ name: "src", type: "dir" }, { name: "a.ts", type: "file" }] });
      return fail ? Promise.reject(new Error("EACCES")) : Promise.resolve({ entries: [{ name: "App.tsx", type: "file" }] });
    });
    const client: FileOpsClient = { fileTree, fileRead: () => Promise.reject(new Error("never")) };
    const onSelect = vi.fn();
    const c = mount(
      <FileTree client={client} workspaceRoot={ROOT} selectedPath={null} onSelect={onSelect} onAtMention={vi.fn()} refreshKey={0} />,
    );
    await flush();
    const fileRow = c.querySelector('.tree-node[data-path="a.ts"] > .ft-row') as HTMLElement;
    expect(fileRow.getAttribute("role")).toBe("button");
    expect(fileRow.tabIndex).toBe(0);
    let prevented = false;
    act(() => {
      prevented = !fileRow.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(prevented).toBe(true);
    expect(onSelect).toHaveBeenCalledWith("a.ts", false);

    const dirRow = c.querySelector('.tree-node[data-path="src"] > .ft-row') as HTMLElement;
    act(() => {
      prevented = !dirRow.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    });
    expect(prevented).toBe(true); // Space never scrolls the page
    expect(onSelect).toHaveBeenCalledWith("src", true);
    await flush();
    const err = c.querySelector('.tree-node[data-path="src"] .kids .tree-err') as HTMLElement;
    expect(err.tabIndex).toBe(0);
    fail = false;
    act(() => {
      err.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await flush();
    expect(callsFor(fileTree, "src")).toBe(2);
    expect(c.textContent).toContain("App.tsx");
  });

  // ui-review-r1 P7: a loaded-but-empty root gets its empty state — the
  // formerly dead .tree-empty class's own home.
  it("an empty root listing renders the 空目录 empty state", async () => {
    const h = treeHarness({ "": [] });
    const c = mount(
      <FileTree client={h.client} workspaceRoot={ROOT} selectedPath={null} onSelect={vi.fn()} onAtMention={vi.fn()} refreshKey={0} />,
    );
    await flush();
    const empty = c.querySelector(".tree-body .tree-empty");
    expect(empty?.textContent).toBe("空目录");
    expect(empty?.getAttribute("role")).toBe("status");
  });
});

// 墨线 T11 — the tree ROW's ink-line shell: a 24px .ft-row line whose depth
// rides repeated .ft-indent spans (the old inline paddingLeft arithmetic is
// gone), hover = --surface on the panel bg, and the active row carries .on
// (accent-weak fill + text-1). Colors read through decl() off the mounted
// sheet (jsdom never resolves var()).
describe("FileTree 墨线 rows (.ft-row)", () => {
  it("rows are 24px .ft-row lines on the fs-ui tier; depth rides .ft-indent spans, one per level", async () => {
    const h = treeHarness({
      "": [{ name: "src", type: "dir" }],
      src: [{ name: "App.tsx", type: "file" }],
    });
    const c = mount(
      <FileTree client={h.client} workspaceRoot={ROOT} selectedPath={null} onSelect={vi.fn()} onAtMention={vi.fn()} refreshKey={0} />,
    );
    await flush();
    click(c.querySelector('.tree-node[data-path="src"] > .ft-row'));
    await flush();
    expect(c.querySelectorAll('.tree-node[data-path="src"] > .ft-row .ft-indent')).toHaveLength(0);
    expect(c.querySelectorAll('.tree-node[data-path="src/App.tsx"] > .ft-row .ft-indent')).toHaveLength(1);
    // The old inline paddingLeft arithmetic is gone — depth is spans now.
    expect((c.querySelector('.tree-node[data-path="src/App.tsx"] > .ft-row') as HTMLElement).style.paddingLeft).toBe("");
    expect(decl(".ft-row", "height")).toBe("24px");
    expect(decl(".ft-row", "font-size")).toBe("var(--fs-ui)");
    expect(decl(".ft-row .ft-indent", "width")).toBe("var(--sp-3)");
    expect(decl(".ft-row .ft-indent", "flex")).toBe("none");
  });

  it("hover sits on --surface; the active row fills accent-weak at text-1 (the .on state)", () => {
    expect(decl(".ft-row:hover", "background")).toBe("var(--surface)");
    expect(decl(".ft-row:hover", "color")).toBe("var(--text-1)");
    expect(decl(".ft-row.on", "background")).toBe("var(--accent-weak)");
    expect(decl(".ft-row.on", "color")).toBe("var(--text-1)");
    // 116 弧 A: the agent-modified marker rides the --ok semantic family
    // (modified = diff-add semantics, the .diff .add idiom) — no longer brand.
    expect(decl(".tree-node.file.modified > .ft-row", "box-shadow")).toBe("inset 2px 0 0 var(--ok)");
    expect(decl(".tree-node.file.modified > .ft-row .name", "color")).toBe("var(--ok)");
  });

  it("the row keeps the button contract (role/tabIndex) and the caret/name slots the CSS targets", async () => {
    const h = treeHarness({ "": [{ name: "a.ts", type: "file" }] });
    const c = mount(
      <FileTree client={h.client} workspaceRoot={ROOT} selectedPath={null} onSelect={vi.fn()} onAtMention={vi.fn()} refreshKey={0} />,
    );
    await flush();
    const row = c.querySelector('.tree-node[data-path="a.ts"] > .ft-row') as HTMLElement;
    expect(row.getAttribute("role")).toBe("button");
    expect(row.tabIndex).toBe(0);
    expect(row.querySelector(".name")?.textContent).toBe("a.ts");
    expect(STYLES_CSS).toMatch(/\.ft-row\s*\{[^}]*cursor:\s*pointer;/s);
  });
});
