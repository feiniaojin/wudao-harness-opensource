// M80 fix-round I1 — construction-point pins for the resolver attachment
// threading. The batch's own bug class was "a construction site forgot to
// pass attachments", and the scoped review found the four threading sites
// had no DIRECT test: an end-to-end image flow passes through any ONE of
// them, so a site-specific regression (one lost `attachments` param) would
// not turn any existing test red.
//
// Each test below drives ONE construction site and asserts the resolver it
// builds received an AttachmentResolver (shape-pinned: a `resolveDataUrl`
// function) — the most direct seam available, since every site is
// `createProviderModelResolver({ ..., attachments })`:
//   · driver    createDriverSession (session-engine.ts)
//   · TUI       WudaoApp's resolveModel useMemo (tui/app.tsx)
//   · REPL      main()'s --no-tui branch (index.ts)
//   · one-shot  main() → runReal (index.ts)
// Removing a site's `attachments` argument makes exactly its test fail
// (opts.attachments becomes undefined); the other three stay green — that is
// the per-site discrimination the fix round asked for.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdin } from "node:process";
import { createScriptedModel } from "@wudao/core";
import type { ModelClient } from "@wudao/core";
import type { ProviderConfig } from "@wudao/providers";
import { WudaoApp } from "../src/tui/app.js";
import { createDriverSession } from "../src/driver/session-engine.js";
import type { DriverSession } from "../src/driver/session-engine.js";
import { resetProviderRegistryCacheForTests } from "../src/provider-registry.js";

const wait = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait(25);
  }
}

// The recorder: every createProviderModelResolver construction site's opts.
const { resolverOpts } = vi.hoisted(() => ({
  resolverOpts: [] as Array<Record<string, unknown>>,
}));

vi.mock("../src/agents/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/index.js")>();
  return {
    ...actual,
    createProviderModelResolver: (opts: Record<string, unknown>) => {
      resolverOpts.push(opts);
      return actual.createProviderModelResolver(opts);
    },
  };
});

// The REPL site's terminal call — mocked so main()'s --no-tui branch runs
// its real construction sequence and returns cleanly.
vi.mock("../src/repl.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/repl.js")>();
  return { ...actual, runRepl: async () => undefined };
});

// The one-shot site has no modelOverride seam — its provider IS
// createProvider(config, ...). Wrap it with a scripted model so runReal
// completes one clean turn with zero network. (The driver/TUI tests pass
// modelOverride, so they never reach this wrapper.)
vi.mock("@wudao/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wudao/providers")>();
  return {
    ...actual,
    createProvider: (_config: ProviderConfig, _options?: unknown): ModelClient =>
      createScriptedModel([{ role: "assistant", content: "wired" }]),
  };
});

const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };

/** The threading pin: the site's construction received an
 *  AttachmentResolver-shaped `attachments` (deleting the site's threading
 *  argument turns this red — undefined has no resolveDataUrl). */
const expectAttachmentResolver = (opts: Record<string, unknown> | undefined): void => {
  expect(opts).toBeDefined();
  const attachments = opts!.attachments as { resolveDataUrl?: unknown } | undefined;
  expect(typeof attachments?.resolveDataUrl).toBe("function");
};

const sessions: DriverSession[] = [];
const roots: string[] = [];
let home: string;
let origCwd: string;
let origArgv: string[];
let origIsTTY: boolean | undefined;
const savedEnv: Record<string, string | undefined> = {};
const touchedEnv = [
  "WUDAO_API_KEY", "WUDAO_API_KEYS", "OPENAI_API_KEY", "DEEPSEEK_API_KEY",
  "WUDAO_PROVIDER", "WUDAO_BASE_URL", "WUDAO_MODEL", "OPENAI_MODEL",
  "WUDAO_GLOBAL_HOME",
] as const;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "m80-wire-home-"));
  origCwd = process.cwd();
  origArgv = [...process.argv];
  origIsTTY = (stdin as { isTTY?: boolean }).isTTY;
  for (const k of touchedEnv) {
    savedEnv[k] = process.env[k];
    if (k !== "WUDAO_GLOBAL_HOME") delete process.env[k];
  }
  process.env.WUDAO_GLOBAL_HOME = home; // hermetic persona/credentials/registry reads
  process.env.WUDAO_API_KEY = "test-key"; // a valid plan: no no-key early returns
  // Non-TTY stdin by default: the --no-tui REPL branch is selected by flag,
  // and a stray TUI branch can never attach Ink to the worker's real stdin.
  Object.defineProperty(stdin, "isTTY", { value: false, configurable: true });
  resolverOpts.length = 0;
  resetProviderRegistryCacheForTests();
});

afterEach(async () => {
  process.chdir(origCwd);
  process.argv = origArgv;
  for (const k of touchedEnv) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  Object.defineProperty(stdin, "isTTY", { value: origIsTTY, configurable: true });
  vi.restoreAllMocks();
  resetProviderRegistryCacheForTests();
  for (const s of sessions.splice(0)) await s.close().catch(() => {});
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("M80 fix-round I1 — resolver construction sites pass attachments", () => {
  it("driver: createDriverSession builds its resolver WITH the session's attachment store", async () => {
    const ws = mkdtempSync(join(tmpdir(), "m80-wire-eng-"));
    roots.push(ws);
    const session = await createDriverSession({
      config,
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      modelOverride: createScriptedModel([{ role: "assistant", content: "ok" }]),
      sessionId: "m80-wire-engine",
    });
    sessions.push(session);
    expect(resolverOpts).toHaveLength(1);
    expectAttachmentResolver(resolverOpts[0]);
  });

  it("TUI: WudaoApp's resolveModel useMemo builds WITH the session's attachment store", async () => {
    const ws = mkdtempSync(join(tmpdir(), "m80-wire-tui-"));
    roots.push(ws);
    const inst = render(
      createElement(WudaoApp, {
        config,
        workspaceRoot: ws,
        contextWindowTokens: 64_000,
        modelOverride: createScriptedModel([{ role: "assistant", content: "ok" }]),
        tools: [],
      }),
    );
    await wait();
    expect(resolverOpts).toHaveLength(1);
    expectAttachmentResolver(resolverOpts[0]);
    inst.unmount();
  });

  it("REPL: main()'s --no-tui branch builds its resolver WITH the workspace attachment store", async () => {
    const ws = mkdtempSync(join(tmpdir(), "m80-wire-repl-"));
    roots.push(ws);
    process.chdir(ws); // empty workspace: no .env, no settings, no sessions
    process.argv = [origArgv[0]!, "wudao", "--no-tui"];
    vi.resetModules();
    await import("../src/index.js"); // module eval boots main() under our argv/env
    await until(() => resolverOpts.length > 0, "the REPL resolver construction");
    expect(resolverOpts).toHaveLength(1);
    expectAttachmentResolver(resolverOpts[0]);
    await wait(100); // let the mocked-runRepl return path finish its cleanup
  }, 30000);

  it("one-shot: main()'s prompt branch (runReal) builds its resolver WITH the session attachment store", async () => {
    const ws = mkdtempSync(join(tmpdir(), "m80-wire-1shot-"));
    roots.push(ws);
    process.chdir(ws);
    process.argv = [origArgv[0]!, "wudao", "resolver wiring probe"];
    vi.resetModules();
    await import("../src/index.js");
    await until(() => resolverOpts.length > 0, "the one-shot resolver construction");
    expect(resolverOpts).toHaveLength(1);
    expectAttachmentResolver(resolverOpts[0]);
    await wait(200); // scripted one-turn runReal completes; cleanups flush
  }, 30000);
});
