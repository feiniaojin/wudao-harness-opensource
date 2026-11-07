import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleSystemPrompt,
  buildSystemPrompt,
  SESSION_TIER,
  STATIC_TIER,
  TAIL_TIER,
} from "../src/prompt.js";
import { skillsDeltaNote } from "../src/skills.js";
import { buildToolSet } from "../src/tools.js";
import type { LoadedSkill } from "../src/skills.js";

// 2026-11-06 结构化分区改造的「钉子」。
//
// 为什么要它：分层此前只活在十几处注释里——「more dynamic goes later」靠
// 的是每个改提示词的人自己记得。一次手滑把 skills 清单挪进前缀，没有任何
// 东西会红，只是所有会话的前缀缓存悄悄失效，然后几周后才有人问「为什么
// 缓存命中率掉了」。
//
// 这三条把分层变成**可断言的性质**：
//   ① 只改 TIER 3 的输入 → TIER 1+2 的字节逐字节不变；
//   ② 只改 TIER 2 的输入 → TIER 1 的字节逐字节不变；
//   ③ TIER 3 的内容绝不会渗进前缀。
// 任何人把动态内容往前提，这三条立刻变红。

const SKILL: LoadedSkill = {
  name: "alpha",
  description: "an example skill",
  filePath: "/tmp/skills/alpha/SKILL.md",
  relPath: ".wudao/skills/alpha/SKILL.md",
  content: "---\nname: alpha\ndescription: an example skill\n---\nalpha body\n",
};

/** Everything up to (not including) the environment section — TIER 1 only. */
const staticPrefix = (p: string): string => p.slice(0, p.indexOf("# Environment"));

/** Everything up to the first tail-only marker — TIER 1 + TIER 2. */
const prefixWithoutTail = (p: string): string => {
  const at = ["# MCP tools", "# Peer messaging", "# Computer operation", "<available_skills>"].reduce(
    (best, marker) => {
      const i = p.indexOf(marker);
      return i === -1 ? best : Math.min(best, i);
    },
    Number.POSITIVE_INFINITY,
  );
  // The separator blank line belongs to the tail section that follows it
  // (each tail part carries its own leading "\n\n"), so strip it here.
  return (Number.isFinite(at) ? p.slice(0, at) : p).replace(/\n+$/, "");
};

describe("system prompt tiers — the prefix-cache contract", () => {
  it("① 只改 TIER 3 的输入，TIER 1+2 的字节逐字节不变", () => {
    const plain = buildSystemPrompt("/tmp/tiers");
    const withMcp = buildSystemPrompt("/tmp/tiers", true);
    const withPeer = buildSystemPrompt("/tmp/tiers", false, [], true);
    const withComputer = buildSystemPrompt("/tmp/tiers", false, [], false, true);
    const withSkills = buildSystemPrompt("/tmp/tiers", false, [SKILL]);
    const withAll = buildSystemPrompt("/tmp/tiers", true, [SKILL], true, true);

    const base = plain.replace(/\n+$/, "");
    for (const variant of [withMcp, withPeer, withComputer, withSkills, withAll]) {
      // 尾段是纯追加：变体以基线为前缀，绝不改写上面的字节。
      expect(prefixWithoutTail(variant)).toBe(base);
      expect(variant.startsWith(plain)).toBe(true);
    }
  });

  it("② 只改 TIER 2 的输入，TIER 1 的字节逐字节不变", () => {
    const a = buildSystemPrompt("/tmp/tiers-a");
    const b = buildSystemPrompt("/tmp/tiers-b");
    // 不同的工作目录 → Environment（TIER 2）不同，但静态前缀必须相同。
    expect(a).not.toBe(b);
    expect(staticPrefix(a)).toBe(staticPrefix(b));
  });

  it("③ TIER 3 的内容不会渗进前缀", () => {
    const withSkills = buildSystemPrompt("/tmp/tiers", true, [SKILL], true, true);
    const prefix = prefixWithoutTail(withSkills);
    // skills 的 id / 正文、MCP 的路径提示、peer 的标题都不得出现在前缀里。
    expect(prefix).not.toContain("alpha");
    expect(prefix).not.toContain("# MCP tools");
    expect(prefix).not.toContain("# Peer messaging");
    expect(prefix).not.toContain("mcp.json");
  });

  it("④ 层声明与装配顺序一致：STATIC → SESSION → TAIL", () => {
    const p = buildSystemPrompt("/tmp/tiers", true, [SKILL], true, true);
    const order = [
      "# Core principles", // static
      "# Environment", // session (join anchor)
      "# MCP tools", // tail
    ].map((h) => p.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
    // 三层都非空，且声明本身没有被悄悄改瘦
    expect(STATIC_TIER.length).toBeGreaterThan(0);
    expect(SESSION_TIER.length).toBeGreaterThan(0);
    expect(TAIL_TIER.length).toBeGreaterThan(0);
  });

  it("⑤ 同一输入两次装配逐字节相同（会话内前缀缓存的前提）", () => {
    const once = buildSystemPrompt("/tmp/tiers", true, [SKILL], true, true);
    const twice = buildSystemPrompt("/tmp/tiers", true, [SKILL], true, true);
    expect(twice).toBe(once);
  });

  it("⑦ 缓存边界是结构量：text.slice(0, boundary) === staticPrefix", () => {
    const a = assembleSystemPrompt("/tmp/tiers", true, [SKILL], true, true);
    expect(a.text.slice(0, a.boundary)).toBe(a.staticPrefix);
    expect(a.text.length).toBeGreaterThan(a.boundary);
    // 边界之外才允许出现会话/尾段内容
    expect(a.staticPrefix).not.toContain("<available_skills>");
    expect(a.staticPrefix).not.toContain("# MCP tools");
  });

  it("⑧ 不同会话的 staticPrefix 完全相同 —— 这是前缀缓存能跨会话命中的字节", () => {
    const a = assembleSystemPrompt("/tmp/ws-a", true, [SKILL], true, true);
    const b = assembleSystemPrompt("/tmp/ws-b");
    expect(a.staticPrefix).toBe(b.staticPrefix);
    // 而完整文本不同（环境/尾段不同）——说明差异全在边界之后
    expect(a.text).not.toBe(b.text);
  });

  it("⑨ skills 中途变化不产生新提示词，只产生一条增量 note", () => {
    const boot = [SKILL];
    const added = { ...SKILL, name: "beta", relPath: ".wudao/skills/beta/SKILL.md", description: "second" };
    // 没变 → null（零字节成本）
    expect(skillsDeltaNote(boot, boot)).toBeNull();
    // 新增 → note 里点名，且带上读取方式
    const note = skillsDeltaNote(boot, [...boot, added]);
    expect(note).toContain("<skills_changed>");
    expect(note).toContain("beta");
    expect(note).toContain("Use read_file");
    // 删除 → note 里点名被删的
    expect(skillsDeltaNote([...boot, added], boot)).toContain("Removed: beta");
  });

  it("⑩ 通用化：身份不提任何场景，编码纪律整节不进提示词", () => {
    const plain = buildSystemPrompt("/tmp/tiers");
    expect(plain).toContain("Your mind ranges across any domain");
    expect(plain.toLowerCase()).not.toContain("coding agent");
    // 编码纪律整节已删（用户定调：不是通用行为准则）；任何会话都不出现
    expect(plain).not.toContain("# Code changes");
    const coding = buildToolSet({ workspaceRoot: "/tmp/tiers", model: "stub" } as never);
    const withCoding = buildSystemPrompt("/tmp/tiers", false, [], false, false, coding);
    expect(withCoding).not.toContain("# Code changes");
    // 通用纪律在两种会话里都在
    expect(plain).toContain("# Finishing the job");
    expect(plain).toContain("# Long tasks");
    expect(plain).toContain("# Behavioral contracts");
    expect(plain).toContain("# Executing actions with care");
  });

  it("⑥ 项目上下文（TIER 2）在 Environment 之后、TIER 3 之前", () => {
    const root = mkdtempSync(join(tmpdir(), "wudao-tiers-"));
    writeFileSync(join(root, "WUDAO.md"), "PROJECT-CONTEXT-MARKER\n");
    mkdirSync(join(root, ".git"), { recursive: true });
    const p = buildSystemPrompt(root, true);
    const ctx = p.indexOf("PROJECT-CONTEXT-MARKER");
    expect(ctx).toBeGreaterThan(p.indexOf("# Environment"));
    expect(ctx).toBeLessThan(p.indexOf("# MCP tools"));
  });
});
