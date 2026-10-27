// ω99-7 — auto-refine settings: `.wudao/settings.json` `refine.auto` node,
// resolved into the auto-refine trigger layer (memory/auto-refine.ts).
//
// Loader contract (long-task-config's pattern): missing/empty settings →
// defaults (silent); malformed JSON or wrong-typed values → warning +
// per-field fallback (never fatal); unknown keys → warning listing them.
//
// ⚠️ enabled defaults FALSE — prime-agent ships auto-refine ON, wudao
// reverses that ruling: a feature that silently spends model calls must be
// explicitly enabled per workspace. WUDAO_AUTO_REFINE=off is the emergency
// kill switch (resolveRefineAutoSettings).
import { loadLayeredSettings } from "./settings-layer.js";

export interface RefineAutoSettings {
  readonly enabled: boolean;
  readonly turnInterval: number;
  readonly compact: boolean;
  readonly cooldownMs: number;
}

export type RefineAutoWarn = (message: string) => void;

export const DEFAULT_REFINE_AUTO: RefineAutoSettings = {
  enabled: false,
  turnInterval: 25,
  compact: true,
  cooldownMs: 20 * 60_000,
};

/** turnInterval 钳 [1, 200]; cooldownMs 钳 [0, 24h] — the debounce stays
 *  honest without letting one typo turn refine into a per-turn caller. */
export const REFINE_AUTO_TURN_MIN = 1;
export const REFINE_AUTO_TURN_MAX = 200;
export const REFINE_AUTO_COOLDOWN_MAX_MS = 24 * 60 * 60_000;

const KNOWN_KEYS = ["enabled", "turnInterval", "compact", "cooldownMs"] as const;

function defaultWarn(message: string): void {
  process.stderr.write(`${message}\n`);
}

function clampInt(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Load the `refine.auto` node. Wrong-typed fields fall back per-field;
 *  range outliers are CLAMPED (钳), not rejected. Default = OFF. */
export async function loadRefineAutoSettings(
  workspaceRoot: string,
  warn: RefineAutoWarn = defaultWarn,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RefineAutoSettings> {
  // M57 §1: the two-tier reader (global + project, deep-merged) owns file IO
  // and JSON validation; this loader parses the effective `refine.auto` node.
  const root = await loadLayeredSettings(workspaceRoot, warn, env).then((l) => l.effective);
  const refineNode = root["refine"];
  if (refineNode === undefined) return DEFAULT_REFINE_AUTO;
  if (refineNode === null || typeof refineNode !== "object" || Array.isArray(refineNode)) {
    warn('⚠️ settings: "refine" must be an object; refine.auto defaults applied');
    return DEFAULT_REFINE_AUTO;
  }
  const node = (refineNode as Record<string, unknown>)["auto"];
  if (node === undefined) return DEFAULT_REFINE_AUTO;
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    warn('⚠️ settings: "refine.auto" must be an object; refine.auto defaults applied');
    return DEFAULT_REFINE_AUTO;
  }

  const record = node as Record<string, unknown>;
  const unknown = Object.keys(record).filter((k) => !(KNOWN_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    warn(`⚠️ .wudao/settings.json: unknown refine.auto key(s) ignored: ${unknown.join(", ")}`);
  }

  const out: { -readonly [K in keyof RefineAutoSettings]: RefineAutoSettings[K] } = { ...DEFAULT_REFINE_AUTO };
  if (record["enabled"] !== undefined) {
    if (typeof record["enabled"] !== "boolean") warn("⚠️ refine.auto.enabled must be a boolean; ignored");
    else out.enabled = record["enabled"];
  }
  if (record["turnInterval"] !== undefined) {
    const v = record["turnInterval"];
    if (typeof v !== "number" || !Number.isInteger(v)) warn("⚠️ refine.auto.turnInterval must be an integer; ignored");
    else out.turnInterval = clampInt(v, REFINE_AUTO_TURN_MIN, REFINE_AUTO_TURN_MAX);
  }
  if (record["compact"] !== undefined) {
    if (typeof record["compact"] !== "boolean") warn("⚠️ refine.auto.compact must be a boolean; ignored");
    else out.compact = record["compact"];
  }
  if (record["cooldownMs"] !== undefined) {
    const v = record["cooldownMs"];
    if (typeof v !== "number" || !Number.isInteger(v)) warn("⚠️ refine.auto.cooldownMs must be an integer; ignored");
    else out.cooldownMs = clampInt(v, 0, REFINE_AUTO_COOLDOWN_MAX_MS);
  }
  return out;
}

/** Kill switch: WUDAO_AUTO_REFINE=off forces the feature OFF regardless of
 *  what the settings file says (the reflect WUDAO_REFLECT=off precedent). */
export function resolveRefineAutoSettings(
  settings: RefineAutoSettings | undefined,
  env: NodeJS.ProcessEnv,
): RefineAutoSettings {
  const s = settings ?? DEFAULT_REFINE_AUTO;
  return (env["WUDAO_AUTO_REFINE"] ?? "").trim() === "off" ? { ...s, enabled: false } : s;
}
