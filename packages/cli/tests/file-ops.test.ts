// M74-ide Task 1 — the WS file-panel ops (fileTree/fileRead), driven through
// the REAL driver handler (createAgentDriver over a tmp workspace). Pins the
// PROTOCOL contract: dirs-first alphabetical sorting, hidden marking (dotfile
// or the hidden list — the CLIENT filters, the server just marks), lazy
// nested listings, workspace containment, the data-panel sensitive-path list
// (stricter than the agent's read_file), binary sniffing, and the 1MB/100KB
// caps. The tmpdir sits behind macOS's /var → /private/var symlink, so the
// workspace-relative projections here also verify the realpath handling.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedModel } from "@wudao/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";

const KB = 1024;

function makeDriver(workspaceRoot?: string): AgentDriver {
  return createAgentDriver({
    systemPrompt: "s",
    summarize: summarizeToolCall,
    model: createScriptedModel([]),
    tools: [],
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
  });
}

describe("M74-ide §1 fileTree (driver handler)", () => {
  let root: string;
  let driver: AgentDriver;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "wudao-fileops-"));
    driver = makeDriver(root);
  });

  afterEach(async () => {
    driver.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("root listing: dirs first alphabetically, then files alphabetically, sizes on files only", async () => {
    await mkdir(join(root, "beta"));
    await mkdir(join(root, "alpha"));
    await writeFile(join(root, "z.txt"), "zzz");
    await writeFile(join(root, "a.ts"), "hi");
    await writeFile(join(root, "m.md"), "hello");

    const { entries } = await driver.fileTree("");
    expect(entries.map((e) => e.name)).toEqual(["alpha", "beta", "a.ts", "m.md", "z.txt"]);
    expect(entries.map((e) => e.type)).toEqual(["dir", "dir", "file", "file", "file"]);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName["a.ts"]!.size).toBe(2);
    expect(byName["z.txt"]!.size).toBe(3);
    expect("size" in byName["alpha"]!).toBe(false);
  });

  it("hidden marking: dotfiles and the hidden list carry hidden:true; visible entries omit the flag", async () => {
    for (const d of [".git", "node_modules", "dist", "target", "__pycache__"]) {
      await mkdir(join(root, d));
    }
    await writeFile(join(root, ".DS_Store"), "junk");
    await writeFile(join(root, ".env"), "K=V");
    await writeFile(join(root, ".env.local"), "K=V");
    await writeFile(join(root, ".npmrc"), "registry=x");
    await writeFile(join(root, "README.md"), "r");
    await writeFile(join(root, "app.ts"), "a");

    const { entries } = await driver.fileTree("");
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    for (const name of [".git", "node_modules", "dist", "target", "__pycache__", ".DS_Store", ".env", ".env.local", ".npmrc"]) {
      expect(byName[name]?.hidden, name).toBe(true);
    }
    for (const name of ["README.md", "app.ts"]) {
      expect("hidden" in byName[name]!, name).toBe(false);
    }
  });

  it("sorting is deterministic ASCII code-unit order (uppercase before lowercase)", async () => {
    await mkdir(join(root, "Beta"));
    await mkdir(join(root, "alpha"));
    await writeFile(join(root, "Z.txt"), "z");
    await writeFile(join(root, "a.txt"), "a");

    const { entries } = await driver.fileTree("");
    expect(entries.map((e) => e.name)).toEqual(["Beta", "alpha", "Z.txt", "a.txt"]);
  });

  it("nested listing: a subdirectory's own entries (the lazy expand)", async () => {
    await mkdir(join(root, "src", "util"), { recursive: true });
    await writeFile(join(root, "src", "main.ts"), "m");
    await writeFile(join(root, "src", "util", "u.ts"), "u");

    const { entries } = await driver.fileTree("src");
    expect(entries.map((e) => e.name)).toEqual(["util", "main.ts"]);
    const nested = await driver.fileTree("src/util");
    expect(nested.entries.map((e) => e.name)).toEqual(["u.ts"]);
  });

  it("sensitive directories list as empty (spec §5: fileTree answers them with no entries)", async () => {
    await mkdir(join(root, ".git", "objects"), { recursive: true });
    await mkdir(join(root, "deploy", ".ssh"), { recursive: true });

    await expect(driver.fileTree(".git")).resolves.toEqual({ entries: [] });
    await expect(driver.fileTree("deploy/.ssh")).resolves.toEqual({ entries: [] });
  });

  it("path escape rejected", async () => {
    await expect(driver.fileTree("../outside")).rejects.toThrow(/path escapes workspace/);
  });

  it("missing directory and file-as-directory reject with an op error", async () => {
    await expect(driver.fileTree("nope")).rejects.toThrow(/no such directory/);
    await writeFile(join(root, "f.txt"), "x");
    await expect(driver.fileTree("f.txt")).rejects.toThrow(/not a directory/);
  });

  // workspace-ux B1 flipped the no-root case: panelRoot falls back to cwd, so
  // the panel always has SOMETHING to list (the old sessions()-precedent empty
  // reply is gone); containment is judged from that same fallback root.
  it("no workspace root: the panel falls back to cwd — a listing, and escapes reject from there", async () => {
    const bare = makeDriver();
    const r = await bare.fileTree("");
    expect(Array.isArray(r.entries)).toBe(true);
    await expect(bare.fileRead("../escape")).rejects.toThrow(/path escapes workspace/);
    bare.dispose();
  });
});

describe("M74-ide §1 fileRead (driver handler)", () => {
  let root: string;
  let driver: AgentDriver;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "wudao-fileops-"));
    driver = makeDriver(root);
  });

  afterEach(async () => {
    driver.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("text file: content, language, line count, byte size; no truncation", async () => {
    await writeFile(join(root, "a.ts"), "line1\nline2\n");

    const r = await driver.fileRead("a.ts");
    expect(r.content).toBe("line1\nline2\n");
    expect(r.truncated).toBe(false);
    expect(r.totalBytes).toBe(12);
    expect(r.lines).toBe(2);
    expect(r.language).toBe("typescript");
    expect("binary" in r).toBe(false);
  });

  it("a final line without a trailing newline still counts; unknown extension → text", async () => {
    await writeFile(join(root, "b.txt"), "a\nb");

    const r = await driver.fileRead("b.txt");
    expect(r.lines).toBe(2);
    expect(r.language).toBe("text");
  });

  it("empty file: zero bytes, zero lines, no truncation", async () => {
    await writeFile(join(root, "empty.txt"), "");

    const r = await driver.fileRead("empty.txt");
    expect(r).toMatchObject({ content: "", truncated: false, totalBytes: 0, lines: 0 });
  });

  it("language mapping for the common extensions; unknown → text", async () => {
    const cases: Record<string, string> = {
      "x.py": "python",
      "x.md": "markdown",
      "x.json": "json",
      "x.yaml": "yaml",
      "x.css": "css",
      "x.html": "html",
      "x.sh": "shell",
      "x.rs": "rust",
      "x.go": "go",
      "x.java": "java",
      "x.c": "c",
      "x.cpp": "cpp",
      "x.h": "c",
      "x.js": "javascript",
      "x.tsx": "tsx",
      "x.jsx": "jsx",
      "x.rb": "ruby",
      "x.php": "php",
      "x.sql": "sql",
      "x.toml": "toml",
      "x.xml": "xml",
    };
    for (const [name, language] of Object.entries(cases)) {
      await writeFile(join(root, name), "c");
      expect((await driver.fileRead(name)).language, name).toBe(language);
    }
  });

  it("over 1MB: truncated=true, first 100KB content, FULL byte and line counts", async () => {
    const chunk = `${"x".repeat(1023)}\n`; // 1KB
    const big = chunk.repeat(1536); // 1.5MiB, 1536 lines
    expect(big.length).toBe(1024 * 1536);
    await writeFile(join(root, "big.txt"), big);

    const r = await driver.fileRead("big.txt");
    expect(r.truncated).toBe(true);
    expect(r.totalBytes).toBe(1024 * 1536);
    expect(r.lines).toBe(1536); // pre-truncation
    expect(r.content).toBe(chunk.repeat(100)); // exactly the first 100KB
  });

  it("exactly 1MB is not truncated", async () => {
    await writeFile(join(root, "cap.txt"), "y".repeat(KB * KB));

    const r = await driver.fileRead("cap.txt");
    expect(r.truncated).toBe(false);
    expect(r.content.length).toBe(KB * KB);
  });

  it("binary by NUL byte in the first 100 bytes (any extension)", async () => {
    await writeFile(join(root, "blob.dat"), Buffer.from([0x61, 0x62, 0x00, 0x63]));

    const r = await driver.fileRead("blob.dat");
    expect(r.binary).toBe(true);
    expect(r.content).toBe("");
    expect(r.lines).toBe(0);
  });

  it("binary by known extension even without a NUL byte", async () => {
    await writeFile(join(root, "img.png"), "not really a png");

    const r = await driver.fileRead("img.png");
    expect(r.binary).toBe(true);
    expect(r.content).toBe("");
  });

  it("a NUL past the first 100 bytes does not flag binary", async () => {
    await writeFile(join(root, "late.dat"), Buffer.concat([Buffer.alloc(120, 0x61), Buffer.from([0x00])]));

    const r = await driver.fileRead("late.dat");
    expect(r.binary).toBeUndefined();
    expect(r.content.startsWith("a")).toBe(true);
  });

  it("sensitive paths reject with 'sensitive path' (stricter than read_file)", async () => {
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git", "config"), "[core]");
    await writeFile(join(root, ".env"), "K=V");
    await writeFile(join(root, ".env.local"), "K=V");
    await mkdir(join(root, "deploy", ".ssh"), { recursive: true });
    await writeFile(join(root, "deploy", ".ssh", "id_rsa"), "KEY");
    await writeFile(join(root, "deploy", "credentials.json"), "{}");

    for (const p of [".git/config", ".env", ".env.local", "deploy/.ssh/id_rsa", "deploy/credentials.json"]) {
      await expect(driver.fileRead(p), p).rejects.toThrow(/sensitive path/);
    }
  });

  it("path escape rejected", async () => {
    await expect(driver.fileRead("../secret")).rejects.toThrow(/path escapes workspace/);
  });

  it("directory and missing file reject", async () => {
    await mkdir(join(root, "d"));
    await expect(driver.fileRead("d")).rejects.toThrow(/not a file/);
    await expect(driver.fileRead("missing.txt")).rejects.toThrow(/no such file/);
  });
});

describe("高亮/编辑 spec §3 fileWrite (driver handler)", () => {
  let root: string;
  let driver: AgentDriver;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "wudao-filewrite-"));
    driver = makeDriver(root);
  });

  afterEach(async () => {
    driver.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("disk matches base → written:true; 盘上内容验证；无 tmp 残留（原子写）", async () => {
    await writeFile(join(root, "a.ts"), "old", "utf8");
    const r = await driver.fileWrite("a.ts", "new", "old");
    expect(r).toEqual({ written: true });
    expect(await readFile(join(root, "a.ts"), "utf8")).toBe("new");
    const residue = (await readdir(root)).filter((n) => n.includes(".wudao-"));
    expect(residue).toEqual([]);
  });

  it("ENOENT + base '' → 新建文件", async () => {
    const r = await driver.fileWrite("created.txt", "hello", "");
    expect(r).toEqual({ written: true });
    expect(await readFile(join(root, "created.txt"), "utf8")).toBe("hello");
  });

  it("conflict: disk ≠ base → {conflict, current}，盘上不动", async () => {
    await writeFile(join(root, "a.ts"), "disk-truth", "utf8");
    const r = await driver.fileWrite("a.ts", "mine", "stale-base");
    expect(r).toEqual({ conflict: true, current: "disk-truth" });
    expect(await readFile(join(root, "a.ts"), "utf8")).toBe("disk-truth");
  });

  it("ENOENT + base 非空 → conflict with current ''", async () => {
    const r = await driver.fileWrite("missing.ts", "mine", "was-here");
    expect(r).toEqual({ conflict: true, current: "" });
  });

  it("path escape rejected", async () => {
    await expect(driver.fileWrite("../out.ts", "x", "")).rejects.toThrow(/escapes workspace/);
  });

  it("sensitive paths reject BEFORE existence（.env 与 .git/x 在文件不存在时也拒）", async () => {
    await expect(driver.fileWrite(".env", "x", "")).rejects.toThrow("sensitive path");
    await expect(driver.fileWrite(".git/config", "x", "")).rejects.toThrow("sensitive path");
  });

  it("content 超 1MB 拒绝，盘上不动", async () => {
    await writeFile(join(root, "a.ts"), "old", "utf8");
    const big = "x".repeat(1024 * 1024 + 1);
    await expect(driver.fileWrite("a.ts", big, "old")).rejects.toThrow(/1MB/);
    expect(await readFile(join(root, "a.ts"), "utf8")).toBe("old");
  });
});
