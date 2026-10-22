// M24 Task 2: read_file pagination (offset/limit + 2000-line / 50KB dual cap)
// and zero-repeat elision (B1). The elision probe is INJECTED (core stays
// dependency-free): no probe, or !force, or content not byte-present in the
// probe's messages → full content, exactly like before.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createReadFileTool } from "../src/tools/read-file.js";
import type { AgentMessage } from "../src/types.js";

const TRUNCATION_HINT = /— call again with offset=(\d+)\)$/;
const ELIDED_MARKER = "[elided]";

describe("read_file pagination (dual cap)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "rf-page-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("returns small files verbatim (no pagination artifacts)", async () => {
    const body = "line one\nline two\n";
    await writeFile(join(root, "small.txt"), body, "utf8");
    const res = await createReadFileTool({ workspaceRoot: root }).execute({ path: "small.txt" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe(body);
  });

  it("returns an empty file verbatim (no pagination error)", async () => {
    await writeFile(join(root, "empty.txt"), "", "utf8");
    const res = await createReadFileTool({ workspaceRoot: root }).execute({ path: "empty.txt" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe("");
  });

  it("truncates the head at 2000 lines and points at the next offset", async () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `line-${i + 1}`);
    await writeFile(join(root, "big.txt"), `${lines.join("\n")}\n`, "utf8");
    const res = await createReadFileTool({ workspaceRoot: root }).execute({ path: "big.txt" });
    expect(res.isError).toBeFalsy();
    expect(res.content.startsWith("line-1\nline-2\n")).toBe(true);
    expect(res.content).toContain("line-2000\n");
    expect(res.content).not.toContain("\nline-2001\n");
    const m = TRUNCATION_HINT.exec(res.content.split("\n").at(-1) ?? "");
    expect(m?.[1]).toBe("2001");
    expect(res.content).toContain("500 more lines");
  });

  it("truncates at 50KB even under the line cap (whichever comes first)", async () => {
    // 600 lines x 101 bytes ≈ 60.6KB — the byte cap fires first.
    const line = "x".repeat(100);
    await writeFile(join(root, "wide.txt"), `${Array.from({ length: 600 }, () => line).join("\n")}\n`, "utf8");
    const res = await createReadFileTool({ workspaceRoot: root }).execute({ path: "wide.txt" });
    expect(res.isError).toBeFalsy();
    const body = res.content.slice(0, res.content.lastIndexOf("\n…"));
    expect(body.length).toBeLessThanOrEqual(50 * 1024 + 1);
    expect(TRUNCATION_HINT.test(res.content)).toBe(true);
    expect(res.content).toContain("more KB");
  });

  it("offset+limit select an exact window (with a paging hint when more remains)", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `L${i + 1}`);
    await writeFile(join(root, "ten.txt"), `${lines.join("\n")}\n`, "utf8");
    const res = await createReadFileTool({ workspaceRoot: root }).execute({ path: "ten.txt", offset: 4, limit: 3 });
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe("L4\nL5\nL6\n… (4 more lines / 0 more KB — call again with offset=7)");
    // The final window ends flush with the file: no trailer.
    const last = await createReadFileTool({ workspaceRoot: root }).execute({ path: "ten.txt", offset: 8, limit: 3 });
    expect(last.content).toBe("L8\nL9\nL10");
  });

  it("offset past the end is a friendly error, not a throw", async () => {
    await writeFile(join(root, "tiny.txt"), "only line\n", "utf8");
    const res = await createReadFileTool({ workspaceRoot: root }).execute({ path: "tiny.txt", offset: 99 });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("offset 99");
    expect(res.content).toContain("beyond");
  });

  it("rejects non-positive or fractional offset/limit", async () => {
    await writeFile(join(root, "t.txt"), "x\n", "utf8");
    const tool = createReadFileTool({ workspaceRoot: root });
    for (const bad of [{ offset: 0 }, { offset: -3 }, { offset: 1.5 }, { limit: 0 }, { limit: -1 }, { limit: 2.5 }]) {
      const res = await tool.execute({ path: "t.txt", ...bad });
      expect(res.isError).toBe(true);
      expect(res.content).toMatch(/offset|limit/);
    }
  });

  it("documents offset/limit/force in the tool description", () => {
    const tool = createReadFileTool();
    expect(tool.description).toContain("offset");
    expect(tool.description).toContain("limit");
    expect(tool.description).toContain("force");
  });
});

describe("read_file zero-repeat elision (B1)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "rf-elide-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const FILE = "note.txt";
  const BODY = "THE-CONTENT-SENTINEL-42\nsecond line\n";

  async function seed(): Promise<void> {
    await writeFile(join(root, FILE), BODY, "utf8");
  }

  it("elides when the exact content is byte-present in the probe messages", async () => {
    await seed();
    const probe = (): AgentMessage[] => [
      { role: "user", content: "read it" },
      { role: "tool", toolCallId: "c1", name: "read_file", content: BODY },
    ];
    const res = await createReadFileTool({ workspaceRoot: root, contextProbe: probe }).execute({ path: FILE });
    expect(res.isError).toBeFalsy();
    expect(res.content.startsWith(`${ELIDED_MARKER} ${FILE}`)).toBe(true);
    expect(res.content).toContain("force=true");
    // first-8 hash chars of the identical content
    expect(res.content).toMatch(/sha256:[0-9a-f]{8}/);
    expect(res.content).not.toContain("SENTINEL");
  });

  it("returns full content when the probe shows different content (fallback)", async () => {
    await seed();
    const probe = (): AgentMessage[] => [
      { role: "tool", toolCallId: "c1", name: "read_file", content: "something else entirely" },
    ];
    const res = await createReadFileTool({ workspaceRoot: root, contextProbe: probe }).execute({ path: FILE });
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe(BODY);
  });

  it("force=true bypasses the elision even when content is present", async () => {
    await seed();
    const probe = (): AgentMessage[] => [
      { role: "tool", toolCallId: "c1", name: "read_file", content: BODY },
    ];
    const res = await createReadFileTool({ workspaceRoot: root, contextProbe: probe }).execute({ path: FILE, force: true });
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe(BODY);
  });

  it("no probe injected → never elides (default wiring unchanged)", async () => {
    await seed();
    const res = await createReadFileTool({ workspaceRoot: root }).execute({ path: FILE });
    expect(res.content).toBe(BODY);
  });

  it("compaction stubbing the old copy breaks presence → full content returns", async () => {
    await seed();
    const probe = (): AgentMessage[] => [
      { role: "user", content: "read it" },
      { role: "tool", toolCallId: "c1", name: "read_file", content: "[compacted tool_result c1: THE-CONTENT-SENTINEL…]" },
    ];
    const res = await createReadFileTool({ workspaceRoot: root, contextProbe: probe }).execute({ path: FILE });
    expect(res.content).toBe(BODY);
  });

  it("a re-read of a truncated window elides on the window bytes (zero repeat)", async () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `line-${i + 1}`);
    await writeFile(join(root, "big.txt"), `${lines.join("\n")}\n`, "utf8");
    const tool = createReadFileTool({ workspaceRoot: root, contextProbe: () => [] });
    const first = await tool.execute({ path: "big.txt" });
    expect(first.isError).toBeFalsy();
    // The first (truncated) result is now "in context": a repeat default read elides.
    const probe = (): AgentMessage[] => [{ role: "tool", toolCallId: "c9", name: "read_file", content: first.content }];
    const second = await createReadFileTool({ workspaceRoot: root, contextProbe: probe }).execute({ path: "big.txt" });
    expect(second.content.startsWith(ELIDED_MARKER)).toBe(true);
  });
});
