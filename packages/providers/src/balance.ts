// P0-4 (96 队列) — the provider wallet-balance face (the upstream harness
// internal/billing/balance.go discipline): one dependency-free fetch every
// frontend can share. The only documented shape today is DeepSeek's
// GET /user/balance, so the parser speaks that schema.
//
// Balance is strictly OPTIONAL: a provider with no balanceUrl is never
// queried — `undefined` is "not configured", not an error, and callers
// silently omit the readout (Reasonix: empty balance_url → (nil, nil)).
// Money never enters a float: the API's amount STRINGS ride through verbatim,
// untouched by arithmetic.
import { truncateSafe } from "@wudao/core";

export interface BalanceInfo {
  readonly currency: string;
  readonly totalBalance: string;
  readonly grantedBalance: string;
  readonly toppedUpBalance: string;
}

/** One provider's wallet, normalized for display. */
export interface ProviderBalance {
  /** The provider reports the account can still serve API calls. */
  readonly available: boolean;
  /** One entry per currency the provider returns. */
  readonly infos: readonly BalanceInfo[];
}

/** Default GET deadline (the /cost all command waits at most this long). */
export const BALANCE_TIMEOUT_MS = 8_000;

/** Body read cap — 64KiB, mirroring the engine's error-body bound. */
const BODY_CAP_BYTES = 64 * 1024;

/** Read at most `capBytes` of the response body as text (stream-capped:
 *  consumption STOPS at the cap — a hostile infinite body cannot buffer). */
async function readBodyCapped(res: Response, capBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (reader === undefined) {
    const text = await res.text();
    return text.length > capBytes ? truncateSafe(text, capBytes) : text; // 113-A4
  }
  const buf = new Uint8Array(capBytes);
  let filled = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || value === undefined) break;
    const room = capBytes - filled;
    if (room <= 0) {
      await reader.cancel().catch(() => {});
      break;
    }
    const take = Math.min(room, value.byteLength);
    buf.set(value.subarray(0, take), filled);
    filled += take;
    if (take < value.byteLength) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return new TextDecoder().decode(buf.subarray(0, filled));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The amount field's 宽进严出 rule: the API's string verbatim; a number the
 *  API already materialized is stringified (still no arithmetic); anything
 *  else is "" (missing). */
function amount(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

/** GET the provider's wallet balance. Returns `undefined` when no balanceUrl
 *  is configured (NOT an error — the caller silently omits the readout);
 *  throws `balance: status …` on a non-OK response and `balance: decode: …`
 *  on an unparseable body. `fetchImpl`/`timeoutMs` are injection seams for
 *  deterministic tests. */
export async function fetchProviderBalance(
  config: { readonly balanceUrl?: string; readonly apiKey?: string },
  opts?: { readonly timeoutMs?: number; readonly fetchImpl?: typeof fetch },
): Promise<ProviderBalance | undefined> {
  const url = config.balanceUrl?.trim();
  if (url === undefined || url === "") return undefined;
  const doFetch = opts?.fetchImpl ?? fetch;
  const headers: Record<string, string> = { accept: "application/json" };
  if (config.apiKey !== undefined && config.apiKey !== "") {
    headers.authorization = `Bearer ${config.apiKey}`;
  }
  const res = await doFetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(opts?.timeoutMs ?? BALANCE_TIMEOUT_MS),
  });
  const body = await readBodyCapped(res, BODY_CAP_BYTES);
  if (!res.ok) {
    throw new Error(`balance: status ${res.status}: ${truncateSafe(body, 200).trim()}`); // 113-A4
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(`balance: decode: ${(e as Error).message}`);
  }
  // DeepSeek schema, 宽进严出: wrong-shape bodies normalize to empty, never
  // crash — every field defaults (`is_available` → false, amounts → "").
  const root = isPlainObject(parsed) ? parsed : {};
  const infosRaw = Array.isArray(root.balance_infos) ? root.balance_infos : [];
  const infos: BalanceInfo[] = [];
  for (const e of infosRaw) {
    if (!isPlainObject(e)) continue;
    infos.push({
      currency: typeof e.currency === "string" ? e.currency : "",
      totalBalance: amount(e.total_balance),
      grantedBalance: amount(e.granted_balance),
      toppedUpBalance: amount(e.topped_up_balance),
    });
  }
  return { available: root.is_available === true, infos };
}
