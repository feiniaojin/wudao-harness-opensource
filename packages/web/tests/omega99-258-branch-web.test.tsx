// @vitest-environment jsdom
// ω99-258: #2 — web 分支面 R 件（W1-W6）。M53 的分支能力（arm/tree/switch 三
// op）早已在协议上，本弧把第一公里接到桌面 UI：转录用户轮 hover「从这里岔开」
// → arm 带原文本进输入框 + armed 横幅（逐字钉）+ 取消（n:0 解除）；armed 下
// 发送 → 新轮带 ⎇ 徽标；分支 chip「第 N/M 条线」+ 叶表面板（forkPreview/条数/
// 当前标记/切到这里 → switchBranch + 重取 isCurrent 翻转）。SimpleMode 与 pet
// 车道零渲染（结构隔离钉）；老 server 无 branchLeaves op → chip 隐藏不白屏
// （protocol 可选 op 先例）。全 mock（mock-ws 家族零真网络零真模型）。
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { App } from "../src/components/App.js";
import { WudaoClient } from "../src/protocol.js";
import type { HistoryEntry } from "../src/protocol.js";
import { editTargetAt, historyKey } from "../src/components/HistoryList.js";
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

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

interface Harness {
  container: HTMLElement;
  client: WudaoClient;
  server: FakeServer;
}

const HISTORY_TWO_TURNS = [
  { kind: "user", text: "第一问" },
  { kind: "assistant", text: "答一" },
  { kind: "user", text: "第二问" },
  { kind: "assistant", text: "答二" },
];

function mountedApp(uiDefaultMode: "advanced" | "simple" = "advanced", history: readonly unknown[] = HISTORY_TWO_TURNS): Harness {
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
  act(() => {
    authOk(server.socket, {}, history);
  });
  // the settings fetch decides the shell mode (advanced/simple)
  act(() => {
    const frames = server.clientFrames().filter((f): f is { id: number; op: { op: string } } =>
      typeof f === "object" && f !== null && "op" in f && "id" in f);
    for (const f of frames) {
      if (f.op.op === "settingsStatus") {
        server.socket.serverSend({
          t: "result",
          id: f.id,
          ok: { settings: { memoryEnabled: true, uiDefaultMode } },
        });
      }
    }
  });
  return { container, client, server };
}

type OpFrame = { id: number; op: { op: string; [k: string]: unknown } };
const opFrames = (h: Harness): OpFrame[] =>
  h.server
    .clientFrames()
    .filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f && "id" in f);

/** Answer every pending op named `name` with ok/err (all pending, like 254's replySessionsAll). */
function replyOp(h: Harness, name: string, payload: unknown | "err"): void {
  act(() => {
    for (const f of opFrames(h)) {
      if (f.op.op !== name) continue;
      if (payload === "err") h.server.socket.serverSend({ t: "result", id: f.id, err: `old server: unknown op ${name}` });
      else h.server.socket.serverSend({ t: "result", id: f.id, ok: payload });
    }
  });
}

/** The rendered user rows (message order). */
const userRows = (h: Harness): HTMLElement[] =>
  [...h.container.querySelectorAll<HTMLElement>(".msg-user")];

const forkBtnOf = (row: HTMLElement): HTMLButtonElement | null =>
  row.querySelector<HTMLButtonElement>("button.fork-act");

const composerInput = (h: Harness): HTMLTextAreaElement | null =>
  h.container.querySelector<HTMLTextAreaElement>("textarea");

/** The r5 type() idiom: React's controlled textarea ignores a bare
 *  `el.value = x` (the value tracker) — the NATIVE prototype setter must
 *  carry the value, or the keydown handler reads an empty buffer state and
 *  the send silently vanishes. */
function typeInto(el: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const sendFromComposer = (h: Harness, text: string): void => {
  // Re-query the textarea at EVERY step: the boot-time panels' loads re-render
  // the shell, and an element grabbed before that re-render can already be
  // DETACHED (events on it never reach React's root listener — the send
  // silently vanishes). Two acts (the r5 submitLine idiom) let the input
  // event's state settle before Enter; a slash text dismisses the suggestion
  // menu first (the stub match list would make Enter COMPLETE, not send).
  act(() => {
    const input = composerInput(h);
    if (input === null) throw new Error("no composer textarea");
    typeInto(input, text);
  });
  if (text.startsWith("/")) {
    act(() => {
      composerInput(h)?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
  }
  act(() => {
    composerInput(h)?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
};

const LEAVES_3 = [
  { n: 1, leafKey: "k1", forkPreview: "first", messageCount: 4, isCurrent: false },
  { n: 2, leafKey: "k2", forkPreview: "first", messageCount: 4, isCurrent: true },
  { n: 3, leafKey: "k3", forkPreview: "first", messageCount: 6, isCurrent: false },
];

describe("ω99-258 W1/W2/W3 — 岔开手势、取消、岔轮徽标", () => {
  it("W1: hover 用户轮 → 「从这里岔开」→ 输入框带入原文本 + armed 横幅逐字；机械轮不 offered", async () => {
    const h = mountedApp();
    await until(() => userRows(h).length >= 2, "the two user turns to render");
    const rows = userRows(h);
    // the FIRST user turn forks at edit-target n=2 (1 = the most recent turn)
    const firstBtn = forkBtnOf(rows[0] as HTMLElement);
    expect(firstBtn).not.toBeNull();
    expect(firstBtn?.textContent).toBe("从这里岔开");
    act(() => {
      (firstBtn as HTMLButtonElement).click();
    });
    await until(() => opFrames(h).some((f) => f.op.op === "edit"), "the edit op");
    const editOp = opFrames(h).find((f) => f.op.op === "edit");
    expect(editOp?.op.n).toBe(2);
    replyOp(h, "edit", "第一问（原文带回）");
    await until(() => composerInput(h)?.value === "第一问（原文带回）", "the armed text in the composer");
    expect(h.container.textContent).toContain("将从第 2 轮开分支（原消息已带入，可修改后发送）；发送即岔开，主线保留");
    expect([...h.container.querySelectorAll("button")].some((b) => b.textContent === "取消")).toBe(true);
  });

  it("W1b: the /edit <n> slash command arms the SAME banner (one arm seam, two doors)", async () => {
    const h = mountedApp();
    await until(() => composerInput(h) !== null, "the composer");
    // settle the boot (panels' first loads re-render the shell; typing into
    // the pre-settle tree can dispatch onto a node React is about to replace)
    await until(() => opFrames(h).some((f) => f.op.op === "fileTree"), "the boot panels");
    await wait(30);
    sendFromComposer(h, "/edit 1");
    await until(() => opFrames(h).some((f) => f.op.op === "edit"), "the edit op");
    replyOp(h, "edit", "第二问原文");
    await until(
      () => h.container.textContent?.includes("将从第 1 轮开分支") === true,
      "the armed banner",
    );
    // ω99-273: #5 — banner 与 armed 文本不是同帧断言安全的：全量并发下实测存在
    // banner 先落、composer 仍空的窗口（0.3.65 报告后的全量复跑抓到过一次
    // '' ≠ '第二问原文'）。改条件等待，与 W1 的「文本先行」序同 idiom。
    await until(() => composerInput(h)?.value === "第二问原文", "the armed text in the composer");
  });

  it("W2: 取消 → edit n:0 解除 → 横幅消失，再发送走主线（无 ⎇ 徽标）", async () => {
    const h = mountedApp();
    await until(() => userRows(h).length >= 2, "the two user turns");
    act(() => {
      (forkBtnOf(userRows(h)[0] as HTMLElement) as HTMLButtonElement).click();
    });
    await until(() => opFrames(h).some((f) => f.op.op === "edit"), "the edit op");
    replyOp(h, "edit", "第一问（原文带回）");
    await until(() => h.container.textContent?.includes("将从第 2 轮开分支") === true, "the armed banner");
    const cancel = [...h.container.querySelectorAll("button")].find((b) => b.textContent === "取消");
    expect(cancel).toBeDefined();
    act(() => {
      (cancel as HTMLButtonElement).click();
    });
    await until(() => opFrames(h).some((f) => f.op.op === "edit" && f.op.n === 0), "the disarm edit op (n:0)");
    replyOp(h, "edit", true);
    await until(() => h.container.textContent?.includes("将从第 2 轮开分支") === false, "the banner gone");
    // a fresh submit goes to the MAINLINE: the echoed turn carries no fork badge
    sendFromComposer(h, "回到主线");
    await until(() => opFrames(h).some((f) => f.op.op === "submit"), "the submit op");
    replyOp(h, "submit", "started");
    act(() => {
      h.server.socket.serverSend({ t: "history", entries: [{ kind: "user", text: "回到主线" }] });
    });
    await until(() => h.container.textContent?.includes("回到主线") === true, "the echoed turn");
    expect(h.container.querySelectorAll(".fork-badge").length).toBe(0);
  });

  it("W3: armed 下发送 → submit 走通 + 转录新轮带 ⎇ 徽标（恰一枚）", async () => {
    const h = mountedApp();
    await until(() => userRows(h).length >= 2, "the two user turns");
    act(() => {
      (forkBtnOf(userRows(h)[1] as HTMLElement) as HTMLButtonElement).click();
    });
    await until(() => opFrames(h).some((f) => f.op.op === "edit"), "the edit op");
    replyOp(h, "edit", "第二问原文");
    await until(() => composerInput(h)?.value === "第二问原文", "the armed text in the composer");
    sendFromComposer(h, "第二问原文");
    await until(() => opFrames(h).some((f) => f.op.op === "submit"), "the submit op");
    replyOp(h, "submit", "started");
    act(() => {
      h.server.socket.serverSend({ t: "history", entries: [{ kind: "user", text: "第二问原文" }] });
    });
    await until(() => h.container.querySelectorAll(".fork-badge").length === 1, "exactly one fork badge");
    // the banner is gone once the branch turn took
    await until(() => h.container.textContent?.includes("将从第 1 轮开分支") === false, "the banner gone after the branch turn");
  });
});

describe("ω99-258 W4 — 分支 chip 与叶表面板", () => {
  it("chip 常显「第 N/M 条线」；面板渲染叶表；切到这里 → switchBranch(n) + isCurrent 翻转 + reset 刷新转录", async () => {
    const h = mountedApp();
    await until(() => opFrames(h).some((f) => f.op.op === "branchLeaves"), "the initial branchLeaves fetch");
    replyOp(h, "branchLeaves", LEAVES_3);
    await until(() => h.container.textContent?.includes("第 2/3 条线") === true, "the branch chip");
    act(() => {
      (h.container.querySelector<HTMLButtonElement>("button.branch-chip") as HTMLButtonElement).click();
    });
    await until(() => h.container.textContent?.includes("切到这里") === true, "the leaf panel");
    // leaf rows: forkPreview, message count, exactly one 当前 mark on n=2
    const panel = h.container.querySelector(".branch-panel");
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain("first");
    expect(panel?.textContent).toContain("4 条消息");
    expect(panel?.textContent).toContain("6 条消息");
    expect(panel?.querySelectorAll(".cur").length).toBe(1);
    // switch to leaf 1 → the switch op + a refetch with isCurrent flipped
    const switchBtns = [...(panel?.querySelectorAll<HTMLButtonElement>("button") ?? [])].filter((b) => b.textContent === "切到这里");
    expect(switchBtns.length).toBe(2);
    act(() => {
      switchBtns[0]?.click();
    });
    await until(() => opFrames(h).some((f) => f.op.op === "switch" && f.op.n === 1), "the switch op (n:1)");
    replyOp(h, "switch", "⑂ switched to branch 1 · 4 messages on the chain");
    await until(() => {
      const frames = opFrames(h).filter((f) => f.op.op === "branchLeaves");
      return frames.length >= 2;
    }, "the post-switch branchLeaves refetch");
    replyOp(h, "branchLeaves", LEAVES_3.map((l) => ({ ...l, isCurrent: l.n === 1 })));
    await until(() => h.container.textContent?.includes("第 1/3 条线") === true, "the flipped chip label");
    // the transcript refresh rides the EXISTING reset frame (switch swaps the chain)
    act(() => {
      h.server.socket.serverSend({ t: "history", entries: [{ kind: "user", text: "第一问" }, { kind: "assistant", text: "旧线答一" }], reset: true });
    });
    await until(() => h.container.textContent?.includes("旧线答一") === true, "the reset transcript");
  });
});

describe("ω99-258 W5/W6 — 隔离与诚实降级", () => {
  it("W5: SimpleMode 零渲染（无岔开手势、无分支 chip）；pet 车道源级零引用", async () => {
    const h = mountedApp("simple");
    await until(() => userRows(h).length >= 2, "the simple history rows");
    for (const row of userRows(h)) expect(forkBtnOf(row)).toBeNull();
    expect(h.container.textContent?.includes("条线")).toBe(false);
    expect(h.container.textContent?.includes("从这里岔开")).toBe(false);
    // pet lane: the pet window's own surface never imports the branch face
    // (jsdom's import.meta.url is http — probe the package root by candidates)
    const petDir = ["src/pet", "packages/web/src/pet"]
      .map((rel) => join(process.cwd(), rel))
      .find((p) => existsSync(p));
    expect(petDir).toBeDefined();
    for (const f of readdirSync(petDir as string).filter((f) => /\.(ts|tsx)$/.test(f))) {
      const src = readFileSync(join(petDir as string, f), "utf8");
      expect(src.includes("从这里岔开"), f).toBe(false);
      expect(src.includes("branchLeaves"), f).toBe(false);
      expect(src.includes("BranchBar"), f).toBe(false);
    }
  });

  it("W6: 老 server（branchLeaves op 缺场）→ chip 隐藏不白屏，转录/输入框照常", async () => {
    const h = mountedApp();
    await until(() => opFrames(h).some((f) => f.op.op === "branchLeaves"), "the initial branchLeaves fetch");
    replyOp(h, "branchLeaves", "err");
    await wait(30);
    expect(h.container.textContent?.includes("条线")).toBe(false);
    expect(h.container.textContent).toContain("第二问"); // the transcript still renders
    expect(composerInput(h)).not.toBeNull(); // no white screen — the composer lives
  });
});

describe("ω99-258 editTargetAt — the /edit n derivation (pure)", () => {
  const hist: readonly HistoryEntry[] = [
    { kind: "user", text: "第一问" },
    { kind: "assistant", text: "答一" },
    { kind: "user", text: "[系统注记] machinery" },
    { kind: "user", text: "第二问" },
  ];
  it("1 = the most recent rendered user turn; earlier turns count up; machinery ([) turns are never targets", () => {
    expect(editTargetAt(hist, 0)).toBe(2);
    expect(editTargetAt(hist, 2)).toBeNull(); // the [ system note is not an edit target
    expect(editTargetAt(hist, 3)).toBe(1);
  });
  it("historyKey stays the identity the fork badge keys on (composite, deterministic)", () => {
    expect(historyKey({ kind: "user", text: "abc" }, 4)).toBe("user#4#abc");
  });
});
