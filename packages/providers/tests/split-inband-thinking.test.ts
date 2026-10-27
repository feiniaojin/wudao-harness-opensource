import { describe, it, expect } from "vitest";
import { InbandThinkSplitter, resolveSplitInbandThinking } from "../src/split-inband-thinking.js";

// 夜移 011 (DeepSeek-Reasonix internal/provider/openai/think.go:18-98): the
// in-band `<think>` splitter. vLLM chat-template lanes (qwen-chat-template
// format) inline CoT into the CONTENT channel as `<think>…</think>` — without
// the splitter that CoT pollutes the assistant content (replayed forever,
// immune to the reasoning-replay contract). The machine peels a turn-INITIAL
// think block into the reasoning channel; a tag mentioned mid-prose is never
// hijacked (armed only at turn start); a delta boundary may split either tag,
// so the longest marker-prefix suffix is held back until the next delta
// resolves it; an UNTERMINATED block is reasoning to the end (Reasonix rule).

describe("InbandThinkSplitter — whole-block cases", () => {
  it("a single-delta full think block splits cleanly", () => {
    const s = new InbandThinkSplitter();
    expect(s.push("<think>abc</think>hello")).toEqual({ reasoning: "abc", content: "hello" });
  });
  it("content-only text passes through untouched", () => {
    const s = new InbandThinkSplitter();
    expect(s.push("just prose")).toEqual({ content: "just prose" });
  });
  it("an empty reasoning block yields only content", () => {
    const s = new InbandThinkSplitter();
    expect(s.push("<think></think>hi")).toEqual({ content: "hi" });
  });
});

describe("InbandThinkSplitter — delta-boundary holdback", () => {
  it("tags straddling deltas resolve correctly (the Reasonix holdback)", () => {
    const s = new InbandThinkSplitter();
    expect(s.push("<th")).toEqual({});
    expect(s.push("ink>re")).toEqual({ reasoning: "re" });
    expect(s.push("ason")).toEqual({ reasoning: "ason" });
    expect(s.push("ing</th")).toEqual({ reasoning: "ing" }); // only the '</th' prefix is held back
    expect(s.push("ink>don")).toEqual({ content: "don" });
    expect(s.finish()).toEqual({});
  });
  it("leading whitespace then the tag: ws is swallowed, block split", () => {
    const s = new InbandThinkSplitter();
    expect(s.push("  ")).toEqual({});
    expect(s.push("\n<think>r</think>c")).toEqual({ reasoning: "r", content: "c" });
  });
  it("leading whitespace without a tag flushes as content", () => {
    const s = new InbandThinkSplitter();
    expect(s.push("  ")).toEqual({});
    expect(s.push("prose")).toEqual({ content: "  prose" });
  });
  it("a partial open-tag suffix at stream end flushes as content (never was a tag)", () => {
    const s = new InbandThinkSplitter();
    expect(s.push("<th")).toEqual({});
    expect(s.finish()).toEqual({ content: "<th" });
  });
});

describe("InbandThinkSplitter — armed only at turn start", () => {
  it("a mid-turn tag in prose is never hijacked", () => {
    const s = new InbandThinkSplitter();
    const out = s.push("code uses <think> as a literal tag");
    expect(out).toEqual({ content: "code uses <think> as a literal tag" });
    expect(s.push(" more")).toEqual({ content: " more" });
  });
  it("after the block closes, a second think tag stays content", () => {
    const s = new InbandThinkSplitter();
    s.push("<think>a</think>answer");
    expect(s.push(" mentions <think> too")).toEqual({ content: " mentions <think> too" });
  });
});

describe("InbandThinkSplitter — unterminated block", () => {
  it("an unterminated think block is reasoning to the end (Reasonix rule)", () => {
    const s = new InbandThinkSplitter();
    expect(s.push("<think>lost")).toEqual({ reasoning: "lost" });
    expect(s.finish()).toEqual({});
  });
  it("a close-tag prefix held at stream end flushes as reasoning", () => {
    const s = new InbandThinkSplitter();
    s.push("<think>almost</t");
    expect(s.finish()).toEqual({ reasoning: "</t" });
  });
});

describe("resolveSplitInbandThinking — 夜移 011: format-derived default, config override", () => {
  it("the qwen-chat-template format is the vLLM inline-CoT lane: on by default", () => {
    expect(resolveSplitInbandThinking({ apiKey: "k", baseURL: "https://x/v1", model: "m", reasoningFormat: "qwen-chat-template" })).toBe(true);
  });
  it("every other format stays off (native reasoning fields carry the CoT)", () => {
    expect(resolveSplitInbandThinking({ apiKey: "k", baseURL: "https://x/v1", model: "m" })).toBe(false);
    expect(resolveSplitInbandThinking({ apiKey: "k", baseURL: "https://x/v1", model: "m", reasoningFormat: "qwen" })).toBe(false);
    expect(resolveSplitInbandThinking({ apiKey: "k", baseURL: "https://x/v1", model: "m", reasoningFormat: "deepseek" })).toBe(false);
  });
  it("an explicit config flag beats the format default in BOTH directions", () => {
    expect(resolveSplitInbandThinking({ apiKey: "k", baseURL: "https://x/v1", model: "m", reasoningFormat: "qwen-chat-template", splitInbandThinking: false })).toBe(false);
    expect(resolveSplitInbandThinking({ apiKey: "k", baseURL: "https://x/v1", model: "m", reasoningFormat: "deepseek", splitInbandThinking: true })).toBe(true);
  });
});
