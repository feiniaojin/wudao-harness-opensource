// M59 §2 — web_fetch: zero-config, SSRF-guarded HTTP(S) text fetch. The
// security core of the milestone lives here: scheme allowlist, per-hop
// re-resolution + private-range rejection, port allowlist, content-type gate,
// size cap, and an end-to-end timeout. Rejections are ERRORS that NAME the
// rule they hit (spec: "拒绝即报错,错误信息说明命中的规则") — a silent
// generic failure would hide which guard fired.
//
// Seams (both injectable, defaults are the real thing): `lookup` (DNS) and
// `fetch` (HTTP) — the SSRF matrix is unit/det-testable with a scripted
// resolver and a scripted responder, no network, no localhost listeners.
//
// Residual risk (documented, v1): the guard resolves DNS itself, then fetch
// re-resolves at connect time — a rebinding window of milliseconds exists
// between the two, and it applies to EVERY hop's connect equally (the same
// attacker class, no widening in practice). The real fix — pinning the
// connection to the validated IP or routing egress through a proxy — belongs
// to the M68 proxy milestone, not this tool.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { truncateSafe, truncateTailSafe } from "../text-truncate.js";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import TurndownService from "turndown";
import { buildTool } from "../tool.js";
import { LONG_OUTPUT_GUIDANCE } from "./long-output.js";

// M59 §2 defaults (spec-verbatim): 2MB total cap, 15s end-to-end timeout,
// ports 80/443 (settings `web.fetch.allowedPorts` EXTENDS, never removes),
// 16k output shaping (`web.fetch.maxChars`).
export const WEB_FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const WEB_FETCH_TIMEOUT_MS = 15_000;
export const WEB_FETCH_MAX_CHARS = 16_000;
export const WEB_FETCH_ALLOWED_PORTS: readonly number[] = [80, 443];
export const WEB_FETCH_MAX_REDIRECTS = 5;

/** The fetchable media types (spec list, exact): anything else is refused as
 *  binary/unsupported with a clear hint. Parameters (charset=…) are ignored
 *  for the gate; an ABSENT content-type is treated as text/plain (the
 *  browsers' precedent — no header is not a detected binary). */
const ALLOWED_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "text/html",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/xml",
]);

/** DNS resolution seam. Default = node dns.lookup {all:true}. Returns every
 *  address so the guard can check them ALL (one private A record among six
 *  publics is still a refusal). */
export type DnsLookup = (hostname: string) => Promise<readonly { address: string; family: number }[]>;

const defaultLookup: DnsLookup = async (hostname) => dnsLookup(hostname, { all: true });

/** The HTTP seam (scripted responders in tests). */
export type FetchLike = typeof fetch;

export interface WebFetchOptions {
  /** Output shaping budget, `web.fetch.maxChars` (default 16,000). */
  readonly maxChars?: number;
  /** Ports allowed IN ADDITION to the always-on 80/443 (`web.fetch.allowedPorts`). */
  readonly allowedPorts?: readonly number[];
  readonly timeoutMs?: number;
  /** M24-style spill directory: shaped (truncated) outputs land here in full
   *  so read_file can page through them. Absent → marker-only truncation. */
  readonly spillDir?: string;
  /** Test seams. */
  readonly lookup?: DnsLookup;
  readonly fetchImpl?: FetchLike;
}

// ---------------------------------------------------------------------------
// M59 §2 — IP classification (pure, the heart of the SSRF matrix)
// ---------------------------------------------------------------------------

/** Parse a dotted-quad into 4 octets, or undefined. */
function parseIPv4(ip: string): [number, number, number, number] | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    octets.push(n);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

/** Expand an IPv6 address (with :: compression and optional embedded IPv4
 *  tail) into a 128-bit BigInt, or undefined when unparseable. Zone ids
 *  (%eth0) are stripped first. */
function expandIPv6(ip: string): bigint | undefined {
  const bare = ip.split("%")[0]!;
  const [headRaw, tailRaw] = (() => {
    const idx = bare.indexOf("::");
    if (idx === -1) return [bare, undefined] as const;
    return [bare.slice(0, idx), bare.slice(idx + 2)] as const;
  })();
  const headGroups: number[] = [];
  const tailGroups: number[] = [];
  const parseSide = (side: string | undefined, out: number[]): boolean => {
    if (side === undefined || side === "") return true;
    const groups = side.split(":");
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]!;
      // Embedded IPv4 tail ("::ffff:1.2.3.4") — the last group may be a quad.
      if (g.includes(".")) {
        if (i !== groups.length - 1) return false;
        const v4 = parseIPv4(g);
        if (v4 === undefined) return false;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
        return true;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return false;
      out.push(parseInt(g, 16));
    }
    return true;
  };
  if (!parseSide(headRaw, headGroups) || !parseSide(tailRaw, tailGroups)) return undefined;
  const total = headGroups.length + tailGroups.length;
  if (bare.includes("::")) {
    if (total > 7) return undefined; // :: must replace at least one zero group... (8 groups + :: is invalid)
  } else if (total !== 8) {
    return undefined;
  }
  const groups = [...headGroups, ...new Array<number>(8 - total).fill(0), ...tailGroups];
  let value = 0n;
  for (const g of groups) value = (value << 16n) | BigInt(g);
  return value;
}

/** Classify one address against the refusal matrix. Returns the RULE that
 *  refuses it (for the error message), or undefined when public. Covers:
 *  loopback (127/8, ::1), private (10/8, 172.16/12, 192.168/16), link-local
 *  (169.254/16 — incl. cloud metadata), ULA (fc00::/7), fe80::/10,
 *  0.0.0.0 / ::, and the IPv4-mapped/embedded IPv6 forms of all of them. */
export function classifyAddress(rawAddress: string): string | undefined {
  const address = rawAddress.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = parseIPv4(address) ?? [0, 0, 0, 0];
    if (a === 0) return "unspecified address (0.0.0.0/8)";
    if (a === 10) return "private network (10.0.0.0/8)";
    if (a === 127) return "loopback (127.0.0.0/8)";
    if (a === 169 && b === 254) return "link-local / cloud metadata (169.254.0.0/16)";
    if (a === 172 && b >= 16 && b <= 31) return "private network (172.16.0.0/12)";
    if (a === 192 && b === 168) return "private network (192.168.0.0/16)";
    return undefined;
  }
  if (family === 6) {
    const v = expandIPv6(address);
    if (v === undefined) return `unparseable address ("${rawAddress}")`;
    // IPv4-mapped (::ffff:a.b.c.d — top 96 bits 0…0:ffff) and the deprecated
    // IPv4-compatible form (::a.b.c.d — top 96 bits all zero): classify the
    // embedded IPv4 — a mapped 127.0.0.1 is a loopback, not a "public" IPv6.
    if (v >> 32n === 0xffffn || (v >> 32n === 0n && v !== 0n && v !== 1n)) {
      const embedded = [(v >> 24n) & 0xffn, (v >> 16n) & 0xffn, (v >> 8n) & 0xffn, v & 0xffn].map((x) => Number(x)).join(".");
      const mapped = classifyAddress(embedded);
      if (mapped !== undefined) return `${mapped} [IPv4-mapped ${address}]`;
      return undefined;
    }
    if (v === 0n) return "unspecified address (::)";
    if (v === 1n) return "loopback (::1)";
    // Prefix checks on the FIRST hextet (fc00::/7 → 0xfc00-0xfdff,
    // fe80::/10 → 0xfe80-0xfebf) — never raw whole-address comparisons.
    const first = Number(v >> 112n);
    if (first >= 0xfc00 && first <= 0xfdff) return "unique local address (fc00::/7)";
    if (first >= 0xfe80 && first <= 0xfebf) return "IPv6 link-local (fe80::/10)";
    return undefined;
  }
  return `non-IP address ("${rawAddress}")`;
}

/** The allowlist matcher shared by the permission layer (`web.allowDomains`:
 *  exact or `*.suffix` — a wildcard entry matches the bare suffix AND any
 *  subdomain). Case-insensitive; hosts never carry brackets/ports here. */
export function domainMatchesAllowlist(host: string, allowDomains: readonly string[]): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "") return false;
  for (const raw of allowDomains) {
    const entry = raw.trim().toLowerCase();
    if (entry === "") continue;
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(2);
      if (h === suffix || h.endsWith(`.${suffix}`)) return true;
    } else if (h === entry) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The guard (pure URL/scheme/port validation + resolver-backed IP checks)
// ---------------------------------------------------------------------------

export type FetchGuardResult = { readonly ok: true; readonly url: URL } | { readonly ok: false; readonly reason: string };

/** Validate scheme + port against the allowlist (no DNS). */
function validateUrl(url: URL, allowedPorts: ReadonlySet<number>): string | undefined {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `scheme "${url.protocol.replace(/:$/, "")}" is not allowed (web_fetch permits http/https only)`;
  }
  const portText = url.port;
  if (portText !== "") {
    const port = Number(portText);
    if (!allowedPorts.has(port)) {
      return `port ${port} is not allowed (web_fetch permits 80/443${allowedPorts.size > 2 ? ` + configured ${[...allowedPorts].filter((p) => p !== 80 && p !== 443).join("/")}` : ""})`;
    }
  }
  return undefined;
}

/** Resolve + classify every address behind a hostname. */
async function guardHostname(hostname: string, lookup: DnsLookup): Promise<string | undefined> {
  let addresses: readonly { address: string; family: number }[];
  try {
    addresses = await lookup(hostname);
  } catch (err) {
    return `DNS lookup failed for ${hostname} (${err instanceof Error ? err.message : String(err)})`;
  }
  if (addresses.length === 0) return `DNS returned no addresses for ${hostname}`;
  for (const { address } of addresses) {
    const rule = classifyAddress(address);
    if (rule !== undefined) return `${hostname} resolves to ${address} — ${rule}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Output shaping (M46 head/tail discipline, char-budgeted for web text)
// ---------------------------------------------------------------------------

/** The truncation marker body (deterministic, states the budget). */
export function webFetchOmissionMarker(omittedChars: number, maxChars: number): string {
  return `… [web_fetch: omitted ${omittedChars} chars — output capped at web.fetch.maxChars=${maxChars}] …`;
}

/** Shape raw into head + marker + tail when it exceeds the budget. Returns
 *  undefined when no shaping is needed. Head-heavy (60/40): the top of a web
 *  page carries title/headings/context, the tail often references/footers. */
export function shapeWebFetchOutput(raw: string, maxChars: number): string | undefined {
  if (raw.length <= maxChars) return undefined;
  const head = Math.ceil((maxChars * 3) / 5);
  const tail = Math.floor((maxChars * 2) / 5);
  const omitted = raw.length - head - tail;
  // 113-A4：头尾帽均代理对安全（省略计数按名义 head/tail，纯展示）。
  return `${truncateSafe(raw, head)}\n${webFetchOmissionMarker(omitted, maxChars)}\n${truncateTailSafe(raw, tail)}`;
}

/** Spill the FULL text next to the shaped result (M24 seam, sha16 name —
 *  identical bodies share one file). Best-effort: a failed write just means
 *  no path note. */
function spill(raw: string, spillDir: string): string | undefined {
  try {
    mkdirSync(spillDir, { recursive: true });
    const name = `${createHash("sha256").update(raw).digest("hex").slice(0, 16)}.txt`;
    const path = join(spillDir, name);
    writeFileSync(path, raw, "utf8");
    return path;
  } catch {
    return undefined;
  }
}

// One shared turndown instance: the conversion config is fixed and the DOM
// walk is stateless per call. script/style are dropped before conversion
// (page chrome and inline handlers are never context).
const htmlToMarkdown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
htmlToMarkdown.remove(["script", "style"]);

/** Decode a response body under the declared charset; unknown/unsupported
 *  charsets and invalid byte sequences fall back to UTF-8 replacement
 *  (U+FFFD), never a crash (spec §2). */
function decodeBody(bytes: Uint8Array, charsetRaw: string | undefined): { text: string; charset: string } {
  const charset = (charsetRaw ?? "").trim().toLowerCase();
  if (charset !== "" && charset !== "utf-8" && charset !== "utf8") {
    try {
      return { text: new TextDecoder(charset).decode(bytes), charset };
    } catch {
      // unknown label → UTF-8 replacement below
    }
  }
  return { text: new TextDecoder("utf-8").decode(bytes), charset: charset === "" ? "utf-8 (assumed)" : "utf-8 (fallback)" };
}

export function createWebFetchTool(options: WebFetchOptions = {}) {
  const maxChars = options.maxChars ?? WEB_FETCH_MAX_CHARS;
  const allowedPorts = new Set<number>([...WEB_FETCH_ALLOWED_PORTS, ...(options.allowedPorts ?? [])]);
  const timeoutMs = options.timeoutMs ?? WEB_FETCH_TIMEOUT_MS;
  const lookup = options.lookup ?? defaultLookup;
  const doFetch = options.fetchImpl ?? fetch;

  /** Validate scheme/port/DNS for one URL. Direct-IP hostnames skip DNS (the
   *  literal IS the address — classify it straight). */
  const guardUrl = async (url: URL): Promise<string | undefined> => {
    const structural = validateUrl(url, allowedPorts);
    if (structural !== undefined) return structural;
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(hostname) !== 0) {
      const rule = classifyAddress(hostname);
      return rule !== undefined ? `${hostname} — ${rule}` : undefined;
    }
    return guardHostname(hostname, lookup);
  };

  return buildTool({
    name: "web_fetch",
    promptSnippet: "fetch a URL and read it as text",
    promptGuidelines: [
      "Use after web_search to read a specific result, or when the user gives a URL.",
      "Fails on authenticated/private pages — those need a real credential, not this tool.",
    ],
    description: "Fetch an http(s) URL and return it as markdown (HTML) or raw text (plain/JSON/XML). " +
      "Zero-config, SSRF-guarded: private/loopback/link-local targets are refused, ports 80/443 only, text content-types only, 2MB cap, output shaped to ~16k chars. " +
      "Example: {url: 'https://example.com/docs'} retrieves a doc page for reading. " +
      "Do NOT use web_fetch for local files (read_file) or web search (web_search when configured).",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute http(s) URL to fetch." } },
      required: ["url"],
      additionalProperties: false,
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isOpenWorld: () => true,
    isDestructive: () => false,
    async execute({ url }) {
      // Params validated before ANY effect (fail-closed): a non-string or
      // unparseable URL never reaches the resolver or the network.
      if (typeof url !== "string" || url.trim() === "") {
        return { content: 'web_fetch refused: "url" must be a non-empty string', isError: true };
      }
      let parsed: URL;
      try {
        parsed = new URL(url.trim());
      } catch {
        return { content: `web_fetch refused: "${truncateSafe(url.trim(), 200)}" is not a valid absolute URL`, isError: true }; // 113-A4
      }

      // One end-to-end abort budget: the timer covers EVERY hop (DNS guards,
      // requests, and body reads), not per-request slices.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // Redirect loop — each hop re-validated from scratch (scheme, port,
        // DNS) BEFORE the request is issued; ≤5 hops; relative Locations
        // resolve against the current URL. AUTHORITY stays pinned to the
        // permission-gated host (M59 review fix): a redirect whose hostname
        // differs from the ORIGINAL call's — even www→apex — is refused; the
        // model's follow-up web_fetch on that URL re-enters the permission
        // gate. Without this, a 302 from an approved (or open-redirect-
        // capable) host would land attacker-chosen content ask-free.
        const gatedHost = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
        let current = parsed;
        for (let hop = 0; ; hop++) {
          const refused = await guardUrl(current);
          if (refused !== undefined) {
            return { content: `web_fetch refused: ${refused}`, isError: true };
          }
          let response: Response;
          try {
            response = await doFetch(current.toString(), {
              redirect: "manual",
              signal: controller.signal,
              headers: { "user-agent": "wudao-harness-web-fetch/0.2 (+https://github.com/feiniaojin/wudao-harness)" },
            });
          } catch (err) {
            if (controller.signal.aborted) {
              return { content: `web_fetch failed: timed out after ${timeoutMs / 1000}s`, isError: true };
            }
            return { content: `web_fetch failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
          }
          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            if (location === null) {
              return { content: `web_fetch failed: redirect status ${response.status} without a Location header`, isError: true };
            }
            if (hop >= WEB_FETCH_MAX_REDIRECTS) {
              return { content: `web_fetch refused: more than ${WEB_FETCH_MAX_REDIRECTS} redirects (last hop → ${truncateSafe(location, 200)})`, isError: true }; // 113-A4
            }
            let next: URL;
            try {
              next = new URL(location, current);
            } catch {
              return { content: `web_fetch failed: redirect target "${truncateSafe(location, 200)}" is not a valid URL`, isError: true }; // 113-A4
            }
            // Full network-scope guard on the hop target BEFORE the authority
            // check: a redirect into a refused range reports the RANGE (the
            // more diagnostic fact); a network-clean cross-host redirect
            // reports the authority boundary below.
            const hopRefused = await guardUrl(next);
            if (hopRefused !== undefined) {
              return { content: `web_fetch refused: ${hopRefused}`, isError: true };
            }
            const nextHost = next.hostname.replace(/^\[|\]$/g, "").toLowerCase();
            if (nextHost !== gatedHost) {
              return {
                content: `web_fetch refused: redirect to ${nextHost} requires its own web_fetch call (permissions are per-origin; the original host was ${gatedHost})`,
                isError: true,
              };
            }
            // Free the unconsumed 3xx body before hopping (undici sockets).
            void response.body?.cancel().catch(() => {});
            current = next;
            continue;
          }
          if (!response.ok) {
            return { content: `web_fetch failed: HTTP ${response.status} ${response.statusText}`.trim(), isError: true };
          }

          // Content-type gate — BEFORE the body is buffered.
          const contentTypeHeader = response.headers.get("content-type");
          const mediaType = (contentTypeHeader ?? "").split(";")[0]!.trim().toLowerCase();
          if (contentTypeHeader !== null && !ALLOWED_MEDIA_TYPES.has(mediaType)) {
            return {
              content: `web_fetch refused: content-type "${contentTypeHeader}" is not fetchable text (allowed: ${[...ALLOWED_MEDIA_TYPES].join(", ")}) — this looks binary or unsupported; fetch it another way`,
              isError: true,
            };
          }

          // Body read under the 2MB cap (streamed; over-budget reads stop
          // and are marked, never buffered whole). The end-to-end abort
          // budget covers the read too: a mid-body timeout surfaces as the
          // timeout error, not a raw AbortError.
          const reader = response.body?.getReader();
          const chunks: Uint8Array[] = [];
          let total = 0;
          let sizeCapped = false;
          if (reader !== undefined) {
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done === true) break;
                total += value.byteLength;
                if (total > WEB_FETCH_MAX_BYTES) {
                  sizeCapped = true;
                  chunks.push(value.subarray(0, Math.max(0, value.byteLength - (total - WEB_FETCH_MAX_BYTES))));
                  try {
                    await reader.cancel();
                  } catch {
                    // best effort — the cap already bit
                  }
                  break;
                }
                chunks.push(value);
              }
            } catch (err) {
              if (controller.signal.aborted) {
                return { content: `web_fetch failed: timed out after ${timeoutMs / 1000}s`, isError: true };
              }
              return { content: `web_fetch failed: body read: ${err instanceof Error ? err.message : String(err)}`, isError: true };
            }
          }
          const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
          let offset = 0;
          for (const c of chunks) {
            bytes.set(c, offset);
            offset += c.byteLength;
          }

          const charsetMatch = /charset=([^;]+)/i.exec(contentTypeHeader ?? "");
          const { text: decoded, charset } = decodeBody(bytes, charsetMatch?.[1]);
          const effective = mediaType === "" ? "text/plain (no content-type)" : mediaType;
          const body = mediaType === "text/html" ? htmlToMarkdown.turndown(decoded).trim() : decoded.trim();

          // M46-style shaping over the converted output, with the full text
          // spilled when a spillDir rides the tool.
          const shaped = shapeWebFetchOutput(body, maxChars);
          let content: string;
          let shapedNote = "";
          if (shaped === undefined) {
            content = body;
          } else {
            const spillPath = options.spillDir !== undefined ? spill(body, options.spillDir) : undefined;
            content = shaped + (spillPath !== undefined ? `\n(full page text: ${spillPath})\n${LONG_OUTPUT_GUIDANCE}` : "");
            shapedNote = `; output shaped to ${maxChars} chars`;
          }
          const receipt = [
            `[web_fetch ok: ${response.status}; ${effective}${mediaType === "text/html" ? " → markdown" : ""}; ` +
              `${total.toLocaleString("en-US")} bytes; charset ${charset}`,
            sizeCapped ? "; body truncated at 2MB" : "",
            shapedNote,
            "]",
          ].join("");
          return { content: `# ${current.toString()}\n${content}\n${receipt}`, provenance: "web" };
        }
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
