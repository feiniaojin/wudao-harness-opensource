// SimpleComposer — M63 §D: the 简洁模式 input area around the shared
// InputBox. While a run is in flight the lane toggle shows what a send will
// do (research 35 #7): 排队 (default) holds the message for the NEXT run —
// it will not disturb the current work; 注入当前轮 submits immediately —
// the driver's steering queue injects it before the next model call. Both
// lanes ride the SAME submit op; the difference is timing, which is exactly
// the difference the driver's two steering outcomes ("steered" mid-run vs
// auto-started at run end) already encode. M64-visual §2: the permanent
// shield row is GONE — the three-shield permission selector (research 35
// #4, B's component), the lane chips, and the parked chips all ride the
// composer card's toolbar row through InputBox's controlsPrefix; the
// context ring keeps its controlsSuffix slot beside the send button.
// inkline Task 7 (spec §2): the lanes speak the chip language's `.on`
// selected state, and ContextMeter renders the inline `.ctx` there.
import type { DriverStatus, Mode } from "../protocol.js";
import type { RecentModel } from "../recent-models-store.js";
import type { SlashCommandInfo } from "../slash.js";
import type { ComposerImageDraft, ComposerFileDraft, SubmitWithImages } from "../attachments.js";
import { InputBox } from "./InputBox.js";
import { Icon } from "./Icon.js";
import { ContextMeter } from "./ContextMeter.js";
import type { ShieldMode } from "./ShieldSelector.js";

export type SendLane = "queue" | "steer";

export function SimpleComposer(props: {
  readonly busy: boolean;
  readonly mode: Mode;
  readonly commands: readonly SlashCommandInfo[];
  readonly connected: boolean;
  readonly ctx: DriverStatus["ctxTokens"];
  /** The active lane (owned by SimpleMode — the flush lives there). */
  readonly lane: SendLane;
  readonly onLane: (lane: SendLane) => void;
  /** Locally parked 排队 messages (chips with a drop affordance). */
  readonly parked: readonly string[];
  readonly onDropParked: (index: number) => void;
  /** M79b: the widened submit seam (SimpleMode's submitRouted — images
   *  cannot ride the queue lane, steer passes through). */
  readonly onSubmit: SubmitWithImages;
  readonly onInterrupt: () => void;
  readonly onCycleMode: () => void;
  readonly onShield: (mode: ShieldMode) => void;
  /** Clears the armed draft once the composer applied it. */
  readonly onDraftApplied: () => void;
  readonly draft?: { readonly text: string; readonly nonce: number };
  /** ui-review-r2 I1/I4: the buffer-report seam (InputBox's prop, forwarded
   *  so the simple shell's composer feeds the same App-held ref). */
  readonly onBufferChange?: (text: string) => void;
  /** M79b: the image-rail park seam (InputBox's props, forwarded the same
   *  way — staged images survive an ask takeover in BOTH shells). */
  readonly onImagesChange?: (drafts: readonly ComposerImageDraft[]) => void;
  readonly imageSeed?: { readonly drafts: readonly ComposerImageDraft[]; readonly nonce: number };
  readonly onImageSeedApplied?: () => void;
  /** ω99-55: the file-rail park seam (the image seam's discipline). */
  readonly onFilesChange?: (drafts: readonly ComposerFileDraft[]) => void;
  readonly fileSeed?: { readonly drafts: readonly ComposerFileDraft[]; readonly nonce: number };
  readonly onFileSeedApplied?: () => void;
  /** 输入框下方模型/强度 chips（spec 2026-08-28 §2.6）：纯透传给 InputBox。
   *  onPickModel 携带 (model, provider)——同端点走 /model、跨端点走 /provider。 */
  readonly modelLabel?: string | null;
  readonly modelProvider?: string;
  readonly modelChoices?: readonly { readonly provider: string; readonly model: string; readonly source: string }[] | null;
  /** (ω99-218 #3 续) 最近使用对，纯透传给 InputBox 的 ModelSelector（零喂
   *  = 旧行为）。 */
  readonly modelRecent?: readonly RecentModel[] | null;
  readonly onPickModel?: (model: string, provider: string) => void;
  readonly onPersistModelDefault?: () => void;
  readonly effort?: string | null;
  readonly efforts?: readonly string[];
  readonly onPickEffort?: (level: string) => void;
  /** 推理档 chip 的持久化脚 (S5)：EffortSelector 的 {provider} footer——同
   *  effort 款纯透传给 InputBox（ω99-234: 语言三件 prop 退役——迁设置页）。 */
  readonly effortProviderLabel?: string;
  readonly onPersistEffortDefault?: () => void;
  /** 极简工作空间切换（spec §3.1）：InputBox 的 LEAD 槽透传——SimpleMode
   *  塞 WorkspaceChip 进来（📎 左边首位）。 */
  readonly controlsLead?: React.ReactNode;
  /** ω99-316 (/btw 侧问): the「顺便问」chip's submit lane (InputBox's prop,
   *  forwarded the same way — busy/idle the side lane bypasses 排队/注入
   *  routing). Absent keeps the composer byte-identical. */
  readonly onSideAsk?: (text: string) => void;
}): React.JSX.Element {
  const { busy, mode, commands, connected, ctx, lane, onLane, parked, onDropParked, onSubmit, onSideAsk, onInterrupt, onCycleMode, onShield, onDraftApplied, draft, onBufferChange, onImagesChange, imageSeed, onImageSeedApplied, onFilesChange, fileSeed, onFileSeedApplied, modelLabel, modelProvider, modelChoices, modelRecent, onPickModel, onPersistModelDefault, effort, efforts, onPickEffort, effortProviderLabel, onPersistEffortDefault, controlsLead } = props;
  return (
    <div className="simple-composer">
      <InputBox
        busy={busy}
        mode={mode}
        commands={commands}
        connected={connected}
        onSubmit={onSubmit}
        onSideAsk={onSideAsk}
        onInterrupt={onInterrupt}
        onShield={onShield}
        onCycleMode={onCycleMode}
        idlePlaceholder="用大白话描述你想构建什么"
        busyPlaceholder={lane === "queue" ? "排队发送 —— 当前任务结束后处理" : "注入当前运行的任务……"}
        controlsLead={controlsLead}
        controlsPrefix={
          <>
            {busy ? (
              <div className="lane-toggle" role="radiogroup" aria-label="发送方式">
                <button
                  type="button"
                  role="radio"
                  aria-checked={lane === "queue"}
                  className={`chip${lane === "queue" ? " on" : ""}`}
                  data-lane="queue"
                  onClick={() => onLane("queue")}
                  title="不打扰当前任务,等它结束后作为新任务发送 —— 当前任务结束后再处理你的消息"
                >
                  <Icon name="hourglass" size={13} /> 排队
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={lane === "steer"}
                  className={`chip${lane === "steer" ? " on" : ""}`}
                  data-lane="steer"
                  onClick={() => onLane("steer")}
                  title="在下一次思考前插入,立即影响当前任务 —— 消息会在下一步前插入当前任务"
                >
                  <Icon name="zap" size={13} /> 注入当前轮
                </button>
              </div>
            ) : null}
            {parked.length > 0 ? (
              <div className="parked-row">
                {parked.map((t, i) => (
                  <span key={i} className="parked-chip">
                    <Icon name="hourglass" size={12} />
                    {`${t.slice(0, 24)}${t.length > 24 ? "…" : ""}`}
                    <button type="button" className="drop" aria-label="放弃这条排队消息" onClick={() => onDropParked(i)}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
          </>
        }
        controlsSuffix={<ContextMeter ctx={ctx} />}
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
        {...(imageSeed !== undefined ? { imageSeed } : {})}
        {...(fileSeed !== undefined ? { fileSeed } : {})}
        {...(draft !== undefined ? { draft } : {})}
      />
    </div>
  );
}
