// ω-3a — the mutation idempotency vault (adapted from the upstream project's WS vault).
// Ops that carry a client-instance qualifier (`cid`) and name a MUTATION are
// keyed by `cid` + the envelope's op id: a retry with the same payload digest
// JOINS the in-flight execution (never re-executes), a retry after completion
// replays the cached result (TTL 5 min, max 256, pruned oldest), and the same
// id with a DIFFERENT payload gets an explicit conflict error (the wudao
// analog of the upstream project's 409 — the existing err-string envelope). Reads and
// cid-less (old-client) ops are never vaulted: a cached read would serve
// stale data, and old clients keep today's execute-every-frame behavior.
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { createUiServer, type ResumeOutcome, type UiDriverPort, type UiServer } from "../src/index.js";

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

/** A counting driver: submit/interrupt/sessions/beginEdit tally calls; resume
 *  parks on a manually-deferred promise so the in-flight join window is
 *  observable. */
function countingDriver(): UiDriverPort & {
  submits: string[];
  interrupts: number;
  sessionsCalls: number;
  resumes: string[];
  edits: number[];
  resolveResume(v: ResumeOutcome): void;
} {
  let statusCbs = new Set<() => void>();
  let historyCbs = new Set<(entries: readonly unknown[], reset: boolean) => void>();
  let eventCbs = new Set<(event: unknown) => void>();
  const submits: string[] = [];
  let interrupts = 0;
  let sessionsCalls = 0;
  const resumes: string[] = [];
  const edits: number[] = [];
  let releaseResume: ((v: boolean) => void) | null = null;
  const resumePending = new Promise<void>((resolve) => {
    releaseResume = resolve;
  });
  let resumeValue = new Promise<ResumeOutcome>(() => {});
  return {
    submits,
    get interrupts() {
      return interrupts;
    },
    get sessionsCalls() {
      return sessionsCalls;
    },
    resumes,
    edits,
    resolveResume(v: ResumeOutcome) {
      resumeValue = Promise.resolve(v);
      releaseResume?.();
    },
    subscribe: (cb) => (statusCbs.add(cb), () => statusCbs.delete(cb)),
    getStatus: () => ({ live: { reasoning: "", answer: "", busyTools: [] }, busy: false, mode: "default" }),
    getHistory: () => [],
    onHistory: (cb) => (historyCbs.add(cb), () => historyCbs.delete(cb)),
    onLoopEvent: (cb) => (eventCbs.add(cb), () => eventCbs.delete(cb)),
    submit: (text: string) => {
      submits.push(text);
      return "started";
    },
    interrupt: () => {
      interrupts += 1;
    },
    setMode: () => {},
    answerPermission: () => false,
    listSlashCommands: () => [],
    sessions: async () => {
      sessionsCalls += 1;
      return [];
    },
    resume: (id: string) => {
      resumes.push(id);
      return resumePending.then(() => resumeValue);
    },
    rewind: async () => "rewound",
    beginEdit: (n: number) => {
      edits.push(n);
      return `original text of message ${n}`;
    },
    tree: async () => "tree",
    switchBranch: async () => "switched",
  };
}

interface Frame {
  t: string;
  id?: unknown;
  ok?: unknown;
  err?: string;
  entries?: unknown[];
  reset?: boolean;
}

function connect(port: number): { ws: WebSocket; frames: Frame[]; closed: Promise<{ code: number; reason: string }>; open: Promise<void> } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames: Frame[] = [];
  const open = new Promise<void>((resolve) => ws.once("open", resolve));
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.once("close", (code, reason) => resolve({ code, reason: String(reason) })));
  ws.on("message", (data) => frames.push(JSON.parse(String(data)) as Frame));
  return { ws, frames, closed, open };
}

function auth(ws: WebSocket, token: string): void {
  ws.send(JSON.stringify({ t: "auth", token }));
}

/** An authed connection ready to send ops. */
async function authed(port: number, token: string): Promise<ReturnType<typeof connect>> {
  const c = connect(port);
  await c.open;
  auth(c.ws, token);
  await until(() => c.frames.some((f) => f.t === "history" && f.reset === true), "initial replay");
  return c;
}

const sendOp = (ws: WebSocket, frame: Record<string, unknown>): void => {
  ws.send(JSON.stringify({ t: "op", ...frame }));
};

const results = (frames: Frame[], id: unknown): Frame[] => frames.filter((f) => f.t === "result" && f.id === id);

describe("ω-3a mutation idempotency vault", () => {
  it("same id + same payload twice while in-flight → ONE execution, both callers get the result (join)", async () => {
    const driver = countingDriver();
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = await authed(server.port, "t");

    sendOp(c.ws, { id: 7, cid: "client-a", op: { op: "resume", id: "sess-1" } });
    sendOp(c.ws, { id: 7, cid: "client-a", op: { op: "resume", id: "sess-1" } });
    await wait(50); // both frames processed; the op is parked in-flight
    expect(results(c.frames, 7)).toHaveLength(0); // no result until the driver settles

    driver.resolveResume({ ok: true });
    await until(() => results(c.frames, 7).length === 2, "both joined results");
    expect(driver.resumes).toEqual(["sess-1"]); // executed exactly once
    expect(results(c.frames, 7).map((f) => f.ok)).toEqual([{ ok: true }, { ok: true }]); // ω99-225: outcome 对象
    c.ws.close();
  });

  it("same id + different payload (or different action) → explicit conflict error, no second execution", async () => {
    const driver = countingDriver();
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = await authed(server.port, "t");

    sendOp(c.ws, { id: 8, cid: "client-a", op: { op: "submit", text: "A" } });
    await until(() => results(c.frames, 8).length === 1, "first submit result");
    expect(driver.submits).toEqual(["A"]);

    sendOp(c.ws, { id: 8, cid: "client-a", op: { op: "submit", text: "B" } });
    await until(() => results(c.frames, 8).length === 2, "conflict result");
    expect(results(c.frames, 8)[1]?.err ?? "").toMatch(/conflict/);
    expect(driver.submits).toEqual(["A"]); // B never executed

    sendOp(c.ws, { id: 8, cid: "client-a", op: { op: "interrupt" } });
    await until(() => results(c.frames, 8).length === 3, "cross-action conflict result");
    expect(results(c.frames, 8)[2]?.err ?? "").toMatch(/conflict/);
    expect(driver.interrupts).toBe(0);
    c.ws.close();
  });

  it("completed result is re-served after a reconnect without re-execution (TTL cache)", async () => {
    const driver = countingDriver();
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c1 = await authed(server.port, "t");

    sendOp(c1.ws, { id: 5, cid: "client-a", op: { op: "submit", text: "w node -v" } });
    await until(() => results(c1.frames, 5).length === 1, "submit result");
    expect(results(c1.frames, 5)[0]?.ok).toBe("started");
    expect(driver.submits).toEqual(["w node -v"]);

    c1.ws.close();
    await c1.closed;
    await wait(30); // let the server release the single-client slot

    const c2 = await authed(server.port, "t");
    sendOp(c2.ws, { id: 5, cid: "client-a", op: { op: "submit", text: "w node -v" } });
    await until(() => results(c2.frames, 5).length === 1, "cached result on reconnect");
    expect(results(c2.frames, 5)[0]?.ok).toBe("started");
    expect(driver.submits).toEqual(["w node -v"]); // NOT re-executed
    c2.ws.close();
  });

  it("in-flight mutation survives the drop: the retry on the NEW socket joins and resolves there", async () => {
    const driver = countingDriver();
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c1 = await authed(server.port, "t");

    sendOp(c1.ws, { id: 9, cid: "client-a", op: { op: "resume", id: "sess-9" } });
    await wait(30); // in-flight, result not yet produced
    c1.ws.close();
    await c1.closed;
    await wait(30);

    const c2 = await authed(server.port, "t");
    sendOp(c2.ws, { id: 9, cid: "client-a", op: { op: "resume", id: "sess-9" } });
    await wait(30); // joined the original in-flight execution
    driver.resolveResume({ ok: true });
    await until(() => results(c2.frames, 9).length === 1, "joined result on the new socket");
    expect(results(c2.frames, 9)[0]?.ok).toEqual({ ok: true });
    expect(driver.resumes).toEqual(["sess-9"]); // one execution across both sockets
    c2.ws.close();
  });

  it("an expired completed entry is forgotten → the retry re-executes (TTL bound)", async () => {
    const driver = countingDriver();
    let clock = 1_000_000;
    const server = await createUiServer({ driver, token: "t", idempotency: { now: () => clock } });
    servers.push(server);
    const c = await authed(server.port, "t");

    sendOp(c.ws, { id: 5, cid: "client-a", op: { op: "submit", text: "once" } });
    await until(() => results(c.frames, 5).length === 1, "first result");
    expect(driver.submits).toEqual(["once"]);

    clock += 300_000; // the default TTL elapses
    sendOp(c.ws, { id: 5, cid: "client-a", op: { op: "submit", text: "once" } });
    await until(() => results(c.frames, 5).length === 2, "post-TTL result");
    expect(driver.submits).toEqual(["once", "once"]); // re-executed after expiry
    c.ws.close();
  });

  it("256-entry cap: the oldest completed entry is pruned, recent ones stay cached", async () => {
    const driver = countingDriver();
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = await authed(server.port, "t");

    // 257 completed mutations (ids 1..257) → the 257th insert evicts id 1
    // (keep the newest 256).
    for (let id = 1; id <= 257; id++) sendOp(c.ws, { id, cid: "client-a", op: { op: "interrupt" } });
    await until(() => driver.interrupts === 257, "all 257 executed");

    sendOp(c.ws, { id: 1, cid: "client-a", op: { op: "interrupt" } });
    await until(() => driver.interrupts === 258, "evicted entry re-executed");
    sendOp(c.ws, { id: 257, cid: "client-a", op: { op: "interrupt" } });
    await until(() => results(c.frames, 257).length === 2, "recent entry re-served");
    expect(driver.interrupts).toBe(258); // id 257 came from the cache
    c.ws.close();
  });

  it("a different client instance (page reload) is a fresh keyspace: same id, same payload → new execution", async () => {
    const driver = countingDriver();
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = await authed(server.port, "t");

    sendOp(c.ws, { id: 5, cid: "page-1", op: { op: "submit", text: "hello" } });
    await until(() => results(c.frames, 5).length === 1, "page-1 result");
    sendOp(c.ws, { id: 5, cid: "page-2", op: { op: "submit", text: "hello" } });
    await until(() => results(c.frames, 5).length === 2, "page-2 result");
    expect(driver.submits).toEqual(["hello", "hello"]); // different client → executed
    expect(results(c.frames, 5)[1]?.err).toBeUndefined(); // no spurious conflict
    c.ws.close();
  });

  it("ops WITHOUT cid (old clients) are not vaulted: every frame executes, no conflicts", async () => {
    const driver = countingDriver();
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = await authed(server.port, "t");

    sendOp(c.ws, { id: 5, op: { op: "submit", text: "legacy" } });
    sendOp(c.ws, { id: 5, op: { op: "submit", text: "legacy" } });
    await until(() => results(c.frames, 5).length === 2, "both legacy results");
    expect(driver.submits).toEqual(["legacy", "legacy"]); // current behavior preserved
    expect(results(c.frames, 5).every((f) => f.err === undefined)).toBe(true);
    c.ws.close();
  });

  it("reads are never vaulted: the same id twice re-executes and stays fresh", async () => {
    const driver = countingDriver();
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = await authed(server.port, "t");

    sendOp(c.ws, { id: 2, cid: "client-a", op: { op: "sessions" } });
    sendOp(c.ws, { id: 2, cid: "client-a", op: { op: "sessions" } });
    await until(() => results(c.frames, 2).length === 2, "both read results");
    expect(driver.sessionsCalls).toBe(2);
    expect(results(c.frames, 2).every((f) => f.err === undefined)).toBe(true);
    c.ws.close();
  });

  it("dual-form ops: only the mutating form is vaulted (switch n / recentWorkspaces add)", async () => {
    const driver = countingDriver();
    let switches = 0;
    let recents = 0;
    const port: UiDriverPort = {
      ...driver,
      switchBranch: async () => {
        switches += 1;
        return `branch ${switches}`;
      },
      recentWorkspaces: async () => {
        recents += 1;
        return { workspaces: [] };
      },
    };
    const server = await createUiServer({ driver: port, token: "t" });
    servers.push(server);
    const c = await authed(server.port, "t");

    // The read forms (n absent / add absent) re-execute: not vaulted.
    sendOp(c.ws, { id: 1, cid: "client-a", op: { op: "switch" } });
    sendOp(c.ws, { id: 1, cid: "client-a", op: { op: "switch" } });
    await until(() => results(c.frames, 1).length === 2, "switch list results");
    expect(switches).toBe(2);
    sendOp(c.ws, { id: 2, cid: "client-a", op: { op: "recentWorkspaces" } });
    sendOp(c.ws, { id: 2, cid: "client-a", op: { op: "recentWorkspaces" } });
    await until(() => results(c.frames, 2).length === 2, "recents results");
    expect(recents).toBe(2);

    // The mutating forms ARE vaulted: the retry replays the cached result.
    sendOp(c.ws, { id: 3, cid: "client-a", op: { op: "switch", n: 2 } });
    await until(() => results(c.frames, 3).length === 1, "switch mutation result");
    expect(switches).toBe(3);
    sendOp(c.ws, { id: 3, cid: "client-a", op: { op: "switch", n: 2 } });
    await until(() => results(c.frames, 3).length === 2, "cached switch result");
    expect(switches).toBe(3); // served from the vault
    sendOp(c.ws, { id: 4, cid: "client-a", op: { op: "recentWorkspaces", add: "/w/x" } });
    await until(() => results(c.frames, 4).length === 1, "recents mutation result");
    expect(recents).toBe(3);
    sendOp(c.ws, { id: 4, cid: "client-a", op: { op: "recentWorkspaces", add: "/w/x" } });
    await until(() => results(c.frames, 4).length === 2, "cached recents result");
    expect(recents).toBe(3);
    c.ws.close();
  });

  // ω-3a review M1 follow-up: /edit arming (an armed edit branch is driver
  // state, not a read) IS a vaulted mutation — the same id + same payload
  // replays the cached armed text without re-arming, and the same id with a
  // different n conflicts. `edit` settles synchronously, so "join" here
  // degenerates to the cached-result replay.
  it("edit is vaulted: a same-id replay re-serves the armed text without re-arming; a different n conflicts", async () => {
    const driver = countingDriver();
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = await authed(server.port, "t");

    sendOp(c.ws, { id: 11, cid: "client-a", op: { op: "edit", n: 3 } });
    await until(() => results(c.frames, 11).length === 1, "first edit result");
    expect(driver.edits).toEqual([3]); // armed exactly once
    expect(results(c.frames, 11)[0]?.ok).toBe("original text of message 3");

    // Same id + same payload: served from the vault — no second arming.
    sendOp(c.ws, { id: 11, cid: "client-a", op: { op: "edit", n: 3 } });
    await until(() => results(c.frames, 11).length === 2, "cached edit result");
    expect(results(c.frames, 11)[1]?.ok).toBe("original text of message 3");
    expect(driver.edits).toEqual([3]);

    // Same id + different payload (n=4): explicit conflict, no arming.
    sendOp(c.ws, { id: 11, cid: "client-a", op: { op: "edit", n: 4 } });
    await until(() => results(c.frames, 11).length === 3, "conflict result");
    expect(results(c.frames, 11)[2]?.err ?? "").toMatch(/conflict/);
    expect(driver.edits).toEqual([3]); // n=4 never armed
    c.ws.close();
  });

  // ω-3a review M2 follow-up: the digest check runs BEFORE the join — a
  // DIFFERENT payload on an id that is still IN FLIGHT gets the conflict
  // immediately (never a silent join onto the original's outcome). Pins the
  // ordering: swapping the digest and done checks would turn this into a
  // join and the assertions below would fail.
  it("in-flight digest mismatch conflicts IMMEDIATELY — it never joins the original execution", async () => {
    const driver = countingDriver();
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = await authed(server.port, "t");

    sendOp(c.ws, { id: 12, cid: "client-a", op: { op: "resume", id: "sess-A" } });
    await wait(50); // in-flight: parked on the deferred driver promise
    expect(results(c.frames, 12)).toHaveLength(0);

    // Same id, DIFFERENT payload while the original is still in flight.
    sendOp(c.ws, { id: 12, cid: "client-a", op: { op: "resume", id: "sess-B" } });
    await until(() => results(c.frames, 12).length === 1, "conflict while still in-flight");
    // The conflict settled BEFORE the original resolved — precedence, not a
    // join: a join would still be parked here (0 results).
    expect(results(c.frames, 12)[0]?.err ?? "").toMatch(/conflict/);
    expect(driver.resumes).toEqual(["sess-A"]); // sess-B never executed

    // The ORIGINAL caller still gets its own outcome — untouched by the
    // conflicting request (a join would have delivered it to both).
    driver.resolveResume({ ok: true });
    await until(() => results(c.frames, 12).length === 2, "original result after settle");
    expect(results(c.frames, 12)[1]?.ok).toEqual({ ok: true });
    expect(results(c.frames, 12)[1]?.err).toBeUndefined();
    expect(driver.resumes).toEqual(["sess-A"]);
    c.ws.close();
  });
});
