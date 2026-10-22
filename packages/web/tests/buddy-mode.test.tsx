// @vitest-environment jsdom
// M78-buddy — Buddy 模式 suite. Slice 1: the SessionSidebar unit (rows from
// the sessions op, name→firstUser-首行→id8 三级标题 (ω99-147), 40-char preview, relative time, the
// active row's highlight, the [+ 新对话] / 设置 / row-click gestures). Slice
// 2: the App's buddy branch — the two-panel shell (sidebar + the shared chat
// column + statusbar), the /clear confirm behind [+ 新对话], the resume op
// behind a row click, and the simple/advanced regression (no sidebar). Slice
// 3: the settings channel — the third 「Buddy 模式」 chip writes
// ui.defaultMode=buddy through settingsSet.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WudaoClient } from "../src/protocol.js";
import type { SessionRow } from "../src/protocol.js";
import { App } from "../src/components/App.js";
import { SessionSidebar, relativeTime, sessionPreview, sessionTitle, sessionTitleTip } from "../src/components/SessionSidebar.js";
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

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  window.localStorage.removeItem("wudao.ui.v1"); // ui-review-r3 P2: reset the persisted layout between tests
});

/** A sessions-op client double — the structural slice the sidebar consumes. */
const sessionsClient = (rows: readonly SessionRow[]): { sessions: ReturnType<typeof vi.fn> } => ({
  sessions: vi.fn(() => Promise.resolve(rows)),
});

const row = (over: Partial<SessionRow> & { id: string }): SessionRow => ({
  mtime: new Date(Date.now() - 5 * 60_000).toISOString(),
  messages: 2,
  firstUser: "",
  model: "deepseek-v4-flash",
  ...over,
});

// ---------------------------------------------------------------------------
// Slice 1 — the SessionSidebar unit.
// ---------------------------------------------------------------------------
/** T8 墨线 §3 harness: the sidebar's ink-line props defaulted to inert,
 *  overridable per test. ω99-147: the five model props are gone — the footer
 *  is [Buddy 模式 note][⚙ 设置]; model switching lives in the composer. */
function mountSidebar(over: Partial<Parameters<typeof SessionSidebar>[0]> = {}): HTMLElement {
  const props: Parameters<typeof SessionSidebar>[0] = {
    client: sessionsClient([]),
    activeSessionId: null,
    onResume: () => {},
    onNewChat: () => {},
    onOpenSettings: () => {},
    onOpenSearch: () => {},
    ...over,
  };
  return mount(<SessionSidebar {...props} />);
}

// T8 墨线 §3 — the sidebar's information architecture: 新对话 the first
// citizen button, the 26px compact search row, date-grouped 28px session
// rows with the .on selected state, and the footer model row.
describe("T8 墨线 §3 — SessionSidebar shell", () => {
  it("the .sb shell: .sb-new button (IconPlus svg) first, then .sb-search div, .sb-list, .sb-f (note + settings, NO model row)", async () => {
    const c = mountSidebar();
    await act(async () => {});
    const sb = c.querySelector(".sb");
    expect(sb).not.toBeNull();
    // The four citizens, in contract order (produces: .sb > .sb-new +
    // .sb-search + .sb-list + .sb-f).
    expect([...(sb?.children ?? [])].map((k) => k.className)).toEqual(["sb-new", "sb-search", "sb-list", "sb-f"]);
    const newBtn = c.querySelector(".sb-new");
    expect(newBtn?.tagName).toBe("BUTTON");
    expect(newBtn?.querySelector("svg")).not.toBeNull(); // IconPlus
    expect(newBtn?.textContent).toContain("新对话");
    const search = c.querySelector(".sb-search");
    expect(search?.tagName).toBe("DIV");
    expect(search?.querySelector("svg")).not.toBeNull(); // IconSearch
    // ω99-147: 双入口去重——footer 只剩 [Buddy 模式 note][⚙ 设置]，模型
    // 选择器（.sb-model 占位与 .chip.model 下拉）零渲染；模型切换归输入框。
    expect(c.querySelector(".sb-f .sb-model")).toBeNull();
    expect(c.querySelector(".sb-f .chip.model")).toBeNull();
    expect(c.querySelector(".sb-f .sb-note")?.textContent).toBe("Buddy 模式");
    expect(c.querySelector(".sb-f .settings-link")).not.toBeNull();
  });

  it("the selected session row carries .on; the others stay bare", async () => {
    const rows = [
      row({ id: "active-id-0001", name: "当前", mtime: new Date(Date.now() - 60_000).toISOString() }),
      row({ id: "other-id-0002", name: "别的", mtime: new Date(Date.now() - 120_000).toISOString() }),
    ];
    const c = mountSidebar({ client: sessionsClient(rows), activeSessionId: "active-id-0001" });
    await act(async () => {});
    expect(c.querySelector(".sb-i.on")?.textContent).toContain("当前");
    const all = [...c.querySelectorAll(".sb-i")];
    expect(all).toHaveLength(2);
    expect(all.filter((i) => i.classList.contains("on"))).toHaveLength(1);
  });

  // 墨线 T15 终门 — the three-state gate: the row speaks EXACTLY two classes,
  // bare `sb-i` for the un-selected rows and `sb-i on` for the active one (no
  // third state class ever rides the row — the .on suffix is the whole contract).
  it("T15 gate — .sb-i class names: bare row vs `sb-i on` (exact)", async () => {
    const rows = [
      row({ id: "active-id-0001", name: "当前", mtime: new Date(Date.now() - 60_000).toISOString() }),
      row({ id: "other-id-0002", name: "别的", mtime: new Date(Date.now() - 120_000).toISOString() }),
    ];
    const c = mountSidebar({ client: sessionsClient(rows), activeSessionId: "active-id-0001" });
    await act(async () => {});
    // mtime desc → 当前 first; the exact map pins BOTH states at once.
    expect([...c.querySelectorAll(".sb-i")].map((i) => i.className)).toEqual(["sb-i on", "sb-i"]);
  });

  it("rows fold under date-group headers 今天 → 昨天 → 7 天内 → 更早; rows are single-line title + relative time", async () => {
    const rows = [
      row({ id: "today-row-001", mtime: new Date(Date.now() - 5 * 60_000).toISOString() }),
      row({ id: "yesterday-002", mtime: new Date(Date.now() - 30 * 3_600_000).toISOString() }),
      row({ id: "week-row-0003", mtime: new Date(Date.now() - 3 * 86_400_000).toISOString() }),
      row({ id: "old-row-00004", mtime: new Date(Date.now() - 30 * 86_400_000).toISOString() }),
    ];
    const c = mountSidebar({ client: sessionsClient(rows) });
    await act(async () => {});
    expect([...c.querySelectorAll(".sb-g")].map((g) => g.textContent)).toEqual(["今天", "昨天", "7 天内", "更早"]);
    // 墨线 §3 单行截断: the row is title (id8 when unnamed) + time — no preview block.
    const first = c.querySelector(".sb-i");
    expect(first?.querySelector(".sb-t")?.textContent).toBe("today-ro");
    expect(first?.querySelector(".sb-when")?.textContent).toBe("5分钟前");
  });

  it("the search row (click AND Enter) fires onOpenSearch; the footer renders NO model picker even with model props gone", async () => {
    const onOpenSearch = vi.fn();
    const c = mountSidebar({ onOpenSearch });
    await act(async () => {});
    await act(async () => {
      (c.querySelector(".sb-search") as HTMLElement).click();
    });
    expect(onOpenSearch).toHaveBeenCalledTimes(1);
    await act(async () => {
      (c.querySelector(".sb-search") as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(onOpenSearch).toHaveBeenCalledTimes(2); // keyboard parity (a11y)
    // ω99-147: 模型 chips 的 onPickModel(model, provider) 联动两栏钉面随
    // footer 的 ModelSelector 一并退役——模型切换钉面由 composer-chips /
    // model-selector 套件持有（输入框线），侧栏不再有第二个入口。
    expect(c.querySelector(".sb-f .chip.model")).toBeNull();
  });
});

describe("M78-buddy §2 — SessionSidebar", () => {
  it("loads rows from client.sessions() on mount: name-or-id8 title + relative time", async () => {
    const rows = [
      row({ id: "aaaaaaaa-bbbb", name: "修 bug", firstUser: "x".repeat(60), mtime: new Date(Date.now() - 5 * 60_000).toISOString() }),
      row({ id: "ccccdddd-eeee", firstUser: "解释一下这段代码", mtime: new Date(Date.now() - 3 * 3_600_000).toISOString() }),
    ];
    const c = mountSidebar({ client: sessionsClient(rows) });
    await act(async () => {});
    const items = [...c.querySelectorAll(".sb-i")] as HTMLElement[];
    expect(items.length).toBe(2);
    expect(items[0]?.querySelector(".sb-t")?.textContent).toBe("修 bug");
    expect(items[0]?.querySelector(".sb-when")?.textContent).toBe("5分钟前");
    // ω99-147: 无名 → firstUser 首行顶上（「解释一下这段代码」恰 8 字不截）；
    // id8 只剩双空回退，会话列表不再满列会话 ID。
    expect(items[1]?.querySelector(".sb-t")?.textContent).toBe("解释一下这段代码");
    expect(items[1]?.querySelector(".sb-when")?.textContent).toBe("3小时前");
  });

  it("orders by mtime desc and caps the list at 50 rows", async () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      row({ id: `row${String(i).padStart(5, "0")}`, mtime: new Date(1_700_000_000_000 + i).toISOString() }),
    );
    const c = mountSidebar({ client: sessionsClient(rows) });
    await act(async () => {});
    const names = [...c.querySelectorAll(".sb-i .sb-t")].map((n) => n.textContent);
    expect(names.length).toBe(50);
    expect(names[0]).toBe("row00059"); // newest first
    expect(names[49]).toBe("row00010");
  });

  it("marks the active session row; a row click fires onResume(id)", async () => {
    const onResume = vi.fn();
    // Explicit mtimes: the helper's Date.now() default lets two rows created
    // across a millisecond boundary flip the desc sort (a [1]-click then hits
    // the ACTIVE row) — the one flake this suite had under load.
    const rows = [
      row({ id: "active-id-0001", name: "当前", mtime: new Date(Date.now() - 60_000).toISOString() }),
      row({ id: "other-id-0002", name: "别的", mtime: new Date(Date.now() - 120_000).toISOString() }),
    ];
    const c = mountSidebar({ client: sessionsClient(rows), activeSessionId: "active-id-0001", onResume });
    await act(async () => {});
    expect(c.querySelector(".sb-i.on")?.textContent).toContain("当前");
    await act(async () => {
      (c.querySelectorAll(".sb-i")[1] as HTMLElement).click();
    });
    expect(onResume).toHaveBeenCalledWith("other-id-0002");
  });

  it("[+ 新对话] fires onNewChat; the footer carries 设置 (onOpenSettings) and the Buddy 模式 label", async () => {
    const onNewChat = vi.fn();
    const onOpenSettings = vi.fn();
    const c = mountSidebar({ onNewChat, onOpenSettings });
    await act(async () => {});
    await act(async () => {
      (c.querySelector(".sb-new") as HTMLButtonElement).click();
    });
    expect(onNewChat).toHaveBeenCalledTimes(1);
    const settings = c.querySelector(".sb-f .settings-link") as HTMLButtonElement;
    expect(settings).not.toBeNull();
    await act(async () => {
      settings.click();
    });
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(c.querySelector(".sb-f")?.textContent).toContain("Buddy 模式");
  });

  it("relativeTime bucketizes 刚刚/分钟/小时/昨天/天/日期", () => {
    const now = 1_800_000_000_000;
    const iso = (msAgo: number): string => new Date(now - msAgo).toISOString();
    expect(relativeTime(iso(30_000), now)).toBe("刚刚");
    expect(relativeTime(iso(5 * 60_000), now)).toBe("5分钟前");
    expect(relativeTime(iso(3 * 3_600_000), now)).toBe("3小时前");
    expect(relativeTime(iso(30 * 3_600_000), now)).toBe("昨天");
    expect(relativeTime(iso(3 * 86_400_000), now)).toBe("3天前");
    expect(relativeTime(iso(30 * 86_400_000), now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(relativeTime("not-a-date", now)).toBe("");
  });

  it("sessionTitle/sessionPreview derive the row's two text lines", () => {
    // ω99-147: 三级回退的底——name 与 firstUser 双空才落 id8。
    expect(sessionTitle({ id: "abcdefgh-1234", firstUser: "", messages: 0, model: "m", mtime: "" })).toBe("abcdefgh");
    expect(sessionTitle({ id: "x", name: "", firstUser: "", messages: 0, model: "m", mtime: "" })).toBe("x");
    // ω99-147: 有 name 用 name（firstUser 不遮蔽命名）。
    expect(sessionTitle({ id: "abcdefgh-1234", name: "修 bug", firstUser: "别的首句", messages: 0, model: "m", mtime: "" })).toBe("修 bug");
    // ω99-147: 无名有 firstUser → 首行（首个 \n 前、collapse 空白、trim）截 16 字；恰 16 不带 …。
    expect(sessionTitle({ id: "x", name: "", firstUser: "整理  一下\n第二行不算", messages: 0, model: "m", mtime: "" })).toBe("整理 一下");
    expect(sessionTitle({ id: "x", name: "", firstUser: "字".repeat(16), messages: 0, model: "m", mtime: "" })).toBe("字".repeat(16));
    expect(sessionTitle({ id: "x", name: "", firstUser: "字".repeat(17), messages: 0, model: "m", mtime: "" })).toBe(`${"字".repeat(16)}…`);
    // ω99-147: 行 tooltip = 完整首行截 120（sessionTitle 的 16 字截断只管行文本）。
    expect(sessionTitleTip({ id: "x", name: "", firstUser: `${"长".repeat(121)}\n尾行`, messages: 0, model: "m", mtime: "" })).toBe(`${"长".repeat(120)}…`);
    expect(sessionTitleTip({ id: "x", name: "命名", firstUser: "首句", messages: 0, model: "m", mtime: "" })).toBe("命名");
    expect(sessionPreview({ id: "x", name: "n", firstUser: "y".repeat(45), messages: 0, model: "m", mtime: "" })).toBe(`${"y".repeat(40)}…`);
    expect(sessionPreview({ id: "x", firstUser: "短的", messages: 0, model: "m", mtime: "" })).toBe("短的");
    expect(sessionPreview({ id: "x", firstUser: "", messages: 0, model: "m", mtime: "" })).toBe("(新会话)");
  });

  // ui-review-r1 I5: 0 sessions and a FAILED load get their own centered
  // empty states (the tree-empty idiom) — not a blank column.
  // ω99-243: #5 — census 同形演进：失败态从裸「加载失败」升为 FileTree 同款
  // 「加载失败 · 点击重试」行（tree-err + role=button；重取行为与骨架回位由
  // omega99-243-visual-refinement S2 钉）。先红取证 /tmp/o243-census-red.log。
  it("0 sessions shows 暂无会话; a failed sessions() shows 加载失败 · 点击重试", async () => {
    const empty = mountSidebar();
    await act(async () => {});
    expect(empty.querySelector(".sb-list .tree-empty")?.textContent).toBe("暂无会话");

    const failing = { sessions: vi.fn(() => Promise.reject(new Error("boom"))) };
    const fail = mountSidebar({ client: failing });
    await act(async () => {});
    expect(fail.querySelector(".sb-list .tree-err")?.textContent).toBe("加载失败 · 点击重试");
  });
});

// ---------------------------------------------------------------------------
// ω99-150 — Slice 1b: 行内重命名（hover ✎ → 既有 /rename 车道）.
// ---------------------------------------------------------------------------
/* ω99-150: rename unit pins — ✎ 在位（每行恰一）、点击入编辑+Enter 逐字提交、
   Esc/blur/空串弃、49 字前置拒不外呼（= cli SESSION_NAME_MAX_CHARS）、
   sessionsEpoch 重取（refreshEpoch 范式，FileViewer historyEpoch 同款）。 */
describe("ω99-150 — SessionSidebar 行内重命名", () => {
  it("✎ rides every row exactly once — named and unnamed alike; a lane-less mount renders none (props 增量可选，零漂移)", async () => {
    const rows = [
      row({ id: "named-row-001", name: "修 bug", mtime: new Date(Date.now() - 60_000).toISOString() }),
      row({ id: "plain-row-002", firstUser: "解释一下这段代码" }),
    ];
    const c = mountSidebar({ client: sessionsClient(rows), onRenameSession: () => {} });
    await act(async () => {});
    const items = [...c.querySelectorAll(".sb-i")];
    expect(items).toHaveLength(2);
    // 每行恰一 ✎——有名/无名行同款（无名行 = 从空起名）。
    for (const item of items) expect(item.querySelectorAll(".sb-rename")).toHaveLength(1);
    // 无 lane 的挂载零 ✎：既有套件的 DOM 一字不差（props 增量可选）。
    const bare = mountSidebar({ client: sessionsClient(rows) });
    await act(async () => {});
    expect(bare.querySelectorAll(".sb-rename")).toHaveLength(0);
  });

  it("✎ → inline editor (input replaces the title/time), prefilled with the raw name; Enter submits onRenameSession(id, name) verbatim and exits — onResume stays silent", async () => {
    const onRenameSession = vi.fn();
    const onResume = vi.fn();
    const rows = [row({ id: "rename-row-001", name: "旧名" })];
    const c = mountSidebar({ client: sessionsClient(rows), onRenameSession, onResume });
    await act(async () => {});
    await act(async () => {
      (c.querySelector(".sb-rename") as HTMLElement).click();
    });
    expect(onResume).not.toHaveBeenCalled(); // ✎ 的 click 不顺带 resume
    const input = c.querySelector("input.sb-rename-in") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("旧名"); // 预填 raw name（空则空——非三级标题回退）
    // 编辑态行内只有 input——标题/时间让位。
    expect(c.querySelector(".sb-t")).toBeNull();
    expect(c.querySelector(".sb-when")).toBeNull();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(input, "  新名  ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    // 逐字钉：id + trimmed name（trim 归 submit 侧）。
    expect(onRenameSession).toHaveBeenCalledTimes(1);
    expect(onRenameSession).toHaveBeenCalledWith("rename-row-001", "新名");
    // 退出编辑态：行回到标题形态。
    expect(c.querySelector("input.sb-rename-in")).toBeNull();
    expect(c.querySelector(".sb-t")).not.toBeNull();
  });

  it("Esc / blur / 空串 Enter all discard — onRenameSession never fires, the row restores", async () => {
    const onRenameSession = vi.fn();
    const rows = [row({ id: "esc-row-000001", name: "原名" })];
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    // Esc 弃。
    const c1 = mountSidebar({ client: sessionsClient(rows), onRenameSession });
    await act(async () => {});
    await act(async () => {
      (c1.querySelector(".sb-rename") as HTMLElement).click();
    });
    let input = c1.querySelector("input.sb-rename-in") as HTMLInputElement;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(c1.querySelector("input.sb-rename-in")).toBeNull();
    // blur 弃（简单语义，无延迟）。
    const c2 = mountSidebar({ client: sessionsClient(rows), onRenameSession });
    await act(async () => {});
    await act(async () => {
      (c2.querySelector(".sb-rename") as HTMLElement).click();
    });
    input = c2.querySelector("input.sb-rename-in") as HTMLInputElement;
    await act(async () => {
      input.focus();
      input.blur();
    });
    expect(c2.querySelector("input.sb-rename-in")).toBeNull();
    // 空串 Enter = 弃（不提空名——driver 侧同值会拒）。
    const c3 = mountSidebar({ client: sessionsClient(rows), onRenameSession });
    await act(async () => {});
    await act(async () => {
      (c3.querySelector(".sb-rename") as HTMLElement).click();
    });
    input = c3.querySelector("input.sb-rename-in") as HTMLInputElement;
    await act(async () => {
      setter?.call(input, "   ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(c3.querySelector("input.sb-rename-in")).toBeNull();
    expect(onRenameSession).not.toHaveBeenCalled();
  });

  it("49 字 Enter 拒不外呼（title 提示「最多 48 字」+ --warn 警示边）；就地收到 48 字内放行", async () => {
    const onRenameSession = vi.fn();
    const rows = [row({ id: "long-row-000001" })];
    const c = mountSidebar({ client: sessionsClient(rows), onRenameSession });
    await act(async () => {});
    await act(async () => {
      (c.querySelector(".sb-rename") as HTMLElement).click();
    });
    const input = c.querySelector("input.sb-rename-in") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(input, "名".repeat(49));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onRenameSession).not.toHaveBeenCalled(); // 前置省一趟（driver 同值会拒）
    expect(input.title).toBe("最多 48 字"); // 超长提示留在行内，不出车道
    /* 边框警示（inline borderColor: var(--warn)，同条件）不在 jsdom 断言：
       jsdom 的 cssstyle 在 set 时整体丢弃 var() 值（实测 attr=null）——同一
       超限条件的 title 已钉住警示逻辑；真机观感归 62 号债。 */
    // 编辑态保留（用户可就地缩短），收到 48 字放行。
    expect(c.querySelector("input.sb-rename-in")).not.toBeNull();
    await act(async () => {
      setter?.call(input, "名".repeat(48));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onRenameSession).toHaveBeenCalledWith("long-row-000001", "名".repeat(48));
  });

  it("sessionsEpoch 变化触发 sessions 重取（refreshEpoch 范式）——mount + bump = 两次 load，同 epoch 重渲染不重取", async () => {
    const sessions = vi.fn(() => Promise.resolve([row({ id: "epoch-row-00001", name: "改名后" })]));
    const base = {
      client: { sessions },
      activeSessionId: null as string | null,
      onResume: () => {},
      onNewChat: () => {},
      onOpenSettings: () => {},
      onOpenSearch: () => {},
      onRenameSession: () => {},
    };
    mount(<SessionSidebar {...base} sessionsEpoch={0} />);
    await act(async () => {});
    expect(sessions).toHaveBeenCalledTimes(1);
    // 同 epoch 的重渲染（时间 tick 等）不重取。
    act(() => {
      root?.render(<SessionSidebar {...base} sessionsEpoch={0} />);
    });
    expect(sessions).toHaveBeenCalledTimes(1);
    // bump → 重取（web 无 rename 推送事件——侧栏自带刷新）。
    act(() => {
      root?.render(<SessionSidebar {...base} sessionsEpoch={1} />);
    });
    await act(async () => {});
    expect(sessions).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Slice 2 — the App's buddy branch.
// ---------------------------------------------------------------------------
interface AppHarness {
  container: HTMLElement;
  client: WudaoClient;
  server: FakeServer;
}

function mountedApp(): AppHarness {
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
  return { container, client, server };
}

type OpFrame = { id: number; op: Record<string, unknown> };
const opFrames = (h: AppHarness): OpFrame[] =>
  h.server.clientFrames().filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f);

/** Reply to the app's settingsStatus fetch (op 2 on the wire, after
 *  listSlashCommands). */
async function replySettings(h: AppHarness, uiDefaultMode: "simple" | "buddy" | "advanced" | null): Promise<void> {
  await act(async () => {
    const op = opFrames(h).find((o) => o.op.op === "settingsStatus");
    h.server.socket.serverSend({
      t: "result",
      id: op?.id,
      ok: { settings: { memoryEnabled: true, uiDefaultMode } },
    });
  });
}

/** Answer the LATEST sessions fetch with rows (the sidebar loads on mount;
 *  the picker re-requests on open — later tests answer the second one). */
async function replySessions(h: AppHarness, rows: readonly SessionRow[]): Promise<void> {
  await act(async () => {
    const op = opFrames(h).filter((o) => o.op.op === "sessions").at(-1);
    h.server.socket.serverSend({ t: "result", id: op?.id, ok: rows });
  });
}

describe("M78-buddy §1/§3 — the App's buddy branch", () => {
  it("ui.defaultMode=buddy resolves to the two-panel shell: sidebar + chat column + composer + STATUSBAR", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    // ω99-224 演进: the buddy statusline is the workspace-led variant — the
    // strip's leading segment now needs the connect-time agentRootStatus
    // reply (the authOk default carries no board/bg/sidecar either, so
    // without a workspace the buddy chain has no segments and omits
    // entirely, the strip's own discipline). Pin evolved from the bare
    // non-null to the workspace-led shape (the App-seam wiring of the
    // variant's props).
    await act(async () => {
      const op = opFrames(h).find((o) => o.op.op === "agentRootStatus");
      h.server.socket.serverSend({
        t: "result",
        id: op?.id,
        ok: { panelRoot: "/Users/u/work/proj-x", agentRoot: "/Users/u/work/proj-x", aligned: true },
      });
    });
    await replySettings(h, "buddy");
    expect(h.container.querySelector(".buddy")).not.toBeNull();
    expect(h.container.querySelector(".sb")).not.toBeNull();
    expect(h.container.querySelector(".buddy .chat")).not.toBeNull(); // the right column
    expect(h.container.querySelector("textarea.wudao-input")).not.toBeNull(); // the composer
    const bar = h.container.querySelector(".statusline");
    expect(bar).not.toBeNull(); // buddy KEEPS the statusline (spec §3)
    expect(bar?.firstElementChild?.textContent).toBe("工作区 proj-x"); // ω99-224: the trust anchor leads
    expect(bar?.textContent).not.toContain("模式"); // the redundant segments are gone on this face
    // No IDE panels leak into the buddy shell (spec §3: 无文件树/文件预览).
    expect(h.container.querySelector(".filetree")).toBeNull();
    expect(h.container.querySelector(".fileviewer")).toBeNull();
    expect(h.container.querySelector(".tabbar")).toBeNull();
  });

  // ω99-276: #5 — buddy 新对话直通（用户令 09-11「开新会话直接切到新的空
  // 会话窗口，旧的随时历史切回」）：旧 ClearConfirm（清空/保留二选一）退役
  // ——点按即 submit('/clear')（driver 轮转 session id=全新会话），收据换成
  // 「已开启新会话」叙事。确认弹窗只留给显式 /clear（components.test 在案）。
  it("[+ 新对话] starts the new chat DIRECTLY (no confirm modal; /clear out at once; the fresh-session receipt)", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, {}, [{ kind: "user", text: "旧消息" }]);
    });
    await replySettings(h, "buddy");
    await replySessions(h, [row({ id: "wudao-test-0001", name: "当前会话" })]);
    await act(async () => {
      (h.container.querySelector(".sb-new") as HTMLButtonElement).click();
    });
    expect(h.container.querySelector(".modal-card")).toBeNull(); // NO confirm anymore — the whole point
    const clearOp = opFrames(h).find((o) => o.op.op === "submit" && o.op.text === "/clear");
    expect(clearOp).toBeDefined(); // …and the op went out on the click itself
    await act(async () => {
      h.server.socket.serverSend({ t: "result", id: clearOp?.id, ok: "frontend" });
    });
    expect(h.container.textContent).not.toContain("旧消息");
    expect(h.container.textContent).toContain("已开启新会话"); // the new-session receipt
    expect(h.container.textContent).toContain("原会话已保留在列表"); // …and it says the old one is switch-back-able
  });

  // ω99-276（续，标记见上）— busy 拒绝仍在（运行中不许轮转会话），措辞换
  // 新对话叙事。
  it("[+ 新对话] while busy refuses with the new-chat wording (no modal, no /clear op)", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, { busy: true }, [{ kind: "user", text: "旧消息" }]);
    });
    await replySettings(h, "buddy");
    await replySessions(h, [row({ id: "wudao-test-0001", name: "当前会话" })]);
    await act(async () => {
      (h.container.querySelector(".sb-new") as HTMLButtonElement).click();
    });
    expect(h.container.querySelector(".modal-card")).toBeNull();
    expect(opFrames(h).find((o) => o.op.op === "submit" && o.op.text === "/clear")).toBeUndefined();
    expect(h.container.textContent).toContain("⚠️ 任务进行中，稍后再开新对话");
  });

  // ω99-276（续，标记见上）③ — 系统消息的代换清理（用户令 09-11「系统消息
  // 只打到当前激活的会话中，切换会话之后就应该清理了，展示会话的历史」）：
  // 切换会话=reset:true 整替（historyEpoch 一跳）。旧代的本地回执（busy 拒令
  // 等系统消息）不得跨代存活——曾经「停在末尾」地留在新会话转录里，切几个
  // 会话堆几层（用户看到的「主界面…一直都在，非常凌乱」）。收据：切换后
  // 视图=目标会话的历史，旧会话消息与旧代系统消息全清。
  it("a session switch RESETS the view: the target history shows, the old session's messages AND its generation's notices are gone", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, { busy: true }, [{ kind: "user", text: "旧会话消息" }]);
    });
    await replySettings(h, "buddy");
    await replySessions(h, [row({ id: "resume-target-1", name: "目标会话" })]);
    // Seed an old-generation notice: the busy refusal (visible pre-switch).
    await act(async () => {
      (h.container.querySelector(".sb-new") as HTMLButtonElement).click();
    });
    expect(h.container.textContent).toContain("稍后再开新对话");
    // Unbusy (a FULL state frame — a bare one REPLACES the status wholesale),
    // then switch: row click → resume op → the driver's reset:true replay.
    await act(async () => {
      h.server.socket.serverSend({
        t: "state",
        state: {
          live: { reasoning: "", answer: "", busyTools: [] },
          busy: false,
          queued: [],
          boardProgress: null,
          ctxTokens: null,
          mode: "workspace",
          cachePercent: null,
          bg: { active: 0, spawned: 0 },
          pendingPermission: null,
          planBoard: null,
          sessionId: "resume-target-1",
          sidecar: null,
        },
      });
    });
    await act(async () => {
      (h.container.querySelector(".sb-i") as HTMLElement).click();
    });
    const op = opFrames(h).find((o) => o.op.op === "resume");
    expect(op?.op).toMatchObject({ id: "resume-target-1" });
    await act(async () => {
      h.server.socket.serverSend({ t: "history", entries: [{ kind: "user", text: "目标会话的消息" }], reset: true });
    });
    await act(async () => {
      h.server.socket.serverSend({ t: "result", id: op?.id, ok: { ok: true } });
    });
    // The view IS the target session's transcript — nothing of the old one.
    expect(h.container.textContent).toContain("目标会话的消息");
    expect(h.container.textContent).not.toContain("旧会话消息");
    // The old generation's system message died with the switch (the epoch wipe).
    expect(h.container.textContent).not.toContain("稍后再开新对话");
  });

  it("a sidebar row click rides the resume op", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await replySettings(h, "buddy");
    await replySessions(h, [row({ id: "resume-target-1", name: "目标会话" })]);
    await act(async () => {
      (h.container.querySelector(".sb-i") as HTMLElement).click();
    });
    const op = opFrames(h).find((o) => o.op.op === "resume");
    expect(op?.op).toMatchObject({ id: "resume-target-1" });
  });

  // T8 墨线 §3: the compact search row rides the 📋 session picker's EXACT
  // lane — the busy refusal notice, then the picker over the rows load.
  it("the .sb-search row opens the session picker (busy guard first), a pick rides resume", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, { busy: true });
    });
    await replySettings(h, "buddy");
    await act(async () => {
      (h.container.querySelector(".sb-search") as HTMLElement).click();
    });
    expect(h.container.querySelector(".search-pop")).toBeNull(); // refused
    expect(h.container.textContent).toContain("运行中无法 切换会话（任务进行中）");
    await act(async () => {
      // A full state frame (a bare one REPLACES the status wholesale).
      h.server.socket.serverSend({
        t: "state",
        state: {
          live: { reasoning: "", answer: "", busyTools: [] },
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
        },
      });
    });
    await act(async () => {
      (h.container.querySelector(".sb-search") as HTMLElement).click();
    });
    await replySessions(h, [row({ id: "pick-target-001", name: "搜索目标" })]);
    expect(h.container.querySelector(".search-pop")).not.toBeNull(); // the picker is up
    await act(async () => {
      (h.container.querySelector(".search-pop .search-item") as HTMLElement).click();
    });
    const op = opFrames(h).find((o) => o.op.op === "resume");
    expect(op?.op).toMatchObject({ id: "pick-target-001" });
  });

  // T8 墨线 §3 → ω99-147: the footer's model row is RETIRED — the user's
  // 双入口 report (sidebar footer + composer chips both switch models). The
  // /model lane itself is untouched: the composer's ModelSelector (chatColumn
  // InputBox, pinned by composer-chips/model-selector suites) carries it.
  it("ω99-147: the .sb-f holds NO model picker even with a live model; settings + note stay", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, {
        model: {
          label: "glm-5",
          provider: "zhipu",
          choices: [
            { provider: "zhipu", model: "glm-5", source: "registry" },
            { provider: "zhipu", model: "glm-5-air", source: "registry" },
          ],
        },
      });
    });
    await replySettings(h, "buddy");
    // 侧栏 footer 干净（有活模型也不渲染模型行）；模型切换入口在输入框下
    // 的 chips（同 fixture 的 composer 已拿到 status.model——此处只钉侧栏无双入口）。
    expect(h.container.querySelector(".sb-f .chip.model")).toBeNull();
    expect(h.container.querySelector(".sb-f .sb-model")).toBeNull();
    expect(h.container.querySelector(".sb-f .sb-note")?.textContent).toBe("Buddy 模式");
    expect(h.container.querySelector(".sb-f .settings-link")).not.toBeNull();
  });

  it("the sidebar collapse toggle zeroes the left column", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await replySettings(h, "buddy");
    const grid = h.container.querySelector(".buddy") as HTMLElement;
    expect(grid.style.getPropertyValue("--buddy-w")).toBe("260px");
    await act(async () => {
      (h.container.querySelector(".buddy-toggle") as HTMLButtonElement).click();
    });
    expect(grid.style.getPropertyValue("--buddy-w")).toBe("0px");
    expect(h.container.querySelector(".sb")).toBeNull();
  });

  it("REGRESSION: simple and advanced never render the sidebar", async () => {
    const simple = mountedApp();
    await act(async () => {
      authOk(simple.server.socket);
    });
    await replySettings(simple, "simple");
    expect(simple.container.querySelector(".sb")).toBeNull();
    expect(simple.container.querySelector(".buddy")).toBeNull();

    const advanced = mountedApp();
    await act(async () => {
      authOk(advanced.server.socket);
    });
    await replySettings(advanced, null);
    expect(advanced.container.querySelector(".sb")).toBeNull();
    expect(advanced.container.querySelector(".buddy")).toBeNull();
    expect(advanced.container.querySelector(".ide")).not.toBeNull();
  });

  // ui-review-r1 I5: a fresh BUDDY session shows the empty hero in the chat
  // column (the shared chatColumn renders it), not a blank column.
  it("empty history in the buddy shell renders the EmptyHero", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await replySettings(h, "buddy");
    await replySessions(h, [row({ id: "wudao-test-0001" })]);
    const hero = h.container.querySelector(".buddy-main .hero");
    expect(hero).not.toBeNull();
    expect(hero?.querySelector("h1")?.textContent).toContain("你好呀，我是悟道Harness"); // ω99-167: hero 换自我介绍
    // A real turn flips it off.
    await act(async () => {
      h.server.socket.serverSend({ t: "history", entries: [{ kind: "user", text: "hi" }], reset: false });
    });
    expect(h.container.querySelector(".hero")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Slice 3 — the settings channel: the third chip.
// ---------------------------------------------------------------------------
describe("M78-buddy §4 — the settings channel", () => {
  it("the 偏好 section shows the third 「Buddy 模式」 chip; clicking it writes ui.defaultMode=buddy", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await replySettings(h, "advanced");
    await act(async () => {
      (h.container.querySelector(".topbar button[aria-label='设置']") as HTMLButtonElement).click();
    });
    // settings-split: the 默认界面 chips ride the 偏好 tab — route through it.
    await act(async () => {
      (h.container.querySelector("button[data-settings-tab='preferences']") as HTMLButtonElement).click();
    });
    const chips = [...h.container.querySelectorAll("button[data-default-mode]")] as HTMLButtonElement[];
    const labels = chips.map((b) => b.textContent);
    // 顺序: 简洁模式 → Buddy 模式 → 高级模式 (spec §4: buddy 在简洁与高级之间).
    expect(labels).toEqual(["简洁模式", "Buddy 模式", "高级模式"]);
    await act(async () => {
      (chips.find((b) => b.textContent === "Buddy 模式") as HTMLButtonElement).click();
    });
    const op = opFrames(h).find((o) => o.op.op === "settingsSet" && o.op.key === "ui.defaultMode");
    expect(op?.op).toMatchObject({ value: "buddy" });
  });
});
