import { describe, it, expect } from "vitest";
import {
  runAgentLoop,
  MAX_TURN_RECOVERY_ATTEMPTS,
  TURN_RECOVERY_NOTE,
  type LoopEvent,
  type Terminal,
} from "../src/loop.js";
import type { ModelClient, ModelInput, ModelStreamEvent } from "../src/model-client.js";
import type { AgentMessage, AssistantMessage } from "../src/types.js";

// ω99-11 (ω99-9 边界收口): the overflow ladder's three INNER retry legs —
// clip / compact-resend / emergency — each called callModel directly, so a
// transport failure after a leg had already delivered deltas escaped the
// ω99-9 arm (its for(;;) wrapped only the main call), pierced the leg's
// catch, and killed the run with the streamed prefix vaporized. The shared
// callModelWithTurnRecovery helper now wraps ALL FOUR call sites with
// identical semantics: commit the delivered prefix, append the frozen
// TURN_RECOVERY_NOTE, resend append-only — with the recovery budget SHARED
// per turn across legs, turn_retried naming which leg dropped (additive
// `leg`), and the one-cap rule (a leg input carrying maxTokens keeps it on
// the resend). Overflow-family / BackgroundOverloadError / budget
// exhaustion keep their original propagation (the ladder owns them); abort
// rethrows for the leg/main catch to finalize — the single finalize point.

async function drain(
  gen: AsyncGenerator<LoopEvent, Terminal>,
  out?: LoopEvent[],
): Promise<Terminal> {
  while (true) {
    const { done, value } = await gen.next();
    if (done) return value;
    out?.push(value);
  }
}

/** One scripted streaming call: yield `events`, then either die with `die`
 *  (the mid-stream failure) or complete with `done`. Self-contained copy of
 *  the ω99-9 harness shape — test files never import each other. */
interface ScriptedCall {
  readonly events: ModelStreamEvent[];
  readonly die?: Error;
  readonly done?: AssistantMessage;
}

/** What the loop actually sent: a deep snapshot of each ModelInput's prompt
 *  side (messages are the LIVE state array — the M24 assertions need the
 *  bytes as they went out). */
interface CapturedInput {
  readonly systemPrompt: string;
  readonly maxTokens: number | undefined;
  readonly messages: AgentMessage[];
}

function scriptedModel(
  script: readonly ScriptedCall[],
): ModelClient & { captures: CapturedInput[] } {
  const captures: CapturedInput[] = [];
  let call = 0;
  return {
    captures,
    generate: () => {
      throw new Error("should not be called");
    },
    async *stream(input: ModelInput) {
      captures.push({
        systemPrompt: input.systemPrompt,
        maxTokens: input.maxTokens,
        messages: JSON.parse(JSON.stringify(input.messages)) as AgentMessage[],
      });
      const s = script[call];
      call += 1;
      if (s === undefined) throw new Error(`script exhausted at call ${call}`);
      for (const ev of s.events) yield ev;
      if (s.die !== undefined) throw s.die;
      yield { type: "done", message: s.done ?? { role: "assistant", content: "" } };
    },
  };
}

function freshState(messages?: AgentMessage[]) {
  return {
    systemPrompt: "s",
    messages: messages ?? ([{ role: "user", content: "go" }] as AgentMessage[]),
    tools: [],
    status: "idle" as const,
  };
}

const socketHangUp = (tag: string) => new Error(`socket hang up ${tag}`);

/** A duck-typed ContextLengthError with the ω-2b trusted-parse observation
 *  (the shape that makes the window learnable / the ladder armable). */
const contextLengthError = (
  observed?: { promptTokens: number; windowTokens: number },
): Error =>
  Object.assign(new Error("provider context length exceeded: 400 too big"), {
    name: "ContextLengthError",
    status: 400,
    ...(observed !== undefined ? { observed } : {}),
  });

/** 64_000 − 40_000 − 8_192 = 15_808 — the ω-2b (ii) clip-retry arithmetic. */
const PHYSICAL = 64_000 - 40_000 - 8_192;

const canon = (ms: readonly AgentMessage[]): string => JSON.stringify(ms);

const legEventOrder = (events: readonly LoopEvent[]): string[] =>
  events
    .filter((e) =>
      e.type === "assistant_interrupted" || e.type === "turn_retried" || e.type === "context_recovery")
    .map((e) => e.type);

describe("inner-leg recovery (ω99-11)", () => {
  it("⑪ clip leg: a mid-stream drop inside the clip-retry is recovered — cap kept alive, append-only resend, leg observable", async () => {
    const model = scriptedModel([
      // call 1 (main): pre-delta overflow with a trusted parse → the ladder
      // arms the clip-retry (physical = 15_808 ≥ MIN_CLIP_TOKENS).
      { events: [], die: contextLengthError({ promptTokens: 40_000, windowTokens: 64_000 }) },
      // call 2 (CLIP leg): deltas delivered, then the transport dies — the
      // old code let this error pierce the leg's catch and kill the run.
      { events: [{ type: "text_delta", text: "clip 腿已流出" }], die: socketHangUp("clip") },
      // call 3: the recovery resend completes the turn.
      { events: [], done: { role: "assistant", content: "clip 腿续写完成" } },
    ]);
    const state = freshState();
    const events: LoopEvent[] = [];
    const terminal = await drain(
      runAgentLoop(state, model, {
        maxTurns: 3,
        gates: { todo: false, verify: false },
        compaction: { contextWindowTokens: 64_000 },
      }),
      events,
    );

    expect(terminal.reason).toBe("completed");
    expect(model.captures.length).toBe(3);
    // 帽保活 (§2 one-cap rule): the leg's input carried the physical cap …
    expect(model.captures[1]?.maxTokens).toBe(PHYSICAL);
    // … and the rebuilt recovery resend copies it back (buildModelInput is
    // cap-free here; only the helper's copy rule keeps the cap alive).
    expect(model.captures[2]?.maxTokens).toBe(PHYSICAL);
    // Append-only (⑧-shaped): the resend keeps the leg request's bytes as a
    // frozen prefix, appending exactly (interrupted partial, note).
    const legReq = model.captures[1]!;
    const resend = model.captures[2]!;
    expect(canon(resend.messages.slice(0, legReq.messages.length))).toBe(canon(legReq.messages));
    expect(resend.messages.at(-2)).toMatchObject({
      role: "assistant",
      content: "clip 腿已流出",
      interrupted: true,
    });
    expect(resend.messages.at(-1)).toMatchObject({ role: "user", content: TURN_RECOVERY_NOTE });
    // Event order: the committed prefix, the leg-tagged retry, THEN the
    // ladder's own clip recovery event (fired by the leg's success).
    expect(legEventOrder(events)).toEqual([
      "assistant_interrupted", "turn_retried", "context_recovery",
    ]);
    expect(events.find((e) => e.type === "turn_retried")).toMatchObject({
      attempt: 1,
      leg: "clip",
    });
    expect(events.find((e) => e.type === "context_recovery")).toMatchObject({
      kind: "clip",
      maxTokens: PHYSICAL,
    });
    // The live history carries the interrupted partial and the note.
    expect(state.messages[1]).toMatchObject({
      role: "assistant",
      content: "clip 腿已流出",
      interrupted: true,
    });
    expect(state.messages[2]).toMatchObject({ role: "user", content: TURN_RECOVERY_NOTE });
    expect(state.messages.at(-1)).toMatchObject({ role: "assistant", content: "clip 腿续写完成" });
  });

  it("⑫ compact leg: a mid-stream drop inside the compact-resend is recovered — cap-free resend, append-only, leg:'compact'", async () => {
    const model = scriptedModel([
      // call 1 (main): a trusted parse that leaves NO usable clip budget
      // (physical = 64_000 − 63_000 − 8_192 < 0) → the reactive compact arm.
      { events: [], die: contextLengthError({ promptTokens: 63_000, windowTokens: 64_000 }) },
      // call 2 (COMPACT-resend leg): deltas, then the transport dies.
      { events: [{ type: "text_delta", text: "compact 腿已流出" }], die: socketHangUp("compact") },
      // call 3: the recovery resend completes the turn.
      { events: [], done: { role: "assistant", content: "compact 腿续写完成" } },
    ]);
    // LADDER_MESSAGES shape (ω-2b (iii)): tier-2 has a compactable span, so
    // the reactive compact fires observably (no summarizer call — the
    // default zero-LLM digest; that is why the script has exactly 3 calls).
    const state = freshState([
      { role: "user", content: "task one " + "x".repeat(400) },
      { role: "assistant", content: "answer one " + "x".repeat(400) },
      { role: "user", content: "go" },
    ]);
    const events: LoopEvent[] = [];
    const terminal = await drain(
      runAgentLoop(state, model, {
        maxTurns: 3,
        gates: { todo: false, verify: false },
        compaction: { contextWindowTokens: 64_000, keepRecent: 1 },
      }),
      events,
    );

    expect(terminal.reason).toBe("completed");
    expect(model.captures.length).toBe(3);
    // 腿无帽语义: the compact leg resends cap-free, and the one-cap rule does
    // not invent a cap on the recovery resend (input had none → keep none).
    expect(model.captures[1]?.maxTokens).toBeUndefined();
    expect(model.captures[2]?.maxTokens).toBeUndefined();
    const legReq = model.captures[1]!;
    const resend = model.captures[2]!;
    expect(canon(resend.messages.slice(0, legReq.messages.length))).toBe(canon(legReq.messages));
    expect(resend.messages.at(-2)).toMatchObject({
      role: "assistant",
      content: "compact 腿已流出",
      interrupted: true,
    });
    expect(resend.messages.at(-1)).toMatchObject({ role: "user", content: TURN_RECOVERY_NOTE });
    expect(legEventOrder(events)).toEqual([
      "assistant_interrupted", "turn_retried", "context_recovery",
    ]);
    expect(events.find((e) => e.type === "turn_retried")).toMatchObject({
      attempt: 1,
      leg: "compact",
    });
    // The kind names the tier that recovered the turn (按夹件实际 — the
    // tier-2 digest compacted observably before the leg resend).
    expect(events.find((e) => e.type === "context_recovery")).toMatchObject({ kind: "compacted" });
    expect(state.messages.some((m) => m.role === "assistant" && m.content === "compact 腿已流出" && m.interrupted === true)).toBe(true);
    expect(state.messages.some((m) => m.role === "user" && m.content === TURN_RECOVERY_NOTE)).toBe(true);
    expect(state.messages.at(-1)).toMatchObject({ role: "assistant", content: "compact 腿续写完成" });
  });

  it("⑬ emergency leg: a mid-stream drop inside the emergency retry is recovered — leg:'emergency', cap-free resend", async () => {
    // tool-result-heavy history (ω-2b (I2-b) fixture): the reactive compact
    // stubs IN PLACE (list length kept), so the emergency tier still has a
    // droppable head when the compact-resend overflows again.
    const messages: AgentMessage[] = [{ role: "user", content: "task" }];
    for (let i = 0; i < 10; i += 1) {
      messages.push({
        role: "assistant",
        content: "",
        toolCalls: [{ id: `c${i}`, name: "echo", arguments: { text: String(i) } }],
      });
      messages.push({ role: "tool", toolCallId: `c${i}`, name: "echo", content: `r${i} ` + "z".repeat(5_000) });
    }
    messages.push({ role: "user", content: "go" });
    const model = scriptedModel([
      // call 1 (main): overflow, physical < MIN_CLIP_TOKENS → compact arm.
      { events: [], die: contextLengthError() },
      // call 2 (COMPACT-resend leg): overflows AGAIN pre-delta → emergency.
      { events: [], die: contextLengthError() },
      // call 3 (EMERGENCY leg): deltas, then the transport dies — the old
      // code killed the run here (the ω99-9 arm wrapped only the main call).
      { events: [{ type: "text_delta", text: "emergency 腿已流出" }], die: socketHangUp("emergency") },
      // call 4: the recovery resend completes the turn.
      { events: [], done: { role: "assistant", content: "emergency 腿续写完成" } },
    ]);
    const state = freshState(messages);
    const events: LoopEvent[] = [];
    const terminal = await drain(
      runAgentLoop(state, model, {
        maxTurns: 3,
        gates: { todo: false, verify: false },
        compaction: { contextWindowTokens: 12_000, keepRecent: 6 },
      }),
      events,
    );

    expect(terminal.reason).toBe("completed");
    expect(model.captures.length).toBe(4);
    // The emergency leg sends no clip — and neither does its recovery resend.
    expect(model.captures[2]?.maxTokens).toBeUndefined();
    expect(model.captures[3]?.maxTokens).toBeUndefined();
    expect(events.find((e) => e.type === "turn_retried")).toMatchObject({
      attempt: 1,
      leg: "emergency",
    });
    expect(events.find((e) => e.type === "context_recovery")).toMatchObject({ kind: "emergency" });
    // Ordering: the tier-3 drop precedes the interruption, and the leg-tagged
    // retry precedes the ladder's own emergency recovery event.
    expect(
      events.findIndex((e) => e.type === "compacted" && e.trigger === "emergency"),
    ).toBeLessThan(events.findIndex((e) => e.type === "assistant_interrupted"));
    expect(events.findIndex((e) => e.type === "turn_retried")).toBeLessThan(
      events.findIndex((e) => e.type === "context_recovery"),
    );
    // The recovery resend rode the emergency-dropped prefix + partial + note.
    const resend = model.captures[3]!;
    expect(resend.messages.at(-2)).toMatchObject({
      role: "assistant",
      content: "emergency 腿已流出",
      interrupted: true,
    });
    expect(resend.messages.at(-1)).toMatchObject({ role: "user", content: TURN_RECOVERY_NOTE });
    expect(state.messages.at(-1)).toMatchObject({ role: "assistant", content: "emergency 腿续写完成" });
  });

  it("⑭ shared budget: main's recovery counts against the clip legs' — 3 turn_retried total, then the drop pierces the run", async () => {
    expect(MAX_TURN_RECOVERY_ATTEMPTS).toBe(3);
    const model = scriptedModel([
      // call 1 (main): one drop, recovered (shared counter → 1).
      { events: [{ type: "text_delta", text: "段一" }], die: socketHangUp("m1") },
      // call 2 (main resend): pre-delta overflow with a trusted parse → the
      // ladder arms the clip-retry (physical = 15_808).
      { events: [], die: contextLengthError({ promptTokens: 40_000, windowTokens: 64_000 }) },
      // call 3 (clip leg): drop → shared counter 2 …
      { events: [{ type: "text_delta", text: "段二" }], die: socketHangUp("c1") },
      // call 4 (clip recovery resend): drop → shared counter 3, the LAST …
      { events: [{ type: "text_delta", text: "段三" }], die: socketHangUp("c2") },
      // call 5: this drop is past the shared budget → the helper rethrows,
      // the leg's catch propagates, the run dies. (Per-LEG accounting would
      // recover here — a 6th call the script deliberately does not provide.)
      { events: [{ type: "text_delta", text: "段四" }], die: socketHangUp("c3") },
    ]);
    const state = freshState();
    const events: LoopEvent[] = [];
    await expect(
      drain(
        runAgentLoop(state, model, {
          maxTurns: 3,
          gates: { todo: false, verify: false },
          compaction: { contextWindowTokens: 64_000 },
        }),
        events,
      ),
    ).rejects.toThrow("socket hang up c3");

    const retried = events.filter(
      (e): e is Extract<LoopEvent, { type: "turn_retried" }> => e.type === "turn_retried",
    );
    expect(retried.map((e) => e.attempt)).toEqual([1, 2, 3]);
    expect(retried.map((e) => e.leg)).toEqual(["main", "clip", "clip"]);
    expect(model.captures.length).toBe(5);
    // The main resend stays cap-free; the clip legs and BOTH their recovery
    // resends keep the physical cap alive (one-cap rule).
    expect(model.captures[1]?.maxTokens).toBeUndefined();
    expect(model.captures[2]?.maxTokens).toBe(PHYSICAL);
    expect(model.captures[3]?.maxTokens).toBe(PHYSICAL);
    expect(model.captures[4]?.maxTokens).toBe(PHYSICAL);
    // Three committed segments (user + 3×(partial, note)); the 4th segment
    // died with the run — no partial for it.
    expect(state.messages.map((m) => m.role)).toEqual([
      "user", "assistant", "user", "assistant", "user", "assistant", "user",
    ]);
  });

  it("⑮ leg abort: an AbortError inside the clip leg finalizes at the leg's own catch — aborted terminal, partial committed, no turn_retried", async () => {
    const abortError = () =>
      Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    const model = scriptedModel([
      // call 1 (main): pre-delta overflow → the clip leg.
      { events: [], die: contextLengthError({ promptTokens: 40_000, windowTokens: 64_000 }) },
      // call 2 (CLIP leg): deltas delivered, then the abort — the helper
      // rethrows (it never finalizes); the leg's abort branch is the single
      // finalize point for this path.
      { events: [{ type: "text_delta", text: "clip 流出的" }], die: abortError() },
    ]);
    const state = freshState();
    const events: LoopEvent[] = [];
    const terminal = await drain(
      runAgentLoop(state, model, {
        maxTurns: 3,
        gates: { todo: false, verify: false },
        compaction: { contextWindowTokens: 64_000 },
      }),
      events,
    );

    expect(terminal.reason).toBe("aborted");
    expect(model.captures.length).toBe(2);
    // The clip leg DID carry the physical cap (the precondition that this
    // was really the clip leg, not the main call).
    expect(model.captures[1]?.maxTokens).toBe(PHYSICAL);
    expect(state.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "clip 流出的",
      interrupted: true,
    });
    expect(events.some((e) => e.type === "turn_retried")).toBe(false);
    expect(events.filter((e) => e.type === "assistant_interrupted").length).toBe(1);
  });

  it("⑯ anchor correction (ω99-12): the clip resend is byte-identical to the overflowing RECOVERY RESEND, not the turn-start projection", async () => {
    // The defect is observable only when THIS turn's drained note made
    // `projected` a COPY (M32 §3) — with no notes `modelInput.messages` IS
    // the live state array (aliasing masks the staleness). One queued note
    // forces the copy, the true ω99-11 × overflow-ladder compound corner.
    const noteQueue = ["steer: 快收尾"];
    const model = scriptedModel([
      // call 1 (main): deltas, then the transport dies → the ω99-11 arm
      // commits the partial, appends the NOTE, and arms a recovery resend.
      { events: [{ type: "text_delta", text: "主调用已流出" }], die: socketHangUp("main") },
      // call 2 (main RECOVERY RESEND): pre-delta overflow with a trusted
      // parse — the appended partial+NOTE (+ re-projected note) made the
      // resent request bigger than the original, and it lands at the window
      // edge. The helper rethrows; the ladder arms the clip-retry
      // (physical = 15_808, the ⑪ fixture arithmetic).
      { events: [], die: contextLengthError({ promptTokens: 40_000, windowTokens: 64_000 }) },
      // call 3 (CLIP resend): completes the turn.
      { events: [], done: { role: "assistant", content: "clip 续锚完成" } },
    ]);
    const state = freshState();
    const events: LoopEvent[] = [];
    const terminal = await drain(
      runAgentLoop(state, model, {
        maxTurns: 3,
        gates: { todo: false, verify: false },
        compaction: { contextWindowTokens: 64_000 },
        metaNotes: { take: () => noteQueue.shift() },
      }),
      events,
    );

    expect(terminal.reason).toBe("completed");
    expect(model.captures.length).toBe(3);
    // Precondition: capture2 IS the recovery resend — the turn-start prefix
    // PLUS (interrupted partial, NOTE, re-projected note) as the suffix.
    const resend = model.captures[1]!;
    expect(resend.messages.at(-3)).toMatchObject({
      role: "assistant",
      content: "主调用已流出",
      interrupted: true,
    });
    expect(resend.messages.at(-2)).toMatchObject({ role: "user", content: TURN_RECOVERY_NOTE });
    expect(resend.messages.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("steer: 快收尾"),
    });
    // THE ANCHOR: the clip resend's prompt bytes are identical to the request
    // that actually overflowed (capture2) — the model sees its own partial
    // and the continuation note, so it continues instead of rewriting.
    expect(canon(model.captures[2]!.messages)).toBe(canon(resend.messages));
    // The cap rides the spread override, same assertion form as ⑪.
    expect(model.captures[2]!.maxTokens).toBe(PHYSICAL);
    // And NOT the turn-start projection (capture1) — the stale-anchor shape
    // the old clip call site sent (the duplicate-rewrite defect of §0).
    expect(canon(model.captures[2]!.messages)).not.toBe(canon(model.captures[0]!.messages));
    // Event order: prefix commit → main-leg retry → the ladder's clip event.
    expect(legEventOrder(events)).toEqual([
      "assistant_interrupted", "turn_retried", "context_recovery",
    ]);
    expect(events.find((e) => e.type === "turn_retried")).toMatchObject({
      attempt: 1,
      leg: "main",
    });
    expect(events.find((e) => e.type === "context_recovery")).toMatchObject({
      kind: "clip",
      maxTokens: PHYSICAL,
    });
    // The completed answer lands on the append-only history.
    expect(state.messages.at(-1)).toMatchObject({ role: "assistant", content: "clip 续锚完成" });
  });
});
