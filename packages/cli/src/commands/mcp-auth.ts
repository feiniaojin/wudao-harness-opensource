// P2-16b（96 队列 #16）— /mcp auth|unauth <server>: the MCP OAuth flow's
// human face (鉴权流是人动作——/trust、/constitution 同款纪律，不给模型
// 工具）。ONE grammar, two frontends (the driver's case routes here, the
// REPL's branch calls the same runner):
//   /mcp auth <server>    discovery → PKCE → 本地回调 → token 交换 → 0600 库
//   /mcp unauth <server>  忘却（删库中该 server 的 token）
//   /mcp                  （裸——status，走 mcp-status.ts，不在此）
//
// Config-only lane（busy-safe）：写的是 ~/.wudao/mcp-tokens.json，不碰任何
// run 的文件；McpHttpClient 的 auth 缝 PER REQUEST 读库，本会话已建立的
// 连接下一次请求即用新 token。回执永不回显 token 值（scope/过期时间够人
// 判断了）。失败永不抛——文案给前端渲染 notice。
import { loadMcpConfig } from "../mcp/config.js";
import { isHttpMcpServer } from "../mcp/config.js";
import { runMcpOAuthFlow } from "../mcp/oauth.js";
import type { McpOAuthDeps } from "../mcp/oauth.js";
import { defaultMcpTokenStore, mcpTokensPath } from "../mcp/tokens.js";
import type { McpTokenStore } from "../mcp/tokens.js";

/** Injectable deps（测试接缝：fetch/now/openBrowser/log/onAuthorizationUrl
 * 全透传给流；tokenStore 缺省走 ~/.wudao/mcp-tokens.json）。 */
export type McpAuthCommandDeps = McpOAuthDeps & { readonly tokenStore?: McpTokenStore };

export interface RunMcpAuthCommandArgs {
  /** The raw arg string after "/mcp" ("" | "auth <server>" | "unauth <server>"). */
  readonly args: string;
  readonly workspaceRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly deps?: McpAuthCommandDeps;
}

const USAGE = [
  "用法：/mcp——MCP 服务器 + OAuth", // ω99-166d-i: #29
  "  /mcp                 server status (config + loaded tools + runtime)",
  "  /mcp auth <server>   run the OAuth flow (authorization code + PKCE, local callback)",
  "  /mcp unauth <server> forget this server's stored token",
].join("\n");

/** Run /mcp auth|unauth. Never throws — failures land in the receipt text
 *  (both frontends render notices, not error channels). */
export async function runMcpAuthCommand(args: RunMcpAuthCommandArgs): Promise<string> {
  const parts = args.args.trim().split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0 || parts.length > 2) return USAGE;
  const [verb, serverName] = parts;
  if ((verb !== "auth" && verb !== "unauth") || serverName === undefined) return USAGE;
  const env = args.env ?? process.env;
  const config = loadMcpConfig(args.workspaceRoot);
  const server = config.servers[serverName];
  if (server === undefined) {
    return `⚠️ mcp server "${serverName}" 不在配置里（.wudao/mcp.json / ~/.wudao/mcp.json）——/mcp 查看已配置的服务器`;
  }
  if (!isHttpMcpServer(server)) {
    return `⚠️ mcp server "${serverName}" 是 stdio 型（command）——OAuth 只适用于 url 型服务器`;
  }
  if (server.oauth !== true) {
    return `⚠️ mcp server "${serverName}" 未声明 "oauth": true——v1 不做 401 自动嗅探；在 mcp.json 的该服务器条目加 "oauth": true 后重试`;
  }
  const store = args.deps?.tokenStore ?? defaultMcpTokenStore(env);
  if (verb === "unauth") {
    const removed = store.remove(serverName);
    return removed
      ? `✅ mcp server "${serverName}" 的 token 已忘却（${mcpTokensPath(env)}）——重新授权用 /mcp auth ${serverName}`
      : `ℹ️ mcp server "${serverName}" 没有存过 token——无需忘却`;
  }
  const { log, ...flowDeps } = args.deps ?? {};
  const sink = log ?? ((line: string) => {
    try {
      process.stdout.write(`${line}\n`);
    } catch {
      // stdout gone — the flow continues anyway (the receipt carries the outcome)
    }
  });
  try {
    const result = await runMcpOAuthFlow({
      serverName,
      serverUrl: server.url,
      ...(server.authorizationUrl !== undefined && server.tokenUrl !== undefined
        ? { configEndpoints: { authorizationUrl: server.authorizationUrl, tokenUrl: server.tokenUrl } }
        : {}),
      ...(server.clientId !== undefined ? { clientId: server.clientId } : {}),
      deps: { ...flowDeps, log: sink },
      tokenStore: store,
    });
    const expires = result.token.expiresAt !== undefined ? new Date(result.token.expiresAt).toISOString() : "(无过期信息)";
    return [
      `✅ mcp server "${serverName}" 授权完成——scope: ${result.token.scope ?? "(default)"} · 过期: ${expires}`,
      `  token 已存 ${mcpTokensPath(env)}（0600）；本会话已建立的连接下次请求即用新 token，新连接（含重启后）自动带上。`,
    ].join("\n");
  } catch (err) {
    return `⚠️ /mcp auth ${serverName} 失败：${err instanceof Error ? err.message : String(err)}`; // ω99-205: #3
  }
}
