// 拆分运动 C：从 app.tsx 原样外提的提交路由器（onSubmit 的函数体——
// /resume 选择器、!cmd、/find、slash 命令族、@-mention/bang 前缀编织）。
// 显式依赖对象（无闭包捕获）；app.tsx 的 useCallback 包装保持原依赖数组，
// 闭包捕获语义与原函数体逐字节同源。
import { truncateSafe } from "@wudao/core"; // 113-A4
import { join } from "node:path";
import type { Dispatch, SetStateAction } from "react";
import type { SessionStore } from "@wudao/core";
import type { AgentRegistry } from "../agents/index.js";
import type { ExtensionCommand } from "../extensions/api.js";
import type { PluginCommand } from "../plugins.js";
import type { Mode } from "../permission.js";
import type { SessionRow } from "../session-list.js";
import type { SlashCommandInfo } from "../slash-commands.js";
import type { UseAgentResult } from "./use-agent.js";
import { appendPromptHistory } from "../prompt-history.js";
import { parseBangCommand, runBangCommand, formatBangEcho, buildBangContextPrefix } from "../bang.js";
import { parseFindCommand } from "./find-core.js";
import { parseRecallCommand, recallTargetOf } from "./recall-core.js";
import { parseRestackCommand } from "../restack.js";

import { parseBgCommand } from "./bg-core.js";
import { describeDetachVerdict } from "../driver/detach-lane.js";
import { parseReplCommand } from "../repl.js";
import { formatSlashHelp } from "../slash-commands.js";
import { modeLabel } from "../permission.js";
import { collectSessionRows, defaultSessionListFilter, ensureSessionName, formatResumePickerLine } from "../session-list.js";
import { expandMentions } from "../mentions.js";
import { buildPluginCommandMessage, formatPluginCommandError } from "../plugins.js";
import { runExtensionCommand } from "../extensions/dispatch.js";
import { parsePlanReviewInput } from "../plan.js";

/** The submit router's explicit dependency slice (app.tsx 的回调包装逐名传入). */
export interface SubmitDeps {
  readonly apiRef: { readonly current: UseAgentResult | null };
  readonly exit: () => void;
  readonly workspaceRoot: string;
  readonly resumePicker: readonly SessionRow[] | null;
  readonly setResumePicker: (rows: readonly SessionRow[] | null) => void;
  readonly setFindQuery: (q: string | null) => void;
  readonly setClearPending: (pending: boolean) => void;
  readonly setEditDraft: Dispatch<SetStateAction<{ readonly text: string; readonly nonce: number } | null>>;
  readonly setSessionName: (name: string | undefined) => void;
  readonly sessionName: string | undefined;
  readonly slashCommands: readonly SlashCommandInfo[];
  readonly pluginCommands: readonly PluginCommand[];
  readonly extensionCommands: readonly ExtensionCommand[];
  readonly agentsRegistry: AgentRegistry;
  readonly loadSession: (id: string, knownName?: string) => Promise<void>;
  readonly storeRef: { readonly current: SessionStore };
  readonly sessionRef: { current: string };
  readonly bangContextRef: { current: string | null };
  readonly initialMode: { readonly current: Mode };
}

export function routeSubmit(d: SubmitDeps, text: string): void {
  const a = d.apiRef.current;
  if (!a) return;
  // M33 §3: while the /resume picker is open, a bare number picks a session;
  // any other input cancels the picker and processes normally.
  if (d.resumePicker !== null) {
    const n = /^(\d+)$/.exec(text.trim());
    const row = n !== null ? d.resumePicker[Number(n[1]) - 1] : undefined;
    if (n !== null) {
      if (row === undefined) {
        a.notify(`(no session ${n[1] ?? ""} — pick 1-${d.resumePicker.length}, or type anything else to cancel)`);
        return;
      }
      void d.loadSession(row.id, row.name);
      return;
    }
    d.setResumePicker(null);
  }
  // M58 §C#12: `!cmd` — a user-initiated shell line. No permission gate by
  // construction (the human typed it, same trust class as their terminal):
  // echo the capped capture, and park the command+output as the context
  // prefix the NEXT submitted prompt carries to the model.
  const bang = parseBangCommand(text);
  if (bang !== undefined) {
    void runBangCommand(bang)
      .then((r) => {
        a.notify(formatBangEcho(r));
        d.bangContextRef.current = buildBangContextPrefix(r);
      })
      .catch(() => {});
    return;
  }
  // ω99-59: /find <query> — the TUI's in-transcript search overlay.
  // Intercepted BEFORE parseReplCommand on purpose: the command union is
  // shared with the driver's exhaustive routing switch, and a TUI-only
  // overlay needs no driver arm — the line never becomes a prompt. Bare
  // /find refuses to open the panel (usage notice instead).
  const find = parseFindCommand(text);
  if (find !== undefined) {
    if (find.query === "") {
      a.notify("用法：/find <query> — 在当前转录内查找（/search 查过去会话）"); // ω99-166d-i: #37
    } else {
      d.setFindQuery(find.query);
    }
    return;
  }
  // 借鉴弧 α2（the upstream format2.1.269 思想）: /recall [n] — recall a queued steer before
  // the loop drains it. The /find interception shape (TUI-owned, no driver
  // routing arm): resolve the target against the LIVE status snapshot, then
  // the driver's CAS face does the race-safe removal. A false reply means it
  // was already consumed — the ⏳ line disappears with the next frame.
  const recall = parseRecallCommand(text);
  if (recall !== undefined) {
    const target = recallTargetOf(a.queued, recall.n);
    if ("refusal" in target) {
      a.notify(target.refusal);
    } else if (d.apiRef.current?.driver.recallSteer(target.index, target.text)) {
      a.notify(`↩ 已撤回排队消息：${truncateSafe(target.text.split("\n")[0] ?? "", 60)}`);
    } else {
      a.notify("⚠️ 这条消息刚被读取或已撤回——晚了一步");
    }
    return;
  }
  // 借鉴弧 ζ2（Amp Restack 思想）: /restack [apply] — 把本会话的归因改动
  // 重组成干净提交序列。/find、/recall 同款 TUI 自有命令形状（拦截在共享
  // parseReplCommand 之前）；数据缝=driver.restack（会话 JSONL 归因条目）。
  const restack = parseRestackCommand(text);
  if (restack !== undefined) {
    d.apiRef.current?.driver.restack(restack.apply ? "apply" : "preview");
    return;
  }

  // 借鉴弧 δ（the upstream harness 367ab084 思想）: /bg [n] — 把一个在飞的工具
  // 调用转入后台（结果不再阻塞本轮；run 在轮界收口，落定结果稍后经后台
  // 车道并入）。/recall 的 TUI 自有命令形态：裸命令=驱动面挑第一个可转的
  // 在飞行；/bg <n>=第 n 个 busy 行（行序即 live.busyTools 渲染序）。typed
  // 裁决即时回执；ok 的历史回执落在 finished(backgrounded) 事件的真相点。
  const bg = parseBgCommand(text);
  if (bg !== undefined) {
    if (bg.n !== undefined) {
      const row = a.live.busyTools[bg.n - 1];
      if (row === undefined || row.callId === undefined) {
        a.notify(`用法：/bg [n]——没有第 ${bg.n} 个在飞工具（裸 /bg 转第一个可转的）`);
        return;
      }
      const v = d.apiRef.current?.driver.detachToolCall(row.callId);
      if (v !== undefined) a.notify(describeDetachVerdict(v));
      return;
    }
    const v = d.apiRef.current?.driver.detachToolCall();
    if (v !== undefined) a.notify(describeDetachVerdict(v));
    return;
  }
  const cmd = parseReplCommand(text, d.pluginCommands.map((c) => c.name), d.extensionCommands.map((c) => c.name));
  if (cmd.kind === "noop") return;
  if (cmd.kind === "exit") {
    d.exit();
    return;
  }
  if (cmd.kind === "help") {
    a.notify(formatSlashHelp(d.slashCommands, { mode: modeLabel(d.apiRef.current?.getMode() ?? d.initialMode.current) }));
    return;
  }
  if (cmd.kind === "resume") {
    if (a.busy) {
      a.notify("⚠️ cannot /resume while a run is in flight");
      return;
    }
    void (async () => {
      // M58 §C#7: inside a git worktree the picker defaults to THIS
      // worktree's sessions; --all on the launch argv lifts the filter.
      const filter = await defaultSessionListFilter(d.workspaceRoot);
      const rows = (await collectSessionRows(
        join(d.workspaceRoot, ".wudao", "sessions"),
        filter !== undefined ? { filterWorkspaceRoot: filter } : {},
      )).slice(-10).reverse();
      if (rows.length === 0) {
        a.notify(filter !== undefined ? "（此 worktree 无已存会话——经 --all 重启后 /resume --all 列出全部根）" : "（无已存会话可恢复）"); // ω99-166d-ii: #28（resume 空列表双臂回执中文化，一处注记）
        return;
      }
      d.setResumePicker(rows);
      for (const [i, r] of rows.entries()) a.notify(formatResumePickerLine(i + 1, r));
      a.notify(`(1 = most recent · enter a number 1-${rows.length} to load · anything else cancels)`);
    })();
    return;
  }
  if (cmd.kind === "clear") {
    if (a.busy) {
      a.notify("⚠️ 运行中无法 /clear"); // ω99-166c-iv: #24
      return;
    }
    // M42 §4: single-key y/N confirm before wiping (防误清) — the ClearConfirm
    // component owns the keyboard until answered.
    d.setClearPending(true);
    return;
  }
  // M53 §1: /edit <n> arms the branch IN THE DRIVER and returns the
  // original text, which lands in the input for editing (the resubmit
  // branches). Bare /edit (or a non-numeric arg) lists the messages —
  // routed through the driver's submit like every other notice command.
  if (cmd.kind === "edit" && cmd.n !== undefined) {
    if (a.busy) {
      a.notify("⚠️ cannot /edit while a run is in flight");
      return;
    }
    const text = d.apiRef.current?.driver.beginEdit(cmd.n);
    if (text === undefined) {
      a.notify(`用法：/edit <n>——没有第 ${cmd.n} 条消息（裸 /edit 列出可选消息，1 = 最近一条）`); // ω99-166d-i: #33
      return;
    }
    d.setEditDraft((cur) => ({ text, nonce: (cur?.nonce ?? 0) + 1 }));
    a.notify(`✎ editing message ${cmd.n} — edit and resubmit to branch from its parent (anything else you submit branches too; /switch returns)`);
    return;
  }
  // M53 §1: /tree //switch route through the driver's submit (notices);
  // an armed edit is consumed by the next prompt submit or disarmed here.
  if (cmd.kind === "tree" || cmd.kind === "switch") {
    d.setEditDraft(null);
    a.submit(text);
    return;
  }
  // M36 /<plugin-cmd> [args]: expand the template and submit through the
  // normal prompt path (same pipeline as /skill:). Unknown → listing notice
  // (defensive — parse only matches registered names). M43-A: the envelope
  // is submitted verbatim — its own @tokens are the template author's.
  if (cmd.kind === "pluginCommand") {
    const pluginCmd = d.pluginCommands.find((c) => c.name === cmd.name);
    if (!pluginCmd) {
      a.notify(formatPluginCommandError(cmd.name, d.pluginCommands));
      return;
    }
    a.submit(buildPluginCommandMessage(pluginCmd, cmd.args), { expand: false });
    return;
  }
  // M39 /<ext-cmd> [args]: run the extension handler in isolation — notice
  // lines surface as notifies; a ctx.submit-ed turn rides the normal prompt
  // path (queued as steering while a run is in flight).
  if (cmd.kind === "extensionCommand") {
    const extCmd = d.extensionCommands.find((c) => c.name === cmd.name);
    if (!extCmd) {
      a.notify(`⚠️ 无此扩展命令 "/${cmd.name}"`); // ω99-175: #2
      return;
    }
    void runExtensionCommand(extCmd, cmd.args, {
      notice: (t) => a.notify(t),
      warn: (m) => a.notify(`⚠️ ${m}`),
    }).then((submitted) => {
      if (submitted !== undefined) a.submit(submitted, { expand: false });
    });
    return;
  }
  // M43-A Task 3: /plan, /skill:, /rewind, @-mention expansion, and the
  // plan-review (ok / 改 …) inputs all route INSIDE the driver's submit.
  // The remaining TUI-side concern is its own follow-up UI: a review input
  // consumed as approval/revision is not a real prompt, so it must not name
  // the session or re-list background agents.
  const isReview = cmd.kind === "prompt" && a.planBoard !== null && parsePlanReviewInput(cmd.text) !== undefined;
  if (cmd.kind === "prompt" && !isReview) {
    // M58 §C#10: every real submitted prompt lands in the global
    // cross-session history (fire-and-forget; failures never break a submit).
    void appendPromptHistory(cmd.text, d.workspaceRoot).catch(() => {});
    // M30 §B: every user turn re-lists in-flight background agents once (id +
    // role, from the registry's status snapshot) so the human can see what is
    // still running — and the model gets a fresh chance to await instead of
    // double-spawning the same work. M31 §3: the lineage arrow marks resume
    // children (bg-2 ← t-1).
    const inFlight = d.agentsRegistry.status().filter((s) => s.status === "queued" || s.status === "running");
    if (inFlight.length > 0) {
      a.notify(`⏳ 后台在飞：${inFlight.map((s) => `${s.id}${s.parentCallId !== undefined ? ` ← ${s.parentCallId}` : ""} ${s.role}`).join(" · ")}`); // ω99-175: #3（lineage 箭头/圆点分隔原样）
    }
    // M33 §3: a fresh session takes its name from the first user turn (once).
    // M34 §2: the NAME keeps the raw text; the submitted prompt is the
    // @-mention-expanded one (the driver expands; notices surface as dim
    // lines and never enter history).
    if (d.sessionName === undefined) {
      void ensureSessionName(d.storeRef.current, d.sessionRef.current, cmd.text)
        .then((r) => { if (r !== undefined) d.setSessionName(r.name); })
        .catch(() => {});
    }
  }
  // M53 §1: a plain prompt consumes the armed /edit (the driver branches);
  // drop the draft so it cannot replace the buffer again later.
  d.setEditDraft(null);
  // M58 §C#12: a pending bang capture prefixes the next real prompt. The
  // user's own @mentions expand FIRST; the envelope then submits verbatim
  // (expand:false) — a stray @token inside the shell capture is data, not
  // a mention.
  const bangPrefix = d.bangContextRef.current;
  if (cmd.kind === "prompt" && bangPrefix !== null) {
    d.bangContextRef.current = null;
    void (async () => {
      let expanded = cmd.text;
      try {
        const mention = await expandMentions(cmd.text, d.workspaceRoot);
        for (const n of mention.notices) a.notify(n);
        expanded = mention.text;
      } catch {
        // expansion must never block a prompt — raw text it is
      }
      a.submit(`${bangPrefix}\n\n${expanded}`, { expand: false });
    })();
    return;
  }
  a.submit(cmd.kind === "prompt" ? cmd.text : text);
}
