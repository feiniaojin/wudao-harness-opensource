// ω99-52 — the storage conformance suite (brief:
// .superpowers/sdd/2026-09-01-newref/omega99-52-storage-conformance-brief.md).
// The session-store CONTRACT made executable: any SessionStore implementation
// runs the same cases (round-trips, entry views, sidechains, list, leases,
// torn-tail healing) and is a backend only if they all pass. Shape learned
// from the upstream projectC5's forBackend suites; the contract is wudao's own — the upstream project's durable
// lanes/operations/values semantics are deliberately NOT ported.
//
// Capabilities: a backend declares what it can express; faces it cannot are
// skipped with a visible annotation (ctx.skip), never silently dropped:
//   byteFace  — real bytes on a filesystem: torn tails, byte prefixes, and
//               hand-written foreign-format files are expressible.
//   leaseFace — sessions live under a filesystem root the cross-process
//               run-lease protocol applies to (sessionsRoot required).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "../../src/types.js";
import type { SessionStore, SessionEntry } from "../../src/session/store.js";
import { analyzeTornTail } from "../../src/session/store.js";
import { isValidAgentMessage, isValidSessionEntry } from "../../src/session/validate.js";
import { UnsupportedSessionFormatException } from "../../src/session/format-version.js";
import { acquireSessionLease } from "../../src/session/lease.js";

export interface StorageBackendCapabilities {
  readonly byteFace: boolean;
  readonly leaseFace: boolean;
  /** Required iff byteFace or leaseFace: the backend's sessions root, where
   *  `<id>.jsonl` / `side-<id>.jsonl` / `.leases/` live. */
  readonly sessionsRoot?: string;
}

export interface StorageBackendHandle {
  readonly store: SessionStore;
  readonly cleanup: () => Promise<void>;
  readonly capabilities?: Partial<StorageBackendCapabilities>;
}

/** The parameterized suite: `forBackend(name, factory)` registers the same
 *  describe tree for every backend; the factory hands a FRESH handle per
 *  test (beforeEach) and cleanup runs afterEach. */
export function forBackend(
  name: string,
  factory: () => Promise<StorageBackendHandle> | StorageBackendHandle,
): void {
  describe(`SessionStore conformance — ${name}`, () => {
    let store: SessionStore;
    let cleanup: () => Promise<void>;
    let caps: StorageBackendCapabilities;
    beforeEach(async () => {
      const handle = await factory();
      store = handle.store;
      cleanup = handle.cleanup;
      caps = { byteFace: false, leaseFace: false, ...handle.capabilities };
    });
    afterEach(async () => {
      await cleanup();
    });

    const USER = { role: "user" as const, content: "hi" };
    const ASSISTANT = { role: "assistant" as const, content: "hello" };
    const TOOL = { role: "tool" as const, toolCallId: "t1", name: "read_file", content: "body" };

    // -------------------------------------------------------------------------
    // Face 1/6: load/append — the message round-trip every backend must hold.
    // -------------------------------------------------------------------------
    describe("face: load/append — message round-trip", () => {
      it("append → load returns the messages in order (user/assistant/tool)", async () => {
        await store.append("s", USER);
        await store.append("s", { ...ASSISTANT, toolCalls: [{ id: "t1", name: "read_file", arguments: { path: "/x" } }] });
        await store.append("s", TOOL);
        expect(await store.load("s")).toEqual([
          USER,
          { ...ASSISTANT, toolCalls: [{ id: "t1", name: "read_file", arguments: { path: "/x" } }] },
          TOOL,
        ]);
      });
      it("load of a missing session → [] (no throw)", async () => {
        expect(await store.load("never-written")).toEqual([]);
        expect(await store.loadSidechain("never-written")).toEqual([]);
      });
      it("rejects an invalid session id on load and append (same law every backend)", async () => {
        await expect(store.append("../evil", USER)).rejects.toThrow(/invalid session id/);
        await expect(store.load("../evil")).rejects.toThrow(/invalid session id/);
      });
      it("concurrent appends land strictly in issue order (serialized writes)", async () => {
        await Promise.all(
          Array.from({ length: 8 }, (_, i) => store.append("cc", { role: "user", content: `m${i}` })),
        );
        expect((await store.load("cc")).map((m) => m.content)).toEqual([
          "m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7",
        ]);
      });
    });

    // -------------------------------------------------------------------------
    // Face 2/6: appendEntry + entry views — M35 generic entries, ω99-43
    // receipts riding them, ω99-47 marker/skip observability.
    // -------------------------------------------------------------------------
    describe("face: appendEntry + entry views (M35/ω99-43/ω99-47)", () => {
      it("typed + generic entries round-trip via loadSessionEntries; load() stays messages-only", async () => {
        await store.append("e", USER);
        await store.appendEntry("e", { type: "model_change", model: "glm-4.6", provider: "glm", at: "2026-09-05T00:00:00.000Z" });
        await store.appendEntry("e", { type: "deferred_loaded", data: { n: 1 } });
        await store.append("e", ASSISTANT);
        expect(await store.load("e")).toEqual([USER, ASSISTANT]);
        const entries = await store.loadSessionEntries("e");
        expect(entries).toHaveLength(4);
        expect(entries[0]).toEqual(USER);
        expect((entries[1] as { type: string }).type).toBe("model_change");
        expect((entries[2] as { type: string }).type).toBe("deferred_loaded");
        expect(entries[3]).toEqual(ASSISTANT);
      });
      it("KNOWN non-message entries are an intentional filter, not skips (lastLoadSkipped === 0)", async () => {
        await store.append("k", USER);
        await store.appendEntry("k", { type: "session_name", name: "n", source: "manual" });
        await store.appendEntry("k", { type: "provider_change", provider: "glm", model: "m", at: "2026-09-05T00:00:00.000Z" });
        await store.append("k", ASSISTANT);
        expect(await store.load("k")).toEqual([USER, ASSISTANT]);
        expect(store.lastLoadSkipped).toBe(0);
        expect(await store.loadSessionEntries("k")).toHaveLength(4);
        expect(store.lastLoadSkipped).toBe(0);
      });
      it("unknown junk entries are skipped AND counted in both views; the counter resets per load", async () => {
        await store.appendEntry("j", { type: "future_thing", payload: 1 } as unknown as SessionEntry);
        await store.append("j", USER);
        expect(await store.load("j")).toEqual([USER]);
        expect(store.lastLoadSkipped).toBe(1);
        expect(await store.loadSessionEntries("j")).toEqual([USER]);
        expect(store.lastLoadSkipped).toBe(1);
        await store.load("missing-file");
        expect(store.lastLoadSkipped).toBe(0);
      });
      it("the ω99-47 format marker never appears in any entry view (transport framing, not data)", async () => {
        await store.append("mk", USER);
        await store.appendEntry("mk", { type: "session_name", name: "n" });
        await store.appendSidechainEntry("mkside", { type: "approval-receipt", data: { tool: "shell" } });
        const main = await store.loadSessionEntries("mk");
        const side = await store.loadSidechainEntries("mkside");
        expect(main.filter((e) => (e as { type?: string }).type === "wudao_meta")).toEqual([]);
        expect(side.filter((e) => (e as { type?: string }).type === "wudao_meta")).toEqual([]);
        expect(main).toHaveLength(2);
        expect(side).toHaveLength(1);
      });
      it("appended messages are entries too — appendEntry accepts them (M35 §2)", async () => {
        await store.appendEntry("am", USER);
        expect(await store.load("am")).toEqual([USER]);
        expect(await store.loadSessionEntries("am")).toEqual([USER]);
      });
      it("ω99-80 appendEntries: one call lands N entries exactly as N calls; an empty batch creates nothing", async () => {
        const rows: SessionEntry[] = [
          USER,
          { type: "model_change", model: "glm-4.6", provider: "glm", at: "2026-09-05T00:00:00.000Z" },
          { type: "deferred_loaded", data: { n: 7 } },
          ASSISTANT,
        ];
        await store.appendEntries("batch", rows);
        for (const r of rows) await store.appendEntry("one-by-one", r);
        expect(await store.loadSessionEntries("batch")).toEqual(await store.loadSessionEntries("one-by-one"));
        expect(await store.load("batch")).toEqual([USER, ASSISTANT]); // message view filters the same
        await store.appendEntries("batch", [TOOL]); // continues after per-entry appends, in order
        expect(await store.load("batch")).toEqual([USER, ASSISTANT, TOOL]);
        // zero-call observable: an empty batch writes nothing, creates nothing
        await store.appendEntries("ghost", []);
        expect(await store.list()).not.toContain("ghost");
        expect(await store.loadSessionEntries("ghost")).toEqual([]);
        // same id guards as the singular write face (fail closed)
        await expect(store.appendEntries("side-top", [USER])).rejects.toThrow(/reserved/);
        await expect(store.appendEntries("../evil", [USER])).rejects.toThrow(/invalid session id/);
      });
      it("reserves the side- prefix for sidechains on top-level writes (fail-closed)", async () => {
        await expect(store.appendEntry("side-top", USER)).rejects.toThrow(/reserved/);
        await expect(store.append("side-top", USER)).rejects.toThrow(/reserved/);
      });
      it("[byteFace] a v99 file reads unchanged and refuses writes with the typed error", async (ctx) => {
        if (!caps.byteFace) ctx.skip();
        const root = caps.sessionsRoot ?? "";
        const v99Text =
          '{"type":"wudao_meta","data":{"formatVersion":99}}\n'
          + `${JSON.stringify(USER)}\n${JSON.stringify(ASSISTANT)}\n`;
        await writeFile(join(root, "v99.jsonl"), v99Text, "utf8");
        expect(await store.load("v99")).toEqual([USER, ASSISTANT]);
        expect(await store.loadSessionEntries("v99")).toEqual([USER, ASSISTANT]);
        const err = await store.append("v99", USER).then(() => undefined, (e: unknown) => e);
        expect(err).toBeInstanceOf(UnsupportedSessionFormatException);
        expect((err as UnsupportedSessionFormatException).fileVersion).toBe(99);
        expect(await readFile(join(root, "v99.jsonl"), "utf8")).toBe(v99Text);
        // the sidechain twin: `side-v99.jsonl` is its own file, same law
        await writeFile(
          join(root, "side-v99.jsonl"),
          `{"type":"wudao_meta","data":{"formatVersion":99}}\n${JSON.stringify(USER)}\n`,
          "utf8",
        );
        await expect(store.appendSidechain("v99", USER)).rejects.toBeInstanceOf(UnsupportedSessionFormatException);
        await expect(store.appendSidechainEntry("v99", USER)).rejects.toBeInstanceOf(UnsupportedSessionFormatException);
        expect(await store.loadSidechain("v99")).toEqual([USER]);
      });
    });

    // -------------------------------------------------------------------------
    // Face 3/6: sidechains — the double entry points (M30 §C + ω99-43).
    // -------------------------------------------------------------------------
    describe("face: sidechain double entry points (M30 §C + ω99-43)", () => {
      const MESSAGE = { role: "user" as const, content: "child brief" };
      const RECEIPT = { type: "approval-receipt", data: { tool: "shell", inputKey: "shell#abc", decision: { behavior: "allow" }, ts: "2026-09-05T00:00:00.000Z" } };
      it("appendSidechain/appendSidechainEntry round-trip through both views in order", async () => {
        await store.appendSidechain("c1", MESSAGE);
        await store.appendSidechainEntry("c1", RECEIPT);
        await store.appendSidechain("c1", { role: "assistant", content: "answer" });
        const entries = await store.loadSidechainEntries("c1");
        expect(entries).toHaveLength(3);
        expect(entries[0]).toEqual(MESSAGE);
        expect(entries[1]).toEqual(RECEIPT);
        expect(entries[2]).toEqual({ role: "assistant", content: "answer" });
        expect(await store.loadSidechain("c1")).toEqual([MESSAGE, { role: "assistant", content: "answer" }]);
      });
      it("a top-level session and a sidechain may share a bare id (domain separation)", async () => {
        await store.append("main", USER);
        await store.appendSidechain("main", MESSAGE);
        expect(await store.load("main")).toEqual([USER]);
        expect(await store.loadSidechain("main")).toEqual([MESSAGE]);
      });
      it("sidechain skip counting holds the same law as the main chain", async () => {
        await store.appendSidechainEntry("cs", { type: "future_thing", payload: 1 } as unknown as SessionEntry);
        await store.appendSidechain("cs", MESSAGE);
        expect(await store.loadSidechain("cs")).toEqual([MESSAGE]);
        expect(store.lastLoadSkipped).toBe(1);
        expect(await store.loadSidechainEntries("cs")).toEqual([MESSAGE]);
        expect(store.lastLoadSkipped).toBe(1);
      });
      it("rejects an invalid sidechain id", async () => {
        await expect(store.appendSidechain("bad/id", MESSAGE)).rejects.toThrow(/invalid sidechain id/);
        await expect(store.loadSidechain("bad/id")).rejects.toThrow(/invalid sidechain id/);
      });
    });

    // -------------------------------------------------------------------------
    // Face 4/6: list — enumerable sessions, oldest-first, sidechains excluded.
    // -------------------------------------------------------------------------
    describe("face: list — enumeration and recency order", () => {
      it("empty before any session; ids appear in first-write order", async () => {
        expect(await store.list()).toEqual([]);
        await store.append("a", USER);
        await new Promise((r) => setTimeout(r, 15)); // mtime granularity on fs backends
        await store.append("b", USER);
        expect(await store.list()).toEqual(["a", "b"]);
      });
      it("touching an older session makes it the most recent (last-write order)", async () => {
        await store.append("older", USER);
        await new Promise((r) => setTimeout(r, 15));
        await store.append("newer", USER);
        await new Promise((r) => setTimeout(r, 15));
        await store.append("older", ASSISTANT);
        expect(await store.list()).toEqual(["newer", "older"]);
      });
      it("sidechains never appear in list()", async () => {
        await store.append("top", USER);
        await store.appendSidechain("kid", { role: "user", content: "child" });
        expect(await store.list()).toEqual(["top"]);
      });
    });

    // -------------------------------------------------------------------------
    // Face 5/6: run lease — one live writer process per session [leaseFace].
    // The lease is a sessions-ROOT protocol (not a SessionStore method), so
    // this face runs only for backends whose sessions live on a filesystem.
    // -------------------------------------------------------------------------
    describe("face: run lease — one live writer per session [leaseFace]", () => {
      it("acquire ok; same-process re-acquire idempotent; release frees the id", async (ctx) => {
        if (!caps.leaseFace) ctx.skip();
        const root = caps.sessionsRoot ?? "";
        const a1 = await acquireSessionLease(root, "lease-a");
        expect(a1.ok).toBe(true);
        const a2 = await acquireSessionLease(root, "lease-a");
        expect(a2.ok).toBe(true);
        if (a1.ok) await a1.lease.release();
        const a3 = await acquireSessionLease(root, "lease-a");
        expect(a3.ok).toBe(true);
        if (a3.ok) await a3.lease.release();
      });
      it("a live foreign holder refuses with its identity (fail-safe, no self-steal)", async (ctx) => {
        if (!caps.leaseFace) ctx.skip();
        const root = caps.sessionsRoot ?? "";
        await mkdir(join(root, ".leases"), { recursive: true });
        await writeFile(
          join(root, ".leases", "lease-b.json"),
          JSON.stringify({ pid: process.pid, at: "2026-09-05T00:00:00.000Z", gen: "foreign-gen" }),
          "utf8",
        );
        const r = await acquireSessionLease(root, "lease-b");
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.holder.pid).toBe(process.pid);
      });
      it("a dead holder's lock is stolen and cleanly released", async (ctx) => {
        if (!caps.leaseFace) ctx.skip();
        const root = caps.sessionsRoot ?? "";
        await mkdir(join(root, ".leases"), { recursive: true });
        // A pid that cannot exist — kill(pid, 0) → ESRCH, i.e. a dead holder.
        await writeFile(
          join(root, ".leases", "lease-c.json"),
          JSON.stringify({ pid: 2147483647, at: "2026-09-05T00:00:00.000Z", gen: "dead-gen" }),
          "utf8",
        );
        const r = await acquireSessionLease(root, "lease-c");
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        await r.lease.release();
        await expect(readFile(join(root, ".leases", "lease-c.json"), "utf8")).rejects.toThrow();
      });
      it("side- ids are never lease targets", async (ctx) => {
        if (!caps.leaseFace) ctx.skip();
        await expect(acquireSessionLease(caps.sessionsRoot ?? "", "side-x")).rejects.toThrow(/reserved/);
      });
      it("lease artifacts do not pollute the store's list()", async (ctx) => {
        if (!caps.leaseFace) ctx.skip();
        const root = caps.sessionsRoot ?? "";
        const a = await acquireSessionLease(root, "lease-e");
        expect(a.ok).toBe(true);
        await store.append("real", USER);
        expect(await store.list()).toEqual(["real"]);
        if (a.ok) await a.lease.release();
      });
    });

    // -------------------------------------------------------------------------
    // Face 6/6: byte-prefix heal property [byteFace] — "any byte prefix of a
    // valid session file loads or heals, and stays writable". A crash can
    // only damage the LAST line, so every prefix is decidable via
    // analyzeTornTail: load returns exactly the readable prefix, the file is
    // rewritten to the verdict's healTo (or left untouched when healthy), and
    // the next append lands without welding lines.
    // -------------------------------------------------------------------------
    describe("face: byte-prefix heal property [byteFace]", () => {
      it("every byte boundary of a fixture (marker/messages/generic entry/torn tail): readable or healed, then writable", async (ctx) => {
        if (!caps.byteFace) ctx.skip();
        const root = caps.sessionsRoot ?? "";
        // Record a valid session through the store's own API, then weld a torn
        // crash fragment onto its tail (raw bytes, no trailing newline).
        await store.append("fx", USER);
        await store.appendEntry("fx", { type: "model_change", model: "glm-4.6", provider: "glm", at: "2026-09-05T00:00:00.000Z" });
        await store.append("fx", ASSISTANT);
        await store.appendEntry("fx", { type: "deferred_loaded", data: { n: 1 } });
        await store.append("fx", TOOL);
        const bytes = (await readFile(join(root, "fx.jsonl"), "utf8")) + '{"role":"user","content":"tor';
        const POST = { role: "user" as const, content: "after-heal" };
        // The decider: what a tolerant reader must see in `text`, and how many
        // lines it must count as skipped (unparseable or unrecognized).
        const messagesOf = (text: string): AgentMessage[] => {
          const out: AgentMessage[] = [];
          for (const line of text.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed: unknown = JSON.parse(trimmed);
              if (isValidAgentMessage(parsed)) out.push(parsed);
            } catch {
              // torn/corrupt line — not a message
            }
          }
          return out;
        };
        const skippedOf = (text: string): number => {
          let n = 0;
          for (const line of text.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed: unknown = JSON.parse(trimmed);
              if (!isValidAgentMessage(parsed) && !isValidSessionEntry(parsed)) n += 1;
            } catch {
              n += 1;
            }
          }
          return n;
        };
        let healDrops = 0; // prefixes healed by DROPPING a torn fragment
        let healNewlines = 0; // prefixes healed by RESTORING a lost "\n"
        for (let len = 0; len <= bytes.length; len += 1) {
          const id = `p${len}`;
          const prefix = bytes.slice(0, len);
          await writeFile(join(root, `${id}.jsonl`), prefix, "utf8");
          const expectMsgs = messagesOf(prefix);
          expect(await store.load(id), `prefix ${len}: load returns the readable message prefix`).toEqual(expectMsgs);
          expect(store.lastLoadSkipped, `prefix ${len}: skip counter counts torn/unknown lines`).toBe(skippedOf(prefix));
          const verdict = analyzeTornTail(prefix);
          const after = await readFile(join(root, `${id}.jsonl`), "utf8");
          if (verdict === undefined) {
            expect(after, `prefix ${len}: healthy prefix is left untouched`).toBe(prefix);
          } else {
            expect(after, `prefix ${len}: healed to the verdict's healTo`).toBe(verdict.healTo);
            expect(verdict.healTo === "" || verdict.healTo.endsWith("\n"), `prefix ${len}: healTo never welds`).toBe(true);
            if (verdict.healTo.length < prefix.length) healDrops += 1;
            else healNewlines += 1;
          }
          await store.append(id, POST);
          expect(await store.load(id), `prefix ${len}: writable after heal`).toEqual([...expectMsgs, POST]);
          const finalText = await readFile(join(root, `${id}.jsonl`), "utf8");
          expect(finalText.endsWith("\n"), `prefix ${len}: final file newline-terminated`).toBe(true);
          for (const line of finalText.split("\n")) {
            if (line.trim() === "") continue;
            expect(() => JSON.parse(line), `prefix ${len}: no welded lines after append`).not.toThrow();
          }
        }
        expect(bytes.length).toBeLessThanOrEqual(2048); // the ≤2KB fixture contract
        expect(healDrops, "at least one prefix took the fragment-drop heal path").toBeGreaterThan(0);
        expect(healNewlines, "at least one prefix took the newline-repair heal path").toBeGreaterThan(0);
      // ~2k 前缀 × 每 prefix 六次 fs 系统调用：单跑 ~1.2s，全量门并行负载下
      // 实测可超缺省 5s（gate-r2 复盘）——属性面的合法慢测试，显式给宽
      // （run-script-python 同款 20s 钉法），掩不住真挂死：超时仍会红。
      }, 20_000);
    });
  });
}
