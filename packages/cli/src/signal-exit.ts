// 一次性 CLI 的 SIGTERM 出口（2026-11-06 Terminal-Bench 取证）。
//
// 这个 CLI 原本只注册 SIGINT。外层调度器——benchmark 的 adapter、systemd、
// `docker stop`、k8s——一律先发 SIGTERM，而 SIGTERM 的**默认处置是直接
// 终止进程**，连 `process.once("exit")` 钩子都不跑。后果实测为：
//   · stdout 里已写好的答案留在 Node 的背压队列里，随进程一起消失
//     （Terminal-Bench 里表现为 wudao_stdout.txt 是 0 字节）；
//   · MCP / LSP / PTY 三类子资源无人回收，留下孤儿进程；
//   · token 用量与 session 落盘没机会提交。
// 而任务本身往往是**已经做完的**——只是进程没走到正常出口。
//
// 这里把 SIGTERM 变成一个正常出口：先跑同一套 best-effort 清理，再排干
// stdout 守卫的泳道（守卫保证队列落地），最后 exit(0)。
//
// 顺序是故意的：清理放前面，flush + exit 紧邻放最后——output-guard-wiring
// 的棘轮要求「dispatch 区每个 process.exit 前必须紧跟 flushRawStdout();」，
// 而 flush 之后不该再有副作用，否则排干就失去意义。
import { stdoutGuard } from "./output-guard.js";

export interface SigtermHooks {
  /** 进程退出前的一轮 best-effort 清理（MCP / LSP / PTY）。 */
  readonly cleanup: () => void;
  /** 退出码；默认 0（SIGTERM 是被请求的退出，不是失败）。 */
  readonly exitCode?: number;
}

/** 只注册一次；重复调用是 no-op（第二次的 hooks 被忽略）。 */
let installed = false;

export function installSigtermExit(hooks: SigtermHooks): void {
  if (installed) return;
  installed = true;
  let draining = false;
  process.once("SIGTERM", () => {
    if (draining) return;
    draining = true;
    void (async () => {
      try {
        hooks.cleanup();
      } catch {
        /* cleanup is best-effort by contract — never block the drain */
      }
      await stdoutGuard.flushRawStdout(); // the wiring ratchet pins this exact call shape
      process.exit(hooks.exitCode ?? 0);
    })();
  });
}
