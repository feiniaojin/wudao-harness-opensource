// @vitest-environment jsdom
// ω99-254: #4 — 系统级通知 R 件（R1-R5；R6 红线走弧门 shell 取证：diff 新增
// 行与新件的删除调用双零、零 exec 零真网络）。发现性三件套第三面：248 晨间
// 行（会话内）+ 251 徽标/点名（应用内列表）之外，夜里 park 在权限问句上的
// 会话由本弧送 macOS 通知中心——转移触发（boot 首轮带既有等待也算）、聚焦
// 抑制（hidden 或 visible-unfocused 才发）、同 tick 合并为一通知（绝不连发
// 轰炸）、每次 park 事件恰一通知。全 App harness（251 式样，mock-ws 家族
// 全 mock 零真网络；通知桥照 finish-notify 式样钉 __TAURI_INTERNALS__.invoke
// ——真 Tauri v2 webview 恒注入的那一层）。
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/components/App.js";
import { WudaoClient, type RecoveryStatusRowWire } from "../src/protocol.js";
import type { SessionRow } from "../src/protocol.js";
import { awaitingNotificationOf } from "../src/components/RecoveryBanner.js";
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
  calls: { cmd: string; args: unknown }[];
}

/** The desktop bridge pin (finish-notify 式样)：__TAURI_INTERNALS__.invoke 收
 *  plugin:notification|notify——本弧的发射断言全走这里。同时钉 hasFocus=false
 *  （可见未聚焦=安静门开的缺省态）：jsdom 里 App 挂载即 focus 输入框，元素
 *  焦点会传导成 document.hasFocus()=true（真浏览器只跟窗口焦点）——不钉则
 *  缺省态漂移；聚焦/hidden 态由各测试自钉。 */
function mountedApp(): Harness {
  const calls: { cmd: string; args: unknown }[] = [];
  document.hasFocus = () => false;
  (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args: unknown) => {
      calls.push({ cmd, args });
      return Promise.resolve();
    },
  };
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
  return { container, client, server, calls };
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

/** auth → settingsStatus（mode 可钉：null=非 buddy，R1 的模式无关钉用）。 */
async function replySettings(h: Harness, uiDefaultMode: string | null = "buddy"): Promise<void> {
  await act(async () => {
    const op = opFrames(h).find((o) => o.op.op === "settingsStatus");
    h.server.socket.serverSend({
      t: "result",
      id: op?.id,
      ok: { settings: { memoryEnabled: true, uiDefaultMode } },
    });
  });
}

/** Answer EVERY pending sessions fetch（侧栏与点名标题联表都消费这个 op）。 */
async function replySessionsAll(h: Harness, rows: readonly SessionRow[]): Promise<void> {
  await act(async () => {
    for (const f of opFrames(h)) {
      if (f.op.op === "sessions") {
        h.server.socket.serverSend({ t: "result", id: f.id, ok: rows });
      }
    }
  });
}

/** 点名标题联表在 awaiting 出现后才发 sessions——等待出现后等这轮 op 并应答
 * （通知的 body 等这轮联表落定才发射）。 */
async function replyTitleJoin(h: Harness, rows: readonly SessionRow[]): Promise<void> {
  const before = opFrames(h).filter((f) => f.op.op === "sessions").length;
  await until(
    () => opFrames(h).filter((f) => f.op.op === "sessions").length > before,
    "the title-join sessions fetch",
  );
  await replySessionsAll(h, rows);
}

/** 等下一次 5s 轮询的 recoveryStatus op 到来（答完当前轮后的下一轮）。 */
async function nextPoll(h: Harness): Promise<void> {
  const seen = opFrames(h).filter((f) => f.op.op === "recoveryStatus").length;
  await until(
    () => opFrames(h).filter((f) => f.op.op === "recoveryStatus").length > seen,
    "the 5s poll re-asks",
    9_000,
  );
}

const setHidden = (hidden: boolean): void => {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
};

/** buddy 挂到侧栏行可见为止（251 式样公共底座；jsdom 默认=可见+未聚焦，
 *  即安静门开的态——聚焦态由各测试自钉 hasFocus）。 */
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

/** The notification-plugin invokes the bridge recorded (the arc's firing face). */
const notes = (h: Harness): { cmd: string; args: unknown }[] =>
  h.calls.filter((c) => c.cmd === "plugin:notification|notify");

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
  setHidden(false); // 各测试自钉三态；还原子序
  delete (document as { hasFocus?: () => boolean }).hasFocus;
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  delete (window as { __TAURI__?: unknown }).__TAURI__;
});

const ASK = { toolName: "shell", summary: "./nightly.sh", question: "允许 shell：./nightly.sh？" };
const blockedRow = (sessionId: string): RecoveryStatusRowWire =>
  ({ sessionId, state: "blocked", permissionAsk: ASK }) as RecoveryStatusRowWire;
const settledRow = (sessionId: string): RecoveryStatusRowWire =>
  ({ sessionId, state: "recovering", verifiedDone: 2, remaining: 1 }) as RecoveryStatusRowWire;

const row = (over: Partial<SessionRow> & { id: string }): SessionRow => ({
  mtime: new Date(Date.now() - 5 * 60_000).toISOString(),
  messages: 2,
  firstUser: "",
  model: "deepseek-chat",
  ...over,
});

/** 四行：boot 活跃 / 等待目标 ×2 / pet 车道。 */
const seedRows = (): SessionRow[] => [
  row({ id: "wudao-test-0001", name: "正在用的会话", messages: 5 }),
  row({ id: "wudao-await-01", name: "夜里停下的托付", messages: 4 }),
  row({ id: "wudao-other-02", name: "另一件托付", messages: 9 }),
  row({ id: "wudao-pet-0009", lane: "pet", messages: 2 }),
];

const SINGLE_TITLE = "⏸ 悟道Harness — 有会话在等你授权";

describe("R1 转移检测（新进入者 diff：每次 park 事件恰一通知）", () => {
  it("新 id 进入 → 恰一通知；同 id 后续轮询零再发；settle 离场清登记 → 再挂再发", async () => {
    const h = await buddyApp();
    await until(() => opFrames(h).some((f) => f.op.op === "recoveryStatus"), "recoveryStatus op sent");
    replyRecovery(h, [blockedRow("wudao-await-01")]);
    await replyTitleJoin(h, seedRows());
    await until(() => notes(h).length === 1, "the first notification fired");
    // 同 id 后续轮询（同证据行再答）：零再发。
    await nextPoll(h);
    replyRecovery(h, [blockedRow("wudao-await-01")]);
    await wait(150);
    expect(notes(h)).toHaveLength(1);
    // settle（id 离开 awaiting）→ 登记清除；settle 本身零通知。
    await nextPoll(h);
    replyRecovery(h, [settledRow("wudao-await-01")]);
    await wait(150);
    expect(notes(h)).toHaveLength(1);
    // 再挂是新 park 事件 → 再通知（恰一次）。
    await nextPoll(h);
    replyRecovery(h, [blockedRow("wudao-await-01")]);
    await until(() => notes(h).length === 2, "the re-park notification fired");
    await wait(100);
    expect(notes(h)).toHaveLength(2);
  }, 30_000);

  it("boot 首轮带既有等待（晨间开应用）也算转移 → 通知；模式无关：非 buddy 挂载照发", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await replySettings(h, null); // 非 buddy：App 顶层 hook 的模式无关钉
    await until(() => opFrames(h).some((f) => f.op.op === "recoveryStatus"), "recoveryStatus op sent");
    replyRecovery(h, [blockedRow("wudao-await-01"), blockedRow("wudao-other-02")]);
    await replyTitleJoin(h, seedRows());
    await until(() => notes(h).length === 1, "the boot notification fired");
    expect((notes(h)[0]?.args as { options?: { title?: string } }).options?.title).toBe(
      "⏸ 悟道Harness — 有 2 个会话在等你授权",
    );
  }, 15_000);
});

describe("R2 发射形（tauriNotify(title, body?) 的逐字钉；body 缺省省略）", () => {
  it("单会话形逐字：title=⏸ 悟道Harness — 有会话在等你授权、body=该会话标题", async () => {
    const h = await buddyApp();
    await until(() => opFrames(h).some((f) => f.op.op === "recoveryStatus"), "recoveryStatus op sent");
    replyRecovery(h, [blockedRow("wudao-await-01")]);
    await replyTitleJoin(h, seedRows());
    await until(() => notes(h).length === 1, "the notification fired");
    expect(notes(h)[0]?.args).toEqual({ options: { title: SINGLE_TITLE, body: "夜里停下的托付" } });
  }, 15_000);

  it("多会话形逐字：N 进 title、body=标题顿号连缀", async () => {
    const h = await buddyApp();
    await until(() => opFrames(h).some((f) => f.op.op === "recoveryStatus"), "recoveryStatus op sent");
    replyRecovery(h, [blockedRow("wudao-await-01"), blockedRow("wudao-other-02")]);
    await replyTitleJoin(h, seedRows());
    await until(() => notes(h).length === 1, "the merged notification fired");
    expect(notes(h)[0]?.args).toEqual({
      options: { title: "⏸ 悟道Harness — 有 2 个会话在等你授权", body: "夜里停下的托付、另一件托付" },
    });
  }, 15_000);

  it("标题取不到（联表缺席该会话）→ body 键缺席：options 恰 title 一键（finish 调用形零演进的同形）", async () => {
    const without = seedRows().filter((r) => r.id !== "wudao-await-01");
    const h = await buddyApp(without);
    await until(() => opFrames(h).some((f) => f.op.op === "recoveryStatus"), "recoveryStatus op sent");
    replyRecovery(h, [blockedRow("wudao-await-01")]);
    await replyTitleJoin(h, without);
    await until(() => notes(h).length === 1, "the notification fired (body omitted)");
    expect(notes(h)[0]?.args).toEqual({ options: { title: SINGLE_TITLE } });
  }, 15_000);

  it("awaitingNotificationOf 纯函数：>3 标题截三 +「等」；恰 3 无「等」；缺席标题混排省略", () => {
    const five = [1, 2, 3, 4, 5].map((i) => ({ id: `s${i}`, title: `托付${i}` }));
    expect(awaitingNotificationOf(five)).toEqual({
      title: "⏸ 悟道Harness — 有 5 个会话在等你授权",
      body: "托付1、托付2、托付3 等",
    });
    const three = [1, 2, 3].map((i) => ({ id: `s${i}`, title: `托付${i}` }));
    expect(awaitingNotificationOf(three)).toEqual({
      title: "⏸ 悟道Harness — 有 3 个会话在等你授权",
      body: "托付1、托付2、托付3",
    });
    expect(awaitingNotificationOf([{ id: "a", title: undefined }, { id: "b", title: "乙托付" }])).toEqual({
      title: "⏸ 悟道Harness — 有 2 个会话在等你授权",
      body: "乙托付",
    });
    expect(awaitingNotificationOf([{ id: "a", title: undefined }])).toEqual({ title: SINGLE_TITLE });
  });
});

describe("R3 安静门（与 finish 通知同门；jsdom 三态钉）", () => {
  it("聚焦 + 可见 → 零发射（应用内徽标/点名已足）；该 park 事件后续轮询永不补发", async () => {
    const h = await buddyApp();
    setHidden(false);
    document.hasFocus = () => true; // 可见且聚焦：jsdom 原生 hasFocus=false，须自钉
    await until(() => opFrames(h).some((f) => f.op.op === "recoveryStatus"), "recoveryStatus op sent");
    replyRecovery(h, [blockedRow("wudao-await-01")]);
    await replyTitleJoin(h, seedRows());
    await wait(200);
    expect(notes(h)).toHaveLength(0);
    await nextPoll(h);
    replyRecovery(h, [blockedRow("wudao-await-01")]);
    await wait(200);
    expect(notes(h)).toHaveLength(0); // 在场即消费：聚焦期到达的 park 不留补发
  }, 20_000);

  it("hidden → 发射", async () => {
    const h = await buddyApp();
    setHidden(true);
    await until(() => opFrames(h).some((f) => f.op.op === "recoveryStatus"), "recoveryStatus op sent");
    replyRecovery(h, [blockedRow("wudao-await-01")]);
    await replyTitleJoin(h, seedRows());
    await until(() => notes(h).length === 1, "the hidden-state notification fired");
  }, 15_000);

  it("visible + 未聚焦 → 发射（第二屏晾着场景）", async () => {
    const h = await buddyApp();
    setHidden(false);
    document.hasFocus = () => false; // 显式钉：可见但焦点在别的应用
    await until(() => opFrames(h).some((f) => f.op.op === "recoveryStatus"), "recoveryStatus op sent");
    replyRecovery(h, [blockedRow("wudao-await-01")]);
    await replyTitleJoin(h, seedRows());
    await until(() => notes(h).length === 1, "the visible-unfocused notification fired");
  }, 15_000);

  it("桥拒绝 → 静默吞：零 title 闪烁回退（等待授权的浏览器态由 251 徽标+点名接住）、零未处理拒绝", async () => {
    const h = await buddyApp();
    setHidden(true);
    // 同一桥对象换拒答实现（记录后再拒——calls 仍可断言发射尝试过）。
    const internals = (window as { __TAURI_INTERNALS__?: { invoke: unknown } }).__TAURI_INTERNALS__ as {
      invoke: (cmd: string, args: unknown) => Promise<unknown>;
    };
    internals.invoke = (cmd: string, args: unknown) => {
      h.calls.push({ cmd, args });
      return Promise.reject(new Error("plugin gone"));
    };
    await until(() => opFrames(h).some((f) => f.op.op === "recoveryStatus"), "recoveryStatus op sent");
    replyRecovery(h, [blockedRow("wudao-await-01")]);
    await replyTitleJoin(h, seedRows());
    await until(() => h.calls.some((c) => c.cmd === "plugin:notification|notify"), "the rejected notify attempted");
    await wait(100);
    expect(document.title).toBe("悟道Harness"); // 无闪烁回退（finish 的回退是终态通知独有）
  }, 15_000);
});

describe("R4 合并（同 tick 多新进入=一通知；绝不连发轰炸）", () => {
  it("同 tick 两个新 id → 恰一通知、N=2 文案", async () => {
    const h = await buddyApp();
    await until(() => opFrames(h).some((f) => f.op.op === "recoveryStatus"), "recoveryStatus op sent");
    replyRecovery(h, [blockedRow("wudao-await-01"), blockedRow("wudao-other-02")]);
    await replyTitleJoin(h, seedRows());
    await until(() => notes(h).length === 1, "exactly one merged notification");
    await wait(150);
    expect(notes(h)).toHaveLength(1);
    expect((notes(h)[0]?.args as { options?: { title?: string } }).options?.title).toBe(
      "⏸ 悟道Harness — 有 2 个会话在等你授权",
    );
  }, 15_000);

  it("跨 tick 各一：A 先（单形），B 后到 → B 自己的单形通知（body=B 标题）", async () => {
    const h = await buddyApp();
    await until(() => opFrames(h).some((f) => f.op.op === "recoveryStatus"), "recoveryStatus op sent");
    replyRecovery(h, [blockedRow("wudao-await-01")]);
    await replyTitleJoin(h, seedRows());
    await until(() => notes(h).length === 1, "A's notification fired");
    await nextPoll(h);
    replyRecovery(h, [blockedRow("wudao-await-01"), blockedRow("wudao-other-02")]);
    await replyTitleJoin(h, seedRows());
    await until(() => notes(h).length === 2, "B's own notification fired");
    expect(notes(h)[1]?.args).toEqual({ options: { title: SINGLE_TITLE, body: "另一件托付" } });
  }, 25_000);
});

describe("R5 邻接（老 server 拒答安静；248 晨间行共存；251/finish/242/248 面走 census 复跑）", () => {
  it("awaiting 拒答降级（老 server）→ 零通知零报错", async () => {
    const h = await buddyApp();
    await until(() => opFrames(h).some((f) => f.op.op === "recoveryStatus"), "recoveryStatus op sent");
    replyRecovery(h, "err");
    await wait(150);
    expect(notes(h)).toHaveLength(0);
    expect(h.container.textContent).not.toContain("recovery not supported");
  }, 15_000);

  it("248 晨间行原样共存：当前会话 blocked+ask 晨间行在场，系统通知对全量等待发射", async () => {
    const h = await buddyApp();
    await until(() => opFrames(h).some((f) => f.op.op === "recoveryStatus"), "recoveryStatus op sent");
    // fake 允许当前会话也携证据（真 server 镜像规则永不）——派生诚实照数（2）。
    replyRecovery(h, [blockedRow("wudao-test-0001"), blockedRow("wudao-await-01")]);
    await replyTitleJoin(h, seedRows());
    await until(
      () => h.container.textContent?.includes("昨夜停在这里等你授权") === true,
      "the morning line renders (248, unchanged)",
    );
    expect(h.container.textContent).toContain("允许 shell：./nightly.sh");
    await until(() => notes(h).length === 1, "the system notification fired alongside");
    expect((notes(h)[0]?.args as { options?: { title?: string } }).options?.title).toBe(
      "⏸ 悟道Harness — 有 2 个会话在等你授权",
    );
  }, 15_000);
});
