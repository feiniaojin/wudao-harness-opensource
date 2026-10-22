// ω99-179: constitution.ts 全命令面中文化的 receipts 测试（先红后绿）。
// 镜像 constitution.test.ts 的 fixture 形（WUDAO_GLOBAL_HOME 沙箱 = 临时 HOME），
// 四组十二 it 逐字钉 brief §一 的 18 面新串：A USAGE 块 / B 回执 / C show / D status。
// token 裁定：digest、sha256:、/constitution、approve/reject、constitution_suggest、
// prompt、~/.wudao/constitution.md 一律保留英文 token（:348 存活钉 /digest/i 的依据）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendPendingSuggestion,
  approvePendingClause,
  constitutionPaths,
  sha256Hex,
} from "../src/constitution/store.js";
import { runConstitutionCommand } from "../src/commands/constitution.js";

let home: string;
const env = (): NodeJS.ProcessEnv => ({ WUDAO_GLOBAL_HOME: home });
const paths = (): { active: string; pendingDir: string; manifest: string } => constitutionPaths(env());
const run = (args: string): Promise<string> => runConstitutionCommand({ args, env: env() });

let savedHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "wudao-omega99-179-"));
  savedHome = process.env.WUDAO_GLOBAL_HOME;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.WUDAO_GLOBAL_HOME;
  else process.env.WUDAO_GLOBAL_HOME = savedHome;
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("ω99-179 A — USAGE 块（junk args → usage，5 面逐串含对齐空格）", () => {
  it("A1: #1/#2 命令列对齐空格原样（16sp/11sp）+ 中文描述段", async () => {
    const text = await run("wat");
    expect(text).toContain("  /constitution                状态（生效 digest、条款数、待审建议）");
    expect(text).toContain("  /constitution show           查看生效宪章的完整内容");
  });

  it("A2: #3/#4 approve·reject 描述段 + #5 尾行（constitution_suggest token 保留）", async () => {
    const text = await run("wat");
    expect(text).toContain("  /constitution approve <n>    批准第 n 条待审建议（原子写入 + 清单 digest）");
    expect(text).toContain("  /constitution reject <n>     丢弃第 n 条待审建议");
    expect(text).toContain("（模型只能经 constitution_suggest 建议；批准的条款在下一次会话启动时装入 prompt）");
  });
});

describe("ω99-179 B — approve/reject 回执", () => {
  it("B1: approve 成功两行（#6 digest 行 + #7 重启行，分行断）", async () => {
    appendPendingSuggestion("Clause A", env());
    const text = await run("approve 1");
    const lines = text.split("\n");
    const digest = sha256Hex(await readFile(paths().active, "utf8"));
    expect(lines[0]).toBe(`✅ 宪章条款已批准——当前生效 1 条，digest sha256:${digest.slice(0, 12)}…`);
    expect(lines[1]).toBe("prompt 段在会话内冻结（前缀缓存）：重启会话后装入修订的宪章");
  });

  it("B2: reject 成功（#8 整句 toBe）", async () => {
    appendPendingSuggestion("one", env());
    appendPendingSuggestion("two", env());
    const text = await run("reject 1");
    expect(text).toBe("已丢弃待审建议 1——收件箱还剩 1 条");
  });

  it("B3: 越界失败形（#9 —— `失败：` 与命令词 reject 原样，store 层错误文案零触）", async () => {
    const text = await run("reject 99");
    expect(text).toContain("⚠️ /constitution reject 失败：");
    expect(text).toContain("no pending");
  });
});

describe("ω99-179 C — show 分支", () => {
  it("C1: 无 active（#10 整句）", async () => {
    const text = await run("show");
    expect(text).toBe("尚无生效宪章（~/.wudao/constitution.md 不存在）——请先批准一条待审建议");
  });

  it("C2: 正常 show（#12 头行 + 正文内容）", async () => {
    appendPendingSuggestion("Clause A", env());
    approvePendingClause(1, env());
    const text = await run("show");
    const digest = sha256Hex(await readFile(paths().active, "utf8"));
    expect(text.split("\n")[0]).toBe(`生效宪章——digest sha256:${digest.slice(0, 12)}… · 共 1 条`);
    expect(text).toContain("Clause A");
  });

  it("C3: stale show（approve 后手改 active 文件 → #11 头行）", async () => {
    appendPendingSuggestion("Clause A", env());
    approvePendingClause(1, env());
    await writeFile(paths().active, "hand-edited", "utf8");
    const text = await run("show");
    expect(text.split("\n")[0]).toBe("⚠️ 已过期——constitution.md 与批准时的 digest 不符（在 /constitution 之外编辑过？）；未装入 prompt");
    expect(text).toContain("hand-edited");
  });
});

describe("ω99-179 D — bare status 分支", () => {
  it("D1: empty store（#13 头行 + #17 待审 0 行）", async () => {
    const text = await run("");
    expect(text.split("\n")[0]).toBe("宪章：暂无生效条款（~/.wudao/constitution.md 不存在）");
    expect(text).toContain("待审建议（0 条）：无——模型经 constitution_suggest 排队条款");
  });

  it("D2: active（#16 头行，digest 与条款数）", async () => {
    appendPendingSuggestion("Clause A", env());
    approvePendingClause(1, env());
    const text = await run("");
    const digest = sha256Hex(await readFile(paths().active, "utf8"));
    expect(text.split("\n")[0]).toBe(`宪章：生效 1 条——digest sha256:${digest.slice(0, 12)}…`);
  });

  it("D3: stale（#14 + #15 两行，#15 行首两空格原样）", async () => {
    appendPendingSuggestion("Clause A", env());
    approvePendingClause(1, env());
    await writeFile(paths().active, "hand-edited", "utf8");
    const lines = (await run("")).split("\n");
    expect(lines[0]).toBe("⚠️ 宪章：已过期——constitution.md 与批准时的 digest 不符（在 /constitution 之外编辑过？）");
    expect(lines[1]).toBe("  该段未装入；请恢复文件或经 /constitution 重新批准，然后重启会话");
  });

  it("D4: pending>0（#18 头行 + :96 编号行原样零触）", async () => {
    appendPendingSuggestion("first pending clause", env());
    const text = await run("");
    expect(text).toContain("待审建议（1 条）：");
    expect(text).toContain("  1. first pending clause");
  });
});
