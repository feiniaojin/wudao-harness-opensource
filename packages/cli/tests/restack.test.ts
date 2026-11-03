// 借鉴弧 ζ2（Amp "Restack Your Changes" 思想，digest-c C4）——归因驱动的
// 改动重组提交。钉四面：①porcelain -z 解析（含 rename 对、untracked、已暂
// 存识别）；②归因读取（command_footprint 权威 + turn_diff_receipt 行、写者
// 契约逐字段校验）；③计划纯层（首命令序分组、最新归因 wins、未归因诚实报
// 告、陈旧归因剔除、工作区前缀拼接）；④编排（预览/apply 两态、拒绝面全家
// ——git 缺席/非仓库/无改动/已暂存/无归因、apply 的显式 add+pathspec commit、
// 失败即停、绝不 force）。
import { describe, it, expect } from "vitest";
import type { SessionEntry } from "@wudao-org/core";
import {
  parseRestackCommand,
  parseGitStatusZ,
  attributionsFromEntries,
  planRestack,
  restackCommitMessage,
  formatRestackPreview,
  runRestack,
  type RestackRunner,
  type RestackAttribution,
  type GitStatusRow,
} from "../src/restack.js";

const row = (repoPath: string, extra: Partial<GitStatusRow> = {}): GitStatusRow => ({ repoPath, staged: false, untracked: false, ...extra });
const attr = (path: string, kind: RestackAttribution["kind"] = "modified", command?: string): RestackAttribution => ({ path, kind, ...(command !== undefined ? { command } : {}) });

// ---------------------------------------------------------------------------
// ① 命令解析
// ---------------------------------------------------------------------------

describe("ζ2 parseRestackCommand", () => {
  it("裸=预览；apply=执行；前缀邻居与带参=undefined", () => {
    expect(parseRestackCommand("/restack")).toEqual({ apply: false });
    expect(parseRestackCommand("/restack apply")).toEqual({ apply: true });
    expect(parseRestackCommand("  /restack  ")).toEqual({ apply: false });
    expect(parseRestackCommand("/restackx")).toBeUndefined();
    expect(parseRestackCommand("/restack apply now")).toBeUndefined();
    expect(parseRestackCommand("/restack force")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ② porcelain -z 解析
// ---------------------------------------------------------------------------

describe("ζ2 parseGitStatusZ", () => {
  it("普通修改/新增/untracked/已暂存识别", () => {
    const out = parseGitStatusZ(" M a.ts\0?? new.ts\0M  staged.ts\0A  added.ts\0");
    expect(out).toEqual([
      row("a.ts"),
      row("new.ts", { untracked: true }),
      row("staged.ts", { staged: true }),
      row("added.ts", { staged: true }),
    ]);
  });
  it("rename 对：新路径行 + 原路径的删除半边（两个 NUL 场消费）", () => {
    const out = parseGitStatusZ("R  renamed.ts\0original.ts\0 M b.ts\0");
    expect(out).toEqual([row("original.ts"), row("renamed.ts", { staged: true }), row("b.ts")]);
  });
  it("ignored（!!）跳过；空段与非记录段跳过", () => {
    expect(parseGitStatusZ("!! secret\0\0 M a.ts\0")).toEqual([row("a.ts")]);
  });
});

// ---------------------------------------------------------------------------
// ③ 归因读取（写者契约读侧）
// ---------------------------------------------------------------------------

describe("ζ2 attributionsFromEntries", () => {
  it("command_footprint 权威（含 deleted）；turn_diff_receipt 行 merge（cmd 归命令、无 cmd 归工具组）", () => {
    const entries: SessionEntry[] = [
      {
        type: "command_footprint",
        data: { turn: 1, run: "s1", command: "pnpm build", files: [{ path: "dist/a.js", kind: "created" }, { path: "old.ts", kind: "deleted" }] },
      },
      {
        type: "turn_diff_receipt",
        data: { text: "改动 2 文件", changes: [{ path: "src/a.ts", op: "modified", writes: 2, cmd: "sed -i s/x/y/ src/a.ts" }, { path: "src/b.ts", op: "created", writes: 1 }] },
      },
    ];
    expect(attributionsFromEntries(entries)).toEqual([
      { command: "pnpm build", path: "dist/a.js", kind: "created" },
      { command: "pnpm build", path: "old.ts", kind: "deleted" },
      { command: "sed -i s/x/y/ src/a.ts", path: "src/a.ts", kind: "modified" },
      { path: "src/b.ts", kind: "created" },
    ]);
  });
  it("畸形载荷逐字段弃（写者契约纪律）：坏 command 弃条、坏行弃行、坏 kind 弃行", () => {
    const entries: SessionEntry[] = [
      { type: "command_footprint", data: { command: "", files: [{ path: "a", kind: "modified" }] } },
      { type: "command_footprint", data: { command: "ok", files: [{ path: "a", kind: "weird" }, { path: "b", kind: "modified" }, "junk"] } },
      { type: "turn_diff_receipt", data: { text: "t", changes: [{ path: "", op: "modified" }, { path: "c", op: "deleted" }, { path: "d", op: "modified", cmd: 42 }] } },
      { type: "run_stats_receipt", data: { text: "无关条目跳过" } },
    ];
    expect(attributionsFromEntries(entries)).toEqual([{ command: "ok", path: "b", kind: "modified" }]);
  });
});

// ---------------------------------------------------------------------------
// ④ 计划纯层
// ---------------------------------------------------------------------------

describe("ζ2 planRestack", () => {
  it("按首归因序分组；每文件最新归因 wins；组文件=归因 ∩ 当前未提交", () => {
    const plan = planRestack(
      [
        attr("src/a.ts", "modified", "cmd-one"),
        attr("src/b.ts", "modified", "cmd-two"),
        attr("src/a.ts", "modified", "cmd-two"), // a 的最新归因 → cmd-two
        attr("src/gone.ts", "modified", "cmd-one"), // 不在当前改动里 → stale
      ],
      [row("src/a.ts"), row("src/b.ts"), row("src/scratch.ts", { untracked: true })],
      "",
    );
    expect(plan.groups.map((g) => [g.label, g.files])).toEqual([
      ["cmd-two", ["src/a.ts", "src/b.ts"]], // cmd-one 的两个文件一个被最新归因接管、一个 stale → 空组剔除
    ]);
    expect(plan.unattributed).toEqual(["src/scratch.ts"]);
    expect(plan.staleAttributed).toEqual(["src/gone.ts"]);
  });
  it("空组剔除；工具组（无命令）殿后按首现序", () => {
    const plan = planRestack(
      [attr("t.ts"), attr("c.ts", "modified", "cmd")],
      [row("t.ts"), row("c.ts")],
      "",
    );
    expect(plan.groups.map((g) => g.label)).toEqual(["会话文件写入（write_file/edit）", "cmd"]);
  });
  it("workspaceRoot ≠ repo top 时按前缀拼接（归因 ws 相对 → porcelain repo 相对）", () => {
    const plan = planRestack(
      [attr("src/a.ts", "modified", "cmd")],
      [row("packages/app/src/a.ts")],
      "packages/app",
    );
    expect(plan.groups[0]?.files).toEqual(["src/a.ts"]);
    expect(plan.unattributed).toEqual([]);
  });
  it("同文件两归因先后（run1 工具写、run2 命令改）→ 最新归因（命令组）得文件", () => {
    const plan = planRestack(
      [attr("x.ts"), attr("x.ts", "modified", "fmt")],
      [row("x.ts")],
      "",
    );
    expect(plan.groups.map((g) => [g.label, g.files])).toEqual([["fmt", ["x.ts"]], ["会话文件写入（write_file/edit）", []]].filter(([, f]) => (f as string[]).length > 0));
  });
});

// ---------------------------------------------------------------------------
// ⑤ 提交消息与预览文案
// ---------------------------------------------------------------------------

describe("ζ2 消息与预览", () => {
  it("提交消息=归因命令+文件清单（命令组/工具组两形）", () => {
    expect(restackCommitMessage({ label: "cmd-one", command: "cmd-one", files: ["a.ts", "b.ts"] }))
      .toBe("wudao(restack): cmd-one\n\n归因命令：cmd-one\n\n文件：\n- a.ts\n- b.ts");
    expect(restackCommitMessage({ label: "会话文件写入（write_file/edit）", files: ["c.ts"] }))
      .toBe("wudao(restack): 会话文件写入（write_file/edit）\n\n归因：会话内 write_file/edit 直接写入（无 shell 命令归因）\n\n文件：\n- c.ts");
  });
  it("命令头截 60（多行命令取首行）——label 由计划层统一构造", () => {
    const plan = planRestack(
      [attr("a.ts", "modified", "x".repeat(70)), attr("b.ts", "modified", "line one\nline two")],
      [row("a.ts"), row("b.ts")],
      "",
    );
    expect(plan.groups.map((g) => g.label)).toEqual([`${"x".repeat(59)}…`, "line one"]);
  });
  it("预览带组/文件清单/未归因警告/apply 指引", () => {
    const text = formatRestackPreview({
      groups: [{ label: "fmt", command: "fmt", files: ["a.ts"] }],
      unattributed: ["scratch.ts"],
      staleAttributed: [],
    });
    expect(text).toContain("1 个提交");
    expect(text).toContain("● fmt");
    expect(text).toContain("a.ts");
    expect(text).toContain("1 个文件不在任何归因组");
    expect(text).toContain("/restack apply");
  });
});

// ---------------------------------------------------------------------------
// ⑥ 编排（脚本化 git——测试链零真 git）
// ---------------------------------------------------------------------------

/** Script the runner: map argv[0..] prefixes to canned outcomes. */
const scriptedGit = (script: Record<string, { stdout: string } | { fail: true } | undefined>): { run: RestackRunner; calls: string[][] } => {
  const calls: string[][] = [];
  const run: RestackRunner = async (args) => {
    calls.push([...args]);
    const key = args.join(" ");
    for (const [prefix, out] of Object.entries(script)) {
      if (key === prefix || key.startsWith(prefix)) {
        if (out && "fail" in out) return undefined;
        return { stdout: (out as { stdout: string }).stdout, stderr: "" };
      }
    }
    return { stdout: "", stderr: "" };
  };
  return { run, calls };
};

const ENTRIES: SessionEntry[] = [
  { type: "command_footprint", data: { turn: 1, run: "s", command: "pnpm build", files: [{ path: "dist/a.js", kind: "created" }] } },
  { type: "turn_diff_receipt", data: { text: "t", changes: [{ path: "src/a.ts", op: "modified", writes: 1 }] } },
];

describe("ζ2 runRestack（编排与拒绝面）", () => {
  const deps = (run: RestackRunner, entries: readonly SessionEntry[] = ENTRIES) => ({ cwd: "/ws", run, loadEntries: async () => entries });

  it("非仓库/无改动/已暂存/无归因——四拒绝面零 git 写操作", async () => {
    const nonRepo = scriptedGit({ "rev-parse --show-toplevel": { fail: true } });
    expect(await runRestack("preview", deps(nonRepo.run))).toContain("不是 git 仓库");
    const empty = scriptedGit({ "rev-parse --show-toplevel": { stdout: "/ws\n" }, "status --porcelain -z": { stdout: "" } });
    expect(await runRestack("preview", deps(empty.run))).toContain("没有未提交的改动");
    const staged = scriptedGit({ "rev-parse --show-toplevel": { stdout: "/ws\n" }, "status --porcelain -z": { stdout: "M  staged.ts\0 M a.ts\0" } });
    const stagedText = await runRestack("preview", deps(staged.run));
    expect(stagedText).toContain("已暂存");
    expect(staged.calls.some((c) => c[0] === "add" || c[0] === "commit")).toBe(false);
    const noAttr = scriptedGit({ "rev-parse --show-toplevel": { stdout: "/ws\n" }, "status --porcelain -z": { stdout: " M src/a.ts\0" } });
    expect(await runRestack("preview", deps(noAttr.run, []))).toContain("没有改动归因数据");
  });
  it("预览：分组/文件/未归因可见，零 git 写操作", async () => {
    const { run, calls } = scriptedGit({
      "rev-parse --show-toplevel": { stdout: "/ws\n" },
      "status --porcelain -z": { stdout: " M dist/a.js\0 M src/a.ts\0?? scratch\0" },
    });
    const text = await runRestack("preview", deps(run));
    expect(text).toContain("2 个提交");
    expect(text).toContain("● pnpm build");
    expect(text).toContain("src/a.ts");
    expect(text).toContain("1 个文件不在任何归因组");
    expect(calls.some((c) => c[0] === "add" || c[0] === "commit")).toBe(false);
  });
  it("apply：每组显式 add（-- 分隔）+ commit 带 pathspec（--only 语义）；未归因零触碰", async () => {
    const { run, calls } = scriptedGit({
      "rev-parse --show-toplevel": { stdout: "/ws\n" },
      "status --porcelain -z": { stdout: " M dist/a.js\0 M src/a.ts\0?? scratch\0" },
    });
    const text = await runRestack("apply", deps(run));
    expect(text).toContain("2 个提交");
    expect(text).toContain("✔");
    expect(text).toContain("1 个未归因文件保持未提交");
    const adds = calls.filter((c) => c[0] === "add");
    expect(adds).toEqual([["add", "--", "dist/a.js"], ["add", "--", "src/a.ts"]]);
    const commits = calls.filter((c) => c[0] === "commit");
    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual(["commit", "-m", "wudao(restack): pnpm build\n\n归因命令：pnpm build\n\n文件：\n- dist/a.js", "--", "dist/a.js"]);
    expect(commits[1]?.slice(0, 2)).toEqual(["commit", "-m"]);
    expect(commits[1]?.at(-1)).toBe("src/a.ts");
    expect(calls.some((c) => c.includes("scratch"))).toBe(false);
    expect(calls.some((c) => c.includes("--force") || c[0] === "push")).toBe(false);
  });
  it("apply 中途失败即停即报（后续组不动），绝不 force", async () => {
    const { run, calls } = scriptedGit({
      "rev-parse --show-toplevel": { stdout: "/ws\n" },
      "status --porcelain -z": { stdout: " M dist/a.js\0 M src/a.ts\0" },
      "add -- dist/a.js": { stdout: "" },
      "commit -m wudao(restack): pnpm build": { fail: true },
    });
    const text = await runRestack("apply", deps(run));
    expect(text).toContain("中止");
    expect(text).toContain("git commit 失败");
    expect(calls.filter((c) => c[0] === "commit")).toHaveLength(1); // 第一组失败即停
    expect(calls.some((c) => c.includes("src/a.ts"))).toBe(false); // 第二组零触碰
  });
});
