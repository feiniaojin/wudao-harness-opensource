// 多 driver 并发弧 B —— server 车道表 + 帧 sid 路由 + 协议演进（B3）。先红后绿：
// ① 车道表 CRUD：mountLane（开）/closeLane（关）幂等与换血、保留字 fail-closed、
// 开/关在 wire 上可观察（state 帧 lanes 字段增减）；② 帧 sid 路由：副车道历史帧
// （追加形与 reset 形）带 sid、主车道帧永不带（字节钉）、auth 后副车道 reset 重放；
// ③ op sid 寻址：七个交互写 op 路由到对应车道、主 driver 零调用（车道隔离）、
// 未知/坏形状 sid 干净拒、vault digest 覆盖 sid（同 cid+id 打不同车道 = conflict）、
// recovery 失效缝只在主车道触发；④ 缺省零变化：无 laneDrivers 时 state 帧无
// lanes 字段、主车道帧无 sid（整套既有 server 测试原样通过 = 第二重证明）。
// ⑤ sessions 行 lane 标记泛化：副车道行带 lane:"<sid>"（pet 先例推广）。
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import {
  createUiServer,
  type LaneDriverPort,
  type UiDriverPort,
  type UiRecoveryPort,
  type UiServer,
} from "../src/index.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const servers: UiServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

/** 主车道 mock：记录全部 mutator 调用（零调用断言=车道隔离钉），史可发射。 */
interface MainMock extends UiDriverPort {
  readonly calls: string[];
  emitHistory(entries: unknown[], reset?: boolean): void;
}

function mainMock(): MainMock {
  const calls: string[] = [];
  const historyCbs = new Set<(entries: readonly unknown[], reset: boolean) => void>();
  return {
    calls,
    subscribe: () => () => {},
    getStatus: () => ({ live: { reasoning: "", answer: "", busyTools: [] }, busy: false, mode: "workspace", laneMark: "main" }),
    getHistory: () => [],
    onHistory: (cb) => (historyCbs.add(cb), () => historyCbs.delete(cb)),
    onLoopEvent: () => () => {},
    submit: (text: string) => (calls.push(`submit:${text}`), "started"),
    interrupt: () => void calls.push("interrupt"),
    setMode: (mode: string) => void calls.push(`setMode:${mode}`),
    answerPermission: (allow: boolean, _r?: string, scope?: "session" | "always") =>
      (calls.push(`answerPermission:${String(allow)}:${String(scope)}`), true),
    recallSteer: (index: number) => (calls.push(`recallSteer:${index}`), true),
    answerAskUser: (answer?: string) => (calls.push(`answerAskUser:${answer ?? ""}`), true),
    detachToolCall: (callId?: string) => (calls.push(`detachToolCall:${callId ?? ""}`), { kind: "ok" }),
    listSlashCommands: () => [],
    sessions: async () => [
      { id: "wudao-main-1", messages: 2, firstUser: "主窗问题", model: "m" },
      { id: "sid-a1", messages: 7, firstUser: "副车道问题", model: "m" },
      { id: "pet", messages: 5, firstUser: "精灵第一问", model: "m" },
    ],
    resume: async () => ({ ok: true }),
    rewind: async () => "rewound",
    emitHistory: (entries, reset = false) => {
      for (const cb of [...historyCbs]) cb(entries, reset);
    },
  };
}

/** 副车道 mock：LaneDriverPort 全量面 + 订阅计数（幂等钉）+ 状态/史可发射。 */
interface LaneMock extends LaneDriverPort {
  readonly calls: string[];
  subCount(): number;
  emitStatus(busy: boolean): void;
  emitHistory(entries: unknown[], reset?: boolean): void;
}

function laneMock(sid: string): LaneMock {
  const calls: string[] = [];
  const statusCbs = new Set<() => void>();
  const historyCbs = new Set<(entries: readonly unknown[], reset: boolean) => void>();
  const history: unknown[] = [];
  let subs = 0;
  let busy = false;
  return {
    calls,
    subscribe: (cb) => {
      subs += 1;
      statusCbs.add(cb);
      return () => statusCbs.delete(cb);
    },
    getStatus: () => ({ busy, mode: "workspace", sessionId: sid, laneMark: sid }),
    getHistory: () => [...history],
    onHistory: (cb) => (historyCbs.add(cb), () => historyCbs.delete(cb)),
    submit: (text: string) => (calls.push(`submit:${text}`), "started"),
    interrupt: () => void calls.push("interrupt"),
    setMode: (mode: string) => void calls.push(`setMode:${mode}`),
    answerPermission: (allow: boolean, _r?: string, scope?: "session" | "always") =>
      (calls.push(`answerPermission:${String(allow)}:${String(scope)}`), true),
    recallSteer: (index: number) => (calls.push(`recallSteer:${index}`), true),
    answerAskUser: (answer?: string) => (calls.push(`answerAskUser:${answer ?? ""}`), true),
    detachToolCall: (callId?: string) => (calls.push(`detachToolCall:${callId ?? ""}`), { kind: "ok" }),
    subCount: () => subs,
    emitStatus: (b: boolean) => {
      busy = b;
      for (const cb of [...statusCbs]) cb();
    },
    emitHistory: (entries, reset = false) => {
      if (reset) history.length = 0;
      history.push(...entries);
      for (const cb of [...historyCbs]) cb(entries, reset);
    },
  };
}

/** recovery 计数 mock：noteUserInput 的车道门测试面。 */
function recoveryMock(): UiRecoveryPort & { count: () => number } {
  let n = 0;
  return { count: () => n, noteUserInput: () => void (n += 1), status: () => [], stop: async () => {} };
}

interface Frame {
  t: string;
  state?: { laneMark?: string };
  lanes?: Record<string, { laneMark?: string; busy?: boolean }>;
  entries?: unknown[];
  reset?: boolean;
  sid?: string;
  id?: unknown;
  ok?: unknown;
  err?: string;
}

function connect(server: UiServer): { ws: WebSocket; frames: Frame[]; open: Promise<void> } {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
  const frames: Frame[] = [];
  const open = new Promise<void>((resolve) => ws.once("open", resolve));
  ws.on("message", (data) => frames.push(JSON.parse(String(data)) as Frame));
  return { ws, frames, open };
}

async function boot(o: {
  laneDrivers?: ReadonlyMap<string, LaneDriverPort>;
  recovery?: UiRecoveryPort;
} = {}): Promise<{ server: UiServer; c: ReturnType<typeof connect>; main: MainMock }> {
  const main = mainMock();
  const server = await createUiServer({
    driver: main,
    ...(o.recovery !== undefined ? { recovery: o.recovery } : {}),
    ...(o.laneDrivers !== undefined ? { laneDrivers: o.laneDrivers } : {}),
  });
  servers.push(server);
  const c = connect(server);
  await c.open;
  c.ws.send(JSON.stringify({ t: "auth", token: server.token }));
  await until(() => c.frames.some((f) => f.t === "history"), "initial replay");
  return { server, c, main };
}

function op(ws: WebSocket, id: number, o: Record<string, unknown>, cid?: string): void {
  ws.send(JSON.stringify({ t: "op", id, ...(cid !== undefined ? { cid } : {}), op: o }));
}

const result = (frames: Frame[], id: unknown): Frame | undefined =>
  frames.find((f) => f.t === "result" && f.id === id);

describe("多 driver 弧 B：车道表 CRUD（开/关/幂等）", () => {
  it("(a) 运行时 mountLane（开）：lanes 字段出现且状态新鲜；车道 emit 推全量帧", async () => {
    const { server, c } = await boot();
    expect("lanes" in (c.frames.find((f) => f.t === "state") ?? {})).toBe(false); // 挂载前缺席
    const lane = laneMock("sid-a1");
    server.mountLane("sid-a1", lane);
    await until(() => c.frames.some((f) => f.t === "state" && f.lanes !== undefined), "lanes field appears");
    expect(c.frames.find((f) => f.t === "state" && f.lanes !== undefined)?.lanes).toEqual({
      "sid-a1": { busy: false, mode: "workspace", sessionId: "sid-a1", laneMark: "sid-a1" },
    });
    // 车道自己的变化 → 一帧全量（主态同帧在场，ω99-235 双读纪律的 N 车道推广）
    lane.emitStatus(true);
    await until(() => {
      const st = [...c.frames].reverse().find((f) => f.t === "state");
      return st?.lanes?.["sid-a1"]?.busy === true;
    }, "lane emit pushes fresh lanes");
    const st = [...c.frames].reverse().find((f) => f.t === "state");
    expect(st?.state?.laneMark).toBe("main");
    c.ws.close();
  });

  it("(b) 幂等：同 sid 同 driver 重复挂载 = 无操作（订阅不翻倍）", async () => {
    const { server, c } = await boot();
    const lane = laneMock("sid-a1");
    server.mountLane("sid-a1", lane);
    await until(() => c.frames.some((f) => f.t === "state" && f.lanes !== undefined), "first mount");
    const framesBefore = c.frames.length;
    server.mountLane("sid-a1", lane); // 幂等重挂
    await wait(50);
    expect(c.frames.length).toBe(framesBefore); // 零新帧（无操作）
    expect(lane.subCount()).toBe(1); // 订阅恰一次
    expect(Object.keys(c.frames.find((f) => f.t === "state" && f.lanes !== undefined)?.lanes ?? {})).toEqual(["sid-a1"]);
    c.ws.close();
  });

  it("(c) 换血：同 sid 换 driver = 原子替换（旧订阅退净，旧 emit 不再推帧）", async () => {
    const { server, c } = await boot();
    const oldLane = laneMock("sid-a1");
    server.mountLane("sid-a1", oldLane);
    await until(() => c.frames.some((f) => f.t === "state" && f.lanes !== undefined), "first mount");
    const newLane = laneMock("sid-a1");
    server.mountLane("sid-a1", newLane); // 换血
    await until(() => c.frames.filter((f) => f.t === "state" && f.lanes !== undefined).length >= 2, "replace push");
    oldLane.emitStatus(true); // 旧车道的 emit……
    await wait(50);
    const states = c.frames.filter((f) => f.t === "state");
    expect(states.at(-1)?.lanes?.["sid-a1"]?.busy).not.toBe(true); // ……不再推帧（退订干净）
    newLane.emitStatus(true); // 新车道的 emit 照常
    await until(() => c.frames.some((f) => f.t === "state" && f.lanes?.["sid-a1"]?.busy === true), "new lane emit pushes");
    expect(oldLane.subCount()).toBe(1); // 旧 mock 的订阅计数不动（只被退订）
    c.ws.close();
  });

  it("(d) closeLane（关）：true→false 幂等；lanes 字段消失；退订后史 emit 静默", async () => {
    const { server, c } = await boot();
    const lane = laneMock("sid-a1");
    server.mountLane("sid-a1", lane);
    await until(() => c.frames.some((f) => f.t === "state" && f.lanes !== undefined), "mount");
    expect(server.closeLane("sid-a1")).toBe(true); // 关
    await until(() => {
      const st = [...c.frames].reverse().find((f) => f.t === "state");
      return st !== undefined && !("lanes" in st);
    }, "lanes field disappears");
    expect(server.closeLane("sid-a1")).toBe(false); // 幂等：重复关 = 目标态
    expect(server.closeLane("main")).toBe(false); // 主车道常驻，不可关
    const framesBefore = c.frames.length;
    lane.emitStatus(true); // 退订后……
    lane.emitHistory([{ kind: "notice", text: "孤儿帧" }]); // ……两种 emit 都静默
    await wait(50);
    expect(c.frames.length).toBe(framesBefore);
    c.ws.close();
  });

  it("(e) 保留字/坏形状 fail-closed：mountLane 与构造期 laneDrivers 双拒", async () => {
    const { server } = await boot();
    expect(() => server.mountLane("main", laneMock("x"))).toThrow(/reserved/);
    expect(() => server.mountLane("pet", laneMock("x"))).toThrow(/reserved/);
    expect(() => server.mountLane("", laneMock("x"))).toThrow(/1–128/);
    await expect(createUiServer({
      driver: mainMock(),
      laneDrivers: new Map([["main", laneMock("x")]]),
    })).rejects.toThrow(/reserved/);
    await expect(createUiServer({
      driver: mainMock(),
      laneDrivers: new Map([["pet", laneMock("x")]]),
    })).rejects.toThrow(/reserved/);
  });
});

describe("多 driver 弧 B：帧 sid 路由", () => {
  it("(a) 副车道史帧带 sid：追加形与 reset 形同规则", async () => {
    const { server, c } = await boot();
    const lane = laneMock("sid-a1");
    server.mountLane("sid-a1", lane);
    await until(() => c.frames.some((f) => f.t === "state" && f.lanes !== undefined), "mount");
    lane.emitHistory([{ kind: "user", text: "副车道第一问" }]);
    await until(() => c.frames.some((f) => f.t === "history" && f.sid === "sid-a1"), "append frame with sid");
    const append = c.frames.find((f) => f.t === "history" && f.sid === "sid-a1");
    expect(append?.entries).toEqual([{ kind: "user", text: "副车道第一问" }]);
    expect("reset" in (append ?? {})).toBe(false); // 追加形无 reset 键（字节钉）
    lane.emitHistory([{ kind: "assistant", text: "换代" }], true);
    await until(() => c.frames.some((f) => f.t === "history" && f.sid === "sid-a1" && f.reset === true), "reset frame with sid");
    expect(c.frames.find((f) => f.t === "history" && f.sid === "sid-a1" && f.reset === true)?.entries)
      .toEqual([{ kind: "assistant", text: "换代" }]);
    c.ws.close();
  });

  it("(b) 主车道史帧永不带 sid（字节钉）", async () => {
    const lane = laneMock("sid-a1");
    lane.emitHistory([{ kind: "user", text: "预置" }]); // 预置史给 auth 重放
    const { c, main } = await boot({ laneDrivers: new Map([["sid-a1", lane]]) });
    main.emitHistory([{ kind: "user", text: "主车道" }]);
    await until(() => c.frames.some((f) => f.t === "history" && (f.entries as { text?: string }[])?.[0]?.text === "主车道"), "main frame");
    for (const f of c.frames.filter((f) => f.t === "history" && f.sid === undefined)) {
      expect("sid" in f).toBe(false); // 主车道帧（含 auth 重放）零 sid 键
    }
    c.ws.close();
  });

  it("(c) auth 重放：构造期挂载的副车道带 sid+reset 重放，紧跟主车道重放之后", async () => {
    const laneA = laneMock("sid-a1");
    laneA.emitHistory([{ kind: "user", text: "A1 的史" }]);
    const laneB = laneMock("sid-b2");
    laneB.emitHistory([{ kind: "user", text: "B2 的史" }]);
    const { c } = await boot({ laneDrivers: new Map([["sid-a1", laneA], ["sid-b2", laneB]]) });
    await until(() => c.frames.filter((f) => f.t === "history" && f.sid !== undefined).length >= 2, "both side replays");
    const replays = c.frames.filter((f) => f.t === "history" && f.reset === true && f.sid !== undefined);
    expect(replays.map((f) => f.sid)).toEqual(["sid-a1", "sid-b2"]); // 挂载序
    expect(replays[0]?.entries).toEqual([{ kind: "user", text: "A1 的史" }]);
    // 主车道 reset 重放仍是无 sid 的第一帧
    const mainReplay = c.frames.find((f) => f.t === "history" && f.reset === true && f.sid === undefined);
    expect(mainReplay).toBeDefined();
    expect(c.frames.indexOf(mainReplay!)).toBeLessThan(c.frames.indexOf(replays[0]));
    c.ws.close();
  });

  it("(d) 断线重连后的重放同样带 sid+reset", async () => {
    const lane = laneMock("sid-a1");
    const { server, c } = await boot({ laneDrivers: new Map([["sid-a1", lane]]) });
    lane.emitHistory([{ kind: "user", text: "重连前的新史" }]);
    c.ws.close(); // 释放单客户端槽（v1-A：一连接一客户端）
    await wait(100);
    const c2 = connect(server);
    await c2.open;
    c2.ws.send(JSON.stringify({ t: "auth", token: server.token }));
    await until(() => c2.frames.some((f) => f.t === "history" && f.sid === "sid-a1" && f.reset === true), "reconnect replay");
    expect(c2.frames.find((f) => f.t === "history" && f.sid === "sid-a1")?.entries)
      .toEqual([{ kind: "user", text: "重连前的新史" }]);
    c2.ws.close();
  });
});

describe("多 driver 弧 B：op sid 寻址", () => {
  it("(a) submit/interrupt/setMode/answerPermission 带 sid → 路由到副车道，主 driver 零调用", async () => {
    const lane = laneMock("sid-a1");
    const { c } = await boot({ laneDrivers: new Map([["sid-a1", lane]]) });
    op(c.ws, 1, { op: "submit", text: "副车道的问题", sid: "sid-a1" });
    await until(() => result(c.frames, 1) !== undefined, "submit result");
    expect(result(c.frames, 1)?.ok).toBe("started");
    op(c.ws, 2, { op: "interrupt", sid: "sid-a1" });
    op(c.ws, 3, { op: "setMode", mode: "auto", sid: "sid-a1" });
    op(c.ws, 4, { op: "answerPermission", allow: true, scope: "always", sid: "sid-a1" });
    await until(() => [2, 3, 4].every((id) => result(c.frames, id) !== undefined), "three results");
    expect(lane.calls).toEqual([
      "submit:副车道的问题",
      "interrupt",
      "setMode:auto",
      "answerPermission:true:always",
    ]);
    // 车道隔离钉：四个 op 全程没碰主 driver 的任何 mutator
    c.ws.close();
  });

  it("(b) 可选写面 recallSteer/answerAskUser/detachToolCall 同样 sid 寻址", async () => {
    const lane = laneMock("sid-a1");
    const { c } = await boot({ laneDrivers: new Map([["sid-a1", lane]]) });
    op(c.ws, 1, { op: "recallSteer", index: 0, text: "撤回", sid: "sid-a1" });
    op(c.ws, 2, { op: "answerAskUser", answer: "方案 B", sid: "sid-a1" });
    op(c.ws, 3, { op: "detachToolCall", callId: "c1", sid: "sid-a1" });
    await until(() => [1, 2, 3].every((id) => result(c.frames, id) !== undefined), "three results");
    expect(lane.calls).toEqual(["recallSteer:0", "answerAskUser:方案 B", "detachToolCall:c1"]);
    c.ws.close();
  });

  it("(c) 缺省（无 sid）与 sid:'main' 都落主车道——多车道服务器上缺省行为不变", async () => {
    const lane = laneMock("sid-a1");
    const { c, main } = await boot({ laneDrivers: new Map([["sid-a1", lane]]) });
    op(c.ws, 1, { op: "submit", text: "默认主车道" });
    op(c.ws, 2, { op: "submit", text: "显式主车道", sid: "main" });
    await until(() => [1, 2].every((id) => result(c.frames, id) !== undefined), "two results");
    expect(main.calls).toEqual(["submit:默认主车道", "submit:显式主车道"]);
    expect(lane.calls).toEqual([]);
    c.ws.close();
  });

  it("(d) 未知 sid / 非字符串 sid / 坏 mode 镜像主车道文案", async () => {
    const { c, main } = await boot({ laneDrivers: new Map([["sid-a1", laneMock("sid-a1")]]) });
    op(c.ws, 1, { op: "submit", text: "x", sid: "nosuch" });
    op(c.ws, 2, { op: "submit", text: "x", sid: 42 });
    op(c.ws, 3, { op: "setMode", mode: " NoSuchMode ", sid: "sid-a1" });
    op(c.ws, 4, { op: "submit", text: "x", sid: "pet" }); // pet 走 petXxx op 面，不 sid 寻址
    await until(() => [1, 2, 3, 4].every((id) => result(c.frames, id) !== undefined), "four results");
    expect(result(c.frames, 1)?.err).toBe("unknown lane sid: nosuch");
    expect(result(c.frames, 2)?.err).toBe("sid must be a string when present");
    expect(result(c.frames, 3)?.err).toContain("setMode: mode must be one of");
    expect(result(c.frames, 4)?.err).toBe("unknown lane sid: pet");
    expect(main.calls).toEqual([]); // 四个全没到 driver
    c.ws.close();
  });

  it("(e) vault digest 覆盖 sid：同 cid+id 打不同车道 = conflict；同重试 join/重放", async () => {
    const { c } = await boot({ laneDrivers: new Map([["sid-a1", laneMock("sid-a1")], ["sid-b2", laneMock("sid-b2")]]) });
    op(c.ws, 1, { op: "submit", text: "同文", sid: "sid-a1" }, "client-1");
    await until(() => result(c.frames, 1) !== undefined, "first submit");
    op(c.ws, 1, { op: "submit", text: "同文", sid: "sid-b2" }, "client-1"); // 同 id 不同 sid
    await until(() => c.frames.filter((f) => f.t === "result" && f.id === 1).length >= 2, "conflict");
    expect(c.frames.filter((f) => f.t === "result" && f.id === 1)[1]?.err)
      .toBe("conflict: op id 1 was already used for a different mutation");
    c.ws.close();
  });

  it("(f) recovery 失效缝只在主车道触发：副车道 submit 不碰主会话的恢复意图", async () => {
    const rec = recoveryMock();
    const lane = laneMock("sid-a1");
    const { c } = await boot({ laneDrivers: new Map([["sid-a1", lane]]), recovery: rec });
    op(c.ws, 1, { op: "submit", text: "副车道", sid: "sid-a1" });
    await until(() => result(c.frames, 1) !== undefined, "side submit");
    expect(rec.count()).toBe(0); // 另一个会话的接管，不作废主会话恢复
    op(c.ws, 2, { op: "submit", text: "主车道" });
    await until(() => result(c.frames, 2) !== undefined, "main submit");
    expect(rec.count()).toBe(1);
    c.ws.close();
  });
});

describe("多 driver 弧 B：缺省零变化 + sessions 行 lane 标记", () => {
  it("(a) 无 laneDrivers：state 帧无 lanes 字段、史帧无 sid、submit 无 sid 照旧", async () => {
    const { c, main } = await boot();
    const first = c.frames.find((f) => f.t === "state");
    expect("lanes" in (first ?? {})).toBe(false);
    main.emitHistory([{ kind: "user", text: "x" }]);
    await until(() => c.frames.some((f) => f.t === "history" && (f.entries as { text?: string }[])?.[0]?.text === "x"), "main frame");
    expect("sid" in (c.frames.find((f) => f.t === "history") ?? {})).toBe(false);
    op(c.ws, 1, { op: "submit", text: "照旧" });
    await until(() => result(c.frames, 1) !== undefined, "submit");
    expect(result(c.frames, 1)?.ok).toBe("started");
    expect(main.calls).toEqual(["submit:照旧"]);
    c.ws.close();
  });

  it("(b) sessions 行标记泛化：副车道行 lane:<sid>、pet 行 lane:'pet'、其余无 lane", async () => {
    const { c, server } = await boot({ laneDrivers: new Map([["sid-a1", laneMock("sid-a1")]]) });
    op(c.ws, 1, { op: "sessions" });
    await until(() => result(c.frames, 1) !== undefined, "sessions");
    const rows = result(c.frames, 1)?.ok as { id: string; lane?: string }[];
    expect(rows.find((r) => r.id === "sid-a1")?.lane).toBe("sid-a1");
    expect(rows.find((r) => r.id === "pet")?.lane).toBe("pet");
    expect(rows.find((r) => r.id === "wudao-main-1") && "lane" in (rows.find((r) => r.id === "wudao-main-1") as object)).toBe(false);
    // 关车道后标记随表走（占用解除）
    server.closeLane("sid-a1");
    await wait(30);
    op(c.ws, 2, { op: "sessions" });
    await until(() => result(c.frames, 2) !== undefined, "sessions again");
    const rows2 = result(c.frames, 2)?.ok as { id: string; lane?: string }[];
    expect(rows2.find((r) => r.id === "sid-a1") && "lane" in (rows2.find((r) => r.id === "sid-a1") as object)).toBe(false);
    expect(rows2.find((r) => r.id === "pet")?.lane).toBe("pet"); // pet 标记不受车道表影响
    c.ws.close();
  });
});
