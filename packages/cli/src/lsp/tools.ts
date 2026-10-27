// P2-9（96 队列 #9）LSP 工具面 — 单工具 `lsp`（action: definitions /
// references / hover），typescript 单语言 v1（CC 单工具多操作范式）。
//
// 纪律：
// - buildTool fail-closed 工厂：任何失败（server 缺失/超时/崩溃/路径/参
//   数）都是 isError 工具错误，绝不静默降级，绝不挂死 loop。
// - 行列基线与既有工具对齐：1-based（grep 的 `path:line:`、read_file 的
//   offset、edit 的 lineOfOffset 全是 1-based）；LSP 线上协议是 0-based
//   ——换算收在 manager/tools 一处，进出工具面永远是 1-based。
// - 输出纪律同 grep：命中列表 `path:line:col`（相对工作区根）cap 100；
//   hover 文本走 core 的 capOutputLines（2000 行 / 50KB）。
// - provider v1 只 typescript（typescript-language-server --stdio，从工
//   作区 node_modules 或 PATH 解析）；扩展名→语言表 + 语言→启动器解析
//   留缝，多语言是后续弧。
// - 默认关：settings `lsp.enabled`（misc-config.resolveLspEnabled）门控
//   在 lspToolsFor —— 缺省零工具、零进程、零行为差（M24 工具列表
//   append-only：注册即列表尾）。
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTool, capOutputLines, resolveWorkspacePath, type Tool } from "@wudao/core";
import { LspManager, type LspProviderLaunchSpec } from "./manager.js";

/** Same hit discipline as grep: 100 locations, then an honest cap marker. */
export const LSP_MAX_LOCATIONS = 100;

/** The languages v1 serves (extension → language id). The multi-language seam. */
const EXT_LANGUAGE_ID: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".mts": "typescript",
  ".cts": "typescript",
};

/** The v1 language set, for error copy and the tool description. */
export const LSP_SUPPORTED_EXTENSIONS = Object.keys(EXT_LANGUAGE_ID).join("/");

/** Language id for a path, or undefined when v1 does not serve that extension. */
export function languageIdForPath(path: string): string | undefined {
  return EXT_LANGUAGE_ID[extname(path).toLowerCase()];
}

const LSP_SERVER_BINARY = "typescript-language-server";

/**
 * Resolve the v1 language server launcher: the workspace's own
 * node_modules/.bin first (hermetic — the repo pins its tooling), then PATH.
 * Undefined = not installed (the tool fails closed with install guidance).
 */
export function resolveLspServerLaunch(workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): LspProviderLaunchSpec | undefined {
  const local = join(workspaceRoot, "node_modules", ".bin", LSP_SERVER_BINARY);
  if (existsSync(local)) return { command: local, args: ["--stdio"] };
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir.trim() === "") continue;
    const candidate = join(dir, LSP_SERVER_BINARY);
    if (existsSync(candidate)) return { command: candidate, args: ["--stdio"] };
  }
  return undefined;
}

const INSTALL_GUIDANCE =
  `typescript-language-server not found (looked in <workspace>/node_modules/.bin and PATH) — ` +
  `install it in the workspace: pnpm add -D typescript-language-server typescript ` +
  `(or npm install -D / yarn add -D), then retry`;

// ---------------------------------------------------------------------------
// Render helpers — pure, exported for the zero-process test seam.
// ---------------------------------------------------------------------------

/** One LSP location-ish result entry (Location or LocationLink subset). */
interface LocationLike {
  readonly uri?: unknown;
  readonly range?: { readonly start?: Position0 };
  readonly targetUri?: unknown;
  readonly targetRange?: { readonly start?: Position0 };
  readonly targetSelectionRange?: { readonly start?: Position0 };
}

interface Position0 {
  readonly line?: unknown;
  readonly character?: unknown;
}

function positionStart(entry: LocationLike): Position0 | undefined {
  // LocationLink: the selection range when present, else the target range.
  if (entry.targetUri !== undefined) return entry.targetSelectionRange?.start ?? entry.targetRange?.start;
  return entry.range?.start;
}

/** `rel:line:col` (workspace-relative, 1-based) — absolute when outside root. */
function formatLocation(entry: LocationLike, workspaceRoot: string): string | undefined {
  const rawUri = entry.uri !== undefined ? entry.uri : entry.targetUri;
  if (typeof rawUri !== "string" || rawUri === "") return undefined;
  const start = positionStart(entry);
  const line = start?.line;
  const character = start?.character;
  if (typeof line !== "number" || typeof character !== "number") return undefined;
  let path: string;
  if (rawUri.startsWith("file://")) {
    try {
      path = fileURLToPath(rawUri);
    } catch {
      return undefined;
    }
  } else {
    path = rawUri; // a non-file scheme — render the uri verbatim, honestly
  }
  // Workspace-relative when the location sits inside the root; absolute (the
  // honest form) when it does not. isAbsolute covers Windows drive mismatches.
  const rel = relative(workspaceRoot, path);
  const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  return `${inside ? rel : path}:${line + 1}:${character + 1}`;
}

/** definitions/references → one `path:line:col` per line, capped + empty-safe. */
export function renderLspLocations(
  locations: unknown,
  workspaceRoot: string,
  emptyLabel = "locations",
): string {
  const list = Array.isArray(locations) ? locations : locations == null ? [] : [locations];
  const lines: string[] = [];
  let truncated = 0;
  for (const entry of list) {
    // Junk entries (no uri/no range) drop silently — only REAL truncation
    // gets the cap marker (it promises cut results, not filtered junk).
    if (typeof entry !== "object" || entry === null) continue;
    const formatted = formatLocation(entry as LocationLike, workspaceRoot);
    if (formatted === undefined) continue;
    if (lines.length >= LSP_MAX_LOCATIONS) { truncated += 1; continue; }
    lines.push(formatted);
  }
  if (lines.length === 0) return `(no ${emptyLabel} found)`;
  const marker = truncated > 0 ? `\n… (${truncated} more result${truncated === 1 ? "" : "s"} — capped at ${LSP_MAX_LOCATIONS})` : "";
  return capOutputLines(`${lines.join("\n")}${marker}`);
}

/** hover → text (MarkupContent | MarkedString | MarkedString[]), capped. */
export function renderLspHover(hover: unknown): string {
  if (typeof hover !== "object" || hover === null) return "(no hover information at this position)";
  const contents = (hover as { contents?: unknown }).contents;
  if (contents === undefined || contents === null) return "(no hover information at this position)";
  const parts: string[] = [];
  const renderPart = (part: unknown): void => {
    if (typeof part === "string") {
      if (part.trim() !== "") parts.push(part);
      return;
    }
    if (typeof part === "object" && part !== null) {
      const rec = part as { kind?: unknown; value?: unknown; language?: unknown };
      if (typeof rec.value === "string" && rec.value.trim() !== "") {
        // MarkupContent {kind,value} renders verbatim; {language,value} fences.
        parts.push(typeof rec.language === "string" ? `\`\`\`${rec.language}\n${rec.value}\n\`\`\`` : rec.value);
      }
    }
  };
  if (Array.isArray(contents)) for (const part of contents) renderPart(part);
  else renderPart(contents);
  if (parts.length === 0) return "(no hover information at this position)";
  return capOutputLines(parts.join("\n\n"));
}

// ---------------------------------------------------------------------------
// The tool.
// ---------------------------------------------------------------------------

export interface LspToolDeps {
  readonly workspaceRoot: string;
  /** Injected launch spec (tests, future settings overrides). Absent → per-call resolution. */
  readonly provider?: LspProviderLaunchSpec;
  readonly requestTimeoutMs?: number;
  readonly initializeTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  /** Debug sink for language-server stderr. */
  readonly onStderr?: (line: string) => void;
}

/** Every live manager (drained by closeLspTools at frontend shutdown). */
const managers: LspManager[] = [];

/** Build the single `lsp` tool (one manager per tool instance, lazy spawn). */
export function createLspTool(deps: LspToolDeps): Tool {
  let manager: LspManager | undefined;
  // Language servers resolve symlinks (tsserver's URIs come back realpath'd —
  // on macOS a /var workspace answers in /private/var). Render against the
  // realpath'd root so locations come out workspace-relative, not absolute.
  let renderingRoot: string | undefined;
  const rootForRendering = async (): Promise<string> => {
    if (renderingRoot !== undefined) return renderingRoot;
    renderingRoot = await realpath(deps.workspaceRoot).catch(() => deps.workspaceRoot);
    return renderingRoot;
  };
  const ensureManager = (): { ok: true; manager: LspManager } | { ok: false; error: string } => {
    if (manager !== undefined) return { ok: true, manager };
    const provider = deps.provider ?? resolveLspServerLaunch(deps.workspaceRoot);
    if (provider === undefined) return { ok: false, error: INSTALL_GUIDANCE };
    manager = new LspManager({
      workspaceRoot: deps.workspaceRoot,
      provider,
      ...(deps.requestTimeoutMs !== undefined ? { requestTimeoutMs: deps.requestTimeoutMs } : {}),
      ...(deps.initializeTimeoutMs !== undefined ? { initializeTimeoutMs: deps.initializeTimeoutMs } : {}),
      ...(deps.idleTimeoutMs !== undefined ? { idleTimeoutMs: deps.idleTimeoutMs } : {}),
      ...(deps.onStderr !== undefined ? { onStderr: deps.onStderr } : {}),
    });
    managers.push(manager);
    return { ok: true, manager };
  };

  return buildTool({
    name: "lsp",
    description:
      "LSP code intelligence for the workspace's TypeScript files (.ts/.tsx/.mts/.cts). " +
      "actions: definitions (where the symbol at the position is defined) · references (every usage, declaration included) · hover (the symbol's type/signature). " +
      "path is workspace-relative; line and column are 1-based — the same coordinates read_file/grep print. " +
      "definitions/references render as 'path:line:col' lines (workspace-relative, 1-based, capped at 100); hover returns type/signature text. " +
      "Prefer this over grep when you need symbol-accurate navigation (a textual search cannot tell foo() from foo in a comment). " +
      "The language server starts on the first call and recycles after idle — a cold first call can take a few seconds.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["definitions", "references", "hover"],
          description: "definitions | references | hover",
        },
        path: { type: "string", description: "Workspace-relative TypeScript file path, e.g. 'src/app.ts'." },
        line: { type: "number", description: "1-based line number of the position." },
        column: { type: "number", description: "1-based column of the position." },
      },
      required: ["action", "path", "line", "column"],
      additionalProperties: false,
    },
    // Code intelligence is a pure read of the workspace's own code — the same
    // class as grep (the server process itself is the settings-gated opt-in).
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    // Local subprocess over the workspace tree, not the network.
    isOpenWorld: () => false,
    execute: async (args: Record<string, unknown>) => {
      const fail = (message: string): { content: string; isError: boolean } => ({ content: message, isError: true });
      const action = args["action"];
      const rawPath = args["path"];
      const line = args["line"];
      const column = args["column"];
      // Defensive re-validation (the core loop validates first; the zero-process
      // seam may call execute directly — errors land before any side effect).
      if (action !== "definitions" && action !== "references" && action !== "hover") {
        return fail(`lsp: action must be "definitions" | "references" | "hover" (got ${JSON.stringify(action)})`);
      }
      if (typeof rawPath !== "string" || rawPath.trim() === "") return fail('lsp: "path" must be a non-empty workspace-relative path');
      if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return fail('lsp: "line" must be an integer >= 1 (1-based, like read_file/grep output)');
      if (typeof column !== "number" || !Number.isInteger(column) || column < 1) return fail('lsp: "column" must be an integer >= 1 (1-based, like read_file/grep output)');
      const languageId = languageIdForPath(rawPath);
      if (languageId === undefined) {
        return fail(`lsp: v1 serves TypeScript files only (${LSP_SUPPORTED_EXTENSIONS}) — "${rawPath}" is not one (use grep/glob for other files)`);
      }
      const resolved = await resolveWorkspacePath(deps.workspaceRoot, rawPath);
      if (!resolved.ok) return fail(`lsp: ${resolved.error}`);
      let text: string;
      try {
        text = await readFile(resolved.absPath, "utf8");
      } catch (err) {
        return fail(`lsp: cannot read "${rawPath}" (${err instanceof Error ? err.message : String(err)})`);
      }
      const got = ensureManager();
      if (!got.ok) return fail(`lsp: ${got.error}`);
      const doc = { path: resolved.absPath, languageId, text };
      const position = { line, column };
      const renderRoot = await rootForRendering();
      try {
        if (action === "hover") {
          const hover = await got.manager.request("textDocument/hover", doc, position);
          return { content: renderLspHover(hover) };
        }
        if (action === "references") {
          const locations = await got.manager.references(doc, position, true);
          return { content: renderLspLocations(locations, renderRoot, "references") };
        }
        const locations = await got.manager.request("textDocument/definition", doc, position);
        return { content: renderLspLocations(locations, renderRoot, "definitions") };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const guidance = /ENOENT|failed to start/i.test(message) ? ` — ${INSTALL_GUIDANCE}` : "";
        return fail(`lsp ${action} on "${rawPath}" failed: ${message}${guidance}`);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Settings gate + the frontend seam (the MCP tools' conditional-registration
// pattern: enabled → the tool appends at the list tail; disabled → []).
// ---------------------------------------------------------------------------

let runtimeEnabled = false;

/** The boot-time settings gate (index.ts calls this once beside mcpRuntime). */
export function setLspRuntimeEnabled(enabled: boolean): void {
  runtimeEnabled = enabled;
}

/** The current gate state (tests/diagnostics). */
export function lspRuntimeEnabled(): boolean {
  return runtimeEnabled;
}

const toolCache = new Map<string, Tool>();

/**
 * The lsp tool for a workspace — [] while `lsp.enabled` is unset/false
 * (zero-config = zero behavior diff). One cached tool per root: repeated
 * frontend calls share one manager (one server process per workspace).
 */
export function lspToolsFor(workspaceRoot: string): Tool[] {
  if (!runtimeEnabled) return [];
  let tool = toolCache.get(workspaceRoot);
  if (tool === undefined) {
    tool = createLspTool({ workspaceRoot });
    toolCache.set(workspaceRoot, tool);
  }
  return [tool];
}

/** Dispose every live language server (bounded; called beside closeMcpTools). */
export async function closeLspTools(): Promise<void> {
  const closing = managers.splice(0, managers.length);
  await Promise.all(closing.map((m) => m.dispose().catch(() => {})));
}

/** Fire-and-forget variant for process "exit" hooks. */
export function bestEffortCloseLspTools(): void {
  for (const m of managers.splice(0, managers.length)) {
    void m.dispose().catch(() => {});
  }
}
