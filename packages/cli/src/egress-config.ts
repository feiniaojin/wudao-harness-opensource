// ω99-46 — the settings `network` node, read through the layered settings
// the boot already loaded (M62 pattern: session-static, resolved ONCE before
// any prompt/provider is built — a mid-session flip would change where
// requests go without any observable trace). Loader contract follows
// web-config.ts: missing/empty → undefined (silent); wrong-typed values →
// warning + per-field fallback (never fatal); unknown keys → warning.
//
// Settings shape (~/.wudao/settings.json, GLOBAL tier only — the trust gate
// drops a project/local `network` node, see settings-layer.ts):
//   "network": {
//     "proxy":       "socks5://127.0.0.1:10808",          // default proxy
//     "proxyRoutes": { "https://api.openai.com": "http://127.0.0.1:7890" }
//   }
// Env vars (HTTPS_PROXY/HTTP_PROXY/ALL_PROXY/NO_PROXY) remain the base
// layer; these two keys OVERRIDE/pin on top. Credentials in proxy URLs are
// supported (userId/password ride to the proxy auth) but discouraged —
// settings files are the wrong place for secrets.
import type { EgressSettingsInput } from "@wudao-org/core";

export type EgressWarn = (message: string) => void;

function defaultWarn(message: string): void {
  process.stderr.write(`${message}\n`);
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const asString = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

/** Read the `network` node off an effective settings record. `undefined`
 *  when the node is absent — the egress layer then sees no settings input
 *  and env alone decides (or nothing installs). */
export function readEgressSettings(
  effective: Readonly<Record<string, unknown>>,
  warn: EgressWarn = defaultWarn,
): EgressSettingsInput | undefined {
  const node = effective["network"];
  if (node === undefined) return undefined;
  const record = asRecord(node);
  if (record === undefined) {
    warn('⚠️ settings: "network" must be an object {proxy,proxyRoutes}; ignored');
    return undefined;
  }
  const unknown = Object.keys(record).filter((k) => k !== "proxy" && k !== "proxyRoutes");
  if (unknown.length > 0) warn(`⚠️ settings: unknown network key(s) ignored: ${unknown.join(", ")}`);
  const proxy = asString(record["proxy"]);
  if (record["proxy"] !== undefined && proxy === undefined) {
    warn('⚠️ settings: network.proxy must be a non-empty proxy URL string; ignored');
  }
  let proxyRoutes: Readonly<Record<string, string>> | undefined;
  const routesRaw = record["proxyRoutes"];
  if (routesRaw !== undefined) {
    const routesRecord = asRecord(routesRaw);
    if (routesRecord === undefined || Object.keys(routesRecord).length === 0) {
      warn("⚠️ settings: network.proxyRoutes must be an object of origin → proxy URL; ignored");
    } else {
      const clean: Record<string, string> = {};
      for (const [key, value] of Object.entries(routesRecord)) {
        const v = asString(value);
        if (v === undefined) {
          warn(`⚠️ settings: network.proxyRoutes["${key}"] must be a non-empty proxy URL string; entry ignored`);
          continue;
        }
        clean[key] = v;
      }
      proxyRoutes = clean;
    }
  }
  return {
    ...(proxy !== undefined ? { proxy } : {}),
    ...(proxyRoutes !== undefined ? { proxyRoutes } : {}),
  };
}
