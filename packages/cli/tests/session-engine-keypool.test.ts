// 2026-08-31 minimax-401 弧 — the session's key pool must be a LIVE view
// over the one mutable config holder, not a boot-time snapshot.
//
// The bug this file pins: session-engine built ONE createKeyPool from the
// BOOT config and passed that same object into every client rebuilt at a
// /provider switch; adapters treat an explicit pool as authoritative
// (options.keyPool ?? own-config pool), so a kimi→minimax switch sent the
// BOOT provider's key to api.minimaxi.com → `401 login fail` on every
// retry. m63's seamFor substitutes scripted clients, so the REAL build
// seam's key identity was never asserted — this test drives the REAL
// engine seam (no modelOverride) and observes the pool through the same
// surface /status reads (`statusline.keys`, the pool object handed to the
// driver).
//
// Hermeticity: WUDAO_GLOBAL_HOME redirects the resolver's global home
// (credentials file, registry, settings) into a temp dir, so the switch
// deterministically resolves the TARGET's OWN saved key (the file leg —
// exactly the settings-page save that produced the reported 401). Without
// it, the resolver would borrow the boot pool (its documented fallback for
// a target with no own key) and the count would never move.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "@wudao/providers";
import { createDriverSession } from "../src/driver/session-engine.js";
import type { DriverSession } from "../src/driver/session-engine.js";

// Boot with TWO keys (a multi-key pool) — enough for a switch to make the
// count MOVE; an unreachable baseURL is fine, /provider never calls the
// model (construction is offline).
const bootConfig: ProviderConfig = {
  apiKey: "sk-boot-1",
  apiKeys: ["sk-boot-1", "sk-boot-2"],
  baseURL: "http://127.0.0.1:1/v1",
  model: "boot-model-x",
};

const sessions: DriverSession[] = [];
const roots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["WUDAO_GLOBAL_HOME", "WUDAO_API_KEY", "WUDAO_API_KEYS", "OPENAI_API_KEY"] as const;

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
    delete savedEnv[k];
  }
  for (const r of roots.splice(0)) {
    for (let i = 0; i < 10; i += 1) {
      try {
        rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
        await new Promise((res) => setTimeout(res, 50));
      }
    }
  }
});

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

/** The /status surface for the pool: { keys: { total, available, cooling } }. */
function keysTotal(session: DriverSession): number | undefined {
  const snap = session.driver.snapshotForStatusline() as { keys?: { total?: number } };
  return snap.keys?.total;
}

describe("session-engine key pool — live view over the config holder", () => {
  it("a /provider switch re-seats the pool on the TARGET's keys (boot snapshot cannot ride the switch)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "wudao-eng-keys-"));
    roots.push(ws);
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    // Hermetic global home: the target's saved key lives in OUR credentials
    // file, never the developer's real one.
    const home = mkdtempSync(join(tmpdir(), "wudao-eng-home-"));
    roots.push(home);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".credentials.yaml"), "deepseek: sk-target-file-key\n", "utf8");
    process.env.WUDAO_GLOBAL_HOME = home;
    delete process.env.WUDAO_API_KEY;
    delete process.env.WUDAO_API_KEYS;
    delete process.env.OPENAI_API_KEY;

    const session = await createDriverSession({
      config: bootConfig,
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      tools: [],
    });
    sessions.push(session);
    // Boot: the pool carries BOTH boot keys.
    expect(keysTotal(session)).toBe(2);

    session.driver.submit("/provider deepseek");
    await until(() => keysTotal(session) === 1, "the switch to re-seat the key pool on the target's keys");

    // The switch itself landed (not just the pool): the model moved off the
    // boot model and a provider_change row hit the session JSONL.
    expect(session.driver.getStatus().model).not.toBe("boot-model-x");
    const sessionId = session.driver.getSessionId();
    const file = join(ws, ".wudao", "sessions", `${sessionId}.jsonl`);
    // writeEntry lands asynchronously after the successful build — poll.
    await until(() => {
      if (!existsSync(file)) return false;
      const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type?: string });
      return rows.some((r) => r.type === "provider_change");
    }, "the provider_change row to hit the session JSONL");
    expect(existsSync(file)).toBe(true);
  });
});
