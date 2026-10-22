// ω99-49 — bounded streaming shell output (OutputCapture sliding window +
// AdaptivePublisher + Tool onUpdate channel). Deterministic acceptance suite:
// fake clock + injected chunk sequences, zero real processes, zero network.
import { describe, it, expect } from "vitest";
import {
  OutputCapture,
  sanitizeShellOutput,
  STREAM_WINDOW_MAX_BYTES,
  OUTPUT_MIN_EMIT_INTERVAL_MS,
  OUTPUT_TARGET_BYTES_PER_SECOND,
} from "../src/tools/output-capture.js";
import { capBuffer } from "../src/tools/shell.js";
import { runAgentLoop, type LoopEvent, type Terminal } from "../src/loop.js";
import { buildTool } from "../src/index.js";
import { createScriptedModel } from "../src/model-client.js";
import type { AgentMessage } from "../src/types.js";

// ---------------------------------------------------------------------------
// Deterministic harness: a manual clock + scheduler pair injected into
// OutputCapture (the package's existing `deps.now ?? Date.now` shape).
// ---------------------------------------------------------------------------
class FakeClock {
  now = 0;
  private seq = 0;
  private timers: { due: number; order: number; cb: () => void; dead: boolean }[] = [];
  readonly nowFn = (): number => this.now;
  readonly schedule = (cb: () => void, ms: number): (() => void) => {
    const entry = { due: this.now + Math.max(0, ms), order: this.seq++, cb, dead: false };
    this.timers.push(entry);
    return () => { entry.dead = true; };
  };
  /** Advance to now+ms, firing due timers in (due, insertion) order. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = this.timers.filter((t) => !t.dead && t.due <= target).sort((a, b) => a.due - b.due || a.order - b.order)[0];
      if (due === undefined) break;
      this.now = Math.max(this.now, due.due);
      due.dead = true;
      due.cb();
    }
    this.now = target;
  }
}

/** Replay a delta sequence into a consumer view (the two rendering paths). */
function replay(deltas: { kind: string; text: string }[]): string {
  let view = "";
  for (const d of deltas) view = d.kind === "append" ? view + d.text : d.text;
  return view;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^[\uD800-\uDBFF]])([\uDC00-\uDFFF])/;
const utf8 = (s: string): number => Buffer.byteLength(s, "utf8");

// ---------------------------------------------------------------------------
// §2.1 memory bound + §2.2 UTF-8-safe window
// ---------------------------------------------------------------------------
describe("ω99-49 OutputCapture sliding window", () => {
  it("module constants are the brief's exact defaults", () => {
    expect(STREAM_WINDOW_MAX_BYTES).toBe(50 * 1024);
    expect(OUTPUT_MIN_EMIT_INTERVAL_MS).toBe(100);
    expect(OUTPUT_TARGET_BYTES_PER_SECOND).toBe(100 * 1024);
  });

  it("§2.1 memory bound holds under any injection rhythm (≤ maxBytes*2)", () => {
    const clock = new FakeClock();
    const cap = new OutputCapture({ maxBytes: 1000, onUpdate: () => {}, now: clock.nowFn, schedule: clock.schedule });
    const rhythms: string[][] = [
      Array.from({ length: 50 }, () => "x".repeat(60)),            // steady drip
      ["y".repeat(5000)],                                          // single burst > 2*maxBytes
      Array.from({ length: 80 }, (_, i) => "中".repeat(7 + (i % 5))), // multibyte churn
      ["z".repeat(999), "z", "z", "z".repeat(2000)],               // cap grazing
    ];
    for (const rhythm of rhythms) {
      for (const chunk of rhythm) {
        cap.push(chunk);
        expect(cap.retainedBytes()).toBeLessThanOrEqual(2 * 1000);
        // accounting conservation: dropped + retained === accepted (raw bytes)
        expect(cap.droppedHeadBytes() + cap.retainedBytes()).toBe(cap.acceptedBytes());
      }
    }
    // a burst larger than the whole window leaves ≤ window retained
    const burst = new OutputCapture({ maxBytes: 1000, onUpdate: () => {}, now: clock.nowFn, schedule: clock.schedule });
    burst.push("q".repeat(5000));
    expect(burst.retainedBytes()).toBeLessThanOrEqual(1000);
  });

  it("§2.2 window text stays valid UTF-8 across trim boundaries (no torn pairs/3-byte cuts)", () => {
    const clock = new FakeClock();
    const cap = new OutputCapture({ maxBytes: 300, onUpdate: () => {}, now: clock.nowFn, schedule: clock.schedule });
    const unit = "中文abc🎉def Gimäß"; // 1p/2p/3p/4p code points + BMP accents
    const codePoints = Array.from(unit.repeat(400));
    // chunk at odd CODE-POINT counts so trims can land anywhere inside multibyte runs
    let full = "";
    for (let i = 0; i < codePoints.length; i += 7) {
      const chunk = codePoints.slice(i, i + 7).join("");
      full += chunk;
      cap.push(chunk);
      const raw = cap.retainedRaw();
      expect(LONE_SURROGATE.test(raw)).toBe(false);
      expect(full.endsWith(raw)).toBe(true); // code-point-aligned suffix
    }
    expect(cap.droppedHeadBytes()).toBeGreaterThan(0);
    expect(utf8(full) - utf8(cap.retainedRaw())).toBe(cap.droppedHeadBytes());
  });

  it("§2.2 a multibyte char split across BYTE chunks decodes intact (streaming decoder)", () => {
    const clock = new FakeClock();
    const cap = new OutputCapture({ maxBytes: 1024, onUpdate: () => {}, now: clock.nowFn, schedule: clock.schedule });
    cap.push(new Uint8Array([0xe4, 0xb8])); // first 2 bytes of 中
    cap.push(new Uint8Array([0xad]));       // final byte
    cap.finish();
    expect(cap.retainedRaw()).toBe("中");
  });
});

// ---------------------------------------------------------------------------
// §2.3 publish-rate bound + §2.4 two-delta protocol
// ---------------------------------------------------------------------------
describe("ω99-49 AdaptivePublisher rate + delta protocol", () => {
  it("§2.3 inter-emit gaps obey max(minInterval, bytes*1000/targetBps); terminal flush loses nothing", () => {
    const clock = new FakeClock();
    const deltas: { t: number; bytes: number; d: { kind: string; text: string } }[] = [];
    const cap = new OutputCapture({
      maxBytes: 1024 * 1024, // no trim — rate only
      minIntervalMs: 100,
      targetBytesPerSecond: 1000, // 1KB/s makes the byte term dominate quickly
      now: clock.nowFn,
      schedule: clock.schedule,
      onUpdate: (d) => deltas.push({ t: clock.now, bytes: utf8(d.text), d }),
    });
    cap.push("a".repeat(100)); // t=0 immediate
    cap.push("b".repeat(100)); // held (nextEmitAt=100)
    cap.push("c".repeat(100)); // joins the pending diff — emitted window by window
    clock.advance(200);        // trailing timer fires at t=100
    cap.push("d".repeat(2000)); // held until t=300
    cap.push("e".repeat(100));
    clock.advance(2500);       // fires at t=300, then the next window
    cap.finish();              // terminal forced flush of whatever remains
    clock.advance(1);
    // formula pin: gap after an emit ≥ max(minInterval, emittedBytes*1000/targetBps)
    for (let i = 1; i < deltas.length; i++) {
      const gap = deltas[i]!.t - deltas[i - 1]!.t;
      const allowed = Math.max(100, (deltas[i - 1]!.bytes * 1000) / 1000);
      expect(gap).toBeGreaterThanOrEqual(allowed);
    }
    // any 1s window stays within budget + one minInterval burst
    for (let t0 = 0; t0 <= deltas[deltas.length - 1]!.t; t0 += 100) {
      const inWindow = deltas.filter((e) => e.t >= t0 && e.t < t0 + 1000).reduce((s, e) => s + e.bytes, 0);
      expect(inWindow).toBeLessThanOrEqual(1000 + 100);
    }
    // zero loss: after the terminal flush the consumer's view is exactly the window
    const view = replay(deltas.map((e) => e.d));
    expect(view).toBe(sanitizeShellOutput(cap.retainedRaw()));
    expect(view).toContain("aaaa");
    expect(view.endsWith("e".repeat(100))).toBe(true);
  });

  it("§2.4 clean appends emit ONLY append deltas; a window slide emits snapshot with exact droppedHeadBytes", () => {
    const clock = new FakeClock();
    const deltas: { kind: string; text: string; droppedHeadBytes?: number }[] = [];
    const cap = new OutputCapture({ maxBytes: 1000, onUpdate: (d) => deltas.push({ ...d }), now: clock.nowFn, schedule: clock.schedule });
    for (let i = 0; i < 5; i++) cap.push(`line-${i}-text\n`); // 12B each, under the window
    clock.advance(500);
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.every((d) => d.kind === "append")).toBe(true);
    expect(replay(deltas)).toBe(sanitizeShellOutput(cap.retainedRaw()));
    // now overflow: 3 pushes of 1201B each force head trims — DISTINCT fill
    // chars per push, so every post-trim window differs from the published
    // view (identical fills would slide over indistinguishable bytes and
    // correctly emit nothing).
    const big = (i: number) => `H${i}` + "abcdefgh"[i]!.repeat(1198) + "\n";
    for (let i = 0; i < 3; i++) {
      cap.push(big(i));
      clock.advance(5000);
    }
    const snapshots = deltas.filter((d) => d.kind === "snapshot");
    expect(snapshots.length).toBeGreaterThan(0);
    const total = "line-0-text\nline-1-text\nline-2-text\nline-3-text\nline-4-text\n" + [0, 1, 2].map(big).join("");
    // droppedHeadBytes is CUMULATIVE raw trimmed bytes: monotone, and the LAST
    // snapshot carries the current total; the total equals accepted - retained.
    const drops = snapshots.map((s) => s.droppedHeadBytes ?? -1);
    for (const d of drops) expect(d).toBeGreaterThan(0);
    for (let i = 1; i < drops.length; i++) expect(drops[i]!).toBeGreaterThanOrEqual(drops[i - 1]!);
    expect(drops[drops.length - 1]).toBe(cap.droppedHeadBytes());
    expect(cap.droppedHeadBytes()).toBe(utf8(total) - utf8(cap.retainedRaw()));
    clock.advance(5000);
    cap.finish();
    clock.advance(1);
    const view = replay(deltas.map((d) => ({ kind: d.kind, text: d.text })));
    expect(view).toBe(sanitizeShellOutput(cap.retainedRaw()));
  });
});

// ---------------------------------------------------------------------------
// §2.6 sanitize covers the streaming face only
// ---------------------------------------------------------------------------
describe("\u03c999-49 sanitizeShellOutput", () => {
  it("strips ANSI escapes, bare CR, and control chars; keeps \\t and \\n", () => {
    expect(sanitizeShellOutput("\x1b[31mRED\x1b[0m")).toBe("RED");
    expect(sanitizeShellOutput("line1\r\nline2")).toBe("line1\nline2");
    expect(sanitizeShellOutput("a\rb")).toBe("ab");
    expect(sanitizeShellOutput("\x00\x07")).toBe("");
    expect(sanitizeShellOutput("a\tb\nc")).toBe("a\tb\nc");
    expect(sanitizeShellOutput("x\x1b]0;title\x07y")).toBe("xy"); // OSC + BEL
    expect(sanitizeShellOutput("tail\x1b[3")).toBe("tail");        // incomplete trailing CSI
    expect(sanitizeShellOutput("interleave\uFFF9x\uFFFAy\uFFFB!")).toBe("interleavexy!");
  });

  it("\u00a72.6 deltas are sanitized; the retained raw window keeps original bytes", () => {
    const clock = new FakeClock();
    const deltas: { kind: string; text: string }[] = [];
    const cap = new OutputCapture({ maxBytes: 100_000, onUpdate: (d) => deltas.push({ kind: d.kind, text: d.text }), now: clock.nowFn, schedule: clock.schedule });
    cap.push("\x1b[31mRED\x1b[0m\n");
    cap.push("line1\r\nline2\n");
    cap.push("\x00beep\x07\n");
    cap.finish();
    clock.advance(1);
    const view = replay(deltas);
    expect(view).toBe("RED\nline1\nline2\nbeep\n");
    expect(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\r\uFFF9-\uFFFB]/.test(view)).toBe(false);
    // the raw window (the terminal face's source) is untouched
    expect(cap.retainedRaw()).toBe("\x1b[31mRED\x1b[0m\nline1\r\nline2\n\x00beep\x07\n");
  });

  it("a throwing onUpdate consumer is isolated (observer failure never kills the command)", () => {
    const clock = new FakeClock();
    const cap = new OutputCapture({ maxBytes: 1000, onUpdate: () => { throw new Error("consumer blew up"); }, now: clock.nowFn, schedule: clock.schedule });
    expect(() => { cap.push("data\n"); }).not.toThrow();
    clock.advance(500);
    expect(() => { cap.push("more\n"); cap.finish(); }).not.toThrow();
    expect(cap.retainedRaw()).toBe("data\nmore\n");
  });
});

// ---------------------------------------------------------------------------
// §2.5 no-consumer byte identity — the capBuffer law diffed against the
// @f8882d4 base append (the exact lambda run-command.ts:91-92 shipped).
// 113-A4 行为修正声明：capBuffer 的帽已收编为代理对安全的 truncateSafe。
// ASCII / BMP（含中文）节奏仍与 base 逐字节一致；增补平面字符（🎉=代理对）
// 的 cap 若劈在代理对中间，base 产出孤立代理项（乱码 bug），capBuffer 现在
// 退一单位保整对——🎉 行改为钉“新法”（无孤立代理项、不超帽），这是有
// 意修正的偏差，不是缓存破坏（旧字节本身无效）。
// ---------------------------------------------------------------------------
describe("ω99-49 no-consumer byte identity (capBuffer vs base)", () => {
  const baseAppend = (prev: string, chunk: Buffer, maxBuffer: number): string =>
    prev.length >= maxBuffer ? prev : (prev + chunk.toString("utf8")).slice(0, maxBuffer);

  it("capBuffer is byte-identical to the base append across ASCII/BMP rhythms", () => {
    const sequences: Buffer[][] = [
      [Buffer.from("hello "), Buffer.from("world")],
      [Buffer.from("中文".repeat(40))],                                     // multibyte BMP over cap
      [Buffer.from("a".repeat(99)), Buffer.from("中"), Buffer.from("b".repeat(50))], // tear point at cap
      Array.from({ length: 30 }, (_, i) => Buffer.from(`${i}xy`.repeat(7))),
      [Buffer.alloc(0)],
    ];
    for (const seq of sequences) {
      for (const maxBuffer of [10, 64, 100, 257, 4096]) {
        let mine = "";
        let base = "";
        for (const chunk of seq) {
          mine = capBuffer(mine, chunk.toString("utf8"), maxBuffer);
          base = baseAppend(base, chunk, maxBuffer);
        }
        expect(mine).toBe(base);
      }
    }
  });

  it("113-A4: astral rhythms keep the cap but never emit a lone surrogate", () => {
    const sequences: Buffer[][] = [
      [Buffer.from("🎉".repeat(60))],                                       // 4-byte pairs over cap
      [Buffer.from("a".repeat(99)), Buffer.from("𠮷"), Buffer.from("b".repeat(50))],
    ];
    for (const seq of sequences) {
      for (const maxBuffer of [10, 64, 100, 257, 4096]) {
        let mine = "";
        for (const chunk of seq) {
          mine = capBuffer(mine, chunk.toString("utf8"), maxBuffer);
          expect(mine.length).toBeLessThanOrEqual(maxBuffer);
          expect(LONE_SURROGATE.test(mine)).toBe(false);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §2.8 loop wiring pin — onToolUpdate reaches execute's second parameter
// ---------------------------------------------------------------------------
describe("ω99-49 loop onUpdate wiring", () => {
  const mkTool = (seen: unknown[]) => buildTool({
    name: "rec",
    description: "records its second execute parameter",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_args: Record<string, unknown>, onUpdate?: unknown) {
      seen.push(onUpdate);
      return { content: "ok" };
    },
  });

  async function drain(gen: AsyncGenerator<LoopEvent, Terminal>): Promise<Terminal> {
    for (;;) {
      const { done, value } = await gen.next();
      if (done) return value;
    }
  }

  it("injected onToolUpdate is handed to execute as its second argument", async () => {
    const seen: unknown[] = [];
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "rec", arguments: {} }] },
      { role: "assistant", content: "done" },
    ]);
    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" } as AgentMessage],
      tools: [mkTool(seen)],
      status: "idle" as const,
    };
    // ω99-63: the loop's single execution point now hands execute an ADAPTER
    // (never the raw consumer) — identity (toolCallId/toolName) is enriched
    // there, so the consumer receives identified deltas instead of the fn
    // reference itself.
    const got: unknown[] = [];
    const fn = (d: unknown): void => { got.push(d); };
    const terminal = await drain(runAgentLoop(state, model, { maxTurns: 3, onToolUpdate: fn as never }));
    expect(terminal.reason).toBe("completed");
    expect(typeof seen[0]).toBe("function");
    expect(seen[0]).not.toBe(fn);
    (seen[0] as (delta: unknown) => void)({ kind: "append", text: "x" });
    expect(got).toEqual([{ kind: "append", text: "x", toolCallId: "c1", toolName: "rec" }]);
  });

  it("absent onToolUpdate leaves execute's second argument undefined (byte-today)", async () => {
    const seen: unknown[] = [];
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "rec", arguments: {} }] },
      { role: "assistant", content: "done" },
    ]);
    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" } as AgentMessage],
      tools: [mkTool(seen)],
      status: "idle" as const,
    };
    const terminal = await drain(runAgentLoop(state, model, { maxTurns: 3 }));
    expect(terminal.reason).toBe("completed");
    expect(seen[0]).toBeUndefined();
  });
});
