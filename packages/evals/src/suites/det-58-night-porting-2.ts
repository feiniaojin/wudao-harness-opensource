// det-58-night-porting-2 — the second debt-payment pass over the
// 2026-08-28 night-porting arc. det-57 pinned 010/011/012; the EARLIER
// ports (001-009) carry the same debt: package unit tests exist, but the
// behaviors never entered the release-eval matrix. Same rationale as
// det-44/det-57 — a regression slips past "someone happened to run that
// package's tests" unless the det suites pin it. Zero network, zero real
// credentials; the one wall-clock use is a 25ms tool timeout (002's own
// seam). Sections mirror the unit contracts verbatim — no invented
// expectations:
//
//   ① 001 interrupted-stream finalization — abort mid-stream commits the
//      delivered text prefix as an `interrupted` assistant message +
//      assistant_interrupted event; abort before any delta appends
//      nothing (legacy shape).
//   ② 002 generic tool timeout — a tool exceeding timeoutMs returns the
//      structured `[timeout after Nms]` error result and the run
//      completes on the model's next turn.
//   ③ 003 time reminder — the FIRST model call carries a projected
//      "[current time:" note in the user channel; the human history gets
//      no time notice (projection-only).
//   ④ 006 shell arity rules — askRuleFor never records the bare
//      tool (one approval ≠ every command): known head → head-prefix,
//      unknown/destructive → exact, compound → nothing; an approved
//      `git checkout main` pre-approves `git checkout -b feat` but not
//      `git status`.
//   ⑤ 007 key-pool status-classed cooldowns — 429→rate 60s, 401→auth
//      15min, 5xx→no cooldown, cross-class max-wins (fake clock).
//   ⑨ 009 session-rule receipts — the `a` answer's rule gets a receipt;
//      `always` stays single-notify (session copy recorded, no receipt).
//   ⑤* 005 session auto-title — sanitizeTitle caps in CODE POINTS
//      (CJK-safe) and drops noise; buildTitleRequest yields undefined
//      until an assistant answer exists.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runAgentLoop,
  buildTool,
  createScriptedModel,
  type AgentMessage,
  type LoopEvent,
  type Terminal,
  type ModelClient,
  type ModelInput,
  type Tool,
} from "@wudao-org/core";
import {
  createKeyPool,
  cooldownClassForStatus,
  DEFAULT_AUTH_COOLDOWN_MS,
  DEFAULT_KEY_COOLDOWN_MS,
} from "@wudao-org/providers";
import { createAgentDriver } from "wudao-harness/driver/agent-driver";
import { askRuleFor, decideRichPermission, recordAskRules } from "wudao-harness/permission";
import { summarizeToolCall } from "wudao-harness/log";
import { sanitizeTitle, buildTitleRequest, TITLE_MAX_CODEPOINTS } from "wudao-harness/session-title";
import type { EvalDefinition } from "../runner.js";

export interface NightPorting2Evidence {
  readonly root: string;
  // ① 夜移 001 — interrupted-stream finalization
  readonly abortMidPrefix?: string;
  readonly abortMidFlag?: boolean;
  readonly sawInterruptedEvent: boolean;
  readonly abortEarlyLen: number;
  // ② 夜移 002 — generic tool timeout
  readonly timeoutToolContent?: string;
  readonly timeoutToolIsError?: boolean;
  readonly timeoutRunReason?: string;
  // ③ 夜移 003 — time reminder projection
  readonly firstCallTailRole?: string;
  readonly firstCallTailHasTime: boolean;
  readonly humanSawTimeNotice: boolean;
  // ④ 夜移 006 — shell arity rules
  readonly ruleSimple?: string | null;
  readonly ruleHead?: string | null;
  readonly ruleDestructive?: string | null;
  readonly ruleCompound?: string | null;
  readonly ruleUnknown?: string | null;
  readonly ruleBareEver: boolean;
  readonly checkoutReplayAllowed: boolean;
  readonly checkoutSiblingAllowed: boolean;
  readonly npmInstallAllowed: boolean;
  // ⑤ 夜移 007 — key-pool status-classed cooldowns
  readonly class429?: string | null;
  readonly class401?: string | null;
  readonly class500?: string | null;
  readonly rateLapsesAt60s: boolean;
  readonly rateHoldsAt59s: boolean;
  readonly authHoldsAt60s: boolean;
  readonly authLapsesAt15min: boolean;
  readonly crossClassMaxWins: boolean;
  // ⑥ 夜移 009 — session-rule receipts
  readonly receiptAdded: string[];
  readonly receiptSessionOnly?: string | null;
  readonly receiptAlways?: string | null;
  readonly receiptAlwaysRecorded: string[];
  // ⑦ 夜移 005 — session auto-title hygiene
  readonly titleCappedCodePoints: number;
  readonly titleCappedHasLoneSurrogate: boolean;
  readonly titleFromQuotes?: string;
  readonly titleTrailingPunct?: string;
  readonly titleEmptyUndef: boolean;
  readonly titleReqWithoutAnswer: boolean;
  readonly titleReqExcerpts: boolean;
}

/** The 001 seam: a model that streams deltas then parks until the request's
 *  abort signal fires — the "user hit stop mid-stream" shape. */
function abortingStreamModel(deltas: Array<{ type: "text_delta"; text: string }>): ModelClient {
  return {
    generate: () => {
      throw new Error("should not be called");
    },
    async *stream(input: ModelInput) {
      for (const d of deltas) yield d;
      await new Promise<never>((_, reject) => {
        input.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
        );
      });
    },
  };
}

async function drain(gen: AsyncGenerator<LoopEvent, Terminal>): Promise<{ events: LoopEvent[]; terminal: Terminal }> {
  const events: LoopEvent[] = [];
  while (true) {
    const { done, value } = await gen.next();
    if (done) return { events, terminal: value };
    events.push(value);
  }
}

/** decideRichPermission returns a MIXED shape ("ask" bare string from some
 *  layers, {behavior} objects from others) — normalize for assertions. */
function behaviorOf(d: unknown): string {
  if (typeof d === "string") return d;
  if (d && typeof d === "object" && "behavior" in d) return String((d as { behavior: unknown }).behavior);
  return String(d);
}

export const det58Eval: EvalDefinition<{ readonly root: string }, NightPorting2Evidence> = {
  name: "det-58-night-porting-2",
  kind: "deterministic",
  async setup() {
    return { root: await mkdtemp(join(tmpdir(), "det58-night2-")) };
  },
  async run(ctx) {
    // ① 001 — abort mid-stream commits the delivered prefix.
    const controller = new AbortController();
    const midState = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" }] as AgentMessage[],
      tools: [],
      status: "idle" as const,
    };
    const midRun = drain(runAgentLoop(midState, abortingStreamModel([
      { type: "text_delta", text: "已经流出的" },
      { type: "text_delta", text: "部分回答" },
    ]), { signal: controller.signal, maxTurns: 3 }));
    await new Promise((r) => setTimeout(r, 10)); // park inside the model stream
    controller.abort();
    const { events: midEvents } = await midRun;
    const midLast = midState.messages.at(-1) as { content?: string; interrupted?: boolean } | undefined;
    const abortMidPrefix = midLast?.content;
    const abortMidFlag = midLast?.interrupted;
    const sawInterruptedEvent = midEvents.some((e) => e.type === "assistant_interrupted");
    // …and abort before any delta appends nothing (legacy shape).
    const earlyController = new AbortController();
    const earlyState = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" }] as AgentMessage[],
      tools: [],
      status: "idle" as const,
    };
    const earlyRun = drain(runAgentLoop(earlyState, abortingStreamModel([]), { signal: earlyController.signal, maxTurns: 3 }));
    await new Promise((r) => setTimeout(r, 10));
    earlyController.abort();
    await earlyRun;
    const abortEarlyLen = earlyState.messages.length;

    // ② 002 — a hanging tool with timeoutMs gets the structured timeout result.
    const hang = buildTool({
      name: "hang",
      description: "hangs forever",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: () => new Promise<{ content: string }>(() => {}),
      timeoutMs: 25,
    });
    const timeoutState = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" }] as AgentMessage[],
      tools: [hang],
      status: "idle" as const,
    };
    const { terminal: timeoutTerminal } = await drain(runAgentLoop(timeoutState, createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "hang", arguments: {} }] },
      { role: "assistant", content: "recovered" },
    ]), { maxTurns: 3 }));
    const timeoutMsg = timeoutState.messages.find((m) => m.role === "tool") as { content?: string; isError?: boolean } | undefined;
    const timeoutToolContent = timeoutMsg?.content;
    const timeoutToolIsError = timeoutMsg?.isError;
    const timeoutRunReason = timeoutTerminal.reason;

    // ③ 003 — the time reminder rides the first model call, never the human history.
    const seenInputs: AgentMessage[][] = [];
    const scripted = createScriptedModel([{ role: "assistant", content: "OK" }]);
    const captureModel: ModelClient = {
      generate: async (input) => {
        seenInputs.push([...input.messages]);
        return scripted.generate(input);
      },
    };
    const driver = createAgentDriver({
      model: captureModel,
      tools: [],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      workspaceRoot: ctx.root,
      onPermissionAsk: async () => ({ kind: "allow" }),
    });
    driver.submit("hi");
    for (let i = 0; i < 200 && !driver.getStatus().busy; i += 1) await new Promise((r) => setTimeout(r, 10));
    for (let i = 0; i < 500 && driver.getStatus().busy; i += 1) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 20));
    const firstCall = seenInputs[0] ?? [];
    const firstTail = firstCall[firstCall.length - 1] as { role?: string; content?: string } | undefined;
    const firstCallTailRole = firstTail?.role;
    const firstCallTailHasTime = typeof firstTail?.content === "string" && firstTail.content.includes("[current time:");
    const humanSawTimeNotice = driver.getHistory().some((e) => e.kind === "notice" && typeof (e as { text?: string }).text === "string" && ((e as { text: string }).text.includes("current time")));
    driver.dispose();

    // ④ 006 — arity rules: one approval is NEVER every command.
    const ruleSimple = askRuleFor("shell", { command: "ls" });
    const ruleHead = askRuleFor("shell", { command: "git checkout main" });
    const ruleDestructive = askRuleFor("shell", { command: "rm -rf /tmp/x" });
    const ruleCompound = askRuleFor("shell", { command: "git push && npm publish" });
    const ruleUnknown = askRuleFor("shell", { command: "python a.py" });
    const ruleBareEver = [ruleSimple, ruleHead, ruleDestructive, ruleCompound, ruleUnknown].includes("shell");
    // Pipeline: the recorded head-prefix rule pre-approves the SAME head's
    // other args, and the sibling command still asks.
    const sessionRules = ruleHead === null ? [] : [ruleHead];
    const allowed = (command: string): boolean =>
      behaviorOf(decideRichPermission({
        mode: "workspace", toolName: "shell", input: { command }, session: sessionRules,
      })) === "allow";
    const checkoutReplayAllowed = allowed("git checkout main");
    const checkoutSiblingAllowed = allowed("git checkout -b feat");
    // NOT `git status` — that one the 0.3.14 safe-command layer (4.7) allows
    // on its own, so it can't probe the rule boundary. `npm install` is
    // det-44's pinned must-ask command: allowed ONLY by an explicit rule.
    const npmInstallAllowed = allowed("npm install left-pad");

    // ⑤ 007 — status-classed cooldowns over a fake clock.
    const class429 = cooldownClassForStatus(429);
    const class401 = cooldownClassForStatus(401);
    const class500 = cooldownClassForStatus(500);
    let t = 0;
    const pool = createKeyPool(["A", "B"], { now: () => t });
    const picks = (): string[] => [pool.select(), pool.select()];
    // rate: holds at 59.999s, lapses at 60s.
    pool.markCooldown("A", "rate");
    t = DEFAULT_KEY_COOLDOWN_MS - 1;
    const rateHoldsAt59s = !picks().includes("A");
    t = DEFAULT_KEY_COOLDOWN_MS;
    const rateLapsesAt60s = picks().includes("A");
    // auth: still cooling at 60s, back at 15min.
    pool.markCooldown("A", "auth");
    t += DEFAULT_KEY_COOLDOWN_MS;
    const authHoldsAt60s = !picks().includes("A");
    t += DEFAULT_AUTH_COOLDOWN_MS;
    const authLapsesAt15min = picks().includes("A");
    // cross-class max-wins: a rate hit never shortens an auth cooldown.
    t = 0;
    pool.markCooldown("A", "auth");
    t = 1000;
    pool.markCooldown("A", "rate");
    t = DEFAULT_KEY_COOLDOWN_MS + 5_000; // past the rate window, deep inside auth — still cooling
    const crossClassMaxWins = !picks().includes("A");

    // ⑥ 009 — receipt parity for recorded session rules.
    const receiptAdded: string[] = [];
    const receiptSessionOnly = recordAskRules(
      { add: (r: string) => receiptAdded.push(r) },
      { sessionRule: "shell:git checkout", persistentRule: null },
    );
    const receiptAlwaysAdded: string[] = [];
    const receiptAlways = recordAskRules(
      { add: (r: string) => receiptAlwaysAdded.push(r) },
      { sessionRule: "write_file:src/a.ts", persistentRule: "write_file:src/a.ts" },
    );

    // ⑦ 005 — title hygiene (CJK-safe cap, noise drop, no-answer guard).
    const longTitle = "这是一个非常非常长的会话标题一定需要被截断到上限码点数以内才能算完成";
    const capped = sanitizeTitle(longTitle);
    const titleCappedCodePoints = capped === undefined ? -1 : Array.from(capped).length;
    const titleCappedHasLoneSurrogate = (capped ?? "").includes("�");
    const titleFromQuotes = sanitizeTitle(`  "修复登录超时 bug"  `);
    const titleTrailingPunct = sanitizeTitle("Fix login bug.");
    const titleEmptyUndef = sanitizeTitle("") === undefined && sanitizeTitle('  ""  ') === undefined;
    const titleReqWithoutAnswer = buildTitleRequest([{ role: "user", content: "hi" }]) === undefined;
    const big = "x".repeat(10_000);
    const bigReq = buildTitleRequest([
      { role: "user", content: big },
      { role: "assistant", content: big },
    ]);
    const titleReqExcerpts = bigReq !== undefined && bigReq.user.length < 2_200;

    return {
      root: ctx.root,
      abortMidPrefix, abortMidFlag, sawInterruptedEvent, abortEarlyLen,
      timeoutToolContent, timeoutToolIsError, timeoutRunReason,
      firstCallTailRole, firstCallTailHasTime, humanSawTimeNotice,
      ruleSimple, ruleHead, ruleDestructive, ruleCompound, ruleUnknown, ruleBareEver,
      checkoutReplayAllowed, checkoutSiblingAllowed, npmInstallAllowed,
      class429, class401, class500, rateHoldsAt59s, rateLapsesAt60s, authHoldsAt60s, authLapsesAt15min, crossClassMaxWins,
      receiptAdded, receiptSessionOnly, receiptAlways, receiptAlwaysRecorded: receiptAlwaysAdded,
      titleCappedCodePoints, titleCappedHasLoneSurrogate, titleFromQuotes, titleTrailingPunct,
      titleEmptyUndef, titleReqWithoutAnswer, titleReqExcerpts,
    };
  },
  assertions(e) {
    const errs: string[] = [];
    const need = (ok: boolean, msg: string) => { if (!ok) errs.push(msg); };

    // ① 001 — the delivered prefix commits as an interrupted message.
    need(e.abortMidPrefix === "已经流出的部分回答" && e.abortMidFlag === true,
      `① abort mid-stream must commit the delivered prefix with interrupted:true (got ${JSON.stringify(e.abortMidPrefix)}, flag=${String(e.abortMidFlag)})`);
    need(e.sawInterruptedEvent, "① an assistant_interrupted event must reach delta-blind frontends");
    need(e.abortEarlyLen === 1, `① abort before any delta appends nothing — legacy shape (got ${e.abortEarlyLen} messages)`);

    // ② 002 — structured timeout, run survives.
    need(typeof e.timeoutToolContent === "string" && e.timeoutToolContent.includes("[timeout after 25ms]"),
      `② the timed-out tool gets the structured result (got ${JSON.stringify(e.timeoutToolContent)})`);
    need(e.timeoutToolIsError === true, "② the timeout result is an error result (isError)");
    need(e.timeoutRunReason === "completed", `② the run completes after the timeout (got ${String(e.timeoutRunReason)})`);

    // ③ 003 — projection-only time grounding.
    need(e.firstCallTailRole === "user" && e.firstCallTailHasTime,
      `③ the first model call carries the projected [current time: note in the user channel (tail=${JSON.stringify(e.firstCallTailRole)}, hasTime=${String(e.firstCallTailHasTime)})`);
    need(!e.humanSawTimeNotice, "③ the human history never sees a time notice");

    // ④ 006 — arity rules; one approval is never every command.
    need(e.ruleSimple === "shell:ls", `④ ls records the arity-1 rule (got ${JSON.stringify(e.ruleSimple)})`);
    need(e.ruleHead === "shell:git checkout", `④ git checkout main records the arity-2 head (got ${JSON.stringify(e.ruleHead)})`);
    need(e.ruleDestructive === "shell:rm -rf /tmp/x", `④ destructive heads record EXACT (got ${JSON.stringify(e.ruleDestructive)})`);
    need(e.ruleCompound === null, `④ compound commands record NOTHING (got ${JSON.stringify(e.ruleCompound)})`);
    need(e.ruleUnknown === "shell:python a.py", `④ unknown heads record EXACT (got ${JSON.stringify(e.ruleUnknown)})`);
    need(!e.ruleBareEver, "④ no command ever records the bare shell (privilege-escalation hole)");
    need(e.checkoutReplayAllowed && e.checkoutSiblingAllowed,
      `④ the approved head-prefix covers replay and sibling args (replay=${String(e.checkoutReplayAllowed)}, sibling=${String(e.checkoutSiblingAllowed)})`);
    need(!e.npmInstallAllowed, "④ an unrelated must-ask command (det-44's npm install) is NOT swept in by the head rule");

    // ⑤ 007 — status-classed cooldowns.
    need(e.class429 === "rate" && e.class401 === "auth" && e.class500 === null,
      `⑤ class map 429→rate / 401→auth / 500→none (got ${String(e.class429)}/${String(e.class401)}/${String(e.class500)})`);
    need(e.rateHoldsAt59s && e.rateLapsesAt60s, `⑤ rate cooldown holds at 59.999s and lapses at 60s (holds=${String(e.rateHoldsAt59s)}, lapses=${String(e.rateLapsesAt60s)})`);
    need(e.authHoldsAt60s && e.authLapsesAt15min, `⑤ auth cooldown outlasts rate and lapses at 15min (holds60=${String(e.authHoldsAt60s)}, lapses=${String(e.authLapsesAt15min)})`);
    need(e.crossClassMaxWins, "⑤ cross-class max-wins: a later rate hit never shortens an auth cooldown");

    // ⑥ 009 — receipt parity.
    need(
      e.receiptAdded.length === 1 && e.receiptAdded[0] === "shell:git checkout"
        && e.receiptSessionOnly === 'permissions: session rule "shell:git checkout" — no more asks this session',
      `⑥ the a-answer records its scoped rule and returns the receipt (got ${JSON.stringify(e.receiptAdded)}/${JSON.stringify(e.receiptSessionOnly)})`,
    );
    need(
      e.receiptAlwaysRecorded.length === 1 && e.receiptAlways === null,
      `⑥ always records the session copy but stays single-notify (recorded=${JSON.stringify(e.receiptAlwaysRecorded)}, receipt=${JSON.stringify(e.receiptAlways)})`,
    );

    // ⑦ 005 — title hygiene.
    need(e.titleCappedCodePoints === TITLE_MAX_CODEPOINTS && !e.titleCappedHasLoneSurrogate,
      `⑦ the cap counts CODE POINTS, CJK-safe (got ${e.titleCappedCodePoints}/${TITLE_MAX_CODEPOINTS}, loneSurrogate=${String(e.titleCappedHasLoneSurrogate)})`);
    need(e.titleFromQuotes === "修复登录超时 bug" && e.titleTrailingPunct === "Fix login bug",
      `⑦ quote-wrapping strips and trailing punctuation drops (got ${JSON.stringify(e.titleFromQuotes)}/${JSON.stringify(e.titleTrailingPunct)})`);
    need(e.titleEmptyUndef, "⑦ empty/quote-only input yields undefined");
    need(e.titleReqWithoutAnswer && e.titleReqExcerpts,
      `⑦ no assistant answer → no title call; excerpts stay tiny (noAnswer=${String(e.titleReqWithoutAnswer)}, tiny=${String(e.titleReqExcerpts)})`);

    return errs;
  },
};
