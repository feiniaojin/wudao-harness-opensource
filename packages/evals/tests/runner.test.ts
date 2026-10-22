import { describe, it, expect } from "vitest";
import { stat, readdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEval, runAllEvals, classifyEvalFailure, type EvalDefinition, type EvalResult } from "../src/runner.js";
import { buildReceipt, pruneReceipts } from "../src/receipts.js";

function def(partial: Partial<EvalDefinition<unknown, unknown>>): EvalDefinition<unknown, unknown> {
  return {
    name: "sample",
    kind: "deterministic",
    setup: async () => ({}),
    run: async () => ({}),
    assertions: () => [],
    ...partial,
  };
}

describe("runEval", () => {
  it("passes when assertions return no errors and cleans up the temp dir", async () => {
    let seenDir = "";
    const result = await runEval(def({
      name: "passing",
      setup: async (dir) => { seenDir = dir; },
      run: async () => 42,
      assertions: (evidence) => (evidence === 42 ? [] : ["wrong evidence"]),
    }));
    expect(result.status).toBe("pass");
    expect(result.errors).toEqual([]);
    expect(result.skipReason).toBeUndefined();
    await expect(stat(seenDir)).rejects.toThrow();
  });

  it("fails with every assertion error collected", async () => {
    const result = await runEval(def({
      assertions: () => ["err one", "err two"],
    }));
    expect(result.status).toBe("fail");
    expect(result.errors).toEqual(["err one", "err two"]);
  });

  it("fails when run() throws, with the error message", async () => {
    const result = await runEval(def({
      run: async () => { throw new Error("boom"); },
    }));
    expect(result.status).toBe("fail");
    expect(result.errors).toEqual(["boom"]);
  });

  it("fails when setup() throws", async () => {
    const result = await runEval(def({
      setup: async () => { throw new Error("setup exploded"); },
    }));
    expect(result.status).toBe("fail");
    expect(result.errors).toEqual(["setup exploded"]);
  });

  it("skips without calling setup when skip() returns a reason", async () => {
    let setupRan = false;
    const result = await runEval(def({
      kind: "live",
      skip: () => "no API key found",
      setup: async () => { setupRan = true; },
    }));
    expect(result.status).toBe("skip");
    expect(result.skipReason).toBe("no API key found");
    expect(setupRan).toBe(false);
  });

  it("uses a sanitized per-eval temp dir under the given tmpRoot", async () => {
    let seenName = "";
    await runEval(def({
      name: "weird/name with spaces",
      setup: async (dir) => { seenName = dir; },
    }), { tmpRoot: undefined });
    expect(seenName).toMatch(/wudao-eval-weird_name_with_spaces-/);
  });
});

describe("runAllEvals", () => {
  it("runs every definition in order and keeps their names", async () => {
    const order: string[] = [];
    const defs = [
      def({ name: "a", run: async () => { order.push("a"); } }),
      def({ name: "b", run: async () => { order.push("b"); } }),
      def({ name: "c", kind: "live", skip: () => "skipped" }),
    ];
    const results = await runAllEvals(defs);
    expect(order).toEqual(["a", "b"]);
    expect(results.map((r) => r.name)).toEqual(["a", "b", "c"]);
    expect(results.map((r) => r.status)).toEqual(["pass", "pass", "skip"]);
  });

  it("keeps running after a failure (no short-circuit)", async () => {
    const results = await runAllEvals([
      def({ name: "fails", assertions: () => ["nope"] }),
      def({ name: "still-runs" }),
    ] satisfies EvalDefinition<unknown, unknown>[]);
    expect(results.map((r: EvalResult) => r.status)).toEqual(["fail", "pass"]);
  });

  it("threads the trial index through to every result (ω-5a I18)", async () => {
    const results = await runAllEvals([def({ name: "a" }), def({ name: "b" })], { trial: 3 });
    expect(results.map((r) => r.trial)).toEqual([3, 3]);
    expect((await runEval(def({ name: "d" }))).trial).toBe(1); // default
    expect((await runEval(def({ name: "s", kind: "live", skip: () => "x" }))).trial).toBe(1);
  });
});

describe("classifyEvalFailure (ω-5a I18)", () => {
  it("the runner's own timeout prefix → timeout", () => {
    expect(classifyEvalFailure(new Error('eval "live-02-fix-bug" timed out after 600000ms'))).toBe("timeout");
    expect(classifyEvalFailure(new Error('eval "x" timed out after 50ms'))).toBe("timeout");
  });

  it("network/provider vocabulary → provider", () => {
    expect(classifyEvalFailure(new Error("getaddrinfo ENOTFOUND api.deepseek.com"))).toBe("provider");
    expect(classifyEvalFailure(new Error("connect ECONNREFUSED 127.0.0.1:443"))).toBe("provider");
    expect(classifyEvalFailure(new Error("socket hang up ETIMEDOUT"))).toBe("provider");
    const rateLimited = Object.assign(new Error("Too Many Requests"), { status: 429 });
    expect(classifyEvalFailure(rateLimited)).toBe("provider");
    const serverError = Object.assign(new Error("Internal Server Error"), { status: 502 });
    expect(classifyEvalFailure(serverError)).toBe("provider");
    expect(classifyEvalFailure(new Error("Incorrect API key provided"))).toBe("provider");
    expect(classifyEvalFailure(new Error("rate limit exceeded, retry later"))).toBe("provider");
    expect(classifyEvalFailure(new Error("Request failed with status code 500"))).toBe("provider");
  });

  it("the ContextLengthError family → provider", () => {
    class ContextLengthError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "ContextLengthError";
      }
    }
    expect(classifyEvalFailure(new ContextLengthError("prompt is too long"))).toBe("provider");
    expect(classifyEvalFailure(new Error("This model's maximum context length is 65536 tokens"))).toBe("provider");
  });

  it("anything else → harness (fail-closed: unknown infra faults are never 'assertion')", () => {
    expect(classifyEvalFailure(new TypeError("Cannot read properties of undefined (reading 'foo')"))).toBe("harness");
    expect(classifyEvalFailure(new Error("assertion failed: expected 3 to be 4"))).toBe("harness");
    expect(classifyEvalFailure("a bare string throw")).toBe("harness");
    expect(classifyEvalFailure(new Error("expected 500 items but got 3"))).toBe("harness"); // bare numbers are content, not status
    expect(classifyEvalFailure(new Error("expected 429 items but got 3"))).toBe("harness"); // 4xx bare numbers likewise (review M6)
  });

  it("4xx in a message needs transport context (review M6) — mirrors the 5xx lane", () => {
    expect(classifyEvalFailure(new Error("HTTP 429: Too Many Requests"))).toBe("provider");
    expect(classifyEvalFailure(new Error("Request failed with status code 403"))).toBe("provider");
    expect(classifyEvalFailure(new Error("error code 401: invalid token"))).toBe("provider");
  });
});

describe("runEval failure classes + receipts (ω-5a I18)", () => {
  it("assertion errors → failureClass 'assertion'", async () => {
    const result = await runEval(def({ assertions: () => ["miss one"] }));
    expect(result.status).toBe("fail");
    expect(result.failureClass).toBe("assertion");
  });

  it("a provider-shaped throw → failureClass 'provider'", async () => {
    const result = await runEval(def({
      run: async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND api.example.com"), {}); },
    }));
    expect(result.status).toBe("fail");
    expect(result.failureClass).toBe("provider");
  });

  it("a never-settling run under timeoutMs → 'timeout' and the run still fails", async () => {
    const result = await runEval(def({
      run: () => new Promise<never>(() => {}), // never settles
    }), { timeoutMs: 50 });
    expect(result.status).toBe("fail");
    expect(result.failureClass).toBe("timeout");
    expect(result.errors[0]).toMatch(/timed out after 50ms/);
  });

  it("a failing eval leaves a receipt dir; the tmp dir is gone; a passing one leaves nothing", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "wudao-eval-receipts-"));
    const outRoot = join(tmpRoot, "out");
    let seenDir = "";
    const failing = await runEval(def({
      name: "fail/receipt",
      setup: async (dir) => { seenDir = dir; await writeFile(join(dir, "fixture.txt"), "evidence", "utf8"); },
      assertions: () => ["boom"],
    }), { tmpRoot, receipts: { outRoot } });
    expect(failing.status).toBe("fail");
    // The workspace moved into the receipt dir (tmp dir gone).
    await expect(stat(seenDir)).rejects.toThrow();
    const entries = await readdir(outRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.*-fail_receipt-t1$/);
    const receiptDir = join(outRoot, entries[0]!);
    // The fixture file traveled with the workspace.
    expect(await readFile(join(receiptDir, "fixture.txt"), "utf8")).toBe("evidence");
    const receipt = JSON.parse(await readFile(join(receiptDir, "receipt.json"), "utf8"));
    expect(receipt).toEqual({
      name: "fail/receipt",
      trial: 1,
      kind: "deterministic",
      status: "fail",
      failureClass: "assertion",
      errors: ["boom"],
      durationMs: expect.any(Number),
      toolCalls: [],
      usage: [],
    });
    // A passing eval leaves nothing behind.
    const before = await readdir(outRoot);
    await runEval(def({ name: "passing" }), { tmpRoot, receipts: { outRoot } });
    expect(await readdir(outRoot)).toEqual(before);
  });

  it("WUDAO_EVAL_KEEP=1 preserves a passing trial's receipt too", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "wudao-eval-keep-"));
    const outRoot = join(tmpRoot, "out");
    const prev = process.env.WUDAO_EVAL_KEEP;
    process.env.WUDAO_EVAL_KEEP = "1";
    try {
      const passing = await runEval(def({ name: "kept" }), { tmpRoot, receipts: { outRoot } });
      expect(passing.status).toBe("pass");
      const entries = await readdir(outRoot);
      expect(entries).toHaveLength(1);
      const receipt = JSON.parse(await readFile(join(outRoot, entries[0]!, "receipt.json"), "utf8"));
      expect(receipt.status).toBe("pass");
      expect(receipt.failureClass).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.WUDAO_EVAL_KEEP;
      else process.env.WUDAO_EVAL_KEEP = prev;
    }
  });
});

describe("buildReceipt duck-typing (ω-5a I18)", () => {
  it("live-shaped evidence maps onto terminalReason/toolCalls/usage; missing fields are omitted", () => {
    const receipt = buildReceipt("live-01", 2, {
      kind: "live",
      status: "fail",
      failureClass: "provider",
      errors: ["ENOTFOUND"],
      durationMs: 1234,
      metrics: { hitRatePct: 12.5, modelCalls: 3 },
      terminal: { reason: "aborted" },
      events: [
        { type: "tool_call_started", toolCallId: "c1", toolName: "read_file" },
        { type: "tool_call_finished", toolCallId: "c1" },
        { type: "usage", usage: { promptTokens: 5000, cacheHitTokens: 4000, cacheMissTokens: 1000 } },
        { type: "usage", usage: { promptTokens: 6000, cacheHitTokens: 5500, cacheMissTokens: 500 } },
      ],
    });
    expect(receipt).toEqual({
      name: "live-01",
      trial: 2,
      kind: "live",
      status: "fail",
      failureClass: "provider",
      errors: ["ENOTFOUND"],
      durationMs: 1234,
      metrics: { hitRatePct: 12.5, modelCalls: 3 },
      terminalReason: "aborted",
      toolCalls: ["read_file"],
      usage: [
        { turn: 1, promptTokens: 5000, cacheHitTokens: 4000, cacheMissTokens: 1000 },
        { turn: 2, promptTokens: 6000, cacheHitTokens: 5500, cacheMissTokens: 500 },
      ],
    });
    // Absent evidence → honest empties, never fabricated fields.
    const bare = buildReceipt("x", 1, {});
    expect(bare).toEqual({
      name: "x",
      trial: 1,
      kind: "unknown",
      status: "unknown",
      errors: [],
      durationMs: 0,
      toolCalls: [],
      usage: [],
    });
  });
});

describe("preserveReceipt + pruneReceipts (ω-5a I18)", () => {
  it("pruneReceipts(keep:2) removes the 3 oldest of 5 by mtime and returns 3", async () => {
    const outRoot = await mkdtemp(join(tmpdir(), "wudao-eval-prune-"));
    const base = new Date("2026-08-22T00:00:00Z");
    for (let i = 0; i < 5; i += 1) {
      const d = join(outRoot, `2026-08-22T00-00-0${i}-suite-t${i + 1}`);
      await mkdir(d, { recursive: true });
      await utimes(d, base, new Date(base.getTime() + i * 60_000));
    }
    const removed = await pruneReceipts(outRoot, 2);
    expect(removed).toBe(3);
    const left = (await readdir(outRoot)).sort();
    expect(left).toEqual(["2026-08-22T00-00-03-suite-t4", "2026-08-22T00-00-04-suite-t5"]);
    // Idempotent at the floor.
    expect(await pruneReceipts(outRoot, 2)).toBe(0);
  });

  it("pruneReceipts on a missing root returns 0 (not a throw)", async () => {
    expect(await pruneReceipts(join(tmpdir(), "wudao-eval-nope-does-not-exist"), 5)).toBe(0);
  });
});
