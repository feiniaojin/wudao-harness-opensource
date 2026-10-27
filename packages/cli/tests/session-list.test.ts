// M33 §3: session naming (kebab short name from the first user message, zh+en)
// + the --list-sessions table (id · mtime · messages · first-user-50 · model ·
// name) + ensureSessionName (record-once semantics).
// ω99-54: the v7 consumer face — rows ride store.list()'s three-tier order
// and the table's stat usage is ONE display-only round per row.
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionStore, newSessionId, type SessionEntry } from "@wudao/core";
import {
  deriveSessionName,
  firstUserMessage,
  ensureSessionName,
  collectSessionRows,
  formatSessionTable,
} from "../src/session-list.js";

// Count the stat calls THIS package's source issues (session-list.ts's
// display round). The store's own list() stat behavior is pinned in core
// (tests/omega99-54-session-id-v7.test.ts — zero for the v7 tier), so the
// two pins compose into "one display-only round per row".
const { statPaths } = vi.hoisted(() => ({ statPaths: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      statPaths.push(String(args[0]));
      return actual.stat(...args);
    },
  };
});

describe("deriveSessionName — kebab short name (≤6 words, zh+en)", () => {
  it("lowercases, splits on non-alphanumerics, keeps ≤6 words", () => {
    expect(deriveSessionName("Fix the login bug in auth module please"))
      .toBe("fix-the-login-bug-in-auth");
    expect(deriveSessionName("Hello, world! (again)")).toBe("hello-world-again");
  });
  it("CJK text survives as its own tokens (a Chinese first message is one word)", () => {
    expect(deriveSessionName("帮我修复登录页面的bug")).toBe("帮我修复登录页面的bug");
  });
  it("mixed zh/en splits on the boundary", () => {
    expect(deriveSessionName("修复 login bug")).toBe("修复-login-bug");
  });
  it("dots split like any other separator (2.10.1 → 2-10-1)", () => {
    expect(deriveSessionName("Bump version 2.10.1")).toBe("bump-version-2-10-1");
  });
  it("empty / separator-only input degrades to 'session'", () => {
    expect(deriveSessionName("")).toBe("session");
    expect(deriveSessionName("   ")).toBe("session");
    expect(deriveSessionName("???!!!")).toBe("session");
  });
  it("very long single tokens are capped", () => {
    const name = deriveSessionName("x".repeat(200));
    expect(name.length).toBeLessThanOrEqual(48);
  });
});

describe("firstUserMessage — skips machinery messages and non-message entries", () => {
  it("returns the first real user message", () => {
    const entries: SessionEntry[] = [
      { type: "model_change", model: "m", at: "2026-01-01T00:00:00.000Z" },
      { type: "session_name", name: "n" },
      { role: "user", content: "[system note: injected]" },
      { role: "user", content: "the real first question" },
      { role: "assistant", content: "answer" },
    ];
    expect(firstUserMessage(entries)).toBe("the real first question");
  });
  it("skips compaction markers and the restored board too", () => {
    const entries: SessionEntry[] = [
      { role: "user", content: "[compacted summary] old turns" },
      { role: "user", content: "[todo board 1/2 done](restored)\n☑ a\n☐ b" },
      { role: "user", content: "after compaction" },
    ];
    expect(firstUserMessage(entries)).toBe("after compaction");
  });
  it("undefined when there is no real user message", () => {
    expect(firstUserMessage([{ role: "assistant", content: "hi" }, { type: "model_change", model: "m", at: "t" }])).toBeUndefined();
    expect(firstUserMessage([])).toBeUndefined();
  });
});

describe("ensureSessionName — record once, derive from the first user message", () => {
  async function tmpStore(): Promise<{ dir: string; store: ReturnType<typeof createJsonlSessionStore> }> {
    const dir = await mkdtemp(join(tmpdir(), "wudao-name-"));
    await mkdir(dir, { recursive: true });
    return { dir, store: createJsonlSessionStore(dir) };
  }
  it("derives and appends a session_name entry; a second call returns it without appending", async () => {
    const { dir, store } = await tmpStore();
    try {
      await store.append("s1", { role: "user", content: "Fix the login bug please" });
      const first = await ensureSessionName(store, "s1");
      expect(first).toEqual({ name: "fix-the-login-bug-please", added: true });
      const again = await ensureSessionName(store, "s1");
      expect(again).toEqual({ name: "fix-the-login-bug-please", added: false });
      const names = (await store.loadSessionEntries("s1")).filter((e) => !(("role" in e)));
      expect(names.filter((e) => e.type === "session_name")).toEqual([{ type: "session_name", name: "fix-the-login-bug-please", source: "derived" }]);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  it("no derivable first user message → undefined, nothing appended", async () => {
    const { dir, store } = await tmpStore();
    try {
      expect(await ensureSessionName(store, "s2")).toBeUndefined();
      expect(await store.loadSessionEntries("s2")).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  it("an explicit fallback text is used when the session has no user message yet", async () => {
    const { dir, store } = await tmpStore();
    try {
      expect(await ensureSessionName(store, "s3", "帮我修复登录")).toEqual({ name: "帮我修复登录", added: true });
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("collectSessionRows + formatSessionTable", () => {
  it("rows carry id/mtime/messages/firstUser(≤50)/model/name; the table prints aligned columns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-list-"));
    try {
      const store = createJsonlSessionStore(dir);
      // Session A: named, with model state.
      await store.appendEntry("aaa", { type: "session_name", name: "fix-the-login-bug" });
      await store.appendEntry("aaa", { type: "model_change", model: "deepseek-v4-flash", provider: "deepseek", at: "2026-01-01T00:00:00.000Z" });
      await store.append("aaa", { role: "user", content: "Fix the login bug in the auth module over there please and thanks" });
      await store.append("aaa", { role: "assistant", content: "done" });
      // Session B: plain, no entries.
      await store.append("bbb", { role: "user", content: "hi" });
      await store.append("bbb", { role: "assistant", content: "hello" });
      await store.append("bbb", { role: "user", content: "bye" });
      const T = new Date("2026-08-14T02:07:00Z");
      await utimes(join(dir, "aaa.jsonl"), T, T);
      await utimes(join(dir, "bbb.jsonl"), new Date("2026-08-15T10:00:00Z"), new Date("2026-08-15T10:00:00Z"));

      const rows = await collectSessionRows(dir);
      expect(rows.length).toBe(2);
      const a = rows.find((r) => r.id === "aaa");
      const b = rows.find((r) => r.id === "bbb");
      expect(a?.messages).toBe(2);
      expect(b?.messages).toBe(3);
      expect(a?.model).toBe("deepseek-v4-flash");
      expect(b?.model).toBe("");
      expect(a?.name).toBe("fix-the-login-bug");
      expect(b?.name).toBeUndefined();
      // First user message is collapsed + truncated to the first 50 chars
      // (plus the trailing … cut marker).
      expect(a?.firstUser.length).toBeLessThanOrEqual(51);
      expect(a?.firstUser.startsWith("Fix the login bug")).toBe(true);
      expect(a?.firstUser.endsWith("…")).toBe(true);
      expect(b?.firstUser).toBe("hi");

      const table = formatSessionTable(rows);
      const lines = table.split("\n");
      expect(lines[0]).toContain("id");
      expect(lines[0]).toContain("modified");
      expect(lines[0]).toContain("msg");
      expect(lines[0]).toContain("first user message");
      expect(lines[0]).toContain("model");
      expect(lines[0]).toContain("name");
      const rowA = lines.find((l) => l.startsWith("aaa"));
      const rowB = lines.find((l) => l.startsWith("bbb"));
      expect(rowA).toBeDefined();
      expect(rowB).toBeDefined();
      expect(rowA).toContain("fix-the-login-bug");
      expect(rowA).toContain("deepseek-v4-flash");
      expect(rowA).toMatch(/\b2\b/); // message count
      expect(rowB).not.toContain("deepseek");
      // mtime column shape: YYYY-MM-DD HH:MM
      expect(rowA).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("empty sessions dir → the (no sessions) line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-empty-"));
    try {
      expect(formatSessionTable(await collectSessionRows(dir))).toContain("(no sessions)");
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("collectSessionRows — ω99-54 v7 face (order + single display stat round)", () => {
  const T = (ms: number): Date => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, ms));

  it("pure v7 dir: rows in id-ascending (creation) order; ONE display stat per row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-v7rows-"));
    try {
      // Three consecutive factory ids (same or adjacent ms — either way
      // ascending), mtimes deliberately scrambled: order must not care.
      const ids = [newSessionId(), newSessionId(), newSessionId()];
      await writeFile(join(dir, `${ids[0]}.jsonl`), '{"role":"user","content":"c"}\n', "utf8");
      await writeFile(join(dir, `${ids[1]}.jsonl`), '{"role":"user","content":"b"}\n', "utf8");
      await writeFile(join(dir, `${ids[2]}.jsonl`), '{"role":"user","content":"a"}\n', "utf8");
      await utimes(join(dir, `${ids[0]}.jsonl`), T(3000), T(3000));
      await utimes(join(dir, `${ids[1]}.jsonl`), T(1000), T(1000));
      await utimes(join(dir, `${ids[2]}.jsonl`), T(2000), T(2000));
      statPaths.length = 0;
      const rows = await collectSessionRows(dir);
      expect(rows.map((r) => r.id)).toEqual([...ids].sort());
      // The one round that remains is the DISPLAY field's own stat —
      // session-list never stats for ordering (the store's v7 tier is
      // stat-free; pinned in core).
      const mine = statPaths.filter((p) => p.startsWith(dir));
      expect(mine.length).toBe(3);
      expect(rows.every((r) => r.messages === 1)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("mixed dir: the epoch boundary shows in the table — legacy first, then v7 ascending", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-v7mix-"));
    try {
      const store = createJsonlSessionStore(dir);
      await store.append("legacy9", { role: "user", content: "old one" });
      await utimes(join(dir, "legacy9.jsonl"), T(1000), T(1000));
      const ids = [newSessionId(), newSessionId()];
      await writeFile(join(dir, `${ids[0]}.jsonl`), '{"role":"user","content":"v1"}\n', "utf8");
      await writeFile(join(dir, `${ids[1]}.jsonl`), '{"role":"user","content":"v2"}\n', "utf8");
      // Even with the legacy file touched LATER than both v7 files, the
      // epoch law keeps it in the legacy tier (core pins the store side;
      // this pins that the table shows the store's order untouched).
      await utimes(join(dir, `${ids[0]}.jsonl`), T(5000), T(5000));
      await utimes(join(dir, `${ids[1]}.jsonl`), T(6000), T(6000));
      await utimes(join(dir, "legacy9.jsonl"), T(9000), T(9000));
      const rows = await collectSessionRows(dir);
      expect(rows.map((r) => r.id)).toEqual(["legacy9", ...[...ids].sort()]);
      expect(formatSessionTable(rows).split("\n")[1].startsWith("legacy9")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
