// M59 §3 — the web settings node, resolved through the M57 two-tier reader
// (global < project, project wins on scalars — the deepMergeSettings
// semantics; the det suite pins provider/endpoint project-wins). Loader
// contract follows output-config.ts: missing/empty → defaults (silent);
// malformed/wrong-typed values → warning + per-field fallback (never fatal);
// unknown keys → warning.
//
// Settings shape (.wudao/settings.json, both tiers):
//   "web": {
//     "search":   { "provider": "searxng" | "brave", "endpoint": "…",
//                   "apiKeyEnv": "ENV_VAR_NAME", "count": 8 },
//     "fetch":    { "maxChars": 16000, "allowedPorts": [8080] },
//     "allowDomains": ["example.com", "*.github.com"]
//   }
// Credentials NEVER live here — apiKeyEnv names an environment variable.
import type { WebSearchConfig, WebSearchProvider } from "@wudao-org/core";
import { classifyAddress, endpointGuardReason, isIpLiteralHost } from "@wudao-org/core";
import { lookup as dnsLookup } from "node:dns/promises";
import { loadLayeredSettings } from "./settings-layer.js";

export interface WebSearchSettings {
  /** false when no valid search config exists → web_search NOT registered. */
  readonly configured: boolean;
  readonly provider: WebSearchProvider | undefined;
  readonly endpoint: string | undefined;
  readonly apiKeyEnv: string | undefined;
  /** Result count (default 8). */
  readonly count: number;
}

export interface WebFetchSettings {
  /** Output shaping budget (default 16,000). */
  readonly maxChars: number;
  /** Ports allowed IN ADDITION to 80/443. */
  readonly allowedPorts: readonly number[];
}

export interface WebSettings {
  readonly search: WebSearchSettings;
  readonly fetch: WebFetchSettings;
  /** Domains pre-approved for web_fetch (exact or *.suffix). */
  readonly allowDomains: readonly string[];
}

export const DEFAULT_WEB_SETTINGS: WebSettings = {
  search: { configured: false, provider: undefined, endpoint: undefined, apiKeyEnv: undefined, count: 8 },
  fetch: { maxChars: 16_000, allowedPorts: [] },
  allowDomains: [],
};

export type WebWarn = (message: string) => void;

/** DNS seam for the endpoint guard (tests inject a mock; the default is the
 *  real resolver — IP literals never hit it, isIpLiteralHost short-circuits). */
export type EndpointLookup = (hostname: string) => Promise<readonly { address: string; family: number }[]>;

const defaultEndpointLookup: EndpointLookup = async (hostname) => dnsLookup(hostname, { all: true });

/** R2 fix: a blackholed resolver must not stall STARTUP behind the OS
 *  resolver timeout when search is configured with a hostname endpoint. The
 *  lookup races this budget; a timeout is a PASS-THROUGH (search stays
 *  configured — ENOTFOUND-class failures were already graceful). */
export const ENDPOINT_LOOKUP_BUDGET_MS = 3_000;

function withLookupBudget(
  lookup: EndpointLookup,
  hostname: string,
  budgetMs: number,
): Promise<readonly { address: string; family: number }[]> {
  return Promise.race([
    lookup(hostname),
    new Promise<readonly { address: string; family: number }[]>((resolve) => {
      const timer = setTimeout(() => resolve([]), budgetMs);
      timer.unref(); // a settled race must never hold the process open
    }),
  ]);
}

function defaultWarn(message: string): void {
  process.stderr.write(`${message}\n`);
}

const KNOWN_SEARCH_KEYS = ["provider", "endpoint", "apiKeyEnv", "count"] as const;
const KNOWN_FETCH_KEYS = ["maxChars", "allowedPorts"] as const;
const PROVIDERS: readonly WebSearchProvider[] = ["searxng", "brave"];

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const asString = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

const asPositiveInt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;

function warnUnknown(record: Record<string, unknown>, known: readonly string[], node: string, warn: WebWarn): void {
  const unknown = Object.keys(record).filter((k) => !(known as readonly string[]).includes(k));
  if (unknown.length > 0) warn(`⚠️ .wudao/settings.json: unknown web.${node} key(s) ignored: ${unknown.join(", ")}`);
}

export async function loadWebSettings(
  workspaceRoot: string,
  warn: WebWarn = defaultWarn,
  opts?: {
    readonly endpointLookup?: EndpointLookup;
    readonly lookupBudgetMs?: number;
    /** 安全审计 2026-11 C3 — true 时未信任工作区的 `web` 节点整体丢弃
     *  （allowDomains / fetch.allowedPorts / search 同属外联预授权面，
     *  settings-layer.suppressUntrustedProjectSurface 落地）；/trust 后恢复。 */
    readonly suppressUntrustedProject?: boolean;
  },
): Promise<WebSettings> {
  const layered = await loadLayeredSettings(workspaceRoot, warn, undefined, {
    suppressUntrustedProject: opts?.suppressUntrustedProject === true,
  });
  const node = layered.effective["web"];
  if (node === undefined) return DEFAULT_WEB_SETTINGS;
  const record = asRecord(node);
  if (record === undefined) {
    warn('⚠️ .wudao/settings.json: "web" must be an object {search,fetch,allowDomains}; ignored');
    return DEFAULT_WEB_SETTINGS;
  }
  const unknown = Object.keys(record).filter((k) => k !== "search" && k !== "fetch" && k !== "allowDomains");
  if (unknown.length > 0) warn(`⚠️ .wudao/settings.json: unknown web key(s) ignored: ${unknown.join(", ")}`);

  // --- search -------------------------------------------------------------
  let search: WebSearchSettings = DEFAULT_WEB_SETTINGS.search;
  const searchNode = record["search"];
  if (searchNode !== undefined) {
    const searchRecord = asRecord(searchNode);
    if (searchRecord === undefined) {
      warn('⚠️ .wudao/settings.json: "web.search" must be an object; web_search stays unregistered');
    } else {
      warnUnknown(searchRecord, KNOWN_SEARCH_KEYS, "search", warn);
      const providerRaw = asString(searchRecord["provider"]) ?? "";
      const provider = PROVIDERS.find((p) => p === providerRaw.toLowerCase()) as WebSearchProvider | undefined;
      if (provider === undefined) {
        warn(`⚠️ web.search.provider must be one of ${PROVIDERS.join(", ")} (got "${providerRaw}"); web_search stays unregistered`);
      } else {
        const endpoint = asString(searchRecord["endpoint"]);
        const apiKeyEnv = asString(searchRecord["apiKeyEnv"]);
        // Provider-required fields — missing one unregisters the tool with a
        // warning naming what to add (spec: /doctor carries the guidance).
        if (provider === "searxng" && endpoint === undefined) {
          warn("⚠️ web.search.provider=searxng requires web.search.endpoint (the self-hosted base URL); web_search stays unregistered");
        } else if (provider === "brave" && apiKeyEnv === undefined) {
          warn("⚠️ web.search.provider=brave requires web.search.apiKeyEnv (the env var NAME holding the key); web_search stays unregistered");
        } else {
          const countRaw = asPositiveInt(searchRecord["count"]) ?? 8;
          if (searchRecord["count"] !== undefined && countRaw !== searchRecord["count"]) {
            warn(`⚠️ web.search.count must be a positive integer; using ${countRaw}`);
          }
          if (countRaw > 20) {
            warn(`⚠️ web.search.count clamped to 20 (got ${countRaw})`);
          }
          search = { configured: true, provider, endpoint, apiKeyEnv, count: Math.min(countRaw, 20) };
        }
      }
    }
  }

  // --- fetch --------------------------------------------------------------
  let fetchSettings = DEFAULT_WEB_SETTINGS.fetch;
  const fetchNode = record["fetch"];
  if (fetchNode !== undefined) {
    const fetchRecord = asRecord(fetchNode);
    if (fetchRecord === undefined) {
      warn('⚠️ .wudao/settings.json: "web.fetch" must be an object; defaults applied');
    } else {
      warnUnknown(fetchRecord, KNOWN_FETCH_KEYS, "fetch", warn);
      const maxChars = asPositiveInt(fetchRecord["maxChars"]);
      if (fetchRecord["maxChars"] !== undefined) {
        if (maxChars === undefined) warn("⚠️ web.fetch.maxChars must be a positive integer; using 16000");
        else fetchSettings = { ...fetchSettings, maxChars };
      }
      const portsRaw = fetchRecord["allowedPorts"];
      if (portsRaw !== undefined) {
        if (!Array.isArray(portsRaw) || portsRaw.some((p) => !asPositiveInt(p) || (p as number) > 65535)) {
          warn("⚠️ web.fetch.allowedPorts must be an array of ports 1-65535; ignored (80/443 remain)");
        } else {
          fetchSettings = { ...fetchSettings, allowedPorts: portsRaw as number[] };
        }
      }
    }
  }

  // --- allowDomains --------------------------------------------------------
  let allowDomains: readonly string[] = [];
  const allowRaw = record["allowDomains"];
  if (allowRaw !== undefined) {
    if (!Array.isArray(allowRaw) || allowRaw.some((d) => typeof d !== "string")) {
      warn("⚠️ web.allowDomains must be a string[]; ignored (web_fetch will ask per call)");
    } else {
      allowDomains = allowRaw.map((d) => (d as string).trim().toLowerCase()).filter((d) => d !== "");
    }
  }

  // --- M59 review hardening: the configured search endpoint's NETWORK SCOPE.
  // A settings file (a cloned repo's .wudao included) must not be able to aim
  // the search GET at loopback/private/link-local/metadata ranges. IP literals
  // classify synchronously (endpointGuardReason); hostnames resolve through
  // the lookup seam under a startup-safe budget. An unresolvable hostname
  // passes (not a scope violation — the call fails loudly later); a refused
  // range UNREGISTERS web_search with a warning naming the endpoint.
  // RESIDUAL (narrow, documented): the hostname is resolved ONCE here, and
  // web_search never re-resolves at call time — a post-startup DNS rebind of
  // the endpoint hostname to a private range is not caught (unlike
  // web_fetch's per-hop re-resolution). The M68 egress proxy closes it.
  if (search.configured && search.provider !== undefined) {
    const candidate: WebSearchConfig = {
      provider: search.provider,
      ...(search.endpoint !== undefined ? { endpoint: search.endpoint } : {}),
      ...(search.apiKeyEnv !== undefined ? { apiKeyEnv: search.apiKeyEnv } : {}),
      count: search.count,
    };
    const literalReason = endpointGuardReason(candidate);
    if (literalReason !== undefined) {
      warn(`⚠️ ${literalReason}; web_search stays unregistered`);
      search = DEFAULT_WEB_SETTINGS.search;
    } else if (search.provider === "searxng" && search.endpoint !== undefined) {
      const host = new URL(search.endpoint).hostname.replace(/^\[|\]$/g, "");
      if (!isIpLiteralHost(host)) {
        try {
          const addresses = await withLookupBudget(
            opts?.endpointLookup ?? defaultEndpointLookup,
            host,
            opts?.lookupBudgetMs ?? ENDPOINT_LOOKUP_BUDGET_MS,
          );
          for (const { address } of addresses) {
            const rule = classifyAddress(address);
            if (rule !== undefined) {
              warn(`⚠️ web.search.endpoint "${search.endpoint}" resolves to ${address} — ${rule}; web_search stays unregistered`);
              search = DEFAULT_WEB_SETTINGS.search;
              break;
            }
          }
        } catch {
          // unresolvable: not a scope violation — the call fails loudly later
        }
      }
    }
  }

  return { search, fetch: fetchSettings, allowDomains };
}

/** The core-side search config for tool construction (undefined when the
 *  provider is unconfigured — the registry then skips web_search). */
export function webSearchConfig(settings: WebSettings): WebSearchConfig | undefined {
  const s = settings.search;
  if (!s.configured || s.provider === undefined) return undefined;
  return {
    provider: s.provider,
    ...(s.endpoint !== undefined ? { endpoint: s.endpoint } : {}),
    ...(s.apiKeyEnv !== undefined ? { apiKeyEnv: s.apiKeyEnv } : {}),
    count: s.count,
  };
}
