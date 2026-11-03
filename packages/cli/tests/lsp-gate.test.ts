// P2-9（96 队列 #9）LSP 门控单测 — settings `lsp.enabled` 缺省 false（opt-in
// 进程面）；注册位照 MCP 先例（enabled → 列表尾追加一只工具；disabled →
// []，零配置零行为差）；settings 白名单纪律（hooks-config known()）+ 权限
// 姿态（READ_TOOLS 同 grep）。
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toModelToolDefinition, type Tool, type ModelClient, type PermissionDecision } from "@wudao-org/core";
import { resolveLspEnabled } from "../src/misc-config.js";
import { setLspRuntimeEnabled, lspRuntimeEnabled, lspToolsFor, closeLspTools } from "../src/lsp/tools.js";
import { buildToolSet } from "../src/tools.js";
import { loadHooksSettings } from "../src/hooks-config.js";
import { decidePermission, READ_TOOLS } from "../src/permission.js";

afterEach(async () => {
  setLspRuntimeEnabled(false); // never leak the gate into other suites
  await closeLspTools();
});

describe("resolveLspEnabled (settings node, default OFF)", () => {
  it("absent node → false (opt-in process surface)", () => {
    expect(resolveLspEnabled({})).toBe(false);
    expect(resolveLspEnabled({ lsp: undefined })).toBe(false);
  });

  it("lsp.enabled true → true", () => {
    expect(resolveLspEnabled({ lsp: { enabled: true } })).toBe(true);
  });

  it("lsp.enabled false → false", () => {
    expect(resolveLspEnabled({ lsp: { enabled: false } })).toBe(false);
  });

  it("junk shapes warn and stay fail-closed (false)", () => {
    const warn = vi.fn();
    expect(resolveLspEnabled({ lsp: { enabled: "yes" } }, warn)).toBe(false);
    expect(resolveLspEnabled({ lsp: "banana" }, warn)).toBe(false);
    expect(resolveLspEnabled({ lsp: [1, 2] }, warn)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

describe("lspToolsFor (the MCP-precedent registration seam)", () => {
  it("default gate → [] (zero tools, zero processes, zero behavior diff)", () => {
    expect(lspRuntimeEnabled()).toBe(false);
    expect(lspToolsFor("/any/workspace")).toEqual([]);
  });

  it("enabled → exactly one tool named lsp, appended at the list tail with existing definitions byte-identical", async () => {
    const root = await mkdtemp(join(tmpdir(), "wudao-lsp-gate-"));
    try {
      const model = fakeModel();
      const allow = (): PermissionDecision => ({ behavior: "allow" });
      const builtin = buildToolSet({
        workspaceRoot: root,
        model,
        canUseTool: allow,
        contextWindowTokens: 200_000,
      });
      // Gate OFF: the frontend assembly is exactly today's bytes.
      setLspRuntimeEnabled(false);
      const off = [...builtin, ...lspToolsFor(root)];
      expect(off).toHaveLength(builtin.length);
      // Gate ON: one more tool, at the END, everything before it unchanged.
      setLspRuntimeEnabled(true);
      const on = [...builtin, ...lspToolsFor(root)];
      expect(on).toHaveLength(off.length + 1);
      expect(on[on.length - 1]?.name).toBe("lsp");
      // Same object references — the existing tools are not rebuilt or touched.
      expect(on.slice(0, -1)).toEqual(off);
      // Byte-level: the OFF definitions serialize as a strict prefix of ON's
      // (the M24 append-only law — no existing tool's bytes move).
      const defsOff = JSON.stringify(off.map(toModelToolDefinition));
      const defsOn = JSON.stringify(on.map(toModelToolDefinition));
      expect(defsOn.startsWith(defsOff.slice(0, -1))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("caches per workspace root — repeated frontend calls share one tool (one server)", async () => {
    const root = await mkdtemp(join(tmpdir(), "wudao-lsp-gate-"));
    try {
      setLspRuntimeEnabled(true);
      const a = lspToolsFor(root);
      const b = lspToolsFor(root);
      expect(a[0]).toBe(b[0]);
      const other = lspToolsFor(`${root}-2`);
      expect(other[0]).not.toBe(a[0]);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(`${root}-2`, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("settings whitelist + permission posture", () => {
  it("the `lsp` settings key is a known top-level key (no unknown-key warning)", async () => {
    const root = await mkdtemp(join(tmpdir(), "wudao-lsp-hooks-"));
    try {
      await mkdir(join(root, ".wudao"), { recursive: true });
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({ lsp: { enabled: true } }), "utf8");
      const warns: string[] = [];
      await loadHooksSettings(root, (m) => warns.push(m));
      expect(warns.some((w) => w.includes("lsp"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("the lsp tool rides the READ_TOOLS posture (same class as grep — plan mode allows it)", () => {
    expect(READ_TOOLS.has("lsp")).toBe(true);
    expect(decidePermission("workspace", "lsp")).toEqual({ behavior: "allow" });
    expect(decidePermission("plan", "lsp")).toEqual({ behavior: "allow" });
    expect(decidePermission("ask", "lsp")).toBe("ask");
  });
});

function fakeModel(): ModelClient {
  return {
    chat: async () => { throw new Error("not used"); },
  } as unknown as ModelClient;
}
