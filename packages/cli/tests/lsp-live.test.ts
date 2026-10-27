// P2-9（96 队列 #9）真实 typescript-language-server 冒烟 — **env 门控**：
// WUDAO_LSP_LIVE=1 才跑；依赖缺失（node_modules/.bin 与 PATH 都没有
// typescript-language-server，或其安装里的 TypeScript 无 tsserver.js）→
// skip 不 fail（CI 不装真 server）。
// 一跳验收：definitions/hover 在真 tsserver 上命中真实定义位。
import { it, expect, describe, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createLspTool, resolveLspServerLaunch, closeLspTools, type LspToolDeps } from "../src/lsp/tools.js";
import type { LspProviderLaunchSpec } from "../src/lsp/manager.js";

const LIVE = process.env.WUDAO_LSP_LIVE === "1";
// Resolution probe BEFORE the tests are declared: a missing dependency skips
// every case (never fails the suite) — the env gate alone is not enough.
const launch = resolveLspServerLaunch(process.cwd());
// The dependency contract includes a WORKSPACE-USABLE tsserver: the server
// resolves <workspace>/node_modules/typescript first. TS 7.x ships no
// tsserver.js (the native port — typescript-language-server rejects it), so
// probe the install the launcher came from and gate on a real tsserver.js.
const installRoot = launch !== undefined ? dirname(dirname(launch.command)) : undefined; // node_modules/.bin/x → node_modules
const tsserverUsable = installRoot !== undefined && existsSync(join(installRoot, "typescript", "lib", "tsserver.js"));
const gated = (name: string, fn: () => Promise<void>): void => {
  if (LIVE && launch !== undefined && tsserverUsable) it(name, fn);
  else it.skip(`${name} (WUDAO_LSP_LIVE=1 + typescript-language-server + a tsserver.js-bearing TypeScript required)`, fn);
};

async function liveWorkspace(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "wudao-lsp-live-"));
  await mkdir(join(root, "src"), { recursive: true });
  // The workspace shares the resolved install's node_modules (typescript +
  // the server) — exactly how a real repo carrying the devDependency sits.
  if (installRoot !== undefined) {
    await symlink(installRoot, join(root, "node_modules"), "dir").catch(() => {});
  }
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }), "utf8");
  // Self-contained one-hop: declaration on line 1 (function local → 1-based
  // col 10), usage on line 4 col 11. No import resolution involved — tsserver
  // answers an imported symbol's "definition" with the import-clause position
  // (its documented chain), which would make the assertion version-coupled.
  await writeFile(
    join(root, "src", "solo.ts"),
    "function local(x: number): number {\n  return x + 1;\n}\nconst r = local(1);\n",
    "utf8",
  );
  return { root, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

function liveTool(root: string): ReturnType<typeof createLspTool> {
  const deps: LspToolDeps = {
    workspaceRoot: root,
    provider: launch as LspProviderLaunchSpec,
    requestTimeoutMs: 30_000, // a cold tsserver's first call can be slow
    initializeTimeoutMs: 30_000,
    idleTimeoutMs: 60_000,
  };
  return createLspTool(deps);
}

afterEach(async () => {
  await closeLspTools();
});

describe("lsp live smoke (real typescript-language-server)", () => {
  gated("definitions one-hop against a real tsserver", async () => {
    const ws = await liveWorkspace();
    try {
      const tool = liveTool(ws.root);
      // Line 4 `const r = local(1);` — column 11 is the `local` usage (1-based).
      const result = await tool.execute({ action: "definitions", path: "src/solo.ts", line: 4, column: 11 });
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain("src/solo.ts:1:10"); // the declaration site
    } finally {
      await ws.cleanup();
    }
  });

  gated("hover against a real tsserver", async () => {
    const ws = await liveWorkspace();
    try {
      const tool = liveTool(ws.root);
      const result = await tool.execute({ action: "hover", path: "src/solo.ts", line: 4, column: 11 });
      expect(result.isError).toBeFalsy();
      expect(result.content).toMatch(/local/);
    } finally {
      await ws.cleanup();
    }
  });
});
