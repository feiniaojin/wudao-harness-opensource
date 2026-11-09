// 夜移 006（2026-08-28 night porting，opencode permission/arity port，加强版）：
// `a`/`p` 批准一条 shell 时记录的 allowlist 规则。此前 wudao 记录裸
// `shell` —— 批准一条命令 = 放开本会话/项目所有命令。移植 opencode 的
// BashArity 前缀思路，收紧三处（opencode 均未做）：
//   1. 复合命令（引号外出现 ; | & < > ` $( 或换行）不记录规则 —— 管道的
//      第二段永远不会被第一段的前缀预先放行；
//   2. 破坏性命令头（rm/dd/kill…）退化为精确匹配，绝不记前缀；
//   3. 未知命令头记录精确命令 —— opencode 的 arity-1 缺省会把
//      `python a.py` 放大成 `python *`（任意脚本全放行）。
// 匹配侧（permission.ts ruleMatches 的 command lane）复用同一个
// commandHeadTokens，规则生成与匹配共享一套头部语义。
//
// 规则三档（严格程度从宽到窄，全部严格窄于旧的裸工具规则）：
//   `shell:ls`            —— 只读 arity-1 头：族级放行（无害）；
//   `shell:git checkout`  —— arity 表前缀：放行该子命令族；
//   `shell:<整条命令>`     —— 精确匹配：破坏性头或未知头。

/** 引号外出现即判定为复合命令的字符（含 `$(…)` 的 "$("）。 */
const COMPOUND_CHARS = new Set([";", "|", "&", "<", ">", "`", "\n"]);

/** 首 token 命中即退化为精确匹配的破坏性命令头。 */
const DESTRUCTIVE_HEADS = new Set([
  "rm", "rmdir", "dd", "mkfs", "shred", "truncate",
  "shutdown", "reboot", "halt", "poweroff",
  "kill", "pkill", "killall",
]);

/** 只读命令头：arity 1，族级放行无害。
 *  安全审计 2026-11 C6：`env` 已移除——`env CMD` 是 busybox 风格启动器，
 *  族级规则 shell:env 会前缀放行 env rm -rf / 这类任意命令；连裸 `env`
 *  的 1-token "exact" 规则也照样前缀匹配（匹配侧 token 前缀语义），
 *  所以 env 头一律不记族级规则（裸 env 不记规则，带参走整条精确），
 *  见 commandArityRule 的特判。 */
const READONLY_HEADS = new Set([
  "ls", "cat", "pwd", "echo", "which", "head", "tail", "wc", "stat", "file",
  "du", "df", "whoami", "date", "hostname", "uname", "ps",
  "grep", "sort", "uniq", "diff", "tree",
]);

/** 安全审计 2026-11 C6 — 族内扩权 flag：命令 token 命中即不得按族级前缀
 *  规则放行（记录侧退化为整条精确，匹配侧跳过前缀 lane 只留整条相等）。
 *  例：批准 `git push origin main` 记下的族规则 shell:git push 不应放行
 *  `git push --force` / `git push --delete`；批准 `git branch feat` 不应借
 *  族规则放行 `git branch -D main`。裸 `-f`/`-d`/`--amend` 故意不列
 *  （grep -f / docker compose up -d / git commit --amend 等高频无害用法
 *  误伤面大——残余风险见审计报告）。`--force` 取前缀匹配，覆盖
 *  --force-with-lease（仍是改写远端历史的强推）。 */
const ESCALATION_FLAG_EXACT = new Set(["--hard", "--privileged", "--delete", "--purge", "-D", "-ff"]);

export function hasEscalationFlagToken(token: string): boolean {
  if (token.startsWith("--force")) return true; // --force / --force-with-lease / --force-push
  return ESCALATION_FLAG_EXACT.has(token);
}

/** 命令头 token 里是否含扩权 flag（记录侧与匹配侧共用一个判定）。 */
export function headHasEscalationFlags(head: readonly string[]): boolean {
  return head.some((t) => hasEscalationFlagToken(t));
}

/** 安全审计 2026-11 C6 —— env 启动器形状：`env CMD …`（env 后跟真命令，
 *  非 flags/赋值）。任何 1-token 规则（shell:env）都是放行器，匹配侧
 *  对该形状跳过前缀 lane，只留整条相等。裸 `env`（仅打印环境）不算。 */
export function isEnvLauncherHead(head: readonly string[]): boolean {
  if (head[0] !== "env" || head.length < 2) return false;
  return head.slice(1).some((t) => !ENV_ASSIGN.test(t) && !t.startsWith("-"));
}

/** 子命令族 arity 表（最长前缀优先）。值 = 规则取的 token 数。 */
const ARITY: Readonly<Record<string, number>> = {
  // 常见包管理 / 构建 / VCS 族：两段（工具 + 子命令）。
  git: 2, docker: 2, npm: 2, pnpm: 2, yarn: 2, bun: 2, cargo: 2, go: 2,
  kubectl: 2, helm: 2, gh: 2, brew: 2, pip: 2, pip3: 2, uv: 2, poetry: 2,
  composer: 2, deno: 2, dotnet: 2, firebase: 2, flutter: 2, rustup: 2,
  terraform: 2, vagrant: 2, systemctl: 2,
  // 三段：嵌套子命令 / 云 CLI 的 service.operation 粒度。
  "npm run": 3, "pnpm run": 3, "bun run": 3, "cargo run": 3, "deno task": 3,
  "docker compose": 3, aws: 3, gcloud: 3, az: 3,
};

/** 前导环境变量赋值 token（`FOO=1`）—— 环境不是命令头。 */
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * 命令头 token 化（共享给规则生成与 ruleMatches）：引号感知扫描，引号外
 * 的 shell 操作符（; | & < > ` $( 换行）判复合 → null；空输入 → null；
 * 否则按空白切分并剥掉前导 VAR= 赋值。返回的 token 保持原样（含引号）
 * —— 匹配两边走同一函数，形状一致即一致。
 */
export function commandHeadTokens(command: string): string[] | null {
  const s = command.trim();
  if (s === "") return null;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (quote !== null) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (COMPOUND_CHARS.has(c)) return null;
    if (c === "$" && s[i + 1] === "(") return null;
  }
  // 引号未闭合：视为不可解析（保守，不给规则）。
  if (quote !== null) return null;
  const tokens = s.split(/\s+/).filter((t) => t !== "");
  let first = 0;
  while (first < tokens.length && ENV_ASSIGN.test(tokens[first] as string)) first += 1;
  const head = tokens.slice(first);
  return head.length === 0 ? null : head;
}

/**
 * `a`/`p` 批准 shell 时记录的规则（含工具名前缀），null = 不记录
 * （复合命令 / 空命令：本次放行，不留规则）。见文件头的三档设计。
 */
export function commandArityRule(command: string): string | null {
  const head = commandHeadTokens(command);
  if (head === null) return null;
  const first = head[0] as string;
  // 破坏性头 / 未知头：精确匹配（破坏性保留原始形式含 env 前缀 —— 规则
  // 文本即用户批准时看到的命令；匹配侧两边都剥 env，语义一致）。
  const exact = (): string => command.trim().split(/\s+/).join(" ");
  if (DESTRUCTIVE_HEADS.has(first)) return exact();
  // 安全审计 2026-11 C6 —— `env` 启动器特判：`env CMD` 执行任意 CMD。
  // 裸 `env`（或 `env`+flags 打印环境）：任何规则文本都是 1-token 前缀
  // （匹配侧语义），会放行 `env rm -rf /` —— 不记规则（本次放行，逐次问）。
  if (first === "env" && !head.slice(1).some((t) => !ENV_ASSIGN.test(t) && !t.startsWith("-"))) return null;
  // 安全审计 2026-11 C6 —— 扩权 flag：族级规则只放行"同族温和形态"，
  // 带 --force/-D/--hard/--privileged… 的命令退化为整条精确（用户批准
  // 该形态本身；另一个危险变体重新问）。
  if (headHasEscalationFlags(head)) return exact();
  if (READONLY_HEADS.has(first)) return first;
  // arity 表：最长前缀优先（"npm run" 先于 "npm"）。
  const max = Math.min(head.length, 3);
  for (let len = max; len >= 1; len -= 1) {
    const key = head.slice(0, len).join(" ");
    const arity = ARITY[key];
    if (arity !== undefined) return head.slice(0, Math.min(arity, head.length)).join(" ");
  }
  return exact(); // 未知头：精确命令，绝不放大
}
