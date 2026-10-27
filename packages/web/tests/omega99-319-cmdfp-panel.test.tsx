// @vitest-environment jsdom
// ω99-319: #3 — 改动面板的命令归因面。先红后绿（模块字段缺位如实分类）。
// 钉：带 cmd 的行渲染「命令改动」徽标（title=命令原文）；同一命令的足迹文件
// 连续分组 + 组头「这条命令改了 N 个文件」（tooltip=命令原文）；组头「撤销这
// 条命令的改动」=逐文件复用 fileRevert（调用序钉）；无 beforeSha 的组按钮置灰
// + 诚实提示「首次改动暂无可恢复快照」；混合组只回退可回退文件；术语黑名单
// （我们的固定文案不上 sha256/content-addressed/blob/hash 等词）。夹具零文件
// 系统（mock-ws）——红线：绝不触碰用户文件。
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/components/App.js";
import { WudaoClient } from "../src/protocol.js";
import type { HistoryEntry } from "../src/protocol.js";
import { groupRunFiles } from "../src/components/ChangesPanel.js";
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
const SHA_C = "c".repeat(64);

interface ChangeRow {
  path: string;
  op: "created" | "modified";
  writes: number;
  cmd?: string;
  beforeSha?: string;
}

const receipt = (files: readonly ChangeRow[]): HistoryEntry => ({
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

describe("改动面板命令归因 (ω99-319)", () => {
  it("分组纯函数：同 cmd 相邻行聚一段；被 plain 行隔断的同 cmd 另起一段；无 cmd 行原样", () => {
    const f = (path: string, cmd?: string): ChangeRow => ({ path, op: "modified", writes: 1, ...(cmd !== undefined ? { cmd } : {}) });
    const segs = groupRunFiles([f("a", "c1"), f("b", "c1"), f("plain"), f("c", "c2"), f("d", "c1")]);
    expect(segs).toEqual([
      { kind: "cmd", cmd: "c1", files: [f("a", "c1"), f("b", "c1")] },
      { kind: "plain", file: f("plain") },
      { kind: "cmd", cmd: "c2", files: [f("c", "c2")] },
      { kind: "cmd", cmd: "c1", files: [f("d", "c1")] },
    ]);
  });

  it("cmd 行渲染「命令改动」徽标，title=命令原文；无 cmd 行零徽标", async () => {
    const h = mountedApp([
      receipt([
        { path: "plain.ts", op: "modified", writes: 2 },
        { path: "cmd-a.ts", op: "modified", writes: 1, cmd: "sed -i s/a/b/ cmd-a.ts", beforeSha: SHA_A },
      ]),
    ]);
    await openPanel(h);
    const badges = [...h.container.querySelectorAll(".chg-cmd-badge")];
    expect(badges).toHaveLength(1);
    expect(badges[0]!.textContent).toBe("命令改动");
    expect(badges[0]!.getAttribute("title")).toBe("sed -i s/a/b/ cmd-a.ts");
  });

  it("同一命令的足迹文件连续分组：组头「这条命令改了 N 个文件」+ tooltip=命令原文；两个命令两组", async () => {
    const h = mountedApp([
      receipt([
        { path: "plain.ts", op: "modified", writes: 2 },
        { path: "c1-a.ts", op: "modified", writes: 1, cmd: "cmd one" },
        { path: "c1-b.ts", op: "created", writes: 1, cmd: "cmd one" },
        { path: "c2-a.ts", op: "created", writes: 1, cmd: "cmd two" },
      ]),
    ]);
    await openPanel(h);
    const groups = [...h.container.querySelectorAll(".chg-cmdgroup")];
    expect(groups).toHaveLength(2);
    const heads = [...h.container.querySelectorAll(".chg-cmd-h")] as HTMLElement[];
    expect(heads).toHaveLength(2);
    expect(heads[0]!.textContent).toContain("这条命令改了 2 个文件");
    expect(heads[0]!.getAttribute("title")).toBe("cmd one");
    expect(heads[1]!.textContent).toContain("这条命令改了 1 个文件");
    expect(heads[1]!.getAttribute("title")).toBe("cmd two");
    // plain 行不进组
    expect([...groups[0]!.querySelectorAll(".chg-path")].map((n) => n.textContent)).toEqual(["c1-a.ts", "c1-b.ts"]);
    expect(h.container.querySelector(".chg-cmdgroup ~ .chg-file-wrap .chg-path")?.textContent ?? h.container.querySelector(".chg-file-wrap .chg-path")?.textContent).toBe("plain.ts");
  });

  it("组回滚：确认弹框 → 逐文件 fileRevert（行序钉）；非 cmd 恢复钮照旧", async () => {
    const h = mountedApp([
      receipt([
        { path: "r1.ts", op: "modified", writes: 1, cmd: "cmd rollback", beforeSha: SHA_A },
        { path: "r2.ts", op: "modified", writes: 1, cmd: "cmd rollback", beforeSha: SHA_B },
      ]),
    ]);
    await openPanel(h);
    const undo = h.container.querySelector<HTMLSpanElement>(".chg-cmd-undo")!;
    expect(undo).not.toBeNull();
    expect(undo.textContent).toBe("撤销这条命令的改动");
    await act(async () => {
      undo.click();
    });
    const dialog = h.container.querySelector(".revert-confirm");
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("2 个文件");
    expect(opFrames(h).filter((o) => o.op === "fileRevert")).toHaveLength(0); // 确认前零 op
    void (async () => {
      await until(() => opFrames(h).some((o) => o.op === "fileRevert"), "ops sent");
      for (const frame of h.server.clientFrames().filter((f) => (f as { op?: { op: string } }).op?.op === "fileRevert")) {
        h.server.socket.serverSend({ t: "result", id: (frame as { id: number }).id, ok: { ok: true, stale: false, message: "已恢复" } });
      }
    })();
    await act(async () => {
      ([...dialog!.querySelectorAll("button")].find((b) => b.textContent === "撤销") as HTMLButtonElement)?.click();
    });
    await until(() => opFrames(h).filter((o) => o.op === "fileRevert").length === 2, "two fileRevert ops");
    // 调用序 = 行序（r1 → r2），sha 原样
    expect(opFrames(h).filter((o) => o.op === "fileRevert")).toEqual([
      { op: "fileRevert", path: "r1.ts", sha: SHA_A },
      { op: "fileRevert", path: "r2.ts", sha: SHA_B },
    ]);
    await until(() => h.container.querySelector(".revert-confirm") === null, "dialog closed");
  });

  it("无 beforeSha 的组：按钮置灰（aria-disabled）+ 提示「首次改动暂无可恢复快照」；点击零 op", async () => {
    const h = mountedApp([
      receipt([
        { path: "fresh1.ts", op: "created", writes: 1, cmd: "first touch" },
        { path: "fresh2.ts", op: "created", writes: 1, cmd: "first touch" },
      ]),
    ]);
    await openPanel(h);
    const undo = h.container.querySelector<HTMLSpanElement>(".chg-cmd-undo")!;
    expect(undo.getAttribute("aria-disabled")).toBe("true");
    expect(undo.getAttribute("title")).toContain("首次改动暂无可恢复快照");
    await act(async () => {
      undo.click();
    });
    await wait(50);
    expect(opFrames(h).filter((o) => o.op === "fileRevert")).toHaveLength(0);
    expect(h.container.querySelector(".revert-confirm")).toBeNull(); // 连确认都不开
  });

  it("混合组：部分文件带 beforeSha → 按钮可用，只回退可回退的文件", async () => {
    const h = mountedApp([
      receipt([
        { path: "mix-new.ts", op: "created", writes: 1, cmd: "mixed cmd" },
        { path: "mix-old.ts", op: "modified", writes: 1, cmd: "mixed cmd", beforeSha: SHA_C },
      ]),
    ]);
    await openPanel(h);
    const undo = h.container.querySelector<HTMLSpanElement>(".chg-cmd-undo")!;
    expect(undo.getAttribute("aria-disabled")).toBeNull(); // 有一枚可回退即可用
    void (async () => {
      await until(() => opFrames(h).some((o) => o.op === "fileRevert"), "op sent");
      for (const frame of h.server.clientFrames().filter((f) => (f as { op?: { op: string } }).op?.op === "fileRevert")) {
        h.server.socket.serverSend({ t: "result", id: (frame as { id: number }).id, ok: { ok: true, stale: false, message: "已恢复" } });
      }
    })();
    await act(async () => {
      undo.click();
    });
    const dialog = h.container.querySelector(".revert-confirm");
    expect(dialog).not.toBeNull();
    await act(async () => {
      ([...dialog!.querySelectorAll("button")].find((b) => b.textContent === "撤销") as HTMLButtonElement)?.click();
    });
    await until(() => opFrames(h).some((o) => o.op === "fileRevert"), "fileRevert op");
    expect(opFrames(h).filter((o) => o.op === "fileRevert")).toEqual([
      { op: "fileRevert", path: "mix-old.ts", sha: SHA_C }, // 只回退带 beforeSha 的
    ]);
  });

  it("术语黑名单：组头/按钮/置灰提示的固定文案零术语词（命令原文是数据不算）", async () => {
    const h = mountedApp([
      receipt([{ path: "x.ts", op: "created", writes: 1, cmd: "cmd x" }]),
    ]);
    await openPanel(h);
    const fixed = [
      h.container.querySelector(".chg-cmd-h")?.textContent ?? "",
      h.container.querySelector(".chg-cmd-undo")?.textContent ?? "",
      h.container.querySelector(".chg-cmd-undo")?.getAttribute("title") ?? "",
      h.container.querySelector(".chg-cmd-badge")?.textContent ?? "",
    ].join(" ");
    for (const banned of ["sha256", "content-addressed", "blob", "hash", "footprint", "snapshot"]) {
      expect(fixed.toLowerCase()).not.toContain(banned);
    }
  });
});
