// M42 §2 — listSlashCommands: the single source of slash-command truth for
// the suggestion menu, /help, and the REPL's Tab completer. Aggregates the
// builtin commands, the loaded skills (as /skill:<name>), plugin commands,
// and extension commands — deduped by name with the parse priority
// (builtin > skill > plugin > extension: a colliding loader entry is dropped,
// defense in depth for the loaders' own refusal rules).
// M53 §4: every entry carries the unified command metadata —
// `{name, description, isSensitive?, immediate?, sources}`. `isSensitive`
// marks commands whose ARGUMENTS must not be echoed (the suggestion menu
// previews them as `<redacted>`); `immediate` marks commands that bypass the
// steering queue (they execute directly even while a run is in flight —
// read-only, model-independent commands only).
import type { LoadedSkill } from "./skills.js";
import type { PluginCommand } from "./plugins.js";

export type SlashSource = "builtin" | "skill" | "plugin" | "extension";

export interface SlashCommandInfo {
  /** The completable token (no leading slash): "help", "skill:alpha", "deploy". */
  readonly name: string;
  /** One-line description (menu dim text / help body). */
  readonly description: string;
  /** Display-only usage suffix: "/plan <goal>" (completion inserts the name). */
  readonly args?: string;
  /** M53 §4: the command's arguments are sensitive — autocomplete and help
   *  previews render `<redacted>` instead of the args template. */
  readonly isSensitive?: boolean;
  /** M53 §4: executes immediately even while a run is in flight (bypasses
   *  the steering queue) — read-only, model-independent commands only. */
  readonly immediate?: boolean;
  /** The primary source (parse priority winner). */
  readonly source: SlashSource;
  /** M53 §4: every source that defines this name (collisions included). */
  readonly sources: readonly SlashSource[];
}

/** The builtin commands (canonical names only — /quit and /? are accepted
 *  aliases of /exit and /help in parseReplCommand and stay off the menu). */
const BUILTIN_COMMANDS: readonly SlashCommandInfo[] = [
  { name: "exit", description: "退出", source: "builtin", sources: ["builtin"] },
  // ω99-159: /clear 菜单描述中文化（与确认框同族；其余命令描述刻意不动）。
  // ω99-162: 内置命令描述整单中文化（A 族 42 条逐字钉值；clear=159、language 原生中文不动；
  // args 列与 isSensitive 的 <redacted> 预览本弧原样；子命令 token 与标识符原样保留）。
  { name: "clear", description: "清空历史（开启全新会话）", source: "builtin", sources: ["builtin"] },
  { name: "help", description: "显示这份帮助", source: "builtin", sources: ["builtin"] },
  { name: "resume", description: "选载最近 10 个会话之一", source: "builtin", sources: ["builtin"] },
  { name: "plan", description: "先只读规划，回 ok 才执行 · 改 <意见> 可修订", args: "<goal>", source: "builtin", sources: ["builtin"] },
  { name: "rewind", description: "列出/撤销文件改动；turn [n] 回退对话轮", args: "[n|last|turn [n]]", source: "builtin", sources: ["builtin"] },
  // M49 §1: the memory store command. M53 §4: sensitive — its args can quote
  // stored memory content, so autocomplete previews stay <redacted>.
  // M55 §A: + the `edit` verb (context files in $EDITOR).
  { name: "memory", description: "记忆库：list / del <id> / ok <id> / edit（上下文文件在 $EDITOR 打开）", args: "[list|del <id>|ok <id>|edit]", isSensitive: true, source: "builtin", sources: ["builtin"] },
  // ω99-3a: /refine — the Continual Harness session refiner. Sensitive like
  // /memory: its args can quote stored content, and the proposal evidence
  // quotes trajectory text.
  { name: "refine", description: "把本会话提炼成记忆更新（Continual Harness）", args: "[instructions]|rollback <refineId>", isSensitive: true, source: "builtin", sources: ["builtin"] },
  { name: "search", description: "搜索过往会话（对中文友好）", args: "<query>", source: "builtin", sources: ["builtin"] },
  // 夜移 014: the cache-shared side question — rides the session's prefix
  // cache, works mid-run, the answer never enters the main history.
  { name: "btw", description: "运行中随口旁问（不打断；答案以通知显示）", args: "<question>", source: "builtin", sources: ["builtin"] },
  { name: "compact", description: "立即压缩上下文（生成摘要，记为手动原因）", source: "builtin", sources: ["builtin"] },
  // M53 §4: immediate — read-only occupancy/tree reports never touch the
  // model or the in-flight run, so they bypass the steering queue.
  { name: "context", description: "查看 token 占用（按类别/服务器/prompt 段）", immediate: true, source: "builtin", sources: ["builtin"] },
  // PB-2（探针基础设施弧）— /probe：探针遥测直读查询（最近事件表/统计面；
  // 零模型调用，/context 同款即时面）。
  { name: "probe", description: "探针遥测：最近事件表 / 统计面（模型·工具·界面·系统·agent）", args: "[model|tool|ui|system|agent|*] [N] | stats", immediate: true, source: "builtin", sources: ["builtin"] },
  { name: "edit", description: "把近期某条消息放回输入框——重发即开新分支", args: "[<n>]", source: "builtin", sources: ["builtin"] },
  { name: "tree", description: "查看会话分支树（主干、分叉、活跃链）", immediate: true, source: "builtin", sources: ["builtin"] },
  { name: "switch", description: "列出分支 / 切换活跃链", args: "[<n>]", source: "builtin", sources: ["builtin"] },
  // M55 §A: the command-parity pack (high-frequency commands).
  { name: "init", description: "扫描代码库生成 AGENTS.md（写前预览+确认）", source: "builtin", sources: ["builtin"] },
  { name: "status", description: "会话一页速览：版本/模型/模式/上下文/界面（离线）", source: "builtin", sources: ["builtin"] },
  { name: "cost", description: "本会话用量统计；/cost all 看跨会话台账+余额", source: "builtin", sources: ["builtin"] },
  { name: "rename", description: "重命名当前会话（供 /resume 与 /search 显示）", args: "<name>", source: "builtin", sources: ["builtin"] },
  { name: "diff", description: "未提交的 git 改动 + 本会话文件流水", source: "builtin", sources: ["builtin"] },
  { name: "config", description: "查看生效配置（settings.json+环境变量+启动参数）；set local <k> <v> 写本地层", args: "[set local <key> <value>]", source: "builtin", sources: ["builtin"] },
  // M55 §B: the medium-command pack.
  { name: "model", description: "列出可切模型 / 会话中切换（下一轮生效，记 model_change）", args: "[name|number]", source: "builtin", sources: ["builtin"] },
  { name: "effort", description: "列出/切换推理力度（low|medium|high|max|none）", args: "[level|number]", source: "builtin", sources: ["builtin"] },
  // 推理档三级配置 + 语言 chip S4: the session language lane (双旋钮 —
  // 回复语言 / 思考语言; bare = status; 会话级覆盖, settings/env 是启动档).
  { name: "language", description: "看/切语言双旋钮: 回复 auto|on|off / 思考 auto|zh|en|off（会话级，下一轮生效）", args: "[reply|reasoning <mode>]", source: "builtin", sources: ["builtin"] },
  // M63 §A: the provider switch — endpoint change, client rebuilt at the
  // turn boundary, provider_change entry, full-cache cold receipt.
  { name: "provider", description: "列出服务提供方（状态点）/ 会话中切换（轮界生效，记 provider_change，缓存全冷）", args: "[name]", source: "builtin", sources: ["builtin"] },
  // 2026-08-23 persona 层：客户端指纹角色扮演（次轮生效、无 client 重建）。
  { name: "persona", description: "列出角色 / 切换客户端指纹（headers/body/prompt 三层，下次调用生效，记 persona_change）", args: "[<id> [--headers-only|--with-prompt]|--off]", source: "builtin", sources: ["builtin"] },
  { name: "permissions", description: "查看/新增/移除权限规则（即时生效）", args: "[add|remove <allow|deny|ask> <rule>]", source: "builtin", sources: ["builtin"] },
  { name: "export", description: "导出会话为 markdown（默认）或独立 HTML——传 html 或 *.html 路径", args: "[file]", source: "builtin", sources: ["builtin"] },
  { name: "review", description: "评审未提交的 git 改动（模板提示词，模型驱动）", args: "[focus]", source: "builtin", sources: ["builtin"] },
  { name: "security-review", description: "对未提交改动做安全评审（清单模板）", args: "[focus]", source: "builtin", sources: ["builtin"] },
  { name: "mcp", description: "MCP 服务器状态与 OAuth：/mcp [auth|unauth <server>]", source: "builtin", sources: ["builtin"] },
  { name: "agents", description: "列出 agent 名册（内置/插件/工作区，含置顶与写权限范围）", source: "builtin", sources: ["builtin"] },
  // M55 §C: the command-parity finale pack.
  { name: "add-dir", description: "为会话添加工作区目录", args: "<path>", source: "builtin", sources: ["builtin"] },
  { name: "doctor", description: "健康检查：node/服务方/密钥/配置/磁盘/评测", source: "builtin", sources: ["builtin"] },
  { name: "tasks", description: "列出后台 agent（注册表快照）", source: "builtin", sources: ["builtin"] },
  { name: "skill:", description: "调用已加载的技能（裸 /skill: 列出全部）", args: "name [args]", source: "builtin", sources: ["builtin"] },
  // M61: scheduling & goal commands.
  { name: "loop", description: "定时循环：/loop 30m [提示词] 固定 · /loop [提示词] 动态 · /loop stop 停止", args: "[interval] [prompt]", source: "builtin", sources: ["builtin"] },
  { name: "goal", description: "条件驱动运行：/goal <条件> · 无参=状态 · clear 放弃", args: "<condition>", source: "builtin", sources: ["builtin"] },
  // ω99-15: the task-campaign human face (REPL v1; the model drives tasks
  // through the mission_* tool quartet). Bare = status; clear abandons.
  { name: "mission", description: "任务战役（任务 DAG+台账+可续跑）：/mission <总目标> 启动 · 无参=状态 · clear 放弃 · 模型经 mission_plan/next/complete/fail 驱动", args: "[<objective>|clear]", source: "builtin", sources: ["builtin"] },
  // ω99-5a: pause/unpause/run join the daemon verbs (run = the upstream project run_now).
  { name: "schedule", description: "定时任务与提醒（wudao ui 托管）：list | add \"<cron>\" <提示词> | rm <id> | pause/unpause <id> | run <id> 立即跑一次 | snooze <id> [分钟] 提醒稍后再响", args: "[list|add|rm|pause|unpause|run|snooze]", source: "builtin", sources: ["builtin"] },
  // cc-plugins B1: /plugin — the plugin/marketplace command face over the
  // A1/A2 engine (same one `wudao plugin` drives; notices 中文). Busy-safe
  // except the two directory-deleting ops (uninstall, marketplace remove).
  { name: "plugin", description: "插件管理：list · install <名>@<市场> · uninstall/enable/disable · marketplace add/list/update/remove", args: "<sub> [args]", source: "builtin", sources: ["builtin"] },
  // P1-5 (96 队列): /trust — the workspace trust gate's face. Bare = status
  // (decision, detected project resources, suppression); accept/revoke write
  // ~/.wudao/trust.json and hot-rescan the extension surfaces. Read-only
  // status + two config writes — busy-safe like /plugin's config ops.
  { name: "trust", description: "工作区信任门：无参=状态 · accept 信任本工作区（加载项目技能/插件/允许规则/hook）· revoke 回到默认拒绝", args: "[accept|revoke]", source: "builtin", sources: ["builtin"] },
  // P1-7 (96 队列): /worktree — the main session's isolated worktree. The
  // OPERATION root (tool cwd / permission workspace / extension face)
  // switches at the turn boundary; sessions/exports/costs stay pinned to the
  // original repo. remove refuses on uncommitted changes (keep only).
  { name: "worktree", description: "隔离工作树：无参=状态 · enter [名] 在轮界切换 agent 的操作根 · exit keep|remove 切回（remove 对未提交改动拒绝执行）", args: "[enter [name]|exit keep|exit remove]", source: "builtin", sources: ["builtin"] },
  // P2-13 (96 队列 #13): /constitution — the user constitution's human
  // face. Bare = status; show renders the active clauses; approve <n> /
  // reject <n> work the pending inbox the model's constitution_suggest
  // fills. Approvals load into the prompt on the next session start.
  { name: "constitution", description: "用户宪章：无参=状态 · show 看条款 · approve <n> / reject <n> 处理待定建议（模型只能建议）", args: "[show|approve <n>|reject <n>]", source: "builtin", sources: ["builtin"] },
];

/** cc-plugins D3 — annotate a skill entry with its invocation origin so the
 *  user can tell which tier it lives in without listing files. Plugin skills
 *  show the owning plugin name (e.g. `(superpowers)`); workspace/personal
 *  skills show their tier (`workspace` / `personal`). */
function skillDescription(s: LoadedSkill): string {
  // ω99-162: 来源后缀换中文词表（（插件：x）/（个人）/（工作区））——与菜单/帮助正文同族。
  if (s.plugin !== undefined) return `${s.description}（插件：${s.plugin}）`;
  if (s.origin === "personal") return `${s.description}（个人）`;
  return `${s.description}（工作区）`;
}

/** Aggregate every slash command this run knows about. cc-plugins D3: skill
 *  entries now render under their INVOCATION form — `/<name>` for workspace
 *  and personal skills (no plugin), `/<plugin>:<skill>` for plugin skills.
 *  The legacy `/skill:<name>` entry survives only as the BUILTIN annotation
 *  line in BUILTIN_COMMANDS (the legacy alias hint). */
export function listSlashCommands(args: {
  readonly skills?: readonly LoadedSkill[];
  readonly pluginCommands?: readonly PluginCommand[];
  /** Structural: ExtensionCommand (name + extension) fits without importing
   *  the extension API here. */
  readonly extensionCommands?: readonly { readonly name: string; readonly extension?: string }[];
}): readonly SlashCommandInfo[] {
  const byName = new Map<string, SlashCommandInfo>();
  const push = (cmd: SlashCommandInfo): void => {
    const existing = byName.get(cmd.name);
    if (existing === undefined) {
      byName.set(cmd.name, { ...cmd, sources: [...(cmd.sources.length > 0 ? cmd.sources : [cmd.source])] });
      return;
    }
    // first wins = parse priority, but the collision is recorded in sources
    const sources = new Set(existing.sources);
    sources.add(cmd.source);
    byName.set(cmd.name, { ...existing, sources: [...sources] });
  };
  for (const c of BUILTIN_COMMANDS) push(c);
  for (const s of args.skills ?? []) {
    // D3: workspace/personal → /<name>; plugin → /<plugin>:<skill>. The
    // shape `skill:<name>` is no longer emitted as a regular entry (the
    // legacy `/skill:<name>` builtin annotation covers it).
    const entryName = s.plugin !== undefined ? `${s.plugin}:${s.name}` : s.name;
    push({ name: entryName, description: skillDescription(s), source: "skill", sources: ["skill"] });
  }
  for (const c of args.pluginCommands ?? []) {
    push({ name: c.name, description: c.description, source: "plugin", sources: ["plugin"] });
  }
  for (const c of args.extensionCommands ?? []) {
    push({ name: c.name, description: `extension command (${c.extension ?? "extension"})`, source: "extension", sources: ["extension"] });
  }
  return [...byName.values()];
}

/** The menu's token for a line: the text after "/" while the user is still
 *  typing the command word (no whitespace yet). Undefined = no menu. */
export function slashToken(line: string): string | undefined {
  if (!line.startsWith("/")) return undefined;
  const rest = line.slice(1);
  return /\s/.test(rest) ? undefined : rest;
}

/** Prefix filter (spec: 行内前缀 — no fuzzy, no substring). */
export function filterSlashCommands(
  commands: readonly SlashCommandInfo[],
  token: string,
): readonly SlashCommandInfo[] {
  return commands.filter((c) => c.name.startsWith(token));
}

/** Complete a slash line to the selected command (the token has no
 *  whitespace by construction, so the replacement is the whole line). */
export function completeSlashLine(line: string, name: string): string {
  return `/${name}`;
}

/** The readline completer (REPL's simple version of the menu): name-only
 *  hits for a slash line still inside its command word; nothing otherwise. */
export function slashCompleter(
  line: string,
  commands: readonly SlashCommandInfo[],
): [string[], string] {
  const token = slashToken(line);
  if (token === undefined) return [[], line];
  return [filterSlashCommands(commands, token).map((c) => `/${c.name}`), line];
}

/** Display form of one command: "/plan <goal>", "/skill:name [args]" (no
 *  space after a colon-terminated name). M53 §4: a sensitive command's args
 *  preview as `<redacted>`. */
export function slashDisplay(cmd: SlashCommandInfo): string {
  if (cmd.args === undefined) return `/${cmd.name}`;
  const sep = cmd.name.endsWith(":") ? "" : " ";
  return `/${cmd.name}${sep}${cmd.isSensitive === true ? "<redacted>" : cmd.args}`;
}

/** M42 §4: /help rendered FROM the same listSlashCommands data — no
 *  hand-written command table anywhere. Ends with the keys block and the
 *  current mode line. M53 §4: immediate commands note `·` and sensitive ones
 *  redact their args preview. cc-plugins D3: an `invocation forms:` footer
 *  surfaces the three skill-invocation shapes (`/<name>` /
 *  `/<plugin>:<skill>` / `/skill:<name>` legacy) so the user can tell the
 *  slash line and a UI tab-completer the right one. */
export function formatSlashHelp(
  commands: readonly SlashCommandInfo[],
  opts: {
    /** Current permission mode label (rendered as `mode: <label>`). */
    readonly mode?: string;
    /** The keys detail line (frontend-specific); omitted = the TUI default. */
    readonly keysLine?: string;
    /** REPL drops the .wudao/keybindings.json remap header. */
    readonly frontend?: "tui" | "repl";
  } = {},
): string {
  const lines = ["命令："]; // ω99-162: 骨架头中文化（commands: → 命令：）。
  for (const c of commands) {
    // ω99-162: 旗标词中文化（immediate→即时、sensitive→敏感；[即时, 敏感] 连接符 ", " 原样）。
    const flags = [
      c.immediate === true ? "即时" : "",
      c.isSensitive === true ? "敏感" : "",
    ].filter((f) => f !== "").join(", ");
    lines.push(
      `  ${slashDisplay(c)}${c.description ? `  ${c.description}` : ""}${flags !== "" ? `  [${flags}]` : ""}`,
    );
  }
  // ω99-162: 三形态页脚中文化（列对齐空格数逐字保留：/<name> 后 14、/<plugin>:<skill> 后 4、/skill:<name> 后 8）。
  lines.push("调用形态（技能）：");
  lines.push("  /<name>              工作区/个人技能");
  lines.push("  /<plugin>:<skill>    命名空间下的插件技能");
  lines.push("  /skill:<name>        /<name> 的旧别名");
  // ω99-162: 键位头两形态中文化（REPL 变体「键位：」；TUI 变体带重映射说明）。
  lines.push(
    opts.frontend === "repl"
      ? "键位："
      : "键位（可在 .wudao/keybindings.json 重映射——见 README）：",
  );
  // ω99-161: 默认键位图例中文化（模式名 ask/auto/read-only=标识符原样）。
  lines.push(`  ${opts.keysLine ?? "Enter 发送 · \\+Enter 换行 · Esc 中断 · shift+tab 切换模式 (accept → ask → auto → plan)"}`); // ω99-191: #1
  if (opts.mode !== undefined) lines.push(`模式：${opts.mode}`); // ω99-162: mode 行头中文化（mode 标识符原样）。
  return lines.join("\n");
}
