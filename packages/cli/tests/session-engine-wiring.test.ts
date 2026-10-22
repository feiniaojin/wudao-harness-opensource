// F1 item 4 (83) — the session-engine wiring pin (construction / init /
// resume). Premise note: the readline REPL (repl.ts runRepl) does NOT use
// driver/session-engine.ts — it drives the loop directly and index.ts hands
// it resumeHistory; the engine's consumers are `wudao ui` (ui.ts
// startUiSession) and the Slack interface. The unpinned seam with the exact
// shape the follow-up names (construction/init/resume) is the ENGINE side:
// what createDriverSession does with resumeHistory + hooks + the store.
// This file pins it end-to-end in-process (scripted model, no tools, no
// real IO beyond the workspace temp dir):
//   construction  resumeHistory seeds the driver's state — the first
//                 ModelInput carries the resumed chain VERBATIM plus the
//                 new prompt, and nothing else;
//   init          the SessionStart hook fires exactly once, source derived
//                 "resume" (sessionStartSource absent);
//   resume        onRunComplete appends ONLY the new run's messages to the
//                 session's JSONL (identity-based selectMessagesToPersist
//                 over the loaded base — the resumed chain is never
//                 re-appended: the append-only/cache law).
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedModel, isFormatMarker } from "@wudao/core";
import type { AgentMessage, ModelClient, ModelInput, SessionStartSource } from "@wudao/core";
import type { ProviderConfig } from "@wudao/providers";
import { createDriverSession } from "../src/driver/session-engine.js";
import type { DriverSession } from "../src/driver/session-engine.js";
import { stripProjectedNotes } from "./projected-notes.js";

const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };

const sessions: DriverSession[] = [];
const roots: string[] = [];
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

/** A scripted model that records every ModelInput (the wiring observer). */
function recordingModel(responses: readonly AgentMessage[]): ModelClient & { inputs: ModelInput[] } {
  const inner = createScriptedModel([...responses]);
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    async generate(input: ModelInput): Promise<AgentMessage> {
      inputs.push({ ...input, messages: input.messages.map((m) => ({ ...m })) });
      i += 1;
      return inner.generate(input);
    },
  };
}

const sessionFile = (ws: string, sessionId: string): string => join(ws, ".wudao", "sessions", `${sessionId}.jsonl`);

describe("F1 item 4 — createDriverSession construction/init/resume wiring", () => {
  it("resumeHistory seeds the run, SessionStart fires \"resume\", and persistence appends only the NEW messages", async () => {
    const ws = mkdtempSync(join(tmpdir(), "f1-engine-"));
    roots.push(ws);
    const sessionId = "wudao-mcx-f1wire001";
    const resumed: AgentMessage[] = [
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
    ];
    const started: SessionStartSource[] = [];
    const model = recordingModel([{ role: "assistant", content: "new answer" }]);
    const session = await createDriverSession({
      config,
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      modelOverride: model,
      tools: [],
      resumeHistory: resumed,
      sessionId,
      hooks: {
        onSessionStart: async (source) => { started.push(source); return undefined; },
      },
    });
    sessions.push(session);
    try {
      // construction + init: the engine fired the session's first boundary
      // with the DERIVED resume source (sessionStartSource absent), once.
      await until(() => started.length === 1, "SessionStart fired");
      expect(started).toEqual(["resume"]);

      // The run over the seeded state: the first ModelInput carries the
      // resumed chain VERBATIM plus the new prompt — and nothing else. (The
      // submitted prompt additionally carries its persistence-only
      // uuid/parentUuid node link; content and order are the wiring facts.)
      session.driver.submit("a follow-up");
      await until(() => session.driver.getStatus().busy === false, "run settles");
      // 夜移 005: the auto-title side-call shares this model — observed but
      // excluded (querySource tag); it never touches the main loop's inputs.
      const mainInputs = model.inputs.filter((i) => i.querySource !== "title");
      expect(mainInputs.length).toBe(1);
      expect(stripProjectedNotes(mainInputs[0]!.messages).map((m) => [m.role, m.content])).toEqual([
        ["user", "earlier question"],
        ["assistant", "earlier answer"],
        ["user", "a follow-up"],
      ]);

      // resume persistence: the JSONL holds ONLY the new run's messages —
      // the resumed chain (identity-in the loaded base) is never re-appended.
      await until(() => existsSync(sessionFile(ws, sessionId)), "session JSONL created");
      await until(() => {
        const lines = readFileSync(sessionFile(ws, sessionId), "utf8").split("\n").filter((l) => l.trim() !== "");
        return lines.length >= 2;
      }, "run persisted");
      // ω99-47: line 1 is the transport-framing format marker — strip it the
      // same way the store's read views do (isFormatMarker) before mapping.
      // ω99-217 (census evolution, 弧军规 §三.6 点名): the settle receipts
      // (turn_diff_receipt / run_stats_receipt) now ride the same JSONL as
      // KNOWN non-message entries — filtered here exactly like the marker,
      // so the assertion below still pins the MESSAGE view verbatim.
      const persisted = readFileSync(sessionFile(ws, sessionId), "utf8")
        .split("\n").filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as AgentMessage | { type: string })
        .filter((e, i, all) => !(i === 0 && all.length > 0 && isFormatMarker(e)))
        .filter((e) => !("type" in e && (e.type === "turn_diff_receipt" || e.type === "run_stats_receipt")))
        .map((e) => e as AgentMessage);
      expect(persisted.map((m) => [m.role, m.content])).toEqual([
        ["user", "a follow-up"],
        ["assistant", "new answer"],
      ]);
      // The engine's store lives where every frontend resolves sessions.
      expect(existsSync(join(ws, ".wudao", "sessions"))).toBe(true);
    } finally {
      await session.close();
    }
  });
});

// 0.3.11（用户反馈：权限档两入口 1:1 联动）— the boot chain: CLI flag >
// props.defaultPermissionMode (ui.ts passes the persisted global read) >
// "workspace" (0.3.12 trio). The prop seam keeps direct-construction tests
// hermetic — the ENGINE never reads settings; argv flags still win over the
// persisted leg.
describe("defaultPermissionMode boot chain (0.3.11; 0.3.12 trio)", () => {
  it("the persisted-default prop sets the session's starting mode", async () => {
    const ws = mkdtempSync(join(tmpdir(), "wudao-eng-pd-"));
    roots.push(ws);
    const session = await createDriverSession({
      config,
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      modelOverride: recordingModel([{ role: "assistant", content: "ok" }]),
      tools: [],
      defaultPermissionMode: "ask",
    });
    sessions.push(session);
    expect(session.driver.getMode()).toBe("ask");
  });

  it("absent prop → workspace (the hermetic baseline)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "wudao-eng-pd2-"));
    roots.push(ws);
    const session = await createDriverSession({
      config,
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      modelOverride: recordingModel([{ role: "assistant", content: "ok" }]),
      tools: [],
    });
    sessions.push(session);
    expect(session.driver.getMode()).toBe("workspace");
  });

  it("an explicit CLI flag still outranks the persisted default", async () => {
    const ws = mkdtempSync(join(tmpdir(), "wudao-eng-pd3-"));
    roots.push(ws);
    const prev = process.argv;
    process.argv = [...prev, "--ask"];
    try {
      const session = await createDriverSession({
        config,
        workspaceRoot: ws,
        contextWindowTokens: 64_000,
        modelOverride: recordingModel([{ role: "assistant", content: "ok" }]),
        tools: [],
        defaultPermissionMode: "auto",
      });
      sessions.push(session);
      expect(session.driver.getMode()).toBe("ask");
    } finally {
      process.argv = prev;
    }
  });
});

// 夜移 032 (the upstream projectturn-diff) — the engine-side wiring pin: createDriverSession
// threads ONE tracker instance into BOTH its buildToolSet (the engine-built
// write_file records committed writes) and the driver (reset at run start,
// receipt at run settle). A scripted write run through the ENGINE's own tool
// set lands the net-change receipt in the driver's history — the
// product-primary surface (wudao ui / desktop) end-to-end.
describe("夜移 032 — engine threads one turnDiff into tools + driver", () => {
  it("an engine-built write_file run lands the net-change notice", async () => {
    // realpath: macOS tmpdir is a symlink — the tool's resolved target is
    // canonical, so the engine's workspaceRoot must be too (else the receipt
    // shows a ../../ escape instead of the display-relative name).
    const ws = realpathSync(mkdtempSync(join(tmpdir(), "td-engine-")));
    roots.push(ws);
    const model = recordingModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "write_file", arguments: { path: "hello.ts", content: "export const x = 1;\n" } }] },
      { role: "assistant", content: "written" },
      { role: "assistant", content: "title" },
    ]);
    const session = await createDriverSession({
      config,
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      modelOverride: model,
      // tools ABSENT: the engine builds its own coding set (write_file
      // included) — passing [] would replace it wholesale.
      sessionId: "wudao-mcx-tdwire001",
      noPeer: true,
      askRelay: async () => ({ kind: "allow" }),
    });
    sessions.push(session);
    try {
      session.driver.submit("write hello.ts");
      await until(() => session.driver.getStatus().busy === false, "engine run settles");
      const netNotices = session.driver.getHistory().filter(
        (e): e is { kind: "notice"; text: string; detail?: string } =>
          e.kind === "notice" && e.text.includes("回合净变更"),
      );
      expect(netNotices).toHaveLength(1);
      expect(netNotices[0]?.text).toBe("回合净变更 1 文件：hello.ts(新建)");
      const detail = netNotices[0]?.detail ?? "";
      expect(detail).toContain("diff --git a/hello.ts b/hello.ts");
      expect(detail).toContain("+export const x = 1;");
    } finally {
      await session.close();
    }
  });
});
