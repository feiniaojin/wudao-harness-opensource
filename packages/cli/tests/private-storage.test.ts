// ω99-2b — 私有存储原语：目录级 0700（只收紧新建组件，the upstream project was_missing
// 语义）、父链目录链接拒绝（不把子目录建进链接目标）、tmp+rename+chmod 的
// 0600 修复语义、harden 遍历边界（不跟链接），以及 Windows icacls 编排
// （platform 注入 "win32" + 假 runner 收集调用 —— 开发机是 macOS，绝不真跑
// icacls / whoami）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  UnsafePrivatePathError,
  ensurePrivateDirectory,
  hardenPrivateTree,
  writePrivateFile,
  writePrivateFileSync,
  type WindowsAclRunner,
} from "../src/private-storage.js";

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "wudao-priv-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const modeOf = (p: string): string => (statSync(p).mode & 0o777).toString(8);
// 0700/0600 是 POSIX 可观测契约（win32 无强制 mode 位——0666 恒读）；代码
// 路径全平台跑，八进制断言只在可观测处。
const modeLeg = process.platform !== "win32";

// ---------------------------------------------------------------------------
// 1. ensurePrivateDirectory — 目录级 0700
// ---------------------------------------------------------------------------
describe("ensurePrivateDirectory — 目录级 0700", () => {
  it("新建链的每个中间目录与目标都是 0700，并原样返回 dir", () => {
    const dir = join(base, "x", "y", "z");
    expect(ensurePrivateDirectory(dir)).toBe(dir);
    if (modeLeg) {
      expect(modeOf(join(base, "x"))).toBe("700");
      expect(modeOf(join(base, "x", "y"))).toBe("700");
      expect(modeOf(dir)).toBe("700");
    }
  });

  it("已存在目录不收紧（0755 原样）；force 才收紧到 0700（was_missing 语义）", () => {
    const dir = join(base, "legacy");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    ensurePrivateDirectory(dir);
    if (modeLeg) expect(modeOf(dir)).toBe("755");
    ensurePrivateDirectory(dir, { force: true });
    if (modeLeg) expect(modeOf(dir)).toBe("700");
  });
});

// ---------------------------------------------------------------------------
// 2. 目录链接拒绝 —— `~/.wudao` 被指向攻击者目录是本弧的核心威胁
// ---------------------------------------------------------------------------
describe("目录链接拒绝", () => {
  it("父链上的 symlink → UnsafePrivatePathError（消息含该路径），且不把子目录建进链接目标", () => {
    const a = join(base, "a");
    const b = join(base, "b");
    mkdirSync(a);
    symlinkSync(a, b); // b → a（真目录）
    expect(() => ensurePrivateDirectory(join(b, "c"))).toThrow(UnsafePrivatePathError);
    expect(() => ensurePrivateDirectory(join(b, "c"))).toThrow(/b/);
    expect(existsSync(join(a, "c"))).toBe(false); // 拒绝发生在任何 mkdir 之前
  });

  it("目标自身是 symlink 同样拒绝", () => {
    const a = join(base, "a");
    const b = join(base, "b");
    mkdirSync(a);
    symlinkSync(a, b);
    expect(() => ensurePrivateDirectory(b)).toThrow(UnsafePrivatePathError);
  });
});

// ---------------------------------------------------------------------------
// 3. writePrivateFile — 0600 落盘 + 修复语义 + 父目录 0700
// ---------------------------------------------------------------------------
describe("writePrivateFile", () => {
  it("async：内容落盘、文件 0600、新建父目录 0700", async () => {
    const path = join(base, "w", "creds.json");
    await writePrivateFile(path, "hello\n");
    expect(readFileSync(path, "utf8")).toBe("hello\n");
    if (modeLeg) {
      expect(modeOf(path)).toBe("600");
      expect(modeOf(dirname(path))).toBe("700");
    }
  });

  it("预 loosened 0644 的旧文件被覆写后回 0600（rename + chmod 修复语义保留）", async () => {
    const path = join(base, "f2.json");
    await writePrivateFile(path, "one");
    chmodSync(path, 0o644);
    if (modeLeg) expect(modeOf(path)).toBe("644");
    await writePrivateFile(path, "two");
    expect(readFileSync(path, "utf8")).toBe("two");
    if (modeLeg) expect(modeOf(path)).toBe("600");
  });

  it("sync 孪生同契约", () => {
    const path = join(base, "w-sync", "creds.json");
    writePrivateFileSync(path, "sync\n");
    expect(readFileSync(path, "utf8")).toBe("sync\n");
    if (modeLeg) {
      expect(modeOf(path)).toBe("600");
      expect(modeOf(dirname(path))).toBe("700");
    }
  });

  it("最终 path 是 symlink 时 rename 替换链接本身（不 throw、不写穿目标）", async () => {
    const victim = join(base, "elsewhere.txt");
    writeFileSync(victim, "victim", { mode: 0o644 });
    const path = join(base, "creds.json");
    symlinkSync(victim, path);
    await writePrivateFile(path, "mine");
    expect(readFileSync(path, "utf8")).toBe("mine"); // path 已是常规文件
    expect(readFileSync(victim, "utf8")).toBe("victim"); // 链接目标未被写穿
    expect(statSync(path).isSymbolicLink()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. hardenPrivateTree — 遍历边界（不跟链接）+ 遗留树修复计数
// ---------------------------------------------------------------------------
describe("hardenPrivateTree", () => {
  it("真目录→0700、真文件→0600；symlink（文件与目录）原样未动；计数正确", () => {
    const root = join(base, "tree");
    mkdirSync(root, { mode: 0o755 });
    chmodSync(root, 0o755);
    writeFileSync(join(root, "f1"), "x", { mode: 0o644 });
    chmodSync(join(root, "f1"), 0o644);
    mkdirSync(join(root, "sub"), { mode: 0o755 });
    chmodSync(join(root, "sub"), 0o755);
    writeFileSync(join(root, "sub", "f2"), "y", { mode: 0o644 });
    chmodSync(join(root, "sub", "f2"), 0o644);
    const outsideFile = join(base, "outside.txt");
    writeFileSync(outsideFile, "z", { mode: 0o644 });
    chmodSync(outsideFile, 0o644);
    const outsideDir = join(base, "outside-dir");
    mkdirSync(outsideDir, { mode: 0o755 });
    chmodSync(outsideDir, 0o755);
    symlinkSync(outsideFile, join(root, "link-file"));
    symlinkSync(outsideDir, join(root, "link-dir"));

    const counts = hardenPrivateTree(root);

    if (modeLeg) {
      expect(modeOf(root)).toBe("700");
      expect(modeOf(join(root, "sub"))).toBe("700");
      expect(modeOf(join(root, "f1"))).toBe("600");
      expect(modeOf(join(root, "sub", "f2"))).toBe("600");
      // 链接目标不在收紧面（遍历边界）。
      expect(modeOf(outsideFile)).toBe("644");
      expect(modeOf(outsideDir)).toBe("755");
    }
    expect(counts).toEqual({ dirs: 2, files: 2, links: 2 });
  });
});

// ---------------------------------------------------------------------------
// 5. Windows icacls 编排 —— DI 假 runner，绝不真跑 icacls / whoami
// ---------------------------------------------------------------------------
describe("Windows icacls 编排（platform 注入 + 假 runner）", () => {
  const ICACLS = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
  interface Call {
    cmd: string;
    args: readonly string[];
  }
  /** 记录每次调用；results 按调用序给定返回值（缺省 true）。 */
  const fakeRunner = (calls: Call[], results: readonly boolean[] = []): WindowsAclRunner => ({
    run: (cmd, args) => {
      calls.push({ cmd, args });
      return Promise.resolve(results[calls.length - 1] ?? true);
    },
  });
  const grantSpecs = (calls: readonly Call[]): readonly string[] =>
    calls.filter((c) => c.args.includes("/grant:r")).map((c) => c.args[c.args.length - 1] ?? "");

  it("目录 grant 带 (OI)(CI)F、文件 grant 不带；单路径内顺序 grant → inheritance:r → remove", async () => {
    const calls: Call[] = [];
    const path = join(base, "w-dir", "creds.json"); // 父目录新建 → 目录 + 文件两条 ACL 路径
    await writePrivateFile(path, "k\n", { platform: "win32", winRunner: fakeRunner(calls) });
    expect(calls.length).toBeGreaterThan(0);
    // 全部命令都直连 System32 icacls（不查 PATH）；也反证 whoami 没进 runner。
    expect(calls.every((c) => c.cmd === ICACLS)).toBe(true);
    const g = grantSpecs(calls);
    expect(g.some((x) => /:\(OI\)\(CI\)F$/.test(x))).toBe(true); // 目录
    expect(g.some((x) => /:F$/.test(x) && !x.includes("(OI)"))).toBe(true); // 文件
    // 文件那条路径的三步顺序与 remove 的三个宽泛 SID（一条命令）。
    const fileCalls = calls.filter((c) => c.args[0] === path);
    expect(fileCalls.map((c) => c.args[1])).toEqual(["/grant:r", "/inheritance:r", "/remove"]);
    expect(fileCalls[2]?.args.slice(2)).toEqual(["*S-1-1-0", "*S-1-5-11", "*S-1-5-32-545"]);
  });

  it("grant 失败 → 该路径后续不再调用（fail-safe：继承 ACL 原样保留）", async () => {
    const calls: Call[] = [];
    mkdirSync(join(base, "pre")); // 父已存在且未 force → 只有文件一条 ACL 路径
    await writePrivateFile(join(base, "pre", "f"), "k", { platform: "win32", winRunner: fakeRunner(calls, [false]) });
    expect(calls.length).toBe(1);
    expect(calls[0]?.args[1]).toBe("/grant:r");
  });

  it("inheritance 失败 → remove 仍尝试（best-effort，3 个 SID 一条命令）", async () => {
    const calls: Call[] = [];
    mkdirSync(join(base, "pre2"));
    await writePrivateFile(join(base, "pre2", "f"), "k", { platform: "win32", winRunner: fakeRunner(calls, [true, false]) });
    expect(calls.length).toBe(3);
    expect(calls[2]?.args[1]).toBe("/remove");
    expect(calls[2]?.args.slice(2)).toEqual(["*S-1-1-0", "*S-1-5-11", "*S-1-5-32-545"]);
  });
});
