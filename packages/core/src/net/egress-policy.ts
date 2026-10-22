// ω99-46 — egress proxy POLICY: the pure, transport-free half of the egress
// module. It resolves ONE EgressPolicy from the launch environment plus the
// settings `network` node, answers which proxy (if any) a given URL goes
// through, and computes the proxy-env overlay harness-spawned children see.
// Nothing here imports undici or any transport — the install half
// (net/egress.ts) owns the dispatcher, so policy stays loadable and testable
// with plain object literals (the the upstream formatpolicy.ts split).
//
// Obligations encoded here:
// - the upstream projectnot-gap (a63fb12c1): NO_PROXY entries match the host AND every
//   subdomain (`example.com` also bypasses `api.example.com`); a leading dot
//   or `*.` prefix is the same thing; `*` bypasses everything.
// - a ref: loopback is bypassed by DEFAULT (localhost / 127.0.0.0/8 / ::1 and
//   friends) — a proxy that also serves the harness's own loopback traffic
//   turns the Web UI, the ws server, and every local test server into a
//   routing loop.
// - a ref: a REJECTED proxy slot (value wudao cannot route) keeps that scheme
//   DIRECT and never falls back to another scheme's proxy — the diagnostic
//   and the route must agree.
// - a ref: credentials in proxy URLs are never echoed — error text and child
//   overlays carry the redacted form (env values the user exported pass
//   through verbatim; curl needs them).
//
// Boundary with web_fetch's SSRF guard (T0-3, documented, not silent): the
// guard resolves DNS ITSELF before every request and that does not change
// under a proxy — it still gates scheme/port/redirect/authority and still
// classifies the LOCAL resolver's view of the hostname. What a proxy changes
// is who acts on DNS: a CONNECT/socks request carries the hostname BY NAME,
// so the proxy's resolver is the one that maps it. The guard's address-class
// verdict is therefore the local machine's view, authoritative for the
// direct path and advisory under an active proxy. (Pins to the validated IP
// belong to a future milestone; the M59 header already records this.)

import { truncateSafe } from "../text-truncate.js";

/** Proxy schemes wudao routes through. socks5h is accepted as an alias: the
 *  socks connector always sends the destination BY HOSTNAME, so the proxy
 *  resolves it either way (remote DNS — the reason socks5h exists). */
export type EgressProxyScheme = "http" | "https" | "socks5";

/** The environment record policy resolution reads (process.env-shaped, so a
 *  test builds one from an object literal). */
export type EgressEnv = Readonly<Record<string, string | undefined>>;

/** The settings `network` node as the cli loader hands it over (raw values;
 *  validation and diagnostics happen here, ONE place). */
export interface EgressSettingsInput {
  /** `network.proxy` — the default proxy URL string, overriding env. */
  readonly proxy?: string;
  /** `network.proxyRoutes` — origin → proxy URL (origin-exact pins). */
  readonly proxyRoutes?: Readonly<Record<string, string>>;
}

/** Why one candidate proxy value was rejected. Warned, never thrown — a
 *  value exported for another tool must not stop the harness from starting
 *  (the upstream formatresolution contract). */
export interface EgressDiagnostic {
  /** `invalid` = unparseable; `unsupported` = a scheme wudao cannot route. */
  readonly kind: "invalid" | "unsupported";
  /** Where the value came from (env name or settings key path). */
  readonly origin: string;
  /** Operator-facing sentence; carries no credential. */
  readonly message: string;
}

/** A policy that routes nothing. */
export interface EgressDirectPolicy {
  readonly kind: "none";
  readonly diagnostics: readonly EgressDiagnostic[];
}

/** A policy with at least one proxy (a scheme default or an origin pin). */
export interface EgressRoutedPolicy {
  readonly kind: "routed";
  /** Validated proxy URL for `http:` origins, or undefined for direct. */
  readonly httpProxy?: string;
  /** Validated proxy URL for `https:` origins, or undefined for direct. */
  readonly httpsProxy?: string;
  /** The bypass list, already merged with the loopback entries. */
  readonly noProxy: string;
  /** Origin-exact pins (normalized `scheme://host[:port]` → proxy URL).
   *  Frozen at resolution; swapped only by whole-policy replacement. */
  readonly routes: ReadonlyMap<string, string>;
  readonly diagnostics: readonly EgressDiagnostic[];
}

export type EgressPolicy = EgressDirectPolicy | EgressRoutedPolicy;

/** Loopback entries merged into every routed policy's bypass list (a ref). */
export const LOOPBACK_NO_PROXY: readonly string[] = ["localhost", "127.0.0.1", "::1", "[::1]"];

/** Every environment name that carries proxy configuration (both casings,
 *  lowercase first — that is the read order too). A caller isolating a child
 *  from the machine's network policy clears exactly these. */
export const EGRESS_ENV_NAMES: readonly string[] = [
  "https_proxy",
  "HTTPS_PROXY",
  "http_proxy",
  "HTTP_PROXY",
  "all_proxy",
  "ALL_PROXY",
  "no_proxy",
  "NO_PROXY",
];

// ---------------------------------------------------------------------------
// Proxy URL validation + display helpers
// ---------------------------------------------------------------------------

const SOCKS5_PROTOCOLS = new Set(["socks5:", "socks5h:"]);
const UNSUPPORTED_PROTOCOLS = new Set(["socks:", "socks4:", "socks4a:"]);

/** Parse and classify one proxy URL. `undefined` = not a proxy wudao routes. */
export function egressProxyScheme(value: string): EgressProxyScheme | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol === "http:") return "http";
  if (parsed.protocol === "https:") return "https";
  if (SOCKS5_PROTOCOLS.has(parsed.protocol)) return "socks5";
  return undefined;
}

/** True when the value is one Node's own env-proxy parser (22.21+/24, under
 *  NODE_USE_ENV_PROXY) accepts: parseable http(s) ONLY — Node exits 1 on any
 *  other scheme, so a socks value must keep the flag withheld (a ref). */
export function isNodeEnvProxyUrl(value: string): boolean {
  try {
    const protocol = new URL(value.trim()).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** The `host:port` of a proxy URL, credentials never included. */
export function proxyHostPort(proxyUrl: string): string {
  try {
    const u = new URL(proxyUrl.trim());
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const port = u.port !== "" ? u.port : u.protocol === "https:" ? "443" : u.protocol.startsWith("socks") ? "1080" : "80";
    return `${host}:${port}`;
  } catch {
    return truncateSafe(proxyUrl, 100); // 113-A4
  }
}

/** The display form of a proxy URL with userinfo redacted. */
export function redactProxyUrl(proxyUrl: string): string {
  try {
    const u = new URL(proxyUrl.trim());
    if (u.username === "" && u.password === "") return proxyUrl.trim();
    return `${u.protocol}//${u.hostname}${u.port !== "" ? `:${u.port}` : ""}`;
  } catch {
    return "<unparseable proxy url>";
  }
}

// ---------------------------------------------------------------------------
// Environment reading (the upstream formatprecedence: lowercase first, blank = unset)
// ---------------------------------------------------------------------------

function readEnvName(env: EgressEnv, lower: string): { value: string; name: string } | undefined {
  for (const name of [lower, lower.toUpperCase()]) {
    const raw = env[name];
    if (raw === undefined) continue;
    const value = raw.trim();
    if (value !== "") return { value, name };
  }
  return undefined;
}

/** What one candidate slot supplied: accepted, rejected (diagnosed), or absent. */
type Slot = { kind: "accepted"; value: string } | { kind: "rejected" } | { kind: "absent" };
const ABSENT: Slot = { kind: "absent" };

function acceptSlot(
  candidate: { value: string; name: string } | undefined,
  diagnostics: EgressDiagnostic[],
): Slot {
  if (candidate === undefined) return ABSENT;
  if (egressProxyScheme(candidate.value) !== undefined) return { kind: "accepted", value: candidate.value.trim() };
  let parsedProtocol = "<no protocol>";
  try {
    parsedProtocol = new URL(candidate.value.trim()).protocol;
  } catch {
    /* fall through with the placeholder */
  }
  const kind = UNSUPPORTED_PROTOCOLS.has(parsedProtocol) ? "unsupported" : "invalid";
  diagnostics.push({
    kind,
    origin: candidate.name,
    message:
      kind === "unsupported"
        ? `${candidate.name} names a ${parsedProtocol.replace(":", "") || "socks"} proxy, which wudao cannot route — set http://, https://, or socks5:// instead; that value stays direct`
        : `${candidate.name} is not a valid proxy URL; that value stays direct`,
  });
  return { kind: "rejected" };
}

/** A scheme's own slot wins; an ABSENT slot falls back; a REJECTED slot stays
 *  direct (no fallback past a refusal — the diagnostic must stay true). */
function resolveSlot(own: Slot, ...fallbacks: (string | undefined)[]): string | undefined {
  if (own.kind === "accepted") return own.value;
  if (own.kind === "rejected") return undefined;
  return fallbacks.find((v) => v !== undefined);
}

function withLoopback(noProxy: string | undefined): string {
  const entries = (noProxy ?? "")
    .split(/[,\s]+/)
    .map((e) => e.trim())
    .filter((e) => e !== "");
  if (entries.includes("*")) return "*";
  const present = new Set(entries.map((e) => e.toLowerCase()));
  return [...entries, ...LOOPBACK_NO_PROXY.filter((e) => !present.has(e))].join(",");
}

// ---------------------------------------------------------------------------
// Loopback + NO_PROXY matching (the upstream projecta63fb12c1 subdomain rule)
// ---------------------------------------------------------------------------

/** Split one bypass entry into host and optional port (IPv6-safe: only a
 *  single-colon entry splits; a bracketed literal takes its port from after
 *  the bracket — getting this wrong is how `::1` becomes host `:` port `1`). */
function splitHostPort(entry: string): { host: string; port?: string } {
  if (entry.startsWith("[")) {
    const close = entry.indexOf("]");
    if (close !== -1) {
      const rest = entry.slice(close + 1);
      const host = entry.slice(1, close);
      return rest.startsWith(":") ? { host, port: rest.slice(1) } : { host };
    }
  }
  const colon = entry.indexOf(":");
  if (colon !== -1 && entry.indexOf(":", colon + 1) === -1) {
    return { host: entry.slice(0, colon), port: entry.slice(colon + 1) };
  }
  return { host: entry };
}

/** One IPv4 octet, so a loopback match cannot accept `127.999.1.1`. */
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const LOOPBACK_IPV4 = new RegExp(`^127\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);

/** Whether a host names this machine (a ref): the whole 127/8 block, the IPv6
 *  loopback/unspecified addresses, `.localhost`, and the IPv4-mapped forms. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "::" || host === "0.0.0.0") return true;
  const mappedHigh = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(host)?.[1];
  if (mappedHigh !== undefined) return Number.parseInt(mappedHigh, 16) >>> 8 === 127;
  return LOOPBACK_IPV4.test(host.startsWith("::ffff:") ? host.slice("::ffff:".length) : host);
}

/** Whether the bypass list exempts one URL. An entry matches its host and
 *  every subdomain under it; a leading `.` or `*.` is the same thing; an
 *  entry may carry `:port`; `*` bypasses everything. CIDR is NOT matched (an
 *  OS list often carries `10.0.0.0/8` — it must be rewritten as suffixes). */
export function bypassesNoProxy(noProxy: string, url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const port = url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80";
  for (const raw of noProxy.split(/[,\s]+/)) {
    const entry = raw.trim().toLowerCase();
    if (entry === "") continue;
    if (entry === "*") return true;
    const split = splitHostPort(entry);
    if (split.port !== undefined && split.port !== port) continue;
    const candidate = split.host.replace(/^\*?\./, "").replace(/\.$/, "");
    if (candidate === "") continue;
    if (host === candidate || host.endsWith(`.${candidate}`)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Policy resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the process's outbound proxy policy.
 *
 * Layering: env provides the per-scheme defaults (`HTTPS_PROXY` own slot →
 * `ALL_PROXY` → for https also the http proxy, matching undici precedence);
 * then settings take OVER — a valid `network.proxy` replaces both scheme
 * defaults (the settings tier is the deliberate override), and
 * `network.proxyRoutes` adds origin-exact pins on top. `NO_PROXY` is env-only
 * and always gains the loopback entries. With no scheme default and no pin
 * the policy is `none`: install then does NOTHING (zero-behavior-change red
 * line — no dispatcher, no setGlobalDispatcher call).
 *
 * A settings `network` node is global-tier only in practice — the cli trust
 * gate drops it from project/local tiers (a cloned repo must not reroute the
 * operator's egress; same class as telemetry/slack).
 */
export function resolveEgressPolicy(env: EgressEnv, settings?: EgressSettingsInput): EgressPolicy {
  const diagnostics: EgressDiagnostic[] = [];
  const all = acceptSlot(readEnvName(env, "all_proxy"), diagnostics);
  const allValue = all.kind === "accepted" ? all.value : undefined;
  const envHttp = acceptSlot(readEnvName(env, "http_proxy"), diagnostics);
  const envHttps = acceptSlot(readEnvName(env, "https_proxy"), diagnostics);
  let httpProxy = resolveSlot(envHttp, allValue);
  let httpsProxy = resolveSlot(envHttps, allValue, httpProxy);

  // Settings override: one valid default proxy replaces both scheme slots.
  if (settings?.proxy !== undefined && settings.proxy.trim() !== "") {
    const slot = acceptSlot({ value: settings.proxy, name: "network.proxy" }, diagnostics);
    if (slot.kind === "accepted") {
      httpProxy = slot.value;
      httpsProxy = slot.value;
    }
  }

  // Origin-exact pins: normalized origin keys, validated values, invalid
  // entries dropped with a diagnostic (never fatal).
  const routes = new Map<string, string>();
  const routeEntries = Object.entries(settings?.proxyRoutes ?? {});
  for (const [rawKey, rawValue] of routeEntries) {
    let key: URL;
    try {
      key = new URL(rawKey.trim());
    } catch {
      diagnostics.push({
        kind: "invalid",
        origin: `network.proxyRoutes["${rawKey}"]`,
        message: `network.proxyRoutes key "${rawKey}" is not a valid origin (use scheme://host[:port], e.g. "https://api.openai.com"); entry ignored`,
      });
      continue;
    }
    if (typeof rawValue !== "string") {
      diagnostics.push({
        kind: "invalid",
        origin: `network.proxyRoutes["${rawKey}"]`,
        message: `network.proxyRoutes["${rawKey}"] must be a proxy URL string; entry ignored`,
      });
      continue;
    }
    if (acceptSlot({ value: rawValue, name: `network.proxyRoutes["${rawKey}"]` }, diagnostics).kind !== "accepted") {
      continue; // diagnostic already pushed for the unroutable value
    }
    routes.set(key.origin, rawValue.trim());
  }

  const noProxy = withLoopback(readEnvName(env, "no_proxy")?.value);
  if (httpProxy === undefined && httpsProxy === undefined && routes.size === 0) {
    return { kind: "none", diagnostics };
  }
  const policy: EgressRoutedPolicy = Object.freeze({
    kind: "routed",
    ...(httpProxy !== undefined ? { httpProxy } : {}),
    ...(httpsProxy !== undefined ? { httpsProxy } : {}),
    noProxy,
    routes: Object.freeze(routes),
    diagnostics,
  });
  return policy;
}

/**
 * Which proxy one URL goes through under a policy — the single answer the
 * installed dispatcher's routing AND any call-site branch consult.
 *
 * Order: an origin-exact pin wins FIRST and deliberately ignores NO_PROXY and
 * the loopback bypass (a pin is the user routing THAT origin on purpose —
 * the bypasses exist to keep accidental DEFAULT routing away from loopback;
 * this is also what makes the local-stub egress tests possible). Then the
 * scheme default, minus loopback, minus NO_PROXY.
 */
export function proxyForUrl(policy: EgressRoutedPolicy, url: URL): string | undefined {
  const pinned = policy.routes.get(url.origin);
  if (pinned !== undefined) return pinned;
  const proxy = url.protocol === "https:" ? policy.httpsProxy : url.protocol === "http:" ? policy.httpProxy : undefined;
  if (proxy === undefined) return undefined;
  if (isLoopbackHost(url.hostname)) return undefined;
  return bypassesNoProxy(policy.noProxy, url) ? undefined : proxy;
}

// ---------------------------------------------------------------------------
// Child-process env overlay (the proxy half of scrubChildEnv's policy)
// ---------------------------------------------------------------------------

const POLICY_FIELD_NAMES = [
  ["httpsProxy", ["https_proxy", "HTTPS_PROXY"]] as const,
  ["httpProxy", ["http_proxy", "HTTP_PROXY"]] as const,
];

/**
 * The proxy names a spawned child needs, as an overlay (undefined = remove).
 * Empty object when no policy is active — the caller's env passes through
 * untouched (byte-identical, the §2.7 negative control).
 *
 * Semantics (the upstream format`proxyEnvironmentForChild`): a name the user exported keeps
 * the user's value (their curl/git settings, in their casing); a name nobody
 * set receives the resolved value, so a child never routes differently than
 * the parent (NODE_USE_ENV_PROXY does not read ALL_PROXY). The bypass list is
 * always the resolved one — it only ever ADDS loopback to what the user
 * wrote. NODE_USE_ENV_PROXY=1 rides along EXCEPT when an HTTP(S)_PROXY value
 * the child receives is not http(s) — Node 22.21+/24 parses those under the
 * flag BEFORE running the program and exits 1 on a socks value, so the flag
 * is withheld (the value stays for curl/git; a Node child connects directly).
 */
export function egressChildEnvOverlay(
  policy: EgressPolicy,
  env: EgressEnv,
): Readonly<Record<string, string | undefined>> {
  if (policy.kind !== "routed") return {};
  const overlay: Record<string, string | undefined> = {};
  for (const [field, names] of POLICY_FIELD_NAMES) {
    const resolved = policy[field];
    const named = readEnvName(env, names[0]);
    const value = named !== undefined ? named.value : resolved;
    for (const name of names) overlay[name] = value;
  }
  overlay["no_proxy"] = policy.noProxy;
  overlay["NO_PROXY"] = policy.noProxy;
  const nodeParsed = POLICY_FIELD_NAMES.flatMap(([, names]) => names);
  const offending = nodeParsed.some((name) => overlay[name] !== undefined && !isNodeEnvProxyUrl(String(overlay[name])));
  if (!offending) overlay["NODE_USE_ENV_PROXY"] = "1";
  return overlay;
}

// ---------------------------------------------------------------------------
// Proxy failure attribution (the 归因红线)
// ---------------------------------------------------------------------------

/** The two honest stages of a proxy-side failure. Both mean the request
 *  NEVER reached the target — that is what separates them from an endpoint
 *  error and what the message must say. (`unreachable` = transport to the
 *  proxy itself failed: DNS/TCP/refused/timeout. `handshake` = the proxy was
 *  reached but refused or mangled the tunnel: CONNECT non-200, 407 auth, TLS
 *  to an https proxy, socks greeting/reply. Mid-tunnel failures are
 *  deliberately NOT attributed — a reset there could come from either side,
 *  and blaming the proxy would be the same masquerade in reverse.) */
export type ProxyEgressStage = "unreachable" | "handshake";

/** A proxy-side egress failure, named as one. Carries the proxy's
 *  host:port and the stage; the message never blames the target. The
 *  providers' retry classification recognizes it (fail fast — the ladder
 *  cannot heal a misconfigured proxy) and any cause-walking consumer can
 *  surface it verbatim. */
export class ProxyEgressError extends Error {
  readonly proxy: string;
  readonly stage: ProxyEgressStage;

  constructor(stage: ProxyEgressStage, proxyUrl: string, cause: unknown) {
    const hostPort = proxyHostPort(proxyUrl);
    const causeText = causeSummary(cause);
    super(
      stage === "unreachable"
        ? `egress proxy ${hostPort} unreachable (${causeText}) — the request never left this machine; fix the proxy address (network.proxy / HTTPS_PROXY) or start the proxy`
        : `egress proxy ${hostPort} refused the tunnel (${causeText}) — the request never reached the target; check the proxy's rules/auth or point network.proxy / HTTPS_PROXY at a working proxy`,
    );
    this.name = "ProxyEgressError";
    this.proxy = redactProxyUrl(proxyUrl);
    this.stage = stage;
    this.cause = cause;
  }
}

/** One-line, credential-free summary of an error for the message body. */
function causeSummary(err: unknown): string {
  // 113-A4：错误首行帽代理对安全（消息体会进设置诊断面）。
  if (err instanceof Error) return truncateSafe(err.message.split("\n")[0]!, 200);
  return truncateSafe(String(err).split("\n")[0]!, 200);
}

/** undici's typed proxy-connection failures (wrapped causes). */
const PROXY_UNREACHABLE_CODES: ReadonlySet<string> = new Set(["UND_ERR_PRX_CONN"]);
const PROXY_HANDSHAKE_CODES: ReadonlySet<string> = new Set(["UND_ERR_PRX_TLS"]);
/** undici messages that only ever mean the proxy refused the tunnel. */
const PROXY_HANDSHAKE_MESSAGES: readonly RegExp[] = [
  /Proxy response \(\d+\) !== 200/,
  /Proxy Authentication Required/,
  /^Proxy Connection failed/i,
  /^Secure Proxy Connection failed/i,
];
/** Establishment failures: on a proxied route these name the PROXY
 *  connection (the only one the client opens — the target goes by name). */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const SOCKS_HANDSHAKE_MESSAGES: readonly RegExp[] = [
  /proxy rejected/i,
  /invalid socks[45]?/i,
  /authentication failed/i,
  /proxy connection timed out/i,
  /^socket closed$/i,
  /malformed/i,
];

/** Whether a walked error's `.code` matches a set (defensive: non-strings
 *  simply do not match). */
function codeIn(err: unknown, codes: ReadonlySet<string>): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && codes.has(code);
}

/**
 * Classify one already-identified-as-proxy-side error into a stage, walking
 * its cause chain (bounded) — the undici wrappers put the discriminator one
 * or two hops down. Returns undefined when nothing proxy-side is found: the
 * error then passes through untouched (attribution must never guess).
 *
 * @param err - the error the dispatcher delivered (any hop of it counts).
 * @param proxyUrl - the proxy this request was routed through.
 */
export function proxyFailureOf(err: unknown, proxyUrl: string): ProxyEgressError | undefined {
  const socksRoute = egressProxyScheme(proxyUrl) === "socks5";
  let hop: unknown = err;
  for (let depth = 0; hop !== null && hop !== undefined && depth < 5; depth += 1) {
    if (hop instanceof ProxyEgressError) return hop;
    if (codeIn(hop, PROXY_UNREACHABLE_CODES)) return new ProxyEgressError("unreachable", proxyUrl, err);
    if (codeIn(hop, PROXY_HANDSHAKE_CODES)) return new ProxyEgressError("handshake", proxyUrl, err);
    const message = hop instanceof Error ? hop.message : "";
    if (PROXY_HANDSHAKE_MESSAGES.some((re) => re.test(message))) return new ProxyEgressError("handshake", proxyUrl, err);
    // On ANY proxied route the client's only TCP connection is to the proxy
    // (the target is reached BY NAME through it), so a raw establishment
    // error is the proxy connection failing — verified empirically for
    // undici 8.10's ProxyAgent, which surfaces a dead proxy as a bare
    // ECONNREFUSED with no wrapper.
    if (codeIn(hop, NETWORK_CODES)) return new ProxyEgressError("unreachable", proxyUrl, err);
    if (socksRoute && SOCKS_HANDSHAKE_MESSAGES.some((re) => re.test(message))) {
      return new ProxyEgressError("handshake", proxyUrl, err);
    }
    hop = (hop as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Walk a thrown error's cause chain (bounded) for a ProxyEgressError — the
 *  predicate the providers' retry classification and any diagnostics use to
 *  recognize a proxy-attributed failure regardless of the TypeError undici's
 *  fetch wraps it in. */
export function findProxyEgressCause(err: unknown, depth = 0): ProxyEgressError | undefined {
  if (!(err instanceof Error) || depth > 4) return undefined;
  if (err instanceof ProxyEgressError) return err;
  return findProxyEgressCause((err as { cause?: unknown }).cause, depth + 1) ?? undefined;
}



