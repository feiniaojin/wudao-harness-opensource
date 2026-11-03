// ω99-68 — the driver's consumer side of ω99-48's appendAttemptEntry seam:
// a streaming attempt that dies mid-flight (non-abort) settles exactly ONE
// log-only `assistant_attempt` entry on the session JSONL — byte shape =
// core's construction, verbatim (the driver adds/rewrites no field). The
// success and abort paths write zero entries (abort bypasses the seam by
// construction — the 夜移 001 twin keeps its bytes instead). Deterministic:
// scripted streaming models + a temp JSONL store.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionStore } from "@wudao-org/core";
import type { ModelClient, ModelInput, ModelStreamEvent, ModelUsage, SessionEntry } from "@wudao-org/core";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriverOptions, AgentDriver } from "../src/driver/agent-driver.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

// 回滚重做 T2d（同族扫尾）：store.loadSessionEntries 走内存缓存时可先于
// 磁盘返回；原始行字节核对必须轮询至文件真含 assistant_attempt 行。
async function rawJsonlWhen(marker: string, timeoutMs = 5000): Promise<string> {
  const file = join(root, "sessions", "w68fail.jsonl");
  const start = Date.now();
  for (;;) {
    const content = await readFile(file, "utf8").catch(() => "");
    if (content.includes(marker)) return content;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for raw JSONL to contain ${JSON.stringify(marker)}`);
    await wait(25);
  }
}

const allow = async () => ({ kind: "allow" as const });

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "w68-att-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });

function makeDriver(opts: Partial<AgentDriverOptions> & Pick<AgentDriverOptions, "model" | "tools">): AgentDriver {
  return createAgentDriver({ systemPrompt: "s", summarize: (_n, i) => JSON.stringify(i).slice(0, 60), ...opts });
}

const USAGE_ROW: ModelUsage = { promptTokens: 1200, cacheHitTokens: 900, cacheMissTokens: 300 };

/** 48's failingStreamModel, driver lane: deliver deltas, optionally fire the
 *  provider usage row, then reject — the mid-stream failure shape. */
function failingStreamModel(spec: { deltas: readonly ModelStreamEvent[]; error: Error; usage?: ModelUsage }): ModelClient & { calls: () => number } {
  let calls = 0;
  const model: ModelClient = {
    generate: () => { throw new Error("should not be called"); },
    async *stream(input: ModelInput) {
      calls += 1;
      for (const d of spec.deltas) yield d;
      if (spec.usage !== undefined) input.onUsage?.(spec.usage);
      throw spec.error;
    },
  };
  return Object.assign(model, { calls: () => calls });
}

/** 48's abortingStreamModel: deltas, then parked until the request's abort
 *  signal fires (rejects AbortError). `parked` resolves once the deltas are
 *  out — the test's deterministic interrupt point. */
function abortingStreamModel(deltas: readonly ModelStreamEvent[]): ModelClient & { parked: Promise<void> } {
  let park!: () => void;
  const parked = new Promise<void>((r) => { park = r; });
  const model: ModelClient = {
    generate: () => { throw new Error("should not be called"); },
    async *stream(input: ModelInput) {
      for (const d of deltas) yield d;
      park();
      await new Promise<never>((_, reject) => {
        input.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
        );
      });
    },
  };
  return Object.assign(model, { parked });
}

/** A completing stream (the success-lane control). */
function completingStreamModel(): ModelClient {
  return {
    generate: () => { throw new Error("should not be called"); },
    async *stream() {
      yield { type: "text_delta", text: "完整回答" };
      yield { type: "done", message: { role: "assistant", content: "完整回答" } };
    },
  };
}

const attemptsOf = (entries: readonly SessionEntry[]) =>
  entries.filter((e): e is Extract<SessionEntry, { type: string }> => !("role" in e) && e.type === "assistant_attempt");

const attemptLines = (raw: string) => raw.split("\n").filter((l) => l.trim().length > 0 && l.includes('"assistant_attempt"'));

describe("ω99-68 driver attempt settlement (consumer side)", () => {
  it("mid-stream failure settles exactly ONE assistant_attempt entry; byte shape = core's construction verbatim", async () => {
    const store = createJsonlSessionStore(join(root, "sessions"));
    const model = failingStreamModel({
      deltas: [{ type: "text_delta", text: "已经渲染的" }, { type: "text_delta", text: "失败前缀" }],
      error: new Error("gateway 5xx mid-stream"),
      usage: USAGE_ROW,
    });
    const driver = makeDriver({ model, tools: [], onPermissionAsk: allow, sessionStore: store, sessionId: "w68fail" });
    driver.submit("go");
    await until(() => driver.getStatus().busy === false, "failed run to settle");
    driver.dispose();

    // 1 initial call + 3 ω99-9 turn-recovery retries, then the final rethrow.
    expect(model.calls()).toBe(4);
    const attempts = attemptsOf(await store.loadSessionEntries("w68fail"));
    expect(attempts.length).toBe(1);
    const a = attempts[0]!;
    const d = a.data as { content: string; reasoning: string; usage?: ModelUsage; at: string; error: string };
    // 恰一条，形状即契约（type 字符串逐字；键集精确，无自造/改写字段）。
    expect(a.type).toBe("assistant_attempt");
    expect(Object.keys(d).sort()).toEqual(["at", "content", "error", "reasoning", "usage"]);
    expect(d.content).toBe("已经渲染的失败前缀");
    expect(d.reasoning).toBe("");
    expect(d.error).toBe("gateway 5xx mid-stream");
    expect(d.usage).toEqual(USAGE_ROW);
    expect(Number.isNaN(Date.parse(d.at))).toBe(false);
    const raw = await rawJsonlWhen('"assistant_attempt"');
    expect(attemptLines(raw).length).toBe(1);
  });

  it("success path settles zero entries (negative control)", async () => {
    const store = createJsonlSessionStore(join(root, "sessions"));
    const driver = makeDriver({ model: completingStreamModel(), tools: [], onPermissionAsk: allow, sessionStore: store, sessionId: "w68ok" });
    driver.submit("hi");
    await until(() => driver.getStatus().busy === false, "run to finish");
    driver.dispose();
    expect(attemptsOf(await store.loadSessionEntries("w68ok"))).toEqual([]);
  });

  it("abort path settles zero entries — the seam is bypassed by construction in the production lane", async () => {
    const store = createJsonlSessionStore(join(root, "sessions"));
    const model = abortingStreamModel([{ type: "text_delta", text: "已经流出的" }, { type: "text_delta", text: "部分回答" }]);
    const driver = makeDriver({ model, tools: [], onPermissionAsk: allow, sessionStore: store, sessionId: "w68abort" });
    driver.submit("go");
    await model.parked; // inside the stream, deltas delivered
    driver.interrupt();
    await until(() => driver.getStatus().busy === false, "aborted run to settle");
    driver.dispose();
    expect(attemptsOf(await store.loadSessionEntries("w68abort"))).toEqual([]);
  });
});
