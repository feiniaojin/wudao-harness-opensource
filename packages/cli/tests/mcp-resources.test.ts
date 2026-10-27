// P0-2（96 队列 #2）MCP resources 面 — 测试先行。
//
// 移植自 CC ReadMcpResourceTool / ListMcpResourcesTool，落到 wudao 的
// mcp__<server>__* 桥上：resources/list、resources/read 直接骑
// JsonRpcClient.request（协议层零改），工具面由 initialize 的
// capabilities.resources 决定（byte-stable：能力缺失不注册）。
import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import {
  loadMcpTools,
  closeMcpTools,
  mcpResourceTools,
  renderResourceList,
  renderResourceContents,
  mcpRuntimeSnapshot,
} from "../src/mcp/tools.js";
import type { McpConfig } from "../src/mcp/config.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));

/** 能力声明的 fixture（FAKE_RESOURCES=1 → initialize 带 resources 能力）。 */
function resourcesConfig(extraEnv: Record<string, string> = {}): McpConfig {
  return {
    servers: {
      fake: { command: process.execPath, args: [FIXTURE], env: { FAKE_RESOURCES: "1", ...extraEnv } },
    },
  };
}

afterEach(async () => {
  await closeMcpTools(); // drain the registry between tests
});

describe("能力门控 —— 工具面 byte-stable（能力决定工具集）", () => {
  it("capabilities.resources 缺失 → 两只资源工具不注册", async () => {
    const tools = await loadMcpTools({ servers: { fake: { command: process.execPath, args: [FIXTURE] } } });
    try {
      expect(tools.some((t) => t.name === "mcp__fake__list_resources" || t.name === "mcp__fake__read_resource")).toBe(false);
    } finally {
      await closeMcpTools();
    }
  });

  it("capabilities.resources 声明 → 注册 list_resources + read_resource", async () => {
    const tools = await loadMcpTools(resourcesConfig());
    try {
      const list = tools.find((t) => t.name === "mcp__fake__list_resources");
      const read = tools.find((t) => t.name === "mcp__fake__read_resource");
      expect(list).toBeDefined();
      expect(read).toBeDefined();
      // 参数面：list 无参；read 必填 uri(string)。
      expect(list?.parameters).toEqual({ type: "object", properties: {} });
      expect(read?.parameters.required).toEqual(["uri"]);
      expect(read?.parameters.properties["uri"]?.type).toBe("string");
    } finally {
      await closeMcpTools();
    }
  });

  it("风险标注沿用 mcp__ 桥的保守姿态：非只读、非并发安全、open-world", async () => {
    const tools = await loadMcpTools(resourcesConfig());
    try {
      for (const name of ["mcp__fake__list_resources", "mcp__fake__read_resource"]) {
        const tool = tools.find((t) => t.name === name);
        if (!tool) throw new Error(`${name} 未注册`);
        expect(tool.isReadOnly?.({})).toBe(false);
        expect(tool.isConcurrencySafe?.({})).toBe(false);
        expect(tool.isOpenWorld?.({})).toBe(true);
      }
    } finally {
      await closeMcpTools();
    }
  });
});

describe("list_resources —— 列目录渲染", () => {
  it("resources/list 渲染为紧凑清单：uri [mime] 名称：描述", async () => {
    const tools = await loadMcpTools(resourcesConfig());
    try {
      const list = tools.find((t) => t.name === "mcp__fake__list_resources");
      if (!list) throw new Error("mcp__fake__list_resources 未注册");
      const result = await list.execute({});
      expect(result.isError).toBeFalsy();
      expect(result.provenance).toBe("mcp");
      expect(result.content).toContain(`3 个资源来自 MCP 服务器 "fake"：`);
      expect(result.content).toContain("- memo://notes/todo [text/markdown] todo.md：今天要做什么");
      expect(result.content).toContain("- memo://notes/done [text/markdown] done.md");
      expect(result.content).toContain("- config://app app-config：运行时配置"); // 无 mime → 无方括号
    } finally {
      await closeMcpTools();
    }
  });

  it("脏数据边界：资源名/描述经 sanitizeMcpText（ESC/U+FFFD 不进上下文）", () => {
    const out = renderResourceList("s", [{ uri: "u://x", name: "a\x1bb\ufffdc" }]);
    expect(out.includes("\x1b")).toBe(false);
    expect(out.includes("\ufffd")).toBe(false);
    expect(out).toContain("u://x");
  });

  it("容忍形态：非数组/空数组/缺 uri 条目", () => {
    const empty = `MCP 服务器 "s" 没有声明资源（服务器仍可能提供工具）。`;
    expect(renderResourceList("s", undefined)).toBe(empty);
    expect(renderResourceList("s", {})).toBe(empty);
    expect(renderResourceList("s", [])).toBe(empty);
    expect(renderResourceList("s", [{ name: "无uri" }, { uri: "ok://1", name: "n" }])).toContain("- ok://1 n");
  });
});

describe("read_resource —— uri 读取", () => {
  it("resources/read 的文本内容按块渲染（uri + mimeType 头 + 正文）", async () => {
    const tools = await loadMcpTools(resourcesConfig());
    try {
      const read = tools.find((t) => t.name === "mcp__fake__read_resource");
      if (!read) throw new Error("mcp__fake__read_resource 未注册");
      const result = await read.execute({ uri: "memo://notes/todo" });
      expect(result.isError).toBeFalsy();
      expect(result.provenance).toBe("mcp");
      expect(result.content).toContain("[memo://notes/todo text/markdown]");
      expect(result.content).toContain("# 待办");
    } finally {
      await closeMcpTools();
    }
  });

  it("多内容数组逐块渲染（每块带自己的 uri）", async () => {
    const tools = await loadMcpTools(resourcesConfig());
    try {
      const read = tools.find((t) => t.name === "mcp__fake__read_resource");
      const result = await read?.execute({ uri: "multi://two" }) ?? { content: "(missing)" };
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain("[multi://two#1 text/plain]");
      expect(result.content).toContain("第一段");
      expect(result.content).toContain("[multi://two#2]");
      expect(result.content).toContain("第二段");
    } finally {
      await closeMcpTools();
    }
  });

  it("脏文本经 sanitizeMcpText（控制字符剥离、NFC 组合、U+FFFD 丢弃）", async () => {
    const tools = await loadMcpTools(resourcesConfig());
    try {
      const read = tools.find((t) => t.name === "mcp__fake__read_resource");
      const result = await read?.execute({ uri: "memo://notes/dirty" }) ?? { content: "(missing)" };
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain("abc\td\n\u00e9fg");
    } finally {
      await closeMcpTools();
    }
  });

  it("二进制 blob 只报字节数，base64 永不进入上下文", async () => {
    const tools = await loadMcpTools(resourcesConfig());
    try {
      const read = tools.find((t) => t.name === "mcp__fake__read_resource");
      const result = await read?.execute({ uri: "binary://logo" }) ?? { content: "(missing)" };
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain("binary://logo");
      expect(result.content).toContain("7 字节");
      expect(result.content.includes("ZmFr")).toBe(false); // base64 不得出现
    } finally {
      await closeMcpTools();
    }
  });

  it("超大内容套 output-caps 有界（2000 行 / 50KB + 截断标记）", async () => {
    const tools = await loadMcpTools(resourcesConfig());
    try {
      const read = tools.find((t) => t.name === "mcp__fake__read_resource");
      const result = await read?.execute({ uri: "huge://big" }) ?? { content: "(missing)" };
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain("output capped at 2000 lines / 50KB");
      expect(result.content.length).toBeLessThan(60 * 1024);
      expect(result.content).not.toContain("第 2999 行"); // 尾部被截
    } finally {
      await closeMcpTools();
    }
  });

  it("未知 uri → JSON-RPC 错误原样浮出为 fail-closed isError", async () => {
    const tools = await loadMcpTools(resourcesConfig());
    try {
      const read = tools.find((t) => t.name === "mcp__fake__read_resource");
      const result = await read?.execute({ uri: "memo://nope" }) ?? { content: "(missing)" };
      expect(result.isError).toBe(true);
      expect(result.content).toContain("unknown resource uri");
    } finally {
      await closeMcpTools();
    }
  });

  it("超时 → isError 且消息带 timed out（fail-closed 形态照 mcp 工具）", async () => {
    const tools = await loadMcpTools(resourcesConfig(), undefined, { requestMs: 80 });
    try {
      const read = tools.find((t) => t.name === "mcp__fake__read_resource");
      const result = await read?.execute({ uri: "slow://wait" }) ?? { content: "(missing)" };
      expect(result.isError).toBe(true);
      expect(result.content).toContain("timed out");
    } finally {
      await closeMcpTools();
    }
  });
});

describe("零进程接缝（mcpResourceTools / 纯渲染）", () => {
  it("deps 全接线：成功路径 onCall(false)，provenance=mcp", async () => {
    const events: boolean[] = [];
    const [list, read] = mcpResourceTools("fake", {
      list: async () => ({ resources: [{ uri: "u://1", name: "one" }] }),
      read: async () => ({ contents: [{ uri: "u://1", text: "body" }] }),
      onCall: (isError) => events.push(isError),
    });
    expect(list.name).toBe("mcp__fake__list_resources");
    expect(read.name).toBe("mcp__fake__read_resource");
    const l = await list.execute({});
    expect(l.content).toContain("- u://1 one");
    expect(events).toEqual([false]);
    const r = await read.execute({ uri: "u://1" });
    expect(r.content).toContain("body");
    expect(events).toEqual([false, false]);
  });

  it("read 缺 uri / uri 非字符串 → isError（副作用前挡下）", async () => {
    const events: boolean[] = [];
    const [, read] = mcpResourceTools("fake", {
      list: async () => ({}),
      read: async () => { throw new Error("不应触达服务器"); },
      onCall: (isError) => events.push(isError),
    });
    const missing = await read.execute({});
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain("uri");
    const notString = await read.execute({ uri: 42 });
    expect(notString.isError).toBe(true);
    expect(events).toEqual([true, true]); // 失败也计数（运行时快照的 errors 口径）
  });

  it("依赖抛错 → fail-closed isError，消息含错误文本", async () => {
    const [, read] = mcpResourceTools("fake", {
      list: async () => ({}),
      read: async () => { throw new Error("connection reset"); },
      onCall: () => {},
    });
    const result = await read.execute({ uri: "u://1" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("connection reset");
  });

  it("renderResourceContents 容忍形态：非数组/空数组", () => {
    expect(renderResourceContents("s", "u://x", undefined)).toBe(`MCP 服务器 "s" 的资源 "u://x" 返回了空内容。`);
    expect(renderResourceContents("s", "u://x", [])).toBe(`MCP 服务器 "s" 的资源 "u://x" 返回了空内容。`);
    expect(renderResourceContents("s", "u://x", {})).toBe(`MCP 服务器 "s" 的资源 "u://x" 返回了空内容。`);
  });
});

describe("运行时可观测 —— 资源调用进 /mcp 快照计数", () => {
  it("一次 list 成功 + 一次 read 失败 → calls=2 errors=1", async () => {
    const tools = await loadMcpTools(resourcesConfig());
    try {
      const list = tools.find((t) => t.name === "mcp__fake__list_resources");
      const read = tools.find((t) => t.name === "mcp__fake__read_resource");
      await list?.execute({});
      await read?.execute({ uri: "memo://nope" });
      const snap = mcpRuntimeSnapshot().get("fake");
      expect(snap?.calls).toBe(2);
      expect(snap?.errors).toBe(1);
      expect(typeof snap?.lastCallMs).toBe("number");
    } finally {
      await closeMcpTools();
    }
  });
});
