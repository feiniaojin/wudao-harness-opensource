// M19: .wudao/settings.json hooks loader + command bridge.
// Loader tests use tmpdir workspaces; bridge tests run tiny fixture scripts
// (tests/fixtures/*.sh) with execFile semantics (no shell).
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHooksSettings, buildConfiguredHooks, resetSettingsWarnMemoForTests } from "../src/hooks-config.js";
import type { AgentState } from "@wudao-org/core";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

// Test logger: collects warnings so assertions never depend on stderr.
function collector(): { warn: (m: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (m: string) => messages.push(m), messages };
}

async function tmpWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wudao-hooks-"));
  await mkdir(join(dir, ".wudao"), { recursive: true });
  return dir;
}

async function writeSettings(root: string, text: string): Promise<void> {
  await writeFile(join(root, ".wudao", "settings.json"), text, "utf8");
}

describe("loadHooksSettings", () => {
  it("returns {} (no warnings) when settings.json is missing", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      expect(await loadHooksSettings(root, log.warn)).toEqual({});
      expect(log.messages).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("returns {} for an empty/whitespace-only file", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeSettings(root, "   \n");
      expect(await loadHooksSettings(root, log.warn)).toEqual({});
      expect(log.messages).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("warns and returns {} on malformed JSON", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeSettings(root, "{ not json");
      expect(await loadHooksSettings(root, log.warn)).toEqual({});
      expect(log.messages.length).toBe(1);
      expect(log.messages[0]).toContain("settings.json");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("warns and returns {} when hooks is not an object", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeSettings(root, JSON.stringify({ hooks: ["nope"] }));
      expect(await loadHooksSettings(root, log.warn)).toEqual({});
      expect(log.messages.length).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("warns listing unknown hook events but keeps recognized ones", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeSettings(root, JSON.stringify({
        hooks: {
          onRunStart: [{ command: "true" }],
          onPreCompact: [{ command: "true" }],
          onPromptSubmit: [{ command: "tr a-z A-Z" }],
        },
      }));
      const settings = await loadHooksSettings(root, log.warn);
      expect(settings.onPromptSubmit).toEqual([{ command: "tr a-z A-Z" }]);
      expect(settings.onRunStart).toBeUndefined();
      expect(log.messages.length).toBe(1);
      expect(log.messages[0]).toContain("onRunStart");
      expect(log.messages[0]).toContain("onPreCompact");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("warns on unknown top-level keys but keeps hooks; permissions is known (M33)", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeSettings(root, JSON.stringify({
        permissions: { allow: ["shell"] },
        banana: 1,
        hooks: { onRunStop: [{ command: "true" }] },
      }));
      const settings = await loadHooksSettings(root, log.warn);
      expect(settings.onRunStop).toEqual([{ command: "true" }]);
      expect(log.messages.length).toBe(1);
      expect(log.messages[0]).toContain("banana");
      expect(log.messages.some((m) => m.includes("permissions"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("drops malformed hook entries with a warning, keeps valid ones", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeSettings(root, JSON.stringify({
        hooks: { onPromptSubmit: [{ command: "tr a-z A-Z" }, { nope: 1 }, "plain string"] },
      }));
      const settings = await loadHooksSettings(root, log.warn);
      expect(settings.onPromptSubmit).toEqual([{ command: "tr a-z A-Z" }]);
      expect(log.messages.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("parses timeoutMs when it is a positive finite number", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeSettings(root, JSON.stringify({
        hooks: {
          onPromptSubmit: [{ command: "tr a-z A-Z", timeoutMs: 2500 }],
          onRunStop: [{ command: "true", timeoutMs: "nope" }],
        },
      }));
      const settings = await loadHooksSettings(root, log.warn);
      expect(settings.onPromptSubmit).toEqual([{ command: "tr a-z A-Z", timeoutMs: 2500 }]);
      expect(settings.onRunStop).toEqual([{ command: "true" }]);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("buildConfiguredHooks", () => {
  it("returns undefined when no hooks are configured", () => {
    const log = collector();
    expect(buildConfiguredHooks({}, { workspaceRoot: process.cwd(), warn: log.warn })).toBeUndefined();
    expect(buildConfiguredHooks({ onPromptSubmit: [], onRunStop: [] }, { workspaceRoot: process.cwd(), warn: log.warn })).toBeUndefined();
  }, 20000);

  it("rewrites the prompt to the hook's stdout; the next hook sees the rewritten prompt", async () => {
    const log = collector();
    const hooks = buildConfiguredHooks(
      {
        onPromptSubmit: [
          { command: join(FIXTURES, "upper.sh") },
          { command: join(FIXTURES, "append-bang.sh") },
        ],
      },
      { workspaceRoot: process.cwd(), warn: log.warn },
    );
    expect(hooks?.onPromptSubmit).toBeDefined();
    const result = await hooks?.onPromptSubmit?.("hello world");
    // upper.sh → "HELLO WORLD"; append-bang.sh sees that rewritten value.
    expect(result).toBe("HELLO WORLD!");
  }, 20000);

  it("keeps the original prompt when the hook prints nothing", async () => {
    const log = collector();
    const hooks = buildConfiguredHooks(
      { onPromptSubmit: [{ command: join(FIXTURES, "ok.sh") }] },
      { workspaceRoot: process.cwd(), warn: log.warn },
    );
    expect(await hooks?.onPromptSubmit?.("stay the same")).toBe("stay the same");
  }, 20000);

  it("blocks with the stderr first line when a prompt hook exits non-zero", async () => {
    const log = collector();
    const hooks = buildConfiguredHooks(
      { onPromptSubmit: [{ command: join(FIXTURES, "block.sh") }] },
      { workspaceRoot: process.cwd(), warn: log.warn },
    );
    expect(await hooks?.onPromptSubmit?.("hello")).toEqual({
      block: true,
      reason: "blocked by fixture",
    });
  }, 20000);

  it("blocks with a generic reason when a prompt hook exits non-zero with empty stderr", async () => {
    const log = collector();
    const hooks = buildConfiguredHooks(
      { onPromptSubmit: [{ command: join(FIXTURES, "block-silent.sh") }] },
      { workspaceRoot: process.cwd(), warn: log.warn },
    );
    expect(await hooks?.onPromptSubmit?.("hello")).toEqual({ block: true, reason: "blocked by hook" });
  }, 20000);

  it("treats a timed-out hook as allow/original with a warning (never blocks)", async () => {
    const log = collector();
    const hooks = buildConfiguredHooks(
      { onPromptSubmit: [{ command: join(FIXTURES, "sleep.sh"), timeoutMs: 150 }] },
      { workspaceRoot: process.cwd(), warn: log.warn },
    );
    expect(await hooks?.onPromptSubmit?.("original")).toBe("original");
    expect(log.messages.length).toBe(1);
    expect(log.messages[0]).toContain("超时"); // ω99-207 钉随源演进（超时词面中文化）
    expect(log.messages[0]).toContain("sleep.sh");
  }, 20000);

  it("treats a spawn failure (ENOENT) as allow/original with a warning", async () => {
    const log = collector();
    const hooks = buildConfiguredHooks(
      { onPromptSubmit: [{ command: "wudao-no-such-binary-xyz --flag" }] },
      { workspaceRoot: process.cwd(), warn: log.warn },
    );
    expect(await hooks?.onPromptSubmit?.("original")).toBe("original");
    expect(log.messages.length).toBe(1);
    expect(log.messages[0]).toContain("wudao-no-such-binary-xyz");
  }, 20000);

  it("skips an empty command with a warning", async () => {
    const log = collector();
    const hooks = buildConfiguredHooks(
      { onPromptSubmit: [{ command: "   " }] },
      { workspaceRoot: process.cwd(), warn: log.warn },
    );
    expect(await hooks?.onPromptSubmit?.("original")).toBe("original");
    expect(log.messages.some((m) => m.includes("已跳过"))).toBe(true); // ω99-207 钉随源演进（空命令跳过词面中文化）
  }, 20000);

  it("blocks onRunStop when a stop hook exits non-zero; allow when all exit zero", async () => {
    const log = collector();
    const state: AgentState = {
      systemPrompt: "",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "done" },
      ],
      tools: [],
      status: "idle",
    };
    const blocking = buildConfiguredHooks(
      { onRunStop: [{ command: join(FIXTURES, "block.sh") }] },
      { workspaceRoot: process.cwd(), warn: log.warn },
    );
    expect(await blocking?.onRunStop?.(state)).toEqual({ block: true, reason: "blocked by fixture" });

    const allowing = buildConfiguredHooks(
      { onRunStop: [{ command: join(FIXTURES, "ok.sh") }] },
      { workspaceRoot: process.cwd(), warn: log.warn },
    );
    expect(await allowing?.onRunStop?.(state)).toBe("allow");
  }, 20000);

  it("receives a JSON payload on stdin describing the stop event", async () => {
    const log = collector();
    // dump-stdin.sh echoes its stdin back out — used as a prompt hook here so
    // the echoed payload becomes the rewritten "prompt" we can assert on.
    const hooks = buildConfiguredHooks(
      { onPromptSubmit: [{ command: join(FIXTURES, "cat.sh") }] },
      { workspaceRoot: process.cwd(), warn: log.warn },
    );
    const result = await hooks?.onPromptSubmit?.("payload-check");
    expect(result).toBe("payload-check");
  }, 20000);
});

// ---------------------------------------------------------------------------
// M33 §2: onPreToolUse / onPostToolUse command bridge.
// ---------------------------------------------------------------------------

describe("buildConfiguredHooks — tool-use events (M33)", () => {
  async function readPayload(root: string): Promise<Record<string, unknown>> {
    const text = await readFile(join(root, "payload.json"), "utf8");
    return JSON.parse(text) as Record<string, unknown>;
  }

  it("loader accepts onPreToolUse/onPostToolUse and the short aliases; unknown events still warn", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeSettings(root, JSON.stringify({
        hooks: {
          onPreToolUse: [{ command: "true" }],
          postToolUse: [{ command: "true" }],
          onPreToolUseAlias: [{ command: "true" }],
        },
      }));
      const settings = await loadHooksSettings(root, log.warn);
      expect(settings.onPreToolUse).toEqual([{ command: "true" }]);
      expect(settings.onPostToolUse).toEqual([{ command: "true" }]);
      expect(log.messages.length).toBe(1);
      expect(log.messages[0]).toContain("onPreToolUseAlias");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("onPreToolUse blocks with the stderr reason when the hook exits non-zero", async () => {
    const log = collector();
    const hooks = buildConfiguredHooks(
      { onPreToolUse: [{ command: join(FIXTURES, "block.sh") }] },
      { workspaceRoot: process.cwd(), warn: log.warn },
    );
    expect(await hooks?.onPreToolUse?.("write_file", { path: "a.ts" })).toEqual({
      block: true,
      reason: "blocked by fixture",
    });
  }, 20000);

  it("onPreToolUse blocks via the stdout first line {\"block\":true,\"reason\":…} with exit 0", async () => {
    const log = collector();
    const hooks = buildConfiguredHooks(
      { onPreToolUse: [{ command: join(FIXTURES, "block-json.sh") }] },
      { workspaceRoot: process.cwd(), warn: log.warn },
    );
    expect(await hooks?.onPreToolUse?.("shell", { command: "rm -rf /" })).toEqual({
      block: true,
      reason: "json says no",
    });
  }, 20000);

  it("onPreToolUse does not block on plain/absent stdout or JSON without block:true", async () => {
    const log = collector();
    const quiet = buildConfiguredHooks(
      { onPreToolUse: [{ command: join(FIXTURES, "ok.sh") }] },
      { workspaceRoot: process.cwd(), warn: log.warn },
    );
    expect(await quiet?.onPreToolUse?.("read_file", {})).toBeUndefined();
    const rewriter = buildConfiguredHooks(
      { onPreToolUse: [{ command: join(FIXTURES, "upper.sh") }] },
      { workspaceRoot: process.cwd(), warn: log.warn },
    );
    // stdout is text ("HELLO"), not block JSON → no block, and the output is NOT
    // treated as a rewrite (pre hooks observe or block, never rewrite).
    expect(await rewriter?.onPreToolUse?.("read_file", { text: "hello" })).toBeUndefined();
  }, 20000);

  it("a non-blocking first pre hook passes through; a blocking second one wins", async () => {
    const log = collector();
    const hooks = buildConfiguredHooks(
      { onPreToolUse: [{ command: join(FIXTURES, "ok.sh") }, { command: join(FIXTURES, "block-json.sh") }] },
      { workspaceRoot: process.cwd(), warn: log.warn },
    );
    expect(await hooks?.onPreToolUse?.("write_file", {})).toEqual({ block: true, reason: "json says no" });
  }, 20000);

  it("onPreToolUse receives the JSON payload on stdin (event/tool/input)", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      const hooks = buildConfiguredHooks(
        { onPreToolUse: [{ command: join(FIXTURES, "dump-payload.sh") }] },
        { workspaceRoot: root, warn: log.warn },
      );
      await hooks?.onPreToolUse?.("write_file", { path: "a.ts", content: "x" });
      const payload = await readPayload(root);
      expect(payload).toEqual({ event: "preToolUse", tool: "write_file", input: { path: "a.ts", content: "x" } });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 20000);

  it("onPostToolUse receives event/tool/input/result; a non-zero exit is ignored (observer)", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      const hooks = buildConfiguredHooks(
        { onPostToolUse: [{ command: join(FIXTURES, "dump-payload.sh") }] },
        { workspaceRoot: root, warn: log.warn },
      );
      await hooks?.onPostToolUse?.("read_file", { path: "a.txt" }, "the file content");
      const payload = await readPayload(root);
      expect(payload).toEqual({ event: "postToolUse", tool: "read_file", input: { path: "a.txt" }, result: "the file content" });

      // A failing post hook neither blocks anything nor warns — it observes.
      const failing = buildConfiguredHooks(
        { onPostToolUse: [{ command: join(FIXTURES, "block.sh") }] },
        { workspaceRoot: root, warn: log.warn },
      );
      const before = log.messages.length;
      await expect(failing?.onPostToolUse?.("read_file", {}, "r")).resolves.toBeUndefined();
      expect(log.messages.length).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 20000);

  it("a timed-out pre hook degrades to non-blocking with a warning", async () => {
    const log = collector();
    const hooks = buildConfiguredHooks(
      { onPreToolUse: [{ command: join(FIXTURES, "sleep.sh"), timeoutMs: 150 }] },
      { workspaceRoot: process.cwd(), warn: log.warn },
    );
    expect(await hooks?.onPreToolUse?.("write_file", {})).toBeUndefined();
    expect(log.messages.length).toBe(1);
    expect(log.messages[0]).toContain("超时"); // ω99-207 钉随源演进（超时词面中文化）
  }, 20000);
});

// ---------------------------------------------------------------------------
// ω99-22 P3 — unknown-key warning dedup across settings reloads. The dogfood
// log reprinted the same "unknown top-level key(s) ignored" line on every hot
// reload of an UNCHANGED file (84 turns, same global-settings line again and
// again), burying real signal. Memo: per (workspace, tier) the last
// unknown-key SET — same set stays quiet across reloads; a CHANGED set
// (keys added or gone) warns again so new signal is never swallowed.
// ---------------------------------------------------------------------------

describe("ω99-22: unknown-key warnings dedupe per (tier, key-set) across reloads", () => {
  beforeEach(() => {
    resetSettingsWarnMemoForTests(); // module memo would otherwise serialize cases
  });

  it("same unknown set → the warning fires exactly once across two loads of an unchanged file", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeSettings(root, JSON.stringify({ zzOmegaA: 1, hooks: { onRunStop: [] } }));
      await loadHooksSettings(root, log.warn);
      await loadHooksSettings(root, log.warn); // the hot-reload case: file unchanged, same set
      const unknownWarnings = log.messages.filter((m) => m.includes("未知的顶层键已忽略")); // ω99-207 钉随源演进（未知键词面中文化）
      expect(unknownWarnings).toHaveLength(1);
      expect(unknownWarnings[0]).toContain("zzOmegaA");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("changed set → warns again (a new unknown key is new signal, not noise)", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeSettings(root, JSON.stringify({ zzOmegaB: 1 }));
      await loadHooksSettings(root, log.warn);
      await writeSettings(root, JSON.stringify({ zzOmegaB: 1, zzOmegaC: 2 }));
      await loadHooksSettings(root, log.warn);
      const unknownWarnings = log.messages.filter((m) => m.includes("未知的顶层键已忽略")); // ω99-207 钉随源演进（未知键词面中文化）
      expect(unknownWarnings).toHaveLength(2);
      expect(unknownWarnings[1]).toContain("zzOmegaC");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("keys gone and back → warns again (a disappearance resets the memory: A → clean → A)", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeSettings(root, JSON.stringify({ zzOmegaD: 1 }));
      await loadHooksSettings(root, log.warn);
      await writeSettings(root, JSON.stringify({ hooks: { onRunStop: [] } })); // fixed: no unknown keys
      await loadHooksSettings(root, log.warn);
      await writeSettings(root, JSON.stringify({ zzOmegaD: 1 })); // re-broken the same way
      await loadHooksSettings(root, log.warn);
      const unknownWarnings = log.messages.filter((m) => m.includes("未知的顶层键已忽略")); // ω99-207 钉随源演进（未知键词面中文化）
      expect(unknownWarnings).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("tiers memo independently: the same unknown set in project and local both warn once each", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeSettings(root, JSON.stringify({ zzOmegaE: 1 }));
      await writeFile(join(root, ".wudao", "settings.local.json"), JSON.stringify({ zzOmegaE: 1 }), "utf8");
      await loadHooksSettings(root, log.warn);
      const unknownWarnings = log.messages.filter((m) => m.includes("未知的顶层键已忽略")); // ω99-207 钉随源演进（未知键词面中文化）
      expect(unknownWarnings).toHaveLength(2);
      expect(unknownWarnings.some((m) => m.includes("settings.json") && m.includes("zzOmegaE"))).toBe(true);
      expect(unknownWarnings.some((m) => m.includes("settings.local.json") && m.includes("zzOmegaE"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
