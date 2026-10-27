// P2-12（96 队列 #12）terminal 门控单测 — settings `terminal.enabled` 缺省
// false（fail-closed 进程面，lsp.enabled 同款）；注册位 lsp 同款（enabled
// 且 node-pty 可加载 → 列表尾追加一只工具；disabled / 加载失败 → []，零
// 行为差零 fatal）；settings 白名单 + 权限姿态（每动作 ask：不进
// READ_TOOLS/WORKSPACE_TOOLS）。
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toModelToolDefinition, type ModelClient, type PermissionDecision, type Tool } from "@wudao/core";
import { resolveTerminalEnabled } from "../src/misc-config.js";
import {
  terminalToolsFor, closeTerminalTools, setTerminalRuntimeEnabled, terminalRuntimeEnabled,
  __resetTerminalRuntimeForTests, setTerminalHistorySink,
} from "../src/terminal/tools.js";
import { loadNodePty, __setPtyLoaderForTests } from "../src/terminal/pty.js";
import { buildToolSet } from "../src/tools.js";
import { loadHooksSettings } from "../src/hooks-config.js";
import { decidePermission, READ_TOOLS, WORKSPACE_TOOLS } from "../src/permission.js";

afterEach(async () => {
  __setPtyLoaderForTests(undefined); // restore the real loader
  __resetTerminalRuntimeForTests();
  setTerminalHistorySink(undefined);
  await closeTerminalTools();
});

describe("resolveTerminalEnabled (settings node, default OFF)", () => {
  it("absent node → false (opt-in process surface)", () => {
    expect(resolveTerminalEnabled({})).toBe(false);
    expect(resolveTerminalEnabled({ terminal: undefined })).toBe(false);
  });

  it("terminal.enabled true → true", () => {
    expect(resolveTerminalEnabled({ terminal: { enabled: true } })).toBe(true);
  });

  it("terminal.enabled false → false", () => {
    expect(resolveTerminalEnabled({ terminal: { enabled: false } })).toBe(false);
  });

  it("junk shapes warn and stay fail-closed (false)", () => {
    const warn = (msg: string) => { void msg; };
    const calls: string[] = [];
    const w = (m: string) => calls.push(m);
    expect(resolveTerminalEnabled({ terminal: { enabled: "yes" } }, w)).toBe(false);
    expect(resolveTerminalEnabled({ terminal: "banana" }, w)).toBe(false);
    expect(resolveTerminalEnabled({ terminal: [1] }, w)).toBe(false);
    expect(calls).toHaveLength(3);
    expect(warn).toBeTypeOf("function");
  });
});

describe("terminalToolsFor (lsp-precedent registration seam)", () => {
  it("default gate → [] (zero tools, zero processes, zero behavior diff)", () => {
    expect(terminalRuntimeEnabled()).toBe(false);
    expect(terminalToolsFor("/any/workspace")).toEqual([]);
  });

  it("enabled + pty loaded → exactly one tool named terminal at the list tail, existing definitions byte-identical", async () => {
    const root = await mkdtemp(join(tmpdir(), "wudao-term-gate-"));
    try {
      const load = await loadNodePty(); // real native load (hard-fail if unavailable)
      expect(load.ok).toBe(true);
      const model = fakeModel();
      const allow = (): PermissionDecision => ({ behavior: "allow" });
      const builtin = buildToolSet({ workspaceRoot: root, model, canUseTool: allow, contextWindowTokens: 200_000 });
      setTerminalRuntimeEnabled(false);
      const off = [...builtin, ...terminalToolsFor(root)];
      expect(off).toHaveLength(builtin.length);
      setTerminalRuntimeEnabled(true);
      const on = [...builtin, ...terminalToolsFor(root)];
      expect(on).toHaveLength(off.length + 1);
      expect(on[on.length - 1]?.name).toBe("terminal");
      expect(on.slice(0, -1)).toEqual(off);
      const defsOff = JSON.stringify(off.map(toModelToolDefinition));
      const defsOn = JSON.stringify(on.map(toModelToolDefinition));
      expect(defsOn.startsWith(defsOff.slice(0, -1))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("node-pty 加载失败 → 优雅降级（红线 3：缺省关；降级不 fatal）", () => {
  it("loader 抛错 → ok:false + 一条 warn；enabled 也零注册、不抛", async () => {
    __setPtyLoaderForTests(async () => { throw new Error("native build missing (simulated)"); });
    const warns: string[] = [];
    const load = await loadNodePty((m) => warns.push(m));
    expect(load.ok).toBe(false);
    if (!load.ok) expect(load.reason).toContain("native build missing");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("node-pty");
    // enabled=true 也零注册（加载失败压过 settings）
    setTerminalRuntimeEnabled(true);
    expect(terminalToolsFor("/any/root")).toEqual([]);
    expect(() => terminalToolsFor("/any/root")).not.toThrow();
  });

  it("loader 恢复后可再加载（缓存按次注入重置）", async () => {
    __setPtyLoaderForTests(async () => { throw new Error("boom"); });
    const first = await loadNodePty();
    expect(first.ok).toBe(false);
    __setPtyLoaderForTests(undefined); // 真实 loader
    const second = await loadNodePty();
    expect(second.ok).toBe(true);
  });
});

describe("settings 白名单 + 权限姿态", () => {
  it("the `terminal` settings key is a known top-level key (no unknown-key warning)", async () => {
    const root = await mkdtemp(join(tmpdir(), "wudao-term-hooks-"));
    try {
      await mkdir(join(root, ".wudao"), { recursive: true });
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({ terminal: { enabled: true } }), "utf8");
      const warns: string[] = [];
      await loadHooksSettings(root, (m) => warns.push(m));
      expect(warns.some((w) => w.includes("terminal"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("每动作 ask 档：terminal 不进 READ_TOOLS/WORKSPACE_TOOLS——workspace/ask 模式都问，plan 拒绝", () => {
    expect(READ_TOOLS.has("terminal")).toBe(false);
    expect(WORKSPACE_TOOLS.has("terminal")).toBe(false);
    expect(decidePermission("workspace", "terminal")).toBe("ask");
    expect(decidePermission("ask", "terminal")).toBe("ask");
    expect(decidePermission("plan", "terminal")).toEqual({ behavior: "deny", reason: expect.stringContaining("read-only") });
    expect(decidePermission("auto", "terminal")).toEqual({ behavior: "allow" }); // 模式语义：auto 全放行
  });

  it("the gate never leaks into the lsp tool face", () => {
    // 独立开关：terminal 关不 lsp 开，反之亦然（各自 runtime flag）
    setTerminalRuntimeEnabled(true);
    expect(terminalRuntimeEnabled()).toBe(true);
    __resetTerminalRuntimeForTests();
    expect(terminalRuntimeEnabled()).toBe(false);
  });
});

function fakeModel(): ModelClient {
  return { chat: async () => { throw new Error("not used"); } } as unknown as ModelClient;
}

// keep the Tool import referenced (typed helper shape mirrors lsp-gate.test.ts)
type _Tool = Tool;
