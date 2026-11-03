// @wudao-org/server tests — the localhost WS contract: first-frame auth matrix
// (wrong token / no frame / timeout / non-JSON), Host allowlist, single-client
// rejection, the two-channel relay + op round-trip against a scripted driver
// port, reconnect full replay, static placeholder, and loopback-only binds.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { get } from "node:http";
import { createUiServer, type UiDriverPort, type UiServer } from "../src/index.js";

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

/** A scripted driver port: submit() appends a user entry, flips busy, appends
 *  an assistant entry, and flips busy back — enough to observe both channels. */
function scriptedDriver(script: { reply: string }[] = [{ reply: "DONE" }]): UiDriverPort & { requests: string[] } {
  let status: Record<string, unknown> = { live: { reasoning: "", answer: "", busyTools: [] }, busy: false, mode: "default" };
  let history: unknown[] = [];
  let statusCbs = new Set<() => void>();
  let historyCbs = new Set<(entries: readonly unknown[], reset: boolean) => void>();
  let eventCbs = new Set<(event: unknown) => void>();
  const requests: string[] = [];
  return {
    requests,
    subscribe: (cb) => (statusCbs.add(cb), () => statusCbs.delete(cb)),
    getStatus: () => status,
    getHistory: () => history,
    onHistory: (cb) => (historyCbs.add(cb), () => historyCbs.delete(cb)),
    onLoopEvent: (cb) => (eventCbs.add(cb), () => eventCbs.delete(cb)),
    submit: (text: string, opts) => {
      requests.push(text);
      const emitStatus = () => { status = { ...status }; for (const cb of [...statusCbs]) cb(); };
      const append = (...entries: unknown[]) => { history = [...history, ...entries]; for (const cb of [...historyCbs]) cb(entries, false); };
      status = { ...status, busy: true };
      emitStatus();
      append({ kind: "user", text });
      void (async () => {
        await wait(20);
        for (const e of eventCbs) e({ type: "model_call_started", turn: 1 });
        append({ kind: "assistant", text: script[0]?.reply ?? "DONE" });
        status = { ...status, busy: false };
        emitStatus();
      })();
      return "started";
    },
    interrupt: () => {},
    setMode: (mode: string) => { status = { ...status, mode }; for (const cb of [...statusCbs]) cb(); },
    answerPermission: () => false,
    listSlashCommands: () => [{ name: "plan", description: "plan read-only", source: "builtin" }],
    sessions: async () => [{ id: "seeded1", messages: 2 }],
    resume: async () => ({ ok: true }),
    rewind: async () => "rewound to before step 1",
  };
}

interface Frame {
  t: string;
  state?: unknown;
  entries?: unknown[];
  reset?: boolean;
  event?: unknown;
  id?: unknown;
  ok?: unknown;
  err?: string;
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

function httpGet(port: number, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    get({ host, port, path: "/", headers: { host } }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    }).on("error", reject);
  });
}

describe("auth matrix (§2)", () => {
  it("wrong token → close 4401", async () => {
    const server = await createUiServer({ driver: scriptedDriver(), token: "right-token" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    auth(c.ws, "wrong-token");
    const ev = await c.closed;
    expect(ev.code).toBe(4401);
  });

  it("no auth frame within the window → close 4401", async () => {
    const server = await createUiServer({ driver: scriptedDriver(), token: "right-token", authTimeoutMs: 80 });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    const ev = await c.closed;
    expect(ev.code).toBe(4401);
  });

  it("a non-auth first frame → close 4401 (even with a matching token inside)", async () => {
    const server = await createUiServer({ driver: scriptedDriver(), token: "right-token", authTimeoutMs: 1000 });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "op", id: 1, op: { op: "interrupt" } }));
    const ev = await c.closed;
    expect(ev.code).toBe(4401);
  });

  it("garbage bytes as the first frame → close 4401", async () => {
    const server = await createUiServer({ driver: scriptedDriver(), token: "t", authTimeoutMs: 1000 });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send("not json");
    const ev = await c.closed;
    expect(ev.code).toBe(4401);
  });

  it("correct token → state + full history replay", async () => {
    const server = await createUiServer({ driver: scriptedDriver(), token: "right-token" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    auth(c.ws, "right-token");
    await until(() => c.frames.some((f) => f.t === "history" && f.reset === true), "initial replay");
    expect(c.frames[0]?.t).toBe("state");
    expect(c.frames.some((f) => f.t === "history" && f.reset === true && Array.isArray(f.entries))).toBe(true);
    c.ws.close();
    await c.closed;
  });
});

describe("Host allowlist (DNS-rebinding guard)", () => {
  it("a foreign Host header gets HTTP 403; loopback names are served", async () => {
    const server = await createUiServer({ driver: scriptedDriver() });
    servers.push(server);
    const bad = await httpGet(server.port, "127.0.0.1").then((r) => r.status).catch(() => -1);
    // The 403 path needs a foreign Host header; node's get with host option
    // sends that host — use a raw request with a spoofed header.
    const spoofed = await new Promise<number>((resolve) => {
      const req = get({ port: server.port, path: "/", headers: { host: "evil.example.com" } }, (res) => resolve(res.statusCode ?? 0));
      req.on("error", () => resolve(-1));
    });
    expect(spoofed).toBe(403);
    expect(bad).not.toBe(403);
    const ok = await httpGet(server.port, "127.0.0.1");
    expect(ok.status).toBe(200);
  });

  it("a non-loopback bind is refused outright (fail-closed)", async () => {
    await expect(createUiServer({ driver: scriptedDriver(), host: "0.0.0.0" })).rejects.toThrow(/loopback/);
  });
});

describe("single client slot", () => {
  it("a second connection while one is authed → close 4000 with a reason", async () => {
    const server = await createUiServer({ driver: scriptedDriver(), token: "t" });
    servers.push(server);
    const first = connect(server.port);
    await first.open;
    auth(first.ws, "t");
    await until(() => first.frames.some((f) => f.t === "history"), "first authed");
    const second = connect(server.port);
    await second.open;
    const ev = await second.closed;
    expect(ev.code).toBe(4000);
    expect(ev.reason).toContain("another client");
    first.ws.close();
  });
});

describe("round-trip (scripted driver)", () => {
  it("submit drives the driver: result + state busy→idle + appended history + raw event", async () => {
    const driver = scriptedDriver([{ reply: "WUDAO-ROUNDTRIP" }]);
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    auth(c.ws, "t");
    await until(() => c.frames.some((f) => f.t === "history" && f.reset === true), "initial replay");

    c.ws.send(JSON.stringify({ t: "op", id: 41, op: { op: "submit", text: "w node -v" } }));
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 41), "submit result");
    const result = c.frames.find((f) => f.t === "result" && f.id === 41);
    expect(result?.ok).toBe("started");
    expect(driver.requests).toEqual(["w node -v"]);

    await until(() => c.frames.some((f) => f.t === "state" && (f.state as { busy?: boolean }).busy === true), "busy state");
    await until(() => c.frames.some((f) => f.t === "event"), "raw loop event");
    // 137（监督者车道）：事件帧带 at（epoch ms，转发同 tick）——裸 LoopEvent
    // 自身无时间戳，时序消费者读本字段。
    {
      const ev = c.frames.find((f) => f.t === "event") as { at?: number } | undefined;
      expect(typeof ev?.at).toBe("number");
    }
    await until(() => {
      const hist = c.frames.filter((f) => f.t === "history" && f.reset !== true).flatMap((f) => f.entries ?? []);
      return hist.some((e) => (e as { kind?: string }).kind === "assistant" && (e as { text?: string }).text === "WUDAO-ROUNDTRIP");
    }, "assistant entry relayed");
    await until(() => c.frames.some((f) => f.t === "state" && (f.state as { busy?: boolean }).busy === false), "idle state");
    c.ws.close();
  });

  it("ops answer with correlated results; unknown/malformed ops error, never close", async () => {
    const server = await createUiServer({ driver: scriptedDriver(), token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    auth(c.ws, "t");
    const send = (id: number, op: unknown): void => c.ws.send(JSON.stringify({ t: "op", id, op }));
    send(1, { op: "listSlashCommands" });
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 1), "commands result");
    expect(c.frames.find((f) => f.t === "result" && f.id === 1)?.ok).toEqual([{ name: "plan", description: "plan read-only", source: "builtin" }]);

    send(2, { op: "sessions" });
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 2), "sessions result");
    expect(c.frames.find((f) => f.t === "result" && f.id === 2)?.ok).toEqual([{ id: "seeded1", messages: 2 }]);

    send(3, { op: "resume", id: "seeded1" });
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 3), "resume result");
    // ω99-225: the resume verdict relays as the outcome object.
    expect(c.frames.find((f) => f.t === "result" && f.id === 3)?.ok).toEqual({ ok: true });

    send(4, { op: "rewind", target: "last" });
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 4), "rewind result");
    expect(c.frames.find((f) => f.t === "result" && f.id === 4)?.ok).toContain("rewound");

    send(5, { op: "answerPermission", allow: true });
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 5), "answerPermission result");
    expect(c.frames.find((f) => f.t === "result" && f.id === 5)?.ok).toBe(false);

    // 0.3.14 #1: the scope lane — valid values pass validation, anything
    // else is refused with an err (fail-closed, like setMode above).
    send(55, { op: "answerPermission", allow: true, scope: "forever" });
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 55), "bad scope result");
    expect(c.frames.find((f) => f.t === "result" && f.id === 55)?.err).toContain("scope");

    send(6, { op: "setMode", mode: "auto" });
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 6), "setMode result");
    send(7, { op: "setMode", mode: "yolo" });
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 7), "bad setMode result");
    expect(c.frames.find((f) => f.t === "result" && f.id === 7)?.err).toContain("mode");
    // The good setMode landed in the status channel.
    await until(() => c.frames.some((f) => f.t === "state" && (f.state as { mode?: string }).mode === "auto"), "mode state frame");

    send(8, { op: "no-such-op" });
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 8), "unknown op result");
    expect(c.frames.find((f) => f.t === "result" && f.id === 8)?.err).toContain("unknown op");

    send(9, { op: "submit" });
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 9), "malformed submit result");
    expect(c.frames.find((f) => f.t === "result" && f.id === 9)?.err).toContain("text");

    // Nothing above closed the socket.
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
  });
});

// M76-ux2 §8 — the ctxInfo op: the StatusBar ctx hover's breakdown rides
// the same auth-gated op channel; OPTIONAL on the driver port like the file
// ops (an absent handler errors cleanly, never closes).
describe("ctxInfo op (M76-ux2 §8)", () => {
  it("round-trips the driver's section breakdown", async () => {
    const driver = {
      ...scriptedDriver(),
      ctxInfo: async () => ({ systemTokens: 3000, toolsTokens: 2000, messagesTokens: 15000, availableTokens: 44000 }),
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    auth(c.ws, "t");
    await until(() => c.frames.some((f) => f.t === "history" && f.reset === true), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 41, op: { op: "ctxInfo" } }));
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 41), "ctxInfo result");
    const r = c.frames.find((f) => f.t === "result" && f.id === 41);
    expect(r?.err).toBeUndefined();
    expect(r?.ok).toEqual({ systemTokens: 3000, toolsTokens: 2000, messagesTokens: 15000, availableTokens: 44000 });
    c.ws.close();
  });

  it("a driver without the handler errors cleanly (old driver, never a close)", async () => {
    const server = await createUiServer({ driver: scriptedDriver(), token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    auth(c.ws, "t");
    await until(() => c.frames.some((f) => f.t === "history" && f.reset === true), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 42, op: { op: "ctxInfo" } }));
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 42), "ctxInfo result");
    const r = c.frames.find((f) => f.t === "result" && f.id === 42);
    expect(r?.ok).toBeUndefined();
    expect(r?.err).toBe("ctx info not supported by this driver");
    expect(c.ws.readyState).toBe(WebSocket.OPEN); // an op error never closes
    c.ws.close();
  });
});

// ω99-213: #R — the away-recap op relay: same contract as ctxInfo (OPTIONAL
// driver method, shape gate, exactly one result), plus the lane's own rule —
// ok:undefined is a LEGITIMATE quiet answer, distinct from an err string.
describe("recap op (ω99-213)", () => {
  const payload = { stats: { turns: 2, toolCalls: 5, filesTouched: 1, sinceTs: 1_700_000_000_000 }, narrative: "完成了：a\n还在进行：b\n等你决定：c" };

  it("round-trips args and payload; a no-recap answer relays as ok:undefined, not err", async () => {
    const calls: { sessionId: string; sinceMark: number; sinceTs?: number }[] = [];
    const driver = {
      ...scriptedDriver(),
      recap: async (sessionId: string, sinceMark: number, sinceTs?: number) => {
        calls.push({ sessionId, sinceMark, ...(sinceTs !== undefined ? { sinceTs } : {}) });
        return calls.length === 1 ? payload : undefined;
      },
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    auth(c.ws, "t");
    await until(() => c.frames.some((f) => f.t === "history" && f.reset === true), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 61, op: { op: "recap", sessionId: "s1", sinceMark: 3, sinceTs: 1_700_000_000_000 } }));
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 61), "recap result 1");
    const r1 = c.frames.find((f) => f.t === "result" && f.id === 61);
    expect(r1?.err).toBeUndefined();
    expect(r1?.ok).toEqual(payload);
    expect(calls).toEqual([{ sessionId: "s1", sinceMark: 3, sinceTs: 1_700_000_000_000 }]);
    c.ws.send(JSON.stringify({ t: "op", id: 62, op: { op: "recap", sessionId: "s1", sinceMark: 3 } }));
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 62), "recap result 2");
    const r2 = c.frames.find((f) => f.t === "result" && f.id === 62);
    expect(r2?.err).toBeUndefined();
    expect(r2?.ok).toBeUndefined(); // JSON drops the undefined ok — quiet ≠ error
    c.ws.close();
  });

  it("shape-gates: bad mark / empty session / unsupported driver → err, socket stays open", async () => {
    const driver = { ...scriptedDriver(), recap: async () => payload };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    auth(c.ws, "t");
    await until(() => c.frames.some((f) => f.t === "history" && f.reset === true), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 63, op: { op: "recap", sessionId: "s1", sinceMark: -1 } }));
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 63), "bad mark result");
    expect(c.frames.find((f) => f.t === "result" && f.id === 63)?.err).toContain("sinceMark");
    c.ws.send(JSON.stringify({ t: "op", id: 64, op: { op: "recap", sessionId: "", sinceMark: 0 } }));
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 64), "empty session result");
    expect(c.frames.find((f) => f.t === "result" && f.id === 64)?.err).toContain("sessionId");
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
    const bare = await createUiServer({ driver: scriptedDriver(), token: "t" });
    servers.push(bare);
    const c2 = connect(bare.port);
    await c2.open;
    auth(c2.ws, "t");
    await until(() => c2.frames.some((f) => f.t === "history" && f.reset === true), "initial replay 2");
    c2.ws.send(JSON.stringify({ t: "op", id: 65, op: { op: "recap", sessionId: "s1", sinceMark: 0 } }));
    await until(() => c2.frames.some((f) => f.t === "result" && f.id === 65), "unsupported result");
    expect(c2.frames.find((f) => f.t === "result" && f.id === 65)?.err).toBe("recap not supported by this driver");
    c2.ws.close();
  });
});

// workspace-ux B1 — the panel-root ops: panelRootSet (switch the file panel's
// view root) and agentRootStatus (the dual-root snapshot). OPTIONAL on the
// driver port like every data op: an absent handler errors cleanly, a bad
// payload errors at the shape gate, and neither ever closes the socket.
describe("panel-root ops (workspace-ux B1)", () => {
  it("panelRootSet round-trips the new root; agentRootStatus the dual-root state; a driver error relays as err", async () => {
    const driver = {
      ...scriptedDriver(),
      panelRootSet: async (path: string) => {
        if (path === "/w/missing") throw new Error("no such directory: /w/missing");
        return { root: path };
      },
      agentRootStatus: async () => ({ panelRoot: "/w/panel", agentRoot: "/w/agent", aligned: false }),
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    auth(c.ws, "t");
    await until(() => c.frames.some((f) => f.t === "history" && f.reset === true), "initial replay");

    c.ws.send(JSON.stringify({ t: "op", id: 51, op: { op: "panelRootSet", path: "/w/panel" } }));
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 51), "panelRootSet result");
    expect(c.frames.find((f) => f.t === "result" && f.id === 51)?.ok).toEqual({ root: "/w/panel" });

    c.ws.send(JSON.stringify({ t: "op", id: 52, op: { op: "agentRootStatus" } }));
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 52), "agentRootStatus result");
    expect(c.frames.find((f) => f.t === "result" && f.id === 52)?.ok).toEqual({
      panelRoot: "/w/panel",
      agentRoot: "/w/agent",
      aligned: false,
    });

    // The driver's typed errors (no such directory / not a directory) relay as
    // op errors, never a close.
    c.ws.send(JSON.stringify({ t: "op", id: 53, op: { op: "panelRootSet", path: "/w/missing" } }));
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 53), "failed set result");
    expect(c.frames.find((f) => f.t === "result" && f.id === 53)?.err).toContain("no such directory");
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
  });

  it("a non-string or empty path errors; a driver without the ops errors cleanly, never closes", async () => {
    const driver = { ...scriptedDriver(), panelRootSet: async () => ({ root: "" }) };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    auth(c.ws, "t");
    const send = (id: number, op: unknown): void => c.ws.send(JSON.stringify({ t: "op", id, op }));

    send(61, { op: "panelRootSet", path: 7 });
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 61), "bad path result");
    expect(c.frames.find((f) => f.t === "result" && f.id === 61)?.err).toContain("panelRootSet path must be a non-empty string");
    send(62, { op: "panelRootSet", path: "" });
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 62), "empty path result");
    expect(c.frames.find((f) => f.t === "result" && f.id === 62)?.err).toContain("panelRootSet path must be a non-empty string");
    c.ws.close();

    // The unsupported branch is checked BEFORE the payload shape (the file-ops
    // contract) — a driver without the ops gets the clean refusal for both.
    const bare = await createUiServer({ driver: scriptedDriver(), token: "t" });
    servers.push(bare);
    const c2 = connect(bare.port);
    await c2.open;
    auth(c2.ws, "t");
    const send2 = (id: number, op: unknown): void => c2.ws.send(JSON.stringify({ t: "op", id, op }));
    send2(63, { op: "panelRootSet", path: "/w/any" });
    await until(() => c2.frames.some((f) => f.t === "result" && f.id === 63), "unsupported set result");
    expect(c2.frames.find((f) => f.t === "result" && f.id === 63)?.err).toBe("panel root ops not supported by this driver");
    send2(64, { op: "agentRootStatus" });
    await until(() => c2.frames.some((f) => f.t === "result" && f.id === 64), "unsupported status result");
    expect(c2.frames.find((f) => f.t === "result" && f.id === 64)?.err).toBe("panel root ops not supported by this driver");
    expect(c2.ws.readyState).toBe(WebSocket.OPEN);
    c2.ws.close();
  });
});

// workspace-ux B2 — the agent-root switch: same op contract as panelRootSet
// (OPTIONAL on the port; shape gate; driver errors relay as op errors). The
// busy-queue/notice/note semantics live in the cli driver — pinned there
// (packages/cli/tests/agent-root-switch.test.ts); this is the relay's pin.
describe("agentRootSwitch op (workspace-ux B2)", () => {
  it("round-trips {applied}/{queued}; driver errors relay as err; the shape gate and the absent handler refuse cleanly", async () => {
    const driver = {
      ...scriptedDriver(),
      agentRootSwitch: async (path: string) => {
        if (path === "/w/missing") throw new Error("no such directory: /w/missing");
        return path === "/w/busy" ? { applied: false, queued: true } : { applied: true, queued: false };
      },
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    auth(c.ws, "t");
    await until(() => c.frames.some((f) => f.t === "history" && f.reset === true), "initial replay");

    c.ws.send(JSON.stringify({ t: "op", id: 71, op: { op: "agentRootSwitch", path: "/w/next" } }));
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 71), "idle switch result");
    expect(c.frames.find((f) => f.t === "result" && f.id === 71)?.ok).toEqual({ applied: true, queued: false });

    c.ws.send(JSON.stringify({ t: "op", id: 72, op: { op: "agentRootSwitch", path: "/w/busy" } }));
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 72), "busy switch result");
    expect(c.frames.find((f) => f.t === "result" && f.id === 72)?.ok).toEqual({ applied: false, queued: true });

    c.ws.send(JSON.stringify({ t: "op", id: 73, op: { op: "agentRootSwitch", path: "/w/missing" } }));
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 73), "failed switch result");
    expect(c.frames.find((f) => f.t === "result" && f.id === 73)?.err).toContain("no such directory");
    expect(c.ws.readyState).toBe(WebSocket.OPEN); // an op error never closes
    c.ws.close();

    // Shape gate + absent handler (the same contract as panelRootSet).
    const bare = await createUiServer({ driver: { ...scriptedDriver(), agentRootSwitch: async () => ({ applied: true, queued: false }) }, token: "t" });
    servers.push(bare);
    const c2 = connect(bare.port);
    await c2.open;
    auth(c2.ws, "t");
    c2.ws.send(JSON.stringify({ t: "op", id: 74, op: { op: "agentRootSwitch", path: "" } }));
    await until(() => c2.frames.some((f) => f.t === "result" && f.id === 74), "empty path result");
    expect(c2.frames.find((f) => f.t === "result" && f.id === 74)?.err).toBe("agentRootSwitch path must be a non-empty string");
    c2.ws.close();

    const none = await createUiServer({ driver: scriptedDriver(), token: "t" });
    servers.push(none);
    const c3 = connect(none.port);
    await c3.open;
    auth(c3.ws, "t");
    c3.ws.send(JSON.stringify({ t: "op", id: 75, op: { op: "agentRootSwitch", path: "/w/any" } }));
    await until(() => c3.frames.some((f) => f.t === "result" && f.id === 75), "unsupported switch result");
    expect(c3.frames.find((f) => f.t === "result" && f.id === 75)?.err).toBe("agent root ops not supported by this driver");
    expect(c3.ws.readyState).toBe(WebSocket.OPEN);
    c3.ws.close();
  });
});

describe("reconnect", () => {
  it("after a drop, a new client re-auths and gets the FULL history replay", async () => {
    const driver = scriptedDriver([{ reply: "FIRST" }]);
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c1 = connect(server.port);
    await c1.open;
    auth(c1.ws, "t");
    await until(() => c1.frames.some((f) => f.t === "history" && f.reset === true), "initial replay");
    c1.ws.send(JSON.stringify({ t: "op", id: 1, op: { op: "submit", text: "w node -v" } }));
    await until(() => c1.frames.some((f) => f.t === "state" && (f.state as { busy?: boolean }).busy === false && c1.frames.filter((x) => x.t === "history").length > 1), "run relayed");
    c1.ws.close();
    await c1.closed;
    await wait(30); // let the server release the slot

    const c2 = connect(server.port);
    await c2.open;
    auth(c2.ws, "t");
    await until(() => c2.frames.some((f) => f.t === "history" && f.reset === true), "reconnect replay");
    const replay = c2.frames.find((f) => f.t === "history" && f.reset === true);
    const kinds = (replay?.entries ?? []).map((e) => (e as { kind: string }).kind);
    expect(kinds).toEqual(["user", "assistant"]);
    c2.ws.close();
  });
});

describe("static serving", () => {
  it("serves the placeholder page when no staticDir exists", async () => {
    const server = await createUiServer({ driver: scriptedDriver() });
    servers.push(server);
    const res = await httpGet(server.port, "127.0.0.1");
    expect(res.status).toBe(200);
    expect(res.body).toContain("wudao ui");
    expect(res.body).toContain("location.hash");
    expect(res.body).not.toContain(server.token); // the token is NEVER in the page
  });

  it("serves the built frontend when staticDir exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wudao-server-static-"));
    try {
      writeFileSync(join(dir, "index.html"), "<!doctype html><title>BUILT-FRONTEND</title>", "utf8");
      const server = await createUiServer({ driver: scriptedDriver(), staticDir: dir });
      servers.push(server);
      const res = await httpGet(server.port, "127.0.0.1");
      expect(res.body).toContain("BUILT-FRONTEND");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
