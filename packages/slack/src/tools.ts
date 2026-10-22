// M60 §3 — non-interactive adaptation: interactive-only tools (ask_user) are
// DISABLED in Slack-driven sessions. The call resolves to a refusal result
// that tells the model to ask in the Slack conversation directly — headless
// sessions must never wait on a terminal prompt that does not exist.
import type { Tool } from "@wudao/core";

/** Tools whose entire purpose is interactive prompting — disabled in Slack. */
export const INTERACTIVE_TOOL_NAMES: readonly string[] = ["ask_user"];

export const SLACK_ASK_USER_REFUSAL =
  "ask_user is disabled in Slack-driven sessions: there is no interactive terminal on this path. " +
  "Ask the user directly instead — end your turn with the question in your reply; the user answers in the Slack thread and the next message continues this session.";

/** Replace every interactive-only tool with a refusing clone (same name,
 *  same schema — the model sees an unchanged surface; only execution
 *  refuses). Pure; returns the input array when nothing matches. */
export function disableInteractiveTools(tools: readonly Tool[]): Tool[] {
  const names = new Set<string>(INTERACTIVE_TOOL_NAMES);
  let touched = false;
  const out = tools.map((tool) => {
    if (!names.has(tool.name)) return tool;
    touched = true;
    return refuseTool(tool);
  });
  return touched ? out : [...tools];
}

function refuseTool(base: Tool): Tool {
  return {
    ...base,
    async execute() {
      return { content: SLACK_ASK_USER_REFUSAL, isError: true };
    },
  };
}

/** The standalone refusal ask_user for Slack sessions: the SAME name and
 *  schema the interactive frontends register (the model's surface is
 *  unchanged), but every call refuses with the ask-in-Slack hint. Rides the
 *  engine's topLevelTools tail exactly like the one-shot's ask_user. */
export function createSlackRefusalAskUserTool(): Tool {
  return {
    name: "ask_user",
    description:
      "Ask the user ONE question and wait for their answer. DISABLED in Slack-driven sessions: " +
      "every call returns an error telling you to put the question in your reply instead — the user answers in the Slack thread.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The single question to ask (one question per call)." },
        options: {
          type: "array",
          description: "≤4 single-select choices: [{label, description?}]. Omit for free-text.",
          items: {
            type: "object",
            properties: { label: { type: "string" }, description: { type: "string" } },
            required: ["label"],
          },
        },
        multiSelect: { type: "boolean", description: "Not supported — one choice per question; leave false/omitted." },
      },
      required: ["question"],
      additionalProperties: false,
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    async execute() {
      return { content: SLACK_ASK_USER_REFUSAL, isError: true };
    },
  };
}
