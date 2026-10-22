// ω99-315 — `.wudao/settings.json` `stream` 节点：流式看门狗的双档预算
// （idleSoftMs 软警告 / idleHardMs 硬中止）。M46 output-config 的 Loader
// contract 同款（hooks-config / long-task-config 模式）：missing/empty →
// defaults（静默）；malformed JSON 或错型 → warning + per-field fallback
// （never fatal）；未知键 → warning。0 是合法值（关该档——providers 侧
// resolveStreamIdleBudget 同义）。设置页 UI v1 不做（记池）：键先经
// settings 文件生效。
import { loadLayeredSettings } from "./settings-layer.js";

export interface StreamSettings {
  /** 软档：静默超过该值发一次警告（不取消、不发请求）。默认 90s；0=关。 */
  readonly idleSoftMs: number;
  /** 硬档：静默超过该值 abort 并走恢复臂。默认 300s；0=关。 */
  readonly idleHardMs: number;
}

export const DEFAULT_STREAM_SETTINGS: StreamSettings = { idleSoftMs: 90_000, idleHardMs: 300_000 };

const KNOWN_STREAM_KEYS = ["idleSoftMs", "idleHardMs"] as const;

export type StreamWarn = (message: string) => void;

function defaultWarn(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** 0 是合法值（disable），负数/非整数/非数值不是。 */
function readNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export async function loadStreamSettings(
  workspaceRoot: string,
  warn: StreamWarn = defaultWarn,
): Promise<StreamSettings> {
  // The two-tier reader (global + project, deep-merged) owns file IO and JSON
  // validation (malformed tiers already warned there).
  const layered = await loadLayeredSettings(workspaceRoot);
  return streamSettingsFromNode(layered.effective["stream"], warn);
}

/** The node-level twin — session-engine already holds the layered effective
 *  map (one read, no second file IO); same contract as loadStreamSettings. */
export function streamSettingsFromNode(node: unknown, warn: StreamWarn = defaultWarn): StreamSettings {
  if (node === undefined) return DEFAULT_STREAM_SETTINGS;
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    warn('⚠️ .wudao/settings.json: "stream" must be an object; defaults applied');
    return DEFAULT_STREAM_SETTINGS;
  }
  const record = node as Record<string, unknown>;
  const unknown = Object.keys(record).filter((k) => !(KNOWN_STREAM_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    warn(`⚠️ .wudao/settings.json: unknown stream key(s) ignored: ${unknown.join(", ")}`);
  }
  const out: { -readonly [K in keyof StreamSettings]: StreamSettings[K] } = { ...DEFAULT_STREAM_SETTINGS };
  for (const key of KNOWN_STREAM_KEYS) {
    if (record[key] === undefined) continue;
    const v = readNonNegativeInt(record[key]);
    if (v === undefined) warn(`⚠️ stream.${key} must be a non-negative integer (0 disables the tier); ignored`);
    else out[key] = v;
  }
  if (out.idleSoftMs > 0 && out.idleHardMs > 0 && out.idleSoftMs >= out.idleHardMs) {
    warn("⚠️ stream.idleSoftMs should be smaller than stream.idleHardMs — the soft warning will never fire before the hard abort");
  }
  return out;
}

/** The ProviderOptions fragment every createProvider site spreads — the
 *  settings→runtime bridge (the providers package stays settings-unaware,
 *  exactly like writeVerify/longOutput inject via tool options). */
export function streamIdleProviderOptions(s: StreamSettings): { streamIdleSoftMs: number; streamIdleHardMs: number } {
  return { streamIdleSoftMs: s.idleSoftMs, streamIdleHardMs: s.idleHardMs };
}
