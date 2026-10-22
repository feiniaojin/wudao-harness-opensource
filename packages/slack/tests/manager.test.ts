// M60 — the channel session manager with a fake channel + fake drivers:
// dual-allowlist silent drop, mention gating, mapping persistence/reuse,
// busy→steering vs idle→prompt, summary post-back (mrkdown + 查看会话),
// key-notice relay (errors/compaction only, never per-tool), /slack
// commands, thread-context truncation, interactive-tool refusal wiring.
import { describe, expect, it } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createChannelSessionManager, allowlistsPass } from "../src/manager.js";
import { loadThreadMap } from "../src/threads.js";
import { DEFAULT_SLACK_SETTINGS, type SlackSettings } from "../src/settings.js";
import type { InboundChannel, InboundChannelHandlers, InboundCommand, InboundMessage, InboundTarget, AskPrompt, AskResolution } from "../src/channel.js";
import { parseInboundCommand } from "../src/channel.js";

// -- fakes -------------------------------------------------------------------

interface FakeDriverOpts {
  readonly sessionId: string;
  /** Busy true from creation (an in-flight run). */
  readonly startBusy?: boolean;
}

function fakeDriver(opts: FakeDriverOpts) {
  const created: { submitted: string[]; steered: string[]; metaNotes: string[]; resumed: string[] } = {
    submitted: [],
    steered: [],
    metaNotes: [],
    resumed: [],
  };
  let busy = opts.startBusy === true;
  const history: { kind: string; text?: string }[] = [];
  const statusSubs = new Set<() => void>();
  const historySubs = new Set<(e: unknown[], reset: boolean) => void>();
  const driver = {
    submit(text: string): string {
      if (busy) {
        created.steered.push(text);
        return "steered";
      }
      created.submitted.push(text);
      history.push({ kind: "user", text });
      return "started";
    },
    interrupt() {},
    getStatus() {
      return { busy, queued: created.steered, sessionId: opts.sessionId };
    },
    getHistory: () => history,
    subscribe(cb: () => void) {
      statusSubs.add(cb);
      return () => statusSubs.delete(cb);
    },
    onHistory(cb: (e: unknown[], reset: boolean) => void) {
      historySubs.add(cb);
      return () => historySubs.delete(cb);
    },
    notify() {},
    pushMetaNote(text: string) {
      created.metaNotes.push(text);
    },
    async resume(id: string) {
      created.resumed.push(id);
      return true;
    },
    dispose() {},
    // test control surface
    __setBusy(next: boolean) {
      busy = next;
      for (const cb of [...statusSubs]) cb();
    },
    __append(entry: { kind: string; text?: string }) {
      history.push(entry);
      for (const cb of [...historySubs]) cb([entry], false);
    },
    __created: created,
  };
  return driver;
}

type FakeDriver = ReturnType<typeof fakeDriver>;

function fakeChannel() {
  const replies: { target: InboundTarget; text: string; sessionId?: string }[] = [];
  const state = { handlers: null as InboundChannelHandlers | null, threadDigest: "" };
  const channel: InboundChannel = {
    name: "fake",
    async start(h) {
      state.handlers = h;
    },
    async stop() {},
    async reply(target, text, rOpts) {
      replies.push({ target, text, ...(rOpts?.sessionId !== undefined ? { sessionId: rOpts.sessionId } : {}) });
    },
    async relayAsk(): Promise<AskResolution> {
      return "deny";
    },
    async threadContext() {
      return state.threadDigest;
    },
  };
  const send = async (m: InboundMessage): Promise<void> => {
    // Same routing the real Slack channel does: /slack … text goes to
    // onCommand, everything else to onMessage.
    const cmd = parseInboundCommand(m.text);
    if (cmd !== null) {
      await state.handlers?.onCommand({ ...cmd, message: m });
      return;
    }
    await state.handlers?.onMessage(m);
  };
  const command = async (name: string, m?: Partial<InboundMessage>): Promise<void> => {
    const msg: InboundMessage = m ?? { userId: "U1", channel: "C1", ts: "100.000", text: "", mentioned: true };
    const cmd: InboundCommand = { name, args: [], message: msg };
    await state.handlers?.onCommand(cmd);
  };
  return { channel, replies, send, command, state };
}

function msg(over: Partial<InboundMessage>): InboundMessage {
  return { userId: "U1", channel: "C1", ts: "100.000", text: "hello", mentioned: true, ...over };
}

async function setup(over?: {
  settings?: Partial<SlackSettings>;
  drivers?: FakeDriver[];
  digest?: string;
}) {
  const root = mkdtempSync(join(tmpdir(), "wudao-slack-manager-"));
  await mkdir(join(root, ".wudao"), { recursive: true });
  const map = await loadThreadMap(root);
  const settings: SlackSettings = {
    ...DEFAULT_SLACK_SETTINGS,
    allowedUsers: ["U1"],
    allowedChannels: ["C1"],
    ...over?.settings,
  };
  const fc = fakeChannel();
  if (over?.digest !== undefined) fc.state.threadDigest = over.digest;
  const drivers = over?.drivers ?? [];
  let n = 0;
  const logs: string[] = [];
  const manager = createChannelSessionManager({
    settings,
    channel: fc.channel,
    threadMap: map,
    log: (l) => logs.push(l),
    createSession: async () => {
      const d = drivers[n] ?? fakeDriver({ sessionId: `sess-${n}` });
      n += 1;
      return { driver: d };
    },
  });
  await manager.start();
  return { manager, map, fc, replies: fc.replies, drivers, logs, root };
}

// -- tests -------------------------------------------------------------------

describe("allowlistsPass", () => {
  const s = { allowedUsers: ["U1"], allowedChannels: ["C1", "C2"] };
  it("requires BOTH lists to contain the sender's user AND channel", () => {
    expect(allowlistsPass(s, "U1", "C1")).toBe(true);
    expect(allowlistsPass(s, "U1", "C9")).toBe(false);
    expect(allowlistsPass(s, "U9", "C1")).toBe(false);
  });
  it("an empty list is fail-closed (nobody passes)", () => {
    expect(allowlistsPass({ allowedUsers: [], allowedChannels: ["C1"] }, "U1", "C1")).toBe(false);
    expect(allowlistsPass({ allowedUsers: ["U1"], allowedChannels: [] }, "U1", "C1")).toBe(false);
  });
});

describe("message flow", () => {
  it("a non-allowlisted sender is silently dropped (log only, no reply)", async () => {
    const { fc, replies, logs } = await setup();
    await fc.send(msg({ userId: "U_EVIL" }));
    expect(replies).toEqual([]);
    expect(logs.some((l) => l.includes("dropped") && l.includes("U_EVIL"))).toBe(true);
  });
  it("a non-allowlisted channel is silently dropped even for an allowed user", async () => {
    const { fc, replies, logs } = await setup();
    await fc.send(msg({ channel: "C_SECRET" }));
    expect(replies).toEqual([]);
    expect(logs.some((l) => l.includes("dropped"))).toBe(true);
  });

  it("an unmapped thread without a mention is ignored; with a mention it creates a session", async () => {
    const d1 = fakeDriver({ sessionId: "s1" });
    const { fc, logs } = await setup({ drivers: [d1] });
    await fc.send(msg({ mentioned: false }));
    expect(d1.__created.submitted).toEqual([]);
    expect(logs.some((l) => l.includes("non-mention"))).toBe(true);
    await fc.send(msg({ mentioned: true, text: "do the thing" }));
    expect(d1.__created.submitted).toEqual(["do the thing"]);
  });

  it("the thread maps to the session and persists; a follow-up reuses it (no mention needed)", async () => {
    const d1 = fakeDriver({ sessionId: "s1" });
    const { fc, map } = await setup({ drivers: [d1] });
    await fc.send(msg({ ts: "100.000", text: "first" }));
    expect(map.get("C1:100.000")).toBe("s1");
    await fc.send(msg({ threadTs: "100.000", ts: "101.000", text: "follow-up", mentioned: false }));
    expect(d1.__created.submitted).toEqual(["first", "follow-up"]);
    expect(map.size()).toBe(1);
  });

  it("idle → the text submits as a prompt; busy → it steers (with the ⏳ reply)", async () => {
    const d1 = fakeDriver({ sessionId: "s1", startBusy: true });
    const { fc, replies } = await setup({ drivers: [d1] });
    await fc.send(msg({ ts: "100.000", text: "start" }));
    expect(d1.__created.steered).toEqual(["start"]);
    expect(replies.some((r) => r.text.includes("steering"))).toBe(true);
    expect(d1.__created.submitted).toEqual([]);
    d1.__setBusy(false);
    d1.__setBusy(true);
    await fc.send(msg({ threadTs: "100.000", ts: "102.000", text: "and also" }));
    expect(d1.__created.steered).toEqual(["start", "and also"]);
  });

  it("a resumed binding adopts the mapped session id and calls resume on it", async () => {
    const root = mkdtempSync(join(tmpdir(), "wudao-slack-manager-resume-"));
    await mkdir(join(root, ".wudao"), { recursive: true });
    const map = await loadThreadMap(root);
    await map.set("C1:100.000", "s-old");
    const fc = fakeChannel();
    let createdDriver: FakeDriver | null = null;
    const manager = createChannelSessionManager({
      settings: { ...DEFAULT_SLACK_SETTINGS, allowedUsers: ["U1"], allowedChannels: ["C1"] },
      channel: fc.channel,
      threadMap: map,
      createSession: async ({ sessionId }) => {
        const d = fakeDriver({ sessionId: sessionId ?? "s-x" });
        createdDriver = d;
        return { driver: d };
      },
    });
    await manager.start();
    await fc.send(msg({ ts: "100.000", threadTs: "100.000", text: "continue", mentioned: true }));
    expect(createdDriver).not.toBeNull();
    expect((createdDriver as FakeDriver).getStatus().sessionId).toBe("s-old");
    expect((createdDriver as FakeDriver).__created.resumed).toEqual(["s-old"]);
    expect(map.get("C1:100.000")).toBe("s-old");
    await manager.stop();
  });
});

describe("post-back", () => {
  it("run end posts the summary (mrkdown) with the 查看会话 affordance + session id", async () => {
    const d1 = fakeDriver({ sessionId: "s1" });
    const { fc, replies } = await setup({ drivers: [d1] });
    await fc.send(msg({ ts: "100.000", text: "go" }));
    d1.__setBusy(true);
    d1.__append({ kind: "tool", text: "noise" });
    d1.__append({ kind: "assistant", text: "# Done\n**shipped** [link](https://x.y)" });
    d1.__setBusy(false);
    await new Promise((r) => setTimeout(r, 10));
    const summary = replies.find((r) => r.text.includes("shipped"));
    expect(summary).toBeDefined();
    expect(summary?.text).toContain("*Done*"); // header → bold
    expect(summary?.text).toContain("*shipped*"); // ** → *
    expect(summary?.text).toContain("<https://x.y|link>"); // link → mrkdown
    expect(summary?.text).toContain("wudao --resume s1");
    expect(summary?.sessionId).toBe("s1");
  });

  it("0.3.15: the run's 耗时 receipt rides the summary footer (absent on old drivers → unchanged)", async () => {
    const d1 = fakeDriver({ sessionId: "s1" });
    const { fc, replies } = await setup({ drivers: [d1] });
    await fc.send(msg({ ts: "100.000", text: "go" }));
    d1.__setBusy(true);
    d1.__append({ kind: "assistant", text: "answer body" });
    d1.__append({ kind: "notice", text: "耗时 42.3s · 模型 18.1s · 工具 24.2s (5 次)" });
    d1.__setBusy(false);
    await new Promise((r) => setTimeout(r, 10));
    const summary = replies.find((r) => r.text.includes("answer body"));
    expect(summary).toBeDefined();
    // The receipt lands between the rule and the 查看会话 affordance.
    const receiptIdx = summary?.text.indexOf("耗时 42.3s") ?? -1;
    const resumeIdx = summary?.text.indexOf("wudao --resume s1") ?? -1;
    expect(receiptIdx).toBeGreaterThanOrEqual(0);
    expect(receiptIdx).toBeLessThan(resumeIdx);
  });

  it("errors and compaction notices relay; tool entries do NOT", async () => {
    const d1 = fakeDriver({ sessionId: "s1" });
    const { fc, replies } = await setup({ drivers: [d1] });
    await fc.send(msg({ ts: "100.000", text: "go" }));
    d1.__setBusy(true);
    d1.__append({ kind: "tool", text: "read_file" });
    d1.__append({ kind: "error", text: "model 500" });
    d1.__append({ kind: "notice", text: "♻️ compacted context (cold turn expected)" });
    d1.__append({ kind: "notice", text: "↳ steering applied" });
    await new Promise((r) => setTimeout(r, 10));
    expect(replies.some((r) => r.text.includes("model 500"))).toBe(true);
    expect(replies.some((r) => r.text.includes("compacted context"))).toBe(true);
    expect(replies.some((r) => r.text.includes("read_file"))).toBe(false);
    expect(replies.some((r) => r.text.includes("steering applied"))).toBe(false);
  });
});

describe("/slack commands", () => {
  it("status lists bindings; pause gates; resume reopens", async () => {
    const d1 = fakeDriver({ sessionId: "s1" });
    const { fc, replies, manager } = await setup({ drivers: [d1] });
    await fc.send(msg({ ts: "100.000", text: "/slack status" }));
    expect(replies.some((r) => r.text.includes("running"))).toBe(true);
    await fc.send(msg({ ts: "101.000", text: "/slack pause" }));
    expect(manager.paused()).toBe(true);
    // A paused message gets the one-time notice and never submits.
    await fc.send(msg({ ts: "102.000", text: "hello?", mentioned: true }));
    expect(replies.some((r) => r.text.includes("已暂停"))).toBe(true);
    expect(d1.__created.submitted).toEqual([]);
    await fc.send(msg({ ts: "103.000", text: "/slack resume" }));
    expect(manager.paused()).toBe(false);
    await fc.send(msg({ ts: "104.000", text: "now do it", mentioned: true }));
    expect(d1.__created.submitted).toEqual(["now do it"]);
  });
  it("unknown subcommand → usage", async () => {
    const { fc, replies } = await setup();
    await fc.command("explode");
    expect(replies.some((r) => r.text.includes("未知子命令"))).toBe(true);
  });
});

describe("thread context", () => {
  it("a new session's first model call carries the truncated digest as a MetaNote", async () => {
    const d1 = fakeDriver({ sessionId: "s1" });
    const digest = "z".repeat(9000);
    const { fc } = await setup({ drivers: [d1], digest });
    await fc.send(msg({ ts: "100.000", text: "go" }));
    expect(d1.__created.metaNotes.length).toBe(1);
    const note = d1.__created.metaNotes[0] ?? "";
    expect(note).toContain("slack thread context");
    expect(note).toContain("线程上下文截断");
    expect(note.length).toBeLessThanOrEqual(8000 + 200);
  });
  it("a follow-up on a known thread does NOT re-inject the digest", async () => {
    const d1 = fakeDriver({ sessionId: "s1" });
    const { fc } = await setup({ drivers: [d1], digest: "prior chat" });
    await fc.send(msg({ ts: "100.000", text: "go" }));
    await fc.send(msg({ threadTs: "100.000", ts: "105.000", text: "again" }));
    expect(d1.__created.metaNotes.length).toBe(1);
  });
});
