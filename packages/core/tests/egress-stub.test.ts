// ω99-46 — egress install × REAL undici × local stub proxies (brief §1.6/§2).
// These tests swap the process-global dispatcher (that is the mechanism under
// test) and restore it in afterEach; every request goes to 127.0.0.1 stubs or
// fails deterministically against the reserved `.test` TLD — no real network.
import { afterEach, describe, expect, it } from "vitest";
import { installEgressProxy } from "../src/net/egress.js";
import { findProxyEgressCause, resolveEgressPolicy, type EgressSettingsInput } from "../src/net/egress-policy.js";
import { ProxyEgressError } from "../src/net/egress-policy.js";
import { startHttpProxyStub, startSocksProxyStub } from "./helpers/egress-stub.js";

const cleanEnv: Record<string, string | undefined> = {};
  // (vitest workers may carry proxy vars from the shell — scrub them so the
  // routed policies below are exactly what the test constructs)
for (const name of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"]) {
  delete cleanEnv[name];
}

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposers.length > 0) await disposers.pop!()?.();
});

async function withPolicy(env: Record<string, string | undefined>, settings?: EgressSettingsInput): Promise<void> {
  const r = await installEgressProxy(resolveEgressPolicy({ ...cleanEnv, ...env }, settings));
  disposers.push(r.dispose);
}

describe("routing through a local HTTP proxy stub (§2.2)", () => {
  it("an http target's fetch goes through the proxy as an ABSOLUTE-URI request and parses the reply", async () => {
    const stub = await startHttpProxyStub();
    await withPolicy({ HTTP_PROXY: `http://127.0.0.1:${stub.port}` });
    const res = await fetch("http://example.test/some/path");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("STUB-PROXY-OK");
    expect(stub.requests).toEqual(["GET http://example.test/some/path"]);
    await stub.close();
  });

  it("an https target's fetch reaches the proxy as CONNECT host:443 (§2.2 CONNECT arm)", async () => {
    const stub = await startHttpProxyStub({ connectStatus: 200 });
    await withPolicy({ HTTPS_PROXY: `http://127.0.0.1:${stub.port}` });
    // The stub establishes the tunnel; the client's TLS to example.test then
    // fails (no such host) — but the CONNECT receipt is the routing fact.
    await expect(fetch("https://example.test/doc")).rejects.toThrow();
    expect(stub.requests).toEqual(["CONNECT example.test:443"]);
    await stub.close();
  });

  it("zero configuration stays direct (§2.1): a .test URL fails DNS, no proxy consulted", async () => {
    const stub = await startHttpProxyStub();
    await withPolicy({});
    await expect(fetch("http://example.test/x")).rejects.toThrow();
    expect(stub.requests).toEqual([]);
    await stub.close();
  });
});

describe("NO_PROXY subdomain rule + loopback default bypass (§2.4)", () => {
  it("NO_PROXY=<domain> bypasses the domain and every subdomain; others route via the stub", async () => {
    const stub = await startHttpProxyStub();
    await withPolicy({ HTTP_PROXY: `http://127.0.0.1:${stub.port}`, NO_PROXY: "bypassed.test" });
    // Direct (bypassed): deterministic ENOTFOUND for the reserved `.test`
    // TLD (the acceptance's api.deepseek.com spelling is pinned in the pure
    // proxyForUrl tests — here the domain must NOT real-DNS resolve).
    await expect(fetch("http://bypassed.test/x")).rejects.toThrow();
    await expect(fetch("http://sub.bypassed.test/y")).rejects.toThrow();
    // Proxied:
    const res = await fetch("http://other.test/z");
    expect(await res.text()).toContain("STUB-PROXY-OK");
    expect(stub.requests).toEqual(["GET http://other.test/z"]);
    await stub.close();
  });

  it("loopback targets bypass the proxy by default", async () => {
    const stub = await startHttpProxyStub();
    await withPolicy({ HTTP_PROXY: `http://127.0.0.1:${stub.port}` });
    await expect(fetch("http://127.0.0.1:9/x")).rejects.toThrow(); // direct ECONNREFUSED
    await expect(fetch("http://localhost:9/x")).rejects.toThrow();
    expect(stub.requests).toEqual([]);
    await stub.close();
  });
});

describe("per-origin routes + atomic whole-table swap (§2.3)", () => {
  it("two origins each hit their own stub", async () => {
    const stubA = await startHttpProxyStub();
    const stubB = await startHttpProxyStub();
    stubA.responseBody = "VIA-A";
    stubB.responseBody = "VIA-B";
    await withPolicy({}, {
      proxyRoutes: { "http://a.test": `http://127.0.0.1:${stubA.port}`, "http://b.test": `http://127.0.0.1:${stubB.port}` },
    });
    expect(await (await fetch("http://a.test/1")).text()).toContain("VIA-A");
    expect(await (await fetch("http://b.test/2")).text()).toContain("VIA-B");
    expect(stubA.requests).toEqual(["GET http://a.test/1"]);
    expect(stubB.requests).toEqual(["GET http://b.test/2"]);
    await stubA.close();
    await stubB.close();
  });

  it("re-installing swaps the table: new requests route per the NEW table immediately, old stub gets nothing more", async () => {
    const oldStub = await startHttpProxyStub();
    const newStub = await startHttpProxyStub();
    oldStub.responseBody = "OLD";
    newStub.responseBody = "NEW";
    await withPolicy({}, { proxyRoutes: { "http://swap.test": `http://127.0.0.1:${oldStub.port}` } });
    expect(await (await fetch("http://swap.test/x")).text()).toContain("OLD");
    expect(oldStub.requests.length).toBe(1);
    // The whole-table swap: a fresh install replaces the routing in ONE call.
    await withPolicy({}, { proxyRoutes: { "http://swap.test": `http://127.0.0.1:${newStub.port}` } });
    expect(await (await fetch("http://swap.test/y")).text()).toContain("NEW");
    expect(await (await fetch("http://swap.test/z")).text()).toContain("NEW");
    // No residual old-table flow: exactly the one pre-swap request landed there.
    expect(oldStub.requests).toEqual(["GET http://swap.test/x"]);
    expect(newStub.requests).toEqual(["GET http://swap.test/y", "GET http://swap.test/z"]);
    await oldStub.close();
    await newStub.close();
  });
});

describe("SOCKS5 first-class (§2.5)", () => {
  it("a socks5:// proxy routes the fetch; the stub sees the tunneled HTTP request", async () => {
    const stub = await startSocksProxyStub();
    await withPolicy({ HTTP_PROXY: `socks5://127.0.0.1:${stub.port}` });
    const res = await fetch("http://example.test/via/socks");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("SOCKS-STUB-OK");
    expect(stub.targets).toEqual(["example.test:80"]);
    expect(stub.httpHeads.length).toBe(1);
    expect(stub.httpHeads[0]).toContain("GET /via/socks HTTP/1.1");
    expect(stub.httpHeads[0]).toContain("host: example.test");
    await stub.close();
  });

  it("socks5h:// is accepted as the same route", async () => {
    const stub = await startSocksProxyStub();
    await withPolicy({ HTTPS_PROXY: `socks5h://127.0.0.1:${stub.port}` });
    // https over socks: TLS to example.test fails after the socks handshake —
    // the CONNECT-by-name receipt is the routing fact under assertion.
    await expect(fetch("https://example.test/tls")).rejects.toThrow();
    expect(stub.targets).toEqual(["example.test:443"]);
    await stub.close();
  });

  it("a refused socks reply attributes the failure to the proxy host:port (§2.6 socks arm)", async () => {
    const stub = await startSocksProxyStub();
    stub.refuseReply = true;
    await withPolicy({ HTTP_PROXY: `socks5://127.0.0.1:${stub.port}` });
    const err = await fetch("http://example.test/x").then(
      () => undefined,
      (e: unknown) => e,
    );
    const attributed = findProxyEgressCause(err);
    expect(attributed).toBeInstanceOf(ProxyEgressError);
    expect(attributed?.stage).toBe("handshake");
    expect(attributed?.message).toContain(`127.0.0.1:${stub.port}`);
    await stub.close();
  });
});

describe("proxy failure attribution through an HTTP proxy (§2.6)", () => {
  it("a CONNECT refusal names the proxy host:port and stage — never the endpoint", async () => {
    const stub = await startHttpProxyStub({ connectStatus: 403 });
    await withPolicy({ HTTPS_PROXY: `http://127.0.0.1:${stub.port}` });
    const err = await fetch("https://example.test/doc").then(
      () => undefined,
      (e: unknown) => e,
    );
    const attributed = findProxyEgressCause(err);
    expect(attributed).toBeInstanceOf(ProxyEgressError);
    expect(attributed?.stage).toBe("handshake");
    expect(attributed?.message).toContain(`127.0.0.1:${stub.port}`);
    expect(attributed?.message).toContain("refused the tunnel");
    // The attribution names the PROXY as the failure point; the endpoint is
    // not blamed for the proxy's refusal.
    expect(attributed?.message).not.toMatch(/example\.test (is|was) (unreachable|down|refusing)/i);
    await stub.close();
  });

  it("a dead proxy (connection refused) attributes as unreachable with host:port", async () => {
    const stub = await startHttpProxyStub();
    const port = stub.port;
    await stub.close(); // port now closed — deterministic ECONNREFUSED
    await withPolicy({ HTTPS_PROXY: `http://127.0.0.1:${port}` });
    const err = await fetch("https://example.test/doc").then(
      () => undefined,
      (e: unknown) => e,
    );
    const attributed = findProxyEgressCause(err);
    expect(attributed).toBeInstanceOf(ProxyEgressError);
    expect(attributed?.stage).toBe("unreachable");
    expect(attributed?.message).toContain(`127.0.0.1:${port}`);
  });
});

describe("web_fetch rides the global dispatcher — its own logic untouched (§3 red line)", () => {
  it("web_fetch with its DEFAULT fetch goes through the proxy once its guard passes", async () => {
    const { createWebFetchTool } = await import("../src/tools/web-fetch.js");
    const stub = await startHttpProxyStub();
    await withPolicy({ HTTP_PROXY: `http://127.0.0.1:${stub.port}` });
    // The SSRF guard resolves DNS itself (that does NOT change under a
    // proxy — the documented T0-3 boundary); the lookup seam feeds a public
    // address so the guard passes and the request reaches the dispatcher.
    const tool = createWebFetchTool({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    const result = await tool.execute({ url: "http://example.test/page" });
    expect(result.isError).not.toBe(true);
    expect(String(result.content)).toContain("STUB-PROXY-OK");
    expect(stub.requests).toEqual(["GET http://example.test/page"]);
    await stub.close();
  });
});
