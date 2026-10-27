// M47 §2 (B2) — the language transient block: pure detection helpers, the
// driver's turn-tail append (prefix-safe), the off-switch, and subagent
// inheritance through the cli task tool.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LANGUAGE_BLOCK_ZH,
  HAN_RATIO_THRESHOLD,
  hanRatio,
  detectChinese,
  languageBlockFor,
  resolveLanguageBlockMode,
  stripCodeFences,
  stripMentions,
  transcriptHasLanguageBlock,
  REASONING_BLOCK_ZH,
  REASONING_BLOCK_EN,
  reasoningBlockFor,
  resolveReasoningLanguageMode,
  transcriptReasoningBlock,
} from "../src/language.js";
import { buildTool, createScriptedModel } from "@wudao/core";
import type { ModelClient, ModelInput, Tool } from "@wudao/core";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import { createAgentsTaskTool, createSessionRegistry } from "../src/agents/index.js";
import { summarizeToolCall } from "../src/log.js";
import { stripProjectedNotes } from "./projected-notes.js";

// M53 §1: strip the branch-node metadata (uuid/parentUuid) — shape pins
// compare roles/contents, not the random node ids.
function stripBranch<T extends { uuid?: unknown; parentUuid?: unknown }>(m: T): T {
  const rest = { ...m } as Partial<T>;
  delete (rest as { uuid?: unknown }).uuid;
  delete (rest as { parentUuid?: unknown }).parentUuid;
  return rest as T;
}
const plainBranch = (ms: readonly unknown[]): unknown[] => ms.map((m) => stripBranch(m as { uuid?: unknown; parentUuid?: unknown }));


afterEach(() => {
  delete process.env.WUDAO_LANGUAGE_BLOCK;
  delete process.env.WUDAO_REASONING_LANGUAGE;
  delete process.env.WUDAO_NO_LANGUAGE;
});

describe("detection helpers", () => {
  it("measures the Han ratio on the stripped text", () => {
    expect(hanRatio("请帮我看看这个文件")).toBeGreaterThan(0.9);
    expect(hanRatio("please review this file")).toBe(0);
    // 3 Han + 7 Latin = exactly 0.30 — the boundary vocabulary.
    expect(hanRatio("看a这b个cdefg")).toBeCloseTo(3 / 10, 5);
  });

  it("strips code fences and @mention payloads before voting", () => {
    const fenced = "请分析\n```js\nconst x = 'lots of english words here and more words';\n```\n谢谢";
    expect(detectChinese(fenced)).toBe(true);
    const englishWithChineseCode = "please review this file\n```js\n// 这是大量中文注释内容比例很高\n```\nand fix it";
    expect(detectChinese(englishWithChineseCode)).toBe(false);
    expect(stripCodeFences("a```x```b")).toBe("ab");
    expect(stripMentions('look at <file path="a.md">\n中文中文中文\n</file> now')).toBe("look at  now");
    expect(stripMentions("read @src/a.ts please")).toBe("read  please");
  });

  it("detectChinese uses the 30% threshold", () => {
    expect(HAN_RATIO_THRESHOLD).toBe(0.3);
    expect(detectChinese("看a这b个cdefg")).toBe(true); // exactly 0.30
    expect(detectChinese("看a这bcdefg")).toBe(false); // 2/9 ≈ 0.22 — below
  });
});

describe("languageBlockFor / resolveLanguageBlockMode", () => {
  it("auto appends only for Chinese prompts; on forces; off disables", () => {
    expect(languageBlockFor("请修复这个 bug", "auto")).toBe(LANGUAGE_BLOCK_ZH);
    expect(languageBlockFor("please fix the bug", "auto")).toBeUndefined();
    expect(languageBlockFor("please fix the bug", "on")).toBe(LANGUAGE_BLOCK_ZH);
    expect(languageBlockFor("请修复", "off")).toBeUndefined();
  });

  it("the block wording is imperative — no soft phrasing", () => {
    expect(LANGUAGE_BLOCK_ZH).toBe("[language: respond in Chinese]");
    expect(LANGUAGE_BLOCK_ZH).not.toMatch(/if you can|如果可以|please try/i);
  });

  it("WUDAO_LANGUAGE_BLOCK resolves off/on/auto", () => {
    expect(resolveLanguageBlockMode({})).toBe("auto");
    expect(resolveLanguageBlockMode({ WUDAO_LANGUAGE_BLOCK: "" })).toBe("auto");
    expect(resolveLanguageBlockMode({ WUDAO_LANGUAGE_BLOCK: "junk" })).toBe("auto");
    expect(resolveLanguageBlockMode({ WUDAO_LANGUAGE_BLOCK: "off" })).toBe("off");
    expect(resolveLanguageBlockMode({ WUDAO_LANGUAGE_BLOCK: "0" })).toBe("off");
    expect(resolveLanguageBlockMode({ WUDAO_LANGUAGE_BLOCK: "on" })).toBe("on");
    expect(resolveLanguageBlockMode({ WUDAO_LANGUAGE_BLOCK: "zh" })).toBe("on");
  });

  it("transcriptHasLanguageBlock detects an active directive in the parent transcript", () => {
    expect(transcriptHasLanguageBlock([{ role: "user", content: LANGUAGE_BLOCK_ZH }])).toBe(true);
    expect(transcriptHasLanguageBlock([{ role: "user", content: "[language: respond in Japanese]" }])).toBe(true);
    expect(transcriptHasLanguageBlock([{ role: "user", content: "hello" }])).toBe(false);
    expect(transcriptHasLanguageBlock([{ role: "assistant", content: LANGUAGE_BLOCK_ZH }])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Driver: the turn-tail append
// ---------------------------------------------------------------------------

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

function stubTool(): Tool {
  return buildTool({
    name: "read_file",
    description: "stub",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    execute: async () => ({ content: "ok" }),
  });
}

describe("AgentDriver — language transient block", () => {
  it("appends the block as a user message at the turn tail for a Chinese prompt", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "好的" }]);
    const inputs: ModelInput[] = [];
    const wrapped = {
      async generate(input: ModelInput) {
        inputs.push({ ...input, messages: [...input.messages], tools: [...input.tools] });
        return model.generate(input);
      },
    };
    const driver = createAgentDriver({
      model: wrapped,
      tools: [stubTool()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      languageBlock: "auto",
      onPermissionAsk: async () => ({ kind: "allow" as const }),
    });
    driver.submit("请总结这个项目");
    await until(() => !driver.getStatus().busy, "run complete");
    // Turn-tail append: [user prompt, block] — then the run's own answer.
    expect(stripBranch(driver.state.messages[0] as { role: string })).toEqual({ role: "user", content: "请总结这个项目" });
    expect(stripBranch(driver.state.messages[1] as { role: string })).toEqual({ role: "user", content: LANGUAGE_BLOCK_ZH });
    // Prefix-safe: the model's request is [user prompt, block] — the user
    // message's bytes lead, the block is a pure tail append.
    const sent = inputs[0]!.messages;
    expect(stripBranch(sent[0] as { role: string })).toEqual({ role: "user", content: "请总结这个项目" });
    expect(stripBranch(sent[1] as { role: string })).toEqual({ role: "user", content: LANGUAGE_BLOCK_ZH });
  });

  it("an English prompt appends nothing (status quo bytes)", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "done" }]);
    const inputs: ModelInput[] = [];
    const wrapped = {
      async generate(input: ModelInput) {
        inputs.push({ ...input, messages: [...input.messages], tools: [...input.tools] });
        return model.generate(input);
      },
    };
    const driver = createAgentDriver({
      model: wrapped,
      tools: [stubTool()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: async () => ({ kind: "allow" as const }),
    });
    driver.submit("summarize this project");
    await until(() => !driver.getStatus().busy, "run complete");
    expect(driver.state.messages.filter((m) => m.content === LANGUAGE_BLOCK_ZH)).toHaveLength(0);
    expect(plainBranch(stripProjectedNotes(inputs[0]!.messages) as readonly unknown[])).toEqual([{ role: "user", content: "summarize this project" }]);
  });

  it("the off-switch (opts beat env) suppresses the block for a Chinese prompt", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "好的" }]);
    const driver = createAgentDriver({
      model,
      tools: [stubTool()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      languageBlock: "off",
      onPermissionAsk: async () => ({ kind: "allow" as const }),
    });
    driver.submit("请总结这个项目");
    await until(() => !driver.getStatus().busy, "run complete");
    expect(driver.state.messages.some((m) => m.content === LANGUAGE_BLOCK_ZH)).toBe(false);
  });

  it("env WUDAO_LANGUAGE_BLOCK=off is the default off-switch (no opts)", async () => {
    process.env.WUDAO_LANGUAGE_BLOCK = "off";
    const model = createScriptedModel([{ role: "assistant", content: "好的" }]);
    const driver = createAgentDriver({
      model,
      tools: [stubTool()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: async () => ({ kind: "allow" as const }),
    });
    driver.submit("请总结这个项目");
    await until(() => !driver.getStatus().busy, "run complete");
    expect(driver.state.messages.some((m) => m.content === LANGUAGE_BLOCK_ZH)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Subagent inheritance (the cli task tool)
// ---------------------------------------------------------------------------

describe("task tool — language-block inheritance (M47 §2)", () => {
  const ALL_TOOLS: readonly Tool[] = [
    buildTool({ name: "read_file", description: "read", parameters: { type: "object", properties: {} }, execute: async () => ({ content: "ok" }) }),
    buildTool({ name: "glob", description: "glob", parameters: { type: "object", properties: {} }, execute: async () => ({ content: "ok" }) }),
    buildTool({ name: "grep", description: "grep", parameters: { type: "object", properties: {} }, execute: async () => ({ content: "ok" }) }),
  ];

  function recordingModel(inputs: ModelInput[]): ModelClient {
    return {
      async generate(input: ModelInput) {
        // Snapshot: the loop passes the live messages array, which keeps
        // growing after the call returns.
        inputs.push({ ...input, messages: [...input.messages], tools: [...input.tools] });
        return { role: "assistant", content: "child done" };
      },
    };
  }

  it("a parent transcript carrying the block appends it to the child brief", async () => {
    const root = await mkdtemp(join(tmpdir(), "m47-lang-"));
    try {
      const inputs: ModelInput[] = [];
      const registry = createSessionRegistry();
      const task = createAgentsTaskTool({
        model: recordingModel(inputs),
        allTools: ALL_TOOLS as unknown as Tool[],
        registry,
        workspaceRoot: root,
        runId: "m47-lang",
        defaultEffort: "off",
        getForkContext: () => ({
          systemPrompt: "parent",
          tools: [],
          messages: [
            { role: "user", content: "请做这件事" },
            { role: "user", content: LANGUAGE_BLOCK_ZH },
          ] as never,
        }),
      });
      const r = await task.execute({ description: "d", prompt: "survey the auth module" });
      expect(r.isError).toBeFalsy();
      const brief = inputs[0]!.messages.at(-1);
      expect(brief?.content.endsWith(`\n\n${LANGUAGE_BLOCK_ZH}`)).toBe(true);
      expect(brief?.content.startsWith("survey the auth module")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("a parent transcript without the block leaves the brief untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "m47-lang-"));
    try {
      const inputs: ModelInput[] = [];
      const registry = createSessionRegistry();
      const task = createAgentsTaskTool({
        model: recordingModel(inputs),
        allTools: ALL_TOOLS as unknown as Tool[],
        registry,
        workspaceRoot: root,
        runId: "m47-lang",
        defaultEffort: "off",
        getForkContext: () => ({
          systemPrompt: "parent",
          tools: [],
          messages: [{ role: "user", content: "do it" }] as never,
        }),
      });
      await task.execute({ description: "d", prompt: "survey the auth module" });
      expect(inputs[0]!.messages.at(-1)?.content).toBe("survey the auth module");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("no fork context available (headless embedders) → no inheritance, no crash", async () => {
    const root = await mkdtemp(join(tmpdir(), "m47-lang-"));
    try {
      const inputs: ModelInput[] = [];
      const registry = createSessionRegistry();
      const task = createAgentsTaskTool({
        model: recordingModel(inputs),
        allTools: ALL_TOOLS as unknown as Tool[],
        registry,
        workspaceRoot: root,
        runId: "m47-lang",
        defaultEffort: "off",
      });
      const r = await task.execute({ description: "d", prompt: "survey" });
      expect(r.isError).toBeFalsy();
      expect(inputs[0]!.messages.at(-1)?.content).toBe("survey");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

// ---------------------------------------------------------------------------
// 夜移 012 (Reasonix reasoning_language.go) — the reasoning-language transient
// block: a SECOND knob, separate from the M47 response block. Reasoning models
// often think in English while answering in Chinese; the directive constrains
// the visible thinking text only, never the final-answer language.
// ---------------------------------------------------------------------------

describe("reasoningBlockFor / resolveReasoningLanguageMode (夜移 012)", () => {
  it("auto rides the SAME detector as the response block: Chinese prompt → zh, English → none", () => {
    expect(reasoningBlockFor("请总结这个项目", "auto")).toBe(REASONING_BLOCK_ZH);
    expect(reasoningBlockFor("summarize this project", "auto")).toBeUndefined();
    // The detector's code-fence strip still applies: an English shell around
    // a Chinese comment must not fire the reasoning directive.
    expect(reasoningBlockFor("fix this\n```js\n// 少量中文\n```\nplease", "auto")).toBeUndefined();
  });

  it("zh / en force unconditionally; off disables", () => {
    expect(reasoningBlockFor("summarize this", "zh")).toBe(REASONING_BLOCK_ZH);
    expect(reasoningBlockFor("请总结", "en")).toBe(REASONING_BLOCK_EN);
    expect(reasoningBlockFor("请总结", "off")).toBeUndefined();
  });

  it("the zh wording is imperative: first token, whole turn, code verbatim, answer language untouched", () => {
    // Reasonix's measured lesson: soft "偏好……请使用" phrasing loses the
    // first reasoning segment on prompts that embed English logs/code.
    expect(REASONING_BLOCK_ZH).toContain("第一个字");
    expect(REASONING_BLOCK_ZH).toContain("整轮保持");
    expect(REASONING_BLOCK_ZH).toContain("保持原文");
    expect(REASONING_BLOCK_ZH).toContain("不改变最终回答语言");
    expect(REASONING_BLOCK_ZH).not.toMatch(/如果可以|尽量|prefer/i);
    // The en directive mirrors the same contract in English.
    expect(REASONING_BLOCK_EN).toContain("from the first token");
    expect(REASONING_BLOCK_EN).toContain("whole turn");
    expect(REASONING_BLOCK_EN).toContain("verbatim");
    expect(REASONING_BLOCK_EN).toContain("does not change the final answer language");
    // House envelope: single line, the [reasoning-language: prefix — the
    // inheritance scan stays a prefix/equality check.
    expect(REASONING_BLOCK_ZH.startsWith("[reasoning-language: ")).toBe(true);
    expect(REASONING_BLOCK_EN.startsWith("[reasoning-language: ")).toBe(true);
    expect(REASONING_BLOCK_ZH.endsWith("]")).toBe(true);
  });

  it("WUDAO_REASONING_LANGUAGE maps zh/en/off; junk → auto; WUDAO_NO_LANGUAGE ablates", () => {
    expect(resolveReasoningLanguageMode({})).toBe("auto");
    expect(resolveReasoningLanguageMode({ WUDAO_REASONING_LANGUAGE: "" })).toBe("auto");
    expect(resolveReasoningLanguageMode({ WUDAO_REASONING_LANGUAGE: "junk" })).toBe("auto");
    expect(resolveReasoningLanguageMode({ WUDAO_REASONING_LANGUAGE: "zh" })).toBe("zh");
    expect(resolveReasoningLanguageMode({ WUDAO_REASONING_LANGUAGE: "cn" })).toBe("zh");
    expect(resolveReasoningLanguageMode({ WUDAO_REASONING_LANGUAGE: "chinese" })).toBe("zh");
    expect(resolveReasoningLanguageMode({ WUDAO_REASONING_LANGUAGE: "中文" })).toBe("zh");
    expect(resolveReasoningLanguageMode({ WUDAO_REASONING_LANGUAGE: "en" })).toBe("en");
    expect(resolveReasoningLanguageMode({ WUDAO_REASONING_LANGUAGE: "english" })).toBe("en");
    expect(resolveReasoningLanguageMode({ WUDAO_REASONING_LANGUAGE: "off" })).toBe("off");
    expect(resolveReasoningLanguageMode({ WUDAO_REASONING_LANGUAGE: "0" })).toBe("off");
    // M53 §5 ablation wins over EVERYTHING — including a forced language.
    expect(resolveReasoningLanguageMode({ WUDAO_NO_LANGUAGE: "1", WUDAO_REASONING_LANGUAGE: "zh" })).toBe("off");
  });

  it("transcriptReasoningBlock returns the exact variant the parent used", () => {
    expect(transcriptReasoningBlock([{ role: "user", content: REASONING_BLOCK_ZH }])).toBe(REASONING_BLOCK_ZH);
    expect(transcriptReasoningBlock([{ role: "user", content: REASONING_BLOCK_EN }])).toBe(REASONING_BLOCK_EN);
    // Exact-match only: user-authored lookalikes never read as a directive.
    expect(transcriptReasoningBlock([{ role: "user", content: "[reasoning-language: 中文思考]" }])).toBeUndefined();
    expect(transcriptReasoningBlock([{ role: "user", content: "hello" }])).toBeUndefined();
    expect(transcriptReasoningBlock([{ role: "assistant", content: REASONING_BLOCK_ZH }])).toBeUndefined();
  });
});

describe("AgentDriver — reasoning-language transient block (夜移 012)", () => {
  it("Chinese auto appends [language] then [reasoning-language] at the turn tail", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "好的" }]);
    const inputs: ModelInput[] = [];
    const wrapped = {
      async generate(input: ModelInput) {
        inputs.push({ ...input, messages: [...input.messages], tools: [...input.tools] });
        return model.generate(input);
      },
    };
    const driver = createAgentDriver({
      model: wrapped,
      tools: [stubTool()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      languageBlock: "auto",
      reasoningLanguage: "auto",
      onPermissionAsk: async () => ({ kind: "allow" as const }),
    });
    driver.submit("请总结这个项目");
    await until(() => !driver.getStatus().busy, "run complete");
    // Turn tail: prompt → response block → reasoning block (pure appends).
    const tail = plainBranch(driver.state.messages).slice(0, 3);
    expect(tail).toEqual([
      { role: "user", content: "请总结这个项目" },
      { role: "user", content: LANGUAGE_BLOCK_ZH },
      { role: "user", content: REASONING_BLOCK_ZH },
    ]);
    // The model's request carries the same order — prefix bytes unchanged.
    const sent = plainBranch(stripProjectedNotes(inputs[0]!.messages) as readonly unknown[]);
    expect(sent.slice(0, 3)).toEqual([
      { role: "user", content: "请总结这个项目" },
      { role: "user", content: LANGUAGE_BLOCK_ZH },
      { role: "user", content: REASONING_BLOCK_ZH },
    ]);
  });

  it("forced en rides alone: English prompt, response block off, reasoning en", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "done" }]);
    const inputs: ModelInput[] = [];
    const wrapped = {
      async generate(input: ModelInput) {
        inputs.push({ ...input, messages: [...input.messages], tools: [...input.tools] });
        return model.generate(input);
      },
    };
    const driver = createAgentDriver({
      model: wrapped,
      tools: [stubTool()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      languageBlock: "off",
      reasoningLanguage: "en",
      onPermissionAsk: async () => ({ kind: "allow" as const }),
    });
    driver.submit("summarize this project");
    await until(() => !driver.getStatus().busy, "run complete");
    expect(plainBranch(driver.state.messages).slice(0, 2)).toEqual([
      { role: "user", content: "summarize this project" },
      { role: "user", content: REASONING_BLOCK_EN },
    ]);
    const sent = plainBranch(stripProjectedNotes(inputs[0]!.messages) as readonly unknown[]);
    expect(sent.slice(0, 2)).toEqual([
      { role: "user", content: "summarize this project" },
      { role: "user", content: REASONING_BLOCK_EN },
    ]);
  });

  it("WUDAO_NO_LANGUAGE=1 ablates BOTH blocks with no opts (M53 §5)", async () => {
    process.env.WUDAO_NO_LANGUAGE = "1";
    const model = createScriptedModel([{ role: "assistant", content: "好的" }]);
    const driver = createAgentDriver({
      model,
      tools: [stubTool()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: async () => ({ kind: "allow" as const }),
    });
    driver.submit("请总结这个项目");
    await until(() => !driver.getStatus().busy, "run complete");
    expect(driver.state.messages.some((m) => m.content === LANGUAGE_BLOCK_ZH)).toBe(false);
    expect(driver.state.messages.some((m) => m.content === REASONING_BLOCK_ZH)).toBe(false);
  });
});

describe("task tool — reasoning-block inheritance (夜移 012)", () => {
  const ALL_TOOLS: readonly Tool[] = [
    buildTool({ name: "read_file", description: "read", parameters: { type: "object", properties: {} }, execute: async () => ({ content: "ok" }) }),
  ];

  function recordingModel(inputs: ModelInput[]): ModelClient {
    return {
      async generate(input: ModelInput) {
        inputs.push({ ...input, messages: [...input.messages], tools: [...input.tools] });
        return { role: "assistant", content: "child done" };
      },
    };
  }

  it("a parent carrying the zh reasoning block passes THAT variant to the child brief", async () => {
    const root = await mkdtemp(join(tmpdir(), "m12-reason-"));
    try {
      const inputs: ModelInput[] = [];
      const registry = createSessionRegistry();
      const task = createAgentsTaskTool({
        model: recordingModel(inputs),
        allTools: ALL_TOOLS as unknown as Tool[],
        registry,
        workspaceRoot: root,
        runId: "m12-reason",
        defaultEffort: "off",
        getForkContext: () => ({
          systemPrompt: "parent",
          tools: [],
          messages: [
            { role: "user", content: "请做这件事" },
            { role: "user", content: REASONING_BLOCK_ZH },
          ] as never,
        }),
      });
      const r = await task.execute({ description: "d", prompt: "survey the auth module" });
      expect(r.isError).toBeFalsy();
      const brief = inputs[0]!.messages.at(-1);
      expect(brief?.content.endsWith(`\n\n${REASONING_BLOCK_ZH}`)).toBe(true);
      expect(brief?.content.endsWith(REASONING_BLOCK_EN)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("a parent carrying the en variant passes en (variant-aware, not hardcoded zh)", async () => {
    const root = await mkdtemp(join(tmpdir(), "m12-reason-"));
    try {
      const inputs: ModelInput[] = [];
      const registry = createSessionRegistry();
      const task = createAgentsTaskTool({
        model: recordingModel(inputs),
        allTools: ALL_TOOLS as unknown as Tool[],
        registry,
        workspaceRoot: root,
        runId: "m12-reason",
        defaultEffort: "off",
        getForkContext: () => ({
          systemPrompt: "parent",
          tools: [],
          messages: [
            { role: "user", content: "mixed 中文 prompt" },
            { role: "user", content: REASONING_BLOCK_EN },
          ] as never,
        }),
      });
      await task.execute({ description: "d", prompt: "survey the auth module" });
      expect(inputs[0]!.messages.at(-1)?.content.endsWith(`\n\n${REASONING_BLOCK_EN}`)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("a parent with only the M47 response block passes NO reasoning line", async () => {
    const root = await mkdtemp(join(tmpdir(), "m12-reason-"));
    try {
      const inputs: ModelInput[] = [];
      const registry = createSessionRegistry();
      const task = createAgentsTaskTool({
        model: recordingModel(inputs),
        allTools: ALL_TOOLS as unknown as Tool[],
        registry,
        workspaceRoot: root,
        runId: "m12-reason",
        defaultEffort: "off",
        getForkContext: () => ({
          systemPrompt: "parent",
          tools: [],
          messages: [
            { role: "user", content: "请做这件事" },
            { role: "user", content: LANGUAGE_BLOCK_ZH },
          ] as never,
        }),
      });
      await task.execute({ description: "d", prompt: "survey" });
      const brief = inputs[0]!.messages.at(-1)?.content ?? "";
      expect(brief.endsWith(REASONING_BLOCK_ZH)).toBe(false);
      expect(brief.endsWith(REASONING_BLOCK_EN)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
