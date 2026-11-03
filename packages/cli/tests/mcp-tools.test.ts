import { describe, it, expect, afterEach, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { validateToolArguments } from "@wudao-org/core";
import { loadMcpTools, closeMcpTools, toMcpParameters, sanitizeMcpText, sanitizeWireToolSegment, mcpToolFromDescriptor, MAX_MCP_DESCRIPTION_CHARS } from "../src/mcp/tools.js";
import type { McpConfig } from "../src/mcp/config.js";

// 0.3.85 门 #5 教训：每个用例 loadMcpTools 都真 spawn 一个 Node 子进程
// （fakeConfig: process.execPath + fixture），单跑全文件 787ms，但门级负载
// 下一次握手跨过全局 20s。文件级默认 60s 给足余量；真挂仍然会红。
vi.setConfig({ testTimeout: 60_000 });

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));

function fakeConfig(): McpConfig {
  return { servers: { fake: { command: process.execPath, args: [FIXTURE] } } };
}

afterEach(async () => {
  await closeMcpTools(); // drain the registry between tests
});

describe("loadMcpTools", () => {
  it("lists server tools as mcp__<server>__<tool> with description + schema passthrough", async () => {
    const tools = await loadMcpTools(fakeConfig());
    try {
      expect(tools.map((t) => t.name).sort()).toEqual([
        "mcp__fake__crash", "mcp__fake__dirty", "mcp__fake__echo", "mcp__fake__fail", "mcp__fake__opaque", "mcp__fake__slow", "mcp__fake__wide",
      ]);
      const echo = tools.find((t) => t.name === "mcp__fake__echo");
      expect(echo?.description).toBe("Echo the arguments back as text");
      expect(echo?.parameters.type).toBe("object");
      expect(echo?.parameters.properties["text"]?.type).toBe("string");
      expect(echo?.parameters.required).toEqual(["text"]);
    } finally {
      await closeMcpTools();
    }
  });

  it("echo tool round-trips arguments through tools/call", async () => {
    const tools = await loadMcpTools(fakeConfig());
    try {
      const echo = tools.find((t) => t.name === "mcp__fake__echo");
      const result = await echo?.execute({ text: "hello world" }) ?? { content: "(missing)" };
      expect(result.content).toBe("hello world");
      expect(result.isError).toBeFalsy();
    } finally {
      await closeMcpTools();
    }
  });

  it("server-side isError maps to a fail-closed tool result", async () => {
    const tools = await loadMcpTools(fakeConfig());
    try {
      const fail = tools.find((t) => t.name === "mcp__fake__fail");
      const result = await fail?.execute({}) ?? { content: "(missing)" };
      expect(result.isError).toBe(true);
      expect(result.content).toContain("boom");
    } finally {
      await closeMcpTools();
    }
  });

  it("a server crash mid-call is caught and returns isError (fail-closed)", async () => {
    const tools = await loadMcpTools(fakeConfig());
    try {
      const crash = tools.find((t) => t.name === "mcp__fake__crash");
      const result = await crash?.execute({}) ?? { content: "(missing)" };
      expect(result.isError).toBe(true);
    } finally {
      await closeMcpTools();
    }
  });

  it("fail-closed risk flags: not read-only, not concurrency-safe", async () => {
    const tools = await loadMcpTools(fakeConfig());
    try {
      const echo = tools.find((t) => t.name === "mcp__fake__echo");
      expect(echo?.isReadOnly?.({})).toBe(false);
      expect(echo?.isConcurrencySafe?.({})).toBe(false);
    } finally {
      await closeMcpTools();
    }
  });

  it("a server that fails to start is skipped with a warning, not fatal", async () => {
    const warnings: string[] = [];
    const tools = await loadMcpTools(
      { servers: { nope: { command: "/nonexistent/wudao-mcp-test-binary" } } },
      (m) => warnings.push(m),
    );
    expect(tools).toEqual([]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("nope");
  });

  it("closeMcpTools shuts servers down; subsequent execute is isError", async () => {
    const tools = await loadMcpTools(fakeConfig());
    const echo = tools.find((t) => t.name === "mcp__fake__echo");
    await closeMcpTools();
    const result = await echo?.execute({ text: "x" }) ?? { content: "(missing)" };
    expect(result.isError).toBe(true);
  });

  it("non-primitive schema params are sanitized: validation passes and args are forwarded verbatim", async () => {
    const tools = await loadMcpTools(fakeConfig());
    try {
      const wide = tools.find((t) => t.name === "mcp__fake__wide");
      if (!wide) throw new Error("mcp__fake__wide not listed");
      const args = { count: 3, tags: ["a", "b"], meta: { x: 1 }, text: "hi" };
      // The core loop validates EVERY call against the tool schema — the
      // sanitized schema must let this legal call through.
      const validation = validateToolArguments(wide.parameters, args);
      expect(validation.valid).toBe(true);
      const result = await wide.execute(args);
      expect(result.isError).toBeFalsy();
      // Dropped-type params must still be FORWARDED to the server untouched.
      expect(JSON.parse(result.content)).toEqual(args);
    } finally {
      await closeMcpTools();
    }
  });

  it("a no-properties {type:\"object\"} schema with arbitrary args does not throw", async () => {
    const tools = await loadMcpTools(fakeConfig());
    try {
      const opaque = tools.find((t) => t.name === "mcp__fake__opaque");
      if (!opaque) throw new Error("mcp__fake__opaque not listed");
      const args = { anything: { nested: [1, 2] } };
      const validation = validateToolArguments(opaque.parameters, args);
      expect(validation.valid).toBe(true);
      const result = await opaque.execute(args);
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(result.content)).toEqual(args);
    } finally {
      await closeMcpTools();
    }
  });

  it("a duplicate composed tool name is suffixed -<n> with a warning", async () => {
    const warnings: string[] = [];
    const tools = await loadMcpTools(
      { servers: { fake: { command: process.execPath, args: [FIXTURE], env: { FAKE_DUPLICATE_TOOLS: "1" } } } },
      (m) => warnings.push(m),
    );
    try {
      const names = tools.map((t) => t.name).filter((n) => n.startsWith("mcp__fake__echo"));
      expect(names.sort()).toEqual(["mcp__fake__echo", "mcp__fake__echo-2"]);
      expect(warnings.some((w) => w.includes("mcp__fake__echo") && w.includes("collision"))).toBe(true);
    } finally {
      await closeMcpTools();
    }
  });
});

describe("夜移 021 — MCP text boundary hygiene (dirty server data)", () => {
  it("sanitizeMcpText strips C0 controls but keeps tab/newline/carriage-return", () => {
    expect(sanitizeMcpText("a\x00b\x01c\x08d\x0be\x0cf\x0eg\x1fh\ti\nj\rk")).toBe("abcdefgh\ti\nj\rk");
  });

  it("strips DEL and the C1 range (terminal-escape adjacent), and drops U+FFFD", () => {
    expect(sanitizeMcpText("a\x7fbc\u009fd\ufffd")).toBe("abcd");
  });

  it("NFC-normalizes decomposed forms and is idempotent", () => {
    expect(sanitizeMcpText("\u0065\u0301")).toBe("\u00e9");
    const once = sanitizeMcpText("a\x1b[31mb\u0301\ufffdr\x00");
    expect(sanitizeMcpText(once)).toBe(once);
  });

  it("tool descriptions are scrubbed and capped with a visible truncation marker", async () => {
    const tools = await loadMcpTools(fakeConfig());
    try {
      const dirty = tools.find((t) => t.name === "mcp__fake__dirty");
      if (!dirty) throw new Error("mcp__fake__dirty not listed");
      const d = dirty.description ?? "";
      // ESC gone, plain printable text intact.
      expect(d.includes("\x1b")).toBe(false);
      expect(d.startsWith("Dirty description ")).toBe(true);
      // Cap math (computed, not hand-counted): raw = "Dirty\x1b description " (19
      // chars incl. the ESC) + 3000 x → sanitize drops the ESC → 3018; cap 2048
      // → 970 truncated.
      const scrubbedLen = ("Dirty\x1b description ".length - 1) + 3000;
      const truncated = scrubbedLen - MAX_MCP_DESCRIPTION_CHARS;
      expect(truncated).toBe(970);
      expect(d.endsWith(` …(+${truncated} chars truncated)`)).toBe(true);
      expect(d.length).toBe(MAX_MCP_DESCRIPTION_CHARS + ` …(+${truncated} chars truncated)`.length);
    } finally {
      await closeMcpTools();
    }
  });

  it("tools/call text results are scrubbed (controls stripped, NFC composed, U+FFFD dropped)", async () => {
    const tools = await loadMcpTools(fakeConfig());
    try {
      const dirty = tools.find((t) => t.name === "mcp__fake__dirty");
      if (!dirty) throw new Error("mcp__fake__dirty not listed");
      const result = await dirty.execute({});
      expect(result.isError).toBeFalsy();
      // a\x00b\x1bc\td\ne+U+0301 f U+FFFD g\x7f → "abc\td\néfg".
      expect(result.content).toBe("abc\td\n\u00e9fg");
    } finally {
      await closeMcpTools();
    }
  });

  it("mcpToolFromDescriptor: zero-process seam — both lanes scrubbed, deps wired", async () => {
    const events: boolean[] = [];
    const tool = mcpToolFromDescriptor("fake", {
      name: "dirty",
      description: "D\x1b" + "y".repeat(4000),
    }, {
      call: async () => ({ content: [{ type: "text", text: "z\x1b[2Jse\u0301t" }], isError: false }),
      onCall: (isError) => events.push(isError),
    });
    expect(tool.name).toBe("mcp__fake__dirty");
    expect(tool.description?.includes("\x1b")).toBe(false);
    expect(tool.description?.endsWith(` …(+${("D\x1b".length - 1) + 4000 - MAX_MCP_DESCRIPTION_CHARS} chars truncated)`)).toBe(true);
    const result = await tool.execute({});
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("z[2Js\u00e9t"); // ESC stripped, decomposed composed by NFC
    expect(events).toEqual([false]);
  });

  it("mcpToolFromDescriptor: server isError maps to fail-closed with scrubbed text", async () => {
    const events: boolean[] = [];
    const tool = mcpToolFromDescriptor("fake", { name: "dirt" }, {
      call: async () => ({ content: [{ type: "text", text: "bad\x00 stuff" }], isError: true }),
      onCall: (isError) => events.push(isError),
    });
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toBe("bad stuff");
    expect(events).toEqual([true]);
    // Fallback description lane passes the same boundary (local, short — no-op).
    expect(tool.description).toBe(`Tool "dirt" from MCP server "fake"`);
  });

  // 0.3.81 实机回执：`Invalid 'tools[N].function.name' … ^[a-zA-Z0-9_-]+$`
  // —— 服务端点号/中文/空格等一个非法字符把整个 provider 请求 400。
  it("wire-name sanitation: dotted/CJK ids fold to [a-zA-Z0-9_-]; the tools/call payload keeps the ORIGINAL tool id", async () => {
    expect(sanitizeWireToolSegment("github.mcp", "server")).toBe("github_mcp");
    expect(sanitizeWireToolSegment("搜索 文档", "tool")).toBe("tool"); // 全非法 → fallback（裸 _ 段更差）
    expect(sanitizeWireToolSegment("search docs", "tool")).toBe("search_docs");
    expect(sanitizeWireToolSegment("fine_name-1", "tool")).toBe("fine_name-1"); // 合法名零触
    expect(sanitizeWireToolSegment("///", "fallback")).toBe("fallback");
    const seen: string[] = [];
    const tool = mcpToolFromDescriptor("github.mcp", { name: "search.code.v2" }, {
      call: async () => {
        seen.push("called");
        return { content: [], isError: false };
      },
      onCall: () => {},
    });
    expect(tool.name).toBe("mcp__github_mcp__search_code_v2"); // 提供商可接受
    expect(tool.description).toContain("search.code.v2"); // 人类可溯源原 id
    await tool.execute({});
    expect(seen).toEqual(["called"]); // 闭包未被净化影响（call 由 connectServer 用原 id 寻址）
  });
});

describe("toMcpParameters (schema shape validation)", () => {
  it("passes a valid object schema through untouched", () => {
    const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
    expect(toMcpParameters(schema)).toEqual(schema);
  });

  it("wraps non-object schemas as a no-args tool schema", () => {
    expect(toMcpParameters("not a schema")).toEqual({ type: "object", properties: {} });
    expect(toMcpParameters({ type: "array" })).toEqual({ type: "object", properties: {} });
    expect(toMcpParameters(undefined)).toEqual({ type: "object", properties: {} });
    expect(toMcpParameters(null)).toEqual({ type: "object", properties: {} });
  });

  it("sanitizes at the boundary: drops non-primitive params, guarantees properties, strips additionalProperties", () => {
    const sanitized = toMcpParameters({
      type: "object",
      properties: {
        s: { type: "string" },
        n: { type: "number" },
        b: { type: "boolean" },
        i: { type: "integer" },
        arr: { type: "array", items: { type: "string" } },
        obj: { type: "object", properties: { x: { type: "string" } } },
        noType: { description: "typeless" },
      },
      required: ["s", "i"],
      additionalProperties: false,
    });
    expect(sanitized).toEqual({ type: "object", properties: { s: { type: "string" }, n: { type: "number" }, b: { type: "boolean" } }, required: ["s"] });
    // Every legal call shape survives core validation against the sanitized schema.
    expect(validateToolArguments(sanitized, { s: "x", i: 3, arr: [], obj: {} }).valid).toBe(true);
    expect(validateToolArguments(sanitized, { s: "x" }).valid).toBe(true);
    expect(validateToolArguments(sanitized, { s: 1 }).valid).toBe(false);
  });

  it("guarantees properties is an object even when the raw schema omits it or sets garbage", () => {
    expect(toMcpParameters({ type: "object" })).toEqual({ type: "object", properties: {} });
    expect(toMcpParameters({ type: "object", properties: null })).toEqual({ type: "object", properties: {} });
    expect(toMcpParameters({ type: "object", properties: "junk" })).toEqual({ type: "object", properties: {} });
    expect(validateToolArguments(toMcpParameters({ type: "object" }), { any: "thing" }).valid).toBe(true);
  });
});
