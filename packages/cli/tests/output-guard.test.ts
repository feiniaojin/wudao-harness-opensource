// 夜移 034 — stdout 背压守卫（pi packages/coding-agent/src/core/output-guard.ts
// 移植）。一次性模式往管道慢消费者（head/jq/下游管道）流式写答案时：
// ①write 回调可携 EAGAIN/ENOBUFS/EWOULDBLOCK（非阻塞管道缓冲满）——裸
// process.stdout.write 从不看回调，错误静默丢、尾部在进程退出时截断丢；
// ②多处并发写（delta 流+工具标记+回执）可交错帧。守卫 = 逐块回调验证 +
// 可重试码 10ms 退避重试 + promise-tail 串行（一次至多一块在飞）+ 出口
// flush 空探针（回调序即写序，空写回调落地=队列排干）。致命错（非可重试
// 码）一次性 onFatal（默认 exit(1)，测试注入），此后 lane 死亡：后续入队
// 静默跳过、flush 如实 reject。
import { describe, it, expect } from "vitest";
import { createOutputGuard, type RawStdoutTarget } from "../src/output-guard.js";

/** Programmable fake: one scripted outcome per write ATTEMPT, "ok" lands the chunk. */
type Outcome = { readonly code?: string; readonly throwSync?: boolean } | "ok";

interface FakeTarget {
  readonly target: RawStdoutTarget;
  readonly landed: string[];
  /** every chunk the target SAW (including retried attempts' chunks). */
  readonly seen: string[];
  attempts(): number;
  /** peak number of write attempts issued but not yet callback-settled. */
  peakInFlight(): number;
}

function fakeTarget(script: readonly Outcome[], settle = "sync"): FakeTarget {
  const landed: string[] = [];
  const seen: string[] = [];
  let attempts = 0;
  let inFlight = 0;
  let peak = 0;
  const target: RawStdoutTarget = {
    write(chunk: string | Uint8Array, callback?: (error?: Error | null) => void): boolean {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      attempts += 1;
      seen.push(text);
      const outcome = script[Math.min(attempts - 1, script.length - 1)] ?? "ok";
      const cb = callback ?? (() => {});
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const settleNow = (): void => {
        inFlight -= 1;
        if (outcome === "ok") {
          landed.push(text);
          cb(null);
        } else {
          const err = new Error(`fake ${outcome.code ?? "unknown"}`);
          (err as Error & { code?: string }).code = outcome.code;
          cb(err);
        }
      };
      if (outcome !== "ok" && outcome.throwSync === true) {
        inFlight -= 1;
        const err = new Error(`fake sync ${outcome.code}`);
        (err as Error & { code?: string }).code = outcome.code;
        throw err;
      }
      if (settle === "sync") settleNow();
      else setTimeout(settleNow, 0);
      return true;
    },
  };
  return { target, landed, seen, attempts: () => attempts, peakInFlight: () => peak };
}

const fatal: { errors: Error[] } = { errors: [] };

function guard(fake: FakeTarget, opts: { retryDelayMs?: number } = {}) {
  return createOutputGuard(fake.target, {
    retryDelayMs: opts.retryDelayMs ?? 1,
    onFatal: (error) => fatal.errors.push(error),
  });
}

describe("夜移 034 — output guard: serialization + retry + fatal lane", () => {
  it("writes are serialized through the tail: order preserved, at most ONE attempt in flight", async () => {
    const fake = fakeTarget(["ok"]);
    const g = guard(fake);
    g.writeRawStdout("alpha\n");
    g.writeRawStdout("beta\n");
    g.writeRawStdout("gamma\n");
    await g.flushRawStdout();
    expect(fake.landed).toEqual(["alpha\n", "beta\n", "gamma\n", ""]); // + the flush probe
    expect(fake.peakInFlight()).toBe(1);
  });

  it("EAGAIN / ENOBUFS / EWOULDBLOCK retry with backoff until the chunk lands exactly once", async () => {
    for (const code of ["EAGAIN", "ENOBUFS", "EWOULDBLOCK"]) {
      const fake = fakeTarget([{ code }, { code }, "ok"]);
      const g = guard(fake);
      g.writeRawStdout("payload");
      await g.flushRawStdout();
      expect(fake.landed).toEqual(["payload", ""]); // once (not three) + the flush probe
      expect(fake.attempts()).toBe(4); // 3 for the chunk + 1 probe
    }
  });

  it("a SYNCHRONOUS throw carrying a retryable code goes down the same retry path", async () => {
    const fake = fakeTarget([{ code: "EAGAIN", throwSync: true }, "ok"]);
    const g = guard(fake);
    g.writeRawStdout("sync-throw");
    await g.flushRawStdout();
    expect(fake.landed).toEqual(["sync-throw", ""]); // + the flush probe
    expect(fake.attempts()).toBe(3);
  });

  it("a non-retryable error is fatal ONCE: onFatal fires, the lane dies, flush rejects honestly", async () => {
    const fake = fakeTarget([{ code: "EIO" }]);
    const g = guard(fake);
    g.writeRawStdout("doomed");
    // let the tail settle (retry delay won't apply — EIO is not retryable)
    await new Promise((r) => setTimeout(r, 10));
    expect(fatal.errors).toHaveLength(1);
    expect(fatal.errors[0]?.message).toContain("EIO");
    // the lane is dead: later writes make NO new attempts
    const before = fake.attempts();
    g.writeRawStdout("after death");
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.attempts()).toBe(before);
    // and flush reports the death instead of pretending a drain
    await expect(g.flushRawStdout()).rejects.toThrow("EIO");
  });

  it("an empty write enqueues nothing; flush issues exactly ONE empty drain probe", async () => {
    const fake = fakeTarget(["ok"]);
    const g = guard(fake);
    g.writeRawStdout("");
    expect(fake.attempts()).toBe(0);
    await g.flushRawStdout();
    // only the probe: the callback-verified empty write whose landing
    // certifies everything queued before it has drained (callbacks fire in
    // write order)
    expect(fake.seen).toEqual([""]);
    expect(fake.landed).toEqual([""]);
  });

  it("flush waits for chunks enqueued while an earlier one was in flight", async () => {
    const fake = fakeTarget(["ok"], "async");
    const g = guard(fake);
    g.writeRawStdout("first");
    g.writeRawStdout("second"); // enqueued while first is in flight
    await g.flushRawStdout();
    expect(fake.landed).toEqual(["first", "second", ""]); // + the probe
    expect(fake.peakInFlight()).toBe(1); // serialization held despite async settles
  });

  it("waitForRawStdoutBackpressure settles the tail without issuing a probe", async () => {
    const fake = fakeTarget(["ok"], "async");
    const g = guard(fake);
    g.writeRawStdout("a");
    g.writeRawStdout("b");
    await g.waitForRawStdoutBackpressure();
    expect(fake.landed).toEqual(["a", "b"]);
    expect(fake.seen).toEqual(["a", "b"]); // no "" probe
  });
});
