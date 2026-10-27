// MCP visibility — the driver's mcpList op (the settings page's MCP tab,
// 2026-08-31 用户反馈「配置之后，根本不知道自己有什么 mcp」): the three
// tiers' EFFECTIVE entries with tier source + replacement receipts, secrets
// never on the wire (env map absent, http url redacted), per-tier load
// warnings surfaced, and the runtime lane defaulting to 未连接 when the
// bridge has no entry (lazy load — not an error).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsOps } from "../src/driver/settings-ops.js";

let home: string;
let savedHome: string | undefined;
let ws: string;

beforeAll(() => {
  savedHome = process.env.WUDAO_GLOBAL_HOME;
  home = mkdtempSync(join(tmpdir(), "wudao-mcplist-home-"));
  process.env.WUDAO_GLOBAL_HOME = home;
  ws = mkdtempSync(join(tmpdir(), "wudao-mcplist-ws-"));
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.WUDAO_GLOBAL_HOME;
  else process.env.WUDAO_GLOBAL_HOME = savedHome;
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const ops = () => createSettingsOps({ env: process.env, workspaceRoot: ws });

describe("mcpList — the settings page's MCP read", () => {
  it("lists every tier's effective entries with source, display command, and no secrets", async () => {
    writeFileSync(join(home, "mcp.json"), JSON.stringify({
      mcpServers: {
        MiniMax: { command: "uvx", args: ["minimax-coding-plan-mcp"], env: { MINIMAX_API_KEY: "sk-secret" } },
        shadowed: { command: "global-one" },
      },
    }), "utf8");
    writeFileSync(join(ws, ".mcp.json"), JSON.stringify({
      mcpServers: { remote: { type: "http", url: "https://user:pw@x.example.com/mcp?token=t" } },
    }), "utf8");
    mkdirSync(join(ws, ".wudao"), { recursive: true });
    writeFileSync(join(ws, ".wudao", "mcp.json"), JSON.stringify({
      servers: { shadowed: { command: "node", args: ["s.mjs"] } },
    }), "utf8");

    const out = await ops().mcpList();
    // Effective entries across all three tiers, no per-name duplicates.
    expect(out.servers.map((s) => `${s.tier}:${s.name}`).sort()).toEqual([
      "project:shadowed", "root:remote", "user:MiniMax",
    ]);
    // stdio row: process-visible command line only — the env map is GONE.
    const mm = out.servers.find((s) => s.name === "MiniMax");
    expect(mm).toMatchObject({ tier: "user", transport: "stdio", command: "uvx minimax-coding-plan-mcp", replaces: [], connected: false, tools: 0 });
    // http row: the REDACTED url (userinfo + query stripped by redactUrl).
    expect(out.servers.find((s) => s.name === "remote")?.command).toBe("https://x.example.com/mcp");
    // Replacement: the project entry wins and receipts the user-tier entry.
    expect(out.servers.find((s) => s.name === "shadowed")).toMatchObject({ tier: "project", command: "node s.mjs", replaces: ["user"] });
    // Secrets never ride: the key exists in the config file but not the wire.
    expect(JSON.stringify(out)).not.toContain("sk-secret");
    // The three file paths ride for the tab's hints.
    expect(out.files).toEqual({ user: join(home, "mcp.json"), root: join(ws, ".mcp.json"), project: join(ws, ".wudao", "mcp.json") });
    expect(out.warnings).toEqual([]);
  });

  it("empty config → empty list, no warnings; malformed tier → the warning names the file", async () => {
    const bare = mkdtempSync(join(tmpdir(), "wudao-mcplist-bare-"));
    try {
      // Isolate from the first test's global-tier file.
      rmSync(join(home, "mcp.json"), { force: true });
      const out = await createSettingsOps({ env: process.env, workspaceRoot: bare }).mcpList();
      expect(out.servers).toEqual([]);
      expect(out.warnings).toEqual([]);
      writeFileSync(join(bare, ".mcp.json"), "{ not json", "utf8");
      const bad = await createSettingsOps({ env: process.env, workspaceRoot: bare }).mcpList();
      expect(bad.warnings.length).toBe(1);
      expect(bad.warnings[0]).toContain(".mcp.json");
    } finally {
      rmSync(bare, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
