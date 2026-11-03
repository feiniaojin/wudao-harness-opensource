// `wudao ui` integration: the REAL driver + REAL server (startUiSession) with
// a scripted model and stub tools — the CI form of the manual smoke (browser
// placeholder + WS auth + a `w node -v`-style round-trip through the driver).
// The WS client is Node's global WebSocket (undici) — no new test dependency.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool, createScriptedModel, createReadFileTool } from "@wudao-org/core";
import type { ModelClient, ModelInput, Tool } from "@wudao-org/core";
import type { ProviderConfig } from "@wudao-org/providers";
import { createSidecar } from "../src/sidecar.js";
import { startUiSession, parseUiPort, type UiSession } from "../src/ui.js";
import { TITLE_QUERY_SOURCE } from "../src/session-title.js";
// M63 §C: the wizard boot plan + the credentials writer the wizard's
// settingsSaveKey rides.
import { buildUiBootPlan } from "../src/run.js";
import { saveProviderKey } from "../src/credentials.js";

const noticesText = (s2: { getHistory(): { kind?: string; text?: string }[] }): string =>
  s2.getHistory().map((e) => (e.kind === "notice" ? e.text ?? "" : "")).join("\n");

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };

const sessions: UiSession[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  // win32: a just-closed session's peer/watcher handle can linger a few ms —
  // the rmdir races EPERM. Retry briefly before surfacing.
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

interface Frame {
  t: string;
  state?: { busy?: boolean; sessionId?: string; pendingPermission?: { toolName?: string } | null };
  entries?: { kind?: string; text?: string; summary?: string }[];
  reset?: boolean;
  id?: unknown;
  ok?: unknown;
  err?: string;
}

function connect(session: UiSession): { ws: WebSocket; frames: Frame[]; closed: Promise<{ code: number }> } {
  const ws = new WebSocket(`ws://127.0.0.1:${session.server.port}`);
  const frames: Frame[] = [];
  const closed = new Promise<{ code: number }>((resolve) => ws.addEventListener("close", (e) => resolve({ code: (e as CloseEvent).code })));
  ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data)) as Frame));
  return { ws, frames, closed };
}

describe("wudao ui (startUiSession)", () => {
  it("serves the placeholder page and a full scripted driver round-trip over WS", async () => {
    const root = mkdtempSync(join(tmpdir(), "wudao-ui-"));
    roots.push(root);
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "node -v" } }] },
      { role: "assistant", content: "UI-ROUNDTRIP-OK" },
    ]);
    const runTool = buildTool({
      name: "shell",
      description: "stub run",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
      execute: async () => ({ content: "v24.7.0" }),
    });
    const session = await startUiSession({
      config,
      workspaceRoot: root,
      contextWindowTokens: 64000,
      modelOverride: model,
      tools: [runTool as Tool],
      gates: { verify: false },
      announce: false,
      openBrowser: false,
      staticDir: undefined,
    });
    sessions.push(session);

    // The placeholder page carries the protocol bootstrap and never the token.
    const page = await fetch(`http://127.0.0.1:${session.server.port}/`);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain("悟道Harness"); // 品牌弧：title 更名
    expect(html).not.toContain(session.server.token);

    // Auth: the token from the printed URL fragment.
    const c = connect(session);
    await new Promise<void>((resolve) => c.ws.addEventListener("open", resolve));
    c.ws.send(JSON.stringify({ t: "auth", token: session.server.token }));
    await until(() => c.frames.some((f) => f.t === "history" && f.reset === true), "initial replay");

    // The smoke's prompt — with the real key the model maps it to a shell
    // call; here the script does. Default mode parks the ask → answered over
    // the protocol (answerPermission), then the run finishes.
    c.ws.send(JSON.stringify({ t: "op", id: 1, op: { op: "submit", text: "w node -v" } }));
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 1 && f.ok === "started"), "submit result");
    await until(() => c.frames.some((f) => f.t === "state" && f.state?.pendingPermission?.toolName === "shell"), "parked ask");
    c.ws.send(JSON.stringify({ t: "op", id: 2, op: { op: "answerPermission", allow: true } }));
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 2 && f.ok === true), "answer result");

    await until(() => {
      const hist = c.frames.filter((f) => f.t === "history" && f.reset !== true).flatMap((f) => f.entries ?? []);
      return hist.some((e) => e.kind === "tool" && e.summary?.includes("node -v"))
        && hist.some((e) => e.kind === "assistant" && e.text === "UI-ROUNDTRIP-OK");
    }, "tool + answer entries relayed");
    await until(() => c.frames.some((f) => f.t === "state" && f.state?.busy === false), "idle state");

    // The run persisted to the session JSONL like the TUI would.
    await until(() => {
      try {
        const dir = join(root, ".wudao", "sessions");
        // #48: the sessions root also carries the `.leases` dir — pick the
        // session FILE, not whatever readdir lists first.
        const file = readdirSync(dir).find((n) => n.endsWith(".jsonl")) ?? "";
        return file !== "" && readFileSync(join(dir, file), "utf8").includes("UI-ROUNDTRIP-OK");
      } catch {
        return false;
      }
    }, "session persisted");
    c.ws.close();
  }, 10000);

  it("a wrong token cannot reach the driver; listSlashCommands/sessions data flows", async () => {
    const root = mkdtempSync(join(tmpdir(), "wudao-ui2-"));
    roots.push(root);
    const model = createScriptedModel([{ role: "assistant", content: "x" }]);
    const session = await startUiSession({
      config,
      workspaceRoot: root,
      contextWindowTokens: 64000,
      modelOverride: model,
      tools: [],
      announce: false,
      openBrowser: false,
    });
    sessions.push(session);

    const bad = connect(session);
    await new Promise<void>((resolve) => bad.ws.addEventListener("open", resolve));
    bad.ws.send(JSON.stringify({ t: "auth", token: "wrong" }));
    const ev = await bad.closed;
    expect(ev.code).toBe(4401);

    const c = connect(session);
    await new Promise<void>((resolve) => c.ws.addEventListener("open", resolve));
    c.ws.send(JSON.stringify({ t: "auth", token: session.server.token }));
    await until(() => c.frames.some((f) => f.t === "history" && f.reset === true), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 7, op: { op: "listSlashCommands" } }));
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 7), "commands result");
    const commands = c.frames.find((f) => f.t === "result" && f.id === 7)?.ok as { name: string }[];
    expect(commands.map((x) => x.name)).toContain("plan");
    c.ws.close();
  });

  it("M45 review: a task-tool child's shell goes through the sidecar gate", async () => {
    const root = mkdtempSync(join(tmpdir(), "wudao-ui3-"));
    roots.push(root);
    // No props.tools → the REAL buildToolSet runs, so the task tool's child
    // gate is the frontend's subagentGate. One scripted model serves parent
    // AND child (coder has no model pins → the child runs on the session
    // model): parent dispatches, child runs one command, child reports,
    // parent answers.
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "p1", name: "task", arguments: { description: "run echo", prompt: "run the echo command", role: "coder" } }] },
      { role: "assistant", content: "", toolCalls: [{ id: "k1", name: "shell", arguments: { command: "echo wudao-sidecar-child" } }] },
      { role: "assistant", content: "CHILD-DONE" },
      { role: "assistant", content: "PARENT-DONE" },
    ]);
    const sidecar = createSidecar({
      model: { async generate() { return { role: "assistant", content: '{"risk":"low","reason":"routine"}' }; } },
    });
    const origArgv = process.argv;
    const origDefer = process.env.WUDAO_DEFER_TOOLS;
    process.argv = [...origArgv, "--auto"];
    process.env.WUDAO_DEFER_TOOLS = "off"; // task callable without load_tools
    let session: UiSession;
    try {
      session = await startUiSession({
        config,
        workspaceRoot: root,
        contextWindowTokens: 64000,
        modelOverride: model,
        sidecar,
        gates: { verify: false },
        announce: false,
        openBrowser: false,
        staticDir: undefined,
      });
    } finally {
      process.argv = origArgv;
      if (origDefer === undefined) delete process.env.WUDAO_DEFER_TOOLS;
      else process.env.WUDAO_DEFER_TOOLS = origDefer;
    }
    sessions.push(session);

    session.driver.submit("dispatch the child");
    await until(
      () => session.driver.getStatus().busy === false && session.driver.getHistory().some((h) => h.kind === "assistant" && h.text === "PARENT-DONE"),
      "run to finish",
    );
    // TWO classifications: the parent's task call (main gate) AND the child's
    // shell (subagent gate) — before the review fix the child call
    // bypassed the classifier entirely.
    expect(sidecar.checks()).toBe(2);
    expect(session.driver.getStatus().sidecar).toEqual({ checks: 2, breakerOpen: false });
    const taskEntry = session.driver.getHistory().find((h) => h.kind === "tool" && h.name === "task");
    expect(taskEntry?.isError).toBeFalsy(); // the low verdict let the child run
    expect(taskEntry?.resultPreview ?? "").toContain("CHILD-DONE");
  });

  it("parseUiPort: absent → undefined; valid → number; malformed → throws", () => {
    expect(parseUiPort(["ui", "--auto"])).toBeUndefined();
    expect(parseUiPort(["ui", "--ui-port", "8080"])).toBe(8080);
    expect(() => parseUiPort(["ui", "--ui-port", "nope"])).toThrow(/--ui-port/);
    expect(() => parseUiPort(["ui", "--ui-port", "99999"])).toThrow(/--ui-port/);
  });

  // M62 §1 fix (review L5): the driver-based frontends (`wudao ui` and the
  // Slack interface share createDriverSession) must wire the gated-rule
  // matcher the TUI/REPL/one-shot paths already had — the note lands in the
  // message history after the first matching read (lazy, append-only).
  it("a gated context rule injects its note on the first matching read (session-engine wiring)", async () => {
    const root = mkdtempSync(join(tmpdir(), "wudao-ui-rules-"));
    roots.push(root);
    mkdirSync(join(root, ".wudao", "rules"), { recursive: true });
    writeFileSync(
      join(root, ".wudao", "rules", "py-gated.md"),
      '---\npaths: ["**/*.py"]\n---\nPY-RULE-UI: run ruff before answering\n',
      "utf8",
    );
    writeFileSync(join(root, "code.py"), "print('ui')\n", "utf8");
    const inputs: ModelInput[] = [];
    let i = 0;
    const replies = [
      { role: "assistant" as const, content: "", toolCalls: [{ id: "r1", name: "read_file", arguments: { path: "code.py" } }] },
      { role: "assistant" as const, content: "RULE-UI-DONE" },
    ];
    const model: ModelClient = {
      async generate(input: ModelInput) {
        // Snapshot (the eval's snapshotModel trick): the loop keeps mutating
        // the live message array after generate returns. Session-engine
        // sessions auto-title (session-engine.ts autoTitle:true): a
        // fire-and-forget background generate races this assertion — count
        // CONVERSATION calls only (the title call is never in the main
        // transcript; TITLE_QUERY_SOURCE is its marker).
        if (input.querySource !== TITLE_QUERY_SOURCE) {
          inputs.push({ ...input, messages: input.messages.map((m) => ({ ...m })) });
        }
        const r = replies[i];
        i += 1;
        if (!r) throw new Error("scripted responses exhausted");
        return r;
      },
    };
    const session = await startUiSession({
      config,
      workspaceRoot: root,
      contextWindowTokens: 64000,
      modelOverride: model,
      tools: [createReadFileTool({ workspaceRoot: root }) as Tool],
      gates: { verify: false },
      announce: false,
      openBrowser: false,
      staticDir: undefined,
    });
    sessions.push(session);

    session.driver.submit("work on the python file");
    await until(
      () => session.driver.getStatus().busy === false && session.driver.getHistory().some((h) => h.kind === "assistant" && h.text === "RULE-UI-DONE"),
      "rule run to finish",
    );
    // Lazy: the first call carries no note; the call AFTER the matching read
    // carries the [context rule …] note the loop appended to history.
    expect(inputs.length).toBe(2);
    expect(JSON.stringify(inputs[0]?.messages ?? [])).not.toContain("[context rule ");
    const second = JSON.stringify(inputs[1]?.messages ?? []);
    expect(second).toContain("[context rule .wudao/rules/py-gated.md");
    expect(second).toContain("PY-RULE-UI");
  });

  it("M63 §C: a no-key boot serves the wizard; a key saved mid-session switches /provider live", async () => {
    const root = mkdtempSync(join(tmpdir(), "wudao-ui-wiz-"));
    roots.push(root);
    const home = mkdtempSync(join(tmpdir(), "wudao-ui-wiz-home-"));
    roots.push(home);
    // The settings ops + the /provider seam read the PROCESS env — pin the
    // home and blank any machine keys so the readiness assertions are ours.
    const prev = { home: process.env.WUDAO_GLOBAL_HOME, key: process.env.WUDAO_API_KEY, okey: process.env.OPENAI_API_KEY };
    const setEnv = (k: string, v: string | undefined): void => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    setEnv("WUDAO_GLOBAL_HOME", home);
    setEnv("WUDAO_API_KEY", undefined);
    setEnv("OPENAI_API_KEY", undefined);
    try {
      // The wizard boot (no key anywhere): placeholder config, real seam.
      const boot = buildUiBootPlan({ prompt: "", env: { WUDAO_GLOBAL_HOME: home } as NodeJS.ProcessEnv, credentials: {} });
      expect(boot.kind).toBe("wizard");
      const session = await startUiSession({
        config: boot.kind === "wizard" ? boot.config : config,
        workspaceRoot: root,
        contextWindowTokens: 64000,
        tools: [],
        gates: { verify: false },
        announce: false,
        openBrowser: false,
      });
      sessions.push(session);

      // The web gate's data over WS: not ready, wizard version 0.
      const c = connect(session);
      await new Promise<void>((resolve) => c.ws.addEventListener("open", resolve));
      c.ws.send(JSON.stringify({ t: "auth", token: session.server.token }));
      await until(() => c.frames.some((f) => f.t === "history" && f.reset === true), "replay");
      c.ws.send(JSON.stringify({ t: "op", id: 11, op: { op: "settingsStatus" } }));
      await until(() => c.frames.some((f) => f.t === "result" && f.id === 11), "status result");
      const status = c.frames.find((f) => f.t === "result" && f.id === 11)?.ok as {
        readiness: boolean;
        settings: { wizardCompletedVersion: number };
      };
      expect(status.readiness).toBe(false);
      expect(status.settings.wizardCompletedVersion).toBe(0);
      c.ws.close();

      // The wizard's key write (settingsSaveKey's own writer), then the
      // completion /provider — SAME provider as the placeholder (the review
      // HIGH shape: the nominal provider matches, so only the placeholder
      // carve-out makes this a real switch instead of a no-op that would
      // ship the sentinel key into the first request).
      await saveProviderKey("deepseek", "sk-wizard-ds", { WUDAO_GLOBAL_HOME: home });
      session.driver.submit("/provider deepseek");
      await until(
        () => session.driver.getHistory().some((e) => e.kind === "notice" && e.text.includes("供应商 → deepseek")),
        "switch receipt",
      );
      // The no-op notice did NOT fire (that path ships the sentinel live).
      expect(noticesText(session.driver)).not.toContain("already on deepseek");
      const jsonl = readFileSync(join(root, ".wudao", "sessions", `${session.driver.getSessionId()}.jsonl`), "utf8");
      expect(jsonl).toContain("\"type\":\"provider_change\"");
      expect(jsonl).toContain("\"provider\":\"deepseek\"");
      // Readiness flipped: the saved key makes the matrix ready.
      const c2 = connect(session);
      await new Promise<void>((resolve) => c2.ws.addEventListener("open", resolve));
      c2.ws.send(JSON.stringify({ t: "auth", token: session.server.token }));
      await until(() => c2.frames.some((f) => f.t === "history" && f.reset === true), "replay 2");
      c2.ws.send(JSON.stringify({ t: "op", id: 12, op: { op: "settingsStatus" } }));
      await until(() => c2.frames.some((f) => f.t === "result" && f.id === 12), "status result 2");
      expect((c2.frames.find((f) => f.t === "result" && f.id === 12)?.ok as { readiness: boolean }).readiness).toBe(true);
      c2.ws.close();
    } finally {
      setEnv("WUDAO_GLOBAL_HOME", prev.home);
      setEnv("WUDAO_API_KEY", prev.key);
      setEnv("OPENAI_API_KEY", prev.okey);
    }
  });
});
