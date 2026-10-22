// ω99-4c — the `reflect` settings loader contract (the upstream project's lint/test
// reflected_message, wudao wiring). Loader mirrors long-task-config:
// missing/empty → reflect: undefined (feature OFF, silent); wrong-typed
// fields → warning + per-field fallback (never fatal); unknown keys →
// warning listing them; WUDAO_REFLECT=off kills the whole feature.
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadReflectSettings,
  buildReflectRuntime,
  DEFAULT_REFLECT_ROUNDS,
} from "../src/reflect-config.js";
import { loadHooksSettings } from "../src/hooks-config.js";

const ENV_KEYS = ["WUDAO_REFLECT", "WUDAO_GLOBAL_HOME"] as const;

async function withSettings(
  json: string | undefined,
  env: Record<string, string> | undefined,
  fn: (root: string, isolatedEnv: NodeJS.ProcessEnv) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "reflect-cfg-"));
  const home = await mkdtemp(join(tmpdir(), "reflect-home-"));
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

describe("loadReflectSettings (loader contract)", () => {
  it("missing settings file → reflect undefined (OFF, silent)", async () => {
    const warnings: string[] = [];
    await withSettings(undefined, undefined, async (root, env) => {
      expect(await loadReflectSettings(root, (m) => warnings.push(m), env)).toBeUndefined();
      expect(warnings).toEqual([]);
    });
  });

  it("empty object → reflect undefined (OFF, silent)", async () => {
    const warnings: string[] = [];
    await withSettings(JSON.stringify({ reflect: {} }), undefined, async (root, env) => {
      expect(await loadReflectSettings(root, (m) => warnings.push(m), env)).toBeUndefined();
      expect(warnings).toEqual([]);
    });
  });

  it("full configuration parses (commands, timeouts, maxRounds)", async () => {
    const warnings: string[] = [];
    await withSettings(
      JSON.stringify({
        reflect: {
          lint: { command: "eslint --fix ${file}", timeoutMs: 45000 },
          test: { command: "vitest run", timeoutMs: 240000 },
          maxRounds: 3,
        },
      }),
      undefined,
      async (root, env) => {
        expect(await loadReflectSettings(root, (m) => warnings.push(m), env)).toEqual({
          lint: { command: "eslint --fix ${file}", timeoutMs: 45000 },
          test: { command: "vitest run", timeoutMs: 240000 },
          maxRounds: 3,
        });
        expect(warnings).toEqual([]);
      },
    );
  });

  it("maxRounds defaults to 2 when absent", async () => {
    await withSettings(
      JSON.stringify({ reflect: { lint: { command: "eslint ${file}" } } }),
      undefined,
      async (root, env) => {
        const s = await loadReflectSettings(root, () => {}, env);
        expect(s?.maxRounds).toBe(DEFAULT_REFLECT_ROUNDS);
        expect(DEFAULT_REFLECT_ROUNDS).toBe(2);
      },
    );
  });

  it("wrong-typed fields → warning + per-field fallback (never fatal)", async () => {
    const warnings: string[] = [];
    await withSettings(
      JSON.stringify({
        reflect: {
          lint: "eslint",
          test: { command: 42, timeoutMs: -1 },
          maxRounds: "two",
        },
      }),
      undefined,
      async (root, env) => {
        const s = await loadReflectSettings(root, (m) => warnings.push(m), env);
        // lint is not an object → dropped; test.command not a string →
        // dropped (whole test node inert); maxRounds wrong-typed → default 2.
        expect(s).toBeUndefined();
        const all = warnings.join("\n");
        expect(all).toMatch(/reflect\.lint must be an object/);
        expect(all).toMatch(/reflect\.test\.command must be a non-empty string/);
        expect(all).toMatch(/reflect\.test\.timeoutMs must be a positive number/);
        expect(all).toMatch(/reflect\.maxRounds must be a positive integer/);
      },
    );
  });

  it("lint timeoutMs wrong-typed alone → warning + default timeout, command kept", async () => {
    const warnings: string[] = [];
    await withSettings(
      JSON.stringify({ reflect: { lint: { command: "eslint ${file}", timeoutMs: "slow" } } }),
      undefined,
      async (root, env) => {
        expect(await loadReflectSettings(root, (m) => warnings.push(m), env)).toEqual({
          lint: { command: "eslint ${file}" },
          maxRounds: 2,
        });
        expect(warnings.join("\n")).toMatch(/reflect\.lint\.timeoutMs must be a positive number/);
      },
    );
  });

  it("unknown keys → warning listing them, recognized ones kept", async () => {
    const warnings: string[] = [];
    await withSettings(
      JSON.stringify({ reflect: { lint: { command: "eslint ${file}", rumor: 1 }, mystery: true } }),
      undefined,
      async (root, env) => {
        expect(await loadReflectSettings(root, (m) => warnings.push(m), env)).toEqual({
          lint: { command: "eslint ${file}" },
          maxRounds: 2,
        });
        const all = warnings.join("\n");
        expect(all).toMatch(/unknown reflect key\(s\) ignored: mystery/);
        expect(all).toMatch(/unknown reflect\.lint key\(s\) ignored: rumor/);
      },
    );
  });

  it("WUDAO_REFLECT=off → whole feature OFF even when configured", async () => {
    const warnings: string[] = [];
    await withSettings(
      JSON.stringify({ reflect: { lint: { command: "eslint ${file}" }, test: { command: "vitest run" } } }),
      { WUDAO_REFLECT: "off" },
      async (root, env) => {
        expect(await loadReflectSettings(root, (m) => warnings.push(m), env)).toBeUndefined();
        expect(warnings).toEqual([]);
      },
    );
  });

  it("malformed reflect node (not an object) → warning + OFF", async () => {
    const warnings: string[] = [];
    await withSettings(JSON.stringify({ reflect: [1, 2] }), undefined, async (root, env) => {
      expect(await loadReflectSettings(root, (m) => warnings.push(m), env)).toBeUndefined();
      expect(warnings.join("\n")).toMatch(/"reflect" must be an object/);
    });
  });

  it("runtime OFF when neither lint nor test configured (hooks not mounted)", async () => {
    await withSettings(JSON.stringify({ reflect: { maxRounds: 5 } }), undefined, async (root, env) => {
      const s = await loadReflectSettings(root, () => {}, env);
      expect(s).toBeUndefined();
      expect(buildReflectRuntime(s, { workspaceRoot: root })).toBeUndefined();
    });
  });

  it("a reflect node is a KNOWN top-level key for the hooks loader (no unknown-key warning)", async () => {
    const warnings: string[] = [];
    await withSettings(
      JSON.stringify({ reflect: { lint: { command: "eslint ${file}" } } }),
      undefined,
      async (root, env) => {
        await loadHooksSettings(root, (m) => warnings.push(m), env);
        expect(warnings.filter((w) => w.includes("未知的顶层键已忽略"))).toEqual([]); // ω99-207 钉随源演进（未知键词面中文化，防漏网反向钉）
      },
    );
  });
});
