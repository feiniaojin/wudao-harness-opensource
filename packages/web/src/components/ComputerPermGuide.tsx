// ComputerPermGuide — ω99-212: #5 — 电脑操作工具的系统权限失败引导卡。osascript
// -1743（辅助功能被拒）与截屏空图（屏幕录制被拒）对新手是两堵无解释的墙：
// 本卡把它们翻成「打开哪、勾选谁、回来点重试」。识别层在 cli——工具错误带
// 机器标记 [wudao-perm:accessibility] / [wudao-perm:screen-recording]（标记
// 常量钉在 cli/src/computer/exec.ts，本文件只认串不认语义）；web 只渲染。
// 结构同 SimpleErrorCard：纯分类函数 + 一张卡 + 一个走正常输入通道的动作钮。
export interface ComputerPermGuideInfo {
  readonly kind: "accessibility" | "screen-recording";
  readonly steps: readonly string[];
  /** 重试钮提交的指令文本（走正常输入通道——让模型重试刚才的操作）。 */
  readonly retryText: string;
}

const ACCESSIBILITY_MARKER = "[wudao-perm:accessibility]";
const SCREEN_RECORDING_MARKER = "[wudao-perm:screen-recording]";

const ACCESSIBILITY_INFO: ComputerPermGuideInfo = {
  kind: "accessibility",
  steps: [
    "打开 系统设置 → 隐私与安全性 → 辅助功能",
    "在列表里勾选 wudao（桌面版是 wudao-harness-desktop；终端里运行就勾选那个终端）",
    "回到 wudao，点下面的「重试」",
  ],
  retryText: "我已经开启了辅助功能权限，请再试一次刚才的电脑操作",
};

const SCREEN_RECORDING_INFO: ComputerPermGuideInfo = {
  kind: "screen-recording",
  steps: [
    "打开 系统设置 → 隐私与安全性 → 屏幕录制",
    "勾选 wudao（桌面版是 wudao-harness-desktop），然后完全退出并重新打开它",
    "回到 wudao，点下面的「重试」",
  ],
  retryText: "我已经开启了屏幕录制权限并重启了应用，请再截一次屏幕",
};

/** 纯分类：错误文本含权限标记 → 引导信息；普通错误 → null（不渲染卡）。 */
export function computerPermGuideFor(errorText: string): ComputerPermGuideInfo | null {
  if (errorText.includes(ACCESSIBILITY_MARKER)) return ACCESSIBILITY_INFO;
  if (errorText.includes(SCREEN_RECORDING_MARKER)) return SCREEN_RECORDING_INFO;
  return null;
}

const KIND_LABEL: Readonly<Record<ComputerPermGuideInfo["kind"], string>> = {
  accessibility: "辅助功能",
  "screen-recording": "屏幕录制",
};

export function ComputerPermGuide({ text, onRetry }: {
  /** 错误全文（分类只认标记；原文不重复渲染——错误行自己会显示）。 */
  text: string;
  /** 重试钮回调（提交 retryText，走正常输入通道）；缺省只渲染步骤。 */
  onRetry?: (text: string) => void;
}): React.JSX.Element {
  const info = computerPermGuideFor(text) ?? ACCESSIBILITY_INFO;
  return (
    <div className="perm-guide" role="note" data-perm-kind={info.kind}>
      <div className="perm-head">{`需要一次「${KIND_LABEL[info.kind]}」授权——按下面三步开：`}</div>
      <ol className="perm-steps">
        {info.steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      {onRetry !== undefined ? (
        <button type="button" className="wudao action perm-retry" onClick={() => onRetry(info.retryText)}>
          重试
        </button>
      ) : null}
    </div>
  );
}
