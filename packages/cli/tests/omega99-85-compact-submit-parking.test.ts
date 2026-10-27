// ω99-85 — submit parking while an idle /compact is in flight (ω99-45's
// parked debt). 45 plugged the three poller mouths (cron/peer/monitor) and
// the TUI Esc face, but the submit path fell straight through submitCore's
// busy-only check into startRun: the user turn landed INSIDE the compaction
// window, and manualCompact's wholesale `state.messages = out.messages`
// (built from the entry snapshot) wiped it from memory while its JSONL line
// chained off a span the boundary just cut. The contract under test:
//   case1  a text submit inside the window parks — outcome "steered", the
//          steering queue holds it, and NO user turn exists in memory yet.
//   case2  the race proper: park → compaction lands → the compact settle
//          drains the parked text as a fresh run — the user turn sits AFTER
//          the summary boundary in state.messages (not wiped), exactly one
//          run, and the driver settles idle.
//   case3  attachments cannot park — refused with a notice (nothing may
//          strand across the boundary), queue untouched, no run.
//   case4  steering ablated (--no-steering) — the park is refused with the
//          same notice the busy arm uses; queue untouched, no run.
import { describe, it, expect } from "vitest";
import type { AgentMessage, ModelClient, ModelInput } from "@wudao/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver, AgentDriverOptions } from "../src/driver/agent-driver.js";

const wait = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

// A span with a compactable window and a NON-digestible narrative (the two
// 2000-char user messages blow the 800-char digest cap) — tier-2 takes the
// LLM path, so the summarizer call is the gate the test holds the compaction
// window open with (same shape as ω99-45's compaction family).
const spanMessages = (): AgentMessage[] => [
  { role: "user", content: "task 0 " + "x".repeat(2000) },
  { role: "assistant", content: "answer 0" },
  { role: "user", content: "task 1 " + "x".repeat(2000) },
  { role: "assistant", content: "answer 1" },
  { role: "user", content: "go" },
];

/** A model whose summarizer call (querySource "summarizer") parks on a gate
 *  the test releases to close the compaction window (and rejects with the
 *  fetch-shape AbortError the moment the request's signal fires — the same
 *  shape ω99-45's hangingModel uses, so interrupt() can cancel the window);
 *  every other call (the runs) answers immediately. */
const abortError = (): Error => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });

const gatedCompactionModel = (): {
  model: ModelClient;
  summarizerEntered: () => boolean;
  releaseCompaction: () => void;
  runCalls: () => number;
} => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let summarizer = false;
  let runs = 0;
  const model: ModelClient = {
    async generate(input: ModelInput) {
      if (input.querySource === "summarizer") {
        summarizer = true;
        await Promise.race([
          gate,
          new Promise<never>((_, reject) => {
            if (input.signal?.aborted) reject(abortError());
            else input.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
          }),
        ]);
        return { role: "assistant", content: "summary of the span" };
      }
      runs += 1;
      return { role: "assistant", content: `answer ${runs}` };
    },
  };
  return { model, summarizerEntered: () => summarizer, releaseCompaction: release, runCalls: () => runs };
};

function makeDriver(opts: Partial<AgentDriverOptions> & Pick<AgentDriverOptions, "model" | "tools">): AgentDriver {
  return createAgentDriver({ systemPrompt: "s", summarize: summarizeToolCall, ...opts });
}

const noticeTexts = (driver: AgentDriver): string[] =>
  driver.getHistory().filter((e) => e.kind === "notice").map((e) => (e as { text: string }).text);

// A structurally valid image block (isValidImageBlock-shaped) — the
// compaction refusal must be what rejects it, not the junk-block admission.
const validImage = {
  kind: "image" as const,
  ref: { kind: "image" as const, attachmentId: "att-85", mediaType: "image/png", byteLength: 10 },
};

describe("ω99-85 submit parking during an idle /compact", () => {
  it("case1: text submit inside the compaction window parks — steered, queued, no user turn in memory", async () => {
    const { model, summarizerEntered, releaseCompaction, runCalls } = gatedCompactionModel();
    const driver = makeDriver({ model, tools: [], compaction: { keepRecent: 1 } });
    driver.loadHistory(spanMessages(), "s-85-1");
    expect(driver.submit("/compact")).toBe("notice");
    await until(summarizerEntered, "summarizer entered");
    expect(driver.isIdle()).toBe(false); // the window: !busy but compaction in flight

    const outcome = driver.submit("meanwhile, a question");

    expect(outcome).toBe("steered");
    expect(driver.getStatus().queued).toEqual(["meanwhile, a question"]);
    // the user turn must NOT exist in memory inside the window — the
    // compaction's wholesale replace would wipe it (the 45 debt)
    expect(driver.state.messages.some((m) => m.role === "user" && m.content === "meanwhile, a question")).toBe(false);
    expect(runCalls()).toBe(0); // no run started inside the window
    releaseCompaction(); // window closes; the settle drain runs the parked text
    await until(() => driver.isIdle(), "settled after the drain");
    driver.dispose();
  });

  it("case2: the race — park, compaction lands, settle drain runs the turn AFTER the boundary", async () => {
    const { model, summarizerEntered, releaseCompaction, runCalls } = gatedCompactionModel();
    const driver = makeDriver({ model, tools: [], compaction: { keepRecent: 1 } });
    driver.loadHistory(spanMessages(), "s-85-2");
    expect(driver.submit("/compact")).toBe("notice");
    await until(summarizerEntered, "summarizer entered");

    const outcome = driver.submit("the question that must survive");
    releaseCompaction();
    // the compaction lands (state.messages replaced with the compacted
    // chain), the settle drain startRuns the parked text, the run settles
    await until(() => driver.isIdle(), "settled after the drain");

    // assert the CHAIN first — this is the race body: on the unparked base
    // the turn landed inside the window and out.messages' wholesale replace
    // wiped it (turnIdx -1)
    const messages = driver.state.messages;
    const summaryIdx = messages.findIndex((m) => m.role === "user" && m.content.startsWith("[compacted summary]"));
    const turnIdx = messages.findIndex((m) => m.role === "user" && m.content === "the question that must survive");
    expect(summaryIdx).toBeGreaterThanOrEqual(0); // the boundary landed
    expect(turnIdx).toBeGreaterThan(summaryIdx); // the turn is AFTER it — not wiped by out.messages
    expect(outcome).toBe("steered"); // and the submit itself parked
    expect(runCalls()).toBe(1); // exactly one run — the drain, no double run
    driver.dispose();
  });

  it("case3: attachments cannot park — refused with a notice, queue untouched, no run", async () => {
    const { model, summarizerEntered, runCalls } = gatedCompactionModel();
    const driver = makeDriver({ model, tools: [], compaction: { keepRecent: 1 } });
    driver.loadHistory(spanMessages(), "s-85-3");
    expect(driver.submit("/compact")).toBe("notice");
    await until(summarizerEntered, "summarizer entered");

    const outcome = driver.submit("look at this", { images: [validImage] });

    expect(outcome).toBe("notice");
    expect(noticeTexts(driver).some((t) => t.includes("compact 进行中无法提交附件"))).toBe(true); // ω99-166c-iv: 钉随源演进（ad:3727 compact 附件拒绝面中文化）。
    expect(driver.getStatus().queued).toEqual([]); // refused, not parked
    expect(runCalls()).toBe(0); // no run started inside the window
    driver.interrupt(); // close the still-open window (abort path settles too)
    await until(() => driver.isIdle(), "settled after abort");
    driver.dispose();
  });

  it("case4: steering ablated — the park is refused with the busy arm's notice, no run", async () => {
    process.env.WUDAO_NO_STEERING = "1";
    try {
      const { model, summarizerEntered, releaseCompaction, runCalls } = gatedCompactionModel();
      const driver = makeDriver({ model, tools: [], compaction: { keepRecent: 1 } });
      driver.loadHistory(spanMessages(), "s-85-4");
      expect(driver.submit("/compact")).toBe("notice");
      await until(summarizerEntered, "summarizer entered");

      const outcome = driver.submit("a steer during compaction");

      expect(outcome).toBe("notice");
      expect(noticeTexts(driver).some((t) => t.includes("steering 已禁用"))).toBe(true); // ω99-166c-iv: 钉随源演进（ad:3731 steering 禁用拒绝面中文化）。
      expect(driver.getStatus().queued).toEqual([]); // refused, not parked
      expect(runCalls()).toBe(0); // no run started inside the window
      releaseCompaction(); // nothing parked → nothing drains
      await until(() => driver.isIdle(), "settled after compaction");
      driver.dispose();
    } finally {
      delete process.env.WUDAO_NO_STEERING;
    }
  });
});
