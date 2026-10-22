// M46 §1 — write-verify feedback loop: the checker matrix (good/bad file ×
// extension), error-line shape (file:line: message), the not-isError
// semantics, skip paths (missing binary / timeout / gated tsc / unknown
// extension), and the no-config byte-equivalence pin (absent writeVerify →
// the exact pre-M46 result).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createWriteFileTool } from "../src/tools/write-file.js";
import { createEditTool } from "../src/tools/edit.js";
import {
  verifyWrittenFile,
  writeVerifyMarker,
  shapeVerifiedResult,
  MAX_VERIFY_ERRORS,
  type WriteVerifyConfig,
  type WriteVerifyOutcome,
} from "../src/tools/write-verify.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "wv-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

// The matrix cases assert CHECKER SEMANTICS, not the default budget — and
// spawn wall-clock on a loaded dev machine swings past 500ms (fork latency,
// not python). The budget itself has its own deterministic test below
// (FAKE_SLOW_SH + budgetMs: 100), so the matrix runs with a generous one.
const ON: WriteVerifyConfig = { enabled: true, tsTsc: false, budgetMs: 5_000 };
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// win32: the .bin tsc shim is a .CMD execFile cannot spawn, and .sh fixtures
// have no interpreter — address both in the two-word `node <entry>` form the
// bins options accept there (splitJsBin). posix keeps the executable
// spellings (the .bin shell shim + the 755 .sh twin): a bare tsc.js has no
// shebang and the .mjs twin no exec bit, so the probe would report "not
// found" (the win32 arc's darwin miss, caught by the 0.3.12 full matrix).
const REPO_TSC = process.platform === "win32"
  ? `${process.execPath} ${join(REPO_ROOT, "node_modules", "typescript", "lib", "tsc.js")}`
  : join(REPO_ROOT, "node_modules", ".bin", "tsc");
const FAKE_SLOW_SH = process.platform === "win32"
  ? `${process.execPath} ${join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-slow-sh.mjs")}`
  : join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-slow-sh.sh");

describe("write-verify: verifier matrix", () => {
  it("passes valid JSON in-process", async () => {
    const file = join(root, "ok.json");
    await writeFile(file, `{"a": 1}`, "utf8");
    const out = await verifyWrittenFile({ absPath: file, content: `{"a": 1}`, workspaceRoot: root, config: ON });
    expect(out).toEqual({ status: "pass", checker: "json" });
  });
  it("fails bad JSON with a file:line: message line", async () => {
    const file = join(root, "bad.json");
    const content = `{\n  "a": 1,\n}`;
    await writeFile(file, content, "utf8");
    const out = await verifyWrittenFile({ absPath: file, content, workspaceRoot: root, config: ON });
    expect(out.status).toBe("fail");
    if (out.status !== "fail") return;
    expect(out.checker).toBe("json");
    expect(out.errors.length).toBe(1);
    // Line 3 is where the stray `}` sits; the path is workspace-relative.
    expect(out.errors[0]).toMatch(/^bad\.json:3: /);
  });
  it("passes good .js through node --check and parses its failure shape", async () => {
    const good = join(root, "ok.js");
    await writeFile(good, "function f() { return 1; }\n", "utf8");
    expect(await verifyWrittenFile({ absPath: good, content: "", workspaceRoot: root, config: ON }))
      .toEqual({ status: "pass", checker: "node --check" });

    const bad = join(root, "bad.js");
    await writeFile(bad, "const x = {\n", "utf8");
    const out = await verifyWrittenFile({ absPath: bad, content: "", workspaceRoot: root, config: ON });
    expect(out.status).toBe("fail");
    if (out.status !== "fail") return;
    expect(out.checker).toBe("node --check");
    expect(out.errors[0]).toMatch(/^bad\.js:2: SyntaxError: /);
  });
  it("checks .mjs/.cjs via the same node lane", async () => {
    const mjs = join(root, "bad.mjs");
    await writeFile(mjs, "import x from ;\n", "utf8");
    const out = await verifyWrittenFile({ absPath: mjs, content: "", workspaceRoot: root, config: ON });
    expect(out.status).toBe("fail");
    if (out.status === "fail") expect(out.checker).toBe("node --check");
  });
  it("silently skips .ts when tsTsc is off (the default)", async () => {
    const file = join(root, "bad.ts");
    await writeFile(file, "let x: string = 42\n", "utf8");
    const out = await verifyWrittenFile({ absPath: file, content: "", workspaceRoot: root, config: ON });
    expect(writeVerifyMarker(out)).toBe("");
  });
  it("runs tsc for .ts when opted in and normalizes its diagnostics", async () => {
    const file = join(root, "bad.ts");
    await writeFile(file, "let x: string = 42\nconst y: number = \"s\"\n", "utf8");
    const out = await verifyWrittenFile({
      absPath: file,
      content: "",
      workspaceRoot: root,
      config: { enabled: true, tsTsc: true, tscBudgetMs: 120_000, bins: { tsc: REPO_TSC } },
    });
    expect(out.status).toBe("fail");
    if (out.status !== "fail") return;
    expect(out.checker).toBe("tsc");
    expect(out.errors[0]).toBe('bad.ts:1: error TS2322: Type \'number\' is not assignable to type \'string\'.');
    expect(out.errors[1]).toBe('bad.ts:2: error TS2322: Type \'string\' is not assignable to type \'number\'.');
  }, 60_000);
  it("passes a clean .ts under the same opt-in", async () => {
    const file = join(root, "ok.ts");
    await writeFile(file, 'const x: string = "ok";\n', "utf8");
    const out = await verifyWrittenFile({
      absPath: file,
      content: "",
      workspaceRoot: root,
      config: { enabled: true, tsTsc: true, tscBudgetMs: 120_000, bins: { tsc: REPO_TSC } },
    });
    expect(out).toEqual({ status: "pass", checker: "tsc" });
  }, 60_000);
  it("checks .py via py_compile, parses the File/line shape, and keeps __pycache__ out of the workspace", async () => {
    const good = join(root, "ok.py");
    await writeFile(good, "x = [1, 2]\n", "utf8");
    expect(await verifyWrittenFile({ absPath: good, content: "", workspaceRoot: root, config: ON }))
      .toEqual({ status: "pass", checker: "py_compile" });

    const bad = join(root, "bad.py");
    await writeFile(bad, "x = [1,\n", "utf8");
    const out = await verifyWrittenFile({ absPath: bad, content: "", workspaceRoot: root, config: ON });
    expect(out.status).toBe("fail");
    if (out.status !== "fail") return;
    expect(out.errors[0]).toMatch(/^bad\.py:1: SyntaxError: /);
    // The compile cache mirrors into a tmp tree — never next to the source.
    expect(await readdir(root)).not.toContain("__pycache__");
  });
  it("checks .sh via sh -n and parses its line diagnostics", async () => {
    const good = join(root, "ok.sh");
    await writeFile(good, "for i in 1 2; do echo $i; done\n", "utf8");
    expect(await verifyWrittenFile({ absPath: good, content: "", workspaceRoot: root, config: ON }))
      .toEqual({ status: "pass", checker: "sh -n" });

    const bad = join(root, "bad.sh");
    await writeFile(bad, "for i in range(\n", "utf8");
    const out = await verifyWrittenFile({ absPath: bad, content: "", workspaceRoot: root, config: ON });
    expect(out.status).toBe("fail");
    if (out.status !== "fail") return;
    expect(out.errors[0]).toMatch(/bad\.sh:1:.*[Ss]yntax [Ee]rror/);
  });
  it("silently skips unknown extensions and the enabled:false switch", async () => {
    const file = join(root, "note.md");
    await writeFile(file, "just prose\n", "utf8");
    expect(writeVerifyMarker(await verifyWrittenFile({ absPath: file, content: "", workspaceRoot: root, config: ON }))).toBe("");
    expect(writeVerifyMarker(
      await verifyWrittenFile({ absPath: file, content: "", workspaceRoot: root, config: { enabled: false, tsTsc: false } }),
    )).toBe("");
  });
  it("skips with a note when the checker binary is missing", async () => {
    const file = join(root, "bad.py");
    await writeFile(file, "x = [1,\n", "utf8");
    const out = await verifyWrittenFile({
      absPath: file,
      content: "",
      workspaceRoot: root,
      config: { enabled: true, tsTsc: false, bins: { python3: "/nonexistent/wudao-python3" } },
    });
    expect(writeVerifyMarker(out)).toBe("[verify skipped: py_compile not found]");
  });
  it("skips with a note when the checker overruns its budget", async () => {
    const file = join(root, "ok.sh");
    await writeFile(file, "echo hi\n", "utf8");
    const out = await verifyWrittenFile({
      absPath: file,
      content: "",
      workspaceRoot: root,
      config: { enabled: true, tsTsc: false, budgetMs: 100, bins: { sh: FAKE_SLOW_SH } },
    });
    expect(writeVerifyMarker(out)).toBe("[verify skipped: sh -n timed out after 100ms]");
  });
});

describe("write-verify: receipts and shaping", () => {
  it("renders pass / fail / skip markers deterministically", () => {
    expect(writeVerifyMarker({ status: "pass", checker: "json" })).toBe("[verified: json ok]");
    expect(writeVerifyMarker({ status: "fail", checker: "tsc", errors: ["a:1: x"] })).toBe("[verified: tsc 1 error]");
    expect(writeVerifyMarker({ status: "fail", checker: "tsc", errors: ["a:1: x", "a:2: y"] })).toBe("[verified: tsc 2 errors]");
    expect(writeVerifyMarker({ status: "skip", checker: "py_compile" })).toBe("");
    expect(writeVerifyMarker({ status: "skip", checker: "py_compile", note: "py_compile not found" }))
      .toBe("[verify skipped: py_compile not found]");
  });
  it("leads with the error list on failure and appends the marker on pass", () => {
    const fail: WriteVerifyOutcome = { status: "fail", checker: "json", errors: ["a.json:3: boom"] };
    expect(shapeVerifiedResult("wrote a.json", fail)).toBe("a.json:3: boom\n[verified: json 1 error]\nwrote a.json");
    expect(shapeVerifiedResult("wrote a.json", { status: "pass", checker: "json" })).toBe("wrote a.json\n[verified: json ok]");
    expect(shapeVerifiedResult("wrote a.json", { status: "skip", checker: "none" })).toBe("wrote a.json");
  });
  it("caps structured error lines at MAX_VERIFY_ERRORS", () => {
    const many = Array.from({ length: 40 }, (_, i) => `a.ts:${i + 1}: boom ${i}`);
    const shaped = shapeVerifiedResult("wrote a.ts", { status: "fail", checker: "tsc", errors: many });
    const lines = shaped.split("\n");
    expect(lines.length).toBe(MAX_VERIFY_ERRORS + 2); // capped 10 errors + receipt + base
    expect(lines[10]).toBe("[verified: tsc 40 errors]");
  });
});

describe("write-verify: write_file integration", () => {
  it("keeps the pre-M46 byte-exact result when no config is injected", async () => {
    const tool = createWriteFileTool({ workspaceRoot: root });
    const res = await tool.execute({ path: "plain.json", content: "{ bad" });
    expect(res.content).toBe("wrote plain.json");
    expect(res.isError).toBeFalsy();
  });
  it("appends the pass receipt after a good write", async () => {
    const tool = createWriteFileTool({ workspaceRoot: root, writeVerify: ON });
    const res = await tool.execute({ path: "good.json", content: `{"a": 1}` });
    expect(res.content).toBe("wrote good.json\n[verified: json ok]");
    expect(res.isError).toBeFalsy();
  });
  it("feeds back structured error lines WITHOUT isError on a bad write", async () => {
    const tool = createWriteFileTool({ workspaceRoot: root, writeVerify: ON });
    const res = await tool.execute({ path: "broken.json", content: "{\n  \"a\": 1,\n}" });
    expect(res.isError).toBeFalsy();
    const lines = res.content.split("\n");
    expect(lines[0]).toMatch(/^broken\.json:3: /);
    expect(lines[1]).toBe("[verified: json 1 error]");
    expect(lines[2]).toBe("wrote broken.json");
    // The file still landed — feedback, not veto.
    expect(await readFile(join(root, "broken.json"), "utf8")).toBe("{\n  \"a\": 1,\n}");
  });
});

describe("write-verify: edit integration", () => {
  it("verifies the post-edit bytes and keeps the snippet intact", async () => {
    await writeFile(join(root, "script.js"), "function f() {\n  return 1;\n}\n", "utf8");
    const tool = createEditTool({ workspaceRoot: root, writeVerify: ON });
    const res = await tool.execute({ path: "script.js", old_string: "return 1;", new_string: "return {" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("edited script.js (match: exact)");
    expect(res.content.split("\n")[0]).toMatch(/^script\.js:\d+: SyntaxError: /);
    expect(res.content).toContain("[verified: node --check 1 error]");
  });
  it("leaves edit results untouched without config", async () => {
    await writeFile(join(root, "script.js"), "function f() {\n  return 1;\n}\n", "utf8");
    const tool = createEditTool({ workspaceRoot: root });
    const res = await tool.execute({ path: "script.js", old_string: "return 1;", new_string: "return 2;" });
    expect(res.content.startsWith("edited script.js (match: exact)")).toBe(true);
    expect(res.content).not.toContain("[verified");
  });
});
