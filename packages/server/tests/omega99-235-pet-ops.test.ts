// ω99-235: #7 — 小精灵会话隔离：server 域的 pet 车道协议面，先红后绿。
// ① petSubmit/petInterrupt/petAnswerPermission 路由到 petDriver（主 driver
// 零调用——车道隔离在协议边界就分流）；② 无 petDriver → optional-ops 族干净
// "pet ops not supported by this driver"；③ state 帧携带 pet 字段（双订阅各
// 自触发、帧内两态都新鲜）；④ sessions 行 lane:"pet" 标记（主窗会话列表的
// 小精灵徽标数据源）。full-set vaulted 镜像钉在 vaulted-mirror.test.ts（本弧
// 演进：三 pet op 入全集）。
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { createUiServer, type UiDriverPort, type UiPetDriverPort, type UiServer } from "../src/index.js";

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

/** The main-lane driver: minimal port whose mutators RECORD every call (the
 *  zero-call assertions — a pet op routed here is an isolation breach). */
function mainDriver(): UiDriverPort & { calls: string[] } {
  const calls: string[] = [];
  let statusCbs = new Set<() => void>();
  return {
    calls,
    subscribe: (cb) => (statusCbs.add(cb), () => statusCbs.delete(cb)),
    getStatus: () => ({ live: { reasoning: "", answer: "", busyTools: [] }, busy: false, mode: "workspace", lane: "main" }),
    getHistory: () => [],
    onHistory: () => () => {},
    onLoopEvent: () => () => {},
    submit: (text: string) => (calls.push(`submit:${text}`), "started"),
    interrupt: () => void calls.push("interrupt"),
    setMode: () => void calls.push("setMode"),
    answerPermission: () => (calls.push("answerPermission"), false),
    listSlashCommands: () => [],
    sessions: async () => [
      { id: "wudao-main-1", messages: 2, firstUser: "主窗问题", model: "m" },
      { id: "pet", messages: 5, firstUser: "精灵第一问", model: "m" },
    ],
    resume: async () => ({ ok: true }),
    rewind: async () => "rewound",
  };
}

/** The pet-lane driver mock: same recording posture + an emittable status. */
function petDriverMock(): UiPetDriverPort & { calls: string[]; setStatusBusy: (b: boolean) => void } {
  const calls: string[] = [];
  const statusCbs = new Set<() => void>();
  let busy = false;
  return {
    calls,
    subscribe: (cb) => (statusCbs.add(cb), () => statusCbs.delete(cb)),
    getStatus: () => ({ live: { reasoning: "", answer: "", busyTools: [] }, busy, mode: "workspace", sessionId: "pet", lane: "pet" }),
    submit: (text: string) => (calls.push(`petSubmit:${text}`), "started"),
    interrupt: () => void calls.push("petInterrupt"),
    answerPermission: (allow: boolean, _reason?: string, scope?: "session" | "always") =>
      (calls.push(`petAnswerPermission:${String(allow)}:${String(scope)}`), true),
    // ω99-271: #3 — the port's sixth member (petHistory read): the 271 test
    // owns its behavior face; this mock just keeps the literal complete.
    getHistory: () => [],
    setStatusBusy: (b) => { busy = b; for (const cb of [...statusCbs]) cb(); },
  };
}

interface Frame {
  t: string;
  state?: { lane?: string; busy?: boolean };
  pet?: { lane?: string; busy?: boolean };
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

function authed(petDriver?: UiPetDriverPort): Promise<{ c: ReturnType<typeof connect>; server: UiServer; main: ReturnType<typeof mainDriver>; pet: ReturnType<typeof petDriverMock> | undefined }> {
  return (async () => {
    const main = mainDriver();
    const pet = petDriver !== undefined ? petDriverMock() : undefined;
    const server = await createUiServer({ driver: main, ...(pet !== undefined ? { petDriver: pet } : {}) });
    servers.push(server);
    const c = connect(server);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: server.token }));
    await until(() => c.frames.some((f) => f.t === "history"), "initial replay");
    return { c, server, main, pet };
  })();
}

function op(ws: WebSocket, id: number, o: Record<string, unknown>): void {
  ws.send(JSON.stringify({ t: "op", id, op: o }));
}

describe("ω99-235 pet ops（路由 + 车道隔离）", () => {
  it("(a) petSubmit/petInterrupt/petAnswerPermission 路由到 petDriver；主 driver 零调用", async () => {
    const { c, main, pet } = await authed(petDriverMock());
    op(c.ws, 1, { op: "petSubmit", text: "精灵的问题" });
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 1), "petSubmit result");
    expect(c.frames.find((f) => f.t === "result" && f.id === 1)?.ok).toBe("started");
    expect(pet!.calls).toEqual(["petSubmit:精灵的问题"]);

    op(c.ws, 2, { op: "petInterrupt" });
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 2), "petInterrupt result");
    op(c.ws, 3, { op: "petAnswerPermission", allow: true, scope: "always" });
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 3), "petAnswerPermission result");
    expect(pet!.calls).toEqual(["petSubmit:精灵的问题", "petInterrupt", "petAnswerPermission:true:always"]);
    // 车道隔离钉：三个 op 全程没碰主 driver 的任何 mutator。
    expect(main.calls).toEqual([]);
    c.ws.close();
  });

  it("(b) 无 petDriver → 三 op 干净 unsupported（optional-ops 既有文案族）", async () => {
    const { c } = await authed();
    for (const [id, o] of [
      [11, { op: "petSubmit", text: "x" }],
      [12, { op: "petInterrupt" }],
      [13, { op: "petAnswerPermission", allow: true }],
    ] as const) {
      op(c.ws, id, o);
      await until(() => c.frames.some((f) => f.t === "result" && f.id === id), `result ${id}`);
      expect(c.frames.find((f) => f.t === "result" && f.id === id)?.err).toBe("pet ops not supported by this driver");
    }
    c.ws.close();
  });

  it("(a2) 校验镜像：petSubmit 非字符串 text / petAnswerPermission 坏形状 → 镜像主 op 的错", async () => {
    const { c, pet } = await authed(petDriverMock());
    op(c.ws, 21, { op: "petSubmit", text: 42 });
    op(c.ws, 22, { op: "petAnswerPermission", allow: "yes" });
    op(c.ws, 23, { op: "petAnswerPermission", allow: true, scope: "forever" });
    await until(() => c.frames.filter((f) => f.t === "result").length >= 3, "three results");
    expect(c.frames.find((f) => f.t === "result" && f.id === 21)?.err).toBe("petSubmit needs a text string");
    expect(c.frames.find((f) => f.t === "result" && f.id === 22)?.err).toBe("petAnswerPermission needs allow: boolean");
    expect(c.frames.find((f) => f.t === "result" && f.id === 23)?.err).toBe('petAnswerPermission scope must be "session" | "always"');
    expect(pet!.calls).toEqual([]); // 坏形状到不了 petDriver
    c.ws.close();
  });
});

describe("ω99-235 state 帧双车道", () => {
  it("(c) 首帧带 pet 字段；petDriver 的推送触发新 state 帧，两态都新鲜", async () => {
    const { c, pet } = await authed(petDriverMock());
    const first = c.frames.find((f) => f.t === "state");
    expect(first).toBeDefined();
    expect(first?.pet?.lane).toBe("pet");
    expect(first?.state?.lane).toBe("main");

    const framesBefore = c.frames.filter((f) => f.t === "state").length;
    pet!.setStatusBusy(true); // pet 车道自己的变化……
    await until(() => c.frames.filter((f) => f.t === "state").length > framesBefore, "pet emit pushes a state frame");
    const pushed = c.frames.filter((f) => f.t === "state").at(-1);
    expect(pushed?.pet?.busy).toBe(true); // ……新帧里 pet 态新鲜……
    expect(pushed?.state?.lane).toBe("main"); // ……主态也同帧在场（不是只发 pet 半帧）
    c.ws.close();
  });

  it("(c2) 无 petDriver 的 state 帧不含 pet 字段（旧形状钉）", async () => {
    const { c } = await authed();
    const first = c.frames.find((f) => f.t === "state");
    expect(first).toBeDefined();
    expect("pet" in (first ?? {})).toBe(false);
    c.ws.close();
  });
});

// ω99-237: #9 — petSubmit 斜杠拒令（车道不变量的协议层守卫）：pet 车道是固定
// id "pet" 的常驻车道，斜杠命令（/clear 等）经 petSubmit 会走 driver 的 submit
// 斜杠路由（旋转会话 id / 落 clear 边界）——车道 id 丢失，235 钉死的「pet 车道
// 永不换 id」在协议边界封死（UiPetDriverPort 是 pet 提交的唯一 choke point，
// 拒在这里覆盖一切客户端，错误串沿 server 族英文形、brief §二 逐字）。对照
// 钉=主车道 submit 的斜杠照旧路由（斜杠命令是主车道功能，不受本弧扰动）。
describe("ω99-237 petSubmit 斜杠拒令", () => {
  const SLASH_ERR = "petSubmit rejects slash commands — the pet lane has a fixed session; use the main window for commands";

  it("(a) /clear 拒：错误串逐字；petDriver 与主 driver 双零调用（到不了 driver）", async () => {
    const { c, main, pet } = await authed(petDriverMock());
    op(c.ws, 41, { op: "petSubmit", text: "/clear" });
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 41), "slash rejection");
    expect(c.frames.find((f) => f.t === "result" && f.id === 41)?.err).toBe(SLASH_ERR);
    expect(pet!.calls).toEqual([]); // 拒在 petDriver 之前（协议边界）
    expect(main.calls).toEqual([]);
    c.ws.close();
  });

  it("(b) /x anything 拒；先导空白拒（trim 后命中）；非前导斜杠的普通文本照旧过 petDriver", async () => {
    const { c, pet } = await authed(petDriverMock());
    op(c.ws, 42, { op: "petSubmit", text: "/x anything" });
    op(c.ws, 43, { op: "petSubmit", text: "  /trim" });
    op(c.ws, 44, { op: "petSubmit", text: "进度 3/4 的普通问题" });
    await until(() => [42, 43, 44].every((id) => c.frames.some((f) => f.t === "result" && f.id === id)), "three results");
    expect(c.frames.find((f) => f.t === "result" && f.id === 42)?.err).toBe(SLASH_ERR);
    expect(c.frames.find((f) => f.t === "result" && f.id === 43)?.err).toBe(SLASH_ERR); // 先导空白不 smuggle
    expect(c.frames.find((f) => f.t === "result" && f.id === 44)?.ok).toBe("started");
    expect(pet!.calls).toEqual(["petSubmit:进度 3/4 的普通问题"]); // 只有非前导斜杠的过
    c.ws.close();
  });

  it("(c) 对照钉：主车道 submit 斜杠照旧路由（/clear 进主 driver）", async () => {
    const { c, main, pet } = await authed(petDriverMock());
    op(c.ws, 45, { op: "submit", text: "/clear" });
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 45), "main submit result");
    expect(main.calls).toEqual(["submit:/clear"]); // 主车道斜杠是功能，零扰动
    expect(pet!.calls).toEqual([]);
    c.ws.close();
  });
});

describe("ω99-235 sessions 行 lane 标记", () => {
  it('(d) id==="pet" 的行带 lane:"pet"，其余行无 lane 字段', async () => {
    const { c } = await authed(petDriverMock());
    op(c.ws, 31, { op: "sessions" });
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 31), "sessions result");
    const rows = c.frames.find((f) => f.t === "result" && f.id === 31)?.ok as { id: string; lane?: string }[];
    const petRow = rows.find((r) => r.id === "pet");
    const mainRow = rows.find((r) => r.id === "wudao-main-1");
    expect(petRow?.lane).toBe("pet");
    expect(mainRow && "lane" in mainRow).toBe(false);
    c.ws.close();
  });
});
