// ω99-315 — settings 键 + run-stats 断流重连计数（217 收据加性扩展）。
//   settings  `stream.idleSoftMs` / `stream.idleHardMs`（typed，缺省
//             90000/300000；0=关该档；未知键警告、错型回退——output-config
//             的 Loader contract 同款）。v1 无设置页 UI（记池），键先经
//             settings 文件生效。
//   指标     driver 数 turn_retried{reasonClass:"idle"}，settle 收据的耗时行
//             追加「断流重连 N 次」（N=0 省略——老会话字节不变）；JSONL 的
//             run_stats_receipt data 加 idleReconnects（验证器向后兼容，
//             回放透传）。网络类恢复不计（只数看门狗杀掉的挂死）。
// 夹具全在 os.tmpdir()。
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createScriptedModel,
  createJsonlSessionStore,
  type ModelClient,
  type ModelInput,
  type ModelStreamEvent,
} from "@wudao-org/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver, formatRunStats } from "../src/driver/agent-driver.js";
import { loadStreamSettings, DEFAULT_STREAM_SETTINGS, streamIdleProviderOptions } from "../src/stream-idle-config.js";
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
  const ws = await mkdtemp(join(tmpdir(), "wd315-"));
  try {
    return await fn(ws);
  } finally {
    await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function writeSettings(ws: string, json: string): Promise<void> {
  await mkdir(join(ws, ".wudao"), { recursive: true });
  await writeFile(join(ws, ".wudao", "settings.json"), json, "utf8");
}

// ---------------------------------------------------------------------------
// settings: stream.idleSoftMs / idleHardMs
// ---------------------------------------------------------------------------

describe("ω99-315 stream settings (stream.idleSoftMs / idleHardMs)", () => {
  it("defaults: soft 90s, hard 300s", async () => {
    await withWs(async (ws) => {
      expect(await loadStreamSettings(ws)).toEqual(DEFAULT_STREAM_SETTINGS);
      expect(DEFAULT_STREAM_SETTINGS).toEqual({ idleSoftMs: 90_000, idleHardMs: 300_000 });
    });
  });

  it("typed keys take effect from the settings file; 0 is a legal (disabling) value", async () => {
    await withWs(async (ws) => {
      await writeSettings(ws, JSON.stringify({ stream: { idleSoftMs: 5_000, idleHardMs: 9_000 } }));
      expect(await loadStreamSettings(ws)).toEqual({ idleSoftMs: 5_000, idleHardMs: 9_000 });
      await writeSettings(ws, JSON.stringify({ stream: { idleSoftMs: 0 } }));
      expect(await loadStreamSettings(ws)).toEqual({ idleSoftMs: 0, idleHardMs: 300_000 });
    });
  });

  it("unknown keys warn; wrong types warn and fall back per-field; soft≥hard warns but passes through", async () => {
    await withWs(async (ws) => {
      const warns: string[] = [];
      await writeSettings(ws, JSON.stringify({ stream: { bogus: 1 } }));
      expect(await loadStreamSettings(ws, (m) => warns.push(m))).toEqual(DEFAULT_STREAM_SETTINGS);
      expect(warningsMentioning(warns, "bogus")).toBe(1);

      await writeSettings(ws, JSON.stringify({ stream: { idleSoftMs: "fast", idleHardMs: -3 } }));
      expect(await loadStreamSettings(ws, (m) => warns.push(m))).toEqual(DEFAULT_STREAM_SETTINGS);
      expect(warningsMentioning(warns, "idleSoftMs")).toBe(1);
      expect(warningsMentioning(warns, "idleHardMs")).toBe(1);

      await writeSettings(ws, JSON.stringify({ stream: { idleSoftMs: 9_000, idleHardMs: 5_000 } }));
      expect(await loadStreamSettings(ws, (m) => warns.push(m))).toEqual({ idleSoftMs: 9_000, idleHardMs: 5_000 });
      expect(warningsMentioning(warns, "smaller")).toBe(1);
    });
  });

  it("a non-object stream node warns and defaults", async () => {
    await withWs(async (ws) => {
      const warns: string[] = [];
      await writeSettings(ws, JSON.stringify({ stream: 7 }));
      expect(await loadStreamSettings(ws, (m) => warns.push(m))).toEqual(DEFAULT_STREAM_SETTINGS);
      expect(warningsMentioning(warns, "stream")).toBe(1);
    });
  });

  it("streamIdleProviderOptions: the ProviderOptions fragment (spreadable at every createProvider site)", async () => {
    expect(streamIdleProviderOptions(DEFAULT_STREAM_SETTINGS)).toEqual({ streamIdleSoftMs: 90_000, streamIdleHardMs: 300_000 });
    expect(streamIdleProviderOptions({ idleSoftMs: 0, idleHardMs: 0 })).toEqual({ streamIdleSoftMs: 0, streamIdleHardMs: 0 });
  });
});

function warningsMentioning(warns: readonly string[], needle: string): number {
  return warns.filter((w) => w.includes(needle)).length;
}

// ---------------------------------------------------------------------------
// run-stats: 断流重连 segment + receipt idleReconnects + replay passthrough
// ---------------------------------------------------------------------------

describe("ω99-315 formatRunStats idle segment", () => {
  it("N=0 omits the segment (byte-parity with old receipts); N>0 appends 断流重连 N 次", () => {
    // formatMs renders sub-second spans as "<1s" — the segments' presence and
    // order are the contract, the idle segment appends last.
    expect(formatRunStats(1_200, 800, 400, 2, 0)).toBe("耗时 1.2s · 模型 <1s · 工具 <1s (2 次)");
    expect(formatRunStats(1_200, 800, 400, 2, 3)).toBe("耗时 1.2s · 模型 <1s · 工具 <1s (2 次) · 断流重连 3 次");
    // default-arg: existing callers keep their exact text
    expect(formatRunStats(1_200, 800, 400, 2)).toBe("耗时 1.2s · 模型 <1s · 工具 <1s (2 次)");
  });
});

/** A streaming model: call 1 dies mid-delta with the named error; call 2
 *  completes. (createScriptedModel has no stream() — the recovery arm needs
 *  streamed deltas.) */
function dyingThenDoneModel(die: Error): ModelClient {
  let call = 0;
  return {
    generate: () => {
      throw new Error("should not be called");
    },
    async *stream(_input: ModelInput): AsyncGenerator<ModelStreamEvent> {
      call += 1;
      if (call === 1) {
        yield { type: "text_delta", text: "半夜断流" };
        throw die;
      }
      yield { type: "done", message: { role: "assistant", content: "续上" } };
    },
  };
}

describe("ω99-315 driver: idle reconnects land in the stats receipt", () => {
  it("an idle-class mid-stream recovery → stats notice + persisted run_stats_receipt idleReconnects", async () => {
    await withWs(async (ws) => {
      const die = Object.assign(new Error("stream idle for 300000ms without a chunk — watchdog abort"), { name: "StreamIdleError" });
      const driver = createAgentDriver({
        model: dyingThenDoneModel(die),
        tools: [],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        workspaceRoot: ws,
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
      const sid = driver.getSessionId();
      driver.submit("过夜任务");
      await until(() => driver.getStatus().busy === false && driver.getHistory().some((e) => e.kind === "notice" && e.text.includes("耗时")), "run settled");
      await wait(50); // fire-and-forget persistence flush
      const stats = driver.getHistory().filter((e) => e.kind === "notice" && e.text.includes("耗时"));
      expect(stats.some((n) => (n as { text: string }).text.includes("断流重连 1 次"))).toBe(true);
      const store = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
      const entries = await store.loadSessionEntries(sid);
      const st = entries.filter((e) => e.type === "run_stats_receipt");
      expect(st).toHaveLength(1);
      expect((st[0] as { data: { idleReconnects?: number } }).data.idleReconnects).toBe(1);
      driver.dispose();
    });
  });

  it("a network-class mid-stream recovery does NOT count (only the watchdog's idle class does)", async () => {
    await withWs(async (ws) => {
      const driver = createAgentDriver({
        model: dyingThenDoneModel(new Error("socket hang up")),
        tools: [],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        workspaceRoot: ws,
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
      const sid = driver.getSessionId();
      driver.submit("过夜任务");
      await until(() => driver.getStatus().busy === false && driver.getHistory().some((e) => e.kind === "notice" && e.text.includes("耗时")), "run settled");
      await wait(50);
      const stats = driver.getHistory().filter((e) => e.kind === "notice" && e.text.includes("耗时"));
      expect(stats.every((n) => !(n as { text: string }).text.includes("断流重连"))).toBe(true);
      const store = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
      const entries = await store.loadSessionEntries(sid);
      const st = entries.filter((e) => e.type === "run_stats_receipt");
      expect((st[0] as { data: { idleReconnects?: number } }).data.idleReconnects).toBeUndefined();
      driver.dispose();
    });
  });
});

describe("ω99-315 receipt replay: idleReconnects is additive", () => {
  it("a new receipt replays with the count; an old receipt replays exactly as before", () => {
    const out = receiptNoticesFromEntries([
      { type: "run_stats_receipt", data: { text: "耗时 1.2s · 断流重连 2 次", idleReconnects: 2 } },
      { type: "run_stats_receipt", data: { text: "耗时 0.9s" } },
      // malformed count drops the FIELD but keeps the notice (never the run)
      { type: "run_stats_receipt", data: { text: "耗时 0.8s", idleReconnects: "many" } },
    ]);
    expect(out[0]).toEqual({ kind: "notice", text: "耗时 1.2s · 断流重连 2 次", idleReconnects: 2 });
    expect(out[1]).toEqual({ kind: "notice", text: "耗时 0.9s" });
    expect(out[2]).toEqual({ kind: "notice", text: "耗时 0.8s" });
  });
});

// keep the import referenced even if the scripted model path changes
void createScriptedModel;
