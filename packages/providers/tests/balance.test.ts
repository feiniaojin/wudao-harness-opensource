// P0-4 (96 队列) — fetchProviderBalance: the DeepSeek GET /user/balance face
// (Reasonix internal/billing/balance.go discipline): an unconfigured provider
// is NOT an error (undefined → the caller silently omits the readout); money
// never enters a float (the API's strings ride through verbatim); every test
// injects fetchImpl — zero real network.
import { describe, it, expect } from "vitest";
import { fetchProviderBalance } from "../src/balance.js";

const ok = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

describe("fetchProviderBalance — unconfigured is not an error", () => {
  it("empty/missing balanceUrl → undefined and NO fetch is made", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return ok("{}");
    };
    await expect(fetchProviderBalance({}, { fetchImpl })).resolves.toBeUndefined();
    await expect(fetchProviderBalance({ balanceUrl: "" }, { fetchImpl })).resolves.toBeUndefined();
    // Reasonix trims: a whitespace-only url is as good as none.
    await expect(fetchProviderBalance({ balanceUrl: "   " }, { fetchImpl })).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });
});

describe("fetchProviderBalance — request shape", () => {
  it("GET balanceUrl with Accept json + Bearer key; an empty key sends no auth header", async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      seen.push({ url: String(url), init });
      return ok(`{"is_available":true,"balance_infos":[]}`);
    };
    await fetchProviderBalance(
      { balanceUrl: "https://api.deepseek.com/user/balance", apiKey: "sk-test" },
      { fetchImpl },
    );
    expect(seen[0]?.url).toBe("https://api.deepseek.com/user/balance");
    const headers = seen[0]?.init?.headers as Record<string, string>;
    expect(headers["accept"]).toBe("application/json");
    expect(headers["authorization"]).toBe("Bearer sk-test");

    seen.length = 0;
    await fetchProviderBalance({ balanceUrl: "https://api.deepseek.com/user/balance" }, { fetchImpl });
    expect("authorization" in (seen[0]?.init?.headers as Record<string, string>)).toBe(false);
  });
});

describe("fetchProviderBalance — DeepSeek schema (宽进严出)", () => {
  it("normal shape → normalized; amounts stay the API's strings (no float math)", async () => {
    const fetchImpl: typeof fetch = async () =>
      ok(
        `{"is_available":true,"balance_infos":[`
        + `{"currency":"CNY","total_balance":"110.00","granted_balance":"10.00","topped_up_balance":"100.00"},`
        + `{"currency":"USD","total_balance":"3.50","granted_balance":"0.00","topped_up_balance":"3.50"}]}`,
      );
    const r = await fetchProviderBalance({ balanceUrl: "https://x/balance" }, { fetchImpl });
    expect(r).toEqual({
      available: true,
      infos: [
        { currency: "CNY", totalBalance: "110.00", grantedBalance: "10.00", toppedUpBalance: "100.00" },
        { currency: "USD", totalBalance: "3.50", grantedBalance: "0.00", toppedUpBalance: "3.50" },
      ],
    });
  });

  it("missing fields default (is_available → false, amounts → \"\")", async () => {
    const fetchImpl: typeof fetch = async () => ok(`{"balance_infos":[{}]}`);
    const r = await fetchProviderBalance({ balanceUrl: "https://x/balance" }, { fetchImpl });
    expect(r).toEqual({
      available: false,
      infos: [{ currency: "", totalBalance: "", grantedBalance: "", toppedUpBalance: "" }],
    });
  });

  it("an empty/wrong-shape body still normalizes (never a decode crash)", async () => {
    const fetchImpl: typeof fetch = async () => ok(`[]`);
    await expect(fetchProviderBalance({ balanceUrl: "https://x/balance" }, { fetchImpl })).resolves.toEqual({
      available: false,
      infos: [],
    });
  });
});

describe("fetchProviderBalance — failure surfaces", () => {
  it("non-200 → throws with the status + the trimmed body's first 200 chars", async () => {
    const body = "A".repeat(150) + "B".repeat(150);
    const fetchImpl: typeof fetch = async () => new Response(body, { status: 502 });
    await expect(
      fetchProviderBalance({ balanceUrl: "https://x/balance" }, { fetchImpl }),
    ).rejects.toThrow(/balance: status 502:/);
    const err = await fetchProviderBalance({ balanceUrl: "https://x/balance" }, { fetchImpl }).catch((e: Error) => e);
    expect(err.message).toContain("A".repeat(150));
    expect(err.message).not.toContain("B".repeat(151)); // capped at 200 body chars
  });

  it("bad JSON → throws with decode", async () => {
    const fetchImpl: typeof fetch = async () => ok("not json {{{");
    await expect(
      fetchProviderBalance({ balanceUrl: "https://x/balance" }, { fetchImpl }),
    ).rejects.toThrow(/balance: decode:/);
  });
});
