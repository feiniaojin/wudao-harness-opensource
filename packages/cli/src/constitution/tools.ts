// P2-13 (96 队列 #13) — the MODEL-SIDE constitution surface: ONE tool,
// `constitution_suggest`. It can ONLY queue a clause into the pending inbox:
// the destination path is HARDCODED in the store (constitution-pending/),
// the schema carries no path-like parameter at all, and validation runs
// BEFORE any side effect (fail-closed). No code path from this module ever
// touches the active constitution.md — the human's /constitution approve is
// the only writer (this arc's red line). memory_write precedent: a plain
// fail-closed buildTool, NOT read-only (it writes a file), default tool
// posture (TOOL_DEFAULTS underneath).
import { buildTool, type Tool } from "@wudao-org/core";
import {
  CONSTITUTION_CLAUSE_MAX_CHARS,
  appendPendingSuggestion,
} from "./store.js";

/** Build the suggest tool. `env` is the test seam (WUDAO_GLOBAL_HOME
 * sandbox); production wiring passes nothing → process.env at execute
 * time. */
export function createConstitutionSuggestTool(env?: NodeJS.ProcessEnv): Tool {
  return buildTool({
    name: "constitution_suggest",
    promptSnippet: "propose a constitution clause for the user to ratify",
    description:
      `Suggest ONE clause for the user's constitution. Suggestions ONLY queue into a pending inbox — the user reviews and approves them with /constitution; this tool NEVER edits the active constitution. One self-contained rule per call, ≤${CONSTITUTION_CLAUSE_MAX_CHARS} chars.`,
    parameters: {
      type: "object",
      properties: {
        clause: {
          type: "string",
          description: `The proposed clause (≤${CONSTITUTION_CLAUSE_MAX_CHARS} chars) — one self-contained rule the user may ratify.`,
        },
      },
      required: ["clause"],
      additionalProperties: false,
    },
    async execute(args) {
      // Fail-closed validation BEFORE any side effect (the store re-validates
      // — defense in depth; the schema has no path parameter to begin with).
      const clause = typeof args.clause === "string" ? args.clause : "";
      const trimmed = clause.trim();
      if (trimmed === "") {
        return { content: "constitution_suggest failed: clause must be a non-empty string", isError: true };
      }
      if (trimmed.length > CONSTITUTION_CLAUSE_MAX_CHARS) {
        return {
          content: `constitution_suggest failed: clause is ${trimmed.length} chars — over the ${CONSTITUTION_CLAUSE_MAX_CHARS}-char cap`,
          isError: true,
        };
      }
      try {
        const r = appendPendingSuggestion(trimmed, env ?? process.env);
        return {
          content: `constitution suggestion queued: ${r.file} (pending: ${r.pendingCount}) — the user reviews it with /constitution; it takes effect only after they approve it`,
        };
      } catch (err) {
        return {
          content: `constitution_suggest failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  });
}
