// Protocol client round-trips against the in-memory fake WebSocket — the
// web package's pin on the PROTOCOL.md contract: first-frame auth, the
// state/history two-channel rules (append vs reset), op/result correlation,
// close-code semantics, and reconnect replay.
import { describe, expect, it, vi } from "vitest";
import { WudaoClient, defaultBackoff, modeLabel, cycleMode, tokenFromLocation, wsUrlFromLocation, shellFromLocation, modelPickCommand, isRetryableMutation, formatDur } from "../src/protocol.js";
import type { DriverStatus, ClientOp } from "../src/protocol.js";
import { authOk, fakeServer } from "./mock-ws.js";
import type { FakeServer } from "./mock-ws.js";

interface Harness {
  client: WudaoClient;
  server: FakeServer;
  timers: ((() => void) | undefined)[];
}

function makeClient(overrides: Record<string, unknown> = {}): Harness {
  const server = fakeServer();
  const timers: ((() => void) | undefined)[] = [];
  const client = new WudaoClient({
    url: "ws://127.0.0.1:9999",
    token: "sekrit",
    wsFactory: () => server.spawn(),
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length - 1;
    },
    clearTimeout: (h) => {
      if (typeof h === "number") timers[h] = undefined;
    },
    ...overrides,
  });
  return { client, server, timers };
}

/** connect + open + auth-accept → connected with a base status. */
function connected(overrides: Record<string, unknown> = {}, history: readonly unknown[] = []): Harness {
  const h = makeClient(overrides);
  h.client.connect();
  h.server.socket.serverOpen();
  authOk(h.server.socket, {}, history);
  return h;
}

describe("auth", () => {
  it("sends the auth frame as the FIRST message after open", () => {
    const { client, server } = makeClient();
    client.connect();
    server.socket.serverOpen();
    expect(server.clientFrames()[0]).toEqual({ t: "auth", token: "sekrit" });
    expect(client.getSnapshot().connection).toBe("authenticating");
  });

  it("flips to connected on the first post-auth frame (state + history replay)", () => {
    const { client, server } = makeClient();
    client.connect();
    server.socket.serverOpen();
    authOk(server.socket, { sessionId: "wudao-abc-123" }, [{ kind: "divider", text: "fresh" }]);
    const snap = client.getSnapshot();
    expect(snap.connection).toBe("connected");
    expect(snap.status?.sessionId).toBe("wudao-abc-123");
    expect(snap.history).toEqual([{ kind: "divider", text: "fresh" }]);
  });

  it("4401 (auth failed) stops — retrying the same fragment is futile", () => {
    const { client, server } = makeClient();
    client.connect();
    server.socket.serverOpen();
    server.socket.serverClose(4401, "unauthenticated");
    expect(client.getSnapshot().connection).toBe("auth-failed");
    expect(client.getSnapshot().lastClose?.code).toBe(4401);
  });
});

describe("two-channel rules", () => {
  it("history frames append; reset:true replaces", () => {
    const { client, server } = connected({}, [{ kind: "user", text: "hi" }]);
    server.socket.serverSend({ t: "history", entries: [{ kind: "assistant", text: "hello" }] });
    expect(client.getSnapshot().history.map((e) => e.kind)).toEqual(["user", "assistant"]);
    server.socket.serverSend({ t: "history", entries: [{ kind: "notice", text: "cleared" }], reset: true });
    expect(client.getSnapshot().history.map((e) => e.kind)).toEqual(["notice"]);
  });

  it("state frames replace the status snapshot wholesale", () => {
    const { client, server } = connected();
    const base = client.getSnapshot().status as DriverStatus;
    server.socket.serverSend({ t: "state", state: { ...base, busy: true, mode: "auto" } });
    expect(client.getSnapshot().status?.busy).toBe(true);
    expect(client.getSnapshot().status?.mode).toBe("auto");
    expect(client.getSnapshot().status?.sessionId).toBe("wudao-test-0001");
  });

  it("snapshots are referentially stable until a change", () => {
    const { client, server } = connected();
    const before = client.getSnapshot();
    server.socket.serverSend({ t: "event", event: { type: "turn_started", turn: 1 } });
    expect(client.getSnapshot()).toBe(before);
  });

  it("notifies subscribers on state and history changes (and unsubscribes)", () => {
    const { client, server } = connected();
    const cb = vi.fn();
    const off = client.subscribe(cb);
    server.socket.serverSend({ t: "history", entries: [{ kind: "user", text: "again" }] });
    expect(cb).toHaveBeenCalledTimes(1);
    server.socket.serverSend({ t: "state", state: client.getSnapshot().status });
    expect(cb).toHaveBeenCalledTimes(2);
    off();
    server.socket.serverSend({ t: "history", entries: [{ kind: "user", text: "silent" }] });
    expect(cb).toHaveBeenCalledTimes(2);
  });
});

describe("ops", () => {
  it("sends {t:'op',id,op} and resolves the correlated result", async () => {
    const { client, server } = connected();
    const p = client.submit("hello world");
    const ops = server.clientFrames().filter((f): f is { id: number; op: unknown } => typeof f === "object" && f !== null && "op" in f);
    const op = ops[0];
    expect(op).toMatchObject({ op: { op: "submit", text: "hello world" } });
    server.socket.serverSend({ t: "result", id: op?.id, ok: "started" });
    await expect(p).resolves.toBe("started");
  });

  it("submit carries plan only when set", async () => {
    const { client, server } = connected();
    const p = client.submit("goal", { plan: true });
    const ops = server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } => typeof f === "object" && f !== null && "op" in f);
    expect(ops[0]?.op).toEqual({ op: "submit", text: "goal", plan: true });
    server.socket.serverSend({ t: "result", id: ops[0]?.id, ok: "notice" });
    await expect(p).resolves.toBe("notice");
  });

  it("every op shape round-trips verbatim", async () => {
    const { client, server } = connected();
    const cases: [Promise<unknown>, Record<string, unknown>][] = [
      [client.interrupt(), { op: "interrupt" }],
      [client.setMode("ask"), { op: "setMode", mode: "ask" }],
      [client.answerPermission(true), { op: "answerPermission", allow: true }],
      [client.answerPermission(false, "too risky"), { op: "answerPermission", allow: false, reason: "too risky" }],
      // 0.3.14 #1: the ask answer's scope rides verbatim (a = session, p = always).
      [client.answerPermission(true, undefined, "session"), { op: "answerPermission", allow: true, scope: "session" }],
      [client.answerPermission(true, undefined, "always"), { op: "answerPermission", allow: true, scope: "always" }],
      [client.listSlashCommands(), { op: "listSlashCommands" }],
      [client.sessions(), { op: "sessions" }],
      [client.resume("wudao-x"), { op: "resume", id: "wudao-x" }],
      [client.rewind(2), { op: "rewind", target: 2 }],
      [client.rewind("list"), { op: "rewind", target: "list" }],
      // M76-ux2 §8: the ctx hover's breakdown (no payload — read-only over
      // live driver state).
      [client.ctxInfo(), { op: "ctxInfo" }],
      // workspace-ux B1: the panel-root ops (set = view root only; status =
      // the dual-root snapshot).
      [client.panelRootSet("/w/panel"), { op: "panelRootSet", path: "/w/panel" }],
      [client.agentRootStatus(), { op: "agentRootStatus" }],
    ];
    const ops = server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } => typeof f === "object" && f !== null && "op" in f);
    expect(ops.map((o) => o.op)).toEqual(cases.map(([, want]) => want));
    for (const [i, [p]] of cases.entries()) {
      server.socket.serverSend({ t: "result", id: ops[i]?.id, ok: true });
      await expect(p).resolves.toBe(true);
    }
  });

  // 高亮/编辑 spec §3: the viewer's save — the CAS payload round-trips
  // verbatim on the wire and the written/conflict reply unwraps as the op's
  // result object (no client-side reshaping).
  it("fileWrite round-trips the CAS payload and unwraps the reply", async () => {
    const { client, server } = connected();
    const p = client.fileWrite("a.ts", "new", "old");
    const ops = server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } => typeof f === "object" && f !== null && "op" in f);
    expect(ops[0]?.op).toEqual({ op: "fileWrite", path: "a.ts", content: "new", base: "old" });
    server.socket.serverSend({ t: "result", id: ops[0]?.id, ok: { written: true } });
    await expect(p).resolves.toEqual({ written: true });
  });

  it("a result with err rejects the op", async () => {
    const { client, server } = connected();
    const p = client.setMode("bogus" as never);
    server.socket.serverSend({ t: "result", id: 1, ok: undefined, err: "setMode: mode must be one of workspace, ask, auto" });
    await expect(p).rejects.toThrow(/setMode/);
  });

  it("rejects ops while disconnected", async () => {
    const { client } = makeClient();
    await expect(client.interrupt()).rejects.toThrow(/not connected/);
  });
});

describe("reconnect", () => {
  it("an abnormal close reconnects with backoff and the replay restores history", () => {
    const h = connected({}, [{ kind: "user", text: "before" }]);
    h.server.socket.serverClose(1006, "");
    expect(h.client.getSnapshot().connection).toBe("reconnecting");
    expect(h.client.getSnapshot().reconnectAttempt).toBe(1);

    // Fire the backoff timer: a fresh socket, a fresh auth, full replay.
    h.timers[0]?.();
    h.server.socket.serverOpen();
    expect(h.server.clientFrames()[0]).toEqual({ t: "auth", token: "sekrit" });
    authOk(h.server.socket, {}, [{ kind: "user", text: "before" }, { kind: "assistant", text: "answer" }]);
    const snap = h.client.getSnapshot();
    expect(snap.connection).toBe("connected");
    expect(snap.reconnectAttempt).toBe(0);
    expect(snap.history.map((e) => e.kind)).toEqual(["user", "assistant"]);
  });

  it("keeps retrying with growing attempts until a reconnect lands", () => {
    const h = connected();
    h.server.socket.serverClose(1006, "");
    expect(h.client.getSnapshot().reconnectAttempt).toBe(1);
    h.timers[0]?.();
    h.server.socket.serverClose(1006, "");
    expect(h.client.getSnapshot().reconnectAttempt).toBe(2);
    h.timers[1]?.();
    h.server.socket.serverOpen();
    authOk(h.server.socket);
    expect(h.client.getSnapshot().reconnectAttempt).toBe(0);
  });

  it("backoff schedule: 1s → 2s → 4s → 8s → 16s → 30s cap", () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(defaultBackoff)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it("gives up after MAX_RECONNECT_ATTEMPTS — terminal state, no further sockets or timers", () => {
    const h = connected();
    for (let i = 0; i < 8; i++) {
      h.server.socket.serverClose(1006, "");
      expect(h.client.getSnapshot().connection).toBe("reconnecting");
      h.timers[h.timers.length - 1]?.();
    }
    // The 9th close (the last retry's failure) trips the cap.
    h.server.socket.serverClose(1006, "");
    const snap = h.client.getSnapshot();
    expect(snap.connection).toBe("gave-up");
    const sockets = h.server.sockets.length;
    const timers = h.timers.filter((t) => t !== undefined).length;
    // No further activity: advancing nothing, but a subsequent close is impossible
    // (no socket) — assert the counts are frozen by giving the loop a beat.
    expect(sockets).toBe(9); // initial + 8 retries
    expect(timers).toBe(8); // one per retry, none scheduled after gave-up
  });

  it("manual reconnect() from gave-up resets the attempts and reconnects", () => {
    const h = connected();
    for (let i = 0; i < 9; i++) {
      h.server.socket.serverClose(1006, "");
      if (h.client.getSnapshot().connection !== "reconnecting") break; // gave-up tripped
      h.timers[h.timers.length - 1]?.();
    }
    expect(h.client.getSnapshot().connection).toBe("gave-up");
    h.client.reconnect();
    expect(h.client.getSnapshot().connection).toBe("connecting");
    h.server.socket.serverOpen();
    authOk(h.server.socket);
    expect(h.client.getSnapshot().connection).toBe("connected");
    expect(h.client.getSnapshot().reconnectAttempt).toBe(0);
  });

  it("setMode while connecting is queued (latest wins) and flushed after auth", async () => {
    const h = makeClient();
    h.client.connect(); // socket exists, still CONNECTING (no serverOpen yet)
    await expect(h.client.setMode("auto")).resolves.toBe(true);
    await expect(h.client.setMode("ask")).resolves.toBe(true); // latest wins
    // Nothing was sent on the connecting socket except nothing at all yet.
    expect(h.server.socket.sent.filter((s) => s.includes("setMode"))).toEqual([]);
    h.server.socket.serverOpen();
    authOk(h.server.socket);
    const ops = h.server.clientFrames().filter((f): f is { op: Record<string, unknown> } => typeof f === "object" && f !== null && "op" in f);
    const setModes = ops.filter((o) => o.op.op === "setMode");
    expect(setModes).toHaveLength(1);
    expect(setModes[0]?.op).toEqual({ op: "setMode", mode: "ask" });
  });

  it("submit while disconnected rejects (the UI disables the send control)", async () => {
    const h = makeClient();
    await expect(h.client.submit("x")).rejects.toThrow(/not connected/);
  });

  it("4000 (another client) still retries — the other tab may close", () => {
    const { client, server } = makeClient();
    client.connect();
    server.socket.serverOpen();
    server.socket.serverClose(4000, "another client is already connected");
    expect(client.getSnapshot().connection).toBe("reconnecting");
  });

  it("user close never reconnects", () => {
    const { client } = makeClient();
    client.connect();
    client.close();
    expect(client.getSnapshot().connection).toBe("closed");
  });

  it("pending ops reject when the socket drops", async () => {
    const { client, server } = connected();
    const p = client.sessions();
    server.socket.serverClose(1006, "");
    await expect(p).rejects.toThrow(/closed \(1006\)/);
  });
});

// ω-3a — reconnect replay of in-flight mutations (the client half of the
// server's idempotency vault): a mutation pending when the socket drops is
// re-sent on the next authenticated socket under its ORIGINAL op id and the
// SAME client-instance cid, so the vault joins the original execution or
// replays its cached result instead of silently dropping the user's op.
// Non-retryable ops (reads) keep failing on the drop, as before.
describe("ω-3a reconnect replay (mutation idempotency)", () => {
  const opFrames = (frames: unknown[]): { t?: string; id?: number; op?: Record<string, unknown>; cid?: string }[] =>
    frames.filter((f): f is { t?: string; id?: number; op?: Record<string, unknown>; cid?: string } =>
      typeof f === "object" && f !== null && "op" in f);

  it("a submit in flight when the socket drops is replayed with its ORIGINAL id + cid on the next socket", async () => {
    const h = connected();
    const p = h.client.submit("fix the bug");
    const first = opFrames(h.server.clientFrames())[0];
    expect(first?.op).toEqual({ op: "submit", text: "fix the bug" });

    h.server.socket.serverClose(1006, "");
    await Promise.resolve(); // onClose runs synchronously on the close event
    expect(h.client.getSnapshot().connection).toBe("reconnecting");
    h.timers[0]?.();
    h.server.socket.serverOpen();
    authOk(h.server.socket);
    const replay = opFrames(h.server.clientFrames())[0];
    expect(replay).toMatchObject({ t: "op", id: first?.id, op: { op: "submit", text: "fix the bug" } });
    expect(replay?.cid).toBe(first?.cid); // same client instance
    h.server.socket.serverSend({ t: "result", id: replay?.id, ok: "started" });
    await expect(p).resolves.toBe("started");
  });

  it("the submit promise stays PENDING through the drop (no silent loss) and resolves via the replay", async () => {
    const h = connected();
    const p = h.client.submit("long task");
    let settled = false;
    void p.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });
    h.server.socket.serverClose(1006, "");
    await Promise.resolve();
    expect(settled).toBe(false); // neither resolved nor rejected by the drop
    h.timers[0]?.();
    h.server.socket.serverOpen();
    authOk(h.server.socket);
    const replay = opFrames(h.server.clientFrames())[0];
    h.server.socket.serverSend({ t: "result", id: replay?.id, ok: "started" });
    await expect(p).resolves.toBe("started");
  });

  it("a non-retryable op (read) still fails on the drop", async () => {
    const h = connected();
    const p = h.client.fileRead("src/a.ts");
    h.server.socket.serverClose(1006, "");
    await expect(p).rejects.toThrow(/closed \(1006\)/);
    // And it is NOT replayed after the reconnect.
    h.timers[0]?.();
    h.server.socket.serverOpen();
    authOk(h.server.socket);
    expect(opFrames(h.server.clientFrames()).filter((f) => f.op?.op === "fileRead")).toEqual([]);
  });

  it("replayed mutations keep their send order", async () => {
    const h = connected();
    const p1 = h.client.submit("first");
    const p2 = h.client.submit("second");
    h.server.socket.serverClose(1006, "");
    await Promise.resolve();
    h.timers[0]?.();
    h.server.socket.serverOpen();
    authOk(h.server.socket);
    const replays = opFrames(h.server.clientFrames());
    expect(replays.map((f) => f.op?.text)).toEqual(["first", "second"]);
    const [r1, r2] = replays;
    h.server.socket.serverSend({ t: "result", id: r1?.id, ok: "started" });
    h.server.socket.serverSend({ t: "result", id: r2?.id, ok: "steered" });
    await expect(p1).resolves.toBe("started");
    await expect(p2).resolves.toBe("steered");
  });

  it("gave-up (reconnect cap) fails the queued mutations", async () => {
    const h = connected();
    const p = h.client.submit("never lands");
    for (let i = 0; i < 8; i++) {
      h.server.socket.serverClose(1006, "");
      h.timers[h.timers.length - 1]?.();
    }
    h.server.socket.serverClose(1006, "");
    expect(h.client.getSnapshot().connection).toBe("gave-up");
    await expect(p).rejects.toThrow(/closed \(1006\)/);
  });

  it("4401 (auth failed) fails the queued mutations — terminal, no replay", async () => {
    const h = connected();
    const p = h.client.submit("bad token page");
    h.server.socket.serverClose(4401, "unauthenticated");
    expect(h.client.getSnapshot().connection).toBe("auth-failed");
    await expect(p).rejects.toThrow(/closed \(4401\)/);
  });

  it("user close() fails the queued mutations", async () => {
    const h = connected();
    const p = h.client.submit("bye");
    h.client.close();
    await expect(p).rejects.toThrow(/client closed/);
  });

  it("a queued setMode (clicked while offline) flushes after the replay, not before", async () => {
    const h = connected();
    const p = h.client.submit("work");
    h.server.socket.serverClose(1006, "");
    await Promise.resolve();
    void h.client.setMode("auto"); // queued while offline (latest wins)
    h.timers[0]?.();
    h.server.socket.serverOpen();
    authOk(h.server.socket);
    const ops = opFrames(h.server.clientFrames()).map((f) => f.op?.op);
    expect(ops).toEqual(["submit", "setMode"]); // replay first, then the queued mode
    const replay = opFrames(h.server.clientFrames())[0];
    h.server.socket.serverSend({ t: "result", id: replay?.id, ok: "started" });
    await expect(p).resolves.toBe("started");
  });

  it("every op frame carries one stable per-instance cid; two clients differ", async () => {
    const h = connected();
    void h.client.submit("a");
    void h.client.interrupt();
    void h.client.setMode("auto");
    const cids = new Set(opFrames(h.server.clientFrames()).map((f) => f.cid));
    expect(cids.size).toBe(1);
    expect(typeof [...cids][0]).toBe("string");

    const other = connected();
    void other.client.submit("b");
    const otherCid = opFrames(other.server.clientFrames())[0]?.cid;
    expect(otherCid).not.toBe([...cids][0]);
  });

  // ω-3a review M1 follow-up (a): /edit arming is a vaulted mutation — the
  // client replays it like every other mutation (the server's vault re-serves
  // the armed text; without the mirror entry the arming would be lost to a
  // "connection closed (1006)" rejection on a network flap).
  it("an edit arming in flight when the socket drops is replayed with its ORIGINAL id + cid", async () => {
    const h = connected();
    const p = h.client.edit(3);
    const first = opFrames(h.server.clientFrames())[0];
    expect(first?.op).toEqual({ op: "edit", n: 3 });

    h.server.socket.serverClose(1006, "");
    await Promise.resolve();
    expect(h.client.getSnapshot().connection).toBe("reconnecting");
    h.timers[0]?.();
    h.server.socket.serverOpen();
    authOk(h.server.socket);
    const replay = opFrames(h.server.clientFrames())[0];
    expect(replay).toMatchObject({ t: "op", id: first?.id, op: { op: "edit", n: 3 } });
    expect(replay?.cid).toBe(first?.cid); // same client instance
    h.server.socket.serverSend({ t: "result", id: replay?.id, ok: "the original text" });
    await expect(p).resolves.toBe("the original text");
  });

  // ω-3a review M1 follow-up (b): the vaulted set is PINNED — one
  // representative of every ClientOp action is classified here. A new action
  // added to the union without updating isRetryableMutation (and the server's
  // isVaultedMutation) changes the action count below and goes red.
  it("the vaulted-mutation set is pinned: every ClientOp action classified, dual forms only in their mutating form", () => {
    // `as const satisfies` keeps the LITERAL action types (the compile-time
    // assertion below derives ActionsTested from these arrays — a plain
    // `readonly ClientOp[]` annotation would widen every op back to the full
    // union and the assertion could never fire) while still failing tsc if a
    // listed op is not a valid ClientOp.
    const mutations = [
      { op: "submit", text: "t" },
      { op: "interrupt" },
      { op: "setMode", mode: "auto" },
      { op: "answerPermission", allow: true },
      { op: "resume", id: "s" },
      { op: "rewind", target: "last" },
      { op: "edit", n: 1 },
      { op: "settingsSaveKey", provider: "glm", key: "k" },
      { op: "settingsSet", key: "ui.theme", value: "dark" },
      // Provider management §5: a provider write is a side effect that must
      // survive a mid-flap replay exactly once — vaulted like settingsSet.
      { op: "settingsSaveProvider", id: "my-gw", config: { baseUrl: "https://gw.example.com/v1" } },
      { op: "switchWorkspace", path: "/w" },
      { op: "panelRootSet", path: "/w" },
      { op: "agentRootSwitch", path: "/w" },
      { op: "attachmentSave", inputs: [] },
      // ω99-55: the file lane's save writes content-addressed objects —
      // vaulted like the image save.
      { op: "fileSave", inputs: [] },
      { op: "pluginMarketAdd", source: "s" },
      { op: "pluginMarketUpdate", name: "n" },
      { op: "pluginMarketRemove", name: "n" },
      { op: "pluginInstall", name: "n", market: "m", scope: "user" },
      // guided-install 弧：spec 直装（git 克隆是幂等副作用 — 重放收敛到同目录登记的 already-exists 拒绝）。
      { op: "pluginInstallSpec", spec: "owner/repo" },
      // M-Memory 管理记忆面：长期记忆删除是删（vault：tombstone 幂等）。
      { op: "longtermMemoryForget", id: "x" },
      { op: "pluginUninstall", id: "i" },
      { op: "pluginEnable", id: "i" },
      { op: "pluginDisable", id: "i" },
      // persona-settings T5: persona writes are side effects — vaulted like
      // the other registry mutations (delete converges on replay).
      { op: "personaSave", definition: { id: "p", displayName: "P", source: { kind: "workspace-source", provenance: "x", pinnedVersion: "1" }, headers: {} } },
      { op: "personaDelete", id: "p" },
      // ω99-235: #10 — the pet lane's ops — mutations of the SECOND driver
      // session, vaulted exactly like their main-lane twins.
      { op: "petSubmit", text: "t" },
      { op: "petInterrupt" },
      { op: "petAnswerPermission", allow: true },
      // M85-pet §2 — 精灵工具栏四写（pet 车道自己的状态面，server vault.ts
      // 镜像同动）：newSession 归档落盘（重放恰一次，绝不双归档）；setModel/
      // setEffort 是 liveConfig 写（setMode 同族）；setWorkspace 镜像已 vault
      // 的 agentRootSwitch 孪生。
      { op: "petNewSession" },
      { op: "petSetModel", provider: "glm" },
      { op: "petSetEffort", effort: "high" },
      { op: "petSetWorkspace", path: "/w" },
      // ω99-260（同 #8）: the memory decision is a side effect (confirm flips
      // a line, del removes it) — vaulted; ok/del converge on replay.
      { op: "memoryDecide", id: "m-a", action: "ok" },
      // ω99-264: #4 — the memory REWRITE is a side effect (update writes a new
      // ledger line, version+1) — vaulted; the DRIVER short-circuits a
      // content-equal replay, so a mid-flap replay converges (version 恰 +1).
      { op: "memoryEdit", id: "m-a", content: "改后内容" },
      // ω99-314: the time machine's restore — a working-face side effect
      // (overwrites a workspace file), vaulted/replayed so a mid-flap retry
      // joins the original execution, never double-reverts.
      { op: "fileRevert", path: "a.ts", sha: "a".repeat(64) },
      // ω99-317 — 定时任务管理面两写：setEnabled 状态写（settingsSet 同
      // 形）；runNow 重放会双跑（vault 保 exactly-once）。删除入读表。
      { op: "schedulesSetEnabled", id: "abcd0001", enabled: false },
      { op: "schedulesRunNow", id: "abcd0001" },
      // 借鉴弧 α2/α1 — recall + ask answer are convergent-on-replay (nothing
      // left parked → false) but vaulted like every driver-state mutation.
      { op: "recallSteer", index: 0, text: "t" },
      { op: "answerAskUser", answer: "a" },
      // 借鉴弧 δ — mid-flight detach: convergent refusals on replay (the
      // call is no longer in flight → not_in_flight), vaulted like the α2/α1
      // twins so a mid-flap replay re-serves the verdict instead of
      // detaching a MOVED busy row.
      { op: "detachToolCall", callId: "c1" },
    ] as const satisfies readonly ClientOp[];
    const reads = [
      { op: "listSlashCommands" },
      // M-Memory：长期记忆列表（纯读）。
      { op: "longtermMemoryList" },
      { op: "sessions" },
      { op: "tree" },
      { op: "settingsStatus" },
      { op: "settingsTestConnection", provider: "glm" },
      // Provider management §5: delete converges (an absent row is the goal
      // state — replaying it changes nothing) and the /models probe is a read.
      { op: "settingsDeleteProvider", id: "my-gw" },
      { op: "settingsListModels", provider: "glm" },
      { op: "fileTree", path: "src" },
      { op: "fileRead", path: "src/a.ts" },
      // 高亮/编辑 spec §3: user-hand save — CAS base makes replay converge
      // to a conflict (noise for a user edit), so it is NOT retryable.
      { op: "fileWrite", path: "a.ts", content: "x", base: "" },
      { op: "agentRootStatus" },
      { op: "ctxInfo" },
      // 139 探针仪表盘：三读 + 运行时总闸（总闸翻转收敛——重放同值幂等）。
      { op: "probeStream" },
      { op: "probeRecent", limit: 50 },
      { op: "probeStats" },
      { op: "probeEnable", on: true },
      // 140：会话解剖（监控面板的全量读）。
      { op: "sessionAnatomy" },
      // ω99-213: a read — the op's model call is a side-channel burn guarded
      // client-side by the (sessionId, mark) memoization, and a replay
      // converges to the same payload (nothing is mutated).
      { op: "recap", sessionId: "s", sinceMark: 0, sinceTs: 1 },
      // ω99-242: #13 — a read — the recovery reconciliation rows (server-counted,
      // no side effect; the server's isVaultedMutation mirror never lists it).
      { op: "recoveryStatus" },
      { op: "attachmentGet", ref: { kind: "image", attachmentId: "a", mediaType: "image/png", byteLength: 1 } },
      { op: "pluginList" },
      { op: "pluginMarketList" },
      { op: "mcpList" },
      { op: "personaList" },
      { op: "personaGet", id: "p" },
      // ω99-258: #12 — branchLeaves 入读表（census 49→50 同形演进）。
      // The structured branch leaf table — a read (the panel's
      // snapshot fetch; never vaulted, old-server reject degrades the chip).
      { op: "branchLeaves" },
      // ω99-260: #8 — memoryList 入读表（census 50→52 同形演进——本弧双 op：
      // 读表 + 决定，各归其类）. The full memory ledger — a read (the
      // 待审卡/管理面's snapshot fetch; never vaulted, old-server reject
      // degrades both faces).
      { op: "memoryList" },
      // ω99-271: #14 — petHistory 入读表（census 52→53 同形演进——第四 pet op
      // 是纯读，260 memoryList 前例）. The pet lane's paired session history —
      // never vaulted (a vaulted read would serve a stale transcript to the
      // pet window).
      { op: "petHistory" },
      // ω99-277: #11 — sessionSearch 入读表（census 54→55 同形演进——纯读：
      // 260 memoryList 前例，vaulting a read would serve stale hits）. The
      // session-picker's full-text search — a replay re-scans, nothing is
      // mutated.
      { op: "sessionSearch", q: "关键词" },
      // ω99-279: #11 — sessionDelete 入读表（census 55→56 同形演进——删除
      // 收敛：absent 即 goal state，重放落 not-found 不再动盘——
      // settingsDeleteProvider 删除收敛先例，mutation 表零动）. The
      // session-picker's trash delete (a recoverable move into .trash/) —
      // never vaulted, a replay re-executes harmlessly.
      { op: "sessionDelete", id: "sess-x" },
      // ω99-283: #6 — 回收站两 op 入读表（census 56→58 lockstep——恢复
      // 收敛同 sessionDelete：mid-flap 重放要么 target-exists（已恢复过）
      // 要么 not-found（回收件已拆），两向都不再动盘；列表是纯扫）. The
      // session-picker's trash list + restore — never vaulted.
      { op: "sessionTrashList" },
      { op: "sessionRestore", id: "sess-x" },
      // ω99-286: #7 — 断点续跑入读表（census 58→59 同形演进——写语义同
      // submit 族但不 vault：driver 的 busy/尾形门让 mid-flap 重放收敛
      // started:false，零双跑——vaulting 反会服务陈旧回执）. The
      // unfinished-session continue — never vaulted.
      { op: "sessionContinue", id: "sess-x" },
      // ω99-313 — 定时任务与提醒读面入读表（census 59→60 同形演进；与
      // server 侧读表刻意一致）：纯读 store（.wudao/schedules.json 扫描），
      // 重放即重扫，零副作用——vaulting 反会服务陈旧行。The durable
      // schedules' read face — never vaulted.
      { op: "schedulesList" },
      // ω99-317 — schedulesRemove 入读表（census 61→62 同形演进；与
      // server 侧读表刻意一致）：删除收敛——absent 即 goal state，重放落
      // not-found 收敛回执不再动盘（sessionDelete 删除收敛先例）。
      { op: "schedulesRemove", id: "abcd0001" },
      // ω99-316 — /btw 侧问入读表（census 62→63 同形演进——后到者随
      // ω99-317 重编号；与 server 侧读表刻意一致）：detached loop 克隆投影
      // 作答，绝不写 session JSONL/store——重放=重新问一次，零副作用。
      { op: "sideQuestion", sessionId: "sess-x", text: "问" },
      // PB-2（探针基础设施弧）— 遥测三读面入读表（census 69→72 同形演进；与
      // server 侧读表刻意一致）：probeStream 订阅声明、probeRecent/probeStats
      // 纯读——重放=重订阅/重扫，零副作用，never vaulted。
      { op: "probeStream" },
      { op: "probeRecent", limit: 10 },
      { op: "probeStats" },
    ] as const satisfies readonly ClientOp[];
    for (const op of mutations) expect(isRetryableMutation(op), op.op).toBe(true);
    for (const op of reads) expect(isRetryableMutation(op), op.op).toBe(false);
    // Dual-form ops retry ONLY in their mutating form (n / add present).
    expect(isRetryableMutation({ op: "switch", n: 2 })).toBe(true);
    expect(isRetryableMutation({ op: "switch" })).toBe(false);
    expect(isRetryableMutation({ op: "recentWorkspaces", add: "/w" })).toBe(true);
    expect(isRetryableMutation({ op: "recentWorkspaces" })).toBe(false);
    // 永续 v6 wave2（reef C1）：improvementFace 是第三个 dual-form——list 拉
    // 记录卡是纯读；五决策是写副作用（镜像服务端 isVaultedMutation：consent
    // 起子代理+模型调用、activate 写规则文件——恰一次）。
    expect(isRetryableMutation({ op: "improvementFace", action: "list" })).toBe(false);
    expect(isRetryableMutation({ op: "improvementFace", action: "consent", id: "p1-a1b2c3d4" })).toBe(true);
    expect(isRetryableMutation({ op: "improvementFace", action: "undo", id: "p1-a1b2c3d4" })).toBe(true);
    // 多 driver 弧 C：写面 op 的可选 sid（车道路由字段，加性——老 server 忽
    // 略未知字段零破坏）不改分类：带 sid 的写与裸形同 vault（重放语义按 op
    // 名，不按车道）；census 面额随形演进=计数不变（server 61 / web 69——
    // 本弧零新 op）。
    expect(isRetryableMutation({ op: "submit", text: "t", sid: "L1" })).toBe(true);
    expect(isRetryableMutation({ op: "interrupt", sid: "L1" })).toBe(true);
    expect(isRetryableMutation({ op: "setMode", mode: "auto", sid: "L1" })).toBe(true);
    expect(isRetryableMutation({ op: "resume", id: "s", sid: "L1" })).toBe(true);
    expect(isRetryableMutation({ op: "answerPermission", allow: true, sid: "L1" })).toBe(true);
    // The enumeration covers EVERY action the client can send: 24
    // unconditional mutations + 18 reads + the 2 dual-form ops = the full
    // 44-action ClientOp union. A new action changes this count — classify it
    // here and update BOTH mirrors (isRetryableMutation + the server's
    // isVaultedMutation) and PROTOCOL.md's vaulted-ops list.
    const actions = new Set<ClientOp["op"]>([...mutations, ...reads].map((o) => o.op));
    actions.add("switch");
    actions.add("recentWorkspaces");
    actions.add("improvementFace");
    // ω99-213: recap joined the reads above → 44 + 1.
    // ω99-235: the pet lane's three ops joined the mutations above → 45 + 3.
    // ω99-242: recoveryStatus joined the reads above → 48 + 1.
    // ω99-258: branchLeaves joined the reads above → 49 + 1.
    // ω99-260: memoryList (read) + memoryDecide (mutation) joined the lists
    // above → 50 + 2 (brief 预判 51 低估一枚——两枚新 action 各归其类).
    // ω99-264: memoryEdit (mutation) joined the mutations above → 52 + 1.
    // ω99-271: petHistory (read) joined the reads above → 53 + 1.
    // ω99-277: sessionSearch (read) joined the reads above → 54 + 1.
    // ω99-279: sessionDelete (read — converging delete, settingsDeleteProvider
    // precedent) joined the reads above → 55 + 1.
    // ω99-283（续，标记见上）: sessionTrashList + sessionRestore (reads — the
    // restore converges like its delete twin: a mid-flap replay lands
    // target-exists or not-found and touches nothing) joined the reads above
    // → 56 + 2.
    // ω99-286（续，标记见上）: sessionContinue (read for census/vaulting —
    // a write semantically, but the driver's busy/tail gates converge a
    // mid-flap replay to started:false, so vaulting would only serve a stale
    // receipt) joined the reads above → 58 + 1.
    // ω99-313: schedulesList (read — the durable schedules' pure store scan,
    // a replay just re-reads) joined the reads above → 59 + 1.
    // ω99-314: fileRevert (mutation — the time machine's restore writes a
    // workspace file) joined the mutations above → 60 + 1.
    // ω99-317: schedulesSetEnabled + schedulesRunNow (mutations — the
    // management face's state write and run-now double-run hazard) joined
    // the mutations above, and schedulesRemove (read — the converging
    // delete) joined the reads above → 61 + 3.
    // ω99-316: sideQuestion (read — the /btw detached side lane; a replay
    // just re-asks) joined the reads above → 64 + 1（后到者随 ω99-317 重编号）.
    // 借鉴弧 α2/α1: recallSteer + answerAskUser (mutations — the recall's CAS
    // and the ask answer both converge on replay; vaulted server-side) joined
    // the mutations above → 65 + 2.
    // 借鉴弧 δ: detachToolCall (mutation — convergent refusals on replay,
    // vaulted like the α2/α1 twins) joined the mutations above → 67 + 1.
    // 永续 v6 wave2 (reef C1): improvementFace (dual-form — list 读/五决策写，
    // mirrors the server's isVaultedMutation branch) joined the dual-form
    // family above → 68 + 1.
    // PB-2 (探针基础设施弧): probeStream + probeRecent + probeStats (reads —
    // the probe telemetry face; a replay re-subscribes/re-scans, never vaulted)
    // joined the reads above → 69 + 3.
    // M85-pet §2: petNewSession + petSetModel + petSetEffort + petSetWorkspace
    // (mutations — the pet toolbar's four writes, vaulted so a mid-flap replay
    // archives exactly once and the config/root switches land exactly once)
    // joined the mutations above → 77 + 4.
    expect(actions.size).toBe(81); // M85-pet §2 工具栏四 op 入表（77→81，写）

    // Report-86 review M1 (report 89 item 1): the count pin above is
    // RUNTIME-only — a new ClientOp action that never enters the lists trips
    // it just when the tests run, not at compile time. This assertion makes
    // tsc itself fail the moment the union grows past the lists: Untested is
    // ClientOp's action union minus every action the two lists (plus the two
    // dual-form ops) classify. Untested is `never` today, so the constraint
    // holds; a new action makes it non-never and tsc rejects the program
    // here. (The lists themselves stay compile-checked in the other direction
    // by `satisfies readonly ClientOp[]` — an action that is not a ClientOp
    // fails tsc too.)
    type AssertNever<T extends never> = T;
    type ActionsTested =
      | (typeof mutations)[number]["op"]
      | (typeof reads)[number]["op"]
      | "switch"
      | "recentWorkspaces"
      | "improvementFace";
    type Untested = Exclude<ClientOp["op"], ActionsTested>;
    type _ClientOpActionsAllTested = AssertNever<Untested>;
  });
});

describe("location helpers", () => {
  it("reads the token from the fragment (URI-decoded, no leading #)", () => {
    expect(tokenFromLocation({ hash: "#abc.def" })).toBe("abc.def");
    expect(tokenFromLocation({ hash: "#a%20b" })).toBe("a b");
    expect(tokenFromLocation({ hash: "" })).toBe("");
  });

  it("derives the ws:// URL from the page origin", () => {
    expect(wsUrlFromLocation({ protocol: "http:", host: "127.0.0.1:8080" })).toBe("ws://127.0.0.1:8080");
    expect(wsUrlFromLocation({ protocol: "https:", host: "x.example" })).toBe("wss://x.example");
  });

  // M65-space §1: the desktop shell marks the sidecar URL with ?shell=desktop
  // (the Rust navigation adds it); the entry stamps <html data-shell> from it
  // BEFORE first paint so the topbar's traffic-light inset applies at render.
  it("M65-space §1: reads the shell mark from ?shell= (desktop only, absent otherwise)", () => {
    expect(shellFromLocation({ search: "?shell=desktop" })).toBe("desktop");
    expect(shellFromLocation({ search: "" })).toBeNull();
    expect(shellFromLocation({ search: "?x=1" })).toBeNull();
    expect(shellFromLocation({ search: "?shell=browser" })).toBeNull();
  });
});

describe("mode helpers (TUI parity)", () => {
  it("modeLabel: the 0.3.13 CC vocabulary — workspace displays as accept; plan is itself", () => {
    expect(modeLabel("workspace")).toBe("accept");
    expect(modeLabel("ask")).toBe("ask");
    expect(modeLabel("auto")).toBe("auto");
    expect(modeLabel("plan")).toBe("plan");
  });

  it("cycleMode: workspace → ask → auto → plan → workspace", () => {
    expect(cycleMode("workspace")).toBe("ask");
    expect(cycleMode("ask")).toBe("auto");
    expect(cycleMode("auto")).toBe("plan");
    expect(cycleMode("plan")).toBe("workspace");
  });
});

// M63 §A — the picker's submission lane: same-provider rows ride /model
// (config mutation), cross-provider rows ride /provider (client rebuild at
// the turn boundary + a fully cold cache). One pure rule for the click
// handler and the tests.
describe("modelPickCommand (M63 §A)", () => {
  it("same-provider rows submit /model <name>", () => {
    expect(modelPickCommand({ provider: "deepseek", model: "deepseek-v4" }, "deepseek")).toBe("/model deepseek-v4");
    expect(modelPickCommand({ provider: "glm", model: "glm-5" }, "glm")).toBe("/model glm-5");
  });

  it("cross-provider rows submit /provider <name>; an unknown current provider rides /model", () => {
    expect(modelPickCommand({ provider: "glm", model: "glm-5" }, "deepseek")).toBe("/provider glm");
    expect(modelPickCommand({ provider: "qwen", model: "qwen4-max" }, "deepseek")).toBe("/provider qwen");
    expect(modelPickCommand({ provider: "glm", model: "glm-5" }, undefined)).toBe("/model glm-5");
  });
});

// 0.3.15（用户需求：LLM 回复耗时展示）——回复卡 meta 的时长格式器。
describe("formatDur (0.3.15)", () => {
  it("renders sub-100ms as <0.1s, seconds with one decimal, then m/h compaction", () => {
    expect(formatDur(50)).toBe("<0.1s");
    expect(formatDur(1_500)).toBe("1.5s");
    expect(formatDur(61_234)).toBe("1m01s");
    expect(formatDur(3_723_456)).toBe("1h02m");
  });
});
