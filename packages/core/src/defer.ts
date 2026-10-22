// M35 §1 — deferred tool loading (realizing the `shouldDefer` DNA annotation).
//
// Tools that report `shouldDefer(): true` never enter a request's tools
// array. Instead the request carries ONE trailing meta-tool — `load_tools` —
// whose description lists each deferred tool's name and a one-line summary.
// The model calls it with the subset it needs; from the NEXT request of the
// run the chosen definitions are APPENDED after load_tools.
//
// Cache cost (documented, deliberate): the tools segment follows the system
// prompt in the serialized request, so growing it invalidates the KV prefix
// of everything after it (the messages). The change therefore happens ONCE
// per run, at the first successful load_tools call; every later request is
// byte-stable again, and a second load_tools call is an informative no-op
// (the window is closed — Pi-style semantics with a stricter cache posture).
//
// Execution stays on the normal pipeline: the meta-tool is a real Tool object
// handed to the loop's gating (onPreToolUse → canUseTool → execute), marked
// isReadOnly (asking permission to load tool definitions would be noise) and
// NOT concurrency-safe (a batch containing it runs sequentially).
//
// Subagent child sets are unaffected by construction: defer candidates are
// orchestration tools, and child sets exclude orchestration tools — a child
// state with no shouldDefer tools gets an inactive controller and byte-
// identical request tool arrays.
import { buildTool, toModelToolDefinition } from "./tool.js";
import type { ModelToolDefinition, Tool } from "./tool.js";
import { truncateSafe } from "./text-truncate.js";
import { buildBudgetedLoadToolsDescription } from "./defer-catalog.js";

export const LOAD_TOOLS_NAME = "load_tools";

const SUMMARY_MAX_CHARS = 110;

/** One line per deferred tool in the meta-tool's description: the first
 *  sentence of the tool's description, whitespace-flattened, capped. */
export function deferSummary(description: string, maxChars = SUMMARY_MAX_CHARS): string {
  const flat = description.replace(/\s+/g, " ").trim();
  const sentence = /^[^.]*\./.exec(flat);
  let text = sentence !== null && sentence[0].trim() !== "" ? sentence[0].trim() : flat;
  if (text.length > maxChars) {
    // 113-A4: surrogate-safe cap — the meta-tool description is model-visible
    // request bytes; a lone surrogate from a severed emoji/CJK ext-B pair was
    // mojibake, not a stable prefix (ASCII/BMP summaries are byte-unchanged).
    const cut = truncateSafe(text, maxChars);
    const lastSpace = cut.lastIndexOf(" ");
    text = `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
  }
  return text;
}

function buildLoadToolsDescription(deferred: readonly Tool[]): string {
  // 128-4 — the budgeted names-first catalog (see defer-catalog.ts; the pure
  // renderer is tested there — this seam stays the single description source).
  return buildBudgetedLoadToolsDescription(deferred);
}

/** The one load a run applied (consumed by the loop to emit `defer_loaded`). */
export interface AppliedDeferLoad {
  readonly names: string[];
}

export interface DeferController {
  /** False when no tool defers — every method below is a no-op passthrough
   *  and requests carry the full, unchanged tools array. */
  readonly hasDeferred: boolean;
  /** The tools segment this request carries: full map when inactive; base
   *  defs + the load_tools meta-tool when active, plus the chosen deferred
   *  defs appended at the tail once the load applied. */
  requestDefs(): ModelToolDefinition[];
  /** The execution-side array: state.tools plus the synthetic load_tools
   *  tool when active (same gating pipeline as any other tool). */
  effectiveTools(): readonly Tool[];
  /** Set by a successful load_tools execution; the loop consumes it (once)
   *  to emit the `defer_loaded` event. */
  consumeApplied(): AppliedDeferLoad | undefined;
}

export function createDeferController(tools: readonly Tool[]): DeferController {
  const deferred = tools.filter((t) => t.shouldDefer?.() === true);
  if (deferred.length === 0) {
    return {
      hasDeferred: false,
      requestDefs: () => tools.map(toModelToolDefinition),
      effectiveTools: () => tools,
      consumeApplied: () => undefined,
    };
  }
  const deferredNames = new Set(deferred.map((t) => t.name));
  const base = tools.filter((t) => t.shouldDefer?.() !== true);

  let applied = false;
  let loadedNames: string[] = [];
  let pendingEvent: AppliedDeferLoad | undefined;

  const metaParameters = {
    type: "object" as const,
    properties: {
      names: {
        type: "array" as const,
        description: "Deferred tool names to load, e.g. [\"task\",\"agent_await\"].",
        items: { type: "string" as const },
      },
    },
    required: ["names"],
    additionalProperties: false,
  };
  const metaDescription = buildLoadToolsDescription(deferred);

  const loadTool: Tool = buildTool({
    name: LOAD_TOOLS_NAME,
    description: metaDescription,
    parameters: metaParameters,
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    async execute(args): Promise<{ content: string; isError?: boolean }> {
      const requested = Array.isArray(args.names) ? args.names : [];
      const bad = requested.filter((n) => typeof n !== "string" || !deferredNames.has(n as string));
      if (requested.length === 0) {
        return {
          content: `load_tools failed: names must be a non-empty array; deferred tools available: ${[...deferredNames].join(", ")}`,
          isError: true,
        };
      }
      if (bad.length > 0) {
        const badList = bad.map((n) => JSON.stringify(n)).join(", ");
        return {
          content: `load_tools failed: ${badList} is not a deferred tool (deferred: ${[...deferredNames].join(", ")}); nothing was loaded`,
          isError: true,
        };
      }
      if (applied) {
        return {
          content: `deferred tools already loaded this run (${loadedNames.join(", ")}) — the toolset is frozen for the rest of the run; use the loaded tools directly`,
        };
      }
      // Deterministic order: the tool-set's own order, not the request's.
      loadedNames = deferred.filter((d) => requested.includes(d.name)).map((d) => d.name);
      applied = true;
      pendingEvent = { names: loadedNames };
      return {
        content: `loaded ${loadedNames.join(", ")} — their full definitions are in your tool list from your next turn; the toolset is now frozen for this run`,
      };
    },
  });

  return {
    hasDeferred: true,
    requestDefs: () => {
      const defs: ModelToolDefinition[] = [
        ...base.map(toModelToolDefinition),
        { name: LOAD_TOOLS_NAME, description: metaDescription, parameters: metaParameters },
      ];
      if (applied) {
        const loaded = new Set(loadedNames);
        defs.push(...deferred.filter((d) => loaded.has(d.name)).map(toModelToolDefinition));
      }
      return defs;
    },
    effectiveTools: () => [...tools, loadTool],
    consumeApplied: () => {
      const event = pendingEvent;
      pendingEvent = undefined;
      return event;
    },
  };
}
