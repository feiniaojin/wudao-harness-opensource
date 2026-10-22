// Permission prompt component for tool authorization (M33 §1: y/a/p/N menu).
// y = allow once · a = allow for this session (the App records the allowlist
// rule) · p = always (0.3.14 #1: the rule is ALSO persisted into the project
// tier's allow list via the /permissions write lane) · n = deny, optionally
// with a typed reason that flows back to the model as part of the denied tool
// result. Renders a single-use prompt that calls onChoose exactly once per
// mount.
// Security fix: when `settingsFile` is set (a write to .wudao/settings.json /
// .wudao/mcp.json) the prompt degrades to plain y/N — the file is named as
// runtime policy and `a`/`p` are NOT bound (a settings write can never be
// whitelisted).
import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { AskAnswer } from "../permission.js";
import { formatSpoofLine } from "@wudao/core";
import type { SpoofInspection } from "@wudao/core";

const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

export function PermissionPrompt({ toolName, summary, settingsFile, warning, sidecar, askDigest, askReview, spoof, onChoose }: {
  toolName: string;
  summary: string;
  /** Set when the call targets a runtime-policy file → plain [y/N], no `a`. */
  settingsFile?: string;
  /** M37 §3: high-risk git command warning block — informational only, the
   *  menu (and the pipeline behind it) is unchanged. */
  warning?: string;
  /** M45: the sidecar verdict reason (or breaker notice) behind this ask —
   *  rendered as `🔑 (sidecar: <reason>)` so the human sees WHY the classifier
   *  escalated before deciding. */
  sidecar?: string;
  /** ω-4e: the asker digest when this ask is child-originated (who is asking
   *  + the latest genuine user instructions) — dim, above the question. The
   *  App passes it once the ask-state wiring lands; until then this renders
   *  exactly as before. */
  askDigest?: string;
  /** design 70: the advisory ask-reviewer's verdict line (sanitized, one
   *  flat line) — dim, BELOW the digest block (it interprets the digest, so
   *  it reads after it), above the warning/sidecar/question. Advisory only:
   *  the menu and the decision semantics are unchanged. */
  askReview?: string;
  /** ω99-318: the visual-spoof inspection payload (zero-width/BiDi codepoint
   *  badges + URL true-targets) — yellow line(s) above the question.
   *  Reveal-not-block: the menu, the keys, and the decision semantics are
   *  unchanged; absent on clean input (byte-identical rendering). */
  spoof?: SpoofInspection;
  onChoose: (answer: AskAnswer) => void;
}): React.JSX.Element {
  // Guard to ensure onChoose is called exactly once per mount
  const resolved = useRef(false);
  // M33: `n` opens a one-line reason input before the deny is confirmed.
  const [reason, setReason] = useState<string | null>(null);
  // ω99-318: the reveal line (badges + true-targets, one flat line per the
  // formatToolError precedent — pure render in core, zero table copies here).
  const spoofLine = formatSpoofLine(spoof);

  useInput((input, key) => {
    if (resolved.current) return;

    if (reason !== null) {
      // Reason entry: printable chars append, backspace edits, Enter confirms
      // the deny (with the reason when non-empty), Esc/Ctrl+C deny without it.
      if (key.return) {
        resolved.current = true;
        const trimmed = reason.trim();
        onChoose(trimmed === "" ? { kind: "deny" } : { kind: "deny", reason: trimmed });
        return;
      }
      if (key.escape || (key.ctrl && input === "c")) {
        resolved.current = true;
        onChoose({ kind: "deny" });
        return;
      }
      if (key.backspace) {
        setReason(reason.slice(0, -1));
        return;
      }
      if (key.delete || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
      const text = input.replace(CONTROL_CHARS, "");
      if (text !== "") setReason(reason + text);
      return;
    }

    // Only a matched key consumes the single shot. Unknown keys (arrows, stray
    // chars) are no-ops — NOT deny — so a mid-thought keypress can't burn the
    // prompt and hang the parked run. Ctrl+C denies: the user is aborting the
    // ask (the app-level handler stands down while an ask is pending).
    // For a protected settings ask, `a`/`p` are unbound — a no-op like any
    // unknown key (the write can be allowed once, never whitelisted).
    if (input === "y" || input === "Y") {
      resolved.current = true;
      onChoose({ kind: "allow" });
    } else if ((input === "a" || input === "A") && settingsFile === undefined) {
      resolved.current = true;
      onChoose({ kind: "session" });
    } else if ((input === "p" || input === "P") && settingsFile === undefined) {
      resolved.current = true;
      onChoose({ kind: "always" });
    } else if (input === "n" || input === "N") {
      setReason("");
    } else if (key.return || key.escape || (key.ctrl && input === "c")) {
      resolved.current = true;
      onChoose({ kind: "deny" });
    }
  });

  if (reason !== null) {
    return (
      <Text>
        {/* ω99-158: 理由帧中文化 — 只改文案，键道/编辑逻辑零动。 */}
        🔑 拒绝 {toolName} — 理由（可选，Enter 确认）：{reason}
        <Text color="yellow">█</Text>
      </Text>
    );
  }

  if (settingsFile !== undefined) {
    return (
      <Box flexDirection="column">
        {askDigest !== undefined ? <Text dimColor>{askDigest}</Text> : null}
        {askReview !== undefined ? <Text dimColor>{askReview}</Text> : null}
        {warning !== undefined ? <Text color="yellow">{warning}</Text> : null}
        {sidecar !== undefined ? <Text color="yellow">{`🔑 (sidecar: ${sidecar})`}</Text> : null}
        {spoofLine !== undefined ? <Text color="yellow">{spoofLine}</Text> : null}
        <Text>
          {/* ω99-158: 策略文件变体中文化 — 键位 legend [y/N] 与 a/p 解绑零动。 */}
          🔑 允许 {toolName}：<Text color="yellow">策略文件 {settingsFile}</Text>
          {summary && summary !== settingsFile ? ` (${summary})` : ""}？ [y/N]
          <Text dimColor>{"  (y 仅本次 · n 拒绝，可输理由 · 策略文件无会话选项)"}</Text>
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {askDigest !== undefined ? <Text dimColor>{askDigest}</Text> : null}
      {askReview !== undefined ? <Text dimColor>{askReview}</Text> : null}
      {warning !== undefined ? <Text color="yellow">{warning}</Text> : null}
      {sidecar !== undefined ? <Text color="yellow">{`🔑 (sidecar: ${sidecar})`}</Text> : null}
      {spoofLine !== undefined ? <Text color="yellow">{spoofLine}</Text> : null}
      <Text>
        {/* ω99-158: 主菜单中文化 — 键位 legend [y/a/p/N] 原样（键位即绑定）。 */}
        🔑 允许 {toolName}
        {summary ? `：${summary}` : ""}？ [y/a/p/N]
        <Text dimColor>{"  (y 仅本次 · a 本会话 · p 总是（写入 .wudao/settings.json） · n 拒绝，可输理由)"}</Text>
      </Text>
    </Box>
  );
}
