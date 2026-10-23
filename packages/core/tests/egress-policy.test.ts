// ω99-46 — egress POLICY tests (pure half; no undici, no sockets).
// Acceptance coverage: §2.1 (zero-config → none), §2.4 (NO_PROXY subdomain
// rule + loopback default bypass), §2.7 (child env overlay), §1.5 (typed
// attribution matcher), plus the settings/env layering rules.
import { describe, expect, it } from "vitest";
import {
  EGRESS_ENV_NAMES,
  ProxyEgressError,
  bypassesNoProxy,
  egressChildEnvOverlay,
  egressProxyScheme,
  findProxyEgressCause,
  isLoopbackHost,
  isNodeEnvProxyUrl,
  proxyFailureOf,
  proxyForUrl,
  proxyHostPort,
  redactProxyUrl,
  resolveEgressPolicy,
} from "../src/net/egress-policy.js";

const routed = (p: ReturnType<typeof resolveEgressPolicy>) => {
  if (p.kind !== "routed") throw new Error(`expected routed policy, got ${p.kind}`);
  return p;
};

describe("resolveEgressPolicy — env layering", () => {
  it("no env, no settings → none, no diagnostics (§2.1)", () => {
    const p = resolveEgressPolicy({});
    expect(p.kind).toBe("none");
    expect(p.diagnostics).toEqual([]);
  });

  it("HTTPS_PROXY only routes https; http stays direct", () => {
    const p = routed(resolveEgressPolicy({ HTTPS_PROXY: "http://127.0.0.1:8080" }));
    expect(p.httpsProxy).toBe("http://127.0.0.1:8080");
    expect(p.httpProxy).toBeUndefined();
  });

  it("HTTP_PROXY only: https falls back to the http proxy (undici precedence)", () => {
    const p = routed(resolveEgressPolicy({ HTTP_PROXY: "http://10.0.0.1:3128" }));
    expect(p.httpProxy).toBe("http://10.0.0.1:3128");
    expect(p.httpsProxy).toBe("http://10.0.0.1:3128");
  });

  it("ALL_PROXY fills ABSENT slots only; own slot wins", () => {
    const p = routed(resolveEgressPolicy({ ALL_PROXY: "socks5://127.0.0.1:1080", HTTP_PROXY: "http://10.0.0.2:3128" }));
    expect(p.httpProxy).toBe("http://10.0.0.2:3128");
    expect(p.httpsProxy).toBe("socks5://127.0.0.1:1080");
  });

  it("socks5:// is a first-class accepted scheme (§1.3)", () => {
    const p = routed(resolveEgressPolicy({ HTTPS_PROXY: "socks5://127.0.0.1:10808" }));
    expect(p.httpsProxy).toBe("socks5://127.0.0.1:10808");
    expect(egressProxyScheme("socks5h://h:1")).toBe("socks5");
  });

  it("a REJECTED slot keeps that scheme direct — no fallback past a refusal", () => {
    const p = resolveEgressPolicy({ HTTPS_PROXY: "socks4://127.0.0.1:1080", HTTP_PROXY: "http://10.0.0.3:3128" });
    // https stays direct even though an http proxy exists; http routes.
    expect(routed(p).httpProxy).toBe("http://10.0.0.3:3128");
    expect(routed(p).httpsProxy).toBeUndefined();
    expect(p.diagnostics.some((d) => d.origin === "HTTPS_PROXY" && d.kind === "unsupported")).toBe(true);
  });

  it("an unparseable value is diagnosed invalid and stays direct", () => {
    const p = resolveEgressPolicy({ HTTPS_PROXY: "::not a url::" });
    expect(p.kind).toBe("none");
    expect(p.diagnostics.some((d) => d.kind === "invalid" && d.origin === "HTTPS_PROXY")).toBe(true);
  });

  it("lowercase wins over uppercase; blank counts as unset", () => {
    const p = routed(resolveEgressPolicy({ https_proxy: "http://a:1", HTTPS_PROXY: "http://b:2", HTTP_PROXY: "  " }));
    expect(p.httpsProxy).toBe("http://a:1");
    expect(p.httpProxy).toBeUndefined();
  });

  it("NO_PROXY merges the loopback entries into the bypass list", () => {
    const p = routed(resolveEgressPolicy({ HTTPS_PROXY: "http://a:1", NO_PROXY: "example.com" }));
    expect(p.noProxy).toBe("example.com,localhost,127.0.0.1,::1,[::1]");
    expect(EGRESS_ENV_NAMES).toContain("ALL_PROXY");
  });

  it("NO_PROXY `*` bypasses everything (kept as-is)", () => {
    const p = routed(resolveEgressPolicy({ HTTPS_PROXY: "http://a:1", NO_PROXY: "*" }));
    expect(p.noProxy).toBe("*");
  });
});

describe("resolveEgressPolicy — settings layering", () => {
  it("network.proxy replaces BOTH env-derived scheme defaults", () => {
    const p = routed(resolveEgressPolicy({ HTTPS_PROXY: "http://env:1" }, { proxy: "socks5://127.0.0.1:10808" }));
    expect(p.httpProxy).toBe("socks5://127.0.0.1:10808");
    expect(p.httpsProxy).toBe("socks5://127.0.0.1:10808");
  });

  it("an invalid network.proxy is diagnosed and the env defaults stand", () => {
    const p = routed(resolveEgressPolicy({ HTTPS_PROXY: "http://env:1" }, { proxy: "gopher://x" }));
    expect(p.httpsProxy).toBe("http://env:1");
    expect(p.diagnostics.some((d) => d.origin === "network.proxy")).toBe(true);
  });

  it("proxyRoutes normalize origin keys (explicit default port drops) and pin origins", () => {
    const p = routed(resolveEgressPolicy({}, { proxyRoutes: { "https://api.openai.com:443": "http://p1:1" } }));
    expect(p.routes.get("https://api.openai.com")).toBe("http://p1:1");
  });

  it("an invalid route key or value is diagnosed and dropped, never fatal", () => {
    const p = routed(resolveEgressPolicy(
      { HTTPS_PROXY: "http://env:1" },
      { proxyRoutes: { "api.openai.com": "http://p:1", "https://ok.test": "ftp://bad:1", "https://num.test": 5 as unknown as string } },
    ));
    expect(p.routes.size).toBe(0);
    expect(p.diagnostics.filter((d) => d.origin.startsWith("network.proxyRoutes")).length).toBe(3);
  });

  it("routes alone (no scheme default) still route the pinned origins", () => {
    const p = resolveEgressPolicy({}, { proxyRoutes: { "http://only.test": "http://p:1" } });
    expect(p.kind).toBe("routed");
  });
});

describe("proxyForUrl — routing + bypass (§2.4)", () => {
  const policy = routed(resolveEgressPolicy(
    { HTTP_PROXY: "http://proxy.test:8080", NO_PROXY: "api.deepseek.com" },
  ));
  const go = (url: string): string | undefined => proxyForUrl(policy, new URL(url));

  it("NO_PROXY entry bypasses the host AND every subdomain; others go via the proxy", () => {
    expect(go("http://api.deepseek.com/x")).toBeUndefined();
    expect(go("http://sub.api.deepseek.com/y")).toBeUndefined();
    expect(go("http://other.test/z")).toBe("http://proxy.test:8080");
  });

  it("loopback is bypassed by default even with no NO_PROXY entry", () => {
    expect(go("http://127.0.0.1:9/x")).toBeUndefined();
    expect(go("http://localhost:9/x")).toBeUndefined();
    expect(go("http://127.8.8.8/x")).toBeUndefined(); // whole 127/8
  });

  it("https URLs use the https slot (which fell back to the http proxy here)", () => {
    expect(go("https://other.test/")).toBe("http://proxy.test:8080");
  });

  it("an origin-exact pin wins FIRST and deliberately ignores NO_PROXY + loopback", () => {
    const pinned = routed(resolveEgressPolicy(
      { HTTP_PROXY: "http://default-proxy.test:8080", NO_PROXY: "pinned.test" },
      { proxyRoutes: { "http://pinned.test:8081": "socks5://127.0.0.1:1080", "http://127.0.0.1:99": "http://p:1" } },
    ));
    expect(proxyForUrl(pinned, new URL("http://pinned.test:8081/x"))).toBe("socks5://127.0.0.1:1080");
    expect(proxyForUrl(pinned, new URL("http://127.0.0.1:99/x"))).toBe("http://p:1");
    // non-pinned origins keep the default+NO_PROXY rules
    expect(proxyForUrl(pinned, new URL("http://pinned.test/other"))).toBeUndefined();
  });
});

describe("bypassesNoProxy + isLoopbackHost — pi subdomain rule", () => {
  const bypass = (noProxy: string, url: string): boolean => bypassesNoProxy(noProxy, new URL(url));

  it("entry matches host + subdomains; leading dot and `*.` are equivalent forms", () => {
    expect(bypass("example.com", "http://example.com/")).toBe(true);
    expect(bypass("example.com", "http://a.b.example.com/")).toBe(true);
    expect(bypass(".example.com", "http://x.example.com/")).toBe(true);
    expect(bypass("*.example.com", "http://x.example.com/")).toBe(true);
    expect(bypass("example.com", "http://notexample.com/")).toBe(false);
  });

  it("port-bearing entries match only that port; `*` bypasses everything", () => {
    expect(bypass("example.com:8080", "http://example.com:8080/")).toBe(true);
    expect(bypass("example.com:8080", "http://example.com/")).toBe(false);
    expect(bypass("*", "https://anything.anywhere/")).toBe(true);
  });

  it("isLoopbackHost covers localhost, 127/8, ::1, mapped v6 — and rejects others", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("x.localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.0.0.2")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackHost("8.8.8.8")).toBe(false);
    expect(isLoopbackHost("127.999.1.1")).toBe(false);
    expect(isLoopbackHost("169.254.1.1")).toBe(false);
  });
});

describe("egressChildEnvOverlay — the scrubChildEnv proxy half (§2.7)", () => {
  it("no active policy → empty overlay (env passes through untouched)", () => {
    expect(egressChildEnvOverlay({ kind: "none", diagnostics: [] }, { HTTPS_PROXY: "http://x:1" })).toEqual({});
  });

  it("settings-sourced http proxy publishes names + NODE_USE_ENV_PROXY=1", () => {
    const p = routed(resolveEgressPolicy({}, { proxy: "http://p.test:8080" }));
    const overlay = egressChildEnvOverlay(p, {});
    expect(overlay["HTTPS_PROXY"]).toBe("http://p.test:8080");
    expect(overlay["https_proxy"]).toBe("http://p.test:8080");
    expect(overlay["HTTP_PROXY"]).toBe("http://p.test:8080");
    expect(overlay["NODE_USE_ENV_PROXY"]).toBe("1");
    expect(overlay["NO_PROXY"]).toContain("localhost");
  });

  it("user-exported names keep the user's value verbatim", () => {
    const p = routed(resolveEgressPolicy({ https_proxy: "http://user-proxy:1" }));
    const overlay = egressChildEnvOverlay(p, { https_proxy: "http://user-proxy:1" });
    expect(overlay["https_proxy"]).toBe("http://user-proxy:1");
    expect(overlay["NODE_USE_ENV_PROXY"]).toBe("1");
  });

  it("a socks proxy value withholds NODE_USE_ENV_PROXY (Node child would exit 1) — dsh obligation", () => {
    const p = routed(resolveEgressPolicy({}, { proxy: "socks5://127.0.0.1:10808" }));
    const overlay = egressChildEnvOverlay(p, {});
    expect(overlay["HTTPS_PROXY"]).toBe("socks5://127.0.0.1:10808");
    expect(overlay["NODE_USE_ENV_PROXY"]).toBeUndefined();
    // the value itself stays for curl/git
    expect(isNodeEnvProxyUrl(String(overlay["HTTPS_PROXY"]))).toBe(false);
    expect(isNodeEnvProxyUrl("http://ok:1")).toBe(true);
  });

  it("user-set socks env value also withholds the flag while keeping the value", () => {
    const p = routed(resolveEgressPolicy({ HTTPS_PROXY: "socks5://127.0.0.1:1080" }));
    const overlay = egressChildEnvOverlay(p, { HTTPS_PROXY: "socks5://127.0.0.1:1080" });
    expect(overlay["HTTPS_PROXY"]).toBe("socks5://127.0.0.1:1080");
    expect("NODE_USE_ENV_PROXY" in overlay).toBe(false);
  });
});

describe("proxyFailureOf + ProxyEgressError — attribution (§1.5)", () => {
  it("undici's ProxyConnectionError code → unreachable, naming host:port", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1 8080"), { code: "UND_ERR_PRX_CONN" });
    const wrapped = new TypeError("fetch failed", { cause });
    const e = proxyFailureOf(wrapped, "http://127.0.0.1:8080");
    expect(e).toBeInstanceOf(ProxyEgressError);
    expect(e?.stage).toBe("unreachable");
    expect(e?.message).toContain("127.0.0.1:8080");
    expect(e?.message).toContain("unreachable");
    expect(e?.message).not.toContain("ECONNREFUSED 52525"); // no endpoint blame
  });

  it("CONNECT refusal message → handshake stage", () => {
    const cause = Object.assign(new Error("Proxy response (403) !== 200 when HTTP Tunneling"), { name: "AbortError" });
    const e = proxyFailureOf(new TypeError("fetch failed", { cause }), "http://127.0.0.1:3128");
    expect(e?.stage).toBe("handshake");
    expect(e?.message).toContain("127.0.0.1:3128");
    expect(e?.message).toContain("refused the tunnel");
  });

  it("on ANY proxied route, raw establishment codes attribute to the proxy (its only connection)", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1 10808"), { code: "ECONNREFUSED" });
    const e = proxyFailureOf(new TypeError("fetch failed", { cause }), "socks5://127.0.0.1:10808");
    expect(e?.stage).toBe("unreachable");
    // Same raw code on an http-proxy route: undici 8.10's ProxyAgent surfaces
    // a dead proxy exactly this way (verified) — the client's only TCP
    // connection on a proxied route is the proxy's.
    const httpRoute = proxyFailureOf(new TypeError("fetch failed", { cause }), "http://127.0.0.1:8080");
    expect(httpRoute?.stage).toBe("unreachable");
  });

  it("socks handshake messages attribute as handshake", () => {
    const e = proxyFailureOf(new Error("Socks5 proxy rejected connection - (Connection refused)"), "socks5://h:1080");
    expect(e?.stage).toBe("handshake");
  });

  it("an ordinary target-side error is NOT attributed (no guessing)", () => {
    expect(proxyFailureOf(new Error("certificate has expired"), "http://p:1")).toBeUndefined();
    expect(proxyFailureOf(new Error("HTTP/2 protocol error"), "socks5://p:1")).toBeUndefined();
    expect(proxyFailureOf(undefined, "http://p:1")).toBeUndefined();
  });

  it("credentials are redacted; host:port defaults per scheme; findProxyEgressCause walks the chain", () => {
    const e = new ProxyEgressError("handshake", "http://user:secret@p.test:3128", new Error("x"));
    expect(e.proxy).toBe("http://p.test:3128");
    expect(e.message).not.toContain("secret");
    expect(redactProxyUrl("http://user:secret@p.test:3128")).toBe("http://p.test:3128");
    expect(proxyHostPort("socks5://h")).toBe("h:1080");
    expect(proxyHostPort("https://h")).toBe("h:443");
    expect(findProxyEgressCause(new TypeError("fetch failed", { cause: new Error("wrap", { cause: e }) }))).toBe(e);
    expect(findProxyEgressCause(new Error("plain"))).toBeUndefined();
  });
});
