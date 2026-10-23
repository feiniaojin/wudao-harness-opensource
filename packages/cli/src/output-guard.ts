// 夜移 034 — stdout 背压守卫（pi packages/coding-agent/src/core/output-guard.ts
// 移植，适配 wudao 的注入纪律）。一次性模式往管道慢消费者（head/jq/下游
// 管道）流式写答案时有三类裸写事故：
//   · write 回调携 EAGAIN/ENOBUFS/EWOULDBLOCK（非阻塞管道缓冲满）——裸
//     process.stdout.write 从不看回调，错误静默丢失；
//   · 进程退出不排干 stdio——缓冲中的尾部直接截断丢（一次性模式答案的
//     最后几段，"字段级丢"）；
//   · 多处并发写（delta 流 + 工具标记 + 回执）在背压下交错帧。
// 守卫语义（与 pi 同）：逐块回调验证；可重试码 10ms 退避无限重试（同块
// 原文重发）；promise-tail 串行（一次至多一块在飞，帧永不交错）；出口
// flush 空探针——回调序即写序，空写的回调落地即证明此前的队列已排干。
// 致命错（非可重试码）一次性 onFatal（默认写 stderr 后 exit(1)——stdout
// 不可恢复，静默挂死更糟；pi 同判），此后 lane 死亡：后续入队静默跳过、
// flush 如实 reject。
// 分叉：pi 绑死 process.stdout 且无测试缝；wudao 的 target 注入（repl.ts
// 的 opts.stdout 同款纪律）+ onFatal/retryDelayMs 可注入，测试与 TUI 接管
// （未来）共用一实现。pi 的 B 半（takeOverStdout TUI 期间重定向 stderr）
// wudao 无消费者，不移植——夜移 034 只取 A 半（背压纪律）。
export interface RawStdoutTarget {
  write(chunk: string | Uint8Array, callback?: (error?: Error | null) => void): boolean;
}

export interface OutputGuard {
  /** 同步入队（火忘式，流式热路径用）；串行经尾 promise；致命错后静默跳过。 */
  writeRawStdout(text: string): void;
  /** 等尾 settle（期间又有新入队会再等——诚实排干）；致命错时 reject。 */
  waitForRawStdoutBackpressure(): Promise<void>;
  /** 排干 + 一次空探针写（其回调落地 = 此前队列全部落地）。进程出口前调用。 */
  flushRawStdout(): Promise<void>;
}

export interface OutputGuardOptions {
  /** 可重试码的退避间隔；默认 10ms（pi 同值）。 */
  readonly retryDelayMs?: number;
  /** 致命错回调；默认 stderr 一行 + exit(1)。 */
  readonly onFatal?: (error: Error) => void;
}

const RETRYABLE_CODES: ReadonlySet<string> = new Set(["ENOBUFS", "EAGAIN", "EWOULDBLOCK"]);
const DEFAULT_RETRY_DELAY_MS = 10;

export function createOutputGuard(target: RawStdoutTarget, options: OutputGuardOptions = {}): OutputGuard {
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const onFatal =
    options.onFatal ??
    ((error: Error): void => {
      process.stderr.write(`wudao: stdout write failed permanently: ${error.message}\n`);
      process.exit(1);
    });
  let tail: Promise<void> = Promise.resolve();
  let dead = false;

  // 单块写：回调验证 + 可重试码退避重试（同块原文无限重发）。同步 throw
  // （pi :29-31 同款 try/catch）与回调错走同一条重试判。
  const writeChunk = async (text: string): Promise<void> => {
    for (;;) {
      try {
        await new Promise<void>((resolve, reject) => {
          try {
            target.write(text, (error) => {
              if (error !== null && error !== undefined) reject(error);
              else resolve();
            });
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
        return;
      } catch (error) {
        const writeError = error instanceof Error ? error : new Error(String(error));
        const code = (writeError as Error & { code?: unknown }).code;
        if (typeof code !== "string" || !RETRYABLE_CODES.has(code)) throw writeError;
        await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  };

  const waitForTail = async (): Promise<void> => {
    for (;;) {
      const current = tail;
      await current;
      if (current === tail) return;
    }
  };

  return {
    writeRawStdout(text: string): void {
      if (text.length === 0 || dead) return;
      tail = tail.then(() => writeChunk(text));
      // 首个致命 reject 触发一次性 onFatal 并封 lane；catch 挂在每次赋值
      // 后的尾上，promise 永不落 unhandled。
      void tail.catch((error: unknown) => {
        if (dead) return;
        dead = true;
        onFatal(error instanceof Error ? error : new Error(String(error)));
      });
    },
    async waitForRawStdoutBackpressure(): Promise<void> {
      await waitForTail();
    },
    async flushRawStdout(): Promise<void> {
      await waitForTail();
      // 空探针：回调序 = 写序，空写回调落地即证明此前全部落地。lane 已
      // 死时上面 waitForTail 已 reject，探针不会发出。
      await writeChunk("");
    },
  };
}

/** 生产默认实例：绑定 process.stdout。TTY 同步写零开销；管道走全部纪律。 */
export const stdoutGuard: OutputGuard = createOutputGuard(process.stdout);
