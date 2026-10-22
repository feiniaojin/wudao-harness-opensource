// M59 §1 — web_search: provider-configurable web search (searxng default
// recommendation / brave). The tool is created ONLY when settings configured a
// provider (the cli registry decides registration — an unconfigured search is
// simply absent from the tool list, /doctor carries the guidance). Credentials
// NEVER live in settings: `apiKeyEnv` names an ENVIRONMENT VARIABLE, read at
// call time (a missing env var is a clear per-call error, not a startup crash).
import { isIP } from "node:net";
import { buildTool } from "../tool.js";
import { classifyAddress } from "./web-fetch.js";

// M59 §1 defaults (spec-verbatim): count 8, total output truncated at 4,000
// chars on a line boundary, 15s end-to-end timeout.
export type WebSearchProvider = "searxng" | "brave";

export const WEB_SEARCH_COUNT = 8;
export const WEB_SEARCH_MAX_QUERY_CHARS = 512;
export const WEB_SEARCH_OUTPUT_MAX_CHARS = 4_000;
export const WEB_SEARCH_TIMEOUT_MS = 15_000;
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

export interface WebSearchConfig {
  readonly provider: WebSearchProvider;
  /** searxng: base endpoint (required) — GET {endpoint}/search?q=…&format=json. */
  readonly endpoint?: string;
  /** brave: the env var NAME holding the API key (required) — sent as
   *  X-Subscription-Token. The value itself never enters settings. */
  readonly apiKeyEnv?: string;
  /** Result count (default 8). */
  readonly count?: number;
  readonly timeoutMs?: number;
  /** Test seam. */
  readonly fetchImpl?: typeof fetch;
}

/** One normalized search hit. */
import { truncateSafe } from "../text-truncate.js";

export interface WebSearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/** M59 review hardening: construction-time classification of the CONFIGURED
 *  search endpoint. A settings file (e.g. a cloned repo's .wudao) aiming
 *  search at a private/loopback/link-local/metadata IP must never get the
 *  GET fired. IP-literal hosts classify directly here; HOSTNAME resolution
 *  happens in the cli settings loader (which owns the async seam). Returns
 *  the refusal reason, or undefined when the endpoint passes.
 *
 *  Residual (narrow): the hostname is classified ONCE at startup and calls
 *  never re-resolve — a post-startup DNS rebind of the endpoint hostname to
 *  a private range is not caught (web_fetch re-resolves every hop). The M68
 *  egress proxy closes this. */
export function endpointGuardReason(config: WebSearchConfig): string | undefined {
  if (config.provider !== "searxng") return undefined; // brave's endpoint is the fixed public API
  const raw = (config.endpoint ?? "").trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `web.search.endpoint "${raw}" is not a valid URL — web_search is misconfigured`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `web.search.endpoint "${raw}" must be http(s) — web_search is misconfigured`;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) === 0) return undefined; // a hostname — the loader's DNS seam classifies it
  const rule = classifyAddress(host);
  if (rule !== undefined) {
    return `web.search.endpoint "${raw}" targets a refused range — ${rule}; configure a public SearXNG instance`;
  }
  return undefined;
}

/** True when `host` is an IP literal (v4 or v6) — the loader skips DNS for
 *  these (the literal IS the address). */
export function isIpLiteralHost(host: string): boolean {
  return isIP(host.replace(/^\[|\]$/g, "")) !== 0;
}

/** Extract hits from a provider payload. SearXNG: results[] with
 *  title/url/content. Brave: web.results[] with title/url/description.
 *  Tolerant per-field string coercion; non-object arrays drop to empty. */
export function parseSearchHits(provider: WebSearchProvider, payload: unknown): readonly WebSearchHit[] {
  const root = provider === "searxng" ? payload : (payload as { web?: unknown } | undefined)?.web;
  const list = (root as { results?: unknown } | undefined)?.results;
  if (!Array.isArray(list)) return [];
  const hits: WebSearchHit[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const title = typeof rec["title"] === "string" ? rec["title"] : "";
    const url = typeof rec["url"] === "string" ? rec["url"] : "";
    if (title === "" || url === "") continue;
    const snippetRaw = provider === "searxng" ? rec["content"] : rec["description"];
    const snippet = typeof snippetRaw === "string" ? snippetRaw.replace(/\s+/g, " ").trim() : "";
    hits.push({ title, url, snippet });
  }
  return hits;
}

/** Render the numbered list (spec §1): `N. title — url\n   snippet`. */
export function formatSearchResults(hits: readonly WebSearchHit[]): string {
  return hits
    .map((h, i) => `${i + 1}. ${h.title} — ${h.url}${h.snippet !== "" ? `\n   ${h.snippet}` : ""}`)
    .join("\n");
}

/** Truncate the rendered list at the character budget on a LINE boundary (a
 *  cut snippet mid-line is noise; dropping whole entries keeps it readable). */
export function capSearchOutput(text: string, maxChars: number = WEB_SEARCH_OUTPUT_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const cut = truncateSafe(text, maxChars); // 113-A4：行界回退前置代理对安全帽
  const lastLine = cut.lastIndexOf("\n");
  const kept = lastLine > 0 ? cut.slice(0, lastLine) : cut;
  return `${kept}\n… [web_search: output truncated at ${maxChars} chars]`;
}

export function createWebSearchTool(config: WebSearchConfig) {
  const count = config.count ?? WEB_SEARCH_COUNT;
  const timeoutMs = config.timeoutMs ?? WEB_SEARCH_TIMEOUT_MS;
  const doFetch = config.fetchImpl ?? fetch;
  // M59 review hardening: one-time, construction-time endpoint
  // classification — a misconfigured or malicious endpoint fails EVERY call
  // with this error instead of ever issuing the GET.
  const configError = endpointGuardReason(config);

  return buildTool({
    name: "web_search",
    description: "Search the web (configured provider: searxng or brave) and return a numbered list of results " +
      "(title — url + snippet, up to the configured count). Zero-result queries say so plainly. " +
      "Example: {query: 'node dns.lookup all option'} finds current docs. " +
      "Do NOT use web_search to fetch a known URL (web_fetch) or to search workspace files (grep).",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Search query (non-empty, up to 512 characters)." } },
      required: ["query"],
      additionalProperties: false,
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isOpenWorld: () => true,
    isDestructive: () => false,
    async execute({ query }) {
      // Construction-time endpoint guard first (fail-closed, zero effects).
      if (configError !== undefined) {
        return { content: `web_search failed: ${configError}`, isError: true };
      }
      // Validation before effects (fail-closed): non-empty, ≤512 chars.
      if (typeof query !== "string" || query.trim() === "") {
        return { content: 'web_search refused: "query" must be a non-empty string', isError: true };
      }
      const q = query.trim();
      if (q.length > WEB_SEARCH_MAX_QUERY_CHARS) {
        return { content: `web_search refused: query is ${q.length} chars (max ${WEB_SEARCH_MAX_QUERY_CHARS}) — narrow it down`, isError: true };
      }

      let url: string;
      const headers: Record<string, string> = { accept: "application/json" };
      if (config.provider === "searxng") {
        const base = (config.endpoint ?? "").replace(/\/+$/, "");
        url = `${base}/search?q=${encodeURIComponent(q)}&format=json`;
      } else {
        const keyName = config.apiKeyEnv ?? "";
        if (keyName === "") {
          return { content: "web_search failed: brave provider requires web.search.apiKeyEnv (the env var NAME holding the key)", isError: true };
        }
        const key = process.env[keyName];
        if (key === undefined || key.trim() === "") {
          return { content: `web_search failed: env var ${keyName} (web.search.apiKeyEnv) is not set — export it and retry`, isError: true };
        }
        headers["X-Subscription-Token"] = key.trim();
        url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(q)}&count=${count}`;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let response: Response;
        try {
          response = await doFetch(url, { signal: controller.signal, headers });
        } catch (err) {
          if (controller.signal.aborted) {
            return { content: `web_search failed: timed out after ${timeoutMs / 1000}s`, isError: true };
          }
          return { content: `web_search failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
        if (!response.ok) {
          return { content: `web_search failed: HTTP ${response.status} ${response.statusText}`.trim(), isError: true };
        }
        let payload: unknown;
        try {
          payload = await response.json();
        } catch (err) {
          return { content: `web_search failed: provider response is not JSON (${err instanceof Error ? err.message : String(err)})`, isError: true };
        }
        const hits = parseSearchHits(config.provider, payload).slice(0, count);
        if (hits.length === 0) {
          return { content: `web_search: no results for "${q}"`, provenance: "web" };
        }
        const body = capSearchOutput(formatSearchResults(hits));
        return { content: `web_search: ${hits.length} result${hits.length === 1 ? "" : "s"} for "${q}"\n${body}`, provenance: "web" };
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
