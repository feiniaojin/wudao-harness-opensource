// 永续 v6 wave2（the upstream project C1 门控自改进）聚焦测试。夹具全写 tmpdir（红线）；
// 提案器/门禁全程注入 fake（零真模型调用、零真子进程——computer-use 弧同
// 律：测试不碰真键鼠/网络）。状态机、触发器、提案管线、门禁运行器四段。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRegistry } from "../src/agents/index.js";
import type { RegistryResult } from "@wudao/core";
import { buildObservedEvent, appendFailureEvent, failureFingerprintPath } from "../src/failure-fingerprints.js";
import {
  listImprovements,
  readImprovement,
  writeImprovement,
  nextImprovementId,
  hasRecordForFingerprint,
  canTransition,
  activateImprovement,
  undoImprovement,
  renderRuleFileForActivation,
  ruleFileNameFor,
  type ImprovementRecord,
} from "../src/improve/store.js";
import { maybeOfferImprovements, triggerCandidates, improveEnabled, IMPROVE_TRIGGER_THRESHOLD } from "../src/improve/trigger.js";
import { buildProposerPrompt, parseProposalOutput, consentToGenerate } from "../src/improve/propose.js";
import { resolveGateBin, runImprovementGateSubprocess } from "../src/improve/gate.js";
import { fenceMarkers } from "../src/memory/guard.js";
import type { FailureRecord } from "../src/failure-fingerprints.js";

let root: string;
const NOW = "2026-09-15T10:00:00.000Z";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wudao-improve-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A minimal offered record for lifecycle tests. */
function offeredRecord(over: Partial<ImprovementRecord> = {}): ImprovementRecord {
  return {
    v: 1,
    id: "p1-a1b2c3d4",
    version: 1,
    fingerprint: "a1b2c3d4".padEnd(64, "0"),
    subject: "npm test",
    stage: "gate",
    normalized: "exit <n> npm test",
    count: 3,
    streak: 3,
    preview: "npm test exited 1",
    status: "offered",
    attempts: 0,
    createdAt: NOW,
    ...over,
  };
}

function fakeManifestRecord(over: Partial<FailureRecord> = {}): FailureRecord {
  return {
    fingerprint: "a1b2c3d4".padEnd(64, "0"),
    subject: "npm test",
    stage: "gate",
    normalized: "exit <n> npm test",
    count: 3,
    streak: 3,
    firstSeen: NOW,
    lastSeen: NOW,
    status: "persisting",
    resolvedCount: 0,
    ...over,
  } as FailureRecord;
}

/** Registry fake: the spawn captures nothing, resolves a controllable result. */
function fakeRegistry(result: RegistryResult): { registry: AgentRegistry; spawned: boolean } {
  const state = { spawned: false };
  const registry = {
    spawn() {
      state.spawned = true;
      return { id: "bg-1", done: Promise.resolve(result), warnings: [] };
    },
  } as unknown as AgentRegistry;
  return { registry, ...state } as { registry: AgentRegistry; spawned: boolean };
}

const OK_REGISTRY_RESULT: RegistryResult = {
  id: "bg-1",
  role: "improve-proposer",
  ok: true,
  report: JSON.stringify({
    problemSummary: "验收未先构建即跑",
    ruleText: "运行 npm test 前先确认产物已构建；缺则先构建再跑测试，不要改测试本身。",
    scope: "本工作区构建流程",
  }),
  reportValid: true,
};

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---------------------------------------------------------------------------
// store — the versioned release face + the state machine.
// ---------------------------------------------------------------------------

describe("improve/store — 版本化提案仓", () => {
  it("id 递增 + 指纹抑制键", () => {
    const a = offeredRecord();
    expect(nextImprovementId([a], "ffffffff" + "0".repeat(56))).toBe("p2-ffffffff");
    expect(hasRecordForFingerprint([a], a.fingerprint)).toBe(true);
    expect(hasRecordForFingerprint([a], "b".padEnd(64, "0"))).toBe(false);
  });

  it("状态机：合法迁移白名单（两道门 + 撤销 + 防重放终态）", () => {
    expect(canTransition("offered", "proposing")).toBe(true);
    expect(canTransition("offered", "ignored")).toBe(true);
    expect(canTransition("offered", "activated")).toBe(false); // 第一道门不可跳过
    expect(canTransition("proposing", "gated")).toBe(true);
    expect(canTransition("proposing", "gate-failed")).toBe(true);
    expect(canTransition("proposing", "offered")).toBe(true); // 失败可重试
    expect(canTransition("gated", "activated")).toBe(true);
    expect(canTransition("gated", "rejected")).toBe(true);
    expect(canTransition("gated", "gated")).toBe(false);
    expect(canTransition("activated", "undone")).toBe(true);
    expect(canTransition("undone", "activated")).toBe(true); // 撤销可反悔
    expect(canTransition("rejected", "offered")).toBe(false); // 驳回=终态（防重复提案）
    expect(canTransition("ignored", "proposing")).toBe(false);
    expect(canTransition("gate-failed", "gated")).toBe(false);
    expect(canTransition("abandoned", "offered")).toBe(false);
  });

  it("激活→撤销→再激活：规则文件字节往返 + 快照纪律", async () => {
    const gated = offeredRecord({
      status: "gated",
      ruleText: "先构建再测试。",
      scope: "构建流程",
      problemSummary: "未构建即跑测试",
    });
    await writeImprovement(root, gated);
    // offered 状态拒绝激活（缺 ruleText）——直接对原记录激活也必须被状态门拒。
    const early = await activateImprovement(root, offeredRecord(), NOW);
    expect(early.ok).toBe(false);

    const act = await activateImprovement(root, gated, NOW);
    expect(act.ok).toBe(true);
    const file = join(root, ".wudao", "rules", ruleFileNameFor(gated.id));
    expect(existsSync(file)).toBe(true);
    expect(await readFile(file, "utf8")).toBe("先构建再测试。\n");
    const activated = await readImprovement(root, gated.id);
    expect(activated?.status).toBe("activated");
    expect(activated?.ruleFileContent).toBe("先构建再测试。\n");

    // 已激活再点激活 → MISS 形收敛（重放由 vault 挡住；面板双击见「已处理过」）。
    const again = await activateImprovement(root, activated!, NOW);
    expect(again.ok).toBe(false);

    // 崩溃窗口幂等：记录仍 gated 但规则文件已落地（writeFile 与 writeImprovement
    // 之间断电）→ 再激活命中 alreadyInPlace，不重写不报错。
    const crashGated = offeredRecord({ id: "p9-e1e2e3e4", fingerprint: "e1e2e3e4".padEnd(64, "0"), status: "gated", ruleText: "窗口规则。", scope: "s", problemSummary: "p" });
    const crashFile = join(root, ".wudao", "rules", ruleFileNameFor(crashGated.id));
    await mkdir(join(root, ".wudao", "rules"), { recursive: true });
    await writeFile(crashFile, "窗口规则。\n", "utf8");
    const crash = await activateImprovement(root, crashGated, NOW);
    expect(crash.ok && crash.alreadyInPlace).toBe(true);

    // 撤销：字节仍匹配 → 删除 + undone。
    const undo = await undoImprovement(root, activated!, NOW);
    expect(undo.ok).toBe(true);
    expect(existsSync(file)).toBe(false);

    // 撤销后反悔：undone → activated 重写同一字节。
    const react = await activateImprovement(root, (await readImprovement(root, gated.id))!, NOW);
    expect(react.ok).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  it("撤销红线：被手工改过的规则文件绝不删", async () => {
    const gated = offeredRecord({ status: "gated", ruleText: "规则A", scope: "s", problemSummary: "p" });
    await writeImprovement(root, gated);
    const act = await activateImprovement(root, gated, NOW);
    expect(act.ok).toBe(true);
    const file = join(root, ".wudao", "rules", ruleFileNameFor(gated.id));
    await writeFile(file, "规则A（用户手工改过）\n", "utf8");
    const undo = await undoImprovement(root, (await readImprovement(root, gated.id))!, NOW);
    expect(undo.ok).toBe(false);
    expect(existsSync(file)).toBe(true); // 文件仍在
  });

  it("激活红线：绝不覆盖内容不同的既有文件", async () => {
    const gated = offeredRecord({ status: "gated", ruleText: "新规则", scope: "s", problemSummary: "p" });
    await writeImprovement(root, gated);
    const file = join(root, ".wudao", "rules", ruleFileNameFor(gated.id));
    await mkdir(join(root, ".wudao", "rules"), { recursive: true });
    await writeFile(file, "用户自己的规则\n", "utf8");
    const act = await activateImprovement(root, gated, NOW);
    expect(act.ok).toBe(false);
    expect(await readFile(file, "utf8")).toBe("用户自己的规则\n");
  });

  it("容错读：损坏记录跳过不炸清单", async () => {
    await mkdir(join(root, ".wudao", "proposals"), { recursive: true });
    await writeFile(join(root, ".wudao", "proposals", "broken.json"), "{not json", "utf8");
    await writeImprovement(root, offeredRecord());
    const all = await listImprovements(root);
    expect(all.length).toBe(1);
  });

  it("规则文件渲染与 evals 侧 gate 渲染字节一致（drift-pin 字面量）", () => {
    expect(renderRuleFileForActivation("规则体。")).toBe("规则体。\n");
    expect(renderRuleFileForActivation("规则体。", ["src/**", "pkg/*.ts"])).toBe("---\npaths:\n- src/**\n- pkg/*.ts\n---\n\n规则体。\n");
  });
});

// ---------------------------------------------------------------------------
// trigger — the first human gate's offer engine.
// ---------------------------------------------------------------------------

describe("improve/trigger — 触发器（人工同意第一道）", () => {
  it("阈值/状态/run-end 防污染/抑制/每趟上限", () => {
    const fp = (n: string) => n.padEnd(64, "0");
    const below = fakeManifestRecord({ fingerprint: fp("b"), count: IMPROVE_TRIGGER_THRESHOLD - 1 });
    const fixed = fakeManifestRecord({ fingerprint: fp("c"), count: 9, status: "fixed", streak: 0 });
    const runEnd = fakeManifestRecord({ fingerprint: fp("d"), stage: "run-end", count: 9 });
    const hit1 = fakeManifestRecord({ fingerprint: fp("e"), count: 5, subject: "zzz" });
    const hit2 = fakeManifestRecord({ fingerprint: fp("f"), count: 4, subject: "aaa" });
    const hit3 = fakeManifestRecord({ fingerprint: fp("1"), count: 8, subject: "mmm" });
    const out = triggerCandidates([below, fixed, runEnd, hit1, hit2, hit3], new Set([fp("1")]));
    expect(out.map((r) => r.fingerprint.slice(0, 1))).toEqual(["e", "f"]); // count 降序 + 帽 2 + 抑制
  });

  it("kill switch：WUDAO_IMPROVE=off / WUDAO_NO_IMPROVE=1", () => {
    expect(improveEnabled({})).toBe(true);
    expect(improveEnabled({ WUDAO_IMPROVE: "off" })).toBe(false);
    expect(improveEnabled({ WUDAO_IMPROVE: "OFF" })).toBe(false);
    expect(improveEnabled({ WUDAO_NO_IMPROVE: "1" })).toBe(false);
    expect(improveEnabled({ WUDAO_IMPROVE: "on" })).toBe(true);
  });

  it("maybeOfferImprovements：台账三次 → 一条 offered + 通知；再跑抑制", async () => {
    const path = failureFingerprintPath(root);
    for (let i = 0; i < 3; i += 1) {
      await appendFailureEvent(path, buildObservedEvent({ subject: "npm test", stage: "gate", cause: "npm test exited 1", at: NOW }));
    }
    const notices: string[] = [];
    const created = await maybeOfferImprovements({ workspaceRoot: root, onNotice: (l) => notices.push(l), env: {}, now: () => NOW });
    expect(created.length).toBe(1);
    expect(created[0]!.status).toBe("offered");
    expect(created[0]!.count).toBe(3);
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain("已出现 3 次");
    const again = await maybeOfferImprovements({ workspaceRoot: root, env: {}, now: () => NOW });
    expect(again.length).toBe(0); // 同指纹抑制（the upstream project rejected/offer 记忆）
    const off = await maybeOfferImprovements({ workspaceRoot: root, env: { WUDAO_IMPROVE: "off" }, now: () => NOW });
    expect(off.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// propose — the detached proposer pipeline (all fakes, zero model calls).
// ---------------------------------------------------------------------------

describe("improve/propose — 提案器管线", () => {
  it("提示词：围栏三源 + worked example + 次数", () => {
    const record = offeredRecord();
    const prompt = buildProposerPrompt({ record, related: [fakeManifestRecord({ fingerprint: "x".padEnd(64, "0") })], rejectedPeers: ["旧提案：先跑构建"] });
    for (const source of ["improve-failure", "improve-history", "improve-rejected"]) {
      const m = prompt.match(new RegExp(`<untrusted source="${source}" nonce="([0-9a-f]+)">`));
      expect(m, source).not.toBeNull();
      expect(prompt).toContain(`</untrusted nonce="${m![1]}">`); // 闭标记带同一 nonce
    }
    expect(prompt).toContain("第 3 次仍未修复");
    expect(prompt).toContain("final_output");
    expect(prompt).toContain("参考示例");
  });

  it("parseProposalOutput：合法稳定/带路径；各项拒绝", () => {
    expect(parseProposalOutput({ problemSummary: "归纳", ruleText: "一条足够长的中文规则文本。", scope: "范围" }).ok).toBe(true);
    const gated = parseProposalOutput({ problemSummary: "归纳", ruleText: "一条足够长的中文规则文本。", scope: "范围", paths: ["src/**"] });
    expect(gated.ok && gated.paths?.[0]).toBe("src/**");
    expect(parseProposalOutput({ problemSummary: "", ruleText: "一条足够长的中文规则文本。", scope: "s" }).ok).toBe(false);
    expect(parseProposalOutput({ problemSummary: "p", ruleText: "短", scope: "s" }).ok).toBe(false);
    expect(parseProposalOutput({ problemSummary: "p", ruleText: "---\npaths:\n- x\n---\n正文很长的一段话。", scope: "s" }).ok).toBe(false); // 自带 frontmatter 拒绝
    expect(parseProposalOutput({ problemSummary: "p", ruleText: "一条足够长的中文规则文本。", scope: "s", paths: ["/abs"] }).ok).toBe(false);
    expect(parseProposalOutput({ problemSummary: "p", ruleText: "一条足够长的中文规则文本。", scope: "s", paths: ["a/../b"] }).ok).toBe(false);
  });

  const GATE_OK = async () => ({ ok: true as const, verdict: { ok: true, paired: { baselineOk: true, candidateOk: true, errors: [] }, suites: [], durationMs: 1, at: NOW } });
  /** env 指向一个真实存在的占位 bin（可用性检查只看存在性；真正的门禁由
   *  注入的 runGate 替身执行——零真子进程）。 */
  const envWithBin = async () => {
    const stub = join(root, "stub-gate-bin.cjs");
    await writeFile(stub, "// availability stub\n", "utf8");
    return { WUDAO_IMPROVE_GATE_BIN: stub };
  };

  it("同意→生成→过门→gated（全 fake 管线）+ 通知", async () => {
    await writeImprovement(root, offeredRecord());
    const { registry } = fakeRegistry(OK_REGISTRY_RESULT);
    const notices: string[] = [];
    const r = await consentToGenerate({ workspaceRoot: root, id: "p1-a1b2c3d4", model: {} as never, registry, onNotice: (l) => notices.push(l), env: await envWithBin(), runGate: GATE_OK, now: () => NOW });
    expect(r.ok).toBe(true);
    await waitFor(async () => (await readImprovement(root, "p1-a1b2c3d4"))?.status === "gated");
    const done = await readImprovement(root, "p1-a1b2c3d4");
    expect(done?.status).toBe("gated");
    expect(done?.ruleText).toContain("先确认产物已构建");
    expect(done?.gate?.ok).toBe(true);
    expect(notices.some((n) => n.includes("通过了门禁"))).toBe(true);
  });

  it("门禁失败→gate-failed（fail-open：什么都不改）", async () => {
    await writeImprovement(root, offeredRecord());
    const { registry } = fakeRegistry(OK_REGISTRY_RESULT);
    const gateFail = async () => ({ ok: true as const, verdict: { ok: false, reason: "骨干套件未全绿", paired: { baselineOk: true, candidateOk: true, errors: [] }, suites: [{ name: "det-46", status: "fail", errors: ["x"] }], durationMs: 1, at: NOW } });
    await consentToGenerate({ workspaceRoot: root, id: "p1-a1b2c3d4", model: {} as never, registry, env: await envWithBin(), runGate: gateFail, now: () => NOW });
    await waitFor(async () => (await readImprovement(root, "p1-a1b2c3d4"))?.status === "gate-failed");
    const done = await readImprovement(root, "p1-a1b2c3d4");
    expect(done?.status).toBe("gate-failed");
    expect(done?.lastError).toContain("套件");
    expect(existsSync(join(root, ".wudao", "rules"))).toBe(false); // 零规则写入
  });

  it("准入筛查拦截（sk- 凭据形状）→ 生成失败回 offered + 台账留痕", async () => {
    await writeImprovement(root, offeredRecord());
    const bad: RegistryResult = {
      ...OK_REGISTRY_RESULT,
      report: JSON.stringify({ problemSummary: "p", ruleText: "密钥 sk-abcdefgh12345678 不要提交。这是一段足够长的规则文本。", scope: "s" }),
    };
    const { registry } = fakeRegistry(bad);
    await consentToGenerate({ workspaceRoot: root, id: "p1-a1b2c3d4", model: {} as never, registry, env: await envWithBin(), runGate: GATE_OK, now: () => NOW });
    await waitFor(async () => (await readImprovement(root, "p1-a1b2c3d4"))?.status === "offered");
    const done = await readImprovement(root, "p1-a1b2c3d4");
    expect(done?.status).toBe("offered");
    expect(done?.attempts).toBe(1);
    expect(done?.lastError).toContain("准入筛查");
    const blocked = await readFile(join(root, ".wudao", "memory-blocked.jsonl"), "utf8");
    expect(blocked).toContain("\"source\":\"improve\"");
    expect(blocked).not.toContain("sk-abcdefgh12345678"); // 台账绝不落第二份密钥
  });

  it("子代理失败→offered 可重试；attempts 帽→abandoned", async () => {
    await writeImprovement(root, offeredRecord({ attempts: 2 }));
    const fail: RegistryResult = { id: "bg-1", role: "improve-proposer", ok: false, report: "timeout", aborted: true, error: "timeout" };
    const { registry } = fakeRegistry(fail);
    await consentToGenerate({ workspaceRoot: root, id: "p1-a1b2c3d4", model: {} as never, registry, env: await envWithBin(), runGate: GATE_OK, now: () => NOW });
    await waitFor(async () => (await readImprovement(root, "p1-a1b2c3d4"))?.status === "abandoned");
    const done = await readImprovement(root, "p1-a1b2c3d4");
    expect(done?.status).toBe("abandoned"); // attempts 2+1 ≥ 3
    expect(done?.attempts).toBe(3);
  });

  it("非 offered 状态同意→MISS；门禁环境缺失→零生成拒绝", async () => {
    await writeImprovement(root, offeredRecord({ status: "ignored" }));
    const r1 = await consentToGenerate({ workspaceRoot: root, id: "p1-a1b2c3d4", model: {} as never, registry: fakeRegistry(OK_REGISTRY_RESULT).registry, env: await envWithBin(), runGate: GATE_OK, now: () => NOW });
    expect(r1.ok).toBe(false);
    expect(r1.message).toContain("可能已处理过");

    await writeImprovement(root, offeredRecord({ id: "p2-b1b2c3d4", fingerprint: "b1b2c3d4".padEnd(64, "0") }));
    const { registry, spawned } = fakeRegistry(OK_REGISTRY_RESULT);
    const envNoBin = { WUDAO_IMPROVE_GATE_BIN: "/definitely/not/here" };
    const r2 = await consentToGenerate({ workspaceRoot: root, id: "p2-b1b2c3d4", model: {} as never, registry, env: envNoBin, runGate: GATE_OK, now: () => NOW });
    expect(r2.ok).toBe(false);
    expect(r2.message).toContain("门禁");
    expect(spawned).toBe(false); // 零模型调用
  });
});

// ---------------------------------------------------------------------------
// gate — the subprocess runner (fixture bins in tmpdir; no real evals run).
// ---------------------------------------------------------------------------

describe("improve/gate — 门禁子进程运行器", () => {
  it("env 覆盖权威：缺失→undefined（不静默回落）", () => {
    expect(resolveGateBin({ WUDAO_IMPROVE_GATE_BIN: "/definitely/not/here" })).toBeUndefined();
  });

  it("过门 bin → ok:true + verdict；未过 bin（exit 1）→ 仍是「门跑完」", async () => {
    const okBin = join(root, "gate-ok.cjs");
    await writeFile(okBin, [
      "const fs=require('fs');",
      `fs.writeFileSync(process.argv[5], JSON.stringify({ok:true,paired:{baselineOk:true,candidateOk:true,errors:[]},suites:[],durationMs:1,at:'${NOW}'})+'\\n');`,
    ].join("\n"), "utf8");
    const pass = await runImprovementGateSubprocess({ proposalId: "p1", ruleFileName: "auto-p1.md", ruleText: "规则。" }, { bin: okBin });
    expect(pass.ok).toBe(true);
    expect(pass.ok && pass.verdict.ok).toBe(true);

    const failBin = join(root, "gate-fail.cjs");
    await writeFile(failBin, [
      "const fs=require('fs');",
      `fs.writeFileSync(process.argv[5], JSON.stringify({ok:false,reason:'骨干套件未全绿',paired:{baselineOk:true,candidateOk:true,errors:[]},suites:[],durationMs:1,at:'${NOW}'})+'\\n');`,
      "process.exit(1);",
    ].join("\n"), "utf8");
    const failed = await runImprovementGateSubprocess({ proposalId: "p1", ruleFileName: "auto-p1.md", ruleText: "规则。" }, { bin: failBin });
    expect(failed.ok).toBe(true); // the gate RAN — the verdict says no
    expect(failed.ok && failed.verdict.ok).toBe(false);
  });

  it("bin 崩溃不写产物 → ok:false（fail-open）", async () => {
    const crashBin = join(root, "gate-crash.cjs");
    await writeFile(crashBin, "process.exit(3);", "utf8");
    const r = await runImprovementGateSubprocess({ proposalId: "p1", ruleFileName: "auto-p1.md", ruleText: "规则。" }, { bin: crashBin });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("门禁");
  });

  it("bin 缺席 → ok:false 门禁环境不可用", async () => {
    const r = await runImprovementGateSubprocess({ proposalId: "p1", ruleFileName: "auto-p1.md", ruleText: "规则。" }, { bin: undefined, env: { WUDAO_IMPROVE_GATE_BIN: "/nope" } });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("不可用");
  });
});
