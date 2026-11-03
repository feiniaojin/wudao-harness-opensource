// ω99-320 — 流式软警告 UI 露出（315 债兑现）。
//   slot     soft-warn-tracker 的纯层：forward 转发给当前 listener；无
//            listener 纯透传（no-op）；listener 抛异常吞掉（fail-open——
//            guard 的 timer 里绝不能炸流）；setListener(undefined) 停投递。
//   driver   run 级计数 softIdleWarns（runIdleReconnects 同族）：首次软警告
//            发一条温和 notice（同 run 只一次）；settle 的 run-stats 追加
//            「等待较久 N 次」（omit-when-zero）；run_stats_receipt data 加
//            softIdleWarns（>0 才带）；run 结束清 listener（迟来回调不进下
//            一 run）。
//   M24      双证：构造缝接上 onStreamIdleWarning 前后请求体字节同一；
//            软警告路径对 session store 零调用。
//   resume   softIdleWarns 透传：字符串/负数/超帽弃字段不弃行。
// 夹具全在 os.tmpdir()。
import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createJsonlSessionStore,
  type SessionStore,
  type ModelClient,
  type ModelInput,
  type ModelStreamEvent,
} from "@wudao-org/core";
import { createOpenAICompatibleProvider } from "@wudao-org/providers";
import { vi } from "vitest";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver, formatRunStats } from "../src/driver/agent-driver.js";
import { createSoftWarnSlot } from "../src/soft-warn-tracker.js";
import { receiptNoticesFromEntries } from "../src/tui/resume.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

async function withWs<T>(fn: (ws: string) => Promise<T>): Promise<T> {
  const ws = await mkdtemp(join(tmpdir(), "wd320-"));
  try {
    return await fn(ws);
  } finally {
    await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const INFO = { idleMs: 90_000, bytesSoFar: 0, softWarns: [90_000] } as const;

// ---------------------------------------------------------------------------
// §5.1 slot 纯层（软警告槽——生产接线的最小构件）
// ---------------------------------------------------------------------------

describe("ω99-320 soft-warn slot (pure layer)", () => {
  it("forwards events to the CURRENT listener", () => {
    const slot = createSoftWarnSlot();
    const seen: unknown[] = [];
    slot.setListener((info) => seen.push(info));
    slot.forward(INFO);
    slot.forward({ ...INFO, softWarns: [90_000, 180_000] });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(INFO);
  });

  it("no listener = silent no-op (pure passthrough, zero behavior change)", () => {
    const slot = createSoftWarnSlot();
    expect(() => slot.forward(INFO)).not.toThrow();
  });

  it("a throwing listener is swallowed (fail-open: the guard's timer must never crash the stream)", () => {
    const slot = createSoftWarnSlot();
    slot.setListener(() => {
      throw new Error("boom");
    });
    expect(() => slot.forward(INFO)).not.toThrow();
  });

  it("setListener(undefined) stops delivery (late callbacks land nowhere)", () => {
    const slot = createSoftWarnSlot();
    const seen: unknown[] = [];
    slot.setListener((info) => seen.push(info));
    slot.forward(INFO);
    slot.setListener(undefined);
    slot.forward(INFO);
    expect(seen).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// §5.1b formatRunStats 第 6 参
// ---------------------------------------------------------------------------

describe("ω99-320 formatRunStats soft segment", () => {
  it("N=0 omits the segment (byte-parity with old receipts); N>0 appends 等待较久 N 次 last", () => {
    expect(formatRunStats(1_200, 800, 400, 2, 0, 0)).toBe("耗时 1.2s · 模型 <1s · 工具 <1s (2 次)");
    expect(formatRunStats(1_200, 800, 400, 2, 3, 0)).toBe("耗时 1.2s · 模型 <1s · 工具 <1s (2 次) · 断流重连 3 次");
    expect(formatRunStats(1_200, 800, 400, 2, 0, 2)).toBe("耗时 1.2s · 模型 <1s · 工具 <1s (2 次) · 等待较久 2 次");
    // default-args: existing callers keep their exact text
    expect(formatRunStats(1_200, 800, 400, 2)).toBe("耗时 1.2s · 模型 <1s · 工具 <1s (2 次)");
    expect(formatRunStats(1_200, 800, 400, 2, 3)).toBe("耗时 1.2s · 模型 <1s · 工具 <1s (2 次) · 断流重连 3 次");
  });
});

// ---------------------------------------------------------------------------
// driver: 计数 + 首次 notice + settle 收据 + listener 清空
// ---------------------------------------------------------------------------

/** The fake provider: each call fires `softWarns` soft warnings (exactly the
 *  way production's guard reaches the slot — through the constructor-seam
 *  callback), optionally dies mid-delta with `die` (the hard face), else
 *  completes. */
function softWarnScriptedModel(
  onWarn: (info: { idleMs: number; bytesSoFar: number; softWarns: readonly number[] }) => void,
  script: readonly { softWarns?: number; die?: Error; reply?: string }[],
): ModelClient {
  let call = 0;
  return {
    generate: () => {
      throw new Error("should not be called");
    },
    async *stream(_input: ModelInput): AsyncGenerator<ModelStreamEvent> {
      const step = script[Math.min(call, script.length - 1)] ?? {};
      call += 1;
      const fires = step.softWarns ?? 0;
      for (let i = 0; i < fires; i += 1) {
        onWarn({ idleMs: 90_000, bytesSoFar: 0, softWarns: Array.from({ length: i + 1 }, () => 90_000) });
      }
      if (step.die !== undefined) {
        yield { type: "text_delta", text: "断流前" };
        throw step.die;
      }
      yield { type: "done", message: { role: "assistant", content: step.reply ?? "答" } };
    },
  };
}

function makeDriver(ws: string, model: ModelClient, extra: { softWarnSlot: ReturnType<typeof createSoftWarnSlot> }) {
  return createAgentDriver({
    model,
    tools: [],
    systemPrompt: "s",
    summarize: summarizeToolCall,
    workspaceRoot: ws,
    onPermissionAsk: async () => ({ kind: "allow" as const }),
    softWarnSlot: extra.softWarnSlot,
  });
}

const statsNotices = (texts: readonly { kind: string; text?: string }[]) =>
  texts.filter((e) => e.kind === "notice" && typeof e.text === "string" && (e.text as string).includes("耗时"));
const softWarnNotices = (texts: readonly { kind: string; text?: string }[]) =>
  texts.filter((e) => e.kind === "notice" && typeof e.text === "string" && (e.text as string).includes("等了好一会儿"));

describe("ω99-320 driver: soft warns land in stats + receipt; first-warn notices once", () => {
  it("§5.2: 2 soft warns → stats 「等待较久 2 次」 + receipt data.softIdleWarns=2; slot cleared after settle", async () => {
    await withWs(async (ws) => {
      const slot = createSoftWarnSlot();
      const driver = makeDriver(ws, softWarnScriptedModel(slot.forward, [{ softWarns: 2 }, {}]), { softWarnSlot: slot });
      const sid = driver.getSessionId();
      driver.submit("过夜任务");
      await until(() => driver.getStatus().busy === false && statsNotices(driver.getHistory()).length > 0, "run settled");
      await wait(50);
      const stats = statsNotices(driver.getHistory());
      expect(stats.some((n) => (n.text as string).includes("等待较久 2 次"))).toBe(true);
      const store = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
      const entries = await store.loadSessionEntries(sid);
      const st = entries.filter((e) => e.type === "run_stats_receipt");
      expect(st).toHaveLength(1);
      expect((st[0] as { data: { softIdleWarns?: number } }).data.softIdleWarns).toBe(2);
      // §5.3 first-only: exactly ONE gentle notice for the whole run
      expect(softWarnNotices(driver.getHistory())).toHaveLength(1);
      // listener cleared at settle: a stray late callback writes nothing
      const noticesBefore = driver.getHistory().length;
      slot.forward(INFO);
      await wait(20);
      expect(driver.getHistory().length).toBe(noticesBefore);
      // …and the NEXT run stays clean (the stray did not bleed into it)
      driver.submit("第二轮");
      await until(() => driver.getStatus().busy === false && statsNotices(driver.getHistory()).length === 2, "run 2 settled");
      await wait(50);
      const stats2 = statsNotices(driver.getHistory());
      const run2Stats = stats2[stats2.length - 1] as { text: string };
      expect(run2Stats.text).not.toContain("等待较久");
      expect(softWarnNotices(driver.getHistory())).toHaveLength(1);
      driver.dispose();
    });
  });

  it("§5.3: 0 soft warns → zero gentle notices, no softIdleWarns field, no 等待较久 segment", async () => {
    await withWs(async (ws) => {
      const slot = createSoftWarnSlot();
      const driver = makeDriver(ws, softWarnScriptedModel(slot.forward, [{}]), { softWarnSlot: slot });
      const sid = driver.getSessionId();
      driver.submit("快任务");
      await until(() => driver.getStatus().busy === false && statsNotices(driver.getHistory()).length > 0, "run settled");
      await wait(50);
      expect(softWarnNotices(driver.getHistory())).toHaveLength(0);
      const stats = statsNotices(driver.getHistory());
      expect(stats.every((n) => !(n.text as string).includes("等待较久"))).toBe(true);
      const store = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
      const entries = await store.loadSessionEntries(sid);
      const st = entries.filter((e) => e.type === "run_stats_receipt");
      expect((st[0] as { data: { softIdleWarns?: number } }).data.softIdleWarns).toBeUndefined();
      driver.dispose();
    });
  });

  it("§5.4: soft warns + one idle-class hard reconnect → both segments in one run-stats line", async () => {
    await withWs(async (ws) => {
      const slot = createSoftWarnSlot();
      const die = Object.assign(new Error("stream idle for 300000ms without a chunk — watchdog abort"), { name: "StreamIdleError" });
      const driver = makeDriver(ws, softWarnScriptedModel(slot.forward, [{ softWarns: 2, die }, {}]), { softWarnSlot: slot });
      driver.submit("网络差的任务");
      await until(() => driver.getStatus().busy === false && statsNotices(driver.getHistory()).length > 0, "run settled");
      await wait(50);
      const stats = statsNotices(driver.getHistory());
      const line = stats.find((n) => (n.text as string).includes("断流重连 1 次"));
      expect(line).toBeDefined();
      expect((line as { text: string }).text).toContain("等待较久 2 次");
      driver.dispose();
    });
  });

  it("§5.2b: absent softWarnSlot option → zero behavior change (stray callback lane unused)", async () => {
    await withWs(async (ws) => {
      const driver = createAgentDriver({
        model: softWarnScriptedModel(() => {}, [{ softWarns: 0 }]),
        tools: [],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        workspaceRoot: ws,
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
      driver.submit("无槽任务");
      await until(() => driver.getStatus().busy === false && statsNotices(driver.getHistory()).length > 0, "run settled");
      expect(softWarnNotices(driver.getHistory())).toHaveLength(0);
      driver.dispose();
    });
  });
});

// ---------------------------------------------------------------------------
// §5.5 M24 双证：请求字节同一 + store 零调用
// ---------------------------------------------------------------------------

const sse = (text: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const DONE = "data: [DONE]\n\n";

function instantBody(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ch of chunks) controller.enqueue(enc.encode(ch));
      controller.close();
    },
  });
}

describe("ω99-320 M24: the soft-warn seam is byte-invisible", () => {
  it("(a) wiring onStreamIdleWarning changes ZERO request bytes (constructor-seam A/B)", async () => {
    const CFG = { apiKey: "k", baseURL: "https://x/v1", model: "m" };
    const INPUT = { systemPrompt: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [] };
    const makeFetch = (bodies: string[]): typeof fetch =>
      (async (_url: unknown, init?: { body?: string }) => {
        bodies.push(String(init?.body));
        return { ok: true, status: 200, body: instantBody([sse("答"), DONE]) };
      }) as unknown as typeof fetch;
    const consume = async (provider: ModelClient): Promise<void> => {
      for await (const _ev of provider.stream!(INPUT as ModelInput)) {
        /* drain */
      }
    };
    const bare: string[] = [];
    await consume(createOpenAICompatibleProvider(CFG, { fetch: makeFetch(bare) }));
    const wired: string[] = [];
    const slot = createSoftWarnSlot();
    await consume(createOpenAICompatibleProvider(CFG, { fetch: makeFetch(wired), onStreamIdleWarning: slot.forward }));
    expect(wired).toHaveLength(1);
    expect(bare[0]).toBe(wired[0]);
  });

  it("(b) the soft-warn path makes ZERO sessionStore calls (same call count as a clean run)", async () => {
    await withWs(async (ws) => {
      const countingStore = (): { store: SessionStore; totalCalls: () => number } => {
        const fns = new Map<string, ReturnType<typeof vi.fn>>();
        const store = new Proxy({} as SessionStore, {
          get: (_t, k: string) => {
            if (typeof k !== "string" || k === "then") return undefined;
            if (!fns.has(k)) {
              const ret = k === "load" || k === "loadSessionEntries" || k === "list" ? Promise.resolve([]) : Promise.resolve(undefined);
              fns.set(k, vi.fn().mockReturnValue(ret));
            }
            return fns.get(k);
          },
        });
        return { store, totalCalls: () => [...fns.values()].reduce((n, f) => n + f.mock.calls.length, 0) };
      };
      const run = async (softWarns: number): Promise<number> => {
        const { store, totalCalls } = countingStore();
        const slot = createSoftWarnSlot();
        const driver = createAgentDriver({
          model: softWarnScriptedModel(slot.forward, [{ softWarns }]),
          tools: [],
          systemPrompt: "s",
          summarize: summarizeToolCall,
          sessionStore: store,
          sessionId: `s-${softWarns}`,
          onPermissionAsk: async () => ({ kind: "allow" as const }),
          softWarnSlot: slot,
        });
        driver.submit("任务");
        await until(() => driver.getStatus().busy === false, "run settled");
        await wait(50);
        driver.dispose();
        return totalCalls();
      };
      const clean = await run(0);
      const warned = await run(3);
      expect(clean).toBeGreaterThan(0); // the run itself persists — the soft-warn lane must not add to it
      expect(warned).toBe(clean);
    });
  });
});

// ---------------------------------------------------------------------------
// §5.6 resume 透传：softIdleWarns 白名单 + 畸形弃字段不弃行
// ---------------------------------------------------------------------------

describe("ω99-320 receipt replay: softIdleWarns is additive", () => {
  it("a well-formed count passes through; malformed (string/negative/over-cap) drops the FIELD, keeps the row", () => {
    const out = receiptNoticesFromEntries([
      { type: "run_stats_receipt", data: { text: "耗时 1.2s · 等待较久 2 次", softIdleWarns: 2 } },
      { type: "run_stats_receipt", data: { text: "耗时 1.0s · 断流重连 1 次 · 等待较久 3 次", idleReconnects: 1, softIdleWarns: 3 } },
      { type: "run_stats_receipt", data: { text: "a", softIdleWarns: "many" } },
      { type: "run_stats_receipt", data: { text: "b", softIdleWarns: -1 } },
      { type: "run_stats_receipt", data: { text: "c", softIdleWarns: 1_000_001 } },
      { type: "run_stats_receipt", data: { text: "d", softIdleWarns: 1.5 } },
    ]);
    expect(out[0]).toEqual({ kind: "notice", text: "耗时 1.2s · 等待较久 2 次", softIdleWarns: 2 });
    expect(out[1]).toEqual({ kind: "notice", text: "耗时 1.0s · 断流重连 1 次 · 等待较久 3 次", idleReconnects: 1, softIdleWarns: 3 });
    expect(out[2]).toEqual({ kind: "notice", text: "a" });
    expect(out[3]).toEqual({ kind: "notice", text: "b" });
    expect(out[4]).toEqual({ kind: "notice", text: "c" });
    expect(out[5]).toEqual({ kind: "notice", text: "d" });
  });
});
