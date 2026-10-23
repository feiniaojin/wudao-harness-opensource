import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpConfig } from "../src/mcp/config.js";

function tmpCwd(): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "mcp-config-"));
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

function writeConfig(cwd: string, text: string): void {
  mkdirSync(join(cwd, ".wudao"), { recursive: true });
  writeFileSync(join(cwd, ".wudao", "mcp.json"), text, "utf8");
}

describe("loadMcpConfig", () => {
  it("missing .wudao/mcp.json → no servers, silent (optional feature)", () => {
    const { cwd, cleanup } = tmpCwd();
    const warnings: string[] = [];
    try {
      const config = loadMcpConfig(cwd, (m) => warnings.push(m));
      expect(config.servers).toEqual({});
      expect(warnings).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("valid config parses command/args/env/timeoutMs", () => {
    const { cwd, cleanup } = tmpCwd();
    try {
      writeConfig(cwd, JSON.stringify({
        servers: {
          fake: { command: "node", args: ["s.mjs"], env: { A: "b" }, timeoutMs: 5000 },
          minimal: { command: "echo" },
        },
      }));
      const config = loadMcpConfig(cwd);
      expect(config.servers["fake"]).toEqual({ command: "node", args: ["s.mjs"], env: { A: "b" }, timeoutMs: 5000 });
      expect(config.servers["minimal"]).toEqual({ command: "echo" });
    } finally {
      cleanup();
    }
  });

  it("malformed JSON → warning + no servers (never throws)", () => {
    const { cwd, cleanup } = tmpCwd();
    const warnings: string[] = [];
    try {
      writeConfig(cwd, "{ not json");
      const config = loadMcpConfig(cwd, (m) => warnings.push(m));
      expect(config.servers).toEqual({});
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toMatch(/mcp\.json/i);
    } finally {
      cleanup();
    }
  });

  it("servers not an object → warning + no servers", () => {
    const { cwd, cleanup } = tmpCwd();
    const warnings: string[] = [];
    try {
      writeConfig(cwd, JSON.stringify({ servers: ["nope"] }));
      const config = loadMcpConfig(cwd, (m) => warnings.push(m));
      expect(config.servers).toEqual({});
      expect(warnings.length).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("server entry without a string command is dropped with a warning", () => {
    const { cwd, cleanup } = tmpCwd();
    const warnings: string[] = [];
    try {
      writeConfig(cwd, JSON.stringify({ servers: { bad: { args: ["x"] }, good: { command: "echo" } } }));
      const config = loadMcpConfig(cwd, (m) => warnings.push(m));
      expect(Object.keys(config.servers)).toEqual(["good"]);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("bad");
    } finally {
      cleanup();
    }
  });
});

// P2-16a（96 队列 #16）url 型 server 条目 —— streamable HTTP transport 的
// config 面。command（stdio，字节稳定）与 url（http/https）二选一。
describe("url 型 server 条目（P2-16a）", () => {
  it("url 条目解析 url/headers/timeoutMs/alwaysLoad；同文件 stdio 条目零回归", () => {
    const { cwd, cleanup } = tmpCwd();
    const warnings: string[] = [];
    try {
      writeConfig(cwd, JSON.stringify({
        servers: {
          remote: {
            url: "https://mcp.example.com/api",
            headers: { Authorization: "Bearer tok-1", "X-Org": "acme" },
            timeoutMs: 5000,
            alwaysLoad: true,
          },
          plain: { url: "http://intranet.local:8080/mcp" },
          local: { command: "node", args: ["s.mjs"] },
        },
      }));
      const config = loadMcpConfig(cwd, (m) => warnings.push(m));
      // 精确形状断言（无判别字段注入 —— stdio 面 toEqual 纪律同款）。
      expect(config.servers["remote"]).toEqual({
        url: "https://mcp.example.com/api",
        headers: { Authorization: "Bearer tok-1", "X-Org": "acme" },
        timeoutMs: 5000,
        alwaysLoad: true,
      });
      expect(config.servers["plain"]).toEqual({ url: "http://intranet.local:8080/mcp" });
      expect(config.servers["local"]).toEqual({ command: "node", args: ["s.mjs"] });
      expect(warnings).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("command 与 url 互斥：两者都有 → fail-visible warn 跳过", () => {
    const { cwd, cleanup } = tmpCwd();
    const warnings: string[] = [];
    try {
      writeConfig(cwd, JSON.stringify({
        servers: { both: { command: "node", url: "https://x.example.com/mcp" }, good: { command: "echo" } },
      }));
      const config = loadMcpConfig(cwd, (m) => warnings.push(m));
      expect(Object.keys(config.servers)).toEqual(["good"]);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("both");
      expect(warnings[0]).toContain("mutually exclusive");
    } finally {
      cleanup();
    }
  });

  it("坏 url（非字符串/空/非 http(s) scheme/相对形态）→ warn 跳过", () => {
    const { cwd, cleanup } = tmpCwd();
    const warnings: string[] = [];
    try {
      writeConfig(cwd, JSON.stringify({
        servers: {
          ftp: { url: "ftp://files.example.com/mcp" },
          ws: { url: "ws://x/mcp" },
          relative: { url: "localhost:3000/mcp" },
          empty: { url: "" },
          notString: { url: 42 },
        },
      }));
      const config = loadMcpConfig(cwd, (m) => warnings.push(m));
      expect(config.servers).toEqual({});
      expect(warnings.length).toBe(5);
      for (const name of ["ftp", "ws", "relative", "empty", "notString"]) {
        expect(warnings.some((w) => w.includes(`"${name}"`))).toBe(true);
      }
    } finally {
      cleanup();
    }
  });

  it("headers 白名单：非 Record<string,string> / 非法头名 → warn 跳过；保留头丢弃 warn；超长值截断 warn", () => {
    const { cwd, cleanup } = tmpCwd();
    const warnings: string[] = [];
    try {
      const long = "Bearer " + "x".repeat(6000);
      writeConfig(cwd, JSON.stringify({
        servers: {
          nested: { url: "https://x.example.com/mcp", headers: { Authorization: { token: "no" } } },
          arrayOfPairs: { url: "https://x.example.com/mcp", headers: [["Authorization", "no"]] },
          badName: { url: "https://x.example.com/mcp", headers: { "Bad Header:Name": "v" } },
          valueNotString: { url: "https://x.example.com/mcp", headers: { "X-N": 7 } },
          reserved: { url: "https://x.example.com/mcp", headers: { "Content-Type": "text/plain", Accept: "*/*", "Mcp-Session-Id": "hijack", "X-Ok": "1" } },
          longValue: { url: "https://x.example.com/mcp", headers: { Authorization: long } },
        },
      }));
      const config = loadMcpConfig(cwd, (m) => warnings.push(m));
      expect(Object.keys(config.servers).sort()).toEqual(["longValue", "reserved"]);
      // 保留头（transport-owned）被丢弃，其余透传。
      expect(config.servers["reserved"]).toEqual({
        url: "https://x.example.com/mcp",
        headers: { "X-Ok": "1" },
      });
      const truncated = config.servers["longValue"]?.headers?.["Authorization"];
      expect(typeof truncated).toBe("string");
      expect((truncated ?? "").length).toBe(4096);
      expect((truncated ?? "").startsWith("Bearer ")).toBe(true);
      expect(warnings.some((w) => w.includes("reserved") && /content-type/i.test(w))).toBe(true);
      expect(warnings.some((w) => w.includes("longValue") && w.includes("truncat"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("url 条目携带 stdio 专属字段（args/env）→ warn 跳过（transport 字段不混用）", () => {
    const { cwd, cleanup } = tmpCwd();
    const warnings: string[] = [];
    try {
      writeConfig(cwd, JSON.stringify({
        servers: { mixed: { url: "https://x.example.com/mcp", args: ["--flag"], env: { A: "b" } } },
      }));
      const config = loadMcpConfig(cwd, (m) => warnings.push(m));
      expect(config.servers).toEqual({});
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("mixed");
    } finally {
      cleanup();
    }
  });
});

describe("Claude Code 格式兼容（mcpServers 别名 + 根 .mcp.json）", () => {
  function writeCcConfig(cwd: string, text: string): void {
    writeFileSync(join(cwd, ".mcp.json"), text, "utf8");
  }

  it("CC 格式 {mcpServers:{...}} 原样粘贴即可用；条目里的 CC 专属字段（type/cwd）被容忍", () => {
    const { cwd, cleanup } = tmpCwd();
    try {
      writeConfig(cwd, JSON.stringify({
        mcpServers: {
          MiniMax: { command: "uvx", args: ["minimax-coding-plan-mcp"], env: { MINIMAX_API_HOST: "https://api.minimaxi.com" } },
          typed: { type: "stdio", command: "echo", cwd: "/tmp" },
        },
      }));
      const config = loadMcpConfig(cwd);
      expect(config.servers["MiniMax"]).toEqual({
        command: "uvx",
        args: ["minimax-coding-plan-mcp"],
        env: { MINIMAX_API_HOST: "https://api.minimaxi.com" },
      });
      // 白名单校验只看已知字段——CC 的 type/cwd 不在黑名单里，条目照常收下。
      expect(config.servers["typed"]).toEqual({ command: "echo" });
    } finally {
      cleanup();
    }
  });

  it("同一文件同时有 servers 与 mcpServers → 取 servers，并 warn（fail-visible）", () => {
    const { cwd, cleanup } = tmpCwd();
    const warnings: string[] = [];
    try {
      writeConfig(cwd, JSON.stringify({
        servers: { native: { command: "echo" } },
        mcpServers: { cc: { command: "cat" } },
      }));
      const config = loadMcpConfig(cwd, (m) => warnings.push(m));
      expect(Object.keys(config.servers)).toEqual(["native"]);
      expect(warnings.some((w) => w.includes("both"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("mcpServers 形状不合法（数组/非对象）→ warn 且无服务器（与 servers 同规则）", () => {
    const { cwd, cleanup } = tmpCwd();
    const warnings: string[] = [];
    try {
      writeConfig(cwd, JSON.stringify({ mcpServers: ["nope"] }));
      const config = loadMcpConfig(cwd, (m) => warnings.push(m));
      expect(config.servers).toEqual({});
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("mcpServers");
    } finally {
      cleanup();
    }
  });

  it("项目根 .mcp.json（CC 项目文件）参与分层：global < .mcp.json < .wudao/mcp.json，同名整体替换", () => {
    const { cwd, cleanup } = tmpCwd();
    try {
      writeCcConfig(cwd, JSON.stringify({
        mcpServers: {
          shared: { command: "from-cc-root" },
          ccOnly: { command: "echo-cc" },
        },
      }));
      writeConfig(cwd, JSON.stringify({
        servers: { shared: { command: "from-wudao" } },
      }));
      const config = loadMcpConfig(cwd);
      expect(config.servers["shared"]).toEqual({ command: "from-wudao" });
      expect(config.servers["ccOnly"]).toEqual({ command: "echo-cc" });
    } finally {
      cleanup();
    }
  });
});
