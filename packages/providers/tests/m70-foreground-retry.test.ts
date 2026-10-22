// M70 §3 (the upstream format) — the foreground-only retry allowlist. API calls are classified
// by whether a HUMAN is blocking on the result (ModelInput.querySource):
// foreground sources (and untagged calls — backward compatible) retry on
// overload-class failures; background sources (the compaction summarizer,
// the /goal evaluator, title generators) bail IMMEDIATELY — during a
// capacity cascade each retry is 3-10x gateway amplification and the user
// never sees those failures anyway.
import { describe, it, expect } from "vitest";
import {
  createOpenAICompatibleProvider,
  FOREGROUND_QUERY_SOURCES,
  BackgroundOverloadError,
  isOverloadClassFailure,
} from "../src/index.js";

const INPUT = { systemPrompt: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [] };

const textRes = (status: number, body: string): Response =>
  ({ ok: status === 200, status, json: async () => JSON.parse(body), text: async () => body }) as unknown as Response;

const OK = () => textRes(200, JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
const OVERLOADED = () => textRes(429, "The server is overloaded — try again later");

/** fetch that fails with 429-overload n times, then succeeds; records calls. */
function cascadeFetch(failTimes: number): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    fetch: (async () => {
      calls += 1;
      return calls <= failTimes ? OVERLOADED() : OK();
    }) as typeof fetch,
  };
}

describe("foreground-only retry allowlist (M70 §3)", () => {
  it("foreground (untagged) 429 retries with backoff and eventually succeeds", async () => {
    const f = cascadeFetch(1);
    const retries: string[] = [];
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch: f.fetch, retry: { sleep: async () => {}, random: () => 0.5 }, onRetry: (_n, _d, reason) => retries.push(reason) },
    );
    const msg = await model.generate(INPUT);
    expect(msg.content).toBe("ok");
    expect(f.calls()).toBe(2);
    expect(retries).toEqual(["overload"]);
  });

  it("background 429 fails IMMEDIATELY with the clear typed reason — one fetch, no waits", async () => {
    const f = cascadeFetch(3);
    let waited = 0;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch: f.fetch, retry: { sleep: async () => { waited += 1; }, random: () => 0.5 } },
    );
    const err = await model.generate({ ...INPUT, querySource: "summarizer" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackgroundOverloadError);
    expect((err as BackgroundOverloadError).name).toBe("BackgroundOverloadError");
    expect((err as BackgroundOverloadError).source).toBe("summarizer");
    expect((err as Error).message).toContain("summarizer");
    expect((err as Error).message).toContain("overload");
    expect((err as Error).message).toContain("429");
    expect(f.calls()).toBe(1);
    expect(waited).toBe(0);
  });

  it("the stream path bails the same way (background overload, pre-delta)", async () => {
    const f = cascadeFetch(3);
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch: f.fetch, retry: { sleep: async () => {}, random: () => 0.5 } },
    );
    const err = await (async () => {
      try {
        for await (const _ev of model.stream!({ ...INPUT, querySource: "evaluator" })) {
          // no events ever arrive (the failure pre-dates the first delta)
        }
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(BackgroundOverloadError);
    expect((err as BackgroundOverloadError).source).toBe("evaluator");
    expect(f.calls()).toBe(1);
  });

  it("background NON-overload transients keep the ordinary retry ladder (the allowlist is overload-scoped)", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return calls === 1 ? textRes(500, "boom") : OK();
    }) as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch, retry: { sleep: async () => {}, random: () => 0.5 } },
    );
    const msg = await model.generate({ ...INPUT, querySource: "summarizer" });
    expect(msg.content).toBe("ok");
    expect(calls).toBe(2);
  });

  it("an explicit foreground source ('agent') retries; the allowlist set is the contract", async () => {
    expect(FOREGROUND_QUERY_SOURCES.has("agent")).toBe(true);
    expect(FOREGROUND_QUERY_SOURCES.has("summarizer")).toBe(false);
    const f = cascadeFetch(1);
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch: f.fetch, retry: { sleep: async () => {}, random: () => 0.5 } },
    );
    const msg = await model.generate({ ...INPUT, querySource: "agent" });
    expect(msg.content).toBe("ok");
    expect(f.calls()).toBe(2);
  });

  // ω99-8b: a child subagent call is stamped querySource="subagent" (core's
  // runSubagent). The waiting PARENT is a human-adjacent foreground caller —
  // before the stamp existed these calls were untagged and retried; the tag
  // must NOT silently demote them to background bail-out on overload.
  it("ω99-8b — 'subagent' is foreground: an overloaded child call retries, not bails", async () => {
    expect(FOREGROUND_QUERY_SOURCES.has("subagent")).toBe(true);
    const f = cascadeFetch(1);
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch: f.fetch, retry: { sleep: async () => {}, random: () => 0.5 } },
    );
    const msg = await model.generate({ ...INPUT, querySource: "subagent" });
    expect(msg.content).toBe("ok");
    expect(f.calls()).toBe(2); // retried past the 429, exactly like the untagged pre-stamp behavior
  });

  it("isOverloadClassFailure: 429/503/529 + overload bodies; not other errors", () => {
    expect(isOverloadClassFailure(new Error("provider request failed: 429 nope"))).toBe(false); // not the typed class
    expect(isOverloadClassFailure(Object.assign(new Error("provider stream failed: 529 overloaded"), { name: "ProviderHttpError", status: 529, body: "", overload: false }))).toBe(false); // duck-typed, not instanceof
  });
});
