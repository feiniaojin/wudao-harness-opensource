// ω99-46 — egress INSTALL tests through an injected fake undici (the seam
// exists so the §2.1 pin — "no configuration → setGlobalDispatcher is NEVER
// called" — is asserted on a recorder, not inferred). The real-dispatcher
// behavior lives in egress-stub.test.ts; this file never touches sockets.
import { afterEach, describe, expect, it, vi } from "vitest";
import { installEgressProxy, activeEgressPolicy, applyEgressChildEnv } from "../src/net/egress.js";
import { resolveEgressPolicy } from "../src/net/egress-policy.js";
import type { EgressPolicy } from "../src/net/egress-policy.js";

class FakeAgent {
  readonly constructedWith: unknown;
  closed = false;
  constructor(options?: unknown) {
    this.constructedWith = options;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}
class FakePool {
  constructor(public readonly origin: unknown, public readonly options: unknown) {}
  async close(): Promise<void> {}
}
class FakeProxyAgent {
  constructor(public readonly options: unknown) {}
  async close(): Promise<void> {}
}

interface FakeUndici {
  readonly sentinel: FakeAgent;
  readonly setCalls: unknown[];
  readonly agents: FakeAgent[];
}

function fakeUndici(): { undici: FakeUndici & Record<string, unknown>; recorder: FakeUndici } {
  const sentinel = new FakeAgent();
  const setCalls: unknown[] = [];
  const agents: FakeAgent[] = [];
  const undici = {
    sentinel,
    setCalls,
    agents,
    Agent: class extends FakeAgent {
      constructor(options?: unknown) {
        super(options);
        agents.push(this);
      }
    },
    Pool: FakePool,
    ProxyAgent: FakeProxyAgent,
    setGlobalDispatcher: (d: unknown): void => {
      setCalls.push(d);
    },
    getGlobalDispatcher: (): unknown => sentinel,
  };
  return { undici: undici as unknown as FakeUndici & Record<string, unknown>, recorder: { sentinel, setCalls, agents } };
}

const socksStub = { socksDispatcher: (proxy: unknown, options?: unknown) => new FakeAgent({ proxy, options }) };

const NONE: EgressPolicy = { kind: "none", diagnostics: [] };

// Restore the module's active-policy state after every test so install tests
// never leak into each other: run tracked disposers LIFO, then force the
// module to `none` (installing a none policy OVER whatever stayed active —
// the fake undici keeps that off the real global dispatcher).
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposers.length > 0) await disposers.pop!()?.();
  await installEgressProxy(NONE, { importUndici: async () => fakeUndici().undici as never, importSocks: async () => socksStub as never });
});

describe("installEgressProxy — the zero-configuration red line (§2.1)", () => {
  it("a `none` policy NEVER imports undici and NEVER calls setGlobalDispatcher", async () => {
    const importer = vi.fn(async () => {
      throw new Error("must not be called");
    });
    const r = await installEgressProxy(NONE, { importUndici: importer, importSocks: async () => socksStub as never });
    expect(importer).not.toHaveBeenCalled();
    expect(r.installed).toBe(false);
    expect(activeEgressPolicy().kind).toBe("none");
    await r.dispose();
  });

  it("an unresolvable transport import leaves the process direct, never throws", async () => {
    const { undici } = fakeUndici();
    const policy = resolveEgressPolicy({ HTTPS_PROXY: "http://p:1" });
    const r = await installEgressProxy(policy, {
      importUndici: async () => undici as never,
      importSocks: async () => {
        throw new Error("ENOENT fetch-socks");
      },
    });
    expect(r.installed).toBe(false);
    expect(activeEgressPolicy().kind).toBe("none");
  });
});

describe("installEgressProxy — install, swap, dispose (§2.3)", () => {
  it("a routed policy installs a NEW dispatcher in one setGlobalDispatcher call", async () => {
    const { undici, recorder } = fakeUndici();
    const policy = resolveEgressPolicy({ HTTPS_PROXY: "http://p:1" });
    const r = await installEgressProxy(policy, { importUndici: async () => undici as never, importSocks: async () => socksStub as never });
    disposers.push(r.dispose);
    expect(r.installed).toBe(true);
    expect(recorder.setCalls.length).toBe(1);
    expect(recorder.setCalls[0]).toBeInstanceOf(FakeAgent);
    expect(activeEgressPolicy()).toBe(policy);
  });

  it("dispose restores the PREVIOUS dispatcher and closes the agent (close, not destroy)", async () => {
    const { undici, recorder } = fakeUndici();
    const r = await installEgressProxy(resolveEgressPolicy({ HTTPS_PROXY: "http://p:1" }), { importUndici: async () => undici as never, importSocks: async () => socksStub as never });
    const agent = recorder.setCalls[0] as FakeAgent;
    await r.dispose();
    expect(recorder.setCalls[1]).toBe(recorder.sentinel);
    expect(agent.closed).toBe(true);
    expect(activeEgressPolicy().kind).toBe("none");
  });

  it("re-installing swaps the WHOLE table: one new agent, old one closed after", async () => {
    const { undici, recorder } = fakeUndici();
    const seam = { importUndici: async () => undici as never, importSocks: async () => socksStub as never };
    const first = await installEgressProxy(resolveEgressPolicy({ HTTPS_PROXY: "http://p:1" }), seam);
    const second = await installEgressProxy(resolveEgressPolicy({ HTTP_PROXY: "http://q:2" }), seam);
    expect(recorder.setCalls.length).toBe(2); // exactly one swap call — no per-item churn
    expect(recorder.setCalls[1]).not.toBe(recorder.setCalls[0]);
    const activeNow = activeEgressPolicy();
    expect(activeNow.kind).toBe("routed");
    if (activeNow.kind === "routed") expect(activeNow.httpProxy).toBe("http://q:2");
    // Out-of-order dispose: the FIRST disposer must NOT undo the newer
    // install (LIFO composition) — the global dispatcher stays the second
    // agent and no third setGlobalDispatcher call happens.
    await first.dispose();
    expect(recorder.setCalls.length).toBe(2);
    expect(activeEgressPolicy().kind).toBe("routed");
    // LIFO unwind then cleans up fully.
    await second.dispose();
    expect(recorder.setCalls[recorder.setCalls.length - 1]).toBe(recorder.sentinel);
  });

  it("`none` over an installed policy installs a plain direct Agent (mode off is not a silent no-op)", async () => {
    const { undici, recorder } = fakeUndici();
    const seam = { importUndici: async () => undici as never, importSocks: async () => socksStub as never };
    const first = await installEgressProxy(resolveEgressPolicy({ HTTPS_PROXY: "http://p:1" }), seam);
    const off = await installEgressProxy(NONE, seam);
    expect(off.installed).toBe(false);
    expect(recorder.setCalls[1]).toBeInstanceOf(FakeAgent);
    expect(activeEgressPolicy().kind).toBe("none");
    await off.dispose();
    await first.dispose();
  });
});

describe("applyEgressChildEnv — module-state wiring", () => {
  it("reflects the ACTIVE policy and merges the overlay into a scrubbed env", async () => {
    const { undici } = fakeUndici();
    const before = activeEgressPolicy();
    const r = await installEgressProxy(resolveEgressPolicy({}, { proxy: "http://p.test:8080" }), { importUndici: async () => undici as never, importSocks: async () => socksStub as never });
    disposers.push(r.dispose);
    const env = applyEgressChildEnv({ PATH: "/bin", SOMETHING_API_KEY: "x" });
    expect(env["HTTPS_PROXY"]).toBe("http://p.test:8080");
    expect(env["NODE_USE_ENV_PROXY"]).toBe("1");
    expect(env["PATH"]).toBe("/bin");
    await r.dispose();
    // dispose returns the module to the state THIS install displaced — an
    // earlier test's stale policy must not leak into the assertion.
    expect(activeEgressPolicy()).toBe(before);
    const after = applyEgressChildEnv({ PATH: "/bin" });
    expect(after).toEqual({ PATH: "/bin" });
    expect("HTTPS_PROXY" in after).toBe(false);
  });
});

describe("scrubChildEnv — the merged single boundary (§2.7)", () => {
  it("inactive policy: scrubChildEnv() output equals the pure scrub, content-identical (byte-for-byte red line)", async () => {
    await installEgressProxy(NONE); // no import — module stays none
    const { scrubChildEnvOf } = await import("../src/tools/shell-snapshot.js");
    const { scrubChildEnv } = await import("../src/tools/shell.js");
    expect(scrubChildEnv()).toEqual(scrubChildEnvOf(process.env));
  });

  it("active policy: children spawned through scrubChildEnv see the proxy names", async () => {
    const { undici } = fakeUndici();
    const { scrubChildEnv } = await import("../src/tools/shell.js");
    const r = await installEgressProxy(resolveEgressPolicy({}, { proxy: "http://p.test:8080" }), { importUndici: async () => undici as never, importSocks: async () => socksStub as never });
    disposers.push(r.dispose);
    const env = scrubChildEnv();
    expect(env["HTTPS_PROXY"]).toBe("http://p.test:8080");
    expect(env["NODE_USE_ENV_PROXY"]).toBe("1");
    // the credential scrub still applies on top of the overlay's inputs
    expect(Object.keys(env).some((k) => /API_KEY$/.test(k))).toBe(false);
  });
});
