// 0.3.31 kimi-400 — the web engine's model overlay must boot from the
// RESOLVED live config. Symptom (0.3.30): fresh browser session, user
// picks kimi-code/k3-256k in the picker → the request hit api.deepseek.com
// with model k3-256k → 400 "The supported API model names are
// deepseek-v4-pro, …, but you passed k3-256k". Root cause: the driver
// seeds modelLive from opts.sessionMeta, which the session engine never
// passed — provider was undefined at boot, failing BOTH cross-provider
// guards open (the web picker's lane router AND resolveModelArgument's
// same-provider filter), and applyModelSelection then relabeled
// config.provider without moving baseURL/key/wire: the UI showed Kimi
// while the endpoint stayed deepseek. This pins the fix end to end: the
// seed (status.model carries the boot provider from turn one), the
// refusal (a cross-provider /model names the provider switch instead),
// and the wire (the next request keeps the boot model id).
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ProviderConfig } from "@wudao-org/providers";
import { createDriverSession } from "../src/driver/session-engine.js";
import { TITLE_SYSTEM_FIRST_LINE } from "../src/session-title.js";
import type { DriverSession } from "../src/driver/session-engine.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

/** A fake OpenAI-compatible endpoint that records every request BODY (the
 *  same recorder as session-engine-effort-wire: main-loop calls are
 *  discriminated from the title side-call by the title constant). */
function startBodyRecorder(): Promise<{ server: Server; url: string; bodies: Array<Record<string, unknown>> }> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => { raw += c.toString("utf8"); });
    req.on("end", () => {
      try { bodies.push(JSON.parse(raw) as Record<string, unknown>); } catch { /* non-JSON noise */ }
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
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/v1`, bodies });
    });
  });
}

const servers: Server[] = [];
const sessions: DriverSession[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  for (const s of servers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()));
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const noticesOf = (s: DriverSession): string[] =>
  s.driver.getHistory().filter((e) => e.kind === "notice").map((e) => e.text);

describe("session-engine — the model overlay boots from the live config (0.3.31 kimi-400)", () => {
  it("status.model carries the BOOT provider from turn one — the picker's lane router sees the truth", async () => {
    const fake = await startBodyRecorder();
    servers.push(fake.server);
    const ws = mkdtempSync(join(tmpdir(), "model-guard-"));
    roots.push(ws);
    const config: ProviderConfig = { apiKey: "test-key", baseURL: fake.url, model: "deepseek-v4-flash", provider: "deepseek" };
    const session = await createDriverSession({
      config,
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      tools: [],
      sessionId: "wudao-model-guard-0001",
      noPeer: true,
    });
    sessions.push(session);

    // Pre-fix this was null (the overlay never booted) — the web picker
    // then routed EVERY row through the /model lane, cross-provider ones
    // included.
    const model = session.driver.getStatus().model;
    expect(model?.provider).toBe("deepseek");
    expect(model?.label).toBe("deepseek-v4-flash");
  });

  it("/model k3-256k on a deepseek session is REFUSED and the wire keeps deepseek bytes (the 400 cannot recur)", async () => {
    const fake = await startBodyRecorder();
    servers.push(fake.server);
    const ws = mkdtempSync(join(tmpdir(), "model-guard-"));
    roots.push(ws);
    const config: ProviderConfig = { apiKey: "test-key", baseURL: fake.url, model: "deepseek-v4-flash", provider: "deepseek" };
    const session = await createDriverSession({
      config,
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      tools: [],
      sessionId: "wudao-model-guard-0002",
      noPeer: true,
    });
    sessions.push(session);

    // The exact 0.3.30 repro: a cross-provider name that the unseeded
    // guard admitted (sameProviderModels returned the FULL matrix).
    session.driver.submit("/model k3-256k");
    await until(
      () => noticesOf(session).some((t) => t.includes("unknown or cross-provider model \"k3-256k\"")),
      "the cross-provider refusal",
    );
    // No switch landed: no success notice, the overlay still names the
    // boot endpoint, and the NEXT main-loop request keeps the boot model.
    expect(noticesOf(session).some((t) => t.includes("模型 → kimi-code/k3-256k"))).toBe(false); // ω99-195: 钉随源演进
    expect(session.driver.getStatus().model?.provider).toBe("deepseek");

    session.driver.submit("hello");
    await until(
      () => session.driver.getHistory().some((e) => e.kind === "assistant" && e.text.includes("ok")),
      "the run replies",
    );
    const mainBodies = fake.bodies.filter(
      (b) => typeof b.messages === "object" && !JSON.stringify(b.messages).includes(TITLE_SYSTEM_FIRST_LINE),
    );
    expect(mainBodies.length).toBeGreaterThan(0);
    const last = mainBodies[mainBodies.length - 1] as Record<string, unknown>;
    expect(last["model"]).toBe("deepseek-v4-flash");
  });

  it("a same-provider /model mid-session SUCCEEDS — arbitrary in-session switching stays free (the picker's main lane)", async () => {
    const fake = await startBodyRecorder();
    servers.push(fake.server);
    const ws = mkdtempSync(join(tmpdir(), "model-guard-"));
    roots.push(ws);
    const config: ProviderConfig = { apiKey: "test-key", baseURL: fake.url, model: "deepseek-v4-flash", provider: "deepseek" };
    const session = await createDriverSession({
      config,
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      tools: [],
      sessionId: "wudao-model-guard-0003",
      noPeer: true,
    });
    sessions.push(session);

    session.driver.submit("/model deepseek-v4-pro");
    await until(() => noticesOf(session).some((t) => t.includes("模型 → deepseek/deepseek-v4-pro")), "the switch lands"); // ω99-195: 钉随源演进
    expect(session.driver.getStatus().model?.label).toBe("deepseek-v4-pro");

    session.driver.submit("hello");
    await until(
      () => session.driver.getHistory().some((e) => e.kind === "assistant" && e.text.includes("ok")),
      "the run replies",
    );
    const mainBodies = fake.bodies.filter(
      (b) => typeof b.messages === "object" && !JSON.stringify(b.messages).includes(TITLE_SYSTEM_FIRST_LINE),
    );
    expect(mainBodies.length).toBeGreaterThan(0);
    const last = mainBodies[mainBodies.length - 1] as Record<string, unknown>;
    expect(last["model"]).toBe("deepseek-v4-pro");
  });
});
