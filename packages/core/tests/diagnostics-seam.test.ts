// M51 §2 — the diagnostics seam on write_file/edit: beforeWrite runs BEFORE
// the bytes land, afterWrite's NEW-only lines append after the verify output
// under the [diagnostics new: N] source label, and an absent layer keeps the
// M46 result byte-identical.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWriteFileTool } from "../src/tools/write-file.js";
import { createEditTool } from "../src/tools/edit.js";
import { appendDiagnosticsLines, diagnosticsMarker, type DiagnosticsLayer, type WriteVerifyConfig } from "../src/tools/write-verify.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "diag-seam-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const ON: WriteVerifyConfig = { enabled: true, tsTsc: false };

/** A fake layer that records the on-disk bytes it saw at beforeWrite time and
 *  answers afterWrite with fixed lines. */
function fakeLayer(lines: readonly string[] = ["f.js:9: NEW error"]): DiagnosticsLayer & { seenBefore: string[] } {
  const seenBefore: string[] = [];
  return {
    seenBefore,
    async beforeWrite(absPath: string) {
      seenBefore.push(await readFile(absPath, "utf8").catch(() => "(missing)"));
    },
    async afterWrite() { return lines; },
  };
}

describe("appendDiagnosticsLines", () => {
  it("appends the source-labeled section; empty input is a no-op", () => {
    expect(appendDiagnosticsLines("base", [])).toBe("base");
    expect(appendDiagnosticsLines("base", ["a:1: x", "a:2: y"])).toBe(`base\n${diagnosticsMarker(2)}\na:1: x\na:2: y`);
    expect(diagnosticsMarker(1)).toBe("[diagnostics new: 1]");
  });
});

describe("write_file seam", () => {
  it("captures the baseline BEFORE the write, then folds new-only lines after the verify output", async () => {
    const file = join(root, "f.js");
    await writeFile(file, "let ok = 1;\n", "utf8");
    const layer = fakeLayer();
    const tool = createWriteFileTool({ workspaceRoot: root, writeVerify: ON, diagnostics: layer });
    const res = await tool.execute({ path: "f.js", content: "let broken = {\n" });
    // beforeWrite saw the PRE-write bytes (not the new content)
    expect(layer.seenBefore).toEqual(["let ok = 1;\n"]);
    // verify section leads (M46 shape), diagnostics section rides after
    expect(res.isError).not.toBe(true);
    expect(res.content).toContain("[verified: node --check 1 error]");
    expect(res.content).toContain("wrote f.js");
    const diagAt = res.content.indexOf("[diagnostics new: 1]");
    const verifyAt = res.content.indexOf("[verified:");
    expect(verifyAt).toBeGreaterThanOrEqual(0);
    expect(diagAt).toBeGreaterThan(verifyAt);
    expect(res.content).toContain("f.js:9: NEW error");
  });

  it("a broken write_file still folds diagnostics (two layers of feedback)", async () => {
    const layer = fakeLayer(["g.js:2: NEW"]);
    const tool = createWriteFileTool({ workspaceRoot: root, writeVerify: ON, diagnostics: layer });
    const res = await tool.execute({ path: "g.js", content: "const x = ;\n" });
    expect(res.isError).not.toBe(true);
    expect(res.content).toContain("[diagnostics new: 1]");
    expect(res.content).toContain("g.js:2: NEW");
  });

  it("absent layer → the exact M46 result (no diagnostics section)", async () => {
    const tool = createWriteFileTool({ workspaceRoot: root, writeVerify: ON });
    const res = await tool.execute({ path: "h.js", content: "const y = ;\n" });
    expect(res.content).not.toContain("[diagnostics");
  });
});

describe("edit seam", () => {
  it("captures the pre-edit baseline and folds new-only lines after the verify output", async () => {
    const file = join(root, "e.js");
    await writeFile(file, "function good() {\n  return 1;\n}\n", "utf8");
    const layer = fakeLayer(["e.js:4: NEW error"]);
    const tool = createEditTool({ workspaceRoot: root, writeVerify: ON, diagnostics: layer });
    const res = await tool.execute({ path: "e.js", old_string: "return 1;", new_string: "return ;" });
    expect(layer.seenBefore).toEqual(["function good() {\n  return 1;\n}\n"]);
    expect(res.isError).not.toBe(true);
    expect(res.content).toContain("edited e.js");
    expect(res.content).toContain("[diagnostics new: 1]");
    expect(res.content).toContain("e.js:4: NEW error");
  });

  it("absent layer → the exact M46 result", async () => {
    const file = join(root, "e2.js");
    await writeFile(file, "const a = 1;\n", "utf8");
    const tool = createEditTool({ workspaceRoot: root, writeVerify: ON });
    const res = await tool.execute({ path: "e2.js", old_string: "a = 1", new_string: "a = ;" });
    expect(res.content).not.toContain("[diagnostics");
  });
});
