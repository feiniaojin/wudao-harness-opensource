// 推理档三级配置 S2b — the WEB engine's missing model-switch leg. The TUI
// (app.tsx onModelSwitch) and the REPL (applyModelSelection) mutate the live
// provider config so /model //effort reach the WIRE; the session engine
// (wudao ui / slack — every browser session) never wired that seam, so a
// browser /effort changed only the display overlay while the request kept
// the boot bytes. This pins the fix: the engine owns ONE mutable live
// config, applyModelSelection lands switches on it, and the next main-loop
// request body carries the new reasoning_effort.
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

/** A fake OpenAI-compatible endpoint that records every request BODY. The
 *  session's auto-title side-call carries a standalone system prompt whose
 *  first line is the title constant — main-loop calls are discriminated by
 *  its absence. */
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

describe("session-engine — /effort reaches the wire (S2b)", () => {
  it("a browser /effort high rides the NEXT main-loop request body as reasoning_effort", async () => {
    const fake = await startBodyRecorder();
    servers.push(fake.server);
    const ws = mkdtempSync(join(tmpdir(), "effort-wire-"));
    roots.push(ws);
    const config: ProviderConfig = { apiKey: "test-key", baseURL: fake.url, model: "boot-model", provider: "deepseek" };
    const session = await createDriverSession({
      config,
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      tools: [],
      sessionId: "wudao-effort-wire-0001",
      noPeer: true,
    });
    sessions.push(session);

    // The switch is display-only until the seam lands it on the live config.
    session.driver.submit("/effort high");
    await wait();
    session.driver.submit("hello");
    await until(
      () => session.driver.getHistory().some((e) => e.kind === "assistant" && e.text.includes("ok")),
      "the run replies",
    );
    // The MAIN-loop call (not the title side-call) carries the switched level.
    const mainBodies = fake.bodies.filter(
      (b) => typeof b.messages === "object" && !JSON.stringify(b.messages).includes(TITLE_SYSTEM_FIRST_LINE),
    );
    expect(mainBodies.length).toBeGreaterThan(0);
    const last = mainBodies[mainBodies.length - 1] as Record<string, unknown>;
    expect(last["reasoning_effort"]).toBe("high");
  });
});
