// P2-9（96 队列 #9）LSP 工具面单测 — 单工具 lsp（action: definitions/
// references/hover）对 fake server：三操作输出形、1-based 行列换算、
// cap 截断、fail-closed 各失败道、工具定义形。
import { describe, it, expect, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateToolArguments } from "@wudao/core";
import { createLspTool, renderLspLocations, renderLspHover, LSP_MAX_LOCATIONS, closeLspTools } from "../src/lsp/tools.js";
import type { LspProviderLaunchSpec } from "../src/lsp/manager.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-lsp-server.mjs", import.meta.url));

async function makeWorkspace(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "wudao-lsp-tool-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "app.ts"), "export function foo(): void {}\nfoo();\n", "utf8");
  await writeFile(join(root, "src", "other.tsx"), "const x = 1;\n", "utf8");
  return { root, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

function fakeProvider(env: Record<string, string> = {}): LspProviderLaunchSpec {
  return { command: process.execPath, args: [FIXTURE], env };
}

function toolFor(root: string, env: Record<string, string> = {}, opts: { requestTimeoutMs?: number; provider?: LspProviderLaunchSpec } = {}) {
  return createLspTool({
    workspaceRoot: root,
    provider: opts.provider ?? fakeProvider(env),
    requestTimeoutMs: opts.requestTimeoutMs ?? 5000,
    idleTimeoutMs: 60_000, // lifecycle is the manager suite's job — keep servers alive here
  });
}

const cleanups: Array<() => Promise<void>> = [];
function remember(cleanup: () => Promise<void>): void {
  cleanups.push(cleanup);
}
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => {});
  await closeLspTools(); // drain the tool-created managers (fake servers down)
});

describe("lsp tool definition (fail-closed factory discipline)", () => {
  it("is named lsp with action enum + required path/line/column; core validates its args", async () => {
    const ws = await makeWorkspace();
    remember(ws.cleanup);
    const tool = toolFor(ws.root);
    expect(tool.name).toBe("lsp");
    expect(tool.isReadOnly?.({})).toBe(true);
    expect(tool.isConcurrencySafe?.({})).toBe(true);
    expect(Object.keys(tool.parameters.properties).sort()).toEqual(["action", "column", "line", "path"]);
    expect(tool.parameters.required).toEqual(["action", "path", "line", "column"]);
    expect(tool.parameters.properties["action"]?.enum).toEqual(["definitions", "references", "hover"]);
    // Core's dispatch validation accepts the schema's scalar types (enum is
    // the case-fold normalizer, not a membership gate) — a junk action is
    // caught by the tool's own defensive check (tested below), while a legal
    // call passes core validation untouched.
    expect(validateToolArguments(tool.parameters, { action: "definitions", path: "src/app.ts", line: 1, column: 1 }).valid).toBe(true);
    const junk = await tool.execute({ action: "nope", path: "src/app.ts", line: 1, column: 1 });
    expect(junk.isError).toBe(true);
  });
});

describe("lsp tool: three actions against the fake server", () => {
  it("definitions renders 'file:line:col' workspace-relative, 1-based both ways", async () => {
    const ws = await makeWorkspace();
    remember(ws.cleanup);
    const tool = toolFor(ws.root);
    // line=3, column=5 (1-based) → the fake receives {line:2, character:4}
    // (0-based) and answers at {line:12, character:6} → rendered 13:7. The
    // second location is sibling.ts at {0,0} → rendered 1:1.
    const result = await tool.execute({ action: "definitions", path: "src/app.ts", line: 3, column: 5 });
    expect(result.isError).toBeFalsy();
    expect(result.content.split("\n")).toEqual(["src/app.ts:13:7", "src/sibling.ts:1:1"]);
  });

  it("references renders the list (declarations included)", async () => {
    const ws = await makeWorkspace();
    remember(ws.cleanup);
    const tool = toolFor(ws.root);
    const result = await tool.execute({ action: "references", path: "src/app.ts", line: 2, column: 1 });
    expect(result.isError).toBeFalsy();
    expect(result.content.split("\n")).toEqual(["src/app.ts:1:1", "src/app.ts:2:1", "src/app.ts:3:1"]);
  });

  it("hover returns the type/signature text (didOpen count proves the sync cache)", async () => {
    const ws = await makeWorkspace();
    remember(ws.cleanup);
    const tool = toolFor(ws.root);
    const r1 = await tool.execute({ action: "hover", path: "src/app.ts", line: 1, column: 1 });
    expect(r1.isError).toBeFalsy();
    expect(r1.content).toContain("```typescript");
    expect(r1.content).toContain("function foo(a: number): void");
    expect(r1.content).toContain("didOpens: 1");
    // Second call: the didOpen cache holds — still one open server-side.
    const r2 = await tool.execute({ action: "hover", path: "src/app.ts", line: 1, column: 1 });
    expect(r2.content).toContain("didOpens: 1");
  });

  it("hover null renders an explicit empty (never an empty string)", async () => {
    const ws = await makeWorkspace();
    remember(ws.cleanup);
    const tool = toolFor(ws.root, { FAKE_HOVER_NULL: "1" });
    const result = await tool.execute({ action: "hover", path: "src/app.ts", line: 1, column: 1 });
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/no hover/i);
  });

  it("a .tsx file maps to the typescriptreact language id", async () => {
    const ws = await makeWorkspace();
    remember(ws.cleanup);
    const tool = toolFor(ws.root);
    const result = await tool.execute({ action: "hover", path: "src/other.tsx", line: 1, column: 1 });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("languageId: typescriptreact");
  });

  it("caps a 150-location response at LSP_MAX_LOCATIONS with an honest marker", async () => {
    const ws = await makeWorkspace();
    remember(ws.cleanup);
    const tool = toolFor(ws.root, { FAKE_LSP_MANY: "1" });
    const result = await tool.execute({ action: "definitions", path: "src/app.ts", line: 1, column: 1 });
    expect(result.isError).toBeFalsy();
    const lines = result.content.split("\n");
    expect(lines).toHaveLength(LSP_MAX_LOCATIONS + 1);
    expect(lines[lines.length - 1]).toMatch(/50 more.*capped at 100|capped at 100.*50 more/);
  });

  it("caps a giant hover body at the shared output caps (2000 lines / 50KB)", async () => {
    const ws = await makeWorkspace();
    remember(ws.cleanup);
    const tool = toolFor(ws.root, { FAKE_HUGE_HOVER: "1" });
    const result = await tool.execute({ action: "hover", path: "src/app.ts", line: 1, column: 1 });
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/output capped at 2000 lines \/ 50KB/);
  });

  it("empty results render an explicit empty (never a bare blank)", async () => {
    const ws = await makeWorkspace();
    remember(ws.cleanup);
    const rendered = renderLspLocations(null, ws.root);
    expect(rendered).toMatch(/no \w+ found/i);
  });
});

describe("lsp tool: fail-closed lanes", () => {
  it("missing server binary → isError with install guidance (never a silent fallback)", async () => {
    const ws = await makeWorkspace();
    remember(ws.cleanup);
    const tool = toolFor(ws.root, {}, { provider: { command: "/nonexistent/no-such-lsp-server", args: [] } });
    const result = await tool.execute({ action: "definitions", path: "src/app.ts", line: 1, column: 1 });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("typescript-language-server");
    expect(result.content).toMatch(/install|pnpm|npm/i);
  });

  it("non-TypeScript path → isError naming the v1 language set", async () => {
    const ws = await makeWorkspace();
    remember(ws.cleanup);
    await writeFile(join(ws.root, "script.py"), "x = 1\n", "utf8");
    const tool = toolFor(ws.root);
    const result = await tool.execute({ action: "definitions", path: "script.py", line: 1, column: 1 });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/TypeScript|\.ts/i);
  });

  it("path escaping the workspace → isError (same guard as read_file)", async () => {
    const ws = await makeWorkspace();
    remember(ws.cleanup);
    const tool = toolFor(ws.root);
    const result = await tool.execute({ action: "definitions", path: "../../etc/passwd.ts", line: 1, column: 1 });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/escapes workspace|path/i);
  });

  it("line/column below 1 → isError (1-based contract)", async () => {
    const ws = await makeWorkspace();
    remember(ws.cleanup);
    const tool = toolFor(ws.root);
    const bad = await tool.execute({ action: "hover", path: "src/app.ts", line: 0, column: 1 });
    expect(bad.isError).toBe(true);
    expect(bad.content).toMatch(/1-based/);
    const bad2 = await tool.execute({ action: "hover", path: "src/app.ts", line: 1, column: 0 });
    expect(bad2.isError).toBe(true);
  });

  it("missing file → isError (the doc cannot sync)", async () => {
    const ws = await makeWorkspace();
    remember(ws.cleanup);
    const tool = toolFor(ws.root);
    const result = await tool.execute({ action: "definitions", path: "src/absent.ts", line: 1, column: 1 });
    expect(result.isError).toBe(true);
  });

  it("server timeout mid-request → isError (the loop never hangs)", async () => {
    const ws = await makeWorkspace();
    remember(ws.cleanup);
    const tool = toolFor(ws.root, { FAKE_LSP_DELAY_MS: "1200" }, { requestTimeoutMs: 150 });
    const result = await tool.execute({ action: "hover", path: "src/app.ts", line: 1, column: 1 });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/timed out|timeout/i);
  });

  it("server crash mid-request → isError with the crash named", async () => {
    const ws = await makeWorkspace();
    remember(ws.cleanup);
    const tool = toolFor(ws.root, { FAKE_LSP_CRASH_ON: "textDocument/hover" });
    const result = await tool.execute({ action: "hover", path: "src/app.ts", line: 1, column: 1 });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/exited|crashed|died/i);
  });
});

describe("renderLspLocations / renderLspHover (pure, zero-process seam)", () => {
  const root = "/ws";
  const loc = (file: string, line: number, ch: number): unknown => ({
    uri: `file://${file}`,
    range: { start: { line, character: ch }, end: { line, character: ch } },
  });

  it("normalizes single-object, array, LocationLink and null shapes", () => {
    expect(renderLspLocations(loc("/ws/a.ts", 0, 0), root).split("\n")).toEqual(["a.ts:1:1"]);
    expect(renderLspLocations([loc("/ws/a.ts", 1, 2), loc("/ws/b.ts", 3, 4)], root).split("\n"))
      .toEqual(["a.ts:2:3", "b.ts:4:5"]);
    // LocationLink: targetUri + targetSelectionRange (preferred) over targetRange.
    const link = {
      targetUri: "file:///ws/a.ts",
      targetRange: { start: { line: 9, character: 9 }, end: { line: 9, character: 9 } },
      targetSelectionRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 8 } },
    };
    expect(renderLspLocations([link], root).split("\n")).toEqual(["a.ts:1:5"]);
    expect(renderLspLocations(null, root)).toMatch(/no \w+ found/i);
  });

  it("locations outside the workspace render as absolute paths (honest, not fake-relative)", () => {
    expect(renderLspLocations([loc("/elsewhere/x.ts", 0, 0)], root).split("\n")).toEqual(["/elsewhere/x.ts:1:1"]);
  });

  it("drops junk entries (no uri / no range) instead of throwing", () => {
    const out = renderLspLocations([{ nope: true }, loc("/ws/a.ts", 0, 0), "garbage"], root);
    expect(out.split("\n")).toEqual(["a.ts:1:1"]);
  });

  it("caps at LSP_MAX_LOCATIONS with the truncation count", () => {
    const many = Array.from({ length: 150 }, (_, i) => loc(`/ws/f${i}.ts`, 0, 0));
    const lines = renderLspLocations(many, root).split("\n");
    expect(lines).toHaveLength(LSP_MAX_LOCATIONS + 1);
    expect(lines[lines.length - 1]).toMatch(/50 more/);
  });

  it("renderLspHover normalizes MarkupContent, MarkedString, MarkedString[] and null", () => {
    expect(renderLspHover({ contents: { kind: "markdown", value: "sig text" } })).toBe("sig text");
    expect(renderLspHover({ contents: "plain marked string" })).toBe("plain marked string");
    expect(renderLspHover({ contents: { language: "typescript", value: "let x: number" } }))
      .toBe("```typescript\nlet x: number\n```");
    expect(renderLspHover({ contents: ["one", { language: "ts", value: "two" }] }))
      .toBe("one\n\n```ts\ntwo\n```");
    expect(renderLspHover(null)).toMatch(/no hover/i);
    expect(renderLspHover({})).toMatch(/no hover/i);
  });
});
