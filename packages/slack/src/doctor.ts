// M60 §4 — `wudao slack --doctor`: offline checks (settings parse, token env
// presence + PREFIX shape, dual allowlists, thread map) plus an optional
// network reachability probe (auth.test). Token VALUES are never logged —
// only presence and prefix class.
import { readFile } from "node:fs/promises";
import { threadMapPath, parseThreadMapBody } from "./threads.js";
import type { SlackSettings } from "./settings.js";
import { resolveToken } from "./settings.js";

export interface SlackDoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** Injected network probe (tests stub it; the real one is defined in main). */
export type DoctorNetworkProbe = (botToken: string) => Promise<{ ok: boolean; detail: string }>;

export interface SlackDoctorInput {
  readonly settings: SlackSettings;
  readonly workspaceRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Present → the connectivity check runs (real auth.test). */
  readonly network?: DoctorNetworkProbe;
}

/** Prefix classes: app-level tokens start xapp-, bot tokens xoxb-. */
export function tokenClass(value: string): "app" | "bot" | "unknown" {
  if (value.startsWith("xapp-")) return "app";
  if (value.startsWith("xoxb-")) return "bot";
  return "unknown";
}

export async function runSlackDoctor(input: SlackDoctorInput): Promise<{ readonly checks: readonly SlackDoctorCheck[]; readonly ok: boolean }> {
  const { settings } = input;
  const env = input.env ?? process.env;
  const checks: SlackDoctorCheck[] = [];

  // 1. enabled
  checks.push({
    name: "settings.enabled",
    ok: settings.enabled,
    detail: settings.enabled ? "slack interface enabled (global-tier settings slack node)" : 'disabled — set "slack": {"enabled": true} in the GLOBAL tier (~/.wudao/settings.json; project-tier slack is trust-gated)',
  });

  // 2/3. tokens: presence + prefix class. Never the value.
  const appToken = resolveToken(settings.appTokenEnv, env);
  checks.push({
    name: `env ${settings.appTokenEnv} (app token)`,
    ok: appToken !== undefined && tokenClass(appToken) === "app",
    detail:
      appToken === undefined
        ? "not set"
        : tokenClass(appToken) === "app"
          ? `set (xapp-…, ${appToken.length} chars)`
          : `set but WRONG PREFIX "${appToken.slice(0, 5)}…" — Socket Mode needs an app-level xapp- token`,
  });
  const botToken = resolveToken(settings.botTokenEnv, env);
  checks.push({
    name: `env ${settings.botTokenEnv} (bot token)`,
    ok: botToken !== undefined && tokenClass(botToken) === "bot",
    detail:
      botToken === undefined
        ? "not set"
        : tokenClass(botToken) === "bot"
          ? `set (xoxb-…, ${botToken.length} chars)`
          : `set but WRONG PREFIX "${botToken.slice(0, 5)}…" — a bot token starts xoxb-`,
  });

  // 4. dual allowlists — empty = nobody can talk (fail-closed gate).
  checks.push({
    name: "slack.allowedUsers",
    ok: settings.allowedUsers.length > 0,
    detail: settings.allowedUsers.length > 0 ? `${settings.allowedUsers.length} user(s)` : "EMPTY — every sender is dropped (fail-closed)",
  });
  checks.push({
    name: "slack.allowedChannels",
    ok: settings.allowedChannels.length > 0,
    detail: settings.allowedChannels.length > 0 ? `${settings.allowedChannels.length} channel(s)` : "EMPTY — every channel is dropped (fail-closed)",
  });

  // 5. thread map (corrupt → warning, not fatal).
  let mapCount = -1;
  try {
    const text = await readFile(threadMapPath(input.workspaceRoot), "utf8");
    const parsed = parseThreadMapBody(text);
    mapCount = parsed === undefined ? -1 : Object.keys(parsed).length;
  } catch {
    mapCount = 0; // absent — fine (written on first binding)
  }
  checks.push({
    name: ".wudao/slack-threads.json",
    ok: mapCount >= 0,
    detail: mapCount >= 0 ? `${mapCount} thread binding(s)` : "CORRUPT — it will be recreated on next write",
  });

  // 6. network (optional, injectable).
  if (input.network !== undefined && botToken !== undefined) {
    const probe = await input.network(botToken);
    checks.push({ name: "slack api reachability (auth.test)", ok: probe.ok, detail: probe.detail });
  }

  return { checks, ok: checks.every((c) => c.ok) };
}

export function formatSlackDoctorReport(checks: readonly SlackDoctorCheck[]): string {
  const lines = checks.map((c) => `${c.ok ? "✅" : "❌"} ${c.name} — ${c.detail}`);
  const failing = checks.filter((c) => !c.ok);
  lines.push(failing.length === 0 ? "\nall slack checks passed" : `\n${failing.length} check(s) failed`);
  return `wudao slack --doctor\n${lines.join("\n")}\n`;
}
