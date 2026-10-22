// M47 §2 (B2) — the language transient block.
//
// When the user writes Chinese (auto-detected), one imperative instruction is
// APPENDED as a user message at the turn tail — `[language: respond in
// Chinese]` — never inserted into any prefix (pure append, so the KV-cache
// prefix stays byte-stable). Soft phrasing ("如果可以请…") measurably loses the
// first reasoning segment on reasoning models (Reasonix reasoning_language),
// so the wording is imperative. Subagents inherit the directive: the cli task
// tool sees the block in the parent transcript and appends it to the child's
// brief. Off-switch: WUDAO_LANGUAGE_BLOCK=off (default auto; on/zh forces).

/** The block's envelope prefix — how inheritance detects an active block. */
export const LANGUAGE_BLOCK_PREFIX = "[language:";

/** The directive itself: short, imperative, model-facing. */
export const LANGUAGE_BLOCK_ZH = "[language: respond in Chinese]";

/** Han-ratio threshold: ≥30% (after stripping code/@file payloads) ⇒ Chinese. */
export const HAN_RATIO_THRESHOLD = 0.3;

export type LanguageBlockMode = "auto" | "on" | "off";

/** Drop fenced code blocks (``` / ~~~) — payload language must not vote. */
export function stripCodeFences(text: string): string {
  return text.replace(/(```|~~~)[^`]*?(\1)/g, "");
}

/** Drop @mention tokens and the mention-expansion <file> envelopes. */
export function stripMentions(text: string): string {
  return text.replace(/<file path="[^"]*">[\s\S]*?<\/file>/g, "").replace(/(^|\s)@\S+/g, "$1");
}

/** Han characters over the "alphabet-bearing" total (Han + Latin letters),
 *  computed on the stripped text. Pure. */
export function hanRatio(text: string): number {
  const clean = stripMentions(stripCodeFences(text));
  const han = clean.match(/\p{Script=Han}/gu)?.length ?? 0;
  const latin = clean.match(/[a-zA-Z]/g)?.length ?? 0;
  return han + latin === 0 ? 0 : han / (han + latin);
}

/** ≥30% Han after stripping ⇒ treat the turn as Chinese. */
export function detectChinese(text: string): boolean {
  return hanRatio(text) >= HAN_RATIO_THRESHOLD;
}

/** WUDAO_LANGUAGE_BLOCK → off | on | auto (default/"" /junk ⇒ auto). */
export function resolveLanguageBlockMode(env: NodeJS.ProcessEnv = process.env): LanguageBlockMode {
  // M53 §5: --no-language wins over every setting (ablation).
  if (env.WUDAO_NO_LANGUAGE === "1") return "off";
  const raw = env.WUDAO_LANGUAGE_BLOCK?.trim().toLowerCase();
  if (raw === "off" || raw === "false" || raw === "0" || raw === "no") return "off";
  if (raw === "on" || raw === "force" || raw === "zh" || raw === "chinese") return "on";
  return "auto";
}

/** The block to append for this prompt under this mode (undefined = none). */
export function languageBlockFor(prompt: string, mode: LanguageBlockMode): string | undefined {
  if (mode === "off") return undefined;
  if (mode === "on") return LANGUAGE_BLOCK_ZH;
  return detectChinese(prompt) ? LANGUAGE_BLOCK_ZH : undefined;
}

/** True when a transcript already carries an active language block (the
 *  inheritance signal the task tool reads off the parent conversation). */
export function transcriptHasLanguageBlock(messages: ReadonlyArray<{ role: string; content: string }>): boolean {
  return messages.some((m) => m.role === "user" && m.content.startsWith(LANGUAGE_BLOCK_PREFIX));
}

// 夜移 012 (Reasonix reasoning_language.go) — the reasoning-language transient
// block: a SECOND knob, separate from the response block above. Reasoning
// models often think in English while answering in Chinese; this directive
// constrains the visible thinking text only, never the final-answer language.
// Auto mode reuses the SAME detector as the response block (one language-
// detection authority per codebase — a divergence from Reasonix, which keeps
// a second han-count heuristic here). Wording is imperative throughout:
// Reasonix measured soft phrasing losing the first reasoning segment on
// prompts that embed English logs/code.

export const REASONING_BLOCK_PREFIX = "[reasoning-language:";

/** zh directive: first token Chinese, whole turn, code verbatim, answer
 *  language untouched. Single line — house envelope, prefix-scannable. */
export const REASONING_BLOCK_ZH =
  "[reasoning-language: 全部思考文本从第一个字起使用简体中文，整轮保持，即使系统提示、工具输出或代码是英文；代码、标识符、文件路径、shell 命令保持原文；本指令只约束思考文本，不改变最终回答语言]";

export const REASONING_BLOCK_EN =
  "[reasoning-language: write all visible thinking in English from the first token and keep it in English for the whole turn, even when system prompts, tool output, or code are in another language; keep code, identifiers, file paths, and shell commands verbatim; this directive constrains thinking text only and does not change the final answer language]";

export type ReasoningLanguageMode = "auto" | "zh" | "en" | "off";

/** WUDAO_REASONING_LANGUAGE → auto | zh | en | off. WUDAO_NO_LANGUAGE=1 (the
 *  M53 §5 ablation switch) wins over everything, including a forced language. */
export function resolveReasoningLanguageMode(env: NodeJS.ProcessEnv = process.env): ReasoningLanguageMode {
  if (env.WUDAO_NO_LANGUAGE === "1") return "off";
  const raw = env.WUDAO_REASONING_LANGUAGE?.trim().toLowerCase();
  if (raw === "off" || raw === "false" || raw === "0" || raw === "no") return "off";
  if (raw === "zh" || raw === "cn" || raw === "chinese" || raw === "中文") return "zh";
  if (raw === "en" || raw === "english") return "en";
  return "auto";
}

/** The reasoning block for this prompt under this mode (undefined = none).
 *  auto anchors Chinese prompts via the shared detector and stays quiet for
 *  English/ambiguous turns (the historical no-injection behaviour). */
export function reasoningBlockFor(prompt: string, mode: ReasoningLanguageMode): string | undefined {
  if (mode === "off") return undefined;
  if (mode === "zh") return REASONING_BLOCK_ZH;
  if (mode === "en") return REASONING_BLOCK_EN;
  return detectChinese(prompt) ? REASONING_BLOCK_ZH : undefined;
}

// 推理档三级配置 + 语言 chip S3 (spec
// docs/superpowers/specs/2026-08-28-effort-tiering-language-chip-design.md §2)
// — the boot-time fold over BOTH knobs. Chain, per knob:
// WUDAO_NO_LANGUAGE=1 (ablation, kills all, highest) > the session lane (the
// /language override, S4; per-knob optional) > the stored settings
// `language` node (language.reply / language.reasoning) > env > auto. The
// stored node arrives RAW (unknown): a corrupted value reads as absent (the
// uiDefaultMode rule) — never a runtime error, never a phantom mode. Note
// "auto" IS a real stored value: it pins auto above the env leg (explicit
// 默认=自动 ignores WUDAO_LANGUAGE_BLOCK), unlike a key-absent follow-env.

export interface LanguagePreference {
  readonly reply: LanguageBlockMode;
  readonly reasoning: ReasoningLanguageMode;
}

export function resolveLanguagePreference(
  env: NodeJS.ProcessEnv = process.env,
  stored?: { reply?: unknown; reasoning?: unknown },
  session?: { reply?: LanguageBlockMode; reasoning?: ReasoningLanguageMode },
): LanguagePreference {
  if (env.WUDAO_NO_LANGUAGE === "1") return { reply: "off", reasoning: "off" };
  const replyStored = stored?.reply;
  const reasoningStored = stored?.reasoning;
  return {
    reply:
      session?.reply !== undefined
        ? session.reply
        : replyStored === "auto" || replyStored === "on" || replyStored === "off"
          ? replyStored
          : resolveLanguageBlockMode(env),
    reasoning:
      session?.reasoning !== undefined
        ? session.reasoning
        : reasoningStored === "auto" || reasoningStored === "zh" || reasoningStored === "en" || reasoningStored === "off"
          ? reasoningStored
          : resolveReasoningLanguageMode(env),
  };
}

// 推理档三级配置 + 语言 chip S4 — the /language argument grammar (the
// /permissions `args` twin): one knob per call, `reply auto|on|off` /
// `reasoning auto|zh|en|off`. Junk is refused with a usage error
// (fail-visible — never a silent no-op, never a phantom mode).
export const LANGUAGE_USAGE =
  "用法：/language reply auto|on|off | /language reasoning auto|zh|en|off — 裸 /language 看当前双旋钮"; // ω99-166d-i: #36

export type LanguageArgumentResult =
  | { readonly ok: true; readonly pref: Partial<LanguagePreference> }
  | { readonly ok: false; readonly error: string };

export function resolveLanguageArgument(args: string): LanguageArgumentResult {
  const parts = args.trim().split(/\s+/).filter((p) => p !== "");
  if (parts.length === 2 && parts[0] === "reply") {
    const level = parts[1]!;
    if (level === "auto" || level === "on" || level === "off") return { ok: true, pref: { reply: level } };
  }
  if (parts.length === 2 && parts[0] === "reasoning") {
    const level = parts[1]!;
    if (level === "auto" || level === "zh" || level === "en" || level === "off") return { ok: true, pref: { reasoning: level } };
  }
  return { ok: false, error: `${LANGUAGE_USAGE}（收到 "${args.trim()}"）` };
}

/** The bare-/language status line (both knobs, the session-effective fold). */
export function formatLanguageStatus(pref: LanguagePreference): string {
  return `language — 回答 reply: ${pref.reply}（auto|on|off） / 思考 reasoning: ${pref.reasoning}（auto|zh|en|off）\n  ${LANGUAGE_USAGE}`;
}

/** The exact reasoning variant an active parent transcript carries (zh or en),
 *  or undefined. Exact-match only: user-authored lookalikes never read as a
 *  directive, and the variant travels to children verbatim. */
export function transcriptReasoningBlock(messages: ReadonlyArray<{ role: string; content: string }>): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user" && (m.content === REASONING_BLOCK_ZH || m.content === REASONING_BLOCK_EN)) return m.content;
  }
  return undefined;
}
