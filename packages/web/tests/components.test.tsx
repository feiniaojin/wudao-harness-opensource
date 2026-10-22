// @vitest-environment jsdom
// Component render + interaction tests: the full App wired to a fake-WS
// client (scripted frames in, asserted DOM out) plus the standalone modal
// components. jsdom for the DOM; React 19's act drives the store→render
// transitions.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WudaoClient } from "../src/protocol.js";
import type { DriverStatus } from "../src/protocol.js";
import { App } from "../src/components/App.js";
import { AskUserCards } from "../src/components/AskUserCards.js";
import { PermissionModal } from "../src/components/PermissionModal.js";
import { HistoryItem } from "../src/components/HistoryList.js";
import { StatusBar } from "../src/components/StatusBar.js";
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

/** Type into a controlled input/textarea the way a real browser does (the
 *  native value setter, then the input event) — React's synthetic onChange
 *  ignores a bare .value assignment + dispatch under jsdom. */
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
});

interface AppHarness {
  container: HTMLElement;
  client: WudaoClient;
  server: FakeServer;
}

function mountedApp(history: DriverStatus extends never ? never : readonly unknown[] = []): AppHarness {
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

describe("App conversation surface", () => {
  it("renders every history entry shape after the auth replay", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, { sessionId: "wudao-live-9" }, [
        { kind: "divider", text: "resumed wudao-liv · 3 messages" },
        { kind: "user", text: "fix the bug\nsecond line" },
        { kind: "assistant", text: "# Done\nFixed `x`." },
        { kind: "tool", name: "edit", summary: "src/a.ts", resultPreview: "ok" },
        { kind: "tool", name: "shell", summary: "npm t", isError: true },
        { kind: "edit", path: "src/a.ts", oldString: "a\nb", newString: "a\nB" },
        { kind: "board", done: 1, total: 2, lines: ["☑ done thing", "◐ wip thing"] },
        { kind: "notice", text: "compacted" },
        { kind: "error", text: "boom" },
      ]);
    });
    const text = h.container.textContent ?? "";
    expect(text).toContain("── resumed wudao-liv · 3 messages ──");
    expect(text).toContain("fix the bug …"); // first-line echo (M64-visual §3: the › marker left with the bubble)
    expect(text).toContain("Done"); // the heading text — the literal `#` prefix left with the 2026-08-26 §3.2 change
    expect(text).toContain("✓ edit(src/a.ts)"); // fix round 1: mockup-v2 glyphs
    expect(text).toContain("↳ ok");
    expect(text).toContain("✕ shell(npm t)");
    expect(text).toContain("[error]");
    // 0.3.82（0.3.81 凌乱反馈）: the edit entry renders the shared collapsed
    // EditCard now (one card language on both faces) — the diff lives behind
    // the row's 查看改动 toggle, so the old bare-DiffView pins (path head
    // always in the DOM, - b/+ B always printed) read from the EXPANDED
    // body. Collapsed first: the 32px row names the file.
    const editCard = h.container.querySelector(".act[data-kind='diff']") as HTMLElement;
    expect(editCard).not.toBeNull();
    expect(editCard.querySelector(".act-row")?.getAttribute("aria-expanded")).toBe("false");
    expect(editCard.querySelector(".act-row")?.textContent).toContain("src/a.ts");
    expect(editCard.querySelector(".act-row")?.textContent).toContain("查看改动");
    expect(h.container.querySelector(".diff .path")).toBeNull(); // the diff is folded
    await act(async () => {
      (editCard.querySelector(".act-row") as HTMLButtonElement).click();
    });
    // inkline T3: the edit card's ✏️ prefix was an icon slot — it renders an
    // IconFileText svg now (spec §1.5), so the pin moves from the unicode
    // glyph to the svg + the path text.
    const diffPath = h.container.querySelector(".diff .path");
    expect(diffPath?.textContent).toContain("src/a.ts");
    expect(diffPath?.querySelector("svg")).not.toBeNull();
    const textAfter = h.container.textContent ?? "";
    expect(textAfter).toContain("- b");
    expect(textAfter).toContain("+ B");
    // 墨线 T11 (controller 补完): the history board DELEGATES to the
    // re-shelled TodoBoard — .todo > .todo-bar (2px accent line, inline
    // width = done/total) + .todo-box checkbox rows. The old inline .board
    // case (📋 head + mark-carrying text) is retired WITH its text pins —
    // the .todo-bar/.todo-box asserts are the discriminator it fails.
    expect(h.container.querySelector(".todo > .todo-bar")).not.toBeNull();
    expect((h.container.querySelector(".todo-bar") as HTMLElement).style.width).toBe("50%");
    expect(h.container.querySelector(".todo-box.done svg")).not.toBeNull();
    expect(h.container.querySelectorAll(".todo-box")).toHaveLength(2);
    expect(text).toContain("done thing"); // marks stripped into the checkbox
    expect(text).toContain("wip thing");
    expect(h.container.querySelector(".entry-notice")?.textContent).toContain("compacted");
    expect(h.container.querySelector(".entry-error")?.textContent).toContain("boom");
    expect(text).toContain("wudao · wudao-li");
  });

  it("0.3.15: a durationMs-carrying assistant reply renders the duration meta tail; absent stays silent", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, { sessionId: "wudao-dur-9" }, [
        { kind: "assistant", text: "with timing", durationMs: 2_100 },
        { kind: "assistant", text: "legacy server reply" },
      ]);
    });
    const metas = h.container.querySelectorAll(".reply-card .reply-meta");
    expect(metas).toHaveLength(1); // only the duration-carrying reply
    expect(metas[0]?.textContent).toBe("· 2.1s");
    expect(h.container.textContent ?? "").toContain("legacy server reply");
  });

  it("v7 γ3: a servedBy-carrying reply renders 「本轮由 X（降级）作答」; primary-model replies stay silent", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, { sessionId: "wudao-served-3" }, [
        { kind: "assistant", text: "fallback answered", servedBy: { model: "deepseek-v4-flash", from: "deepseek-v4" } },
        { kind: "assistant", text: "primary answered" },
      ]);
    });
    const served = h.container.querySelectorAll(".reply-card .reply-meta[data-served-by]");
    expect(served).toHaveLength(1); // omit-when-no-fallback：主模型作答的回复零注记
    expect(served[0]?.textContent).toBe("· 本轮由 deepseek-v4-flash（降级）作答");
    expect(served[0]?.getAttribute("data-served-by")).toBe("deepseek-v4-flash");
    expect(h.container.textContent ?? "").toContain("primary answered");
    expect(h.container.textContent ?? "").not.toContain("primary answered）作答");
  });

  it("streams live state: reasoning head, answer, busy tool, steering queue", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, {
        busy: true,
        live: {
          reasoning: "l1\nl2\nl3\nthinking hard about it",
          answer: "partial ans",
          busyTools: [{ name: "read_file", summary: "src/x.ts", gating: true }],
        },
        queued: ["steer this"],
      });
    });
    const text = h.container.textContent ?? "";
    expect(text).toContain("思考过程"); // 0.3.8: the concluded label (this old-server frame carries no thinking flag)
    expect(text).toContain("partial ans");
    // 墨线 T10: the busy tool rides the timeline row contract now — verb +
    // mono file (读取 src/x.ts), not the raw `name(summary)` RPC line.
    expect(text).toContain("读取");
    expect(text).toContain("src/x.ts");
    // ω99-160: gating 尾 / steering 行随源中文化——钉的语义不变
    // （gating 尾在场 / 队列行在场），文案随源走。
    expect(text).toContain("检查中");
    expect(text).toContain("将在下一步前注入:steer this");
    // ω99-152: interrupt chip 文案中文化（原 "interrupt (Esc)"）——
    // 断言语义不变：busy 帧 ⇒ 中断 chip 可见。
    expect(text).toContain("停止 (Esc)");
  });

  it("the status bar renders the full segment set from one state frame", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, {
        mode: "auto",
        ctxTokens: { used: 12345, window: 131072, nearLimit: false },
        cachePercent: 89,
        boardProgress: { done: 3, total: 5 },
        bg: { active: 1, spawned: 2 },
        sidecar: { checks: 4, breakerOpen: true },
      });
    });
    const bar = h.container.querySelector(".statusline");
    // ω99-298 (M14): 模型/模式段退役（composer chips 是唯一家）——负钉钉死不回潮。
    expect(bar?.textContent).not.toContain("模式 auto");
    expect(bar?.textContent).not.toContain("模型 ");
    expect(bar?.textContent).toContain("ctx 12.3k/131.1k");
    expect(bar?.textContent).toContain("cache 89%");
    expect(bar?.textContent).toContain("3/5"); // 116 弧 C：▣ → list-checks 细线字形
    expect(bar?.textContent).toContain("bg 1/2");
    expect(bar?.textContent).toContain("sidecar 4");
    // 116 弧 C：🛡✕ 双字符熔断位 → shield-x 单字形（svg 在位，零 emoji）。
    expect(bar?.querySelector(".warn svg")).not.toBeNull();
    expect(bar?.textContent).not.toContain("🛡");
  });

  // ω99-195: B2 渲染负查——旧英文段前缀归零。ω99-298 (M14): 中文段本身
  // 也已退役（模型/模式 = composer chips 的重复显示），负查双向钉死。
  it("ω99-298: 模型/模式段退役 — both language forms are gone from the statusline", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, {
        mode: "auto",
        model: { label: "big-128k", provider: "deepseek" },
      });
    });
    const bar = h.container.querySelector(".statusline");
    expect(bar?.textContent).not.toContain("模式 auto");
    expect(bar?.textContent).not.toContain("模型 big-128k");
    expect(bar?.textContent).not.toContain("mode auto");
    expect(bar?.textContent).not.toContain("model big-128k");
    expect(bar?.textContent).toContain("wudao ·"); // token 保留（ctx/cache 段钉在上例 :178/:179）
  });
});

describe("App controls", () => {
  it("submit sends the op; a busy submit steers (outcome + queue)", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    const input = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(input, "hello agent");
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    const ops = h.server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } => typeof f === "object" && f !== null && "op" in f);
    expect(ops.some((o) => o.op.op === "submit" && o.op.text === "hello agent")).toBe(true);
  });

  it("shift+tab cycles the mode through the setMode op", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, { mode: "workspace" });
    });
    const input = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    });
    const ops = h.server.clientFrames().filter((f): f is { op: Record<string, unknown> } => typeof f === "object" && f !== null && "op" in f);
    expect(ops.some((o) => o.op.op === "setMode" && o.op.mode === "ask")).toBe(true);
  });

  it("the parked permission ask renders the modal; deny sends the op with the reason", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, {
        busy: true,
        pendingPermission: { toolName: "write_file", summary: "src/a.ts", input: {} },
      });
    });
    // ω99-154: 标题与键钮文案中文化——既有钉钉的是标题全串与选项在场，文案随源走。
    expect(h.container.textContent).toContain("允许 write_file：src/a.ts？");
    expect(h.container.textContent).toContain("a — 本会话");
    // ω99-154: y/n 两钮此前无测试钉，补最小断言各一条
    // （标题/a/p 全串已由本用例既有钉随源演进覆盖，不重复钉）。
    expect(h.container.textContent).toContain("y — 仅本次");
    expect(h.container.textContent).toContain("n — 拒绝…");
    // 0.3.14 #1: the always button rides the same card (protected asks omit it
    // — pinned in the settingsFile test below).
    expect(h.container.textContent).toContain("p — 总是");
    // settings-trial r7: the ask is an INLINE card — no scrim anywhere, the
    // card rides the chat column (a .chat sibling, the composer slot above),
    // so the conversation stays visible and scrollable while it pends.
    expect(h.container.querySelector(".scrim")).toBeNull();
    expect(h.container.querySelector(".chat ~ .permission-card")).not.toBeNull();
    // n opens the reason input; Enter denies with it.
    await act(async () => {
      (h.container.querySelector("button.danger") as HTMLButtonElement).click();
    });
    const reason = h.container.querySelector("input.wudao-input") as HTMLInputElement;
    expect(reason).not.toBeNull();
    // ω99-152: 理由视图两条文案中文化（原 "why (flows back to the model)" /
    // "deny without reason (Esc)"）——此前无测试钉，补最小断言各一条。
    expect(reason.placeholder).toBe("理由（会回传给模型）");
    expect(h.container.textContent).toContain("不带理由拒绝 (Esc)");
    // ω99-154 小刀（concern① 收口）：理由视图标题与确认钮两串（154 的
    // :152/:179）此前零钉——补最小断言各一条，与上方 152 钉同帧。
    expect(h.container.textContent).toContain("拒绝 write_file — 理由（可选）");
    expect(h.container.textContent).toContain("拒绝");
    await act(async () => {
      type(reason, "not safe");
    });
    await act(async () => {
      reason.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    const ops = h.server.clientFrames().filter((f): f is { op: Record<string, unknown> } => typeof f === "object" && f !== null && "op" in f);
    expect(ops.some((o) => o.op.op === "answerPermission" && o.op.allow === false && o.op.reason === "not safe")).toBe(true);
  });

  it("a settingsFile ask degrades to plain y/N (no session/always buttons)", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, {
        pendingPermission: { toolName: "write_file", summary: ".wudao/settings.json", input: {}, settingsFile: ".wudao/settings.json" },
      });
    });
    // ω99-154: 策略文件变体标题随源中文化——本钉钉的是降级语义（a/p 不在场），文案随源走。
    expect(h.container.textContent).toContain("策略文件 .wudao/settings.json");
    expect(h.container.textContent).not.toContain("a — 本会话");
    expect(h.container.textContent).not.toContain("p — 总是");
  });

  it("0.3.14: the a button sends scope session; the p button sends scope always", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, {
        busy: true,
        pendingPermission: { toolName: "shell", summary: "pnpm test", input: { command: "pnpm test" } },
      });
    });
    const buttons = [...h.container.querySelectorAll("button.wudao:not(.danger)")] as HTMLButtonElement[];
    // ω99-154: a/p 按钮定位串随源走——本钉钉的是 scope 语义。
    const session = buttons.find((b) => b.textContent?.includes("a — 本会话"));
    expect(session).toBeDefined();
    await act(async () => {
      session?.click();
    });
    const ops = h.server.clientFrames().filter((f): f is { op: Record<string, unknown> } => typeof f === "object" && f !== null && "op" in f);
    expect(ops.some((o) => o.op.op === "answerPermission" && o.op.allow === true && o.op.scope === "session")).toBe(true);
    // a fresh mount answers `p` — the op carries scope "always".
    const h2 = mountedApp();
    await act(async () => {
      authOk(h2.server.socket, {
        busy: true,
        pendingPermission: { toolName: "shell", summary: "pnpm build", input: { command: "pnpm build" } },
      });
    });
    const always = [...h2.container.querySelectorAll("button.wudao:not(.danger)")].map((b) => b as HTMLButtonElement)
      .find((b) => b.textContent?.includes("p — 总是"));
    expect(always).toBeDefined();
    await act(async () => {
      always?.click();
    });
    const ops2 = h2.server.clientFrames().filter((f): f is { op: Record<string, unknown> } => typeof f === "object" && f !== null && "op" in f);
    expect(ops2.some((o) => o.op.op === "answerPermission" && o.op.allow === true && o.op.scope === "always")).toBe(true);
  });

  it("/help renders the live command list as a local notice", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    // The connected-effect sends listSlashCommands; answer it in its own act.
    await act(async () => {
      const ops = h.server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } => typeof f === "object" && f !== null && "op" in f);
      h.server.socket.serverSend({
        t: "result",
        id: ops[0]?.id,
        ok: [{ name: "plan", description: "plan read-only", args: "<goal>", source: "builtin" }],
      });
    });
    const input = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(input, "/help");
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(h.container.textContent).toContain("命令："); // ω99-162: commands: 头钉随源演进。
    expect(h.container.textContent).toContain("/plan <goal>");
    expect(h.container.textContent).toContain("Ctrl+P 文件搜索"); // ω99-162 NEW#4: web /help 键位行中文化。
    // /help is frontend-owned: no submit op went out for it.
    const ops = h.server.clientFrames().filter((f): f is { op: Record<string, unknown> } => typeof f === "object" && f !== null && "op" in f);
    expect(ops.some((o) => o.op.op === "submit" && o.op.text === "/help")).toBe(false);
  });

  it("the plan board renders the ok / 改 review card", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, { planBoard: "1. step one\n2. step two" });
    });
    expect(h.container.textContent).toContain("plan — review before execution");
    await act(async () => {
      (h.container.querySelector(".planboard button.primary") as HTMLButtonElement).click();
    });
    const ops = h.server.clientFrames().filter((f): f is { op: Record<string, unknown> } => typeof f === "object" && f !== null && "op" in f);
    expect(ops.some((o) => o.op.op === "submit" && o.op.text === "ok")).toBe(true);
  });

  it("/resume opens the picker and picking loads through the resume op", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    const opsOf = (): { id: number; op: Record<string, unknown> }[] =>
      h.server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } => typeof f === "object" && f !== null && "op" in f);
    await act(async () => {
      // Answer the connected-effect's listSlashCommands (empty registry).
      h.server.socket.serverSend({ t: "result", id: opsOf()[0]?.id, ok: [] });
    });
    const input = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(input, "/resume");
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    // ω99-156: App's boot-time activeName listing is ALSO a sessions op on
    // the wire now — answer the PICKER's op, the LATEST sessions op (the
    // buddy-mode test's .at(-1) idiom for the same reason).
    const sessionsOp = opsOf().filter((o) => o.op.op === "sessions").at(-1);
    expect(sessionsOp).toBeDefined();
    await act(async () => {
      h.server.socket.serverSend({
        t: "result",
        id: sessionsOp?.id,
        ok: [{ id: "wudao-old-1", mtime: "2026-08-16T10:00:00.000Z", messages: 4, firstUser: "fix bug", model: "deepseek" }],
      });
    });
    expect(h.container.textContent).toContain("选择要恢复的会话");
    expect(h.container.textContent).toContain("wudao-ol"); // id8
    await act(async () => {
      (h.container.querySelector(".pickrow") as HTMLButtonElement).click();
    });
    const ops = opsOf();
    expect(ops.some((o) => o.op.op === "resume" && o.op.id === "wudao-old-1")).toBe(true);
  });

  // ui-review-r2 C1: the typed /clear now rides the SAME path the + button
  // uses — the confirm submits /clear to the driver; a "frontend" outcome
  // (the driver defers the render to the client) is when the local view
  // wipe runs. The view-only clearView is the offline/refused fallback.
  it("/clear confirms → submit('/clear') on the wire; a frontend outcome wipes the view", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, {}, [{ kind: "user", text: "old turn" }]);
    });
    const input = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(input, "/clear");
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(h.container.textContent).toContain("清空历史");
    await act(async () => {
      (h.container.querySelector(".modal-card button.danger") as HTMLButtonElement).click();
    });
    // The confirm went to the DRIVER first — one submit op, text /clear.
    const ops = h.server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } => typeof f === "object" && f !== null && "op" in f);
    const clearOps = ops.filter((o) => o.op.op === "submit" && o.op.text === "/clear");
    expect(clearOps).toHaveLength(1);
    // Until the reply lands, nothing is wiped (the driver owns the clear).
    expect(h.container.textContent).toContain("old turn");
    await act(async () => {
      h.server.socket.serverSend({ t: "result", id: clearOps[0]?.id, ok: "frontend" });
    });
    expect(h.container.textContent).not.toContain("old turn");
    expect(h.container.textContent).toContain("历史已清空");
  });

  it("after the reconnect cap the gave-up banner offers a manual 重连; controls disable offline", async () => {
    const server = fakeServer();
    const timers: ((() => void) | undefined)[] = [];
    const client = new WudaoClient({
      url: "ws://127.0.0.1:1",
      token: "t",
      wsFactory: () => server.spawn(),
      setTimeout: (fn) => {
        timers.push(fn);
        return timers.length - 1;
      },
      clearTimeout: (h) => {
        if (typeof h === "number") timers[h] = undefined;
      },
    });
    const container = mount(<App client={client} />);
    act(() => {
      client.connect();
      server.socket.serverOpen();
    });
    await act(async () => {
      authOk(server.socket, {}, [{ kind: "user", text: "kept" }]);
    });
    // 9 abnormal closes: 8 retries then the terminal state.
    act(() => {
      for (let i = 0; i < 9; i++) {
        server.socket.serverClose(1006, "");
        if (client.getSnapshot().connection !== "reconnecting") break; // gave-up tripped
        timers[timers.length - 1]?.();
      }
    });
    expect(container.textContent).toContain("连接已断开");
    const send = container.querySelector("button.send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(container.textContent).toContain("kept"); // history stays visible
    await act(async () => {
      (container.querySelector(".banner button") as HTMLButtonElement).click();
    });
    expect(container.textContent).not.toContain("连接已断开");
    await act(async () => {
      server.socket.serverOpen();
      authOk(server.socket);
    });
    // Back online: the hint line is gone entirely (M65-space §2 — connected
    // renders no .hint; the send button also re-enables once a draft exists,
    // `connected` is its only other disable source).
    expect(container.querySelector(".inputarea > .hint")).toBeNull();
    expect(container.textContent).not.toContain("离线——");
  });

  it("mode clicks while offline queue and flush after the reconnect (no error toast)", async () => {
    const server = fakeServer();
    const timers: ((() => void) | undefined)[] = [];
    const client = new WudaoClient({
      url: "ws://127.0.0.1:1",
      token: "t",
      wsFactory: () => server.spawn(),
      setTimeout: (fn) => {
        timers.push(fn);
        return timers.length - 1;
      },
      clearTimeout: (h) => {
        if (typeof h === "number") timers[h] = undefined;
      },
    });
    const container = mount(<App client={client} />);
    act(() => {
      client.connect();
      server.socket.serverOpen();
    });
    await act(async () => {
      authOk(server.socket);
    });
    act(() => {
      server.socket.serverClose(1006, "");
    });
    // Mode change while offline rides the keyboard path (0.3.13: the
    // modechip retired; the ShieldSelector chip is disabled offline, but a
    // bare shift+tab still cycles): no ⚠️ notice, no op on a dead socket.
    await act(async () => {
      (container.querySelector("textarea.wudao-input") as HTMLTextAreaElement)
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(container.textContent).not.toContain("setMode failed");
    await act(async () => {
      timers[0]?.();
      server.socket.serverOpen();
      authOk(server.socket);
    });
    const ops = server.clientFrames().filter((f): f is { op: Record<string, unknown> } => typeof f === "object" && f !== null && "op" in f);
    expect(ops.some((o) => o.op.op === "setMode" && o.op.mode === "ask")).toBe(true);
  });

  it("the reconnect banner shows while reconnecting, then the replay restores", async () => {
    const server = fakeServer();
    const timers: ((() => void) | undefined)[] = [];
    const client = new WudaoClient({
      url: "ws://127.0.0.1:1",
      token: "t",
      wsFactory: () => server.spawn(),
      setTimeout: (fn) => {
        timers.push(fn);
        return timers.length - 1;
      },
      clearTimeout: (h) => {
        if (typeof h === "number") timers[h] = undefined;
      },
    });
    const container = mount(<App client={client} />);
    act(() => {
      client.connect();
      server.socket.serverOpen();
    });
    await act(async () => {
      authOk(server.socket, {}, [{ kind: "user", text: "before" }]);
    });
    act(() => {
      server.socket.serverClose(1006, "");
    });
    expect(container.textContent).toContain("连接断开(close 1006) — 正在重连");
    await act(async () => {
      timers[0]?.();
      server.socket.serverOpen();
      authOk(server.socket, {}, [{ kind: "user", text: "before" }, { kind: "assistant", text: "after" }]);
    });
    expect(container.textContent).not.toContain("reconnecting");
    expect(container.textContent).toContain("after");
  });
});

describe("standalone components", () => {
  it("HistoryItem: unknown-free render of each kind", () => {
    const c = mount(<HistoryItem entry={{ kind: "notice", text: "n" }} />);
    expect(c.textContent).toBe("n");
  });

  // 0.3.6 反馈：系统通知以居中系统气泡呈现（.entry-notice 容器 +
  // .notice-bub 胶囊），不再是一条裸灰线；文本原样保留。
  it("HistoryItem notice: centered system bubble (0.3.6 反馈)", () => {
    const c = mount(<HistoryItem entry={{ kind: "notice", text: "已切换到简洁模式 — 重载后完全生效" }} />);
    const bub = c.querySelector(".entry-notice > .notice-bub");
    expect(bub).not.toBeNull();
    expect(bub?.textContent).toBe("已切换到简洁模式 — 重载后完全生效");
    // 无 detail（短通知无信息丢失）→ 不渲染展开箭头。
    expect(c.querySelector(".notice-exp")).toBeNull();
    expect(c.querySelector(".notice-detail")).toBeNull();
  });

  // 0.3.6 反馈追修（0.3.7）：截断的 meta_note 预览携带全文 detail——
  // 胶囊尾部展开箭头，点击展开全文块、再点收起（ToolCard CapToggle 同款契约）。
  it("HistoryItem notice: detail expands in place (0.3.6 反馈追修)", async () => {
    const c = mount(
      <HistoryItem
        entry={{
          kind: "notice",
          text: "↳ <EXTREMELY_IMPORTANT> You have superpowers. **Below is the full content of your 'superpowers:using-s…",
          detail: "<EXTREMELY_IMPORTANT> You have superpowers.\n**Below is the full content of your 'superpowers:using-superpowers' skill - your introduction to using skills.**\nIf you think…",
        }}
      />,
    );
    expect(c.querySelector(".notice-detail")).toBeNull(); // 收起态
    const exp = c.querySelector(".notice-exp") as HTMLButtonElement;
    expect(exp).not.toBeNull();
    expect(exp.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      exp.click();
    });
    const detail = c.querySelector(".notice-detail");
    expect(detail?.textContent).toContain("your introduction to using skills");
    expect((c.querySelector(".notice-exp") as HTMLButtonElement).getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      (c.querySelector(".notice-exp") as HTMLButtonElement).click();
    });
    expect(c.querySelector(".notice-detail")).toBeNull(); // 收起
  });

  it("StatusBar: null status renders nothing", () => {
    expect(mount(<StatusBar status={null} />).querySelector(".statusline")).toBeNull();
  });

  // M76-ux2 §8 — the ctx segment's hover breakdown: the ctxInfo op's
  // four sections ride the title attribute (newline-separated), fetched on
  // mount and again only when ctx.used moves by >1k. Without the op (old
  // server / not wired) the title degrades to the generic label.
  it("StatusBar ctx hover: ctxInfo lands as a multi-line title; without it the generic label stands", async () => {
    const withCtx = { ...baseStatus(), ctxTokens: { used: 27000, window: 64000, nearLimit: false } };
    const c1 = mount(
      <StatusBar
        status={withCtx}
        ctxInfo={() =>
          Promise.resolve({ systemTokens: 3000, toolsTokens: 2000, messagesTokens: 15000, availableTokens: 44000 })
        }
      />,
    );
    const ctxSeg = c1.querySelector(".statusline .seg-ctx") as HTMLElement;
    expect(ctxSeg.textContent).toContain("ctx 27k/64k");
    // Before the reply: the generic fallback, never empty.
    expect(ctxSeg.getAttribute("title")).toBe("上下文使用量");
    await act(async () => {});
    expect(ctxSeg.getAttribute("title")).toBe("系统提示 ~3k\n工具定义 ~2k\n消息历史 ~15k\n可用 ~44k");

    // No fetcher wired (old client / simple shells): the generic label stays.
    const c2 = mount(<StatusBar status={withCtx} />);
    await act(async () => {});
    expect((c2.querySelector(".statusline .seg-ctx") as HTMLElement).getAttribute("title")).toBe("上下文使用量");

    // A rejecting op (old server: unknown op) degrades the same way.
    const c3 = mount(<StatusBar status={withCtx} ctxInfo={() => Promise.reject(new Error("unknown op: ctxInfo"))} />);
    await act(async () => {});
    expect((c3.querySelector(".statusline .seg-ctx") as HTMLElement).getAttribute("title")).toBe("上下文使用量");
  });

  // R5-I1 — the hover's 图片 line: image riders finally count in the ctx
  // estimate, and the breakdown surfaces them as their own dimension — ONLY
  // when they exist (0 / absent / old server → the exact pre-R5-I1 title).
  it("StatusBar ctx hover: 图片 line appears only when imagesTokens > 0", async () => {
    const withCtx = { ...baseStatus(), ctxTokens: { used: 31000, window: 64000, nearLimit: false } };
    const c1 = mount(
      <StatusBar
        status={withCtx}
        ctxInfo={() =>
          Promise.resolve({ systemTokens: 3000, toolsTokens: 2000, messagesTokens: 15000, imagesTokens: 27000, availableTokens: 17000 })
        }
      />,
    );
    await act(async () => {});
    const title1 = (c1.querySelector(".statusline .seg-ctx") as HTMLElement).getAttribute("title") ?? "";
    expect(title1).toContain("图片 ~27k");
    expect(title1.indexOf("图片")).toBeGreaterThan(title1.indexOf("消息历史")); // between history…
    expect(title1.indexOf("可用")).toBeGreaterThan(title1.indexOf("图片")); // …and available

    const c2 = mount(
      <StatusBar
        status={withCtx}
        ctxInfo={() => Promise.resolve({ systemTokens: 3000, toolsTokens: 2000, messagesTokens: 15000, imagesTokens: 0, availableTokens: 44000 })}
      />,
    );
    await act(async () => {});
    expect((c2.querySelector(".statusline .seg-ctx") as HTMLElement).getAttribute("title")).toBe(
      "系统提示 ~3k\n工具定义 ~2k\n消息历史 ~15k\n可用 ~44k",
    );
  });

  it("StatusBar ctx hover re-fetches only on a >1k ctx.used delta", async () => {
    const fetchInfo = vi.fn(() =>
      Promise.resolve({ systemTokens: 3000, toolsTokens: 2000, messagesTokens: 15000, availableTokens: 44000 }),
    );
    const mk = (used: number): React.ReactElement => (
      <StatusBar status={{ ...baseStatus(), ctxTokens: { used, window: 64000, nearLimit: false } }} ctxInfo={fetchInfo} />
    );
    const c = mount(mk(27000));
    await act(async () => {});
    expect(fetchInfo).toHaveBeenCalledTimes(1); // mount fetch
    root?.render(mk(27500)); // +500 — under the delta, no refetch
    await act(async () => {});
    expect(fetchInfo).toHaveBeenCalledTimes(1);
    root?.render(mk(29000)); // +2000 — over the delta, refetch
    await act(async () => {});
    expect(fetchInfo).toHaveBeenCalledTimes(2);
  });

  // ω99-156 — 会话身份统一: the statusline head names the session the user
  // named it (the /rename lane, 150); the id8 stays as the precise handle
  // when no name exists. Both lanes pinned at the component seam; the :118
  // App-level `wudao · wudao-li` row stays the no-prop regression pin.
  it("StatusBar head 有名显示名: sessionName rides the first segment (ω99-156 例 A)", () => {
    const named = mount(<StatusBar status={{ ...baseStatus(), sessionId: "wudao-live-9" }} sessionName="修登录 bug" />);
    expect(named.textContent).toContain("wudao · 修登录 bug");
  });

  it("StatusBar head 无名兜底 id8: no sessionName keeps the pre-156 path byte-identical (ω99-156 例 B)", () => {
    const bare = mount(<StatusBar status={{ ...baseStatus(), sessionId: "wudao-live-9" }} />);
    expect(bare.textContent).toContain("wudao · wudao-li");
  });

  // ω99-156 App-level: activeName (App's own sessions read at the sidebar's
  // epochs) feeds BOTH identity surfaces — the topbar title and the
  // statusline head. The mock answers the effect's sessions op by id (the
  // /resume picker pattern at the sessionsOp lookup above).
  it("ω99-156: a named current session converges topbar + statusbar; unnamed keeps the heuristic lanes", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, { sessionId: "wudao-live-9" }, [{ kind: "user", text: "fix the bug\nsecond line" }]);
    });
    const opsOf = (): { id: number; op: Record<string, unknown> }[] =>
      h.server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } => typeof f === "object" && f !== null && "op" in f);
    const sessionsOp = opsOf().find((o) => o.op.op === "sessions");
    expect(sessionsOp).toBeDefined(); // the activeName effect asked for the store
    await act(async () => {
      h.server.socket.serverSend({
        t: "result",
        id: sessionsOp?.id,
        ok: [{ id: "wudao-live-9", mtime: "2026-09-07T10:00:00.000Z", messages: 1, firstUser: "fix the bug", model: "deepseek", name: "修登录 bug" }],
      });
    });
    expect((h.container.querySelector(".tb-name") as HTMLElement).textContent).toBe("修登录 bug");
    expect(h.container.textContent).toContain("wudao · 修登录 bug"); // the statusline head converges too

    // A row with no name (or a listing miss): both surfaces fail OPEN to the
    // pre-156 lanes — first-user heuristic up top, id8 in the strip.
    const h2 = mountedApp();
    await act(async () => {
      authOk(h2.server.socket, { sessionId: "wudao-live-9" }, [{ kind: "user", text: "fix the bug\nsecond line" }]);
    });
    const opsOf2 = (): { id: number; op: Record<string, unknown> }[] =>
      h2.server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } => typeof f === "object" && f !== null && "op" in f);
    const sessionsOp2 = opsOf2().find((o) => o.op.op === "sessions");
    await act(async () => {
      h2.server.socket.serverSend({
        t: "result",
        id: sessionsOp2?.id,
        ok: [{ id: "wudao-live-9", mtime: "2026-09-07T10:00:00.000Z", messages: 1, firstUser: "fix the bug", model: "deepseek" }],
      });
    });
    expect((h2.container.querySelector(".tb-name") as HTMLElement).textContent).toBe("fix the bug"); // the heuristic stands
    expect(h2.container.textContent).toContain("wudao · wudao-li");
  });

  it("AskUserCards: option cards answer by click; free text answers on Enter", async () => {
    const onAnswer = vi.fn();
    const c = mount(
      <AskUserCards
        question="Which DB?"
        options={[{ label: "postgres", description: "relational" }, { label: "sqlite" }]}
        onAnswer={onAnswer}
        onDismiss={() => {}}
      />,
    );
    expect(c.textContent).toContain("Which DB?"); // 116 弧 C：❓ → circle-help 细线字形
    await act(async () => {
      (c.querySelectorAll(".optioncard")[1] as HTMLButtonElement).click();
    });
    expect(onAnswer).toHaveBeenCalledWith("sqlite");
  });

  it("AskUserCards free-text variant", async () => {
    const onAnswer = vi.fn();
    const c = mount(<AskUserCards question="Name?" onAnswer={onAnswer} onDismiss={() => {}} />);
    const input = c.querySelector("input.wudao-input") as HTMLInputElement;
    await act(async () => {
      type(input, "wudao");
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(onAnswer).toHaveBeenCalledWith("wudao");
  });

  it("PermissionModal keyboard: y allows, esc denies (single-shot)", async () => {
    const onChoose = vi.fn();
    const c = mount(
      <PermissionModal ask={{ toolName: "shell", summary: "npm t", input: {} }} onChoose={onChoose} />,
    );
    const card = c.querySelector(".permission-card") as HTMLElement;
    await act(async () => {
      card.dispatchEvent(new KeyboardEvent("keydown", { key: "y", bubbles: true, cancelable: true }));
    });
    expect(onChoose).toHaveBeenCalledWith({ allow: true });
    // single-shot: a second key does nothing
    await act(async () => {
      card.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onChoose).toHaveBeenCalledTimes(1);
  });
});

// 2026-08-28 用户反馈: 模型切换不要弹窗 — the composer's ModelSelector chip
// dropdown (强度/模式同款 .pop/.menu) replaces the retired ModelPicker modal;
// the StatusBar model segment goes display-only. The App-level LANES keep
// their coverage here (a row click routes /model vs /provider via
// modelPickCommand; the 设为默认 footer persists the session model through
// settingsSet). The dropdown mechanics live in model-selector.test.tsx.
describe("model chip (the composer's ModelSelector dropdown)", () => {
  const MODEL_STATUS = {
    model: {
      label: "deepseek-v4",
      provider: "deepseek",
      choices: [
        { provider: "deepseek", model: "deepseek-v4", source: "profile" },
        { provider: "glm", model: "glm-5", source: "profile" },
        { provider: "qwen", model: "qwen4-max", source: "profile" },
      ],
    },
  };

  it("ω99-298 (M14): the model segment is retired — even with model data the statusline stays silent", () => {
    const withModel = mount(<StatusBar status={{ ...baseStatus(), ...MODEL_STATUS } as DriverStatus} />);
    expect(withModel.textContent).not.toContain("模型 deepseek-v4"); // composer chip 是唯一家
    expect(withModel.querySelector(".statusline .seg-btn")).toBeNull();
    const bare = mount(<StatusBar status={baseStatus()} />);
    expect(bare.textContent).not.toContain("model ");
  });

  it("a same-provider row click submits /model; a cross-provider row submits /provider; 设为默认 writes settingsSet", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, MODEL_STATUS, []);
    });
    const frames = (): { t?: string; op?: { op?: string; text?: string; key?: string; value?: unknown } }[] =>
      h.server.clientFrames() as { t?: string; op?: { op?: string; text?: string; key?: string; value?: unknown } }[];
    const lastSubmit = (): string | undefined => frames().filter((f) => f.t === "op" && f.op?.op === "submit").pop()?.op?.text;

    // Open the dropdown from the composer chip — 联动两栏 (2026-08-31 第四报):
    // 左列供应商行常驻,右栏自动跟随当前供应商(deepseek),打开即见其模型行。
    await act(async () => {
      (h.container.querySelector("button.chip.model") as HTMLButtonElement).click();
    });
    // ω99-218: 左列首位现在是「最近使用」虚拟组行(.mrec,boot 播种当前模型
    // 即自 populate)——供应商行计数排掉它(意图仍钉 3 家供应商)。
    expect(h.container.querySelectorAll(".menu .mroot .mi.mprov:not(.mrec)")).toHaveLength(3);
    expect(h.container.querySelector(".menu .mroot .mi.mrec")).not.toBeNull(); // (ω99-218 #R 续) 虚拟组在
    expect(h.container.querySelector(".menu .mpane .mgroup")?.textContent).toBe("deepseek");
    // Same-provider pick → /model (右栏直接点,无需先钻入)。
    await act(async () => {
      (h.container.querySelector(".menu .mi[data-model=\"deepseek-v4\"]") as HTMLButtonElement).click();
    });
    expect(h.container.querySelector(".menu")).toBeNull(); // closed after commit
    expect(lastSubmit()).toBe("/model deepseek-v4");

    // Reopen (resets to the auto focus); link glm on the LEFT column — the
    // provider column stays put — then its row rides the /provider lane
    // (M63 §A).
    await act(async () => {
      (h.container.querySelector("button.chip.model") as HTMLButtonElement).click();
    });
    await act(async () => {
      (h.container.querySelector('.menu .mroot .mi.mprov[data-provider="glm"]') as HTMLButtonElement).click();
    });
    expect(h.container.querySelectorAll(".menu .mroot .mi.mprov:not(.mrec)")).toHaveLength(3);
    await act(async () => {
      (h.container.querySelector(".menu .mi[data-model=\"glm-5\"]") as HTMLButtonElement).click();
    });
    expect(lastSubmit()).toBe("/provider glm");

    // Reopen; the footer persists the SESSION's current model as the boot
    // default (the R6 Ctrl+S lane, made visible).
    await act(async () => {
      (h.container.querySelector("button.chip.model") as HTMLButtonElement).click();
    });
    await act(async () => {
      (h.container.querySelector(".menu .mi.foot") as HTMLButtonElement).click();
    });
    const setOp = frames().filter((f) => f.t === "op" && f.op?.op === "settingsSet").pop()?.op;
    expect(setOp).toMatchObject({ key: "model.defaultModel", value: { provider: "deepseek", model: "deepseek-v4" } });
  });
});

/** A minimal valid DriverStatus the component tests can extend. */
function baseStatus(): DriverStatus {
  return {
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
    model: null,
  };
}

// 2026-08-28: the ModelPicker modal's numeric-hotkey and keyboard-lane
// describes retired WITH the modal (the dropdown chip has no digit buffer or
// arrow/Ctrl+S machinery — the TUI keeps /model <n>; the persist-default
// lane survives as the menu's 设为默认 footer, pinned in the model-chip
// describe above).

// M75-ux2 §12 — the composer's auto-grow: the textarea's rows track the
// buffer's VISUAL line count 1→6 — hard newlines AND soft-wrapped long
// lines (a char-width estimate off the live textarea; jsdom's unmeasured
// clientWidth falls back to 80 cols, which is what the assertions ride),
// capped at 6 (past it the textarea scrolls internally), shrinking back on
// delete and resetting to 1 on submit.
import { InputBox } from "../src/components/InputBox.js";

describe("InputBox auto-grow (M75-ux2 §12)", () => {
  const mountBox = (): HTMLTextAreaElement => {
    const c = mount(
      <InputBox
        busy={false}
        mode="workspace"
        commands={[]}
        connected={true}
        onShield={vi.fn()}
        onSubmit={vi.fn()}
        onInterrupt={vi.fn()}
        onCycleMode={vi.fn()}
      />,
    );
    return c.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
  };
  const rowsOf = (ta: HTMLTextAreaElement): number => Number(ta.getAttribute("rows"));

  it("starts at 1 row and grows with hard newlines", () => {
    const ta = mountBox();
    expect(rowsOf(ta)).toBe(1);
    type(ta, "a\nb");
    expect(rowsOf(ta)).toBe(2);
    type(ta, "a\nb\nc\nd");
    expect(rowsOf(ta)).toBe(4);
  });

  it("grows on a soft-wrapped long line (no newlines at all)", () => {
    const ta = mountBox();
    // 160 chars over the 80-col jsdom fallback → 2 visual rows.
    type(ta, "x".repeat(160));
    expect(rowsOf(ta)).toBe(2);
    type(ta, "x".repeat(240));
    expect(rowsOf(ta)).toBe(3);
  });

  it("caps at 6 rows (past it the textarea scrolls internally)", () => {
    const ta = mountBox();
    type(ta, Array.from({ length: 9 }, () => "line").join("\n"));
    expect(rowsOf(ta)).toBe(6);
    type(ta, "x".repeat(2000));
    expect(rowsOf(ta)).toBe(6);
  });

  it("shrinks on delete and resets to 1 on submit", () => {
    const ta = mountBox();
    type(ta, "a\nb\nc");
    expect(rowsOf(ta)).toBe(3);
    type(ta, "ab");
    expect(rowsOf(ta)).toBe(1);
    type(ta, "hello\nworld");
    act(() => {
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(ta.value).toBe("");
    expect(rowsOf(ta)).toBe(1);
  });
});

// inkline Task 3 (spec §1.5) — 图标系统 v2: the six new glyphs ride the
// unified 1.5 stroke, and icon slots carry SVG instead of bare Unicode.
// The brief's @testing-library/react `render` is unavailable here (zero new
// npm deps is a binding constraint) — the file's mount() helper renders the
// same tree; `container.querySelector("svg")` is the identical probe.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IconSearch, IconArrowUp, IconSlash, IconShield, IconCheck, IconSpinner } from "../src/components/icons.js";

describe("inkline icons v2", () => {
  it("ships the 6 new glyphs at stroke 1.5", () => {
    for (const I of [IconSearch, IconArrowUp, IconSlash, IconShield, IconCheck, IconSpinner]) {
      const container = mount(<I />);
      const svg = container.querySelector("svg");
      if (svg === null) throw new Error(`${I.name} rendered no svg`);
      expect(svg.getAttribute("stroke-width")).toBe("1.5");
    }
  });

  it("App.tsx icon slots use SVG, not unicode glyphs (◐×8/⚙×5 are all icon positions)", () => {
    // jsdom rewrites import.meta.url to http://localhost — readFileSync needs
    // a real path, so resolve from the package cwd (vitest's working dir).
    const src = readFileSync(join(process.cwd(), "src/components/App.tsx"), "utf8");
    expect(src).not.toMatch(/[◐⚙]/);
  });
});
