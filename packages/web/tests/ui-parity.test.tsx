// @vitest-environment jsdom
// ui-parity (2026-08-25 task brief) — the three acceptance lanes, pinned:
//   A. the popup family's VIEWPORT CAPS: .scrim/.modal-card/.menu.ctx/
//      .permission-card all carry a max-height inside 100dvh, and every cap's
//      scroll region NEVER contains the answer buttons (they stay reachable).
//      (ω99-301: the legacy .modal twin retired — ONE family, ONE cap pin.)
//   B. the advanced session's mockup parity: the tool card (.toolcard) rides
//      the `.act` paradigm (bordered card + clickable status-colored head +
//      capped mono body + err variant), the toolgroup wears the same chrome,
//      the composer chips are the quiet pills, the transient reconnect notice
//      is the secondary strip, and the topbar carries exactly ONE theme
//      button.
//   C. the permission card's .approval tokens (strip label / mono cmd block
//      capped at 76px / pill buttons outside the scroll region) + the
//      no-scrim audit over every ask path.
// Same seams as the other visual suites: the sheet mounted for the CSSOM
// decl() pins, the raw text for source-level audits.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import "../src/styles.css";
import "../src/tokens.css";
import { App } from "../src/components/App.js";
import { WudaoClient } from "../src/protocol.js";
import { PermissionModal } from "../src/components/PermissionModal.js";
import { SimpleApprovalCard } from "../src/components/SimpleApprovalCard.js";
import { AskUserCards } from "../src/components/AskUserCards.js";
import { HistoryItem, HistoryList } from "../src/components/HistoryList.js";
import { fakeServer, authOk } from "./mock-ws.js";
import type { FakeServer } from "./mock-ws.js";
import { decl, mount, prop, unmount } from "./css-test-utils.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The viewport cap every popup shares: 100dvh minus the scrim insets. */
const Dvh_CAP = "calc(100dvh - var(--sp-8))";

/** The one ask both shells render (the brief's mockup example). */
const ASK = {
  toolName: "shell",
  summary: "运行测试以验证修复",
  input: { command: "pnpm --filter app test -- Login.test.tsx" },
};

afterEach(() => {
  unmount();
  window.localStorage.removeItem("wudao.ui.v1");
});

/** The full App on a fake socket (components.test's harness, trimmed). */
function mountedApp(): { container: HTMLElement; server: FakeServer } {
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
  return { container, server };
}

// ---------------------------------------------------------------------------
// A — the popup family's viewport caps (弹框文本多时整屏放不下).
// ---------------------------------------------------------------------------
describe("ui-parity A — popup family viewport caps", () => {
  it("the scrim breathes (--sp-4 inset) so a capped card never kisses the edge", () => {
    expect(decl(".scrim", "padding")).toBe("var(--sp-4)");
  });

  it(".modal-card / .menu.ctx / .permission-card cap inside 100dvh (ω99-301: the family is ONE)", () => {
    expect(decl(".modal-card", "max-height")).toBe(Dvh_CAP);
    expect(decl(".permission-card", "max-height")).toBe(Dvh_CAP);
  });

  it("ω99-301: the legacy .overlay/.modal rules are gone — the sheet speaks ONE modal vocabulary", () => {
    // Selector scan: no rule mentions the retired pair (the scrim/modal-card
    // family below owns every popup).
    const selectors = new Set<string>();
    for (const sheet of [...document.styleSheets] as CSSStyleSheet[]) {
      for (const rule of [...sheet.cssRules]) {
        if (rule instanceof CSSStyleRule) selectors.add(rule.selectorText);
      }
    }
    const legacy = [...selectors].filter((s) => /(^|[\s,])\.modal([\s,:{.]|$)/.test(s) || /(^|[\s,])\.overlay([\s,:{.]|$)/.test(s));
    expect(legacy).toEqual([]);
  });

  it("fix round 2 M2 — the ctx menu's anchor is clamped into the viewport on both axes", () => {
    // The menu's own height cap is the SAME constant the top clamp
    // subtracts — a menu opened at the clamped top can never overshoot the
    // bottom edge; longer menus scroll inside the cap.
    // ui-sweep N3 re-pin: the LEFT axis now subtracts the menu's own WIDTH
    // var (--ctx-w, pinned by min-width/max-width below) instead of borrowing
    // the height cap as a width proxy — a wide menu flush to the right edge
    // can no longer overshoot 100vw.
    expect(decl(".menu.ctx", "max-height")).toBe("var(--ctx-cap)");
    expect(decl(".menu.ctx", "overflow-y")).toBe("auto");
    expect(decl(".menu.ctx", "top")).toBe("min(var(--ctx-y, 0px), calc(100dvh - var(--ctx-cap) - var(--sp-4)))");
    expect(decl(".menu.ctx", "left")).toBe("min(var(--ctx-x, 0px), calc(100vw - var(--ctx-w) - var(--sp-4)))");
  });

  it("fix round 2 M1 — the permission card's scroll region is an overflow rule, not just a div", () => {
    expect(decl(".permission-card .pc-scroll", "overflow-y")).toBe("auto");
  });

  it("the ask-user option list is the modal-card's scroll region (btnrow outside)", () => {
    expect(decl(".optioncards", "overflow-y")).toBe("auto");
    const c = mount(
      <AskUserCards
        question="怎么办"
        options={Array.from({ length: 30 }, (_, i) => ({ label: `选项 ${i + 1}` }))}
        onAnswer={() => {}}
        onDismiss={() => {}}
      />,
    );
    const list = c.querySelector(".optioncards") as HTMLElement;
    const btns = c.querySelector(".modal-card .btnrow") as HTMLElement;
    expect(list).not.toBeNull();
    expect(btns).not.toBeNull();
    expect(list.contains(btns)).toBe(false);
  });

  it("the permission card's scroll region carries the long content; the answers sit outside it", () => {
    const ask = {
      toolName: "shell",
      summary: "跑测试".repeat(120),
      input: { command: "pnpm t" },
    };
    const c = mount(<PermissionModal ask={ask} onChoose={() => {}} />);
    const scroll = c.querySelector(".permission-card .pc-scroll") as HTMLElement;
    const btns = c.querySelector(".permission-card .btnrow") as HTMLElement;
    expect(scroll).not.toBeNull();
    expect(btns).not.toBeNull();
    expect(scroll.contains(btns)).toBe(false);
    // The headline (the long summary wall) rides INSIDE the scroll region.
    expect(scroll.textContent).toContain("跑测试");
  });
});

// ---------------------------------------------------------------------------
// B — the advanced tool card on the `.act` paradigm + the shell chrome.
// ---------------------------------------------------------------------------
describe("ui-parity B — the advanced tool card (.act paradigm)", () => {
  it("the card chrome: --surface fill, hairline edge, --radius-md, clipped", () => {
    expect(decl(".toolcard", "background")).toBe("var(--surface)");
    expect(decl(".toolcard", "border-color")).toBe("var(--hair-1)");
    expect(decl(".toolcard", "border-radius")).toBe("var(--radius-md)");
    expect(decl(".toolcard", "overflow")).toBe("hidden");
  });

  it("the head is a BUTTON row: status-colored mark + name + params + chevron; the text contract holds", () => {
    const c = mount(
      <HistoryItem entry={{ kind: "tool", name: "read_file", summary: "src/a.ts", resultPreview: "ok" }} />,
    );
    const card = c.querySelector(".toolcard") as HTMLElement;
    expect(card.getAttribute("data-status")).toBe("ok");
    const head = c.querySelector(".toolcard .head") as HTMLButtonElement;
    expect(head.tagName).toBe("BUTTON");
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(head.textContent).toContain("✓ read_file(src/a.ts)"); // fix round 1: the mockup-v2 glyph set
    expect(c.querySelector(".toolcard .chev")?.textContent).toBe("▾");
  });

  it("data-status drives the mark color: ok green / run accent / err danger", () => {
    expect(decl('.toolcard[data-status="ok"] .mark', "color")).toBe("var(--ok)");
    expect(decl('.toolcard[data-status="run"] .mark', "color")).toBe("var(--accent)");
    expect(decl('.toolcard[data-status="err"] .mark', "color")).toBe("var(--danger)");
    // fix round 2 (M3): the status rides the entry's COMPLETED state — a
    // history tool entry is committed by definition (live tools render in
    // LiveArea), so a completed entry with an EMPTY resultPreview is ✓ ok,
    // never ◐ run. The run derivation stays for the CSS contract only.
    const done = mount(<HistoryItem entry={{ kind: "tool", name: "shell", summary: "npm t" }} />);
    expect(done.querySelector(".toolcard")?.getAttribute("data-status")).toBe("ok");
    expect(done.querySelector(".toolcard .mark")?.textContent).toBe("✓ ");
    // fix round 1: the mockup-v2 GLYPHS — ✓ ok / ◐ run / ✕ err (the inkline
    // ⏺/⏹ text marks retired by the coordinator ruling).
    expect(decl('.toolcard[data-status="run"] .mark', "color")).toBe("var(--accent)");
  });

  it("clicking the head folds/unfolds the body (default open — the historical surface)", () => {
    const c = mount(
      <HistoryItem entry={{ kind: "tool", name: "shell", summary: "npm t", resultPreview: "done" }} />,
    );
    const head = c.querySelector(".toolcard .head") as HTMLButtonElement;
    expect(c.querySelector(".toolcard .result")).not.toBeNull();
    act(() => {
      head.dispatchEvent(new Event("click", { bubbles: true }));
    });
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(c.querySelector(".toolcard .chev")?.textContent).toBe("▸");
    expect(c.querySelector(".toolcard .result")).toBeNull();
    act(() => {
      head.dispatchEvent(new Event("click", { bubbles: true }));
    });
    expect(c.querySelector(".toolcard .result")).not.toBeNull();
  });

  it("the body is the capped mono result region: 132px ceiling, internal scroll", () => {
    expect(decl(".toolcard .result", "max-height")).toBe("132px");
    expect(decl(".toolcard .result", "overflow-y")).toBe("auto");
    expect(decl(".toolcard .result", "font-family")).toBe("var(--mono)");
  });

  it("the err variant: danger border + danger head (reads without expanding)", () => {
    expect(decl(".toolcard.err", "border-color")).toBe("rgb(var(--danger-rgb) / .4)");
    const c = mount(
      <HistoryItem entry={{ kind: "tool", name: "shell", summary: "npm t", isError: true, resultPreview: "boom" }} />,
    );
    const card = c.querySelector(".toolcard") as HTMLElement;
    expect(card.classList.contains("err")).toBe(true);
    expect(card.getAttribute("data-status")).toBe("err");
    expect(card.querySelector(".mark")?.textContent).toBe("✕ ");
    expect(card.textContent).toContain("✕ shell(npm t)");
    expect(card.textContent).toContain("↳ [error]");
  });

  it("the toolgroup wears the same card chrome; expanded members ride the hairline list inside it", () => {
    const read = (path: string) => ({ kind: "tool" as const, name: "read_file", summary: path, resultPreview: `${path}:1` });
    const c = mount(<HistoryList history={[read("a"), read("b"), read("c")]} />);
    const head = c.querySelector(".toolgroup .grp-head") as HTMLButtonElement;
    act(() => {
      head.dispatchEvent(new Event("click", { bubbles: true }));
    });
    // The group card chrome (one bordered surface, not a nest of cards)…
    expect(decl(".toolgroup", "background")).toBe("var(--surface)");
    expect(decl(".toolgroup", "border-color")).toBe("var(--hair-1)");
    expect(decl(".toolgroup", "border-radius")).toBe("var(--radius-md)");
    // …and the member chrome yields to the list seams inside it.
    expect(decl(".toolgroup .toolcard", "border-width")).toBe("0");
    expect(c.querySelectorAll(".toolgroup .toolcard")).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// B — the shell chrome: quiet chips, quiet reconnect strip, one theme button.
// ---------------------------------------------------------------------------
describe("ui-parity B — shell chrome", () => {
  it("the composer is the 119 input-card: --radius-md + elevation 中档 (116 弧 A), border retired", () => {
    // 119 用户反馈修正（圆角统一）：输入条从 22px 胶囊归卡片族 8px——全站
    // 只剩 sm 6 / md 8 / lg 12 一套 scale（胶囊帽与复合角是「不统一」主源）。
    expect(decl(".composer", "border-radius")).toBe("var(--radius-md)");
    expect(decl(".composer", "box-shadow")).toBe("var(--elev-2)");
    expect(decl(".composer", "border")).toBe("0");
    expect(decl(".send", "width")).toBe("34px");
    expect(decl(".send", "height")).toBe("34px");
    expect(decl(".send", "border-radius")).toBe("50%");
    // the tokens themselves: the 119 scale + BOTH theme shadows (inkline-tokens re-pin).
    expect(prop("--radius-md")).toBe("8px");
  });

  it("119 — the user bubble rides the uniform 8px bubble tier (气泡与卡片同族)", () => {
    expect(decl(".msg-user .bub", "border-radius")).toBe("var(--radius-bubble)");
    expect(prop("--radius-bubble")).toBe("8px");
  });

  it("the composer chips are the quiet chips (transparent at rest; the 999px cap override retired in 119)", () => {
    expect(decl(".composer .chip", "background")).toBe("transparent");
    // 119：胶囊帽覆写退役——scoped 基座只剩透明底/透明边，角随全局 .chip
    // 的 sm 档（本 scoped 规则不再声明 border-radius，见 10/20 源注释）。
    expect(decl(".chip", "border-radius")).toBe("var(--radius-sm)");
    expect(decl(".composer .chip:hover:not(:disabled)", "background")).toBe("var(--surface-2)");
  });

  it("fix round 2 I1/M5 — the SELECTED chip keeps its NEUTRAL state inside the composer (116 弧 A)", () => {
    // The scoped quiet base (0,2,0, later) was eating `.chip.on/.sel` — the
    // scoped re-declaration below restores the selected look; pinned so the
    // regression cannot slip through again. 116 弧 A: 芯片选中 = 中性
    // （surface-2 底 + hair-2 边 + text-1），accent 不再进芯片底。
    expect(decl(".composer .chip.on", "background")).toBe("var(--surface-2)");
    expect(decl(".composer .chip.sel", "background")).toBe("var(--surface-2)");
    expect(decl(".composer .chip.sel", "border-color")).toBe("var(--hair-2)");
    expect(decl(".composer .chip.sel", "color")).toBe("var(--text-1)");
  });

  it("the transient reconnect notice is the secondary strip (.banner.quiet), not the amber band", async () => {
    expect(decl(".banner.quiet", "background")).toBe("none");
    expect(decl(".banner.quiet", "font-family")).toBe("var(--mono)");
    // A reconnecting client (default reconnect schedule) mounts the quiet
    // strip — fake timers keep the scheduled retry from leaking past unmount.
    vi.useFakeTimers();
    try {
      const server = fakeServer();
      const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn() });
      const container = mount(<App client={client} />);
      act(() => {
        client.connect();
        server.socket.serverOpen();
      });
      await act(async () => {
        server.socket.serverClose(1006, "");
      });
      const quiet = container.querySelector(".banner.quiet");
      expect(quiet?.textContent).toContain("正在重连");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the topbar carries exactly ONE theme button (the ◐ merge — no moon+sun pair)", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    const theme = h.container.querySelectorAll('.topbar button[aria-label="切换主题"]');
    expect(theme).toHaveLength(1);
  });

  it("the statusline stays the mockup strip: 28px mono caption, cache on --ok", () => {
    expect(decl(".statusline", "height")).toBe("28px");
    expect(decl(".statusline", "font-family")).toBe("var(--mono)");
    expect(decl(".statusline", "font-size")).toBe("var(--fs-caption)");
    expect(decl(".statusline .cache", "color")).toBe("var(--ok)");
  });
});

// ---------------------------------------------------------------------------
// C — the permission card's .approval tokens + the no-scrim ask audit.
// ---------------------------------------------------------------------------
describe("ui-parity C — permission card on the .approval tokens", () => {
  it("strip label + mono cmd block capped at 76px + sm-tier buttons right-aligned", () => {
    expect(decl(".permission-card .strip", "color")).toBe("var(--warn)");
    expect(decl(".permission-card .cmd", "max-height")).toBe("76px");
    expect(decl(".permission-card .cmd", "overflow")).toBe("auto");
    expect(decl(".permission-card .cmd", "font-family")).toBe("var(--mono)");
    // 119：按钮从胶囊帽归 chip 档 sm（一套 6/8/12 scale）。
    expect(decl(".permission-card .btnrow button", "border-radius")).toBe("var(--radius-sm)");
    const c = mount(<PermissionModal ask={ASK} onChoose={() => {}} />);
    expect(c.querySelector(".permission-card .strip")?.textContent).toContain("等待你的批准");
    expect(c.querySelector(".permission-card .cmd")?.textContent).toContain("pnpm --filter app test");
  });

  it("the keyboard lane is untouched: y allows, Esc denies (single-shot)", async () => {
    const onChoose = vi.fn();
    const c = mount(<PermissionModal ask={ASK} onChoose={onChoose} />);
    const card = c.querySelector(".permission-card") as HTMLElement;
    await act(async () => {
      card.dispatchEvent(new KeyboardEvent("keydown", { key: "y", bubbles: true }));
    });
    expect(onChoose).toHaveBeenCalledWith({ allow: true });
    await act(async () => {
      card.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onChoose).toHaveBeenCalledTimes(1); // single-shot: the y already resolved it
  });
});

describe("ui-parity C — the no-scrim ask audit (every ask path is inline)", () => {
  // The tokens-conformance seam: fileURLToPath, not the file:// string strip
  // (win32 file:///D:/… minus "file://" doubles the drive letter D:\D:\…).
  const src = (f: string): string =>
    readFileSync(join(fileURLToPath(import.meta.url), `../../src/components/${f}`), "utf8");

  it("the three ask paths render ZERO scrim/overlay markup", () => {
    for (const f of ["PermissionModal.tsx", "SimpleApprovalCard.tsx", "SimpleMode.tsx"]) {
      const s = src(f);
      expect(s, f).not.toMatch(/className=["'][^"']*\b(scrim|overlay|modal-card)\b/);
    }
  });

  it("the advanced ask mounts as the chat column's inline card (no scrim)", async () => {
    const h = mountedApp();
    // No parked ask yet: no card, and no scrim from anything else either.
    await act(async () => {
      authOk(h.server.socket, {
        busy: true,
        pendingPermission: { toolName: "write_file", summary: "src/a.ts", input: {} },
      });
    });
    expect(h.container.querySelector(".scrim")).toBeNull();
    expect(h.container.querySelector(".chat ~ .permission-card")).not.toBeNull();
  });

  it("the simple approval card is the inline .approval card (buttons outside the cmd scroll region)", () => {
    const c = mount(<SimpleApprovalCard ask={ASK} onChoose={() => {}} />);
    const cmd = c.querySelector(".approval .cmd") as HTMLElement;
    const btns = c.querySelector(".approval .btns") as HTMLElement;
    expect(cmd).not.toBeNull();
    expect(cmd.contains(btns)).toBe(false);
  });
});
