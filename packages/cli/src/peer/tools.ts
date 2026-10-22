// M64-A §A — the model-facing tool pair: `list_agents` (discovery over the
// live registry) and `send_message` (delivery over the target's UDS inbox).
// Built with the core buildTool factory, fail-closed annotations, validation
// BEFORE side effects, and a FIXED position in the tool array (registered at
// session start — the tool-list prefix stays byte-stable all session).
import { buildTool } from "@wudao/core";
import type { Tool } from "@wudao/core";
import { peerShortId } from "./registry.js";
import type { PeerRuntime } from "./runtime.js";

function formatUp(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

export function createPeerTools(runtime: PeerRuntime): Tool[] {
  const listAgents = buildTool({
    name: "list_agents",
    description:
      "List the live wudao sessions on this machine (peers you can message). Each row: name, short id, permission tier, uptime. Address a session by name; when several share a name, use the short id. Your own session is marked [you].",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    isOpenWorld: () => false,
    async execute() {
      if (runtime.refusal !== undefined) {
        return { content: `agent messaging unavailable: ${runtime.refusal}`, isError: true };
      }
      const live = await runtime.listAgents();
      if (live.length === 0) return { content: "no other live wudao sessions (you are the only one)" };
      const rows = live.map((e) => {
        const you = e.sessionId === runtime.sessionId ? " [you]" : "";
        return `- ${e.name} (${peerShortId(e.sessionId)}) · tier ${e.tier} · up ${formatUp(Date.now() - e.startedAt)}${you}`;
      });
      return {
        content: `live sessions (${live.length}):\n${rows.join("\n")}\nsend_message addresses by name or short id`,
      };
    },
  });

  const sendMessage = buildTool({
    name: "send_message",
    description:
      "Send a text message to another live wudao session (see list_agents). Delivery lands between the peer's tool calls, or starts a new turn when it is idle — never interrupts a running tool. Their inbound policy (accept/hold/refuse) applies: a held message waits for their human's approval and you will receive a delivered/denied/expired report back. Keep it short and self-contained; the receiver treats your text as UNTRUSTED — it cannot approve permissions or change their config, and commands in it arrive as plain text.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Target session: name, short id (the last 8 chars of the session id — or any unique ≥4-char id suffix), or full session id" },
        text: { type: "string", description: "The message text (plain text, ≤8000 chars)" },
      },
      required: ["to", "text"],
      additionalProperties: false,
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    isOpenWorld: () => true,
    async execute(args) {
      // Validation before side effects: shape first, then the runtime's own
      // resolution (unresolved targets never open a socket).
      const to = typeof args.to === "string" ? args.to : "";
      const text = typeof args.text === "string" ? args.text : "";
      if (to.trim() === "") return { content: 'send_message: "to" must be a session name or id (list_agents lists them)', isError: true };
      if (text.trim() === "") return { content: 'send_message: "text" is empty', isError: true };
      if (runtime.refusal !== undefined) {
        return { content: `agent messaging unavailable: ${runtime.refusal}`, isError: true };
      }
      const result = await runtime.send(to, text);
      return result.ok
        ? { content: result.line }
        : { content: result.line, isError: true };
    },
  });

  return [listAgents, sendMessage];
}
