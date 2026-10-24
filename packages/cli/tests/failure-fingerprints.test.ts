// 永续迭代 v6 · reef 借鉴弧 A（digest-reef C2）——失败指纹清单纯层 RED 件：
// 归一化矩阵（同因异形→同指纹；不同因→异指纹）、new→persisting→fixed
// 状态机、跨重启稳定（JSONL 事件流 round-trip + 重 fold 等价）、徽章与
// 修复知识的内容预算。纯函数 + tmpdir JSONL，零网络零真实 shell。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeFailureCause,
  failureFingerprint,
  foldFailureManifest,
  buildObservedEvent,
  readFailureEvents,
  appendFailureEvent,
  failureFingerprintPath,
  occurrenceBadge,
  fixedNoteContent,
  isOpenFailure,
  FP_CAUSE_MAX_CHARS,
  type FailureEvent,
  type FailureRecord,
} from "../src/failure-fingerprints.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fp-pure-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

// ---------------------------------------------------------------------------
// 归一化矩阵——「同因异形」必须撞出同一指纹（这正是功能：同一失败模式），
// 「不同因」必须分开。噪声维度：时间戳 / pid / 绝对路径前缀 / 数字量词 /
// 长标识串 / 空白形状 / ANSI。
// ---------------------------------------------------------------------------

describe("normalizeFailureCause — 同因异形→同指纹", () => {
  it("timestamps / pids / numbers / absolute paths / long ids are masked to placeholders", () => {
    const a = normalizeFailureCause("Error at /Users/runner/work/repo/src/parse.ts:120:8 — timeout after 3000ms (pid 47821, attempt 2)");
    const b = normalizeFailureCause("Error at /tmp/xyz-998/src/parse.ts:441:77 — timeout after 5000ms (pid 991, attempt 17)");
    expect(a).toBe(b);
    expect(a).toContain("<path>");
    expect(a).toContain("<n>");
    // Same run in a FRESH temp dir (reef: fingerprints survive brand-new tmp dirs).
    const c = normalizeFailureCause("Error at ~/builds/abc123/src/parse.ts:1:2 — timeout after 1ms (pid 2, attempt 1)");
    expect(a).toBe(c);
  });

  it("16+ char ids WITH a digit collapse; pure-alpha long words survive (no false collisions)", () => {
    const withHex = normalizeFailureCause("session a1b2c3d4e5f6a1b2 could not resume");
    const withHex2 = normalizeFailureCause("session ffee001122334455 could not resume");
    expect(withHex).toBe(withHex2);
    expect(withHex).toContain("<id>");
    // "internationalization" carries no digit → NOT an id → two DIFFERENT prose
    // causes must not collide into one fingerprint via word masking.
    const proseA = normalizeFailureCause("internationalization layer failed to load");
    const proseB = normalizeFailureCause("uncharacteristically slow startup observed");
    expect(proseA).not.toBe(proseB);
  });

  it("ISO timestamps and hex shas collapse under the number/id rules", () => {
    const a = normalizeFailureCause("checkpoint 2026-09-15T10:00:00.000Z sha=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 mismatch");
    const b = normalizeFailureCause("checkpoint 2027-01-01T00:00:00.000Z sha=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef mismatch");
    expect(a).toBe(b);
  });

  it("whitespace folding + ANSI stripping + 200-char truncation", () => {
    const ansi = normalizeFailureCause("[31mFAIL[0m   extra\n\n\tspaces   here");
    expect(ansi).toBe("FAIL extra spaces here");
    expect(ansi).not.toMatch(/\s{2,}/);
    const long = normalizeFailureCause(`${"x".repeat(500)} tail`);
    expect(long.length).toBe(FP_CAUSE_MAX_CHARS);
  });

  it("different causes → different fingerprints (all three axes)", () => {
    const n1 = normalizeFailureCause("cannot find module 'leftpad'");
    const n2 = normalizeFailureCause("cannot find module 'rightpad'");
    expect(failureFingerprint("npm test", "gate", n1)).not.toBe(failureFingerprint("npm test", "gate", n2));
    expect(failureFingerprint("npm test", "gate", n1)).not.toBe(failureFingerprint("npm run test", "gate", n1)); // different subject
    expect(failureFingerprint("npm test", "gate", n1)).not.toBe(failureFingerprint("npm test", "ratchet", n1)); // different stage
    // Deterministic: pure function, no clock/no randomness.
    expect(failureFingerprint("npm test", "gate", n1)).toBe(failureFingerprint("npm test", "gate", n1));
  });
});

// ---------------------------------------------------------------------------
// 状态机 fold——new→persisting→fixed，修复后再现=回归（persisting 重起）。
// ---------------------------------------------------------------------------

describe("foldFailureManifest — new→persisting→fixed 状态机", () => {
  const at = (i: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
  const obs = (i: number, subject = "npm test", stage: "gate" | "task-fail" = "gate", cause = "exit 1\\nmodule not found"): FailureEvent =>
    buildObservedEvent({ subject, stage, cause: cause.replace("\\n", "\n"), at: at(i), missionId: "m1", taskId: "t3" });
  const res = (fp: string, i: number): FailureEvent => ({ v: 1, type: "resolved", fingerprint: fp, subject: "npm test", at: at(i), missionId: "m1", taskId: "t3" });

  it("first observation → new; repeats → persisting with streak/count; resolution → fixed; regression → persisting again", () => {
    const e1 = obs(1);
    let manifest = foldFailureManifest([e1]);
    expect(manifest).toHaveLength(1);
    let r = manifest[0] as FailureRecord;
    expect(r.status).toBe("new");
    expect(r.streak).toBe(1);
    expect(r.count).toBe(1);
    expect(isOpenFailure(r)).toBe(true);

    manifest = foldFailureManifest([e1, obs(2)]);
    r = manifest[0] as FailureRecord;
    expect(r.status).toBe("persisting");
    expect(r.count).toBe(2);
    expect(r.streak).toBe(2);
    expect(r.firstSeen).toBe(at(1));
    expect(r.lastSeen).toBe(at(2));

    manifest = foldFailureManifest([e1, obs(2), res(e1.fingerprint, 3)]);
    r = manifest[0] as FailureRecord;
    expect(r.status).toBe("fixed");
    expect(r.streak).toBe(0);
    expect(r.count).toBe(2); // total observations unchanged
    expect(r.resolvedCount).toBe(1);
    expect(isOpenFailure(r)).toBe(false);

    // 回归：修好后又犯——fixed 事实不改写，状态回 persisting、streak 重新从 1 起。
    manifest = foldFailureManifest([e1, obs(2), res(e1.fingerprint, 3), obs(4)]);
    r = manifest[0] as FailureRecord;
    expect(r.status).toBe("persisting");
    expect(r.count).toBe(3);
    expect(r.streak).toBe(1);
    expect(r.resolvedCount).toBe(1);
  });

  it("a second fix cycle bumps resolvedCount; unknown-fingerprint resolutions are ignored", () => {
    const e1 = obs(1);
    const fp = e1.fingerprint;
    const manifest = foldFailureManifest([e1, obs(2), res(fp, 3), obs(4), res(fp, 5)]);
    const r = manifest[0] as FailureRecord;
    expect(r.status).toBe("fixed");
    expect(r.resolvedCount).toBe(2);
    // A resolution naming a fingerprint never observed → no record manufactured.
    const untouched = foldFailureManifest([e1, res("deadbeef".repeat(8), 9)]);
    expect(untouched).toHaveLength(1);
    expect((untouched[0] as FailureRecord).status).toBe("new");
  });

  it("parallel failure modes stay independent (subject and stage partition)", () => {
    const gate = obs(1);
    const manual = obs(2, "write the parser", "task-fail", "环境缺依赖");
    const other = obs(3, "pnpm lint", "gate", "exit 1\\nsemicolons");
    const manifest = foldFailureManifest([gate, manual, other]);
    expect(manifest).toHaveLength(3);
    expect(new Set(manifest.map((r) => r.fingerprint)).size).toBe(3);
    // A gated task's manual fail (stage task-fail, subject=gate command) is a
    // DIFFERENT mode from its gate red — stages never conflate.
    const manualSameSubject = obs(4, "npm test", "task-fail", "等上游服务");
    expect(foldFailureManifest([gate, manualSameSubject])).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// JSONL IO + 跨重启稳定——事件是唯一持久真相；新进程重读重 fold 结果一致。
// ---------------------------------------------------------------------------

describe("failure-fingerprints.jsonl — 跨重启稳定", () => {
  it("append → read round-trip; a second reader (fresh process) folds the SAME manifest", async () => {
    const path = failureFingerprintPath(dir);
    const e1 = buildObservedEvent({ subject: "npm test", stage: "gate", cause: "exit 1", at: "2026-09-15T00:00:00.000Z", missionId: "mA", taskId: "t1" });
    const e2 = buildObservedEvent({ subject: "npm test", stage: "gate", cause: "exit 1", at: "2026-09-15T01:00:00.000Z", missionId: "mB", taskId: "t9" });
    await appendFailureEvent(path, e1);
    await appendFailureEvent(path, e2);
    const events = await readFailureEvents(path);
    expect(events).toHaveLength(2);
    // Same cause in a different mission/task → SAME fingerprint → streak 2.
    expect(events[0]!.fingerprint).toBe(events[1]!.fingerprint);
    const manifest = foldFailureManifest(events);
    expect(manifest).toHaveLength(1);
    expect((manifest[0] as FailureRecord).status).toBe("persisting");
    expect((manifest[0] as FailureRecord).lastMissionId).toBe("mB");
    // The file is JSONL (one line per event).
    const text = await readFile(path, "utf8");
    expect(text.trim().split("\n")).toHaveLength(2);
  });

  it("tolerant read: absent file → []; corrupt lines skip; malformed rows never abort", async () => {
    expect(await readFailureEvents(join(dir, "nope.jsonl"))).toEqual([]);
    const path = failureFingerprintPath(dir);
    await mkdir(join(dir, ".wudao"), { recursive: true });
    await writeFile(path, "not json\n\n{\"v\":1,\"type\":\"observed\",\"fingerprint\":\"fp\",\"subject\":\"s\",\"at\":\"t\"}\n{\"v\":9,\"type\":\"weird\"}\n", "utf8");
    const events = await readFailureEvents(path);
    // The middle row lacks stage/normalized → malformed observed → skipped.
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 用户面派生——徽章（首见零噪音）与修复知识（预算内、指纹 tag 幂等锚）。
// ---------------------------------------------------------------------------

describe("occurrenceBadge + fixedNoteContent — 用户面纯派生", () => {
  const rec = (over: Partial<FailureRecord>): FailureRecord => ({
    fingerprint: "ab".repeat(32),
    subject: "npm test",
    stage: "gate",
    normalized: "exit <n>\\nmodule 'leftpad' not found".replace("\\n", "\n"),
    count: 3,
    streak: 3,
    firstSeen: "2026-09-15T00:00:00.000Z",
    lastSeen: "2026-09-15T02:00:00.000Z",
    status: "persisting",
    resolvedCount: 0,
    ...over,
  });

  it("first occurrence → no badge (zero noise); repeats name the count", () => {
    expect(occurrenceBadge(rec({ count: 1, streak: 1, status: "new" }))).toBe("");
    expect(occurrenceBadge(rec({}))).toBe("〔该失败模式第 3 次出现，仍未修复〕");
    // 曾修复后再现 says so honestly.
    expect(occurrenceBadge(rec({ resolvedCount: 1, count: 4, streak: 1 }))).toBe("〔该失败模式第 4 次出现（曾修复后再现）〕");
  });

  it("fixedNoteContent: pitfall kind, within title/content budgets, carries the mode tag", () => {
    const note = fixedNoteContent(rec({ count: 5 }));
    expect(note.kind).toBe("pitfall");
    expect(note.title.length).toBeLessThanOrEqual(80);
    expect(note.content.length).toBeLessThanOrEqual(500);
    expect(note.content).toContain("npm test");
    expect(note.content).toContain("5 次");
    expect(note.content).toContain(note.modeTag);
    // The tag is (subject, normalized)-keyed — stage-INSENSITIVE by design:
    // the same mode fixed at gate and at ratchet deposits ONE note.
    const gateRec = rec({ stage: "gate" });
    const ratchetRec = rec({ stage: "ratchet" });
    expect(fixedNoteContent(gateRec).modeTag).toBe(fixedNoteContent(ratchetRec).modeTag);
    // Long subjects/normalized texts stay within budgets.
    const long = fixedNoteContent(rec({ subject: "z".repeat(400), normalized: "y".repeat(400) }));
    expect(long.title.length).toBeLessThanOrEqual(80);
    expect(long.content.length).toBeLessThanOrEqual(500);
  });
});

// ---------------------------------------------------------------------------
// v7 借鉴弧 γ2（digest-a 候选 2，源 CodeWhale #6162）——run-end 车道：
// 「怎么结束的」入同一账本（fold/IO 全复用），词面与失败分家（防污染）。
// ---------------------------------------------------------------------------

describe("v7 γ2 run-end 车道（怎么结束的姊妹面）", () => {
  it("run-end 观察照常 fold（同账本同状态机）；同 subject 同因=同指纹可数", () => {
    const e1 = buildObservedEvent({ subject: "计划任务 ab12", stage: "run-end", cause: "计划任务超时被终止", at: "2026-09-15T01:00:00.000Z" });
    const e2 = buildObservedEvent({ subject: "计划任务 ab12", stage: "run-end", cause: "计划任务超时被终止", at: "2026-09-15T02:00:00.000Z" });
    const manifest = foldFailureManifest([e1, e2]);
    expect(manifest).toHaveLength(1);
    expect(manifest[0]!.stage).toBe("run-end");
    expect(manifest[0]!.count).toBe(2);
    expect(manifest[0]!.status).toBe("persisting");
    expect(isOpenFailure(manifest[0]!)).toBe(true); // 未结：第 N 次被超时杀，等着被追问
  });

  it("run-end 与失败车道同 subject 不同因 → 异指纹（两账不打架）", () => {
    const runEnd = buildObservedEvent({ subject: "npm test", stage: "run-end", cause: "窗口关闭时被结束", at: "2026-09-15T01:00:00.000Z" });
    const gateFail = buildObservedEvent({ subject: "npm test", stage: "gate", cause: "退出 1", at: "2026-09-15T02:00:00.000Z" });
    const manifest = foldFailureManifest([runEnd, gateFail]);
    expect(manifest).toHaveLength(2); // stage 参与指纹——同一命令「被关窗结束」与「跑红」是两件事
  });

  it("occurrenceBadge 词面分家：run-end 说「该结束方式」，失败车道说「该失败模式」", () => {
    const rec = (over: Partial<FailureRecord>): FailureRecord => ({
      fingerprint: "ab".repeat(32), subject: "计划任务 ab12", stage: "run-end", normalized: "计划任务超时被终止",
      count: 3, streak: 3, firstSeen: "t0", lastSeen: "t1", status: "persisting", resolvedCount: 0, ...over,
    });
    expect(occurrenceBadge(rec({}))).toBe("〔该结束方式第 3 次出现，仍未修复〕");
    expect(occurrenceBadge(rec({ stage: "task-fail" }))).toBe("〔该失败模式第 3 次出现，仍未修复〕");
  });

  it("JSONL round-trip：run-end 行读写无损（parseEvent 认得新 stage）", async () => {
    const event = buildObservedEvent({ subject: "夜间重构 mission", stage: "run-end", cause: "窗口关闭时被结束", at: "2026-09-15T03:00:00.000Z" });
    await appendFailureEvent(join(dir, "fp.jsonl"), event);
    const back = await readFailureEvents(join(dir, "fp.jsonl"));
    expect(back).toHaveLength(1);
    expect(back[0]!.stage).toBe("run-end");
    expect(foldFailureManifest(back)[0]!.fingerprint).toBe(event.fingerprint);
  });
});
