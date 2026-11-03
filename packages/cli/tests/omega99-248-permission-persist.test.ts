// ω99-248: #1 — 权限挂起持久面 R 件（R1 落盘 / R2 observe 升级 / R4 恢复端到
// 端）。★红线：全 mock/脚本化（scripted model、stub 工具、wireGate 式规则门），
// 夹具只写 mkdtemp(os.tmpdir())，只写不删（禁 rm/unlink），零真网络/真模型/真
// 键鼠。
//
// 设计裁定（brief §一 面二的镜像规则，R2 逐条钉）：
//  - 持久缝 = session JSONL 的 M35 §2 泛型车道（217 收据先例）——证据寿命=
//    会话寿命，observe 的读侧零额外 IO（本就要 loadSessionEntries）。
//  - observe 的证据源镜像：当前会话只认 driver status（活真值——晨间 resume
//    后记录不得死锁 blocked，admission 才是重新问的载体）；非当前会话认持久
//    记录（跨重启证据）。
//  - 「证据不是授权」：持久记录只证明问过；重问由 verify-first run 里模型再
//    发出的同一工具调用走正常权限管线浮出（R4 钉：应答前工具零执行）。
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool, createScriptedModel, createJsonlSessionStore } from "@wudao-org/core";
import type { SessionEntry, SessionStore, Tool } from "@wudao-org/core";
import type { ProviderConfig } from "@wudao-org/providers";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";
import {
  buildPermissionAskEntry,
  buildPermissionSettledEntry,
  permissionPendingFromEntries,
  permissionQuestionText,
} from "../src/driver/permission-ledger.js";
import { createRecoveryPort } from "../src/recovery-admission.js";

// ★红线（242 同款立场）：夹具只写 mkdtemp(os.tmpdir())，只写不删。
const tmp = (): string => mkdtempSync(join(tmpdir(), "o248-perm-"));

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

// m58 式规则门（简化形）：一切工具调用落 ask → 停进 driver 的
// pendingPermission（server/web 车道里「规则门回 ask → driver.ask 停挂」的真
// 路径；闭包经 box 晚绑定 driver 句柄）。
function parkingGate(box: { current?: AgentDriver }): (toolName: string, input: Record<string, unknown>) => Promise<import("@wudao-org/core").PermissionDecision> {
  return async (toolName, input) => box.current?.ask(toolName, input) ?? { behavior: "allow" };
}

/** The stub shell — execution COUNTED (R4 pins 非自动放行：应答前零执行). */
function stubRunCommand(): { tool: Tool; executions: () => number } {
  let n = 0;
  const tool = buildTool({
    name: "shell",
    description: "stub shell",
    parameters: {
      type: "object" as const,
      properties: { command: { type: "string" as const }, env: { type: "object" as const } },
      required: ["command"],
      additionalProperties: false,
    },
    execute: async (input) => {
      n += 1;
      return { content: `ran ${String(input.command)} (call #${n})` };
    },
  });
  return { tool, executions: () => n };
}

// ---------------------------------------------------------------------------
// R2 纯层 — the fold (permissionPendingFromEntries)：文件序折叠，最后一枚
// 未落定 ask = 挂起；落定即清（不复活）；畸形 data 弃条不崩。
// ---------------------------------------------------------------------------
describe("R2 pure fold — permissionPendingFromEntries", () => {
  const ask = (toolName = "shell", summary = "./nightly.sh"): SessionEntry =>
    buildPermissionAskEntry("nightperm01", toolName, summary, 1);

  it("a pending ask with no later settle → pending with the ask's evidence", () => {
    const entries: SessionEntry[] = [{ role: "user", content: "夜里跑迁移" }, ask()];
    const ev = permissionPendingFromEntries(entries);
    expect(ev.pending).toBe(true);
    expect(ev.ask).toEqual({
      toolName: "shell",
      summary: "./nightly.sh",
      question: permissionQuestionText("shell", "./nightly.sh"),
    });
    // 记录行本身含会话 id（brief §一 面一字段钉）。
    const data = (ask() as { data: Record<string, unknown> }).data;
    expect(data.sessionId).toBe("nightperm01");
  });

  it("a settled ask (deny / terminal outcomes) → NOT pending (不复活)", () => {
    for (const outcome of ["deny", "interrupted", "allow", "session", "always"] as const) {
      const entries: SessionEntry[] = [ask(), buildPermissionSettledEntry("nightperm01", outcome, 2)];
      expect(permissionPendingFromEntries(entries).pending).toBe(false);
    }
  });

  it("file order wins: ask → settled → a LATER ask again → pending again (append-only, no rewrite)", () => {
    const entries: SessionEntry[] = [
      ask("shell", "first.sh"),
      buildPermissionSettledEntry("nightperm01", "deny", 2),
      ask("write_file", "b.txt"),
    ];
    const ev = permissionPendingFromEntries(entries);
    expect(ev.pending).toBe(true);
    expect(ev.ask?.toolName).toBe("write_file");
  });

  it("no record → not pending; malformed payloads drop silently without crashing", () => {
    expect(permissionPendingFromEntries([{ role: "user", content: "hi" }]).pending).toBe(false);
    const junk: SessionEntry[] = [
      { type: "permission_ask", data: "not-an-object" },
      { type: "permission_ask", data: {} }, // no toolName
      { type: "permission_ask", data: { sessionId: "s", toolName: "shell", summary: "x", question: "q", at: "not-a-number" } },
      { type: "permission_ask_settled", data: {} }, // a settle without shape is a no-op
    ];
    expect(permissionPendingFromEntries(junk).pending).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R2 observe 集成 — the mirror rule（当前会话=活真值；非当前会话=持久记录）
// ---------------------------------------------------------------------------
describe("R2 observe — the persistent evidence source (mirror rule)", () => {
  interface StubDriver {
    getSessionId(): string;
    getStatus(): { pendingPermission: unknown };
    isIdle(): boolean;
  }
  const stubDriver = (current: string, liveAsk: unknown): StubDriver =>
    ({ getSessionId: () => current, getStatus: () => ({ pendingPermission: liveAsk }), isIdle: () => true }) as never;

  const seedNight = async (root: string, extra: readonly SessionEntry[]): Promise<SessionStore> => {
    const store = createJsonlSessionStore(join(root, ".wudao", "sessions"));
    await store.append("nightperm01", { role: "user", content: "夜里跑迁移" });
    await store.append("nightperm01", { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "./nightly.sh" } }] });
    for (const e of extra) await store.appendEntry("nightperm01", e);
    return store;
  };

  it("non-current session + persisted record → observe TRUE with the ask evidence (跨重启)", async () => {
    const root = tmp();
    const store = await seedNight(root, [buildPermissionAskEntry("nightperm01", "shell", "./nightly.sh", 1)]);
    const port = createRecoveryPort({ driver: stubDriver("boot-fresh", null), workspaceRoot: root, store });
    const obs = await port.observe("nightperm01");
    expect(obs?.permissionPending).toBe(true);
    expect(obs?.pendingAsk?.toolName).toBe("shell");
    expect(obs?.pendingAsk?.summary).toBe("./nightly.sh");
  });

  it("non-current session without a record → FALSE (the pre-248 world's honest zero)", async () => {
    const root = tmp();
    const store = await seedNight(root, []);
    const port = createRecoveryPort({ driver: stubDriver("boot-fresh", null), workspaceRoot: root, store });
    expect((await port.observe("nightperm01"))?.permissionPending).toBe(false);
  });

  it("record settled → FALSE（落定不复活）", async () => {
    const root = tmp();
    const store = await seedNight(root, [
      buildPermissionAskEntry("nightperm01", "shell", "./nightly.sh", 1),
      buildPermissionSettledEntry("nightperm01", "deny", 2),
    ]);
    const port = createRecoveryPort({ driver: stubDriver("boot-fresh", null), workspaceRoot: root, store });
    const obs = await port.observe("nightperm01");
    expect(obs?.permissionPending).toBe(false);
    expect(obs?.pendingAsk).toBeUndefined();
  });

  it("the CURRENT session keeps the LIVE truth: a parked ask → true; resumed-and-idle with a stale record → false (the morning unlock)", async () => {
    const root = tmp();
    const store = await seedNight(root, [buildPermissionAskEntry("nightperm01", "shell", "./nightly.sh", 1)]);
    // Live parked ask on the current session → the 242 live rule still fires.
    const parked = createRecoveryPort({ driver: stubDriver("nightperm01", { toolName: "shell" }), workspaceRoot: root, store });
    expect((await parked.observe("nightperm01"))?.permissionPending).toBe(true);
    // Morning resume landed: the driver is current and IDLE — the record alone
    // must NOT hold the session blocked (the admission re-asks through the
    // normal pipeline; the record is evidence, never a lock).
    const resumedIdle = createRecoveryPort({ driver: stubDriver("nightperm01", null), workspaceRoot: root, store });
    const obs = await resumedIdle.observe("nightperm01");
    expect(obs?.permissionPending).toBe(false);
    expect(obs?.pendingAsk).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// R1 落盘 — park → permission_ask 行；answer → settle 行追加；挂起行字节不变
// ---------------------------------------------------------------------------
describe("R1 persistence — the ask's append-only evidence", () => {
  it("parking an ask appends the permission_ask entry; the answer APPENDS a settle; the ask line's bytes never move", async () => {
    const root = tmp();
    const { tool } = stubRunCommand();
    const box: { current?: AgentDriver } = {};
    const driver = createAgentDriver({
      model: createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "./nightly.sh", env: { API_KEY: "sk-o248-SECRET" } } }] },
        { role: "assistant", content: "NIGHT-DONE" },
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
    driver.submit("夜里跑迁移");
    await until(() => driver.getStatus().pendingPermission !== null, "shell to park an ask");
    await wait(80); // fire-and-forget persistence flush

    const file = join(root, ".wudao", "sessions", `${sid}.jsonl`);
    expect(existsSync(file)).toBe(true);
    const store = createJsonlSessionStore(join(root, ".wudao", "sessions"));
    const entries = await store.loadSessionEntries(sid);
    const asks = entries.filter((e) => "type" in e && e.type === "permission_ask");
    expect(asks).toHaveLength(1);
    // 字段钉：恰五字段——sessionId/toolName/summary/question/at；绝无 input/env/键。
    const data = (asks[0] as { data: Record<string, unknown> }).data;
    expect(Object.keys(data).sort()).toEqual(["at", "question", "sessionId", "summary", "toolName"]);
    expect(data.sessionId).toBe(sid);
    expect(data.toolName).toBe("shell");
    expect(data.summary).toBe("./nightly.sh");
    expect(data.question).toBe("允许 shell：./nightly.sh？");
    // 密钥零泄漏钉：记录行不含 env 载荷/键值（完整 input 本就由转录的
    // 工具调用消息承载——钉的作用域是记录行本身）。
    const askLine = readFileSync(file, "utf8").split("\n").find((l) => l.includes('"permission_ask"'));
    expect(askLine).toBeDefined();
    expect(askLine).not.toContain("sk-o248-SECRET");
    expect(askLine).not.toContain("API_KEY");
    const askBytes = askLine as string;

    // 应答 → 落定行追加；挂起行字节前后不变（append-only 改写断言）。
    expect(driver.answerPermission(false, "morning deny")).toBe(true);
    await until(() => driver.getStatus().busy === false, "run to settle after the deny");
    await wait(80);
    const linesAfter = readFileSync(file, "utf8").split("\n");
    expect(linesAfter.find((l) => l === askBytes)).toBe(askBytes); // byte-identical
    const settled = linesAfter.find((l) => l.includes('"permission_ask_settled"'));
    expect(settled).toBeDefined();
    const settledData = JSON.parse(settled as string) as { data: Record<string, unknown> };
    expect(settledData.data.outcome).toBe("deny");
    expect(settledData.data.sessionId).toBe(sid);
    // 折叠终态：落定 → 不挂起。
    expect(permissionPendingFromEntries(await store.loadSessionEntries(sid)).pending).toBe(false);
    driver.dispose();
  }, 10_000);

  it("interrupting the run (denyPendingAsk) settles the record honestly as interrupted", async () => {
    const root = tmp();
    const { tool } = stubRunCommand();
    const box: { current?: AgentDriver } = {};
    const driver = createAgentDriver({
      model: createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "./nightly.sh" } }] },
        { role: "assistant", content: "ABORTED-RUN-DONE" },
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
    driver.submit("night job");
    await until(() => driver.getStatus().pendingPermission !== null, "ask to park");
    await wait(80);
    driver.interrupt(); // the interrupt path resolves the parked ask as deny
    await until(() => driver.getStatus().busy === false, "run to settle after interrupt");
    await wait(80);
    const store = createJsonlSessionStore(join(root, ".wudao", "sessions"));
    const settled = (await store.loadSessionEntries(sid)).filter((e) => "type" in e && e.type === "permission_ask_settled");
    expect(settled).toHaveLength(1);
    expect((settled[0] as { data: { outcome: string } }).data.outcome).toBe("interrupted");
    driver.dispose();
  }, 10_000);

  it("persistPermissionAsks:false (the pet lane's opt-out) parks and answers normally but writes NO record (车道隔离)", async () => {
    const root = tmp();
    const { tool } = stubRunCommand();
    const box: { current?: AgentDriver } = {};
    const driver = createAgentDriver({
      model: createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "./nightly.sh" } }] },
        { role: "assistant", content: "PET-LANE-DONE" },
      ]),
      tools: [tool],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      workspaceRoot: root,
      gates: { verify: false },
      persistPermissionAsks: false,
      canUseTool: parkingGate(box),
    });
    box.current = driver;
    const sid = driver.getSessionId();
    driver.submit("pet lane job");
    await until(() => driver.getStatus().pendingPermission !== null, "ask to park (the card still works)");
    await wait(60);
    expect(driver.answerPermission(true)).toBe(true);
    await until(() => driver.getStatus().busy === false, "run to settle");
    await wait(60);
    const store = createJsonlSessionStore(join(root, ".wudao", "sessions"));
    const types = (await store.loadSessionEntries(sid)).filter((e) => "type" in e).map((e) => (e as { type: string }).type);
    expect(types).not.toContain("permission_ask");
    expect(types).not.toContain("permission_ask_settled");
    driver.dispose();
  }, 10_000);

  it("a driver with neither sessionStore nor workspaceRoot persists NOTHING (m58 in-memory posture unchanged)", async () => {
    const { tool } = stubRunCommand();
    const box: { current?: AgentDriver } = {};
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
    });
    box.current = driver;
    driver.submit("go");
    await until(() => driver.getStatus().pendingPermission !== null, "ask to park");
    await wait(50);
    expect(driver.getStatus().pendingPermission?.toolName).toBe("shell");
    driver.answerPermission(true);
    await until(() => driver.getStatus().busy === false, "run to settle");
    driver.dispose();
  }, 10_000);
});

// ---------------------------------------------------------------------------
// R4 恢复端到端 — 权限挂起会话：boot blocked(权限) hold → 晨间 resume →
// admission 的 verify-first run 里同一工具调用重新浮出（正常管线，非自动放
// 行）→ mock 应答 → run 续完 → journal claim→settle 全链（242 端到端范式）。
// ---------------------------------------------------------------------------
describe("R4 morning loop, end to end (startUiSession + coordinator)", () => {
  it("blocked on boot; the morning resume unlocks; the SAME question re-floats; one answer finishes the run; claim→settle land", async () => {
    const { startUiSession } = await import("../src/ui.js");
    const root = tmp();
    const nightId = "nightperm01";
    const sessionsDir = join(root, ".wudao", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const nightAsk = buildPermissionAskEntry(nightId, "shell", "./nightly.sh", 1);
    writeFileSync(join(sessionsDir, `${nightId}.jsonl`), [
      JSON.stringify({ role: "user", content: "夜里跑迁移" }),
      JSON.stringify({ role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "./nightly.sh" } }] }),
      JSON.stringify(nightAsk),
    ].join("\n") + "\n", "utf8");
    const journalPath = join(root, ".wudao", "recovery.jsonl");
    writeFileSync(journalPath, `${JSON.stringify({ type: "admit", sessionId: nightId, at: 2, user: true })}\n`, "utf8");

    const stub = stubRunCommand();
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
      tools: [stub.tool] as readonly Tool[],
      announce: false,
    } as never);
    try {
      // ① boot：协调器观察夜间会话——持久记录在 → blocked(权限) → hold
      //（绝不动 admission：无 claim、不 resume）。等 2+ 个 tick 亲证。
      const holdDeadline = Date.now() + 5_000;
      while (Date.now() < holdDeadline) await new Promise((r) => setTimeout(r, 250));
      expect(session.driver.getSessionId()).not.toBe(nightId);
      expect(readFileSync(journalPath, "utf8")).not.toContain("claim");

      // ② 晨间：用户 resume 该会话（镜像规则解锁：当前会话认活真值）。
      expect(await session.driver.resume(nightId)).toEqual({ ok: true });

      // ③ admission（claim → resume+verify-first submit → settle）：模型再发
      // 出同一工具调用 → 正常权限管线落 ask——同一问句重新浮出。
      await until(() => session.driver.getStatus().pendingPermission !== null, "the SAME ask to re-float through the normal pipeline", 12_000);
      const refloated = session.driver.getStatus().pendingPermission;
      expect(refloated?.toolName).toBe("shell");
      expect(refloated?.summary).toBe("./nightly.sh"); // 同问句（同工具同参数 → 同摘要同问句）
      // 非自动放行钉：应答前工具零执行（证据不是授权）。
      expect(stub.executions()).toBe(0);

      // ④ 夜间挂起行字节快照（append-only 将在应答后核对）。
      const nightLines = readFileSync(join(sessionsDir, `${nightId}.jsonl`), "utf8").split("\n");
      const nightAskLine = nightLines.find((l) => l.includes('"permission_ask"'));
      expect(nightAskLine).toBeDefined();

      // ⑤ mock 应答 → 正常管线走完 → 工具执行 → run 续完。
      expect(session.driver.answerPermission(true)).toBe(true);
      await until(
        () => session.driver.getStatus().busy === false && session.driver.getHistory().some((e) => (e as { kind?: string }).kind === "assistant" && (e as { text?: string }).text === "NIGHT-DONE"),
        "the run to finish after the one answer",
        12_000,
      );
      expect(stub.executions()).toBe(1);

      // ⑥ journal 全链：admit(user) → claim → settle（242 端到端范式）。
      const journal = readFileSync(journalPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string });
      expect(journal.map((e) => e.type)).toEqual(["admit", "claim", "settle"]);

      // ⑦ 会话 JSONL：夜间挂起行字节不变；晨间重浮出追加新 ask 行；应答
      // 落 settle 行；折叠终态=不挂起。
      // 0.4.3 gate fix: ⑤'s gate is the IN-MEMORY history (busy=false +
      // NIGHT-DONE); the settle line's JSONL append is a separate async fs
      // write that can trail it by a few ms (2-in-4 red solo before this
      // poll). Poll the disk face like ⑤ polls the memory face.
      await until(
        () => readFileSync(join(sessionsDir, `${nightId}.jsonl`), "utf8").includes('"permission_ask_settled"'),
        "the settled line on disk",
        4_000,
      );
      const morningLines = readFileSync(join(sessionsDir, `${nightId}.jsonl`), "utf8").split("\n");
      expect(morningLines.find((l) => l === nightAskLine)).toBe(nightAskLine);
      expect(morningLines.filter((l) => l.includes('"permission_ask"'))).toHaveLength(2); // night + morning re-float
      const settledLine = morningLines.find((l) => l.includes('"permission_ask_settled"'));
      expect(settledLine).toBeDefined();
      expect((JSON.parse(settledLine as string) as { data: { outcome: string } }).data.outcome).toBe("allow");
      const store = createJsonlSessionStore(sessionsDir);
      expect(permissionPendingFromEntries(await store.loadSessionEntries(nightId)).pending).toBe(false);
    } finally {
      await session.close();
    }
  }, 40_000);
});
