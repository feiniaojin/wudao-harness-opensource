// ---------------------------------------------------------------------------
// det-47 (M60) — the Slack interface end to end through the REAL machinery:
// the shared driver session engine (createDriverSession — the exact code
// `wudao ui` runs) driven by the channel manager over a scripted fake
// InboundChannel, with REAL tools, REAL JSONL persistence, and the REAL ask
// relay. Pins (spec §验收): mapping persistence + restart reuse; dual-
// allowlist silent drop; busy→steering vs idle→prompt (JSONL entries
// asserted); ask→allow/always/deny/timeout-deny four paths + the bypass-
// immune step's missing "always"; interactive tools disabled with the
// refusal; thread-context truncation (the model sees it, the JSONL never
// does); summary md→mrkdown conversion; the InboundChannel contract.
// ---------------------------------------------------------------------------
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput } from "@wudao-org/core";
import type { AgentDriver } from "wudao-harness/driver/agent-driver";
import type { SessionAllowlist } from "wudao-harness/permission";
import {
  allowlistsPass,
  buildAskBlocks,
  createChannelSessionManager,
  createSlackRefusalAskUserTool,
  DEFAULT_SLACK_SETTINGS,
  ASK_ACTION_ALWAYS,
  loadThreadMap,
  mdToMrkdown,
} from "@wudao-org/slack";
import { createDriverSession } from "wudao-harness/driver/session-engine";
import type { EvalDefinition } from "../runner.js";

interface Det47Evidence {
  readonly drops: { readonly userDropped: boolean; readonly channelDropped: boolean; readonly noReply: boolean };
  readonly steer: {
    readonly idlePromptRan: boolean;
    readonly jsonlUserEntries: readonly string[];
    readonly secondCallSawSteer: boolean;
    readonly steeringReply: boolean;
  };
  readonly ask: {
    readonly allowToolRan: boolean;
    readonly denyFedBack: boolean;
    readonly timeoutDenied: boolean;
    readonly askCount: number;
  };
  readonly alwaysLane: { readonly ruleRecorded: boolean; readonly secondAskFree: boolean; readonly secondWriteRan: boolean };
  readonly bypass: {
    readonly noAlwaysButton: boolean;
    readonly askedTwice: boolean;
    readonly allowlistClean: boolean;
  };
  readonly interactive: { readonly refused: boolean; readonly hintNamesSlack: boolean };
  readonly threadCtx: { readonly modelSawDigest: boolean; readonly truncated: boolean; readonly jsonlClean: boolean };
  readonly mrkdown: { readonly header: string; readonly bold: string; readonly link: string; readonly broadcast: string };
  readonly summary: { readonly posted: boolean; readonly converted: boolean; readonly sessionLink: boolean };
  readonly contract: { readonly started: boolean; readonly messageRouted: boolean; readonly commandRouted: boolean };
  readonly mapping: { readonly persisted: boolean; readonly reusedSessionId: string | undefined; readonly resumed: readonly string[] };
}

type AskScript = readonly ("allow" | "always" | "deny" | "timeout")[];

/** A scripted fake InboundChannel: asks answer from a queue, every call is
 *  recorded; send() routes /slack commands exactly like the Slack impl. */
function det47Channel(askScript: AskScript) {
  const replies: { text: string; sessionId?: string }[] = [];
  const askPrompts: { toolName: string; protectedFile?: string }[] = [];
  const state = {
    handlers: null as null | {
      onMessage(m: Record<string, unknown>): unknown;
      onCommand(c: { name: string; args?: readonly string[]; message: Record<string, unknown> }): unknown;
    },
    digest: "",
    started: false,
  };
  let cursor = 0;
  const channel = {
    name: "det47",
    async start(h: unknown) {
      state.handlers = h as typeof state.handlers;
      state.started = true;
    },
    async stop() {},
    async reply(_t: unknown, text: string, opts?: { sessionId?: string }) {
      replies.push({ text, ...(opts?.sessionId !== undefined ? { sessionId: opts.sessionId } : {}) });
    },
    async relayAsk(_t: unknown, prompt: { toolName: string; protectedFile?: string }) {
      askPrompts.push({ toolName: prompt.toolName, ...(prompt.protectedFile !== undefined ? { protectedFile: prompt.protectedFile } : {}) });
      const next = askScript[cursor];
      cursor += 1;
      return next ?? "deny";
    },
    async threadContext() {
      return state.digest;
    },
  };
  const send = async (m: Record<string, unknown>): Promise<void> => {
    const text = String(m["text"] ?? "");
    if (text.trim().startsWith("/slack")) {
      const parts = text.trim().split(/\s+/);
      await state.handlers?.onCommand({ name: parts[1] ?? "status", args: [], message: m });
      return;
    }
    await state.handlers?.onMessage(m);
  };
  return { channel, replies, askPrompts, state, send };
}

/** A model whose every call parks until the test releases it — the run stays
 *  busy so a mid-run follow-up lands in the steering queue exactly as in
 *  production, and the model's inputs are fully observable. */
function det47GatedModel() {
  const inputs: ModelInput[] = [];
  const waiters: ((m: AssistantMessage) => void)[] = [];
  const queued: AssistantMessage[] = [];
  const model: ModelClient = {
    async generate(input) {
      inputs.push(input);
      return await new Promise<AssistantMessage>((resolve) => {
        const buffered = queued.shift();
        if (buffered !== undefined) resolve(buffered);
        else waiters.push(resolve);
      });
    },
  };
  return {
    model,
    inputs,
    release: (m: AssistantMessage) => {
      const w = waiters.shift();
      if (w !== undefined) w(m);
      else queued.push(m); // released before the call parked — buffer it
    },
  };
}

async function det47Wait(probe: () => boolean, label: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (probe()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`det-47: timed out waiting for ${label}`);
}

/** The persisted user prompts in a session JSONL (branch entries skipped). */
function det47UserEntries(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const e = JSON.parse(line) as { role?: string; content?: string };
      if (e.role === "user" && typeof e.content === "string") out.push(e.content);
    } catch {
      // non-message entries (model_change, thinking_level_change, …)
    }
  }
  return out;
}

const DET47_SETTINGS = {
  ...DEFAULT_SLACK_SETTINGS,
  enabled: true,
  allowedUsers: ["U_OK"],
  allowedChannels: ["C_OK"],
  askTimeoutMs: 400,
  threadContextMaxChars: 8000,
};

const DET47_CONFIG = { apiKey: "det47-key", baseURL: "http://127.0.0.1:9", model: "det47-model" } as const;

/** Wire one manager over the REAL session engine (per-scenario model + ask
 *  script). `wrapDriver` lets the reuse scenario observe resume() calls. */
async function det47Wire(args: {
  readonly workspace: string;
  readonly model: ModelClient;
  readonly askScript: AskScript;
  readonly digest?: string;
  readonly wrapDriver?: (d: AgentDriver) => AgentDriver;
}) {
  const fc = det47Channel(args.askScript);
  fc.state.digest = args.digest ?? "";
  const map = await loadThreadMap(args.workspace, () => {});
  const captured: { driver?: AgentDriver; allowlist?: SessionAllowlist } = {};
  const manager = createChannelSessionManager({
    settings: DET47_SETTINGS,
    channel: fc.channel,
    threadMap: map,
    createSession: async ({ sessionId, askRelay }) => {
      const session = await createDriverSession({
        config: DET47_CONFIG,
        workspaceRoot: args.workspace,
        contextWindowTokens: 32_000,
        modelOverride: args.model,
        ...(sessionId !== undefined ? { sessionId } : {}),
        askRelay,
        // M60 §3: the refusal ask_user rides the top level (as in production).
        topLevelTools: [createSlackRefusalAskUserTool()],
        startupNotice: () => {},
        // The M23 verify gate would nudge the run past its scripted final
        // answer (writes happened, nothing ran) — this suite pins the Slack
        // flow, not the gates; production keeps the defaults.
        gates: { verify: false },
      });
      // Mirror main.ts: the settings mode applies over the engine's
      // workspace boot (a REMOTE surface starts ask — det-47 pins the ask
      // flow, so the old implicit ask-per-tool boot must be restored here).
      session.driver.setMode(DET47_SETTINGS.defaultPermissionMode);
      captured.driver = args.wrapDriver ? args.wrapDriver(session.driver) : session.driver;
      captured.allowlist = session.allowlist;
      return { driver: captured.driver };
    },
  });
  await manager.start();
  return { fc, map, manager, captured };
}

const det47Eval: EvalDefinition<{ dir: string }, Det47Evidence> = {
  name: "det-47-m60-slack",
  kind: "deterministic",
  async setup(dir) {
    return { dir };
  },
  async run(ctx) {
    const { dir } = ctx;
    await mkdir(join(dir, ".wudao"), { recursive: true });
    await mkdir(join(dir, "out"), { recursive: true });
    const reuseDir = join(dir, "reuse-ws");
    await mkdir(join(reuseDir, ".wudao"), { recursive: true });

    // -- 1) dual-allowlist silent drop --------------------------------------
    const g = det47GatedModel();
    const digestMarker = "DET47_DIGEST_";
    const digest = `${digestMarker}${"d".repeat(9000)}`;
    const w1 = await det47Wire({ workspace: dir, model: g.model, askScript: ["allow", "deny", "timeout", "always", "always"], digest });
    await w1.fc.send({ userId: "U_BAD", channel: "C_OK", ts: "900.000", text: "let me in", mentioned: true });
    await w1.fc.send({ userId: "U_OK", channel: "C_BAD", ts: "901.000", text: "wrong room", mentioned: true });
    const drops = {
      userDropped: !allowlistsPass(DET47_SETTINGS, "U_BAD", "C_OK"),
      channelDropped: !allowlistsPass(DET47_SETTINGS, "U_OK", "C_BAD"),
      noReply: w1.fc.replies.length === 0,
    };

    // -- 2) the main thread: mention → prompt; busy → steering ---------------
    await w1.fc.send({ userId: "U_OK", channel: "C_OK", ts: "200.000", text: "write the report", mentioned: true });
    await det47Wait(() => w1.captured.driver !== undefined, "session creation");
    const d = w1.captured.driver!;
    await det47Wait(() => d.getStatus().busy, "run start");
    const idlePromptRan = true; // the mention became the run's first prompt
    // Mid-run follow-up (no mention — the thread binding IS the intent).
    await w1.fc.send({ userId: "U_OK", channel: "C_OK", threadTs: "200.000", ts: "201.000", text: "and add a table" });
    const steeringReply = w1.fc.replies.some((r) => r.text.includes("steering"));

    // Call 1 → write_file (normal path): ask → ALLOW → the tool runs.
    g.release({ role: "assistant", content: "writing", toolCalls: [{ id: "c1", name: "write_file", arguments: { path: "out/report.txt", content: "R1" } }] });
    await det47Wait(() => g.inputs.length >= 2, "model call 2 (post-allow)");
    const allowToolRan = (await readFile(join(dir, "out", "report.txt"), "utf8").catch(() => "")) === "R1";
    // The steer drained before call 2 (M18 semantics).
    const secondCallSawSteer = JSON.stringify(g.inputs[1]?.messages ?? []).includes("and add a table");
    // Call 2 → ask_user: interactive tools refuse with the ask-in-Slack hint.
    g.release({ role: "assistant", content: "asking", toolCalls: [{ id: "c2", name: "ask_user", arguments: { question: "which format?" } }] });
    await det47Wait(() => g.inputs.length >= 3, "model call 3 (post-ask_user)");
    const afterAskUser = JSON.stringify(g.inputs[2]?.messages ?? []);
    const interactive = {
      refused: afterAskUser.includes("disabled in Slack-driven sessions"),
      hintNamesSlack: afterAskUser.includes("Slack thread"),
    };
    // Call 3 → write_file DENIED: the reason feeds back to the model.
    g.release({ role: "assistant", content: "again", toolCalls: [{ id: "c3", name: "write_file", arguments: { path: "out/denied.txt", content: "X" } }] });
    await det47Wait(() => g.inputs.length >= 4, "model call 4 (post-deny)");
    const denyFedBack = JSON.stringify(g.inputs[3]?.messages ?? []).includes("permission denied: user denied");
    // Call 4 → write_file TIMEOUT: fail-closed deny, reason visible.
    g.release({ role: "assistant", content: "once more", toolCalls: [{ id: "c4", name: "write_file", arguments: { path: "out/timeout.txt", content: "T" } }] });
    await det47Wait(() => g.inputs.length >= 5, "model call 5 (post-timeout)");
    const afterTimeout = JSON.stringify(g.inputs[4]?.messages ?? []);
    const timeoutDenied = afterTimeout.includes("permission denied") && afterTimeout.includes("fail-closed");
    // Calls 5/6 → the PROTECTED write (.wudao/settings.json) twice: "always"
    // must degrade to allow-once (no rule), so the second write ASKS again.
    g.release({ role: "assistant", content: "policy", toolCalls: [{ id: "c5", name: "write_file", arguments: { path: ".wudao/settings.json", content: "{}" } }] });
    await det47Wait(() => g.inputs.length >= 6, "model call 6 (post-bypass)");
    g.release({ role: "assistant", content: "policy again", toolCalls: [{ id: "c6", name: "write_file", arguments: { path: ".wudao/settings.json", content: "{}" } }] });
    await det47Wait(() => g.inputs.length >= 7, "model call 7 (post-bypass-2)");
    // Final: a plain answer ends the run.
    g.release({ role: "assistant", content: "# Done\n**shipped** — see [the report](https://example.com/r)" });
    await det47Wait(() => !d.getStatus().busy, "run end");

    const bypassPrompts = w1.fc.askPrompts.filter((p) => p.protectedFile !== undefined);
    const bypass = {
      noAlwaysButton: bypassPrompts.every((p) => {
        const blocks = buildAskBlocks({ toolName: p.toolName, summary: "s", protectedFile: p.protectedFile }, "det47");
        return !JSON.stringify(blocks).includes(ASK_ACTION_ALWAYS);
      }),
      askedTwice: bypassPrompts.length >= 2,
      allowlistClean: (w1.captured.allowlist?.rules() ?? []).every((r) => !r.includes("settings")),
    };

    // The thread digest rode call 1 (projection-only); the JSONL stays clean.
    const sid = d.getSessionId();
    const jsonlPath = join(dir, ".wudao", "sessions", `${sid}.jsonl`);
    let jsonl = "";
    for (let i = 0; i < 400 && jsonl === ""; i += 1) {
      jsonl = await readFile(jsonlPath, "utf8").catch(() => "");
      if (jsonl === "") await new Promise((r) => setTimeout(r, 15));
    }
    const firstInput = JSON.stringify(g.inputs[0] ?? {});
    const threadCtx = {
      modelSawDigest: firstInput.includes(digestMarker),
      truncated: firstInput.includes("线程上下文截断") && !firstInput.includes(`${digestMarker}${"d".repeat(9000)}`),
      jsonlClean: !jsonl.includes(digestMarker),
    };
    const jsonlUserEntries = det47UserEntries(jsonl);

    // -- 3) the summary post-back (md → mrkdown + the session link) ----------
    const summaryReply = w1.fc.replies.find((r) => r.text.includes("shipped"));
    const summary = {
      posted: summaryReply !== undefined,
      converted: summaryReply !== undefined && summaryReply.text.includes("*Done*") && summaryReply.text.includes("<https://example.com/r|the report>"),
      sessionLink: summaryReply !== undefined && summaryReply.text.includes("wudao --resume"),
    };
    await w1.manager.stop();

    // -- 4) the "always" lane (fresh thread): rule records, second ask-free --
    const g2 = det47GatedModel();
    const w2 = await det47Wire({ workspace: dir, model: g2.model, askScript: ["always"] });
    await w2.fc.send({ userId: "U_OK", channel: "C_OK", ts: "300.000", text: "always allow this one", mentioned: true });
    await det47Wait(() => w2.captured.driver !== undefined && w2.captured.driver.getStatus().busy, "always-lane run start");
    g2.release({ role: "assistant", content: "w", toolCalls: [{ id: "k1", name: "write_file", arguments: { path: "out/always.txt", content: "A" } }] });
    await det47Wait(() => g2.inputs.length >= 2, "always-lane call 2");
    g2.release({ role: "assistant", content: "w2", toolCalls: [{ id: "k2", name: "write_file", arguments: { path: "out/always.txt", content: "B" } }] });
    await det47Wait(() => g2.inputs.length >= 3, "always-lane call 3");
    g2.release({ role: "assistant", content: "done" });
    await det47Wait(() => !w2.captured.driver!.getStatus().busy, "always-lane run end");
    const alwaysLane = {
      ruleRecorded: (w2.captured.allowlist?.rules() ?? []).some((r) => r.startsWith("write_file:")),
      secondAskFree: w2.fc.askPrompts.length === 1,
      secondWriteRan: (await readFile(join(dir, "out", "always.txt"), "utf8").catch(() => "")) === "B",
    };

    // -- 5) the InboundChannel contract: message + command routing -----------
    await w2.fc.send({ userId: "U_OK", channel: "C_OK", ts: "310.000", text: "/slack status", mentioned: true });
    const commandRouted = w2.fc.replies.some((r) => r.text.includes("wudao slack"));
    await w2.manager.stop();
    const contract = { started: w2.fc.state.started, messageRouted: jsonlUserEntries.includes("write the report"), commandRouted };

    // -- 6) mapping persistence + restart reuse (own workspace) --------------
    const resumedCalls: string[] = [];
    const wrapResume = (drv: AgentDriver): AgentDriver => ({
      ...drv,
      async resume(id: string) {
        resumedCalls.push(id);
        return await drv.resume(id);
      },
    });
    const g3 = det47GatedModel();
    const w3 = await det47Wire({ workspace: reuseDir, model: g3.model, askScript: [], wrapDriver: wrapResume });
    await w3.fc.send({ userId: "U_OK", channel: "C_OK", ts: "500.000", text: "first binding", mentioned: true });
    await det47Wait(() => w3.captured.driver !== undefined && w3.captured.driver.getStatus().busy, "reuse run start");
    g3.release({ role: "assistant", content: "ok" });
    await det47Wait(() => !w3.captured.driver!.getStatus().busy, "reuse run end");
    const firstSessionId = w3.captured.driver!.getSessionId();
    await w3.manager.stop();
    // A brand-new daemon (fresh map from the FILE + fresh manager) rebinds
    // the thread to the SAME session and adopts its history.
    const g4 = det47GatedModel();
    const w4 = await det47Wire({ workspace: reuseDir, model: g4.model, askScript: [], wrapDriver: wrapResume });
    await w4.fc.send({ userId: "U_OK", channel: "C_OK", threadTs: "500.000", ts: "501.000", text: "continue the same session", mentioned: false });
    await det47Wait(() => resumedCalls.length >= 1, "restart resume call");
    await w4.manager.stop();
    const reuseMap = await loadThreadMap(reuseDir, () => {});
    const mapping = {
      persisted: reuseMap.get("C_OK:500.000") === firstSessionId,
      reusedSessionId: reuseMap.get("C_OK:500.000"),
      resumed: [...resumedCalls],
    };

    return {
      drops,
      steer: { idlePromptRan, jsonlUserEntries, secondCallSawSteer, steeringReply },
      ask: {
        allowToolRan,
        denyFedBack,
        timeoutDenied,
        askCount: w1.fc.askPrompts.length,
      },
      alwaysLane,
      bypass,
      interactive,
      threadCtx,
      mrkdown: {
        header: mdToMrkdown("# T"),
        bold: mdToMrkdown("**b**"),
        link: mdToMrkdown("[l](https://x.y)"),
        // F4: relayed text can never post as a real broadcast mention.
        broadcast: mdToMrkdown("hi <!channel>"),
      },
      summary,
      contract,
      mapping,
    };
  },
  assertions(evidence) {
    const errors: string[] = [];
    const e = evidence;
    if (!e.drops.userDropped || !e.drops.channelDropped) errors.push("drops: BOTH allowlist sides must gate");
    if (!e.drops.noReply) errors.push("drops: a dropped sender must get NO reply (silent drop)");
    if (!e.steer.idlePromptRan) errors.push("steer: the idle mention must start the run");
    if (!e.steer.secondCallSawSteer) errors.push("steer: the mid-run follow-up must drain into model call 2 (M18)");
    if (!e.steer.steeringReply) errors.push("steer: the ⏳ steering receipt must post back");
    if (!e.steer.jsonlUserEntries.includes("write the report")) errors.push("steer: the JSONL must carry the first prompt");
    if (!e.steer.jsonlUserEntries.includes("and add a table")) errors.push("steer: the JSONL must carry the steered prompt");
    if (!e.ask.allowToolRan) errors.push("ask/allow: the allowed tool must run and write the file");
    if (!e.ask.denyFedBack) errors.push("ask/deny: `permission denied: user denied` must feed back to the model");
    if (!e.ask.timeoutDenied) errors.push("ask/timeout: the timeout must deny fail-closed with the reason visible to the model");
    if (!e.alwaysLane.ruleRecorded) errors.push("ask/always: the session rule must record (write_file:…)");
    if (!e.alwaysLane.secondAskFree) errors.push("ask/always: the second identical call must NOT ask again");
    if (!e.alwaysLane.secondWriteRan) errors.push("ask/always: the second (auto-allowed) write must execute");
    if (!e.bypass.noAlwaysButton) errors.push("bypass: the protected ask must not offer 本会话总是");
    if (!e.bypass.askedTwice) errors.push('bypass: an "always" on a protected write must not whitelist it — the second write asks again');
    if (!e.bypass.allowlistClean) errors.push("bypass: no session rule may cover the settings file");
    if (!e.interactive.refused) errors.push("interactive: ask_user must refuse with an error result");
    if (!e.interactive.hintNamesSlack) errors.push("interactive: the refusal must point the model at the Slack thread");
    if (!e.threadCtx.modelSawDigest) errors.push("threadCtx: the first model call must see the thread digest");
    if (!e.threadCtx.truncated) errors.push("threadCtx: the digest must be truncated (marker present, full body absent)");
    if (!e.threadCtx.jsonlClean) errors.push("threadCtx: the digest is projection-only — the JSONL must never contain it");
    if (e.mrkdown.header !== "*T*") errors.push(`mrkdown: header conversion, got ${e.mrkdown.header}`);
    if (e.mrkdown.bold !== "*b*") errors.push(`mrkdown: bold conversion, got ${e.mrkdown.bold}`);
    if (e.mrkdown.link !== "<https://x.y|l>") errors.push(`mrkdown: link conversion, got ${e.mrkdown.link}`);
    if (e.mrkdown.broadcast !== "hi &lt;!channel&gt;") errors.push(`mrkdown: broadcast escaping (F4), got ${e.mrkdown.broadcast}`);
    if (!e.summary.posted || !e.summary.converted || !e.summary.sessionLink) {
      errors.push(`summary: posted=${e.summary.posted} converted=${e.summary.converted} link=${e.summary.sessionLink}`);
    }
    if (!e.contract.started) errors.push("contract: the channel must start");
    if (!e.contract.messageRouted) errors.push("contract: onMessage must route into the session");
    if (!e.contract.commandRouted) errors.push("contract: onCommand must route /slack status to a reply");
    if (!e.mapping.persisted || e.mapping.reusedSessionId === undefined) errors.push("mapping: the binding must persist to .wudao/slack-threads.json");
    if (!e.mapping.resumed.includes(e.mapping.reusedSessionId ?? "")) errors.push("mapping: a restarted daemon must resume the SAME session for the thread");
    return errors;
  },
  metrics(evidence) {
    return {
      askPaths: [evidence.ask.allowToolRan, evidence.ask.denyFedBack, evidence.ask.timeoutDenied, evidence.alwaysLane.ruleRecorded].filter(Boolean).length,
      jsonlUserEntries: evidence.steer.jsonlUserEntries.length,
      threadBindings: evidence.mapping.persisted ? 1 : 0,
    };
  },
};

export { det47Eval };
