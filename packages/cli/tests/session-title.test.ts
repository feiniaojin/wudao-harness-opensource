// 夜移 005（2026-08-28 night porting，the upstream formatsession-title，设计加强）：
// 首个成功 run 后，用一次独立小调用（querySource:"title"、低推理、短输出、
// 不进主转录、不改任何前缀字节）给会话生成人类可读标题，写入 session_name
// 条目（source:"llm"，last-wins）；手动 /rename（source:"manual"）永不覆盖；
// 失败静默回退派生名（source:"derived"，M33 既有行为）。
import { describe, it, expect } from "vitest";
import { sanitizeTitle, buildTitleRequest, TITLE_QUERY_SOURCE, TITLE_MAX_CODEPOINTS } from "../src/session-title.js";
import type { AgentMessage } from "@wudao/core";

describe("sanitizeTitle (夜移 005)", () => {
  it("strips wrapping quotes/backticks, collapses to one line, trims", () => {
    expect(sanitizeTitle(`  "修复登录超时 bug"  `)).toBe("修复登录超时 bug");
    expect(sanitizeTitle("`fix login timeout`\n")).toBe("fix login timeout");
    expect(sanitizeTitle("line one\nline two")).toBe("line one line two");
    expect(sanitizeTitle("  「给会话起名」  ")).toBe("给会话起名");
  });

  it("caps at the limit in CODE POINTS (CJK-safe, never splits a surrogate pair)", () => {
    const long = "这是一个非常非常长的会话标题一定需要被截断到上限码点数以内才能算完成";
    const out = sanitizeTitle(long);
    expect(out).toBeDefined();
    expect(Array.from(out ?? "").length).toBe(TITLE_MAX_CODEPOINTS);
    // No lone surrogate left at the cut.
    expect((out ?? "").includes("�")).toBe(false);
  });

  it("drops trailing punctuation noise", () => {
    expect(sanitizeTitle("Fix login bug.")).toBe("Fix login bug");
    expect(sanitizeTitle("这是一个标题。")).toBe("这是一个标题");
  });

  it("returns undefined for empty / whitespace / quote-only input", () => {
    expect(sanitizeTitle("")).toBeUndefined();
    expect(sanitizeTitle("   \n  ")).toBeUndefined();
    expect(sanitizeTitle('  ""  ')).toBeUndefined();
  });
});

describe("buildTitleRequest (夜移 005)", () => {
  it("builds a tiny standalone request from the first exchange", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "帮我修复登录超时的 bug" },
      { role: "assistant", content: "好的，我来看一下相关代码。" },
    ];
    const req = buildTitleRequest(messages);
    expect(req).toBeDefined();
    expect(req!.systemPrompt).toContain("title");
    expect(req!.user).toContain("帮我修复登录超时的 bug");
    expect(req!.user).toContain("好的，我来看一下相关代码。");
  });

  it("no assistant answer yet → undefined (nothing to title from)", () => {
    expect(buildTitleRequest([{ role: "user", content: "hi" }])).toBeUndefined();
  });

  it("caps both excerpts so the call stays tiny", () => {
    const big = "x".repeat(10_000);
    const req = buildTitleRequest([
      { role: "user", content: big },
      { role: "assistant", content: big },
    ])!;
    expect(req.user.length).toBeLessThan(2_200);
  });
});

describe("TITLE_QUERY_SOURCE", () => {
  it("rides the background allowlist tag (bail-on-overload, no retries)", () => {
    expect(TITLE_QUERY_SOURCE).toBe("title");
  });
});
