// ω99-277: #8 — 会话全文搜索纯层（切换会话弹框的搜索车道）。tmpdir 造真实
// 形状的 JSONL（user string content、assistant parts 数组、泛型行、坏 JSON
// 尾行）钉：命中跨 user/assistant、大小写不敏感、CJK 子串、±30 字摘要的
// 越界侧省略号、perSession/total 帽与早退、空 q / 缺目录的礼貌退化、
// worktree filter 与 sessions() 同语义、name/firstUser 同源。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchSessionFiles, type SessionSearchHit } from "../src/driver/session-search.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wudao-277-search-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** 写一个会话 JSONL（原始行直写——夹具要能放坏行与任意 part 形）。 */
async function seed(id: string, lines: readonly unknown[], mtime = new Date()): Promise<string> {
  const sessionsDir = join(dir, ".wudao", "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const file = join(sessionsDir, `${id}.jsonl`);
  await writeFile(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n", "utf8");
  await utimes(file, mtime, mtime);
  return file;
}

// 会话 1：user string 命中 + assistant parts 数组命中 + 各类应跳过的行。
const SEED_OLD_LINES = [
  { type: "wudao_meta", data: { formatVersion: 1 } },
  { role: "user", content: "帮我修复登录页面的 Bug", uuid: "u-0001" },
  { role: "assistant", content: "", reasoning: "thinking about the Bug fix internally" },
  { role: "assistant", content: [
    { type: "text", text: "已修复 Bug：问题出在 auth.ts 的空指针" },
    { type: "tool_use", id: "t1", name: "read_file" },
  ] },
  { type: "notice", data: { text: "notice 行也提到 Bug 但不是消息" } },
  { role: "tool", toolCallId: "c1", name: "read_file", content: "Bug 出现在文件正文里，工具行不搜" },
  "{this is not json at all", // 坏 JSON 尾行（append-only 的半行）
  { role: "user", content: "uuid 里有 magicword-xyz 但正文没有" , uuid: "magicword-xyz" },
];

describe("ω99-277 searchSessionFiles — 命中与文本提取", () => {
  it("命中跨 user/assistant；泛型行/工具行/坏行/空 content/reasoning-only 全跳过", async () => {
    await seed("sess-old", SEED_OLD_LINES);
    const hits = await searchSessionFiles(join(dir, ".wudao", "sessions"), "bug", {});
    expect(hits.map((h) => h.kind)).toEqual(["user", "assistant"]);
    expect(hits.every((h) => h.sessionId === "sess-old")).toBe(true);
    // notice 行的文本（“notice 行也提到 Bug…”）绝不出现。
    expect(hits.some((h) => h.snippet.includes("notice 行"))).toBe(false);
    // 工具行正文不搜。
    expect(hits.some((h) => h.snippet.includes("工具行不搜"))).toBe(false);
    // reasoning-only 的 assistant（content:""）跳过。
    expect(hits.some((h) => h.snippet.includes("thinking about"))).toBe(false);
    // assistant parts 数组：只拼 text 部分（tool_use part 不猜）。
    expect(hits[1]!.snippet).toContain("已修复 Bug：问题出在 auth.ts 的空指针");
  });

  it("大小写不敏感（两侧 toLowerCase）；CJK 子串安全", async () => {
    await seed("sess-old", SEED_OLD_LINES);
    await seed("sess-cjk", [
      { role: "user", content: "前天精灵问过的那个配置项在哪里" },
      { role: "assistant", content: [{ type: "text", text: "配置项是 server.port，在 .env 里" }] },
    ]);
    const hits = await searchSessionFiles(join(dir, ".wudao", "sessions"), "BUG", {});
    expect(hits.length).toBeGreaterThan(0); // q 大写命中正文小写 bug
    const zh = await searchSessionFiles(join(dir, ".wudao", "sessions"), "配置项", {});
    expect(zh.map((h) => h.kind)).toEqual(["user", "assistant"]);
  });

  it("q 只匹配可见正文，不匹配行内 JSON 元数据（uuid 键值）", async () => {
    await seed("sess-meta", [{ role: "user", content: "正文完全无关", uuid: "magicword-xyz" }]);
    const hits = await searchSessionFiles(join(dir, ".wudao", "sessions"), "magicword", {});
    expect(hits).toEqual([]);
  });
});

describe("ω99-277 searchSessionFiles — 摘要 ±30", () => {
  it("越界侧才加省略号；两侧富余不加；原文大小写保真", async () => {
    await seed("sess-snip", [
      { role: "user", content: "A".repeat(40) + "NEEDLE" + "B".repeat(5) }, // 左切右侧刚好收尾
      { role: "user", content: "X".repeat(3) + "needle" + "Y".repeat(40) }, // 右切
      { role: "user", content: "prefix needle suffix" }, // 两侧都不切
      { role: "user", content: "L".repeat(60) + "needle" + "R".repeat(60) }, // 两侧都切
    ]);
    const hits = await searchSessionFiles(join(dir, ".wudao", "sessions"), "NEEDLE", {});
    expect(hits).toHaveLength(4);
    const [leftCut, rightCut, neither, both] = hits as SessionSearchHit[];
    expect(leftCut.snippet.startsWith("…")).toBe(true);
    expect(leftCut.snippet.endsWith("…")).toBe(false);
    expect(rightCut.snippet.startsWith("…")).toBe(false);
    expect(rightCut.snippet.endsWith("…")).toBe(true);
    expect(neither.snippet.startsWith("…")).toBe(false);
    expect(neither.snippet.endsWith("…")).toBe(false);
    expect(neither.snippet).toBe("prefix needle suffix"); // 大小写保真（q 大写）
    expect(both.snippet.startsWith("…")).toBe(true);
    expect(both.snippet.endsWith("…")).toBe(true);
  });
});

describe("ω99-277 searchSessionFiles — 排序与帽", () => {
  it("会话按 mtime desc；会话内按文件序", async () => {
    await seed("sess-a", [
      { role: "user", content: "alpha 第一条" },
      { role: "assistant", content: "alpha 第二条" },
    ], new Date(Date.now() - 60_000));
    await seed("sess-b", [
      { role: "user", content: "alpha 新会话第一条" },
    ], new Date());
    const hits = await searchSessionFiles(join(dir, ".wudao", "sessions"), "alpha", {});
    expect(hits.map((h) => h.sessionId)).toEqual(["sess-b", "sess-a", "sess-a"]);
    expect(hits[1]!.snippet).toContain("第一条");
    expect(hits[2]!.snippet).toContain("第二条"); // 会话内文件序
  });

  it("perSession 帽 5（可覆写）；total 帽 50 满即停扫", async () => {
    // 一个会话 8 条命中 → 默认只出 5。
    await seed("sess-cap", Array.from({ length: 8 }, (_, i) => ({
      role: "user" as const, content: `capline 第 ${i} 条`,
    })));
    const five = await searchSessionFiles(join(dir, ".wudao", "sessions"), "capline", {});
    expect(five).toHaveLength(5);
    const seven = await searchSessionFiles(join(dir, ".wudao", "sessions"), "capline", { perSession: 7 });
    expect(seven).toHaveLength(7);

    // 11 个会话 × 5 = 55 > 50 → 早退在 50。
    for (let s = 0; s < 11; s += 1) {
      await seed(`sess-tot-${s}`, Array.from({ length: 5 }, (_, i) => ({
        role: "user" as const, content: `totline ${s}-${i}`,
      })), new Date(Date.now() - s * 1000));
    }
    const tot = await searchSessionFiles(join(dir, ".wudao", "sessions"), "totline", {});
    expect(tot).toHaveLength(50);
  });
});

describe("ω99-277 searchSessionFiles — 退化与过滤", () => {
  it("空 q / 纯空白 q → []；不存在的目录 → []", async () => {
    await seed("sess-x", [{ role: "user", content: "whatever" }]);
    const s = join(dir, ".wudao", "sessions");
    expect(await searchSessionFiles(s, "", {})).toEqual([]);
    expect(await searchSessionFiles(s, "   ", {})).toEqual([]);
    expect(await searchSessionFiles(join(dir, ".wudao", "no-such-dir"), "whatever", {})).toEqual([]);
  });

  it("filterWorkspaceRoot 与 sessions() 同语义：记录了不同 root 的会话隐藏，无记录/同 root 可见", async () => {
    await seed("sess-other-root", [
      { type: "workspace_root", data: { root: "/elsewhere/main" } },
      { role: "user", content: "另一个 worktree 的 zebra 消息" },
    ]);
    await seed("sess-this-root", [
      { role: "user", content: "本 worktree 的 zebra 消息" },
      { type: "workspace_root", data: { root: "/this/worktree" } },
    ]);
    await seed("sess-no-root", [
      { role: "user", content: "无记录的 zebra 消息（老文件）" },
    ]);
    const s = join(dir, ".wudao", "sessions");
    const hits = await searchSessionFiles(s, "zebra", { filterWorkspaceRoot: "/this/worktree" });
    expect(hits.map((h) => h.sessionId).sort()).toEqual(["sess-no-root", "sess-this-root"]);
    // 不给 filter → 全可见（plain checkout 语义）。
    const all = await searchSessionFiles(s, "zebra", {});
    expect(all).toHaveLength(3);
  });
});

describe("ω99-277 searchSessionFiles — name/firstUser 同源", () => {
  it("name 取 session_name entry；firstUser 是首条真实 user 消息（50 字折叠）", async () => {
    await seed("sess-named", [
      { role: "user", content: "[system note: 引导信息]" }, // marker，不算首条真实消息
      { role: "user", content: "真正的第一个问题 " + "很长的正文".repeat(20) },
      { type: "session_name", name: "修复登录页", source: "manual" },
      { role: "assistant", content: "答案里有 named-target" },
    ]);
    const hits = await searchSessionFiles(join(dir, ".wudao", "sessions"), "named-target", {});
    expect(hits).toHaveLength(1);
    const h = hits[0]!;
    expect(h.name).toBe("修复登录页");
    expect(h.firstUser.startsWith("真正的第一个问题")).toBe(true);
    expect(h.firstUser.length).toBeLessThanOrEqual(51); // 50 + 可能的 …
    expect(h.kind).toBe("assistant");
    expect(h.mtime).toBe(new Date(h.mtime).toISOString()); // ISO 形
  });

  it("未命名会话 name 为空串（web 侧三级回退拼题）", async () => {
    await seed("sess-unnamed", [{ role: "user", content: "只有正文 unnamed-target" }]);
    const hits = await searchSessionFiles(join(dir, ".wudao", "sessions"), "unnamed-target", {});
    expect(hits[0]!.name).toBe("");
    expect(hits[0]!.firstUser).toContain("只有正文");
  });
});
