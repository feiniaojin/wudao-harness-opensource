// SimpleMode — M63 §D's 简洁模式 shell (research 35): the single-column
// conversation flow novices get by default. It renders from the SAME driver
// state as the advanced two-pane view (no second data path — one store, two
// projections). The shell owns: the empty-state hero vs the activity-card
// history, the live turn status, the 排队/注入当前轮 lane + its local park
// (flushed one message per run end), and the input-area swap between the
// composer and the approval card. Every sub-widget lives in its own file.
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { DriverStatus, HistoryEntry, LiveBusyTool, PendingAskUser, PendingPermission } from "../protocol.js";
import type { RecentModel } from "../recent-models-store.js";
import type { SlashCommandInfo } from "../slash.js";
import type { ComposerImageDraft, ComposerImageInput, ComposerFileDraft, ComposerFileInput, SubmitWithImages } from "../attachments.js";
// ui-review-r5 I3: the shared jump seam (the advanced column's ↓ button,
// extracted so the simple shell rides the same rule).
import { JumpBottomButton, useJumpBottom } from "../use-jump-bottom.js";
// 133 #9 — 长史 resume 渲染水合（尾窗+哨兵 IO+点击兜底）。
import { useHistoryTailWindow, historyHydrateLabel } from "../use-history-hydration.js";
import { HistoryItem, historyKey } from "./HistoryList.js";
// ω99-212: the computer tools' system-permission guide card (识别层在 cli)。
import { ComputerPermGuide, computerPermGuideFor } from "./ComputerPermGuide.js";
import { AskUserCards } from "./AskUserCards.js";
import { BusyToolRow, LiveAnswer, ReasoningBlock } from "./LiveArea.js";
import { PlanReview } from "./PlanReview.js";
import { SimpleActivityCard, isEditRunning } from "./SimpleActivityCard.js";
import { SimpleApprovalCard } from "./SimpleApprovalCard.js";
import { SimpleComposer } from "./SimpleComposer.js";
import type { SendLane } from "./SimpleComposer.js";
// ω99-316 (/btw 侧问): the simple column's side-QA lane mount.
import { SideQaLane } from "./SideQaLane.js";
import { SimpleErrorCard } from "./SimpleErrorCard.js";
import { SimpleTurnStatus } from "./SimpleTurnStatus.js";
import { EmptyHero } from "./EmptyHero.js";
import type { ShieldMode } from "./ShieldSelector.js";
import { AgentRootCard } from "./AgentRootCard.js";
import { pathName } from "./app-consts.js";
import { WorkspaceChip } from "./WorkspaceChip.js";
import type { FileOpsClient } from "../file-ops.js";

export interface SimpleModeProps {
  readonly status: DriverStatus | null;
  /** The merged server history + view-local notes (the same list the
   *  advanced column renders). */
  readonly history: readonly HistoryEntry[];
  readonly connected: boolean;
  readonly commands: readonly SlashCommandInfo[];
  /** M79b: the widened submit seam — images ride through to App on the steer
   *  path; the 排队 park cannot hold them (a parked chip is text-only). */
  readonly onSubmit: SubmitWithImages;
  readonly onInterrupt: () => void;
  readonly onCycleMode: () => void;
  /** Answers a parked permission ask through the client op (the approval
   *  card's buttons land here). The PROMISE resolves when the server took
   *  the answer (true) or nothing was parked anymore (false); a rejection
   *  means the answer never left — the card stays answerable. */
  readonly onAnswerPermission: (allow: boolean) => Promise<boolean>;
  /** 借鉴弧 α2 — the queued steer's recall (the ⏳ line's ↩ button). */
  readonly onRecallSteer?: (index: number, text: string) => void;
  /** 借鉴弧 δ — the busy tool row's 转入后台 button (the advanced timeline's
   *  twin; absent/undefined → rows render byte-identically). */
  readonly onDetachTool?: (callId: string) => void;
  /** 借鉴弧 α1 — the parked ask_user clarification card (null on old
   *  servers; the composer-takeover slot below renders it). */
  readonly pendingAsk?: PendingAskUser | null;
  /** 借鉴弧 α1 — answer/dismiss that card through the client op. */
  readonly onAnswerAskUser?: (answer?: string) => Promise<boolean>;
  /** The runtime permission tier (the shield selector by the input). */
  readonly onShield: (mode: ShieldMode) => void;
  /** View-local notice channel (the vanished-ask receipt, the answer-failure
   *  line). */
  readonly notify: (text: string) => void;
  /** ω99-167: onPrefill 退役——空态 hero 不再带预填 chips（用户令），
   *  该 seam 的宿主只剩高级布局的 FileViewer「改这段」。 */
  /** The 排队 lane's parked messages — APP-owned state (this shell unmounts
   *  on mode/settings swaps; the park must outlive them; the flush lives in
   *  App too). */
  readonly parked: readonly string[];
  readonly onPark: (text: string) => void;
  readonly onDropParked: (index: number) => void;
  /** Clears the armed draft once the composer applied it. */
  readonly onDraftApplied: () => void;
  /** The external buffer-replacement seam (/edit arming; ω99-167: the hero
   *  chips are gone — this now serves the advanced layout's viewer chip). */
  readonly draft?: { readonly text: string; readonly nonce: number };
  /** ui-review-r2 I1/I4: the buffer-report seam (parked drafts across the
   *  ask takeover + the unsent-draft exit guard). */
  readonly onBufferChange?: (text: string) => void;
  /** M79b: the image-rail park seam — staged images survive an ask takeover
   *  (forwarded to the composer). */
  readonly onImagesChange?: (drafts: readonly ComposerImageDraft[]) => void;
  readonly imageSeed?: { readonly drafts: readonly ComposerImageDraft[]; readonly nonce: number };
  readonly onImageSeedApplied?: () => void;
  /** ω99-55: the file rail's park/seed seam (the image seam's discipline). */
  readonly onFilesChange?: (drafts: readonly ComposerFileDraft[]) => void;
  readonly fileSeed?: { readonly drafts: readonly ComposerFileDraft[]; readonly nonce: number };
  readonly onFileSeedApplied?: () => void;
  /** 输入框下方模型/强度 chips（spec 2026-08-28 §2.6）：纯透传给
   *  SimpleComposer → InputBox（onShield 同款穿层）。onPickModel 携带
   *  (model, provider)——同端点行走 /model、跨端点行走 /provider。 */
  readonly modelLabel?: string | null;
  readonly modelProvider?: string;
  readonly modelChoices?: readonly { readonly provider: string; readonly model: string; readonly source: string }[] | null;
  /** (ω99-218 #3 续) 最近使用对，纯透传 SimpleComposer → InputBox（同款
   *  穿层；零喂 = 旧行为）。 */
  readonly modelRecent?: readonly RecentModel[] | null;
  readonly onPickModel?: (model: string, provider: string) => void;
  readonly onPersistModelDefault?: () => void;
  readonly effort?: string | null;
  readonly efforts?: readonly string[];
  readonly onPickEffort?: (level: string) => void;
  /** 推理档 chip 的持久化脚 (S5)：effortProviderLabel/onPersistEffortDefault
   *  是 EffortSelector 的「设为 {provider} 默认」footer（ω99-234: 语言三件
   *  prop 退役——迁设置页·偏好 tab）。 */
  readonly effortProviderLabel?: string;
  readonly onPersistEffortDefault?: () => void;
  /** 极简工作空间切换（spec §3.4）：全部透传，逻辑零新增——chip 的选择走
   *  App 的 switchPanelRoot（B1 面板根 + B3 arm 确认卡），agent 根切换与
   *  保持现状走 App 的既有回调；rootCard 形态即 App 的内联 state。 */
  readonly workspaceRoot: string;
  /** 138 续：boot 根（会话锚）——「默认空间」钉项的落点。可选：缺席不渲染。 */
  readonly bootRoot?: string;
  readonly onSwitchWorkspace: (path: string) => void;
  readonly onOpenOtherWorkspace: () => void;
  readonly rootCard: { readonly panelRoot: string; readonly agentRoot: string; queued: boolean } | null;
  readonly onAgentRootSwitch: () => void;
  readonly onAgentRootKeep: () => void;
  readonly fileOpsClient: FileOpsClient;
  /** ω99-316 (/btw 侧问): the「顺便问」chip's submit lane (→ SimpleComposer
   *  → InputBox) — busy/idle alike the side lane bypasses 排队/注入 routing
   *  (the whole point: not interrupting the main run). Absent keeps the
   *  composer byte-identical. */
  readonly onSideAsk?: (text: string) => void;
  /** ω99-316: the side-QA bubbles (App-owned client-local state — rendered
   *  above the composer like the advanced column, never in the transcript). */
  readonly sideQas?: readonly import("./SideQaLane.js").SideQa[];
  readonly onPromoteSideQa?: (qa: import("./SideQaLane.js").SideQa) => void;
}

/** Does the conversation have real content? Notices/dividers/boards alone
 *  still count as empty — the hero is about the FIRST user move. */
export function isConversationEmpty(history: readonly HistoryEntry[]): boolean {
  return !history.some((e) => e.kind === "user" || e.kind === "assistant" || e.kind === "tool" || e.kind === "edit" || e.kind === "error");
}

export function SimpleMode(props: SimpleModeProps): React.JSX.Element {
  const { status, history, connected, commands, onSubmit, onInterrupt, onCycleMode, onAnswerPermission, onRecallSteer, onDetachTool, pendingAsk, onAnswerAskUser, onShield, notify, parked, onPark, onDropParked, onDraftApplied, draft, onBufferChange, onImagesChange, imageSeed, onImageSeedApplied, onFilesChange, fileSeed, onFileSeedApplied, modelLabel, modelProvider, modelChoices, modelRecent, onPickModel, onPersistModelDefault, effort, efforts, onPickEffort, effortProviderLabel, onPersistEffortDefault, workspaceRoot, bootRoot, onSwitchWorkspace, onOpenOtherWorkspace, rootCard, onAgentRootSwitch, onAgentRootKeep, fileOpsClient, onSideAsk, sideQas, onPromoteSideQa } = props;
  const busy = status?.busy ?? false;
  const ask = status?.pendingPermission ?? null;
  const chatRef = useRef<HTMLDivElement>(null);

  // Research 35 #7: the busy-send lane. 排队 (default) parks on APP state
  // (survives this shell's unmounts; App flushes at run end); 注入当前轮
  // submits immediately onto the driver's steering channel. M79b: images
  // cannot park (a parked chip is text-only) — the queue lane refuses them
  // with a notice and false, so the composer keeps its rail for the retry.
  const [lane, setLane] = useState<SendLane>("queue");
  const submitRouted = useCallback(
    (text: string, images?: readonly ComposerImageInput[], files?: readonly ComposerFileInput[]): void | boolean | Promise<boolean | void> => {
      if (busy && lane === "queue") {
        if (images !== undefined && images.length > 0) {
          notify("⚠️ 排队消息暂不支持图片 —— 请等当前任务结束后再发");
          return false;
        }
        // ω99-55: the queue lane refuses file turns identically (a parked
        // chip is text-only).
        if (files !== undefined && files.length > 0) {
          notify("⚠️ 排队消息暂不支持文件 —— 请等当前任务结束后再发");
          return false;
        }
        onPark(text);
        return;
      }
      return onSubmit(text, images, files);
    },
    [busy, lane, notify, onPark, onSubmit],
  );

  // Review LOW: the answer's single-flight + answered flags track the OP,
  // not the click — a rejected answerPermission (socket drop at click time)
  // re-enables the card with a notice instead of swallowing the ask.
  const [answering, setAnswering] = useState(false);
  const answeringRef = useRef(false);
  const answeredRef = useRef(false);
  const answerAsk = useCallback(
    (allow: boolean): void => {
      if (answeringRef.current) return;
      answeringRef.current = true;
      setAnswering(true);
      void onAnswerPermission(allow)
        .then((accepted) => {
          // false = nothing parked anymore (resolved elsewhere): the vanish
          // receipt below owns the wording — leave answeredRef unset.
          if (accepted) answeredRef.current = true;
        })
        .catch((e: unknown) => {
          notify(`⚠️ 回答未送达(${e instanceof Error ? e.message : String(e)})——请再选一次`);
        })
        .finally(() => {
          answeringRef.current = false;
          setAnswering(false);
        });
    },
    [notify, onAnswerPermission],
  );

  // A parked ask that vanishes WITHOUT this client answering was resolved
  // elsewhere (an interrupt; a future server-side timeout→deny). The novice
  // sees an explicit receipt — silence after an amber strip reads as a hang.
  // (answeredRef is set only by a RESOLVED answer op — see answerAsk.)
  const prevAskRef = useRef<PendingPermission | null>(null);
  useEffect(() => {
    const prev = prevAskRef.current;
    if (prev !== null && ask === null && !answeredRef.current) {
      notify("⚠️ 权限请求已结束(未被允许)——如需继续,请重新描述要做的事");
    }
    if (ask !== null && prev === null) answeredRef.current = false;
    prevAskRef.current = ask;
  }, [ask, notify]);

  // ui-review-r5 I3: the jump-to-bottom affordance the advanced and Buddy
  // columns already had — the shared seam (scrolled > 200px up floats the ↓
  // circle; click smooth-scrolls home, reduced-motion respected there).
  // 0.3.4 反馈（会话上下晃）: tail-follow moved INTO the seam too — the shell's
  // old render-time `atBottom` read raced fast streaming ticks (content grew,
  // distance measured > 80, follow flipped off, next tick flipped it back on
  // = wobble). The seam's stickRef updates only on real scroll events, so a
  // stuck column stays glued to the bottom across ticks.
  const { onScroll: onChatScroll, jump: jumpToBottom, show: showJumpBottom } = useJumpBottom(chatRef);

  return (
    <div className="simple" data-mode="simple">
      <div className="chat" ref={chatRef} onScroll={onChatScroll}>
        {/* The hero rides ABOVE the history when the conversation is empty;
            the history list still renders — notices (receipts, errors) must
            stay visible behind the hero, or a submit failure on a fresh
            session would be invisible. */}
        {isConversationEmpty(history) ? <EmptyHero /> : null}
        <SimpleHistoryList history={history} onSubmit={onSubmit} busyTools={status?.live.busyTools ?? []} />
        {status?.planBoard != null ? (
          <PlanReview plan={status.planBoard} busy={busy} onSubmit={onSubmit} />
        ) : null}
        {status !== null && busy && ask === null ? (
          <div className="turnlive">
            {/* 0.3.81 精修: parked 不再上状态行——composer 的 ⏳ chip 是它唯一
                的家（带放弃钮），同一消息屏上只显一次。 */}
            <SimpleTurnStatus busy={busy} live={status.live} queued={status.queued} onRecall={onRecallSteer} />
            {status.live.reasoning !== "" ? <ReasoningBlock text={status.live.reasoning} streaming={status.live.thinking ?? false} defaultOpen={true} /> : null}
            {status.live.answer !== "" ? <LiveAnswer text={status.live.answer} /> : null}
            {/* UI-3 C1: the in-flight tools render HERE too (mockup P1's
                running ◐ card) — the SAME BusyToolRow the advanced timeline
                uses, so the novice sees "它在干什么" while a tool runs instead
                of one phase label. Completion lands in history as the
                expandable SimpleActivityCard (✓/✕) — the run row itself has
                no body (LiveBusyTool carries no payload), matching the
                advanced face's non-expandable busy row. Interior order mirrors
                LiveArea: reasoning → answer → busy rows.
                UI-5 C7-A: write-class busy rows whose CARD already sits in
                history are deduped (busyToolHasCard) — the running ◐ rides
                the EditCard itself, never one card + two rows. */}
            {status.live.busyTools.filter((t) => !busyToolHasCard(t, history)).map((t, i) => (
              <BusyToolRow key={`${t.name}:${t.summary}:${i}`} tool={t} onDetach={onDetachTool} />
            ))}
          </div>
        ) : null}
        {/* 借鉴弧 α1（Codex 0.154 思想）— the clarification card IN the chat
            stream (问题+选项 chips+自由输入): a chip pick or a typed answer
            resolves the tool and the task continues — nothing restarts, the
            composer stays live (a steer queued now just waits its turn).
            Esc = 让 agent 自行决定（the tool's own contract）. */}
        {ask === null && pendingAsk != null && onAnswerAskUser !== undefined ? (
          <AskUserCards
            inline={true}
            question={pendingAsk.question}
            options={pendingAsk.options}
            onAnswer={(answer) => {
              void onAnswerAskUser(answer).catch(() => { /* parked ask resolved elsewhere */ });
            }}
            onDismiss={() => {
              void onAnswerAskUser().catch(() => { /* parked ask resolved elsewhere */ });
            }}
          />
        ) : null}
      </div>
      {/* ui-review-r5 I3: the ↓ circle, anchored to this shell (styles.css —
          .simple is the positioning context, like .ide-cell.ide-right). */}
      <JumpBottomButton show={showJumpBottom} onJump={jumpToBottom} />
      {/* 极简工作空间切换（spec §3.4）：与 advanced chatColumn 同 idiom ——
          composer 上方且脱离 composer 的挂载条件（ask 接管不带走待决的
          根切换；两 mount 点随模式互斥，永不并存）。 */}
      {rootCard !== null ? (
        <AgentRootCard
          panelRoot={rootCard.panelRoot}
          agentRoot={rootCard.agentRoot}
          queued={rootCard.queued}
          onSwitch={onAgentRootSwitch}
          onKeep={onAgentRootKeep}
        />
      ) : null}
      {/* ω99-316 (/btw 侧问): the simple column's side-QA lane — above the
          composer, OUTSIDE the ask-takeover conditional (the bubbles are
          not composer state; the answers survive an ask). */}
      {(sideQas?.length ?? 0) > 0 && onPromoteSideQa !== undefined ? (
        <SideQaLane qas={sideQas ?? []} onPromote={onPromoteSideQa} />
      ) : null}
      {/* Research 35 #1/#9: the ask takes over the input area; the composer
          element itself never remounts across the hero→session flip. */}
      {ask === null ? (
        <SimpleComposer
          busy={busy}
          mode={status?.mode ?? "workspace"}
          commands={commands}
          connected={connected}
          ctx={status?.ctxTokens ?? null}
          lane={lane}
          onLane={setLane}
          parked={parked}
          onDropParked={onDropParked}
          onSubmit={submitRouted}
          onSideAsk={onSideAsk}
          onInterrupt={onInterrupt}
          onCycleMode={onCycleMode}
          onShield={onShield}
          onDraftApplied={onDraftApplied}
          onBufferChange={onBufferChange}
          onImagesChange={onImagesChange}
          onImageSeedApplied={onImageSeedApplied}
          onFilesChange={onFilesChange}
          onFileSeedApplied={onFileSeedApplied}
          modelLabel={modelLabel}
          modelProvider={modelProvider}
          modelChoices={modelChoices}
          modelRecent={modelRecent}
          onPickModel={onPickModel}
          onPersistModelDefault={onPersistModelDefault}
          effort={effort}
          efforts={efforts}
          onPickEffort={onPickEffort}
          {...(effortProviderLabel !== undefined ? { effortProviderLabel } : {})}
          {...(onPersistEffortDefault !== undefined ? { onPersistEffortDefault } : {})}
          controlsLead={
            <WorkspaceChip
              client={fileOpsClient}
              root={workspaceRoot}
              bootRoot={bootRoot}
              connected={connected}
              onPick={onSwitchWorkspace}
              onOpenOther={onOpenOtherWorkspace}
              labelName={rootCard !== null && rootCard.agentRoot !== "" ? pathName(rootCard.agentRoot) : undefined}
              labelPath={rootCard !== null && rootCard.agentRoot !== "" ? rootCard.agentRoot : undefined}
            />
          }
          {...(imageSeed !== undefined ? { imageSeed } : {})}
          {...(fileSeed !== undefined ? { fileSeed } : {})}
          {...(draft !== undefined ? { draft } : {})}
        />
      ) : (
        <>
          <SimpleApprovalCard
            ask={ask}
            busy={answering}
            onChoose={(answer) => answerAsk(answer.allow)}
          />
          {/* UI-5 顺手项 B (mockup v2:246): the takeover receipt — the
              novice's input position was borrowed, and this says so (and
              that it returns). A sibling BELOW the card, like the mockup. */}
          <div className="approval-note">权限卡临时接管输入位置 · 处理后自动恢复</div>
        </>
      )}
    </div>
  );
}

/** UI-5 C7-A: does this busy row's write ALREADY have a card in history?
 *  The simple face must not render the running write twice (card ◐ + busy
 *  row ◐). `edit` unconditionally has one — the driver appends the edit
 *  entry in the same tool_call_started branch that publishes the busy row,
 *  no await between. `write_file` only when an edit entry with the same
 *  path exists: an OVERWRITE lands a diff card (dedupe); a NEW file lands
 *  no card, so its busy row stays the only in-flight affordance. All other
 *  tools never render a card while running — their rows pass through.
 *  (Simple-face projection only: the advanced LiveArea is a tool-flow
 *  panel — its busy rows ARE the design, no dedup.) */
export function busyToolHasCard(tool: LiveBusyTool, history: readonly HistoryEntry[]): boolean {
  if (tool.name === "edit") return true;
  if (tool.name === "write_file") return history.some((e) => e.kind === "edit" && e.path === tool.summary);
  return false;
}

/** The 简洁模式 history projection: tool/edit entries become activity
 *  cards, error entries become recovery-instruction cards; every other kind
 *  renders exactly as in the advanced column (same HistoryItem). UI-5 C7-A:
 *  `busyTools` threads the live in-flight list so an edit entry whose write
 *  is still running renders ◐ (isEditRunning); absent = settled (✓), which
 *  keeps card-level tests and the resumed-session replay honest. */
export function SimpleHistoryList({ history, onSubmit, busyTools = [] }: {
  readonly history: readonly HistoryEntry[];
  readonly onSubmit: (text: string) => void;
  readonly busyTools?: readonly LiveBusyTool[];
}): React.JSX.Element {
  // 133 #9（deepagents 8ea734a80 形）— 长史 resume 只挂尾窗（简洁面的单元
  // =entry），向上滚/点击哨兵补水合。
  const tail = useHistoryTailWindow(history.length);
  const tailStart = tail.hidden;
  return (
    <>
      {tailStart > 0 ? (
        <div
          ref={tail.sentinelRef}
          className="history-hydrate-sentinel"
          onClick={tail.hydrate}
          role="button"
          tabIndex={0}
          onKeyDown={(ev) => {
            if (ev.key === "Enter" || ev.key === " ") tail.hydrate();
          }}
        >
          {historyHydrateLabel(tailStart)}
        </div>
      ) : null}
      {history.slice(tailStart).map((entry, vi) => {
        const i = tailStart + vi; // 全量索引——键用全局位（切片不改变键稳定性）
        return (
          // ui-review-r5 I4: the stable composite key (r2-P4's fix in the
          // advanced HistoryList) — a bare index key let a history REPLACEMENT
          // (resume/reconnect replay) inherit the previous rows' expand state.
          <Fragment key={historyKey(entry, i)}>
            {vi > 0 ? <div className="entry-gap" /> : null}
            <div className="entry">
              {entry.kind === "tool" || entry.kind === "edit" ? (
                <>
                  <SimpleActivityCard entry={entry} running={entry.kind === "edit" ? isEditRunning(entry, busyTools) : false} />
                  {/* ω99-212: 电脑操作工具的系统权限失败 → 引导卡嵌在活动卡下
                      （识别层在 cli 的机器标记；重试钮走正常提交通道）。 */}
                  {entry.kind === "tool" && entry.isError === true && computerPermGuideFor(entry.resultPreview ?? "") !== null ? (
                    <ComputerPermGuide text={entry.resultPreview ?? ""} onRetry={onSubmit} />
                  ) : null}
                </>
              ) : entry.kind === "error" ? (
                <SimpleErrorCard text={entry.text} onAction={onSubmit} />
              ) : (
                <HistoryItem entry={entry} />
              )}
            </div>
          </Fragment>
        );
      })}
    </>
  );
}
