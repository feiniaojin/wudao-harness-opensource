// M59 §2 — the web_fetch SSRF matrix, content gates, caps, and shaping, with
// mocked DNS + scripted HTTP (zero network, zero listeners). Every refusal
// class must be NAMED in the error (spec: 拒绝即报错,说明命中的规则).
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWebFetchTool,
  classifyAddress,
  domainMatchesAllowlist,
  shapeWebFetchOutput,
  WEB_FETCH_MAX_BYTES,
  type DnsLookup,
} from "../src/tools/web-fetch.js";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** A DNS resolver over a fixed host → addresses table. */
const resolver = (table: Readonly<Record<string, readonly string[]>>): DnsLookup => {
  return async (hostname) => {
    const addresses = table[hostname];
    if (addresses === undefined) throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);
    return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
};

const PUBLIC = resolver({
  "example.com": ["93.184.216.34"],
  "www.example.com": ["93.184.216.36"],
  "docs.example.com": ["93.184.216.35"],
  "mixed.example.com": ["93.184.216.34", "10.0.0.9"], // one bad record among publics
  "rebind.example.com": ["169.254.169.254"],
  "v6.example.com": ["2606:2800:220:1:248:1893:25c8:1946"],
  "mapped.example.com": ["::ffff:127.0.0.1"],
  "ula.example.com": ["fd12:3456:789a:1::1"],
  "fe80.example.com": ["fe80::1"],
  "v6loop.example.com": ["::1"],
});

interface ScriptedResponse {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Bytes instead of text (size-cap tests). */
  readonly bodyBytes?: Uint8Array;
  readonly location?: string;
}

/** Scripted fetch: routes by exact URL, records calls. */
function scriptedFetch(routes: Readonly<Record<string, ScriptedResponse>>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes[url];
    if (route === undefined) return new Response("no route for " + url, { status: 404 });
    const headers = new Headers(route.headers ?? {});
    if (route.location !== undefined) headers.set("location", route.location);
    const body = route.bodyBytes ?? route.body ?? "";
    return new Response(body, { status: route.status ?? 200, headers });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const HTML_PAGE = "<html><head><style>.x{}</style><title>T</title></head><body><h1>Hello Docs</h1><p>Read the <a href='/next'>manual</a>.</p></body></html>";

const okHtml: ScriptedResponse = { headers: { "content-type": "text/html; charset=utf-8" }, body: HTML_PAGE };

describe("classifyAddress (M59 §2 pure IP rules)", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["10.0.0.1", "private network (10"],
    ["172.16.0.1", "private network (172.16"],
    ["172.31.255.1", "private network (172.16"],
    ["169.254.169.254", "link-local / cloud metadata"],
    ["192.168.1.1", "private network (192.168"],
    ["0.0.0.0", "unspecified"],
    ["0.1.2.3", "unspecified"],
    ["::1", "loopback (::1)"],
    ["::", "unspecified"],
    ["fc00::1", "unique local"],
    ["fdff::1", "unique local"],
    ["fe80::1", "IPv6 link-local"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::127.0.0.1", "loopback"],
    ["::ffff:169.254.169.254", "link-local"],
  ])("%s is refused", (ip, fragment) => {
    expect(classifyAddress(ip)).toContain(fragment);
  });

  it.each([
    "93.184.216.34",
    "172.32.0.1",   // just outside 172.16/12
    "172.15.255.1", // just below
    "169.253.1.1",  // just below link-local
    "192.169.1.1",  // not 192.168
    "fe00::1",      // outside fe80::/10
    "2606:2800:220:1:248:1893:25c8:1946",
    "64:ff9b::1.2.3.4", // NAT64 well-known prefix — not in the refusal matrix
    "::ffff:93.184.216.34",
  ])("%s is public", (ip) => {
    expect(classifyAddress(ip)).toBeUndefined();
  });
});

describe("domainMatchesAllowlist (web.allowDomains semantics)", () => {
  const list = ["example.com", "*.github.com"];
  it.each([
    ["example.com", true],
    ["EXAMPLE.COM", true],
    ["api.github.com", true],
    ["github.com", true],          // *.suffix matches the bare suffix too
    ["deep.api.github.com", true],
    ["notexample.com", false],
    ["evil.com", false],
    ["github.com.evil.io", false], // suffix must be at a label boundary
  ])("%s → %s", (host, expected) => {
    expect(domainMatchesAllowlist(host, list)).toBe(expected);
  });
  it("an empty or malformed entry never matches", () => {
    expect(domainMatchesAllowlist("example.com", ["", "  ", "*."])).toBe(false);
  });
});

describe("web_fetch SSRF matrix (mocked DNS)", () => {
  const tool = (overrides?: { allowedPorts?: readonly number[] }) =>
    createWebFetchTool({ lookup: PUBLIC, fetchImpl: scriptedFetch({ "https://example.com/": okHtml }).fetchImpl, ...overrides });

  it.each([
    ["file:///etc/passwd", /scheme "file" is not allowed/],
    ["ftp://example.com/x", /scheme "ftp" is not allowed/],
    ["http://127.0.0.1/x", /loopback/],
    ["http://[::1]/x", /loopback/],
    ["http://10.0.0.5/x", /private network/],
    ["http://172.16.1.5/x", /private network/],
    ["http://192.168.0.10/x", /private network/],
    ["http://169.254.169.254/latest/meta-data/", /link-local \/ cloud metadata/],
    ["http://0.0.0.0/x", /unspecified/],
    ["http://ula.example.com/x", /unique local/],
    ["http://fe80.example.com/x", /IPv6 link-local/],
    ["http://v6loop.example.com/x", /loopback/],
    ["http://mapped.example.com/x", /loopback.*IPv4-mapped/],
    ["http://mixed.example.com/x", /private network/], // ANY bad record refuses
    ["http://rebind.example.com/x", /link-local \/ cloud metadata/], // by NAME, not just literal
    ["http://example.com:8080/x", /port 8080 is not allowed/],
    ["not a url at all", /not a valid absolute URL/],
    ["", /must be a non-empty string/],
    // M59 review pin: the four alternative IPv4 encodings all normalize to
    // 127.0.0.1 INSIDE new URL() and refuse as loopback — if a parser
    // regression ever stopped normalizing, these fail (they'd reach the
    // mocked resolver as unknown hostnames → a different refusal, never a
    // silent pass; the pin catches either drift).
    ["http://2130706433/x", /loopback/],
    ["http://0x7f000001/x", /loopback/],
    ["http://0177.0.0.1/x", /loopback/],
    ["http://127.1/x", /loopback/],
  ])("%s refused with the rule named", async (url, re) => {
    const res = await tool().execute({ url });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(re);
    expect(res.content).toContain("web_fetch refused:");
  });

  it("a public https URL on 443 succeeds and converts HTML to markdown", async () => {
    const res = await tool().execute({ url: "https://example.com/" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("# Hello Docs");
    expect(res.content).toContain("[manual](/next)");
    expect(res.content).toContain("# https://example.com/");
    expect(res.content).toContain("[web_fetch ok: 200; text/html → markdown");
    expect(res.provenance).toBe("web");
  });

  it("configured allowedPorts EXTENDS 80/443 (8080 passes, 443 still passes)", async () => {
    const { fetchImpl } = scriptedFetch({
      "http://example.com:8080/x": okHtml,
      "https://example.com/": okHtml,
    });
    const t = createWebFetchTool({ lookup: PUBLIC, fetchImpl, allowedPorts: [8080] });
    const res = await t.execute({ url: "http://example.com:8080/x" });
    expect(res.isError).toBeFalsy();
    const still = await t.execute({ url: "https://example.com/" });
    expect(still.isError).toBeFalsy();
  });

  it("every redirect hop is re-resolved and re-checked — a public URL 302-ing to the metadata IP is refused", async () => {
    const { fetchImpl } = scriptedFetch({
      "https://example.com/redirect": { status: 302, location: "http://rebind.example.com/meta" },
    });
    const res = await createWebFetchTool({ lookup: PUBLIC, fetchImpl }).execute({ url: "https://example.com/redirect" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("rebind.example.com resolves to 169.254.169.254");
    expect(res.content).toContain("cloud metadata");
  });

  it("a SAME-HOST redirect chain continues and lands on the final URL", async () => {
    const { fetchImpl } = scriptedFetch({
      "https://example.com/hop1": { status: 302, location: "/hop2" }, // relative Location, same host
      "https://example.com/hop2": { status: 301, location: "https://example.com/final" },
      "https://example.com/final": okHtml,
    });
    const res = await createWebFetchTool({ lookup: PUBLIC, fetchImpl }).execute({ url: "https://example.com/hop1" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("# https://example.com/final");
  });

  it("a CROSS-HOST redirect is refused — authority stays pinned to the permission-gated host", async () => {
    const { fetchImpl } = scriptedFetch({
      "https://example.com/open-redirect": { status: 302, location: "https://docs.example.com/attacker-content" },
      "https://docs.example.com/attacker-content": okHtml,
    });
    const res = await createWebFetchTool({ lookup: PUBLIC, fetchImpl }).execute({ url: "https://example.com/open-redirect" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("redirect to docs.example.com requires its own web_fetch call");
    expect(res.content).toContain("the original host was example.com");
  });

  it("www→apex is a cross-host redirect too — only IDENTICAL hostnames continue", async () => {
    const { fetchImpl } = scriptedFetch({
      "https://www.example.com/x": { status: 302, location: "https://example.com/x" },
    });
    const res = await createWebFetchTool({ lookup: PUBLIC, fetchImpl }).execute({ url: "https://www.example.com/x" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("redirect to example.com requires its own web_fetch call");
  });

  it("hostname comparison is case-insensitive — a case-only hop continues", async () => {
    // The URL parser lowercases hostnames, so EXAMPLE.com normalizes to the
    // same authority — this must NOT read as a cross-host redirect.
    const { fetchImpl } = scriptedFetch({
      "https://example.com/case": { status: 302, location: "https://EXAMPLE.com/cased" },
      "https://example.com/cased": okHtml,
    });
    const res = await createWebFetchTool({ lookup: PUBLIC, fetchImpl }).execute({ url: "https://example.com/case" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("# https://example.com/cased");
  });

  it("more than 5 redirects is refused", async () => {
    const routes: Record<string, ScriptedResponse> = {};
    for (let i = 1; i <= 7; i++) routes[`https://example.com/r${i}`] = { status: 302, location: `/r${i + 1}` };
    routes["https://example.com/r8"] = okHtml;
    const res = await createWebFetchTool({ lookup: PUBLIC, fetchImpl: scriptedFetch(routes).fetchImpl }).execute({ url: "https://example.com/r1" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("more than 5 redirects");
  });

  it("a redirect hop to a disallowed PORT is refused even mid-chain", async () => {
    const { fetchImpl } = scriptedFetch({
      "https://example.com/secure": { status: 302, location: "http://example.com:8443/x" },
    });
    const res = await createWebFetchTool({ lookup: PUBLIC, fetchImpl }).execute({ url: "https://example.com/secure" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("port 8443 is not allowed");
  });
});

describe("web_fetch content gates and caps", () => {
  it("binary content-types are refused with a clear hint", async () => {
    const { fetchImpl } = scriptedFetch({
      "https://example.com/img.png": { headers: { "content-type": "image/png" }, bodyBytes: new Uint8Array([0x89, 0x50]) },
    });
    const res = await createWebFetchTool({ lookup: PUBLIC, fetchImpl }).execute({ url: "https://example.com/img.png" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('content-type "image/png" is not fetchable text');
    expect(res.content).toContain("binary");
  });

  it("application/json passes through raw (no markdown conversion)", async () => {
    const { fetchImpl } = scriptedFetch({
      "https://example.com/data.json": { headers: { "content-type": "application/json" }, body: `{"a":1,"html":"<b>x</b>"}` },
    });
    const res = await createWebFetchTool({ lookup: PUBLIC, fetchImpl }).execute({ url: "https://example.com/data.json" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('{"a":1,"html":"<b>x</b>"}');
    expect(res.content).toContain("application/json");
  });

  it("an absent content-type is fetched as text (browsers' precedent)", async () => {
    // Byte bodies: the Response constructor auto-stamps text/plain on STRING
    // bodies, so only bytes can simulate a header-less origin.
    const { fetchImpl } = scriptedFetch({ "https://example.com/bare": { bodyBytes: new TextEncoder().encode("plain bytes") } });
    const res = await createWebFetchTool({ lookup: PUBLIC, fetchImpl }).execute({ url: "https://example.com/bare" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("plain bytes");
    expect(res.content).toContain("text/plain (no content-type)");
  });

  it("the 2MB size cap truncates and says so", async () => {
    const big = new Uint8Array(WEB_FETCH_MAX_BYTES + 100_000).fill(0x61); // 'a'
    const { fetchImpl } = scriptedFetch({
      "https://example.com/big": { headers: { "content-type": "text/plain" }, bodyBytes: big },
    });
    const res = await createWebFetchTool({ lookup: PUBLIC, fetchImpl, maxChars: 10_000_000 }).execute({ url: "https://example.com/big" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("body truncated at 2MB");
    expect(res.content.length).toBeLessThan(WEB_FETCH_MAX_BYTES + 10_000);
  });

  it("invalid UTF-8 decodes with replacement characters, not a crash", async () => {
    const bad = new Uint8Array([0x61, 0xff, 0xfe, 0x62]);
    const { fetchImpl } = scriptedFetch({
      "https://example.com/broken": { headers: { "content-type": "text/plain; charset=utf-8" }, bodyBytes: bad },
    });
    const res = await createWebFetchTool({ lookup: PUBLIC, fetchImpl }).execute({ url: "https://example.com/broken" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("a");
    expect(res.content).toContain("�");
  });

  it("an unknown charset label falls back to UTF-8 replacement", async () => {
    const { fetchImpl } = scriptedFetch({
      "https://example.com/cs": { headers: { "content-type": "text/plain; charset=not-a-real-charset" }, body: "hello" },
    });
    const res = await createWebFetchTool({ lookup: PUBLIC, fetchImpl }).execute({ url: "https://example.com/cs" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("charset utf-8 (fallback)");
  });

  it("HTTP error statuses surface as failures", async () => {
    const { fetchImpl } = scriptedFetch({ "https://example.com/404": { status: 404, body: "nope" } });
    const res = await createWebFetchTool({ lookup: PUBLIC, fetchImpl }).execute({ url: "https://example.com/404" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("HTTP 404");
  });

  it("an unresolvable host fails with the DNS error", async () => {
    const res = await createWebFetchTool({ lookup: PUBLIC, fetchImpl: scriptedFetch({}).fetchImpl }).execute({ url: "https://nope.example.com/" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("DNS lookup failed");
  });

  it("the end-to-end abort budget times out a hung fetch and says so", async () => {
    // The mock honors the abort signal exactly like real fetch (rejects on
    // abort) — otherwise nothing would ever cut the hang short.
    const hung: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
      });
    const res = await createWebFetchTool({ lookup: PUBLIC, fetchImpl: hung, timeoutMs: 60 }).execute({ url: "https://example.com/slow" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("timed out after");
  });
});

describe("web_fetch output shaping (M46 head/tail discipline)", () => {
  it("under-budget output passes through unshaped", () => {
    expect(shapeWebFetchOutput("short", 100)).toBeUndefined();
  });

  it("over-budget output keeps head + marker + tail at 60/40", () => {
    const raw = "A".repeat(600) + "B".repeat(600) + "C".repeat(600);
    const shaped = shapeWebFetchOutput(raw, 1_000)!;
    expect(shaped).toContain("omitted 800 chars");
    expect(shaped.startsWith("A".repeat(600))).toBe(true);
    expect(shaped.endsWith("C".repeat(400))).toBe(true);
  });

  it("a long fetch is shaped to maxChars with the full text spilled for read_file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "webfetch-spill-"));
    try {
      const body = Array.from({ length: 900 }, (_, i) => `line-${i} ${"x".repeat(30)}`).join("\n");
      const { fetchImpl } = scriptedFetch({ "https://example.com/long": { headers: { "content-type": "text/plain" }, body } });
      const res = await createWebFetchTool({ lookup: PUBLIC, fetchImpl, maxChars: 4_000, spillDir: dir }).execute({ url: "https://example.com/long" });
      expect(res.isError).toBeFalsy();
      expect(res.content).toContain("omitted");
      expect(res.content).toContain("web.fetch.maxChars=4000");
      expect(res.content).toMatch(/full page text: .+\.txt/);
      const spilled = await readFile((res.content.match(/full page text: (.+\.txt)/) ?? [])[1] ?? "", "utf8");
      expect(spilled).toBe(body);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("web_fetch turndown determinism", () => {
  it("the same fixture HTML converts byte-identically twice", async () => {
    const { fetchImpl } = scriptedFetch({ "https://example.com/page": okHtml });
    const t = createWebFetchTool({ lookup: PUBLIC, fetchImpl });
    const a = await t.execute({ url: "https://example.com/page" });
    const b = await t.execute({ url: "https://example.com/page" });
    expect(a.content).toBe(b.content);
    // script/style content never survives the conversion.
    expect(a.content).not.toContain("bad()");
    expect(a.content).not.toContain(".x{");
  });
});
