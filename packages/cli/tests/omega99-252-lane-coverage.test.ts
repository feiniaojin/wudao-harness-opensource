// ω99-252: #1 — 权限证据车道全化 R 件 + verify-first 重发引导逐字钉。★红线：
// 全 mock（scripted model、stub 工具、parkingGate 规则门、手动 resolve 的
// onPermissionAsk＝TUI 弹窗替身），夹具只写 mkdtemp(os.tmpdir())，只写不删（禁
// rm/unlink），零真网络/真模型/真键鼠。
//
// 设计裁定（brief §一，侦察结论）：
//  - 证据 = 「正在问」的事实，不是 UI 状态：askPermission 规则门回 ask 时，
//    无论 onPermissionAsk 在场与否，permission_ask 五字段行都先落盘，然后才走
//    停挂或前端回调（车道全化）。
//  - TUI 应答不走 answerPermission——它经回调返回值回到 askPermission 内部，
//    settle 追加缝=回调 await 返回处（两路各自收束，改动面最小）。
//  - 弹窗取消语义（侦察后钉）：Ink PermissionPrompt 没有「无应答消失」路径——
//    Esc/Enter/Ctrl+C 全部是真应答 {kind:"deny"}；driver.interrupt()/dispose 走
//    denyPendingAsk，证据全化后该缝对 TUI 形 ask 也落 interrupted settle（弹窗
//    期间进程被杀=行独立幸存，正是晨间证据）。
//  - pet 车道隔离不破：persistPermissionAsks:false 的守卫在 askLedger 内部，
//    与走哪条分支无关（R1 复钉——pet 卡即答=onPermissionAsk 形）。
//  - M24 判定（R3 记档）：恢复模板是每 run 现构造的全新 user turn（resume 边界
//    冷转已由 242 声明），加句=恢复 run 自身一次性字节，无稳定前缀冷转代价。
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool, createScriptedModel, createJsonlSessionStore } from "@wudao/core";
import type { Tool } from "@wudao/core";
import type { ProviderConfig } from "@wudao/providers";
import { summarizeToolCall } from "../src/log.js";
import type { AskAnswer } from "../src/permission.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";
import { permissionPendingFromEntries } from "../src/driver/permission-ledger.js";
import { buildRecoveryPrompt } from "../src/recovery-admission.js";
import type { MissionState, MissionTask } from "../src/mission.js";

// ★红线（248 同款立场）：夹具只写 mkdtemp(os.tmpdir())，只写不删。
const tmp = (): string => mkdtempSync(join(tmpdir(), "o252-lane-"));

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

// m58 式规则门（248 同款）：一切工具调用落 ask → driver.ask。
function parkingGate(box: { current?: AgentDriver }): (toolName: string, input: Record<string, unknown>) => Promise<import("@wudao/core").PermissionDecision> {
  return async (toolName, input) => box.current?.ask(toolName, input) ?? { behavior: "allow" };
}

/** The stub shell — execution COUNTED（应答前零执行的钉用）。 */
function stubRunCommand(): { tool: Tool; executions: () => number } {
  let n = 0;
  const tool = buildTool({
    name: "shell",
    description: "stub shell",
    parameters: {
      type: "object" as const,
      // NOTE (侦察发现): core 的 matchesType 没有 "object" 臂——声明
      // type:"object" 的参数恒校验失败（248 的同款 stub 只走 deny 路径从未
      // 执行故未暴露）。env 留为未声明参数（additionalProperties 非 false
      // 即放行）——本弧工具真正执行，钉的是证据车道不是校验器。
      properties: { command: { type: "string" as const } },
      required: ["command"],
    },
    execute: async (input) => {
      n += 1;
      return { content: `ran ${String(input.command)} (call #${n})` };
    },
  });
  return { tool, executions: () => n };
}

/** The TUI-lane ask seam's test double: the dialog "opens" (the callback parks
 *  its resolver in the box) and answers only when the test resolves it — the
 *  real Ink prompt's promise shape without the keyboard. */
type DialogBox = { current: ((answer: AskAnswer) => void) | null };
const tuiAsk = (box: DialogBox, seen: { toolName: string; summary: string }[] = []) =>
  (toolName: string, summary: string): Promise<AskAnswer> =>
    new Promise((resolve) => {
      seen.push({ toolName, summary });
      // 应答即清空（连续两次 ask 时，第二次 until 等的是新弹窗不是旧句柄）。
      box.current = (answer: AskAnswer): void => {
        box.current = null;
        resolve(answer);
      };
    });

const askLines = (root: string, sid: string): string[] => {
  const file = join(root, ".wudao", "sessions", `${sid}.jsonl`);
  return existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
};

// ---------------------------------------------------------------------------
// R1 — TUI 车道证据：ask 行落盘（五字段钉）/ 应答 settle / 弹窗期间中断 →
// interrupted settle / pet 车道隔离（onPermissionAsk 形复钉）/ 无 store 内存驱动。
// ---------------------------------------------------------------------------
describe("R1 TUI-lane evidence — the ask line lands while the dialog is open", () => {
  it("onPermissionAsk present: the ask lands in the JSONL (five fields, no secrets); the answer settles; the ask bytes never move", async () => {
    const root = tmp();
    const { tool, executions } = stubRunCommand();
    const box: { current?: AgentDriver } = {};
    const dialog: DialogBox = { current: null };
    const seen: { toolName: string; summary: string }[] = [];
    const driver = createAgentDriver({
      model: createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "./nightly.sh", env: { API_KEY: "sk-o252-SECRET" } } }] },
        { role: "assistant", content: "TUI-LANE-DONE" },
      ]),
      tools: [tool],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      workspaceRoot: root,
      gates: { verify: false },
      canUseTool: parkingGate(box),
      onPermissionAsk: tuiAsk(dialog, seen),
    });
    box.current = driver;
    const sid = driver.getSessionId();
    driver.submit("夜间 TUI 任务");
    await until(() => dialog.current !== null, "the TUI dialog to open");
    await wait(80); // fire-and-forget persistence flush

    // 弹窗开着（回调未返回）——证据行已经落盘（证据=「正在问」的事实，不是
    // UI 状态）。TUI 车道不停挂：pendingPermission 恒 null。
    expect(seen).toEqual([{ toolName: "shell", summary: "./nightly.sh" }]);
    expect(driver.getStatus().pendingPermission).toBe(null);
    expect(executions()).toBe(0); // 应答前工具零执行（证据不是授权）
    const file = join(root, ".wudao", "sessions", `${sid}.jsonl`);
    expect(existsSync(file)).toBe(true);
    const asks = (await createJsonlSessionStore(join(root, ".wudao", "sessions")).loadSessionEntries(sid))
      .filter((e) => "type" in e && e.type === "permission_ask");
    expect(asks).toHaveLength(1);
    // 五字段钉：恰 sessionId/toolName/summary/question/at；绝无 input/env/键。
    const data = (asks[0] as { data: Record<string, unknown> }).data;
    expect(Object.keys(data).sort()).toEqual(["at", "question", "sessionId", "summary", "toolName"]);
    expect(data.sessionId).toBe(sid);
    expect(data.toolName).toBe("shell");
    expect(data.summary).toBe("./nightly.sh");
    expect(data.question).toBe("允许 shell：./nightly.sh？");
    const askBytes = askLines(root, sid).find((l) => l.includes('"permission_ask"')) as string;
    expect(askBytes).not.toContain("sk-o252-SECRET");
    expect(askBytes).not.toContain("API_KEY");

    // 应答（回调返回）→ settle 行追加（kind 钉）；挂起行字节前后不变。
    dialog.current({ kind: "allow" });
    await until(
      () => driver.getStatus().busy === false && driver.getHistory().some((e) => (e as { kind?: string }).kind === "assistant" && (e as { text?: string }).text === "TUI-LANE-DONE"),
      "the run to finish after the TUI answer",
    );
    expect(executions()).toBe(1);
    await wait(80);
    const after = askLines(root, sid);
    expect(after.find((l) => l === askBytes)).toBe(askBytes); // byte-identical
    const settled = after.find((l) => l.includes('"permission_ask_settled"'));
    expect(settled).toBeDefined();
    const settledData = JSON.parse(settled as string) as { data: Record<string, unknown> };
    expect(settledData.data.outcome).toBe("allow");
    expect(settledData.data.sessionId).toBe(sid);
    expect(permissionPendingFromEntries(await createJsonlSessionStore(join(root, ".wudao", "sessions")).loadSessionEntries(sid)).pending).toBe(false);
    driver.dispose();
  }, 10_000);

  it("a session answer settles as session; a deny settles as deny（kind 映射钉）", async () => {
    const root = tmp();
    const { tool } = stubRunCommand();
    const box: { current?: AgentDriver } = {};
    const dialog: DialogBox = { current: null };
    const driver = createAgentDriver({
      model: createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "./a.sh" } }] },
        { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "shell", arguments: { command: "./b.sh" } }] },
        { role: "assistant", content: "BOTH-SETTLED" },
      ]),
      tools: [tool],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      workspaceRoot: root,
      gates: { verify: false },
      canUseTool: parkingGate(box),
      onPermissionAsk: tuiAsk(dialog),
    });
    box.current = driver;
    const sid = driver.getSessionId();
    driver.submit("two asks");
    await until(() => dialog.current !== null, "first dialog");
    dialog.current({ kind: "session" });
    await until(() => dialog.current !== null, "second dialog (the session answer un-parks the run)");
    dialog.current({ kind: "deny", reason: "不要" });
    await until(
      () => driver.getStatus().busy === false && driver.getHistory().some((e) => (e as { kind?: string }).kind === "assistant" && (e as { text?: string }).text === "BOTH-SETTLED"),
      "the run to finish",
    );
    await wait(80);
    const outcomes = askLines(root, sid)
      .filter((l) => l.includes('"permission_ask_settled"'))
      .map((l) => (JSON.parse(l) as { data: { outcome: string } }).data.outcome);
    expect(outcomes).toEqual(["session", "deny"]);
    driver.dispose();
  }, 10_000);

  it("interrupting while the dialog is open settles the record honestly as interrupted；a LATE dialog answer adds NO second settle", async () => {
    const root = tmp();
    const { tool } = stubRunCommand();
    const box: { current?: AgentDriver } = {};
    const dialog: DialogBox = { current: null };
    const driver = createAgentDriver({
      model: createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "./nightly.sh" } }] },
        { role: "assistant", content: "ABORTED-LANE-DONE" },
      ]),
      tools: [tool],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      workspaceRoot: root,
      gates: { verify: false },
      canUseTool: parkingGate(box),
      onPermissionAsk: tuiAsk(dialog),
    });
    box.current = driver;
    const sid = driver.getSessionId();
    driver.submit("night tui job");
    await until(() => dialog.current !== null, "the dialog to open");
    await wait(80);
    driver.interrupt(); // 弹窗期间中断 → denyPendingAsk 缝落 interrupted settle
    await until(() => askLines(root, sid).some((l) => l.includes('"permission_ask_settled"') && (JSON.parse(l) as { data: { outcome: string } }).data.outcome === "interrupted"), "the interrupted settle to land");
    // 迟到的弹窗应答（真进程里=对话框被收掉）——run 解缠，但绝不双写 settle。
    dialog.current({ kind: "deny" });
    await until(() => driver.getStatus().busy === false, "the aborted run to unwind");
    await wait(80);
    const settles = askLines(root, sid).filter((l) => l.includes('"permission_ask_settled"'));
    expect(settles).toHaveLength(1);
    expect((JSON.parse(settles[0] as string) as { data: { outcome: string } }).data.outcome).toBe("interrupted");
    driver.dispose();
  }, 10_000);

  it("persistPermissionAsks:false with onPermissionAsk present (the pet lane's REAL shape) → zero record lines（车道隔离复钉）", async () => {
    const root = tmp();
    const { tool } = stubRunCommand();
    const box: { current?: AgentDriver } = {};
    const dialog: DialogBox = { current: null };
    const driver = createAgentDriver({
      model: createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "./pet.sh" } }] },
        { role: "assistant", content: "PET-TUI-DONE" },
      ]),
      tools: [tool],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      workspaceRoot: root,
      gates: { verify: false },
      persistPermissionAsks: false,
      canUseTool: parkingGate(box),
      onPermissionAsk: tuiAsk(dialog),
    });
    box.current = driver;
    const sid = driver.getSessionId();
    driver.submit("pet lane job");
    await until(() => dialog.current !== null, "the pet card ask to open");
    dialog.current({ kind: "allow" });
    await until(() => driver.getStatus().busy === false, "run to settle");
    await wait(80);
    const types = (await createJsonlSessionStore(join(root, ".wudao", "sessions")).loadSessionEntries(sid))
      .filter((e) => "type" in e).map((e) => (e as { type: string }).type);
    expect(types).not.toContain("permission_ask");
    expect(types).not.toContain("permission_ask_settled");
    driver.dispose();
  }, 10_000);

  it("no store and no workspaceRoot (m58 in-memory posture, TUI form) → zero persistence, zero crash", async () => {
    const { tool } = stubRunCommand();
    const box: { current?: AgentDriver } = {};
    const dialog: DialogBox = { current: null };
    const driver = createAgentDriver({
      model: createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "x" } }] },
        { role: "assistant", content: "DONE" },
      ]),
      tools: [tool],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      gates: { verify: false },
      canUseTool: parkingGate(box),
      onPermissionAsk: tuiAsk(dialog),
    });
    box.current = driver;
    driver.submit("go");
    await until(() => dialog.current !== null, "the dialog to open");
    dialog.current({ kind: "allow" });
    await until(() => driver.getStatus().busy === false, "run to settle");
    driver.dispose(); // 到这里零崩=钉（无 root 时 askLedger 是 no-op）
  }, 10_000);
});

// ---------------------------------------------------------------------------
// R2 — 停挂车道零演进（锚点用例；248 全 13 测在 solo 清单复跑）：park → 落盘 →
// answerPermission → settle，语义与 248 同字节。
// ---------------------------------------------------------------------------
describe("R2 park-lane anchor — 248's server/web seam is unchanged", () => {
  it("parking still parks (no onPermissionAsk): ask line → answerPermission → settle; bytes never move", async () => {
    const root = tmp();
    const { tool } = stubRunCommand();
    const box: { current?: AgentDriver } = {};
    const driver = createAgentDriver({
      model: createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "./park.sh" } }] },
        { role: "assistant", content: "PARK-DONE" },
      ]),
      tools: [tool],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      workspaceRoot: root,
      gates: { verify: false },
      canUseTool: parkingGate(box),
    });
    box.current = driver;
    const sid = driver.getSessionId();
    driver.submit("park lane job");
    await until(() => driver.getStatus().pendingPermission !== null, "the ask to park");
    await wait(80);
    const askBytes = askLines(root, sid).find((l) => l.includes('"permission_ask"')) as string;
    expect(askBytes).toBeDefined();
    expect(driver.answerPermission(true)).toBe(true);
    await until(() => driver.getStatus().busy === false, "run to settle");
    await wait(80);
    const after = askLines(root, sid);
    expect(after.find((l) => l === askBytes)).toBe(askBytes);
    const settled = after.find((l) => l.includes('"permission_ask_settled"'));
    expect((JSON.parse(settled as string) as { data: { outcome: string } }).data.outcome).toBe("allow");
    driver.dispose();
  }, 10_000);
});

// ---------------------------------------------------------------------------
// R3 — verify-first 重发引导句：逐字钉；既有 242 句零演进（演进行恰=新增句）；
// M24 判定记档（模板=每 run 现构造的恢复 user turn，见文件头注）。
// ---------------------------------------------------------------------------
describe("R3 the resend guidance sentence (verify-first template)", () => {
  const GUIDANCE = "上一轮被权限挡住的工具调用请原样重发，授权问句会自动浮出；不要改为口头描述或跳过。";
  const OLD_TAIL = "请先检查会话与工作区，确认上面「已完成」的部分真实在盘；保留已完成的工作，不要重复已产生副作用的操作；只完成剩余部分。无法确认某一步是否已执行时，停下来问我，不要猜。";

  it("contains the guidance sentence verbatim (both forms — with and without receipts)", () => {
    const withReceipts = buildRecoveryPrompt(["改动 2 文件：src/a.ts（修改）"], "任务 t9（收尾）");
    expect(withReceipts).toContain(GUIDANCE);
    const noReceipts = buildRecoveryPrompt([], "继续完成夜间批处理任务");
    expect(noReceipts).toContain(GUIDANCE);
  });

  it("existing 242 sentences are byte-identical; the diff is EXACTLY one new line (the guidance, last)", () => {
    const p = buildRecoveryPrompt([], "继续完成夜间批处理任务");
    const lines = p.split("\n");
    // 242 无收据形=3 行（首句/待续/尾句）——演进后恰 4 行，新增行=引导句。
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("继续之前的任务。上一进程在执行中中断，我已按会话记录对账：");
    expect(lines[1]).toBe("待续：继续完成夜间批处理任务");
    expect(lines[2]).toBe(OLD_TAIL);
    expect(lines[3]).toBe(GUIDANCE);
    // 引导句恰一次（不重复注入）。
    expect(p.split(GUIDANCE).length - 1).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// R5 — goal settle 缝（249）与本弧 settle 追加共存：同一条 run 的两份收据各自
// 恰一次（不同缝——askPermission 收束缝 vs run 完成收据缝——亲证不双写）。
// ---------------------------------------------------------------------------
describe("R5 goal-settle coexistence — one permission settle AND one goal settle per run", () => {
  it("a TUI-lane run with a budgeted doing task settles both receipts exactly once each", async () => {
    const root = tmp();
    const { tool } = stubRunCommand();
    const box: { current?: AgentDriver } = {};
    const dialog: DialogBox = { current: null };
    const t = (id: string, over: Partial<MissionTask> = {}): MissionTask => ({ id, title: `任务 ${id}`, dependsOn: [], status: "todo", attempts: 0, ...over });
    const mission: MissionState = {
      id: "m1",
      objective: "完成发布",
      createdAt: "2026-09-10T00:00:00.000Z",
      status: "active",
      tasks: [t("t1", { status: "doing", budgetTokens: 5000 })],
    };
    const driver = createAgentDriver({
      model: createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "./goal.sh" } }] },
        { role: "assistant", content: "GOAL-COEXIST-DONE" },
      ]),
      tools: [tool],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      workspaceRoot: root,
      gates: { verify: false },
      canUseTool: parkingGate(box),
      onPermissionAsk: tuiAsk(dialog),
      missionBox: { current: { snapshot: () => mission } } as never,
    });
    box.current = driver;
    const sid = driver.getSessionId();
    driver.submit("goal coexistence job");
    await until(() => dialog.current !== null, "the dialog to open");
    dialog.current({ kind: "allow" });
    await until(
      () => driver.getStatus().busy === false && driver.getHistory().some((e) => (e as { kind?: string }).kind === "assistant" && (e as { text?: string }).text === "GOAL-COEXIST-DONE"),
      "the run to finish",
    );
    await wait(120); // both fire-and-forget lanes flush
    const entries = await createJsonlSessionStore(join(root, ".wudao", "sessions")).loadSessionEntries(sid);
    const types = entries.filter((e) => "type" in e).map((e) => (e as { type: string }).type);
    // 权限收据：恰一问一答（本弧缝，恰一次）。
    expect(types.filter((x) => x === "permission_ask")).toHaveLength(1);
    expect(types.filter((x) => x === "permission_ask_settled")).toHaveLength(1);
    // goal 收据（249 缝）：物化一行 + 轮界结算一行，恰两次转移（不双写）。
    expect(types.filter((x) => x === "goal_state")).toHaveLength(2);
    driver.dispose();
  }, 10_000);
});

// ---------------------------------------------------------------------------
// R4 — 端到端（TUI 形夜间车道）：TUI ask 落盘 → 进程崩溃（行幸存无 settle）→
// 晨间 observe blocked(权限) → resume → admission 的 verify-first run（模板含
// 引导句）→ scripted model 重发同调用 → 问句重浮（正常管线）→ 一答 → run 续完
// → journal admit→claim→settle（248 R4 的 TUI 车道版）。
// ---------------------------------------------------------------------------
describe("R4 morning loop, TUI night lane, end to end", () => {
  it("the TUI-lane ask survives the crash as morning evidence; the verify-first prompt carries the guidance; one answer finishes the run", async () => {
    const root = tmp();
    const sessionsDir = join(root, ".wudao", "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    // —— 夜间：真引擎装配 + 永不解析的 askRelay（TUI/Slack 形车道——ask 经
    // onPermissionAsk 回调而非停挂；引擎的预派发持久化缝把 user turn 和
    // tool-carrying assistant 先落盘，与真进程一致）——
    const { createDriverSession } = await import("../src/driver/session-engine.js");
    const nightConfig: ProviderConfig = { apiKey: "k", baseURL: "http://127.0.0.1:1/v1", model: "fake" };
    const nightStub = stubRunCommand();
    const nightSession = await createDriverSession({
      config: nightConfig,
      workspaceRoot: root,
      contextWindowTokens: 64000,
      modelOverride: createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "./nightly.sh" } }] },
      ]),
      tools: [nightStub.tool] as readonly Tool[],
      // The dialog that never resolves: the process dies with it open. The
      // relayed ask must have landed its evidence line by then.
      askRelay: (): Promise<AskAnswer> => new Promise<AskAnswer>(() => {}),
    });
    const nightId = nightSession.driver.getSessionId();
    nightSession.driver.submit("夜里跑迁移");
    await until(
      () => askLines(root, nightId).some((l) => l.includes('"permission_ask"') && l.includes("shell")),
      "the TUI-lane ask line to land while the relay dialog is open",
      8000,
    );
    await wait(150); // the transcript's pre-dispatch prefix + ask line settle
    // 弹窗开着、证据行已落盘——这就是 TUI 车道的崩溃前状态；工具零执行。
    const nightAskBytes = askLines(root, nightId).find((l) => l.includes('"permission_ask"'));
    expect(nightAskBytes).toBeDefined();
    expect(nightStub.executions()).toBe(0);
    // 转录持久化钉：预派发屏障已把 user turn + tool-carrying assistant 落在
    // ask 行之前（半轮证据——晨间分类器的输入面）。
    const nightPrefix = askLines(root, nightId).filter((l) => l.trim() !== "" && !l.includes("wudao_meta"));
    expect(nightPrefix.length).toBeGreaterThanOrEqual(3); // user + assistant(toolCalls) + permission_ask
    // —— 崩溃：不答、不 close（kill -9 的诚实模拟：进程没机会收尾）——
    // 夜间行独立幸存，无 settle。

    // —— 晨间：协调器 boot（journal 已有 admit(user)，248 R4 同款）——
    const journalPath = join(root, ".wudao", "recovery.jsonl");
    writeFileSync(journalPath, `${JSON.stringify({ type: "admit", sessionId: nightId, at: 2, user: true })}\n`, "utf8");

    const { startUiSession } = await import("../src/ui.js");
    const morningStub = stubRunCommand();
    const config: ProviderConfig = { apiKey: "k", baseURL: "http://127.0.0.1:1/v1", model: "fake" };
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "m1", name: "shell", arguments: { command: "./nightly.sh" } }] }, // the re-issue
      { role: "assistant", content: "NIGHT-DONE" }, // the continuation completes
    ]);
    const session = await startUiSession({
      config,
      workspaceRoot: root,
      contextWindowTokens: 64000,
      modelOverride: model,
      tools: [morningStub.tool] as readonly Tool[],
      announce: false,
    } as never);
    try {
      // ① boot：协调器观察夜间会话——TUI 车道落的记录在 → blocked(权限) → hold
      //（绝不动 admission：无 claim、不 resume）。等 2+ 个 tick 亲证。
      const holdDeadline = Date.now() + 5_000;
      while (Date.now() < holdDeadline) await new Promise((r) => setTimeout(r, 250));
      expect(session.driver.getSessionId()).not.toBe(nightId);
      expect(readFileSync(journalPath, "utf8")).not.toContain("claim");

      // ② 晨间：用户 resume 该会话（镜像规则解锁：当前会话认活真值）。
      expect(await session.driver.resume(nightId)).toEqual({ ok: true });

      // ③ admission（claim → resume+verify-first submit → settle）：模型再发
      // 同一工具调用 → 正常权限管线落 ask——同一问句重新浮出（晨间车道停挂）。
      await until(() => session.driver.getStatus().pendingPermission !== null, "the SAME ask to re-float through the normal pipeline", 12_000);
      const refloated = session.driver.getStatus().pendingPermission;
      expect(refloated?.toolName).toBe("shell");
      expect(refloated?.summary).toBe("./nightly.sh");
      expect(morningStub.executions()).toBe(0); // 应答前工具零执行

      // ④ verify-first 模板已注入（resume 后的恢复 user turn）且含引导句。
      const promptLine = askLines(root, nightId).find((l) => l.includes("继续之前的任务"));
      expect(promptLine).toBeDefined();
      expect(decodeMaybe(promptLine as string)).toContain("上一轮被权限挡住的工具调用请原样重发，授权问句会自动浮出；不要改为口头描述或跳过。");

      // ⑤ 夜间行字节快照（append-only 将在应答后核对）。
      const nightLines = askLines(root, nightId);

      // ⑥ mock 应答 → run 续完。
      expect(session.driver.answerPermission(true)).toBe(true);
      await until(
        () => session.driver.getStatus().busy === false && session.driver.getHistory().some((e) => (e as { kind?: string }).kind === "assistant" && (e as { text?: string }).text === "NIGHT-DONE"),
        "the run to finish after the one answer",
        12_000,
      );
      expect(morningStub.executions()).toBe(1);

      // ⑦ journal 全链：admit(user) → claim → settle。
      const journal = readFileSync(journalPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string });
      expect(journal.map((e) => e.type)).toEqual(["admit", "claim", "settle"]);

      // ⑧ 会话 JSONL：夜间 TUI 行字节不变；晨间重浮出追加新 ask 行；应答落
      // settle 行；折叠终态=不挂起。
      // 回滚重做 T2c：应答后的 settle 行由异步会话写入器落盘，可能晚于
      // busy=false 的 run 终态（暖机盒全量第 3 轮复现，solo 全绿；前两轮
      // 全量此测试皆绿——纯时序窗）。按仓库条件等待惯例等它落盘再读快照；
      // 断言不弱化：写入器真丢行时轮询超时，测试照红。
      await until(
        () => askLines(root, nightId).some((l) => l.includes('"permission_ask_settled"')),
        "the settled line to land in the session JSONL",
        5_000,
      );
      const morningLines = askLines(root, nightId);
      expect(morningLines.find((l) => l === nightAskBytes)).toBe(nightAskBytes);
      expect(morningLines.filter((l) => l.includes('"permission_ask"'))).toHaveLength(2); // night + morning re-float
      const settledLine = morningLines.find((l) => l.includes('"permission_ask_settled"'));
      expect(settledLine).toBeDefined();
      expect((JSON.parse(settledLine as string) as { data: { outcome: string } }).data.outcome).toBe("allow");
      expect(nightLines).toBeDefined();
      expect(permissionPendingFromEntries(await createJsonlSessionStore(sessionsDir).loadSessionEntries(nightId)).pending).toBe(false);
    } finally {
      await session.close();
    }
  }, 40_000);
});

/** The JSONL line's content may ride escaped bytes — normalize for a contains
 *  check without parsing the whole message shape. */
function decodeMaybe(line: string): string {
  try {
    const parsed = JSON.parse(line) as { content?: unknown };
    if (typeof parsed.content === "string") return parsed.content;
  } catch {
    /* not JSON or not a message — return the raw line */
  }
  return line;
}
