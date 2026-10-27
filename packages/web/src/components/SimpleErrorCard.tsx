// SimpleErrorCard — M63 §D (research 35 #8): an error entry in 简洁模式
// carries its RECOVERY instruction inline — the novice never has to decode a
// stack line to know the next move. The classifier is a pure function over
// the error text (truncation → 发送「继续」; auth → key hint; rate limit /
// network / default each get their own wording); the one actionable case
// (继续) offers a button that submits the recovery text through the normal
// input path.
import { capLines, CARD_LINE_CAP } from "./SimpleActivityCard.js";
import { Icon } from "./Icon.js";

export interface RecoveryAction {
  readonly label: string;
  /** The text the button submits (through the normal input path). */
  readonly text: string;
}

export interface RecoveryHint {
  readonly hint: string;
  readonly action?: RecoveryAction;
}

/** Classify an error text into its novice recovery instruction (pure — the
 *  tests and the card share one table). */
export function recoveryFor(errorText: string): RecoveryHint {
  const t = errorText.toLowerCase();
  if (/截断|truncat|finish_reason|too long|超出.*长度|length limit/.test(t) || /截断/.test(errorText)) {
    return {
      hint: "回复被截断了——内容太长,模型只写了一半。",
      action: { label: "发送「继续」让模型接着写", text: "继续" },
    };
  }
  if (/\b401\b|\b403\b|unauthorized|api[ -]?key|密钥|鉴权|认证|invalid key/.test(t)) {
    return { hint: "模型服务的 Key 可能无效或过期——打开右上角「设置」检查密钥后重试。" };
  }
  if (/\b429\b|rate.?limit|限流|too many requests/.test(t)) {
    return { hint: "请求太频繁——稍等一会儿再发送。" };
  }
  if (/timeout|timed out|econn|enotfound|network|fetch failed|connection|网络/.test(t)) {
    return { hint: "连不上模型服务——检查网络后重试。" };
  }
  return { hint: "可以重试一次;若再次失败,把任务拆小一点、换个说法再描述。" };
}

export function SimpleErrorCard({ text, onAction }: {
  text: string;
  /** Submits the recovery action's text (the normal input path). */
  onAction?: (text: string) => void;
}): React.JSX.Element {
  const { lines, total } = capLines(text);
  const recovery = recoveryFor(text);
  return (
    <div className="simple-error" role="alert">
      <div className="err-head"><Icon name="triangle-alert" size={13} /> 出错了</div>
      <div className="err-text">{lines.join("\n")}</div>
      {total > CARD_LINE_CAP ? (
        <div className="activity-foot">{`⋯ 共 ${total} 行,已显示前 ${CARD_LINE_CAP} 行`}</div>
      ) : null}
      <div className="err-recovery">
        <span className="label">怎么办:</span>
        <span>{recovery.hint}</span>
        {recovery.action !== undefined && onAction !== undefined ? (
          <button type="button" className="wudao action" onClick={() => onAction(recovery.action?.text ?? "")}>
            {recovery.action.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}
