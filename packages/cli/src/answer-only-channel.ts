// `--answer-only` 的诊断分流（2026-11-06 Terminal-Bench 取证）。
//
// 这个开关的契约写在它自己的注释里：「抑制流式/元数据，仅输出终答
// （无空行包裹，供脚本/benchmark 消费）」。但实测 stdout 里还有
// `模型：…` / `session: …` / 耗时收据 / 缓存行 / 净变更回执 / 探针审计提示
// ——它们是 `ge("info")` 门控的，不受 `answerOnly` 管。于是「机器可读的输出
// 模式」并不可读：下游 `wudao --answer-only …  | jq` 之类拿到的第一行是
// 「模型：」。
//
// 正确的做法不是把这些诊断删掉——benchmark 恰恰靠它们定位问题——而是**换
// 通道**：answer-only 下 stdout 只留终答，诊断一律走 stderr。两者的分离
// 是 Unix 的既有约定，`wudao_stdout.txt` 与 `wudao_stderr.txt` 也各自落盘。
//
// 非 answer-only 时行为完全不变（诊断仍走 stdout）。
import { stdoutGuard } from "./output-guard.js";

/** 诊断行：answer-only 走 stderr，否则走 stdout（锁在守卫泳道上）。 */
export function diagLine(text: string, answerOnly: boolean): void {
  if (answerOnly) process.stderr.write(text);
  else stdoutGuard.writeRawStdout(text);
}
