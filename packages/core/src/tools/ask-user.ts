// M34 §1 — ask_user: the model asking the human ONE question mid-run.
//
// The tool is interaction-free by construction: the asking lives in an
// injected `askUser` seam, so core stays UI-less and each frontend decides
// what "asking" means (TUI inline numbered options; REPL/one-shot a line
// prompt). Fail-closed everywhere:
//   - no seam (non-interactive run)     → error result "no interactive user"
//   - seam rejects (user dismissed)     → error result with the reason
//   - seam never settles (120s default) → error result "timed out"
// Every error result tells the model to decide itself — the question was an
// option, never a blocker.
//
// Only the TOP-LEVEL session gets the tool: buildToolSet-style callers place
// it outside the child pool, isolated children never see it, and a forked
// child (which shares the parent's byte-stable tool array) gets a refusing
// clone (subagent.ts FORK_REFUSED_TOOLS).
import { buildTool } from "../tool.js";
import type { Tool } from "../tool.js";

/** One single-select answer choice. */
export interface AskUserOption {
  readonly label: string;
  readonly description?: string;
}

/** The seam frontends inject: ask the human `question` (optionally rendering
 *  `options` as numbered choices) and resolve with their answer verbatim.
 *  Rejecting = the question could not be answered (dismissed, no input). */
export type AskUserFn = (question: string, options?: readonly AskUserOption[]) => Promise<string>;

export const ASK_USER_TIMEOUT_MS = 120_000;

const MAX_OPTIONS = 4;

export function createAskUserTool(options?: {
  /** Absent (or non-interactive) → every call fails closed. */
  readonly askUser?: AskUserFn;
  /** Default 120s. */
  readonly timeoutMs?: number;
}): Tool {
  const askUser = options?.askUser;
  const timeoutMs = options?.timeoutMs ?? ASK_USER_TIMEOUT_MS;
  return buildTool({
    name: "ask_user",
    description:
      "Ask the user ONE question and wait for their answer. Use when a decision genuinely needs the user (ambiguity, preference between approaches, missing credentials context). " +
      "requiresUserInteraction: yes — available ONLY in the interactive top-level session; subagents and non-interactive runs get an error result instead. " +
      "options: up to 4 single-select choices ({label, description?}); omit for a free-text question. The tool result is the user's choice/input verbatim; " +
      "on error (no user, dismissed, or timeout) decide yourself with your best judgment and continue.",
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
    async execute({ question, options, multiSelect }) {
      if (multiSelect === true) {
        return {
          content: "ask_user failed: multiSelect is not supported — ask ONE question with single-select options (or free text)",
          isError: true,
        };
      }
      if (options !== undefined) {
        if (!Array.isArray(options)) {
          return { content: "ask_user failed: options must be an array of {label, description?}", isError: true };
        }
        if (options.length > MAX_OPTIONS) {
          return { content: `ask_user failed: at most ${MAX_OPTIONS} options (got ${options.length}) — split the question or drop choices`, isError: true };
        }
        for (const [i, opt] of options.entries()) {
          if (typeof opt !== "object" || opt === null || typeof (opt as Record<string, unknown>).label !== "string" || (opt as Record<string, unknown>).label === "") {
            return { content: `ask_user failed: options[${i}] must be an object with a non-empty string "label"`, isError: true };
          }
        }
      }
      if (askUser === undefined) {
        return {
          content: "ask_user unavailable: no interactive user — decide yourself with your best judgment and continue",
          isError: true,
        };
      }
      try {
        const answer = await Promise.race([
          askUser(question as string, options as readonly AskUserOption[] | undefined),
          new Promise<never>((_, reject) => {
            const t = setTimeout(
              () => reject(new Error(`ask_user timed out after ${Math.round(timeoutMs / 1000)}s — no user answer; decide yourself with your best judgment and continue`)),
              timeoutMs,
            );
            t.unref?.();
          }),
        ]);
        return { content: answer };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: `ask_user failed: ${message}`, isError: true };
      }
    },
  });
}
