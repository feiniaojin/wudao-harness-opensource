// ω99-277: #14 — SessionPicker 增 onSearch prop（全文搜索车道）；本件的单元挂载以空命中 stub（这些套件钉的是列表车道）。
// The 📋 session picker's row ORDER. The sessions op returns mtime-ASC —
// store.list() sorts oldest-first by design (for --continue), and nothing in
// driver/server flips it (the TUI's /resume picker does its own
// .slice(-10).reverse() on top). M76-ux2's spec is 时间倒序前 20 条, but the
// original picker trusted a comment claiming "the sessions op already returns
// mtime-desc" and did rows.slice(0, 20) — with >20 stored sessions that
// showed the 20 OLDEST and the recent ones never made the list (the bug
// report: 右上角切换会话弹框里看不到最近的会话).
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SessionPicker } from "../src/components/App.js";
import type { SessionRow } from "../src/protocol.js";

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
});

const row = (id: string, minutesSinceEpochStart: number): SessionRow => ({
  id,
  mtime: new Date(Date.UTC(2026, 7, 1) + minutesSinceEpochStart * 60_000).toISOString(),
  messages: 1,
  firstUser: `msg ${id}`,
  model: "",
});

// 25 rows, mtime-ASC — exactly the shape the op delivers over the wire.
const rows: SessionRow[] = Array.from({ length: 25 }, (_, i) =>
  row(`s${String(i).padStart(2, "0")}`, i),
);

describe("SessionPicker row order (the sessions op is mtime-ASC)", () => {
  it("renders the NEWEST session first (时间倒序)", () => {
    const c = mount(<SessionPicker rows={rows} onPick={vi.fn()} onClose={vi.fn()} onSearch={vi.fn(async () => [])} />);
    const items = c.querySelectorAll<HTMLElement>(".session-item");
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]?.dataset.id).toBe("s24");
  });

  it("the 20-row cap keeps the NEWEST 20 — the oldest 5 drop, the newest stays", () => {
    const c = mount(<SessionPicker rows={rows} onPick={vi.fn()} onClose={vi.fn()} onSearch={vi.fn(async () => [])} />);
    const ids = [...c.querySelectorAll<HTMLElement>(".session-item")].map((el) => el.dataset.id);
    expect(ids).toHaveLength(20);
    expect(ids).toContain("s24");
    expect(ids).toContain("s05");
    expect(ids).not.toContain("s00");
    expect(ids).not.toContain("s04");
  });

  it("Enter on the initial cursor resumes the NEWEST session (sel starts at the top row)", () => {
    const onPick = vi.fn();
    const c = mount(<SessionPicker rows={rows} onPick={onPick} onClose={vi.fn()} onSearch={vi.fn(async () => [])} />);
    const pop = c.querySelector<HTMLDivElement>(".search-pop");
    act(() => {
      pop?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(onPick).toHaveBeenCalledWith("s24");
  });
});
