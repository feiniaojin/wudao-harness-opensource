// 借鉴弧 ζ1（Reasonix durable tool recovery 蒸馏）——未决工具动作的崩溃事
// 实面。三面钉：①动作身份与提取（pendingLedgerOf 的逐调用配对/未知合成结
// 果/再接地清除/悬空调用）；②尾注 rider（format/parse 回环、帽与省略行、
// 三条 tier-2 通道的冻结摘要携带、空集=status-quo 字节）；③陈旧写拒绝门
// （同指纹放行、异指纹拒、重新读过放行、fail-open）。
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalArguments,
  argumentFingerprint,
  normalizePathArg,
  pendingLedgerOf,
  pendingActionsSection,
  formatPendingActions,
  parsePendingActionsFromSummary,
  pendingActionLine,
  createPendingWriteGate,
  PENDING_ACTIONS_CAP,
  STALE_PENDING_WRITE_RESULT,
  SUMMARY_MARKER,
  tier2Compact,
  staticTier2Compact,
  dualTier2Compact,
  createWriteFileTool,
  createEditTool,
  createReadStateTable,
  ABORTED_UNKNOWN_TOOL_RESULT,
  ABORTED_NOT_STARTED_TOOL_RESULT,
  TRUNCATED_TOOL_CALL_RESULT,
  UNAVAILABLE_TOOL_RESULT,
} from "../src/index.js";
import { createScriptedModel } from "../src/model-client.js";
import type { ModelClient } from "../src/model-client.js";
import type { AgentMessage } from "../src/types.js";

const tc = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, arguments: args });
const user = (content: string): AgentMessage => ({ role: "user", content });
const asstCalls = (...calls: ReturnType<typeof tc>[]): AgentMessage => ({ role: "assistant", content: "", toolCalls: calls });
const toolMsg = (id: string, name: string, content: string, isError = false): AgentMessage => ({ role: "tool", toolCallId: id, name, content, ...(isError ? { isError: true } : {}) });
const asstText = (content: string): AgentMessage => ({ role: "assistant", content });

const WRITE_A = { path: "src/a.ts", content: "hello world" };
const WRITE_A_FP = argumentFingerprint(WRITE_A);
const WRITE_B = { path: "src/a.ts", content: "different bytes" };

// ---------------------------------------------------------------------------
// ① 动作身份
// ---------------------------------------------------------------------------

describe("ζ1 动作身份（canonical 指纹）", () => {
  it("键序无关：{a,b} 与 {b,a} 同指纹；值序不同则异", () => {
    expect(argumentFingerprint({ path: "a", content: "x" })).toBe(argumentFingerprint({ content: "x", path: "a" }));
    expect(argumentFingerprint({ path: "a", content: "x" })).not.toBe(argumentFingerprint({ path: "a", content: "y" }));
  });
  it("嵌套键序也无关（递归排序）；undefined 键与缺席键同形", () => {
    expect(canonicalArguments({ a: { x: 1, y: [2, { b: 1, a: 2 }] } })).toBe('{"a":{"x":1,"y":[2,{"a":2,"b":1}]}}');
    expect(argumentFingerprint({ path: "a", replace_all: undefined })).toBe(argumentFingerprint({ path: "a" }));
  });
  it("normalizePathArg 只剥前导 ./（文件台账同一边界）", () => {
    expect(normalizePathArg("./src/a.ts")).toBe("src/a.ts");
    expect(normalizePathArg("src/a.ts")).toBe("src/a.ts");
    expect(normalizePathArg("../out.ts")).toBe("../out.ts");
  });
});

// ---------------------------------------------------------------------------
// ② pendingLedgerOf — 提取语义
// ---------------------------------------------------------------------------

describe("ζ1 pendingLedgerOf（未决提取）", () => {
  it("悬空写调用（发出、无结果）= 未决——崩溃残迹的机器事实", () => {
    const chain = [
      user("go"),
      asstCalls(tc("c1", "write_file", WRITE_A)),
    ];
    expect(pendingLedgerOf(chain)).toEqual([{ tool: "write_file", path: "src/a.ts", fingerprint: WRITE_A_FP }]);
  });
  it("未知合成结果（resume 修复 / 中断成对）保持未决；确定未执行的合成结果已了结", () => {
    const withUnavailable = [
      user("go"),
      asstCalls(tc("c1", "write_file", WRITE_A)),
      toolMsg("c1", "write_file", UNAVAILABLE_TOOL_RESULT, true),
    ];
    expect(pendingLedgerOf(withUnavailable)).toHaveLength(1);
    const withAbortedUnknown = [
      user("go"),
      asstCalls(tc("c1", "write_file", WRITE_A)),
      toolMsg("c1", "write_file", ABORTED_UNKNOWN_TOOL_RESULT, true),
    ];
    expect(pendingLedgerOf(withAbortedUnknown)).toHaveLength(1);
    for (const synthetic of [TRUNCATED_TOOL_CALL_RESULT, ABORTED_NOT_STARTED_TOOL_RESULT, "[会话写入失败] 工具未执行"]) {
      const resolved = [
        user("go"),
        asstCalls(tc("c1", "write_file", WRITE_A)),
        toolMsg("c1", "write_file", synthetic, true),
      ];
      expect(pendingLedgerOf(resolved), synthetic).toHaveLength(0);
    }
  });
  it("普通错误结果（权限拒/门拒）已了结；成功写清除同目标未决", () => {
    const denied = [
      user("go"),
      asstCalls(tc("c1", "write_file", WRITE_A)),
      toolMsg("c1", "write_file", "permission denied", true),
    ];
    expect(pendingLedgerOf(denied)).toHaveLength(0);
    const superseded = [
      user("go"),
      asstCalls(tc("c1", "write_file", WRITE_A)),
      toolMsg("c1", "write_file", UNAVAILABLE_TOOL_RESULT, true),
      asstCalls(tc("c2", "write_file", WRITE_B)),
      toolMsg("c2", "write_file", "wrote src/a.ts"),
    ];
    expect(pendingLedgerOf(superseded)).toHaveLength(0);
  });
  it("成功的 read_file 重新接地（含 elided 形——成功即触碰过盘）；读失败不清", () => {
    const elided = [
      user("go"),
      asstCalls(tc("c1", "write_file", WRITE_A)),
      toolMsg("c1", "write_file", ABORTED_UNKNOWN_TOOL_RESULT, true),
      asstCalls(tc("c2", "read_file", { path: "./src/a.ts" })),
      toolMsg("c2", "read_file", "[elided] src/a.ts unchanged — identical content already in your context"),
    ];
    expect(pendingLedgerOf(elided)).toHaveLength(0);
    const failedRead = [
      user("go"),
      asstCalls(tc("c1", "write_file", WRITE_A)),
      toolMsg("c1", "write_file", ABORTED_UNKNOWN_TOOL_RESULT, true),
      asstCalls(tc("c2", "read_file", { path: "src/a.ts" })),
      toolMsg("c2", "read_file", "read failed", true),
    ];
    expect(pendingLedgerOf(failedRead)).toHaveLength(1);
  });
  it("非写工具与无 path 参数的调用不进台账；onlyPath 过滤与全量语义一致", () => {
    const chain = [
      user("go"),
      asstCalls(tc("s1", "shell", { command: "sed -i s/a/b/ src/a.ts" })),
      asstCalls(tc("c1", "write_file", WRITE_A), tc("c2", "edit", { path: "src/b.ts", old_string: "a", new_string: "b" })),
      toolMsg("c2", "edit", "ok"),
    ];
    expect(pendingLedgerOf(chain)).toEqual([{ tool: "write_file", path: "src/a.ts", fingerprint: WRITE_A_FP }]);
    expect(pendingLedgerOf(chain, "src/b.ts")).toEqual([]);
  });
  it("同一逻辑动作重发=一条（首现序去重）；批内先后写由逐调用配对天然区分", () => {
    const chain = [
      user("go"),
      asstCalls(tc("c1", "write_file", WRITE_A)),
      toolMsg("c1", "write_file", ABORTED_UNKNOWN_TOOL_RESULT, true),
      asstCalls(tc("c2", "write_file", WRITE_A)),
      toolMsg("c2", "write_file", ABORTED_UNKNOWN_TOOL_RESULT, true),
    ];
    expect(pendingLedgerOf(chain)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ③ rider — format/parse/section + 三条 tier-2 通道
// ---------------------------------------------------------------------------

describe("ζ1 尾注 rider（format/parse/section）", () => {
  const entries = [
    { tool: "write_file" as const, path: "src/a.ts", fingerprint: "1a2b3c4d" },
    { tool: "edit" as const, path: "src/b.ts", fingerprint: "9f31e207" },
  ];
  it("空集 → 空串（status-quo 字节律）", () => {
    expect(formatPendingActions([])).toBe("");
    expect(pendingActionsSection([], [])).toBe("");
  });
  it("format→parse 回环无损（指引行/省略行是表现层，不进事实）", () => {
    const parsed = parsePendingActionsFromSummary(`[compact] stuff\n${formatPendingActions(entries)}`);
    expect(parsed).toEqual(entries);
    expect(parsePendingActionsFromSummary("[compact] no block here")).toBeUndefined();
  });
  it("帽=PENDING_ACTIONS_CAP，省略行协议无损再合并", () => {
    const many = Array.from({ length: PENDING_ACTIONS_CAP + 3 }, (_, i) => ({ tool: "write_file" as const, path: `f${i}.ts`, fingerprint: argumentFingerprint({ path: `f${i}.ts` }) }));
    const block = formatPendingActions(many);
    expect(block).toContain(`[... 3 older pending writes omitted]`);
    const parsed = parsePendingActionsFromSummary(block);
    expect(parsed).toEqual(many.slice(3));
  });
  it("撕裂块不解析（家族律：摘要体内 LLM 回声的未闭合块=整块缺席；冻结写者的块永远完整）", () => {
    const torn = `${formatPendingActions(entries)}\n<pending-actions>\n- write_file x.ts`;
    expect(parsePendingActionsFromSummary(torn)).toBeUndefined();
    // 摘要体里早段回声不遮蔽尾部完整块（lastIndexOf 取最后一块）。
    const echoed = `body echo <pending-actions>\n- edit z.ts (fingerprint 11111111)\n${formatPendingActions(entries)}`;
    expect(parsePendingActionsFromSummary(echoed)).toEqual(entries);
  });
  it("pendingActionsSection 折叠 prior+span：解答回来的不携带、悬空的携带", () => {
    const prior: AgentMessage[] = [];
    const span: AgentMessage[] = [
      user("go"),
      asstCalls(tc("c1", "write_file", WRITE_A)),
      toolMsg("c1", "write_file", "wrote src/a.ts"),
      asstCalls(tc("c2", "edit", { path: "src/b.ts", old_string: "a", new_string: "b" })),
      // c2 悬空（崩溃点）
    ];
    const section = pendingActionsSection(prior, span);
    expect(section).toContain(pendingActionLine({ tool: "edit", path: "src/b.ts", fingerprint: argumentFingerprint({ path: "src/b.ts", old_string: "a", new_string: "b" }) }));
    expect(section).not.toContain("src/a.ts");
  });
});

describe("ζ1 rider 随三条 tier-2 通道过压缩（链式再合并）", () => {
  const alwaysModel = (text: string): ModelClient => {
    const scripted = createScriptedModel([
      { role: "assistant", content: text },
      { role: "assistant", content: text },
      { role: "assistant", content: text },
      { role: "assistant", content: text },
    ]);
    return { generate: (input) => scripted.generate(input) };
  };
  const crashChain = (): AgentMessage[] => [
    user("do a big task " + "x".repeat(400)),
    asstCalls(tc("c1", "write_file", WRITE_A)),
    toolMsg("c1", "write_file", ABORTED_UNKNOWN_TOOL_RESULT, true),
    asstText("moving on " + "y".repeat(400)),
    user("latest 1"),
    user("latest 2"),
  ];
  const keep = { keepRecent: 3 };

  it("tier2Compact：摘要携带未决尾注；无未决时摘要字节与既有形状一致（只差零个 rider）", async () => {
    const model = alwaysModel("summary body");
    const out = await tier2Compact(crashChain(), model, keep);
    expect(out).not.toBeNull();
    const summary = out!.messages.find((m) => m.role === "user" && m.content.startsWith(SUMMARY_MARKER))!;
    expect(summary.content).toContain(pendingActionLine({ tool: "write_file", path: "src/a.ts", fingerprint: WRITE_A_FP }));

    const clean = await tier2Compact([
      user("do things " + "x".repeat(400)),
      asstCalls(tc("c1", "write_file", WRITE_A)),
      toolMsg("c1", "write_file", "wrote src/a.ts"),
      asstText("done " + "y".repeat(400)),
      user("latest 1"),
      user("latest 2"),
    ], model, keep);
    const cleanSummary = clean!.messages.find((m) => m.role === "user" && m.content.startsWith(SUMMARY_MARKER))!;
    expect(cleanSummary.content).not.toContain("<pending-actions>");
  });
  it("staticTier2Compact 与 dualTier2Compact 同缝携带", () => {
    const staticOut = staticTier2Compact(crashChain(), keep);
    expect(staticOut).not.toBeNull();
    expect(staticOut!.messages.some((m) => m.role === "user" && m.content.includes("pending-actions"))).toBe(true);
  });
  it("链式压缩：第一次的 rider 块在第二次压缩时作种子再合并（冻结字节重解析）", async () => {
    const model = alwaysModel("summary body");
    const first = await tier2Compact(crashChain(), model, keep);
    // 在第一次的结果上继续追加并再压——种子必须来自冻结摘要的块（新尾须含
    // assistant，否则 stubFloor 咬住第二压缩的 span——ω-3b 的未应答面）。
    const grown = [...first!.messages, user("more work " + "z".repeat(400)), asstText("working " + "z".repeat(400)), user("tail 1"), user("tail 2")];
    const second = await tier2Compact(grown, model, keep);
    expect(second).not.toBeNull();
    const summary = second!.messages.find((m) => m.role === "user" && m.content.startsWith(SUMMARY_MARKER))!;
    expect(summary.content).toContain(pendingActionLine({ tool: "write_file", path: "src/a.ts", fingerprint: WRITE_A_FP }));
    // 种子语义：pendingLedgerOf 直接从第二次链读出同一条。
    expect(pendingLedgerOf(second!.messages)).toEqual([{ tool: "write_file", path: "src/a.ts", fingerprint: WRITE_A_FP }]);
  });
});

// （占位符常量已并入字面断言——<pending-actions> 直接写进 expect。）

// ---------------------------------------------------------------------------
// ④ 陈旧写拒绝门（纯门 + 工具接线）
// ---------------------------------------------------------------------------

describe("ζ1 陈旧写拒绝门（createPendingWriteGate）", () => {
  const crashedChain = (): AgentMessage[] => [
    user("go"),
    asstCalls(tc("c1", "write_file", WRITE_A)),
    toolMsg("c1", "write_file", UNAVAILABLE_TOOL_RESULT, true),
  ];
  it("异指纹拒（消息含指引）；同指纹放行（verify-first 的原样重发）", () => {
    const gate = createPendingWriteGate(crashedChain, () => false);
    expect(gate.staleFor("write_file", "src/a.ts", WRITE_B, "/ws/src/a.ts")).toBe(STALE_PENDING_WRITE_RESULT);
    expect(gate.staleFor("edit", "src/a.ts", { path: "src/a.ts", old_string: "a", new_string: "b" }, "/ws/src/a.ts")).toBe(STALE_PENDING_WRITE_RESULT);
    expect(gate.staleFor("write_file", "src/a.ts", WRITE_A, "/ws/src/a.ts")).toBeUndefined();
    // ./ 归一化后同一目标
    expect(gate.staleFor("write_file", "./src/a.ts", WRITE_B, "/ws/src/a.ts")).toBe(STALE_PENDING_WRITE_RESULT);
  });
  it("无未决记录=零扰动；异目标=零扰动", () => {
    const clean = createPendingWriteGate([user("go"), asstText("hi")], () => false);
    expect(clean.staleFor("write_file", "src/a.ts", WRITE_B, "/ws/src/a.ts")).toBeUndefined();
    const gate = createPendingWriteGate(crashedChain, () => false);
    expect(gate.staleFor("write_file", "src/other.ts", { path: "src/other.ts", content: "x" }, "/ws/src/other.ts")).toBeUndefined();
  });
  it("重新读过（hasFreshRead）放行——freshness gate 重新武装接管真陈旧", () => {
    const gate = createPendingWriteGate(crashedChain, () => true);
    expect(gate.staleFor("write_file", "src/a.ts", WRITE_B, "/ws/src/a.ts")).toBeUndefined();
  });
  it("fail-open：链缺席/访问器抛错/链畸形一律放行（表损坏不阻塞）", () => {
    const noChain = createPendingWriteGate(() => undefined, () => false);
    expect(noChain.staleFor("write_file", "src/a.ts", WRITE_B, "/ws/src/a.ts")).toBeUndefined();
    const throwing = createPendingWriteGate(() => { throw new Error("boom"); }, () => false);
    expect(throwing.staleFor("write_file", "src/a.ts", WRITE_B, "/ws/src/a.ts")).toBeUndefined();
    const malformed = createPendingWriteGate(() => [{ role: "assistant", content: "" } as AgentMessage], () => false);
    expect(malformed.staleFor("write_file", "src/a.ts", WRITE_B, "/ws/src/a.ts")).toBeUndefined();
  });
});

describe("ζ1 写工具接线（write_file/edit 的姊妹门）", () => {
  it("未决悬着时 write_file 拒异指纹、放行同指纹；re-read 后放行（真盘）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zeta1-write-"));
    const crashedWrite = { path: "a.ts", content: "old" };
    let chain: AgentMessage[] = [
      user("go"),
      asstCalls(tc("c1", "write_file", crashedWrite)),
      toolMsg("c1", "write_file", UNAVAILABLE_TOOL_RESULT, true),
    ];
    const readState = createReadStateTable();
    const gate = createPendingWriteGate(() => chain, (abs) => readState.get(abs) !== undefined);
    const tool = createWriteFileTool({ workspaceRoot: dir, readState, pendingWrites: gate });
    const blocked = await tool.execute({ path: "a.ts", content: "brand new" });
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain(STALE_PENDING_WRITE_RESULT);
    const resent = await tool.execute({ path: "a.ts", content: "old" });
    expect(resent.isError).toBeUndefined(); // 同指纹=原样重发，门放行（freshness 无记录也不拦）
    expect(resent.content).toBe("wrote a.ts");
    // A fresh read re-grounds (records readState) → a different-fp write passes.
    chain = [...chain, asstCalls(tc("c2", "read_file", { path: "a.ts" })), toolMsg("c2", "read_file", "old")];
    const { createReadFileTool } = await import("../src/index.js");
    const readTool = createReadFileTool({ workspaceRoot: dir, readState });
    const r = await readTool.execute({ path: "a.ts" });
    expect(r.isError).not.toBe(true); // 读到刚写的文件
    const after = await tool.execute({ path: "a.ts", content: "brand new" });
    expect(after.content).toBe("wrote a.ts");
  });
  it("edit 同款：未决悬着拒（old_string 即旧心智模型的凭据）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zeta1-edit-"));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.ts"), "hello world", "utf8");
    const chain: AgentMessage[] = [
      user("go"),
      asstCalls(tc("c1", "edit", { path: "a.ts", old_string: "hello", new_string: "hi" })),
      toolMsg("c1", "edit", ABORTED_UNKNOWN_TOOL_RESULT, true),
    ];
    const gate = createPendingWriteGate(() => chain, () => false);
    const tool = createEditTool({ workspaceRoot: dir, pendingWrites: gate });
    const blocked = await tool.execute({ path: "a.ts", old_string: "hello", new_string: "bye" });
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain(STALE_PENDING_WRITE_RESULT);
    const resent = await tool.execute({ path: "a.ts", old_string: "hello", new_string: "hi" });
    expect(resent.isError).toBeUndefined(); // 同指纹原样重发
    expect(resent.content).toContain("edited a.ts");
  });
  it("门缺席 = 行为与 ζ1 之前逐字节一致（无门不拦）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zeta1-none-"));
    const tool = createWriteFileTool({ workspaceRoot: dir });
    const out = await tool.execute({ path: "a.ts", content: "x" });
    expect(out.content).toBe("wrote a.ts");
  });
});
