// 121 §1 续章 — the persistent-notes pair (note_write / note_read): the
// model's PROACTIVE-SAVE surface over long-task knowledge. search_history
// recovers what compaction swallowed from the raw ledger; notes are the
// deliberate save AT THE MOMENT of learning — plain markdown files under
// <workspace>/.wudao/notes/<sessionId>/, append-only, tag-indexed, never
// entering model context by themselves (note_read is the only door). These
// tests pin: the pure naming/parsing/listing helpers, the write/read
// round-trip on a real tmpdir, the tag filter + newest-first order, the
// limit clamp and the honest truncation budget, the append-only collision
// suffix (wx — never an overwrite), and the fail-closed argument gates.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNotesTools,
  noteSlugOf,
  noteTimestampName,
  noteFileName,
  parseNoteFileName,
  noteFileBody,
  parseNoteBody,
  listNotes,
  NOTE_CONTENT_MAX_CHARS,
  NOTES_LIMIT_DEFAULT,
  NOTES_LIMIT_MAX,
  NOTES_READ_TOTAL_MAX_CHARS,
  type NoteRecord,
  type Tool,
} from "../src/index.js";

const note = (over: Partial<NoteRecord> = {}): NoteRecord => ({
  file: "20260926T040506789Z-a.md",
  at: "2026-09-26T04:05:06.789Z",
  content: "content-a",
  ...over,
});

describe("121 §1 — 命名/解析纯函数（文件名=时间戳序）", () => {
  it("noteSlugOf: ASCII kept, others collapse to hyphens, capped, trimmed; CJK falls back to \"note\"", () => {
    expect(noteSlugOf("fix: the auth flow leaks")).toBe("fix-the-auth-flow-leaks");
    expect(noteSlugOf("A  B___C--D")).toBe("A-B___C-D"); // runs of non-ASCII collapse to ONE hyphen
    expect(noteSlugOf("   ")).toBe("note");
    expect(noteSlugOf("纯中文结论没有任何拉丁字符")).toBe("note"); // pure CJK: nothing survives → the fallback
    expect(noteSlugOf("中文结论里的 ASCII 词")).toBe("ASCII"); // mixed: the ASCII run survives as the slug
    expect(noteSlugOf("x".repeat(100)).length).toBeLessThanOrEqual(24);
    // leading/trailing hyphens from punctuation-only edges are trimmed
    expect(noteSlugOf("--hello--")).toBe("hello");
  });

  it("noteTimestampName is UTC, compact, and lexically sortable; noteFileName/parseNoteFileName round-trip", () => {
    const atMs = Date.UTC(2026, 8, 26, 4, 5, 6, 789); // month 8 = September
    expect(noteTimestampName(atMs)).toBe("20260926T040506789Z");
    const name = noteFileName(atMs, "finding");
    expect(name).toBe("20260926T040506789Z-finding.md");
    expect(parseNoteFileName(name)).toEqual({ at: "2026-09-26T04:05:06.789Z", slug: "finding" });
    // lexical order == time order (the directory scan's sort key)
    expect(noteTimestampName(atMs) < noteTimestampName(atMs + 1)).toBe(true);
    // non-note names are rejected honestly, never thrown
    expect(parseNoteFileName("notes.txt")).toBeUndefined();
    expect(parseNoteFileName("20260926T040506789Z.md")).toBeUndefined();
    expect(parseNoteFileName("side-20260926T040506789Z-a.md")).toBeUndefined();
  });

  it("noteFileBody/parseNoteBody round-trip; tag optional; a hand-edited body without the metadata line still reads", () => {
    const withTag = noteFileBody("2026-09-26T04:05:06.789Z", "finding", "# 结论\n正文");
    expect(parseNoteBody(withTag)).toEqual({ at: "2026-09-26T04:05:06.789Z", tag: "finding", content: "# 结论\n正文" });
    const noTag = noteFileBody("2026-09-26T04:05:06.789Z", undefined, "正文");
    expect(parseNoteBody(noTag)).toEqual({ at: "2026-09-26T04:05:06.789Z", content: "正文" });
    expect(parseNoteBody("手写的笔记没有元数据行")).toEqual({ content: "手写的笔记没有元数据行" });
  });
});

describe("121 §1 — listNotes：tag 过滤 + 时间倒序 + limit 帽 + 诚实截断", () => {
  const notes: readonly NoteRecord[] = [
    note({ file: "20260926T01Z-a.md", at: "2026-09-26T01:00:00.000Z", tag: "finding", content: "早" }),
    note({ file: "20260926T03Z-b.md", at: "2026-09-26T03:00:00.000Z", tag: "decision", content: "中" }),
    note({ file: "20260926T02Z-c.md", at: "2026-09-26T02:00:00.000Z", content: "无标签" }),
    note({ file: "20260926T04Z-d.md", at: "2026-09-26T04:00:00.000Z", tag: "finding", content: "晚" }),
  ];

  it("newest first; tag filter is exact; no tag = all notes; the default limit rides the header", () => {
    const all = listNotes(notes);
    expect(all.header.matches).toBe(4);
    expect(all.header.limit).toBe(NOTES_LIMIT_DEFAULT);
    expect(all.notes.map((n) => n.file)).toEqual([
      "20260926T04Z-d.md", "20260926T03Z-b.md", "20260926T02Z-c.md", "20260926T01Z-a.md",
    ]);
    const findings = listNotes(notes, { tag: "finding" });
    expect(findings.header.matches).toBe(2);
    expect(findings.notes.map((n) => n.at)).toEqual(["2026-09-26T04:00:00.000Z", "2026-09-26T01:00:00.000Z"]);
    expect(listNotes(notes, { tag: "nope" }).notes).toEqual([]);
  });

  it("limit clamps at the 帽 (never an error); the limit cut marks truncated honestly", () => {
    const clamped = listNotes(notes, { limit: 999 });
    expect(clamped.header.limit).toBe(NOTES_LIMIT_MAX);
    expect(clamped.header.limit_clamped).toBe(true);
    const cut = listNotes(notes, { limit: 2 });
    expect(cut.notes).toHaveLength(2);
    expect(cut.header).toMatchObject({ matches: 4, returned: 2, truncated: true });
    expect(() => listNotes(notes, { limit: 0 })).toThrow(/limit must be an integer/);
    expect(() => listNotes(notes, { tag: "" })).toThrow(/tag/);
  });

  it("the total-char budget stops the list with an honest truncated flag", () => {
    const big = Array.from({ length: 12 }, (_, i) =>
      note({ file: `20260926T${String(i).padStart(2, "0")}Z-b${i}.md`, at: `2026-09-26T${String(i).padStart(2, "0")}:00:00.000Z`, content: "x".repeat(2000) }));
    const r = listNotes(big, { limit: 50 }); // budget 16000 / 2000 = 8 notes
    expect(r.notes.length).toBe(Math.floor(NOTES_READ_TOTAL_MAX_CHARS / 2000));
    expect(r.header.truncated).toBe(true);
    expect(r.header.matches).toBe(12);
  });
});

describe("121 §1 — note_write / note_read 工具对（真 tmpdir 落盘）", () => {
  /** A fresh pair over a fresh tmpdir; `tick` advances the injected clock so
   *  tests control timestamp distinctness explicitly. */
  const mk = (): { w: Tool; r: Tool; root: string; sid: () => string; tick: (ms: number) => void } => {
    const root = mkdtempSync(join(tmpdir(), "notes-121-"));
    let sid = "sess-121";
    let clock = Date.UTC(2026, 8, 26, 4, 5, 6, 0);
    const tools = createNotesTools({ workspaceRoot: root, sessionId: () => sid, now: () => clock });
    return { w: tools[0]!, r: tools[1]!, root, sid: () => sid, tick: (ms) => { clock += ms; } };
  };
  const notesDir = (root: string, sid: string): string => join(root, ".wudao", "notes", sid);

  it("the pair carries the pinned names and the read/write risk posture", () => {
    const { w, r } = mk();
    expect(w.name).toBe("note_write");
    expect(r.name).toBe("note_read");
    expect(w.isReadOnly()).toBe(false);
    expect(r.isReadOnly()).toBe(true);
  });

  it("note_write lands <timestamp>-<slug>.md under .wudao/notes/<sessionId>/ with metadata + content; receipt is one line", async () => {
    const { w, r, root, sid } = mk();
    const res = await w.execute({ content: "fix: auth flow leaks — root cause is the stale token cache", tag: "finding" }, undefined as never);
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("已保存笔记 [finding]");
    expect((res.content as string).split("\n")).toHaveLength(1);
    const files = readdirSync(notesDir(root, sid()));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^20260926T040506000Z-fix-auth-flow-leaks-root\.md$/); // slug = first line, capped at 24
    const text = readFileSync(join(notesDir(root, sid()), files[0] as string), "utf8");
    expect(text.startsWith(`<!-- wudao-note at="2026-09-26T04:05:06.000Z" tag="finding" -->\n`)).toBe(true);
    expect(text).toContain("root cause is the stale token cache");
    const back = await r.execute({}, undefined as never);
    expect(back.isError).toBeUndefined();
    expect(back.content).toContain("stale token cache");
    expect(back.content).toContain("\"tag\":\"finding\"");
  });

  it("append-only collision: two same-timestamp same-slug writes take a suffix, never overwrite", async () => {
    const { w, root, sid } = mk(); // clock never ticks → same timestamp + same first-line slug
    await w.execute({ content: "same head conclusion\nfirst body" }, undefined as never);
    await w.execute({ content: "same head conclusion\nrevised body — the slug collides, the bytes differ" }, undefined as never);
    const files = readdirSync(notesDir(root, sid())).sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/-2\.md$/); // the suffixed collision
    const bodies = files.map((f) => readFileSync(join(notesDir(root, sid()), f), "utf8"));
    expect(bodies.some((b) => b.includes("revised body"))).toBe(true); // both bodies survive — nothing was overwritten
  });

  it("note_read: newest first, tag filter, limit cut — over the real directory", async () => {
    const { w, r, tick } = mk();
    tick(1000);
    await w.execute({ content: "first finding", tag: "finding" }, undefined as never);
    tick(1000);
    await w.execute({ content: "a decision", tag: "decision" }, undefined as never);
    tick(1000);
    await w.execute({ content: "second finding", tag: "finding" }, undefined as never);
    const all = await r.execute({}, undefined as never);
    const lines = (all.content as string).split("\n");
    expect(JSON.parse(lines[0] as string)).toMatchObject({ matches: 3, returned: 3 });
    expect(lines[1]).toContain("second finding"); // newest first
    const findings = await r.execute({ tag: "finding", limit: 1 }, undefined as never);
    const fLines = (findings.content as string).split("\n");
    expect(JSON.parse(fLines[0] as string)).toMatchObject({ matches: 2, returned: 1, truncated: true });
    expect(fLines[1]).toContain("second finding");
  });

  it("fail-closed argument gates and the honest empty face", async () => {
    const { w, r } = mk();
    expect((await w.execute({ content: "   " }, undefined as never)).isError).toBe(true);
    const tooLong = await w.execute({ content: "x".repeat(NOTE_CONTENT_MAX_CHARS + 1) }, undefined as never);
    expect(tooLong.isError).toBe(true);
    expect(tooLong.content).toContain("4000");
    expect((await w.execute({ content: "ok", tag: 'bad"tag' }, undefined as never)).isError).toBe(true);
    expect((await r.execute({ limit: 0 }, undefined as never)).isError).toBe(true);
    const none = await r.execute({}, undefined as never);
    expect(none.isError).toBeUndefined();
    expect(none.content).toContain("没有笔记");
    // an unwired workspace root fails closed with the typed refusal
    const unwired = createNotesTools({ sessionId: () => "s" });
    const refused = await unwired[1]!.execute({}, undefined as never);
    expect(refused.isError).toBe(true);
  });

  it("session isolation: the directory is per-session (a second session's dir is invisible to the first)", async () => {
    const { w, r, sid } = mk();
    await w.execute({ content: "session A conclusion" }, undefined as never);
    sid(); // no-op read to satisfy the returned shape
    const second = createNotesTools({ workspaceRoot: mkdtempSync(join(tmpdir(), "notes-121-")), sessionId: () => "sess-b" });
    const bRead = await second[1]!.execute({}, undefined as never);
    expect(bRead.content).toContain("没有笔记");
    const aRead = await r.execute({}, undefined as never);
    expect(aRead.content).toContain("session A conclusion");
  });
});
