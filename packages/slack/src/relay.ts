// M60 §3 — the channel ask relay: the frontend-owned permission ask the
// session engine invokes (onPermissionAsk). It renders the SAME sanitized
// summary the TUI shows (summarizeToolCall already ran — the engine passes
// the summary in), the same protected-file / git-risk / sidecar decorations,
// and maps the channel's button resolution onto the harness AskAnswer. The
// engine records the session-allowlist rule through applyAskAnswer, so a
// 本会话总是 on a protected path degrades to allow-once exactly like the
// TUI's `a` — no layer can whitelist a settings write.
//
// Fail-closed: timeout (slack.askTimeoutMs, default 5min) is a DENY with a
// reason the model sees; a channel error is likewise a deny.
import { protectedSettingsFile, type AskAnswer } from "wudao-harness/permission";
import { gitRiskAskWarning } from "wudao-harness/git-safety";
import type { AskPrompt, InboundChannel, InboundTarget } from "./channel.js";

export interface ChannelAskRelayArgs {
  readonly channel: InboundChannel;
  readonly target: InboundTarget;
  readonly timeoutMs: number;
  /** Present → the ask carries the git-risk decoration the TUI shows. */
  readonly workspaceRoot?: string;
  readonly log?: (line: string) => void;
}

export type ChannelAskRelay = (
  toolName: string,
  summary: string,
  input: Record<string, unknown>,
  ctx?: { readonly sidecarReason?: string },
) => Promise<AskAnswer>;

/** Build the ask relay bound to one conversation (thread). */
export function createChannelAskRelay(args: ChannelAskRelayArgs): ChannelAskRelay {
  const { channel, target, timeoutMs } = args;
  return async (toolName, summary, input, ctx): Promise<AskAnswer> => {
    const protectedFile = protectedSettingsFile(toolName, input);
    const gitWarning = args.workspaceRoot !== undefined ? gitRiskAskWarning(toolName, input, args.workspaceRoot) : undefined;
    const prompt: AskPrompt = {
      toolName,
      summary,
      ...(protectedFile !== undefined ? { protectedFile } : {}),
      ...(gitWarning !== undefined ? { warning: gitWarning } : {}),
      ...(ctx?.sidecarReason !== undefined ? { sidecarReason: ctx.sidecarReason } : {}),
    };
    let resolution;
    try {
      resolution = await channel.relayAsk(target, prompt, { timeoutMs });
    } catch (err) {
      args.log?.(`⚠️ slack ask relay failed (${err instanceof Error ? err.message : String(err)}) — denying ${toolName}`);
      return { kind: "deny", reason: "ask relay failed" };
    }
    if (resolution === "timeout") {
      args.log?.(`⏱ slack ask for ${toolName} timed out after ${timeoutMs}ms — denying (fail-closed)`);
      return { kind: "deny", reason: `no answer within ${Math.round(timeoutMs / 1000)}s (fail-closed timeout)` };
    }
    if (resolution === "allow") return { kind: "allow" };
    if (resolution === "always") return { kind: "session" };
    return { kind: "deny" };
  };
}
