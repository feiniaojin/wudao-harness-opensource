// @vitest-environment jsdom
// ω99-251: #6 — 恢复跨会话发现性 R 件（R1-R5；R6 红线走弧门 shell 取证：
// diff 新增行与新件的删除调用双零、零真网络）。数据源裁定=复用
// 既有 recoveryStatus 5s 轮询的全量行（零新 op）→ 全局派生纯函数
// sessionsAwaitingYou；徽标/点名两face都只在「有会话在等你」时渲染（无等待=
// 零渲染零噪音，245 健康行同款门）。全 App harness（248 morning-line 式样，
// mock-ws 家族全 mock 零真网络；夹具零盘写——只碰 jsdom localStorage）。
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/components/App.js";
import { EmptyHero } from "../src/components/EmptyHero.js";
import { WudaoClient, type RecoveryStatusRowWire } from "../src/protocol.js";
import type { SessionRow } from "../src/protocol.js";
import { sessionsAwaitingYou } from "../src/components/RecoveryBanner.js";
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

function mountedApp(): Harness {
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

type OpFrame = { id: number; op: { op: string; [k: string]: unknown } };
const opFrames = (h: Harness): OpFrame[] =>
  h.server
    .clientFrames()
    .filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f && "id" in f);

/** Reply to every pending recoveryStatus frame with `rows` (the 5s poll re-asks). */
const replyRecovery = (h: Harness, rows: readonly unknown[] | "err"): void => {
  act(() => {
    for (const f of opFrames(h)) {
      if (f.op.op === "recoveryStatus") {
        if (rows === "err") {
          h.server.socket.serverSend({ t: "result", id: f.id, err: "recovery not supported by this server" });
        } else {
          h.server.socket.serverSend({ t: "result", id: f.id, ok: rows });
        }
      }
    }
  });
};

/** auth → settingsStatus(buddy)（215 unread receipts 同款最小形状）。 */
async function replySettings(h: Harness): Promise<void> {
  await act(async () => {
    const op = opFrames(h).find((o) => o.op.op === "settingsStatus");
    h.server.socket.serverSend({
      t: "result",
      id: op?.id,
      ok: { settings: { memoryEnabled: true, uiDefaultMode: "buddy" } },
    });
  });
}

/** Answer EVERY pending sessions fetch（侧栏与点名标题联表都消费这个 op——
 * 两条 fetch 都要应答，否则侧栏停在骨架）。 */
async function replySessionsAll(h: Harness, rows: readonly SessionRow[]): Promise<void> {
  await act(async () => {
    for (const f of opFrames(h)) {
      if (f.op.op === "sessions") {
        h.server.socket.serverSend({ t: "result", id: f.id, ok: rows });
      }
    }
  });
}

/** 点名标题联表在 awaiting 出现后才发 sessions（App 级 join 的成员驱动
 * fetch）——等待出现后等这轮 op 并应答（真 server 必应；fake 同形）。 */
async function replyTitleJoin(h: Harness, rows: readonly SessionRow[]): Promise<void> {
  const before = opFrames(h).filter((f) => f.op.op === "sessions").length;
  await until(
    () => opFrames(h).filter((f) => f.op.op === "sessions").length > before,
    "the title-join sessions fetch",
  );
  await replySessionsAll(h, rows);
}

afterEach(() => {
  act(() => {
    root?.unmount();
    root = null;
  });
  document.body.innerHTML = "";
  window.localStorage.removeItem("wudao.ui.v1");
  window.localStorage.removeItem("wudao.recap.v1");
  window.localStorage.removeItem("wudao.archive.v1");
  window.localStorage.removeItem("wudao.unread.v1");
  document.title = "";
});

const ASK = { toolName: "shell", summary: "./nightly.sh", question: "允许 shell：./nightly.sh？" };
const blockedRow = (sessionId: string): RecoveryStatusRowWire =>
  ({ sessionId, state: "blocked", permissionAsk: ASK }) as RecoveryStatusRowWire;

const DAY = 86_400_000;
const row = (over: Partial<SessionRow> & { id: string }): SessionRow => ({
  mtime: new Date(Date.now() - 5 * 60_000).toISOString(),
  messages: 2,
  firstUser: "",
  model: "deepseek-chat",
  ...over,
});

/** 四行：boot 活跃 / 等待目标 / 未读对照（非等待）/ pet 车道。 */
const seedRows = (): SessionRow[] => [
  row({ id: "wudao-test-0001", name: "正在用的会话", messages: 5 }),
  row({ id: "wudao-await-01", name: "夜里停下的托付", messages: 4 }),
  row({ id: "wudao-other-02", name: "另一件托付", messages: 9 }),
  row({ id: "wudao-pet-0009", lane: "pet", messages: 2 }),
];

/** The ACTIVE-list row (.sb-list 内) whose title cell reads `title`. */
const activeRow = (h: Harness, title: string): HTMLElement | undefined =>
  ([...h.container.querySelectorAll(".sb-list .sb-i")] as HTMLElement[])
    .find((r) => r.querySelector(".sb-t")?.textContent === title);

/** buddy 挂到侧栏行可见为止（点名/徽标两 face 的公共底座）。 */
async function buddyApp(rows: readonly SessionRow[] = seedRows()): Promise<Harness> {
  const h = mountedApp();
  await act(async () => {
    authOk(h.server.socket); // boot：sessionId=wudao-test-0001、空 history → 欢迎面在场
  });
  await replySettings(h);
  await replySessionsAll(h, rows);
  await until(() => h.container.querySelector(".sb-list .sb-i") !== null, "sidebar rows");
  return h;
}

describe("R1 sessionsAwaitingYou 派生纯函数（面一：零新 op 的全局派生）", () => {
  it("多行输入：blocked+permissionAsk 行恰入选（id 列表）；落定/非 blocked/无证据行不入选；空输入与 undefined=空", () => {
    const rows: RecoveryStatusRowWire[] = [
      { sessionId: "night-a", state: "blocked", permissionAsk: ASK },
      { sessionId: "night-b", state: "blocked" }, // 无证据（未 park 的 blocked）
      { sessionId: "settled", state: "recovering", verifiedDone: 2, remaining: 1 }, // 落定
      { sessionId: "recov-ask", state: "recovering", verifiedDone: 2, remaining: 1, permissionAsk: ASK }, // 非 blocked
      { sessionId: "active-ask", state: "active", permissionAsk: ASK }, // 非 blocked
      { sessionId: "unf-ask", state: "unfinished", permissionAsk: ASK }, // 非 blocked
      { sessionId: "night-c", state: "blocked", permissionAsk: ASK },
      { sessionId: "term-ask", state: "terminal", permissionAsk: ASK }, // 非 blocked
    ];
    expect(sessionsAwaitingYou(rows)).toEqual(["night-a", "night-c"]);
    expect(sessionsAwaitingYou([])).toEqual([]);
    expect(sessionsAwaitingYou(undefined)).toEqual([]);
  });

  it("空输入=空；行序保持（服务端 mem 序即点名序）", () => {
    expect(sessionsAwaitingYou([{ sessionId: "x", state: "blocked", permissionAsk: ASK }, { sessionId: "y", state: "blocked", permissionAsk: ASK }])).toEqual(["x", "y"]);
  });
});

describe("R2 会话列表徽标面（面二：blocked(权限) 行挂「等你授权」）", () => {
  it("等待会话行有徽标（文案钉「等你授权」）；pet 行永不；其余行零徽标", async () => {
    const h = await buddyApp();
    await until(() => opFrames(h).some((f) => f.op.op === "recoveryStatus"), "recoveryStatus op sent");
    // pet 行也带上 ask 证据（fake 故意违反实况——防御层钉：渲染层拒绝）。
    replyRecovery(h, [blockedRow("wudao-await-01"), blockedRow("wudao-pet-0009")]);
    await until(
      () => activeRow(h, "夜里停下的托付")?.querySelector(".sb-await") != null,
      "the awaiting badge renders",
    );
    expect(activeRow(h, "夜里停下的托付")?.querySelector(".sb-await")?.textContent).toBe("等你授权");
    expect(activeRow(h, "小精灵")?.querySelector(".sb-await")).toBeNull(); // pet 永不
    expect(activeRow(h, "正在用的会话")?.querySelector(".sb-await")).toBeNull();
    expect(activeRow(h, "另一件托付")?.querySelector(".sb-await")).toBeNull();
  }, 10_000);

  it("徽标随 settle（应答落定）消失——下一次 5s 轮询回不再带证据的行", async () => {
    const h = await buddyApp();
    await until(() => opFrames(h).some((f) => f.op.op === "recoveryStatus"), "recoveryStatus op sent");
    replyRecovery(h, [blockedRow("wudao-await-01")]);
    await until(
      () => activeRow(h, "夜里停下的托付")?.querySelector(".sb-await") != null,
      "the awaiting badge renders",
    );
    const seen = opFrames(h).filter((f) => f.op.op === "recoveryStatus").length;
    await until(
      () => opFrames(h).filter((f) => f.op.op === "recoveryStatus").length > seen,
      "the 5s poll re-asks",
      9_000,
    );
    replyRecovery(h, [{ sessionId: "wudao-await-01", state: "recovering", verifiedDone: 2, remaining: 1 }]);
    await until(
      () => activeRow(h, "夜里停下的托付")?.querySelector(".sb-await") == null,
      "the badge disappears after the settle",
    );
  }, 20_000);

  it("老 server（recoveryStatus 拒答）零徽标零报错面", async () => {
    const h = await buddyApp();
    await until(() => opFrames(h).some((f) => f.op.op === "recoveryStatus"), "recoveryStatus op sent");
    replyRecovery(h, "err");
    await wait(50);
    expect(h.container.querySelector(".sb-await")).toBeNull();
    expect(h.container.textContent).not.toContain("recovery not supported");
    // 侧栏本体不受扰（既有行照常）。
    expect(activeRow(h, "夜里停下的托付")).toBeDefined();
  }, 10_000);

  it("共存裁决：等待行有未读差值也只显「等你授权」一枚状态徽标（不堆砌）；非等待行的「N 新」原样（215 家族零演进）", async () => {
    window.localStorage.setItem(
      "wudao.unread.v1",
      JSON.stringify({ marks: { "wudao-await-01": 0, "wudao-other-02": 6 } }),
    );
    const h = await buddyApp();
    await until(() => opFrames(h).some((f) => f.op.op === "recoveryStatus"), "recoveryStatus op sent");
    replyRecovery(h, [blockedRow("wudao-await-01")]);
    await until(
      () => activeRow(h, "夜里停下的托付")?.querySelector(".sb-await") != null,
      "the awaiting badge renders",
    );
    const waiting = activeRow(h, "夜里停下的托付");
    expect(waiting?.querySelector(".sb-unread")).toBeNull(); // 等待压过未读（一枚状态徽标）
    expect(waiting?.querySelectorAll(".sb-await")).toHaveLength(1);
    // 非等待行：未读徽标家族原样（9−6=3 新）。
    expect(activeRow(h, "另一件托付")?.querySelector(".sb-unread")?.textContent).toBe("3 新");
    expect(activeRow(h, "另一件托付")?.querySelector(".sb-await")).toBeNull();
  }, 10_000);
});

describe("R3 欢迎页点名面（面三：boot 后「有 N 个会话在等你授权」）", () => {
  it("N=1 形逐字：点名行带会话标题；点击走既有选中通路（resume op）", async () => {
    const h = await buddyApp();
    await until(() => opFrames(h).some((f) => f.op.op === "recoveryStatus"), "recoveryStatus op sent");
    replyRecovery(h, [blockedRow("wudao-await-01")]);
    await replyTitleJoin(h, seedRows());
    await until(
      () => h.container.querySelector(".hero-await")?.textContent?.includes("夜里停下的托付") === true,
      "the hero naming line renders with the session title",
    );
    expect(h.container.querySelector(".hero-await")?.textContent).toBe("有 1 个会话在等你授权：夜里停下的托付");
    // 欢迎面本体原样（211 邻接零演进）。
    expect(h.container.querySelector(".hero h1")?.textContent).toBe("你好呀，我是悟道Harness");
    // 点击 = 既有选中通路：resume op 带该会话 id。
    const resumesBefore = opFrames(h).filter((f) => f.op.op === "resume").length;
    await act(async () => {
      (h.container.querySelector<HTMLButtonElement>(".hero-await-name"))?.click();
    });
    const resumes = opFrames(h).filter((f) => f.op.op === "resume");
    expect(resumes.length).toBe(resumesBefore + 1);
    expect((resumes.at(-1)?.op as { id?: string } | undefined)?.id).toBe("wudao-await-01");
  }, 10_000);

  it("N>1 形逐字：多个标题以「、」连缀；各名各自可点", async () => {
    const h = await buddyApp();
    await until(() => opFrames(h).some((f) => f.op.op === "recoveryStatus"), "recoveryStatus op sent");
    replyRecovery(h, [blockedRow("wudao-await-01"), blockedRow("wudao-other-02")]);
    await replyTitleJoin(h, seedRows());
    await until(
      () => h.container.querySelector(".hero-await")?.textContent?.includes("另一件托付") === true,
      "the hero naming line renders with both titles",
    );
    expect(h.container.querySelector(".hero-await")?.textContent).toBe("有 2 个会话在等你授权：夜里停下的托付、另一件托付");
    const names = [...h.container.querySelectorAll<HTMLButtonElement>(".hero-await-name")];
    expect(names).toHaveLength(2);
    const resumesBefore = opFrames(h).filter((f) => f.op.op === "resume").length;
    await act(async () => {
      names[1]?.click();
    });
    const resumes = opFrames(h).filter((f) => f.op.op === "resume");
    expect(resumes.length).toBe(resumesBefore + 1);
    expect((resumes.at(-1)?.op as { id?: string } | undefined)?.id).toBe("wudao-other-02");
  }, 10_000);

  it("N=0 零渲染（无等待=零渲染零噪音）；无 props 的 EmptyHero 挂载字节同形", async () => {
    const h = await buddyApp();
    await until(() => opFrames(h).some((f) => f.op.op === "recoveryStatus"), "recoveryStatus op sent");
    replyRecovery(h, [{ sessionId: "wudao-await-01", state: "recovering", verifiedDone: 2, remaining: 1 }]);
    await wait(80);
    expect(h.container.querySelector(".hero-await")).toBeNull();
    expect(h.container.querySelector(".sb-await")).toBeNull();
    expect(h.container.querySelector(".hero h1")?.textContent).toBe("你好呀，我是悟道Harness");
    // 裸挂载（SimpleMode 的同款）：无 props → 无点名行（可选 prop 缺席=字节同形）。
    const bare = mount(<EmptyHero />);
    expect(bare.querySelector(".hero-await")).toBeNull();
    expect(bare.querySelector(".hero h1")?.textContent).toBe("你好呀，我是悟道Harness");
  }, 10_000);

  it("sessions 列表缺席该会话 → 标题兜 id8（标题梯子末层同语义）", async () => {
    const h = await buddyApp(seedRows().filter((r) => r.id !== "wudao-await-01"));
    await until(() => opFrames(h).some((f) => f.op.op === "recoveryStatus"), "recoveryStatus op sent");
    replyRecovery(h, [blockedRow("wudao-await-01")]);
    await until(
      () => h.container.querySelector(".hero-await") !== null,
      "the hero naming line renders",
    );
    expect(h.container.querySelector(".hero-await")?.textContent).toBe("有 1 个会话在等你授权：wudao-aw");
  }, 10_000);
});

describe("R4 静默降级（老 server 拒答/超时=全局面安静消失，恢复后回来）", () => {
  it("拒答 → 点名行零渲染零报错；服务恢复（下一次轮询应答）→ 点名行回来", async () => {
    const h = await buddyApp();
    await until(() => opFrames(h).some((f) => f.op.op === "recoveryStatus"), "recoveryStatus op sent");
    replyRecovery(h, "err");
    await wait(50);
    expect(h.container.querySelector(".hero-await")).toBeNull();
    expect(h.container.textContent).not.toContain("recovery not supported");
    // 恢复：下一次 5s 轮询应答带证据的行 → 点名行回来（不残影也不卡死）。
    const seen = opFrames(h).filter((f) => f.op.op === "recoveryStatus").length;
    await until(
      () => opFrames(h).filter((f) => f.op.op === "recoveryStatus").length > seen,
      "the 5s poll re-asks",
      9_000,
    );
    replyRecovery(h, [blockedRow("wudao-await-01")]);
    await replyTitleJoin(h, seedRows());
    await until(
      () => h.container.querySelector(".hero-await")?.textContent?.includes("夜里停下的托付") === true,
      "the naming line comes back",
    );
    expect(h.container.querySelector(".hero-await")?.textContent).toBe("有 1 个会话在等你授权：夜里停下的托付");
  }, 20_000);
});

describe("R5 邻接零演进（242 对账行/248 晨间行语义不破；235 pet/214 归档/215 未读徽标族零演进）", () => {
  it("当前会话的 248 晨间行 + 242 对账行语义原样（选中态行为字节不变），与全局面互不干扰", async () => {
    const h = await buddyApp();
    await until(() => opFrames(h).some((f) => f.op.op === "recoveryStatus"), "recoveryStatus op sent");
    // 当前会话（wudao-test-0001）blocked+ask + 另一会话 blocked+ask 同时在场。
    replyRecovery(h, [blockedRow("wudao-test-0001"), blockedRow("wudao-await-01")]);
    await replyTitleJoin(h, seedRows());
    await until(
      () => h.container.textContent?.includes("昨夜停在这里等你授权") === true,
      "the morning line renders (248, unchanged)",
    );
    expect(h.container.textContent).toContain("允许 shell：./nightly.sh");
    // 全局面同时在（互不干扰）：徽标 + 点名行各自在场。fake 允许当前会话也
    // 携证据（真 server 镜像规则永不）——派生诚实照数（2），实况语义不受
    // 本弧影响。
    expect(activeRow(h, "夜里停下的托付")?.querySelector(".sb-await")?.textContent).toBe("等你授权");
    await until(
      () => h.container.querySelector(".hero-await")?.textContent?.includes("夜里停下的托付") === true,
      "the naming line renders alongside the morning line",
    );
    expect(h.container.querySelector(".hero-await")?.textContent).toBe("有 2 个会话在等你授权：正在用的会话、夜里停下的托付");
    // 落定后：晨间行撤、对账行接管（242 face，字节不变）。
    const seen = opFrames(h).filter((f) => f.op.op === "recoveryStatus").length;
    await until(
      () => opFrames(h).filter((f) => f.op.op === "recoveryStatus").length > seen,
      "the 5s poll re-asks",
      9_000,
    );
    replyRecovery(h, [
      { sessionId: "wudao-test-0001", state: "recovering", verifiedDone: 2, remaining: 1 },
    ]);
    await until(
      () => h.container.textContent?.includes("昨夜停在这里等你授权") !== true,
      "the morning line withdraws",
    );
    expect(h.container.textContent).toContain("已验证完成 2 / 待续 1");
    expect(h.container.querySelector(".recovery-banner")?.getAttribute("role")).toBe("status");
  }, 20_000);

  it("pet 车道零演进：标题仍「小精灵」、点击 toast 不 resume（235 家族）", async () => {
    const h = await buddyApp();
    await until(() => opFrames(h).some((f) => f.op.op === "recoveryStatus"), "recoveryStatus op sent");
    replyRecovery(h, [blockedRow("wudao-await-01"), blockedRow("wudao-pet-0009")]);
    await until(
      () => activeRow(h, "夜里停下的托付")?.querySelector(".sb-await") != null,
      "the awaiting badge renders",
    );
    const petRow = activeRow(h, "小精灵");
    expect(petRow?.querySelector(".sb-t")?.textContent).toBe("小精灵"); // 标题面原样
    expect(petRow?.querySelector(".sb-await")).toBeNull(); // 徽标面：pet 永不
    const resumesBefore = opFrames(h).filter((f) => f.op.op === "resume").length;
    await act(async () => {
      petRow?.click();
    });
    expect(h.container.querySelector(".sb-toast")?.textContent).toBe("精灵会话在精灵窗口继续");
    expect(opFrames(h).filter((f) => f.op.op === "resume").length).toBe(resumesBefore); // 零 resume
  }, 10_000);

  it("归档共存（214 家族零演进）：等待行被归档 → 活跃列表与归档箱行均无徽标（收起的就是不打扰的），恢复回列徽标即在", async () => {
    window.localStorage.setItem("wudao.archive.v1", JSON.stringify({ archived: ["wudao-await-01"] }));
    const h = await buddyApp();
    await until(() => opFrames(h).some((f) => f.op.op === "recoveryStatus"), "recoveryStatus op sent");
    replyRecovery(h, [blockedRow("wudao-await-01")]);
    await wait(80);
    expect(activeRow(h, "夜里停下的托付")).toBeUndefined(); // 被归档滤出活跃列表
    const head = h.container.querySelector<HTMLElement>(".sb-arch-h");
    expect(head?.textContent).toContain("已归档 1"); // 214 折叠组原样
    await act(async () => {
      head?.click(); // 展开
    });
    const archRow = ([...h.container.querySelectorAll(".sb-arch-list .sb-arch-i")] as HTMLElement[])
      .find((r) => r.querySelector(".sb-t")?.textContent === "夜里停下的托付");
    expect(archRow?.querySelector(".sb-await")).toBeNull(); // 归档行无徽标
    await act(async () => {
      archRow?.click(); // 恢复
    });
    expect(activeRow(h, "夜里停下的托付")?.querySelector(".sb-await")?.textContent).toBe("等你授权");
  }, 10_000);
});
