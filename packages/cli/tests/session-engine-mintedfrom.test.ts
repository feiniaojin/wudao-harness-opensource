// ω-5a queued minor (40/93) — the session-engine mintedFrom RUNTIME pin.
// The provider-switch `build` seam (session-engine.ts) is the only site that
// hands a replacement cache-tracking wrapper its predecessor's window id
// (`mintedFrom: predecessorWindowId`), which is what makes the switch land a
// context_window entry instead of the old window id dying silently. Until
// now only a hand-replica unit test pinned the wrapper behavior
// (cache-window.test.ts builds the replacement wrapper itself) — deleting
// the session-engine wiring line kept the whole suite green. This test goes
// through createDriverSession END-TO-END (no modelOverride, so the real
// onProviderSwitch seam is wired): a local OpenAI-compatible SSE endpoint
// stands in for the provider, /provider switches mid-session, the next run's
// first usage row fires the synthetic advance, and the session's JSONL must
// carry exactly ONE context_window entry with advancedFrom and NO
// divergedAt. Drop the wiring line → no synthetic advance → zero entries →
// this test goes red.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ProviderConfig } from "@wudao-org/providers";
import { resetProviderRegistryCacheForTests } from "../src/provider-registry.js";
import { createDriverSession } from "../src/driver/session-engine.js";
import { TITLE_SYSTEM_FIRST_LINE } from "../src/session-title.js";
import type { DriverSession } from "../src/driver/session-engine.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

/** A minimal OpenAI-compatible streaming endpoint: one content delta, a
 *  finish_reason chunk, and the usage-only trailing chunk
 *  (stream_options.include_usage) that makes the wrapper observe a usage
 *  row — the trigger for the synthetic advance. */
function startFakeProvider(): Promise<{ server: Server; url: string; requests: number }> {
  // 夜移 005: `requests` counts MAIN-LOOP calls only — the session's
  // auto-title side-call (discriminated by its standalone system prompt's
  // first line; querySource never serializes) is not counted.
  const requests = { n: 0 };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString("utf8"); });
    req.on("end", () => {
      if (!body.includes(TITLE_SYSTEM_FIRST_LINE)) requests.n += 1;
    });
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
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/v1`, get requests() { return requests.n; } });
    });
  });
}

interface ContextWindowLine {
  readonly type: string;
  readonly data: { readonly id: string; readonly advancedFrom?: string; readonly divergedAt?: string };
}

const sessions: DriverSession[] = [];
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  // win32: a just-closed session's handle can linger a few ms — the rmdir
  // races EPERM. Retry briefly before surfacing.
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
  for (const s of servers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()));
});

describe("ω-5a follow-up — createDriverSession provider-switch mintedFrom runtime pin", () => {
  it("a mid-session /provider rebuild continues the window chain: ONE context_window entry with advancedFrom, no divergedAt", async () => {
    const fake = await startFakeProvider();
    servers.push(fake.server);
    // 0.3.31b: at a mid-session switch the TARGET profile's endpoint outranks
    // WUDAO_BASE_URL (the env-first order was the kimi-404 bug), so pinning
    // the fake endpoint via env no longer holds the switch on it. The test
    // pins it the way the new rule reads: a REGISTRY overlay on glm whose
    // baseUrl is the fake server (registrySupplied — the overlay IS the
    // target's endpoint truth). The live pool supplies the key.
    writeFileSync(
      join(process.env.WUDAO_GLOBAL_HOME as string, "providers.json"),
      JSON.stringify({ version: 1, providers: { glm: { baseUrl: fake.url } } }, null, 2),
      "utf8",
    );
    resetProviderRegistryCacheForTests();

    const ws = mkdtempSync(join(tmpdir(), "mintedfrom-"));
    roots.push(ws);
    const sessionId = "wudao-mintedfrom-0001";
    const config: ProviderConfig = { apiKey: "test-key", baseURL: fake.url, model: "boot-model", provider: "deepseek" };

    // NO modelOverride — the real provider path AND the real onProviderSwitch
    // seam (the wiring under test) are both live.
    const session = await createDriverSession({
      config,
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      tools: [],
      sessionId,
      noPeer: true, // tests own their sockets — no peer surface
    });
    sessions.push(session);

    // The switch: resolves through the engine's seam, builds the replacement
    // wrapper with the predecessor's window id, lands the provider_change.
    session.driver.submit("/provider glm");
    await until(() => session.driver.getStatus().model?.provider === "glm", "provider switched");

    // The next run's FIRST observed row fires the synthetic advance → the
    // context_window entry lands on the session JSONL (async append).
    session.driver.submit("hello");
    const file = join(ws, ".wudao", "sessions", `${sessionId}.jsonl`);
    await until(() => existsSync(file) && readFileSync(file, "utf8").includes("context_window"), "context_window entry appended");
    await until(() => session.driver.getStatus().busy === false, "run settles");

    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
    const entries = lines
      .map((l) => JSON.parse(l) as ContextWindowLine)
      .filter((e) => e.type === "context_window");
    expect(entries).toHaveLength(1); // exactly the synthetic advance — nothing else fired
    expect(entries[0]?.data.advancedFrom).toMatch(/^[0-9a-f-]{36}$/); // the predecessor wrapper's id
    expect(entries[0]?.data.divergedAt).toBeUndefined(); // synthetic: no divergent line exists
    // The fake endpoint saw exactly the one post-switch call.
    expect(fake.requests).toBe(1);
  });
});
