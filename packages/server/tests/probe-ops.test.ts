// PB-2（探针基础设施弧）— server 域的探针遥测面，先红后绿：
// ① WS 帧转发：probeStream 订阅 → bus.emit → {t:"probe",event} 帧到达（含
//    cat 过滤槽与换槽重订阅）；
// ② 读面：probeRecent（环形缓冲 + cat + limit 形状门）、probeStats（统计面
//    原样回）；
// ③ 缺省零变化：未挂 bus → 三 op 干净拒答；挂了 bus 但未订阅 → emit 零 probe
//    帧（订阅门在 relay 内）；
// ④ isVaultedMutation 镜像钉在 vaulted-mirror.test.ts（三 op 入读表，census
//    61→64）。
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { createUiServer, type UiDriverPort, type UiServer, type ProbeEventWire, type UiProbeBusPort } from "../src/index.js";

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

function mainDriver(): UiDriverPort {
  const statusCbs = new Set<() => void>();
  return {
    subscribe: (cb) => (statusCbs.add(cb), () => statusCbs.delete(cb)),
    getStatus: () => ({ live: { reasoning: "", answer: "", busyTools: [] }, busy: false, mode: "workspace" }),
    getHistory: () => [],
    onHistory: () => () => {},
    onLoopEvent: () => () => {},
    submit: () => "started",
    interrupt: () => {},
    setMode: () => {},
    answerPermission: () => false,
    listSlashCommands: () => [],
    sessions: async () => [],
    resume: async () => ({ ok: true }),
    rewind: async () => "rewound",
  };
}

/** 测试用 bus 桩：emit 进环形数组 + 转发订阅者（PB-1 接口的直接实现形）。 */
function busStub(): UiProbeBusPort & { emitted: ProbeEventWire[] } {
  const emitted: ProbeEventWire[] = [];
  const subs: { cat: string; cb: (e: ProbeEventWire) => void }[] = [];
  return {
    emitted,
    emit: (e) => {
      emitted.push(e);
      for (const s of [...subs]) if (s.cat === "*" || s.cat === e.cat) s.cb(e);
    },
    subscribe: (cat, cb) => (subs.push({ cat, cb }), () => {
      const i = subs.findIndex((s) => s.cb === cb);
      if (i >= 0) subs.splice(i, 1);
    }),
    recent: (cat, limit) => {
      const rows = cat !== undefined ? emitted.filter((e) => e.cat === cat) : [...emitted];
      return limit !== undefined ? rows.slice(-limit) : rows;
    },
    stats: () => {
      const out: Record<string, { count: number; lastTs: number }> = {};
      for (const e of emitted) out[e.name] = { count: (out[e.name]?.count ?? 0) + 1, lastTs: e.ts };
      return out;
    },
  };
}

const ev = (cat: ProbeEventWire["cat"], name: string, ts = 1_000, dur?: number): ProbeEventWire =>
  ({ ts, cat, name, data: { k: name }, ...(dur !== undefined ? { dur } : {}) });

interface Frame {
  t: string;
  event?: ProbeEventWire;
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

async function authed(probeBus?: UiProbeBusPort): Promise<{ c: ReturnType<typeof connect>; server: UiServer }> {
  const server = await createUiServer({ driver: mainDriver(), ...(probeBus !== undefined ? { probeBus } : {}) });
  servers.push(server);
  const c = connect(server);
  await c.open;
  c.ws.send(JSON.stringify({ t: "auth", token: server.token }));
  await until(() => c.frames.some((f) => f.t === "history"), "initial replay");
  return { c, server };
}

function op(ws: WebSocket, id: number, o: Record<string, unknown>): void {
  ws.send(JSON.stringify({ t: "op", id, op: o }));
}

const result = (frames: Frame[], id: number): Frame | undefined => frames.find((f) => f.t === "result" && f.id === id);
const probeFrames = (frames: Frame[]): ProbeEventWire[] => frames.filter((f) => f.t === "probe").map((f) => f.event as ProbeEventWire);

describe("PB-2 probeStream（WS 帧转发）", () => {
  it("(a) 订阅 → emit → {t:\"probe\",event} 帧到达（事件原样中继）", async () => {
    const bus = busStub();
    const { c } = await authed(bus);
    op(c.ws, 1, { op: "probeStream" });
    await until(() => result(c.frames, 1) !== undefined, "probeStream ack");
    expect(result(c.frames, 1)?.ok).toBe(true);
    bus.emit(ev("model", "model.call", 111, 812));
    await until(() => c.frames.some((f) => f.t === "probe"), "probe frame");
    const frame = c.frames.find((f) => f.t === "probe");
    expect(frame?.event).toEqual({ ts: 111, cat: "model", name: "model.call", data: { k: "model.call" }, dur: 812 });
    c.ws.close();
  });

  it("(b) cat 过滤槽：订阅 model → tool 事件零帧，model 事件帧到达；重订阅换槽", async () => {
    const bus = busStub();
    const { c } = await authed(bus);
    op(c.ws, 2, { op: "probeStream", cat: "model" });
    await until(() => result(c.frames, 2) !== undefined, "subscribe ack");
    bus.emit(ev("tool", "tool.run", 222)); // 不同类别——不应上链
    bus.emit(ev("model", "model.call", 333)); // 同类别——应上链
    await until(() => c.frames.some((f) => f.t === "probe"), "model probe frame");
    // 序列钉：到达的第一条 probe 帧就是 model 事件——tool 事件从未发帧。
    expect(probeFrames(c.frames).map((e) => e.name)).toEqual(["model.call"]);
    // 换槽：cat:"tool" 重订阅后，model 事件不再上链、tool 事件上链。
    op(c.ws, 3, { op: "probeStream", cat: "tool" });
    await until(() => result(c.frames, 3) !== undefined, "re-subscribe ack");
    const before = probeFrames(c.frames).length;
    bus.emit(ev("model", "model.call", 444));
    bus.emit(ev("tool", "tool.run", 555));
    await until(() => probeFrames(c.frames).length > before, "tool frame after re-subscribe");
    expect(probeFrames(c.frames).at(-1)?.name).toBe("tool.run");
    expect(probeFrames(c.frames).filter((e) => e.ts === 444)).toEqual([]); // 旧槽事件零帧
    c.ws.close();
  });

  it("(c) \"*\" 与缺省同义=全类别；坏 cat 拒（fail-closed 形状门）", async () => {
    const bus = busStub();
    const { c } = await authed(bus);
    op(c.ws, 4, { op: "probeStream", cat: "*" });
    op(c.ws, 5, { op: "probeStream", cat: "bogus" });
    op(c.ws, 6, { op: "probeStream", cat: 42 });
    await until(() => [4, 5, 6].every((id) => result(c.frames, id) !== undefined), "three results");
    expect(result(c.frames, 4)?.ok).toBe(true);
    expect(result(c.frames, 5)?.err).toBe("probeStream cat must be one of model|tool|ui|system|agent|* when present");
    expect(result(c.frames, 6)?.err).toBe("probeStream cat must be one of model|tool|ui|system|agent|* when present");
    // 坏 cat 不动既有槽：先前 "*" 订阅仍全类别转发。
    bus.emit(ev("system", "sys.tick", 666));
    await until(() => probeFrames(c.frames).length === 1, "system frame through the * slot");
    c.ws.close();
  });
});

describe("PB-2 probeRecent / probeStats（读面）", () => {
  it("(d) recent：全量、cat 过滤、limit 尾窗、\"*\" 同缺省", async () => {
    const bus = busStub();
    const { c } = await authed(bus);
    bus.emit(ev("model", "model.call", 1));
    bus.emit(ev("tool", "tool.run", 2));
    bus.emit(ev("model", "model.call", 3));
    op(c.ws, 11, { op: "probeRecent" });
    op(c.ws, 12, { op: "probeRecent", cat: "model" });
    op(c.ws, 13, { op: "probeRecent", cat: "model", limit: 1 });
    op(c.ws, 14, { op: "probeRecent", cat: "*", limit: 2 });
    await until(() => [11, 12, 13, 14].every((id) => result(c.frames, id) !== undefined), "recent results");
    expect((result(c.frames, 11)?.ok as ProbeEventWire[]).map((e) => e.ts)).toEqual([1, 2, 3]);
    expect((result(c.frames, 12)?.ok as ProbeEventWire[]).map((e) => e.ts)).toEqual([1, 3]);
    expect((result(c.frames, 13)?.ok as ProbeEventWire[]).map((e) => e.ts)).toEqual([3]);
    expect((result(c.frames, 14)?.ok as ProbeEventWire[]).map((e) => e.ts)).toEqual([2, 3]);
    c.ws.close();
  });

  it("(e) stats：统计面原样回；坏形状拒（cat / limit 形状门）", async () => {
    const bus = busStub();
    const { c } = await authed(bus);
    bus.emit(ev("model", "model.call", 7));
    bus.emit(ev("model", "model.call", 9));
    bus.emit(ev("tool", "tool.run", 12));
    op(c.ws, 21, { op: "probeStats" });
    op(c.ws, 22, { op: "probeRecent", cat: "nope" });
    op(c.ws, 23, { op: "probeRecent", limit: 0 });
    op(c.ws, 24, { op: "probeRecent", limit: 1.5 });
    op(c.ws, 25, { op: "probeRecent", limit: 1001 });
    await until(() => [21, 22, 23, 24, 25].every((id) => result(c.frames, id) !== undefined), "stats + bad shapes");
    expect(result(c.frames, 21)?.ok).toEqual({
      "model.call": { count: 2, lastTs: 9 },
      "tool.run": { count: 1, lastTs: 12 },
    });
    for (const id of [22]) {
      expect(result(c.frames, id)?.err).toBe("probeRecent cat must be one of model|tool|ui|system|agent|* when present");
    }
    for (const id of [23, 24, 25]) {
      expect(result(c.frames, id)?.err).toBe("probeRecent limit must be an integer 1..1000 when present");
    }
    c.ws.close();
  });
});

describe("PB-2 缺省零变化", () => {
  it("(f) 未挂 bus → 三 op 干净 unsupported（optional-ops 既有文案族），零帧", async () => {
    const { c } = await authed();
    op(c.ws, 31, { op: "probeStream" });
    op(c.ws, 32, { op: "probeRecent" });
    op(c.ws, 33, { op: "probeStats" });
    await until(() => [31, 32, 33].every((id) => result(c.frames, id) !== undefined), "unsupported results");
    for (const id of [31, 32, 33]) {
      expect(result(c.frames, id)?.err).toBe("probe not supported by this server");
    }
    expect(probeFrames(c.frames)).toEqual([]);
    c.ws.close();
  });

  it("(g) 挂了 bus 但未订阅 → emit 零 probe 帧（订阅门在 relay 内）", async () => {
    const bus = busStub();
    const { c } = await authed(bus);
    bus.emit(ev("model", "model.call", 42));
    bus.emit(ev("ui", "ui.render", 43));
    // emit 之后才发 op：若 emit 曾上链，probe 帧必先于 result 到达（server 的
    // send 同步有序）——result 到了而 probe 帧缺席即为确定性零帧钉。
    op(c.ws, 34, { op: "probeRecent" });
    await until(() => result(c.frames, 34) !== undefined, "recent result");
    expect(probeFrames(c.frames)).toEqual([]);
    expect((result(c.frames, 34)?.ok as ProbeEventWire[]).length).toBe(2);
    c.ws.close();
  });
});
