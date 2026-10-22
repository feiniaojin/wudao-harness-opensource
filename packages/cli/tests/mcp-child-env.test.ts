// GUI PATH + initialize budget (0.3.39 desktop "spawn uvx ENOENT").
//
// A macOS app launched from Finder/Dock inherits launchd's bare PATH
// (/usr/bin:/bin:/usr/sbin:/sbin): ~/.local/bin (uvx) and the brew dirs
// aren't on it, so stdio servers installed there failed with ENOENT —
// and even a found uvx died exit-126 because its wrapper scripts exec
// /usr/local/bin/realpath. augmentChildPath appends the standard user
// bin dirs at spawn; these tests pin the pure function, the spawn wiring
// (augmented value actually reaches the child), and the config-override
// precedence. Plus the initialize-budget regression pin: uvx cold start
// measured 12s+, so 10s was a guaranteed false failure.
import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { augmentChildPath, JsonRpcClient } from "../src/mcp/json-rpc.js";
import { INITIALIZE_TIMEOUT_MS } from "../src/mcp/tools.js";

describe("augmentChildPath", () => {
  it("appends the standard user bin dirs to launchd's bare GUI PATH", () => {
    expect(augmentChildPath("/usr/bin:/bin:/usr/sbin:/sbin", "/Users/u")).toBe(
      "/usr/bin:/bin:/usr/sbin:/sbin:/Users/u/.local/bin:/opt/homebrew/bin:/usr/local/bin:/Users/u/bin",
    );
  });

  it("seeds a system PATH when PATH is empty or undefined", () => {
    for (const empty of [undefined, ""]) {
      const out = augmentChildPath(empty, "/Users/u");
      expect(out.startsWith("/usr/bin:/bin:/usr/sbin:/sbin")).toBe(true);
      expect(out).toContain("/Users/u/.local/bin");
      expect(out.endsWith("/Users/u/bin")).toBe(true);
    }
  });

  it("never duplicates dirs already on PATH and never reorders what exists", () => {
    // /Users/u/.local/bin already present → appended set skips it, order kept.
    expect(augmentChildPath("/Users/u/.local/bin:/usr/bin:/bin", "/Users/u")).toBe(
      "/Users/u/.local/bin:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:/Users/u/bin",
    );
  });

  it("is append-only: existing entries are never shadowed", () => {
    const out = augmentChildPath("/custom/first:/usr/bin:/bin", "/Users/u");
    expect(out.indexOf("/custom/first")).toBe(0);
  });
});

describe("JsonRpcClient spawn env", () => {
  const readChildPathViaStderr = async (env?: Record<string, string>): Promise<string> => {
    const lines: string[] = [];
    const client = new JsonRpcClient({
      command: process.execPath,
      args: ["-e", 'console.error(process.env.PATH ?? "")'],
      onStderr: (line) => lines.push(line),
      ...(env !== undefined ? { env } : {}),
    });
    const deadline = Date.now() + 10_000;
    while (lines.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await client.close();
    expect(lines.length).toBeGreaterThan(0);
    return lines[0];
  };

  it("the augmented PATH reaches the child process", async () => {
    const got = await readChildPathViaStderr();
    expect(got).toContain(`${homedir()}/.local/bin`);
    expect(got).toContain("/usr/local/bin");
  }, 20_000);

  it("an explicit PATH in the server config wins over augmentation", async () => {
    const got = await readChildPathViaStderr({ PATH: "/custom/bin" });
    expect(got).toBe("/custom/bin");
  }, 20_000);
});

describe("initialize budget", () => {
  it("default connect timeout covers a uvx cold start (≥30s)", () => {
    // 10s was the shipped default; uvx cold-cache install alone measured
    // 12s+. mcpTimeouts.connectMs can still override per deployment.
    expect(INITIALIZE_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });
});
