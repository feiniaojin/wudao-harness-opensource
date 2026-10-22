// @vitest-environment jsdom
// M63 §D — 简洁模式 suite. Slice 1: the 简洁/高级 shell resolution — the
// ui.defaultMode persistence contract (absent = advanced), the settingsStatus
// resolution, and the shell swap (M65-space §1: the topbar pill is gone;
// the settings page's 偏好 switch is the only writer). Slice 2: activity cards (collapse/expand/
// 8-line cap/error-first-line), the approval card (three paths, takeover),
// and the recovery-instruction error card. Slice 3: the empty hero, the turn
// status clock, the context ring, and the 排队/注入当前轮 lanes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WudaoClient } from "../src/protocol.js";
import type { HistoryEntry } from "../src/protocol.js";
import { App } from "../src/components/App.js";
import { SimpleActivityCard, activityKindOf, isEditRunning, CARD_LINE_CAP } from "../src/components/SimpleActivityCard.js";
import { SimpleApprovalCard, approvalCommandText } from "../src/components/SimpleApprovalCard.js";
import { SimpleErrorCard, recoveryFor } from "../src/components/SimpleErrorCard.js";
import { SimpleTurnStatus, turnPhaseOf } from "../src/components/SimpleTurnStatus.js";
import { ContextMeter } from "../src/components/ContextMeter.js";
// ω99-167: EmptyHero 直接挂载钉已迁 flow-visual（hero 零按钮防复活钉；
// ω99-203: 原同迁的 ask-row 套件随常用吩咐行整族退役）；本文件的 hero 钉
// 走 App 整挂（见 M63 §D slice 3 describe）。

import { busyToolHasCard, isConversationEmpty, SimpleHistoryList } from "../src/components/SimpleMode.js";
import { DiffView } from "../src/components/DiffView.js";
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

function type(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  window.localStorage.removeItem("wudao.ui.v1"); // ui-review-r3 P2: reset the persisted layout between tests
  vi.useRealTimers();
});

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
async function replySettings(h: AppHarness, uiDefaultMode: "simple" | "advanced" | null): Promise<void> {
  await act(async () => {
    const op = opFrames(h).find((o) => o.op.op === "settingsStatus");
    h.server.socket.serverSend({
      t: "result",
      id: op?.id,
      ok: { settings: { memoryEnabled: true, uiDefaultMode } },
    });
  });
}

describe("M63 §D slice 1 — the 简洁/高级 shell resolution", () => {
  it("absent ui.defaultMode resolves to the ADVANCED shell (existing users never flip)", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await replySettings(h, null);
    expect(h.container.querySelector("[data-mode='simple']")).toBeNull();
  });

  it("a persisted 简洁 preference resolves to the simple shell", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await replySettings(h, "simple");
    expect(h.container.querySelector("[data-mode='simple']")).not.toBeNull();
  });

  it("an unanswered settingsStatus (old server) keeps advanced; the toggle still works", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    expect(h.container.querySelector("[data-mode='simple']")).toBeNull();
  });

  // M65-space §1: the topbar pill is GONE — the settings page's 偏好 switch
  // (SettingsPage, ui.defaultMode) is the only writer. The topbar itself
  // carries no mode control.
  it("M65-space §1: no mode pill anywhere in the shell — the settings page owns the switch", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await replySettings(h, "simple");
    expect(h.container.querySelector(".mode-toggle")).toBeNull();
    // And the switch it replaced is reachable: ⚙ opens the settings page
    // (whose 偏好 tab holds the 简洁/高级 default — settings-split routes
    // through the tab; it is not the default panel).
    await act(async () => {
      (h.container.querySelector(".topbar button[aria-label='设置']") as HTMLButtonElement).click();
    });
    expect(h.container.querySelector(".settings-page")).not.toBeNull();
    await act(async () => {
      (h.container.querySelector("button[data-settings-tab='preferences']") as HTMLButtonElement).click();
    });
    expect(h.container.textContent).toContain("默认界面");
  });

  // M65-space §2: the statusline is ADVANCED-only — the simple shell's
  // window ends at the composer wrap (12px bottom inset); the driver state
  // it carried stays reachable through the composer's context ring.
  it("M65-space §2: the simple shell drops the statusline; advanced keeps it", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await replySettings(h, "simple");
    expect(h.container.querySelector(".statusline")).toBeNull();
    const adv = mountedApp();
    await act(async () => {
      authOk(adv.server.socket);
    });
    await replySettings(adv, null);
    expect(adv.container.querySelector(".statusline")).not.toBeNull();
  });

  it("the simple shell keeps the driver surface: history renders, submit still rides the submit op", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, {}, [{ kind: "user", text: "你好" }, { kind: "assistant", text: "在的" }]);
    });
    await replySettings(h, "simple");
    const text = h.container.textContent ?? "";
    expect(text).toContain("你好");
    expect(text).toContain("在的");
    const input = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(input, "继续");
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(opFrames(h).some((o) => o.op.op === "submit" && o.op.text === "继续")).toBe(true);
  });
});

/** A full state frame the simple-mode suites can override piecemeal. */
function sendState(h: AppHarness, overrides: Record<string, unknown>): void {
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
      ...overrides,
    },
  });
}

// ---------------------------------------------------------------------------
// Slice 2 — activity cards (research 35 #2: collapsed one-line rows, typed
// 8-line-capped expandable bodies, error first line as the summary).
// ---------------------------------------------------------------------------
describe("M63 §D slice 2 — SimpleActivityCard", () => {
  it("classifies the typed-card family from the tool name", () => {
    expect(activityKindOf("read_file")).toBe("read");
    expect(activityKindOf("grep")).toBe("search");
    expect(activityKindOf("glob")).toBe("search");
    expect(activityKindOf("web_search")).toBe("web");
    expect(activityKindOf("web_fetch")).toBe("web");
    expect(activityKindOf("shell")).toBe("inout");
    expect(activityKindOf("task")).toBe("inout");
    expect(activityKindOf("WriteFile")).toBe("inout");
  });

  // 墨线活动卡契约（spec §2）——32px 折叠行（状态符/动词/mono 文件名/右缘
  // 注记/chevron）+ 类型化展开体。夹具沿用该文件现有形状。
  const toolEntry = { kind: "tool", name: "read_file", summary: "src/a.ts", resultPreview: "line1\nline2" } as const;

  it("activity card collapsed = one row with data-status + verb + mono file + tail", () => {
    const c = mount(<SimpleActivityCard entry={toolEntry} />);
    const row = c.querySelector(".act .act-row") as HTMLButtonElement;
    expect(row.getAttribute("data-status")).toBeTruthy();
    expect(row.querySelector(".act-verb")).toBeTruthy();
    expect(row.querySelector(".act-file")).toBeTruthy(); // mono 文件名
    expect(c.querySelector(".act .act-body")).toBeNull();
    // fix-r1: the ROOT carries the binding contract too — div.act[data-kind][data-status].
    expect(c.querySelector(".act")?.getAttribute("data-kind")).toBe("read");
    expect(c.querySelector(".act")?.getAttribute("data-status")).toBe("ok");
  });
  it("expanding reveals the typed body under .act-body", async () => {
    const c = mount(<SimpleActivityCard entry={toolEntry} />);
    await act(async () => {
      (c.querySelector(".act .act-row") as HTMLButtonElement).click();
    });
    const body = c.querySelector(".act .act-body") as HTMLElement;
    expect(body.textContent).toContain("line1");
  });

  it("renders collapsed as ONE line (name + summary); expanding reveals the typed body", async () => {
    const c = mount(
      <SimpleActivityCard entry={{ kind: "tool", name: "read_file", summary: "src/a.ts", resultPreview: "line1\nline2" }} />,
    );
    const head = c.querySelector(".act .act-row") as HTMLButtonElement;
    expect(head.textContent).toContain("读取");
    expect(head.textContent).toContain("src/a.ts");
    expect(c.querySelector(".act .act-body")).toBeNull();
    expect(c.querySelector(".act")?.getAttribute("data-kind")).toBe("read");
    await act(async () => {
      head.click();
    });
    const body = c.querySelector(".act .act-body") as HTMLElement;
    expect(body.textContent).toContain("line1");
    expect(body.style.maxHeight).not.toBe("");
  });

  it("caps the expanded body at 8 lines with an honest footer (12-line read)", async () => {
    const preview = Array.from({ length: 12 }, (_, i) => `line-${i + 1}`).join("\n");
    const c = mount(
      <SimpleActivityCard entry={{ kind: "tool", name: "read_file", summary: "big.ts", resultPreview: preview }} />,
    );
    await act(async () => {
      (c.querySelector(".act .act-row") as HTMLButtonElement).click();
    });
    const body = c.querySelector(".act .act-body") as HTMLElement;
    expect(body.textContent).toContain("line-1");
    expect(body.textContent).toContain(`line-${CARD_LINE_CAP}`);
    expect(body.textContent).not.toContain(`line-${CARD_LINE_CAP + 1}`);
    // M76-ux2 §2: the static truncation foot became the 展开 toggle (the
    // honest total moved into its label).
    expect(c.querySelector(".act .activity-toggle")?.textContent).toBe(`展开 ▾ (12 行)`);
  });

  it("M76-ux2 §2: 展开 raises the cap to 50 lines; 收起 drops back to 8 (20-line read)", async () => {
    const preview = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join("\n");
    const c = mount(
      <SimpleActivityCard entry={{ kind: "tool", name: "read_file", summary: "big.ts", resultPreview: preview }} />,
    );
    await act(async () => {
      (c.querySelector(".act .act-row") as HTMLButtonElement).click();
    });
    const body = (): HTMLElement => c.querySelector(".act .act-body") as HTMLElement;
    const toggle = (): HTMLButtonElement | null => c.querySelector(".act .activity-toggle");
    // Truncated: 8 lines + the 展开 button announcing the honest total.
    expect(body().textContent).toContain("line-8");
    expect(body().textContent).not.toContain("line-9");
    expect(body().style.maxHeight).toBe("132px");
    expect(toggle()?.textContent).toBe("展开 ▾ (20 行)");
    await act(async () => {
      toggle()?.click();
    });
    // Expanded: all 20 lines visible; the ceiling rose with the cap.
    expect(body().textContent).toContain("line-20");
    expect(body().style.maxHeight).toBe("960px");
    expect(toggle()?.textContent).toBe("收起 ▴");
    await act(async () => {
      toggle()?.click();
    });
    // Collapsed again: back to 8 lines.
    expect(body().textContent).toContain("line-8");
    expect(body().textContent).not.toContain("line-9");
    expect(toggle()?.textContent).toBe("展开 ▾ (20 行)");
  });

  it("an errored tool's collapsed summary IS the error's first line, in the error color", () => {
    const c = mount(
      <SimpleActivityCard
        entry={{ kind: "tool", name: "shell", summary: "npm t", isError: true, resultPreview: "exit 1: tests failed\nat spec:42" }}
      />,
    );
    const head = c.querySelector(".act .act-row") as HTMLElement;
    expect(head.textContent).toContain("exit 1: tests failed");
    expect(head.querySelector(".act-tail")).not.toBeNull();
    // fix-r1: the ROOT mirrors the err status (`.act[data-status="err"]`).
    expect(c.querySelector(".act")?.getAttribute("data-status")).toBe("err");
  });

  // #455 (0.3.83 报障「很多 -号的行，+号的行没有看到」): the folded diff is the
  // BALANCED two-sign preview. 14 lines/1 change collapses to 15 rows — over
  // the 8-line card cap — and the OLD window showed only the ctx/del head
  // (the add row sat below the 132px fold). The preview keeps BOTH signs'
  // heads (ctx rows give way — the preview answers 「改了什么」), and 展开
  // raises to the full hunk. 15 ≤ EXPAND_LINE_CAP → the scroll footer never
  // appears for this size.
  it("the edit entry expands into the red/green diff card; over-cap folds to the balanced two-sign preview", async () => {
    const oldText = Array.from({ length: 14 }, (_, i) => `old ${i + 1}`).join("\n");
    const newText = oldText.replace("old 7", "new 7");
    const c = mount(
      <SimpleActivityCard entry={{ kind: "edit", path: "src/a.ts", oldString: oldText, newString: newText }} />,
    );
    expect(c.querySelector(".act")?.getAttribute("data-kind")).toBe("diff");
    // fix-r1: the EditCard root emits data-status as well (pinned "ok").
    expect(c.querySelector(".act")?.getAttribute("data-status")).toBe("ok");
    await act(async () => {
      (c.querySelector(".act .act-row") as HTMLButtonElement).click();
    });
    const body = (): HTMLElement => c.querySelector(".act .act-body") as HTMLElement;
    const toggle = (): HTMLButtonElement | null => c.querySelector(".act .activity-toggle");
    // Folded: BOTH signs' heads on the first screen, honest total on the
    // toggle, ctx rows elided (the preview is signs-only).
    expect(c.textContent).toContain("- old 7");
    expect(c.textContent).toContain("+ new 7");
    expect(c.textContent).not.toContain("old 6");
    expect(body().style.maxHeight).toBe("132px");
    expect(toggle()?.textContent).toBe("展开 ▾ (15 行)");
    await act(async () => {
      toggle()?.click();
    });
    // Expanded: the full hunk (ctx back), raised ceiling. 15 ≤ 50 → no
    // monster footer for this size.
    expect(c.textContent).toContain("old 6");
    expect(body().style.maxHeight).toBe("960px");
    expect(toggle()?.textContent).toBe("收起 ▴");
    expect(c.textContent).not.toContain("卡内滚动查看");
  });

  // #455 报障形态本体：12 删 12 增无公共行 — git hunk 惯序把 12 条 `-` 全部
  // 排在首条 `+` 之前，旧 132px 窗口（≈7 行）整个落在 del 块里，读起来就是
  // 「只有 - 没有 +」。预览两侧各保头 3 行 + 各自诚实计数；展开两侧第 4 行
  // 都回来。
  it("#455: a del-heavy diff's folded preview shows BOTH signs' heads with honest per-side counts", async () => {
    const oldText = Array.from({ length: 12 }, (_, i) => `old ${i + 1}`).join("\n");
    const newText = Array.from({ length: 12 }, (_, i) => `new ${i + 1}`).join("\n");
    const c = mount(
      <SimpleActivityCard entry={{ kind: "edit", path: "src/b.ts", oldString: oldText, newString: newText }} />,
    );
    await act(async () => {
      (c.querySelector(".act .act-row") as HTMLButtonElement).click();
    });
    const toggle = (): HTMLButtonElement | null => c.querySelector(".act .activity-toggle");
    expect(c.textContent).toContain("- old 1");
    expect(c.textContent).toContain("- old 3");
    expect(c.textContent).toContain("+ new 1");
    expect(c.textContent).toContain("+ new 3");
    expect(c.textContent).not.toContain("- old 4");
    expect(c.textContent).not.toContain("+ new 4");
    expect(c.textContent).toContain("⋯ 再 -9 行 ⋯");
    expect(c.textContent).toContain("⋯ 再 +9 行 ⋯");
    expect(toggle()?.textContent).toBe("展开 ▾ (24 行)");
    await act(async () => {
      toggle()?.click();
    });
    expect(c.textContent).toContain("- old 4");
    expect(c.textContent).toContain("+ new 4");
    expect(toggle()?.textContent).toBe("收起 ▴");
  });

  // ω99-295 (M7): 默认 gap 文案中文化 —— 「N unchanged lines」曾是中文
  // 界面里唯一的行内英文。均衡双侧标签（⋯ 再 ±N 行 ⋯）带 label 走覆盖
  // 分支，本钉只钉无 label 的默认分支：8 行改末行 → 7 条前缀 ctx →
  // keep=3 折叠 → gap count=1。
  it("ω99-295: DiffView's default gap marker renders in Chinese (⋯ N 行未变 ⋯)", () => {
    const oldText = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join("\n");
    const c = mount(
      <DiffView path="src/c.ts" oldString={oldText} newString={oldText.replace("line 8", "changed")} />,
    );
    expect(c.textContent).toContain("⋯ 1 行未变 ⋯");
    expect(c.textContent).not.toContain("unchanged");
  });

  it("unknown tools fall back to the IN/OUT card", async () => {
    const c = mount(
      <SimpleActivityCard entry={{ kind: "tool", name: "task", summary: "研究一下", resultPreview: "done: 3 findings" }} />,
    );
    await act(async () => {
      (c.querySelector(".act .act-row") as HTMLButtonElement).click();
    });
    const body = c.querySelector(".act .act-body.inout") as HTMLElement;
    expect(body.textContent).toContain("输入");
    expect(body.textContent).toContain("研究一下");
    expect(body.textContent).toContain("输出");
    expect(body.textContent).toContain("done: 3 findings");
  });
});

// ---------------------------------------------------------------------------
// Slice 2 — the approval card (research 35 #1: input-area takeover, model
// justification as headline, buttons always reachable, three answer paths).
// ---------------------------------------------------------------------------
describe("M63 §D slice 2 — SimpleApprovalCard", () => {
  const ASK = {
    toolName: "shell",
    summary: "跑测试确认修复没有破坏其他用例",
    input: { command: "npm test -- src/a" },
  } as const;

  it("headline = the model's justification; the exact command renders muted in code, outside the actions row", () => {
    const c = mount(<SimpleApprovalCard ask={ASK} onChoose={() => {}} />);
    expect(c.querySelector(".approval .why")?.textContent).toContain("跑测试确认修复");
    const code = c.querySelector(".approval .cmd") as HTMLElement;
    expect(code.textContent).toContain("npm test -- src/a");
    // The buttons live OUTSIDE the command's scroll region.
    const actions = c.querySelector(".approval .btns") as HTMLElement;
    expect(actions.querySelector("button.deny")).not.toBeNull();
    expect(actions.querySelector("button.allow")).not.toBeNull();
    expect(code.contains(actions)).toBe(false);
  });

  it("the interactive paths: allow / deny clicks fire; busy (op in flight) stands down", async () => {
    const onChoose = vi.fn();
    const c = mount(<SimpleApprovalCard ask={ASK} onChoose={onChoose} />);
    await act(async () => {
      (c.querySelector(".approval .btns button.deny") as HTMLButtonElement).click();
    });
    expect(onChoose).toHaveBeenCalledWith({ allow: false });
    await act(async () => {
      (c.querySelector(".approval .btns button.allow") as HTMLButtonElement).click();
    });
    expect(onChoose).toHaveBeenCalledTimes(2); // the card itself is re-answerable
    const busy = mount(<SimpleApprovalCard ask={ASK} busy={true} onChoose={onChoose} />);
    const deny = busy.querySelector(".approval .btns button.deny") as HTMLButtonElement;
    const allow = busy.querySelector(".approval .btns button.allow") as HTMLButtonElement;
    expect(deny.disabled).toBe(true);
    expect(allow.disabled).toBe(true);
    await act(async () => {
      allow.click();
    });
    expect(onChoose).toHaveBeenCalledTimes(2); // busy stands down
    const onChoose2 = vi.fn();
    const c2 = mount(<SimpleApprovalCard ask={ASK} onChoose={onChoose2} />);
    await act(async () => {
      (c2.querySelector(".approval .btns button.allow") as HTMLButtonElement).click();
    });
    expect(onChoose2).toHaveBeenCalledWith({ allow: true });
  });

  it("approvalCommandText picks the command, then url/path/pattern/query, then compact JSON", () => {
    expect(approvalCommandText({ command: "rm -rf x" })).toBe("rm -rf x");
    expect(approvalCommandText({ url: "https://a.b/c" })).toBe("https://a.b/c");
    expect(approvalCommandText({ path: "src/a.ts" })).toBe("src/a.ts");
    expect(approvalCommandText({ pattern: "TODO" })).toBe("TODO");
    expect(approvalCommandText({ n: 3 })).toBe('{"n":3}');
    expect(approvalCommandText({})).toBe("{}");
    const long = approvalCommandText({ command: "x".repeat(500) });
    expect(long.length).toBeLessThanOrEqual(301);
    expect(long.endsWith("…")).toBe(true);
  });

  it("in the shell: the ask TAKES OVER the input area (no textarea, no modal); deny rides answerPermission", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await replySettings(h, "simple");
    await act(async () => {
      sendState(h, { busy: true, pendingPermission: ASK });
    });
    expect(h.container.querySelector(".approval")).not.toBeNull();
    expect(h.container.querySelector("textarea.wudao-input")).toBeNull(); // takeover
    expect(h.container.querySelector(".overlay")).toBeNull(); // no modal in simple mode
    await act(async () => {
      (h.container.querySelector(".approval .btns button.deny") as HTMLButtonElement).click();
    });
    const answerOp = opFrames(h).find((o) => o.op.op === "answerPermission");
    expect(answerOp?.op).toMatchObject({ allow: false });
    // The server takes the answer — only a RESOLVED op marks the ask
    // answered (review LOW).
    await act(async () => {
      h.server.socket.serverSend({ t: "result", id: answerOp?.id, ok: true });
    });
    // The ask clears: the composer returns and NO vanish notice (we answered).
    await act(async () => {
      sendState(h, { busy: false, pendingPermission: null });
    });
    expect(h.container.querySelector("textarea.wudao-input")).not.toBeNull();
    expect(h.container.textContent).not.toContain("权限请求已结束");
  });

  it("a vanished ask (resolved elsewhere — e.g. a future timeout→deny) surfaces an explicit receipt", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await replySettings(h, "simple");
    await act(async () => {
      sendState(h, { busy: true, pendingPermission: ASK });
    });
    await act(async () => {
      sendState(h, { busy: false, pendingPermission: null });
    });
    expect(h.container.textContent).toContain("权限请求已结束(未被允许)");
  });
});

// ---------------------------------------------------------------------------
// Slice 2 — the recovery-instruction error card (research 35 #8).
// ---------------------------------------------------------------------------
describe("M63 §D slice 2 — SimpleErrorCard + recoveryFor", () => {
  it("classifies recovery instructions", () => {
    expect(recoveryFor("回复被截断,finish_reason=length").action?.text).toBe("继续");
    expect(recoveryFor("Error 401 Unauthorized (invalid api key)").hint).toContain("Key");
    expect(recoveryFor("HTTP 429 rate limit exceeded").hint).toContain("频繁");
    expect(recoveryFor("fetch failed: network timeout").hint).toContain("网络");
    expect(recoveryFor("something odd happened").hint).toContain("重试");
  });

  it("renders the instruction inline; the actionable case submits its text", async () => {
    const onAction = vi.fn();
    const c = mount(<SimpleErrorCard text="回复被截断,只写了一半" onAction={onAction} />);
    expect(c.textContent).toContain("怎么办");
    expect(c.textContent).toContain("发送「继续」");
    await act(async () => {
      (c.querySelector(".err-recovery button") as HTMLButtonElement).click();
    });
    expect(onAction).toHaveBeenCalledWith("继续");
  });

  it("in the shell: an error entry renders the recovery card and the button rides the submit op", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, {}, [{ kind: "error", text: "回复被截断" }]);
    });
    await replySettings(h, "simple");
    expect(h.container.querySelector(".simple-error")).not.toBeNull();
    await act(async () => {
      (h.container.querySelector(".err-recovery button") as HTMLButtonElement).click();
    });
    expect(opFrames(h).some((o) => o.op.op === "submit" && o.op.text === "继续")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Slice 3 — the empty hero (research 35 #9) + composer identity.
// ---------------------------------------------------------------------------
describe("M63 §D slice 3 — EmptyHero", () => {
  it("notices/dividers alone still count as an empty conversation; any real turn flips it", () => {
    expect(isConversationEmpty([{ kind: "notice", text: "hi" }])).toBe(true);
    expect(isConversationEmpty([{ kind: "divider", text: "resumed" }])).toBe(true);
    expect(isConversationEmpty([{ kind: "user", text: "hi" }])).toBe(false);
    expect(isConversationEmpty([{ kind: "tool", name: "x", summary: "" }])).toBe(false);
  });

  it("the hero renders the welcome intro; NO preset chips ride the empty state (ω99-167)", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await replySettings(h, "simple");
    expect(h.container.querySelector(".hero h1")?.textContent).toContain("你好呀，我是悟道Harness");
    expect(h.container.querySelectorAll(".hero button").length).toBe(0); // 预设颗零复活（防复活钉）
    expect(h.container.querySelector(".hero")).not.toBeNull(); // still empty until submit
  });

  it("the composer element KEEPS ITS IDENTITY across the hero→session flip (no remount)", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await replySettings(h, "simple");
    const input = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      h.server.socket.serverSend({
        t: "history",
        entries: [{ kind: "user", text: "第一条" }],
        reset: false,
      });
    });
    expect(h.container.querySelector(".hero")).toBeNull(); // hero flipped off
    const inputAfter = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    expect(inputAfter).toBe(input); // same DOM node — no remount, focus/draft survive
  });
});

// ---------------------------------------------------------------------------
// Slice 3 — the turn status (research 35 #6: stable label, clock only ≥15s,
// queued/parked lines; the cancel hint retired by ω99-298 M13).
// ---------------------------------------------------------------------------
describe("M63 §D slice 3 — SimpleTurnStatus", () => {
  const live = (over: Partial<{ reasoning: string; answer: string; busyTools: { name: string; summary: string }[] }>) => ({
    reasoning: "",
    answer: "",
    busyTools: [],
    ...over,
  });

  it("derives a stable phase per state shape", () => {
    expect(turnPhaseOf(live({ reasoning: "想" }))).toBe("thinking");
    expect(turnPhaseOf(live({ busyTools: [{ name: "x", summary: "" }] }))).toBe("tools");
    expect(turnPhaseOf(live({ answer: "部分回答" }))).toBe("answering");
    expect(turnPhaseOf(live({}))).toBe("working");
  });

  it("#451: ONE motion signal — the label spinner renders ONLY on thinking/working", () => {
    // thinking/working: nothing else moves, so the label carries its own glyph.
    for (const l of [live({ reasoning: "想" }), live({})]) {
      const c = mount(<SimpleTurnStatus busy={true} live={l} />);
      const spin = c.querySelector(".turnstatus svg.spin");
      expect(spin).not.toBeNull();
      // …and it rides the ONE head line (spinner + label in a row,
      // not the old stacked-lines noise).
      expect(spin?.closest(".ts-head")).not.toBeNull();
    }
    // tools: BusyToolRow's .act-st spins; answering: the caret ▌ types —
    // the label must not stack a SECOND spinner on top of either (0.3.81
    // user report: 回答时两个转圈).
    for (const l of [live({ busyTools: [{ name: "x", summary: "" }] }), live({ answer: "部分回答" })]) {
      const c = mount(<SimpleTurnStatus busy={true} live={l} />);
      expect(c.querySelector(".turnstatus svg.spin")).toBeNull();
      expect(c.querySelector(".ts-head .label")?.textContent).toContain("正在"); // the WHAT stays
      // ω99-298 (M13): the stop hint is retired — the composer's 停止 (Esc)
      // chip is the single stop affordance; the head row carries no echo.
      expect(c.querySelector(".ts-head .cancel-hint")).toBeNull();
    }
  });

  it("renders nothing while idle; while busy shows the label and NO clock before 15s (ω99-298: hint gone)", async () => {
    vi.useFakeTimers();
    const c = mount(<SimpleTurnStatus busy={false} live={live({ reasoning: "x" })} />);
    expect(c.querySelector(".turnstatus")).toBeNull();
    const c2 = mount(<SimpleTurnStatus busy={true} live={live({ reasoning: "x" })} />);
    expect(c2.textContent).toContain("正在思考");
    expect(c2.textContent).not.toContain("Esc"); // ω99-298 (M13): 停止说明只在输入框 chip
    expect(c2.querySelector(".clock")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(c2.querySelector(".clock")).toBeNull(); // 10s: still quiet
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    const clock = c2.querySelector(".clock") as HTMLElement;
    expect(clock.textContent).toMatch(/已进行 1[56] 秒/);
  });

  it("lists driver-queued steers; parked messages have NO line here (their one home is the composer chip)", () => {
    const c = mount(<SimpleTurnStatus busy={true} live={live({})} queued={["注入这条"]} />);
    expect(c.textContent).toContain("将在下一步前注入:注入这条");
    expect(c.textContent).not.toContain("排队等下一轮"); // 0.3.81 精修: parked 双显退役
  });
});

// ---------------------------------------------------------------------------
// Slice 3 — the context ring beside send (click → legend).
// ---------------------------------------------------------------------------
describe("M63 §D slice 3 — ContextMeter", () => {
  it("renders nothing without ctx data; with data the click opens the legend", async () => {
    expect(mount(<ContextMeter ctx={null} />).querySelector(".ctx")).toBeNull();
    const c = mount(<ContextMeter ctx={{ used: 12345, window: 131072, nearLimit: false }} />);
    expect(c.querySelector("svg")).not.toBeNull();
    await act(async () => {
      (c.querySelector(".ctx-btn") as HTMLButtonElement).click();
    });
    const legend = c.querySelector(".ctxmeter-legend") as HTMLElement;
    expect(legend.textContent).toContain("已用 12.3k");
    expect(legend.textContent).toContain("窗口 131.1k");
    expect(legend.textContent).toContain("占比 9%");
    const warn = mount(<ContextMeter ctx={{ used: 120000, window: 131072, nearLimit: true }} />);
    await act(async () => {
      (warn.querySelector(".ctx-btn") as HTMLButtonElement).click();
    });
    expect(warn.querySelector(".ctxmeter-legend")?.textContent).toContain("接近上限");
  });

  it("sits in the simple composer's controls row (beside send) when ctx data flows", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, { ctxTokens: { used: 500, window: 1000, nearLimit: false } });
    });
    await replySettings(h, "simple");
    expect(h.container.querySelector(".composer-right .ctx")).not.toBeNull();
  });

  // ui-review-r1 P8: the legend dismisses from OUTSIDE — a transparent fixed
  // click-away layer (the ws-menu/ctx-menu pattern) and Esc on window.
  it("the open legend closes on a backdrop click and on Esc", async () => {
    const c = mount(<ContextMeter ctx={{ used: 12345, window: 131072, nearLimit: false }} />);
    await act(async () => {
      (c.querySelector(".ctx-btn") as HTMLButtonElement).click();
    });
    expect(c.querySelector(".ctxmeter-legend")).not.toBeNull();
    const backdrop = c.querySelector(".ctxmeter-backdrop") as HTMLElement;
    expect(backdrop).not.toBeNull();
    await act(async () => {
      backdrop.dispatchEvent(new Event("click", { bubbles: true }));
    });
    expect(c.querySelector(".ctxmeter-legend")).toBeNull();

    await act(async () => {
      (c.querySelector(".ctx-btn") as HTMLButtonElement).click();
    });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(c.querySelector(".ctxmeter-legend")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Slice 3 — the 排队/注入当前轮 lanes (research 35 #7) + the shield selector
// riding the input area (research 35 #4).
// ---------------------------------------------------------------------------
describe("M63 §D slice 3 — queue vs steer + shield row", () => {
  const BUSY_LIVE = { live: { reasoning: "思考中", answer: "", busyTools: [] }, busy: true };

  it("DEFAULT lane while busy parks locally (no submit op); the run ending flushes it", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await replySettings(h, "simple");
    await act(async () => {
      sendState(h, { ...BUSY_LIVE, queued: [] });
    });
    const input = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(input, "排队消息");
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(opFrames(h).some((o) => o.op.op === "submit")).toBe(false); // parked, not sent
    // 0.3.81 精修: the parked message shows EXACTLY ONCE — the composer chip
    // (its actionable home, with the drop ×). The turn status no longer
    // repeats it as a second line above the answer.
    expect(h.container.querySelector(".parked-chip")).not.toBeNull();
    expect(h.container.textContent).toContain("排队消息");
    expect(h.container.textContent).not.toContain("排队等下一轮");
    await act(async () => {
      sendState(h, { busy: false });
    });
    expect(opFrames(h).some((o) => o.op.op === "submit" && o.op.text === "排队消息")).toBe(true);
    expect(h.container.querySelector(".parked-chip")).toBeNull();
  });

  it("flushes ONE parked message per run end (the rest wait for the run they start)", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await replySettings(h, "simple");
    await act(async () => {
      sendState(h, { ...BUSY_LIVE });
    });
    const input = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    for (const text of ["第一条", "第二条"]) {
      await act(async () => {
        type(input, text);
      });
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
    }
    await act(async () => {
      sendState(h, { busy: false });
    });
    const submits = opFrames(h).filter((o) => o.op.op === "submit");
    expect(submits.length).toBe(1);
    expect(h.container.querySelectorAll(".parked-chip").length).toBe(1);
    // A new run starts and ends → the second message goes out.
    await act(async () => {
      sendState(h, { busy: true });
    });
    await act(async () => {
      sendState(h, { busy: false });
    });
    expect(opFrames(h).filter((o) => o.op.op === "submit").length).toBe(2);
  });

  it("the 注入当前轮 lane submits immediately onto the steering channel", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await replySettings(h, "simple");
    await act(async () => {
      sendState(h, { ...BUSY_LIVE });
    });
    await act(async () => {
      (h.container.querySelector(".lane-toggle button[data-lane='steer']") as HTMLButtonElement).click();
    });
    const input = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    expect(input.placeholder).toContain("注入当前运行的任务");
    await act(async () => {
      type(input, "现在就插入");
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(opFrames(h).some((o) => o.op.op === "submit" && o.op.text === "现在就插入")).toBe(true);
    expect(h.container.querySelector(".parked-chip")).toBeNull();
  });

  // 墨线 T15 终门 — the chip language's selected state on the lane toggle: the
  // ACTIVE lane is exactly `chip on`, the other stays bare `chip` (the pair is
  // the whole state contract — swapping lanes swaps the suffix, nothing else).
  it("T15 gate — lane chips: the active lane carries exactly `chip on`, the other bare `chip`", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await replySettings(h, "simple");
    await act(async () => {
      sendState(h, { ...BUSY_LIVE });
    });
    const queue = h.container.querySelector(".lane-toggle button[data-lane='queue']") as HTMLButtonElement;
    const steer = h.container.querySelector(".lane-toggle button[data-lane='steer']") as HTMLButtonElement;
    expect(queue.className).toBe("chip on"); // queue is the default lane
    expect(steer.className).toBe("chip");
    await act(async () => {
      steer.click();
    });
    expect(queue.className).toBe("chip");
    expect(steer.className).toBe("chip on");
  });

  it("a parked chip can be dropped; the lane toggle hides when idle", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await replySettings(h, "simple");
    await act(async () => {
      sendState(h, { ...BUSY_LIVE });
    });
    const input = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(input, "会放弃的");
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await act(async () => {
      (h.container.querySelector(".parked-chip .drop") as HTMLButtonElement).click();
    });
    expect(h.container.querySelector(".parked-chip")).toBeNull();
    await act(async () => {
      sendState(h, { busy: false });
    });
    expect(opFrames(h).some((o) => o.op.op === "submit" && o.op.text === "会放弃的")).toBe(false);
    expect(h.container.querySelector(".lane-toggle")).toBeNull(); // idle → hidden
  });

  it("the shield selector rides the composer toolbar; a tier pick rides setMode", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await replySettings(h, "simple");
    // M64-visual §2: the permanent shield row is gone; the chip rides the
    // composer's toolbar row and opens the tier menu.
    expect(h.container.querySelector(".shield-row")).toBeNull();
    const chip = h.container.querySelector(".simple-composer .composer-tools .pop > button.chip") as HTMLButtonElement;
    expect(chip).not.toBeNull();
    await act(async () => {
      chip.click();
    });
    await act(async () => {
      (h.container.querySelector(".pop .mi[data-mode='workspace']") as HTMLButtonElement).click();
    });
    expect(opFrames(h).some((o) => o.op.op === "setMode" && o.op.mode === "workspace")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Slice 4 — DiffView word-level intra-line highlight (BOTH modes; research
// 35 #3): .wchg spans on an exactly-1-del+1-add hunk, row-level otherwise.
// ---------------------------------------------------------------------------
describe("M63 §D slice 4 — DiffView word-level highlight", () => {
  it("a 1-del+1-add hunk marks the changed words in both rows", () => {
    const c = mount(
      <DiffView path="src/a.ts" oldString={"const total = compute();"} newString={"const subtotal = compute();"} />,
    );
    const changed = [...c.querySelectorAll(".wchg")] as HTMLElement[];
    expect(changed.map((s) => s.textContent)).toEqual(["total", "subtotal"]);
    expect(c.querySelector(".del .wchg")).not.toBeNull();
    expect(c.querySelector(".add .wchg")).not.toBeNull();
    // The rows still read whole: spans concatenate to the full line.
    const del = c.querySelector(".diff .del") as HTMLElement;
    expect(del.textContent).toContain("- const total = compute();");
  });

  it("a multi-row hunk (2 del + 1 add) keeps row-level marking — no .wchg", () => {
    const c = mount(
      <DiffView path="src/a.ts" oldString={"a\nx\ny\nz"} newString={"a\nw\nz"} />,
    );
    expect(c.querySelector(".wchg")).toBeNull();
    expect(c.textContent).toContain("- x");
    expect(c.textContent).toContain("+ w");
  });

  it("flows through the simple activity card's diff body", async () => {
    const c = mount(
      <SimpleActivityCard
        entry={{ kind: "edit", path: "src/a.ts", oldString: "  return x + 1;", newString: "  return y + 1;" }}
      />,
    );
    await act(async () => {
      (c.querySelector(".act .act-row") as HTMLButtonElement).click();
    });
    expect(c.querySelectorAll(".wchg").length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Review round — MEDIUM: the parked queue must SURVIVE every SimpleMode
// unmount (the settings swap — M65-space §1's only in-app remount path);
// LOW: a rejected answer op keeps
// the ask answerable; NIT: an applied draft never re-arms on remount.
// ---------------------------------------------------------------------------
describe("M63 §D review round", () => {
  const BUSY_LIVE = { live: { reasoning: "思考中", answer: "", busyTools: [] }, busy: true };

  it("MEDIUM: a parked message survives repeated settings swaps (SimpleMode unmounts), then flushes at run end", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await replySettings(h, "simple");
    await act(async () => {
      sendState(h, { ...BUSY_LIVE });
    });
    const input = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(input, "排队幸存者");
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(h.container.querySelector(".parked-chip")).not.toBeNull();
    // Swap to the settings page (SimpleMode unmounts) and back.
    await act(async () => {
      // M64-visual §4: the 设置 entry is the topbar's ⚙ icon button now.
      (h.container.querySelector(".topbar button[aria-label='设置']") as HTMLButtonElement).click();
    });
    expect(h.container.querySelector(".parked-chip")).toBeNull(); // the page swapped
    await act(async () => {
      (h.container.querySelector(".settings-head button") as HTMLButtonElement).click();
    });
    expect(h.container.textContent).toContain("排队幸存者"); // the park survived
    // M65-space §1: the topbar mode pill is gone, so the second unmount cycle
    // is another settings swap (the only in-app remount path left).
    await act(async () => {
      (h.container.querySelector(".topbar button[aria-label='设置']") as HTMLButtonElement).click();
    });
    await act(async () => {
      (h.container.querySelector(".settings-head button") as HTMLButtonElement).click();
    });
    expect(h.container.textContent).toContain("排队幸存者");
    expect(opFrames(h).some((o) => o.op.op === "submit" && o.op.text === "排队幸存者")).toBe(false);
    // The run ends → the promise is kept.
    await act(async () => {
      sendState(h, { busy: false });
    });
    expect(opFrames(h).some((o) => o.op.op === "submit" && o.op.text === "排队幸存者")).toBe(true);
  });

  it("LOW: a REJECTED answer op keeps the ask answerable and surfaces a notice; the retry resolves", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await replySettings(h, "simple");
    await act(async () => {
      sendState(h, { busy: true, pendingPermission: { toolName: "shell", summary: "跑测试", input: { command: "npm t" } } });
    });
    const deny = () => h.container.querySelector(".approval .btns button.deny") as HTMLButtonElement;
    await act(async () => {
      deny().click();
    });
    // The op rejects (socket drop at click time).
    const op = opFrames(h).find((o) => o.op.op === "answerPermission");
    await act(async () => {
      h.server.socket.serverSend({ t: "result", id: op?.id, err: "not connected" });
    });
    expect(h.container.textContent).toContain("回答未送达");
    expect(deny().disabled).toBe(false); // re-answerable, not locked
    // The retry goes through.
    await act(async () => {
      deny().click();
    });
    const retry = opFrames(h).filter((o) => o.op.op === "answerPermission").pop();
    await act(async () => {
      h.server.socket.serverSend({ t: "result", id: retry?.id, ok: true });
    });
    await act(async () => {
      sendState(h, { busy: false, pendingPermission: null });
    });
    expect(h.container.querySelector("textarea.wudao-input")).not.toBeNull(); // composer back
    expect(h.container.textContent).not.toContain("权限请求已结束"); // answered — no vanish receipt
  });

  // The NIT's original pin (buffer wiped on remount) was superseded by
  // ui-review-r2 I1: the VISIBLE buffer now survives an ask/modal/settings
  // unmount (a permission ask popping mid-typing must not eat the text).
  // ω99-167: the hero chips (the old arm trigger) are RETIRED by user order —
  // this pin now fills the buffer by TYPING (the park/survival half); the
  // arm-consumption half (applies exactly once, no re-fire on remount, new
  // nonce re-arms) had moved to the ask-row suite and was retired with the
  // frequent-asks row (ω99-203: InputBox's draft prop arming itself is now
  // unpinned — same-arc disclosure in the ω99-203 report).
  it("NIT/I1: the LIVE buffer parks across a composer remount — typed text survives the settings swap", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await replySettings(h, "simple");
    const input = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(input, "用户补充的话");
    });
    // Remount the composer (settings swap): the typed buffer survives (I1).
    await act(async () => {
      // M64-visual §4: the 设置 entry is the topbar's ⚙ icon button now.
      (h.container.querySelector(".topbar button[aria-label='设置']") as HTMLButtonElement).click();
    });
    await act(async () => {
      (h.container.querySelector(".settings-head button") as HTMLButtonElement).click();
    });
    const fresh = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    expect(fresh.value).toBe("用户补充的话"); // the parked live buffer
  });
});

// ---------------------------------------------------------------------------
// ui-review-r5 I4 — SimpleHistoryList's rows ride the SAME stable composite
// key the advanced HistoryList gained in r2-P4 (historyKey): a bare index key
// let a history REPLACEMENT (resume/reconnect replay) inherit the previous
// rows' local state — an expanded activity card could land on whichever entry
// slid into its old position.
// ---------------------------------------------------------------------------
describe("ui-review-r5 I4 — SimpleHistoryList keys", () => {
  it("a replay with shifted entries keeps the expand state off the WRONG row (historyKey, the r2-P4 fix)", async () => {
    const preview = Array.from({ length: 12 }, (_, i) => `line-${i + 1}`).join("\n");
    const read: HistoryEntry = { kind: "tool", name: "read_file", summary: "src/a.ts", resultPreview: preview };
    const c = mount(<SimpleHistoryList history={[read]} onSubmit={() => {}} />);
    await act(async () => {
      (c.querySelector(".act[data-kind='read'] .act-row") as HTMLButtonElement).click();
    });
    expect(c.querySelector(".act[data-kind='read'] .act-body")).not.toBeNull(); // expanded

    // The replay: a grep card lands at index 0; the read slides to index 1.
    // With a bare index key the expansion would attach to the grep (index 0).
    act(() => {
      root?.render(
        <SimpleHistoryList
          history={[{ kind: "tool", name: "grep", summary: "TODO", resultPreview: "found 2" }, read]}
          onSubmit={() => {}}
        />,
      );
    });
    expect(c.querySelector(".act[data-kind='search'] .act-body")).toBeNull(); // the newcomer is collapsed
    expect(c.querySelector(".act[data-kind='read'] .act-body")).toBeNull(); // the read re-derived its own (collapsed) state at index 1
  });
});

// ---------------------------------------------------------------------------
// UI-3 — C1: the busy tools render in the 简洁面 too (mockup P1's running ◐
// card — the SAME BusyToolRow the advanced timeline rides, so "它在干什么"
// is visible while a tool runs, not only after it lands in history); C2: the
// approval card's focus/keyboard contract (PermissionModal's, fail-closed).
// ---------------------------------------------------------------------------
describe("UI-3 C1 — busy tool rows in the simple face", () => {
  it("while busy, each in-flight tool renders as a run card inside .turnlive (verb + mono summary + ◐ spinner + gating tail)", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await replySettings(h, "simple");
    await act(async () => {
      sendState(h, {
        busy: true,
        live: {
          reasoning: "",
          answer: "",
          busyTools: [
            { name: "read_file", summary: "src/pages/Login.tsx", gating: false },
            { name: "shell", summary: "pnpm test -- Login", gating: true },
          ],
        },
      });
    });
    const cards = [...h.container.querySelectorAll(".turnlive .act")] as HTMLElement[];
    expect(cards.length).toBe(2);
    expect(cards.map((c) => c.getAttribute("data-status"))).toEqual(["run", "run"]);
    expect(cards[0]?.getAttribute("data-kind")).toBe("read");
    const row = cards[0]?.querySelector(".act-row") as HTMLElement;
    expect(row.tagName).toBe("DIV"); // not a button — nothing to expand while busy
    expect(row.querySelector(".act-st.st-run svg.spin")).not.toBeNull();
    expect(row.querySelector(".sr-only")?.textContent).toBe("进行中");
    expect(row.querySelector(".act-verb")?.textContent).toBe("读取");
    expect(row.querySelector(".act-file")?.textContent).toBe("src/pages/Login.tsx");
    expect(cards[0]?.querySelector(".act-body")).toBeNull();
    // ω99-160: gating 尾随源中文化——钉的是 gating 尾在场，文案随源走。
    expect(cards[1]?.querySelector(".act-tail.gating")?.textContent).toContain("检查中");
  });

  it("the run cards vanish when the turn ends; the finished tool lands in history as the expandable card", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await replySettings(h, "simple");
    await act(async () => {
      sendState(h, {
        busy: true,
        live: { reasoning: "", answer: "", busyTools: [{ name: "read_file", summary: "src/a.ts" }] },
      });
    });
    expect(h.container.querySelectorAll(".turnlive .act").length).toBe(1);
    await act(async () => {
      sendState(h, { busy: false, live: { reasoning: "", answer: "", busyTools: [] } });
      h.server.socket.serverSend({
        t: "history",
        entries: [{ kind: "tool", name: "read_file", summary: "src/a.ts", resultPreview: "ok" }],
        reset: false,
      });
    });
    expect(h.container.querySelector(".turnlive")).toBeNull(); // run over
    const done = h.container.querySelector(".act[data-status='ok']") as HTMLElement;
    expect(done).not.toBeNull(); // ✓ — the completion flip is the history card
    expect(done.querySelector(".act-row")?.tagName).toBe("BUTTON"); // expandable again
  });

  it("C4 in the simple face: the streaming answer carries the ▌ caret; idle answers show none", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await replySettings(h, "simple");
    await act(async () => {
      sendState(h, { busy: true, live: { reasoning: "", answer: "修复进行中", busyTools: [] } });
    });
    const caret = h.container.querySelector(".turnlive .live-answer .caret") as HTMLElement;
    expect(caret?.textContent).toBe("▌");
    expect(caret?.getAttribute("aria-hidden")).toBe("true");
    await act(async () => {
      sendState(h, { busy: false, live: { reasoning: "", answer: "", busyTools: [] } });
    });
    expect(h.container.querySelector(".live-answer")).toBeNull(); // the turn closed — cursor gone with it
  });
});

describe("UI-3 C2 — the approval card's focus/keyboard contract", () => {
  const ASK = {
    toolName: "shell",
    summary: "跑测试确认修复",
    input: { command: "npm test -- src/a" },
  } as const;

  it("focus lands ON the card the moment it mounts (the composer it replaces is gone)", () => {
    const c = mount(<SimpleApprovalCard ask={ASK} onChoose={() => {}} />);
    const card = c.querySelector(".approval") as HTMLElement;
    expect(card.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(card);
  });

  it("keys: y allows, n denies; Esc AND Enter both deny (fail-closed on the reflex keys)", async () => {
    const onChoose = vi.fn();
    const c = mount(<SimpleApprovalCard ask={ASK} onChoose={onChoose} />);
    const card = c.querySelector(".approval") as HTMLElement;
    const key = async (k: string): Promise<void> => {
      await act(async () => {
        card.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
      });
    };
    await key("y");
    expect(onChoose).toHaveBeenCalledWith({ allow: true });
    await key("n");
    expect(onChoose).toHaveBeenCalledWith({ allow: false });
    await key("Escape");
    expect(onChoose).toHaveBeenLastCalledWith({ allow: false });
    await key("Enter");
    expect(onChoose).toHaveBeenLastCalledWith({ allow: false }); // Enter NEVER grants
    expect(onChoose).toHaveBeenCalledTimes(4); // the card itself stays re-answerable (single-flight is the parent's)
  });

  it("busy (answer op in flight): the keys stand down with the buttons", async () => {
    const onChoose = vi.fn();
    const c = mount(<SimpleApprovalCard ask={ASK} busy={true} onChoose={onChoose} />);
    const card = c.querySelector(".approval") as HTMLElement;
    await act(async () => {
      card.dispatchEvent(new KeyboardEvent("keydown", { key: "y", bubbles: true, cancelable: true }));
      card.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("in the shell: the ask takeover focuses the card; Esc rides answerPermission as a DENY", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await replySettings(h, "simple");
    await act(async () => {
      sendState(h, { busy: true, pendingPermission: { toolName: "shell", summary: "跑测试", input: { command: "npm t" } } });
    });
    const card = h.container.querySelector(".approval") as HTMLElement;
    expect(document.activeElement).toBe(card); // not <body> — the novice never blind-Tabs
    await act(async () => {
      card.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    const answerOp = opFrames(h).find((o) => o.op.op === "answerPermission");
    expect(answerOp?.op).toMatchObject({ allow: false }); // fail-closed on the wire
  });
});

// UI-3 C1 (scout 顺手项, v2:202): the errored card's collapsed tail carries
// the 「· 点击查看」 hint; expanding retires it (the body is open).
describe("UI-3 C1 add-on — the error tail's 点击查看 hint", () => {
  it("collapsed: first line + the hint; expanded: the first line alone", async () => {
    const c = mount(
      <SimpleActivityCard
        entry={{ kind: "tool", name: "shell", summary: "npm t", isError: true, resultPreview: "exit 1: 断言失败\nat spec:42" }}
      />,
    );
    const tail = c.querySelector(".act .act-tail") as HTMLElement;
    // firstLine() marks the truncation with " …" — the hint follows it.
    expect(tail.textContent).toBe("exit 1: 断言失败 … · 点击查看");
    await act(async () => {
      (c.querySelector(".act .act-row") as HTMLButtonElement).click();
    });
    expect((c.querySelector(".act .act-tail") as HTMLElement).textContent).toBe("exit 1: 断言失败 …");
  });
});

// ---------------------------------------------------------------------------
// UI-5 C7-A — the running edit card is honest: a write still in flight
// renders ◐ (never a premature ✓), the simple face never shows the SAME
// running write twice (card + busy row), and the tool card's status rides
// the completed state, not the preview's presence.
// ---------------------------------------------------------------------------
describe("UI-5 C7-A — the edit card's running state", () => {
  const EDIT: HistoryEntry = { kind: "edit", path: "src/pages/Login.tsx", oldString: "const a = 1;", newString: "const a = 2;" };

  it("isEditRunning: matches edit AND write_file busy rows by exact path; rejects other paths/tools/empty", () => {
    expect(isEditRunning({ kind: "edit", path: "src/a.ts", oldString: "x", newString: "y" }, [{ name: "edit", summary: "src/a.ts" }])).toBe(true);
    expect(isEditRunning({ kind: "edit", path: "src/a.ts", oldString: "x", newString: "y" }, [{ name: "write_file", summary: "src/a.ts" }])).toBe(true);
    expect(isEditRunning({ kind: "edit", path: "src/a.ts", oldString: "x", newString: "y" }, [{ name: "edit", summary: "src/other.ts" }])).toBe(false);
    expect(isEditRunning({ kind: "edit", path: "src/a.ts", oldString: "x", newString: "y" }, [{ name: "read_file", summary: "src/a.ts" }])).toBe(false);
    expect(isEditRunning({ kind: "edit", path: "src/a.ts", oldString: "x", newString: "y" }, [])).toBe(false);
  });

  it("busyToolHasCard: edit always has its card; write_file only when an edit entry with the same path exists; others never", () => {
    const history: readonly HistoryEntry[] = [{ kind: "edit", path: "src/exist.ts", oldString: "a", newString: "b" }];
    expect(busyToolHasCard({ name: "edit", summary: "src/anything.ts" }, history)).toBe(true);
    expect(busyToolHasCard({ name: "write_file", summary: "src/exist.ts" }, history)).toBe(true);
    expect(busyToolHasCard({ name: "write_file", summary: "src/brand-new.ts" }, history)).toBe(false);
    expect(busyToolHasCard({ name: "read_file", summary: "src/exist.ts" }, history)).toBe(false);
    expect(busyToolHasCard({ name: "shell", summary: "pnpm t" }, history)).toBe(false);
  });

  it("in the shell: a flying edit card reads ◐ (data-status run + spinner + 正在写入…) and its busy row is DEDUPED — one ◐ per write", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, {}, [EDIT]);
    });
    await replySettings(h, "simple");
    await act(async () => {
      sendState(h, { busy: true, live: { reasoning: "", answer: "", busyTools: [{ name: "edit", summary: "src/pages/Login.tsx" }] } });
    });
    const card = h.container.querySelector(".act[data-kind='diff']") as HTMLElement;
    expect(card.getAttribute("data-status")).toBe("run"); // ◐, not a lying ✓
    const row = card.querySelector(".act-row") as HTMLElement;
    expect(row.getAttribute("data-status")).toBe("run");
    expect(row.querySelector(".act-st.st-run svg.spin")).not.toBeNull();
    expect(row.querySelector(".sr-only")?.textContent).toBe("进行中");
    expect((row.querySelector(".act-tail") as HTMLElement).textContent).toBe("正在写入…");
    // The dedup: the busy row for the SAME write is gone from .turnlive —
    // the card IS the running surface. Only unrelated rows survive there.
    expect(h.container.querySelectorAll(".turnlive .act").length).toBe(0);
  });

  it("write_file dedup discriminates: an overwrite (edit entry exists) loses its busy row; a new file keeps it", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, {}, [{ kind: "edit", path: "src/exist.ts", oldString: "old", newString: "new" }]);
    });
    await replySettings(h, "simple");
    await act(async () => {
      sendState(h, {
        busy: true,
        live: {
          reasoning: "",
          answer: "",
          busyTools: [
            { name: "write_file", summary: "src/exist.ts" }, // overwrite → has a card
            { name: "write_file", summary: "src/brand-new.ts" }, // new file → no card
            { name: "read_file", summary: "src/x.ts" }, // never carded while running
          ],
        },
      });
    });
    // The overwrite's diff card runs via the write_file busy row (the
    // predicate must include it — the scout's point).
    const diff = h.container.querySelector(".act[data-kind='diff']") as HTMLElement;
    expect(diff.getAttribute("data-status")).toBe("run");
    // .turnlive keeps exactly the two cardless rows.
    const rows = [...h.container.querySelectorAll(".turnlive .act")] as HTMLElement[];
    expect(rows.map((r) => r.getAttribute("data-kind"))).toEqual(["inout", "read"]);
    expect(rows.some((r) => r.textContent?.includes("src/exist.ts"))).toBe(false);
  });

  it("landing flips the card once: busyTools empties → ✓ (ok) + 查看改动; the spinner is gone", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, {}, [EDIT]);
    });
    await replySettings(h, "simple");
    await act(async () => {
      sendState(h, { busy: true, live: { reasoning: "", answer: "", busyTools: [{ name: "edit", summary: "src/pages/Login.tsx" }] } });
    });
    expect(h.container.querySelector(".act[data-kind='diff']")?.getAttribute("data-status")).toBe("run");
    await act(async () => {
      sendState(h, { busy: false, live: { reasoning: "", answer: "", busyTools: [] } });
    });
    const card = h.container.querySelector(".act[data-kind='diff']") as HTMLElement;
    expect(card.getAttribute("data-status")).toBe("ok"); // ✓ — the honest flip
    expect(card.querySelector(".act-row")?.getAttribute("data-status")).toBe("ok");
    expect(card.querySelector(".act-st svg.spin")).toBeNull();
    expect((card.querySelector(".act-tail") as HTMLElement).textContent).toBe("查看改动");
  });

  it("card-level: running defaults to false — a bare SimpleActivityCard edit stays settled ✓", () => {
    const c = mount(<SimpleActivityCard entry={EDIT} />);
    expect(c.querySelector(".act")?.getAttribute("data-status")).toBe("ok");
  });

  it("status derivation: a completed-but-empty tool result is ✓ ok (no eternal spin) — the HistoryList M3 rule ported over", () => {
    const c = mount(
      <SimpleActivityCard entry={{ kind: "tool", name: "shell", summary: "true", resultPreview: "" }} />,
    );
    expect(c.querySelector(".act")?.getAttribute("data-status")).toBe("ok");
    expect(c.querySelector(".act .act-st svg.spin")).toBeNull();
    expect((c.querySelector(".act .act-row .sr-only") as HTMLElement).textContent).toBe("完成");
    // isError still reads ✕ err.
    const err = mount(
      <SimpleActivityCard entry={{ kind: "tool", name: "shell", summary: "x", isError: true, resultPreview: "boom" }} />,
    );
    expect(err.querySelector(".act")?.getAttribute("data-status")).toBe("err");
  });
});

// ---------------------------------------------------------------------------
// ω99-63 — the busy tool row's live tail line: a streaming call's bounded
// tail (driver-side, ≤2000 chars) renders as ONE dim line under the row —
// the LAST non-empty line of the tail, truncated. Minimal visual change:
// no tail → no line (old rows byte-identical).
// ---------------------------------------------------------------------------
describe("ω99-63 — busy tool live tail line", () => {
  const TAIL_MULTI = "PASS src/a.test.ts\nFAIL src/b.test.ts\n  ● b suite › case 2 expects 3\n";
  const TAIL_LONG = "z".repeat(300);

  it("a row with a tail renders the last-3-lines dim tail (品牌弧补丁：执行过程可见)", async () => {
    const h = mountedApp();
    await act(async () => { authOk(h.server.socket); });
    await replySettings(h, "simple");
    await act(async () => {
      sendState(h, {
        busy: true,
        live: {
          reasoning: "",
          answer: "",
          busyTools: [
            { name: "shell", summary: "pnpm test", gating: false, callId: "c1", tail: TAIL_MULTI },
            { name: "read_file", summary: "src/x.ts", gating: false, callId: "c2", tail: TAIL_LONG },
          ],
        },
      });
    });
    const cards = [...h.container.querySelectorAll(".turnlive .act")] as HTMLElement[];
    expect(cards.length).toBe(2);
    const line1 = cards[0]?.querySelector(".act-tail-line") as HTMLElement;
    expect(line1).not.toBeNull();
    expect(line1.textContent).toBe("PASS src/a.test.ts\nFAIL src/b.test.ts\n  ● b suite › case 2 expects 3"); // 品牌弧补丁：最近 3 行
    // A single long line truncates with the ellipsis marker.
    const line2 = cards[1]?.querySelector(".act-tail-line") as HTMLElement;
    expect(line2?.textContent).toBe(`${"z".repeat(300)}`); // 品牌弧补丁：全文不再截断（审计完整性）
    // The tail line sits INSIDE the run card (a second row), not in .act-row.
    expect(cards[0]?.querySelector(".act-row .act-tail-line")).toBeNull();
  });

  it("a row without a tail renders NO tail line (old rows byte-identical)", async () => {
    const h = mountedApp();
    await act(async () => { authOk(h.server.socket); });
    await replySettings(h, "simple");
    await act(async () => {
      sendState(h, {
        busy: true,
        live: {
          reasoning: "",
          answer: "",
          busyTools: [{ name: "read_file", summary: "src/y.ts", gating: false }],
        },
      });
    });
    const cards = [...h.container.querySelectorAll(".turnlive .act")] as HTMLElement[];
    expect(cards.length).toBe(1);
    expect(cards[0]?.querySelector(".act-tail-line")).toBeNull();
  });
});
