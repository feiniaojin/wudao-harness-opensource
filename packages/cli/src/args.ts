// ω99-130: the `wudao --help` usage text lives in this module so index.ts's
// short-circuit imports it next to the parser; the version rides the
// version.ts import (never a hardcoded string) so the text stays current.
import { VERSION } from "./version.js";

// End-of-options `--` (the upstream projectprecedent): the FIRST bare `--` in argv ends flag
// parsing — every token after it is a positional (prompt word), even
// flag-looking ones; the `--` itself belongs to neither side. A second and
// later `--` are ORDINARY positionals. Without a bare `--` the split is the
// identity, so argv without a `--` parses byte-identically to before.
export interface EndOfOptionsSplit {
  /** tokens before the first bare `--` — the only place flags are recognized */
  flagWindow: string[];
  /** tokens after it — positionals (later `--` tokens included as words) */
  positionals: string[];
}

export function splitEndOfOptions(argv: readonly string[]): EndOfOptionsSplit {
  const i = argv.indexOf("--");
  if (i === -1) return { flagWindow: argv.slice(), positionals: [] };
  return { flagWindow: argv.slice(0, i), positionals: argv.slice(i + 1) };
}

// End-of-options follow-up: a subcommand must not silently lose the post-`--`
// window. main() normalizes process.argv to the flag window (so every flag
// consumer sees flags only), which meant a dispatch that consumes argv as
// DATA — its subcommand word, file paths, the search query — only ever saw
// the window: `wudao sessions search foo -- --bar` searched "foo" with
// `--bar` silently gone (searching session transcripts that quote bash
// commands hits a bare `--` often enough to matter). This is the
// dispatch-side composition: the window slice with the positionals appended
// VERBATIM — exactly what promptFromArgv builds for the one-shot prompt.
// The subcommand's own parser then decides what the tokens mean. Scope:
// only the data-consuming dispatches (workflow/plugin/sessions search/meta)
// thread this; flag-only dispatches (perms/statusline/ui/slack/purge) keep
// reading the window — post-`--` tokens are never flags by the top-level
// contract, and those branches take no positional data, so inertness there
// is the contract, not a truncation. Without a bare `--` this is exactly
// rawArgv.slice(from) — zero drift.
export function subcommandArgv(rawArgv: readonly string[], from: number): string[] {
  const { flagWindow, positionals } = splitEndOfOptions(rawArgv);
  return [...flagWindow.slice(from), ...positionals];
}

// Session-flag parsing (pure, testable). Symmetric with stripLogFlags in
// log.ts: both accept `--resume <v>`, `--resume=<v>`, and the single-dash
// `-resume` quirk form, plus `--continue` / `--list-sessions` booleans.
// A `--resume` whose following token is missing or flag-looking (`-`-prefixed)
// yields no resumeId — the next token belongs to another flag, not to us.

export interface SessionFlags {
  resumeId?: string;
  cont: boolean;
  list: boolean;
}

export function parseSessionFlags(argv: readonly string[]): SessionFlags {
  let resumeId: string | undefined;
  let cont = false;
  let list = false;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--continue") { cont = true; continue; }
    if (a === "--list-sessions") { list = true; continue; }
    if (a === "--resume" || a === "-resume") {
      const next = argv[i + 1];
      if (next !== undefined && next !== "" && !next.startsWith("-")) resumeId = next;
      continue;
    }
    if (a.startsWith("--resume=")) { resumeId = a.slice("--resume=".length) || undefined; continue; }
    if (a.startsWith("-resume=")) { resumeId = a.slice("-resume=".length) || undefined; continue; }
  }

  return { resumeId, cont, list };
}

// Sandbox resolution (M21): `--sandbox` argv flag or WUDAO_SANDBOX=1 enable
// containerized shell; WUDAO_SANDBOX_IMAGE overrides the default image
// (node:22-alpine, applied in core). Anything but "1" in the env var means
// off — no fuzzy "yes"/"true" acceptance.
export interface SandboxFlags {
  enabled: boolean;
  image?: string;
}

export function parseSandboxFlags(argv: readonly string[], env: NodeJS.ProcessEnv): SandboxFlags {
  const enabled = argv.includes("--sandbox") || env.WUDAO_SANDBOX === "1";
  if (!enabled) return { enabled: false };
  const image = env.WUDAO_SANDBOX_IMAGE?.trim();
  return image ? { enabled: true, image } : { enabled: true };
}

// M37 §1: `--plan` runs the one-shot prompt as a plan run (read-only
// whitelist, board as the plan) and — on a TTY — offers the ok-to-execute
// flow. Boolean flag, same parsing style as --sandbox.
export function parsePlanFlag(argv: readonly string[]): boolean {
  return argv.includes("--plan") || argv.includes("-plan");
}

// M58 §C#5: `--fork-session` pairs with `--resume <id>` — the session JSONL
// is copied to a fresh id and the run resumes the fork (the original file is
// never touched). Boolean flag, same parsing style as --plan.
export function parseForkSessionFlag(argv: readonly string[]): boolean {
  return argv.includes("--fork-session") || argv.includes("-fork-session");
}

// M58 §C#7: `--all` lifts the /resume + --list-sessions worktree filter (a
// process started inside a git worktree otherwise lists only sessions whose
// recorded workspaceRoot matches that worktree). Kept OUTSIDE parseSessionFlags
// on purpose: the flags object is shape-pinned by tests and --all belongs to
// the list filter, not the resume resolver. Review fix: the scan is a LEADING
// FLAG WINDOW, exactly like parseAblationFlags — it stops at the first prompt
// word and steps over value-taking flags, so a one-shot PROMPT containing the
// bare word "--all" (e.g. `wudao explain --all flags`) never lifts the filter.
// `argv` is the args AFTER the executable prefix (process.argv.slice(2)).
export function parseAllFlag(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) continue;
    if (!a.startsWith("-")) break; // first prompt word ends the flag window
    if (VALUE_FLAGS.has(a)) i += 1; // its value is not a prompt word either
    if (a === "--all" || a === "-all") return true;
  }
  return false;
}

// Provider-flag parsing (pure, testable). Same conventions as
// parseSessionFlags: `--provider <v>` / `--provider=<v>` / single-dash
// variants, and likewise for `--reasoning-effort`. A value token that is
// missing or flag-looking is not consumed. Values are validated downstream in
// @wudao/providers resolveProviderConfig (throws on junk).
export interface ProviderFlags {
  provider?: string;
  reasoningEffort?: string;
  /** R3-T002 深测弧：--model 显式模型（最高优先，越过 env 钉）。 */
  model?: string;
}

export function parseProviderFlags(argv: readonly string[]): ProviderFlags {
  let provider: string | undefined;
  let reasoningEffort: string | undefined;
  let model: string | undefined;

  // R3-T002 深测弧：--model 与 --provider 同形（空格/等号两式，负号前缀
  // 双形）。显式旗标最高优——越过 env 钉（.env 的 WUDAO_MODEL）与 profile
  // 缺省，让「换 provider 不换模型」的错配可控、可修。
  const valueForms = [
    { flag: "--provider", eq: "--provider=", set: (v: string) => { provider = v; } },
    { flag: "-provider", eq: "-provider=", set: (v: string) => { provider = v; } },
    { flag: "--reasoning-effort", eq: "--reasoning-effort=", set: (v: string) => { reasoningEffort = v; } },
    { flag: "-reasoning-effort", eq: "-reasoning-effort=", set: (v: string) => { reasoningEffort = v; } },
    { flag: "--model", eq: "--model=", set: (v: string) => { model = v; } },
    { flag: "-model", eq: "-model=", set: (v: string) => { model = v; } },
  ];

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) continue;
    for (const f of valueForms) {
      if (a === f.flag) {
        const next = argv[i + 1];
        if (next !== undefined && next !== "" && !next.startsWith("-")) f.set(next);
        continue;
      }
      if (a.startsWith(f.eq)) {
        const v = a.slice(f.eq.length);
        if (v !== "") f.set(v);
      }
    }
  }

  return { provider, reasoningEffort, ...(model !== undefined ? { model } : {}) };
}

// M36: `--plugin <path>` mounts the upstream harness plugin dirs for this run
// (repeatable). Same conventions as the other value flags: `--plugin <v>` /
// `--plugin=<v>` / single-dash variants; a missing or flag-looking value is
// not consumed. Paths resolve against the workspace root in loadPlugins.
export function parsePluginFlags(argv: readonly string[]): string[] {
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--plugin" || a === "-plugin") {
      const next = argv[i + 1];
      if (next !== undefined && next !== "" && !next.startsWith("-")) paths.push(next);
      continue;
    }
    if (a.startsWith("--plugin=") || a.startsWith("-plugin=")) {
      const v = a.slice(a.indexOf("=") + 1);
      if (v !== "") paths.push(v);
    }
  }
  return paths;
}

// P1-5 (96 队列): `--trust-workspace` — the headless escape hatch for the
// workspace trust gate. Equivalent to `/trust accept` for THIS RUN only (a
// one-shot: it never writes ~/.wudao/trust.json), so scripted/CI runs on a
// fresh clone can load the project skills/plugins/allow/hooks without an
// interactive step. Boolean flag, same parsing style as --plan.
export function parseTrustWorkspaceFlag(argv: readonly string[]): boolean {
  return argv.includes("--trust-workspace") || argv.includes("-trust-workspace");
}

// M64-A §A: `--name <v>` names this session for peer messaging (the registry
// / list_agents / send_message face; /rename re-names it mid-session). Same
// conventions as --plugin: two-token and `=` forms, single-dash tolerated, a
// missing/flag-looking value not consumed. Kept OUT of parseSessionFlags on
// purpose — the flags object is shape-pinned by tests.
export function parseSessionNameFlag(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--name" || a === "-name") {
      const next = argv[i + 1];
      if (next !== undefined && next !== "" && !next.startsWith("-")) return next;
      continue;
    }
    if (a.startsWith("--name=") || a.startsWith("-name=")) {
      const v = a.slice(a.indexOf("=") + 1);
      if (v !== "") return v;
    }
  }
  return undefined;
}

// M79 §5: `--image <path>` attaches image files to the one-shot prompt
// (repeatable, newest = flag order). Same conventions as --plugin: the
// two-token and `=` forms, single-dash tolerated, a missing/flag-looking
// value not consumed. Files are read + admitted through the workspace
// AttachmentStore in runReal (before the run starts); the resulting
// ImageBlocks ride the first user turn as durable refs.
export function parseImageFlags(argv: readonly string[]): string[] {
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--image" || a === "-image") {
      const next = argv[i + 1];
      if (next !== undefined && next !== "" && !next.startsWith("-")) paths.push(next);
      continue;
    }
    if (a.startsWith("--image=") || a.startsWith("-image=")) {
      const v = a.slice(a.indexOf("=") + 1);
      if (v !== "") paths.push(v);
    }
  }
  return paths;
}

// M53 §5 — the ablation flag matrix: `--no-<feature>` fully disables one
// feature for the run (evals use them for ablation comparisons; production
// never sets them). Parsing is pure; the flags are bridged into
// WUDAO_NO_<FEATURE> env entries once per process (applyAblationFlagsToEnv)
// so every consumer — including deep seams like the driver's steering queue
// or the read_file elision probe — checks isFeatureAblated(feature) without
// prop threading. The CLI-only env bridge keeps core settings-free.
export const ABLATION_FEATURES = [
  "sidecar",
  "verify",
  "diagnostics",
  "language",
  "review-fork",
  "steering",
  "gates",
  "loop-safety",
  "loop-reflection",
  "elision",
  "login-shell",
  // ω-5a I23: the cold-cache pre-send ❄️ notice.
  "cold-cache-warning",
  // P0-1 (the upstream projectcache-stats port): the per-turn prefix-cache waste attribution
  // notice (idle TTL / model switch; per-cause deduped).
  "cache-waste-notice",
  // design 70 Phase 2: the ask-tier LLM reviewer (`WUDAO_ASK_REVIEWER=1`
  // opt-in; this is the full-disable kill switch — `--no-ask-reviewer` /
  // WUDAO_NO_ASK_REVIEWER). The module's own env read already honors the
  // same name, so flag and env compose without prop threading.
  "ask-reviewer",
] as const;

export type AblationFeature = (typeof ABLATION_FEATURES)[number];

export type AblationFlags = Readonly<Record<AblationFeature, boolean>>;

/** Value-taking flags whose FOLLOWING token is a value, not a prompt word —
 *  the ablation scan steps over them so `--resume <id> --no-gates <prompt>`
 *  still parses the ablation. (`=`-forms are single tokens and need no
 *  special casing.) M58-D review fix: --log-level is value-taking — without
 *  it here, `--log-level debug --all <prompt>` truncates the leading-flag
 *  window at "debug" and the --all never parses. */
const VALUE_FLAGS = new Set(["--resume", "-resume", "--provider", "-provider", "--reasoning-effort", "-reasoning-effort", "--model", "-model", "--plugin", "-plugin", "--image", "-image", "--log-level", "--name", "-name"]);

/** Parse `--no-<feature>` / `-no-<feature>` for every known feature. Unknown
 *  --no- flags are NOT errors (they may belong to other tooling); the
 *  returned record is complete — every feature gets an explicit boolean
 *  (true = disabled), so absence is byte-equivalent to the default run.
 *
 *  M53 review fix — argv scoping: `argv` is the args AFTER the executable
 *  prefix (index.ts passes `process.argv.slice(2)`), and a `--no-X` only
 *  counts while it precedes every non-flag token: the scan stops at the
 *  first prompt word, so `wudao fix --no-gates the bug` is a PROMPT, never
 *  an ablation. Value-taking flags step over their value token so leading
 *  flags compose (`--resume <id> --no-gates <prompt>`). */
export function parseAblationFlags(argv: readonly string[]): AblationFlags {
  const disabled = new Set<AblationFeature>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) continue;
    if (!a.startsWith("-")) break; // first prompt word ends the flag window
    if (VALUE_FLAGS.has(a)) i += 1; // its value is not a prompt word either
    const m = /^-{1,2}no[-_](.+)$/.exec(a); // --no-X and --no_X both parse
    if (m === null) continue;
    const name = (m[1] ?? "").replace(/_/g, "-");
    for (const f of ABLATION_FEATURES) {
      if (f === name) disabled.add(f);
    }
  }
  const out = {} as Record<AblationFeature, boolean>;
  for (const f of ABLATION_FEATURES) out[f] = disabled.has(f);
  return out;
}

/** The env var name for one feature (dashes → underscores, upper-cased). */
export function ablationEnvVar(feature: AblationFeature): string {
  return `WUDAO_NO_${feature.replace(/-/g, "_").toUpperCase()}`;
}

/** Bridge parsed flags into the process env (idempotent; never unsets). */
export function applyAblationFlagsToEnv(
  flags: AblationFlags,
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const f of ABLATION_FEATURES) {
    if (flags[f]) env[ablationEnvVar(f)] = "1";
  }
}

/** True when the feature is ablated for this process (flag-bridged env). */
export function isFeatureAblated(feature: AblationFeature, env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ablationEnvVar(feature)] === "1";
}

// ω99-130: the two print-and-exit flags, `-h/--help` and `-V/--version`.
// Dogfood bug being fixed: `wudao --help` used to send the literal word
// "--help" to the model as a one-shot prompt (one wasted call answering the
// wrong question). The scan is a LEADING FLAG WINDOW in the parseAblationFlags
// style: it stops at the first prompt word (`wudao fix the --help flag` is a
// prompt — the design pin: a --help INSIDE the prompt is a prompt word), and
// therefore also at a subcommand word (`wudao plugin --help` keeps the
// plugin subcommand's own --help). Value-taking flags step over their value
// so leading flags compose (`wudao --provider deepseek --help` is help), and
// the window itself ends at the first bare `--` (splitEndOfOptions), so
// `wudao -- --help` sends "--help" as the prompt, semantics unchanged. Only
// the four spellings -h/--help/-V/--version parse — the repo's single-dash
// long-form quirk (-resume, -plan) is deliberately NOT extended: the short
// forms already exist, and every added spelling is one more way to collide
// with a user's prompt words. First hit wins when both flags appear.
export type HelpVersionFlag = "help" | "version";

export function parseHelpVersionFlags(argv: readonly string[]): HelpVersionFlag | undefined {
  const { flagWindow } = splitEndOfOptions(argv);
  for (let i = 0; i < flagWindow.length; i += 1) {
    const a = flagWindow[i];
    if (a === undefined) continue;
    if (!a.startsWith("-")) break; // first prompt word ends the flag window
    if (VALUE_FLAGS.has(a)) i += 1; // its value is not a prompt word either
    if (a === "-h" || a === "--help") return "help";
    if (a === "-V" || a === "--version") return "version";
  }
  return undefined;
}

// ω99-130: the `wudao --help` text. Honest inventory discipline: every entry
// below is a real dispatch (index.ts argv[2] routing) or a real parsed flag
// in this file — no aspirational lines, no internal jargon; phrasing is
// user-benefit Chinese, one usage example per line, every line ≤100 chars.
// (Kept as one template literal: greppable, diffable, byte-stable.)
export const CLI_USAGE_TEXT = `wudao-harness v${VERSION} —— 终端里的 AI 干活助手

最常用（每行一个例子）：
  wudao "任务描述"              一句话开工：改代码、写文档、查问题
  wudao                         不带参数，进入持续对话
  wudao ui                      打开网页界面（首次配置向导也在这里）
  wudao workflow run 流程.js     按固定脚本跑任务，断了可续跑
  wudao sessions search 关键词   搜索过往会话，找回聊过的内容
  wudao plugin list             查看与管理插件
  wudao purge                    清理本目录的运行数据（先预览再确认）
  wudao perms lint              权限规则体检，揪出永不生效的条目

接续会话：
  --resume <会话id>              从指定会话继续；--continue 接最近一次
  --resume <id> --fork-session   在旧会话的副本上继续，原会话保持原样
  --list-sessions               列出可恢复的会话（加 --all 看全部）

权限档位（默认：当前工作区内可直接读写）：
  --plan                        只调研、出方案，不动任何文件
  --ask                         每次改动前都先问你
  --auto                        全自动放行（请慎用）

模型与输入：
  --provider deepseek           这次运行换一家模型服务
  --model glm-5.3               指定这次运行用哪个模型（越过环境变量与 .env 钉的值）
  --reasoning-effort high       调思考深度：省时间或攻坚
  --image 图片路径              给任务附图（可重复多次）
  --name 会话名                 给本次会话起名，方便辨认

更多：
  -h, --help                    显示本说明
  -V, --version                 显示版本号
  --sandbox                     命令在容器里执行，更安全（需 Docker）
  --trust-workspace             信任当前目录，脚本/CI 免交互
  --plugin 插件目录             本次运行临时挂载一个插件目录
  --no-tui                      用逐行输入代替全屏界面（管道/慢终端）
  --debug / --quiet             调日志详略
  --no-verify 等                临时关掉某项内置检查（评估对比用）
  --                            之后的词全部当任务内容，不当旗标

无 key 试用：pnpm demo
`;
