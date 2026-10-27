// @vitest-environment jsdom
// ω99-314: #R — 改动面板「恢复到这里」面。先红后绿（模块字段缺位如实分类）。
// 钉：条件渲染（beforeSha 在场才渲染恢复钮——294 anchors 同款范式；老收据
// 零钮）；点击 → 确认弹框（守卫 3 的警示文案在场，收益语、零术语黑名单词）；
// 确认 → fileRevert op（path+sha 原样）；取消 → 零 op；成功回执 notify；
// busy/evicted 拒答也如实 notify。夹具零文件系统（mock-ws）——红线：绝不
// 触碰用户文件。
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/components/App.js";
import { WudaoClient } from "../src/protocol.js";
import type { HistoryEntry } from "../src/protocol.js";
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
function mountedApp(history: readonly HistoryEntry[]): Harness {
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
    authOk(server.socket, {}, history);
  });
  return { container, client, server };
}

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

/** 一轮收据；modified 行带 beforeSha=可恢复面，created 行不带。 */
const receipt = (
  files: readonly { path: string; op: "created" | "modified"; writes: number; beforeSha?: string }[],
): HistoryEntry => ({
  kind: "notice",
  text: `回合净变更 ${files.length} 文件：${files.map((f) => f.path).join(" · ")}`,
  changes: files,
});

const openPanel = async (h: Harness): Promise<void> => {
  await until(() => h.container.querySelector(".topbar .tb-changes") !== null, "changes chip");
  await act(async () => {
    (h.container.querySelector<HTMLButtonElement>(".topbar .tb-changes"))!.click();
  });
  await until(() => h.container.querySelector(".changes-panel") !== null, "panel open");
};

const opFrames = (h: Harness): { op: string; path?: string; sha?: string }[] =>
  h.server.clientFrames().filter((f) => (f as { t?: string }).t === "op").map((f) => (f as { op?: { op: string; path?: string; sha?: string } }).op!);

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  document.title = "";
});

describe("改动面板「恢复到这里」(ω99-314)", () => {
  it("beforeSha 在场才渲染恢复钮；created 行与老收据（无字段）零钮——条件渲染范式", async () => {
    const h = mountedApp([
      receipt([
        { path: "a.ts", op: "modified", writes: 2, beforeSha: SHA_A },
        { path: "new.ts", op: "created", writes: 1 },
      ]),
      // 老形状收据：无 beforeSha 字段
      { kind: "notice", text: "回合净变更 1 文件：old.ts(×1)", changes: [{ path: "old.ts", op: "modified" as const, writes: 1 }] },
    ]);
    await openPanel(h);
    const runs = [...h.container.querySelectorAll(".chg-run")] as HTMLElement[];
    const buttons = [...h.container.querySelectorAll(".chg-revert")] as HTMLButtonElement[];
    expect(buttons).toHaveLength(1); // 只有带 beforeSha 的 modified 行
    expect(buttons[0]?.textContent).toBe("恢复到这里");
    expect(buttons[0]?.getAttribute("title")).toBe("这一轮开始前它是这个样子");
    expect(buttons[0]?.getAttribute("data-path")).toBe("a.ts");
  });

  it("点击 → 确认弹框（守卫 3 警示文案 + 收益语；术语黑名单词不上 UI）→ 确认后 fileRevert op 原样发出", async () => {
    const h = mountedApp([receipt([{ path: "a.ts", op: "modified", writes: 1, beforeSha: SHA_A }])]);
    await openPanel(h);
    await act(async () => {
      (h.container.querySelector<HTMLButtonElement>(".chg-revert"))!.click();
    });
    // 弹框：警示文案在场；面板此时还没发任何 op
    const dialog = h.container.querySelector(".revert-confirm");
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("role")).toBe("dialog");
    const dialogText = dialog?.textContent ?? "";
    expect(dialogText).toContain("这一轮开始前它是这个样子");
    expect(dialogText).toContain("覆盖");
    // 术语黑名单：sha256 / content-addressed / blob / hash 不上 UI
    for (const banned of ["sha256", "content-addressed", "blob", "hash"]) {
      expect(dialogText.toLowerCase()).not.toContain(banned);
    }
    expect(opFrames(h).filter((o) => o.op === "fileRevert")).toHaveLength(0);
    // 确认 → op 发出（path+sha 原样）→ 回执后弹框收起（id 从真实帧读——
    // 挂载期可能已有别的 op 花掉序号）
    void (async () => {
      await until(() => opFrames(h).some((o) => o.op === "fileRevert"), "op sent");
      const frame = h.server.clientFrames().find((f) => (f as { op?: { op: string } }).op?.op === "fileRevert") as { id: number };
      h.server.socket.serverSend({ t: "result", id: frame.id, ok: { ok: true, stale: false, message: "已恢复 a.ts" } });
    })();
    await act(async () => {
      ( [...dialog!.querySelectorAll("button")].find((b) => b.textContent === "恢复") as HTMLButtonElement)?.click();
    });
    await until(() => opFrames(h).some((o) => o.op === "fileRevert"), "fileRevert op");
    expect(opFrames(h).find((o) => o.op === "fileRevert")).toEqual({ op: "fileRevert", path: "a.ts", sha: SHA_A });
    await until(() => h.container.querySelector(".revert-confirm") === null, "dialog closed");
  });

  it("取消（Esc/按钮）→ 零 op，弹框收起", async () => {
    const h = mountedApp([receipt([{ path: "a.ts", op: "modified", writes: 1, beforeSha: SHA_A }])]);
    await openPanel(h);
    await act(async () => {
      (h.container.querySelector<HTMLButtonElement>(".chg-revert"))!.click();
    });
    const dialog = h.container.querySelector<HTMLElement>(".revert-confirm");
    expect(dialog).not.toBeNull();
    await act(async () => {
      ( [...dialog!.querySelectorAll("button")].find((b) => b.textContent === "取消 (Esc)") as HTMLButtonElement)?.click();
    });
    expect(h.container.querySelector(".revert-confirm")).toBeNull();
    expect(opFrames(h).filter((o) => o.op === "fileRevert")).toHaveLength(0);
  });

  it("拒答（busy）也如实回执——拒绝文案 notify 可见，弹框收起不重试", async () => {
    const h = mountedApp([receipt([{ path: "a.ts", op: "modified", writes: 1, beforeSha: SHA_A }])]);
    await openPanel(h);
    await act(async () => {
      (h.container.querySelector<HTMLButtonElement>(".chg-revert"))!.click();
    });
    const dialog = h.container.querySelector(".revert-confirm")!;
    void (async () => {
      await until(() => opFrames(h).some((o) => o.op === "fileRevert"), "op sent");
      const frame = h.server.clientFrames().find((f) => (f as { op?: { op: string } }).op?.op === "fileRevert") as { id: number };
      h.server.socket.serverSend({ t: "result", id: frame.id, ok: { ok: false, reason: "busy", message: "任务正在跑，等它停下来再恢复" } });
    })();
    await act(async () => {
      ( [...dialog.querySelectorAll("button")].find((b) => b.textContent === "恢复") as HTMLButtonElement)?.click();
    });
    await until(() => h.container.querySelector(".revert-confirm") === null, "dialog closed on refusal");
    await until(
      () => [...h.container.querySelectorAll(".notice-bub")].some((n) => (n.textContent ?? "").includes("等它停下来")),
      "refusal receipt visible",
    );
  });
});
