// M34 §1 — the TUI's ask_user prompt: the model asked ONE question, the user
// answers inline. With options: an embedded numbered list — pressing 1..N
// picks that option's label. Without: a one-line free-text input (chars +
// backspace + Enter). Esc/Ctrl+C dismisses the question (the tool resolves
// to an error telling the model to decide itself). Mirrors PermissionPrompt:
// single-shot per mount, owns the keyboard while mounted.
import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { AskUserOption } from "@wudao/core";

const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

export function AskUserPrompt({ question, options, onAnswer, onDismiss }: {
  question: string;
  options?: readonly AskUserOption[];
  onAnswer: (answer: string) => void;
  onDismiss: () => void;
}): React.JSX.Element {
  const resolved = useRef(false);
  const [text, setText] = useState("");
  const hasOptions = options !== undefined && options.length > 0;

  useInput((input, key) => {
    if (resolved.current) return;
    if (key.escape || (key.ctrl && input === "c")) {
      resolved.current = true;
      onDismiss();
      return;
    }
    if (hasOptions) {
      // Numbered selection: a digit within range answers immediately.
      if (/^[1-9]$/.test(input)) {
        const n = Number(input);
        if (n >= 1 && n <= (options?.length ?? 0)) {
          resolved.current = true;
          onAnswer(options?.[n - 1]?.label ?? input);
        }
      }
      // Every other key is a no-op — a stray keypress must not burn the prompt.
      return;
    }
    // Free-text line input.
    if (key.return) {
      resolved.current = true;
      onAnswer(text.trim());
      return;
    }
    if (key.backspace || key.delete) {
      setText(text.slice(0, -1));
      return;
    }
    if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
    const ch = input.replace(CONTROL_CHARS, "");
    if (ch !== "") setText(text + ch);
  });

  if (hasOptions) {
    return (
      <Box flexDirection="column">
        <Text>{`❓ ${question}`}</Text>
        {options?.map((opt, i) => (
          <Text key={i}>
            {`  ${i + 1}) ${opt.label}`}
            {opt.description !== undefined && opt.description !== "" ? <Text dimColor>{` — ${opt.description}`}</Text> : null}
          </Text>
        ))}
        {/* ω99-161: 选项版提示行中文化（159 自由输入版同尾「Esc 取消、交回 agent 决定」）。 */}
        <Text dimColor>{`(按 1-${options?.length} 选择 · Esc 取消、交回 agent 决定)`}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text>{`❓ ${question}`}</Text>
      <Text>
        {"answer: "}
        {text}
        <Text color="yellow">█</Text>
      </Text>
      {/* ω99-159: 输入提示行中文化（键位语义零动：Enter 发送 · Esc 取消不变）。 */}
      <Text dimColor>{"(Enter 发送 · Esc 取消、交回 agent 决定)"}</Text>
    </Box>
  );
}
