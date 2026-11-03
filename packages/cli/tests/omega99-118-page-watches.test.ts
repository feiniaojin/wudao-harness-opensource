// ω99-118 — 页面盯看（watches）. RED-first.
// 弧门：「对宠物说『盯着这个页面』，它每半小时自己看一眼，页面变了气泡里
// 告诉你。」——watch 是 cron 任务的单层薄壳：createTask + 固定中文模板，
// 变化判据=模型对会话历史里的上次摘要做对比（零新存储），投递链
// （[scheduled task 前缀→105 气泡→115 收养）全复用。
//
// 三段：纯层（模板逐字/interval typed 拒/判据）→ 工具面（双门注册/
// fail-closed/round-trip）→ e2e（确定性模型：注入轮里模型调假件
// browser_open/browser_snapshot，答案入历史带 [scheduled task 前缀）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@wudao-org/core";
import { createBrowserRuntime } from "@wudao-org/browser";
import type { ModelClient, ModelInput, AssistantMessage } from "@wudao-org/core";
import { createCronRuntime } from "../src/cron.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";
import { buildToolSet } from "../src/tools.js";
import {
  WATCH_DEFAULT_INTERVAL_MINUTES,
  WATCH_MIN_INTERVAL_MINUTES,
  buildWatchPrompt,
  watchIntervalFromMinutes,
  watchUrlFromInput,
  watchUrlFromPrompt,
  isWatchPrompt,
  createWatchTools,
} from "../src/watch.js";

const URL_OK = "https://example.com/pricing";
const MIN = 60_000;

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "w118-watch-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

describe("ω99-118 纯层 — 模板逐字（golden）", () => {
  it("buildWatchPrompt：整串逐字钉（纪律全在内）", () => {
    expect(buildWatchPrompt(URL_OK)).toBe(
      `【页面盯看】请看一眼这个页面有没有新变化：${URL_OK}\n` +
      "1. 用 browser_open 重新打开上面的网址，不要假设页面还开着。\n" +
      "2. 用 browser_snapshot 浏览页面，用一两句话概括当前内容。\n" +
      "3. 把这次的概括和对话里上一次的概括对比；找不到上一次的概括，就当作第一次看。\n" +
      "4. 有变化：只用一句话告诉用户页面变了什么。\n" +
      "5. 没变化：只回复「无变化」，不要多说。\n" +
      "无论有没有变化，都不要把页面的完整内容贴出来。",
    );
  });

  it("模板纪律逐项：重开不假设 / 摘要对比上文 / 一句话讲变化 / 「无变化」逐字 / 不贴全量", () => {
    const p = buildWatchPrompt(URL_OK);
    expect(p).toContain("重新打开上面的网址，不要假设页面还开着");
    expect(p).toContain("和对话里上一次的概括对比");
    expect(p).toContain("只用一句话告诉用户页面变了什么");
    expect(p).toContain("「无变化」");
    expect(p).toContain("不要把页面的完整内容贴出来");
    // 模板=用户收益中文：不得出现实现术语。
    for (const jargon of ["cron", "scheduler", "IntervalSchedule", "harness", "context", "token"]) {
      expect(p).not.toContain(jargon);
    }
  });

  it("url 注入模板首行；watchUrlFromPrompt 往返取回", () => {
    expect(watchUrlFromPrompt(buildWatchPrompt(URL_OK))).toBe(URL_OK);
    expect(watchUrlFromPrompt(buildWatchPrompt("http://a.b/c?d=1"))).toBe("http://a.b/c?d=1");
  });

  it("isWatchPrompt：前缀判据（前缀真/中缀假/空假/普通假）", () => {
    expect(isWatchPrompt(buildWatchPrompt(URL_OK))).toBe(true);
    expect(isWatchPrompt("【页面盯看】")).toBe(true);
    expect(isWatchPrompt(`前置文字\n${buildWatchPrompt(URL_OK)}`)).toBe(false);
    expect(isWatchPrompt("[scheduled task ab12cd34] 普通提醒")).toBe(false);
    expect(isWatchPrompt("")).toBe(false);
  });
});

describe("ω99-118 纯层 — interval typed 校验映射", () => {
  it("缺省 → 默认 30 分钟", () => {
    expect(watchIntervalFromMinutes(undefined)).toEqual({ ok: true, everyMs: 30 * MIN });
    expect(WATCH_DEFAULT_INTERVAL_MINUTES).toBe(30);
  });

  it("下限 5：恰 5 收，<5 typed 拒", () => {
    expect(WATCH_MIN_INTERVAL_MINUTES).toBe(5);
    expect(watchIntervalFromMinutes(5)).toEqual({ ok: true, everyMs: 5 * MIN });
    for (const bad of [4, 4.9, 0, -30]) {
      const r = watchIntervalFromMinutes(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    }
  });

  it("非数字（字符串/NaN/Infinity/null）typed 拒；正常值映射毫秒", () => {
    for (const bad of ["30", NaN, Infinity, null, {}]) {
      expect(watchIntervalFromMinutes(bad).ok).toBe(false);
    }
    expect(watchIntervalFromMinutes(10)).toEqual({ ok: true, everyMs: 10 * MIN });
    expect(watchIntervalFromMinutes(7.5)).toEqual({ ok: true, everyMs: 450_000 });
  });
});

describe("ω99-118 纯层 — url typed 校验（与 browser_open 同规：绝对 http(s)）", () => {
  it("http/https 收；其余 typed 拒", () => {
    expect(watchUrlFromInput("https://example.com/pricing")).toEqual({ ok: true, url: "https://example.com/pricing" });
    expect(watchUrlFromInput("http://a.b")).toEqual({ ok: true, url: "http://a.b" });
    for (const bad of ["ftp://a.b", "example.com", "not a url", "", "  ", 42, null, undefined]) {
      const r = watchUrlFromInput(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 工具面 — 双门注册（cron.createTask 在 且 browser 在）+ fail-closed + round-trip
// ---------------------------------------------------------------------------
const stubModel = { stream: async function* () { /* never invoked */ } } as unknown as never;
const gate = async (): Promise<{ behavior: "allow" }> => ({ behavior: "allow" });
const BASE = { workspaceRoot: "/tmp/ws", model: stubModel, canUseTool: gate, contextWindowTokens: 64_000 } as const;

const browserRuntime = () =>
  createBrowserRuntime({
    port: { launch: async () => { throw new Error("never launched in registration tests"); } },
    homeDir: "/tmp/wd-browser-118-home",
    env: () => ({}),
    resolveInstalled: async () => "/fake/kernel",
    download: async () => ({ executablePath: "/fake/kernel" }),
    registerExitHook: () => () => {},
  });

const inertCreateTask = async () => { throw new Error("unreachable in registration tests"); };
/** 注册级假 runtime（从不执行——存在性即门）。 */
const fakeRuntime = {
  createTask: inertCreateTask,
  list: () => [],
  remove: async () => false,
  table: () => ({ list: () => [], add: async () => {}, remove: async () => false }),
} as unknown as import("../src/cron.js").CronRuntime;

describe("ω99-118 工具面 — 双门注册（照 cron 三件套范式，字节序稳定）", () => {
  it("cron(runtime)+browser → 三件套注册，钉在 cron 三件套之后", () => {
    const tools: Tool[] = buildToolSet({
      ...BASE,
      cron: { table: { list: () => [], add: async () => {}, remove: async () => false }, runtime: fakeRuntime },
      browser: browserRuntime(),
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain("watch_create");
    expect(names).toContain("watch_list");
    expect(names).toContain("watch_delete");
    // 固定位置：紧跟 cron 三件套之后（前缀稳定纪律）。
    expect(names.indexOf("watch_create")).toBe(names.indexOf("cron_delete") + 1);
    expect(names.indexOf("watch_list")).toBe(names.indexOf("watch_create") + 1);
    expect(names.indexOf("watch_delete")).toBe(names.indexOf("watch_list") + 1);
  });

  it("无浏览器 → absent（fail-closed 钉：无浏览器不注册）", () => {
    const tools: Tool[] = buildToolSet({
      ...BASE,
      cron: { table: { list: () => [], add: async () => {}, remove: async () => false }, runtime: fakeRuntime },
    });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("watch_create");
    expect(names).not.toContain("watch_list");
    expect(names).not.toContain("watch_delete");
  });

  it("cron seam 无 runtime（ω99-112 fixture 形态：仅 table）→ absent（既有字节 pin 不受扰）", () => {
    const tools: Tool[] = buildToolSet({
      ...BASE,
      cron: { table: { list: () => [], add: async () => {}, remove: async () => false } },
      browser: browserRuntime(),
    });
    expect(tools.map((t) => t.name).some((n) => n.startsWith("watch_"))).toBe(false);
  });

  it("cron 整体缺席 → absent", () => {
    const tools: Tool[] = buildToolSet({ ...BASE, browser: browserRuntime() });
    expect(tools.map((t) => t.name).some((n) => n.startsWith("watch_"))).toBe(false);
  });
});

describe("ω99-118 工具面 — round-trip（真 runtime + 真盘store）", () => {
  it("watch_create：默认 30 分钟；prompt=固定模板；interval 排程；origin=model；7 天过期；收据诚实", async () => {
    let clock = 1_800_000_000_000;
    const rt = await createCronRuntime({ workspaceRoot: ws, sessionId: "s-w118-a", tickMs: 0, now: () => clock });
    const tools = createWatchTools({ runtime: rt, now: () => clock });
    const create = tools.find((t) => t.name === "watch_create")!;
    const r = await create.execute({ url: URL_OK });
    expect(r.isError).toBeUndefined();
    const task = rt.list()[0]!;
    expect(task.prompt).toBe(buildWatchPrompt(URL_OK));
    expect(task.schedule).toEqual({ type: "interval", everyMs: 30 * MIN });
    expect(task.origin).toBe("model");
    expect(task.expiresAt).toBe(task.createdAt + 7 * 24 * 60 * MIN);
    expect(r.content).toContain(URL_OK);
    expect(r.content).toContain(task.id);
    expect(r.content).toContain("7"); // 7-day expiry taught in the receipt
    expect(r.content.toLowerCase()).toContain("every 30m");
    rt.stop();
  });

  it("watch_create：intervalMinutes=5 恰收；<5 / 非数字 typed 拒；坏 url typed 拒（零副作用）", async () => {
    const rt = await createCronRuntime({ workspaceRoot: ws, sessionId: "s-w118-b", tickMs: 0 });
    const tools = createWatchTools({ runtime: rt });
    const create = tools.find((t) => t.name === "watch_create")!;
    const five = await create.execute({ url: URL_OK, intervalMinutes: 5 });
    expect(five.isError).toBeUndefined();
    expect(rt.list().some((t) => t.schedule.type === "interval" && t.schedule.everyMs === 5 * MIN)).toBe(true);
    for (const bad of [4, 4.9, 0, "30", null]) {
      const r = await create.execute({ url: URL_OK, intervalMinutes: bad });
      expect(r.isError).toBe(true);
      expect(typeof r.content).toBe("string");
    }
    for (const badUrl of ["ftp://x", "not-a-url", ""]) {
      const r = await create.execute({ url: badUrl });
      expect(r.isError).toBe(true);
    }
    // typed 拒零副作用：表里只有成功那条。
    expect(rt.list().length).toBe(1);
    rt.stop();
  });

  it("watch_create：inert runtime（kill switch）→ fail-closed 拒（不静默）", async () => {
    const rt = await createCronRuntime({
      workspaceRoot: ws, sessionId: "s-w118-c", tickMs: 0, env: { WUDAO_DISABLE_CRON: "1" },
    });
    const tools = createWatchTools({ runtime: rt });
    const r = await tools.find((t) => t.name === "watch_create")!.execute({ url: URL_OK });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("unavailable");
    rt.stop();
  });

  it("watch_list：只列 watch（普通 cron 任务/提醒不出）；行含 id/url/间隔", async () => {
    const rt = await createCronRuntime({ workspaceRoot: ws, sessionId: "s-w118-d", tickMs: 0 });
    await rt.createTask({ prompt: "普通提醒：喝水", schedule: { type: "interval", everyMs: 60 * MIN } });
    const tools = createWatchTools({ runtime: rt });
    const create = tools.find((t) => t.name === "watch_create")!;
    await create.execute({ url: URL_OK, intervalMinutes: 10 });
    const r = await tools.find((t) => t.name === "watch_list")!.execute({});
    expect(r.isError).toBeUndefined();
    const ids = rt.list().filter((t) => isWatchPrompt(t.prompt)).map((t) => t.id);
    expect(r.content).toContain(ids[0]!);
    expect(r.content).toContain(URL_OK);
    expect(r.content.toLowerCase()).toContain("every 10m");
    expect(r.content).not.toContain("普通提醒");
    rt.stop();
  });

  it("watch_delete：id 直删 watch；删普通 cron 任务 id → typed 拒；未知 id → 拒", async () => {
    const rt = await createCronRuntime({ workspaceRoot: ws, sessionId: "s-w118-e", tickMs: 0 });
    const plain = await rt.createTask({ prompt: "普通提醒：喝水", schedule: { type: "interval", everyMs: 60 * MIN } });
    const tools = createWatchTools({ runtime: rt });
    const create = tools.find((t) => t.name === "watch_create")!;
    await create.execute({ url: URL_OK });
    const watchId = rt.list().find((t) => isWatchPrompt(t.prompt))!.id;
    const del = tools.find((t) => t.name === "watch_delete")!;
    const plainR = await del.execute({ id: plain.id });
    expect(plainR.isError).toBe(true);
    expect(rt.list().some((t) => t.id === plain.id)).toBe(true); // 未误删
    const unknown = await del.execute({ id: "zzzz9999" });
    expect(unknown.isError).toBe(true);
    const ok = await del.execute({ id: watchId });
    expect(ok.isError).toBeUndefined();
    expect(rt.list().some((t) => t.id === watchId)).toBe(false);
    rt.stop();
  });
});

// ---------------------------------------------------------------------------
// e2e — 确定性模型冒烟（m61-cron driver 夹具范式）：造 watch → tick 推进 →
// 注入轮里模型调假件 browser_open/browser_snapshot → 答案入历史带
// [scheduled task 前缀（105 投递软契约的拾取条件）→ 第二次 fire 无变化轮。
// ---------------------------------------------------------------------------
const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}
const allowAsk = async () => ({ kind: "allow" as const });

/** 记录式脚本模型（m61 范式）：捕获每个 ModelInput 供断言。 */
function recordingModel(responses: readonly AssistantMessage[]): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push({ ...input, messages: input.messages.map((m) => ({ ...m })) });
      const r = responses[i];
      i += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

/** 假件 browser 工具（记录调用；快照返回可对比的两版内容）。 */
function fakeBrowserTools(): { tools: Tool[]; openedUrls: string[]; snapshotCount: () => number } {
  const openedUrls: string[] = [];
  let snapshotCount = 0;
  const open: Tool = {
    name: "browser_open",
    description: "fake",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    isOpenWorld: () => true,
    async execute(input) {
      openedUrls.push(String(input["url"]));
      return { content: "Opened (fake)" };
    },
  };
  const snapshot: Tool = {
    name: "browser_snapshot",
    description: "fake",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    isOpenWorld: () => true,
    async execute() {
      snapshotCount += 1;
      return { content: "价格页：专业版 ¥99/月，企业版 ¥299/月（新增）" };
    },
  };
  return { tools: [open, snapshot], openedUrls, snapshotCount: () => snapshotCount };
}

describe("ω99-118 e2e — 盯看 fire → 注入轮 → 浏览器假件 → 答案入历史（105 前缀沿）", () => {
  it("造 watch → tick 到点 → [scheduled task 前缀注入 → 模型重开页面+快照 → 变化一句话入历史；第二 fire 无变化轮", async () => {
    const t0 = 1_800_000_000_000;
    let clock = t0;
    const rt = await createCronRuntime({ workspaceRoot: ws, sessionId: "s-w118-e2e", tickMs: 0, now: () => clock });
    const watchTools = createWatchTools({ runtime: rt, now: () => clock });
    const createR = await watchTools.find((t) => t.name === "watch_create")!.execute({ url: URL_OK, intervalMinutes: 5 });
    expect(createR.isError).toBeUndefined();
    const task = rt.list()[0]!;
    expect(task.schedule).toEqual({ type: "interval", everyMs: 5 * MIN });

    const fake = fakeBrowserTools();
    const ANSWER1 = "价格页新增了「企业版」套餐（¥299/月）。";
    const model = recordingModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "browser_open", arguments: { url: URL_OK } }] },
      { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "browser_snapshot", arguments: {} }] },
      { role: "assistant", content: ANSWER1 },
      { role: "assistant", content: "", toolCalls: [{ id: "c3", name: "browser_open", arguments: { url: URL_OK } }] },
      { role: "assistant", content: "无变化" },
    ]);
    const driver: AgentDriver = createAgentDriver({
      model,
      tools: fake.tools,
      systemPrompt: "sp",
      summarize: summarizeToolCall,
      onPermissionAsk: allowAsk,
      cron: rt,
    });
    await until(() => driver.getStatus().busy === false, "driver idle");

    // 推进 10 分钟（5 分钟间隔 + late-jitter ≤ min(30m, interval/2)=2.5m）→ due。
    clock = t0 + 10 * MIN;
    await rt.tick();
    await until(() => driver.getHistory().some((h) => h.kind === "user" && h.text.includes("【页面盯看】")), "first watch turn started");

    // 注入=普通 cron 注入形态：[scheduled task {id}] {模板 prompt}——105 的
    // 拾取条件（web 侧 SCHEDULED_TASK_LEAD 软契约同一字符串）。
    const injected = driver.getHistory().find((h) => h.kind === "user" && h.text.includes("【页面盯看】"));
    expect(injected?.text.startsWith("[scheduled task ")).toBe(true);
    expect(injected?.text).toContain(task.id);
    expect(injected?.text.endsWith(buildWatchPrompt(URL_OK))).toBe(true);

    await until(() => driver.getHistory().some((h) => h.kind === "assistant" && h.text.includes(ANSWER1)), "first answer landed");
    await until(() => driver.getStatus().busy === false, "first watch run finished");
    // 纪律①落地：模型重新打开了 url（不假设页面还开着）。
    expect(fake.openedUrls).toEqual([URL_OK]);
    expect(fake.snapshotCount()).toBe(1);
    expect(rt.list()[0]!.lastFiredAt).toBeDefined();

    // 第二次 fire：无变化轮——答案逐字「无变化」，注入同样带前缀。
    clock = t0 + 25 * MIN;
    await rt.tick();
    await until(() => driver.getHistory().filter((h) => h.kind === "user" && h.text.startsWith("[scheduled task ")).length === 2, "second watch injection");
    await until(() => driver.getHistory().some((h) => h.kind === "assistant" && h.text === "无变化"), "no-change answer landed");
    await until(() => driver.getStatus().busy === false, "second watch run finished");
    expect(fake.openedUrls).toEqual([URL_OK, URL_OK]); // 每 fire 各自重开

    rt.stop();
    driver.dispose();
  });
});
