// ω99-45 — driver-level compaction abort + the isIdle predicate. The contract
// under test (queue 105 §2.2):
//   §2.2-4  /compact in flight + driver interrupt → settled isIdle() === true,
//           NO compact_boundary entry (onCompactBoundary never fires), and the
//           static fallback never ran (a fallback landing would have written
//           both the boundary and a summary) — the three-in-one assertion.
//   §2.2-5  the isIdle predicate: each busy dimension flipped on its own turns
//           it false; all quiet turns it true.
// The abort funnel is the ONE cancel point (interrupt()) every frontend
// already reaches — TUI Esc, WS interrupt, headless signals.
import { describe, it, expect } from "vitest";
import type { AgentMessage, ModelClient, ModelInput, Tool } from "@wudao/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver, AgentDriverOptions } from "../src/driver/agent-driver.js";
import type { MonitorRuntime } from "../src/monitor.js";

const wait = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const abortError = (): Error => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });

/** A model whose generate() parks forever and rejects with the AbortError
 *  shape the moment the request's signal fires — the fetch shape. */
const hangingModel = (): { model: ModelClient; calls: () => number } => {
  let calls = 0;
  const model: ModelClient = {
    generate(input: ModelInput) {
      calls += 1;
      return new Promise((_resolve, reject) => {
        if (input.signal?.aborted) {
          reject(abortError());
          return;
        }
        input.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
      });
    },
  };
  return { model, calls: () => calls };
};

// A span with a compactable window and a non-digestible narrative — tier-2
// takes the LLM path (the summarizer is what an abort must cancel).
const spanMessages = (): AgentMessage[] => [
  { role: "user", content: "task 0 " + "x".repeat(2000) },
  { role: "assistant", content: "answer 0" },
  { role: "user", content: "task 1 " + "x".repeat(2000) },
  { role: "assistant", content: "answer 1" },
  { role: "user", content: "go" },
];

function makeDriver(opts: Partial<AgentDriverOptions> & Pick<AgentDriverOptions, "model" | "tools">): AgentDriver {
  return createAgentDriver({
    systemPrompt: "s",
    summarize: summarizeToolCall,
    ...opts,
  });
}

describe("ω99-45 /compact abort (§2.2-4 three-in-one)", () => {
  it("/compact in flight + driver interrupt → settled isIdle, no boundary, no static fallback", async () => {
    const boundaries: unknown[] = [];
    const { model, calls } = hangingModel();
    const driver = makeDriver({
      model,
      tools: [],
      compaction: { keepRecent: 1 },
      onCompactBoundary: (b: unknown) => boundaries.push(b),
    });
    driver.loadHistory(spanMessages(), "s-abort-1");
    const before = driver.state.messages.length;
    const beforeSnapshot = driver.state.messages.map((m) => ({ ...m })) as AgentMessage[];

    expect(driver.submit("/compact")).toBe("notice");
    await until(() => calls() === 1, "summarizer entered");
    expect(driver.isIdle()).toBe(false); // the compaction dimension — while !busy

    driver.interrupt(); // the ONE cancel point (TUI Esc / WS interrupt funnel)

    await until(() => driver.isIdle(), "settled after abort");
    expect(driver.isIdle()).toBe(true);
    // (a) no compact_boundary entry — the boundary sink never fired;
    expect(boundaries).toEqual([]);
    // (b) history untouched — same messages, no summary marker;
    expect(driver.state.messages.length).toBe(before);
    expect(driver.state.messages).toEqual(beforeSnapshot);
    expect(driver.state.messages.some((m) => m.role === "user" && m.content.startsWith("[compacted"))).toBe(false);
    // (c) the static fallback never ran — a fallback landing would have left
    // BOTH a boundary and a "Static fallback summary" text; neither exists,
    // and the cancel notice names the abort instead of a provider failure.
    expect(driver.state.messages.some((m) => m.content.includes("Static fallback summary"))).toBe(false);
    const notices = driver.getHistory().filter((e) => e.kind === "notice").map((e) => (e as { text: string }).text);
    expect(notices.some((t) => t.includes("compact 已中止"))).toBe(true); // ω99-166c-iii: #9 钉演进（孪生归一）
    expect(notices.some((t) => t.includes("compact 失败"))).toBe(false); // ω99-166c-iii: 负钉裁定同步演进（166c-i 已翻 :4887，英文永缺席=空洞负钉，演进保判别力）
  });

  it("a second /compact while one is in flight is refused (the isIdle gate)", async () => {
    const { model, calls } = hangingModel();
    const driver = makeDriver({ model, tools: [], compaction: { keepRecent: 1 } });
    driver.loadHistory(spanMessages(), "s-abort-2");
    expect(driver.submit("/compact")).toBe("notice");
    await until(() => calls() === 1, "first summarizer entered");
    expect(driver.isIdle()).toBe(false);
    // The second /compact must NOT start a racing compaction — the gate
    // refuses while the first holds the compaction slot.
    let secondCalls = calls();
    expect(driver.submit("/compact")).toBe("notice");
    await wait(30);
    expect(driver.isIdle()).toBe(false);
    const notices = driver.getHistory().filter((e) => e.kind === "notice").map((e) => (e as { text: string }).text);
    expect(notices.some((t) => t.includes("会话未空闲"))).toBe(true);
    driver.interrupt();
    await until(() => driver.isIdle(), "settled after abort");
    expect(driver.isIdle()).toBe(true);
    secondCalls = calls();
    expect(secondCalls).toBe(1); // only the FIRST compaction ever called the model
  });
});

describe("ω99-45 isIdle predicate (§2.2-5 dimension flips)", () => {
  it("all quiet → true on a fresh driver", () => {
    const { model } = hangingModel();
    const driver = makeDriver({ model, tools: [] });
    expect(driver.isIdle()).toBe(true);
  });

  it("model call in flight (run active) → false; settled → true", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let entered = 0;
    const model: ModelClient = {
      async generate() {
        entered += 1;
        await gate;
        return { role: "assistant", content: "done" };
      },
    };
    const driver = makeDriver({ model, tools: [] });
    expect(driver.submit("hello")).toBe("started");
    await until(() => entered === 1, "model call entered");
    // busy AND modelInFlight both hold — the run dimensions ride `busy`.
    expect(driver.isIdle()).toBe(false);
    release?.();
    await until(() => driver.isIdle(), "run settled");
    expect(driver.isIdle()).toBe(true);
  });

  it("compaction in flight (idle, no run) → false — the dimension Esc must see", async () => {
    const { model, calls } = hangingModel();
    const driver = makeDriver({ model, tools: [], compaction: { keepRecent: 1 } });
    driver.loadHistory(spanMessages(), "s-idle-1");
    expect(driver.isIdle()).toBe(true);
    expect(driver.submit("/compact")).toBe("notice");
    await until(() => calls() === 1, "summarizer entered");
    expect(driver.isIdle()).toBe(false);
    driver.interrupt();
    await until(() => driver.isIdle(), "compaction settled");
  });

  it("queued follow-up non-empty → false", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let entered = 0;
    const model: ModelClient = {
      async generate() {
        entered += 1;
        // First call holds the run; the queued follow-up's call (post-release)
        // answers immediately.
        if (entered === 1) await gate;
        return { role: "assistant", content: "done" };
      },
    };
    const driver = makeDriver({ model, tools: [] });
    expect(driver.submit("first")).toBe("started");
    await until(() => entered === 1, "run in flight");
    expect(driver.submit("queued next")).toBe("steered");
    expect(driver.getStatus().queued.length).toBe(1); // the queue dimension is live
    expect(driver.isIdle()).toBe(false);
    release?.();
    await until(() => driver.isIdle(), "runs drained");
    expect(driver.isIdle()).toBe(true);
  });

  it("pending monitor events → false; drained → true", () => {
    const box: { n: number } = { n: 1 };
    const monitor: MonitorRuntime = {
      registry: undefined as unknown as MonitorRuntime["registry"],
      takeInjection: () => undefined,
      tick: () => [],
      pending: () => Array.from({ length: box.n }, () => ({ watchId: "w0", kind: "keyword", detail: "hit", occurredAt: 0 })),
      stop: () => {},
    };
    const { model } = hangingModel();
    const driver = makeDriver({ model, tools: [], monitor });
    expect(driver.isIdle()).toBe(false); // 1 pending monitor event
    box.n = 0;
    expect(driver.isIdle()).toBe(true);
  });

  it("busy tool in flight (run active) → false", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const tool: Tool = {
      name: "read_file",
      description: "gated",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: [] },
      execute: async () => { await gate; return { content: "GATED" }; },
    };
    let entered = 0;
    const model: ModelClient = {
      async generate() {
        entered += 1;
        if (entered === 1) return { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "read_file", arguments: { path: "a" } }] };
        return { role: "assistant", content: "done" };
      },
    };
    const driver = makeDriver({ model, tools: [tool], onPermissionAsk: async () => ({ kind: "allow" as const }) });
    expect(driver.submit("use the tool")).toBe("started");
    await until(() => driver.getStatus().live.busyTools.length > 0, "tool busy");
    expect(driver.isIdle()).toBe(false);
    release?.();
    await until(() => driver.isIdle(), "run settled");
    expect(driver.isIdle()).toBe(true);
  });
});
