// M59 — the cli web surface: the settings loader (two-tier merge, tolerance),
// the permission layer's web lanes (allowDomains pre-approval, domain-scoped
// session rules, the ask prompt's domain), the tool registry (fetch always,
// search only when configured), and the /doctor web checks.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput, PermissionDecision, Tool } from "@wudao-org/core";
import { loadWebSettings, webSearchConfig, DEFAULT_WEB_SETTINGS } from "../src/web-config.js";
import { buildToolSet } from "../src/tools.js";
import { decideRichPermission, ruleMatches, askRuleFor, applyAskAnswer, EMPTY_PERMISSION_SETTINGS } from "../src/permission.js";
import { summarizeToolCall } from "../src/log.js";
import { checkWebFetch, checkWebSearch, formatDoctorReport, type DoctorInput } from "../src/commands/doctor.js";

// ---------------------------------------------------------------------------
// Settings loader
// ---------------------------------------------------------------------------

async function withRoot(settings: string | undefined, fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "web-config-"));
  try {
    if (settings !== undefined) {
      await mkdir(join(dir, ".wudao"), { recursive: true });
      await writeFile(join(dir, ".wudao", "settings.json"), settings, "utf8");
    }
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** A public-resolving endpoint lookup (the loader's DNS seam, mocked — the
 *  tests never touch the real resolver). */
const PUBLIC_LOOKUP = async (hostname: string) => [{ address: "93.184.216.34", family: 4 }];

describe("loadWebSettings (M59 §3)", () => {
  it("defaults with no settings: search unconfigured, fetch caps, no allowlist", async () => {
    await withRoot(undefined, async (root) => {
      expect(await loadWebSettings(root)).toEqual(DEFAULT_WEB_SETTINGS);
      expect(webSearchConfig(await loadWebSettings(root))).toBeUndefined();
    });
  });

  it("reads a full searxng config", async () => {
    await withRoot(
      `{"web": {"search": {"provider": "searxng", "endpoint": "http://searx.local:8888", "count": 5},
           "fetch": {"maxChars": 8000, "allowedPorts": [8080]},
           "allowDomains": ["example.com", "*.github.com"]}}`,
      async (root) => {
        const s = await loadWebSettings(root, undefined, { endpointLookup: PUBLIC_LOOKUP });
        expect(s.search).toEqual({ configured: true, provider: "searxng", endpoint: "http://searx.local:8888", apiKeyEnv: undefined, count: 5 });
        expect(s.fetch).toEqual({ maxChars: 8000, allowedPorts: [8080] });
        expect(s.allowDomains).toEqual(["example.com", "*.github.com"]);
        expect(webSearchConfig(s)).toEqual({ provider: "searxng", endpoint: "http://searx.local:8888", count: 5 });
      },
    );
  });

  it("two tiers deep-merge — the PROJECT tier wins provider/endpoint", async () => {
    const globalHome = await mkdtemp(join(tmpdir(), "web-global-"));
    const root = await mkdtemp(join(tmpdir(), "web-project-"));
    const saved = process.env.WUDAO_GLOBAL_HOME;
    process.env.WUDAO_GLOBAL_HOME = globalHome;
    try {
      await mkdir(join(globalHome), { recursive: true });
      await writeFile(join(globalHome, "settings.json"), `{"web": {"search": {"provider": "searxng", "endpoint": "http://global.example/", "count": 3}}}`, "utf8");
      await mkdir(join(root, ".wudao"), { recursive: true });
      await writeFile(join(root, ".wudao", "settings.json"), `{"web": {"search": {"provider": "brave", "apiKeyEnv": "BRAVE_KEY"}}}`, "utf8");
      const s = await loadWebSettings(root, undefined, { endpointLookup: PUBLIC_LOOKUP });
      // project won the provider + added its key; global-only keys survive
      expect(s.search.configured).toBe(true);
      expect(s.search.provider).toBe("brave");
      expect(s.search.apiKeyEnv).toBe("BRAVE_KEY");
      expect(s.search.count).toBe(3); // global survives (project didn't set it)
    } finally {
      if (saved === undefined) delete process.env.WUDAO_GLOBAL_HOME;
      else process.env.WUDAO_GLOBAL_HOME = saved;
      await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("missing provider-required fields keep search UNREGISTERED with a warning", async () => {
    await withRoot(`{"web": {"search": {"provider": "searxng"}}}`, async (root) => {
      const warns: string[] = [];
      const s = await loadWebSettings(root, (m) => warns.push(m));
      expect(s.search.configured).toBe(false);
      expect(warns.some((w) => w.includes("requires web.search.endpoint"))).toBe(true);
      expect(webSearchConfig(s)).toBeUndefined();
    });
    await withRoot(`{"web": {"search": {"provider": "brave"}}}`, async (root) => {
      const warns: string[] = [];
      const s = await loadWebSettings(root, (m) => warns.push(m));
      expect(s.search.configured).toBe(false);
      expect(warns.some((w) => w.includes("requires web.search.apiKeyEnv"))).toBe(true);
    });
  });

  it("an IP-literal endpoint in a refused range unregisters search with the range named", async () => {
    // The cloned-repo vector: a project settings file aiming search at the
    // cloud metadata service.
    await withRoot(`{"web": {"search": {"provider": "searxng", "endpoint": "http://169.254.169.254/"}}}`, async (root) => {
      const warns: string[] = [];
      const s = await loadWebSettings(root, (m) => warns.push(m));
      expect(s.search.configured).toBe(false);
      expect(warns.some((w) => w.includes("169.254.169.254") && w.includes("link-local / cloud metadata"))).toBe(true);
      expect(webSearchConfig(s)).toBeUndefined();
    });
    await withRoot(`{"web": {"search": {"provider": "searxng", "endpoint": "http://10.0.0.9:8888"}}}`, async (root) => {
      const warns: string[] = [];
      const s = await loadWebSettings(root, (m) => warns.push(m));
      expect(s.search.configured).toBe(false);
      expect(warns.some((w) => w.includes("private network"))).toBe(true);
    });
  });

  it("a HOSTNAME endpoint resolving into a refused range unregisters search (DNS seam)", async () => {
    await withRoot(`{"web": {"search": {"provider": "searxng", "endpoint": "http://searx.rebind.example"}}}`, async (root) => {
      const warns: string[] = [];
      const rebind = async () => [{ address: "10.0.0.7", family: 4 }];
      const s = await loadWebSettings(root, (m) => warns.push(m), { endpointLookup: rebind });
      expect(s.search.configured).toBe(false);
      expect(warns.some((w) => w.includes("searx.rebind.example") && w.includes("10.0.0.7"))).toBe(true);
    });
  });

  it("a public-resolving or unresolvable hostname endpoint stays configured", async () => {
    await withRoot(`{"web": {"search": {"provider": "searxng", "endpoint": "http://searx.example"}}}`, async (root) => {
      expect((await loadWebSettings(root, undefined, { endpointLookup: PUBLIC_LOOKUP })).search.configured).toBe(true);
      const enotfound = async () => { throw new Error("getaddrinfo ENOTFOUND"); };
      expect((await loadWebSettings(root, undefined, { endpointLookup: enotfound })).search.configured).toBe(true);
    });
  });

  it("R2: a blackholed resolver times out to PASS-THROUGH instead of stalling startup", async () => {
    await withRoot(`{"web": {"search": {"provider": "searxng", "endpoint": "http://searx.example"}}}`, async (root) => {
      const hung = () => new Promise<never>(() => {}); // never resolves, never rejects
      const started = Date.now();
      const s = await loadWebSettings(root, undefined, { endpointLookup: hung, lookupBudgetMs: 50 });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(s.search.configured).toBe(true); // timeout = pass-through, not unregistration
    });
  });

  it("count above 20 warns and clamps", async () => {
    await withRoot(`{"web": {"search": {"provider": "searxng", "endpoint": "http://searx.example", "count": 50}}}`, async (root) => {
      const warns: string[] = [];
      const s = await loadWebSettings(root, (m) => warns.push(m), { endpointLookup: PUBLIC_LOOKUP });
      expect(s.search.count).toBe(20);
      expect(warns.some((w) => w.includes("clamped to 20 (got 50)"))).toBe(true);
    });
  });

  it("malformed nodes fall back per-field and never throw", async () => {
    await withRoot(`{"web": {"search": "nope", "fetch": 42, "allowDomains": "x", "extra": 1}}`, async (root) => {
      const warns: string[] = [];
      const s = await loadWebSettings(root, (m) => warns.push(m));
      expect(s.search.configured).toBe(false);
      expect(s.fetch).toEqual(DEFAULT_WEB_SETTINGS.fetch);
      expect(s.allowDomains).toEqual([]);
      expect(warns.some((w) => w.includes('"web.search" must be an object'))).toBe(true);
      expect(warns.some((w) => w.includes('"web.fetch" must be an object'))).toBe(true);
      expect(warns.some((w) => w.includes("web.allowDomains must be a string[]"))).toBe(true);
      expect(warns.some((w) => w.includes("unknown web key"))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Permission layer — web lanes
// ---------------------------------------------------------------------------

describe("decideRichPermission web.allowDomains (M59 §2)", () => {
  const input = (url: string): Record<string, unknown> => ({ url });
  const args = (url: string, webAllowDomains?: readonly string[]) => ({
    mode: "workspace" as const,
    toolName: "web_fetch",
    input: input(url),
    settings: EMPTY_PERMISSION_SETTINGS,
    ...(webAllowDomains !== undefined ? { webAllowDomains } : {}),
  });

  it("exact and *.suffix entries pre-approve; others still ask", () => {
    const list = ["example.com", "*.github.com"];
    expect(decideRichPermission(args("https://example.com/x", list))).toEqual({ behavior: "allow" });
    expect(decideRichPermission(args("https://api.github.com/y", list))).toEqual({ behavior: "allow" });
    expect(decideRichPermission(args("https://github.com/", list))).toEqual({ behavior: "allow" });
    expect(decideRichPermission(args("https://evil.com/", list))).toBe("ask");
    expect(decideRichPermission(args("https://github.com.evil.io/", list))).toBe("ask");
  });

  it("without an allowlist workspace mode still asks", () => {
    expect(decideRichPermission(args("https://example.com/"))).toBe("ask");
  });

  it("settings ASK rules still force the human over the allowlist; deny outranks", () => {
    const ask = decideRichPermission({
      mode: "workspace",
      toolName: "web_fetch",
      input: input("https://example.com/x"),
      settings: { allow: [], deny: [], ask: ["web_fetch"] },
      webAllowDomains: ["example.com"],
    });
    expect(ask).toBe("ask");
    const deny = decideRichPermission({
      mode: "workspace",
      toolName: "web_fetch",
      input: input("https://example.com/x"),
      settings: { allow: [], deny: ["web_fetch"], ask: [] },
      webAllowDomains: ["example.com"],
    });
    expect(deny).toEqual({ behavior: "deny", reason: 'settings deny rule "web_fetch"' });
  });

  it("ask and workspace still ask; auto allows (the sidecar gates it upstream)", () => {
    expect(decideRichPermission({ ...args("https://example.com/"), mode: "ask" })).toBe("ask");
    expect(decideRichPermission({ ...args("https://example.com/"), mode: "workspace" })).toBe("ask");
    expect(decideRichPermission({ ...args("https://example.com/"), mode: "auto" })).toEqual({ behavior: "allow" });
  });

  it("web_search never matches the allowlist (provider backend ≠ query target)", () => {
    const d = decideRichPermission({ mode: "workspace", toolName: "web_search", input: { query: "x" }, settings: EMPTY_PERMISSION_SETTINGS, webAllowDomains: ["example.com"] });
    expect(d).toBe("ask");
  });

  it("an unparseable URL gets no pre-approval (asks; the tool refuses it)", () => {
    expect(decideRichPermission(args("not a url", ["example.com"]))).toBe("ask");
  });
});

describe("web session rules (the `a` answer lane, M59 §2)", () => {
  it("askRuleFor scopes web_fetch to the host — an unparseable URL records NO rule", () => {
    expect(askRuleFor("web_fetch", { url: "https://api.github.com/x?y=1" })).toBe("web_fetch:api.github.com");
    expect(askRuleFor("web_fetch", { url: "https://EXAMPLE.com/" })).toBe("web_fetch:example.com");
    // Garbage URL → null: a bare `web_fetch` rule would blanket-approve every
    // domain for the session (the escalation host scoping exists to prevent).
    expect(askRuleFor("web_fetch", { url: "junk" })).toBeNull();
    expect(askRuleFor("web_fetch", {})).toBeNull(); // no url at all → same hole, same closure
    expect(askRuleFor("read_file", { path: "a.txt" })).toBe("read_file:a.txt");
  });

  it("R2: URLs that PARSE but carry no http(s) authority record NO rule (the empty-suffix match-all)", () => {
    // file:/data:/about:/mailto: all parse — with hostname "" — which would
    // produce the rule "web_fetch:" and ruleMatches treats an empty suffix
    // as match-ALL. One `a` press must not blanket-approve web_fetch.
    expect(askRuleFor("web_fetch", { url: "file:///etc/passwd" })).toBeNull();
    expect(askRuleFor("web_fetch", { url: "data:text/plain,hello" })).toBeNull();
    expect(askRuleFor("web_fetch", { url: "about:blank" })).toBeNull();
    expect(askRuleFor("web_fetch", { url: "mailto:a@b.c" })).toBeNull();
    expect(askRuleFor("web_fetch", { url: "javascript:alert(1)" })).toBeNull();
    // End to end through the ask-answer path: no session rule is recorded.
    expect(applyAskAnswer({ kind: "session" }, "web_fetch", { url: "file:///etc/passwd" }).sessionRule).toBeNull();
    expect(applyAskAnswer({ kind: "session" }, "web_fetch", { url: "data:text/plain,x" }).sessionRule).toBeNull();
  });

  it("an `a` on a garbage-URL web_fetch call records nothing for the session", () => {
    const outcome = applyAskAnswer({ kind: "session" }, "web_fetch", { url: "junk" });
    expect(outcome.decision).toEqual({ behavior: "allow" }); // the call itself may run (it will refuse)
    expect(outcome.sessionRule).toBeNull(); // but no rule is recorded
  });

  it("ruleMatches: exact host only — a sibling subdomain never rides along", () => {
    const input = { url: "https://api.github.com/x" };
    expect(ruleMatches("web_fetch:api.github.com", "web_fetch", input)).toBe(true);
    expect(ruleMatches("web_fetch:github.com", "web_fetch", input)).toBe(false);
    expect(ruleMatches("web_fetch:evil.com", "web_fetch", input)).toBe(false);
    expect(ruleMatches("web_fetch", "web_fetch", input)).toBe(true);
  });
});

describe("the ask prompt carries the domain (M59 §2)", () => {
  it("summarizeToolCall shows the URL for web_fetch (domain first) and the query for web_search", () => {
    expect(summarizeToolCall("web_fetch", { url: "https://docs.example.com/very/long/path" })).toContain("docs.example.com");
    expect(summarizeToolCall("web_search", { query: "node dns" })).toBe("node dns");
  });
  it("a long URL truncates from the TAIL — the domain always survives", () => {
    const summary = summarizeToolCall("web_fetch", { url: `https://example.com/${"a".repeat(400)}` });
    expect(summary.startsWith("https://example.com/")).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(500);
  });
});

// ---------------------------------------------------------------------------
// Tool registry — fetch always, search only when configured
// ---------------------------------------------------------------------------

const stubModel: ModelClient = {
  async generate(_input: ModelInput): Promise<AssistantMessage> {
    return { role: "assistant", content: "" };
  },
};
const allowAll = async (): Promise<PermissionDecision> => ({ behavior: "allow" });

function build(web?: { fetch?: { maxChars?: number; allowedPorts?: readonly number[] }; search?: never | object }): Tool[] {
  return buildToolSet({
    workspaceRoot: "/tmp/ws",
    model: stubModel,
    canUseTool: allowAll,
    contextWindowTokens: 64_000,
    ...(web !== undefined ? { web: web as never } : {}),
  });
}

describe("buildToolSet web registration (M59 §3)", () => {
  it("web_fetch is registered ZERO-CONFIG (no web settings at all)", () => {
    const names = build().map((t) => t.name);
    expect(names).toContain("web_fetch");
    expect(names).not.toContain("web_search");
  });

  it("web_search registers only when a provider is configured", () => {
    const names = build({ search: { provider: "searxng", endpoint: "http://searx.local/" } }).map((t) => t.name);
    expect(names).toContain("web_fetch");
    expect(names).toContain("web_search");
  });

  it("the web surface is exactly the two tools, top-level (pool boundary lives in tools.ts: web never joins toolPool)", () => {
    const tools = build({ search: { provider: "searxng", endpoint: "http://searx.local/" } });
    expect(tools.filter((t) => t.name.startsWith("web_"))).toHaveLength(2);
    // The task tool exists and its child sets are built from toolPool — the
    // registry test file pins pool membership by construction site; here we
    // pin the annotations the sidecar/permission layers consume.
    const fetchTool = tools.find((t) => t.name === "web_fetch")!;
    expect(fetchTool.isReadOnly?.({ url: "https://x/" })).toBe(true);
    expect(fetchTool.isOpenWorld?.({ url: "https://x/" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// /doctor web checks
// ---------------------------------------------------------------------------

describe("/doctor web checks (M59 §3)", () => {
  const base: DoctorInput = { cwd: "/tmp", nodeVersion: "22.0.0", requiredNode: ">=22" };

  it("fetch reports always-on; unconfigured search carries the configuration guidance", () => {
    expect(checkWebFetch(base).status).toBe("ok");
    const unconfigured = checkWebSearch({ ...base, web: { search: { configured: false } } });
    expect(unconfigured.status).toBe("warn");
    expect(unconfigured.hint).toContain('"provider": "searxng"');
    expect(formatDoctorReport({ ...base, web: { search: { configured: false } } })).toContain("web_search not configured");
  });

  it("configured searxng reports provider + endpoint", () => {
    const c = checkWebSearch({ ...base, web: { search: { configured: true, provider: "searxng", endpoint: "http://searx.local:8888/" } } });
    expect(c.status).toBe("ok");
    expect(c.label).toContain("searxng → http://searx.local:8888/");
  });

  it("brave reports whether the apiKeyEnv variable is set", () => {
    const saved = process.env["WEBTEST_DOCTOR_KEY"];
    delete process.env["WEBTEST_DOCTOR_KEY"];
    try {
      const missing = checkWebSearch({ ...base, web: { search: { configured: true, provider: "brave", apiKeyEnv: "WEBTEST_DOCTOR_KEY" } } });
      expect(missing.status).toBe("warn");
      expect(missing.label).toContain("WEBTEST_DOCTOR_KEY not set");
      process.env["WEBTEST_DOCTOR_KEY"] = "tok";
      const set = checkWebSearch({ ...base, web: { search: { configured: true, provider: "brave", apiKeyEnv: "WEBTEST_DOCTOR_KEY" } } });
      expect(set.status).toBe("ok");
    } finally {
      if (saved === undefined) delete process.env["WEBTEST_DOCTOR_KEY"];
      else process.env["WEBTEST_DOCTOR_KEY"] = saved;
    }
  });

  it("no web node at all degrades to the unconfigured guidance", () => {
    expect(checkWebSearch(base).status).toBe("warn");
  });
});
