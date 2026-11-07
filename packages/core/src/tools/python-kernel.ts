// 114 取证弧（docs/research/114-tb-longtask-forensics.md §3/§6-5）— 持久
// Python kernel：会话内跨调用的计算状态车道。取证裁定：长程计算任务的
// 状态重建税真实（video-q 同一段视频重解码 ×125、gcode 全文重解析 ≥10
// 次、sam 41 次 python 调用反复 import torch/重载权重——所在会话 10-30%
// 墙钟），且"终端即内存"反模式（print 中间结果当存储）加剧上下文淹没。
// 本工具把两类税一起收：变量/imports 驻留 RAM（kernel 状态），print 只留
// 蒸馏事实（上下文卫生）。
//
// 机制（run_script 的 file-RPC 协议反向复用）：会话级单例 python3 子进程
// 跑一个 cell 泵循环——父进程原子写 `cell-<n>.py`（tmp+rename），kernel
// exec 该 cell（捕获 stdout/stderr/异常，异常不杀进程），原子回写
// `cell-<n>.json`；父进程轮询 res 文件，带每-cell 墙钟帽。同一 channel
// 形状、同一原子写纪律、同一截断纪律——roles 互换（run_script 是子写
// req 父写 res，这里是父写 req 子写 res）。
//
// 生命周期：
//   懒 spawn     零动作零进程——第一次 cell 才 spawn（LSP/TerminalManager
//               同款纪律）。
//   idle 回收    最后一次 cell 完成后 idleTimeoutMs（缺省 15min，settings
//               pythonKernel.idleTimeoutMs 可调，0=永不）无新 cell →
//               SIGTERM→2s→SIGKILL 阶梯回收。计时器 unref——绝不拽住
//               事件循环。
//   孤儿保护     kernel 侧 stdin-EOF 看护线程：父进程死亡（含被 SIGKILL）
//               →管道 EOF → os._exit(0)。kernel 永不孤儿。
//   进程退出钩   有活子进程时注册 process.on("exit") 同步 SIGKILL——
//               kernel 不比 harness 进程活得久。
//   崩溃/超时    下次调用透明冷启，回执注明 "restarted after … (state
//               lost)"（诚实披露状态已丢）。reset:true 显式重启。
//   driver 死   工具带 stop() 面——CLI driver dispose 遍历 tools 调
//               stop?.()（会话清理缝，kernel 随 driver dispose 死）。
//
// 信任模型（诚实 v1，与 run_script python lane 同级、同款披露）：kernel
// 无文件系统沙箱（python3 -I 只隔离 imports/env）——信任级别=shell：每次
// 调用过正常权限门、每-cell 超时兜时长、stdout 帽兜回传、kernel 自身文
// 件系统可达面无约束。**不做**逐 cell 的 call() RPC 门：kernel 是纯计算
// 车道，不调工具、不碰 harness 面（run_script 的 call() 缝在这里不存在）；
// 若未来 kernel 要调工具，逐调用权限门变为必选项——此边界在此声明。
// cwd 沿 agent root（kernel spawn 时读 live root；驻留期间 root 切换不
// 改已活 kernel 的 cwd，reset 后跟新根——诚实 v1，无路径参数即无
// resolveWorkspacePath 面）。
//
// M24 契约声明：kernel 进程态在本 harness 进程内，与对话历史完全正交
// （零缓存代价——不触碰任何历史字节）。工具 schema 进 tools 列表=跨版本
// 一次性冷点（新槽位，append-only 纪律），会话内前缀字节稳定。
//
// 124 项 3（kernel 子代理 fan-in 设计文档：docs/research/124-kernel-fanin-design.md）
// — v1 边界不变量：python_kernel 永远不出现在 childToolsFor / run_script 的
// 内层 call() 池 / 任何 deferred 路径。多子代理并行 + 各需 kernel 的场景
// = N 个独立冷启（idle 回收窗自动清理），fan-in 走 agent_await 文本层。
// 共享 kernel 进程是 v3+ 工作（v1 不引入新进程管理面）。
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool } from "../tool.js";
import type { Tool } from "../tool.js";
import type { ToolResult } from "../types.js";
import { truncateSafe } from "../text-truncate.js";
import { scrubChildEnv } from "./shell.js";

/** 空闲回收窗口（缺省 15 分钟；settings pythonKernel.idleTimeoutMs 可调）。 */
export const PYTHON_KERNEL_DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000;
/** 单 cell 墙钟帽（缺省；沿 run_script 的 120s script-timeout 姿态）。 */
export const PYTHON_KERNEL_CELL_TIMEOUT_MS = 120_000;
/** 单 cell stdout 帽（字符；run_script 50KB 姿态的字符口径）。 */
export const PYTHON_KERNEL_MAX_STDOUT_CHARS = 50_000;
/** kernel 会话目录前缀（tmp-sweep 崩溃守卫同款纪律，单一真值点）。 */
export const PYTHON_KERNEL_TMP_PREFIX = "wudao-kernel-";
/** stderr 只在失败回执出现（run_script 同款 2KB head 预算）。 */
const MAX_STDERR_CHARS = 2_000;
/** traceback/错误文本帽（错误是模型可见字节，同 stderr 预算纪律）。 */
const MAX_ERROR_CHARS = 4_000;
/** 冷启 ready 文件等待帽。 */
const BOOT_TIMEOUT_MS = 10_000;
/** 轮询节拍（run_script 的 POLL_MS 同款）。 */
const POLL_MS = 20;
/** kill 阶梯：SIGTERM → 2s → SIGKILL。 */
const SIGKILL_GRACE_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// kernel 侧 cell 泵循环（纯 stdlib；globals() 即 cell 命名空间——变量/
// imports 跨 cell 驻留）。stdin-EOF 看护线程=孤儿保护：父进程死亡（含被
// SIGKILL）→管道 EOF→os._exit(0)。捕获帽在 kernel 侧绑定 RAM（一个
// print 1GB 的 cell 不会 OOM kernel）；python str 按 code point 切分，永
// 不劈代理对（父侧 truncateSafe 再做一次权威截断，防任何例外字节）。
// SystemExit/KeyboardInterrupt 一并捕获（cell 想杀 kernel 不得逞——异常
// 回传，进程继续活）。
const KERNEL_LOOP = [
  "import io, json, os, sys, threading, time, traceback",
  "",
  "__dir = os.environ['WUDAO_KERNEL_DIR']",
  "__stdout_cap = int(os.environ.get('WUDAO_KERNEL_STDOUT_CAP', '50000'))",
  "__stderr_cap = int(os.environ.get('WUDAO_KERNEL_STDERR_CAP', '2000'))",
  "",
  "def __watch_stdin():",
  "    try:",
  "        while sys.stdin.buffer.read(4096) != b'':",
  "            pass",
  "    except Exception:",
  "        pass",
  "    os._exit(0)",
  "",
  "threading.Thread(target=__watch_stdin, daemon=True).start()",
  "",
  "class __Cap(io.TextIOBase):",
  "    def __init__(self, cap):",
  "        self.parts = []",
  "        self.n = 0",
  "        self.cap = cap",
  "        self.truncated = False",
  "    def write(self, s):",
  "        if not isinstance(s, str):",
  "            s = str(s)",
  "        self.n += len(s)",
  "        if self.n > self.cap:",
  "            self.truncated = True",
  "            room = self.cap - (self.n - len(s))",
  "            if room > 0:",
  "                self.parts.append(s[:room])",
  "        else:",
  "            self.parts.append(s)",
  "        return len(s)",
  "    def text(self):",
  "        return ''.join(self.parts)",
  "",
  "def __atomic_write(path, data):",
  "    with open(path + '.tmp', 'w', encoding='utf-8') as f:",
  "        f.write(data)",
  "    os.replace(path + '.tmp', path)",
  "",
  "__atomic_write(os.path.join(__dir, 'ready'), '')",
  "",
  "while True:",
  "    __target = None",
  "    try:",
  "        __names = sorted(os.listdir(__dir))",
  "    except OSError:",
  "        __names = []",
  "    for __name in __names:",
  "        if __name.startswith('cell-') and __name.endswith('.py'):",
  "            __target = __name",
  "            break",
  "    if __target is None:",
  "        time.sleep(0.02)",
  "        continue",
  "    __path = os.path.join(__dir, __target)",
  "    try:",
  "        with open(__path, 'r', encoding='utf-8') as f:",
  "            __code = f.read()",
  "        os.remove(__path)",
  "    except OSError:",
  "        continue",
  "    __out, __err = __Cap(__stdout_cap), __Cap(__stderr_cap)",
  "    __error = None",
  "    __saved_out, __saved_err = sys.stdout, sys.stderr",
  "    sys.stdout, sys.stderr = __out, __err",
  "    try:",
  "        exec(compile(__code, '<cell>', 'exec'), globals())",
  "    except BaseException:",
  "        __error = traceback.format_exc()",
  "    finally:",
  "        sys.stdout, sys.stderr = __saved_out, __saved_err",
  "    __atomic_write(os.path.join(__dir, __target[:-3] + '.json'), json.dumps({",
  "        'ok': __error is None,",
  "        'stdout': __out.text(),",
  "        'stdoutTruncated': __out.truncated,",
  "        'stderr': __err.text(),",
  "        'stderrTruncated': __err.truncated,",
  "        'error': __error,",
  "    }, ensure_ascii=False))",
].join("\n");

export interface PythonKernelOptions {
  /** kernel cwd（缺省本进程 cwd；live-root options 对象沿 run_script 的
   *  workspace-ux B2 缝——kernel spawn 时读，agentRootSwitch 后的 reset
   *  跟新根）。 */
  readonly cwd?: string;
  /** 空闲回收窗口（缺省 15min；0=永不回收——进程退出钩仍然兜底）。 */
  readonly idleTimeoutMs?: number;
  /** 单 cell 墙钟帽。 */
  readonly cellTimeoutMs?: number;
  /** 单 cell stdout 帽（字符）。 */
  readonly maxStdoutChars?: number;
}

/** The tool face plus the eager-cleanup seam: `stop()` kills the kernel
 *  (bounded ladder, idempotent) — the CLI driver's dispose walks the tool
 *  array calling `stop?.()` so the kernel dies with the session. */
export type PythonKernelTool = Tool & { readonly stop: () => void };

interface KernelProc {
  readonly child: ChildProcess;
  readonly dir: string;
  seq: number;
  /** best-effort stderr tail（崩溃诊断；管道被动排水，永不蓄满）。 */
  stderrTail: string;
  /** 我方 kill 阶梯持有退出时为 true（close 处理器不得把主动 kill 误标
   *  为 crash——idle/timeout/reset 的死因标签在 kill 前已写）。 */
  killing: boolean;
  exited: boolean;
}

interface CellOutcome {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stdoutTruncated: boolean;
  readonly stderr: string;
  readonly stderrTruncated: boolean;
  readonly error: string | null;
}

export function createPythonKernelTool(options: PythonKernelOptions = {}): PythonKernelTool {
  const idleTimeoutMs = options.idleTimeoutMs ?? PYTHON_KERNEL_DEFAULT_IDLE_TIMEOUT_MS;
  const cellTimeoutMs = options.cellTimeoutMs ?? PYTHON_KERNEL_CELL_TIMEOUT_MS;
  const maxStdoutChars = options.maxStdoutChars ?? PYTHON_KERNEL_MAX_STDOUT_CHARS;
  const cwd = (): string => options.cwd ?? process.cwd();

  let kernel: KernelProc | undefined;
  let busy = false;
  /** 死因标签：下次冷启回执披露（"idle cleanup" | "crash" | "cell timeout"）。 */
  let pendingRestartReason: string | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let exitHook: (() => void) | undefined;

  const disarmIdle = (): void => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const armIdle = (): void => {
    disarmIdle();
    if (idleTimeoutMs <= 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      const k = kernel;
      if (k === undefined || busy) return;
      pendingRestartReason ??= "idle cleanup";
      void killKernel(k).catch(() => {});
    }, idleTimeoutMs);
    idleTimer.unref?.();
  };

  const killKernel = async (k: KernelProc): Promise<void> => {
    k.killing = true;
    disarmIdle();
    if (exitHook !== undefined) {
      process.removeListener("exit", exitHook);
      exitHook = undefined;
    }
    if (!k.exited) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const drop = setTimeout(finish, SIGKILL_GRACE_MS + 1_000);
        drop.unref?.();
        k.child.once("close", () => {
          clearTimeout(drop);
          finish();
        });
        try {
          k.child.kill("SIGTERM");
        } catch {
          finish();
        }
        const esk = setTimeout(() => {
          try {
            k.child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }, SIGKILL_GRACE_MS);
        esk.unref?.();
      });
    }
    if (kernel === k) kernel = undefined;
    await rm(k.dir, { recursive: true, force: true }).catch(() => {});
  };

  /** 冷启：fresh 会话目录 + spawn + ready 握手。失败 = typed 拒绝。 */
  const bootKernel = async (): Promise<{ ok: true; k: KernelProc } | { ok: false; receipt: ToolResult }> => {
    let dir: string;
    try {
      dir = await realpath(await mkdtemp(join(tmpdir(), PYTHON_KERNEL_TMP_PREFIX)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, receipt: { content: `python_kernel failed: cannot create the kernel workdir: ${message}`, isError: true } };
    }
    const loopPath = join(dir, "kernel.py");
    await writeFile(loopPath, `${KERNEL_LOOP}\n`, "utf8");
    // Credential-scrubbed env（shell/run_script 共款纪律）+ channel 变量。
    // NODE_OPTIONS 删除沿 run_script（对称性；python 本就不读它）。
    const env = scrubChildEnv();
    delete env.NODE_OPTIONS;
    env.WUDAO_KERNEL_DIR = dir;
    env.WUDAO_KERNEL_STDOUT_CAP = String(maxStdoutChars);
    env.WUDAO_KERNEL_STDERR_CAP = String(MAX_STDERR_CHARS);
    // stdin=pipe：kernel 的 stdin-EOF 看护线程靠它做孤儿保护（父死→EOF→退）。
    const child = spawn("python3", [loopPath], { cwd: cwd(), env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const k: KernelProc = { child, dir, seq: 0, stderrTail: "", killing: false, exited: false };
    let spawnError: Error | undefined;
    // 被动排水（cell 里的后台线程事后 print 不至于涨满管道）；stderr 留
    // 小尾巴作崩溃诊断。
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", (chunk: Buffer) => {
      k.stderrTail = (k.stderrTail + chunk.toString("utf8")).slice(-MAX_STDERR_CHARS);
    });
    child.on("error", (err) => {
      spawnError = err;
    });
    child.once("close", () => {
      k.exited = true;
      if (kernel === k) kernel = undefined;
      if (!k.killing) pendingRestartReason ??= "crash";
    });
    // 进程退出钩：kernel 不比 harness 进程活得久（同步 SIGKILL）。
    exitHook = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    process.on("exit", exitHook);
    const ready = (): Promise<boolean> => readFile(join(dir, "ready"), "utf8").then(() => true, () => false);
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (spawnError === undefined && !(await ready()) && Date.now() < deadline) {
      await sleep(POLL_MS);
    }
    if (spawnError !== undefined || !(await ready())) {
      const code = spawnError !== undefined ? (spawnError as NodeJS.ErrnoException).code : undefined;
      if (code === "ENOENT") {
        await killKernel(k).catch(() => {});
        return {
          ok: false,
          receipt: {
            content: "python_kernel failed: python3 not found on PATH — the kernel requires a python3 binary; no silent fallback",
            isError: true,
          },
        };
      }
      const detail = spawnError !== undefined
        ? spawnError.message
        : k.exited && k.stderrTail.trim() !== ""
          ? `kernel exited during boot: ${k.stderrTail.trim()}`
          : k.exited
            ? "kernel exited during boot"
            : `no ready marker within ${BOOT_TIMEOUT_MS / 1000}s`;
      await killKernel(k).catch(() => {});
      return { ok: false, receipt: { content: `python_kernel failed: kernel boot failed: ${detail}`, isError: true } };
    }
    kernel = k;
    armIdle();
    return { ok: true, k };
  };

  /** 写入 cell 文件（tmp+rename 原子）并推进序号。 */
  const writeCell = async (k: KernelProc, code: string): Promise<number> => {
    k.seq += 1;
    const final = join(k.dir, `cell-${k.seq}.py`);
    const tmp = `${final}.tmp`;
    await writeFile(tmp, code, "utf8");
    await rename(tmp, final);
    return k.seq;
  };

  /** 跑一个 cell：轮询 res 文件 / 进程死 / 墙钟帽三路竞速。 */
  const runCell = async (k: KernelProc, code: string): Promise<{ kind: "done"; outcome: CellOutcome } | { kind: "timeout" } | { kind: "crashed" }> => {
    const n = await writeCell(k, code);
    const resPath = join(k.dir, `cell-${n}.json`);
    const deadline = Date.now() + cellTimeoutMs;
    for (;;) {
      const raw = await readFile(resPath, "utf8").then(
        (t) => t,
        () => undefined,
      );
      if (raw !== undefined) {
        try {
          const parsed = JSON.parse(raw) as Partial<CellOutcome>;
          return {
            kind: "done",
            outcome: {
              ok: parsed.ok === true,
              stdout: typeof parsed.stdout === "string" ? parsed.stdout : "",
              stdoutTruncated: parsed.stdoutTruncated === true,
              stderr: typeof parsed.stderr === "string" ? parsed.stderr : "",
              stderrTruncated: parsed.stderrTruncated === true,
              error: typeof parsed.error === "string" ? parsed.error : null,
            },
          };
        } catch {
          // 损坏的 res（写者崩溃窗口）——按 crash 处理，诚实不重试。
          return { kind: "crashed" };
        }
      }
      if (k.exited) return { kind: "crashed" };
      if (Date.now() >= deadline) return { kind: "timeout" };
      await sleep(POLL_MS);
    }
  };

  const base = buildTool({
    name: "python_kernel",
    promptSnippet: "run Python in a persistent kernel — state survives between cells",
    promptGuidelines: [
      "Use it for multi-step computation instead of re-deriving the same state in shell one-liners.",
      "Re-decoding or reloading the same data repeatedly is the anti-pattern it exists to prevent.",
    ],
    description:
      "Run a Python cell in the session's PERSISTENT python3 kernel — imports, loaded data and variables stay alive across calls " +
      "(import torch / parse the big file ONCE, then iterate on the results; no re-import tax per probe). " +
      "Each call executes one cell and returns its stdout (capped), stderr and exceptions — an exception is caught and reported, the kernel keeps running; only a timeout or reset kills it. " +
      "STATE GUIDANCE (the whole point): store intermediate results in kernel VARIABLES (masks = ..., results[...] = ...), NOT by printing them — printed output is what enters the conversation and it is capped; printing big intermediates as storage is the anti-pattern this tool replaces. " +
      "No filesystem sandbox — shell-level trust (same as run_script's python lane). " +
      "The kernel is idle-reaped after 15 min (state lost; the next call cold-starts automatically and says so); reset:true restarts it explicitly. " +
      "Example: call 1 `import numpy as np; data = np.loadtxt('grid.txt')` → call 2 `print(np.median(data))`.",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "Python cell source. Variables and imports persist in the kernel between calls — keep intermediates in variables; print only distilled facts (stdout is capped).",
        },
        reset: { type: "boolean", description: "Restart the kernel (all state lost) before running this cell. A reset-only call needs no code." },
        description: { type: "string", description: "One line saying what this cell is for (shown in the result header)." },
      },
      additionalProperties: false,
    },
    // kernel 里的一段 cell 可写文件/开网络——永不只读（run_script 同款）。
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async execute({ code, reset, description }): Promise<ToolResult> {
      // 参数校验先于副作用（fail-closed）：code/reset 至少其一。
      if (code !== undefined && typeof code !== "string") {
        return { content: `python_kernel failed: "code" must be a string (got ${typeof code})`, isError: true };
      }
      if (reset !== undefined && typeof reset !== "boolean") {
        return { content: `python_kernel failed: "reset" must be a boolean (got ${typeof reset})`, isError: true };
      }
      if ((code === undefined || code === "") && reset !== true) {
        return { content: 'python_kernel failed: provide "code" (a Python cell) or "reset": true', isError: true };
      }
      if (busy) {
        return { content: "python_kernel failed: a cell is already running in this kernel (cells are strictly sequential)", isError: true };
      }
      busy = true;
      try {
        const header = `[python_kernel] ${typeof description === "string" && description !== "" ? description : "(no description)"}`;
        if (reset === true) {
          const k = kernel;
          if (k !== undefined) await killKernel(k).catch(() => {});
          pendingRestartReason = undefined;
          if (code === undefined || code === "") {
            // reset-only：不 spawn（懒 spawn 纪律——零动作零进程）。
            return { content: `${header}\nkernel: reset (state lost)\n[ok]` };
          }
        }
        const note = pendingRestartReason;
        pendingRestartReason = undefined;
        let kernelLine: string;
        if (kernel !== undefined) {
          kernelLine = "kernel: warm";
        } else {
          const boot = await bootKernel();
          if (!boot.ok) return boot.receipt;
          kernelLine = reset === true
            ? "kernel: reset (state lost)"
            : note !== undefined
              ? `kernel: restarted after ${note} (state lost)`
              : "kernel: cold start";
        }
        const k = kernel!;
        const r = await runCell(k, code!);
        let outcome: CellOutcome | undefined;
        let crashDiag = "";
        if (r.kind === "done") {
          outcome = r.outcome;
        } else if (r.kind === "timeout") {
          pendingRestartReason ??= "cell timeout";
          await killKernel(k).catch(() => {});
        } else {
          crashDiag = k.stderrTail.trim();
          pendingRestartReason ??= "crash";
          await killKernel(k).catch(() => {});
        }
        // 回执渲染：一切截断走 truncateSafe（代理对安全单一原语，113-A4）。
        // 空段过滤——无 stdout 的 cell 回执不留空行。
        const stdoutText = truncateSafe(outcome?.stdout ?? "", maxStdoutChars);
        const stdoutNote = outcome !== undefined && (outcome.stdoutTruncated || outcome.stdout.length > stdoutText.length)
          ? `[stdout truncated at ${maxStdoutChars} chars — print distilled facts; keep intermediates in kernel variables]`
          : "";
        const isError = outcome === undefined || !outcome.ok;
        const stderrText = truncateSafe(outcome?.stderr ?? "", MAX_STDERR_CHARS);
        const stderrNote = isError && outcome !== undefined && stderrText.trim() !== "" ? `[stderr]\n${stderrText.trim()}` : "";
        const errorText = outcome?.error != null ? truncateSafe(outcome.error, MAX_ERROR_CHARS) : "";
        const crashNote = outcome === undefined && r.kind === "crashed" && crashDiag !== ""
          ? `[kernel stderr]\n${truncateSafe(crashDiag, MAX_STDERR_CHARS)}`
          : "";
        const exitLabel = outcome === undefined
          ? (r.kind === "timeout"
            ? `[timeout after ${cellTimeoutMs / 1000}s — kernel killed, state lost]`
            : `[crashed — kernel died mid-cell, state lost]`)
          : outcome.ok
            ? "[ok]"
            : "[error]";
        const body = [stdoutText, stdoutNote, stderrNote, errorText, crashNote].filter((s) => s.trim() !== "").join("\n");
        return {
          content: body === "" ? `${header}\n${kernelLine}\n${exitLabel}` : `${header}\n${kernelLine}\n${body}\n${exitLabel}`,
          isError,
        };
      } finally {
        busy = false;
        armIdle();
      }
    },
  });

  return {
    ...base,
    /** Eager teardown（driver dispose / 嵌入方）：有界 kill 阶梯，幂等，
     *  无重启注记（有意收尾——之后的调用干净冷启）。 */
    stop: (): void => {
      pendingRestartReason = undefined;
      const k = kernel;
      if (k !== undefined) void killKernel(k).catch(() => {});
    },
  };
}
