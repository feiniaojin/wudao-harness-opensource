// ω99-46 — egress proxy INSTALL: the transport half. It owns undici's global
// dispatcher and the process-wide record of which policy is active — the
// mechanism the the upstream formatstartup uses, with wudao's four additions (socks5
// first-class, child-env overlay in scrubChildEnv's neighborhood, typed
// proxy-failure attribution, atomic whole-table swap).
//
// RED LINE (brief §1.2/§3): a resolved `none` policy installs NOTHING — no
// undici import, no setGlobalDispatcher call, the direct path byte-identical.
// The install seam (`importUndici`) exists so that pin is testable.
//
// Zero-callsite coverage: providers' `doFetch` (`options.fetch ?? fetch`) and
// core web_fetch's `options.fetchImpl ?? fetch` default to the GLOBAL fetch;
// replacing the global dispatcher redirects them without touching either
// seam or web_fetch's guard logic. (Raw `ws` sockets — Slack Socket Mode —
// do not go through fetch/undici and stay direct; documented residual.)
//
// Disposal (the upstream formatinstall.ts semantics): dispose RESTORES the previous global
// dispatcher and policy, then CLOSES the routing agent — close, never
// destroy, so a request already dispatched when the table swapped finishes
// naturally. A swap is a whole-table replacement: the new agent is fully
// built before setGlobalDispatcher, and the policy object + routes map are
// frozen at resolution — no per-item mutation ever races a request.
import type { Dispatcher, Pool } from "undici";
import {
  egressChildEnvOverlay,
  egressProxyScheme,
  proxyFailureOf,
  proxyForUrl,
  type EgressPolicy,
} from "./egress-policy.js";

/** What the default seams load (structural, so tests can record calls). */
type UndiciModule = typeof import("undici");
type SocksModule = typeof import("fetch-socks");

/** Test seams: inject recorders or a broken loader; defaults import the real
 *  packages (undici dynamically — the pure policy half carries no transport
 *  dependency, matching the the upstream formatsplit). */
export interface EgressInstallSeams {
  readonly importUndici?: () => Promise<UndiciModule>;
  readonly importSocks?: () => Promise<SocksModule>;
}

const defaultImportUndici = (): Promise<UndiciModule> => import("undici");
const defaultImportSocks = (): Promise<SocksModule> => import("fetch-socks");

/** The active policy. Process-wide, like the dispatcher it tracks. */
let active: EgressPolicy = { kind: "none", diagnostics: [] };
/** The dispatcher installed with `active` (undefined when none). */
let installedDispatcher: Dispatcher | undefined;

/** The currently active policy (observability/tests). */
export function activeEgressPolicy(): EgressPolicy {
  return active;
}

/** The proxy-env overlay for spawned children, computed against the env the
 *  spawner already scrubbed — ONE policy function for every child spawn
 *  (shell's scrubChildEnv and the cli capture child), so no second
 *  proxy-env decision point can drift. */
export function applyEgressChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const overlay = egressChildEnvOverlay(active, env);
  const out: NodeJS.ProcessEnv = { ...env };
  for (const [name, value] of Object.entries(overlay)) {
    if (value === undefined) delete out[name];
    else out[name] = value;
  }
  return out;
}

/** The proxy dispatcher for one proxy URL: undici ProxyAgent for http(s)
 *  proxies, fetch-socks' socksDispatcher for socks5 — both are undici Agent
 *  family, so both ride the SAME per-origin factory seam. Credentials in the
 *  proxy URL (userId/password) ride through to the proxy auth. */
function proxyDispatcherFor(
  proxyUrl: string,
  options: Pool.Options,
  undici: UndiciModule,
  socks: SocksModule,
): Dispatcher {
  if (egressProxyScheme(proxyUrl) === "socks5") {
    const u = new URL(proxyUrl);
    // Drop a `connect` key the factory opts may carry as a FUNCTION —
    // socksDispatcher's own connect accepts TLS options only (its connector
    // is the socks one). The Agent factory runtime never passes one.
    const { connect: _unsupportedConnectorForm, ...rest } = options;
    return socks.socksDispatcher(
      {
        type: 5,
        host: u.hostname.replace(/^\[|\]$/g, ""),
        port: Number(u.port !== "" ? u.port : 1080),
        ...(u.username !== "" ? { userId: decodeURIComponent(u.username) } : {}),
        ...(u.password !== "" ? { password: decodeURIComponent(u.password) } : {}),
      },
      rest,
    );
  }
  return new undici.ProxyAgent({ ...options, uri: proxyUrl });
}

/**
 * Wrap one dispatch handler so proxy-side failures surface as
 * ProxyEgressError naming the proxy host:port and stage. Only identifiable
 * proxy-side errors are rewritten (see proxyFailureOf) and only before a
 * response started — mid-tunnel failures pass through untouched. Everything
 * else forwards verbatim through the Proxy.
 */
function attributedHandler<H extends object>(handler: H, proxyUrl: string): H {
  let responseStarted = false;
  const cache = new Map<string | symbol, unknown>();
  return new Proxy(handler, {
    get(target, prop) {
      if (cache.has(prop)) return cache.get(prop);
      const raw = Reflect.get(target, prop, target) as unknown;
      let value: unknown;
      if (typeof raw === "function") {
        const fn = raw as (...args: unknown[]) => unknown;
        if (prop === "onResponseStart" || prop === "onResponseStarted" || prop === "onHeaders") {
          value = (...args: unknown[]) => {
            responseStarted = true;
            return fn.apply(target, args);
          };
        } else if (prop === "onResponseError" || prop === "onError") {
          value = (...args: unknown[]) => {
            const last = args[args.length - 1];
            const attributed = responseStarted ? undefined : proxyFailureOf(last, proxyUrl);
            if (attributed !== undefined && attributed !== last) args[args.length - 1] = attributed;
            return fn.apply(target, args);
          };
        } else {
          value = fn.bind(target);
        }
      } else {
        value = raw;
      }
      cache.set(prop, value);
      return value;
    },
  });
}

/** The routing dispatcher: one undici Agent whose per-origin factory consults
 * the frozen policy (the same proxyForUrl the attribution arm uses — route
 * and diagnostic can never disagree), and whose dispatch arm wraps proxied
 * requests' handlers for attribution. */
function createRoutingAgent(policy: EgressPolicy & { kind: "routed" }, undici: UndiciModule, socks: SocksModule): Dispatcher {
  const route = (origin: string): string | undefined => {
    try {
      return proxyForUrl(policy, new URL(origin));
    } catch {
      return undefined; // an unparseable origin routes direct, never throws
    }
  };
  class RoutingAgent extends undici.Agent {
    override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
      const origin = options.origin;
      const proxy =
        typeof origin === "string" ? route(origin) : origin instanceof URL ? route(origin.toString()) : undefined;
      if (proxy === undefined) return super.dispatch(options, handler);
      return super.dispatch(options, attributedHandler(handler, proxy));
    }
  }
  return new RoutingAgent({
    factory(origin: Parameters<NonNullable<Pool.Options["factory"]>>[0], opts: Pool.Options) {
      const proxy = route(String(origin));
      if (proxy === undefined) {
        // What undici's own default factory builds for these options (a
        // direct Pool — a ref's direct arm, verbatim semantics).
        return new undici.Pool(origin, opts);
      }
      return proxyDispatcherFor(proxy, opts, undici, socks);
    },
  });
}

export interface EgressInstallResult {
  /** false when nothing was installed (a `none` policy — the zero-change
   *  red line) or when the install failed and the process stays direct. */
  readonly installed: boolean;
  /** Restores the previous global dispatcher + active policy, then closes
   *  the routing agent (in-flight requests drain, the upstream formatclose-not-destroy). */
  readonly dispose: () => Promise<void>;
}

/**
 * Install one egress policy as the process's outbound routing.
 *
 * A `none` policy with nothing previously installed does NOTHING — no undici
 * import, no dispatcher swap (byte-identical direct path). Over a previously
 * installed policy it installs a plain direct Agent, because recording `none`
 * while leaving the old agent routing would make `mode: off` a silent no-op
 * (a ref). Any install failure (import, agent construction) is the caller's to
 * warn about — this function never throws past the seams' own rejections;
 * on rejection the process simply stays direct.
 *
 * Re-installing over an active policy is the ATOMIC TABLE SWAP: the new agent
 * is fully constructed (per-origin factories consult the new frozen policy)
 * before setGlobalDispatcher replaces the old reference in one call; the old
 * agent's close() afterwards lets already-dispatched requests finish.
 */
export async function installEgressProxy(policy: EgressPolicy, seams: EgressInstallSeams = {}): Promise<EgressInstallResult> {
  const previousActive = active;
  const previousInstalled = installedDispatcher;
  const importUndici = seams.importUndici ?? defaultImportUndici;
  const importSocks = seams.importSocks ?? defaultImportSocks;

  if (policy.kind !== "routed") {
    if (previousActive.kind !== "routed") {
      // RED LINE: no configuration → zero behavior change. No import, no
      // setGlobalDispatcher, no state beyond the record itself.
      active = policy;
      return { installed: false, dispose: async () => { active = previousActive; } };
    }
    const undici = await importUndici();
    const previousDispatcher = undici.getGlobalDispatcher();
    const direct = new undici.Agent();
    undici.setGlobalDispatcher(direct);
    active = policy;
    installedDispatcher = undefined;
    return {
      installed: false,
      dispose: async () => {
        if (active === policy && installedDispatcher === undefined) {
          undici.setGlobalDispatcher(previousDispatcher);
          active = previousActive;
          installedDispatcher = previousInstalled;
        }
        await direct.close();
      },
    };
  }

  let undici: UndiciModule;
  let socks: SocksModule;
  try {
    [undici, socks] = await Promise.all([importUndici(), importSocks()]);
  } catch {
    // A transport that cannot load leaves the process direct — the harness
    // keeps starting (a ref: a proxy must not stop the agent).
    return { installed: false, dispose: async () => {} };
  }
  const previousDispatcher = undici.getGlobalDispatcher();
  let agent: Dispatcher;
  try {
    agent = createRoutingAgent(policy, undici, socks);
  } catch {
    return { installed: false, dispose: async () => {} };
  }
  undici.setGlobalDispatcher(agent);
  active = policy;
  installedDispatcher = agent;
  return {
    installed: true,
    dispose: async () => {
      // Disposers compose LIFO: one that runs after a newer install must NOT
      // undo it — the newer policy owns the global state now. This one only
      // closes its own agent (its in-flight requests still drain).
      if (active === policy && installedDispatcher === agent) {
        undici.setGlobalDispatcher(previousDispatcher);
        active = previousActive;
        installedDispatcher = previousInstalled;
      }
      await agent.close();
    },
  };
}
