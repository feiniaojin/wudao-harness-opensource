// 夜移 017 (#31) — 首调前持久 user（crash-safety for the prompt)。The gap:
// persistence happened ONLY in onRunComplete — a crash mid-run lost the
// user's submitted prompt, the one message the user cannot regenerate. The
// fix: the driver fires onUserTurn synchronously right after the user's own
// turn lands in state.messages (BEFORE the first model call resolves;
// never for the language/reasoning transient tails — those are model-facing
// projection that still persists at run-complete), and both frontends
// append that exact object to the session JSONL immediately. Identity-based
// selectMessagesToPersist then skips it at run-complete: exactly one line.
//
//   ① driver seam  onUserTurn fires once per submit, before the first
//                  model call settles, with the EXACT object identity
//                  onRunComplete later sees (the dedup key);
//   ② transients   forced language + reasoning tails (2 extra user
//                  messages in state) never fire the seam;
//   ③ engine       mid-run — the model hanging, run busy — the user line
//                  is ALREADY on disk; after settle, exactly ONCE;
//   ④ TUI          the same contract through the full ink render.
import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, ModelClient, ModelInput } from "@wudao/core";
import type { ProviderConfig } from "@wudao/providers";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";
import { createDriverSession } from "../src/driver/session-engine.js";
import type { DriverSession } from "../src/driver/session-engine.js";
import { summarizeToolCall } from "../src/log.js";
import { WudaoApp } from "../src/tui/app.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };

/** A model whose every generate() hangs until release() — the mid-run crash
 *  window stand-in: the run is busy, nothing has settled, the process is
 *  one kill -9 away from losing everything not yet on disk. */
function gatedModel(): ModelClient & { calls: number; release: () => void } {
  let calls = 0;
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  return {
    get calls() { return calls; },
    release: () => open(),
    async generate(_input: ModelInput): Promise<AgentMessage> {
      calls += 1;
      await gate;
      return { role: "assistant", content: "late answer", stopReason: "end_turn" };
    },
  };
}

function makeDriver(over: Parameters<typeof createAgentDriver>[0] = {}): AgentDriver {
  return createAgentDriver({
    systemPrompt: "s",
    summarize: summarizeToolCall,
    model: gatedModel(),
    tools: [],
    ...over,
  });
}

// ink-testing-library delivers a multi-char stdin.write as ONE input chunk —
// feed character by character with an await between writes (React batching).
async function type(stdin: { write(s: string): void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await wait(15);
  }
}

const roots: string[] = [];
const sessions: DriverSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const sessionFile = (ws: string, sessionId: string): string => join(ws, ".wudao", "sessions", `${sessionId}.jsonl`);

const userLineCount = (path: string, content: string): number => {
  try {
    return readFileSync(path, "utf8").split("\n").filter((l) => {
      if (l.trim() === "") return false;
      try {
        const m = JSON.parse(l) as AgentMessage;
        return m.role === "user" && m.content === content;
      } catch { return false; }
    }).length;
  } catch { return 0; }
};

describe("夜移 017 — first-call-early user persistence (crash-safety for the prompt)", () => {
  it("① the driver fires onUserTurn once at submit, with the exact identity onRunComplete sees", async () => {
    const model = gatedModel();
    const seen: AgentMessage[] = [];
    const completed: AgentMessage[][] = [];
    const d = makeDriver({
      model,
      onUserTurn: (m) => seen.push(m),
      onRunComplete: (ms) => completed.push([...ms]),
    });
    d.submit("precious prompt");
    await until(() => model.calls === 1, "first model call");
    // The run is STILL HANGING here — the seam fired before any settle.
    expect(seen.length).toBe(1);
    expect(seen[0]!.role).toBe("user");
    expect(seen[0]!.content).toBe("precious prompt");
    model.release();
    await until(() => completed.length === 1, "run complete");
    // Identity: the SAME object reference run-complete persistence walks —
    // the loadedRef dedup keys on it, so early append ⇒ no duplicate line.
    expect(completed[0]!.includes(seen[0]!)).toBe(true);
  });

  it("② never fires for the language/reasoning transient tails", async () => {
    const model = gatedModel();
    const seen: AgentMessage[] = [];
    const d = makeDriver({
      model,
      languageBlock: "on",   // forces the response-language tail every turn
      reasoningLanguage: "zh", // forces the reasoning-language tail too
      onUserTurn: (m) => seen.push(m),
    });
    d.submit("plain ascii prompt");
    await until(() => model.calls === 1, "first model call");
    model.release();
    await until(() => d.getStatus().busy === false, "run settles");
    // Three user messages exist in state (turn + both tails) — but the seam
    // fired exactly once: only the user's own turn is crash-persistent.
    expect(seen.length).toBe(1);
    expect(seen[0]!.content).toBe("plain ascii prompt");
  });

  it("③ session-engine: the user line is on disk mid-run, and exactly once after settle", async () => {
    const ws = mkdtempSync(join(tmpdir(), "night017-engine-"));
    roots.push(ws);
    const sessionId = "wudao-night017-engine";
    const model = gatedModel();
    const session = await createDriverSession({
      config,
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      modelOverride: model,
      tools: [],
      sessionId,
    });
    sessions.push(session);
    session.driver.submit("mid-run crash window");
    // MID-RUN: the model hangs, busy=true, nothing settled — the user's
    // prompt is already durable in the session JSONL.
    // 原来：只轮询「user 行已落盘」就立刻断言 calls===1——落盘与 generate
    // 被调用之间没有时序保证（r1 签名 expected 1 got 0）：负载下轮询命中的
    // 那一刻 generate 可能尚未进入。两个条件各自轮询到成立（模型挂起 ⇒ calls
    // 停在 1），崩溃窗口的断言语义不变。
    await until(() => model.calls >= 1, "first model call started");
    await until(() => {
      try { return readFileSync(sessionFile(ws, sessionId), "utf8").includes("mid-run crash window"); } catch { return false; }
    }, "user line on disk mid-run");
    expect(model.calls).toBe(1); // still hanging — this IS the pre-crash window
    model.release();
    await until(() => session.driver.getStatus().busy === false, "run settles");
    await until(() => {
      try { return readFileSync(sessionFile(ws, sessionId), "utf8").includes("late answer"); } catch { return false; }
    }, "assistant line persisted");
    // The identity dedup contract: exactly ONE line for the user prompt.
    expect(userLineCount(sessionFile(ws, sessionId), "mid-run crash window")).toBe(1);
  });

  it("④ TUI: the user line lands mid-run through the full render and never duplicates", async () => {
    const model = gatedModel();
    const root = mkdtempSync(join(tmpdir(), "night017-tui-"));
    roots.push(root);
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} />,
    );
    await wait();
    await type(inst.stdin, "tui precious\r");
    const sessDir = join(root, ".wudao", "sessions");
    await until(() => {
      try {
        return readdirSync(sessDir).some((f) =>
          f.endsWith(".jsonl") && readFileSync(join(sessDir, f), "utf8").includes("tui precious"));
      } catch { return false; }
    }, "user line on disk while the model hangs");
    model.release();
    await until(() => (inst.lastFrame() ?? "").includes("late answer"), "answer rendered");
    inst.unmount();
    // 原来：unmount 后固定 wait(50) 就数行——渲染出答案与 run-complete 持久化
    // flush 之间没有时序保证，负载下 50ms 内 dedup 定局可能还没写完，计数跑在
    // 定局前。轮询到 assistant 行落盘（= run-complete 持久化已 flush）再数。
    await until(() => {
      try {
        return readdirSync(sessDir).some((f) =>
          f.endsWith(".jsonl") && readFileSync(join(sessDir, f), "utf8").includes("late answer"));
      } catch { return false; }
    }, "assistant line persisted (dedup final)");
    const total = readdirSync(sessDir).filter((f) => f.endsWith(".jsonl"))
      .reduce((n, f) => n + userLineCount(join(sessDir, f), "tui precious"), 0);
    expect(total).toBe(1);
  });
});
