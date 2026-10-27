import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, utimes, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEditTool } from "../src/tools/edit.js";
import { createReadFileTool } from "../src/tools/read-file.js";
import { createReadStateTable } from "../src/tools/read-state.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "ws-")); await writeFile(join(root, "f.txt"), "foo bar foo"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const T0 = new Date("2024-01-01T00:00:00Z");
const T1 = new Date("2024-01-02T00:00:00Z");
const touch = (path: string, when: Date): Promise<void> => utimes(path, when, when);

describe("edit", () => {
  it("replaces a unique occurrence", async () => {
    const tool = createEditTool({ workspaceRoot: root });
    const res = await tool.execute({ path: "f.txt", old_string: "bar", new_string: "baz" });
    expect(res.isError).toBeFalsy();
    expect(await readFile(join(root, "f.txt"), "utf8")).toBe("foo baz foo");
    // M32: the result is a numbered ±4-line snippet, not a bare OK.
    expect(res.content).toMatch(/\(match: exact\)/);
    expect(res.content).toMatch(/1→ /);
  });
  it("errors when old_string is not unique", async () => {
    const tool = createEditTool({ workspaceRoot: root });
    const res = await tool.execute({ path: "f.txt", old_string: "foo", new_string: "x" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("not unique");
  });
  it("errors when old_string is absent", async () => {
    const tool = createEditTool({ workspaceRoot: root });
    const res = await tool.execute({ path: "f.txt", old_string: "nope", new_string: "x" });
    expect(res.isError).toBe(true);
  });
  it("errors on empty old_string", async () => {
    const tool = createEditTool({ workspaceRoot: root });
    const res = await tool.execute({ path: "f.txt", old_string: "", new_string: "x" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("must not be empty");
  });

  // -------------------------------------------------------------------------
  // M32 §1 — read-freshness gate (fail-closed)
  // -------------------------------------------------------------------------
  describe("freshness", () => {
    it("refuses an edit after an external mtime change, then passes after a re-read", async () => {
      const readState = createReadStateTable();
      const readFileTool = createReadFileTool({ workspaceRoot: root, readState });
      const edit = createEditTool({ workspaceRoot: root, readState });
      await touch(join(root, "f.txt"), T0);
      await readFileTool.execute({ path: "f.txt" });
      // External change: content + a later mtime.
      await writeFile(join(root, "f.txt"), "foo QUUX foo", "utf8");
      await touch(join(root, "f.txt"), T1);
      const refused = await edit.execute({ path: "f.txt", old_string: "QUUX", new_string: "baz" });
      expect(refused.isError).toBe(true);
      expect(refused.content).toContain("changed since your last read");
      expect(refused.content).toContain("re-read");
      // Fail-closed: the disk is untouched.
      expect(await readFile(join(root, "f.txt"), "utf8")).toBe("foo QUUX foo");
      // Re-read unblocks the edit.
      await readFileTool.execute({ path: "f.txt" });
      const ok = await edit.execute({ path: "f.txt", old_string: "QUUX", new_string: "baz" });
      expect(ok.isError).toBeFalsy();
      expect(await readFile(join(root, "f.txt"), "utf8")).toBe("foo baz foo");
    });
    it("a session's own edit refreshes the entry — the next edit needs no re-read", async () => {
      const readState = createReadStateTable();
      const readFileTool = createReadFileTool({ workspaceRoot: root, readState });
      const edit = createEditTool({ workspaceRoot: root, readState });
      await readFileTool.execute({ path: "f.txt" });
      const first = await edit.execute({ path: "f.txt", old_string: "bar", new_string: "baz" });
      expect(first.isError).toBeFalsy();
      const second = await edit.execute({ path: "f.txt", old_string: "baz", new_string: "qux" });
      expect(second.isError).toBeFalsy();
      expect(await readFile(join(root, "f.txt"), "utf8")).toBe("foo qux foo");
    });
    it("refuses when mtime is identical but content differs (hash belt)", async () => {
      const readState = createReadStateTable();
      const p = await realpath(join(root, "f.txt"));
      const readFileTool = createReadFileTool({ workspaceRoot: root, readState });
      const edit = createEditTool({ workspaceRoot: root, readState });
      await touch(p, T0);
      await readFileTool.execute({ path: "f.txt" });
      const recorded = readState.get(p);
      expect(recorded).toBeDefined();
      // Rewrite the content but rewind mtime to the recorded value.
      await writeFile(p, "foo TAMPERED foo", "utf8");
      await utimes(p, (recorded?.mtimeMs ?? 0) / 1000, (recorded?.mtimeMs ?? 0) / 1000);
      const res = await edit.execute({ path: "f.txt", old_string: "TAMPERED", new_string: "x" });
      expect(res.isError).toBe(true);
      expect(res.content).toContain("changed since your last read");
    });
    it("never-read files keep the legacy behavior (no gate)", async () => {
      const edit = createEditTool({ workspaceRoot: root, readState: createReadStateTable() });
      const res = await edit.execute({ path: "f.txt", old_string: "bar", new_string: "baz" });
      expect(res.isError).toBeFalsy();
    });
  });

  // -------------------------------------------------------------------------
  // M32 §1 — fuzzy ladder (unique hit required at every rung)
  // -------------------------------------------------------------------------
  describe("fuzzy ladder", () => {
    it("matches through smart-quote normalization (file smart, needle straight)", async () => {
      await writeFile(join(root, "q.txt"), 'said “hello” today\n', "utf8");
      const edit = createEditTool({ workspaceRoot: root });
      const res = await edit.execute({ path: "q.txt", old_string: 'said "hello" today', new_string: "greeted" });
      expect(res.isError).toBeFalsy();
      expect(res.content).toContain("match: quote-normalized");
      expect(await readFile(join(root, "q.txt"), "utf8")).toBe("greeted\n");
    });
    it("matches through smart-quote normalization (file straight, needle smart)", async () => {
      await writeFile(join(root, "q.txt"), 'said "hello" today\n', "utf8");
      const edit = createEditTool({ workspaceRoot: root });
      const res = await edit.execute({ path: "q.txt", old_string: "said “hello” today", new_string: "greeted" });
      expect(res.isError).toBeFalsy();
      expect(res.content).toContain("match: quote-normalized");
      expect(await readFile(join(root, "q.txt"), "utf8")).toBe("greeted\n");
    });
    it("matches with leading/trailing whitespace tolerance", async () => {
      await writeFile(join(root, "w.txt"), "  alpha beta  gamma\n", "utf8");
      const edit = createEditTool({ workspaceRoot: root });
      const res = await edit.execute({ path: "w.txt", old_string: "alpha beta\n", new_string: "ALPHA" });
      expect(res.isError).toBeFalsy();
      expect(res.content).toContain("match: whitespace-tolerant");
      // The tolerated whitespace belongs to the file, not the match.
      expect(await readFile(join(root, "w.txt"), "utf8")).toBe("  ALPHA  gamma\n");
    });
    it("rejects ambiguity at a fuzzy rung", async () => {
      await writeFile(join(root, "q.txt"), 'said “x” and said “x”\n', "utf8");
      const edit = createEditTool({ workspaceRoot: root });
      const res = await edit.execute({ path: "q.txt", old_string: 'said "x"', new_string: "y" });
      expect(res.isError).toBe(true);
      expect(res.content).toContain("not unique");
      expect(res.content).toContain("quote normalization");
      expect(await readFile(join(root, "q.txt"), "utf8")).toBe('said “x” and said “x”\n');
    });
    it("zero hits → teaching error with a ±4-line numbered closest candidate", async () => {
      const lines = ["one", "two", "three", "four", "the target lina", "six", "seven", "eight", "nine", "ten"];
      await writeFile(join(root, "c.txt"), lines.join("\n") + "\n", "utf8");
      const edit = createEditTool({ workspaceRoot: root });
      const res = await edit.execute({ path: "c.txt", old_string: "the target line", new_string: "x" });
      expect(res.isError).toBe(true);
      expect(res.content).toContain("not found");
      expect(res.content).toContain("Closest candidate");
      expect(res.content).toContain("around line 5");
      // Numbered snippet: line 1..9 window (5 ± 4).
      expect(res.content).toContain("1→ one");
      expect(res.content).toContain("5→ the target lina");
      expect(res.content).toContain("9→ nine");
      expect(res.content).not.toContain("10→");
    });
  });

  // -------------------------------------------------------------------------
  // M32 §1 — replace_all
  // -------------------------------------------------------------------------
  describe("replace_all", () => {
    it("replaces every occurrence and reports the count", async () => {
      const edit = createEditTool({ workspaceRoot: root });
      const res = await edit.execute({ path: "f.txt", old_string: "foo", new_string: "BETA", replace_all: true });
      expect(res.isError).toBeFalsy();
      expect(res.content).toContain("2 replacements");
      expect(await readFile(join(root, "f.txt"), "utf8")).toBe("BETA bar BETA");
    });
    it("replaces every quote-normalized occurrence", async () => {
      await writeFile(join(root, "q.txt"), '“q” and “q”\n', "utf8");
      const edit = createEditTool({ workspaceRoot: root });
      const res = await edit.execute({ path: "q.txt", old_string: '"q"', new_string: "r", replace_all: true });
      expect(res.isError).toBeFalsy();
      expect(res.content).toContain("2 replacements");
      expect(await readFile(join(root, "q.txt"), "utf8")).toBe("r and r\n");
    });
    it("zero hits still errors", async () => {
      const edit = createEditTool({ workspaceRoot: root });
      const res = await edit.execute({ path: "f.txt", old_string: "nope", new_string: "x", replace_all: true });
      expect(res.isError).toBe(true);
      expect(res.content).toContain("not found");
    });
  });

  // -------------------------------------------------------------------------
  // ω99-4a — match ladder extensions: blank-line-relaxed + indent-relative
  // (aider search_replace.py port; unique hit still required at every rung)
  // -------------------------------------------------------------------------
  describe("match ladder ω99-4a extensions", () => {
    it("blank-line-relaxed: strips boundary blank lines off old_string AND new_string", async () => {
      // File has 1 blank line around the block; the needle carries 2 on each
      // side — the classic reasoning-model mismatch. The exact rung must miss
      // (the file never has two consecutive newlines), so the new rung fires.
      await writeFile(join(root, "b.txt"), "header\n\nfoo();\nbar();\n\nfooter\n", "utf8");
      const edit = createEditTool({ workspaceRoot: root });
      const res = await edit.execute({
        path: "b.txt",
        old_string: "\n\n\nfoo();\nbar();\n\n\n",
        new_string: "\n\n\nqux();\nbaz();\n\n\n",
      });
      expect(res.isError).toBeFalsy();
      expect(res.content).toContain("match: blank-line-relaxed");
      // new_string is stripped the SAME way (aider strips the triple).
      expect(await readFile(join(root, "b.txt"), "utf8")).toBe("header\n\nqux();\nbaz();\n\nfooter\n");
    });
    it("blank-line-relaxed: 2 hits after stripping → ambiguity error, disk untouched", async () => {
      await writeFile(join(root, "b2.txt"), "a\n\nX\nY\n\nb\n\nX\nY\n\nc\n", "utf8");
      const edit = createEditTool({ workspaceRoot: root });
      const res = await edit.execute({ path: "b2.txt", old_string: "\n\n\nX\nY\n\n\n", new_string: "Z\nW" });
      expect(res.isError).toBe(true);
      expect(res.content).toContain("not unique");
      expect(res.content).toContain("blank-line relaxation");
      expect(res.content).toContain("2 matches");
      expect(await readFile(join(root, "b2.txt"), "utf8")).toBe("a\n\nX\nY\n\nb\n\nX\nY\n\nc\n");
    });
    it("blank-line-relaxed: replace_all replaces every stripped occurrence with the stripped new_string", async () => {
      await writeFile(join(root, "b3.txt"), "pre\n\nP\nQ\n\nmid\n\nP\nQ\n\npost\n", "utf8");
      const edit = createEditTool({ workspaceRoot: root });
      const res = await edit.execute({
        path: "b3.txt",
        old_string: "\n\n\nP\nQ\n\n\n",
        new_string: "\n\n\nR\nS\n\n\n",
        replace_all: true,
      });
      expect(res.isError).toBeFalsy();
      expect(res.content).toContain("match: blank-line-relaxed");
      expect(res.content).toContain("2 replacements");
      expect(await readFile(join(root, "b3.txt"), "utf8")).toBe("pre\n\nR\nS\n\nmid\n\nR\nS\n\npost\n");
    });
  });

  describe("match ladder ω99-4a — indent-relative", () => {
    it("uniform shift: 0-indent needle matches an 8-space block; new_string re-indented", async () => {
      // The model wrote the nested block at column 0 — rung 5 detects the
      // uniform shift and applies the same shift to new_string.
      await writeFile(join(root, "i.txt"), "top\n        alpha();\n        beta();\n        gamma();\nbottom\n", "utf8");
      const edit = createEditTool({ workspaceRoot: root });
      const res = await edit.execute({
        path: "i.txt",
        old_string: "alpha();\nbeta();\ngamma();",
        new_string: "alpha2();\nbeta2();\ngamma2();",
      });
      expect(res.isError).toBeFalsy();
      expect(res.content).toContain("match: indent-relative");
      expect(await readFile(join(root, "i.txt"), "utf8"))
        .toBe("top\n        alpha2();\n        beta2();\n        gamma2();\nbottom\n");
    });
    it("uniform shift: non-zero baseline (needle 2sp, file 6sp) shifts every line by +4", async () => {
      await writeFile(join(root, "i2.txt"), "f\n      one();\n      two();\ng\n", "utf8");
      const edit = createEditTool({ workspaceRoot: root });
      const res = await edit.execute({
        path: "i2.txt",
        old_string: "  one();\n  two();",
        new_string: "  uno();\n    sub();",
      });
      expect(res.isError).toBeFalsy();
      expect(res.content).toContain("match: indent-relative");
      // "    sub();" = F(6sp) + L.slice(2) = 8 spaces total.
      expect(await readFile(join(root, "i2.txt"), "utf8")).toBe("f\n      uno();\n        sub();\ng\n");
    });
    it("misses on tab-vs-space indent mix → not-found listing all five rungs", async () => {
      await writeFile(join(root, "i3.txt"), "x\n\t\tA();\n\t\tB();\ny\n", "utf8");
      const edit = createEditTool({ workspaceRoot: root });
      const res = await edit.execute({ path: "i3.txt", old_string: "    A();\n    B();", new_string: "C();" });
      expect(res.isError).toBe(true);
      expect(res.content).toContain("not found");
      for (const rung of ["exact", "quote-normalized", "blank-line-relaxed", "whitespace-tolerant", "indent-relative"]) {
        expect(res.content).toContain(rung);
      }
      expect(await readFile(join(root, "i3.txt"), "utf8")).toBe("x\n\t\tA();\n\t\tB();\ny\n");
    });
    it("misses on interior blank-line count mismatch → not-found", async () => {
      // Needle has two interior blank lines; the file has one — the 1:1
      // correspondence fails, so the rung conservatively declines.
      await writeFile(join(root, "i4.txt"), "x\nA();\n\nB();\ny\n", "utf8");
      const edit = createEditTool({ workspaceRoot: root });
      const res = await edit.execute({ path: "i4.txt", old_string: "A();\n\n\nB();", new_string: "C();" });
      expect(res.isError).toBe(true);
      expect(res.content).toContain("not found");
    });
    it("2 hits after blank-line + indent normalization → ambiguity error", async () => {
      // Same block at two different indents: both windows match after the
      // per-line strip → unique-hit iron law rejects.
      await writeFile(join(root, "i5.txt"), "a\n    A();\n    B();\nb\n        A();\n        B();\nc\n", "utf8");
      const edit = createEditTool({ workspaceRoot: root });
      const res = await edit.execute({ path: "i5.txt", old_string: "A();\nB();", new_string: "C();" });
      expect(res.isError).toBe(true);
      expect(res.content).toContain("not unique");
      expect(res.content).toContain("indent-relative");
      expect(res.content).toContain("2 matches");
      expect(await readFile(join(root, "i5.txt"), "utf8")).toBe("a\n    A();\n    B();\nb\n        A();\n        B();\nc\n");
    });
    it("replace_all=true skips the indent rung → explicit error, no silent mass replace", async () => {
      await writeFile(join(root, "i6.txt"), "x\n\t\tA();\n\t\tB();\ny\n", "utf8");
      const edit = createEditTool({ workspaceRoot: root });
      const res = await edit.execute({ path: "i6.txt", old_string: "    A();\n    B();", new_string: "C();", replace_all: true });
      expect(res.isError).toBe(true);
      expect(res.content).toContain("not found");
      expect(await readFile(join(root, "i6.txt"), "utf8")).toBe("x\n\t\tA();\n\t\tB();\ny\n");
    });
    it("conservative bail: a new_string line whose indent lacks the N prefix → not-found", async () => {
      // Baseline N="  "; "X();" has zero indent → shifting it would corrupt
      // the relative structure → the whole rung declines (fail-closed).
      await writeFile(join(root, "i7.txt"), "x\n      A();\n      B();\ny\n", "utf8");
      const edit = createEditTool({ workspaceRoot: root });
      const res = await edit.execute({ path: "i7.txt", old_string: "  A();\n  B();", new_string: "  A2();\nX();" });
      expect(res.isError).toBe(true);
      expect(res.content).toContain("not found");
      expect(await readFile(join(root, "i7.txt"), "utf8")).toBe("x\n      A();\n      B();\ny\n");
    });
  });

  it("success snippets carry the ±4-line numbered window", async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
    await writeFile(join(root, "s.txt"), lines.join("\n") + "\n", "utf8");
    const edit = createEditTool({ workspaceRoot: root });
    const res = await edit.execute({ path: "s.txt", old_string: "line 8", new_string: "EDITED" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("4→ line 4");
    expect(res.content).toContain("8→ EDITED");
    expect(res.content).toContain("12→ line 12");
  });
});
