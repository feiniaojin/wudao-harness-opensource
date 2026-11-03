// ω99-62 — /find's graceful degradation outside the TUI. 59 shipped /find as
// a TUI-owned overlay (app.tsx intercepts the line before parseReplCommand),
// so REPL/web/headless users who typed /find … paid the unknown-slash round
// trip (the line went to the model as a prompt). This file pins the repair:
// a `find` kind in the shared parse (TUI-identical grammar, prefix-neighbor
// discipline), a driver routedSubmit arm (web/desktop/Slack), a REPL chain
// branch (readline + the headless batcher), byte-identical notice copy at
// both seams, and the TUI interception priority as a regression invariant.
import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink-testing-library";
import { createScriptedModel, createReadFileTool } from "@wudao-org/core";
import type { ProviderConfig } from "@wudao-org/providers";
import { parseReplCommand, runRepl } from "../src/repl.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";
import { listSlashCommands } from "../src/slash-commands.js";
import { WudaoApp } from "../src/tui/app.js";
import type { LoadedSkill } from "../src/skills.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

/** The degradation copy — byte-pinned here (not imported) so a wording drift
 * in the source trips this suite, exactly like the acceptance demands. */
const NOTICE = "/find 是 TUI 界面命令（当前转录内查找）。跨会话搜索用 /search <query>。";

// ── parse layer: the shared grammar gains one kind ─────────────────────

describe("parseReplCommand — the find kind (ω99-62)", () => {
  it("/find <query> parses with the TUI's exact semantics (trim both sides)", () => {
    expect(parseReplCommand("/find error")).toEqual({ kind: "find", query: "error" });
    expect(parseReplCommand("/find   spaced   query  ")).toEqual({ kind: "find", query: "spaced   query" });
    expect(parseReplCommand("  /find Error Handling ")).toEqual({ kind: "find", query: "Error Handling" });
  });

  it("bare /find parses with an empty query (same arm as with a query)", () => {
    expect(parseReplCommand("/find")).toEqual({ kind: "find", query: "" });
    expect(parseReplCommand("  /find  ")).toEqual({ kind: "find", query: "" });
  });

  it("prefix-neighbors stay plain prompts: /findx, /finder, /findtab", () => {
    expect(parseReplCommand("/findx")).toEqual({ kind: "prompt", text: "/findx" });
    expect(parseReplCommand("/finder error")).toEqual({ kind: "prompt", text: "/finder error" });
    expect(parseReplCommand("/findtab")).toEqual({ kind: "prompt", text: "/findtab" });
  });

  it("the builtin wins: registered plugin/extension/skill names never shadow /find", () => {
    const skill = { name: "find" } as unknown as LoadedSkill;
    expect(parseReplCommand("/find x", ["find"], ["find"], [skill])).toEqual({ kind: "find", query: "x" });
  });

  it("the neighbors of the neighborhood stay prompts: /fi, /fin", () => {
    expect(parseReplCommand("/fi")).toEqual({ kind: "prompt", text: "/fi" });
    expect(parseReplCommand("/fin")).toEqual({ kind: "prompt", text: "/fin" });
  });
});

// ── the driver arm: routedSubmit (web / desktop / Slack seam) ──────────

/** A model that counts its calls — the degradation arms must call it ZERO
 * times (that was the whole cost of the 59 gap: a wasted round trip). */
function makeDriver(): { driver: AgentDriver; calls: () => number } {
  let calls = 0;
  const model = createScriptedModel([{ role: "assistant", content: "ok" }]);
  const driver = createAgentDriver({
    systemPrompt: "s",
    summarize: summarizeToolCall,
    model: { generate: async (input) => { calls += 1; return model.generate(input); } },
    tools: [createReadFileTool({ workspaceRoot: process.cwd() })],
  });
  return { driver, calls: () => calls };
}

const noticesOf = (d: AgentDriver): readonly string[] =>
  d.getHistory().filter((e): e is { kind: "notice"; text: string } => e.kind === "notice").map((e) => e.text);

describe("AgentDriver routedSubmit — the find degradation arm", () => {
  it("'/find anything' → 'notice' + the verbatim copy + ZERO model calls", async () => {
    const { driver, calls } = makeDriver();
    await wait();
    expect(driver.submit("/find anything")).toBe("notice");
    await wait(50);
    expect(noticesOf(driver)).toContain(NOTICE);
    expect(calls()).toBe(0);
    driver.dispose();
  });

  it("bare '/find' → the same arm, the same copy (same-shape, no usage fork)", async () => {
    const { driver, calls } = makeDriver();
    await wait();
    expect(driver.submit("/find")).toBe("notice");
    await wait(50);
    expect(noticesOf(driver)).toContain(NOTICE);
    expect(calls()).toBe(0);
    driver.dispose();
  });

  it("'/findx note' stays a real prompt: a run starts and the line reaches the model", async () => {
    const { driver, calls } = makeDriver();
    await wait();
    expect(driver.submit("/findx note")).toBe("started");
    await until(() => driver.getStatus().busy === false, "the prompt run to settle");
    expect(calls()).toBe(1);
    expect(driver.getHistory().some((e) => e.kind === "user" && e.text === "/findx note")).toBe(true);
    expect(noticesOf(driver)).not.toContain(NOTICE);
    driver.dispose();
  });
});

// ── the REPL seam: readline + the headless batcher (same chain) ────────

const CFG: ProviderConfig = { apiKey: "sk-o99-62", baseURL: "https://o99-62.invalid/v1", model: "o99-62-model" };

/** Fake fetch: capture every request, replay a minimal SSE completion (the
 * persona-wire-repl harness shape). */
function sseFetch(captured: string[]): typeof fetch {
  const enc = new TextEncoder();
  return (async (url: unknown, init?: RequestInit) => {
    captured.push(String(init?.body));
    const sse = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`));
        c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}

function drainAll(out: PassThrough): string {
  let text = "";
  let chunk = out.read();
  while (chunk !== null) {
    text += chunk.toString();
    chunk = out.read();
  }
  return text;
}

/** Drive one full REPL session through injected streams; resolves on /exit.
 * PassThrough stdin is non-TTY, so the ω99-35 headless batcher is ACTIVE in
 * these tests — the /find lines pass through its isImmediate probe (the
 * repl.ts:1521 light parse) and then the main chain, exactly the path a
 * piped headless session takes. */
async function driveRepl(lines: readonly string[]): Promise<{ wire: readonly string[]; out: string }> {
  const ws = await mkdtemp(join(tmpdir(), "o99-62-ws-"));
  const globalHome = await mkdtemp(join(tmpdir(), "o99-62-gh-"));
  const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
  const prevFetch = globalThis.fetch;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const captured: string[] = [];
  process.env.WUDAO_GLOBAL_HOME = globalHome;
  globalThis.fetch = sseFetch(captured);
  let replError: unknown;
  let seen = "";
  let fed = 0;
  let feeder: ReturnType<typeof setInterval> | undefined;
  try {
    const done = runRepl({
      config: CFG,
      workspaceRoot: ws,
      buildTools: () => [],
      contextWindowTokens: 200_000,
      stdin,
      stdout,
    });
    feeder = setInterval(() => {
      seen += drainAll(stdout);
      const prompts = seen.split("wudao> ").length - 1;
      while (fed < lines.length && fed < prompts) {
        stdin.write(`${lines[fed]}\n`);
        fed += 1;
      }
    }, 15);
    await done;
  } catch (err) {
    replError = err;
  } finally {
    if (feeder !== undefined) clearInterval(feeder);
    process.env.WUDAO_GLOBAL_HOME = prevGlobal;
    globalThis.fetch = prevFetch;
    await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  if (replError !== undefined) throw replError;
  return { wire: captured, out: seen + drainAll(stdout) };
}

describe("REPL (readline + headless batcher) — the local degradation branch", () => {
  it("'/find anything' prints the verbatim notice; the wire sees ZERO model calls", async () => {
    const { wire, out } = await driveRepl(["/find anything", "/exit"]);
    expect(out).toContain(NOTICE);
    expect(wire).toEqual([]);
  }, 20_000);

  it("bare '/find' prints the same notice (same-shape)", async () => {
    const { wire, out } = await driveRepl(["/find", "/exit"]);
    expect(out).toContain(NOTICE);
    expect(wire).toEqual([]);
  }, 20_000);

  it("'/findx note' stays a real prompt: exactly one model call carrying the line", async () => {
    const { wire } = await driveRepl(["/findx note", "/exit"]);
    expect(wire.length).toBe(1);
    expect(wire[0]).toContain("/findx note");
  }, 20_000);
});

// ── asymmetric advertising + TUI priority (the two design pins) ────────

describe("asymmetric advertising (ω99-62 beyond-point 1)", () => {
  it("listSlashCommands advertises no find — the REPL/web menus never list it", () => {
    expect(listSlashCommands({}).some((c) => c.name === "find")).toBe(false);
  });
});

const TUI_CONFIG: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };

async function type(stdin: { write(s: string): void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await wait(15);
  }
}

describe("TUI priority pin (ω99-62 beyond-point 3 — the interception stays on top)", () => {
  it("/find still opens the FindPanel, not the degradation notice (pre-parse interception outranks the new kind)", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "部署遇到 Error: connection refused" }]);
    const root = mkdtempSync(join(tmpdir(), "wudao-o99-62-"));
    const inst = render(<WudaoApp config={TUI_CONFIG} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} />);
    await wait();
    await type(inst.stdin, "diag\r");
    await until(() => (inst.lastFrame() ?? "").includes("connection refused"), "answer to land");
    await type(inst.stdin, "/find error\r");
    await until(() => (inst.lastFrame() ?? "").includes("find: error"), "the FindPanel to open");
    const frame = inst.lastFrame() ?? "";
    // The regression invariant: the TUI got its overlay, NOT the non-TUI copy.
    expect(frame).not.toContain("是 TUI 界面命令");
    // And the command line never entered the transcript as a user turn.
    expect(frame).not.toContain("› /find error");
    inst.stdin.write("\x1b");
    await until(() => !(inst.lastFrame() ?? "").includes("find: error"), "panel to close");
    inst.unmount();
  });
});
