// 借鉴弧 α2/α1 顺带拆分（文件行数棘轮「把压力推向拆分」）：模型/语言
// chip 的纯命令行构造族外提（protocol-core 1000 帽留给出入车道）。行为逐字
// 节一致（纯搬家）；re-export 门面保公共面。
export function isSwitchableModel(choice: { readonly provider: string }, currentProvider: string | undefined): boolean {
  return currentProvider === undefined || currentProvider === "" || currentProvider === choice.provider;
}

/** M63 §A: the submission line a picker click builds — same-provider rows
 *  ride the /model lane (live-config mutation + model_change entry);
 *  cross-provider rows ride /provider (endpoint switch + provider_change
 *  entry + a fully cold cache — the driver's switch machinery, not a
 *  restart). Pure, so the click handler and the tests share one rule. */
export function modelPickCommand(
  choice: { readonly provider: string; readonly model: string },
  currentProvider: string | undefined,
): string {
  return isSwitchableModel(choice, currentProvider)
    ? `/model ${choice.model}`
    : `/provider ${choice.provider}`;
}

// 推理档三级配置 + 语言 chip S5 (spec 2026-08-28 §5) — the language chip's
// pure wire helpers (the modelPickCommand pattern: the App callbacks stay
// one-liners, the line/key formats are pinned in the tests).

/** The language knob a chip row addresses (the /language grammar's two
 *  operands). */
export type LanguageKnob = "reply" | "reasoning";

/** The /language submission line a chip row builds — the SESSION lane (S4:
 *  takes effect next turn; env/settings stay the boot tiers). */
export function languagePickCommand(knob: LanguageKnob, mode: string): string {
  return `/language ${knob} ${mode}`;
}

/** The settingsSet key a group's 设为默认 footer writes (the S3 lane — the
 *  global tier, a NEW session's boot fold). */
export function languageDefaultKey(knob: LanguageKnob): string {
  return knob === "reply" ? "language.reply" : "language.reasoning";
}

