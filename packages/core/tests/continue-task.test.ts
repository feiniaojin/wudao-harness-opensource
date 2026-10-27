// 127 项 1 — continue_task 工具面测试：baton 文件写入+结构（头注释/状态节/
// 指针节/链史）、schedule 创建（at 一次性 + origin resume 车道 + createdFrom
// 章）、幂等拒（同 task_id 已有 pending 火）、回执文案、参数校验（fail-closed
// typed doors）、活跃链帽、第二棒（链史 append + hops 递增 + createdAt 保持）。
// 纯层（渲染/解析/匹配）同文件钉住。设计：docs/research/127-cross-session-chaining.md §3。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createContinueTaskTool,
  taskChainBatonPath,
  parseTaskChainHeader,
  parseTaskChainHistory,
  renderTaskChainBaton,
  taskChainHistoryLine,
  continueTaskPrompt,
  continueTaskContextHint,
  continueTaskPromptMatch,
  HANDOFF_MAX_CHARS,
  CONTINUE_TASK_DEFAULT_DELAY_SECONDS,
  CONTINUE_TASK_ACTIVE_CHAIN_CAP,
  CONTINUE_TASK_CREATED_FROM,
} from "../src/tools/continue-task.js";
import type { ContinueTaskPendingRow, ContinueTaskScheduleInput } from "../src/tools/continue-task.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "continue-task-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

const T0 = Date.parse("2026-09-27T12:00:00Z");
const SID = "wudao-live7a";

/** The scripted daemon face: records adds, reports the given pending rows. */
const faceOf = (rows: ContinueTaskPendingRow[] = [], opts: { readonly addReceipt?: string } = {}) => {
  const adds: ContinueTaskScheduleInput[] = [];
  return {
    adds,
    face: {
      add: async (input: ContinueTaskScheduleInput) => {
        adds.push(input);
        return opts.addReceipt ?? "📅 持久任务 zzz00001 已添加（2026-09-27T12:00:30.000Z）";
      },
      list: () => rows,
    },
  };
};

const rowOf = (taskId: string, over: Partial<ContinueTaskPendingRow> = {}): ContinueTaskPendingRow => ({
  id: "zzz00001",
  createdFrom: CONTINUE_TASK_CREATED_FROM,
  prompt: continueTaskPrompt(taskId),
  schedule: { type: "at", at: T0 + 60_000 },
  nextRunAt: T0 + 60_000,
  ...over,
});

const toolOf = (face: ReturnType<typeof faceOf>["face"], sid: string = SID) =>
  createContinueTaskTool({ workspaceRoot: ws, face, sessionId: () => sid, now: () => T0 });

const batonText = async (): Promise<string> => readFile(taskChainBatonPath(ws, "abcd0001"), "utf8");

describe("pure layer — baton render/parse", () => {
  it("renders and re-parses the header (id/createdAt/updatedAt/hops/status) roundtrip", () => {
    const text = renderTaskChainBaton({
      header: { id: "abcd0001", createdAt: "2026-09-27T12:00:00.000Z", updatedAt: "2026-09-27T13:00:00.000Z", hops: 2, status: "active" },
      handoff: "修 bug：已定位到 X，下一步改 Y",
      sessionId: SID,
      history: [
        taskChainHistoryLine(1, "2026-09-27T12:00:00.000Z", SID, 30),
        taskChainHistoryLine(2, "2026-09-27T13:00:00.000Z", SID, 120),
      ],
    });
    const header = parseTaskChainHeader(text)!;
    expect(header).toEqual({
      id: "abcd0001",
      createdAt: "2026-09-27T12:00:00.000Z",
      updatedAt: "2026-09-27T13:00:00.000Z",
      hops: 2,
      status: "active",
    });
    // 链史 lines survive verbatim through the history parser.
    expect(parseTaskChainHistory(text)).toHaveLength(2);
    // 头注释 must be the FIRST line (the machine face before any prose).
    expect(text.split("\n", 1)[0]!.startsWith("<!-- wudao-task-chain ")).toBe(true);
  });

  it("a corrupt/missing header refuses to parse (fail-closed read)", () => {
    expect(parseTaskChainHeader("# someone deleted the header\n")).toBeUndefined();
    expect(parseTaskChainHeader("")).toBeUndefined();
    // hops=0 / non-numeric is corrupt too (a hop count starts at 1).
    expect(parseTaskChainHeader('<!-- wudao-task-chain id="abcd0001" createdAt="a" updatedAt="b" hops="0" status="active" -->\n')).toBeUndefined();
  });

  it("the fired-prompt matcher recovers the task id from a chain row (idempotency key)", () => {
    expect(continueTaskPromptMatch(continueTaskPrompt("abcd0001"))).toBe("abcd0001");
    expect(continueTaskPromptMatch("[定时续跑] some other task")).toBeUndefined();
    expect(continueTaskPromptMatch("")).toBeUndefined();
  });
});

describe("continue_task — the happy path (hop 1)", () => {
  it("writes the baton with the four sections and schedules ONE at one-shot on the resume lane", async () => {
    const { adds, face } = faceOf();
    const res = await toolOf(face).execute({ task_id: "abcd0001", handoff: "任务：修构建。进展：已定位 X。下一步：改 Y 后跑测试。" });
    expect(res.isError).toBeFalsy();
    // --- the schedule: one at one-shot, delay 后 fire, origin = live sid ---
    expect(adds).toHaveLength(1);
    expect(adds[0]).toEqual({
      schedule: { type: "at", at: T0 + CONTINUE_TASK_DEFAULT_DELAY_SECONDS * 1000 },
      prompt: continueTaskPrompt("abcd0001"),
      kind: "task",
      origin: { sessionId: SID, contextHint: continueTaskContextHint("abcd0001") },
      createdFrom: CONTINUE_TASK_CREATED_FROM,
    });
    // --- the baton: 头注释 + 状态节 + 指针节 + 链史 ---
    const text = await batonText();
    const header = parseTaskChainHeader(text)!;
    expect(header.id).toBe("abcd0001");
    expect(header.hops).toBe(1);
    expect(header.status).toBe("active");
    expect(text).toContain("## 当前状态");
    expect(text).toContain("修构建");
    expect(text).toContain("## 指针");
    expect(text).toContain(`前任会话: ${SID}`);
    expect(text).toContain(`.wudao/notes/${SID}/`);
    expect(text).toContain("## 链史");
    expect(parseTaskChainHistory(text)).toEqual([taskChainHistoryLine(1, header.updatedAt, SID, CONTINUE_TASK_DEFAULT_DELAY_SECONDS)]);
    // --- the receipt (task 127's exact copy): delay 秒数 + baton 路径 + notes/历史保留 ---
    expect(res.content).toContain(`已安排任务 abcd0001 在 ${String(CONTINUE_TASK_DEFAULT_DELAY_SECONDS)}s 后继续`);
    expect(res.content).toContain("Baton 文件：.wudao/task-chain/abcd0001.md");
    expect(res.content).toContain("当前会话的 notes 和历史会在 resume 时保留");
  });

  it("a custom delay lands in the at time, the history line, and the receipt", async () => {
    const { adds, face } = faceOf();
    const res = await toolOf(face).execute({ task_id: "abcd0001", handoff: "h", delay_seconds: 120 });
    expect(adds[0]!.schedule.at).toBe(T0 + 120_000);
    expect(res.content).toContain("在 120s 后继续");
    const text = await batonText();
    expect(parseTaskChainHistory(text)[0]!.endsWith("120s 后在原会话继续（resume）")).toBe(true);
  });

  it("hop 2 on the same chain: history appends, hops bumps, createdAt is preserved, 状态节 is the newest projection", async () => {
    const { face } = faceOf();
    await toolOf(face).execute({ task_id: "abcd0001", handoff: "第一棒", delay_seconds: 30 });
    // the pending fire fired (row gone from the table) → the next hop is legal
    const second = faceOf([]);
    const T1 = T0 + 60_000;
    const res = await createContinueTaskTool({ workspaceRoot: ws, face: second.face, sessionId: () => "wudao-live7b", now: () => T1 })
      .execute({ task_id: "abcd0001", handoff: "第二棒：X 已修，下一步验证", delay_seconds: 60 });
    expect(res.isError).toBeFalsy();
    const text = await batonText();
    const header = parseTaskChainHeader(text)!;
    expect(header.hops).toBe(2);
    expect(header.createdAt).toBe(new Date(T0).toISOString()); // chain identity persists
    expect(header.updatedAt).toBe(new Date(T1).toISOString());
    const history = parseTaskChainHistory(text);
    expect(history).toHaveLength(2); // append-only: hop 1's line survives
    expect(history[0]).toContain("wudao-live7a");
    expect(history[1]).toContain("wudao-live7b");
    expect(text).toContain("第二棒"); // the newest projection replaces the old 状态节
  });

  it("a corrupt existing baton refuses fail-closed — never a blind overwrite", async () => {
    await mkdir(join(ws, ".wudao", "task-chain"), { recursive: true });
    await writeFile(taskChainBatonPath(ws, "abcd0001"), "# hand-edited, header lost\n", "utf8");
    const { adds, face } = faceOf();
    const res = await toolOf(face).execute({ task_id: "abcd0001", handoff: "h" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("不可解析");
    expect(adds).toHaveLength(0); // no schedule was made either
    expect(await batonText()).toBe("# hand-edited, header lost\n"); // bytes untouched
  });
});

describe("continue_task — idempotency and the chain cap", () => {
  it("a pending fire for the SAME task_id is refused with a wait hint (no baton rewrite, no add)", async () => {
    const { adds, face } = faceOf([rowOf("abcd0001")]);
    const res = await toolOf(face).execute({ task_id: "abcd0001", handoff: "h" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("abcd0001");
    expect(res.content).toContain("等待");
    expect(adds).toHaveLength(0);
    expect(existsSync(join(ws, ".wudao"))).toBe(false);
  });

  it("a breaker-disabled pending row names the unpause path instead of a wait hint", async () => {
    const { face } = faceOf([rowOf("abcd0001", { enabled: false })]);
    const res = await toolOf(face).execute({ task_id: "abcd0001", handoff: "h" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("停用");
    expect(res.content).toContain("unpause");
  });

  it("the 4th DISTINCT active chain is refused (runaway cap, 127 设计 §3.4)", async () => {
    const { face } = faceOf([rowOf("aaaa0001"), rowOf("bbbb0002"), rowOf("cccc0003")]);
    const res = await toolOf(face).execute({ task_id: "dddd0004", handoff: "h" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain(String(CONTINUE_TASK_ACTIVE_CHAIN_CAP));
    // ...while a 4th row being THIS chain's own (re-handoff after fire) is fine — covered by the hop-2 test.
  });
});

describe("continue_task — typed doors (fail-closed, before any side effect)", () => {
  const cases: readonly [string, Record<string, unknown>][] = [
    ["task_id: uppercase rejected", { task_id: "ABCD0001", handoff: "h" }],
    ["task_id: wrong length rejected", { task_id: "abc", handoff: "h" }],
    ["task_id: path-unsafe rejected", { task_id: "../esc%01", handoff: "h" }],
    ["handoff: missing", { task_id: "abcd0001" }],
    ["handoff: blank", { task_id: "abcd0001", handoff: "   " }],
    ["handoff: over the cap", { task_id: "abcd0001", handoff: "x".repeat(HANDOFF_MAX_CHARS + 1) }],
    ["delay: zero", { task_id: "abcd0001", handoff: "h", delay_seconds: 0 }],
    ["delay: fractional", { task_id: "abcd0001", handoff: "h", delay_seconds: 1.5 }],
    ["delay: over the ceiling", { task_id: "abcd0001", handoff: "h", delay_seconds: 86_401 }],
  ];
  for (const [name, args] of cases) {
    it(name, async () => {
      const { adds, face } = faceOf();
      const res = await toolOf(face).execute(args);
      expect(res.isError).toBe(true);
      expect(adds).toHaveLength(0);
      expect(existsSync(join(ws, ".wudao"))).toBe(false); // nothing written
    });
  }

  it("a live sid that is a sidechain/invalid refuses (no resume lane exists)", async () => {
    const { face } = faceOf();
    const res = await toolOf(face, "side-leak").execute({ task_id: "abcd0001", handoff: "h" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("主会话");
  });

  it("a daemon add refusal (⚠️ receipt) surfaces as the tool error, baton stays as an inert retry-safe file", async () => {
    const { adds, face } = faceOf([], { addReceipt: "⚠️ 一次性时间需在未来" });
    const res = await toolOf(face).execute({ task_id: "abcd0001", handoff: "h" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("一次性时间需在未来");
    expect(adds).toHaveLength(1);
    expect(parseTaskChainHeader(await batonText())!.id).toBe("abcd0001"); // inert md file, retry rewrites it
  });
});
