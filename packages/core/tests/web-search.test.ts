// M59 §1 — web_search: both provider shapes, header contract, count cap,
// output truncation, and query validation — scripted HTTP, zero network.
import { describe, expect, it, afterEach } from "vitest";
import {
  createWebSearchTool,
  parseSearchHits,
  formatSearchResults,
  capSearchOutput,
  WEB_SEARCH_MAX_QUERY_CHARS,
} from "../src/tools/web-search.js";

/** Scripted search fetch: one responder + a call log. */
function searchFetch(status: number, body: string) {
  const calls: { url: string; headers?: Record<string, string> }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url: String(input), headers });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const SEARXNG_BODY = JSON.stringify({
  results: [
    { title: "Node dns docs", url: "https://nodejs.org/dns", content: "lookup() with all:true\nreturns every address" },
    { title: "Second hit", url: "https://second.example/x", content: "  spaced   snippet  " },
    { title: "", url: "https://dropped.example/no-title", content: "dropped: no title" },
    { title: "No snippet", url: "https://third.example/y" },
  ],
});

const BRAVE_BODY = JSON.stringify({
  web: {
    results: [
      { title: "Brave hit one", url: "https://brave.one/a", description: "first description" },
      { title: "Brave hit two", url: "https://brave.two/b", description: "second description" },
    ],
  },
});

describe("parseSearchHits (both provider shapes)", () => {
  it("searxng: results[] title/url/content", () => {
    const hits = parseSearchHits("searxng", JSON.parse(SEARXNG_BODY));
    expect(hits.map((h) => h.title)).toEqual(["Node dns docs", "Second hit", "No snippet"]);
    expect(hits[0]).toEqual({ title: "Node dns docs", url: "https://nodejs.org/dns", snippet: "lookup() with all:true returns every address" });
  });

  it("brave: web.results[] title/url/description", () => {
    const hits = parseSearchHits("brave", JSON.parse(BRAVE_BODY));
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({ title: "Brave hit one", url: "https://brave.one/a", snippet: "first description" });
  });

  it("non-object payloads drop to empty, never throw", () => {
    expect(parseSearchHits("searxng", null)).toEqual([]);
    expect(parseSearchHits("searxng", "string")).toEqual([]);
    expect(parseSearchHits("brave", {})).toEqual([]);
    expect(parseSearchHits("searxng", { results: "nope" })).toEqual([]);
  });
});

describe("formatSearchResults + capSearchOutput (spec §1 shaping)", () => {
  it("renders the numbered list with the snippet on its own indented line", () => {
    const text = formatSearchResults([
      { title: "T1", url: "https://a", snippet: "s1" },
      { title: "T2", url: "https://b", snippet: "" },
    ]);
    expect(text).toBe("1. T1 — https://a\n   s1\n2. T2 — https://b");
  });

  it("caps at 4000 chars on a line boundary with an honest marker", () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ title: `t${i}`, url: `https://x/${i}`, snippet: "y".repeat(40) }));
    const text = formatSearchResults(many);
    expect(text.length).toBeGreaterThan(4_000);
    const capped = capSearchOutput(text);
    expect(capped.length).toBeLessThanOrEqual(4_100);
    expect(capped).toContain("[web_search: output truncated at 4000 chars]");
    // The cut landed on a line boundary: the kept text (minus the marker) is
    // a prefix of the original whose next original char is the newline.
    const marker = "\n… [web_search: output truncated at 4000 chars]";
    const kept = capped.slice(0, capped.length - marker.length);
    expect(text.startsWith(kept)).toBe(true);
    expect(text.charAt(kept.length)).toBe("\n");
  });
});

describe("createWebSearchTool", () => {
  afterEach(() => { delete process.env["TEST_BRAVE_KEY"]; });

  it("an endpoint aimed at the metadata IP (or any refused range) never issues the GET", async () => {
    const { fetchImpl, calls } = searchFetch(200, SEARXNG_BODY);
    const tool = createWebSearchTool({ provider: "searxng", endpoint: "http://169.254.169.254/", fetchImpl });
    const res = await tool.execute({ query: "q" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("169.254.169.254");
    expect(res.content).toContain("link-local / cloud metadata");
    expect(calls).toHaveLength(0); // zero effects — the GET never fires
  });

  it("a private or loopback endpoint is likewise refused at construction time", async () => {
    for (const endpoint of ["http://10.0.0.5:8888/", "http://127.0.0.1:8888/", "http://[::1]:8888/"]) {
      const res = await createWebSearchTool({ provider: "searxng", endpoint, fetchImpl: searchFetch(200, SEARXNG_BODY).fetchImpl }).execute({ query: "q" });
      expect(res.isError, endpoint).toBe(true);
      expect(res.content, endpoint).toContain("web_search failed:");
    }
  });

  it("a non-http(s) endpoint scheme is a config error, and a hostname endpoint defers to the loader's DNS seam", async () => {
    const badScheme = await createWebSearchTool({ provider: "searxng", endpoint: "ftp://searx.local/", fetchImpl: searchFetch(200, SEARXNG_BODY).fetchImpl }).execute({ query: "q" });
    expect(badScheme.isError).toBe(true);
    expect(badScheme.content).toContain("must be http(s)");
    // A HOSTNAME endpoint passes the construction guard (the settings loader
    // resolves it — see the web-config tests); calls proceed normally.
    const ok = await createWebSearchTool({ provider: "searxng", endpoint: "http://searx.public/", fetchImpl: searchFetch(200, SEARXNG_BODY).fetchImpl }).execute({ query: "q" });
    expect(ok.isError).toBeFalsy();
  });

  it("searxng hits GET {endpoint}/search?q=…&format=json and shapes results", async () => {
    const { fetchImpl, calls } = searchFetch(200, SEARXNG_BODY);
    const tool = createWebSearchTool({ provider: "searxng", endpoint: "http://searx.local/", fetchImpl });
    const res = await tool.execute({ query: "dns lookup all" });
    expect(res.isError).toBeFalsy();
    expect(calls[0]?.url).toBe("http://searx.local/search?q=dns%20lookup%20all&format=json");
    expect(res.content).toContain("web_search: 3 results");
    expect(res.content).toContain("1. Node dns docs — https://nodejs.org/dns");
    expect(res.content).toContain("   lookup() with all:true returns every address");
    expect(res.provenance).toBe("web");
  });

  it("brave sends X-Subscription-Token from the apiKeyEnv VARIABLE (value never in config)", async () => {
    process.env["TEST_BRAVE_KEY"] = "sekrit-token";
    const { fetchImpl, calls } = searchFetch(200, BRAVE_BODY);
    const tool = createWebSearchTool({ provider: "brave", apiKeyEnv: "TEST_BRAVE_KEY", fetchImpl });
    const res = await tool.execute({ query: "brave test" });
    expect(res.isError).toBeFalsy();
    expect(calls[0]?.url).toBe("https://api.search.brave.com/res/v1/web/search?q=brave%20test&count=8");
    expect(calls[0]?.headers?.["x-subscription-token"]).toBe("sekrit-token");
    expect(res.content).toContain("1. Brave hit one — https://brave.one/a");
  });

  it("brave with an unset env var fails naming the variable", async () => {
    const tool = createWebSearchTool({ provider: "brave", apiKeyEnv: "TEST_BRAVE_KEY", fetchImpl: searchFetch(200, BRAVE_BODY).fetchImpl });
    const res = await tool.execute({ query: "x" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("TEST_BRAVE_KEY");
    expect(res.content).toContain("is not set");
  });

  it("brave without apiKeyEnv in the config fails at construction-use time", async () => {
    const tool = createWebSearchTool({ provider: "brave", fetchImpl: searchFetch(200, BRAVE_BODY).fetchImpl });
    const res = await tool.execute({ query: "x" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("apiKeyEnv");
  });

  it("count caps the returned entries", async () => {
    const { fetchImpl } = searchFetch(200, SEARXNG_BODY);
    const tool = createWebSearchTool({ provider: "searxng", endpoint: "http://s/", count: 2, fetchImpl });
    const res = await tool.execute({ query: "q" });
    expect(res.content).toContain("web_search: 2 results");
    expect(res.content).not.toContain("No snippet");
  });

  it("empty result sets say so plainly", async () => {
    const { fetchImpl } = searchFetch(200, JSON.stringify({ results: [] }));
    const tool = createWebSearchTool({ provider: "searxng", endpoint: "http://s/", fetchImpl });
    const res = await tool.execute({ query: "nothing" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('no results for "nothing"');
  });

  it.each([
    ["", /must be a non-empty string/],
    ["x".repeat(WEB_SEARCH_MAX_QUERY_CHARS + 1), new RegExp(`query is ${WEB_SEARCH_MAX_QUERY_CHARS + 1} chars`)],
  ])("query validation refuses %s", async (query, re) => {
    const tool = createWebSearchTool({ provider: "searxng", endpoint: "http://s/", fetchImpl: searchFetch(200, SEARXNG_BODY).fetchImpl });
    const res = await tool.execute({ query });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(re);
  });

  it("provider HTTP failures surface with the status", async () => {
    const { fetchImpl } = searchFetch(503, "{}");
    const tool = createWebSearchTool({ provider: "searxng", endpoint: "http://s/", fetchImpl });
    const res = await tool.execute({ query: "q" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("HTTP 503");
  });

  it("non-JSON provider responses fail cleanly", async () => {
    const { fetchImpl } = searchFetch(200, "<html>not json</html>");
    const tool = createWebSearchTool({ provider: "searxng", endpoint: "http://s/", fetchImpl });
    const res = await tool.execute({ query: "q" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("not JSON");
  });

  it("carries the open-world/read-only risk annotations", () => {
    const tool = createWebSearchTool({ provider: "searxng", endpoint: "http://s/" });
    expect(tool.isReadOnly?.({})).toBe(true);
    expect(tool.isConcurrencySafe?.({})).toBe(true);
    expect(tool.isOpenWorld?.({})).toBe(true);
    expect(tool.isDestructive?.({})).toBe(false);
  });
});
