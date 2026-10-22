import type { AgentMessage } from "./types.js";
import type { Tool } from "./tool.js";

export type AgentStatus = "idle" | "running" | "error";

export interface AgentState {
  readonly systemPrompt: string;
  messages: AgentMessage[];
  tools: Tool[];
  status: AgentStatus;
}

/** cc-plugins A3 — the ONE sanctioned systemPrompt rewrite: a hot extension
 *  rescan swapping the trailing <available_skills> manifest at a TURN
 *  BOUNDARY (idle, or run settle). The field is readonly precisely so
 *  nothing else can shift prompt bytes mid-session; this seam exists because
 *  the rescan's contract is narrower than "rewrite the prompt" — the caller
 *  guarantees the bytes before the tail are unchanged (the provider
 *  prefix-cache invariant, asserted by tests/rescan.test.ts). */
export function replaceSystemPrompt(state: AgentState, systemPrompt: string): void {
  (state as { -readonly [K in "systemPrompt"]: string }).systemPrompt = systemPrompt;
}
