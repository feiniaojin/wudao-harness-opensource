// M46: output feedback settings — loader contract (defaults / per-field
// fallback / unknown keys) and the env kill switches resolved into the core
// tool configs. The longOutput half gains its runtime tests alongside the
// shell shaping; the loader is pinned here from day one.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadWriteVerifySettings,
  loadLongOutputSettings,
  resolveWriteVerifyRuntime,
  resolveLongOutputRuntime,
  resolveGenericShapingRuntime,
  DEFAULT_WRITE_VERIFY_SETTINGS,
  DEFAULT_LONG_OUTPUT,
} from "../src/output-config.js";

const ENV_KEYS = ["WUDAO_WRITE_VERIFY", "WUDAO_LONG_OUTPUT", "WUDAO_GENERIC_SHAPING"] as const;

async function withSettings(json: string | undefined, fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "out-config-"));
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    if (json !== undefined) {
      await mkdir(join(dir, ".wudao"), { recursive: true });
      await writeFile(join(dir, ".wudao", "settings.json"), json, "utf8");
    }
    await fn(dir);
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

describe("writeVerify settings", () => {
  it("defaults to enabled with tsc off when no settings exist", async () => {
    await withSettings(undefined, async (root) => {
      expect(await loadWriteVerifySettings(root)).toEqual(DEFAULT_WRITE_VERIFY_SETTINGS);
      expect(resolveWriteVerifyRuntime(undefined, {})).toEqual({ enabled: true, tsTsc: false });
    });
  });
  it("reads the writeVerify node", async () => {
    await withSettings(`{"writeVerify": {"enabled": false, "tsTsc": true}}`, async (root) => {
      expect(await loadWriteVerifySettings(root)).toEqual({ enabled: false, tsTsc: true });
      expect(resolveWriteVerifyRuntime(await loadWriteVerifySettings(root), {})).toEqual({ enabled: false, tsTsc: true });
    });
  });
  it("falls back per-field on wrong types and warns about unknown keys", async () => {
    await withSettings(`{"writeVerify": {"enabled": "yes", "extra": 1}}`, async (root) => {
      const warns: string[] = [];
      expect(await loadWriteVerifySettings(root, (m) => warns.push(m))).toEqual({ enabled: true, tsTsc: false });
      expect(warns.some((w) => w.includes("enabled must be a boolean"))).toBe(true);
      expect(warns.some((w) => w.includes("unknown writeVerify key"))).toBe(true);
    });
  });
  it("rejects a non-object node with defaults + warning", async () => {
    await withSettings(`{"writeVerify": 3}`, async (root) => {
      const warns: string[] = [];
      expect(await loadWriteVerifySettings(root, (m) => warns.push(m))).toEqual(DEFAULT_WRITE_VERIFY_SETTINGS);
      expect(warns.some((w) => w.includes('"writeVerify" must be an object'))).toBe(true);
    });
  });
  it("WUDAO_WRITE_VERIFY=off kills the feature; ts-off only the tsc lane", async () => {
    await withSettings(`{"writeVerify": {"tsTsc": true}}`, async (root) => {
      const settings = await loadWriteVerifySettings(root);
      expect(resolveWriteVerifyRuntime(settings, { WUDAO_WRITE_VERIFY: "off" })).toBeUndefined();
      expect(resolveWriteVerifyRuntime(settings, { WUDAO_WRITE_VERIFY: "ts-off" })).toEqual({ enabled: true, tsTsc: false });
      expect(resolveWriteVerifyRuntime(settings, {})).toEqual({ enabled: true, tsTsc: true });
    });
  });
});

describe("longOutput settings", () => {
  it("defaults to 200/10000/50/50", async () => {
    await withSettings(undefined, async (root) => {
      expect(await loadLongOutputSettings(root)).toEqual(DEFAULT_LONG_OUTPUT);
      expect(resolveLongOutputRuntime(undefined, {})).toEqual({
        lineThreshold: 200,
        byteThreshold: 10_000,
        headLines: 50,
        tailLines: 50,
      });
    });
  });
  it("reads custom thresholds and tolerates sibling nodes", async () => {
    await withSettings(`{"longOutput": {"lineThreshold": 30, "headLines": 5, "tailLines": 7}, "hooks": {}}`, async (root) => {
      expect(await loadLongOutputSettings(root)).toEqual({ ...DEFAULT_LONG_OUTPUT, lineThreshold: 30, headLines: 5, tailLines: 7 });
    });
  });
  it("falls back per-field on wrong types", async () => {
    await withSettings(`{"longOutput": {"byteThreshold": -1, "tailLines": "x"}}`, async (root) => {
      const warns: string[] = [];
      expect(await loadLongOutputSettings(root, (m) => warns.push(m))).toEqual(DEFAULT_LONG_OUTPUT);
      expect(warns.filter((w) => w.includes("must be a positive integer")).length).toBe(2);
    });
  });
  it("WUDAO_LONG_OUTPUT=off turns shaping off entirely", async () => {
    await withSettings(`{"longOutput": {"lineThreshold": 30}}`, async (root) => {
      expect(resolveLongOutputRuntime(await loadLongOutputSettings(root), { WUDAO_LONG_OUTPUT: "off" })).toBeUndefined();
    });
  });
});

describe("genericResultShaping runtime (ω-1b)", () => {
  it("passes the spill anchor through with the config left to core defaults", () => {
    const resolved = resolveGenericShapingRuntime(join(tmpdir(), "spill"), {});
    expect(resolved).toEqual({ spillDir: join(tmpdir(), "spill") });
    // config stays absent → core's DEFAULT_GENERIC_RESULT_CONFIG governs.
    expect(Object.keys(resolved ?? {})).toEqual(["spillDir"]);
  });
  it("WUDAO_GENERIC_SHAPING=off kills the backstop entirely (case-insensitive)", () => {
    expect(resolveGenericShapingRuntime("/tmp/x", { WUDAO_GENERIC_SHAPING: "off" })).toBeUndefined();
    expect(resolveGenericShapingRuntime("/tmp/x", { WUDAO_GENERIC_SHAPING: " OFF " })).toBeUndefined();
  });
  it("no spill anchor derivable → off (the absent-spillDir kill-switch semantics)", () => {
    expect(resolveGenericShapingRuntime(undefined, {})).toBeUndefined();
    expect(resolveGenericShapingRuntime("", {})).toBeUndefined();
  });
  it("unrelated env values leave shaping armed", () => {
    expect(resolveGenericShapingRuntime("/tmp/x", { WUDAO_GENERIC_SHAPING: "on" })).toEqual({ spillDir: "/tmp/x" });
  });
});
