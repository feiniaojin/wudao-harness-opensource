// ω99-55 — the file attachment domain (content-addressed storage + the
// model-visible hardlink + the request-build text projection). Spec
// invariants: dedup (1), visibility/git-cleanliness (2), wire-clean (3,
// provider-side), typed admission (4), subagent refusal (5).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { execFile as cbExecFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createFileAttachmentStore,
  createJsonlSessionStore,
  isValidFileBlock,
  fileVisibleRelPath,
  offloadRequestFiles,
  runSubagent,
  AttachmentAdmissionError,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_REQUEST_FILE_BYTES,
  type FileBlock,
  type AgentMessage,
} from "../src/index.js";
import { fileHandleText, fileLeafName, fileObjectRelPath } from "../src/attachments.js";

const execFile = promisify(cbExecFile);

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "wudao-files-")); });
afterEach(async () => { await execFile("rm", ["-rf", root]).catch(() => {}); });

const PDF_BYTES = Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\nfake pdf body for wudao ω99-55 tests\n");
const b64 = (bytes: Buffer): string => bytes.toString("base64");

async function saveOne(name: string, bytes: Buffer): Promise<FileBlock> {
  const store = createFileAttachmentStore(root);
  const blocks = await store.saveFiles([{ data: bytes.toString("base64"), name }]);
  return blocks[0]!;
}

describe("saveFiles — content-addressed storage + dedup (acceptance 1)", () => {
  it("returns FileBlocks {kind:'file', name, bytes, attachmentId:'sha256:<hex>'} in input order", async () => {
    const store = createFileAttachmentStore(root);
    const blocks = await store.saveFiles([
      { data: b64(PDF_BYTES), name: "report.pdf" },
      { data: b64(Buffer.from("1,2,3\n")), name: "data.csv" },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: "file", name: "report.pdf", bytes: PDF_BYTES.length });
    expect(blocks[0]!.attachmentId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(blocks[1]!.name).toBe("data.csv");
  });

  it("same bytes twice → same digest, ONE stored object", async () => {
    const a = await saveOne("a.pdf", PDF_BYTES);
    const b = await saveOne("b.pdf", PDF_BYTES);
    expect(b.attachmentId).toBe(a.attachmentId);
    const digest = a.attachmentId.slice("sha256:".length);
    const objDir = dirname(join(root, fileObjectRelPath(digest)));
    const entries = await readdir(objDir);
    expect(entries).toEqual([digest]); // exactly one object file
  });

  it("same content under two names → two hardlink aliases of ONE object (same inode)", async () => {
    const a = await saveOne("report.pdf", PDF_BYTES);
    const b = await saveOne("final copy.pdf", PDF_BYTES);
    expect(b.attachmentId).toBe(a.attachmentId);
    const visA = join(root, fileVisibleRelPath(a));
    const visB = join(root, fileVisibleRelPath(b));
    const stA = await stat(visA);
    const stB = await stat(visB);
    expect(stA.ino).toBe(stB.ino); // hardlinks share the inode
    expect(stA.nlink).toBeGreaterThanOrEqual(3); // object + 2 aliases
  });
});

describe("saveFiles — visibility + git cleanliness (acceptance 2)", () => {
  it("visible path exists, keeps the name, content equals the uploaded bytes", async () => {
    const block = await saveOne("annual report.pdf", PDF_BYTES);
    const vis = join(root, fileVisibleRelPath(block));
    expect(fileVisibleRelPath(block).endsWith(join(block.attachmentId.slice(7, 9), block.attachmentId.slice("sha256:".length), "annual report.pdf"))).toBe(true);
    const roundTripped = await readFile(vis);
    expect(roundTripped.equals(PDF_BYTES)).toBe(true);
  });

  it("the workspace's own tree stays untouched — git status lists ONLY .wudao paths", async () => {
    await writeFile(join(root, "tracked.txt"), "pre-existing file\n");
    await execFile("git", ["init", "-q", root]);
    await execFile("git", ["-C", root, "add", "tracked.txt"]);
    await execFile("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
    await saveOne("a.pdf", PDF_BYTES);
    const { stdout } = await execFile("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
    const lines = stdout.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThan(0); // the store DID land
    expect(lines.every((l) => l.includes(".wudao/"))).toBe(true); // nothing outside the harness root
  });

  it("with .wudao/ ignored, git status is byte-empty (zero pollution)", async () => {
    await execFile("git", ["init", "-q", root]);
    await writeFile(join(root, ".gitignore"), ".wudao/\n");
    await execFile("git", ["-C", root, "add", ".gitignore"]);
    await execFile("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
    await saveOne("a.pdf", PDF_BYTES);
    const { stdout } = await execFile("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
    expect(stdout.trim()).toBe("");
  });

  it("the visible alias is read-only (0o400 — a ref a ref parity)", async () => {
    const block = await saveOne("a.pdf", PDF_BYTES);
    const vis = join(root, fileVisibleRelPath(block));
    const mode = (await stat(vis)).mode & 0o777;
    expect(mode).toBe(0o400);
    await expect(writeFile(vis, "x")).rejects.toThrow();
  });
});

describe("saveFiles — admission is fail-closed BEFORE any write (acceptance 4)", () => {
  it("count over the cap → typed TOO_MANY_FILES, zero files written", async () => {
    const store = createFileAttachmentStore(root);
    const batch = Array.from({ length: DEFAULT_MAX_FILES + 1 }, (_, i) => ({ data: b64(Buffer.from(`f${i}`)), name: `f${i}.txt` }));
    await expect(store.saveFiles(batch)).rejects.toMatchObject({
      name: "AttachmentAdmissionError",
      code: "TOO_MANY_FILES",
    });
    await expect(readdir(join(root, ".wudao", "attachments"))).rejects.toThrow();
  });

  it("cumulative bytes over the budget → typed FILES_TOO_LARGE, zero files written", async () => {
    const store = createFileAttachmentStore(root);
    // raw size chosen so 2 × base64 > the 50MiB default (37.5MiB raw × 2).
    const raw = Math.ceil((DEFAULT_MAX_REQUEST_FILE_BYTES / 2) / (4 / 3)) + 1024;
    const big = Buffer.alloc(raw, 9);
    await expect(
      store.saveFiles([{ data: b64(big), name: "a.bin" }, { data: b64(big), name: "b.bin" }]),
    ).rejects.toMatchObject({ name: "AttachmentAdmissionError", code: "FILES_TOO_LARGE" });
    await expect(readdir(join(root, ".wudao", "attachments"))).rejects.toThrow();
  });

  it("honors caller-provided FileLimits overrides", async () => {
    const store = createFileAttachmentStore(root);
    await expect(
      store.saveFiles([{ data: b64(Buffer.from("x")), name: "a.txt" }], { maxFiles: 0, maxRequestFileBytes: 1024 }),
    ).rejects.toMatchObject({ code: "TOO_MANY_FILES" });
    await expect(
      store.saveFiles([{ data: b64(Buffer.alloc(100, 1)), name: "a.txt" }], { maxFiles: 9, maxRequestFileBytes: 50 }),
    ).rejects.toMatchObject({ code: "FILES_TOO_LARGE" });
  });

  it("malformed base64 / empty data refuse before any write", async () => {
    const store = createFileAttachmentStore(root);
    await expect(store.saveFiles([{ data: "!!not-base64!!", name: "a.txt" }])).rejects.toThrow(/base64/);
    await expect(store.saveFiles([{ data: "", name: "a.txt" }])).rejects.toThrow(/base64/);
    await expect(readdir(join(root, ".wudao", "attachments"))).rejects.toThrow();
  });
});

describe("fileLeafName — display names sanitize to safe leaf names", () => {
  it("strips both separator styles (a Windows client path leaks nothing)", () => {
    expect(fileLeafName("C:\\Users\\me\\报告.pdf")).toBe("报告.pdf");
    expect(fileLeafName("/tmp/local/notes.txt")).toBe("notes.txt");
  });
  it("drops control chars, replaces Windows-refused chars, trims trailing dots/spaces", () => {
    expect(fileLeafName("bad\x00name\x1f.txt")).toBe("badname.txt");
    expect(fileLeafName("a<b>c.txt")).toBe("a_b_c.txt");
    expect(fileLeafName("trailing dots... ")).not.toMatch(/[. ]$/);
  });
  it("refuses Windows device names and collapses empty/dot names to 'file'", () => {
    expect(fileLeafName("CON")).toBe("_CON");
    expect(fileLeafName("")).toBe("file");
    expect(fileLeafName("..")).toBe("file");
  });
  it("caps at 255 UTF-8 bytes without splitting a multibyte char", () => {
    const long = "字".repeat(200); // 600 UTF-8 bytes
    const capped = fileLeafName(long);
    expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(255);
    expect(Buffer.byteLength(capped)).toBeGreaterThanOrEqual(255 - 3);
  });
});

describe("offloadRequestFiles — the request-build projection (acceptance 3, pure)", () => {
  const sha = (hex: string): string => `sha256:${hex.padEnd(64, "0")}`;
  const fblock = (name: string, bytes: number, hex: string): FileBlock => ({ kind: "file", name, bytes, attachmentId: sha(hex) });

  it("returns the SAME array reference when nothing rides files (byte-identity prefilter)", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "plain" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "with image", images: [{ kind: "image", ref: { kind: "image", attachmentId: "0b0e8a91-1111-4111-8111-111111111111", mediaType: "image/png", byteLength: 3 } }] },
    ];
    expect(offloadRequestFiles(messages)).toBe(messages);
  });

  it("a file-bearing user turn gains handle text naming the visible path; files drop", () => {
    const b = fblock("report.pdf", 123, "9a3f");
    const out = offloadRequestFiles([{ role: "user", content: "see attached", files: [b] }]);
    const m = out[0] as { role: string; content: string; files?: unknown };
    expect(m.files).toBeUndefined();
    expect(m.content).toContain("see attached");
    expect(m.content).toContain(fileVisibleRelPath(b));
    expect(m.content).toContain('"report.pdf"');
    expect(m.content).toContain("(123 bytes");
  });

  it("an empty-caption file-only turn becomes handle-only text (no empty part)", () => {
    const b = fblock("a.csv", 9, "11");
    const out = offloadRequestFiles([{ role: "user", content: "", files: [b] }]);
    expect((out[0] as { content: string }).content.startsWith("[attached file")).toBe(true);
  });

  it("multiple files → one handle line each, in block order", () => {
    const b1 = fblock("a.csv", 9, "11");
    const b2 = fblock("b.pdf", 90, "22");
    const out = offloadRequestFiles([{ role: "user", content: "x", files: [b1, b2] }]);
    const c = (out[0] as { content: string }).content;
    const i1 = c.indexOf(fileVisibleRelPath(b1));
    const i2 = c.indexOf(fileVisibleRelPath(b2));
    expect(i1).toBeGreaterThan(-1);
    expect(i2).toBeGreaterThan(i1);
    expect(c.match(/\[attached file/g)?.length).toBe(2);
  });

  it("non-user messages pass through untouched", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: "prior" },
      { role: "tool", toolCallId: "t1", name: "read_file", content: "r" },
    ];
    expect(offloadRequestFiles(messages)).toBe(messages);
  });
});

describe("fileHandleText / isValidFileBlock / path guards", () => {
  it("isValidFileBlock accepts a well-formed block and rejects junk", () => {
    const b: FileBlock = { kind: "file", name: "a.txt", bytes: 3, attachmentId: "sha256:" + "a".repeat(64) };
    expect(isValidFileBlock(b)).toBe(true);
    expect(isValidFileBlock({ ...b, attachmentId: "../../etc/passwd" })).toBe(false);
    expect(isValidFileBlock({ ...b, attachmentId: "sha256:ABC" })).toBe(false);
    expect(isValidFileBlock({ ...b, name: "" })).toBe(false);
    expect(isValidFileBlock({ kind: "image" })).toBe(false);
  });

  it("a doctored id or name never derives a path (traversal refusal)", () => {
    expect(() => fileVisibleRelPath({ kind: "file", name: "a", bytes: 1, attachmentId: "sha256:../x" })).toThrow(/invalid file attachment id/);
    expect(() => fileVisibleRelPath({ kind: "file", name: "a/b", bytes: 1, attachmentId: "sha256:" + "a".repeat(64) })).toThrow(/invalid file attachment name/);
    expect(() => fileObjectRelPath("../escape")).toThrow(/invalid file digest/);
  });

  it("fileHandleText is deterministic and names the digest prefix + path", () => {
    const b: FileBlock = { kind: "file", name: "a.txt", bytes: 3, attachmentId: "sha256:9a3f11" + "0".repeat(58) };
    expect(fileHandleText(b)).toBe(fileHandleText(b));
    expect(fileHandleText(b)).toContain("sha256:9a3f11000000");
    expect(fileHandleText(b)).toContain(".wudao/attachments/files/9a/9a3f11");
  });
});

describe("persistence — JSONL carries file blocks, never bytes", () => {
  it("a file-bearing user turn round-trips through the session store", async () => {
    const block = await saveOne("spec v2.pdf", PDF_BYTES);
    const sessions = createJsonlSessionStore(join(root, ".wudao", "sessions"));
    await sessions.append("s1", { role: "user", content: "review this", files: [block] });
    await sessions.append("s1", { role: "assistant", content: "done" });
    const raw = await readFile(join(root, ".wudao", "sessions", "s1.jsonl"), "utf8");
    expect(raw).not.toContain(b64(PDF_BYTES)); // bytes never enter the log
    expect(raw).toContain(block.attachmentId);
    const loaded = await sessions.load("s1");
    const first = loaded[0] as { content: string; files?: unknown[] };
    expect(first.content).toBe("review this");
    expect(isValidFileBlock(first.files?.[0])).toBe(true);
  });

  it("a malformed files field invalidates the line (skipped on load)", async () => {
    const sessions = createJsonlSessionStore(join(root, ".wudao", "sessions"));
    await sessions.append("s2", { role: "user", content: "ok" });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(
      join(root, ".wudao", "sessions", "s2.jsonl"),
      `${JSON.stringify({ role: "user", content: "bad", files: [{ kind: "file", name: "x", bytes: 1, attachmentId: "nope" }] })}\n`,
    );
    const loaded = await sessions.load("s2");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.content).toBe("ok");
  });
});

describe("subagent — file blocks never ride child input (acceptance 5)", () => {
  it("promptFiles on ANY child shape → typed refusal before the loop runs", async () => {
    const block: FileBlock = { kind: "file", name: "a.pdf", bytes: 10, attachmentId: "sha256:" + "a".repeat(64) };
    const opts = {
      model: { generate: async () => ({ role: "assistant", content: "x" }) } as never,
      allTools: [],
      subagentType: { name: "coder", description: "d", systemPrompt: "s", toolNames: [] },
      prompt: "do it",
      promptFiles: [block],
      loopOptions: { maxTurns: 1 },
    };
    await expect(runSubagent(opts)).rejects.toThrow(/file blocks cannot ride subagent input/);
  });
});
