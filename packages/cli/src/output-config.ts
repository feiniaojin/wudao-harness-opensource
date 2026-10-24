// M46: output feedback settings — `.wudao/settings.json` `writeVerify` +
// `longOutput` nodes + env overrides, resolved into the core tool configs
// (the cli INJECTS them via tool options; core stays settings-unaware).
//
// Loader contract (hooks-config / long-task-config pattern): missing/empty
// settings → defaults (silent); malformed JSON or wrong-typed values →
// warning + per-field fallback (never fatal); unknown keys → warning.
//
// Env:
//   WUDAO_WRITE_VERIFY=off     → write-verify disabled entirely
//   WUDAO_WRITE_VERIFY=ts-off  → the (slow, opt-in) tsc checker forced off
//   WUDAO_LONG_OUTPUT=off      → long-output head/tail shaping off → the
//                                pre-M46 byte-cap behavior
//   WUDAO_GENERIC_SHAPING=off  → the loop-level generic large-result
//                                backstop off → pre-ω-1b passthrough
import type { GenericResultShaping, LongOutputConfig, LogSlimmingPorts, WriteVerifyConfig } from "@wudao/core";
import { createProvider, type ProviderConfig } from "@wudao/providers";
import { loadLayeredSettings } from "./settings-layer.js";

export interface WriteVerifySettings {
  /** Post-write syntax receipts on write_file/edit. Default true. */
  readonly enabled: boolean;
  /** Single-file tsc for .ts/.tsx. Default false (seconds-scale cost). */
  readonly tsTsc: boolean;
}

export const DEFAULT_WRITE_VERIFY_SETTINGS: WriteVerifySettings = { enabled: true, tsTsc: false };

const KNOWN_WRITE_VERIFY_KEYS = ["enabled", "tsTsc"] as const;

export interface LongOutputSettings {
  readonly lineThreshold: number;
  readonly byteThreshold: number;
  readonly headLines: number;
  readonly tailLines: number;
}

export const DEFAULT_LONG_OUTPUT: LongOutputSettings = {
  lineThreshold: 200,
  byteThreshold: 10_000,
  headLines: 50,
  tailLines: 50,
};

const KNOWN_LONG_OUTPUT_KEYS = ["lineThreshold", "byteThreshold", "headLines", "tailLines"] as const;

export type OutputWarn = (message: string) => void;

function defaultWarn(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function readSettingsNode(workspaceRoot: string): Promise<Record<string, unknown> | undefined> {
  // M57 §1: the two-tier reader (global + project, deep-merged) owns file IO
  // and JSON validation (malformed tiers already warned there).
  const layered = await loadLayeredSettings(workspaceRoot);
  const root = layered.effective;
  return Object.keys(root).length > 0 ? root : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// writeVerify
// ---------------------------------------------------------------------------

export async function loadWriteVerifySettings(
  workspaceRoot: string,
  warn: OutputWarn = defaultWarn,
): Promise<WriteVerifySettings> {
  const root = await readSettingsNode(workspaceRoot);
  const node = root?.["writeVerify"];
  if (node === undefined) return DEFAULT_WRITE_VERIFY_SETTINGS;
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    warn('⚠️ .wudao/settings.json: "writeVerify" must be an object; defaults applied');
    return DEFAULT_WRITE_VERIFY_SETTINGS;
  }
  const record = node as Record<string, unknown>;
  const unknown = Object.keys(record).filter((k) => !(KNOWN_WRITE_VERIFY_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    warn(`⚠️ .wudao/settings.json: unknown writeVerify key(s) ignored: ${unknown.join(", ")}`);
  }
  const out: { -readonly [K in keyof WriteVerifySettings]: WriteVerifySettings[K] } = { ...DEFAULT_WRITE_VERIFY_SETTINGS };
  if (record["enabled"] !== undefined) {
    const v = readBoolean(record["enabled"]);
    if (v === undefined) warn("⚠️ writeVerify.enabled must be a boolean; ignored");
    else out.enabled = v;
  }
  if (record["tsTsc"] !== undefined) {
    const v = readBoolean(record["tsTsc"]);
    if (v === undefined) warn("⚠️ writeVerify.tsTsc must be a boolean; ignored");
    else out.tsTsc = v;
  }
  return out;
}

/** settings + env → the core WriteVerifyConfig; undefined = feature off
 *  (tools then return the exact pre-M46 results). */
export function resolveWriteVerifyRuntime(
  settings: WriteVerifySettings | undefined,
  env: NodeJS.ProcessEnv,
): WriteVerifyConfig | undefined {
  const s = settings ?? DEFAULT_WRITE_VERIFY_SETTINGS;
  const flag = (env["WUDAO_WRITE_VERIFY"] ?? "").trim().toLowerCase();
  if (flag === "off") return undefined;
  return { enabled: s.enabled, tsTsc: s.tsTsc && flag !== "ts-off" };
}

// ---------------------------------------------------------------------------
// longOutput
// ---------------------------------------------------------------------------

export async function loadLongOutputSettings(
  workspaceRoot: string,
  warn: OutputWarn = defaultWarn,
): Promise<LongOutputSettings> {
  const root = await readSettingsNode(workspaceRoot);
  const node = root?.["longOutput"];
  if (node === undefined) return DEFAULT_LONG_OUTPUT;
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    warn('⚠️ .wudao/settings.json: "longOutput" must be an object; defaults applied');
    return DEFAULT_LONG_OUTPUT;
  }
  const record = node as Record<string, unknown>;
  const unknown = Object.keys(record).filter((k) => !(KNOWN_LONG_OUTPUT_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    warn(`⚠️ .wudao/settings.json: unknown longOutput key(s) ignored: ${unknown.join(", ")}`);
  }
  const out: { -readonly [K in keyof LongOutputSettings]: LongOutputSettings[K] } = { ...DEFAULT_LONG_OUTPUT };
  for (const key of KNOWN_LONG_OUTPUT_KEYS) {
    if (record[key] === undefined) continue;
    const v = readPositiveInt(record[key]);
    if (v === undefined) warn(`⚠️ longOutput.${key} must be a positive integer; ignored`);
    else out[key] = v;
  }
  return out;
}

/** settings + env → the core LongOutputConfig; undefined = shaping off
 *  (shell then behaves exactly as before M46). */
export function resolveLongOutputRuntime(
  settings: LongOutputSettings | undefined,
  env: NodeJS.ProcessEnv,
): LongOutputConfig | undefined {
  if ((env["WUDAO_LONG_OUTPUT"] ?? "").trim().toLowerCase() === "off") return undefined;
  const s = settings ?? DEFAULT_LONG_OUTPUT;
  return {
    lineThreshold: s.lineThreshold,
    byteThreshold: s.byteThreshold,
    headLines: s.headLines,
    tailLines: s.tailLines,
  };
}

/** ω-1b: env → the loop-level generic large-result backstop's shaping
 *  handle. The spill anchor is the CALLER's job (each entry point knows its
 *  session root); this resolver only owns the env kill switch and the
 *  absent-anchor off state. undefined = backstop off entirely (behavior
 *  byte-identical to pre-ω-1b), mirroring M46's config-absent pattern.
 *  `config` is deliberately left unset — core's deliberately-loose
 *  DEFAULT_GENERIC_RESULT_CONFIG (5× M46's thresholds) is the only tuning
 *  surface until a settings node earns one. */
export function resolveGenericShapingRuntime(
  spillDir: string | undefined,
  env: NodeJS.ProcessEnv,
): GenericResultShaping | undefined {
  if ((env["WUDAO_GENERIC_SHAPING"] ?? "").trim().toLowerCase() === "off") return undefined;
  if (spillDir === undefined || spillDir === "") return undefined;
  return { spillDir };
}

// ---------------------------------------------------------------------------
// logSlimming（借鉴弧 C1，SoL-Pi C3）— 超长诊断日志的证据保全瘦身。
// 缺省关；启用必须显式指名廉价档模型（fail-closed：不猜 provider 的
// flash 名，settings 示例文档给 deepseek-v4-flash / glm-5.3-flash 档名）。
// 全部验证门与 fail-open 语义在 core（tools/log-slimming.ts）；本节只做
// settings 解析 + 廉价档客户端构造（sidecar 同款形状：effort none +
// softReasoningNone + 2048 完成上限）。
// ---------------------------------------------------------------------------

export interface LogSlimmingSettings {
  /** Default false — the conservative-start discipline. */
  readonly enabled: boolean;
  /** REQUIRED when enabled: the cheapest-tier reducer model name. */
  readonly model?: string;
  /** Overrides for core's conservative defaults (positive ints). */
  readonly minChars?: number;
  readonly timeoutMs?: number;
}

const KNOWN_LOG_SLIMMING_KEYS = ["enabled", "model", "minChars", "timeoutMs"] as const;

export async function loadLogSlimmingSettings(
  workspaceRoot: string,
  warn: OutputWarn = defaultWarn,
): Promise<LogSlimmingSettings> {
  const root = await readSettingsNode(workspaceRoot);
  const node = root?.["logSlimming"];
  if (node === undefined) return { enabled: false };
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    warn('⚠️ .wudao/settings.json: "logSlimming" must be an object; feature stays off');
    return { enabled: false };
  }
  const record = node as Record<string, unknown>;
  const unknown = Object.keys(record).filter((k) => !(KNOWN_LOG_SLIMMING_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    warn(`⚠️ .wudao/settings.json: unknown logSlimming key(s) ignored: ${unknown.join(", ")}`);
  }
  const out: { -readonly [K in keyof LogSlimmingSettings]: LogSlimmingSettings[K] } = { enabled: false };
  if (record["enabled"] !== undefined) {
    const v = readBoolean(record["enabled"]);
    if (v === undefined) warn("⚠️ logSlimming.enabled must be a boolean; ignored");
    else out.enabled = v;
  }
  if (record["model"] !== undefined) {
    if (typeof record["model"] !== "string" || record["model"].trim() === "") warn("⚠️ logSlimming.model must be a non-empty string; ignored");
    else out.model = record["model"];
  }
  for (const key of ["minChars", "timeoutMs"] as const) {
    if (record[key] === undefined) continue;
    const v = readPositiveInt(record[key]);
    if (v === undefined) warn(`⚠️ logSlimming.${key} must be a positive integer; ignored`);
    else out[key] = v;
  }
  return out;
}

/** The wiring-layer runtime: settings + env → what the entry points thread.
 *  undefined = feature off (shell behaves byte-identically to pre-C1). */
export interface LogSlimmingRuntime {
  readonly model: string;
  readonly minChars?: number;
  readonly timeoutMs?: number;
}

/** settings + env → runtime; fail-closed everywhere (off / kill-switch /
 *  enabled-without-a-model all → undefined with at most one warn line). */
export function resolveLogSlimmingRuntime(
  settings: LogSlimmingSettings | undefined,
  env: NodeJS.ProcessEnv,
  warn: OutputWarn = defaultWarn,
): LogSlimmingRuntime | undefined {
  if ((env["WUDAO_LOG_SLIMMING"] ?? "").trim().toLowerCase() === "off") return undefined;
  const s = settings ?? { enabled: false };
  if (!s.enabled) return undefined;
  if (s.model === undefined || s.model.trim() === "") {
    warn('⚠️ logSlimming.enabled = true 但未配置 logSlimming.model（廉价档模型名，如 "deepseek-v4-flash"）— 长日志瘦身保持关闭');
    return undefined;
  }
  return {
    model: s.model.trim(),
    ...(s.minChars !== undefined ? { minChars: s.minChars } : {}),
    ...(s.timeoutMs !== undefined ? { timeoutMs: s.timeoutMs } : {}),
  };
}

/** The reducer's provider config: the session's config with the cheap-tier
 *  overrides (sidecar precedent — effort none marked soft so a mandatory-
 *  reasoning endpoint's 400 stays repairable for THIS client only). Pure. */
export function logSlimmingReducerConfig(config: ProviderConfig, runtime: LogSlimmingRuntime): ProviderConfig {
  return {
    ...config,
    model: runtime.model,
    reasoningEffort: "none",
    softReasoningNone: true,
    maxTokens: 2048,
  };
}

/** The ports core's shell seam consumes (the ModelClient port — core never
 *  imports a concrete provider). The config spread keeps core's
 *  conservative defaults for every unset field. */
export function createLogSlimmingPorts(config: ProviderConfig, runtime: LogSlimmingRuntime): LogSlimmingPorts {
  return {
    model: createProvider(logSlimmingReducerConfig(config, runtime)),
    config: {
      ...(runtime.minChars !== undefined ? { minChars: runtime.minChars } : {}),
      ...(runtime.timeoutMs !== undefined ? { timeoutMs: runtime.timeoutMs } : {}),
    },
  };
}

/** One boot-path helper: settings + env (process.cwd) → ready ports, or
 *  undefined when the feature is off (the overwhelming default). Every entry
 *  path is mutually exclusive per process, so this loads at most once per
 *  boot — engine, REPL, and one-shot all share it. */
export async function loadLogSlimmingPortsForBoot(config: ProviderConfig): Promise<LogSlimmingPorts | undefined> {
  const runtime = resolveLogSlimmingRuntime(await loadLogSlimmingSettings(process.cwd()), process.env);
  return runtime !== undefined ? createLogSlimmingPorts(config, runtime) : undefined;
}
