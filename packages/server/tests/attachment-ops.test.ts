// M79 §4 — the attachment ops over the WS protocol: same first-frame auth
// gate as every op, shape validation of both payloads, pass-through of the
// driver's typed admission errors, absent-handler degradation, and the
// submit envelope's optional images field (valid blocks pass through, junk
// shapes refuse before the driver is touched).
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

const IMAGE = "QUJD"; // base64 of "ABC"

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

describe("attachmentSave / attachmentGet ops", () => {
  it("relays save → refs and get → base64 through an authed driver", async () => {
    const saved: { data: string; mediaType: string }[] = [];
    const driver = baseDriver({
      attachmentSave: async (inputs) => {
        saved.push(...inputs);
        return inputs.map((_, i) => ({ kind: "image", attachmentId: `att-${i}`, mediaType: inputs[i]!.mediaType, byteLength: 3 }));
      },
      attachmentGet: async (ref) => ({ data: IMAGE, mediaType: ref.mediaType }),
    });
    const server = await createUiServer({ driver });
    servers.push(server);

    const save = await opRoundTrip(server.port, server.token, {
      op: "attachmentSave",
      inputs: [{ data: IMAGE, mediaType: "image/png" }],
    });
    expect(save.err).toBeUndefined();
    expect(save.ok).toEqual([{ kind: "image", attachmentId: "att-0", mediaType: "image/png", byteLength: 3 }]);
    expect(saved).toEqual([{ data: IMAGE, mediaType: "image/png" }]);

    const got = await opRoundTrip(server.port, server.token, {
      op: "attachmentGet",
      ref: { attachmentId: "att-0", mediaType: "image/png", byteLength: 3 },
    });
    expect(got.err).toBeUndefined();
    expect(got.ok).toEqual({ data: IMAGE, mediaType: "image/png" });
  });

  it("rides the same first-frame auth — an unauthed op frame never reaches the driver", async () => {
    let called = 0;
    const driver = baseDriver({
      attachmentSave: async () => {
        called += 1;
        return [];
      },
    });
    const server = await createUiServer({ driver });
    servers.push(server);
    const c = connect(server.port, server.token);
    await c.open;
    c.ws.send(JSON.stringify({ t: "op", id: 7, op: { op: "attachmentSave", inputs: [{ data: IMAGE, mediaType: "image/png" }] } }));
    await wait(150);
    expect(called).toBe(0);
    c.ws.close();
  });

  it("relays the driver's typed admission error verbatim (limits live in the store)", async () => {
    const driver = baseDriver({
      attachmentSave: async () => {
        const err = new Error("10 images exceed the per-request cap of 9") as Error & { code?: string };
        err.name = "AttachmentAdmissionError";
        err.code = "TOO_MANY_IMAGES";
        throw err;
      },
    });
    const server = await createUiServer({ driver });
    servers.push(server);
    const res = await opRoundTrip(server.port, server.token, {
      op: "attachmentSave",
      inputs: Array.from({ length: 10 }, () => ({ data: IMAGE, mediaType: "image/png" })),
    });
    expect(res.ok).toBeUndefined();
    expect(res.err).toMatch(/TOO_MANY_IMAGES|exceed the per-request cap/);
  });

  it("absent handler → clean unsupported error", async () => {
    const server = await createUiServer({ driver: baseDriver() });
    servers.push(server);
    expect((await opRoundTrip(server.port, server.token, { op: "attachmentSave", inputs: [{ data: IMAGE, mediaType: "image/png" }] })).err)
      .toBe("attachment ops not supported by this driver");
    expect((await opRoundTrip(server.port, server.token, { op: "attachmentGet", ref: { attachmentId: "x", mediaType: "image/png", byteLength: 1 } })).err)
      .toBe("attachment ops not supported by this driver");
  });

  it("shape validation refuses junk before the driver is touched", async () => {
    let called = 0;
    const driver = baseDriver({
      attachmentSave: async () => {
        called += 1;
        return [];
      },
      attachmentGet: async () => {
        called += 1;
        return { data: IMAGE, mediaType: "image/png" };
      },
    });
    const server = await createUiServer({ driver });
    servers.push(server);
    expect((await opRoundTrip(server.port, server.token, { op: "attachmentSave", inputs: "not-an-array" })).err).toMatch(/inputs array/);
    expect((await opRoundTrip(server.port, server.token, { op: "attachmentSave", inputs: [] })).err).toMatch(/non-empty/);
    expect((await opRoundTrip(server.port, server.token, { op: "attachmentSave", inputs: [{ data: 7, mediaType: "image/png" }] })).err).toMatch(/data: base64 string/);
    expect((await opRoundTrip(server.port, server.token, { op: "attachmentGet", ref: { attachmentId: 1 } })).err).toMatch(/ref \{attachmentId/);
    expect(called).toBe(0);
  });
});

describe("submit's optional images field (protocol v1 increment)", () => {
  it("valid image blocks pass through to the driver", async () => {
    const seen: { text: string; images?: readonly unknown[] }[] = [];
    const driver = baseDriver({
      submit: (text, opts) => {
        seen.push({ text, images: opts?.images });
        return "started";
      },
    });
    const server = await createUiServer({ driver });
    servers.push(server);
    const res = await opRoundTrip(server.port, server.token, {
      op: "submit",
      text: "look",
      images: [{ kind: "image", ref: { attachmentId: "att-0", mediaType: "image/png", byteLength: 3 } }],
    });
    expect(res.err).toBeUndefined();
    expect(res.ok).toBe("started");
    expect(seen[0]?.images).toEqual([{ kind: "image", ref: { attachmentId: "att-0", mediaType: "image/png", byteLength: 3 } }]);
  });

  it("absent images = the pre-M79 submit (no field on the driver opts)", async () => {
    const seen: { images?: readonly unknown[] }[] = [];
    const driver = baseDriver({
      submit: (_text, opts) => {
        seen.push({ images: opts?.images });
        return "started";
      },
    });
    const server = await createUiServer({ driver });
    servers.push(server);
    const res = await opRoundTrip(server.port, server.token, { op: "submit", text: "hi" });
    expect(res.ok).toBe("started");
    expect(seen[0]?.images).toBeUndefined();
  });

  it("junk image shapes refuse before the driver is touched", async () => {
    let called = 0;
    const driver = baseDriver({
      submit: () => {
        called += 1;
        return "started";
      },
    });
    const server = await createUiServer({ driver });
    servers.push(server);
    expect((await opRoundTrip(server.port, server.token, { op: "submit", text: "hi", images: "nope" })).err).toMatch(/images must be an array/);
    expect((await opRoundTrip(server.port, server.token, { op: "submit", text: "hi", images: [{ kind: "video", ref: {} }] })).err).toMatch(/kind:'image'/);
    expect((await opRoundTrip(server.port, server.token, { op: "submit", text: "hi", images: [{ kind: "image", ref: { attachmentId: 5 } }] })).err).toMatch(/kind:'image'/);
    expect(called).toBe(0);
  });
});
