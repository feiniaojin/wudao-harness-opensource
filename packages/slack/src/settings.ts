// M60 §1 — the `slack` settings node, read through the SAME two-tier layering
// every other settings consumer uses (global ~/.wudao + project .wudao, deep
// merge, project wins). Credentials NEVER live in settings: appTokenEnv /
// botTokenEnv carry env-var NAMES only, and nothing in this package ever logs
// a resolved token value.
import { loadLayeredSettings } from "wudao-harness/settings-layer";

/** The `slack` node of settings.json. `defaultPermissionMode` speaks the
 *  0.3.14 harness four (workspace/ask/auto/plan). A REMOTE surface defaults
 *  to "ask" — unlike the local boot, Slack never starts workspace-writable. */
export interface SlackSettings {
  readonly enabled: boolean;
  readonly appTokenEnv: string;
  readonly botTokenEnv: string;
  readonly allowedChannels: readonly string[];
  readonly allowedUsers: readonly string[];
  readonly defaultPermissionMode: "workspace" | "ask" | "auto" | "plan";
  readonly threadContextMaxChars: number;
  readonly askTimeoutMs: number;
}

export const DEFAULT_SLACK_SETTINGS: SlackSettings = {
  enabled: false,
  appTokenEnv: "WUDAO_SLACK_APP_TOKEN",
  botTokenEnv: "WUDAO_SLACK_BOT_TOKEN",
  allowedChannels: [],
  allowedUsers: [],
  defaultPermissionMode: "ask",
  threadContextMaxChars: 8000,
  askTimeoutMs: 300_000,
};

const MODES: readonly string[] = ["workspace", "ask", "auto", "plan"];
type SlackMode = SlackSettings["defaultPermissionMode"];

const parseMode = (raw: string | undefined): SlackMode => {
  if (raw === "workspace" || raw === "ask" || raw === "auto" || raw === "plan") return raw;
  if (raw === "acceptEdits") return "workspace"; // legacy (pre-0.3.12) spelling
  if (raw === "default") return "ask"; // legacy ask-per-tool tier
  return "ask"; // junk and the retired "read-only" fail toward the safe tier
};

function strList(v: unknown, warn: (m: string) => void, origin: string, key: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    warn(`⚠️ ${origin}: slack.${key} must be a string[]; ignored`);
    return [];
  }
  return [...(v as string[])];
}

function positiveInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : fallback;
}

/** Tolerant parse of the `slack` value (pure). Non-object → defaults +
 *  warning; per-field type errors drop that field with a warning, never the
 *  process. Unknown keys are ignored (forward-compatible). */
export function parseSlackSettings(
  value: unknown,
  warn: (m: string) => void = () => {},
  origin = ".wudao/settings.json (slack)",
): SlackSettings {
  if (value === undefined || value === null) return { ...DEFAULT_SLACK_SETTINGS };
  if (typeof value !== "object" || Array.isArray(value)) {
    warn(`⚠️ ${origin}: "slack" must be an object; using defaults`);
    return { ...DEFAULT_SLACK_SETTINGS };
  }
  const rec = value as Record<string, unknown>;
  const modeRaw = typeof rec["defaultPermissionMode"] === "string" ? rec["defaultPermissionMode"] : undefined;
  if (modeRaw === "acceptEdits" || modeRaw === "default") {
    warn(`⚠️ ${origin}: slack.defaultPermissionMode "${modeRaw}" is a pre-0.3.12 spelling; migrating to "${parseMode(modeRaw)}"`);
  } else if (modeRaw !== undefined && !MODES.includes(modeRaw)) {
    warn(`⚠️ ${origin}: slack.defaultPermissionMode "${modeRaw}" is not one of ${MODES.join(", ")}; using "ask"`);
  }
  const mode = parseMode(modeRaw);
  return {
    enabled: rec["enabled"] === true,
    appTokenEnv:
      typeof rec["appTokenEnv"] === "string" && rec["appTokenEnv"].trim() !== ""
        ? (rec["appTokenEnv"] as string).trim()
        : DEFAULT_SLACK_SETTINGS.appTokenEnv,
    botTokenEnv:
      typeof rec["botTokenEnv"] === "string" && rec["botTokenEnv"].trim() !== ""
        ? (rec["botTokenEnv"] as string).trim()
        : DEFAULT_SLACK_SETTINGS.botTokenEnv,
    allowedChannels: strList(rec["allowedChannels"], warn, origin, "allowedChannels"),
    allowedUsers: strList(rec["allowedUsers"], warn, origin, "allowedUsers"),
    defaultPermissionMode: mode,
    threadContextMaxChars: positiveInt(rec["threadContextMaxChars"], DEFAULT_SLACK_SETTINGS.threadContextMaxChars),
    askTimeoutMs: positiveInt(rec["askTimeoutMs"], DEFAULT_SLACK_SETTINGS.askTimeoutMs),
  };
}

/** Read the effective `slack` node from both settings tiers. */
export async function loadSlackSettings(
  workspaceRoot: string,
  warn: (m: string) => void = () => {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<SlackSettings> {
  const layered = await loadLayeredSettings(workspaceRoot, warn, env);
  return parseSlackSettings(layered.effective["slack"], warn);
}

/** Resolve a credentials env-var NAME to its value (or undefined). The ONLY
 *  place tokens are read; callers must never log the result. */
export function resolveToken(envName: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env[envName];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}
