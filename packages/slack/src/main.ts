// M60 §1 — the `wudao slack` entry. Local-first: Bolt Socket Mode (one
// outbound websocket; no public ingress). Every Slack thread maps to a
// NORMAL harness session through the shared driver session engine (the same
// machinery `wudao ui` uses — JSONL sessions, /resume, steering queue,
// permission gate stack); this module only wires the channel + manager on
// top and never reimplements loop logic.
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createJsonlSessionStore } from "@wudao/core";
import type { ProviderConfig } from "@wudao/providers";
import { createDriverSession, type DriverSessionOptions } from "wudao-harness/driver/session-engine";
// SDD 2026-08-23 persona Task 4 — the REAL persona-chain reads (the Slack face
// is a production session-engine consumer exactly like ui.ts; the engine's
// prop defaults stay test stubs).
import { readProviderPersonaBinding } from "wudao-harness/driver/provider-registry-ops";
import { readGlobalDefaultPersonaId } from "wudao-harness/driver/settings-ops";
import { recordModelState } from "wudao-harness/run";
import { ensureWorkspaceRootEntry } from "wudao-harness/session-list";
import { loadSlackSettings, resolveToken, type SlackSettings } from "./settings.js";
import { loadThreadMap } from "./threads.js";
import { allowlistsPass, createChannelSessionManager } from "./manager.js";
import { createSlackChannel } from "./slack-channel.js";
import { createSlackRefusalAskUserTool } from "./tools.js";
import { runSlackDoctor, formatSlackDoctorReport } from "./doctor.js";

/** What `wudao slack` needs beyond the session engine's own options. */
export type RunSlackProps = Omit<DriverSessionOptions, "askRelay" | "topLevelTools" | "sessionId" | "resumeHistory" | "readState"> & {
  /** The argv AFTER the "slack" word (flags like --doctor). */
  readonly argv: readonly string[];
};

export interface SlackRuntime {
  stop(): Promise<void>;
  readonly settings: SlackSettings;
}

/** Fresh, recognizable session ids (same shape as the driver's, prefixed). */
export function newSlackSessionId(): string {
  return `wudao-slack-${Date.now().toString(36)}-${randomUUID().split("-")[0]}`;
}

/** Run the doctor, print, return the exit code. */
export async function slackDoctorMain(workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const settings = await loadSlackSettings(workspaceRoot, (m) => process.stdout.write(`${m}\n`));
  const network =
    resolveToken(settings.botTokenEnv, env) !== undefined
      ? async (botToken: string) => {
          try {
            const res = await fetch("https://slack.com/api/auth.test", {
              method: "POST",
              headers: { authorization: `Bearer ${botToken}` },
            });
            const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
            return body.ok === true
              ? { ok: true, detail: "auth.test ok (bot token accepted)" }
              : { ok: false, detail: `auth.test failed: ${body.error ?? res.status}` };
          } catch (err) {
            return { ok: false, detail: `network error: ${err instanceof Error ? err.message : String(err)}` };
          }
        }
      : undefined;
  const { checks, ok } = await runSlackDoctor({ settings, workspaceRoot, env, ...(network !== undefined ? { network } : {}) });
  process.stdout.write(`${formatSlackDoctorReport(checks)}\n`);
  return ok ? 0 : 1;
}

/** Start the daemon; resolves the runtime (caller owns lifetime/signals). */
export async function runSlack(props: RunSlackProps): Promise<SlackRuntime> {
  const { workspaceRoot, config, argv } = props;
  const { argv: _argv, ...sessionProps } = props;
  const settings = await loadSlackSettings(workspaceRoot, (m) => process.stdout.write(`${m}\n`));
  if (!settings.enabled) {
    throw new Error('slack interface is disabled — set "slack": {"enabled": true} in the GLOBAL tier (~/.wudao/settings.json; the project tier is trust-gated and cannot open remote surfaces), then rerun');
  }
  const appToken = resolveToken(settings.appTokenEnv);
  const botToken = resolveToken(settings.botTokenEnv);
  if (appToken === undefined || botToken === undefined) {
    // Never include values; name the missing env vars only.
    const missing = [settings.appTokenEnv, settings.botTokenEnv].filter((n) => resolveToken(n) === undefined);
    throw new Error(`missing slack credential env var(s): ${missing.join(", ")} (app-level xapp- + bot xoxb-; run: wudao slack --doctor)`);
  }
  // F1: the SAME dual allowlist gates messages AND interactive clicks — a
  // button rendered to a non-allowlisted workspace member can never settle
  // an ask (fail-closed predicate, see createSlackChannel).
  const isAuthorized = (userId: string | undefined, channel: string | undefined): boolean =>
    userId !== undefined && channel !== undefined && allowlistsPass(settings, userId, channel);
  const channel = createSlackChannel({ appToken, botToken, isAuthorized, log: (line) => process.stdout.write(`${line}\n`) });
  const threadMap = await loadThreadMap(workspaceRoot, (m) => process.stdout.write(`${m}\n`));
  const argvModes = argv.includes("--auto") || argv.includes("--ask");

  const manager = createChannelSessionManager({
    settings,
    channel,
    threadMap,
    log: (line) => process.stdout.write(`${line}\n`),
    createSession: async ({ sessionId, askRelay }) => {
      const fresh = sessionId ?? newSlackSessionId();
      const session = await createDriverSession({
        ...sessionProps,
        sessionId: fresh,
        askRelay,
        // M60 §3: interactive-only tools refuse with the ask-in-Slack hint.
        topLevelTools: [createSlackRefusalAskUserTool()],
        startupNotice: () => {},
        // SDD 2026-08-23 persona Task 4 — the production chain reads.
        readProviderPersonaBinding,
        readGlobalDefaultPersonaId,
      });
      // The settings' defaultPermissionMode applies unless argv flags set a
      // mode explicitly (same precedence as every other entry path). The
      // engine boots workspace (the 0.3.12 default) but a REMOTE surface
      // starts ask — so the slack default ("ask") applies here too.
      if (!argvModes && settings.defaultPermissionMode !== "workspace") {
        session.driver.setMode(settings.defaultPermissionMode);
      }
      // M28/M58 bookkeeping entries — the same ones the TUI/ui paths record
      // at startup, so /resume, /search and the worktree filter treat a
      // Slack session like any other.
      const store = createJsonlSessionStore(join(workspaceRoot, ".wudao", "sessions"));
      await recordModelState(store, fresh, config, {}).catch(() => {});
      await ensureWorkspaceRootEntry(store, fresh, workspaceRoot).catch(() => {});
      return session;
    },
  });
  await manager.start();
  // 96 队列 P1-6: startup sweep — redeliver final replies a PREVIOUS daemon
  // process generated but never confirmed-delivered (crash between turn
  // completion and platform ACK burned the tokens and dropped the text).
  // Runs after start (the socket must be live to post); best-effort inside,
  // it can never block the daemon.
  await channel.sweepPendingDeliveries();
  process.stdout.write(
    `wudao slack · socket mode connected · workspace ${workspaceRoot}\n` +
      `allowlists: ${settings.allowedUsers.length} user(s) · ${settings.allowedChannels.length} channel(s) · ask timeout ${Math.round(settings.askTimeoutMs / 1000)}s\n` +
      `Ctrl+C to stop\n`,
  );
  return {
    settings,
    stop: () => manager.stop(),
  };
}

/** The CLI-shaped entry: run until SIGINT/SIGTERM. */
export async function runSlackDaemon(props: RunSlackProps): Promise<void> {
  const runtime = await runSlack(props);
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.stdout.write("⏹ wudao slack stopped\n");
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await runtime.stop();
}

/** Dispatch for the CLI: --doctor runs offline checks (no API key needed);
 *  otherwise the daemon. Returns the process exit code. */
export async function slackMain(props: RunSlackProps): Promise<number> {
  if (props.argv.includes("--doctor")) return slackDoctorMain(props.workspaceRoot);
  await runSlackDaemon(props);
  return 0;
}

export type { ProviderConfig };
