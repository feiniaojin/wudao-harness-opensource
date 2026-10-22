// 推理档三级配置 + 语言 chip S4 (spec
// docs/superpowers/specs/2026-08-28-effort-tiering-language-chip-design.md
// §2/§4) — the cli language SESSION lane: /language + languageLive +
// gateStatus. The 双旋钮 already fold settings/env at boot (S3's
// resolveLanguagePreference) and the per-submit seam (夜移 012) reads env;
// S4 homes ONE mutable session tier in the driver (modelLive's twin):
// /language mutates it, the seam re-folds it EVERY submit
// (resolveLanguagePreference(env, undefined, languageLive) — ablation stays
// live-checked, session > env by construction), and the session-effective
// pair surfaces on getStatus() and — via withSettingsOps — the
// settingsStatus payload the web's gateStatus reads (spec §4's `language`).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDriverSession } from "../src/driver/session-engine.js";
import type { DriverSession } from "../src/driver/session-engine.js";
import { createScriptedModel } from "@wudao/core";
import type { ModelClient, ModelInput } from "@wudao/core";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver, AgentDriverOptions } from "../src/driver/agent-driver.js";
import { withSettingsOps } from "../src/driver/settings-ops.js";
import { parseReplCommand } from "../src/repl.js";
import { summarizeToolCall } from "../src/log.js";
import { resolveLanguageArgument } from "../src/language.js";
import { LANGUAGE_BLOCK_ZH, REASONING_BLOCK_ZH, REASONING_BLOCK_EN } from "../src/language.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

// Pin the env legs so the developer machine's WUDAO_* can't leak into the
// resolution under test (every leg below reads process.env).
const ENV_KEYS = ["WUDAO_LANGUAGE_BLOCK", "WUDAO_REASONING_LANGUAGE", "WUDAO_NO_LANGUAGE", "WUDAO_GLOBAL_HOME", "WUDAO_REASONING_EFFORT"] as const;
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** A scripted model that records every ModelInput (the language blocks ride
 *  state.messages — asserted off the recorded input, not the history). */
function recordingDriver(opts: Partial<AgentDriverOptions> = {}): { driver: AgentDriver; inputs: ModelInput[] } {
  const scripted = createScriptedModel([{ role: "assistant", content: "ok" }]);
  const inputs: ModelInput[] = [];
  const model: ModelClient = {
    async generate(input: ModelInput) {
      inputs.push(input);
      return scripted.generate(input);
    },
  };
  const driver = createAgentDriver({ systemPrompt: "s", summarize: summarizeToolCall, model, tools: [], ...opts });
  return { driver, inputs };
}

/** Submits a /language line and waits for its notice (commands never hit the
 *  model — the notice IS the effect's receipt). */
async function runNotice(driver: AgentDriver, line: string): Promise<string> {
  const before = driver.getHistory().filter((e) => e.kind === "notice").length;
  driver.submit(line);
  await until(() => driver.getHistory().filter((e) => e.kind === "notice").length > before, `notice for ${line}`);
  const notices = driver.getHistory().filter((e) => e.kind === "notice");
  return notices[notices.length - 1]?.text ?? "";
}

/** Runs one plain turn and waits for its assistant reply. */
async function runTurn(driver: AgentDriver, text: string): Promise<void> {
  driver.submit(text);
  await until(() => driver.getHistory().some((e) => e.kind === "assistant"), "the turn settles");
}

const userTexts = (input: ModelInput): string[] =>
  input.messages.filter((m) => m.role === "user" && typeof m.content === "string").map((m) => (m as { content: string }).content);

// ---------------------------------------------------------------------------
// The pure argument parser (language.ts — the /permissions `args` grammar's
// twin): `reply auto|on|off` / `reasoning auto|zh|en|off`, one knob per call.
// ---------------------------------------------------------------------------
describe("S4 — resolveLanguageArgument", () => {
  it("parses each knob's levels; refuses junk visibly", () => {
    expect(resolveLanguageArgument("reply on")).toEqual({ ok: true, pref: { reply: "on" } });
    expect(resolveLanguageArgument("reply off")).toEqual({ ok: true, pref: { reply: "off" } });
    expect(resolveLanguageArgument("reply auto")).toEqual({ ok: true, pref: { reply: "auto" } });
    expect(resolveLanguageArgument("reasoning auto")).toEqual({ ok: true, pref: { reasoning: "auto" } });
    expect(resolveLanguageArgument("reasoning zh")).toEqual({ ok: true, pref: { reasoning: "zh" } });
    expect(resolveLanguageArgument("reasoning en")).toEqual({ ok: true, pref: { reasoning: "en" } });
    expect(resolveLanguageArgument("reasoning off")).toEqual({ ok: true, pref: { reasoning: "off" } });
    for (const bad of ["", "reply", "reply maybe", "answer on", "reasoning fr", "reply on extra"]) {
      const v = resolveLanguageArgument(bad);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.error).toContain("用法："); // ω99-166d-i: 泛 usage 钉演进（#36 头换）
    }
  });
});

// ---------------------------------------------------------------------------
// The shared parse (both frontends route through it).
// ---------------------------------------------------------------------------
describe("S4 — parseReplCommand /language", () => {
  it("parses /language [args]; /languagex stays a prompt (prefix-neighbor discipline)", () => {
    expect(parseReplCommand("/language")).toEqual({ kind: "language", args: "" });
    expect(parseReplCommand("/language reply on")).toEqual({ kind: "language", args: "reply on" });
    expect(parseReplCommand("/language reasoning zh")).toEqual({ kind: "language", args: "reasoning zh" });
    expect(parseReplCommand("/languagex hi").kind).toBe("prompt");
    expect(parseReplCommand("怎么切换语言").kind).toBe("prompt");
  });
});

// ---------------------------------------------------------------------------
// The driver's /language lane (the web path — the driver's own router).
// ---------------------------------------------------------------------------
describe("S4 — the driver's /language lane", () => {
  it("bare /language is the status notice (both knobs); a bad argument is refused visibly", async () => {
    const { driver } = recordingDriver();
    const status = await runNotice(driver, "/language");
    expect(status).toContain("reply");
    expect(status).toContain("reasoning");
    expect(status).toContain("auto");
    const bad = await runNotice(driver, "/language reply maybe");
    expect(bad).toContain("⚠️");
    driver.dispose();
  });

  it("/language reply on → the NEXT submit appends the reply block (English prompt: auto stays quiet)", async () => {
    const { driver, inputs } = recordingDriver();
    await runTurn(driver, "hello world"); // control: English + auto ⇒ no block
    expect(userTexts(inputs[inputs.length - 1])).not.toContain(LANGUAGE_BLOCK_ZH);
    await runNotice(driver, "/language reply on");
    await runTurn(driver, "hello again");
    expect(userTexts(inputs[inputs.length - 1])).toContain(LANGUAGE_BLOCK_ZH);
    driver.dispose();
  });

  it("/language reasoning zh → the reasoning block rides the same turn tail", async () => {
    const { driver, inputs } = recordingDriver();
    await runNotice(driver, "/language reasoning zh");
    await runTurn(driver, "plain english prompt");
    expect(userTexts(inputs[inputs.length - 1])).toContain(REASONING_BLOCK_ZH);
    driver.dispose();
  });

  it("/language reasoning en forces the English thinking directive", async () => {
    const { driver, inputs } = recordingDriver();
    await runNotice(driver, "/language reasoning en");
    await runTurn(driver, "another english prompt");
    expect(userTexts(inputs[inputs.length - 1])).toContain(REASONING_BLOCK_EN);
    driver.dispose();
  });

  it("/language reply off on a fresh session: no block ever lands", async () => {
    const { driver, inputs } = recordingDriver();
    await runNotice(driver, "/language reply off");
    await runTurn(driver, "你好世界"); // Chinese prompt: auto would emit — off kills it
    expect(userTexts(inputs[inputs.length - 1])).not.toContain(LANGUAGE_BLOCK_ZH);
    driver.dispose();
  });

  it("the session lane WINS over the env tier (spec chain: session > env)", async () => {
    process.env.WUDAO_LANGUAGE_BLOCK = "off";
    const { driver, inputs } = recordingDriver();
    await runNotice(driver, "/language reply on");
    await runTurn(driver, "english prompt");
    expect(userTexts(inputs[inputs.length - 1])).toContain(LANGUAGE_BLOCK_ZH);
    driver.dispose();
  });

  it("WUDAO_NO_LANGUAGE=1 ablation stays live: it kills the boot seed AND a later /language", async () => {
    process.env.WUDAO_NO_LANGUAGE = "1";
    const { driver, inputs } = recordingDriver({ languagePreference: { reply: "on", reasoning: "zh" } });
    await runTurn(driver, "english prompt");
    expect(userTexts(inputs[inputs.length - 1])).not.toContain(LANGUAGE_BLOCK_ZH);
    expect(userTexts(inputs[inputs.length - 1])).not.toContain(REASONING_BLOCK_ZH);
    await runNotice(driver, "/language reply on");
    await runTurn(driver, "another english prompt");
    expect(userTexts(inputs[inputs.length - 1])).not.toContain(LANGUAGE_BLOCK_ZH);
    driver.dispose();
  });

  it("the opts override (tests/embedders) still WINS over the session lane", async () => {
    const { driver, inputs } = recordingDriver({ languageBlock: "off" });
    await runNotice(driver, "/language reply on");
    await runTurn(driver, "english prompt");
    expect(userTexts(inputs[inputs.length - 1])).not.toContain(LANGUAGE_BLOCK_ZH);
    driver.dispose();
  });

  it("boot seed via opts.languagePreference: the first turn already carries the fold", async () => {
    const { driver, inputs } = recordingDriver({ languagePreference: { reply: "on", reasoning: "off" } });
    await runTurn(driver, "english prompt");
    expect(userTexts(inputs[inputs.length - 1])).toContain(LANGUAGE_BLOCK_ZH);
    expect(userTexts(inputs[inputs.length - 1])).not.toContain(REASONING_BLOCK_ZH);
    driver.dispose();
  });

  it("getStatus().language is the session-effective fold (env leg visible until /language overrides it)", async () => {
    const { driver } = recordingDriver();
    expect(driver.getStatus().language).toEqual({ reply: "auto", reasoning: "auto" });
    process.env.WUDAO_REASONING_LANGUAGE = "zh";
    expect(driver.getStatus().language).toEqual({ reply: "auto", reasoning: "zh" });
    await runNotice(driver, "/language reply on");
    expect(driver.getStatus().language).toEqual({ reply: "on", reasoning: "zh" }); // session > env
    driver.dispose();
  });
});

// ---------------------------------------------------------------------------
// gateStatus: the settingsStatus payload (what the web's gateStatus reads)
// gains the session-effective `language` pair via the withSettingsOps mount.
// S5: the SAME overlay carries the session-effective EFFORT (current.effort
// was env-only — the web's 强度 chip and its 设为默认 footer read it, so a
// mid-session /effort must surface).
// ---------------------------------------------------------------------------
describe("S4 — withSettingsOps overlays session language onto settingsStatus", () => {
  it("settingsStatus().language mirrors the live fold and follows setLanguage", async () => {
    const home = mkdtempSync(join(tmpdir(), "lang-s4-home-"));
    const ws = mkdtempSync(join(tmpdir(), "lang-s4-ws-"));
    try {
      const { driver } = recordingDriver();
      const port = withSettingsOps(driver, { env: { WUDAO_GLOBAL_HOME: home }, workspaceRoot: ws });
      const status = await port.settingsStatus();
      expect(status.language).toEqual({ reply: "auto", reasoning: "auto" });
      driver.setLanguage({ reply: "on" });
      const status2 = await port.settingsStatus();
      expect(status2.language).toEqual({ reply: "on", reasoning: "auto" });
      driver.dispose();
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("S5: current.effort follows a mid-session /effort pick (the overlay, not the env tier)", async () => {
    const home = mkdtempSync(join(tmpdir(), "lang-s4-home-"));
    const ws = mkdtempSync(join(tmpdir(), "lang-s4-ws-"));
    try {
      const { driver } = recordingDriver();
      // The effort env leg rides the DEPS env (the ops' own override object
      // shadows process.env — the seam the settingsStatus base reads).
      const port = withSettingsOps(driver, {
        env: { WUDAO_GLOBAL_HOME: home, WUDAO_REASONING_EFFORT: "low" },
        workspaceRoot: ws,
      });
      const before = await port.settingsStatus();
      expect(before.current.effort).toBe("low"); // the env/boot tier reads through
      await runNotice(driver, "/effort high");
      const after = await port.settingsStatus();
      expect(after.current.effort).toBe("high"); // the SESSION tier wins on the wire
      driver.dispose();
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

// ---------------------------------------------------------------------------
// The engine wire: boot reads the settings `language` node (S3's fold) and
// the FIRST main-loop request already carries the blocks. (The HTTP recorder
// harness mirrors session-engine-effort-wire.test.ts.)
// ---------------------------------------------------------------------------
describe("S4 — session-engine boot folds the settings language node onto the wire", () => {
  it("language.reply=on + language.reasoning=zh in settings → the first request carries both blocks", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const server: Server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => { raw += c.toString("utf8"); });
      req.on("end", () => {
        try { bodies.push(JSON.parse(raw) as Record<string, unknown>); } catch { /* noise */ }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          [
            `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: null }] })}`,
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
            `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })}`,
            "data: [DONE]",
            "",
          ].join("\n\n"),
        );
      });
    });
    const started = new Promise<{ url: string }>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        resolve({ url: `http://127.0.0.1:${port}/v1` });
      });
    });
    const fake = await started;

    const home = mkdtempSync(join(tmpdir(), "lang-s4-eng-home-"));
    const ws = mkdtempSync(join(tmpdir(), "lang-s4-eng-ws-"));
    process.env.WUDAO_GLOBAL_HOME = home;
    writeFileSync(join(home, "settings.json"), JSON.stringify({ language: { reply: "on", reasoning: "zh" } }), "utf8");
    let session: DriverSession | null = null;
    try {
      session = await createDriverSession({
        config: { apiKey: "test-key", baseURL: fake.url, model: "wire-model", provider: "deepseek" },
        workspaceRoot: ws,
        contextWindowTokens: 64_000,
        tools: [],
        sessionId: "wudao-lang-s4-0001",
        noPeer: true,
      });
      session.driver.submit("plain english prompt");
      await until(() => session!.driver.getHistory().some((e) => e.kind === "assistant"), "the engine run replies");
      const flat = bodies.map((b) => JSON.stringify(b.messages ?? []));
      const main = flat.filter((s) => s.length > 0);
      expect(main.length).toBeGreaterThan(0);
      expect(main.some((s) => s.includes(LANGUAGE_BLOCK_ZH))).toBe(true);
      expect(main.some((s) => s.includes(REASONING_BLOCK_ZH))).toBe(true);
    } finally {
      await session?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
