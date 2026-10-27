// 借鉴弧 ζ2（digest-c 候选 4，Amp 09-11 "Restack Your Changes" 思想）——
// 归因驱动的改动重组提交。在位者=ω99-319 的命令级改动归因（settle 缝落
// turn_diff_receipt.changes[].cmd + command_footprint 条目——数据在、无产
// 物）；本层把这份现成数据变成交付物：把本会话的归因重组成一串干净的 git
// 提交（每个逻辑变更一提交，消息=归因命令+文件清单），先预览、`apply` 执
// 行。
//
// 安全律（绝不 force 的具体化）：
//   * 只 git add / 只提交「显式列出」的文件（commit 带 pathspec——`--only`
//     语义，即使索引里混进别的东西也不会被卷进提交）；
//   * 工作树有「已暂存」改动 → 整体拒做（restack 不与用户的暂存区混合，
//     请先提交或取消暂存）——预览与 apply 双查（TOCTOU 诚实）；
//   * 未归因改动诚实报告「N 个文件不在任何归因组」并跳过（绝不顺手打包）；
//   * 无 --force / --amend / push，任何 git 失败即停即报。
//
// 命令形状（/find、/recall 的 TUI 自有命令先例——拦截在共享 parseReplCommand
// 之前；REPL/web 不广播此名）。数据缝=驱动方法 driver.restack（会话 JSONL
// 的归因条目 + workspaceRoot），纯逻辑全在本模块。
//
// M24：零——会话内只读会话文件 + git 子进程，不进 state.messages、不进
// system prompt、不动任何模型请求字节。
import { truncateSafe } from "@wudao/core"; // 113-A4
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { relative } from "node:path";
import type { SessionEntry } from "@wudao/core";
import type { SlashCommandInfo } from "./slash-commands.js";
import { hardenedGitArgs } from "./git-hardened.js";

const execFileAsync = promisify(execFile);

/** ζ2: one git call's budget (a commit on a big repo can take seconds). */
const GIT_TIMEOUT_MS = 15_000;

/** The git spawn (git-branch.ts's injectable-runner discipline — tests script
 *  it, zero real git in the test chain). null = binary missing (ENOENT);
 *  undefined = failed (non-repo among other things); never throws. */
export type RestackRunner = (args: readonly string[], cwd: string) => Promise<{ stdout: string; stderr: string } | null | undefined>;

async function runGit(args: readonly string[], cwd: string): Promise<{ stdout: string; stderr: string } | null | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync("git", hardenedGitArgs(args), {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (err) {
    if (err !== null && typeof err === "object" && (err as { code?: unknown }).code === "ENOENT") return null;
    return undefined;
  }
}

/** ζ2: the TUI menu entry (the REPL never advertises a name it does not
 *  route — /recall precedent). */
export const RESTACK_COMMAND_INFO: SlashCommandInfo = {
  name: "restack",
  description: "把本会话的改动按归因重组成干净的提交序列（先预览，apply 执行）",
  args: "[apply]",
  source: "builtin",
  sources: ["builtin"],
};

/** Parse a /restack line. Bare → preview; `/restack apply` → execute.
 *  Prefix-neighbors and anything else return undefined. */
export function parseRestackCommand(text: string): { readonly apply: boolean } | undefined {
  const trimmed = text.trim();
  if (trimmed === "/restack") return { apply: false };
  if (trimmed === "/restack apply") return { apply: true };
  return undefined;
}

// ---------------------------------------------------------------------------
// git status --porcelain -z 解析（纯）
// ---------------------------------------------------------------------------

/** One worktree change row. `repoPath` is REPO-relative (porcelain's own
 *  coordinate); staged = anything in the index column. */
export interface GitStatusRow {
  readonly repoPath: string;
  /** True when the INDEX column is non-blank and not untracked ('?'). */
  readonly staged: boolean;
  readonly untracked: boolean;
}

/** Parse `git status --porcelain -z` output. NUL-separated records; an R/C
 *  record carries the original path as the NEXT NUL field (consumed — the
 *  rename's new path is the change we track; the dropped original rides as
 *  a deleted row so both sides stay attributable). Pure. */
export function parseGitStatusZ(out: string): GitStatusRow[] {
  const fields = out.split("\0");
  const rows: GitStatusRow[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const record = fields[i];
    if (record === undefined || record === "") continue;
    const x = record[0];
    const y = record[1];
    const path = record.slice(3);
    if (path === "" || x === undefined || y === undefined) continue;
    if (x === "!" && y === "!") continue; // ignored — never restack material
    const untracked = x === "?" && y === "?";
    if (x === "R" || x === "C") {
      const orig = fields[i + 1];
      if (orig !== undefined && orig !== "") {
        rows.push({ repoPath: orig, staged: false, untracked: false }); // the rename's dropped half
        i += 1;
      }
    }
    rows.push({ repoPath: path, staged: !untracked && x !== " ", untracked });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 归因数据 → 重组计划（纯）
// ---------------------------------------------------------------------------

/** One attributed change (the settle seam's writer contract, read side). */
export interface RestackAttribution {
  /** The shell command the change is attributed to; undefined = the session's
   *  direct write_file/edit tool writes. */
  readonly command?: string;
  readonly path: string;
  readonly kind: "created" | "modified" | "deleted";
}

/** Read the session's attribution data off its JSONL entries (file order):
 *  command_footprint entries (authoritative, carries deletions) then the
 *  turn_diff_receipt rows (cmd rows merge under the same command; no-cmd
 *  rows are the tools group). Writer-contract validation per field — a
 *  malformed payload drops the row, never the read (resume.ts's law). */
export function attributionsFromEntries(entries: readonly SessionEntry[]): RestackAttribution[] {
  const out: RestackAttribution[] = [];
  for (const e of entries) {
    if (!("type" in e)) continue;
    const data: unknown = (e as { readonly type?: unknown; readonly data?: unknown }).type !== undefined
      ? (e as { readonly data?: unknown }).data
      : undefined;
    if (typeof data !== "object" || data === null) continue;
    if (e.type === "command_footprint") {
      const { command, files } = data as Record<string, unknown>;
      if (typeof command !== "string" || command === "" || !Array.isArray(files)) continue;
      for (const f of files) {
        if (typeof f !== "object" || f === null) continue;
        const { path, kind } = f as Record<string, unknown>;
        if (typeof path !== "string" || path === "") continue;
        if (kind !== "modified" && kind !== "created" && kind !== "deleted") continue;
        out.push({ command, path, kind });
      }
      continue;
    }
    if (e.type === "turn_diff_receipt") {
      const { changes } = data as Record<string, unknown>;
      if (!Array.isArray(changes)) continue;
      for (const c of changes) {
        if (typeof c !== "object" || c === null) continue;
        const { path, op, cmd } = c as Record<string, unknown>;
        if (typeof path !== "string" || path === "") continue;
        if (op !== "created" && op !== "modified") continue;
        const cmdOk = cmd === undefined || (typeof cmd === "string" && cmd !== "" && cmd.length <= 201);
        if (!cmdOk) continue;
        out.push({ ...(cmd !== undefined ? { command: cmd } : {}), path, kind: op });
      }
    }
  }
  return out;
}

/** One planned commit: a logical change with its attributed files. */
export interface RestackGroup {
  /** Commit subject fragment: the command head, or the tools-group label. */
  readonly label: string;
  readonly command?: string;
  /** Workspace-relative file paths (final attribution wins per file). */
  readonly files: readonly string[];
}

/** The full plan + the honest edges. */
export interface RestackPlan {
  readonly groups: readonly RestackGroup[];
  /** Worktree-changed files in NO attribution group — reported, skipped. */
  readonly unattributed: readonly string[];
  /** Attributed files not currently changed (already committed/reverted). */
  readonly staleAttributed: readonly string[];
}

const TOOLS_GROUP = "__tools__";

/** Fold attributions + worktree status into the restack plan. Pure.
 *  `prefix` is the workspace root's path RELATIVE to the repo top ("" when
 *  they coincide) — attribution paths are workspace-relative, porcelain
 *  paths are repo-relative; the join is deterministic. Group files and the
 *  unattributed list stay WORKSPACE-relative (the user's anchor; git add
 *  resolves them against the cwd it runs in). */
export function planRestack(attributions: readonly RestackAttribution[], status: readonly GitStatusRow[], prefix: string): RestackPlan {
  const toRepo = (wsRel: string): string => (prefix === "" ? wsRel : `${prefix}/${wsRel}`);
  const toWs = (repoRel: string): string => (prefix !== "" && repoRel.startsWith(`${prefix}/`) ? repoRel.slice(prefix.length + 1) : repoRel);
  // Current worktree changes, keyed repo-relative (dedup: rename halves).
  const changed = new Map<string, GitStatusRow>();
  for (const row of status) if (!changed.has(row.repoPath)) changed.set(row.repoPath, row);
  // Per-file final attribution: the LAST attribution event wins (the file's
  // current bytes belong to its most recent logical change).
  const fileGroup = new Map<string, string>(); // ws-relative path → group key
  const groupOrder: string[] = [];
  const groupCommand = new Map<string, string>();
  const stale: string[] = [];
  for (const a of attributions) {
    const repoPath = toRepo(a.path);
    const key = a.command !== undefined ? a.command : TOOLS_GROUP;
    if (!groupCommand.has(key)) {
      groupCommand.set(key, a.command ?? "");
      groupOrder.push(key);
    }
    if (!changed.has(repoPath)) {
      if (!stale.includes(a.path)) stale.push(a.path);
      fileGroup.delete(a.path); // a later revert may un-stage it — keep honest
      continue;
    }
    fileGroup.set(a.path, key);
  }
  const groups: RestackGroup[] = [];
  for (const key of groupOrder) {
    const files = [...fileGroup.entries()].filter(([, k]) => k === key).map(([p]) => p);
    if (files.length === 0) continue; // every file went stale — the group commits nothing
    const command = key === TOOLS_GROUP ? undefined : key;
    groups.push({ label: commandHead(command), ...(command !== undefined ? { command } : {}), files });
  }
  const attributedPaths = new Set([...fileGroup.keys()].map(toRepo));
  const unattributed = [...changed.keys()].filter((p) => !attributedPaths.has(p)).map(toWs);
  return { groups, unattributed, staleAttributed: stale.filter((p) => !attributedPaths.has(toRepo(p))) };
}

/** The commit-subject fragment for one command (first line, capped). */
function commandHead(command: string | undefined): string {
  if (command === undefined) return "会话文件写入（write_file/edit）";
  const head = command.split("\n")[0] ?? command;
  return head.length > 60 ? `${truncateSafe(head, 59)}…` : head;
}

/** ζ2: the commit message — subject = attribution head, body = the full
 *  command + the explicit file list. Pure. */
export function restackCommitMessage(group: RestackGroup): string {
  const files = group.files.map((f) => `- ${f}`).join("\n");
  const attribution = group.command !== undefined
    ? `归因命令：${group.command}`
    : "归因：会话内 write_file/edit 直接写入（无 shell 命令归因）";
  return `wudao(restack): ${group.label}\n\n${attribution}\n\n文件：\n${files}`;
}

/** The preview notice (收益语——用户看到的是「会得到哪几个提交」，不是机
 *  制术语）。Pure. */
export function formatRestackPreview(plan: RestackPlan): string {
  const lines = [`📦 restack 预览：把本会话的改动重组成 ${plan.groups.length} 个提交`];
  for (const g of plan.groups) {
    lines.push(``);
    lines.push(`● ${g.label}`);
    for (const f of g.files) lines.push(`  ${f}`);
  }
  if (plan.unattributed.length > 0) {
    const shown = plan.unattributed.slice(0, 10).join("、");
    const more = plan.unattributed.length > 10 ? ` 等 ${plan.unattributed.length} 个` : "";
    lines.push(``);
    lines.push(`⚠️ ${plan.unattributed.length} 个文件不在任何归因组（${shown}${more}）——跳过不提交`);
  }
  if (plan.staleAttributed.length > 0) {
    lines.push(`ℹ️ 另有 ${plan.staleAttributed.length} 个归因文件已是提交态，本次不涉及`);
  }
  lines.push(``);
  lines.push(`确认无误后执行：/restack apply`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 编排（预览/执行——拒绝面全在两端同查）
// ---------------------------------------------------------------------------

export interface RestackDeps {
  /** The workspace root (attribution paths' anchor; git runs here). */
  readonly cwd: string;
  /** The CURRENT session's JSONL entries (the attribution source). */
  readonly loadEntries: () => Promise<readonly SessionEntry[]>;
  /** Injectable git spawn (tests script it; the default spawns). */
  readonly run?: RestackRunner;
}

/** One restack pass: read status + attribution, plan, then preview or apply.
 *  Returns the notice text — refusals included, NEVER a throw into the
 *  caller (the driver lane just prints). */
export async function runRestack(mode: "preview" | "apply", deps: RestackDeps): Promise<string> {
  const run = deps.run ?? runGit;
  const top = await run(["rev-parse", "--show-toplevel"], deps.cwd);
  if (top === null) return "（git 不可用——restack 需要 git）";
  if (top === undefined || top.stdout.trim() === "") return "（这里不是 git 仓库——restack 把改动重组成提交，需要 git）";
  const repoTop = top.stdout.trim();
  const prefix = relative(repoTop, deps.cwd).split("\\").join("/");
  const status = await run(["status", "--porcelain", "-z"], deps.cwd);
  if (status === null || status === undefined) return "（读取 git 状态失败——restack 未做任何改动）";
  const rows = parseGitStatusZ(status.stdout);
  if (rows.length === 0) return "（没有未提交的改动可重组）";
  if (rows.some((r) => r.staged)) {
    return "（工作区有已暂存的改动——restack 绝不与它们混合；请先提交或取消暂存（git restore --staged .），再运行 /restack）";
  }
  const attributions = attributionsFromEntries(await deps.loadEntries());
  if (attributions.length === 0) {
    return "（本会话没有改动归因数据——restack 按会话的命令级归因分组，此会话没有可用的归因记录）";
  }
  const plan = planRestack(attributions, rows, prefix);
  if (plan.groups.length === 0) {
    return plan.unattributed.length > 0
      ? `（归因覆盖的文件都已是提交态；当前 ${plan.unattributed.length} 个未提交改动不在任何归因组——restack 只提交归因过的文件，全部跳过）`
      : "（归因覆盖的文件都已是提交态——无可重组）";
  }
  if (mode === "preview") return formatRestackPreview(plan);
  // apply：逐组 add（只加显式列出的文件）→ commit（带 pathspec 的 --only
  // 语义——索引里若有任何其他东西也不会被卷进提交）。任何失败即停即报。
  const results: string[] = [];
  for (const g of plan.groups) {
    const add = await run(["add", "--", ...g.files], deps.cwd);
    if (add === null || add === undefined) {
      results.push(`✖ ${g.label}：git add 失败，已停止（未提交任何东西）`);
      return [`📦 restack 中止：`, ...results].join("\n");
    }
    const msg = restackCommitMessage(g);
    const commit = await run(["commit", "-m", msg, "--", ...g.files], deps.cwd);
    if (commit === null || commit === undefined) {
      results.push(`✖ ${g.label}：git commit 失败，已停止（该组的 add 已进索引——可 git restore --staged . 撤销）`);
      return [`📦 restack 中止：`, ...results].join("\n");
    }
    results.push(`✔ ${g.label}（${g.files.length} 文件）`);
  }
  const skipped = plan.unattributed.length > 0 ? `\n⚠️ ${plan.unattributed.length} 个未归因文件保持未提交` : "";
  return `📦 restack 完成：${plan.groups.length} 个提交\n${results.join("\n")}${skipped}`;
}
