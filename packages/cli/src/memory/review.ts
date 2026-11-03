// M49 §2 — the background review fork (hermes). After a SUCCESSFUL run with
// ≥3 tool calls, a shareContext fork replays the settled transcript (warm
// prefix) with maxTurns 2 and read tools + memory_write, asking "anything
// worth saving as a skill or memory? ≤3 suggestions". Every suggestion the
// child saves goes through the SAME §1 write assessment (the memory_write
// tool never bypasses it) — user-scope suggestions land pending at most, so
// the review NEVER writes the user domain directly. WUDAO_BG_REVIEW=off
// disables the whole mechanism.
import type { AgentMessage, ModelClient, Tool } from "@wudao-org/core";
import { buildTool } from "@wudao-org/core";
import type { AgentRegistry } from "../agents/index.js";
import { openMemoryStore } from "./store.js";

export const REVIEW_MAX_TURNS = 2;
export const REVIEW_MIN_TOOL_CALLS = 3;
export const REVIEW_ROLE_ID = "memory-review";

export const REVIEW_PROMPT = [
  "本轮有值得存为技能或记忆的内容吗?",
  "Review the conversation above: is anything worth keeping as a durable memory or skill note? Propose AT MOST 3 suggestions, and save each one by calling memory_write (kind: fact|preference|skill_note; content ≤500 chars, self-contained; never include secrets or credentials; scope stays project unless the note is truly about the user).",
  "Only save genuinely reusable conclusions (hard-won facts, confirmed preferences, repeatable technique). Duplicates of what memory already holds will be rejected by the assessment — check with memory_search first when unsure. If nothing qualifies, write nothing and answer briefly.",
].join("\n");

/** True unless WUDAO_BG_REVIEW=off (spec's kill switch) or the M53 §5
 *  --no-review-fork ablation is in effect. */
export function backgroundReviewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.WUDAO_NO_REVIEW_FORK === "1") return false;
  return (env.WUDAO_BG_REVIEW ?? "").trim().toLowerCase() !== "off";
}

// The write-semantics tools a review child must not actually run. Their
// DEFINITIONS stay byte-identical (only execute is swapped) so the fork's
// tool-array wire bytes — and therefore the parent's paid prefix — do not
// move. task/agent_*/ask_user are additionally refused by runSubagent's own
// fork guard.
const NEUTERED_TOOL_NAMES = new Set(["write_file", "edit", "shell", "todo_write"]);

function neuterWriteTools(tools: readonly Tool[]): readonly Tool[] {
  return tools.map((t) =>
    NEUTERED_TOOL_NAMES.has(t.name)
      ? buildTool({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          async execute() {
            return { content: "memory review is read-only: this tool is disabled for the review fork — suggest memories with memory_write instead", isError: true };
          },
        })
      : t,
  );
}
export { neuterWriteTools };

export interface BackgroundReviewOptions {
  readonly workspaceRoot: string;
  readonly model: ModelClient;
  readonly registry: AgentRegistry;
  /** The parent's system prompt + settled transcript (the fork replay). */
  readonly systemPrompt: string;
  readonly messages: readonly AgentMessage[];
  /** The parent's full tool array (definitions ride the fork byte-identical). */
  readonly tools: readonly Tool[];
  /** Receives the 🧠 receipt line when the review settles. */
  readonly onReceipt?: (line: string) => void;
}

export interface BackgroundReviewSpawn {
  /** The registry's bg-N id. */
  readonly id: string;
  /** Resolves with the receipt line when the review settles. */
  readonly done: Promise<string>;
}

/** Spawn the review fork through the session registry (fire-and-forget; the
 *  caller may await `done`). The store baseline is snapshotted BEFORE the
 *  spawn so the suggestion diff can never race the child's writes. Returns
 *  undefined when disabled (the kill switch) — never throws. */
export async function spawnBackgroundReview(opts: BackgroundReviewOptions): Promise<BackgroundReviewSpawn | undefined> {
  if (!backgroundReviewEnabled()) return undefined;
  const before = new Set<string>();
  try {
    for (const e of await openMemoryStore(opts.workspaceRoot).load()) before.add(e.id);
  } catch {
    // An unreadable store: still spawn (the child's writes still land);
    // only the receipt's diff numbers degrade.
  }
  try {
    // No memory_write in the parent set → nothing for the reviewer to save
    // with (a memory-less frontend); skip instead of spawning a dead fork.
    if (!opts.tools.some((t) => t.name === "memory_write")) return undefined;
    const spawned = opts.registry.spawn({
      model: opts.model,
      allTools: opts.tools,
      role: {
        id: REVIEW_ROLE_ID,
        description: "post-run memory review (shareContext fork, read tools + memory_write)",
        systemPrompt: opts.systemPrompt,
        toolNames: [],
      },
      prompt: REVIEW_PROMPT,
      forkFrom: { systemPrompt: opts.systemPrompt, tools: neuterWriteTools(opts.tools), messages: opts.messages },
      maxTurns: REVIEW_MAX_TURNS,
      graceTools: [],
      onSettle: () => {},
    });
    const done = spawned.done.then(async (result) => {
      // Diff the store: the child's memory_write calls ARE the suggestions.
      let added = 0;
      let auto = 0;
      let pending = 0;
      try {
        const store = openMemoryStore(opts.workspaceRoot);
        for (const e of await store.load()) {
          if (before.has(e.id)) continue;
          added += 1;
          if (e.status === "active") auto += 1;
          else pending += 1;
        }
      } catch {
        // A broken store read must not mask the receipt — report the run.
      }
      const suffix = result.ok
        ? added === 0
          ? `0 suggestions`
          : `${added} suggestion${added === 1 ? "" : "s"} (${auto} auto, ${pending} pending)`
        : `review aborted (${result.error ?? result.report})`;
      const line = `🧠 review: ${suffix}`;
      opts.onReceipt?.(line);
      return line;
    });
    return { id: spawned.id, done };
  } catch {
    // A full registry (hard cap) or a broken spawn must never break the run.
    return undefined;
  }
}
