// ω99-271: #1 — 小精灵会话完整史（用户报障 09-10：「很多消息没有展示完全，
// 也看不到完整的会话信息」）——server 域第四 pet op `petHistory`，先红后绿。
// 根因三层（弧报告 §一）：① PetFrame.answerTail 只带末 500 字尾窗（长回答头
// 部结构性到不了宠物窗）；② MAX_CHAT_TURNS=3 弃最旧；③ transcript 是宠物窗
// 本地态，窗关即空——而 pet 车道 driver 手里有全量史（ui.ts 从 pet.jsonl
// resume 进 getHistory），server 端口面却明文「no history replay」。本弧把
// 已存的史送到该看它的窗：op 是纯读（不进 vault 全集——vaulted-mirror 的
// reads 清单另钉）。★红线（09-09 用户令）：夹具只写内存，全程零文件。
// ω99-272 — 271 的两道 server 侧帽全撤（用户令「本地转写无限」）：轮上限
// 50 / 单轮字上限 8000（保头尾 + 中段省略标注）退役，(c)(d) 改钉全保真。
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { createUiServer, petTurnsFromHistory, type UiDriverPort, type UiPetDriverPort, type UiServer } from "../src/index.js";

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

/** 主车道 mock：getHistory 计数——boot 的 initial replay 帧合法调一次（index.ts
 *  :654 既有路径），车道隔离钉看的是 petHistory 之后「计数不增」。 */
function mainDriver(): UiDriverPort & { historyCalls: number } {
  const d: UiDriverPort & { historyCalls: number } = {
    historyCalls: 0,
    subscribe: () => () => {},
    getStatus: () => ({ live: { reasoning: "", answer: "", busyTools: [] }, busy: false, mode: "workspace" }),
    getHistory: () => {
      d.historyCalls += 1;
      return [];
    },
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
  return d;
}

type Entry = { kind: string; text?: string };

/** pet 车道 mock：getHistory 可编程 + 计数经 getter 暴露（对象字段直写会漏计）。 */
function petDriverMock(entries: readonly Entry[]): UiPetDriverPort & { historyCalls: () => number } {
  let historyCalls = 0;
  return {
    historyCalls: () => historyCalls,
    subscribe: () => () => {},
    getStatus: () => ({ live: { reasoning: "", answer: "", busyTools: [] }, busy: false, mode: "auto", lane: "pet" }),
    getHistory: () => {
      historyCalls += 1;
      return entries;
    },
    submit: () => "started",
    interrupt: () => {},
    answerPermission: () => true,
  } as unknown as UiPetDriverPort & { historyCalls: () => number };
}

interface Frame {
  t: string;
  id?: unknown;
  ok?: unknown;
  err?: string;
}

async function authed(petDriver?: UiPetDriverPort): Promise<{ ws: WebSocket; frames: Frame[]; main: UiDriverPort & { historyCalls: number } }> {
  const main = mainDriver();
  const server = await createUiServer({ driver: main, ...(petDriver !== undefined ? { petDriver } : {}) });
  servers.push(server);
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
  const frames: Frame[] = [];
  const open = new Promise<void>((resolve) => ws.once("open", resolve));
  ws.on("message", (data) => frames.push(JSON.parse(String(data)) as Frame));
  await open;
  ws.send(JSON.stringify({ t: "auth", token: server.token }));
  await until(() => frames.some((f) => f.t === "history"), "initial replay");
  return { ws, frames, main };
}

function op(ws: WebSocket, id: number, o: Record<string, unknown>): void {
  ws.send(JSON.stringify({ t: "op", id, op: o }));
}

describe("ω99-271 petHistory op（读车道 + 配对）", () => {
  it("(a) 路由到 petDriver.getHistory：三轮史配对成 {q,a}（assistant 多段 \\n\\n 连接、tool/notice 跳过）", async () => {
    const entries: Entry[] = [
      { kind: "user", text: "第一问" },
      { kind: "assistant", text: "" }, // 工具轮的空 assistant——跳过
      { kind: "tool", text: "shell" },
      { kind: "assistant", text: "先看了下目录。" },
      { kind: "assistant", text: "最终答案一。" },
      { kind: "notice", text: "boot 提示" },
      { kind: "user", text: "第二问" },
      { kind: "assistant", text: "答案二。" },
    ];
    const pet = petDriverMock(entries);
    const { ws, frames, main } = await authed(pet);
    const mainCallsAtBoot = main.historyCalls; // initial replay 的合法一次
    op(ws, 1, { op: "petHistory" });
    await until(() => frames.some((f) => f.t === "result" && f.id === 1), "petHistory result");
    expect(frames.find((f) => f.t === "result" && f.id === 1)?.ok).toEqual([
      { q: "第一问", a: "先看了下目录。\n\n最终答案一。" },
      { q: "第二问", a: "答案二。" },
    ]);
    expect(main.historyCalls).toBe(mainCallsAtBoot); // 车道隔离：读精灵史绝不走主道
    ws.close();
  });

  it("(b) 缺席面：无 petDriver → 干净 unsupported；错误轮（有问无答）a 取 error 文本；悬挂 assistant 丢弃", async () => {
    const { ws, frames } = await authed();
    op(ws, 11, { op: "petHistory" });
    await until(() => frames.some((f) => f.t === "result" && f.id === 11), "absent result");
    expect(frames.find((f) => f.t === "result" && f.id === 11)?.err).toBe("pet ops not supported by this driver");
    ws.close();

    const pet2 = petDriverMock([
      { kind: "assistant", text: "悬挂段（无先导 user）" },
      { kind: "user", text: "没答上的问" },
      { kind: "error", text: "模型调用失败：超时" },
      { kind: "user", text: "下一个问" },
      { kind: "assistant", text: "答上了。" },
    ]);
    const c2 = await authed(pet2);
    op(c2.ws, 12, { op: "petHistory" });
    await until(() => c2.frames.some((f) => f.t === "result" && f.id === 12), "second result");
    expect(c2.frames.find((f) => f.t === "result" && f.id === 12)?.ok).toEqual([
      { q: "没答上的问", a: "模型调用失败：超时" },
      { q: "下一个问", a: "答上了。" },
    ]);
    c2.ws.close();
  });
});

describe("ω99-271 petTurnsFromHistory 纯函数（ω99-272 起全保真）", () => {
  it("(c) ω99-272: #9 — 轮数无帽：60 轮全量返回、序次保持（「本地转写无限」的 server 侧）", () => {
    const entries: Entry[] = [];
    for (let i = 0; i < 60; i += 1) {
      entries.push({ kind: "user", text: `问${i}` }, { kind: "assistant", text: `答${i}` });
    }
    const turns = petTurnsFromHistory(entries);
    expect(turns).toHaveLength(60);
    expect(turns[0]!.q).toBe("问0"); // 最旧不被弃
    expect(turns[59]!.a).toBe("答59");
  });

  it("(d) ω99-272 — 单轮字数无帽：13000 字答案全文透传、零省略标注（截断标注退役）", () => {
    const long = "甲".repeat(13000);
    const turns = petTurnsFromHistory([{ kind: "user", text: "长答问" }, { kind: "assistant", text: long }]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.a).toBe(long); // 一字不少
    expect(turns[0]!.a).not.toContain("中段省略"); // 271 的显式标注退役
  });

  it("(e) 空史/无 message 条目 → 空数组（fresh 精灵窗的诚实空态）", () => {
    expect(petTurnsFromHistory([])).toEqual([]);
    expect(petTurnsFromHistory([{ kind: "notice", text: "boot" }, { kind: "divider", text: "—" }])).toEqual([]);
  });
});
