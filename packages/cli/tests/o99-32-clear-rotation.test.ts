// ω99-32 T1 — REPL /clear rotates the session identity (driver M80 parity).
// ω99-29 made the REPL's main conversation durable, which exposed /clear as a
// memory-only promise: the id never rotated, so post-clear turns appended to
// the PRE-clear JSONL and a resume dragged the whole old history back ("clear"
// failed at the persistence layer). The driver path has carried the answer
// since M80 (routed /clear = wipe + fresh-segment id + one clear_boundary on
// the old id's tail). These cases pin the REPL joining that ONE
// persistence-layer contract:
//   ① run → /clear → run: the old id's file ends with exactly one
//      clear_boundary (nextSessionId = the fresh segment) and the new id's
//      file carries ONLY the post-clear conversation;
//   ② resume the old id → round one only (the boundary adds a seal, it never
//      rewrites or leaks history — the pre-clear bytes stay as they were);
//   ③ resume the new id → round two only;
//   ④ a post-clear /compact's frozen summary lands on the NEW id (every
//      persistence seam — user turn, barrier, tail, compacted summaries —
//      reads the rotated box, not the boot id).
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runRepl } from "../src/repl.js";
import {
  createJsonlSessionStore,
  repairOrphanedToolCalls,
  applySummaryMarkers,
  resumeChain,
  activeBranchLeafKey,
  SUMMARY_MARKER,
  type AgentMessage,
} from "@wudao/core";
import type { ProviderConfig } from "@wudao/providers";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  await delay();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`o99-32: timed out waiting for ${what}`);
    await delay(10);
  }
}

const enc = new TextEncoder();
const sse = (frames: readonly unknown[]): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({
  start(c) {
    for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
    c.enqueue(enc.encode("data: [DONE]\n\n"));
    c.close();
  },
});

const answer = (text: string): readonly unknown[] => [
  { id: "a", choices: [{ index: 0, delta: { content: text } }] },
  { id: "a", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } },
];

/** The o99-29 REPL driver: feeds `lines` one prompt at a time (the pump only
 * advances on a fresh "wudao> "), returns everything the REPL printed. The
 * workspace outlives the helper — callers read the JSONL before removing it. */
async function driveRepl(o: {
  readonly ws: string;
  readonly sid: string;
  readonly lines: readonly string[];
  readonly script: readonly (readonly unknown[])[];
  readonly contextWindowTokens?: number;
}): Promise<string> {
  const globalHome = await mkdtemp(join(tmpdir(), "o9932-gh-"));
  const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
  const prevFetch = globalThis.fetch;
  const prevArgv = process.argv;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  process.argv = [prevArgv[0]!, "wudao", "--auto"];
  let calls = 0;
  globalThis.fetch = (async () => {
    const frames = o.script[calls] ?? answer("ok");
    calls += 1;
    return new Response(sse(frames), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  let seen = "";
  let fed = 0;
  const drain = (): string => { let t = ""; let c = stdout.read(); while (c !== null) { t += c.toString(); c = stdout.read(); } return t; };
  const pump = (): void => {
    seen += drain();
    const prompts = seen.split("wudao> ").length - 1;
    while (fed < o.lines.length && fed < prompts) { stdin.write(`${o.lines[fed]}\n`); fed += 1; }
  };
  let replError: unknown;
  let done: Promise<void> | undefined;
  try {
    done = runRepl({
      config: { apiKey: "sk-o9932", baseURL: "https://o9932.invalid/v1", model: "o9932-model" } satisfies ProviderConfig,
      workspaceRoot: o.ws,
      buildTools: () => [],
      contextWindowTokens: o.contextWindowTokens ?? 200_000,
      sessionId: o.sid,
      stdin,
      stdout,
    });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) { pump(); if (fed >= o.lines.length) break; await delay(10); }
    await Promise.race([done!, delay(5_000)]);
  } catch (err) {
    replError = err;
  } finally {
    stdin.end();
    if (done !== undefined) await Promise.race([done.then(() => {}, () => {}), delay(500)]);
    process.argv = prevArgv;
    process.env.WUDAO_GLOBAL_HOME = prevGlobal;
    globalThis.fetch = prevFetch;
    await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  if (replError !== undefined) throw replError;
  return seen;
}

// The session readers: raw entries (messages + generic entries like the
// boundary), the message projection, and resolveSession's exact resume
// composition (o99-29 ⑥'s loadHistory — entries → messages → chain-aware
// summary projection → orphan repair).
type RawEntry = AgentMessage | { readonly type: string; readonly data: Record<string, unknown> };

async function readEntries(ws: string, sid: string): Promise<readonly RawEntry[]> {
  const store = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
  return (await store.loadSessionEntries(sid)) as readonly RawEntry[];
}

async function readMessages(ws: string, sid: string): Promise<AgentMessage[]> {
  const entries = await readEntries(ws, sid);
  return entries.filter((e): e is AgentMessage => "role" in e);
}

async function loadHistory(ws: string, sid: string): Promise<AgentMessage[]> {
  const entries = await readEntries(ws, sid);
  const messages = entries.filter((e): e is AgentMessage => "role" in e);
  return repairOrphanedToolCalls(applySummaryMarkers(resumeChain(messages, activeBranchLeafKey(entries)), { chain: true }));
}

const isClearBoundary = (e: RawEntry): boolean => !("role" in e) && e.type === "clear_boundary";

function boundaryOf(entries: readonly RawEntry[]): { readonly nextSessionId: string; readonly at: string } | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e !== undefined && isClearBoundary(e)) {
      const d = (e as { readonly data: { nextSessionId?: unknown; at?: unknown } }).data;
      return typeof d.nextSessionId === "string"
        ? { nextSessionId: d.nextSessionId, at: typeof d.at === "string" ? d.at : "" }
        : undefined;
    }
  }
  return undefined;
}

describe("ω99-32 T1 — REPL /clear rotates the session identity", () => {
  it("① the old id is sealed by one clear_boundary; the conversation continues on a fresh id", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "o9932-rot-")));
    const SID = "wudao-o9932rot";
    try {
      const seen = await driveRepl({
        ws,
        sid: SID,
        lines: ["first round", "/clear", "second round", "/exit"],
        script: [answer("first done"), answer("second done")],
      });
      expect(seen).toContain("(历史已清空)"); // ω99-161: 回执串随源演进（在场语义不变）。
      const oldEntries = await readEntries(ws, SID);
      // RED pre-fix: the id never rotated — no boundary exists and the old
      // file just kept growing with the post-clear turns.
      const boundaries = oldEntries.filter(isClearBoundary);
      expect(boundaries).toHaveLength(1);
      const boundary = boundaryOf(oldEntries);
      expect(boundary).toBeDefined();
      expect(boundary!.nextSessionId).not.toBe(SID);
      expect(boundary!.nextSessionId.length).toBeGreaterThan(0);
      expect(boundary!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // The seal is the file's LAST entry (append-only: the old bytes never
      // move, the boundary lands on the tail).
      expect(isClearBoundary(oldEntries[oldEntries.length - 1]!)).toBe(true);
      // The pre-clear file keeps round one — and only round one.
      const oldMsgs = await readMessages(ws, SID);
      expect(oldMsgs.map((m) => m.content)).toEqual(["first round", "first done"]);
      // The fresh segment carries round two — and nothing from round one,
      // and no boundary of its own.
      const newEntries = await readEntries(ws, boundary!.nextSessionId);
      expect(newEntries.filter(isClearBoundary)).toHaveLength(0);
      const newMsgs = newEntries.filter((e): e is AgentMessage => "role" in e);
      expect(newMsgs.map((m) => m.content)).toEqual(["second round", "second done"]);
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);

  it("② resume the OLD id → round one only (the seal adds, it never leaks or rewrites)", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "o9932-res-old-")));
    const SID = "wudao-o9932resold";
    try {
      await driveRepl({
        ws,
        sid: SID,
        lines: ["first round", "/clear", "second round", "/exit"],
        script: [answer("first done"), answer("second done")],
      });
      // RED pre-fix: the resume reaches BOTH rounds — the clear never
      // reached the persistence layer.
      const texts = (await loadHistory(ws, SID)).map((m) => m.content);
      expect(texts).toContain("first round");
      expect(texts).toContain("first done");
      expect(texts).not.toContain("second round");
      expect(texts).not.toContain("second done");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);

  it("③ resume the NEW id → round two only", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "o9932-res-new-")));
    const SID = "wudao-o9932resnew";
    try {
      await driveRepl({
        ws,
        sid: SID,
        lines: ["first round", "/clear", "second round", "/exit"],
        script: [answer("first done"), answer("second done")],
      });
      const boundary = boundaryOf(await readEntries(ws, SID));
      // RED pre-fix: no boundary exists (the id never rotated), so there is
      // no fresh segment to resume.
      expect(boundary).toBeDefined();
      const texts = (await loadHistory(ws, boundary!.nextSessionId)).map((m) => m.content);
      expect(texts).toEqual(["second round", "second done"]);
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);

  it("④ a post-clear /compact persists its frozen summary on the NEW id (every seam reads the rotated box)", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "o9932-cmp-")));
    const SID = "wudao-o9932cmp";
    try {
      // Five post-clear Q/A turns give the manual tier-2 a digestible span
      // (keepRecent 6 → the first pairs compact, o99-29 ⑤b's shape).
      await driveRepl({
        ws,
        sid: SID,
        lines: ["first round", "/clear", "q1", "q2", "q3", "q4", "q5", "/compact", "/exit"],
        script: [answer("first done"), answer("a1"), answer("a2"), answer("a3"), answer("a4"), answer("a5")],
      });
      const boundary = boundaryOf(await readEntries(ws, SID));
      expect(boundary).toBeDefined();
      // RED pre-fix: the summary lands on the OLD id (persistSid still reads
      // the boot id) — the new id never sees a marker.
      await until(async () => {
        const msgs = await readMessages(ws, boundary!.nextSessionId);
        return msgs.some((m) => m.role === "user" && m.content.startsWith(SUMMARY_MARKER));
      }, "the post-clear summary marker on the NEW id", 8_000);
      const oldMsgs = await readMessages(ws, SID);
      expect(oldMsgs.some((m) => m.role === "user" && m.content.startsWith(SUMMARY_MARKER))).toBe(false);
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);
});
