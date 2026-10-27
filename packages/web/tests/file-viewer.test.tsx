// @vitest-environment jsdom
// M74-ide §3 — FileViewer: the IDE middle panel. The token pipeline from
// highlight.ts rides per-line with a left gutter (min-width 3ch, --text-3),
// big files cap at 2000 rendered lines + the tail 截断 notice, binary
// results render the placeholder card instead of content, a null path is
// the centered empty state, a dir path renders the entries table off the
// same fileTree op, and a rejected read (the server's sensitive-path /
// escape refusals) surfaces its message instead of silently blanking.
// The client is the structural FileOpsClient port (file-ops.ts) — the
// spec §5 shapes are declared HERE until Task 1's protocol mirror merges.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { stylesCss } from "./styles-source.js";
import "../src/styles.css";
import { FileViewer } from "../src/components/FileViewer.js";
import type { FileOpsClient } from "../src/file-ops.js";
import { decl } from "./css-test-utils.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The raw sheet text — the border-bottom pin reads the source (cssstyle
 *  drops var()-bearing border shorthands, the .panel-head precedent). */
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
interface ReadResult {
  content: string;
  truncated: boolean;
  totalBytes: number;
  lines: number;
  language: string;
  binary?: boolean;
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
/** Re-render with new props on the SAME root (the path-switch flows). */
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

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
});

function viewerHarness(over: {
  fileRead?: (path: string) => Promise<ReadResult>;
  fileTree?: (path: string) => Promise<TreeResult>;
}): { client: FileOpsClient; fileRead: ReturnType<typeof vi.fn>; fileTree: ReturnType<typeof vi.fn> } {
  const fileRead = vi.fn(over.fileRead ?? (() => Promise.reject(new Error("no fileRead stub"))));
  const fileTree = vi.fn(over.fileTree ?? (() => Promise.reject(new Error("no fileTree stub"))));
  const client: FileOpsClient = { fileRead, fileTree };
  return { client, fileRead, fileTree };
}

const read = (content: string, extra?: Partial<ReadResult>): ReadResult => ({
  content,
  truncated: false,
  totalBytes: content.length,
  lines: content.split("\n").length,
  language: "ts",
  ...extra,
});

describe("FileViewer (M74-ide §3)", () => {
  it("renders highlight.ts tokens per line with a numbered left gutter", async () => {
    const h = viewerHarness({
      fileRead: () => Promise.resolve(read('const x = "hi"; // note')),
    });
    const c = mount(<FileViewer client={h.client} path="src/a.ts" isDir={false} />);
    await flush();
    expect(c.querySelector(".viewer-code")).not.toBeNull();
    // The three token classes the pipeline classifies on that line.
    expect(c.querySelector(".viewer-src .tok-key")?.textContent).toBe("const");
    expect(c.querySelector(".viewer-src .tok-str")?.textContent).toBe('"hi"');
    expect(c.querySelector(".viewer-src .tok-com")?.textContent).toBe("// note");
    // The head carries the path (墨线 T11: .fv-head > .fv-file).
    expect(c.querySelector(".fv-head .fv-file")?.textContent).toBe("src/a.ts");
  });

  it("numbers every line 1..N in the gutter", async () => {
    const h = viewerHarness({
      fileRead: () => Promise.resolve(read("aa\nbb\ncc")),
    });
    const c = mount(<FileViewer client={h.client} path="a.txt" isDir={false} />);
    await flush();
    const lines = [...c.querySelectorAll(".viewer-line")];
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.querySelector(".viewer-gutter")?.textContent)).toEqual(["1", "2", "3"]);
    expect(lines.map((l) => l.querySelector(".viewer-src")?.textContent)).toEqual(["aa", "bb", "cc"]);
  });

  // 20000ms: this is the suite's one heavyweight render (2000 line elements
  // through jsdom) — the 5s default is tight on a machine running parallel
  // worktree test batches, and the timeout (not the assertion) is what fails.
  it("caps a big file at 2000 rendered lines with the tail 截断 notice", async () => {
    const big = Array.from({ length: 2500 }, (_, i) => `line-${i}`).join("\n");
    const h = viewerHarness({
      fileRead: () => Promise.resolve(read(big, { truncated: true, totalBytes: 153600, lines: 2500 })),
    });
    const c = mount(<FileViewer client={h.client} path="big.log" isDir={false} />);
    await flush();
    expect(c.querySelectorAll(".viewer-line")).toHaveLength(2000);
    const notice = c.querySelector(".viewer-truncated");
    expect(notice?.textContent).toContain("截断");
    expect(notice?.textContent).toContain("153600");
    expect(notice?.textContent).toContain("2000");
    // The last rendered line is the 2000th, not the file's tail.
    const last = [...c.querySelectorAll(".viewer-src")].at(-1)?.textContent;
    expect(last).toBe("line-1999");
  }, 20000);

  it("a binary result renders the placeholder card and reads no lines", async () => {
    const h = viewerHarness({
      fileRead: () => Promise.resolve(read("", { binary: true, totalBytes: 4096, lines: 0, language: "text" })),
    });
    const c = mount(<FileViewer client={h.client} path="logo.png" isDir={false} />);
    await flush();
    const card = c.querySelector(".viewer-binary");
    expect(card?.textContent).toBe("二进制文件 · 4096 bytes · 不支持预览");
    expect(c.querySelectorAll(".viewer-line")).toHaveLength(0);
  });

  it("a null path is the centered empty state and fetches nothing", async () => {
    const h = viewerHarness({});
    const c = mount(<FileViewer client={h.client} path={null} isDir={false} />);
    await flush();
    expect(c.querySelector(".viewer-empty")?.textContent).toContain("从左侧选择文件查看内容");
    expect(h.fileRead).not.toHaveBeenCalled();
    expect(h.fileTree).not.toHaveBeenCalled();
  });

  it("a dir path renders the entries table (name / type / size) off fileTree", async () => {
    const h = viewerHarness({
      fileTree: (p) => {
        expect(p).toBe("src");
        return Promise.resolve({
          entries: [
            { name: "z.ts", type: "file", size: 120 },
            { name: "inner", type: "dir" },
            { name: "App.tsx", type: "file", size: 4096 },
          ],
        });
      },
    });
    const c = mount(<FileViewer client={h.client} path="src" isDir={true} />);
    await flush();
    expect(h.fileRead).not.toHaveBeenCalled();
    const rows = [...c.querySelectorAll(".viewer-dir tbody tr")];
    expect(rows).toHaveLength(3);
    // Dirs-first-alpha ordering carries into the listing.
    expect(rows.map((r) => (r.querySelector("td")?.textContent ?? "").trim())).toEqual(["inner", "App.tsx", "z.ts"]);
    const texts = rows.map((r) => r.textContent ?? "");
    expect(texts[0]).toContain("目录");
    expect(texts[0]).not.toContain("bytes");
    expect(texts[1]).toContain("文件");
    expect(texts[1]).toContain("4096");
  });

  it("a rejected read surfaces the server's refusal instead of blanking", async () => {
    const h = viewerHarness({
      fileRead: () => Promise.reject(new Error("sensitive path: .env")),
    });
    const c = mount(<FileViewer client={h.client} path=".env" isDir={false} />);
    await flush();
    expect(c.querySelector(".viewer-err")?.textContent).toContain("sensitive path: .env");
    // r5-P4 → 116 弧 C: the warn glyph is the triangle-alert 细线字形
    // (svg in place, zero emoji)。
    expect(c.querySelector(".viewer-err svg")).not.toBeNull();
    expect(c.querySelector(".viewer-err")?.textContent).not.toContain("⚠");
    expect(c.querySelectorAll(".viewer-line")).toHaveLength(0);
  });
});

// M75-ux2 §8 — the breadcrumb strip (24px, below the tab bar): the path's
// segments separated by /, every DIR prefix clickable (→ onOpenPath with
// isDir=true, which the App turns into a dir tab), the current segment in
// the accent color and inert.
describe("FileViewer breadcrumb (M75-ux2 §8)", () => {
  it("renders the segments; dir prefixes are clickable, the current segment is accent and inert", async () => {
    const h = viewerHarness({
      fileRead: () => Promise.resolve(read("// x")),
    });
    const onOpenPath = vi.fn();
    const c = mount(<FileViewer client={h.client} path="src/pages/Login.tsx" isDir={false} onOpenPath={onOpenPath} />);
    await flush();
    const crumbs = [...c.querySelectorAll(".breadcrumb .crumb")];
    expect(crumbs.map((k) => k.textContent)).toEqual(["src", "pages", "Login.tsx"]);
    expect(c.querySelectorAll(".breadcrumb .crumb-sep")).toHaveLength(2); // the / separators
    // Current (last) segment: accent-marked, not clickable.
    expect(crumbs[2]?.className).toContain("current");
    click(crumbs[2]);
    // Dir prefixes open as DIR paths.
    click(crumbs[0]);
    expect(onOpenPath).toHaveBeenCalledWith("src", true);
    click(crumbs[1]);
    expect(onOpenPath).toHaveBeenCalledWith("src/pages", true);
    expect(onOpenPath).toHaveBeenCalledTimes(2);
  });

  it("a dir path's breadcrumb makes every prefix but the last clickable", async () => {
    const h = viewerHarness({
      fileTree: () => Promise.resolve({ entries: [] }),
    });
    const onOpenPath = vi.fn();
    const c = mount(<FileViewer client={h.client} path="src/pages" isDir={true} onOpenPath={onOpenPath} />);
    await flush();
    const crumbs = [...c.querySelectorAll(".breadcrumb .crumb")];
    expect(crumbs.map((k) => k.textContent)).toEqual(["src", "pages"]);
    click(crumbs[0]);
    expect(onOpenPath).toHaveBeenCalledWith("src", true);
    expect(crumbs[1]?.className).toContain("current");
  });

  it("a null path renders no breadcrumb", async () => {
    const h = viewerHarness({});
    const c = mount(<FileViewer client={h.client} path={null} isDir={false} />);
    await flush();
    expect(c.querySelector(".breadcrumb")).toBeNull();
  });

  // ui-review-r1 I3: the dir crumbs carried role="button" without
  // tabIndex/keys — mouse-only. Enter/Space open the dir tab now.
  it("Enter/Space on a dir crumb opens it (keyboard-drivable)", async () => {
    const h = viewerHarness({
      fileRead: () => Promise.resolve(read("// x")),
    });
    const onOpenPath = vi.fn();
    const c = mount(<FileViewer client={h.client} path="src/pages/Login.tsx" isDir={false} onOpenPath={onOpenPath} />);
    await flush();
    const crumb = c.querySelector(".breadcrumb .crumb:not(.current)") as HTMLElement;
    expect(crumb.tabIndex).toBe(0);
    let prevented = false;
    act(() => {
      prevented = !crumb.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(prevented).toBe(true);
    expect(onOpenPath).toHaveBeenCalledWith("src", true);
    act(() => {
      prevented = !crumb.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    });
    expect(prevented).toBe(true); // Space never scrolls
    expect(onOpenPath).toHaveBeenCalledTimes(2);
  });
});

// M75-ux2 §11 — .md files render through the Markdown component (预览,
// the default) with a「源码/预览」toggle riding the breadcrumb bar; 源码 is
// the plain numbered-line rendering; every path switch resets to 预览.
describe("FileViewer markdown preview (M75-ux2 §11)", () => {
  it(".md renders through Markdown by default; 源码 swaps to the plain lines and back", async () => {
    const h = viewerHarness({
      fileRead: () => Promise.resolve(read("# Title\n\nplain **bold** text\n", { language: "md" })),
    });
    const c = mount(<FileViewer client={h.client} path="docs/README.md" isDir={false} />);
    await flush();
    // Default 预览: the Markdown component's blocks, not the code lines.
    expect(c.querySelector(".viewer-md .md")).not.toBeNull();
    expect(c.querySelector(".viewer-md .md-heading")?.textContent).toContain("Title");
    expect(c.querySelector(".viewer-md .bold")?.textContent).toBe("bold");
    expect(c.querySelector(".viewer-code")).toBeNull();
    // The toggle rides the breadcrumb bar: 源码 / 预览.
    const sourceBtn = c.querySelector<HTMLButtonElement>('.breadcrumb .mdmode[data-mode="source"]');
    const previewBtn = c.querySelector<HTMLButtonElement>('.breadcrumb .mdmode[data-mode="preview"]');
    expect(sourceBtn).not.toBeNull();
    expect(previewBtn?.getAttribute("aria-pressed")).toBe("true");
    click(sourceBtn);
    expect(c.querySelector(".viewer-code")).not.toBeNull(); // the plain numbered lines
    expect(c.querySelector(".viewer-md")).toBeNull();
    expect(c.querySelectorAll(".viewer-line").length).toBeGreaterThan(0);
    expect(sourceBtn?.getAttribute("aria-pressed")).toBe("true");
    click(previewBtn);
    expect(c.querySelector(".viewer-md .md")).not.toBeNull();
  });

  it("a non-md file renders no toggle; a binary .md keeps the binary card (no markdown pipeline)", async () => {
    const h = viewerHarness({
      fileRead: (p) =>
        p === "img.md"
          ? Promise.resolve(read("", { binary: true, totalBytes: 10, lines: 0, language: "md" }))
          : Promise.resolve(read("// ts")),
    });
    const c = mount(<FileViewer client={h.client} path="src/a.ts" isDir={false} />);
    await flush();
    expect(c.querySelector(".breadcrumb .mdmode")).toBeNull();
    rerender(<FileViewer client={h.client} path="img.md" isDir={false} />);
    await flush();
    expect(c.querySelector(".viewer-binary")).not.toBeNull();
    expect(c.querySelector(".viewer-md")).toBeNull();
    expect(c.querySelector(".breadcrumb .mdmode")).toBeNull();
  });

  it("switching to another .md resets to 预览 (the mode is per-open, not sticky)", async () => {
    const h = viewerHarness({
      fileRead: () => Promise.resolve(read("# A\n", { language: "md" })),
    });
    const c = mount(<FileViewer client={h.client} path="a.md" isDir={false} />);
    await flush();
    click(c.querySelector('.breadcrumb .mdmode[data-mode="source"]'));
    expect(c.querySelector(".viewer-code")).not.toBeNull();
    rerender(<FileViewer client={h.client} path="b.md" isDir={false} />);
    await flush();
    expect(c.querySelector(".viewer-md .md")).not.toBeNull(); // back to 预览
  });
});

// 墨线 T11 — the viewer head's ink-line shell: .fv-head(.fv-file mono
// filename + .fv-close IconClose) on every non-empty state (file / dir /
// binary / error); the old .viewer-head/.path/.ico chrome retires. Colors
// read through decl() off the mounted sheet (jsdom never resolves var()).
describe("FileViewer 墨线 head (.fv-head)", () => {
  it("viewer head: mono filename + IconClose button", async () => {
    const h = viewerHarness({
      fileRead: () => Promise.resolve(read("// x")),
    });
    const onClose = vi.fn();
    const c = mount(<FileViewer client={h.client} path="src/a.ts" isDir={false} onClose={onClose} />);
    await flush();
    expect(c.querySelector(".fv-head .fv-file")?.textContent).toBe("src/a.ts");
    const close = c.querySelector<HTMLButtonElement>(".fv-head .fv-close");
    expect(close).not.toBeNull();
    expect(close?.querySelector("svg")).not.toBeNull(); // IconClose
    expect(close?.getAttribute("aria-label")).toBe("关闭");
    click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
    // The retired chrome is gone.
    expect(c.querySelector(".viewer-head")).toBeNull();
    expect(c.querySelector(".fv-head .ico")).toBeNull();
  });

  it("a dir head and an error head keep the same two-slot shell", async () => {
    const dirH = viewerHarness({
      fileTree: () => Promise.resolve({ entries: [{ name: "a.ts", type: "file" }] }),
    });
    const c1 = mount(<FileViewer client={dirH.client} path="src" isDir={true} />);
    await flush();
    expect(c1.querySelector(".fv-head .fv-file")?.textContent).toBe("src");
    expect(c1.querySelector(".fv-head .fv-close")).not.toBeNull();
    const errH = viewerHarness({
      fileRead: () => Promise.reject(new Error("sensitive path: .env")),
    });
    const c2 = mount(<FileViewer client={errH.client} path=".env" isDir={false} />);
    await flush();
    expect(c2.querySelector(".fv-head .fv-file")?.textContent).toBe(".env");
    expect(c2.querySelector(".fv-head .fv-close")).not.toBeNull();
  });

  it("the head rides the tokens: 34px hairline strip; mono caption filename; the 26px close chip", () => {
    expect(decl(".fv-head", "height")).toBe("34px");
    // (padding in LONGHANDS + border-bottom off the raw sheet — the
    // .panel-head precedent: jsdom does not expand shorthands, and cssstyle
    // drops var()-bearing border shorthands.)
    expect(decl(".fv-head", "padding-left")).toBe("var(--sp-3)");
    expect(decl(".fv-head", "padding-right")).toBe("var(--sp-2)");
    expect(STYLES_CSS).toMatch(/\.fv-head\s*\{[^}]*border-bottom:\s*1px solid var\(--hair-1\);/s);
    expect(decl(".fv-file", "font-family")).toBe("var(--mono)");
    expect(decl(".fv-file", "font-size")).toBe("var(--fs-caption)");
    expect(decl(".fv-file", "color")).toBe("var(--text-2)");
    expect(decl(".fv-close", "width")).toBe("26px");
    expect(decl(".fv-close", "height")).toBe("26px");
    expect(decl(".fv-close", "border-radius")).toBe("var(--radius-sm)");
    expect(decl(".fv-close:hover", "background")).toBe("var(--surface)");
    expect(decl(".fv-close:hover", "color")).toBe("var(--text-1)");
  });
});

// 高亮/编辑 spec §4 —— FileViewer 的编辑模式：门控（文本 ∧ 非截断 ∧ 非
// 二进制 ∧ 客端带 fileWrite）、value/base 双份草稿、保存三分支（written →
// 重读 + 回执；conflict → 冲突条两出口；错 → viewer-err 不清草稿）。
/** React 18 受控 textarea 的原生改值惯例（Task 7 测试同款）。 */
const setType = (ta: HTMLTextAreaElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setter?.call(ta, value);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("编辑模式（高亮/编辑 spec §4）", () => {
  const TEXT: ReadResult = { content: "old draft", truncated: false, totalBytes: 9, lines: 1, language: "text" };

  const editTextClient = (fw: ReturnType<typeof vi.fn>): FileOpsClient => ({
    fileTree: vi.fn(),
    fileRead: vi.fn().mockResolvedValue(TEXT),
    fileWrite: fw,
  });

  const findEditBtn = (c: HTMLElement): HTMLButtonElement | null =>
    (Array.from(c.querySelectorAll(".fv-head .fv-btn")).find((b) => b.textContent === "编辑") as HTMLButtonElement | undefined) ?? null;

  it("门控矩阵：文本✓；二进制/截断(>100KB)/无 fileWrite 客端 ✗", async () => {
    const withEdit = mount(<FileViewer client={editTextClient(vi.fn())} path="a.txt" isDir={false} />);
    await act(async () => {});
    expect(findEditBtn(withEdit)).not.toBeNull();

    const binClient: FileOpsClient = { fileRead: vi.fn().mockResolvedValue({ ...TEXT, binary: true, content: "" }), fileTree: vi.fn() };
    const bin = mount(<FileViewer client={binClient} path="a.png" isDir={false} />);
    await act(async () => {});
    expect(findEditBtn(bin)).toBeNull();

    const bigClient: FileOpsClient = { fileRead: vi.fn().mockResolvedValue({ ...TEXT, totalBytes: 101 * 1024 }), fileTree: vi.fn() };
    const bigc = mount(<FileViewer client={bigClient} path="a.txt" isDir={false} />);
    await act(async () => {});
    expect(findEditBtn(bigc)).toBeNull();

    const noOp: FileOpsClient = { fileRead: vi.fn().mockResolvedValue(TEXT), fileTree: vi.fn() }; // 无 fileWrite 方法
    const noc = mount(<FileViewer client={noOp} path="a.txt" isDir={false} />);
    await act(async () => {});
    expect(findEditBtn(noc)).toBeNull();
  });

  it("进入编辑：textarea 初值 = 文件内容；保存调用 fileWrite(path, value, base)", async () => {
    const fw = vi.fn().mockResolvedValue({ written: true });
    const c = mount(<FileViewer client={editTextClient(fw)} path="a.txt" isDir={false} />);
    await act(async () => {});
    act(() => { findEditBtn(c)?.click(); });
    const ta = c.querySelector("textarea.editor-ta") as HTMLTextAreaElement;
    expect(ta.value).toBe("old draft");
    setType(ta, "new draft");
    await act(async () => {});
    const save = Array.from(c.querySelectorAll(".fv-edit button")).find((b) => b.textContent === "保存") as HTMLButtonElement;
    act(() => { save.click(); });
    await act(async () => {});
    expect(fw).toHaveBeenCalledWith("a.txt", "new draft", "old draft");
  });

  it("written → 退出编辑 + 重读（fileRead 第二次）+ 已保存回执", async () => {
    const fw = vi.fn().mockResolvedValue({ written: true });
    const client = editTextClient(fw);
    const c = mount(<FileViewer client={client} path="a.txt" isDir={false} />);
    await act(async () => {});
    act(() => { findEditBtn(c)?.click(); });
    const ta = c.querySelector("textarea.editor-ta") as HTMLTextAreaElement;
    setType(ta, "new draft");
    const save = Array.from(c.querySelectorAll(".fv-edit button")).find((b) => b.textContent === "保存") as HTMLButtonElement;
    act(() => { save.click(); });
    await act(async () => {});
    expect(c.querySelector("textarea.editor-ta")).toBeNull();
    expect(client.fileRead).toHaveBeenCalledTimes(2); // selfEpoch 重读
    expect(c.querySelector(".fv-saved")?.textContent).toContain("已保存 a.txt");
  });

  it("conflict → 冲突条 + 草稿保留；重开换底稿为磁盘内容", async () => {
    const fw = vi.fn().mockResolvedValue({ conflict: true, current: "disk-truth" });
    const c = mount(<FileViewer client={editTextClient(fw)} path="a.txt" isDir={false} />);
    await act(async () => {});
    act(() => { findEditBtn(c)?.click(); });
    setType(c.querySelector("textarea.editor-ta") as HTMLTextAreaElement, "new draft");
    const save = Array.from(c.querySelectorAll(".fv-edit button")).find((b) => b.textContent === "保存") as HTMLButtonElement;
    act(() => { save.click(); });
    await act(async () => {});
    expect(c.querySelector(".fv-conflict")).not.toBeNull();
    expect((c.querySelector("textarea.editor-ta") as HTMLTextAreaElement).value).toBe("new draft");
    const reopen = Array.from(c.querySelectorAll(".fv-conflict button")).find((b) => b.textContent === "用磁盘内容重开") as HTMLButtonElement;
    act(() => { reopen.click(); });
    expect((c.querySelector("textarea.editor-ta") as HTMLTextAreaElement).value).toBe("disk-truth");
    expect(c.querySelector(".fv-conflict")).toBeNull();
  });

  it("守卫错误 → .viewer-err 呈现且草稿保留", async () => {
    const fw = vi.fn().mockRejectedValue(new Error("sensitive path"));
    const c = mount(<FileViewer client={editTextClient(fw)} path="a.txt" isDir={false} />);
    await act(async () => {});
    act(() => { findEditBtn(c)?.click(); });
    setType(c.querySelector("textarea.editor-ta") as HTMLTextAreaElement, "new draft");
    const save = Array.from(c.querySelectorAll(".fv-edit button")).find((b) => b.textContent === "保存") as HTMLButtonElement;
    act(() => { save.click(); });
    await act(async () => {});
    expect(c.querySelector(".viewer-err")?.textContent).toContain("sensitive path");
    expect(c.querySelector("textarea.editor-ta")).not.toBeNull();
  });

  it("放弃 → 退出编辑，只读视图回到原内容", async () => {
    const c = mount(<FileViewer client={editTextClient(vi.fn())} path="a.txt" isDir={false} />);
    await act(async () => {});
    act(() => { findEditBtn(c)?.click(); });
    setType(c.querySelector("textarea.editor-ta") as HTMLTextAreaElement, "scratch");
    const discard = Array.from(c.querySelectorAll(".fv-edit button")).find((b) => b.textContent === "放弃") as HTMLButtonElement;
    act(() => { discard.click(); });
    expect(c.querySelector("textarea.editor-ta")).toBeNull();
    expect(c.querySelector(".viewer-src")?.textContent).toContain("old draft");
  });
});

// ω99-148 — 选中修改：the read-only code lines carry data-line; a mouseup
// with a live Selection resolves first/last through the A layer and floats
// the「改这段」chip; clicking rides onPrefill (the /edit draft seam:
// setEditDraft → InputBox applies + clears). jsdom note: a Range over two
// lines walks every Text node between its endpoints, so interior GUTTER
// digits ride toString() (browsers exclude user-select:none gutters — the
// A layer takes the browser's word); the component pins what the chip
// owns: the path, the line range, the fences, and the quoted content.
describe("FileViewer 选中修改 (ω99-148)", () => {
  /** A live jsdom Selection spanning .viewer-src of lines first..last. */
  const selectLines = (c: HTMLElement, first: number, last: number): void => {
    const a = c.querySelector(`.viewer-line[data-line="${first}"] .viewer-src`) as HTMLElement;
    const b = c.querySelector(`.viewer-line[data-line="${last}"] .viewer-src`) as HTMLElement;
    const range = document.createRange();
    range.setStartBefore(a);
    range.setEndAfter(b);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };
  const mouseUp = (c: HTMLElement): void => {
    act(() => {
      c.querySelector(".viewer-code")?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
  };

  it("选中两行 → mouseup 浮「改这段」→ 点击 → onPrefill 收到 path+行号+围栏引文的完整模板", async () => {
    const h = viewerHarness({
      fileRead: () => Promise.resolve(read("aa\nbb\ncc\ndd")),
    });
    const onPrefill = vi.fn();
    const c = mount(<FileViewer client={h.client} path="src/a.ts" isDir={false} onPrefill={onPrefill} />);
    await flush();
    selectLines(c, 3, 4);
    mouseUp(c);
    const chip = c.querySelector<HTMLButtonElement>(".fv-selchip");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe("改这段");
    // The chip floats (fixed) over the code pane.
    expect(decl(".fv-selchip", "position")).toBe("fixed");
    act(() => { chip?.click(); });
    expect(onPrefill).toHaveBeenCalledTimes(1);
    const tmpl = onPrefill.mock.calls[0]?.[0] as string;
    expect(tmpl.startsWith("请修改 src/a.ts 第 3-4 行：")).toBe(true);
    expect(tmpl).toContain("```\ncc"); // the fence opens onto the first selected line
    expect(tmpl.endsWith("我的要求：")).toBe(true);
    // The ask riding clears the chip (v1 单选区即清).
    expect(c.querySelector(".fv-selchip")).toBeNull();
  });

  it("空选区（塌缩）mouseup 无 chip", async () => {
    const h = viewerHarness({
      fileRead: () => Promise.resolve(read("aa\nbb")),
    });
    const onPrefill = vi.fn();
    const c = mount(<FileViewer client={h.client} path="a.txt" isDir={false} onPrefill={onPrefill} />);
    await flush();
    const src = c.querySelector('.viewer-line[data-line="1"] .viewer-src') as HTMLElement;
    const range = document.createRange();
    range.setStart(src, 0);
    range.setEnd(src, 0); // collapsed — toString() is empty
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    mouseUp(c);
    expect(c.querySelector(".fv-selchip")).toBeNull();
    expect(onPrefill).not.toHaveBeenCalled();
  });

  it("onPrefill 未传：选中静默无 chip（prop 缺席 = 宿主不要此能力）", async () => {
    const h = viewerHarness({
      fileRead: () => Promise.resolve(read("aa\nbb\ncc")),
    });
    const c = mount(<FileViewer client={h.client} path="a.txt" isDir={false} />);
    await flush();
    selectLines(c, 1, 3);
    expect(() => mouseUp(c)).not.toThrow();
    expect(c.querySelector(".fv-selchip")).toBeNull();
  });

  it("换文件重取时 chip 清空（path 变化 → fetch effect 重置）", async () => {
    const h = viewerHarness({
      fileRead: (p) => Promise.resolve(read(p === "a.ts" ? "aa\nbb\ncc\ndd" : "xx\nyy", { language: "ts" })),
    });
    const onPrefill = vi.fn();
    const c = mount(<FileViewer client={h.client} path="a.ts" isDir={false} onPrefill={onPrefill} />);
    await flush();
    selectLines(c, 2, 3);
    mouseUp(c);
    expect(c.querySelector(".fv-selchip")).not.toBeNull();
    rerender(<FileViewer client={h.client} path="b.ts" isDir={false} onPrefill={onPrefill} />);
    await flush();
    expect(c.querySelector(".fv-selchip")).toBeNull();
  });
});
