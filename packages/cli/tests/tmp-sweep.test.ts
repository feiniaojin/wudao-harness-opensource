// OOM-fix guardrail — the startup sweep of stale run_script RPC dirs
// (wudao-ptc-*) and stale python_kernel session dirs (wudao-kernel-*, 114):
// only clearly-abandoned dirs (>1h) under the OS tmpdir are removed,
// best-effort, with nothing else touched.
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PYTHON_KERNEL_TMP_PREFIX } from "@wudao/core";
import { sweepStaleRpcDirs, RPC_TMP_PREFIX, STALE_RPC_DIR_MAX_AGE_MS } from "../src/tmp-sweep.js";

const HOUR = 60 * 60 * 1000;

function makeRpcDir(base: string): string {
  return mkdtempSync(join(base, RPC_TMP_PREFIX));
}

describe("sweepStaleRpcDirs (OOM-fix guardrail)", () => {
  it("removes wudao-ptc-* dirs older than 1h and keeps fresh ones", async () => {
    const base = mkdtempSync(join(tmpdir(), "wudao-sweep-test-"));
    const stale = makeRpcDir(base);
    const fresh = makeRpcDir(base);
    const now = Date.now();
    // stale: mtime 2h ago; fresh: untouched (now)
    utimesSync(stale, new Date(now - 2 * HOUR), new Date(now - 2 * HOUR));

    const removed = await sweepStaleRpcDirs(base, now, STALE_RPC_DIR_MAX_AGE_MS);
    expect(removed).toContain(stale);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("never touches dirs that do not match the prefix", async () => {
    const base = mkdtempSync(join(tmpdir(), "wudao-sweep-test-"));
    const foreign = mkdtempSync(join(base, "someone-else-"));
    utimesSync(foreign, new Date(0), new Date(0)); // ancient but foreign

    const removed = await sweepStaleRpcDirs(base, Date.now(), STALE_RPC_DIR_MAX_AGE_MS);
    expect(removed).toEqual([]);
    expect(existsSync(foreign)).toBe(true);
  });

  it("skips prefix-matching FILES and swallows a missing base dir", async () => {
    const base = mkdtempSync(join(tmpdir(), "wudao-sweep-test-"));
    const file = join(base, RPC_TMP_PREFIX + "not-a-dir");
    writeFileSync(file, "x", "utf8");
    utimesSync(file, new Date(0), new Date(0));

    expect(await sweepStaleRpcDirs(base, Date.now(), STALE_RPC_DIR_MAX_AGE_MS)).toEqual([]);
    expect(existsSync(file)).toBe(true);
    // a nonexistent base resolves to an empty sweep, not a throw
    expect(await sweepStaleRpcDirs(join(base, "nope"))).toEqual([]);
  });

  it("114: sweeps stale python_kernel session dirs under the same 1h grace", async () => {
    const base = mkdtempSync(join(tmpdir(), "wudao-sweep-test-"));
    const staleKernel = mkdtempSync(join(base, PYTHON_KERNEL_TMP_PREFIX));
    const freshKernel = mkdtempSync(join(base, PYTHON_KERNEL_TMP_PREFIX));
    const now = Date.now();
    utimesSync(staleKernel, new Date(now - 2 * HOUR), new Date(now - 2 * HOUR));

    const removed = await sweepStaleRpcDirs(base, now, STALE_RPC_DIR_MAX_AGE_MS);
    expect(removed).toContain(staleKernel);
    expect(existsSync(staleKernel)).toBe(false);
    expect(existsSync(freshKernel)).toBe(true);
  });
});
