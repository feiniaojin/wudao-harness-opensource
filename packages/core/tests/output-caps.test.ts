// M24 Task 6 (core half): glob/grep dual caps + shell spill.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobTool } from "../src/tools/glob.js";
import { createGrepTool } from "../src/tools/grep.js";
import { createShellTool } from "../src/tools/shell.js";
import { capOutputLines } from "../src/tools/output-caps.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "caps-")); });
afterEach(async () => {
  // win32: a just-exited exec child can hold the workspace cwd handle briefly
  // — the rmdir races EBUSY (force skips ENOENT, not EBUSY). Retry a little.
  for (let i = 0; i < 5; i += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EBUSY") throw err;
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
  await rm(root, { recursive: true, force: true }); // still busy → surface it
});

describe("capOutputLines", () => {
  it("returns text under the byte cap unchanged", () => {
    expect(capOutputLines("short")).toBe("short");
  });
  it("caps oversized text at whole lines with a tail note", () => {
    const line = "x".repeat(200);
    const text = Array.from({ length: 400 }, () => line).join("\n"); // 80KB
    const out = capOutputLines(text);
    expect(out.length).toBeLessThanOrEqual(50 * 1024 + 200);
    expect(out).toContain("— output capped at 2000 lines / 50KB)");
    expect(out).not.toContain("\n\n");
  });
});

describe("glob output cap", () => {
  it("keeps the 200-match cap (existing limit preserved)", async () => {
    await mkdir(join(root, "many"), { recursive: true });
    await Promise.all(
      Array.from({ length: 260 }, (_, i) => writeFile(join(root, "many", `f${String(i).padStart(4, "0")}.txt`), "x")),
    );
    const res = await createGlobTool({ workspaceRoot: root }).execute({ pattern: "many/*.txt" });
    const lines = res.content.split("\n").filter((l) => l.length > 0 && !l.startsWith("…"));
    expect(lines.length).toBeLessThanOrEqual(200);
  });
});

describe("grep output cap", () => {
  it("keeps the 100-hit cap and caps bytes on huge lines", async () => {
    await writeFile(join(root, "wide.txt"), Array.from({ length: 150 }, (_, i) => `L${i} ${"y".repeat(400)}`).join("\n"), "utf8");
    const res = await createGrepTool({ workspaceRoot: root }).execute({ pattern: "L\\d+" });
    const hits = res.content.split("\n").filter((l) => l.startsWith("wide.txt:"));
    expect(hits.length).toBeLessThanOrEqual(100);
    expect(res.content.length).toBeLessThanOrEqual(50 * 1024 + 200);
  });
});

describe("shell spill (M24)", () => {
  it("spills the full output past the inline cap and names the path", async () => {
    const spillDir = join(root, ".wudao", "spill", "sess-1");
    const tool = createShellTool({ workspaceRoot: root, maxOutputBytes: 2048, spillDir });
    const res = await tool.execute({ command: "node -e \"process.stdout.write('SPILL-MARKER-' + 'z'.repeat(20000))\"" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("SPILL-MARKER-");
    expect(res.content).toContain("(full output: ");
    const path = /\(full output: (.+)\)/.exec(res.content)?.[1];
    expect(path).toBeDefined();
    const spilled = await readFile(path!, "utf8");
    expect(spilled).toContain("SPILL-MARKER-");
    expect(spilled.length).toBeGreaterThan(20000); // the FULL output, not the inline slice
    // Deterministic name: content hash.
    const files = await readdir(spillDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{16}\.txt$/);
  });

  it("small outputs do not spill", async () => {
    const spillDir = join(root, ".wudao", "spill", "sess-2");
    const tool = createShellTool({ workspaceRoot: root, spillDir });
    const res = await tool.execute({ command: "echo tiny" });
    expect(res.content).toContain("tiny");
    expect(res.content).not.toContain("(full output:");
    await expect(readdir(spillDir)).rejects.toThrow(); // directory never created
  });

  it("no spillDir → truncated output only (pre-M24 behavior)", async () => {
    const tool = createShellTool({ workspaceRoot: root, maxOutputBytes: 2048 });
    const res = await tool.execute({ command: "node -e \"process.stdout.write('x'.repeat(4096))\"" });
    expect(res.content).not.toContain("(full output:");
    // Truncation still applies at the inline cap.
    expect(res.content.length).toBeLessThan(4096);
  });
});
