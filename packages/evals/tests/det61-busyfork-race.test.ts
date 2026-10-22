// ω99-25 — the det-61 busy-fork race, manufactured on demand.
//
// det-61 ③ pinned "a /btw fork answers while the main run is busy" on a
// wall-clock head start: poll the busy flag (it flips true SYNCHRONOUSLY in
// submit, so the poll usually exits on its first check) and trust ~0ms of
// ordering to keep the fork's model call behind the main loop's first one.
// Under CPU contention that head start evaporates — the fork's dispatch path
// (parse + snapshot + fire-and-forget generate) is far shorter than the main
// pipeline (lease / cold-cache consult / projection / prompt_id), so the
// fork's generate lands in the recorder FIRST: script[0]'s grep toolCall is
// handed to the fork and the main run's first answer becomes script[1], the
// 旁答 text. That is the ω99-23 walk's high-load 2× failure (same signature
// both times, single-run always green).
//
// This file turns that "high-load occasional" race into a deterministic
// input: recordingModel's `delayFirstMs` delays the main loop's first call
// by 50ms before recording it (the btw fork itself is never delayed — see
// the injector comment). On any idle machine:
//   - legacy scheduling + the injection  = the slot swap, on demand (pinned
//     as a green spec of the debt pattern: if this arm ever fails, either
//     the injector or the product's fork-dispatch shape changed, and the
//     ω99-23 evidence chain needs re-deriving — do NOT "fix" it by deleting
//     the injection);
//   - handshake scheduling + the injection = the SAME race absorbed: the
//     suite's evidence handshake (submit the fork only after the main call
//     is recorded + the gated tool entered; release only after the fork is
//     recorded as inputs[1] with the <side_question> tail) holds the slot order
//     regardless of the main pipeline's latency.
import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BTW_QUERY_SOURCE } from "wudao-harness/btw";
import { runBusyForkScenario } from "../src/suites/det-61-night-porting-4.js";

describe("ω99-25 det-61 busy-fork race (manufactured)", () => {
  it("legacy wall-clock scheduling swaps the script slots once the main call loses its head start", async () => {
    const root = await mkdtemp(join(tmpdir(), "det61-race-legacy-"));
    const ev = await runBusyForkScenario({ root, scheduling: "legacy", delayFirstMs: 50 });
    // The swap, in arrival order (ω99-316 随源演进、0.3.91 gate 补钉): the
    // fork lands FIRST and is handed script[0] (the grep toolCall); the
    // side lane's frozen-tool execution returns a structured error and the
    // detached loop retries (maxTurns=3), so the fork's round 2 consumes
    // script[1] — the 旁答 text — as a REAL answer. The main run's delayed
    // first call becomes inputs[2], answered with script[2] ("主线完成").
    // The swap now costs one extra fork round; the pre-316 占用 placeholder
    // notice (immediate bail-out on a toolCall-holding fork) is retired.
    expect(ev.slots.map((s) => s.source)).toEqual([BTW_QUERY_SOURCE, BTW_QUERY_SOURCE, "main"]);
    // inputs[1] = the fork's ROUND-2 call: after the frozen toolCall error,
    // its last message is the 旁路问答中工具冻结 tool result, NOT the
    // envelope — the envelope pin lives on round-1 calls (handshake mode
    // pins it via suite ③). Value coincides with the pre-316 pin (false),
    // for a different reason: then inputs[1] was the MAIN call.
    expect(ev.forkSuffixOnSlot1).toBe(false);
    expect(ev.final).toBe("主线完成"); // the main run completes on its own delayed first answer
    // The gated grep never ran: the fork's toolCall was answered by the
    // frozen side-lane (never entering the real execute) and the main run
    // completed on a pure-text first answer — release() fell on an
    // unconsumed gate. At release() time the recorder holds the fork's TWO
    // rounds — the main call is still parked inside the injected delay.
    expect(ev.toolEnteredAtRelease).toBe(false);
    expect(ev.inputsAtRelease).toBe(2);
    // midAnswer is a REAL answer (the fork's round-2 text); stillBusy holds
    // because the main call is parked inside the injected delay. The slot
    // swap IS the scheduling bug; the frozen-retry shape is what 316 made
    // it cost.
    expect(ev.midAnswer).toBe(true);
    expect(ev.stillBusy).toBe(true);
    // Diagnostic surface for the dump: the real side answer is in the
    // history — proof the frozen-tool retry consumed script[1] after being
    // handed script[0].
    expect(ev.notices.some((t) => t.startsWith("💬 旁答"))).toBe(true);
  }, 20_000);

  it("the evidence handshake holds the same slots under the same injection", async () => {
    const root = await mkdtemp(join(tmpdir(), "det61-race-handshake-"));
    const ev = await runBusyForkScenario({ root, scheduling: "handshake", delayFirstMs: 50 });
    // The SAME 50ms main-call delay that scrambles legacy scheduling leaves
    // the handshake untouched: handshake A only submits the fork after the
    // main call is recorded AND the gated grep has entered, so the fork is
    // necessarily inputs[1]; handshake B only releases after the fork's
    // <side_question> tail is on the recorder.
    expect(ev.slots.map((s) => s.source)).toEqual(["main", "btw", "main"]);
    expect(ev.forkSuffixOnSlot1).toBe(true);
    expect(ev.final).toBe("主线完成");
    expect(ev.midAnswer && ev.stillBusy).toBe(true); // the product pin: answered mid-busy, for real
    expect(ev.toolEnteredAtRelease).toBe(true);
    expect(ev.inputsAtRelease).toBe(2);
    expect(ev.notices.some((t) => t.startsWith("💬 旁答"))).toBe(true); // a REAL answer, not the 占用 placeholder
  }, 20_000);

  it("the evidence handshake is green on natural timing too (suite-mode baseline)", async () => {
    const root = await mkdtemp(join(tmpdir(), "det61-race-handshake-natural-"));
    const ev = await runBusyForkScenario({ root, scheduling: "handshake" });
    expect(ev.slots.map((s) => s.source)).toEqual(["main", "btw", "main"]);
    expect(ev.forkSuffixOnSlot1).toBe(true);
    expect(ev.final).toBe("主线完成");
    expect(ev.midAnswer && ev.stillBusy).toBe(true);
  }, 20_000);
});
