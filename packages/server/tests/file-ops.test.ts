// ω99-55 — the file lane over the WS protocol: the PROTOCOL "fileSave" op
// (shape validation, driver passthrough, typed admission error relay, first-
// frame auth) and the submit envelope's optional files field (valid blocks
// pass through, junk shapes refuse before the driver is touched, absent =
// the pre-ω99-55 submit).
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
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

const FILE = "JVBERi0="; // base64 of "%PDF"

function baseDriver(overrides: Partial<UiDriverPort> = {}): UiDriverPort {
  const status = { live: { reasoning: "", answer: "", busyTools: [] }, busy: false, mode: "default" };
  const cbs = new Set<() => void>();
  return {
    subscribe: (cb) => (cbs.add(cb), () => cbs.delete(cb)),
    getStatus: () => status,
    getHistory: () => [],
    onHistory: () => () => {},
    onLoopEvent: () => () => {},
    submit: () => "notice",
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
    ...overrides,
  };
}

interface Frame {
  t: string;
  id?: number;
  ok?: unknown;
  err?: string;
}

function connect(port: number, token: string): { ws: WebSocket; frames: Frame[]; open: Promise<void> } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames: Frame[] = [];
  const open = new Promise<void>((resolve) => ws.once("open", resolve));
  ws.on("message", (data) => frames.push(JSON.parse(String(data)) as Frame));
  return { ws, frames, open };
}

async function opRoundTrip(port: number, token: string, op: Record<string, unknown>): Promise<{ ok?: unknown; err?: string }> {
  const c = connect(port, token);
  await c.open;
  c.ws.send(JSON.stringify({ t: "auth", token }));
  await until(() => c.frames.some((f) => f.t === "history"), "auth replay");
  c.ws.send(JSON.stringify({ t: "op", id: 41, op }));
  await until(() => c.frames.some((f) => f.t === "result" && f.id === 41), "op result");
  c.ws.close();
  const res = c.frames.find((f) => f.t === "result" && f.id === 41);
  return { ok: res?.ok, err: res?.err };
}

const fblock = { kind: "file" as const, name: "spec.pdf", bytes: 5, attachmentId: `sha256:${"a".repeat(64)}` };

describe("fileSave op (ω99-55)", () => {
  it("relays save → FileBlocks through an authed driver", async () => {
    const saved: { data: string; name: string }[] = [];
    const driver = baseDriver({
      fileSave: async (inputs) => {
        saved.push(...inputs);
        return inputs.map((_, i) => ({ kind: "file", name: inputs[i]!.name, bytes: 5, attachmentId: `sha256:${String(i).padStart(64, "0")}` }));
      },
    });
    const server = await createUiServer({ driver });
    servers.push(server);
    const res = await opRoundTrip(server.port, server.token, {
      op: "fileSave",
      inputs: [{ data: FILE, name: "spec.pdf" }],
    });
    expect(res.err).toBeUndefined();
    expect(res.ok).toEqual([{ kind: "file", name: "spec.pdf", bytes: 5, attachmentId: `sha256:${"0".repeat(64)}` }]);
    expect(saved).toEqual([{ data: FILE, name: "spec.pdf" }]);
  });

  it("shape validation refuses junk before the driver is touched", async () => {
    let called = 0;
    const driver = baseDriver({
      fileSave: async () => {
        called += 1;
        return [];
      },
    });
    const server = await createUiServer({ driver });
    servers.push(server);
    expect((await opRoundTrip(server.port, server.token, { op: "fileSave", inputs: [] })).err).toMatch(/non-empty inputs array/);
    expect((await opRoundTrip(server.port, server.token, { op: "fileSave", inputs: [{ data: 5, name: "a" }] })).err).toMatch(/\{data: base64 string, name: string\}/);
    expect((await opRoundTrip(server.port, server.token, { op: "fileSave", inputs: [{ data: FILE }] })).err).toMatch(/\{data: base64 string, name: string\}/);
    expect(called).toBe(0);
  });

  it("relays the driver's typed admission error verbatim", async () => {
    const driver = baseDriver({
      fileSave: async () => {
        const err = new Error("10 files exceed the per-request cap of 9") as Error & { code?: string };
        err.name = "AttachmentAdmissionError";
        err.code = "TOO_MANY_FILES";
        throw err;
      },
    });
    const server = await createUiServer({ driver });
    servers.push(server);
    const res = await opRoundTrip(server.port, server.token, {
      op: "fileSave",
      inputs: Array.from({ length: 10 }, () => ({ data: FILE, name: "a.pdf" })),
    });
    expect(res.err).toMatch(/TOO_MANY_FILES|exceed the per-request cap/);
  });

  it("absent driver support degrades with a clean error", async () => {
    const server = await createUiServer({ driver: baseDriver() });
    servers.push(server);
    const res = await opRoundTrip(server.port, server.token, { op: "fileSave", inputs: [{ data: FILE, name: "a" }] });
    expect(res.err).toMatch(/attachment ops not supported/);
  });
});

describe("submit's optional files field (protocol v1 increment)", () => {
  it("valid file blocks pass through to the driver", async () => {
    const seen: { text: string; files?: readonly unknown[] }[] = [];
    const driver = baseDriver({
      submit: (text, opts) => {
        seen.push({ text, files: opts?.files });
        return "started";
      },
    });
    const server = await createUiServer({ driver });
    servers.push(server);
    const res = await opRoundTrip(server.port, server.token, { op: "submit", text: "review", files: [fblock] });
    expect(res.err).toBeUndefined();
    expect(res.ok).toBe("started");
    expect(seen[0]?.files).toEqual([fblock]);
  });

  it("absent files = the pre-ω99-55 submit (no field on the driver opts)", async () => {
    const seen: { files?: readonly unknown[] }[] = [];
    const driver = baseDriver({
      submit: (_text, opts) => {
        seen.push({ files: opts?.files });
        return "started";
      },
    });
    const server = await createUiServer({ driver });
    servers.push(server);
    const res = await opRoundTrip(server.port, server.token, { op: "submit", text: "hi" });
    expect(res.ok).toBe("started");
    expect(seen[0]?.files).toBeUndefined();
  });

  it("junk file shapes refuse before the driver is touched", async () => {
    let called = 0;
    const driver = baseDriver({
      submit: () => {
        called += 1;
        return "started";
      },
    });
    const server = await createUiServer({ driver });
    servers.push(server);
    expect((await opRoundTrip(server.port, server.token, { op: "submit", text: "hi", files: "nope" })).err).toMatch(/files must be an array/);
    expect((await opRoundTrip(server.port, server.token, { op: "submit", text: "hi", files: [{ kind: "video" }] })).err).toMatch(/kind:'file'/);
    expect((await opRoundTrip(server.port, server.token, { op: "submit", text: "hi", files: [{ kind: "file", name: "a", bytes: 1, attachmentId: "../../x" }] })).err).toMatch(/kind:'file'/);
    expect(called).toBe(0);
  });
});
