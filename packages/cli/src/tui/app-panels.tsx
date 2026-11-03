// 拆分运动 C：从 app.tsx 原样外提的展示组件 + 纯助手族
//（ClearConfirm、HistoryItem、LiveArea、reasoning/answer 渲染帽、会话 id 派生）。
import { truncateSafe, truncateTailSafe } from "@wudao-org/core"; // 113-A4
import { useRef } from "react";
import type * as React from "react";
import { randomUUID } from "node:crypto";
import { Box, Text, useInput } from "ink";
import { TODO_LINE_MARKS } from "@wudao-org/core";
import type { AskUserOption } from "@wudao-org/core";
import type { AskAnswer } from "../permission.js";
import { formatMs } from "../driver/agent-driver.js";
import { FileCard } from "./file-card.js";
import { Spinner } from "./spinner.js";
import { PROMPT, SEP, T } from "./theme.js";
import { Markdown } from "./markdown.js";
import { DiffView } from "./diff.js";
import { truncate } from "../log.js";
import { truncate as truncateLine, RESULT_PREVIEW_CHARS } from "../log.js";

/** 审计完整性（09-16）：显示级截断——数据带全文，单行渲染处按需折叠
 * （空白压平+200 字帽与旧数据级截断同形，但只影响这一行的显示）。 */
const truncateMultiline = (s: string, n: number): string => truncateLine(s, n);
import type { HistoryEntry, LiveState } from "./use-agent.js";

// M42 §4: /help renders FROM listSlashCommands (same source as the menu) —
// the hand-written table is gone. The hint line under the input stays.
// ω99-161: 键位图例描述词中文化（键名 token Enter/Esc/shift+tab//help 原样）。
export const HINT = "Enter 发送 · \\+Enter 换行 · Esc 中断 · shift+tab 切模式 · /help";

// Session ids are url-safe (store regex: [A-Za-z0-9_-]+) and sortable by name.
export function newSessionId(): string {
  return `wudao-${Date.now().toString(36)}-${randomUUID().split("-")[0]}`;
}

export interface PendingAsk {
  toolName: string;
  summary: string;
  input: Record<string, unknown>;
  /** Security fix: set when the call writes .wudao/settings.json /
   *  .wudao/mcp.json — the prompt degrades to plain y/N (no `a`). */
  settingsFile?: string;
  /** M37 §3: high-risk git shell warning block (informational). */
  warning?: string;
  /** M45: the sidecar verdict reason / breaker notice behind this ask —
   *  rendered as `🔑 (sidecar: <reason>)`. */
  sidecar?: string;
  /** ω-4e (debt retired at funnel 4, design 70 §2): the asker digest when
   *  this ask is child-originated — dim, above the question. */
  askDigest?: string;
  /** design 70: the advisory ask-reviewer's verdict line — dim, below the
   *  digest, above the warning/sidecar/question. Advisory only. */
  askReview?: string;
  /** ω99-318: the visual-spoof inspection payload (codepoint badges + URL
   *  true-targets) — reveal-not-block decoration above the question. */
  spoof?: import("@wudao-org/core").SpoofInspection;
  resolve: (answer: AskAnswer) => void;
}

// M34 §1: a pending ask_user question — the AskUserPrompt component owns the
// keyboard until the user answers (numbered pick / free text) or dismisses.
export interface PendingAskUser {
  question: string;
  options?: readonly AskUserOption[];
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
}

// M42 §4: the /clear single-key confirmation (y clears, n/Esc/Enter keeps).
// Same ownership pattern as PermissionPrompt: while pending, this component
// owns the keyboard and the app-level handler stands down.
export function ClearConfirm({ onChoose }: { onChoose: (yes: boolean) => void }): React.JSX.Element {
  const resolved = useRef(false);
  useInput((input, key) => {
    if (resolved.current) return;
    // Only a matched key consumes the shot (unknown keys are no-ops, so a
    // stray arrow cannot burn the confirm).
    if (input === "y" || input === "Y") {
      resolved.current = true;
      onChoose(true);
    } else if (input === "n" || input === "N" || key.return || key.escape || (key.ctrl && input === "c")) {
      resolved.current = true;
      onChoose(false);
    }
  });
  // ω99-159: 确认框文案中文化（键位语义零动：y 清空 · n/Enter/Esc/Ctrl+C 保留）。
  return (
    <Text>
      🗑 清空历史——开一个全新会话？ <Text dimColor>{"(y 清空 · n 保留)"}</Text>
    </Text>
  );
}

// User echo: first line only, with an ellipsis marker when truncated.
function firstLine(text: string): string {
  const idx = text.indexOf("\n");
  return idx === -1 ? text : `${text.slice(0, idx)} …`;
}

// ω99-131: the receipt's human sentence — the note line's text. The receipt
// is 中文句 + "\n" + JSON by construction, BUT the driver's preview collapses
// whitespace (log.ts truncate), so the sentence and the JSON arrive as ONE
// line: cut at the JSON's opening brace. The name-gated family's sentences
// (已生成 Excel/PPT/文档：…（R 行 × C 列，X KB）) never contain a brace, so
// the cut is unambiguous. No brace → the whole first non-blank line; absent
// preview → undefined; empty result → no note line at all.
function receiptSentence(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const firstLine = text.split("\n").find((l) => l.trim() !== "") ?? "";
  const brace = firstLine.indexOf("{");
  return (brace === -1 ? firstLine : firstLine.slice(0, brace)).trim();
}

// Long reasoning collapses to its last line (the live head of thought). OOM
// fix: the collapse now triggers on ANY multi-line reasoning OR a single line
// past the render cap — ink's measure/wrap caches key on the full rendered
// string, so an unbounded single line would retain every streaming prefix
// (O(n²) heap). The rendered last line is capped to its trailing tail.
const REASONING_RENDER_CAP = 400;
function collapseReasoning(text: string): string {
  const lines = text.split("\n");
  const last = lines[lines.length - 1] ?? "";
  if (lines.length <= 1 && last.length <= REASONING_RENDER_CAP) return text;
  const shown = last.length > REASONING_RENDER_CAP ? truncateTailSafe(last, REASONING_RENDER_CAP) : last;
  return `… ${shown}`;
}

// OOM fix: the live answer renders only a bounded TAIL. The driver still
// accumulates the full answer in state (persistence/loop semantics are
// unchanged) — only what ink is asked to measure/wrap is bounded, which is
// what keeps the render caches from retaining every accumulated prefix.
const ANSWER_RENDER_CAP = 4_000;
function boundAnswer(text: string): string {
  return text.length > ANSWER_RENDER_CAP ? `…${truncateTailSafe(text, ANSWER_RENDER_CAP)}` : text;
}

// Presentational per-entry renderer (M25-B2 turn structure). Exported for
// direct ink-testing-library coverage of the entry shapes.
export function HistoryItem({ entry }: { entry: HistoryEntry }): React.JSX.Element {
  switch (entry.kind) {
    case "user":
      return (
        <Text>
          <Text color={T.accent}>{`${PROMPT} `}</Text>
          <Text dimColor>{firstLine(entry.text)}</Text>
        </Text>
      );
    case "assistant":
      return (
        <Box flexDirection="column">
          {/* 136：分段思考进转录后终端面同样要看得见 —— 多行折叠成末行（与
              直播面 collapseReasoning 同一契约，OOM 帽同源）；空 reasoning
              零渲染，老历史字节不变。 */}
          {entry.reasoning !== undefined && entry.reasoning !== "" ? (
            <Text dimColor>{collapseReasoning(entry.reasoning)}</Text>
          ) : null}
          <Markdown source={entry.text} />
          {/* 0.3.15（用户需求：LLM 回复耗时展示）：最终回复的自身生成耗时
              （最后一次 answering 调用的 durationMs），dim 一行；provider 不
              上报时整行省略。 */}
          {entry.durationMs !== undefined ? <Text dimColor>{`· ${formatMs(entry.durationMs)}`}</Text> : null}
        </Box>
      );
    case "tool":
      // CC-style tool line: `⏺ name(params)` — name default, params dim;
      // errored tools swap the marker for `⏹` in err. 0.3.15：行尾 dim 耗时
      // （I21 per-call 墙钟，出错调用照显——失败也花时间）。
      return (
        <Box flexDirection="column">
          <Text>
            <Text color={entry.isError ? T.err : undefined}>{`${entry.isError ? "⏹" : "⏺"} `}</Text>
            {entry.name}
            {entry.summary ? <Text dimColor>{`(${entry.summary})`}</Text> : null}
            {entry.durationMs !== undefined ? <Text dimColor>{` · ${formatMs(entry.durationMs)}`}</Text> : null}
          </Text>
          {/* ω99-131: a deliverable entry (file landed, never on error — the
              driver pins that) renders the file card INSTEAD of the ↳ preview
              line: the raw receipt's JSON line is screen pollution and never
              said where the file is or how to open it. Every other entry
              (file absent, or error) keeps the exact dim line below — the
              zero-drift pin. */}
          {entry.file !== undefined && !entry.isError ? (
            <FileCard file={entry.file} note={receiptSentence(entry.resultPreview)} />
          ) : entry.resultPreview ? (
            <Text dimColor>{`  ↳ ${entry.isError ? "[error] " : ""}${truncateMultiline(entry.resultPreview, RESULT_PREVIEW_CHARS)}`}</Text>
          ) : entry.isError ? (
            <Text color={T.err}>{"  ↳ [error]"}</Text>
          ) : null}
        </Box>
      );
    case "edit":
      return <DiffView path={entry.path} oldString={entry.oldString} newString={entry.newString} />;
    case "board":
      // M23: the todo board renders as a checklist — ☑ ok / ◐ warn / ☐ dim.
      return (
        <Box flexDirection="column">
          <Text dimColor>{`📋 board ${entry.done}/${entry.total} done`}</Text>
          {entry.lines.map((line, i) => {
            const color = line.startsWith(TODO_LINE_MARKS.done)
              ? T.ok
              : line.startsWith(TODO_LINE_MARKS.inProgress)
                ? T.warn
                : T.dim;
            return <Text key={i} color={color}>{line}</Text>;
          })}
        </Box>
      );
    case "notice":
      return <Text color={T.warn} dimColor>{entry.text}</Text>;
    case "divider":
      return <Text dimColor>{`${SEP}${SEP} ${entry.text} ${SEP}${SEP}`}</Text>;
    case "error":
      return <Text color={T.err}>{entry.text}</Text>;
  }
}

// M45: exported for direct ink-testing-library coverage of the busyTools
// gating badge (the same pattern as HistoryItem).
export function LiveArea({ live, queued }: { live: LiveState; queued: readonly string[] }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {live.reasoning ? <Text dimColor>{collapseReasoning(live.reasoning)}</Text> : null}
      {live.answer ? <Text>{boundAnswer(live.answer)}</Text> : null}
      {live.busyTools.map((t, i) => {
        // ω99-77 (63-C4 停泊债): the streaming call's live tail renders as ONE
        // dim line under the row — the LAST non-empty line, truncated to 120
        // (the SAME bound the web's BusyToolRow pins: one contract, three
        // surfaces — alignment by test pins, never shared code). No tail ⇒
        // no line: the row renders byte-identical to the pre-ω99-77 shape.
        // Updates ride the existing onToolUpdate → status-emit cadence (the
        // driver folds the bounded tail; no timer, no forced re-render).
        const tailLine = t.tail === undefined
          ? undefined
          : truncate((t.tail.split("\n").filter((l) => l.trim() !== "").at(-1) ?? ""), 120);
        return (
          <Box key={i} flexDirection="column">
            <Text>
              <Spinner />{" "}
              {t.name}
              {t.summary ? <Text dimColor>{`(${t.summary})`}</Text> : null}
              {/* M45 §1.6: the sidecar check is in flight — the badge clears the
                  moment the verdict lands (display never waits on the gate). */}
              {/* ω99-161: 徽章串中文化（160 web 侧同串镜像；前导空格保留）。 */}
              {t.gating ? <Text color={T.warn}>{" 🛡 检查中"}</Text> : null}
            </Text>
            {tailLine !== undefined && tailLine !== "" ? <Text dimColor>{tailLine}</Text> : null}
          </Box>
        );
      })}
      {/* ω99-161: 排队注入行中文化（与 160 #3 同字节：半角冒号无空格）。 */}
      {queued.map((t, i) => (
        <Text key={i} dimColor>{`⏳ 将在下一步前注入:${truncate(firstLine(t), 60)}`}</Text>
      ))}
    </Box>
  );
}
