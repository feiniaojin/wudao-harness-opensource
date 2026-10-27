import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadLongTaskSettings,
  resolveLongTaskRuntime,
  DEFAULT_LONG_TASK,
} from "../src/long-task-config.js";

const ENV_KEYS = ["WUDAO_MAX_TURNS", "WUDAO_LONG_TASK_GATES"] as const;

async function withSettings(json: string | undefined, fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "lt-config-"));
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
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

describe("loadLongTaskSettings", () => {
  it("defaults when no settings file exists", async () => {
    await withSettings(undefined, async (root) => {
      expect(await loadLongTaskSettings(root)).toEqual(DEFAULT_LONG_TASK);
    });
  });

  it("reads the longTask node with per-field overrides", async () => {
    await withSettings(
      JSON.stringify({ longTask: { todoGate: false, gateMaxInsists: 5, maxTurnsFuse: 300 } }),
      async (root) => {
        expect(await loadLongTaskSettings(root)).toEqual({
          todoGate: false, verifyGate: true, gateMaxInsists: 5, maxTurnsFuse: 300,
        });
      },
    );
  });

  it("missing longTask node → defaults", async () => {
    await withSettings(JSON.stringify({ hooks: {} }), async (root) => {
      expect(await loadLongTaskSettings(root)).toEqual(DEFAULT_LONG_TASK);
    });
  });

  it("malformed JSON → warning + defaults (never throws)", async () => {
    const warnings: string[] = [];
    await withSettings("{not json", async (root) => {
      expect(await loadLongTaskSettings(root, (m) => warnings.push(m))).toEqual(DEFAULT_LONG_TASK);
      // M57: the two-tier reader owns JSON validation — the tier-tagged
      // warning names the file; the loader degrades to defaults silently.
      expect(warnings.join("\n")).toMatch(/不是合法的 JSON/); // ω99-207 钉随源演进（JSON 校验词面中文化；census 漏网披露同弧演进）
      expect(warnings.join("\n")).toMatch(/project settings 已忽略/); // ω99-207 钉随源演进（忽略语态中文化）
    });
  });

  it("wrong-typed fields warn and fall back per-field", async () => {
    const warnings: string[] = [];
    await withSettings(
      JSON.stringify({ longTask: { todoGate: "nope", gateMaxInsists: -1, maxTurnsFuse: "big" } }),
      async (root) => {
        const s = await loadLongTaskSettings(root, (m) => warnings.push(m));
        expect(s.todoGate).toBe(true); // rejected → default
        expect(s.gateMaxInsists).toBe(3);
        expect(s.maxTurnsFuse).toBe(200);
        expect(warnings.length).toBeGreaterThan(0);
      },
    );
  });

  it("unknown keys inside longTask are ignored with a warning", async () => {
    const warnings: string[] = [];
    await withSettings(JSON.stringify({ longTask: { mystery: 1 } }), async (root) => {
      const s = await loadLongTaskSettings(root, (m) => warnings.push(m));
      expect(s).toEqual(DEFAULT_LONG_TASK);
      expect(warnings.join("\n")).toMatch(/mystery/);
    });
  });
});

describe("resolveLongTaskRuntime", () => {
  it("maps settings to loop gates + fuse turns", () => {
    const rt = resolveLongTaskRuntime({ todoGate: false, verifyGate: true, gateMaxInsists: 7, maxTurnsFuse: 120 }, {});
    expect(rt.gates).toEqual({ todo: false, verify: true, maxInsists: 7 });
    expect(rt.maxTurns).toBe(120);
  });

  it("defaults: both gates on, maxInsists 3, 200 turns", () => {
    const rt = resolveLongTaskRuntime(DEFAULT_LONG_TASK, {});
    expect(rt.gates).toEqual({ todo: true, verify: true, maxInsists: 3 });
    expect(rt.maxTurns).toBe(200);
  });

  it("WUDAO_MAX_TURNS overrides the fuse; 0 means unlimited", () => {
    expect(resolveLongTaskRuntime(DEFAULT_LONG_TASK, { WUDAO_MAX_TURNS: "50" }).maxTurns).toBe(50);
    expect(resolveLongTaskRuntime(DEFAULT_LONG_TASK, { WUDAO_MAX_TURNS: "0" }).maxTurns).toBe(Infinity);
  });

  it("a non-numeric WUDAO_MAX_TURNS is ignored", () => {
    expect(resolveLongTaskRuntime(DEFAULT_LONG_TASK, { WUDAO_MAX_TURNS: "banana" }).maxTurns).toBe(200);
  });

  it("WUDAO_LONG_TASK_GATES=off kills both gates (panic switch)", () => {
    const rt = resolveLongTaskRuntime(DEFAULT_LONG_TASK, { WUDAO_LONG_TASK_GATES: "off" });
    expect(rt.gates).toEqual({ todo: false, verify: false, maxInsists: 3 });
    expect(rt.maxTurns).toBe(200);
  });
});

describe("longTask node coexists with hooks in settings.json", () => {
  it("loading hooks does not warn about the longTask top-level key", async () => {
    const { loadHooksSettings } = await import("../src/hooks-config.js");
    const warnings: string[] = [];
    await withSettings(JSON.stringify({ hooks: {}, longTask: { gateMaxInsists: 2 } }), async (root) => {
      await loadHooksSettings(root, (m) => warnings.push(m));
      expect(warnings).toEqual([]);
    });
  });
});
