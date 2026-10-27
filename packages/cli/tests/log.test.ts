import { describe, it, expect } from "vitest";
import { parseLogLevel, summarizeToolCall, truncate, LEVEL_ORDER, stripLogFlags, modelLabel, formatCompactedLine } from "../src/log.js";

describe("parseLogLevel", () => {
  it("defaults to info", () => { expect(parseLogLevel([], {})).toBe("info"); });
  it("--debug wins", () => { expect(parseLogLevel(["--debug", "--quiet"], {})).toBe("debug"); });
  it("--quiet -> error", () => { expect(parseLogLevel(["--quiet"], {})).toBe("error"); });
  it("--log-level flag", () => { expect(parseLogLevel(["--log-level", "debug"], {})).toBe("debug"); });
  it("WUDAO_LOG_LEVEL env", () => { expect(parseLogLevel([], { WUDAO_LOG_LEVEL: "error" })).toBe("error"); });
  it("ignores bogus level", () => { expect(parseLogLevel(["--log-level", "nope"], {})).toBe("info"); });
  it("parses --log-level=equals form with same precedence as space form", () => {
    expect(parseLogLevel(["--log-level=debug"], {})).toBe("debug");
    expect(parseLogLevel(["--log-level=ERROR"], {})).toBe("error");
  });
  it("equals form loses to --debug and --quiet like the space form", () => {
    expect(parseLogLevel(["--debug", "--log-level=error"], {})).toBe("debug");
    expect(parseLogLevel(["--quiet", "--log-level=debug"], {})).toBe("error");
  });
  it("ignores bogus equals-form level", () => { expect(parseLogLevel(["--log-level=nope"], {})).toBe("info"); });
  it("does not eat a following flag as the level", () => {
    expect(parseLogLevel(["--log-level", "--auto"], {})).toBe("info");
    expect(parseLogLevel(["--log-level", "-v"], {})).toBe("info");
  });
  it("missing value after --log-level falls through", () => {
    expect(parseLogLevel(["--log-level"], {})).toBe("info");
    expect(parseLogLevel(["--log-level", ""], {})).toBe("info");
  });
});
describe("summarizeToolCall", () => {
  it("shell -> command", () => { expect(summarizeToolCall("shell", { command: "ls" })).toBe("ls"); });
  it("write_file -> path", () => { expect(summarizeToolCall("write_file", { path: "a.ts" })).toBe("a.ts"); });
  it("glob -> pattern", () => { expect(summarizeToolCall("glob", { pattern: "**/*.ts" })).toBe("**/*.ts"); });
  it("unknown -> empty", () => { expect(summarizeToolCall("zzz", { x: 1 })).toBe(""); });
});
describe("truncate", () => {
  it("collapses whitespace and truncates with ellipsis", () => {
    expect(truncate("a\nb\nc", 1)).toBe("a…");
  });
  it("leaves short strings intact", () => { expect(truncate("hi", 10)).toBe("hi"); });
});
describe("LEVEL_ORDER", () => {
  it("orders error<info<debug", () => { expect(LEVEL_ORDER.error < LEVEL_ORDER.info && LEVEL_ORDER.info < LEVEL_ORDER.debug).toBe(true); });
});
describe("stripLogFlags", () => {
  it("removes --debug", () => { expect(stripLogFlags(["hi", "--debug"])).toEqual(["hi"]); });
  it("removes --quiet but keeps other words", () => { expect(stripLogFlags(["hi", "--quiet", "there"])).toEqual(["hi", "there"]); });
  it("removes --log-level and its value", () => { expect(stripLogFlags(["hi", "--log-level", "debug", "there"])).toEqual(["hi", "there"]); });
  it("removes --auto but keeps other words", () => { expect(stripLogFlags(["hi", "--auto", "there"])).toEqual(["hi", "there"]); });
  it("removes --read-only", () => { expect(stripLogFlags(["hi", "--read-only"])).toEqual(["hi"]); });
  it("removes --resume and its value", () => { expect(stripLogFlags(["hi", "--resume", "abc", "there"])).toEqual(["hi", "there"]); });
  it("removes single-dash -resume and its value", () => { expect(stripLogFlags(["-resume", "abc", "hi"])).toEqual(["hi"]); });
  it("removes --resume=<v> form", () => { expect(stripLogFlags(["--resume=abc", "hi"])).toEqual(["hi"]); });
  it("removes -resume=<v> form", () => { expect(stripLogFlags(["-resume=abc", "hi"])).toEqual(["hi"]); });
  it("does not eat a non-flag word after --resume into the prompt twice", () => {
    expect(stripLogFlags(["--resume", "--auto", "hi"])).toEqual(["hi"]);
  });
  it("stripLogFlags drops equals forms too", () => {
    expect(stripLogFlags(["--log-level=debug", "--resume=abc", "hello"])).toEqual(["hello"]);
  });
  it("removes --continue", () => { expect(stripLogFlags(["hi", "--continue"])).toEqual(["hi"]); });
  it("removes -all too (parseAllFlag accepts the single-dash form)", () => { expect(stripLogFlags(["-all", "hi", "there"])).toEqual(["hi", "there"]); });
  it("removes --list-sessions", () => { expect(stripLogFlags(["hi", "--list-sessions"])).toEqual(["hi"]); });
  it("removes --no-tui", () => { expect(stripLogFlags(["--no-tui"])).toEqual([]); expect(stripLogFlags(["hi", "--no-tui", "there"])).toEqual(["hi", "there"]); });
  it("removes --sandbox", () => { expect(stripLogFlags(["--sandbox", "hi", "there"])).toEqual(["hi", "there"]); });
  it("removes --plan (M37: one-shot plan mode)", () => { expect(stripLogFlags(["--plan", "add", "dark", "mode"])).toEqual(["add", "dark", "mode"]); });
  it("keeps a literal 'plan' word that is not the flag", () => { expect(stripLogFlags(["the", "plan", "works"])).toEqual(["the", "plan", "works"]); });
  it("keeps a literal 'sandbox' word that is not the flag", () => { expect(stripLogFlags(["escape", "the", "sandbox"])).toEqual(["escape", "the", "sandbox"]); });
  it("leaves argv without flags intact", () => { expect(stripLogFlags(["just", "words"])).toEqual(["just", "words"]); });
});

describe("stripLogFlags — provider flags", () => {
  it("removes --provider and its value", () => { expect(stripLogFlags(["hi", "--provider", "glm", "there"])).toEqual(["hi", "there"]); });
  it("removes --provider=<v> form", () => { expect(stripLogFlags(["--provider=glm", "hi"])).toEqual(["hi"]); });
  it("removes single-dash -provider forms", () => {
    expect(stripLogFlags(["-provider", "glm", "hi"])).toEqual(["hi"]);
    expect(stripLogFlags(["-provider=glm", "hi"])).toEqual(["hi"]);
  });
  it("removes --reasoning-effort and its value", () => { expect(stripLogFlags(["hi", "--reasoning-effort", "high", "there"])).toEqual(["hi", "there"]); });
  it("removes --reasoning-effort=<v> form", () => { expect(stripLogFlags(["--reasoning-effort=high", "hi"])).toEqual(["hi"]); });
  it("removes single-dash -reasoning-effort forms", () => {
    expect(stripLogFlags(["-reasoning-effort", "high", "hi"])).toEqual(["hi"]);
    expect(stripLogFlags(["-reasoning-effort=high", "hi"])).toEqual(["hi"]);
  });
  it("does not eat a following flag as a value", () => {
    expect(stripLogFlags(["--provider", "--auto", "hi"])).toEqual(["hi"]);
  });
});

describe("modelLabel", () => {
  it("model only (no provider) → just the model", () => { expect(modelLabel({ model: "m" })).toBe("m"); });
  it("deepseek provider → just the model (byte-stable header)", () => {
    expect(modelLabel({ provider: "deepseek", model: "deepseek-v4-flash" })).toBe("deepseek-v4-flash");
  });
  it("other providers → provider · model", () => {
    expect(modelLabel({ provider: "glm", model: "glm-4.6" })).toBe("glm · glm-4.6");
    expect(modelLabel({ provider: "qwen", model: "qwen3-max" })).toBe("qwen · qwen3-max");
    expect(modelLabel({ provider: "wudao", model: "wudao-preview" })).toBe("wudao · wudao-preview");
  });
});

// ---------------------------------------------------------------------------
// M25 §A4: compacted-notice composition (tier/trigger words + k-magnitudes)
// ---------------------------------------------------------------------------

describe("formatCompactedLine", () => {
  it("composes the spec line: magnitudes · tier word · trigger word · continuing", () => {
    // 49800 → "49.8k", 12100 → "12.1k" (formatTokensK, one decimal).
    expect(formatCompactedLine(2, "boundary", 49800, 12100)).toBe(
      "♻️ 上下文已压缩 49.8k → 12.1k · 摘要 · 轮界（继续中…）", // ω99-192: 钉随源演进
    );
  });
  it("tier 1 → micro-compact; threshold → pre-call; immediate → overflow", () => {
    expect(formatCompactedLine(1, "threshold", 60000, 20000)).toBe(
      "♻️ 上下文已压缩 60k → 20k · 微压缩 · 调用前（继续中…）", // ω99-192: 钉随源演进
    );
    expect(formatCompactedLine(1, "immediate", 60000, 20000)).toBe(
      "♻️ 上下文已压缩 60k → 20k · 微压缩 · 溢出（继续中…）", // ω99-192: 钉随源演进
    );
  });
  it("reactive (post-413) maps to overflow too — headroom was already gone", () => {
    expect(formatCompactedLine(2, "reactive", 70000, 30000)).toBe(
      "♻️ 上下文已压缩 70k → 30k · 摘要 · 溢出（继续中…）", // ω99-192: 钉随源演进
    );
  });
});

describe("stripLogFlags — plugin flag (M36)", () => {
  it("removes --plugin and its value", () => { expect(stripLogFlags(["hi", "--plugin", "./p", "there"])).toEqual(["hi", "there"]); });
  it("removes repeated --plugin mounts", () => { expect(stripLogFlags(["--plugin", "a", "--plugin=b", "hi"])).toEqual(["hi"]); });
  it("removes single-dash -plugin forms", () => {
    expect(stripLogFlags(["-plugin", "a", "hi"])).toEqual(["hi"]);
    expect(stripLogFlags(["-plugin=a", "hi"])).toEqual(["hi"]);
  });
});
