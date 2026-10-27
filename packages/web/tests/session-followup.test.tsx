// @vitest-environment jsdom
// 小精灵会话弧（会话体验：选择会话、基于会话恢复或追问）—— web 侧钉件：
// ①SessionSidebar 行内「追问」hover 动作触发 resume 的 fork 形 op（原会话
// 永不改写；行点击的「恢复」语义并存、追问点击不顺带 resume）；②EmptyHero
// 空态双入口（继续上次会话=既有 resume 通路取 mtime 最新非 pet 行；从历史
// 会话提问=选择器 followup 意图，拣选走 fork 流）；③零噪音门（无历史会话/
// prop 缺席 → 双入口零渲染，hero 字节同形）；④回执分叉（busy 拒答的人话
// toast）。全 App harness（248/251 式样，mock-ws 家族全 mock 零真网络；夹具
// 零盘写——只碰 jsdom localStorage）。
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/components/App.js";
import { EmptyHero } from "../src/components/EmptyHero.js";
import { ResumePicker } from "../src/components/ResumePicker.js";
import { WudaoClient } from "../src/protocol.js";
import type { SessionRow } from "../src/protocol.js";
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

/** Answer EVERY pending sessions fetch（侧栏 + hero 数据门 + onAskFromHistory
 *  的装载取数都是这个 op——全部应答，否则哪条停在骨架）。 */
async function replySessionsAll(h: Harness, rows: readonly SessionRow[]): Promise<void> {
  await act(async () => {
    for (const f of opFrames(h)) {
      if (f.op.op === "sessions") {
        h.server.socket.serverSend({ t: "result", id: f.id, ok: rows });
      }
    }
  });
}

/** auth → settingsStatus(buddy)（251 式样：buddy 挂侧栏+共享 chatColumn）。 */
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

/** 应答最近一条 resume op（fork 形与否由 frame 自带）。 */
const replyResume = (h: Harness, ok: unknown): void => {
  const f = opFrames(h).filter((x) => x.op.op === "resume").at(-1);
  if (f !== undefined) h.server.socket.serverSend({ t: "result", id: f.id, ok });
};

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

const MIN = 60_000;
const row = (over: Partial<SessionRow> & { id: string }): SessionRow => ({
  mtime: new Date(Date.now() - 5 * MIN).toISOString(),
  messages: 2,
  firstUser: "",
  model: "deepseek-chat",
  ...over,
});

/** 三行 + pet：mtime 阶梯——older（1 小时前）/ boot 活跃（30 分钟前）/
 * latest（5 分钟前，非 pet 中最新）/ pet 车道（不可恢复）。 */
const seedRows = (): SessionRow[] => [
  row({ id: "wudao-old-0001", name: "上周的活", mtime: new Date(Date.now() - 60 * MIN).toISOString() }),
  row({ id: "wudao-test-0001", name: "正在用的会话", mtime: new Date(Date.now() - 30 * MIN).toISOString() }),
  row({ id: "wudao-new-0002", name: "最新的托付", mtime: new Date(Date.now() - 5 * MIN).toISOString() }),
  row({ id: "wudao-pet-0009", lane: "pet", mtime: new Date(Date.now() - 2 * MIN).toISOString() }),
];

/** The ACTIVE-list row (.sb-list 内) whose title cell reads `title`. */
const activeRow = (h: Harness, title: string): HTMLElement | undefined =>
  ([...h.container.querySelectorAll(".sb-list .sb-i")] as HTMLElement[])
    .find((r) => r.querySelector(".sb-t")?.textContent === title);

/** The row's hover 追问 button（.sb-follow——214 归档弧把 .sb-act 钉成归档
 *  专属，追问是独立类名）。 */
const followUpBtn = (rowEl: HTMLElement | undefined): HTMLButtonElement | null =>
  rowEl === undefined ? null : (rowEl.querySelector<HTMLButtonElement>(".sb-follow") ?? null);

/** buddy 挂到侧栏行可见为止（欢迎面在场：空 history）。 */
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

describe("SessionSidebar 行内「追问」动作（fork 该会话进副本继续问）", () => {
  it("非 pet 行有「追问」hover 动作；点击发 resume 的 fork 形 op（id 直传）且不顺带 resume 原会话", async () => {
    const h = await buddyApp();
    const rowEl = activeRow(h, "上周的活");
    expect(followUpBtn(rowEl)).not.toBeNull(); // 动作在场
    const resumesBefore = opFrames(h).filter((f) => f.op.op === "resume").length;
    await act(async () => {
      followUpBtn(rowEl)?.click();
    });
    const resumes = opFrames(h).filter((f) => f.op.op === "resume");
    expect(resumes.length).toBe(resumesBefore + 1); // 恰一条（点击未顺带第二条）
    const sent = resumes.at(-1)?.op as { id?: string; fork?: boolean };
    expect(sent.id).toBe("wudao-old-0001");
    expect(sent.fork).toBe(true); // fork 形（原会话永不改写）
  }, 10_000);

  it("pet 行永无「追问」（精灵会话在精灵窗口活着，租约互斥——行点击 toast 同判据）", async () => {
    const h = await buddyApp();
    expect(followUpBtn(activeRow(h, "小精灵"))).toBeNull();
    expect(followUpBtn(activeRow(h, "正在用的会话"))).not.toBeNull(); // 邻行原样（活跃行也可对自己岔线）
  }, 10_000);

  it("成功回执：收据话术 + 聚焦输入框（seed 以当前 buffer 重播，不打断草稿）", async () => {
    const h = await buddyApp();
    await act(async () => {
      followUpBtn(activeRow(h, "上周的活"))?.click();
    });
    await act(async () => {
      replyResume(h, { ok: true, forkedId: "wudao-fork-0007" });
    });
    await until(
      () => h.container.textContent?.includes("已基于这段对话开了新篇") === true,
      "the fork receipt note",
    );
    // 聚焦：seed 落到输入框（textarea 持有焦点）。
    const ta = h.container.querySelector<HTMLTextAreaElement>("textarea");
    expect(ta).not.toBeNull();
    expect(document.activeElement).toBe(ta);
  }, 10_000);

  it("busy 拒答的人话 toast（主车道换血不能打断运行中的回合）", async () => {
    const h = await buddyApp();
    await act(async () => {
      followUpBtn(activeRow(h, "上周的活"))?.click();
    });
    await act(async () => {
      replyResume(h, { ok: false, reason: "busy" });
    });
    await until(
      () => h.container.textContent?.includes("任务进行中——等它跑完再追问") === true,
      "the busy refusal toast",
    );
  }, 10_000);
});

describe("EmptyHero 空态双入口", () => {
  it("有历史会话 → 两入口渲染（文案钉）+「继续上次会话」走既有 resume 通路（mtime 最新非 pet 行，无 fork 字段）", async () => {
    const h = await buddyApp();
    await until(() => h.container.querySelector(".hero-actions") !== null, "the hero action row");
    const btns = [...h.container.querySelectorAll<HTMLButtonElement>(".hero-act")];
    expect(btns.map((b) => b.textContent)).toEqual(["继续上次会话", "从历史会话提问"]);
    const resumesBefore = opFrames(h).filter((f) => f.op.op === "resume").length;
    await act(async () => {
      btns[0]?.click();
    });
    const resumes = opFrames(h).filter((f) => f.op.op === "resume");
    expect(resumes.length).toBe(resumesBefore + 1);
    const sent = resumes.at(-1)?.op as { id?: string; fork?: boolean };
    expect(sent.id).toBe("wudao-new-0002"); // 最新非 pet（pet 行 2 分钟前也不算）
    expect(sent.fork).toBeUndefined(); // 恢复=继续原会话，不是 fork
  }, 10_000);

  it("「从历史会话提问」→ 选择器以追问语打开；拣选走 fork 流（fork:true + 选中 id）", async () => {
    const h = await buddyApp();
    await until(() => h.container.querySelector(".hero-actions") !== null, "the hero action row");
    // 快照在点击前取（点击的 act 内 op 已上链——取晚了基线就含它，永远等不到 +1）。
    const sessionsBefore = opFrames(h).filter((f) => f.op.op === "sessions").length;
    await act(async () => {
      ([...h.container.querySelectorAll<HTMLButtonElement>(".hero-act")].find((b) => b.textContent === "从历史会话提问"))?.click();
    });
    await until(
      () => opFrames(h).filter((f) => f.op.op === "sessions").length > sessionsBefore,
      "the picker's sessions fetch",
    );
    await replySessionsAll(h, seedRows());
    // 选择器：followup 意图的标题/说明（选器哑组件，语义在 App 接的 onPick）。
    await until(() => h.container.querySelector(".modal-card h3")?.textContent === "选择要追问的会话", "the followup picker heading");
    expect(h.container.textContent).toContain("选中后开一份副本继续问");
    const pickRows = [...h.container.querySelectorAll<HTMLButtonElement>(".pickrow")];
    expect(pickRows.length).toBeGreaterThan(0);
    const resumesBefore = opFrames(h).filter((f) => f.op.op === "resume").length;
    await act(async () => {
      pickRows[0]?.click(); // 行序=rows 序（第一行=上周的活）
    });
    const resumes = opFrames(h).filter((f) => f.op.op === "resume");
    expect(resumes.length).toBe(resumesBefore + 1);
    const sent = resumes.at(-1)?.op as { id?: string; fork?: boolean };
    expect(sent.id).toBe("wudao-old-0001");
    expect(sent.fork).toBe(true);
    await until(() => h.container.querySelector(".modal-card") == null, "the picker closes on pick");
  }, 10_000);

  it("零噪音门：无历史会话 → 双入口零渲染（hero 字节同形）；裸挂载同形", async () => {
    const h = await buddyApp([row({ id: "wudao-pet-0009", lane: "pet" })]); // 只有 pet 行=无可续会话
    await until(() => h.container.querySelector(".sb-list .sb-i") !== null, "sidebar rows");
    await wait(80);
    expect(h.container.querySelector(".hero-actions")).toBeNull();
    expect(h.container.querySelector(".hero h1")?.textContent).toBe("你好呀，我是悟道Harness");
    // 组件级裸挂载（SimpleMode 的同款）：无 props → 无双入口（可选 prop 缺席=字节同形）。
    const bare = mount(<EmptyHero />);
    expect(bare.querySelector(".hero-actions")).toBeNull();
  }, 10_000);

  it("ResumePicker 缺省意图=恢复语（/resume 命令面字节同形钉）", () => {
    const el = mount(
      <ResumePicker rows={[row({ id: "wudao-old-0001" })]} onPick={() => {}} onCancel={() => {}} />,
    );
    expect(el.querySelector(".modal-card h3")?.textContent).toBe("选择要恢复的会话");
    expect(el.querySelector(".muted")?.textContent).toBe("仅列出记录在当前工作区的会话");
  });
});
