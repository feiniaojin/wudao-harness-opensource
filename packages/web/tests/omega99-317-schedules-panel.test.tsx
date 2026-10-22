// ω99-317 — 定时任务 web 管理面（看/停/试跑闭环）：
//  G) schedulesPanelModel 聚合纯函数——状态徽标（生效中/已暂停/已停用熔
//     断）/下次触发（马上 · M月D日 HH:mm · 暂停/停用各自的收益语）/上次
//     结果（跑成了/没跑成/连败 N 次已停用/还没跑过/还没响过/上次触发）/
//     绑定会话名 join（name → firstUser 阶梯）；
//  H) 「定时 N」chip 门（N>0 才显示，216 改动 chip 同族）+ 面板 DOM +
//     三动作 op 帧（setEnabled/remove/runNow）+ 删除/熔断试跑双确认弹框
//     （.scrim>.modal-card 家族，Esc 取消零 op）+ 动作回执 notify +
//     纪元 refetch；
//  I) CSS 钉——.tb-sched 身份类 + .schedules-panel 进 modal-card 组 +
//     .sch-* 行族在场，零 color-mix（0.3.88 通道令牌律）。
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { readStyles } from "./styles-source.js";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WudaoClient } from "../src/protocol.js";
import type { ScheduleListRow, SessionRow } from "../src/protocol.js";
import { App } from "../src/components/App.js";
import { schedulesPanelModel } from "../src/components/SchedulesPanel.js";
import { authOk, fakeServer } from "./mock-ws.js";
import type { FakeServer } from "./mock-ws.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  window.localStorage.removeItem("wudao.ui.v1");
});

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface AppHarness {
  container: HTMLElement;
  client: WudaoClient;
  server: FakeServer;
}
function mountedApp(status: Record<string, unknown> = {}): AppHarness {
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
    authOk(server.socket, status);
  });
  return { container, client, server };
}

type OpFrame = { id: number; op: Record<string, unknown> };
const opFrames = (h: AppHarness): OpFrame[] =>
  h.server.clientFrames().filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f);

const T0 = new Date(2026, 8, 14, 8, 0).getTime(); // 2026-09-14 08:00 LOCAL
const MIN = 60_000;

/** 本地时区的 M月D日 HH:mm 参照（模型输出的格式契约）。 */
const fmtRef = (ts: number): string => {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const sched = (over: Partial<ScheduleListRow> & { id: string }): ScheduleListRow => ({
  kind: "task",
  prompt: "每天 09:00 整理收件箱",
  trigger: "每天 09:00",
  nextRunAt: T0 + 60 * MIN,
  enabled: true,
  paused: false,
  ...over,
});

const srow = (over: Partial<SessionRow> & { id: string }): SessionRow => ({
  mtime: new Date(T0).toISOString(),
  messages: 3,
  firstUser: "第一句话",
  model: "deepseek-v4-flash",
  ...over,
});

describe("ω99-317 G — schedulesPanelModel 聚合纯函数", () => {
  const now = (): number => T0;

  it("生效中：徽标/下次（M月D日 HH:mm）/还没跑过；绑定会话名 name→firstUser 阶梯", () => {
    const rows = schedulesPanelModel(
      [sched({ id: "active001", sessionId: "wudao-bound0001" })],
      [srow({ id: "wudao-bound0001", name: "天天跑的会话" })],
      now,
    );
    expect(rows[0]!.state).toBe("active");
    expect(rows[0]!.stateText).toBe("生效中");
    expect(rows[0]!.nextText).toBe(fmtRef(T0 + 60 * MIN));
    expect(rows[0]!.lastText).toBe("还没跑过");
    expect(rows[0]!.sessionName).toBe("天天跑的会话");
    // name 空串 → firstUser 阶梯；sessions null → 不 join（null）。
    const anon = schedulesPanelModel([sched({ id: "active001", sessionId: "wudao-x2" })], [srow({ id: "wudao-x2", name: "" })], now);
    expect(anon[0]!.sessionName).toBe("第一句话");
    const noJoin = schedulesPanelModel([sched({ id: "active001", sessionId: "wudao-x3" })], null, now);
    expect(noJoin[0]!.sessionName).toBeNull();
  });

  it("到点了：下次 = 马上（<=now）；nextRunAt null = 无待跑", () => {
    const rows = schedulesPanelModel([sched({ id: "due00001", nextRunAt: T0 }), sched({ id: "none0001", nextRunAt: null })], null, now);
    expect(rows[0]!.nextText).toBe("马上");
    expect(rows[1]!.nextText).toBe("无待跑");
  });

  it("已暂停：徽标 + 收益语（恢复后按计划继续）", () => {
    const rows = schedulesPanelModel([sched({ id: "paused001", paused: true, nextRunAt: null })], null, now);
    expect(rows[0]!.state).toBe("paused");
    expect(rows[0]!.stateText).toBe("已暂停");
    expect(rows[0]!.nextText).toBe("已暂停——恢复后按计划继续");
  });

  it("熔断：徽标已停用 + 连败 N 次明示 + 重开口指引；lastRun 失败在healthy 行如实带连败", () => {
    const rows = schedulesPanelModel(
      [
        sched({ id: "brkr0001", enabled: false, consecutiveFailures: 3, lastRun: { ok: false, at: T0 - 30 * MIN } }),
        sched({ id: "flaky0001", consecutiveFailures: 2, lastRun: { ok: false, at: T0 - 15 * MIN } }),
      ],
      null,
      now,
    );
    expect(rows[0]!.state).toBe("breaker");
    expect(rows[0]!.stateText).toBe("已停用");
    expect(rows[0]!.lastText).toContain("连败 3 次没跑成");
    expect(rows[0]!.lastText).toContain("已自动停用");
    expect(rows[0]!.nextText).toBe("已停用——恢复或试跑可重开");
    expect(rows[0]!.breaker).toBe(true);
    // 未熔断但连败计数在场：上次结果行如实带（health 可见，不到熔断线）。
    expect(rows[1]!.state).toBe("active");
    expect(rows[1]!.lastText).toContain("没跑成");
    expect(rows[1]!.lastText).toContain("已连败 2 次");
  });

  it("上次成功：跑成了 + 时间；提醒的零运行 = 还没响过；只有 lastFiredAt = 上次触发", () => {
    const rows = schedulesPanelModel(
      [
        sched({ id: "okrun0001", lastRun: { ok: true, at: T0 - 5 * MIN } }),
        sched({ id: "remind001", kind: "reminder", prompt: "抬头休息", trigger: "每天 10:00" }),
        sched({ id: "fired0001", lastFiredAt: T0 - 2 * MIN }),
      ],
      null,
      now,
    );
    expect(rows[0]!.lastText).toContain("跑成了");
    expect(rows[0]!.lastText).toContain(fmtRef(T0 - 5 * MIN));
    expect(rows[1]!.lastText).toBe("还没响过");
    expect(rows[2]!.lastText).toContain("上次触发");
    expect(rows[2]!.lastText).toContain(fmtRef(T0 - 2 * MIN));
  });

  it("老 server 行（无新字段）零崩：缺省即 null/0，prompt 超长摘到 80 字", () => {
    const legacy = sched({ id: "legacy001", prompt: "长".repeat(120) }) as ScheduleListRow;
    const rows = schedulesPanelModel([legacy], null, now);
    expect(rows[0]!.state).toBe("active");
    expect(rows[0]!.lastText).toBe("还没跑过");
    expect(rows[0]!.promptText.length).toBe(80);
  });
});

describe("借鉴弧 ε — 事件触发行（盯信号，不看钟）", () => {
  const now = (): number => T0;

  it("模型：event 行下次=等信号到达（nextRunAt 有值也不看）；triggerKind 透传；日历行缺省 calendar", () => {
    const rows = schedulesPanelModel(
      [
        sched({ id: "fileev01", triggerKind: "event", eventSource: "file", trigger: "当「docs/x.md」变化时", nextRunAt: null }),
        // nextRunAt 有值的 event 行（防御形：数据面不该产出，但面板不看钟是硬律）
        sched({ id: "hookev01", triggerKind: "event", eventSource: "webhook", trigger: "当收到 webhook 信号时", nextRunAt: T0 + 60 * MIN }),
        sched({ id: "pausedv1", triggerKind: "event", paused: true, nextRunAt: null }),
        sched({ id: "cal00001", nextRunAt: T0 + 60 * MIN }),
      ],
      null,
      now,
    );
    expect(rows[0]!.triggerKind).toBe("event");
    expect(rows[0]!.nextText).toBe("等信号到达");
    expect(rows[1]!.nextText).toBe("等信号到达");
    expect(rows[2]!.nextText).toBe("已暂停——恢复后按计划继续");
    expect(rows[3]!.triggerKind).toBe("calendar");
    expect(rows[3]!.nextText).toBe(fmtRef(T0 + 60 * MIN));
  });

  it("面板 DOM：event 行的待命格不带「下次」前缀；触发类型人话直渲染", async () => {
    const h = await openPanel([sched({ id: "fileev01", triggerKind: "event", eventSource: "file", trigger: "当「docs/x.md」变化时", nextRunAt: null })]);
    const row = h.container.querySelector(".sch-row")!;
    expect(row.querySelector(".sch-trig")!.textContent).toBe("当「docs/x.md」变化时");
    expect(row.querySelector(".sch-next")!.textContent).toBe("等信号到达");
    // 日历行保留「下次」前缀（同一面板两种触发大类的词汇分野）。T0 在真实
    // 时钟的过去 → 待命词是「马上」（面板 DOM 走 Date.now，不接测试时钟）。
    const h2 = await openPanel([sched({ id: "cal00001", nextRunAt: T0 + 60 * MIN })]);
    expect(h2.container.querySelector(".sch-next")!.textContent).toBe("下次 马上");
  });
});

/** The lane to an OPEN schedules panel over answered rows. */
async function openPanel(rows: readonly ScheduleListRow[], sessions: readonly SessionRow[] | null = null): Promise<AppHarness> {
  const h = mountedApp();
  await act(async () => {
    const op = opFrames(h).find((o) => o.op.op === "schedulesList");
    h.server.socket.serverSend({ t: "result", id: op?.id, ok: rows });
  });
  await until(() => h.container.querySelector(".topbar .tb-sched") !== null, "sched chip");
  await act(async () => {
    (h.container.querySelector<HTMLButtonElement>(".topbar .tb-sched"))!.click();
  });
  if (sessions !== null) {
    await act(async () => {
      const op = opFrames(h).find((o) => o.op.op === "sessions");
      h.server.socket.serverSend({ t: "result", id: op?.id, ok: sessions });
    });
  }
  await until(() => h.container.querySelector(".schedules-panel") !== null, "schedules panel");
  return h;
}

describe("ω99-317 H — chip 门 + 面板 DOM + 三动作 + 双确认", () => {
  it("「定时 N」chip：N>0 才显示（216 改动 chip 同族）；零行/读败 → 零 chip", async () => {
    const h = await openPanel([
      sched({ id: "active001" }),
      sched({ id: "paused001", paused: true, nextRunAt: null }),
    ]);
    const chip = h.container.querySelector<HTMLButtonElement>(".topbar .tb-sched");
    expect(chip?.textContent).toBe("定时 2");
    expect(chip?.getAttribute("aria-label")).toBe("查看定时任务");
    // 面板：行数 + 人话触发器直渲染（cron 零解码成本）+ 状态徽标。
    const panel = h.container.querySelector(".schedules-panel");
    expect(panel?.getAttribute("role")).toBe("dialog");
    expect(panel?.getAttribute("aria-label")).toBe("定时任务");
    expect(panel?.querySelector(".sch-head")?.textContent).toBe("共 2 条");
    const rowsEl = [...(panel?.querySelectorAll(".sch-row") ?? [])] as HTMLElement[];
    expect(rowsEl).toHaveLength(2);
    expect(rowsEl[0]?.querySelector(".sch-trig")?.textContent).toBe("每天 09:00");
    expect(rowsEl[0]?.querySelector(".sch-state")?.textContent).toBe("生效中");
    expect(rowsEl[1]?.getAttribute("data-state")).toBe("paused");
    expect(rowsEl[1]?.querySelector(".sch-state")?.textContent).toBe("已暂停");
    // 绑定会话名 join（name 阶梯）。
    const named = await openPanel([sched({ id: "active001", sessionId: "wudao-bound0001" })], [srow({ id: "wudao-bound0001", name: "天天跑的会话" })]);
    expect(named.container.querySelector(".sch-session")?.textContent).toContain("天天跑的会话");
  });

  it("零行 / 读败 → 零 chip（面隐藏不是空壳）", async () => {
    const empty = mountedApp();
    await act(async () => {
      const op = opFrames(empty).find((o) => o.op.op === "schedulesList");
      empty.server.socket.serverSend({ t: "result", id: op?.id, ok: [] });
    });
    await until(() => empty.container.querySelector(".topbar") !== null, "topbar");
    expect(empty.container.querySelector(".topbar .tb-sched")).toBeNull();
    const failed = mountedApp();
    await act(async () => {
      const op = opFrames(failed).find((o) => o.op.op === "schedulesList");
      failed.server.socket.serverSend({ t: "result", id: op?.id, ok: undefined, err: "schedulesList not supported by this driver" });
    });
    await until(() => failed.container.querySelector(".topbar") !== null, "topbar");
    expect(failed.container.querySelector(".topbar .tb-sched")).toBeNull();
  });

  it("暂停/恢复：click → schedulesSetEnabled op 帧 verbatim；回执 notify + 纪元 refetch", async () => {
    const h = await openPanel([sched({ id: "active001", paused: false }), sched({ id: "paused001", paused: true, nextRunAt: null })]);
    const listsBefore = opFrames(h).filter((o) => o.op.op === "schedulesList").length;
    const toggleBtns = [...h.container.querySelectorAll<HTMLButtonElement>(".sch-row .sch-act[data-act=\"toggle\"]")];
    expect(toggleBtns.map((b) => b.textContent)).toEqual(["暂停", "恢复"]);
    await act(async () => {
      toggleBtns[0]!.click();
    });
    const op1 = opFrames(h).find((o) => o.op.op === "schedulesSetEnabled");
    expect(op1?.op).toEqual({ op: "schedulesSetEnabled", id: "active001", enabled: false });
    await act(async () => {
      h.server.socket.serverSend({ t: "result", id: op1?.id, ok: { ok: true, message: "⏸ active001 已暂停（错过的触发不补跑）" } });
    });
    // 回执走 notify（notice-bub），动作后 refetch（schedulesList 再发一发）。
    expect(h.container.textContent).toContain("⏸ active001 已暂停");
    await until(() => opFrames(h).filter((o) => o.op.op === "schedulesList").length === listsBefore + 1, "refetch");
    await act(async () => {
      toggleBtns[1]!.click();
    });
    const op2 = opFrames(h).filter((o) => o.op.op === "schedulesSetEnabled").at(-1);
    expect(op2?.op).toEqual({ op: "schedulesSetEnabled", id: "paused001", enabled: true });
  });

  it("删除：家族确认弹框（Esc 取消零 op；确认 → schedulesRemove op + refetch）", async () => {
    const h = await openPanel([sched({ id: "active001" })]);
    await act(async () => {
      (h.container.querySelector<HTMLButtonElement>(".sch-act[data-act=\"remove\"]"))!.click();
    });
    const confirm = h.container.querySelector(".remove-confirm");
    expect(confirm?.getAttribute("role")).toBe("dialog");
    expect(confirm?.textContent).toContain("删除这条定时任务");
    // Esc 取消：零 op。
    await act(async () => {
      confirm?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(h.container.querySelector(".remove-confirm")).toBeNull();
    expect(opFrames(h).some((o) => o.op.op === "schedulesRemove")).toBe(false);
    // 再开 → 确认 → op 发出。
    await act(async () => {
      (h.container.querySelector<HTMLButtonElement>(".sch-act[data-act=\"remove\"]"))!.click();
    });
    await act(async () => {
      (h.container.querySelectorAll<HTMLButtonElement>(".remove-confirm .wudao")[0])!.click();
    });
    const op = opFrames(h).find((o) => o.op.op === "schedulesRemove");
    expect(op?.op).toEqual({ op: "schedulesRemove", id: "active001" });
    await act(async () => {
      h.server.socket.serverSend({ t: "result", id: op?.id, ok: { ok: true, message: "已移除持久任务 active001" } });
    });
    expect(h.container.textContent).toContain("已移除持久任务");
  });

  it("试跑（健康行）：直接发 schedulesRunNow（无 resetBreaker）；busy 拒答如实回执", async () => {
    const h = await openPanel([sched({ id: "active001", sessionId: "wudao-bound0001" })]);
    await act(async () => {
      (h.container.querySelector<HTMLButtonElement>(".sch-act[data-act=\"run\"]"))!.click();
    });
    const op = opFrames(h).find((o) => o.op.op === "schedulesRunNow");
    expect(op?.op).toEqual({ op: "schedulesRunNow", id: "active001" });
    await act(async () => {
      h.server.socket.serverSend({
        t: "result",
        id: op?.id,
        ok: { ok: false, message: "⚠️ active001 绑定的会话正在跑——等当前对话结束再试" },
      });
    });
    expect(h.container.textContent).toContain("会话正在跑");
  });

  it("试跑（熔断行）：显式问「连败 N 次已熔断，仍要试跑」——确认才发 resetBreaker:true", async () => {
    const h = await openPanel([
      sched({ id: "brkr0001", enabled: false, consecutiveFailures: 3, lastRun: { ok: false, at: T0 - MIN } }),
    ]);
    await act(async () => {
      (h.container.querySelector<HTMLButtonElement>(".sch-act[data-act=\"run\"]"))!.click();
    });
    const confirm = h.container.querySelector(".run-confirm");
    expect(confirm?.getAttribute("role")).toBe("dialog");
    expect(confirm?.textContent).toContain("连败 3 次");
    expect(confirm?.textContent).toContain("仍要试跑");
    expect(opFrames(h).some((o) => o.op.op === "schedulesRunNow")).toBe(false); // 先问后发
    // 取消 → 零 op。
    await act(async () => {
      (h.container.querySelectorAll<HTMLButtonElement>(".run-confirm .wudao")[1])!.click();
    });
    expect(h.container.querySelector(".run-confirm")).toBeNull();
    expect(opFrames(h).some((o) => o.op.op === "schedulesRunNow")).toBe(false);
    // 再试 → 确认 → resetBreaker 旗随行。
    await act(async () => {
      (h.container.querySelector<HTMLButtonElement>(".sch-act[data-act=\"run\"]"))!.click();
    });
    await act(async () => {
      (h.container.querySelectorAll<HTMLButtonElement>(".run-confirm .wudao")[0])!.click();
    });
    const op = opFrames(h).find((o) => o.op.op === "schedulesRunNow");
    expect(op?.op).toEqual({ op: "schedulesRunNow", id: "brkr0001", resetBreaker: true });
    await act(async () => {
      h.server.socket.serverSend({
        t: "result",
        id: op?.id,
        ok: { ok: true, message: "▶ brkr0001 已重新打开并立即试跑（连败计数清零——计划不变）" },
      });
    });
    expect(h.container.textContent).toContain("已重新打开");
  });

  it("Esc 与关闭钮都收起面板", async () => {
    const h = await openPanel([sched({ id: "active001" })]);
    const panel = h.container.querySelector<HTMLDivElement>(".schedules-panel");
    await act(async () => {
      panel?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(h.container.querySelector(".schedules-panel")).toBeNull();
    await act(async () => {
      (h.container.querySelector<HTMLButtonElement>(".topbar .tb-sched"))!.click();
    });
    await act(async () => {
      (h.container.querySelector<HTMLButtonElement>(".schedules-panel .btnrow .wudao"))!.click();
    });
    expect(h.container.querySelector(".schedules-panel")).toBeNull();
  });
});

describe("ω99-317 I — CSS 钉（chip 身份类 + 面板行族 + 通道令牌律）", () => {
  const css = readStyles();

  it(".tb-sched 身份类在场（.tb-changes 视觉家族，.tb-computer 先例）", () => {
    expect(css).toContain(".tb-sched");
  });

  it(".schedules-panel 进 modal-card 尺寸组；.sch-* 行族与熔断徽标在场", () => {
    expect(css).toContain(".modal-card.schedules-panel");
    expect(css).toContain(".sch-row");
    expect(css).toContain(".sch-badge");
    expect(css).toContain('[data-state="breaker"]');
  });

  it("新样式零 color-mix（0.3.88 通道令牌律——WKWebView 兼容红线）", () => {
    const from = css.indexOf(".tb-sched");
    expect(from).toBeGreaterThan(-1);
    const to = css.indexOf("/* ω99-317 sched panel end */");
    expect(to).toBeGreaterThan(from);
    expect(css.slice(from, to)).not.toContain("color-mix");
  });
});
