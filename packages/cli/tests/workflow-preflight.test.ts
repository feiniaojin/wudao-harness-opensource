// M56 §5 — route preflight (the upstream format fleet_preflight): everything that must
// be true for a spawn is checked AT ADMISSION, decided LOCALLY from
// configuration — no network probe (a preflight that hit the API would spend
// money and leak the run before the operator's gates were evaluated).
// Provider configured · model in profile · key present · budget remaining.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput } from "@wudao/core";
import { routePreflight } from "../src/workflow/preflight.js";
import { runScriptWorkflow, type JsflowOptions } from "../src/workflow/engine.js";
import { journalFilePath, openJournal } from "../src/workflow/journal.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wf-preflight-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** routePreflight resolves the credentials-file fallback from ITS env
 *  argument — the no-key lanes must point it at an empty home so an
 *  operator's real ~/.wudao/.credentials.yaml cannot flip the check. */
const CLEAN_ENV = (): NodeJS.ProcessEnv => ({ WUDAO_GLOBAL_HOME: join(root, "global-home") });

describe("routePreflight — admission checks (local, no model call)", () => {
  it("a configured route passes all four checks", () => {
    const r = routePreflight({ env: { WUDAO_API_KEY: "k" }, budgetRemaining: 10_000 });
    expect(r.ok).toBe(true);
    expect(r.refusals).toEqual([]);
    expect(r.checks.map((c) => `${c.id}:${c.ok ? "ok" : "refused"}`)).toEqual([
      "provider:ok", "key:ok", "model:ok", "budget:ok",
    ]);
    expect(r.model).toBe("deepseek-v4-flash");
    expect(r.provider).toBe("deepseek");
  });

  it("no key refuses fast with the missing-credential reason", () => {
    const r = routePreflight({ env: CLEAN_ENV(), budgetRemaining: 10_000 });
    expect(r.ok).toBe(false);
    expect(r.refusals.some((x) => x.includes("no API key"))).toBe(true);
  });

  it("a multi-key pool satisfies the key check (WUDAO_API_KEYS)", () => {
    const r = routePreflight({ env: { WUDAO_API_KEYS: "k1,k2" }, budgetRemaining: 10_000 });
    const key = r.checks.find((c) => c.id === "key");
    expect(key?.ok).toBe(true);
    expect(key?.detail).toContain("2");
  });

  it("an unknown provider name refuses (resolve throws are caught, not crashes)", () => {
    const r = routePreflight({ env: { WUDAO_API_KEY: "k" }, selection: { provider: "nope" }, budgetRemaining: 10 });
    expect(r.ok).toBe(false);
    expect(r.refusals.some((x) => x.includes("unknown provider"))).toBe(true);
  });

  it("a model outside the provider's profile set refuses with the switchable list", () => {
    const r = routePreflight({ env: { WUDAO_API_KEY: "k" }, model: "not-a-real-model", budgetRemaining: 10_000 });
    expect(r.ok).toBe(false);
    expect(r.refusals.some((x) => x.includes("not-a-real-model") && x.includes("deepseek-v4-flash"))).toBe(true);
  });

  it("an env-configured model (WUDAO_MODEL) passes — it is what the run would use", () => {
    const r = routePreflight({ env: { WUDAO_API_KEY: "k", WUDAO_MODEL: "custom-tuned" }, budgetRemaining: 10_000 });
    expect(r.ok).toBe(true);
    expect(r.model).toBe("custom-tuned");
  });

  it("an exhausted budget refuses before any spend", () => {
    const r = routePreflight({ env: { WUDAO_API_KEY: "k" }, budgetRemaining: 0 });
    expect(r.ok).toBe(false);
    expect(r.refusals.some((x) => x.includes("budget exhausted"))).toBe(true);
  });

  it("the wudao profile without WUDAO_BASE_URL refuses (provider check)", () => {
    const r = routePreflight({ env: { WUDAO_API_KEY: "k", WUDAO_PROVIDER: "wudao" }, budgetRemaining: 10_000 });
    expect(r.ok).toBe(false);
    expect(r.refusals.some((x) => x.includes("WUDAO_BASE_URL"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Engine admission: a refused route fails the task BEFORE any model call.
// ---------------------------------------------------------------------------
describe("engine preflight gate", () => {
  const say = (content: string): AssistantMessage => ({ role: "assistant", content });
  const countingModel = (): { client: ModelClient; calls: number } => {
    let calls = 0;
    return {
      get calls() { return calls; },
      client: {
        async generate(input: ModelInput): Promise<AssistantMessage> {
          calls += 1;
          input.onUsage?.({ promptTokens: 100, cacheHitTokens: 0, cacheMissTokens: 100, completionTokens: 20 });
          return say("never reached");
        },
      },
    };
  };

  const opts = (model: ModelClient, preflight: JsflowOptions["preflight"]): JsflowOptions => ({
    workspaceRoot: root,
    model,
    journal: openJournal(journalFilePath(root, `wf-pf-${Math.random().toString(16).slice(2, 8)}`)),
    workflowName: "preflight-gate",
    preflight,
  });

  it("a refused route fails the task with preflight-refused and ZERO model calls", async () => {
    const model = countingModel();
    const result = await runScriptWorkflow(
      "const a = await task('do it');\nreturn [a.ok, a.failure.category];",
      opts(model.client, () => "key: no API key present (WUDAO_API_KEY / WUDAO_API_KEYS)"),
    );
    expect(model.calls).toBe(0);
    expect(result.returnValue).toEqual([false, "preflight-refused"]);
    expect(result.tasksOk).toBe(0);
  });

  it("an admitting preflight lets the task run normally", async () => {
    const model = countingModel();
    const result = await runScriptWorkflow(
      "const a = await task('do it');\nreturn a.ok;",
      opts(model.client, () => undefined),
    );
    expect(model.calls).toBe(1);
    expect(result.returnValue).toBe(true);
  });

  it("budget exhaustion at spawn stays the engine's FATAL budget-exhausted (not a per-task refusal)", async () => {
    // The per-spawn gate never carries the budget check — a script whose
    // budget runs out mid-run must fail the RUN, not degrade into per-task
    // refusals the script survives.
    const model = countingModel();
    const result = await runScriptWorkflow(
      "for (let i = 0; i < 2; i++) { await task('t' + i); }\nreturn 1;",
      { ...opts(model.client, () => undefined), budgetTokens: 1 },
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.category).toBe("budget-exhausted");
  });
});
