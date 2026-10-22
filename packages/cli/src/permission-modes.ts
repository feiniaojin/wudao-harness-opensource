// Permission modes + tool classes — module-level segment extracted from
// permission.ts (ω99 file-size discipline arc A): the Mode union, the
// read/edit/workspace tool-class rosters, the workspace-safe command class,
// and the pure builtin-tier decision. No runtime state, no IO beyond the
// global-settings read in resolveInitialMode.
import type { PermissionDecision } from "@wudao/core";
import { readGlobalDefaultPermissionMode, readGlobalSettingsSync } from "./settings-layer.js";
// ω99-236: the doc trio's name rosters (READ/EDIT) — the two Sets below
// consume them at the tail instead of hardcoding the twelve doc names
// (展开后内容等值，出处注释全数保留在原位).
import { DOC_SUITE_READ_TOOLS, DOC_SUITE_EDIT_TOOLS } from "./doc-suite.js";

export type Mode = "workspace" | "ask" | "auto" | "plan";

// 0.3.12（用户裁定，对齐 the upstream harness 模式设计）— 三档权限制，read-out 四档
// 退役。档位语义（用户原话）：
//   workspace  工作空间本来就应该可读写（默认档）：工作区文件读写自由，
//              只读命令类（git status/diff/log/show/blame、ls/pwd/cat/
//              head/tail/wc）也放行，其他操作（命令/网络/MCP）仍询问。
//              ≈ the upstream formatacceptEdits。
//   ask        每次执行工具都要询问：除 harness 自身元工具外每个工具都
//              问。≈ the upstream formatdefault（按用户字面收紧到"每个工具"）。
//   auto       完全权限：全部放行（sidecar 分类器照跑）。≈ the upstream formatbypassPermissions。
//              ω99-226 产品裁定：电脑/浏览器八件套动作类也跟随本档放行
//              （sidecar 照审）——auto 是真放行，不再逐动作问。#452（0.3.81）
//              终局：托付+审计不打断——sidecar high/error/熔断判决同样自动
//              放行，审计走响亮回执；还问的只剩旁路免疫静态面（保护设置写/
//              凭据物料/操作员 ask 规则，见 4.65/夜移010/层4 注记）。
//   plan       只读探查（0.3.14 #3）：读取类 + 安全只读命令放行，其余一律
//              deny 带 reason（不询问，不打断）。≈ the upstream formatplan mode。完成方案后
//              切回 accept/auto 执行。
// 0.3.13 展示词汇对齐 the upstream format：界面一律显示 ask/accept/auto（workspace 显示为
// accept）；mode 值不变（持久化/协议零改动）。旧持久值迁移见
// readGlobalDefaultPermissionMode：default→ask、acceptEdits→workspace、
// auto→auto。

// Harness meta tools — never gated in ANY mode (not even ask): ask_user IS
// the ask (permission-gating it would ask permission to ask), and todo_write
// writes only the harness's own state file (.wudao/plan.md), not user code
// (M23 §1; the upstream formatprecedent: TodoWrite is auto-allowed everywhere, plan mode
// included).
export const META_TOOLS = new Set(["ask_user", "todo_write"]);

// Tools that only read data. Free in workspace mode (and in auto), ASKED in
// ask mode (the user's literal 0.3.12 ruling: 每次执行工具都要询问).
// monitor_list (ω-4a) discloses only the session's own watches — the same
// read class as load_tools; monitor_read (夜移 020) reads a watch's own
// buffered output — the same session-scoped read class.
// lsp (P2-9, 96 队列 #9): definitions/references/hover are pure reads of the
// workspace's own code — the grep class. The server PROCESS is the gated part
// (settings lsp.enabled, default off); once the operator opted in, per-call
// asks would only add noise grep never has.
// ω99-221: #8 — read_xlsx joins the read class (控制器 fix1 裁决): it reads a
// workspace file through resolveWorkspacePath — the read_file domain, and
// the write half (make_xlsx in FILE_EDIT_TOOLS) already auto-runs in
// workspace mode, so asking on the READ half inverts the trust domain. NOT
// the 212 screen_capture/app_list privacy faces (those read OUTSIDE the
// workspace — screen/app enumeration); read_xlsx stays out of
// DEFAULT_ASK_TOOLS either way (the ask set is the always-ask class).
// ω99-222: #6 — read_docx / read_pptx join the same way (221 fix1 裁定沿用，
// 本弧零再裁): both read workspace files through resolveWorkspacePath — the
// read_file domain — and their write halves (make_docx/make_pptx in
// FILE_EDIT_TOOLS) already auto-run in workspace mode, so the read halves
// take the same tier posture. Also out of DEFAULT_ASK_TOOLS (read class).
// ω99-236: #3 — the doc names now ride the doc-suite ROSTER (doc-suite.ts 的
// DOC_SUITE_READ_TOOLS / DOC_SUITE_EDIT_TOOLS)——本双名册从「逐名硬编码」
// 变「基础名 + 名册尾部展开」；展开后内容与重构前逐字等值（tests/
// omega99-236-doc-suite.test.ts R1(c) 钉）。名册静态消费：off 态名册惰性在
// 册（缺席名无害——门只控挂载，不控名单），出处注释全数保留。
// 121 挖掘 TOP5 #1: search_history joins the read class — it reads the
// session's OWN append-only ledger (the conversation the model itself took
// part in; no workspace file, no screen, no network), pure bypass read with
// zero side effects. The read_file-neighborhood posture: plan-mode's
// read-only fence lets a planner look up earlier conclusions, the sidecar
// never classifies it, and it stays out of DEFAULT_ASK_TOOLS (asking
// permission to reread one's own conversation would be pure noise).
// 121 §1 续章: note_read joins the same class — it lists the session's OWN
// note files under .wudao/notes/ (harness runtime data, the plan.md
// convention; no user file, no screen, no network). Its write twin
// note_write is DELIBERATELY in no roster: the write face keeps the
// fail-closed default ask in workspace mode (decidePermission's unknown-
// tool branch) — writing is a face the human sees, reading one's own
// notes is not.
// 125 项 2: context_remaining joins the read class — it computes the session's
// OWN occupancy/watermark over in-memory state (ctx_inspect 同缝：no file, no
// screen, no network, zero side effects). Asking permission to check one's own
// context gauge would be pure noise; plan-mode's read-only fence keeps it
// available to planners (the ones who most need the number).
export const READ_TOOLS = new Set(["read_file", "glob", "grep", "todo_write", "ask_user", "load_tools", "monitor_list", "monitor_read", "discover_skills", "lsp", "schedule_list", "search_history", "note_read", "context_remaining", ...DOC_SUITE_READ_TOOLS]);

// M58 §C#1: the file-edit class — the builtin tools that modify user files by
// path. workspace auto-allows this set (joined by READ_TOOLS); patch/
// apply-class builtins join here when they land. Runtime-policy writes
// (.wudao/settings.json) are NOT covered by the mode — protectedSettingsFile's
// bypass-immune layer asks before any builtin mode is consulted
// (decideRichPermission §2).
// ω99-123: make_xlsx joins the class — it writes a real file by (file)name,
// so it takes write_file's mode posture (workspace auto-allow, ask-mode ask)
// and the hard gate below reads its filename.
// ω99-124: make_pptx joins the same way (write target = the filename key).
// ω99-126: make_docx joins the same way; the two ternary chains that keyed
// the filename tools are consolidated into this Set lookup (readability debt
// cleared in-arc, behavior identical for the prior four names).
// ω99-223: #6 — append_docx / append_pptx join the class: they modify the
// user's named file by path (the append faces of the Word/PPT built-ins —
// edit/write_file class semantics: workspace auto-allow, ask-mode ask, plan
// deny). NOT into DEFAULT_ASK_TOOLS (edit 同形不进——the ask set is the
// always-ask class); also NOT into FILENAME_KEY_TOOLS (they carry the write
// target as `path`, like write_file/edit — the hard gate reads the right key
// through the existing Set lookup). Downstream WORKSPACE_TOOLS (the union)
// follows automatically.
// ω99-228: #3 — append_xlsx joins the class the same way (the Excel append
// face; write target carried as `path` exactly like append_docx — the :356
// path extraction below covers it through the existing Set lookup, zero
// extra seam).
// ω99-229: #3 — replace_docx / replace_pptx join the class the same way (the
// Word/PPT in-place rewrite faces; write target carried as `path` exactly like
// append_* — the :356 domain covers it, NOT into FILENAME_KEY_TOOLS) and also
// NOT into DEFAULT_ASK_TOOLS (edit 同形不进——the ask set is the always-ask
// class).
// ω99-231: #3 — replace_xlsx joins the class the same way (the Excel in-place
// rewrite face; write target carried as `path` exactly like replace_docx/
// replace_pptx — the :356 domain covers it, NOT into FILENAME_KEY_TOOLS) and
// also NOT into DEFAULT_ASK_TOOLS (229 同形不进——the ask set is the
// always-ask class).
// ω99-236 同缝续——写册九名同改 ROSTER 展开（DOC_SUITE_EDIT_TOOLS；READ_TOOLS
// 同缝同款，内容等值钉在 R1(c)）。
export const FILE_EDIT_TOOLS = new Set(["write_file", "edit", ...DOC_SUITE_EDIT_TOOLS]);

// ω99-126: the make_* tools carry their write target as `filename`, not
// `path` — the bypass-immune hard gate and credential detection read the
// right key by consulting this Set. Module-level next to FILE_EDIT_TOOLS;
// three call sites below (was two growing ternary chains).
export const FILENAME_KEY_TOOLS = new Set(["make_xlsx", "make_pptx", "make_docx"]);

// The workspace class — everything the workspace tier auto-allows.
// ω99-313: the durable-schedule write faces (schedule_add / schedule_remove)
// join the class — they edit the workspace's own runtime store
// (.wudao/schedules.json), the read/write family's in-workspace posture;
// NOT into DEFAULT_ASK_TOOLS (the always-ask set stays for the risky class).
// schedule_list rides READ_TOOLS with the other read faces.
// 127 项 1: continue_task joins schedule_add's tier — it edits the same
// runtime store (via the daemon's add face) plus a baton markdown under
// .wudao/task-chain/ (workspace runtime data, plan.md law).
export const WORKSPACE_TOOLS = new Set([...READ_TOOLS, ...FILE_EDIT_TOOLS, "schedule_add", "schedule_remove", "continue_task"]);

export function modeFromArgv(argv: readonly string[]): Mode {
  if (argv.includes("--auto")) return "auto";
  if (argv.includes("--ask")) return "ask";
  if (argv.includes("--plan")) return "plan";
  return "workspace";
}

/** 0.3.11（用户反馈：权限档两入口 1:1 联动）— the boot chain, ONE place for
 *  every entrypoint: explicit CLI flag (--auto/--ask/--plan) > the persisted
 *  default (global settings.json permissions.defaultMode — 向导⑤/设置页写)
 *  > "workspace" (0.3.12: 工作区可读写是默认档). `env` is a parameter so
 *  callers and tests stay hermetic (the production call sites pass
 *  process.env). */
export function resolveInitialMode(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Mode {
  if (argv.includes("--auto") || argv.includes("--ask") || argv.includes("--plan")) return modeFromArgv(argv);
  return readGlobalDefaultPermissionMode(readGlobalSettingsSync(env)) ?? "workspace";
}

/** Display label for a mode — the 0.3.13 the upstream formatvocabulary: workspace shows as
 *  "accept" (≈ the upstream formatacceptEdits); ask/auto show as themselves. The mode VALUE
 *  is unchanged (persistence + the wire protocol never see "accept"). */
export function modeLabel(mode: Mode): string {
  return mode === "workspace" ? "accept" : mode;
}

/** The runtime mode cycle driven by shift+tab — workspace → ask → auto →
 *  plan → workspace (0.3.14 #3: the fourth stop, read-only 探查; 0.3.12's
 *  three-tier cycle; the retired read-only stop and the old
 *  default/acceptEdits pair are gone). */
export function cycleMode(mode: Mode): Mode {
  return mode === "workspace" ? "ask" : mode === "ask" ? "auto" : mode === "auto" ? "plan" : "workspace";
}

// ---------------------------------------------------------------------------
// 0.3.14 #2 — accept 档的工作区命令分级：一条精选只读命令类在 accept
// (workspace) 档免问（git status/diff/log/show/blame + ls/pwd/cat/head/tail/
// wc）。这是纯读检查，替代不了 shell 的副作用围栏——不在这条类里的
// 命令照旧询问（fail-closed）。
// ---------------------------------------------------------------------------

/** Bare read-only verbs (no path relocation, no side effects). */
const SAFE_WORKSPACE_VERBS = new Set(["ls", "pwd", "cat", "head", "tail", "wc"]);
/** `git <sub>` pairs that only read repo state. branch/stash/remote stay out —
 *  they have mutating forms (`branch -D`); v1 keeps the class unambiguous. */
const SAFE_GIT_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "blame"]);
/** Flags that relocate git's view outside the cwd or write files (`-C<path>`
 *  glues, hence the prefix match). */
const UNSAFE_GIT_FLAGS = ["-C", "--git-dir", "--work-tree", "--output"];

/** A command-segment token is path-safe when it cannot escape the workspace:
 *  no absolute paths, no `~`, no `..` path segment (git rev ranges like
 *  `v1.0..v2.0` contain no `/`-delimited `..` part and pass). */
function workspaceSafeToken(token: string): boolean {
  if (token.startsWith("/") || token.startsWith("~")) return false;
  return !token.split("/").some((part) => part === "..");
}

/** One `;`/`&&`/`||`-separated segment qualifies when the verb is listed and
 *  every token is path-safe and metachar-free. */
function safeWorkspaceSegment(segment: string): boolean {
  // Shell metacharacters (post-split: a lone |, &, or any redirection/command
  // substitution) disqualify outright — quoting subtleties are not worth
  // reasoning about; the fallback is an ask, not a deny.
  if (/[;|&><`$()\r\n]/.test(segment)) return false;
  const tokens = segment.trim().split(/\s+/).filter((t) => t !== "");
  if (tokens.length === 0) return false;
  const verb = tokens[0];
  if (verb === undefined) return false; // unreachable post length-check; tsc can't see it
  const sub = tokens[1];
  const isGit = verb === "git" && sub !== undefined && SAFE_GIT_SUBCOMMANDS.has(sub);
  if (!isGit && !SAFE_WORKSPACE_VERBS.has(verb)) return false;
  return tokens.every(
    (t) => workspaceSafeToken(t) && !UNSAFE_GIT_FLAGS.some((f) => t.startsWith(f)),
  );
}

/** accept 档免问判定（纯函数）：命令按 `;`/`&&`/`||`/换行 切段，每段都须
 *  合格（动词在白名单、参数不可逃出工作区、无 shell 元字符）。任何解析不
 *  出的结果都是 false → 照旧询问。 */
export function safeWorkspaceCommand(command: string): boolean {
  const segments = command
    .split(/;|&&|\|\||\n/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (segments.length === 0) return false;
  return segments.every(safeWorkspaceSegment);
}

/** 0.3.14 #3 — the plan-mode deny reason: names the posture AND the way out
 *  (the model finishes the plan; the human switches tiers to execute). */
export const PLAN_DENY_REASON =
  "plan mode is read-only — finish the plan and present it; the user switches to accept/auto to execute";

// Pure permission decision (no I/O). Returns "ask" when the human must be prompted.
export function decidePermission(mode: Mode, toolName: string): PermissionDecision | "ask" {
  if (mode === "auto") return { behavior: "allow" };
  if (META_TOOLS.has(toolName)) return { behavior: "allow" };
  // 0.3.14 #3: plan is read-only 探查 — reads (and, at the rich layer, the
  // workspace-safe command class) pass; everything else DENIES with the
  // self-teaching reason. Never asks: plan must not interrupt the run.
  if (mode === "plan") {
    return READ_TOOLS.has(toolName)
      ? { behavior: "allow" }
      : { behavior: "deny", reason: PLAN_DENY_REASON };
  }
  if (mode === "ask") return "ask";
  // MCP tools call user-configured external servers (arbitrary local
  // commands) — explicitly NOT workspace tools: ask in workspace mode, never
  // silently allowed.
  if (toolName.startsWith("mcp__")) return "ask";
  // workspace: the file/read class auto-allowed; shell, web tools and
  // any tool the harness does not know (fail-closed) keep the ask.
  if (WORKSPACE_TOOLS.has(toolName)) return { behavior: "allow" };
  return "ask";
}
