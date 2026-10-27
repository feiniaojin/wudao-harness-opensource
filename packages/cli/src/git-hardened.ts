// 129 弧（goose 3fbea00d / GHSA-6mg9-3cvh-9939 引进）——harness git 调用对
// 不可信仓库配置的硬化。
//
// 威胁：harness 对工作区/市场仓跑 git（status/clone/diff/checkout）。这些仓的
// repo 级配置（.git/config）不受我们控制——`core.fsmonitor` 指向任意命令（每
// 次 `git status` 执行）、`diff.external` 指定外部 diff 驱动（每次 `git diff`
// 执行）。恶意工作区/三方市场仓 = 经 harness 自身 git 调用的代码执行。
//
// 修法：一切 harness 发起的 git 调用注入 `-c` 覆写，把这两个 config 钥匙钉
// 回安全值（命令行 -c 优先级高于 repo config——git 语义保证）。五个调用点
// （marketplace/git-status-note/git-branch/restack/session-list）统一消费本
// 前缀；测试用 marker-file 夹具（配了恶意 fsmonitor 的 fixture 仓 → 硬化后
// status 仍收集、marker 永不出现）。
//
// 边界（诚实）：gitattributes 的 filter driver 与 hook 不在本前缀范围——它们
// 需要不同的治理面（clone 侧 fsck/hook 禁用），记池待需求实证。

/** 硬化前缀：置于子命令之前（`git -c k=v <subcmd>`）。 */
export const HARDENED_GIT_PREFIX: readonly string[] = [
  "-c", "core.fsmonitor=false", // repo 配置的 fsmonitor 命令不在 status 里执行
  "-c", "diff.external=", // 外部 diff 驱动清空（git 语义：空值=未设）
];

/** 给一段 git 参数装上硬化前缀（纯函数；调用点 `execFileAsync("git", hardenedGitArgs([...]))`）。 */
export function hardenedGitArgs(args: readonly string[]): string[] {
  return [...HARDENED_GIT_PREFIX, ...args];
}
