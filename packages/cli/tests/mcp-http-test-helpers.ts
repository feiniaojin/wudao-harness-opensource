// 16a/16b 共享的 MCP HTTP 测试 fake 工具（自 tests/mcp-http.test.ts 抽出，
// 语义不变）：结构化 McpHttpResponse 手工构造 + 脚本化 fetch 记录器。
import type { McpHttpResponse } from "../src/mcp/http.js";

const encoder = new TextEncoder();

/** A capture of one POST the client issued (the fetch seam's view). */
export interface SentPost {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export function jsonBody(post: SentPost): Record<string, unknown> {
  return JSON.parse(post.body) as Record<string, unknown>;
}

export function makeResponse(body: string | readonly Uint8Array[] | undefined, init: {
  readonly status?: number;
  readonly headers?: Record<string, string>;
}): McpHttpResponse {
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  let chunks: readonly Uint8Array[] = [];
  if (typeof body === "string") chunks = body.length === 0 ? [] : [encoder.encode(body)];
  else if (body !== undefined) chunks = body;
  let i = 0;
  return {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) <= 299,
    status: init.status ?? 200,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    ...(chunks.length > 0
      ? {
          text: async () => chunks.map((c) => new TextDecoder().decode(c)).join(""),
          body: {
            getReader: () => ({
              read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }),
              cancel: async () => {},
            }),
          },
        }
      : {}),
  };
}

export function jsonRpcResponse(id: number, result: unknown, headers: Record<string, string> = {}): McpHttpResponse {
  return makeResponse(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "content-type": "application/json", ...headers } });
}

/** Scripted fetch: answers POST i with responses[i]; records every send. */
export function scriptedFetch(responses: readonly McpHttpResponse[]): { f: typeof fetchLike; posts: SentPost[] } {
  const posts: SentPost[] = [];
  async function fetchLike(url: string, init: { headers: Record<string, string>; body: string }): Promise<McpHttpResponse> {
    posts.push({ url, headers: { ...init.headers }, body: init.body });
    const r = responses[posts.length - 1];
    if (r === undefined) throw new Error(`unexpected POST #${posts.length}: ${init.body}`);
    return r;
  }
  return { f: fetchLike, posts };
}

export function sseStream(messages: readonly unknown[]): readonly Uint8Array[] {
  const text = messages.map((m) => `event: message\nretry: 100\n: keep-alive\ndata: ${JSON.stringify(m)}\n\n`).join("");
  return [encoder.encode(text)];
}
