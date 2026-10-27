// P2-16b（96 队列 #16）MCP OAuth token 库 —— `~/.wudao/mcp-tokens.json`。
//
// 形状：`{ "<serverName>": { access_token, refresh_token?, expires_at?, scope?,
// token_url, obtained_at } }`（文件键沿用 brief 的 snake_case）。token_url
// 随 token 落库（有据分歧：brief 列了三键，刷新跨会话需要端点——没有它
// refresh_token 就是死数据；报告记录）。
//
// 纪律：
// - **0600**：落盘即 chmod（writeFile 的 mode 只在新建时生效，故显式
//   chmod 兜底）；load 时发现权限不对 → 修正 + warn（启动 warn 纪律）。
// - **tolerant**：库文件是可选设施 —— 缺失=空库静默；坏 JSON / 坏条目
//   warn + 跳过，绝不崩（mcp.json 同款纪律）。
// - **secrets**：所有 token 值（access+refresh）可枚举进 scrubSecrets 的
//   输入（scrub 网延伸 —— 三面永不泄漏）。
// - 路径 WUDAO_GLOBAL_HOME-aware（settings-layer.resolveGlobalHome）。
import { chmodSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveGlobalHome } from "../settings-layer.js";
import { writePrivateFileSync } from "../private-storage.js";

/** One stored token (the in-memory camelCase form; the file is snake_case). */
export interface McpStoredToken {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Epoch ms; absent = the server gave no expires_in (no proactive refresh). */
  readonly expiresAt?: number;
  readonly scope?: string;
  /** The token endpoint this token came from — the refresh lane's target. */
  readonly tokenUrl: string;
  readonly obtainedAt: number;
}

/** Tokens are secrets: the file is owner-only, always. */
export const MCP_TOKENS_FILE_MODE = 0o600;

export function mcpTokensPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveGlobalHome(env), "mcp-tokens.json");
}

/** The storage seam (file-backed by default; tests inject fakes). */
export interface McpTokenStore {
  load(): Record<string, McpStoredToken>;
  save(tokens: Record<string, McpStoredToken>): void;
  /** Remove one server's token; true when a token was actually removed. */
  remove(server: string): boolean;
}

/** Tolerant field-wise parse of one stored entry (snake_case file form). */
function parseEntry(server: string, raw: unknown, warn: (msg: string) => void): McpStoredToken | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r["access_token"] !== "string" || r["access_token"].length === 0) {
    warn(`mcp token store: server "${server}" entry has no usable "access_token"; skipping it`);
    return undefined;
  }
  if (typeof r["token_url"] !== "string" || r["token_url"].length === 0) {
    warn(`mcp token store: server "${server}" entry has no "token_url" (unrefreshable); skipping it`);
    return undefined;
  }
  const refreshToken = typeof r["refresh_token"] === "string" && r["refresh_token"].length > 0 ? r["refresh_token"] : undefined;
  const expiresAt = typeof r["expires_at"] === "number" && Number.isFinite(r["expires_at"]) ? r["expires_at"] : undefined;
  const scope = typeof r["scope"] === "string" && r["scope"].length > 0 ? r["scope"] : undefined;
  const obtainedAt = typeof r["obtained_at"] === "number" && Number.isFinite(r["obtained_at"]) ? r["obtained_at"] : 0;
  return {
    accessToken: r["access_token"],
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(scope !== undefined ? { scope } : {}),
    tokenUrl: r["token_url"],
    obtainedAt,
  };
}

/** The on-disk snake_case form (stable key order: brief's field order). */
function serializeEntry(t: McpStoredToken): Record<string, unknown> {
  return {
    access_token: t.accessToken,
    ...(t.refreshToken !== undefined ? { refresh_token: t.refreshToken } : {}),
    ...(t.expiresAt !== undefined ? { expires_at: t.expiresAt } : {}),
    ...(t.scope !== undefined ? { scope: t.scope } : {}),
    token_url: t.tokenUrl,
    obtained_at: t.obtainedAt,
  };
}

/** A file-backed store at an explicit path (the test seam; tolerant + 0600). */
export function fileMcpTokenStore(path: string, warn: (msg: string) => void = () => {}): McpTokenStore {
  const readAll = (): Record<string, McpStoredToken> => {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return {}; // no store yet → no tokens, no noise
    }
    // 启动 warn 纪律：权限不对 → 修正到 0600 并让人看见。
    try {
      const mode = statSync(path).mode & 0o777;
      if (mode !== MCP_TOKENS_FILE_MODE) {
        chmodSync(path, MCP_TOKENS_FILE_MODE);
        warn(`mcp token store ${path} had permissions ${mode.toString(8)}; tightened to 0600`);
      }
    } catch {
      // stat/chmod 失败（竞态删除等）→ 下面的读取/解析自会给出可见结果
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      warn(`mcp token store ${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}); ignoring it`);
      return {};
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      warn(`mcp token store ${path} is not an object; ignoring it`);
      return {};
    }
    const out: Record<string, McpStoredToken> = {};
    for (const [server, raw] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = parseEntry(server, raw, warn);
      if (entry !== undefined) out[server] = entry;
    }
    return out;
  };
  const writeAll = (tokens: Record<string, McpStoredToken>): void => {
    const onDisk: Record<string, unknown> = {};
    for (const [server, t] of Object.entries(tokens)) onDisk[server] = serializeEntry(t);
    // ω99-2b: 走私有存储原语 —— 目录 0700 + 同目录 tmp/原子 rename + 0600
    // （mode 只在新建时生效，故 rename 后显式 chmod 兜底）+ 父链目录链接拒绝。
    writePrivateFileSync(path, `${JSON.stringify(onDisk, null, 2)}\n`);
  };
  return {
    load: readAll,
    save: writeAll,
    remove: (server: string): boolean => {
      const tokens = readAll();
      if (!(server in tokens)) return false;
      delete tokens[server];
      writeAll(tokens);
      return true;
    },
  };
}

/** The default store: `~/.wudao/mcp-tokens.json` (WUDAO_GLOBAL_HOME-aware). */
export function defaultMcpTokenStore(env: NodeJS.ProcessEnv = process.env, warn: (msg: string) => void = () => {}): McpTokenStore {
  return fileMcpTokenStore(mcpTokensPath(env), warn);
}

/** Every secret value in the store — scrubSecrets 输入的 token 面（三面纪律）。 */
export function mcpTokenSecretValues(tokens: Record<string, McpStoredToken>): string[] {
  const values: string[] = [];
  for (const t of Object.values(tokens)) {
    if (t.accessToken.length > 0) values.push(t.accessToken);
    if (t.refreshToken !== undefined && t.refreshToken.length > 0) values.push(t.refreshToken);
  }
  return values;
}
