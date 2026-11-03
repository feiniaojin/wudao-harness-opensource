// M30 — background agent registry tools (spec §B): thin registry clients
// registered after `task` and never part of a child's tool set.
//   agent_await({ids, mode})  collect results (all | allSettled | any | race)
//   agent_status()            snapshot of every spawned agent
//   agent_cancel({id})        stop one in-flight agent
// The registry is engine-level (core): spawn/awaitAgents/status/cancel/
// abortAll. The tool vocabulary below is the user-facing one — `done`/
// `aborted` surface as `completed`/`cancelled`, matching what the tool set
// has always promised.
import { truncateSafe } from "@wudao-org/core"; // 113-A4
import { buildTool } from "@wudao-org/core";
import type { AgentRunStatus, AgentRegistry, RegistryResult } from "./core-bind.js";

/** Reports are capped in the await/status payloads — the registry keeps the
 * full text; this is the parent-context budget for one agent's report. */
const REPORT_PREVIEW_CHARS = 4000;

const AWAIT_MODES: readonly string[] = ["all", "allSettled", "any", "race"];

/** Registry status (queued|running|done|failed|aborted) → tool status. */
function stateWord(status: AgentRunStatus | undefined): string {
  if (status === "done") return "completed";
  if (status === "aborted") return "cancelled";
  return status ?? "unknown";
}

function cap(text: string): string {
  return text.length > REPORT_PREVIEW_CHARS ? `${truncateSafe(text, REPORT_PREVIEW_CHARS)}…(${text.length} chars)` : text;
}

/** One agent row for the await/status payloads. */
function resultJson(registry: AgentRegistry, r: RegistryResult, withReport: boolean): Record<string, unknown> {
  return {
    id: r.id,
    role: r.role,
    state: stateWord(registry.status(r.id)?.status),
    ...(withReport ? { report: cap(r.report) } : {}),
    ...(r.reasoning !== undefined ? { reasoning: r.reasoning } : {}),
    ...(r.error !== undefined ? { error: r.error } : {}),
    ...(r.reportValid === false ? { reportErrors: r.reportErrors ?? [] } : {}),
    // M31 §1: the write scope rides every scoped agent's row, and overlap
    // partners stay listed — the fan-in receipt keeps BOTH candidates.
    ...(r.writeScope !== undefined ? { writeScope: r.writeScope } : {}),
    ...(r.overlapWith !== undefined ? { overlapWith: r.overlapWith } : {}),
    // M31 §2/§3: budget receipt + t-N lineage.
    ...(r.callId !== undefined ? { callId: r.callId } : {}),
    ...(r.parentCallId !== undefined ? { parentCallId: r.parentCallId } : {}),
    ...(r.budget !== undefined ? { budget: r.budget } : {}),
  };
}

/** Every spawned id, for unknown-id error messages. */
function knownIds(registry: AgentRegistry): string {
  return registry.status().map((s) => s.id).join(", ") || "(none spawned)";
}

export function createAgentAwaitTool(registry: AgentRegistry): import("@wudao-org/core").Tool {
  return buildTool({
    name: "agent_await",
    description:
      "Wait for background agents spawned via task({background:true}) and return their reports. mode: \"all\" (every id completed; error if any failed), \"allSettled\" (every id settled, failures included as state), \"any\" (first success), \"race\" (first to settle, whatever the state). Reports are the agents' final answers — the only thing the children's work reduces to in this conversation.",
    parameters: {
      type: "object",
      properties: {
        ids: { type: "array", description: "Agent ids returned by background task spawns (e.g. [\"bg-1\",\"bg-2\"]).", items: { type: "string" } },
        mode: { type: "string", description: "all | allSettled | any | race (default all)." },
      },
      required: ["ids"],
      additionalProperties: false,
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute({ ids, mode }) {
      const list = Array.isArray(ids) ? ids : undefined;
      if (!list || list.length === 0 || list.some((i) => typeof i !== "string")) {
        return { content: "agent_await failed: ids must be a non-empty array of agent id strings", isError: true };
      }
      const modeName = typeof mode === "string" && mode.trim() !== "" ? mode.trim() : "all";
      if (!AWAIT_MODES.includes(modeName)) {
        return { content: `agent_await failed: mode must be one of ${AWAIT_MODES.join("|")} (got ${JSON.stringify(modeName)})`, isError: true };
      }
      for (const id of list as string[]) {
        if (registry.status(id) === undefined) {
          return { content: `agent_await failed: unknown agent id "${id}" (known: ${knownIds(registry)})`, isError: true };
        }
      }
      try {
        // The registry owns the mode semantics (any rejects when every id
        // failed; all rejects when any failed).
        const results = await registry.awaitAgents({ ids: list as string[], mode: modeName as "all" | "allSettled" | "any" | "race" });
        const payload = results.map((r) => resultJson(registry, r, true));
        return {
          content: JSON.stringify(modeName === "race" || modeName === "any" ? (payload[0] as Record<string, unknown>) : payload),
        };
      } catch (err) {
        return { content: `agent_await failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  });
}

export function createAgentStatusTool(registry: AgentRegistry): import("@wudao-org/core").Tool {
  return buildTool({
    name: "agent_status",
    description:
      "Snapshot every background agent spawned in this session: id, callId (t-N), role, state (queued|running|completed|failed|cancelled), writeScope when scoped, parentCallId when it resumes an earlier task — without waiting. Use it to decide what to await or cancel.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute() {
      const rows = registry.status().map((s) => ({
        id: s.id,
        role: s.role,
        state: stateWord(s.status),
        // M31: write scope + t-N lineage (parentCallId marks a resume child:
        // bg-2 ← t-1 in the relist).
        ...(s.writeScope !== undefined ? { writeScope: s.writeScope } : {}),
        ...(s.callId !== undefined ? { callId: s.callId } : {}),
        ...(s.parentCallId !== undefined ? { parentCallId: s.parentCallId } : {}),
      }));
      return { content: rows.length === 0 ? "(no background agents)" : JSON.stringify(rows) };
    },
  });
}

export function createAgentCancelTool(registry: AgentRegistry): import("@wudao-org/core").Tool {
  return buildTool({
    name: "agent_cancel",
    description:
      "Cancel one background agent (queued agents are dequeued; running agents get an abort signal and stop at their next checkpoint). The agent's partial report is NOT collected — cancel means discard.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Agent id, e.g. \"bg-1\"." } },
      required: ["id"],
      additionalProperties: false,
    },
    async execute({ id }) {
      if (typeof id !== "string" || id.trim() === "") {
        return { content: "agent_cancel failed: id must be a non-empty agent id string", isError: true };
      }
      const ok = registry.cancel(id.trim());
      if (!ok) {
        const known = registry.status().map((s) => `${s.id}(${stateWord(s.status)})`).join(", ") || "(none spawned)";
        return { content: `agent_cancel failed: no in-flight agent "${id.trim()}" (${known})`, isError: true };
      }
      return { content: `cancelled ${id.trim()}` };
    },
  });
}

/** The registry tool triple, in registration order (after `task`). */
export function createRegistryTools(registry: AgentRegistry): readonly import("@wudao-org/core").Tool[] {
  return [createAgentAwaitTool(registry), createAgentStatusTool(registry), createAgentCancelTool(registry)];
}
