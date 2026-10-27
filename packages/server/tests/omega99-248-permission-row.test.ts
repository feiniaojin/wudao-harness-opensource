// ω99-248: #2 — 权限挂起持久面的 server 侧 R 件（R3）：observe 的
// pendingPermission 证据跨重启成立后，blocked(权限) 会话被识别且 HOLD（绝
// 不 admission）；记录落定（拒绝/终局）→ 非 blocked → 正常 unfinished 路径
// claim→admit→settle；status 行携带晨间「等你决定」证据（permissionAsk）供
// web 渲染。分类器/认领/帽/间隔语义零改（242 既有钉不动——本件只钉新增证据
// 缝）。★红线：全 mock（端口是内联 fake，零真引擎零真网络），夹具只写
// tmpdir，只写不删。
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRecoveryCoordinator,
  createRecoveryJournal,
  type RecoveryObservation,
  type RecoveryPort,
  type RecoveryStatusRow,
} from "../src/recovery.js";

// ★红线（242 同款立场）：夹具只写 mkdtemp(os.tmpdir())，只写不删。
const tmp = (): string => mkdtempSync(join(tmpdir(), "o248-row-"));

const ASK = { toolName: "shell", summary: "./nightly.sh", question: "允许 shell：./nightly.sh？" };

/** The record-fed observation the cli observe now produces for a non-current
 *  session with an unsettled permission_ask entry (the cross-restart shape). */
const recordBlocked = (over: Partial<RecoveryObservation> = {}): RecoveryObservation => ({
  leaseHeldByOther: false,
  permissionPending: true,
  childPending: false,
  turnOpen: true, // the parked-ask crash shape keeps the half-turn open
  missionTerminal: false,
  dagRank: Number.POSITIVE_INFINITY,
  pendingAsk: ASK,
  ...over,
});

/** A record-settled observation: permissionPending=false（落定不复活）. */
const recordSettled = (over: Partial<RecoveryObservation> = {}): RecoveryObservation => ({
  leaseHeldByOther: false,
  permissionPending: false,
  childPending: false,
  turnOpen: true,
  missionTerminal: false,
  dagRank: Number.POSITIVE_INFINITY,
  ...over,
});

interface FakePort extends RecoveryPort {
  readonly admits: readonly string[];
  setObservation(o: RecoveryObservation): void;
}

const fakePort = (o: RecoveryObservation): FakePort => {
  const admits: string[] = [];
  let current: string | undefined;
  return {
    admits,
    setObservation(next) { o = next; },
    async bootCandidates() { return []; },
    async observe() { return o; },
    async admit(id) {
      admits.push(id);
      return { verifiedDone: 2, remaining: 1 };
    },
    currentSession: () => current,
    busy: () => false,
  };
};

const noTimer = (): ((tick: () => void, ms: number) => void) | undefined => () => {};

const journalTypes = (path: string): string[] =>
  readFileSync(path, "utf8").trim().split("\n").filter((l) => l !== "").map((l) => (JSON.parse(l) as { type: string }).type);

describe("R3 the persistent permission evidence across restarts", () => {
  it("a record-blocked session is identified AND held — no claim, no admission; the row carries the ask for the morning line", async () => {
    const dir = tmp();
    const journalPath = join(dir, "recovery.jsonl");
    // The night process's journal: the user's night submit tracked the session.
    writeFileSync(journalPath, `${JSON.stringify({ type: "admit", sessionId: "night", at: 1, user: true })}\n`, "utf8");
    const port = fakePort(recordBlocked());
    const coordinator = createRecoveryCoordinator({ journalPath, port, setTimer: noTimer() });
    await coordinator.tick();
    expect(port.admits).toEqual([]); // blocked → hold — observe only
    const rows = coordinator.status() as readonly RecoveryStatusRow[];
    expect(rows).toEqual([{ sessionId: "night", state: "blocked", permissionAsk: ASK }]);
    // No claim ever landed — the hold is durable, not just in-memory.
    expect(journalTypes(journalPath)).toEqual(["admit"]);
    await coordinator.stop();
  });

  it("the SAME verdict after a real restart shape: a SECOND coordinator over the same journal still blocks (cross-process fold)", async () => {
    const dir = tmp();
    const journalPath = join(dir, "recovery.jsonl");
    writeFileSync(journalPath, `${JSON.stringify({ type: "admit", sessionId: "night", at: 1, user: true })}\n`, "utf8");
    // The first process held (blocked) and died — its journal carries intent only.
    const a = createRecoveryCoordinator({ journalPath, port: fakePort(recordBlocked()), setTimer: noTimer() });
    await a.tick();
    expect(journalTypes(journalPath)).toEqual(["admit"]);
    await a.stop();
    // The restart: a fresh coordinator folds the same journal + the same
    // record-backed observation → still blocked, still held.
    const b = createRecoveryCoordinator({ journalPath, port: fakePort(recordBlocked()), setTimer: noTimer() });
    await b.tick();
    expect(journalTypes(journalPath)).toEqual(["admit"]); // no claim across BOTH processes
    const rows = b.status() as readonly RecoveryStatusRow[];
    expect(rows[0]?.state).toBe("blocked");
    expect((rows[0] as { permissionAsk?: typeof ASK }).permissionAsk).toEqual(ASK);
    await b.stop();
  });

  it("the record settled (deny / terminal) → NOT blocked: the unfinished path claims → admits → settles, and the row's ask is gone", async () => {
    const dir = tmp();
    const journalPath = join(dir, "recovery.jsonl");
    writeFileSync(journalPath, `${JSON.stringify({ type: "admit", sessionId: "night", at: 1, user: true })}\n`, "utf8");
    // Denied record: the fold's pending=false → the observation carries no
    // permission evidence → the classifier's blocked(权限) rule no longer fires.
    const port = fakePort(recordSettled());
    const coordinator = createRecoveryCoordinator({ journalPath, port, setTimer: noTimer() });
    await coordinator.tick();
    expect(port.admits).toEqual(["night"]); // unfinished → the admission ran
    expect(journalTypes(journalPath)).toEqual(["admit", "claim", "settle"]);
    const rows = coordinator.status() as readonly RecoveryStatusRow[];
    expect(rows[0]?.state).toBe("recovering");
    expect(rows[0]?.verifiedDone).toBe(2);
    expect(rows[0]?.remaining).toBe(1);
    expect((rows[0] as { permissionAsk?: unknown }).permissionAsk).toBeUndefined(); // the morning line's source is gone
    await coordinator.stop();
  });

  it("a mission-terminal session with a pending record stays terminal (rule order unchanged — the 242 classifier untouched)", async () => {
    const dir = tmp();
    const journalPath = join(dir, "recovery.jsonl");
    writeFileSync(journalPath, `${JSON.stringify({ type: "admit", sessionId: "night", at: 1, user: true })}\n`, "utf8");
    const port = fakePort(recordBlocked({ missionTerminal: true }));
    const coordinator = createRecoveryCoordinator({ journalPath, port, setTimer: noTimer() });
    await coordinator.tick();
    expect(port.admits).toEqual([]);
    // terminal outranks blocked — the session is untracked honestly.
    expect(coordinator.status()).toEqual([]);
    await coordinator.stop();
  });

  it("the journal fold alone (no in-memory state) reads back the same hold posture — the evidence is on disk", async () => {
    const dir = tmp();
    const journalPath = join(dir, "recovery.jsonl");
    writeFileSync(journalPath, `${JSON.stringify({ type: "admit", sessionId: "night", at: 1, user: true })}\n`, "utf8");
    const fold = await createRecoveryJournal(journalPath).fold();
    expect(fold.sessions.get("night")).toMatchObject({ tracked: true, claimPending: false, checkpointed: false });
  });
});
