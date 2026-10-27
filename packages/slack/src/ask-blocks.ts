// M60 §3 — the Block Kit rendering of a permission ask, as PURE functions
// (the Bolt layer posts whatever these build; tests assert the payload shape
// with zero network). Layout mirrors the TUI's ask prompt: tool name, the
// SAME sanitized summary (summarizeToolCall), plus the decorations the TUI
// shows — protected-file naming, git-risk warning, sidecar escalation note.
// The button set: [允许一次] [本会话总是] [拒绝]. A bypass-immune step
// (protectedFile set) omits 本会话总是 — the TUI's plain [y/N] degradation,
// and the answer path additionally degrades an "always" click to allow-once
// (applyAskAnswer) so no layer can whitelist a settings write.
import type { AskPrompt } from "./channel.js";
import { escapeMrkdownEntities } from "./mrkdown.js";

export const ASK_ACTION_ALLOW = "wudao-ask-allow";
export const ASK_ACTION_ALWAYS = "wudao-ask-always";
export const ASK_ACTION_DENY = "wudao-ask-deny";
export const VIEW_SESSION_ACTION = "wudao-view-session";

/** Slack mrkdown section text for the ask (pure). The tool name is
 *  harness-controlled; the SUMMARY is model/user-controlled, so it is
 *  entity-escaped (F4 class: a raw <!channel> in a path or command must post
 *  literally, never as a broadcast). */
export function askPromptText(prompt: AskPrompt): string {
  const lines: string[] = [];
  const decorations: string[] = [];
  if (prompt.warning !== undefined) decorations.push(escapeMrkdownEntities(prompt.warning));
  if (prompt.sidecarReason !== undefined) decorations.push(`🔑 (sidecar: ${escapeMrkdownEntities(prompt.sidecarReason)})`);
  if (prompt.protectedFile !== undefined) {
    decorations.push(`🔒 runtime policy file ${escapeMrkdownEntities(prompt.protectedFile)} — bypass-immune, no "always" option`);
  }
  lines.push(`🔑 权限审批:*${prompt.toolName}*`);
  if (prompt.summary !== "") lines.push(escapeMrkdownEntities(prompt.summary));
  for (const d of decorations) lines.push(d);
  return lines.join("\n");
}

export interface KnownBlock {
  readonly type: string;
  readonly [field: string]: unknown;
}

/** The interactive blocks for one ask (pure). Every button carries the
 *  per-ask correlation id as its `value` — a click resolves exactly the ask
 *  it belongs to, never a newer one parked in the same thread. */
export function buildAskBlocks(prompt: AskPrompt, askId: string): KnownBlock[] {
  const blocks: KnownBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: askPromptText(prompt) } },
    {
      type: "actions",
      elements: [
        { type: "button", action_id: ASK_ACTION_ALLOW, value: askId, style: "primary", text: { type: "plain_text", text: "允许一次" } },
        // A bypass-immune step never offers 本会话总是 — same rule that turns
        // the TUI's y/a/N into plain y/N on protected files.
        ...(prompt.protectedFile === undefined
          ? [{ type: "button", action_id: ASK_ACTION_ALWAYS, value: askId, text: { type: "plain_text", text: "本会话总是" } }]
          : []),
        { type: "button", action_id: ASK_ACTION_DENY, value: askId, style: "danger", text: { type: "plain_text", text: "拒绝" } },
      ],
    },
  ];
  return blocks;
}

/** Map a Block Kit action_id back to the choice (pure; unknown → null). */
export function parseAskAction(actionId: string): "allow" | "always" | "deny" | null {
  switch (actionId) {
    case ASK_ACTION_ALLOW:
      return "allow";
    case ASK_ACTION_ALWAYS:
      return "always";
    case ASK_ACTION_DENY:
      return "deny";
    default:
      return null;
  }
}

/** The settled-ask replacement text (pure): the interactive message's buttons
 *  are swapped for this receipt once the ask resolves. */
export function askSettledText(prompt: AskPrompt, resolution: "allow" | "always" | "deny" | "timeout"): string {
  const verdict =
    resolution === "allow"
      ? "✅ 已允许(仅本次)"
      : resolution === "always"
        ? "✅ 已允许(本会话总是)"
        : resolution === "deny"
          ? "🚫 已拒绝"
          : "⏱ 无人应答,超时拒绝(fail-closed)";
  return `${askPromptText(prompt)}\n${verdict}`;
}
