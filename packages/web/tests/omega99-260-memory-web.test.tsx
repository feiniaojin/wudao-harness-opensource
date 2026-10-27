// @vitest-environment jsdom
// ω99-260: #3 — 面三/面四/面五 web R 件（R3-R6）：protocol 客户端两方法
// （sendOp 直通形）+ boot 待审卡（pending 计数键控——surfaced 位不参与；
// 确认/丢弃走 memoryDecide 后重取；稍后会话内收起，下轮 boot 再现）+
// PreferencesTab 管理记忆面（段内懒取不占 boot；全量字段+status 徽标+被想起
// 次数；决定键同缝；空态）。老 server 缺 op → 整面隐藏（258 零噪音门）。
// SimpleMode/pet 车道零渲染（结构隔离钉）。全 mock（mock-ws 家族零真网络
// 零真模型零 spawn）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { App } from "../src/components/App.js";
import { PreferencesTab } from "../src/components/PreferencesTab.js";
import { readMemoryEntries } from "../src/components/MemoryReviewCard.js";
import { WudaoClient } from "../src/protocol.js";
import type { SettingsStatus } from "../src/protocol.js";
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
});

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
function mountedApp(uiDefaultMode: "advanced" | "simple" = "advanced", history: readonly unknown[] = []): Harness {
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
const opsNamed = (h: Harness, name: string): OpFrame[] => opFrames(h).filter((f) => f.op.op === name);

/** Answer every pending op named `name` with ok/err (all pending). */
function replyOp(h: Harness, name: string, payload: unknown | "err"): void {
  act(() => {
    for (const f of opsNamed(h, name)) {
      if (payload === "err") h.server.socket.serverSend({ t: "result", id: f.id, err: `old server: unknown op ${name}` });
      else h.server.socket.serverSend({ t: "result", id: f.id, ok: payload });
    }
  });
}

// --- fixtures -----------------------------------------------------------------

const DAYS = 24 * 60 * 60 * 1000;
const iso = (daysAgo: number): string => new Date(Date.now() - daysAgo * DAYS).toISOString();

const MEM_PENDING_A = {
  id: "m-a", kind: "preference", content: "称呼我用「老板」", scope: "user",
  tags: [], created: iso(0.5), hits: 0, status: "pending", surfaced: true, seq: 1, version: 1,
};
const MEM_PENDING_B = {
  id: "m-b", kind: "skill_note", content: "改动后要跑聚焦测试", scope: "user",
  tags: ["test"], created: iso(3), hits: 2, status: "pending", seq: 2, version: 1,
};
const MEM_ACTIVE_C = {
  id: "m-c", kind: "fact", content: "构建命令是 pnpm build", scope: "project",
  tags: ["build"], created: iso(30), hits: 5, status: "active", seq: 3, version: 1,
};
const MEM_ALL = { entries: [MEM_ACTIVE_C, MEM_PENDING_A, MEM_PENDING_B] };

// 116 弧 C：标题的 🧠 换 brain 细线字形（svg 的 inter-path 空白随 trim 归零）。
const cardTitle = (h: Harness): string | null => h.container.querySelector(".memory-review-title")?.textContent?.trim() ?? null;
const cardRows = (h: Harness): HTMLElement[] =>
  [...h.container.querySelectorAll<HTMLElement>(".memory-review-card .mem-row")];
const rowButton = (row: HTMLElement, label: string): HTMLButtonElement | null =>
  [...row.querySelectorAll("button")].find((b) => b.textContent === label) ?? null;

// --- R3/R4 — the boot pending-review card --------------------------------------

describe("ω99-260 R4 — boot 待审卡（面四）", () => {
  it("R4a: pending>0 渲染「🧠 有 N 条记忆待你确认」——status 计数键控，surfaced 位不参与（surfaced=true 仍渲染）；active 条目不进卡", async () => {
    const h = mountedApp();
    await until(() => opsNamed(h, "memoryList").length >= 1, "the deferred memoryList fetch");
    replyOp(h, "memoryList", MEM_ALL);
    await until(() => cardRows(h).length === 2, "the two pending rows");
    expect(cardTitle(h)).toBe("有 2 条记忆待你确认");
    // the rows carry kind/scope labels + content preview
    const text = h.container.querySelector(".memory-review-card")?.textContent ?? "";
    expect(text).toContain("称呼我用「老板」");
    expect(text).toContain("改动后要跑聚焦测试");
    expect(text).toContain("偏好 · 个人");
    expect(text).toContain("技能心得 · 个人");
    expect(text).not.toContain("pnpm build"); // the ACTIVE entry never joins the card
    expect(text).toContain("确认后才会参与回忆");
    expect([...h.container.querySelectorAll(".memory-review-card button")].some((b) => b.textContent === "稍后")).toBe(true);
  });

  it("R4b: R3 sendOp 形直证——memoryList op 恰 {op}；确认 → memoryDecide {op,id,action:'ok'} + 重取后条目消失", async () => {
    const h = mountedApp();
    await until(() => opsNamed(h, "memoryList").length >= 1, "the deferred memoryList fetch");
    // R3: the client's read op is the bare shape (no stray fields)
    expect(opsNamed(h, "memoryList")[0]?.op).toEqual({ op: "memoryList" });
    replyOp(h, "memoryList", MEM_ALL);
    await until(() => cardRows(h).length === 2, "the pending rows");
    const rowA = cardRows(h).find((r) => r.textContent?.includes("称呼我用"));
    act(() => {
      rowButton(rowA as HTMLElement, "确认")?.click();
    });
    await until(() => opsNamed(h, "memoryDecide").length >= 1, "the decide op");
    // R3: the decide op's exact wire shape
    expect(opsNamed(h, "memoryDecide")[0]?.op).toEqual({ op: "memoryDecide", id: "m-a", action: "ok" });
    replyOp(h, "memoryDecide", { ok: true, message: "已确认一条记忆" });
    // the post-decide refetch (the same client seam)
    await until(() => opsNamed(h, "memoryList").length >= 2, "the post-decide refetch");
    replyOp(h, "memoryList", { entries: [MEM_ACTIVE_C, { ...MEM_PENDING_A, status: "active" }, MEM_PENDING_B] });
    await until(() => cardRows(h).length === 1, "the confirmed row gone");
    expect(cardTitle(h)).toBe("有 1 条记忆待你确认");
  });

  it("R4c: 丢弃 → action:'del' + 重取后条目消失", async () => {
    const h = mountedApp();
    await until(() => opsNamed(h, "memoryList").length >= 1, "the deferred memoryList fetch");
    replyOp(h, "memoryList", MEM_ALL);
    await until(() => cardRows(h).length === 2, "the pending rows");
    const rowB = cardRows(h).find((r) => r.textContent?.includes("聚焦测试"));
    act(() => {
      rowButton(rowB as HTMLElement, "丢弃")?.click();
    });
    await until(() => opsNamed(h, "memoryDecide").some((f) => f.op.action === "del"), "the del op");
    replyOp(h, "memoryDecide", { ok: true, message: "已删除一条记忆" });
    await until(() => opsNamed(h, "memoryList").length >= 2, "the post-decide refetch");
    replyOp(h, "memoryList", { entries: [MEM_ACTIVE_C, MEM_PENDING_A] });
    await until(() => cardRows(h).length === 1, "the discarded row gone");
  });

  it("R4d: 稍后 → 本会话收起不再弹（零新取数——快照非订阅）；重挂载（下轮 boot 同构）pending 仍在 → 卡再现", async () => {
    const h = mountedApp();
    await until(() => opsNamed(h, "memoryList").length >= 1, "the deferred memoryList fetch");
    replyOp(h, "memoryList", MEM_ALL);
    await until(() => cardRows(h).length === 2, "the pending rows");
    const before = opsNamed(h, "memoryList").length;
    act(() => {
      ([...h.container.querySelectorAll(".memory-review-card button")].find((b) => b.textContent === "稍后") as HTMLButtonElement).click();
    });
    await until(() => h.container.querySelector(".memory-review-card") === null, "the card dismissed");
    await wait(80); // no poll, no re-pop in the same session
    expect(h.container.querySelector(".memory-review-card")).toBeNull();
    expect(opsNamed(h, "memoryList").length).toBe(before);
    // a fresh mount = the next boot: the pending items still in the store → the card returns
    const h2 = mountedApp();
    await until(() => opsNamed(h2, "memoryList").length >= 1, "the fresh boot's fetch");
    replyOp(h2, "memoryList", MEM_ALL);
    await until(() => cardRows(h2).length === 2, "the card back on the fresh boot");
  });

  it("R4e: 老 server（op 缺场）→ 整面隐藏不白屏；pending=0 → 零渲染", async () => {
    const h = mountedApp();
    await until(() => opsNamed(h, "memoryList").length >= 1, "the deferred memoryList fetch");
    replyOp(h, "memoryList", "err");
    await wait(30);
    expect(h.container.querySelector(".memory-review-card")).toBeNull();
    expect(h.container.querySelector("textarea")).not.toBeNull(); // no white screen
    // zero pending → zero render (the ACTIVE-only store)
    const h2 = mountedApp();
    await until(() => opsNamed(h2, "memoryList").length >= 1, "the deferred memoryList fetch");
    replyOp(h2, "memoryList", { entries: [MEM_ACTIVE_C] });
    await wait(30);
    expect(h2.container.querySelector(".memory-review-card")).toBeNull();
  });

  // ω99-273: #4 — 坏形回执两枚回归钉。99 败（19 套件）的机制：App 级测试的
  // drain() 家族对所有未知 op 兜底应答裸 ok:[]，r.entries 于是取到
  // Array.prototype.entries——一个函数，React 当 state updater 派发，在
  // this=null 上炸（Cannot convert undefined or null to object）。修复 =
  // readMemoryEntries 必填键判型（readSelectionPayload 家族纪律——260 的
  // 「拒答→隐藏」契约扩到「任何坏形→隐藏」）；R5e 再把「拒答」扩到「方法缺场」。
  it("R4f: readMemoryEntries 判型矩阵 + 裸数组回执 → 不炸不白屏，整面隐藏（273 直证）", async () => {
    // the pure guard's matrix: entries 必须是数组，坏形整丢 null（不部分信任）
    expect(readMemoryEntries({ entries: [MEM_PENDING_A] })).toEqual([MEM_PENDING_A]);
    expect(readMemoryEntries({ entries: [], extra: 1 })).toEqual([]); // extras ignored
    expect(readMemoryEntries([])).toBeNull(); // ← THE bug: bare array → .entries is a FUNCTION
    expect(readMemoryEntries({})).toBeNull();
    expect(readMemoryEntries({ entries: "x" })).toBeNull();
    expect(readMemoryEntries(null)).toBeNull();
    expect(readMemoryEntries(undefined)).toBeNull();
    // the App-level integration: the drain() family's catch-all shape
    const h = mountedApp();
    await until(() => opsNamed(h, "memoryList").length >= 1, "the deferred memoryList fetch");
    replyOp(h, "memoryList", []);
    await wait(30);
    expect(h.container.querySelector(".memory-review-card")).toBeNull();
    expect(h.container.querySelector("textarea")).not.toBeNull(); // no white screen
  });

  it("R6a: boot ops[0] 序钉——defer 后 memoryList 绝不抢 wire 头（components /help 族零演进的红线）", async () => {
    const h = mountedApp();
    await until(() => opsNamed(h, "memoryList").length >= 1, "the deferred memoryList fetch");
    const ops = opFrames(h);
    expect(ops[0]?.op.op).toBe("listSlashCommands"); // the synchronous boot op owns the head
    const mlIdx = ops.findIndex((f) => f.op.op === "memoryList");
    expect(mlIdx).toBeGreaterThan(0);
  });

  it("R6b: SimpleMode 零渲染；pet 车道源级零引用（结构隔离）", async () => {
    const h = mountedApp("simple");
    await wait(50);
    expect(h.container.textContent?.includes("条记忆待你确认")).toBe(false);
    expect(h.container.textContent?.includes("管理记忆")).toBe(false);
    // pet lane: the sprite window's own surface never imports the memory face
    const petDir = ["src/pet", "packages/web/src/pet"]
      .map((rel) => join(process.cwd(), rel))
      .find((p) => existsSync(p));
    expect(petDir).toBeDefined();
    for (const f of readdirSync(petDir as string).filter((f) => /\.(ts|tsx)$/.test(f))) {
      const src = readFileSync(join(petDir as string, f), "utf8");
      expect(src.includes("MemoryReviewCard"), f).toBe(false);
      expect(src.includes("memoryList"), f).toBe(false);
      expect(src.includes("memoryDecide"), f).toBe(false);
    }
    // SimpleMode keeps its own column — the shared chatColumn never mounts there
    const simpleSrc = readFileSync(
      ["src/components/SimpleMode.tsx", "packages/web/src/components/SimpleMode.tsx"]
        .map((rel) => join(process.cwd(), rel))
        .find((p) => existsSync(p)) as string,
      "utf8",
    );
    expect(simpleSrc.includes("MemoryReviewCard")).toBe(false);
  });
});

// --- R5 — the PreferencesTab 管理记忆 face -------------------------------------

const STATUS: SettingsStatus = {
  providers: [],
  credentials: { path: "/home/u/.wudao/.credentials.yaml", keyCount: 1 },
  settings: { memoryEnabled: true, uiDefaultMode: null, wizardCompletedVersion: 1, uiTheme: null, uiAccent: null },
  current: { provider: "deepseek", model: "deepseek-v4-flash", effort: "high" },
  envKey: false,
  readiness: true,
  efforts: [],
};

describe("ω99-260 R5 — 管理记忆面（面五，PreferencesTab 段内懒取）", () => {
  it("R5a: 段内懒取——boot 零 fetch 钉（App boot 只有待审卡的 1 次 memoryList），设置页开偏好 tab 才第 2 次", async () => {
    const h = mountedApp();
    await until(() => opsNamed(h, "memoryList").length >= 1, "the boot card's fetch");
    replyOp(h, "memoryList", { entries: [] }); // no pending → the card stays hidden
    await wait(40);
    // boot settled: EXACTLY one memoryList (the card's) — the panel never fetches at boot
    expect(opsNamed(h, "memoryList").length).toBe(1);
    // open 设置 → 偏好 tab
    act(() => {
      (h.container.querySelector(".topbar button[aria-label='设置']") as HTMLButtonElement).click();
    });
    await until(() => h.container.querySelector("button[data-settings-tab='preferences']") != null, "the settings tabs");
    act(() => {
      (h.container.querySelector("button[data-settings-tab='preferences']") as HTMLButtonElement).click();
    });
    await until(() => opsNamed(h, "memoryList").length >= 2, "the panel's lazy fetch on tab open");
    replyOp(h, "memoryList", MEM_ALL);
    await until(() => h.container.querySelector(".memory-manage") != null, "the management panel");
  });

  it("R5b: 全量条目——content/kind/scope/相对时间/hits「被想起 N 次」/status 徽标（待审｜生效）；决定键只在 pending 行", async () => {
    const server = fakeServer();
    const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
    act(() => {
      client.connect();
      server.socket.serverOpen();
    });
    act(() => {
      authOk(server.socket);
    });
    const notify = vi.fn();
    const container = mount(
      <PreferencesTab client={client} settings={STATUS} notify={notify} refresh={() => {}} />,
    );
    const frames = () =>
      server.clientFrames().filter((f): f is { id: number; op: { op: string; [k: string]: unknown } } =>
        typeof f === "object" && f !== null && "op" in f && "id" in f);
    await until(() => frames().some((f) => f.op.op === "memoryList"), "the tab-mount fetch");
    act(() => {
      for (const f of frames()) {
        if (f.op.op === "memoryList") server.socket.serverSend({ t: "result", id: f.id, ok: MEM_ALL });
      }
    });
    await until(() => container.querySelectorAll(".memory-manage .mem-row").length === 3, "all three rows");
    const rows = [...container.querySelectorAll(".memory-manage .mem-row")] as HTMLElement[];
    // status badges: 待审 on the pending rows, 生效 on the active one
    expect(rows.filter((r) => r.textContent?.includes("待审")).length).toBe(2);
    expect(rows.filter((r) => r.textContent?.includes("生效")).length).toBe(1);
    // the active row: full fields incl. relative time + hits telemetry
    const activeRow = rows.find((r) => r.textContent?.includes("pnpm build")) as HTMLElement;
    expect(activeRow.textContent).toContain("事实 · 本项目");
    expect(activeRow.textContent).toContain("30 天前");
    expect(activeRow.textContent).toContain("被想起 5 次");
    // decide keys ONLY on pending rows
    for (const r of rows) {
      const hasKeys = [...r.querySelectorAll("button")].some((b) => b.textContent === "确认");
      expect(hasKeys).toBe(r.textContent?.includes("待审") === true);
    }
    // the memoryEnabled checkbox semantics untouched (zero-evolution pin)
    const checkbox = container.querySelector(".setrow input[type=checkbox]") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it("R5c: 决定键同缝——面板确认 → memoryDecide + 重取 + notify 回执；空态文案", async () => {
    const server = fakeServer();
    const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
    act(() => {
      client.connect();
      server.socket.serverOpen();
    });
    act(() => {
      authOk(server.socket);
    });
    const notify = vi.fn();
    const container = mount(
      <PreferencesTab client={client} settings={STATUS} notify={notify} refresh={() => {}} />,
    );
    const frames = () =>
      server.clientFrames().filter((f): f is { id: number; op: { op: string; [k: string]: unknown } } =>
        typeof f === "object" && f !== null && "op" in f && "id" in f);
    const replyAll = (name: string, payload: unknown): void => {
      act(() => {
        for (const f of frames()) {
          if (f.op.op !== name) continue;
          server.socket.serverSend({ t: "result", id: f.id, ok: payload });
        }
      });
    };
    await until(() => frames().some((f) => f.op.op === "memoryList"), "the tab-mount fetch");
    replyAll("memoryList", MEM_ALL);
    await until(() => container.querySelectorAll(".memory-manage .mem-row").length === 3, "all three rows");
    const rowA = [...container.querySelectorAll(".memory-manage .mem-row")].find((r) => r.textContent?.includes("称呼我用")) as HTMLElement;
    act(() => {
      ([...rowA.querySelectorAll("button")].find((b) => b.textContent === "确认") as HTMLButtonElement).click();
    });
    await until(() => frames().some((f) => f.op.op === "memoryDecide"), "the decide op");
    expect(frames().find((f) => f.op.op === "memoryDecide")?.op).toEqual({ op: "memoryDecide", id: "m-a", action: "ok" });
    replyAll("memoryDecide", { ok: true, message: "已确认一条记忆" });
    await until(() => frames().filter((f) => f.op.op === "memoryList").length >= 2, "the post-decide refetch");
    replyAll("memoryList", { entries: [MEM_ACTIVE_C, { ...MEM_PENDING_A, status: "active" }, MEM_PENDING_B] });
    await until(() => {
      const row = [...container.querySelectorAll(".memory-manage .mem-row")].find((r) => r.textContent?.includes("称呼我用"));
      return row?.textContent?.includes("生效") === true;
    }, "the badge flipped to 生效");
    expect(notify).toHaveBeenCalledWith("已确认一条记忆");
    // the empty state (a fresh store)
    const h2 = mountedApp();
    await until(() => opsNamed(h2, "memoryList").length >= 1, "the boot card's fetch");
    replyOp(h2, "memoryList", { entries: [] });
    await wait(30);
    act(() => {
      (h2.container.querySelector(".topbar button[aria-label='设置']") as HTMLButtonElement).click();
    });
    await until(() => h2.container.querySelector("button[data-settings-tab='preferences']") != null, "the settings tabs");
    act(() => {
      (h2.container.querySelector("button[data-settings-tab='preferences']") as HTMLButtonElement).click();
    });
    await until(() => opsNamed(h2, "memoryList").length >= 2, "the panel's fetch");
    replyOp(h2, "memoryList", { entries: [] });
    await until(() => h2.container.textContent?.includes("还没有记忆——用得越久攒得越多") === true, "the empty state copy");
  });

  it("R5d: 老 server（memoryList 拒答）→ 管理面隐藏，偏好段照常（零噪音门）", async () => {
    const h = mountedApp();
    await until(() => opsNamed(h, "memoryList").length >= 1, "the boot card's fetch");
    replyOp(h, "memoryList", "err");
    await wait(30);
    act(() => {
      (h.container.querySelector(".topbar button[aria-label='设置']") as HTMLButtonElement).click();
    });
    await until(() => h.container.querySelector("button[data-settings-tab='preferences']") != null, "the settings tabs");
    act(() => {
      (h.container.querySelector("button[data-settings-tab='preferences']") as HTMLButtonElement).click();
    });
    await until(() => opsNamed(h, "memoryList").length >= 2, "the panel's fetch");
    replyOp(h, "memoryList", "err");
    await wait(30);
    expect(h.container.querySelector(".memory-manage")).toBeNull();
    // the rest of the tab renders byte-as-before
    expect(h.container.textContent).toContain("跨会话记忆");
    expect(h.container.querySelector(".setrow input[type=checkbox]")).not.toBeNull();
  });

  // ω99-273 companion pin (marker lives at R4f): 更老字节 = memoryList 方法本身
  // 缺场（lean 手搓 client）——260 只保了「拒答」；同步 throw 逃出 .catch 链
  // 直接炸挂载。缺场=老 server 同语义：管理面隐藏，偏好段照常。
  it("R5e: memoryList 方法缺场（lean client）→ 管理面隐藏，偏好段照常，挂载不炸", async () => {
    const lean = { settingsSet: () => Promise.resolve({ ok: true }) } as unknown as WudaoClient;
    const notify = vi.fn();
    const container = mount(
      <PreferencesTab client={lean} settings={STATUS} notify={notify} refresh={() => {}} />,
    );
    await wait(40);
    expect(container.querySelector(".memory-manage")).toBeNull();
    expect(container.textContent).toContain("跨会话记忆");
    expect(container.querySelector(".setrow input[type=checkbox]")).not.toBeNull();
  });
});

// --- ω99-264 — the 管理记忆面's 行内改写（R4/R5） ---------------------------------
// ω99-264: #5 — 面五扩展：每行（active+pending 全部）行尾「改写」键 → 行内
// textarea（预填现 content）+ 保存/取消；保存 = memoryEdit op + 回执透传 +
// 重取；取消零调用；busy 防双击沿用；失败回执复用「⚠️ 记忆操作失败：」族
// （204 census 零演进的前提——源里该串只出现一次）。待审卡零改写键（卡是轻
// 提醒面，编辑归管理面板）。全 mock（mock-ws 家族零真网络零真模型零 spawn）。

const STATUS_O264: SettingsStatus = {
  providers: [],
  credentials: { path: "/home/u/.wudao/.credentials.yaml", keyCount: 1 },
  settings: { memoryEnabled: true, uiDefaultMode: null, wizardCompletedVersion: 1, uiTheme: null, uiAccent: null },
  current: { provider: "deepseek", model: "deepseek-v4-flash", effort: "high" },
  envKey: false,
  readiness: true,
  efforts: [],
};

/** A PreferencesTab harness over the mock wire (the R5b shape, inlined so
 *  the block reads standalone). */
async function panelHarness(): Promise<{
  container: HTMLElement;
  frames: () => OpFrame[];
  replyAll: (name: string, payload: unknown | "err") => void;
  notify: ReturnType<typeof vi.fn>;
}> {
  const server = fakeServer();
  const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
  act(() => {
    client.connect();
    server.socket.serverOpen();
  });
  act(() => {
    authOk(server.socket);
  });
  const notify = vi.fn();
  const container = mount(
    <PreferencesTab client={client} settings={STATUS_O264} notify={notify} refresh={() => {}} />,
  );
  const frames = (): OpFrame[] =>
    server.clientFrames().filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f && "id" in f);
  const replyAll = (name: string, payload: unknown | "err"): void => {
    act(() => {
      for (const f of frames()) {
        if (f.op.op !== name) continue;
        if (payload === "err") server.socket.serverSend({ t: "result", id: f.id, err: `old server: ${name} refused` });
        else server.socket.serverSend({ t: "result", id: f.id, ok: payload });
      }
    });
  };
  await until(() => frames().some((f) => f.op.op === "memoryList"), "the tab-mount fetch");
  replyAll("memoryList", MEM_ALL);
  await until(() => container.querySelectorAll(".memory-manage .mem-row").length === 3, "all three rows");
  return { container, frames, replyAll, notify };
}

const panelRows = (container: HTMLElement): HTMLElement[] =>
  [...container.querySelectorAll<HTMLElement>(".memory-manage .mem-row")];
const rowButton264 = (row: HTMLElement, label: string): HTMLButtonElement | null =>
  [...row.querySelectorAll("button")].find((b) => b.textContent === label) ?? null;
/** Type into a controlled textarea the way a real browser does (the file's
 *  established native-setter + input-event idiom). */
const typeInto = (ta: HTMLTextAreaElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(ta, value);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("ω99-264 R4 — 行内改写（面五扩展）", () => {
  it("R4a: 改写键全部行在场（active 行也有——决定是审、改写是编辑）；待审卡零改写键", async () => {
    const { container } = await panelHarness();
    const rows = panelRows(container);
    expect(rows.length).toBe(3);
    for (const r of rows) expect(rowButton264(r, "改写")).not.toBeNull(); // ALL rows editable
    // the boot card is the light reminder face — the edit key never joins it
    const h = mountedApp();
    await until(() => opsNamed(h, "memoryList").length >= 1, "the boot card's fetch");
    replyOp(h, "memoryList", MEM_ALL);
    await until(() => cardRows(h).length === 2, "the pending rows");
    expect([...h.container.querySelectorAll(".memory-review-card button")].some((b) => b.textContent === "改写")).toBe(false);
  });

  it("R4b: 展开 → textarea 预填现 content；保存 → memoryEdit op 恰形 + 回执透传 + 重取 + 编辑收起、行落新值", async () => {
    const { container, frames, replyAll, notify } = await panelHarness();
    const activeRow = panelRows(container).find((r) => r.textContent?.includes("pnpm build")) as HTMLElement;
    act(() => {
      rowButton264(activeRow, "改写")?.click();
    });
    const ta = activeRow.querySelector(".mem-edit textarea") as HTMLTextAreaElement;
    expect(ta).not.toBeNull();
    expect(ta.value).toBe("构建命令是 pnpm build"); // 预填现 content
    act(() => {
      typeInto(ta, "构建命令是 pnpm -r build");
    });
    act(() => {
      rowButton264(activeRow, "保存")?.click();
    });
    await until(() => frames().some((f) => f.op.op === "memoryEdit"), "the edit op");
    expect(frames().find((f) => f.op.op === "memoryEdit")?.op).toEqual({
      op: "memoryEdit",
      id: "m-c",
      content: "构建命令是 pnpm -r build",
    }); // R3: the wire shape, no stray fields
    replyAll("memoryEdit", { ok: true, message: "已改写一条记忆" });
    await until(() => frames().filter((f) => f.op.op === "memoryList").length >= 2, "the post-edit refetch");
    replyAll("memoryList", { entries: [{ ...MEM_ACTIVE_C, content: "构建命令是 pnpm -r build" }, MEM_PENDING_A, MEM_PENDING_B] });
    await until(() => {
      const row = panelRows(container).find((r) => r.textContent?.includes("pnpm -r build"));
      return row != null && row.querySelector(".mem-edit") === null; // editor collapsed
    }, "the edited row's new content, editor closed");
    expect(notify).toHaveBeenCalledWith("已改写一条记忆");
  });

  it("R4c: 取消 → 零 memoryEdit op、编辑器收起（零调用收起）", async () => {
    const { container, frames } = await panelHarness();
    const row = panelRows(container).find((r) => r.textContent?.includes("称呼我用")) as HTMLElement;
    act(() => {
      rowButton264(row, "改写")?.click();
    });
    const ta = row.querySelector(".mem-edit textarea") as HTMLTextAreaElement;
    act(() => {
      typeInto(ta, "草稿不该落盘");
    });
    act(() => {
      rowButton264(row, "取消")?.click();
    });
    expect(row.querySelector(".mem-edit")).toBeNull(); // collapsed
    expect(frames().some((f) => f.op.op === "memoryEdit")).toBe(false); // ZERO calls
    expect(row.textContent).toContain("称呼我用「老板」"); // the row still shows the store's truth
  });

  it("R4d: busy 防双击——双击保存只 1 枚 op；in-flight 期间保存/取消 disabled，落定后复位", async () => {
    const { container, frames, replyAll } = await panelHarness();
    const row = panelRows(container).find((r) => r.textContent?.includes("pnpm build")) as HTMLElement;
    act(() => {
      rowButton264(row, "改写")?.click();
    });
    const ta = row.querySelector(".mem-edit textarea") as HTMLTextAreaElement;
    act(() => {
      typeInto(ta, "v2");
    });
    act(() => {
      rowButton264(row, "保存")?.click();
    });
    act(() => {
      // the second click of a REAL double click is its own event task: the
      // first click's busyId render has landed, so this click meets a
      // disabled button (one act() would batch both into a single render —
      // an artificial timeline no browser produces).
      rowButton264(row, "保存")?.click();
    });
    await until(() => frames().some((f) => f.op.op === "memoryEdit"), "the edit op");
    expect(frames().filter((f) => f.op.op === "memoryEdit").length).toBe(1); // busyId guarded
    // in-flight: both editor buttons disabled
    expect((rowButton264(row, "保存") as HTMLButtonElement).disabled).toBe(true);
    expect((rowButton264(row, "取消") as HTMLButtonElement).disabled).toBe(true);
    replyAll("memoryEdit", { ok: true, message: "已改写一条记忆" });
    await until(() => frames().filter((f) => f.op.op === "memoryList").length >= 2, "the refetch");
    replyAll("memoryList", MEM_ALL);
    await wait(30);
    // settled: the editor collapsed, no stuck disabled buttons
    expect(row.querySelector(".mem-edit")).toBeNull();
    for (const r of panelRows(container)) expect((rowButton264(r, "改写") as HTMLButtonElement).disabled).toBe(false);
  });

  it("R4e: 失败 → 「⚠️ 记忆操作失败：」族回执（204 零演进前提），编辑器保持展开草稿不丢", async () => {
    const { container, frames, replyAll, notify } = await panelHarness();
    const row = panelRows(container).find((r) => r.textContent?.includes("pnpm build")) as HTMLElement;
    act(() => {
      rowButton264(row, "改写")?.click();
    });
    const ta = row.querySelector(".mem-edit textarea") as HTMLTextAreaElement;
    act(() => {
      typeInto(ta, "改动会失败");
    });
    act(() => {
      rowButton264(row, "保存")?.click();
    });
    await until(() => frames().some((f) => f.op.op === "memoryEdit"), "the edit op");
    replyAll("memoryEdit", "err");
    await until(() => notify.mock.calls.some((a) => String(a[0]).includes("记忆操作失败")), "the failure receipt");
    expect(notify.mock.calls.find((a) => String(a[0]).includes("记忆操作失败"))?.[0]).toContain("⚠️ 记忆操作失败：");
    // the editor stays open with the draft — a retry is one click away
    const ta2 = row.querySelector(".mem-edit textarea") as HTMLTextAreaElement;
    expect(ta2.value).toBe("改动会失败");
  });

  it("R4f: pending 行改写 → 回执透传「已改写一条记忆（仍待你确认）」（driver 语义，web 只透传）", async () => {
    const { container, frames, replyAll, notify } = await panelHarness();
    const row = panelRows(container).find((r) => r.textContent?.includes("称呼我用")) as HTMLElement;
    act(() => {
      rowButton264(row, "改写")?.click();
    });
    const ta = row.querySelector(".mem-edit textarea") as HTMLTextAreaElement;
    act(() => {
      typeInto(ta, "称呼我用「您」");
    });
    act(() => {
      rowButton264(row, "保存")?.click();
    });
    await until(() => frames().some((f) => f.op.op === "memoryEdit"), "the edit op");
    expect(frames().find((f) => f.op.op === "memoryEdit")?.op).toEqual({
      op: "memoryEdit",
      id: "m-a",
      content: "称呼我用「您」",
    });
    replyAll("memoryEdit", { ok: true, message: "已改写一条记忆（仍待你确认）" });
    await until(() => notify.mock.calls.some((a) => a[0] === "已改写一条记忆（仍待你确认）"), "the pending receipt");
  });

  it("R4g: 空 draft → 保存 disabled 零调用（改写不得成空记忆——server typed gate 的 UI 前置镜像）", async () => {
    const { container, frames } = await panelHarness();
    const row = panelRows(container).find((r) => r.textContent?.includes("pnpm build")) as HTMLElement;
    act(() => {
      rowButton264(row, "改写")?.click();
    });
    const ta = row.querySelector(".mem-edit textarea") as HTMLTextAreaElement;
    act(() => {
      typeInto(ta, "");
    });
    expect((rowButton264(row, "保存") as HTMLButtonElement).disabled).toBe(true);
    act(() => {
      typeInto(ta, "   ");
    });
    expect((rowButton264(row, "保存") as HTMLButtonElement).disabled).toBe(true); // whitespace-only is empty too
    act(() => {
      rowButton264(row, "保存")?.click(); // a disabled button never fires
    });
    expect(frames().some((f) => f.op.op === "memoryEdit")).toBe(false); // ZERO calls
  });
});

// --- 268 弧 — the memory faces' live refetch (the store-signature state frame) ---

// ω99-268: #9 — R3 扩展：管理面板/待审卡订阅 memorySignature（DriverStatus 的
// store 内容签名 `count:pending:maxVersion`）——签名跨帧变化且面在场 → 重取
// （fetch-on-open 升级为「打开在场即活」：别窗决定/改写、driver 自身 Dream/refine
// 落条目都可见）；面板不在场 → 零调用（不是每变必 fetch）；卡片重取失败静默零
// 弹错；签名缺席（老 server）= 今日字节（上方 260/264 既有各 describe 不动即
// 零演进直证）。全 mock（mock-ws 家族零真网络零真模型零 spawn）。

/** A rerenderable PreferencesTab harness (the 264 panelHarness shape + the
 *  signature prop feed): rerender(sig) simulates the App's status frame
 *  landing a NEW memorySignature into the mounted panel. */
function sigPanel(initial: string | undefined): {
  container: HTMLElement;
  rerender: (sig: string | undefined) => void;
  frames: () => OpFrame[];
  replyAll: (name: string, payload: unknown) => void;
} {
  const server = fakeServer();
  const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
  act(() => {
    client.connect();
    server.socket.serverOpen();
  });
  act(() => {
    authOk(server.socket);
  });
  const el = (sig: string | undefined) => (
    <PreferencesTab client={client} settings={STATUS_O264} notify={() => {}} refresh={() => {}} memorySignature={sig} />
  );
  const container = mount(el(initial));
  const rerender = (sig: string | undefined): void => {
    act(() => {
      root?.render(el(sig));
    });
  };
  const frames = (): OpFrame[] =>
    server.clientFrames().filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f && "id" in f);
  const replyAll = (name: string, payload: unknown): void => {
    act(() => {
      for (const f of frames()) {
        if (f.op.op !== name) continue;
        server.socket.serverSend({ t: "result", id: f.id, ok: payload });
      }
    });
  };
  return { container, rerender, frames, replyAll };
}

describe("268 R3 — 签名变化 → 两面重取（在场才取；失败静默；缺席=今日字节）", () => {
  it("R3a: 面板在场签名变 → 重取并渲染新值；首观察只布防（mount 恰 1 次不双取）", async () => {
    const p = sigPanel("3:2:1");
    await until(() => p.frames().some((f) => f.op.op === "memoryList"), "the tab-mount fetch");
    p.replyAll("memoryList", MEM_ALL);
    await until(() => panelRows(p.container).length === 3, "all three rows");
    // armed-ref：首观察只记录不重取——mount 恰 1 次（挂载即取保留，零双取）
    expect(p.frames().filter((f) => f.op.op === "memoryList").length).toBe(1);
    // 别窗决定（一条确认一条删除）→ 签名变 → 面板重取渲染新真值
    p.rerender("1:0:1");
    await until(() => p.frames().filter((f) => f.op.op === "memoryList").length >= 2, "the signature-driven refetch");
    p.replyAll("memoryList", { entries: [MEM_ACTIVE_C] });
    await until(() => panelRows(p.container).length === 1, "the panel renders the new truth");
    expect(p.container.textContent).not.toContain("称呼我用"); // 旧快照条目已不在
  });

  it("R3b: 面板不在场（设置页未开）→ 签名帧只驱动待审卡重取，恰 +1 次零第 3 只手", async () => {
    const h = mountedApp();
    await until(() => opsNamed(h, "memoryList").length >= 1, "the boot card's fetch");
    replyOp(h, "memoryList", { entries: [] }); // no pending → the card stays hidden
    await wait(40);
    expect(opsNamed(h, "memoryList").length).toBe(1); // boot settled: exactly the card's
    // a NEW status frame carries a changed memorySignature (别窗/Dream 落了 2 条待审)
    act(() => {
      const base = h.client.getSnapshot().status as unknown as Record<string, unknown>;
      h.server.socket.serverSend({ t: "state", state: { ...base, memorySignature: "3:2:1" } });
    });
    await until(() => opsNamed(h, "memoryList").length >= 2, "the card's signature refetch");
    replyOp(h, "memoryList", MEM_ALL);
    await until(() => cardRows(h).length === 2, "the card surfaces the other-window pendings");
    // 面板不在场零调用：总调用恰 2（boot 卡 1 + 卡重取 1）——App 级若误挂面板取数会是 3
    expect(opsNamed(h, "memoryList").length).toBe(2);
  });

  it("R3c: 卡片重取失败静默——零弹错零白屏（卡是轻提醒面，260 同语义）", async () => {
    const h = mountedApp();
    await until(() => opsNamed(h, "memoryList").length >= 1, "the boot card's fetch");
    replyOp(h, "memoryList", { entries: [] });
    await wait(30);
    act(() => {
      const base = h.client.getSnapshot().status as unknown as Record<string, unknown>;
      h.server.socket.serverSend({ t: "state", state: { ...base, memorySignature: "3:2:1" } });
    });
    await until(() => opsNamed(h, "memoryList").length >= 2, "the card's signature refetch");
    replyOp(h, "memoryList", "err"); // old server / socket gone
    await wait(40);
    expect(h.container.querySelector(".memory-review-card")).toBeNull(); // hide, never crash
    expect(h.container.textContent ?? "").not.toContain("记忆操作失败"); // 零弹错
    expect(h.container.querySelector("textarea")).not.toBeNull(); // no white screen
  });

  it("R3d: 签名缺席（老 server）→ 帧流零触发——fetch-on-open 今日字节保留", async () => {
    const p = sigPanel(undefined);
    await until(() => p.frames().some((f) => f.op.op === "memoryList"), "the tab-mount fetch");
    p.replyAll("memoryList", MEM_ALL);
    await until(() => panelRows(p.container).length === 3, "all three rows");
    p.rerender(undefined); // still absent — undefined≡undefined 静默（255 同族纪律）
    await wait(60);
    expect(p.frames().filter((f) => f.op.op === "memoryList").length).toBe(1); // 恰 mount 那 1 次
  });
});
