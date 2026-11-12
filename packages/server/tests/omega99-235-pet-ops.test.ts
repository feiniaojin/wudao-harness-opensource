// ω99-235: #7 — 小精灵会话隔离：server 域的 pet 车道协议面，先红后绿。
// ① petSubmit/petInterrupt/petAnswerPermission 路由到 petDriver（主 driver
// 零调用——车道隔离在协议边界就分流）；② 无 petDriver → optional-ops 族干净
// "pet ops not supported by this driver"；③ state 帧携带 pet 字段（双订阅各
// 自触发、帧内两态都新鲜）；④ sessions 行 lane:"pet" 标记（主窗会话列表的
// 小精灵徽标数据源）。full-set vaulted 镜像钉在 vaulted-mirror.test.ts（本弧
// 演进：三 pet op 入全集）。
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { createUiServer, interruptAndWaitPetIdle, type UiDriverPort, type UiPetDriverPort, type UiServer } from "../src/index.js";

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
  pet?: { lane?: string; busy?: boolean; workspaceName?: string; workspacePath?: string };
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

function authed(pet?: ReturnType<typeof petDriverMock>): Promise<{ c: ReturnType<typeof connect>; server: UiServer; main: ReturnType<typeof mainDriver>; pet: ReturnType<typeof petDriverMock> | undefined }> {
  return (async () => {
    const main = mainDriver();
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

// M85-pet §2 / Task 3 —— 精灵工具栏四 op（NewSession/SetModel/SetEffort/
// SetWorkspace）+ 状态帧 pet 的 workspace 对。路由钉沿 235 既有：全部只碰
// petDriver（主 driver 零调用）；老驱动（缺可选面）与无 petDriver 同句干净
// 拒 "pet ops not supported by this driver"。busy 稳定化是 Task 2 转来的
// 遗留收口：busy===false 可先于最后一条史落盘，仅靠 UI idle 门控不充分——
// server 侧 petNewSession 先 interrupt 等离 busy（10s 上限，超时仍执行）。
describe("M85-pet 工具栏四 op", () => {
  const res = (frames: Frame[], id: number): Frame | undefined =>
    frames.find((f) => f.t === "result" && f.id === id);

  it("(e) petNewSession：归档 id 回执 + null 空会话回执；缺面老驱动/无 petDriver 干净拒", async () => {
    const pet = petDriverMock();
    pet.newPetSession = async () => { pet.calls.push("newPetSession"); return "pet-20261108-210000"; };
    const { c, main } = await authed(pet);
    op(c.ws, 51, { op: "petNewSession" });
    await until(() => res(c.frames, 51) !== undefined, "archived id reply");
    expect(res(c.frames, 51)?.ok).toBe("pet-20261108-210000");

    pet.newPetSession = async () => null; // 零轮次空会话：跳过归档
    op(c.ws, 52, { op: "petNewSession" });
    await until(() => res(c.frames, 52) !== undefined, "null reply");
    expect(res(c.frames, 52)?.ok).toBeNull();

    delete pet.newPetSession; // 老驱动：可选面缺席
    op(c.ws, 53, { op: "petNewSession" });
    await until(() => res(c.frames, 53) !== undefined, "old-driver reject");
    expect(res(c.frames, 53)?.err).toBe("pet ops not supported by this driver");

    const bare = await authed(); // 无 petDriver 的宿主
    op(bare.c.ws, 54, { op: "petNewSession" });
    await until(() => res(bare.c.frames, 54) !== undefined, "no-driver reject");
    expect(res(bare.c.frames, 54)?.err).toBe("pet ops not supported by this driver");
    expect(main.calls).toEqual([]); // 车道隔离钉：轮换全程零主车道调用
    c.ws.close();
    bare.c.ws.close();
  });

  it("(f) busy 稳定化：运行中 → 先 interrupt 等离 busy 再轮换（emit 解除等待）", async () => {
    const pet = petDriverMock();
    let busyAtRotation: boolean | undefined;
    pet.newPetSession = async () => {
      busyAtRotation = (pet.getStatus() as { busy?: boolean }).busy === true;
      pet.calls.push("newPetSession");
      return "pet-arch-busy";
    };
    const { c, main } = await authed(pet);
    pet.setStatusBusy(true);
    await until(() => c.frames.some((f) => f.t === "state" && f.pet?.busy === true), "busy frame");
    op(c.ws, 55, { op: "petNewSession" });
    await wait(80); // 稳定化等待中：interrupt 已发，轮换未动（无 emit 不解除）
    expect(pet.calls).toEqual(["petInterrupt"]);
    pet.setStatusBusy(false); // 运行收束 emit → 等待解除 → 轮换执行
    await until(() => res(c.frames, 55) !== undefined, "rotation reply");
    expect(res(c.frames, 55)?.ok).toBe("pet-arch-busy");
    expect(pet.calls).toEqual(["petInterrupt", "newPetSession"]); // 顺序钉：先停后转
    expect(busyAtRotation).toBe(false); // 轮换发生在离开 busy 之后
    expect(main.calls).toEqual([]);
    c.ws.close();
  });

  it("(g) interruptAndWaitPetIdle 单元：idle 进门零动作；卡 busy 走上限；emit 提前解除", async () => {
    const idle = petDriverMock();
    await interruptAndWaitPetIdle(idle, 5000);
    expect(idle.calls).toEqual([]); // 不忙绝不 interrupt

    const stuck = petDriverMock();
    stuck.getStatus = () => ({ live: { reasoning: "", answer: "", busyTools: [] }, busy: true, mode: "workspace", sessionId: "pet", lane: "pet" });
    const t0 = Date.now();
    await interruptAndWaitPetIdle(stuck, 40); // 无 emit：只有上限能解除
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    expect(stuck.calls).toEqual(["petInterrupt"]); // 超时仍放行前的停跑照发

    const settle = petDriverMock();
    settle.setStatusBusy(true);
    setTimeout(() => settle.setStatusBusy(false), 30); // 30ms 后收束 emit
    const t1 = Date.now();
    await interruptAndWaitPetIdle(settle, 5000);
    expect(Date.now() - t1).toBeLessThan(2000); // emit 解除：远早于上限
    expect(settle.calls).toEqual(["petInterrupt"]);
  });

  it("(h) petSetModel/petSetEffort 路由到 configureModel；坏形状 typed 拒；缺面老驱动干净拒", async () => {
    const pet = petDriverMock();
    const cfgs: unknown[] = [];
    pet.configureModel = (cfg: { provider?: string; model?: string; effort?: string }) => {
      cfgs.push(cfg);
      pet.calls.push("configureModel");
    };
    const { c, main } = await authed(pet);
    op(c.ws, 61, { op: "petSetModel", provider: "deepseek", model: "m2", effort: "high" });
    op(c.ws, 62, { op: "petSetEffort", effort: "medium" });
    op(c.ws, 63, { op: "petSetModel", provider: 42 });
    op(c.ws, 64, { op: "petSetModel", model: "m" });
    op(c.ws, 65, { op: "petSetModel", provider: "glm", model: 7 });
    op(c.ws, 66, { op: "petSetModel", provider: "glm", effort: 9 });
    op(c.ws, 67, { op: "petSetEffort" });
    op(c.ws, 68, { op: "petSetEffort", effort: 9 });
    await until(() => [61, 62, 63, 64, 65, 66, 67, 68].every((id) => res(c.frames, id) !== undefined), "eight results");
    expect(res(c.frames, 61)?.ok).toBe(true);
    expect(res(c.frames, 62)?.ok).toBe(true);
    expect(cfgs).toEqual([{ provider: "deepseek", model: "m2", effort: "high" }, { effort: "medium" }]);
    expect(res(c.frames, 63)?.err).toBe("petSetModel provider must be a non-empty string");
    expect(res(c.frames, 64)?.err).toBe("petSetModel provider must be a non-empty string");
    expect(res(c.frames, 65)?.err).toBe("petSetModel model must be a string");
    expect(res(c.frames, 66)?.err).toBe("petSetModel effort must be a string");
    expect(res(c.frames, 67)?.err).toBe("petSetEffort needs an effort string");
    expect(res(c.frames, 68)?.err).toBe("petSetEffort needs an effort string");
    expect(pet.calls.filter((s) => s === "configureModel")).toHaveLength(2); // 坏形状到不了 driver
    expect(main.calls).toEqual([]);

    const oldDrv = petDriverMock(); // 老驱动：可选面缺席
    const o = await authed(oldDrv);
    op(o.c.ws, 69, { op: "petSetModel", provider: "glm" });
    op(o.c.ws, 70, { op: "petSetEffort", effort: "high" });
    await until(() => res(o.c.frames, 69) !== undefined && res(o.c.frames, 70) !== undefined, "old-driver rejects");
    expect(res(o.c.frames, 69)?.err).toBe("pet ops not supported by this driver");
    expect(res(o.c.frames, 70)?.err).toBe("pet ops not supported by this driver");
    c.ws.close();
    o.c.ws.close();
  });

  it("(i) petSetWorkspace 镜像 agentRootSwitch：AgentRootSwitchResult 同形回执；path 校验；缺面干净拒", async () => {
    const pet = petDriverMock();
    pet.agentRootSwitch = async (path: string) => {
      pet.calls.push(`agentRootSwitch:${path}`);
      return { applied: true, queued: false };
    };
    const { c, main } = await authed(pet);
    op(c.ws, 71, { op: "petSetWorkspace", path: "/w/space-b" });
    op(c.ws, 72, { op: "petSetWorkspace", path: "" });
    op(c.ws, 73, { op: "petSetWorkspace", path: 42 });
    await until(() => [71, 72, 73].every((id) => res(c.frames, id) !== undefined), "three results");
    expect(res(c.frames, 71)?.ok).toEqual({ applied: true, queued: false });
    expect(res(c.frames, 72)?.err).toBe("petSetWorkspace path must be a non-empty string");
    expect(res(c.frames, 73)?.err).toBe("petSetWorkspace path must be a non-empty string");
    expect(pet.calls.filter((s) => s.startsWith("agentRootSwitch"))).toEqual(["agentRootSwitch:/w/space-b"]);
    expect(main.calls).toEqual([]);

    const oldDrv = petDriverMock();
    const o = await authed(oldDrv);
    op(o.c.ws, 74, { op: "petSetWorkspace", path: "/w" });
    await until(() => res(o.c.frames, 74) !== undefined, "old-driver reject");
    expect(res(o.c.frames, 74)?.err).toBe("pet ops not supported by this driver");
    c.ws.close();
    o.c.ws.close();
  });
});

// M85-pet §2 —— 状态帧 pet 字段的 workspace 对（agentRootStatus 派生：
// workspaceName=basename、workspacePath=全路径，spec §4「chip 与 StatusBar
// 同源」的数据面）。异步读的帧序钉：auth 首帧行序 state→history 不得因链式
// 构建翻转；坏读/缺面降级为基础快照，状态信道绝不阻塞。
describe("M85-pet 状态帧 workspace 对", () => {
  it("(j) agentRootStatus 在场 → pet 帧带 workspaceName/workspacePath；auth 行序 state→history 不翻；随帧重读", async () => {
    const pet = petDriverMock();
    pet.agentRootStatus = async () => ({ panelRoot: "/w", agentRoot: "/w/精灵空间", aligned: true });
    const { c, main } = await authed(pet);
    // 0.5.10 — 状态帧零等待改形：auth 首帧不再等 workspace 读（旧形每帧
    // await realpath，慢读机器上整条 delta 流被拖住——本测试文件修订的同
    // 根因）。首帧照发（lane/busy 即时），pair 由读落地后的补推帧送达。
    const first = c.frames.find((f) => f.t === "state");
    expect(first?.pet?.lane).toBe("pet"); // 既有字段不动
    expect(first?.pet?.busy).toBe(false);
    await until(() => c.frames.some((f) => f.t === "state" && f.pet?.workspaceName === "精灵空间"), "cold-start follow-up frame with the pair");
    const primed = c.frames.filter((f) => f.t === "state" && f.pet?.workspaceName === "精灵空间").at(-1)!;
    expect(primed.pet?.workspacePath).toBe("/w/精灵空间");
    expect(c.frames.findIndex((f) => f.t === "state")).toBeLessThan(c.frames.findIndex((f) => f.t === "history")); // 行序钉
    expect(main.calls).toEqual([]);

    const before = c.frames.filter((f) => f.t === "state").length;
    pet.setStatusBusy(true); // pet 自己的 emit → 新帧，workspace 对随帧重读
    await until(() => c.frames.filter((f) => f.t === "state").length > before, "pushed frame");
    const pushed = c.frames.filter((f) => f.t === "state").at(-1);
    expect(pushed?.pet?.busy).toBe(true);
    expect(pushed?.pet?.workspacePath).toBe("/w/精灵空间");
    c.ws.close();
  });

  it("(k) 缺面老驱动 → pet 帧无 workspace 两键（旧形状钉）；agentRootStatus 抛错 → 基础快照照发、信道不阻塞", async () => {
    const { c } = await authed(petDriverMock()); // 无 agentRootStatus 面
    const first = c.frames.find((f) => f.t === "state");
    expect(first?.pet && "workspaceName" in first.pet).toBe(false);
    expect(first?.pet && "workspacePath" in first.pet).toBe(false);
    c.ws.close();

    const boom = petDriverMock();
    boom.agentRootStatus = async () => { throw new Error("realpath 失败"); };
    const b = await authed(boom);
    const f2 = b.c.frames.find((f) => f.t === "state");
    expect(f2?.pet?.lane).toBe("pet"); // 坏读降级：基础快照原样在场
    expect(f2?.pet && "workspacePath" in f2.pet).toBe(false);
    boom.setStatusBusy(true); // 后续推送不受坏读拖累
    await until(() => b.c.frames.some((f) => f.t === "state" && f.pet?.busy === true), "frames keep flowing");
    b.c.ws.close();
  });

  // I-1（评审修复轮）—— 链失败隔离（监听器失败隔离 DNA 在帧链上的同构）：
  // 一次瞬态读取抛错不得毒化 frameChain（无 .catch 的链步 rejection 会让
  // 后续帧全部停发 + unhandled rejection 可崩进程）。断言：吃了抛错之后，
  // 下一个 emit 照发新帧（链回 resolved）。
  it("(l) 链失败隔离：一次状态读取瞬态抛错不毒化帧链（后续帧照发）", async () => {
    const pet = petDriverMock();
    pet.agentRootStatus = async () => ({ panelRoot: "/w", agentRoot: "/w/精灵空间", aligned: true });
    const realGetStatus = pet.getStatus.bind(pet);
    let throwOnce = true;
    pet.getStatus = () => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error("瞬态读取失败");
      }
      return realGetStatus();
    };
    const { c } = await authed(pet); // 首帧构建吃到那次抛错（链步 rejected）
    pet.setStatusBusy(true); // 下一个 emit：修复后链仍活着，新帧照发
    await until(() => c.frames.some((f) => f.t === "state" && f.pet?.busy === true), "chain survives the transient throw");
    c.ws.close();
  });
});
