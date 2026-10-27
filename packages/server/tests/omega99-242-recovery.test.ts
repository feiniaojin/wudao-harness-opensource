// ω99-242: #1 — 中断任务自动续跑（重启不丢托付）的服务面 R 件：R1 journal
// 状态机 / R2 分类器表测 / R3 认领纪律 / R5 限流与作废 / R7 mission 拓扑序。
// ★红线：全 mock——端口是本文件内联的 fake（observe/admit 只记录调用，不触
// 真引擎、不真文件副作用）；journal 夹具只写 tmpdir；绝不删用户文件。
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRecoveryJournal,
  classifyRecovery,
  createRecoveryCoordinator,
  RECOVERY_CONCURRENCY,
  RECOVERY_INTERVAL_MS,
  type RecoveryObservation,
  type RecoveryPort,
  type RecoveryJournalEntry,
} from "../src/recovery.js";
import { createUiServer, type UiDriverPort, type UiServer, type UiRecoveryPort } from "../src/index.js";
import WebSocket from "ws";

// ★红线（ω99-236 同款立场）：夹具只写 mkdtemp(os.tmpdir())，只写不删——
// 开发/测试代码绝不 rm 用户文件/文件夹，自建临时目录交 OS 清理。
const tmp = (): string => mkdtempSync(join(tmpdir(), "o242-recovery-"));

/** The default observation shape — every field overridable per case. */
const obs = (over: Partial<RecoveryObservation> = {}): RecoveryObservation => ({
  leaseHeldByOther: false,
  permissionPending: false,
  childPending: false,
  turnOpen: false,
  missionTerminal: false,
  dagRank: Number.POSITIVE_INFINITY,
  ...over,
});

// ---------------------------------------------------------------------------
// R1 — journal 状态机：admit/settle/checkpoint/claim/cancel 序列；append-only；
// 坏行跳过诚实（解析失败行不炸协调器）。
// ---------------------------------------------------------------------------
describe("R1 journal state machine", () => {
  it("folds admit→checkpoint→claim→settle→cancel sequences into per-session state", async () => {
    const dir = tmp();
    const j = createRecoveryJournal(join(dir, "recovery.jsonl"));
    await j.append({ type: "admit", sessionId: "s1", at: 1 });
    await j.append({ type: "checkpoint", sessionId: "s1", at: 2 });
    let fold = await j.fold();
    expect(fold.sessions.get("s1")).toMatchObject({ tracked: true, checkpointed: true, claimPending: false });
    await j.append({ type: "claim", sessionId: "s1", at: 3 });
    fold = await j.fold();
    // claim supersedes the checkpoint intent and stands until settle/cancel.
    expect(fold.sessions.get("s1")).toMatchObject({ tracked: true, checkpointed: false, claimPending: true });
    await j.append({ type: "settle", sessionId: "s1", at: 4, verifiedDone: 3, remaining: 2 });
    fold = await j.fold();
    expect(fold.sessions.get("s1")).toMatchObject({ tracked: true, checkpointed: false, claimPending: false, verifiedDone: 3, remaining: 2 });
    await j.append({ type: "cancel", sessionId: "s1", at: 5, reason: "terminal" });
    fold = await j.fold();
    expect(fold.sessions.get("s1")).toMatchObject({ tracked: false, checkpointed: false, claimPending: false });
  });

  it("a fresh user admit consumes a standing checkpoint intent (user takeover supersedes the shutdown freeze)", async () => {
    const dir = tmp();
    const j = createRecoveryJournal(join(dir, "recovery.jsonl"));
    await j.append({ type: "checkpoint", sessionId: "s1", at: 1 });
    await j.append({ type: "admit", sessionId: "s1", at: 2, user: true });
    const fold = await j.fold();
    expect(fold.sessions.get("s1")).toMatchObject({ tracked: true, checkpointed: false });
  });

  it("append-only: earlier bytes are never rewritten (the file only grows)", async () => {
    const dir = tmp();
    const path = join(dir, "recovery.jsonl");
    const j = createRecoveryJournal(path);
    await j.append({ type: "admit", sessionId: "s1", at: 1 });
    const afterFirst = readFileSync(path, "utf8");
    await j.append({ type: "checkpoint", sessionId: "s2", at: 2 });
    const afterSecond = readFileSync(path, "utf8");
    expect(afterSecond.startsWith(afterFirst)).toBe(true);
    expect(afterSecond.length).toBeGreaterThan(afterFirst.length);
  });

  it("skips unparseable/ill-shaped lines honestly — counted, never thrown", async () => {
    const dir = tmp();
    const path = join(dir, "recovery.jsonl");
    writeFileSync(path, [
      JSON.stringify({ type: "admit", sessionId: "s1", at: 1 }),
      "{not json at all",
      JSON.stringify({ type: "unknown-thing", sessionId: "s2", at: 2 }),
      JSON.stringify({ type: "claim" }), // missing sessionId/at — shape-refused
      JSON.stringify({ type: "claim", sessionId: "s3", at: 3 }),
      "",
    ].join("\n"), "utf8");
    const j = createRecoveryJournal(path);
    const fold = await j.fold();
    expect(fold.skippedLines).toBe(4);
    expect(fold.sessions.size).toBe(2);
    expect(fold.sessions.get("s3")?.claimPending).toBe(true);
  });

  it("journal writes survive a not-yet-existing directory (mkdir-before-append)", async () => {
    const dir = tmp();
    const nested = join(dir, "deep", "wudao");
    mkdirSync(nested, { recursive: true });
    const j = createRecoveryJournal(join(nested, "recovery.jsonl"));
    await j.append({ type: "admit", sessionId: "s1", at: 1 });
    expect((await j.fold()).sessions.get("s1")?.tracked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R2 — 分类器表测：terminal/blocked（权限挂起、父等子）/active/unfinished 全
// 矩阵；idle 无半轮证据→不恢复 的负钉；checkpoint 后 abort→恢复。
// ---------------------------------------------------------------------------
describe("R2 classifier table", () => {
  const tracked = { checkpointed: false, claimPending: false };

  it("terminal: mission ledger terminal → untouched", () => {
    const c = classifyRecovery(obs({ missionTerminal: true, turnOpen: true }), tracked);
    expect(c).toEqual({ state: "terminal", recoverable: false });
  });

  it("blocked: permission pending → not independently recovered", () => {
    const c = classifyRecovery(obs({ permissionPending: true, turnOpen: true }), tracked);
    expect(c).toEqual({ state: "blocked", recoverable: false });
  });

  it("blocked: delegated child unresolved (父等子) → not independently recovered", () => {
    const c = classifyRecovery(obs({ childPending: true, turnOpen: true }), tracked);
    expect(c).toEqual({ state: "blocked", recoverable: false });
  });

  it("active: another live process holds the lease → observe only, never re-send (beats every other signal)", () => {
    const c = classifyRecovery(obs({ leaseHeldByOther: true, turnOpen: true, permissionPending: true }), tracked);
    expect(c).toEqual({ state: "active", recoverable: false });
  });

  it("lost-ack (claim without settle, across restart) → blocked before every other rule — never re-admitted", () => {
    const c = classifyRecovery(obs({ turnOpen: true, leaseHeldByOther: true }), { checkpointed: true, claimPending: true });
    expect(c).toEqual({ state: "blocked", recoverable: false });
  });

  it("unfinished: the same open turn (half-turn evidence) → recoverable", () => {
    const c = classifyRecovery(obs({ turnOpen: true }), tracked);
    expect(c).toEqual({ state: "unfinished", recoverable: true });
  });

  it("unfinished: our own shutdown checkpoint stands → recoverable (checkpoint 后 abort→恢复)", () => {
    const c = classifyRecovery(obs({ turnOpen: false }), { checkpointed: true, claimPending: false });
    expect(c).toEqual({ state: "unfinished", recoverable: true });
  });

  it("negative pin: idle alone is NOT evidence — closed turn, no checkpoint → terminal, never recovered", () => {
    const c = classifyRecovery(obs({ turnOpen: false }), tracked);
    expect(c).toEqual({ state: "terminal", recoverable: false });
  });
});

// ---------------------------------------------------------------------------
// The fake port — every observe/admit is recorded; nothing real is touched.
// ---------------------------------------------------------------------------
interface FakePort extends RecoveryPort {
  readonly admits: string[];
  readonly observed: string[];
  setSession(id: string, o: Partial<RecoveryObservation>): void;
  setCurrent(id: string | undefined): void;
  setBusy(v: boolean): void;
}

function fakePort(script: Record<string, Partial<RecoveryObservation>> = {}): FakePort {
  const observations = new Map<string, RecoveryObservation | undefined>(
    Object.entries(script).map(([id, o]) => [id, obs(o)]),
  );
  const admits: string[] = [];
  const observed: string[] = [];
  let current: string | undefined;
  let busy = false;
  return {
    admits,
    observed,
    setSession(id, o) { observations.set(id, obs(o)); },
    setCurrent(id) { current = id; },
    setBusy(v) { busy = v; },
    async bootCandidates() { return Object.keys(script); },
    async observe(id) {
      observed.push(id);
      return observations.get(id);
    },
    async admit(id) {
      admits.push(id);
      return { verifiedDone: 1, remaining: 1 };
    },
    currentSession: () => current,
    busy: () => busy,
  };
}

/** A mutable test clock. */
const clock = (start = 0): { now(): number; advance(ms: number): void } => {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
};

/** Let fire-and-forget journal IO (noteUserInput) land before asserting. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

/** Tests drive ticks by hand — the interval timer is never installed. */
const noTimer = (): ((tick: () => void, ms: number) => void) | undefined => () => {};

interface BootOpts {
  journalLines?: readonly string[];
  script?: Record<string, Partial<RecoveryObservation>>;
  now?: () => number;
  intervalMs?: number;
}

const boot = async (opts: BootOpts = {}): Promise<{
  coordinator: ReturnType<typeof createRecoveryCoordinator>;
  port: FakePort;
  journalPath: string;
}> => {
  const dir = tmp();
  const journalPath = join(dir, "recovery.jsonl");
  if (opts.journalLines !== undefined && opts.journalLines.length > 0) {
    writeFileSync(journalPath, opts.journalLines.join("\n") + "\n", "utf8");
  }
  const port = fakePort(opts.script ?? {});
  const coordinator = createRecoveryCoordinator({
    journalPath,
    port,
    setTimer: noTimer(),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.intervalMs !== undefined ? { intervalMs: opts.intervalMs } : {}),
  });
  await coordinator.tick();
  return { coordinator, port, journalPath };
};

const entry = (e: RecoveryJournalEntry): string => JSON.stringify(e);
const checkpointLines = (ids: readonly string[]): string[] => ids.map((id) => entry({ type: "checkpoint", sessionId: id, at: 1 }));

// ---------------------------------------------------------------------------
// R3 — 认领纪律：claim 先落盘再 admission（顺序断言）；丢 ack 条目二次重启→
// blocked 不重试。
// ---------------------------------------------------------------------------
describe("R3 claim discipline", () => {
  it("claims durably BEFORE admission — journal order is checkpoint→claim→settle, the claim line is on disk when admit runs", async () => {
    const dir = tmp();
    const journalPath = join(dir, "recovery.jsonl");
    writeFileSync(journalPath, entry({ type: "checkpoint", sessionId: "s1", at: 1 }) + "\n", "utf8");
    const port = fakePort({ s1: { turnOpen: true } });
    // At admit time the journal file must ALREADY end with the claim line —
    // the exact "claim 先落盘再 admission" order assertion.
    let lastLineAtAdmit: string | undefined;
    const wrapped: RecoveryPort = {
      bootCandidates: port.bootCandidates,
      observe: port.observe,
      admit: async (id) => {
        lastLineAtAdmit = readFileSync(journalPath, "utf8").trim().split("\n").pop();
        return port.admit(id);
      },
      currentSession: port.currentSession,
      busy: port.busy,
    };
    const coordinator = createRecoveryCoordinator({ journalPath, port: wrapped, setTimer: noTimer() });
    await coordinator.tick();
    expect(port.admits).toEqual(["s1"]);
    expect(JSON.parse(lastLineAtAdmit ?? "{}") as { type?: string }).toMatchObject({ type: "claim" });
    const lines = readFileSync(journalPath, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { type: string }).type);
    expect(lines).toEqual(["checkpoint", "claim", "settle"]);
  });

  it("a lost ack (claim without settle) is NEVER re-admitted — not this boot, not the next", async () => {
    const claimOnly = [entry({ type: "checkpoint", sessionId: "s1", at: 1 }), entry({ type: "claim", sessionId: "s1", at: 2 })];
    const first = await boot({ journalLines: claimOnly, script: { s1: { turnOpen: true } } });
    expect(first.port.admits).toEqual([]);
    expect(first.coordinator.status().find((r) => r.sessionId === "s1")?.state).toBe("blocked");
    const second = await boot({ journalLines: claimOnly, script: { s1: { turnOpen: true } } });
    expect(second.port.admits).toEqual([]);
    expect(second.coordinator.status().find((r) => r.sessionId === "s1")?.state).toBe("blocked");
  });

  it("a settle ACK frees the session for the ordinary lifecycle (not lost-ack blocked)", async () => {
    const { coordinator } = await boot({
      journalLines: [
        entry({ type: "checkpoint", sessionId: "s1", at: 1 }),
        entry({ type: "claim", sessionId: "s1", at: 2 }),
        entry({ type: "settle", sessionId: "s1", at: 3, verifiedDone: 2, remaining: 0 }),
      ],
      script: { s1: { turnOpen: false } },
    });
    // Settled + closed turn → terminal: cancelled out, never blocked.
    expect(coordinator.status().find((r) => r.sessionId === "s1")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// R5 — 限流与作废：并发帽 2 + 启动间隔；用户手工输入→作废（权限回复例外）。
// ---------------------------------------------------------------------------
describe("R5 rate limiting and invalidation", () => {
  it("pins the exported limits: concurrency 2, interval 2000ms", () => {
    expect(RECOVERY_CONCURRENCY).toBe(2);
    expect(RECOVERY_INTERVAL_MS).toBe(2_000);
  });

  it("caps in-flight recoveries at 2 — the third waits until a slot frees", async () => {
    const c = clock(10_000);
    const { coordinator, port } = await boot({
      journalLines: checkpointLines(["a", "b", "c"]),
      script: { a: { turnOpen: true }, b: { turnOpen: true }, c: { turnOpen: true } },
      now: c.now,
      intervalMs: 2_000,
    });
    // One admission per interval — a first, then b.
    expect(port.admits).toEqual(["a"]);
    c.advance(2_000);
    await coordinator.tick();
    expect(port.admits).toEqual(["a", "b"]);
    // Cap reached: further ticks admit nothing while both are in flight.
    c.advance(2_000);
    await coordinator.tick();
    c.advance(2_000);
    await coordinator.tick();
    expect(port.admits).toEqual(["a", "b"]);
    // The recovered runs settle (turn closed) → slots free → c recovers.
    port.setSession("a", { turnOpen: false });
    port.setSession("b", { turnOpen: false });
    c.advance(2_000);
    await coordinator.tick();
    expect(port.admits).toEqual(["a", "b", "c"]);
    await coordinator.stop();
  });

  it("spaces admission starts by the interval — a too-early tick admits nothing", async () => {
    const c = clock(10_000);
    const { coordinator, port } = await boot({
      journalLines: checkpointLines(["a", "b"]),
      script: { a: { turnOpen: true }, b: { turnOpen: true } },
      now: c.now,
      intervalMs: 2_000,
    });
    expect(port.admits).toEqual(["a"]);
    c.advance(1_999); // one ms short
    await coordinator.tick();
    expect(port.admits).toEqual(["a"]);
    c.advance(1);
    await coordinator.tick();
    expect(port.admits).toEqual(["a", "b"]);
    await coordinator.stop();
  });

  it("manual user input cancels the pending recovery of the session the user took over", async () => {
    const dir = tmp();
    const journalPath = join(dir, "recovery.jsonl");
    writeFileSync(journalPath, entry({ type: "checkpoint", sessionId: "s1", at: 1 }) + "\n", "utf8");
    const port = fakePort({ s1: { turnOpen: true } });
    const coordinator = createRecoveryCoordinator({ journalPath, port, setTimer: noTimer() });
    port.setCurrent("s1");
    coordinator.noteUserInput();
    await flush(); // the fire-and-forget journal IO lands
    await coordinator.tick();
    expect(port.admits).toEqual([]); // the pending intent died with the takeover
    // But the session STAYS tracked for the next crash (the user is driving it).
    const fold = await createRecoveryJournal(journalPath).fold();
    expect(fold.sessions.get("s1")).toMatchObject({ tracked: true, checkpointed: false, claimPending: false });
    await coordinator.stop();
  });

  it("a manual input after a settled recovery must not poison the claim discipline", async () => {
    const dir = tmp();
    const journalPath = join(dir, "recovery.jsonl");
    writeFileSync(journalPath, entry({ type: "checkpoint", sessionId: "s1", at: 1 }) + "\n", "utf8");
    const port = fakePort({ s1: { turnOpen: true } });
    const coordinator = createRecoveryCoordinator({ journalPath, port, intervalMs: 1, setTimer: noTimer() });
    await coordinator.tick(); // claims + admits + settles
    expect(port.admits).toEqual(["s1"]);
    port.setCurrent("s1");
    coordinator.noteUserInput(); // user takes the wheel post-settle
    const fold = await createRecoveryJournal(journalPath).fold();
    expect(fold.sessions.get("s1")?.claimPending).toBe(false);
    expect(fold.sessions.get("s1")?.tracked).toBe(true);
    await coordinator.stop();
  });

  it("observes fairly: a large backlog rotates (bounded reads per tick, everyone covered across ticks)", async () => {
    const ids = ["s1", "s2", "s3", "s4", "s5"];
    const script: Record<string, Partial<RecoveryObservation>> = {};
    for (const id of ids) script[id] = { permissionPending: true }; // blocked → held, no cancels
    const first = await boot({ journalLines: ids.map((id) => entry({ type: "admit", sessionId: id, at: 1 })), script });
    expect(first.port.observed.length).toBeLessThan(ids.length); // bounded per tick
    for (let i = 0; i < 6; i += 1) await first.coordinator.tick();
    for (const id of ids) expect(first.port.observed).toContain(id); // rotation covers everyone
    await first.coordinator.stop();
  });
});

// ---------------------------------------------------------------------------
// R7 — mission 拓扑序：三任务 DAG（B 依赖 A）恢复序 A→B（拓扑非轮询）。
// ---------------------------------------------------------------------------
describe("R7 mission DAG topological order", () => {
  it("admits the dependency's session BEFORE the dependent's — not the journal tracking order", async () => {
    const c = clock(10_000);
    // Journal tracks B FIRST (the polling order); the DAG says A (rank 0)
    // precedes B (rank 1, dependsOn A).
    const { port, coordinator } = await boot({
      journalLines: checkpointLines(["sB", "sA"]),
      script: { sB: { turnOpen: true, dagRank: 1 }, sA: { turnOpen: true, dagRank: 0 } },
      now: c.now,
      intervalMs: 2_000,
    });
    expect(port.admits).toEqual(["sA"]); // the FIRST admission is A, not sB
    c.advance(2_000);
    await coordinator.tick();
    expect(port.admits).toEqual(["sA", "sB"]); // then B — topological, not polling
    await coordinator.stop();
  });

  it("an unranked (mission-unbound) session recovers after every mission-bound one", async () => {
    const c = clock(10_000);
    const { port, coordinator } = await boot({
      journalLines: checkpointLines(["sB", "sC", "sA"]),
      script: {
        sB: { turnOpen: true, dagRank: 1 },
        sC: { turnOpen: true, dagRank: Number.POSITIVE_INFINITY },
        sA: { turnOpen: true, dagRank: 0 },
      },
      now: c.now,
      intervalMs: 2_000,
    });
    expect(port.admits).toEqual(["sA"]);
    c.advance(2_000);
    await coordinator.tick();
    expect(port.admits).toEqual(["sA", "sB"]);
    // The cap (2 in flight) holds sC back until the mission-bound runs settle.
    c.advance(2_000);
    await coordinator.tick();
    expect(port.admits).toEqual(["sA", "sB"]);
    port.setSession("sA", { turnOpen: false });
    port.setSession("sB", { turnOpen: false });
    c.advance(2_000);
    await coordinator.tick();
    expect(port.admits).toEqual(["sA", "sB", "sC"]);
    await coordinator.stop();
  });
});

// ---------------------------------------------------------------------------
// The graceful-shutdown checkpoint (invariant 3) + the status surface (R6's
// structured data source).
// ---------------------------------------------------------------------------
describe("shutdown checkpoint and status", () => {
  it("stop() freezes the in-flight session BEFORE the engine dies (journal carries the checkpoint)", async () => {
    const dir = tmp();
    const journalPath = join(dir, "recovery.jsonl");
    const port = fakePort({});
    port.setCurrent("night");
    port.setBusy(true);
    const coordinator = createRecoveryCoordinator({ journalPath, port, setTimer: noTimer() });
    await coordinator.stop();
    const fold = await createRecoveryJournal(journalPath).fold();
    expect(fold.sessions.get("night")).toMatchObject({ tracked: true, checkpointed: true });
    await coordinator.stop(); // idempotent — exactly one line, no second write
    const lines = readFileSync(journalPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
  });

  it("stop() skips the checkpoint when no run is in flight (idle ≠ intent)", async () => {
    const dir = tmp();
    const journalPath = join(dir, "recovery.jsonl");
    const port = fakePort({});
    port.setCurrent("idle-session");
    const coordinator = createRecoveryCoordinator({ journalPath, port, setTimer: noTimer() });
    await coordinator.stop();
    expect(() => readFileSync(journalPath, "utf8")).toThrow();
  });

  it("status() reports the settle counts verbatim (the web counts X/Y from here, never fabricates)", async () => {
    const { coordinator } = await boot({
      journalLines: checkpointLines(["s1"]),
      script: { s1: { turnOpen: true } },
      intervalMs: 1,
    });
    const row = coordinator.status().find((r) => r.sessionId === "s1");
    expect(row).toMatchObject({ sessionId: "s1", verifiedDone: 1, remaining: 1 });
    await coordinator.stop();
  });
});

// ---------------------------------------------------------------------------
// The PROTOCOL boundary: the submit op is the ONE manual-input seam (the
// permission-reply exception lives here — answerPermission must NOT cancel).
// ---------------------------------------------------------------------------
describe("protocol boundary", () => {
  const uiServers: UiServer[] = [];
  afterEach(async () => {
    for (const s of uiServers.splice(0)) await s.close();
  });

  /** The scripted driver from server.test.ts's minimal subset. */
  const minimalDriver = (): UiDriverPort => {
    const cbs = new Set<() => void>();
    let status: Record<string, unknown> = { live: { reasoning: "", answer: "", busyTools: [] }, busy: false, mode: "workspace" };
    let history: unknown[] = [];
    return {
      subscribe: (cb) => (cbs.add(cb), () => cbs.delete(cb)),
      getStatus: () => status,
      getHistory: () => history,
      onHistory: (cb) => () => void cb,
      onLoopEvent: () => () => undefined,
      submit: (text: string) => {
        history = [...history, { kind: "user", text }];
        return "started";
      },
      interrupt: () => {},
      setMode: () => {},
      answerPermission: () => false,
      listSlashCommands: () => [],
      sessions: async () => [],
      resume: async () => ({ ok: true }),
      rewind: async () => "",
      beginEdit: () => undefined,
      tree: async () => "",
      switchBranch: async () => "",
    };
  };

  const mounted = (): { notes: string[]; recovery: UiRecoveryPort } => {
    const notes: string[] = [];
    return {
      notes,
      recovery: {
        noteUserInput: () => { notes.push("user-input"); },
        status: () => [{ sessionId: "s1", state: "recovering", verifiedDone: 3, remaining: 2 }],
        stop: async () => { notes.push("stop"); },
      },
    };
  };

  const waitFrame = async (frames: unknown[], id: number): Promise<{ ok?: unknown; err?: string }> => {
    for (let i = 0; i < 100; i += 1) {
      const f = frames.find((f) => (f as { t?: string; id?: unknown }).t === "result" && (f as { id?: unknown }).id === id);
      if (f !== undefined) return f as { ok?: unknown; err?: string };
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("no result frame");
  };

  it("a client submit fires noteUserInput BEFORE the engine sees it; answerPermission NEVER does (the exception)", async () => {
    const { notes, recovery } = mounted();
    const server = await createUiServer({ driver: minimalDriver(), recovery, token: "t" });
    uiServers.push(server);
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const frames: unknown[] = [];
    await new Promise<void>((r) => ws.once("open", r));
    ws.on("message", (d) => frames.push(JSON.parse(String(d))));
    ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await new Promise((r) => setTimeout(r, 30));
    ws.send(JSON.stringify({ t: "op", id: 1, op: { op: "submit", text: "manual" } }));
    await waitFrame(frames, 1);
    expect(notes).toEqual(["user-input"]);
    ws.send(JSON.stringify({ t: "op", id: 2, op: { op: "answerPermission", allow: true } }));
    await waitFrame(frames, 2);
    expect(notes).toEqual(["user-input"]); // the permission reply cancelled nothing
    ws.send(JSON.stringify({ t: "op", id: 3, op: { op: "submit" } })); // no text — shape-refused
    await new Promise((r) => setTimeout(r, 30));
    expect(notes).toEqual(["user-input"]); // a REFUSED submit (bad shape) never fires the seam
    ws.close();
  });

  it("recoveryStatus relays the coordinator's rows; an unmounted server answers not-supported", async () => {
    const { recovery } = mounted();
    const server = await createUiServer({ driver: minimalDriver(), recovery, token: "t" });
    uiServers.push(server);
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const frames: unknown[] = [];
    await new Promise<void>((r) => ws.once("open", r));
    ws.on("message", (d) => frames.push(JSON.parse(String(d))));
    ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await new Promise((r) => setTimeout(r, 30));
    ws.send(JSON.stringify({ t: "op", id: 1, op: { op: "recoveryStatus" } }));
    const r1 = await waitFrame(frames, 1);
    expect(r1.ok).toEqual([{ sessionId: "s1", state: "recovering", verifiedDone: 3, remaining: 2 }]);
    ws.close();
    await server.close();
    const bare = await createUiServer({ driver: minimalDriver(), token: "t" });
    uiServers.push(bare);
    const ws2 = new WebSocket(`ws://127.0.0.1:${bare.port}`);
    const frames2: unknown[] = [];
    await new Promise<void>((r) => ws2.once("open", r));
    ws2.on("message", (d) => frames2.push(JSON.parse(String(d))));
    ws2.send(JSON.stringify({ t: "auth", token: "t" }));
    await new Promise((r) => setTimeout(r, 30));
    ws2.send(JSON.stringify({ t: "op", id: 1, op: { op: "recoveryStatus" } }));
    const r2 = await waitFrame(frames2, 1);
    expect(r2.err).toBe("recovery not supported by this server");
    ws2.close();
  });
});
