// ω99-7 — refine.auto settings loader contract (the long-task-config
// pattern): missing/empty → OFF (enabled=false — a feature that silently
// spends model calls must be explicitly enabled; prime-agent defaults ON,
// wudao reverses that ruling); malformed → warning + per-field fallback;
// unknown keys → warning listing them; WUDAO_AUTO_REFINE=off kill switch;
// turnInterval clamped [1,200], cooldownMs clamped [0,24h].
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadRefineAutoSettings,
  resolveRefineAutoSettings,
  DEFAULT_REFINE_AUTO,
  REFINE_AUTO_TURN_MAX,
  REFINE_AUTO_COOLDOWN_MAX_MS,
} from "../src/refine-auto-config.js";

const ENV_KEYS = ["WUDAO_AUTO_REFINE", "WUDAO_GLOBAL_HOME"] as const;

async function withSettings(
  json: string | undefined,
  env: Record<string, string> | undefined,
  fn: (root: string, isolatedEnv: NodeJS.ProcessEnv) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "refine-auto-cfg-"));
  const home = await mkdtemp(join(tmpdir(), "refine-auto-home-"));
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  const isolatedEnv: NodeJS.ProcessEnv = { ...process.env, WUDAO_GLOBAL_HOME: home, ...env };
  try {
    if (json !== undefined) {
      await mkdir(join(dir, ".wudao"), { recursive: true });
      await writeFile(join(dir, ".wudao", "settings.json"), json, "utf8");
    }
    await fn(dir, isolatedEnv);
  } finally {
    for (const k of ENV_KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

describe("loadRefineAutoSettings (loader contract)", () => {
  it("defaults: enabled=false / 25 / compact=true / 20min — the OFF-by-default ruling", () => {
    expect(DEFAULT_REFINE_AUTO).toEqual({ enabled: false, turnInterval: 25, compact: true, cooldownMs: 20 * 60_000 });
  });

  it("missing settings file → defaults, silent (OFF)", async () => {
    const warnings: string[] = [];
    await withSettings(undefined, undefined, async (root, env) => {
      expect(await loadRefineAutoSettings(root, (m) => warnings.push(m), env)).toEqual(DEFAULT_REFINE_AUTO);
      expect(warnings).toEqual([]);
    });
  });

  it("empty refine node / empty auto node → defaults, silent", async () => {
    const warnings: string[] = [];
    await withSettings(JSON.stringify({ refine: {} }), undefined, async (root, env) => {
      expect(await loadRefineAutoSettings(root, (m) => warnings.push(m), env)).toEqual(DEFAULT_REFINE_AUTO);
    });
    await withSettings(JSON.stringify({ refine: { auto: {} } }), undefined, async (root, env) => {
      expect(await loadRefineAutoSettings(root, (m) => warnings.push(m), env)).toEqual(DEFAULT_REFINE_AUTO);
      expect(warnings).toEqual([]);
    });
  });

  it("full parse", async () => {
    await withSettings(JSON.stringify({ refine: { auto: { enabled: true, turnInterval: 40, compact: false, cooldownMs: 60_000 } } }), undefined, async (root, env) => {
      expect(await loadRefineAutoSettings(root, () => {}, env)).toEqual({ enabled: true, turnInterval: 40, compact: false, cooldownMs: 60_000 });
    });
  });

  it("wrong-typed fields → warning + per-field fallback (never fatal)", async () => {
    const warnings: string[] = [];
    await withSettings(
      JSON.stringify({ refine: { auto: { enabled: "yes", turnInterval: "25", compact: 1, cooldownMs: 1.5 } } }),
      undefined,
      async (root, env) => {
        expect(await loadRefineAutoSettings(root, (m) => warnings.push(m), env)).toEqual(DEFAULT_REFINE_AUTO);
      },
    );
    expect(warnings).toHaveLength(4);
    expect(warnings.join("\n")).toContain("enabled");
    expect(warnings.join("\n")).toContain("turnInterval");
    expect(warnings.join("\n")).toContain("compact");
    expect(warnings.join("\n")).toContain("cooldownMs");
  });

  it("unknown key → warning listing it, the rest still parsed", async () => {
    const warnings: string[] = [];
    await withSettings(JSON.stringify({ refine: { auto: { enabled: true, interval: 5 } } }), undefined, async (root, env) => {
      const s = await loadRefineAutoSettings(root, (m) => warnings.push(m), env);
      expect(s.enabled).toBe(true);
      expect(s.turnInterval).toBe(25);
    });
    expect(warnings.join("\n")).toContain("interval");
  });

  it("non-object refine / refine.auto → warning + defaults", async () => {
    const warnings: string[] = [];
    await withSettings(JSON.stringify({ refine: "nope" }), undefined, async (root, env) => {
      expect(await loadRefineAutoSettings(root, (m) => warnings.push(m), env)).toEqual(DEFAULT_REFINE_AUTO);
    });
    await withSettings(JSON.stringify({ refine: { auto: [1, 2] } }), undefined, async (root, env) => {
      expect(await loadRefineAutoSettings(root, (m) => warnings.push(m), env)).toEqual(DEFAULT_REFINE_AUTO);
    });
    expect(warnings).toHaveLength(2);
  });

  it("clamps: turnInterval 500→200 / 0→1; cooldownMs over 24h→cap / negative→0", async () => {
    await withSettings(
      JSON.stringify({ refine: { auto: { enabled: true, turnInterval: 500, cooldownMs: REFINE_AUTO_COOLDOWN_MAX_MS + 1 } } }),
      undefined,
      async (root, env) => {
        const s = await loadRefineAutoSettings(root, () => {}, env);
        expect(s.turnInterval).toBe(REFINE_AUTO_TURN_MAX);
        expect(s.cooldownMs).toBe(REFINE_AUTO_COOLDOWN_MAX_MS);
      },
    );
    await withSettings(JSON.stringify({ refine: { auto: { enabled: true, turnInterval: 0, cooldownMs: -500 } } }), undefined, async (root, env) => {
      const s = await loadRefineAutoSettings(root, () => {}, env);
      expect(s.turnInterval).toBe(1);
      expect(s.cooldownMs).toBe(0);
    });
  });
});

describe("resolveRefineAutoSettings (kill switch)", () => {
  it("WUDAO_AUTO_REFINE=off forces enabled=false; other values leave settings untouched", () => {
    const on = { ...DEFAULT_REFINE_AUTO, enabled: true };
    expect(resolveRefineAutoSettings(on, { WUDAO_AUTO_REFINE: "off" }).enabled).toBe(false);
    expect(resolveRefineAutoSettings(on, { WUDAO_AUTO_REFINE: "" }).enabled).toBe(true);
    expect(resolveRefineAutoSettings(on, {}).enabled).toBe(true);
    expect(resolveRefineAutoSettings(undefined, {}).enabled).toBe(false);
  });
});
